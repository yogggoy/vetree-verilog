import * as vscode from 'vscode';
import * as path from 'path';
import {
    ParsedDesign,
    InstanceRef,
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
            contextValue?: string;
            description?: string;
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.moduleName = options?.moduleName;
        this.uri = options?.uri;
        this.location = options?.location;
        this.parent = options?.parent;
        if (options?.description) {
            this.description = options.description;
        }

        if (options?.location) {
            // Module node
            this.command = {
                command: 'vscode.open',
                title: 'Open Module Definition',
                arguments: [options.location.uri, { selection: options.location.range }],
            };
            this.contextValue = options?.contextValue ?? 'verilogModule';
        } else if (options?.uri) {
            // File node
            this.resourceUri = options.uri;
            this.command = {
                command: 'vscode.open',
                title: 'Open Verilog File',
                arguments: [options.uri],
            };
            this.contextValue = options?.contextValue ?? 'verilogFile';
        } else {
            // Folder
            this.contextValue = options?.contextValue ?? 'verilogFolder';
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

            const moduleNodes = modulesForFile.map(m => {
                const portNodes = m.ports.map(p =>
                    new VerilogNode(
                        `${p.direction} ${p.name}`,
                        vscode.TreeItemCollapsibleState.None,
                        {
                            location: p.location,
                            contextValue: 'verilogPort',
                            description: p.rangeText ?? '',
                        },
                    ),
                );
                return new VerilogNode(
                    `module ${m.name}`,
                    portNodes.length > 0
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.None,
                    {
                        location: new vscode.Location(m.uri, m.definitionRange),
                        moduleName: m.name,
                        children: portNodes,
                        parent: undefined,
                    },
                );
            });

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
                    for (const port of child.children ?? []) {
                        port.parent = child;
                    }
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
    public instanceName?: string;
    public parentModuleName?: string;

    constructor(
        public moduleName: string,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: {
            children?: HierarchyNode[];
            definitionLocation?: vscode.Location;
            instanceLocation?: vscode.Location;
            parent?: HierarchyNode;
            instanceName?: string;
            parentModuleName?: string;
            contextValue?: string;
        },
    ) {
        super(label, collapsibleState);
        this.children = options?.children;
        this.definitionLocation = options?.definitionLocation;
        this.instanceLocation = options?.instanceLocation;
        this.parent = options?.parent;
        this.instanceName = options?.instanceName;
        this.parentModuleName = options?.parentModuleName;
        this.contextValue = options?.contextValue ?? 'verilogModuleHierarchy';

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
                    {
                        instanceLocation: inst.location,
                        parent: undefined,
                        instanceName: inst.instanceName,
                        parentModuleName: name,
                        contextValue: 'verilogModuleInstance',
                    },
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
                childNode.instanceName = inst.instanceName;
                childNode.parentModuleName = name;
                childNode.contextValue = 'verilogModuleInstance';
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

type ConnectionInfo = {
    label: string;
    location?: vscode.Location;
};

class ConnectionNode extends vscode.TreeItem {
    constructor(label: string, location?: vscode.Location) {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (location) {
            this.command = {
                command: 'vscode.open',
                title: 'Open Connection',
                arguments: [location.uri, { selection: location.range }],
            };
        }
    }
}

class DirectConnectionsProvider implements vscode.TreeDataProvider<ConnectionNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ConnectionNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ConnectionNode | undefined | void> =
        this._onDidChangeTreeData.event;
    private data: ConnectionNode[] = [];

    update(connections: ConnectionInfo[]): void {
        this.data = connections.map(c => new ConnectionNode(c.label, c.location));
        this._onDidChangeTreeData.fire();
    }

    getFirst(): ConnectionNode | undefined {
        return this.data[0];
    }

    getTreeItem(element: ConnectionNode): vscode.TreeItem {
        return element;
    }

    getParent(_element: ConnectionNode): vscode.ProviderResult<ConnectionNode> {
        return undefined;
    }

    getChildren(): Thenable<ConnectionNode[]> {
        return Promise.resolve(this.data);
    }
}

type FilelistData = {
    defines: Set<string>;
    files: vscode.Uri[];
    topModule?: string;
};

async function loadFilelist(): Promise<FilelistData> {
    const defines = new Set<string>();
    const config = vscode.workspace.getConfiguration('vetree-verilog');
    const definesFile = config.get<string>('definesFile');
    if (!definesFile) {
        return { defines, files: [] };
    }

    const uri = resolveDefinesFileUri(definesFile);
    if (!uri) {
        console.warn('Defines file path is set, but no workspace folder is open.');
        return { defines, files: [] };
    }

    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        return await parseFilelist(text, uri);
    } catch (err) {
        console.warn(`Failed to read defines file: ${uri.fsPath}`, err);
        return { defines, files: [] };
    }
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

async function parseFilelist(text: string, filelistUri: vscode.Uri): Promise<FilelistData> {
    const defines = new Set<string>();
    const files: vscode.Uri[] = [];
    let topModule: string | undefined;

    const folders = vscode.workspace.workspaceFolders;
    const workspaceRoot = folders && folders.length > 0 ? folders[0].uri : undefined;
    const baseDir = vscode.Uri.joinPath(filelistUri, '..');

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
            } else if (token.startsWith('+top+')) {
                const name = token.slice('+top+'.length).trim();
                if (name) {
                    topModule = name;
                }
            } else if (token.startsWith('+incdir+')) {
                continue;
            } else if (token.startsWith('-I')) {
                continue;
            } else if (token === '-f') {
                continue;
            } else if (token.includes('*') || token.includes('?') || token.includes('[')) {
                if (!workspaceRoot) {
                    continue;
                }
                const glob = makeWorkspaceGlob(token, baseDir, workspaceRoot);
                if (!glob) {
                    continue;
                }
                const matches = await vscode.workspace.findFiles(glob);
                files.push(...matches);
            } else {
                const fileUri = resolveFilePath(token, baseDir);
                if (fileUri) {
                    files.push(fileUri);
                }
            }
        }
    }

    return { defines, files, topModule };
}

