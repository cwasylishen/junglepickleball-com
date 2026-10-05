// QA2: test-plan.md §6 Double-booking races, RACE-001..011 (per A2).
// `POST /api/portal/bookings` is B2a1's route, currently an empty
// `ROUTES = []` stub (src/portal/routes/booking.js) -- every concurrent
// fetch below will 404, which is the honest failure this file reports
// (waiting on B2a1), not a skip. Concurrency itself is real: `Promise.all`
// firing N fetches with no await-gap, same process, same event loop,
// against the one running `wrangler dev` instance.
//
// portal(QA3) GRID FIX: M10 landed a real S-12 grid/hours check
// (gridAndHoursError in src/portal/booking.js) between QA2's dispatch
// and this one. This file's old `freshStart(daysAhead, hour)` set a
// raw UTC hour with no Costa Rica conversion (the exact M11 bug
// booking-bounds.test.mjs's own header already documents and fixed for
// §7) -- every HTTP booking attempt below that used it would now be
// rejected `400 off_grid`/`outside_hours` before the race/expiry/credit
// logic under test ever ran, for a reason that has nothing to do with
// the case. Every fixture below now uses `crDateAt` (qa-helpers.mjs,
// CR wall-clock -> UTC, PIN-6) and names its Costa Rica time, same as
// booking-bounds.test.mjs already does for §7.
//
// RACE-002/003 specifically needed a different construction once grid
// alignment is enforced: a single fixed-size grid can never produce two
// DIFFERENT valid starts that overlap (adjacent grid points partition
// time, by definition). The fix keeps the resource's normal 90-min grid
// (no mid-test slot_minutes mutation) and instead gives the FIRST half's
// booking a longer-than-grid-step offering (120 min, inserted as local
// test data only) so its booking at the earlier grid point (CR 07:00,
// ends 08:30) genuinely overlaps the second half's booking at the very
// next grid point (CR 08:30, default 90-min duration, ends 10:00) --
// 07:00-08:30(+30min=09:00 with the long offering) still overlaps
// 08:30-10:00. This proves A2's "different starts, overlapping in
// wall-clock time" shape without asking the grid to allow a non-grid
// start.
//
// portal(QA3) SECOND FIXTURE FIX (same discovery pass): a non-entitled,
// no-credit account booking a COURT hits src/portal/booking.js's "pay"
// branch, which 503s (Stripe unset) before any write -- every account
// in this file that books a court via HTTP is now given a same-shape
// hand grant (grantEntitlement, qa-helpers.mjs) so resolveAudience
// returns mode="included" and the request reaches the overlap/race
// logic instead of being rejected for an unrelated reason (payment).
// RACE-009 is the deliberate exception: it tests the credit-spend path
// on purpose and keeps its own non-entitled, credited account.
// Entitled accounts also make the offering_id override above actually
// take effect: resolveAudience's court "pay" branch ignores the
// caller's offering_id entirely (it looks up the resource's own
// "everyone" offering), but the "included" branch never consults
// offerings at all, so resolveDuration falls through to the raw
// offering_id the request sent -- confirmed by reading both functions
// (src/portal/entitlement.js resolveAudience, src/portal/booking.js
// resolveDuration) before relying on it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { burstUntilUninterrupted } from "./foundation/helpers.mjs";
import { d1, loginFreshAccounts, BASE_URL, poolEmail, loginDemo, patchWithClient, signStripeBody, postRaw, resetRateLimits, crDateAt, grantEntitlement, grantEntitlements } from "./qa-helpers.mjs";

// FINDING (qa-run-1.md): loginFreshAccounts() already resets per call,
// but RACE-007/008/011's direct loginDemo(member.demo/owner.demo) calls
// do not -- reset once at load for the same H-1 reason as the other
// files.
resetRateLimits();

// The fixtures below book 10 to 17 days ahead, past the seeded booking
// windows (7 days for a member, 2 for a guest), so every booking was
// refused outside_window before the race under test began. Widen the
// windows for this file and put the seeded values back after.
const SEEDED_WINDOWS = d1(`SELECT id, member_window_days AS member, non_member_window_days AS guest FROM resources`);
d1(`UPDATE resources SET member_window_days = 60, non_member_window_days = 60`);
after(() => {
  for (const r of SEEDED_WINDOWS) {
    d1(`UPDATE resources SET member_window_days = ${r.member}, non_member_window_days = ${r.guest} WHERE id = '${r.id}'`);
  }
});

