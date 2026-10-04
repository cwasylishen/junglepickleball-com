// Glow in the Dark tournament signup: pure-logic probes against the real
// module (no wrangler dev, no network) with a tiny in-memory KV mock that
// mirrors the EVENTS namespace's get/put/delete shape.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  validGlowInput,
  createGlowSignup,
  getGlowSignups,
  deleteGlowSignup,
  handleGlowSignup,
  handleGlowList,
  computeGlowAmountCents,
  verifyStripeSignature,
  markGlowSignupPaid,
  handleGlowStripeWebhook,
} from "../../src/worker.js";

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

test("validGlowInput requires name, phone and a valid role", () => {
  assert.equal(validGlowInput({ name: "", phone: "1", role: "player" }), "Name is required.");
  assert.equal(validGlowInput({ name: "A", phone: "", role: "player" }), "A phone or WhatsApp number is required.");
  assert.equal(validGlowInput({ name: "A", phone: "1", role: "dancer" }), "Role must be player or spectator.");
  assert.equal(validGlowInput({ name: "A", phone: "1", role: "spectator" }), null);
});

test("createGlowSignup appends one row and defaults people to 1", async () => {
  const env = { EVENTS: makeKv() };
  const s = await createGlowSignup(env, { name: "Pat", phone: "8989", role: "player" });
  assert.equal(s.people, 1);
  assert.equal(s.spectatorMeal, false);
  const list = await getGlowSignups(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, s.id);
});

test("createGlowSignup ignores spectatorMeal for players, keeps it for spectators", async () => {
  const env = { EVENTS: makeKv() };
  const player = await createGlowSignup(env, { name: "P", phone: "1", role: "player", spectatorMeal: true });
  assert.equal(player.spectatorMeal, false);
  const spectator = await createGlowSignup(env, { name: "S", phone: "2", role: "spectator", spectatorMeal: true });
  assert.equal(spectator.spectatorMeal, true);
});

test("deleteGlowSignup removes exactly one row by id and is repeatable (run-it-twice)", async () => {
  const env = { EVENTS: makeKv() };
  const a = await createGlowSignup(env, { name: "A", phone: "1", role: "player" });
  await createGlowSignup(env, { name: "B", phone: "2", role: "spectator" });
  const first = await deleteGlowSignup(env, a.id);
  assert.equal(first, true);
  assert.equal((await getGlowSignups(env)).length, 1);
  // Running the same deletion again leaves the same state: no row to
  // remove, reports false, and the surviving row count is unchanged.
  const second = await deleteGlowSignup(env, a.id);
  assert.equal(second, false);
  assert.equal((await getGlowSignups(env)).length, 1);
});

test("handleGlowSignup honeypot returns a fake success and writes nothing", async () => {
  const env = { EVENTS: makeKv() };
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": "9.9.9.9", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bot", phone: "0", role: "player", website: "http://spam.example" }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal((await getGlowSignups(env)).length, 0);
});

test("handleGlowSignup rejects invalid input with a 400 and the specific reason", async () => {
  const env = { EVENTS: makeKv() };
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": "1.2.3.4", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", phone: "", role: "player" }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Name is required.");
});

test("handleGlowSignup rate-limits a connection after 5 attempts in the window", async () => {
  const env = { EVENTS: makeKv() };
  const ip = "5.5.5.5";
  for (let i = 0; i < 5; i++) {
    const req = new Request("https://x/api/glow/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `N${i}`, phone: "1", role: "player" }),
    });
    const res = await handleGlowSignup(req, env);
    assert.equal(res.status, 201);
  }
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Overflow", phone: "1", role: "player" }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 429);
});

test("handleGlowList requires the key and reports counts correctly", async () => {
  const env = { EVENTS: makeKv(), GLOW_LIST_KEY: "sekret" };
  await createGlowSignup(env, { name: "A", phone: "1", role: "player" });
  await createGlowSignup(env, { name: "B", phone: "2", role: "spectator", spectatorMeal: true, people: 2 });

  const denied = await handleGlowList(new Request("https://x/api/glow/list"), env, new URL("https://x/api/glow/list"));
  assert.equal(denied.status, 401);

  const url = new URL("https://x/api/glow/list?key=sekret");
  const ok = await handleGlowList(new Request(url), env, url);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.counts.players, 1);
  assert.equal(body.counts.spectators, 1);
  assert.equal(body.counts.spectatorMeals, 1);
  assert.equal(body.counts.totalPeople, 3);
});

