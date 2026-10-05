// Shared helpers for the B1 foundation probes. Black-box HTTP against
// the real bundle (PIN-16) -- these never import the server's own code
// except where a control's probe is explicitly a pure-function/schema
// check (controls.md says so for CTL-ENT-01/02, CTL-ROLE-01, CTL-AUTH-07,
// CTL-DATA-01/02/03/05), in which case the test says so at the top.

export const BASE_URL = process.env.PORTAL_TEST_BASE_URL || "http://127.0.0.1:8799";

// A tiny cookie jar: fetch() in Node does not persist Set-Cookie across
// calls, and the auth flow needs that to work the way a browser would.
export function makeClient() {
  let cookie = null;
  async function call(method, path, body, extraHeaders = {}) {
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (cookie) headers["Cookie"] = cookie;
    // `wrangler dev` hot-reloads mid-suite (a source edit, or even a
    // concurrent `wrangler d1 execute` CLI run touching .wrangler/tmp)
    // and drops any request in flight at that instant. One retry rides
    // out that transient disconnect without masking a real failure --
    // the retried request still gets the real response and the real
    // assertion runs against it.
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        break;
      } catch (err) {
        if (attempt === 1) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data, res };
  }
  return {
    get: (path, headers) => call("GET", path, undefined, headers),
    post: (path, body, headers) => call("POST", path, body, headers),
    request: (method, path, body, headers) => call(method, path, body, headers),
    clearCookie: () => { cookie = null; },
    getCookie: () => cookie,
  };
}

// True for the local runtime's own "Your worker restarted mid-request"
// answer: a 503 whose body is plain text. Every 503 this application sends is
// JSON (src/portal/http.js), so a 503 with no JSON body did not come from the
// application. Measured 2026-10-04 on a host at load average 70: about one run
// in four of a 20-request burst gets this answer for 2 of its requests, with
// nothing in the application's log. Which of those requests had already
// committed is unknown, so a burst that contains one proves nothing either way.
export function isPlatformRestart(result) {
  return result.status === 503 && result.data === null;
}

// Runs one burst of concurrent requests. If the local runtime restarted in the
// middle of it (isPlatformRestart), the burst's outcome is unknown, so it is
// thrown away and run again on another day's slot: attempt 0 uses the slot the
// test names, later attempts move it 20 days on. The assertions are applied,
// unchanged, to the first burst the runtime did not interrupt. Three
// interrupted bursts in a row fail the test by name.
export async function burstUntilUninterrupted(runBurst) {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const results = await runBurst(attempt * 20);
    if (!results.some(isPlatformRestart)) return { results, shiftDays: attempt * 20 };
  }
  assert.fail(`the local server restarted mid-request in all ${attempts} bursts; this host is too loaded to say anything about the race`);
}

// `wrangler dev`'s hot-reload can tear down and rebuild the D1
// connection mid-request, which the portal's own top-level catch
// (CTL-ERR-01) correctly turns into a generic 500 -- that is the control
// working, not a test to fail on. One retry rides that out; a genuine
// problem with auth/start still fails loudly on the second attempt.
export async function startAndGetDevLink(client, email, origin) {
  let start = await client.post("/api/portal/auth/start", { email }, origin);
  if (!start.data || !start.data.dev_link) {
    await new Promise((r) => setTimeout(r, 500));
    start = await client.post("/api/portal/auth/start", { email }, origin);
  }
  if (!start.data || !start.data.dev_link) {
    throw new Error(`no dev_link for ${email}: ${JSON.stringify(start.data)}`);
  }
  return start.data.dev_link;
}

