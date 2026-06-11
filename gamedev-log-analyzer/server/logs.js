// Editor-log analysis for rider-mcp-enforcer.
// Detect UE/Unity/generic editor logs, parse {severity, category, location, message},
// template-dedup repeated spam, and return search/filter-centric, token-capped output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SEV_RANK = { Fatal: 5, Error: 4, Warning: 3, Display: 2, Verbose: 1 };
const rank = (s) => SEV_RANK[s] ?? 2;

// ---- detection ----
export function detectLogs(projectPath) {
  const out = [];
  const add = (p) => {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p.replace(/\\/g, "/"));
    } catch {
      /* ignore */
    }
  };
  if (projectPath) {
    // UE: <root>/Saved/Logs, and commonly <root>/<GameDir>/Saved/Logs (the .uproject dir).
    const roots = [projectPath];
    try {
      for (const d of fs.readdirSync(projectPath, { withFileTypes: true }))
        if (d.isDirectory() && !d.name.startsWith(".")) roots.push(path.join(projectPath, d.name));
    } catch {
      /* unreadable root */
    }
    for (const r of roots) {
      const logdir = path.join(r, "Saved", "Logs");
      try {
        for (const f of fs.readdirSync(logdir))
          if (f.toLowerCase().endsWith(".log")) add(path.join(logdir, f));
      } catch {
        /* no Saved/Logs here */
      }
    }
  }
  if (process.env.LOCALAPPDATA)
    add(path.join(process.env.LOCALAPPDATA, "Unity", "Editor", "Editor.log"));
  add(path.join(os.homedir(), "Library", "Logs", "Unity", "Editor.log"));
  // Newest first so the active editor log is the default.
  return [...new Set(out)].sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

// ---- read (tail bytes for huge logs) ----
export function readText(file, maxBytes) {
  const size = fs.statSync(file).size;
  if (!maxBytes || size <= maxBytes) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    let s = buf.toString("utf8");
    // We started reading mid-file, so the first line is almost certainly a fragment (and may begin with
    // a split multi-byte char). Drop everything up to and including the first newline so parsing starts
    // on a clean line boundary — otherwise that fragment pollutes the learnings ledger / mis-parses.
    const nl = s.indexOf("\n");
    if (nl !== -1) s = s.slice(nl + 1);
    return "…(older lines truncated)…\n" + s;
  } finally {
    fs.closeSync(fd);
  }
}

