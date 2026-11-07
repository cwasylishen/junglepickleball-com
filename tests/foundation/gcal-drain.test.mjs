// Probes for `drainCalendarOutbox` (controls.md §3.7, REQ-CAL-04/05/07,
// D-A17). A fake D1 stands in for PORTAL_DB -- it matches on the same
// SQL fragments `src/portal/gcal.js` actually sends, same discipline as
// tests/foundation/entitlement.test.mjs -- and a fetch spy stands in for
// Google, so every assertion below is about this module's own logic,
// never a real network call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drainCalendarOutbox, __resetAccessTokenCacheForTests } from "../../src/portal/gcal.js";

function fakeDb(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  const writes = [];

  function findById(id) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`fakeDb: no row ${id}`);
    return row;
  }

  return {
    rows,
    writes,
    prepare(sql) {
      // D1's real `.prepare()` result answers `.first()`/`.all()`/`.run()`
      // directly (no bind needed for a parameterless query) and also
      // after `.bind(...)` -- this fake supports both the same way.
      function statement(args) {
        return {
          bind(...newArgs) {
            return statement(newArgs);
          },
          async all() {
            if (sql.includes("FROM calendar_outbox o")) {
              return { results: rows.filter((r) => r.status === "pending").map((r) => ({ ...r })) };
            }
            throw new Error(`fakeDb.all: unexpected sql: ${sql}`);
          },
          async first() {
            if (sql.includes("COUNT(*) AS n")) {
              return { n: rows.filter((r) => r.status === "pending").length };
            }
            throw new Error(`fakeDb.first: unexpected sql: ${sql}`);
          },
          async run() {
            const id = args[args.length - 1];
            const row = findById(id);
            writes.push({ sql, args });
            if (sql.includes("SET status = 'failed', last_error = ?, updated_at = ?")) {
              row.status = "failed";
              row.last_error = args[0];
              row.updated_at = args[1];
            } else if (sql.includes("status = 'sent'")) {
              row.status = "sent";
              row.attempts += 1;
              row.last_error = null;
              row.updated_at = args[0];
            } else if (sql.includes("SET status = ?, attempts = ?, last_error = ?, updated_at = ?")) {
              row.status = args[0];
              row.attempts = args[1];
              row.last_error = args[2];
              row.updated_at = args[3];
            } else {
              throw new Error(`fakeDb.run: unexpected sql: ${sql}`);
            }
            return { success: true };
          },
        };
      }
      return statement([]);
    },
  };
}

function candidateRow(overrides = {}) {
  return {
    id: "outbox-1",
    booking_id: "b1a2c3d4-0000-0000-0000-000000000001",
    action: "create",
    resource_id: "res-1",
    status: "pending",
    attempts: 0,
    updated_at: "2026-10-01T00:00:00.000Z",
    start_at: "2026-10-05T15:00:00.000Z",
    end_at: "2026-10-05T16:30:00.000Z",
    resource_name: "Court 1",
    google_calendar_id: "court1@group.calendar.google.com",
    ...overrides,
  };
}

function fetchSpy(responder) {
  const calls = [];
  async function spy(url, init) {
    calls.push({ url, init });
    return responder(url, init, calls.length);
  }
  spy.calls = calls;
  return spy;
}

function tokenOk() {
  return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
}

test.beforeEach(() => {
  __resetAccessTokenCacheForTests();
});

test("REQ-CAL-04: unconfigured drain makes zero fetch calls and changes no row", async () => {
  const db = fakeDb([candidateRow()]);
  const before = JSON.stringify(db.rows);
  const fetchImpl = fetchSpy(() => {
    throw new Error("fetch must never be called while unconfigured");
  });

  const result = await drainCalendarOutbox({ PORTAL_DB: db }, { fetchImpl });

  // RED: a naive drain that read the row and tried the push regardless
  // of the secret would throw from the spy above, or would at least
  // show calls.length > 0 and a changed row -- either failure here is
  // that mutation.
  assert.deepEqual(result, { configured: false, skipped: 1, sent: 0, failed: 0 });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(JSON.stringify(db.rows), before);
});

test("configured drain inserts a create row and marks it sent", async () => {
  const db = fakeDb([candidateRow()]);
  const fetchImpl = fetchSpy((url) => {
    if (url === "https://oauth2.googleapis.com/token") return tokenOk();
    return { ok: true, status: 200, json: async () => ({ id: "jp..." }) };
  });

  const result = await drainCalendarOutbox({ PORTAL_DB: db, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: FIXTURE_PRIVATE_KEY }) }, { fetchImpl });

  assert.deepEqual(result, { configured: true, sent: 1, failed: 0, skipped: 0 });
  assert.equal(db.rows[0].status, "sent");
  // RED: a drain that built the request body with no end-to-end
  // discipline could point the insert at the wrong calendar; proving
  // the URL carries the row's own google_calendar_id catches that.
  const insertCall = fetchImpl.calls.find((c) => c.url.includes("/events") && c.init.method === "POST");
  assert.ok(insertCall.url.includes(encodeURIComponent("court1@group.calendar.google.com")));
});

