// The booking engine (CTL-BOOK-01): the ONLY module that inserts,
// updates or writes `bookings`, `credits`, `credits_ledger` or
// `calendar_outbox` rows for a booking's create/cancel/confirm. Every
// other path (owner override, imports, the Stripe webhook via
// amendment 6's exports) calls through the functions here rather than
// writing its own SQL (database doctrine).
//
// docs/portal/api.md §3 is the contract. D-A06/amendment 5 F-4 (holds),
// D-A13 (window), S-12 (grid), A2 (no double booking under any rule
// change), Amendment 4 (audience pricing), CTL-CRD-01 (credits),
// CTL-MSG-01 (massage pays only), PIN-13 (outbox same batch as the
// booking write).
//
// A2's overlap guard is one SQL idiom used everywhere a booking state
// changes: `INSERT ... SELECT ... WHERE NOT EXISTS (<conflicting row>)`
// or `UPDATE ... WHERE <still in the state we read>`. Each of these is a
// single statement, so there is no read-then-write gap for a second
// request to land in -- the SQLite engine (D1) serialises the
// statement's own execution. No UNIQUE index or occupancy-cells table
// is added here: migrations are not this part's file, and this
// predicate-guarded INSERT is sufficient and provably serial per
// statement (R-6).

import { json, notConfigured } from "./http.js";
import { newId, nowIso, runBatch } from "./db.js";
import { resolveAudience, resolveEntitlement, audienceFor } from "./entitlement.js";
import { isStripeConfigured, createBookingCheckout } from "./stripe.js";
import {
  crDateStringFromUtc,
  crTimeStringFromUtcIso,
  crDateTimeToUtcIso,
  addDaysToDateString,
  isValidDateString,
  hhmmToMinutes,
  minutesToHHMM,
} from "./cr-time.js";
import { resourceForDate } from "./day-hours.js";

const HOLD_EXTRA_MINUTES = 2; // amendment 5 F-4: hold_expires_at = checkout expires_at + 2 min
const CHECKOUT_MINUTES = 31; // amendment 5 F-4: checkout expires_at = now + 31 min
const MAX_SLOTS_PER_DAY = 288; // CTL-RES-01's grid-generator cap

// PIN L3 as amended by A6 (2026-10-04, ruling on inspection C4-01): Roger's
// "no limit on court bookings" is for members only. A guest, meaning an
// account with no active membership (resolveEntitlement says not entitled),
// holds at most this many upcoming court bookings across all courts. Members,
// the owner and staff are not held to it. Plunge and massage keep the
// per-resource cap on their own resource row.
const GUEST_MAX_UPCOMING_COURT_BOOKINGS = 2;
const GUEST_CAP_MESSAGE = `Guests can hold up to ${GUEST_MAX_UPCOMING_COURT_BOOKINGS} upcoming court bookings. Become a member for unlimited booking, or ask at the club.`;

// The ONE definition of a "live" booking: one that occupies its court right
// now. It is confirmed, or it is a payment hold that has not run out (a hold
// with no expiry is still a hold). Every query in this file that asks "is
// this slot taken?" or "how many bookings does this account hold?" builds
// its WHERE from this function, and so does the reader day-hours.js calls
// (countLiveBookingsEndingAfter), so the rule cannot drift between them.
// The returned text holds one `?`: bind the current time there. `alias`
// names the table when the query joins bookings to itself.
function liveBookingSql(alias = "") {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  return `(${col("status")} = 'confirmed' OR (${col("status")} = 'pending_payment' AND (${col("hold_expires_at")} IS NULL OR ${col("hold_expires_at")} > ?)))`;
}

function weekdayOfCrDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sunday, matches blocks.weekday
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// D-A14/S-12: slot starts at `open`, repeats by `slot + buffer`, must
// end <= `close`. Returns UTC start/end for each slot on the given CR
// calendar date.
export function generateGridForDate(resource, crDateStr) {
  const openMin = hhmmToMinutes(resource.open_time);
  const closeMin = hhmmToMinutes(resource.close_time);
  const step = resource.slot_minutes + resource.buffer_minutes;
  const slots = [];
  for (let t = openMin; t + resource.slot_minutes <= closeMin && slots.length < MAX_SLOTS_PER_DAY; t += step) {
    slots.push({
      start: crDateTimeToUtcIso(crDateStr, minutesToHHMM(t)),
      end: crDateTimeToUtcIso(crDateStr, minutesToHHMM(t + resource.slot_minutes)),
    });
  }
  return slots;
}

// F-03: the one place a request's start (or end) instant is read. Only the
// exact shape the portal's own slots carry is accepted: YYYY-MM-DDTHH:MM:SS
// with optional milliseconds, then Z. new Date() alone also takes
// ECMAScript expanded years ("+010000-...", "-000001-..."), numeric offsets
// and loose forms; an expanded-year string sorts before "2026-..." in the
// string compares of the 60-day window and the guest cap, and so slipped
// past both. Returns a Date, or null for anything else (including a date
// that does not exist, such as 2026-02-30). The caller answers 400 with its
// own error code. createBooking and ownerOverrideBooking both use this;
// nothing else in src/portal may parse a request's start.
const INSTANT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export function parseInstantUtc(raw) {
  if (typeof raw !== "string" || !INSTANT_UTC.test(raw)) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  // Date rolls 2026-02-30 over to March 2 and reads 24:00 as the next day;
  // the text must name the same date and time it parsed to.
  if (date.toISOString().slice(0, 19) !== raw.slice(0, 19)) return null;
  return date;
}

