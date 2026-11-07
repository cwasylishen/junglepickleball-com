// Pin L4: with STRIPE_SECRET_KEY unset (the state of this harness and of
// production at launch) nothing renders a button that fails. A paid booking
// is recorded confirmed and unpaid, "pay at the club", with the amount
// shown. Membership purchase reads "Payments are not switched on yet" and
// how to join at the club. No 5xx on any of these paths.
//
// Billing and History keep their built not-configured state; that is
// covered by not-configured.test.mjs and stripe-not-configured.test.mjs.
//
// Black-box HTTP against the local server from scripts/test.sh, which never
// sets STRIPE_SECRET_KEY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, loginDemo, BASE_URL } from "./helpers.mjs";
import { crDateAt } from "../qa-helpers.mjs";

const GUEST_EMAIL = "guest.demo@jp-demo.test";
const GUEST_ID = "demo-guest-0000-0000-000000000005";
const COURT_3 = "demo-court-0000-0000-000000000003";
const PLUNGE = "demo-plng-00000-0000-000000000006";
const EM_DASH = "—";

async function guestSession() {
  d1(`DELETE FROM rate_limits`);
  const guest = await loginDemo(GUEST_EMAIL);
  // Other files leave credits on this seeded account; with credits a court
  // booking would use them, which is not the path under test.
  d1(`INSERT OR REPLACE INTO credits (account_id, balance, updated_at) VALUES ('${GUEST_ID}', 0, datetime('now'))`);
  return guest;
}

const csrf = (s) => ({ "X-CSRF-Token": s.csrfToken, Origin: BASE_URL });

function removeBooking(id) {
  d1(`DELETE FROM calendar_outbox WHERE booking_id = '${id}'; DELETE FROM bookings WHERE id = '${id}'`);
}

test("L4 /membership: the page says payments are not switched on, and every buy button is hidden", async () => {
  const res = await fetch(`${BASE_URL}/membership`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Payments are not switched on yet/);
  assert.match(html, /come by the club/i);
  assert.match(html, /wa\.me\/50689893111/, "how to join: Roger's WhatsApp");
  const buttons = html.match(/<button[^>]*onclick="(joinTier|buyPass)\([^"]*"[^>]*>/g) || [];
  assert.equal(buttons.length, 9, "7 membership tiers plus 2 passes");
  for (const tag of buttons) {
    assert.match(tag, /\bhidden\b/, `a buy button must start hidden: ${tag}`);
    assert.match(tag, /data-pay-on/);
  }
  assert.ok(!html.includes(EM_DASH) || !visibleText(html).includes(EM_DASH), "no em dash in the page copy");
});

function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&mdash;/g, EM_DASH);
}

test("L4 /membership: the success, cancel and sign-in pages carry no em dash and answer 200", async () => {
  for (const path of ["/membership-success", "/membership-cancel", "/membership"]) {
    const res = await fetch(`${BASE_URL}${path}`);
    assert.equal(res.status, 200, path);
    assert.ok(!visibleText(await res.text()).includes(EM_DASH), `${path}: no em dash in visible copy`);
  }
});

test("L4 /api/checkout: GET is the payments flag (off), and a POST that arrives anyway is a 200 with the message, never a 5xx", async () => {
  const flag = await fetch(`${BASE_URL}/api/checkout`);
  assert.equal(flag.status, 200);
  assert.deepEqual(await flag.json(), { enabled: false });

  for (const lookupKey of ["jp_1m_single", "jp_session_pack8", "no_such_key"]) {
    const res = await fetch(`${BASE_URL}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupKey }),
    });
    assert.ok(res.status < 500, `${lookupKey}: got ${res.status}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, false);
    assert.equal(data.url, undefined, "no Stripe URL when payments are off");
    assert.match(data.message, /Payments are not switched on yet/);
    assert.ok(!data.message.includes(EM_DASH));
  }
});

