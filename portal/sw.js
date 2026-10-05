// Portal service worker (B2e). Scope `/portal/` (set by the registration
// call in portal/js/pwa.js, not here).
//
// CTL-PWA-01 (the control this file exists to prove): the fetch handler
// below never calls respondWith for a non-GET request, an `/api/`
// request, or a navigation. Those pass straight to the network, so no
// account data -- a booking list, a session, anything personal -- can
// ever enter Cache Storage. Only a fixed list of this script's own
// static assets is cached.
//
// CTL-PWA-02: BUILD_ID is bumped by hand on every portal release. The
// cache name carries it, so activate() below deletes every cache from a
// previous build and claims open clients -- a device that already has
// the service worker installed picks up the new one on next load
// instead of serving stale assets forever.
const BUILD_ID = "2026-10-05.2";
const CACHE_NAME = `portal-static-${BUILD_ID}`;

// Deliberately small and named, not a crawl of the portal: everything
// here is this file's own static, account-free asset (REQ-PWA-02/03).
const PRECACHE_URLS = [
  "/portal/manifest.webmanifest",
  "/portal/icon-192.png",
  "/portal/icon-512.png",
  "/portal/vendor/alpine-3.14.9.min.js",
  "/portal/portal.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// CTL-PWA-01. Each early return below leaves the request completely
// unhandled by this service worker -- the browser serves it exactly as
// if no service worker were registered at all.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return; // never cache a write
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return; // REQ-PWA-03: no API response ever cached
  if (request.mode === "navigate") return; // no HTML page is cached either

  if (!PRECACHE_URLS.includes(url.pathname)) return; // only the named static list

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});

// R-3/Q2: a push payload may arrive with no event.data (RFC 8030), but
// this portal always sends one (CTL-PSH-01's fixed payload). Either
// way, showNotification is always called inside waitUntil -- iOS Safari
// revokes the permission the first time a push shows nothing.
self.addEventListener("push", (event) => {
  let payload = { title: "Jungle Pickleball", body: "You have a booking coming up. Open the app for details.", booking_id: null, kind: null };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // Not JSON: keep the fixed fallback strings above rather than
      // showing a notification with no body at all.
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.booking_id ? `booking-${payload.booking_id}` : "jp-portal",
      data: { booking_id: payload.booking_id, kind: payload.kind },
    })
  );
});

// Clicking the notification opens (or focuses) the portal's bookings
// view -- the app itself looks up the booking by id; the notification
// carries no detail to render (CTL-PSH-01).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window" });
      for (const client of clientsList) {
        if (client.url.includes("/portal/")) {
          client.focus();
          return;
        }
      }
      await self.clients.openWindow("/portal/");
    })()
  );
});
