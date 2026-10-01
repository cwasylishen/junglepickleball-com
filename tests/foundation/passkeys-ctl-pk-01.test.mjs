// B2c: CTL-PK-01 (controls.md §4) -- WebAuthn challenges are single-use,
// server-held, bound and expire in 5 minutes. A reused challenge, a
// wrong-origin assertion and a wrong-RP-ID assertion are each rejected.
//
// Black-box HTTP (PIN-16) against the real bundle, using a real
// software ES256 authenticator (tests/foundation/passkeys-fixture.mjs)
// -- not a mock of @simplewebauthn/server. R-2: RP ID is the request
// hostname, so every fixture below derives rpId/origin from BASE_URL
// rather than hard-coding a domain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient, loginDemo, BASE_URL } from "./helpers.mjs";
import { cookieName } from "../../src/portal/auth.js";
import { routeTable } from "../../src/portal/router.js";
import { CSRF_EXEMPT_ROUTES } from "../../src/portal/auth.js";
import {
  generateAuthenticatorKeyPair,
  buildRegistrationCredential,
  buildAssertionCredential,
  randomCredentialId,
} from "./passkeys-fixture.mjs";

const RP_ID = new URL(BASE_URL).hostname;

async function registerPasskeyFor(client, csrfToken) {
  const start = await client.post("/api/portal/auth/passkey/register/start", {}, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const { privateKey, coseKeyBytes } = await generateAuthenticatorKeyPair();
  const credentialId = randomCredentialId();
  const credential = await buildRegistrationCredential({
    rpId: RP_ID,
    origin: BASE_URL,
    challenge: start.data.challenge,
    credentialId,
    coseKeyBytes,
  });
  const finish = await client.post(
    "/api/portal/auth/passkey/register/finish",
    { credential },
    { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
  );
  assert.equal(finish.status, 200, JSON.stringify(finish.data));
  assert.equal(finish.data.ok, true);
  return { credentialId, privateKey };
}

test("B2c route wiring: register/login/list/delete are in the live route table at the right class, and the two login routes stay CSRF-exempt", () => {
  const table = routeTable();
  const byKey = new Map(table.map((r) => [`${r.method} ${r.path}`, r.class]));
  assert.equal(byKey.get("POST /api/portal/auth/passkey/register/start"), "own");
  assert.equal(byKey.get("POST /api/portal/auth/passkey/register/finish"), "own");
  assert.equal(byKey.get("POST /api/portal/auth/passkey/login/start"), "public");
  assert.equal(byKey.get("POST /api/portal/auth/passkey/login/finish"), "public");
  assert.equal(byKey.get("GET /api/portal/passkeys"), "own");
  assert.equal(byKey.get("DELETE /api/portal/passkeys/:id"), "own");
  assert.ok(CSRF_EXEMPT_ROUTES.has("POST /api/portal/auth/passkey/login/start"));
  assert.ok(CSRF_EXEMPT_ROUTES.has("POST /api/portal/auth/passkey/login/finish"));
  assert.ok(!CSRF_EXEMPT_ROUTES.has("POST /api/portal/auth/passkey/register/start"), "register must require CSRF, unlike login");
});

test("CTL-PK-01: register + sign in with a real software authenticator; the session cookie matches PIN-8/S-4; a replayed assertion is rejected", async () => {
  const email = "member.demo@jp-demo.test";
  const { client, csrfToken } = await loginDemo(email);
  const { credentialId, privateKey } = await registerPasskeyFor(client, csrfToken);

  // Sign in with the passkey from a fresh, unauthenticated client -- this
  // is the actual login ceremony, not a re-use of the magic-link session.
  const loginClient = makeClient();
  const start = await loginClient.post("/api/portal/auth/passkey/login/start", { email }, { Origin: BASE_URL });
  assert.equal(start.status, 200, JSON.stringify(start.data));

  const credential = await buildAssertionCredential({
    rpId: RP_ID,
    origin: BASE_URL,
    challenge: start.data.challenge,
    credentialId,
    privateKey,
  });

  const finish = await loginClient.post("/api/portal/auth/passkey/login/finish", { credential }, { Origin: BASE_URL });
  assert.equal(finish.status, 200, JSON.stringify(finish.data));
  assert.equal(finish.data.ok, true);
  assert.equal(finish.data.account.email, email);

  // PIN-8/S-4: exactly one cookie, named per auth.js's cookieName() for
  // this URL, HttpOnly + SameSite=Lax + Path=/, Secure dropped only
  // because BASE_URL is local http (same rule as a magic-link session).
  const setCookie = finish.res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header on passkey login success");
  const name = cookieName(new URL(BASE_URL));
  assert.ok(setCookie.startsWith(`${name}=`), `expected cookie name ${name}, got: ${setCookie}`);
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  assert.ok(setCookie.includes("Path=/"));
  assert.ok(!setCookie.includes("Secure"), "Secure must be dropped on local http");

  // RED (named, not executed): a finish handler that verifies the
  // assertion WITHOUT first deleting the webauthn_challenges row (or
  // that deletes it only after a successful verify) would let this
  // exact same request body succeed twice. GREEN: the second attempt
  // below finds no live challenge row and is rejected.
  const replay = await loginClient.post("/api/portal/auth/passkey/login/finish", { credential }, { Origin: BASE_URL });
  assert.equal(replay.status, 400, JSON.stringify(replay.data));
  assert.equal(replay.data.error, "passkey_invalid");
});

test("CTL-PK-01: an assertion signed for a different origin is rejected (wrong-origin probe)", async () => {
  const email = "member.demo@jp-demo.test";
  const { client, csrfToken } = await loginDemo(email);
  const { credentialId, privateKey } = await registerPasskeyFor(client, csrfToken);

  const loginClient = makeClient();
  const start = await loginClient.post("/api/portal/auth/passkey/login/start", { email }, { Origin: BASE_URL });
  assert.equal(start.status, 200);

  // The HTTP Origin header is correct (so the Origin-check control
  // CTL-CSRF-01's sibling for this route passes); the signed
  // clientDataJSON.origin inside the assertion is for a different site
  // entirely -- the shape a phished/relayed assertion would have.
  const credential = await buildAssertionCredential({
    rpId: RP_ID,
    origin: "http://evil.example",
    challenge: start.data.challenge,
    credentialId,
    privateKey,
  });

  // RED (named, not executed): a verify call made without
  // `expectedOrigin` (or with it derived from a hard-coded production
  // domain instead of the live request's own origin, R-2) would accept
  // this. GREEN: verifyAuthenticationResponse's own origin check throws,
  // and the handler turns that into 400.
  const finish = await loginClient.post("/api/portal/auth/passkey/login/finish", { credential }, { Origin: BASE_URL });
  assert.equal(finish.status, 400, JSON.stringify(finish.data));
  assert.equal(finish.data.error, "passkey_invalid");
});

test("CTL-PK-01: an assertion signed for a different RP ID is rejected (wrong-RP-ID probe)", async () => {
  const email = "member.demo@jp-demo.test";
  const { client, csrfToken } = await loginDemo(email);
  const { credentialId, privateKey } = await registerPasskeyFor(client, csrfToken);

  const loginClient = makeClient();
  const start = await loginClient.post("/api/portal/auth/passkey/login/start", { email }, { Origin: BASE_URL });
  assert.equal(start.status, 200);

  // Correct HTTP Origin and correct signed clientDataJSON.origin, but
  // the authenticatorData's rpIdHash is for a different hostname (R-2:
  // exactly the shape of a passkey carried over from another preview
  // host, or a relay attempt against the wrong RP ID).
  const credential = await buildAssertionCredential({
    rpId: "evil.example",
    origin: BASE_URL,
    challenge: start.data.challenge,
    credentialId,
    privateKey,
  });

  // RED (named, not executed): a verify call with no `expectedRPID` (or
  // one hard-coded rather than taken from the live request's hostname,
  // R-2) would accept this. GREEN: matchExpectedRPID throws on the
  // rpIdHash mismatch, and the handler turns that into 400.
  const finish = await loginClient.post("/api/portal/auth/passkey/login/finish", { credential }, { Origin: BASE_URL });
  assert.equal(finish.status, 400, JSON.stringify(finish.data));
  assert.equal(finish.data.error, "passkey_invalid");
});
