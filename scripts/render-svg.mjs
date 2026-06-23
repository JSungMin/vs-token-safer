// Render an SVG file to a PNG via headless Chromium (puppeteer from canvas-orbit-gif).
// usage: node render-svg.mjs <in.svg> <out.png> [scale]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// puppeteer isn't a dependency of this repo — it's borrowed from the sibling
// canvas-orbit-gif (github.com/JSungMin/canvas-orbit-gif). Resolve it from there,
// or set PUPPETEER_DIR to any folder whose node_modules has puppeteer installed.
const anchor = process.env.PUPPETEER_DIR
  ? new URL("file://" + process.env.PUPPETEER_DIR + "/")
  : new URL("../../canvas-orbit-gif/", import.meta.url);
const puppeteer = createRequire(anchor)("puppeteer");

const [inSvg, outPng, scaleArg] = process.argv.slice(2);
const scale = Number(scaleArg || 2);
const svg = readFileSync(inSvg, "utf8");
const m = svg.match(/width="(\d+)"[\s\S]*?height="(\d+)"/);
const w = Number(m[1]), h = Number(m[2]);

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
await page.setContent(
  `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`,
  { waitUntil: "networkidle0" }
);
const el = await page.$("svg");
await el.screenshot({ path: outPng, omitBackground: false });
await browser.close();
console.log(`wrote ${outPng} (${w}x${h} @${scale}x)`);
