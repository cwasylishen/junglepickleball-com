// CTL-PWA-01 and CTL-PSH-01. No server and no DB: the service worker's
// actual fetch handler is loaded into a sandboxed VM context and driven
// directly with fake events, and the reminder content builder is a pure
// function -- both controls' own probes (controls.md §3.8) describe
// exactly this shape of test ("E7 inspection"/"table test"), not an E2
// browser run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildReminderPushMessage, STR } from "../../src/portal/push.js";

// Runs portal/sw.js for real, inside a minimal sandbox standing in for
// the ServiceWorkerGlobalScope. Returns the handlers it registered, so
// the test can call the real `fetch` listener with fake events instead
// of re-describing its logic by hand.
function loadServiceWorkerListeners() {
  const source = readFileSync(new URL("../../portal/sw.js", import.meta.url), "utf8");
  const listeners = {};
  const sandbox = {
    self: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
      registration: { showNotification: async () => {} },
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {}, match: async () => undefined }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => new Response(""),
    console,
    crypto: globalThis.crypto,
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "portal/sw.js" });
  return listeners;
}

function fakeFetchEvent(method, url, mode) {
  let respondWithCalled = false;
  const event = {
    request: { method, url, mode },
    respondWith(promiseOrValue) {
      respondWithCalled = true;
      return promiseOrValue;
    },
  };
  return { event, wasHandled: () => respondWithCalled };
}

// Every test here is synchronous and touches no server or DB, so a
// real hang is not expected -- the timeout is still explicit (same
// practice as push-cron.test.mjs) rather than relying only on
// scripts/test.sh's global --test-timeout flag.
const TEST_TIMEOUT_MS = 5000;

test(
  "CTL-PWA-01: the fetch handler never intercepts a non-GET request",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const listeners = loadServiceWorkerListeners();
    const { event, wasHandled } = fakeFetchEvent("POST", "https://portal.example/portal/manifest.webmanifest", "same-origin");
    listeners.fetch(event);
    // RED: a handler that caches "GET-shaped" requests regardless of
    // method would call respondWith here too, and a POST/PATCH/DELETE
    // under /portal/ would then risk being served stale from cache.
    assert.equal(wasHandled(), false);
  }
);

test(
  "CTL-PWA-01 / REQ-PWA-03: the fetch handler never intercepts an /api/ request",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const listeners = loadServiceWorkerListeners();
    const { event, wasHandled } = fakeFetchEvent("GET", "https://portal.example/api/portal/bookings", "same-origin");
    listeners.fetch(event);
    // RED: a cache-first variant with no "/api/" early return (the exact
    // mutation controls.md names) would call respondWith and, on a
    // cache miss, store the booking list response for the next device
    // user to read.
    assert.equal(wasHandled(), false);
  }
);

test(
  "CTL-PWA-01: the fetch handler never intercepts a navigation",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const listeners = loadServiceWorkerListeners();
    const { event, wasHandled } = fakeFetchEvent("GET", "https://portal.example/portal/", "navigate");
    listeners.fetch(event);
    assert.equal(wasHandled(), false);
  }
);

test(
  "CTL-PWA-01 (positive control): a precached static asset IS served from the cache path",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const listeners = loadServiceWorkerListeners();
    const { event, wasHandled } = fakeFetchEvent("GET", "https://portal.example/portal/manifest.webmanifest", "same-origin");
    listeners.fetch(event);
    // Without this assertion, the three tests above would pass just as
    // well for a handler that NEVER calls respondWith -- this proves the
    // guard is selective, not a blanket no-op.
    assert.equal(wasHandled(), true);
  }
);

test(
  "CTL-PSH-01: the reminder push message carries only booking_id and kind, with fixed strings",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const message = buildReminderPushMessage("booking-123", "24h");
    // RED (named exactly in controls.md's probe): a builder that pulls in
    // the resource name or the account's display name here --
    // e.g. `body: "Massage Therapy by Samy at 3pm"` -- is the failure
    // this control exists to prevent.
    assert.deepEqual(message.data, {
      title: STR.en.pushReminderTitle,
      body: STR.en.pushReminderBody,
      booking_id: "booking-123",
      kind: "24h",
    });
    const asText = JSON.stringify(message);
    for (const leak of ["Samy", "Massage", "Court", "Plunge"]) {
      assert.ok(!asText.includes(leak), `reminder message leaked "${leak}"`);
    }
  }
);
