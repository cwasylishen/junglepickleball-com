-- Portal foundation: environment marker, accounts, magic-link tokens,
-- sessions, passkeys, WebAuthn challenges, login rate limiting.
-- PIN-5, PIN-7, PIN-8, S-1..S-6, CTL-ENV-01, CTL-DATA-01/03, CTL-PK-01.

-- One row only (CTL-ENV-01 d). Written by scripts/seed-preview.sql as its
-- FIRST statement -- never by a migration -- so an existing production
-- marker makes the seed fail before anything else is written.
CREATE TABLE portal_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  env TEXT NOT NULL CHECK (env IN ('preview', 'production')),
  created_at TEXT NOT NULL
);

-- Rolling counters with no PII (CTL-AUTH-06). key is e.g.
-- 'email_send_failed:2026-09-30T12' (one bucket per UTC hour).
CREATE TABLE portal_meta_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, -- crypto.randomUUID() (CTL-DATA-01)
  email TEXT NOT NULL CHECK (length(trim(email)) >= 3 AND instr(email, '@') > 1),
  role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner', 'staff', 'member', 'guest')),
  display_name TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  age_attested_at TEXT, -- CTL-AUTH-05
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_accounts_email ON accounts(email);

-- Magic-link tokens. Only the SHA-256 of the 32-byte token is stored
-- (PIN-8). Single use (consumed_at), 15-minute expiry.
CREATE TABLE login_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ip TEXT
);
CREATE INDEX idx_login_tokens_hash ON login_tokens(token_hash);
CREATE INDEX idx_login_tokens_expiry ON login_tokens(expires_at);

-- Server-side session rows, keyed by the SHA-256 of the cookie value
-- (never the raw cookie). csrf_token is served by GET /api/portal/me.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, -- sha256(cookie value) hex
  account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf_token TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'link' CHECK (method IN ('link', 'passkey')),
  user_agent_family TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  rp_id TEXT NOT NULL, -- R-2: tied to the hostname it was created on
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX idx_passkeys_credential ON passkeys(credential_id);

-- WebAuthn registration/auth challenges: single-use, 5-minute expiry
-- (CTL-PK-01).
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- Login-start rate limiting, in D1, no new KV (PIN-8). One row per
-- (window key). window_start is the floor of the 15-minute rolling
-- window's start.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY, -- e.g. 'email:a@b.com' or 'ip:1.2.3.4'
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
