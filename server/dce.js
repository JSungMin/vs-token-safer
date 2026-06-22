// dce.js — TOPOLOGICAL dead-code ANALYSIS (preview-only).
//
// Given seed symbols, walk the call graph to a fixpoint and classify every reachable symbol as
//   DEAD          — no live caller remains (all its callers are themselves slated for removal), OR
//   HELD          — still called by something outside the removal set, OR
//   ENTRY         — a root we must keep (main / public API / user-named entry pattern), OR
//   INCONCLUSIVE  — could not be resolved, or its caller set could not be proven COMPLETE.
//
// It NEVER deletes. It emits a candidate list + a suggested deletion order. The actual removal still goes
// through `safe_delete`, whose independent find_references guard refuses a symbol that is still referenced —
// so a false "DEAD" here cannot delete live code. The layering is the safety model:
//   DCE proposes (the call graph)  ·  safe_delete disposes (the reference guard).
//
// PURE: the graph query is INJECTED, so this module touches no fs/LSP and is fully unit-testable.
//   query(name) -> {
//     resolved: bool,
//     callers:  [{ name, file }],   // immediate callers (who calls `name`)
//     callees:  [{ name, file }],   // immediate callees (whom `name` calls) — the cascade frontier
//     cert:     "COMPLETE" | "PARTIAL" | "INCONCLUSIVE" | ...,   // confidence in the CALLER set
//     file, line                    // where `name` is declared
//   }

// WARM GATE — the safety preflight. clangd's call graph on a cold or large (e.g. Unreal) tree UNDER-REPORTS
// callers: a caller living in a translation unit clangd has not indexed yet is simply absent, so a LIVE symbol
// looks like it has no callers → a false DEAD. For a workflow that feeds `safe_delete`, that is the worst
// failure mode, so unless a persisted index exists we REFUSE by default. `allowCold` lets the caller proceed
// anyway, but then every verdict is forced to INCONCLUSIVE (never DEAD) — the structure is shown, no deletion
// is ever implied. Non-clangd backends index on open and carry no persisted-index notion, so they are not
// gated here (their per-symbol cert still reflects truncation). PURE — the caller supplies `persisted`.
export function dceWarmGate(backendName, persisted, allowCold) {
  if (backendName === "clangd" && !persisted) return { refuse: !allowCold, forceInconclusive: true };
  return { refuse: false, forceInconclusive: false };
}

// REFERENCE RECONCILIATION — the "thorough" correctness check that closes the call graph's blind spot. The
// call graph sees CALLS; it does not see a function used as a value/callback, via reflection, a string/dynamic
// dispatch, or a member taken by address. So before trusting a "no live callers → DEAD" verdict, compare the
// total SEMANTIC reference count (textDocument/references — every use, not just calls) against the number of
// CALL SITES the graph accounts for. If there are MORE references than call sites, the surplus are non-call
// uses that keep the symbol alive → it is NOT provably dead. PURE — the caller supplies the two counts.
//   refCount === null  → references could not be counted → cannot confirm (treat as not-dead, safe).
//   refCount  >  callSites → extra non-call references exist → not dead.
//   refCount <= callSites → every reference is a call the removal set will delete → confirmed dead.
export function reconcileRefs(callSites, refCount) {
  const cs = Number(callSites) || 0;
  if (refCount == null || Number.isNaN(Number(refCount))) return { confirmed: false, reason: "could not count references to verify it is unused (index not ready?)" };
  const rc = Number(refCount);
  if (rc > cs) return { confirmed: false, reason: `${rc} reference(s) but only ${cs} call-site(s) — the surplus are non-call uses (function value / reflection / dynamic dispatch), so it is NOT provably dead` };
  return { confirmed: true };
}

