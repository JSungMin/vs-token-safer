#!/usr/bin/env node
/*
 * vs-token-safer — PreToolUse hook (matcher: the vs-search MCP LOCATE tools).
 *
 * When a LOCAL ORCHESTRATOR (qvts / vts-local-orchestrator) is present, a code-LOCATE call to the vs-search
 * MCP tools is the orchestrator's job, NOT Claude's: delegating it keeps the raw search output in the local
 * model and returns only a compact answer, saving Claude tokens. The orchestrator's SessionStart hint says
 * "delegate", but a hint loses the routing fight on a SINGLE lookup (vs-token-safer's own hint permits a
 * direct call there). A hint can't gate — only a hook can. So when orchestratorPresent(), this BLOCKS a
 * locate-class vs-search call (exit 2) and hands back the ready `qvts` command. The model then delegates.
 *
 * SCOPE — only the LOCATE tools are gated:
 *   search_text · search_symbol · find_files · find_references · goto_definition · concept_search ·
 *   def_search · document_symbols
 * NEVER gated (these stay Claude's direct tools):
 *   read_symbol (the sanctioned "read the decl body yourself" after a delegated file:line — delegation
 *   protocol step 1), hover, diagnostics, and ALL edits (insert_symbol / replace_symbol_body / rename /
 *   safe_delete / vts_admin).
 *
 * FALLBACK SAFETY — strict, but never strands the model. The delegation protocol says: if the delegated
 * answer is empty / no-match / error, retry the search yourself. A permanent block would forbid that retry.
 * So a block is ONE-TIME per distinct (tool,args): the first sight is blocked (→ delegate); an identical
 * call seen again within TTL is ALLOWED (it's the post-delegation fallback). The model: tries vs-search →
 * blocked → runs qvts → qvts no-match → retries the SAME vs-search call → now passes.
 *
 *   orchestrator absent                      → no-op (standalone vts behaves exactly as before)
 *   VTS_ORCH_BLOCK 0/false/off               → warn-only (allow + nudge), never blocks
 *   VTS_ORCHESTRATOR_AWARE 0                  → orchestratorPresent() false → no-op
 *   VTS_ENFORCE 0/false/off                  → master kill switch (matches block-code-grep) → no-op
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orchestratorPresent, resolveSearchRoot, recordActiveProject, readActiveProject, subprojectsUnder } from "../server/policy.js";

const off = (v) => /^(0|false|off|no)$/i.test(String(v ?? ""));

const CONFIG_FILE = process.env.VTS_CONFIG_FILE || path.join(os.homedir(), ".vs-token-safer", "config.json");
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; } };
function uiLang() {
  const v = String(process.env.VTS_LANG || readConfig().lang || "").toLowerCase();
  if (v) return v.startsWith("ko") ? "ko" : "en";
  try { return /^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "ko" : "en"; } catch { return "en"; }
}
const KO = uiLang() === "ko";

// The vs-search LOCATE tools (suffix after the MCP server prefix). read_symbol / hover / diagnostics / edits
// are intentionally absent — they are not delegated.
const LOCATE_TOOLS = new Set([
  "search_text", "search_symbol", "find_files", "find_references",
  "goto_definition", "concept_search", "def_search", "document_symbols",
]);
const toolSuffix = (name) => String(name || "").replace(/^.*__/, ""); // mcp__plugin_vs-token-safer_vs-search__search_text → search_text

// The configured/explicit root, then GENERALIZED: if the call names a file/dir target (search_text path,
// document_symbols path) that lives in a sibling sub-tree of the configured root (Unreal Engine/ vs Game/,
// a monorepo package, …), resolve UP to that target's real repo root so qvts scopes where the file actually is.
const rootFor = (ti) => {
  const configured = ti.projectPath || ti.project_path || process.env.VTS_PROJECT_PATH || readConfig().projectPath || process.cwd();
  const target = ti.path || ti.file || "";
  if (target) { const r = resolveSearchRoot(target, configured) || configured; recordActiveProject(r); return r; } // (A) remember
  return readActiveProject() || configured; // (A) target-less search inherits the last active project, not the broad parent
};

// Build a natural-language locate task from the MCP tool args, so the handed-back qvts command is ready to run.
function taskFor(suffix, ti) {
  const q = String(ti.q ?? ti.query ?? "").trim();
  const sym = String(ti.symbol ?? ti.name ?? q).trim();
  const p = String(ti.path ?? ti.file ?? "").trim();
  switch (suffix) {
    case "search_symbol": return `where is symbol ${q || sym} declared`;
    case "def_search": return `where is ${sym || q} defined`;
    case "goto_definition": return `where is ${sym || "the symbol at this position"} defined`;
    case "find_references": return `find all references and callers of ${sym || q}`;
    case "find_files": return `find file named ${q || sym}`;
    case "document_symbols": return `outline / list the symbols declared in ${p || "this file"}`;
    case "concept_search": return q || sym;
    case "search_text":
    default: return `find ${q || sym} in code`;
  }
}

const blockOn = () => !off(process.env.VTS_ORCH_BLOCK ?? "1");

// One-time-per-query state so a post-delegation fallback retry isn't blocked again.
const SEEN_FILE = path.join(os.homedir(), ".vs-token-safer", "orch-seen.json");
const TTL_MS = (() => { const n = Number(process.env.VTS_ORCH_TTL_MS); return Number.isFinite(n) && n > 0 ? n : 180000; })();
function seenRecently(key) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) || {}; } catch { /* none yet */ }
  // pass time in via the most recent stored stamp (no Date.now dependency in the hot decision is unnecessary
  // here — a hook is a fresh process; Date.now is allowed in hooks, only workflow scripts forbid it).
  const now = Date.now();
  const last = m[key];
  // prune expired
  for (const k of Object.keys(m)) if (now - m[k] > TTL_MS) delete m[k];
  const recent = typeof last === "number" && now - last <= TTL_MS;
  m[key] = now;
  try { fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify(m)); } catch { /* best effort */ }
  return recent;
}

