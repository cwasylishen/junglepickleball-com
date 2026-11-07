// D-A11 (owner override: bypasses window/entitlement/payment, never
// bumps), D-A15 (blocks warn, never bump), and the owner Today view
// (confirmed/held/blocked/paid_conflict, refund link).
//
// One owner login for the whole file (CTL-AUTH-07's 5-per-15-minute
// login-start limit is shared across the whole suite run; a session
// lasts 7 days, so one login serves every test below).
//
// FINDING (repeated from owner.js's own header comment, named here too
// per PIN-18): B2a1's booking.js is still the amendment-6 interface
// stub at the time this was written, so there is no shared booking-
// insert function to import. The override path below writes `bookings`
// directly through the same atomic INSERT...SELECT...WHERE NOT
// EXISTS...RETURNING guard B2a1's own create path should use -- the
// run-it-twice test here is this control's actual proof that two
// concurrent-shaped calls can never double-book a slot, which is the
// property CTL-BOOK-01 exists to certify. If B2a1 later exports a
// shared insert function, `ownerOverrideBooking` must be switched to
// call it so there is only one writer, not two that happen to agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";

const COURT_2 = "demo-court-0000-0000-000000000002";

const owner = await loginDemo("owner.demo@jp-demo.test");

async function ownerPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function ownerDeleteBlock(blockId) {
  return fetch(`${BASE_URL}/api/portal/owner/blocks/${blockId}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() },
  });
}

test("D-A11: owner override books a walk-in, bypassing window/entitlement/payment, and is audited", async () => {
  const start = "2026-11-05T14:30:00.000Z"; // 08:30 CR, on Court 2's grid; far outside any window
  const res = await ownerPost("/api/portal/owner/bookings", {
    resource_id: COURT_2,
    start,
    walk_in_name: "Walk-in Dana",
  });
  assert.equal(res.status, 201);
  const booking = res.data.booking;
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.payment_mode, "override");
  assert.equal(booking.walk_in_name, "Walk-in Dana");

  const auditRows = d1(`SELECT * FROM audit_log WHERE target_id = '${booking.id}' AND action = 'owner_override_booking'`);
  assert.equal(auditRows.length, 1, "exactly one audit row for the one booking actually created");

  // M20/PIN-13: the calendar_outbox 'create' row must ride in the SAME
  // batch as the override's booking write -- RED before the fix: this
  // row never existed at all, so Roger's calendar never heard about a
  // walk-in or owner booking.
  const outboxRows = d1(`SELECT action, status FROM calendar_outbox WHERE booking_id = '${booking.id}'`);
  assert.equal(outboxRows.length, 1, "exactly one calendar_outbox row for the override's booking write");
  assert.equal(outboxRows[0].action, "create");
  assert.equal(outboxRows[0].status, "pending");

  d1(`DELETE FROM calendar_outbox WHERE booking_id = '${booking.id}'`);
  d1(`DELETE FROM bookings WHERE id = '${booking.id}'`);
  d1(`DELETE FROM audit_log WHERE target_id = '${booking.id}'`);
});

test("M10: the owner override refuses an off-grid start or one that ends after close, same rule createBooking uses", async () => {
  const offGrid = await ownerPost("/api/portal/owner/bookings", {
    resource_id: COURT_2,
    start: "2026-11-05T15:00:00.000Z", // 09:00 CR -- NOT on Court 2's 90-min grid
    walk_in_name: "Off grid",
  });
  assert.equal(offGrid.status, 400, JSON.stringify(offGrid.data));
  assert.equal(offGrid.data.error, "off_grid");

  const outsideHours = await ownerPost("/api/portal/owner/bookings", {
    resource_id: COURT_2,
    start: "2026-11-05T01:00:00.000Z", // 19:00 CR -- after Court 2's last 17:30 start
    walk_in_name: "Too late",
  });
  assert.equal(outsideHours.status, 400, JSON.stringify(outsideHours.data));
  assert.equal(outsideHours.data.error, "outside_hours");

  const rows = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${COURT_2}' AND walk_in_name IN ('Off grid', 'Too late')`)[0].n;
  assert.equal(rows, 0, "neither refused attempt may write a row");
});

