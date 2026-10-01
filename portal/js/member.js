// Member/guest area (screens.md §4: M1 home, M2 booking flow, M3 bookings,
// M4 billing, M5 history, M6 household). Registers Alpine component
// factories on window (same pattern as portal/index.html's portalShell())
// and the "area's own router glue" ui-structure.md calls for: on
// hashchange it fetches this area's view template into #portal-area and
// lets Alpine process the newly-injected DOM.
//
// GET /api/portal/me now carries `credits` (portal(FR1), api.md §2). It
// still has no entitlement `ends_at`, so this file shows membership
// status without a specific end date rather than inventing one.

if (!window.t) {
  window.t = function (key, vars) {
    var s = (window.STR && window.STR.en && window.STR.en[key]) || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split("{" + k + "}").join(String(vars[k]));
      });
    }
    return s;
  };
}
if (!window.crDate) {
  window.crDate = function (iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  };
}
if (!window.crTime) {
  window.crTime = function (iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  };
}
if (!window.crDateOnly) {
  // CR calendar date (YYYY-MM-DD) for an ISO instant -- used to build the
  // date strip and as the `date=` query to the availability endpoint
  // (PIN-6: the device's own time zone is never used for this).
  window.crDateOnly = function (iso) {
    var d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    return d; // en-CA formats as YYYY-MM-DD
  };
}
if (!window.moneyFmt) {
  window.moneyFmt = function (cents) {
    return "$" + (Number(cents || 0) / 100).toFixed(2);
  };
}
if (!window.chipClass) {
  window.chipClass = function (status) {
    var map = {
      active: "bg-[#dcfce7] text-[#15803d]",
      confirmed: "bg-[#dcfce7] text-[#15803d]",
      held: "bg-[#fffbeb] text-[#92400e]",
      held_mine: "bg-[#fffbeb] text-[#92400e]",
      ending: "bg-[#fffbeb] text-[#92400e]",
      past_due: "bg-[#fffbeb] text-[#92400e]",
      paid_conflict: "bg-[#fee2e2] text-[#b91c1c]",
      expired: "bg-[#fee2e2] text-[#b91c1c]",
      cancelled: "bg-slate-100 text-slate-500",
      blocked: "bg-slate-100 text-slate-500",
      paid: "bg-[#dcfce7] text-[#15803d]",
      refunded: "bg-slate-100 text-slate-500",
      failed: "bg-[#fee2e2] text-[#b91c1c]",
    };
    return map[status] || "bg-slate-100 text-slate-600";
  };
}

