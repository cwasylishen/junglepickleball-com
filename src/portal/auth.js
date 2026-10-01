// Magic-link auth, sessions, CSRF/Origin checks, the demo-login gate and
// the login rate limiter. PIN-8, PIN-9, S-1..S-6, CTL-AUTH-01..07,
// CTL-ROLE-01..03, CTL-CSRF-01.

import { json } from "./http.js";
import { newId, nowIso } from "./db.js";
import { writeAudit } from "./audit.js";
import { isOwnerEmail, resolveEntitlement } from "./entitlement.js";

const TOKEN_TTL_MS = 15 * 60 * 1000; // PIN-8
const SESSION_TTL_MS = { owner: 7 * 86400000, staff: 7 * 86400000, member: 30 * 86400000, guest: 30 * 86400000 }; // S-5
const DEMO_HOST_RE = /^[0-9a-f]{8}-junglepickleball-com\.cwasylishen\.workers\.dev$/;

export const CSRF_EXEMPT_ROUTES = new Set([
  "POST /api/portal/auth/start",
  "POST /api/portal/auth/verify",
  "POST /api/portal/auth/passkey/login/start",
  "POST /api/portal/auth/passkey/login/finish",
]);

// ---------- small crypto / normalisation helpers ----------

export async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomTokenHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// D-A24: trim + lowercase for identity and storage.
export function normalizeEmailIdentity(email) {
  return String(email || "").trim().toLowerCase();
}

