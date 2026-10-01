// WebAuthn passkey registration and login ceremonies
// (@simplewebauthn/server@14.0.3). Owned by B2c.
//
// R-2 (research.md): RP ID is always the request hostname, never a
// fixed value -- a passkey made on one preview host does not verify on
// the next. The expected origin is always the request's own origin.
//
// CTL-PK-01 (controls.md §4): every WebAuthn challenge is stored
// server-side, bound (to the account for registration, to the
// challenge's own random value for login), expires in 5 minutes, and
// is consumed by one `DELETE ... RETURNING` before verification ever
// runs -- so a replayed challenge finds no row the second time.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { json } from "./http.js";
import { newId, nowIso } from "./db.js";
import { writeAudit } from "./audit.js";
import { originMatchesRequestUrl, sha256Hex, sessionCookieHeader, publicAccount } from "./auth.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // CTL-PK-01

// Mirrors auth.js's SESSION_TTL_MS (S-5) exactly. This is duplicated
// here, not imported, because auth.js has no exported session-minting
// function a second login method can call -- auth.js is not this
// part's file to add one to, so the gap is reported as a finding in
// this part's return rather than fixed here. If S-5's values change,
// this table must change with them.
const SESSION_TTL_MS = { owner: 7 * 86400000, staff: 7 * 86400000, member: 30 * 86400000, guest: 30 * 86400000 };

function randomTokenHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uaFamily(request) {
  const ua = request.headers.get("User-Agent") || "";
  if (/iPhone|iPad/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Chrome/.test(ua)) return "chrome";
  if (/Safari/.test(ua)) return "safari";
  if (/Firefox/.test(ua)) return "firefox";
  return "other";
}

