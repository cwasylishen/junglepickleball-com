// QA2: test-plan.md §7 Booking windows, grid and non-functional
// boundaries, BOOK-001..012. BOOK-001/003 are conditional on A-13
// (reading 2, requirements-steward's chosen default): slot CR-date <=
// today(CR) + window days. S-12 (amendment 3) gives the grid-start rule
// used for BOOK-007..010.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, uniqueEmail, BASE_URL, d1, resetRateLimits } from "./qa-helpers.mjs";

// FINDING (qa-run-1.md, self-found defect in this suite, fixed same
// day per the seat's own law): this file logs in member.demo/owner.demo
// more than 5 times each -- the per-email 5/15min rate limit (REQ-AUTH-
// 07) would otherwise trip mid-file and poison the shared rate_limits
// table for every file that runs after this one (H-1). Reset at load.
resetRateLimits();

function crDateAt(daysAhead, hour, minute = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

async function book(client, csrfToken, resourceId, start, extra = {}) {
  return client.post("/api/portal/bookings", { resource_id: resourceId, start, party_size: 1, ...extra }, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
}

test("BOOK-001/002 (conditional on A-13 reading 2): member window boundary -- today+7 OK, today+8 rejected", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const ok = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(7, 8));
  assert.equal(ok.status, 201, `BOOK-001: expected 200/201 at today+7, got ${ok.status} -- waiting on B2a1. If Roger rules reading 1/3, this expected result flips (H-5).`);
  const over = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(8, 8));
  assert.equal(over.status, 409, `BOOK-002: expected 409 window-exceeded at today+8, got ${over.status}`);
});

test("BOOK-003/004: guest non-member window boundary -- today+2 OK, today+3 rejected", async () => {
  const guest = await loginDemo(uniqueEmail("book003"));
  const ok = await book(guest.client, guest.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(2, 8));
  assert.equal(ok.status, 201, `BOOK-003: expected 200/201 at today+2, got ${ok.status} -- waiting on B2a1`);
  const over = await book(guest.client, guest.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(3, 8));
  assert.equal(over.status, 409, `BOOK-004: expected 409 at today+3, got ${over.status}`);
});

test("BOOK-005 (D-A13): owner has no window -- booking today+60 succeeds", async () => {
  const owner = await loginDemo("owner.demo@jp-demo.test");
  const resp = await book(owner.client, owner.csrfToken, "demo-court-0000-0000-000000000003", crDateAt(60, 8));
  assert.equal(resp.status, 201, `expected 200/201 (no window for owner), got ${resp.status} -- waiting on B2a1`);
});

test("BOOK-006: a start in the past is rejected", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000004", crDateAt(-1, 8));
  assert.equal(resp.status, 409, `expected rejection for a past start, got ${resp.status} -- waiting on B2a1`);
});

test("BOOK-007: a start off the 90-minute grid (07:15) is rejected", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(3, 7, 15));
  assert.equal(resp.status, 409, `expected rejection for a misaligned start, got ${resp.status} -- waiting on B2a1`);
});

test("BOOK-008: a start before open (06:00) and a start past the last valid grid slot (19:00) are both rejected", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const before = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(3, 6, 0));
  assert.equal(before.status, 409, `expected rejection before open, got ${before.status} -- waiting on B2a1`);
  const after = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(3, 19, 0));
  assert.equal(after.status, 409, `S-12: 19:00 would end at 20:30, outside 07:00-19:30 hours -- expected rejection, got ${after.status}`);
});

test("BOOK-009 (D-A14 grid tail, boundary): 17:30 is the last valid start, ending 19:00 within hours", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000003", crDateAt(4, 17, 30));
  assert.equal(resp.status, 201, `expected 200/201, got ${resp.status} -- waiting on B2a1`);
});

test("BOOK-010 (D-A14 grid tail, pin-wording finding): 18:00 start -- literal 'ends <= close' text permits it; a rejection is a pin-wording defect, not a build defect", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await book(member.client, member.csrfToken, "demo-court-0000-0000-000000000004", crDateAt(4, 18, 0));
  // S-12 (amendment 3, later than D-A14) resolves this explicitly: starts
  // fall only at open + k*(slot+buffer); 19:00 (and by the same rule
  // 18:00 for a 90-min grid from 07:00) is NOT a valid start per S-12's
  // own worked example (07:00..17:30 only). S-12 wins as the later pin,
  // so the expected result here is REJECTED, overriding D-A14's literal
  // "ends <= close" reading that test-plan.md flagged as ambiguous.
  assert.equal(resp.status, 409, `S-12 (later amendment, wins over D-A14) excludes 18:00 as a non-grid start; got ${resp.status} -- waiting on B2a1`);
});

test("BOOK-011: a slot blocked by the owner is rejected", async () => {
  const resourceId = "demo-msg-00000-0000-000000000005";
  const blockStart = crDateAt(5, 10, 0);
  d1(`INSERT INTO blocks (id, resource_id, kind, date, start_time, end_time, label, created_by, created_at) VALUES ('qa-book011-block', '${resourceId}', 'one_off', date('${blockStart}'), '10:00', '11:00', 'QA block', 'demo-owner-0000-0000-000000000001', datetime('now'))`);
  const member = await loginDemo(uniqueEmail("book011"));
  const resp = await book(member.client, member.csrfToken, resourceId, blockStart, { offering_id: "demo-off-00000-0000-000000000005" });
  assert.equal(resp.status, 409, `expected rejection for a blocked slot, got ${resp.status} -- waiting on B2a1`);
});

test("BOOK-012: entitled member goes straight to confirmed/no-checkout; non-entitled gets S-11's 503 in THIS harness (Stripe never configured)", async () => {
  const entitled = await loginDemo("member.demo@jp-demo.test");
  const entitledResp = await book(entitled.client, entitled.csrfToken, "demo-court-0000-0000-000000000001", crDateAt(6, 8));
  assert.equal(entitledResp.status, 201, `entitled path expected 201, got ${entitledResp.status} -- waiting on B2a1`);
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
  const guest = await loginDemo(uniqueEmail("book012"));
  const guestResp = await book(guest.client, guest.csrfToken, "demo-court-0000-0000-000000000002", crDateAt(1, 9));
  assert.equal(guestResp.status, 503, `S-11: payment needed + Stripe unset must be 503 before any hold, got ${guestResp.status} -- waiting on B2a1`);
  assert.deepEqual(guestResp.data, { error: "not_configured", feature: "stripe" });
});
