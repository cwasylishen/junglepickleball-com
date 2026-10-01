// QA2 shared helpers (qa-lead / Myers). Built on top of, never editing,
// tests/foundation/helpers.mjs (B1's harness). Black-box HTTP against
// the running `wrangler dev --local` (PIN-16); the one white-box lever
// is direct D1 writes for setup the API itself has no handle on
// (test-plan.md H-2), which PIN-16 permits on the LOCAL sqlite file.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { makeClient, loginDemo as loginDemoRaw, startAndGetDevLink as startAndGetDevLinkRaw, BASE_URL, d1 } from "./foundation/helpers.mjs";
import { sha256Hex } from "../src/portal/auth.js";

export { makeClient, BASE_URL, d1 };

// QA3 fix (rate limits, per dispatch): "reset the local rate-limit table
// before each login helper call, so the 5-per-email limit is a tested
// behaviour, not suite-wide starvation." Run 2 of this dispatch (the
// permitted rerun) proved exactly this failure mode for real: dozens of
// `loginDemo()`/`startAndGetDevLink()` calls spread across many files
// (not-configured.test.mjs, passkeys-ctl-pk-01.test.mjs, push-routes.
// test.mjs, stripe-not-configured.test.mjs, roles.test.mjs -- not an
// exhaustive list) share ONE per-IP budget (CF-Connecting-IP is never
// sent by this harness, so every request keys to `ip:unknown`) across
// the ENTIRE 48-file run, and only a few files (booking-bounds.test.mjs,
// races.test.mjs's loginFreshAccounts) ever reset it. Any file that
// relied on "resetRateLimits() once at file load is enough" was wrong
// whenever the cumulative count of logins across files before its own
// turn -- or within its own file, past the 5-per-email/20-per-IP
// boundary -- pushed the shared budget over the line; the result was
// not a clean assertion failure but an UNCAUGHT "no dev_link" exception
// (startAndGetDevLink throws when the response has no dev_link field),
// which crashes the whole test as an error, not a named defect.
// Wrapping the two login entry points here, in the one shared helper
// file every test imports from, resets before every call -- this is the
// generic fix the dispatch asked for, not a per-call-site patch that
// the next new test file could still get wrong. The explicit rate-limit
// tests (AUTH-006/007/008/009) are unaffected: they call `makeClient().
// post(...)` directly against the raw foundation client, never through
// these two wrapped functions, so they still observe and assert on the
// real, un-reset rate-limit behaviour test-plan.md's H-1 describes.
export async function startAndGetDevLink(client, email, origin) {
  resetRateLimits();
  return startAndGetDevLinkRaw(client, email, origin);
}

export async function loginDemo(email, extraHeaders = {}) {
  resetRateLimits();
  return loginDemoRaw(email, extraHeaders);
}

let counter = 0;
// H-1: a fresh, unique @jp-demo.test email per case so test files never
// trip the per-email 5/15min limit (REQ-AUTH-07) on each other. NOTE
// (QA3, demo-account starvation): an address minted by this function has
// NO pre-existing `accounts` row, so src/portal/auth.js's demoDevLink()
// (S-1 e: "must already exist, flagged demo") will NEVER return a
// dev_link for it -- that is the pin working as designed, not a bug.
// Use this for: (a) emails that never need to actually log in via the
// dev-link path (e.g. AUTH-001's token-hash check), or (b) with
// loginNewAccountDirect() below, which bypasses demoDevLink on purpose
// to prove the genuinely-new-account path (REQ-AUTH-17). For every other
// "I just need a fresh, working login" case, use poolEmail()/loginPooled().
export function uniqueEmail(tag) {
  counter += 1;
  return `qa-${tag}-${Date.now()}-${counter}@jp-demo.test`;
}

// ---------- QA3: demo-account-starvation fix ----------
// tests/fixtures/seed-test.sql (local-only, loaded by scripts/test.sh
// after the preview seed) pre-seeds qa01..qa50@jp-demo.test as
// is_demo=1 accounts, so these are always PIN-9-eligible: demoDevLink()
// finds a pre-existing, flagged-demo row and issues a real dev_link.
// poolEmail() hands out the pool in order (module-scoped counter, reset
// per test FILE because `node --test` runs each file in its own
// process) so two call sites in the SAME file never collide on one
// email -- which matters for any site that does an email-scoped D1
// lookup afterward (e.g. AUTH-002/003's backdating UPDATE). 50 slots is
// comfortably more than any one file's call-site count in this suite
// (races.test.mjs, the heaviest user, needs ~44).
const DEMO_POOL_SIZE = 50;
let poolCounter = 0;
export function poolEmail() {
  poolCounter += 1;
  const n = ((poolCounter - 1) % DEMO_POOL_SIZE) + 1;
  return `qa${String(n).padStart(2, "0")}@jp-demo.test`;
}

