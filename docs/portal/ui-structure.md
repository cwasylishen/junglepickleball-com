# Portal UI structure (B1 contract for B2c/B2e/B2f1/B2f2)

Written by B1 (foundation). This is the shell contract every UI-owning part
builds against. It does not describe screens (see `screens.md`) -- only how a
new area attaches to the shell B1 ships.

## Files and ownership

| File | Owner | Purpose |
|---|---|---|
| `portal/index.html` | B1 (shell only; see below) | Top bar, preview ribbon, nav mount, `#portal-area` mount point, Alpine `portalShell()` root. |
| `portal/js/api.js` | B1 | `PortalApi.get/post/patch/del`. Every area module calls through this, never `fetch()` directly. |
| `portal/js/app.js` | B1 | `window.PortalApp` (`bootstrapSession`, `navForRole`, `handleLoginFragment`, `mergeStrings`), `window.STR.en` base dictionary, `window.PortalAreas` registry. |
| `portal/vendor/alpine-3.14.9.min.js` | B1 | Self-hosted Alpine (S-7/CTL-UI-01). Never load Alpine from a CDN on a portal page. |
| `portal/portal.css` | B1 build step (`npm run build:portal`), content added to by B2f via `portal/**/*.html` | Compiled from `portal/src/input.css` via `tailwind.portal.config.js`. Never edits `assets/styles.css` (A3). |
| `portal/views/*.html`, `portal/js/member.js`, `portal/js/owner.js`, `portal/js/staff.js`, `portal/js/account.js` | B2f1 (member/guest/staff/account) and B2f2 (owner) | Area templates and their Alpine component registrations. |
| `portal/js/passkeys.js` | B2c | Passkey UI calling the B2c-owned `/api/portal/auth/passkey/*` routes. |
| `portal/manifest.webmanifest`, `portal/sw.js`, `portal/js/pwa.js` | B2e | PWA install/push UI. |

## How an area attaches

1. The area's HTML lives in `portal/views/<area>.html` and is fetched and
   injected into `#portal-area` by the area's own router glue (a small
   hash-route dispatcher is NOT part of B1's shell; B2f1/B2f2 add it once
   there is more than one screen to route between -- B1 ships only the
   single signed-in/signed-out state in `index.html` as the minimal proof
   that session bootstrap and the login fragment work end to end).
2. The area's JS module calls `window.PortalApp.bootstrapSession()` to get
   `{ authenticated, features, csrf_token (via PortalApi.setCsrfToken,
   already done by bootstrapSession), account }` and reads `account.role`
   to decide what it shows.
3. Every string the area displays is added to `window.STR.en` via
   `window.PortalApp.mergeStrings({...})` -- never a literal string in a
   template -- so Spanish (PIN-10, later) is a second dictionary, not a
   rewrite.
4. Nav items for the area's role come from `window.PortalApp.navForRole(role)`
   (screens.md §2.2); an area never hardcodes its own tab list.
5. Every API call goes through `PortalApi`, which already attaches
   `X-CSRF-Token` from the session and treats a `{"error":"not_configured",
   "feature":...}` 503 as a planned state (screens.md §2.4), never a fault.

## What B1 proved end to end (see `tests/foundation/ui-shell.test.mjs`)

- `GET /portal/` (navigate-style request) returns 200 HTML with the CSP
  headers from `src/portal/http.js`.
- The compiled `portal/portal.css` exists and `assets/styles.css`'s bytes are
  unchanged by the portal build step (A3).
- `index.html`'s login form posts to `/api/portal/auth/start` and, on the
  preview demo gate, surfaces `dev_link` to `console.info` only -- never into
  the page body (PIN-9, F-D5).
- The login fragment handler consumes `#login=<token>` via POST only; a GET
  of the same URL does not touch the token (S-6, CTL-AUTH-03).