// CTL-AUTH-07: the rate-limit KEY only. Identity/storage always uses
// normalizeEmailIdentity -- this is never used for anything except the
// rate_limits row name.
export function normalizeEmailRateLimitKey(email) {
  const id = normalizeEmailIdentity(email);
  const at = id.indexOf("@");
  if (at === -1) return id;
  let local = id.slice(0, at);
  const domain = id.slice(at + 1);
  local = local.replace(/\+[^@]*$/, "");
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export function originMatchesRequestUrl(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return false; // S-12: no Origin header is rejected
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

// ---------- rate limiting (D1, no KV; PIN-8) ----------

async function checkAndBump(db, key, limit, windowMinutes) {
  const now = Date.now();
  const row = await db.prepare(`SELECT * FROM rate_limits WHERE key = ?`).bind(key).first();
  const windowMs = windowMinutes * 60 * 1000;
  if (!row || now - new Date(row.window_start).getTime() > windowMs) {
    await db
      .prepare(`INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
                ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`)
      .bind(key, new Date(now).toISOString())
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await db.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`).bind(key).run();
  return true;
}

// ---------- demo gate (PIN-9 a-c, S-1 d-e) ----------

export function isDemoEligibleHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || DEMO_HOST_RE.test(hostname);
}

async function demoDevLink(db, env, url, email, token) {
  if (env.PORTAL_DEV_LOGIN !== "1") return null;
  if (!isDemoEligibleHost(url.hostname)) return null;
  if (!email.endsWith("@jp-demo.test")) return null;
  const marker = await db.prepare(`SELECT env FROM portal_meta WHERE id = 1`).first();
  if (!marker || marker.env !== "preview") return null; // S-1 d
  const account = await db.prepare(`SELECT id, is_demo FROM accounts WHERE email = ?`).bind(email).first();
  if (!account || !account.is_demo) return null; // S-1 e: must already exist, flagged demo
  const link = `${url.origin}/portal/#login=${token}`;
  // eslint-disable-next-line no-console
  console.log(`[portal demo login] ${email} -> ${link}`);
  return link;
}

// ---------- login start ----------

export async function authStart(request, env, db, url) {
  if (!originMatchesRequestUrl(request, url)) return json({ error: "origin_required" }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const email = normalizeEmailIdentity(body.email);
  if (!email || email.indexOf("@") < 1) return json({ error: "invalid_request" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const emailOk = await checkAndBump(db, `email:${normalizeEmailRateLimitKey(email)}`, 5, 15);
  const ipOk = await checkAndBump(db, `ip:${ip}`, 20, 15);
  // PIN-8: the start response is identical whether or not the email
  // exists -- it must ALSO be identical whether or not the caller is
  // rate-limited, so a limited caller never learns that fact either.
  // We still must not issue a token when limited.
  const token = randomTokenHex(32);
  let devLink = null;
  if (emailOk && ipOk) {
    const tokenHash = await sha256Hex(token);
    await db
      .prepare(`INSERT INTO login_tokens (id, email, token_hash, created_at, expires_at, ip) VALUES (?,?,?,?,?,?)`)
      .bind(newId(), email, tokenHash, nowIso(), new Date(Date.now() + TOKEN_TTL_MS).toISOString(), ip)
      .run();
    devLink = await demoDevLink(db, env, url, email, token);
  }
  const resp = { ok: true };
  if (devLink) resp.dev_link = devLink;
  return json(resp);
}

// ---------- login verify ----------

export async function authVerify(request, env, db, url, currentSession) {
  if (!originMatchesRequestUrl(request, url)) return json({ error: "origin_required" }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const token = String(body.token || "");
  if (!token) return json({ error: "verify.bad_invalid" }, 400);
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(`SELECT * FROM login_tokens WHERE token_hash = ?`).bind(tokenHash).first();
  if (!row) return json({ error: "verify.bad_invalid" }, 400);
  if (row.consumed_at) return json({ error: "verify.bad_used" }, 400);
  if (row.expires_at <= nowIso()) return json({ error: "verify.bad_expired" }, 400);

  let account = await db.prepare(`SELECT * FROM accounts WHERE email = ?`).bind(row.email).first();
  let firstLogin = false;
  if (!account) {
    if (body.age_16_plus !== true) {
      return json({ error: "age_confirmation_required" }, 409);
    }
    const id = newId();
    await db
      .prepare(
        `INSERT INTO accounts (id, email, role, display_name, is_demo, age_attested_at, created_at, updated_at)
         VALUES (?,?,?,?,0,?,?,?)`
      )
      .bind(id, row.email, "guest", "", nowIso(), nowIso(), nowIso())
      .run();
    account = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
    firstLogin = true;
  }

  // CTL-AUTH-02: a different account's live session accompanies this
  // request -- require explicit confirmation before switching.
  if (currentSession && currentSession.account_id !== account.id && body.confirm !== true) {
    const hint = `${account.email[0]}***@${account.email.split("@")[1]}`;
    return json({ error: "confirm_account_switch", account_hint: hint }, 409);
  }

  // S-3: owner role re-derived every login. An account is owner iff its
  // email is in OWNER_EMAILS, OR it is a seeded is_demo owner and the
  // preview marker exists (PIN-9's owner.demo has no OWNER_EMAILS entry
  // at all in preview -- this second clause is what keeps it owner). A
  // demoted owner loses its other sessions too.
  const wasOwner = account.role === "owner";
  const seededDemoOwner = Boolean(account.is_demo) && wasOwner && env.envClass === "preview";
  const nowOwner = isOwnerEmail(account.email, env.OWNER_EMAILS) || seededDemoOwner;
  let role = account.role;
  if (nowOwner) role = "owner";
  else if (wasOwner) {
    const ent = await resolveEntitlement(db, account.id);
    role = ent.entitled ? "member" : "guest";
  }
  if (role !== account.role) {
    await db.prepare(`UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?`).bind(role, nowIso(), account.id).run();
    if (wasOwner && !nowOwner) {
      await db.prepare(`DELETE FROM sessions WHERE account_id = ?`).bind(account.id).run();
    }
    account.role = role;
  }

  await db.prepare(`UPDATE login_tokens SET consumed_at = ? WHERE id = ?`).bind(nowIso(), row.id).run();
  if (currentSession && currentSession.account_id !== account.id) {
    await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(currentSession.id).run();
  }

  const sessionToken = randomTokenHex(32);
  const sessionId = await sha256Hex(sessionToken);
  const csrfToken = randomTokenHex(16);
  const ttl = SESSION_TTL_MS[account.role] || SESSION_TTL_MS.guest;
  const method = "link";
  await db
    .prepare(
      `INSERT INTO sessions (id, account_id, csrf_token, method, user_agent_family, created_at, expires_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(sessionId, account.id, csrfToken, method, uaFamily(request), nowIso(), new Date(Date.now() + ttl).toISOString(), nowIso())
    .run();

  await writeAudit(db, { actor: account.id, action: account.role === "owner" ? "owner_login" : "login", targetType: "account", targetId: account.id });
  if (account.role === "owner" && !wasOwner) {
    await writeAudit(db, { actor: account.id, action: "owner_promoted", targetType: "account", targetId: account.id });
  }

  const headers = { "Set-Cookie": sessionCookieHeader(url, sessionToken, ttl) };
  return json({ ok: true, first_login: firstLogin, csrf_token: csrfToken, account: publicAccount(account) }, 200, headers);
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

export function publicAccount(account) {
  return { id: account.id, email: account.email, role: account.role, display_name: account.display_name };
}

// ---------- cookie (CTL-AUTH-04, S-4) ----------

export function cookieName(url) {
  return isLocalHttp(url) ? "jp_portal_dev" : "__Host-jp_portal";
}

function isLocalHttp(url) {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export function sessionCookieHeader(url, token, ttlMs) {
  const name = cookieName(url);
  const maxAge = Math.floor(ttlMs / 1000);
  const parts = [`${name}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (!isLocalHttp(url)) parts.splice(1, 0, "Secure");
  return parts.join("; ");
}

export function clearCookieHeader(url) {
  const name = cookieName(url);
  const parts = [`${name}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (!isLocalHttp(url)) parts.splice(1, 0, "Secure");
  return parts.join("; ");
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}

// Loads the live session (if any) for this request, from EITHER cookie
// name (a dev box may carry the dev cookie; production only ever sets
// the __Host- one). Expired sessions are treated as absent.
export async function loadSession(request, env, db, url) {
  const token = getCookie(request, "__Host-jp_portal") || getCookie(request, "jp_portal_dev");
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await db.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first();
  if (!row) return null;
  if (row.expires_at <= nowIso()) return null;
  await db.prepare(`UPDATE sessions SET last_used_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  return row;
}

export async function logout(request, env, db, url, session) {
  if (session) await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(session.id).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader(url) });
}

// ---------- owner session visibility (CTL-AUTH-01) ----------

export async function ownerSessions(request, env, db, url, session, account) {
  const rows = (await db
    .prepare(`SELECT id, method, user_agent_family, created_at, last_used_at FROM sessions WHERE account_id = ? ORDER BY last_used_at DESC`)
    .bind(account.id)
    .all()).results || [];
  return json({ sessions: rows.map((r) => ({ ...r, current: r.id === session.id })) });
}

export async function ownerRevokeOtherSessions(request, env, db, url, session, account) {
  await db.prepare(`DELETE FROM sessions WHERE account_id = ? AND id != ?`).bind(account.id, session.id).run();
  return json({ ok: true });
}

// ---------- owner health (CTL-AUTH-06, CTL-OWN-01) ----------

export async function ownerHealth(request, env, db) {
  const owners = (await db
    .prepare(`SELECT a.id, a.email, MIN(au.at) AS first_owner_login, MAX(au.at) AS last_owner_login
              FROM accounts a LEFT JOIN audit_log au ON au.target_id = a.id AND au.action IN ('owner_login','owner_promoted')
              WHERE a.role = 'owner' GROUP BY a.id`)
    .all()).results || [];
  const bucket = `email_send_failed:${nowIso().slice(0, 13)}`;
  const counter = await db.prepare(`SELECT value FROM portal_meta_counters WHERE key = ?`).bind(bucket).first();
  return json({
    owners,
    email_configured: Boolean(env.EMAIL),
    email_send_failed_24h: counter ? counter.value : 0,
    stripe_configured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    gcal_configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    push_configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
  });
}

// CTL-AUTH-06: called by the (not-yet-provisioned) EMAIL send path on
// failure, and usable now to prove the counter in a test without a real
// EMAIL binding.
export async function recordEmailSendFailure(db, at = new Date()) {
  const bucket = `email_send_failed:${at.toISOString().slice(0, 13)}`;
  await db
    .prepare(`INSERT INTO portal_meta_counters (key, value, updated_at) VALUES (?, 1, ?)
              ON CONFLICT(key) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`)
    .bind(bucket, nowIso())
    .run();
}
