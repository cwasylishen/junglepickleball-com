// Stripe integration: Checkout (membership/pack via the new route,
// per-booking via createBookingCheckout), the Customer Portal, purchase
// history, owner price edits, and the webhook (B2b, amendment 6,
// api.md §5). Hand-rolled signature verification (research.md Q3) --
// no stripe-node dependency, so this adds nothing to package.json.
//
// Database doctrine: this file is the one writer of (a) stripe-source
// entitlement_grants rows, (b) the payments_mirror row for a
// Stripe-paid item, and (c) the webhook_events idempotency row. It
// never writes a booking, a credits balance or a non-Stripe grant --
// those go through B2a1's confirmPaidBooking/releaseHold/addCredits,
// which are each already the one function for their own activity
// (CTL-CRD-01 etc). It also owns offerings.display_price_cents, but
// only through editOfferingPrice below: Amendment 4 decision 7 makes a
// Stripe price edit the only path a price ever changes on, so B2a2's
// offering CRUD (when it lands) must never touch this one column.

import { json, notConfigured } from "./http.js";
import { newId, nowIso, runBatch } from "./db.js";
import { auditStatement } from "./audit.js";
import { confirmPaidBooking, releaseHold, addCredits } from "./booking.js";

const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 300; // Q3: Stripe's own default tolerance

// The 7 membership tiers + the 8-pack: the only lookup_keys
// POST /api/portal/billing/checkout accepts (amendment 6). Per-booking
// items (massage/plunge/court) are never requested through this route --
// those come from the stored booking row via createBookingCheckout,
// never a client-supplied lookup_key (CTL-STR-01).
export const MEMBERSHIP_AND_PACK_LOOKUP_KEYS = new Set([
  "jp_1m_single",
  "jp_3m_single",
  "jp_3m_couples",
  "jp_6m_single",
  "jp_6m_couples",
  "jp_annual_single",
  "jp_annual_couples",
  "jp_session_pack8",
]);

// A1: the webhook gates separately on STRIPE_WEBHOOK_SECRET; this is
// the "can we create a checkout / show billing UI" check every other
// Stripe-calling path uses (S-11).
export function isStripeConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

// ---------- pure request builder (no network -- testable with no server) ----------

// Builds the exact body for POST /v1/checkout/sessions. Pure: the same
// inputs always produce the same object (no Date.now(), no randomness),
// so a test can assert on it directly. `lineItems` carry the resolved
// Stripe `price` id (never price_data, Amendment 4) plus the
// `lookup_key` it came from, which travels into `metadata.lookup_keys`
// purely as an audit trail of which catalog item(s) were charged.
export function buildCheckoutParams({ mode, customerId, clientReferenceId, bookingId, lineItems, successUrl, cancelUrl, expiresAt }) {
  if (!customerId) throw new Error("buildCheckoutParams: customerId is required (R-4, customer create-first)");
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw new Error("buildCheckoutParams: lineItems must be non-empty");
  return {
    mode,
    customer: customerId,
    client_reference_id: clientReferenceId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: lineItems.map((li) => ({ price: li.price, quantity: li.quantity })),
    metadata: {
      booking_id: bookingId || "",
      lookup_keys: lineItems.map((li) => li.lookup_key).filter(Boolean).join(","),
    },
    expires_at: expiresAt,
  };
}

// ---------- Stripe HTTP (only ever reached when isStripeConfigured) ----------

// Same bracket-nested form encoding scripts/stripe-setup.mjs and the
// legacy src/worker.js checkout already use for Stripe's API.
function stripeForm(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
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

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? stripeForm(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || `Stripe error ${res.status}`);
  return data;
}

async function findPriceByLookupKey(env, lookupKey) {
  const data = await stripeRequest(env, "GET", `/prices?limit=1&active=true&lookup_keys[]=${encodeURIComponent(lookupKey)}`);
  return (data.data && data.data[0]) || null;
}

// R-4: a Stripe customer is created, and saved to the account, before
// any Checkout/Portal call ever runs for that account.
async function ensureCustomer(env, account) {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await stripeRequest(env, "POST", "/customers", { email: account.email, metadata: { account_id: account.id } });
  await env.PORTAL_DB.prepare(`UPDATE accounts SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`)
    .bind(customer.id, nowIso(), account.id)
    .run();
  return customer.id;
}

