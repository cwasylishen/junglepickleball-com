// Google Calendar READ side (src/portal/gcal-busy.js): Roger's own events
// make a slot unavailable. Every case runs the portal the way the Worker
// does (router, session, CSRF) against real SQLite seeded from
// scripts/seed-prod.sql, with the clock fixed to Monday 2026-10-05 09:00
// Costa Rica time. Google is a fake `fetch`; the cache is a Map. No network.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso as crAt } from "./launch-helpers.mjs";
import { drainCalendarOutbox, buildEventBody, __resetAccessTokenCacheForTests } from "../src/portal/gcal.js";
import { busyIntervalsForWindow, crDatesCovering, eventInterval, isBusyEvent, PORTAL_SOURCE, CR_TIME_ZONE } from "../src/portal/gcal-busy.js";
import { crDateStringFromUtc } from "../src/portal/cr-time.js";

const DAY = "2026-10-08";
const TODAY_CR = "2026-10-05";
const LAST_DAY_CR = "2026-12-04"; // 60 days after the mocked Costa Rica date; the seeded windows are 60 days.
const CAL = "court1@group.calendar.google.com";
const CAL2 = "court2@group.calendar.google.com";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SECRET = JSON.stringify({ client_email: "jp-portal@example.iam.gserviceaccount.com", private_key: privateKey });

let db;
let session; // m1's session, made once per test
let kv;
let google; // the fake Google: google.events[calendarId] = [event, ...]
let errorLines;

// A Map-backed KV that remembers each put's TTL.
function fakeKv({ honorExpiry = false } = {}) {
  const map = new Map();
  const expires = new Map();
  return { map, ttls: new Map(), gets: 0, puts: 0,
    async get(k) {
      this.gets += 1;
      if (honorExpiry && expires.has(k) && Date.now() >= expires.get(k)) {
        map.delete(k);
        expires.delete(k);
      }
      return map.get(k) ?? null;
    },
    async put(k, v, opts) {
      this.puts += 1;
      map.set(k, v);
      this.ttls.set(k, opts && opts.expirationTtl);
      if (honorExpiry && opts && opts.expirationTtl != null) expires.set(k, Date.now() + opts.expirationTtl * 1000);
    } };
}

// A fake Google: token endpoint + events.list (honours timeMin/timeMax, pages of `pageSize`).
function fakeGoogle() {
  const g = { events: {}, calls: [], mode: "ok", pageSize: 250, failCalendars: new Set(), hangEvents: false, hangInterval: null };
  g.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    g.calls.push({ url: String(url), init });
    if (u.origin + u.pathname === "https://oauth2.googleapis.com/token") {
      if (g.mode === "token_fail") return new Response("denied", { status: 401 });
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (g.mode === "throw") throw new Error("network down");
    if (g.mode === "http500") return new Response("boom", { status: 500 });
    const calendarId = decodeURIComponent(u.pathname.split("/")[4]);
    if (g.failCalendars.has(calendarId)) return new Response("boom", { status: 500 });
    if (g.hangEvents) {
      g.hangInterval = setInterval(() => {}, 1000);
      try {
        return await new Promise((resolve, reject) => {
          const abort = () => reject(init.signal.reason || new Error("aborted"));
          if (!init.signal) {
            g.hangFallback = setTimeout(() => reject(new Error("no abort signal")), 6000);
            return;
          }
          if (init.signal.aborted) abort();
          else init.signal.addEventListener("abort", abort, { once: true });
        });
      } finally {
        clearTimeout(g.hangFallback);
        g.hangFallback = null;
        clearInterval(g.hangInterval);
        g.hangInterval = null;
      }
    }
    const min = u.searchParams.get("timeMin");
    const max = u.searchParams.get("timeMax");
    const all = (g.events[calendarId] || []).filter((e) => {
      const s = e.start.dateTime ? new Date(e.start.dateTime).toISOString() : crAt(e.start.date, "00:00");
      const en = e.end.dateTime ? new Date(e.end.dateTime).toISOString() : crAt(e.end.date, "00:00");
      return s < max && min < en;
    });
    const from = Number(u.searchParams.get("pageToken") || 0);
    const items = all.slice(from, from + g.pageSize);
    return Response.json({ items, ...(from + g.pageSize < all.length ? { nextPageToken: String(from + g.pageSize) } : {}) });
  };
  g.eventListCalls = () => g.calls.filter((c) => c.url.includes("/events?"));
  return g;
}

