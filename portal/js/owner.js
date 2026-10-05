// Owned by B2f2 (amendment 5 build cut). Owner-only area, screens.md §7
// (O1 Today .. O9 Owner booking). Registers `window.PortalAreas.owner`
// and a small hash router that mounts into the `#portal-area` element
// portal/index.html (B1) already ships. It is a no-op the moment the
// signed-in account's role is not 'owner', so it never fights B2f1's
// member/staff/account modules over the same mount point
// (docs/portal/ui-structure.md point 1: "the area's own router glue").
//
// FINDING for the conductor, not fixed here because portal/index.html is
// B1's file and this dispatch says not to touch it: nothing in the
// shipped shell has a <script> tag for this file (or for B2f1's
// member.js/staff.js/account.js). Until one line is added --
//   <script src="/portal/js/owner.js"></script>
// (placed after app.js's own script tag) -- this module only runs on a
// page that explicitly loads it. Verification for this dispatch used a
// throwaway harness under /tmp that loads the real served files from
// `wrangler dev`; it is not part of the shipped site.
//
// Every string shown to the owner comes from `t(key, vars)` reading
// `window.STR.en` (PIN-10) -- the internal-tool keys below are this
// seat's own (§9: "final from this seat"). Every piece of user/API data
// in a view is bound with `x-text`, never `x-html` (REQ-SEC-10).

