// Owner ops: accounts, entitlement hand grants, households, dependants,
// role, account delete, today-across-resources, blocks, the owner
// booking override, outbox failures and overlaps (B2a2,
// docs/portal/api.md §4). Database doctrine: this is the ONE place that
// writes `entitlement_grants` by hand (`source='hand'`), `households`,
// `dependants`, `blocks`, and the ONE place that inserts a booking row
// for the owner-override path (see the finding at the bottom of this
// file about `bookings`' single-writer control, CTL-BOOK-01).

import { newId, nowIso } from "./db.js";
import { auditStatement } from "./audit.js";
import { resolveEntitlement, validGrants } from "./entitlement.js";
import { outboxSummary } from "./outbox.js";
import { crLocalMinutesOfUtcIso, timeToMinutes } from "./resources.js";
import { insertBookingAtomic, gridAndHoursError, guardedOutboxInsertStatement } from "./booking.js";

// Mirrors the 7 tier lookup_key families entitlement.js's TIER_RANK
// recognises (not exported there -- see the B2a2 return's findings: if
// an 8th tier is ever added, both lists must be updated together, or
// B1 should export one shared VALID_TIERS/isValidTier()).
const VALID_TIERS = new Set([
  "jp_annual_single",
  "jp_annual_couples",
  "jp_6m_single",
  "jp_6m_couples",
  "jp_3m_single",
  "jp_3m_couples",
  "jp_1m_single",
]);

const SETTABLE_ROLES = new Set(["staff", "member", "guest"]);

