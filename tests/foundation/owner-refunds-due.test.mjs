// M19/CTL-REF-01: cancelling a paid confirmed booking (member before
// cutoff, or owner at any time) leaves a refund-due trail -- never
// silently dropped off the owner's Today view, and never auto-refunded
// (PIN-11: the Stripe refund itself stays a dashboard act).
//
// RED (see this part's dispatch return for the transcript): before the
// fix, no `refund_state` column existed at all, `GET .../today`
// excluded every cancelled row outright, and there was no
// refunds-due list or mark-refunded route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";

const COURT_3 = "demo-court-0000-0000-000000000003";
const MEMBER_ID = "demo-memb1-0000-0000-000000000003";

const owner = await loginDemo("owner.demo@jp-demo.test");

async function ownerCall(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

test("M19: owner-cancelling a paid confirmed booking marks refund_state='due', keeps it on Today, lists it, and mark-refunded clears it (audited, idempotent)", async () => {
  const unique = Date.now();
  const bookingId = `m19-paid-booking-${unique}`;
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  start.setUTCHours(13, 0, 0, 0); // 07:00 CR -- on Court 3's grid
  const startIso = start.toISOString();
  const endIso = new Date(start.getTime() + 90 * 60000).toISOString();
  const dateStr = new Date(start.getTime() - 6 * 3600000).toISOString().slice(0, 10); // CR calendar date

  d1(
    `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, payment_intent_id, created_by, created_at, updated_at)
     VALUES ('${bookingId}', '${MEMBER_ID}', '${COURT_3}', NULL, '${startIso}', '${endIso}', 1, 0, 'confirmed', 'pay', 'pi_m19_test_${unique}', '${MEMBER_ID}', datetime('now'), datetime('now'))`
  );

  try {
    // Owner cancels it (D-A08: the owner may cancel anything, any time).
    const cancel = await ownerCall("POST", `/api/portal/bookings/${bookingId}/cancel`, {});
    assert.equal(cancel.status, 200, `cancel expected 200, got ${cancel.status} ${JSON.stringify(cancel.data)}`);

    const row = d1(`SELECT status, refund_state FROM bookings WHERE id = '${bookingId}'`)[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.refund_state, "due", "a paid confirmed booking's cancel must leave refund_state='due'");

    // Today still shows it (M19: it would otherwise vanish -- status != 'cancelled' alone used to exclude it).
    const today = await ownerCall("GET", `/api/portal/owner/today?date=${dateStr}`);
    assert.equal(today.status, 200);
    const todayItem = today.data.items.find((i) => i.id === bookingId);
    assert.ok(todayItem, `expected ${bookingId} still on Today: ${JSON.stringify(today.data.items.map((i) => i.id))}`);
    assert.equal(todayItem.refund_url, `https://dashboard.stripe.com/payments/pi_m19_test_${unique}`);

    // The refunds-due worklist carries it.
    const due = await ownerCall("GET", "/api/portal/owner/refunds-due");
    assert.equal(due.status, 200);
    assert.ok(due.data.some((r) => r.id === bookingId), `expected ${bookingId} in refunds-due: ${JSON.stringify(due.data)}`);

    // The owner marks it refunded in the Stripe dashboard (PIN-11: this
    // route only records that, it never calls Stripe).
    const mark = await ownerCall("POST", `/api/portal/owner/bookings/${bookingId}/mark-refunded`, {});
    assert.equal(mark.status, 200, JSON.stringify(mark.data));
    const after = d1(`SELECT refund_state FROM bookings WHERE id = '${bookingId}'`)[0];
    assert.equal(after.refund_state, "refunded");

    const dueAfter = await ownerCall("GET", "/api/portal/owner/refunds-due");
    assert.ok(!dueAfter.data.some((r) => r.id === bookingId), "a refunded booking must leave the refunds-due list");

    const audit = d1(`SELECT COUNT(*) AS n FROM audit_log WHERE target_id = '${bookingId}' AND action = 'refund_marked'`)[0].n;
    assert.equal(audit, 1);

    // Idempotent: marking an already-refunded booking again is a no-op, no second audit row.
    const markAgain = await ownerCall("POST", `/api/portal/owner/bookings/${bookingId}/mark-refunded`, {});
    assert.equal(markAgain.status, 200);
    const auditAfterRepeat = d1(`SELECT COUNT(*) AS n FROM audit_log WHERE target_id = '${bookingId}' AND action = 'refund_marked'`)[0].n;
    assert.equal(auditAfterRepeat, 1, "a repeat mark-refunded call must not write a second audit row");
  } finally {
    d1(`DELETE FROM audit_log WHERE target_id = '${bookingId}' AND action = 'refund_marked'`);
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
  }
});

test("M19: a cancel with no payment (included) never sets refund_state, and never appears in refunds-due", async () => {
  const unique = Date.now();
  const bookingId = `m19-included-booking-${unique}`;
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  start.setUTCHours(14, 30, 0, 0); // 08:30 CR -- on Court 3's grid
  const startIso = start.toISOString();
  const endIso = new Date(start.getTime() + 90 * 60000).toISOString();

  d1(
    `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('${bookingId}', '${MEMBER_ID}', '${COURT_3}', NULL, '${startIso}', '${endIso}', 1, 0, 'confirmed', 'included', '${MEMBER_ID}', datetime('now'), datetime('now'))`
  );
  try {
    const cancel = await ownerCall("POST", `/api/portal/bookings/${bookingId}/cancel`, {});
    assert.equal(cancel.status, 200);
    const row = d1(`SELECT refund_state FROM bookings WHERE id = '${bookingId}'`)[0];
    assert.equal(row.refund_state, "none", "an included (never-paid) booking's cancel must never claim a refund is due");
    const due = await ownerCall("GET", "/api/portal/owner/refunds-due");
    assert.ok(!due.data.some((r) => r.id === bookingId));
  } finally {
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
  }
});
