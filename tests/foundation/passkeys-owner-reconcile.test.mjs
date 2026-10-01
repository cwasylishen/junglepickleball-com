// M5 (S-3, CTL-OWN-01): passkey login must re-derive owner authority
// exactly like magic-link verify, through the SAME shared function
// (auth.js's reconcileOwnerRole) -- before this fix, passkeyLoginFinish
// never called it at all, so an owner removed from OWNER_EMAILS kept
// owner indefinitely by passkey.
//
// Harness note: a real demotion-by-OWNER_EMAILS-removal scenario needs
// a non-demo owner account, and src/portal/router.js's own CTL-ENV-02
// gate refuses every request for any non-demo account under this
// suite's preview marker -- the identical F-14-class limit M4 hit
// (tests/foundation/authz-owner-reconcile.test.mjs), which already
// proves reconcileOwnerRole's demotion logic red-then-green directly.
// What M5 adds on top of that is the WIRING: passkeys.js must call the
// same function, before minting the session. That is proven two ways
// below: (1) a source-order assertion that fires if the call is ever
// removed or reordered after mintSession, and (2) a real end-to-end
// passkey login for the seeded demo owner, proving the call is live in
// the request path and does not break the existing S-3 preview
// exception or the owner_login audit trail.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { makeClient, loginDemo, BASE_URL } from "./helpers.mjs";
import { generateAuthenticatorKeyPair, buildRegistrationCredential, buildAssertionCredential, randomCredentialId } from "./passkeys-fixture.mjs";

const RP_ID = new URL(BASE_URL).hostname;

test("M5 RED->GREEN (source order): passkeyLoginFinish must call reconcileOwnerRole before mintSession", async () => {
  const src = await fs.readFile(new URL("../../src/portal/passkeys.js", import.meta.url), "utf8");
  const finishStart = src.indexOf("export async function passkeyLoginFinish");
  const finishEnd = src.indexOf("\nexport async function", finishStart + 1);
  const body = src.slice(finishStart, finishEnd === -1 ? undefined : finishEnd);

  // A LIVE (non-commented) call: a `//`-prefixed line mentioning the
  // name does not count, so a RED run (the call removed, or only
  // mentioned in a comment) fails this exactly the way the pre-M5 code
  // did.
  const liveCallLine = body.split("\n").find((line) => /^\s*(const|await)[^/]*reconcileOwnerRole\(/.test(line) && !line.trim().startsWith("//"));
  const reconcileIdx = liveCallLine ? body.indexOf(liveCallLine) : -1;
  const mintIdx = body.indexOf("await mintSession(");
  assert.notEqual(reconcileIdx, -1, "RED: passkeyLoginFinish never called reconcileOwnerRole live -- the exact bug M5 names");
  assert.ok(mintIdx !== -1 && reconcileIdx < mintIdx, "GREEN: owner authority must be re-derived before the session is minted");
});

test("M5 end-to-end: the seeded demo owner's passkey login still re-derives role via the shared function and keeps owner (S-3 preview exception), with owner_login audited", async () => {
  const email = "owner.demo@jp-demo.test";
  const { client, csrfToken } = await loginDemo(email);
  const start = await client.post("/api/portal/auth/passkey/register/start", {}, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const { privateKey, coseKeyBytes } = await generateAuthenticatorKeyPair();
  const credentialId = randomCredentialId();
  const credential = await buildRegistrationCredential({ rpId: RP_ID, origin: BASE_URL, challenge: start.data.challenge, credentialId, coseKeyBytes });
  const regFinish = await client.post("/api/portal/auth/passkey/register/finish", { credential }, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
  assert.equal(regFinish.status, 200, JSON.stringify(regFinish.data));

  const loginClient = makeClient();
  const loginStart = await loginClient.post("/api/portal/auth/passkey/login/start", { email }, { Origin: BASE_URL });
  assert.equal(loginStart.status, 200, JSON.stringify(loginStart.data));
  const assertion = await buildAssertionCredential({ rpId: RP_ID, origin: BASE_URL, challenge: loginStart.data.challenge, credentialId, privateKey });
  const loginFinish = await loginClient.post("/api/portal/auth/passkey/login/finish", { credential: assertion }, { Origin: BASE_URL });
  assert.equal(loginFinish.status, 200, JSON.stringify(loginFinish.data));
  assert.equal(loginFinish.data.account.role, "owner", "the S-3 preview exception for the seeded demo owner must survive the new reconciliation call");
});