// Convenience: loginDemo() against the next pool email.
export async function loginPooled() {
  return loginDemo(poolEmail());
}

// For the ONE class of case the pool cannot serve: proving the
// genuinely-new-account path (REQ-AUTH-17, AUTH-019/020), which needs an
// email with NO pre-existing `accounts` row at all. This is the same
// white-box-on-setup technique tests/foundation/auth-token-single-use.
// test.mjs already uses for M3 -- a login_tokens row is inserted
// directly (never through POST /auth/start, so demoDevLink's S-1 e gate
// is never consulted), then the real HTTP /auth/verify route is driven
// with the resulting raw token. Black-box on the endpoint under test
// (verify), white-box on setup (H-2's own stated distinction).
export async function loginNewAccountDirect(email, extra = {}) {
  const client = makeClient();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = await sha256Hex(token);
  const id = `tok-qa3-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nowIsoStr = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  d1(
    `INSERT INTO login_tokens (id, email, token_hash, created_at, expires_at, ip) VALUES ('${id}', '${email}', '${tokenHash}', '${nowIsoStr}', '${expiresIso}', '127.0.0.1')`
  );
  const origin = { Origin: BASE_URL, ...extra };
  const verify = await client.post("/api/portal/auth/verify", { token, age_16_plus: true, confirm: true }, origin);
  if (verify.status !== 200) throw new Error(`verify failed for ${email}: ${verify.status} ${JSON.stringify(verify.data)}`);
  return { client, csrfToken: verify.data.csrf_token, account: verify.data.account };
}

// QA3 FINDING (races.test.mjs, discovered while fixing the grid
// fixtures): a court booking by a non-entitled, no-credit account hits
// src/portal/booking.js's own "pay" branch, which returns 503 (Stripe
// unset, S-11/S-12) BEFORE any write -- RACE-001/002/003/005/006/007/008
// all book courts with freshly-logged-in guest accounts that have
// neither an entitlement nor a credits balance, so every one of those
// cases would 503 before ever reaching the overlap/race logic under
// test, for a reason that has nothing to do with the race. Giving the
// account a same-shape hand grant (source='hand', the exact pattern
// scripts/seed-preview.sql already uses for member.demo) makes
// resolveAudience return mode="included" for court kind, which never
// touches credits or Stripe -- this is fixture setup (an account's
// entitlement), not a product edit.
export function grantEntitlement(accountId, tier = "jp_annual_single") {
  d1(
    `INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, note, created_at, updated_at)
     VALUES ('qa-grant-${accountId}', '${accountId}', 'hand', '${tier}', datetime('now'), datetime('now', '+1 year'), 'active', 'demo-owner-0000-0000-000000000001', 'QA3 test fixture grant', datetime('now'), datetime('now'))`
  );
}

// QA3 PERFORMANCE FIX (found via this dispatch's own rerun, races.
// test.mjs): `accounts.forEach(a => grantEntitlement(a.account.id))`
// calls d1() once PER account -- 20 separate `wrangler d1 execute` CLI
// spin-ups for RACE-001 alone. On a shared, contended host (confirmed
// via `ps aux` during this dispatch: several other seats' `wrangler
// dev`/`d1 execute` processes running concurrently) a single d1() call
// can cost 10-30s, so 20 of them in a tight loop reliably exceeds even
// the raised 180s per-file budget -- and did, in this dispatch's own
// rerun: races.test.mjs's entire file timed out before RACE-001's first
// grant finished, so NONE of RACE-001..011 got to run at all. One
// multi-row INSERT in a SINGLE d1() call is the fix -- same effect, one
// CLI spin-up instead of N.
export function grantEntitlements(accountIds, tier = "jp_annual_single") {
  if (accountIds.length === 0) return;
  const values = accountIds
    .map(
      (id) =>
        `('qa-grant-${id}', '${id}', 'hand', '${tier}', datetime('now'), datetime('now', '+1 year'), 'active', 'demo-owner-0000-0000-000000000001', 'QA3 test fixture grant', datetime('now'), datetime('now'))`
    )
    .join(",\n       ");
  d1(
    `INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, note, created_at, updated_at)
     VALUES ${values}`
  );
}

