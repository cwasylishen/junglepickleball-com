// Owned by B2c (amendment 5 build cut, B1-fix amendment 6). The passkey
// routes from docs/portal/api.md §1/§6 (register/login start+finish,
// GET/DELETE /api/portal/passkeys[/:id]) -- this file alone, never
// src/portal/router.js, which only imports and concatenates this array.
// Same entry shape as router.js's own B1_ROUTES.
//
// The two login routes are in auth.js's CSRF_EXEMPT_ROUTES (Origin-
// checked instead, like auth/start); register/list/delete are "own"
// and go through the normal CSRF+Origin check.

import { passkeyRegisterStart, passkeyRegisterFinish, passkeyLoginStart, passkeyLoginFinish, listPasskeys, deletePasskey } from "../passkeys.js";

export const ROUTES = [
  { method: "POST", path: "/api/portal/auth/passkey/register/start", class: "own", handler: (ctx) => passkeyRegisterStart(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account) },
  { method: "POST", path: "/api/portal/auth/passkey/register/finish", class: "own", handler: (ctx) => passkeyRegisterFinish(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account) },
  { method: "POST", path: "/api/portal/auth/passkey/login/start", class: "public", handler: (ctx) => passkeyLoginStart(ctx.request, ctx.env, ctx.db, ctx.url) },
  { method: "POST", path: "/api/portal/auth/passkey/login/finish", class: "public", handler: (ctx) => passkeyLoginFinish(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session) },
  { method: "GET", path: "/api/portal/passkeys", class: "own", handler: (ctx) => listPasskeys(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account) },
  { method: "DELETE", path: "/api/portal/passkeys/:id", class: "own", handler: (ctx) => deletePasskey(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account, ctx.params) },
];