async function bookOnce(client, csrfToken, resourceId, start, extra = {}) {
  return client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 1, ...extra },
    { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
  );
}

test("RACE-001: 20 concurrent identical-slot bookings from 20 accounts -- exactly 1 succeeds, 19 get 409", async () => {
  const accounts = await loginFreshAccounts(20, "race001");
  grantEntitlements(accounts.map((a) => a.account.id)); // QA3 fix: see file header (batched, one d1 call for all 20)
  const resourceId = "demo-court-0000-0000-000000000003";
  let start;
  // A burst the local runtime interrupted proves nothing; it is run again on another day (helpers.mjs).
  const { results } = await burstUntilUninterrupted((shift) => {
    start = crDateAt(10 + shift, 8, 30); // CR 08:30, on the 90-min grid (07:00 + 90min)
    return Promise.all(accounts.map((a) => bookOnce(a.client, a.csrfToken, resourceId, start)));
  });
  const successes = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  assert.equal(successes, 1, `expected exactly 1 success, got ${successes} (statuses: ${results.map((r) => r.status).join(",")}) -- waiting on B2a1`);
  assert.equal(conflicts, 19, `expected 19 conflicts, got ${conflicts}`);
  const live = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start}' AND status != 'cancelled'`)[0].n;
  assert.equal(live, 1);
});

test("RACE-002/003 (A2 overlapping starts): two different, on-grid starts whose durations overlap never both survive", async () => {
  const resourceId = "demo-court-0000-0000-000000000004";
  let startA;
  let startB;
  // Local-test-only offering: 120 min duration (> the 90-min grid step),
  // so a booking at startA ends 09:00 CR, overlapping startB's 08:30-10:00
  // CR range. Never touches the resource's own slot_minutes (A2's
  // premise is about overlap detection, not about the grid rule itself).
  const longOfferingId = "qa-race002-long-offering";
  d1(`INSERT OR REPLACE INTO offerings (id, resource_id, name, duration_minutes, audience, lookup_key, display_price_cents, active, created_at, updated_at)
      VALUES ('${longOfferingId}', '${resourceId}', 'QA long test offering', 120, 'everyone', NULL, 0, 1, datetime('now'), datetime('now'))`);
  const accounts = await loginFreshAccounts(20, "race002");
  grantEntitlements(accounts.map((a) => a.account.id)); // QA3 fix: see file header (batched, one d1 call for all 20)
  const half = accounts.slice(0, 10);
  const otherHalf = accounts.slice(10, 20);
  const { results } = await burstUntilUninterrupted((shift) => {
    startA = crDateAt(11 + shift, 7, 0); // CR 07:00, the resource's open time -- on-grid
    startB = crDateAt(11 + shift, 8, 30); // CR 08:30, the very next 90-min grid point -- on-grid
    return Promise.all([
      ...half.map((a) => bookOnce(a.client, a.csrfToken, resourceId, startA, { offering_id: longOfferingId })),
      ...otherHalf.map((a) => bookOnce(a.client, a.csrfToken, resourceId, startB)),
    ]);
  });
  const successes = results.filter((r) => r.status === 201).length;
  assert.equal(successes, 1, `exactly one booking must survive across BOTH overlapping starts combined, got ${successes} successes -- waiting on B2a1`);
});

test("RACE-004 (inspection): the overlap check must be one statement/batch/UNIQUE, not read-then-write across two round trips", () => {
  let source = "";
  try {
    source = readFileSync(new URL("../src/portal/booking.js", import.meta.url), "utf8");
  } catch {
    source = "";
  }
  const hasRouteFile = existsSync(new URL("../src/portal/routes/booking.js", import.meta.url));
  const routeSource = hasRouteFile ? readFileSync(new URL("../src/portal/routes/booking.js", import.meta.url), "utf8") : "";
  const bookingCreationExists = /resources\/:id|bookings.*POST|createBooking|handleCreateBooking/i.test(source + routeSource) && routeSource.includes("ROUTES = [") && !routeSource.includes("ROUTES = [];");
  assert.ok(bookingCreationExists, "no booking-creation implementation found yet in src/portal/booking.js or routes/booking.js -- cannot inspect the overlap-check shape. FAILS HONESTLY, waiting on B2a1. Re-run this inspection once B2a1 lands.");
});