window.PortalApp.mergeStrings({
  "home.hello": "Hi, {first_name}",
  "home.next_label": "Next up",
  "home.players": "{n} players",
  "home.hold_title": "Finish paying for {resource}, {date} {time}",
  "home.hold_ends": "Your hold ends at {time}.",
  "home.book_court": "Book a court",
  "home.book_massage": "Massage",
  "home.book_plunge": "Cold plunge",
  "home.status_member": "{tier} member · active until {date}",
  "home.status_member_no_date": "{tier} member · active",
  "home.status_guest": "Not a member. You can book 2 days ahead and pay per player.",
  "home.credits": "{n} court credits left",
  "home.no_credits": "No court credits",
  "home.upcoming_label": "Coming up",
  "home.all_bookings": "All bookings",
  "home.empty_title": "No bookings yet",
  "home.empty_body": "Courts are open {open}–{close} every day.",
  "nc.stripe_title": "Payments are not switched on yet",
  "nc.stripe_book_body": "You can't pay online for this booking yet.",
  "nc.stripe_billing_body": "When they are, you'll manage your card and membership here.",
  "nc.stripe_history_body": "Your payment history will show here once they are.",
  "act.view": "View",
  "act.cancel": "Cancel",
  "act.pay_now": "Pay now",
  "act.done": "Done",
  "act.back": "Back",
  "act.show_more": "Show more",

  "book.title": "Book",
  "book.pick_top": "What do you want to book?",
  "book.courts_label": "Courts",
  "book.amenities_label": "Wellness",
  "book.included": "Included",
  "book.price_per_player": "{price} per player",
  "book.price_per_booking": "{price}",
  "book.price_not_set": "Not bookable yet: price not set",
  "book.no_resources": "Nothing is open for booking right now.",
  "book.massage_durations": "60 or 90 min",
  "book.duration_top": "How long?",
  "book.duration_first": "Pick a length to see free times",
  "book.slots_top": "{free} of {total} times free on {date}",
  "book.day_full": "Nothing free on {date}. Try another day.",
  "book.players_top": "How many players, including you?",
  "book.cost_included": "Included in your membership",
  "book.pay_credits": "Use {n} credits ({left} left after)",
  "book.confirm_top": "Check and confirm",
  "book.cancel_rule": "Free to cancel until {cutoff} before the start.",
  "book.confirm": "Confirm booking",
  "book.to_payment": "Continue to payment",
  "book.opening_payment": "Opening secure payment…",
  "book.use_credits_instead": "Use credits instead",
  "book.done_title": "You're booked",
  "book.err_taken": "Someone just took that time. Pick another.",
  "book.err_window": "That date is outside your booking window.",
  "book.err_past": "That time has already passed.",
  "book.err_cap": "You already have {n} upcoming bookings for {resource}, the most allowed.",
  "book.err_blocked": "That time is closed.",
  "book.err_credits": "You don't have enough credits for that.",
  "book.err_price_not_set": "This can't be booked online yet: the club hasn't set a price.",
  "slot.available": "Free",
  "slot.taken": "Booked",
  "slot.held": "On hold",
  "slot.blocked": "Closed",
  "slot.my_hold": "Your hold",
  "slot.mine": "Yours",

  "bookings.top": "{n} coming up",
  "bookings.none_top": "Nothing coming up",
  "bookings.upcoming": "Upcoming",
  "bookings.past": "Past",
  "bookings.too_late": "Can't cancel within {cutoff} of the start",
  "bookings.empty_upcoming": "No upcoming bookings.",
  "bookings.empty_past": "Bookings you've played show here.",
  "cancel.title": "Cancel {resource}, {date} {time}?",
  "cancel.credits_back": "{n} credits go back to your balance.",
  "cancel.paid_note": "This doesn't refund your card payment. Contact the club about a refund.",
  "cancel.confirm": "Cancel booking",
  "cancel.keep": "Keep it",
  "cancel.done": "Booking cancelled.",
  "cancel.err_cutoff": "It's too close to the start to cancel online. Contact the club.",

  "account.billing": "Billing",
  "account.history": "History",
  "account.household": "Household",
  "account.hint_billing_off": "Not switched on",
  "billing.top": "Your card, invoices and membership are managed on Stripe's secure page.",
  "billing.open": "Open billing ↗",
  "billing.opening": "Opening Stripe…",
  "billing.no_cards_here": "We never see or store your card number.",
  "billing.open_failed": "Couldn't open billing. Try again.",
  "history.top": "{n} payments",
  "history.empty_top": "No payments yet",
  "history.empty_title": "No payments yet",
  "history.empty_body": "Payments you make online show here.",
  "history.paid": "Paid",
  "history.refunded": "Refunded",
  "history.partial_refund": "Part refunded",
  "history.failed": "Failed",
  "household.top": "{tier}: {adults} adults, {kids} kids",
  "household.you": "You",
  "household.no_partner": "No partner linked yet. Ask the club to link your partner's account.",
  "household.single": "Single membership: one adult",
  "household.kid_allowance": "{used} of {max} free kid places used",
  "household.readonly": "To add a kid or link a partner, ask at the club.",
  "chip.free": "Free",
  "chip.confirmed": "Confirmed",
  "chip.cancelled": "Cancelled",
  "chip.held": "Held",
  "chip.held_mine": "Held",
  "chip.paid_conflict": "Paid, no slot",
  "chip.active": "Active",
  "chip.ending": "Ending soon",
  "chip.past_due": "Payment failed",
  "chip.expired": "Expired",
});

function slugifyWant(name) {
  var n = (name || "").toLowerCase();
  if (n.indexOf("massage") !== -1) return "massage";
  if (n.indexOf("plunge") !== -1) return "plunge";
  return null;
}

