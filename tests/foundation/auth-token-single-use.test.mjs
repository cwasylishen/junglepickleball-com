// M3 (PIN-8 single-use token): login_tokens consumption must be one
// atomic `UPDATE ... WHERE consumed_at IS NULL RETURNING`, not a SELECT
// followed later by a separate, unguarded UPDATE.
//
// The first test proves the SQL mechanism directly and deterministically:
// wrangler dev's single-threaded local runtime does not reliably
// interleave two concurrent HTTP requests mid-handler, so a race proven
// only over HTTP can pass by luck even on the unguarded statement (two
// requests simply run back-to-back). Issuing the two candidate SQL
// statements directly, in the exact order a race would deliver them, is
// the construction PIN-18 asks for: it fires every time, not sometimes.
//
// The second test is the end-to-end regression check: the shipped route
// enforces single-use (a reused token is rejected), proven once through
// the real HTTP path with the real auth.js code.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { d1, BASE_URL } from "./helpers.mjs";
import { sha256Hex } from "../../src/portal/auth.js";

async function insertLoginToken(email) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = await sha256Hex(token);
  const id = `tok-m3-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nowIsoStr = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  d1(
    `INSERT INTO login_tokens (id, email, token_hash, created_at, expires_at, ip) VALUES ('${id}', '${email}', '${tokenHash}', '${nowIsoStr}', '${expiresIso}', '127.0.0.1')`
  );
  return { id, tokenHash };
}

test("M3 RED->GREEN: the unguarded UPDATE lets two racing consumers both win; the guarded one lets exactly one", async () => {
  const { id } = await insertLoginToken("member.demo@jp-demo.test");

  // RED: the exact statement M3 reports (auth.js:203 before the fix) --
  // unconditional on `id`, no `consumed_at IS NULL` guard. Both racing
  // callers run this; both report a row changed, so both believe they
  // won the single use.
  const redFirst = d1(`UPDATE login_tokens SET consumed_at = datetime('now') WHERE id = '${id}' RETURNING id`);
  const redSecond = d1(`UPDATE login_tokens SET consumed_at = datetime('now') WHERE id = '${id}' RETURNING id`);
  assert.equal(redFirst.length, 1, "RED: first unguarded UPDATE reports a row changed");
  assert.equal(redSecond.length, 1, "RED: the SAME unguarded UPDATE reports a row changed again -- the bug M3 names");

  // Reset for the GREEN half of the same probe.
  d1(`UPDATE login_tokens SET consumed_at = NULL WHERE id = '${id}'`);

  // GREEN: the fixed statement (auth.js, M3) -- gated on `consumed_at
  // IS NULL`, with RETURNING so the caller can tell whether it won.
  const greenFirst = d1(`UPDATE login_tokens SET consumed_at = datetime('now') WHERE id = '${id}' AND consumed_at IS NULL RETURNING id`);
  const greenSecond = d1(`UPDATE login_tokens SET consumed_at = datetime('now') WHERE id = '${id}' AND consumed_at IS NULL RETURNING id`);
  assert.equal(greenFirst.length, 1, "GREEN: the first guarded UPDATE claims the token");
  assert.equal(greenSecond.length, 0, "GREEN: the second guarded UPDATE finds no unconsumed row -- exactly one winner");
});

test("M3 end-to-end: a reused token is rejected by the real /auth/verify route", async () => {
  const email = "member.demo@jp-demo.test";
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = await sha256Hex(token);
  const id = `tok-m3b-${Date.now()}`;
  const nowIsoStr = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  d1(
    `INSERT INTO login_tokens (id, email, token_hash, created_at, expires_at, ip) VALUES ('${id}', '${email}', '${tokenHash}', '${nowIsoStr}', '${expiresIso}', '127.0.0.1')`
  );

  const post = () =>
    fetch(`${BASE_URL}/api/portal/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ token }),
    }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));

  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);

  const second = await post();
  assert.equal(second.status, 400);
  assert.equal(second.data.error, "verify.bad_used");
});
