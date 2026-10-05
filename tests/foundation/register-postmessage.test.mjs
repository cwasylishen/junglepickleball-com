// F-01 (security audit, HIGH): /register trusted every postMessage. Its
// listener never looked at e.origin or e.source, and `redirectAfterLogin`
// did window.location.href = e.data.urlToRedirect, so any page that opened
// /register in a window could run `javascript:` on junglepickleball.com or
// bounce the visitor to a phishing site.
//
// What is proved here, in a real Chromium (not by reading the source):
//   * a foreign origin cannot drive the page (javascript:, data:, https);
//   * the CourtReserve origin is not enough: the sender must be the embedded
//     iframe's own window;
//   * the embedded iframe CAN redirect, but only to https + an allow-listed
//     origin, and setHeight / scrollBottom ignore non-numeric values;
//   * with the /register headers from _headers applied (COOP + CSP) the
//     widget still loads with no CSP violation, and a cross-origin opener is
//     cut off from the page.
//
// Hermetic: every hostname (junglepickleball.com, widgets.courtreserve.com,
// an attacker host, ...) is mapped to one local HTTPS server, so the page
// really runs at the https://junglepickleball.com origin with no network.
//
// Needs puppeteer-core + Chromium: NODE_PATH=/home/mike/wzq/node_modules.
// Skips cleanly (not red) without it, like portal-shell-headless.test.mjs.
// REGISTER_HTML=<path> runs the same attacks against another copy of the
// page (used to show the test red on the pre-fix file).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTER_PATH = process.env.REGISTER_HTML || path.join(REPO, "register.html");
const CHROMIUM_PATH = "/usr/bin/chromium-browser";
const SITE = "https://junglepickleball.com";
const REGISTER_URL = `${SITE}/register`;
const CR = "https://widgets.courtreserve.com";
const EVIL = "https://evil.example";

// ---- the headers the live site will send for /register ----------------