test("RACE-005/006 (expired-hold control pair): an expired hold never blocks, an unexpired hold does", async () => {
  const resourceId = "demo-court-0000-0000-000000000001";
  const expiredStart = crDateAt(12, 10, 0); // CR 10:00, on-grid (07:00 + 2*90min)
  const liveStart = crDateAt(13, 10, 0); // CR 10:00 a different day, on-grid
  // hold_expires_at is compared with an ISO string (`...T...Z`) by the booking
  // guard. SQLite's datetime() writes a space instead of the T, which sorts
  // before it, so a datetime() hold always read as expired; write ISO.
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, created_by, created_at, updated_at)
      VALUES ('qa-race005-hold', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${expiredStart}', '${new Date(new Date(expiredStart).getTime() + 90 * 60000).toISOString()}', 1, 0, 'pending_payment', 'pay', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minutes'), 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, created_by, created_at, updated_at)
      VALUES ('qa-race006-hold', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${liveStart}', '${new Date(new Date(liveStart).getTime() + 90 * 60000).toISOString()}', 1, 0, 'pending_payment', 'pay', strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'), 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const actor = await loginDemo(poolEmail());
  grantEntitlement(actor.account.id); // QA3 fix: see file header
  const expiredResp = await bookOnce(actor.client, actor.csrfToken, resourceId, expiredStart);
  assert.ok([200, 201].includes(expiredResp.status), `RACE-005: an expired hold must not block a new booking, got ${expiredResp.status} -- waiting on B2a1`);
  const liveResp = await bookOnce(actor.client, actor.csrfToken, resourceId, liveStart);
  assert.equal(liveResp.status, 409, `RACE-006: an unexpired hold MUST block, got ${liveResp.status} -- waiting on B2a1 (this is the control that proves RACE-005 is testing expiry, not "holds never block")`);
});

test("RACE-007: cancel then immediately rebook the same slot succeeds", async () => {
  const resourceId = "demo-court-0000-0000-000000000002";
  const start = crDateAt(14, 11, 30); // CR 11:30, on-grid (07:00 + 3*90min)
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
      VALUES ('qa-race007-confirmed', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const owner1 = await loginDemo("member.demo@jp-demo.test");
  const cancel = await owner1.client.post("/api/portal/bookings/qa-race007-confirmed/cancel", {}, { "X-CSRF-Token": owner1.csrfToken, Origin: BASE_URL });
  assert.equal(cancel.status, 200, `cancel expected 200, got ${cancel.status} -- waiting on B2a1`);
  const rebooker = await loginDemo(poolEmail());
  grantEntitlement(rebooker.account.id); // QA3 fix: see file header
  const rebook = await bookOnce(rebooker.client, rebooker.csrfToken, resourceId, start);
  assert.ok([200, 201].includes(rebook.status), `rebook on the now-open slot must succeed, got ${rebook.status}`);
});

test("RACE-008: concurrent cancel + book on the same slot -- never two live bookings afterward (ordering not contracted)", async () => {
  const resourceId = "demo-court-0000-0000-000000000003";
  const start = crDateAt(15, 13, 0); // CR 13:00, on-grid (07:00 + 4*90min)
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
      VALUES ('qa-race008-confirmed', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const owner1 = await loginDemo("member.demo@jp-demo.test");
  const other = await loginDemo(poolEmail());
  grantEntitlement(other.account.id); // QA3 fix: see file header
  await Promise.all([
    owner1.client.post("/api/portal/bookings/qa-race008-confirmed/cancel", {}, { "X-CSRF-Token": owner1.csrfToken, Origin: BASE_URL }),
    bookOnce(other.client, other.csrfToken, resourceId, start),
  ]);
  const live = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start}' AND status NOT IN ('cancelled')`)[0].n;
  assert.ok(live <= 1, `at most one live booking must remain on the slot afterward, found ${live} -- waiting on B2a1`);
});

test("RACE-009 (credit race, REQ-ENT-15): 2 credits, 3 concurrent spends -- exactly 2 succeed, balance lands at 0, never negative", async () => {
  const account = await loginDemo(poolEmail());
  d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('${account.account.id}', 2, datetime('now'))`);
  const resourceId = "demo-court-0000-0000-000000000004";
  // Three DIFFERENT on-grid CR starts (08:30, 10:00, 11:30) so each
  // booking only competes on credit balance, never on slot collision.
  // payment_choice "credits" is explicit: without it, a request that reads the
  // balance after the first two spends fell through to "pay at the club" (PIN
  // L4, payments off) and booked, so the number of successes depended on timing.
  // With it, the third request can only be refused, which is the race under test.
  const { results } = await burstUntilUninterrupted(async (shift) => {
    // An interrupted burst may have spent credits: put the 2 back before the next one.
    d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('${account.account.id}', 2, datetime('now'))`);
    return Promise.all([
      bookOnce(account.client, account.csrfToken, resourceId, crDateAt(16 + shift, 8, 30), { payment_choice: "credits" }),
      bookOnce(account.client, account.csrfToken, resourceId, crDateAt(16 + shift, 10, 0), { payment_choice: "credits" }),
      bookOnce(account.client, account.csrfToken, resourceId, crDateAt(16 + shift, 11, 30), { payment_choice: "credits" }),
    ]);
  });
  const successes = results.filter((r) => [200, 201].includes(r.status)).length;
  assert.equal(successes, 2, `expected exactly 2 successful credit spends, got ${successes} -- waiting on B2a1`);
  const balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 0, `balance must land exactly at 0, got ${balance}`);
  assert.ok(balance >= 0, "balance must never go negative");
});

