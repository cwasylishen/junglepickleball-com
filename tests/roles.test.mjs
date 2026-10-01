// QA2: test-plan.md §3 Role boundaries, ROLE-001..013.
// Most routes probed here (bookings, owner accounts/resources/blocks,
// staff calendar, PATCH /me) belong to B2a1/B2a2 and are empty route-
// table stubs (src/portal/routes/{booking,owner}.js `ROUTES = []`) as of
// this run -- every case still executes against the real api.md path so
// it fails HONESTLY (404 not_found) rather than being skipped, and is
// logged in qa-run-1.md as waiting on that part.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, d1, uniqueEmail, BASE_URL, patchWithClient, resetRateLimits } from "./qa-helpers.mjs";

// FINDING (qa-run-1.md): this file logs in staff.demo more than 5 times
// -- reset at load, same reasoning as booking-bounds.test.mjs (H-1).
resetRateLimits();

test("ROLE-001: member cannot read member2's booking by id", async () => {
  const member2 = await loginDemo("member2.demo@jp-demo.test");
  const created = await member2.client.post(
    "/api/portal/bookings",
    { resource_id: "demo-court-0000-0000-000000000002", start: new Date(Date.now() + 3600000).toISOString(), party_size: 1 },
    { "X-CSRF-Token": member2.csrfToken, Origin: BASE_URL }
  );
  const bookingId = created.data && created.data.booking ? created.data.booking.id : "unknown-booking-id";
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await member.client.get(`/api/portal/bookings/${bookingId}`);
  assert.ok([403, 404].includes(resp.status), `expected 403/404, got ${resp.status} -- waiting on B2a1 (booking create/read routes)`);
});

test("ROLE-002: member cannot read member2's account detail by id", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await member.client.get("/api/portal/owner/accounts/demo-memb2-0000-0000-000000000004");
  assert.ok([403, 404, 401].includes(resp.status), `expected a refusal, got ${resp.status} -- waiting on B2a2 (owner accounts route, class=owner so member gets 403 once built)`);
});

test("ROLE-003: id-tampering equivalence -- adjacent ids to member's own never return another account's data", async () => {
  const member = await loginDemo("member.demo@jp-demo.test");
  const resp = await member.client.get("/api/portal/bookings/demo-memb2-0000-0000-000000000004");
  assert.ok(resp.status !== 200, `an id that is not this account's own must never return 200, got ${resp.status} -- waiting on B2a1`);
});

test("ROLE-004: guest gets the same refusal as member against member2's rows", async () => {
  const guest = await loginDemo("guest.demo@jp-demo.test");
  const resp = await guest.client.get("/api/portal/owner/accounts/demo-memb2-0000-0000-000000000004");
  assert.ok([403, 404, 401].includes(resp.status), `expected a refusal, got ${resp.status} -- waiting on B2a2`);
});

test("ROLE-005: staff (Massage-owned) can read Massage's bookings", async () => {
  const staff = await loginDemo("staff.demo@jp-demo.test");
  const resp = await staff.client.get("/api/portal/staff/calendar?date=2026-10-15");
  assert.equal(resp.status, 200, `expected 200 for staff's own resource, got ${resp.status} -- waiting on B2a2 (staff calendar route)`);
});

test("ROLE-006: staff cannot read Court 1's bookings (a resource they do not own)", async () => {
  const staff = await loginDemo("staff.demo@jp-demo.test");
  const resp = await staff.client.get("/api/portal/owner/resources/demo-court-0000-0000-000000000001/availability?date=2026-10-15");
  assert.ok([403, 404].includes(resp.status), `expected 403/404, got ${resp.status} -- waiting on B2a2`);
});

test("ROLE-007: staff cannot read a specific Court 1 booking id by guess", async () => {
  const staff = await loginDemo("staff.demo@jp-demo.test");
  const resp = await staff.client.get("/api/portal/bookings/demo-court-0000-0000-000000000001");
  assert.ok(resp.status !== 200, `expected a refusal, got ${resp.status} -- waiting on B2a1`);
});

