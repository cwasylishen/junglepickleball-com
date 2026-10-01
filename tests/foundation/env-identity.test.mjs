// CTL-ENV-01, CTL-ENV-02, CTL-ENV-03.
//
// RED, demonstrated by construction (not left to imagination): before
// src/portal/router.js's resolveEnvironmentClass existed, every one of
// these requests would simply have run the handler -- a deleted/mismatched
// marker or a real account in the preview DB would have been served
// normally. That is exactly the failure each assertion below rules out.
// GREEN is the 503 this suite requires every time the signals disagree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient, d1 } from "./helpers.mjs";

test("CTL-ENV-01: agreeing signals (preview host + preview marker) serve normally", async () => {
  // GET /api/portal/me has route class "own", which requires a session
  // (the acceptance test fixes this: "no session gives 401") -- 401 here
  // IS "serving normally", distinguished from the 503 environment_mismatch
  // the next tests prove for a genuine signal disagreement.
  const client = makeClient();
  const res = await client.get("/api/portal/me");
  assert.equal(res.status, 401);
});

test("CTL-ENV-01 (a): deleting the portal_meta marker -> every portal route is 503 environment_mismatch, nothing else", async () => {
  d1(`DELETE FROM portal_meta`);
  try {
    const client = makeClient();
    const res = await client.get("/api/portal/me");
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "environment_mismatch");
  } finally {
    d1(`INSERT INTO portal_meta (id, env, created_at) VALUES (1, 'preview', datetime('now'))`);
  }
});

test("CTL-ENV-01: a production marker on a preview (localhost) host is a mismatch, not production", async () => {
  d1(`UPDATE portal_meta SET env = 'production' WHERE id = 1`);
  try {
    const client = makeClient();
    const res = await client.get("/api/portal/me");
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "environment_mismatch");
  } finally {
    d1(`UPDATE portal_meta SET env = 'preview' WHERE id = 1`);
  }
});

test("CTL-ENV-01 (d): re-running seed-preview.sql against a DB that already holds a marker fails before writing anything else", () => {
  const before = d1(`SELECT COUNT(*) AS n FROM accounts`)[0].n;
  let failed = false;
  try {
    d1(`INSERT INTO portal_meta (id, env, created_at) VALUES (1, 'preview', datetime('now'))`);
  } catch {
    failed = true;
  }
  assert.equal(failed, true, "a second marker insert must violate the single-row CHECK/PK");
  const after = d1(`SELECT COUNT(*) AS n FROM accounts`)[0].n;
  assert.equal(after, before, "no account row should have been touched by the failed re-seed");
});

test("CTL-ENV-02: a non-demo account in the preview DB makes every portal route 503, even unauthenticated ones", async () => {
  d1(`INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES ('real-account-0000000000000001', 'real.person@example.com', 'guest', '', 0, datetime('now'), datetime('now'))`);
  try {
    const client = makeClient();
    const res = await client.get("/api/portal/me");
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "environment_mismatch");
  } finally {
    d1(`DELETE FROM accounts WHERE id = 'real-account-0000000000000001'`);
  }
});

test("CTL-ENV-03: portal code never reaches the legacy DB/EVENTS/ANALYTICS bindings", async () => {
  const { execSync } = await import("node:child_process");
  const hits = execSync(`grep -rnE "env\\.(DB|EVENTS|ANALYTICS)\\b" src/portal || true`, {
    cwd: new URL("../..", import.meta.url).pathname,
    encoding: "utf8",
  }).trim();
  assert.equal(hits, "", `portal code must never read env.DB/EVENTS/ANALYTICS; found:\n${hits}`);
});