(function () {
  "use strict";

  // portal/js/api.js declares `const PortalApi = ...` as a classic
  // script (no `window.PortalApi =`), so it is a same-document lexical
  // binding, not a window property -- `typeof PortalApi` is the correct
  // check here (checking `window.PortalApi` always failed and made this
  // whole module a silent no-op; caught by running it in a real browser,
  // never by the API-level curl checks). `window.PortalApp` IS a real
  // window property (app.js's last line sets it explicitly), so that
  // half of the guard is fine as `window.`.
  if (!window.PortalApp || typeof PortalApi === "undefined") {
    // The shell modules this file depends on were not loaded first --
    // nothing to attach to. Fail silently rather than throw into a page
    // that never asked for the owner area.
    return;
  }

  // ---------------------------------------------------------------
  // §9 string dictionary, owner-facing keys (copied verbatim from
  // screens.md §9; this seat owns and finalises these).
  // ---------------------------------------------------------------
  window.PortalApp.mergeStrings({
    // Shell-level keys (screens.md §9 "shell") that neither B1's
    // index.html nor app.js's base STR.en define yet (confirmed: B1's
    // own bottom nav renders the raw key, e.g. "NAV.TODAY") -- added
    // here, pure gap-fill, only the exact keys this area's own
    // templates reference, never overwriting a key app.js already set
    // (e.g. act.retry/state.* keep B1's existing wording).
    "tab.today": "Today",
    "tab.members": "Members",
    "tab.book": "Book",
    "tab.manage": "Manage",
    "chip.default_confirm": "Default · tap to confirm",
    "chip.paid_conflict": "Paid, time taken",
    "act.back": "Back",
    "act.cancel": "Cancel",
    "act.done": "Done",
    "act.save": "Save",
    "slot.blocked": "Closed",
    "cancel.keep": "Go back",
    "book.err_taken": "Someone just took that time. Pick another.",
    "book.err_blocked": "That time is closed.",
    "book.no_resources": "Nothing is open for booking right now.",

    "today.top": "{date} · {n} bookings across {r} courts and services",
    "today.top_one": "{date} · 1 booking across {r} courts and services",
    "today.scroll_hint": "Scroll sideways to see every column.",
    "today.alert_conflict": "{n} paid booking has no slot. Refund in Stripe.",
    "today.alert_sync": "{n} calendar updates failed",
    "today.jump_today": "Today",
    "today.players": "{n} players",
    "today.player_one": "1 player",
    "today.held_until": "Awaiting payment",
    "today.refund": "Refund in Stripe ↗",
    "today.open_member": "Open member",
    "today.conflict_explain": "Payment arrived after the hold ran out, and the time went to another booking. Refund the payment in Stripe. Cancelling here does not refund it.",
    "today.book_here": "Book this time",
    "today.block_here": "Block this time",
    "today.empty": "No bookings on {date}. Every time is open.",
    "today.stripe_off_note": "Payments are not switched on yet, so refund links will not find a real payment.",
    "today.walk_in": "Walk-in",
    "today.pay_club": "Pay at club: {amount}",

    "members.top": "{active} active members · {ending} ending in 14 days",
    "members.search": "Search name or email",
    "members.f_all": "All",
    "members.f_active": "Active",
    "members.f_ending": "Ending in 14 days",
    "members.f_past_due": "Payment failed",
    "members.f_expired": "Expired",
    "members.f_guests": "Guests",
    "members.f_staff": "Staff",
    "members.ends": "until {date}",
    "members.ended": "ended {date}",
    "members.empty": "No accounts yet. People appear here after they first sign in or buy online.",
    "members.no_match": "No one matches “{q}”.",

    "member.since": "Joined {date}",
    "member.source_stripe": "Stripe subscription",
    "member.source_granted": "Granted by {owner} · {note}",
    "member.grant": "Grant membership",
    "member.grant_tier": "Tier",
    "member.grant_start": "Starts",
    "member.grant_end": "Ends",
    "member.grant_note": "Paid by",
    "member.grant_confirm": "Grant",
    "member.end_grant": "End this grant today",
    "member.grant_overlap": "This member already pays through Stripe. A grant adds a second membership. It does not stop or refund the Stripe one.",
    "member.overlap_flag": "Membership from two sources",
    "member.linked_by_email": "Linked by email match. Check this is the right account.",
    "member.link_partner": "Link partner",
    "member.partner_search": "Partner's email",
    "member.link_confirm": "Link",
    "member.unlink": "Unlink partner",
    "member.link_needs_couples": "Needs a couples membership.",
    "member.err_partner_taken": "That account is already in another household.",
    "member.add_kid": "Add kid",
    "member.kid_name": "First name",
    "member.kid_year": "Birth year",
    "member.kid_limit": "One free kid per paying adult ({max}).",
    "member.kid_too_old": "Kids must be under 16.",
    "member.remove_kid": "Remove",
    "member.set_role": "Change role",
    "member.credits": "{n} court credits",
    "member.no_partner": "No partner linked.",
    "member.no_kids": "No kids added.",
    "member.no_grant": "No membership granted or paid through Stripe.",
    "member.no_bookings": "No bookings.",
    "member.no_payments": "No payments recorded.",
    "member.no_stripe": "Not a Stripe payment",
    "member.payments_off": "No online payments recorded yet.",

    "role.staff_effect": "Sees only their assigned calendar: times and names, no emails or payments.",
    "role.member_effect": "Books as a member. Normally set automatically by an active membership.",
    "role.guest_effect": "Books as a guest: up to 2 days ahead, at guest prices.",
    "role.owner_note": "Owner access is set in the site's setup, not here. Ask your web team to change it.",

    "block.title": "Block time",
    "block.all_courts": "All courts",
    "block.one_off": "One-off",
    "block.weekly": "Weekly",
    "block.from_date": "Starting",
    "block.label_ph": "e.g. Open play, Maintenance",
    "block.preview": "Blocks {resources} {when} {start}–{end}",
    "block.conflicts": "{n} bookings overlap. A block does not cancel them.",
    "block.save": "Block",
    "block.save_anyway": "Block anyway",
    "block.saved": "Time blocked.",
    "block.err_range": "End must be after start.",
    "block.err_hours": "That's outside opening hours.",
    "blocks.top": "{w} weekly blocks · {o} one-off blocks",
    "blocks.add": "Block time",
    "blocks.remove": "Remove block",
    "blocks.remove_series": "Remove every week",
    "blocks.empty": "No blocks. Every open hour is bookable.",

    "manage.top": "{n} courts or services still have default settings to check",
    "manage.top_done": "All settings confirmed",
    "manage.resources": "Courts and services",
    "manage.prices": "Prices",
    "manage.blocks": "Blocks",
    "manage.sync": "Calendar sync",
    "manage.late": "Late hours",

    "late.intro": "Courts normally close at 19:00. Extend one day to 21:00, for an event or a tournament. It applies to courts only and to that day only.",
    "late.day": "Day",
    "late.extend": "Extend to 21:00",
    "late.until": "Courts open until {time}",
    "late.clear": "Back to normal hours",
    "late.empty": "No extended days coming up.",
    "late.err_bad_date": "Choose a day first.",
    "late.err_date_in_past": "That day has already passed.",
    "late.err_not_an_extension": "That is not later than the normal closing time.",
    "late.err_close_too_late": "The latest a day can be extended to is 21:00.",
    "late.running_late": "{n} bookings already run past the closing time. They stay as they are.",

    "res.top": "{n} courts and services · {d} with defaults to check",
    "res.n_defaults": "{n} to check",
    "res.add": "Add resource",
    "res.defaults_banner": "{n} settings here are still defaults. Once a value is right, tap its Default chip to confirm it.",
    "res.name": "Name",
    "res.bookable": "Bookable",
    "res.sort": "Order",
    "res.opens": "Opens",
    "res.closes": "Closes",
    "res.slot": "Slot length (min)",
    "res.buffer": "Buffer between slots (min)",
    "res.grid_preview": "First {first}, last {last} (ends {end}). {n} slots a day.",
    "res.window_member": "Member booking window (days ahead)",
    "res.window_guest": "Guest booking window (days ahead)",
    "res.cap": "Max upcoming bookings per person",
    "res.cap_none": "No limit",
    "res.cutoff": "Online cancelling closes (minutes before start)",
    "res.member_included": "Members' price",
    "res.mp_included": "Included",
    "res.mp_by_tier": "By tier",
    "res.mp_same": "Same as guests",
    "res.price_mode": "Price mode",
    "res.per_player": "Per player",
    "res.per_booking": "Per booking",
    "res.staff_owner": "Staff owner",
    "res.staff_none": "None",
    "res.gcal": "Google Calendar ID",
    "res.gcal_ph": "…@group.calendar.google.com",
    "res.misfits": "{n} existing bookings no longer fit the new times. They are kept.",
    "res.err_close_before_open": "Closing must be after opening.",
    "res.err_slot": "Slot length must be 5 to 480 minutes.",
    "res.err_window": "Window must be 0 to 60 days.",
    "res.discard": "Discard unsaved changes?",

    "prices.top": "{n} items have no price and can't take paid bookings",
    "prices.top_ok": "Every item has a price",
    "prices.not_set": "Price not set",
    "prices.not_set_effect": "Non-members can't book this. Members can if it's included.",
    "prices.saved": "New price is live.",
    "prices.err_amount": "Enter an amount like 15.00.",
    "prices.top_off": "Prices can't be changed until payments are switched on",
    "prices.sec_bookings": "Per booking",
    "prices.sec_plans": "Memberships and passes",
    "prices.edit": "Change",
    "prices.included_annual": "Annual members: included, no payment",
    "prices.effect_booking": "New bookings pay this from now on. Bookings already paid keep their price.",
    "prices.effect_plan": "New members pay this. Current subscriptions keep their price until changed in billing.",
    "prices.save_stripe": "Save in Stripe",
    "prices.saving": "Creating the new price in Stripe…",
    "prices.err_stripe": "Stripe didn't accept the change, so the price shown here is unchanged. Try again.",
    "nc.prices": "Payments are not switched on yet, so prices can't be changed here.",

    "sync.off_top": "Google Calendar sync is off. {n} changes are waiting and will be sent when it's switched on.",
    "sync.ok_top": "All changes sent to Google Calendar.",
    "sync.pending": "{n} waiting",
    "sync.fail_top": "{n} changes failed after 5 tries.",
    "sync.create": "Add",
    "sync.cancel": "Remove",
    "sync.move": "Move",
    "sync.attempts": "{n}/5 tries",
    "sync.empty": "No failed updates.",
    "sync.no_calendar": "{resource} has no calendar ID, so its changes are not sent.",
    "sync.hint_off": "Off",
    "sync.hint_failed": "{n} failed",
    "sync.hint_ok": "OK",

    "obook.top": "Book any open time for a member or a walk-in. No payment is taken.",
    "obook.for_account": "Member",
    "obook.for_walk_in": "Walk-in",
    "obook.search_ph": "Name or email",
    "obook.walk_in_name": "Walk-in name",
    "obook.bypass": "Window, membership and payment rules are skipped.",
    "obook.confirm": "Book it",
    "obook.done": "Booked.",
    "obook.use_walk_in": "Book as a walk-in instead",

    "owner.health_top": "What's switched on",
    "owner.health_owners": "Owners",
    "owner.health_email": "Email",
    "owner.health_stripe": "Stripe",
    "owner.health_gcal": "Google Calendar",
    "owner.health_push": "Phone reminders",
    "owner.on": "On",
    "owner.off": "Not switched on yet",
    "state.not_wired": "This isn't available yet. Nothing you did caused it.",
  });

  // ---------------------------------------------------------------
  // Shared helpers. Costa Rica time display (PIN-6) -- the device's own
  // time zone is never used for anything the owner reads.
  // ---------------------------------------------------------------
  const CR_TZ = "America/Costa_Rica";
  const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: CR_TZ, weekday: "short", day: "numeric", month: "short" });
  // D7: the grant range on member detail needs the year (an annual grant
  // otherwise reads as a single day, e.g. "Thu, Oct 1 - Fri, Oct 1" for a
  // grant that actually runs a full year) -- a separate formatter so the
  // other, shorter uses of fmtDate (today's own date strip, "Joined
  // {date}") keep their existing look.
  const dateFmtYear = new Intl.DateTimeFormat("en-US", { timeZone: CR_TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: CR_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const isoDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: CR_TZ, year: "numeric", month: "2-digit", day: "2-digit" }); // en-CA = YYYY-MM-DD

  function fmtDate(iso) {
    if (!iso) return "";
    return dateFmt.format(new Date(iso));
  }
  function fmtDateYear(iso) {
    if (!iso) return "";
    return dateFmtYear.format(new Date(iso));
  }
  function fmtTime(iso) {
    if (!iso) return "";
    return timeFmt.format(new Date(iso));
  }
  function fmtMoney(cents) {
    if (cents === null || cents === undefined) return "";
    return "$" + (cents / 100).toFixed(2);
  }
  function todayCR() {
    return isoDateFmt.format(new Date());
  }
  function shiftDateCR(dateStr, days) {
    const d = new Date(dateStr + "T12:00:00Z"); // noon UTC avoids DST/zone edge cases for a plain day shift
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  if (!window.t) {
    window.t = function t(key, vars) {
      const dict = (window.STR && window.STR.en) || {};
      let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
      if (vars) {
        for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
      }
      return s;
    };
  }

  // Classifies a PortalApi response into one of the shared states
  // (screens.md §2.4) every view switches on. A screen whose API route
  // has not landed yet (B2a2/B2b still mid-build, per the dispatch) gets
  // "not_found" here -- shown as a clean, named state, never a stub
  // presented as if it worked.
  function classify(res) {
    if (res.ok) return "ok";
    if (res.status === 0) return "offline";
    if (res.status === 503 && res.error === "not_configured") return "not_configured";
    if (res.status === 403) return "forbidden";
    if (res.status === 404) return "not_found";
    if (res.status === 429) return "rate_limited";
    return "error";
  }

  function notConfiguredFeature(res) {
    return (res.data && res.data.feature) || null;
  }

  // The seven membership tiers (entitlement.js's own TIER_RANK is the
  // source of truth for which tiers exist; this list mirrors it for the
  // grant/price pickers rather than re-deriving it over the wire).
  const TIERS = [
    { key: "jp_1m_single", label: "1 Month" },
    { key: "jp_3m_single", label: "3 Month Single" },
    { key: "jp_3m_couples", label: "3 Month Couples" },
    { key: "jp_6m_single", label: "6 Month Single" },
    { key: "jp_6m_couples", label: "6 Month Couples" },
    { key: "jp_annual_single", label: "Annual Single" },
    { key: "jp_annual_couples", label: "Annual Couples" },
  ];

  window.ownerHelpers = { fmtDate, fmtDateYear, fmtTime, fmtMoney, todayCR, shiftDateCR, classify, notConfiguredFeature, TIERS, t: window.t };

  // ---------------------------------------------------------------
  // O1 Today
  // ---------------------------------------------------------------
  window.ownerToday = function () {
    return {
      state: "loading",
      date: todayCR(),
      resources: [],
      byResource: {},
      alerts: [],
      sheet: null,
      stripeOn: true,
      // D8: whether the column strip is wider than its box, and whether
      // it is already scrolled to the far end. Drive the scroll cue.
      stripOverflows: false,
      stripAtEnd: true,
      h: window.ownerHelpers,
      async init() {
        const me = await window.PortalApp.bootstrapSession();
        this.stripeOn = Boolean(me.features && me.features.stripe);
        await this.load();
      },
      bookingCount() {
        return Object.values(this.byResource).reduce((sum, list) => sum + list.filter((x) => x.state !== "blocked").length, 0);
      },
      topLine() {
        const n = this.bookingCount();
        return window.t(n === 1 ? "today.top_one" : "today.top", { date: this.h.fmtDate(this.date + "T12:00:00Z"), n: n, r: this.resources.length });
      },
      playersLabel(n) {
        return window.t(n === 1 ? "today.player_one" : "today.players", { n: n });
      },
      measureStrip() {
        const strip = this.$refs.strip;
        if (!strip) return;
        this.stripOverflows = strip.scrollWidth > strip.clientWidth + 1;
        this.stripAtEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
      },
      async load() {
        this.state = "loading";
        const [resRes, todayRes] = await Promise.all([
          PortalApi.get("/api/portal/owner/resources"),
          PortalApi.get("/api/portal/owner/today?date=" + this.date),
        ]);
        if (!resRes.ok) {
          this.state = classify(resRes);
          return;
        }
        if (!todayRes.ok) {
          this.state = classify(todayRes);
          return;
        }
        this.resources = (resRes.data || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const grouped = {};
        for (const r of this.resources) grouped[r.id] = [];
        // src/portal/owner.js's todayAcrossResources() returns {date, items},
        // one item per booking or per matching block for the day -- never a
        // bare array (docs/portal/api.md §4's "every resource's bookings"
        // prose underspecifies the wrapper; this is the shape B2a2 shipped).
        const items = (todayRes.data && todayRes.data.items) || [];
        for (const it of items) {
          (grouped[it.resource_id] = grouped[it.resource_id] || []).push(it);
        }
        for (const id of Object.keys(grouped)) {
          grouped[id].sort((a, b) => (a.start_at || "").localeCompare(b.start_at || ""));
        }
        this.byResource = grouped;
        this.alerts = (todayRes.data && todayRes.data.alerts) || [];
        this.state = this.resources.length === 0 ? "empty" : items.length === 0 ? "empty" : "ok";
      },
      prevDay() {
        this.date = shiftDateCR(this.date, -1);
        this.load();
      },
      nextDay() {
        this.date = shiftDateCR(this.date, 1);
        this.load();
      },
      jumpToday() {
        this.date = todayCR();
        this.load();
      },
      isToday() {
        return this.date === todayCR();
      },
      open(booking) {
        this.sheet = booking;
      },
      close() {
        this.sheet = null;
      },
      refundUrl(item) {
        return item && item.refund_url ? item.refund_url : null;
      },
      async cancel(booking) {
        const res = await PortalApi.post("/api/portal/bookings/" + booking.id + "/cancel", {});
        if (res.ok) {
          this.sheet = null;
          await this.load();
        }
      },
      stateClasses(st) {
        if (st === "confirmed") return "bg-jpteal text-white border border-jpteal";
        if (st === "held") return "bg-amber-50 border border-amber-400 text-amber-800";
        if (st === "blocked") return "bg-slate-100 border border-slate-300 text-slate-500";
        if (st === "paid_conflict") return "bg-red-50 border border-red-400 text-red-700";
        return "bg-white border border-slate-200 text-slate-700";
      },
    };
  };

  // ---------------------------------------------------------------
  // O2 Members
  // ---------------------------------------------------------------
  window.ownerMembers = function () {
    return {
      state: "loading",
      accounts: [],
      q: "",
      filter: "all",
      h: window.ownerHelpers,
      async init() {
        await this.load();
      },
      async load() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/accounts");
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        this.accounts = res.data || [];
        this.state = this.accounts.length === 0 ? "empty" : "ok";
      },
      get activeCount() {
        return this.accounts.filter((a) => a.entitlement && a.entitlement.tier).length;
      },
      get endingCount() {
        return this.accounts.filter((a) => a.entitlement && a.entitlement.ending_soon).length;
      },
      get filtered() {
        let rows = this.accounts;
        if (this.filter === "active") rows = rows.filter((a) => a.entitlement && a.entitlement.tier && a.role === "member");
        else if (this.filter === "ending") rows = rows.filter((a) => a.entitlement && a.entitlement.ending_soon);
        else if (this.filter === "past_due") rows = rows.filter((a) => a.entitlement && a.entitlement.stripe_status === "past_due");
        else if (this.filter === "expired") rows = rows.filter((a) => a.entitlement && a.entitlement.expired);
        else if (this.filter === "guests") rows = rows.filter((a) => a.role === "guest");
        else if (this.filter === "staff") rows = rows.filter((a) => a.role === "staff");
        if (this.q.trim()) {
          const needle = this.q.trim().toLowerCase();
          rows = rows.filter((a) => (a.display_name || "").toLowerCase().includes(needle) || (a.email || "").toLowerCase().includes(needle));
        }
        return rows;
      },
    };
  };

  // ---------------------------------------------------------------
  // O3 Member detail
  // ---------------------------------------------------------------
  window.ownerMemberDetail = function () {
    return {
      state: "loading",
      account: null,
      grants: [],
      household: null,
      dependants: [],
      bookings: [],
      payments: [],
      accountNames: {},
      overlap: false,
      grantSheet: false,
      roleSheet: false,
      kidSheet: false,
      partnerSheet: false,
      grantForm: { tier: "jp_1m_single", starts_at: todayCR(), ends_at: "", note: "" },
      kidForm: { first_name: "", birth_year: new Date().getFullYear() - 10 },
      partnerEmail: "",
      partnerResults: [],
      partnerPickedId: null,
      roleChoice: "member",
      saveError: null,
      h: window.ownerHelpers,
      tiers: TIERS,
      async init() {
        await this.load();
      },
      id() {
        return (window.ownerRouteParam && window.ownerRouteParam()) || "";
      },
      async load() {
        this.state = "loading";
        const [res, resourcesRes, accountsRes] = await Promise.all([
          PortalApi.get("/api/portal/owner/accounts/" + this.id()),
          PortalApi.get("/api/portal/owner/resources"),
          PortalApi.get("/api/portal/owner/accounts"),
        ]);
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        const d = res.data || {};
        this.account = d.account || d;
        this.grants = d.grants || [];
        // D7: entitlement_grants.created_by is the granter's account id, not
        // a name -- the accounts list is the only place that id resolves to
        // a display name, so build that map here rather than show the raw
        // id in the view.
        this.accountNames = {};
        for (const a of accountsRes.ok ? accountsRes.data || [] : []) this.accountNames[a.id] = a.display_name || a.email || a.id;
        // src/portal/owner.js's getAccountDetail() returns `households`
        // (plural -- this account may be the payer's own row, the
        // partner's, or absent), each a bare households-table row with no
        // joined display name; resolve the other side's name from the
        // resources call's sibling account list where possible.
        const households = d.households || [];
        this.household = households.find((h) => h.status === "active") || null;
        this.dependants = d.dependants || [];
        const resourceNames = {};
        for (const r of resourcesRes.ok ? resourcesRes.data || [] : []) resourceNames[r.id] = r.name;
        this.bookings = (d.bookings || []).map((b) => ({ ...b, resource: resourceNames[b.resource_id] || b.resource_id, start: b.start_at }));
        this.payments = d.payments || [];
        const activeSources = new Set(this.grants.filter((g) => g.status === "active").map((g) => g.source));
        this.overlap = activeSources.size > 1;
        this.state = "ok";
      },
      granterName(id) {
        return this.accountNames[id] || id;
      },
      get activeGrant() {
        return this.grants.find((g) => g.status === "active") || null;
      },
      get hasActiveStripe() {
        return this.grants.some((g) => g.source === "stripe" && g.status === "active");
      },
      get isCouplesTier() {
        const active = this.grants.find((g) => g.status === "active");
        return Boolean(active && /couples/.test(active.tier || ""));
      },
      openGrant() {
        this.saveError = null;
        this.grantSheet = true;
      },
      async submitGrant() {
        this.saveError = null;
        const res = await PortalApi.post("/api/portal/owner/accounts/" + this.id() + "/grant", this.grantForm);
        if (res.ok) {
          this.grantSheet = false;
          await this.load();
        } else {
          this.saveError = classify(res);
        }
      },
      async endGrant(grant) {
        // portal(FR1): the end-grant route this file's own comment used
        // to name as missing now exists (docs/portal/api.md §4).
        this.saveError = null;
        const res = await PortalApi.post("/api/portal/owner/accounts/" + this.id() + "/grants/" + grant.id + "/end", {});
        if (res.ok) {
          await this.load();
        } else {
          this.saveError = classify(res);
        }
      },
      openKid() {
        this.saveError = null;
        this.kidSheet = true;
      },
      async submitKid() {
        this.saveError = null;
        const res = await PortalApi.post("/api/portal/owner/accounts/" + this.id() + "/dependants", this.kidForm);
        if (res.ok) {
          this.kidSheet = false;
          this.kidForm = { first_name: "", birth_year: new Date().getFullYear() - 10 };
          await this.load();
        } else {
          this.saveError = classify(res);
        }
      },
      openPartner() {
        this.saveError = null;
        this.partnerEmail = "";
        this.partnerResults = [];
        this.partnerPickedId = null;
        this.partnerSheet = true;
      },
      async searchPartner() {
        this.partnerPickedId = null;
        if (!this.partnerEmail.trim()) {
          this.partnerResults = [];
          return;
        }
        const res = await PortalApi.get("/api/portal/owner/accounts");
        if (!res.ok) return;
        const needle = this.partnerEmail.trim().toLowerCase();
        this.partnerResults = (res.data || []).filter((a) => a.id !== this.id() && (a.email || "").toLowerCase().includes(needle));
      },
      pickPartner(a) {
        this.partnerPickedId = a.id;
        this.partnerEmail = a.email;
        this.partnerResults = [];
      },
      async submitPartner() {
        this.saveError = null;
        if (!this.partnerPickedId) {
          this.saveError = "pick_a_result";
          return;
        }
        const res = await PortalApi.post("/api/portal/owner/accounts/" + this.id() + "/household-link", { partner_account_id: this.partnerPickedId });
        if (res.ok) {
          this.partnerSheet = false;
          await this.load();
        } else {
          this.saveError = res.status === 409 ? "partner_taken" : classify(res);
        }
      },
      async unlinkPartner() {
        if (!this.household) return;
        const res = await PortalApi.del("/api/portal/owner/households/" + this.household.id);
        if (res.ok) await this.load();
      },
      openRole() {
        this.roleChoice = (this.account && this.account.role) || "member";
        this.roleSheet = true;
      },
      async submitRole() {
        const res = await PortalApi.patch("/api/portal/owner/accounts/" + this.id() + "/role", { role: this.roleChoice });
        if (res.ok) {
          this.roleSheet = false;
          await this.load();
        }
      },
      birthYears() {
        const y = new Date().getFullYear();
        const out = [];
        for (let i = 0; i < 16; i++) out.push(y - i);
        return out;
      },
    };
  };

  // ---------------------------------------------------------------
  // O9 Owner booking (override, D-A11)
  // ---------------------------------------------------------------
  window.ownerBook = function () {
    return {
      state: "loading",
      resources: [],
      resourceId: null,
      date: todayCR(),
      slots: [],
      selected: null,
      forMode: "account",
      searchQ: "",
      searchResults: [],
      accountId: null,
      walkInName: "",
      players: 1,
      done: false,
      err: null,
      h: window.ownerHelpers,
      async init() {
        await this.loadResources();
      },
      async loadResources() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/resources");
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        this.resources = res.data || [];
        this.state = this.resources.length === 0 ? "empty" : "ok";
        if (this.resources.length) {
          // D3: loadResources() can run more than once for the same mount
          // (Alpine's own auto-call of a data method named init() plus
          // this view's explicit x-init="init()" -- fixed in
          // owner-book.html, but this guard is the one that actually
          // keeps the owner's chosen court from snapping back: it only
          // picks a default the first time, or if the previously picked
          // resource no longer exists, never overwriting a resource the
          // owner already picked).
          if (!this.resourceId || !this.resources.some((r) => r.id === this.resourceId)) {
            this.resourceId = this.resources[0].id;
          }
          await this.loadSlots();
        }
      },
      async loadSlots() {
        if (!this.resourceId) return;
        // FINDING: docs/portal/api.md §3 promises an owner variant at
        // GET /api/portal/owner/resources/:id/availability (display_name,
        // booking_id on taken slots) -- only the member/guest route
        // (src/portal/booking.js's availability(), class "own") exists.
        // It works for the owner (any authenticated role may call an
        // "own" route) but a taken slot shows no booker name here yet.
        const res = await PortalApi.get("/api/portal/resources/" + this.resourceId + "/availability?date=" + this.date);
        if (!res.ok) {
          this.slots = [];
          return;
        }
        this.slots = (res.data && res.data.slots) || [];
      },
      async search() {
        if (!this.searchQ.trim()) {
          this.searchResults = [];
          return;
        }
        const res = await PortalApi.get("/api/portal/owner/accounts");
        if (!res.ok) return;
        const needle = this.searchQ.trim().toLowerCase();
        this.searchResults = (res.data || []).filter(
          (a) => (a.display_name || "").toLowerCase().includes(needle) || (a.email || "").toLowerCase().includes(needle)
        );
      },
      pick(account) {
        this.accountId = account.id;
        this.searchQ = account.display_name || account.email;
        this.searchResults = [];
      },
      async confirm() {
        this.err = null;
        const body = { resource_id: this.resourceId, start: this.selected, party_size: this.players };
        if (this.forMode === "account") body.account_id = this.accountId;
        else body.walk_in_name = this.walkInName;
        const res = await PortalApi.post("/api/portal/owner/bookings", body);
        if (res.ok) {
          this.done = true;
        } else {
          this.err = res.status === 409 ? res.error || "slot_taken" : classify(res);
        }
      },
    };
  };

  // ---------------------------------------------------------------
  // O5 Manage (hub list)
  // ---------------------------------------------------------------
  window.ownerManage = function () {
    return {
      state: "loading",
      resourcesDefaults: 0,
      pricesUnset: 0,
      weeklyBlocks: 0,
      syncHint: "off",
      health: null,
      h: window.ownerHelpers,
      async init() {
        this.state = "loading";
        const [resRes, healthRes] = await Promise.all([
          PortalApi.get("/api/portal/owner/resources"),
          PortalApi.get("/api/portal/owner/health"),
        ]);
        if (resRes.ok) {
          const rows = resRes.data || [];
          this.resourcesDefaults = rows.reduce((n, r) => n + ((r.unconfirmed_fields || []).length > 0 ? 1 : 0), 0);
        }
        if (healthRes.ok) {
          const h = healthRes.data || {};
          this.health = h;
          if (!h.gcal_configured) this.syncHint = "off";
          else if (h.outbox && h.outbox.failed && h.outbox.failed.length) this.syncHint = String(h.outbox.failed.length);
          else this.syncHint = "ok";
        }
        this.state = "ok";
      },
      get totalDefaults() {
        return this.resourcesDefaults;
      },
    };
  };

  // ---------------------------------------------------------------
  // O6 Resources list / O6b editor
  // ---------------------------------------------------------------
  window.ownerResources = function () {
    return {
      state: "loading",
      resources: [],
      h: window.ownerHelpers,
      async init() {
        await this.load();
      },
      async load() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/resources");
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        this.resources = res.data || [];
        this.state = this.resources.length === 0 ? "empty" : "ok";
      },
      get defaultsCount() {
        return this.resources.reduce((n, r) => n + ((r.unconfirmed_fields || []).length > 0 ? 1 : 0), 0);
      },
    };
  };

  window.ownerResourceEditor = function () {
    return {
      state: "loading",
      resource: null,
      form: {},
      unconfirmed: [],
      saveError: null,
      misfits: null,
      h: window.ownerHelpers,
      async init() {
        await this.load();
      },
      id() {
        return (window.ownerRouteParam && window.ownerRouteParam()) || "";
      },
      async load() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/resources/" + this.id());
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        this.resource = res.data || {};
        this.unconfirmed = this.resource.unconfirmed_fields || [];
        this.form = Object.assign({}, this.resource);
        this.state = "ok";
      },
      isDefault(field) {
        return this.unconfirmed.includes(field);
      },
      async confirmField(field) {
        const res = await PortalApi.post("/api/portal/owner/resources/" + this.id() + "/confirm-field", { field });
        if (res.ok) this.unconfirmed = this.unconfirmed.filter((f) => f !== field);
      },
      async save() {
        this.saveError = null;
        const res = await PortalApi.patch("/api/portal/owner/resources/" + this.id(), this.form);
        if (res.ok) {
          this.misfits = (res.data && res.data.misfits) || null;
          await this.load();
        } else {
          this.saveError = classify(res);
        }
      },
    };
  };

  // ---------------------------------------------------------------
  // O7 Prices
  // ---------------------------------------------------------------
  window.ownerPrices = function () {
    return {
      state: "loading",
      resources: [],
      editing: null,
      amountInput: "",
      saveState: "idle", // idle|saving|error
      stripeOn: true,
      h: window.ownerHelpers,
      async init() {
        // D5: /api/portal/owner/resources succeeds (200) whether or not
        // Stripe is connected -- it just lists resources and the mirrored
        // display prices -- so classify()'s 503/not_configured path never
        // fires here. The real signal is /api/portal/me's features.stripe,
        // the same flag ownerToday already reads for its own stripe-off
        // note.
        const me = await window.PortalApp.bootstrapSession();
        this.stripeOn = Boolean(me.features && me.features.stripe);
        await this.load();
      },
      async load() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/resources");
        if (!res.ok) {
          this.state = classify(res);
          this.notConfiguredFeature = notConfiguredFeature(res);
          return;
        }
        this.resources = res.data || [];
        this.state = "ok";
      },
      get items() {
        const out = [];
        for (const r of this.resources) {
          for (const o of r.offerings || []) {
            out.push({ resource: r, offering: o });
          }
        }
        return out;
      },
      get unsetCount() {
        // A null lookup_key (the annual-member $0 Cold Plunge offering,
        // Amendment 4) is "included, no checkout" by design, never an
        // unset price -- only an item that takes payment and has no
        // price counts here.
        return this.items.filter((i) => i.offering.lookup_key && (i.offering.display_price_cents === null || i.offering.display_price_cents === undefined)).length;
      },
      open(item) {
        this.editing = item;
        this.amountInput = item.offering.display_price_cents != null ? (item.offering.display_price_cents / 100).toFixed(2) : "";
        this.saveState = "idle";
      },
      close() {
        this.editing = null;
      },
      async save() {
        const n = Number(this.amountInput);
        if (!this.amountInput || Number.isNaN(n) || n < 0) {
          this.saveState = "bad_amount";
          return;
        }
        this.saveState = "saving";
        const cents = Math.round(n * 100);
        const res = await PortalApi.post(
          "/api/portal/owner/resources/" + this.editing.resource.id + "/offerings/" + this.editing.offering.id + "/price",
          { price_cents: cents }
        );
        if (res.ok) {
          this.editing.offering.display_price_cents = cents;
          this.saveState = "idle";
          this.editing = null;
          await this.load();
        } else if (classify(res) === "not_configured") {
          this.saveState = "not_configured";
        } else {
          this.saveState = "stripe_error";
        }
      },
    };
  };

  // ---------------------------------------------------------------
  // O4/O4b Blocks
  // ---------------------------------------------------------------
  window.ownerBlocks = function () {
    return {
      state: "loading",
      blocks: [],
      resources: [],
      sheetOpen: false,
      form: { resource_ids: [], kind: "one_off", date: todayCR(), weekday: "mon", start_time: "08:00", end_time: "09:00", label: "" },
      h: window.ownerHelpers,
      async init() {
        await this.load();
      },
      async load() {
        this.state = "loading";
        const [blockRes, resRes] = await Promise.all([
          PortalApi.get("/api/portal/owner/blocks"),
          PortalApi.get("/api/portal/owner/resources"),
        ]);
        if (!blockRes.ok) {
          this.state = classify(blockRes);
          return;
        }
        this.blocks = blockRes.data || [];
        this.resources = resRes.ok ? resRes.data || [] : [];
        this.state = this.blocks.length === 0 ? "empty" : "ok";
      },
      get weekly() {
        return this.blocks.filter((b) => b.kind === "weekly");
      },
      get oneOff() {
        return this.blocks.filter((b) => b.kind !== "weekly");
      },
      openSheet() {
        this.sheetOpen = true;
      },
      toggleResource(id) {
        const i = this.form.resource_ids.indexOf(id);
        if (i === -1) this.form.resource_ids.push(id);
        else this.form.resource_ids.splice(i, 1);
      },
      async save() {
        const res = await PortalApi.post("/api/portal/owner/blocks", this.form);
        if (res.ok) {
          this.sheetOpen = false;
          await this.load();
        }
      },
      async remove(block) {
        const res = await PortalApi.del("/api/portal/owner/blocks/" + block.id);
        if (res.ok) await this.load();
      },
    };
  };

  // ---------------------------------------------------------------
  // Late hours: the owner extends one day's court closing time (PIN L3)
  // ---------------------------------------------------------------
  window.ownerLateHours = function () {
    return {
      state: "loading",
      days: [],
      date: "",
      message: "",
      h: window.ownerHelpers,
      async init() {
        await this.load();
      },
      async load() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/day-extensions");
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        this.days = res.data || [];
        this.state = "ok";
      },
      // Said in the owner's words; a code with no sentence falls back to
      // the generic one rather than showing the code.
      sentence(code) {
        const key = "late.err_" + code;
        const text = window.t(key);
        return text === key ? window.t("state.error_body") : text;
      },
      note(res) {
        const n = res.data && res.data.late_bookings;
        return n > 0 ? window.t("late.running_late", { n }) : "";
      },
      async extend() {
        this.message = "";
        const res = await PortalApi.post("/api/portal/owner/day-extensions", { date: this.date, close_time: "21:00" });
        if (!res.ok) {
          this.message = this.sentence(res.error);
          return;
        }
        this.date = "";
        await this.load();
      },
      async clear(day) {
        this.message = "";
        const res = await PortalApi.del("/api/portal/owner/day-extensions/" + day.date);
        if (!res.ok) {
          this.message = this.sentence(res.error);
          return;
        }
        this.message = this.note(res);
        await this.load();
      },
    };
  };

  // ---------------------------------------------------------------
  // O8 Calendar sync
  // ---------------------------------------------------------------
  window.ownerSync = function () {
    return {
      state: "loading",
      configured: false,
      pending: 0,
      failed: [],
      h: window.ownerHelpers,
      async init() {
        await this.load();
      },
      async load() {
        this.state = "loading";
        const res = await PortalApi.get("/api/portal/owner/outbox");
        if (!res.ok) {
          this.state = classify(res);
          return;
        }
        const d = res.data || {};
        this.pending = d.pending || 0;
        this.failed = d.failed || [];
        this.configured = d.configured !== false;
        this.state = "ok";
      },
    };
  };

  // ---------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------
  const ROUTES = [
    [/^#\/today$/, "owner-today"],
    [/^#\/members$/, "owner-members"],
    [/^#\/members\/([^/?]+)/, "owner-member-detail"],
    [/^#\/owner-book$/, "owner-book"],
    [/^#\/manage\/resources\/([^/?]+)/, "owner-resource-editor"],
    [/^#\/manage\/resources$/, "owner-resources"],
    [/^#\/manage\/prices$/, "owner-prices"],
    [/^#\/manage\/blocks$/, "owner-blocks"],
    [/^#\/manage\/late-hours$/, "owner-late-hours"],
    [/^#\/manage\/sync$/, "owner-sync"],
    [/^#\/manage$/, "owner-manage"],
  ];

  const viewCache = {};
  async function loadView(name) {
    if (!viewCache[name]) {
      const r = await fetch("/portal/views/" + name + ".html");
      viewCache[name] = await r.text();
    }
    return viewCache[name];
  }

  let currentParam = null;
  window.ownerRouteParam = function () {
    return currentParam;
  };

  async function render() {
    const session = await window.PortalApp.bootstrapSession();
    if (!session.authenticated || !session.account || session.account.role !== "owner") return; // not this area's route to own

    const hash = window.location.hash || "#/today";
    let view = null;
    let param = null;
    for (const [re, name] of ROUTES) {
      const m = re.exec(hash);
      if (m) {
        view = name;
        param = m[1] || null;
        break;
      }
    }
    if (!view) {
      if (hash !== "#/today") {
        window.location.hash = "#/today";
        return;
      }
      view = "owner-today";
    }
    currentParam = param;
    const mount = document.getElementById("portal-area");
    if (!mount) return;
    mount.innerHTML = await loadView(view);
    window.Alpine.initTree(mount);
  }

  window.PortalAreas.owner = { render };
  window.addEventListener("hashchange", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
