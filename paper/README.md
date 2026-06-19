# Paper — vs-token-safer

arXiv-style preprint positioning `vs-token-safer` against the
persistent-knowledge-graph approach of *Codebase-Memory* (arXiv:2603.27277).
Author: **Sungmin Jeon** <sungmin1505104@gmail.com>.

## Files

| File | What |
| --- | --- |
| `vs-token-safer.tex` | English version (self-contained, inline bibliography) |
| `vs-token-safer.ko.tex` | Korean version (xeCJK + Malgun Gothic) |
| `vs-token-safer.pdf` / `.ko.pdf` | built PDFs |
| `figures/*.svg` | source figures (architecture pipeline, per-tool savings) |
| `figures/*.pdf` | figures converted for `\includegraphics` |
| `figures/build.py` | SVG → PDF converter (pure-python svglib, no cairo) |

## Build

```bash
# figures first (only if you edited the .svg)
pip install svglib
python figures/build.py

# then the papers (tectonic auto-selects XeTeX for the Korean one)
tectonic vs-token-safer.tex
tectonic vs-token-safer.ko.tex
```

Both compile clean: 0 overfull boxes, 0 undefined references/citations.
The Korean version uses **`kotex`** (xetexko) for correct Korean word-spacing and
line-breaking — plain `xeCJK` + `\sloppy` stretched the spaces and made it hard to
read, so we switched. It needs the **Malgun Gothic** font (ships with Windows
10/11); on Linux/macOS swap `\setmainhangulfont{Malgun Gothic}` for an installed
Korean font (e.g. `Noto Serif CJK KR`).

## Toolchain installed for this paper

- **tectonic 0.16.9** (scoop) — self-contained LaTeX engine (auto-fetches packages).
- **svglib + reportlab** (pip) — SVG → vector-PDF, pure-python (cairosvg fails on
  Windows for lack of a native cairo DLL; svglib does not need it).
- **MCP servers** registered at user scope (`claude mcp add`, active next session):
  - `arxiv-latex` (`arxiv-latex-mcp`) — fetch a reference paper's true LaTeX/math.
  - `paper-search` (`python -m paper_search_mcp.server`) — search/verify citations
    across arXiv, PubMed, bioRxiv.

## Provenance / honesty notes

- **Critic pass done.** An independent audit cross-checked every quantitative and
  behavioral claim against the live code/ledger. All headline numbers reproduce
  (441 searches · ~130,251 tokens · 263,540→133,289 · peak 21,056→1,961 · 74
  guards · depth 5 / 80 nodes · MAX_BACKENDS 2 · zero network calls outside the
  loopback dashboard + vendored Three.js). One rounding fix applied: cold-query
  cap is **1,433** tokens (harness output), not 1,434.
- **Tool surface** stated precisely: 13 first-class MCP tools + one `vts_admin`
  folding 9 admin ops.
- **Evaluation framing is observational**, not a controlled A/B benchmark — the
  draft says so. The §"combined savings" note deliberately refuses to quote the
  bundled log-compaction total (the ledger value is degenerate); only the
  code-search ledger (Table 1) is a result.
- Numbers are as of v0.32.2; re-run `vts savings` + `node eval/run.mjs` and
  rebuild before submission if stale.
- No real company/project paths or symbols appear (charter rule). Synthetic names
  only.
- Both versions were written for natural readability (humanized prose: varied
  rhythm, reduced formulaic transitions and em-dash chains); the Korean avoids
  translationese (no excessive passives / inanimate subjects).

## Next

1. Use the now-registered `paper-search` MCP to verify each bibliography entry and
   add proper citations for the Related Work claims.
2. Push to Overleaf for co-editing / final typesetting.
3. Run the controlled grep-vs-vts benchmark described in §9 to promote the
   observational numbers to experimental ones.
