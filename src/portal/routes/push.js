// Owned by B2e (amendment 5 build cut, B1-fix amendment 6). The push
// routes from docs/portal/api.md §8, plus one addition of our own
// (`vapid-public-key`, changelog line at the bottom of api.md) that the
// client needs before it can call `subscribe` at all.

import { json, notConfigured } from "../http.js";
import { isPushConfigured, subscribeToPush, unsubscribeFromPush } from "../push.js";

async function handleVapidPublicKey(ctx) {
  if (!isPushConfigured(ctx.env)) return notConfigured("push");
  return json({ public_key: ctx.env.VAPID_PUBLIC_KEY });
}

async function handleSubscribe(ctx) {
  if (!isPushConfigured(ctx.env)) return notConfigured("push");
  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const keys = body.keys || {};
  if (!endpoint || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return json({ error: "invalid_request" }, 400);
  }
  await subscribeToPush(ctx.db, ctx.account.id, { endpoint, keys });
  return json({ ok: true });
}

async function handleUnsubscribe(ctx) {
  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return json({ error: "invalid_request" }, 400);
  await unsubscribeFromPush(ctx.db, ctx.account.id, endpoint);
  return json({ ok: true });
}

export const ROUTES = [
  { method: "GET", path: "/api/portal/push/vapid-public-key", class: "own", handler: handleVapidPublicKey },
  { method: "POST", path: "/api/portal/push/subscribe", class: "own", handler: handleSubscribe },
  { method: "POST", path: "/api/portal/push/unsubscribe", class: "own", handler: handleUnsubscribe },
];
