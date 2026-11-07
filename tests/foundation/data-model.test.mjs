// CTL-DATA-01, 02, 03, 04, 05. Each control's own probe in controls.md
// §3.3 is a direct D1 schema/trigger inspection (not an HTTP call), so
// this file shells out to `wrangler d1 execute --local`, exactly as
// those probes specify.

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "./helpers.mjs";

test("CTL-DATA-01: no table that crosses the API uses an integer autoincrement id", () => {
  const tables = ["accounts", "bookings", "entitlement_grants", "households", "dependants", "passkeys"];
  for (const t of tables) {
    const schema = d1(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${t}'`)[0].sql;
    // RED: an `id INTEGER PRIMARY KEY AUTOINCREMENT` column (the thing
    // this control removes, for enumeration/cross-DB collision reasons)
    // would match this.
    assert.ok(!/INTEGER PRIMARY KEY/i.test(schema), `${t} must not use an integer primary key:\n${schema}`);
  }
});

test("CTL-DATA-02: bookings.account_id is NOT NULL -- no ownerless booking can exist", () => {
  let failed = false;
  try {
    d1(
      `INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, status, payment_mode, created_by, created_at, updated_at)
       VALUES ('t1', NULL, 'demo-court-0000-0000-000000000001', '2026-10-01T10:00:00Z', '2026-10-01T11:30:00Z', 'confirmed', 'included', 'demo-owner-0000-0000-000000000001', datetime('now'), datetime('now'))`
    );
  } catch {
    failed = true;
  }
  // RED: a nullable account_id column (no NOT NULL) would let this insert
  // succeed, which is exactly the "ownerless walk-in" hazard the control
  // removes.
  assert.equal(failed, true, "an INSERT with a NULL account_id must fail the schema constraint");
});

test("CTL-DATA-03: accounts.email rejects empty/too-short values", () => {
  let failed = false;
  try {
    d1(
      `INSERT INTO accounts (id, email, role, display_name, created_at, updated_at)
       VALUES ('t2', '', 'guest', '', datetime('now'), datetime('now'))`
    );
  } catch {
    failed = true;
  }
  assert.equal(failed, true, "an empty email must fail the CHECK constraint");
});

test("CTL-DATA-04: bookings has no column naming a dependant or a child's identity", () => {
  const cols = d1(`PRAGMA table_info(bookings)`).map((c) => c.name);
  for (const forbidden of ["dependant_id", "child_name", "kid_name", "dependant_name"]) {
    assert.ok(!cols.includes(forbidden), `bookings must not have a ${forbidden} column`);
  }
  assert.ok(cols.includes("free_kids"), "the free-kid allowance must be a count, not an identity");
});

test("CTL-DATA-05: an ad hoc UPDATE/DELETE on a tracked table leaves a db_change_log row with no app audit row", () => {
  const before = d1(`SELECT COUNT(*) AS n FROM db_change_log`)[0].n;
  // Pick a row that exists from the seed and mutate it directly, the
  // way an operator's ad hoc `d1 execute` would (bypassing the app).
  d1(`UPDATE accounts SET display_name = display_name WHERE id = 'demo-guest-0000-0000-000000000005'`);
  const afterUpdate = d1(`SELECT COUNT(*) AS n FROM db_change_log WHERE table_name = 'accounts' AND op = 'UPDATE'`)[0].n;
  // RED: before migrations/0006 added the triggers, db_change_log simply
  // does not exist, so this ad hoc write would leave no trail at all.
  assert.ok(afterUpdate >= 1, "the UPDATE trigger must have fired");

  d1(`INSERT INTO accounts (id, email, role, display_name, created_at, updated_at) VALUES ('t3','t3@example.com','guest','',datetime('now'),datetime('now'))`);
  d1(`DELETE FROM accounts WHERE id = 't3'`);
  const afterDelete = d1(`SELECT COUNT(*) AS n FROM db_change_log WHERE table_name = 'accounts' AND row_id = 't3' AND op = 'DELETE'`)[0].n;
  assert.equal(afterDelete, 1);
});
