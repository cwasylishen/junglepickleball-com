-- Entitlement grants (one row per writer, CTL-ENT-01/§2), households,
-- dependants (named kids, D-A03) and the credits ledger (D-A01, P-6).

-- "No writer overwrites another writer's value" (CTL-ENT-01). One row
-- per grant; src/portal/entitlement.js is the only reader that resolves
-- effective entitlement, at read time, from these rows (P-1..P-7).
CREATE TABLE entitlement_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('stripe', 'hand', 'household', 'email_link')),
  tier TEXT NOT NULL, -- lookup_key family, e.g. jp_annual_single, jp_1m_single
  stripe_subscription_id TEXT,
  stripe_status TEXT, -- active | trialing | past_due | unpaid | canceled | incomplete_expired (D-A09)
  starts_at TEXT NOT NULL,
  ends_at TEXT, -- NULL = open-ended (stripe active); set on cancel/end
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  linked_by_email INTEGER NOT NULL DEFAULT 0, -- S-10: flagged for owner confirmation
  created_by TEXT REFERENCES accounts(id), -- NULL for stripe/webhook-written rows
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_grants_account ON entitlement_grants(account_id);
CREATE INDEX idx_grants_source ON entitlement_grants(account_id, source);

-- A couples household: the payer's account and one linked partner.
-- needs_review flags a single<->couples tier switch (CTL-STR-09).
CREATE TABLE households (
  id TEXT PRIMARY KEY,
  payer_account_id TEXT NOT NULL REFERENCES accounts(id),
  partner_account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review', 'unlinked')),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_households_payer ON households(payer_account_id);
CREATE INDEX idx_households_partner ON households(partner_account_id);

-- Named kids (first name + birth year only -- D-A03/F-2), attached to the
-- paying adult's account. No login. CTL-AUTHZ-02 restricts who may read
-- this table; CTL-DATA-04 keeps it off bookings entirely.
CREATE TABLE dependants (
  id TEXT PRIMARY KEY,
  household_account_id TEXT NOT NULL REFERENCES accounts(id), -- the paying adult
  first_name TEXT NOT NULL,
  birth_year INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_dependants_household ON dependants(household_account_id);

-- Credits are a balance, never entitlement (P-6). credits is the current
-- balance cache; credits_ledger is the append-only record it is derived
-- from. Both are written only inside the one credit-spending/returning
-- function (database doctrine), in the same batch, so they never drift.
CREATE TABLE credits (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE credits_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  delta INTEGER NOT NULL, -- positive = granted/returned, negative = spent
  reason TEXT NOT NULL, -- e.g. 'pack_purchase', 'booking_spend', 'cancel_return'
  booking_id TEXT REFERENCES bookings(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_credits_ledger_account ON credits_ledger(account_id, created_at);