// A9 permits a test file to clear the shared rate-limit table itself.
// FINDING (qa-run-1.md): test-plan.md's H-1 per-file budget (<=20 IP
// starts/file, synthetic emails) does not scale to RACE-001/003/009,
// which each need many distinct freshly-logged-in accounts in the same
// 15-minute window as every other file in the suite. Rather than let
// those cases fail on 429 (the WRONG reason -- noise, not the booking
// defect under test), every file that needs more than ~4 fresh logins
// resets the table immediately before doing so, and this is named here
// as a deviation from the original per-file budget, not hidden.
export function resetRateLimits() {
  d1(`DELETE FROM rate_limits`);
}

// Logs in N accounts and returns their authenticated clients + csrf
// tokens. Resets the rate-limit table first (see resetRateLimits)
// because this is exactly the >4-logins case the note above names.
// QA3 fix: draws from the pre-seeded demo pool (poolEmail()), not a
// brand-new uniqueEmail() -- a brand-new address can never get a
// dev_link (demo-account starvation, see poolEmail()'s comment above).
// `tag` is kept as a parameter for call-site readability only; it no
// longer affects the email minted.
export async function loginFreshAccounts(n, tag) {
  resetRateLimits();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await loginDemo(poolEmail()));
  }
  return out;
}

// ---------- Stripe-style webhook signature (research.md Q3/A1) ----------
// Stripe's documented method: HMAC-SHA256 over `${t}.${rawBody}`, hex
// digest, header `Stripe-Signature: t=<t>,v1=<hex>`.
export async function signStripeBody(secret, rawBody, t) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

// Raw POST (no JSON auto-stringify, needed for webhook body + signature
// headers computed over the exact bytes sent).
export async function postRaw(path, rawBody, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", body: rawBody, headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, res };
}

// makeClient() (B1's harness) exposes only get/post. A few api.md routes
// are PATCH (PATCH /api/portal/me, PATCH /api/portal/owner/resources/:id)
// -- this sends one using the same client's current cookie so the
// request is still authenticated, without editing foundation/helpers.mjs.
export async function patchWithClient(client, path, body, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  const cookie = client.getCookie();
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE_URL}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, res };
}

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------- PIN-6 Costa Rica <-> UTC conversion (FR2-E, fixes M11) ----------
// BRIEF-AND-PINS.md PIN-6: every stored instant is UTC ISO-8601; every
// displayed time is America/Costa_Rica, a FIXED UTC-6 offset with no DST.
// So CR wall-clock + 6h == the UTC instant. This is the one conversion
// every booking-window/grid fixture in the suite depends on -- get it
// wrong here and every test built on it "passes" without ever exercising
// the CR time it names (M11's defect).
const CR_UTC_OFFSET_HOURS = 6;

// Pure, no "now" dependency: the CR wall-clock reading (year, 1-12 month,
// day, hour, minute) that a test can name directly, converted to the UTC
// instant PIN-6 requires on the wire. Exported so a test file can assert
// the conversion itself in isolation, e.g. CR 07:00 on a given date ==
// 13:00Z.
export function crWallClockToUtcIso(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) + CR_UTC_OFFSET_HOURS * 3600 * 1000).toISOString();
}

// `daysAhead` CR calendar days from TODAY in Costa Rica (not the test
// runner's own zone) at the named CR hour:minute. Replaces the old local
// `crDateAt` in booking-bounds.test.mjs, which set UTC hours while the
// tests named CR times (M11).
export function crDateAt(daysAhead, hour, minute = 0) {
  const nowUtc = new Date();
  // Shift "now" back 6h and read its UTC Y/M/D: that is today's CR
  // calendar date, because CR local = UTC - 6h exactly, always (no DST).
  const nowCr = new Date(nowUtc.getTime() - CR_UTC_OFFSET_HOURS * 3600 * 1000);
  return crWallClockToUtcIso(nowCr.getUTCFullYear(), nowCr.getUTCMonth() + 1, nowCr.getUTCDate() + daysAhead, hour, minute);
}
