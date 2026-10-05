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
    "auth.age_confirm_title": "Confirm your age",
    "auth.age_confirm_body": "You must be 16 or older to create a Jungle Pickleball account.",
    "auth.age_confirm_checkbox": "I confirm I am 16 years of age or older.",
    "auth.age_confirm_submit": "Continue",
    "auth.age_confirm_error": "Please confirm your age to continue.",
    "auth.link_sent": "If that address can receive email, a sign-in link is on its way. It works once and expires in 15 minutes.",
    "auth.email_unavailable": "Email sign-in is not available right now. Please try again later.",
    "auth.email_invalid": "Enter a valid email address.",
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
  if (!res.ok || !res.data) return { authenticated: false, features: {}, account: null };
  // PF-4: signed out is 200 {user:null, authenticated:false, features}.
  // Keep the features (the shell reads them before login), drop the user.
  if (res.data.user === null) return { authenticated: false, features: res.data.features || {}, account: null };
  if (res.data.csrf_token) PortalApi.setCsrfToken(res.data.csrf_token);
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
  // M7/CTL-AUTH-05: the token is returned alongside the result so the
  // caller can ask the person the age question and retry the SAME
  // token with their answer -- it is never re-sent as a query string
  // or GET, only ever via this same POST path.
  return { ...res, token };
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
    loginSent: false,
    loginError: "",
    // M7/CTL-AUTH-05/CTL-UI-04: a brand-new email verifying for the
    // first time gets 409 age_confirmation_required from the server --
    // this holds that pending token and shows the age prompt so the
    // person actually answers the question, instead of the UI
    // fabricating an answer it never asked.
    ageConfirmToken: null,
    ageConfirmError: false,
    ageChecked: false,
    async init() {
      // portal(FR3b): the one call into pwa.js (ui-structure.md,
      // inspection-2.md N3) -- registers the service worker and mounts
      // the account area's install/reminders row once it exists. Never
      // awaited: a failed/slow registration must not block sign-in.
      if (window.PortalPwa && typeof window.PortalPwa.init === "function") window.PortalPwa.init();
      const verifyResult = await window.PortalApp.handleLoginFragment();
      if (verifyResult && verifyResult.error === "age_confirmation_required") {
        this.ageConfirmToken = verifyResult.token;
        return;
      }
      const wasAuthenticated = this.session.authenticated;
      await this.refreshSession();
      // portal(FR4-A/D1): each area module's own router (owner.js/
      // member.js/staff.js) mounts on DOMContentLoaded, which already
      // ran -- before this init() finished awaiting verify -- and found
      // `session.authenticated` false, so it bailed without rendering.
      // Firing the same "hashchange" those routers already listen for
      // makes them re-check the (now authenticated) session and mount
      // the role's default view, with no new wiring in any area file.
      if (!wasAuthenticated && this.session.authenticated) {
        window.dispatchEvent(new Event("hashchange"));
      }
    },
    async refreshSession() {
      this.session = await window.PortalApp.bootstrapSession();
      this.nav = window.PortalApp.navForRole(this.session.account ? this.session.account.role : null);
    },
    async startLogin() {
      // age_16_plus is never sent here -- /auth/start ignores it, and
      // the person has not been asked anything yet at this point.
      this.loginSent = false;
      this.loginError = "";
      const res = await PortalApi.post("/api/portal/auth/start", { email: this.loginEmail });
      if (res.status === 503 && res.error === "email_unavailable") {
        this.loginError = STR.en["auth.email_unavailable"];
        return;
      }
      if (res.status === 400) {
        this.loginError = STR.en["auth.email_invalid"];
        return;
      }
      if (!res.ok) {
        this.loginError = STR.en["state.error_body"];
        return;
      }
      this.loginSent = true;
      if (res.data && res.data.dev_link) {
        this.devLink = res.data.dev_link;
        // eslint-disable-next-line no-console
        console.info("[portal demo login]", res.data.dev_link);
      }
    },
    // Called from the age-confirmation prompt's own "I'm 16 or older"
    // control (portal/index.html) -- the one place this attestation is
    // actually collected, retrying the SAME magic-link token.
    async confirmAge16Plus() {
      this.ageConfirmError = false;
      const res = await PortalApi.post("/api/portal/auth/verify", { token: this.ageConfirmToken, age_16_plus: true });
      if (!res.ok) {
        this.ageConfirmError = true;
        return;
      }
      this.ageConfirmToken = null;
      await this.refreshSession();
      // Same D1 fix as init(): the area routers' DOMContentLoaded mount
      // already ran and bailed unauthenticated, so re-check now.
      if (this.session.authenticated) window.dispatchEvent(new Event("hashchange"));
    },
  };
}
window.portalShell = portalShell;
