// M9 (CTL-ENV-01 (a)/(f), CTL-ENV-03): the scheduled handler must fail
// closed exactly like the HTTP path, using the one signal a cron
// trigger actually has (the portal_meta marker + the accounts table --
// there is no hostname), and src/worker.js must pass cron.js only the
// filtered env (never the raw one), doing nothing at all on a
// mismatch.
//
// Harness note: there is no HTTP surface for a Cron Trigger, so this
// is a direct check of resolveScheduledEnvironmentClass (a pure
// function over a fake D1, the same exemption pattern as M4's
// reconcileOwnerRole test) plus a source-order assertion that
// worker.js's scheduled() actually gates on it before calling
// runScheduled -- the two together are the construction PIN-18 asks
// for, given the harness limit (F-14 class, same reasoning as M4/M5).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { resolveScheduledEnvironmentClass, buildPortalEnv } from "../../src/portal/router.js";

function fakeDb({ markerEnv, nonDemoCount = 0, demoCount = 0 }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (/FROM portal_meta/.test(sql)) return markerEnv === null ? null : { env: markerEnv };
          if (/is_demo = 0 OR email NOT LIKE/.test(sql)) return { n: nonDemoCount };
          if (/is_demo = 1 OR email LIKE/.test(sql)) return { n: demoCount };
          return null;
        },
      };
    },
  };
}

test("M9 RED->GREEN: no marker row -> mismatch, scheduled must do nothing", async () => {
  const cls = await resolveScheduledEnvironmentClass(fakeDb({ markerEnv: null }));
  assert.equal(cls, "mismatch");
});

test("M9: preview marker with a real (non-demo) account present -> mismatch (CTL-ENV-02's cron leg)", async () => {
  const cls = await resolveScheduledEnvironmentClass(fakeDb({ markerEnv: "preview", nonDemoCount: 1 }));
  assert.equal(cls, "mismatch");
});

test("M9: preview marker with only demo accounts -> preview, and the filtered env strips live secrets", async () => {
  const cls = await resolveScheduledEnvironmentClass(fakeDb({ markerEnv: "preview", nonDemoCount: 0 }));
  assert.equal(cls, "preview");
  const penv = buildPortalEnv({ PORTAL_DB: {}, EMAIL: "should-be-stripped", OWNER_EMAILS: "x@y.com" }, cls);
  assert.equal(penv.EMAIL, undefined, "CTL-ENV-03: preview never carries the real EMAIL binding into a job");
});

test("M9: production marker with a demo account present -> mismatch (CTL-ENV-01(e)'s cron leg)", async () => {
  const cls = await resolveScheduledEnvironmentClass(fakeDb({ markerEnv: "production", demoCount: 1 }));
  assert.equal(cls, "mismatch");
});

test("M9 source order: src/worker.js's scheduled() must gate on resolveScheduledEnvironmentClass, do nothing on mismatch, and never hand cron.js the raw env", async () => {
  const src = await fs.readFile(new URL("../../src/worker.js", import.meta.url), "utf8");
  const start = src.indexOf("async scheduled(controller, env)");
  assert.notEqual(start, -1, "scheduled() export must exist");
  const body = src.slice(start, src.indexOf("\n};", start));
  assert.match(body, /resolveScheduledEnvironmentClass\(/, "RED: the pre-M9 handler never computed an environment class at all");
  assert.match(body, /if \(envClass === "mismatch"\) return;/, "GREEN: a mismatch must return before any job runs");
  assert.match(body, /runScheduled\(buildPortalEnv\(env, envClass\)\)/, "GREEN: cron.js must receive the filtered env, never the raw `env`");
  assert.doesNotMatch(body, /runScheduled\(env\)/, "the raw, unfiltered env must never reach cron.js");
});
