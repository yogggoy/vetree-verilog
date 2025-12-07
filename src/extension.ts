import * as vscode from 'vscode';
import {
    ParsedDesign,
} from './parser/types';
import { TsRegexParserBackend } from './parser/tsRegexBackend';

// текущий индекс дизайна, чтобы DefinitionProvider мог его видеть
let currentDesign: ParsedDesign | null = null;

// -------------------- Узлы для Project Tree --------------------

interface TempNode {
    children: Map<string, TempNode>;
    uri?: vscode.Uri; // файл
}

class VerilogNode extends vscode.TreeItem {
    public readonly children?: VerilogNode[];

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            children?: VerilogNode[];
            uri?: vscode.Uri;              // для файлов
            location?: vscode.Location;    // для модулей
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;

        if (options?.location) {
            // Узел модуля
            this.command = {
                command: 'vscode.open',
                title: 'Open Module Definition',
                arguments: [options.location.uri, { selection: options.location.range }],
            };
            this.contextValue = 'verilogModule';
        } else if (options?.uri) {
            // Узел файла
            this.resourceUri = options.uri;
            this.command = {
                command: 'vscode.open',
                title: 'Open Verilog File',
                arguments: [options.uri],
            };
            this.contextValue = 'verilogFile';
        } else {
            // Папка
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

// Добавляем location, чтобы по клику открывать файл
class HierarchyNode extends vscode.TreeItem {
    public readonly children?: HierarchyNode[];

    constructor(
        public moduleName: string,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: { children?: HierarchyNode[]; location?: vscode.Location },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.contextValue = 'verilogModuleHierarchy';

        if (options?.location) {
            this.command = {
                command: 'vscode.open',
                title: 'Open Module Definition',
                arguments: [options.location.uri, { selection: options.location.range }],
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

    private createNodeForModule(name: string, visited: Set<string>): HierarchyNode {
        if (!this.design) {
            return new HierarchyNode(name, name, vscode.TreeItemCollapsibleState.None);
        }

        if (visited.has(name)) {
            return new HierarchyNode(
                name,
                `${name} (cycle)`,
                vscode.TreeItemCollapsibleState.None,
            );
        }

        const newVisited = new Set(visited);
        newVisited.add(name);

        const mods = this.design.modulesByName.get(name) ?? [];
        const instances = mods.flatMap(m => m.instances);

        // Выбираем первую реализацию модуля для навигации
        const primaryModule = mods[0];
        const primaryLocation = primaryModule
            ? new vscode.Location(primaryModule.uri, primaryModule.definitionRange)
            : undefined;

        const children: HierarchyNode[] = [];

        for (const inst of instances) {
            const targets = this.design.modulesByName.get(inst.moduleName);
            if (!targets || targets.length === 0) {
                children.push(
                    new HierarchyNode(
                        inst.moduleName,
                        `${inst.instanceName}: ${inst.moduleName} (external)`,
                        vscode.TreeItemCollapsibleState.None,
                        { location: inst.location },
                    ),
                );
                continue;
            }

            for (const t of targets) {
                const childLoc = new vscode.Location(t.uri, t.definitionRange);
                const childNode = this.createNodeForModule(t.name, newVisited);
                childNode.label = `${inst.instanceName}: ${t.name}`;
                // добавляем команду на дочерний узел
                childNode.command = {
                    command: 'vscode.open',
                    title: 'Open Module Definition',
                    arguments: [childLoc.uri, { selection: childLoc.range }],
                };
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
                location: primaryLocation,
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

        // Находим слово под курсором (идентификатор)
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
                continue; // уже добавляли такое определение
            }
            seen.add(key);
            locations.push(new vscode.Location(m.uri, range));
        }

        return locations.length > 0 ? locations : null;
    }
}

// -------------------- Общий индекс + автообновление --------------------

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

    // Команды ручного обновления
    const refreshTreeCmd = vscode.commands.registerCommand(
        'vetree-verilog.refreshTree',
        () => scheduleFullRefresh(),
    );
    const refreshHierarchyCmd = vscode.commands.registerCommand(
        'vetree-verilog.refreshHierarchy',
        () => scheduleFullRefresh(),
    );

    context.subscriptions.push(refreshTreeCmd, refreshHierarchyCmd);

    // Автообновление при изменении файлов .v/.sv
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{v,sv}');
    watcher.onDidCreate(() => scheduleFullRefresh());
    watcher.onDidChange(() => scheduleFullRefresh());
    watcher.onDidDelete(() => scheduleFullRefresh());
    context.subscriptions.push(watcher);

    // DefinitionProvider для верилогов
    const defProvider = new VerilogDefinitionProvider(() => currentDesign);
    const selector: vscode.DocumentSelector = [
        { scheme: 'file', language: 'verilog' },
        { scheme: 'file', language: 'systemverilog' },
    ];
    const defReg = vscode.languages.registerDefinitionProvider(selector, defProvider);
    context.subscriptions.push(defReg);

    // Первичный проход
    scheduleFullRefresh();
}

export function deactivate() {
    // ничего особого
}