export async function analyzeDeadCode(query, seeds, opts = {}) {
  const maxNodes = Math.max(1, opts.maxNodes || 200);
  const isEntry = opts.isEntry || (() => false);
  const verify = opts.verify || null;   // async (name, queryResult) -> { confirmed, reason } — the thorough gate
  const seedList = [...new Set(seeds.filter(Boolean))];

  const info = new Map();
  const q = async (name) => { if (!info.has(name)) info.set(name, await query(name)); return info.get(name); };

  const removal = new Set();   // confirmed DEAD
  const order = [];            // discovery order = a safe deletion order (each is unreferenced once the ones above it are gone)
  const entry = new Map();     // name -> reason
  const incon = new Map();     // name -> reason
  const candidates = new Set(seedList);

  // Fixpoint: a symbol with a still-live caller is NOT finalized — a later pass may remove that caller and
  // free it. Only ENTRY and INCONCLUSIVE are terminal classifications; "has a live caller" is re-checked.
  let changed = true;
  while (changed && removal.size < maxNodes) {
    changed = false;
    for (const name of [...candidates]) {
      if (removal.has(name) || entry.has(name) || incon.has(name)) continue;
      const r = await q(name);
      if (!r || !r.resolved) { incon.set(name, "could not resolve to a callable symbol (no backend, or not a function/method)"); continue; }
      if (isEntry(name, r)) { entry.set(name, "entry point / public API — kept as a root"); continue; }
      if (r.cert !== "COMPLETE") { incon.set(name, `caller set is ${r.cert || "unverified"} — cannot prove it is unused`); continue; }
      const live = (r.callers || []).filter((c) => c.name !== name && !removal.has(c.name));
      if (live.length === 0) {
        // THOROUGH gate: before marking DEAD (and cascading through it), verify via the full reference set that
        // no non-call use keeps it alive. A failed verify → INCONCLUSIVE, and we do NOT cascade through it (its
        // callees stay candidates but aren't freed by it), so a single unverifiable symbol can't fan out false DEAD.
        if (verify) {
          const v = await verify(name, r);
          if (!v || !v.confirmed) { incon.set(name, (v && v.reason) || "reference verification did not confirm it is unused"); continue; }
        }
        removal.add(name); order.push(name); changed = true;
        for (const ce of r.callees || []) if (ce.name !== name) candidates.add(ce.name);
      }
    }
  }
  const truncated = removal.size >= maxNodes;

  const held = [];
  for (const name of candidates) {
    if (removal.has(name) || entry.has(name) || incon.has(name)) continue;
    const r = info.get(name);
    const live = (r && r.callers ? r.callers : []).filter((c) => c.name !== name && !removal.has(c.name));
    held.push({ name, callers: [...new Set(live.map((c) => c.name))].slice(0, 8) });
  }
  const dead = order.map((name) => { const r = info.get(name); return { name, file: r && r.file, line: r && r.line }; });
  return {
    dead, order,
    held,
    entry: [...entry].map(([name, reason]) => ({ name, reason })),
    inconclusive: [...incon].map(([name, reason]) => ({ name, reason })),
    truncated, seeds: seedList,
  };
}

// REACHABILITY (mark-sweep) mode — the Go-`deadcode`/RTA model. Instead of asking "does this symbol have a
// caller?" (which a missing/unindexed caller can answer wrong → false DEAD), it computes liveness FORWARD from
// the program's ENTRY POINTS: mark everything reachable from the roots (over callees), then a seed is DEAD iff
// it is NOT in the reachable set. Computed from roots, so a missing *caller* edge cannot make a live symbol
// look dead — the only way to be wrong is an INCOMPLETE ROOT SET (a symbol reachable only from a root you did
// not name), which the `verify` reference-check then catches (a reference from reachable code ⇒ not dead).
// Stays demand-driven (universe = the seed closure, not the whole program), so it scales to a huge tree.
// PURE — `query(name)` (callees + cert) and `verify` are injected; `roots`/`seeds` are name lists.
export async function reachabilityDeadCode(query, roots, seeds, opts = {}) {
  const maxNodes = Math.max(1, opts.maxNodes || 2000);
  const verify = opts.verify || null;
  const isEntry = opts.isEntry || (() => false);
  const rootList = [...new Set((roots || []).filter(Boolean))];
  const seedList = [...new Set((seeds || []).filter(Boolean))];
  const info = new Map();
  const q = async (name) => { if (!info.has(name)) info.set(name, await query(name)); return info.get(name); };

  // 1. MARK — everything reachable from the roots, walking callees forward.
  const reachable = new Set();
  const queue = [...rootList];
  while (queue.length && reachable.size < maxNodes) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    const r = await q(name);
    if (!r || !r.resolved) continue;           // an unresolvable root/callee is still "named reachable", just can't expand
    for (const ce of r.callees || []) if (!reachable.has(ce.name)) queue.push(ce.name);
  }

  // 2. SWEEP — classify the seed closure (seeds, then the callees of any dead one) by reachability.
  const rootSet = new Set(rootList);
  const dead = [], held = [], order = [], incon = new Map();
  const visited = new Set();
  const work = [...seedList];
  while (work.length && dead.length < maxNodes) {
    const name = work.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    if (rootSet.has(name)) { held.push({ name, note: "is a root" }); continue; }
    if (isEntry(name)) { held.push({ name, note: "entry point / public API" }); continue; }
    if (reachable.has(name)) { held.push({ name, note: "reachable from a root" }); continue; }
    const r = await q(name);
    if (!r || !r.resolved) { incon.set(name, "could not resolve to a callable symbol"); continue; }
    if (r.cert !== "COMPLETE") { incon.set(name, `call graph is ${r.cert || "unverified"} — cannot trust reachability`); continue; }
    if (verify) { const v = await verify(name, r); if (!v || !v.confirmed) { incon.set(name, (v && v.reason) || "a reference from reachable code keeps it alive (incomplete roots?)"); continue; } }
    dead.push({ name, file: r.file, line: r.line }); order.push(name);
    for (const ce of r.callees || []) if (!visited.has(ce.name)) work.push(ce.name); // its callees may also be unreachable
  }
  return {
    dead, order, held,
    entry: [],
    inconclusive: [...incon].map(([name, reason]) => ({ name, reason })),
    truncated: dead.length >= maxNodes,
    seeds: seedList, roots: rootList,
    mode: "reachability (mark-sweep from roots)",
  };
}

