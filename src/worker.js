// Jungle Pickleball Worker: static site + admin/booking API.
// Assets are served by the assets layer first; this script only receives
// requests that match no static file (i.e. /api/* and true 404s).

const SESSION_COOKIE = "jp_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SITE_ID = "junglepickleball"; // wizardweb analytics site_id
const COURTS = 4;

// ---------- small helpers ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function nowIso() { return new Date().toISOString(); }

function b64urlEncode(str) {
  return btoa(str).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(str) {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}
function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const m = hex.match(/.{1,2}/g) || [];
  return new Uint8Array(m.map((h) => parseInt(h, 16)));
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, usage);
}
async function signSession(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toHex(sig)}`;
}
async function verifySession(token, secret) {
  if (!token || token.indexOf(".") === -1) return null;
  const [body, sigHex] = token.split(".");
  const key = await hmacKey(secret, ["verify"]);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, fromHex(sigHex), new TextEncoder().encode(body));
  } catch { return null; }
  if (!ok) return null;
  try {
    const data = JSON.parse(b64urlDecode(body));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch { return false; }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- events (KV) ----------

const EVENTS_KEY = "events";

async function getStoredEvents(env) {
  const raw = await env.EVENTS.get(EVENTS_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
async function putEvents(env, events) {
  await env.EVENTS.put(EVENTS_KEY, JSON.stringify(events));
}
function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function normalizeEvent(input, existing = {}) {
  const allowedCategories = ["weekly", "special"];
  const category = allowedCategories.includes(input.category) ? input.category : existing.category || "weekly";
  const status = input.status === "archived" ? "archived" : input.status === "active" ? "active" : existing.status || "active";
  return {
    id: existing.id || newId(),
    title: String(input.title ?? existing.title ?? "").trim().slice(0, 200),
    when: String(input.when ?? existing.when ?? "").trim().slice(0, 120),
    time: String(input.time ?? existing.time ?? "").trim().slice(0, 120),
    description: String(input.description ?? existing.description ?? "").trim().slice(0, 1000),
    category,
    status,
    featured: Boolean(input.featured ?? existing.featured ?? false),
    ctaLabel: String(input.ctaLabel ?? existing.ctaLabel ?? "").trim().slice(0, 60),
    ctaUrl: String(input.ctaUrl ?? existing.ctaUrl ?? "").trim().slice(0, 500),
    // Corner tag on featured cards. Blank falls back to "Tournament" in the renderer.
    badge: String(input.badge ?? existing.badge ?? "").trim().slice(0, 40),
    images: Array.isArray(input.images)
      ? input.images.filter((x) => typeof x === "string" && x.trim()).slice(0, 8)
      : existing.images || [],
    date: typeof input.date === "string" && DATE_RE.test(input.date) ? input.date : existing.date || "",
    order: Number.isFinite(+input.order) ? +input.order : existing.order ?? 100,
    updatedAt: nowIso(),
  };
}

const DEFAULT_EVENTS = [
  { id: "redcross-firstaid-2026", title: "Community Training: Lifesaving First Aid", when: "Sunday, September 27, 2026", date: "2026-09-27", time: "1:00 PM to 5:00 PM, in English, at Jungle Pickleball Ojochal", description: "FREE community training in Lifesaving First Aid, taught by Oscar Aguilar Fonseca, National Coordinator of Lifeguards of the Costa Rican Red Cross. Topics include safety aspects, initial patient assessment, 9-1-1 activation, basic CPR, ventilation, and safe AED use. In collaboration with Ama Más / LoveMoreLiveMore and Jungle Pickleball. This session is in English at Jungle Pickleball Ojochal. A Spanish-language session runs Saturday, September 26, 1:00 to 5:00 PM at Salón Comunal Ojochal. Tap the flyer for full details.", category: "special", featured: true, ctaLabel: "JOIN US", ctaUrl: "https://wa.me/50689893111?text=I%20want%20to%20join%20the%20Red%20Cross%20First%20Aid%20Training", order: 7, status: "active", images: ["assets/events/redcross-firstaid.jpg"] },
  { id: "open-play", title: "Open Play", when: "Tuesdays & Thursdays", time: "10:00 AM Start", description: "Our most popular session. All skill levels welcome, so just rotate in and enjoy the game.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 10, status: "active" },
  { id: "wed-open-play", title: "Open Play", when: "Wednesdays", time: "8:30 AM Start", description: "Mid-week open play for all levels. Rotate in and enjoy the game.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 15, status: "active" },
  { id: "womens-open", title: "Women's Open", when: "Fridays", time: "8:30 AM Start", description: "A supportive and competitive session dedicated to our women players.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 20, status: "active" },
  { id: "sunday-swish", title: "The Sunday Swish", when: "Sunday Mornings", time: "8:30 AM Start", description: "Our top social mixer. A rotating-partners format with nine games guaranteed.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 30, status: "active" },
  { id: "alternating-opens", title: "Alternating Opens", when: "Mon & Sat", time: "Check Availability", description: "Flex days with times that vary by demand. Text Roger on WhatsApp to confirm open slots.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 40, status: "active" },
  { id: "marlapalooza-2026", title: "Marlapalooza 2026", when: "Tuesday, July 28, 2026", date: "2026-07-28", time: "11:00 AM to 3:00 PM", description: "Pickleball, cornhole, great friends, and lots of fun. Bring your favorite appetizer to share and your own drinks. Hotdogs and beverages available for purchase. Please no gifts. Instead consider donating to Shauna's animal rescue efforts. Puppies will be on site to snuggle with, looking for their forever family. Tap the flyer for full details.", category: "special", featured: true, ctaLabel: "JOIN US", ctaUrl: "https://wa.me/50689893111?text=I%20want%20to%20join%20Marlapalooza%202026", order: 6, status: "active", images: ["assets/events/marlapalooza-2026.jpg"] },
  { id: "bring-a-friend-opens", title: "Bring a Friend to Opens", when: "Now through November 22", time: "Any Open Play session", description: "New friends, and anyone who hasn't played here in the last 6 months, play free, twice, at any Open. Bring them along and the drinks are on us: members who bring a friend get a free drink of their choice, or a float.", category: "special", featured: true, ctaLabel: "BRING A FRIEND", ctaUrl: "https://wa.me/50689893111?text=I%20want%20to%20bring%20a%20friend%20to%20Jungle%20Pickleball%20Opens", order: 8, status: "active", badge: "Promo" },
  { id: "glow-open-tournament", title: "Glow in the Dark Fun Tournament", when: "Wednesday, October 28, 2026", date: "2026-10-28", time: "Opens 5:00 PM for food and practice. Games start about 6:00 PM.", description: "Mixed teams, round robin, all classes welcome. This one is just for fun, played under the black light. $10 per person (member or nonmember), price includes catered food. Wear a white top to glow and stand out! Spectators are free; if a spectator wants the meal, it's $10. Beautiful medals for 1st, 2nd & 3rd. If signups run high we'll add dates November 4 and November 11. Sign up online at junglepickleball.com.", category: "special", featured: true, ctaLabel: "SIGN UP", ctaUrl: "/glow", order: 1, status: "active", images: ["assets/events/glow-tournament-2026.jpg"] },
];

function isPast(dateStr) {
  if (!dateStr || !DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return new Date(Date.UTC(y, m - 1, d)) < today;
}

// ---------- Glow in the Dark tournament signups (KV) ----------
// One named activity, one read-modify-write function: "sign up for the
// glow tournament." Mirrors the events array's own KV shape (list stored
// whole, under one key) so there is exactly one pattern for list-shaped
// KV data in this file, not two.

const GLOW_SIGNUPS_KEY = "glow_signups";
const GLOW_PRICE_NOTE = "$10 per player (member or nonmember, food included); spectator meal $10; spectator without a meal is free.";

// ---------- Glow tournament payment (Stripe Checkout) ----------
// Prices come from the owner's order (Clinton, 2026-10-03), not from a
// Stripe product — there is nothing to look up by lookup_key here, so the
// Checkout Session line item is built inline with price_data. Currency is
// USD: every existing Stripe reference in this repo (membership-page
// branch's scripts/stripe-setup.mjs and src/worker.js) uses "usd" and
// Roger's posted pricing is in USD, so no other currency is in play.
const GLOW_CURRENCY = "usd";
const GLOW_PLAYER_PRICE_CENTS = 1000;
const GLOW_SPECTATOR_MEAL_PRICE_CENTS = 1000;
// Team pricing (owner's 2026-10-04 flyer): team size is not yet confirmed by
// Clinton, so this constant exists for the form and amount calc to switch to
// once he confirms it, but the team option stays hidden (see glow.html) and
// no code path charges GLOW_TEAM_PRICE_CENTS until that happens.
const GLOW_TEAM_SIZE = null;
const GLOW_TEAM_PRICE_CENTS = 4000;
const STRIPE_API = "https://api.stripe.com/v1";

// One pure function computes the amount for a signup; both the checkout
// path and the free/pay-at-event paths call this same function so the
// price is never computed two different ways.
function computeGlowAmountCents(input) {
  const people = Number.isInteger(+input.people) && +input.people > 0 ? +input.people : 1;
  if (input.role === "player") return people * GLOW_PLAYER_PRICE_CENTS;
  if (input.role === "spectator" && input.spectatorMeal) return people * GLOW_SPECTATOR_MEAL_PRICE_CENTS;
  return 0;
}

// Same bracket-nested form encoding the membership-page branch's checkout
// handler uses for every Stripe API call (Stripe's API takes
// application/x-www-form-urlencoded, not JSON).
function stripeForm(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const arrKey = `${key}[${i}]`;
        if (item && typeof item === "object") parts.push(stripeForm(item, arrKey));
        else parts.push(`${encodeURIComponent(arrKey)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === "object") {
      parts.push(stripeForm(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? stripeForm(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || `Stripe error ${res.status}`);
  return data;
}

async function createGlowCheckoutSession(env, url, signup) {
  const name = signup.role === "player"
    ? "Glow in the Dark Fun Tournament, Player (incl. catered food)"
    : "Glow in the Dark Fun Tournament, Spectator meal";
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    line_items: [{
      quantity: signup.people,
      price_data: {
        currency: GLOW_CURRENCY,
        unit_amount: signup.role === "player" ? GLOW_PLAYER_PRICE_CENTS : GLOW_SPECTATOR_MEAL_PRICE_CENTS,
        product_data: { name },
      },
    }],
    metadata: { signup_id: signup.id },
    success_url: `${url.origin}/glow?paid=1&id=${encodeURIComponent(signup.id)}`,
    cancel_url: `${url.origin}/glow?cancelled=1`,
  });
}

