// Gate: assets/styles.css must never lose a rule that production already
// serves. tests/fixtures/styles-live-8c90a66d.css is the stylesheet that was
// live on junglepickleball.com at production version 8c90a66d (commit
// 7b42600, Glow v3), fetched on 2026-10-05. Every rule in it, keyed by its
// enclosing at-rule and its selector, must exist in the built stylesheet.
//
// Why: Tailwind builds assets/styles.css by purging every class no scanned
// file mentions. A page or script missing from tailwind.config.js `content`
// silently loses its classes on the next `npm run build`. This test turns that
// into a red build instead of a broken page.
//
// It is a floor, not a ceiling: new rules may be added freely. When a rule is
// removed on purpose (a class nobody uses any more), refresh the fixture from
// the live site in the same commit and say so in the message.
//
// No server is needed; this file only reads two CSS files. JP_STYLES_UNDER_TEST
// points the test at another stylesheet, for showing it go red against a
// known-bad file. The default is the built assets/styles.css.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = resolve(ROOT, "tests/fixtures/styles-live-8c90a66d.css");
const BUILT_PATH = process.env.JP_STYLES_UNDER_TEST || resolve(ROOT, "assets/styles.css");

// Split a stylesheet into a flat set of keys. A key is the selector, prefixed
// by the at-rule it sits in when there is one: "@media (min-width:640px) | .sm\:flex".
// A rule that moves out of its media query is therefore reported as missing.
// Declarations are not compared, only that the rule exists.
export function ruleKeys(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const keys = new Set();
  parseBlock(text, 0, "", keys);
  return keys;
}

// Reads rules from `start` until the matching close brace (or end of text) and
// returns the index it stopped at. Braces inside quoted strings are skipped.
function parseBlock(text, start, atRule, keys) {
  let i = start;
  let prelude = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) throw new Error(`unterminated string at offset ${i}: ${text.slice(i, i + 40)}`);
      prelude += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "{") {
      const head = prelude.trim();
      prelude = "";
      if (head.startsWith("@keyframes") || head.startsWith("@font-face") || head.startsWith("@page")) {
        keys.add(`${atRule}${head}`);
        i = skipBlock(text, i + 1);
      } else if (head.startsWith("@")) {
        keys.add(`${atRule}${head}`);
        i = parseBlock(text, i + 1, `${atRule}${head} | `, keys) + 1;
      } else {
        for (const selector of splitSelectors(head)) keys.add(`${atRule}${selector}`);
        i = skipBlock(text, i + 1);
      }
    } else if (ch === "}") {
      return i;
    } else if (ch === ";") {
      prelude = ""; // a statement such as @import or @charset
      i += 1;
    } else {
      prelude += ch;
      i += 1;
    }
  }
  return i;
}

function skipBlock(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    i += 1;
  }
  return i;
}

function splitSelectors(head) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of head) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

export function missingKeys(baselineCss, builtCss) {
  const built = ruleKeys(builtCss);
  return [...ruleKeys(baselineCss)].filter((key) => !built.has(key));
}

test("styles-superset: the extractor reads selector lists, media queries and keyframes", () => {
  const css = `a,.b:hover{x:1}@media (min-width:640px){.sm\\:flex{display:flex}.c,.d{y:2}}@keyframes spin{to{z:3}}.e{content:"}{"}`;
  assert.deepEqual([...ruleKeys(css)].sort(), [
    "@keyframes spin",
    "@media (min-width:640px) | .c",
    "@media (min-width:640px) | .d",
    "@media (min-width:640px) | .sm\\:flex",
    "@media (min-width:640px)",
    ".b:hover",
    ".e",
    "a",
  ].sort());
});

test("styles-superset: a dropped rule is reported, an added rule is not", () => {
  const baseline = ".a{x:1}.b{x:2}@media (min-width:640px){.sm\\:c{x:3}}";
  assert.deepEqual(missingKeys(baseline, ".a{x:1}.new{x:9}@media (min-width:640px){.sm\\:c{x:3}}"), [".b"]);
  assert.deepEqual(missingKeys(baseline, ".a{x:1}.b{x:2}.sm\\:c{x:3}"), ["@media (min-width:640px)", "@media (min-width:640px) | .sm\\:c"]);
  assert.deepEqual(missingKeys(baseline, baseline + ".more{x:4}"), []);
});

test("styles-superset: the baseline is the live stylesheet and is not trivially small", () => {
  const keys = ruleKeys(readFileSync(BASELINE_PATH, "utf8"));
  assert.ok(keys.size > 400, `baseline ${BASELINE_PATH} has only ${keys.size} rules; was the fixture truncated?`);
});

test("styles-superset: every rule live at 8c90a66d is still in the built stylesheet", () => {
  const baseline = readFileSync(BASELINE_PATH, "utf8");
  const built = readFileSync(BUILT_PATH, "utf8");
  const missing = missingKeys(baseline, built);
  assert.deepEqual(
    missing,
    [],
    `${BUILT_PATH} lost ${missing.length} rule(s) that production serves: ${missing.join("  ;  ")}. ` +
      `A page or script that uses these classes is not listed in tailwind.config.js content, or a class was removed on purpose ` +
      `(then refresh tests/fixtures/styles-live-8c90a66d.css from the live site in the same commit).`,
  );
});
