// F13 / D-R2c-1: the footer text of every public page reads at 4.5:1 or better
// (WCAG AA, the 2026-08-14 contrast amendment). The release inspection ran
// Lighthouse on live /membership and found its two footer lines at 2.71:1
// (the copyright line, gray-500) and 1.63:1 ("Built and hosted by", gray-500 at
// half opacity) on the dark green footer.
//
// Measured in a real browser, not read from the CSS: for each text-bearing
// element inside a <footer> the test takes the computed text colour, the
// opacity of the element and of every ancestor, and the background it really
// sits on (the ancestors' background colours composited, bottom up, over the
// white canvas). Needs puppeteer-core on NODE_PATH
// (NODE_PATH=/home/mike/wzq/node_modules); skips, not red, without it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_URL } from "./helpers.mjs";
import { loadPuppeteer, withBrowser } from "./portal-nav-probe.mjs";

const MIN_RATIO = 4.5;

// Pages that carry a footer, and pages that carry none today (listed so a
// footer added to one of them later is measured too, not skipped).
const PAGES_WITH_FOOTER = ["/", "/gallery", "/register", "/glow", "/membership", "/this-page-does-not-exist"];
const PAGES_WITHOUT_FOOTER = ["/glow/list", "/membership-success", "/membership-cancel", "/admin/"];

// Runs in the page. Returns one reading per footer text element.
function readFooterContrast() {
  const parse = (css) => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const backgroundOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.push(parse(getComputedStyle(n).backgroundColor));
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of chain.reverse()) bg = over(layer, bg);
    return bg;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const out = [];
  for (const footer of document.querySelectorAll("footer")) {
    for (const el of [footer, ...footer.querySelectorAll("*")]) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
      if (!own) continue;
      const fg = parse(getComputedStyle(el).color);
      const bg = backgroundOf(el);
      const shown = over({ ...fg, a: fg.a * opacityOf(el) }, bg);
      const l1 = lum(shown);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({
        text: own.slice(0, 48),
        tag: el.tagName.toLowerCase(),
        fg: [shown.r, shown.g, shown.b].map(Math.round).join(","),
        bg: [bg.r, bg.g, bg.b].map(Math.round).join(","),
        ratio,
      });
    }
  }
  return out;
}

for (const width of [390, 1280]) {
  test(`F13 footer contrast at ${width}: every footer line on every public page is at least ${MIN_RATIO}:1`, { timeout: 120000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");
    await withBrowser(puppeteer, async (browser) => {
      const problems = [];
      const report = [];
      for (const path of [...PAGES_WITH_FOOTER, ...PAGES_WITHOUT_FOOTER]) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 800 });
          await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
          await page.evaluate(() => document.fonts && document.fonts.ready);
          const lines = await page.evaluate(readFooterContrast);
          if (PAGES_WITH_FOOTER.includes(path) && lines.length === 0) problems.push(`${path}: no footer text found, so nothing was measured`);
          for (const l of lines) {
            report.push(`${path}@${width} <${l.tag}> "${l.text}" text rgb(${l.fg}) on rgb(${l.bg}) = ${l.ratio.toFixed(2)}:1`);
            if (l.ratio < MIN_RATIO) problems.push(`${path}@${width}: "${l.text}" is ${l.ratio.toFixed(2)}:1 (text rgb(${l.fg}) on rgb(${l.bg})), under ${MIN_RATIO}:1`);
          }
        } finally {
          await page.close();
        }
      }
      console.log(report.join("\n"));
      assert.deepEqual(problems, []);
    });
  });
}