// FALLBACK WINDOW — the orchestrator (qvts) drops ~/.vts-local/orch-fallback.json when a delegated locate came
// up dry (empty / no-match / error). That is the real "the local model already tried and couldn't" signal, so
// for a short window Claude must be free to search DIRECTLY (the delegation protocol's fallback step) — not just
// re-issue the IDENTICAL call (seenRecently), but ANY follow-up search (different query/tool). Without this the
// gate re-blocks every fresh fallback search and Claude abandons search entirely (reads whole files instead).
const FALLBACK_FILE = path.join(os.homedir(), ".vts-local", "orch-fallback.json");
const FB_TTL_MS = (() => { const n = Number(process.env.VTS_ORCH_FALLBACK_TTL_MS); return Number.isFinite(n) && n > 0 ? n : 120000; })();
function fallbackWindowOpen() {
  try {
    const m = JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8"));
    return m && typeof m.ts === "number" && Date.now() - m.ts <= FB_TTL_MS;
  } catch { return false; }
}

// (B) when the chosen root is a broad PARENT holding multiple sub-projects, nudge the caller to scope -p.
function subprojectHint(root) {
  const subs = subprojectsUnder(root);
  if (subs.length < 2) return "";
  const list = subs.slice(0, 5).join(", ");
  return KO
    ? `\n참고: "${root}"는 여러 프로젝트를 포함한 상위 폴더예요. 정확/빠른 결과를 위해 작업 중인 구체 프로젝트를 -p로 지정하세요 (후보: ${list}).`
    : `\nNote: "${root}" is a parent holding multiple projects. For accurate/fast results pass -p the specific one you're working on (candidates: ${list}).`;
}
function msg(qvtsCmd, root) {
  const hint = root ? subprojectHint(root) : "";
  return (KO
    ? `✨ vs-token-safer: 로컬 오케스트레이터(qvts) 감지 — 이 locate는 위임하세요.\n→ ${qvtsCmd}\n   (로컬 모델이 vs-search를 돌리고 compact 답만 반환 — Claude 토큰 절약. answer의 file:line은 사실로 신뢰; 바디는 read_symbol로 직접 읽기.)\n이미 위임했는데 no-match/에러였으면 같은 호출 다시 하면 통과됩니다. warn전환: VTS_ORCH_BLOCK=0`
    : `✨ vs-token-safer: local orchestrator (qvts) detected — delegate this locate.\n→ ${qvtsCmd}\n   (the local model runs vs-search and returns only a compact answer — saves Claude tokens. Trust the answer's file:line; read bodies yourself with read_symbol.)\nAlready delegated and got no-match/error? Re-issue the same call and it passes. Warn-only: VTS_ORCH_BLOCK=0`) + hint;
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (off(process.env.VTS_ENFORCE)) process.exit(0);
  let j;
  try { j = JSON.parse(input); } catch { process.exit(0); }
  const suffix = toolSuffix(j.tool_name);
  if (!LOCATE_TOOLS.has(suffix)) process.exit(0);          // not a locate tool → allow
  if (!orchestratorPresent()) process.exit(0);             // standalone vts → unchanged behavior

  const ti = j.tool_input || {};
  const root = rootFor(ti);
  const task = taskFor(suffix, ti).replace(/"/g, "'");     // keep the handed-back command shell-safe
  const safeRoot = String(root).replace(/"/g, "'");
  const qvtsCmd = `qvts -p "${safeRoot}" --json "${task}"`;

  const key = `${suffix}:${JSON.stringify(ti)}`;
  const fallbackRetry = seenRecently(key);     // identical call re-issued → the post-delegation retry
  const fallbackWindow = fallbackWindowOpen(); // qvts recently came up dry → any direct search is the fallback

  if (blockOn() && !fallbackRetry && !fallbackWindow) {
    process.stderr.write(msg(qvtsCmd, root) + "\n");
    process.exit(2); // block — route this locate to the local orchestrator
  }
  // warn-only mode, OR a post-delegation fallback retry → allow, but surface the nudge.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: msg(qvtsCmd, root) },
  }) + "\n");
  process.exit(0);
});
