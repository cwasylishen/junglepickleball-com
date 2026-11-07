// Static checks on the launch copy and wiring in the portal UI. The
// behaviour itself was driven in a real headless browser (see the B3
// return); these keep the wording and the wiring from drifting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const appJs = read("portal/js/app.js");
const memberJs = read("portal/js/member.js");
const ownerJs = read("portal/js/owner.js");

test("sign-in says, in these words, when email sign-in is not available", () => {
  assert.ok(appJs.includes("Email sign-in is not available right now. Please try again later."));
  assert.match(appJs, /res\.status === 503 && res\.error === "email_unavailable"/);
});

test("inside the cancel window the UI tells the member to contact the club, naming the cutoff the server sent", () => {
  assert.ok(memberJs.includes('"cancel.err_cutoff": "To cancel within {cutoff}, please contact the club."'));
  assert.match(memberJs, /noticeWords\(res\.data && res\.data\.cancel_cutoff_minutes\)/);
});

test("the booking screen offers every day of the booker's window, not a fixed week", () => {
  assert.match(memberJs, /member_window_days : this\.resource\.non_member_window_days/);
  assert.doesNotMatch(memberJs, /var n = 7;/);
});

test("the owner's late-hours screen is wired: file, route and a link in Manage", () => {
  assert.ok(existsSync(new URL("../portal/views/owner-late-hours.html", import.meta.url)));
  assert.ok(ownerJs.includes('[/^#\\/manage\\/late-hours$/, "owner-late-hours"]'));
  assert.ok(read("portal/views/owner-manage.html").includes('href="#/manage/late-hours"'));
});

test("every string the late-hours screen asks for is defined", () => {
  const view = read("portal/views/owner-late-hours.html");
  const keys = [...view.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 5);
  for (const key of keys) assert.ok(ownerJs.includes(`"${key}":`) || appJs.includes(`"${key}":`), `string key ${key} is not defined`);
  for (const code of ["bad_date", "date_in_past", "not_an_extension", "close_too_late"]) assert.ok(ownerJs.includes(`"late.err_${code}"`), `no sentence for ${code}`);
});

test("no em or en dash in the new copy", () => {
  const dashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
  const newCopy = [
    ...ownerJs.matchAll(/"(late\.[a-z_]+|manage\.late)": "([^"]*)"/g),
    ...appJs.matchAll(/"(auth\.(?:link_sent|email_unavailable|email_invalid))": "([^"]*)"/g),
    ...memberJs.matchAll(/"((?:cancel\.err_cutoff|book\.err_too_soon|book\.err_not_bookable|slot\.too_soon))": "([^"]*)"/g),
  ];
  assert.ok(newCopy.length >= 15, `found ${newCopy.length} strings`);
  for (const [, key, text] of newCopy) assert.doesNotMatch(text, dashes, key);
});

// C4-01: runs the real booking screen code (portal/js/member.js) in a
// bare context with the API stubbed, and reads what the screen would show.
test("the booking screen shows a guest the engine's own sentence when the guest cap refuses", async () => {
  const { runInNewContext } = await import("node:vm");
  const sentence = "Guests can hold up to 2 upcoming court bookings. Become a member for unlimited booking, or ask at the club.";
  const strings = {};
  // In a browser `window` is the global object; do the same here.
  const context = {
    STR: { en: strings },
    PortalApp: { mergeStrings: (dict) => Object.assign(strings, dict) },
    PortalAreas: {},
    addEventListener() {},
    location: {},
    document: { getElementById: () => null },
    PortalApi: { post: async () => ({ ok: false, status: 409, error: "guest_cap_reached", data: { error: "guest_cap_reached", message: sentence } }), get: async () => ({ ok: true, data: {} }) },
    Intl,
    console,
  };
  context.window = context;
  runInNewContext(`${memberJs}\nthis.__memberBook = memberBook;`, context);
  const screen = context.__memberBook();
  screen.resource = { id: "court-1", name: "Court 1" };
  screen.slot = { start: "2026-10-08T14:30:00.000Z" };
  await screen.confirm();
  assert.equal(screen.confirmError, sentence);
  assert.equal(screen.done, false);
  assert.doesNotMatch(screen.confirmError, new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`));
});
