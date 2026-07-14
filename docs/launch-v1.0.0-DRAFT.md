# vs-token-safer 1.0 — the layer your agent talks to instead of reading the repo

*Release notes for the 1.0 tag. Numbers are current as of v0.42.27.*

---

When a coding agent doesn't know where something lives, it does what you'd do at a terminal: it greps, and it pastes what comes back into its own head. On a small repo that's fine. On a 26,000-translation-unit Unreal Engine project, one such hunt cost us **282,000 tokens** of raw source — most of it never read, all of it counted against the context window.

vs-token-safer exists to make that the wrong reflex — and, at 1.0, to make it a reflex the agent can no longer act on by accident.

It is not "a code search tool." It is **the layer an agent talks to instead of reading the repository.** You ask where something is, what calls it, or — when you don't even know the name — how the auth flow works, and it hands back the smallest faithful answer it can: a capped `file:line` list, no bodies. On that same Unreal hunt, the indexed path returned the answer in roughly **two thousand tokens** — a 138× cut — and every line of it was semantically correct, not a text-match guess.

## Why it exists

Two things were true at once, and they pulled against each other.

Agents are only as good as what's in their context window, and raw source is the most expensive thing you can put there. Grep-and-paste is the default because it needs no setup — but it floods the window with bodies the model mostly throws away, and it answers with text matches, not meaning. Ask grep for "everything that calls `Foo`" and it can't tell a call from a comment from a string literal.

Meanwhile, the tools that *do* understand meaning — the language servers your IDE already runs — were sitting right there, unused by the agent. clangd has indexed your C++. Roslyn has your C#. tsserver and pyright have your JS and Python. They know a reference from a coincidence. They were just never wired to the thing burning the tokens.

So the whole project is one idea: **force code search through the official language server's index, and cap the result to `file:line`.** The engine is theirs — clangd is LLVM's, Roslyn is Microsoft's, tree-sitter is GitHub's. The glue is ours, and it's thin enough to audit.

## What's new since the road-to-1.0 draft

The draft (v0.40.0) called out one gate as unmet: enforcement was still *advisory* — the tool suggested the indexed query but let the grep run. **1.0 closes that gate.** The hook no longer just warns; it acts, across four tool surfaces:

- **Bash** grep / rg / `find -name` over source → **rewritten to the equivalent `vts` query in place** (identifier → `search_symbol`, literal → `search_text`, `find <dir> -name` → `find_files` rooted at `<dir>`). The search still runs; the flow never breaks. Ambiguous cases (a pipeline, multi-`-name`) block instead.
- **Read-only body dumps** — `sed -n` / `cat` / `head` / `tail` / `awk` on a code file, and interpreter one-liners that hand-roll a read (`python`/`node`/`perl`/`ruby -c`/`-e`) → **steered to `read_symbol`**, the read that was leaking tokens *before* the edit even started.
- **Grep / Glob tools** → a symbol hunt or a concrete code-file glob (`*.cpp`, `Foo.h`) is **blocked** with a ready-to-run indexed call.
- **Crawl-risk trees** (a UE/monorepo where clangd can't answer fast) → `read_symbol` / `find_references` / `document_symbols` / the symbol-edit tools **pre-empt to a committed tree-sitter index** instead of hanging or falling back to a text walk (#201, #205–209).

That last group is why 1.0 is honest about big repos: a no-index tree now answers *fast* off `.vts-index/symbols.jsonl` and hands you a `vts_index` build hint, instead of timing out and letting the agent give up and grep.

## What 1.0 actually is

A 1.0 should tell you what's stable and what isn't. Here's the honest version.

**The precision ladder is the whole product.** vs-token-safer answers at the highest precision it can reach, and it tells you which rung it's standing on — so you never mistake a guess for ground truth:

- **EXACT** — when the name is known and a toolchain is present, the language server answers. clangd, Roslyn, tsserver, pyright. Semantic ground truth: a reference is a reference, a rename is safe. All four are live-verified, including clangd against a real 26k-TU Unreal project.
- **SYNTACTIC** — when there's no toolchain, tree-sitter does. Zero setup, ~17 languages with tuned declaration extraction out of 36 bundled grammars, plus a committable `.vts-index/symbols.jsonl` your team can share. It locates declarations; it does *not* resolve overloads or types — that's the LSP's job, so this rung sits below it and says so.
- **FUZZY** — when you only know the *intent* ("how does login work"), a concept dictionary mined from the repo's own naming answers — no embeddings. The repo is its own thesaurus: identifiers and the comments beside them already cluster the things that mean the same thing. We've pushed this further than we expected with RM3 pseudo-relevance feedback, confidence-gated import-graph proximity, and git co-change neighbors — but we'll say plainly where it ends below.
- **SECTION** — when it's a doc, not code. Markdown, HTML (with real tree-sitter injection into embedded scripts), CSS, TOML, YAML — addressed by heading or selector, so you read or edit *one section* by name instead of the whole file.

The rungs aren't a one-time pick — they **connect**. Start on FUZZY when you only know the intent; the moment `concept_search` surfaces a real name, vts climbs to EXACT to confirm it against the semantic index, and an exact search that misses drops back to FUZZY. Every answer carries one completeness certificate naming its rung — the model always knows whether it got the truth, a syntactic locate, a fuzzy guess, or a doc section, and whether the answer was capped or timed out.

## The three things we won't trade away

These are non-negotiable, and they're why the tool is worth trusting:

1. **Local-only, zero transmission.** Every engine runs over stdio or localhost. Nothing leaves the machine — not a symbol, not a path, not a query. The token-cap means *less* of your source reaches the model than a grep-and-paste would.
2. **Official engines for correctness.** The semantic answers come from clangd / Roslyn / tsserver / pyright. We never reimplement them and never wrap a third-party index over your source. Our code is the glue, and it stays auditable.
3. **Capped `file:line`, no bodies, no embeddings for correctness.** The output is `kind name @ file:line`, capped. Embeddings are never used to decide a reference or a rename. The fuzzy rung is the only place approximation lives, and it's labeled as such.

## What was hard

Most of the work to 1.0 was not adding features. It was making the honest answer fast and the fast answer honest.

- **clangd 19.x deadlocks on Unreal.** The Visual-Studio-bundled clangd parses a real UE translation unit fine with `--check`, then never finishes in LSP-server mode. We isolated it to an upstream 19.1.x bug — standalone clangd 22 parses the same TU in ~13s — and the tool now requires ≥22 and tells you why if it sees older.
- **369 seconds to first answer became 51.** Cold-indexing a monorepo is the thing that makes an agent give up and grep anyway. The fix was to index a *subtree*, not the whole tree (13% of the TUs on a real UE5 project), and to load a static index file instead of waiting for a full background re-validation that workspace-symbol queries don't need. 7.8×.
- **Enforcement had to survive a real tree without lying.** Rewriting grep in place is easy until the tree is 747k binary Unreal assets, or the "symbol" is a macro-generated name no index holds, or clangd hangs mid-parse. 1.0's enforcement skips Unreal `Content/`, pre-empts crawl-risk trees to the committed index, and — crucially — *reverts a rewrite when it can't produce a faithful answer* rather than shipping a wrong one. The escalation is deliberately conservative: block only where the indexed call is unambiguous; warn everywhere else.
- **The adoption gap taught us humility.** Symbol-level editing — replace a declaration by *name* instead of reading the whole file to line-count an exact-match edit — is the biggest token win we ship, and almost nobody used it (~2%). We built a behavioral eval harness, spent the better part of a million tokens proving that *nicer wording does not move the number*, and finally measured the real leak: the tokens are sunk in a whole-file Read *before* the edit, and most of those reads had no prior search to steer from. So the live work isn't persuasion — it's intervening at the Read, where there's always a target. That intervention shipped in 1.0; whether it moves adoption is the measurement below.

## Where it ends — honestly

A 1.0 that hides its limits isn't a 1.0.

- **Fuzzy is not magic, and it is not embeddings.** The name-and-comment channels are reliable; co-occurrence recovers domain synonyms when the vocabulary clusters; but a pure synonym with no lexical bridge anywhere in the repo genuinely needs an embedding model, and we don't ship one. We chose inspectable-and-deterministic over a few more points of recall.
- **Enforcement is block-where-safe, warn-elsewhere by design.** The rewrite and the crawl-risk pre-emption are live; the hard *block* is scoped to the cases where the indexed call is unambiguous. On symbol-level editing it is still warn-only, escalating on repeated ignores — a deliberate choice to never break an edit the agent genuinely needs. Tightening that ratchet is a post-1.0, data-driven call, not a flag we flip on tag day.
- **Symbol-edit adoption is measured, not solved.** The instrumentation is live and the read-side intervention shipped; the payoff is a question for real-session data over the coming months, not a benchmark we can pass today. This is the one 1.0 criterion we're calling *measured-and-in-progress* rather than *closed*.
- **One ABI bump is parked.** The tree-sitter runtime's 0.26 release changed the grammar-load API; we've held it deliberately rather than ship a breaking dependency, and it's near the top of the post-1.0 list. (Relatedly: `typescript` stays pinned at `^6` — TS 7's native port drops the `tsserver.js` that `typescript-language-server` spawns.)

## What 1.0 means, and what comes after

We tag 1.0 with:

- all four backends production-proven (clangd, Roslyn, tsserver, pyright) — **done**,
- the enforcement path hardened (the grep→index swap is *blocked and rewritten*, not merely suggested — the one thing no competitor does) — **shipped**,
- the fuzzy rung empirically competitive (RM3 + confidence-gating + co-change, measured against the embedding tools) — **shipped, measured**,
- the adoption measurement live over real-session data — **instrumented; the read-side intervention shipped, the six-month number is still accruing.**

Three are closed; the fourth is instrumented and honest. That's the trade 1.0 makes: we ship the enforcement and the measurement rather than wait on a number that only real usage can produce.

The roadmap rule never changes: a feature earns its place only by adding a rung to the precision ladder or covering more of the repo — and never by breaking the three promises. Judge anything we ship next by "which rung, which surface, does it keep the discipline" before anything else.

That's the layer. Ask it where something is. Stop pasting your repo into the window.

---

*vs-token-safer is local-only and transmits nothing. Install as an MCP server + CLI (`vts`). C/C++, C#, JS/TS, Python today; the naming umbrella is deliberate — "token-safer" is a safety device for the context budget, and it will grow past these four.*
