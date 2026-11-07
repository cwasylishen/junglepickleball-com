-- Calendar outbox (PIN-13, same-batch write with every booking change),
-- push subscriptions and reminder dedupe (PIN-14).

CREATE TABLE calendar_outbox (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'cancel', 'move')),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  payload TEXT NOT NULL, -- JSON: title per D-A17, start/end, no personal data, never attendees
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_status ON calendar_outbox(status);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- CTL-PSH-02: one endpoint rebinds to whichever account registered it last;
-- logout deletes it.
CREATE UNIQUE INDEX idx_push_endpoint ON push_subscriptions(endpoint);

-- Dedupe per (booking, kind) so a 24h and a 2h reminder each send once
-- (PIN-14, CTL-PSH-02 rider).
CREATE TABLE reminder_sends (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('24h', '2h')),
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_reminder_sends_unique ON reminder_sends(booking_id, kind);
