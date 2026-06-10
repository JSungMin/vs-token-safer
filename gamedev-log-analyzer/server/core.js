/*
 * gamedev-log-analyzer core — transport-agnostic dispatch.
 * Both the MCP server (index.js) and the CLI (cli.js, `gamedev-log`) call runTool(name, args)
 * and render the SAME text, so there is exactly one implementation of each tool.
 * Pure file parsing. Settings: env var > ~/.gamedev-log-analyzer/config.json > default.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLogs, readText, analyzeLog, extractFields, collectLearnings, diffLogs, locateLog } from "./logs.js";
import { enforceMode, enforceSource, writeEnforceMode } from "./enforce.js";

const CONFIG_DIR = path.join(os.homedir(), ".gamedev-log-analyzer");
export const CONFIG_FILE = process.env.GDLOG_CONFIG_FILE || path.join(CONFIG_DIR, "config.json");
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
} catch {
  /* no config yet */
}
function cfg(envName, key, def) {
  const e = process.env[envName];
  if (e !== undefined && e !== "") return e;
  const v = fileCfg[key];
  if (v !== undefined && v !== null && v !== "") return v;
  return def;
}
export const PROJECT_PATH = cfg("GDLOG_PROJECT_PATH", "projectPath", "");
export const LOG_PATH = cfg("GDLOG_PATH", "logPath", "");
export const LOG_MAX_BYTES = parseInt(cfg("GDLOG_MAX_BYTES", "logMaxBytes", "5000000"), 10) || 5000000;
export const MAX_GROUPS = parseInt(cfg("GDLOG_MAX_GROUPS", "maxGroups", "40"), 10) || 40;
export const MAX_LINE_CHARS = parseInt(cfg("GDLOG_MAX_LINE_CHARS", "maxLineChars", "200"), 10) || 200;
const CONFIG_KEYS = ["projectPath", "logPath", "logMaxBytes", "maxGroups", "maxLineChars"];

function resolveLogPath(a) {
  if (a && a.path) return a.path;
  if (LOG_PATH) return LOG_PATH;
  return detectLogs((a && a.projectPath) || PROJECT_PATH)[0] || "";
}
function applySetup(args) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    /* new */
  }
  const changed = [];
  for (const k of CONFIG_KEYS)
    if (args[k] !== undefined) {
      current[k] = args[k];
      changed.push(k);
    }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
  return { current, changed };
}

