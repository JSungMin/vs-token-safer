// Cleanroom 3-Hex `hashline` (LINE#HHH, 12-bit FNV-1a) partial symbol editor & drift-safe re-anchoring.
// Zero external dependencies and zero GPL/third-party reference; cross-language byte-identical with Python
// `line_hash_hex3` (32-bit FNV-1a over UTF-8 `.trim()` bytes, lower 12 bits formatted as 3 lowercase hex chars).
import fs from "node:fs";
import path from "node:path";
import { tsReadSymbol, tsFileSymbols, tsSearchSymbols, tsSupports } from "./treesitter.js";
import { searchSymIndex, defaultSkipDir } from "./symindex.js";

export function hashlineOn() {
  return !/^(0|false|off|no)$/i.test(String(process.env.VTS_HASHLINE ?? "1"));
}

export function lineHash3Hex(rawLine) {
  const bytes = Buffer.from(String(rawLine ?? "").trim(), "utf8");
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xfff).toString(16).padStart(3, "0");
}

export function spanHashHex8(lines) {
  const joined = (Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/)).map((l) => String(l).trim()).join("\n");
  const bytes = Buffer.from(joined, "utf8");
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function formatHashLines(lines, startLine1Based = 1) {
  return lines.map((ln, idx) => `${startLine1Based + idx}#${lineHash3Hex(ln)}| ${ln}`).join("\n");
}

export function parseHashlineSpec(spec) {
  const s = String(spec ?? "").trim();
  let m = /^(after|before):(\d+)#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const ln = parseInt(m[2], 10), hx = m[3].toLowerCase();
    return ln >= 1 ? { mode: m[1].toLowerCase(), startLine: ln, endLine: ln, hStart: hx, hEnd: hx } : null;
  }
  m = /^(\d+)#([0-9a-f]{3})(?:(?:\.\.|-+)(\d+)#([0-9a-f]{3}))?$/i.exec(s);
  if (!m) return null;
  const startLine = parseInt(m[1], 10);
  const endLine = m[3] ? parseInt(m[3], 10) : startLine;
  if (startLine < 1 || endLine < startLine) return null;
  return {
    mode: "range",
    startLine,
    endLine,
    hStart: m[2].toLowerCase(),
    hEnd: (m[4] || m[2]).toLowerCase(),
  };
}

async function resolveFileAndSpan(a, root, resolveViaLsp) {
  const want = String(a.symbol || "").trim();
  if (!want) return { error: "replace_symbol_body needs `symbol`." };
  let absFile = a.path ? (path.isAbsolute(String(a.path)) ? String(a.path) : path.join(root, String(a.path))) : "";
  if (!absFile) {
    const idxHits = searchSymIndex(root, want, { max: 5 });
    const exactIdx = idxHits && (idxHits.find((h) => h.name === want) || idxHits[0]);
    if (exactIdx) absFile = exactIdx.file;
    else {
      const tsHits = await tsSearchSymbols(root, want, { skipDir: defaultSkipDir, maxResults: 5 });
      const exactTs = tsHits && (tsHits.find((h) => h.name === want) || tsHits[0]);
      if (exactTs) absFile = exactTs.file;
    }
  }
  if (absFile && tsSupports(absFile)) {
    const ts = await tsReadSymbol(absFile, want, { line: a.line != null ? Number(a.line) + 1 : null });
    if (ts) return { file: absFile, symStart0: ts.startRow, symEnd0: ts.endRow };
    const syms = await tsFileSymbols(absFile);
    if (syms && syms.parseError) {
      return { error: `syntax parse error in ${absFile.replace(/\\/g, "/")} — refusing partial hashline edit on an incomplete AST.` };
    }
  }
  if (typeof resolveViaLsp === "function") {
    const r = await resolveViaLsp();
    if (r && !r.error && r.ds && r.ds.range) {
      return { file: r.file, symStart0: r.ds.range.start.line, symEnd0: r.ds.range.end.line };
    }
    if (r && r.error) return { error: r.error };
  }
  return { error: `no declaration "${want}" resolved${absFile ? " in " + absFile.replace(/\\/g, "/") : ""}.` };
}

