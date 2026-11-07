// N1 (inspection-2.md): the webhook's event-id claim (M16) used to be
// permanent even when an effect failed after it -- a thrown error
// between the claim INSERT and the processed-batch committing left
// that event id claimed-but-unprocessed forever. Stripe's retry
// resends the SAME event id; the claim query then returns no row for
// it (treated as an already-handled no-op), so the retry got a 200
// `{received:true}` and the event was lost for good -- exactly the
// dispatch's own wording: "the retry gets a non-2xx when the effects
// did not commit."
//
// RED construction (same fixture M1's own test uses, since it is the
// one genuine thrown error this fix round can drive without touching
// stripe.js's classification logic): a legacy Checkout session with
// `metadata.kind: "unknown"` reaches the `payments_mirror` INSERT with
// kind="unknown", which violates that column's CHECK constraint when
// the batch runs -- a real thrown error, not a hand-typed one.
//
// Proof: send the IDENTICAL event body (same event.id) TWICE, exactly
// as a real Stripe redelivery would. Before the fix, the first call is
// 500 and the SECOND silently returns 200 `{received:true}` (the claim
// query finds the stuck 'received' row gone and treats it as already
// handled -- nothing was ever applied, and Stripe stops retrying
// because it saw a 2xx). After the fix, the claim is released on
// failure, so the second call is rejected (non-2xx) again instead of
// being silently swallowed -- the event stays visibly broken and
// Stripe keeps retrying it, rather than looking "done" while nothing
// happened.
//
// No direct-D1 access is used here at all (unlike this suite's other
// webhook tests) -- this machine is running several other parts' own
// `wrangler dev`/CLI invocations concurrently right now, and a single
// `wrangler d1 execute` round trip was observed taking 30+ seconds
// under that load. Using an EXISTING seeded demo account's email
// (member.demo@jp-demo.test, the same email M1's own fixture uses, for
// the same reason) means resolveAccountForSession never creates a new
// account as a side effect of the first (failing) delivery, so this
// test leaves nothing behind to clean up and the CHECK-violation batch
// rolls back as one transaction either way (FMEA top-3).

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

async function postEvent(body) {
  const t = Math.floor(Date.now() / 1000);
  const header = sign(WEBHOOK_SECRET, body, t);
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": header },
        body,
      });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function unknownKindEvent(eventId, sessionId, email) {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_intent: `pi_${sessionId}`,
        amount_total: 1500,
        currency: "usd",
        customer: null,
        customer_details: { email },
        metadata: { kind: "unknown", booking_id: "" },
      },
    },
  });
}

test("N1 RED->GREEN: a redelivery of an event whose effects failed must still be rejected, not silently swallowed as 200", async () => {
  const eventId = `evt_test_n1_${Date.now()}`;
  const sessionId = `cs_n1_${Date.now()}`;
  const body = unknownKindEvent(eventId, sessionId, "member.demo@jp-demo.test");

  const first = await postEvent(body);
  assert.equal(first.status, 500, `an effect failure must answer non-2xx so Stripe schedules a redelivery, got ${first.status}`);
  assert.equal(first.data.error, "server_error");

  // The exact same event id, the exact same body -- a real Stripe
  // redelivery. GREEN: still rejected (the claim was released, so
  // this is processed again, fails the same way, and answers
  // non-2xx again). RED (pre-fix): the stuck claim makes this a
  // silent 200 `{received:true}` no-op.
  const second = await postEvent(body);
  assert.equal(second.status, 500, `a redelivery of a permanently-failing event must stay non-2xx, not be silently swallowed as 200, got ${second.status}`);
  assert.equal(second.data.error, "server_error");
});
