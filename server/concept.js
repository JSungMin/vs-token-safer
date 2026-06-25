// concept.js — FUZZY code retrieval WITHOUT embeddings.
//
// THE PROBLEM (raised in correspondence with the Code Context Engine authors): a language server is superb
// at "where is X" but weak at "how does the auth flow work" when the developer cannot name X. The dominant
// answer is a pretrained embedding model + vector search — which breaks our charter (it transmits, or ships a
// model, and retrieves the nearest vector, not the right one).
//
// THE IDEA (approach "B"): the repository is its own thesaurus. Identifiers and the comments next to them are
// a distributional signal already present in the source — `authenticateUser`, a comment "begin the login
// flow", a nearby `session` field. Tokens that NAME THE SAME THING co-occur. So we mine a CONCEPT DICTIONARY
// from the code's own naming: a local, deterministic, inspectable co-occurrence model (symbolic, not a dense
// vector). A fuzzy query is tokenised, expanded through this local dictionary (auth -> login, session, token),
// and the expanded token set scores symbols. Structural expansion along the official call graph then turns a
// seed into the actual flow. Nothing is transmitted; no model is shipped; output stays token-capped file:line.
//
// This module is the engine: tokenisation (A), the co-occurrence model + query expansion (B), and scoring (E).
// It is PURE (no fs, no LSP) so it is trivially testable and deterministic.

// Minimal stop-list: NL fillers + ultra-generic code tokens that carry no concept signal. Deliberately small —
// over-stopping (e.g. dropping "get"/"set") would erase real API vocabulary; we only drop noise.
const STOP = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "and",
  "or",
  "in",
  "on",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "with",
  "as",
  "at",
  "by",
  "from",
  "if",
  "else",
  "then",
  "not",
  "no",
  "yes",
  "true",
  "false",
  "null",
  "tmp",
  "temp",
  "val",
  "obj",
  "foo",
  "bar",
  "baz",
  "qux",
  "data",
  "item",
  "items",
  "value",
  "values",
  "self",
  "cls",
  "args",
  "kwargs",
  "ctx",
  "ptr",
  "ref",
  "idx",
  "len",
  "num",
  "str",
  "arr",
  "buf",
]);

// Split one identifier into lowercased sub-tokens across snake_/kebab-/dot boundaries AND camelCase /
// PascalCase / digit boundaries. "authenticateUser" -> [authenticate, user]; "HTTPServer2" -> [http, server, 2];
// "auth_flow" -> [auth, flow]. Length-1 and pure-stop tokens are dropped.
export function splitIdent(name) {
  const out = [];
  for (const piece of String(name).split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue;
    // camel / acronym / digit boundaries
    const parts = piece
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2")
      .split(/\s+/);
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t)) out.push(t); // drop length-1, stop-words, pure digits
    }
  }
  return out;
}

// Tokenise arbitrary text (a comment, a docstring, a natural-language query) into concept tokens. Splits on
// non-word runs first, then identifier-splits each word, so "How does the auth flow work?" -> [how, does, auth,
// flow, work] -> (stop-filtered) [does, auth, flow, work].
export function tokenize(text) {
  const out = [];
  for (const w of String(text).split(/[^A-Za-z0-9_]+/)) {
    if (w) for (const t of splitIdent(w)) out.push(t);
  }
  return out;
}

