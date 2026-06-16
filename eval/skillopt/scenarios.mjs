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

// Harder scenarios — bigger, multi-declaration files so Read is non-trivial and a hurried agent might
// default to Read+Edit. Used to probe whether warn WORDING moves adoption when the choice is less obvious.
// FINDING (16 rollouts: this set + the toy set, baseline + 2 variants): adoption stayed 100% on baseline
// too — a focused rollout agent always reaches for symbol-edit once the tools exist, regardless of wording.
// So wording optimization has NO headroom in the clean-rollout regime; see README "No headroom" note.
export const HARD = [
  {
    id: "add-method-big", holdout: false, file: "store.ts",
    content: "export interface Item { id: number; name: string; }\n\nexport class Store {\n  private items: Item[] = [];\n  add(it: Item): void { this.items.push(it); }\n  remove(id: number): void { this.items = this.items.filter(x => x.id !== id); }\n  find(id: number): Item | undefined { return this.items.find(x => x.id === id); }\n  count(): number { return this.items.length; }\n}\n\nexport class Logger {\n  private lines: string[] = [];\n  log(s: string): void { this.lines.push(s); }\n  dump(): string { return this.lines.join(\"\\n\"); }\n}\n",
    task: "Add a new method `clear(): void` to the Store class that empties its items array.", expect: "insert",
  },
  {
    id: "replace-body-big", holdout: false, file: "util.ts",
    content: "export function slugify(s: string): string {\n  return s.toLowerCase().replace(/\\s+/g, \"-\");\n}\n\nexport function truncate(s: string, n: number): string {\n  if (s.length <= n) return s;\n  return s.slice(0, n) + \"...\";\n}\n\nexport function parseRange(s: string): [number, number] {\n  const parts = s.split(\"-\");\n  return [Number(parts[0]), Number(parts[1])];\n}\n",
    task: "Replace the body of `parseRange` so it trims whitespace from each part before converting to a number.", expect: "replace",
  },
  {
    id: "add-fn-after", holdout: true, file: "math.ts",
    content: "export function lerp(a: number, b: number, t: number): number {\n  return a + (b - a) * t;\n}\n\nexport function sign(n: number): number {\n  return n < 0 ? -1 : n > 0 ? 1 : 0;\n}\n\nexport function avg(xs: number[]): number {\n  return xs.reduce((s, x) => s + x, 0) / xs.length;\n}\n",
    task: "Add a new exported function `clamp(n: number, min: number, max: number): number` after the `lerp` function.", expect: "insert",
  },
  {
    id: "replace-method-class", holdout: true, file: "cache.ts",
    content: "export class Cache<V> {\n  private map = new Map<string, V>();\n  set(k: string, v: V): void { this.map.set(k, v); }\n  get(k: string): V | undefined { return this.map.get(k); }\n  has(k: string): boolean { return this.map.has(k); }\n  clear(): void { this.map.clear(); }\n}\n",
    task: "Replace the body of the `get` method in the Cache class so it returns undefined and logs a miss via console.warn when the key is absent.", expect: "replace",
  },
];

export const heldout = (s) => s.holdout === true;
export const train = (s) => s.holdout !== true;
