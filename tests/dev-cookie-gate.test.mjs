// F-07 (independent audit): loadSession accepted the unprefixed
// `jp_portal_dev` cookie on every host, production included, so a session
// token delivered through that cookie weakened the __Host- guarantee. The
// dev cookie is now read only when the dev-login gate is open (the same
// predicate that lets /auth/start hand out a dev link): PORTAL_DEV_LOGIN is
// '1', the host is a demo-eligible one, and the portal_meta marker says
// 'preview'. Anywhere else it is ignored as if it were not sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openTestDb } from "./d1-sqlite.mjs";
import { prodDb, addAccount, sessionFor, callPortal } from "./launch-helpers.mjs";
import { loadSession } from "../src/portal/auth.js";
import { handlePortalRequest } from "../src/portal/router.js";

const DEV_COOKIE = "jp_portal_dev";
const LOCAL = "http://127.0.0.1:8787";

// The same session token, delivered as the dev cookie.
function asDevCookie(session) {
  return { ...session, cookie: session.cookie.replace("__Host-jp_portal=", `${DEV_COOKIE}=`) };
}

// A local-dev database: preview marker, demo accounts only (CTL-ENV-02).
function previewDb() {
  const db = openTestDb();
  db.sqlite.prepare(`INSERT INTO portal_meta (id, env, created_at) VALUES (1, 'preview', 'x')`).run();
  db.sqlite
    .prepare(`INSERT INTO accounts (id, email, role, display_name, is_demo, age_attested_at, created_at, updated_at) VALUES ('demo1','member.demo@jp-demo.test','member','Demo',1,'x','x','x')`)
    .run();
  return db;
}

async function me(db, env, session, origin) {
  const url = new URL("/api/portal/me", origin);
  const request = new Request(url, { headers: { Cookie: session.cookie, Origin: origin } });
  const response = await handlePortalRequest(request, { PORTAL_DB: db, ...env }, url);
  return { status: response.status, data: await response.json() };
}

test("production: a request carrying jp_portal_dev gets the signed-out answer (200 {user:null})", async () => {
  const db = prodDb();
  addAccount(db, { id: "m1", email: "m1@example.com", role: "member" });
  const session = await sessionFor(db, "m1");

  // Control: the same session through the real __Host- cookie is signed in,
  // so the signed-out answer below is the cookie name's doing and nothing else.
  const real = await callPortal(db, {}, { path: "/api/portal/me", session });
  assert.equal(real.data.authenticated, true);

  const dev = await callPortal(db, {}, { path: "/api/portal/me", session: asDevCookie(session) });
  assert.equal(dev.status, 200);
  assert.equal(dev.data.user, null);
  assert.equal(dev.data.authenticated, false);
  assert.equal(dev.data.account, undefined, "no account leaks");
  assert.equal(dev.data.csrf_token, undefined, "no CSRF token leaks");
});

test("production: the dev cookie gives no role either, an owner route answers as for a request with no cookie", async () => {
  const db = prodDb();
  addAccount(db, { id: "o1", email: "roger@example.com", role: "owner" });
  const session = await sessionFor(db, "o1");
  const env = { OWNER_EMAILS: "roger@example.com" };
  const noCookie = await callPortal(db, env, { path: "/api/portal/owner/today" });
  const devCookie = await callPortal(db, env, { path: "/api/portal/owner/today", session: asDevCookie(session) });
  assert.notEqual(noCookie.status, 200);
  assert.deepEqual(devCookie, noCookie);
});

test("production: the dev cookie is ignored even if PORTAL_DEV_LOGIN were set by mistake", async () => {
  const db = prodDb();
  addAccount(db, { id: "m1", email: "m1@example.com", role: "member" });
  const session = await sessionFor(db, "m1");
  const dev = await callPortal(db, { PORTAL_DEV_LOGIN: "1" }, { path: "/api/portal/me", session: asDevCookie(session) });
  assert.equal(dev.data.user, null);
});

test("the production marker closes the gate on a local host too (loadSession, PORTAL_DEV_LOGIN '1')", async () => {
  const db = prodDb();
  addAccount(db, { id: "m1", email: "m1@example.com", role: "member" });
  const session = await sessionFor(db, "m1");
  const request = new Request(new URL("/api/portal/me", LOCAL), { headers: { Cookie: asDevCookie(session).cookie } });
  assert.equal(await loadSession(request, { PORTAL_DEV_LOGIN: "1" }, db, new URL(LOCAL)), null);
});

test("production: the __Host- cookie is unaffected", async () => {
  const db = prodDb();
  addAccount(db, { id: "m1", email: "m1@example.com", role: "member" });
  const session = await sessionFor(db, "m1");
  const real = await callPortal(db, {}, { path: "/api/portal/me", session });
  assert.deepEqual([real.status, real.data.authenticated, real.data.account.id], [200, true, "m1"]);
});

test("local dev (gate open: PORTAL_DEV_LOGIN 1, localhost, preview marker): the dev cookie signs in as before", async () => {
  const db = previewDb();
  const session = asDevCookie(await sessionFor(db, "demo1"));
  const r = await me(db, { PORTAL_DEV_LOGIN: "1" }, session, LOCAL);
  assert.deepEqual([r.status, r.data.authenticated, r.data.account.id], [200, true, "demo1"]);
});

test("local dev with PORTAL_DEV_LOGIN unset: the gate is closed and the dev cookie is ignored", async () => {
  const db = previewDb();
  const session = asDevCookie(await sessionFor(db, "demo1"));
  const r = await me(db, {}, session, LOCAL);
  assert.deepEqual([r.status, r.data.user, r.data.authenticated], [200, null, false]);
});

test("the gate has one predicate: PORTAL_DEV_LOGIN is read in exactly one place in auth.js", () => {
  const source = readFileSync(new URL("../src/portal/auth.js", import.meta.url), "utf8");
  assert.equal(source.split("\n").filter((line) => /env\.PORTAL_DEV_LOGIN/.test(line)).length, 1);
});
