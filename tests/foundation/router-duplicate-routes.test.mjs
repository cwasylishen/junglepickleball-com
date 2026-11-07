// B1-fix (amendment 6): "B2 parts append to ROUTES in router.js" put
// several agents' edits on one shared file at once. The fix is one
// route file per part (src/portal/routes/*.js), concatenated once by
// assembleRoutes() in router.js, which must refuse outright if two
// files ever claim the same method+path rather than letting the later
// one silently shadow the earlier one.
//
// Pure function test of assembleRoutes() itself (no HTTP surface).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRoutes } from "../../src/portal/router.js";

test("RED: two route files claiming the same method+path throws, naming both files", () => {
  const sources = [
    { name: "routes/booking.js", routes: [{ method: "GET", path: "/api/portal/bookings", class: "own" }] },
    { name: "routes/owner.js", routes: [{ method: "GET", path: "/api/portal/bookings", class: "owner" }] },
  ];
  assert.throws(
    () => assembleRoutes(sources),
    (err) => {
      assert.match(err.message, /GET \/api\/portal\/bookings/);
      assert.match(err.message, /routes\/booking\.js/);
      assert.match(err.message, /routes\/owner\.js/);
      return true;
    }
  );
});

test("GREEN: distinct method+path pairs across files assemble into one table in order", () => {
  const sources = [
    { name: "router.js (B1)", routes: [{ method: "GET", path: "/api/portal/me", class: "own" }] },
    { name: "routes/booking.js", routes: [{ method: "GET", path: "/api/portal/bookings", class: "own" }] },
    { name: "routes/owner.js", routes: [{ method: "DELETE", path: "/api/portal/owner/accounts/:id", class: "owner" }] },
  ];
  const all = assembleRoutes(sources);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.path), ["/api/portal/me", "/api/portal/bookings", "/api/portal/owner/accounts/:id"]);
});

test("the same method on a different path from two files is not a duplicate", () => {
  const sources = [
    { name: "routes/a.js", routes: [{ method: "GET", path: "/api/portal/a", class: "own" }] },
    { name: "routes/b.js", routes: [{ method: "GET", path: "/api/portal/b", class: "own" }] },
  ];
  assert.doesNotThrow(() => assembleRoutes(sources));
});
