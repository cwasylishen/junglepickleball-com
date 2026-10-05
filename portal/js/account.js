// Account hub (screens.md §2.2/M7). Owns exactly `#/account` -- the
// sub-routes (billing/history/household) are portal/js/member.js's view
// files; `#/account/app` and `#/account/passkeys` are mounted by
// portal/js/pwa.js (B2e) and portal/js/passkeys.js (B2c) themselves into
// the two mount points this file's view (account.html) leaves for them
// (ui-structure.md).

if (!window.t) {
  window.t = function (key, vars) {
    var s = (window.STR && window.STR.en && window.STR.en[key]) || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
    return s;
  };
}

window.PortalApp.mergeStrings({
  "tab.account": "Account",
  "account.billing": "Billing",
  "account.history": "History",
  "account.household": "Household",
  "account.app": "App and reminders",
  "account.passkeys": "Passkeys",
  "account.sign_out": "Sign out",
  "account.signed_out": "You're signed out.",
  "account.hint_billing_off": "Not switched on",
  "chip.owner": "Owner",
  "chip.staff": "Staff",
  "chip.member": "Member",
  "chip.guest": "Guest",
});

// screens.md §2.2: which Account rows a role sees.
var ACCOUNT_ROWS_BY_ROLE = {
  guest: ["billing", "history"],
  member: ["billing", "history", "household"],
  staff: [],
  owner: [],
};

async function mountAccountRoute() {
  var session = await window.PortalApp.bootstrapSession();
  if (!session.authenticated) return false;
  var hash = window.location.hash || "";
  if (hash !== "#/account" && hash !== "#/account/") return false;

  var area = document.getElementById("portal-area");
  var html = await fetch("/portal/views/account.html").then(function (r) { return r.text(); });
  area.innerHTML = html;
  if (window.Alpine) window.Alpine.initTree(area);
  return true;
}

window.addEventListener("hashchange", function () { mountAccountRoute(); });
window.addEventListener("DOMContentLoaded", function () {
  mountAccountRoute();
  var toastMsg = window.sessionStorage.getItem("jp_toast");
  if (toastMsg) window.sessionStorage.removeItem("jp_toast");
});

window.PortalAreas.account = { mountAccountRoute: mountAccountRoute };

function accountHub() {
  return {
    loading: true,
    account: null,
    features: {},
    toast: window.sessionStorage.getItem("jp_toast") || "",
    t: window.t,
    async load() {
      this.loading = true;
      var me = await PortalApi.get("/api/portal/me");
      if (me.ok && me.data && me.data.authenticated) {
        this.account = me.data.account;
        this.features = me.data.features || {};
      }
      this.loading = false;
      if (this.toast) {
        window.sessionStorage.removeItem("jp_toast");
        var self = this;
        setTimeout(function () { self.toast = ""; }, 3000);
      }
    },
    showRow(row) {
      if (!this.account) return false;
      return (ACCOUNT_ROWS_BY_ROLE[this.account.role] || []).indexOf(row) !== -1;
    },
    async signOut() {
      await PortalApi.post("/api/portal/auth/logout", {});
      window.sessionStorage.setItem("jp_toast", t("account.signed_out"));
      window.location.hash = "";
      window.location.reload();
    },
  };
}
