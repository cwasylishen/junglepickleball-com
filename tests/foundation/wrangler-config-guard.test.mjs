// F9: a deploy must be fully config-driven. wrangler 4.111 turned production
// Preview URLs back ON from a plain `wrangler deploy` whose config omitted
// `preview_urls` ("Because your 'workers.dev' route is enabled and your
// 'preview_urls' setting is not in your Wrangler file, Preview URLs will be
// enabled"), and a cron left on a version with no scheduled() fired failed
// invocations. These tests pin the script-level settings in wrangler.toml so
// neither can come back by omission:
//   1. preview_urls is present and false
//   2. workers_dev is present and an explicit boolean (true: matches live)
//   3. both custom domains are declared, custom_domain = true
//   4. crons present and non-empty, and crons => src/worker.js has scheduled()
//   5. PORTAL_DB is the production D1; the preview D1 is bound nowhere
//
// Reader: wrangler.toml is read by the small line-based reader below. No TOML
// parser is installed in this tree (wrangler bundles its own, not importable),
// and this seat adds no dependencies. The reader covers exactly the TOML this
// file uses (comments, tables, array-of-tables, strings, booleans, numbers,
// inline tables, arrays, multi-line arrays) and THROWS on anything else, so an
// unrecognised construct is a red test, never a silently skipped line. Its own
// tests (last block) keep a wrong reader from passing the rest.
//
// WRANGLER_TOML_PATH points the guard at another file (used to show it red on
// a scratch copy). Unset, it reads the repo's wrangler.toml.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PROD_PORTAL_D1 = "d7daeb61-9843-4fa5-86a2-a3134e777ea7";
const PREVIEW_PORTAL_D1_PREFIX = "ca34a6c4";
const CUSTOM_DOMAINS = ["junglepickleball.com", "www.junglepickleball.com"];

// ---------- minimal TOML reader ----------

// Remove a trailing "# comment", ignoring a # inside a quoted string.
function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inString) {
      i++;
    } else if (ch === '"') {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Net open brackets/braces outside strings, to join a multi-line array.
function bracketDepth(text) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && inString) i++;
    else if (ch === '"') inString = !inString;
    else if (!inString && (ch === "[" || ch === "{")) depth++;
    else if (!inString && (ch === "]" || ch === "}")) depth--;
  }
  return depth;
}

// Parse one value at the start of `text`; returns { value, rest }.
function parseValue(text) {
  const s = text.trimStart();
  if (s.startsWith('"')) {
    let i = 1;
    let out = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") {
        out += s[i + 1];
        i += 2;
      } else {
        out += s[i++];
      }
    }
    if (s[i] !== '"') throw new Error(`unterminated string in: ${text}`);
    return { value: out, rest: s.slice(i + 1) };
  }
  if (s.startsWith("[")) {
    const items = [];
    let rest = s.slice(1).trimStart();
    while (!rest.startsWith("]")) {
      const item = parseValue(rest);
      items.push(item.value);
      rest = item.rest.trimStart();
      if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
      else if (!rest.startsWith("]")) throw new Error(`bad array near: ${rest}`);
    }
    return { value: items, rest: rest.slice(1) };
  }
  if (s.startsWith("{")) {
    const obj = {};
    let rest = s.slice(1).trimStart();
    while (!rest.startsWith("}")) {
      const key = /^([A-Za-z0-9_-]+)\s*=\s*/.exec(rest);
      if (!key) throw new Error(`bad inline table near: ${rest}`);
      const item = parseValue(rest.slice(key[0].length));
      obj[key[1]] = item.value;
      rest = item.rest.trimStart();
      if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
      else if (!rest.startsWith("}")) throw new Error(`bad inline table near: ${rest}`);
    }
    return { value: obj, rest: rest.slice(1) };
  }
  const bare = /^(true|false|-?\d+(?:\.\d+)?)(?![A-Za-z0-9_])/.exec(s);
  if (bare) {
    const raw = bare[1];
    const value = raw === "true" ? true : raw === "false" ? false : Number(raw);
    return { value, rest: s.slice(raw.length) };
  }
  throw new Error(`unsupported TOML value: ${text}`);
}

export function parseToml(source) {
  const root = {};
  let current = root;
  const lines = source.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    let line = stripComment(lines[n]).trim();
    if (line === "") continue;

    const arrayTable = /^\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]$/.exec(line);
    const table = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
    if (arrayTable) {
      if (!Array.isArray(root[arrayTable[1]])) root[arrayTable[1]] = [];
      current = {};
      root[arrayTable[1]].push(current);
      continue;
    }
    if (table) {
      root[table[1]] = root[table[1]] || {};
      current = root[table[1]];
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`wrangler.toml line ${n + 1} not understood: ${lines[n]}`);
    let valueText = kv[2];
    while (bracketDepth(valueText) > 0) {
      n++;
      if (n >= lines.length) throw new Error(`unclosed value for key ${kv[1]}`);
      valueText += " " + stripComment(lines[n]).trim();
    }
    const parsed = parseValue(valueText);
    if (parsed.rest.trim() !== "") {
      throw new Error(`trailing text after value of ${kv[1]}: ${parsed.rest}`);
    }
    current[kv[1]] = parsed.value;
  }
  return root;
}

// ---------- the rule for crons ----------

