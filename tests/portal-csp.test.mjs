// D-R2 (release inspection of 1f0f44a8): on the production host Cloudflare
// adds its Web Analytics beacon to HTML. The portal CSP refused it (a console
// error on every load, and no measurement). The CSP now allows exactly that
// beacon, and nothing else, without ever allowing inline script.
//
// The CSP lives in two places that must say the same thing: _headers
// (static /portal/ files) and PORTAL_HTML_HEADERS (Worker responses).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PORTAL_HTML_HEADERS } from "../src/portal/http.js";

function headersFileCsp() {
  const text = readFileSync(new URL("../_headers", import.meta.url), "utf8");
  const block = text.split("\n/portal/*\n")[1].split(/\n\S/)[0];
  const line = block.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  return line.trim().slice("Content-Security-Policy:".length).trim();
}

function directives(csp) {
  const out = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

const fromFile = headersFileCsp();
const fromWorker = PORTAL_HTML_HEADERS["Content-Security-Policy"];

test("D-R2: _headers and the Worker say the same CSP", () => {
  assert.equal(fromFile, fromWorker);
});

for (const [where, csp] of [["_headers", fromFile], ["http.js", fromWorker]]) {
  test(`D-R2: ${where} lets the Cloudflare Web Analytics beacon load and report`, () => {
    const d = directives(csp);
    assert.ok(d["script-src"].includes("https://static.cloudflareinsights.com"), "beacon script origin missing from script-src");
    assert.ok(d["connect-src"].includes("https://cloudflareinsights.com"), "beacon report origin missing from connect-src");
  });

  test(`D-R2: ${where} never allows inline script, and allows no other outside origin`, () => {
    const d = directives(csp);
    assert.ok(!d["script-src"].includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline'");
    assert.ok(!d["script-src"].some((v) => /^'(nonce|sha\d+)-/.test(v)), "no hash or nonce: the edge's inline script changes on every request");
    const outside = Object.entries(d).flatMap(([name, values]) => values.filter((v) => /^https?:/.test(v)).map((v) => `${name} ${v}`));
    assert.deepEqual(outside.sort(), ["connect-src https://cloudflareinsights.com", "script-src https://static.cloudflareinsights.com"]);
    assert.deepEqual(d["default-src"], ["'self'"]);
  });
}
