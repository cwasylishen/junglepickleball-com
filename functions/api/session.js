import { json, getCookie, verifySession, SESSION_COOKIE } from "../_shared.js";

export async function onRequestGet({ request, env }) {
  if (!env.SESSION_SECRET) return json({ authed: false });
  const token = getCookie(request, SESSION_COOKIE);
  const session = await verifySession(token, env.SESSION_SECRET);
  return json({ authed: !!session });
}
