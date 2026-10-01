// QA2: test-plan.md §7 Booking windows, grid and non-functional
// boundaries, BOOK-001..012. BOOK-001/003 are conditional on A-13
// (reading 2, requirements-steward's chosen default): slot CR-date <=
// today(CR) + window days. S-12 (amendment 3) gives the grid-start rule
// used for BOOK-007..010.
//
// FR2-E (2026-10-01, fixes inspection-1.md M11): the old local `crDateAt`
// here set UTC hours while every case named a Costa Rica time, so
// BOOK-007..010 never tested the S-12 grid at all -- "07:15" was 01:15
// CR, "17:30" was 11:30 CR (which happens to land on-grid by accident),
// "06:00/19:00" were 00:00/13:00 CR. Any pass came from the window or
// the account's cap on member.demo, never from a grid check. Every
// fixture below now states its Costa Rica time and goes through
// `crDateAt` (qa-helpers.mjs), which converts CR wall-clock -> UTC per
// PIN-6 (UTC-6, no DST). See the pure conversion assertion below.
//
// FR2-E also re-assigns which court resource each case uses. M11 named
// the account cap (max_active_per_account = 2, scripts/seed-preview.sql)
// as a confound: if a grid/hours case wrongly succeeds while M10 (the
// engine has no grid/hours check at all) is still open, that extra
// booking eats a cap slot, and a LATER case on the same resource can
// then fail with 409-cap instead of its own real assertion -- a false
// result that looks like a pass for the wrong reason. Resources are
// grouped so no pending-M10 case can push a shared resource past its
// cap-of-2 and corrupt a different case's result (see the per-resource
// tally in the BOOK-007..010 block below).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, poolEmail, BASE_URL, d1, crDateAt, crWallClockToUtcIso, resetRateLimits } from "./qa-helpers.mjs";

// FINDING (qa-run-1.md, self-found defect in this suite, fixed same
// day per the seat's own law): this file logs in member.demo/owner.demo
// more than 5 times each -- the per-email 5/15min rate limit (REQ-AUTH-
// 07) would otherwise trip mid-file and poison the shared rate_limits
// table for every file that runs after this one (H-1). Reset at load.
resetRateLimits();

// ---------- Pure conversion assertion (acceptance for this dispatch) ----------
// No server, no "now" -- a fixed CR wall-clock reading converted to the
// UTC instant PIN-6 requires on the wire. If this ever goes red, every
// other case in this file is testing the wrong instant.
test("crWallClockToUtcIso (PIN-6): CR 07:00 on a fixed date == 13:00:00.000Z", () => {
  assert.equal(crWallClockToUtcIso(2026, 12, 25, 7, 0), "2026-12-25T13:00:00.000Z");
});
test("crWallClockToUtcIso (PIN-6): CR 19:00 rolls to the NEXT UTC calendar day (S-12's own 19:00 example)", () => {
  assert.equal(crWallClockToUtcIso(2026, 6, 30, 19, 0), "2026-07-01T01:00:00.000Z");
});

async function book(client, csrfToken, resourceId, start, extra = {}) {
  return client.post("/api/portal/bookings", { resource_id: resourceId, start, party_size: 1, ...extra }, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
}

test("BOOK-001/002 (conditional on A-13 reading 2): member window boundary -- CR 08:30 (on-grid, so the window is the only variable), today+7 OK, today+8 rejected", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const member = await loginDemo("member.demo@jp-demo.test");
  const ok = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(7, 8, 30));
  assert.equal(ok.status, 201, `BOOK-001: CR 08:30 today+7, expected 200/201, got ${ok.status}`);
  const over = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(8, 8, 30));
  assert.equal(over.status, 409, `BOOK-002: CR 08:30 today+8, expected 409 window-exceeded, got ${over.status}`);
});

test("BOOK-003/004: guest non-member window boundary -- CR 08:30 (on-grid), today+2 OK, today+3 rejected", async () => {
  const guest = await loginDemo(poolEmail());
  const ok = await book(guest.client, guest.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(2, 8, 30));
  assert.equal(ok.status, 201, `BOOK-003: CR 08:30 today+2, expected 200/201, got ${ok.status}`);
  const over = await book(guest.client, guest.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(3, 8, 30));
  assert.equal(over.status, 409, `BOOK-004: CR 08:30 today+3, expected 409, got ${over.status}`);
});

test("BOOK-005 (D-A13): owner has no window -- CR 08:30 today+60 succeeds", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const owner = await loginDemo("owner.demo@jp-demo.test");
  const resp = await book(owner.client, owner.csrfToken, "demo-court-0000-0000-000000000003", crDateAt(60, 8, 30));
  assert.equal(resp.status, 201, `expected 200/201 (no window for owner), CR 08:30 today+60, got ${resp.status}`);
});

test("BOOK-006: a start in the past is rejected -- CR 08:30 yesterday", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000004", crDateAt(-1, 8, 30));
  assert.equal(resp.status, 409, `expected rejection for a past start, CR 08:30 yesterday, got ${resp.status}`);
});

// ---------- S-12 grid + hours (M10 pending: booking.js has no grid/hours
// check yet, per inspection-1.md -- these cases are EXPECTED to fail
// (observe 201 instead of 409) until that lands. A test failing here is
// correct: the product is wrong, and weakening the assertion would hide
// it. See the dispatch note above on resource grouping: resource 2 takes
// BOOK-007 + BOOK-008's "before open" leg (2 cap-slots, exactly the
// cap), resource 4 takes BOOK-008's "after hours" leg + BOOK-010 (2
// cap-slots, exactly the cap). Even if every one of these four wrongly
// succeeds while M10 is open, neither resource is pushed past its cap,
// so none of these four can mask another one's result as "cap
// exceeded" instead of "grid/hours missing". ----------

