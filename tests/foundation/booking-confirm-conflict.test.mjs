// portal(FR2-B) M12: `confirmPaidBooking` on an expired hold must never
// double-book. Drives the real mechanism (the Stripe webhook route,
// `checkout.session.completed`) rather than importing booking.js
// directly -- D1 only exists inside the Workers runtime `wrangler dev`
// is running, so this stays black-box HTTP (PIN-16), same as
// stripe-webhook.test.mjs (B2b, not this part's file -- this file
// signs its own small webhook event rather than importing theirs).
//
// RED (see this part's dispatch return for the transcript): before the
// fix, booking.js's confirmPaidBooking ran an unguarded
// `UPDATE ... SET status='confirmed' WHERE id=? AND status='pending_payment'`
// after a separate conflict SELECT -- a booking created in the gap
// between that SELECT and the UPDATE was never seen, so the late
// confirm still landed and produced two live rows for the same slot.
// GREEN: the UPDATE itself carries the NOT EXISTS occupancy guard, so
// it can confirm at most one of the two.
//
// Repeatable: the test cleans up every row it creates (including the
// calendar_outbox/payments_mirror rows D1's enforced foreign keys would
// otherwise strand) so a rerun never trips `cap_reached` on the account
// it used.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";

const WEBHOOK_SECRET = "whsec_local_test_only";
const RESOURCE_ID = "demo-court-0000-0000-000000000001";
const GUEST_ID = "demo-guest-0000-0000-000000000005";

function sign(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

async function postWebhook(rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": sign(WEBHOOK_SECRET, rawBody, t) },
    body: rawBody,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function freshStartIso(daysAhead, hour) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

test("M12: a late paid-confirm on an expired hold, raced by another member's booking, becomes paid_conflict with exactly one live booking", async () => {
  const unique = Date.now();
  const start = freshStartIso(3 + (unique % 4), 13); // 07:00 CR -- on Court 1's grid; stays inside the 7-day member window
  const end = new Date(new Date(start).getTime() + 90 * 60000).toISOString();
  const holdId = `m12-expired-hold-${unique}`;
  const sessionId = `cs_m12_conflict_${unique}`;
  const eventId = `evt_m12_conflict_${unique}`;
  let liveBookingId = null;

  try {
    d1(
      `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, checkout_session_id, created_by, created_at, updated_at)
       VALUES ('${holdId}', '${GUEST_ID}', '${RESOURCE_ID}', NULL, '${start}', '${end}', 1, 0, 'pending_payment', 'pay', datetime('now','-5 minutes'), '${sessionId}', '${GUEST_ID}', datetime('now'), datetime('now'))`
    );

    // Another member books the SAME slot while the hold sits expired (the
    // normal case: no sweep job has run yet) -- this is the "race" leg.
    const member = await loginDemo("member2.demo@jp-demo.test");
    const bookResp = await member.client.post(
      "/api/portal/bookings",
      { resource_id: RESOURCE_ID, start, party_size: 1 },
      { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL }
    );
    assert.equal(bookResp.status, 201, `member booking expected 201, got ${bookResp.status} ${JSON.stringify(bookResp.data)}`);
    assert.equal(bookResp.data.booking.status, "confirmed");
    liveBookingId = bookResp.data.booking.id;

    // The late Stripe webhook for the ORIGINAL hold arrives after the race.
    const body = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          payment_intent: "pi_m12_conflict",
          amount_total: 1500,
          currency: "usd",
          customer: null,
          customer_details: { email: "guest.demo@jp-demo.test" },
          metadata: { kind: "booking", booking_id: holdId },
        },
      },
    });
    const webhook = await postWebhook(body);
    assert.equal(webhook.status, 200, `webhook expected 200, got ${webhook.status} ${JSON.stringify(webhook.data)}`);

    // One combined read: the hold's own final status, plus every row
    // still confirmed for this exact resource+start (should be exactly
    // the member's booking, never the stale hold).
    const rows = d1(
      `SELECT id, status FROM bookings WHERE id = '${holdId}' OR (resource_id = '${RESOURCE_ID}' AND start_at = '${start}' AND status = 'confirmed')`
    );
    const holdRow = rows.find((r) => r.id === holdId);
    assert.equal(holdRow.status, "paid_conflict", "the late confirm on an already-occupied slot must become paid_conflict, never confirmed");
    const confirmedRows = rows.filter((r) => r.status === "confirmed");
    assert.equal(confirmedRows.length, 1, "exactly one confirmed booking must survive for this resource+start");
    assert.equal(confirmedRows[0].id, liveBookingId, "the surviving booking must be the member's, not the stale hold");
  } finally {
    // D1 enforces foreign keys on this local harness (confirmed by an
    // exact SQLITE_CONSTRAINT_FOREIGNKEY failure while drafting this
    // test, see the dispatch return for M21) -- dependents go first so
    // the account's cap_reached count on this resource resets for the
    // next run.
    const ids = liveBookingId ? `'${holdId}', '${liveBookingId}'` : `'${holdId}'`;
    d1(`DELETE FROM calendar_outbox WHERE booking_id IN (${ids})`);
    d1(`DELETE FROM payments_mirror WHERE booking_id IN (${ids})`);
    d1(`DELETE FROM bookings WHERE id IN (${ids})`);
  }
});