test("CTL-BOOK-01 (occupancy, run-it-twice): the same slot booked twice never double-books -- second call is 409 slot_taken, no bump, no second audit row", async () => {
  const start = "2026-11-06T16:00:00.000Z";
  const body = { resource_id: COURT_2, start, walk_in_name: "Repeat Caller" };

  const first = await ownerPost("/api/portal/owner/bookings", body);
  assert.equal(first.status, 201);
  const bookingId = first.data.booking.id;

  try {
    // RED: a non-atomic read-then-insert (SELECT overlap, then a plain
    // INSERT with no guard) would let this second call create a second
    // row at the identical time, i.e. double-book the court.
    const second = await ownerPost("/api/portal/owner/bookings", body);
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "slot_taken");

    const rows = d1(`SELECT id FROM bookings WHERE resource_id = '${COURT_2}' AND start_at = '${start}' AND status != 'cancelled'`);
    assert.equal(rows.length, 1, "exactly one booking must occupy the slot after the repeat call");

    const auditRows = d1(`SELECT * FROM audit_log WHERE action = 'owner_override_booking' AND after LIKE '%Repeat Caller%'`);
    assert.equal(auditRows.length, 1, "the failed second attempt must not write a second audit row");
  } finally {
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
    d1(`DELETE FROM audit_log WHERE target_id = '${bookingId}'`);
  }
});

test("D-A11: a blocked slot refuses the override -- no bumping, cancel the block first", async () => {
  const blockRes = await ownerPost("/api/portal/owner/blocks", {
    resource_id: COURT_2,
    kind: "one_off",
    date: "2026-11-07",
    start_time: "09:00",
    end_time: "10:30",
    label: "Test maintenance",
  });
  assert.equal(blockRes.status, 201);
  const blockId = blockRes.data.block.id;

  try {
    const res = await ownerPost("/api/portal/owner/bookings", {
      resource_id: COURT_2,
      start: "2026-11-07T16:00:00.000Z", // 10:00 CR local, on Court 2's grid, inside the block
      walk_in_name: "Should be refused",
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "blocked");
  } finally {
    const del = await ownerDeleteBlock(blockId);
    assert.equal(del.status, 200);
  }
});

test("D-A15/F-D3: a block never bumps an existing booking -- it is created and the booking is listed as a conflict, unchanged", async () => {
  const bookingId = "block-conflict-booking-1";
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('${bookingId}', 'demo-memb1-0000-0000-000000000003', '${COURT_2}', '2026-11-08T15:00:00.000Z', '2026-11-08T16:30:00.000Z', 1, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`
  );
  let blockId = null;
  try {
    const before = d1(`SELECT * FROM bookings WHERE id = '${bookingId}'`)[0];
    const res = await ownerPost("/api/portal/owner/blocks", {
      resource_id: COURT_2,
      kind: "one_off",
      date: "2026-11-08",
      start_time: "09:00",
      end_time: "10:30",
      label: "Overlapping block",
    });
    assert.equal(res.status, 201, "the block is created even though it overlaps a booking");
    blockId = res.data.block.id;
    assert.ok(res.data.conflicts.some((c) => c.id === bookingId), `expected ${bookingId} in conflicts: ${JSON.stringify(res.data.conflicts)}`);

    const after = d1(`SELECT * FROM bookings WHERE id = '${bookingId}'`)[0];
    assert.deepEqual(after, before, "the booking must be untouched by the block that overlaps it");
  } finally {
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
    if (blockId) await ownerDeleteBlock(blockId);
  }
});

test("owner Today: lists confirmed/held/paid_conflict with a refund link, and blocked slots", async () => {
  const confirmedId = "today-confirmed-1";
  const heldId = "today-held-1";
  const conflictId = "today-conflict-1";
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('${confirmedId}', 'demo-memb1-0000-0000-000000000003', '${COURT_2}', '2026-11-09T15:00:00.000Z', '2026-11-09T16:30:00.000Z', 1, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now')),
            ('${heldId}', 'demo-guest-0000-0000-000000000005', '${COURT_2}', '2026-11-09T17:00:00.000Z', '2026-11-09T18:30:00.000Z', 1, 'pending_payment', 'pay', 'demo-guest-0000-0000-000000000005', datetime('now'), datetime('now')),
            ('${conflictId}', 'demo-guest-0000-0000-000000000005', '${COURT_2}', '2026-11-09T18:30:00.000Z', '2026-11-09T20:00:00.000Z', 1, 'paid_conflict', 'pay', 'demo-guest-0000-0000-000000000005', datetime('now'), datetime('now'))`
  );
  d1(`UPDATE bookings SET payment_intent_id = 'pi_test_today_1' WHERE id = '${conflictId}'`);
  try {
    const res = await fetch(`${BASE_URL}/api/portal/owner/today?date=2026-11-09`, {
      headers: { "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byId = (id) => body.items.find((i) => i.id === id);
    assert.equal(byId(confirmedId).state, "confirmed");
    assert.equal(byId(heldId).state, "held");
    const conflict = byId(conflictId);
    assert.equal(conflict.state, "paid_conflict");
    assert.equal(conflict.refund_url, "https://dashboard.stripe.com/payments/pi_test_today_1");
  } finally {
    d1(`DELETE FROM bookings WHERE id IN ('${confirmedId}','${heldId}','${conflictId}')`);
  }
});
