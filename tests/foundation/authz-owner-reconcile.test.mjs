// M4 (S-3, PIN-7): an account that is `role='owner'` in storage but
// whose email is no longer in OWNER_EMAILS (exactly the state an
// address removed from that list leaves behind) must lose owner
// authority on reconcileOwnerRole()'s very next call, not only at
// login, and every session for that account must be revoked with it.
//
// Harness note: this scenario is production-only by construction (a
// real, non-demo OWNER_EMAILS owner) and src/portal/router.js's own
// environment gate (CTL-ENV-02) refuses every request for a non-demo
// account under this suite's preview marker/localhost host -- there is
// no way to reach the authorize() layer for such an account over HTTP
// in this harness (an F-14-class limit). reconcileOwnerRole is
// therefore proven directly, as controls.md's own exemption allows for
// a pure-function check, against a minimal fake D1 that records every
// statement it runs so the probe shows exactly what fired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOwnerRole } from "../../src/portal/auth.js";

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              calls.push({ sql, args });
              if (/SELECT .* FROM entitlement_grants|SELECT .* FROM credits/.test(sql)) return null;
              return null;
            },
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
            async all() {
              calls.push({ sql, args });
              return { results: [] }; // no live grants -> resolveEntitlement sees entitled:false
            },
          };
        },
      };
    },
  };
}

test("M4 RED->GREEN: reconcileOwnerRole demotes and revokes sessions when the email is no longer in OWNER_EMAILS", async () => {
  const db = fakeDb();
  const account = { id: "acct-m4-1", email: "exec@junglepickleball.com", role: "owner", is_demo: 0 };
  const env = { OWNER_EMAILS: "roger@junglepickleball.com", envClass: "production" }; // the account's email is absent

  const { wasOwner, nowOwner } = await reconcileOwnerRole(db, env, account);

  assert.equal(wasOwner, true, "the account entered as owner");
  assert.equal(nowOwner, false, "GREEN: an email absent from OWNER_EMAILS is demoted");
  assert.equal(account.role, "guest", "no entitlement grants -> guest, not member");

  const updatedRole = db.calls.some((c) => /UPDATE accounts SET role/.test(c.sql) && c.args[0] !== "owner");
  assert.equal(updatedRole, true, "the account row's role must actually be written, not just the in-memory object");

  const revoked = db.calls.some((c) => /DELETE FROM sessions WHERE account_id/.test(c.sql));
  assert.equal(revoked, true, "GREEN: every session for the demoted account must be revoked (S-3), not just this one");
});

test("M4 control: an email still in OWNER_EMAILS stays owner and revokes nothing", async () => {
  const db = fakeDb();
  const account = { id: "acct-m4-2", email: "roger@junglepickleball.com", role: "owner", is_demo: 0 };
  const env = { OWNER_EMAILS: "roger@junglepickleball.com", envClass: "production" };

  const { wasOwner, nowOwner } = await reconcileOwnerRole(db, env, account);
  assert.equal(wasOwner, true);
  assert.equal(nowOwner, true, "still listed -> still owner");
  assert.equal(account.role, "owner");
  assert.equal(db.calls.length, 0, "role unchanged -> no write, no session revoke");
});

test("M4 demo exception: a seeded is_demo owner in preview keeps owner even though OWNER_EMAILS is empty", async () => {
  const db = fakeDb();
  const account = { id: "acct-m4-3", email: "owner.demo@jp-demo.test", role: "owner", is_demo: 1 };
  const env = { OWNER_EMAILS: "", envClass: "preview" };

  const { nowOwner } = await reconcileOwnerRole(db, env, account);
  assert.equal(nowOwner, true, "S-3's explicit preview exception for seeded demo owners");
  assert.equal(account.role, "owner");
  assert.equal(db.calls.length, 0);
});
