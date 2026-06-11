/*
 * gamedev-log-analyzer — `discover`: scan local Claude Code transcript(s) and report, in aggregate, how
 * many raw log reads bypassed gamedev-log vs went through it. Adapted from RTK's `rtk discover`, scoped
 * to OUR domain (log reads only — never general command compression).
 *
 * SECURITY: reads transcripts, writes/transmits nothing, and emits ONLY aggregate counts + coarse token
 * estimates + labels. It NEVER prints a command, file path, or any log content (proprietary). Stdout only.
 * HONESTY: output tokens ≈ chars / CHARS_PER_TOKEN (a heuristic, not a tokenizer), coarse + labelled;
 * "reclaimable" is a range. Raw reads are described, not scolded — some are legitimate fallbacks.
 *
 * Reuses enforce.js's shouldBlockLogBash / isLogPath — the SAME detectors as the enforcement hook.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldBlockLogBash, isLogPath } from "./enforce.js";

const CHARS_PER_TOKEN = 4; // rough char→token heuristic; NOT a tokenizer
const PENDING_CAP = 5000;

export function contentLen(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (b && typeof b.text === "string" ? b.text.length : 0), 0);
  }
  return 0;
}

// A raw log read that bypassed gamedev-log: a Bash log dump (grep/tail/cat over a log), or an UNSLICED
// Read of a log file. A `gamedev-log ...` Bash call is NOT a bypass (it IS using the tool → captured).
export function classifyBypassGamedev(name, input) {
  if (name === "Bash") {
    const cmd = (input && input.command) || "";
    if (!cmd || /gamedev-log/.test(cmd)) return null;
    return shouldBlockLogBash(cmd) ? "bashlog" : null;
  }
  if (name === "Read") {
    const fp = (input && input.file_path) || "";
    const sliced = (input && input.offset != null) || (input && input.limit != null);
    if (sliced) return null; // a bounded slice is the legit escape, not a flood
    return isLogPath(fp) ? "readlog" : null;
  }
  return null;
}

// A log read that DID go through the tool: a gamedev-log CLI call, or an MCP log_* tool.
export function isCapturedGamedev(name, input) {
  if (typeof name === "string" && /gamedev-log-analyzer__log_/.test(name)) return true;
  if (name === "Bash" && /gamedev-log/.test(String((input && input.command) || ""))) return true;
  return false;
}

export function makeAnalyzer({ classifyBypass, isCaptured }) {
  const pending = new Map();
  const bypass = {};
  let capturedCount = 0;
  let recognized = 0;
  let lines = 0;
  const bump = (kind, outChars) => {
    const t = bypass[kind] || (bypass[kind] = { count: 0, outChars: 0 });
    t.count++;
    t.outChars += outChars;
  };
  function feed(rec) {
    lines++;
    const msg = rec && (rec.message || rec);
    const content = msg && msg.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "tool_use") {
        recognized++;
        if (isCaptured(c.name, c.input)) {
          capturedCount++;
          continue;
        }
        const kind = classifyBypass(c.name, c.input);
        if (kind && c.id) {
          if (pending.size >= PENDING_CAP) pending.clear();
          pending.set(c.id, kind);
        }
      } else if (c.type === "tool_result") {
        const kind = pending.get(c.tool_use_id);
        if (!kind) continue;
        pending.delete(c.tool_use_id);
        if (c.is_error) continue;
        bump(kind, contentLen(c.content));
      }
    }
  }
  return { feed, result: () => ({ bypass, capturedCount, recognized, lines }) };
}

export function analyzeJsonl(text) {
  const a = makeAnalyzer({ classifyBypass: classifyBypassGamedev, isCaptured: isCapturedGamedev });
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    a.feed(rec);
  }
  return a.result();
}

const kTok = (chars) => Math.round(chars / CHARS_PER_TOKEN / 1000);

export function formatGamedevReport(result, { scope = "this project" } = {}) {
  if (result.lines > 0 && result.recognized === 0) {
    return "gamedev-log discover: transcript format not recognized (Claude Code may have changed its log format) — skipping, no estimate produced.";
  }
  const bash = result.bypass.bashlog || { count: 0, outChars: 0 };
  const read = result.bypass.readlog || { count: 0, outChars: 0 };
  const bypassCount = bash.count + read.count;
  const captured = result.capturedCount;
  const total = bypassCount + captured;
  if (total === 0) {
    return `gamedev-log discover (${scope}): no in-domain log reads found in the transcript — nothing to report.`;
  }
  const outK = kTok(bash.outChars + read.outChars);
  const pct = Math.round((captured / total) * 100);
  const out = [];
  out.push(`gamedev-log discover — ${scope}  (estimated; output tokens ≈ chars/${CHARS_PER_TOKEN})`);
  out.push("──────────────────────────────────────────────");
  out.push(`Raw log reads that bypassed gamedev-log : ${bypassCount}  (~${outK}K tok of output reached context, measured)`);
  out.push(`    • Bash grep/tail/cat over a log : ${bash.count}`);
  out.push(`    • Read tool, full log file      : ${read.count}`);
  out.push(`Log reads routed through gamedev-log    : ${captured}   → coverage ${pct}%`);
  out.push("──────────────────────────────────────────────");
  if (outK >= 1) {
    out.push(`Est. reclaimable via gamedev-log: ~${Math.max(1, Math.round(outK * 0.9))}K–${outK}K tok (it parses + dedups + caps; estimate).`);
  }
  out.push("Tip: route logs through gamedev-log (summary / search / locate / fields / diff).");
  out.push("Note: some raw reads may have been intentional (a bounded peek or a format gamedev-log parses poorly).");
  return out.join("\n");
}

// CLI entry (sync): resolve transcripts for the cwd's project (or --all / --since / --session), tally,
// and return the report text. Reads files with readFileSync (fine for a manual, occasional command).
export function runDiscover(argv) {
  const PROJECTS = path.join(os.homedir(), ".claude", "projects");
  const has = (f) => argv.includes(f);
  const valOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : "";
  };
  const sinceDays = Number(valOf("--since")) || 0;
  const sessionArg = valOf("--session");
  const encodeCwd = (p) => p.replace(/[:\\/]/g, "-");

  let files = [];
  if (sessionArg) {
    files = [sessionArg];
  } else {
    const dirs = [];
    if (has("--all")) {
      try {
        for (const d of fs.readdirSync(PROJECTS)) {
          const sub = path.join(PROJECTS, d);
          try {
            if (fs.statSync(sub).isDirectory()) dirs.push(sub);
          } catch {
            /* skip */
          }
        }
      } catch {
        /* none */
      }
    } else {
      dirs.push(path.join(PROJECTS, encodeCwd(process.cwd())));
    }
    const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
    for (const dir of dirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!/\.jsonl$/i.test(f)) continue;
        const fp = path.join(dir, f);
        if (cutoff) {
          try {
            if (fs.statSync(fp).mtimeMs < cutoff) continue;
          } catch {
            continue;
          }
        }
        files.push(fp);
      }
    }
  }

  if (!files.length) {
    return `gamedev-log discover: no transcripts found under ${PROJECTS} for ${has("--all") ? "any project" : "this project"}${sinceDays ? ` in the last ${sinceDays} day(s)` : ""}.`;
  }
  const analyzer = makeAnalyzer({ classifyBypass: classifyBypassGamedev, isCaptured: isCapturedGamedev });
  for (const fp of files) {
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      analyzer.feed(rec);
    }
  }
  const scope = sessionArg ? "one session" : has("--all") ? "all projects" : "this project";
  return formatGamedevReport(analyzer.result(), { scope });
}