// D-A14/S-12: the one grid/hours check every booking writer uses --
// createBooking below AND the owner override (owner.js's
// ownerOverrideBooking) import this rather than keep a second copy
// (database doctrine). D-A11 bypasses window/entitlement/payment, never
// grid or hours, so this applies to both callers with no owner/staff
// exemption. Returns the exact 400 error code to use, or null when the
// start is on-grid and the whole booking fits inside opening hours.
export function gridAndHoursError(resource, startIso, endIso) {
  const startMin = hhmmToMinutes(crTimeStringFromUtcIso(startIso));
  const openMin = hhmmToMinutes(resource.open_time);
  const closeMin = hhmmToMinutes(resource.close_time);
  if (startMin < openMin || startMin >= closeMin) return "outside_hours";
  const step = resource.slot_minutes + resource.buffer_minutes;
  if ((startMin - openMin) % step !== 0) return "off_grid";
  const durationMin = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
  if (startMin + durationMin > closeMin) return "outside_hours";
  return null;
}

// D-A13: a slot is bookable when its CR calendar date <= today(CR) +
// window days. Owner/staff have no window (checked by the caller).
export function withinWindow(resource, crDateStr, entitled) {
  const windowDays = entitled ? resource.member_window_days : resource.non_member_window_days;
  const today = crDateStringFromUtc(new Date());
  return crDateStr <= addDaysToDateString(today, windowDays);
}

// PIN L3: Cold Plunge may only be booked at least `min_advance_minutes`
// ahead (24 h). Exactly 24 h ahead is allowed ("at least"). Owner and
// staff are exempt, as they are from the window (D-A11); the caller
// decides who is exempt.
export function tooSoon(resource, startMs, nowMs) {
  return resource.min_advance_minutes > 0 && startMs - nowMs < resource.min_advance_minutes * 60000;
}

// The 409 error code when the audience resolver says an offering cannot
// be sold. A missing price is "price_not_set" (the owner can fix it); an
// offering that is switched off or does not exist is not bookable online
// at all (PIN L3: massage stays off until Roger gives Samy's hours).
function notBookableCode(audience) {
  return audience.reason === "price_not_set" ? "price_not_set" : "not_bookable_online";
}

function clampPartySize(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 4);
}

function resolveDuration(resource, offerings, offeringId) {
  if (offeringId) {
    const found = offerings.find((o) => o.id === offeringId);
    if (found) return found.duration_minutes;
  }
  return resource.slot_minutes;
}

