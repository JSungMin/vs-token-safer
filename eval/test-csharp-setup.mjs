// Guards for the setup provisioning added in 1.1.9: the C# decision table, the launcher content, and the
// hookNoise parse. Pure functions only — no fs, no dotnet.
import { decideCSharp, launcherScript } from "../server/csharp-setup.js";
import { parseHookNoise } from "../server/policy.js";

let bad = 0;
const check = (got, want, name) => { if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.error("FAIL", name, got); } };

// Unity tree on a Mac with ~/.dotnet but no dotnet on PATH → launcher + sln
check(decideCSharp({ csprojCount: 5, hasSln: false, dotnetOnPath: false, dotnetHome: "/h/.dotnet", csharpLs: "/h/.dotnet/tools/csharp-ls" }).actions,
      ["launcher", "sln"], "unity mac: launcher + sln");
// Same tree, dotnet on PATH → only the sln
check(decideCSharp({ csprojCount: 5, hasSln: false, dotnetOnPath: true, dotnetHome: "/h/.dotnet", csharpLs: "/usr/local/bin/csharp-ls" }).actions,
      ["sln"], "unity with dotnet on PATH: sln only");
// Ordinary repo with a .sln and everything on PATH → nothing
check(decideCSharp({ csprojCount: 3, hasSln: true, dotnetOnPath: true, dotnetHome: null, csharpLs: "/usr/local/bin/csharp-ls" }).actions,
      [], "normal repo: nothing to do");
// No csharp-ls at all → advisory only, never a launcher
check(decideCSharp({ csprojCount: 5, hasSln: false, dotnetOnPath: false, dotnetHome: "/h/.dotnet", csharpLs: null }).actions,
      ["sln"], "no csharp-ls: no launcher, sln still useful");
// Single csproj, no sln → csharp-ls opens it directly, no sln needed
check(decideCSharp({ csprojCount: 1, hasSln: false, dotnetOnPath: true, dotnetHome: null, csharpLs: "/x/csharp-ls" }).actions,
      [], "single csproj: no sln");

const sh = launcherScript("darwin", "/h/.dotnet", "/h/.dotnet/tools/csharp-ls");
check(sh.startsWith("#!/bin/sh"), true, "posix launcher shebang");
check(sh.includes('export DOTNET_ROOT="/h/.dotnet"') && sh.includes('exec "/h/.dotnet/tools/csharp-ls" "$@"'), true, "posix launcher body");
const cmd = launcherScript("win32", "C:\\Users\\u\\.dotnet", "C:\\Users\\u\\.dotnet\\tools\\csharp-ls.exe");
check(cmd.startsWith("@echo off") && cmd.includes("set \"DOTNET_ROOT=C:\\Users\\u\\.dotnet\"") && cmd.includes("%*"), true, "windows launcher body");

check(parseHookNoise(undefined), "full", "hookNoise default");
check(parseHookNoise("quiet"), "quiet", "hookNoise quiet");
check(parseHookNoise("QUIET "), "quiet", "hookNoise case/space");
check(parseHookNoise("nudge"), "full", "hookNoise unknown → full");

if (bad) { console.error(`csharp-setup guard: ${bad} failure(s)`); process.exit(1); }
console.log("csharp-setup guard: 14 cases ok");
