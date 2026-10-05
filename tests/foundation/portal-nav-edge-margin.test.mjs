// F10 / D-R2b-2: the bottom bar's edge margin, in rendered pixels. The
// inspection measured ACCOUNT 9.5 px from the right edge of the owner's
// 5-tab bar at 390 (and never measured 360). Clinton's rule (2026-09-17):
// nothing closer than 16 px to a screen edge. For every role, at 360 and
// 390: the first tab's label and hit area start at least 16 px from the
// left edge, the last tab's end at least 16 px from the right edge, every
// tap target is at least 44 px tall (and wide), and no label spills out of
// its own tab. Measured from getBoundingClientRect, not from the CSS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES, EDGE_PX, TAP_PX, loadPuppeteer, withBrowser, openPortal, readNav } from "./portal-nav-probe.mjs";

for (const width of [360, 390]) {
  test(`F10 edge margin at ${width}: every role's bottom bar keeps 16 px from both edges, tap targets 44 px`, { timeout: 170000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");
    await withBrowser(puppeteer, async (browser) => {
      const problems = [];
      const measured = [];
      for (const role of Object.keys(ROLES)) {
        const page = await openPortal(browser, role, width);
        try {
          const state = await page.evaluate(readNav);
          const first = state.links[0];
          const last = state.links[state.links.length - 1];
          const gaps = {
            labelLeft: first.label.left,
            labelRight: state.viewport - last.label.right,
            hitLeft: first.hit.left,
            hitRight: state.viewport - last.hit.right,
          };
          measured.push(
            `${role}@${width}: ${state.links.length} tabs; label ${gaps.labelLeft.toFixed(1)} px from the left edge, ${gaps.labelRight.toFixed(1)} px from the right; ` +
              `hit area ${gaps.hitLeft.toFixed(1)} / ${gaps.hitRight.toFixed(1)} px; tab ${state.links[0].hit.width.toFixed(1)} x ${state.links[0].hit.height.toFixed(1)} px`
          );
          for (const [name, gap] of Object.entries(gaps)) {
            if (gap < EDGE_PX) problems.push(`${role}@${width}: ${name} gap is ${gap.toFixed(1)} px, under ${EDGE_PX}`);
          }
          for (const l of state.links) {
            if (l.hit.height < TAP_PX) problems.push(`${role}@${width}: ${l.text} tap target is ${l.hit.height.toFixed(1)} px tall, under ${TAP_PX}`);
            if (l.hit.width < TAP_PX) problems.push(`${role}@${width}: ${l.text} tap target is ${l.hit.width.toFixed(1)} px wide, under ${TAP_PX}`);
            if (l.label.left < l.hit.left || l.label.right > l.hit.right) problems.push(`${role}@${width}: ${l.text} label spills out of its own tab`);
          }
        } finally {
          await page.close();
        }
      }
      console.log(measured.join("\n"));
      assert.deepEqual(problems, []);
    });
  });
}
