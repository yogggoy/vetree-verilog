# vetree-verilog

Lightweight VS Code extension for quick exploration of Verilog/SystemVerilog projects. It builds a project tree and hierarchy, lets you navigate modules/instances/ports, and helps you inspect direct connections between instances. It is designed to be fast to set up and does not require external tools, but the parser is a native TypeScript implementation, so results are best-effort and can be incomplete on complex codebases.

## What problem it solves

When you open a new RTL repository, it is often hard to answer basic questions quickly:

- What modules exist and where are they defined?
- What is the hierarchy starting from a top module?
- Where is this module instantiated?
- What are the ports and how are two instances directly connected?

This extension provides a quick, visual map of the project and navigation helpers without requiring a simulator, linter, or external indexer.

## Features

- Project tree view of folders, files, and modules.
- Module ports shown under each module node.
- Hierarchy view with module instances and navigation to instantiation sites.
- Go to definition (F12) for module names.
- QuickPick list of module ports with jump to declaration.
- Auto refresh on file changes.
- Optional preprocessing support for `define/ifdef/ifndef/elsif/else/endif`.
- Basic `include` handling using `+incdir+` from filelists.
- Direct connection lookup between two instances (named port bindings).

## Views

You will see a "Verilog" activity bar container with:

- Verilog Project Tree
- Verilog Hierarchy
- Direct Connections

## Commands

- `vetree: Refresh Tree`
- `vetree: Refresh Hierarchy`
- `vetree: Show Module Ports`
- `vetree: Go to Module Definition`
- `vetree: Reveal in Hierarchy`
- `vetree: Reveal in Project Tree`
- `vetree: Set as Top Module`
- `vetree: Clear Top Module`
- `vetree: Select as Endpoint A`
- `vetree: Select as Endpoint B`
- `vetree: Show Direct Connections`

## Settings

- `vetree-verilog.definesFile`: Path to a `.f` file that defines files to scan and flags (`+define+`, `+incdir+`, `-I`, `-f`, `+top+`).
- `vetree-verilog.maxFileSizeMB`: Skip files larger than this size (MB). Set to `0` to disable.
- `vetree-verilog.quickScan`: Skip preprocessing for faster scans.
- `vetree-verilog.maxHierarchyDepth`: Maximum depth for hierarchy traversal.
- `vetree-verilog.debugLogging`: Enable verbose logging for troubleshooting.
- `vetree-verilog.skipHierarchyBuild`: Skip hierarchy building (debugging).
- `vetree-verilog.hierarchyResolve`: How to resolve duplicate module names (`all` or `first`).
- `vetree-verilog.hierarchyTopModule`: Restrict hierarchy roots to a specific top module name.

## How to use

1) Open a workspace with Verilog/SystemVerilog files.
2) Use the **Verilog Project Tree** and **Verilog Hierarchy** views to browse the structure.
3) Right-click a module to set it as top module if the hierarchy is too large.
4) Use **Show Module Ports** to inspect ports directly under a module node.
5) To find direct connections:
   - Right-click two instance nodes in the hierarchy and select **Endpoint A** / **Endpoint B**.
   - The **Direct Connections** view will show the pairs.

If a project uses a filelist, set `vetree-verilog.definesFile` so the extension scans only those files and honors flags from the filelist (including nested `-f` lists).

## Notes

- If a project contains many duplicate module names (for example vendor tags), use `hierarchyResolve: "first"` or set `hierarchyTopModule` to keep the hierarchy stable.
- You can set the top module from the tree context menu and clear it with `vetree: Clear Top Module`.
- `include` is supported as a lightweight define pass; included files are not merged into the current file.
- When `definesFile` is set and resolves to files, only those files are scanned.
- Direct connections are based on named port bindings within the same parent module.
- Direct connection results appear in the "Direct Connections" view.

## Limitations

- The parser is a lightweight TypeScript implementation, not a full Verilog compiler.
- Complex macros, generate blocks, or heavy conditional compilation can reduce accuracy.
- 
## Example `.f` file

```text
// Defines
+define+SIMV
+define+SIMD
+define+N64

// Top module (optional)
+top+chip

// Include dirs (used for `include` define scanning)
+incdir+uart

// Sources
chip.sv
cpu.sv
decode.sv
commit.sv
rtl/**/*.sv
-f common.f
```

## Troubleshooting

- Enable `vetree-verilog.debugLogging` to see scan timing, memory usage, and hierarchy stats.
- If the hierarchy build stalls, set `vetree-verilog.skipHierarchyBuild` to confirm the issue is isolated to hierarchy construction.

## Release Notes

### 0.0.1

Initial preview with project tree, hierarchy, definition navigation, and ports listing.
