# Build 1 result

Branch and commit: `rules-1030`, `b631d0956a66b2b7d7901867d57296003488d22d`.

The branch was created in `/home/mike/projects/jp-wt/rules-1030` from `gcal-busy` at `8b1c3ee`. `git fetch origin` completed first. No `origin/gcal-busy` ref exists after the fetch, so a behind or ahead count could not be computed. The local `gcal-busy` branch remains at `8b1c3ee`.

Tests: `npm test` started the full existing test command, applied all ten local migrations, and loaded the local D1 fixture. The Wrangler development server did not answer on `127.0.0.1:8799`, so the suite stopped before its HTTP tests could run. JavaScript syntax checks passed for the changed portal modules, and `git diff --check` passed. The requested new unit tests and a passing full suite are therefore not complete.

Implemented in the branch: member and non-member court windows of 60 and 30 days, 2,880 minute cancellation cutoff, A through D placeholder court seeds flagged as unconfirmed, the draft booking policy and acknowledgement checkbox, policy enforcement on booking creation, the existing ledger reused for cancellation credits, member credit visibility in owner account detail, and an audited owner credit adjustment route.

Preview URL and version ID: none. No preview deployment was made because the checked-in Worker configuration points `PORTAL_DB` at the production D1 and no safe preview binding was configured for this worktree. Production `junglepickleball.com` was not deployed.

Screenshots: none. The local Wrangler server did not answer, so the requested 390 pixel booking confirmation screenshot and member account credit screenshot could not be captured.

Production binding inventory read from `wrangler.toml`: `ASSETS` serves `./`; KV binding `EVENTS` uses namespace `0c6dbe2eca394cc8a4ddf98147dc0332`; D1 binding `ANALYTICS` uses database `wizardweb`, ID `69028e1f-c781-4501-b0a8-5404801366f4`; service binding `WARD_MAIL` targets `ward-mail`; D1 binding `PORTAL_DB` uses database `junglepickleball-portal`, ID `d7daeb61-9843-4fa5-86a2-a3134e777ea7`; email binding `EMAIL` is declared; custom domains are `junglepickleball.com` and `www.junglepickleball.com`; the configured cron is every 15 minutes. The legacy `DB` binding is commented out. Secrets and variables are declared by name only and were not exposed.

Open questions for Roger: confirm hours for courts A through D, confirm the 90 minute slot length and zero buffer default, confirm the non-member price represented by the existing `$15.00` offering, confirm member pricing or included membership treatment, confirm whether credits are displayed and spent in cents as implemented by the paid amount ledger extension, and review the policy marked `DRAFT FOR ROGER`.

Production confirmation: no production Worker version was uploaded, no production custom domain was changed, and no production D1 migration or seed was applied. The new migration was only applied by the local test harness before it became part of the branch.
