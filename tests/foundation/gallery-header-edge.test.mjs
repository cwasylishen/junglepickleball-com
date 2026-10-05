// F13 / D-R2c-2: /gallery's header at phone width. The release inspection
// measured the BOOK COURT button 9 px from the right edge at 360 (Clinton's
// rule, 2026-09-17: nothing closer than 16 px to a screen edge), wrapped onto
// two lines, with the logo running into HOME. The three header items together
// were wider than the row, so the row pushed the button out.
//
// Measured from rendered boxes in real headless Chromium (needs puppeteer-core
// on NODE_PATH=/home/mike/wzq/node_modules; skips, not red, without it):
// the button keeps 16 px from the right edge, its label is one line, the logo
// does not touch HOME, HOME does not touch the button, nothing scrolls sideways.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_URL } from "./helpers.mjs";
import { EDGE_PX, loadPuppeteer, withBrowser } from "./portal-nav-probe.mjs";

const MIN_GAP_PX = 8; // clear space between neighbouring header items

// Runs in the page: the three header items and the viewport.
function readHeader() {
  const nav = document.querySelector("nav");
  const [logo, home, book] = [...nav.querySelectorAll("a")];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(el);
    // Distinct line tops of the label: more than one means it wrapped.
    const lines = new Set([...text.getClientRects()].map((q) => Math.round(q.top))).size;
    return { left: r.left, right: r.right, height: r.height, lines };
  };
  return {
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    logo: box(logo),
    home: box(home),
    book: box(book),
    bookText: book.textContent.trim(),
  };
}

for (const width of [360, 390, 768, 1280]) {
  test(`F13 /gallery header at ${width}: BOOK COURT keeps ${EDGE_PX} px from the right edge, one line, nothing overlapping`, { timeout: 60000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");
    await withBrowser(puppeteer, async (browser) => {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width, height: 800 });
        await page.goto(`${BASE_URL}/gallery`, { waitUntil: "load" });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        const h = await page.evaluate(readHeader);
        const f = (n) => n.toFixed(1);
        console.log(
          `gallery@${width}: logo ${f(h.logo.left)}-${f(h.logo.right)}, HOME ${f(h.home.left)}-${f(h.home.right)}, ` +
            `BOOK COURT ${f(h.book.left)}-${f(h.book.right)} (${f(h.viewport - h.book.right)} px from the right edge, ${h.book.lines} line(s), ${f(h.book.height)} px tall); ` +
            `scrollWidth ${h.scrollWidth}`
        );
        assert.equal(h.bookText, "BOOK COURT");
        const problems = [];
        const rightGap = h.viewport - h.book.right;
        if (rightGap < EDGE_PX) problems.push(`BOOK COURT is ${f(rightGap)} px from the right edge, under ${EDGE_PX}`);
        if (h.logo.left < EDGE_PX) problems.push(`logo is ${f(h.logo.left)} px from the left edge, under ${EDGE_PX}`);
        if (h.book.lines !== 1) problems.push(`BOOK COURT wraps onto ${h.book.lines} lines`);
        if (h.logo.lines !== 1) problems.push(`the logo wraps onto ${h.logo.lines} lines`);
        if (h.home.left - h.logo.right < MIN_GAP_PX) problems.push(`logo and HOME are ${f(h.home.left - h.logo.right)} px apart, under ${MIN_GAP_PX}`);
        if (h.book.left - h.home.right < MIN_GAP_PX) problems.push(`HOME and BOOK COURT are ${f(h.book.left - h.home.right)} px apart, under ${MIN_GAP_PX}`);
        if (h.scrollWidth > h.viewport) problems.push(`page scrolls sideways: scrollWidth ${h.scrollWidth} > viewport ${h.viewport}`);
        assert.deepEqual(problems, []);
      } finally {
        await page.close();
      }
    });
  });
}
