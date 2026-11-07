// C4-05 (inspection 4, ruling A6): the people at the desk see who owes money.
// A booking recorded as pay-at-the-club (L4: confirmed, paid for at the
// club, no Stripe payment on it) is marked on the owner's Today screen with
// the amount, and on the staff calendar with the marker alone, because the
// staff payload carries no price (D-A16). The amount is the one My Bookings
// already shows. Price-at-booking-time (C4-04) is deferred and not built.
//
// The API cases call the portal the way the Worker does, against a real
// SQLite database seeded from scripts/seed-prod.sql, with the clock fixed to
// Monday 2026-10-05 09:00 Costa Rica time.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso as crAt } from "./launch-helpers.mjs";
import { ownerOverrideBooking } from "../src/portal/owner.js";

const ENV = { OWNER_EMAILS: "roger@example.com" };
const DAY = "2026-10-08";

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
async function ownerSession() {
  addAccount(db, { id: "owner-1", email: "roger@example.com", role: "owner" });
  return sessionFor(db, "owner-1");
}
// Staff is assigned to Court 1 (CTL-STF-01: a staff calendar is that staff's own resource only).
async function staffSession() {
  addAccount(db, { id: "staff-1", email: "staff-1@example.com", role: "staff" });
  db.sqlite.prepare(`UPDATE resources SET staff_account_id = 'staff-1' WHERE id = 'court-1'`).run();
  return sessionFor(db, "staff-1");
}
const book = (session, resource_id, start, extra = {}) =>
  callPortal(db, ENV, { method: "POST", path: "/api/portal/bookings", session, body: { resource_id, start, party_size: 2, ...extra } });
const ownerToday = (session) => callPortal(db, ENV, { path: `/api/portal/owner/today?date=${DAY}`, session });
const staffDay = (session) => callPortal(db, ENV, { path: `/api/portal/staff/calendar?date=${DAY}`, session });

test("owner Today marks a pay-at-the-club booking with the amount the engine computed for it", async () => {
  const g = await guest("g1");
  const o = await ownerSession();
  const made = await book(g, "court-1", crAt(DAY, "08:30")); // 2 players x $15.00
  assert.equal(made.status, 201);
  assert.equal(made.data.booking.amount_cents, 3000);

  const today = await ownerToday(o);
  const item = today.data.items.find((i) => i.id === made.data.booking.id);
  assert.deepEqual([item.pay_at_club, item.amount_cents], [true, 3000]);

  // The same number My Bookings shows the guest, and the number the booking itself returned.
  const mine = await callPortal(db, ENV, { path: "/api/portal/bookings", session: g });
  assert.equal(mine.data.find((b) => b.id === made.data.booking.id).amount_cents, item.amount_cents);
});

test("owner Today marks nothing for a member's included booking, a walk-in, a paid booking or a payment hold", async () => {
  makeMember(db, "m1");
  const m = await sessionFor(db, "m1");
  const o = await ownerSession();
  const included = await book(m, "court-2", crAt(DAY, "08:30"));
  await ownerOverrideBooking(db, "owner-1", { resource_id: "court-3", start: crAt(DAY, "08:30"), walk_in_name: "Walk-in" });
  // A guest booking that a Stripe payment has settled: confirmed, 'pay', with a payment intent.
  addAccount(db, { id: "g2", email: "g2@example.com", role: "guest" });
  const insert = (id, resource, status, intent, hold) =>
    db.sqlite
      .prepare(`INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, status, payment_mode, payment_intent_id, hold_expires_at, created_by, created_at, updated_at) VALUES (?,'g2',?,?,?,?,2,?,'pay',?,?,'g2','x','x')`)
      .run(id, resource, `${resource}-session`, crAt(DAY, "10:00"), crAt(DAY, "11:30"), status, intent, hold);
  insert("paid", "court-4", "confirmed", "pi_123", null);
  insert("hold", "court-1", "pending_payment", null, "2026-10-05T16:00:00.000Z");

  const items = (await ownerToday(o)).data.items.filter((i) => i.state !== "blocked");
  assert.equal(items.length, 4);
  for (const i of items) assert.deepEqual([i.id, i.pay_at_club, i.amount_cents], [i.id, false, null]);
  assert.ok(items.some((i) => i.id === included.data.booking.id));
});

test("owner Today: a pay-at-the-club booking cancelled by the guest is no longer marked (it is no longer owed)", async () => {
  const g = await guest("g1");
  const o = await ownerSession();
  const made = await book(g, "court-1", crAt(DAY, "08:30"));
  await callPortal(db, ENV, { method: "POST", path: `/api/portal/bookings/${made.data.booking.id}/cancel`, session: g, body: {} });
  const items = (await ownerToday(o)).data.items;
  assert.equal(items.find((i) => i.id === made.data.booking.id), undefined);
});

test("staff calendar marks a pay-at-the-club booking with 'Pay at club' and carries no amount or other price field", async () => {
  const g = await guest("g1");
  makeMember(db, "m1");
  const m = await sessionFor(db, "m1");
  const s = await staffSession();
  const owed = await book(g, "court-1", crAt(DAY, "08:30"));
  const included = await book(m, "court-1", crAt(DAY, "10:00"));
  assert.equal(included.status, 201);

  const day = await staffDay(s);
  assert.equal(day.status, 200);
  const owedEvent = day.data.find((e) => e.start === crAt(DAY, "08:30"));
  const includedEvent = day.data.find((e) => e.start === crAt(DAY, "10:00"));
  assert.deepEqual(Object.keys(owedEvent).sort(), ["display_name", "end", "pay_at_club", "resource", "start", "state"]);
  assert.equal(owedEvent.pay_at_club, true);
  assert.deepEqual(Object.keys(includedEvent).sort(), ["display_name", "end", "resource", "start", "state"], "an included booking carries no marker");
  const text = JSON.stringify(day.data);
  for (const forbidden of ["amount", "price", "cents", "payment_intent", "email"]) assert.ok(!text.includes(forbidden), `staff body must not contain "${forbidden}"`);
  assert.equal(owed.status, 201);
});

// The screens. The API cases above prove what the server sends; these prove
// the two screens show it, in words with no dash.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("owner Today shows the marker and amount on the booking tile and on its sheet", () => {
  const view = read("portal/views/owner-today.html");
  const ownerJs = read("portal/js/owner.js");
  assert.match(view, /x-show="b\.pay_at_club"[^>]*x-text="t\('today\.pay_club', \{ ?amount: h\.fmtMoney\(b\.amount_cents\) ?\}\)"/);
  assert.match(view, /x-show="sheet\.pay_at_club"[^>]*x-text="t\('today\.pay_club', \{ ?amount: h\.fmtMoney\(sheet\.amount_cents\) ?\}\)"/);
  assert.ok(ownerJs.includes('"today.pay_club": "Pay at club: {amount}"'));
});

test("the staff calendar shows 'Pay at club' with no amount", () => {
  const view = read("portal/views/staff.html");
  const staffJs = read("portal/js/staff.js");
  assert.match(view, /x-show="r\.pay_at_club"[^>]*x-text="t\('staff\.pay_club'\)"/);
  assert.ok(staffJs.includes('"staff.pay_club": "Pay at club"'));
  assert.doesNotMatch(view, /amount_cents|fmtMoney|moneyFmt/);
});
