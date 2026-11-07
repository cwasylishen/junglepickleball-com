// B2a2's role-boundary probes. Swept from the LIVE route table (never a
// hand-maintained list), per this part's acceptance test: member, guest
// and staff each get 403 on every /api/portal/owner/* route; staff gets
// 403 asking for another resource's calendar (CTL-STF-01); a staff
// response body carries no email/phone/notes key; PATCH /me only ever
// changes display_name (CTL-AUTHZ-03).
//
// One login per persona for the whole file (CTL-AUTH-07's 5-per-15-
// minute login-start limit is shared across the whole suite run; a
// session lasts 7 days, so one login per persona serves every test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTable } from "../../src/portal/router.js";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";

const MASSAGE_RESOURCE = "demo-msg-00000-0000-000000000005";
const MEMBER_ID = "demo-memb1-0000-0000-000000000003";

const member = await loginDemo("member.demo@jp-demo.test");
const guest = await loginDemo("guest.demo@jp-demo.test");
const staff = await loginDemo("staff.demo@jp-demo.test");

// helpers.mjs's makeClient() exposes only get()/post() -- several of
// this sweep's routes are registered PATCH/DELETE, and sending the
// wrong verb would 404 on the route table lookup itself rather than
// exercise authorize(), so this calls fetch directly with the real
// method instead of bending every route onto POST.
async function callAs(persona, method, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": persona.csrfToken, Origin: BASE_URL, Cookie: persona.client.getCookie() },
    body: method === "GET" ? undefined : "{}",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

test("CTL-AUTHZ-01/role sweep: member, guest and staff all get 403 on every live /api/portal/owner/* route", async () => {
  const table = routeTable().filter((r) => r.path.startsWith("/api/portal/owner/"));
  assert.ok(table.length >= 10, "expected the full B2a2 owner route set to be registered");

  for (const [name, persona] of [["member", member], ["guest", guest], ["staff", staff]]) {
    for (const route of table) {
      const path = route.path.replace(/:id/g, "x").replace(/:offeringId/g, "y");
      const res = await callAs(persona, route.method, path);
      // RED: a router that defaulted an unrecognised/mistyped class to
      // "own" (permissive) would let a member or guest through here.
      assert.equal(res.status, 403, `${name} on ${route.method} ${route.path} must be 403, got ${res.status}`);
      assert.equal(res.data.error, "owner_only", `${route.method} ${route.path} must report owner_only for ${name}`);
    }
  }
});

test("CTL-STF-01: staff asking for another resource's calendar gets 403, not a silently-ignored param", async () => {
  const ok = await staff.client.get("/api/portal/staff/calendar", { "X-CSRF-Token": staff.csrfToken, Origin: BASE_URL });
  assert.equal(ok.status, 200, "staff's own calendar with no resource param must succeed");

  // RED: a handler that accepts and silently ignores a resource_id query
  // param (rather than refusing outright) would also return 200 here.
  const asked = await staff.client.get(`/api/portal/staff/calendar?resource_id=${MASSAGE_RESOURCE}`, { "X-CSRF-Token": staff.csrfToken, Origin: BASE_URL });
  assert.equal(asked.status, 403, "a resource_id param must be refused outright");
  assert.equal(asked.data.error, "resource_forbidden");
});

test("D-A16/CTL-AUTHZ-02: a staff calendar response body carries no email, phone, notes, or a client's email address", async () => {
  const bookingId = "authz-staff-fields-booking-1";
  // Explicit ISO-8601 UTC literals (PIN-6) -- SQLite's datetime('now', ...)
  // helper returns "YYYY-MM-DD HH:MM:SS" (a space, no "Z"), which does not
  // sort correctly against the "T...Z" strings this file's own queries
  // compare against.
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('${bookingId}', '${MEMBER_ID}', '${MASSAGE_RESOURCE}', '2026-12-01T15:00:00.000Z', '2026-12-01T16:00:00.000Z', 1, 'confirmed', 'pay', '${MEMBER_ID}', datetime('now'), datetime('now'))`
  );
  try {
    const res = await staff.client.get("/api/portal/staff/calendar?date=2026-12-01", { "X-CSRF-Token": staff.csrfToken, Origin: BASE_URL });
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.data);
    for (const forbidden of ["email", "phone", "notes", "payment_intent", "member.demo@jp-demo.test"]) {
      assert.ok(!text.includes(forbidden), `staff calendar body must not contain "${forbidden}": ${text}`);
    }
    const event = res.data.find((e) => e.resource === "Massage Therapy by Samy");
    assert.ok(event, `the seeded massage booking must appear on staff's own calendar: ${text}`);
    // This booking is payment_mode 'pay' with no payment on it: a pay-at-the-club booking
    // (L4). C4-05 (ruling A6) adds the yes/no marker `pay_at_club` for it, and nothing else:
    // no amount, no price.
    assert.deepEqual(Object.keys(event).sort(), ["display_name", "end", "pay_at_club", "resource", "start", "state"].sort());
    assert.equal(event.pay_at_club, true);
  } finally {
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
  }
});

test("CTL-AUTHZ-03: PATCH /api/portal/me accepts only display_name -- every other field is ignored, not rejected", async () => {
  const before = await member.client.get("/api/portal/me");
  const originalRole = before.data.account.role;
  const originalEmail = before.data.account.email;

  // RED: an Object.assign-style handler would flip role to owner here.
  // helpers.mjs's client has no patch() verb -- call PATCH directly.
  const originalName = before.data.account.display_name;
  try {
    const direct = await fetch(`${BASE_URL}/api/portal/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": member.csrfToken, Origin: BASE_URL, Cookie: member.client.getCookie() },
      body: JSON.stringify({ display_name: "Patched Name", role: "owner", is_demo: 1, email: "hijacked@example.com", credits: 999, stripe_customer_id: "cus_hijack" }),
    });
    assert.equal(direct.status, 200);
    const body = await direct.json();
    assert.equal(body.account.display_name, "Patched Name");
    assert.equal(body.account.role, originalRole, "role must never change via PATCH /me");
    assert.equal(body.account.email, originalEmail, "email must never change via PATCH /me");
  } finally {
    // Put the seeded name back: the staff calendar test in portal-ui-b2 reads it.
    d1(`UPDATE accounts SET display_name = '${String(originalName).replace(/'/g, "''")}' WHERE id = '${before.data.account.id}'`);
  }
});
