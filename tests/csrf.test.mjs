// QA2: test-plan.md §2 CSRF and session-adjacent security, AUTH-028..034.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, BASE_URL, uniqueEmail } from "./qa-helpers.mjs";

const PROTECTED_GETS = [
  "/api/portal/me",
  "/api/portal/owner/sessions",
  "/api/portal/owner/health",
];

test("AUTH-028: every non-public /api/portal/* GET returns 401 with no cookie", async () => {
  for (const path of PROTECTED_GETS) {
    const res = await fetch(`${BASE_URL}${path}`);
    assert.ok(res.status === 401 || (res.status === 200 && (await res.clone().json()).authenticated === false),
      `${path}: expected 401 or authenticated:false, got ${res.status}`);
  }
});

test("AUTH-029: a state-changing route with no X-CSRF-Token header is rejected (403)", async () => {
  const { client } = await loginDemo(uniqueEmail("csrf029"));
  const resp = await client.post("/api/portal/owner/sessions/revoke-others", {}, { Origin: BASE_URL });
  assert.equal(resp.status, 403);
  assert.equal(resp.data.error, "csrf_required");
});

test("AUTH-030: a state-changing route with the WRONG CSRF token (another session's) is rejected", async () => {
  const a = await loginDemo(uniqueEmail("csrf030a"));
  const b = await loginDemo(uniqueEmail("csrf030b"));
  const resp = await a.client.post("/api/portal/owner/sessions/revoke-others", {}, { "X-CSRF-Token": b.csrfToken, Origin: BASE_URL });
  assert.equal(resp.status, 403);
});

test("AUTH-031: the control case -- correct token + correct Origin succeeds (proves CSRF isn't just always-403)", async () => {
  const a = await loginDemo(uniqueEmail("csrf031"));
  const me = await a.client.get("/api/portal/me");
  assert.equal(me.data.csrf_token, a.csrfToken);
  const resp = await a.client.post("/api/portal/owner/sessions/revoke-others", {}, { "X-CSRF-Token": me.data.csrf_token, Origin: BASE_URL });
  assert.equal(resp.status, 200);
});

test("AUTH-032: correct CSRF token but a foreign Origin is still rejected (Origin checked independently)", async () => {
  const a = await loginDemo(uniqueEmail("csrf032"));
  const resp = await a.client.post("/api/portal/owner/sessions/revoke-others", {}, { "X-CSRF-Token": a.csrfToken, Origin: "https://not-this-host.example" });
  assert.equal(resp.status, 403);
});

test("AUTH-033: GET /api/portal/me includes a non-empty csrf_token matching what AUTH-031 accepts", async () => {
  const a = await loginDemo(uniqueEmail("csrf033"));
  const me = await a.client.get("/api/portal/me");
  assert.ok(me.data.csrf_token && me.data.csrf_token.length > 0);
  assert.equal(me.data.csrf_token, a.csrfToken);
});

test("AUTH-034: the webhook route is never CSRF/Origin gated -- no X-CSRF-Token and a foreign Origin still reach signature checking", async () => {
  const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://not-this-host.example" },
    body: JSON.stringify({ id: "evt_qa_034", type: "invoice.created" }),
  });
  // Must NOT be the CSRF/Origin layer's 403; whatever the signature
  // layer does (400/503/200) is §5's business, not this test's.
  assert.notEqual(res.status, 403, "the webhook must not be rejected by the CSRF/Origin layer at all");
});
