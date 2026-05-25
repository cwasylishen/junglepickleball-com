import { json, getEvents, putEvents, normalizeEvent } from "../../../_shared.js";

// Update an event (including archive/restore via the status field).
export async function onRequestPut({ request, env, params }) {
  const list = (await getEvents(env)) ?? [];
  const idx = list.findIndex((e) => e.id === params.id);
  if (idx === -1) return json({ error: "Event not found." }, 404);
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const updated = normalizeEvent(input, list[idx]);
  updated.id = list[idx].id;
  list[idx] = updated;
  await putEvents(env, list);
  return json({ event: updated });
}

// Permanently delete an event.
export async function onRequestDelete({ env, params }) {
  const list = (await getEvents(env)) ?? [];
  const next = list.filter((e) => e.id !== params.id);
  if (next.length === list.length) return json({ error: "Event not found." }, 404);
  await putEvents(env, next);
  return json({ ok: true });
}
