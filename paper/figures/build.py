#!/usr/bin/env python3
"""Convert every figures/*.svg to a vector PDF for LaTeX \includegraphics.

Pure-Python (svglib + reportlab) — no native cairo/inkscape needed on Windows.
  pip install svglib
  python build.py
"""
import glob
import os

from reportlab.graphics import renderPDF
from svglib.svglib import svg2rlg

here = os.path.dirname(os.path.abspath(__file__))
for svg in sorted(glob.glob(os.path.join(here, "*.svg"))):
    pdf = os.path.splitext(svg)[0] + ".pdf"
    renderPDF.drawToFile(svg2rlg(svg), pdf)
    print("wrote", os.path.basename(pdf))
