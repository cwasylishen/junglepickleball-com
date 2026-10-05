// F-03 (independent audit): a booking start in ECMAScript expanded-year ISO
// form ("+010000-12-01T14:30:00.000Z") parsed as a valid Date, sorted before
// "2026-..." as a string, and so slipped past the 60-day window and the
// guest 2-court cap. The fix is one strict boundary: a start (or end) is
// accepted only in the exact shape the portal's own slots carry,
// YYYY-MM-DDTHH:MM:SS(.sss)?Z, by the one function parseInstantUtc in
// src/portal/booking.js. Everything else is a 400 with a stable code.
//
// Clock fixed to Monday 2026-10-05 09:00 Costa Rica time. Every case goes
// through the router (or ownerOverrideBooking) against a real SQLite
// database seeded from scripts/seed-prod.sql.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso as crAt } from "./launch-helpers.mjs";
import { ownerOverrideBooking } from "../src/portal/owner.js";
import { parseInstantUtc } from "../src/portal/booking.js";

const ENV = { OWNER_EMAILS: "roger@example.com" };
const PLUS_60 = "2026-12-04"; // today (CR) 2026-10-05 + 60 days
const PLUS_61 = "2026-12-05";

let db;
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
});
afterEach(() => mock.timers.reset());

async function guest(id) {
  addAccount(db, { id, email: `${id}@example.com`, role: "guest" });
  return sessionFor(db, id);
}
async function member(id) {
  makeMember(db, id);
  return sessionFor(db, id);
}
async function owner(id) {
  addAccount(db, { id, email: "roger@example.com", role: "owner" });
  return sessionFor(db, id);
}

const book = (session, resource_id, start, extra = {}) =>
  callPortal(db, ENV, { method: "POST", path: "/api/portal/bookings", session, body: { resource_id, start, party_size: 2, ...extra } });
const ownerBook = (session, resource_id, start) =>
  callPortal(db, ENV, { method: "POST", path: "/api/portal/owner/bookings", session, body: { resource_id, start, walk_in_name: "Walk-in" } });
const bookingRows = () => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n;

// 08:30 Costa Rica on 2026-12-01 is 14:30Z. These are the same wall time in
// the forms that used to be accepted.
const GOOD = "2026-12-01T14:30:00.000Z";
const BAD_STARTS = {
  "expanded year, + sign, 4 digits": "+002026-12-01T14:30:00.000Z",
  "expanded year, + sign, year 10000": "+010000-12-01T14:30:00.000Z",
  "expanded year, + sign, year 275760": "+275760-09-13T00:00:00.000Z",
  "expanded year, - sign, year -1": "-000001-12-01T14:30:00.000Z",
  "expanded year, - sign, year -271821": "-271821-04-20T00:00:00.000Z",
  "negative zero year": "-000000-12-01T14:30:00.000Z",
  "numeric offset +00:00": "2026-12-01T14:30:00.000+00:00",
  "numeric offset -06:00": "2026-12-01T08:30:00.000-06:00",
  "no zone designator": "2026-12-01T14:30:00.000",
  "lower-case z": "2026-12-01T14:30:00.000z",
  "no seconds": "2026-12-01T14:30Z",
  "date only": "2026-12-01",
  "space instead of T": "2026-12-01 14:30:00.000Z",
  "leading space": " 2026-12-01T14:30:00.000Z",
  "trailing text": "2026-12-01T14:30:00.000Zjunk",
  "five digit year": "12026-12-01T14:30:00.000Z",
  "four fraction digits": "2026-12-01T14:30:00.0000Z",
  "month 13": "2026-13-01T14:30:00.000Z",
  "30 February": "2026-02-30T14:30:00.000Z",
  "hour 24": "2026-12-01T24:00:00.000Z",
  "garbage": "next tuesday",
  "empty": "",
};

// ---- the validator itself ------------------------------------------------

test("parseInstantUtc: the shapes the portal sends are accepted, with and without milliseconds", () => {
  assert.equal(parseInstantUtc(GOOD).toISOString(), GOOD);
  assert.equal(parseInstantUtc("2026-12-01T14:30:00Z").toISOString(), GOOD);
  assert.equal(parseInstantUtc("2026-12-01T14:30:00.5Z").toISOString(), "2026-12-01T14:30:00.500Z");
});

for (const [name, value] of Object.entries(BAD_STARTS)) {
  test(`parseInstantUtc: refuses ${name} (${JSON.stringify(value)})`, () => {
    assert.equal(parseInstantUtc(value), null);
  });
}

test("parseInstantUtc: refuses anything that is not a string", () => {
  for (const value of [undefined, null, 0, 1796135400000, true, {}, [], [GOOD]]) assert.equal(parseInstantUtc(value), null, JSON.stringify(value));
});

// ---- member and guest booking (POST /api/portal/bookings) ----------------

for (const [name, value] of Object.entries(BAD_STARTS)) {
  test(`member booking: ${name} is 400 invalid_request and writes nothing`, async () => {
    const s = await member("m1");
    const r = await book(s, "court-1", value);
    assert.deepEqual([r.status, r.data.error], [400, "invalid_request"]);
    assert.equal(bookingRows(), 0);
  });
}

