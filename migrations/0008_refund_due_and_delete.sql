-- portal(FR2-B). Two additive columns, no new tables:
--
-- M19/CTL-REF-01: `bookings.refund_state` tracks a paid confirmed
-- booking's refund once cancelled -- 'none' (default, nothing owed),
-- 'due' (owner or member cancelled a paid booking; the Stripe refund
-- itself is still a dashboard act, PIN-11), 'refunded' (owner marked it
-- done). Application code (src/portal/booking.js, owner.js) is the only
-- writer and enforces the three values -- no CHECK added here so this
-- stays a plain ADD COLUMN against the existing table (SQLite's ALTER
-- TABLE ADD COLUMN support for CHECK constraints is version-sensitive;
-- the application guard is the same pattern already used for every
-- other state column in this schema, e.g. `status`'s transitions).
ALTER TABLE bookings ADD COLUMN refund_state TEXT NOT NULL DEFAULT 'none';

-- M21: a real account's row is kept (bookings/payments/audit rows keep
-- their FK to it -- D1 enforces foreign keys on this local harness,
-- confirmed empirically while building this fix) but anonymised:
-- `deleted_at` marks that it happened, idempotently (a second delete
-- call is a no-op once this is set).
ALTER TABLE accounts ADD COLUMN deleted_at TEXT;
