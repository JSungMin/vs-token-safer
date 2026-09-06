// Guard for the Roslyn host preflight (pure part): `dotnet --list-runtimes` text → does it satisfy the
// major the MS dll's runtimeconfig asks for (rollForward: Major → same-or-newer major counts).
import { hostHasRuntime } from "../server/backends/index.js";
const nine = "Microsoft.AspNetCore.App 9.0.16 [/x/shared/Microsoft.AspNetCore.App]\nMicrosoft.NETCore.App 9.0.16 [/x/shared/Microsoft.NETCore.App]\n";
const ten = nine + "Microsoft.NETCore.App 10.0.2 [/x/shared/Microsoft.NETCore.App]\n";
const cases = [
  [hostHasRuntime(nine, 10), false, "net10 dll, only .NET 9 runtime → cannot run"],
  [hostHasRuntime(ten, 10), true, "net10 dll, .NET 10 runtime present → runs"],
  [hostHasRuntime(nine, 9), true, "net9 dll, .NET 9 runtime → runs"],
  [hostHasRuntime(nine, 8), true, "net8 dll, newer runtime rolls forward → runs"],
  [hostHasRuntime("", 10), false, "no host output → cannot run"],
  [hostHasRuntime("", 0), true, "unknown requirement → don't block"],
];
let bad = 0;
for (const [got, want, name] of cases) { if (got !== want) { bad++; console.error("FAIL", name, got); } }
if (bad) { console.error(`roslyn runtime guard: ${bad} failure(s)`); process.exit(1); }
console.log(`roslyn runtime guard: ${cases.length} cases ok`);
