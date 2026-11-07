// A minimal software WebAuthn authenticator for B2c's black-box probes
// (PIN-18: real attestation/assertion responses, not mocks). Builds the
// same wire format navigator.credentials.create()/get() would hand to
// the browser -- CBOR attestationObject, raw authenticatorData, a real
// ES256 (ECDSA P-256) signature -- using only Node's global WebCrypto,
// so the server verifies it with the real @simplewebauthn/server
// library, not a stub.
//
// Not a test file itself (no `.test.mjs` suffix, so scripts/test.sh's
// glob skips it); imported by tests/foundation/passkeys-*.test.mjs.

import { isoCBOR, isoBase64URL } from "@simplewebauthn/server/helpers";

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function u16be(n) {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32be(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

// DER-encode a raw IEEE-P1363 (r||s, 32 bytes each) ECDSA signature --
// WebCrypto's ECDSA signer returns raw r||s; WebAuthn (and
// @simplewebauthn/server's unwrapEC2Signature) requires ASN.1 DER.
function derFromRawEcdsaSignature(raw) {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  function encodeInt(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let b = bytes.slice(i);
    if (b[0] & 0x80) b = concat([Uint8Array.from([0]), b]);
    return concat([Uint8Array.from([0x02, b.length]), b]);
  }
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const body = concat([rEnc, sEnc]);
  return concat([Uint8Array.from([0x30, body.length]), body]);
}

export async function generateAuthenticatorKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)); // 0x04||x(32)||y(32)
  const x = rawPublic.slice(1, 33);
  const y = rawPublic.slice(33, 65);
  const coseKey = isoCBOR.encode(
    new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, x],
      [-3, y],
    ])
  );
  return { privateKey: keyPair.privateKey, coseKeyBytes: coseKey };
}

function buildAuthenticatorData({ rpIdHash, flags, counter, attestedCredentialData }) {
  const parts = [rpIdHash, Uint8Array.from([flags]), u32be(counter)];
  if (attestedCredentialData) parts.push(attestedCredentialData);
  return concat(parts);
}

function clientDataJSONBytes({ type, challenge, origin }) {
  const json = JSON.stringify({ type, challenge, origin, crossOrigin: false });
  return new TextEncoder().encode(json);
}

// Builds a full RegistrationResponseJSON as the server's
// verifyRegistrationResponse() expects it (attestation format "none").
export async function buildRegistrationCredential({ rpId, origin, challenge, credentialId, coseKeyBytes }) {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  const aaguid = new Uint8Array(16);
  const attestedCredentialData = concat([aaguid, u16be(credentialId.length), credentialId, coseKeyBytes]);
  const authData = buildAuthenticatorData({ rpIdHash, flags: 0x45, counter: 0, attestedCredentialData }); // UP+UV+AT
  const attestationObject = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  const clientDataJSON = clientDataJSONBytes({ type: "webauthn.create", challenge, origin });
  const idB64 = isoBase64URL.fromBuffer(credentialId);
  return {
    id: idB64,
    rawId: idB64,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
    },
  };
}

// Builds a full AuthenticationResponseJSON, signed with the matching
// authenticator private key from buildRegistrationCredential's pair.
// `rpId` and `origin` can be overridden independently of the
// credential's own registration values, to construct the wrong-RP-ID
// and wrong-origin probes.
export async function buildAssertionCredential({ rpId, origin, challenge, credentialId, privateKey, counter = 0 }) {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  const authData = buildAuthenticatorData({ rpIdHash, flags: 0x05, counter }); // UP+UV, no attested data
  const clientDataJSON = clientDataJSONBytes({ type: "webauthn.get", challenge, origin });
  const clientDataHash = await sha256(clientDataJSON);
  const signatureBase = concat([authData, clientDataHash]);
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signatureBase)
  );
  const derSignature = derFromRawEcdsaSignature(rawSignature);
  const idB64 = isoBase64URL.fromBuffer(credentialId);
  return {
    id: idB64,
    rawId: idB64,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(derSignature),
    },
  };
}

export function randomCredentialId() {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  return id;
}
