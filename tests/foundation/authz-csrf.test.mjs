// CTL-AUTHZ-01 (route classing) and CTL-CSRF-01 (exact exemption list,
// swept from the router's own live table, never a hand list).
//
// B1 ships no id-taking "own" route yet (booking/owner-detail routes are
// B2a1/B2a2's). The id-ownership half of CTL-AUTHZ-01's probe ("member
// calls every id route with member2's ids") has nothing to sweep until
// those land -- QA2/B2a inherit that half. What B1 can and does prove
// now: an unclassed route is refused, and the CSRF sweep is generated
// from the real route table, not a hand-maintained list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../../src/portal/authz.js";
import { routeTable } from "../../src/portal/router.js";
import { CSRF_EXEMPT_ROUTES } from "../../src/portal/auth.js";
import { makeClient, loginDemo, BASE_URL } from "./helpers.mjs";

test("CTL-AUTHZ-01: an unclassed route is refused, not served", () => {
  // RED: a router that defaults an unknown class to "public" (the
  // permissive mistake this control exists to rule out) would return ok.
  const result = authorize("some_future_class_nobody_registered", null, null);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, "route_unclassed");
});

test("CTL-CSRF-01: every non-GET /api/portal/* route, swept from the live table, requires the CSRF token except the exact 4-route exemption list", async () => {
  const table = routeTable();
  assert.ok(table.length > 0, "the route table must not be empty");

  const { client, csrfToken } = await loginDemo("owner.demo@jp-demo.test");
  let checked = 0;
  for (const route of table) {
    if (route.method === "GET") continue;
    const key = `${route.method} ${route.path}`;
    checked++;
    // Call with a session but NO X-CSRF-Token and no Origin.
    const res = await client.post(route.path, {});
    if (CSRF_EXEMPT_ROUTES.has(key)) {
      // Exempt routes are Origin-checked instead; with no Origin at all
      // they must still be refused, just with a different reason.
      assert.notEqual(res.status, 200, `${key} is CSRF-exempt but must still require Origin`);
    } else {
      // RED: a prefix-exemption mutation (e.g. exempting the whole
      // /api/portal/auth/ prefix) would let logout through here.
      assert.equal(res.status, 403, `${key} must require X-CSRF-Token`);
      assert.equal(res.data.error, "csrf_required");
    }
  }
  assert.ok(checked >= 2, "expected at least logout and revoke-others to be swept");

  // And the positive case: the same route succeeds with the token + Origin.
  const ok = await client.post("/api/portal/owner/sessions/revoke-others", {}, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
  assert.equal(ok.status, 200);
});

test("CTL-CSRF-01: the exemption list is exactly 4 routes, matching src/portal/auth.js", () => {
  assert.equal(CSRF_EXEMPT_ROUTES.size, 4);
});
