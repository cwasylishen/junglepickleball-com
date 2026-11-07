// Writes tests/fixtures/sw-release-manifest.json: the BUILD_ID of portal/sw.js
// and the sha256 of every file the service worker caches, as of one release.
// tests/foundation/sw-build-id-guard.test.mjs compares the working tree to that
// record. Run it as the last step of each release, AFTER bumping BUILD_ID:
//
//   node scripts/sw-release-manifest.mjs            # from the working tree
//   node scripts/sw-release-manifest.mjs --ref <sha> # from a past commit
//
// The list of files is read out of sw.js (PRECACHE_URLS), never kept here.
// The URL "/portal/x" is the repo file "portal/x" (the Worker serves the repo
// root as its assets directory).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_PATH = "portal/sw.js";
export const MANIFEST_PATH = "tests/fixtures/sw-release-manifest.json";

// Returns { buildId, files } where files are repo-relative paths of everything
// the service worker caches. Throws (with the reason) on a sw.js it cannot read,
// so a changed layout is a red test and not an empty list that checks nothing.
export function readServiceWorker(swText) {
  const idMatch = swText.match(/const BUILD_ID = "([^"]+)";/);
  if (!idMatch) throw new Error('sw.js: no line of the form  const BUILD_ID = "...";');
  const listMatch = swText.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
  if (!listMatch) throw new Error("sw.js: no PRECACHE_URLS = [ ... ]; list");
  const urls = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (urls.length === 0) throw new Error("sw.js: PRECACHE_URLS is empty");
  const files = urls.map((url) => {
    if (!url.startsWith("/portal/")) throw new Error(`sw.js: cached URL ${url} is not under /portal/`);
    return url.slice(1);
  });
  return { buildId: idMatch[1], files };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// One reader of file bytes: the working tree, or a git ref when given.
export function makeReader(ref) {
  if (!ref) return (file) => fs.readFileSync(path.join(REPO_ROOT, file));
  return (file) =>
    execFileSync("git", ["show", `${ref}:${file}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
}

export function buildManifest(read) {
  const { buildId, files } = readServiceWorker(read(SW_PATH).toString("utf8"));
  const hashes = {};
  for (const file of [...files].sort()) hashes[file] = sha256(read(file));
  return { build_id: buildId, files: hashes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const refAt = process.argv.indexOf("--ref");
  const ref = refAt === -1 ? null : process.argv[refAt + 1];
  if (refAt !== -1 && !ref) {
    console.error("--ref needs a git ref, e.g.  --ref 5449890");
    process.exit(2);
  }
  const manifest = buildManifest(makeReader(ref));
  fs.writeFileSync(path.join(REPO_ROOT, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${MANIFEST_PATH}: build_id ${manifest.build_id}, ${Object.keys(manifest.files).length} files`);
}
