#!/usr/bin/env node
// One-shot version bumper. The plugin version lives in several files; this keeps them in sync.
//
//   node scripts/bump.mjs <level> [--dry-run] [--tag]
//
//   <level>   major | minor | patch   (hotfix and fix are aliases for patch)
//   --dry-run print what would change, write nothing
//   --tag     after writing, create the annotated git tag vX.Y.Z
//
// The `v*` tag publishes the GitHub Release (release.yml) AND (idempotently) the npm package
// (npm-publish.yml skips if that version is already on npm).
//
// Targets (edited in place, formatting preserved via a scoped regex replace):
//   .claude-plugin/plugin.json            (top-level "version")
//   .claude-plugin/marketplace.json       (vs-token-safer plugin entry)
//   server/package.json                   (top-level "version")
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [levelArg] = args.filter((a) => !a.startsWith("--"));
const DRY = flags.has("--dry-run");
const TAG = flags.has("--tag");

const LEVEL = { major: "major", minor: "minor", patch: "patch", hotfix: "patch", fix: "patch" }[levelArg];
if (!LEVEL) {
  console.error("usage: node scripts/bump.mjs <major|minor|patch|hotfix> [--dry-run] [--tag]");
  process.exit(2);
}

const entryVersionRe = (name) => new RegExp(`("name":\\s*"${name}"[\\s\\S]*?"version":\\s*")([0-9]+\\.[0-9]+\\.[0-9]+)(")`);
const topVersionRe = () => new RegExp(`("version":\\s*")([0-9]+\\.[0-9]+\\.[0-9]+)(")`);

const CANONICAL = ".claude-plugin/plugin.json";
const TARGETS = [
  { file: ".claude-plugin/plugin.json", re: topVersionRe() },
  { file: ".claude-plugin/marketplace.json", re: entryVersionRe("vs-token-safer") },
  { file: "server/package.json", re: topVersionRe() },
];

function bumpSemver(v, level) {
  const [maj, min, pat] = v.split(".").map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function readCurrent(file, re) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const m = text.match(re);
  if (!m) throw new Error(`no version found in ${file}`);
  return m[2]; // capture group 2 is the version in both regex shapes
}

const current = readCurrent(CANONICAL, topVersionRe());
const next = bumpSemver(current, LEVEL);
console.log(`\nvs-token-safer: ${current} -> ${next} (${LEVEL})`);
for (const { file, re } of TARGETS) {
  const abs = path.join(ROOT, file);
  const text = fs.readFileSync(abs, "utf8");
  const found = readCurrent(file, re);
  if (found !== current) {
    console.warn(`  ! ${file} had ${found}, expected ${current} — bumping it to ${next} anyway`);
  }
  const updated = text.replace(re, (_m, p1, _v, p3) => `${p1}${next}${p3}`);
  if (updated === text) throw new Error(`failed to update version in ${file}`);
  if (DRY) {
    console.log(`  would update ${file}`);
  } else {
    fs.writeFileSync(abs, updated);
    console.log(`  updated ${file}`);
  }
}

if (DRY) {
  console.log("\n(dry run — no files written)");
  process.exit(0);
}

const tag = `v${next}`;
if (TAG) {
  execFileSync("git", ["tag", "-a", tag, "-m", `vs-token-safer ${next}`], { cwd: ROOT, stdio: "inherit" });
  console.log(`\ntagged ${tag}`);
  console.log(`Push with: git push origin ${tag}`);
} else {
  console.log("\nNext: commit the bump (PR + merge to main), then push the release tag on main:");
  console.log(`  git tag -a ${tag} -m "vs-token-safer ${next}" && git push origin ${tag}`);
  console.log("That `v*` tag publishes the GitHub Release AND (idempotently) the npm package.");
}
