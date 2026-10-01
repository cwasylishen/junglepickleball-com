// Interface stubs for B2a1 (amendment 6). B1 commits this module with
// the exact export signatures below as working, non-throwing stubs so
// every other part's import resolves and `npm test` stays green while
// B2a1 writes the real bodies. From here on this file belongs to B2a1 --
// it replaces each stub outright with the real booking engine
// (docs/portal/api.md §3): availability, holds (D-A06/amendment 5 F-4),
// create/cancel, and the single credit function (CTL-CRD-01).

// No-op stub: does not look up or touch any row. B2a1's real body
// writes the calendar outbox row in the same batch and returns
// "paid_conflict" / "already_confirmed" per docs/portal/api.md §3.
export async function confirmPaidBooking(env, bookingId, { paymentIntentId, sessionId } = {}) {
  return { status: "confirmed" };
}

// No-op stub: releases nothing. Used for checkout.session.expired.
export async function releaseHold(env, bookingId, reason) {
  return { released: false };
}

// No-op stub: adds no credits, reports no balance change. B2a1's real
// body is the single credit function (CTL-CRD-01), idempotent on `ref`.
export async function addCredits(env, accountId, n, { source, ref } = {}) {
  return { balance: 0 };
}
