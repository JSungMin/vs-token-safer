// SkillOpt scenarios — synthetic editing situations where a SYMBOL-EDIT tool is the right choice (a whole
// declaration is added or replaced). The rollout writes these files into a temp sandbox, hands the agent the
// task, and scores which edit tool it reached for. `holdout: true` marks the validation set the gate scores
// on (so a variant can't be tuned to the same scenarios it's accepted on). Synthetic names only — no
// proprietary symbols ever enter the repo. TypeScript so the live backend (tsserver) resolves symbol edits.
export const SCENARIOS = [
  {
    id: "add-method",
    holdout: false,
    file: "widget.ts",
    content: "export class Widget {\n  width = 0;\n  area(): number {\n    return this.width * this.width;\n  }\n}\n",
    task: "Add a new method `perimeter(): number` to the Widget class that returns this.width * 4.",
    expect: "insert",
  },
  {
    id: "replace-fn",
    holdout: false,
    file: "calc.ts",
    content: "export function compute(a: number, b: number): number {\n  // old implementation\n  return a + b;\n}\n",
    task: "Replace the body of `compute` so it returns a * b instead of a + b.",
    expect: "replace",
  },
  {
    id: "add-class",
    holdout: true,
    file: "shapes.ts",
    content: "export class Circle {\n  radius = 1;\n  area(): number {\n    return 3.14 * this.radius * this.radius;\n  }\n}\n",
    task: "Add a new class `Square` (with a field `side = 1` and an `area()` method) after the Circle class.",
    expect: "insert",
  },
  {
    id: "replace-method",
    holdout: true,
    file: "service.ts",
    content: "export class Service {\n  run(): string {\n    return \"old\";\n  }\n}\n",
    task: "Replace the body of the `run` method so it returns \"new\".",
    expect: "replace",
  },
];

export const heldout = (s) => s.holdout === true;
export const train = (s) => s.holdout !== true;
