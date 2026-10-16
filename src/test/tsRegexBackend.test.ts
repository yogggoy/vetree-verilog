// 2026/10/16 14:11:14 by liaoweipeng1
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TsRegexParserBackend } from '../parser/tsRegexBackend';

suite('Parameterized module instances', () => {
    let tempDir: string;

    setup(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vetree-parser-'));
    });

    teardown(async () => {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    const cases = [
        ['plain instance', 'child u_child (.data(signal));'],
        ['named parameters', 'child #(.WIDTH(8), .DEPTH(4)) u_child (.data(signal));'],
        ['positional parameters', 'child #(8, 4) u_child (.data(signal));'],
        ['nested parameter expressions', 'child #(.WIDTH(calc(2, (3 + 1)))) u_child (.data(signal));'],
        ['multiline parameters', 'child #(\n    .WIDTH(8),\n    .DEPTH(4)\n) u_child (\n    .data(signal)\n);'],
        ['compact parameter syntax', 'child#(.WIDTH(8))u_child(.data(signal));'],
        ['empty parameter list', 'child #() u_child (.data(signal));'],
        ['instance in generate block', 'generate\n    if (1) begin : g_child\n        child #(.WIDTH(8)) u_child (.data(signal));\n    end\nendgenerate'],
        ['attribute before instance', '(* keep = "true" *) child #(.WIDTH(8)) u_child (.data(signal));'],
    ];

    for (const [name, instance] of cases) {
        test(name, async () => {
            const uri = vscode.Uri.file(path.join(tempDir, 'top.v'));
            await vscode.workspace.fs.writeFile(uri, Buffer.from(`module top;\n${instance}\nendmodule\n`));
            const design = await new TsRegexParserBackend().parseFiles([uri]);
            const top = design.modulesByName.get('top')?.[0];
            assert.ok(top, 'top module should be indexed');
            assert.deepStrictEqual(top.instances.map(i => [i.moduleName, i.instanceName]), [['child', 'u_child']]);
            assert.deepStrictEqual(top.instances[0].bindings.map(b => [b.portName, b.expr]), [['data', 'signal']]);
        });
    }

    test('mixed hierarchy excludes comments and preserves port bindings', async () => {
        const uri = vscode.Uri.file(path.join(tempDir, 'hierarchy.v'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(`module top;
child u_plain (.data(plain_signal));
child #(.WIDTH(8)) u_parameterized (.data(parameter_signal));
// child #(.WIDTH(8)) u_line_comment (.data(ignored));
/* child #(.WIDTH(8)) u_block_comment (.data(ignored)); */
endmodule
module child #(parameter WIDTH = 1) (input [WIDTH-1:0] data);
endmodule
`));
        const design = await new TsRegexParserBackend().parseFiles([uri]);
        const top = design.modulesByName.get('top')?.[0];
        assert.ok(top, 'top module should be indexed');
        assert.deepStrictEqual(top.instances.map(i => [i.moduleName, i.instanceName]), [
            ['child', 'u_plain'],
            ['child', 'u_parameterized'],
        ]);
        assert.deepStrictEqual(top.instances.map(i => i.bindings.map(b => [b.portName, b.expr])), [
            [['data', 'plain_signal']],
            [['data', 'parameter_signal']],
        ]);
        assert.strictEqual(design.modulesByName.get('child')?.length, 1);
    });
});