// Stripe's documented webhook signing scheme: header is
// "t=<timestamp>,v1=<hex hmac>[,v1=<hex hmac>...]"; the signed payload is
// "<timestamp>.<raw body>", HMAC-SHA256 with the endpoint secret. Rejects
// anything that doesn't match rather than trusting an unsigned or
// mis-signed body — this is the only door that can mark a signup paid.
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=")).filter((kv) => kv.length === 2)
  );
  const timestamp = parts.t;
  const candidates = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!timestamp || candidates.length === 0) return false;
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = toHex(sig);
  return candidates.some((c) => timingSafeEqual(c, expected));
}

// The one place a signup's payment status is ever changed after creation.
// Read-modify-write over the same list key as createGlowSignup, so there
// is exactly one write path for this record, not a second one living next
// to the webhook. Repeatable: marking an already-paid signup paid again
// with the same session id leaves the list unchanged (the run-it-twice
// case the webhook itself can trigger if Stripe retries delivery).
async function markGlowSignupPaid(env, signupId, amountCents, stripeSessionId) {
  const list = await getGlowSignups(env);
  const idx = list.findIndex((s) => s.id === signupId);
  if (idx === -1) return false;
  const current = list[idx];
  if (current.status === "paid" && current.stripeSessionId === stripeSessionId) return true;
  list[idx] = { ...current, status: "paid", amountCents, currency: GLOW_CURRENCY, stripeSessionId };
  await env.EVENTS.put(GLOW_SIGNUPS_KEY, JSON.stringify(list));
  return true;
}

