import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // gamedev-log-analyzer is a VENDORED static mirror of ../rider-mcp-enforcer (synced byte-for-byte by
    // scripts/sync-gamedev.mjs) — lint it in its source repo, not here, or fixes would break the mirror.
    // *.workflow.js run in the Workflow runtime (top-level await/return + injected globals agent/parallel/
    // phase/log/args), not as plain ESM — eslint can't parse them; they're exercised by running the workflow.
    // server/vendor/** holds third-party libraries bundled verbatim (e.g. Three.js, minified) so the
    // dashboard loads them same-origin — lint upstream, not here (linting a minified vendor build is noise).
    ignores: ["node_modules", "**/node_modules", "package-lock.json", "**/package-lock.json", "gamedev-log-analyzer/**", "**/*.workflow.js", "server/vendor/**"],
  },
  {
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "warn",
    },
  },
];
