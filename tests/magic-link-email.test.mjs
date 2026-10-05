// M2: the magic-link email send (PIN L5: "magic links go out through the
// Cloudflare Email Service `send_email` binding named `EMAIL`, From
// `Jungle Pickleball <portal@junglepickleball.com>`"). The binding is a
// recording stand-in; everything else is real: the router, the auth
// code, and a SQLite database built from the project's migrations.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prodDb, addAccount, PROD_ORIGIN } from "./launch-helpers.mjs";
import { handlePortalRequest } from "../src/portal/router.js";
import { authStart } from "../src/portal/auth.js";

let db;
let sent;
let EMAIL;

beforeEach(() => {
  db = prodDb();
  sent = [];
  EMAIL = { send: async (message) => (sent.push(message), { messageId: `m${sent.length}` }) };
});

async function start(email, { env = { EMAIL }, origin = PROD_ORIGIN, ip = "203.0.113.7", headers = {} } = {}) {
  const url = new URL("/api/portal/auth/start", origin);
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip, ...headers },
    body: JSON.stringify({ email }),
  });
  const response = await handlePortalRequest(request, { PORTAL_DB: db, ...env }, url);
  return { status: response.status, body: await response.json() };
}

// Runs fn and returns everything the code wrote to the console.
async function captureLogs(fn) {
  const lines = [];
  const original = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    original[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

const tokenFrom = (message) => /#login=([0-9a-f]{64})/.exec(message.text)[1];

test("one send per request, from Jungle Pickleball <portal@junglepickleball.com>, to the address given", async () => {
  const r = await start("  Player@Example.com ");
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].from, { email: "portal@junglepickleball.com", name: "Jungle Pickleball" });
  assert.equal(sent[0].to, "player@example.com");
  assert.equal(sent[0].subject, "Your Jungle Pickleball sign-in link");
});

test("the message carries the fragment link and the 15 minute wording, in text and html, with no em dash", async () => {
  await start("player@example.com");
  const [message] = sent;
  const link = /https:\/\/junglepickleball\.com\/portal\/#login=[0-9a-f]{64}/;
  assert.match(message.text, link);
  assert.match(message.html, link);
  assert.doesNotMatch(message.text, /\?token|\?login/, "the token travels in the fragment, never a query string");
  for (const part of [message.text, message.html]) assert.match(part, /15 minutes/);
  const dashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
  for (const part of [message.subject, message.text, message.html]) assert.doesNotMatch(part, dashes, "no em or en dash in copy");
});

test("the emailed link is the real one: verifying its token signs the person in", async () => {
  await start("player@example.com");
  const token = tokenFrom(sent[0]);
  const url = new URL("/api/portal/auth/verify", PROD_ORIGIN);
  const response = await handlePortalRequest(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: PROD_ORIGIN }, body: JSON.stringify({ token, age_16_plus: true }) }),
    { PORTAL_DB: db },
    url
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account.email, "player@example.com");
});

test("the response is identical whether or not the account exists, and a send happens either way", async () => {
  addAccount(db, { id: "m1", email: "known@example.com" });
  const known = await start("known@example.com", { ip: "203.0.113.1" });
  const unknown = await start("never-seen@example.com", { ip: "203.0.113.2" });
  assert.deepEqual(known, unknown);
  assert.deepEqual(sent.map((m) => m.to), ["known@example.com", "never-seen@example.com"]);
});

test("the existing limits hold: a 6th request for one email, and a 21st from one IP, send nothing and answer the same", async () => {
  for (let i = 0; i < 5; i++) await start("same@example.com");
  assert.equal(sent.length, 5);
  const sixth = await start("same@example.com");
  assert.deepEqual([sixth.status, sixth.body], [200, { ok: true }]);
  assert.equal(sent.length, 5, "the limited request sends nothing");

  sent.length = 0;
  for (let i = 0; i < 20; i++) await start(`user${i}@example.com`, { ip: "198.51.100.9" });
  assert.equal(sent.length, 20);
  const twentyFirst = await start("user99@example.com", { ip: "198.51.100.9" });
  assert.deepEqual([twentyFirst.status, twentyFirst.body], [200, { ok: true }]);
  assert.equal(sent.length, 20, "the IP-limited request sends nothing");
});

