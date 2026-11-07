// B2c: one account cannot list or delete another account's passkeys
// (AUTH-14 / "own" route scoping, dispatch acceptance test 5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, BASE_URL } from "./helpers.mjs";
import { generateAuthenticatorKeyPair, buildRegistrationCredential, randomCredentialId } from "./passkeys-fixture.mjs";

const RP_ID = new URL(BASE_URL).hostname;

// helpers.mjs's makeClient() has no DELETE verb (no "own" DELETE route
// existed when it was written) -- this file adds its own tiny one
// rather than editing a file this part does not own.
async function del(client, path, csrfToken) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrfToken, Origin: BASE_URL, Cookie: client.getCookie() },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

test("one account cannot list or delete another account's passkey (404, not 403, and nothing is deleted)", async () => {
  const { client: ownerClient, csrfToken: ownerCsrf } = await loginDemo("member.demo@jp-demo.test");

  const start = await ownerClient.post(
    "/api/portal/auth/passkey/register/start",
    {},
    { "X-CSRF-Token": ownerCsrf, Origin: BASE_URL }
  );
  assert.equal(start.status, 200);
  const { coseKeyBytes } = await generateAuthenticatorKeyPair();
  const credential = await buildRegistrationCredential({
    rpId: RP_ID,
    origin: BASE_URL,
    challenge: start.data.challenge,
    credentialId: randomCredentialId(),
    coseKeyBytes,
  });
  const finish = await ownerClient.post(
    "/api/portal/auth/passkey/register/finish",
    { credential },
    { "X-CSRF-Token": ownerCsrf, Origin: BASE_URL }
  );
  assert.equal(finish.status, 200, JSON.stringify(finish.data));

  const ownList = await ownerClient.get("/api/portal/passkeys");
  assert.equal(ownList.status, 200);
  assert.equal(ownList.data.length, 1);
  const passkeyId = ownList.data[0].id;

  const { client: otherClient, csrfToken: otherCsrf } = await loginDemo("member2.demo@jp-demo.test");

  // Listing never surfaces another account's rows at all.
  const otherList = await otherClient.get("/api/portal/passkeys");
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.data, []);

  // RED (named, not executed): a delete handler that matched on `id`
  // alone (no `AND account_id = ?`) would return 200 and actually
  // delete another account's passkey here. GREEN: it is reported as
  // not_found and nothing is removed.
  const forbidden = await del(otherClient, `/api/portal/passkeys/${passkeyId}`, otherCsrf);
  assert.equal(forbidden.status, 404, JSON.stringify(forbidden.data));

  const stillThere = await ownerClient.get("/api/portal/passkeys");
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.data.length, 1, "the other account's attempt must not have deleted it");

  // And the real owner can delete their own.
  const ok = await del(ownerClient, `/api/portal/passkeys/${passkeyId}`, ownerCsrf);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const afterOwnDelete = await ownerClient.get("/api/portal/passkeys");
  assert.deepEqual(afterOwnDelete.data, []);
});

test("deleting a passkey id that never existed is also not_found, not a server error", async () => {
  const { client, csrfToken } = await loginDemo("member.demo@jp-demo.test");
  const res = await del(client, "/api/portal/passkeys/00000000-0000-0000-0000-000000000000", csrfToken);
  assert.equal(res.status, 404);
  assert.equal(res.data.error, "not_found");
});
