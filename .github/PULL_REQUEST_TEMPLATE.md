<!--
This repo is maintained with AI-assisted review (see CONTRIBUTING.md). Your PR is judged from the
diff + this description + your evidence — so please fill every section. Small, focused, well-evidenced
PRs merge fast.
-->

## Summary
<!-- What does this change? One focused thing. -->

## Why
<!-- The problem it solves / motivation. Link the issue: Closes #__ -->
Closes #

## How verified
<!-- REQUIRED. Paste test output / repro steps / before-after numbers. Assume the reviewer won't run your branch. e.g. `node eval/run.mjs` → EVAL PASSED. -->

## Risk / blast radius
<!-- What could this break? Anything reviewers should check carefully? -->

## Checklist
- [ ] Single, focused change (no unrelated refactors)
- [ ] `node eval/run.mjs` prints EVAL PASSED, and an eval guard was added for any new path
- [ ] Token win kept or raised (output stays `file:line`, capped, no source bodies)
- [ ] Docs updated in this PR (README / README.ko config tables, command/tool lists)
- [ ] Version bumped if the change must reach installed clients (`node scripts/bump.mjs <level>`)
- [ ] **No proprietary data or secrets** — incl. commit messages (no real paths, class/symbol names, company/project identifiers, tokens, or source contents)
- [ ] Generic / reusable (nothing tied to one company or project)
- [ ] `node --check` passes on changed JS; `claude plugin validate` clean
