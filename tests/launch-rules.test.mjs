// Roger's club rules (PIN L3, ruling PF-3), enforced by the booking
// engine on the server. Every case calls the portal the way the Worker
// does (router, session, CSRF) against a real SQLite database seeded
// from scripts/seed-prod.sql, with the clock fixed to Monday 2026-10-05
// 09:00 Costa Rica time, so every boundary is exact.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso as crAt } from "./launch-helpers.mjs";
import { setDayExtension, clearDayExtension } from "../src/portal/day-hours.js";
import { ownerOverrideBooking } from "../src/portal/owner.js";

const ENV = { OWNER_EMAILS: "roger@example.com" };
// 2026-10-05 is today in Costa Rica. +60 days is 2026-12-04.
const TODAY = "2026-10-05";
const PLUS_60 = "2026-12-04";
const PLUS_61 = "2026-12-05";

let db;
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
});
afterEach(() => mock.timers.reset());

async function booker(id, kind = "member") {
  if (kind === "member") makeMember(db, id);
  else {
    addAccount(db, { id, email: `${id}@example.com`, role: "guest" });
    db.sqlite.prepare(`INSERT INTO credits (account_id, balance, updated_at) VALUES (?, 5, 'x')`).run(id);
  }
  return sessionFor(db, id);
}

async function owner() {
  addAccount(db, { id: "owner-1", email: "roger@example.com", role: "owner" });
  return sessionFor(db, "owner-1");
}

const book = (session, resource_id, start, extra = {}) =>
  callPortal(db, ENV, { method: "POST", path: "/api/portal/bookings", session, body: { resource_id, start, party_size: 2, ...extra } });

test("window: 60 days ahead for a member, and the 61st day is refused", async () => {
  const s = await booker("m1");
  assert.equal((await book(s, "court-1", crAt(PLUS_60, "08:30"))).status, 201);
  const over = await book(s, "court-1", crAt(PLUS_61, "08:30"));
  assert.deepEqual([over.status, over.data.error], [409, "outside_window"]);
});

test("window: the same 60 days for a non-member with credits, the 61st day refused", async () => {
  const s = await booker("g1", "guest");
  assert.equal((await book(s, "court-2", crAt(PLUS_60, "08:30"))).status, 201);
  const over = await book(s, "court-2", crAt(PLUS_61, "08:30"));
  assert.deepEqual([over.status, over.data.error], [409, "outside_window"]);
});

