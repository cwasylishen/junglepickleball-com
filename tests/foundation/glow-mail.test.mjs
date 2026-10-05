// Glow signup and paid emails (owner's order, 2026-10-05: Roger expected Glow
// emails and got none). Pure-logic probes against the real module: an
// in-memory KV for EVENTS and a recording stand-in for the WARD_MAIL service
// binding. No network, no wrangler dev, no Stripe call, no real mail.
//
// Webhook cases go through the Worker's own fetch() on /api/stripe/webhook,
// which is the shared dispatcher (handleStripeWebhook, the route Stripe really
// calls). The dispatcher is not exported, but default.fetch reaches it with no
// portal binding for this path. One case also drives handleGlowStripeWebhook,
// the older Glow-only entry, because both end in applyGlowStripeEvent.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, {
  createGlowSignup,
  getGlowSignups,
  handleGlowSignup,
  handleGlowStripeWebhook,
} from "../../src/worker.js";

const CLINTON = "cwasylishen@gmail.com";
const ROGER = "rogerworsham.cr@gmail.com";
const WEBHOOK_SECRET = "whsec_test_secret";
const SEND_SECRET = "send-secret-for-tests";

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

// Records every /send POST. `behaviour(to)` returns "ok", "500" or "throw".
function makeWardMail(behaviour = () => "ok") {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), method: init.method, headers: init.headers, body });
      const what = behaviour(body.to);
      if (what === "throw") throw new Error(`ward-mail unreachable for ${body.to}`);
      if (what === "500") return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    },
  };
}

function mailEnv(wardMail, extra = {}) {
  return { EVENTS: makeKv(), WARD_MAIL: wardMail, WARD_SEND_SECRET: SEND_SECRET, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...extra };
}

function signupRequest(body, ip = "9.9.9.9") {
  return new Request("https://junglepickleball.com/api/glow/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sign(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function completedEvent(signupId, { sessionId = "cs_test_paid_1", amountTotal = 4000, eventId = "evt_1" } = {}) {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: { object: { id: sessionId, amount_total: amountTotal, metadata: { signup_id: signupId } } },
  });
}

function webhookRequest(payload, header = sign(payload)) {
  return new Request("https://junglepickleball.com/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": header },
    body: payload,
  });
}

const dispatch = (payload, env, header) => worker.fetch(webhookRequest(payload, header), env);

// A fixed row, so two runs of the same scenario can be compared byte for byte.
function seedPendingRow(env, overrides = {}) {
  const row = {
    id: "signup_fixed_1", name: "Pat Example", phone: "555", email: "", member: false,
    role: "player", spectatorMeal: false, partnerName: "Sam Partner", people: 2, notes: "",
    amountCents: 4000, currency: "usd", status: "pending_payment", stripeSessionId: "cs_test_paid_1",
    createdAt: "2026-10-05T00:00:00.000Z", ...overrides,
  };
  env.EVENTS.store.set("glow_signups", JSON.stringify([row]));
  return row;
}

// ---------- 1. both recipients on a signup ----------

test("a signup sends one ward-mail /send POST to each of the two recipients, each with a single-string `to`", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  const res = await handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }), env);
  assert.equal(res.status, 201);
  assert.equal(wm.calls.length, 2);
  assert.deepEqual(wm.calls.map((c) => c.body.to), [CLINTON, ROGER]);
  for (const c of wm.calls) {
    assert.equal(typeof c.body.to, "string");
    assert.equal(c.url, "https://ward-mail/send");
    assert.equal(c.method, "POST");
    assert.equal(c.headers["x-ward-secret"], SEND_SECRET);
    assert.equal(c.body.from, "ward@wizardweb.ca");
    assert.equal(c.body.subject, "Glow Tournament signup: Pat");
  }
  const body = await res.json();
  assert.equal(body.mail.sent, true);
});

