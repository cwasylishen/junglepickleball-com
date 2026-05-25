import { json, signSession, verifyTurnstile, timingSafeEqual, sessionCookie, SESSION_TTL_MS } from "../_shared.js";

const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 900; // 15 minutes

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET || !env.TURNSTILE_SECRET_KEY) {
    return json({ error: "Server is not configured. Missing admin secrets." }, 500);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:${ip}`;
  const attempts = parseInt((await env.EVENTS.get(rlKey)) || "0", 10);
  if (attempts >= MAX_ATTEMPTS) {
    return json({ error: "Too many attempts. Please wait a few minutes and try again." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const { username, password, turnstileToken } = body || {};

  const turnstileOk = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
  if (!turnstileOk) {
    return json({ error: "Bot check failed. Please try again." }, 403);
  }

  const userOk = timingSafeEqual(String(username || ""), env.ADMIN_USERNAME);
  const passOk = timingSafeEqual(String(password || ""), env.ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    await env.EVENTS.put(rlKey, String(attempts + 1), { expirationTtl: WINDOW_SECONDS });
    return json({ error: "Incorrect username or password." }, 401);
  }

  await env.EVENTS.delete(rlKey);
  const token = await signSession({ u: env.ADMIN_USERNAME, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}