test("no member cap: a member holds five upcoming bookings on one court", async () => {
  const s = await booker("m1");
  const starts = ["07:00", "08:30", "10:00", "11:30", "13:00"];
  for (const t of starts) {
    const r = await book(s, "court-1", crAt("2026-10-08", t));
    assert.equal(r.status, 201, `${t}: ${JSON.stringify(r.data)}`);
  }
  const live = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE account_id = 'm1' AND status = 'confirmed'`).get().n;
  assert.equal(live, 5);
});

test("the day's grid is 07:00 to 19:00 in 90 minute slots, last start 17:30", async () => {
  const s = await booker("m1");
  const { data } = await callPortal(db, ENV, { path: "/api/portal/resources/court-1/availability?date=2026-10-08", session: s });
  assert.equal(data.slots.length, 8);
  assert.equal(data.slots[0].start, crAt("2026-10-08", "07:00"));
  assert.equal(data.slots[7].start, crAt("2026-10-08", "17:30"));
  assert.equal(data.slots[7].end, crAt("2026-10-08", "19:00"));
});

test("booking: 17:30 (ends 19:00) is allowed; a slot that would end after 19:00 is refused on a normal day", async () => {
  const s = await booker("m1");
  assert.equal((await book(s, "court-1", crAt("2026-10-08", "17:30"))).status, 201);
  const late = await book(s, "court-2", crAt("2026-10-08", "19:00"));
  assert.deepEqual([late.status, late.data.error], [400, "outside_hours"]);
});

test("extended day: the owner's 21:00 adds the 19:00 slot (ends 20:30) for that date only", async () => {
  const s = await booker("m1");
  await owner();
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");

  const day = await callPortal(db, ENV, { path: "/api/portal/resources/court-1/availability?date=2026-10-09", session: s });
  assert.equal(day.data.slots.length, 9);
  assert.equal(day.data.slots[8].end, crAt("2026-10-09", "20:30"));
  const next = await callPortal(db, ENV, { path: "/api/portal/resources/court-1/availability?date=2026-10-10", session: s });
  assert.equal(next.data.slots.length, 8, "the next day is back to normal hours");

  assert.equal((await book(s, "court-1", crAt("2026-10-09", "19:00"))).status, 201);
  const nextDay = await book(s, "court-1", crAt("2026-10-10", "19:00"));
  assert.deepEqual([nextDay.status, nextDay.data.error], [400, "outside_hours"]);
  // 20:30 is on the grid but would end at 22:00, past the 21:00 ceiling.
  const tooLate = await book(s, "court-2", crAt("2026-10-09", "20:30"));
  assert.deepEqual([tooLate.status, tooLate.data.error], [400, "outside_hours"]);
});

test("extended day: clearing it puts the 19:00 slot out of reach again", async () => {
  const s = await booker("m1");
  await owner();
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  await clearDayExtension(db, "owner-1", "2026-10-09");
  const r = await book(s, "court-3", crAt("2026-10-09", "19:00"));
  assert.deepEqual([r.status, r.data.error], [400, "outside_hours"]);
});

test("extended day: the owner's own booking follows the same hours (extended day yes, normal day no)", async () => {
  await owner();
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  const ok = await ownerOverrideBooking(db, "owner-1", { resource_id: "court-4", start: crAt("2026-10-09", "19:00"), walk_in_name: "Walk-in" });
  assert.equal(ok.error, undefined);
  const no = await ownerOverrideBooking(db, "owner-1", { resource_id: "court-4", start: crAt("2026-10-10", "19:00"), walk_in_name: "Walk-in" });
  assert.equal(no.error, "outside_hours");
});

test("extended day: Cold Plunge is not extended (courts only)", async () => {
  const s = await booker("m1");
  await owner();
  await setDayExtension(db, "owner-1", "2026-10-09", "21:00");
  const r = await book(s, "cold-plunge", crAt("2026-10-09", "19:00"), { party_size: 1 });
  assert.deepEqual([r.status, r.data.error], [400, "outside_hours"]);
});

test("Cold Plunge: refused inside 24 h, with the minimum named; allowed from exactly 24 h", async () => {
  // Now is Monday 09:00. Tuesday 08:40 is 23 h 40 min away; Tuesday 09:00 is exactly 24 h.
  const inside = await booker("m1");
  const early = await book(inside, "cold-plunge", crAt("2026-10-06", "08:40"), { party_size: 1 });
  assert.deepEqual([early.status, early.data.error, early.data.min_advance_minutes], [409, "too_soon", 1440]);
  const sameDay = await book(inside, "cold-plunge", crAt(TODAY, "10:00"), { party_size: 1 });
  assert.deepEqual([sameDay.status, sameDay.data.error], [409, "too_soon"]);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n, 0, "a refused booking writes nothing");

  const exact = await book(inside, "cold-plunge", crAt("2026-10-06", "09:00"), { party_size: 1 });
  assert.equal(exact.status, 201, JSON.stringify(exact.data));
});

test("Cold Plunge: the 24 h rule applies to a non-member too, before any payment is attempted", async () => {
  const g = await booker("g1", "guest");
  const early = await book(g, "cold-plunge", crAt("2026-10-06", "08:40"), { party_size: 1 });
  assert.deepEqual([early.status, early.data.error], [409, "too_soon"]);
  // At 24 h the request gets past the rule. Stripe is not configured here, so (PIN L4)
  // it is recorded as a booking to be paid at the club, not refused.
  const ok = await book(g, "cold-plunge", crAt("2026-10-06", "09:00"), { party_size: 1 });
  assert.deepEqual([ok.status, ok.data.error, ok.data.booking?.pay_at_club], [201, undefined, true]);
});

test("Cold Plunge: the availability grid marks slots inside 24 h as too_soon for a member, not for the owner", async () => {
  const s = await booker("m1");
  const o = await owner();
  const member = await callPortal(db, ENV, { path: `/api/portal/resources/cold-plunge/availability?date=2026-10-06`, session: s });
  const at = (data, hhmm) => data.slots.find((x) => x.start === crAt("2026-10-06", hhmm)).state;
  assert.equal(at(member.data, "08:40"), "too_soon");
  assert.equal(at(member.data, "09:00"), "available");
  const ownerView = await callPortal(db, ENV, { path: `/api/portal/resources/cold-plunge/availability?date=2026-10-06`, session: o });
  assert.equal(at(ownerView.data, "08:40"), "available");
});

test("Cold Plunge: the owner is not held to the minimum notice (as with the window)", async () => {
  const o = await owner();
  // Booking as themselves, the owner gets past the rule. Stripe is not configured here, so (PIN L4)
  // the booking is recorded to be paid at the club.
  const self = await book(o, "cold-plunge", crAt(TODAY, "10:00"), { party_size: 1 });
  assert.deepEqual([self.status, self.data.error, self.data.booking?.pay_at_club], [201, undefined, true]);
  // The owner's walk-in booking (D-A11) takes no notice either. A different slot:
  // the owner's own booking above now holds 10:00.
  const walkIn = await ownerOverrideBooking(db, "owner-1", { resource_id: "cold-plunge", start: crAt(TODAY, "10:20"), walk_in_name: "Walk-in" });
  assert.equal(walkIn.error, undefined);
});

test("a court has no minimum notice: a member books a slot an hour away", async () => {
  const s = await booker("m1");
  assert.equal((await book(s, "court-1", crAt(TODAY, "10:00"))).status, 201);
});

test("cancel: allowed up to exactly 24 h before the start, refused one second later, with the cutoff named", async () => {
  const s = await booker("m1");
  const made = await book(s, "court-1", crAt("2026-10-07", "10:00"));
  const id = made.data.booking.id;
  const cancel = () => callPortal(db, ENV, { method: "POST", path: `/api/portal/bookings/${id}/cancel`, session: s, body: {} });

  mock.timers.setTime(Date.parse(crAt("2026-10-07", "10:00")) - 24 * 3600000 + 1000); // 23 h 59 min 59 s before
  const inside = await cancel();
  assert.deepEqual([inside.status, inside.data.error, inside.data.cancel_cutoff_minutes], [409, "past_cutoff", 1440]);
  assert.equal(db.sqlite.prepare(`SELECT status FROM bookings WHERE id = ?`).get(id).status, "confirmed");

  mock.timers.setTime(Date.parse(crAt("2026-10-07", "10:00")) - 24 * 3600000); // exactly 24 h before
  const exact = await cancel();
  assert.equal(exact.status, 200, JSON.stringify(exact.data));
});

test("cancel: the owner may cancel inside 24 h", async () => {
  const s = await booker("m1");
  const o = await owner();
  const made = await book(s, "court-1", crAt(TODAY, "10:00"));
  const r = await callPortal(db, ENV, { method: "POST", path: `/api/portal/bookings/${made.data.booking.id}/cancel`, session: o, body: {} });
  assert.equal(r.status, 200);
});

test("massage is present but not bookable online: the booking API refuses it, and the resource list says so", async () => {
  const s = await booker("m1");
  const r = await book(s, "massage-samy", crAt("2026-10-08", "10:00"), { offering_id: "massage-60", party_size: 1 });
  assert.deepEqual([r.status, r.data.error], [409, "not_bookable_online"]);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n, 0);

  const q = await callPortal(db, ENV, { path: "/api/portal/resources/massage-samy/quote?offering_id=massage-60", session: s });
  assert.deepEqual([q.status, q.data.error], [409, "not_bookable_online"]);

  const list = await callPortal(db, ENV, { path: "/api/portal/resources", session: s });
  const active = Object.fromEntries(list.data.map((x) => [x.id, x.active]));
  assert.deepEqual(active, { "court-1": true, "court-2": true, "court-3": true, "court-4": true, "massage-samy": false, "cold-plunge": true });
  assert.deepEqual(list.data.find((x) => x.id === "massage-samy").offerings, []);
});

test("massage: the `active` column is the gate (switch an offering on and the refusal changes)", async () => {
  const s = await booker("m1");
  db.sqlite.prepare(`UPDATE offerings SET active = 1 WHERE id = 'massage-60'`).run();
  // Now past the gate: massage is paid, and Stripe is not configured here, so (PIN L4)
  // it is recorded to be paid at the club.
  const r = await book(s, "massage-samy", crAt("2026-10-08", "10:00"), { offering_id: "massage-60", party_size: 1 });
  assert.deepEqual([r.status, r.data.error, r.data.booking?.pay_at_club], [201, undefined, true]);
  // The 90 minute offering is still off: refused by name, not as a missing price.
  const still = await book(s, "massage-samy", crAt("2026-10-08", "10:00"), { offering_id: "massage-90", party_size: 1 });
  assert.deepEqual([still.status, still.data.error], [409, "not_bookable_online"]);
});

test("the resource list carries the rules the booking screen needs", async () => {
  const s = await booker("m1");
  const list = await callPortal(db, ENV, { path: "/api/portal/resources", session: s });
  const court = list.data.find((x) => x.id === "court-1");
  assert.deepEqual(
    { m: court.member_window_days, n: court.non_member_window_days, adv: court.min_advance_minutes, cancel: court.cancel_cutoff_minutes },
    { m: 60, n: 60, adv: 0, cancel: 1440 }
  );
  assert.equal(list.data.find((x) => x.id === "cold-plunge").min_advance_minutes, 1440);
});