function headersForPath(headersFile, urlPath) {
  const lines = headersFile.split("\n");
  const start = lines.findIndex((l) => l === urlPath);
  if (start === -1) return null;
  const out = {};
  for (let i = start + 1; i < lines.length && lines[i].startsWith("  "); i++) {
    const [name, ...rest] = lines[i].trim().split(":");
    out[name.trim()] = rest.join(":").trim();
  }
  return out;
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function sha256Source(text) {
  return `'sha256-${crypto.createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

const headersFile = fs.readFileSync(path.join(REPO, "_headers"), "utf8");
const registerHtml = fs.readFileSync(REGISTER_PATH, "utf8");

// ---- static checks on _headers ----------------------------------------

test("F-01: /register and /register.html both carry COOP and a CSP with no script 'unsafe-inline'", () => {
  for (const urlPath of ["/register", "/register.html"]) {
    const h = headersForPath(headersFile, urlPath);
    assert.ok(h, `_headers has no rule for ${urlPath}`);
    assert.equal(h["Cross-Origin-Opener-Policy"], "same-origin-allow-popups", `${urlPath} COOP`);
    const csp = h["Content-Security-Policy"];
    assert.ok(csp, `${urlPath} has no Content-Security-Policy`);
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
    assert.ok(scriptSrc, `${urlPath} CSP has no script-src`);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `${urlPath} script-src allows unsafe-inline: ${scriptSrc}`);
    assert.match(csp, /frame-src https:\/\/widgets\.courtreserve\.com(;|$)/, `${urlPath} frame-src`);
  }
});

// F7: the Cloudflare Web Analytics beacon loads from static.cloudflareinsights.com
// and reports to cloudflareinsights.com. Those two sources, and nothing wider,
// are added; script-src still has no 'unsafe-inline' (the existing test above).
test("F7: /register and /register.html allow the Web Analytics beacon script and its report endpoint", () => {
  for (const urlPath of ["/register", "/register.html"]) {
    const csp = headersForPath(headersFile, urlPath)["Content-Security-Policy"];
    const directive = (name) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
    const scriptSrc = directive("script-src").split(/\s+/);
    const connectSrc = directive("connect-src").split(/\s+/);
    assert.ok(scriptSrc.includes("https://static.cloudflareinsights.com"), `${urlPath} script-src: ${scriptSrc.join(" ")}`);
    assert.ok(connectSrc.includes("https://cloudflareinsights.com"), `${urlPath} connect-src: ${connectSrc.join(" ")}`);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `${urlPath} script-src allows unsafe-inline: ${scriptSrc.join(" ")}`);
  }
});

test("F-01: every inline script on the page is allowed by hash, and only those", () => {
  const scripts = inlineScripts(registerHtml);
  assert.ok(scripts.length >= 1, "no inline scripts found; the extractor is broken");
  const csp = headersForPath(headersFile, "/register")["Content-Security-Policy"];
  const allowedHashes = [...csp.matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)].map((m) => m[0]);
  const wanted = scripts.map(sha256Source);
  assert.deepEqual([...allowedHashes].sort(), [...wanted].sort(),
    "CSP hashes differ from the page's inline scripts: edit register.html and the hashes in _headers together");
  assert.deepEqual(headersForPath(headersFile, "/register.html"), headersForPath(headersFile, "/register"),
    "/register and /register.html must carry identical headers");
});

// ---- hermetic HTTPS site + browser ------------------------------------

async function loadPuppeteer() {
  for (const root of (process.env.NODE_PATH || "").split(":").filter(Boolean)) {
    try {
      return await import(new URL(`${root}/puppeteer-core/lib/puppeteer/puppeteer-core.js`, "file://").href);
    } catch {
      // try the next NODE_PATH root
    }
  }
  return null;
}

const puppeteer = await loadPuppeteer();
let server;
let serverPort;
let browser;
let sendRegisterHeaders = false;

const landing = (name) => `<!doctype html><title>LANDED ${name}</title><p>${name}</p>`;

const WIDGET_STUB = "<!doctype html><title>widget stub</title><p>CourtReserve widget stub</p>";

function handle(req, res) {
  const host = (req.headers.host || "").split(":")[0];
  const urlPath = new URL(req.url, "https://x").pathname;
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { "content-type": type, ...extra });
    res.end(body);
  };
  if (host === "junglepickleball.com" || host === "www.junglepickleball.com") {
    if (urlPath === "/register") {
      const extra = sendRegisterHeaders ? headersForPath(headersFile, "/register") : {};
      return send(200, "text/html; charset=utf-8", registerHtml, extra);
    }
    if (urlPath === "/assets/styles.css") {
      return send(200, "text/css", fs.readFileSync(path.join(REPO, "assets/styles.css")));
    }
    return send(200, "text/html", landing(host + urlPath));
  }
  if (host === "widgets.courtreserve.com") {
    return send(200, "text/html", urlPath.startsWith("/Online/Public/EmbedCode/") ? WIDGET_STUB : landing(host + urlPath));
  }
  if (host === "app.courtreserve.com" || host === "evil.example") {
    return send(200, "text/html", landing(host + urlPath));
  }
  if (host === "fonts.googleapis.com") return send(200, "text/css", "/* fonts */");
  return send(204, "text/plain", "");
}

before(async () => {
  if (!puppeteer) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f01-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=test",
    "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
  server = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = server.address().port;
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: "new",
    args: ["--no-sandbox", "--ignore-certificate-errors", "--disable-popup-blocking",
      `--host-resolver-rules=MAP * 127.0.0.1:${serverPort}, EXCLUDE localhost`],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE_MS = 700; // the page redirects after a 100 ms timer; wait well past it

// Returns false (and skips) without puppeteer. Otherwise closes every page a
// previous test left open (a failed assertion skips that test's own cleanup,
// and a stale popup at the same URL would be picked up as this test's popup).
async function startTest(t) {
  if (!puppeteer) { t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules"); return false; }
  const keep = await browser.newPage();
  for (const page of await browser.pages()) {
    if (page !== keep) await page.close();
  }
  return true;
}

async function newPage(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  return page;
}

// Opens /register in a popup from `opener` and returns the popup page with
// dialog + execution tracking attached.
async function openRegisterFrom(opener) {
  await opener.evaluate((u) => { window.__w = window.open(u); }, REGISTER_URL);
  const target = await browser.waitForTarget((x) => x.url() === REGISTER_URL && x !== opener.target(), { timeout: 10000 });
  const popup = await target.page();
  popup.__dialogs = [];
  popup.on("dialog", (d) => { popup.__dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await popup.waitForFunction(() => document.readyState === "complete");
  await markAlive(popup);
  return popup;
}

// window.__alive is set once the page has loaded; if it is gone the page was
// reloaded or replaced (a redirect to the page's own URL keeps the URL equal).
const markAlive = (page) => page.evaluate(() => { window.__alive = true; });

async function assertUntouched(popup, why) {
  await sleep(SETTLE_MS);
  assert.equal(await popup.evaluate(() => window.__alive), true, `${why}: page was reloaded or replaced`);
  assert.equal(popup.url(), REGISTER_URL, `${why}: page navigated to ${popup.url()}`);
  assert.deepEqual(popup.__dialogs, [], `${why}: script ran (dialog ${JSON.stringify(popup.__dialogs)})`);
  assert.equal(await popup.evaluate(() => window.__pwned), undefined, `${why}: script ran (flag set)`);
}

const JS_PAYLOAD = "javascript:window.__pwned=1;alert(1)";
const DATA_PAYLOAD = "data:text/html,<script>alert(1)</script>";

// ---- foreign origin (headers off: the JS fix on its own) --------------

for (const [name, url] of [["javascript:", JS_PAYLOAD], ["data:", DATA_PAYLOAD], ["https open redirect", `${EVIL}/phish`], ["allow-listed https", "https://app.courtreserve.com/landed"]]) {
  test(`F-01: a foreign origin that opens /register cannot make it navigate (${name})`, async (t) => {
    if (!(await startTest(t))) return;
    sendRegisterHeaders = false;
    const attacker = await newPage(`${EVIL}/attack`);
    const popup = await openRegisterFrom(attacker);
    await attacker.evaluate((d) => window.__w.postMessage(d, "*"), { action: "redirectAfterLogin", urlToRedirect: url });
    await assertUntouched(popup, `foreign origin, ${name}`);
    await attacker.close(); await popup.close();
  });
}

test("F-01: the CourtReserve origin is not enough, the sender must be the embedded iframe (other window, right origin)", async (t) => {
  if (!(await startTest(t))) return;
  sendRegisterHeaders = false;
  const crTop = await newPage(`${CR}/some-other-courtreserve-page`);
  const popup = await openRegisterFrom(crTop);
  for (const url of [JS_PAYLOAD, "https://app.courtreserve.com/landed"]) {
    await crTop.evaluate((d) => window.__w.postMessage(d, "*"), { action: "redirectAfterLogin", urlToRedirect: url });
    await assertUntouched(popup, `CourtReserve origin but not the iframe, ${url}`);
  }
  await crTop.close(); await popup.close();
});

test("F-01: the right window is not enough, the origin must be CourtReserve (the iframe itself navigated elsewhere)", async (t) => {
  if (!(await startTest(t))) return;
  sendRegisterHeaders = false; // with the CSP on, frame-src would stop the iframe from navigating away at all
  const page = await newPage(REGISTER_URL);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await markAlive(page);
  const widget = page.frames().find((f) => f.url().startsWith(CR));
  assert.ok(widget, "widget iframe missing");
  await widget.evaluate((u) => { window.location.href = u; }, `${EVIL}/hijacked-frame`);
  await page.waitForFrame((f) => f.url() === `${EVIL}/hijacked-frame`, { timeout: 5000 });
  const hijacked = page.frames().find((f) => f.url() === `${EVIL}/hijacked-frame`);
  // an allow-listed target, so only the origin check (not the host allow-list) can stop it
  await hijacked.evaluate((d) => window.parent.postMessage(d, "*"), { action: "redirectAfterLogin", urlToRedirect: "https://app.courtreserve.com/landed" });
  await assertUntouched(page, "iframe window, evil origin");
  await page.close();
});

test("F-01: the page posting to itself (its own origin) is ignored", async (t) => {
  if (!(await startTest(t))) return;
  sendRegisterHeaders = false;
  const page = await newPage(REGISTER_URL);
  page.__dialogs = [];
  await markAlive(page);
  await page.evaluate(() => window.postMessage({ action: "redirectAfterLogin", urlToRedirect: "https://app.courtreserve.com/landed" }, "*"));
  await assertUntouched(page, "self-posted message");
  await page.close();
});

// ---- headers on: COOP + CSP -------------------------------------------

test("F-01: with the /register headers, a cross-origin opener is cut off (window.opener is null) and nothing runs", async (t) => {
  if (!(await startTest(t))) return;
  sendRegisterHeaders = true;
  const attacker = await newPage(`${EVIL}/attack`);
  const popup = await openRegisterFrom(attacker);
  assert.equal(await popup.evaluate(() => window.opener), null, "COOP should sever the opener");
  await attacker.evaluate((d) => window.__w.postMessage(d, "*"), { action: "redirectAfterLogin", urlToRedirect: JS_PAYLOAD });
  await assertUntouched(popup, "foreign origin with COOP+CSP");
  await attacker.close(); await popup.close();
});

test("F-01: with the CSP alone (no origin check could save it) a javascript: navigation is refused by the browser", async (t) => {
  if (!(await startTest(t))) return;
  sendRegisterHeaders = true;
  const page = await newPage(REGISTER_URL);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  const violations = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    document.addEventListener("securitypolicyviolation", (e) => seen.push(e.violatedDirective));
    window.location.href = "javascript:window.__pwned=1";
    setTimeout(() => resolve(seen), 400);
  }));
  assert.equal(await page.evaluate(() => window.__pwned), undefined, "javascript: URL executed despite the CSP");
  assert.ok(violations.some((v) => v.startsWith("script-src")), `expected a script-src violation, got ${JSON.stringify(violations)}`);
  await page.close();
});

test("F-01: with the headers on, the widget iframe loads and the page reports no CSP violation", async (t) => {
  if (!(await startTest(t))) return;
  sendRegisterHeaders = true;
  const page = await browser.newPage();
  const consoleCsp = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text())) consoleCsp.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective}: ${e.blockedURI}`));
  });
  await page.goto(REGISTER_URL, { waitUntil: "networkidle0" });
  const widgetFrame = page.frames().find((f) => f.url().startsWith(CR));
  assert.ok(widgetFrame, "the CourtReserve widget iframe did not load");
  assert.deepEqual(await page.evaluate(() => window.__csp), [], "CSP violations");
  assert.deepEqual(consoleCsp, [], "CSP console errors");
  await page.close();
});

