// C4-01 (inspection 4, ruling A6): Roger's "no limit on court bookings" is
// for MEMBERS. A guest (an account with no active membership) holds at most
// 2 upcoming court bookings across all courts, paid at the club. Members,
// the owner and staff are not held to it, and the Cold Plunge and Massage
// caps are as they were.
//
// Every case calls the portal the way the Worker does (router, session,
// CSRF) against a real SQLite database seeded from scripts/seed-prod.sql,
// with the clock fixed to Monday 2026-10-05 09:00 Costa Rica time.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso as crAt } from "./launch-helpers.mjs";
import { ownerOverrideBooking } from "../src/portal/owner.js";

const ENV = { OWNER_EMAILS: "roger@example.com" };
const GUEST_CAP_MESSAGE = "Guests can hold up to 2 upcoming court bookings. Become a member for unlimited booking, or ask at the club.";

let db;
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
});
afterEach(() => mock.timers.reset());

// A guest with no membership and no credits: a court booking is pay-at-the-club.
async function guest(id) {
  addAccount(db, { id, email: `${id}@example.com`, role: "guest" });
  return sessionFor(db, id);
}
async function member(id) {
  makeMember(db, id);
  return sessionFor(db, id);
}
async function personWithRole(id, role) {
  // The router re-derives the owner role from OWNER_EMAILS on every request.
  addAccount(db, { id, email: role === "owner" ? "roger@example.com" : `${id}@example.com`, role });
  return sessionFor(db, id);
}

const book = (session, resource_id, start, extra = {}) =>
  callPortal(db, ENV, { method: "POST", path: "/api/portal/bookings", session, body: { resource_id, start, party_size: 2, ...extra } });
