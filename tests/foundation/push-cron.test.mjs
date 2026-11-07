// PIN-14, REQ-PWA-09..13, CTL-PSH-02 rider. This is the "calling
// runScheduled against the local DB" probe the dispatch names as the
// alternative to `wrangler dev --test-scheduled` -- it imports
// src/portal/cron.js and src/portal/push.js directly (Node 22 has
// WebCrypto and fetch globally, same as workerd) and drives them
// against the SAME local D1 the shared :8799 server uses
// (PORTAL_TEST_PERSIST_DIR), through a tiny facade in the
// prepare/bind/first/all/run shape push.js and cron.js call in
// production against the real D1 binding.
//
// That facade opens the local D1 sqlite file directly with Node's
// built-in `node:sqlite` (no new dependency -- it ships with Node 22).
// An earlier version of this file shelled out to `npx wrangler d1
// execute` per statement instead, the same way tests/foundation/
// helpers.mjs's own `d1()` does for its one-query schema probes. That
// cost ~15-20s of cold Miniflare start PER CALL (measured), and this
// file alone makes several dozen calls across its tests -- which is
// exactly why the earlier version took 16+ minutes: `execFileSync`
// blocks Node's single thread synchronously, so node:test's own
// --test-timeout (which needs the event loop to turn to fire) could
// never actually interrupt it mid-call. It looked like a hang; it was
// just that much real, serial subprocess-startup time. Reading the
// same sqlite file directly is the same data, in milliseconds, with no
// subprocess and nothing to hang.
//
// No real VAPID keys are ever generated for a preview here (that is
// cloudflare-warden's job at upload) -- `throwawayVapidKeys()` below
// makes a fresh, disposable keypair in memory for this process only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runScheduled } from "../../src/portal/cron.js";
import { sendDueReminders } from "../../src/portal/push.js";

const TEST_TIMEOUT_MS = 20000;
const PERSIST_DIR = process.env.PORTAL_TEST_PERSIST_DIR || ".wrangler/state";
const DEMO_MEMBER_ID = "demo-memb1-0000-0000-000000000003";
const DEMO_COURT_ID = "demo-court-0000-0000-000000000001";

// The D1 sqlite file's own name is content-hashed per database id, so
// this finds the one real database file in the Miniflare D1 object
// directory instead of hard-coding a hash that would break the moment
// a migration changes. `metadata.sqlite` is Miniflare's own
// bookkeeping file, not the database, and is excluded.
function findD1File(persistDir) {
  const dir = `${persistDir}/v3/d1/miniflare-D1DatabaseObject`;
  const candidates = readdirSync(dir).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one D1 sqlite file in ${dir}, found: ${candidates.join(", ") || "(none)"}`);
  }
  return `${dir}/${candidates[0]}`;
}

// One connection, opened lazily and reused for the whole file. Busy
// timeout rides out a write the running wrangler dev server (same
// file, WAL mode, a separate OS process) happens to be mid-flight on,
// rather than failing a probe on a transient lock.
let dbSingleton;
function dbHandle() {
  if (!dbSingleton) {
    dbSingleton = new DatabaseSync(findD1File(PERSIST_DIR));
    dbSingleton.exec("PRAGMA busy_timeout = 5000");
  }
  return dbSingleton;
}

// The exact subset of the real D1 prepared-statement API push.js and
// cron.js use: prepare(sql).bind(...args).first()/.all()/.run(), and
// -- same as the real D1 binding -- first()/all()/run() also work
// directly on the unbound statement for a parameterless query (that is
// exactly how cron.js's own marker check calls it).
function statementFor(sql, args) {
  return {
    bind(...boundArgs) {
      return statementFor(sql, boundArgs);
    },
    async first() {
      return dbHandle().prepare(sql).get(...args) ?? null;
    },
    async all() {
      return { results: dbHandle().prepare(sql).all(...args) };
    },
    async run() {
      const r = dbHandle().prepare(sql).run(...args);
      return { success: true, meta: { changes: r.changes }, results: [] };
    },
  };
}

function localD1Env() {
  return {
    prepare(sql) {
      return statementFor(sql, []);
    },
  };
}

// Test-setup helpers below talk to the same connection directly with
// real bound parameters (never string-built SQL -- there is no reason
// left to build SQL text once a parameter can just be bound).
function runD1(sql, ...params) {
  return dbHandle().prepare(sql).run(...params);
}

function queryD1(sql, ...params) {
  return dbHandle().prepare(sql).all(...params);
}

function base64UrlFromBytes(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

// R-3/Q2: generates a throwaway VAPID keypair in the format
// @block65/webcrypto-web-push expects (base64url raw public point,
// base64url `d`) -- never the real preview/production keys, which
// cloudflare-warden alone generates at upload.
async function throwawayVapidKeys() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const publicPoint = Buffer.concat([Buffer.from([0x04]), x, y]);
  return { publicKey: base64UrlFromBytes(publicPoint), privateKey: jwk.d };
}

function baseEnv() {
  return { PORTAL_DB: localD1Env() };
}

async function configuredEnv() {
  const vapid = await throwawayVapidKeys();
  return { ...baseEnv(), VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:test@example.com" };
}

function insertBooking(id, status, hoursFromNow) {
  const startAt = new Date(Date.now() + hoursFromNow * 3600000).toISOString();
  const endAt = new Date(Date.now() + (hoursFromNow + 1.5) * 3600000).toISOString();
  const now = new Date().toISOString();
  runD1(
    `INSERT INTO bookings (id, account_id, resource_id, start_at, end_at, status, payment_mode, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    DEMO_MEMBER_ID,
    DEMO_COURT_ID,
    startAt,
    endAt,
    status,
    "included",
    DEMO_MEMBER_ID,
    now,
    now
  );
}

