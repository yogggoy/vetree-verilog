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
    async parseFiles(
        files: vscode.Uri[],
        defines?: Set<string>,
        options?: { enablePreprocess?: boolean; logDebug?: (message: string) => void },
    ): Promise<ParsedDesign> {
        const modules: ParsedModule[] = [];
        const activeDefines = defines ?? new Set<string>();
        const enablePreprocess = options?.enablePreprocess ?? true;
        const logDebug = options?.logDebug;

        for (const uri of files) {
            try {
                const start = Date.now();
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                const fileDefines = new Set(activeDefines);
                const modsInFile = parseModulesAndInstancesInFile(
                    text,
                    uri,
                    fileDefines,
                    enablePreprocess,
                );
                if (logDebug) {
                    const rel = vscode.workspace.asRelativePath(uri, false);
                    logDebug(
                        `Parsed ${rel}: modules=${modsInFile.length}, time=${Date.now() - start}ms`,
                    );
                }
                modules.push(...modsInFile);
            } catch (err) {
                console.error(`Failed to read ${uri.fsPath}:`, err);
            }
        }

        const modulesByName = new Map<string, ParsedModule[]>();
        const modulesByFile = new Map<string, ParsedModule[]>();

        for (const m of modules) {
            // by name
            let arrByName = modulesByName.get(m.name);
            if (!arrByName) {
                arrByName = [];
                modulesByName.set(m.name, arrByName);
            }
            arrByName.push(m);

            // by file
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

// --------- helpers: regex parser ---------

function stripVerilogComments(source: string): string {
    // Preserve length and line positions by replacing comment/attribute chars with spaces.
    const out = source.split('');
    let inLineComment = false;
    let inBlockComment = false;
    let inAttribute = false;
    let inString = false;

    for (let i = 0; i < out.length; i++) {
        const ch = out[i];
        const next = i + 1 < out.length ? out[i + 1] : '';

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
            } else {
                out[i] = ' ';
            }
            continue;
        }

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                out[i] = ' ';
                out[i + 1] = ' ';
                i++;
                inBlockComment = false;
            } else if (ch !== '\n') {
                out[i] = ' ';
            }
            continue;
        }

        if (inAttribute) {
            if (ch === '*' && next === ')') {
                out[i] = ' ';
                out[i + 1] = ' ';
                i++;
                inAttribute = false;
            } else if (ch !== '\n') {
                out[i] = ' ';
            }
            continue;
        }

        if (inString) {
            if (ch === '\\\\' && next !== '') {
                i++;
                continue;
            }
            if (ch === '\"') {
                inString = false;
            }
            continue;
        }

        if (ch === '\"') {
            inString = true;
            continue;
        }

        if (ch === '/' && next === '/') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i++;
            inLineComment = true;
            continue;
        }

        if (ch === '/' && next === '*') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i++;
            inBlockComment = true;
            continue;
        }

        if (ch === '(' && next === '*') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i++;
            inAttribute = true;
            continue;
        }
    }

    return out.join('');
}

function preprocessVerilog(clean: string, defines: Set<string>): string {
    const out = clean.split('');
    const stack: Array<{ parentActive: boolean; thisActive: boolean; branchTaken: boolean }> = [];

    const isActive = () => (stack.length === 0 ? true : stack[stack.length - 1].thisActive);

    const blankLine = (start: number, end: number) => {
        for (let i = start; i < end; i++) {
            out[i] = ' ';
        }
    };

    let index = 0;
    while (index < clean.length) {
        const lineStart = index;
        let lineEnd = clean.indexOf('\n', index);
        if (lineEnd === -1) {
            lineEnd = clean.length;
        }

        const lineText = clean.slice(lineStart, lineEnd);
        const directiveMatch = /^\s*`(\w+)(.*)$/.exec(lineText);

        if (directiveMatch) {
            const directive = directiveMatch[1];
            const rest = directiveMatch[2].trim();

            if (directive === 'define') {
                if (isActive()) {
                    const nameMatch = /^([a-zA-Z_]\w*)/.exec(rest);
                    if (nameMatch) {
                        defines.add(nameMatch[1]);
                    }
                }
            } else if (directive === 'undef') {
                if (isActive()) {
                    const nameMatch = /^([a-zA-Z_]\w*)/.exec(rest);
                    if (nameMatch) {
                        defines.delete(nameMatch[1]);
                    }
                }
            } else if (directive === 'ifdef' || directive === 'ifndef') {
                const nameMatch = /^([a-zA-Z_]\w*)/.exec(rest);
                const isDefined = nameMatch ? defines.has(nameMatch[1]) : false;
                const condition = directive === 'ifdef' ? isDefined : !isDefined;
                const parentActive = isActive();
                const thisActive = parentActive && condition;
                stack.push({ parentActive, thisActive, branchTaken: condition });
            } else if (directive === 'elsif') {
                const state = stack[stack.length - 1];
                if (state) {
                    if (!state.parentActive || state.branchTaken) {
                        state.thisActive = false;
                    } else {
                        const nameMatch = /^([a-zA-Z_]\w*)/.exec(rest);
                        const condition = nameMatch ? defines.has(nameMatch[1]) : false;
                        state.thisActive = condition;
                        state.branchTaken = condition;
                    }
                }
            } else if (directive === 'else') {
                const state = stack[stack.length - 1];
                if (state) {
                    if (!state.parentActive || state.branchTaken) {
                        state.thisActive = false;
                    } else {
                        state.thisActive = true;
                        state.branchTaken = true;
                    }
                }
            } else if (directive === 'endif') {
                if (stack.length > 0) {
                    stack.pop();
                }
            }

            blankLine(lineStart, lineEnd);
        } else if (!isActive()) {
            blankLine(lineStart, lineEnd);
        }

        index = lineEnd + 1;
    }

    return out.join('');
}

function parseModulesAndInstancesInFile(
    source: string,
    uri: vscode.Uri,
    defines: Set<string>,
    enablePreprocess: boolean,
): ParsedModule[] {
    const modules: ParsedModule[] = [];
    let clean = stripVerilogComments(source);
    if (enablePreprocess) {
        clean = preprocessVerilog(clean, defines);
    }

    // Important: only space/tab, no '\n'
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

        // Ports: parse module header
        const ports = parseModulePortsFromHeader(clean, uri, cur.start, cur.bodyStart);

        // Instances: search inside module body
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

    // Also without '\n' at line start
    const instRegex =
        /^[ \t]*(?:[a-zA-Z_]\w*\s*:\s*)?([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\s*(?:#\s*\([^;]*\))?\s*\(/gm;

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

    // Inside parens: list of ports separated by commas
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

        // Rough direction parsing
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

        // Try to find the local index of the fragment inside headerInner
        let localIndex = headerInner.indexOf(partOriginal, searchOffset);
        if (localIndex === -1) {
            localIndex = searchOffset;
        }

        // Global offset: inner start + localIndex + name offset
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

// simple offset -> position (by lines)
function offsetToPosition(text: string, offset: number): vscode.Position {
    const lineStarts = getLineStarts(text);
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const start = lineStarts[mid];
        if (start === offset) {
            return new vscode.Position(mid, 0);
        }
        if (start < offset) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const line = Math.max(0, low - 1);
    const character = offset - lineStarts[line];
    return new vscode.Position(line, character);
}

let cachedText: string | null = null;
let cachedLineStarts: number[] = [];

function getLineStarts(text: string): number[] {
    if (text === cachedText) {
        return cachedLineStarts;
    }

    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) {
            starts.push(i + 1);
        }
    }

    cachedText = text;
    cachedLineStarts = starts;
    return starts;
}