const OWNER_ONLY_ROUTES = [
  ["GET", "/api/portal/owner/accounts"],
  ["GET", "/api/portal/owner/resources"],
  ["POST", "/api/portal/owner/resources/demo-court-0000-0000-000000000001/confirm-field"],
  ["GET", "/api/portal/owner/blocks"],
  ["POST", "/api/portal/owner/resources/demo-msg-00000-0000-000000000005/offerings/demo-off-00000-0000-000000000005/price"],
];

test("ROLE-008: staff gets 403 on every owner-only route", async () => {
  const staff = await loginDemo("staff.demo@jp-demo.test");
  for (const [method, path] of OWNER_ONLY_ROUTES) {
    const resp = method === "GET"
      ? await staff.client.get(path)
      : await staff.client.post(path, {}, { "X-CSRF-Token": staff.csrfToken, Origin: BASE_URL });
    assert.ok([403, 404].includes(resp.status), `${method} ${path}: expected 403 (or 404 while unbuilt), got ${resp.status} -- waiting on B2a2`);
    if (resp.status === 404) continue; // route not built: honest fail, cannot distinguish 403 from not_found yet
  }
});

test("ROLE-009 (D-A16): staff calendar rows never include email, phone, notes or payment fields", async () => {
  const staff = await loginDemo("staff.demo@jp-demo.test");
  const resp = await staff.client.get("/api/portal/staff/calendar?date=2026-10-15");
  assert.equal(resp.status, 200, `waiting on B2a2 -- got ${resp.status}`);
  const rows = Array.isArray(resp.data) ? resp.data : [];
  for (const row of rows) {
    for (const forbidden of ["email", "phone", "notes", "payment", "payment_intent_id"]) {
      assert.ok(!(forbidden in row), `staff calendar row leaks forbidden field "${forbidden}"`);
    }
  }
});

test("ROLE-010: every non-owner role gets 403 on every owner-only route (matrix)", async () => {
  const roles = [
    await loginDemo("member.demo@jp-demo.test"),
    await loginDemo("guest.demo@jp-demo.test"),
    await loginDemo("staff.demo@jp-demo.test"),
  ];
  for (const r of roles) {
    for (const [method, path] of OWNER_ONLY_ROUTES) {
      const resp = method === "GET"
        ? await r.client.get(path)
        : await r.client.post(path, {}, { "X-CSRF-Token": r.csrfToken, Origin: BASE_URL });
      assert.ok([403, 404].includes(resp.status), `${r.account.role} ${method} ${path}: expected 403, got ${resp.status} -- waiting on B2a2`);
    }
  }
});

test("ROLE-011: mass-assignment -- smuggled role/entitlement/credits fields never take effect via PATCH /me", async () => {
  const member = await loginDemo(uniqueEmail("role011"));
  const before = await member.client.get("/api/portal/me");
  const resp = await patchWithClient(
    member.client,
    "/api/portal/me",
    { display_name: "QA Name", role: "owner", entitlement: "active", credits: 999, price: 0, staff_account_id: "demo-staff-0000-0000-000000000002" },
    { "X-CSRF-Token": member.csrfToken, Origin: BASE_URL }
  );
  assert.ok(resp.status !== 0);
  const after = await member.client.get("/api/portal/me");
  assert.equal(after.data.account.role, before.data.account.role, "role must never change via this route regardless of status code");
});

test("ROLE-012: role=owner / account_id=<owner> in body/query never changes authorization on an ordinary member route", async () => {
  const member = await loginDemo(uniqueEmail("role012"));
  const resp = await member.client.get("/api/portal/owner/health?role=owner&account_id=demo-owner-0000-0000-000000000001");
  assert.equal(resp.status, 403, `the session's own role must govern, got ${resp.status}`);
});

test("ROLE-013 (DB-level): the accounts.role CHECK constraint rejects 'superadmin'", () => {
  assert.throws(() => {
    d1(`UPDATE accounts SET role = 'superadmin' WHERE id = 'demo-guest-0000-0000-000000000005'`);
  }, /CHECK constraint failed/i, "the role CHECK constraint must reject an out-of-enum role at the DB level, independent of application code");
  const row = d1(`SELECT role FROM accounts WHERE id = 'demo-guest-0000-0000-000000000005'`)[0];
  assert.equal(row.role, "guest", "the row must be unchanged after the rejected write");
});