// ---- parsing ----
function extractLoc(s) {
  const m =
    s.match(/\(at\s+([\w./\\:-]+):(\d+)\)/i) ||
    s.match(/Filename:\s*([\w./\\:-]+)\s+Line:\s*(\d+)/i) ||
    s.match(/([\w./\\:-]+\.[A-Za-z]{1,5})[(:](\d+)/);
  return m ? `${m[1].replace(/\\/g, "/")}:${m[2]}` : "";
}

// Map a JSON log's level/severity field (string or numeric syslog 0-7) to our severity scale;
// fall back to message keywords when there is no level field.
function jsonSeverity(lvl, msg) {
  const s = String(lvl == null ? "" : lvl).toLowerCase();
  if (/fatal|crit|emerg|panic/.test(s)) return "Fatal";
  if (/error|err|severe/.test(s)) return "Error";
  if (/warn/.test(s)) return "Warning";
  if (/debug|trace|verbose/.test(s)) return "Verbose";
  if (/info|notice|log|display/.test(s)) return "Display";
  if (s !== "" && /^\d+$/.test(s)) { const n = parseInt(s, 10); return n <= 3 ? "Error" : n === 4 ? "Warning" : "Display"; }
  if (/(fatal|exception|assert(ion)?\s+failed)/i.test(msg)) return "Error";
  if (/(^|\W)(error|fail(ed|ure)?)(\W|$)/i.test(msg)) return "Error";
  if (/(^|\W)(warning|warn)(\W|$)/i.test(msg)) return "Warning";
  return "Display";
}

export function parseLine(line) {
  if (!line || !line.trim()) return null;

  // JSON line (JSONL): structured logs — UE structured trace (`{"ts":..,"verbosity":..,"stage":..,
  // "message":..}`), bunyan/pino (Node), Serilog (.NET), or generic. Live-verified against a real UE
  // AIMovementDebug .jsonl. Common key aliases are tried for level / category / message / location.
  {
    const t = line.trim();
    if (t.charCodeAt(0) === 123 /* { */ && t.charCodeAt(t.length - 1) === 125 /* } */) {
      let o = null;
      try { o = JSON.parse(t); } catch { /* not JSON; fall through to text parsers */ }
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const pick = (...ks) => { for (const k of ks) if (o[k] != null && o[k] !== "") return String(o[k]); return ""; };
        const msg = pick("message", "msg", "text", "event", "Message", "RenderedMessage", "MessageTemplate");
        const cat = pick("category", "logger", "channel", "source", "stage", "tag", "name", "module", "Category", "SourceContext") || "Json";
        const lvl = pick("level", "severity", "verbosity", "lvl", "loglevel", "Level", "@l");
        const loc = o.file && (o.line != null) ? `${String(o.file).replace(/\\/g, "/")}:${o.line}` : extractLoc(msg);
        return { severity: jsonSeverity(lvl, msg), category: cat, location: loc, message: (msg || t).trim() };
      }
    }
  }

  // Build/compile diagnostic: path(line[,col]): error|warning CODE: message  (MSVC/UBT/C#)
  // The CODE (C4996, C2065, CS1002 …) is captured so noisy builds can roll up by code (groupBy=code).
  let m = line.match(/^\s*(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(error|warning)(?:\s+([A-Za-z]{1,5}\d+))?[^:]*:\s*(.*)$/i);
  if (m) {
    return {
      severity: m[3].toLowerCase() === "error" ? "Error" : "Warning",
      category: "Build",
      location: `${m[1].trim().replace(/\\/g, "/")}:${m[2]}`,
      message: m[5].trim(),
      code: m[4] ? m[4].toUpperCase() : "",
    };
  }

  // UE runtime: [time][frame]Category: [Verbosity: ] message  (frame optional)
  m =
    line.match(
      /^\[[\d.\-:\s]+\]\[\s*\d+\s*\]([A-Za-z][\w]+):\s*(?:(Display|Warning|Error|Fatal|Verbose|VeryVerbose|Log):\s*)?(.*)$/
    ) ||
    line.match(
      /^\[[\d.\-:\s]+\]([A-Za-z][\w]+):\s*(?:(Display|Warning|Error|Fatal|Verbose|VeryVerbose|Log):\s*)?(.*)$/
    );
  if (m) {
    const sev = m[2] && m[2] !== "Log" ? m[2] : "Display";
    return { severity: sev, category: m[1], location: extractLoc(m[3] || ""), message: (m[3] || "").trim() };
  }

  // Linker / toolchain diagnostic without a line number: "file : error LNK2019: msg" (MSVC/UBT/MSBuild).
  // Live-verified shape for MSVC link errors; line-less, so no location.
  m = line.match(/^\s*(.+?)\s*:\s*(error|warning|fatal error)\s+([A-Z]{1,4}\d+)\s*:\s*(.*)$/i);
  if (m) {
    return {
      severity: /warning/i.test(m[2]) ? "Warning" : "Error",
      category: "Build",
      location: "",
      message: `${m[3]}: ${m[4]}`.trim(),
      code: m[3].toUpperCase(),
    };
  }

  // Godot (BEST-EFFORT — format from Godot's public docs/console output, NOT live-verified against real
  // Godot project logs; the learnings ledger surfaces real-world misses). Distinctive headers, plus the
  // standalone `at: func (file:line)` stack line Godot prints separately (so a header and its location
  // parse as two entries). Bare ERROR:/WARNING: fall through to the generic branch below.
  m = line.match(/^\s*(SCRIPT|SHADER|USER)\s+(ERROR|WARNING):\s*(.*)$/);
  if (m) {
    return {
      severity: m[2] === "ERROR" ? "Error" : "Warning",
      category: "Godot",
      location: extractLoc(m[3] || ""),
      message: `${m[1]} ${m[2]}: ${(m[3] || "").trim()}`,
    };
  }
  m = line.match(/^\s*at:\s+\S/);
  if (m) {
    const loc = extractLoc(line);
    if (loc) return { severity: "Display", category: "Godot", location: loc, message: line.trim() };
  }

  // Python logging default format `asctime - name - LEVELNAME - message`. BEST-EFFORT (common format,
  // not live-verified against a specific app's real logs).
  m = line.match(/^\d{4}-\d\d-\d\d[ T][\d:.,]+\s+-\s+([\w.]+)\s+-\s+(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+-\s+(.*)$/);
  if (m) {
    return { severity: jsonSeverity(m[2], m[3]), category: m[1], location: extractLoc(m[3]), message: m[3].trim() };
  }
  // Bracketed level: `[ERROR] msg`, `[WARN] msg` (many engines/CLIs). BEST-EFFORT.
  m = line.match(/^\s*\[(TRACE|DEBUG|VERBOSE|INFO|DISPLAY|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\]\s*(.*)$/i);
  if (m) {
    return { severity: jsonSeverity(m[1], m[2]), category: "Log", location: extractLoc(m[2]), message: m[2].trim() };
  }

  // Unity / generic: detect a severity keyword + optional location.
  // "exception"/"fatal" matched as substrings so glued names (NullReferenceException) count.
  let sev = null;
  if (/(fatal|exception|assert(ion)?\s+failed)/i.test(line)) sev = "Error";
  else if (/(^|\W)(error|fail(ed|ure)?)(\W|$)/i.test(line)) sev = "Error";
  else if (/(^|\W)(warning|warn)(\W|$)/i.test(line)) sev = "Warning";
  if (sev) return { severity: sev, category: "Log", location: extractLoc(line), message: line.trim() };

  return null; // uninteresting info line
}

// Normalize variable parts so repeated spam collapses into one template.
// Numbers are matched WITHOUT a word boundary so instance ids (e.g. "Actor_12",
// "Pawn_07") collapse together with coordinates and counters.
function templateOf(msg) {
  return msg
    .replace(/0x[0-9a-fA-F]+/g, "<addr>")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<guid>")
    .replace(/[A-Za-z]:[\\/][^\s'"]+/g, "<path>")
    .replace(/-?\d+(?:\.\d+)?/g, "<n>")
    .trim();
}

// ---- generic field extraction (columnar "decisive scalars only") ----
// For structured trace logs with `Key=value`, `Key=(x, y, z)`, `Key=(P.. Y.. R..)` fields.
// Pulls just the requested fields into a compact table instead of dumping raw lines —
// the single biggest token win on dense trace logs (often ~99% vs a raw window dump).
function rawField(line, key) {
  const m = line.match(new RegExp(`(?:^|[\\s\\[(,])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(\\([^)]*\\)|[^\\s,)]+)`));
  return m ? m[1] : null;
}
function vecComp(val, idx) {
  if (!val) return null;
  const parts = val.replace(/[()]/g, "").split(",").map((s) => s.trim());
  return parts[idx] ?? null;
}
function rotComp(val, which) {
  if (!val) return null;
  const m = val.match(new RegExp(`${which}(-?\\d+(?:\\.\\d+)?)`));
  return m ? m[1] : null;
}
// Resolve one field spec against a line → string value (or "").
function getField(line, spec) {
  if (spec === "ts") return rawField(line, "ts") ?? rawField(line, "Ts") ?? rawField(line, "time") ?? "";
  let m;
  if ((m = spec.match(/^(.+)\.(x|y|z)$/))) {
    return vecComp(rawField(line, m[1]), { x: 0, y: 1, z: 2 }[m[2]]) ?? "";
  }
  if ((m = spec.match(/^(.+)\.(Y|P|R)$/))) return rotComp(rawField(line, m[1]), m[2]) ?? "";
  return rawField(line, spec) ?? "";
}
const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

// Flatten a JSON log line into the `Key=value` text the field extractor understands: top-level scalars
// become `k=v`, then the message string is appended (it carries its own `Key=value` / `Key=(x,y,z)`).
// Non-JSON lines pass through unchanged. This is what lets `log_fields` work on JSONL trace logs
// (e.g. a UE AIMovementDebug `.jsonl` where the per-frame `Actor=(x,y,z)` lives inside `message`).
function normForFields(raw) {
  const t = raw.trim();
  if (t.charCodeAt(0) !== 123 /* { */ || t.charCodeAt(t.length - 1) !== 125 /* } */) return raw;
  let o;
  try { o = JSON.parse(t); } catch { return raw; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return raw;
  const parts = [];
  let msg = "";
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    if (k === "message" || k === "msg" || k === "text") { msg = String(v); continue; }
    if (typeof v === "object") continue; // skip nested arrays/objects
    parts.push(`${k}=${v}`);
  }
  return parts.join(" ") + (msg ? " " + msg : "");
}

export function extractFields(text, opts = {}) {
  const {
    fields = ["ts"],
    query = "",
    category = "",
    file = "",
    severityMin = "Verbose",
    window = null, // [t0, t1] on ts
    max = 200,
    maxLineChars = 200,
    stats = false, // aggregate each numeric column to min/max/avg/Δ (one line/col) instead of rows
  } = opts;
  const minRank = rank(severityMin);
  const q = String(query).toLowerCase();
  const catLc = String(category).toLowerCase();
  const fileLc = String(file).toLowerCase();
  // computed columns reference a base field
  const cols = fields.map((f) => {
    let mm;
    if (f === "dts") return { name: "dts", kind: "dts", base: "ts" };
    if ((mm = f.match(/^d:(.+)$/))) return { name: f, kind: "delta", base: mm[1] };
    if ((mm = f.match(/^step:(.+)$/))) return { name: f, kind: "step", base: mm[1] };
    return { name: f, kind: "value", base: f };
  });

  const rows = [];
  const acc = stats ? cols.map(() => []) : null; // per-column numeric values for stats mode
  let matched = 0;
  let prev = {};
  for (const raw of text.split(/\r?\n/)) {
    const e = parseLine(raw);
    if (!e) continue;
    if (rank(e.severity) < minRank) continue;
    if (catLc && e.category.toLowerCase() !== catLc) continue;
    if (fileLc && !e.location.toLowerCase().includes(fileLc)) continue;
    if (q && !raw.toLowerCase().includes(q)) continue;
    const norm = normForFields(raw); // JSONL → `Key=value` text (no-op for plain text lines)
    if (window) {
      const t = num(getField(norm, "ts"));
      if (t == null || t < window[0] || t > window[1]) continue;
    }
    const row = [];
    const cur = {};
    for (const c of cols) {
      if (c.kind === "value") {
        row.push(getField(norm, c.name));
      } else if (c.kind === "dts") {
        const t = num(getField(norm, "ts"));
        row.push(t != null && prev.ts != null ? (t - prev.ts).toFixed(3) : "");
        cur.ts = t;
      } else if (c.kind === "delta") {
        const v = num(getField(norm, c.base));
        const p = prev["v:" + c.base];
        row.push(v != null && p != null ? (v - p).toFixed(3) : "");
        cur["v:" + c.base] = v;
      } else if (c.kind === "step") {
        const x = num(vecComp(rawField(norm, c.base), 0));
        const y = num(vecComp(rawField(norm, c.base), 1));
        const px = prev["x:" + c.base];
        const py = prev["y:" + c.base];
        row.push(x != null && px != null ? Math.hypot(x - px, y - py).toFixed(2) : "");
        cur["x:" + c.base] = x;
        cur["y:" + c.base] = y;
      }
    }
    // always remember ts + referenced bases for next-row deltas
    if (cur.ts === undefined) cur.ts = num(getField(norm, "ts"));
    for (const c of cols) {
      if (c.kind === "delta" && cur["v:" + c.base] === undefined) cur["v:" + c.base] = num(getField(norm, c.base));
    }
    prev = cur;
    if (stats) {
      for (let i = 0; i < cols.length; i++) { const n = num(row[i]); if (n != null) acc[i].push(n); }
      if (++matched >= 500000) break; // safety bound; the window/query/category filters normally cap it
      continue;
    }
    let line = row.join("\t");
    if (line.length > maxLineChars) line = line.slice(0, maxLineChars) + " …";
    rows.push(line);
    if (rows.length >= max) break;
  }
  if (stats) {
    const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3));
    const lines = cols.map((c, i) => {
      const arr = acc[i];
      if (!arr.length) return `${c.name}: (no numeric values)`;
      let min = Infinity, mx = -Infinity, sum = 0;
      for (const v of arr) { if (v < min) min = v; if (v > mx) mx = v; sum += v; }
      const first = arr[0], last = arr[arr.length - 1];
      return `${c.name}: n=${arr.length} min=${fmt(min)} max=${fmt(mx)} avg=${fmt(sum / arr.length)} first=${fmt(first)} last=${fmt(last)} Δ=${fmt(last - first)}`;
    });
    return `stats over ${matched} matched row(s):\n${lines.join("\n") || "(no matching rows)"}`;
  }
  const header = fields.join("\t");
  const footer = rows.length >= max ? `\n… capped at ${max} rows (narrow window/query/maxGroups).` : "";
  return `${header}\n${rows.join("\n") || "(no matching rows)"}${footer}`;
}

// ---- analyze (search/filter + dedup) ----
export function analyzeLog(text, opts = {}) {
  const {
    query = "",
    severityMin = "Warning",
    category = "",
    file = "",
    maxGroups = 40,
    maxLocs = 5,
    maxLineChars = 200,
    summaryOnly = false,
    groupBy = "template", // "template" (per distinct message) | "callsite" (per file:line) | "code" (per diagnostic code)
  } = opts;
  const minRank = rank(severityMin);
  const q = String(query).toLowerCase();
  const catLc = String(category).toLowerCase();
  const fileLc = String(file).toLowerCase();

  const lines = text.split(/\r?\n/);
  let total = 0,
    matched = 0;
  const sevCounts = { Fatal: 0, Error: 0, Warning: 0, Display: 0, Verbose: 0 };
  const catCounts = {};
  const groups = new Map();

  for (const raw of lines) {
    const e = parseLine(raw);
    if (!e) continue;
    total++;
    sevCounts[e.severity] = (sevCounts[e.severity] || 0) + 1;
    catCounts[e.category] = (catCounts[e.category] || 0) + 1;
    if (rank(e.severity) < minRank) continue;
    if (catLc && e.category.toLowerCase() !== catLc) continue;
    if (fileLc && !e.location.toLowerCase().includes(fileLc)) continue;
    if (q && !e.message.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue;
    matched++;
    const key =
      groupBy === "callsite" && e.location
        ? `${e.severity}|${e.category}|@${e.location}`
        : groupBy === "code" && e.code
        ? `${e.severity}|${e.category}|#${e.code}`
        : `${e.severity}|${e.category}|${templateOf(e.message)}`;
    let g = groups.get(key);
    if (!g) {
      g = { severity: e.severity, category: e.category, code: e.code || "", message: e.message, count: 0, locs: new Set() };
      groups.set(key, g);
    }
    g.count++;
    if (e.location && g.locs.size < maxLocs) g.locs.add(e.location);
  }

  const header =
    `Log analysis — ${total} classified line(s); matched ${matched} ` +
    `(filter: severity≥${severityMin}${category ? `, category=${category}` : ""}` +
    `${file ? `, file~${file}` : ""}${query ? `, query="${query}"` : ""}).\n` +
    `Severity: Fatal ${sevCounts.Fatal}, Error ${sevCounts.Error}, Warning ${sevCounts.Warning}, ` +
    `Display ${sevCounts.Display}.`;

  if (summaryOnly) {
    const topCats = Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([c, n]) => `  ${c}: ${n}`)
      .join("\n");
    return `${header}\n\nTop categories:\n${topCats}`;
  }

  const sorted = [...groups.values()].sort(
    (a, b) => rank(b.severity) - rank(a.severity) || b.count - a.count
  );
  const shown = sorted.slice(0, maxGroups);
  const body = shown
    .map((g) => {
      let msg = g.message;
      if (msg.length > maxLineChars) msg = msg.slice(0, maxLineChars) + " …";
      const loc = g.locs.size ? "  @ " + [...g.locs].join(", ") : "";
      const mult = g.count > 1 ? `  (×${g.count})` : "";
      const codeTag = groupBy === "code" && g.code && !g.message.startsWith(g.code) ? `${g.code}: ` : "";
      return `${g.severity.toUpperCase()} [${g.category}] ${codeTag}${msg}${mult}${loc}`;
    })
    .join("\n");
  const more = sorted.length - shown.length;
  const footer =
    (more > 0 ? `\n\n… ${more} more group(s) (raise maxGroups, or filter by severity/category/query).` : "") +
    (matched === 0 ? `\n(no entries matched — lower severityMin or change the filter.)` : "");
  return `${header}\n\n${body || "(no matching entries)"}${footer}`;
}

// ---- locate (jump list: distinct file:line locations only, no message bodies) ----
// The most compact handoff for "open the offending source": dedup matched entries down to their
// callsite locations, ranked by severity then frequency. Pairs with rider-mcp-enforcer — feed the
// (basename) locations to find_files_by_name_keyword → read_file at the line. Entries with no
// parseable location are counted but cannot be jumped to, so they're reported as a tail note.
export function locateLog(text, opts = {}) {
  const {
    query = "",
    severityMin = "Error",
    category = "",
    file = "",
    max = 60,
    basename = false,
  } = opts;
  const minRank = rank(severityMin);
  const q = String(query).toLowerCase();
  const catLc = String(category).toLowerCase();
  const fileLc = String(file).toLowerCase();

  const locs = new Map(); // file:line -> { loc, severity (strongest), count, cats:Set }
  let matched = 0,
    noLoc = 0;
  for (const raw of text.split(/\r?\n/)) {
    const e = parseLine(raw);
    if (!e) continue;
    if (rank(e.severity) < minRank) continue;
    if (catLc && e.category.toLowerCase() !== catLc) continue;
    if (fileLc && !e.location.toLowerCase().includes(fileLc)) continue;
    if (q && !e.message.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue;
    matched++;
    if (!e.location) {
      noLoc++;
      continue;
    }
    const loc = basename ? e.location.replace(/^.*[\\/]/, "") : e.location;
    let g = locs.get(loc);
    if (!g) {
      g = { loc, severity: e.severity, count: 0, cats: new Set() };
      locs.set(loc, g);
    }
    g.count++;
    g.cats.add(e.category);
    if (rank(e.severity) > rank(g.severity)) g.severity = e.severity;
  }

  const sorted = [...locs.values()].sort(
    (a, b) => rank(b.severity) - rank(a.severity) || b.count - a.count || a.loc.localeCompare(b.loc)
  );
  const shown = sorted.slice(0, max);
  const header =
    `Jump list — ${sorted.length} distinct location(s) from ${matched} matched entr(y/ies) ` +
    `(filter: severity≥${severityMin}${category ? `, category=${category}` : ""}` +
    `${file ? `, file~${file}` : ""}${query ? `, query="${query}"` : ""}${basename ? ", basename" : ""}).`;
  const body = shown
    .map((g) => `${g.severity.toUpperCase()}  ${g.loc}  (×${g.count})  [${[...g.cats].slice(0, 3).join(",")}]`)
    .join("\n");
  const more = sorted.length - shown.length;
  const footer =
    (more > 0 ? `\n… ${more} more location(s) (raise max or filter).` : "") +
    (noLoc ? `\n(${noLoc} matched entr(y/ies) had no parseable file:line — not jumpable.)` : "") +
    (sorted.length === 0 ? `\n(no jumpable locations — lower severityMin or widen the filter.)` : "");
  return `${header}\n\n${body || "(none)"}${footer}`;
}

// ---- diff (compare two logs; emit ONLY the delta) ----
// Tally each side into templated groups, then report new / gone / count-changed
// groups only. Unchanged groups are omitted entirely — that omission IS the token
// win: a noisy log that barely changed yields a near-empty diff instead of a full dump.
function tally(text, { minRank, catLc, fileLc, q, groupBy, maxLocs }) {
  const sevCounts = { Fatal: 0, Error: 0, Warning: 0, Display: 0, Verbose: 0 };
  const groups = new Map();
  let total = 0;
  for (const raw of text.split(/\r?\n/)) {
    const e = parseLine(raw);
    if (!e) continue;
    if (rank(e.severity) < minRank) continue;
    if (catLc && e.category.toLowerCase() !== catLc) continue;
    if (fileLc && !e.location.toLowerCase().includes(fileLc)) continue;
    if (q && !e.message.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue;
    total++;
    sevCounts[e.severity] = (sevCounts[e.severity] || 0) + 1;
    const key =
      groupBy === "callsite" && e.location
        ? `${e.severity}|${e.category}|@${e.location}`
        : groupBy === "code" && e.code
        ? `${e.severity}|${e.category}|#${e.code}`
        : `${e.severity}|${e.category}|${templateOf(e.message)}`;
    let g = groups.get(key);
    if (!g) {
      g = { severity: e.severity, category: e.category, code: e.code || "", message: e.message, count: 0, locs: new Set() };
      groups.set(key, g);
    }
    g.count++;
    if (e.location && g.locs.size < maxLocs) g.locs.add(e.location);
  }
  return { total, sevCounts, groups };
}

export function diffLogs(textA, textB, opts = {}) {
  const {
    severityMin = "Warning",
    category = "",
    file = "",
    query = "",
    maxGroups = 40,
    maxLineChars = 200,
    minDelta = 1, // only report count-changes with |Δ| ≥ minDelta
    groupBy = "template",
    maxLocs = 5,
  } = opts;
  const o = {
    minRank: rank(severityMin),
    catLc: String(category).toLowerCase(),
    fileLc: String(file).toLowerCase(),
    q: String(query).toLowerCase(),
    groupBy: ["callsite", "code"].includes(groupBy) ? groupBy : "template",
    maxLocs,
  };
  const A = tally(textA, o);
  const B = tally(textB, o);

  const added = []; // in B, not A
  const gone = []; // in A, not B
  const changed = []; // in both, |Δ| ≥ minDelta
  for (const [key, g] of B.groups) {
    if (!A.groups.has(key)) added.push({ ...g, delta: g.count });
    else {
      const a = A.groups.get(key);
      const delta = g.count - a.count;
      if (Math.abs(delta) >= minDelta) changed.push({ ...g, from: a.count, to: g.count, delta });
    }
  }
  for (const [key, g] of A.groups) if (!B.groups.has(key)) gone.push({ ...g, delta: -g.count });

  const bySev = (x, y) => rank(y.severity) - rank(x.severity) || Math.abs(y.delta) - Math.abs(x.delta);
  added.sort(bySev);
  gone.sort(bySev);
  changed.sort(bySev);

  const clip = (m) => (m.length > maxLineChars ? m.slice(0, maxLineChars) + " …" : m);
  const locOf = (g) => (g.locs && g.locs.size ? "  @ " + [...g.locs].join(", ") : "");
  // Under groupBy=code, prefix the diagnostic code (mirrors analyzeLog) so a code-rolled diff is readable.
  const codeTag = (g) => (o.groupBy === "code" && g.code && !g.message.startsWith(g.code) ? `${g.code}: ` : "");
  const sevDelta = ["Fatal", "Error", "Warning", "Display"]
    .map((s) => {
      const a = A.sevCounts[s] || 0,
        b = B.sevCounts[s] || 0;
      const d = b - a;
      return `${s} ${a}→${b}${d ? ` (${d > 0 ? "+" : ""}${d})` : ""}`;
    })
    .join(", ");

  const filt =
    `severity≥${severityMin}` +
    `${category ? `, category=${category}` : ""}${file ? `, file~${file}` : ""}` +
    `${query ? `, query="${query}"` : ""}${o.groupBy !== "template" ? `, groupBy=${o.groupBy}` : ""}`;
  const header =
    `Log diff (A→B) — A: ${A.total} matched, B: ${B.total} matched (filter: ${filt}).\n` +
    `Severity delta: ${sevDelta}.`;

  if (!added.length && !gone.length && !changed.length)
    return `${header}\n\nNo differences at this filter — the two logs match (raise severityMin/minDelta or widen the filter to compare more).`;

  const section = (title, arr, fmt) => {
    if (!arr.length) return "";
    const shown = arr.slice(0, maxGroups);
    const more = arr.length - shown.length;
    return (
      `\n${title} (${arr.length}):\n` +
      shown.map(fmt).join("\n") +
      (more > 0 ? `\n  … ${more} more (raise maxGroups).` : "")
    );
  };
  const body =
    section("+ NEW", added, (g) => `+ ${g.severity.toUpperCase()} [${g.category}] ${codeTag(g)}${clip(g.message)}  (×${g.count})${locOf(g)}`) +
    section("- GONE", gone, (g) => `- ${g.severity.toUpperCase()} [${g.category}] ${codeTag(g)}${clip(g.message)}  (was ×${g.count})${locOf(g)}`) +
    section("~ CHANGED", changed, (g) => `~ ${g.delta > 0 ? "+" : ""}${g.delta}  ${g.severity.toUpperCase()} [${g.category}] ${codeTag(g)}${clip(g.message)}  (${g.from}→${g.to})${locOf(g)}`);

  return `${header}\n${body}`;
}

// ---- learnings (sanitized; for a LOCAL ledger only) ----
// Returns coverage + top category volumes + templated shapes of UNPARSED lines, so the tool can
// suggest new parsers/categories or noisy excludes. Variable parts are templated; the result is
// written only to a local file on the user's machine (never transmitted).
export function collectLearnings(text, maxSamples = 8) {
  const lines = text.split(/\r?\n/);
  let total = 0,
    parsed = 0;
  const cats = new Map();
  const misses = new Map();
  for (const raw of lines) {
    if (!raw.trim()) continue;
    total++;
    const e = parseLine(raw);
    if (e) {
      parsed++;
      cats.set(e.category, (cats.get(e.category) || 0) + 1);
      continue;
    }
    const shape = raw
      .replace(/0x[0-9a-fA-F]+/g, "<x>")
      .replace(/[A-Za-z]:\/[^\s'"]+/g, "<path>")
      .replace(/"[^"]*"/g, '"<q>"')
      .replace(/-?\d+(?:\.\d+)?/g, "<n>")
      .trim()
      .slice(0, 100);
    misses.set(shape, (misses.get(shape) || 0) + 1);
  }
  const top = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
  return {
    total,
    parsed,
    coverage: total ? parsed / total : 1,
    categories: top(cats, 10),
    misses: top(misses, maxSamples),
  };
}