const timed = (date, from, to, extra = {}) => ({ start: { dateTime: crAt(date, from) }, end: { dateTime: crAt(date, to) }, ...extra });
const env = (extra = {}) => ({ OWNER_EMAILS: "roger@example.com", GCAL_BUSY_CACHE: kv, GOOGLE_SERVICE_ACCOUNT_JSON: SECRET, ...extra });
const setCalendar = (resourceId, calendarId) => db.sqlite.prepare(`UPDATE resources SET google_calendar_id = ? WHERE id = ?`).run(calendarId, resourceId);

async function slots(e, resourceId = "court-1", date = DAY) {
  const res = await callPortal(db, e, { path: `/api/portal/resources/${resourceId}/availability?date=${date}`, session });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.slots;
}
const stateAt = (list, date, hhmm) => list.find((s) => s.start === crAt(date, hhmm)).state;
const book = async (e, resourceId, start) =>
  callPortal(db, e, { method: "POST", path: "/api/portal/bookings", session, body: { resource_id: resourceId, start, party_size: 2 } });

beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
  makeMember(db, "m1");
  session = await sessionFor(db, "m1");
  kv = fakeKv();
  google = fakeGoogle();
  mock.method(globalThis, "fetch", google.fetch);
  errorLines = [];
  mock.method(console, "error", (line) => errorLines.push(String(line)));
  __resetAccessTokenCacheForTests();
  setCalendar("court-1", CAL);
});
afterEach(() => {
  if (google && google.hangInterval) clearInterval(google.hangInterval);
  if (google) google.hangInterval = null;
  mock.restoreAll();
  mock.timers.reset();
});

// ---------- inert without configuration ----------

test("no secret: availability and booking are what they were, Google and KV are never touched", async () => {
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  const list = await slots(env({ GOOGLE_SERVICE_ACCOUNT_JSON: undefined }));
  assert.equal(list.length, 8);
  assert.equal(stateAt(list, DAY, "10:00"), "available");
  assert.equal((await book(env({ GOOGLE_SERVICE_ACCOUNT_JSON: undefined }), "court-1", crAt(DAY, "10:00"))).status, 201);
  assert.equal(google.calls.length, 0);
  assert.equal(kv.gets + kv.puts, 0);
  assert.deepEqual(errorLines, []);
});

test("secret set but the resource has no calendar id (or only spaces): no Google call, DB only", async () => {
  setCalendar("court-1", null);
  setCalendar("court-2", "   ");
  assert.equal(stateAt(await slots(env()), DAY, "10:00"), "available");
  assert.equal(stateAt(await slots(env(), "court-2"), DAY, "10:00"), "available");
  assert.equal(google.calls.length, 0);
});

// ---------- read side: busy intervals merged into availability ----------

test("a busy event makes exactly the slots it overlaps unavailable; neighbours stay available; no title leaks", async () => {
  google.events[CAL] = [timed(DAY, "10:00", "11:30", { summary: "Roger private lesson" })];
  const res = await callPortal(db, env(), { path: `/api/portal/resources/court-1/availability?date=${DAY}`, session });
  const list = res.data.slots;
  assert.equal(stateAt(list, DAY, "08:30"), "available");
  assert.equal(stateAt(list, DAY, "10:00"), "blocked");
  assert.equal(stateAt(list, DAY, "11:30"), "available");
  assert.ok(!JSON.stringify(res.data).includes("Roger private lesson"));
});

