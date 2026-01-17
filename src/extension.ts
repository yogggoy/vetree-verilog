import * as vscode from 'vscode';
import * as path from 'path';
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
    public readonly uri?: vscode.Uri;
    public readonly location?: vscode.Location;
    public parent?: VerilogNode;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            children?: VerilogNode[];
            uri?: vscode.Uri;              // file
            location?: vscode.Location;    // module
            moduleName?: string;           // module name
            parent?: VerilogNode;
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.moduleName = options?.moduleName;
        this.uri = options?.uri;
        this.location = options?.location;
        this.parent = options?.parent;

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

    getParent(element: VerilogNode): vscode.ProviderResult<VerilogNode> {
        return element.parent;
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
        return entries.map(([name, temp]) => this.convertNode(name, temp, undefined));
    }

    private convertNode(name: string, temp: TempNode, parent: VerilogNode | undefined): VerilogNode {
        const childEntries = Array.from(temp.children.entries());
        childEntries.sort((a, b) => a[0].localeCompare(b[0]));

        let node: VerilogNode | undefined;
        const folderChildren = childEntries.map(([childName, childTemp]) =>
            this.convertNode(childName, childTemp, node),
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
                        parent: undefined,
                    },
                ),
            );

            if (moduleNodes.length > 0) {
                node = new VerilogNode(
                    name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    {
                        uri: temp.uri,
                        children: moduleNodes,
                        parent,
                    },
                );
                for (const child of moduleNodes) {
                    child.parent = node;
                }
                return node;
            }

            node = new VerilogNode(
                name,
                vscode.TreeItemCollapsibleState.None,
                { uri: temp.uri, parent },
            );
            return node;
        }

        node = new VerilogNode(
            name,
            vscode.TreeItemCollapsibleState.Collapsed,
            { children: folderChildren, parent },
        );
        for (const child of folderChildren) {
            child.parent = node;
        }
        return node;
    }

    findModuleNode(moduleName: string, uri?: vscode.Uri): VerilogNode | undefined {
        return this.findNode((node) => {
            if (!node.moduleName || node.moduleName !== moduleName) {
                return false;
            }
            if (!uri) {
                return true;
            }
            return node.location?.uri.toString() === uri.toString();
        });
    }

    findFileNode(uri: vscode.Uri): VerilogNode | undefined {
        return this.findNode((node) => node.uri?.toString() === uri.toString());
    }

    private findNode(
        predicate: (node: VerilogNode) => boolean,
        nodes: VerilogNode[] = this.data,
    ): VerilogNode | undefined {
        for (const node of nodes) {
            if (predicate(node)) {
                return node;
            }
            const children = node.children ?? [];
            const found = this.findNode(predicate, children);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
}

// -------------------- Hierarchy Tree --------------------

// Add location so click opens the file
class HierarchyNode extends vscode.TreeItem {
    public readonly children?: HierarchyNode[];
    public readonly definitionLocation?: vscode.Location;
    public readonly instanceLocation?: vscode.Location;
    public parent?: HierarchyNode;

    constructor(
        public moduleName: string,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            children?: HierarchyNode[];
            definitionLocation?: vscode.Location;
            instanceLocation?: vscode.Location;
            parent?: HierarchyNode;
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.definitionLocation = options?.definitionLocation;
        this.instanceLocation = options?.instanceLocation;
        this.parent = options?.parent;
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
    private rootNodes: HierarchyNode[] = [];
    private maxDepth = 100;
    private resolveStrategy: 'all' | 'first' = 'all';
    private topModule: string | undefined;
    private stats = {
        nodeCount: 0,
        maxDepthSeen: 0,
        depthLimitHits: 0,
        cycleHits: 0,
    };

    update(
        design: ParsedDesign | null,
        maxDepth: number,
        resolveStrategy: 'all' | 'first',
        topModule?: string,
    ): void {
        this.design = design;
        this.recomputeRoots();
        this.maxDepth = maxDepth;
        this.resolveStrategy = resolveStrategy;
        this.topModule = topModule;
        this.stats = {
            nodeCount: 0,
            maxDepthSeen: 0,
            depthLimitHits: 0,
            cycleHits: 0,
        };
        const rootList = this.topModule
            ? this.roots.filter(r => r === this.topModule)
            : this.roots;
        this.rootNodes = rootList.map(name =>
            this.createNodeForModule(name, new Set(), undefined, undefined, undefined, 0),
        );
        if (this.design) {
            console.log(
                `Hierarchy build: nodes=${this.stats.nodeCount}, maxDepth=${this.stats.maxDepthSeen}, ` +
                `depthLimitHits=${this.stats.depthLimitHits}, cycles=${this.stats.cycleHits}`,
            );
        }
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
            return Promise.resolve(this.rootNodes);
        }
        return Promise.resolve(element.children ?? []);
    }

    getParent(element: HierarchyNode): vscode.ProviderResult<HierarchyNode> {
        return element.parent;
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
        parent?: HierarchyNode,
        depth?: number,
    ): HierarchyNode {
        const safeDepth = depth ?? 0;
        this.stats.maxDepthSeen = Math.max(this.stats.maxDepthSeen, safeDepth);

        if (!this.design) {
            return new HierarchyNode(name, name, vscode.TreeItemCollapsibleState.None);
        }

        if (safeDepth >= this.maxDepth) {
            this.stats.depthLimitHits++;
            this.stats.nodeCount++;
            return new HierarchyNode(
                name,
                `${name} (depth limit)`,
                vscode.TreeItemCollapsibleState.None,
                { instanceLocation, definitionLocation, parent },
            );
        }

        if (visited.has(name)) {
            this.stats.cycleHits++;
            this.stats.nodeCount++;
            return new HierarchyNode(
                name,
                `${name} (cycle)`,
                vscode.TreeItemCollapsibleState.None,
                { instanceLocation, parent },
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
                const externalNode = new HierarchyNode(
                    inst.moduleName,
                    `${inst.instanceName}: ${inst.moduleName} (external)`,
                    vscode.TreeItemCollapsibleState.None,
                    { instanceLocation: inst.location, parent: undefined },
                );
                this.stats.nodeCount++;
                children.push(externalNode);
                continue;
            }

            const resolvedTargets =
                this.resolveStrategy === 'first' ? targets.slice(0, 1) : targets;
            for (const t of resolvedTargets) {
                const childLoc = new vscode.Location(t.uri, t.definitionRange);
                const childNode = this.createNodeForModule(
                    t.name,
                    newVisited,
                    inst.location,
                    childLoc,
                    undefined,
                    safeDepth + 1,
                );
                childNode.label = `${inst.instanceName}: ${t.name}`;
                children.push(childNode);
            }
        }

        const state = children.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const node = new HierarchyNode(
            name,
            name,
            state,
            {
                children,
                definitionLocation: primaryLocation,
                instanceLocation,
                parent,
            },
        );
        this.stats.nodeCount++;
        for (const child of children) {
            child.parent = node;
        }
        return node;
    }

    findNodeByModuleName(name: string): HierarchyNode | undefined {
        const visit = (nodes: HierarchyNode[]): HierarchyNode | undefined => {
            for (const node of nodes) {
                if (node.moduleName === name) {
                    return node;
                }
                const children = node.children ?? [];
                const found = visit(children);
                if (found) {
                    return found;
                }
            }
            return undefined;
        };
        return visit(this.rootNodes);
    }
}

async function loadDefinesFromFile(): Promise<Set<string>> {
    const defines = new Set<string>();
    const config = vscode.workspace.getConfiguration('vetree-verilog');
    const definesFile = config.get<string>('definesFile');
    if (!definesFile) {
        return defines;
    }

    const uri = resolveDefinesFileUri(definesFile);
    if (!uri) {
        console.warn('Defines file path is set, but no workspace folder is open.');
        return defines;
    }

    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        parseDefinesFromFilelist(text, defines);
    } catch (err) {
        console.warn(`Failed to read defines file: ${uri.fsPath}`, err);
    }

    return defines;
}