test("one recipient's failure (500 or a throw) does not stop the other's send, and the signup result says who failed", async () => {
  for (const failure of ["500", "throw"]) {
    for (const failing of [CLINTON, ROGER]) {
      const wm = makeWardMail((to) => (to === failing ? failure : "ok"));
      const env = mailEnv(wm);
      const res = await handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }, `8.8.8.${failure.length}`), env);
      assert.equal(res.status, 201, `${failure} for ${failing}`);
      assert.equal(wm.calls.length, 2, `both attempted when ${failing} gets ${failure}`);
      const { mail } = await res.json();
      assert.equal(mail.sent, false);
      const byTo = Object.fromEntries(mail.recipients.map((r) => [r.to, r]));
      assert.equal(byTo[failing].sent, false);
      assert.match(byTo[failing].reason, failure === "500" ? /500/ : /unreachable/);
      const other = failing === CLINTON ? ROGER : CLINTON;
      assert.equal(byTo[other].sent, true);
    }
  }
});

// ---------- 2. the three status labels ----------

test("signup email status line: pay_at_event -> 'Pay at the event'", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm); // no STRIPE_SECRET_KEY, so an owing signup is pay_at_event
  await handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }), env);
  assert.equal(wm.calls.length, 2);
  for (const c of wm.calls) {
    assert.match(c.body.text, /^Payment status: Pay at the event$/m);
    assert.equal(c.body.subject, "Glow Tournament signup: Pat");
  }
});

test("signup email status line: free -> 'Free'", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  await handleGlowSignup(signupRequest({ name: "Sue", phone: "1", role: "spectator", spectatorMeal: false }), env);
  assert.equal(wm.calls.length, 2);
  for (const c of wm.calls) {
    assert.match(c.body.text, /^Payment status: Free$/m);
    assert.equal(c.body.subject, "Glow Tournament signup: Sue");
  }
});

test("signup email status line: pending_payment -> 'Not paid yet (sent to Stripe checkout)'", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // The only Stripe traffic is this local stub; no real account is called.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: "cs_test_mock", url: "https://checkout.stripe.com/test/cs_test_mock" }) });
  const wm = makeWardMail();
  const env = mailEnv(wm, { STRIPE_SECRET_KEY: "sk_test_fake" });
  const res = await handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }), env);
  assert.equal(res.status, 201);
  assert.equal(wm.calls.length, 2);
  for (const c of wm.calls) {
    assert.match(c.body.text, /^Payment status: Not paid yet \(sent to Stripe checkout\)$/m);
    assert.equal(c.body.subject, "Glow Tournament signup: Pat");
  }
});

// ---------- 3. the paid email, once ----------

test("first checkout.session.completed sends exactly one PAID email per recipient with subject and the five body fields", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env);
  const res = await dispatch(completedEvent("signup_fixed_1", { amountTotal: 4000 }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  assert.equal(wm.calls.length, 2);
  assert.deepEqual(wm.calls.map((c) => c.body.to).sort(), [CLINTON, ROGER].sort());
  for (const c of wm.calls) {
    assert.equal(typeof c.body.to, "string");
    assert.equal(c.body.from, "ward@wizardweb.ca");
    assert.equal(c.headers["x-ward-secret"], SEND_SECRET);
    assert.equal(c.body.subject, "PAID: Glow Tournament - Pat Example, $40.00 USD");
    assert.match(c.body.text, /^Name: Pat Example$/m);
    assert.match(c.body.text, /^People: 2$/m);
    assert.match(c.body.text, /^Partner: Sam Partner$/m);
    assert.match(c.body.text, /^Amount: \$40\.00 USD$/m);
    assert.match(c.body.text, /^Stripe session: cs_test_paid_1$/m);
  }
});

test("paid email: empty partner reads '(none)' and the amount is cents/100 to two decimals", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env, { partnerName: "", people: 1 });
  await dispatch(completedEvent("signup_fixed_1", { amountTotal: 2050 }), env);
  assert.equal(wm.calls.length, 2);
  for (const c of wm.calls) {
    assert.equal(c.body.subject, "PAID: Glow Tournament - Pat Example, $20.50 USD");
    assert.match(c.body.text, /^Partner: \(none\)$/m);
    assert.match(c.body.text, /^Amount: \$20\.50 USD$/m);
  }
});

test("the same paid event delivered again (Stripe retry) sends no further email", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env);
  const payload = completedEvent("signup_fixed_1");
  assert.equal((await dispatch(payload, env)).status, 200);
  assert.equal(wm.calls.length, 2);
  assert.equal((await dispatch(payload, env)).status, 200);
  assert.equal((await dispatch(payload, env)).status, 200);
  assert.equal(wm.calls.length, 2, "no email beyond the first delivery's two");
});

