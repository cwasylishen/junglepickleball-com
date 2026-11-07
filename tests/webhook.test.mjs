// QA2: test-plan.md §5 Webhook signature failure, WH-001..009. Signs
// locally with whsec_local_test_only (A1), Stripe's documented method:
// HMAC-SHA256 over `${t}.${rawBody}`. A 503 never counts as a rejection
// (A1) -- these cases assert 400/200 specifically, not merely "not 200".

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, signStripeBody, postRaw } from "./qa-helpers.mjs";

function bookingEvent(id, type, bookingId) {
  return JSON.stringify({ id, type, data: { object: { id: `cs_${id}`, metadata: { booking_id: bookingId } } } });
}

async function countRows(table, where) {
  return d1(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
}

test("WH-001: no Stripe-Signature header at all -- 400, no write", async () => {
  const payload = bookingEvent("evt_wh001", "checkout.session.completed", "none");
  const resp = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json" });
  assert.equal(resp.status, 400, `expected 400, got ${resp.status} -- waiting on B2b`);
});

test("WH-002: Stripe-Signature with wrong value, right shape -- 400, no write", async () => {
  const payload = bookingEvent("evt_wh002", "checkout.session.completed", "none");
  const resp = await postRaw("/api/stripe/webhook", payload, {
    "Content-Type": "application/json",
    "Stripe-Signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
  });
  assert.equal(resp.status, 400, `expected 400, got ${resp.status} -- waiting on B2b`);
});

test("WH-003: malformed Stripe-Signature header -- 400, not a 500 (must not crash)", async () => {
  const payload = bookingEvent("evt_wh003", "checkout.session.completed", "none");
  const resp = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": "garbage" });
  assert.equal(resp.status, 400, `expected 400 (not 500), got ${resp.status} -- waiting on B2b`);
});

test("WH-004/005: timestamp tolerance boundary -- 301s stale is 400, 299s is 200", async () => {
  const now = Math.floor(Date.now() / 1000);
  const staleT = now - 301;
  const stalePayload = bookingEvent("evt_wh004", "checkout.session.completed", "none");
  const staleSig = await signStripeBody("whsec_local_test_only", stalePayload, staleT);
  const staleResp = await postRaw("/api/stripe/webhook", stalePayload, { "Content-Type": "application/json", "Stripe-Signature": staleSig });
  assert.equal(staleResp.status, 400, `WH-004: expected 400 for a 301s-old signature, got ${staleResp.status} -- waiting on B2b`);

  const freshT = now - 299;
  const freshPayload = bookingEvent("evt_wh005", "checkout.session.completed", "none");
  const freshSig = await signStripeBody("whsec_local_test_only", freshPayload, freshT);
  const freshResp = await postRaw("/api/stripe/webhook", freshPayload, { "Content-Type": "application/json", "Stripe-Signature": freshSig });
  assert.equal(freshResp.status, 200, `WH-005: expected 200 for a 299s-old signature, got ${freshResp.status} -- waiting on B2b`);
});

test("WH-006: a correctly-signed checkout.session.completed confirms a real pending booking", async () => {
  // Setup: a real pending_payment booking row (white-box setup, H-2).
  const bookingId = "qa-wh006-booking";
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, checkout_session_id, created_by, created_at, updated_at)
      VALUES ('${bookingId}', 'demo-memb1-0000-0000-000000000003', 'demo-court-0000-0000-000000000001', NULL, datetime('now','+2 days'), datetime('now','+2 days','+90 minutes'), 1, 0, 'pending_payment', 'pay', datetime('now','+31 minutes'), 'cs_wh006', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const t0 = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_wh006", type: "checkout.session.completed", data: { object: { id: "cs_wh006", metadata: { booking_id: bookingId } } } });
  const sig = await signStripeBody("whsec_local_test_only", payload, t0);
  const resp = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  assert.equal(resp.status, 200, `expected 200, got ${resp.status} -- waiting on B2b`);
  const row = d1(`SELECT status FROM bookings WHERE id = '${bookingId}'`)[0];
  assert.equal(row.status, "confirmed", `expected booking to move to confirmed -- waiting on B2b`);
  const mirror = await countRows("payments_mirror", `booking_id = '${bookingId}'`);
  assert.ok(mirror >= 1, "a payments_mirror row must be written (REQ-PAY-19)");
});

test("WH-007: the exact same event id re-sent (replay) is idempotent, no double-write", async () => {
  const bookingId = "qa-wh007-booking";
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, checkout_session_id, created_by, created_at, updated_at)
      VALUES ('${bookingId}', 'demo-memb1-0000-0000-000000000003', 'demo-court-0000-0000-000000000002', NULL, datetime('now','+3 days'), datetime('now','+3 days','+90 minutes'), 1, 0, 'pending_payment', 'pay', datetime('now','+31 minutes'), 'cs_wh007', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const t0 = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_wh007", type: "checkout.session.completed", data: { object: { id: "cs_wh007", metadata: { booking_id: bookingId } } } });
  const sig = await signStripeBody("whsec_local_test_only", payload, t0);
  const first = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  const second = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  assert.equal(first.status, 200, `waiting on B2b -- got ${first.status}`);
  assert.equal(second.status, 200, `replay must not error -- got ${second.status}`);
  const mirrorCount = await countRows("payments_mirror", `booking_id = '${bookingId}'`);
  assert.equal(mirrorCount, 1, "exactly one payments_mirror row after a replayed event, never duplicated");
});

test("WH-008: a well-signed event of an unhandled type is a safe no-op -- 200, no write of any kind", async () => {
  const before = await countRows("bookings", "1=1");
  const t0 = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_wh008", type: "invoice.created" });
  const sig = await signStripeBody("whsec_local_test_only", payload, t0);
  const resp = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  assert.equal(resp.status, 200, `expected 200, got ${resp.status} -- waiting on B2b`);
  const after = await countRows("bookings", "1=1");
  assert.equal(before, after, "an unhandled event type must write nothing");
});

test("WH-009 / A1: signature good + STRIPE_SECRET_KEY unset -- signature success still returns, degraded not failed", async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_wh009", type: "customer.subscription.updated", data: { object: { id: "sub_qa_wh009" } } });
  const sig = await signStripeBody("whsec_local_test_only", payload, t0);
  const resp = await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  assert.equal(resp.status, 200, `A1: signature-good must not fail just because the Stripe API key is unset. Got ${resp.status} -- waiting on B2b`);
});
