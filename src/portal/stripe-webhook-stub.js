// Stub for POST /api/stripe/webhook (PIN-4/F-8: B1 wires the dispatch,
// B2b implements the real handler). Mirrors the pattern B1 uses for
// src/portal/cron.js: a working, honest placeholder B2b then owns and
// replaces outright with signature verification (STRIPE_WEBHOOK_SECRET,
// PIN-11) and the event handling in its own src/portal/stripe.js.
//
// Until B2b lands, this returns the same "not configured" shape every
// other Stripe path returns (PIN-11), so the dispatch is never silently
// wrong even though nothing is implemented behind it yet.

import { notConfigured } from "./http.js";

export async function handleStripeWebhook(request, env, db) {
  if (!env.STRIPE_WEBHOOK_SECRET) return notConfigured("stripe");
  return new Response(JSON.stringify({ error: "not_implemented", note: "B2b implements webhook verification and handling" }), {
    status: 501,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
