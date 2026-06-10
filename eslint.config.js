import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules", "**/node_modules", "package-lock.json", "**/package-lock.json"],
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
