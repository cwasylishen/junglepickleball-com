// F12: the owner's Manage screen must not say "All settings confirmed" before
// it knows. While its counts were loading (count 0) the top line read the
// all-clear, a false all-clear on the owner's first visit. Ruling: a neutral
// loading line until the counts are in; after a failed load, a neutral error
// line; the all-clear only for a load that came back with nothing to confirm.
//
// Real headless Chromium against the local `wrangler dev`, like
// portal-nav-*.test.mjs (NODE_PATH=/home/mike/wzq/node_modules; skips, not
// red, without puppeteer-core). The counts endpoint is held ~2 s by request
// interception so the loading state can be read; everything else (the
// session, /me, the health call, the page itself) is the real server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPuppeteer, withBrowser, openPortal } from "./portal-nav-probe.mjs";

const ALL_CLEAR = "All settings confirmed";
const LOADING = "Checking settings…";
const COUNTS_PATH = "/api/portal/owner/resources";
const HOLD_MS = 2000;

const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

// What the owner can read on the Manage screen: the line under the heading,
// the right-hand text of the first two rows, and the whole screen's text.
function readManage() {
  const root = document.querySelector('#portal-area [x-data="ownerManage()"]');
  if (!root) return null;
  const rows = [...root.querySelectorAll("a")].map((a) => (a.querySelectorAll("span")[1] || { textContent: "" }).textContent.trim());
  return {
    top: root.querySelector("h1 + p") ? root.querySelector("h1 + p").textContent.trim() : null,
    resourcesRow: rows[0],
    pricesRow: rows[1],
    screen: root.textContent.replace(/\s+/g, " "),
  };
}

// Open the owner's portal, then go to Manage with the counts request
// answered by `answer(request)` after `holdMs`. Returns the page, a promise
// for the moment the counts request was seen, and a promise for the moment
// it was answered.
async function openManage(browser, answer, holdMs) {
  const page = await openPortal(browser, "owner", 390);
  let seen, answered;
  const seenP = new Promise((r) => (seen = r));
  const answeredP = new Promise((r) => (answered = r));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    // Only Manage's own call is held: the Today screen, still settling when
    // the page opens, makes the same call and must pass straight through.
    const fromManage = page.url().endsWith("#/manage");
    if (path !== COUNTS_PATH || req.method() !== "GET" || !fromManage) return req.continue();
    seen();
    setTimeout(() => {
      Promise.resolve(answer(req)).then(() => answered(), () => answered());
    }, holdMs);
  });
  await page.evaluate(() => { window.location.hash = "#/manage"; });
  return { page, seenP, answeredP };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTop(page, predicate, what) {
  const deadline = Date.now() + 20000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(readManage);
    if (last && predicate(last)) return last;
    await pause(100);
  }
  assert.fail(`${what}: not reached in 20 s; last reading ${JSON.stringify(last)}`);
}

test("F12 Manage: while the counts load, the neutral loading line shows and the all-clear does not; then 0 to confirm shows the all-clear", { timeout: 120000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");
  await withBrowser(puppeteer, async (browser) => {
    const { page, seenP, answeredP } = await openManage(browser, (req) => req.respond(json(200, [])), HOLD_MS);
    try {
      await seenP;
      // Two readings while the response is still being held.
      for (const wait of [300, 900]) {
        await pause(wait);
        const during = await page.evaluate(readManage);
        assert.ok(during, "the Manage screen is mounted while the counts load");
        assert.ok(!during.screen.includes(ALL_CLEAR), `all-clear shown before the data loaded: "${during.top}"`);
        assert.equal(during.top, LOADING, "the loading line shows while the counts load");
        assert.equal(during.resourcesRow, "", "the courts row shows no count while loading");
      }
      await answeredP;
      const after = await waitForTop(page, (r) => r.top !== LOADING, "loaded, 0 to confirm");
      assert.equal(after.top, ALL_CLEAR);
      assert.equal(after.resourcesRow, "");
    } finally {
      await page.close();
    }
  });
});

test("F12 Manage: with 2 of 3 courts on default settings, loading then '2 to confirm' (never the all-clear)", { timeout: 120000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");
  await withBrowser(puppeteer, async (browser) => {
    const rows = [
      { id: "r1", unconfirmed_fields: ["hours", "price"] },
      { id: "r2", unconfirmed_fields: [] },
      { id: "r3", unconfirmed_fields: ["hours"] },
    ];
    const { page, seenP, answeredP } = await openManage(browser, (req) => req.respond(json(200, rows)), HOLD_MS);
    try {
      await seenP;
      await pause(500);
      const during = await page.evaluate(readManage);
      assert.ok(!during.screen.includes(ALL_CLEAR), `all-clear shown while loading: "${during.top}"`);
      assert.equal(during.top, LOADING);
      assert.equal(during.resourcesRow, "", "no count on the courts row while loading");
      await answeredP;
      const after = await waitForTop(page, (r) => r.top !== LOADING, "loaded, 2 to confirm");
      assert.equal(after.top, "2 courts or services still have default settings to check");
      assert.equal(after.resourcesRow, "2 to confirm");
      assert.ok(!after.screen.includes(ALL_CLEAR));
    } finally {
      await page.close();
    }
  });
});

for (const [name, answer] of [
  ["a server error (500)", (req) => req.respond(json(500, { error: "internal" }))],
  ["a refused request (offline)", (req) => req.abort("failed")],
]) {
  test(`F12 Manage: ${name} on the counts call shows a neutral error line, never the all-clear`, { timeout: 120000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");
    await withBrowser(puppeteer, async (browser) => {
      const { page, seenP, answeredP } = await openManage(browser, answer, HOLD_MS);
      try {
        await seenP;
        await pause(500);
        const during = await page.evaluate(readManage);
        assert.ok(!during.screen.includes(ALL_CLEAR), `all-clear shown while loading: "${during.top}"`);
        await answeredP;
        const after = await waitForTop(page, (r) => r.top !== LOADING, "failed load");
        assert.ok(!after.screen.includes(ALL_CLEAR), `all-clear shown after a failed load: "${after.top}"`);
        assert.equal(after.top, "Could not check your settings. Please try again.");
        assert.equal(after.resourcesRow, "", "no count on the courts row after a failed load");
        // The error line must not read as a count either.
        assert.ok(!/\d+ courts or services/.test(after.top));
      } finally {
        await page.close();
      }
    });
  });
}
