// M1 (CTL-ERR-01): src/portal/router.js's dispatch to the webhook
// handler must be `await`ed inside the router's own try/catch, or a
// rejected promise skips logAndMask and escapes to the legacy catch in
// src/worker.js, which answers with the raw error message
// (`{error:"Server error.", detail: ...}`) instead of the one generic
// envelope (`{error:"server_error"}`).
//
// RED construction: a legacy checkout event (`kind: "unknown"`) makes
// the payments_mirror INSERT violate its CHECK constraint inside
// handleStripeWebhook, a genuine thrown error from a file this fix
// round never touches (stripe.js, B2b-owned). Without the `await`, that
// rejection bypasses router.js's catch entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BASE_URL } from "./helpers.mjs";

const WEBHOOK_SECRET = "whsec_local_test_only";

function sign(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function unknownKindEvent(id, sessionId) {
  return JSON.stringify({
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_intent: `pi_${sessionId}`,
        amount_total: 1500,
        currency: "usd",
        customer: null,
        customer_details: { email: "member.demo@jp-demo.test" },
        metadata: { kind: "unknown", booking_id: "" },
      },
    },
  });
}

test("M1/CTL-ERR-01: a thrown error inside the webhook handler is masked by the router's own catch, never the raw message", async () => {
  const eventId = `evt_test_m1_mask_${Date.now()}`;
  const sessionId = `cs_m1_mask_${Date.now()}`;
  const body = unknownKindEvent(eventId, sessionId);
  const t = Math.floor(Date.now() / 1000);
  const header = sign(WEBHOOK_SECRET, body, t);

  const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": header },
    body,
  });
  assert.equal(res.status, 500, "the CHECK-constraint violation must surface as the one masked 500, not succeed");
  const data = await res.json();
  assert.equal(data.error, "server_error", "router.js's logAndMask envelope -- the GREEN this control requires");
  assert.equal(data.detail, undefined, "the legacy catch's `detail` (raw err.message/SQL text) must never appear -- that is exactly the escape M1 names");
});
