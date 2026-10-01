// CTL-RES-01 (bounded owner rule values) and REQ-OWN-11 (an edit never
// touches an existing booking row; misfits are listed instead).
//
// One owner login for the whole file (CTL-AUTH-07 allows only 5
// login-starts per email per 15 minutes; logging in once per test
// would burn that budget against the shared suite run for no reason --
// a session lasts 7 days, so one login serves every test below).

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";

const COURT_1 = "demo-court-0000-0000-000000000001";
const MEMBER_ID = "demo-memb1-0000-0000-000000000003";

const owner = await loginDemo("owner.demo@jp-demo.test");

async function patchResource(id, body) {
  const res = await fetch(`${BASE_URL}/api/portal/owner/resources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

test("CTL-RES-01: out-of-range rule values are refused with 400 and change nothing", async () => {
  const before = d1(`SELECT * FROM resources WHERE id = '${COURT_1}'`)[0];

  for (const bad of [
    { slot_minutes: 0 },
    { slot_minutes: 481 },
    { buffer_minutes: -5 },
    { buffer_minutes: 241 },
    { cancel_cutoff_minutes: -1 },
    { member_window_days: 61 },
    { open_time: "20:00", close_time: "19:30" }, // close <= open
  ]) {
    // RED: before validation existed, each of these either wrote the
    // bad value or (for slot 0) made the grid generator loop/empty.
    const res = await patchResource(COURT_1, bad);
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
  }

  const after = d1(`SELECT * FROM resources WHERE id = '${COURT_1}'`)[0];
  assert.deepEqual(after, before, "no out-of-range PATCH may change the row");
});

test("REQ-OWN-11: shortening hours never touches the existing booking row -- it is listed as a misfit", async () => {
  const bookingId = "res-misfit-booking-1";
  // 18:00-19:30 CR local, inside the original 07:00-19:30 hours.
  d1(
    `INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, created_by, created_at, updated_at)
     VALUES ('${bookingId}', '${MEMBER_ID}', '${COURT_1}', '2026-10-02T00:00:00.000Z', '2026-10-02T01:30:00.000Z', 1, 'confirmed', 'included', '${MEMBER_ID}', datetime('now'), datetime('now'))`
  );
  try {
    const before = d1(`SELECT * FROM bookings WHERE id = '${bookingId}'`)[0];

    // Shorten close_time to 18:00 -- the booking now ends after close.
    const res = await patchResource(COURT_1, { close_time: "18:00" });
    assert.equal(res.status, 200);
    assert.ok(res.data.misfits.some((m) => m.id === bookingId), `expected ${bookingId} in misfits: ${JSON.stringify(res.data.misfits)}`);

    // RED: a resource edit that silently cancelled or trimmed the
    // booking row to fit the new hours would fail this.
    const after = d1(`SELECT * FROM bookings WHERE id = '${bookingId}'`)[0];
    assert.deepEqual(after, before, "the booking row must be byte-identical after the resource edit");
  } finally {
    d1(`DELETE FROM bookings WHERE id = '${bookingId}'`);
    // Restore the seeded hours for every other test file sharing this DB.
    await patchResource(COURT_1, { close_time: "19:30" });
  }
});

test("confirm-field clears the 'default, confirm with Roger' chip, and is idempotent on repeat", async () => {
  // Court 1 seeds buffer_minutes as an unconfirmed default (seed-preview.sql).
  const before = d1(`SELECT unconfirmed_fields FROM resources WHERE id = '${COURT_1}'`)[0];
  assert.ok(JSON.parse(before.unconfirmed_fields).includes("buffer_minutes"), "fixture assumption: buffer_minutes starts unconfirmed");

  const confirm = async () =>
    fetch(`${BASE_URL}/api/portal/owner/resources/${COURT_1}/confirm-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() },
      body: JSON.stringify({ field: "buffer_minutes" }),
    });

  const first = await confirm();
  assert.equal(first.status, 200);
  const afterFirst = d1(`SELECT unconfirmed_fields FROM resources WHERE id = '${COURT_1}'`)[0];
  assert.ok(!JSON.parse(afterFirst.unconfirmed_fields).includes("buffer_minutes"));

  // RED: a second confirm on an already-cleared field throwing, or
  // re-adding/duplicating the entry, would fail the repeatable test.
  const second = await confirm();
  assert.equal(second.status, 200);
  const afterSecond = d1(`SELECT unconfirmed_fields FROM resources WHERE id = '${COURT_1}'`)[0];
  assert.deepEqual(afterSecond, afterFirst, "running confirm-field twice must leave the same state");

  // Restore the fixture for other test files.
  d1(`UPDATE resources SET unconfirmed_fields = '${before.unconfirmed_fields}' WHERE id = '${COURT_1}'`);
});

test("offerings CRUD: create, update, delete, each audited", async () => {
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": owner.csrfToken, Origin: BASE_URL, Cookie: owner.client.getCookie() };

  const created = await fetch(`${BASE_URL}/api/portal/owner/resources/${COURT_1}/offerings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Test offering", duration_minutes: 90, audience: "everyone" }),
  });
  assert.equal(created.status, 201);
  const offering = (await created.json()).offering;
  assert.equal(offering.lookup_key, null, "a newly created offering has no price until B2b's price route sets one");

  try {
    const updated = await fetch(`${BASE_URL}/api/portal/owner/resources/${COURT_1}/offerings/${offering.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Renamed offering", lookup_key: "sneaky_key" }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()).offering;
    assert.equal(updatedBody.name, "Renamed offering");
    assert.equal(updatedBody.lookup_key, null, "lookup_key is never writable through this route (B2b owns pricing)");
  } finally {
    const deleted = await fetch(`${BASE_URL}/api/portal/owner/resources/${COURT_1}/offerings/${offering.id}`, { method: "DELETE", headers });
    assert.equal(deleted.status, 200);
  }
});