// crons => scheduled(): a config with cron triggers needs a scheduled handler;
// a config with none requires nothing. Returns a list of problems (empty = ok).
export function cronProblems(config, handler) {
  const crons = config.triggers && config.triggers.crons;
  if (!Array.isArray(crons) || crons.length === 0) return [];
  if (!handler || typeof handler.scheduled !== "function") {
    return [`crons ${JSON.stringify(crons)} are declared but the default export has no scheduled() handler`];
  }
  return [];
}

// ---------- subject under test ----------

const tomlPath = process.env.WRANGLER_TOML_PATH || new URL("../../wrangler.toml", import.meta.url).pathname;
const config = parseToml(fs.readFileSync(tomlPath, "utf8"));

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

test("WCG-01 preview_urls is declared and false (a deploy must never inherit Preview URLs on)", () => {
  assert.ok(Object.hasOwn(config, "preview_urls"), `preview_urls is missing from ${tomlPath}`);
  assert.strictEqual(config.preview_urls, false);
});

test("WCG-02 workers_dev is declared as an explicit boolean (true: live has workers.dev on)", () => {
  assert.ok(Object.hasOwn(config, "workers_dev"), `workers_dev is missing from ${tomlPath}`);
  assert.strictEqual(typeof config.workers_dev, "boolean");
  assert.strictEqual(config.workers_dev, true);
});

test("WCG-03 both custom domains are declared with custom_domain = true", () => {
  assert.ok(Array.isArray(config.routes), "routes is missing or not an array");
  for (const domain of CUSTOM_DOMAINS) {
    const route = config.routes.find((r) => r.pattern === domain);
    assert.ok(route, `no route for ${domain}`);
    assert.strictEqual(route.custom_domain, true, `route for ${domain} must set custom_domain = true`);
  }
});

test("WCG-04 crons are declared and non-empty", () => {
  assert.ok(config.triggers, "[triggers] is missing");
  assert.ok(Array.isArray(config.triggers.crons), "triggers.crons is missing or not an array");
  assert.ok(config.triggers.crons.length > 0, "triggers.crons is empty");
  for (const cron of config.triggers.crons) {
    assert.equal(typeof cron, "string");
    assert.equal(cron.trim().split(/\s+/).length, 5, `cron expression needs 5 fields: ${cron}`);
  }
});

test("WCG-05 crons imply a scheduled() handler: the real default export has one", async () => {
  const worker = (await import("../../src/worker.js")).default;
  assert.equal(typeof worker.scheduled, "function", "src/worker.js default export has no scheduled()");
  assert.deepEqual(cronProblems(config, worker), []);
});

test("WCG-06 the crons => scheduled() rule: crons without a handler fail, no crons requires nothing", () => {
  const withCrons = { triggers: { crons: ["*/15 * * * *"] } };
  const noCrons = { triggers: { crons: [] } };
  const noTriggers = {};
  const fetchOnly = { fetch() {} };
  const both = { fetch() {}, scheduled() {} };

  assert.equal(cronProblems(withCrons, fetchOnly).length, 1, "crons with no scheduled() must be a problem");
  assert.equal(cronProblems(withCrons, undefined).length, 1);
  assert.deepEqual(cronProblems(withCrons, both), []);
  // The converse: no crons, no requirement.
  assert.deepEqual(cronProblems(noCrons, fetchOnly), []);
  assert.deepEqual(cronProblems(noTriggers, fetchOnly), []);
});

test("WCG-07 PORTAL_DB is the production D1 and the preview D1 is bound nowhere", () => {
  const portal = (config.d1_databases || []).filter((d) => d.binding === "PORTAL_DB");
  assert.equal(portal.length, 1, "exactly one PORTAL_DB binding expected");
  assert.equal(portal[0].database_id, PROD_PORTAL_D1);
  assert.equal(portal[0].database_name, "junglepickleball-portal");

  const mentions = collectStrings(config).filter((s) => s.includes(PREVIEW_PORTAL_D1_PREFIX));
  assert.deepEqual(mentions, [], "a binding references the preview D1 ca34a6c4");
});

// ---------- the reader's own tests ----------

test("WCG-08 reader: comments are ignored, inline tables and multi-line arrays parse, odd input throws", () => {
  const parsed = parseToml(
    [
      "# preview_urls = true",
      'name = "a # not a comment"  # trailing comment',
      "flag = false",
      "routes = [",
      '  { pattern = "x.test", custom_domain = true },',
      "]",
      "# [[d1_databases]]",
      "[triggers]",
      'crons = ["*/15 * * * *"]',
      "[[d1_databases]]",
      'binding = "A"',
      "[[d1_databases]]",
      'binding = "B"',
    ].join("\n"),
  );
  assert.equal(parsed.name, "a # not a comment");
  assert.equal(parsed.flag, false);
  assert.equal("preview_urls" in parsed, false, "a commented-out key must not appear");
  assert.deepEqual(parsed.routes, [{ pattern: "x.test", custom_domain: true }]);
  assert.deepEqual(parsed.triggers.crons, ["*/15 * * * *"]);
  assert.deepEqual(parsed.d1_databases.map((d) => d.binding), ["A", "B"]);
  assert.throws(() => parseToml("not a toml line"), /not understood/);
  assert.throws(() => parseToml("k = 2026-01-01"), /unsupported TOML value|trailing text/);
});
