// Owned by B2a1 (amendment 5 build cut, B1-fix amendment 6). The
// booking-engine routes from docs/portal/api.md §3 (resources,
// availability, quote, bookings create/cancel/list) -- this file alone,
// never src/portal/router.js, which only imports and concatenates this
// array. Same entry shape as router.js's own B1_ROUTES.

import { listResources, availability, quote, createBooking, cancelBooking, listMyBookings } from "../booking.js";

export const ROUTES = [
  { method: "GET", path: "/api/portal/resources", class: "own", handler: (ctx) => listResources(ctx.request, ctx.env, ctx.db) },
  {
    method: "GET",
    path: "/api/portal/resources/:id/availability",
    class: "own",
    handler: (ctx) => availability(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account, ctx.params),
  },
  {
    method: "GET",
    path: "/api/portal/resources/:id/quote",
    class: "own",
    handler: (ctx) => quote(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account, ctx.params),
  },
  {
    method: "POST",
    path: "/api/portal/bookings",
    class: "own",
    handler: (ctx) => createBooking(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account),
  },
  {
    method: "POST",
    path: "/api/portal/bookings/:id/cancel",
    class: "own",
    handler: (ctx) => cancelBooking(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account, ctx.params),
  },
  {
    method: "GET",
    path: "/api/portal/bookings",
    class: "own",
    handler: (ctx) => listMyBookings(ctx.request, ctx.env, ctx.db, ctx.url, ctx.session, ctx.account),
  },
];
