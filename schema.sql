-- Jungle Pickleball back end (D1: junglepickleball-db)
-- Reference copy. The Worker also runs these idempotently via ensureSchema()
-- on first admin/booking request, so the database self-provisions its tables.

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  plan TEXT NOT NULL DEFAULT 'monthly',          -- monthly | drop-in | custom
  status TEXT NOT NULL DEFAULT 'active',         -- active | past_due | canceled
  pay_method TEXT NOT NULL DEFAULT 'cash',       -- cash | stripe
  stripe_customer_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                            -- YYYY-MM-DD
  start TEXT NOT NULL,                           -- HH:MM (24h)
  end TEXT NOT NULL,                             -- HH:MM (24h)
  court INTEGER NOT NULL,                        -- 1..4
  name TEXT NOT NULL,                            -- display name (member or walk-in)
  member_id INTEGER,
  source TEXT NOT NULL DEFAULT 'admin',          -- admin | cash | whatsapp | member | block
  status TEXT NOT NULL DEFAULT 'confirmed',      -- confirmed | canceled
  notes TEXT,
  gcal_event_id TEXT,                            -- Phase 3: Google Calendar mirror
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, court, status);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  method TEXT NOT NULL DEFAULT 'cash',           -- cash | stripe
  stripe_ref TEXT,                               -- invoice/charge id (Phase 2)
  note TEXT,
  paid_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(member_id, paid_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Booking rules live under key 'booking_rules' as JSON. Defaults seeded by the
-- Worker; Roger's real guidelines replace them via the admin later.
