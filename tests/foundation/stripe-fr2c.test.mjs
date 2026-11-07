// portal(FR2-C): B2b webhook defects from inspection-1.md (M13, M14,
// M15, M16, M18). Black-box HTTP against the real webhook route
// (PIN-16), same technique as stripe-webhook.test.mjs -- this file signs
// its own events locally with whsec_local_test_only and never calls
// api.stripe.com.
//
// Every test that lets the webhook create a real account cleans that
// account (and its dependants) up in a `finally`, run or fail: a
// webhook-vivified account is always `is_demo = 0` (CTL-STR-05/AUTH-23,
// correctly -- it is never a seeded demo account), which trips
// router.js's CTL-ENV-02 "non-demo account on a preview host" signal to
// `mismatch` for every request on this server from then on (an
// out-of-scope finding, reported in this part's return, not fixed
// here: router.js is not one of this part's files). Cleaning up after
// each test keeps this file's own run repeatable without depending on
// that finding being fixed first.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BASE_URL, d1Last as d1, d1Each } from "./helpers.mjs";

const WEBHOOK_SECRET = "whsec_local_test_only";
const PERSIST_DIR = process.env.PORTAL_TEST_PERSIST_DIR || ".wrangler/state";

function sign(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

// `wrangler dev`'s watcher reloads on every source edit anywhere in the
// repo (other parts are editing this same shared tree right now, per
// this part's dispatch) and drops a request in flight as a genuine
// network error (fast ECONNRESET) -- that is what gets one retry here,
// same as helpers.mjs's makeClient(). This deliberately carries NO
// client-side timeout/abort: an abort-and-retry while the FIRST request
// is merely slow (this machine is running several other parts' own
// servers and test suites at once) would resend the same signed event
// while the original delivery is still in flight -- a second, genuinely
// concurrent delivery of the same event id, which is exactly the M16
// scenario this file deliberately constructs on purpose elsewhere and
// must not construct here by accident.
async function postWebhook(rawBody) {
  const t = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": sign(WEBHOOK_SECRET, rawBody, t) },
      body: rawBody,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch (err) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": sign(WEBHOOK_SECRET, rawBody, Math.floor(Date.now() / 1000)) },
      body: rawBody,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }
}

// Deletes a webhook-created test account and everything that could
// reference it, in FK-safe (children-first) order, in ONE wrangler
// invocation. Safe to call even when nothing was ever created (every
// statement is a no-op then).
function purgeAccountByEmail(email) {
  const sub = `(SELECT id FROM accounts WHERE email = '${email}')`;
  d1(
    [
      `DELETE FROM credits_ledger WHERE account_id IN ${sub}`,
      `DELETE FROM credits WHERE account_id IN ${sub}`,
      `DELETE FROM payments_mirror WHERE account_id IN ${sub}`,
      `DELETE FROM entitlement_grants WHERE account_id IN ${sub}`,
      `DELETE FROM audit_log WHERE target_id IN ${sub}`,
      `DELETE FROM bookings WHERE account_id IN ${sub}`,
      `DELETE FROM accounts WHERE email = '${email}'`,
    ].join("; ")
  );
}

function purgeEvent(eventId, sessionId) {
  const statements = [`DELETE FROM webhook_events WHERE id = '${eventId}'`];
  if (sessionId) {
    statements.push(`DELETE FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`);
    statements.push(`DELETE FROM audit_log WHERE target_id = '${sessionId}'`);
  }
  d1(statements.join("; "));
}

// ---------------------------------------------------------------------
// M13: the frozen legacy /membership checkout (src/worker.js) sets NO
// metadata at all. Pre-fix, `kind` fell through to "unknown", which
// `payments_mirror`'s CHECK(kind IN (...)) rejects -- the whole batch
// throws and the webhook never returns 200, so Stripe retries the same
// legacy purchase forever. GREEN: a subscription-mode legacy session is
// classified "membership" (deterministic from `session.mode`); a
// payment-mode legacy session (ambiguous between a single session and
// the 8-pack, since Stripe sends no line items on this event by
// default) is never guessed -- it is recorded for the owner instead,
// and the webhook still returns 200.
// ---------------------------------------------------------------------

