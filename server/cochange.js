// cochange.js — GIT CO-CHANGE signal for the FUZZY rung (concept_search).
//
// Files committed together hold related code. That co-occurrence is a deterministic, LOCAL, embedding-free
// proxy for the "what clusters semantically" signal cloud tools (Cursor/Augment) get from vectors — mined
// straight from the repo's own history, nothing transmitted. We feed it as a SECOND structural neighbour map
// (alongside the import graph) into the concept_search pass-2 proximity boost: a symbol whose file frequently
// co-changes with a strongly-matching file is lifted, GATED by the same LARGER anchor confidence so a weak
// neighbour can't drag it up. The boost only reranks the already-matched, already-capped file:line set — it
// never invents a match, so the charter (capped output, honest precision, local) holds.
//
// PURE core (`parseCoChange`, text → map) + one thin git read (`cochangeNeighbors`). Absent git / not a repo
// → an empty map (the boost then does nothing — graceful, exactly like the import graph on an unsupported lang).
import path from "node:path";
import { execFileSync } from "node:child_process";

// Commit-boundary marker. We make git print it once per commit (`--pretty=format:<SEP>`), so a line equal to
// it starts a new commit and every other non-empty line is a touched file. A printable sentinel (no control
// chars — diff/eslint friendly) that cannot collide with a real path line.
const SEP = "<<<VTS-COMMIT>>>";

// Parse the output of `git log --name-only --pretty=format:<SEP>` into a file→file co-change weight map. Each
// commit contributes +1 to every unordered pair of files it touched (stored BOTH directions for O(1) neighbour
// lookup). A commit touching MORE than maxFilesPerCommit files is SKIPPED — a merge / format sweep / mass-rename
// couples hundreds of unrelated files and is noise, not a semantic signal. Pure: text → Map, no fs, no git.
// Returns Map<relpath, Map<relpath, count>>.
export function parseCoChange(logText, { maxFilesPerCommit = 30, boundary = SEP } = {}) {
  const pairs = new Map();
  const bump = (a, b) => {
    if (a === b) return;
    if (!pairs.has(a)) pairs.set(a, new Map());
    const m = pairs.get(a);
    m.set(b, (m.get(b) || 0) + 1);
  };
  const flush = (files) => {
    const uniq = [...new Set(files)];
    if (uniq.length < 2 || uniq.length > maxFilesPerCommit) return; // singletons + mega-commits carry no signal
    for (let i = 0; i < uniq.length; i++)
      for (let j = i + 1; j < uniq.length; j++) {
        bump(uniq[i], uniq[j]);
        bump(uniq[j], uniq[i]);
      }
  };
  let cur = [];
  for (const raw of String(logText).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(boundary)) { flush(cur); cur = []; continue; } // commit boundary (SEP, optionally + the next file glued by git)
    cur.push(line.replace(/\\/g, "/"));
  }
  flush(cur);
  return pairs;
}

// Build a file→Set<neighbour-file> co-change map from the last `maxCommits` of git history under `root`. Keys
// and values are ABSOLUTE forward-slash paths (resolved against the git TOPLEVEL so they line up with the
// concept index's `symbol.file`, which is an absolute walk path). Only neighbours co-changed >= minWeight times
// are kept (a single shared commit is a coincidence, not a coupling). Not a git repo / git missing → empty map.
export function cochangeNeighbors(root, { maxCommits = 500, maxFilesPerCommit = 30, minWeight = 2 } = {}) {
  let top, out;
  try {
    top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    out = execFileSync(
      "git",
      ["-C", root, "log", "--name-only", "--no-renames", `--pretty=format:${SEP}`, "-n", String(maxCommits)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return new Map(); // no git / not a repo → no co-change edges (graceful)
  }
  const pairs = parseCoChange(out, { maxFilesPerCommit });
  const abs = (rel) => path.resolve(top, rel).replace(/\\/g, "/");
  const neighbors = new Map();
  for (const [f, m] of pairs) {
    const set = new Set();
    for (const [g, w] of m) if (w >= minWeight) set.add(abs(g));
    if (set.size) neighbors.set(abs(f), set);
  }
  return neighbors;
}