test("M22: a resource with no google_calendar_id is flagged failed, not left pending forever", async () => {
  const db = fakeDb([candidateRow({ google_calendar_id: null })]);
  const fetchImpl = fetchSpy(() => {
    throw new Error("fetch must never be called for a row with no calendar id");
  });

  const result = await drainCalendarOutbox(
    { PORTAL_DB: db, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: FIXTURE_PRIVATE_KEY }) },
    { fetchImpl }
  );

  assert.deepEqual(result, { configured: true, sent: 0, failed: 0, skipped: 1 });
  // RED (the pre-fix defect, M22): the row stayed `pending` forever, so
  // it was re-selected by every later drain and never left the owner's
  // view as anything but a growing "pending" count.
  assert.equal(db.rows[0].status, "failed");
  assert.equal(db.rows[0].last_error, "no_calendar_id");
  assert.equal(fetchImpl.calls.length, 0);
});

test("M22: a backlog of no-calendar rows ahead of a pushable row does not stall the drain", async () => {
  // More than `limit` no-calendar rows, oldest first, then one pushable
  // row behind them -- the exact shape M22 describes ("once `limit`
  // such rows accumulate, the sync stalls permanently").
  const limit = 5;
  const noCalendarRows = Array.from({ length: limit + 3 }, (_, i) =>
    candidateRow({ id: `no-cal-${i}`, booking_id: `b1a2c3d4-0000-0000-0000-00000000000${i}`, google_calendar_id: null, updated_at: "2026-09-01T00:00:00.000Z" })
  );
  const pushableRow = candidateRow({ id: "pushable-1", booking_id: "b1a2c3d4-0000-0000-0000-000000000099", updated_at: "2026-09-01T00:00:00.000Z" });
  const db = fakeDb([...noCalendarRows, pushableRow]);
  const fetchImpl = fetchSpy((url) => {
    if (url === "https://oauth2.googleapis.com/token") return tokenOk();
    return { ok: true, status: 200, json: async () => ({ id: "jp..." }) };
  });

  const result = await drainCalendarOutbox(
    { PORTAL_DB: db, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: FIXTURE_PRIVATE_KEY }) },
    { fetchImpl, limit }
  );

  // RED on the pre-fix code: `rows` was sliced to `limit` *before* the
  // no-calendar rows were skipped, so with `limit + 3` no-calendar rows
  // ahead of it, the pushable row was never even looked at -- sent
  // stayed 0 and its status stayed "pending" no matter how many times
  // the drain ran.
  assert.equal(result.sent, 1);
  assert.equal(db.rows.find((r) => r.id === "pushable-1").status, "sent");
  assert.equal(result.skipped, limit + 3);
  assert.ok(noCalendarRows.every((r) => db.rows.find((row) => row.id === r.id).status === "failed"));
});

test("D-A17: a push that keeps failing is retried with backoff, then marked failed at the 5th attempt", async () => {
  // Start at attempts=4 so the next failure is the cap-crossing 5th.
  const db = fakeDb([candidateRow({ attempts: 4, updated_at: new Date(Date.now() - 20 * 60_000).toISOString() })]);
  const fetchImpl = fetchSpy((url) => {
    if (url === "https://oauth2.googleapis.com/token") return tokenOk();
    return { ok: false, status: 500, text: async () => "server_error" };
  });

  const result = await drainCalendarOutbox(
    { PORTAL_DB: db, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: FIXTURE_PRIVATE_KEY }) },
    { fetchImpl }
  );

  assert.deepEqual(result, { configured: true, sent: 0, failed: 1, skipped: 0 });
  // RED: a drain with no retry cap would leave this `pending` forever,
  // which is the exact state the owner health/outbox view (PIN-13)
  // needs to surface as a failure.
  assert.equal(db.rows[0].status, "failed");
  assert.equal(db.rows[0].attempts, 5);
});

