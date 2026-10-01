// Stub scheduled-handler body (PIN-14). B1 writes this stub; B2e owns
// the real body (24h/2h push reminders, deduplicated via
// reminder_sends, and the calendar_outbox drain) and never reopens
// worker.js to add it (breakdown.md §2) -- src/worker.js's scheduled()
// export always calls this function; B2e fills in what it does.

export async function runScheduled(env) {
  const db = env.PORTAL_DB;
  if (!db) return;
  // A cron trigger has no hostname, so CTL-ENV-01's full gate does not
  // apply the way it does to an HTTP request. The one check that is
  // meaningful here -- a marker row exists at all -- stays, so an
  // unconfigured database does nothing rather than erroring.
  const marker = await db.prepare(`SELECT env FROM portal_meta WHERE id = 1`).first();
  if (!marker) return;
  // B2e: send 24h/2h reminders and drain calendar_outbox here.
}
