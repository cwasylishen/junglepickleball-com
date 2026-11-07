// Pin L6 as amended by ruling E1-11: ONE endpoint, POST /api/stripe/webhook,
// shared by Glow and the portal. The signature is verified once, then the
// event is routed by what its checkout session carries in `metadata`:
//   signup_id                      -> the Glow handler
//   kind / booking_id / lookup_keys, or nothing at all, or a non-checkout
//   event                          -> the portal handler
//   any other metadata             -> 200, ignored, logged (never a 400)
//
// Black-box HTTP against the local server that scripts/test.sh starts with
// STRIPE_WEBHOOK_SECRET=whsec_local_test_only and GLOW_LIST_KEY set, and
// STRIPE_SECRET_KEY unset (so a Glow signup is stored as pay_at_event and a
// Stripe call never happens). The "secret unset -> 503" case cannot use that
// server, so it calls the Worker's own fetch() with an env that lacks the
// secret, the same way glow-signup.test.mjs drives the Glow handlers.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { d1, BASE_URL } from "./helpers.mjs";
import worker from "../../src/worker.js";

const WEBHOOK_SECRET = "whsec_local_test_only";
const GLOW_LIST_KEY = "glow-list-key-local-test";
const RUN = Date.now();

function sign(rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

// `wrangler dev` reloads when a source file changes and drops a request in
// flight; a retry on a network error (never on an HTTP status) rides that
// out, the same as helpers.mjs's makeClient().
async function fetchRetry(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function post(path, body, headers = {}) {
  const res = await fetchRetry(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function sessionEvent({ id, type = "checkout.session.completed", sessionId, metadata }) {
  return JSON.stringify({
    id,
    type,
    data: {
      object: {
        id: sessionId,
        mode: "payment",
        payment_status: "paid",
        payment_intent: `pi_${sessionId}`,
        amount_total: 2000,
        currency: "usd",
        customer: null,
        customer_details: { email: "dispatch.test@example.invalid" },
        metadata,
      },
    },
  });
}

const webhook = (rawBody, header) => post("/api/stripe/webhook", rawBody, header === undefined ? {} : { "Stripe-Signature": header });

async function glowSignups() {
  const res = await fetchRetry(`${BASE_URL}/api/glow/list?key=${GLOW_LIST_KEY}`);
  assert.equal(res.status, 200, "the local server must be started with GLOW_LIST_KEY (scripts/test.sh)");
  return (await res.json()).signups;
}

async function deleteGlowSignup(id) {
  await fetchRetry(`${BASE_URL}/api/glow/list?key=${GLOW_LIST_KEY}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

function webhookEventRows(ids) {
  const quoted = ids.map((i) => `'${i}'`).join(",");
  return d1(`SELECT id, status FROM webhook_events WHERE id IN (${quoted})`);
}

test("E1-11: a Glow session (metadata.signup_id) goes to the Glow handler: the signup turns paid and the portal never claims the event", async () => {
  const created = await post("/api/glow/signup", { name: "Dispatch Test", phone: "000", role: "player", people: 1 }, { "CF-Connecting-IP": `203.0.113.${RUN % 200}` });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const signupId = created.data.signup.id;
  assert.equal(created.data.signup.status, "pay_at_event", "Stripe is unset on the test server, so Glow stores pay at the event");
  const eventId = `evt_dispatch_glow_${RUN}`;
  try {
    const body = sessionEvent({ id: eventId, sessionId: `cs_dispatch_glow_${RUN}`, metadata: { signup_id: signupId } });
    const res = await webhook(body, sign(body));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data, { received: true });

    const row = (await glowSignups()).find((s) => s.id === signupId);
    assert.equal(row.status, "paid", "the Glow handler marked the signup paid");
    assert.equal(row.stripeSessionId, `cs_dispatch_glow_${RUN}`);
    assert.equal(webhookEventRows([eventId]).length, 0, "the portal handler must not have claimed a Glow event");
  } finally {
    await deleteGlowSignup(signupId);
  }
});

test("E1-11: a Glow session for a signup that does not exist is the Glow handler's own 404, proving it was routed to Glow", async () => {
  const body = sessionEvent({ id: `evt_dispatch_glow_missing_${RUN}`, sessionId: `cs_dispatch_missing_${RUN}`, metadata: { signup_id: "no-such-signup" } });
  const res = await webhook(body, sign(body));
  assert.equal(res.status, 404, JSON.stringify(res.data));
  assert.match(res.data.error, /No signup found for id no-such-signup/);
});

test("E1-11: portal events go to the portal handler (metadata.kind, no metadata, and a non-checkout event each leave a webhook_events row)", async () => {
  const ids = [`evt_dispatch_portal_kind_${RUN}`, `evt_dispatch_portal_bare_${RUN}`, `evt_dispatch_portal_invoice_${RUN}`];
  try {
    // checkout.session.expired is the portal's no-effect path when there is no booking_id,
    // so these three leave nothing behind except the claim row this test looks for.
    const kind = sessionEvent({ id: ids[0], type: "checkout.session.expired", sessionId: `cs_dispatch_kind_${RUN}`, metadata: { kind: "membership" } });
    const bare = sessionEvent({ id: ids[1], type: "checkout.session.expired", sessionId: `cs_dispatch_bare_${RUN}`, metadata: {} });
    const invoice = JSON.stringify({ id: ids[2], type: "invoice.paid", data: { object: { id: `in_dispatch_${RUN}` } } });
    for (const body of [kind, bare, invoice]) {
      const res = await webhook(body, sign(body));
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(res.data, { received: true });
    }
    const rows = webhookEventRows(ids);
    assert.deepEqual(rows.map((r) => r.id).sort(), ids.slice().sort(), "the portal handler claimed all three events");
    assert.ok(rows.every((r) => r.status === "processed"));
  } finally {
    d1(`DELETE FROM webhook_events WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})`);
  }
});

test("E1-11: unknown metadata is answered 200 ignored, logged by event id with key names only, and nothing is claimed or written", async () => {
  const eventId = `evt_dispatch_unknown_${RUN}`;
  const body = sessionEvent({ id: eventId, sessionId: `cs_dispatch_unknown_${RUN}`, metadata: { order_ref: "A-1", customer_note: "secret value" } });
  const res = await webhook(body, sign(body));
  assert.equal(res.status, 200, "never a 400 for another product's event");
  assert.deepEqual(res.data, { received: true, ignored: true });
  assert.equal(webhookEventRows([eventId]).length, 0, "an ignored event is not claimed, so nothing is written");

  const logPath = process.env.PORTAL_TEST_SERVER_LOG;
  assert.ok(logPath, "PORTAL_TEST_SERVER_LOG must be set (scripts/test.sh sets it) so the log line can be read");
  let log = "";
  for (let i = 0; i < 20; i++) {
    log = fs.readFileSync(logPath, "utf8");
    if (log.includes(`stripe_webhook_ignored id=${eventId}`)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const line = log.split("\n").find((l) => l.includes(`stripe_webhook_ignored id=${eventId}`));
  assert.ok(line, "the dispatcher logs one stripe_webhook_ignored line per ignored event");
  assert.match(line, /type=checkout\.session\.completed/);
  assert.match(line, /keys=order_ref,customer_note/);
  assert.ok(!line.includes("secret value"), "metadata values are never logged");
});

test("E1-11: a bad signature is 400 for a Glow event and a portal event alike, and changes nothing", async () => {
  const created = await post("/api/glow/signup", { name: "Dispatch BadSig", phone: "000", role: "player", people: 1 }, { "CF-Connecting-IP": `198.51.100.${RUN % 200}` });
  const signupId = created.data.signup.id;
  try {
    const glowBody = sessionEvent({ id: `evt_dispatch_badsig_glow_${RUN}`, sessionId: `cs_badsig_${RUN}`, metadata: { signup_id: signupId } });
    const portalBody = sessionEvent({ id: `evt_dispatch_badsig_portal_${RUN}`, type: "checkout.session.expired", sessionId: `cs_badsig_p_${RUN}`, metadata: { kind: "pack" } });
    const wrong = `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`;
    for (const [body, header] of [[glowBody, wrong], [glowBody, undefined], [portalBody, wrong], [portalBody, sign(portalBody, Math.floor(Date.now() / 1000) - 400)]]) {
      const res = await webhook(body, header);
      assert.equal(res.status, 400, JSON.stringify(res.data));
      assert.equal(res.data.error, "bad_signature");
    }
    const row = (await glowSignups()).find((s) => s.id === signupId);
    assert.equal(row.status, "pay_at_event", "a refused event never marks a signup paid");
    assert.equal(webhookEventRows([`evt_dispatch_badsig_portal_${RUN}`]).length, 0);
  } finally {
    await deleteGlowSignup(signupId);
  }
});

test("E1-11: with STRIPE_WEBHOOK_SECRET unset the route is 503 and does nothing else", async () => {
  const body = sessionEvent({ id: `evt_dispatch_nosecret_${RUN}`, sessionId: "cs_nosecret", metadata: { signup_id: "x" } });
  const req = new Request("https://junglepickleball.com/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": sign(body) },
    body,
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.match(data.error, /STRIPE_WEBHOOK_SECRET/);
});