test("L4 booking: a paid court booking is recorded confirmed and unpaid, with the amount, and no Stripe call or hold", async () => {
  const guest = await guestSession();
  // Three days out, so the cancel at the end is outside the 24 h cutoff (PIN L3) whatever the time of day.
  const start = crDateAt(3, 14, 30); // 14:30 CR, on Court 3's 90-minute grid
  const quote = await guest.client.get(`/api/portal/resources/${COURT_3}/quote?start=${encodeURIComponent(start)}&party_size=2`);
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.pay_at_club, true);
  assert.equal(quote.data.total_cents, 3000, "2 players at $15 each");

  const res = await guest.client.post("/api/portal/bookings", { resource_id: COURT_3, start, party_size: 2, payment_choice: "card" }, csrf(guest));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const booking = res.data.booking;
  try {
    assert.equal(booking.status, "confirmed");
    assert.equal(booking.payment_mode, "pay");
    assert.equal(booking.pay_at_club, true);
    assert.equal(booking.amount_cents, 3000);
    assert.equal(booking.checkout_url, undefined, "no checkout when payments are off");

    const row = d1(`SELECT status, payment_mode, hold_expires_at, checkout_session_id, payment_intent_id FROM bookings WHERE id = '${booking.id}'`)[0];
    assert.deepEqual(row, { status: "confirmed", payment_mode: "pay", hold_expires_at: null, checkout_session_id: null, payment_intent_id: null });
    const outbox = d1(`SELECT COUNT(*) AS n FROM calendar_outbox WHERE booking_id = '${booking.id}'`)[0].n;
    assert.equal(outbox, 1, "a confirmed booking queues its calendar event like any other");

    const list = await guest.client.get("/api/portal/bookings");
    assert.equal(list.status, 200);
    const listed = list.data.find((b) => b.id === booking.id);
    assert.equal(listed.pay_at_club, true);
    assert.equal(listed.amount_cents, 3000);

    // Run it twice: the same slot cannot be booked again, and says so with a 409, not a 5xx.
    const again = await guest.client.post("/api/portal/bookings", { resource_id: COURT_3, start, party_size: 2, payment_choice: "card" }, csrf(guest));
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "slot_taken");

    // Cancelling an unpaid booking owes no refund.
    const cancel = await guest.client.post(`/api/portal/bookings/${booking.id}/cancel`, {}, csrf(guest));
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
    assert.equal(d1(`SELECT refund_state FROM bookings WHERE id = '${booking.id}'`)[0].refund_state, "none");
  } finally {
    removeBooking(booking.id);
  }
});

test("L4 booking: a non-member cold plunge booking is recorded the same way, at the guest price", async () => {
  const guest = await guestSession();
  const start = crDateAt(2, 10, 20); // the day after tomorrow 10:20 CR: on the plunge's 20-minute grid, over 24 h ahead
  const res = await guest.client.post("/api/portal/bookings", { resource_id: PLUNGE, offering_id: "demo-off-00000-0000-000000000009", start, party_size: 1 }, csrf(guest));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const booking = res.data.booking;
  try {
    assert.equal(booking.status, "confirmed");
    assert.equal(booking.pay_at_club, true);
    assert.equal(booking.amount_cents, 1500, "per booking, not per player");
    assert.equal(booking.checkout_url, undefined);
  } finally {
    removeBooking(booking.id);
  }
});

test("L4: the member booking screen and bookings list carry the pay-at-club wording, and no em dash", async () => {
  for (const path of ["/portal/js/member.js", "/portal/views/member-book.html", "/portal/views/member-bookings.html"]) {
    const res = await fetch(`${BASE_URL}${path}`);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.ok(!text.includes(EM_DASH), `${path}: no em dash`);
    if (path.endsWith("member.js")) {
      assert.match(text, /"book\.pay_at_club": "Pay at the club: \{amount\}"/);
      assert.match(text, /"book\.confirm_pay_club": "Book now, pay at the club"/);
      assert.ok(!text.includes("needsStripeAndOff"), "the dead-end 'not switched on' booking block is gone");
    }
  }
});

test("L4: no 5xx on any payments-off path", async () => {
  for (const path of ["/membership", "/membership-success", "/membership-cancel", "/api/checkout", "/portal/", "/api/portal/me"]) {
    const res = await fetch(`${BASE_URL}${path}`);
    assert.ok(res.status < 500, `${path}: ${res.status}`);
  }
});
