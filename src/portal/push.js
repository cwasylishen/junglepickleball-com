// Push subscriptions and reminder sends (PIN-14, R-3, CTL-PSH-01/02).
// Database doctrine: this is the ONE module that writes
// `push_subscriptions` and `reminder_sends` -- no other file builds SQL
// against either table. Each business activity below is one named
// function, each write a single atomic statement (R-6).

import { buildPushPayload } from "@block65/webcrypto-web-push";
import { newId, nowIso } from "./db.js";

// ---------- configuration (REQ-PWA-09/16) ----------

export function isPushConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

// ---------- subscriptions: one writer, one endpoint = one account (CTL-PSH-02) ----------

// The subscribe activity. `endpoint` is UNIQUE (migration 0005): a
// device re-registering, or a second account registering the same
// device, rebinds the row to whoever just called this rather than
// creating a second row.
export async function subscribeToPush(db, accountId, { endpoint, keys }) {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, account_id, endpoint, p256dh, auth, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET
         account_id = excluded.account_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         updated_at = excluded.updated_at`
    )
    .bind(newId(), accountId, endpoint, keys.p256dh, keys.auth, nowIso(), nowIso())
    .run();
}

// The opt-out activity (REQ-PWA-08), scoped to the caller's own
// account: an account can only remove a subscription it owns, never one
// a different account's device re-registered onto the same endpoint.
export async function unsubscribeFromPush(db, accountId, endpoint) {
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ?`).bind(endpoint, accountId).run();
}

// Logout's cleanup activity is this same opt-out activity, not a
// second one: CTL-PSH-02 and GEN-33 both say logout stops reminders on
// *that device* (one endpoint), not every device signed in to the
// account, so `unsubscribeFromPush` above -- scoped to account+endpoint
// -- is what src/portal/auth.js's logout() must call, with the
// endpoint the client sends in its logout request body. auth.js is
// B1's file; this part's return carries the exact line for B1 to add.
// (An earlier draft of this module had a second, account-wide
// `deleteSubscriptionsForAccount` here for logout to call -- removed:
// it would have cleared every other device's subscription too, which
// is not what "that device" means, and the database doctrine's "one
// named function per activity" already has this one.)

// REQ-PWA-14: the push service itself says the endpoint is gone.
async function deleteSubscriptionByEndpoint(db, endpoint) {
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
}

async function subscriptionsForAccount(db, accountId) {
  const rows = await db
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE account_id = ?`)
    .bind(accountId)
    .all();
  return rows.results || [];
}

// ---------- reminder content (CTL-PSH-01, PIN-10) ----------

// Fixed strings only. No booking field is ever interpolated into these
// -- the payload below carries nothing but `booking_id` and `kind`; the
// client looks the booking up itself to show its own detail.
export const STR = {
  en: {
    pushReminderTitle: "Jungle Pickleball",
    pushReminderBody: "You have a booking coming up. Open the app for details.",
  },
};

// Exported on purpose: this is the exact object the control's probe
// inspects. A future edit that adds a resource name, a display name or
// a time into `data` fails that probe before it ever reaches encryption.
export function buildReminderPushMessage(bookingId, kind) {
  return {
    data: {
      title: STR.en.pushReminderTitle,
      body: STR.en.pushReminderBody,
      booking_id: bookingId,
      kind,
    },
    options: { ttl: 900, urgency: "normal" },
  };
}

// ---------- sending (R-3: always encrypted, never an empty tickle) ----------

async function sendReminderPush(env, subscription, bookingId, kind) {
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const message = buildReminderPushMessage(bookingId, kind);
  const payload = await buildPushPayload(
    message,
    { endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
    vapid
  );
  return fetch(subscription.endpoint, payload);
}

// LOG-02 discipline (matches http.js/cron.js): log the class and a
// random id, never the push service's response body or the endpoint.
function logPushSendFailure(err) {
  const errorId = crypto.randomUUID();
  // eslint-disable-next-line no-console
  console.error(`push_send_failed id=${errorId} class=${(err && err.name) || "Error"}`);
}

// ---------- the one dedupe-and-send activity (PIN-14, REQ-PWA-10..13) ----------

function isoPlusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000).toISOString();
}

// REQ-PWA-10/11/13: only a `confirmed` booking is ever a candidate --
// `pending_payment` (including an expired hold), `cancelled` and
// `paid_conflict` are excluded by this one filter, so there is no
// second "is this cancelled/expired" check to get out of sync with it.
async function dueBookings(db, kind, now) {
  const windowMinutes = kind === "24h" ? 24 * 60 : 2 * 60;
  const windowEnd = isoPlusMinutes(now, windowMinutes);
  const rows = await db
    .prepare(`SELECT id, account_id FROM bookings WHERE status = 'confirmed' AND start_at > ? AND start_at <= ?`)
    .bind(now.toISOString(), windowEnd)
    .all();
  return rows.results || [];
}

// REQ-PWA-12: claims the (booking, kind) row exactly once. SQLite only
// returns a RETURNING row for the statement that actually wrote one --
// a conflict (the row already exists) returns nothing, so this is the
// run-it-twice guarantee: the second cron pass sees `claimed === false`
// and sends nothing more for that booking+kind, however many times it
// runs.
async function claimReminder(db, bookingId, kind) {
  const row = await db
    .prepare(
      `INSERT INTO reminder_sends (id, booking_id, kind, sent_at) VALUES (?,?,?,?)
       ON CONFLICT(booking_id, kind) DO NOTHING RETURNING id`
    )
    .bind(newId(), bookingId, kind, nowIso())
    .first();
  return Boolean(row);
}

// The one scheduled activity cron.js calls. REQ-PWA-09: with push
// unconfigured this returns {sent:0, configured:false} and touches
// neither table -- no row is claimed for a reminder that was never
// actually attempted, so turning VAPID on later does not skip anyone.
export async function sendDueReminders(env) {
  const db = env.PORTAL_DB;
  if (!db || !isPushConfigured(env)) return { sent: 0, configured: false };

  const now = new Date();
  let sent = 0;
  for (const kind of ["24h", "2h"]) {
    const bookings = await dueBookings(db, kind, now);
    for (const booking of bookings) {
      const claimed = await claimReminder(db, booking.id, kind);
      if (!claimed) continue;
      sent++;
      const subscriptions = await subscriptionsForAccount(db, booking.account_id);
      for (const subscription of subscriptions) {
        try {
          const res = await sendReminderPush(env, subscription, booking.id, kind);
          if (res && (res.status === 404 || res.status === 410)) {
            await deleteSubscriptionByEndpoint(db, subscription.endpoint);
          }
        } catch (err) {
          // One subscription's failure (a dead endpoint that throws
          // instead of answering, a network error) never stops the
          // rest of this booking's subscriptions or the next booking.
          logPushSendFailure(err);
        }
      }
    }
  }
  return { sent, configured: true };
}