// A generic hourly counter, same shape as auth.js's recordEmailSendFailure,
// for the owner-health signals CTL-STR-06/07 require (checkout_failed by
// reason, billing_portal_error). B2a2's owner.js (not yet built) is the
// eventual reader; this is the one writer.
async function bumpCounter(env, key) {
  const bucket = `${key}:${nowIso().slice(0, 13)}`;
  await env.PORTAL_DB.prepare(
    `INSERT INTO portal_meta_counters (key, value, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`
  )
    .bind(bucket, nowIso())
    .run();
}

// ---------- per-booking checkout (B2a1 calls this) ----------

// Throws `{ code: "not_configured" }`, `{ code: "price_mismatch" }` or
// `{ code: "checkout_failed", reason }`. Per CTL-STR-02/06, the caller
// (B2a1's booking.js) is the one holding the hold row, so on any of
// these it is the caller's job to delete the hold and return the
// matching status (409 price_mismatch / 503 checkout_failed) -- this
// function cannot do that itself without a booking-table write, which
// would duplicate booking.js's own CRUD (database doctrine).
export async function createBookingCheckout(env, { account, bookingId, lineItems, expiresAt, successUrl, cancelUrl }) {
  if (!isStripeConfigured(env)) throw { code: "not_configured" };

  const resolvedLineItems = [];
  for (const li of lineItems) {
    const price = await findPriceByLookupKey(env, li.lookup_key);
    if (!price) {
      await bumpCounter(env, "checkout_failed:unknown_item");
      throw { code: "checkout_failed", reason: "unknown_item" };
    }
    // CTL-STR-02: never a charge the portal did not show. The caller
    // may pass `expected_unit_cents` (the offering's display mirror);
    // when it does, a live-price/mirror mismatch refuses the Checkout.
    if (li.expected_unit_cents != null && price.unit_amount !== li.expected_unit_cents) {
      throw { code: "price_mismatch" };
    }
    resolvedLineItems.push({ price: price.id, quantity: li.quantity, lookup_key: li.lookup_key });
  }

  const customerId = await ensureCustomer(env, account);
  const params = buildCheckoutParams({
    mode: "payment",
    customerId,
    clientReferenceId: account.id,
    bookingId,
    lineItems: resolvedLineItems,
    successUrl,
    cancelUrl,
    expiresAt,
  });
  params.metadata.kind = "booking";

  let session;
  try {
    session = await stripeRequest(env, "POST", "/checkout/sessions", params);
  } catch {
    await bumpCounter(env, "checkout_failed:stripe_error");
    throw { code: "checkout_failed", reason: "stripe_error" };
  }
  return { url: session.url, sessionId: session.id };
}

// ---------- membership/pack checkout (new route, amendment 6) ----------

export async function createBillingCheckoutSession(env, account, lookupKey, originUrl) {
  const price = await findPriceByLookupKey(env, lookupKey);
  if (!price) throw { code: "unknown_item" };
  const customerId = await ensureCustomer(env, account);
  const mode = price.recurring ? "subscription" : "payment";
  const kind = lookupKey === "jp_session_pack8" ? "pack" : "membership";
  const params = buildCheckoutParams({
    mode,
    customerId,
    clientReferenceId: account.id,
    bookingId: null,
    lineItems: [{ price: price.id, quantity: 1, lookup_key: lookupKey }],
    successUrl: `${originUrl.origin}/portal/#billing=success`,
    cancelUrl: `${originUrl.origin}/portal/#billing=cancelled`,
    // Checkout Sessions in subscription mode do not accept expires_at;
    // amendment 5 F-4's 31-minute hold is a per-booking concept only.
    expiresAt: mode === "payment" ? Math.floor(Date.now() / 1000) + 31 * 60 : undefined,
  });
  params.metadata.kind = kind;
  const session = await stripeRequest(env, "POST", "/checkout/sessions", params);
  return { url: session.url, sessionId: session.id };
}

// ---------- Customer Portal (own customer only, CTL-STR-03) ----------

export async function createCustomerPortalSession(env, account, originUrl) {
  if (!account.stripe_customer_id) throw { code: "no_customer" };
  try {
    const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
      customer: account.stripe_customer_id,
      return_url: `${originUrl.origin}/portal/`,
    });
    return { url: session.url };
  } catch {
    // CTL-STR-07: a missing Customer Portal configuration (or any other
    // Stripe error here) is detected and flagged, never a 500/blank page.
    await bumpCounter(env, "billing_portal_error");
    throw { code: "billing_portal_unavailable" };
  }
}

// ---------- history (own customer only, CTL-STR-03) ----------

