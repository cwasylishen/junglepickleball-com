// M6 (CTL-HDR-01 + PIN-17) and M7 (CTL-AUTH-05/CTL-UI-04): a real,
// headless Chromium proof -- not a source-text inference -- that the
// live CSP ships with zero violations on /portal/* and that both the
// owner and member views actually render, plus (M7) that a brand-new
// email can complete sign-up through the real UI, including the age
// question the UI must ask (never fabricate).
//
// Requires puppeteer-core + a local Chromium outside this repo's own
// node_modules (NODE_PATH=/home/mike/wzq/node_modules, no system
// Chromium download here) -- skips cleanly, not red, when that is not
// on NODE_PATH, so `npm test`'s default invocation (no NODE_PATH) still
// exits 0. The dispatch's own proof run sets NODE_PATH explicitly.
//
// setBypassCSP is never called anywhere in this file -- the whole point
// is the REAL browser CSP enforcement, not a bypassed one.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { d1, BASE_URL, startAndGetDevLink, makeClient } from "./helpers.mjs";
import { sha256Hex } from "../../src/portal/auth.js";

const CHROMIUM_PATH = "/usr/bin/chromium-browser";

// Node's ESM loader does not honour NODE_PATH for bare specifiers, so
// `import("puppeteer-core")` alone never finds the dependency sitting
// outside this repo's own node_modules -- the resolver is pointed at
// the exact package entry (its own package.json "exports") on whatever
// NODE_PATH-listed root is configured, so NODE_PATH stays the single
// knob the dispatch names for this proof.
async function loadPuppeteer() {
  const roots = (process.env.NODE_PATH || "").split(":").filter(Boolean);
  for (const root of roots) {
    try {
      return await import(new URL(`${root}/puppeteer-core/lib/puppeteer/puppeteer-core.js`, "file://").href);
    } catch {
      // try the next NODE_PATH root, if any
    }
  }
  return null;
}

async function withPage(puppeteer, fn) {
  const browser = await puppeteer.launch({ executablePath: CHROMIUM_PATH, headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const violations = [];
    await page.evaluateOnNewDocument(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });
    page.on("console", (msg) => {
      if (/Content Security Policy|Refused to/.test(msg.text())) violations.push(msg.text());
    });
    await fn(page, violations);
  } finally {
    await browser.close();
  }
}

async function tokenFromDevLink(client, email) {
  const devLink = await startAndGetDevLink(client, email, { Origin: BASE_URL });
  return new URL(devLink).hash.replace(/^#login=/, "");
}

test("M6: /portal renders the member view via a real login fragment with zero CSP violations", async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules to execute this proof");

  await withPage(puppeteer, async (page, consoleViolations) => {
    const token = await tokenFromDevLink(makeClient(), "member.demo@jp-demo.test");
    await page.goto(`${BASE_URL}/portal/#login=${encodeURIComponent(token)}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.textContent.includes("Signed in as"), { timeout: 10000 });
    const bodyText = await page.evaluate(() => document.body.textContent);
    assert.match(bodyText, /Signed in as member\.demo@jp-demo\.test/);
    assert.match(bodyText, /\(member\)/);
    const domViolations = await page.evaluate(() => window.__cspViolations);
    assert.deepEqual(domViolations, [], `CSP violations fired: ${JSON.stringify(domViolations)}`);
    assert.deepEqual(consoleViolations, [], `CSP console errors: ${JSON.stringify(consoleViolations)}`);
  });
});

test("M6: /portal renders the owner view via a real login fragment with zero CSP violations", async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  await withPage(puppeteer, async (page, consoleViolations) => {
    const token = await tokenFromDevLink(makeClient(), "owner.demo@jp-demo.test");
    await page.goto(`${BASE_URL}/portal/#login=${encodeURIComponent(token)}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.textContent.includes("Signed in as"), { timeout: 10000 });
    const bodyText = await page.evaluate(() => document.body.textContent);
    assert.match(bodyText, /Signed in as owner\.demo@jp-demo\.test/);
    assert.match(bodyText, /\(owner\)/);
    const domViolations = await page.evaluate(() => window.__cspViolations);
    assert.deepEqual(domViolations, [], `CSP violations fired: ${JSON.stringify(domViolations)}`);
    assert.deepEqual(consoleViolations, [], `CSP console errors: ${JSON.stringify(consoleViolations)}`);
  });
});

test("M7 RED->GREEN: a brand-new email completes sign-up through the real UI, age question asked and answered", async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  const email = `newsignup-m7-${Date.now()}@jp-demo.test`;
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = await sha256Hex(rawToken);
  const nowIsoStr = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  d1(
    `INSERT INTO login_tokens (id, email, token_hash, created_at, expires_at, ip) VALUES ('tok-m7-${Date.now()}', '${email}', '${tokenHash}', '${nowIsoStr}', '${expiresIso}', '127.0.0.1')`
  );

  try {
    await withPage(puppeteer, async (page) => {
      await page.goto(`${BASE_URL}/portal/#login=${encodeURIComponent(rawToken)}`, { waitUntil: "networkidle0" });
      // RED (pre-M7): the shell has no handler for age_confirmation_required
      // at all, so this prompt never appears -- a new email is stuck.
      await page.waitForFunction(() => document.body.textContent.includes("Confirm your age"), { timeout: 10000 });

      await page.click('input[type="checkbox"]');
      const verifyResponse = page.waitForResponse(
        (res) => res.url().endsWith("/api/portal/auth/verify") && res.request().method() === "POST"
      );
      await page.click("#age-confirm-submit");
      const res = await verifyResponse;
      assert.equal(res.status(), 200, "GREEN: the retried verify (now WITH the person's actual answer) must succeed");
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.account.email, email);
    });
  } finally {
    // One combined statement (not several separate CLI round-trips):
    // `wrangler dev`'s hot-reload (another part's concurrent edit
    // elsewhere in this shared tree) can drop the CLI's own d1
    // connection mid-command, exactly as helpers.mjs's own fetch-retry
    // comment describes, and under this suite's load each extra
    // invocation is another chance to hit that window. This account
    // must not survive a transient failure here -- it is a non-demo
    // row, and CTL-ENV-02 fails every other request on this server
    // while it exists.
    const cleanupSql = `
      DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email = '${email}');
      DELETE FROM audit_log WHERE actor_account_id IN (SELECT id FROM accounts WHERE email = '${email}') OR target_id IN (SELECT id FROM accounts WHERE email = '${email}');
      DELETE FROM login_tokens WHERE email = '${email}';
      DELETE FROM accounts WHERE email = '${email}';
    `;
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        d1(cleanupSql);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (lastErr) throw lastErr;
  }
});
