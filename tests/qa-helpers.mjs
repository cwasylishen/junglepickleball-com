// QA2 shared helpers (qa-lead / Myers). Built on top of, never editing,
// tests/foundation/helpers.mjs (B1's harness). Black-box HTTP against
// the running `wrangler dev --local` (PIN-16); the one white-box lever
// is direct D1 writes for setup the API itself has no handle on
// (test-plan.md H-2), which PIN-16 permits on the LOCAL sqlite file.

import { execFileSync } from "node:child_process";
import { makeClient, loginDemo, startAndGetDevLink, BASE_URL, d1 } from "./foundation/helpers.mjs";

export { makeClient, loginDemo, startAndGetDevLink, BASE_URL, d1 };

let counter = 0;
// H-1: a fresh, unique @jp-demo.test email per case so test files never
// trip the per-email 5/15min limit (REQ-AUTH-07) on each other. Demo
// accounts created this way are real `accounts` rows (PIN-9's
// login-start creates them as `guest` automatically on first verify) --
// they are NOT in scripts/seed-preview.sql, which is deliberate per
// test-plan.md's note that REQ-AUTH-17 needs an account that doesn't
// pre-exist.
export function uniqueEmail(tag) {
  counter += 1;
  return `qa-${tag}-${Date.now()}-${counter}@jp-demo.test`;
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

// Logs in N freshly created accounts (new @jp-demo.test emails, each
// becomes a `guest` account on first verify) and returns their
// authenticated clients + csrf tokens. Resets the rate-limit table
// first (see resetRateLimits) because this is exactly the >4-logins
// case the note above names.
export async function loginFreshAccounts(n, tag) {
  resetRateLimits();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await loginDemo(uniqueEmail(`${tag}${i}`)));
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
