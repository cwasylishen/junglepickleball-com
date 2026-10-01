// Interface stubs for B2b (amendment 6). B1 commits this module with
// the exact export signatures below as working, non-throwing stubs so
// every other part's import resolves and `npm test` stays green while
// B2b writes the real bodies. From here on this file belongs to B2b --
// it replaces each stub outright, including `handleStripeWebhook`,
// which src/portal/router.js already dispatches
// `POST /api/stripe/webhook` to (docs/portal/api.md §5).

// A1: the webhook gates separately on STRIPE_WEBHOOK_SECRET; this is
// the "can we create a checkout / show billing UI" check.
export function isStripeConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

// Stub: always throws the documented not_configured shape until B2b
// implements the real Stripe Checkout Session call (R-4 customer
// create-first, client_reference_id = account.id, metadata.booking_id,
// amendment 5 F-4's 31-minute expiresAt). A fabricated {url, sessionId}
// would be worse than this -- callers already check isStripeConfigured
// first (S-11), so this only fires on the path B2b has not built yet.
export async function createBookingCheckout(env, { account, bookingId, lineItems, expiresAt, successUrl, cancelUrl }) {
  throw { code: "not_configured" };
}

// Mirrors the "not configured" shape every other Stripe path returns
// (PIN-11) until B2b lands signature verification and event handling.
export async function handleStripeWebhook(request, env, ctx) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "not_configured", feature: "stripe" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ error: "not_implemented", note: "B2b implements webhook verification and handling" }), {
    status: 501,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
