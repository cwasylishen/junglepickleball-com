// Owner managed public events. This module owns the events table, its
// validation, its audit entries, and the read shape used by the public site.

import { newId, nowIso } from "./db.js";
import { auditStatement } from "./audit.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function text(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function validLink(value) {
  const link = text(value, 500);
  if (!link) return "";
  if (link.startsWith("/")) return link;
  try {
    const url = new URL(link);
    return ["https:", "http:"].includes(url.protocol) ? link : null;
  } catch {
    return null;
  }
}

function validImage(body) {
  const data = text(body.image_data, 1500000);
  if (data && (!IMAGE_DATA_RE.test(data) || data.length > 1200000)) return null;
  const url = text(body.image_url, 500);
  if (url && !url.startsWith("/assets/")) return null;
  return { image_data: data || null, image_url: url || null };
}

function validate(body, current = null) {
  const source = body || {};
  const title = text(source.title, 160);
  const eventDate = text(source.event_date, 10);
  const eventTime = text(source.event_time, 80);
  const place = text(source.place, 160);
  const description = text(source.description, 2400);
  const signupUrl = validLink(source.signup_url);
  const image = validImage(source);
  const status = source.status === "published" ? "published" : source.status === "draft" ? "draft" : null;

  if (!title) return { error: "title_required" };
  if (!validDate(eventDate)) return { error: "date_invalid" };
  if (!eventTime) return { error: "time_required" };
  if (!place) return { error: "place_required" };
  if (!description) return { error: "description_required" };
  if (!signupUrl && text(source.signup_url, 500)) return { error: "signup_link_invalid" };
  if (!image) return { error: "image_invalid" };
  if (!status) return { error: "status_invalid" };
  if (eventTime.length <= 5 && !TIME_RE.test(eventTime)) return { error: "time_invalid" };

  return {
    event: {
      id: current ? current.id : newId(),
      title,
      event_date: eventDate,
      event_time: eventTime,
      place,
      description,
      image_url: image.image_url || (current ? current.image_url : null),
      image_data: image.image_data || (current ? current.image_data : null),
      signup_url: signupUrl || null,
      price_text: text(source.price_text, 120) || null,
      status,
    },
  };
}

function publicShape(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.event_date,
    time: row.event_time,
    place: row.place,
    description: row.description,
    image: row.image_data || row.image_url || null,
    signup_url: row.signup_url,
    price_text: row.price_text,
  };
}

function ownerShape(row) {
  return { ...publicShape(row), image_data: row.image_data, image_url: row.image_url, status: row.status, updated_at: row.updated_at };
}

export async function listPublishedEvents(db) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db.prepare(
    `SELECT id, title, event_date, event_time, place, description, image_url, image_data, signup_url, price_text
       FROM events
      WHERE status = 'published' AND event_date >= ?
      ORDER BY event_date ASC, event_time ASC, created_at ASC`
  ).bind(today).all();
  return (result.results || []).map(publicShape);
}

export async function listOwnerEvents(db) {
  const result = await db.prepare(
    `SELECT id, title, event_date, event_time, place, description, image_url, image_data, signup_url, price_text, status, updated_at
       FROM events
      ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END, event_date ASC, event_time ASC, updated_at DESC`
  ).all();
  return (result.results || []).map(ownerShape);
}

export async function getOwnerEvent(db, id) {
  const row = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  return row ? ownerShape(row) : null;
}

export async function createOwnerEvent(db, actorId, body) {
  const checked = validate(body);
  if (checked.error) return checked;
  const row = checked.event;
  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO events (id, title, event_date, event_time, place, description, image_url, image_data, signup_url, price_text, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.title, row.event_date, row.event_time, row.place, row.description, row.image_url, row.image_data, row.signup_url, row.price_text, row.status, actorId, now, now);
  const audit = auditStatement(db, { actor: actorId, action: "event_create", targetType: "event", targetId: row.id, after: row });
  await db.batch([insert, audit]);
  return { event: await getOwnerEvent(db, row.id) };
}

export async function updateOwnerEvent(db, actorId, id, body) {
  const before = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!before) return { error: "not_found" };
  const checked = validate(body, before);
  if (checked.error) return checked;
  const row = checked.event;
  const now = nowIso();
  const update = db.prepare(
    `UPDATE events SET title = ?, event_date = ?, event_time = ?, place = ?, description = ?, image_url = ?, image_data = ?, signup_url = ?, price_text = ?, status = ?, updated_at = ? WHERE id = ?`
  ).bind(row.title, row.event_date, row.event_time, row.place, row.description, row.image_url, row.image_data, row.signup_url, row.price_text, row.status, now, id);
  const audit = auditStatement(db, { actor: actorId, action: "event_update", targetType: "event", targetId: id, before, after: row });
  await db.batch([update, audit]);
  return { event: await getOwnerEvent(db, id) };
}

export async function deleteOwnerEvent(db, actorId, id) {
  const before = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!before) return { error: "not_found" };
  const remove = db.prepare(`DELETE FROM events WHERE id = ?`).bind(id);
  const audit = auditStatement(db, { actor: actorId, action: "event_delete", targetType: "event", targetId: id, before });
  await db.batch([remove, audit]);
  return { ok: true };
}

export async function publicEventsResponse(db) {
  try {
    return { events: await listPublishedEvents(db) };
  } catch (error) {
    if (/no such table/i.test(String(error && error.message))) return { events: [] };
    throw error;
  }
}

export { validate as validateEvent, publicShape };