// Token-capped, sectioned preview. Never prints source bodies — names + file:line + ready safe_delete calls.
export function formatDce(result, opts = {}) {
  const cap = opts.cap || 60;
  const { dead, held, entry, inconclusive, truncated, seeds, roots, coldNote, mode } = result;
  const L = [`dead-code analysis from seed(s): ${seeds.join(", ")}${mode ? ` — ${mode}` : ""} — PREVIEW ONLY, nothing was deleted.`];
  if (roots && roots.length) L.push(`roots (liveness computed forward from these): ${roots.join(", ")}`);
  if (coldNote) L.push(`⚠ ${coldNote}`);
  L.push("");

  if (dead.length) {
    L.push(`DEAD — ${dead.length} candidate(s), in a safe deletion order (each is unreferenced once the ones above it are removed):`);
    dead.slice(0, cap).forEach((d, i) => L.push(`  ${i + 1}. ${d.name}${d.file ? `  @ ${d.file}:${d.line}` : ""}`));
    if (dead.length > cap) L.push(`  … ${dead.length - cap} more`);
    L.push("");
    L.push("  to remove (each still passes safe_delete's own reference guard, so it cannot delete live code):");
    dead.slice(0, Math.min(cap, 12)).forEach((d) => L.push(`    safe_delete symbol="${d.name}" apply=true`));
    if (dead.length > 12) L.push(`    … and ${dead.length - 12} more, top-to-bottom`);
  } else {
    L.push("DEAD — none. No seed is provably unreferenced (see HELD / INCONCLUSIVE below).");
  }

  if (held.length) {
    L.push("", `HELD — ${held.length} still referenced (NOT dead):`);
    held.slice(0, cap).forEach((h) => {
      const why = h.callers && h.callers.length ? `  ← called by ${h.callers.join(", ")}` : h.note ? `  (${h.note})` : "";
      L.push(`  ${h.name}${why}`);
    });
  }
  if (entry.length) L.push("", `ENTRY — ${entry.length} kept as root(s): ${entry.map((e) => e.name).join(", ")}`);
  if (inconclusive.length) {
    L.push("", `INCONCLUSIVE — ${inconclusive.length} (cannot prove dead — verify manually):`);
    inconclusive.slice(0, cap).forEach((x) => L.push(`  ${x.name} — ${x.reason}`));
  }
  if (truncated) L.push("", "(node cap hit — more may cascade; raise maxNodes or re-run from the tail of the DEAD list.)");

  L.push(
    "",
    "CAVEAT: candidates come from the CALL graph, which does not see non-call references — a function used as a",
    "value/callback, reflection, string or dynamic dispatch, cross-language calls, or test-only usage. Treat DEAD",
    "as CANDIDATES, not a verdict: safe_delete re-checks each with find_references and refuses while referenced.",
  );
  return L.join("\n");
}

// Parse a committable root list — `<root>/.vts-index/dce-roots.json` — the team-curated, version-controlled,
// inspectable declaration of a project's ENTRY POINTS for reachability mode (its tests, route handlers, DI
// registrations, public API, reflection/dynamic-dispatch targets). Generic and framework-agnostic: vts hard-
// codes NO framework markers (no UFUNCTION, no @Route) — the team names its own roots, the same charter-pure,
// no-drift mechanism as the committable concept-synonyms file. Accepts `["a","b"]` or `{ "roots": [...] }`.
// PURE (text → string[]); returns [] on a malformed/empty file (reachability then runs on the passed roots alone).
export function parseRootsFile(text) {
  let obj;
  try { obj = JSON.parse(String(text)); } catch { return []; }
  const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.roots) ? obj.roots : null;
  if (!arr) return [];
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}
