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

// Score one symbol against the expanded query across three channels, strongest first: the symbol NAME, the
// file PATH it lives in, and its attached comment/docstring. Related code clusters by directory and filename
// (an auth helper lives under `auth/` in a `session.ts`), so a query token that matches the path is real,
// free, local evidence — weaker than a name hit, comparable to a comment hit. Each enriched query token
// contributes its weight x best token-match x idf per channel (path/doc at a discount). idf already damps
// ubiquitous tokens, so no length normalisation is needed.
export function scoreSymbol(
  model,
  enriched,
  symTokens,
  docTokens = [],
  { docFactor = 0.5, pathTokens = [], pathFactor = 0.4 } = {},
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
  return score;
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
