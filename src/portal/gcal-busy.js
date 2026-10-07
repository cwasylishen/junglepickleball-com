// Google Calendar READ side: what Roger has put on a resource's Google
// calendar by hand counts as unavailable in the portal. The push side
// (gcal.js) is unchanged in direction; this module only reads.
//
// Our database stays the source of truth. A Google event never becomes a
// booking row; it only makes a slot show as unavailable and refuses a
// booking that would land on it.
//
// Inert by construction: with GOOGLE_SERVICE_ACCOUNT_JSON unset, or a
// resource with no google_calendar_id, busyIntervalsForWindow answers
// "not configured" before it builds a JWT, reads a cache or calls fetch.
//
// Fail safe: if Google cannot be read (token, HTTP error, timeout, bad
// secret), the answer is "unknown", which callers treat as "no Google
// blocks": the slot shows as the database says. One error line with an
// error id is logged; a booking is never refused because Google is down.
//
// Why events.list and not freebusy.query: freebusy returns bare time
// ranges and drops extendedProperties, so it cannot tell an event the
// portal pushed from one Roger typed. Reading events lets us skip our own
// (extendedProperties.private.source = "portal") so a booking is not
// counted twice. Titles and details are read by Google's API but never
// stored, cached or returned: only start/end instants leave this module.
//
// Time: every day boundary is a Costa Rica calendar day, converted by
// cr-time.js (the one place the zone is applied). Google event instants
// are absolute, so they need no zone arithmetic; an all-day event is a
// calendar date and is read as that Costa Rica date.

import { getGoogleAccessToken } from "./gcal.js";
import { addDaysToDateString, crDateStringFromUtc, crDateTimeToUtcIso } from "./cr-time.js";

export const CR_TIME_ZONE = "America/Costa_Rica";
export const PORTAL_SOURCE = "portal"; // value of extendedProperties.private.source on events we push

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars";
const OK_CACHE_SECONDS = 180; // 3 minutes (KV's own minimum is 60)
const ERROR_CACHE_SECONDS = 60; // after a Google failure, do not ask again (or log again) for a minute
const GOOGLE_TIMEOUT_MS = 3000;
const MAX_PAGES = 5;

// A calendar id pasted with a stray space or newline would 404 at Google, so it is trimmed here.
function calendarIdOf(resource) {
  return resource && typeof resource.google_calendar_id === "string" ? resource.google_calendar_id.trim() : "";
}

export function isGcalReadConfigured(env, resource) {
  return Boolean(env && env.GOOGLE_SERVICE_ACCOUNT_JSON && calendarIdOf(resource));
}

// An event counts as busy unless it is cancelled, marked "free"
// (transparency: transparent), or one the portal pushed itself. Events
// pushed before `source` was added carry booking_id, so that also marks
// them as ours.
export function isBusyEvent(event) {
  if (!event || event.status === "cancelled") return false;
  if (event.transparency === "transparent") return false;
  const props = (event.extendedProperties && event.extendedProperties.private) || {};
  if (props.source === PORTAL_SOURCE || props.booking_id) return false;
  return true;
}

// One Google event -> [startIso, endIso] in UTC, or null if it has no usable time.
export function eventInterval(event) {
  const start = event.start || {};
  const end = event.end || {};
  if (start.dateTime && end.dateTime) {
    const s = Date.parse(start.dateTime);
    const e = Date.parse(end.dateTime);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
    return [new Date(s).toISOString(), new Date(e).toISOString()];
  }
  if (start.date && end.date) {
    // All-day: Google's end date is exclusive.
    return [crDateTimeToUtcIso(start.date, "00:00"), crDateTimeToUtcIso(end.date, "00:00")];
  }
  return null;
}

// The Costa Rica dates a UTC window touches, first to last.
export function crDatesCovering(startIso, endIso) {
  const first = crDateStringFromUtc(new Date(startIso));
  const last = crDateStringFromUtc(new Date(Date.parse(endIso) - 1));
  const dates = [];
  for (let d = first; d <= last; d = addDaysToDateString(d, 1)) dates.push(d);
  return dates;
}

