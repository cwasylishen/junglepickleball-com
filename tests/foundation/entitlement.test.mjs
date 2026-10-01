// CTL-ENT-01 (the §2 P-1..P-7 table) and CTL-ENT-02 (the audience enum).
// controls.md's own probe for both is a pure table test against the
// resolver, so this uses a minimal fake D1 rather than a live binding --
// resolveEntitlement/resolveAudience only ever call `db.prepare(sql)
// .bind(...).first()/.all()`, which is all this fake implements.
//
// RED for every case: a single-column "last writer wins" implementation
// (the thing CTL-ENT-01 exists to remove) fails (i) and (ii) below,
// because it would look at only the most-recently-updated row, not
// "any valid grant from any source".

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEntitlement, resolveAudience } from "../../src/portal/entitlement.js";

const NOW = "2026-10-01T00:00:00.000Z";

function fakeDb(grants, households = []) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (sql.includes("FROM entitlement_grants")) {
                return { results: grants.filter((g) => g.account_id === args[0]) };
              }
              return { results: [] };
            },
            async first() {
              if (sql.includes("FROM households")) {
                return households.find((h) => h.partner_account_id === args[0] && h.status === "active") || null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

test("CTL-ENT-01 (i): Stripe ended + a valid hand grant -> still entitled", async () => {
  const db = fakeDb([
    { id: "g1", account_id: "a1", source: "stripe", tier: "jp_1m_single", stripe_status: "canceled", starts_at: "2026-01-01", ends_at: "2026-02-01", status: "ended" },
    { id: "g2", account_id: "a1", source: "hand", tier: "jp_annual_single", starts_at: "2026-01-01", ends_at: "2027-01-01", status: "active" },
  ]);
  const r = await resolveEntitlement(db, "a1", NOW);
  assert.equal(r.entitled, true);
  assert.equal(r.tier, "jp_annual_single");
});

test("CTL-ENT-01 (ii): hand grant ended + Stripe active -> entitled via Stripe", async () => {
  const db = fakeDb([
    { id: "g1", account_id: "a1", source: "hand", tier: "jp_annual_single", starts_at: "2025-01-01", ends_at: "2025-06-01", status: "active" },
    { id: "g2", account_id: "a1", source: "stripe", tier: "jp_1m_single", stripe_status: "active", starts_at: "2026-09-01", ends_at: null, status: "active" },
  ]);
  const r = await resolveEntitlement(db, "a1", NOW);
  assert.equal(r.entitled, true);
  assert.equal(r.tier, "jp_1m_single");
});

test("CTL-ENT-01 (iii) / CTL-ENT-02: an annual hand grant plus a 1m Stripe grant prices the plunge at $0 (included), not $10", async () => {
  const db = fakeDb([
    { id: "g1", account_id: "a1", source: "hand", tier: "jp_annual_single", starts_at: "2026-01-01", ends_at: "2027-01-01", status: "active" },
    { id: "g2", account_id: "a1", source: "stripe", tier: "jp_1m_single", stripe_status: "active", starts_at: "2026-09-01", ends_at: null, status: "active" },
  ]);
  const resource = { kind: "plunge" };
  const offerings = [
    { id: "o-annual", resource_id: "r1", audience: "member_annual", lookup_key: null, display_price_cents: 0, active: 1 },
    { id: "o-member", resource_id: "r1", audience: "member_other", lookup_key: "plunge_member", display_price_cents: 1000, active: 1 },
    { id: "o-guest", resource_id: "r1", audience: "guest", lookup_key: "plunge_guest", display_price_cents: 1500, active: 1 },
  ];
  const audience = await resolveAudience(db, "a1", resource, offerings, null, NOW);
  assert.equal(audience.mode, "included");
  assert.equal(audience.unit_cents, 0);
});

test("CTL-ENT-01 (iv): two valid grants from different sources are reported as an overlap", async () => {
  const db = fakeDb([
    { id: "g1", account_id: "a1", source: "hand", tier: "jp_1m_single", starts_at: "2026-09-01", ends_at: "2026-11-01", status: "active" },
    { id: "g2", account_id: "a1", source: "stripe", tier: "jp_1m_single", stripe_status: "active", starts_at: "2026-09-01", ends_at: null, status: "active" },
  ]);
  const r = await resolveEntitlement(db, "a1", NOW);
  assert.equal(r.overlap, true);
});

test("CTL-ENT-01 (v): unlinking a household partner removes their entitlement on the next read", async () => {
  const payerGrant = { id: "g1", account_id: "payer", source: "hand", tier: "jp_annual_couples", starts_at: "2026-01-01", ends_at: "2027-01-01", status: "active" };
  const linked = fakeDb([payerGrant], [{ id: "h1", payer_account_id: "payer", partner_account_id: "partner", status: "active" }]);
  const beforeUnlink = await resolveEntitlement(linked, "partner", NOW);
  assert.equal(beforeUnlink.entitled, true);

  const unlinked = fakeDb([payerGrant], [{ id: "h1", payer_account_id: "payer", partner_account_id: "partner", status: "unlinked" }]);
  const afterUnlink = await resolveEntitlement(unlinked, "partner", NOW);
  assert.equal(afterUnlink.entitled, false);
});

test("CTL-ENT-02: the audience decision is an enum -- guest, 1m member, and a resource with no price set", async () => {
  const resource = { kind: "plunge" };
  const offeringsNoGuestPrice = [
    { id: "o-annual", audience: "member_annual", lookup_key: null, display_price_cents: 0, active: 1 },
    { id: "o-member", audience: "member_other", lookup_key: "plunge_member", display_price_cents: 1000, active: 1 },
    // no 'guest' offering at all -- not_bookable, never a falsy-price guess.
  ];
  const guestDb = fakeDb([]);
  const guestResult = await resolveAudience(guestDb, "guest-account", resource, offeringsNoGuestPrice, null, NOW);
  assert.equal(guestResult.mode, "not_bookable");
  assert.equal(guestResult.reason, "price_not_set");

  const memberDb = fakeDb([{ id: "g1", account_id: "m1", source: "hand", tier: "jp_1m_single", starts_at: "2026-09-01", ends_at: "2026-11-01", status: "active" }]);
  const offerings = [
    { id: "o-annual", audience: "member_annual", lookup_key: null, display_price_cents: 0, active: 1 },
    { id: "o-member", audience: "member_other", lookup_key: "plunge_member", display_price_cents: 1000, active: 1 },
    { id: "o-guest", audience: "guest", lookup_key: "plunge_guest", display_price_cents: 1500, active: 1 },
  ];
  const memberResult = await resolveAudience(memberDb, "m1", resource, offerings, null, NOW);
  assert.equal(memberResult.mode, "pay");
  assert.equal(memberResult.lookup_key, "plunge_member");

  // A massage offering with no lookup_key (price not yet set by the
  // owner) must never silently become "included" or free.
  const massageResource = { kind: "massage" };
  const massageOfferings = [{ id: "m60", audience: "everyone", lookup_key: null, display_price_cents: null, active: 1 }];
  const massageResult = await resolveAudience(fakeDb([]), "guest-account", massageResource, massageOfferings, "m60", NOW);
  assert.equal(massageResult.mode, "not_bookable");
  assert.equal(massageResult.reason, "price_not_set");
});