// Mirrors the column shape of outbox.js's own `outboxInsertStatement`
// (B1, the designated owner of the outbox row's shape) but adds a
// WHERE EXISTS guard so it is safe to put in the SAME batch as a
// booking write whose own WHERE NOT EXISTS clause may have matched zero
// rows (A2's conflict case): that guard keeps a routine 409 a quiet
// zero-row INSERT instead of a thrown FK violation. outbox.js's helper
// is unconditional by design (flagged as a finding, not edited here --
// outbox.js is not this part's file).
export function guardedOutboxInsertStatement(db, { bookingId, action, resourceId, payload, requireStatus }) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO calendar_outbox (id, booking_id, action, resource_id, payload, status, attempts, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?
       WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = ?)`
    )
    .bind(newId(), bookingId, action, resourceId, JSON.stringify(payload || {}), now, now, bookingId, requireStatus);
}

// CTL-BOOK-01: the ONE place the overlap-guarded `bookings` INSERT is
// written. Every writer of a booking row -- this file's own
// createBooking below, and the owner override in owner.js -- builds its
// insert through this function rather than keeping its own copy of the
// SQL (database doctrine: one writer, named once). It returns an
// unexecuted, bound statement (never runs it itself) so each caller can
// fold it into its OWN batch() alongside whatever else must commit
// atomically with it (member creation needs credits/outbox rows in the
// same batch; the owner override needs its audit row) -- CTL-BOOK-01's
// "one writer" is about the SQL, not about which other rows ride along
// in the same transaction.
//
// A2's one-statement guard: the row is only inserted when nothing live
// occupies an overlapping time range AND (for a credit spend) the
// balance covers it -- both checked inside the same WHERE as the INSERT,
// so a concurrent twin of this exact call can produce at most one
// surviving row between them. `requiredCredits` is 0 for every caller
// that does not spend credits (owner override, included, massage/plunge
// pay), so the balance check is then trivially satisfied.
//
// `guestCourtCap` (C4-01) is null for everyone but a guest booking a court.
// For that one caller it adds a third condition to the same WHERE: the
// account holds fewer than that many upcoming court bookings. Two requests
// that both saw "one held" cannot both insert, for the same reason two
// requests for one slot cannot.
export function insertBookingAtomic(
  db,
  { accountId, resourceId, offeringId = null, startIso, endIso, partySize, freeKids = 0, status, paymentMode, holdExpiresAt = null, creditsSpent = 0, walkInName = null, createdBy, createdAt = nowIso(), requiredCredits = 0, guestCourtCap = null }
) {
  const id = newId();
  const capGuard = guestCourtCap == null ? "" : `AND (${upcomingCourtBookingsSql()}) < ?`;
  const capBinds = guestCourtCap == null ? [] : [accountId, createdAt, createdAt, guestCourtCap];
  const stmt = db
    .prepare(
      `INSERT INTO bookings (
         id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids,
         status, payment_mode, hold_expires_at, credits_spent, checkout_session_id, payment_intent_id,
         walk_in_name, block_weekly_id, created_by, created_at, updated_at
       )
       SELECT ?,?,?,?,?,?,?,?, ?,?,?,?,NULL,NULL, ?,NULL, ?,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings
         WHERE resource_id = ? AND start_at < ? AND end_at > ?
           AND ${liveBookingSql()}
       )
       AND COALESCE((SELECT balance FROM credits WHERE account_id = ?), 0) >= ?
       ${capGuard}
       RETURNING *`
    )
    .bind(
      id, accountId, resourceId, offeringId, startIso, endIso, partySize, freeKids,
      status, paymentMode, holdExpiresAt, creditsSpent,
      walkInName, createdBy, createdAt, createdAt,
      resourceId, endIso, startIso, createdAt,
      accountId, requiredCredits,
      ...capBinds
    );
  return { id, statement: stmt };
}

function creditReturnStatements(db, { bookingId, accountId, amount, cancelledAt }) {
  return [
    db
      .prepare(
        `INSERT INTO credits_ledger (id, account_id, delta, reason, booking_id, created_at)
         SELECT ?, ?, ?, 'cancel_return', ?, ?
         WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND cancelled_at = ?)`
      )
      .bind(newId(), accountId, amount, bookingId, cancelledAt, bookingId, cancelledAt),
    db
      .prepare(
        `UPDATE credits SET balance = balance + ?, updated_at = ?
         WHERE account_id = ? AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND cancelled_at = ?)`
      )
      .bind(amount, cancelledAt, accountId, bookingId, cancelledAt),
  ];
}

async function isBlockedSlot(db, resourceId, crDateStr, startHHMM, endHHMM) {
  const weekday = weekdayOfCrDate(crDateStr);
  const rows =
    (
      await db
        .prepare(
          `SELECT * FROM blocks WHERE resource_id = ? AND ((kind = 'one_off' AND date = ?) OR (kind = 'weekly' AND weekday = ?))`
        )
        .bind(resourceId, crDateStr, weekday)
        .all()
    ).results || [];
  return rows.find((b) => hhmmToMinutes(startHHMM) < hhmmToMinutes(b.end_time) && hhmmToMinutes(b.start_time) < hhmmToMinutes(endHHMM)) || null;
}

// The guest cap's count, written once: this account's live court bookings
// that start after now. Three `?`: the account id, then now twice (the
// "upcoming" test and the live rule). Used inside the booking INSERT's own
// guard (insertBookingAtomic) and by countUpcomingCourtBookings below.
function upcomingCourtBookingsSql() {
  return `SELECT COUNT(*) FROM bookings gb JOIN resources gr ON gr.id = gb.resource_id
          WHERE gb.account_id = ? AND gr.kind = 'court' AND gb.start_at > ? AND ${liveBookingSql("gb")}`;
}

// READER: how many upcoming court bookings this account holds (the early,
// friendly check, and the reason given when the INSERT's guard refuses).
async function countUpcomingCourtBookings(db, accountId, nowIsoVal) {
  const row = await db.prepare(`SELECT (${upcomingCourtBookingsSql()}) AS n`).bind(accountId, nowIsoVal, nowIsoVal).first();
  return row ? row.n : 0;
}

function guestCapReached() {
  return json({ error: "guest_cap_reached", message: GUEST_CAP_MESSAGE, max_upcoming_court_bookings: GUEST_MAX_UPCOMING_COURT_BOOKINGS }, 409);
}

// READER: how many live bookings on one resource start in
// [startFromIso, startBeforeIso) and end after endAfterIso. The owner's
// late-hours count (day-hours.js) is this question, asked for one Costa
// Rica day against that day's closing time. It lives here, next to the
// engine's own live rule, because bookings belong to this module.
export async function countLiveBookingsEndingAfter(db, resourceId, startFromIso, startBeforeIso, endAfterIso, nowIsoVal = nowIso()) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE resource_id = ? AND start_at >= ? AND start_at < ? AND end_at > ? AND ${liveBookingSql()}`)
    .bind(resourceId, startFromIso, startBeforeIso, endAfterIso, nowIsoVal)
    .first();
  return row ? row.n : 0;
}

// ---------------------------------------------------------------------
// §3 GET /api/portal/resources
// ---------------------------------------------------------------------
// What one caller is shown for one resource, from the same decision the
// quote and the booking make (audienceFor): whether it is included for them,
// and which of its offerings apply to them. A guest is never shown a member
// offering, and never an "Included" that the confirm step will not honour.
function resourceViewForCaller(entitlement, resource, offerings) {
  if (resource.kind === "massage") {
    const applies = offerings.filter((o) => audienceFor(entitlement, resource, offerings, o.id).mode === "pay").map((o) => o.id);
    return { included: false, applies };
  }
  const audience = audienceFor(entitlement, resource, offerings);
  return { included: audience.mode === "included", applies: audience.offering_id ? [audience.offering_id] : [] };
}

export async function listResources(request, env, db, account) {
  const resources = (await db.prepare(`SELECT * FROM resources ORDER BY kind, name`).all()).results || [];
  const offeringRows = (await db.prepare(`SELECT * FROM offerings WHERE active = 1 ORDER BY resource_id, duration_minutes`).all()).results || [];
  const entitlement = await resolveEntitlement(db, account.id);
  return json(
    resources.map((r) => {
      const offerings = offeringRows.filter((o) => o.resource_id === r.id);
      const forYou = resourceViewForCaller(entitlement, r, offerings);
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        open_time: r.open_time,
        close_time: r.close_time,
        slot_minutes: r.slot_minutes,
        buffer_minutes: r.buffer_minutes,
        member_included: Boolean(r.member_included),
        // What THIS caller pays: true when the booking is included for them
        // (a member's court, an annual member's plunge). member_included
        // above is the resource's setting for members and says nothing
        // about a guest.
        included_for_you: forYou.included,
        // PIN L3: how far ahead each kind of booker may book, the minimum
        // notice, and whether anything on this resource can be booked online
        // at all (a resource with no active offering is shown to nobody).
        member_window_days: r.member_window_days,
        non_member_window_days: r.non_member_window_days,
        min_advance_minutes: r.min_advance_minutes,
        cancel_cutoff_minutes: r.cancel_cutoff_minutes,
        active: offerings.length > 0,
        offerings: offerings.map((o) => ({
          id: o.id,
          name: o.name,
          duration_minutes: o.duration_minutes,
          audience: o.audience,
          display_price_cents: o.display_price_cents,
          applies_to_you: forYou.applies.includes(o.id),
        })),
      };
    })
  );
}

