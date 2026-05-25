import { json, getEvents, DEFAULT_EVENTS } from "../_shared.js";

// Public endpoint: returns active events only.
export async function onRequestGet({ env }) {
  const stored = await getEvents(env);
  const list = stored ?? DEFAULT_EVENTS;
  const active = list
    .filter((e) => e.status !== "archived")
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return json({ events: active });
}