export async function getBillingHistory(env, account) {
  if (!account.stripe_customer_id) return [];
  const data = await stripeRequest(env, "GET", `/charges?customer=${encodeURIComponent(account.stripe_customer_id)}&limit=25`);
  return (data.data || []).map((c) => ({
    amount_cents: c.amount,
    kind: c.description || "charge",
    status: c.refunded ? "refunded" : c.status,
    created_at: new Date(c.created * 1000).toISOString(),
  }));
}

// ---------- owner price edit (amendment 4 decision 7) ----------

export async function editOfferingPrice(env, offeringId, priceCents) {
  const db = env.PORTAL_DB;
  const offering = await db.prepare(`SELECT * FROM offerings WHERE id = ?`).bind(offeringId).first();
  if (!offering || !offering.lookup_key) return null;
  const existingPrice = await findPriceByLookupKey(env, offering.lookup_key);
  if (!existingPrice) throw { code: "unknown_item" };
  const productId = typeof existingPrice.product === "string" ? existingPrice.product : existingPrice.product.id;
  // Decision 7: a NEW Price with the SAME lookup_key + transfer_lookup_key,
  // never an edit of the existing Price object (Stripe Prices are immutable).
  await stripeRequest(env, "POST", "/prices", {
    product: productId,
    currency: "usd",
    unit_amount: priceCents,
    lookup_key: offering.lookup_key,
    transfer_lookup_key: true,
  });
  await db.prepare(`UPDATE offerings SET display_price_cents = ?, updated_at = ? WHERE id = ?`).bind(priceCents, nowIso(), offeringId).run();
  return db.prepare(`SELECT * FROM offerings WHERE id = ?`).bind(offeringId).first();
}

// ---------- webhook ----------

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Equal-length XOR loop: no early return on the first differing byte, so
// the comparison takes the same time whether the first byte or the last
// byte differs (Q3's "compare in constant time").
function constantTimeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// "t=167...,v1=abc...,v1=def..." -- Stripe sends one v1 normally, but can
// send more than one during secret rotation, so every v1 is checked
// (Q3). v0 and any other scheme are ignored (downgrade protection).
function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || "").split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") out.t = v;
    else if (k === "v1") out.v1.push(v);
  }
  return out;
}

// Exported so a probe can exercise verification directly against a
// constructed header without a running server, if ever needed -- the
// webhook tests in this build instead go through the real HTTP route
// (PIN-16: black-box), which is what proves the route actually calls this.
export async function verifyStripeSignature(secret, rawBody, header, nowSeconds = Math.floor(Date.now() / 1000)) {
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || v1.length === 0) return { ok: false, reason: "malformed" };
  const tNum = Number(t);
  if (!Number.isFinite(tNum)) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - tNum) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  const matched = v1.some((sig) => constantTimeEqualHex(expected, sig));
  if (!matched) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

function emailHint(email) {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1) return null;
  return `${email[0]}***@${email.slice(at + 1)}`;
}

// Reads-only: decides which account a Checkout session belongs to
// without writing anything, so the caller can fold the CREATE statement
// (if any) into the SAME batch as the payment/grant effect it is for.
// CTL-STR-05: an account is matched by `stripe_customer_id` first; only
// when that is absent does it fall back to `customer_details.email`
// (A7/S-10, "linked by lower(email), flagged linked_by_email"). In
// `preview`, the email fallback runs only for `@jp-demo.test` addresses.
async function resolveAccountForSession(session, env, db) {
  if (session.customer) {
    const byCustomer = await db.prepare(`SELECT id FROM accounts WHERE stripe_customer_id = ?`).bind(session.customer).first();
    if (byCustomer) return { accountId: byCustomer.id, isNewAccount: false, linkedByEmail: false, email: null };
  }
  const email = normalizeEmail(session.customer_details && session.customer_details.email);
  if (!email || email.indexOf("@") < 1) return { accountId: null, isNewAccount: false, linkedByEmail: false, email: null };
  if (env.envClass === "preview" && !email.endsWith("@jp-demo.test")) return { accountId: null, isNewAccount: false, linkedByEmail: false, email };
  const existing = await db.prepare(`SELECT id FROM accounts WHERE email = ?`).bind(email).first();
  if (existing) return { accountId: existing.id, isNewAccount: false, linkedByEmail: true, email };
  return { accountId: newId(), isNewAccount: true, linkedByEmail: true, email };
}

