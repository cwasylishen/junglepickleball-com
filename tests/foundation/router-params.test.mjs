// B1-fix (amendment 6): matchRoute used to compare exact paths only,
// so none of docs/portal/api.md's `:id`-shaped routes could ever match
// a real request. This is a pure function test of the matching rule
// (findRoute), the same kind of probe helpers.mjs reserves for
// schema/pure-function controls -- no live route for these contract
// paths exists yet (B2a1/B2a2/B2c own filling in their route files),
// so this exercises the real contract paths against the matcher
// directly rather than over HTTP.
//
// RED, demonstrated by construction: the matcher this replaces
// (`ROUTES.find((r) => r.path === path)`) returns null for every path
// below that contains a `:id`/`:offeringId` segment, and would let a
// literal route (e.g. a future `/owner/accounts/stats`) be shadowed by
// `/owner/accounts/:id` matching first in declaration order. GREEN is
// what this file asserts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findRoute } from "../../src/portal/router.js";

const SAMPLE_ROUTES = [
  { method: "GET", path: "/api/portal/resources/:id/availability", class: "own" },
  { method: "POST", path: "/api/portal/bookings/:id/cancel", class: "own" },
  { method: "DELETE", path: "/api/portal/owner/accounts/:id", class: "owner" },
  // A literal segment at the same position as another route's `:id` --
  // this must win over the param route, never be shadowed by it.
  { method: "GET", path: "/api/portal/owner/accounts/stats", class: "owner" },
  { method: "PATCH", path: "/api/portal/owner/resources/:id/offerings/:offeringId", class: "owner" },
];

test("findRoute: a :id segment matches and is exposed as params.id", () => {
  const match = findRoute(SAMPLE_ROUTES, "GET", "/api/portal/resources/123/availability");
  assert.ok(match, "expected a match for the parameterised availability route");
  assert.equal(match.route.path, "/api/portal/resources/:id/availability");
  assert.equal(match.params.id, "123");
});

test("findRoute: an unknown path matches nothing (still a 404, not a crash)", () => {
  const match = findRoute(SAMPLE_ROUTES, "GET", "/api/portal/not-a-real-route");
  assert.equal(match, null);
});

test("findRoute: a literal segment never loses to a :param at the same position", () => {
  const match = findRoute(SAMPLE_ROUTES, "GET", "/api/portal/owner/accounts/stats");
  assert.ok(match);
  assert.equal(match.route.path, "/api/portal/owner/accounts/stats", "the literal route must win, not /owner/accounts/:id");
  assert.equal(Object.keys(match.params).length, 0);
});

test("findRoute: multiple :param segments in one route all resolve", () => {
  const match = findRoute(SAMPLE_ROUTES, "PATCH", "/api/portal/owner/resources/court-1/offerings/off-9");
  assert.ok(match);
  assert.deepEqual(match.params, { id: "court-1", offeringId: "off-9" });
});

test("findRoute: method mismatch on an otherwise-matching path is still no match", () => {
  const match = findRoute(SAMPLE_ROUTES, "DELETE", "/api/portal/resources/123/availability");
  assert.equal(match, null);
});
