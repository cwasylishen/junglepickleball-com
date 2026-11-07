-- Payments mirror (brief decision 2) and the webhook idempotency table
-- (PIN-11: "the webhook is idempotent on event.id").

CREATE TABLE payments_mirror (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  booking_id TEXT REFERENCES bookings(id),
  stripe_payment_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'refunded', 'failed')),
  kind TEXT NOT NULL CHECK (kind IN ('membership', 'pack', 'booking')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_mirror_account ON payments_mirror(account_id);

-- Every processed Stripe event, keyed by Stripe's own event id, so a
-- redelivered webhook is a no-op (PIN-11).
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY, -- Stripe event.id
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'error'))
);