function unlinkedPurchaseAuditStatement(db, session) {
  return auditStatement(db, {
    actor: null,
    action: "stripe_unlinked_purchase",
    targetType: "stripe_checkout_session",
    targetId: session.id,
    after: {
      amount_cents: session.amount_total || 0,
      currency: session.currency || "usd",
      email_hint: emailHint(session.customer_details && session.customer_details.email),
    },
  });
}

async function handleCheckoutCompleted(session, env, db) {
  const kind = (session.metadata && session.metadata.kind) || "unknown";
  const bookingId = (session.metadata && session.metadata.booking_id) || null;
  const statements = [];

  if (kind === "booking" && bookingId) {
    // B2a1's own atomic function (confirmed/paid_conflict/already_confirmed,
    // CTL-STR-08). Its write is already one transaction on its own; calling
    // it before our batch means a crash before our batch commits just makes
    // the (idempotent) webhook retry call it again, never lose it.
    await confirmPaidBooking(env, bookingId, { paymentIntentId: session.payment_intent, sessionId: session.id });
  }

  const resolved = await resolveAccountForSession(session, env, db);

  if (resolved.isNewAccount) {
    // CTL-STR-05/AUTH-23: a webhook-created account is always role 'guest'.
    statements.push(
      db
        .prepare(`INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES (?,?,?,'',0,?,?)`)
        .bind(resolved.accountId, resolved.email, "guest", nowIso(), nowIso())
    );
  }

  if (resolved.accountId) {
    if (kind === "pack") {
      // B2a1's single credit function (CTL-CRD-01), idempotent on `ref`.
      await addCredits(env, resolved.accountId, 8, { source: "pack", ref: session.id });
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO payments_mirror (id, account_id, booking_id, stripe_payment_intent_id, stripe_checkout_session_id, amount_cents, currency, status, kind, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'paid',?,?,?)`
        )
        .bind(newId(), resolved.accountId, bookingId, session.payment_intent || null, session.id, session.amount_total || 0, session.currency || "usd", kind, nowIso(), nowIso())
    );
    if (resolved.linkedByEmail) {
      statements.push(
        auditStatement(db, { actor: null, action: "stripe_linked_by_email", targetType: "account", targetId: resolved.accountId, after: { checkout_session_id: session.id } })
      );
    }
  } else {
    // FMEA #4: an unlinkable payment is recorded for the owner, never
    // dropped, even with no account to attach it to.
    statements.push(unlinkedPurchaseAuditStatement(db, session));
  }

  return statements;
}

async function handleCheckoutExpired(session, env /* , db unused */) {
  const bookingId = session.metadata && session.metadata.booking_id;
  if (bookingId) await releaseHold(env, bookingId, "checkout_session_expired");
  return [];
}

function tierFamily(tier) {
  return tier ? tier.replace(/_(single|couples)$/, "") : null;
}

// CTL-STR-09: a single<->couples switch is the SAME family, different
// tier -- a plan change within the family (e.g. 1m -> 3m single) is not.
function isSingleCouplesSwitch(oldTier, newTier) {
  if (!oldTier || !newTier || oldTier === newTier) return false;
  return tierFamily(oldTier) === tierFamily(newTier);
}

async function handleSubscriptionUpsert(subscription, env, db) {
  const account = await db.prepare(`SELECT id FROM accounts WHERE stripe_customer_id = ?`).bind(subscription.customer).first();
  if (!account) return []; // nothing to grant against yet; the raw event is still recorded in webhook_events
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const tier = item && item.price && item.price.lookup_key;
  if (!tier) return [];
  const status = subscription.status;
  const statements = [];

  const existing = await db
    .prepare(`SELECT * FROM entitlement_grants WHERE account_id = ? AND source = 'stripe' AND stripe_subscription_id = ?`)
    .bind(account.id, subscription.id)
    .first();

  if (existing) {
    statements.push(db.prepare(`UPDATE entitlement_grants SET tier = ?, stripe_status = ?, updated_at = ? WHERE id = ?`).bind(tier, status, nowIso(), existing.id));
    if (isSingleCouplesSwitch(existing.tier, tier)) {
      statements.push(
        db.prepare(`UPDATE households SET status = 'needs_review', updated_at = ? WHERE payer_account_id = ? AND status = 'active'`).bind(nowIso(), account.id)
      );
    }
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO entitlement_grants (id, account_id, source, tier, stripe_subscription_id, stripe_status, starts_at, status, created_at, updated_at)
           VALUES (?,?,'stripe',?,?,?,?,'active',?,?)`
        )
        .bind(newId(), account.id, tier, subscription.id, status, nowIso(), nowIso(), nowIso())
    );
  }
  return statements;
}

