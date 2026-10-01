// N2 (inspection-2.md): reconcileOwnerRole's per-request call
// (router.js, every authenticated request) must DEMOTE mid-session
// (M4/S-3) but must never PROMOTE mid-session -- promotion is a
// login-only event (S-3), audited `owner_promoted`, and only a login
// mints the owner's 7-day session (S-5). Before this fix,
// reconcileOwnerRole took no third argument at all, so ANY call --
// including the per-request one -- promoted the instant an account's
// email appeared in OWNER_EMAILS, mid-session, with no audit row and
// no session re-mint.
//
// Harness note (same F-14-class limit M4's own test documents): a real,
// non-demo OWNER_EMAILS account cannot reach authorize() over HTTP in
// this suite (CTL-ENV-02's environment gate refuses it under the
// preview/localhost marker this harness always runs under), so the
// function is proven directly against a fake D1, exactly as M4's test
// does. router.js's actual call site is checked by reading its own
// source for the exact call (the same "source-order" technique
// inspection-2.md credited as adequate for M5), so this test also fails
// if a future edit removes the `{ allowPromotion: false }` option from
// that call, not only if reconcileOwnerRole's own logic regresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
              return null;
            },
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
            async all() {
              calls.push({ sql, args });
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

test("N2 RED->GREEN: the per-request call (allowPromotion:false) must not promote a newly-eligible member mid-session", async () => {
  const db = fakeDb();
  const account = { id: "acct-n2-1", email: "newowner@junglepickleball.com", role: "member", is_demo: 0 };
  const env = { OWNER_EMAILS: "newowner@junglepickleball.com", envClass: "production" };

  const { wasOwner, nowOwner } = await reconcileOwnerRole(db, env, account, { allowPromotion: false });

  assert.equal(wasOwner, false);
  assert.equal(nowOwner, false, "GREEN: newly eligible for OWNER_EMAILS must NOT be promoted by the per-request call");
  assert.equal(account.role, "member", "role must stay exactly as it was -- no mid-session promotion");
  assert.equal(db.calls.length, 0, "no promotion -> no role write, no owner_promoted audit opportunity");
});

test("N2 control: the login path (default allowPromotion:true) still promotes, unaffected by the guard", async () => {
  const db = fakeDb();
  const account = { id: "acct-n2-2", email: "newowner2@junglepickleball.com", role: "member", is_demo: 0 };
  const env = { OWNER_EMAILS: "newowner2@junglepickleball.com", envClass: "production" };

  const { nowOwner } = await reconcileOwnerRole(db, env, account);

  assert.equal(nowOwner, true, "login callers (auth.js/passkeys.js) pass no options and must keep promoting");
  assert.equal(account.role, "owner");
});

test("N2 control: demotion still applies immediately with allowPromotion:false (M4/S-3 must not regress)", async () => {
  const db = fakeDb();
  const account = { id: "acct-n2-3", email: "exec@junglepickleball.com", role: "owner", is_demo: 0 };
  const env = { OWNER_EMAILS: "roger@junglepickleball.com", envClass: "production" };

  const { wasOwner, nowOwner } = await reconcileOwnerRole(db, env, account, { allowPromotion: false });

  assert.equal(wasOwner, true);
  assert.equal(nowOwner, false, "demotion is unaffected by the promotion guard");
  const revoked = db.calls.some((c) => /DELETE FROM sessions WHERE account_id/.test(c.sql));
  assert.equal(revoked, true, "M4's session revoke on demotion must still fire");
});

test("N2 source check: router.js's per-request call site actually passes { allowPromotion: false }", () => {
  const routerPath = fileURLToPath(new URL("../../src/portal/router.js", import.meta.url));
  const src = readFileSync(routerPath, "utf8");
  assert.match(
    src,
    /reconcileOwnerRole\(db,\s*penv,\s*account,\s*\{\s*allowPromotion:\s*false\s*\}\)/,
    "router.js's loadAccount-time call must pass allowPromotion:false, or this guard is unreachable from a real request"
  );
});