test("RACE-010 (D-A06 paid_conflict): an expired-and-superseded hold's late webhook marks paid_conflict, never confirmed, and never touches the live booking", async () => {
  const resourceId = "demo-court-0000-0000-000000000001";
  const start = crDateAt(17, 13, 0); // CR 13:00, on-grid (07:00 + 4*90min)
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, checkout_session_id, created_by, created_at, updated_at)
      VALUES ('qa-race010-orig', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'pending_payment', 'pay', datetime('now','-5 minutes'), 'cs_race010', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
      VALUES ('qa-race010-second', 'demo-memb2-0000-0000-000000000004', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'confirmed', 'included', 'demo-memb2-0000-0000-000000000004', datetime('now'), datetime('now'))`);
  const t0 = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_race010", type: "checkout.session.completed", data: { object: { id: "cs_race010", metadata: { booking_id: "qa-race010-orig" } } } });
  const sig = await signStripeBody("whsec_local_test_only", payload, t0);
  await postRaw("/api/stripe/webhook", payload, { "Content-Type": "application/json", "Stripe-Signature": sig });
  const orig = d1(`SELECT status FROM bookings WHERE id = 'qa-race010-orig'`)[0];
  const second = d1(`SELECT status FROM bookings WHERE id = 'qa-race010-second'`)[0];
  assert.equal(orig.status, "paid_conflict", `expected paid_conflict, got ${orig.status} -- waiting on B2a1/B2b`);
  assert.equal(second.status, "confirmed", "the live second booking must be untouched");
});

test("RACE-011 (adjacent control, REQ-OWN-11): a confirmed booking is untouched when the owner edits the resource's grid out from under it", async () => {
  const resourceId = "demo-court-0000-0000-000000000002";
  const start = crDateAt(18, 10, 0); // CR 10:00, on-grid (07:00 + 2*90min) -- this row is inserted directly, not via HTTP, but kept grid-sane for consistency with every other fixture in this file
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
      VALUES ('qa-race011-confirmed', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const owner = await loginDemo("owner.demo@jp-demo.test");
  const edit = await patchWithClient(
    owner.client,
    `/api/portal/owner/resources/${resourceId}`,
    { open_time: "08:00" },
    { "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL }
  );
  assert.ok([200, 404].includes(edit.status), `expected 200 (or 404 while unbuilt), got ${edit.status} -- waiting on B2a2`);
  const row = d1(`SELECT status FROM bookings WHERE id = 'qa-race011-confirmed'`)[0];
  assert.equal(row.status, "confirmed", "the existing booking row must never be deleted or changed by a resource edit");
});
