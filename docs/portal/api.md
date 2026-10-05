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
| `POST /api/portal/auth/start` | public (Origin-checked, CSRF-exempt) | `{email}` | `200 {ok:true}`, `+{dev_link}` only under PIN-9/S-1. The link is emailed with `env.EMAIL.send` (PIN L5, portal(B3)). | `403 origin_required`, `400 invalid_request` (also for an address that could reach more than one mailbox: comma, semicolon, whitespace, angle brackets, over 254 characters), `503 email_unavailable` (no `EMAIL` binding and no demo dev login: fail closed, nothing written). Otherwise identical shape whether the email exists, is rate-limited or the send failed (PIN-8). |
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
| `GET /api/portal/me` | own | — | Signed out: `200 {user:null, authenticated:false, features:{stripe,push,gcal,passkeys,preview}}` (PF-4: never a 401). Signed in: `200 {authenticated:true, features, csrf_token, account:{id,email,role,display_name}, entitlement:{entitled,tier,overlap}, credits}` (`credits` added portal(FR1)) | — |
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
| `GET /api/portal/resources` | own | — | `[{id, kind, name, open_time, close_time, slot_minutes, buffer_minutes, member_included, member_window_days, non_member_window_days, min_advance_minutes, cancel_cutoff_minutes, active, offerings:[{id,name,duration_minutes,audience,display_price_cents}]}]`. `active` is false when no offering is active (massage until Roger gives Samy's hours, PIN L3); `close_time` is the normal close, an owner-extended day is read from availability. (The four rule fields and `active` were added portal(B3).) | — |
| `GET /api/portal/resources/:id/availability?date=YYYY-MM-DD` | own | — | `{slots:[{start,end,state}]}`, `state ∈ {available,taken,held,held_mine,mine,blocked,past,too_soon}` (screens §10 item 2; `too_soon` added portal(B3): inside the resource's minimum notice, member and guest only). The grid follows the day's real hours, so an owner-extended court day has the extra slot. No account fields for member/guest (CTL-AVL-01). Owner variant (`GET /api/portal/owner/resources/:id/availability`, B2a2) adds `display_name`, `booking_id`. | `400 bad_date` |
| `GET /api/portal/resources/:id/quote?offering_id=&start=&party_size=` | own | — | `{mode, unit_cents, party_size, total_cents, credits_needed, credits_have, cancel_cutoff_minutes}` (screens §10 item 3), `mode` from `entitlement.resolveAudience` | `409 price_not_set` |
| `POST /api/portal/bookings` | own | `{resource_id, offering_id?, start, party_size, free_kids?, payment_choice?}` | `201 {booking:{id,status,payment_mode,hold_expires_at?,checkout_url?}}`. **Must not create any row at all if a paid path is `not_configured` (S-11/F-D1) -- check Stripe configuration before inserting a hold.** | `409 slot_taken`, `409 outside_window`, `409 in_past`, `409 blocked`, `409 cap_reached`, `409 insufficient_credits`, `409 price_not_set`, `409 price_mismatch` (CTL-STR-02, added portal(FR1)), `409 too_soon {min_advance_minutes}` (PIN L3 minimum notice, Cold Plunge 1440, member and guest only), `409 not_bookable_online` (no active offering, or the offering asked for is inactive; massage until Roger gives Samy's hours; added portal(B3)), `400 off_grid` / `400 outside_hours` (D-A14/S-12, added portal(FR2-B), checked for every caller incl. staff/owner self-book), `503 not_configured {feature:"stripe"}`, `400 invalid_request` |
| `POST /api/portal/bookings/:id/cancel` | own | — | `200 {ok:true, credits_returned}` | `404` (not this account's or already cancelled), `409 past_cutoff {cancel_cutoff_minutes}` (UI string key `cancel.err_cutoff`; 1440 under PIN L3, so inside 24 h the UI says to contact the club) |
| `GET /api/portal/bookings` | own | — | `[{id,resource,start,end,status,payment_mode,party_size}]` (`party_size` added portal(FR1)), this account's own rows only | — |

Credit spend/return is one function in `booking.js` (CTL-CRD-01); it is never computed inline in
the create/cancel handlers.

**B2a1 appendix (2026-10-01):**
- `payment_choice?: "credits" | "card"` on create -- not in B1's original request shape, added
  because a non-member court booking (Amendment 4) can pay either way and the request body had
  no field to carry that choice (screens M2d's radio control). Omitted -> defaults to `credits`
  when the balance covers `party_size`, else `card`. Backward compatible: existing callers that
  never send it keep working exactly as before. No existing field changed or removed.
- The `409`/`503` error values above are the exact `error` field values returned (`slot_taken`,
  `outside_window`, etc.) -- these are JSON error codes, not UI string keys. `cancel.err_cutoff`
  in the cancel row is screens.md's **STR dictionary key** for displaying a `409 past_cutoff`
  response, not a second error code; the JSON body is `{"error":"past_cutoff"}`.
- Credits only ever apply to a **court** booking (Amendment 4: massage and plunge are always
  `pay`). `GET .../quote`'s `credits_needed` is non-zero only for a court in `pay` mode.
- A2's overlap guard and CTL-CRD-01's credit guard are both inside the ONE `INSERT ... WHERE NOT
  EXISTS (...) AND <credit balance check>` statement that creates the row -- there is no
  separate read-then-write step for either check (REQ-BOOK-07).
- **Finding for the conductor / data-custodian:** `credits_ledger` (migrations, not this part's
  file) has no dedicated idempotency `ref` column for `addCredits` (amendment 6). Implemented by
  encoding `reason = "<source>:<ref>"`, which still reads as the column's intended free-text
  category (e.g. `pack_purchase`) with the ref appended, not a shape violation, but a future
  migration adding a real `ref` column (unique per account) would make this exact and dropped
  the string-encoding. Not built here (migrations are not this part's file).
- **Finding:** `outbox.js`'s `outboxInsertStatement()` always inserts unconditionally. A
  same-batch write that must stay conditional on the preceding booking write actually
  succeeding (A2's conflict case: 0 rows inserted) needs a guarded variant, or the unconditional
  insert throws an FK violation instead of returning a quiet 409. `booking.js` writes its own
  `WHERE EXISTS (...)`-guarded insert locally (same column list/shape as `outbox.js`'s helper)
  rather than edit a file this part does not own. Recommend `outbox.js` grow a guarded variant
  B2a1 (and any future booking-state writer) can call instead.
- **Finding:** D-A11's owner booking override (`POST /api/portal/owner/bookings`, §4, B2a2) must
  still satisfy CTL-BOOK-01 ("only `booking.js` writes bookings/cells"), but amendment 6 did not
  define an export for it. B2a1 did not invent one unilaterally; the conductor or feature-
  architect should name the export B2a2 calls (or route the override's write back into
  `createBooking`'s building blocks) so there is exactly one writer, not two.

## 4. Owner & staff ops -- B2a2 (`src/portal/resources.js`, `owner.js`, `staff.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `PATCH /api/portal/me` | own | `{display_name}` | `200 {account}` | (see §2) |
| `GET /api/portal/owner/accounts` | owner | — | `[{id,email,role,display_name,is_demo,entitlement:{tier,overlap}}]` (CTL-ENV-02 refuses this on a non-demo-polluted preview DB) | |
| `GET /api/portal/owner/accounts/:id` | owner | — | account detail + grants + households + dependants + bookings | `404` |
| `POST /api/portal/owner/accounts/:id/grant` | owner | `{tier, starts_at, ends_at, note}` | `201 {grant}` (D-A05, audited, one batch with the audit row) | `400 bad_tier` |
| `POST /api/portal/owner/accounts/:id/grants/:grantId/end` | owner | — | `200 {grant}` -- ends a hand grant in place (added portal(FR1); audited `hand_grant_ended`; idempotent) | `404 not_found`, `403 not_a_hand_grant` (never ends a Stripe grant, P-2) |
| `GET /api/portal/me/household` | own | — | `{tier, is_couples, partner, kids:[{first_name,birth_year}]}`, own household only (added portal(FR1), B2f1 M6 finding) | — |
| `POST /api/portal/owner/accounts/:id/household-link` | owner | `{partner_account_id}` | `200 {household}` (D-A02) | `409 already_linked` |
| `DELETE /api/portal/owner/households/:id` | owner | — | `200 {ok:true}` (unlink) | |
| `POST /api/portal/owner/accounts/:id/dependants` | owner | `{first_name, birth_year}` | `201 {dependant}` (D-A03; first name + birth year only, CTL-DATA-04) | |
| `PATCH /api/portal/owner/accounts/:id/role` | owner | `{role}`, `role ≠ 'owner'` always enforced | `200 {account}` | `403` if `role:'owner'` attempted (CTL-ROLE-02) |
| `DELETE /api/portal/owner/accounts/:id` | owner | — | `200 {ok:true}` (added portal(FR2-B): anonymises rather than deletes the row -- see appendix) | `404` (already anonymised, same end state) |
| `GET /api/portal/owner/today?date=YYYY-MM-DD` | owner | — | every resource's bookings for that CR date, `state ∈ {confirmed,held,blocked,paid_conflict}`, `payment_intent_id`, `walk_in_name`, `block.weekly` (screens §10 item 8) | |
| `GET /api/portal/owner/resources` / `POST` / `PATCH /:id` | owner | resource fields (CTL-AUTHZ-03 explicit list) | resource row + `unconfirmed_fields` | `400` on out-of-range values (CTL-RES-01: slot 0, buffer < 0, close ≤ open → 400) |
| `GET /api/portal/owner/day-extensions` | owner | — | `[{date, close_time, set_by, updated_at}]`, today and later (Costa Rica date), soonest first | — |
| `POST /api/portal/owner/day-extensions` | owner | `{date:'YYYY-MM-DD', close_time:'HH:MM'}` | `200 {override:{date,close_time,...}, changed, late_bookings}`. PIN L3 / ruling PF-3: extends that Costa Rica day's court closing time (21:00 at most). Repeatable: the same request again returns `changed:false` and writes nothing. `late_bookings` counts live bookings that end after the day's closing time as it now stands (never moved). Audited (`day_extension_set`). | `400 bad_date`, `400 date_in_past`, `400 bad_close_time`, `400 close_too_late` (after 21:00), `400 not_an_extension` (not later than the normal close) |
| `DELETE /api/portal/owner/day-extensions/:date` | owner | — | `200 {ok:true, changed, late_bookings}`; clearing a day with no extension is `changed:false`. Audited (`day_extension_cleared`). | `400 bad_date` |
| `POST /api/portal/owner/resources/:id/confirm-field` | owner | `{field}` | `200 {ok:true}` (audited; clears that name from `unconfirmed_fields`) | |
| `GET/POST/PATCH/DELETE /api/portal/owner/resources/:id/offerings[/:offeringId]` | owner | offering fields | offering row | |
| `GET/POST/DELETE /api/portal/owner/blocks[/:id]` | owner | `{resource_id, kind, weekday|date, start_time, end_time, label}` | block row(s) | Warns, never bumps an existing booking (F-D3) |
| `POST /api/portal/owner/bookings` (owner override, D-A11) | owner | `{resource_id, start, account_id? , walk_in_name?}` | `201 {booking}`, bypasses window/entitlement/payment, **never grid or hours** (added portal(FR2-B)) | `409 slot_taken` (no bumping), `400 off_grid` / `400 outside_hours` |
| `GET /api/portal/owner/refunds-due` (added portal(FR2-B), M19/CTL-REF-01) | owner | — | `[{id,resource_id,resource_name,start_at,end_at,party_size,display_name,walk_in_name,cancelled_at,payment_intent_id,refund_url}]`, every cancelled booking with `refund_state='due'`, oldest first | — |
| `POST /api/portal/owner/bookings/:id/mark-refunded` (added portal(FR2-B)) | owner | — | `200 {ok:true}`, audited `refund_marked`; idempotent | `404 not_found` |
| `GET /api/portal/owner/health` | owner | — | `{owners:[...], email_configured, email_send_failed_24h, stripe_configured, gcal_configured, push_configured, outbox:{pending,failed}}` (CTL-OWN-01, CTL-AUTH-06, CTL-UI-06; `outbox` wired portal(FR1)) | |
| `GET /api/portal/owner/outbox` | owner | — | `{pending, failed:[...]}` (screens §10 item 9) | |
| `GET /api/portal/owner/overlaps` | owner | — | accounts with >1 valid entitlement source (P-4) | |
| `GET /api/portal/staff/calendar?date=` | staff-own | — | `[{start,end,resource,display_name,state}]`, this staff's own resource only, no email/phone/notes/payment (D-A16) | `403` if asking another resource (CTL-STF-01) |

**B2a2 appendix (2026-10-01, portal(FR2-B)):**
- **CTL-REF-01.** Cancelling a paid, confirmed booking (member before cutoff, or owner at any
  time -- both go through the one `cancelBooking` in `booking.js`) sets `bookings.refund_state =
  'due'` in the SAME statement as the cancel. `GET /api/portal/owner/today` includes a cancelled
  row whose `refund_state` is `due` (every other cancelled row stays excluded, as before) so it
  never disappears from the owner's view. The Stripe refund is still a dashboard act (PIN-11) --
  `POST .../mark-refunded` only records that the owner did it.
- **Account delete (DEL-01).** The account row is never hard-deleted once it has any
  money/audit history -- `bookings`, `entitlement_grants`, `credits_ledger`, `payments_mirror`
  and `audit_log.actor_account_id` all carry a reference to it, and D1 enforces foreign keys on
  this local harness (confirmed empirically: a plain `DELETE` against an account with any such
  row throws `SQLITE_CONSTRAINT_FOREIGNKEY`). Instead the row is anonymised in place (`email` ->
  `deleted-<id>@deleted.invalid`, `display_name` -> `''`, `stripe_customer_id` -> `NULL`,
  `deleted_at` set) and its login/personal-data rows are hard-deleted: `sessions`, `passkeys`,
  `push_subscriptions`, `dependants`, `households`. Money/audit rows keep full referential
  integrity, pointing at the now-anonymised account. The audit row for the delete itself never
  re-stores the deleted email (the previous shape's own finding).

## 5. Stripe -- B2b (`src/portal/stripe.js`, replaces `src/portal/stripe-webhook-stub.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/stripe/webhook` | public, signature-checked (never CSRF/Origin) | raw Stripe event | `200 {received:true}`; `200 {received:true, ignored:true}` for a checkout session that belongs to neither Glow nor the portal | `400 {error:"bad_signature"}`, `503` when `STRIPE_WEBHOOK_SECRET` is unset. One endpoint for Glow and the portal (pin L6, ruling E1-11): `src/worker.js` verifies once, then routes by `metadata`: `signup_id` goes to Glow; the portal's `kind`/`booking_id`/`lookup_keys`, no metadata, and every non-checkout event go to the portal; other metadata is logged and ignored, never a 400. The portal half is idempotent on `event.id` (`webhook_events`). |
| `POST /api/portal/billing/checkout` | own | `{lookup_key}` (one of the 7 membership tiers or `jp_session_pack8`, amendment 6) | `200 {url}` | `503 not_configured {feature:"stripe"}`, `400 unknown_item` |
| `POST /api/portal/billing/portal-session` | own | — | `303`-style `{url}` to a server-created Stripe Customer Portal session | `503 not_configured {feature:"stripe"}`, `409 no_billing_account` (no `stripe_customer_id` yet), `503 billing_portal_unavailable` (CTL-STR-07) |
| `GET /api/portal/billing/history` | own | — | `[{amount_cents, kind, status, created_at}]` from Stripe `charges?customer=`, only the caller's own `stripe_customer_id` (CTL-STR-03); `[]` when the account has none yet | `503 not_configured` |
| `POST /api/portal/owner/resources/:id/offerings/:offeringId/price` | owner | `{price_cents}` | `200 {offering}` -- creates a new Stripe Price on the same product with the same `lookup_key` + `transfer_lookup_key=true`, updates the mirror (amendment 4 decision 7) | `503 not_configured`, `404 not_found` (no offering or no `lookup_key` set), changes nothing when unset |

**Webhook wiring (launch):** `src/worker.js` owns the route and the signature check, and calls
`handlePortalStripeEvent` (`src/portal/router.js`), which runs the environment gate and then
`processStripeEvent` (`src/portal/stripe.js`) for events the portal owns.

## 6. Passkeys -- B2c (`src/portal/passkeys.js`, `portal/js/passkeys.js`)

Builds out §1's two placeholder route pairs with full WebAuthn ceremony detail
(`@simplewebauthn/server@14.0.3`). `GET /api/portal/passkeys` / `DELETE /api/portal/passkeys/:id`
(own) manage L6. RP ID is the request hostname (R-2) -- stated, not fixed, so a passkey made on
one preview URL will not verify on the next.

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/portal/auth/passkey/register/start` | own | — | `PublicKeyCredentialCreationOptionsJSON` (rpID = request hostname, `excludeCredentials` = this account's existing passkeys) | — |
| `POST /api/portal/auth/passkey/register/finish` | own | `{credential}` (`RegistrationResponseJSON`) | `200 {ok:true}` | `400 passkey_invalid` (no live challenge, expired, or the library rejects the attestation) |
| `POST /api/portal/auth/passkey/login/start` | public (Origin-checked, CSRF-exempt) | `{email}` | `PublicKeyCredentialRequestOptionsJSON`; same fields whether or not the email/its passkeys exist (PIN-8 shape-hiding, extended) | `403 origin_required` |
| `POST /api/portal/auth/passkey/login/finish` | public (Origin-checked, CSRF-exempt) | `{credential}` (`AuthenticationResponseJSON`), `confirm?` | same success shape as `auth/verify` (`{ok, first_login:false, csrf_token, account}` + `Set-Cookie`) | `400 passkey_invalid`, `409 confirm_account_switch {account_hint}` (same rule as magic-link verify, CTL-AUTH-02), `403 origin_required` |
| `GET /api/portal/passkeys` | own | — | `[{id, device_type, backed_up, rp_id, created_at, last_used_at}]`, this account's own rows only | — |
| `DELETE /api/portal/passkeys/:id` | own | — | `200 {ok:true}` | `404 not_found` (not this account's, or never existed -- never 403, so the response shape never confirms the id belongs to someone else, AUTH-14) |

CTL-PK-01 (controls.md §4): every `webauthn_challenges` row is single-use, 5-minute expiry, and
consumed by one `DELETE ... RETURNING` *before* `verifyRegistrationResponse`/
`verifyAuthenticationResponse` ever runs -- a replayed challenge (same request body sent twice)
finds no row the second time and gets `400 passkey_invalid`. Registration challenges are bound to
the account (`account_id`); login challenges are bound to their own unguessable random value
(and to `account_id` too, when login-start resolved a real email) rather than to a cookie, since
the caller is not authenticated yet. `expectedOrigin` is always `url.origin` and `expectedRPID`
is always `url.hostname` for the live request -- never a configured/hard-coded value (R-2).

**Finding for the conductor / B1:** a passkey login success mints a session row with the same
shape as `auth.js`'s `authVerify` (same columns, `cookieName`/`sessionCookieHeader` reused for
byte-identical cookie attributes, same TTL-by-role table), but `auth.js` has no exported
session-minting function for a second login method to call -- `authVerify` builds the session
inline. `src/portal/passkeys.js` duplicates that one `INSERT INTO sessions` and its
`SESSION_TTL_MS` table locally (commented at the duplication site) rather than edit `auth.js`,
which is not this part's file. Recommend `auth.js` export something like
`mintSession(db, request, url, account, method) -> {csrfToken, cookieHeader}` that `authVerify`
and `passkeys.js` both call, so the session write stays the one place the database doctrine
requires.

**Finding (scope, not built):** `security-posture.md` AUTH-09 (passkey registration requires a
magic-link/passkey auth within the last 10 minutes, `403 reauth_required` otherwise) and AUTH-18
(rate-limit the 31st failed passkey-login finish per IP per 15 min) are not in `risk/controls.md`
§4's one B2c control (CTL-PK-01) or this dispatch's acceptance list, so neither is built tonight
-- listed here for the conductor/security-steward to adopt or decline.

## 7. Google Calendar -- B2d (`src/portal/gcal.js`)

No new `/api/portal/*` route is required for the one-way push itself (it drains
`calendar_outbox` from cron/`waitUntil`). `GET /api/portal/owner/resources/:id` (B2a2's row,
§4) gains a `google_calendar_id` field B2d documents here once set. The one-time import tool
is a CLI script (`scripts/gcal-import.mjs`), not an API route; its dry-run/`--apply` contract is
documented in `docs/portal/gcal-import.md` (B2d's file).

## 8. PWA and push -- B2e (`src/portal/push.js`, `src/portal/cron.js`)

| Method & path | Class | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/portal/push/vapid-public-key` | own | — | `200 {public_key}` (base64url raw public key, the exact string `pushManager.subscribe()`'s `applicationServerKey` needs) | `503 not_configured {feature:"push"}` |
| `POST /api/portal/push/subscribe` | own | `{endpoint, keys:{p256dh, auth}}` | `200 {ok:true}` (upsert on `endpoint`, CTL-PSH-02) | `503 not_configured {feature:"push"}`, `400 invalid_request` |
| `POST /api/portal/push/unsubscribe` | own | `{endpoint}` | `200 {ok:true}` (idempotent; always scoped to the caller's own account) | `400 invalid_request` |

Reminders (24h/2h) send from the cron body only, payload `{booking_id, kind}` -- no name,
resource or time in the payload (CTL-PSH-01); the client looks the booking up itself to render
the notification. Logout deletes this account's subscription rows.

B2e changelog (2026-09-30): added `GET /api/portal/push/vapid-public-key` above -- not in B1's
original §8 table -- because the client cannot call `subscribe` without the server's public
key. No existing shape changed. **Finding for the conductor:** `src/portal/auth.js`'s `logout()`
(B1-owned) does not yet call `push.js`'s `deleteSubscriptionsForAccount(db, session.account_id)`;
see this part's return for the exact one-line change.

## 9. UI data needs already covered above

Screens.md §10 items 4-7 and 10 are covered by: item 4 → §3 booking-create rule; item 5 →
§1 verify error codes; item 6 → §3 create error codes; item 7 → §4 confirm-field route;
item 10 → §4 staff calendar row.

---

## Changelog

- 2026-10-04 (B3, PINs L3 L5 L7, ruling PF-3): migration `0009_launch_rules.sql` (`resources.min_advance_minutes`, table
  `day_close_overrides`); `src/portal/day-hours.js` and the three `/owner/day-extensions` routes above; booking engine
  enforces the day's real hours, the minimum notice and inactive offerings (`too_soon`, `not_bookable_online`, availability
  state `too_soon`); `GET /resources` carries the window, notice, cancel-cutoff and `active` fields; `past_cutoff` names the
  cutoff; `auth/start` sends the magic link through `env.EMAIL` and fails closed with `503 email_unavailable`, and now refuses
  an address that could reach more than one mailbox (AUTH-07). No existing field was removed or renamed.

- 2026-09-30 (B1): initial contract.
- 2026-09-30 (B1-fix, amendment 6): `src/portal/router.js`'s `ROUTES` table now supports
  `:param` path segments (literal segments always win over a `:param` at the same position),
  is assembled from the five per-part route files under `src/portal/routes/` instead of being
  appended to directly, and dispatches the Stripe webhook straight to `src/portal/stripe.js`
  (no more `stripe-webhook-stub.js`). No request/response shape above changed.
- 2026-10-01 (B2d): `gcal.js`'s `drainCalendarOutbox(env, { limit, fetchImpl })` real body
  replaces the amendment-6 stub -- same required signature (`fetchImpl` is an additional
  optional field, default the global `fetch`, added only so a test can inject a spy; every
  existing caller is unaffected). Also exports `signServiceAccountAssertion`,
  `getGoogleAccessToken`, `eventIdForBooking`, `buildEventBody` (reused by
  `scripts/gcal-import.mjs`'s dry run) and a test-only `__resetAccessTokenCacheForTests`.
  No new `/api/portal/*` route. §7's text above (no route, CLI script, doc) is unchanged.
- 2026-10-01 (B2b): §5 filled in -- `POST /api/portal/billing/checkout` (amendment 6's new
  route), real error codes for `billing/portal-session` (`409 no_billing_account`,
  `503 billing_portal_unavailable`) and `offerings/:offeringId/price` (`404 not_found`), and
  the `history` empty-array case for an account with no `stripe_customer_id` yet. No
  previously-shipped shape changed.
- 2026-10-01 (portal(FR2-B)): §3 `POST /api/portal/bookings` and §4's owner override gain
  `400 off_grid`/`400 outside_hours` (M10, D-A14/S-12, no owner/staff exemption). §4 adds
  `GET /api/portal/owner/refunds-due` and `POST .../bookings/:id/mark-refunded` (M19,
  CTL-REF-01) and documents account delete as anonymise-in-place, never a hard delete (M21,
  migration `0008_refund_due_and_delete.sql` adds `bookings.refund_state` and
  `accounts.deleted_at`). No previously-shipped shape changed.
- 2026-10-01 (B2a1): §3 appendix added -- `payment_choice?` on create (new optional field,
  nothing removed/changed), a clarification that the cancel row's `cancel.err_cutoff` is a UI
  string key, not a second JSON error code, and two findings (an `addCredits` idempotency `ref`
  column and a guarded-outbox-insert variant, both migrations/outbox.js changes outside this
  part's files) plus the still-undefined owner-override export CTL-BOOK-01 needs from B2a2's
  side. No previously-shipped §3 shape changed.
- 2026-10-01 (B2c): §6 filled in with the full request/response table for both placeholder route
  pairs plus `GET/DELETE /api/portal/passkeys[/:id]`, and CTL-PK-01's challenge-consumption rule.
  No shape B1 placeholder-sketched in §1 changed. Two findings recorded: `auth.js` has no
  exported session-minting function, so the passkey-login session insert is duplicated rather
  than shared; and `security-posture.md` AUTH-09/AUTH-18 are out of tonight's scope (not in
  controls.md §4).
- 2026-10-01 (B2f1, UI-only part, no route shapes changed, findings only): building M1/M8
  (screens.md) against §2's `GET /api/portal/me` found it has no `credits` field though
  screens.md §0.2's boot sequence and M1's credits line both need one -- the UI defaults to 0
  until it's added. Building M3 against §3's `GET /api/portal/bookings` response
  (`[{id,resource,start,end,status,payment_mode}]`) found no `party_size`, needed by M1's
  "{players} players" line and M2d's per-player cost line on an existing booking -- the UI
  omits that line rather than show it undefined. M6 (household, read-only) has no `GET`
  endpoint in this contract at all -- §4 only exposes household data through the *owner's*
  `GET /api/portal/owner/accounts/:id`; a member reading their own household needs an "own"
  route (e.g. `GET /api/portal/household`) that does not yet exist, so M6 cannot be verified
  against real data tonight. None of these are shape changes to anything already shipped.
- 2026-10-01 (B2a2): §4 filled in -- `src/portal/resources.js`, `owner.js`, `staff.js` and
  `routes/owner.js` implement every row. Additive detail only, nothing already-shipped changed:
  `POST /api/portal/owner/bookings` gains an optional `party_size?` (1-4, default 1; screens.md
  O9's players stepper, not in B1's original request shape); `PATCH .../resources/:id` response
  gains `misfits` (REQ-OWN-11, `[]` when the edit touched no hours/slot/buffer field);
  `POST/GET .../blocks` response gains `conflicts` (overlapping bookings the block never
  cancels, F-D3); `GET .../resources/:id/offerings/:offeringId` added (singular GET, matching
  the bracket notation already in the row's path); extra named errors used by this part's own
  handlers: `no_fields`, `bad_*` (per-field, CTL-RES-01/CTL-AUTHZ-03), `resource_forbidden`
  (CTL-STF-01, a `resource_id` param on the staff calendar), `cannot_delete_owner`/
  `cannot_change_owner` (role/delete guard a defensive addition, owner rows are never
  touched by these routes).
  **Findings (not built, reported per B2-COMMON):**
  (1) `GET /api/portal/owner/health` is documented (§2, §4) to carry `outbox`, but the route is
  registered in B1's `router.js` and its handler (`ownerHealth`) lives in B1's `auth.js` --
  neither is this part's file. The exact one-line fix: in `auth.js`'s `ownerHealth`, import
  `outboxSummary` from `./outbox.js` and add `outbox: await outboxSummary(db)` to the response.
  Until then, `GET /api/portal/owner/outbox` (this part, fully built) is the only place that
  data is available over HTTP.
  (2) CTL-BOOK-01 ("only booking.js writes bookings") is, in the strict sense, still violated:
  `owner.js`'s `ownerOverrideBooking` writes `bookings` directly (B2a1's `booking.js` exported
  no shared insert function at the time this was written; amendment 6 did not assign this
  interface to either part). Its occupancy predicate was checked against B2a1's real
  `createBooking` (committed independently, in parallel) and matched exactly after the fact.
  Recommended follow-up: B2a1 exports a shared `insertBookingIfFree(db, {...})` both writers
  call, so there is truly one writer.

  **Both findings above are resolved as of 2026-10-01 (portal(FR1)) -- see that changelog entry.**

- 2026-10-01 (portal(FR1), integration fix round -- task-conductor jp-portal-2026-09-30):
  Closes several findings left open by the parallel build. No previously-shipped request/response
  field was removed or renamed; every change below is additive or fixes a wiring gap between two
  already-documented shapes.
  - **§1/§6 finding resolved:** `src/portal/auth.js` now exports `mintSession(db, request, url,
    account, method)`. `authVerify` and `src/portal/passkeys.js`'s login-finish both call it; the
    passkey file's own duplicate `INSERT INTO sessions` is deleted. Cookie attributes, TTL table
    and column shape are unchanged -- this is a refactor of where the one insert lives, not a new
    shape.
  - **§3/§4 CTL-BOOK-01 finding resolved:** `src/portal/booking.js` exports
    `insertBookingAtomic(db, {...})`, the one place the overlap-guarded `bookings` INSERT is
    built. `createBooking` (this file) and `owner.js`'s `ownerOverrideBooking` both call it now;
    neither keeps its own copy of the SQL. Behaviour unchanged (same guard, same columns).
  - **§2 `GET /api/portal/me` gains `credits`** (integer, the account's current balance; the
    B2f1 finding above). `0` when the account has no `credits` row yet.
  - **§3 `GET /api/portal/bookings` gains `party_size`** on every row (the B2f1 finding above).
  - **§4 `GET /api/portal/owner/health` gains `outbox:{pending, failed}`** (same shape
    `GET /api/portal/owner/outbox` already returns; `auth.js`'s `ownerHealth` now imports
    `outboxSummary` from `./outbox.js` instead of leaving the field undocumented-but-missing).
  - **New: `GET /api/portal/me/household`** (own) -- `{tier, is_couples, partner, kids:
    [{first_name, birth_year}]}`, this account's own household only (the B2f1 M6 finding --
    `portal/js/member.js`'s `memberHousehold()` already called a `/api/portal/household` path
    expecting this shape; repointed at the real path rather than left half-built).
  - **New: `POST /api/portal/owner/accounts/:id/grants/:grantId/end`** (owner) -- ends a
    **hand** grant in place (`status:'ended', ends_at:now`), audited (`hand_grant_ended`). Named
    error `403 not_a_hand_grant` if `grantId` is a Stripe-sourced grant (P-2: a Stripe
    subscription is never ended by hand here) and `404 not_found` if `grantId` is not this
    account's. Idempotent: ending an already-ended grant changes nothing, returns it unchanged.
    `portal/js/owner.js`'s `endGrant()` (previously a named gap, `"end_grant_not_available"`)
    now calls this route.
  - **CTL-STR-02 wiring fix (not a shape change):** `booking.js`'s `createBooking` now passes
    `expected_unit_cents` (the offering's display mirror) on the Checkout lineItem it builds for
    `stripe.js`'s `createBookingCheckout`, which already implemented the mismatch check but was
    never actually handed a value to check against. A mismatch now returns `409 price_mismatch`
    (added to §3's create error list) and releases the hold, instead of falling through to the
    generic `500`.
  - **CTL-CAL-01 finding partially resolved:** `migrations/0007_import_idempotency.sql` adds
    `bookings.source_event_id` (partial UNIQUE) and `credits_ledger.ref` (partial UNIQUE,
    cheap-to-add bonus). `scripts/gcal-import.mjs --apply` still refuses -- the import-write
    function itself (CTL-CAL-02) is not wired this round -- but the column it needs now exists.
  - **Test harness:** `scripts/test.sh` now honours `JP_TEST_PORT`, `JP_TEST_STATE` and
    `JP_TEST_INSPECTOR_PORT` (all optional, same defaults as before) so two runs never collide,
    and every `node --test` invocation carries `--test-timeout=60000`.
