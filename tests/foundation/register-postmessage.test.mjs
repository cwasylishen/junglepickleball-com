/* Registration acceptance. The public registration page must send a new
 * customer to the existing member portal account flow, not an external
 * booking embed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(REPO, "register.html"), "utf8");
const headers = fs.readFileSync(path.join(REPO, "_headers"), "utf8");

function headersFor(urlPath) {
  const lines = headers.split("\n");
  const start = lines.findIndex((line) => line === urlPath);
  assert.notEqual(start, -1, `_headers has no rule for ${urlPath}`);
  const result = {};
  for (let i = start + 1; i < lines.length && lines[i].startsWith("  "); i += 1) {
    const [name, ...rest] = lines[i].trim().split(":");
    result[name] = rest.join(":").trim();
  }
  return result;
}

function inlineScripts(source) {
  return [...source.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

test("register uses the existing member portal sign-up path", () => {
  assert.doesNotMatch(html, /courtreserve/i);
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.match(html, /href=["']\/portal\/["']/);
  assert.match(html, /Create your account in the member portal/);
  assert.match(html, /one-time sign-in link/);
});

test("registration headers no longer allow the removed booking frame", () => {
  for (const urlPath of ["/register", "/register.html"]) {
    const rule = headersFor(urlPath);
    assert.equal(rule["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
    assert.ok(rule["Content-Security-Policy"]);
    assert.doesNotMatch(rule["Content-Security-Policy"], /courtreserve|frame-src/i);
  }
});

test("registration inline script hashes match the served policy", () => {
  const policy = headersFor("/register")["Content-Security-Policy"];
  const allowed = [...policy.matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)].map((match) => match[0]).sort();
  const actual = inlineScripts(html).map((script) => `'sha256-${crypto.createHash("sha256").update(script, "utf8").digest("base64")}'`).sort();
  assert.deepEqual(allowed, actual);
  assert.deepEqual(headersFor("/register.html"), headersFor("/register"));
});