const cancel = (session, id) => callPortal(db, ENV, { method: "POST", path: `/api/portal/bookings/${id}/cancel`, session, body: {} });
const liveCount = (accountId) =>
  db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE account_id = ? AND status IN ('confirmed','pending_payment')`).get(accountId).n;

// A database wrapper that holds every guest-cap EARLY check (the plain
// read before the insert) at a barrier until `parties` requests have
// arrived. Without it the in-process requests do not overlap: the first
// finishes its insert before the second reads its count, and the test
// would pass with no guard at all. With it, every request reads the same
// count and all of them reach the INSERT together, so only the guard
// inside the INSERT can hold the line. A safety timer releases the
// barrier so a changed code path fails the test instead of hanging it.
// Batches are run one after another, as D1 does; the SQLite stand-in's own
// batch() opens a transaction and cannot be entered twice at once.
function withEarlyCheckBarrier(base, parties) {
  let arrived = 0;
  let batches = Promise.resolve();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const safety = setTimeout(release, 2000);
  const isEarlyCheck = (sql) => sql.startsWith("SELECT (SELECT COUNT(*) FROM bookings gb");
  const wrap = (stmt, sql) => ({
    bind: (...args) => wrap(stmt.bind(...args), sql),
    first: async (...args) => {
      if (isEarlyCheck(sql)) {
        arrived += 1;
        if (arrived >= parties) {
          clearTimeout(safety);
          release();
        }
        await gate;
      }
      return stmt.first(...args);
    },
    all: (...args) => stmt.all(...args),
    run: (...args) => stmt.run(...args),
  });
  return { sqlite: base.sqlite, prepare: (sql) => wrap(base.prepare(sql), sql), batch: (statements) => {
      const run = batches.then(() => base.batch(statements));
      batches = run.catch(() => {});
      return run;
    },
  };
}

// Two different courts and days, so only the cap (never an overlap) can refuse the third.
const SLOT_A = ["court-1", crAt("2026-10-08", "08:30")];
const SLOT_B = ["court-2", crAt("2026-10-09", "10:00")];
const SLOT_C = ["court-3", crAt("2026-10-10", "13:00")];

test("a guest's 3rd upcoming court booking, on a third court, is refused with a clear message; the first two are pay-at-the-club", async () => {
  const g = await guest("g1");
  const first = await book(g, ...SLOT_A);
  const second = await book(g, ...SLOT_B);
  assert.deepEqual([first.status, first.data.booking.pay_at_club, first.data.booking.status], [201, true, "confirmed"]);
  assert.deepEqual([second.status, second.data.booking.pay_at_club, second.data.booking.status], [201, true, "confirmed"]);

  const third = await book(g, ...SLOT_C);
  assert.deepEqual([third.status, third.data.error], [409, "guest_cap_reached"]);
  assert.equal(third.data.message, GUEST_CAP_MESSAGE);
  assert.doesNotMatch(third.data.message, /[–—]/, "no dash in the words a guest reads");
  assert.equal(liveCount("g1"), 2, "the refused request wrote nothing");
});

test("the cap counts only upcoming, live court bookings: past, cancelled and expired-hold rows do not count", async () => {
  const g = await guest("g1");
  const insert = (id, resource, start, status, hold = null) =>
    db.sqlite
      .prepare(`INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, hold_expires_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,2,?,'pay',?,?,'x','x')`)
      .run(id, "g1", resource, start, new Date(Date.parse(start) + 90 * 60000).toISOString(), status, hold, "g1");
  insert("past", "court-4", crAt("2026-10-04", "10:00"), "confirmed"); // started yesterday
  insert("started-an-hour-ago", "court-4", crAt("2026-10-05", "07:00"), "confirmed"); // before 09:00 now
  insert("cancelled", "court-4", crAt("2026-10-08", "17:30"), "cancelled");
  insert("expired-hold", "court-4", crAt("2026-10-09", "17:30"), "pending_payment", "2026-10-05T14:00:00.000Z");

  assert.equal((await book(g, ...SLOT_A)).status, 201);
  assert.equal((await book(g, ...SLOT_B)).status, 201);
  const third = await book(g, ...SLOT_C);
  assert.deepEqual([third.status, third.data.error], [409, "guest_cap_reached"]);
});

test("a guest's unexpired payment hold counts toward the cap (it is a live booking)", async () => {
  const g = await guest("g1");
  const hold = (id, resource, start) =>
    db.sqlite
      .prepare(`INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, party_size, status, payment_mode, hold_expires_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,2,'pending_payment','pay','2026-10-05T16:00:00.000Z','g1','x','x')`)
      .run(id, "g1", resource, start, new Date(Date.parse(start) + 90 * 60000).toISOString());
  hold("h1", "court-1", SLOT_A[1]);
  hold("h2", "court-2", SLOT_B[1]);
  const third = await book(g, ...SLOT_C);
  assert.deepEqual([third.status, third.data.error], [409, "guest_cap_reached"]);
});

test("cancelling one of the two frees a place: the guest can book again", async () => {
  const g = await guest("g1");
  const first = await book(g, ...SLOT_A);
  await book(g, ...SLOT_B);
  assert.equal((await book(g, ...SLOT_C)).data.error, "guest_cap_reached");
  assert.equal((await cancel(g, first.data.booking.id)).status, 200);
  assert.equal((await book(g, ...SLOT_C)).status, 201);
});

test("member unaffected: a member holds six upcoming court bookings across all four courts", async () => {
  const m = await member("m1");
  const slots = [
    ["court-1", "2026-10-08", "07:00"],
    ["court-2", "2026-10-08", "07:00"],
    ["court-3", "2026-10-08", "07:00"],
    ["court-4", "2026-10-08", "07:00"],
    ["court-1", "2026-10-09", "08:30"],
    ["court-2", "2026-10-09", "08:30"],
  ];
  for (const [court, day, time] of slots) {
    const r = await book(m, court, crAt(day, time));
    assert.equal(r.status, 201, `${court} ${day} ${time}: ${JSON.stringify(r.data)}`);
  }
  assert.equal(liveCount("m1"), 6);
});

test("on-behalf unaffected: the owner books for a guest who already holds two, and books for themselves without a cap", async () => {
  const g = await guest("g1");
  await book(g, ...SLOT_A);
  await book(g, ...SLOT_B);
  const o = await personWithRole("owner-1", "owner");
  const onBehalf = await ownerOverrideBooking(db, "owner-1", { resource_id: SLOT_C[0], start: SLOT_C[1], account_id: "g1" });
  assert.equal(onBehalf.error, undefined, JSON.stringify(onBehalf));
  assert.equal(liveCount("g1"), 3, "the owner's booking is recorded for the guest");

  // The owner is not a guest in the cap's sense: three of their own court bookings.
  for (const [court, day] of [["court-1", "2026-10-12"], ["court-2", "2026-10-13"], ["court-3", "2026-10-14"]]) {
    const r = await book(o, court, crAt(day, "10:00"));
    assert.equal(r.status, 201, `${court} ${day}: ${JSON.stringify(r.data)}`);
  }
});

test("staff unaffected: a staff account books three courts for itself", async () => {
  const s = await personWithRole("staff-1", "staff");
  for (const [court, day] of [["court-1", "2026-10-12"], ["court-2", "2026-10-13"], ["court-3", "2026-10-14"]]) {
    const r = await book(s, court, crAt(day, "10:00"));
    assert.equal(r.status, 201, `${court} ${day}: ${JSON.stringify(r.data)}`);
  }
});

test("plunge and massage unchanged: they do not count toward the court cap, and Cold Plunge keeps its own cap of one", async () => {
  const g = await guest("g1");
  await book(g, ...SLOT_A);
  await book(g, ...SLOT_B);
  // At the court cap, a Cold Plunge booking is still allowed...
  const plunge = await book(g, "cold-plunge", crAt("2026-10-08", "10:00"), { party_size: 1 });
  assert.deepEqual([plunge.status, plunge.data.error], [201, undefined]);
  // ...up to its own cap of one, with the old code.
  const plunge2 = await book(g, "cold-plunge", crAt("2026-10-09", "10:00"), { party_size: 1 });
  assert.deepEqual([plunge2.status, plunge2.data.error], [409, "cap_reached"]);
  // Massage stays off online.
  const massage = await book(g, "massage-samy", crAt("2026-10-08", "12:00"), { offering_id: "massage-60", party_size: 1 });
  assert.deepEqual([massage.status, massage.data.error], [409, "not_bookable_online"]);
  assert.equal(liveCount("g1"), 3);
});

test("a plunge booking does not use up a guest's court places", async () => {
  const g = await guest("g1");
  assert.equal((await book(g, "cold-plunge", crAt("2026-10-08", "10:00"), { party_size: 1 })).status, 201);
  assert.equal((await book(g, ...SLOT_A)).status, 201);
  assert.equal((await book(g, ...SLOT_B)).status, 201);
  assert.equal((await book(g, ...SLOT_C)).data.error, "guest_cap_reached");
});

test("a guest's own cap does not touch another guest", async () => {
  const g1 = await guest("g1");
  const g2 = await guest("g2");
  await book(g1, ...SLOT_A);
  await book(g1, ...SLOT_B);
  assert.equal((await book(g1, ...SLOT_C)).data.error, "guest_cap_reached");
  assert.equal((await book(g2, ...SLOT_C)).status, 201);
});

// Concurrency. The cap is a guard inside the same INSERT statement as the
// booking, so requests that all passed the early check still cannot go over.
test("two simultaneous guest requests with one place left: exactly one succeeds", async () => {
  const g = await guest("g1");
  assert.equal((await book(g, ...SLOT_A)).status, 201);
  const racing = withEarlyCheckBarrier(db, 2);
  const bookVia = (resource_id, start) =>
    callPortal(racing, ENV, { method: "POST", path: "/api/portal/bookings", session: g, body: { resource_id, start, party_size: 2 } });
  const [x, y] = await Promise.all([bookVia(...SLOT_B), bookVia(...SLOT_C)]);
  const outcomes = [x, y].map((r) => (r.status === 201 ? "booked" : r.data.error)).sort();
  assert.deepEqual(outcomes, ["booked", "guest_cap_reached"]);
  assert.equal(liveCount("g1"), 2);
});

test("three simultaneous guest requests from none held: at most two succeed", async () => {
  const g = await guest("g1");
  const racing = withEarlyCheckBarrier(db, 3);
  const bookVia = (resource_id, start) =>
    callPortal(racing, ENV, { method: "POST", path: "/api/portal/bookings", session: g, body: { resource_id, start, party_size: 2 } });
  const results = await Promise.all([bookVia(...SLOT_A), bookVia(...SLOT_B), bookVia(...SLOT_C)]);
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.data.error === "guest_cap_reached").length, 1);
  assert.equal(liveCount("g1"), 2);
});

test("a refused guest booking leaves no outbox row and no credit movement", async () => {
  const g = await guest("g1");
  db.sqlite.prepare(`INSERT INTO credits (account_id, balance, updated_at) VALUES ('g1', 5, 'x')`).run();
  await book(g, ...SLOT_A, { payment_choice: "credits" });
  await book(g, ...SLOT_B, { payment_choice: "credits" });
  const before = {
    outbox: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM calendar_outbox`).get().n,
    balance: db.sqlite.prepare(`SELECT balance FROM credits WHERE account_id = 'g1'`).get().balance,
    ledger: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM credits_ledger`).get().n,
  };
  const third = await book(g, ...SLOT_C, { payment_choice: "credits" });
  assert.deepEqual([third.status, third.data.error], [409, "guest_cap_reached"]);
  const after = {
    outbox: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM calendar_outbox`).get().n,
    balance: db.sqlite.prepare(`SELECT balance FROM credits WHERE account_id = 'g1'`).get().balance,
    ledger: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM credits_ledger`).get().n,
  };
  assert.deepEqual(after, before);
});
