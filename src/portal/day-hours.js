// The per-day closing-time override: the owner extends one specific
// Costa Rica day past the normal close (PIN L3, ruling PF-3). Everything
// about the `day_close_overrides` table lives here: the owner's set and
// clear actions, the list the owner screen shows, and the one function
// the booking engine calls to learn a day's real closing time.
//
// PIN L3 (Roger, 2026-10-01): "The owner can extend a specific day to
// 21:00 (an admin action, never the default)". The override only ever
// moves a close LATER, and only for courts.

import { nowIso } from "./db.js";
import { auditStatement } from "./audit.js";
import { crDateStringFromUtc, crDateTimeToUtcIso, addDaysToDateString, isValidDateString, hhmmToMinutes } from "./cr-time.js";

// PIN L3: the latest an owner can extend a day to. The table's own CHECK
// repeats it, so no other code path can store a later close.
export const DAY_EXTENSION_MAX_CLOSE = "21:00";

// PIN L3 words the extension under "Courts". Plunge and massage keep
// their own hours on every day.
const EXTENDABLE_KIND = "court";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getDayCloseOverride(db, crDate) {
  return (await db.prepare(`SELECT * FROM day_close_overrides WHERE date = ?`).bind(crDate).first()) || null;
}

// Pure. Returns the resource as it should be treated on the day the
// override covers: same row, close_time moved later. A resource that is
// not a court, or an override that is not later than the normal close,
// leaves the resource untouched.
export function applyDayOverride(resource, override) {
  if (!override || resource.kind !== EXTENDABLE_KIND) return resource;
  if (hhmmToMinutes(override.close_time) <= hhmmToMinutes(resource.close_time)) return resource;
  return { ...resource, close_time: override.close_time };
}

// The engine's one question: "what are this resource's hours on this
// Costa Rica date?" Every booking writer and the availability grid ask
// it, so the owner's extension is honoured in exactly one place.
export async function resourceForDate(db, resource, crDate) {
  if (resource.kind !== EXTENDABLE_KIND) return resource;
  return applyDayOverride(resource, await getDayCloseOverride(db, crDate));
}

// Upcoming extensions (today and later, Costa Rica date) for the owner
// screen, soonest first.
export async function listDayExtensions(db) {
  const today = crDateStringFromUtc(new Date());
  return (await db.prepare(`SELECT date, close_time, set_by, updated_at FROM day_close_overrides WHERE date >= ? ORDER BY date`).bind(today).all()).results || [];
}

// How many live bookings on that day end after the day's closing time as
// it now stands. Existing bookings are never moved or cancelled when an
// extension is shortened or cleared (D-A11, REQ-OWN-11); the owner is
// told how many are left running late.
async function countLateBookings(db, crDate) {
  const dayStart = crDateTimeToUtcIso(crDate, "00:00");
  const dayEnd = crDateTimeToUtcIso(addDaysToDateString(crDate, 1), "00:00");
  const override = await getDayCloseOverride(db, crDate);
  const courts = (await db.prepare(`SELECT id, kind, close_time FROM resources WHERE kind = ?`).bind(EXTENDABLE_KIND).all()).results || [];
  let late = 0;
  for (const court of courts) {
    const closeIso = crDateTimeToUtcIso(crDate, applyDayOverride(court, override).close_time);
    const row = await db
      // "Live" is the engine's own rule: confirmed, or an unexpired payment hold.
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings WHERE resource_id = ? AND start_at >= ? AND start_at < ? AND end_at > ?
           AND (status = 'confirmed' OR (status = 'pending_payment' AND (hold_expires_at IS NULL OR hold_expires_at > ?)))`
      )
      .bind(court.id, dayStart, dayEnd, closeIso, nowIso())
      .first();
    late += row ? row.n : 0;
  }
  return late;
}

// ACTIVITY: owner extends one day's closing time.
// One transaction (the row and its audit entry). Repeatable: setting the
// same close on the same day again changes nothing and writes no second
// audit entry. Errors are named, never thrown for a bad request:
//   bad_date, date_in_past, bad_close_time, close_too_late, not_an_extension
export async function setDayExtension(db, actorId, crDate, closeTime) {
  if (!isValidDateString(crDate)) return { error: "bad_date" };
  if (crDate < crDateStringFromUtc(new Date())) return { error: "date_in_past" };
  if (typeof closeTime !== "string" || !HHMM.test(closeTime)) return { error: "bad_close_time" };
  if (hhmmToMinutes(closeTime) > hhmmToMinutes(DAY_EXTENSION_MAX_CLOSE)) return { error: "close_too_late" };

  const latestNormalClose = await db.prepare(`SELECT MAX(close_time) AS close_time FROM resources WHERE kind = ?`).bind(EXTENDABLE_KIND).first();
  if (!latestNormalClose || !latestNormalClose.close_time || hhmmToMinutes(closeTime) <= hhmmToMinutes(latestNormalClose.close_time)) {
    return { error: "not_an_extension" }; // an extension must be later than the normal close
  }

  const existing = await getDayCloseOverride(db, crDate);
  if (existing && existing.close_time === closeTime) return { override: existing, changed: false, late_bookings: await countLateBookings(db, crDate) };

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO day_close_overrides (date, close_time, set_by, created_at, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(date) DO UPDATE SET close_time = excluded.close_time, set_by = excluded.set_by, updated_at = excluded.updated_at`
      )
      .bind(crDate, closeTime, actorId, now, now),
    auditStatement(db, {
      actor: actorId,
      action: "day_extension_set",
      targetType: "day_close_override",
      targetId: crDate,
      before: existing ? { close_time: existing.close_time } : null,
      after: { close_time: closeTime },
    }),
  ]);
  return { override: await getDayCloseOverride(db, crDate), changed: true, late_bookings: await countLateBookings(db, crDate) };
}

// ACTIVITY: owner clears one day's extension, back to normal hours.
// One transaction. Repeatable: clearing a day that has no extension is
// the same end state and writes nothing. Errors: bad_date.
export async function clearDayExtension(db, actorId, crDate) {
  if (!isValidDateString(crDate)) return { error: "bad_date" };
  const existing = await getDayCloseOverride(db, crDate);
  if (!existing) return { ok: true, changed: false, late_bookings: 0 };

  await db.batch([
    db.prepare(`DELETE FROM day_close_overrides WHERE date = ?`).bind(crDate),
    auditStatement(db, { actor: actorId, action: "day_extension_cleared", targetType: "day_close_override", targetId: crDate, before: { close_time: existing.close_time }, after: null }),
  ]);
  return { ok: true, changed: true, late_bookings: await countLateBookings(db, crDate) };
}