test("guest cap: year-10000 starts no longer slip past the 2-court cap (three bookings were accepted before)", async () => {
  const g = await guest("g1");
  const results = [];
  for (const [court, day] of [["court-1", "01"], ["court-2", "02"], ["court-3", "03"]]) {
    results.push(await book(g, court, `+010000-12-${day}T14:30:00.000Z`));
  }
  assert.deepEqual(results.map((r) => [r.status, r.data.error]), [[400, "invalid_request"], [400, "invalid_request"], [400, "invalid_request"]]);
  assert.equal(bookingRows(), 0);
});

test("window: a year-10000 start is refused, not treated as 'before the window closes'", async () => {
  const s = await member("m1");
  const r = await book(s, "court-1", "+010000-12-01T14:30:00.000Z");
  assert.deepEqual([r.status, r.data.error], [400, "invalid_request"]);
});

test("window boundary: day 60 is bookable, day 61 is outside_window (both in the exact format)", async () => {
  const s = await member("m1");
  const inside = await book(s, "court-1", crAt(PLUS_60, "08:30"));
  assert.equal(inside.status, 201);
  const outside = await book(s, "court-2", crAt(PLUS_61, "08:30"));
  assert.deepEqual([outside.status, outside.data.error], [409, "outside_window"]);
});

test("window boundary for a guest: day 60 is bookable, day 61 is outside_window", async () => {
  const g = await guest("g1");
  assert.equal((await book(g, "court-1", crAt(PLUS_60, "08:30"))).status, 201);
  const outside = await book(g, "court-2", crAt(PLUS_61, "08:30"));
  assert.deepEqual([outside.status, outside.data.error], [409, "outside_window"]);
});

test("a start without milliseconds (YYYY-MM-DDTHH:MM:SSZ) is still accepted", async () => {
  const s = await member("m1");
  const r = await book(s, "court-1", "2026-12-01T14:30:00Z");
  assert.equal(r.status, 201);
  assert.equal(r.data.booking.id.length > 0, true);
});

test("a past start in the exact format is still 409 in_past", async () => {
  const s = await member("m1");
  const r = await book(s, "court-1", "2026-10-04T14:30:00.000Z");
  assert.deepEqual([r.status, r.data.error], [409, "in_past"]);
});

// ---- owner booking on behalf (POST /api/portal/owner/bookings) -----------

for (const [name, value] of Object.entries(BAD_STARTS)) {
  test(`owner booking: ${name} is 400 bad_start and writes nothing`, async () => {
    const s = await owner("o1");
    const r = await ownerBook(s, "court-1", value);
    assert.deepEqual([r.status, r.data.error], [400, "bad_start"]);
    assert.equal(bookingRows(), 0);
  });
}

test("owner booking: a missing start is bad_start; the exact format works", async () => {
  const s = await owner("o1");
  const missing = await callPortal(db, ENV, { method: "POST", path: "/api/portal/owner/bookings", session: s, body: { resource_id: "court-1", walk_in_name: "Walk-in" } });
  assert.deepEqual([missing.status, missing.data.error], [400, "bad_start"]);
  assert.equal((await ownerBook(s, "court-1", GOOD)).status, 201);
});

test("ownerOverrideBooking (the activity function, not only the route) refuses the expanded-year form", async () => {
  const r = await ownerOverrideBooking(db, "o1", { resource_id: "court-1", start: "+010000-12-01T14:30:00.000Z", walk_in_name: "Walk-in" });
  assert.equal(r.error, "bad_start");
  assert.equal(bookingRows(), 0);
});

// ---- the other entry points that take a date or time ---------------------

test("availability and day extensions take a calendar date: expanded-year and timestamp forms are bad_date", async () => {
  const s = await owner("o1");
  for (const date of ["+010000-12-01", "-000001-12-01", "2026-12-01T00:00:00Z", "12026-12-01"]) {
    const a = await callPortal(db, ENV, { path: `/api/portal/resources/court-1/availability?date=${encodeURIComponent(date)}`, session: s });
    assert.deepEqual([a.status, a.data.error], [400, "bad_date"], `availability ${date}`);
    const e = await callPortal(db, ENV, { method: "POST", path: "/api/portal/owner/day-extensions", session: s, body: { date, close_time: "21:00" } });
    assert.deepEqual([e.status, e.data.error], [400, "bad_date"], `day extension ${date}`);
  }
});

test("owner blocks take a one-off date: expanded-year forms are bad_date", async () => {
  const s = await owner("o1");
  for (const date of ["+010000-12-01", "-000001-12-01", "2026-12-01T00:00:00Z"]) {
    const r = await callPortal(db, ENV, { method: "POST", path: "/api/portal/owner/blocks", session: s, body: { resource_id: "court-1", kind: "one_off", date, start_time: "10:00", end_time: "11:00" } });
    assert.deepEqual([r.status, r.data.error], [400, "bad_date"], date);
  }
});

// ---- one validator, not copies --------------------------------------------

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".js") ? [path] : [];
  });
}

test("no portal code parses a request's start with new Date(...) itself: the strict format appears in exactly one place", () => {
  const files = sourceFiles(new URL("../src/portal", import.meta.url).pathname);
  const withFormat = files.filter((f) => /\\d\{4\}-\\d\{2\}-\\d\{2\}T/.test(readFileSync(f, "utf8")));
  assert.deepEqual(withFormat.map((f) => f.split("/src/portal/")[1]), ["booking.js"]);
  for (const f of files) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /new Date\((startRaw|start|body\.start)\)/, `${f} parses a request start directly`);
  }
});
