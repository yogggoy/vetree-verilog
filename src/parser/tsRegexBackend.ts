// src/parser/tsRegexBackend.ts
import * as vscode from 'vscode';
import {
    InstanceRef,
    ParsedDesign,
    ParsedModule,
    VerilogParserBackend,
} from './types';

export class TsRegexParserBackend implements VerilogParserBackend {
    async parseFiles(files: vscode.Uri[]): Promise<ParsedDesign> {
        const modules: ParsedModule[] = [];

        for (const uri of files) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                const modsInFile = parseModulesAndInstancesInFile(text, uri);
                modules.push(...modsInFile);
            } catch (err) {
                console.error(`Failed to read ${uri.fsPath}:`, err);
            }
        }

        const modulesByName = new Map<string, ParsedModule[]>();
        const modulesByFile = new Map<string, ParsedModule[]>();

        for (const m of modules) {
            // по имени
            let arrByName = modulesByName.get(m.name);
            if (!arrByName) {
                arrByName = [];
                modulesByName.set(m.name, arrByName);
            }
            arrByName.push(m);

            // по файлу
            const key = m.uri.toString();
            let arrByFile = modulesByFile.get(key);
            if (!arrByFile) {
                arrByFile = [];
                modulesByFile.set(key, arrByFile);
            }
            arrByFile.push(m);
        }

        return { modules, modulesByName, modulesByFile };
    }
}

// --------- helpers: парсер на regex ---------

function stripVerilogComments(source: string): string {
    // Сохраняем длину текста и позиции строк/столбцов.
    // В комментариях заменяем всё, кроме '\n', на пробелы.

    // Многострочные комментарии /* ... */
    let result = source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
        return match.replace(/[^\n]/g, ' ');
    });

    // Однострочные комментарии // ...
    result = result.replace(/\/\/.*$/gm, (match) => {
        return match.replace(/[^\n]/g, ' ');
    });

    return result;
}

function parseModulesAndInstancesInFile(source: string, uri: vscode.Uri): ParsedModule[] {
    const modules: ParsedModule[] = [];
    const clean = stripVerilogComments(source);

    // Важно: только пробел/таб, без '\n'
    const moduleRegex = /^[ \t]*module\s+([a-zA-Z_]\w*)/gm;
    const endRegex = /\bendmodule\b/gm;

    const moduleMatches: { name: string; start: number; bodyStart: number }[] = [];
    let m: RegExpExecArray | null;

    while ((m = moduleRegex.exec(clean)) !== null) {
        const name = m[1];
        const bodyStart = moduleRegex.lastIndex;
        moduleMatches.push({ name, start: m.index, bodyStart });
    }

    for (let i = 0; i < moduleMatches.length; i++) {
        const cur = moduleMatches[i];

        let bodyEnd = clean.length;

        endRegex.lastIndex = cur.bodyStart;
        const endMatch = endRegex.exec(clean);
        if (endMatch) {
            bodyEnd = endMatch.index;
        }
        if (i + 1 < moduleMatches.length && moduleMatches[i + 1].start < bodyEnd) {
            bodyEnd = moduleMatches[i + 1].start;
        }

        // парсим инстансы в диапазоне [bodyStart, bodyEnd)
        const instances = parseInstantiationsInText(clean, uri, cur.bodyStart, bodyEnd);

        const defPos = offsetToPosition(clean, cur.start);
        const defRange = new vscode.Range(defPos, defPos);

        modules.push({
            name: cur.name,
            uri,
            definitionRange: defRange,
            instances,
        });
    }

    return modules;
}

function parseInstantiationsInText(
    clean: string,
    uri: vscode.Uri,
    bodyStart: number,
    bodyEnd: number,
): InstanceRef[] {
    const result: InstanceRef[] = [];

    // Тоже без '\n' в начале строки
    const instRegex =
        /^[ \t]*([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\s*(?:#\s*\([^;]*\))?\s*\(/gm;

    const keywords = new Set([
        'if', 'else', 'begin', 'end', 'case', 'casex', 'casez',
        'for', 'while', 'repeat', 'forever',
        'always', 'always_ff', 'always_comb', 'always_latch',
        'assign', 'deassign', 'force', 'release',
        'wire', 'reg', 'logic', 'tri', 'tri0', 'tri1',
        'module', 'endmodule',
        'function', 'endfunction',
        'task', 'endtask',
        'generate', 'endgenerate',
        'initial', 'final',
        'parameter', 'localparam',
        'specify', 'endspecify',
        'primitive', 'endprimitive',
    ]);

    instRegex.lastIndex = bodyStart;
    let m: RegExpExecArray | null;
    while ((m = instRegex.exec(clean)) !== null) {
        if (m.index >= bodyEnd) {
            break;
        }

        const moduleName = m[1];
        const instanceName = m[2];

        const modLower = moduleName.toLowerCase();
        const instLower = instanceName.toLowerCase();
        if (keywords.has(modLower) || keywords.has(instLower)) {
            continue;
        }

        const globalOffset = m.index;
        const pos = offsetToPosition(clean, globalOffset);
        const loc = new vscode.Location(uri, pos);

        result.push({ moduleName, instanceName, location: loc });
    }

    return result;
}

// простой offset -> position (по строкам)
function offsetToPosition(text: string, offset: number): vscode.Position {
    let line = 0;
    let lastLineStart = 0;

    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) {
            line++;
            lastLineStart = i + 1;
        }
    }

    const character = offset - lastLineStart;
    return new vscode.Position(line, character);
}
