// F4-C: the shared stylesheet must never be pinned by a browser.
//
// Production sent `cache-control: public, max-age=31536000, immutable,
// public, max-age=0, must-revalidate` for /assets/styles.css, because the
// `/assets/*` immutable rule and the `/assets/styles.css` override in
// _headers BOTH applied (Cloudflare applies every matching rule; a later
// rule adds to an earlier one unless it detaches it with `! Header`). A
// browser reads that as "immutable for a year" and keeps an old stylesheet.
//
// Two defences, both tested here with no server (pure file reads):
//   1. _headers detaches the inherited Cache-Control for styles.css, so the
//      response carries exactly one, non-immutable.
//   2. Every page links the stylesheet as assets/styles.css?v=<first 10 hex
//      of its sha256>, so a stale pinned copy is bypassed at once and the
//      version can never drift from the file (scripts/stamp-css.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const SITE = "https://junglepickleball.com";

// ---- _headers, parsed with Cloudflare Pages/Workers-assets precedence -----
// A line with no indent starts a rule (a URL pattern). Indented lines belong
// to it: `Name: value` attaches a value, `! Name` detaches every value that
// earlier rules (or earlier lines of this rule) attached to that name. Every
// rule whose pattern matches the URL applies, in file order. `*` matches any
// run of characters (slashes included); `:name` matches one path segment.
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), lines: [] };
      rules.push(current);
      continue;
    }
    if (!current) throw new Error(`header line before any URL pattern: ${JSON.stringify(raw)}`);
    const line = raw.trim();
    if (line.startsWith("!")) {
      current.lines.push({ detach: line.slice(1).trim().toLowerCase() });
    } else {
      const colon = line.indexOf(":");
      assert.ok(colon > 0, `header line without a colon: ${JSON.stringify(raw)}`);
      current.lines.push({
        name: line.slice(0, colon).trim().toLowerCase(),
        value: line.slice(colon + 1).trim(),
      });
    }
  }
  return rules;
}

function patternToRegExp(pattern) {
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/:[A-Za-z_]\w*/g, "[^/]+");
  return new RegExp(`^${body}$`);
}

// Returns { "cache-control": ["v1", "v2"], ... } for one URL path.
function headersFor(rules, path) {
  const out = {};
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    for (const line of rule.lines) {
      if (line.detach) delete out[line.detach];
      else (out[line.name] ||= []).push(line.value);
    }
  }
  return out;
}

const rules = parseHeaders(readFileSync(join(REPO, "_headers"), "utf8"));

// ---- the public pages --------------------------------------------------
// Root-level pages, glow/ and admin/. The portal has its own shell and its
// own headers and is not the public site.
function publicPages() {
  const pages = [];
  for (const name of readdirSync(REPO)) if (name.endsWith(".html")) pages.push(name);
  for (const dir of ["glow", "admin"]) {
    if (!existsSync(join(REPO, dir))) continue;
    for (const name of readdirSync(join(REPO, dir))) if (name.endsWith(".html")) pages.push(`${dir}/${name}`);
  }
  return pages.sort();
}

// Same-origin stylesheet and script URLs a page links, resolved to
// { urlPath, query, filePath }.
function sameOriginAssets(page) {
  const html = readFileSync(join(REPO, page), "utf8");
  const found = [];
  const tag = /<(link|script)\b[^>]*>/gi;
  let m;
  while ((m = tag.exec(html))) {
    const t = m[0];
    const isCss = /^<link/i.test(t) && /rel\s*=\s*["']stylesheet["']/i.test(t);
    const isJs = /^<script/i.test(t) && /\bsrc\s*=/.test(t);
    if (!isCss && !isJs) continue;
    const attr = /\b(?:href|src)\s*=\s*["']([^"']+)["']/i.exec(t);
    if (!attr) continue;
    const url = new URL(attr[1], `${SITE}/${page}`);
    if (url.origin !== SITE) continue;
    found.push({ page, href: attr[1], urlPath: url.pathname, query: url.searchParams, filePath: join(REPO, url.pathname) });
  }
  return found;
}

function versionOf(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 10);
}