async function mountMemberRoute() {
  var session = await window.PortalApp.bootstrapSession();
  if (!session.authenticated) return false;
  var role = session.account.role;
  if (role !== "member" && role !== "guest") return false;

  var hash = window.location.hash || "#/home";
  var area = document.getElementById("portal-area");
  var template = null;

  // "#/bookings" is checked before "#/book": "#/book" is a string
  // prefix of "#/bookings" too, so the more specific route goes first.
  if (hash === "" || hash === "#" || hash.indexOf("#/home") === 0) template = "member-home.html";
  else if (hash.indexOf("#/bookings") === 0) template = "member-bookings.html";
  else if (hash.indexOf("#/book") === 0) template = "member-book.html";
  else if (hash.indexOf("#/account/billing") === 0) template = "member-billing.html";
  else if (hash.indexOf("#/account/history") === 0) template = "member-history.html";
  else if (hash.indexOf("#/account/household") === 0) {
    if (role === "guest") { window.location.hash = "#/home"; return true; } // D-A02/D-A03: member-only
    template = "member-household.html";
  } else if (hash.indexOf("#/account") === 0) {
    return false; // account.js owns the hub itself
  } else {
    // Unknown or an owner/staff-only route: this role's home tab (ground rule 1).
    window.location.hash = "#/home";
    return true;
  }

  var html = await fetch("/portal/views/" + template).then(function (r) { return r.text(); });
  area.innerHTML = html;
  if (window.Alpine) window.Alpine.initTree(area);
  return true;
}

window.addEventListener("hashchange", function () { mountMemberRoute(); });
window.addEventListener("DOMContentLoaded", function () { mountMemberRoute(); });
window.PortalAreas.member = { mountMemberRoute: mountMemberRoute };

// ---- M1 Home ------------------------------------------------------------

var TIER_NAMES = {
  jp_annual_single: "Annual Single",
  jp_annual_couples: "Annual Couples",
  jp_6m_single: "6 Month",
  jp_6m_couples: "6 Month Couples",
  jp_3m_single: "3 Month",
  jp_3m_couples: "3 Month Couples",
  jp_1m_single: "1 Month",
};

function memberHome() {
  return {
    loading: true,
    error: false,
    firstName: "",
    nextUp: null,
    holdBooking: null,
    comingUp: [],
    statusTint: "page",
    statusLine: "",
    creditsLine: "",
    t: window.t,
    crDate: window.crDate,
    crTime: window.crTime,
    chipClass: window.chipClass,
    async load() {
      this.loading = true;
      this.error = false;
      var me = await PortalApi.get("/api/portal/me");
      if (!me.ok || !me.data || !me.data.authenticated) { this.error = true; this.loading = false; return; }
      var account = me.data.account;
      this.firstName = (account.display_name || account.email || "").split(" ")[0];
      var list = await PortalApi.get("/api/portal/bookings");
      if (!list.ok) { this.error = true; this.loading = false; return; }
      var bookings = (list.data || []).filter(function (b) { return b.status !== "cancelled"; });
      var nowIso = new Date().toISOString();
      var upcoming = bookings
        .filter(function (b) { return b.end > nowIso; })
        .sort(function (a, b) { return a.start.localeCompare(b.start); });
      this.holdBooking = upcoming.find(function (b) { return b.status === "held" || b.status === "held_mine"; }) || null;
      var rest = upcoming.filter(function (b) { return b !== this.holdBooking; }, this);
      this.nextUp = rest[0] || null;
      this.comingUp = rest.slice(1, 4);
      var ent = me.data.entitlement || { entitled: false };
      if (ent.entitled) {
        this.statusTint = "ok";
        var tierName = TIER_NAMES[ent.tier] || ent.tier || "";
        this.statusLine = t("home.status_member_no_date", { tier: tierName });
      } else {
        this.statusTint = "page";
        this.statusLine = t("home.status_guest");
      }
      var credits = me.data.credits || 0;
      this.creditsLine = credits > 0 ? t("home.credits", { n: credits }) : t("home.no_credits");
      this.loading = false;
    },
    async cancelFromHome(id) {
      await PortalApi.post("/api/portal/bookings/" + id + "/cancel", {});
      this.load();
    },
  };
}

// ---- M2 Booking flow -----------------------------------------------------

