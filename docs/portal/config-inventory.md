# Portal configuration inventory (CTL-CFG-01)

Every `env.*` name any file under `src/portal/` reads. `tests/foundation/config-inventory.test.mjs`
fails if a name appears in the code but not here, or here but not in the code (checked both ways,
by grepping `src/portal/*.js` the same way this table was built).

| Name | Kind | Set where | On preview? | Purpose |
|---|---|---|---|---|
| `PORTAL_DB` | binding | `wrangler.toml` | yes | The portal's D1 database (PIN-5). |
| `ASSETS` | binding | `wrangler.toml` `[assets]` | yes | Serves `portal/index.html` for the static-asset fallback path. |
| `OWNER_EMAILS` | secret | Worker secret, production go only | **no** (S-2, AUTH-24) | Comma-separated owner allowlist (PIN-1/PIN-7). Never a `wrangler.toml` var. |
| `PORTAL_DEV_LOGIN` | CLI flag | `--var PORTAL_DEV_LOGIN:1` at `wrangler dev`/preview upload time | yes, preview only | Gates the demo `dev_link` (PIN-9). Never added to `wrangler.toml` (amendment 5). |
| `VAPID_PUBLIC_KEY` | secret | Worker secret | yes (preview keys; regenerated at go, S-14) | Web Push (PIN-14). |
| `VAPID_PRIVATE_KEY` | secret | Worker secret | **no** (stripped from the filtered env on preview, CTL-ENV-01 f) | Web Push signing key. |
| `VAPID_SUBJECT` | var | `wrangler.toml` or secret | yes | `mailto:` contact for push (PIN-14). |
| `STRIPE_SECRET_KEY` | secret | Worker secret | test key only (live key treated as absent on preview, CTL-ENV-01 c) | Stripe API calls (PIN-11). |
| `STRIPE_WEBHOOK_SECRET` | secret | Worker secret (`whsec_local_test_only` literal in `scripts/test.sh` only, S-13) | test only | Webhook signature verification (PIN-11). |
| `EMAIL` | binding/secret | Worker (not yet provisioned) | **no** (stripped on preview, CTL-ENV-01 f) | Sends the magic-link mail in production. Absent in preview by design -- PIN-3/PIN-9 cover the preview substitute. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | Worker secret (not yet provisioned) | **no** (stripped on preview, CTL-ENV-01 f) | Google Calendar push (PIN-13). Inert until set. |

No other `env.*` name is read anywhere under `src/portal/`.