function crDateString(utcIso) {
  const d = new Date(utcIso);
  const shifted = new Date(d.getTime() - 6 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function crWeekday(utcIso) {
  const d = new Date(utcIso);
  const shifted = new Date(d.getTime() - 6 * 60 * 60 * 1000);
  return shifted.getUTCDay(); // 0 = Sunday, matches blocks.weekday
}

// ---------- accounts ----------

export async function listAccounts(db) {
  const rows = (await db.prepare(`SELECT id, email, role, display_name, is_demo FROM accounts ORDER BY email`).all()).results || [];
  const out = [];
  for (const r of rows) {
    const ent = await resolveEntitlement(db, r.id);
    out.push({ ...r, entitlement: { tier: ent.tier, overlap: ent.overlap } });
  }
  return out;
}

export async function getAccountDetail(db, accountId) {
  const account = await db.prepare(`SELECT id, email, role, display_name, is_demo, created_at FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!account) return null;
  const grants = (await db.prepare(`SELECT * FROM entitlement_grants WHERE account_id = ? ORDER BY created_at DESC`).bind(accountId).all()).results || [];
  const asPayer = await db.prepare(`SELECT * FROM households WHERE payer_account_id = ? AND status != 'unlinked'`).bind(accountId).first();
  const asPartner = await db.prepare(`SELECT * FROM households WHERE partner_account_id = ? AND status != 'unlinked'`).bind(accountId).first();
  const dependants = (await db.prepare(`SELECT id, first_name, birth_year FROM dependants WHERE household_account_id = ? ORDER BY birth_year DESC`).bind(accountId).all()).results || [];
  const bookings = (await db
    .prepare(`SELECT id, resource_id, start_at, end_at, status, payment_mode, party_size, walk_in_name FROM bookings WHERE account_id = ? ORDER BY start_at DESC LIMIT 50`)
    .bind(accountId)
    .all()).results || [];
  return {
    account,
    grants,
    households: [asPayer, asPartner].filter(Boolean),
    dependants,
    bookings,
  };
}

// D-A05: a dated hand grant, audited, one transaction. Not idempotent
// on repeat identical input BY DESIGN -- see the B2a2 return's finding
// (the contract carries no idempotency key for this activity; the
// owner may deliberately grant the same tier twice, e.g. a renewal).
export async function handGrantEntitlement(db, actorId, accountId, { tier, starts_at, ends_at, note } = {}) {
  if (!VALID_TIERS.has(tier)) return { error: "bad_tier" };
  if (!starts_at || !ends_at || !(new Date(starts_at).getTime() < new Date(ends_at).getTime())) return { error: "bad_dates" };
  const account = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!account) return { error: "not_found" };

  const id = newId();
  const now = nowIso();
  const insertGrant = db
    .prepare(
      `INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(id, accountId, "hand", tier, starts_at, ends_at, "active", actorId, note || null, now, now);
  const audit = auditStatement(db, { actor: actorId, action: "hand_grant", targetType: "entitlement_grant", targetId: id, after: { account_id: accountId, tier, starts_at, ends_at, note: note || null } });
  await db.batch([insertGrant, audit]);

  const grant = await db.prepare(`SELECT * FROM entitlement_grants WHERE id = ?`).bind(id).first();
  return { grant };
}

// portal(FR1): the end-grant route named as a gap in portal/js/owner.js
// (`endGrant()` showed "end_grant_not_available" rather than act, per
// its own comment -- posting a second grant would NOT end the first,
// only add a confusing second row). This ends the NAMED grant in place
// -- never touches a Stripe-sourced grant (P-2: hand grants and Stripe
// grants are separate sources, CTL-ENT-01, and only an owner hand grant
// is ever ended by hand here). Audited, one transaction. Idempotent:
// ending an already-ended grant changes nothing and still returns it.
export async function endHandGrant(db, actorId, accountId, grantId) {
  const grant = await db.prepare(`SELECT * FROM entitlement_grants WHERE id = ? AND account_id = ?`).bind(grantId, accountId).first();
  if (!grant) return { error: "not_found" };
  if (grant.source !== "hand") return { error: "not_a_hand_grant", status: 403 }; // never a Stripe grant
  if (grant.status === "ended") return { grant }; // idempotent no-op

  const now = nowIso();
  const updateStmt = db.prepare(`UPDATE entitlement_grants SET status = 'ended', ends_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, grantId);
  const audit = auditStatement(db, { actor: actorId, action: "hand_grant_ended", targetType: "entitlement_grant", targetId: grantId, before: { ends_at: grant.ends_at, status: grant.status }, after: { ends_at: now, status: "ended" } });
  await db.batch([updateStmt, audit]);

  const updated = await db.prepare(`SELECT * FROM entitlement_grants WHERE id = ?`).bind(grantId).first();
  return { grant: updated };
}

// portal(FR1): own-scoped household read (api.md §9/B2f1 finding M6 --
// "a member reading their own household needs an 'own' route"). Reuses
// the same households/dependants query vocabulary getAccountDetail
// already owns (database doctrine: no second copy); returns only the
// shape M6 needs, never the raw household/dependant rows.
export async function getOwnHousehold(db, accountId) {
  const ent = await resolveEntitlement(db, accountId);
  const isCouples = Boolean(ent.tier && ent.tier.endsWith("_couples"));
  const asPayer = await db.prepare(`SELECT * FROM households WHERE payer_account_id = ? AND status != 'unlinked'`).bind(accountId).first();
  const asPartner = await db.prepare(`SELECT * FROM households WHERE partner_account_id = ? AND status != 'unlinked'`).bind(accountId).first();
  const household = asPayer || asPartner || null;

  let partner = null;
  if (household) {
    const partnerId = household.payer_account_id === accountId ? household.partner_account_id : household.payer_account_id;
    if (partnerId) {
      const partnerAccount = await db.prepare(`SELECT display_name, email FROM accounts WHERE id = ?`).bind(partnerId).first();
      partner = partnerAccount ? partnerAccount.display_name || partnerAccount.email : null;
    }
  }

  // D-A03/CTL-DATA-04: kids attached to this account's own id (the
  // paying adult), first name + birth year only -- same shape and same
  // table addDependant (above) writes.
  const kids = (await db.prepare(`SELECT first_name, birth_year FROM dependants WHERE household_account_id = ? ORDER BY birth_year DESC`).bind(accountId).all()).results || [];

  return { tier: ent.tier, is_couples: isCouples, partner, kids };
}

// D-A02. Idempotent (repeatable, database doctrine): linking the SAME
// pair twice returns the existing household unchanged -- no second row.
export async function linkHousehold(db, actorId, payerAccountId, partnerAccountId) {
  if (!partnerAccountId || partnerAccountId === payerAccountId) return { error: "bad_partner" };
  const payer = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(payerAccountId).first();
  const partner = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(partnerAccountId).first();
  if (!payer || !partner) return { error: "not_found" };

  const existingForPair = await db
    .prepare(`SELECT * FROM households WHERE payer_account_id = ? AND partner_account_id = ? AND status = 'active'`)
    .bind(payerAccountId, partnerAccountId)
    .first();
  if (existingForPair) return { household: existingForPair }; // same end state, no write

  const existingAny = await db
    .prepare(`SELECT id FROM households WHERE status = 'active' AND (payer_account_id = ? OR partner_account_id = ? OR payer_account_id = ? OR partner_account_id = ?)`)
    .bind(payerAccountId, payerAccountId, partnerAccountId, partnerAccountId)
    .first();
  if (existingAny) return { error: "already_linked" };

  const id = newId();
  const now = nowIso();
  const insertStmt = db
    .prepare(`INSERT INTO households (id, payer_account_id, partner_account_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, payerAccountId, partnerAccountId, "active", actorId, now, now);
  const audit = auditStatement(db, { actor: actorId, action: "household_linked", targetType: "household", targetId: id, after: { payer_account_id: payerAccountId, partner_account_id: partnerAccountId } });
  await db.batch([insertStmt, audit]);

  const household = await db.prepare(`SELECT * FROM households WHERE id = ?`).bind(id).first();
  return { household };
}

// Idempotent: unlinking an already-gone household is a no-op (same end
// state: the row does not exist either way).
export async function unlinkHousehold(db, actorId, householdId) {
  const existing = await db.prepare(`SELECT * FROM households WHERE id = ?`).bind(householdId).first();
  if (!existing) return { ok: true };
  const deleteStmt = db.prepare(`DELETE FROM households WHERE id = ?`).bind(householdId);
  const audit = auditStatement(db, { actor: actorId, action: "household_unlinked", targetType: "household", targetId: householdId, before: existing });
  await db.batch([deleteStmt, audit]);
  return { ok: true };
}

// D-A03 + CTL-DATA-04 (no child identity ever reaches `bookings`;
// CTL-AUTHZ-02 governs who may ever read this row back).
export async function addDependant(db, actorId, householdAccountId, { first_name, birth_year } = {}) {
  if (!first_name || typeof first_name !== "string" || !first_name.trim()) return { error: "bad_first_name" };
  const year = Number(birth_year);
  const nowYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < nowYear - 16 || year > nowYear) return { error: "bad_birth_year" };
  const account = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(householdAccountId).first();
  if (!account) return { error: "not_found" };

  const id = newId();
  const now = nowIso();
  const insertStmt = db
    .prepare(`INSERT INTO dependants (id, household_account_id, first_name, birth_year, created_by, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(id, householdAccountId, first_name.trim(), year, actorId, now);
  const audit = auditStatement(db, { actor: actorId, action: "dependant_added", targetType: "dependant", targetId: id, after: { household_account_id: householdAccountId, birth_year: year } });
  await db.batch([insertStmt, audit]);

  const dependant = await db.prepare(`SELECT id, first_name, birth_year FROM dependants WHERE id = ?`).bind(id).first();
  return { dependant };
}

// CTL-ROLE-02: no endpoint may ever set role='owner'. Idempotent:
// setting the same role twice leaves the same row (and writes a second,
// harmless audit row recording the no-op confirmation).
export async function setRole(db, actorId, accountId, role) {
  if (role === "owner") return { error: "owner_forbidden", status: 403 };
  if (!SETTABLE_ROLES.has(role)) return { error: "bad_role" };
  const existing = await db.prepare(`SELECT id, role FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!existing) return { error: "not_found" };
  if (existing.role === "owner") return { error: "cannot_change_owner", status: 403 };

  const updateStmt = db.prepare(`UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?`).bind(role, nowIso(), accountId);
  const audit = auditStatement(db, { actor: actorId, action: "role_set", targetType: "account", targetId: accountId, before: { role: existing.role }, after: { role } });
  await db.batch([updateStmt, audit]);

  const account = await db.prepare(`SELECT id, email, role, display_name FROM accounts WHERE id = ?`).bind(accountId).first();
  return { account };
}

// M21: `bookings`, `entitlement_grants`, `credits`/`credits_ledger`,
// `payments_mirror` and `audit_log.actor_account_id` all carry a NOT
// NULL (or FK-checked) reference to `accounts(id)`, and D1 enforces
// foreign keys on this local harness (confirmed empirically building
// this fix: a plain DELETE on an account with any such row throws
// SQLITE_CONSTRAINT_FOREIGNKEY). A hard DELETE on a real account's row
// is therefore never safe once it has any money/audit history --
// without FK enforcement it would instead leave those rows pointing at
// nothing, the same PII leak either way.
//
// So the account row stays (referential integrity for the money rows,
// anonymise-rather-than-cascade-delete per the contract) and loses its
// personal data instead: email -> a non-reachable placeholder,
// display_name -> ''. `deleted_at` marks the state. Login artifacts and
// the household/dependant PII rows are hard-deleted -- they carry no
// money reference and are personal data outright.
//
// Idempotent on STATE: a second call against an already-deleted
// account is a same-end-state no-op (reported as not_found, since
// there is nothing left here for the caller to act on).
export async function deleteAccount(db, actorId, accountId) {
  const existing = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!existing) return { error: "not_found" };
  if (existing.role === "owner") return { error: "cannot_delete_owner", status: 403 };
  if (existing.deleted_at) return { error: "not_found" }; // already anonymised -- same end state

  const now = nowIso();
  // CTL-ENV-01/02 (router.js's `demoDataAgreesWithMarker`, not this
  // part's file) fails the WHOLE preview environment closed the moment
  // any account's email stops matching `%@jp-demo.test` while
  // `is_demo=1` -- found empirically running this exact delete against
  // the preview harness (every route started returning
  // `environment_mismatch` right after). A demo account's anonymised
  // address must stay inside that same pattern; only a real
  // (non-demo) account's address is safe to move off it entirely.
  const anonymisedEmail = existing.email.endsWith("@jp-demo.test") ? `deleted-${accountId}@jp-demo.test` : `deleted-${accountId}@deleted.invalid`;
  const anonymiseAccount = db
    .prepare(`UPDATE accounts SET email = ?, display_name = '', stripe_customer_id = NULL, deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(anonymisedEmail, now, now, accountId);
  const deleteSessions = db.prepare(`DELETE FROM sessions WHERE account_id = ?`).bind(accountId);
  const deletePasskeys = db.prepare(`DELETE FROM passkeys WHERE account_id = ?`).bind(accountId);
  const deletePush = db.prepare(`DELETE FROM push_subscriptions WHERE account_id = ?`).bind(accountId);
  const deleteDependants = db.prepare(`DELETE FROM dependants WHERE household_account_id = ?`).bind(accountId);
  const deleteHouseholds = db.prepare(`DELETE FROM households WHERE payer_account_id = ? OR partner_account_id = ?`).bind(accountId, accountId);
  // The audit row names what happened without re-storing the personal
  // data it is removing (the exact finding against the previous shape,
  // which kept `before.email`) -- role only, never re-stores the email.
  const audit = auditStatement(db, { actor: actorId, action: "account_deleted", targetType: "account", targetId: accountId, before: { role: existing.role } });
  await db.batch([anonymiseAccount, deleteSessions, deletePasskeys, deletePush, deleteDependants, deleteHouseholds, audit]);
  return { ok: true };
}

// ---------- today across resources ----------

export async function todayAcrossResources(db, dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr : crDateString(new Date().toISOString());
  const dayStartUtc = `${date}T06:00:00.000Z`; // CR midnight = 06:00 UTC (fixed -06:00)
  const next = new Date(new Date(dayStartUtc).getTime() + 24 * 60 * 60 * 1000);
  const dayEndUtc = next.toISOString();

  const resources = (await db.prepare(`SELECT id, name, kind FROM resources ORDER BY kind, name`).all()).results || [];
  const resourceById = new Map(resources.map((r) => [r.id, r]));

  // M19/CTL-REF-01: a cancelled-but-refund-due booking stays on Today
  // (never just the plain `status != 'cancelled'` filter) so the owner
  // sees it and its refund link until marked refunded.
  const bookings = (await db
    .prepare(
      `SELECT b.*, a.display_name AS account_display_name
       FROM bookings b JOIN accounts a ON a.id = b.account_id
       WHERE b.start_at >= ? AND b.start_at < ? AND (b.status != 'cancelled' OR b.refund_state = 'due')
       ORDER BY b.resource_id, b.start_at`
    )
    .bind(dayStartUtc, dayEndUtc)
    .all()).results || [];

  const items = bookings.map((b) => ({
    id: b.id,
    resource_id: b.resource_id,
    resource_name: resourceById.get(b.resource_id)?.name || null,
    start_at: b.start_at,
    end_at: b.end_at,
    state: b.status === "pending_payment" ? "held" : b.status, // confirmed | held | paid_conflict | cancelled
    display_name: b.walk_in_name ? null : b.account_display_name,
    walk_in_name: b.walk_in_name,
    party_size: b.party_size,
    payment_intent_id: b.payment_intent_id,
    refund_state: b.refund_state,
    refund_url: b.payment_intent_id ? `https://dashboard.stripe.com/payments/${b.payment_intent_id}` : null,
    block: null,
  }));

  const weekday = crWeekday(dayStartUtc);
  const blocks = (await db.prepare(`SELECT * FROM blocks WHERE date = ? OR weekday = ?`).bind(date, weekday).all()).results || [];
  for (const blk of blocks) {
    if (blk.kind === "one_off" && blk.date !== date) continue;
    if (blk.kind === "weekly" && blk.weekday !== weekday) continue;
    items.push({
      id: null,
      resource_id: blk.resource_id,
      resource_name: resourceById.get(blk.resource_id)?.name || null,
      start_at: null,
      end_at: null,
      state: "blocked",
      display_name: null,
      walk_in_name: null,
      party_size: null,
      payment_intent_id: null,
      refund_url: null,
      block: { id: blk.id, weekly: blk.kind === "weekly", label: blk.label, start_time: blk.start_time, end_time: blk.end_time },
    });
  }

  return { date, items };
}