test("busy merge: several events, a second page, and an all-day event all count; free and cancelled events do not", async () => {
  google.pageSize = 1;
  google.events[CAL] = [
    timed(DAY, "07:00", "08:00"),
    timed(DAY, "11:00", "12:00"), // overlaps the 10:00 and 11:30 slots
    timed(DAY, "15:00", "16:00", { transparency: "transparent" }),
    timed(DAY, "17:30", "19:00", { status: "cancelled" }),
  ];
  const list = await slots(env());
  assert.equal(google.eventListCalls().length, 4, "four pages of one event each were followed");
  assert.deepEqual(
    ["07:00", "08:30", "10:00", "11:30", "13:00", "14:30", "16:00", "17:30"].map((t) => stateAt(list, DAY, t)),
    ["blocked", "available", "blocked", "blocked", "available", "available", "available", "available"]
  );

  google.events[CAL] = [{ start: { date: DAY }, end: { date: "2026-10-09" } }]; // all-day, end exclusive
  kv.map.clear();
  assert.ok((await slots(env())).every((s) => s.state === "blocked"));
  assert.ok((await slots(env(), "court-1", "2026-10-09")).every((s) => s.state === "available"), "the all-day event ends at midnight CR");
});

test("two resources keep same-day busy cache entries separate by calendar", async () => {
  setCalendar("court-2", CAL2);
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  google.events[CAL2] = [timed(DAY, "13:00", "14:30")];

  const e = env();
  const court1 = await slots(e, "court-1");
  const court2 = await slots(e, "court-2");
  assert.equal(stateAt(court1, DAY, "10:00"), "blocked");
  assert.equal(stateAt(court1, DAY, "13:00"), "available");
  assert.equal(stateAt(court2, DAY, "10:00"), "available");
  assert.equal(stateAt(court2, DAY, "13:00"), "blocked");
  const okKeys = [...kv.map.keys()].filter((key) => key.startsWith("gcalbusy:v1:") && !key.includes(":err:"));
  assert.equal(okKeys.length, 2);
  assert.ok(okKeys.some((key) => key.includes(encodeURIComponent(CAL))));
  assert.ok(okKeys.some((key) => key.includes(encodeURIComponent(CAL2))));
});

test("error memos are separate by calendar and fresh booking reads recover independently", async () => {
  setCalendar("court-2", CAL2);
  google.failCalendars.add(CAL);
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  google.events[CAL2] = [timed(DAY, "13:00", "14:30")];

  const e = env();
  assert.equal(stateAt(await slots(e, "court-1"), DAY, "10:00"), "available");
  assert.equal(stateAt(await slots(e, "court-2"), DAY, "13:00"), "blocked");
  const errKeys = [...kv.map.keys()].filter((key) => key.startsWith("gcalbusy:v1:err:"));
  assert.equal(errKeys.length, 1);
  assert.ok(errKeys[0].includes(encodeURIComponent(CAL)));

  const court2Busy = await book(e, "court-2", crAt(DAY, "13:00"));
  assert.deepEqual([court2Busy.status, court2Busy.data.error], [409, "calendar_busy"]);
  const court1Recovered = await book(e, "court-1", crAt(DAY, "10:00"));
  assert.equal(court1Recovered.status, 201, JSON.stringify(court1Recovered.data));
});

test("events the portal pushed are skipped: source=portal, and an older push that only has booking_id", async () => {
  google.events[CAL] = [
    timed(DAY, "07:00", "08:30", { extendedProperties: { private: { source: PORTAL_SOURCE, booking_id: "b1" } } }),
    timed(DAY, "08:30", "10:00", { extendedProperties: { private: { booking_id: "b2" } } }),
    timed(DAY, "10:00", "11:30", { extendedProperties: { private: { note: "typed by Roger" } } }),
  ];
  const list = await slots(env());
  assert.deepEqual([stateAt(list, DAY, "07:00"), stateAt(list, DAY, "08:30"), stateAt(list, DAY, "10:00")], ["available", "available", "blocked"]);
});