test("an event for an already-paid row with a different session id sends no email", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env, { status: "paid", stripeSessionId: "cs_test_first" });
  const res = await dispatch(completedEvent("signup_fixed_1", { sessionId: "cs_test_second", eventId: "evt_2" }), env);
  assert.equal(res.status, 200);
  assert.equal(wm.calls.length, 0);
  assert.equal((await getGlowSignups(env))[0].status, "paid");
});

test("an unknown signup id answers 404 and sends no email", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env);
  const res = await dispatch(completedEvent("signup_does_not_exist"), env);
  assert.equal(res.status, 404);
  assert.equal(wm.calls.length, 0);
});

test("a bad signature answers 400, sends no email and leaves the row unpaid (dispatcher path)", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env);
  const before = env.EVENTS.store.get("glow_signups");
  const res = await dispatch(completedEvent("signup_fixed_1"), env, "t=1,v1=deadbeef");
  assert.equal(res.status, 400);
  assert.equal(wm.calls.length, 0);
  assert.equal(env.EVENTS.store.get("glow_signups"), before);
});

test("handleGlowStripeWebhook (Glow-only entry): first event mails once per recipient, a bad signature mails nobody", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm);
  seedPendingRow(env);
  const payload = completedEvent("signup_fixed_1");
  const bad = await handleGlowStripeWebhook(webhookRequest(payload, "t=1,v1=deadbeef"), env);
  assert.equal(bad.status, 400);
  assert.equal(wm.calls.length, 0);
  const good = await handleGlowStripeWebhook(webhookRequest(payload), env);
  assert.equal(good.status, 200);
  assert.equal(wm.calls.length, 2);
  assert.equal((await handleGlowStripeWebhook(webhookRequest(payload), env)).status, 200);
  assert.equal(wm.calls.length, 2);
});

// ---------- 4. mail failure never changes the webhook answer or the KV write ----------

test("WARD_MAIL throwing, answering 500, or absent leaves the webhook response and KV row identical to the mail-ok case", async () => {
  async function run(wardMail, extraEnv = {}) {
    const env = mailEnv(wardMail, extraEnv);
    seedPendingRow(env);
    const res = await dispatch(completedEvent("signup_fixed_1"), env);
    return { status: res.status, body: await res.text(), kv: env.EVENTS.store.get("glow_signups") };
  }
  const ok = await run(makeWardMail());
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.kv)[0].status, "paid");

  const wmThrow = makeWardMail(() => "throw");
  const thrown = await run(wmThrow);
  assert.equal(wmThrow.calls.length, 2, "both recipients still attempted when each throws");
  assert.deepEqual(thrown, ok);

  const wm500 = makeWardMail(() => "500");
  const failed = await run(wm500);
  assert.equal(wm500.calls.length, 2);
  assert.deepEqual(failed, ok);

  const unconfigured = await run(undefined, { WARD_MAIL: undefined });
  assert.deepEqual(unconfigured, ok);
});

test("a paid event for a row created through createGlowSignup also mails once (end to end, no seeded row)", async () => {
  const wm = makeWardMail();
  const env = mailEnv(wm, { STRIPE_SECRET_KEY: "sk_test_fake" });
  const signup = await createGlowSignup(env, { name: "Lee", phone: "1", role: "player", people: 1 });
  const res = await dispatch(completedEvent(signup.id, { amountTotal: 2000 }), env);
  assert.equal(res.status, 200);
  assert.equal(wm.calls.length, 2);
  assert.equal(wm.calls[0].body.subject, "PAID: Glow Tournament - Lee, $20.00 USD");
});

// ---------- 5. PIN-TIMEOUT: each ward-mail /send call is bounded ----------
//
// env.GLOW_MAIL_TIMEOUT_MS shortens the bound (default 5000) so these run in
// milliseconds. `within` is the test's own guard: on code with no bound a
// hanging fetch never settles, and the test must fail, not hang.

const SHORT_BOUND_MS = 40;

// A WARD_MAIL whose fetch never resolves for the listed recipients.
function makeHangingWardMail(hangFor) {
  const calls = [];
  return {
    calls,
    fetch(url, init) {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      if (hangFor.includes(body.to)) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200 });
    },
  };
}

