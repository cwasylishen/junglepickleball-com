// Owned by B2a2 (amendment 5 build cut, B1-fix amendment 6). The
// owner/staff ops routes from docs/portal/api.md §4 -- this file alone,
// never src/portal/router.js, which only imports and concatenates this
// array. Same entry shape as router.js's own B1_ROUTES.

import { json } from "../http.js";
import { stripPrivilegedFields } from "../authz.js";
import { nowIso } from "../db.js";
import {
  listOwnerResources,
  createResource,
  updateResource,
  confirmResourceField,
  listOfferings,
  createOffering,
  updateOffering,
  deleteOffering,
} from "../resources.js";
import {
  listAccounts,
  getAccountDetail,
  handGrantEntitlement,
  endHandGrant,
  getOwnHousehold,
  linkHousehold,
  unlinkHousehold,
  addDependant,
  setRole,
  deleteAccount,
  todayAcrossResources,
  listBlocks,
  createBlock,
  deleteBlock,
  ownerOverrideBooking,
  outboxFailures,
  listOverlaps,
  listRefundsDue,
  markRefunded,
} from "../owner.js";
import { staffCalendar } from "../staff.js";

// Maps a handler's { error } result to its documented HTTP status. Most
// are 400/404/409; a handler may override with its own `status`.
const ERROR_STATUS = {
  not_found: 404,
  resource_not_found: 404,
  account_not_found: 404,
  already_linked: 409,
  blocked: 409,
  slot_taken: 409,
};