async function getGlowSignups(env) {
  const raw = await env.EVENTS.get(GLOW_SIGNUPS_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function validGlowInput(b) {
  if (!b || typeof b !== "object") return "Invalid request.";
  if (!b.name || !String(b.name).trim()) return "Name is required.";
  if (!b.phone || !String(b.phone).trim()) return "A phone or WhatsApp number is required.";
  if (b.role !== "player" && b.role !== "spectator") return "Role must be player or spectator.";
  return null;
}

// The one place a signup is ever written. Read-modify-write under one KV
// put, so a second hand-written insert path can never diverge from this
// one. Not safe against two truly simultaneous writers racing the same
// millisecond (KV has no transaction); acceptable for a club-sized signup
// sheet, same risk the events-admin list already carries today.
async function createGlowSignup(env, input) {
  const list = await getGlowSignups(env);
  const people = Number.isInteger(+input.people) && +input.people > 0 ? +input.people : 1;
  const role = input.role;
  const spectatorMeal = role === "spectator" ? Boolean(input.spectatorMeal) : false;
  const amountCents = computeGlowAmountCents({ role, spectatorMeal, people });
  // Status at creation reflects only what's known before any Stripe call:
  // nothing owed, or owed-but-unconfigured, or owed-and-about-to-checkout.
  // handleGlowSignup is the only caller and decides which; the webhook
  // (markGlowSignupPaid) is the only place status ever becomes 'paid'.
  const status = amountCents === 0 ? "free" : (env.STRIPE_SECRET_KEY ? "pending_payment" : "pay_at_event");
  const signup = {
    id: newId(),
    name: String(input.name).trim().slice(0, 200),
    phone: String(input.phone).trim().slice(0, 60),
    email: String(input.email ?? "").trim().slice(0, 200),
    member: Boolean(input.member),
    role,
    spectatorMeal,
    partnerName: String(input.partnerName ?? "").trim().slice(0, 200),
    people,
    notes: String(input.notes ?? "").trim().slice(0, 1000),
    amountCents,
    currency: GLOW_CURRENCY,
    status,
    stripeSessionId: null,
    createdAt: nowIso(),
  };
  list.push(signup);
  await env.EVENTS.put(GLOW_SIGNUPS_KEY, JSON.stringify(list));
  return signup;
}

// The one place a signup's Stripe Checkout Session id is recorded right
// after creation (needed so the success/cancel redirect and the webhook
// can both find the row by session id if metadata is ever missing it).
async function setGlowSignupStripeSession(env, signupId, stripeSessionId) {
  const list = await getGlowSignups(env);
  const idx = list.findIndex((s) => s.id === signupId);
  if (idx === -1) return false;
  list[idx] = { ...list[idx], stripeSessionId };
  await env.EVENTS.put(GLOW_SIGNUPS_KEY, JSON.stringify(list));
  return true;
}

async function notifyGlowSignup(env, signup) {
  if (!env.WARD_MAIL || !env.WARD_SEND_SECRET) {
    return { sent: false, reason: "Mail not configured (WARD_MAIL binding / WARD_SEND_SECRET not set)." };
  }
  try {
    const res = await env.WARD_MAIL.fetch("https://ward-mail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ward-secret": env.WARD_SEND_SECRET },
      body: JSON.stringify({
        to: "cwasylishen@gmail.com",
        from: "ward@wizardweb.ca",
        subject: `Glow Tournament signup: ${signup.name}`,
        text: [
          `New Glow in the Dark Fun Tournament signup.`,
          ``,
          `Name: ${signup.name}`,
          `Phone/WhatsApp: ${signup.phone}`,
          `Email: ${signup.email || "(none)"}`,
          `Member: ${signup.member ? "Yes" : "No"}`,
          `Role: ${signup.role}`,
          signup.role === "spectator" ? `Wants the meal: ${signup.spectatorMeal ? "Yes ($10)" : "No"}` : null,
          `Partner: ${signup.partnerName || "(none)"}`,
          `People: ${signup.people}`,
          `Notes: ${signup.notes || "(none)"}`,
          `Amount: $${(signup.amountCents / 100).toFixed(2)} ${signup.currency.toUpperCase()}`,
          `Payment status: ${signup.status}`,
          ``,
          GLOW_PRICE_NOTE,
        ].filter(Boolean).join("\n"),
      }),
    });
    if (!res.ok) return { sent: false, reason: `ward-mail returned ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: String((err && err.message) || err).slice(0, 200) };
  }
}

async function handleGlowSignup(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:glow:${ip}`;
  const attempts = parseInt((await env.EVENTS.get(rlKey)) || "0", 10);
  if (attempts >= 5) {
    return json({ error: "Too many signups from this connection. Please wait a few minutes and try again, or message Roger on WhatsApp." }, 429);
  }
  await env.EVENTS.put(rlKey, String(attempts + 1), { expirationTtl: 900 });

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  // Honeypot: a real visitor never fills this hidden field. Any value in
  // it answers the request with a fake success instead of an error, so a
  // bot's script sees nothing to retry against.
  if (body && String(body.website || "").trim()) {
    return json({ ok: true, signup: { id: newId() }, mail: { sent: false, reason: "skipped" } }, 201);
  }

  const err = validGlowInput(body);
  if (err) return json({ error: err }, 400);

  const signup = await createGlowSignup(env, body);

  if (signup.status === "pending_payment") {
    try {
      const url = new URL(request.url);
      const session = await createGlowCheckoutSession(env, url, signup);
      await setGlowSignupStripeSession(env, signup.id, session.id);
      const mail = await notifyGlowSignup(env, { ...signup, stripeSessionId: session.id });
      return json({ ok: true, signup, checkoutUrl: session.url, mail }, 201);
    } catch (checkoutErr) {
      // The signup row already exists (status pending_payment) so Clinton
      // can still see and follow up on it; the visitor gets a clear error
      // instead of a dead end, not a silent downgrade to pay-at-event.
      return json({
        error: `Could not start payment: ${String((checkoutErr && checkoutErr.message) || checkoutErr).slice(0, 200)}. Message Roger on WhatsApp and he'll get you sorted at the event.`,
      }, 502);
    }
  }

  const mail = await notifyGlowSignup(env, signup);
  const message = signup.status === "free"
    ? `Thanks, ${signup.name}! You're on the list for the Glow in the Dark Fun Tournament.`
    : `Thanks, ${signup.name}! You're on the list for the Glow in the Dark Fun Tournament. Pay at the event, $${(signup.amountCents / 100).toFixed(2)} ${signup.currency.toUpperCase()}.`;
  return json({ ok: true, signup, message, mail }, 201);
}

// The one place a signup is ever removed (test rows, spam, a cancellation
// Clinton reads to him over the phone). Same read-modify-write shape as
// createGlowSignup; no second deletion path exists.
async function deleteGlowSignup(env, id) {
  const list = await getGlowSignups(env);
  const next = list.filter((s) => s.id !== id);
  const removed = next.length !== list.length;
  if (removed) await env.EVENTS.put(GLOW_SIGNUPS_KEY, JSON.stringify(next));
  return removed;
}

async function handleGlowList(request, env, url) {
  if (!env.GLOW_LIST_KEY) {
    return json({ error: "The list view is not configured yet. Set GLOW_LIST_KEY on the Worker." }, 503);
  }
  const key = url.searchParams.get("key") || "";
  if (!timingSafeEqual(key, env.GLOW_LIST_KEY)) {
    return json({ error: "Not authorized." }, 401);
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!id) return json({ error: "id is required." }, 400);
    const removed = await deleteGlowSignup(env, id);
    return removed ? json({ ok: true }) : json({ error: "Signup not found." }, 404);
  }
  const list = await getGlowSignups(env);
  const players = list.filter((s) => s.role === "player");
  const spectators = list.filter((s) => s.role === "spectator");
  const meals = spectators.filter((s) => s.spectatorMeal).length;
  const paid = list.filter((s) => s.status === "paid");
  const pending = list.filter((s) => s.status === "pending_payment");
  const payAtEvent = list.filter((s) => s.status === "pay_at_event");
  return json({
    counts: {
      players: players.length,
      spectators: spectators.length,
      spectatorMeals: meals,
      totalPeople: list.reduce((sum, s) => sum + (s.people || 1), 0),
      rows: list.length,
      paid: paid.length,
      paidCents: paid.reduce((sum, s) => sum + (s.amountCents || 0), 0),
      pendingPayment: pending.length,
      payAtEvent: payAtEvent.length,
    },
    signups: list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  });
}

// ---------- Glow tournament Stripe webhook ----------
//
// Stripe signs the raw request body, so this reads request.text() (never
// request.json()) and verifies before parsing. checkout.session.completed
// is the only event type this handler acts on; every other event type is
// acknowledged 200 so Stripe doesn't retry it forever, but changes nothing.
async function handleGlowStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: "Webhook not configured. Set STRIPE_WEBHOOK_SECRET on the Worker." }, 503);
  }
  const rawBody = await request.text();
  const sigHeader = request.headers.get("Stripe-Signature");
  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "Invalid signature." }, 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "Invalid payload." }, 400); }

  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object;
    const signupId = session && session.metadata && session.metadata.signup_id;
    if (!signupId) return json({ error: "Missing signup_id metadata on session." }, 400);
    const ok = await markGlowSignupPaid(env, signupId, session.amount_total ?? 0, session.id);
    if (!ok) return json({ error: `No signup found for id ${signupId}.` }, 404);
  }
  return json({ received: true });
}

