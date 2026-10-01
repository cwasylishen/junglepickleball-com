// Owner-side resource and offering CRUD (B2a2, docs/portal/api.md §4).
// REQ-OWN-08/09/10/11, CTL-RES-01 (bounded rule values, 400/no-write on
// violation), PIN-15 (seeded defaults flagged "confirm with Roger").
//
// Database doctrine: this is the ONE place that writes `resources` or
// `offerings`. Every write builds its SQL from an explicit field list
// (CTL-AUTHZ-03) -- a request body is never spread onto a row. The
// Stripe Price for an offering (and the `display_price_cents` mirror)
// is written only by B2b's dedicated price route (docs/portal/api.md
// §5) -- `lookup_key` and `display_price_cents` are deliberately absent
// from this file's own field lists so the two writers never race on the
// same column.

import { newId, nowIso } from "./db.js";
import { auditStatement } from "./audit.js";

export const RESOURCE_FIELDS = [
  "name",
  "staff_account_id",
  "open_time",
  "close_time",
  "slot_minutes",
  "buffer_minutes",
  "member_window_days",
  "non_member_window_days",
  "cancel_cutoff_minutes",
  "max_active_per_account",
  "member_included",
  "price_mode",
  "google_calendar_id",
];

// Fields whose seeded/created-by-default value is flagged "default,
// confirm with Roger" (PIN-15). open_time/close_time/slot_minutes are
// required at create, so they are only ever a real owner choice -- they
// are still clearable by confirm-field if a later PATCH leaves them
// untouched. staff_account_id/google_calendar_id are nullable and NULL
// is a legitimate "not set yet" state, not a risky default, so they are
// not auto-flagged.
const DEFAULTABLE_FIELDS = [
  "buffer_minutes",
  "member_window_days",
  "non_member_window_days",
  "cancel_cutoff_minutes",
  "max_active_per_account",
  "member_included",
  "price_mode",
];

const OFFERING_FIELDS = ["name", "duration_minutes", "audience", "active"];
const OFFERING_AUDIENCES = new Set(["everyone", "member_annual", "member_other", "guest"]);
const RESOURCE_KINDS = new Set(["court", "massage", "plunge"]);

// Costa Rica is a fixed UTC-6 offset, no DST (PIN-6: stored times are
// UTC, displayed/edited times are CR local). Resource open_time/
// close_time and block start_time/end_time/weekday/date are all CR
// local, so a misfit or block-conflict check against a UTC booking row
// needs this one conversion -- duplicated (as a small pure function)
// in owner.js rather than adding a new shared module outside this
// part's exclusive file list; see the B2a2 return's findings.
const CR_OFFSET_MINUTES = 6 * 60;

export function crLocalMinutesOfUtcIso(utcIso) {
  const d = new Date(utcIso);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ((utcMinutes - CR_OFFSET_MINUTES) % 1440 + 1440) % 1440;
}

export function timeToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

// CTL-RES-01: bounds on the fields that admit one. Returns the first
// violated field's error code, or null. Checked BEFORE any write, on
// the candidate fields only (open/close cross-check happens separately
// once both ends are known).
function boundsError(fields) {
  if ("slot_minutes" in fields) {
    const v = fields.slot_minutes;
    if (!Number.isInteger(v) || v < 5 || v > 480) return "bad_slot_minutes";
  }
  if ("buffer_minutes" in fields) {
    const v = fields.buffer_minutes;
    if (!Number.isInteger(v) || v < 0 || v > 240) return "bad_buffer_minutes";
  }
  if ("cancel_cutoff_minutes" in fields) {
    const v = fields.cancel_cutoff_minutes;
    if (!Number.isInteger(v) || v < 0 || v > 10080) return "bad_cancel_cutoff_minutes";
  }
  for (const key of ["member_window_days", "non_member_window_days"]) {
    if (key in fields) {
      const v = fields[key];
      if (!Number.isInteger(v) || v < 0 || v > 60) return "bad_window_days";
    }
  }
  if ("max_active_per_account" in fields) {
    const v = fields.max_active_per_account;
    if (v !== null && (!Number.isInteger(v) || v < 1)) return "bad_max_active_per_account";
  }
  if ("price_mode" in fields && fields.price_mode !== "per_player" && fields.price_mode !== "per_booking") {
    return "bad_price_mode";
  }
  return null;
}