function memberBook() {
  return {
    loadingResources: true,
    resourceError: false,
    resources: [],
    resource: null,
    offering: null,
    dateOptions: [],
    date: null,
    loadingSlots: false,
    slotError: false,
    slots: [],
    slot: null,
    partySize: 1,
    loadingQuote: false,
    quote: null,
    confirming: false,
    confirmError: "",
    done: false,
    features: {},
    t: window.t,
    crTime: window.crTime,
    async load() {
      this.loadingResources = true;
      this.resourceError = false;
      var me = await PortalApi.get("/api/portal/me");
      if (me.ok && me.data) this.features = me.data.features || {};
      var res = await PortalApi.get("/api/portal/resources");
      if (!res.ok) { this.resourceError = true; this.loadingResources = false; return; }
      this.resources = (res.data || []).filter(function (r) { return r.active !== false; });
      this.loadingResources = false;

      var hash = window.location.hash || "";
      var m = /^#\/book\/([^?]+)/.exec(hash);
      var q = {};
      var qIdx = hash.indexOf("?");
      if (qIdx !== -1) new URLSearchParams(hash.slice(qIdx + 1)).forEach(function (v, k) { q[k] = v; });
      if (m) {
        var r = this.resources.find(function (x) { return x.id === m[1]; });
        if (r) this.pickResource(r);
      } else if (q.want) {
        var want = this.resources.find(function (x) { return slugifyWant(x.name) === q.want; });
        if (want) this.pickResource(want);
      }
      if (q.offering && this.resource) {
        var off = (this.resource.offerings || []).find(function (o) { return o.id === q.offering; });
        if (off) this.offering = off;
      }
      if (q.date) this.pickDate(q.date);
    },
    courts() { return this.resources.filter(function (r) { return r.kind === "court"; }); },
    amenities() { return this.resources.filter(function (r) { return r.kind !== "court"; }); },
    isMassage(r) { return r.kind === "massage"; },
    priceMode() { return this.resource && this.resource.kind === "court" ? "per_player" : "per_booking"; },
    priceLine(r) {
      if (r.member_included) return t("book.included");
      if (r.offerings && r.offerings.length === 1) return money(r.offerings[0].display_price_cents);
      return "";
    },
    pickResource(r) {
      // Deliberately does not write window.location.hash: the router
      // glue's hashchange listener fully re-fetches and re-mounts
      // member-book.html on every hash change (ui-structure.md's "own
      // router glue" is a simple fetch+innerHTML swap, not a diff), so
      // writing the route mid-flow raced the user's own date/slot
      // picks and silently reset them when the remount landed after a
      // later step. #/book/:resourceId still works as an *entry* point
      // (read once in load()); it is not re-synced after that.
      // FINDING: this means refresh/back mid-flow does not restore the
      // date/slot/offering already chosen -- only the resource.
      this.resource = r;
      this.offering = r.offerings && r.offerings.length === 1 ? r.offerings[0] : null;
      this.date = null;
      this.slots = [];
      this.slot = null;
      this.buildDateOptions();
    },
    pickOffering(o) {
      this.offering = o;
      this.slot = null;
      if (this.date) this.loadSlots();
    },
    reset() {
      this.resource = null;
      this.offering = null;
      this.date = null;
      this.slots = [];
      this.slot = null;
      this.done = false;
      window.location.hash = "#/book";
    },
    buildDateOptions() {
      // D-A13 base window (resource-level overrides are not exposed by
      // GET /api/portal/resources today -- flagged in the return).
      var days = this.resource && this.resource.kind !== "court" ? 7 : 7;
      var n = 7; // member default; guest default is 3 (today + 2)
      this.dateOptions = [];
      for (var i = 0; i < n; i++) {
        var d = new Date();
        d.setUTCDate(d.getUTCDate() + i);
        this.dateOptions.push(crDateOnly(d.toISOString()));
      }
    },
    weekdayLabel(d) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", weekday: "short" }).format(new Date(d + "T12:00:00Z")); },
    dayNumber(d) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", day: "numeric" }).format(new Date(d + "T12:00:00Z")); },
    crDateLabel(d) { return d ? crDate(d + "T12:00:00Z") : ""; },
    pickDate(d) {
      this.date = d;
      this.slot = null;
      this.loadSlots();
    },
    slotMinutes() { return (this.offering && this.offering.duration_minutes) || (this.resource && this.resource.slot_minutes) || 60; },
    gridCols() { return this.slotMinutes() <= 20 ? "grid-cols-4" : "grid-cols-2"; },
    async loadSlots() {
      if (!this.resource || !this.date) return;
      this.loadingSlots = true;
      this.slotError = false;
      var url = "/api/portal/resources/" + this.resource.id + "/availability?date=" + this.date;
      if (this.offering) url += "&offering_id=" + this.offering.id;
      var res = await PortalApi.get(url);
      if (!res.ok) { this.slotError = true; this.loadingSlots = false; return; }
      this.slots = (res.data && res.data.slots) || [];
      this.loadingSlots = false;
    },
    freeCount() { return this.slots.filter(function (s) { return s.state === "available"; }).length; },
    slotClass(s) {
      var map = {
        available: "bg-white border border-jpteal text-jpteal",
        taken: "bg-slate-100 text-slate-400",
        held: "bg-[#fffbeb] border border-dashed border-[#f59e0b] text-[#92400e]",
        held_mine: "bg-white border-2 border-[#f59e0b] text-[#92400e]",
        mine: "bg-white border-2 border-jpteal text-jpteal",
        blocked: "bg-[#f1f5f9] text-slate-400",
        past: "bg-white text-slate-300",
      };
      if (this.slot && this.slot.start === s.start) return "bg-jpteal text-jpyellow";
      return map[s.state] || "bg-white text-slate-500";
    },
    slotLabel(s) {
      var map = { taken: t("slot.taken"), held: t("slot.held"), held_mine: t("slot.my_hold"), mine: t("slot.mine"), blocked: t("slot.blocked") };
      return map[s.state] || crTime(s.end);
    },
    pickSlot(s) {
      this.slot = s;
      this.partySize = 1;
      this.loadQuote();
    },
    async loadQuote() {
      if (!this.resource || !this.slot) return;
      this.loadingQuote = true;
      this.quote = null;
      var url = "/api/portal/resources/" + this.resource.id + "/quote?start=" + encodeURIComponent(this.slot.start) + "&party_size=" + this.partySize;
      if (this.offering) url += "&offering_id=" + this.offering.id;
      var res = await PortalApi.get(url);
      this.loadingQuote = false;
      if (res.ok) this.quote = res.data;
    },
    quoteLine() {
      if (!this.quote) return "";
      if (this.quote.mode === "included") return t("book.cost_included");
      if (this.quote.mode === "credits") return t("book.pay_credits", { n: this.quote.credits_needed, left: this.quote.credits_have - this.quote.credits_needed });
      return money(this.quote.total_cents);
    },
    cutoffLabel() {
      var m = (this.quote && this.quote.cancel_cutoff_minutes) || 120;
      return m % 60 === 0 ? (m / 60) + "h" : m + "min";
    },
    needsStripeAndOff() {
      return this.quote && this.quote.mode === "card" && !this.features.stripe && !(this.quote.credits_have >= this.partySize && this.quote.credits_have > 0);
    },
    useCreditsInstead() {
      // Server decides mode; re-quoting with the same inputs is all the
      // UI needs to do -- the quote's own mode flips once credits cover it.
      this.loadQuote();
    },
    watchPartySize: null,
    async confirm() {
      if (!this.resource || !this.slot) return;
      this.confirming = true;
      this.confirmError = "";
      var body = { resource_id: this.resource.id, start: this.slot.start, party_size: this.partySize };
      if (this.offering) body.offering_id = this.offering.id;
      var res = await PortalApi.post("/api/portal/bookings", body);
      this.confirming = false;
      if (res.ok && res.data && res.data.booking) {
        var b = res.data.booking;
        if (b.checkout_url) { window.location.assign(b.checkout_url); return; }
        this.done = true;
        return;
      }
      var errMap = {
        slot_taken: t("book.err_taken"),
        outside_window: t("book.err_window"),
        in_past: t("book.err_past"),
        blocked: t("book.err_blocked"),
        cap_reached: t("book.err_cap", { n: "", resource: this.resource.name }),
        insufficient_credits: t("book.err_credits"),
        price_not_set: t("book.err_price_not_set"),
      };
      this.confirmError = errMap[res.error] || t("state.error_body");
      if (res.error === "slot_taken") this.loadSlots();
    },
  };
}

