// scripts/seed-preview.sql is demo data, but its RULES must be Roger's
// real ones (PIN L3), so the local suite exercises the rules production
// runs. This compares the rule columns of the two seeds, resource by
// resource and offering by offering, on real SQLite databases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./d1-sqlite.mjs";

const RULE_COLUMNS = "name, kind, open_time, close_time, slot_minutes, buffer_minutes, member_window_days, non_member_window_days, cancel_cutoff_minutes, min_advance_minutes, max_active_per_account, member_included, price_mode";

function load(seedFile) {
  const db = openTestDb();
  db.execFile(seedFile);
  const resources = db.sqlite.prepare(`SELECT ${RULE_COLUMNS} FROM resources ORDER BY name`).all().map((r) => ({ ...r }));
  const offerings = db.sqlite
    .prepare(`SELECT r.name AS resource, o.name, o.duration_minutes, o.audience, o.lookup_key, o.display_price_cents, o.active FROM offerings o JOIN resources r ON r.id = o.resource_id ORDER BY r.name, o.name`)
    .all()
    .map((r) => ({ ...r }));
  return { db, resources, offerings };
}

test("the preview seed carries the same rules and prices as the production seed", () => {
  const prod = load("scripts/seed-prod.sql");
  const preview = load("scripts/seed-preview.sql");
  assert.deepEqual(preview.resources, prod.resources);
  assert.deepEqual(preview.offerings, prod.offerings);
});

test("the preview seed is still demo data: every resource is_demo, marker 'preview'", () => {
  const { db } = load("scripts/seed-preview.sql");
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM resources WHERE is_demo = 0`).get().n, 0);
  assert.equal(db.sqlite.prepare(`SELECT env FROM portal_meta`).get().env, "preview");
  assert.ok(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE is_demo = 1`).get().n >= 5);
});
