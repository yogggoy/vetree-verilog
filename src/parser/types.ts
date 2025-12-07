// src/parser/types.ts
import * as vscode from 'vscode';

export interface InstanceRef {
    moduleName: string;
    instanceName: string;
    location: vscode.Location; // на будущее для перехода к инстансу
}

export interface ParsedModule {
    name: string;
    uri: vscode.Uri;
    definitionRange: vscode.Range;
    instances: InstanceRef[];
}

export interface ParsedDesign {
    modules: ParsedModule[];
    modulesByName: Map<string, ParsedModule[]>;
    modulesByFile: Map<string, ParsedModule[]>;
}

export interface VerilogParserBackend {
    parseFiles(files: vscode.Uri[]): Promise<ParsedDesign>;
}
