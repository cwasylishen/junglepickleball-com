// Portal HTTP helpers: JSON responses, the one error envelope (CTL-ERR-01),
// and the security headers portal pages/API responses carry (CTL-HDR-01).
// Keep this module boring: every other portal file calls through here
// rather than building its own Response.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

// CTL-ERR-01: every thrown error becomes exactly this body. No message,
// stack, SQL fragment or constraint name ever reaches the caller.
export function serverError() {
  return json({ error: "server_error" }, 500);
}

export function notConfigured(feature) {
  return json({ error: "not_configured", feature }, 503);
}

export function environmentMismatch() {
  return json({ error: "environment_mismatch" }, 503);
}

// CTL-HDR-01: CSP + supporting headers for /portal/* HTML responses.
// Kept byte-identical to the `/portal/*` block in `_headers` (portal(FR1)
// fix round): 'unsafe-eval' is required by the standard (non-CSP-build)
// Alpine v3 bundle this portal vendors at portal/vendor/, and no CDN
// origin is listed because Alpine is self-hosted (security-posture.md
// line 207).
export const PORTAL_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export function portalHtml(body, status = 200) {
  return new Response(body, { status, headers: PORTAL_HTML_HEADERS });
}

// A thrown error inside a portal handler is logged by class + a random
// error id only (LOG-02: never the message or a value), then turned into
// the one generic body. Call this from the router's top-level catch.
export function logAndMask(err) {
  const errorId = crypto.randomUUID();
  // eslint-disable-next-line no-console
  console.error(`portal_error id=${errorId} class=${err && err.name || "Error"}`);
  return serverError();
}