async function within(ms, promise, what) {
  let guard;
  const expired = new Promise((_, reject) => {
    guard = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms (no bound on the mail call)`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(guard);
  }
}

async function paidRun(wardMail, extraEnv = {}) {
  const env = mailEnv(wardMail, extraEnv);
  seedPendingRow(env);
  const started = Date.now();
  const res = await within(1000, dispatch(completedEvent("signup_fixed_1"), env), "the paid webhook");
  return { status: res.status, body: await res.text(), kv: env.EVENTS.store.get("glow_signups"), ms: Date.now() - started };
}

test("a WARD_MAIL fetch that never resolves: same webhook response and KV row as mail ok, within the bound, other recipient still sent", async () => {
  const ok = await paidRun(makeWardMail());
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.kv)[0].status, "paid");

  // Clinton's send hangs; Roger's must still go out.
  const hangOne = makeHangingWardMail([CLINTON]);
  const one = await paidRun(hangOne, { GLOW_MAIL_TIMEOUT_MS: SHORT_BOUND_MS });
  assert.deepEqual({ status: one.status, body: one.body, kv: one.kv }, { status: ok.status, body: ok.body, kv: ok.kv });
  assert.deepEqual(hangOne.calls.map((c) => c.body.to).sort(), [CLINTON, ROGER].sort(), "both attempted");
  assert.ok(one.ms < 500, `answered in ${one.ms} ms`);

  // Both hang: still the same answer, and still bounded by ONE timeout (not one per address).
  const hangBoth = makeHangingWardMail([CLINTON, ROGER]);
  const both = await paidRun(hangBoth, { GLOW_MAIL_TIMEOUT_MS: SHORT_BOUND_MS });
  assert.deepEqual({ status: both.status, body: both.body, kv: both.kv }, { status: ok.status, body: ok.body, kv: ok.kv });
  assert.equal(hangBoth.calls.length, 2);
  assert.ok(both.ms < 500, `answered in ${both.ms} ms`);
});

test("a timed-out send is reported like any failed send: that address, sent false, a reason naming the bound; the other address is sent", async () => {
  for (const hanging of [CLINTON, ROGER]) {
    const wm = makeHangingWardMail([hanging]);
    const env = mailEnv(wm, { GLOW_MAIL_TIMEOUT_MS: SHORT_BOUND_MS });
    const res = await within(1000, handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }, `7.7.7.${hanging.length}`), env), "the signup");
    assert.equal(res.status, 201);
    const { mail } = await res.json();
    assert.equal(mail.sent, false);
    const byTo = Object.fromEntries(mail.recipients.map((r) => [r.to, r]));
    assert.equal(byTo[hanging].sent, false);
    assert.match(byTo[hanging].reason, new RegExp(`within ${SHORT_BOUND_MS} ms`));
    const other = hanging === CLINTON ? ROGER : CLINTON;
    assert.equal(byTo[other].sent, true);
    assert.equal(wm.calls.length, 2);
  }
});

test("without GLOW_MAIL_TIMEOUT_MS the bound is 5000 ms, and a bad override falls back to it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const override of [undefined, "", "abc", "0", "-5"]) {
    const wm = makeHangingWardMail([CLINTON, ROGER]);
    const env = mailEnv(wm, override === undefined ? {} : { GLOW_MAIL_TIMEOUT_MS: override });
    let settled = false;
    const pending = handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }, "6.6.6.6"), env).then((r) => { settled = true; return r; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    t.mock.timers.tick(4999);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(settled, false, `still waiting at 4999 ms (override ${JSON.stringify(override)})`);
    t.mock.timers.tick(1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(settled, true, `answered at 5000 ms (override ${JSON.stringify(override)})`);
    assert.equal((await pending).status, 201);
  }
});

test("a quick mail answer clears its timer: every timer the mail path starts is cleared", async (t) => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  globalThis.setTimeout = (...args) => { const id = realSet(...args); live.add(id); return id; };
  globalThis.clearTimeout = (id) => { live.delete(id); return realClear(id); };
  const wm = makeWardMail();
  const res = await handleGlowSignup(signupRequest({ name: "Pat", phone: "1", role: "player", people: 1 }, "5.5.5.5"), mailEnv(wm));
  assert.equal(res.status, 201);
  assert.equal(wm.calls.length, 2);
  assert.equal(live.size, 0, "no timer left running after the sends answered");
});
