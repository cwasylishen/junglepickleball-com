// F11: the service worker serves its cached files cache-first, under a cache
// named for BUILD_ID (portal/sw.js, CTL-PWA-02). Shipping a changed cached file
// without bumping BUILD_ID leaves the OLD file pinned on every installed device
// (a stale portal.css did exactly that). This test compares each cached file to
// tests/fixtures/sw-release-manifest.json, the record of the LAST RELEASE:
//   1. while BUILD_ID still equals the manifest's build_id, no cached file may
//      differ from the manifest (the failure names the files);
//   2. every file sw.js caches must be listed in the manifest, and be on disk.
//
// On each release: bump BUILD_ID, then run scripts/sw-release-manifest.mjs and
// commit. (The manifest then describes that release; until it ships, the
// manifest stays at the previous one, and the bumped BUILD_ID is what keeps
// this test green.)
//
// The list of cached files is read from sw.js, not kept here. The checker is a
// pure function with its own tests (last block), so a wrong checker cannot
// pass the real check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_PATH, readServiceWorker, sha256 } from "../../scripts/sw-release-manifest.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Returns a list of problem strings; empty means the guard is satisfied.
//   sw        { buildId, files }   from sw.js
//   manifest  { build_id, files }  the last release
//   hashOf    (file) => sha256 hex, or null when the file is not on disk
function checkAgainstRelease(sw, manifest, hashOf) {
  const problems = [];
  const unlisted = sw.files.filter((f) => !(f in manifest.files));
  if (unlisted.length > 0) {
    problems.push(
      `sw.js caches file(s) the manifest does not list: ${unlisted.join(", ")}. ` +
        `Run scripts/sw-release-manifest.mjs after bumping BUILD_ID.`
    );
  }
  const missing = sw.files.filter((f) => hashOf(f) === null);
  if (missing.length > 0) {
    problems.push(`sw.js caches file(s) that are not on disk: ${missing.join(", ")}`);
  }
  if (sw.buildId === manifest.build_id) {
    const changed = sw.files.filter(
      (f) => f in manifest.files && hashOf(f) !== null && hashOf(f) !== manifest.files[f]
    );
    if (changed.length > 0) {
      problems.push(
        `BUILD_ID is still ${sw.buildId} (the last release) but these cached files changed: ` +
          `${changed.join(", ")}. Installed devices would keep serving the old copies. ` +
          `Bump BUILD_ID in portal/sw.js.`
      );
    }
  }
  return problems;
}

function currentHash(file) {
  const full = path.join(REPO_ROOT, file);
  return fs.existsSync(full) ? sha256(fs.readFileSync(full)) : null;
}

test("F11: no cached file changed since the last release unless BUILD_ID was bumped", () => {
  const sw = readServiceWorker(fs.readFileSync(path.join(REPO_ROOT, "portal/sw.js"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MANIFEST_PATH), "utf8"));
  assert.deepEqual(checkAgainstRelease(sw, manifest, currentHash), []);
});

// ---- the checker and the sw.js reader, on synthetic input ----

const SW = { buildId: "R2", files: ["portal/a.css", "portal/b.js"] };
const MANIFEST = { build_id: "R1", files: { "portal/a.css": "h-a", "portal/b.js": "h-b" } };
const hashes = (table) => (f) => (f in table ? table[f] : null);

test("checker: a changed cached file under the old BUILD_ID is named", () => {
  const sw = { ...SW, buildId: "R1" };
  const problems = checkAgainstRelease(sw, MANIFEST, hashes({ "portal/a.css": "NEW", "portal/b.js": "h-b" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /portal\/a\.css/);
  assert.doesNotMatch(problems[0], /portal\/b\.js/);
});

test("checker: every changed file is named, not just the first", () => {
  const sw = { ...SW, buildId: "R1" };
  const [problem] = checkAgainstRelease(sw, MANIFEST, hashes({ "portal/a.css": "X", "portal/b.js": "Y" }));
  assert.match(problem, /portal\/a\.css, portal\/b\.js/);
});

test("checker: the same change passes once BUILD_ID differs from the manifest", () => {
  const problems = checkAgainstRelease(SW, MANIFEST, hashes({ "portal/a.css": "NEW", "portal/b.js": "NEWER" }));
  assert.deepEqual(problems, []);
});

test("checker: unchanged files under the old BUILD_ID pass", () => {
  const sw = { ...SW, buildId: "R1" };
  assert.deepEqual(checkAgainstRelease(sw, MANIFEST, hashes({ "portal/a.css": "h-a", "portal/b.js": "h-b" })), []);
});

test("checker: a cached file the manifest does not list fails, even with BUILD_ID bumped", () => {
  const sw = { buildId: "R2", files: ["portal/a.css", "portal/b.js", "portal/new.js"] };
  const problems = checkAgainstRelease(sw, MANIFEST, hashes({ "portal/a.css": "h-a", "portal/b.js": "h-b", "portal/new.js": "z" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /portal\/new\.js/);
});

test("checker: a cached file missing from disk fails and is named", () => {
  const problems = checkAgainstRelease(SW, MANIFEST, hashes({ "portal/a.css": "h-a" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not on disk: portal\/b\.js/);
});

test("reader: takes the BUILD_ID and the cached files from sw.js text", () => {
  const text = `const BUILD_ID = "X.9";\nconst PRECACHE_URLS = [\n  "/portal/one.css",\n  "/portal/v/two.js",\n];\n`;
  assert.deepEqual(readServiceWorker(text), { buildId: "X.9", files: ["portal/one.css", "portal/v/two.js"] });
});

test("reader: refuses a sw.js it cannot read rather than checking nothing", () => {
  assert.throws(() => readServiceWorker("const PRECACHE_URLS = [];"), /BUILD_ID/);
  assert.throws(() => readServiceWorker('const BUILD_ID = "x";'), /PRECACHE_URLS/);
  assert.throws(() => readServiceWorker('const BUILD_ID = "x";\nconst PRECACHE_URLS = [];'), /empty/);
  assert.throws(() => readServiceWorker('const BUILD_ID = "x";\nconst PRECACHE_URLS = ["/api/me"];'), /\/api\/me/);
});

test("manifest: lists exactly the files sw.js caches today (derived, not hand-kept)", () => {
  const sw = readServiceWorker(fs.readFileSync(path.join(REPO_ROOT, "portal/sw.js"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MANIFEST_PATH), "utf8"));
  assert.deepEqual(Object.keys(manifest.files).sort(), [...sw.files].sort());
});
