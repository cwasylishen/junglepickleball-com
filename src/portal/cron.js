// Scheduled-handler body (PIN-14, amendment 6). B1 wires the three jobs
// below; B2e owns this file from here on, including the real bodies of
// push.js (24h/2h reminders, deduplicated via reminder_sends) and
// gcal.js (the calendar_outbox drain, already stubbed by B1), plus the
// D-A19 retention purge stubbed inline here. It never reopens
// worker.js to add a fourth job (breakdown.md §2) -- src/worker.js's
// scheduled() export always calls this one function.
//
// Each job runs in its own try/catch (amendment 6) so one failure never
// stops the others -- a push-provider outage must not also stop the
// calendar drain or the retention purge, and vice versa.

import { sendDueReminders } from "./push.js";
import { drainCalendarOutbox } from "./gcal.js";

// D-A19 retention (amendment 2): magic-link rows purged 24h after
// expiry, session rows purged after expiry. The audit log is kept --
// neither statement below touches it. Each DELETE is a single
// statement (atomic, R-6) and idempotent on its own: a row already
// gone from a prior run simply matches zero rows the next time, so
// running this twice in a row leaves the same state as running it once.
async function purgeExpiredRows(env) {
  const db = env.PORTAL_DB;
  const nowIso = new Date().toISOString();
  const loginTokenCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tokens = await db.prepare(`DELETE FROM login_tokens WHERE expires_at <= ?`).bind(loginTokenCutoff).run();
  const sessions = await db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(nowIso).run();
  return { login_tokens_purged: tokens.meta ? tokens.meta.changes : 0, sessions_purged: sessions.meta ? sessions.meta.changes : 0 };
}

// LOG-02: never logs the error's own message, only its class and a
// random id, same discipline as http.js's logAndMask.
function logJobFailure(job, err) {
  const errorId = crypto.randomUUID();
  // eslint-disable-next-line no-console
  console.error(`cron_${job}_failed id=${errorId} class=${(err && err.name) || "Error"}`);
}

export async function runScheduled(env) {
  const db = env.PORTAL_DB;
  if (!db) return;
  // A cron trigger has no hostname, so CTL-ENV-01's full gate does not
  // apply the way it does to an HTTP request. The one check that is
  // meaningful here -- a marker row exists at all -- stays, so an
  // unconfigured database does nothing rather than erroring.
  const marker = await db.prepare(`SELECT env FROM portal_meta WHERE id = 1`).first();
  if (!marker) return;

  try {
    await sendDueReminders(env);
  } catch (err) {
    logJobFailure("reminders", err);
  }
  try {
    await drainCalendarOutbox(env, {});
  } catch (err) {
    logJobFailure("gcal_drain", err);
  }
  try {
    await purgeExpiredRows(env);
  } catch (err) {
    logJobFailure("purge", err);
  }
}
