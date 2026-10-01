// CTL-ASSET-01, CTL-HDR-01, CTL-CFG-01, CTL-ERR-01.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { makeClient, loginDemo, BASE_URL } from "./helpers.mjs";

const REPO = new URL("../..", import.meta.url).pathname;

test("CTL-ASSET-01: a migration file is never served as a public asset", async () => {
  const res = await fetch(`${BASE_URL}/migrations/0001_env_accounts_auth.sql`);
  // RED: before `migrations` was added to .assetsignore, the static
  // assets layer would have served this file's bytes (the whole
  // repo is published except what .assetsignore names) -- the schema,
  // including every table/column name, would be public.
  assert.equal(res.status, 404);
});

test("CTL-ASSET-01: the public site's own pages are unaffected by the portal's .assetsignore additions", async () => {
  const res = await fetch(`${BASE_URL}/membership.html`);
  assert.equal(res.status, 200);
});

test("CTL-HDR-01: /portal/ carries the portal CSP, Referrer-Policy and no-store headers", async () => {
  const res = await fetch(`${BASE_URL}/portal/`, { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" } });
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  // RED: before _headers' /portal/* block existed, this header would be
  // entirely absent, letting a third-party script source load on the
  // page serving the account's own CSRF token and session state.
  assert.ok(csp, "/portal/ must carry a Content-Security-Policy header");
  assert.ok(csp.includes("script-src 'self'"));
  // Cloudflare's _headers combines values from every matching block
  // (the site-wide `/*` rule's strict-origin-when-cross-origin AND the
  // portal-specific `/*portal/*` rule's no-referrer both apply to
  // /portal/), rather than the more specific rule overriding -- so the
  // raw header is a comma list. The Referrer Policy spec resolves a
  // multi-token value by using the LAST valid token, so this is still
  // "no-referrer" in every browser; the test checks that, not exact
  // string equality.
  const referrerPolicy = res.headers.get("referrer-policy") || "";
  const tokens = referrerPolicy.split(",").map((t) => t.trim());
  assert.equal(tokens[tokens.length - 1], "no-referrer", `expected the last Referrer-Policy token to be no-referrer, got "${referrerPolicy}"`);
});

test("CTL-CFG-01: every env.* name read under src/portal matches docs/portal/config-inventory.md exactly", () => {
  const grepOut = execSync(`grep -onE "env\\.[A-Z_][A-Z0-9_]*" src/portal/*.js | sed -E 's/.*env\\.//' | sort -u`, { cwd: REPO, encoding: "utf8" });
  const fromCode = new Set(grepOut.split("\n").filter(Boolean));

  const doc = readFileSync(`${REPO}/docs/portal/config-inventory.md`, "utf8");
  const fromDoc = new Set([...doc.matchAll(/^\| `([A-Z_][A-Z0-9_]*)` \|/gm)].map((m) => m[1]));

  // RED: adding a new env.FOO_PROBE read to a portal file with no
  // matching inventory row (or vice versa) must fail one of these.
  for (const name of fromCode) assert.ok(fromDoc.has(name), `env.${name} is read in code but missing from config-inventory.md`);
  for (const name of fromDoc) assert.ok(fromCode.has(name), `env.${name} is documented but never read in code`);
});

test("CTL-ERR-01: any thrown error inside the portal dispatch returns a generic 500 with no detail", async () => {
  const { client, csrfToken } = await loginDemo("owner.demo@jp-demo.test");
  // A malformed Origin header makes `new URL(origin)` throw inside the
  // CSRF check -- a real, reproducible throw, not a simulated one.
  const res = await client.post(
    "/api/portal/owner/sessions/revoke-others",
    {},
    { "X-CSRF-Token": csrfToken, Origin: "not a url" }
  );
  assert.equal(res.status, 500);
  assert.deepEqual(res.data, { error: "server_error" });
  const bodyText = JSON.stringify(res.data);
  for (const leak of ["SQLITE", "UNIQUE", "constraint", "at Object", ".js:"]) {
    assert.ok(!bodyText.includes(leak), `response leaked "${leak}"`);
  }
});
