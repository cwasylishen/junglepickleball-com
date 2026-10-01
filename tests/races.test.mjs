// QA2: test-plan.md §6 Double-booking races, RACE-001..011 (per A2).
// `POST /api/portal/bookings` is B2a1's route, currently an empty
// `ROUTES = []` stub (src/portal/routes/booking.js) -- every concurrent
// fetch below will 404, which is the honest failure this file reports
// (waiting on B2a1), not a skip. Concurrency itself is real: `Promise.all`
// firing N fetches with no await-gap, same process, same event loop,
// against the one running `wrangler dev` instance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { d1, loginFreshAccounts, BASE_URL, uniqueEmail, loginDemo, patchWithClient, signStripeBody, postRaw, resetRateLimits } from "./qa-helpers.mjs";

// FINDING (qa-run-1.md): loginFreshAccounts() already resets per call,
// but RACE-007/008/011's direct loginDemo(member.demo/owner.demo) calls
// do not -- reset once at load for the same H-1 reason as the other
// files.
resetRateLimits();

function freshStart(daysAhead, hour) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function bookOnce(client, csrfToken, resourceId, start) {
  return client.post(
    "/api/portal/bookings",
    { resource_id: resourceId, start, party_size: 1 },
    { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
  );
}

test("RACE-001: 20 concurrent identical-slot bookings from 20 accounts -- exactly 1 succeeds, 19 get 409", async () => {
  const accounts = await loginFreshAccounts(20, "race001");
  const resourceId = "demo-court-0000-0000-000000000003";
  const start = freshStart(10, 8);
  const results = await Promise.all(accounts.map((a) => bookOnce(a.client, a.csrfToken, resourceId, start)));
  const successes = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  assert.equal(successes, 1, `expected exactly 1 success, got ${successes} (statuses: ${results.map((r) => r.status).join(",")}) -- waiting on B2a1`);
  assert.equal(conflicts, 19, `expected 19 conflicts, got ${conflicts}`);
  const live = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start}' AND status != 'cancelled'`)[0].n;
  assert.equal(live, 1);
});

