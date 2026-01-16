import * as vscode from 'vscode';
import {
    ParsedDesign,
} from './parser/types';
import { TsRegexParserBackend } from './parser/tsRegexBackend';

// Current design index so DefinitionProvider can see it
let currentDesign: ParsedDesign | null = null;

// -------------------- Nodes for Project Tree --------------------

interface TempNode {
    children: Map<string, TempNode>;
    uri?: vscode.Uri; // file
}

class VerilogNode extends vscode.TreeItem {
    public readonly children?: VerilogNode[];
    public readonly moduleName?: string;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            children?: VerilogNode[];
            uri?: vscode.Uri;              // file
            location?: vscode.Location;    // module
            moduleName?: string;           // module name
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.moduleName = options?.moduleName;

        if (options?.location) {
            // Module node
            this.command = {
                command: 'vscode.open',
                title: 'Open Module Definition',
                arguments: [options.location.uri, { selection: options.location.range }],
            };
            this.contextValue = 'verilogModule';
        } else if (options?.uri) {
            // File node
            this.resourceUri = options.uri;
            this.command = {
                command: 'vscode.open',
                title: 'Open Verilog File',
                arguments: [options.uri],
            };
            this.contextValue = 'verilogFile';
        } else {
            // Folder
            this.contextValue = 'verilogFolder';
        }
    }
}


// -------------------- Project Tree Provider --------------------

