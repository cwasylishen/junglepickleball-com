// D-R1 (release inspection of 1f0f44a8): guest-facing copy stated the old or
// the member rules. The class of defect is "a screen says a number or a
// price that the data does not": hours, booking windows, "Included", and
// which Cold Plunge length applies. These tests hold the fix at both ends.
//
//  1. The API: GET /resources tells each caller what is included for THEM
//     and which offerings apply to them, and that agrees with the quote the
//     confirm step uses (one decision, audienceFor).
//  2. The screens: the real portal/js files run in a bare context with the
//     API stubbed, and what a guest would read is checked.
//  3. A grep: no hours, window or "Included" literal is left in a view or
//     string table.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { prodDb, addAccount, makeMember, sessionFor, callPortal, NOW_UTC_MS } from "./launch-helpers.mjs";

const ENV = { OWNER_EMAILS: "roger@example.com" };
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---- 1. the API --------------------------------------------------------

let db;
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW_UTC_MS });
  db = prodDb();
});
afterEach(() => mock.timers.reset());

async function caller(kind) {
  if (kind === "guest") {
    addAccount(db, { id: "g1", email: "g1@example.com", role: "guest" });
    return sessionFor(db, "g1");
  }
  makeMember(db, `m-${kind}`, kind);
  return sessionFor(db, `m-${kind}`);
}
const resourcesFor = async (session) => (await callPortal(db, ENV, { path: "/api/portal/resources", session })).data;
const byId = (list, id) => list.find((r) => r.id === id);
const applying = (r) => r.offerings.filter((o) => o.applies_to_you).map((o) => o.id);

test("D-R1: a guest is shown the courts and the plunge at the guest price, nothing Included", async () => {
  const list = await resourcesFor(await caller("guest"));
  for (const id of ["court-1", "court-2", "court-3", "court-4"]) {
    const court = byId(list, id);
    assert.equal(court.included_for_you, false, `${id} must not be Included for a guest`);
    assert.deepEqual(applying(court), [`${id}-session`]);
    assert.equal(court.offerings[0].display_price_cents, 1500);
  }
  const plunge = byId(list, "cold-plunge");
  assert.equal(plunge.included_for_you, false);
  assert.deepEqual(applying(plunge), ["plunge-guest"], "a guest is offered exactly one Cold Plunge length: the guest one");
  assert.equal(plunge.offerings.find((o) => o.id === "plunge-guest").display_price_cents, 1500);
});

test("D-R1: an annual member has the courts and the plunge included; another member pays the member plunge price", async () => {
  const annual = await resourcesFor(await caller("jp_annual_single"));
  assert.equal(byId(annual, "court-1").included_for_you, true);
  assert.equal(byId(annual, "cold-plunge").included_for_you, true);
  assert.deepEqual(applying(byId(annual, "cold-plunge")), ["plunge-annual"]);

  db = prodDb();
  const threeMonth = await resourcesFor(await caller("jp_3m_single"));
  assert.equal(byId(threeMonth, "court-1").included_for_you, true);
  assert.equal(byId(threeMonth, "cold-plunge").included_for_you, false);
  assert.deepEqual(applying(byId(threeMonth, "cold-plunge")), ["plunge-member"]);
});