function withTimeout(fetchImpl) {
  return (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
}

async function listBusyForCrDate(env, calendarId, crDate, fetchImpl) {
  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const timed = withTimeout(fetchImpl);
  const accessToken = await getGoogleAccessToken(serviceAccount, timed);
  const timeMin = crDateTimeToUtcIso(crDate, "00:00");
  const timeMax = crDateTimeToUtcIso(addDaysToDateString(crDate, 1), "00:00");

  const intervals = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      timeZone: CR_TIME_ZONE,
      singleEvents: "true",
      maxResults: "250",
      fields: "nextPageToken,items(status,transparency,start,end,extendedProperties/private)",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const res = await timed(`${EVENTS_URL}/${encodeURIComponent(calendarId)}/events?${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`gcal_events_list_failed status=${res.status}`);
    const data = await res.json();
    for (const event of data.items || []) {
      if (!isBusyEvent(event)) continue;
      const interval = eventInterval(event);
      if (interval) intervals.push(interval);
    }
    pageToken = data.nextPageToken || null;
    if (!pageToken) return intervals;
  }
  throw new Error(`gcal_events_list_too_many_pages max=${MAX_PAGES}`);
}

const okKey = (calendarId, crDate) => `gcalbusy:v1:${encodeURIComponent(calendarId)}:${crDate}`;
const errKey = (calendarId) => `gcalbusy:v1:err:${encodeURIComponent(calendarId)}`;

// The cache. CTL-ENV-03 forbids portal code from touching the legacy EVENTS
// KV namespace (it holds the public events list and Glow signups), so the
// cache is either a KV namespace bound under the name GCAL_BUSY_CACHE (same
// get/put shape, no code change needed to switch) or, by default, the
// Workers Cache API. The Cache API is a per-datacentre cache and does not
// store anything on a workers.dev hostname; there it is simply always a miss.
const CACHE_API_ORIGIN = "https://gcal-busy.cache.invalid/";

const cacheApiStore = {
  async get(key) {
    const hit = await caches.default.match(new Request(CACHE_API_ORIGIN + key));
    return hit ? hit.text() : null;
  },
  async put(key, value, { expirationTtl }) {
    await caches.default.put(
      new Request(CACHE_API_ORIGIN + key),
      new Response(value, { headers: { "Cache-Control": `max-age=${expirationTtl}` } })
    );
  },
};

function cacheOf(env) {
  if (env.GCAL_BUSY_CACHE) return env.GCAL_BUSY_CACHE;
  return typeof caches !== "undefined" && caches.default ? cacheApiStore : null;
}

async function cacheGet(env, key) {
  const store = cacheOf(env);
  if (!store) return null;
  try {
    return await store.get(key);
  } catch {
    return null; // a cache that cannot be read is a cache miss, never a refusal
  }
}

async function cachePut(env, key, value, seconds) {
  const store = cacheOf(env);
  if (!store) return;
  try {
    await store.put(key, value, { expirationTtl: seconds });
  } catch (err) {
    console.error(`gcal_busy_cache_write_failed key=${key} message=${err && err.message}`);
  }
}

// Returns one of:
//   { state: "not_configured" }
//   { state: "ok", intervals: [[startIso, endIso], ...] }   (all busy ranges overlapping the window)
//   { state: "unknown", errorId }                           (Google could not be read; treat as no blocks)
// `fresh: true` (the booking-time re-check) skips the cache read; it still writes the cache.
export async function busyIntervalsForWindow(env, resource, startIso, endIso, { fresh = false, fetchImpl = (...args) => fetch(...args) } = {}) {
  if (!isGcalReadConfigured(env, resource)) return { state: "not_configured" };
  const calendarId = calendarIdOf(resource);

  if (!fresh) {
    const recentErrorId = await cacheGet(env, errKey(calendarId));
    if (recentErrorId) return { state: "unknown", errorId: recentErrorId };
  }

  const all = [];
  try {
    for (const crDate of crDatesCovering(startIso, endIso)) {
      const cached = fresh ? null : await cacheGet(env, okKey(calendarId, crDate));
      let intervals = null;
      if (cached) {
        try {
          intervals = JSON.parse(cached);
        } catch {
          intervals = null; // damaged cache entry: fetch again
        }
      }
      if (!intervals) {
        intervals = await listBusyForCrDate(env, calendarId, crDate, fetchImpl);
        await cachePut(env, okKey(calendarId, crDate), JSON.stringify(intervals), OK_CACHE_SECONDS);
      }
      all.push(...intervals);
    }
  } catch (err) {
    const errorId = crypto.randomUUID().slice(0, 8);
    console.error(`gcal_busy_unreadable error_id=${errorId} resource_id=${resource.id} message=${(err && err.message) || String(err)}`);
    await cachePut(env, errKey(calendarId), errorId, ERROR_CACHE_SECONDS);
    return { state: "unknown", errorId };
  }
  return { state: "ok", intervals: all.filter(([s, e]) => s < endIso && startIso < e) };
}

// True if any busy range overlaps [startIso, endIso). Same overlap rule as
// booking.js's rangesOverlap, on UTC ISO strings of the same shape.
export function overlapsBusy(intervals, startIso, endIso) {
  return intervals.some(([s, e]) => s < endIso && startIso < e);
}
