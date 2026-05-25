import { json } from "../_shared.js";

// Public, non-secret config for the admin page (Turnstile site key is public).
export async function onRequestGet({ env }) {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || "" });
}
