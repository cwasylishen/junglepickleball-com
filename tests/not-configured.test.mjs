// QA2: test-plan.md §4 Not-configured states, CFG-001..006. The harness
// default has STRIPE_SECRET_KEY unset, STRIPE_WEBHOOK_SECRET set,
// GOOGLE_SERVICE_ACCOUNT_JSON unset, VAPID_* unset (scripts/test.sh).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, d1, uniqueEmail, BASE_URL, signStripeBody, postRaw } from "./qa-helpers.mjs";

const STRIPE_CALLING_ROUTES = [
  ["POST", "/api/portal/billing/checkout", { lookup_key: "jp_1m_single" }],
  ["POST", "/api/portal/billing/portal-session", {}],
  ["GET", "/api/portal/billing/history", null],
];

test("CFG-001: every Stripe-calling route returns 503 {error:not_configured, feature:stripe}", async () => {
  const member = await loginDemo(uniqueEmail("cfg001"));
  for (const [method, path, body] of STRIPE_CALLING_ROUTES) {
    const resp = method === "GET"
      ? await member.client.get(path)
      : await member.client.post(path, body, { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL });
    assert.equal(resp.status, 503, `${method} ${path}: expected 503, got ${resp.status} -- waiting on B2b`);
    assert.deepEqual(resp.data, { error: "not_configured", feature: "stripe" }, `${method} ${path}: body shape must be exact`);
  }
});

test("CFG-002: missing STRIPE_WEBHOOK_SECRET alone also triggers the same 503 shape", async (t) => {
  t.skip("requires a dedicated wrangler dev --local run with STRIPE_SECRET_KEY set and STRIPE_WEBHOOK_SECRET unset -- not constructible against the single running harness instance (scripts/test.sh fixes both vars for the whole suite). Logged as NOT-TESTED, not silently passed.");
});

test("CFG-003: a paid booking on an offering with price NULL is rejected with price_not_set, not a 503", async () => {
  const guest = await loginDemo(uniqueEmail("cfg003"));
  const resp = await guest.client.post(
    "/api/portal/bookings",
    { resource_id: "demo-plng-00000-0000-000000000006", offering_id: "demo-off-00000-0000-000000000007", start: new Date(Date.now() + 86400000).toISOString(), party_size: 1 },
    { "X-CSRF-Token": guest.csrfToken, Origin: BASE_URL }
  );
  assert.equal(resp.status, 409, `expected 409 price_not_set, got ${resp.status} -- waiting on B2a1`);
  assert.equal(resp.data && resp.data.error, "price_not_set");
});

test("CFG-004: calendar outbox stays pending with attempt_count 0 when GOOGLE_SERVICE_ACCOUNT_JSON is unset", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await member.client.post(
    "/api/portal/bookings",
    { resource_id: "demo-court-0000-0000-000000000003", start: new Date(Date.now() + 7200000).toISOString(), party_size: 1 },
    { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL }
  );
  assert.equal(resp.status, 201, `expected 201 booking created, got ${resp.status} -- waiting on B2a1`);
  const bookingId = resp.data.booking.id;
  const rows = d1(`SELECT status, attempts FROM calendar_outbox WHERE booking_id = '${bookingId}'`);
  assert.equal(rows.length, 1, "a calendar_outbox row must be written in the same batch as the booking");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].attempts, 0);
});

test("CFG-005: push opt-in with VAPID keys unset returns not-configured, writes no subscription row, does not crash", async () => {
  const member = await loginDemo(uniqueEmail("cfg005"));
  const resp = await member.client.post(
    "/api/portal/push/subscribe",
    { endpoint: "https://example.invalid/push/abc", keys: { p256dh: "x", auth: "y" } },
    { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL }
  );
  assert.equal(resp.status, 503, `expected 503 not_configured, got ${resp.status} -- waiting on B2e`);
  assert.equal(resp.data && resp.data.feature, "push");
  const rows = d1(`SELECT * FROM push_subscriptions WHERE endpoint = 'https://example.invalid/push/abc'`);
  assert.equal(rows.length, 0, "no subscription row must be written when push is not configured");
});

test("CFG-006 / A1: a correctly-signed webhook whose handling would need a Stripe API call still returns the signature-success code, not 503", async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_qa_cfg006", type: "checkout.session.completed", data: { object: { id: "cs_qa_cfg006", metadata: { booking_id: "nonexistent-booking" } } } });
  const sig = await signStripeBody("whsec_local_test_only", payload, t0);
  const resp = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  assert.notEqual(resp.status, 503, `A1's own regression: signature-good must never collapse into "not configured". Got ${resp.status} -- waiting on B2b`);
});