// Extract the IMPORT targets of a file as lowercased basenames (no path, no extension): the last path segment
// of each import/require/#include/from specifier. PURE (text → names). The caller matches these basenames
// against the corpus's own files to build a within-repo import graph — two files that import each other hold
// structurally related code even when their names share no token. Covers JS/TS, Python, and C/C++; other
// languages simply yield no edges (the boost then does nothing — graceful).
export function importSpecifiers(text, ext) {
  const out = new Set();
  const add = (s) => {
    if (!s) return;
    const leaf =
      String(s)
        .replace(/^[./\\]+/, "")
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() || "";
    if (!leaf) return;
    // a relative file path keeps its name minus extension (scope.js -> scope); a dotted module keeps its last
    // segment (a.b.c -> c). Offer both — only basenames that actually match a corpus file create an edge.
    const noext = leaf.replace(/\.[^./]+$/, "");
    const lastDot = leaf.split(".").filter(Boolean).pop();
    for (const cand of [noext, lastDot]) if (cand && /[A-Za-z_]/.test(cand)) out.add(cand.toLowerCase());
  };
  const e = String(ext || "").toLowerCase();
  if (/^[mc]?[jt]sx?$/.test(e)) {
    for (const m of String(text).matchAll(
      /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport)\s*["'`]([^"'`]+)["'`]/g,
    ))
      add(m[1]);
  } else if (e === "py" || e === "pyi") {
    for (const m of String(text).matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm))
      add(m[1] || m[2]);
  } else if (/^(c|h|cc|cpp|hpp|hh|cxx|hxx|inl|ipp|tpp)$/.test(e)) {
    for (const m of String(text).matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)) add(m[1]);
  }
  return [...out];
}

// Match two concept tokens: exact (1.0) or a prefix relationship of length >= 4 (0.7) so auth ~ authenticate ~
// authentication ~ authorize without a stemmer. Returns the match strength, 0 if unrelated.
export function tokMatch(a, b) {
  if (a === b) return 1;
  const m = Math.min(a.length, b.length);
  if (m >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.7;
  return 0;
}

// Last segment of a qualified name ("ns::Foo::bar" / "a.b.c" / "a/b" -> the tail). Local helper for the
// symbol-name matcher below.
function tailSeg(name) {
  const m = String(name).split(/::|\.|\//);
  return m[m.length - 1] || String(name);
}

// SYMBOL-NAME match score (the LocAgent migration, arXiv:2503.09089 — sparse token matching instead of a flat
// literal substring). The syntactic tiers (committed symindex + live tree-sitter) used to score a name by
// `name.includes(q)`, so a MULTI-WORD query ("warm cap") matched NOTHING because the literal string never
// appears in `warmCap`. This scores by TOKEN COVERAGE: split both the name and the query into sub-tokens and
// sum the best per-query-token match (exact 1.0 / prefix 0.7 via tokMatch) — so "warm cap" now finds warmCap,
// ranked above a name that covers only one of the two words. Charter-pure (token coverage = the BM25 numerator;
// idf weighting is a deferred refinement), deterministic, no embeddings.
//   - exact full-name or tail-segment match (case-insensitive) wins outright (3).
//   - else token coverage in (1, 2]: 1 + (covered query weight / #query tokens) — full coverage -> 2.
//   - else a single-token literal substring still matches at 0.5 (back-compat: "ooBa" finds "FooBar").
// `qTokens` is the query pre-split (splitIdent), passed once per search; `qRaw` is the raw query for the exact
// and substring checks. `coverMin` (default 1.0 = AND) is the multi-word coverage FRACTION a name must reach:
// 1.0 = every query token covered (precise — the default); a lower value (e.g. 0.6) admits PARTIAL coverage,
// used by the caller ONLY as a zero-result fallback (when the strict AND pass found nothing) so recall rises
// without the precise pass ever surfacing a partial near-miss.
export function symbolMatchScore(name, qTokens, qRaw, coverMin = 1) {
  const ln = String(name).toLowerCase();
  const raw = String(qRaw == null ? qTokens.join("") : qRaw);
  const lq = raw.toLowerCase();
  if (ln === lq || tailSeg(name).toLowerCase() === lq) return 3; // exact full / tail name
  // TOKEN COVERAGE only for a genuine MULTI-WORD query (whitespace) — a single CamelCase identifier
  // ("buildWidgetTree") must NOT explode into every token-neighbour, so it keeps the precise substring path.
  // Coverage semantics: a name must cover at least `coverMin` of the query tokens ("warm cap" finds warmCap;
  // at coverMin 1 a name sharing only "warm" is rejected), ranked by coverage strength.
  if (qTokens.length >= 2 && /\s/.test(raw)) {
    const nt = splitIdent(name);
    let cov = 0,
      matched = 0;
    for (const qt of qTokens) {
      let best = 0;
      for (const t of nt) {
        const m = tokMatch(qt, t);
        if (m > best) best = m;
      }
      if (best > 0) matched++;
      cov += best;
    }
    return matched / qTokens.length >= coverMin ? 1 + cov / qTokens.length : 0;
  }
  if (lq && ln.includes(lq)) return 1; // single-word substring ("Foo" finds "FooBar", "ns::FooBar")
  return 0;
}

// Build the concept model from UNITS. Each unit is a token bag for one declaration: its name sub-tokens plus
// the sub-tokens of the comment/docstring attached to it. Co-occurrence is computed WITHIN a unit (a tight,
// bounded scope — a decl + its own doc), which is exactly the "these words name the same thing" signal and
// keeps the pair count O(tokens-per-decl^2), not O(tokens-per-file^2).
// Returns { N, df: Map<tok,count>, cooc: Map<tok, Map<tok,count>> }.
//
// `maxUnitTokens` is the key noise control: a long file/section header comment that happens to sit above the
// first declaration is NOT that declaration's docstring — left unbounded it makes a giant unit where dozens of
// unrelated words co-occur, polluting the dictionary. Capping a unit (name tokens first, then doc) keeps the
// co-occurrence signal to the tight name+docstring scope it is meant to model.
export function buildConceptModel(units, { maxUnitTokens = 14 } = {}) {
  const df = new Map();
  const cooc = new Map();
  let N = 0;
  for (const raw of units) {
    const toks = [...new Set(raw)].filter(Boolean).slice(0, maxUnitTokens); // dedupe + cap (name tokens lead)
    if (!toks.length) continue;
    N++;
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        bump(cooc, toks[i], toks[j]);
        bump(cooc, toks[j], toks[i]);
      }
    }
  }
  return { N, df, cooc };
}
function bump(cooc, a, b) {
  let m = cooc.get(a);
  if (!m) {
    m = new Map();
    cooc.set(a, m);
  }
  m.set(b, (m.get(b) || 0) + 1);
}

// Association strength between two tokens — a PMI-flavoured score: how much more often a and b co-occur than
// chance, given their individual frequencies. assoc = cooc(a,b) * N / (df(a) * df(b)). Higher = more related.
export function assoc(model, a, b) {
  const m = model.cooc.get(a);
  if (!m) return 0;
  const c = m.get(b) || 0;
  if (!c) return 0;
  const da = model.df.get(a) || 1,
    dbb = model.df.get(b) || 1;
  return (c * model.N) / (da * dbb);
}

// Inverse document frequency for a token — rare tokens carry more concept weight than ubiquitous ones.
export function idf(model, t) {
  const d = model.df.get(t) || 0;
  return Math.log((model.N + 1) / (d + 1)) + 1;
}

// Expand a query's tokens through the local concept dictionary. Returns a Map<token, weight>: the query's own
// tokens at weight 1, plus up to `k` neighbours per query token weighted by a saturating function of their
// association (capped below 1 so an expanded term never outranks an exact one). minAssoc filters weak links.
// `synonyms` (optional Map<token, string[]>, from parseSynonyms over a committable .vts-index/concept-
// synonyms.json) is the critic-approved charter-pure adaptation path: a human-curated, version-controlled,
// inspectable expansion with NO drift (vs a self-learning click loop). A curated synonym is injected JUST
// BELOW an exact match (0.95) and above any mined co-occurrence neighbour, so a hand-declared bridge
// (auth → login/session) reliably beats the noisy mined ones without ever outranking a literal hit.
// `maxDfRatio` (0 = off) is the CROSS-CUTTING-GENERIC gate. A token present in a large fraction of all
// declarations (a "manager", "data", "handle" that names nothing in particular) carries no discriminative
// concept signal, yet it can still clear the PMI bar against a moderately-common neighbour — and its
// expansion is exactly the documented noise on cross-cutting queries. So when the corpus is large enough to
// make a frequency estimate meaningful (N >= 20), we refuse to expand THROUGH such a token and refuse to
// expand INTO one. It is still scored directly (its idf is already low, so it barely moves the rank); we
// only suppress the noisy second-order neighbours it would otherwise pull in. Deterministic and inspectable
// — a frequency threshold mined from the repo itself, not a learned cutoff. (A maximally ubiquitous token,
// df == N, can never reach assoc >= minAssoc anyway; this gate catches the MODERATELY common middle band the
// PMI test alone lets through.)
export function expandQuery(model, qTokens, { k = 6, minAssoc = 1.5, minCooc = 2, neighborMax = 0.85, synonyms = null, maxDfRatio = 0 } = {}) {
  const weights = new Map();
  for (const t of qTokens) weights.set(t, 1);
  if (synonyms) {
    for (const t of qTokens) {
      const ex = synonyms.get(t);
      if (ex) for (const s of ex) { const st = String(s).toLowerCase(); if ((weights.get(st) || 0) < 0.95) weights.set(st, 0.95); }
    }
  }
  const dfCap = maxDfRatio > 0 && model.N >= 20 ? maxDfRatio * model.N : Infinity;
  for (const t of qTokens) {
    // a ubiquitous query token's co-occurrence neighbours are cross-cutting noise — don't expand THROUGH it
    // (it's still scored directly, damped by its own low idf).
    if ((model.df.get(t) || 0) > dfCap) continue;
    const m = model.cooc.get(t);
    if (!m) continue;
    const scored = [];
    for (const [n, c] of m) {
      if (weights.has(n)) continue;
      // a real synonym RECURS — gate on raw co-occurrence count (kills single-shot noise from a shared comment)
      // AND on a neighbour seen in at least two declarations, before the association (PMI) threshold; and never
      // expand INTO a cross-cutting-generic neighbour (df above the ratio cap).
      if (c < minCooc || (model.df.get(n) || 0) < 2 || (model.df.get(n) || 0) > dfCap) continue;
      const a = assoc(model, t, n);
      if (a >= minAssoc) scored.push([n, a]);
    }
    scored.sort((x, y) => y[1] - x[1]);
    for (const [n, a] of scored.slice(0, k)) {
      // saturating: weight rises with association but never reaches an exact-match's 1.0
      const w = Math.min(neighborMax, 1 - 1 / (1 + Math.log(1 + a)));
      if ((weights.get(n) || 0) < w) weights.set(n, w);
    }
  }
  return weights;
}

// LARGER-style confidence gate (migrated from "Lexically Anchored Repository Graph Exploration and Retrieval",
// arXiv:2605.16352): the import-graph (structural) neighbourhood should be expanded only from HIGH-CONFIDENCE
// lexical anchors — a weak base match must not drag its import-neighbours up the ranking. A neighbour file's
// base score qualifies as an anchor iff it clears `ratio` of the strongest intrinsic match in the result set.
// ratio<=0 disables the gate (any matched neighbour expands, the pre-migration behaviour). Pure + deterministic.
export function anchorConfident(neighbourBase, topBase, ratio = 0.5) {
  if (!(ratio > 0)) return neighbourBase > 0;
  return neighbourBase >= topBase * ratio;
}

// RM3-style pseudo-relevance feedback (Lavrenko & Croft 2001; re-validated for the LLM era in arXiv:2603.11008):
// the embedding-free way to bridge a synonym the query can't reach lexically. Run a first retrieval, then mine
// expansion terms from the VOCABULARY of the top-ranked results THEMSELVES — "login" retrieves the auth module,
// whose declarations contain "authenticate", which is then folded back so a second pass surfaces it.
//   topBags: the token bags (name + comment subtokens) of the top-k pass-1 declarations. Returns [[term, weight]]
//   for terms present in >= minDocs of those decls (consensus drift-guard), excluding the original query tokens,
//   ranked by feedback-frequency x idf (so a ubiquitous token can't hijack the feedback), capped to `terms`.
//   Pure, deterministic, no embeddings, no transmission — it only reweights tokens already mined from the repo.
export function prfTerms(model, topBags, queryTokens, { terms = 5, minDocs = 2, weight = 0.5 } = {}) {
  const q = new Set(queryTokens);
  const df = new Map();
  for (const bag of topBags) {
    const seen = new Set();
    for (const t of bag) {
      if (!t || q.has(t) || seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return [...df.entries()]
    .filter(([, d]) => d >= minDocs)
    .map(([t, d]) => [t, d * idf(model, t)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, terms)
    .map(([t]) => [t, weight]);
}

// Score one symbol against the expanded query across three channels, strongest first: the symbol NAME, the
// file PATH it lives in, and its attached comment/docstring. Related code clusters by directory and filename
// (an auth helper lives under `auth/` in a `session.ts`), so a query token that matches the path is real,
// free, local evidence — weaker than a name hit, comparable to a comment hit. Each enriched query token
// contributes its weight x best token-match x idf per channel (path/doc at a discount). idf already damps
// ubiquitous tokens, so no length normalisation is needed.
//
// `negatives` (LogicalRAG-style boolean NEGATION, arXiv:2605.27123 — charter-pure: the exclusion only reranks
// the repo's OWN mined tokens, transmits nothing, ships no model) PENALISES a symbol that matches an excluded
// concept: a decl mentioning a `negatives` token (across the same three channels) is demoted by idf x match x
// negFactor, so "auth -test" pushes the test doubles below the real flow. The penalty can drive a score < 0,
// which the caller's `base > 0` filter then drops entirely — a hard exclusion for a strong match, a soft demote
// for a weak one. Deterministic; negFactor<=0 disables.
export function scoreSymbol(
  model,
  enriched,
  symTokens,
  docTokens = [],
  { docFactor = 0.5, pathTokens = [], pathFactor = 0.4, negatives = [], negFactor = 0.6 } = {},
) {
  const bestMatch = (qt, toks) => {
    let best = 0;
    for (const t of toks) {
      const m = tokMatch(qt, t);
      if (m > best) best = m;
    }
    return best;
  };
  let score = 0;
  for (const [qt, w] of enriched) {
    const weight = w * idf(model, qt);
    const nameHit = bestMatch(qt, symTokens);
    if (nameHit) score += weight * nameHit;
    if (pathFactor && pathTokens.length) {
      const ph = bestMatch(qt, pathTokens);
      if (ph) score += weight * ph * pathFactor;
    }
    if (docFactor && docTokens.length) {
      const dh = bestMatch(qt, docTokens);
      if (dh) score += weight * dh * docFactor;
    }
  }
  if (negFactor > 0 && negatives.length) {
    for (const nt of negatives) {
      // an excluded term hits the strongest of the three channels (name full-weight, path/doc discounted to
      // match the positive scale), penalised by its idf so a rare excluded term bites harder than a generic one.
      let pen = bestMatch(nt, symTokens);
      if (pathFactor && pathTokens.length) pen = Math.max(pen, bestMatch(nt, pathTokens) * pathFactor);
      if (docFactor && docTokens.length) pen = Math.max(pen, bestMatch(nt, docTokens) * docFactor);
      if (pen) score -= idf(model, nt) * pen * negFactor;
    }
  }
  return score;
}

// Split a concept query into its POSITIVE text and its NEGATIVE (excluded) concept tokens. An exclusion is a
// `-term`, a `-"quoted phrase"`, or a standalone `NOT term` (case-insensitive, word-boundary) — the LogicalRAG
// boolean-negation interface (arXiv:2605.27123), kept charter-pure (it only reweights the repo's own mined
// tokens). A dash WITHOUT a leading boundary is left alone, so a hyphenated query word ("auth-flow") is never
// mistaken for an exclusion. Returns { positive: string, negatives: string[] } (negatives de-duped, identifier-
// split + stop-filtered the same way names are). Pure.
export function parseConceptQuery(q) {
  const negParts = [];
  let s = String(q);
  s = s.replace(/(^|\s)-"([^"]+)"/g, (_, p, ph) => {
    negParts.push(ph);
    return p;
  });
  s = s.replace(/(^|\s)-([A-Za-z0-9_]+)/g, (_, p, w) => {
    negParts.push(w);
    return p;
  });
  s = s.replace(/(^|\s)NOT\s+([A-Za-z0-9_]+)/g, (_, p, w) => {
    negParts.push(w);
    return p;
  });
  const negatives = [];
  for (const np of negParts) for (const t of splitIdent(np)) negatives.push(t);
  return { positive: s.trim(), negatives: [...new Set(negatives)] };
}

// Parse a committable synonym file (JSON `{ "term": ["syn", …], … }`) into a Map<token, string[]> for
// expandQuery. PURE (text → Map, no fs — the caller reads the file). Keys and values are tokenised the same
// way identifiers are (CamelCase/snake split, lowercased), so a key `auth` or `AuthFlow` and a value
// `login_session` all normalise to the same concept tokens the model uses. Returns null on a malformed /
// empty file (the fuzzy rung then runs on the mined dictionary alone — the synonym file is purely additive).
export function parseSynonyms(text) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) {
    const arr = Array.isArray(v) ? v : [v];
    const terms = [];
    for (const x of arr) for (const t of splitIdent(String(x))) terms.push(t);
    const keys = splitIdent(String(k)); // a multi-token key (e.g. "auth flow") maps each of its tokens
    for (const key of keys.length ? keys : [String(k).toLowerCase()]) {
      const cur = m.get(key) || [];
      for (const t of terms) if (!cur.includes(t)) cur.push(t);
      if (cur.length) m.set(key, cur);
    }
  }
  return m.size ? m : null;
}
