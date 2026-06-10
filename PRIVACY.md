# Privacy Policy

_Last updated: 2026-06-10_

This policy covers the **vs-token-safer** Claude Code plugin (and its npm package of the same name).

## Summary

**This plugin collects no personal data and transmits no user data to the author or any third party.**
All processing happens locally on your machine.

## What the plugin accesses

- **vs-token-safer** spawns an **official language server on your own machine** — clangd (LLVM) for
  C/C++, a Roslyn-based LSP (default `csharp-ls`) for C#/.NET — and asks it for symbols, references,
  and definitions in the project you point it at. The language server reads your local source; the
  plugin only translates LSP results into a token-capped `file:line` list. **No source code, query,
  or result is sent anywhere off your machine.**

## What is stored, and where (all local)

- Configuration file: `~/.vs-token-safer/config.json`.
- A token-savings counter: `~/.vs-token-safer/savings.json` (aggregate token counts only — no code,
  no symbol names, no identifiers).
- The MCP server dependencies (`node_modules`) installed into the plugin's data directory.

These files stay on your machine. Uninstalling the plugin removes its data directory.

## Network activity

The only outbound network connection is:

1. **First-run dependency install** — `npm install` fetches the open-source `@modelcontextprotocol/sdk`
   package from the public npm registry. This is standard package installation; no user data is sent.

The plugin makes **no other network connections**. The language servers run locally over stdio.
There is **no telemetry, no analytics, no tracking, and no transmission** of your code, symbols,
queries, or any personal data.

## Third parties

None. Your data is not shared, sold, or sent to the author or any third-party service. The bundled
engines (clangd, the Roslyn LSP) are third-party open-source tools that run locally; vs-token-safer
does not send them anything beyond your local search request.

## Open source

The plugin is MIT-licensed and fully auditable in this repository. You can verify every network call
and file write in the source.

## Contact

Questions or concerns: open an issue at <https://github.com/JSungMin/vs-token-safer/issues>.

## Changes

Updates to this policy will be committed to this file; the "Last updated" date reflects the latest
revision.