function pickFields(body, allowList) {
  const out = {};
  for (const key of allowList) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

function parseUnconfirmed(resource) {
  try {
    const arr = JSON.parse(resource.unconfirmed_fields || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function withParsedResource(resource) {
  if (!resource) return resource;
  return { ...resource, unconfirmed_fields: parseUnconfirmed(resource) };
}

// REQ-OWN-11: an edit never changes or deletes an existing booking. This
// is a READ ONLY check -- it never writes to `bookings`. A booking
// "misfits" the new grid if its CR-local start or end falls outside the
// new open/close window.
async function findMisfits(db, resourceId, openMinutes, closeMinutes) {
  const rows = (await db
    .prepare(`SELECT id, account_id, walk_in_name, start_at, end_at FROM bookings WHERE resource_id = ? AND status != 'cancelled'`)
    .bind(resourceId)
    .all()).results || [];
  return rows
    .filter((b) => {
      const startMin = crLocalMinutesOfUtcIso(b.start_at);
      let endMin = crLocalMinutesOfUtcIso(b.end_at);
      if (endMin === 0 && b.end_at > b.start_at) endMin = 1440; // ends exactly at CR midnight
      return startMin < openMinutes || endMin > closeMinutes;
    })
    .map((b) => ({ id: b.id, start_at: b.start_at, end_at: b.end_at, account_id: b.account_id, walk_in_name: b.walk_in_name }));
}

export async function listOwnerResources(db) {
  const resources = (await db.prepare(`SELECT * FROM resources ORDER BY kind, name`).all()).results || [];
  const offerings = (await db.prepare(`SELECT * FROM offerings ORDER BY resource_id, duration_minutes`).all()).results || [];
  const byResource = new Map();
  for (const o of offerings) {
    if (!byResource.has(o.resource_id)) byResource.set(o.resource_id, []);
    byResource.get(o.resource_id).push(o);
  }
  return resources.map((r) => ({ ...withParsedResource(r), offerings: byResource.get(r.id) || [] }));
}

export async function createResource(db, actorId, body = {}) {
  const kind = body.kind;
  const name = body.name;
  if (!RESOURCE_KINDS.has(kind)) return { error: "bad_kind" };
  if (!name || typeof name !== "string" || !name.trim()) return { error: "bad_name" };
  const openTime = body.open_time;
  const closeTime = body.close_time;
  const slotMinutes = body.slot_minutes;
  const openMin = timeToMinutes(openTime);
  const closeMin = timeToMinutes(closeTime);
  if (openMin === null || closeMin === null) return { error: "bad_hours" };
  if (openMin >= closeMin) return { error: "bad_hours" };

  // open_time/close_time/slot_minutes are required and already placed
  // in the base column list below; excluded here so they are never
  // pushed onto that list a second time.
  const optional = pickFields(body, RESOURCE_FIELDS.filter((f) => f !== "open_time" && f !== "close_time" && f !== "slot_minutes"));
  const err = boundsError({ ...optional, slot_minutes: slotMinutes });
  if (err) return { error: err };
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 480) return { error: "bad_slot_minutes" };

  const unconfirmed = DEFAULTABLE_FIELDS.filter((f) => !(f in optional));

  const id = newId();
  const now = nowIso();
  const columns = ["id", "kind", "name", "open_time", "close_time", "slot_minutes", "is_demo", "unconfirmed_fields", "created_at", "updated_at"];
  const values = [id, kind, name.trim(), openTime, closeTime, slotMinutes, 0, JSON.stringify(unconfirmed), now, now];
  for (const [k, v] of Object.entries(optional)) {
    columns.push(k);
    values.push(v);
  }
  const placeholders = columns.map(() => "?").join(",");
  const insertStmt = db.prepare(`INSERT INTO resources (${columns.join(",")}) VALUES (${placeholders})`).bind(...values);
  const audit = auditStatement(db, { actor: actorId, action: "resource_created", targetType: "resource", targetId: id, after: { kind, name, open_time: openTime, close_time: closeTime, slot_minutes: slotMinutes, ...optional } });
  await db.batch([insertStmt, audit]);

  const resource = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(id).first();
  return { resource: withParsedResource(resource) };
}

export async function updateResource(db, actorId, resourceId, body = {}) {
  const existing = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!existing) return { error: "not_found" };

  const candidate = pickFields(body, RESOURCE_FIELDS);
  if (Object.keys(candidate).length === 0) return { error: "no_fields" };
  if ("name" in candidate && (!candidate.name || !candidate.name.trim())) return { error: "bad_name" };

  const err = boundsError(candidate);
  if (err) return { error: err };

  const effectiveOpen = "open_time" in candidate ? candidate.open_time : existing.open_time;
  const effectiveClose = "close_time" in candidate ? candidate.close_time : existing.close_time;
  const openMin = timeToMinutes(effectiveOpen);
  const closeMin = timeToMinutes(effectiveClose);
  if (openMin === null || closeMin === null) return { error: "bad_hours" };
  if (openMin >= closeMin) return { error: "bad_hours" };

  const before = { ...existing };
  const unconfirmedBefore = parseUnconfirmed(existing);
  const unconfirmedAfter = unconfirmedBefore.filter((f) => !(f in candidate)); // editing a field clears its chip

  const cols = Object.keys(candidate);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const bindings = [...cols.map((c) => candidate[c]), JSON.stringify(unconfirmedAfter), nowIso(), resourceId];
  const updateStmt = db
    .prepare(`UPDATE resources SET ${setClause}, unconfirmed_fields = ?, updated_at = ? WHERE id = ?`)
    .bind(...bindings);
  const audit = auditStatement(db, { actor: actorId, action: "resource_updated", targetType: "resource", targetId: resourceId, before, after: candidate });
  await db.batch([updateStmt, audit]);

  const resource = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();

  const misfitRelevant = ["open_time", "close_time", "slot_minutes", "buffer_minutes"].some((f) => f in candidate);
  const misfits = misfitRelevant ? await findMisfits(db, resourceId, openMin, closeMin) : [];

  return { resource: withParsedResource(resource), misfits };
}

// Idempotent (database doctrine, repeatable): confirming an already-
// confirmed field is a no-op on the row, same end state either way.
export async function confirmResourceField(db, actorId, resourceId, field) {
  if (!RESOURCE_FIELDS.includes(field)) return { error: "bad_field" };
  const existing = await db.prepare(`SELECT id, unconfirmed_fields FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!existing) return { error: "not_found" };
  const before = parseUnconfirmed(existing);
  if (!before.includes(field)) return { ok: true }; // already confirmed -- no write needed
  const after = before.filter((f) => f !== field);
  const updateStmt = db.prepare(`UPDATE resources SET unconfirmed_fields = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(after), nowIso(), resourceId);
  const audit = auditStatement(db, { actor: actorId, action: "resource_field_confirmed", targetType: "resource", targetId: resourceId, before: { field }, after: { field } });
  await db.batch([updateStmt, audit]);
  return { ok: true };
}

export async function listOfferings(db, resourceId) {
  return (await db.prepare(`SELECT * FROM offerings WHERE resource_id = ? ORDER BY duration_minutes`).bind(resourceId).all()).results || [];
}

export async function createOffering(db, actorId, resourceId, body = {}) {
  const resource = await db.prepare(`SELECT id FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!resource) return { error: "resource_not_found" };
  const name = body.name;
  const durationMinutes = body.duration_minutes;
  const audience = body.audience || "everyone";
  if (!name || typeof name !== "string" || !name.trim()) return { error: "bad_name" };
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) return { error: "bad_duration_minutes" };
  if (!OFFERING_AUDIENCES.has(audience)) return { error: "bad_audience" };

  const id = newId();
  const now = nowIso();
  // lookup_key / display_price_cents start NULL ("price not set",
  // CTL-ENT-02 not_bookable) -- only B2b's price route ever writes them.
  const insertStmt = db
    .prepare(
      `INSERT INTO offerings (id, resource_id, name, duration_minutes, audience, lookup_key, display_price_cents, active, created_at, updated_at)
       VALUES (?,?,?,?,?,NULL,NULL,?,?,?)`
    )
    .bind(id, resourceId, name.trim(), durationMinutes, audience, body.active === false ? 0 : 1, now, now);
  const audit = auditStatement(db, { actor: actorId, action: "offering_created", targetType: "offering", targetId: id, after: { resource_id: resourceId, name, duration_minutes: durationMinutes, audience } });
  await db.batch([insertStmt, audit]);

  const offering = await db.prepare(`SELECT * FROM offerings WHERE id = ?`).bind(id).first();
  return { offering };
}

export async function updateOffering(db, actorId, resourceId, offeringId, body = {}) {
  const existing = await db.prepare(`SELECT * FROM offerings WHERE id = ? AND resource_id = ?`).bind(offeringId, resourceId).first();
  if (!existing) return { error: "not_found" };
  const candidate = pickFields(body, OFFERING_FIELDS);
  if (Object.keys(candidate).length === 0) return { error: "no_fields" };
  if ("name" in candidate && (!candidate.name || !candidate.name.trim())) return { error: "bad_name" };
  if ("duration_minutes" in candidate && (!Number.isInteger(candidate.duration_minutes) || candidate.duration_minutes <= 0)) {
    return { error: "bad_duration_minutes" };
  }
  if ("audience" in candidate && !OFFERING_AUDIENCES.has(candidate.audience)) return { error: "bad_audience" };
  if ("active" in candidate) candidate.active = candidate.active ? 1 : 0;

  const cols = Object.keys(candidate);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const updateStmt = db
    .prepare(`UPDATE offerings SET ${setClause}, updated_at = ? WHERE id = ?`)
    .bind(...cols.map((c) => candidate[c]), nowIso(), offeringId);
  const audit = auditStatement(db, { actor: actorId, action: "offering_updated", targetType: "offering", targetId: offeringId, before: existing, after: candidate });
  await db.batch([updateStmt, audit]);

  const offering = await db.prepare(`SELECT * FROM offerings WHERE id = ?`).bind(offeringId).first();
  return { offering };
}

export async function deleteOffering(db, actorId, resourceId, offeringId) {
  const existing = await db.prepare(`SELECT * FROM offerings WHERE id = ? AND resource_id = ?`).bind(offeringId, resourceId).first();
  if (!existing) return { error: "not_found" };
  const deleteStmt = db.prepare(`DELETE FROM offerings WHERE id = ?`).bind(offeringId);
  const audit = auditStatement(db, { actor: actorId, action: "offering_deleted", targetType: "offering", targetId: offeringId, before: existing });
  await db.batch([deleteStmt, audit]);
  return { ok: true };
}