function resolveDefinesFileUri(definesFile: string): vscode.Uri | null {
    if (path.isAbsolute(definesFile)) {
        return vscode.Uri.file(definesFile);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return null;
    }
    return vscode.Uri.joinPath(folders[0].uri, definesFile);
}

function parseDefinesFromFilelist(text: string, defines: Set<string>): void {
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('#')) {
            continue;
        }

        const tokens = line.split(/\s+/);
        for (const token of tokens) {
            if (token.startsWith('+define+')) {
                const rest = token.slice('+define+'.length);
                const parts = rest.split('+');
                for (const part of parts) {
                    const name = part.split('=')[0].trim();
                    if (name) {
                        defines.add(name);
                    }
                }
            } else if (token.startsWith('-D')) {
                const name = token.slice(2).split('=')[0].trim();
                if (name) {
                    defines.add(name);
                }
            }
        }
    }
}

async function filterFilesBySize(
    files: vscode.Uri[],
    maxFileSizeMB: number,
): Promise<{ filteredFiles: vscode.Uri[] }> {
    const stats: Array<{ uri: vscode.Uri; size: number }> = [];
    let totalSize = 0;

    await Promise.all(files.map(async (uri) => {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            stats.push({ uri, size: stat.size });
            totalSize += stat.size;
        } catch (err) {
            console.warn(`Failed to stat file: ${uri.fsPath}`, err);
        }
    }));

    const sorted = [...stats].sort((a, b) => b.size - a.size);
    const top = sorted.slice(0, 5);
    const totalMB = (totalSize / (1024 * 1024)).toFixed(2);

    console.log(
        `Verilog scan: ${stats.length} files, total ${totalMB} MB. Top files:`,
    );
    for (const entry of top) {
        const sizeMB = (entry.size / (1024 * 1024)).toFixed(2);
        const rel = vscode.workspace.asRelativePath(entry.uri, false);
        console.log(`  ${rel} (${sizeMB} MB)`);
    }

    if (!maxFileSizeMB || maxFileSizeMB <= 0) {
        return { filteredFiles: stats.map(s => s.uri) };
    }

    const limitBytes = maxFileSizeMB * 1024 * 1024;
    const filtered = stats.filter(s => s.size <= limitBytes);
    const skipped = stats.length - filtered.length;
    if (skipped > 0) {
        console.warn(
            `Verilog scan: skipped ${skipped} file(s) larger than ${maxFileSizeMB} MB.`,
        );
    }

    return { filteredFiles: filtered.map(s => s.uri) };
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
            const key = [
                m.uri.toString(),
                range.start.line,
                range.start.character,
                range.end.line,
                range.end.character,
            ].join(':');
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

    const projectTreeView = vscode.window.createTreeView('vetreeVerilogView', {
        treeDataProvider: projectTreeProvider,
        showCollapseAll: true,
    });
    const hierarchyTreeView = vscode.window.createTreeView('vetreeVerilogHierarchyView', {
        treeDataProvider: hierarchyProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(projectTreeView, hierarchyTreeView);

    let refreshTimer: NodeJS.Timeout | undefined;
    let refreshInProgress = false;
    let refreshPending = false;
    let lastDuplicateWarning = '';

    const isDebugEnabled = () =>
        vscode.workspace.getConfiguration('vetree-verilog').get<boolean>('debugLogging') ?? false;

    const logDebug = (message: string) => {
        if (isDebugEnabled()) {
            console.log(message);
        }
    };

    const fullRefresh = async () => {
        if (refreshInProgress) {
            refreshPending = true;
            return;
        }
        refreshInProgress = true;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            currentDesign = null;
            projectTreeProvider.update([], null);
            const maxHierarchyDepth = vscode.workspace
                .getConfiguration('vetree-verilog')
                .get<number>('maxHierarchyDepth') ?? 100;
            const config = vscode.workspace.getConfiguration('vetree-verilog');
            const resolveStrategy = config.get<'all' | 'first'>('hierarchyResolve') ?? 'all';
            const topModule = config.get<string>('hierarchyTopModule')?.trim() || undefined;
            hierarchyProvider.update(null, maxHierarchyDepth, resolveStrategy, topModule);
            refreshInProgress = false;
            return;
        }

        const refreshStart = Date.now();
        const defines = await loadDefinesFromFile();

        const files = await vscode.workspace.findFiles(
            '**/*.{v,sv}',
            '**/{.git,node_modules,out,dist,build}/**',
        );

        const config = vscode.workspace.getConfiguration('vetree-verilog');
        const maxFileSizeMB = config.get<number>('maxFileSizeMB') ?? 0;
        const enablePreprocess = !(config.get<boolean>('quickScan') ?? false);
        const maxHierarchyDepth = config.get<number>('maxHierarchyDepth') ?? 100;
        const skipHierarchyBuild = config.get<boolean>('skipHierarchyBuild') ?? false;
        const resolveStrategy = config.get<'all' | 'first'>('hierarchyResolve') ?? 'all';
        const topModule = config.get<string>('hierarchyTopModule')?.trim() || undefined;

        const { filteredFiles } = await filterFilesBySize(files, maxFileSizeMB);

        logDebug(
            `Refresh start: files=${filteredFiles.length}, defines=${defines.size}, ` +
            `preprocess=${enablePreprocess}, maxDepth=${maxHierarchyDepth}`,
        );

        const design = await backend.parseFiles(filteredFiles, defines, {
            enablePreprocess,
            logDebug,
        });
        currentDesign = design;

        projectTreeProvider.update(filteredFiles, design);
        if (skipHierarchyBuild) {
            logDebug('Hierarchy build skipped by configuration.');
            hierarchyProvider.update(null, maxHierarchyDepth, resolveStrategy, topModule);
        } else {
            const duplicates = Array.from(design.modulesByName.entries())
                .filter(([, mods]) => mods.length > 1)
                .sort((a, b) => b[1].length - a[1].length);
            if (duplicates.length > 0) {
                const top = duplicates
                    .slice(0, 5)
                    .map(([name, mods]) => `${name}(${mods.length})`)
                    .join(', ');
                logDebug(`Duplicate module names: ${duplicates.length} (top: ${top})`);
                const key = `${duplicates.length}:${topModule ?? ''}:${resolveStrategy}`;
                if (key !== lastDuplicateWarning) {
                    lastDuplicateWarning = key;
                    vscode.window.showInformationMessage(
                        `Multiple definitions found for ${duplicates.length} module(s). ` +
                        `Consider setting "vetree-verilog.hierarchyResolve": "first" ` +
                        `or "vetree-verilog.hierarchyTopModule".`,
                    );
                }
            }
            hierarchyProvider.update(design, maxHierarchyDepth, resolveStrategy, topModule);
        }

        const refreshEnd = Date.now();
        const mem = process.memoryUsage();
        logDebug(
            `Refresh done: modules=${design.modules.length}, time=${refreshEnd - refreshStart}ms, ` +
            `rss=${(mem.rss / 1048576).toFixed(1)}MB, heapUsed=${(mem.heapUsed / 1048576).toFixed(1)}MB`,
        );
        refreshInProgress = false;
        if (refreshPending) {
            refreshPending = false;
            scheduleFullRefresh();
        }
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

    const revealInHierarchyCmd = vscode.commands.registerCommand(
        'vetree-verilog.revealInHierarchy',
        async (item: VerilogNode) => {
            if (!item?.moduleName) {
                vscode.window.showInformationMessage('No module associated with this item.');
                return;
            }
            const target = hierarchyProvider.findNodeByModuleName(item.moduleName);
            if (!target) {
                vscode.window.showInformationMessage(
                    `Module "${item.moduleName}" not found in hierarchy.`,
                );
                return;
            }
            await hierarchyTreeView.reveal(target, { select: true, focus: true, expand: true });
        },
    );
    context.subscriptions.push(revealInHierarchyCmd);

    const revealInProjectTreeCmd = vscode.commands.registerCommand(
        'vetree-verilog.revealInProjectTree',
        async (item: HierarchyNode) => {
            const loc = item?.definitionLocation ?? item?.instanceLocation;
            if (!loc) {
                vscode.window.showInformationMessage('No file location associated with this item.');
                return;
            }
            const moduleNode = projectTreeProvider.findModuleNode(item.moduleName, loc.uri);
            const target = moduleNode ?? projectTreeProvider.findFileNode(loc.uri);
            if (!target) {
                vscode.window.showInformationMessage(
                    `File "${vscode.workspace.asRelativePath(loc.uri)}" not found in project tree.`,
                );
                return;
            }
            await projectTreeView.reveal(target, { select: true, focus: true, expand: true });
        },
    );
    context.subscriptions.push(revealInProjectTreeCmd);

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