// The one place a passkey login mints a session row. Same shape as
// auth.js's authVerify session insert (same columns, same cookie
// helper, same TTL-by-role table) so a passkey session is
// indistinguishable from a link session to every other part of the
// portal -- see the SESSION_TTL_MS note above for why this one insert
// is duplicated rather than called through.
async function mintSessionForAccount(db, request, url, account) {
  const sessionToken = randomTokenHex(32);
  const sessionId = await sha256Hex(sessionToken);
  const csrfToken = randomTokenHex(16);
  const ttl = SESSION_TTL_MS[account.role] || SESSION_TTL_MS.guest;
  await db
    .prepare(
      `INSERT INTO sessions (id, account_id, csrf_token, method, user_agent_family, created_at, expires_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(sessionId, account.id, csrfToken, "passkey", uaFamily(request), nowIso(), new Date(Date.now() + ttl).toISOString(), nowIso())
    .run();
  return { csrfToken, cookieHeader: sessionCookieHeader(url, sessionToken, ttl) };
}

// ---------- registration (own) ----------

export async function passkeyRegisterStart(request, env, db, url, session, account) {
  const existing = (await db.prepare(`SELECT credential_id FROM passkeys WHERE account_id = ?`).bind(account.id).all()).results || [];
  const options = await generateRegistrationOptions({
    rpName: "Jungle Pickleball",
    rpID: url.hostname, // R-2
    userName: account.email,
    userID: new TextEncoder().encode(account.id),
    userDisplayName: account.display_name || account.email,
    attestationType: "none",
    excludeCredentials: existing.map((r) => ({ id: r.credential_id })),
  });
  // At most one live registration challenge per account: a fresh start
  // always invalidates whatever the previous one left unconsumed.
  await db.prepare(`DELETE FROM webauthn_challenges WHERE account_id = ? AND purpose = 'register'`).bind(account.id).run();
  await db
    .prepare(`INSERT INTO webauthn_challenges (id, account_id, purpose, challenge, created_at, expires_at) VALUES (?,?,?,?,?,?)`)
    .bind(newId(), account.id, "register", options.challenge, nowIso(), new Date(Date.now() + CHALLENGE_TTL_MS).toISOString())
    .run();
  return json(options);
}

export async function passkeyRegisterFinish(request, env, db, url, session, account) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const credential = body && body.credential;
  if (!credential) return json({ error: "passkey_invalid" }, 400);

  // CTL-PK-01: consumed before verification -- a replay of this same
  // finish call (same account, same challenge already spent) finds no
  // row the second time around.
  const row = await db
    .prepare(`DELETE FROM webauthn_challenges WHERE account_id = ? AND purpose = 'register' RETURNING *`)
    .bind(account.id)
    .first();
  if (!row || row.expires_at <= nowIso()) return json({ error: "passkey_invalid" }, 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: row.challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
    });
  } catch {
    return json({ error: "passkey_invalid" }, 400);
  }
  if (!verification.verified) return json({ error: "passkey_invalid" }, 400);

  const { credential: cred, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await db
    .prepare(
      `INSERT INTO passkeys (id, account_id, credential_id, public_key, counter, device_type, backed_up, rp_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      newId(),
      account.id,
      cred.id,
      isoBase64URL.fromBuffer(cred.publicKey),
      cred.counter,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      url.hostname,
      nowIso()
    )
    .run();
  await writeAudit(db, { actor: account.id, action: "passkey_registered", targetType: "account", targetId: account.id });
  return json({ ok: true });
}

// ---------- login (public, Origin-checked) ----------

export async function passkeyLoginStart(request, env, db, url) {
  if (!originMatchesRequestUrl(request, url)) return json({ error: "origin_required" }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const email = String((body && body.email) || "").trim().toLowerCase();
  // PIN-8's shape-hiding rule extended to passkeys: the response has the
  // same fields whether or not the email is a real account, and whether
  // or not that account owns any passkeys.
  const account = email ? await db.prepare(`SELECT id FROM accounts WHERE email = ?`).bind(email).first() : null;
  const creds = account
    ? (await db.prepare(`SELECT credential_id FROM passkeys WHERE account_id = ?`).bind(account.id).all()).results || []
    : [];
  const options = await generateAuthenticationOptions({
    rpID: url.hostname, // R-2
    allowCredentials: creds.length ? creds.map((r) => ({ id: r.credential_id })) : undefined,
    userVerification: "preferred",
  });
  await db
    .prepare(`INSERT INTO webauthn_challenges (id, account_id, purpose, challenge, created_at, expires_at) VALUES (?,?,?,?,?,?)`)
    .bind(newId(), account ? account.id : null, "login", options.challenge, nowIso(), new Date(Date.now() + CHALLENGE_TTL_MS).toISOString())
    .run();
  return json(options);
}

export async function passkeyLoginFinish(request, env, db, url, currentSession) {
  if (!originMatchesRequestUrl(request, url)) return json({ error: "origin_required" }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const credential = body && body.credential;
  if (!credential || !credential.response || typeof credential.response.clientDataJSON !== "string") {
    return json({ error: "passkey_invalid" }, 400);
  }

  let clientData;
  try {
    clientData = JSON.parse(isoBase64URL.toUTF8String(credential.response.clientDataJSON));
  } catch {
    return json({ error: "passkey_invalid" }, 400);
  }

  // CTL-PK-01: consumed before verification -- the same assertion (same
  // clientDataJSON, same challenge value) can never be submitted twice;
  // the second attempt finds no row and is rejected below.
  const challengeRow = await db
    .prepare(`DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = 'login' RETURNING *`)
    .bind(String(clientData.challenge || ""))
    .first();
  if (!challengeRow || challengeRow.expires_at <= nowIso()) return json({ error: "passkey_invalid" }, 400);

  const passkeyRow = await db.prepare(`SELECT * FROM passkeys WHERE credential_id = ?`).bind(credential.id).first();
  if (!passkeyRow) return json({ error: "passkey_invalid" }, 400);
  // Defence in depth: when login-start knew the account (a real email),
  // the challenge it minted is bound to that account id too.
  if (challengeRow.account_id && challengeRow.account_id !== passkeyRow.account_id) {
    return json({ error: "passkey_invalid" }, 400);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      credential: {
        id: passkeyRow.credential_id,
        publicKey: isoBase64URL.toBuffer(passkeyRow.public_key),
        counter: passkeyRow.counter,
      },
    });
  } catch {
    return json({ error: "passkey_invalid" }, 400);
  }
  if (!verification.verified) return json({ error: "passkey_invalid" }, 400);

  await db
    .prepare(`UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?`)
    .bind(verification.authenticationInfo.newCounter, nowIso(), passkeyRow.id)
    .run();

  const account = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(passkeyRow.account_id).first();
  if (!account) return json({ error: "passkey_invalid" }, 400);

  // Same account-switch confirmation rule as the magic link (CTL-AUTH-02).
  if (currentSession && currentSession.account_id !== account.id) {
    if (body.confirm !== true) {
      const hint = `${account.email[0]}***@${account.email.split("@")[1]}`;
      return json({ error: "confirm_account_switch", account_hint: hint }, 409);
    }
    await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(currentSession.id).run();
  }

  const { csrfToken, cookieHeader } = await mintSessionForAccount(db, request, url, account);
  await writeAudit(db, {
    actor: account.id,
    action: account.role === "owner" ? "owner_login" : "login",
    targetType: "account",
    targetId: account.id,
  });

  return json(
    { ok: true, first_login: false, csrf_token: csrfToken, account: publicAccount(account) },
    200,
    { "Set-Cookie": cookieHeader }
  );
}

// ---------- own passkey management (own, L6) ----------

export async function listPasskeys(request, env, db, url, session, account) {
  const rows =
    (await db
      .prepare(`SELECT id, device_type, backed_up, rp_id, created_at, last_used_at FROM passkeys WHERE account_id = ? ORDER BY created_at DESC`)
      .bind(account.id)
      .all()).results || [];
  return json(rows);
}

export async function deletePasskey(request, env, db, url, session, account, params) {
  const row = await db.prepare(`SELECT account_id FROM passkeys WHERE id = ?`).bind(params.id).first();
  // Another account's passkey id is reported as not found, not
  // forbidden, and deletes nothing either way (AUTH-14).
  if (!row || row.account_id !== account.id) return json({ error: "not_found" }, 404);
  await db.prepare(`DELETE FROM passkeys WHERE id = ?`).bind(params.id).run();
  return json({ ok: true });
}