// Logs a demo account in end to end (start -> dev_link -> verify) and
// returns an authenticated client plus its csrf token.
export async function loginDemo(email, extraHeaders = {}) {
  // The per-email (5) and per-IP (20) login limits are per 15 minutes, and a
  // whole suite logs in far more often than that from one address. A login
  // helper that does not clear them gets no dev_link once the budget is
  // spent. The tests that exercise the limits themselves call makeClient()
  // directly and never come through here.
  d1(`DELETE FROM rate_limits`);
  const client = makeClient();
  const origin = { Origin: BASE_URL, ...extraHeaders };
  const devLink = await startAndGetDevLink(client, email, origin);
  const token = new URL(devLink).hash.replace(/^#login=/, "");
  const verify = await client.post("/api/portal/auth/verify", { token, age_16_plus: true, confirm: true }, origin);
  if (verify.status !== 200) throw new Error(`verify failed for ${email}: ${verify.status} ${JSON.stringify(verify.data)}`);
  return { client, csrfToken: verify.data.csrf_token, account: verify.data.account };
}

// Direct SQL against the SAME local PORTAL_DB the running server uses
// (--persist-to, set by scripts/test.sh -- see that file for why state
// lives outside the watched project tree). Used by probes that need to see
// or set rows the API gives no handle on, and by the schema/trigger probes
// (CTL-DATA-01/02/03/05, CTL-ENV-01/02).
//
// This opens the persisted sqlite file with Node's built-in `node:sqlite`
// (no new dependency). It used to run `npx wrangler d1 execute` once per
// call, which costs a cold Miniflare start every time (15-25 s on a busy
// host, measured on 2026-10-04) and, because execFileSync blocks the one
// Node thread, node:test's own timeout could never fire during it: a suite
// with a few hundred calls looked hung for an hour. Same data, in
// milliseconds, with nothing to block. push-cron.test.mjs already read the
// file this way.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import assert from "node:assert/strict";

const PERSIST_DIR = process.env.PORTAL_TEST_PERSIST_DIR || ".wrangler/state";

// The sqlite file name is content-hashed per database id. Pick the file
// that holds the portal's tables; `metadata.sqlite` is Miniflare's own
// bookkeeping, and the ANALYTICS database (if the server ever touched it)
// has no portal_meta table.
function findPortalDbFile(persistDir) {
  const dir = `${persistDir}/v3/d1/miniflare-D1DatabaseObject`;
  const names = readdirSync(dir).filter((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite");
  for (const name of names) {
    const probe = new DatabaseSync(`${dir}/${name}`, { readOnly: true });
    try {
      if (probe.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'portal_meta'`).get()) return `${dir}/${name}`;
    } finally {
      probe.close();
    }
  }
  throw new Error(`no portal database (a file with a portal_meta table) in ${dir}; found: ${names.join(", ") || "none"}`);
}

let dbSingleton;
function portalDb() {
  if (!dbSingleton) {
    // Foreign keys off: the `wrangler d1 execute` calls this replaced did not
    // enforce them, and the tests' cleanup deletes (a booking before its
    // calendar_outbox row, an account before its sessions) depend on that.
    // The server's own connection is unaffected.
    dbSingleton = new DatabaseSync(findPortalDbFile(PERSIST_DIR), { enableForeignKeyConstraints: false });
    // The running server writes the same file from another process; wait out
    // a write in flight instead of failing a probe on a transient lock.
    dbSingleton.exec("PRAGMA busy_timeout = 10000");
  }
  return dbSingleton;
}

// Splits on `;` outside single- or double-quoted text, so a value that
// contains a semicolon stays whole.
function splitStatements(sql) {
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// Runs each statement in order; returns one array of rows per statement
// (empty for a statement that returns no columns). A SQL error throws.
export function d1Each(sql) {
  const db = portalDb();
  return splitStatements(sql).map((text) => {
    const statement = db.prepare(text);
    if (statement.columns().length > 0) return statement.all().map((row) => ({ ...row }));
    statement.run();
    return [];
  });
}

// Rows of the first statement (the long-standing shape of d1()).
export function d1(sql) {
  return d1Each(sql)[0] || [];
}

// Rows of the last statement.
export function d1Last(sql) {
  const all = d1Each(sql);
  return all[all.length - 1] || [];
}

// A UTC instant on the Costa Rica calendar day `daysAhead` from today, at
// the given UTC hour and minute (CR is UTC-6 all year, so CR 08:30 is hour
// 14, minute 30). Counting days from the UTC calendar is wrong in the six
// hours when UTC has rolled to tomorrow and CR has not: a "tomorrow" slot
// then lands two CR days out, past a guest's window.
export function utcOnCrDay(daysAhead, hour, minute = 0) {
  const nowCr = new Date(Date.now() - 6 * 3600 * 1000);
  return new Date(Date.UTC(nowCr.getUTCFullYear(), nowCr.getUTCMonth(), nowCr.getUTCDate() + daysAhead, hour, minute, 0, 0));
}

// Every test file runs in its own process and imports this module, so this
// runs once at the start of each file. It puts back the rows a file's
// predecessors are known to leave behind (bookings and their calendar
// events, credit balances, QA entitlement grants, login limits), keeping the
// seeded rows. Without it a booking left by one file tripped another file's
// per-account cap or took its slot, and a whole suite run gave different
// answers from the same files run alone. Only the harness sets
// PORTAL_TEST_PERSIST_DIR, so a file run without a server is not touched.
if (process.env.PORTAL_TEST_PERSIST_DIR) {
  d1Each(`
    DELETE FROM calendar_outbox WHERE booking_id NOT LIKE 'demo-bkg-%';
    DELETE FROM bookings WHERE id NOT LIKE 'demo-bkg-%';
    DELETE FROM credits_ledger;
    UPDATE credits SET balance = 0;
    DELETE FROM entitlement_grants WHERE id LIKE 'qa-grant-%';
    DELETE FROM rate_limits`);
}
