// Portal dispatch table (CTL-AUTHZ-01, CTL-CSRF-01) and the single
// environment-identity gate every portal/webhook/scheduled call passes
// through first (CTL-ENV-01/02/03). Called from src/worker.js by the one
// hook line B1 adds there.
//
// Extending this table: a B2 part adds its own routes by appending
// entries to ROUTES (import its handler module, push one object), in a
// commit that touches only the lines it adds -- the same discipline as
// docs/portal/api.md's per-owner append rule. It never edits another
// part's existing entries.

import { json, environmentMismatch, logAndMask, notConfigured, portalHtml } from "./http.js";
import {
  authStart,
  authVerify,
  logout,
  loadSession,
  isDemoEligibleHost,
  CSRF_EXEMPT_ROUTES,
  ownerSessions,
  ownerRevokeOtherSessions,
  ownerHealth,
} from "./auth.js";
import { ROUTE_CLASSES, authorize } from "./authz.js";
import { publicAccount } from "./auth.js";
import { handleStripeWebhook } from "./stripe-webhook-stub.js";
import { resolveEntitlement } from "./entitlement.js";

const PROD_HOSTS = new Set(["junglepickleball.com", "www.junglepickleball.com"]);

// controls.md's GEN-03 note suggests caching the environment class per
// isolate for up to 60s to bound the extra D1 read per request. B1
// deliberately does NOT: CTL-ENV-02 exists precisely so a real-data leak
// (or a corrected marker) takes effect immediately, and a 60s-stale
// cache would let exactly the request this control exists to refuse
// through for up to a minute after the DB state changed. The query
// below is one indexed SELECT (and, on the preview path, one COUNT); if
// that ever shows up as real latency, the fix is a short TTL tied to a
// value that actually changes with the data (e.g. the marker row's own
// last-write time), not a blind time window -- flagged for the
// conductor/release-captain rather than built speculatively here.
async function computeEnvironmentClass(db, hostname) {
  const marker = await db.prepare(`SELECT env FROM portal_meta WHERE id = 1`).first();
  const markerEnv = marker ? marker.env : null;
  const hostIsPreview = isDemoEligibleHost(hostname);
  const hostIsProd = PROD_HOSTS.has(hostname);

  if (hostIsPreview && markerEnv === "preview") {
    const nonDemo = await db
      .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE is_demo = 0 OR email NOT LIKE '%@jp-demo.test'`)
      .first();
    if (nonDemo && nonDemo.n > 0) return "mismatch"; // CTL-ENV-02
    return "preview";
  }
  if (hostIsProd && markerEnv === "production") {
    const demoRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE is_demo = 1 OR email LIKE '%@jp-demo.test'`)
      .first();
    if (demoRow && demoRow.n > 0) return "mismatch"; // CTL-ENV-01 (e)
    return "production";
  }
  return "mismatch";
}

export async function resolveEnvironmentClass(db, hostname) {
  return computeEnvironmentClass(db, hostname);
}

// CTL-ENV-01 (f) / CTL-ENV-03: handlers receive only this filtered view,
// never the raw env.
export function buildPortalEnv(env, envClass) {
  const out = {
    PORTAL_DB: env.PORTAL_DB,
    OWNER_EMAILS: env.OWNER_EMAILS,
    PORTAL_DEV_LOGIN: env.PORTAL_DEV_LOGIN,
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
    VAPID_SUBJECT: env.VAPID_SUBJECT,
    envClass,
  };
  let stripeKey = env.STRIPE_SECRET_KEY;
  if (envClass === "preview" && stripeKey && /^(sk|rk)_live_/.test(stripeKey)) stripeKey = undefined;
  if (envClass === "production" && stripeKey && /^(sk|rk)_test_/.test(stripeKey)) {
    // eslint-disable-next-line no-console
    console.log("stripe_test_key_in_production");
    stripeKey = undefined;
  }
  out.STRIPE_SECRET_KEY = stripeKey;
  out.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
  if (envClass !== "preview") {
    out.EMAIL = env.EMAIL;
    out.GOOGLE_SERVICE_ACCOUNT_JSON = env.GOOGLE_SERVICE_ACCOUNT_JSON;
    out.VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY;
  }
  return out;
}