// ---------- D1 schema (self-provisioning) ----------

let schemaReady = false;
const DEFAULT_RULES = {
  open: "07:00", close: "19:30", slotMinutes: 30,
  durations: [60, 90], maxDaysAhead: 7, maxActivePerMember: 1,
  note: "Defaults pending Roger's guidelines",
};

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, phone TEXT,
      plan TEXT NOT NULL DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'active',
      pay_method TEXT NOT NULL DEFAULT 'cash', stripe_customer_id TEXT, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, start TEXT NOT NULL,
      end TEXT NOT NULL, court INTEGER NOT NULL, name TEXT NOT NULL, member_id INTEGER,
      source TEXT NOT NULL DEFAULT 'admin', status TEXT NOT NULL DEFAULT 'confirmed',
      notes TEXT, gcal_event_id TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
      method TEXT NOT NULL DEFAULT 'cash', stripe_ref TEXT, note TEXT, paid_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_members_status ON members(status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, court, status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(member_id, paid_at)`),
    env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('booking_rules', ?)`)
      .bind(JSON.stringify(DEFAULT_RULES)),
  ]);
  schemaReady = true;
}

function requireDb(env) {
  if (!env.DB) {
    return json({ error: "Database not provisioned yet. Create the D1 binding and redeploy." }, 503);
  }
  return null;
}

