-- Club rules the engine did not have (PIN L3, ruling PF-3, 2026-10-01).
-- Both rules are enforced server-side in src/portal/booking.js and
-- src/portal/day-hours.js; this file is only their schema.

-- Cold Plunge may only be booked at least 24 h ahead (PIN L3). Minutes,
-- per resource. 0 = no minimum (every other resource). Applies to
-- members and guests; the owner is exempt, as the owner is exempt from
-- the booking window (D-A11).
ALTER TABLE resources ADD COLUMN min_advance_minutes INTEGER NOT NULL DEFAULT 0;

-- The owner can extend one specific Costa Rica day past the normal close
-- (PIN L3: "to 21:00, an admin action, never the default"). One row per
-- date, owner-set, applies to the court resources. The 21:00 ceiling is
-- also the table's own CHECK, so no code path can store a later close.
CREATE TABLE day_close_overrides (
  date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- CR local day, YYYY-MM-DD
  close_time TEXT NOT NULL CHECK (close_time GLOB '[0-2][0-9]:[0-5][0-9]' AND close_time <= '21:00'),
  set_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