test("the token is never logged, and neither is the address", async () => {
  const logs = await captureLogs(() => start("player@example.com"));
  const token = tokenFrom(sent[0]);
  assert.ok(!logs.includes(token), "token in logs");
  assert.ok(!logs.includes("player@example.com"), "address in logs");
});

test("EMAIL absent and no dev login: a clear JSON error, nothing sent, nothing stored, no address in the log", async () => {
  const logs = await captureLogs(async () => {
    const r = await start("player@example.com", { env: {} });
    assert.deepEqual([r.status, r.body], [503, { error: "email_unavailable" }]);
  });
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM login_tokens`).get().n, 0);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM rate_limits`).get().n, 0);
  assert.match(logs, /email_not_configured/);
  assert.ok(!logs.includes("player@example.com"));
  assert.equal(sent.length, 0);
});

test("on a preview host the binding is never used: the portal hands handlers no EMAIL there, and without dev login it fails closed", async () => {
  const preview = prodDb();
  preview.sqlite.prepare(`UPDATE portal_meta SET env = 'preview'`).run();
  const origin = "https://abcd1234-junglepickleball-com.cwasylishen.workers.dev";
  const url = new URL("/api/portal/auth/start", origin);
  const response = await handlePortalRequest(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email: "player@example.com" }) }),
    { PORTAL_DB: preview, EMAIL },
    url
  );
  assert.equal(response.status, 503);
  assert.equal(sent.length, 0);
});

test("the demo path is unchanged: dev login active on a demo-eligible host and no EMAIL still answers the generic ok", async () => {
  const url = new URL("http://127.0.0.1/");
  const call = (env) =>
    authStart(new Request(url, { method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "anyone@example.com" }) }), env, db, url);
  const withDevLogin = await call({ PORTAL_DEV_LOGIN: "1" });
  assert.deepEqual([withDevLogin.status, await withDevLogin.json()], [200, { ok: true }]);
  const without = await call({});
  assert.equal(without.status, 503);
});

test("a send that fails is counted, logged by code only, and the caller still gets the generic ok", async () => {
  EMAIL.send = async () => {
    const err = new Error("recipient player@example.com is suppressed");
    err.code = "E_RECIPIENT_SUPPRESSED";
    throw err;
  };
  let result;
  const logs = await captureLogs(async () => {
    result = await start("player@example.com");
  });
  assert.deepEqual([result.status, result.body], [200, { ok: true }]);
  assert.match(logs, /email_send_failed/);
  assert.match(logs, /E_RECIPIENT_SUPPRESSED/);
  assert.ok(!logs.includes("player@example.com"), "the error message names the address; it must not reach the log");
  const counter = db.sqlite.prepare(`SELECT SUM(value) AS n FROM portal_meta_counters WHERE key LIKE 'email_send_failed:%'`).get();
  assert.equal(counter.n, 1);
});

test("an address that could address more than one mailbox, or inject a header, is refused before anything is sent", async () => {
  const bad = ["a@b.example, c@d.example", "a@b.example\nBcc: x@y.example", "a b@c.example", "no-at-sign", "a@@b.example", "<a@b.example>", `${"x".repeat(250)}@b.example`, "a@b.example;c@d.example"];
  for (const email of bad) {
    const r = await start(email);
    assert.equal(r.status, 400, JSON.stringify(email));
  }
  assert.equal(sent.length, 0);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM login_tokens`).get().n, 0);
});

test("a request with no Origin is refused and sends nothing", async () => {
  const url = new URL("/api/portal/auth/start", PROD_ORIGIN);
  const response = await handlePortalRequest(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "player@example.com" }) }),
    { PORTAL_DB: db, EMAIL },
    url
  );
  assert.equal(response.status, 403);
  assert.equal(sent.length, 0);
});