// ---- the embedded iframe: what must keep working ----------------------

async function registerWithWidget() {
  sendRegisterHeaders = true;
  const page = await browser.newPage();
  await page.goto(REGISTER_URL, { waitUntil: "networkidle0" });
  const widget = page.frames().find((f) => f.url().startsWith(CR));
  assert.ok(widget, "widget iframe missing");
  await markAlive(page);
  return { page, post: (data) => widget.evaluate((d) => window.parent.postMessage(d, "*"), data) };
}

for (const [name, url] of [
  ["the CourtReserve app host", "https://app.courtreserve.com/landed"],
  ["the www site", "https://www.junglepickleball.com/landed"],
  ["a relative path", "/landed"],
]) {
  test(`F-01: the embedded iframe can still redirect after login to ${name}`, async (t) => {
    if (!(await startTest(t))) return;
    const { page, post } = await registerWithWidget();
    await post({ action: "redirectAfterLogin", urlToRedirect: url });
    await page.waitForFunction(() => document.title.startsWith("LANDED"), { timeout: 5000 });
    assert.match(page.url(), /\/landed$/);
    await page.close();
  });
}

test("F-01: the embedded iframe cannot redirect to javascript:, data:, http, or look-alike hosts", async (t) => {
  if (!(await startTest(t))) return;
  const { page, post } = await registerWithWidget();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  const refused = [
    JS_PAYLOAD,
    DATA_PAYLOAD,
    "http://app.courtreserve.com/landed",
    `${EVIL}/phish`,
    "https://app.courtreserve.com.evil.example/landed",
    "https://junglepickleball.com.evil.example/landed",
    "https://app.courtreserve.com@evil.example/landed",
    "https://widgets.courtreserve.com:8443/landed",
    "//evil.example/landed",
    "\\\\evil.example/landed",
    "",
    null,
    42,
    { href: "https://app.courtreserve.com/landed" },
  ];
  for (const url of refused) {
    await post({ action: "redirectAfterLogin", urlToRedirect: url });
    await assertUntouched(page, `embedded iframe, ${JSON.stringify(url)}`);
  }
  for (const data of ["a string", 7, null, [], { action: 5 }, {}]) {
    await post(data);
  }
  await assertUntouched(page, "non-object / action-less messages");
  await page.close();
});

