# Security Policy

## Supported versions

Security fixes are applied to the **latest release** only. Older versions are not backported.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Open a **[private security advisory](https://github.com/JSungMin/vs-token-safer/security/advisories/new)**
on this repository. Describe the issue, steps to reproduce, and potential impact.

**Expected response:** best-effort; this is a hobby project maintained by one person. Expect an
acknowledgement within a few days and a fix or assessment within a reasonable timeframe, but no
formal SLA applies.

## Scope

- **vs-token-safer** spawns an official language server (clangd / a Roslyn LSP) on your local machine
  over stdio and returns a token-capped `file:line` list. It does not open outbound connections to the
  internet and does not exfiltrate source code, symbols, or query results.

Neither the CLI nor the MCP server collects or transmits user data. See [PRIVACY.md](PRIVACY.md) for
the full data-handling statement.

## Out of scope

- Vulnerabilities in the underlying language servers (clangd, csharp-ls, Microsoft.CodeAnalysis.LanguageServer).
- Issues that require physical access to the machine or compromising the OS user account.
- Dependency vulnerabilities with no plausible exploitation path through this plugin.
