// Google Calendar push (B2d, PIN-13, D-A17). One-way: `calendar_outbox`
// rows become Google Calendar events; nothing ever flows back from
// Google into a booking (REQ-CAL-01). Auth is a hand-rolled RS256
// service-account JWT -- no library, no domain-wide delegation
// (research.md Q5) -- exchanged for an access token that this module
// caches for its own lifetime.
//
// With `GOOGLE_SERVICE_ACCOUNT_JSON` unset, every exported function
// takes the not-configured path before it builds a JWT or touches
// `fetch` (REQ-CAL-04): no network call, no row change.

import { nowIso } from "./db.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// D-A17: retry with backoff, then `failed`. Index 0 is the wait after
// the 1st failed attempt, etc. A 5th failed attempt has nothing left to
// wait for -- it is marked `failed` instead.
const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 2, 4, 8, 16];

// One Worker isolate reuses this across calls instead of exchanging a
// fresh JWT for an access token on every drain. Refreshed whenever it is
// within a minute of expiry.
let cachedToken = null; // { accessToken, expiresAtMs }

// Test-only: the module-level cache above would otherwise leak a token
// from one test into the next. Production code never calls this.
export function __resetAccessTokenCacheForTests() {
  cachedToken = null;
}

function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importSigningKey(pem) {
  return crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function base64urlFromBytes(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromString(str) {
  return base64urlFromBytes(new TextEncoder().encode(str));
}

// Builds and signs the JWT assertion Google's token endpoint exchanges
// for an access token (research.md Q5: alg is always RS256, aud is
// always the token URL, exp is at most 1h past iat). Exported so a test
// can sign with a locally generated key and verify with its matching
// public key, independent of any secret or network call.
export async function signServiceAccountAssertion(serviceAccount, { scope = CALENDAR_SCOPE, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(claims))}`;
  const key = await importSigningKey(serviceAccount.private_key);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64urlFromBytes(signatureBytes)}`;
}

// Exchanges the signed assertion for an access token, caching it for its
// reported lifetime. `fetchImpl` defaults to the global `fetch`; a test
// passes a spy so it can assert this is (or is not) called.
export async function getGoogleAccessToken(serviceAccount, fetchImpl = fetch) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now + 60_000) {
    return cachedToken.accessToken;
  }
  const assertion = await signServiceAccountAssertion(serviceAccount);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gcal_token_exchange_failed status=${res.status} body=${text.slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAtMs: now + (data.expires_in || 3600) * 1000 };
  return cachedToken.accessToken;
}

// A Google Calendar event id must be lowercase a-v and 0-9, 5-1024
// chars. A booking id's hex digits (0-9a-f) are already inside that
// alphabet, so stripping the dashes is enough -- no separate encoding
// step, and the same booking id always gives the same event id, so a
// retried drain can never create a duplicate event.
export function eventIdForBooking(bookingId) {
  return `jp${String(bookingId).replace(/-/g, "").toLowerCase()}`;
}

// D-A17: title only, no personal data, and this object must never carry
// an `attendees` key. Without domain-wide delegation Google rejects a
// service-account invite outright (research.md Q5); even if it did not,
// the brief forbids putting a member's name or email anywhere a calendar
// viewer with "see details" access could read it.
export function buildEventBody({ resourceName, startAt, endAt, bookingId }) {
  return {
    id: eventIdForBooking(bookingId),
    summary: `${resourceName}: booked`,
    start: { dateTime: startAt },
    end: { dateTime: endAt },
    extendedProperties: { private: { booking_id: bookingId } },
  };
}

async function callCalendarApi(fetchImpl, accessToken, calendarId, action, event) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  if (action === "create") return fetchImpl(base, { method: "POST", headers, body: JSON.stringify(event) });
  if (action === "move") return fetchImpl(`${base}/${encodeURIComponent(event.id)}`, { method: "PUT", headers, body: JSON.stringify(event) });
  if (action === "cancel") return fetchImpl(`${base}/${encodeURIComponent(event.id)}`, { method: "DELETE", headers });
  throw new Error(`gcal_unknown_action action=${action}`);
}