// ---------- blocks (D-A15: one-off or weekly; never bumps a booking) ----------

async function findBlockConflicts(db, resourceId, kind, weekday, dateStr, startTime, endTime) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const rows = (await db
    .prepare(`SELECT id, account_id, walk_in_name, start_at, end_at FROM bookings WHERE resource_id = ? AND status IN ('confirmed','pending_payment')`)
    .bind(resourceId)
    .all()).results || [];
  return rows
    .filter((b) => {
      if (kind === "one_off" && crDateString(b.start_at) !== dateStr) return false;
      if (kind === "weekly" && crWeekday(b.start_at) !== weekday) return false;
      const bStart = crLocalMinutesOfUtcIso(b.start_at);
      const bEnd = crLocalMinutesOfUtcIso(b.end_at) || 1440;
      return bStart < endMin && bEnd > startMin;
    })
    .map((b) => ({ id: b.id, start_at: b.start_at, end_at: b.end_at, account_id: b.account_id, walk_in_name: b.walk_in_name }));
}

export async function listBlocks(db) {
  return (await db.prepare(`SELECT * FROM blocks ORDER BY resource_id, kind`).all()).results || [];
}

// Repeatable: creating the exact same block twice returns the existing
// row instead of a second one (same end state).
export async function createBlock(db, actorId, body = {}) {
  const { resource_id, kind, weekday, date, start_time, end_time, label } = body;
  const resource = await db.prepare(`SELECT id FROM resources WHERE id = ?`).bind(resource_id).first();
  if (!resource) return { error: "resource_not_found" };
  if (kind !== "one_off" && kind !== "weekly") return { error: "bad_kind" };
  if (kind === "one_off" && !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { error: "bad_date" };
  if (kind === "weekly" && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) return { error: "bad_weekday" };
  const startMin = timeToMinutes(start_time);
  const endMin = timeToMinutes(end_time);
  if (startMin === null || endMin === null || startMin >= endMin) return { error: "bad_range" };

  const existing = await db
    .prepare(
      `SELECT * FROM blocks WHERE resource_id = ? AND kind = ? AND start_time = ? AND end_time = ?
       AND ((kind = 'one_off' AND date = ?) OR (kind = 'weekly' AND weekday = ?))`
    )
    .bind(resource_id, kind, start_time, end_time, date || null, weekday ?? null)
    .first();
  const conflicts = await findBlockConflicts(db, resource_id, kind, weekday ?? null, date || null, start_time, end_time);
  if (existing) return { block: existing, conflicts };

  const id = newId();
  const now = nowIso();
  const insertStmt = db
    .prepare(`INSERT INTO blocks (id, resource_id, kind, weekday, date, start_time, end_time, label, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, resource_id, kind, kind === "weekly" ? weekday : null, kind === "one_off" ? date : null, start_time, end_time, label || null, actorId, now);
  const audit = auditStatement(db, { actor: actorId, action: "block_created", targetType: "block", targetId: id, after: { resource_id, kind, weekday, date, start_time, end_time, label } });
  await db.batch([insertStmt, audit]);

  const block = await db.prepare(`SELECT * FROM blocks WHERE id = ?`).bind(id).first();
  return { block, conflicts };
}

export async function deleteBlock(db, actorId, blockId) {
  const existing = await db.prepare(`SELECT * FROM blocks WHERE id = ?`).bind(blockId).first();
  if (!existing) return { ok: true }; // idempotent: already gone
  const deleteStmt = db.prepare(`DELETE FROM blocks WHERE id = ?`).bind(blockId);
  const audit = auditStatement(db, { actor: actorId, action: "block_deleted", targetType: "block", targetId: blockId, before: existing });
  await db.batch([deleteStmt, audit]);
  return { ok: true };
}

// ---------- owner booking override (D-A11) ----------
//
// portal(FR1) fix: now calls booking.js's exported insertBookingAtomic
// (CTL-BOOK-01) instead of keeping its own copy of the overlap-guarded
// INSERT -- the finding below (from the original B2a2 build, when
// booking.js exported no shared insert function yet) is resolved; left
// in place as the history of why this was two writers until now. The
// audit row is written in the SAME batch, guarded by `WHERE EXISTS
// (SELECT 1 FROM bookings WHERE id=?)`, so the audit never fires for a
// booking the guarded insert did not actually create -- the whole
// activity is one transaction, all-or-nothing.
export async function ownerOverrideBooking(db, actorId, body = {}) {
  const { resource_id, start, account_id, walk_in_name, party_size } = body;
  if (Boolean(account_id) === Boolean(walk_in_name)) return { error: "bad_request" }; // exactly one of the two
  const size = party_size === undefined ? 1 : party_size;
  if (!Number.isInteger(size) || size < 1 || size > 4) return { error: "bad_party_size" };

  const resource = await db.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resource_id).first();
  if (!resource) return { error: "resource_not_found" };

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return { error: "bad_start" };
  const startIso = startDate.toISOString();
  const endIso = new Date(startDate.getTime() + resource.slot_minutes * 60000).toISOString();

  // M10/S-12: D-A11 bypasses window/entitlement/payment, never grid or
  // hours -- the override uses the SAME check createBooking does
  // (booking.js's gridAndHoursError), not a second copy of the rule.
  const gridError = gridAndHoursError(resource, startIso, endIso);
  if (gridError) return { error: gridError };

  let bookingAccountId = account_id;
  let walkInName = null;
  if (account_id) {
    const account = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(account_id).first();
    if (!account) return { error: "account_not_found" };
  } else {
    bookingAccountId = actorId; // CTL-DATA-02: a walk-in is owned by the acting owner's own account
    walkInName = walk_in_name;
  }

  // D-A11 respects an existing block (cancel it first; never bumps it).
  const startMin = crLocalMinutesOfUtcIso(startIso);
  const endMinRaw = crLocalMinutesOfUtcIso(endIso);
  const endMin = endMinRaw === 0 ? 1440 : endMinRaw;
  const dateStr = crDateString(startIso);
  const weekday = crWeekday(startIso);
  const blocked = await db
    .prepare(
      `SELECT 1 FROM blocks WHERE resource_id = ? AND start_time < ? AND end_time > ?
       AND ((kind = 'one_off' AND date = ?) OR (kind = 'weekly' AND weekday = ?))`
    )
    .bind(resource_id, minutesToTime(endMin), minutesToTime(startMin), dateStr, weekday)
    .first();
  if (blocked) return { error: "blocked" };

  const now = nowIso();
  // CTL-BOOK-01: the one shared overlap-guarded insert (booking.js),
  // never a second copy of the SQL here. An override never spends
  // credits (requiredCredits 0) and is always 'confirmed'/'override'.
  const { id, statement: insertBookingStmt } = insertBookingAtomic(db, {
    accountId: bookingAccountId,
    resourceId: resource_id,
    offeringId: null,
    startIso,
    endIso,
    partySize: size,
    freeKids: 0,
    status: "confirmed",
    paymentMode: "override",
    holdExpiresAt: null,
    creditsSpent: 0,
    walkInName,
    createdBy: actorId,
    createdAt: now,
    requiredCredits: 0,
  });
  // The audit row must see the SAME outcome the guarded insert above
  // either did or didn't produce -- auditStatement() (audit.js) builds a
  // plain, unconditional INSERT, so it isn't used here. This statement
  // repeats that same shape with its own `WHERE EXISTS` guard instead of
  // editing audit.js (not this part's file) to add a conditional variant.
  const guardedAudit = db
    .prepare(
      `INSERT INTO audit_log (id, actor_account_id, action, target_type, target_id, before, after, at)
       SELECT ?, ?, ?, ?, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)`
    )
    .bind(newId(), actorId, "owner_override_booking", "booking", id, JSON.stringify({ resource_id, start_at: startIso, end_at: endIso, account_id: bookingAccountId, walk_in_name: walkInName, party_size: size }), now, id);
  // M20/PIN-13: the calendar_outbox row rides in the SAME batch as the
  // booking write and its audit row -- same guard shape (WHERE EXISTS
  // the booking actually landed), so a routine slot_taken 409 still
  // writes nothing instead of throwing an FK violation.
  const outboxStmt = guardedOutboxInsertStatement(db, { bookingId: id, action: "create", resourceId: resource_id, payload: { booking_id: id }, requireStatus: "confirmed" });
  await db.batch([insertBookingStmt, guardedAudit, outboxStmt]);

  const created = await db.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!created) return { error: "slot_taken" };
  return { booking: created };
}

function minutesToTime(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ---------- refunds due (M19/CTL-REF-01) ----------

// Every cancelled booking still carrying refund_state='due', oldest
// first -- the owner's worklist until each is marked refunded in the
// Stripe dashboard (PIN-11: the refund itself is never automatic).
export async function listRefundsDue(db) {
  const rows = (await db
    .prepare(
      `SELECT b.id, b.resource_id, r.name AS resource_name, b.start_at, b.end_at, b.party_size,
              b.payment_intent_id, b.cancelled_at, a.display_name AS account_display_name, b.walk_in_name
       FROM bookings b
       JOIN resources r ON r.id = b.resource_id
       JOIN accounts a ON a.id = b.account_id
       WHERE b.refund_state = 'due'
       ORDER BY b.cancelled_at ASC`
    )
    .all()).results || [];
  return rows.map((b) => ({
    id: b.id,
    resource_id: b.resource_id,
    resource_name: b.resource_name,
    start_at: b.start_at,
    end_at: b.end_at,
    party_size: b.party_size,
    display_name: b.walk_in_name ? null : b.account_display_name,
    walk_in_name: b.walk_in_name,
    cancelled_at: b.cancelled_at,
    payment_intent_id: b.payment_intent_id,
    refund_url: b.payment_intent_id ? `https://dashboard.stripe.com/payments/${b.payment_intent_id}` : null,
  }));
}

// Idempotent: marking an already-refunded (or never-due) booking is a
// same-end-state no-op, never a second audit row.
export async function markRefunded(db, actorId, bookingId) {
  const existing = await db.prepare(`SELECT id, refund_state FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!existing) return { error: "not_found" };
  if (existing.refund_state !== "due") return { ok: true };

  const now = nowIso();
  const updateStmt = db
    .prepare(`UPDATE bookings SET refund_state = 'refunded', updated_at = ? WHERE id = ? AND refund_state = 'due'`)
    .bind(now, bookingId);
  const audit = auditStatement(db, { actor: actorId, action: "refund_marked", targetType: "booking", targetId: bookingId, before: { refund_state: "due" }, after: { refund_state: "refunded" } });
  await db.batch([updateStmt, audit]);
  return { ok: true };
}

// ---------- outbox / overlaps ----------

export async function outboxFailures(db) {
  return outboxSummary(db); // reuses the one existing reader (database doctrine: no second copy)
}

export async function listOverlaps(db) {
  const rows = (await db.prepare(`SELECT id, email, display_name FROM accounts`).all()).results || [];
  const out = [];
  for (const r of rows) {
    const grants = await validGrants(db, r.id);
    const sources = [...new Set(grants.map((g) => g.source))];
    if (sources.length > 1) {
      const ent = await resolveEntitlement(db, r.id);
      out.push({ id: r.id, email: r.email, display_name: r.display_name, tier: ent.tier, sources });
    }
  }
  return out;
}

// FINDING, named per B2-COMMON.md's rule ("if you need a change in a
// file you do not own, stop and report it, never edit it yourself"):
// `GET /api/portal/owner/health` already returns `outbox` per
// docs/portal/api.md §4, but the route is registered in B1's
// `router.js` (B1_ROUTES) and its handler, `ownerHealth`, lives in B1's
// `auth.js` -- neither file is in this part's exclusive list. This file
// cannot append `outbox` to that response without editing one of them.
// The exact change needed: in `src/portal/auth.js`'s `ownerHealth`,
// import `outboxSummary` from `./outbox.js` and add
// `outbox: await outboxSummary(db)` to the returned object. Until B1 (or
// a fix dispatch) makes that one-line change, `GET /api/portal/owner/
// health` is missing `outbox` and `GET /api/portal/owner/outbox` (this
// file, fully built) is the only place that data is available.
