// C# / Unity provisioning for `vts setup` — turn "the engine is silently absent" into one setup step.
//
// What a C# tree needs before Roslyn/csharp-ls can answer anything:
//   1. an engine: the VS Code C# extension's Roslyn dll (needs a matching .NET runtime — preflighted in
//      backends/index.js) or `csharp-ls` (a dotnet global tool under ~/.dotnet/tools);
//   2. a `dotnet` the engine can find. The MCP host often inherits a PATH without the SDK dir (macOS GUI
//      launch, IDE-spawned shells, `~/.dotnet` installs) → csharp-ls dies with "You must install .NET";
//   3. one file that opens the whole tree: csharp-ls takes ONE `--solution`. Unity writes several .csproj and
//      no .sln, so only the first csproj (alphabetically) was loaded and most symbols were invisible.
//
// `csharpPlan(root)` gathers the facts and `decideCSharp(facts)` (pure — pinned by eval/test-csharp-setup.mjs)
// turns them into actions; `applyCSharp` performs them. Dry by default; `vts setup --csharp apply` writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CONFIG_DIR = path.join(os.homedir(), ".vs-token-safer");

function onPath(name) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) { try { if (fs.existsSync(path.join(d, name + e))) return path.join(d, name + e); } catch { /* ignore */ } }
  }
  return null;
}

function shallow(root, re) {
  try { return fs.readdirSync(root).filter((n) => re.test(n)).map((n) => path.join(root, n)); } catch { return []; }
}

/** Pure decision. facts: { csprojCount, hasSln, dotnetOnPath, dotnetHome, csharpLs } → { actions, lines }. */
export function decideCSharp(f) {
  const actions = []; const lines = [];
  if (!f.csharpLs) {
    lines.push("csharp-ls not found (PATH, ~/.dotnet/tools). If the VS Code C# extension's Roslyn dll can run on this machine vts uses that; otherwise: dotnet tool install --global csharp-ls");
  } else {
    lines.push(`csharp-ls: ${f.csharpLs}`);
    if (!f.dotnetOnPath && f.dotnetHome) {
      actions.push("launcher");
      lines.push(`dotnet is NOT on PATH but ${f.dotnetHome} exists — a launcher that exports DOTNET_ROOT will be written and persisted as roslynCmd`);
    } else if (!f.dotnetOnPath && !f.dotnetHome) {
      lines.push("dotnet not found on PATH nor ~/.dotnet — csharp-ls cannot start; install the .NET SDK or set roslynCmd to a launcher");
    }
  }
  if (f.csprojCount >= 2 && !f.hasSln) {
    actions.push("sln");
    lines.push(`${f.csprojCount} .csproj and no .sln — csharp-ls opens ONE solution, so a .sln listing every csproj will be generated (Unity-style tree; keep it gitignored)`);
  } else if (f.csprojCount === 0 && !f.hasSln) {
    lines.push("no .csproj/.sln under the root — nothing for Roslyn to open (is projectPath the C# root?)");
  }
  return { actions, lines };
}

/** The launcher content — a POSIX sh script or a Windows .cmd. Pure. */
export function launcherScript(platform, dotnetRoot, csharpLsPath) {
  if (platform === "win32") {
    return `@echo off\r\nrem vs-token-safer csharp-ls launcher — the MCP host had no dotnet on PATH\r\nset "DOTNET_ROOT=${dotnetRoot}"\r\nset "PATH=${dotnetRoot};${dotnetRoot}\\tools;%PATH%"\r\n"${csharpLsPath}" %*\r\n`;
  }
  return `#!/bin/sh\n# vs-token-safer csharp-ls launcher — the MCP host had no dotnet on PATH (written by vts setup --csharp apply)\nexport DOTNET_ROOT="${dotnetRoot}"\nexport PATH="${dotnetRoot}:${dotnetRoot}/tools:$PATH"\nexec "${csharpLsPath}" "$@"\n`;
}

export function csharpPlan(root) {
  const home = os.homedir();
  const dotnetHomeDir = path.join(home, ".dotnet");
  const dotnetHomeExe = path.join(dotnetHomeDir, process.platform === "win32" ? "dotnet.exe" : "dotnet");
  const toolsLs = path.join(dotnetHomeDir, "tools", process.platform === "win32" ? "csharp-ls.exe" : "csharp-ls");
  const facts = {
    root,
    csprojCount: shallow(root, /\.csproj$/i).length,
    hasSln: shallow(root, /\.sln$/i).length > 0,
    dotnetOnPath: !!onPath("dotnet"),
    dotnetHome: fs.existsSync(dotnetHomeExe) ? dotnetHomeDir : null,
    csharpLs: onPath("csharp-ls") || (fs.existsSync(toolsLs) ? toolsLs : null),
  };
  const d = decideCSharp(facts);
  const report = d.lines.map((l) => "  · " + l).join("\n") + (d.actions.length ? "" : "\n  · nothing to do");
  return { ...facts, actions: d.actions, report };
}

export function applyCSharp(plan, opts = {}) {
  const done = []; let roslynCmd = null;
  if (plan.actions.includes("launcher")) {
    const bin = path.join(CONFIG_DIR, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, process.platform === "win32" ? "csharp-ls.cmd" : "csharp-ls");
    fs.writeFileSync(file, launcherScript(process.platform, plan.dotnetHome, plan.csharpLs));
    if (process.platform !== "win32") fs.chmodSync(file, 0o755);
    roslynCmd = file;
    done.push(`launcher written: ${file} (persisted as roslynCmd)`);
  }
  if (plan.actions.includes("sln") && opts.genSln !== false) {
    const dotnet = onPath("dotnet") || (plan.dotnetHome ? path.join(plan.dotnetHome, process.platform === "win32" ? "dotnet.exe" : "dotnet") : null);
    if (!dotnet) done.push("sln NOT generated — no dotnet to run `dotnet new sln`");
    else {
      const name = path.basename(plan.root);
      const env = { ...process.env, DOTNET_ROOT: plan.dotnetHome || process.env.DOTNET_ROOT || "", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
      try {
        execFileSync(dotnet, ["new", "sln", "-n", name], { cwd: plan.root, env, stdio: "ignore", timeout: 60000 });
        for (const p of shallow(plan.root, /\.csproj$/i))
          execFileSync(dotnet, ["sln", `${name}.sln`, "add", p], { cwd: plan.root, env, stdio: "ignore", timeout: 60000 });
        done.push(`solution written: ${path.join(plan.root, name + ".sln")} (${plan.csprojCount} projects) — add *.sln to .gitignore if the repo doesn't track it`);
      } catch (e) { done.push(`sln generation failed: ${e.message}`); }
    }
  }
  return { roslynCmd, report: done.length ? done.map((l) => "  ✓ " + l).join("\n") : "  · nothing applied" };
}
