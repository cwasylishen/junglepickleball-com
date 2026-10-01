// CTL-STR (acceptance scenario 5, B2b dispatch): the Checkout request
// builder is a pure function -- no network, no server, no `node --test`
// harness needed. Importing src/portal/stripe.js directly here never
// calls fetch() at module load, so this file runs standalone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCheckoutParams } from "../../src/portal/stripe.js";

test("buildCheckoutParams: carries customer, client_reference_id, metadata.booking_id, a lookup_key price, and expires_at >= now+30min", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + 31 * 60; // amendment 5 F-4

  const params = buildCheckoutParams({
    mode: "payment",
    customerId: "cus_test123",
    clientReferenceId: "acct_abc",
    bookingId: "booking_xyz",
    lineItems: [{ price: "price_massage60", quantity: 1, lookup_key: "massage_60" }],
    successUrl: "https://example.test/portal/#paid=",
    cancelUrl: "https://example.test/portal/#cancelled",
    expiresAt,
  });

  assert.equal(params.customer, "cus_test123");
  assert.equal(params.client_reference_id, "acct_abc");
  assert.equal(params.metadata.booking_id, "booking_xyz");
  assert.ok(params.metadata.lookup_keys.includes("massage_60"), "the built params must carry the lookup_key the price came from");
  assert.equal(params.line_items.length, 1);
  assert.equal(params.line_items[0].price, "price_massage60");
  assert.equal(params.line_items[0].quantity, 1);
  assert.ok(params.expires_at >= nowSeconds + 30 * 60, "expires_at must be at least 30 minutes out");
});

test("buildCheckoutParams: is pure -- identical inputs produce identical output, twice in a row", () => {
  const input = {
    mode: "payment",
    customerId: "cus_1",
    clientReferenceId: "acct_1",
    bookingId: "b1",
    lineItems: [{ price: "price_1", quantity: 2, lookup_key: "jp_session_single" }],
    successUrl: "https://example.test/ok",
    cancelUrl: "https://example.test/cancel",
    expiresAt: 1234567890,
  };
  assert.deepEqual(buildCheckoutParams(input), buildCheckoutParams(input));
});

test("buildCheckoutParams: refuses to build without a customer (R-4, customer create-first)", () => {
  assert.throws(() =>
    buildCheckoutParams({
      mode: "payment",
      customerId: null,
      clientReferenceId: "acct_1",
      bookingId: null,
      lineItems: [{ price: "price_1", quantity: 1, lookup_key: "jp_session_single" }],
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/cancel",
      expiresAt: 0,
    })
  );
});

test("buildCheckoutParams: multiple line items each keep their own lookup_key in the audit trail", () => {
  const params = buildCheckoutParams({
    mode: "payment",
    customerId: "cus_1",
    clientReferenceId: "acct_1",
    bookingId: null,
    lineItems: [
      { price: "price_court", quantity: 4, lookup_key: "jp_session_single" },
    ],
    successUrl: "https://example.test/ok",
    cancelUrl: "https://example.test/cancel",
    expiresAt: 0,
  });
  // CTL-STR-01: quantity travels through unchanged -- this builder never
  // substitutes a different number than the one it was given.
  assert.equal(params.line_items[0].quantity, 4);
  assert.equal(params.metadata.lookup_keys, "jp_session_single");
});