// ---------- route handlers ----------

async function handleLogin(request, env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "Server is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET on the Worker." }, 500);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:${ip}`;
  const attempts = parseInt((await env.EVENTS.get(rlKey)) || "0", 10);
  if (attempts >= 8) {
    return json({ error: "Too many attempts. Please wait a few minutes and try again." }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const { username, password, turnstileToken } = body || {};

  // Turnstile is enforced only once its secret is configured.
  if (env.TURNSTILE_SECRET_KEY) {
    const ok = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
    if (!ok) return json({ error: "Bot check failed. Please try again." }, 403);
  }

  const userOk = timingSafeEqual(String(username || ""), env.ADMIN_USERNAME);
  const passOk = timingSafeEqual(String(password || ""), env.ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    await env.EVENTS.put(rlKey, String(attempts + 1), { expirationTtl: 900 });
    return json({ error: "Incorrect username or password." }, 401);
  }
  await env.EVENTS.delete(rlKey);
  const token = await signSession({ u: env.ADMIN_USERNAME, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = getCookie(request, SESSION_COOKIE);
  return !!(await verifySession(token, env.SESSION_SECRET));
}

async function publicEvents(env) {
  const stored = await getStoredEvents(env);
  const list = stored ?? DEFAULT_EVENTS;
  const active = list
    .filter((e) => e.status !== "archived")
    .filter((e) => !isPast(e.date))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return json({ events: active });
}

// --- admin: events (KV) ---

async function adminEvents(request, env, id) {
  if (request.method === "GET") {
    let list = await getStoredEvents(env);
    if (list === null) {
      list = DEFAULT_EVENTS.map((e) => ({ ...e }));
      await putEvents(env, list);
    }
    list = list.slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return json({ events: list });
  }
  if (request.method === "POST" && !id) {
    const list = (await getStoredEvents(env)) ?? [];
    let input;
    try { input = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    if (!input.title || !String(input.title).trim()) return json({ error: "Title is required." }, 400);
    if (input.order == null) input.order = list.reduce((m, e) => Math.max(m, e.order ?? 0), 0) + 10;
    const event = normalizeEvent(input);
    list.push(event);
    await putEvents(env, list);
    return json({ event }, 201);
  }
  if (id && (request.method === "PUT" || request.method === "DELETE")) {
    const list = (await getStoredEvents(env)) ?? [];
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return json({ error: "Event not found." }, 404);
    if (request.method === "DELETE") {
      list.splice(idx, 1);
      await putEvents(env, list);
      return json({ ok: true });
    }
    let input;
    try { input = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const updated = normalizeEvent(input, list[idx]);
    updated.id = list[idx].id;
    list[idx] = updated;
    await putEvents(env, list);
    return json({ event: updated });
  }
  return json({ error: "Method not allowed." }, 405);
}

// --- admin: bookings (D1) ---

function validBookingInput(b) {
  if (!b || typeof b !== "object") return "Invalid request.";
  if (!DATE_RE.test(b.date || "")) return "A valid date is required.";
  if (!TIME_RE.test(b.start || "") || !TIME_RE.test(b.end || "")) return "Valid start and end times are required.";
  if (b.end <= b.start) return "End time must be after the start time.";
  const court = +b.court;
  if (!Number.isInteger(court) || court < 1 || court > COURTS) return `Court must be 1 to ${COURTS}.`;
  if (!b.name || !String(b.name).trim()) return "A name is required.";
  return null;
}

async function adminBookings(request, env, id, url) {
  await ensureSchema(env);
  if (request.method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to") || from;
    if (!DATE_RE.test(from || "")) return json({ error: "from date required (YYYY-MM-DD)." }, 400);
    const rows = await env.DB.prepare(
      `SELECT * FROM bookings WHERE date >= ? AND date <= ? AND status = 'confirmed' ORDER BY date, court, start`
    ).bind(from, to).all();
    return json({ bookings: rows.results || [] });
  }
  if (request.method === "POST" && !id) {
    let b;
    try { b = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const err = validBookingInput(b);
    if (err) return json({ error: err }, 400);
    const clash = await env.DB.prepare(
      `SELECT id, name, start, end FROM bookings
       WHERE date = ? AND court = ? AND status = 'confirmed' AND start < ? AND end > ? LIMIT 1`
    ).bind(b.date, +b.court, b.end, b.start).first();
    if (clash) {
      return json({ error: `Court ${b.court} is already booked ${clash.start} to ${clash.end} (${clash.name}).` }, 409);
    }
    const source = ["admin", "cash", "whatsapp", "member", "block"].includes(b.source) ? b.source : "admin";
    const res = await env.DB.prepare(
      `INSERT INTO bookings (date, start, end, court, name, member_id, source, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(b.date, b.start, b.end, +b.court, String(b.name).trim().slice(0, 120),
      Number.isInteger(+b.member_id) && +b.member_id > 0 ? +b.member_id : null,
      source, String(b.notes || "").slice(0, 500), nowIso()).run();
    return json({ ok: true, id: res.meta.last_row_id }, 201);
  }
  if (id && request.method === "DELETE") {
    const res = await env.DB.prepare(`UPDATE bookings SET status = 'canceled' WHERE id = ? AND status = 'confirmed'`)
      .bind(+id).run();
    if (!res.meta.changes) return json({ error: "Booking not found." }, 404);
    return json({ ok: true });
  }
  return json({ error: "Method not allowed." }, 405);
}