function money(cents) { return window.moneyFmt(cents); }

// ---- M3 My bookings -------------------------------------------------------

function memberBookings() {
  return {
    loading: true,
    error: false,
    tab: "upcoming",
    all: [],
    pastLimit: 20,
    pastHasMore: false,
    cancelTarget: null,
    cancelling: false,
    cancelError: "",
    toast: "",
    t: window.t,
    chipClass: window.chipClass,
    async load() {
      this.loading = true;
      this.error = false;
      var res = await PortalApi.get("/api/portal/bookings");
      if (!res.ok) { this.error = true; this.loading = false; return; }
      this.all = res.data || [];
      this.loading = false;
    },
    weekdayLabel(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", weekday: "short" }).format(new Date(iso)); },
    dayNumber(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Costa_Rica", day: "numeric" }).format(new Date(iso)); },
    crTime: window.crTime,
    topLine() {
      var n = this.upcomingList().length;
      return n > 0 ? t("bookings.top", { n: n }) : t("bookings.none_top");
    },
    upcomingList() {
      var now = new Date().toISOString();
      return this.all.filter(function (b) { return b.status !== "cancelled" && b.end > now; })
        .sort(function (a, b) { return a.start.localeCompare(b.start); });
    },
    pastList() {
      var now = new Date().toISOString();
      return this.all.filter(function (b) { return b.status === "cancelled" || b.end <= now; })
        .sort(function (a, b) { return b.start.localeCompare(a.start); });
    },
    visible() {
      if (this.tab === "upcoming") return this.upcomingList();
      return this.pastList().slice(0, this.pastLimit);
    },
    showMorePast() { this.pastLimit += 20; },
    openCancel(b) { this.cancelTarget = b; this.cancelError = ""; },
    cancelConsequence() {
      if (!this.cancelTarget) return "";
      if (this.cancelTarget.payment_mode === "credits") return t("cancel.credits_back", { n: this.cancelTarget.party_size || 1 });
      if (this.cancelTarget.payment_mode === "card") return t("cancel.paid_note");
      return "";
    },
    async doCancel() {
      this.cancelling = true;
      var res = await PortalApi.post("/api/portal/bookings/" + this.cancelTarget.id + "/cancel", {});
      this.cancelling = false;
      if (res.ok) {
        this.cancelTarget = null;
        this.toast = t("cancel.done");
        setTimeout(function () { }, 0);
        this.load();
        var self = this;
        setTimeout(function () { self.toast = ""; }, 3000);
      } else if (res.error === "past_cutoff") {
        this.cancelError = t("cancel.err_cutoff");
      } else {
        this.cancelError = t("state.error_body");
      }
    },
    payNow(b) { window.location.hash = "#/bookings/" + b.id; },
  };
}

// ---- M4 Billing ------------------------------------------------------------

function memberBilling() {
  return {
    loading: true,
    stripeOn: false,
    opening: false,
    openError: false,
    t: window.t,
    async load() {
      this.loading = true;
      var me = await PortalApi.get("/api/portal/me");
      this.stripeOn = !!(me.ok && me.data && me.data.features && me.data.features.stripe);
      this.loading = false;
    },
    async openBilling() {
      this.opening = true;
      this.openError = false;
      var res = await PortalApi.post("/api/portal/billing/portal-session", {});
      this.opening = false;
      if (res.ok && res.data && res.data.url) window.location.assign(res.data.url);
      else this.openError = true;
    },
  };
}

// ---- M5 History ------------------------------------------------------------

function memberHistory() {
  return {
    loading: true,
    stripeOn: false,
    error: false,
    rows: [],
    t: window.t,
    chipClass: window.chipClass,
    crDateLabel: function (iso) { return crDate(iso); },
    async load() {
      this.loading = true;
      this.error = false;
      var me = await PortalApi.get("/api/portal/me");
      this.stripeOn = !!(me.ok && me.data && me.data.features && me.data.features.stripe);
      if (!this.stripeOn) { this.loading = false; return; }
      var res = await PortalApi.get("/api/portal/billing/history");
      if (!res.ok) { this.error = res.error !== "not_configured"; this.loading = false; return; }
      this.rows = res.data || [];
      this.loading = false;
    },
    topLine() { return this.rows.length > 0 ? t("history.top", { n: this.rows.length }) : t("history.empty_top"); },
    money: window.moneyFmt,
  };
}

// ---- M6 Household ----------------------------------------------------------

function memberHousehold() {
  return {
    loading: true,
    error: false,
    household: null,
    t: window.t,
    async load() {
      this.loading = true;
      this.error = false;
      var res = await PortalApi.get("/api/portal/me/household");
      if (!res.ok) { this.error = true; this.loading = false; return; }
      this.household = res.data;
      this.loading = false;
    },
    topLine() {
      if (!this.household) return "";
      var tier = TIER_NAMES[this.household.tier] || this.household.tier || "";
      return t("household.top", { tier: tier, adults: this.household.is_couples ? (this.household.partner ? 2 : 1) : 1, kids: (this.household.kids || []).length });
    },
  };
}
