// Owned by B2b. Routes from docs/portal/api.md §5 (billing checkout,
// portal-session, history, offering price) -- this file alone, never
// src/portal/router.js, which only imports and concatenates this array.
// (POST /api/stripe/webhook is dispatched separately, outside this
// table -- see router.js and src/portal/stripe.js.)

import { json, notConfigured } from "../http.js";
import {
  isStripeConfigured,
  createBillingCheckoutSession,
  createCustomerPortalSession,
  getBillingHistory,
  editOfferingPrice,
  MEMBERSHIP_AND_PACK_LOOKUP_KEYS,
} from "../stripe.js";

// Every thrown error from stripe.js carries a `code`; this is the one
// place that maps each known code to the response api.md §5 promises
// (CTL-STR-03/07 "a message in the user's words", never a raw 500).
function stripeErrorResponse(err) {
  if (err && err.code === "not_configured") return notConfigured("stripe");
  if (err && err.code === "unknown_item") return json({ error: "unknown_item" }, 400);
  if (err && err.code === "no_customer") return json({ error: "no_billing_account" }, 409);
  if (err && err.code === "billing_portal_unavailable") return json({ error: "billing_portal_unavailable" }, 503);
  // eslint-disable-next-line no-console
  console.log(`stripe_route_error code=${(err && err.code) || "unknown"}`);
  return json({ error: "stripe_error" }, 502);
}

async function billingCheckout(ctx) {
  if (!isStripeConfigured(ctx.env)) return notConfigured("stripe");
  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const lookupKey = body && body.lookup_key;
  if (!MEMBERSHIP_AND_PACK_LOOKUP_KEYS.has(lookupKey)) return json({ error: "unknown_item" }, 400);
  try {
    const { url } = await createBillingCheckoutSession(ctx.env, ctx.account, lookupKey, ctx.url);
    return json({ url });
  } catch (err) {
    return stripeErrorResponse(err);
  }
}

async function billingPortalSession(ctx) {
  if (!isStripeConfigured(ctx.env)) return notConfigured("stripe");
  try {
    const { url } = await createCustomerPortalSession(ctx.env, ctx.account, ctx.url);
    return json({ url });
  } catch (err) {
    return stripeErrorResponse(err);
  }
}

async function billingHistory(ctx) {
  if (!isStripeConfigured(ctx.env)) return notConfigured("stripe");
  try {
    const items = await getBillingHistory(ctx.env, ctx.account);
    return json(items);
  } catch (err) {
    return stripeErrorResponse(err);
  }
}

async function offeringPrice(ctx) {
  if (!isStripeConfigured(ctx.env)) return notConfigured("stripe");
  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const priceCents = Number(body && body.price_cents);
  if (!Number.isInteger(priceCents) || priceCents <= 0) return json({ error: "invalid_request" }, 400);
  try {
    const offering = await editOfferingPrice(ctx.env, ctx.params.offeringId, priceCents);
    if (!offering) return json({ error: "not_found" }, 404);
    return json({ offering });
  } catch (err) {
    return stripeErrorResponse(err);
  }
}

export const ROUTES = [
  { method: "POST", path: "/api/portal/billing/checkout", class: "own", handler: billingCheckout },
  { method: "POST", path: "/api/portal/billing/portal-session", class: "own", handler: billingPortalSession },
  { method: "GET", path: "/api/portal/billing/history", class: "own", handler: billingHistory },
  { method: "POST", path: "/api/portal/owner/resources/:id/offerings/:offeringId/price", class: "owner", handler: offeringPrice },
];