// --- admin: members + payments (D1) ---

async function adminMembers(request, env, id, sub) {
  await ensureSchema(env);
  if (request.method === "GET" && !id) {
    const rows = await env.DB.prepare(
      `SELECT m.*, (SELECT MAX(paid_at) FROM payments p WHERE p.member_id = m.id) AS last_paid_at
       FROM members m ORDER BY m.name COLLATE NOCASE`
    ).all();
    return json({ members: rows.results || [] });
  }
  if (request.method === "POST" && !id) {
    let b;
    try { b = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    if (!b.name || !String(b.name).trim()) return json({ error: "Name is required." }, 400);
    const res = await env.DB.prepare(
      `INSERT INTO members (name, email, phone, plan, status, pay_method, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(String(b.name).trim().slice(0, 120), String(b.email || "").trim().slice(0, 200),
      String(b.phone || "").trim().slice(0, 40), String(b.plan || "monthly").slice(0, 40),
      ["active", "past_due", "canceled"].includes(b.status) ? b.status : "active",
      ["cash", "stripe"].includes(b.pay_method) ? b.pay_method : "cash",
      String(b.notes || "").slice(0, 500), nowIso(), nowIso()).run();
    return json({ ok: true, id: res.meta.last_row_id }, 201);
  }
  if (id && sub === "payments" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const cents = Math.round(Number(b.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return json({ error: "A valid amount is required." }, 400);
    const member = await env.DB.prepare(`SELECT id FROM members WHERE id = ?`).bind(+id).first();
    if (!member) return json({ error: "Member not found." }, 404);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payments (member_id, amount_cents, method, note, paid_at) VALUES (?,?,?,?,?)`)
        .bind(+id, cents, "cash", String(b.note || "").slice(0, 300), nowIso()),
      env.DB.prepare(`UPDATE members SET status = 'active', updated_at = ? WHERE id = ?`).bind(nowIso(), +id),
    ]);
    return json({ ok: true }, 201);
  }
  if (id && sub === "payments" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT * FROM payments WHERE member_id = ? ORDER BY paid_at DESC LIMIT 50`
    ).bind(+id).all();
    return json({ payments: rows.results || [] });
  }
  if (id && request.method === "PUT") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const existing = await env.DB.prepare(`SELECT * FROM members WHERE id = ?`).bind(+id).first();
    if (!existing) return json({ error: "Member not found." }, 404);
    const status = ["active", "past_due", "canceled"].includes(b.status) ? b.status : existing.status;
    await env.DB.prepare(
      `UPDATE members SET name=?, email=?, phone=?, plan=?, status=?, pay_method=?, notes=?, updated_at=? WHERE id=?`
    ).bind(
      String(b.name ?? existing.name).trim().slice(0, 120),
      String(b.email ?? existing.email ?? "").trim().slice(0, 200),
      String(b.phone ?? existing.phone ?? "").trim().slice(0, 40),
      String(b.plan ?? existing.plan).slice(0, 40),
      status,
      ["cash", "stripe"].includes(b.pay_method) ? b.pay_method : existing.pay_method,
      String(b.notes ?? existing.notes ?? "").slice(0, 500),
      nowIso(), +id
    ).run();
    return json({ ok: true });
  }
  return json({ error: "Method not allowed." }, 405);
}

// --- admin: stats from the wizardweb analytics D1 ---

async function adminStats(env, url) {
  if (!env.ANALYTICS) return json({ error: "Analytics binding not configured yet." }, 503);
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10)));
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();
  const totals = await env.ANALYTICS.prepare(
    `SELECT
       SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS pageviews,
       COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) AS visitors,
       SUM(CASE WHEN type='whatsapp' THEN 1 ELSE 0 END) AS whatsapp
     FROM analytics_events WHERE site_id = ? AND ts >= ?`
  ).bind(SITE_ID, sinceIso).first();
  const byDay = await env.ANALYTICS.prepare(
    `SELECT substr(ts, 1, 10) AS day,
       SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS pageviews,
       COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) AS visitors,
       SUM(CASE WHEN type='whatsapp' THEN 1 ELSE 0 END) AS whatsapp
     FROM analytics_events WHERE site_id = ? AND ts >= ?
     GROUP BY day ORDER BY day DESC`
  ).bind(SITE_ID, sinceIso).all();
  return json({ days, totals: totals || {}, byDay: byDay.results || [] });
}

// --- admin: dashboard summary ---

async function adminSummary(env, url) {
  await ensureSchema(env);
  const date = DATE_RE.test(url.searchParams.get("date") || "") ? url.searchParams.get("date")
    : new Date().toISOString().slice(0, 10);
  const [bookings, pastDue, memberCount] = await Promise.all([
    env.DB.prepare(`SELECT * FROM bookings WHERE date = ? AND status = 'confirmed' ORDER BY court, start`)
      .bind(date).all(),
    env.DB.prepare(`SELECT id, name, phone, plan FROM members WHERE status = 'past_due' ORDER BY name`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE status != 'canceled'`).first(),
  ]);
  let stats = null;
  if (env.ANALYTICS) {
    try {
      const since = new Date(Date.now() - 6 * 86400000);
      since.setUTCHours(0, 0, 0, 0);
      stats = await env.ANALYTICS.prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) AS visitors,
           SUM(CASE WHEN type='whatsapp' THEN 1 ELSE 0 END) AS whatsapp
         FROM analytics_events WHERE site_id = ? AND ts >= ?`
      ).bind(SITE_ID, since.toISOString()).first();
    } catch { stats = null; }
  }
  return json({
    date,
    bookings: bookings.results || [],
    pastDue: pastDue.results || [],
    memberCount: memberCount ? memberCount.n : 0,
    stats7: stats,
  });
}

// --- admin: settings ---

async function adminSettings(request, env) {
  await ensureSchema(env);
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'booking_rules'`).first();
    let rules = DEFAULT_RULES;
    try { if (row) rules = JSON.parse(row.value); } catch {}
    return json({ rules });
  }
  if (request.method === "PUT") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('booking_rules', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(JSON.stringify(b || {}).slice(0, 4000)).run();
    return json({ ok: true });
  }
  return json({ error: "Method not allowed." }, 405);
}

