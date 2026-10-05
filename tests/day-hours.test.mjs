// The owner's per-day closing-time extension (PIN L3, ruling PF-3):
// src/portal/day-hours.js on a real SQLite database seeded from
// scripts/seed-prod.sql, with the clock fixed to Monday 2026-10-05 09:00
// Costa Rica time.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso } from "./launch-helpers.mjs";
import { countLiveBookingsEndingAfter } from "../src/portal/booking.js";
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

// C4-02: the late-hours count and the booking engine must agree on what a
// "live" booking is. Each case puts one booking in the 19:00 slot (ends
// 20:30) of its own extended day. The engine's answer is what the
// availability grid shows for that slot (anything but "available" means
// the engine treats it as occupying the court). The owner's answer is the
// late_bookings number clearing that day reports. The two must match, and
// both must match what the rule says.
test("the late-hours count and the booking engine agree on which bookings are live", async () => {
  makeMember(db, "viewer");
  const viewer = await sessionFor(db, "viewer");
  addAccount(db, { id: "m1", email: "m1@example.com" });
  const FUTURE_HOLD = "2026-10-05T16:00:00.000Z";
  const EXPIRED_HOLD = "2026-10-05T14:00:00.000Z";
  const cases = [
    { name: "confirmed", status: "confirmed", hold: null, live: true },
    { name: "payment hold, not expired", status: "pending_payment", hold: FUTURE_HOLD, live: true },
    { name: "payment hold with no expiry", status: "pending_payment", hold: null, live: true },
    { name: "payment hold, expired", status: "pending_payment", hold: EXPIRED_HOLD, live: false },
    { name: "cancelled", status: "cancelled", hold: null, live: false },
    { name: "paid_conflict", status: "paid_conflict", hold: null, live: false },
  ];
  let day = 9;
  for (const c of cases) {
    const date = `2026-10-${String(day++).padStart(2, "0")}`;
    await setDayExtension(db, "owner-1", date, "21:00");
    db.sqlite
      .prepare(`INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, hold_expires_at, created_by, created_at, updated_at) VALUES (?,'m1','court-1',?,?,2,?,'pay',?,'m1','x','x')`)
      .run(`b-${c.name}`, crDateTimeToUtcIso(date, "19:00"), crDateTimeToUtcIso(date, "20:30"), c.status, c.hold);

    const grid = await callPortal(db, {}, { path: `/api/portal/resources/court-1/availability?date=${date}`, session: viewer });
    const slot = grid.data.slots.find((x) => x.start === crDateTimeToUtcIso(date, "19:00"));
    const engineSaysLive = slot.state !== "available";
    const cleared = await clearDayExtension(db, "owner-1", date);

    assert.equal(engineSaysLive, c.live, `${c.name}: the engine`);
    assert.equal(cleared.late_bookings, c.live ? 1 : 0, `${c.name}: the owner's late count`);
  }
});

test("the one reader counts live bookings that start in a window and end after a time, and nothing else", async () => {
  addAccount(db, { id: "m1", email: "m1@example.com" });
  const insert = (id, resource, start, end, status = "confirmed") =>
    db.sqlite
      .prepare(`INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, created_by, created_at, updated_at) VALUES (?,'m1',?,?,?,2,?,'included','m1','x','x')`)
      .run(id, resource, start, end, status);
  const at = (h) => crDateTimeToUtcIso("2026-10-09", h);
  insert("late", "court-1", at("19:00"), at("20:30"));
  insert("ends-exactly-at-close", "court-1", at("17:30"), at("19:00"));
  insert("other-court", "court-2", at("19:00"), at("20:30"));
  insert("cancelled", "court-1", at("07:00"), at("20:00"), "cancelled");
  insert("next-day", "court-1", crDateTimeToUtcIso("2026-10-10", "19:00"), crDateTimeToUtcIso("2026-10-10", "20:30"));
  const count = (resource) => countLiveBookingsEndingAfter(db, resource, at("00:00"), crDateTimeToUtcIso("2026-10-10", "00:00"), at("19:00"));
  assert.equal(await count("court-1"), 1);
  assert.equal(await count("court-2"), 1);
  assert.equal(await count("court-3"), 0);
});

// C4-02: day-hours.js owns day_close_overrides and nothing else. It holds
// no bookings query, and the live-booking rule is written exactly once in
// the whole source tree, in booking.js.
test("no bookings SQL in day-hours.js, and the live-booking rule appears once in src", () => {
  assert.doesNotMatch(readFileSync("src/portal/day-hours.js", "utf8"), /FROM\s+bookings|JOIN\s+bookings/i);
  // Matches the rule written out literally, or built by booking.js's
  // liveBookingSql (which writes the column through a helper).
  const copies = [];
  for (const dir of ["src", "src/portal", "src/portal/routes"]) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const n = (readFileSync(`${dir}/${f}`, "utf8").match(/hold_expires_at(?:"\)\})? IS NULL OR/g) || []).length;
      if (n) copies.push(`${dir}/${f} x${n}`);
    }
  }
  assert.deepEqual(copies, ["src/portal/booking.js x1"]);
});
