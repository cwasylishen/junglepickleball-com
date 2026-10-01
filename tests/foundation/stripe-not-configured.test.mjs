// S-11/PIN-11, acceptance scenario 4 (B2b dispatch): with STRIPE_SECRET_KEY
// unset -- exactly how scripts/test.sh runs this whole suite -- every
// Stripe-API-calling route returns 503 not_configured and changes
// nothing. The webhook gates on STRIPE_WEBHOOK_SECRET instead (A1); its
// own probes live in stripe-webhook.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient, loginDemo, d1, BASE_URL } from "./helpers.mjs";

const MASSAGE_60_OFFERING_ID = "demo-off-00000-0000-000000000005"; // seed-preview.sql

test("not_configured: POST billing/checkout changes nothing", async () => {
  const { client, csrfToken } = await loginDemo("member.demo@jp-demo.test");
  const before = d1(`SELECT COUNT(*) AS n FROM payments_mirror`)[0].n;
  const res = await client.post("/api/portal/billing/checkout", { lookup_key: "jp_1m_single" }, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
  assert.equal(res.status, 503);
  assert.deepEqual(res.data, { error: "not_configured", feature: "stripe" });
  const after = d1(`SELECT COUNT(*) AS n FROM payments_mirror`)[0].n;
  assert.equal(after, before);
});

test("not_configured: POST billing/portal-session changes nothing", async () => {
  const { client, csrfToken } = await loginDemo("member.demo@jp-demo.test");
  const res = await client.post("/api/portal/billing/portal-session", {}, { "X-CSRF-Token": csrfToken, Origin: BASE_URL });
  assert.equal(res.status, 503);
  assert.deepEqual(res.data, { error: "not_configured", feature: "stripe" });
});

test("not_configured: GET billing/history changes nothing (and needs no CSRF -- it is a GET)", async () => {
  const { client } = await loginDemo("member.demo@jp-demo.test");
  const res = await client.get("/api/portal/billing/history");
  assert.equal(res.status, 503);
  assert.deepEqual(res.data, { error: "not_configured", feature: "stripe" });
});

test("not_configured: owner offering price edit changes nothing -- the display mirror is untouched", async () => {
  const before = d1(`SELECT display_price_cents FROM offerings WHERE id = '${MASSAGE_60_OFFERING_ID}'`)[0].display_price_cents;
  const { client, csrfToken } = await loginDemo("owner.demo@jp-demo.test");
  const res = await client.post(
    `/api/portal/owner/resources/demo-msg-00000-0000-000000000005/offerings/${MASSAGE_60_OFFERING_ID}/price`,
    { price_cents: 6000 },
    { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
  );
  assert.equal(res.status, 503);
  assert.deepEqual(res.data, { error: "not_configured", feature: "stripe" });
  const after = d1(`SELECT display_price_cents FROM offerings WHERE id = '${MASSAGE_60_OFFERING_ID}'`)[0].display_price_cents;
  assert.equal(after, before, "a 503 must change nothing -- the mirror stays at its seeded value");
});

test("not_configured: a non-owner cannot reach the price-edit route regardless of Stripe config (route class, not this part's job to re-prove, but must not be weaker than not_configured)", async () => {
  const { client, csrfToken } = await loginDemo("member.demo@jp-demo.test");
  const res = await client.post(
    `/api/portal/owner/resources/demo-msg-00000-0000-000000000005/offerings/${MASSAGE_60_OFFERING_ID}/price`,
    { price_cents: 6000 },
    { "X-CSRF-Token": csrfToken, Origin: BASE_URL }
  );
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "owner_only");
});