// ---------------------------------------------------------------------
// §3 GET /api/portal/resources/:id/availability?date=
// ---------------------------------------------------------------------
export async function availability(request, env, db, url, session, account, params) {
  const resourceId = params.id;
  const dateStr = url.searchParams.get("date");
  if (!isValidDateString(dateStr)) return json({ error: "bad_date" }, 400);

  const resource = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!resource) return json({ error: "not_found" }, 404);

  // The owner may have extended this day's close (PIN L3); the grid is
  // built from the day's real hours.
  const grid = generateGridForDate(await resourceForDate(db, resource, dateStr), dateStr);
  if (grid.length === 0) return json({ slots: [] });

  const nowIsoVal = nowIso();
  const mustGiveNotice = account.role !== "owner" && account.role !== "staff";
  const dayStartUtc = grid[0].start;
  const dayEndUtc = grid[grid.length - 1].end;
  const liveBookings =
    (
      await db
        .prepare(
          `SELECT * FROM bookings WHERE resource_id = ? AND start_at < ? AND end_at > ?
             AND ${liveBookingSql()}`
        )
        .bind(resourceId, dayEndUtc, dayStartUtc, nowIsoVal)
        .all()
    ).results || [];

  const weekday = weekdayOfCrDate(dateStr);
  const blockRows =
    (
      await db
        .prepare(`SELECT * FROM blocks WHERE resource_id = ? AND ((kind = 'one_off' AND date = ?) OR (kind = 'weekly' AND weekday = ?))`)
        .bind(resourceId, dateStr, weekday)
        .all()
    ).results || [];

  const slots = grid.map((slot) => {
    if (slot.start <= nowIsoVal) return { start: slot.start, end: slot.end, state: "past" };

    const block = blockRows.find((b) => rangesOverlap(slot.start, slot.end, crDateTimeToUtcIso(dateStr, b.start_time), crDateTimeToUtcIso(dateStr, b.end_time)));
    if (block) {
      const out = { start: slot.start, end: slot.end, state: "blocked" };
      if (block.label) out.label = block.label;
      return out;
    }

    const overlapping = liveBookings.filter((b) => rangesOverlap(slot.start, slot.end, b.start_at, b.end_at));
    if (overlapping.find((b) => b.account_id === account.id && b.status === "confirmed")) return { start: slot.start, end: slot.end, state: "mine" };
    if (overlapping.find((b) => b.account_id === account.id && b.status === "pending_payment")) return { start: slot.start, end: slot.end, state: "held_mine" };
    if (overlapping.find((b) => b.status === "confirmed")) return { start: slot.start, end: slot.end, state: "taken" };
    if (overlapping.find((b) => b.status === "pending_payment")) return { start: slot.start, end: slot.end, state: "held" };
    if (mustGiveNotice && tooSoon(resource, Date.parse(slot.start), Date.now())) return { start: slot.start, end: slot.end, state: "too_soon" };
    return { start: slot.start, end: slot.end, state: "available" };
  });

  return json({ slots });
}

// ---------------------------------------------------------------------
// §3 GET /api/portal/resources/:id/quote
// ---------------------------------------------------------------------
export async function quote(request, env, db, url, session, account, params) {
  const resourceId = params.id;
  const resource = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!resource) return json({ error: "not_found" }, 404);

  const offeringId = url.searchParams.get("offering_id") || null;
  const partySize = resource.price_mode === "per_player" ? clampPartySize(url.searchParams.get("party_size")) : 1;

  const offerings = (await db.prepare(`SELECT * FROM offerings WHERE resource_id = ?`).bind(resourceId).all()).results || [];
  if (!offerings.some((o) => o.active)) return json({ error: "not_bookable_online" }, 409);
  const audience = await resolveAudience(db, account.id, resource, offerings, offeringId);
  if (audience.mode === "not_bookable") return json({ error: notBookableCode(audience) }, 409);

  const unitCents = audience.unit_cents || 0;
  const totalCents = bookingTotalCents(resource, audience, partySize);
  const creditsRow = await db.prepare(`SELECT balance FROM credits WHERE account_id = ?`).bind(account.id).first();
  const creditsHave = creditsRow ? creditsRow.balance : 0;
  const creditsNeeded = resource.kind === "court" && audience.mode === "pay" ? partySize : 0;
  // L4: with Stripe off, a paid booking is recorded unpaid, to pay at the
  // club. Credits still win when they cover a court (createBooking's own
  // default), so they are not "pay at the club".
  const creditsCover = creditsNeeded > 0 && creditsHave >= partySize;
  const payAtClub = audience.mode === "pay" && !creditsCover && !isStripeConfigured(env);

  return json({
    mode: audience.mode,
    unit_cents: unitCents,
    party_size: partySize,
    total_cents: totalCents,
    credits_needed: creditsNeeded,
    credits_have: creditsHave,
    pay_at_club: payAtClub,
    cancel_cutoff_minutes: resource.cancel_cutoff_minutes,
  });
}

// What a booking costs: nothing when the membership includes it, the unit
// price per player for a per-player resource, the unit price otherwise.
// The one place this is computed; the quote and the booking both call it.
function bookingTotalCents(resource, audience, partySize) {
  if (audience.mode === "included") return 0;
  const unitCents = audience.unit_cents || 0;
  return resource.price_mode === "per_player" ? unitCents * partySize : unitCents;
}

