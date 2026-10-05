// D-R6 (release inspection of 1f0f44a8): Account showed "Build dev" on the
// production site. The portal has no real build id to show, so it shows none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("D-R6: the Account screen has no build label and the script carries no build id", () => {
  assert.doesNotMatch(read("portal/views/account.html"), /account\.version|buildId/);
  const script = read("portal/js/account.js");
  assert.doesNotMatch(script, /account\.version|buildId|Build \{id\}/);
});

test("D-R6: nothing the Account hub renders says Build or dev", () => {
  const strings = {};
  const context = {
    console,
    PortalApp: { mergeStrings: (dict) => Object.assign(strings, dict) },
    PortalAreas: {},
    addEventListener() {},
    location: { hash: "" },
    document: { getElementById: () => null },
    sessionStorage: { getItem: () => "" },
    PortalApi: { get: async () => ({ ok: false }) },
    t: (key) => strings[key] || key,
  };
  context.window = context;
  runInNewContext(`${read("portal/js/account.js")}\nthis.__hub = accountHub;`, context);
  const hub = context.__hub();
  assert.equal("buildId" in hub, false);
  assert.ok(!Object.values(strings).some((text) => /^Build\b/.test(text)), "no 'Build ...' string is defined");
});