// ---- the parser itself (so a wrong parser cannot make the rest pass) ------
test("F4-C parser: all matching rules apply, `!` detaches earlier values, later lines re-add", () => {
  const sample = parseHeaders([
    "/*",
    "  X-A: one",
    "/assets/*",
    "  Cache-Control: immutable",
    "/assets/x.css",
    "  Cache-Control: revalidate",
    "/assets/y.css",
    "  ! Cache-Control",
    "  Cache-Control: revalidate",
    "/assets/z.css",
    "  Cache-Control: revalidate",
    "  ! Cache-Control",
  ].join("\n"));
  assert.deepEqual(headersFor(sample, "/assets/x.css")["cache-control"], ["immutable", "revalidate"], "no detach: both apply");
  assert.deepEqual(headersFor(sample, "/assets/y.css")["cache-control"], ["revalidate"], "detach then set: one value");
  assert.equal(headersFor(sample, "/assets/z.css")["cache-control"], undefined, "detach after set removes it");
  assert.deepEqual(headersFor(sample, "/assets/y.css")["x-a"], ["one"], "unrelated header is untouched");
  assert.deepEqual(headersFor(sample, "/other"), { "x-a": ["one"] });
});

// ---- the real _headers and the real pages -----------------------------------
test("F4-C: /assets/styles.css carries exactly one Cache-Control and it is not immutable", () => {
  const cc = headersFor(rules, "/assets/styles.css")["cache-control"] || [];
  assert.equal(cc.length, 1, `expected exactly one Cache-Control for /assets/styles.css, got ${cc.length}: ${JSON.stringify(cc)}`);
  assert.ok(!/immutable/i.test(cc[0]), `/assets/styles.css must not be immutable, got: ${cc[0]}`);
  assert.match(cc[0], /max-age=0/, `/assets/styles.css must revalidate, got: ${cc[0]}`);
});

test("F4-C: other /assets/ files keep the long immutable cache (they are renamed when they change)", () => {
  const cc = headersFor(rules, "/assets/hero/hero.webp")["cache-control"] || [];
  assert.equal(cc.length, 1, `expected one Cache-Control, got ${JSON.stringify(cc)}`);
  assert.match(cc[0], /immutable/);
});

test("F4-C: every public page links the stylesheet with ?v= equal to the file's sha256 prefix", () => {
  const want = versionOf(join(REPO, "assets/styles.css"));
  const pages = publicPages();
  let linked = 0;
  for (const page of pages) {
    for (const a of sameOriginAssets(page).filter((x) => x.urlPath === "/assets/styles.css")) {
      linked++;
      assert.equal(a.query.get("v"), want, `${page} links ${a.href}; expected ?v=${want} (run: node scripts/stamp-css.mjs)`);
    }
  }
  assert.ok(linked >= 6, `expected the stylesheet linked from at least 6 public pages, found ${linked}`);
});

test("F4-C: every same-origin CSS/JS a public page links is content-versioned or not served immutable", () => {
  for (const page of publicPages()) {
    for (const a of sameOriginAssets(page)) {
      const cc = (headersFor(rules, a.urlPath)["cache-control"] || []).join(", ");
      if (!/immutable/i.test(cc)) continue;
      assert.ok(existsSync(a.filePath) && statSync(a.filePath).isFile(), `${page} links ${a.href}, which is not a file in this repo`);
      assert.equal(
        a.query.get("v"),
        versionOf(a.filePath),
        `${page} links ${a.href}, served with "${cc}" but not content-versioned (?v=<sha256 first 10>)`,
      );
    }
  }
});

// Cloudflare joins every matching rule's value into one comma-separated header,
// so two rules that both set the same header name on one path send a merged
// value (INT2: /portal/* sent two Referrer-Policy values, /portal/*.html and /portal/sw.js two
// Cache-Control values). No path may end up with more than one value of any header.
test("INT2: no header name carries more than one value on any representative path", () => {
  const paths = [
    "/", "/index.html", "/register", "/register.html", "/glow", "/glow.html", "/gallery.html",
    "/assets/styles.css", "/assets/hero/hero.webp",
    "/portal/", "/portal/index.html", "/portal/views/member-home.html", "/portal/sw.js", "/portal/portal.css", "/api/portal/me",
  ];
  for (const path of paths) {
    for (const [name, values] of Object.entries(headersFor(rules, path))) {
      assert.equal(values.length, 1, `${path} would send ${name} with ${values.length} merged values: ${JSON.stringify(values)}`);
    }
  }
});