function resolveFilePath(token: string, baseDir: vscode.Uri): vscode.Uri | null {
    const trimmed = token.trim();
    if (!trimmed) {
        return null;
    }
    if (path.isAbsolute(trimmed)) {
        return vscode.Uri.file(trimmed);
    }
    return vscode.Uri.joinPath(baseDir, trimmed);
}

function makeWorkspaceGlob(
    token: string,
    baseDir: vscode.Uri,
    workspaceRoot: vscode.Uri,
): string | null {
    const normalized = token.replace(/\\/g, '/');
    if (path.isAbsolute(normalized)) {
        return null;
    }
    const baseRel = vscode.workspace.asRelativePath(baseDir, false).replace(/\\/g, '/');
    return baseRel ? `${baseRel}/${normalized}` : normalized;
}

function findDirectConnections(
    design: ParsedDesign,
    parentModule: string,
    instanceA: string,
    instanceB: string,
): ConnectionInfo[] {
    const modules = design.modulesByName.get(parentModule) ?? [];
    let instA: InstanceRef | undefined;
    let instB: InstanceRef | undefined;

    for (const mod of modules) {
        const a = mod.instances.find(i => i.instanceName === instanceA);
        const b = mod.instances.find(i => i.instanceName === instanceB);
        if (a && b) {
            instA = a;
            instB = b;
            break;
        }
    }

    if (!instA || !instB) {
        return [];
    }

    const normalize = (expr: string) => expr.replace(/\s+/g, '');
    const mapBindings = (bindings: typeof instA.bindings) => {
        const map = new Map<string, typeof instA.bindings>();
        for (const b of bindings) {
            const key = normalize(b.expr);
            if (!key) {
                continue;
            }
            const list = map.get(key) ?? [];
            list.push(b);
            map.set(key, list);
        }
        return map;
    };

    const mapA = mapBindings(instA.bindings);
    const mapB = mapBindings(instB.bindings);
    const result: ConnectionInfo[] = [];

    for (const [expr, portsA] of mapA.entries()) {
        const portsB = mapB.get(expr);
        if (!portsB) {
            continue;
        }
        for (const pa of portsA) {
            for (const pb of portsB) {
                result.push({
                    label: `${instA.instanceName}.${pa.portName} - ${instB.instanceName}.${pb.portName}`,
                    location: pa.location,
                });
            }
        }
    }

    return result;
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
    const connectionsProvider = new DirectConnectionsProvider();

    const projectTreeView = vscode.window.createTreeView('vetreeVerilogView', {
        treeDataProvider: projectTreeProvider,
        showCollapseAll: true,
    });
    const hierarchyTreeView = vscode.window.createTreeView('vetreeVerilogHierarchyView', {
        treeDataProvider: hierarchyProvider,
        showCollapseAll: true,
    });
    const connectionsTreeView = vscode.window.createTreeView('vetreeVerilogConnectionsView', {
        treeDataProvider: connectionsProvider,
        showCollapseAll: false,
    });
    context.subscriptions.push(projectTreeView, hierarchyTreeView, connectionsTreeView);

    let refreshTimer: NodeJS.Timeout | undefined;
    let refreshInProgress = false;
    let refreshPending = false;
    let lastDuplicateWarning = '';
    let lastTopModuleInfo = '';
    let endpointA: { parentModule: string; instance: string } | null = null;
    let endpointB: { parentModule: string; instance: string } | null = null;

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
        const filelist = await loadFilelist();

        const config = vscode.workspace.getConfiguration('vetree-verilog');
        const maxFileSizeMB = config.get<number>('maxFileSizeMB') ?? 0;
        const enablePreprocess = !(config.get<boolean>('quickScan') ?? false);
        const maxHierarchyDepth = config.get<number>('maxHierarchyDepth') ?? 100;
        const skipHierarchyBuild = config.get<boolean>('skipHierarchyBuild') ?? false;
        const resolveStrategy = config.get<'all' | 'first'>('hierarchyResolve') ?? 'all';
        const topModuleConfig = config.get<string>('hierarchyTopModule')?.trim() || undefined;

        const files = filelist.files.length > 0
            ? filelist.files
            : await vscode.workspace.findFiles(
                '**/*.{v,sv}',
                '**/{.git,node_modules,out,dist,build}/**',
            );

        const { filteredFiles } = await filterFilesBySize(files, maxFileSizeMB);
        const topModule = topModuleConfig ?? filelist.topModule;

        if (filelist.files.length > 0) {
            const info = `Filelist mode: files=${filelist.files.length}, top=${filelist.topModule ?? ''}`;
            if (info !== lastTopModuleInfo) {
                lastTopModuleInfo = info;
                logDebug(info);
            }
        }

        logDebug(
            `Refresh start: files=${filteredFiles.length}, defines=${filelist.defines.size}, ` +
            `preprocess=${enablePreprocess}, maxDepth=${maxHierarchyDepth}`,
        );

        const design = await backend.parseFiles(filteredFiles, filelist.defines, {
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

    const setEndpoint = async (item: HierarchyNode, slot: 'A' | 'B') => {
        if (!item?.instanceName || !item?.parentModuleName) {
            vscode.window.showInformationMessage('Select an instance node.');
            return;
        }
        const data = { parentModule: item.parentModuleName, instance: item.instanceName };
        if (slot === 'A') {
            endpointA = data;
        } else {
            endpointB = data;
        }
        vscode.window.showInformationMessage(
            `Endpoint ${slot} set to ${data.instance} (in ${data.parentModule}).`,
        );
        await updateDirectConnections();
    };

    const selectEndpointACmd = vscode.commands.registerCommand(
        'vetree-verilog.selectEndpointA',
        async (item: HierarchyNode) => setEndpoint(item, 'A'),
    );
    const selectEndpointBCmd = vscode.commands.registerCommand(
        'vetree-verilog.selectEndpointB',
        async (item: HierarchyNode) => setEndpoint(item, 'B'),
    );
    context.subscriptions.push(selectEndpointACmd, selectEndpointBCmd);

    const showDirectConnectionsCmd = vscode.commands.registerCommand(
        'vetree-verilog.showDirectConnections',
        async () => {
            if (!endpointA || !endpointB) {
                vscode.window.showInformationMessage('Select endpoint A and B first.');
                return;
            }
            if (endpointA.parentModule !== endpointB.parentModule) {
                vscode.window.showInformationMessage(
                    'Endpoints must be in the same parent module.',
                );
                return;
            }

            const design = currentDesign;
            if (!design) {
                vscode.window.showInformationMessage('Verilog design is not indexed yet.');
                return;
            }

            const connections = findDirectConnections(
                design,
                endpointA.parentModule,
                endpointA.instance,
                endpointB.instance,
            );
            if (connections.length === 0) {
                connectionsProvider.update([]);
                vscode.window.showInformationMessage('No direct connections found.');
                return;
            }

            connectionsProvider.update(connections);
            const first = connectionsProvider.getFirst();
            if (first) {
                await connectionsTreeView.reveal(first, { focus: true, select: true });
            }
        },
    );
    context.subscriptions.push(showDirectConnectionsCmd);

    const updateDirectConnections = async () => {
        if (!endpointA || !endpointB) {
            return;
        }
        if (endpointA.parentModule !== endpointB.parentModule) {
            vscode.window.showInformationMessage(
                'Endpoints must be in the same parent module.',
            );
            return;
        }

        const design = currentDesign;
        if (!design) {
            return;
        }

        const connections = findDirectConnections(
            design,
            endpointA.parentModule,
            endpointA.instance,
            endpointB.instance,
        );
        connectionsProvider.update(connections);
        if (connections.length === 0) {
            vscode.window.showInformationMessage('No direct connections found.');
            return;
        }
        const first = connectionsProvider.getFirst();
        if (first) {
            await connectionsTreeView.reveal(first, { focus: true, select: true });
        }
    };

    const setTopModuleCmd = vscode.commands.registerCommand(
        'vetree-verilog.setTopModule',
        async (item: VerilogNode | HierarchyNode) => {
            const moduleName =
                item instanceof HierarchyNode
                    ? item.moduleName
                    : item instanceof VerilogNode
                        ? item.moduleName
                        : undefined;
            if (!moduleName) {
                vscode.window.showInformationMessage('No module associated with this item.');
                return;
            }
            const config = vscode.workspace.getConfiguration('vetree-verilog');
            await config.update('hierarchyTopModule', moduleName, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Top module set to "${moduleName}".`);
            scheduleFullRefresh();
        },
    );
    context.subscriptions.push(setTopModuleCmd);

    const clearTopModuleCmd = vscode.commands.registerCommand(
        'vetree-verilog.clearTopModule',
        async () => {
            const config = vscode.workspace.getConfiguration('vetree-verilog');
            await config.update('hierarchyTopModule', '', vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage('Top module cleared.');
            scheduleFullRefresh();
        },
    );
    context.subscriptions.push(clearTopModuleCmd);

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