test("M13: a legacy subscription checkout with no metadata is classified 'membership', no CHECK violation, 200", async () => {
  const eventId = "evt_m13_legacy_subscription";
  const sessionId = "cs_m13_legacy_sub";
  const email = "m13.legacy.sub@jp-demo.test";
  try {
    const body = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "subscription",
          payment_status: "paid",
          payment_intent: null,
          amount_total: 7500,
          currency: "usd",
          customer: null,
          customer_details: { email },
          // no `metadata` key at all -- exactly what src/worker.js sends
        },
      },
    });
    const res = await postWebhook(body);
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${JSON.stringify(res.data)}`);
    const [eventRows, rows] = d1Each(
      `SELECT COUNT(*) AS n FROM webhook_events WHERE id = '${eventId}'; SELECT kind, status FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`
    );
    assert.equal(eventRows[0].n, 1);
    assert.equal(rows.length, 1, "a legacy subscription purchase still gets a payments_mirror row");
    assert.equal(rows[0].kind, "membership");
    assert.equal(rows[0].status, "paid");
  } finally {
    purgeAccountByEmail(email);
    purgeEvent(eventId, sessionId);
  }
});

test("M13: a legacy payment-mode checkout with no metadata (ambiguous: single session or 8-pack) is recorded, never guessed, never a CHECK violation, 200", async () => {
  const eventId = "evt_m13_legacy_payment";
  const sessionId = "cs_m13_legacy_payment";
  const email = "m13.legacy.pay@jp-demo.test";
  try {
    const body = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_m13_legacy_payment",
          amount_total: 10000,
          currency: "usd",
          customer: null,
          customer_details: { email },
          // no `metadata`, and no `line_items` (Stripe does not send
          // line items on this event unless the endpoint expands them)
        },
      },
    });
    const res = await postWebhook(body);
    assert.equal(res.status, 200, `expected 200 (no DB crash), got ${res.status} ${JSON.stringify(res.data)}`);

    const [eventRows, mirrorRows, auditRows] = d1Each(
      `SELECT COUNT(*) AS n FROM webhook_events WHERE id = '${eventId}';
       SELECT COUNT(*) AS n FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}';
       SELECT after FROM audit_log WHERE action = 'stripe_legacy_payment_unclassified' AND target_id = '${sessionId}'`
    );
    assert.equal(eventRows[0].n, 1);
    assert.equal(mirrorRows[0].n, 0, "never guessed into payments_mirror's CHECK-constrained kind column");
    assert.equal(auditRows.length, 1, "recorded for the owner instead of guessed (never dropped)");
    const after = JSON.parse(auditRows[0].after);
    assert.equal(after.amount_cents, 10000);
  } finally {
    purgeAccountByEmail(email);
    purgeEvent(eventId, sessionId);
  }
});

// ---------------------------------------------------------------------
// M14: a buyer linked by email (no stripe_customer_id on the account
// yet) must get stripe_customer_id written, so a later
// customer.subscription.created/updated for that same Stripe customer
// finds the account and creates the entitlement grant, flagged
// linked_by_email (S-10). Pre-fix, stripe_customer_id was never
// written, so the subscription event found no account and the grant
// was silently never created.
// ---------------------------------------------------------------------

// Uses the SEEDED member2.demo account (already exists, is_demo = 1)
// rather than a brand-new email. A brand-new webhook-linked account is
// always written is_demo = 0 (CTL-STR-05/AUTH-23, correctly) -- but
// router.js's CTL-ENV-02 signal ("a non-demo account exists on a
// preview host") treats that correct row as evidence of environment
// contamination and 503s every further request on this server,
// including this test's own SECOND webhook call below. That is a real,
// out-of-scope defect (router.js is not one of this part's files,
// reported in this part's return) which would also 503 a REAL buyer's
// very next webhook delivery on the real preview deployment. Matching
// by email to an account that already exists (isNewAccount: false)
// writes no new account row, so it exercises the same M14 code path
// (stripe_customer_id written for an email-matched account, the grant
// flagged linked_by_email) without tripping that defect.
test("M14: an email-linked buyer gets stripe_customer_id written, and the subsequent subscription event grants an entitlement flagged linked_by_email", async () => {
  const LINK_EMAIL = "member2.demo@jp-demo.test";
  const LINK_ACCOUNT_ID = "demo-memb2-0000-0000-000000000004";
  const CUSTOMER_ID = "cus_m14_test";
  const checkoutEventId = "evt_m14_checkout";
  const checkoutSessionId = "cs_m14_checkout";
  const subEventId = "evt_m14_subscription";
  d1(`UPDATE accounts SET stripe_customer_id = NULL WHERE id = '${LINK_ACCOUNT_ID}'`);
  try {
    // Step 1: a subscription checkout completes, with a real Stripe
    // customer id attached, matched to the existing account by email
    // (A7) since it has no stripe_customer_id yet.
    const checkoutBody = JSON.stringify({
      id: checkoutEventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: checkoutSessionId,
          mode: "subscription",
          payment_status: "paid",
          payment_intent: null,
          amount_total: 7500,
          currency: "usd",
          customer: CUSTOMER_ID,
          customer_details: { email: LINK_EMAIL },
        },
      },
    });
    const checkoutRes = await postWebhook(checkoutBody);
    assert.equal(checkoutRes.status, 200, JSON.stringify(checkoutRes.data));

    const account = d1(`SELECT id, stripe_customer_id FROM accounts WHERE id = '${LINK_ACCOUNT_ID}'`)[0];
    assert.equal(account.stripe_customer_id, CUSTOMER_ID, "M14: stripe_customer_id must be written for an email-linked buyer");

    // Step 2: Stripe's companion customer.subscription.created event for
    // that same customer -- pre-fix this found no account (lookup by
    // stripe_customer_id failed) and silently granted nothing.
    const subBody = JSON.stringify({
      id: subEventId,
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_m14_test",
          customer: CUSTOMER_ID,
          status: "active",
          items: { data: [{ price: { lookup_key: "jp_1m_single" } }] },
        },
      },
    });
    const subRes = await postWebhook(subBody);
    assert.equal(subRes.status, 200, JSON.stringify(subRes.data));

    const grants = d1(
      `SELECT tier, linked_by_email, status FROM entitlement_grants WHERE account_id = '${account.id}' AND source = 'stripe' AND stripe_subscription_id = 'sub_m14_test'`
    );
    assert.equal(grants.length, 1, "M14: the entitlement grant must now be created for the email-linked account");
    assert.equal(grants[0].tier, "jp_1m_single");
    assert.equal(grants[0].status, "active");
    assert.equal(grants[0].linked_by_email, 1, "S-10: the grant is flagged linked_by_email for owner confirmation");
  } finally {
    d1(`UPDATE accounts SET stripe_customer_id = NULL WHERE id = '${LINK_ACCOUNT_ID}'`);
    d1(`DELETE FROM entitlement_grants WHERE account_id = '${LINK_ACCOUNT_ID}' AND stripe_subscription_id = 'sub_m14_test'`);
    d1(`DELETE FROM payments_mirror WHERE account_id = '${LINK_ACCOUNT_ID}'`);
    d1(`DELETE FROM audit_log WHERE target_id = '${LINK_ACCOUNT_ID}'`);
    purgeEvent(checkoutEventId, checkoutSessionId);
    purgeEvent(subEventId, null);
  }
});

// ---------------------------------------------------------------------
// M15: for a NEW buyer, the 8-pack credits must be written after (or in
// the same batch as) the account they belong to -- never before, which
// references a row that does not exist yet.
// ---------------------------------------------------------------------

test("M15: a new buyer's pack purchase credits land against an account that already exists, no orphan credits", async () => {
  const PACK_EMAIL = "m15.newbuyer@jp-demo.test";
  const eventId = "evt_m15_pack";
  const sessionId = "cs_m15_pack";
  try {
    const body = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_m15_pack",
          amount_total: 10000,
          currency: "usd",
          customer: null,
          customer_details: { email: PACK_EMAIL },
          metadata: { kind: "pack", booking_id: "" },
        },
      },
    });
    const res = await postWebhook(body);
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const accounts = d1(`SELECT id FROM accounts WHERE email = '${PACK_EMAIL}'`);
    assert.equal(accounts.length, 1, "the new account must exist");
    const account = accounts[0];

    const [credits, ledger] = d1Each(
      `SELECT balance FROM credits WHERE account_id = '${account.id}'; SELECT delta FROM credits_ledger WHERE account_id = '${account.id}'`
    );
    assert.equal(credits.length, 1, "a credits row must exist for the new account (no FK orphan)");
    assert.equal(credits[0].balance, 8, "M15: the 8-pack credits must land, ordered after the account exists");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].delta, 8);
  } finally {
    purgeAccountByEmail(PACK_EMAIL);
    purgeEvent(eventId, sessionId);
  }
});

// ---------------------------------------------------------------------
// M16: two concurrent deliveries of ONE event must take effect once.
// The claim (INSERT ... ON CONFLICT DO NOTHING RETURNING) must gate the
// effects, not a check-then-act SELECT.
// ---------------------------------------------------------------------

// Uses the SEEDED guest.demo account's email (already exists) rather
// than a brand-new one, for the same reason M14's test does: a
// webhook-created account is correctly is_demo = 0, but router.js's
// CTL-ENV-02 signal treats any such row on a preview host as
// environment contamination and 503s this test's OWN second concurrent
// request before it ever reaches handleStripeWebhook -- an
// out-of-scope defect (reported in this part's return), not this
// test's concern. Matching an existing account creates no new row, so
// M16's actual claim-vs-effects race is exercised cleanly.
test("M16: two simultaneous signed deliveries of the same event produce exactly one payments_mirror row and one webhook_events row", async () => {
  const eventId = "evt_m16_concurrent";
  const sessionId = "cs_m16_concurrent";
  const email = "guest.demo@jp-demo.test";
  const GUEST_ACCOUNT_ID = "demo-guest-0000-0000-000000000005";
  try {
    const body = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_m16_concurrent",
          amount_total: 5500,
          currency: "usd",
          customer: null,
          customer_details: { email },
          metadata: { kind: "membership", booking_id: "" },
        },
      },
    });

    // Two genuinely simultaneous deliveries: issued together, not
    // awaited one at a time.
    const [first, second] = await Promise.all([postWebhook(body), postWebhook(body)]);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(second.status, 200, JSON.stringify(second.data));

    const [eventRows, mirrorRows] = d1Each(
      `SELECT COUNT(*) AS n FROM webhook_events WHERE id = '${eventId}'; SELECT COUNT(*) AS n FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`
    );
    assert.equal(eventRows[0].n, 1, "exactly one webhook_events row for one event id");
    assert.equal(mirrorRows[0].n, 1, "M16: the event must take effect exactly once under concurrent delivery");
  } finally {
    // Targeted cleanup only -- guest.demo is seeded data other test
    // files depend on, never deleted wholesale.
    d1(`DELETE FROM audit_log WHERE target_id = '${GUEST_ACCOUNT_ID}' AND action = 'stripe_linked_by_email'`);
    purgeEvent(eventId, sessionId);
  }
});

// ---------------------------------------------------------------------
// M18: checkout.session.completed must grant/confirm only when
// payment_status is not explicitly 'unpaid' (an async payment method
// that has not yet cleared). checkout.session.async_payment_succeeded/
// _failed are handled cheaply by reusing the same effect functions.
// ---------------------------------------------------------------------

test("M18: an 'unpaid' checkout.session.completed grants nothing and is recorded; the later async_payment_succeeded for the same session then grants for real", async () => {
  const UNPAID_EMAIL = "m18.unpaid@jp-demo.test";
  const sessionId = "cs_m18_unpaid";
  const unpaidEventId = "evt_m18_unpaid_completed";
  const paidEventId = "evt_m18_async_succeeded";
  try {
    const unpaidBody = JSON.stringify({
      id: unpaidEventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          payment_status: "unpaid", // async payment method, not cleared yet
          payment_intent: "pi_m18_unpaid",
          amount_total: 10000,
          currency: "usd",
          customer: null,
          customer_details: { email: UNPAID_EMAIL },
          metadata: { kind: "pack", booking_id: "" },
        },
      },
    });
    const unpaidRes = await postWebhook(unpaidBody);
    assert.equal(unpaidRes.status, 200, JSON.stringify(unpaidRes.data));

    const [accountBefore, mirrorBefore, auditRows] = d1Each(
      `SELECT id FROM accounts WHERE email = '${UNPAID_EMAIL}';
       SELECT COUNT(*) AS n FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}';
       SELECT after FROM audit_log WHERE action = 'stripe_checkout_completed_unpaid' AND target_id = '${sessionId}'`
    );
    assert.equal(accountBefore.length, 0, "M18: an unpaid session must not even create the account or grant credits");
    assert.equal(mirrorBefore[0].n, 0, "M18: no payments_mirror row for an unpaid session");
    assert.equal(auditRows.length, 1, "M18: the unpaid completion is still recorded, never silently dropped");

    // Stripe later confirms the async payment actually cleared, same
    // session id, a DIFFERENT event id and type.
    const paidBody = JSON.stringify({
      id: paidEventId,
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_m18_unpaid",
          amount_total: 10000,
          currency: "usd",
          customer: null,
          customer_details: { email: UNPAID_EMAIL },
          metadata: { kind: "pack", booking_id: "" },
        },
      },
    });
    const paidRes = await postWebhook(paidBody);
    assert.equal(paidRes.status, 200, JSON.stringify(paidRes.data));

    const accountsAfter = d1(`SELECT id FROM accounts WHERE email = '${UNPAID_EMAIL}'`);
    assert.equal(accountsAfter.length, 1, "M18: async_payment_succeeded for the same session now grants for real");
    const credits = d1(`SELECT balance FROM credits WHERE account_id = '${accountsAfter[0].id}'`);
    assert.equal(credits.length, 1);
    assert.equal(credits[0].balance, 8);
  } finally {
    purgeAccountByEmail(UNPAID_EMAIL);
    purgeEvent(unpaidEventId, sessionId);
    purgeEvent(paidEventId, null);
  }
});

test("M18: checkout.session.async_payment_failed releases a booking hold the same way checkout.session.expired does", async () => {
  const RESOURCE_ID = "demo-court-0000-0000-000000000002";
  const GUEST_ID = "demo-guest-0000-0000-000000000005";
  const holdId = "m18-async-failed-hold";
  const sessionId = "cs_m18_async_failed";
  const eventId = "evt_m18_async_failed";
  const start = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 90 * 60 * 1000).toISOString();

  d1(`DELETE FROM bookings WHERE id = '${holdId}'`);
  purgeEvent(eventId, sessionId);
  try {
    d1(
      `INSERT INTO bookings (id, account_id, resource_id, offering_id, start_at, end_at, party_size, free_kids, status, payment_mode, hold_expires_at, checkout_session_id, created_by, created_at, updated_at)
       VALUES ('${holdId}', '${GUEST_ID}', '${RESOURCE_ID}', NULL, '${start}', '${end}', 1, 0, 'pending_payment', 'pay', datetime('now','+10 minutes'), '${sessionId}', '${GUEST_ID}', datetime('now'), datetime('now'))`
    );

    const body = JSON.stringify({
      id: eventId,
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          payment_status: "unpaid",
          metadata: { kind: "booking", booking_id: holdId },
        },
      },
    });
    const res = await postWebhook(body);
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const row = d1(`SELECT status FROM bookings WHERE id = '${holdId}'`)[0];
    assert.equal(row.status, "cancelled", "M18: a failed async payment releases the hold, same as an expired checkout session");
  } finally {
    d1(`DELETE FROM bookings WHERE id = '${holdId}'`);
    purgeEvent(eventId, sessionId);
  }
});
