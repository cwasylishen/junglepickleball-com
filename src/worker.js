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
    images: Array.isArray(input.images)
      ? input.images.filter((x) => typeof x === "string" && x.trim()).slice(0, 8)
      : existing.images || [],
    date: typeof input.date === "string" && DATE_RE.test(input.date) ? input.date : existing.date || "",
    order: Number.isFinite(+input.order) ? +input.order : existing.order ?? 100,
    updatedAt: nowIso(),
  };
}

const DEFAULT_EVENTS = [
  { id: "open-play", title: "Open Play", when: "Tuesdays & Thursdays", time: "10:00 AM Start", description: "Our most popular session. All skill levels welcome, so just rotate in and enjoy the game.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 10, status: "active" },
  { id: "wed-open-play", title: "Open Play", when: "Wednesdays", time: "8:30 AM Start", description: "Mid-week open play for all levels. Rotate in and enjoy the game.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 15, status: "active" },
  { id: "womens-open", title: "Women's Open", when: "Fridays", time: "8:30 AM Start", description: "A supportive and competitive session dedicated to our women players.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 20, status: "active" },
  { id: "sunday-swish", title: "The Sunday Swish", when: "Sunday Mornings", time: "8:30 AM Start", description: "Our top social mixer. A rotating-partners format with nine games guaranteed.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 30, status: "active" },
  { id: "alternating-opens", title: "Alternating Opens", when: "Mon & Sat", time: "Check Availability", description: "Flex days with times that vary by demand. Text Roger on WhatsApp to confirm open slots.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 40, status: "active" },
  { id: "marlapalooza-2026", title: "Marlapalooza 2026", when: "Tuesday, July 28, 2026", date: "2026-07-28", time: "11:00 AM to 3:00 PM", description: "Pickleball, cornhole, great friends, and lots of fun. Bring your favorite appetizer to share and your own drinks. Hotdogs and beverages available for purchase. Please no gifts. Instead consider donating to Shauna's animal rescue efforts. Puppies will be on site to snuggle with, looking for their forever family. Tap the flyer for full details.", category: "special", featured: true, ctaLabel: "JOIN US", ctaUrl: "https://wa.me/50689893111?text=I%20want%20to%20join%20Marlapalooza%202026", order: 6, status: "active", images: ["assets/events/marlapalooza-2026.jpg"] },
];

function isPast(dateStr) {
  if (!dateStr || !DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return new Date(Date.UTC(y, m - 1, d)) < today;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p.startsWith("/api/")) {
        // public endpoints
        if (p === "/api/events" && request.method === "GET") return publicEvents(env);
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
