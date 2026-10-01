// The one calendar-outbox-writing function (PIN-13, REQ-CAL-02): every
// booking create/cancel/move writes its outbox row in the SAME D1 batch
// as the booking write, so a failure of either rolls back both.

import { newId, nowIso } from "./db.js";

// Returns a prepared statement -- the caller (booking.js, B2a1) includes
// it in its own batch() call alongside the booking insert/update. This
// module never calls db.batch() itself, so it can never be the thing
// that writes a booking without its outbox row, or vice versa.
export function outboxInsertStatement(db, { bookingId, action, resourceId, payload }) {
  return db
    .prepare(
      `INSERT INTO calendar_outbox (id, booking_id, action, resource_id, payload, status, attempts, created_at, updated_at)
       VALUES (?,?,?,?,?, 'pending', 0, ?, ?)`
    )
    .bind(newId(), bookingId, action, resourceId, JSON.stringify(payload || {}), nowIso(), nowIso());
}

// Read-only summary for the owner view (O8/screens §10 item 9) and the
// B2d drain cron. Inert while GOOGLE_SERVICE_ACCOUNT_JSON is unset -- the
// rows simply accumulate as 'pending' (PIN-13).
export async function outboxSummary(db) {
  const pending = await db.prepare(`SELECT COUNT(*) AS n FROM calendar_outbox WHERE status = 'pending'`).first();
  const failed = await db
    .prepare(`SELECT id, booking_id, action, last_error FROM calendar_outbox WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 50`)
    .all();
  return { pending: pending ? pending.n : 0, failed: failed.results || [] };
}
