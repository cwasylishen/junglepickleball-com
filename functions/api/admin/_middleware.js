import { json, getCookie, verifySession, SESSION_COOKIE } from "../../_shared.js";

// Guards every /api/admin/* route.
export async function onRequest({ request, env, next }) {
  if (!env.SESSION_SECRET) return json({ error: "Server is not configured." }, 500);
  const token = getCookie(request, SESSION_COOKIE);
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "Not authenticated." }, 401);
  return next();
}