// ---------------------------------------------------------------------
// §3 POST /api/portal/bookings
//
// L4 (replaces S-11's 503): with Stripe off, a paid booking is written
// confirmed and unpaid ("pay at the club") with the amount in the reply.
// No hold, no checkout, never a 503. With Stripe on, the paid path inserts
// a pending_payment hold and returns the Checkout URL, as before.
// CTL-CRD-01: credit sufficiency is part of the SAME atomic INSERT
// guard as the overlap check, so "not enough credits" and "slot taken"
// can never race each other into a bad state; the booking simply does
// not get created and nothing is written (REQ-ENT-14 amended, F-11).
// ---------------------------------------------------------------------
export async function createBooking(request, env, db, url, session, account) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const resourceId = body && body.resource_id;
  const offeringId = (body && body.offering_id) || null;
  const startRaw = body && body.start;
  const freeKids = Math.max(0, Number.parseInt((body && body.free_kids) || 0, 10) || 0);
  // Appended clarification (not a shape change -- an additional optional
  // field): the UI (M2d) lets a guest with enough credits choose card
  // instead of the default credit spend. Omitted -> defaults to credits
  // when the balance covers it, else card. Logged in api.md's changelog.
  const paymentChoice = body && body.payment_choice === "card" ? "card" : body && body.payment_choice === "credits" ? "credits" : null;

  if (!resourceId || typeof startRaw !== "string") return json({ error: "invalid_request" }, 400);
  const startDate = parseInstantUtc(startRaw);
  if (!startDate) return json({ error: "invalid_request" }, 400);

  const resource = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!resource) return json({ error: "not_found" }, 404);

  const partySize = resource.price_mode === "per_player" ? clampPartySize(body && body.party_size) : 1;

  const nowDate = new Date();
  const nowIsoVal = nowDate.toISOString();
  if (startDate.getTime() <= nowDate.getTime()) return json({ error: "in_past" }, 409);

  const offerings = (await db.prepare(`SELECT * FROM offerings WHERE resource_id = ?`).bind(resourceId).all()).results || [];
  // PIN L3: a resource none of whose offerings is active (massage, until
  // Roger gives Samy's hours) cannot be booked online by anyone.
  if (!offerings.some((o) => o.active)) return json({ error: "not_bookable_online" }, 409);
  const audience = await resolveAudience(db, account.id, resource, offerings, offeringId, nowIsoVal);
  if (audience.mode === "not_bookable") return json({ error: notBookableCode(audience) }, 409);

  const durationMinutes = resolveDuration(resource, offerings, audience.offering_id || offeringId);
  const startIso = startDate.toISOString();
  const endIso = new Date(startDate.getTime() + durationMinutes * 60000).toISOString();
  const crDateStr = crDateStringFromUtc(startDate);

  // S-12/D-A14: off the grid, before/after hours, or ending past close.
  // Checked for every caller, including staff/owner self-booking --
  // D-A11's exemption (window/entitlement/payment) never covers this.
  // The hours are the day's real hours: the owner may have extended
  // this date to 21:00 (PIN L3), and a slot ending after the normal
  // close is bookable only on such a day.
  const hoursToday = await resourceForDate(db, resource, crDateStr);
  const gridError = gridAndHoursError(hoursToday, startIso, endIso);
  if (gridError) return json({ error: gridError }, 400);

  // D-A13: owner/staff have no window or minimum notice; member/guest do.
  const isOwnerOrStaff = account.role === "owner" || account.role === "staff";
  let entitlement = null;
  if (!isOwnerOrStaff) {
    entitlement = await resolveEntitlement(db, account.id, nowIsoVal);
    if (!withinWindow(resource, crDateStr, entitlement.entitled)) return json({ error: "outside_window" }, 409);
    if (tooSoon(resource, startDate.getTime(), nowDate.getTime())) {
      return json({ error: "too_soon", min_advance_minutes: resource.min_advance_minutes }, 409);
    }
  }

  const startHHMM = crTimeStringFromUtcIso(startIso);
  const endHHMM = crTimeStringFromUtcIso(endIso);
  const block = await isBlockedSlot(db, resourceId, crDateStr, startHHMM, endHHMM);
  if (block) return json({ error: "blocked" }, 409);

  if (resource.max_active_per_account != null) {
    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings WHERE account_id = ? AND resource_id = ?
           AND ${liveBookingSql()}`
      )
      .bind(account.id, resourceId, nowIsoVal)
      .first();
    if (countRow && countRow.n >= resource.max_active_per_account) return json({ error: "cap_reached" }, 409);
  }

  // C4-01: a guest (not entitled) is held to the guest cap on courts. The
  // early check gives the plain refusal; the INSERT's own guard (below)
  // keeps two simultaneous requests from both getting through it.
  const guestCourtCap = resource.kind === "court" && entitlement && !entitlement.entitled ? GUEST_MAX_UPCOMING_COURT_BOOKINGS : null;
  if (guestCourtCap != null && (await countUpcomingCourtBookings(db, account.id, nowIsoVal)) >= guestCourtCap) return guestCapReached();

  let paymentMode;
  let payAtClub = false;
  let creditsSpent = 0;
  if (audience.mode === "included") {
    paymentMode = "included";
  } else {
    // audience.mode === "pay"
    const creditsEligible = resource.kind === "court";
    let useCredits = false;
    if (creditsEligible) {
      const creditsRow = await db.prepare(`SELECT balance FROM credits WHERE account_id = ?`).bind(account.id).first();
      const have = creditsRow ? creditsRow.balance : 0;
      if (paymentChoice === "credits") {
        if (have < partySize) return json({ error: "insufficient_credits" }, 409);
        useCredits = true;
      } else if (paymentChoice === null && have >= partySize) {
        useCredits = true; // M2d's default radio choice
      }
    }
    if (useCredits) {
      paymentMode = "credits";
      creditsSpent = partySize;
    } else {
      paymentMode = "pay";
      payAtClub = !isStripeConfigured(env); // L4
    }
  }

  // A card payment needs a Checkout session and a hold on the slot until it
  // is paid. A pay-at-club booking needs neither: it is confirmed now.
  const needsCheckout = paymentMode === "pay" && !payAtClub;
  const createdAt = nowIsoVal;
  const holdExpiresAt = needsCheckout ? new Date(nowDate.getTime() + (CHECKOUT_MINUTES + HOLD_EXTRA_MINUTES) * 60000).toISOString() : null;
  const status = needsCheckout ? "pending_payment" : "confirmed";
  const requiredCredits = paymentMode === "credits" ? partySize : 0;

  // CTL-BOOK-01: the shared, overlap-guarded insert (see insertBookingAtomic
  // above) -- this is the only place a booking row is written, by self or
  // by the owner override (src/portal/owner.js).
  const { id, statement: insertStmt } = insertBookingAtomic(db, {
    accountId: account.id,
    resourceId,
    offeringId: audience.offering_id || offeringId || null,
    startIso,
    endIso,
    partySize,
    freeKids,
    status,
    paymentMode,
    holdExpiresAt,
    creditsSpent,
    createdBy: account.id,
    createdAt,
    requiredCredits,
    guestCourtCap,
  });

  let row;
  if (needsCheckout) {
    row = (await insertStmt.first()) || null;
  } else {
    const extra = [];
    if (paymentMode === "credits") extra.push(...creditReturnStatementsForSpend(db, { bookingId: id, accountId: account.id, amount: creditsSpent, createdAt }));
    extra.push(guardedOutboxInsertStatement(db, { bookingId: id, action: "create", resourceId, payload: { booking_id: id }, requireStatus: "confirmed" }));
    const results = await runBatch(db, [insertStmt, ...extra]);
    row = (results[0].results || [])[0] || null;
  }

  if (!row) {
    // The guard may have refused it: a twin request took the guest's last place.
    if (guestCourtCap != null && (await countUpcomingCourtBookings(db, account.id, nowIsoVal)) >= guestCourtCap) return guestCapReached();
    if (paymentMode === "credits") {
      const creditsRow = await db.prepare(`SELECT balance FROM credits WHERE account_id = ?`).bind(account.id).first();
      const have = creditsRow ? creditsRow.balance : 0;
      if (have < partySize) return json({ error: "insufficient_credits" }, 409);
    }
    return json({ error: "slot_taken" }, 409);
  }

  if (needsCheckout) {
    const quantity = resource.price_mode === "per_player" ? partySize : 1;
    let checkout;
    try {
      checkout = await createBookingCheckout(env, {
        account,
        bookingId: id,
        // CTL-STR-02: the offering's display mirror travels with the
        // request so stripe.js can refuse a live Price that no longer
        // matches what the portal showed, instead of charging whatever
        // Stripe currently has on file.
        lineItems: [{ lookup_key: audience.lookup_key, quantity, expected_unit_cents: audience.unit_cents }],
        expiresAt: Math.floor(nowDate.getTime() / 1000) + CHECKOUT_MINUTES * 60,
        successUrl: `${url.origin}/portal/#/bookings/${id}?paid=1`,
        cancelUrl: `${url.origin}/portal/#/bookings/${id}?cancelled=1`,
      });
    } catch (err) {
      // Can't offer a checkout: release the hold we just created rather
      // than leave a phantom hold on a slot nobody can pay for.
      await db
        .prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, note = 'checkout_create_failed' WHERE id = ? AND status = 'pending_payment'`)
        .bind(nowIsoVal, id)
        .run();
      if (err && err.code === "not_configured") return notConfigured("stripe");
      // CTL-STR-02: a mismatch is reported as the named 409, hold already
      // released above -- never the generic 500 a rethrow would produce.
      if (err && err.code === "price_mismatch") return json({ error: "price_mismatch" }, 409);
      throw err;
    }
    await db.prepare(`UPDATE bookings SET checkout_session_id = ? WHERE id = ?`).bind(checkout.sessionId, id).run();
    return json({ booking: { id, status: row.status, payment_mode: paymentMode, hold_expires_at: holdExpiresAt, checkout_url: checkout.url } }, 201);
  }

  if (payAtClub) {
    return json({ booking: { id, status: row.status, payment_mode: paymentMode, pay_at_club: true, amount_cents: bookingTotalCents(resource, audience, partySize) } }, 201);
  }
  return json({ booking: { id, status: row.status, payment_mode: paymentMode } }, 201);
}

// create()'s own name for creditReturnStatements, spending instead of
// returning -- same shape, opposite sign, so it is written once and
// bound at each call site with its own sign and reason.
function creditReturnStatementsForSpend(db, { bookingId, accountId, amount, createdAt }) {
  return [
    db
      .prepare(
        `INSERT INTO credits_ledger (id, account_id, delta, reason, booking_id, created_at)
         SELECT ?, ?, ?, 'booking_spend', ?, ?
         WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'confirmed')`
      )
      .bind(newId(), accountId, -amount, bookingId, createdAt, bookingId),
    db
      .prepare(
        `UPDATE credits SET balance = balance - ?, updated_at = ?
         WHERE account_id = ? AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'confirmed')`
      )
      .bind(amount, createdAt, accountId, bookingId),
  ];
}

// ---------------------------------------------------------------------
// §3 POST /api/portal/bookings/:id/cancel
// D-A08: self-cancel before `cancel_cutoff_minutes`; owner any time.
// Credits spent are returned on an in-time cancel, in the SAME batch as
// the cancel itself (CTL-CRD-01), never as a second separate write.
// ---------------------------------------------------------------------
export async function cancelBooking(request, env, db, url, session, account, params) {
  const bookingId = params.id;
  const booking = await db.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return json({ error: "not_found" }, 404);
  if (booking.account_id !== account.id && account.role !== "owner") return json({ error: "not_found" }, 404);
  if (booking.status !== "confirmed" && booking.status !== "pending_payment") return json({ error: "not_found" }, 404);

  const nowDate = new Date();
  const nowIsoVal = nowDate.toISOString();

  if (booking.status === "confirmed" && account.role !== "owner") {
    const resource = await db.prepare(`SELECT cancel_cutoff_minutes FROM resources WHERE id = ?`).bind(booking.resource_id).first();
    const cutoffMinutes = resource ? resource.cancel_cutoff_minutes : 0;
    const cutoffMs = new Date(booking.start_at).getTime() - cutoffMinutes * 60000;
    if (nowDate.getTime() > cutoffMs) return json({ error: "past_cutoff", cancel_cutoff_minutes: cutoffMinutes }, 409);
  }

  const cancelledAt = nowIsoVal;
  const statements = [
    // M19/CTL-REF-01: a paid, confirmed booking's refund is recorded as
    // `due` in the SAME statement as the cancel itself -- never a
    // second write -- so owner Today/the refunds-due list sees it the
    // instant the cancel commits. A booking that was never paid (or
    // never confirmed) leaves refund_state untouched.
    db
      .prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ?,
           refund_state = CASE WHEN status = 'confirmed' AND payment_mode = 'pay' AND payment_intent_id IS NOT NULL THEN 'due' ELSE refund_state END
           WHERE id = ? AND status IN ('confirmed', 'pending_payment')
           RETURNING *`
      )
      .bind(cancelledAt, account.id, cancelledAt, bookingId),
  ];

  const creditsReturned = booking.payment_mode === "credits" && booking.credits_spent > 0 ? booking.credits_spent : 0;
  if (creditsReturned > 0) {
    statements.push(...creditReturnStatements(db, { bookingId, accountId: booking.account_id, amount: creditsReturned, cancelledAt }));
  }
  if (booking.status === "confirmed") {
    statements.push(
      guardedOutboxInsertStatement(db, { bookingId, action: "cancel", resourceId: booking.resource_id, payload: { booking_id: bookingId }, requireStatus: "cancelled" })
    );
  }

  const results = await runBatch(db, statements);
  const updatedRows = results[0].results || [];
  if (updatedRows.length === 0) return json({ error: "not_found" }, 404);

  return json({ ok: true, credits_returned: creditsReturned });
}

