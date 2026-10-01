// Staff area (screens.md §6: S1 calendar). D-A16: staff see only start,
// end, resource, display name and state -- never email, phone, notes,
// price or payment detail beyond "awaiting payment". Router glue per
// ui-structure.md, same pattern as portal/js/member.js.

if (!window.t) {
  window.t = function (key, vars) {
    var s = (window.STR && window.STR.en && window.STR.en[key]) || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
    return s;
  };
}
if (!window.crTime) {
  window.crTime = function (iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  };
}
if (!window.crDate) {
  window.crDate = function (iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  };
}
if (!window.crDateOnly) {
  window.crDateOnly = function (iso) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  };
}
if (!window.chipClass) {
  window.chipClass = function (status) {
    var map = {
      held: "bg-[#fffbeb] text-[#92400e]",
      blocked: "bg-slate-100 text-slate-500",
      paid_conflict: "bg-[#fee2e2] text-[#b91c1c]",
    };
    return map[status] || "bg-slate-100 text-slate-600";
  };
}

window.PortalApp.mergeStrings({
  "tab.calendar": "Calendar",
  "staff.top": "{n} bookings on {date}",
  "staff.free": "Free {start}–{end}",
  "staff.empty_day": "No bookings on {date}.",
  "staff.no_resource": "You're not assigned to a calendar yet. Ask Roger to assign you.",
  "staff.awaiting": "Awaiting payment",
  "slot.blocked": "Closed",
  "chip.held": "Held",
  "chip.paid_conflict": "Paid, time taken",
  "act.retry": "Try again",
});

async function mountStaffRoute() {
  var session = await window.PortalApp.bootstrapSession();
  if (!session.authenticated) return false;
  if (session.account.role !== "staff") return false;

  var hash = window.location.hash || "#/calendar";
  if (hash.indexOf("#/account") === 0) return false; // account.js owns the hub

  var area = document.getElementById("portal-area");
  var template = hash.indexOf("#/calendar") === 0 ? "staff.html" : null;
  if (!template) { window.location.hash = "#/calendar"; return true; }

  var html = await fetch("/portal/views/" + template).then(function (r) { return r.text(); });
  area.innerHTML = html;
  if (window.Alpine) window.Alpine.initTree(area);
  return true;
}

window.addEventListener("hashchange", function () { mountStaffRoute(); });
window.addEventListener("DOMContentLoaded", function () { mountStaffRoute(); });
window.PortalAreas.staff = { mountStaffRoute: mountStaffRoute };

function staffCalendar() {
  return {
    loading: true,
    error: false,
    noResource: false,
    resourceName: "",
    date: window.crDateOnly(new Date().toISOString()),
    dateOptions: [],
    rows: [],
    t: window.t,
    crTime: window.crTime,
    chipClass: window.chipClass,
    async load() {
      this.buildDateOptions();
      await this.loadDay();
    },
    buildDateOptions() {
      // D-A13: staff have no window -- 7 back, 14 forward (screens §6).
      this.dateOptions = [];
      for (var i = -7; i <= 14; i++) {
        var d = new Date();
        d.setUTCDate(d.getUTCDate() + i);
        this.dateOptions.push(crDateOnly(d.toISOString()));
      }
    },
    weekdayLabel(d) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", weekday: "short" }).format(new Date(d + "T12:00:00Z")); },
    dayNumber(d) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", day: "numeric" }).format(new Date(d + "T12:00:00Z")); },
    crDateLabel(d) { return crDate(d + "T12:00:00Z"); },
    pickDate(d) { this.date = d; this.loadDay(); },
    resourceTitle() { return this.resourceName || t("tab.calendar"); },
    topLine() { return t("staff.top", { n: this.bookingCount(), date: this.crDateLabel(this.date) }); },
    bookingCount() { return this.rows.filter(function (r) { return r.kind === "booking"; }).length; },
    async loadDay() {
      this.loading = true;
      this.error = false;
      this.noResource = false;
      var res = await PortalApi.get("/api/portal/staff/calendar?date=" + this.date);
      this.loading = false;
      if (!res.ok) {
        if (res.error === "staff_no_resource") { this.noResource = true; return; }
        this.error = true;
        return;
      }
      var items = res.data || [];
      if (items.length > 0 && items[0].resource) this.resourceName = items[0].resource;
      this.rows = this.withGaps(items);
    },
    // Renders confirmed bookings and blocks as rows, with a thin "free"
    // row filling each gap between them (screens §6: "so the day reads
    // as a schedule, not just a list").
    withGaps(items) {
      var sorted = items.slice().sort(function (a, b) { return a.start.localeCompare(b.start); });
      var out = [];
      var cursor = null;
      sorted.forEach(function (it) {
        if (cursor && it.start > cursor) out.push({ kind: "free", start: cursor, end: it.start });
        out.push(Object.assign({ kind: it.state === "blocked" ? "blocked" : "booking" }, it));
        cursor = it.end;
      });
      return out;
    },
  };
}