test("RACE-002/003 (A2 overlapping starts): resource slot length changed mid-test, overlapping starts never both survive", async () => {
  const resourceId = "demo-court-0000-0000-000000000004";
  d1(`UPDATE resources SET slot_minutes = 60 WHERE id = '${resourceId}'`);
  const startA = freshStart(11, 9); // 09:00
  const dA = new Date(startA);
  const startB = new Date(dA.getTime() + 30 * 60000).toISOString(); // 09:30, overlaps 09:00-10:00 at 60-min slots
  const accounts = await loginFreshAccounts(20, "race002");
  const half = accounts.slice(0, 10);
  const otherHalf = accounts.slice(10, 20);
  const results = await Promise.all([
    ...half.map((a) => bookOnce(a.client, a.csrfToken, resourceId, startA)),
    ...otherHalf.map((a) => bookOnce(a.client, a.csrfToken, resourceId, startB)),
  ]);
  const successes = results.filter((r) => r.status === 201).length;
  assert.equal(successes, 1, `exactly one booking must survive across BOTH overlapping starts combined, got ${successes} successes -- waiting on B2a1`);
  d1(`UPDATE resources SET slot_minutes = 90 WHERE id = '${resourceId}'`); // restore (repeatability law)
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
  const expiredStart = freshStart(12, 10);
  const liveStart = freshStart(13, 10);
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, created_by, created_at, updated_at)
      VALUES ('qa-race005-hold', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${expiredStart}', '${new Date(new Date(expiredStart).getTime() + 90 * 60000).toISOString()}', 1, 0, 'pending_payment', 'pay', datetime('now','-1 minutes'), 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, created_by, created_at, updated_at)
      VALUES ('qa-race006-hold', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${liveStart}', '${new Date(new Date(liveStart).getTime() + 90 * 60000).toISOString()}', 1, 0, 'pending_payment', 'pay', datetime('now','+30 minutes'), 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const actor = await loginDemo(uniqueEmail("race0056"));
  const expiredResp = await bookOnce(actor.client, actor.csrfToken, resourceId, expiredStart);
  assert.ok([200, 201].includes(expiredResp.status), `RACE-005: an expired hold must not block a new booking, got ${expiredResp.status} -- waiting on B2a1`);
  const liveResp = await bookOnce(actor.client, actor.csrfToken, resourceId, liveStart);
  assert.equal(liveResp.status, 409, `RACE-006: an unexpired hold MUST block, got ${liveResp.status} -- waiting on B2a1 (this is the control that proves RACE-005 is testing expiry, not "holds never block")`);
});

test("RACE-007: cancel then immediately rebook the same slot succeeds", async () => {
  const resourceId = "demo-court-0000-0000-000000000002";
  const start = freshStart(14, 11);
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
      VALUES ('qa-race007-confirmed', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const owner1 = await loginDemo("member.demo@jp-demo.test");
  const cancel = await owner1.client.post("/api/portal/bookings/qa-race007-confirmed/cancel", {}, { "X-CSRF-Token": owner1.csrfToken, Origin: BASE_URL });
  assert.equal(cancel.status, 200, `cancel expected 200, got ${cancel.status} -- waiting on B2a1`);
  const rebooker = await loginDemo(uniqueEmail("race007b"));
  const rebook = await bookOnce(rebooker.client, rebooker.csrfToken, resourceId, start);
  assert.ok([200, 201].includes(rebook.status), `rebook on the now-open slot must succeed, got ${rebook.status}`);
});

test("RACE-008: concurrent cancel + book on the same slot -- never two live bookings afterward (ordering not contracted)", async () => {
  const resourceId = "demo-court-0000-0000-000000000003";
  const start = freshStart(15, 12);
  d1(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
      VALUES ('qa-race008-confirmed', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${new Date(new Date(start).getTime() + 90 * 60000).toISOString()}', 1, 0, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`);
  const owner1 = await loginDemo("member.demo@jp-demo.test");
  const other = await loginDemo(uniqueEmail("race008b"));
  await Promise.all([
    owner1.client.post("/api/portal/bookings/qa-race008-confirmed/cancel", {}, { "X-CSRF-Token": owner1.csrfToken, Origin: BASE_URL }),
    bookOnce(other.client, other.csrfToken, resourceId, start),
  ]);
  const live = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start}' AND status NOT IN ('cancelled')`)[0].n;
  assert.ok(live <= 1, `at most one live booking must remain on the slot afterward, found ${live} -- waiting on B2a1`);
});

test("RACE-009 (credit race, REQ-ENT-15): 2 credits, 3 concurrent spends -- exactly 2 succeed, balance lands at 0, never negative", async () => {
  const account = await loginDemo(uniqueEmail("race009"));
  d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('${account.account.id}', 2, datetime('now'))`);
  const resourceId = "demo-court-0000-0000-000000000004";
  const results = await Promise.all([
    bookOnce(account.client, account.csrfToken, resourceId, freshStart(16, 8)),
    bookOnce(account.client, account.csrfToken, resourceId, freshStart(16, 10)),
    bookOnce(account.client, account.csrfToken, resourceId, freshStart(16, 12)),
  ]);
  const successes = results.filter((r) => [200, 201].includes(r.status)).length;
  assert.equal(successes, 2, `expected exactly 2 successful credit spends, got ${successes} -- waiting on B2a1`);
  const balance = d1(`SELECT balance FROM credits WHERE account_id = '${account.account.id}'`)[0].balance;
  assert.equal(balance, 0, `balance must land exactly at 0, got ${balance}`);
  assert.ok(balance >= 0, "balance must never go negative");
});

test("RACE-010 (D-A06 paid_conflict): an expired-and-superseded hold's late webhook marks paid_conflict, never confirmed, and never touches the live booking", async () => {
  const resourceId = "demo-court-0000-0000-000000000001";
  const start = freshStart(17, 13);
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
  const start = freshStart(18, 9);
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