// ---------- legacy redirects (belt and suspenders for the worker path) ----------

const REDIRECTS = { "/index.php": "/", "/home": "/", "/wp-login.php": "/", "/wp-admin": "/" };

// ---------- entry ----------

// Exported for tests/foundation/glow-signup.test.mjs (pure-logic probes;
// CTL-ENT-01/02 style — no network, no wrangler dev needed for these).
export {
  validGlowInput, createGlowSignup, getGlowSignups, deleteGlowSignup, handleGlowSignup, handleGlowList,
  computeGlowAmountCents, verifyStripeSignature, markGlowSignupPaid, handleGlowStripeWebhook,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p.startsWith("/api/")) {
        // public endpoints
        if (p === "/api/events" && request.method === "GET") return publicEvents(env);
        if (p === "/api/glow/signup" && request.method === "POST") return handleGlowSignup(request, env);
        if (p === "/api/glow/list" && (request.method === "GET" || request.method === "DELETE")) {
          return handleGlowList(request, env, url);
        }
        if (p === "/api/stripe/webhook" && request.method === "POST") return handleGlowStripeWebhook(request, env);
        if (p === "/api/config" && request.method === "GET") {
          return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || "" });
        }
        if (p === "/api/login" && request.method === "POST") return handleLogin(request, env);
        if (p === "/api/logout" && request.method === "POST") {
          return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
        }
        if (p === "/api/session" && request.method === "GET") {
          return json({ authed: await isAuthed(request, env) });
        }

        // guarded admin endpoints
        if (p.startsWith("/api/admin/")) {
          if (!(await isAuthed(request, env))) return json({ error: "Not authenticated." }, 401);
          const parts = p.slice("/api/admin/".length).split("/").filter(Boolean);
          const [resource, id, sub] = parts;

          if (resource === "events") return adminEvents(request, env, id);

          // everything below needs the database
          const dbErr = requireDb(env);
          if (dbErr && resource !== "stats") return dbErr;

          if (resource === "summary") return adminSummary(env, url);
          if (resource === "bookings") return adminBookings(request, env, id, url);
          if (resource === "members") return adminMembers(request, env, id, sub);
          if (resource === "settings") return adminSettings(request, env);
          if (resource === "stats") return adminStats(env, url);
        }
        return json({ error: "Not found." }, 404);
      }

      // Non-API request that matched no static asset.
      if (REDIRECTS[p] || p.startsWith("/wp-admin/")) {
        return Response.redirect(url.origin + (REDIRECTS[p] || "/"), 301);
      }
      // Note: the assets layer serves /404.html at the clean URL /404
      // (html_handling auto-trailing-slash), so fetch that path directly.
      const notFound = await env.ASSETS.fetch(url.origin + "/404");
      if (notFound.ok) {
        return new Response(notFound.body, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "Server error.", detail: String(err && err.message || err).slice(0, 200) }, 500);
    }
  },
};
