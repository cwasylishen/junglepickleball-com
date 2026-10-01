#!/usr/bin/env node
// One-time setup: creates the 9 Jungle Pickleball membership/pass products
// and prices in Stripe, found afterward by lookup_key (never by ID) from
// src/worker.js's /api/checkout handler. Safe to re-run: each item is
// looked up by lookup_key first and skipped if it already exists, so a
// second run creates no duplicates.
//
// DO NOT RUN until STRIPE_SECRET_KEY is set for Roger's own Stripe account
// — this writes real products/prices to whatever account the key belongs to.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_live_or_restricted_... node scripts/stripe-setup.mjs
//
// Required key permissions (restricted key): Products — Write, Prices — Write.
// (Read access to both is implied by Write in Stripe's restricted-key model,
// and is also needed here to check for an existing lookup_key before creating.)

const STRIPE_API = "https://api.stripe.com/v1";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set. Refusing to run.");
  process.exit(1);
}

// Same bracket-nested form encoding Stripe's API expects everywhere else
// in this project (src/worker.js has the same helper for the checkout call).
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

async function stripeRequest(method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? stripeForm(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${(data.error && data.error.message) || res.status}`);
  }
  return data;
}

// Rates from Roger's posted sign (files/inbox/wa-cloud/wa-event-2026-10-01T01-18-42-209Z_image.jpg).
const ITEMS = [
  { lookupKey: "jp_1m_single", productName: "Jungle Pickleball — 1 Month (Per Person)", unitAmount: 7500, recurring: { interval: "month", interval_count: 1 } },
  { lookupKey: "jp_3m_single", productName: "Jungle Pickleball — 3 Month (Per Person)", unitAmount: 20000, recurring: { interval: "month", interval_count: 3 } },
  { lookupKey: "jp_3m_couples", productName: "Jungle Pickleball — 3 Month Couples", unitAmount: 37500, recurring: { interval: "month", interval_count: 3 } },
  { lookupKey: "jp_6m_single", productName: "Jungle Pickleball — 6 Month Single", unitAmount: 40000, recurring: { interval: "month", interval_count: 6 } },
  { lookupKey: "jp_6m_couples", productName: "Jungle Pickleball — 6 Month Couples", unitAmount: 65000, recurring: { interval: "month", interval_count: 6 } },
  { lookupKey: "jp_annual_single", productName: "Jungle Pickleball — Annual Single", unitAmount: 75000, recurring: { interval: "year", interval_count: 1 } },
  { lookupKey: "jp_annual_couples", productName: "Jungle Pickleball — Annual Couples", unitAmount: 97500, recurring: { interval: "year", interval_count: 1 } },
  { lookupKey: "jp_session_single", productName: "Jungle Pickleball — Pay to Play (90 min session)", unitAmount: 1500, recurring: null },
  { lookupKey: "jp_session_pack8", productName: "Jungle Pickleball — 8-Play Prepaid Pack", unitAmount: 10000, recurring: null },
];

async function findPriceByLookupKey(lookupKey) {
  const data = await stripeRequest("GET", `/prices?limit=1&lookup_keys[]=${encodeURIComponent(lookupKey)}`);
  return (data.data && data.data[0]) || null;
}

async function createProduct(name) {
  const data = await stripeRequest("POST", "/products", { name });
  return data.id;
}

async function createPrice(productId, item) {
  const body = {
    product: productId,
    currency: "usd",
    unit_amount: item.unitAmount,
    lookup_key: item.lookupKey,
  };
  if (item.recurring) body.recurring = item.recurring;
  return stripeRequest("POST", "/prices", body);
}

async function main() {
  for (const item of ITEMS) {
    const existing = await findPriceByLookupKey(item.lookupKey);
    if (existing) {
      console.log(`SKIP  ${item.lookupKey} — price ${existing.id} already exists`);
      continue;
    }
    const productId = await createProduct(item.productName);
    const price = await createPrice(productId, item);
    console.log(`CREATE ${item.lookupKey} — product ${productId}, price ${price.id}`);
  }
  console.log("Done. Re-running this script will create nothing new.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
