// PWA install prompt and push opt-in (B2e). Exposes `window.PortalPwa`
// so the account area (B2f1's portal/js/account.js, per
// docs/portal/ui-structure.md) can call into it; this file never
// assumes any particular element exists, so it is safe to load even
// before that area is built (see this part's return for the one
// finding: the <script> tag and init() call that still need adding to
// portal/index.html/app.js, which B2e does not own).
//
// REQ-PWA-04/05: Android gets the native `beforeinstallprompt`; iOS
// Safari never fires it, so canInstall()/isIos() let the caller choose
// which UI to show.

(function () {
  let deferredInstallEvent = null;
  let serviceWorkerRegistration = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallEvent = event;
  });

  function isIos() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }

  function canInstall() {
    return Boolean(deferredInstallEvent);
  }

  // Android's one-shot install prompt. Resolves to "accepted" or
  // "dismissed"; the caller decides what to show either way.
  async function promptInstall() {
    if (!deferredInstallEvent) return null;
    deferredInstallEvent.prompt();
    const choice = await deferredInstallEvent.userChoice;
    deferredInstallEvent = null;
    return choice.outcome;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    serviceWorkerRegistration = await navigator.serviceWorker.register("/portal/sw.js", { scope: "/portal/" });
    return serviceWorkerRegistration;
  }

  // https://developer.mozilla.org/.../PushManager/subscribe needs the
  // VAPID public key as raw bytes, not the base64url string the server
  // hands back.
  function base64UrlToUint8Array(base64Url) {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function subscriptionToJson(subscription) {
    const keys = subscription.toJSON().keys;
    return { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  }

  // REQ-PWA-07: opt in. Throws a plain Error with a caller-facing
  // message rather than swallowing a permission refusal or a
  // not-configured 503 -- the account area is expected to catch this
  // and show the message, never a generic failure.
  async function subscribeToPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("Push notifications are not supported on this browser.");
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
    const keyRes = await PortalApi.get("/api/portal/push/vapid-public-key");
    if (keyRes.status === 503 || !keyRes.data || !keyRes.data.public_key) {
      throw new Error("Push reminders are not switched on yet.");
    }
    const registration = serviceWorkerRegistration || (await registerServiceWorker());
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(keyRes.data.public_key),
    });
    const body = subscriptionToJson(subscription);
    const subscribeRes = await PortalApi.post("/api/portal/push/subscribe", body);
    if (subscribeRes.status !== 200) {
      throw new Error("Could not save the push subscription.");
    }
    return body;
  }

  // REQ-PWA-08: opt out, both on the device and on the server.
  async function unsubscribeFromPush() {
    if (!("serviceWorker" in navigator)) return;
    const registration = serviceWorkerRegistration || (await navigator.serviceWorker.getRegistration("/portal/"));
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await PortalApi.post("/api/portal/push/unsubscribe", { endpoint });
  }

  window.PortalPwa = {
    registerServiceWorker,
    canInstall,
    promptInstall,
    isIos,
    isStandalone,
    subscribeToPush,
    unsubscribeFromPush,
  };
})();
