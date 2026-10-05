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

import { json, notConfigured, logAndMask } from "./http.js";
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

// A booking's owning account is the booking row's own `account_id` --
// read-only, no Stripe customer/email heuristic needed or wanted, since
// confirmPaidBooking has already confirmed this exact booking against
// this exact session. Same `{accountId, isNewAccount, linkedByEmail}`
// shape as resolveAccountForSession so handleCheckoutCompleted's
// downstream code (the payments_mirror write, the linked-by-email
// audit) does not need to branch on which path it came from.
async function resolveAccountForBooking(db, bookingId) {
  const booking = await db.prepare(`SELECT account_id FROM bookings WHERE id = ?`).bind(bookingId).first();
  return booking ? { accountId: booking.account_id, isNewAccount: false, linkedByEmail: false } : { accountId: null, isNewAccount: false, linkedByEmail: false };
}

// Reads-only: decides which account a Checkout session belongs to
// without writing anything, so the caller can fold the CREATE statement
// (if any) into the SAME batch as the payment/grant effect it is for.
// CTL-STR-05: an account is matched by `stripe_customer_id` first; only
// when that is absent does it fall back to `customer_details.email`
// (A7/S-10, "linked by lower(email), flagged linked_by_email"). In
// `preview`, the email fallback runs only for `@jp-demo.test` addresses.
// Used only for membership/pack checkouts -- a booking checkout resolves
// its account via resolveAccountForBooking above instead.
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

// M13/A7/PIN-11: the frozen legacy `/membership` checkout (src/worker.js)
// sets no `metadata` at all, unlike every portal-originated checkout.
// `payments_mirror.kind` is CHECK-constrained to ('membership','pack',
// 'booking') -- guessing wrong here is worse than not guessing (a wrong
// "pack" would grant 8 credits for what might be a single $15 session).
// `session.mode` makes the subscription case deterministic. A
// payment-mode legacy session is genuinely ambiguous (jp_session_single
// vs jp_session_pack8 both charge in Checkout mode "payment", and
// Stripe sends no line items on this event unless the endpoint is
// configured to expand them) -- `line_items` is read defensively in
// case that expansion is ever turned on, but when it is absent this
// returns null rather than guess; the caller records the session for
// the owner to reconcile by hand instead.
function classifyLegacySession(session) {
  const firstLineItem = session.line_items && session.line_items.data && session.line_items.data[0];
  const expandedLookupKey = firstLineItem && firstLineItem.price && firstLineItem.price.lookup_key;
  if (expandedLookupKey === "jp_session_pack8") return "pack";
  if (expandedLookupKey && MEMBERSHIP_AND_PACK_LOOKUP_KEYS.has(expandedLookupKey)) return "membership";
  if (session.mode === "subscription") return "membership";
  return null; // ambiguous payment-mode session with no line items -- never guessed
}

function legacyUnclassifiedAuditStatement(db, session) {
  return auditStatement(db, {
    actor: null,
    action: "stripe_legacy_payment_unclassified",
    targetType: "stripe_checkout_session",
    targetId: session.id,
    after: { amount_cents: session.amount_total || 0, mode: session.mode || null },
  });
}

function checkoutUnpaidAuditStatement(db, session) {
  return auditStatement(db, {
    actor: null,
    action: "stripe_checkout_completed_unpaid",
    targetType: "stripe_checkout_session",
    targetId: session.id,
    after: { payment_status: session.payment_status || null, mode: session.mode || null },
  });
}

