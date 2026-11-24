// Cold LSP pre-emption & precision-ladder routing (clangd · roslyn · pyright · typescript).
// Serves committed .vts-index / tree-sitter syntactic results in <15ms when an LSP backend is cold, missing, or
// mid-crawl, auto-descends SYNTACTIC ➔ FUZZY on 0-hit misses in one call, and provides session slice dedup stubs.
import fs from "node:fs";
import path from "node:path";
import { canonFsPath, envInt } from "./lsp.js";
import { BACKENDS, clangdAvailable, effectiveCdbDir } from "./backends/index.js";
import { hasSymIndex, symIndexPath, indexFreshness } from "./symindex.js";
import { tsSearchReferences } from "./treesitter.js";

export function preemptEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.VTS_SYMBOL_PREEMPT ?? "1"));
}

export function isBackendWarm(clients, backendName, root) {
  const entry = clients && clients.get(`${backendName}|${root}`);
  return !!(entry && entry.client);
}

const _cdbCache = new Map(); // cdbDir → { count, files:Set<canonPath>, mtime }
export function loadCdb(cdbDir) {
  try {
    const cc = path.join(cdbDir, "compile_commands.json");
    const st = fs.statSync(cc);
    const hit = _cdbCache.get(cdbDir);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const j = JSON.parse(fs.readFileSync(cc, "utf8"));
    const v = { count: j.length, files: new Set(j.map((e) => canonFsPath(String(e.file || ""))).filter(Boolean)), mtime: st.mtimeMs };
    _cdbCache.set(cdbDir, v);
    return v;
  } catch { return null; }
}

export function clangdShardCount(cdbDir) {
  try {
    let n = 0;
    for (const f of fs.readdirSync(path.join(cdbDir, ".cache", "clangd", "index"))) if (f.endsWith(".idx")) n++;
    return n;
  } catch { return 0; }
}

const _bigTreeCache = new Map(); // root → boolean
export function bigTreeLikely(root) {
  if (_bigTreeCache.has(root)) return _bigTreeCache.get(root);
  const cap = envInt("VTS_SYMBOL_PREEMPT_FILES", 3000);
  const t0 = Date.now();
  let n = 0, big = false;
  const stack = [root];
  const skip = (name) => name.startsWith(".") || /^(node_modules|intermediate|binaries|saved|deriveddatacache|build|dist|out|obj)$/i.test(name);
  while (stack.length && !big) {
    if (Date.now() - t0 > 400) { big = n > cap / 4; break; }
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!skip(e.name)) stack.push(path.join(d, e.name)); }
      else if (/\.(c|cc|cxx|cpp|h|hpp|hh|inl)$/i.test(e.name) && ++n >= cap) { big = true; break; }
    }
  }
  _bigTreeCache.set(root, big);
  return big;
}

export function clangdCrawlLikely(root, clients) {
  let cdbDir; try { cdbDir = effectiveCdbDir(root); } catch { cdbDir = null; }
  if (!clangdAvailable(BACKENDS.clangd.cmd)) return { crawl: true, missing: true, why: "clangd not installed" };
  const db = cdbDir ? loadCdb(cdbDir) : null;
  if (!db || db.count === 0) return { crawl: true, why: "no compile_commands.json" };
  const warm = !!(clients && clients.has(`clangd|${root}`));
  if (!warm && hasSymIndex(root)) return { crawl: true, cold: true, why: "cold clangd, committed index available" };
  if (db.count > envInt("VTS_SYMBOL_PREEMPT_TU_MAX", 8000)) {
    const shards = clangdShardCount(cdbDir);
    if (shards < Math.floor(db.count * 0.9)) return { crawl: true, why: `~${db.count.toLocaleString()} TUs, index incomplete` };
    if (!warm) return { crawl: true, cold: true, why: `~${db.count.toLocaleString()} TUs, cold start (no warm clangd yet)` };
  }
  return { crawl: false, why: "" };
}

// Unified cold/crawl verdict across clangd, roslyn, pyright, and typescript.
export function backendPreemptVerdict(backendName, root, clients) {
  if (!preemptEnabled()) return { preempt: false };
  if (backendName === "clangd") {
    const { crawl, why, missing, cold } = clangdCrawlLikely(root, clients);
    const preempt = crawl && (missing || fs.existsSync(symIndexPath(root)) || bigTreeLikely(root));
    return { preempt, backendLabel: "clangd", why, missing, cold };
  }
  if ((backendName === "roslyn" || backendName === "pyright" || backendName === "typescript") &&
      !isBackendWarm(clients, backendName, root) && hasSymIndex(root)) {
    return { preempt: true, backendLabel: backendName, cold: true, missing: false, why: `cold ${backendName}, committed index available` };
  }
  return { preempt: false };
}

