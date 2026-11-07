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
import { ROLES, loadPuppeteer, withBrowser, openPortal, readNav, clickVisibleTab, settleOn, walkEveryLink } from "./portal-nav-probe.mjs";

for (const role of ["staff", "owner"]) {
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

// The highlight is the route's, not the click's: Back moves it, and a
// sub-route belongs to its tab (Manage > Prices is still Manage, Account >
// Passkeys is still Account).
test("F10 owner: the highlight follows the route (Back, deep links), not the click", { timeout: 170000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");
  await withBrowser(puppeteer, async (browser) => {
    const { tabs } = ROLES.owner;
    const page = await openPortal(browser, "owner", 390);
    const problems = [];
    try {
      await clickVisibleTab(page, "#/members");
      problems.push(...(await settleOn(page, "#/members", tabs, "owner")));
      await clickVisibleTab(page, "#/account");
      problems.push(...(await settleOn(page, "#/account", tabs, "owner")));
      await page.goBack();
      problems.push(...(await settleOn(page, "#/members", tabs, "owner after Back")));

      for (const [deep, tab] of [["#/manage/prices", "#/manage"], ["#/account/passkeys", "#/account"]]) {
        await page.evaluate((h) => { window.location.hash = h; }, deep);
        await new Promise((r) => setTimeout(r, 2000));
        const state = await page.evaluate(readNav);
        const current = state.links.filter((l) => l.current === "page").map((l) => l.href);
        if (state.hash !== deep) problems.push(`owner deep link ${deep}: hash is "${state.hash}" after 2 s`);
        if (current.length !== 1 || current[0] !== tab) problems.push(`owner deep link ${deep}: aria-current=page on [${current.join(", ")}], expected only [${tab}]`);
      }
    } finally {
      await page.close();
    }
    assert.deepEqual(problems, []);
  });
});
