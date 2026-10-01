// D-A05 (hand grant, audited), D-A02 (household link/unlink),
// D-A03 + CTL-DATA-04 (dependants) + CTL-AUTHZ-02 (who may read one
// back), CTL-ROLE-02 (no endpoint ever grants owner), account delete,
// the accounts list/detail, overlaps and outbox reads.
//
// One owner login for the whole file (CTL-AUTH-07's 5-per-15-minute
// login-start limit is shared across the whole suite run; a session
// lasts 7 days, so one login serves every test below).

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";

const MEMBER_ID = "demo-memb1-0000-0000-000000000003";
const MEMBER2_ID = "demo-memb2-0000-0000-000000000004";
const GUEST_ID = "demo-guest-0000-0000-000000000005";

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

test("accounts list/detail: entitlement is resolved per account, not read from a cached field", async () => {
  const list = await ownerCall("GET", "/api/portal/owner/accounts");
  assert.equal(list.status, 200);
  const member = list.data.find((a) => a.id === MEMBER_ID);
  assert.equal(member.entitlement.tier, "jp_annual_single");

  const detail = await ownerCall("GET", `/api/portal/owner/accounts/${MEMBER_ID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.account.id, MEMBER_ID);
  assert.ok(Array.isArray(detail.data.grants) && detail.data.grants.length >= 1);
});

test("D-A05: a hand grant is audited, one new grant row, never overwriting an existing one (CTL-ENT-01)", async () => {
  const before = d1(`SELECT COUNT(*) AS n FROM entitlement_grants WHERE account_id = '${MEMBER2_ID}'`)[0].n;

  const res = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER2_ID}/grant`, {
    tier: "jp_3m_single",
    starts_at: "2026-10-01T00:00:00.000Z",
    ends_at: "2027-01-01T00:00:00.000Z",
    note: "test: cash",
  });
  assert.equal(res.status, 201);
  const grantId = res.data.grant.id;
  try {
    const after = d1(`SELECT COUNT(*) AS n FROM entitlement_grants WHERE account_id = '${MEMBER2_ID}'`)[0].n;
    assert.equal(after, before + 1, "the pre-existing seeded grant must still be there, untouched");
    const audited = d1(`SELECT * FROM audit_log WHERE target_id = '${grantId}' AND action = 'hand_grant'`);
    assert.equal(audited.length, 1);

    // RED: a bad tier string reaching the INSERT would violate no CHECK
    // (tier has none) and silently create an unusable grant.
    const bad = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER2_ID}/grant`, { tier: "not_a_real_tier", starts_at: "2026-10-01", ends_at: "2027-01-01" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, "bad_tier");
  } finally {
    d1(`DELETE FROM entitlement_grants WHERE id = '${grantId}'`);
    d1(`DELETE FROM audit_log WHERE target_id = '${grantId}'`);
  }
});

test("D-A02: household link is idempotent on the same pair, 409 on a conflicting second partner, and unlink removes it", async () => {
  const first = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER_ID}/household-link`, { partner_account_id: MEMBER2_ID });
  assert.equal(first.status, 200);
  const householdId = first.data.household.id;

  try {
    // RED: a plain unconditional INSERT would create a second household
    // row for the identical pair here.
    const again = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER_ID}/household-link`, { partner_account_id: MEMBER2_ID });
    assert.equal(again.status, 200);
    assert.equal(again.data.household.id, householdId, "linking the same pair twice must return the SAME household, not a new one");
    const count = d1(`SELECT COUNT(*) AS n FROM households WHERE payer_account_id = '${MEMBER_ID}' AND partner_account_id = '${MEMBER2_ID}'`)[0].n;
    assert.equal(count, 1);

    const conflicting = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER_ID}/household-link`, { partner_account_id: GUEST_ID });
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.data.error, "already_linked");
  } finally {
    const unlinked = await ownerCall("DELETE", `/api/portal/owner/households/${householdId}`);
    assert.equal(unlinked.status, 200);
    // Idempotent: unlinking an already-gone household is still 200, same end state.
    const again = await ownerCall("DELETE", `/api/portal/owner/households/${householdId}`);
    assert.equal(again.status, 200);
  }
});

