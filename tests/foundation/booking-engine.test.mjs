// B2a1's own red-then-green probes for the booking-engine controls it
// took from risk/controls.md §4 "B2a -- booking": CTL-BOOK-01 (covered
// by booking-concurrency.test.mjs), CTL-AVL-01, CTL-CRD-01, CTL-MSG-01,
// plus S-11 (no phantom hold while Stripe is off) and the Amendment 4
// plunge/massage audience rules. PIN-16: black-box HTTP against the
// real bundle; one direct `d1()` read per test only to inspect rows the
// API itself would not expose (row counts, raw status).
//
// Uses only the five pre-seeded demo accounts (never a freshly
// registered @jp-demo.test email) -- see booking-concurrency.test.mjs's
// header for why: `demoDevLink()` (S-1 e, src/portal/auth.js, not this
// part's file) issues a dev_link only for an email that already exists
// as `is_demo`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL, utcOnCrDay } from "./helpers.mjs";

function resetRateLimits() {
  d1(`DELETE FROM rate_limits`);
}
async function loginSeeded(email) {
  resetRateLimits();
  return loginDemo(email);
}
function freshStartIso(daysAhead, hour, minute = 0) {
  return utcOnCrDay(daysAhead, hour, minute).toISOString();
}

test("L4 (replaces S-11's 503): a guest court booking (pay mode) with Stripe unconfigured is confirmed and unpaid, pay at the club, with no hold", async () => {
  const guest = await loginSeeded("guest.demo@jp-demo.test");
  const resourceId = "demo-court-0000-0000-000000000001";
  const start = freshStartIso(1, 14, 30); // 08:30 CR -- on Court 1's grid (portal(FR2-B)/M10)
  const resp = await guest.client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 1, payment_choice: "card" }, // force the card path, skip the credits default
    { "X-CSRF-Token": guest.csrfToken, Origin: BASE_URL }
  );
  assert.equal(resp.status, 201, `expected 201, got ${resp.status} ${JSON.stringify(resp.data)}`);
  assert.equal(resp.data.booking.status, "confirmed");
  assert.equal(resp.data.booking.pay_at_club, true);
  assert.equal(resp.data.booking.amount_cents, 1500);
  const row = d1(`SELECT status, payment_mode, hold_expires_at, payment_intent_id FROM bookings WHERE id = '${resp.data.booking.id}'`)[0];
  assert.deepEqual(row, { status: "confirmed", payment_mode: "pay", hold_expires_at: null, payment_intent_id: null }, "recorded unpaid: no hold, no payment intent");
  d1(`DELETE FROM calendar_outbox WHERE booking_id = '${resp.data.booking.id}'; DELETE FROM bookings WHERE id = '${resp.data.booking.id}'`);
});

test("Amendment 4: an annual-member plunge booking confirms at $0 with no checkout (included, no Stripe call)", async () => {
  const annual = await loginSeeded("member.demo@jp-demo.test"); // seeded jp_annual_single
  const resourceId = "demo-plng-00000-0000-000000000006";
  const start = freshStartIso(5, 15, 40); // 09:40 CR -- on the Plunge's 20-min grid (portal(FR2-B)/M10)
  const resp = await annual.client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 1 },
    { "X-CSRF-Token": annual.csrfToken, Origin: BASE_URL }
  );
  assert.equal(resp.status, 201, `expected 201, got ${resp.status} ${JSON.stringify(resp.data)}`);
  assert.equal(resp.data.booking.status, "confirmed");
  assert.equal(resp.data.booking.payment_mode, "included");
  assert.equal(resp.data.booking.checkout_url, undefined, "an included booking must never carry a checkout_url");
  const row = d1(`SELECT status, payment_mode, hold_expires_at FROM bookings WHERE id = '${resp.data.booking.id}'`)[0];
  assert.equal(row.status, "confirmed");
  assert.equal(row.payment_mode, "included");
  assert.equal(row.hold_expires_at, null, "an included booking never carries a hold");
});