class VerilogProjectTreeProvider implements vscode.TreeDataProvider<VerilogNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<VerilogNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<VerilogNode | undefined | void> =
        this._onDidChangeTreeData.event;

    private files: vscode.Uri[] = [];
    private design: ParsedDesign | null = null;
    private data: VerilogNode[] = [];

    update(files: vscode.Uri[], design: ParsedDesign | null): void {
        this.files = files;
        this.design = design;
        this.data = this.buildTree();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: VerilogNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: VerilogNode): Thenable<VerilogNode[]> {
        if (!element) {
            return Promise.resolve(this.data);
        }
        return Promise.resolve(element.children ?? []);
    }

    private buildTree(): VerilogNode[] {
        const root: TempNode = { children: new Map() };

        for (const uri of this.files) {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            const parts = relPath.split('/');
            this.insertPath(root, parts, uri);
        }

        return this.convertRootToNodes(root);
    }

    private insertPath(node: TempNode, parts: string[], uri: vscode.Uri): void {
        if (parts.length === 0) {
            return;
        }

        const [head, ...rest] = parts;
        let child = node.children.get(head);
        if (!child) {
            child = { children: new Map() };
            node.children.set(head, child);
        }

        if (rest.length === 0) {
            child.uri = uri;
        } else {
            this.insertPath(child, rest, uri);
        }
    }

    private convertRootToNodes(root: TempNode): VerilogNode[] {
        const entries = Array.from(root.children.entries());
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        return entries.map(([name, temp]) => this.convertNode(name, temp));
    }

    private convertNode(name: string, temp: TempNode): VerilogNode {
        const childEntries = Array.from(temp.children.entries());
        childEntries.sort((a, b) => a[0].localeCompare(b[0]));

        const folderChildren = childEntries.map(([childName, childTemp]) =>
            this.convertNode(childName, childTemp),
        );

        if (temp.uri) {
            const modulesForFile =
                this.design?.modulesByFile.get(temp.uri.toString()) ?? [];

            const moduleNodes = modulesForFile.map(m =>
                new VerilogNode(
                    `module ${m.name}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        location: new vscode.Location(m.uri, m.definitionRange),
                        moduleName: m.name,
                    },
                ),
            );

            if (moduleNodes.length > 0) {
                return new VerilogNode(
                    name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    {
                        uri: temp.uri,
                        children: moduleNodes,
                    },
                );
            }

            return new VerilogNode(
                name,
                vscode.TreeItemCollapsibleState.None,
                { uri: temp.uri },
            );
        }

        return new VerilogNode(
            name,
            vscode.TreeItemCollapsibleState.Collapsed,
            { children: folderChildren },
        );
    }
}

// -------------------- Hierarchy Tree --------------------

// Add location so click opens the file
class HierarchyNode extends vscode.TreeItem {
    public readonly children?: HierarchyNode[];
    public readonly definitionLocation?: vscode.Location;
    public readonly instanceLocation?: vscode.Location;

    constructor(
        public moduleName: string,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            children?: HierarchyNode[];
            definitionLocation?: vscode.Location;
            instanceLocation?: vscode.Location;
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.definitionLocation = options?.definitionLocation;
        this.instanceLocation = options?.instanceLocation;
        this.contextValue = 'verilogModuleHierarchy';

        const target = this.instanceLocation ?? this.definitionLocation;
        if (target) {
            this.command = {
                command: 'vscode.open',
                title: 'Open Module',
                arguments: [target.uri, { selection: target.range }],
            };
        }
    }
}

class VerilogHierarchyProvider implements vscode.TreeDataProvider<HierarchyNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HierarchyNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<HierarchyNode | undefined | void> =
        this._onDidChangeTreeData.event;

    private design: ParsedDesign | null = null;
    private roots: string[] = [];

    update(design: ParsedDesign | null): void {
        this.design = design;
        this.recomputeRoots();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HierarchyNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HierarchyNode): Thenable<HierarchyNode[]> {
        if (!element) {
            if (!this.design) {
                return Promise.resolve([]);
            }
            return Promise.resolve(
                this.roots.map(name => this.createNodeForModule(name, new Set())),
            );
        }
        return Promise.resolve(element.children ?? []);
    }

    private recomputeRoots(): void {
        if (!this.design) {
            this.roots = [];
            return;
        }

        const instantiated = new Set<string>();
        for (const m of this.design.modules) {
            for (const inst of m.instances) {
                instantiated.add(inst.moduleName);
            }
        }

        const rootSet = new Set<string>();
        for (const m of this.design.modules) {
            if (!instantiated.has(m.name)) {
                rootSet.add(m.name);
            }
        }

        this.roots = Array.from(rootSet).sort();
    }

    private createNodeForModule(
        name: string,
        visited: Set<string>,
        instanceLocation?: vscode.Location,
        definitionLocation?: vscode.Location,
    ): HierarchyNode {
        if (!this.design) {
            return new HierarchyNode(name, name, vscode.TreeItemCollapsibleState.None);
        }

        if (visited.has(name)) {
            return new HierarchyNode(
                name,
                `${name} (cycle)`,
                vscode.TreeItemCollapsibleState.None,
                { instanceLocation },
            );
        }

        const newVisited = new Set(visited);
        newVisited.add(name);

        const mods = this.design.modulesByName.get(name) ?? [];
        const instances = mods.flatMap(m => m.instances);

        // Pick the first module implementation for navigation
        const primaryModule = mods[0];
        const primaryLocation = definitionLocation ?? (primaryModule
            ? new vscode.Location(primaryModule.uri, primaryModule.definitionRange)
            : undefined);

        const children: HierarchyNode[] = [];

        for (const inst of instances) {
            const targets = this.design.modulesByName.get(inst.moduleName);
            if (!targets || targets.length === 0) {
                children.push(
                    new HierarchyNode(
                        inst.moduleName,
                        `${inst.instanceName}: ${inst.moduleName} (external)`,
                        vscode.TreeItemCollapsibleState.None,
                        { instanceLocation: inst.location },
                    ),
                );
                continue;
            }

            for (const t of targets) {
                const childLoc = new vscode.Location(t.uri, t.definitionRange);
                const childNode = this.createNodeForModule(
                    t.name,
                    newVisited,
                    inst.location,
                    childLoc,
                );
                childNode.label = `${inst.instanceName}: ${t.name}`;
                children.push(childNode);
            }
        }

        const state = children.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        return new HierarchyNode(
            name,
            name,
            state,
            {
                children,
                definitionLocation: primaryLocation,
                instanceLocation,
            },
        );
    }
}

// -------------------- DefinitionProvider --------------------

class VerilogDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private getDesign: () => ParsedDesign | null) {}

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
        const design = this.getDesign();
        if (!design) {
            return null;
        }

        // Find identifier under cursor
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
        if (!wordRange) {
            return null;
        }
        const word = document.getText(wordRange);

        const candidates = design.modulesByName.get(word);
        if (!candidates || candidates.length === 0) {
            return null;
        }

        const locations: vscode.Location[] = [];
        const seen = new Set<string>();

        for (const m of candidates) {
            const range = m.definitionRange;
            const key = `${m.uri.toString()}:${range.start.line}:${range.start.character}`;
            if (seen.has(key)) {
                continue; // already added this location
            }
            seen.add(key);
            locations.push(new vscode.Location(m.uri, range));
        }

        return locations.length > 0 ? locations : null;
    }
}

// -------------------- Shared index + auto refresh --------------------

export function activate(context: vscode.ExtensionContext) {
    const backend = new TsRegexParserBackend();

    const projectTreeProvider = new VerilogProjectTreeProvider();
    const hierarchyProvider = new VerilogHierarchyProvider();

    vscode.window.registerTreeDataProvider('vetreeVerilogView', projectTreeProvider);
    vscode.window.registerTreeDataProvider('vetreeVerilogHierarchyView', hierarchyProvider);

    let refreshTimer: NodeJS.Timeout | undefined;

    const fullRefresh = async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            currentDesign = null;
            projectTreeProvider.update([], null);
            hierarchyProvider.update(null);
            return;
        }

        const files = await vscode.workspace.findFiles(
            '**/*.{v,sv}',
            '**/{.git,node_modules,out,dist,build}/**',
        );

        const design = await backend.parseFiles(files);
        currentDesign = design;

        projectTreeProvider.update(files, design);
        hierarchyProvider.update(design);
    };

    const scheduleFullRefresh = () => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
            fullRefresh().catch(err =>
                console.error('Failed to refresh Verilog index:', err),
            );
        }, 300);
    };

    // Manual refresh commands
    const refreshTreeCmd = vscode.commands.registerCommand(
        'vetree-verilog.refreshTree',
        () => scheduleFullRefresh(),
    );
    const refreshHierarchyCmd = vscode.commands.registerCommand(
        'vetree-verilog.refreshHierarchy',
        () => scheduleFullRefresh(),
    );

    context.subscriptions.push(refreshTreeCmd, refreshHierarchyCmd);

    const showModulePortsCmd = vscode.commands.registerCommand(
        'vetree-verilog.showModulePorts',
        async (item: VerilogNode | HierarchyNode) => {
            const design = currentDesign;
            if (!design) {
                vscode.window.showInformationMessage('Verilog design is not indexed yet.');
                return;
            }

            let moduleName: string | undefined;

            if (item instanceof HierarchyNode) {
                moduleName = item.moduleName;
            } else if (item instanceof VerilogNode && item.contextValue === 'verilogModule') {
                moduleName = item.moduleName;
            }

            if (!moduleName) {
                vscode.window.showInformationMessage('No module associated with this item.');
                return;
            }

            const modules = design.modulesByName.get(moduleName);
            if (!modules || modules.length === 0) {
                vscode.window.showInformationMessage(`Module "${moduleName}" not found in index.`);
                return;
            }

            // If module is defined in multiple files, let the user pick
            let targetModule = modules[0];
            if (modules.length > 1) {
                const pick = await vscode.window.showQuickPick(
                    modules.map(m => ({
                        label: moduleName!,
                        description: vscode.workspace.asRelativePath(m.uri),
                        mod: m,
                    })),
                    { title: `Select module "${moduleName}" variant` },
                );
                if (!pick) {
                    return;
                }
                targetModule = pick.mod;
            }

            const ports = targetModule.ports;
            if (!ports || ports.length === 0) {
                vscode.window.showInformationMessage(`Module "${moduleName}" has no parsed ports.`);
                return;
            }

            const items = ports.map(p => ({
                label: `${p.direction.padEnd(7)} ${p.name}`,
                description: p.rangeText ?? '',
                port: p,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                title: `Ports of module "${moduleName}"`,
                placeHolder: 'Select port to jump to its definition',
            });

            if (!selected) {
                return;
            }

            const loc = selected.port.location;
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
            editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
        },
    );

    context.subscriptions.push(showModulePortsCmd);

    const goToDefinitionCmd = vscode.commands.registerCommand(
        'vetree-verilog.goToDefinition',
        async (item: HierarchyNode) => {
            const loc = item?.definitionLocation;
            if (!loc) {
                vscode.window.showInformationMessage('Module definition not found.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
            editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
        },
    );

    context.subscriptions.push(goToDefinitionCmd);

    // Auto refresh on .v/.sv changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{v,sv}');
    watcher.onDidCreate(() => scheduleFullRefresh());
    watcher.onDidChange(() => scheduleFullRefresh());
    watcher.onDidDelete(() => scheduleFullRefresh());
    context.subscriptions.push(watcher);

    // DefinitionProvider for Verilog files
    const defProvider = new VerilogDefinitionProvider(() => currentDesign);
    const selector: vscode.DocumentSelector = [
        { scheme: 'file', language: 'verilog' },
        { scheme: 'file', language: 'systemverilog' },
    ];
    const defReg = vscode.languages.registerDefinitionProvider(selector, defProvider);
    context.subscriptions.push(defReg);

    // Initial pass
    scheduleFullRefresh();
}

export function deactivate() {
    // no-op
}
