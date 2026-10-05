// B2a1's own red-then-green probes for CTL-BOOK-01 / A2 (amendment 1):
// no double booking survives concurrent requests under any slot/buffer/
// hours/block change. Black-box HTTP against the real bundle (PIN-16).
//
// These use ONLY the five pre-seeded demo accounts (scripts/seed-preview.sql),
// never a freshly-registered @jp-demo.test email: `src/portal/auth.js`'s
// `demoDevLink()` (S-1 e) returns a `dev_link` only for an email that
// ALREADY EXISTS as `is_demo` -- an unknown address gets the normal
// generic response with no token exposed, so `loginDemo()` on a brand
// new address throws "no dev_link". That is a foundation (B1) control
// working as designed, not a bug in this file -- see this part's
// dispatch return for the same finding against QA2's `tests/races.test.mjs`,
// which assumes the opposite and is not this part's file to edit.
// Member/annual accounts (`included` payment mode) are used here instead
// of fresh guests so the race itself, not the Stripe-unconfigured gate,
// is what's under test.
//
// QA2's independent `tests/races.test.mjs` covers the same scenarios
// from the black-box/acceptance side; this file is the developer's own
// probe, written with the code (not after), proving the exact mechanism
// named in booking.js's own comments: a single `INSERT ... WHERE NOT
// EXISTS (...)` statement, never a read-then-write pair. The RED side of
// PIN-18 (the guard disabled) was demonstrated once by hand -- replacing
// the WHERE NOT EXISTS guard with a plain INSERT and watching every one
// of these assertions fail before the real guard was restored -- see
// this part's dispatch return for that transcript; a permanently-red
// test has no place in a suite that must stay green (B2-COMMON).

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL, utcOnCrDay, burstUntilUninterrupted } from "./helpers.mjs";

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

async function create(client, csrfToken, resourceId, start, extra = {}) {
  return client.post("/api/portal/bookings", { resource_id: resourceId, start, party_size: 1, ...extra }, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
}

test("B2a1 equal-start race: 20 concurrent creates on the same resource+start, exactly 1 success", async () => {
  const resourceId = "demo-court-0000-0000-000000000001";
  const actor = await loginSeeded("member.demo@jp-demo.test"); // included mode -- no Stripe gate in the way
  let start;
  const { results } = await burstUntilUninterrupted((shift) => {
    start = freshStartIso(1 + shift, 13); // 07:00 CR -- on Court 1's grid (portal(FR2-B)/M10)
    return Promise.all(Array.from({ length: 20 }, () => create(actor.client, actor.csrfToken, resourceId, start)));
  });
  const successes = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409 && r.data && r.data.error === "slot_taken").length;
  assert.equal(successes, 1, `expected exactly 1 success, got ${successes} (statuses: ${results.map((r) => r.status).join(",")})`);
  assert.equal(conflicts, 19, `expected 19 slot_taken conflicts, got ${conflicts}`);
  const live = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND start_at = '${start}' AND status != 'cancelled'`)[0].n;
  assert.equal(live, 1, "exactly one non-cancelled row must exist for this resource+start afterward");
});

test("B2a1 overlapping-different-start race (A2 + M10): slot length changed mid-test; the half-slot-offset start that used to overlap is now refused off_grid outright, never raced into a double-booking", async () => {
  // portal(FR2-B)/M10: before the grid/hours check existed, startB
  // (half the new slot length off startA) was accepted and could
  // straddle/overlap startA's cell -- the exact failure this test
  // originally named. M10 now refuses an off-grid start at the door,
  // so the scenario below proves the SAME guarantee (never two
  // overlapping bookings survive a slot-length change) by rejection
  // rather than by racing the overlap guard.
  const resourceId = "demo-court-0000-0000-000000000002";
  d1(`UPDATE resources SET slot_minutes = 60 WHERE id = '${resourceId}'`);
  try {
    const actor = await loginSeeded("member.demo@jp-demo.test");
    let startA;
    let startB;
    const { results } = await burstUntilUninterrupted((shift) => {
      startA = freshStartIso(1 + shift, 15, 0); // 09:00 CR -- on the NEW 60-min grid
      startB = freshStartIso(1 + shift, 15, 30); // 09:30 CR -- off the 60-min grid; would have overlapped startA's cell
      return Promise.all([
        ...Array.from({ length: 10 }, () => create(actor.client, actor.csrfToken, resourceId, startA)),
        ...Array.from({ length: 10 }, () => create(actor.client, actor.csrfToken, resourceId, startB)),
      ]);
    });
    const successesA = results.slice(0, 10).filter((r) => r.status === 201).length;
    const offGridB = results.slice(10).filter((r) => r.status === 400 && r.data && r.data.error === "off_grid").length;
    assert.equal(successesA, 1, `exactly one of the on-grid startA calls must succeed, got ${successesA}`);
    assert.equal(offGridB, 10, `every off-grid startB call must be refused 400 off_grid, got statuses: ${results.slice(10).map((r) => r.status).join(",")}`);
    const live = d1(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = '${resourceId}' AND status != 'cancelled' AND start_at IN ('${startA}', '${startB}')`)[0].n;
    assert.equal(live, 1, "exactly one booking must survive across both starts combined");
  } finally {
    d1(`UPDATE resources SET slot_minutes = 90 WHERE id = '${resourceId}'`); // repeatable: restore the seeded default
  }
});

