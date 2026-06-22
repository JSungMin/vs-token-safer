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
export function expandQuery(model, qTokens, { k = 6, minAssoc = 1.5, minCooc = 2, neighborMax = 0.85 } = {}) {
  const weights = new Map();
  for (const t of qTokens) weights.set(t, 1);
  for (const t of qTokens) {
    const m = model.cooc.get(t);
    if (!m) continue;
    const scored = [];
    for (const [n, c] of m) {
      if (weights.has(n)) continue;
      // a real synonym RECURS — gate on raw co-occurrence count (kills single-shot noise from a shared comment)
      // AND on a neighbour seen in at least two declarations, before the association (PMI) threshold.
      if (c < minCooc || (model.df.get(n) || 0) < 2) continue;
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

// Score one symbol against the expanded query. `symTokens` = sub-tokens of the symbol name; `docTokens` =
// sub-tokens of its attached comment/docstring (matched at a discount, since a name is a stronger signal than
// a comment). Each enriched query token contributes its weight x best token-match x idf; the comment channel
// adds a smaller bonus. The result is comparable across symbols (no length normalisation needed because idf
// already damps ubiquitous tokens, and a longer name simply has more chances to match — which is fair).
export function scoreSymbol(model, enriched, symTokens, docTokens = [], { docFactor = 0.5 } = {}) {
  let score = 0;
  for (const [qt, w] of enriched) {
    const weight = w * idf(model, qt);
    let best = 0;
    for (const st of symTokens) {
      const m = tokMatch(qt, st);
      if (m > best) best = m;
    }
    if (best) score += weight * best;
    if (docFactor && docTokens.length) {
      let dbest = 0;
      for (const dt of docTokens) {
        const m = tokMatch(qt, dt);
        if (m > dbest) dbest = m;
      }
      if (dbest && dbest * docFactor > 0) score += weight * dbest * docFactor;
    }
  }
  return score;
}