// ---------------------------------------------------------------------
// §3 GET /api/portal/bookings
// ---------------------------------------------------------------------
export async function listMyBookings(request, env, db, url, session, account) {
  const rows =
    (
      await db
        .prepare(
          `SELECT b.id, r.name AS resource_name, r.price_mode, b.start_at, b.end_at, b.status, b.payment_mode, b.party_size,
                  b.payment_intent_id, o.display_price_cents
             FROM bookings b JOIN resources r ON r.id = b.resource_id
             LEFT JOIN offerings o ON o.id = b.offering_id
             WHERE b.account_id = ? ORDER BY b.start_at DESC`
        )
        .bind(account.id)
        .all()
    ).results || [];
  // portal(FR1), api.md §3 appendix finding: `party_size` was missing,
  // though M1's "{players} players" line and M2d's per-player cost line
  // on an existing booking both need it (member.js already reads
  // `b.party_size` defensively -- this just fills the gap it names).
  return json(rows.map(bookingListEntry));
}

// L4: a booking confirmed with payment_mode 'pay' and no Stripe payment on
// it is a pay-at-club booking (a paid one always carries its payment
// intent). The one definition, used by My Bookings, the owner's Today
// screen and the staff calendar so all three mark the same bookings.
export function isPayAtClub(row) {
  return row.status === "confirmed" && row.payment_mode === "pay" && !row.payment_intent_id;
}

