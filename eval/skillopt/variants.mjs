// SkillOpt variants — the TRAINABLE ARTIFACT. Each variant is a piece of guidance prepended to the rollout
// agent's task, standing in for what the skill/warn text would tell it. `baseline` is the live behavior
// (no extra guidance — only whatever the installed hook/skill already injects); the rest are candidate
// rewordings the gate scores against the baseline. The optimizer (a human, or a reflection sub-agent reading
// the scored rollouts) proposes new entries here; the harness measures whether they raise adoption.
export const VARIANTS = [
  {
    id: "baseline",
    guidance: "",
  },
  {
    id: "explicit-ready-call",
    guidance:
      "Tooling note: when you ADD or REPLACE a whole declaration (a function, method, or class), use the " +
      "vs-search symbol-edit tools — insert_symbol / replace_symbol_body with " +
      "symbol=<name> — instead of reading the file and using the built-in Edit. They edit by name and skip " +
      "reading the file into context.",
  },
  {
    id: "cost-framed",
    guidance:
      "Tooling note: reading a whole file just to edit one declaration wastes tokens. For a whole-declaration " +
      "add or replace, call insert_symbol or replace_symbol_body (symbol=<name>, apply=true) — no file " +
      "read needed; the language-server outline supplies the span.",
  },
];

export const byId = (id) => VARIANTS.find((v) => v.id === id);
