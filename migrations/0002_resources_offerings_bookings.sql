-- Resources (courts, massage, plunge), their offerings, recurring/one-off
-- blocks, and bookings. PIN-3 (brief), PIN-15, Amendment 4, D-A01/A13/A14/A21.

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('court', 'massage', 'plunge')),
  name TEXT NOT NULL,
  staff_account_id TEXT REFERENCES accounts(id), -- staff-owned calendar (massage)
  open_time TEXT NOT NULL, -- HH:MM, Costa Rica local
  close_time TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL CHECK (slot_minutes > 0 AND slot_minutes <= 1440),
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  member_window_days INTEGER NOT NULL DEFAULT 7 CHECK (member_window_days >= 0 AND member_window_days <= 365),
  non_member_window_days INTEGER NOT NULL DEFAULT 2 CHECK (non_member_window_days >= 0 AND non_member_window_days <= 365),
  cancel_cutoff_minutes INTEGER NOT NULL DEFAULT 120 CHECK (cancel_cutoff_minutes >= 0),
  max_active_per_account INTEGER, -- NULL = no limit (D-A21); S-9 seeds 2 for courts, 1 for massage/plunge
  member_included INTEGER NOT NULL DEFAULT 0, -- D-A04: true for courts and plunge-annual handled via offerings
  price_mode TEXT NOT NULL DEFAULT 'per_player' CHECK (price_mode IN ('per_player', 'per_booking')),
  google_calendar_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  unconfirmed_fields TEXT NOT NULL DEFAULT '[]', -- JSON array of field names flagged "default, confirm" (PIN-15/screens item 7)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A resource may offer more than one bookable duration/price variant
-- (massage 60/90; non-member court session; plunge audience prices).
-- audience distinguishes who the row prices, for the plunge's three-tier
-- rule (Amendment 4): 'everyone' | 'member_annual' | 'member_other' | 'guest'.
-- lookup_key is the Stripe Price lookup_key (never price_data, Amendment 4);
-- NULL lookup_key + price_cents = 0 means "included, no checkout"
-- (annual plunge). NULL lookup_key + NULL price_cents means "price not
-- set" (CTL-ENT-02 not_bookable).
CREATE TABLE offerings (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  audience TEXT NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'member_annual', 'member_other', 'guest')),
  lookup_key TEXT, -- e.g. massage_60, massage_90, plunge_member, plunge_guest, jp_session_single
  display_price_cents INTEGER, -- mirror only; the Stripe Price is the truth for the amount charged
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_offerings_resource ON offerings(resource_id);

-- Owner blocks (one-off or weekly-recurring) that remove availability.
-- D-A15. Never bumps an existing booking (D-A11/F-D3): enforcement lives
-- in booking.js (B2a1); this is the schema only.
CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  kind TEXT NOT NULL CHECK (kind IN ('one_off', 'weekly')),
  weekday INTEGER CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6)), -- weekly only, 0=Sunday CR local
  date TEXT, -- one_off only, YYYY-MM-DD CR local
  start_time TEXT NOT NULL, -- HH:MM CR local
  end_time TEXT NOT NULL,
  label TEXT,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_blocks_resource ON blocks(resource_id);

-- CTL-DATA-02: account_id is NOT NULL. A walk-in owner booking (D-A11) is
-- owned by the booking owner's own account with walk_in_name set; there
-- is no ownerless row.
-- CTL-DATA-04: no column references a dependant or a child's name --
-- free_kids is a count only.
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  offering_id TEXT REFERENCES offerings(id),
  start_at TEXT NOT NULL, -- UTC ISO-8601 (PIN-6)
  end_at TEXT NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size >= 1 AND party_size <= 4),
  free_kids INTEGER NOT NULL DEFAULT 0 CHECK (free_kids >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'paid_conflict')),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('included', 'credits', 'pay', 'override')),
  hold_expires_at TEXT, -- D-A06/F-4: Checkout expires_at + 2 min
  credits_spent INTEGER NOT NULL DEFAULT 0,
  checkout_session_id TEXT,
  payment_intent_id TEXT,
  walk_in_name TEXT, -- set only for an owner walk-in booking (D-A11); account_id is still the owner's
  block_weekly_id TEXT, -- set when the row represents a materialised weekly block instance, else NULL
  created_by TEXT NOT NULL REFERENCES accounts(id), -- the acting account (owner override vs self-book)
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES accounts(id),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bookings_account ON bookings(account_id);
CREATE INDEX idx_bookings_resource_time ON bookings(resource_id, start_at, end_at);
CREATE INDEX idx_bookings_hold_expiry ON bookings(hold_expires_at);