test("the event the portal itself pushes is the one it skips (push -> read round trip)", async () => {
  const e = env();
  assert.equal((await book(e, "court-1", crAt(DAY, "10:00"))).status, 201);
  const pushed = [];
  const fakePush = async (url, init = {}) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/")) return Response.json({ access_token: "tok", expires_in: 3600 });
    pushed.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  const drained = await drainCalendarOutbox({ PORTAL_DB: db, ...e }, { fetchImpl: fakePush });
  assert.equal(drained.sent, 1);
  assert.equal(pushed[0].extendedProperties.private.source, PORTAL_SOURCE);

  google.events[CAL] = [pushed[0]];
  kv.map.clear();
  assert.equal(stateAt(await slots(e), DAY, "10:00"), "mine", "own booking is not turned into a Google block");
  assert.equal(stateAt(await slots(e), DAY, "11:30"), "available");
});

test("PORTAL_SOURCE is exactly what buildEventBody writes", () => {
  const body = buildEventBody({ resourceName: "Court 1", startAt: crAt(DAY, "10:00"), endAt: crAt(DAY, "11:30"), bookingId: "b-1" });
  assert.equal(body.extendedProperties.private.source, PORTAL_SOURCE);
  assert.equal(isBusyEvent(body), false);
});

// ---------- booking-time re-check ----------

test("re-check at booking: a slot busy in Google is refused with calendar_busy and writes nothing, even when the cache said free", async () => {
  const e = env();
  assert.equal(stateAt(await slots(e), DAY, "10:00"), "available"); // caches "no busy" for the day
  google.events[CAL] = [timed(DAY, "10:30", "11:00")]; // Roger blocks it a minute later
  assert.equal(stateAt(await slots(e), DAY, "10:00"), "available", "display still comes from the 3-minute cache");

  const refused = await book(e, "court-1", crAt(DAY, "10:00"));
  assert.deepEqual([refused.status, refused.data.error], [409, "calendar_busy"]);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n, 0);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM calendar_outbox`).get().n, 0);

  assert.equal((await book(e, "court-1", crAt(DAY, "11:30"))).status, 201, "the free slot beside it still books");
  assert.equal(stateAt(await slots(e), DAY, "10:00"), "blocked", "the fresh read refreshed the cache");
});

test("the member page has words for calendar_busy", () => {
  const src = readFileSync(new URL("../portal/js/member.js", import.meta.url), "utf8");
  assert.match(src, /"book\.err_calendar_busy": "That time is no longer available\. Pick another\."/);
  assert.match(src, /calendar_busy: t\("book\.err_calendar_busy"\)/);
});

// ---------- cache ----------

test("busy results are cached 3 minutes in KV: a second view makes no Google call", async () => {
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  const e = env();
  await slots(e);
  const callsAfterFirst = google.eventListCalls().length;
  assert.equal(callsAfterFirst, 1);
  await slots(e);
  assert.equal(google.eventListCalls().length, callsAfterFirst);
  const key = [...kv.ttls.keys()].find((k) => k.startsWith("gcalbusy:v1:") && !k.includes(":err:"));
  assert.equal(kv.ttls.get(key), 180);
});

// ---------- Google errors: fail safe ----------

for (const mode of ["http500", "token_fail", "throw"]) {
  test(`Google error (${mode}): availability shows the DB's own slots, one error line with an id, booking still works`, async () => {
    google.mode = mode;
    google.events[CAL] = [timed(DAY, "10:00", "11:30")];
    const e = env();
    const list = await slots(e);
    assert.equal(list.length, 8);
    assert.ok(list.every((s) => s.state === "available"), "no Google blocks are shown when Google cannot be read");
    assert.equal(errorLines.length, 1);
    assert.match(errorLines[0], /^gcal_busy_unreadable error_id=[0-9a-f]{8} resource_id=court-1 /);
    assert.ok(!errorLines[0].includes(CAL) && !errorLines[0].includes("PRIVATE KEY"), "no calendar id or key in the log");

    // The second view inside the minute does not ask Google again or log again.
    const callsBefore = google.calls.length;
    await slots(e);
    assert.equal(google.calls.length, callsBefore);
    assert.equal(errorLines.length, 1);

    // Google down never blocks booking: the re-check fails safe, the DB decides.
    const booked = await book(e, "court-1", crAt(DAY, "10:00"));
    assert.equal(booked.status, 201, JSON.stringify(booked.data));
    assert.equal(errorLines.length, 2);
    assert.notEqual(errorLines[0].match(/error_id=(\w+)/)[1], errorLines[1].match(/error_id=(\w+)/)[1], "each failure has its own id");
  });
}

