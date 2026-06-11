import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // gamedev-log-analyzer is a VENDORED static mirror of ../rider-mcp-enforcer (synced byte-for-byte by
    // scripts/sync-gamedev.mjs) — lint it in its source repo, not here, or fixes would break the mirror.
    ignores: ["node_modules", "**/node_modules", "package-lock.json", "**/package-lock.json", "gamedev-log-analyzer/**"],
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
