// Portal fetch helper. Every area module calls through this -- never
// `fetch()` directly -- so the CSRF header and the error envelope are
// handled in exactly one place.
//
// Usage: api.get('/api/portal/me'); api.post('/api/portal/auth/start', {email});

const PortalApi = (() => {
  let csrfToken = null;

  function setCsrfToken(token) {
    csrfToken = token || null;
  }

  async function request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network/offline failure (screens §2.4 "Offline"). Never cached
      // (REQ-PWA-03), so this path is the only way a caller learns the
      // request did not complete.
      return { ok: false, status: 0, error: "offline", data: null };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // A non-JSON body (a 5xx from outside the portal catch, say) --
      // the UI never shows server text (REQ-SEC-09), so this is folded
      // into the generic error state, not surfaced.
      data = null;
    }
    return { ok: res.ok, status: res.status, error: data && data.error ? data.error : null, data };
  }

  return {
    setCsrfToken,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
  };
})();
