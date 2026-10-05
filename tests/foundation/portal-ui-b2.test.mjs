// Part B2 (portal launch UI): two defects found by the independent
// re-inspection of preview 8a19b1fc (commit 0cd7dfc).
//
//   D9  The staff calendar never drew a booking. Alpine's x-for clones
//       only the FIRST root element of its <template>; staff.html had
//       three sibling <template x-if> roots, so "booking" and "blocked"
//       rows never mounted.
//   D8  Owner Today at 1280 px kept six resource columns in a 720 px
//       strip: Massage and Cold Plunge sat off-canvas with no cue.
//
// These are real headless-Chromium checks against the real views served
// by the local `wrangler dev` (never a source-text inference), written
// in the style of portal-shell-headless.test.mjs: they need
// puppeteer-core on NODE_PATH (NODE_PATH=/home/mike/wzq/node_modules)
// and skip cleanly, not red, when it is absent.
//
// Network responses for the staff "mixed kinds" test and the owner
// Today layout test are intercepted (the bodies are the raw JSON the
// API returns: a bare array for staff/calendar, {date, items, alerts}
// for owner/today) so the data is fixed no matter what day the suite
// runs on; the first staff test uses the seeded real
// massage booking (scripts/seed-preview.sql: tomorrow, 16:00 CR).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BASE_URL, loginDemo, d1 } from "./helpers.mjs";

const CHROMIUM_PATH = "/usr/bin/chromium-browser";
const VIEWS_DIR = new URL("../../portal/views/", import.meta.url).pathname;

// Same NODE_PATH resolver as portal-shell-headless.test.mjs (Node's ESM
// loader does not honour NODE_PATH for bare specifiers).
async function loadPuppeteer() {
  const roots = (process.env.NODE_PATH || "").split(":").filter(Boolean);
  for (const root of roots) {
    try {
      return await import(new URL(`${root}/puppeteer-core/lib/puppeteer/puppeteer-core.js`, "file://").href);
    } catch {
      // try the next NODE_PATH root, if any
    }
  }
  return null;
}

async function withBrowser(puppeteer, fn) {
  const browser = await puppeteer.launch({ executablePath: CHROMIUM_PATH, headless: "new", args: ["--no-sandbox"] });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

// auth/start is limited to 5 per email per 15 minutes (and 20 per IP,
// which is "unknown" locally), so each demo account signs in ONCE per
// run, through the real dev-login + verify path, and every page reuses
// that session cookie. The shared limiter table is cleared first, as the
// other files that log demo accounts in do (booking-engine.test.mjs),
// so a neighbouring file's logins cannot starve this one.
const sessionCookies = new Map();

// `fixedApi` maps an API path fragment to the raw JSON body to answer it
// with; it is registered BEFORE the first navigation, so the page never
// sees the real answer and no reload is needed.
async function signIn(page, email, fixedApi = {}) {
  if (!sessionCookies.has(email)) {
    d1(`DELETE FROM rate_limits`);
    const { client } = await loginDemo(email);
    const [name, ...rest] = client.getCookie().split("=");
    sessionCookies.set(email, { name, value: rest.join("=") });
  }
  const { name, value } = sessionCookies.get(email);
  await page.setCookie({ name, value, url: BASE_URL });
  if (Object.keys(fixedApi).length > 0) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const hit = Object.keys(fixedApi).find((fragment) => req.url().includes(fragment));
      if (hit) {
        req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixedApi[hit]) });
      } else {
        req.continue();
      }
    });
  }
  await page.goto(`${BASE_URL}/portal/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#portal-area h1, #portal-area section"), { timeout: 30000 });
}

// ---------------------------------------------------------------------
// D9 root cause, checked on every view so no sibling can repeat it.
// ---------------------------------------------------------------------
test("D9: no x-for <template> in any portal view has more than one root element", { timeout: 60000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH -- run with NODE_PATH=/home/mike/wzq/node_modules");

  const files = fs.readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".html")).sort();
  assert.ok(files.length > 0, `no views found in ${VIEWS_DIR}`);

  await withBrowser(puppeteer, async (browser) => {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/portal/`, { waitUntil: "domcontentloaded" });
    // Parse each view exactly as the browser parses it when the area
    // router assigns it to innerHTML, then walk every <template x-for>,
    // including ones nested inside another template's content.
    const offenders = await page.evaluate(async (names) => {
      const bad = [];
      function walk(root, file) {
        for (const tpl of root.querySelectorAll("template")) {
          if (tpl.hasAttribute("x-for") && tpl.content.children.length !== 1) {
            bad.push(`${file}: <template x-for="${tpl.getAttribute("x-for")}"> has ${tpl.content.children.length} root elements`);
          }
          walk(tpl.content, file);
        }
      }
      for (const name of names) {
        const res = await fetch(`/portal/views/${name}`);
        if (!res.ok) { bad.push(`${name}: fetch returned ${res.status}`); continue; }
        const holder = document.createElement("div");
        holder.innerHTML = await res.text();
        walk(holder, name);
      }
      return bad;
    }, files);
    assert.deepEqual(offenders, [], `Alpine x-for renders only the first root; fix: ${JSON.stringify(offenders)}`);
  });
});

