// Shared helpers for Jungle Pickleball admin Functions.
// Underscore-prefixed files are not routed by Pages, so this is import-only.

export const SESSION_COOKIE = "jp_admin";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

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
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage
  );
}

// Create a signed session token: base64url(payload).hexHmac
export async function signSession(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toHex(sig)}`;
}

// Verify a session token; returns the payload object or null.
export async function verifySession(token, secret) {
  if (!token || token.indexOf(".") === -1) return null;
  const [body, sigHex] = token.split(".");
  const key = await hmacKey(secret, ["verify"]);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    fromHex(sigHex),
    new TextEncoder().encode(body)
  );
  if (!ok) return null;
  try {
    const data = JSON.parse(b64urlDecode(body));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
export function clearCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

const EVENTS_KEY = "events";

export async function getEvents(env) {
  const raw = await env.EVENTS.get(EVENTS_KEY);
  if (!raw) return null; // null = uninitialized, [] = intentionally empty
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function putEvents(env, events) {
  await env.EVENTS.put(EVENTS_KEY, JSON.stringify(events));
}

export function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Coerce arbitrary input into a clean event record.
export function normalizeEvent(input, existing = {}) {
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
    featured: Boolean(input.featured ?? existing.featured ?? false),
    ctaLabel: String(input.ctaLabel ?? existing.ctaLabel ?? "").trim().slice(0, 60),
    ctaUrl: String(input.ctaUrl ?? existing.ctaUrl ?? "").trim().slice(0, 500),
    images: Array.isArray(input.images)
      ? input.images.filter((x) => typeof x === "string" && x.trim()).slice(0, 8)
      : existing.images || [],
    order: Number.isFinite(+input.order) ? +input.order : existing.order ?? 100,
    updatedAt: new Date().toISOString(),
  };
}

// The starting set, used to seed KV the first time the admin loads.
export const DEFAULT_EVENTS = [
  { id: "open-play", title: "Open Play", when: "Tuesdays & Thursdays", time: "10:00 AM Start", description: "Our most popular session. All skill levels welcome, so just rotate in and enjoy the game.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 10, status: "active" },
  { id: "womens-open", title: "Women's Open", when: "Fridays", time: "8:30 AM Start", description: "A supportive and competitive session dedicated to our women players.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 20, status: "active" },
  { id: "sunday-swish", title: "The Sunday Swish", when: "Sunday Mornings", time: "8:30 AM Start", description: "Our top social mixer. A rotating-partners format with nine games guaranteed.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 30, status: "active" },
  { id: "alternating-opens", title: "Alternating Opens", when: "Mon, Wed, Sat", time: "Check Availability", description: "Flex days with times that vary by demand. Text Roger on WhatsApp to confirm open slots.", category: "weekly", featured: false, ctaLabel: "", ctaUrl: "", order: 40, status: "active" },
  { id: "rihana-rally-cup", title: "Rihana's Rally Cup", when: "Sunday, May 31, 2026", time: "Practice 8:00 AM | Start 9:00 AM", description: "A Mix and Match Madness fundraiser for Rihana Mora, Ojochal's own and Costa Rica's fastest 17-year-old, on her birthday. Random pairings every round (kids and adults mixed), individual points, and mini games between matches. Adults $25, kids under 16 $15, family $30. Partial proceeds fund Rihana's training and travel. Spaces are limited. Tap the flyer for full details.", category: "special", featured: true, ctaLabel: "RESERVE YOUR SPOT", ctaUrl: "https://wa.me/50689893111?text=I%20want%20to%20register%20for%20the%20Rihana%20Rally%20Cup", order: 5, status: "active", images: ["assets/events/rihana-rally-cup.jpg", "assets/events/rihana-rally-cup-details.jpg"] },
];