test("D-A03/CTL-AUTHZ-02: a dependant is visible to the owner, rejected outside the 16-year window, and never reachable by staff", async () => {
  const tooOld = new Date().getUTCFullYear() - 17;
  const badAge = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER_ID}/dependants`, { first_name: "Too Old", birth_year: tooOld });
  assert.equal(badAge.status, 400);
  assert.equal(badAge.data.error, "bad_birth_year");

  const res = await ownerCall("POST", `/api/portal/owner/accounts/${MEMBER_ID}/dependants`, { first_name: "Testkid", birth_year: new Date().getUTCFullYear() - 5 });
  assert.equal(res.status, 201);
  const dependantId = res.data.dependant.id;
  try {
    const detail = await ownerCall("GET", `/api/portal/owner/accounts/${MEMBER_ID}`);
    assert.ok(detail.data.dependants.some((d) => d.id === dependantId && d.first_name === "Testkid"), "the owner must see the dependant");

    // CTL-AUTHZ-02: staff has no route in this part's surface that can
    // ever return a dependant -- the owner-only account-detail route
    // already refuses staff outright (proven in owner-authz.test.mjs's
    // role sweep); this asserts the one staff-reachable data surface
    // (its own calendar) cannot leak the name through some other field.
    const staff = await loginDemo("staff.demo@jp-demo.test");
    const staffCalRes = await fetch(`${BASE_URL}/api/portal/staff/calendar`, {
      headers: { "X-CSRF-Token": staff.csrfToken, Origin: BASE_URL, Cookie: staff.client.getCookie() },
    });
    const staffCal = await staffCalRes.json();
    assert.ok(!JSON.stringify(staffCal).includes("Testkid"));
  } finally {
    d1(`DELETE FROM dependants WHERE id = '${dependantId}'`);
  }
});

test("CTL-ROLE-02: PATCH role never accepts 'owner', even from the owner, and is otherwise idempotent", async () => {
  const before = d1(`SELECT role FROM accounts WHERE id = '${MEMBER_ID}'`)[0].role;

  // RED: a generic field-setter with no role check would accept this.
  const attempt = await ownerCall("PATCH", `/api/portal/owner/accounts/${MEMBER_ID}/role`, { role: "owner" });
  assert.equal(attempt.status, 403);
  const after = d1(`SELECT role FROM accounts WHERE id = '${MEMBER_ID}'`)[0].role;
  assert.equal(after, before, "role must be unchanged after a refused owner attempt");

  const setStaff = await ownerCall("PATCH", `/api/portal/owner/accounts/${MEMBER2_ID}/role`, { role: "staff" });
  assert.equal(setStaff.status, 200);
  assert.equal(setStaff.data.account.role, "staff");
  try {
    // Repeatable: setting the SAME role twice leaves the same state.
    const again = await ownerCall("PATCH", `/api/portal/owner/accounts/${MEMBER2_ID}/role`, { role: "staff" });
    assert.equal(again.status, 200);
    assert.equal(again.data.account.role, "staff");
  } finally {
    await ownerCall("PATCH", `/api/portal/owner/accounts/${MEMBER2_ID}/role`, { role: "member" });
  }
});

test("account delete (no history): personal-data rows are removed and the account row is anonymised, not resurrected on a second call", async () => {
  const id = "throwaway-delete-account-1";
  d1(`INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES ('${id}','throwaway.delete@jp-demo.test','guest','Throwaway',1,datetime('now'),datetime('now'))`);

  const first = await ownerCall("DELETE", `/api/portal/owner/accounts/${id}`);
  assert.equal(first.status, 200);
  const row = d1(`SELECT email, display_name, deleted_at FROM accounts WHERE id = '${id}'`)[0];
  assert.ok(row, "the account row itself is kept (never hard-deleted)");
  assert.notEqual(row.email, "throwaway.delete@jp-demo.test", "the real email must be gone");
  assert.equal(row.display_name, "");
  assert.ok(row.deleted_at, "deleted_at must be set");

  const second = await ownerCall("DELETE", `/api/portal/owner/accounts/${id}`);
  assert.equal(second.status, 404, "an already-anonymised account reports not_found, same end state");
});

// M21: the real case -- an account with booking/payment/audit history.
// RED (see this part's dispatch return for the transcript): the
// previous shape ran a plain `DELETE FROM accounts`, which either
// throws SQLITE_CONSTRAINT_FOREIGNKEY (this harness enforces foreign
// keys -- confirmed directly against this same local D1 file while
// building this fix) or, without enforcement, orphans every row below.
// GREEN: the account row is anonymised in place, so every FK into it
// stays valid and the booking/payment/audit rows are untouched.
test("M21: an account WITH booking/payment/audit history deletes cleanly -- anonymised, not cascaded, FK integrity intact", async () => {
  const id = "m21-real-account-" + Date.now();
  const bookingId = "m21-real-booking-" + Date.now();
  d1(`INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES ('${id}','m21.real@jp-demo.test','guest','Real Person',1,datetime('now'),datetime('now'))`);
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, payment_intent_id, created_by, created_at, updated_at)
     VALUES ('${bookingId}', '${id}', 'demo-court-0000-0000-000000000001', NULL, datetime('now','+10 days'), datetime('now','+10 days','+90 minutes'), 1, 0, 'cancelled', 'pay', 'pi_m21_real', '${id}', datetime('now'), datetime('now'))`
  );
  d1(`INSERT INTO payments_mirror (id, account_id, booking_id, stripe_payment_intent_id, amount_cents, status, kind, created_at, updated_at) VALUES ('m21-mirror-${id}', '${id}', '${bookingId}', 'pi_m21_real', 1500, 'paid', 'booking', datetime('now'), datetime('now'))`);

  try {
    const res = await ownerCall("DELETE", `/api/portal/owner/accounts/${id}`);
    assert.equal(res.status, 200, `expected the delete to succeed with history present, got ${res.status} ${JSON.stringify(res.data)}`);

    const account = d1(`SELECT email, deleted_at FROM accounts WHERE id = '${id}'`)[0];
    assert.ok(account, "the account row survives (money rows still reference it)");
    assert.notEqual(account.email, "m21.real@jp-demo.test");
    assert.ok(account.deleted_at);

    const bookingStillThere = d1(`SELECT account_id FROM bookings WHERE id = '${bookingId}'`)[0];
    assert.equal(bookingStillThere.account_id, id, "the booking row is untouched, still pointing at the (now-anonymised) account");
    const mirrorStillThere = d1(`SELECT account_id FROM payments_mirror WHERE id = 'm21-mirror-${id}'`)[0];
    assert.equal(mirrorStillThere.account_id, id);

    const audit = d1(`SELECT before FROM audit_log WHERE action = 'account_deleted' AND target_id = '${id}'`)[0];
    assert.ok(audit, "the delete itself is audited");
    assert.ok(!audit.before.includes("m21.real@jp-demo.test"), "the audit row must never re-store the deleted email");
  } finally {
    d1(`DELETE FROM payments_mirror WHERE id = 'm21-mirror-${id}'`);
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
    d1(`DELETE FROM audit_log WHERE target_id = '${id}' AND action = 'account_deleted'`);
    d1(`DELETE FROM accounts WHERE id = '${id}'`);
  }
});

test("overlaps lists an account with two entitlement sources (P-4); outbox returns the shared summary", async () => {
  const grantId = "overlap-extra-grant-1";
  d1(
    `INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, note, created_at, updated_at)
     VALUES ('${grantId}', '${MEMBER_ID}', 'email_link', 'jp_1m_single', datetime('now','-1 day'), datetime('now','+1 month'), 'active', NULL, 'test overlap', datetime('now'), datetime('now'))`
  );
  try {
    const overlaps = await ownerCall("GET", "/api/portal/owner/overlaps");
    assert.equal(overlaps.status, 200);
    assert.ok(overlaps.data.some((a) => a.id === MEMBER_ID), `expected ${MEMBER_ID} in overlaps: ${JSON.stringify(overlaps.data)}`);

    const outbox = await ownerCall("GET", "/api/portal/owner/outbox");
    assert.equal(outbox.status, 200);
    assert.ok("pending" in outbox.data && "failed" in outbox.data);
  } finally {
    d1(`DELETE FROM entitlement_grants WHERE id = '${grantId}'`);
  }
});
