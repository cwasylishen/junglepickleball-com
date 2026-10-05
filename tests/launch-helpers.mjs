// Shared fixtures for the launch-rule tests (day-hours, booking rules,
// owner routes). A production-seeded real-SQLite database, accounts and
// sessions written straight into it, and a Costa Rica clock helper.

import { openTestDb } from "./d1-sqlite.mjs";
import { sha256Hex } from "../src/portal/auth.js";
import { crDateTimeToUtcIso } from "../src/portal/cr-time.js";

export { crDateTimeToUtcIso };

// Monday 2026-10-05 09:00 in Costa Rica (15:00 UTC). Tests that need a
// fixed "now" mock Date to this instant.
export const NOW_UTC_MS = Date.parse("2026-10-05T15:00:00.000Z");
export const TODAY_CR = "2026-10-05";

export function prodDb() {
  const db = openTestDb();
  db.execFile("scripts/seed-prod.sql");
  return db;
}

export function addAccount(db, { id, email, role = "member" }) {
  db.sqlite
    .prepare(`INSERT INTO accounts (id, email, role, display_name, is_demo, age_attested_at, created_at, updated_at) VALUES (?,?,?,?,0,'x','x','x')`)
    .run(id, email, role, id);
  return { id, email, role };
}

// A member: any active entitlement makes the account entitled.
export function makeMember(db, id, tier = "jp_annual_single") {
  const account = addAccount(db, { id, email: `${id}@example.com`, role: "member" });
  db.sqlite
    .prepare(`INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, created_at, updated_at) VALUES (?,?,'hand',?,?,?,'active',?,'x','x')`)
    .run(`grant-${id}`, id, tier, "2026-01-01T00:00:00.000Z", "2027-12-31T00:00:00.000Z", id);
  return account;
}

// A session row with a known cookie and CSRF token, so a test can call
// handlePortalRequest the way a browser would.
export async function sessionFor(db, accountId) {
  const token = `t-${accountId}`.padEnd(43, "x");
  const csrf = `csrf-${accountId}`;
  db.sqlite
    .prepare(`INSERT INTO sessions (id, account_id, csrf_token, method, user_agent_family, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(await sha256Hex(token), accountId, csrf, "link", "other", "2026-10-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
  return { cookie: `__Host-jp_portal=${token}`, csrf };
}

export const PROD_ORIGIN = "https://junglepickleball.com";

// Calls the portal exactly as the Worker does, on the production host.
export async function callPortal(db, env, { method = "GET", path, body, session }) {
  const { handlePortalRequest } = await import("../src/portal/router.js");
  const url = new URL(path, PROD_ORIGIN);
  const headers = { "Content-Type": "application/json", Origin: PROD_ORIGIN };
  if (session) {
    headers.Cookie = session.cookie;
    if (method !== "GET") headers["X-CSRF-Token"] = session.csrf;
  }
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await handlePortalRequest(request, { PORTAL_DB: db, ...env }, url);
  return { status: response.status, data: await response.json().catch(() => null) };
}
