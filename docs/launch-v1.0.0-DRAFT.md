# vs-token-safer 1.0 — the layer your agent talks to instead of reading the repo

*Draft launch post. Numbers are current as of v0.40.0; the 1.0 tag ships once the maturity criteria at the end are met.*

---

When a coding agent doesn't know where something lives, it does what you'd do at a terminal: it greps, and it pastes what comes back into its own head. On a small repo that's fine. On a 26,000-translation-unit Unreal Engine project, one such hunt cost us **282,000 tokens** of raw source — most of it never read, all of it counted against the context window.

vs-token-safer exists to make that the wrong reflex.

It is not "a code search tool." It is **the layer an agent talks to instead of reading the repository.** You ask where something is, what calls it, or — when you don't even know the name — how the auth flow works, and it hands back the smallest faithful answer it can: a capped `file:line` list, no bodies. On that same Unreal hunt, the indexed path returned the answer in roughly **two thousand tokens** — a 138× cut — and every line of it was semantically correct, not a text-match guess.

Today we're drafting the road to **1.0**.

## Why it exists

Two things were true at once, and they pulled against each other.

Agents are only as good as what's in their context window, and raw source is the most expensive thing you can put there. Grep-and-paste is the default because it needs no setup — but it floods the window with bodies the model mostly throws away, and it answers with text matches, not meaning. Ask grep for "everything that calls `Foo`" and it can't tell a call from a comment from a string literal.

Meanwhile, the tools that *do* understand meaning — the language servers your IDE already runs — were sitting right there, unused by the agent. clangd has indexed your C++. Roslyn has your C#. tsserver and pyright have your JS and Python. They know a reference from a coincidence. They were just never wired to the thing burning the tokens.

So the whole project is one idea: **force code search through the official language server's index, and cap the result to `file:line`.** The engine is theirs — clangd is LLVM's, Roslyn is Microsoft's, tree-sitter is GitHub's. The glue is ours, and it's thin enough to audit.

## What 1.0 actually is

A 1.0 should tell you what's stable and what isn't. Here's the honest version.

**The precision ladder is the whole product.** vs-token-safer answers at the highest precision it can reach, and it tells you which rung it's standing on — so you never mistake a guess for ground truth:

- **EXACT** — when the name is known and a toolchain is present, the language server answers. clangd, Roslyn, tsserver, pyright. Semantic ground truth: a reference is a reference, a rename is safe. All four are live-verified, including clangd against a real 26k-TU Unreal project.
- **SYNTACTIC** — when there's no toolchain, tree-sitter does. Zero setup, ~17 languages with tuned declaration extraction out of 36 bundled grammars, plus a committable `.vts-index/symbols.jsonl` your team can share. It locates declarations; it does *not* resolve overloads or types — that's the LSP's job, so this rung sits below it and says so.
- **FUZZY** — when you only know the *intent* ("how does login work"), a concept dictionary mined from the repo's own naming answers — no embeddings. The repo is its own thesaurus: identifiers and the comments beside them already cluster the things that mean the same thing. We've pushed this further than we expected to with RM3 pseudo-relevance feedback, confidence-gated import-graph proximity, and git co-change neighbors — but we'll say plainly where it ends below.
- **SECTION** — when it's a doc, not code. Markdown, HTML (with real tree-sitter injection into embedded scripts), CSS, TOML, YAML — addressed by heading or selector, so you read or edit *one section* by name instead of the whole file.

Every answer carries one completeness certificate naming its rung. That's the contract: the model always knows whether it got the truth, a syntactic locate, a fuzzy guess, or a doc section — and whether the answer was capped or timed out.

## The three things we won't trade away

These are non-negotiable, and they're why the tool is worth trusting:

1. **Local-only, zero transmission.** Every engine runs over stdio or localhost. Nothing leaves the machine — not a symbol, not a path, not a query. The token-cap means *less* of your source reaches the model than a grep-and-paste would.
2. **Official engines for correctness.** The semantic answers come from clangd / Roslyn / tsserver / pyright. We never reimplement them and never wrap a third-party index over your source. Our code is the glue, and it stays auditable.
3. **Capped `file:line`, no bodies, no embeddings for correctness.** The output is `kind name @ file:line`, capped. Embeddings are never used to decide a reference or a rename. The fuzzy rung is the only place approximation lives, and it's labeled as such.