function errorResponse(result) {
  const status = result.status || ERROR_STATUS[result.error] || 400;
  return json({ error: result.error }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---------- PATCH /me (CTL-AUTHZ-03: only display_name, ever) ----------

async function patchMe(ctx) {
  const body = await readJson(ctx.request);
  const safe = stripPrivilegedFields(body); // drops role/is_demo/email/credits/stripe_customer_id
  const displayName = typeof safe.display_name === "string" ? safe.display_name.trim().slice(0, 120) : undefined;
  if (displayName === undefined) {
    const account = await ctx.db.prepare(`SELECT id, email, role, display_name FROM accounts WHERE id = ?`).bind(ctx.account.id).first();
    return json({ account });
  }
  await ctx.db.prepare(`UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?`).bind(displayName, nowIso(), ctx.account.id).run();
  const account = await ctx.db.prepare(`SELECT id, email, role, display_name FROM accounts WHERE id = ?`).bind(ctx.account.id).first();
  return json({ account });
}

// ---------- accounts ----------

async function getAccounts(ctx) {
  return json(await listAccounts(ctx.db));
}

async function getAccountById(ctx) {
  const detail = await getAccountDetail(ctx.db, ctx.params.id);
  if (!detail) return json({ error: "not_found" }, 404);
  return json(detail);
}

async function postGrant(ctx) {
  const body = await readJson(ctx.request);
  const result = await handGrantEntitlement(ctx.db, ctx.account.id, ctx.params.id, body);
  if (result.error) return errorResponse(result);
  return json({ grant: result.grant }, 201);
}

async function postEndGrant(ctx) {
  const result = await endHandGrant(ctx.db, ctx.account.id, ctx.params.id, ctx.params.grantId);
  if (result.error) return errorResponse(result);
  return json({ grant: result.grant });
}

async function getMyHousehold(ctx) {
  return json(await getOwnHousehold(ctx.db, ctx.account.id));
}

async function postHouseholdLink(ctx) {
  const body = await readJson(ctx.request);
  const result = await linkHousehold(ctx.db, ctx.account.id, ctx.params.id, body.partner_account_id);
  if (result.error) return errorResponse(result);
  return json({ household: result.household });
}

async function deleteHousehold(ctx) {
  await unlinkHousehold(ctx.db, ctx.account.id, ctx.params.id);
  return json({ ok: true });
}

async function postDependant(ctx) {
  const body = await readJson(ctx.request);
  const result = await addDependant(ctx.db, ctx.account.id, ctx.params.id, body);
  if (result.error) return errorResponse(result);
  return json({ dependant: result.dependant }, 201);
}

async function patchRole(ctx) {
  const body = await readJson(ctx.request);
  const result = await setRole(ctx.db, ctx.account.id, ctx.params.id, body.role);
  if (result.error) return errorResponse(result);
  return json({ account: result.account });
}

async function deleteAccountRoute(ctx) {
  const result = await deleteAccount(ctx.db, ctx.account.id, ctx.params.id);
  if (result.error) return errorResponse(result);
  return json({ ok: true });
}

// ---------- today ----------

async function getToday(ctx) {
  const date = ctx.url.searchParams.get("date");
  const result = await todayAcrossResources(ctx.db, date);
  return json(result);
}

// ---------- resources / offerings ----------

async function getOwnerResources(ctx) {
  return json(await listOwnerResources(ctx.db));
}

async function postOwnerResource(ctx) {
  const body = await readJson(ctx.request);
  const result = await createResource(ctx.db, ctx.account.id, body);
  if (result.error) return errorResponse(result);
  return json({ resource: result.resource }, 201);
}

async function patchOwnerResource(ctx) {
  const body = await readJson(ctx.request);
  const result = await updateResource(ctx.db, ctx.account.id, ctx.params.id, body);
  if (result.error) return errorResponse(result);
  return json({ resource: result.resource, misfits: result.misfits });
}

async function postConfirmField(ctx) {
  const body = await readJson(ctx.request);
  const result = await confirmResourceField(ctx.db, ctx.account.id, ctx.params.id, body.field);
  if (result.error) return errorResponse(result);
  return json({ ok: true });
}

async function getOfferings(ctx) {
  return json(await listOfferings(ctx.db, ctx.params.id));
}

async function getOfferingById(ctx) {
  const offerings = await listOfferings(ctx.db, ctx.params.id);
  const offering = offerings.find((o) => o.id === ctx.params.offeringId);
  if (!offering) return json({ error: "not_found" }, 404);
  return json({ offering });
}

async function postOffering(ctx) {
  const body = await readJson(ctx.request);
  const result = await createOffering(ctx.db, ctx.account.id, ctx.params.id, body);
  if (result.error) return errorResponse(result);
  return json({ offering: result.offering }, 201);
}

async function patchOffering(ctx) {
  const body = await readJson(ctx.request);
  const result = await updateOffering(ctx.db, ctx.account.id, ctx.params.id, ctx.params.offeringId, body);
  if (result.error) return errorResponse(result);
  return json({ offering: result.offering });
}

async function deleteOfferingRoute(ctx) {
  const result = await deleteOffering(ctx.db, ctx.account.id, ctx.params.id, ctx.params.offeringId);
  if (result.error) return errorResponse(result);
  return json({ ok: true });
}

// ---------- blocks ----------

async function getBlocks(ctx) {
  return json(await listBlocks(ctx.db));
}

async function postBlock(ctx) {
  const body = await readJson(ctx.request);
  const result = await createBlock(ctx.db, ctx.account.id, body);
  if (result.error) return errorResponse(result);
  return json({ block: result.block, conflicts: result.conflicts }, 201);
}

async function deleteBlockRoute(ctx) {
  await deleteBlock(ctx.db, ctx.account.id, ctx.params.id);
  return json({ ok: true });
}

// ---------- owner booking override ----------

async function postOwnerBooking(ctx) {
  const body = await readJson(ctx.request);
  const result = await ownerOverrideBooking(ctx.db, ctx.account.id, body);
  if (result.error) return errorResponse(result);
  return json({ booking: result.booking }, 201);
}

// ---------- refunds due (M19/CTL-REF-01) ----------

async function getRefundsDue(ctx) {
  return json(await listRefundsDue(ctx.db));
}

async function postMarkRefunded(ctx) {
  const result = await markRefunded(ctx.db, ctx.account.id, ctx.params.id);
  if (result.error) return errorResponse(result);
  return json({ ok: true });
}

// ---------- outbox / overlaps ----------

async function getOutbox(ctx) {
  return json(await outboxFailures(ctx.db));
}

async function getOverlaps(ctx) {
  return json(await listOverlaps(ctx.db));
}

// ---------- staff calendar ----------

async function getStaffCalendar(ctx) {
  const date = ctx.url.searchParams.get("date");
  const resourceIdParam = ctx.url.searchParams.get("resource_id"); // CTL-STF-01 probe: must be refused, not ignored
  const result = await staffCalendar(ctx.db, ctx.account.id, date, resourceIdParam);
  if (result.error) return errorResponse(result);
  return json(result.events ? result.events : []);
}

export const ROUTES = [
  { method: "PATCH", path: "/api/portal/me", class: "own", handler: patchMe },
  { method: "GET", path: "/api/portal/me/household", class: "own", handler: getMyHousehold },

  { method: "GET", path: "/api/portal/owner/accounts", class: "owner", handler: getAccounts },
  { method: "GET", path: "/api/portal/owner/accounts/:id", class: "owner", handler: getAccountById },
  { method: "POST", path: "/api/portal/owner/accounts/:id/grant", class: "owner", handler: postGrant },
  { method: "POST", path: "/api/portal/owner/accounts/:id/grants/:grantId/end", class: "owner", handler: postEndGrant },
  { method: "POST", path: "/api/portal/owner/accounts/:id/household-link", class: "owner", handler: postHouseholdLink },
  { method: "DELETE", path: "/api/portal/owner/households/:id", class: "owner", handler: deleteHousehold },
  { method: "POST", path: "/api/portal/owner/accounts/:id/dependants", class: "owner", handler: postDependant },
  { method: "PATCH", path: "/api/portal/owner/accounts/:id/role", class: "owner", handler: patchRole },
  { method: "DELETE", path: "/api/portal/owner/accounts/:id", class: "owner", handler: deleteAccountRoute },

  { method: "GET", path: "/api/portal/owner/today", class: "owner", handler: getToday },

  { method: "GET", path: "/api/portal/owner/resources", class: "owner", handler: getOwnerResources },
  { method: "POST", path: "/api/portal/owner/resources", class: "owner", handler: postOwnerResource },
  { method: "PATCH", path: "/api/portal/owner/resources/:id", class: "owner", handler: patchOwnerResource },
  { method: "POST", path: "/api/portal/owner/resources/:id/confirm-field", class: "owner", handler: postConfirmField },
  { method: "GET", path: "/api/portal/owner/resources/:id/offerings", class: "owner", handler: getOfferings },
  { method: "GET", path: "/api/portal/owner/resources/:id/offerings/:offeringId", class: "owner", handler: getOfferingById },
  { method: "POST", path: "/api/portal/owner/resources/:id/offerings", class: "owner", handler: postOffering },
  { method: "PATCH", path: "/api/portal/owner/resources/:id/offerings/:offeringId", class: "owner", handler: patchOffering },
  { method: "DELETE", path: "/api/portal/owner/resources/:id/offerings/:offeringId", class: "owner", handler: deleteOfferingRoute },

  { method: "GET", path: "/api/portal/owner/blocks", class: "owner", handler: getBlocks },
  { method: "POST", path: "/api/portal/owner/blocks", class: "owner", handler: postBlock },
  { method: "DELETE", path: "/api/portal/owner/blocks/:id", class: "owner", handler: deleteBlockRoute },

  { method: "POST", path: "/api/portal/owner/bookings", class: "owner", handler: postOwnerBooking },

  { method: "GET", path: "/api/portal/owner/refunds-due", class: "owner", handler: getRefundsDue },
  { method: "POST", path: "/api/portal/owner/bookings/:id/mark-refunded", class: "owner", handler: postMarkRefunded },

  { method: "GET", path: "/api/portal/owner/outbox", class: "owner", handler: getOutbox },
  { method: "GET", path: "/api/portal/owner/overlaps", class: "owner", handler: getOverlaps },

  { method: "GET", path: "/api/portal/staff/calendar", class: "staff-own", handler: getStaffCalendar },
];
