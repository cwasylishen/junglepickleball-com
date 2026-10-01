// CTL-STR-04/05, PIN-11, acceptance scenario 3 (B2b dispatch): hand-rolled
// HMAC-SHA256 signature verification over `${t}.${rawBody}`, 300s
// tolerance, verified BEFORE parsing, idempotent on event.id.
//
// scripts/test.sh runs the server with STRIPE_WEBHOOK_SECRET set to
// `whsec_local_test_only` (and STRIPE_SECRET_KEY left unset) specifically
// so this file can sign events locally and never needs a real Stripe
// account or any call to api.stripe.com.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { d1, BASE_URL } from "./helpers.mjs";

const WEBHOOK_SECRET = "whsec_local_test_only";
const MEMBER_DEMO_ACCOUNT_ID = "demo-memb1-0000-0000-000000000003"; // member.demo@jp-demo.test, seed-preview.sql

function sign(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

async function postWebhook(rawBody, signatureHeader) {
  const headers = { "Content-Type": "application/json" };
  if (signatureHeader !== undefined) headers["Stripe-Signature"] = signatureHeader;
  // Same one-retry-on-transient-disconnect reasoning as helpers.mjs's
  // makeClient(): `wrangler dev`'s hot-reload (triggered by ANY file
  // change anywhere in the watched tree, not just this one) can drop a
  // request already in flight. One retry rides that out without masking
  // a real failure -- the retried request still gets the real response.
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${BASE_URL}/api/stripe/webhook`, { method: "POST", headers, body: rawBody });
      break;
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function checkoutCompletedEvent({ id, sessionId, email, amountTotal = 5500, kind = "pack" }) {
  return JSON.stringify({
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_intent: `pi_${sessionId}`,
        amount_total: amountTotal,
        currency: "usd",
        customer: null,
        customer_details: { email },
        metadata: { kind, booking_id: "" },
      },
    },
  });
}

function eventRowCount(eventId) {
  return d1(`SELECT COUNT(*) AS n FROM webhook_events WHERE id = '${eventId}'`)[0].n;
}

test("CTL-STR-04/PIN-11: a missing Stripe-Signature header is refused, 0 rows written", async () => {
  const eventId = "evt_test_missing_sig";
  const body = checkoutCompletedEvent({ id: eventId, sessionId: "cs_missing", email: "member.demo@jp-demo.test" });
  const res = await postWebhook(body, undefined);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "bad_signature");
  assert.equal(eventRowCount(eventId), 0);
});

test("CTL-STR-04/PIN-11: a wrong signature is refused, 0 rows written", async () => {
  const eventId = "evt_test_wrong_sig";
  const body = checkoutCompletedEvent({ id: eventId, sessionId: "cs_wrong", email: "member.demo@jp-demo.test" });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${"0".repeat(64)}`; // well-formed, deliberately wrong
  const res = await postWebhook(body, header);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "bad_signature");
  assert.equal(eventRowCount(eventId), 0);
});

test("CTL-STR-04/PIN-11: a stale (>300s) timestamp is refused even with a correctly-computed signature, 0 rows written", async () => {
  const eventId = "evt_test_stale";
  const body = checkoutCompletedEvent({ id: eventId, sessionId: "cs_stale", email: "member.demo@jp-demo.test" });
  const staleTimestamp = Math.floor(Date.now() / 1000) - 400; // > 300s tolerance
  const header = sign(WEBHOOK_SECRET, body, staleTimestamp);
  const res = await postWebhook(body, header);
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "bad_signature");
  assert.equal(eventRowCount(eventId), 0);
});

