// Shared by the F10 navigation tests (portal-nav-*.test.mjs). Not a test
// file itself: the suite collects only *.test.mjs.
//
// F10: every navigation link of every role goes where it says.
//
// Found by the production cold inspection of 5449890 (D-R2b-1, D-R2b-2):
// the owner's ACCOUNT tab set #/account and, within 200 ms, owner.js
// rewrote the hash to #/today, so the owner could not reach Account (and
// so could not sign out). No test walked the tabs, so nothing noticed.
//
// Real headless Chromium against the local `wrangler dev`, like
// portal-ui-b2.test.mjs: needs puppeteer-core on NODE_PATH
// (NODE_PATH=/home/mike/wzq/node_modules) and the tests skip, not go red,
// without it. Sign-in is the local dev-login only (PORTAL_DEV_LOGIN, demo
// accounts); nothing here reaches a real account.

import assert from "node:assert/strict";
import { BASE_URL, loginDemo, d1 } from "./helpers.mjs";

const CHROMIUM_PATH = "/usr/bin/chromium-browser";
export const EDGE_PX = 16; // Clinton 2026-09-17: nothing closer than 16 px to a screen edge
export const TAP_PX = 44; // minimum tap target size

// Each role's tabs, in bar order: the href, and the root x-data of the
// screen that tab must mount.
export const ROLES = {
  guest: {
    email: "guest.demo@jp-demo.test",
    tabs: { "#/home": "memberHome()", "#/book": "memberBook()", "#/bookings": "memberBookings()", "#/account": "accountHub()" },
  },
  member: {
    email: "member.demo@jp-demo.test",
    tabs: { "#/home": "memberHome()", "#/book": "memberBook()", "#/bookings": "memberBookings()", "#/account": "accountHub()" },
  },
  staff: {
    email: "staff.demo@jp-demo.test",
    tabs: { "#/calendar": "staffCalendar()", "#/account": "accountHub()" },
  },
  owner: {
    email: "owner.demo@jp-demo.test",
    tabs: {
      "#/today": "ownerToday()",
      "#/members": "ownerMembers()",
      "#/owner-book": "ownerBook()",
      "#/manage": "ownerManage()",
      "#/account": "accountHub()",
    },
  },
};

