# SkillOpt behavioral eval (edit-steer optimization)

The lightweight adoption loop (v0.23.0) MEASURES symbol-edit adoption and RE-INJECTS it as a goal, but it
can't tell you *which wording* of the warn/skill makes an agent actually switch. This harness is the missing
piece — a [SkillOpt](https://github.com/microsoft/SkillOpt)-style **scored rollout**: run editing scenarios
under different skill/warn **variants**, see which tool the agent really picks, and **gate** a reword on a
strict held-out improvement.

## Pieces

| File | Role |
| --- | --- |
| `scenarios.mjs` | Synthetic editing situations where a symbol-edit is the right call (insert / replace), split into train + `holdout`. Synthetic names only. |
| `variants.mjs` | The **trainable artifact** — `baseline` (live behavior) + candidate guidance rewordings. |
| `score.mjs` | Deterministic scorer + **validation gate** (`classifyRollout` / `variantScore` / `gate`). Unit-tested. |
| `selftest.mjs` | CI-gated test of the scorer/gate logic (no live agents). `npm run eval:skillopt`. |
| `rollout.workflow.js` | The live rollout — a Workflow that spawns one sub-agent per scenario×variant, each doing a **real edit** in a sandbox (the hook warn is active) and self-reporting the tools it used. Token-heavy, opt-in. |

## The loop (SkillOpt's rollout → reflection → gate)

1. **Rollout** (opt-in, token-heavy): run `rollout.workflow.js` via the Workflow tool, passing `scenarios`
   and `variants` as `args`. Each sub-agent sets up a TS sandbox, performs the edit, and reports `toolsUsed`.
2. **Score**: adoption = symbol-edits / (symbol-edits + built-in-edits) per variant, on the held-out split.
3. **Gate**: a candidate variant is accepted only if its held-out adoption **strictly beats** the baseline
   (`minDelta`). The winner's guidance is what should fold into the real warn (`editNudgeFor`) / `SKILL.md`.
4. **Reflection**: a human (or a reflection sub-agent reading the scored rollouts) proposes the next
   `variants` entries; repeat.

## Running

Deterministic core (CI):
```bash
node eval/skillopt/selftest.mjs      # scorer + gate
```

Live rollout (opt-in — spawns scenario×variant sub-agents; costs tokens). Build `args` from the fixtures and
invoke the Workflow tool with `eval/skillopt/rollout.workflow.js`. It returns `{ perVariant, verdicts,
winner, raw }` — the winner's wording is the candidate to graft into the live warn/skill.

## First live run (2 scenarios × 2 variants, 4 agents)

A smoke run validated the pipeline end-to-end and taught three things:

- **Ceiling effect.** On clean single-declaration toy scenarios, **baseline already scored 100%** symbol-edit
  adoption — the live plugin (v0.23.0 hook + tools) drives the right choice without extra guidance, so the
  candidate variant couldn't differentiate (Δ 0pp → gate rejects). To get signal, scenarios must sit in the
  regime where baseline adoption is *below* 100% — the real-world miss is on **big files / search-less flows**,
  not toy ones. Widen/harden `scenarios.mjs` before trusting a reword verdict.
- **Score on `appliedTool`, not `toolsUsed`.** One rollout *tried* a symbol-edit, hit a backend spawn
  failure, and fell back to the built-in Edit — `toolsUsed` listed both, which inflated it to "symbol". The
  scorer now classifies on `appliedTool` (the tool that actually made the edit); the smoke surfaced this.
- **Sandbox path + backend reliability are real noise.** The vs-search MCP server runs on Windows node, so an
  MSYS `/tmp` sandbox path broke its backend spawn; the prompt now tells the agent to use a Windows-native
  path. A TS-backend ENOENT in one rollout also forced a fallback. Behavioral eval found live bugs — that's
  the point — but they add variance to a small-N run.

## Honest caveats

- **Fidelity**: scoring is the agent's *self-report* of tools used after a *real* edit (the hook warn does
  fire). It's behavior, not a stated preference — but it trusts the agent's report.
- **Backend dependence**: symbol-edit needs the TS backend to resolve in the sandbox; if it can't, every
  variant scores low and they don't differentiate. The scenarios use plain single-file TS to minimize this.
- **Not CI**: the rollout spawns real agents — too token-heavy and non-deterministic for the CI gate. Only
  the scorer/gate (`selftest.mjs`) runs in CI.
- **Small N**: a few scenarios give a noisy adoption estimate. Treat a single run as directional; average
  several, or widen `scenarios.mjs`, before trusting a reword.