## What was hard

Most of the work since v0.33 was not adding features. It was making the honest answer fast and the fast answer honest.

- **clangd 19.x deadlocks on Unreal.** The Visual-Studio-bundled clangd parses a real UE translation unit fine with `--check`, then never finishes in LSP-server mode. We isolated it to an upstream 19.1.x bug — standalone clangd 22 parses the same TU in ~13s — and the tool now requires ≥22 and tells you why if it sees older.
- **369 seconds to first answer became 51.** Cold-indexing a monorepo is the thing that makes an agent give up and grep anyway. The fix was to index a *subtree*, not the whole tree (13% of the TUs on a real UE5 project), and to load a static index file instead of waiting for a full background re-validation that workspace-symbol queries don't need. 7.8×.
- **The adoption gap taught us humility.** Symbol-level editing — replace a declaration by *name* instead of reading the whole file to line-count an exact-match edit — is the biggest token win we ship, and almost nobody used it (~4%). We built a behavioral eval harness, spent the better part of a million tokens proving that *nicer wording does not move the number* (it has a ceiling; the lever was already in the harness at Δ0pp), and finally measured the real leak: the tokens are sunk in a whole-file Read *before* the edit, and 94% of those reads had no prior search to steer from. So the live work isn't persuasion — it's intervening at the Read, where there's always a target.

That last one is the most important thing we learned, and it's why some of the road to 1.0 is calendar time, not code.

## Where it ends — honestly

A 1.0 that hides its limits isn't a 1.0.

- **Fuzzy is not magic, and it is not embeddings.** The name-and-comment channels are reliable; co-occurrence recovers domain synonyms when the vocabulary clusters; but a pure synonym with no lexical bridge anywhere in the repo genuinely needs an embedding model, and we don't ship one. We chose inspectable-and-deterministic over a few more points of recall. If that's the wrong trade for you, this is the rung to watch.
- **Symbol-edit adoption is measured, not solved.** The instrumentation is live; the validation is a six-month question on real sessions, not a benchmark we can pass today.
- **One ABI bump is parked.** The tree-sitter runtime's 0.26 release changed the grammar-load API; we've held it deliberately rather than ship a breaking dependency, and it's the first thing on the post-1.0 list.

## Thanks

The hard parts of this tool aren't ours. clangd is LLVM's, Roslyn is Microsoft's, tree-sitter is GitHub's, and the language-server protocol is what let four very different engines hide behind one small interface. Our job was to wire them to the thing that was wasting tokens and then get out of the way. "Engine = official, glue = ours" has been the rule since day one, and it's why we can promise the other two — local-only and capped — without asking you to trust much code.

## What 1.0 means, and what comes after

We're tagging 1.0 when:

- all four backends are production-proven (clangd, Roslyn, tsserver, pyright — done),
- the enforcement path is hardened (the grep→index swap is *blocked and rewritten*, not merely suggested — the one thing no competitor does),
- the fuzzy rung is empirically competitive (RM3 + confidence-gating + co-change, measured against the embedding tools), and
- the adoption measurement has stabilized over real-session data rather than a clean-room rollout.

Three of those four are true now, at v0.40.0, behind more than ninety charter-safe eval guards. The fourth is the honest reason 1.0 has a date and not just a diff.

The roadmap rule never changes: a feature earns its place only by adding a rung to the precision ladder or covering more of the repo — and never by breaking the three promises. Judge anything we ship next by "which rung, which surface, does it keep the discipline" before anything else.

That's the layer. Ask it where something is. Stop pasting your repo into the window.

---

*vs-token-safer is local-only and transmits nothing. Install as an MCP server + CLI (`vts`). C/C++, C#, JS/TS, Python today; the naming umbrella is deliberate — "token-safer" is a safety device for the context budget, and it will grow past these four.*