test("handleGlowList 503s when GLOW_LIST_KEY is not configured yet", async () => {
  const env = { EVENTS: makeKv() };
  const url = new URL("https://x/api/glow/list?key=anything");
  const res = await handleGlowList(new Request(url), env, url);
  assert.equal(res.status, 503);
});

// ---------- Payment: amount calculation ----------

test("computeGlowAmountCents: $10 per player, $10 per spectator meal, free spectator", () => {
  assert.equal(computeGlowAmountCents({ role: "player", people: 1 }), 1000);
  assert.equal(computeGlowAmountCents({ role: "player", people: 3 }), 3000);
  assert.equal(computeGlowAmountCents({ role: "spectator", spectatorMeal: true, people: 1 }), 1000);
  assert.equal(computeGlowAmountCents({ role: "spectator", spectatorMeal: true, people: 2 }), 2000);
  assert.equal(computeGlowAmountCents({ role: "spectator", spectatorMeal: false, people: 1 }), 0);
});

// ---------- Payment: not-configured fallback ----------

test("createGlowSignup: owed amount with no STRIPE_SECRET_KEY stores pay_at_event, not a dead end", async () => {
  const env = { EVENTS: makeKv() };
  const s = await createGlowSignup(env, { name: "A", phone: "1", role: "player", people: 1 });
  assert.equal(s.status, "pay_at_event");
  assert.equal(s.amountCents, 1000);
});

test("createGlowSignup: owed amount with STRIPE_SECRET_KEY set stores pending_payment", async () => {
  const env = { EVENTS: makeKv(), STRIPE_SECRET_KEY: "sk_test_fake" };
  const s = await createGlowSignup(env, { name: "A", phone: "1", role: "player", people: 1 });
  assert.equal(s.status, "pending_payment");
});

test("createGlowSignup: nothing owed (spectator, no meal) is stored free regardless of Stripe config", async () => {
  const env = { EVENTS: makeKv(), STRIPE_SECRET_KEY: "sk_test_fake" };
  const s = await createGlowSignup(env, { name: "A", phone: "1", role: "spectator", spectatorMeal: false, people: 1 });
  assert.equal(s.status, "free");
  assert.equal(s.amountCents, 0);
});

test("handleGlowSignup: not configured, owed amount, thank-you says pay at the event", async () => {
  const env = { EVENTS: makeKv() };
  const req = new Request("https://x/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": "1.1.1.1", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Pat", phone: "1", role: "player", people: 1 }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.signup.status, "pay_at_event");
  assert.ok(/pay at the event/i.test(body.message));
  assert.equal(body.checkoutUrl, undefined);
});

// ---------- Webhook: Stripe's documented signing scheme ----------

const WEBHOOK_SECRET = "whsec_test_secret";

function signStripePayload(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return { header: `t=${timestamp},v1=${sig}`, timestamp, sig };
}

test("verifyStripeSignature accepts a correctly signed payload and rejects a tampered one", async () => {
  const payload = JSON.stringify({ hello: "world" });
  const { header } = signStripePayload(WEBHOOK_SECRET, payload);
  assert.equal(await verifyStripeSignature(payload, header, WEBHOOK_SECRET), true);
  assert.equal(await verifyStripeSignature(payload + "x", header, WEBHOOK_SECRET), false);
  assert.equal(await verifyStripeSignature(payload, header, "wrong_secret"), false);
  assert.equal(await verifyStripeSignature(payload, "", WEBHOOK_SECRET), false);
  assert.equal(await verifyStripeSignature(payload, "garbage", WEBHOOK_SECRET), false);
});

test("handleGlowStripeWebhook rejects a bad signature and never marks anything paid", async () => {
  const env = { EVENTS: makeKv(), STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const signup = await createGlowSignup(env, { name: "A", phone: "1", role: "player", people: 1 });
  const payload = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", amount_total: 1000, metadata: { signup_id: signup.id } } },
  });
  const req = new Request("https://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
    body: payload,
  });
  const res = await handleGlowStripeWebhook(req, env);
  assert.equal(res.status, 400);
  const list = await getGlowSignups(env);
  assert.notEqual(list.find((s) => s.id === signup.id).status, "paid");
});