test("CTL-MSG-01: massage is always a paid booking, never included/credits, even for an annual member with credits", async () => {
  const annual = await loginSeeded("member.demo@jp-demo.test");
  d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('demo-memb1-0000-0000-000000000003', 10, datetime('now'))`);
  const resourceId = "demo-msg-00000-0000-000000000005";
  const start = freshStartIso(6, 16); // 10:00 CR -- on the Massage's hourly grid (portal(FR2-B)/M10)
  // The seed gives member.demo two future massage bookings and the resource a
  // cap of one active booking per account, so the cap would answer first.
  // Lift it for this case (L3: members have no cap) and put it back after.
  const capBefore = d1(`SELECT max_active_per_account AS cap FROM resources WHERE id = '${resourceId}'`)[0].cap;
  d1(`UPDATE resources SET max_active_per_account = NULL WHERE id = '${resourceId}'`);
  let resp;
  try {
    resp = await annual.client.post(
      "/api/portal/bookings",
      { resource_id: resourceId, offering_id: "demo-off-00000-0000-000000000005", start, party_size: 1 },
      { "X-CSRF-Token": annual.csrfToken, Origin: BASE_URL }
    );
  } finally {
    d1(`UPDATE resources SET max_active_per_account = ${capBefore === null ? "NULL" : capBefore} WHERE id = '${resourceId}'`);
  }
  // Stripe is unconfigured on this harness (D-A23), so under L4 a massage is
  // recorded confirmed and unpaid, pay at the club. CTL-MSG-01's point
  // stands: it must NEVER be paid for by entitlement or credits, even for an
  // annual member holding credits.
  assert.equal(resp.status, 201, `expected 201 pay at the club, got ${resp.status} ${JSON.stringify(resp.data)}`);
  assert.equal(resp.data.booking.payment_mode, "pay", "never included, never credits");
  assert.equal(resp.data.booking.pay_at_club, true);
  assert.equal(resp.data.booking.amount_cents, 5500);
  const credits = d1(`SELECT balance FROM credits WHERE account_id = 'demo-memb1-0000-0000-000000000003'`)[0].balance;
  assert.equal(credits, 10, "the credits were not spent on a massage");
  d1(`DELETE FROM calendar_outbox WHERE booking_id = '${resp.data.booking.id}'; DELETE FROM bookings WHERE id = '${resp.data.booking.id}'`);
});

test("CTL-CRD-01 (party-size credits, atomic): 8 credits, party of 4 -> 4 left; then 3 credits, party of 4 -> 409 and nothing written", async () => {
  const account = await loginSeeded("guest.demo@jp-demo.test");
  d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('${account.account.id}', 8, datetime('now'))`);
  const resourceId = "demo-court-0000-0000-000000000002";
  const start = freshStartIso(1, 13); // 07:00 CR -- on Court 2's grid (portal(FR2-B)/M10)
  const ok = await account.client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 4, payment_choice: "credits" },
    { "X-CSRF-Token": account.csrfToken, Origin: BASE_URL }
  );
  assert.equal(ok.status, 201, `expected 201, got ${ok.status} ${JSON.stringify(ok.data)}`);
  assert.equal(ok.data.booking.payment_mode, "credits");
  let balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 4);

  d1(`UPDATE credits SET balance = 3 WHERE account_id = '${account.account.id}'`);
  const start2 = freshStartIso(2, 17, 30); // 11:30 CR -- on Court 2's grid (portal(FR2-B)/M10)
  const before = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start2}'`)[0].n;
  const short = await account.client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start: start2, party_size: 4, payment_choice: "credits" },
    { "X-CSRF-Token": account.csrfToken, Origin: BASE_URL }
  );
  assert.equal(short.status, 409);
  assert.equal(short.data.error, "insufficient_credits");
  balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 3, "balance must be untouched by the failed attempt");
  const after = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start2}'`)[0].n;
  assert.equal(after, before, "no booking row for the rejected attempt");
});