test("D-R1: what the list says is what the quote charges, for every caller and every applying offering", async () => {
  // Massage is off at launch; switch it on so its lengths are covered too.
  db.sqlite.prepare(`UPDATE offerings SET active = 1 WHERE resource_id = 'massage-samy'`).run();
  const callers = [["guest", await caller("guest")]];
  for (const tier of ["jp_annual_single", "jp_6m_couples", "jp_1m_single"]) callers.push([tier, await caller(tier)]);

  let checked = 0;
  for (const [who, session] of callers) {
    for (const r of await resourcesFor(session)) {
      const offerings = r.offerings.filter((o) => o.applies_to_you);
      const targets = offerings.length ? offerings : [{ id: null }];
      for (const o of targets) {
        const qs = `party_size=1${o.id ? `&offering_id=${o.id}` : ""}`;
        const q = (await callPortal(db, ENV, { path: `/api/portal/resources/${r.id}/quote?${qs}`, session })).data;
        assert.equal(q.mode === "included", r.included_for_you, `${who} ${r.id}: list says included=${r.included_for_you}, quote says ${q.mode}`);
        if (r.included_for_you) assert.equal(q.total_cents, 0);
        else assert.equal(q.total_cents, o.display_price_cents, `${who} ${r.id} ${o.id}: list price ${o.display_price_cents}, quote ${q.total_cents}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 20, `expected at least 20 list-versus-quote checks, ran ${checked}`);
});

// ---- 2. the screens ----------------------------------------------------

function loadPortalScripts(apiGet) {
  const strings = {};
  const context = {
    console,
    Intl,
    Date,
    location: { hash: "" },
    history: { replaceState() {} },
    addEventListener() {},
    document: { readyState: "complete", getElementById: () => null, addEventListener() {} },
    PortalApi: { get: async (url) => apiGet(url), post: async () => ({ ok: false }), setCsrfToken() {} },
    fetch: async () => ({ text: async () => "" }),
  };
  context.window = context;
  void strings;
  runInNewContext(read("portal/js/app.js"), context);
  runInNewContext(`${read("portal/js/member.js")}\nthis.__memberHome = memberHome; this.__memberBook = memberBook;`, context);
  runInNewContext(read("portal/js/owner.js"), context);
  return context;
}

const COURT = { kind: "court", open_time: "07:00", close_time: "19:00", member_window_days: 60, non_member_window_days: 60, active: true };
const guestApi = (extra = {}) => async (url) => {
  if (url === "/api/portal/me") return { ok: true, data: { authenticated: true, account: { display_name: "Ward Guest", email: "w@example.com", role: "guest" }, entitlement: { entitled: false }, credits: 0 } };
  if (url === "/api/portal/bookings") return { ok: true, data: [] };
  if (url === "/api/portal/resources") return { ok: true, data: [{ id: "court-1", name: "Court 1", ...COURT, ...extra }] };
  return { ok: false };
};

test("D-R1: a guest's Home states the booking window and the hours the courts report", async () => {
  const ctx = loadPortalScripts(guestApi());
  const home = ctx.__memberHome();
  await home.load();
  assert.match(home.statusLine, /book up to 60 days ahead/);
  assert.doesNotMatch(home.statusLine, /\b2 days\b/);
  assert.equal(home.courtHours.open, "07:00");
  assert.equal(home.courtHours.close, "19:00");
  assert.equal(ctx.t("home.empty_body", home.courtHours), "Courts are open 07:00\u201319:00 every day.");
});

test("D-R1: the words follow the data: other hours and another window read as given", async () => {
  const ctx = loadPortalScripts(guestApi({ close_time: "18:00", non_member_window_days: 14 }));
  const home = ctx.__memberHome();
  await home.load();
  assert.match(home.statusLine, /up to 14 days ahead/);
  assert.equal(home.courtHours.close, "18:00");
});

test("D-R1: with the courts unreadable, Home leaves the hours and the window out rather than guess", async () => {
  const api = guestApi();
  const ctx = loadPortalScripts(async (url) => (url === "/api/portal/resources" ? { ok: false, status: 500 } : api(url)));
  const home = ctx.__memberHome();
  await home.load();
  assert.equal(home.courtHours, null);
  assert.doesNotMatch(home.statusLine, /days/);
  assert.match(home.statusLine, /Not a member yet/);
});

test("D-R1: the Book picker labels a guest's court and plunge with the guest price, and shows one plunge length", () => {
  const ctx = loadPortalScripts(async () => ({ ok: false }));
  const book = ctx.__memberBook();
  const court = { id: "court-1", kind: "court", member_included: true, included_for_you: false, offerings: [{ id: "court-1-session", display_price_cents: 1500, applies_to_you: true }] };
  assert.equal(book.priceLine(court), "$15.00", "a guest's court shows $15, not Included");
  const plunge = {
    id: "cold-plunge", kind: "plunge", member_included: true, included_for_you: false,
    offerings: [
      { id: "plunge-annual", duration_minutes: 20, display_price_cents: 0, applies_to_you: false },
      { id: "plunge-member", duration_minutes: 20, display_price_cents: 1000, applies_to_you: false },
      { id: "plunge-guest", duration_minutes: 20, display_price_cents: 1500, applies_to_you: true },
    ],
  };
  assert.equal(book.priceLine(plunge), "$15.00");
  assert.equal(book.yourOfferings(plunge).map((o) => o.id).join(","), "plunge-guest", "How long? lists only the guest's own offering");
  book.pickResource(plunge);
  assert.equal(book.offering && book.offering.id, "plunge-guest", "the one length that applies is chosen for them");
});

test("D-R1: a member's court still reads Included, and keeps its one offering selected", () => {
  const ctx = loadPortalScripts(async () => ({ ok: false }));
  const book = ctx.__memberBook();
  const court = { id: "court-1", kind: "court", member_included: true, included_for_you: true, offerings: [{ id: "court-1-session", display_price_cents: 1500, applies_to_you: false }] };
  assert.equal(book.priceLine(court), "Included");
  book.pickResource(court);
  assert.equal(book.offering && book.offering.id, "court-1-session");
});

test("D-R1: the owner screens state the guest window and the normal close from the courts", async () => {
  const api = async (url) => {
    if (url === "/api/portal/owner/resources") return { ok: true, data: [{ id: "court-1", ...COURT }] };
    if (url.startsWith("/api/portal/owner/accounts/")) return { ok: true, data: { account: { id: "a1", role: "guest" } } };
    return { ok: true, data: [] };
  };
  const ctx = loadPortalScripts(api);
  const detail = ctx.ownerMemberDetail();
  detail.id = () => "a1";
  await detail.load();
  assert.equal(detail.guestEffect(), "Books as a guest: up to 60 days ahead, at guest prices.");

  const late = ctx.ownerLateHours();
  await late.load();
  assert.match(late.introLine(), /^Courts normally close at 19:00\. /);
});

// ---- 3. no literal left ---------------------------------------------------

test("D-R1: no view or string table states an opening hour, a booking window in days, or a stale rule", () => {
  const files = [
    ...readdirSync(new URL("../portal/js", import.meta.url)).map((f) => `portal/js/${f}`),
    ...readdirSync(new URL("../portal/views", import.meta.url)).map((f) => `portal/views/${f}`),
    "portal/index.html",
  ];
  const offenders = [];
  for (const file of files) {
    read(file).split("\n").forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("<!--")) return;
      // 19:30 was the old close; "N days ahead" and "up to N days" are the window.
      if (/\b19:30\b/.test(code)) offenders.push(`${file}:${i + 1} 19:30`);
      if (/\b\d+ days? ahead\b/.test(code)) offenders.push(`${file}:${i + 1} N days ahead`);
      if (/\bup to \d+ days\b/.test(code)) offenders.push(`${file}:${i + 1} up to N days`);
      if (/close: '\d\d:\d\d'|open: '\d\d:\d\d'/.test(code)) offenders.push(`${file}:${i + 1} literal open/close`);
      // "Included" on a guest-facing label comes only from included_for_you or the quote mode.
      if (/\bmember_included\b/.test(code) && file.startsWith("portal/js/member")) offenders.push(`${file}:${i + 1} member_included drives a label`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("D-R1: no em dash in the touched copy", () => {
  const text = read("portal/js/member.js") + read("portal/js/owner.js") + read("portal/js/app.js") + read("portal/views/member-home.html");
  assert.doesNotMatch(text, /\u2014/);
});

// D-R3 (mitigation): Home asks for what it needs all at once, so the first
// screen after sign-in is not five round trips behind a placeholder.
test("D-R3: Home issues its three reads together, before any of them has answered", async () => {
  let inFlight = 0;
  let peak = 0;
  const api = guestApi();
  const ctx = loadPortalScripts(async (url) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return api(url);
  });
  await new Promise((resolve) => setTimeout(resolve, 30)); // let the owner script's own start-up read finish
  peak = 0;
  await ctx.__memberHome().load();
  assert.equal(peak, 3, "me, bookings and resources must be requested together");
});
