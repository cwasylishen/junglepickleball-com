// QA2: test-plan.md §8, A4 probe -- nothing private is served, PATH-001..003.
// Real filenames confirmed against this run's actual repo contents
// (test-plan.md's own note: don't guess them).

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_URL } from "./qa-helpers.mjs";

test("PATH-001: a migration file is not served", async () => {
  const res = await fetch(`${BASE_URL}/migrations/0001_env_accounts_auth.sql`);
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

test("PATH-002: a test file is not served", async () => {
  const res = await fetch(`${BASE_URL}/tests/qa-helpers.mjs`);
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

test("PATH-003: the API contract doc is not served", async () => {
  const res = await fetch(`${BASE_URL}/docs/portal/api.md`);
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});