test("Google error: the database's own double-booking guard still refuses a taken slot", async () => {
  const e = env();
  assert.equal((await book(e, "court-1", crAt(DAY, "10:00"))).status, 201);
  google.mode = "http500";
  makeMember(db, "m2");
  const second = await callPortal(db, e, { method: "POST", path: "/api/portal/bookings", session: await sessionFor(db, "m2"), body: { resource_id: "court-1", start: crAt(DAY, "10:00"), party_size: 2 } });
  assert.deepEqual([second.status, second.data.error], [409, "slot_taken"]);
});

test("a hanging Google events request aborts at 3 seconds for availability and fresh booking", { timeout: 10000 }, async () => {
  google.hangEvents = true;
  const e = env();

  const viewStart = process.hrtime.bigint();
  const list = await slots(e);
  const viewElapsedMs = Number(process.hrtime.bigint() - viewStart) / 1e6;
  assert.ok(list.every((s) => s.state === "available"));
  assert.ok(viewElapsedMs >= 2900 && viewElapsedMs < 3600, `availability took ${viewElapsedMs} ms`);

  kv = fakeKv();
  const bookingStart = process.hrtime.bigint();
  const booked = await book(env(), "court-1", crAt(DAY, "11:30"));
  const bookingElapsedMs = Number(process.hrtime.bigint() - bookingStart) / 1e6;
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.ok(bookingElapsedMs < 3600, `booking took ${bookingElapsedMs} ms`);
});

test("the availability error memo expires after 60 seconds", async () => {
  kv = fakeKv({ honorExpiry: true });
  google.mode = "http500";
  const e = env();

  await slots(e);
  assert.equal(errorLines.length, 1);
  assert.equal(google.eventListCalls().length, 1);
  const errKey = [...kv.ttls.keys()].find((key) => key.startsWith("gcalbusy:v1:err:"));
  assert.ok(errKey);
  assert.equal(kv.ttls.get(errKey), 60);

  mock.timers.tick(59000);
  await slots(e);
  assert.equal(google.eventListCalls().length, 1);
  assert.equal(errorLines.length, 1);

  mock.timers.tick(2000);
  await slots(e);
  assert.equal(google.eventListCalls().length, 2);
  assert.equal(errorLines.length, 2);
});

test("an unreadable GOOGLE_SERVICE_ACCOUNT_JSON is the same fail-safe, not a 500", async () => {
  const list = await slots(env({ GOOGLE_SERVICE_ACCOUNT_JSON: "{not json" }));
  assert.ok(list.every((s) => s.state === "available"));
  assert.equal(errorLines.length, 1);
});

