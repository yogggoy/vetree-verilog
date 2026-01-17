# vetree-verilog

VS Code extension for exploring Verilog/SystemVerilog projects. It builds a project tree, a module hierarchy, and provides navigation to module definitions, instances, and ports.

## Features

- Project tree view of folders, files, and modules.
- Hierarchy view with module instances and navigation to instantiation sites.
- Go to definition (F12) for module names.
- QuickPick list of module ports with jump to declaration.
- Auto refresh on file changes.
- Optional preprocessing support for `define/ifdef/ifndef/elsif/else/endif` using a `.f` file.

## Views

You will see a "Verilog" activity bar container with:

- Verilog Project Tree
- Verilog Hierarchy

## Commands

- `vetree: Refresh Tree`
- `vetree: Refresh Hierarchy`
- `vetree: Show Module Ports`
- `vetree: Go to Module Definition`
- `vetree: Reveal in Hierarchy`
- `vetree: Reveal in Project Tree`

## Settings

- `vetree-verilog.definesFile`: Path to a `.f` file that provides `+define+` flags.
- `vetree-verilog.maxFileSizeMB`: Skip files larger than this size (MB). Set to `0` to disable.
- `vetree-verilog.quickScan`: Skip preprocessing for faster scans.
- `vetree-verilog.maxHierarchyDepth`: Maximum depth for hierarchy traversal.
- `vetree-verilog.debugLogging`: Enable verbose logging for troubleshooting.
- `vetree-verilog.skipHierarchyBuild`: Skip hierarchy building (debugging).
- `vetree-verilog.hierarchyResolve`: How to resolve duplicate module names (`all` or `first`).
- `vetree-verilog.hierarchyTopModule`: Restrict hierarchy roots to a specific top module name.

## Notes

- If a project contains many duplicate module names (for example vendor tags), use `hierarchyResolve: "first"` or set `hierarchyTopModule` to keep the hierarchy stable.
- Preprocessing is intentionally minimal and does not yet handle `include` files.

## Example `.f` file

```text
// Defines
+define+SIMV
+define+SIMD
+define+N64

// Include dirs (currently ignored by the parser)
+incdir+uart

// Sources
chip.sv
cpu.sv
decode.sv
commit.sv
```

## Troubleshooting

- Enable `vetree-verilog.debugLogging` to see scan timing, memory usage, and hierarchy stats.
- If the hierarchy build stalls, set `vetree-verilog.skipHierarchyBuild` to confirm the issue is isolated to hierarchy construction.

## Release Notes

### 0.0.1

Initial preview with project tree, hierarchy, definition navigation, and ports listing.
