// CTL-STR-02 (controls.md §3.4 Stripe pack): "no charge the portal did
// not show." `src/portal/stripe.js`'s `createBookingCheckout` already
// compares a live Stripe Price to a caller-supplied `expected_unit_cents`
// and throws `{code:"price_mismatch"}` on drift -- but until this
// portal(FR1) fix round, `src/portal/booking.js`'s `createBooking` never
// actually PASSED `expected_unit_cents` on its lineItem, so the control
// was wired but never armed (see this dispatch's return). This file is
// a pure stub test (no server, no network -- a monkey-patched
// `globalThis.fetch` stands in for Stripe, same technique as
// `stripe-pure.test.mjs`) proving both halves: RED (the pre-fix call
// shape lets a drifted price through) and GREEN (the shape booking.js
// now sends refuses it, releasing no Checkout and making no second
// Stripe call).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookingCheckout } from "../../src/portal/stripe.js";

const DISPLAY_PRICE_CENTS = 8000; // the offering's mirror, what the portal showed
const LIVE_STRIPE_PRICE_CENTS = 8500; // Stripe's Price has since drifted higher

function stubFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes("/prices?")) {
      return {
        ok: true,
        json: async () => ({ data: [{ id: "price_live_1", unit_amount: LIVE_STRIPE_PRICE_CENTS, product: "prod_1" }] }),
      };
    }
    if (String(url).includes("/checkout/sessions")) {
      return { ok: true, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }) };
    }
    throw new Error(`stubFetch: unexpected URL ${url}`);
  };
}

const ACCOUNT = { id: "acct_1", email: "member@jp-demo.test", stripe_customer_id: "cus_existing" }; // customer already set -- skips ensureCustomer's own DB write
const ENV = { STRIPE_SECRET_KEY: "sk_test_x" };

test("CTL-STR-02 RED: a lineItem with no expected_unit_cents lets the drifted live Price through unflagged", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls);
  try {
    const result = await createBookingCheckout(ENV, {
      account: ACCOUNT,
      bookingId: "b1",
      lineItems: [{ lookup_key: "massage_60", quantity: 1 }], // the pre-fix shape: no expected_unit_cents
      expiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/cancel",
    });
    assert.equal(result.sessionId, "cs_test_1", "RED: a Checkout was created despite the price having drifted from 8000 to 8500");
    assert.ok(calls.some((u) => u.includes("/checkout/sessions")), "RED: the Checkout API was called -- the portal would charge the undisplayed 8500");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("CTL-STR-02 GREEN: the lineItem booking.js now sends (with expected_unit_cents) refuses the same drifted Price, no Checkout call made", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls);
  try {
    await assert.rejects(
      () =>
        createBookingCheckout(ENV, {
          account: ACCOUNT,
          bookingId: "b1",
          lineItems: [{ lookup_key: "massage_60", quantity: 1, expected_unit_cents: DISPLAY_PRICE_CENTS }], // the fixed shape
          expiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
          successUrl: "https://example.test/ok",
          cancelUrl: "https://example.test/cancel",
        }),
      (err) => err && err.code === "price_mismatch"
    );
    assert.ok(!calls.some((u) => u.includes("/checkout/sessions")), "GREEN: no Checkout session is ever created once the mismatch is caught");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("CTL-STR-02 sanity: expected_unit_cents matching the live Price still succeeds normally", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/prices?")) {
      return { ok: true, json: async () => ({ data: [{ id: "price_live_1", unit_amount: DISPLAY_PRICE_CENTS, product: "prod_1" }] }) };
    }
    if (String(url).includes("/checkout/sessions")) {
      return { ok: true, json: async () => ({ id: "cs_test_2", url: "https://checkout.stripe.test/cs_test_2" }) };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await createBookingCheckout(ENV, {
      account: ACCOUNT,
      bookingId: "b2",
      lineItems: [{ lookup_key: "massage_60", quantity: 1, expected_unit_cents: DISPLAY_PRICE_CENTS }],
      expiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/cancel",
    });
    assert.equal(result.sessionId, "cs_test_2");
  } finally {
    globalThis.fetch = realFetch;
  }
});
