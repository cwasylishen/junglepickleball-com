// Pure-function probes for B2d's JWT signing and event-body builder
// (controls.md §3.7, D-A17). Neither test touches D1, Google, or
// `fetch` -- a locally generated RSA key stands in for the service
// account's own key, and node:crypto verifies independently of the
// module under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { signServiceAccountAssertion, buildEventBody, eventIdForBooking } from "../../src/portal/gcal.js";

function fakeServiceAccount() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    serviceAccount: { client_email: "jp-portal@example.iam.gserviceaccount.com", private_key: privateKey },
    publicKeyPem: publicKey,
  };
}

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

test("CTL-CAL (JWT): the signed assertion verifies against its own public key, and claims match research.md Q5", async () => {
  const { serviceAccount, publicKeyPem } = fakeServiceAccount();
  const jwt = await signServiceAccountAssertion(serviceAccount, { nowSeconds: 1_700_000_000 });
  const [headerPart, claimsPart, signaturePart] = jwt.split(".");

  // RED: a mutation that signs over the wrong bytes (e.g. only the
  // claims, not `header.claims`) or uses the wrong digest would still
  // produce *a* signature -- it just would not verify against the
  // matching public key.
  const signingInput = `${headerPart}.${claimsPart}`;
  const verified = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(signingInput),
    { key: publicKeyPem },
    base64urlToBuffer(signaturePart)
  );
  assert.equal(verified, true);

  const header = JSON.parse(base64urlToBuffer(headerPart).toString("utf8"));
  const claims = JSON.parse(base64urlToBuffer(claimsPart).toString("utf8"));
  assert.equal(header.alg, "RS256");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/calendar.events");
  assert.equal(claims.iss, serviceAccount.client_email);
  assert.equal(claims.exp - claims.iat, 3600);
});

test("CTL-CAL (JWT): a tampered claims segment fails verification", async () => {
  const { serviceAccount, publicKeyPem } = fakeServiceAccount();
  const jwt = await signServiceAccountAssertion(serviceAccount, { nowSeconds: 1_700_000_000 });
  const [headerPart, claimsPart, signaturePart] = jwt.split(".");
  const tamperedClaims = Buffer.from(JSON.stringify({ iss: "someone-else@evil.example", scope: "x", aud: "x", iat: 0, exp: 0 }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const verified = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${tamperedClaims}`),
    { key: publicKeyPem },
    base64urlToBuffer(signaturePart)
  );
  assert.equal(verified, false);
});

test("D-A17: the event body never carries attendees, email or a display name, whatever it is given", () => {
  const event = buildEventBody({
    resourceName: "Court 2",
    startAt: "2026-10-05T15:00:00.000Z",
    endAt: "2026-10-05T16:30:00.000Z",
    bookingId: "b1a2c3d4-0000-0000-0000-000000000001",
  });
  const serialised = JSON.stringify(event);

  // RED: an implementation that forwarded a member's name/email into
  // `summary`, `description` or `attendees` (the shape the brief
  // forbids, and the shape Google rejects anyway without domain-wide
  // delegation) would fail every one of these.
  assert.equal("attendees" in event, false);
  assert.equal(/@/.test(serialised), false);
  assert.ok(!serialised.toLowerCase().includes("display_name"));
  assert.equal(event.summary, "Court 2: booked");
  assert.deepEqual(Object.keys(event).sort(), ["end", "extendedProperties", "id", "start", "summary"]);
});

test("CTL-CAL idempotency: the event id is deterministic from the booking id alone", () => {
  const id1 = eventIdForBooking("b1a2c3d4-0000-0000-0000-000000000001");
  const id2 = eventIdForBooking("b1a2c3d4-0000-0000-0000-000000000001");
  const id3 = eventIdForBooking("b1a2c3d4-0000-0000-0000-000000000002");
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  // RED: an id built from `Date.now()` or a random suffix would make
  // every retry of the same booking create a second Google event.
  assert.match(id1, /^[a-v0-9]{5,1024}$/);
});