test("B2a1 expired-hold reuse: an expired pending_payment hold never blocks a new booking, with no cleanup job run first", async () => {
  const resourceId = "demo-court-0000-0000-000000000003";
  const start = freshStartIso(1, 16); // 10:00 CR -- on Court 3's grid (portal(FR2-B)/M10)
  const end = freshStartIso(1, 17, 30);
  // Directly seeds an expired hold (hold_expires_at in the past) -- no
  // sweep/cron runs between this insert and the request below, which is
  // the point: the overlap predicate itself excludes it at read time.
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, created_by, created_at, updated_at)
     VALUES ('b2a1-expired-hold-1', 'demo-guest-0000-0000-000000000005', '${resourceId}', NULL, '${start}', '${end}', 1, 0, 'pending_payment', 'pay', datetime('now','-1 minutes'), 'demo-guest-0000-0000-000000000005', datetime('now'), datetime('now'))`
  );
  const actor = await loginSeeded("member.demo@jp-demo.test");
  const resp = await create(actor.client, actor.csrfToken, resourceId, start);
  assert.ok([200, 201].includes(resp.status), `an expired hold must not block, got ${resp.status} ${JSON.stringify(resp.data)}`);
  const stillThereRow = d1(`SELECT status FROM bookings WHERE id = 'b2a1-expired-hold-1'`)[0];
  assert.equal(stillThereRow.status, "pending_payment", "the stale expired-hold row itself is untouched -- no cleanup job ran");
});

test("B2a1 cancel-then-rebook: cancelling a confirmed booking immediately frees the slot for a new one", async () => {
  const resourceId = "demo-court-0000-0000-000000000004";
  // Three days out: online cancellation closes 24 h before the start (PIN L3),
  // so a booking for tomorrow could not be cancelled by its holder after 13:00 CR today.
  const start = freshStartIso(3, 19); // 13:00 CR -- on Court 4's grid (portal(FR2-B)/M10)
  const end = freshStartIso(3, 20, 30);
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('b2a1-rebook-src', 'demo-memb1-0000-0000-000000000003', '${resourceId}', NULL, '${start}', '${end}', 1, 0, 'confirmed', 'included', 'demo-memb1-0000-0000-000000000003', datetime('now'), datetime('now'))`
  );
  const holder = await loginSeeded("member.demo@jp-demo.test");
  const cancel = await holder.client.post("/api/portal/bookings/b2a1-rebook-src/cancel", {}, { "X-CSRF-Token": holder.csrfToken, Origin: BASE_URL });
  assert.equal(cancel.status, 200, `cancel expected 200, got ${cancel.status} ${JSON.stringify(cancel.data)}`);
  const rebooker = await loginSeeded("member2.demo@jp-demo.test"); // a different account proves the slot is genuinely open, not just re-held by its own owner
  const rebook = await create(rebooker.client, rebooker.csrfToken, resourceId, start);
  assert.ok([200, 201].includes(rebook.status), `rebook on the now-open slot must succeed, got ${rebook.status} ${JSON.stringify(rebook.data)}`);
});