test("an unparseable service-account JSON has a fixed safe error message", async () => {
  const list = await slots(env({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key": MIIEvQIBADANBgkqhki, "client_email": "x"}' }));
  assert.equal(list.length, 8);
  assert.ok(list.every((s) => s.state === "available"));
  assert.equal(errorLines.length, 1);
  assert.match(errorLines[0], /message=gcal_service_account_json_unparseable$/);
  assert.ok(!errorLines.some((line) => /MIIEv|BADANBgkq|Unexpected token/.test(line)));
  assert.equal((await book(env({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key": MIIEvQIBADANBgkqhki, "client_email": "x"}' }), "court-1", crAt(DAY, "10:00"))).status, 201);
});

test("a cache write failure logs only a generated id and resource id", async () => {
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  const brokenKv = {
    async get() { return null; },
    async put() { throw new Error(`${CAL} SECRET-TEXT`); },
  };
  const list = await slots(env({ GCAL_BUSY_CACHE: brokenKv }));
  assert.equal(stateAt(list, DAY, "10:00"), "blocked");
  assert.equal(errorLines.length, 1);
  assert.match(errorLines[0], /^gcal_busy_cache_write_failed error_id=[0-9a-f]{8} resource_id=court-1$/);
  assert.ok(!errorLines[0].includes(CAL) && !errorLines[0].includes("gcalbusy:v1") && !errorLines[0].includes("SECRET-TEXT"));
});

test("a KV that throws is a cache miss, not a refusal", async () => {
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  const brokenKv = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
  const list = await slots(env({ GCAL_BUSY_CACHE: brokenKv }));
  assert.equal(stateAt(list, DAY, "10:00"), "blocked");
});

// ---------- timezone: America/Costa_Rica ----------

test("the Google query covers one Costa Rica day: 06:00Z to 06:00Z next day, in the America/Costa_Rica zone", async () => {
  await slots(env());
  const q = new URL(google.eventListCalls()[0].url).searchParams;
  assert.equal(q.get("timeMin"), "2026-10-08T06:00:00.000Z");
  assert.equal(q.get("timeMax"), "2026-10-09T06:00:00.000Z");
  assert.equal(q.get("timeZone"), "America/Costa_Rica");
  assert.equal(q.get("singleEvents"), "true");
  assert.equal(CR_TIME_ZONE, "America/Costa_Rica");
});

test("dates before today or after the longest booking window do no Google or cache I/O", async () => {
  google.events[CAL] = [timed("2026-10-04", "10:00", "11:30"), timed("2026-12-05", "10:00", "11:30")];
  assert.equal((await slots(env(), "court-1", "2026-10-04")).length, 8);
  assert.equal((await slots(env(), "court-1", "2026-12-05")).length, 8);
  assert.equal(google.calls.length, 0);
  assert.equal(kv.gets + kv.puts, 0);
});

test("today and the last allowed day both read Google and show their busy block", async () => {
  google.events[CAL] = [timed(TODAY_CR, "10:00", "11:30"), timed(LAST_DAY_CR, "10:00", "11:30")];
  assert.equal(stateAt(await slots(env(), "court-1", TODAY_CR), TODAY_CR, "10:00"), "blocked");
  assert.equal(stateAt(await slots(env(), "court-1", LAST_DAY_CR), LAST_DAY_CR, "10:00"), "blocked");
  assert.equal(google.eventListCalls().length, 2);
});

test("a window crossing the last day only reads that Costa Rica date", async () => {
  google.events[CAL] = [timed(LAST_DAY_CR, "23:30", "23:59")];
  const resource = { id: "court-1", google_calendar_id: CAL, member_window_days: 60, non_member_window_days: 60 };
  const result = await busyIntervalsForWindow(env(), resource, crAt(LAST_DAY_CR, "23:30"), crAt("2026-12-05", "00:30"), { fresh: true, clampToWindow: true });
  assert.equal(result.state, "ok");
  assert.equal(google.eventListCalls().length, 1);
  const query = new URL(google.eventListCalls()[0].url).searchParams;
  assert.equal(query.get("timeMin"), "2026-12-04T06:00:00.000Z");
  assert.equal(query.get("timeMax"), "2026-12-05T06:00:00.000Z");
});

test("an invalid clamped window logs one safe line and skips Google", async () => {
  db.sqlite.prepare(`UPDATE resources SET member_window_days = 10.5 WHERE id = 'court-1'`).run();
  const resource = db.sqlite.prepare(`SELECT * FROM resources WHERE id = 'court-1'`).get();
  const result = await busyIntervalsForWindow(env(), resource, crAt(DAY, "10:00"), crAt(DAY, "11:30"), { clampToWindow: true });
  assert.deepEqual(result, { state: "ok", intervals: [] });
  assert.equal(google.calls.length, 0);
  assert.equal(errorLines.length, 1);
  assert.match(errorLines[0], /^gcal_busy_window_invalid error_id=[0-9a-f]{8} resource_id=court-1$/);
  assert.ok(!errorLines[0].includes("10.5") && !errorLines[0].includes("member_window_days"));
});

test("the busy read uses the resource's longest window, not the shorter one", async () => {
  db.sqlite.prepare(`UPDATE resources SET member_window_days = 10, non_member_window_days = 20 WHERE id = 'court-1'`).run();
  google.events[CAL] = [timed("2026-10-25", "10:00", "11:30"), timed("2026-10-26", "10:00", "11:30")];
  assert.equal(stateAt(await slots(env(), "court-1", "2026-10-25"), "2026-10-25", "10:00"), "blocked");
  assert.equal(stateAt(await slots(env(), "court-1", "2026-10-26"), "2026-10-26", "10:00"), "available");
  assert.equal(google.eventListCalls().length, 1);
});

test("a booking past the resource window is refused before Google is read", async () => {
  const refused = await book(env(), "court-1", crAt("2026-12-05", "10:00"));
  assert.deepEqual([refused.status, refused.data.error], [409, "outside_window"]);
  assert.equal(google.calls.length, 0);
});

test("owner and staff read and re-check Google beyond the booking window", async () => {
  const day61 = "2026-12-05";
  google.events[CAL] = [timed(day61, "10:00", "11:30")];
  const people = [
    ["owner", addAccount(db, { id: "owner-1", email: "roger@example.com", role: "owner" })],
    ["staff", addAccount(db, { id: "staff-1", email: "staff-1@example.com", role: "staff" })],
  ];

  for (const [role, account] of people) {
    const personSession = await sessionFor(db, account.id);
    kv.map.clear();
    google.calls.length = 0;
    const availability = await callPortal(db, env(), { path: `/api/portal/resources/court-1/availability?date=${day61}`, session: personSession });
    assert.equal(availability.status, 200, JSON.stringify(availability.data));
    assert.equal(stateAt(availability.data.slots, day61, "10:00"), "blocked", `${role} availability reads Google`);
    assert.ok(google.eventListCalls().length >= 1);

    const refused = await callPortal(db, env(), { method: "POST", path: "/api/portal/bookings", session: personSession, body: { resource_id: "court-1", start: crAt(day61, "10:00"), party_size: 2 } });
    assert.deepEqual([refused.status, refused.data.error], [409, "calendar_busy"], `${role} booking re-checks Google`);
    assert.ok(google.eventListCalls().length >= 2);
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n, 0);
  }
});

test("an event stored with another zone's offset still lands on the right Costa Rica slot", () => {
  // 10:00 in Costa Rica is 12:00 in Toronto's UTC-4 summer offset and 06:00 in UTC+... any offset names the same instant.
  const [s, e] = eventInterval({ start: { dateTime: "2026-10-08T12:00:00-04:00" }, end: { dateTime: "2026-10-08T13:30:00-04:00" } });
  assert.deepEqual([s, e], [crAt(DAY, "10:00"), crAt(DAY, "11:30")]);
});

test("midnight: a window ending at CR midnight touches one date; one minute past it touches two", () => {
  assert.deepEqual(crDatesCovering(crAt(DAY, "22:30"), crAt("2026-10-09", "00:00")), [DAY]);
  assert.deepEqual(crDatesCovering(crAt(DAY, "22:30"), "2026-10-09T06:01:00.000Z"), [DAY, "2026-10-09"]);
});

test("midnight: an evening slot ending at 00:00 CR is blocked by an event that starts at 23:00, not by one that starts at 00:00", async () => {
  db.sqlite.prepare(`UPDATE resources SET open_time = '22:30', close_time = '24:00' WHERE id = 'court-3'`).run();
  setCalendar("court-3", "court3@group.calendar.google.com");
  const cal3 = "court3@group.calendar.google.com";

  google.events[cal3] = [{ start: { dateTime: crAt(DAY, "23:00") }, end: { dateTime: crAt("2026-10-09", "01:00") } }]; // crosses midnight CR
  let list = await slots(env(), "court-3");
  assert.equal(list.length, 1);
  assert.equal(list[0].end, crAt("2026-10-09", "00:00"));
  assert.equal(list[0].state, "blocked");

  google.events[cal3] = [{ start: { dateTime: crAt("2026-10-09", "00:00") }, end: { dateTime: crAt("2026-10-09", "01:00") } }]; // starts as the slot ends
  kv.map.clear();
  list = await slots(env(), "court-3");
  assert.equal(list[0].state, "available");
});

test("midnight: a booking whose end crosses midnight is re-checked against both Costa Rica days", async () => {
  const calendar = { google_calendar_id: CAL, id: "court-1", member_window_days: 60, non_member_window_days: 60 };
  google.events[CAL] = [{ start: { dateTime: crAt("2026-10-09", "00:00") }, end: { dateTime: crAt("2026-10-09", "01:00") } }];
  const result = await busyIntervalsForWindow(env(), calendar, crAt(DAY, "23:30"), crAt("2026-10-09", "00:30"), { fresh: true });
  assert.equal(result.state, "ok");
  assert.equal(result.intervals.length, 1, "the event on the second CR day is seen");
  assert.equal(google.eventListCalls().length, 2, "one query per Costa Rica day");
});

test("a fresh clamped read uses the Costa Rica date after UTC midnight", async () => {
  mock.timers.setTime(Date.parse("2026-10-06T00:30:00.000Z"));
  google.events[CAL] = [timed(TODAY_CR, "19:00", "20:00")];
  const resource = { id: "court-1", google_calendar_id: CAL, member_window_days: 60, non_member_window_days: 60 };
  const result = await busyIntervalsForWindow(env(), resource, crAt(TODAY_CR, "19:00"), crAt(TODAY_CR, "20:30"), { fresh: true, clampToWindow: true });
  assert.equal(result.state, "ok");
  assert.deepEqual(result.intervals, [[crAt(TODAY_CR, "19:00"), crAt(TODAY_CR, "20:00")]]);
  assert.equal(google.eventListCalls().length, 1);
});

test("api.md keeps the fresh Google booking check contract", () => {
  const api = readFileSync(new URL("../docs/portal/api.md", import.meta.url), "utf8");
  assert.match(api, /checked fresh at booking, never when Google cannot be read/);
});

test("costa rica's offset in cr-time.js matches the tz database for every day through 2030, and no other zone is named in src", () => {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let ms = Date.parse("2026-01-01T00:00:00Z"); ms < Date.parse("2031-01-01T00:00:00Z"); ms += 3600000 * 5) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const intlDate = `${parts.year}-${parts.month}-${parts.day}`;
    assert.equal(crDateStringFromUtc(new Date(ms)), intlDate, new Date(ms).toISOString());
  }
  const files = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(`${dir}${d.name}/`) : [`${dir}${d.name}`]));
  for (const f of [...files("../src/"), ...files("../portal/js/")]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(text, /Edmonton|America\/(Denver|Vancouver|Mexico_City|Chicago|New_York)|\bMST\b|\bMDT\b/, f);
  }
});

test("with no GCAL_BUSY_CACHE binding the Workers Cache API is used, for 180 s; where it does not exist there is no cache and no error", async () => {
  google.events[CAL] = [timed(DAY, "10:00", "11:30")];
  const store = new Map();
  const puts = [];
  globalThis.caches = {
    default: {
      match: async (req) => (store.has(req.url) ? new Response(store.get(req.url)) : undefined),
      put: async (req, res) => { puts.push(res.headers.get("Cache-Control")); store.set(req.url, await res.text()); },
    },
  };
  try {
    const e = env({ GCAL_BUSY_CACHE: undefined });
    await slots(e);
    await slots(e);
    assert.equal(google.eventListCalls().length, 1, "second view came from the Cache API");
    assert.deepEqual(puts, ["max-age=180"]);
    assert.ok([...store.keys()].every((k) => k.startsWith("https://gcal-busy.cache.invalid/gcalbusy:v1:")));
  } finally {
    delete globalThis.caches;
  }
  await slots(env({ GCAL_BUSY_CACHE: undefined }));
  await slots(env({ GCAL_BUSY_CACHE: undefined }));
  assert.equal(google.eventListCalls().length, 3, "no cache available: every view asks Google, and nothing throws");
});

test("portal code never names the legacy EVENTS namespace (CTL-ENV-03 stays true for this feature)", () => {
  const dir = new URL("../src/portal/", import.meta.url);
  const hits = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".js") && /env\.EVENTS\b/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(hits, []);
});
