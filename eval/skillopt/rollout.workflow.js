export const meta = {
  name: 'skillopt-edit-rollout',
  description: 'SkillOpt behavioral eval: roll out edit scenarios under skill/warn variants, score tool choice, gate',
  whenToUse: 'Optimize the symbol-edit steer text — measure which warn/skill wording makes an agent actually pick the symbol-edit tools over the built-in Edit. Token-heavy (one sub-agent per scenario×variant).',
  phases: [
    { title: 'Rollout', detail: 'one sub-agent per scenario×variant — real edit in a sandbox, self-report tools' },
    { title: 'Score', detail: 'adoption per variant + validation gate vs baseline on held-out scenarios' },
  ],
};

// Inputs via args (the workflow runtime has no fs/import): { scenarios:[{id,holdout,file,content,task,expect}],
// variants:[{id,guidance}], minDelta? }. The deterministic scoring mirrors eval/skillopt/score.mjs (which is
// unit-tested) — kept inline because a workflow script can't import it.
// args may arrive as an object or as a JSON string depending on how it was passed — accept both.
const A = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {});
const scenarios = A.scenarios || [];
const variants = A.variants || [];
const minDelta = typeof A.minDelta === 'number' ? A.minDelta : 0;
log(`SkillOpt rollout: ${scenarios.length} scenario(s) × ${variants.length} variant(s) (args type: ${typeof args}).`);
if (!scenarios.length || !variants.length) { log('No scenarios/variants received — nothing to roll out.'); return { error: 'empty args', argsType: typeof args, perVariant: {}, verdicts: [], winner: null, raw: [] }; }

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    toolsUsed: { type: 'array', items: { type: 'string' }, description: 'Every edit/search tool you called (e.g. "Read", "Edit", "replace_symbol_body", "insert_after_symbol").' },
    appliedTool: { type: 'string', description: 'The SINGLE tool that actually applied the final edit (e.g. "insert_after_symbol" or "Edit"). If you tried one tool, it failed, and you fell back to another, name the one that SUCCEEDED.' },
    editApplied: { type: 'boolean', description: 'Whether the requested edit was actually made.' },
    approach: { type: 'string', description: 'One sentence: how you made the edit.' },
  },
  required: ['toolsUsed', 'appliedTool', 'editApplied'],
};

const SYMBOL = new Set(['replace_symbol_body', 'insert_after_symbol', 'insert_before_symbol', 'safe_delete', 'rename']);
const BUILTIN = new Set(['Edit', 'MultiEdit', 'Write']);
const bare = (t) => String(t).replace(/^.*__/, '');
// Score on the tool that APPLIED the edit (honest — a tried-symbol-then-fell-back-to-Edit rollout is builtin);
// fall back to toolsUsed only if appliedTool is missing. Mirrors eval/skillopt/score.mjs (unit-tested).
const classify = (r) => {
  if (r && r.appliedTool) { const t = bare(r.appliedTool); if (SYMBOL.has(t)) return 'symbol'; if (BUILTIN.has(t)) return 'builtin'; }
  const norm = ((r && r.toolsUsed) || []).map(bare);
  if (norm.some((t) => SYMBOL.has(t))) return 'symbol';
  if (norm.some((t) => BUILTIN.has(t))) return 'builtin';
  return 'other';
};

function rolloutPrompt(scn, variant) {
  return [
    'You are in a tool-choice evaluation. Do the edit task for real, then report the tools you used.',
    '',
    'Step 1 — set up an isolated sandbox: create a fresh temp directory, write a minimal `tsconfig.json` ({}) and `package.json` ({}) in it, and write this file:',
    '',
    `FILE: ${scn.file}`,
    '```ts',
    scn.content,
    '```',
    '',
    `Step 2 — perform this edit on ${scn.file} (pass projectPath=<the sandbox dir> to any vs-search tool so it roots there):`,
    scn.task,
    variant.guidance ? `\nGuidance: ${variant.guidance}` : '',
    '',
    'Use whatever tools you judge best — the built-in Edit, or the vs-search symbol-edit tools, your call.',
    'Note: the vs-search MCP server runs on Windows node, so use a Windows-native sandbox path (not an MSYS /tmp path) or its language-server backend can fail to reach the file.',
    'Then report: every edit/search tool you called (toolsUsed), the SINGLE tool that actually APPLIED the final edit (appliedTool — if you fell back, name the one that succeeded), whether the edit was applied, and a one-sentence approach.',
  ].join('\n');
}

phase('Rollout');
// One rollout per scenario×variant. pipeline keeps each independent (no barrier): score a variant's
// rollouts as soon as they finish. Stage 1 = the live edit; stage 2 just tags the result with its keys.
const jobs = [];
for (const v of variants) for (const scn of scenarios) jobs.push({ v, scn });
const rolled = await parallel(jobs.map((j) => () =>
  agent(rolloutPrompt(j.scn, j.v), { label: `roll:${j.v.id}/${j.scn.id}`, phase: 'Rollout', schema: RESULT_SCHEMA })
    .then((res) => ({ variantId: j.v.id, scenarioId: j.scn.id, holdout: j.scn.holdout === true, result: res, klass: classify(res) }))
    .catch(() => ({ variantId: j.v.id, scenarioId: j.scn.id, holdout: j.scn.holdout === true, result: null, klass: 'other' }))
));

phase('Score');
const scoreOf = (rows) => {
  let symbol = 0, builtin = 0, other = 0;
  for (const r of rows) { if (r.klass === 'symbol') symbol++; else if (r.klass === 'builtin') builtin++; else other++; }
  const total = symbol + builtin;
  return { symbol, builtin, other, total, adoption: total ? symbol / total : null };
};
const ok = rolled.filter(Boolean);
const perVariant = {};
for (const v of variants) {
  const mine = ok.filter((r) => r.variantId === v.id);
  perVariant[v.id] = { all: scoreOf(mine), holdout: scoreOf(mine.filter((r) => r.holdout)), train: scoreOf(mine.filter((r) => !r.holdout)) };
}
const baseline = perVariant['baseline'] ? perVariant['baseline'].holdout : null;
const verdicts = variants.filter((v) => v.id !== 'baseline').map((v) => {
  const cand = perVariant[v.id].holdout;
  let accept = false, reason = 'no baseline';
  if (cand.adoption == null) { accept = false; reason = 'candidate produced no scorable edits'; }
  else if (!baseline || baseline.adoption == null) { accept = cand.adoption > 0; reason = 'no baseline — accept any positive signal'; }
  else { const d = cand.adoption - baseline.adoption; accept = d > minDelta; reason = `holdout adoption ${Math.round((baseline.adoption || 0) * 100)}% → ${Math.round(cand.adoption * 100)}% (Δ ${Math.round(d * 100)}pp, need > ${Math.round(minDelta * 100)}pp)`; }
  return { variant: v.id, accept, reason, holdout: cand };
});
const winner = verdicts.filter((x) => x.accept).sort((a, b) => (b.holdout.adoption || 0) - (a.holdout.adoption || 0))[0];
log(`SkillOpt rollout done: baseline holdout adoption ${baseline && baseline.adoption != null ? Math.round(baseline.adoption * 100) + '%' : 'n/a'}; ${verdicts.filter((v) => v.accept).length}/${verdicts.length} candidate(s) beat it.`);
return { perVariant, verdicts, winner: winner ? winner.variant : null, raw: ok };