// What a pay-at-club booking owes: the offering's price now (C4-04: the
// price at booking time is deferred to the payments-on gate), times the
// players for a per-player resource. The row must carry display_price_cents
// (from the offering), price_mode (from the resource) and party_size.
export function payAtClubAmountCents(row) {
  return (row.display_price_cents || 0) * (row.price_mode === "per_player" ? row.party_size : 1);
}

function bookingListEntry(r) {
  const entry = { id: r.id, resource: r.resource_name, start: r.start_at, end: r.end_at, status: r.status, payment_mode: r.payment_mode, party_size: r.party_size };
  if (isPayAtClub(r)) {
    entry.pay_at_club = true;
    entry.amount_cents = payAtClubAmountCents(r);
  }
  return entry;
}

// ---------------------------------------------------------------------
// Amendment 6 exports -- called by B2b's Stripe webhook (src/portal/stripe.js).
// ---------------------------------------------------------------------

// D-A06: a `checkout.session.completed` for a hold whose expiry has
// passed is confirmed only if nothing else now occupies the slot;
// otherwise it becomes `paid_conflict` for the owner to resolve by hand
// (never auto-refunded). Idempotent: a second call after confirmation
// returns `already_confirmed` and writes nothing.
export async function confirmPaidBooking(env, bookingId, { paymentIntentId, sessionId } = {}) {
  const db = env.PORTAL_DB;
  const booking = await db.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return { status: "paid_conflict" };
  if (booking.status === "confirmed") return { status: "already_confirmed" };
  if (booking.status !== "pending_payment") return { status: "paid_conflict" };

  const nowIsoVal = nowIso();
  const holdExpired = Boolean(booking.hold_expires_at) && booking.hold_expires_at <= nowIsoVal;

  if (holdExpired) {
    // M12/A2: the confirm itself carries the SAME occupancy guard the
    // original insert used -- a plain SELECT-then-UPDATE pair (the
    // previous shape here) leaves a gap between the two statements for
    // a concurrent booking to land in, which this single guarded
    // statement closes. It can confirm this row ONLY if nothing else
    // now occupies the slot; it is a no-op (0 rows) otherwise.
    const confirmStmt = db
      .prepare(
        `UPDATE bookings SET status = 'confirmed', payment_intent_id = ?, checkout_session_id = COALESCE(?, checkout_session_id),
           hold_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending_payment'
           AND NOT EXISTS (
             SELECT 1 FROM bookings AS other
             WHERE other.resource_id = ? AND other.id != ? AND other.start_at < ? AND other.end_at > ?
               AND ${liveBookingSql("other")}
           )
         RETURNING *`
      )
      .bind(
        paymentIntentId || null, sessionId || null, nowIsoVal, bookingId,
        booking.resource_id, bookingId, booking.end_at, booking.start_at, nowIsoVal
      );
    const outboxStmt = guardedOutboxInsertStatement(db, { bookingId, action: "create", resourceId: booking.resource_id, payload: { booking_id: bookingId }, requireStatus: "confirmed" });
    const results = await runBatch(db, [confirmStmt, outboxStmt]);
    if ((results[0].results || []).length > 0) return { status: "confirmed" };

    // Confirm did not happen: either the slot is now occupied (mark
    // paid_conflict, itself guarded so it only fires if the row is
    // still pending_payment) or a concurrent call already resolved it.
    const conflictRow = await db
      .prepare(`UPDATE bookings SET status = 'paid_conflict', payment_intent_id = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment' RETURNING id`)
      .bind(paymentIntentId || null, nowIsoVal, bookingId)
      .first();
    if (conflictRow) return { status: "paid_conflict" };

    const finalRow = await db.prepare(`SELECT status FROM bookings WHERE id = ?`).bind(bookingId).first();
    return { status: finalRow && finalRow.status === "confirmed" ? "already_confirmed" : "paid_conflict" };
  }

  const statements = [
    db
      .prepare(
        `UPDATE bookings SET status = 'confirmed', payment_intent_id = ?, checkout_session_id = COALESCE(?, checkout_session_id),
           hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending_payment' RETURNING *`
      )
      .bind(paymentIntentId || null, sessionId || null, nowIsoVal, bookingId),
    guardedOutboxInsertStatement(db, { bookingId, action: "create", resourceId: booking.resource_id, payload: { booking_id: bookingId }, requireStatus: "confirmed" }),
  ];
  const results = await runBatch(db, statements);
  const updated = (results[0].results || []).length > 0;
  if (!updated) return { status: "already_confirmed" }; // raced with a concurrent confirm/cancel
  return { status: "confirmed" };
}

