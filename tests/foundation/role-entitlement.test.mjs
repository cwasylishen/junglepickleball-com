// CTL-ROLE-03: booking/audience rules read the entitlement resolver,
// never `role` -- a staff (or owner) account that holds a grant must
// show as entitled exactly like a member would. Full "staff books a
// court as included" is B2a1's booking.js; this proves the resolver
// half, which is B1's (src/portal/entitlement.js), through the one
// B1-owned endpoint that surfaces it (`GET /api/portal/me`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo } from "./helpers.mjs";

test("CTL-ROLE-03: a staff account with a hand grant resolves as entitled, same as a member would", async () => {
  d1(
    `INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, note, created_at, updated_at)
     VALUES ('role03-grant-1', 'demo-staff-0000-0000-000000000002', 'hand', 'jp_1m_single', datetime('now','-1 day'), datetime('now','+1 month'), 'active', 'demo-owner-0000-0000-000000000001', 'test grant', datetime('now'), datetime('now'))`
  );
  try {
    const { client } = await loginDemo("staff.demo@jp-demo.test");
    const me = await client.get("/api/portal/me");
    // RED: a rule that reads `account.role === 'member'` instead of the
    // resolver would show this staff account as not entitled, even
    // though it holds a perfectly valid grant.
    assert.equal(me.data.entitlement.entitled, true);
    assert.equal(me.data.entitlement.tier, "jp_1m_single");
    assert.equal(me.data.account.role, "staff", "the grant must not change the account's role");
  } finally {
    d1(`DELETE FROM entitlement_grants WHERE id = 'role03-grant-1'`);
  }
});