export async function preemptSearchSymbol(backendName, root, a, clients, deps) {
  const v = backendPreemptVerdict(backendName, root, clients);
  if (!v.preempt) return null;
  const {
    maxResults, scopedSyntacticSymbols, symScopeNote, kickAutoIndex, autoIndexNote, prewarm, fuzzyFallback,
    ladderOn, ladderLine, completenessCert, scanTextUnder, widenRootHint, emptyHint, finishOut,
  } = deps;
  if (v.cold && typeof prewarm === "function" && /^(1|true|on|yes)$/i.test(String(process.env.VTS_PREWARM_ON_PREEMPT || ""))) {
    try { prewarm(root, backendName).catch(() => {}); } catch { /* ignore */ }
  }
  const pmax = Number(a.maxResults) || maxResults;
  const syn = await scopedSyntacticSymbols(root, a.q, a.path, pmax);
  const hasIdx = fs.existsSync(symIndexPath(root));
  const autoNote = hasIdx ? "" : autoIndexNote(root, kickAutoIndex(root));
  const rung = v.cold ? "SYNTACTIC (instant)" : "SYNTACTIC";
  const reason = v.missing ? `${v.backendLabel} not installed` : v.cold ? `${v.backendLabel} warming` : v.why;
  const climb = v.missing ? `install ${v.backendLabel} (vts setup) → goto_definition for semantic def/refs`
    : v.cold ? "re-query for EXACT"
    : hasIdx ? "" : `vts index (one-time; then goto_definition once ${v.backendLabel} warms)`;
  const ladder = ladderLine({ rung, reason, climb });
  const buildHint = ladderOn() ? "" : (hasIdx ? "" :
    `\n↪ Make this instant + complete: vts_index (one-time build; chunk-safe on huge trees, no toolchain needed) — then commit .vts-index/ to share it with the team.`);
  if (syn) {
    const scopeTag = syn.scoped ? ` in ${syn.scoped}` : "";
    const fresh = /committed index/.test(syn.source || "") ? indexFreshness(root) : { stale: false, changed: 0 };
    const tail = fresh.stale ? ladderLine({ rung: "SYNTACTIC · STALE", reason: `${fresh.changed} file(s) changed`, climb: "vts index (rebuild)" }) : ladder;
    return finishOut(syn.lines, `${v.backendLabel} can't serve this tree fast (${v.why}) — ${syn.source} declaration matches for "${a.q}"${scopeTag}:\n` + syn.lines.join("\n") + symScopeNote(syn, a.q) + buildHint + autoNote + completenessCert({ shown: syn.lines.length, total: syn.total, truncated: syn.truncated, syntactic: true, stale: fresh.stale ? fresh.changed : 0 }) + tail);
  }
  // 1-Call SYNTACTIC ➔ FUZZY auto-descend when syntactic tier misses.
  if (process.env.VTS_CONCEPT_STEER !== "0" && typeof fuzzyFallback === "function") {
    const fz = await fuzzyFallback(root, String(a.q), Math.min(pmax, 20));
    if (fz && fz.length) {
      const fzTail = ladderLine({ rung: "FUZZY (auto-descend)", reason: `0 syntactic hits (${reason})`, climb: `re-query once ${v.backendLabel} warms` });
      return finishOut(fz, `${v.backendLabel} can't serve this tree fast (${v.why}) — 0 syntactic hits; auto-descended to FUZZY concept matches for "${a.q}":\n` + fz.join("\n") + autoNote + completenessCert({ shown: fz.length, total: fz.length, fuzzy: true }) + fzTail);
    }
  }
  const descend = process.env.VTS_CONCEPT_STEER !== "0"
    ? ladderLine({ rung: "SYNTACTIC miss", reason, climb: `concept_search q="${a.q}" (fuzzy — repo-mined, no embeddings)`, verb: "descend" })
    : ladder;
  const hits = scanTextUnder(root, String(a.q), Math.min(pmax, 60));
  if (hits.length) return finishOut(hits, `${v.backendLabel} can't serve this tree fast (${v.why}) — literal text matches for "${a.q}" (file:line, not a semantic decl):\n` + hits.join("\n") + buildHint + autoNote + descend);
  return finishOut([], `${v.backendLabel} can't serve this tree fast (${v.why}) and no syntactic/text match for "${a.q}" under ${root}.` + buildHint + autoNote + descend + emptyHint + widenRootHint(root));
}

