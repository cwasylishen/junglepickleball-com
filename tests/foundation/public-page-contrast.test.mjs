// F14 / D-V13b-1: no text on any public page fails WCAG AA colour contrast.
//
// The pre-deploy check of F13 ran axe on all nine public pages and found
// /membership-cancel's "Checkout Canceled" eyebrow at 2.80:1 (text-yellow-600
// on slate-50). F13's own test measured footers only, so a page with no
// footer was never looked at. This test is the whole page: axe-core's
// `color-contrast` rule over every public HTML page at a phone width (390)
// and a desktop width (1280). Zero violations.
//
// The page list is DERIVED, not typed: the served HTML files are read from
// the `.assetsignore` allow-list (the same list that decides what the Worker
// publishes) and the disk. A new public page is therefore measured the day it
// is added, with no edit here. `404.html` is not reached by its file name; it
// is the page served for a path that does not exist, so it is measured at one.
//
// Not covered, by name: /portal/ is the signed-in app (its own headless
// tests walk it); its views/ are fragments, and portal/src is private.
//
// Tooling: puppeteer-core from NODE_PATH (NODE_PATH=/home/mike/wzq/node_modules)
// and axe-core. axe-core is NOT in the project tree or in the wzq tree; it is
// loaded from, in order: $AXE_CORE_PATH (a path to axe.min.js), an
// axe-core/axe.min.js under any NODE_PATH root, then the global Lighthouse
// install (/home/mike/.npm-global/lib/node_modules/lighthouse/node_modules).
// The test skips, not red, if puppeteer or axe is missing -- the same rule the
// other headless tests follow. axe is injected with Runtime.evaluate, so the
// page's own Content-Security-Policy is NOT bypassed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL } from "./helpers.mjs";
import { loadPuppeteer, withBrowser } from "./portal-nav-probe.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WIDTHS = [390, 1280];
// The signed-in app: not a public page (see the header).
const NOT_PUBLIC_PAGES = ["portal"];
const NOT_FOUND_PROBE = "/this-page-does-not-exist-contrast-probe";
const LIGHTHOUSE_AXE = "/home/mike/.npm-global/lib/node_modules/lighthouse/node_modules/axe-core/axe.min.js";

// ---- the page list ----------------------------------------------------------

// `.assetsignore` text -> the files and top-level directories it hands back
// with a `!` line. Anything else (the `*` refusal, comments, refusals of
// private paths) is not a served entry.
export function parseAllowList(text) {
  const files = [];
  const dirs = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("!/")) continue;
    const entry = line.slice(2);
    if (entry.endsWith("/*")) continue; // the children of a directory entry already listed
    if (entry.includes("/")) continue; // a nested entry belongs to its top-level directory
    if (entry.endsWith(".html")) files.push(entry);
    else if (!entry.includes(".")) dirs.push(entry);
  }
  return { files, dirs };
}

// A served HTML file (path relative to the site root) -> the URL it answers at.
export function routeFor(file) {
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html")) return `/${file.slice(0, -"index.html".length)}`;
  return `/${file.slice(0, -".html".length)}`;
}

function htmlFilesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...htmlFilesUnder(rel));
    else if (entry.name.endsWith(".html")) found.push(rel);
  }
  return found;
}

// Every public page as { route, label, expectStatus }.
export function publicPages(assetsignoreText) {
  const { files, dirs } = parseAllowList(assetsignoreText);
  const served = [...files];
  for (const dir of dirs) {
    if (NOT_PUBLIC_PAGES.includes(dir)) continue;
    served.push(...htmlFilesUnder(dir));
  }
  const pages = [];
  for (const file of [...new Set(served)].sort()) {
    if (file === "404.html") pages.push({ route: NOT_FOUND_PROBE, label: "404 page", expectStatus: 404 });
    else pages.push({ route: routeFor(file), label: file, expectStatus: 200 });
  }
  return pages;
}

const pages = publicPages(fs.readFileSync(path.join(REPO_ROOT, ".assetsignore"), "utf8"));

// ---- the list-reading is itself tested, so an empty or wrong list cannot pass ---

