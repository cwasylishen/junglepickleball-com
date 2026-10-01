// Owned by B2b (amendment 5 build cut, B1-fix amendment 6). Add the
// Stripe routes from docs/portal/api.md §5 here (billing checkout,
// portal-session, history, offering price) -- this file alone, never
// src/portal/router.js, which only imports and concatenates this array.
// Same entry shape as router.js's own B1_ROUTES. (POST /api/stripe/webhook
// is dispatched separately, outside this table -- see router.js and
// src/portal/stripe.js.)

export const ROUTES = [];
