# Google Calendar busy time (read side)

What Roger puts on a resource's Google Calendar by hand shows in the portal as
unavailable, and a booking that would land on it is refused. The push side
(`src/portal/gcal.js`) is unchanged in direction. Code: `src/portal/gcal-busy.js`.

## Owner setup (no OAuth, service account only)

1. Roger shares each court/resource calendar with the service account's `client_email`
   (from `GOOGLE_SERVICE_ACCOUNT_JSON`) at **"Make changes to events"** (API role `writer`).
   That one level covers both reading event details and the portal's push.
   "See all event details" (`reader`) reads but cannot push; "See only free/busy" is
   too little (events carry no extended properties, so our own pushes could not be told apart).
2. In the portal: Owner, Manage, open the resource, field **Google Calendar ID**
   (Google Calendar, Settings, that calendar, Integrate calendar, Calendar ID). Save.
3. Clinton sets the Worker secret `GOOGLE_SERVICE_ACCOUNT_JSON`.

With the secret unset, or a resource with no calendar id, nothing changes: no Google call,
no cache read.

## Rules

- Events read with `events.list` (`singleEvents=true`, scope `calendar.events`, the same
  token code as the push). Not `freebusy.query`: freebusy drops `extendedProperties`.
- Skipped: cancelled events, events marked Free (transparent), and events the portal
  pushed (`extendedProperties.private.source = "portal"`, or an older push that has
  `booking_id`). An all-day event blocks that whole Costa Rica day.
- A busy slot shows as `blocked` ("Closed"). Titles are never stored, cached or returned.
- Booking: `POST /api/portal/bookings` re-reads Google fresh (no cache) and answers
  `409 calendar_busy` ("That time is no longer available. Pick another.").
  Owner override booking is not checked (the owner decides).
- Cache: 180 s, keys `gcalbusy:v1:<calendar>:<CR date>`. By default the Workers Cache API (portal code may not touch the legacy EVENTS KV, CTL-ENV-03); it stores nothing on a workers.dev hostname, so there every view asks Google. To use KV instead, bind a KV namespace as `GCAL_BUSY_CACHE`: no code change.
- **Fail safe**: if Google cannot be read (token, HTTP error, 3 s timeout, bad secret) the
  portal shows and books from the database alone, never refuses because Google is down,
  logs one `gcal_busy_unreadable error_id=<8 hex> resource_id=<id> message=...` line. The
  60 s pause applies to availability views only; the booking POST deliberately bypasses
  the pause (it always re-checks Google fresh, waits at most the 3 s timeout, logs a new
  line and refreshes the pause) so a recovered Google is honoured at once (key
  `gcalbusy:v1:err:<calendar>`).
- Preview environment class never receives the Google secret (router.js buildPortalEnv,
  CTL-ENV-01), so this is exercised end to end only on the production class.

## Window

The clamp applies to member and guest availability views and member/guest booking POSTs only:
Google reads are clamped to today in Costa Rica through the longest of
`member_window_days` and `non_member_window_days`. Outside that window Google is never
called and slots are database-only. Owners and staff are never clamped; their booking POST
re-checks Google fresh for any date. If a window field is invalid, a member/guest read logs
`gcal_busy_window_invalid` and skips Google reads.

## Time

Every day boundary is a Costa Rica calendar day through `cr-time.js` (the one place the
zone is applied; Costa Rica has no daylight saving). The Google query asks
`timeMin/timeMax` = CR midnight to CR midnight and `timeZone=America/Costa_Rica`. A window
that crosses CR midnight is read as two CR days.
