# Contributing

Thanks for your interest! Issues and PRs are welcome — bug fixes, new language backends, additional
LSP capabilities, performance, and docs.

## How this project is maintained

This repository is maintained with **AI (Claude Code) assistance**. The maintainer does **not** do a
deep line-by-line manual read of every PR — review is AI-assisted, with a human giving final approval.

That changes what makes a PR mergeable. A PR is reviewed primarily from its **diff + description +
evidence**, so the clearer and more self-contained it is, the faster it merges. Opaque, sprawling, or
unverifiable PRs may be slow or declined.

## What makes a PR merge fast

1. **Open an issue first** for anything non-trivial, so the approach is agreed before you build.
2. **Keep it small and single-purpose.** One concern per PR. No drive-by refactors or unrelated
   reformatting mixed in — they make AI review unreliable.
3. **Describe it clearly** (use the PR template): *what* changed, *why*, *how you verified it*, and the
   *risk / blast radius*. Assume the reviewer will not run your branch — make correctness checkable from
   the description.
4. **Include evidence.** Paste test output (`node eval/run.mjs` → `EVAL PASSED`), a repro, or
   before/after token numbers. New behavior should come with a way to confirm it.
5. **Keep the token win.** Output must stay a capped `file:line` list (no source bodies). Any new code
   path needs an **eval guard** in `eval/run.mjs` that asserts the token reduction and shape.
6. **Update docs in the same PR.** README / README.ko config tables and command/tool lists. Bump the
   plugin `version` if the change must reach installed clients.
7. **No proprietary data or secrets** — anywhere, **including commit messages**. No real file paths,
   class/symbol names, company/project identifiers, tokens, or source contents. Use synthetic
   placeholders and aggregate numbers. PRs containing such data will be closed and may need history
   scrubbing.
8. **Keep it generic and reusable.** This is a public, general-purpose plugin — nothing tied to one
   company or project. Keep the server dependency-light and preserve the token-efficiency goals.
9. **Match the existing style** and conventions you see in nearby code.

## Local checks before you push

Install dev tooling once at the repo root (`npm install`), then:

- `npm test` — runs the eval gate (`node eval/run.mjs`, mock LSP — no toolchain needed).
- `npm run lint` — ESLint over the whole repo (CI runs this too).
- `npm run format` — Prettier (optional; CI does not gate on formatting).
- `node --check` your changed `.js`/`.mjs` files; `claude plugin validate .` for manifest changes.
- For server changes: `cd server && npm install`, then start the MCP server and confirm it lists tools
  (see the README "Development" section).
- Scan your diff **and** commit messages for any internal names before pushing.

CI (`.github/workflows/test.yml`) runs the eval on **Windows + Linux** across **Node 18/20/22**, lints,
and validates the plugin manifests — so a cross-platform issue (like a Windows-only path bug) fails the
matrix, not your users.

## Releasing (maintainer)

The version lives in several files (`.claude-plugin/plugin.json`, the marketplace entry, and
`server/package.json`). Keep them in sync with the bumper instead of editing by hand:

```bash
node scripts/bump.mjs <major|minor|patch>   # --dry-run to preview, --tag to create the tag
```

It rewrites every version location, then prints the tag to push. Pushing a `v*` tag on `main`
triggers the GitHub Release **and** (idempotently) the npm publish workflow (needs an `NPM_TOKEN`
repo secret; skips if that version is already on npm).

## Review and merge

- Be responsive to review comments; small follow-up commits are fine.
- Final approval and merge are the maintainer's call. Merges are squash-merged; please keep your branch
  focused so the squashed history stays clean.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE). See also
the [Privacy Policy](PRIVACY.md) — this plugin collects no user data.
