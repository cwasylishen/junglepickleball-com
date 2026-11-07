// PWA install prompt and push opt-in (B2e). Exposes `window.PortalPwa`,
// called by the shell (portal/js/app.js's portalShell().init(), per
// docs/portal/ui-structure.md) once the area modules have loaded; this
// file never assumes any particular element exists, so it is safe to
// load even before the account area has mounted its view.
//
// portal(FR3b): inspection-2.md N3 -- nothing called PortalPwa, so the
// service worker never registered and the account area never showed
// the install/reminders row. Fixed by adding init()/mountAccountAppRow()
// here and the one call to PortalPwa.init() in app.js.
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

  // P1: fills the `#account-app-mount` row account.html leaves for this
  // module (ui-structure.md) with the install control and the reminders
  // opt-in. Safe to call anytime -- it does nothing until that element
  // exists (account.js mounts it asynchronously after its own route
  // match), and it only ever mounts once per element.
  async function mountAccountAppRow() {
    const mount = document.getElementById("account-app-mount");
    if (!mount || mount.dataset.pwaMounted === "1") return;
    mount.dataset.pwaMounted = "1";

    const wrap = document.createElement("div");
    wrap.className = "flex flex-col items-end gap-1 text-xs text-slate-500";
    mount.appendChild(wrap);

    const installLine = document.createElement("div");
    wrap.appendChild(installLine);
    if (isStandalone()) {
      installLine.textContent = "App installed";
    } else if (isIos()) {
      installLine.textContent = "Add to Home Screen from the Share menu";
    } else {
      const installButton = document.createElement("button");
      installButton.type = "button";
      installButton.className = "text-jpteal underline disabled:no-underline disabled:opacity-50";
      installButton.textContent = "Install app";
      installButton.disabled = !canInstall();
      installButton.addEventListener("click", async () => {
        const outcome = await promptInstall();
        installLine.textContent = outcome === "accepted" ? "App installed" : "Install app";
        if (outcome !== "accepted") wrap.insertBefore(installButton, installLine.nextSibling);
      });
      installLine.appendChild(installButton);
      window.addEventListener("beforeinstallprompt", () => {
        installButton.disabled = false;
      });
    }

    // REQ-PWA-07/08: features.push comes from the same /api/portal/me
    // call every area already trusts for feature gating (nc.push,
    // app.js's STR.en) -- never a guess from whether the browser
    // supports the Push API.
    const session = await window.PortalApp.bootstrapSession();
    const pushOn = Boolean(session.features && session.features.push);

    const pushLine = document.createElement("div");
    wrap.appendChild(pushLine);
    if (!pushOn) {
      pushLine.textContent = (window.STR && window.STR.en && window.STR.en["nc.push"]) || "Reminders are not switched on yet.";
      return;
    }
    const pushButton = document.createElement("button");
    pushButton.type = "button";
    pushButton.className = "text-jpteal underline";
    pushButton.textContent = "Turn on reminders";
    pushButton.addEventListener("click", async () => {
      pushButton.disabled = true;
      try {
        await subscribeToPush();
        pushLine.textContent = "Reminders are on";
      } catch (err) {
        pushLine.textContent = err && err.message ? err.message : "Could not turn on reminders.";
        pushButton.disabled = false;
      }
    });
    pushLine.appendChild(pushButton);
  }

  // Called once by the shell (app.js's portalShell().init(), per this
  // file's own header note above) after the area modules have loaded.
  // Registers the service worker, then mounts the account row now (in
  // case `#/account` is already showing) and again whenever the DOM
  // changes, since account.js injects account.html asynchronously on
  // its own hashchange/DOMContentLoaded handler and this module has no
  // other way to know when that fetch finishes.
  async function init() {
    try {
      await registerServiceWorker();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[pwa] service worker registration failed:", err && err.message);
    }
    mountAccountAppRow();
    window.addEventListener("hashchange", mountAccountAppRow);
    new MutationObserver(mountAccountAppRow).observe(document.body, { childList: true, subtree: true });
  }

  window.PortalPwa = {
    init,
    registerServiceWorker,
    canInstall,
    promptInstall,
    isIos,
    isStandalone,
    subscribeToPush,
    unsubscribeFromPush,
    mountAccountAppRow,
  };
})();
