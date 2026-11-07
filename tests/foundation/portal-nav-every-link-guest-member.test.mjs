// F10: for EVERY nav link of the role's navigation (the mobile bottom bar
// at 390 wide, the desktop header links at 1280 wide) click it, wait 2 s,
// and assert in the rendered page:
//   (a) location.hash equals the link's href (it was not redirected),
//   (b) the screen that mounted is that tab's own screen (the root x-data
//       of the mounted view), not Today's or another tab's,
//   (c) exactly that tab, and no other, is highlighted: aria-current is
//       "page" on it alone, and it LOOKS different from the rest.
// Shared machinery and the reason for this test: portal-nav-probe.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPuppeteer, withBrowser, walkEveryLink } from "./portal-nav-probe.mjs";

for (const role of ["guest", "member"]) {
  test(`F10 ${role}: every bottom-bar tab at 390 renders its own screen, keeps its hash, and is the one highlighted`, { timeout: 170000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");
    await withBrowser(puppeteer, async (browser) => {
      assert.deepEqual(await walkEveryLink(browser, role, 390), []);
    });
  });

  test(`F10 ${role}: every desktop header link at 1280 renders its own screen, keeps its hash, and is the one highlighted`, { timeout: 170000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");
    await withBrowser(puppeteer, async (browser) => {
      assert.deepEqual(await walkEveryLink(browser, role, 1280), []);
    });
  });
}