async function handleMe(request, env, db, url, session, account) {
  const features = {
    stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    gcal: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    passkeys: true,
    preview: env.envClass === "preview",
  };
  if (!session || !account) return json({ authenticated: false, features });
  const entitlement = await resolveEntitlement(db, account.id);
  return json({
    authenticated: true,
    features,
    csrf_token: session.csrf_token,
    account: publicAccount(account),
    entitlement: { entitled: entitlement.entitled, tier: entitlement.tier, overlap: entitlement.overlap },
  });
}

// B1's own routes. Each B2 part appends its routes here (see file
// header). class/path/method drive both dispatch and the CTL-AUTHZ-01 /
// CTL-CSRF-01 sweeps, which read this table rather than a hand list.
export const ROUTES = [
  { method: "POST", path: "/api/portal/auth/start", class: "public", handler: (ctx) => authStart(ctx.request, ctx.env, ctx.db, ctx.url) },
  { method: "POST", path: "/api/portal/auth/verify", class: "public", handler: (ctx) => authVerify(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session) },
  { method: "POST", path: "/api/portal/auth/logout", class: "own", handler: (ctx) => logout(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session) },
  { method: "GET", path: "/api/portal/me", class: "own", handler: (ctx) => handleMe(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account) },
  { method: "GET", path: "/api/portal/owner/sessions", class: "owner", handler: (ctx) => ownerSessions(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account) },
  { method: "POST", path: "/api/portal/owner/sessions/revoke-others", class: "owner", handler: (ctx) => ownerRevokeOtherSessions(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account) },
  { method: "GET", path: "/api/portal/owner/health", class: "owner", handler: (ctx) => ownerHealth(ctx.request, ctx.env, ctx.db) },
];

function matchRoute(method, path) {
  return ROUTES.find((r) => r.method === method && r.path === path) || null;
}

async function loadAccount(db, accountId) {
  if (!accountId) return null;
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
}

// Exported for the CTL-CSRF-01 / CTL-AUTHZ-01 sweeps (tests read the
// live table, never a hand copy).
export function routeTable() {
  return ROUTES.map((r) => ({ method: r.method, path: r.path, class: r.class }));
}

export async function handlePortalRequest(request, env, url) {
  const db = env.PORTAL_DB;
  if (!db) return environmentMismatch();

  try {
    const envClass = await resolveEnvironmentClass(db, url.hostname);

    if (url.pathname === "/api/stripe/webhook" && request.method === "POST") {
      if (envClass === "mismatch") return environmentMismatch();
      const penv = buildPortalEnv(env, envClass);
      return handleStripeWebhook(request, penv, db);
    }

    if (!url.pathname.startsWith("/api/portal/")) return null; // not ours

    if (envClass === "mismatch") return environmentMismatch();
    const penv = buildPortalEnv(env, envClass);

    const session = await loadSession(request, env, db, url);
    const account = session ? await loadAccount(db, session.account_id) : null;

    const route = matchRoute(request.method, url.pathname);
    if (!route) return json({ error: "not_found" }, 404);

    const auth = authorize(route.class, session, account);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    // CTL-CSRF-01: every non-GET /api/portal/* route requires the CSRF
    // token, except the exact exemption list (which is Origin-checked
    // instead -- auth.* handlers check Origin themselves).
    if (request.method !== "GET") {
      const key = `${request.method} ${url.pathname}`;
      if (!CSRF_EXEMPT_ROUTES.has(key)) {
        const sentToken = request.headers.get("X-CSRF-Token");
        const origin = request.headers.get("Origin");
        if (!session || !sentToken || sentToken !== session.csrf_token || !origin || new URL(origin).origin !== url.origin) {
          return json({ error: "csrf_required" }, 403);
        }
      }
    }

    return await route.handler({ request, env: penv, db, url, session, account });
  } catch (err) {
    return logAndMask(err);
  }
}

// GET /portal/* is normally served directly by the static assets layer
// (portal/index.html). This fallback exists only so the Worker itself
// also answers a navigate-style request correctly if it is ever invoked
// for a /portal path that matched no static file (e.g. a deep link with
// no matching static alias), per the acceptance test.
export async function handlePortalShellFallback(request, env, url) {
  if (!url.pathname.startsWith("/portal")) return null;
  const asset = await env.ASSETS.fetch(new URL("/portal/index.html", url.origin));
  if (asset.ok) return portalHtml(await asset.text());
  return null;
}