// Used for `checkout.session.expired`. A no-op once the booking is no
// longer `pending_payment` (idempotent).
export async function releaseHold(env, bookingId, reason) {
  const db = env.PORTAL_DB;
  const nowIsoVal = nowIso();
  const row = await db
    .prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, note = ? WHERE id = ? AND status = 'pending_payment' RETURNING *`)
    .bind(nowIsoVal, `released: ${reason || "expired"}`, bookingId)
    .first();
  return { released: Boolean(row) };
}

// CTL-CRD-01: the single credit-writing function for callers OUTSIDE a
// booking's own write (the Stripe pack-purchase webhook, an owner hand
// grant, a refund). A booking's own spend/return goes through the
// same two statements inline in its own batch (createBooking/
// cancelBooking above) so it stays in the SAME transaction as the
// booking write (PIN-13's same-batch rule) -- this export manages its
// OWN batch, which would not be atomic with a booking write it did not
// originate.
//
// Idempotent on `ref`: schema has no dedicated ref column (migrations
// are not this part's file -- flagged as a finding), so `source:ref` is
// encoded into `credits_ledger.reason`, which already holds free-text
// categories (e.g. 'pack_purchase'). A second call with the same
// source+ref changes nothing.
export async function addCredits(env, accountId, n, { source, ref } = {}) {
  const db = env.PORTAL_DB;
  if (!source || !ref) throw new Error(`addCredits requires source and ref, got source=${source} ref=${ref}`);
  const reasonKey = `${source}:${ref}`;
  const nowIsoVal = nowIso();
  const ledgerId = newId();
  const bookingIdForLedger = source === "cancel" ? ref : null;

  const statements = [
    db.prepare(`INSERT INTO credits (account_id, balance, updated_at) VALUES (?, 0, ?) ON CONFLICT(account_id) DO NOTHING`).bind(accountId, nowIsoVal),
    db
      .prepare(
        `INSERT INTO credits_ledger (id, account_id, delta, reason, booking_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM credits_ledger WHERE account_id = ? AND reason = ?)`
      )
      .bind(ledgerId, accountId, n, reasonKey, bookingIdForLedger, nowIsoVal, accountId, reasonKey),
    db
      .prepare(
        `UPDATE credits SET balance = balance + ?, updated_at = ?
         WHERE account_id = ? AND EXISTS (SELECT 1 FROM credits_ledger WHERE id = ? AND account_id = ?)`
      )
      .bind(n, nowIsoVal, accountId, ledgerId, accountId),
  ];
  await runBatch(db, statements);
  const row = await db.prepare(`SELECT balance FROM credits WHERE account_id = ?`).bind(accountId).first();
  return { balance: row ? row.balance : 0 };
}
