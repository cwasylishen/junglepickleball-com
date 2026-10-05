// Stamp the stylesheet's content hash into every page that links it.
//
//   node scripts/stamp-css.mjs
//
// Rewrites href="assets/styles.css" or "/assets/styles.css" (with or without
// an old ?v=) to carry ?v=<first 10 hex of sha256 of assets/styles.css>.
// `npm run build` runs it right after tailwind, so a rebuilt stylesheet gets
// a new URL and no browser can keep serving an older copy. It changes only
// the text of that one href; everything else in a page is left as it was.
// tests/foundation/styles-cache.test.mjs fails if any page's ?v= is stale.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set([".git", ".wrangler", "node_modules", "portal", "tests", "scripts", "functions", "src", "docs", "migrations"]);
const CSS_PATH = join(ROOT, "assets/styles.css");

const version = createHash("sha256").update(readFileSync(CSS_PATH)).digest("hex").slice(0, 10);

function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...htmlFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".html")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const LINK = /(href=["'])(\/?assets\/styles\.css)(\?v=[0-9a-f]*)?(["'])/g;

let changed = 0;
let linked = 0;
for (const file of htmlFiles(ROOT)) {
  const before = readFileSync(file, "utf8");
  let hits = 0;
  const after = before.replace(LINK, (_all, open, path, _oldQuery, close) => {
    hits++;
    return `${open}${path}?v=${version}${close}`;
  });
  if (hits === 0) continue;
  linked += hits;
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
    console.log(`stamped ${relative(ROOT, file)}`);
  }
}
console.log(`styles.css ?v=${version}: ${linked} link(s) in pages, ${changed} file(s) rewritten`);
