// The entitlement resolver (CTL-ENT-01/§2, CTL-ENT-02). This is the ONLY
// place that decides whether an account is entitled, and to what tier.
// Every reader (booking, audience pricing, window rules, Billing, role
// re-derivation) calls through here -- never a cached role or session
// field, and never a price value tested for truthiness.
//
// P-1..P-7 (controls.md §2) are implemented exactly as ranked there.
// Changing the ranking is a one-function change, by design.

const TIER_RANK = { jp_annual_single: 4, jp_annual_couples: 4, jp_6m_single: 3, jp_6m_couples: 3, jp_3m_single: 2, jp_3m_couples: 2, jp_1m_single: 1 };
const STRIPE_LIVE_STATUSES = new Set(["active", "trialing", "past_due"]); // D-A09

function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

function isAnnualTier(tier) {
  return tier === "jp_annual_single" || tier === "jp_annual_couples";
}

// P-1: a grant is valid only inside its own dates and status.
function isValidRow(row, nowIso) {
  if (row.status !== "active") return false;
  if (row.starts_at && row.starts_at > nowIso) return false;
  if (row.ends_at && row.ends_at <= nowIso) return false;
  if ((row.source === "stripe" || row.source === "email_link") && row.stripe_status) {
    if (!STRIPE_LIVE_STATUSES.has(row.stripe_status)) return false;
  }
  return true;
}

// Returns every valid grant row for an account, each tagged with its own
// source (P-2: a source can end only its own grants -- this resolver
// never merges them into one field).
export async function validGrants(db, accountId, at = new Date().toISOString()) {
  const rows = (await db.prepare(`SELECT * FROM entitlement_grants WHERE account_id = ?`).bind(accountId).all()).results || [];
  const direct = rows.filter((r) => r.source !== "household" && isValidRow(r, at));

  // P-5: a household partner's grant derives from the payer's own valid
  // grant and ends with it or with the unlink. No Stripe customer of
  // their own, so Billing never resolves to the payer (CTL-STR-03, owned
  // by B2b; this resolver only supplies the entitlement fact).
  const household = await db
    .prepare(`SELECT * FROM households WHERE partner_account_id = ? AND status = 'active'`)
    .bind(accountId)
    .first();
  let householdGrant = null;
  if (household) {
    const payerGrants = (await db.prepare(`SELECT * FROM entitlement_grants WHERE account_id = ? AND source != 'household'`).bind(household.payer_account_id).all()).results || [];
    const payerValid = payerGrants.filter((r) => isValidRow(r, at)).sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
    if (payerValid) {
      householdGrant = { ...payerValid, id: `household:${household.id}`, account_id: accountId, source: "household" };
    }
  }

  return householdGrant ? [...direct, householdGrant] : direct;
}

// P-3/P-4/P-7: the account is entitled if any valid grant exists; the
// effective tier is the most favourable one; two-or-more different
// sources is an `overlap`, reported, never auto-resolved.
export async function resolveEntitlement(db, accountId, at = new Date().toISOString()) {
  const grants = await validGrants(db, accountId, at);
  if (grants.length === 0) return { entitled: false, tier: null, grants: [], overlap: false };
  const best = grants.slice().sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
  const distinctSources = new Set(grants.map((g) => g.source));
  return { entitled: true, tier: best.tier, grants, overlap: distinctSources.size > 1 };
}

// CTL-ENT-02: the audience decision is an enum, never a number. One of
// `included`, `credits(n)` (left to booking.js/B2a1, which knows
// party_size), `pay(lookup_key, quantity)` or `not_bookable(reason)`.
//
// resource: a row from `resources`. offerings: every row from
// `offerings` for that resource (so the caller loads once, resolves many
// times). offeringId is required for massage (duration choice); ignored
// for court/plunge, which pick their own offering by audience.
export async function resolveAudience(db, accountId, resource, offerings, offeringId = null, at = new Date().toISOString()) {
  const entitlement = await resolveEntitlement(db, accountId, at);
  return audienceFor(entitlement, resource, offerings, offeringId);
}

// The decision itself, once the entitlement is known. The quote, the
// booking and the resource list (what each screen shows a caller) all take
// their answer from this one function, so a screen can never show a price
// or an "Included" the confirm step then contradicts.
export function audienceFor(entitlement, resource, offerings, offeringId = null) {
  if (resource.kind === "court") {
    if (entitlement.entitled) return { mode: "included", unit_cents: 0, tier: entitlement.tier };
    const offering = offerings.find((o) => o.audience === "everyone" && o.active);
    if (!offering || !offering.lookup_key) return { mode: "not_bookable", reason: "price_not_set" };
    return { mode: "pay", lookup_key: offering.lookup_key, offering_id: offering.id, unit_cents: offering.display_price_cents };
  }

  if (resource.kind === "massage") {
    const offering = offerings.find((o) => o.id === offeringId && o.active);
    if (!offering) return { mode: "not_bookable", reason: "offering_not_found" };
    if (!offering.lookup_key) return { mode: "not_bookable", reason: "price_not_set" };
    return { mode: "pay", lookup_key: offering.lookup_key, offering_id: offering.id, unit_cents: offering.display_price_cents };
  }

  if (resource.kind === "plunge") {
    let audience = "guest";
    if (entitlement.entitled) audience = isAnnualTier(entitlement.tier) ? "member_annual" : "member_other";
    const offering = offerings.find((o) => o.audience === audience && o.active);
    if (!offering) return { mode: "not_bookable", reason: "price_not_set" };
    if (audience === "member_annual") return { mode: "included", unit_cents: 0, tier: entitlement.tier, offering_id: offering.id };
    if (!offering.lookup_key) return { mode: "not_bookable", reason: "price_not_set" };
    return { mode: "pay", lookup_key: offering.lookup_key, offering_id: offering.id, unit_cents: offering.display_price_cents };
  }

  return { mode: "not_bookable", reason: "unknown_resource_kind" };
}

// S-3/CTL-ROLE-03: role re-derivation at login reads OWNER_EMAILS, never
// entitlement. This export exists so auth.js and this module stay the
// two places that ever decide "owner", never a third.
export function isOwnerEmail(email, ownerEmailsVar) {
  const entries = (ownerEmailsVar || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const candidate = String(email || "").trim().toLowerCase();
  if (!candidate || !/^[\x00-\x7F]+$/.test(candidate)) return false; // CTL-ROLE-01: pure ASCII only
  return entries.includes(candidate);
}
