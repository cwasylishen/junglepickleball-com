-- PRODUCTION seed for the Jungle Pickleball portal. PIN L7 (Roger/Clinton
-- 2026-10-01): "zero demo accounts, bookings or credits. Seed holds only
-- the L3 resources and rules, the Amendment-4 prices, and the production
-- marker row."
--
-- Apply once, to the production D1 only, after the migrations:
--   wrangler d1 execute PORTAL_DB --remote --file=scripts/seed-prod.sql
-- (the deployer runs it; never from a build lane). It is safe to run
-- again: every insert is INSERT OR IGNORE on a fixed id, so a re-run adds
-- nothing and never overwrites an edit the owner has made since. That
-- also means a change to a rule here does NOT reach a database that
-- already holds the row: change it in the owner screens, or ship a
-- migration.
--
-- What this file never writes: accounts, entitlement grants, credits,
-- bookings, Samy's email (the massage resource has no staff account
-- until she has a real one), or any row with is_demo = 1.

-- 1. The production marker (CTL-ENV-01). The dev-login gate (auth.js,
-- demoDevLink) issues a link only when this row says 'preview', so with
-- 'production' it refuses. A second run keeps the existing row.
INSERT OR IGNORE INTO portal_meta (id, env, created_at) VALUES (1, 'production', datetime('now'));

-- 2. Refuse to go on against a database whose marker is not 'production'
-- (for example the preview D1). On such a database this statement breaks
-- NOT NULL, which aborts the run before any resource is written. On a
-- production database it matches no row and does nothing.
UPDATE portal_meta SET env = NULL WHERE id = 1 AND env <> 'production';

-- 3. Resources, PIN L3. Courts: 90 min slots, 07:00 first start, close
-- 19:00 (last start 17:30), 7 days, window 60 days for every booker, no
-- cap on upcoming court bookings (max_active_per_account NULL), online
-- cancel up to 24 h (1440 min) before the start.
-- Cold Plunge: open 7 days, 20 min, bookable at least 24 h ahead (1440).
-- Massage: present, but its offerings below are inactive.
-- Plunge and massage hours, and their one-booking cap (S-9), are not in
-- L3: they are flagged in unconfirmed_fields for the owner to confirm.
INSERT OR IGNORE INTO resources
  (id, kind, name, staff_account_id, open_time, close_time, slot_minutes, buffer_minutes,
   member_window_days, non_member_window_days, cancel_cutoff_minutes, min_advance_minutes,
   max_active_per_account, member_included, price_mode, is_demo, unconfirmed_fields, created_at, updated_at)
VALUES
  ('court-1',      'court',   'Court 1',                 NULL, '07:00', '19:00', 90, 0, 60, 60, 1440,    0, NULL, 1, 'per_player',  0, '[]', datetime('now'), datetime('now')),
  ('court-2',      'court',   'Court 2',                 NULL, '07:00', '19:00', 90, 0, 60, 60, 1440,    0, NULL, 1, 'per_player',  0, '[]', datetime('now'), datetime('now')),
  ('court-3',      'court',   'Court 3',                 NULL, '07:00', '19:00', 90, 0, 60, 60, 1440,    0, NULL, 1, 'per_player',  0, '[]', datetime('now'), datetime('now')),
  ('court-4',      'court',   'Court 4',                 NULL, '07:00', '19:00', 90, 0, 60, 60, 1440,    0, NULL, 1, 'per_player',  0, '[]', datetime('now'), datetime('now')),
  ('massage-samy', 'massage', 'Massage Therapy by Samy', NULL, '07:00', '19:00', 60, 0, 60, 60, 1440,    0,    1, 0, 'per_booking', 0, '["open_time","close_time","max_active_per_account"]', datetime('now'), datetime('now')),
  ('cold-plunge',  'plunge',  'Cold Plunge',             NULL, '07:00', '19:00', 20, 0, 60, 60, 1440, 1440,    1, 1, 'per_booking', 0, '["open_time","close_time","max_active_per_account"]', datetime('now'), datetime('now'));

-- 4. Offerings and the Amendment-4 prices (display mirror in cents; the
-- Stripe Price named by lookup_key is the truth for the amount charged).
-- Massage is inactive (active = 0) until Roger gives Samy's hours (PIN
-- L3): the booking API refuses an offering whose active flag is 0.
INSERT OR IGNORE INTO offerings
  (id, resource_id, name, duration_minutes, audience, lookup_key, display_price_cents, active, created_at, updated_at)
VALUES
  ('court-1-session',  'court-1',      'Non-member session',          90, 'everyone',      'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('court-2-session',  'court-2',      'Non-member session',          90, 'everyone',      'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('court-3-session',  'court-3',      'Non-member session',          90, 'everyone',      'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('court-4-session',  'court-4',      'Non-member session',          90, 'everyone',      'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('massage-60',       'massage-samy', 'Massage 60 min',              60, 'everyone',      'massage_60',        5500, 0, datetime('now'), datetime('now')),
  ('massage-90',       'massage-samy', 'Massage 90 min',              90, 'everyone',      'massage_90',        8000, 0, datetime('now'), datetime('now')),
  ('plunge-annual',    'cold-plunge',  'Cold Plunge (annual member)', 20, 'member_annual', NULL,                   0, 1, datetime('now'), datetime('now')),
  ('plunge-member',    'cold-plunge',  'Cold Plunge (member)',        20, 'member_other',  'plunge_member',     1000, 1, datetime('now'), datetime('now')),
  ('plunge-guest',     'cold-plunge',  'Cold Plunge (guest)',         20, 'guest',         'plunge_guest',      1500, 1, datetime('now'), datetime('now'));