test("handleGlowStripeWebhook accepts a correctly signed checkout.session.completed and marks the signup paid, idempotently", async () => {
  const env = { EVENTS: makeKv(), STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: "sk_test_fake" };
  const signup = await createGlowSignup(env, { name: "A", phone: "1", role: "player", people: 1 });
  assert.equal(signup.status, "pending_payment");

  const payload = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", amount_total: 1000, metadata: { signup_id: signup.id } } },
  });
  const { header } = signStripePayload(WEBHOOK_SECRET, payload);
  const req = () => new Request("https://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": header },
    body: payload,
  });

  const res1 = await handleGlowStripeWebhook(req(), env);
  assert.equal(res1.status, 200);
  let list = await getGlowSignups(env);
  assert.equal(list.find((s) => s.id === signup.id).status, "paid");
  assert.equal(list.find((s) => s.id === signup.id).amountCents, 1000);

  // Run-it-twice: a Stripe retry delivery of the same event changes nothing.
  const res2 = await handleGlowStripeWebhook(req(), env);
  assert.equal(res2.status, 200);
  const listAgain = await getGlowSignups(env);
  assert.deepEqual(listAgain, list);
});

test("handleGlowStripeWebhook 503s when STRIPE_WEBHOOK_SECRET is not configured", async () => {
  const env = { EVENTS: makeKv() };
  const req = new Request("https://x/api/stripe/webhook", { method: "POST", body: "{}" });
  const res = await handleGlowStripeWebhook(req, env);
  assert.equal(res.status, 503);
});

// ---------- Checkout: Stripe configured, mocked (no real Stripe account) ----------

test("handleGlowSignup: Stripe configured creates a Checkout Session and returns checkoutUrl, never calling a real Stripe account", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      json: async () => ({ id: "cs_test_mock", url: "https://checkout.stripe.com/test/cs_test_mock" }),
    };
  };

  const env = { EVENTS: makeKv(), STRIPE_SECRET_KEY: "sk_test_fake" };
  const req = new Request("https://junglepickleball.com/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": "2.2.2.2", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Pat", phone: "1", role: "player", people: 1 }),
  });
  const res = await handleGlowSignup(req, env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.checkoutUrl, "https://checkout.stripe.com/test/cs_test_mock");
  assert.equal(body.signup.status, "pending_payment");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/checkout\/sessions$/);
  assert.match(calls[0].init.body, /metadata%5Bsignup_id%5D=/);

  const list = await getGlowSignups(env);
  assert.equal(list[0].stripeSessionId, "cs_test_mock");
});

// ---------- List totals ----------

test("handleGlowList totals paid count/$, pending payment and pay-at-event counts", async () => {
  const env = { EVENTS: makeKv(), GLOW_LIST_KEY: "sekret", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const paidSignup = await createGlowSignup(env, { name: "Paid", phone: "1", role: "player", people: 1 });
  await markGlowSignupPaid(env, paidSignup.id, 1000, "cs_test_paid");
  await createGlowSignup(env, { name: "AtEvent", phone: "2", role: "player", people: 1 }); // no STRIPE_SECRET_KEY -> pay_at_event
  await createGlowSignup(env, { ...{ name: "Free", phone: "3", role: "spectator", spectatorMeal: false, people: 1 } });

  const url = new URL("https://x/api/glow/list?key=sekret");
  const res = await handleGlowList(new Request(url), env, url);
  const body = await res.json();
  assert.equal(body.counts.paid, 1);
  assert.equal(body.counts.paidCents, 1000);
  assert.equal(body.counts.payAtEvent, 1);
  assert.equal(body.counts.pendingPayment, 0);
});