test("CTL-AVL-01: availability for a member never carries another account's id, name or email", async () => {
  const resourceId = "demo-court-0000-0000-000000000003";
  // Grid-aligned: resource003 opens 07:00 CR-local (UTC-6) with 90-min
  // slots, so boundaries fall at CR 07:00, 08:30, 10:00... = UTC 13:00,
  // 14:30, 16:00... An arbitrary UTC hour (e.g. 15:00 = CR 09:00) sits
  // BETWEEN two grid cells and never matches any slot's exact `start`,
  // which is a bug in a test picking its own fixture time, not in the
  // availability endpoint itself.
  const start = freshStartIso(2, 17, 30);
  const end = freshStartIso(2, 19, 0);
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('b2a1-avl-other', 'demo-memb2-0000-0000-000000000004', '${resourceId}', NULL, '${start}', '${end}', 1, 0, 'confirmed', 'included', 'demo-memb2-0000-0000-000000000004', datetime('now'), datetime('now'))`
  );
  const viewer = await loginSeeded("member.demo@jp-demo.test");
  const dateStr = start.slice(0, 10);
  const resp = await viewer.client.get(`/api/portal/resources/${resourceId}/availability?date=${dateStr}`, { Origin: BASE_URL });
  assert.equal(resp.status, 200, JSON.stringify(resp.data));
  const body = JSON.stringify(resp.data);
  assert.ok(!body.includes("demo-memb2"), "member2's account id leaked into the availability response");
  assert.ok(!body.includes("member2.demo@jp-demo.test"), "member2's email leaked into the availability response");
  assert.ok(!body.includes("Member Two"), "member2's display name leaked into the availability response");
  const slot = resp.data.slots.find((s) => s.start === start);
  assert.equal(slot && slot.state, "taken");
});

test("Cancel's credit return is idempotent (run it twice -> credited once, same as the database doctrine's run-it-twice law)", async () => {
  const account = await loginSeeded("guest.demo@jp-demo.test");
  d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('${account.account.id}', 4, datetime('now'))`);
  const resourceId = "demo-court-0000-0000-000000000004";
  const start = freshStartIso(2, 14, 30); // 08:30 CR -- on Court 4's grid (portal(FR2-B)/M10)
  const create = await account.client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 2, payment_choice: "credits" },
    { "X-CSRF-Token": account.csrfToken, Origin: BASE_URL }
  );
  assert.equal(create.status, 201, JSON.stringify(create.data));
  const bookingId = create.data.booking.id;
  let balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 2, "2 spent out of 4");

  const cancel1 = await account.client.post(`/api/portal/bookings/${bookingId}/cancel`, {}, { "X-CSRF-Token": account.csrfToken, Origin: BASE_URL });
  assert.equal(cancel1.status, 200, JSON.stringify(cancel1.data));
  assert.equal(cancel1.data.credits_returned, 2);
  balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 4, "returned once");

  const cancel2 = await account.client.post(`/api/portal/bookings/${bookingId}/cancel`, {}, { "X-CSRF-Token": account.csrfToken, Origin: BASE_URL });
  assert.equal(cancel2.status, 404, "cancelling an already-cancelled booking is not a 200 no-op, per api.md");
  balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 4, "a repeat cancel call must never credit twice");
  const ledgerRows = d1(`SELECT COUNT(*) AS n FROM credits_ledger WHERE booking_id = '${bookingId}' AND reason = 'cancel_return'`)[0].n;
  assert.equal(ledgerRows, 1, "exactly one ledger row for the one real cancel");
});

test("PIN-13 / same-batch: a confirmed (included) booking and its calendar_outbox 'create' row always appear together", async () => {
  const member = await loginSeeded("member.demo@jp-demo.test");
  const resourceId = "demo-court-0000-0000-000000000001";
  const start = freshStartIso(4, 14, 30); // 08:30 CR -- on Court 1's grid (portal(FR2-B)/M10)
  const resp = await member.client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 1 },
    { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL }
  );
  assert.equal(resp.status, 201, JSON.stringify(resp.data));
  const bookingId = resp.data.booking.id;
  const outboxRows = d1(`SELECT action, status FROM calendar_outbox WHERE booking_id = '${bookingId}'`);
  assert.equal(outboxRows.length, 1, "exactly one outbox row for the one confirmed create");
  assert.equal(outboxRows[0].action, "create");
  assert.equal(outboxRows[0].status, "pending");

  const cancel = await member.client.post(`/api/portal/bookings/${bookingId}/cancel`, {}, { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  const outboxAfter = d1(`SELECT action FROM calendar_outbox WHERE booking_id = '${bookingId}' ORDER BY created_at`);
  assert.equal(outboxAfter.length, 2, "the cancel adds its own outbox row, never replacing the create row");
  assert.equal(outboxAfter[1].action, "cancel");
});
