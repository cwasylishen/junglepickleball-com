import { json, getEvents, DEFAULT_EVENTS } from "../_shared.js";

// Public endpoint: returns active events only, filtering out dated events whose
// day has already passed. Weekly (no `date`) events always pass through.
export async function onRequestGet({ env }) {
  const stored = await getEvents(env);
  const list = stored ?? DEFAULT_EVENTS;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const active = list
    .filter((e) => e.status !== "archived")
    .filter((e) => {
      if (!e.date) return true;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.date);
      if (!m) return true;
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return d >= today;
    })
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return json({ events: active });
}
