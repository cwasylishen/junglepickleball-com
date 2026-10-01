# Jungle Pickleball portal: API contract

Written by B1 (foundation), 2026-09-30, for every B2 part to build against in parallel.
**B1 implements §1 and §2 below; every other section is the contract B2 parts build to.**
A B2 part appends full request/response detail **only to its own section**, as a separate
diff hunk, and logs a dated changelog line at the bottom if it must change a shape B1 shipped.
It never silently changes another part's rows -- a shape change is reported as a finding.

Conventions: all times UTC ISO-8601 in request/response bodies (PIN-6; the UI converts to
Costa Rica for display). Money is integer cents. Every non-GET `/api/portal/*` route except
the four in `CSRF_EXEMPT_ROUTES` (`src/portal/auth.js`) requires header `X-CSRF-Token`
matching the session's token, **and** an `Origin` header matching the request origin. A
`route class` of `public`/`own`/`staff-own`/`owner` is enforced centrally by
`src/portal/router.js` reading `ROUTES` (never a per-handler check). `ROUTES` is assembled
from one file per B2 part under `src/portal/routes/` (`booking.js`, `owner.js`, `stripe.js`,
`passkeys.js`, `push.js`, each exporting its own `ROUTES` array) plus `router.js`'s own B1
routes -- a part edits only its own file, never `router.js`'s table directly (B1-fix,
amendment 6). `403 csrf_required` /
`401 not_authenticated` / `403 owner_only` / `403 staff_only` / `403 route_unclassed` are
possible on every protected route and are not repeated per row below. Any unhandled throw
becomes `500 {"error":"server_error"}` (CTL-ERR-01).

---

## 1. Auth (B1, built)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/portal/auth/start` | public (Origin-checked, CSRF-exempt) | `{email}` | `200 {ok:true}`, `+{dev_link}` only under PIN-9/S-1 | `403 origin_required`, `400 invalid_request`. Identical shape whether the email exists or is rate-limited (PIN-8). |
| `POST /api/portal/auth/verify` | public (Origin-checked, CSRF-exempt) | `{token, age_16_plus?, confirm?}` | `200 {ok, first_login, csrf_token, account:{id,email,role,display_name}}` + `Set-Cookie` | `400 verify.bad_invalid` / `verify.bad_used` / `verify.bad_expired`, `409 age_confirmation_required`, `409 confirm_account_switch {account_hint}` |
| `POST /api/portal/auth/logout` | own | — | `200 {ok:true}` + cleared cookie | — |
| `POST /api/portal/auth/passkey/register/start` | own | — | WebAuthn registration options | `503 not_configured {feature:"passkeys"}` until B2c lands |
| `POST /api/portal/auth/passkey/register/finish` | own | `{credential}` | `200 {ok:true}` | `400 passkey_invalid` |
| `POST /api/portal/auth/passkey/login/start` | public (Origin-checked, CSRF-exempt) | `{email}` | WebAuthn login options | same shape-hiding rule as login-start |
| `POST /api/portal/auth/passkey/login/finish` | public (Origin-checked, CSRF-exempt) | `{credential}` | same success shape as verify | `400 passkey_invalid`, `400 verify.bad_*` |

*(The two passkey/register rows are placeholders for B2c's section 4; B2c may restate them there with full detail -- this row stays as the CSRF-exemption contract for `src/portal/auth.js`'s route table.)*

## 2. Session (B1, built)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/portal/me` | own | — | Signed out: `200 {authenticated:false, features:{stripe,push,gcal,passkeys,preview}}`. Signed in: `200 {authenticated:true, features, csrf_token, account:{id,email,role,display_name}, entitlement:{entitled,tier,overlap}}` | — |
| `GET /api/portal/owner/sessions` | owner | — | `[{id,method,user_agent_family,created_at,last_used_at,current}]` (CTL-AUTH-01) | |
| `POST /api/portal/owner/sessions/revoke-others` | owner | — | `200 {ok:true}` -- deletes every other session row of the caller's own account | |
| `GET /api/portal/owner/health` | owner | — | `{owners, email_configured, email_send_failed_24h, stripe_configured, gcal_configured, push_configured}` (CTL-AUTH-06, CTL-OWN-01; §4 adds `outbox`) | |

`features.*` are booleans computed from the filtered env (CTL-ENV-01 f): `stripe` = both Stripe
secrets set, `push` = both VAPID keys set, `gcal` = Google credential set, `passkeys` = always
true (client capability, not a secret), `preview` = this request resolved to the `preview`
environment class. The UI (screens.md §10 item 1) uses these to show "not configured" states
**before** a 503, never only after.

`PATCH /api/portal/me` is **owned by B2a2**, not B1 (amendment 5 ruling F-8). Contract: accepts
only `{display_name}` (CTL-AUTHZ-03); every other field in the body is ignored, not rejected.