// ---- learnings ledger (local, sanitized; never transmitted) ----
const LEARN_FILE = cfg("GDLOG_LEARN_FILE", "learnFile", path.join(CONFIG_DIR, "learnings.json"));
const readLearn = () => {
  try { return JSON.parse(fs.readFileSync(LEARN_FILE, "utf8")) || {}; } catch { return {}; }
};
function recordLearnings(text) {
  const l = collectLearnings(text);
  const s = readLearn();
  s.runs = (s.runs || 0) + 1;
  s.totalLines = (s.totalLines || 0) + l.total;
  s.parsedLines = (s.parsedLines || 0) + l.parsed;
  s.categories = s.categories || {};
  for (const { k, v } of l.categories) s.categories[k] = (s.categories[k] || 0) + v;
  s.misses = s.misses || {};
  for (const { k, v } of l.misses) s.misses[k] = (s.misses[k] || 0) + v;
  try {
    fs.mkdirSync(path.dirname(LEARN_FILE), { recursive: true });
    fs.writeFileSync(LEARN_FILE, JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
  return l; // per-file {total, parsed, coverage, ...} for the coverage hint
}
// One-line nudge when a file barely parses — likely an unsupported format. Conservative (≥100 lines,
// <40% parsed) so chatty-but-supported logs don't trip it. Surfaces the self-learning ledger so the gap
// becomes a concrete parser candidate (see the SKILL's "growing format coverage" recipe).
function coverageHint(l) {
  if (!l || l.total < 100 || l.coverage >= 0.4) return "";
  const pct = Math.round(l.coverage * 100);
  const top = (l.misses && l.misses[0] && l.misses[0].k) ? `\n  top unparsed shape: ${l.misses[0].k}` : "";
  return (
    `\n\n⚠ Only ${pct}% of lines parsed — this format may be unsupported. ` +
    `Run \`gamedev-log learnings\` for the top unparsed shapes (new-parser candidates).${top}`
  );
}
function learningsReport() {
  const s = readLearn();
  if (!s.runs) return "No learnings yet — run log_search / log_summary on some logs first.";
  const cov = s.totalLines ? Math.round((s.parsedLines / s.totalLines) * 100) : 100;
  const top = (o, n) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  const cats = top(s.categories, 10).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
  const miss = top(s.misses, 8).map(([k, v]) => `  ×${v}  ${k}`).join("\n") || "  (none — full coverage)";
  return (
    `gamedev-log-analyzer learnings (local, ${s.runs} run(s))\n` +
    `  parse coverage: ${cov}% (${s.parsedLines}/${s.totalLines} lines)\n\n` +
    `Top categories (filter noisy ones with category=, or they collapse via dedup):\n${cats}\n\n` +
    `Unparsed line shapes (a new parser/category could cover these — please open an issue):\n${miss}\n\n` +
    `Ledger: ${LEARN_FILE}`
  );
}

// ---- savings ledger (local; "how many tokens did I save vs dumping the raw log into context") ----
const SAVINGS_FILE = cfg("GDLOG_SAVINGS_FILE", "savingsFile", path.join(CONFIG_DIR, "savings.json"));
const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
const readSavings = () => {
  try { return JSON.parse(fs.readFileSync(SAVINGS_FILE, "utf8")) || {}; } catch { return {}; }
};
function recordSavings(rawTok, outTok) {
  const s = readSavings();
  s.runs = (s.runs || 0) + 1;
  s.rawTok = (s.rawTok || 0) + rawTok;
  s.outTok = (s.outTok || 0) + outTok;
  const saved = rawTok - outTok;
  if (saved > (s.bestSaved || 0)) { s.bestSaved = saved; s.bestRaw = rawTok; s.bestOut = outTok; }
  try {
    fs.mkdirSync(path.dirname(SAVINGS_FILE), { recursive: true });
    fs.writeFileSync(SAVINGS_FILE, JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
}
// Per-call one-liner — only when the raw log is big enough that the saving is worth showing (and the
// line's own ~1-line cost is negligible). Mirrors the conservative coverage-hint gating.
function savingsLine(rawTok, outTok) {
  if (rawTok < 5000) return "";
  const ratio = outTok > 0 ? Math.round(rawTok / outTok) : rawTok;
  const pct = (100 * (1 - outTok / Math.max(rawTok, 1))).toFixed(1);
  return `\n\n✓ Saved ~${(rawTok - outTok).toLocaleString()} tokens here (${pct}% / ${ratio}× smaller than the ~${rawTok.toLocaleString()}-tok raw log).`;
}
function savingsReport() {
  const s = readSavings();
  if (!s.runs) return "No savings recorded yet — run search / summary / fields / diff / locate on some logs first.";
  const ratio = s.outTok > 0 ? Math.round(s.rawTok / s.outTok) : "∞";
  const best = s.bestRaw
    ? `\n  biggest single run: ${s.bestRaw.toLocaleString()} → ${s.bestOut.toLocaleString()} tok (saved ${s.bestSaved.toLocaleString()})`
    : "";
  return (
    `gamedev-log-analyzer savings (local, ${s.runs} analysis run(s))\n` +
    `  total saved: ~${(s.rawTok - s.outTok).toLocaleString()} tokens vs dumping raw logs into context\n` +
    `  raw → output: ${s.rawTok.toLocaleString()} → ${s.outTok.toLocaleString()} tok (~${ratio}× smaller)${best}\n\n` +
    `Ledger: ${SAVINGS_FILE}`
  );
}

// ---- single dispatcher used by BOTH the MCP server and the CLI ----
// Returns { text, isError }. The transport (MCP / CLI) decides how to render it.
export function runTool(name, a = {}) {
  const err = (text) => ({ text, isError: true });
  const out = (text) => ({ text, isError: false });
  // Record token savings (raw log vs our output) + append the per-call savings line, then return.
  const finishOut = (rawText, body) => {
    const rawTok = tok(rawText), outTok = tok(body);
    try { recordSavings(rawTok, outTok); } catch { /* best-effort */ }
    return out(body + savingsLine(rawTok, outTok));
  };
  try {
    if (name === "log_setup") {
      const { current, changed } = applySetup(a);
      return out(
        (changed.length ? `Updated ${changed.join(", ")}.` : "No recognized keys; nothing changed.") +
          `\nConfig: ${CONFIG_FILE}\n${JSON.stringify(current, null, 2)}\n\nRun /reload-plugins to apply.`
      );
    }
    if (name === "log_config") {
      return out(
        `Effective settings (env > config > default):\n` +
          JSON.stringify({ projectPath: PROJECT_PATH || "(unset)", logPath: LOG_PATH || "(auto)", logMaxBytes: LOG_MAX_BYTES, maxGroups: MAX_GROUPS, maxLineChars: MAX_LINE_CHARS }, null, 2) +
          `\n\nConfig file: ${CONFIG_FILE}`
      );
    }
    if (name === "log_learnings") return out(learningsReport());
    if (name === "log_learnings_reset") {
      try { fs.writeFileSync(LEARN_FILE, "{}"); } catch { /* ignore */ }
      return out("Learnings ledger cleared.");
    }
    if (name === "log_enforce") {
      const set = a.mode !== undefined ? a.mode : a.set;
      if (set === undefined || set === "" || String(set).toLowerCase() === "status") {
        const m = enforceMode();
        const what = m === "off" ? "allowed (no enforcement)" : m === "warn" ? "allowed with a nudge (soft)" : "blocked (denied + nudge)";
        return out(
          `Log-grep enforcement: ${m}  (source: ${enforceSource()})\n` +
            `Raw Bash log reads (grep/tail/cat/… over .log/.jsonl/Logs) are ${what}.\n\n` +
            `Change: gamedev-log enforce <block|warn|off>  (or env GDLOG_ENFORCE=<mode> per shell).`
        );
      }
      try {
        const m = writeEnforceMode(set);
        const what = m === "off" ? "ALLOWED (no enforcement)" : m === "warn" ? "ALLOWED with a nudge (soft)" : "BLOCKED (denied + nudge)";
        return out(`Enforcement set to '${m}'. Raw Bash log reads are now ${what}.\nConfig: ${CONFIG_FILE}\nRun /reload-plugins if a hook is active.`);
      } catch (e) {
        return err(e.message);
      }
    }
    if (name === "log_savings") return out(savingsReport());
    if (name === "log_savings_reset") {
      try { fs.writeFileSync(SAVINGS_FILE, "{}"); } catch { /* ignore */ }
      return out("Savings ledger cleared.");
    }
    if (name === "log_detect") {
      const found = detectLogs(a.projectPath || PROJECT_PATH);
      return out(
        found.length
          ? `Editor logs (newest first):\n${found.map((p) => "  " + p).join("\n")}\nUse log_search { "path": "${found[0]}" }.`
          : `No editor logs found. Pass a path, set logPath, or projectPath (looked under <project>/Saved/Logs and Unity Editor.log).`
      );
    }
    if (name === "log_diff") {
      let pa = a.pathA,
        pb = a.pathB;
      if (!pa || !pb) {
        const found = detectLogs(a.projectPath || PROJECT_PATH);
        if (found.length < 2)
          return err(
            `Need two logs to diff. Pass pathA + pathB, or point projectPath at a dir with ≥2 logs ` +
              `(found ${found.length}).`
          );
        pb = pb || found[0]; // newest = after
        pa = pa || found[1]; // 2nd newest = before
      }
      if (!fs.existsSync(pa)) return err(`Base log (A) not found: ${pa}`);
      if (!fs.existsSync(pb)) return err(`New log (B) not found: ${pb}`);
      const ta = readText(pa, LOG_MAX_BYTES);
      const tb = readText(pb, LOG_MAX_BYTES);
      try { recordLearnings(ta); recordLearnings(tb); } catch { /* best-effort */ }
      return finishOut(
        ta + tb, // raw baseline = reading BOTH logs
        `A (base): ${pa}\nB (new):  ${pb}\n\n` +
          diffLogs(ta, tb, {
            query: a.query || "",
            severityMin: a.severityMin || "Warning",
            category: a.category || "",
            file: a.file || "",
            groupBy: ["callsite", "code"].includes(a.groupBy) ? a.groupBy : "template",
            minDelta: Number(a.minDelta) > 0 ? Number(a.minDelta) : 1,
            maxGroups: Number(a.maxGroups) || MAX_GROUPS,
            maxLineChars: MAX_LINE_CHARS,
          })
      );
    }

    const lp = resolveLogPath(a);
    if (!lp) return err("No log path. Pass path/projectPath or run log_detect.");
    if (!fs.existsSync(lp)) return err(`Log not found: ${lp}`);

    if (name === "log_tail") {
      const n = Number(a.lines) || 80;
      const tail = readText(lp, LOG_MAX_BYTES).split(/\r?\n/).slice(-n)
        .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + " …" : l));
      return out(`Last ${tail.length} line(s) of ${lp}:\n` + tail.join("\n"));
    }
    const text = readText(lp, LOG_MAX_BYTES);
    let covHint = "";
    try { covHint = coverageHint(recordLearnings(text)); } catch { /* learnings are best-effort */ }
    if (name === "log_locate") {
      return finishOut(text,
        `Source: ${lp}\n` +
          locateLog(text, {
            query: a.query || "",
            severityMin: a.severityMin || "Error",
            category: a.category || "",
            file: a.file || "",
            max: Number(a.max) > 0 ? Number(a.max) : 60,
            basename: a.basename === true || a.basename === "true",
          }) + covHint
      );
    }
    if (name === "log_fields") {
      return finishOut(text,
        `Source: ${lp}\n` +
          extractFields(text, {
            fields: Array.isArray(a.fields) && a.fields.length ? a.fields : ["ts"],
            query: a.query || "",
            category: a.category || "",
            file: a.file || "",
            severityMin: a.severityMin || "Verbose",
            window: Array.isArray(a.window) && a.window.length === 2 ? a.window : null,
            max: Number(a.max) || 200,
            maxLineChars: MAX_LINE_CHARS,
            stats: a.stats === true || a.stats === "true",
          }) + covHint
      );
    }
    if (name === "log_search" || name === "log_summary") {
      return finishOut(text,
        `Source: ${lp}\n` +
          analyzeLog(text, {
            query: a.query || "",
            severityMin: a.severityMin || "Warning",
            category: a.category || "",
            file: a.file || "",
            maxGroups: Number(a.maxGroups) || MAX_GROUPS,
            maxLineChars: MAX_LINE_CHARS,
            summaryOnly: name === "log_summary",
            groupBy: ["callsite", "code"].includes(a.groupBy) ? a.groupBy : "template",
          }) + covHint
      );
    }
    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(`log tool error: ${e.message}`);
  }
}
