// Passkey UI glue (B2c), calling the B2c-owned /api/portal/auth/passkey/*
// and /api/portal/passkeys routes (docs/portal/ui-structure.md).
//
// This module never assumes its own markup exists yet -- other areas
// (B1's index.html for L1, B2f1's account.html for L5/L6) mount the
// actual buttons/sheets and call into `window.PortalPasskeys`. Where an
// area wires a DOM hook, it uses the `data-passkey-*` attributes
// documented at the bottom of this file and in docs/portal/api.md §6.
//
// Every string this module shows is merged into window.STR.en (screens
// §762 "Copy ownership": keys under `passkey` and `nc.passkeys`) via
// window.PortalApp.mergeStrings, per ui-structure.md step 3.

if (window.PortalApp && typeof window.PortalApp.mergeStrings === "function") {
  window.PortalApp.mergeStrings({
    "nc.passkeys": "Passkeys aren't switched on yet. Use the email link.",
    "login.passkey": "Sign in with a passkey",
    "passkey.offer_title": "Sign in faster next time",
    "passkey.offer_body": "Save a passkey on this device and sign in with your fingerprint, face or screen lock. No email needed.",
    "passkey.save": "Save a passkey",
    "passkey.not_now": "Not now",
    "passkey.saving": "Saving…",
    "passkey.saved": "Passkey saved. Next time, tap “Sign in with a passkey”.",
    "passkey.save_failed": "Couldn't save the passkey. You can try again from Account.",
    "passkey.not_found": "No passkey for this site on this device. Use the email link instead.",
    "passkey.list_top": "Passkeys on this account: {n}",
    "passkey.none_top": "No passkeys yet",
    "passkey.unnamed": "Passkey",
    "passkey.added_on": "Added {date}",
    "passkey.add": "Add a passkey",
    "passkey.empty": "Add a passkey to sign in with your fingerprint, face or screen lock.",
    "passkey.unsupported": "This device or browser can't save passkeys.",
  });
}

const OFFER_DISMISSED_KEY = "jp_pk_offer_dismissed";

// base64url <-> ArrayBuffer, matching what navigator.credentials
// create()/get() hand back and what the server (passkeys.js) expects.
function b64urlToBuffer(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

function bufferToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return window.btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The server sends options with base64url strings (challenge, user.id,
// excludeCredentials[].id, allowCredentials[].id); the browser API wants
// ArrayBuffers in those same places.
function decodeCreationOptions(options) {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    user: { ...options.user, id: b64urlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuffer(c.id) })),
  };
}

function decodeRequestOptions(options) {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuffer(c.id) })),
  };
}

function encodeRegistrationCredential(cred) {
  return {
    id: cred.id,
    rawId: bufferToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
      attestationObject: bufferToB64url(cred.response.attestationObject),
    },
  };
}

function encodeAssertionCredential(cred) {
  return {
    id: cred.id,
    rawId: bufferToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
      authenticatorData: bufferToB64url(cred.response.authenticatorData),
      signature: bufferToB64url(cred.response.signature),
      userHandle: cred.response.userHandle ? bufferToB64url(cred.response.userHandle) : undefined,
    },
  };
}

// L4: screens.md's platform-availability gate for showing `login.passkey`
// at all (window.PublicKeyCredential existing is not enough on its own).
async function isPlatformAvailable() {
  if (!window.PublicKeyCredential || !window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// L4 passkey sign-in. Resolves to the same shape as a magic-link verify
// ({ok, first_login, csrf_token, account}); the caller sets the CSRF
// token and routes to the role home exactly as it does after verify.
// Throws { code: "not_found" | "cancelled" | "error" } on failure --
// the caller shows `passkey.not_found` for not_found/error and nothing
// for cancelled (screens.md L4).
async function loginWithPasskey(email) {
  const start = await PortalApi.post("/api/portal/auth/passkey/login/start", { email: email || "" });
  if (!start.ok) throw { code: "error" };
  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey: decodeRequestOptions(start.data) });
  } catch (err) {
    if (err && err.name === "NotAllowedError") throw { code: "cancelled" };
    throw { code: "not_found" };
  }
  const finish = await PortalApi.post("/api/portal/auth/passkey/login/finish", { credential: encodeAssertionCredential(assertion) });
  if (!finish.ok) throw { code: "error" };
  if (finish.data && finish.data.csrf_token) PortalApi.setCsrfToken(finish.data.csrf_token);
  return finish.data;
}

// L5/L6 "Save a passkey", for an already-signed-in account.
async function registerPasskey() {
  const start = await PortalApi.post("/api/portal/auth/passkey/register/start", {});
  if (!start.ok) throw { code: "error" };
  let created;
  try {
    created = await navigator.credentials.create({ publicKey: decodeCreationOptions(start.data) });
  } catch (err) {
    if (err && err.name === "NotAllowedError") throw { code: "cancelled" };
    throw { code: "error" };
  }
  const finish = await PortalApi.post("/api/portal/auth/passkey/register/finish", { credential: encodeRegistrationCredential(created) });
  if (!finish.ok) throw { code: "error" };
  return finish.data;
}

// L6 list/remove.
function listPasskeys() {
  return PortalApi.get("/api/portal/passkeys");
}

function deletePasskey(id) {
  return PortalApi.del(`/api/portal/passkeys/${encodeURIComponent(id)}`);
}

// L5: whether the post-first-login offer sheet should open at all.
// Pure decision, no DOM/API side effects -- the caller (L3's landing
// handler) opens the sheet and then calls registerPasskey() itself.
async function shouldOfferAfterFirstLogin(features) {
  if (!features || features.passkeys === false) return false;
  if (window.localStorage.getItem(OFFER_DISMISSED_KEY) === "1") return false;
  return isPlatformAvailable();
}

function dismissOffer() {
  window.localStorage.setItem(OFFER_DISMISSED_KEY, "1");
}

window.PortalPasskeys = {
  isPlatformAvailable,
  loginWithPasskey,
  registerPasskey,
  listPasskeys,
  deletePasskey,
  shouldOfferAfterFirstLogin,
  dismissOffer,
};

// DOM-hook convention for B2f1/B1 to wire against (documented here and
// in api.md §6's changelog line) -- optional, never required:
//   [data-passkey-login]   click -> loginWithPasskey(emailFieldValue)
//   [data-passkey-offer]   a sheet shown per shouldOfferAfterFirstLogin()
//   [data-passkey-list]    a container rendered from listPasskeys()
// This file does not query the DOM itself: no area's markup exists in
// every build yet, and a missing hook must never throw.
