// Acceptance scenario 6 (B2b dispatch): scripts/stripe-setup.mjs refuses
// to run with no key, and lists all 13 lookup_keys (the 9 B1 shipped
// plus amendment 4's 4). This file never sets STRIPE_SECRET_KEY and
// never lets the script make a network call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPT_PATH = new URL("../../scripts/stripe-setup.mjs", import.meta.url).pathname;
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

test("stripe-setup.mjs: refuses to run (exit 1) with STRIPE_SECRET_KEY unset", () => {
  const env = { ...process.env };
  delete env.STRIPE_SECRET_KEY;
  let threw = false;
  let status = 0;
  try {
    execFileSync("node", [SCRIPT_PATH], { cwd: REPO_ROOT, env, encoding: "utf8" });
  } catch (err) {
    threw = true;
    status = err.status;
  }
  assert.equal(threw, true, "the script must not exit 0 with no key");
  assert.equal(status, 1);
});

test("stripe-setup.mjs: lists all 13 lookup_keys (9 from B1 + amendment 4's massage/plunge four)", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const keys = [...src.matchAll(/lookupKey: "([^"]+)"/g)].map((m) => m[1]);
  const expected = [
    "jp_1m_single",
    "jp_3m_single",
    "jp_3m_couples",
    "jp_6m_single",
    "jp_6m_couples",
    "jp_annual_single",
    "jp_annual_couples",
    "jp_session_single",
    "jp_session_pack8",
    "massage_60",
    "massage_90",
    "plunge_member",
    "plunge_guest",
  ];
  assert.equal(keys.length, 13);
  for (const key of expected) assert.ok(keys.includes(key), `missing lookup_key ${key}`);

  // Amendment 4: all four new items are one-time (never recurring).
  for (const key of ["massage_60", "massage_90", "plunge_member", "plunge_guest"]) {
    const re = new RegExp(`lookupKey: "${key}"[^}]*recurring: null`);
    assert.ok(re.test(src), `${key} must be one-time (recurring: null)`);
  }
});