export async function preemptFindReferences(backendName, root, a, clients, deps) {
  if (!a.symbol) return null;
  const v = backendPreemptVerdict(backendName, root, clients);
  if (!v.preempt) return null;
  const {
    maxResults, syntacticSymbols, kickAutoIndex, autoIndexNote, prewarm, skipDir,
    compactResults, compactLocationLines, completenessCert, ladderLine, trimMatchLine, scanTextUnder, emptyHint, finishOut,
  } = deps;
  if (v.cold && typeof prewarm === "function" && /^(1|true|on|yes)$/i.test(String(process.env.VTS_PREWARM_ON_PREEMPT || ""))) {
    try { prewarm(root, backendName).catch(() => {}); } catch { /* ignore */ }
  }
  const want = String(a.symbol), rMax = Number(a.maxResults) || maxResults;
  const syn = await syntacticSymbols(root, want, 3);
  const declLine = syn && syn.lines.length ? `Declaration (committed index): ${syn.lines[0]}\n` : "";
  const rAutoNote = fs.existsSync(symIndexPath(root)) ? "" : autoIndexNote(root, kickAutoIndex(root));
  const rRung = v.cold ? "SYNTACTIC (instant)" : "SYNTACTIC";
  const rReason = v.missing ? `${v.backendLabel} not installed` : v.cold ? `${v.backendLabel} warming` : v.why;
  const rClimb = v.missing ? `install ${v.backendLabel} (vts setup) → find_references for semantic call sites`
    : v.cold ? "re-query for EXACT references"
    : `vts index, then find_references once ${v.backendLabel} warms (semantic call sites)`;
  const rLadder = ladderLine({ rung: rRung, reason: rReason, climb: rClimb });
  const tsRefs = await tsSearchReferences(root, want, { skipDir: (n) => skipDir(n, root) });
  if (tsRefs && tsRefs.length) {
    const refLines = tsRefs.slice(0, rMax).map((r) => `${r.file}:${r.line}`);
    const body = compactResults() ? compactLocationLines(refLines) : refLines.join("\n");
    return finishOut(refLines, `${v.backendLabel} can't serve this tree fast (${v.why}) — ${tsRefs.length} tree-sitter call reference(s) for "${want}" (syntactic AST):\n` + declLine + body + rAutoNote + completenessCert({ shown: refLines.length, total: tsRefs.length, truncated: tsRefs.length > rMax ? "cap" : tsRefs.truncated, syntactic: true }) + rLadder);
  }
  const declFiles = [...new Set((syn ? syn.lines : []).map((l) => l.split(/:\d+:/)[0]))].slice(0, 3);
  const uses = [];
  for (const df of declFiles) {
    try {
      fs.readFileSync(df, "utf8").split(/\r?\n/).forEach((ln, i) => {
        if (ln.includes(want) && uses.length < rMax) uses.push(`${df.replace(/\\/g, "/")}:${i + 1}: ${trimMatchLine(ln)}`);
      });
    } catch { /* ignore */ }
  }
  let truncated = null;
  if (uses.length < rMax) {
    const more = scanTextUnder(root, want, rMax - uses.length);
    truncated = more.truncated || null;
    const seen = new Set(uses.map((u) => u.split(": ")[0]));
    for (const m of more) if (!seen.has(m.split(": ")[0])) uses.push(m);
  }
  if (uses.length) return finishOut(uses, `${v.backendLabel} can't serve this tree fast (${v.why}) — literal usage matches for "${want}" (file:line of the NAME, not semantic references; declaration-file hits listed first):\n` + declLine + uses.join("\n") + (truncated ? `\n[tree scan truncated: ${truncated} — decl-file hits above are complete; narrow projectPath for the full tree set]` : "") + rAutoNote + rLadder);
  const rDescend = process.env.VTS_CONCEPT_STEER !== "0"
    ? ladderLine({ rung: "SYNTACTIC miss", reason: rReason, climb: `concept_search q="${want}" (fuzzy — repo-mined, no embeddings)`, verb: "descend" })
    : rLadder;
  return finishOut([], `${v.backendLabel} can't serve this tree fast (${v.why}) and no text usage found for "${want}" under ${root}.\n` + declLine + rAutoNote + rDescend + emptyHint);
}

// Session-scoped slice deduplication stub registry (opt-in VTS_SESSION_DEDUP=1).
const _sessionSeenSlices = new Map(); // `${file}::${symbol}` → { sha, range }
export function checkSessionSliceDedup(file, symbol, sha, range) {
  if (!/^(1|true|on|yes)$/i.test(String(process.env.VTS_SESSION_DEDUP || ""))) return null;
  const key = `${canonFsPath(String(file || ""))}::${symbol}`;
  const prev = _sessionSeenSlices.get(key);
  if (prev && prev.sha === sha) return `[session-dedup: ${symbol} (${range}) unchanged in context]`;
  _sessionSeenSlices.set(key, { sha, range });
  return null;
}