async function handleCheckoutCompleted(session, env, db) {
  // M18/PIN-12/CTL-MSG-01: an async payment method completes this same
  // event with payment_status "unpaid" before the money has actually
  // cleared (Stripe settles it later via a separate
  // checkout.session.async_payment_succeeded/_failed event, routed back
  // through this same function/handleCheckoutExpired below). Confirming
  // a booking or granting anything on an explicitly unpaid session would
  // mean "confirmed" for money that might still fail to arrive. Only
  // the explicit 'unpaid' value is rejected -- real Stripe always sets
  // payment_status to 'paid' | 'unpaid' | 'no_payment_required', so an
  // absent value (older/partial fixtures) is treated as paid rather
  // than silently dropping an otherwise-normal confirmation.
  if (session.payment_status === "unpaid") {
    return [checkoutUnpaidAuditStatement(db, session)];
  }

  const bookingId = (session.metadata && session.metadata.booking_id) || null;
  const metadataKind = session.metadata && session.metadata.kind;
  // `booking_id` is the one signal amendment 6 actually documents for
  // "this Checkout paid for a booking" (createBookingCheckout always
  // sets it); it is authoritative over this file's own internal
  // `metadata.kind` convention. A hand-built event (a test fixture, or
  // any future caller) that sets `booking_id` without also setting
  // `kind` must still confirm the booking -- WH-006 caught this when
  // `kind` alone gated confirmPaidBooking and a booking_id-only event
  // silently never confirmed anything.
  const kind = bookingId ? "booking" : metadataKind || classifyLegacySession(session); // M13
  const statements = [];

  if (kind === "booking" && bookingId) {
    // B2a1's own atomic function (confirmed/paid_conflict/already_confirmed,
    // CTL-STR-08). Its write is already one transaction on its own; calling
    // it before our batch means a crash before our batch commits just makes
    // the (idempotent) webhook retry call it again, never lose it.
    await confirmPaidBooking(env, bookingId, { paymentIntentId: session.payment_intent, sessionId: session.id });
  }

  // A booking payment already has a definite owner -- the booking row
  // itself -- so the account comes from there, never from Stripe
  // customer/email matching, which a booking Checkout session may carry
  // none of at all (WH-006/WH-007 caught this: resolveAccountForSession
  // found no match on a booking-only fixture and the paid-and-confirmed
  // booking's payment landed in the unlinked-purchase trail instead of
  // payments_mirror).
  const resolved =
    kind === "booking" && bookingId
      ? await resolveAccountForBooking(db, bookingId)
      : await resolveAccountForSession(session, env, db);

  if (resolved.isNewAccount) {
    // M15: this INSERT must be committed (not merely queued into the
    // outer batch below) before `addCredits` -- a separate, already
    // atomic function -- runs next and writes a credits row that
    // references this account id. Queuing it into `statements` instead
    // would leave addCredits writing against a row that does not exist
    // yet (an FK orphan, or an outright FK violation).
    await db
      .prepare(`INSERT INTO accounts (id, email, role, display_name, is_demo, created_at, updated_at) VALUES (?,?,?,'',0,?,?)`)
      .bind(resolved.accountId, resolved.email, "guest", nowIso(), nowIso())
      .run();
  }

  if (resolved.accountId) {
    // M14/A7/S-10: whenever Stripe tells us the customer id for this
    // account (a fresh webhook-created account, or an existing account
    // only ever matched by email so far), it is written now. Without
    // this, a later customer.subscription.* event can never find the
    // account by stripe_customer_id, and its entitlement grant is
    // silently never created.
    if (session.customer) {
      statements.push(
        db
          .prepare(`UPDATE accounts SET stripe_customer_id = ?, updated_at = ? WHERE id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id != ?)`)
          .bind(session.customer, nowIso(), resolved.accountId, session.customer)
      );
    }
    if (kind === "pack") {
      // B2a1's single credit function (CTL-CRD-01), idempotent on `ref`.
      await addCredits(env, resolved.accountId, 8, { source: "pack", ref: session.id });
    }
    if (kind) {
      statements.push(
        db
          .prepare(
            `INSERT INTO payments_mirror (id, account_id, booking_id, stripe_payment_intent_id, stripe_checkout_session_id, amount_cents, currency, status, kind, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'paid',?,?,?)`
          )
          .bind(newId(), resolved.accountId, bookingId, session.payment_intent || null, session.id, session.amount_total || 0, session.currency || "usd", kind, nowIso(), nowIso())
      );
    } else {
      // M13: an ambiguous legacy payment-mode session -- recorded for
      // the owner, never guessed into the CHECK-constrained kind column.
      statements.push(legacyUnclassifiedAuditStatement(db, session));
    }
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

// Shared by checkout.session.expired AND M18's
// checkout.session.async_payment_failed -- an async payment that never
// clears releases the hold exactly the way an expired Checkout Session
// does, so this is reused rather than duplicated.
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
  // A1/WH-009: a malformed or test fixture's subscription object may carry
  // no `customer` at all -- D1 rejects a bound `undefined` outright (a
  // real thrown error, not a graceful "no match"), so this guards to
  // `null` the same way every other optional Stripe field in this file
  // does, rather than letting an absent field turn into a 500.
  if (!subscription.customer) return [];
  const account = await db.prepare(`SELECT id FROM accounts WHERE stripe_customer_id = ?`).bind(subscription.customer).first();
  if (!account) return []; // nothing to grant against yet; the raw event is still recorded in webhook_events
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const tier = item && item.price && item.price.lookup_key;
  if (!tier) return [];
  const status = subscription.status || null;
  const subscriptionId = subscription.id || null;
  const statements = [];

  const existing = await db
    .prepare(`SELECT * FROM entitlement_grants WHERE account_id = ? AND source = 'stripe' AND stripe_subscription_id = ?`)
    .bind(account.id, subscriptionId)
    .first();

  if (existing) {
    statements.push(db.prepare(`UPDATE entitlement_grants SET tier = ?, stripe_status = ?, updated_at = ? WHERE id = ?`).bind(tier, status, nowIso(), existing.id));
    if (isSingleCouplesSwitch(existing.tier, tier)) {
      statements.push(
        db.prepare(`UPDATE households SET status = 'needs_review', updated_at = ? WHERE payer_account_id = ? AND status = 'active'`).bind(nowIso(), account.id)
      );
    }
  } else {
    // M14/S-10: a grant created for an account that was ever linked by
    // email (A7) is flagged `linked_by_email` for the owner to confirm
    // -- read from the audit trail `handleCheckoutCompleted` already
    // writes at link time, rather than re-deriving or duplicating that
    // write here.
    const linked = await db.prepare(`SELECT 1 FROM audit_log WHERE action = 'stripe_linked_by_email' AND target_id = ? LIMIT 1`).bind(account.id).first();
    statements.push(
      db
        .prepare(
          `INSERT INTO entitlement_grants (id, account_id, source, tier, stripe_subscription_id, stripe_status, starts_at, status, linked_by_email, created_at, updated_at)
           VALUES (?,?,'stripe',?,?,?,?,'active',?,?,?)`
        )
        .bind(newId(), account.id, tier, subscriptionId, status, nowIso(), linked ? 1 : 0, nowIso(), nowIso())
    );
  }
  return statements;
}

async function handleSubscriptionDeleted(subscription, env, db) {
  if (!subscription.id) return []; // same reasoning as handleSubscriptionUpsert's customer guard
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
    // M18: an async payment method settles via this separate event,
    // same session shape, now with payment_status "paid" -- cheap to
    // handle by reusing the exact same effect function.
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutCompleted(obj, env, db);
    case "checkout.session.expired":
    // M18: an async payment that failed to clear releases the hold the
    // same way an expired session does -- reuses handleCheckoutExpired
    // rather than a second copy of the same release.
    case "checkout.session.async_payment_failed":
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

// The portal's half of POST /api/stripe/webhook. The signature has already
// been verified, and the body parsed, by the one-endpoint dispatcher in
// src/worker.js (pin L6, ruling E1-11), which also decides that this event
// belongs to the portal and not to Glow. This function claims the event id
// and applies its effects. `env` is the filtered portal env (buildPortalEnv).
// Returns a Response: 200 {received:true}, or a masked 500 so Stripe retries.
export async function processStripeEvent(event, env, db) {
  // A1: the dispatcher has already checked this. The portal's half still
  // refuses to apply anything on its own if the secret is absent, so no
  // caller can reach the effects of an unverifiable event.
  if (!env.STRIPE_WEBHOOK_SECRET) return notConfigured("stripe");

  // M16/PIN-11: claim the event id atomically BEFORE computing or
  // applying any effect. The old check (SELECT status, THEN compute
  // effects, THEN mark processed) was check-then-act: two concurrent
  // deliveries of the same event both pass the SELECT before either
  // writes, so both go on to apply their effects, producing two
  // payments_mirror rows and two entitlement grants for one event.
  // This single INSERT ... ON CONFLICT DO NOTHING RETURNING is one
  // atomic statement -- of two concurrent deliveries, exactly one gets
  // the returned row and proceeds; the other sees no row and returns
  // immediately below, computing and applying nothing.
  //
  // N1 fix (inspection-2.md): the claim above used to be permanent --
  // nothing released it when an effect failed, so a thrown error after
  // this INSERT left that event id claimed-but-unprocessed FOREVER
  // (Stripe's retry resends the SAME event id, finds no row returned by
  // the claim, and no-ops at `if (!claim)` below, forever). The claim
  // and the effects are still not one D1 batch (computeEffectStatements
  // calls B2a1's own already-atomic functions directly, not via
  // statements this file could fold into one batch), so instead: on any
  // failure between the claim and the processed-batch committing, the
  // claim row is deleted so a later delivery of the SAME event id can
  // claim and process it again, and this response is a non-2xx so
  // Stripe actually schedules that redelivery.
  const claim = await db
    .prepare(`INSERT INTO webhook_events (id, type, received_at, status) VALUES (?,?,?, 'received') ON CONFLICT(id) DO NOTHING RETURNING id`)
    .bind(event.id, event.type, nowIso())
    .first();
  if (!claim) {
    // Either an already-processed replay (PIN-11, a genuine no-op) or a
    // concurrent delivery racing us right now (M16) -- neither one
    // re-applies effects.
    return json({ received: true });
  }

  let effectStatements;
  try {
    effectStatements = await computeEffectStatements(event, env, db);
  } catch (err) {
    await db.prepare(`DELETE FROM webhook_events WHERE id = ? AND status = 'received'`).bind(event.id).run();
    // eslint-disable-next-line no-console
    console.log(`stripe_webhook_effect_failed id=${event.id} type=${event.type} stage=compute`);
    return logAndMask(err);
  }

  // FMEA top-3: the event is marked processed only in the SAME batch as
  // the effect rows this file writes directly (payments_mirror,
  // entitlement_grants, the audit trail). Effects delegated to B2a1's own
  // atomic functions (confirmPaidBooking/releaseHold/addCredits, called
  // inside computeEffectStatements above) are already one transaction on
  // their own and are each idempotent, so a crash between that call and
  // this batch committing is safe for THOSE effects: the one residual
  // gap is the direct effects below, named above.
  try {
    await runBatch(db, [
      db.prepare(`UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE id = ?`).bind(nowIso(), event.id),
      ...effectStatements,
    ]);
  } catch (err) {
    // N1: this batch failing (e.g. a CHECK violation on one of the
    // direct effect rows) must not leave the claim stuck -- release it
    // the same way the compute-stage catch above does, so a later
    // delivery of this same event id is accepted and processed again
    // rather than silently no-op'd at `if (!claim)`.
    await db.prepare(`DELETE FROM webhook_events WHERE id = ? AND status = 'received'`).bind(event.id).run();
    // eslint-disable-next-line no-console
    console.log(`stripe_webhook_effect_failed id=${event.id} type=${event.type} stage=batch`);
    return logAndMask(err);
  }

  // eslint-disable-next-line no-console
  console.log(`stripe_webhook_processed id=${event.id} type=${event.type}`);
  return json({ received: true });
}
