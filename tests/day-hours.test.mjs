// The owner's per-day closing-time extension (PIN L3, ruling PF-3):
// src/portal/day-hours.js on a real SQLite database seeded from
// scripts/seed-prod.sql, with the clock fixed to Monday 2026-10-05 09:00
// Costa Rica time.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { prodDb, addAccount, NOW_UTC_MS, crDateTimeToUtcIso } from "./launch-helpers.mjs";
import { setDayExtension, clearDayExtension, listDayExtensions, resourceForDate, DAY_EXTENSION_MAX_CLOSE } from "../src/portal/day-hours.js";

let db;
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
  addAccount(db, { id: "owner-1", email: "roger@example.com", role: "owner" });
});
afterEach(() => mock.timers.reset());

const rows = (sql, ...args) => db.sqlite.prepare(sql).all(...args).map((r) => ({ ...r }));
const court = () => db.sqlite.prepare(`SELECT * FROM resources WHERE id = 'court-1'`).get();
const plunge = () => db.sqlite.prepare(`SELECT * FROM resources WHERE id = 'cold-plunge'`).get();

test("migration 0009: the new column defaults to no minimum, and the table refuses a close later than 21:00", () => {
  assert.equal(court().min_advance_minutes, 0);
  const insert = (close) =>
    db.sqlite.prepare(`INSERT INTO day_close_overrides (date, close_time, set_by, created_at, updated_at) VALUES ('2026-10-09', ?, 'owner-1', 'x', 'x')`).run(close);
  assert.throws(() => insert("21:01"), /CHECK constraint/);
  assert.throws(() => insert("22:00"), /CHECK constraint/);
  insert("21:00"); // the ceiling itself is allowed
});

test("owner extends a day to 21:00: the row exists and one audit entry names who and what", async () => {
  const result = await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  assert.deepEqual(rows(`SELECT date, close_time, set_by FROM day_close_overrides`), [{ date: "2026-10-09", close_time: "21:00", set_by: "owner-1" }]);
  const audit = rows(`SELECT actor_account_id, action, target_id FROM audit_log`);
  assert.deepEqual(audit, [{ actor_account_id: "owner-1", action: "day_extension_set", target_id: "2026-10-09" }]);
});

test("run it twice: the same extension again leaves the same state and no second audit entry", async () => {
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  const again = await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  assert.equal(again.changed, false);
  assert.equal(rows(`SELECT * FROM day_close_overrides`).length, 1);
  assert.equal(rows(`SELECT * FROM audit_log`).length, 1);
});

test("changing an extension replaces the close time (one row per day) and audits the change", async () => {
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  await setDayExtension(db, "owner-1", "2026-10-09", "20:30");
  assert.deepEqual(rows(`SELECT close_time FROM day_close_overrides`), [{ close_time: "20:30" }]);
  assert.equal(rows(`SELECT * FROM audit_log`).length, 2);
});

test("a bad request is named and writes nothing", async () => {
  const cases = [
    [["not-a-date", "21:00"], "bad_date"],
    [["2026-10-04", "21:00"], "date_in_past"], // yesterday
    [["2026-10-09", "9pm"], "bad_close_time"],
    [["2026-10-09", "25:00"], "bad_close_time"],
    [["2026-10-09", "21:30"], "close_too_late"], // PIN L3: 21:00 is the ceiling
    [["2026-10-09", "19:00"], "not_an_extension"], // not later than the normal close
    [["2026-10-09", "18:00"], "not_an_extension"],
  ];
  for (const [[date, close], error] of cases) {
    const result = await setDayExtension(db, "owner-1", date, close);
    assert.equal(result.error, error, `${date} ${close}`);
  }
  assert.equal(rows(`SELECT * FROM day_close_overrides`).length, 0);
  assert.equal(rows(`SELECT * FROM audit_log`).length, 0);
  assert.equal(DAY_EXTENSION_MAX_CLOSE, "21:00");
});

test("today itself can be extended (a Costa Rica date, not a UTC one)", async () => {
  const result = await setDayExtension(db, "owner-1", "2026-10-05", "21:00");
  assert.equal(result.error, undefined);
});

test("the engine's question: courts close at 21:00 on the extended day only; plunge is untouched", async () => {
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  assert.equal((await resourceForDate(db, court(), "2026-10-09")).close_time, "21:00");
  assert.equal((await resourceForDate(db, court(), "2026-10-10")).close_time, "19:00");
  assert.equal((await resourceForDate(db, plunge(), "2026-10-09")).close_time, "19:00");
});

test("clearing returns the day to normal hours; clearing again is the same end state", async () => {
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  const cleared = await clearDayExtension(db, "owner-1", "2026-10-09");
  assert.equal(cleared.changed, true);
  assert.equal((await resourceForDate(db, court(), "2026-10-09")).close_time, "19:00");
  const again = await clearDayExtension(db, "owner-1", "2026-10-09");
  assert.deepEqual({ ok: again.ok, changed: again.changed }, { ok: true, changed: false });
  assert.deepEqual(rows(`SELECT action FROM audit_log ORDER BY at, rowid`).map((r) => r.action), ["day_extension_set", "day_extension_cleared"]);
});

test("clearing never touches a booking already made in the extended hours; it reports how many now run late", async () => {
  addAccount(db, { id: "m1", email: "m1@example.com" });
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  db.sqlite
    .prepare(`INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, created_by, created_at, updated_at) VALUES ('b1','m1','court-1',?,?,2,'confirmed','included','m1','x','x')`)
    .run(crDateTimeToUtcIso("2026-10-09", "19:00"), crDateTimeToUtcIso("2026-10-09", "20:30"));
  const cleared = await clearDayExtension(db, "owner-1", "2026-10-09");
  assert.equal(cleared.late_bookings, 1);
  assert.equal(db.sqlite.prepare(`SELECT status FROM bookings WHERE id = 'b1'`).get().status, "confirmed");
});

test("the owner list shows today and later, soonest first, and drops past days", async () => {
  await setDayExtension(db, "owner-1", "2026-10-12", "21:00");
  await setDayExtension(db, "owner-1", "2026-10-09", "20:30");
  db.sqlite.prepare(`INSERT INTO day_close_overrides (date, close_time, set_by, created_at, updated_at) VALUES ('2026-09-01','21:00','owner-1','x','x')`).run();
  const list = await listDayExtensions(db);
  assert.deepEqual(list.map((r) => [r.date, r.close_time]), [["2026-10-09", "20:30"], ["2026-10-12", "21:00"]]);
});
