-- portal(QA3): LOCAL-ONLY test fixture. Loaded by scripts/test.sh AFTER
-- scripts/seed-preview.sql, against the same local, ephemeral D1
-- (--persist-to, wiped and rebuilt on every `npm test` run). This file
-- is never run against the real preview D1 and is never referenced by
-- any deploy/preview script.
--
-- WHY THIS EXISTS (QA3 dispatch, "demo-account starvation"):
-- src/portal/auth.js's demoDevLink() (S-1 e) only returns a dev_link
-- for an email that ALREADY EXISTS as accounts.is_demo = 1 --
-- "qa-<tag>-<timestamp>@jp-demo.test"-style addresses invented fresh by
-- a test (tests/qa-helpers.mjs's old uniqueEmail() + loginDemo() combo)
-- can NEVER get a dev_link, because they have no account row yet. That
-- is the pin working as designed (S-1 e), not a defect -- but it means
-- every QA2-authored test that called loginDemo(uniqueEmail(...)) to
-- get "a fresh, working login" was silently unable to log in at all.
--
-- The fix: a pool of 50 pre-seeded, pre-flagged is_demo accounts
-- (qa01..qa50@jp-demo.test, role=guest) that exist before the suite
-- runs, so any test that just needs "a distinct, working demo login"
-- can get a real dev_link immediately. Tests that must prove the
-- genuinely-new-account path (REQ-AUTH-17, AUTH-019/020) do NOT use
-- this pool -- they use qa-helpers.mjs's loginNewAccountDirect(), which
-- inserts a login_tokens row directly (the same white-box-on-setup
-- technique tests/foundation/auth-token-single-use.test.mjs already
-- uses for M3), bypassing demoDevLink entirely so a truly never-seeded
-- email can still be driven through POST /api/portal/auth/verify.
--
-- No portal_meta row here (seed-preview.sql already wrote it; a second
-- marker insert would violate the single-row CHECK/PK, CTL-ENV-01 d).

INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES
  ('qa-test-pool-0000-000000000001', 'qa01@jp-demo.test', 'guest', 'QA Pool 01', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000002', 'qa02@jp-demo.test', 'guest', 'QA Pool 02', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000003', 'qa03@jp-demo.test', 'guest', 'QA Pool 03', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000004', 'qa04@jp-demo.test', 'guest', 'QA Pool 04', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000005', 'qa05@jp-demo.test', 'guest', 'QA Pool 05', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000006', 'qa06@jp-demo.test', 'guest', 'QA Pool 06', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000007', 'qa07@jp-demo.test', 'guest', 'QA Pool 07', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000008', 'qa08@jp-demo.test', 'guest', 'QA Pool 08', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000009', 'qa09@jp-demo.test', 'guest', 'QA Pool 09', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000010', 'qa10@jp-demo.test', 'guest', 'QA Pool 10', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000011', 'qa11@jp-demo.test', 'guest', 'QA Pool 11', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000012', 'qa12@jp-demo.test', 'guest', 'QA Pool 12', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000013', 'qa13@jp-demo.test', 'guest', 'QA Pool 13', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000014', 'qa14@jp-demo.test', 'guest', 'QA Pool 14', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000015', 'qa15@jp-demo.test', 'guest', 'QA Pool 15', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000016', 'qa16@jp-demo.test', 'guest', 'QA Pool 16', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000017', 'qa17@jp-demo.test', 'guest', 'QA Pool 17', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000018', 'qa18@jp-demo.test', 'guest', 'QA Pool 18', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000019', 'qa19@jp-demo.test', 'guest', 'QA Pool 19', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000020', 'qa20@jp-demo.test', 'guest', 'QA Pool 20', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000021', 'qa21@jp-demo.test', 'guest', 'QA Pool 21', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000022', 'qa22@jp-demo.test', 'guest', 'QA Pool 22', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000023', 'qa23@jp-demo.test', 'guest', 'QA Pool 23', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000024', 'qa24@jp-demo.test', 'guest', 'QA Pool 24', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000025', 'qa25@jp-demo.test', 'guest', 'QA Pool 25', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000026', 'qa26@jp-demo.test', 'guest', 'QA Pool 26', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000027', 'qa27@jp-demo.test', 'guest', 'QA Pool 27', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000028', 'qa28@jp-demo.test', 'guest', 'QA Pool 28', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000029', 'qa29@jp-demo.test', 'guest', 'QA Pool 29', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000030', 'qa30@jp-demo.test', 'guest', 'QA Pool 30', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000031', 'qa31@jp-demo.test', 'guest', 'QA Pool 31', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000032', 'qa32@jp-demo.test', 'guest', 'QA Pool 32', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000033', 'qa33@jp-demo.test', 'guest', 'QA Pool 33', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000034', 'qa34@jp-demo.test', 'guest', 'QA Pool 34', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000035', 'qa35@jp-demo.test', 'guest', 'QA Pool 35', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000036', 'qa36@jp-demo.test', 'guest', 'QA Pool 36', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000037', 'qa37@jp-demo.test', 'guest', 'QA Pool 37', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000038', 'qa38@jp-demo.test', 'guest', 'QA Pool 38', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000039', 'qa39@jp-demo.test', 'guest', 'QA Pool 39', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000040', 'qa40@jp-demo.test', 'guest', 'QA Pool 40', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000041', 'qa41@jp-demo.test', 'guest', 'QA Pool 41', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000042', 'qa42@jp-demo.test', 'guest', 'QA Pool 42', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000043', 'qa43@jp-demo.test', 'guest', 'QA Pool 43', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000044', 'qa44@jp-demo.test', 'guest', 'QA Pool 44', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000045', 'qa45@jp-demo.test', 'guest', 'QA Pool 45', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000046', 'qa46@jp-demo.test', 'guest', 'QA Pool 46', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000047', 'qa47@jp-demo.test', 'guest', 'QA Pool 47', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000048', 'qa48@jp-demo.test', 'guest', 'QA Pool 48', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000049', 'qa49@jp-demo.test', 'guest', 'QA Pool 49', 1, datetime('now'), datetime('now')),
  ('qa-test-pool-0000-000000000050', 'qa50@jp-demo.test', 'guest', 'QA Pool 50', 1, datetime('now'), datetime('now'));

INSERT INTO credits (account_id, balance, updated_at) VALUES
  ('qa-test-pool-0000-000000000001', 0, datetime('now')),
  ('qa-test-pool-0000-000000000002', 0, datetime('now')),
  ('qa-test-pool-0000-000000000003', 0, datetime('now')),
  ('qa-test-pool-0000-000000000004', 0, datetime('now')),
  ('qa-test-pool-0000-000000000005', 0, datetime('now')),
  ('qa-test-pool-0000-000000000006', 0, datetime('now')),
  ('qa-test-pool-0000-000000000007', 0, datetime('now')),
  ('qa-test-pool-0000-000000000008', 0, datetime('now')),
  ('qa-test-pool-0000-000000000009', 0, datetime('now')),
  ('qa-test-pool-0000-000000000010', 0, datetime('now')),
  ('qa-test-pool-0000-000000000011', 0, datetime('now')),
  ('qa-test-pool-0000-000000000012', 0, datetime('now')),
  ('qa-test-pool-0000-000000000013', 0, datetime('now')),
  ('qa-test-pool-0000-000000000014', 0, datetime('now')),
  ('qa-test-pool-0000-000000000015', 0, datetime('now')),
  ('qa-test-pool-0000-000000000016', 0, datetime('now')),
  ('qa-test-pool-0000-000000000017', 0, datetime('now')),
  ('qa-test-pool-0000-000000000018', 0, datetime('now')),
  ('qa-test-pool-0000-000000000019', 0, datetime('now')),
  ('qa-test-pool-0000-000000000020', 0, datetime('now')),
  ('qa-test-pool-0000-000000000021', 0, datetime('now')),
  ('qa-test-pool-0000-000000000022', 0, datetime('now')),
  ('qa-test-pool-0000-000000000023', 0, datetime('now')),
  ('qa-test-pool-0000-000000000024', 0, datetime('now')),
  ('qa-test-pool-0000-000000000025', 0, datetime('now')),
  ('qa-test-pool-0000-000000000026', 0, datetime('now')),
  ('qa-test-pool-0000-000000000027', 0, datetime('now')),
  ('qa-test-pool-0000-000000000028', 0, datetime('now')),
  ('qa-test-pool-0000-000000000029', 0, datetime('now')),
  ('qa-test-pool-0000-000000000030', 0, datetime('now')),
  ('qa-test-pool-0000-000000000031', 0, datetime('now')),
  ('qa-test-pool-0000-000000000032', 0, datetime('now')),
  ('qa-test-pool-0000-000000000033', 0, datetime('now')),
  ('qa-test-pool-0000-000000000034', 0, datetime('now')),
  ('qa-test-pool-0000-000000000035', 0, datetime('now')),
  ('qa-test-pool-0000-000000000036', 0, datetime('now')),
  ('qa-test-pool-0000-000000000037', 0, datetime('now')),
  ('qa-test-pool-0000-000000000038', 0, datetime('now')),
  ('qa-test-pool-0000-000000000039', 0, datetime('now')),
  ('qa-test-pool-0000-000000000040', 0, datetime('now')),
  ('qa-test-pool-0000-000000000041', 0, datetime('now')),
  ('qa-test-pool-0000-000000000042', 0, datetime('now')),
  ('qa-test-pool-0000-000000000043', 0, datetime('now')),
  ('qa-test-pool-0000-000000000044', 0, datetime('now')),
  ('qa-test-pool-0000-000000000045', 0, datetime('now')),
  ('qa-test-pool-0000-000000000046', 0, datetime('now')),
  ('qa-test-pool-0000-000000000047', 0, datetime('now')),
  ('qa-test-pool-0000-000000000048', 0, datetime('now')),
  ('qa-test-pool-0000-000000000049', 0, datetime('now')),
  ('qa-test-pool-0000-000000000050', 0, datetime('now'));
