// Staff calendar (B2a2, docs/portal/api.md §4). CTL-STF-01: the query is
// fixed to the caller's OWN resource(s) -- no resource id is ever
// accepted from the request, and D-A16 bounds the fields returned to
// start/end/resource/display_name/state. CTL-AUTHZ-02: a dependant's
// name never appears here (this file never reads `dependants` at all).

// Costa Rica is a fixed UTC-6 offset, no DST (same small conversion
// owner.js and resources.js each carry their own copy of -- see the
// B2a2 return's finding about duplicating this rather than adding a new
// shared module outside this part's exclusive file list).
function todayCrDate() {
  const shifted = new Date(Date.now() - 6 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// staffAccountId: the session's own account id (never a parameter the
// caller supplies). resourceIdParam: present only to PROVE CTL-STF-01 --
// any caller sending one at all is asking for a resource by name, which
// this route must refuse rather than silently ignore.
export async function staffCalendar(db, staffAccountId, dateStr, resourceIdParam) {
  if (resourceIdParam) return { error: "resource_forbidden", status: 403 };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr : todayCrDate();

  const resources = (await db.prepare(`SELECT id, name FROM resources WHERE staff_account_id = ?`).bind(staffAccountId).all()).results || [];
  if (resources.length === 0) return { date, events: [] }; // S1 "no_resource" state: an empty, honest list

  const dayStartUtc = `${date}T06:00:00.000Z`; // CR midnight, fixed UTC-6
  const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const resourceIds = resources.map((r) => r.id);
  const resourceNameById = new Map(resources.map((r) => [r.id, r.name]));

  const placeholders = resourceIds.map(() => "?").join(",");
  const bookings = (await db
    .prepare(
      `SELECT b.start_at, b.end_at, b.resource_id, b.status, a.display_name AS account_display_name, b.walk_in_name
       FROM bookings b JOIN accounts a ON a.id = b.account_id
       WHERE b.resource_id IN (${placeholders}) AND b.start_at >= ? AND b.start_at < ? AND b.status != 'cancelled'
       ORDER BY b.start_at`
    )
    .bind(...resourceIds, dayStartUtc, dayEndUtc)
    .all()).results || [];

  // D-A16: start, end, resource, display_name, state ONLY -- never
  // email, phone, notes or payment detail beyond the held/confirmed
  // state itself.
  const events = bookings.map((b) => ({
    start: b.start_at,
    end: b.end_at,
    resource: resourceNameById.get(b.resource_id) || null,
    display_name: b.walk_in_name || b.account_display_name,
    state: b.status === "pending_payment" ? "held" : "confirmed",
  }));

  const blocks = (await db
    .prepare(`SELECT resource_id, kind, weekday, date, start_time, end_time, label FROM blocks WHERE resource_id IN (${placeholders})`)
    .bind(...resourceIds)
    .all()).results || [];
  const weekday = new Date(new Date(dayStartUtc).getTime()).getUTCDay();
  for (const blk of blocks) {
    if (blk.kind === "one_off" && blk.date !== date) continue;
    if (blk.kind === "weekly" && blk.weekday !== weekday) continue;
    events.push({
      start: `${date}T${blk.start_time}:00.000-06:00`,
      end: `${date}T${blk.end_time}:00.000-06:00`,
      resource: resourceNameById.get(blk.resource_id) || null,
      display_name: null,
      state: "blocked",
    });
  }

  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { date, events };
}