async function handleSubscriptionDeleted(subscription, env, db) {
  const existing = await db
    .prepare(`SELECT id FROM entitlement_grants WHERE source = 'stripe' AND stripe_subscription_id = ? AND status = 'active'`)
    .bind(subscription.id)
    .first();
  if (!existing) return [];
  return [db.prepare(`UPDATE entitlement_grants SET status = 'ended', ends_at = ?, stripe_status = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), subscription.status || "canceled", nowIso(), existing.id)];
}

async function handleChargeRefunded(charge, env, db) {
  const pi = charge.payment_intent;
  if (!pi) return [];
  const row = await db.prepare(`SELECT id FROM payments_mirror WHERE stripe_payment_intent_id = ?`).bind(pi).first();
  if (!row) {
    return [auditStatement(db, { actor: null, action: "stripe_unlinked_refund", targetType: "stripe_charge", targetId: charge.id, after: { amount_cents: charge.amount_refunded || charge.amount || 0 } })];
  }
  return [db.prepare(`UPDATE payments_mirror SET status = 'refunded', updated_at = ? WHERE id = ?`).bind(nowIso(), row.id)];
}

async function handleDisputeCreated(dispute, env, db) {
  // payments_mirror.status has no "disputed" value (schema holds pending |
  // paid | refunded | failed) and this part does not own a migration to
  // add one -- recorded in the audit log instead so the owner sees it,
  // per FMEA #4's "never dropped", without a schema change outside scope.
  return [auditStatement(db, { actor: null, action: "stripe_dispute_created", targetType: "stripe_charge", targetId: dispute.charge || dispute.id, after: { amount_cents: dispute.amount || 0 } })];
}

async function computeEffectStatements(event, env, db) {
  const obj = event.data && event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(obj, env, db);
    case "checkout.session.expired":
      return handleCheckoutExpired(obj, env);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionUpsert(obj, env, db);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(obj, env, db);
    case "charge.refunded":
      return handleChargeRefunded(obj, env, db);
    case "charge.dispute.created":
      return handleDisputeCreated(obj, env, db);
    default:
      return []; // an event type this build does not act on: processed as a no-op, never an error
  }
}

// Replaces B1's stub. Signature matches the real call site in
// src/portal/router.js: `handleStripeWebhook(request, penv, db)`.
export async function handleStripeWebhook(request, env, db) {
  if (!env.STRIPE_WEBHOOK_SECRET) return notConfigured("stripe"); // A1

  const rawBody = await request.text(); // verified BEFORE any parsing
  const sigHeader = request.headers.get("Stripe-Signature");
  const verified = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, rawBody, sigHeader);
  if (!verified.ok) {
    // CTL-STR-04: never the body, never an email -- only the outcome.
    // eslint-disable-next-line no-console
    console.log(`stripe_webhook_rejected reason=${verified.reason}`);
    return json({ error: "bad_signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_signature" }, 400);
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") {
    return json({ error: "bad_signature" }, 400);
  }

  // Idempotent on event.id (PIN-11): a replay of an already-processed
  // event writes nothing new.
  const existing = await db.prepare(`SELECT status FROM webhook_events WHERE id = ?`).bind(event.id).first();
  if (existing && existing.status === "processed") {
    return json({ received: true });
  }

  const effectStatements = await computeEffectStatements(event, env, db);

  // FMEA top-3: the event is marked processed only in the SAME batch as
  // the effect rows this file writes directly (payments_mirror,
  // entitlement_grants, the audit trail). Effects delegated to B2a1's own
  // atomic functions (confirmPaidBooking/releaseHold/addCredits, called
  // inside computeEffectStatements above) are already one transaction on
  // their own and are each idempotent, so a crash between that call and
  // this batch committing is safe: the retried delivery simply calls them
  // again rather than losing the event.
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO webhook_events (id, type, received_at, processed_at, status) VALUES (?,?,?,?, 'processed')
         ON CONFLICT(id) DO UPDATE SET processed_at = excluded.processed_at, status = 'processed'`
      )
      .bind(event.id, event.type, nowIso(), nowIso()),
    ...effectStatements,
  ]);

  // eslint-disable-next-line no-console
  console.log(`stripe_webhook_processed id=${event.id} type=${event.type}`);
  return json({ received: true });
}
