// The owner's day-extension routes: owner role, CSRF, named errors, and
// the effect on what a member can then book. Real SQLite, production
// seed, clock fixed to Monday 2026-10-05 09:00 Costa Rica time.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS, crDateTimeToUtcIso as crAt, PROD_ORIGIN } from "./launch-helpers.mjs";

const ENV = { OWNER_EMAILS: "roger@example.com" };
let db;
let ownerSession;
let memberSession;

beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
  addAccount(db, { id: "owner-1", email: "roger@example.com", role: "owner" });
  makeMember(db, "m1");
  ownerSession = await sessionFor(db, "owner-1");
  memberSession = await sessionFor(db, "m1");
});
afterEach(() => mock.timers.reset());

const extend = (session, body) => callPortal(db, ENV, { method: "POST", path: "/api/portal/owner/day-extensions", session, body });

test("the owner extends a day; a member can then book the 19:00 court slot that day and only that day", async () => {
  const r = await extend(ownerSession, { date: "2026-10-09", close_time: "21:00" });
  assert.deepEqual([r.status, r.data.override.close_time, r.data.changed], [200, "21:00", true]);

  const book = (date) => callPortal(db, ENV, { method: "POST", path: "/api/portal/bookings", session: memberSession, body: { resource_id: "court-1", start: crAt(date, "19:00"), party_size: 2 } });
  assert.equal((await book("2026-10-09")).status, 201);
  assert.equal((await book("2026-10-10")).data.error, "outside_hours");
});

test("the owner clears it again; the list shows what is set", async () => {
  await extend(ownerSession, { date: "2026-10-09", close_time: "21:00" });
  const listed = await callPortal(db, ENV, { path: "/api/portal/owner/day-extensions", session: ownerSession });
  assert.deepEqual(listed.data.map((x) => [x.date, x.close_time]), [["2026-10-09", "21:00"]]);

  const del = () => callPortal(db, ENV, { method: "DELETE", path: "/api/portal/owner/day-extensions/2026-10-09", session: ownerSession });
  const first = await del();
  assert.deepEqual([first.status, first.data.ok, first.data.changed], [200, true, true]);
  const second = await del(); // run it twice
  assert.deepEqual([second.status, second.data.ok, second.data.changed], [200, true, false]);
  assert.deepEqual((await callPortal(db, ENV, { path: "/api/portal/owner/day-extensions", session: ownerSession })).data, []);
});

test("a member is refused on every day-extension route and nothing is written", async () => {
  const set = await extend(memberSession, { date: "2026-10-09", close_time: "21:00" });
  assert.deepEqual([set.status, set.data.error], [403, "owner_only"]);
  const list = await callPortal(db, ENV, { path: "/api/portal/owner/day-extensions", session: memberSession });
  assert.equal(list.status, 403);
  const del = await callPortal(db, ENV, { method: "DELETE", path: "/api/portal/owner/day-extensions/2026-10-09", session: memberSession });
  assert.equal(del.status, 403);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM day_close_overrides`).get().n, 0);
});

test("signed out: 401", async () => {
  const r = await callPortal(db, ENV, { method: "POST", path: "/api/portal/owner/day-extensions", body: { date: "2026-10-09", close_time: "21:00" } });
  assert.equal(r.status, 401);
});

test("the owner without the CSRF token is refused, and so is a foreign Origin", async () => {
  const { handlePortalRequest } = await import("../src/portal/router.js");
  const send = async (headers) => {
    const url = new URL("/api/portal/owner/day-extensions", PROD_ORIGIN);
    const res = await handlePortalRequest(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Cookie: ownerSession.cookie, ...headers }, body: JSON.stringify({ date: "2026-10-09", close_time: "21:00" }) }),
      { PORTAL_DB: db, ...ENV },
      url
    );
    return [res.status, (await res.json()).error];
  };
  assert.deepEqual(await send({ Origin: PROD_ORIGIN }), [403, "csrf_required"]);
  assert.deepEqual(await send({ Origin: "https://evil.example", "X-CSRF-Token": ownerSession.csrf }), [403, "csrf_required"]);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM day_close_overrides`).get().n, 0);
});

test("bad requests are 400 with a named error and write nothing", async () => {
  for (const [body, error] of [
    [{ date: "soon", close_time: "21:00" }, "bad_date"],
    [{ date: "2026-10-04", close_time: "21:00" }, "date_in_past"],
    [{ date: "2026-10-09" }, "bad_close_time"],
    [{ date: "2026-10-09", close_time: "21:30" }, "close_too_late"],
    [{ date: "2026-10-09", close_time: "19:00" }, "not_an_extension"],
  ]) {
    const r = await extend(ownerSession, body);
    assert.deepEqual([r.status, r.data.error], [400, error], JSON.stringify(body));
  }
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM day_close_overrides`).get().n, 0);
});