// Same NODE_PATH resolver as portal-ui-b2.test.mjs (Node's ESM loader
// does not honour NODE_PATH for bare specifiers).
export async function loadPuppeteer() {
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

export async function withBrowser(puppeteer, fn) {
  const browser = await puppeteer.launch({ executablePath: CHROMIUM_PATH, headless: "new", args: ["--no-sandbox"] });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

// auth/start allows 5 per email per 15 minutes, so each demo account
// signs in ONCE per test file and every page reuses the session cookie.
const sessionCookies = new Map();

export async function openPortal(browser, role, width, height = 844) {
  const { email } = ROLES[role];
  if (!sessionCookies.has(email)) {
    d1(`DELETE FROM rate_limits`);
    const { client } = await loginDemo(email);
    const [name, ...rest] = client.getCookie().split("=");
    sessionCookies.set(email, { name, value: rest.join("=") });
  }
  const { name, value } = sessionCookies.get(email);
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setCookie({ name, value, url: BASE_URL });
  await page.goto(`${BASE_URL}/portal/`, { waitUntil: "domcontentloaded" });
  // Ready: the role's bar has drawn all its tabs and a screen is mounted.
  const want = Object.keys(ROLES[role].tabs).length;
  await page.waitForFunction(
    (n) => {
      const bar = [...document.querySelectorAll("nav")].find((x) => x.getClientRects().length > 0 && x.querySelector("a"));
      return bar && bar.querySelectorAll("a").length === n && document.querySelector("#portal-area [x-data]");
    },
    { timeout: 60000 },
    want
  );
  return page;
}

// Everything the assertions read, in one in-page call: the hash, the
// mounted screen, and the visible bar's links with their rendered boxes.
// "Visible bar" is whichever nav is drawn at this width: the bottom bar
// below 768 px, the header links from 768 px up.
export function readNav() {
  const bar = [...document.querySelectorAll("nav")].find((x) => x.getClientRects().length > 0 && x.querySelector("a"));
  const root = document.querySelector("#portal-area [x-data]");
  const links = bar ? [...bar.querySelectorAll("a")] : [];
  return {
    hash: window.location.hash,
    screen: root ? root.getAttribute("x-data") : null,
    links: links.map((a) => {
      const hit = a.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(a);
      const label = range.getBoundingClientRect();
      const cs = getComputedStyle(a);
      return {
        href: a.getAttribute("href"),
        text: a.textContent.trim(),
        current: a.getAttribute("aria-current"),
        look: [cs.color, cs.backgroundColor, cs.boxShadow, cs.textDecorationLine, cs.fontWeight].join(" | "),
        hit: { left: hit.left, right: hit.right, width: hit.width, height: hit.height },
        label: { left: label.left, right: label.right },
      };
    }),
    viewport: window.innerWidth,
  };
}

// Click the link the person can see. (`nav a[href=...]` alone would find
// the hidden desktop copy first at phone width.)
export async function clickVisibleTab(page, href) {
  const handle = await page.evaluateHandle((h) => {
    const bar = [...document.querySelectorAll("nav")].find((x) => x.getClientRects().length > 0 && x.querySelector("a"));
    return bar ? [...bar.querySelectorAll("a")].find((a) => a.getAttribute("href") === h) : null;
  }, href);
  const el = handle.asElement();
  assert.ok(el, `no visible nav link with href ${href}`);
  await el.click();
}

// The problems with one state of the page, given the tab that should be
// showing. Returns [] when the page is right.
export function problemsFor(state, href, tabs, where) {
  const out = [];
  if (state.hash !== href) out.push(`${where} ${href}: hash is "${state.hash}" after 2 s, expected "${href}"`);
  if (state.screen !== tabs[href]) out.push(`${where} ${href}: mounted screen is ${state.screen}, expected ${tabs[href]}`);
  const current = state.links.filter((l) => l.current === "page").map((l) => l.href);
  if (current.length !== 1 || current[0] !== href) {
    out.push(`${where} ${href}: tabs marked aria-current=page are [${current.join(", ")}], expected only [${href}]`);
  }
  const mine = state.links.find((l) => l.href === href);
  const others = state.links.filter((l) => l.href !== href);
  if (mine && others.some((o) => o.look === mine.look)) {
    out.push(`${where} ${href}: the active tab looks the same as an inactive one (${mine.look})`);
  }
  if (new Set(others.map((o) => o.look)).size > 1) {
    out.push(`${where} ${href}: inactive tabs do not all look alike`);
  }
  return out;
}

// After a click or a hash change the page must settle on `href`'s screen.
// It is read at 2 s as the story says; when the shared dev server is busy
// (this host runs at load 20 to 70 and each navigation makes four /me
// calls) a mount can land late, so a wrong reading is read again every
// half second before it counts. A redirect, which is what D-R2b-1 was,
// never comes right. `grace` is one allowance for the whole walk (10 s):
// once a wrong state has outlasted it, later links are read at 2 s only,
// so a broken page fails with its full list of problems instead of timing
// the file out.
export async function settleOn(page, href, tabs, where, grace = { ms: 10000 }) {
  await new Promise((r) => setTimeout(r, 2000));
  let problems = problemsFor(await page.evaluate(readNav), href, tabs, where);
  while (problems.length > 0 && grace.ms > 0) {
    await new Promise((r) => setTimeout(r, 500));
    grace.ms -= 500;
    problems = problemsFor(await page.evaluate(readNav), href, tabs, where);
  }
  return problems;
}

// Click every link of the role's visible bar at this width, one after the
// other, and collect what is wrong after each.
export async function walkEveryLink(browser, role, width) {
  const { tabs } = ROLES[role];
  const page = await openPortal(browser, role, width);
  const problems = [];
  const grace = { ms: 10000 };
  try {
    const hrefs = (await page.evaluate(readNav)).links.map((l) => l.href);
    assert.deepEqual(hrefs, Object.keys(tabs), `${role} at ${width}: the bar's tabs are not the ones this test declares`);
    for (const href of hrefs) {
      await clickVisibleTab(page, href);
      problems.push(...(await settleOn(page, href, tabs, `${role}@${width}`, grace)));
    }
  } finally {
    await page.close();
  }
  return problems;
}
