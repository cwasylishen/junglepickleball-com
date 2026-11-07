-- portal(FR1): idempotency columns named by two findings left open from
-- the parallel build (docs/portal/api.md's B2a1 appendix; CTL-CAL-01,
-- controls.md §3.7). Adds the columns only -- no writer is wired to use
-- them yet (scripts/gcal-import.mjs's --apply still refuses; the
-- row-level write is a separate fix, not built tonight).

-- CTL-CAL-01: the Google Calendar import's idempotency key. A partial
-- UNIQUE index (not a column-level UNIQUE) because every existing and
-- future non-imported booking leaves this NULL, and SQLite's UNIQUE
-- treats NULL as distinct from NULL (any number of NULLs are allowed),
-- so this never blocks a normal booking insert -- it only ever
-- constrains rows that actually set it.
ALTER TABLE bookings ADD COLUMN source_event_id TEXT;
CREATE UNIQUE INDEX idx_bookings_source_event_id ON bookings(source_event_id) WHERE source_event_id IS NOT NULL;

-- `addCredits`'s (src/portal/booking.js) idempotency key, named in
-- api.md's B2a1 appendix finding: until now it was encoded into
-- `reason` as "<source>:<ref>" because no dedicated column existed. A
-- real column is cheap to add (one more TEXT, same partial-UNIQUE
-- pattern as above) -- the encoding in `reason` is left as-is for this
-- fix round (switching `addCredits` to write this column instead is a
-- separate change to a file already covered by other FR1 items, flagged
-- here rather than bundled in).
ALTER TABLE credits_ledger ADD COLUMN ref TEXT;
CREATE UNIQUE INDEX idx_credits_ledger_ref ON credits_ledger(account_id, ref) WHERE ref IS NOT NULL;
