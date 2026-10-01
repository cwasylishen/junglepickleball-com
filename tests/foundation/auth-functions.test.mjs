// CTL-AUTH-07 and CTL-ROLE-01: both are pure-function table tests --
// controls.md §3.2 describes their own probes this way (a normalised
// rate-limit key; an owner-match table), with no DB or HTTP involved.
// RED for each is named inline: the naive implementation it replaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmailRateLimitKey } from "../../src/portal/auth.js";
import { isOwnerEmail } from "../../src/portal/entitlement.js";
import { stripPrivilegedFields } from "../../src/portal/authz.js";

test("CTL-AUTH-07: +tag and Gmail dots normalise to the same rate-limit key", () => {
  const variants = ["a@gmail.com", "a+1@gmail.com", "a.@gmail.com", "a+2@gmail.com", "a.+3@gmail.com", "a+4@gmail.com"];
  const keys = variants.map(normalizeEmailRateLimitKey);
  // RED: a plain string-keyed (non-normalising) implementation would
  // give 6 distinct keys here, so the 6th login-start would never be
  // limited. GREEN is that they all collapse to one key.
  assert.equal(new Set(keys).size, 1, `expected one key, got: ${keys.join(", ")}`);
  // A non-Gmail domain never strips dots (only +tag, every domain).
  assert.equal(normalizeEmailRateLimitKey("a.b+x@example.com"), "a.b@example.com");
});

test("CTL-ROLE-01: owner match is exact, ASCII, trimmed/lowercased -- no substring or Unicode fold", () => {
  const list = " Roger@x.com , ,";
  // RED: an `includes()`/substring-based matcher would wrongly accept
  // the look-alikes below (that is the exact mutation named in
  // controls.md's probe).
  assert.equal(isOwnerEmail("roger@x.com", list), true);
  assert.equal(isOwnerEmail("ROGER@X.COM", list), true);
  assert.equal(isOwnerEmail("roger@x.com.evil.com", list), false);
  assert.equal(isOwnerEmail("xroger@x.com", list), false);
  assert.equal(isOwnerEmail("rкger@x.com", list), false); // Cyrillic о look-alike
  assert.equal(isOwnerEmail("", list), false);
});

test("CTL-AUTHZ-03: the write helper strips every privileged field, keeping only what the caller allowed", () => {
  const input = { display_name: "A", role: "owner", is_demo: 1, email: "x@y.z", credits: 99, stripe_customer_id: "cus_x" };
  // RED: an `Object.assign`/spread-onto-row implementation would carry
  // every one of these through untouched.
  const safe = stripPrivilegedFields(input);
  assert.deepEqual(safe, { display_name: "A" });
});