test("F14 page list: the allow-list parser reads files and directories, and nothing else", () => {
  const text = [
    "# comment",
    "*",
    "!/index.html",
    "!/404.html",
    "!/robots.txt",
    "!/_headers_not_negated.txt",
    "!/assets",
    "!/assets/*",
    "!/assets/events",
    "!/glow",
    "!/glow/*",
    "/portal/src",
    "!/portal",
  ].join("\n");
  assert.deepEqual(parseAllowList(text), { files: ["index.html", "404.html"], dirs: ["assets", "glow", "portal"] });
  assert.deepEqual(
    ["index.html", "gallery.html", "glow/list.html", "admin/index.html"].map(routeFor),
    ["/", "/gallery", "/glow/list", "/admin/"]
  );
});

test("F14 page list: the derived list is the public site, the 404 probe included, and not the portal", () => {
  const routes = pages.map((p) => p.route);
  for (const must of ["/", "/gallery", "/register", "/glow", "/glow/list", "/membership", "/membership-success", "/membership-cancel", "/admin/", NOT_FOUND_PROBE]) {
    assert.ok(routes.includes(must), `derived page list is missing ${must}: ${routes.join(" ")}`);
  }
  assert.ok(!routes.some((r) => r.startsWith("/portal")), `the portal is not a public page: ${routes.join(" ")}`);
  // Every HTML file in the site root is either on the list or deliberately private.
  const onDisk = fs.readdirSync(REPO_ROOT).filter((f) => f.endsWith(".html"));
  const listed = parseAllowList(fs.readFileSync(path.join(REPO_ROOT, ".assetsignore"), "utf8")).files;
  assert.deepEqual(onDisk.filter((f) => !listed.includes(f)), [], "a root HTML file is not on the allow-list, so it is not a served page");
});

// ---- the measurement --------------------------------------------------------

function findAxeSource() {
  const candidates = [process.env.AXE_CORE_PATH, ...(process.env.NODE_PATH || "").split(":").filter(Boolean).map((r) => `${r}/axe-core/axe.min.js`), LIGHTHOUSE_AXE];
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return { file, source: fs.readFileSync(file, "utf8") };
  }
  return null;
}

// Runs in the page: axe's colour-contrast rule, reduced to plain data.
async function runContrast() {
  const result = await axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
  const rows = (list) =>
    list.flatMap((rule) =>
      rule.nodes.map((n) => {
        const d = (n.any[0] && n.any[0].data) || {};
        return {
          target: n.target.join(" "),
          html: n.html.slice(0, 120),
          fg: d.fgColor,
          bg: d.bgColor,
          ratio: d.contrastRatio,
          needs: d.expectedContrastRatio,
          fontSize: d.fontSize,
        };
      })
    );
  return { version: axe.version, violations: rows(result.violations), incomplete: rows(result.incomplete), passes: result.passes.reduce((s, r) => s + r.nodes.length, 0) };
}

for (const width of WIDTHS) {
  test(`F14 whole-page contrast at ${width}: axe color-contrast finds 0 violations on every public page`, { timeout: 170000 }, async (t) => {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");
    const axeLib = findAxeSource();
    if (!axeLib) return t.skip("axe-core not found: set AXE_CORE_PATH to an axe.min.js, or put axe-core on NODE_PATH");
    await withBrowser(puppeteer, async (browser) => {
      const problems = [];
      const report = [`axe-core from ${axeLib.file}`];
      for (const { route, label, expectStatus } of pages) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 800 });
          const res = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded" });
          const status = res.status();
          if (status !== expectStatus) problems.push(`${route}@${width} (${label}): answered ${status}, expected ${expectStatus}, so the page measured is not the page meant`);
          // Own stylesheets applied, web fonts settled, then measure.
          await page.waitForFunction(() => [...document.querySelectorAll('link[rel="stylesheet"][href^="/"]')].every((l) => l.sheet), { timeout: 30000 });
          await page.evaluate(() => document.fonts && document.fonts.ready);
          await page.evaluate(axeLib.source);
          const out = await page.evaluate(runContrast);
          report.push(`${route}@${width} (${label}) axe ${out.version}: ${out.violations.length} violations, ${out.incomplete.length} incomplete, ${out.passes} passing nodes`);
          for (const v of out.violations) {
            problems.push(`${route}@${width} (${label}): ${v.target} is ${v.ratio}:1, needs ${v.needs} (${v.fg} on ${v.bg}, ${v.fontSize}) -- ${v.html}`);
          }
        } finally {
          await page.close();
        }
      }
      console.log(report.join("\n"));
      assert.deepEqual(problems, []);
    });
  });
}
