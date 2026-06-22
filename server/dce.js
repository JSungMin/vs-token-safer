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

export async function analyzeDeadCode(query, seeds, opts = {}) {
  const maxNodes = Math.max(1, opts.maxNodes || 200);
  const isEntry = opts.isEntry || (() => false);
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

// Token-capped, sectioned preview. Never prints source bodies — names + file:line + ready safe_delete calls.
export function formatDce(result, opts = {}) {
  const cap = opts.cap || 60;
  const { dead, held, entry, inconclusive, truncated, seeds, coldNote } = result;
  const L = [`dead-code analysis from seed(s): ${seeds.join(", ")} — PREVIEW ONLY, nothing was deleted.`];
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
    held.slice(0, cap).forEach((h) => L.push(`  ${h.name}${h.callers.length ? `  ← called by ${h.callers.join(", ")}` : ""}`));
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