test("CTL-STR-05/A7/S-10: a correctly-signed event is accepted, links the existing demo account by email, and is idempotent on replay", async () => {
  const eventId = "evt_test_happy_path";
  const sessionId = "cs_happy_path";
  const body = checkoutCompletedEvent({ id: eventId, sessionId, email: "member.demo@jp-demo.test", amountTotal: 5500, kind: "pack" });
  const t = Math.floor(Date.now() / 1000);
  const header = sign(WEBHOOK_SECRET, body, t);

  const mirrorBefore = d1(`SELECT COUNT(*) AS n FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`)[0].n;
  assert.equal(mirrorBefore, 0);

  const res = await postWebhook(body, header);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { received: true });
  assert.equal(eventRowCount(eventId), 1);

  const processed = d1(`SELECT status FROM webhook_events WHERE id = '${eventId}'`)[0];
  assert.equal(processed.status, "processed");

  const mirrorRows = d1(`SELECT account_id, kind, amount_cents, status FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`);
  assert.equal(mirrorRows.length, 1, "exactly one payments_mirror row for this session");
  assert.equal(mirrorRows[0].account_id, MEMBER_DEMO_ACCOUNT_ID, "linked by lower(email) to the existing demo account (A7)");
  assert.equal(mirrorRows[0].kind, "pack");
  assert.equal(mirrorRows[0].amount_cents, 5500);
  assert.equal(mirrorRows[0].status, "paid");

  const linkAudit = d1(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stripe_linked_by_email' AND target_id = '${MEMBER_DEMO_ACCOUNT_ID}'`)[0].n;
  assert.ok(linkAudit >= 1, "the email-link is flagged in the audit trail (S-10)");

  // Replay: the SAME event.id, re-signed fresh (as Stripe's own retry
  // would arrive), writes no second payments_mirror row.
  const replayHeader = sign(WEBHOOK_SECRET, body, Math.floor(Date.now() / 1000));
  const replay = await postWebhook(body, replayHeader);
  assert.equal(replay.status, 200);
  assert.equal(eventRowCount(eventId), 1, "still exactly one webhook_events row");
  const mirrorAfterReplay = d1(`SELECT COUNT(*) AS n FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`)[0].n;
  assert.equal(mirrorAfterReplay, 1, "the replay must write no second payments_mirror row");
});

test("FMEA #4: an unlinkable payment (no account, no matching email) is recorded for the owner, never dropped", async () => {
  const eventId = "evt_test_unlinkable";
  const sessionId = "cs_unlinkable";
  // Not a @jp-demo.test address -- in the preview env class this is
  // never linked or created (CTL-STR-05), but it must still be recorded.
  const body = checkoutCompletedEvent({ id: eventId, sessionId, email: "real.person@example.com", amountTotal: 1500, kind: "membership" });
  const t = Math.floor(Date.now() / 1000);
  const header = sign(WEBHOOK_SECRET, body, t);

  const res = await postWebhook(body, header);
  assert.equal(res.status, 200);
  assert.equal(eventRowCount(eventId), 1);

  const mirrorRows = d1(`SELECT COUNT(*) AS n FROM payments_mirror WHERE stripe_checkout_session_id = '${sessionId}'`)[0].n;
  assert.equal(mirrorRows, 0, "no account exists to attach this payment to");

  const unlinkedAudit = d1(`SELECT after FROM audit_log WHERE action = 'stripe_unlinked_purchase' AND target_id = '${sessionId}'`);
  assert.equal(unlinkedAudit.length, 1, "the unlinkable payment must be recorded for the owner, never dropped");
  const after = JSON.parse(unlinkedAudit[0].after);
  assert.equal(after.amount_cents, 1500);
  assert.ok(!after.email_hint || !after.email_hint.includes("real.person"), "the full email is never stored, only a hint (CTL-STR-04-style privacy)");
});

test("not_configured gate also applies to the webhook when STRIPE_WEBHOOK_SECRET itself is absent -- proven by reading the gate in source, since this suite's server always sets it (A1)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../src/portal/stripe.js", import.meta.url), "utf8"));
  assert.match(src, /if \(!env\.STRIPE_WEBHOOK_SECRET\) return notConfigured\("stripe"\);/, "the webhook's own not-configured gate must check STRIPE_WEBHOOK_SECRET, separately from STRIPE_SECRET_KEY (A1)");
});