test("BOOK-007 (S-12, pending M10): a start off the 90-min grid -- CR 07:15 (not open+k*90) is rejected", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(3, 7, 15));
  // M11 fix: api.md:66 and booking.js:409 both answer 400 off_grid for a
  // grid miss, never 409 -- 409 is reserved for conflict-class errors
  // (slot_taken, cap_reached, ...), which this is not.
  assert.equal(resp.status, 400, `S-12: CR 07:15 is not a grid start, expected 400, got ${resp.status}`);
  assert.equal(resp.data.error, "off_grid");
});

test("BOOK-008 (S-12, pending M10): a start before open (CR 06:00) and a start past the last valid grid slot (CR 19:00, ends 20:30) are both rejected", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const member = await loginDemo("member.demo@jp-demo.test");
  const before = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(3, 6, 0));
  // M11 fix: api.md:66 and booking.js:409 both answer 400 outside_hours.
  assert.equal(before.status, 400, `S-12: CR 06:00 is before 07:00 open, expected 400, got ${before.status}`);
  assert.equal(before.data.error, "outside_hours");
  const after = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000004", crDateAt(3, 19, 0));
  assert.equal(after.status, 400, `S-12: CR 19:00 would end 20:30, outside 07:00-19:30 hours, expected 400, got ${after.status}`);
  assert.equal(after.data.error, "outside_hours");
});

test("BOOK-009 (D-A14 grid tail, boundary): CR 17:30 is the last valid start, ending CR 19:00 within hours -- succeeds regardless of M10", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000003", crDateAt(4, 17, 30));
  assert.equal(resp.status, 201, `CR 17:30 is on-grid and within hours, expected 200/201, got ${resp.status}`);
});

test("BOOK-010 (S-12, pending M10; pin-wording finding): CR 18:00 -- not reachable as open+k*90 (07:00..17:30 only, 19:00 excluded) -- rejected, overriding D-A14's literal 'ends <= close' reading", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000004", crDateAt(4, 18, 0));
  // S-12 (amendment 3, later than D-A14) resolves the ambiguity
  // test-plan.md flagged: starts fall only at open + k*(slot+buffer);
  // 18:00 is not among 07:00..17:30 (nor is 19:00, excluded because it
  // would end 20:30). S-12 wins as the later pin.
  // M11 fix: api.md:66 and booking.js:409 both answer 400 off_grid.
  assert.equal(resp.status, 400, `S-12 excludes CR 18:00 as a non-grid start, expected 400, got ${resp.status}`);
  assert.equal(resp.data.error, "off_grid");
});

test("BOOK-011: a slot blocked by the owner is rejected -- block and booking both at CR 10:00 (on-grid)", async () => {
  const resourceId = "demo-msg-00000-0000-000000000005";
  const blockStart = crDateAt(5, 10, 0);
  d1(`INSERT INTO blocks (id, resource_id, kind, date, start_time, end_time, label, created_by, created_at) VALUES ('qa-book011-block', '${resourceId}', 'one_off', date('${blockStart}'), '10:00', '11:00', 'QA block', 'demo-owner-0000-0000-000000000001', datetime('now'))`);
  const member = await loginDemo(poolEmail());
  const resp = await book(member.client, member.csrfToken, resourceId, blockStart, { offering_id: "demo-off-00000-0000-000000000005" });
  assert.equal(resp.status, 409, `expected rejection for a blocked slot (CR 10:00), got ${resp.status}`);
});

test("BOOK-012: entitled member goes straight to confirmed/no-checkout at CR 08:30 today+6; non-entitled gets S-11's 503 in THIS harness (Stripe never configured) at CR 08:30 today+1", async () => {
  resetRateLimits(); // self-found FR2-E fix: 7 member.demo + 1 owner.demo logins in this file exceed the 5/15min per-email limit (REQ-AUTH-07); reset before each so none of them silently withholds dev_link
  const entitled = await loginDemo("member.demo@jp-demo.test");
  const entitledResp = await book(entitled.client, entitled.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(6, 8, 30));
  assert.equal(entitledResp.status, 201, `entitled path expected 201, got ${entitledResp.status}`);
  assert.equal(entitledResp.data.booking.status, "confirmed");
  assert.ok(!entitledResp.data.booking.checkout_url, "an entitled member must never see a Checkout call");

  // FINDING (see qa-run-1.md): test-plan.md's BOOK-012 non-entitled leg
  // reads "pending_payment with hold_expires_at ... Checkout session
  // created" -- but this harness never sets STRIPE_SECRET_KEY (B2-COMMON
  // law: secrets unset, not-configured path only), and S-12/S-11
  // (amendment 3) is explicit that a paid booking with Stripe unset
  // returns the PIN-11 503 BEFORE writing any hold at all. The two pins
  // describe different Stripe-availability worlds; this harness is only
  // ever in the unset one, so 503+no-row is the correct expected result
  // for THIS suite, not the original table's wording. The
  // pending_payment/checkout_url shape needs a configured (sandboxed)
  // Stripe key to ever be observed and is out of this suite's reach.
  const guest = await loginDemo(poolEmail());
  const guestResp = await book(guest.client, guest.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(1, 8, 30));
  assert.equal(guestResp.status, 503, `S-11: payment needed + Stripe unset must be 503 before any hold, got ${guestResp.status}`);
  assert.deepEqual(guestResp.data, { error: "not_configured", feature: "stripe" });
});