// ---------------------------------------------------------------------
// D9 behaviour: the rows actually draw.
// ---------------------------------------------------------------------
function crDayNumber(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", day: "numeric" }).format(d);
}

test("D9: the staff calendar draws the seeded booking, with a correct singular count", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  await withBrowser(puppeteer, async (browser) => {
    const page = await browser.newPage();
    await signIn(page, "staff.demo@jp-demo.test");
    // The shell mounts the staff view more than once on a cold load (observed:
    // three calendar requests for one page load), and each later mount resets
    // the date to today. So the page-side check is atomic and idempotent: while
    // tomorrow is not the selected date it clicks it, and it answers only
    // when the section already shows the booking's time. A timeout is not an
    // error in itself: the assertions below report what the calendar
    // actually rendered, which is the evidence.
    const handle = await page
      .waitForFunction(
        (day) => {
          const section = document.querySelector("section");
          if (!section) return false;
          const text = section.innerText;
          if (/16:00/.test(text)) return text;
          const button = [...section.querySelectorAll("button")].find((b) => {
            const spans = b.querySelectorAll("span");
            return spans.length === 2 && spans[1].textContent.trim() === day && !b.className.includes("bg-jpteal");
          });
          if (button) button.click();
          return false;
        },
        { timeout: 25000, polling: 500 },
        crDayNumber(1)
      )
      .catch(() => null);
    const text = handle ? await handle.jsonValue() : await page.evaluate(() => (document.querySelector("section") || {}).innerText);
    assert.match(text, /16:00.17:00/, `booking time row missing from the calendar: ${JSON.stringify(text)}`);
    assert.match(text, /Member Demo/, `booking name missing from the calendar: ${JSON.stringify(text)}`);
    assert.match(text, /\b1 booking on /, `count line should read "1 booking on ...": ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /1 bookings/, "1 bookings is a pluralisation error");
  });
});

test("D9: free, blocked and booking rows all draw, in order", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  // 09:00-10:00 CR block, 11:00-12:00 CR booking (CR is UTC-6, no DST).
  const items = [
    { start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T16:00:00.000Z", state: "blocked", resource: "Massage Therapy by Samy" },
    { start: "2026-12-01T17:00:00.000Z", end: "2026-12-01T18:00:00.000Z", state: "confirmed", display_name: "Ana Prueba", resource: "Massage Therapy by Samy", length_label: "60 min" },
    { start: "2026-12-01T18:00:00.000Z", end: "2026-12-01T19:00:00.000Z", state: "confirmed", display_name: "Luis Prueba", resource: "Massage Therapy by Samy", length_label: "60 min" },
  ];

  await withBrowser(puppeteer, async (browser) => {
    const page = await browser.newPage();
    await signIn(page, "staff.demo@jp-demo.test", { "/api/portal/staff/calendar": items });
    // Atomic read (see the note above about repeated mounts): the section
    // text is returned from inside the predicate that saw the rows.
    const handle = await page
      .waitForFunction(() => {
        const section = document.querySelector("section");
        const text = section ? section.innerText : "";
        return /Ana Prueba/.test(text) && /Luis Prueba/.test(text) ? text : false;
      }, { timeout: 25000, polling: 500 })
      .catch(() => null);
    const text = handle ? await handle.jsonValue() : await page.evaluate(() => (document.querySelector("section") || {}).innerText);
    assert.match(text, /09:00.10:00/, `blocked row missing: ${JSON.stringify(text)}`);
    assert.match(text, /Closed/, `blocked row label missing: ${JSON.stringify(text)}`);
    assert.match(text, /Free 10:00.11:00/, `free gap row missing: ${JSON.stringify(text)}`);
    assert.match(text, /11:00.12:00/, `first booking row missing: ${JSON.stringify(text)}`);
    assert.match(text, /Ana Prueba/);
    assert.match(text, /12:00.13:00/, `back-to-back booking row missing: ${JSON.stringify(text)}`);
    assert.match(text, /Luis Prueba/);
    assert.ok(text.indexOf("Closed") < text.indexOf("Ana Prueba") && text.indexOf("Ana Prueba") < text.indexOf("Luis Prueba"), "rows are out of order");
  });
});

// ---------------------------------------------------------------------
// D8: owner Today layout. Fixed data: one booking in every resource.
// ---------------------------------------------------------------------
const TODAY_ITEMS = (day) => [
  ["demo-court-0000-0000-000000000001", "Ana Uno", 1],
  ["demo-court-0000-0000-000000000002", "Ben Dos", 2],
  ["demo-court-0000-0000-000000000003", "Cai Tres", 3],
  ["demo-court-0000-0000-000000000004", "Dee Cuatro", 4],
  ["demo-msg-00000-0000-000000000005", "Eli Masaje", 1],
  ["demo-plng-00000-0000-000000000006", "Fay Frio", 1],
].map(([resource_id, display_name, party_size], i) => ({
  id: `b2-item-${i}`,
  resource_id,
  state: "confirmed",
  start_at: `${day}T${String(15 + i).padStart(2, "0")}:00:00.000Z`,
  end_at: `${day}T${String(16 + i).padStart(2, "0")}:00:00.000Z`,
  display_name,
  party_size,
}));

async function openOwnerToday(browser, width, items = null) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  // The CR calendar day the view asks for.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await signIn(page, "owner.demo@jp-demo.test", {
    "/api/portal/owner/today": { date: today, items: items ? items(today) : TODAY_ITEMS(today), alerts: [] },
  });
  await page.waitForFunction(() => /Fay Frio/.test(document.body.innerText), { timeout: 30000 });
  return page;
}

// Rects of the six resource column headers and the six booking buttons.
function measureColumns(page) {
  return page.evaluate(() => {
    // The strip is the view's one horizontal scroller; its first child
    // is the flex row whose children are the resource columns.
    const strip = document.querySelector("#portal-area .overflow-x-auto");
    const cols = [...strip.firstElementChild.children].filter((el) => el.tagName !== "TEMPLATE");
    const buttons = [...strip.querySelectorAll("button")];
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right) }; };
    return {
      vw: window.innerWidth,
      pageScrollW: document.documentElement.scrollWidth,
      stripScrollW: strip.scrollWidth,
      stripClientW: strip.clientWidth,
      cols: cols.map((c) => ({ name: c.firstElementChild.textContent.trim(), ...r(c) })),
      buttons: buttons.map((b) => ({ text: b.innerText.replace(/\s+/g, " ").trim(), ...r(b) })),
    };
  });
}

test("D8: at 1280 px every resource column and booking is inside the viewport", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  await withBrowser(puppeteer, async (browser) => {
    const page = await openOwnerToday(browser, 1280);
    const m = await measureColumns(page);
    assert.equal(m.cols.length, 6, `expected 6 resource columns, got ${JSON.stringify(m.cols)}`);
    for (const c of m.cols) {
      assert.ok(c.left >= 0 && c.right <= m.vw, `column ${c.name} is off-canvas at 1280: ${c.left}..${c.right} of ${m.vw}`);
    }
    assert.equal(m.buttons.length, 6, "all six bookings render");
    for (const b of m.buttons) {
      assert.ok(b.left >= 0 && b.right <= m.vw, `booking "${b.text}" is off-canvas at 1280: ${b.left}..${b.right} of ${m.vw}`);
    }
    assert.ok(m.pageScrollW <= m.vw, `page scrolls horizontally at 1280: scrollWidth ${m.pageScrollW} > ${m.vw}`);
    const cue = await page.evaluate(() => { const el = document.querySelector("[data-scroll-cue]"); return el ? getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0 : false; });
    assert.equal(cue, false, "no scroll cue is needed (and none shown) when every column fits");
  });
});

test("D8: at 390 px the strip shows a scroll cue and no booking is clipped; 16 px margins and no page scroll", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  await withBrowser(puppeteer, async (browser) => {
    const page = await openOwnerToday(browser, 390);
    const before = await measureColumns(page);
    assert.ok(before.stripScrollW > before.stripClientW, "at 390 the six columns overflow the strip (the case that needs a cue)");
    assert.ok(before.pageScrollW <= before.vw, `page scrolls horizontally at 390: scrollWidth ${before.pageScrollW} > ${before.vw}`);

    const cue = await page.evaluate(() => {
      const el = document.querySelector("[data-scroll-cue]");
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { shown: getComputedStyle(el).display !== "none" && b.height > 0 && b.width > 0, text: el.innerText, left: Math.round(b.left), right: Math.round(b.right) };
    });
    assert.ok(cue && cue.shown, `a visible scroll cue is required at 390, got ${JSON.stringify(cue)}`);
    assert.match(cue.text, /sideways/i);
    assert.doesNotMatch(cue.text, /\u2014/, "no em dash in visible copy");
    const fade = await page.evaluate(() => { const el = document.querySelector("[data-scroll-fade]"); return el ? getComputedStyle(el).display !== "none" : false; });
    assert.ok(fade, "the right-edge fade is shown while more columns are off to the right");

    // Scroll to the end: every booking must be reachable inside the viewport.
    await page.evaluate(() => { const s = document.querySelector("#portal-area .overflow-x-auto"); s.scrollLeft = s.scrollWidth; s.dispatchEvent(new Event("scroll")); });
    const after = await measureColumns(page);
    const last = after.buttons[after.buttons.length - 1];
    assert.ok(last.right <= after.vw, `last booking "${last.text}" is clipped at the end of the strip: right ${last.right} of ${after.vw}`);
    // Alpine applies x-show on its next tick, so wait for it rather than race it.
    await page
      .waitForFunction(() => getComputedStyle(document.querySelector("[data-scroll-fade]")).display === "none", { timeout: 5000 })
      .catch(() => assert.fail("the fade goes away once the strip is scrolled to its end"));

    // Edge margins unchanged (16 px) and no page-level horizontal scroll.
    const edges = await page.evaluate(() => {
      const h1 = document.querySelector("#portal-area h1").getBoundingClientRect();
      return { left: Math.round(h1.left), pageScrollW: document.documentElement.scrollWidth, vw: window.innerWidth };
    });
    assert.equal(edges.left, 16, "heading keeps its 16 px left margin at 390");
    assert.ok(edges.pageScrollW <= edges.vw, "no page-level horizontal scroll at 390");
  });
});

test("pluralisation: owner Today reads '1 booking' and '1 player' for one", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  await withBrowser(puppeteer, async (browser) => {
    const page = await openOwnerToday(browser, 1280);
    const text = await page.evaluate(() => document.querySelector("#portal-area").innerText);
    assert.match(text, /6 bookings across 6 courts and services/, "six bookings stay plural");
    assert.match(text, /\b1 player\b/, "a party of one reads '1 player'");
    assert.doesNotMatch(text, /\b1 players\b/);
    assert.match(text, /\b2 players\b/, "a party of two stays plural");
  });
});

// ---------------------------------------------------------------------
// C4-05: the pay-at-the-club marker is drawn on the owner's Today screen
// (with the amount) and on the staff calendar (without one).
// ---------------------------------------------------------------------
test("C4-05: owner Today marks a pay-at-the-club booking with the amount, on its tile and on its sheet, and no other tile", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  // The first booking owes $30.00; the others carry the fields the server sends for "not owed".
  const items = (day) => TODAY_ITEMS(day).map((it, i) => ({ ...it, pay_at_club: i === 0, amount_cents: i === 0 ? 3000 : null }));
  await withBrowser(puppeteer, async (browser) => {
    const page = await openOwnerToday(browser, 1280, items);
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll("#portal-area .overflow-x-auto button")].map((b) => b.innerText.replace(/\s+/g, " ").trim())
    );
    assert.equal(tiles.length, 6);
    const marked = tiles.filter((x) => /pay at club/i.test(x));
    assert.equal(marked.length, 1, `exactly one tile is marked: ${JSON.stringify(tiles)}`);
    assert.match(marked[0], /Ana Uno/);
    assert.match(marked[0], /pay at club: \$30\.00/i);

    await page.evaluate(() => document.querySelector("#portal-area .overflow-x-auto button").click());
    const sheet = await page
      .waitForFunction(() => { const el = document.querySelector("#portal-area .fixed"); return el ? el.innerText : false; }, { timeout: 15000 })
      .then((h) => h.jsonValue());
    assert.match(sheet, /pay at club: \$30\.00/i, `the sheet shows what is owed: ${JSON.stringify(sheet)}`);
  });
});

test("C4-05: the staff calendar marks a pay-at-the-club booking 'Pay at club', with no amount", { timeout: 90000 }, async (t) => {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return t.skip("puppeteer-core not on NODE_PATH");

  const items = [
    { start: "2026-12-01T17:00:00.000Z", end: "2026-12-01T18:30:00.000Z", state: "confirmed", display_name: "Gus Guest", resource: "Massage Therapy by Samy", pay_at_club: true },
    { start: "2026-12-01T19:00:00.000Z", end: "2026-12-01T20:30:00.000Z", state: "confirmed", display_name: "Mia Member", resource: "Massage Therapy by Samy" },
  ];
  await withBrowser(puppeteer, async (browser) => {
    const page = await browser.newPage();
    await signIn(page, "staff.demo@jp-demo.test", { "/api/portal/staff/calendar": items });
    const handle = await page
      .waitForFunction(() => {
        const section = document.querySelector("section");
        const text = section ? section.innerText : "";
        return /Gus Guest/.test(text) && /Mia Member/.test(text) ? text : false;
      }, { timeout: 25000, polling: 500 })
      .catch(() => null);
    const text = handle ? await handle.jsonValue() : await page.evaluate(() => (document.querySelector("section") || {}).innerText);
    assert.equal((text.match(/pay at club/gi) || []).length, 1, `exactly one booking is marked: ${JSON.stringify(text)}`);
    assert.ok(text.search(/Gus Guest/) < text.search(/pay at club/i) && text.search(/pay at club/i) < text.search(/Mia Member/), "the marker sits on Gus's row, before Mia's");
    assert.doesNotMatch(text, /\$/, "staff never see an amount");
  });
});