function cleanupBooking(id) {
  runD1(`DELETE FROM reminder_sends WHERE booking_id = ?`, id);
  runD1(`DELETE FROM bookings WHERE id = ?`, id);
}

function reminderCount(bookingId, kind) {
  const rows = queryD1(`SELECT COUNT(*) AS n FROM reminder_sends WHERE booking_id = ? AND kind = ?`, bookingId, kind);
  return rows[0].n;
}

test(
  "REQ-PWA-09: with VAPID unset, the cron sends nothing and does not throw",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const id = `probe-unconf-${crypto.randomUUID()}`;
    insertBooking(id, "confirmed", 23.9);
    try {
      // runScheduled is the one scheduled entry point (PINS-AMENDMENT-6) --
      // this exercises reminders + the gcal drain + the D-A19 purge
      // together, proving none of the three throws when push is
      // unconfigured.
      await assert.doesNotReject(() => runScheduled(baseEnv()));
      const result = await sendDueReminders(baseEnv());
      assert.deepEqual(result, { sent: 0, configured: false });
      assert.equal(reminderCount(id, "24h"), 0);
    } finally {
      cleanupBooking(id);
    }
  }
);

test(
  "REQ-PWA-10/12: a booking 24h out gets exactly one 24h reminder row across two cron runs",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const id = `probe-24h-${crypto.randomUUID()}`;
    insertBooking(id, "confirmed", 23.5); // inside (now, now+24h]
    try {
      const env = await configuredEnv();

      // RED, shown for real: a claim that uses a plain INSERT instead of
      // `ON CONFLICT ... DO NOTHING RETURNING` throws on the SECOND
      // attempt against the real UNIQUE(booking_id, kind) index B1
      // shipped (migration 0005) -- it does not quietly double-send, it
      // crashes the job. That is exactly the failure REQ-PWA-12's UNIQUE
      // constraint exists to force a correct claim-then-send shape to
      // handle.
      const naiveInsert = () => runD1(`INSERT INTO reminder_sends (id, booking_id, kind, sent_at) VALUES (?,?,?,?)`, crypto.randomUUID(), id, "24h", new Date().toISOString());
      naiveInsert();
      assert.throws(naiveInsert, /UNIQUE|constraint/i, "the naive INSERT should collide with the real UNIQUE index");
      runD1(`DELETE FROM reminder_sends WHERE booking_id = ?`, id); // reset for the real GREEN run below

      // GREEN: the real sendDueReminders, run twice, same as two
      // */15 * * * * cron ticks 15 minutes apart. `.sent` is a
      // system-wide total, not scoped to this one booking -- the
      // preview seed data includes a real confirmed demo booking
      // (scripts/seed-preview.sql's "tomorrow 16:00" massage booking)
      // that drifts into this same dynamic (now, now+24h] window
      // depending what time of day the suite runs, so asserting an
      // exact `.sent` count here is a false RED waiting to happen on
      // its own, unrelated to anything this test is proving. What
      // REQ-PWA-10/12 actually requires -- exactly one claimed row for
      // THIS booking, never a second one on the next tick -- is what
      // `reminderCount(id, "24h")` below checks directly.
      const first = await sendDueReminders(env);
      assert.ok(first.sent >= 1, "this booking's reminder must be among those sent");
      assert.equal(reminderCount(id, "24h"), 1);
      await sendDueReminders(env);
      assert.equal(reminderCount(id, "24h"), 1, "the second run must claim nothing new for this booking+kind");
    } finally {
      cleanupBooking(id);
    }
  }
);

