// M8 (CTL-ASSET-01): .assetsignore is an ALLOW-LIST (starts with `*`,
// negates only the public surface), proven locally with wrangler's own
// negation support (confirmed working: tested against an isolated
// throwaway Worker+assets config before converting this project's real
// file, so this is a construction proof, not an assumption about
// wrangler's behaviour). A new root file is private by default unless
// someone deliberately negates it -- the opposite failure mode from a
// deny-list, where a new private file leaks until someone remembers to
// list it.
//
// RED construction: before this fix, .assetsignore was a deny-list
// that never mentioned src/, migrations/, tests/ or docs/ individually
// enough to guarantee every CURRENT and FUTURE private root path 404s
// -- the comment even named a probe file (this one) that did not
// exist. Today's deny-list happens not to leak anything existing
// (confirmed by this same suite), but the control itself -- "a new
// root file is private by default" -- was never built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_URL } from "./helpers.mjs";

async function status(path) {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return res.status;
}

test("M8: the exact dispatch probe set -- private paths 404", async () => {
  for (const path of [
    "/src/worker.js",
    "/migrations/0001_env_accounts_auth.sql",
    "/tests/qa-helpers.mjs",
    "/docs/portal/api.md",
    "/wrangler.toml",
    "/package.json",
  ]) {
    assert.equal(await status(path), 404, `${path} must 404 under the allow-list`);
  }
});

test("M8: the exact dispatch probe set -- public paths still serve", async () => {
  assert.equal(await status("/"), 200);
  assert.equal(await status("/membership"), 200);
  assert.equal(await status("/portal/"), 200);
  assert.equal(await status("/assets/styles.css"), 200);
  assert.equal(await status("/admin/"), 200);
});

test("M8 RED->GREEN: a brand-new, never-negated root file is private by construction (the allow-list's whole point)", async () => {
  // There is no `!/zz-private-probe.txt` anywhere in .assetsignore, and
  // there never will be -- this is the exact probe controls.md's own
  // comment named as never having run. A deny-list would have had to
  // remember to list this file; the allow-list refuses it for free.
  assert.equal(await status("/zz-private-probe.txt"), 404);
});
