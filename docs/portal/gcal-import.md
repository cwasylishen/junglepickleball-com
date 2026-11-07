# Google Calendar import (B2d, PIN-13, REQ-CAL-09/10/11)

This is the design for the one-time import of Roger's existing court bookings out of
Google Calendar and into the portal's `bookings` table. **It is not run tonight.** The
script (`scripts/gcal-import.mjs`) ships dry-run-by-default and `--apply`-gated, per
PIN-13 and controls.md §3.7 (CTL-CAL-01..04).

## Sharing the calendars with the service account

For each of Roger's court calendars (and any other resource calendar to be imported),
in Google Calendar: **Settings → that calendar → Share with specific people → Add
people**, enter the service account's `client_email` (from
`GOOGLE_SERVICE_ACCOUNT_JSON`), and set its permission to **"Make changes and see
event details"** -- this is the API role `writer`. Do **not** use "See event details"
(`reader`): that role can list events for the dry run but cannot insert, update or
delete, so the ongoing push (`src/portal/gcal.js`) would fail on every write. "Make
changes and manage sharing" (`owner`) is more than the service account needs.

Sharing a calendar with a service account does **not** add it to that account's own
CalendarList, so this import (and the ongoing push) always addresses a calendar by its
**ID**, taken from each calendar's own Settings → "Integrate calendar" → Calendar ID,
never `primary`. Put that ID in the resource's `google_calendar_id` column before
running anything against it.

If Roger's calendars live inside a Google Workspace domain, the domain admin's sharing
settings can cap what an external (`*.gserviceaccount.com`) address is allowed to see.
That is a question for Roger, not a code control (research.md Q5).

## Source and mapping rules

- **Source:** one Google Calendar per court resource, addressed by `google_calendar_id`
  (`resources` table). `scripts/gcal-import.mjs --target=<db>` reads every resource that
  has one set and fetches each calendar's events (`events.list`, `singleEvents=true`).
- **Field mapping**, one Google event -> one candidate booking:
  - `resource_id` <- the resource whose calendar the event came from.
  - `start_at` / `end_at` <- the event's `start.dateTime` / `end.dateTime`, **UTC**
    (PIN-6). An event with no `dateTime` (an all-day event, which Google reports as
    `start.date` instead) or a `dateTime` with no explicit offset goes to
    **`needs_review`** instead of being imported (CTL-CAL-03) -- CourtReserve exports
    seen so far are not guaranteed to carry an offset, and a 6-hour silent shift is
    exactly the failure this control exists to stop.
  - No member identity is inferred from the event's title or description. CourtReserve
    member names are free text, not a reliable join key to a portal account; an
    imported booking is created the same way an owner override is (D-A11): owned by a
    walk-in name, with no account attached, until Roger reconciles it by hand.
  - The dry run prints every event's start/end **in UTC and in America/Costa_Rica side
    by side** (that zone has no DST, fixed UTC-6), so a reviewer never has to do the
    arithmetic in their head to catch an offset bug (CTL-CAL-03).

## De-duplication and conflict handling

- A booking already on the target for the same `(resource_id, start_at, end_at)` and
  not cancelled is reported as `already_imported_or_conflict` and is **not**
  re-imported -- this also covers a second run of the import itself.
- **Known gap, reported and not built (outside B2d's files):** CTL-CAL-01 names the
  import's idempotency key as a UNIQUE `source_event_id` column on the imported row, so
  a second apply with the *same* Google event inserts nothing even if the time changed
  in between. No such column exists on `bookings` today -- `migrations/` is owned by
  B1/data-custodian, not B2d. Tonight's dry run de-duplicates on time instead, which is
  weaker: if a CourtReserve booking's time is edited between an apply and a later
  re-apply, the old time's row and the new time's row would both look "new". **Before
  `--apply` is ever run for real, add a migration**: `ALTER TABLE bookings ADD COLUMN
  source_event_id TEXT; CREATE UNIQUE INDEX idx_bookings_source_event_id ON
  bookings(source_event_id) WHERE source_event_id IS NOT NULL;` and have the import
  write that column.
- A slot the engine would refuse for any other reason (already booked by a different
  resource rule, outside hours, etc.) is reported as a conflict and is not imported --
  CTL-CAL-02 means this is enforced by `booking.js` itself, not re-implemented here.

## Idempotency (CTL-CAL-01)

`--apply` always requires both `--target=<database name>` and
`--diff-sha256=<hash>`. The hash is the sha256 of the dry run's own plan (every row:
resource, source event id, start/end, outcome), printed at the end of a dry run. Apply
**recomputes that same plan right now** and refuses unless the fresh hash matches the
one given -- so an apply only ever runs exactly the plan someone reviewed, and if
anything changed underneath it (a member rebooked between review and apply -- GEN-30),
the apply refuses rather than silently importing something nobody reviewed. That is
safe; the fix is to re-run the dry run and review again.

## Rollback

An imported booking is a normal row with no Google-specific marker beyond the
`source_event_id` column above (once it exists) -- rolling one back is cancelling it
the same way any other booking is cancelled (through `booking.js`, which writes its own
`calendar_outbox` row, PIN-13). There is no bulk "undo the whole import" button by
design: Roger reviews the dry-run plan line by line before approving an apply, so a
wholesale rollback should never be needed. If one import run turns out to be wrong
end-to-end, every row it created shares the apply's timestamp window and can be found
and cancelled with a single `SELECT ... WHERE created_at BETWEEN ... AND ...`, reviewed
by hand before any of them are cancelled.

## Who runs it at cutover

This script is not run tonight. At cutover (CTL-GO-06's written plan), **Roger or
Clinton, not an agent,** runs it, in this order:

1. Share every court calendar with the service account (above), confirm each
   resource's `google_calendar_id` is set.
2. Add the `source_event_id` migration (the "Known gap" above) before relying on
   idempotency for a real apply.
3. Wire `booking.js`'s import-write export that `--apply` currently refuses to call
   (CTL-CAL-02 -- see the per-part return for the exact gap).
4. Run a dry run against the **production** database (never `--remote` against
   anything still marked `preview` -- CTL-CAL-04 refuses that automatically) and read
   every line of the plan.
5. Run `--apply --diff-sha256=<that plan's hash>` once, immediately after reviewing it.
6. Follow CTL-GO-06: CourtReserve goes read-only and legacy `/admin` booking stops at
   the same instant T the apply runs, so no booking is ever double-counted.
