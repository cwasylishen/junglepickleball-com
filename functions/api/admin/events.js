import { json, getEvents, putEvents, DEFAULT_EVENTS, normalizeEvent } from "../../_shared.js";

// List all events (active + archived). Seeds defaults on first run.
export async function onRequestGet({ env }) {
  let list = await getEvents(env);
  if (list === null) {
    list = DEFAULT_EVENTS.map((e) => ({ ...e }));
    await putEvents(env, list);
  }
  list = list.slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return json({ events: list });
}

// Create an event.
export async function onRequestPost({ request, env }) {
  const list = (await getEvents(env)) ?? [];
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (!input.title || !String(input.title).trim()) {
    return json({ error: "Title is required." }, 400);
  }
  if (input.order == null) {
    input.order = list.reduce((m, e) => Math.max(m, e.order ?? 0), 0) + 10;
  }
  const event = normalizeEvent(input);
  list.push(event);
  await putEvents(env, list);
  return json({ event }, 201);
}