async function countPending(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM calendar_outbox WHERE status = 'pending'`).first();
  return row ? row.n : 0;
}

// True once an attempt is "due": the first attempt is always due; a
// later one waits out the backoff slot for its attempt count, measured
// from the row's own last update.
function dueForRetry(row, nowMs) {
  if (row.attempts === 0) return true;
  const minutes = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
  return nowMs - Date.parse(row.updated_at) >= minutes * 60_000;
}

// Candidate rows, joined to the booking's time and the resource's name
// and calendar id -- everything the event body needs, in one read. Pulls
// extra candidates past `limit` because some are filtered out by
// backoff below.
async function loadCandidateRows(db, limit) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.booking_id, o.action, o.resource_id, o.attempts, o.updated_at,
              b.start_at, b.end_at, r.name AS resource_name, r.google_calendar_id
       FROM calendar_outbox o
       JOIN bookings b ON b.id = o.booking_id
       JOIN resources r ON r.id = o.resource_id
       WHERE o.status = 'pending'
       ORDER BY o.created_at ASC
       LIMIT ?`
    )
    .bind(Math.max(limit * 3, limit))
    .all();
  return results || [];
}

async function markNoCalendar(db, row) {
  await db.prepare(`UPDATE calendar_outbox SET last_error = ?, updated_at = ? WHERE id = ?`).bind("no_calendar_id", nowIso(), row.id).run();
}

async function markSent(db, row) {
  await db
    .prepare(`UPDATE calendar_outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), row.id)
    .run();
}

async function markAttemptFailed(db, row, errorMessage) {
  const attempts = row.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await db
    .prepare(`UPDATE calendar_outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .bind(status, attempts, errorMessage.slice(0, 300), nowIso(), row.id)
    .run();
}

// The one function that drains `calendar_outbox` (amendment 6's
// interface). Insert/update/delete per the row's own `action`.
export async function drainCalendarOutbox(env, { limit = 25, fetchImpl = fetch } = {}) {
  const db = env.PORTAL_DB;
  const configured = Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  if (!configured) {
    // REQ-CAL-04: no network call, no row change -- rows just stay
    // `pending` until the secret is set.
    return { configured: false, skipped: db ? await countPending(db) : 0, sent: 0, failed: 0 };
  }
  if (!db) return { configured: true, skipped: 0, sent: 0, failed: 0 };

  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const candidates = await loadCandidateRows(db, limit);
  const now = Date.now();
  const rows = candidates.filter((r) => dueForRetry(r, now)).slice(0, limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.google_calendar_id) {
      // A resource with no calendar configured is not a retry-able
      // failure -- it may get one later -- so the row stays `pending`,
      // counted as skipped and flagged with a distinct last_error so the
      // owner view can tell "waiting on Google" apart from "waiting on
      // a calendar id Roger has not set yet".
      skipped += 1;
      await markNoCalendar(db, row);
      continue;
    }

    try {
      const accessToken = await getGoogleAccessToken(serviceAccount, fetchImpl);
      const event = buildEventBody({
        resourceName: row.resource_name,
        startAt: row.start_at,
        endAt: row.end_at,
        bookingId: row.booking_id,
      });
      const res = await callCalendarApi(fetchImpl, accessToken, row.google_calendar_id, row.action, event);

      // A retried drain that already succeeded against Google, but
      // crashed before marking the row `sent`, sees these on the
      // retry -- both mean "the end state is already what we wanted",
      // so they count as success rather than another failed attempt.
      const alreadyCreated = row.action === "create" && res.status === 409;
      const alreadyGone = row.action === "cancel" && (res.status === 404 || res.status === 410);

      if (res.ok || alreadyCreated || alreadyGone) {
        await markSent(db, row);
        sent += 1;
      } else {
        const text = await res.text().catch(() => "");
        await markAttemptFailed(db, row, `gcal_api_status=${res.status} body=${text}`);
        failed += 1;
      }
    } catch (err) {
      await markAttemptFailed(db, row, `${(err && err.name) || "Error"}: ${(err && err.message) || String(err)}`);
      failed += 1;
    }
  }

  return { configured: true, sent, failed, skipped };
}
