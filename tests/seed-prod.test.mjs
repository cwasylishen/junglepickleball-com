// scripts/seed-prod.sql against a real SQLite database built from the
// project's own migrations (tests/d1-sqlite.mjs). PIN L7: "zero demo
// accounts, bookings or credits. Seed holds only the L3 resources and
// rules, the Amendment-4 prices, and the production marker row."

import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./d1-sqlite.mjs";
import { authStart } from "../src/portal/auth.js";

const SEED = "scripts/seed-prod.sql";
const plain = (rows) => rows.map((r) => ({ ...r }));

function seededDb() {
  const db = openTestDb();
  db.execFile(SEED);
  return db;
}

function count(db, table) {
  return db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test("L7: the seed writes only the marker, the L3 resources and their offerings -- every other table stays empty", () => {
  const db = seededDb();
  const tables = db.sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migrations%'`)
    .all()
    .map((t) => t.name);
  const counts = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
  assert.deepEqual(Object.fromEntries(nonEmpty), { portal_meta: 1, resources: 6, offerings: 9 });
});

test("L7: no is_demo row exists, no account, booking or credit", () => {
  const db = seededDb();
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM resources WHERE is_demo <> 0`).get().n, 0);
  for (const table of ["accounts", "bookings", "credits", "credits_ledger", "entitlement_grants"]) {
    assert.equal(count(db, table), 0, `${table} must be empty`);
  }
});

test("L7: the marker row says production", () => {
  const db = seededDb();
  assert.equal(db.sqlite.prepare(`SELECT env FROM portal_meta WHERE id = 1`).get().env, "production");
});

test("L7: the dev-login gate refuses on the production marker, and the same test goes red when the marker says preview", async () => {
  const db = seededDb();
  db.sqlite
    .prepare(`INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES ('d1','owner.demo@jp-demo.test','owner','Demo',1,'x','x')`)
    .run();
  const env = { PORTAL_DEV_LOGIN: "1" };
  const url = new URL("http://127.0.0.1/");
  const start = () =>
    authStart(
      new Request(url, { method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner.demo@jp-demo.test" }) }),
      env,
      db,
      url
    );

  const onProduction = await (await start()).json();
  assert.equal(onProduction.dev_link, undefined, "production marker: no dev link");

  // Negative control: the same request with a preview marker DOES get a link,
  // so the assertion above is capable of failing.
  db.sqlite.prepare(`UPDATE portal_meta SET env = 'preview' WHERE id = 1`).run();
  db.sqlite.prepare(`DELETE FROM rate_limits`).run();
  const onPreview = await (await start()).json();
  assert.ok(onPreview.dev_link, "preview marker: dev link is issued, so the gate really keys on the marker");
});

test("L7: running the seed a second time changes nothing", () => {
  const db = seededDb();
  const dump = () => ({
    portal_meta: plain(db.sqlite.prepare(`SELECT id, env FROM portal_meta`).all()),
    resources: plain(db.sqlite.prepare(`SELECT id, kind, name, open_time, close_time, slot_minutes, member_window_days, non_member_window_days, cancel_cutoff_minutes, min_advance_minutes, max_active_per_account, is_demo FROM resources ORDER BY id`).all()),
    offerings: plain(db.sqlite.prepare(`SELECT id, resource_id, lookup_key, display_price_cents, active FROM offerings ORDER BY id`).all()),
    totals: [count(db, "portal_meta"), count(db, "resources"), count(db, "offerings")],
  });
  const first = dump();
  db.execFile(SEED);
  assert.deepEqual(dump(), first);
});

test("a re-run never overwrites an edit the owner made after the first load", () => {
  const db = seededDb();
  db.sqlite.prepare(`UPDATE resources SET close_time = '20:00' WHERE id = 'court-1'`).run();
  db.sqlite.prepare(`UPDATE offerings SET active = 1 WHERE id = 'massage-60'`).run();
  db.execFile(SEED);
  assert.equal(db.sqlite.prepare(`SELECT close_time FROM resources WHERE id = 'court-1'`).get().close_time, "20:00");
  assert.equal(db.sqlite.prepare(`SELECT active FROM offerings WHERE id = 'massage-60'`).get().active, 1);
});

test("the seed refuses a database whose marker is 'preview' and writes no resource", () => {
  const db = openTestDb();
  db.sqlite.prepare(`INSERT INTO portal_meta (id, env, created_at) VALUES (1, 'preview', 'x')`).run();
  assert.throws(() => db.execFile(SEED), /NOT NULL/);
  assert.equal(count(db, "resources"), 0);
  assert.equal(db.sqlite.prepare(`SELECT env FROM portal_meta WHERE id = 1`).get().env, "preview", "the marker is left as it was");
});

test("PIN L3 rules as seeded: courts 07:00-19:00, 90 min, window 60 for everyone, no cap, cancel 24 h", () => {
  const db = seededDb();
  const courts = db.sqlite.prepare(`SELECT * FROM resources WHERE kind = 'court' ORDER BY id`).all();
  assert.deepEqual(courts.map((c) => c.id), ["court-1", "court-2", "court-3", "court-4"]);
  for (const c of courts) {
    assert.equal(c.open_time, "07:00");
    assert.equal(c.close_time, "19:00");
    assert.equal(c.slot_minutes, 90);
    assert.equal(c.buffer_minutes, 0);
    assert.equal(c.member_window_days, 60);
    assert.equal(c.non_member_window_days, 60);
    assert.equal(c.max_active_per_account, null, "members have no cap on upcoming court bookings");
    assert.equal(c.cancel_cutoff_minutes, 1440);
    assert.equal(c.min_advance_minutes, 0);
  }
});

test("PIN L3 rules as seeded: Cold Plunge is 20 min and needs 24 h notice; massage is present but inactive", () => {
  const db = seededDb();
  const plunge = db.sqlite.prepare(`SELECT * FROM resources WHERE id = 'cold-plunge'`).get();
  assert.equal(plunge.slot_minutes, 20);
  assert.equal(plunge.min_advance_minutes, 1440);
  const massage = db.sqlite.prepare(`SELECT * FROM resources WHERE id = 'massage-samy'`).get();
  assert.equal(massage.staff_account_id, null, "Samy's account is never seeded");
  const massageOfferings = db.sqlite.prepare(`SELECT id, active FROM offerings WHERE resource_id = 'massage-samy' ORDER BY id`).all();
  assert.equal(massageOfferings.length, 2);
  assert.ok(massageOfferings.every((o) => o.active === 0));
  const plungeOfferings = db.sqlite.prepare(`SELECT active FROM offerings WHERE resource_id = 'cold-plunge'`).all();
  assert.ok(plungeOfferings.length > 0 && plungeOfferings.every((o) => o.active === 1));
});

test("Amendment 4 prices, by Stripe lookup_key", () => {
  const db = seededDb();
  const prices = Object.fromEntries(
    db.sqlite.prepare(`SELECT lookup_key, display_price_cents FROM offerings WHERE lookup_key IS NOT NULL GROUP BY lookup_key`).all().map((o) => [o.lookup_key, o.display_price_cents])
  );
  assert.deepEqual(prices, { jp_session_single: 1500, massage_60: 5500, massage_90: 8000, plunge_member: 1000, plunge_guest: 1500 });
  const annual = db.sqlite.prepare(`SELECT display_price_cents, lookup_key FROM offerings WHERE audience = 'member_annual'`).get();
  assert.equal(annual.display_price_cents, 0);
  assert.equal(annual.lookup_key, null);
});
