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

// FR3/SCV-05 (F-1, preview-deploy.md): the deployed preview served
// `/portal/src/input.css` (200) -- Cloudflare's real asset-ignore
// matcher re-included it once `!/portal/*` re-included the `portal/src`
// directory entry. `/portal/src` + `/portal/src/*`, added right after
// `!/portal/*`, makes the exclusion explicit rather than relying on
// implicit fallthrough.
//
// PIN-18 honesty note: this is marked UNPROVEN-locally, not
// RED->GREEN. Checked directly against the real `ignore` npm package
// (the exact one miniflare's local asset-manifest builder uses) with
// BOTH the pre-fix and post-fix .assetsignore content, "portal/src/
// input.css" already resolves `ignored: true` either way -- the local
// matcher correctly falls through an un-negated path to the top-level
// `*`, so this specific gap only manifests against Cloudflare's real
// deploy-time asset service (where F-1 was actually observed), which
// this fix round has no local way to drive red. The explicit rule is
// still the correct, directly-responsive fix for F-1's literal ask
// ("allow-list nested-path fix in .assetsignore"); this test only
// guards the CONSTRUCTION (the exact gap the header comment names)
// against a future regression, and the real proof is a preview
// deploy's `WRANGLER_LOG=debug wrangler deploy --dry-run`, outside
// this round's local-only scope (B2-COMMON).
test("SCV-05/F-1 (UNPROVEN-locally, PIN-18): .assetsignore explicitly excludes portal/src/input.css, not by fallthrough alone", async () => {
  const ignoreModule = await import("/home/mike/.npm-global/lib/node_modules/@openacp/cli/node_modules/ignore/index.js");
  const makeIgnore = ignoreModule.default || ignoreModule;
  const fs = await import("node:fs");
  const raw = fs.readFileSync(new URL("../../.assetsignore", import.meta.url), "utf8");
  assert.match(
    raw,
    /\n\/portal\/src\n\/portal\/src\/\*\n/,
    "an EXPLICIT /portal/src exclusion must exist right after !/portal/* -- relying on implicit fallthrough is exactly what let F-1 happen on the real deploy"
  );
  const ig = makeIgnore().add(raw.split("\n"));
  assert.equal(ig.test("portal/src/input.css").ignored, true, "portal/src/input.css must be excluded");
  assert.equal(ig.test("portal/portal.css").ignored, false, "portal/portal.css (a real public portal file) must stay included");
});
