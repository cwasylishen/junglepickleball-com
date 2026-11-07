// REQ-PWA-01/07/08/09, CTL-PSH-02 (black-box HTTP, PIN-16). The shared
// :8799 harness never sets VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (see
// scripts/test.sh), so every push route here is exercised in its
// not-configured state -- REQ-PWA-09's own acceptance test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginDemo, BASE_URL } from "./helpers.mjs";

// Explicit per-test timeout (same practice as push-cron.test.mjs):
// scripts/test.sh's --test-timeout=60000 already covers a full-suite
// run, but a targeted run of this file alone (no flag) must not be
// able to hang forever on a dropped connection either.
const TEST_TIMEOUT_MS = 20000;

test(
  "REQ-PWA-01: /portal/manifest.webmanifest serves scope /portal/ with the manifest content type",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const res = await fetch(`${BASE_URL}/portal/manifest.webmanifest`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type") || "";
    assert.ok(contentType.includes("manifest+json") || contentType.includes("json"), `unexpected content-type: ${contentType}`);
    const manifest = await res.json();
    assert.equal(manifest.scope, "/portal/");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.theme_color, "#0f393b");
    assert.ok(manifest.icons.some((i) => i.sizes === "192x192"));
    assert.ok(manifest.icons.some((i) => i.sizes === "512x512"));
  }
);

test(
  "REQ-PWA-02: /portal/sw.js is served (registration target exists)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const res = await fetch(`${BASE_URL}/portal/sw.js`);
    assert.equal(res.status, 200);
  }
);

test(
  "REQ-PWA-09: with VAPID unset, the public-key route and subscribe both answer not_configured",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { client, csrfToken } = await loginDemo("member.demo@jp-demo.test");

    const key = await client.get("/api/portal/push/vapid-public-key");
    assert.equal(key.status, 503);
    assert.deepEqual(key.data, { error: "not_configured", feature: "push" });

    const sub = await client.post(
      "/api/portal/push/subscribe",
      { endpoint: "https://push.example.test/ep/1", keys: { p256dh: "x", auth: "y" } },
      { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
    );
    assert.equal(sub.status, 503);
    assert.deepEqual(sub.data, { error: "not_configured", feature: "push" });
  }
);

test(
  "REQ-PWA-08: unsubscribe is idempotent and does not depend on push being configured",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { client, csrfToken } = await loginDemo("member.demo@jp-demo.test");
    const res = await client.post(
      "/api/portal/push/unsubscribe",
      { endpoint: "https://push.example.test/ep/never-subscribed" },
      { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true });
  }
);

test(
  "push routes are classed 'own': an unauthenticated caller gets 401, not a server error",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const res = await fetch(`${BASE_URL}/api/portal/push/vapid-public-key`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "not_authenticated" });
  }
);
