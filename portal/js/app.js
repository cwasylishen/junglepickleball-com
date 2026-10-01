// Portal app bootstrap: session/me fetch, role-based nav, STR merge,
// and the S-6 fragment-login handler (the ONLY code that ever reads
// `#login=<token>` -- it is never sent as a query string or to a GET).
//
// Each area module (member.js, owner.js, staff.js, account.js --
// B2f1/B2f2) registers itself by setting `window.PortalAreas[name]` to
// an Alpine component definition and listing its route prefix in
// ui-structure.md. This file only owns the shell: nav visibility,
// bootstrap, and the login fragment.

window.STR = window.STR || { en: {} };
function mergeStrings(dict) {
  Object.assign(window.STR.en, dict || {});
}
window.PortalAreas = window.PortalAreas || {};

window.STR.en = Object.assign(
  {
    "shell.preview_badge": "PREVIEW -- not the live portal",
    "auth.signed_out": "You were signed out. Sign in to continue.",
    "state.error_title": "Something went wrong",
    "state.error_body": "Please try again.",
    "state.offline": "You're offline. Check your connection and retry.",
    "state.forbidden": "You don't have access to that page.",
    "state.not_found": "That page doesn't exist.",
    "state.rate_limited": "Too many attempts. Please wait and try again.",
    "act.retry": "Retry",
    "nc.stripe_payments": "Payments are not switched on yet.",
    "nc.stripe_billing": "Billing is not switched on yet.",
    "nc.push": "Reminders are not switched on yet.",
    "nc.gcal": "Calendar sync is not switched on yet.",
    // Bottom-nav labels (NAV_BY_ROLE below) -- the only place this shell
    // renders a string outside STR.en (PIN-10), so these keys live here
    // rather than in each area's own dictionary.
    "nav.home": "Home",
    "nav.book": "Book",
    "nav.bookings": "Bookings",
    "nav.account": "Account",
    "nav.calendar": "Calendar",
    "nav.today": "Today",
    "nav.members": "Members",
    "nav.manage": "Manage",
  },
  window.STR.en
);

// Tabs per role (screens.md §2.2). Each entry: [route, label key].
const NAV_BY_ROLE = {
  guest: [["#/home", "nav.home"], ["#/book", "nav.book"], ["#/bookings", "nav.bookings"], ["#/account", "nav.account"]],
  member: [["#/home", "nav.home"], ["#/book", "nav.book"], ["#/bookings", "nav.bookings"], ["#/account", "nav.account"]],
  staff: [["#/calendar", "nav.calendar"], ["#/account", "nav.account"]],
  owner: [["#/today", "nav.today"], ["#/members", "nav.members"], ["#/owner-book", "nav.book"], ["#/manage", "nav.manage"], ["#/account", "nav.account"]],
};

function navForRole(role) {
  return NAV_BY_ROLE[role] || [];
}

async function bootstrapSession() {
  const res = await PortalApi.get("/api/portal/me");
  if (!res.ok) return { authenticated: false, features: {}, account: null };
  if (res.data && res.data.csrf_token) PortalApi.setCsrfToken(res.data.csrf_token);
  return res.data;
}

// S-6: the magic-link token lives only in the URL fragment
// (`/portal/#login=<token>`). This reads it, clears it from the visible
// URL with history.replaceState (never a GET to the server), and POSTs
// it to verify. A plain GET -- including this page load itself -- never
// consumes the token; only the POST below does.
async function handleLoginFragment() {
  const match = /^#login=(.+)$/.exec(window.location.hash);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  history.replaceState(null, "", window.location.pathname + window.location.search);
  const res = await PortalApi.post("/api/portal/auth/verify", { token });
  return res;
}

window.PortalApp = { navForRole, bootstrapSession, handleLoginFragment, mergeStrings };

// portal(FR1): moved out of index.html's inline <script> tag -- CTL-HDR-01's
// CSP (`script-src 'self'`) blocks an inline script with no hash/nonce, and
// Alpine's x-data="portalShell()" resolves against any function in scope,
// whether it got there via an inline tag or (as here) an external file, so
// moving it costs nothing. Same body as before, verbatim.
function portalShell() {
  return {
    session: { authenticated: false, features: {}, account: null },
    nav: [],
    loginEmail: "",
    devLink: null,
    async init() {
      const verifyResult = await window.PortalApp.handleLoginFragment();
      if (verifyResult && verifyResult.ok) {
        await this.refreshSession();
        return;
      }
      await this.refreshSession();
    },
    async refreshSession() {
      this.session = await window.PortalApp.bootstrapSession();
      this.nav = window.PortalApp.navForRole(this.session.account ? this.session.account.role : null);
    },
    async startLogin() {
      const res = await PortalApi.post("/api/portal/auth/start", { email: this.loginEmail, age_16_plus: true });
      if (res.data && res.data.dev_link) {
        this.devLink = res.data.dev_link;
        // eslint-disable-next-line no-console
        console.info("[portal demo login]", res.data.dev_link);
      }
    },
  };
}
window.portalShell = portalShell;
