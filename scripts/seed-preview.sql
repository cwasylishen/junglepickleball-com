-- Demo/preview seed data for the Jungle Pickleball portal. NEVER a
-- migration (PIN-5) -- apply with:
--   wrangler d1 execute PORTAL_DB --local --file=scripts/seed-preview.sql
-- Never add --remote. This file is for the local/preview D1 only.
--
-- The FIRST statement writes the preview environment marker with a plain
-- INSERT (CTL-ENV-01 d): portal_meta.id has CHECK(id = 1), so on a
-- database that already holds a marker row (preview OR production) this
-- statement fails on the UNIQUE/PK violation and the whole run aborts
-- before any demo account or resource is written.
INSERT INTO portal_meta (id, env, created_at) VALUES (1, 'preview', datetime('now'));

-- ---------------------------------------------------------------------
-- Demo accounts (PIN-9, S-1). Fixed ids so tests/foundation can refer to
-- them by name instead of re-discovering a random UUID.
-- ---------------------------------------------------------------------
INSERT INTO accounts (id, email, role, display_name, is_demo, age_attested_at, created_at, updated_at) VALUES
  ('demo-owner-0000-0000-000000000001', 'owner.demo@jp-demo.test',  'owner',  'Owner Demo',  1, datetime('now'), datetime('now'), datetime('now')),
  ('demo-staff-0000-0000-000000000002', 'staff.demo@jp-demo.test',  'staff',  'Samy',        1, datetime('now'), datetime('now'), datetime('now')),
  ('demo-memb1-0000-0000-000000000003', 'member.demo@jp-demo.test', 'member', 'Member Demo', 1, datetime('now'), datetime('now'), datetime('now')),
  ('demo-memb2-0000-0000-000000000004', 'member2.demo@jp-demo.test','member', 'Member Two',  1, datetime('now'), datetime('now'), datetime('now')),
  ('demo-guest-0000-0000-000000000005', 'guest.demo@jp-demo.test',  'guest',  'Guest Demo',  1, datetime('now'), datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------
-- Entitlement grants, source='hand', no Stripe ids (PIN-9). One row per
-- writer (CTL-ENT-01): both are hand grants made by the demo owner.
-- ---------------------------------------------------------------------
INSERT INTO entitlement_grants (id, account_id, source, tier, starts_at, ends_at, status, created_by, note, created_at, updated_at) VALUES
  ('demo-grant-0000-0000-000000000001', 'demo-memb1-0000-0000-000000000003', 'hand', 'jp_annual_single', datetime('now'), datetime('now', '+1 year'), 'active', 'demo-owner-0000-0000-000000000001', 'seed: annual single, no Stripe', datetime('now'), datetime('now')),
  ('demo-grant-0000-0000-000000000002', 'demo-memb2-0000-0000-000000000004', 'hand', 'jp_1m_single',     datetime('now'), datetime('now', '+1 month'), 'active', 'demo-owner-0000-0000-000000000001', 'seed: 1-month single, no Stripe', datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------
-- Resources (PIN-15/Amendment 4). Every seeded value is owner-editable
-- and flagged "default, confirm with Roger" via unconfirmed_fields.
-- ---------------------------------------------------------------------
INSERT INTO resources (id, kind, name, staff_account_id, open_time, close_time, slot_minutes, buffer_minutes, member_window_days, non_member_window_days, cancel_cutoff_minutes, max_active_per_account, member_included, price_mode, is_demo, unconfirmed_fields, created_at, updated_at) VALUES
  ('demo-court-0000-0000-000000000001', 'court', 'Court 1', NULL, '07:00', '19:30', 90, 0, 7, 2, 120, 2, 1, 'per_player', 1, '["open_time","close_time","buffer_minutes","cancel_cutoff_minutes","max_active_per_account"]', datetime('now'), datetime('now')),
  ('demo-court-0000-0000-000000000002', 'court', 'Court 2', NULL, '07:00', '19:30', 90, 0, 7, 2, 120, 2, 1, 'per_player', 1, '["open_time","close_time","buffer_minutes","cancel_cutoff_minutes","max_active_per_account"]', datetime('now'), datetime('now')),
  ('demo-court-0000-0000-000000000003', 'court', 'Court 3', NULL, '07:00', '19:30', 90, 0, 7, 2, 120, 2, 1, 'per_player', 1, '["open_time","close_time","buffer_minutes","cancel_cutoff_minutes","max_active_per_account"]', datetime('now'), datetime('now')),
  ('demo-court-0000-0000-000000000004', 'court', 'Court 4', NULL, '07:00', '19:30', 90, 0, 7, 2, 120, 2, 1, 'per_player', 1, '["open_time","close_time","buffer_minutes","cancel_cutoff_minutes","max_active_per_account"]', datetime('now'), datetime('now')),
  ('demo-msg-00000-0000-000000000005', 'massage', 'Massage Therapy by Samy', 'demo-staff-0000-0000-000000000002', '07:00', '19:30', 60, 0, 7, 2, 120, 1, 0, 'per_booking', 1, '["open_time","close_time","cancel_cutoff_minutes"]', datetime('now'), datetime('now')),
  ('demo-plng-00000-0000-000000000006', 'plunge', 'Cold Plunge', NULL, '07:00', '19:30', 20, 0, 7, 2, 120, 1, 1, 'per_booking', 1, '["open_time","close_time","cancel_cutoff_minutes"]', datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------
-- Offerings (Amendment 4 lookup_keys; no price_data).
-- ---------------------------------------------------------------------
INSERT INTO offerings (id, resource_id, name, duration_minutes, audience, lookup_key, display_price_cents, active, created_at, updated_at) VALUES
  ('demo-off-00000-0000-000000000001', 'demo-court-0000-0000-000000000001', 'Non-member session', 90, 'everyone', 'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000002', 'demo-court-0000-0000-000000000002', 'Non-member session', 90, 'everyone', 'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000003', 'demo-court-0000-0000-000000000003', 'Non-member session', 90, 'everyone', 'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000004', 'demo-court-0000-0000-000000000004', 'Non-member session', 90, 'everyone', 'jp_session_single', 1500, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000005', 'demo-msg-00000-0000-000000000005', 'Massage 60 min', 60, 'everyone', 'massage_60', 5500, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000006', 'demo-msg-00000-0000-000000000005', 'Massage 90 min', 90, 'everyone', 'massage_90', 8000, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000007', 'demo-plng-00000-0000-000000000006', 'Cold Plunge (annual member)', 20, 'member_annual', NULL, 0, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000008', 'demo-plng-00000-0000-000000000006', 'Cold Plunge (member)', 20, 'member_other', 'plunge_member', 1000, 1, datetime('now'), datetime('now')),
  ('demo-off-00000-0000-000000000009', 'demo-plng-00000-0000-000000000006', 'Cold Plunge (guest)', 20, 'guest', 'plunge_guest', 1500, 1, datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------
-- credits balance rows (zero; present so the resolver has a row to read).
-- ---------------------------------------------------------------------
INSERT INTO credits (account_id, balance, updated_at) VALUES
  ('demo-memb1-0000-0000-000000000003', 0, datetime('now')),
  ('demo-memb2-0000-0000-000000000004', 0, datetime('now')),
  ('demo-guest-0000-0000-000000000005', 0, datetime('now'));

-- ---------------------------------------------------------------------
-- portal(FR1): two sample massage bookings with Samy (staff.demo, the
-- resource's assigned staff), made by member.demo, tomorrow and the day
-- after in Costa Rica local time (UTC-6, A8) -- so the staff calendar
-- demo (GET /api/portal/staff/calendar) is not empty on a fresh preview
-- DB. `payment_mode='override'`/`status='confirmed'` (rather than
-- CTL-MSG-01's real pending_payment-then-webhook path) because this is
-- seed data, not a live booking flow, and needs no Stripe webhook to
-- land already-confirmed on a cold database.
-- ---------------------------------------------------------------------
INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, created_by, created_at, updated_at) VALUES
  ('demo-bkg-msg1-0-000-000000000001', 'demo-memb1-0000-0000-000000000003', 'demo-msg-00000-0000-000000000005', 'demo-off-00000-0000-000000000005',
    datetime('now', '+1 day', 'start of day', '+16 hours'), datetime('now', '+1 day', 'start of day', '+17 hours'),
    1, 0, 'confirmed', 'override', 'demo-owner-0000-0000-000000000001', datetime('now'), datetime('now')),
  ('demo-bkg-msg2-0-000-000000000002', 'demo-memb1-0000-0000-000000000003', 'demo-msg-00000-0000-000000000005', 'demo-off-00000-0000-000000000006',
    datetime('now', '+2 day', 'start of day', '+20 hours'), datetime('now', '+2 day', 'start of day', '+21 hours'),
    1, 0, 'confirmed', 'override', 'demo-owner-0000-0000-000000000001', datetime('now'), datetime('now'));