test(
  "REQ-PWA-13: a cancelled booking in the same time window gets no reminder",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const id = `probe-cancelled-${crypto.randomUUID()}`;
    insertBooking(id, "cancelled", 23.5);
    try {
      const env = await configuredEnv();
      await sendDueReminders(env);
      await sendDueReminders(env);
      assert.equal(reminderCount(id, "24h"), 0);
    } finally {
      cleanupBooking(id);
    }
  }
);

test(
  "REQ-PWA-11: a last-minute booking 1.5h out gets the 2h reminder (and the 24h one, on the same first run)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const id = `probe-2h-${crypto.randomUUID()}`;
    insertBooking(id, "confirmed", 1.5); // inside (now, now+2h] AND (now, now+24h]
    try {
      const env = await configuredEnv();
      await sendDueReminders(env);
      // REQ-PWA-10/11 are independently dedup'd per kind -- a booking
      // made this close to its start was never seen at an earlier 24h
      // tick, so this first run is the only chance for either kind and
      // correctly claims both. A second run must claim neither again.
      assert.equal(reminderCount(id, "2h"), 1);
      assert.equal(reminderCount(id, "24h"), 1);
      const second = await sendDueReminders(env);
      assert.equal(second.sent, 0);
    } finally {
      cleanupBooking(id);
    }
  }
);

test(
  "REQ-PWA-14: a subscription whose endpoint answers 410 Gone is deleted",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const bookingId = `probe-410-${crypto.randomUUID()}`;
    insertBooking(bookingId, "confirmed", 23.5);
    const endpoint = `https://push.example.test/ep/${crypto.randomUUID()}`;
    const clientKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", clientKeyPair.publicKey));
    const p256dh = base64UrlFromBytes(rawPublic);
    const auth = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
    const now = new Date().toISOString();
    runD1(
      `INSERT INTO push_subscriptions (id, account_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      crypto.randomUUID(),
      DEMO_MEMBER_ID,
      endpoint,
      p256dh,
      auth,
      now,
      now
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === endpoint) return new Response("", { status: 410 });
      return originalFetch(url);
    };
    try {
      const env = await configuredEnv();
      const result = await sendDueReminders(env);
      assert.equal(result.sent, 1, "the reminder is still counted as sent even though the endpoint is gone");
      const remaining = queryD1(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, endpoint);
      // RED: without the 404/410 cleanup, this row survives forever and
      // every future reminder for this account keeps failing the same
      // way.
      assert.equal(remaining.length, 0, "a 410 response must delete the subscription row");
    } finally {
      globalThis.fetch = originalFetch;
      runD1(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint);
      cleanupBooking(bookingId);
    }
  }
);