test("D-A17 backoff: a row that just failed is not retried again before its backoff window elapses", async () => {
  const db = fakeDb([candidateRow({ attempts: 1, updated_at: new Date().toISOString() })]);
  const fetchImpl = fetchSpy(() => {
    throw new Error("fetch must never be called before the backoff window elapses");
  });

  const result = await drainCalendarOutbox(
    { PORTAL_DB: db, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com", private_key: FIXTURE_PRIVATE_KEY }) },
    { fetchImpl }
  );

  // RED: a drain with no backoff would hammer Google (and burn the
  // retry cap) every 15 minutes' worth of cron ticks in one call.
  assert.deepEqual(result, { configured: true, sent: 0, failed: 0, skipped: 0 });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.rows[0].status, "pending");
});

// A real PKCS8 key generated once for these fixtures only -- never used
// against a real Google account, and not a secret (research.md Q5's
// shape, not a credential).
const FIXTURE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCi6KKTDfG4AKe8
MmGs72/mqjwdTgD49JXkhuYI2DfwzSj+oGk0PHw2J5nSbtxMLgz1oRFHV0Y+C83I
K9K8q9CWdaKvjD8FqRKOyWyT7ddcPKT83aAWrW6ybOpWfsUNI0LdQveoP/NFAg8L
jmMILPgc7qBFiSt0Y7pPwbg6ls7Avoa0Tgj7SQ+snhOWAK8wJ2Mc1mgULY+eUMDx
vCCjhutsYs9r1PWC846Y4QLD6T8ThHDgyYVfJRnCwBGmcEnQbaH0tj5nWDgh0Aie
gLQ1aMPult0rtfxKUvcnb+dHo7/WMexgjCSPfSdUpMtzAcbEZF/hfrL88570eDPN
nKYIdsbVAgMBAAECggEAHq4FmgCtBkxXSn3Jf9ZK4muqbRFo5Pm49eQC0+UWaerV
PtjKX0xJzzAXi7YVlmIwzhxygtc4kwxJiZpZMm+AFanbRMi6gLAl3s6nvFc1MPl5
z+ZUFRk96OvSmQ4AQbhjigRn3B+JCrS3zSMYWuyPIHG/LMFHtgBnEMioj54hm1Ip
Qv53uupyFUyBOEnBST2aYU/EG8Au9Ihb9/0Ff06P3LnHrD8nxOtRChPTF9v7YcMo
RC7gxCH/n+FDC9C6ktVQ6S1+A5ScxG9iZG3bZNy0rGCEo/7aDwGz9XOWTaESwDrl
/LnJD1jY4czqYzGROmxJ7yW5I5kvfo9oxA9zJAq9wQKBgQDYcbTb76fn+q42T1aq
IBpPoBL39kPT1O/bz1JTikCiwdE9a+DJnOiiHYqqxic8afHFrX5NDmEQqhW5xWE6
lkQg2MBHTNq5RXuXVNKMVGXfrjmr+q4Tlq4hZuF4Uwfqe6G5DGpQXF38e4MWzCEa
3yP3oRk1Wdt9qYNsf33wEwnAwQKBgQDArkjpO49hH7n6FIwhHbOSqs/yZ+c4Mkin
MTvFMx4X2t45PXY8z9zeFtX9exKk6OWOswYWuANEQnJk11SWkjKYMzrZj33rMaM3
15nCimBGhNwXAox76LDRuZ4H99oo4om5fSynxfW0fMh90EYgUGSO0no3WiYs7IAM
Kcqel+C3FQKBgErT3KPgkZrIdmv+N8bu/Emk3InvEHnudtH2Nc79z+S0vuLOJdNt
tJs/PU5W3P+s3NHrbeuz2ejJ9GLaEwgPJRR5+tdrgX5lwBmMUJIFJ4cSE4waSQ4q
nJ6dk7tmcSkmfr2bxjFsDW4ZQTOjdJp2pFea0T05iIFEFlRvKxnRayDBAoGALcU4
7K6JULkIpK9c2kED90M8QokME/1d5Nl9KUsLSv9i6pX/EFMQVHF4Q86Ij0QDw/Ii
8CKmJADky6+bGGmCO0VwJV5Auy3/Z7R/ggb898N3xL+GP6j219sP/zSRTkUCEl35
zaDozQcXWUuwXNy8BnFZNuzjRKipgjorN6E8cEECgYEAs+pTX7gKxsoYkcvc5lxW
k0bkVWY74LCDDTrRsbrTS4y8fk8+SMn3meP4CMYiQHEdm1jtW8HtGOELTt76baMY
TXr0u1H1zfBVTSWDwhmE/eirUxN1MVB++gp6NQeNIKpV2SdoiXgdouFEpsHgeL1Y
2Qk77O7mwyLcvfLqHtP7UEk=
-----END PRIVATE KEY-----`;
