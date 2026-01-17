import * as vscode from 'vscode';

export type PortDirection = 'input' | 'output' | 'inout' | 'ref' | 'unknown';

export interface PortInfo {
    direction: PortDirection;
    name: string;
    rangeText?: string;       // e.g. "[7:0]" or "[ADDR_W-1:0]"
    location: vscode.Location;
}

export interface InstanceRef {
    moduleName: string;
    instanceName: string;
    location: vscode.Location;
    bindings: PortBinding[];
}

export interface PortBinding {
    portName: string;
    expr: string;
    location: vscode.Location;
}

export interface ParsedModule {
    name: string;
    uri: vscode.Uri;
    definitionRange: vscode.Range;
    instances: InstanceRef[];
    ports: PortInfo[];
}

export interface ParsedDesign {
    modules: ParsedModule[];
    modulesByName: Map<string, ParsedModule[]>;
    modulesByFile: Map<string, ParsedModule[]>;
}

export interface VerilogParserBackend {
    parseFiles(
        files: vscode.Uri[],
        defines?: Set<string>,
        options?: {
            enablePreprocess?: boolean;
            logDebug?: (message: string) => void;
            includeDirs?: vscode.Uri[];
        },
    ): Promise<ParsedDesign>;
}