---

## 3. Booking engine -- B2a1 (`src/portal/booking.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/portal/resources` | own | — | `[{id, kind, name, open_time, close_time, slot_minutes, buffer_minutes, member_included, offerings:[{id,name,duration_minutes,audience,display_price_cents}]}]` | — |
| `GET /api/portal/resources/:id/availability?date=YYYY-MM-DD` | own | — | `{slots:[{start,end,state}]}`, `state ∈ {available,taken,held,held_mine,mine,blocked,past}` (screens §10 item 2). No account fields for member/guest (CTL-AVL-01). Owner variant (`GET /api/portal/owner/resources/:id/availability`, B2a2) adds `display_name`, `booking_id`. | `400 bad_date` |
| `GET /api/portal/resources/:id/quote?offering_id=&start=&party_size=` | own | — | `{mode, unit_cents, party_size, total_cents, credits_needed, credits_have, cancel_cutoff_minutes}` (screens §10 item 3), `mode` from `entitlement.resolveAudience` | `409 price_not_set` |
| `POST /api/portal/bookings` | own | `{resource_id, offering_id?, start, party_size, free_kids?}` | `201 {booking:{id,status,payment_mode,hold_expires_at?,checkout_url?}}`. **Must not create any row at all if a paid path is `not_configured` (S-11/F-D1) -- check Stripe configuration before inserting a hold.** | `409 slot_taken`, `409 outside_window`, `409 in_past`, `409 blocked`, `409 cap_reached`, `409 insufficient_credits`, `409 price_not_set`, `503 not_configured {feature:"stripe"}` |
| `POST /api/portal/bookings/:id/cancel` | own | — | `200 {ok:true, credits_returned}` | `404` (not this account's or already cancelled), `409 past_cutoff` (`cancel.err_cutoff`) |
| `GET /api/portal/bookings` | own | — | `[{id,resource,start,end,status,payment_mode}]`, this account's own rows only | — |

Credit spend/return is one function in `booking.js` (CTL-CRD-01); it is never computed inline in
the create/cancel handlers.

## 4. Owner & staff ops -- B2a2 (`src/portal/resources.js`, `owner.js`, `staff.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `PATCH /api/portal/me` | own | `{display_name}` | `200 {account}` | (see §2) |
| `GET /api/portal/owner/accounts` | owner | — | `[{id,email,role,display_name,is_demo,entitlement:{tier,overlap}}]` (CTL-ENV-02 refuses this on a non-demo-polluted preview DB) | |
| `GET /api/portal/owner/accounts/:id` | owner | — | account detail + grants + households + dependants + bookings | `404` |
| `POST /api/portal/owner/accounts/:id/grant` | owner | `{tier, starts_at, ends_at, note}` | `201 {grant}` (D-A05, audited, one batch with the audit row) | `400 bad_tier` |
| `POST /api/portal/owner/accounts/:id/household-link` | owner | `{partner_account_id}` | `200 {household}` (D-A02) | `409 already_linked` |
| `DELETE /api/portal/owner/households/:id` | owner | — | `200 {ok:true}` (unlink) | |
| `POST /api/portal/owner/accounts/:id/dependants` | owner | `{first_name, birth_year}` | `201 {dependant}` (D-A03; first name + birth year only, CTL-DATA-04) | |
| `PATCH /api/portal/owner/accounts/:id/role` | owner | `{role}`, `role ≠ 'owner'` always enforced | `200 {account}` | `403` if `role:'owner'` attempted (CTL-ROLE-02) |
| `DELETE /api/portal/owner/accounts/:id` | owner | — | `200 {ok:true}` | |
| `GET /api/portal/owner/today?date=YYYY-MM-DD` | owner | — | every resource's bookings for that CR date, `state ∈ {confirmed,held,blocked,paid_conflict}`, `payment_intent_id`, `walk_in_name`, `block.weekly` (screens §10 item 8) | |
| `GET /api/portal/owner/resources` / `POST` / `PATCH /:id` | owner | resource fields (CTL-AUTHZ-03 explicit list) | resource row + `unconfirmed_fields` | `400` on out-of-range values (CTL-RES-01: slot 0, buffer < 0, close ≤ open → 400) |
| `POST /api/portal/owner/resources/:id/confirm-field` | owner | `{field}` | `200 {ok:true}` (audited; clears that name from `unconfirmed_fields`) | |
| `GET/POST/PATCH/DELETE /api/portal/owner/resources/:id/offerings[/:offeringId]` | owner | offering fields | offering row | |
| `GET/POST/DELETE /api/portal/owner/blocks[/:id]` | owner | `{resource_id, kind, weekday|date, start_time, end_time, label}` | block row(s) | Warns, never bumps an existing booking (F-D3) |
| `POST /api/portal/owner/bookings` (owner override, D-A11) | owner | `{resource_id, start, account_id? , walk_in_name?}` | `201 {booking}`, bypasses window/entitlement/payment | `409 slot_taken` (no bumping) |
| `GET /api/portal/owner/health` | owner | — | `{owners:[...], email_configured, email_send_failed_24h, stripe_configured, gcal_configured, push_configured, outbox:{pending,failed}}` (CTL-OWN-01, CTL-AUTH-06, CTL-UI-06) | |
| `GET /api/portal/owner/outbox` | owner | — | `{pending, failed:[...]}` (screens §10 item 9) | |
| `GET /api/portal/owner/overlaps` | owner | — | accounts with >1 valid entitlement source (P-4) | |
| `GET /api/portal/staff/calendar?date=` | staff-own | — | `[{start,end,resource,display_name,state}]`, this staff's own resource only, no email/phone/notes/payment (D-A16) | `403` if asking another resource (CTL-STF-01) |

## 5. Stripe -- B2b (`src/portal/stripe.js`, replaces `src/portal/stripe-webhook-stub.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/stripe/webhook` | public, signature-checked (never CSRF/Origin) | raw Stripe event | `200 {received:true}` | `400` bad signature. Idempotent on `event.id` (`webhook_events`). |
| `POST /api/portal/billing/portal-session` | own | — | `303`-style `{url}` to a server-created Stripe Customer Portal session | `503 not_configured {feature:"stripe"}` |
| `GET /api/portal/billing/history` | own | — | `[{amount_cents, kind, status, created_at}]` from Stripe `charges?customer=`, only the caller's own `stripe_customer_id` (CTL-STR-03) | `503 not_configured` |
| `POST /api/portal/owner/resources/:id/offerings/:offeringId/price` | owner | `{price_cents}` | `200 {offering}` -- creates a new Stripe Price on the same product with the same `lookup_key` + `transfer_lookup_key=true`, updates the mirror (amendment 4 decision 7) | `503 not_configured`, changes nothing when unset |

**Replacing B1's stub:** `src/portal/router.js` already imports `handleStripeWebhook` from
`./stripe.js` (B1-fix, amendment 6). B1 commits that file with
`isStripeConfigured`/`createBookingCheckout`/`handleStripeWebhook` as non-throwing interface
stubs (amendment 6's interface-first commit); B2b replaces the stub bodies in place -- it
never needs to touch `router.js`'s import line.

## 6. Passkeys -- B2c (`src/portal/passkeys.js`, `portal/js/passkeys.js`)

Builds out §1's two placeholder route pairs with full WebAuthn ceremony detail
(`@simplewebauthn/server@14.0.3`). `GET /api/portal/passkeys` / `DELETE /api/portal/passkeys/:id`
(own) manage L6. RP ID is the request hostname (R-2) -- stated, not fixed, so a passkey made on
one preview URL will not verify on the next.

## 7. Google Calendar -- B2d (`src/portal/gcal.js`)

No new `/api/portal/*` route is required for the one-way push itself (it drains
`calendar_outbox` from cron/`waitUntil`). `GET /api/portal/owner/resources/:id` (B2a2's row,
§4) gains a `google_calendar_id` field B2d documents here once set. The one-time import tool
is a CLI script (`scripts/gcal-import.mjs`), not an API route; its dry-run/`--apply` contract is
documented in `docs/portal/gcal-import.md` (B2d's file).

## 8. PWA and push -- B2e (`src/portal/push.js`, `src/portal/cron.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/portal/push/subscribe` | own | `{endpoint, keys:{p256dh, auth}}` | `200 {ok:true}` (upsert on `endpoint`, CTL-PSH-02) | `503 not_configured {feature:"push"}` |
| `POST /api/portal/push/unsubscribe` | own | `{endpoint}` | `200 {ok:true}` | |

Reminders (24h/2h) send from the cron body only, payload `{booking_id, kind}` -- no name,
resource or time in the payload (CTL-PSH-01); the client looks the booking up itself to render
the notification. Logout deletes this account's subscription rows.

## 9. UI data needs already covered above

Screens.md §10 items 4-7 and 10 are covered by: item 4 → §3 booking-create rule; item 5 →
§1 verify error codes; item 6 → §3 create error codes; item 7 → §4 confirm-field route;
item 10 → §4 staff calendar row.

---

## Changelog

- 2026-09-30 (B1): initial contract.
- 2026-09-30 (B1-fix, amendment 6): `src/portal/router.js`'s `ROUTES` table now supports
  `:param` path segments (literal segments always win over a `:param` at the same position),
  is assembled from the five per-part route files under `src/portal/routes/` instead of being
  appended to directly, and dispatches the Stripe webhook straight to `src/portal/stripe.js`
  (no more `stripe-webhook-stub.js`). No request/response shape above changed.
