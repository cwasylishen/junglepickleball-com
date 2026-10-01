// Shared helpers for the B1 foundation probes. Black-box HTTP against
// the real bundle (PIN-16) -- these never import the server's own code
// except where a control's probe is explicitly a pure-function/schema
// check (controls.md says so for CTL-ENT-01/02, CTL-ROLE-01, CTL-AUTH-07,
// CTL-DATA-01/02/03/05), in which case the test says so at the top.

import { execFileSync } from "node:child_process";

export const BASE_URL = process.env.PORTAL_TEST_BASE_URL || "http://127.0.0.1:8799";

// A tiny cookie jar: fetch() in Node does not persist Set-Cookie across
// calls, and the auth flow needs that to work the way a browser would.
export function makeClient() {
  let cookie = null;
  async function call(method, path, body, extraHeaders = {}) {
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (cookie) headers["Cookie"] = cookie;
    // `wrangler dev` hot-reloads mid-suite (a source edit, or even a
    // concurrent `wrangler d1 execute` CLI run touching .wrangler/tmp)
    // and drops any request in flight at that instant. One retry rides
    // out that transient disconnect without masking a real failure --
    // the retried request still gets the real response and the real
    // assertion runs against it.
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        break;
      } catch (err) {
        if (attempt === 1) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data, res };
  }
  return {
    get: (path, headers) => call("GET", path, undefined, headers),
    post: (path, body, headers) => call("POST", path, body, headers),
    clearCookie: () => { cookie = null; },
    getCookie: () => cookie,
  };
}

// `wrangler dev`'s hot-reload can tear down and rebuild the D1
// connection mid-request, which the portal's own top-level catch
// (CTL-ERR-01) correctly turns into a generic 500 -- that is the control
// working, not a test to fail on. One retry rides that out; a genuine
// problem with auth/start still fails loudly on the second attempt.
export async function startAndGetDevLink(client, email, origin) {
  let start = await client.post("/api/portal/auth/start", { email }, origin);
  if (!start.data || !start.data.dev_link) {
    await new Promise((r) => setTimeout(r, 500));
    start = await client.post("/api/portal/auth/start", { email }, origin);
  }
  if (!start.data || !start.data.dev_link) {
    throw new Error(`no dev_link for ${email}: ${JSON.stringify(start.data)}`);
  }
  return start.data.dev_link;
}

// Logs a demo account in end to end (start -> dev_link -> verify) and
// returns an authenticated client plus its csrf token.
export async function loginDemo(email, extraHeaders = {}) {
  const client = makeClient();
  const origin = { Origin: BASE_URL, ...extraHeaders };
  const devLink = await startAndGetDevLink(client, email, origin);
  const token = new URL(devLink).hash.replace(/^#login=/, "");
  const verify = await client.post("/api/portal/auth/verify", { token, age_16_plus: true, confirm: true }, origin);
  if (verify.status !== 200) throw new Error(`verify failed for ${email}: ${verify.status} ${JSON.stringify(verify.data)}`);
  return { client, csrfToken: verify.data.csrf_token, account: verify.data.account };
}

// Runs a wrangler d1 execute against the SAME local PORTAL_DB the
// running server uses (--persist-to, set by scripts/test.sh -- see that
// file for why state lives outside the watched project tree). Used only
// by probes whose control explicitly inspects the schema or triggers
// (CTL-DATA-01/02/03/05, CTL-ENV-01/02), which have no HTTP surface by
// design.
const PERSIST_DIR = process.env.PORTAL_TEST_PERSIST_DIR || ".wrangler/state";

export function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "PORTAL_DB", "--local", "--persist-to", PERSIST_DIR, "--json", "--command", sql],
    { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" }
  );
  const parsed = JSON.parse(out);
  return parsed[0].results;
}