test("F-01: setHeight takes a finite number (clamped) and ignores everything else", async (t) => {
  if (!(await startTest(t))) return;
  const { page, post } = await registerWithWidget();
  const height = () => page.evaluate(() => document.getElementById("form-iframe").getAttribute("height"));
  const styleHeight = () => page.evaluate(() => document.getElementById("form-iframe").style.height);
  await post({ action: "setHeight", height: 1234 });
  assert.equal(await waitFor(height, "1234px"), "1234px");
  await post({ action: "setHeight", height: "1500" });
  assert.equal(await waitFor(height, "1500px"), "1500px");
  for (const bad of ["abc", "12px;background:red", null, undefined, NaN, Infinity, {}, [], true]) {
    await post({ action: "setHeight", height: bad });
    await sleep(60);
    assert.equal(await height(), "1500px", `height ${String(bad)} was applied`);
  }
  await post({ action: "setHeight", height: 99999999 });
  assert.equal(await waitFor(height, "10000px"), "10000px", "huge height not clamped");
  await post({ action: "setHeight", height: -50 });
  assert.equal(await waitFor(height, "0px"), "0px", "negative height not clamped");
  // the embedCodeId path (class lookup) validates the same way
  await post({ action: "setHeight", embedCodeId: "103824", height: 800 });
  assert.equal(await waitFor(styleHeight, "800px"), "800px");
  await post({ action: "setHeight", embedCodeId: "103824", height: "oops" });
  await sleep(60);
  assert.equal(await styleHeight(), "800px");
  await page.close();
});

async function waitFor(read, expected) {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (value === expected) return value;
    await sleep(40);
  }
  return read();
}

test("F-01: scrollBottom scrolls only for a finite number; scrollTop still works", async (t) => {
  if (!(await startTest(t))) return;
  const { page, post } = await registerWithWidget();
  await page.evaluate(() => { window.__scrolls = []; window.scrollTo = (x, y) => window.__scrolls.push([x, y]); });
  const scrolls = () => page.evaluate(() => window.__scrolls);
  await post({ action: "scrollBottom", scrollHeight: 300 });
  await waitFor(async () => (await scrolls()).length, 1);
  assert.deepEqual(await scrolls(), [[0, 300]]);
  for (const bad of ["abc", "javascript:1", NaN, Infinity, {}, [], null, true, 0]) {
    await post({ action: "scrollBottom", scrollHeight: bad });
  }
  await sleep(150);
  assert.deepEqual(await scrolls(), [[0, 300]], "a non-numeric scrollHeight scrolled the page");
  await post({ action: "scrollTop" });
  await waitFor(async () => (await scrolls()).length, 2);
  assert.deepEqual(await scrolls(), [[0, 300], [0, 0]]);
  await page.close();
});
