// src/parser/tsRegexBackend.ts
import * as vscode from 'vscode';
import {
    InstanceRef,
    ParsedDesign,
    ParsedModule,
    VerilogParserBackend,
    PortInfo,
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

        // Порты: берём заголовок module (...) ;
        const ports = parseModulePortsFromHeader(clean, uri, cur.start, cur.bodyStart);

        // Инстансы: ищем в теле модуля
        const instances = parseInstantiationsInText(clean, uri, cur.bodyStart, bodyEnd);

        const defPos = offsetToPosition(clean, cur.start);
        const defRange = new vscode.Range(defPos, defPos);

        modules.push({
            name: cur.name,
            uri,
            definitionRange: defRange,
            instances,
            ports,
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

function findMatchingParen(text: string, openIndex: number, maxIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i <= maxIndex && i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function parseModulePortsFromHeader(
    clean: string,
    uri: vscode.Uri,
    moduleStart: number,
    bodyStart: number,
): PortInfo[] {
    const ports: PortInfo[] = [];

    // Find end of header to avoid matching body parens.
    const headerEnd = clean.indexOf(';', bodyStart);
    if (headerEnd === -1) {
        return ports;
    }

    // Skip optional parameter list: module name #( ... ) ( ... );
    let scanIndex = bodyStart;
    while (scanIndex < headerEnd && /\s/.test(clean[scanIndex])) {
        scanIndex++;
    }
    if (scanIndex < headerEnd && clean[scanIndex] === '#') {
        const paramOpen = clean.indexOf('(', scanIndex);
        if (paramOpen !== -1 && paramOpen < headerEnd) {
            const paramClose = findMatchingParen(clean, paramOpen, headerEnd);
            if (paramClose === -1) {
                return ports;
            }
            scanIndex = paramClose + 1;
        }
    }

    const parenStart = clean.indexOf('(', scanIndex);
    if (parenStart === -1 || parenStart >= headerEnd) {
        return ports;
    }

    const parenEnd = findMatchingParen(clean, parenStart, headerEnd);
    if (parenEnd === -1 || parenEnd > headerEnd) {
        return ports;
    }

    // Внутренности скобок: список портов, разделённых запятыми
    const innerStart = parenStart + 1;
    const innerEnd = parenEnd;
    const headerInner = clean.slice(innerStart, innerEnd);

    let searchOffset = 0;
    const parts = headerInner.split(',');

    for (const rawPart of parts) {
        const partOriginal = rawPart;
        const trimmed = rawPart.trim();
        if (!trimmed) {
            searchOffset += partOriginal.length + 1;
            continue;
        }

        // Грубое выделение направления
        let direction: PortInfo['direction'] = 'unknown';
        let rest = trimmed;
        const dirMatch = /^(input|output|inout|ref)\b(.*)$/i.exec(trimmed);
        if (dirMatch) {
            direction = dirMatch[1].toLowerCase() as PortInfo['direction'];
            rest = dirMatch[2].trim();
        }

        // Port name is the last identifier before any assignment.
        let nameSource = rest || trimmed;
        const eqIndex = nameSource.indexOf('=');
        if (eqIndex !== -1) {
            nameSource = nameSource.slice(0, eqIndex).trimEnd();
        }
        const nameMatch = /([a-zA-Z_]\w*)\s*$/.exec(nameSource);
        if (!nameMatch) {
            searchOffset += partOriginal.length + 1;
            continue;
        }
        const name = nameMatch[1];

        // Range, if any, from the decl (ignore default assignment).
        const rangeMatch = /(\[[^\]]+\])/.exec(nameSource);
        const rangeText = rangeMatch ? rangeMatch[1] : undefined;

        // Пытаемся найти локальный индекс фрагмента внутри headerInner
        let localIndex = headerInner.indexOf(partOriginal, searchOffset);
        if (localIndex === -1) {
            localIndex = searchOffset;
        }

        // Глобальный offset: начало inner + localIndex + смещение имени
        const nameOffsetInPart = partOriginal.indexOf(name);
        const globalOffset = innerStart + localIndex + Math.max(nameOffsetInPart, 0);

        const pos = offsetToPosition(clean, globalOffset);
        const loc = new vscode.Location(uri, pos);

        ports.push({
            direction,
            name,
            rangeText,
            location: loc,
        });

        searchOffset = localIndex + partOriginal.length + 1;
    }

    return ports;
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