export async function applyHashlineSymbolEdit(a, root, deps) {
  const { recordEditEvent, ensureWritableForEdit, finishOut, err, resolveViaLsp, notifyWarmClient } = deps;
  if (a.body == null) return err("replace_symbol_body needs `body`.");
  const parsed = parseHashlineSpec(a.lines);
  if (!parsed) {
    return err(`replace_symbol_body: invalid lines="${a.lines}" — expected "START#HHH..END#HHH", "LINE#HHH", or "after:LINE#HHH".`);
  }
  const loc = await resolveFileAndSpan(a, root, resolveViaLsp);
  if (loc.error) return err(`replace_symbol_body: ${loc.error}`);
  const { file, symStart0, symEnd0 } = loc;
  let rawText;
  try { rawText = fs.readFileSync(file, "utf8"); }
  catch (e) { return err(`replace_symbol_body: cannot read ${file} (${e.message}).`); }
  const eol = rawText.includes("\r\n") ? "\r\n" : "\n";
  const trailingNl = /\r?\n$/.test(rawText);
  const rawLines = rawText.split(/\r?\n/);
  if (trailingNl) rawLines.pop();
  const boundedEnd0 = Math.min(symEnd0, rawLines.length - 1);
  const spanLen = parsed.endLine - parsed.startLine + 1;
  const reqS = parsed.startLine - 1, reqE = parsed.endLine - 1;

  let targetS = -1, targetE = -1, drift = 0;
  if (reqS >= symStart0 && reqE <= boundedEnd0 &&
      lineHash3Hex(rawLines[reqS]) === parsed.hStart && lineHash3Hex(rawLines[reqE]) === parsed.hEnd) {
    targetS = reqS;
    targetE = reqE;
  } else {
    const candidates = [];
    for (let i = symStart0; i + spanLen - 1 <= boundedEnd0; i++) {
      if (lineHash3Hex(rawLines[i]) === parsed.hStart && lineHash3Hex(rawLines[i + spanLen - 1]) === parsed.hEnd) {
        candidates.push(i);
      }
    }
    if (candidates.length === 1) {
      targetS = candidates[0];
      targetE = targetS + spanLen - 1;
      drift = targetS - reqS;
    } else {
      const fp = file.replace(/\\/g, "/");
      const reason = candidates.length === 0 ? "hash mismatch" : `ambiguous collision (${candidates.length} matching spans)`;
      const slice = formatHashLines(rawLines.slice(symStart0, Math.min(boundedEnd0 + 1, symStart0 + 60)), symStart0 + 1);
      return err(`replace_symbol_body: hashline ${reason} for ${a.lines} in "${a.symbol}" (${fp}:${symStart0 + 1}-${boundedEnd0 + 1}) — file NOT modified. Current symbol hashlines:\n${slice}`);
    }
  }

  try { if (recordEditEvent) recordEditEvent("symbol-edit"); } catch { /* best-effort */ }
  const fp = file.replace(/\\/g, "/");
  const spanLabel = targetS === targetE ? `${fp}:${targetS + 1}` : `${fp}:${targetS + 1}-${targetE + 1}`;
  const driftNote = drift ? ` (re-anchored ${drift > 0 ? "+" : ""}${drift}L inside "${a.symbol}")` : "";
  const apply = a.apply === true || a.apply === "true";
  if (!apply) {
    return finishOut(rawText, `replace_symbol_body "${a.symbol}" [hashline ${a.lines}] — PREVIEW at ${spanLabel}${driftNote}. Pass apply=true to write.`);
  }
  const repLines = String(a.body).split(/\r?\n/);
  if (parsed.mode === "after") rawLines.splice(targetE + 1, 0, ...repLines);
  else if (parsed.mode === "before") rawLines.splice(targetS, 0, ...repLines);
  else rawLines.splice(targetS, spanLen, ...repLines);

  const p4note = ensureWritableForEdit ? ensureWritableForEdit(file) : "";
  const nextText = rawLines.join(eol) + (trailingNl ? eol : "");
  try { fs.writeFileSync(file, nextText, "utf8"); }
  catch (e) { return err(`replace_symbol_body: failed to write ${spanLabel} (${e.code || e.message}).`); }
  if (notifyWarmClient) notifyWarmClient(file);
  return finishOut(rawText, `replace_symbol_body "${a.symbol}" [hashline ${a.lines}] — APPLIED at ${spanLabel}${driftNote}.${p4note}`);
}
