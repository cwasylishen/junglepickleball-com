// CTL-AUTH-01, 02, 03, 04, CTL-OWN-01 (black-box HTTP, PIN-16).
// CTL-AUTH-07 and CTL-ROLE-01 are pure-function table tests (controls.md
// explicitly describes them that way); see auth-functions.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient, loginDemo, startAndGetDevLink, BASE_URL } from "./helpers.mjs";

test("CTL-AUTH-03: a GET cannot consume the login token; the POST after it still redeems", async () => {
  const client = makeClient();
  const devLink = await startAndGetDevLink(client, "owner.demo@jp-demo.test", { Origin: BASE_URL });
  const token = new URL(devLink).hash.replace(/^#login=/, "");

  // RED, by construction: if any GET route consumed the token, the
  // following GET would burn it and the POST below would then fail
  // with verify.bad_used. There is no GET route for verify in
  // src/portal/router.js's ROUTES table at all (a 404 is the proof).
  const getAttempt = await client.get(`/api/portal/auth/verify?token=${token}`);
  assert.equal(getAttempt.status, 404);

  const verify = await client.post("/api/portal/auth/verify", { token, age_16_plus: true }, { Origin: BASE_URL });
  assert.equal(verify.status, 200, "the token must still be redeemable after the GET");
});

test("CTL-AUTH-02: verifying a different account's token while signed in requires confirm:true", async () => {
  const { client, account } = await loginDemo("member2.demo@jp-demo.test");
  assert.equal(account.email, "member2.demo@jp-demo.test");

  const devLink = await startAndGetDevLink(client, "member.demo@jp-demo.test", { Origin: BASE_URL });
  const token = new URL(devLink).hash.replace(/^#login=/, "");

  const noConfirm = await client.post("/api/portal/auth/verify", { token, age_16_plus: true }, { Origin: BASE_URL });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.data.error, "confirm_account_switch");
  assert.ok(noConfirm.data.account_hint.includes("***"));

  // The member2 cookie must still work -- the switch was refused, not applied.
  const stillMember2 = await client.get("/api/portal/me");
  assert.equal(stillMember2.data.account.email, "member2.demo@jp-demo.test");

  const confirmed = await client.post("/api/portal/auth/verify", { token, age_16_plus: true, confirm: true }, { Origin: BASE_URL });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.account.email, "member.demo@jp-demo.test");
});

test("CTL-AUTH-04: the session cookie is Secure unless the request is local http", async () => {
  // Pure-function proof (the harness only ever runs over local http, so
  // the Secure-vs-not branch cannot be exercised live here -- the
  // production/https leg is release-captain's E2 check, as controls.md
  // §3.2 itself says). RED: a pin-literal `protocol === "http:"` alone
  // (ignoring hostname) would mark `http://example.com` as local too.
  const { cookieName, sessionCookieHeader } = await import("../../src/portal/auth.js");
  const local = new URL("http://127.0.0.1:8799/");
  const remoteHttp = new URL("http://example.com/");
  const remoteHttps = new URL("https://junglepickleball.com/");
  assert.equal(cookieName(local), "jp_portal_dev");
  assert.equal(cookieName(remoteHttp), "__Host-jp_portal");
  assert.equal(cookieName(remoteHttps), "__Host-jp_portal");
  assert.ok(!sessionCookieHeader(local, "tok", 1000).includes("Secure"));
  assert.ok(sessionCookieHeader(remoteHttp, "tok", 1000).includes("Secure"));
  assert.ok(sessionCookieHeader(remoteHttps, "tok", 1000).includes("Secure"));
});

test("CTL-AUTH-01/CTL-OWN-01: owner session list, revoke-others, and the audit/health listing", async () => {
  const first = await loginDemo("owner.demo@jp-demo.test");
  const second = await loginDemo("owner.demo@jp-demo.test");

  const list = await second.client.get("/api/portal/owner/sessions");
  assert.equal(list.status, 200);
  assert.ok(list.data.sessions.length >= 2, "both owner sessions must be listed");

  const health = await second.client.get("/api/portal/owner/health");
  assert.equal(health.status, 200);
  assert.ok(health.data.owners.some((o) => o.email === "owner.demo@jp-demo.test"));

  const revoke = await second.client.post(
    "/api/portal/owner/sessions/revoke-others",
    {},
    { "X-CSRF-Token": second.csrfToken, Origin: BASE_URL }
  );
  assert.equal(revoke.status, 200);

  // RED, by construction: without revoke-others deleting the other row,
  // this call would still return 200 here.
  const firstNowRevoked = await first.client.get("/api/portal/me");
  assert.equal(firstNowRevoked.status, 401);
});
