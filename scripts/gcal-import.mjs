#!/usr/bin/env node
// One-time import of Roger's existing court bookings from Google
// Calendar into the portal's `bookings` table (PIN-13, REQ-CAL-09/10/11,
// controls.md §3.7 CTL-CAL-01..04). Design is documented in full at
// docs/portal/gcal-import.md -- read that first.
//
// Dry run is the default and the only thing this script does tonight
// (PIN-13: "it is not run"). `--apply` is gated behind three separate
// refusals, each named for the failure it exists to stop:
//   - CTL-CAL-04: refuses a target whose portal_meta marker is 'preview'.
//   - CTL-CAL-01: refuses without --diff-sha256, and refuses if the dry
//     run recomputed right now does not hash to that value (someone
//     rebooked between the review and the apply -- GEN-30, safe, just
//     re-review).
//   - CTL-CAL-02: writes only through `src/portal/booking.js`'s own
//     exported functions, never a direct INSERT -- see "Known gap"
//     below for the one piece that is not wired yet.
//
// Usage:
//   node scripts/gcal-import.mjs
//     No target: prints usage and, since GOOGLE_SERVICE_ACCOUNT_JSON is
//     unset tonight, a message saying so. Writes nothing, calls nothing.
//
//   node scripts/gcal-import.mjs --target=junglepickleball-portal-preview
//     Dry run: reads resources + existing bookings from that D1 (via
//     `wrangler d1 execute --local`), and -- only if the Google secret
//     is set -- fetches each resource's `google_calendar_id` calendar
//     and prints the mapping plan plus its sha256.
//
//   node scripts/gcal-import.mjs --target=<db> --apply --diff-sha256=<hash>
//     Apply: see the three refusals above. Tonight this always stops at
//     the "Known gap" error below, because booking.js does not yet
//     export an import-write function for this script to call.
//
// Known gap (reported, not built -- outside B2d's owned files):
//   CTL-CAL-01 names the import's idempotency key as a UNIQUE
//   `source_event_id` on the imported row. No such column exists on
//   `bookings` (migrations/ is not a B2d file). Tonight's dry run
//   de-duplicates against existing bookings by (resource_id, start_at,
//   end_at) instead, which is weaker. docs/portal/gcal-import.md names
//   the exact migration this needs before --apply can ever run safely.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getGoogleAccessToken } from "../src/portal/gcal.js";

const DEFAULT_PERSIST_DIR = "/tmp/jp-portal-gcal-import-state";
const COSTA_RICA_OFFSET_MINUTES = -6 * 60; // America/Costa_Rica, no DST (research.md)

function parseArgs(argv) {
  const args = { apply: false, remote: false };
  for (const token of argv) {
    if (token === "--apply") args.apply = true;
    else if (token === "--remote") args.remote = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--target=")) args.target = token.slice("--target=".length);
    else if (token.startsWith("--diff-sha256=")) args.diffSha256 = token.slice("--diff-sha256=".length);
    else if (token.startsWith("--persist-to=")) args.persistTo = token.slice("--persist-to=".length);
    else {
      console.error(`Unknown argument: ${token}`);
      process.exit(1);
    }
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "gcal-import: one-time Google Calendar -> bookings import (dry-run by default, PIN-13).",
      "",
      "  node scripts/gcal-import.mjs",
      "      Prints this message. Performs no read or write.",
      "",
      "  node scripts/gcal-import.mjs --target=<db-name> [--remote] [--persist-to=<dir>]",
      "      Dry run against that database. Prints the mapping plan and its sha256.",
      "",
      "  node scripts/gcal-import.mjs --target=<db-name> --apply --diff-sha256=<hash>",
      "      Applies the plan whose hash matches exactly. See docs/portal/gcal-import.md.",
      "",
    ].join("\n")
  );
}

function runWrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8" });
}

// One D1 statement, parsed from `wrangler d1 execute --json`'s array-of
// resultsets shape (confirmed against a live local D1 -- see the
// per-part build return). Only ever reads; this script never passes a
// write statement through here (CTL-CAL-02).
function d1Query(target, { remote, persistTo }, sql) {
  const flags = remote ? ["--remote"] : ["--local", "--persist-to", persistTo];
  const out = runWrangler(["d1", "execute", target, ...flags, "--json", "--command", sql]);
  const resultSets = JSON.parse(out);
  return (resultSets[0] && resultSets[0].results) || [];
}

function requireNonPreview(target, dbOpts) {
  const rows = d1Query(target, dbOpts, "SELECT env FROM portal_meta WHERE id = 1");
  const env = rows[0] && rows[0].env;
  if (env !== "production") {
    // CTL-CAL-04: refuses any target that is not explicitly
    // `production` -- an unset marker or a `preview` marker both
    // refuse, which is the safe default for a target nobody has
    // confirmed yet.
    throw new ImportRefused(`refusing target "${target}": portal_meta.env is "${env || "(none)"}", not "production" (CTL-CAL-04)`);
  }
}

class ImportRefused extends Error {}

// RFC 3339 `dateTime` with an explicit offset (including `Z`) only
// (CTL-CAL-03). Google's all-day events report `{ date: "YYYY-MM-DD" }`
// instead of `dateTime` and are never accepted here.
function parseOffsetDateTime(googleEventTime) {
  if (!googleEventTime || !googleEventTime.dateTime) return null;
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(googleEventTime.dateTime);
  if (!match) return null;
  return googleEventTime.dateTime;
}

function toCostaRicaDisplay(utcIso) {
  const ms = Date.parse(utcIso) + COSTA_RICA_OFFSET_MINUTES * 60_000;
  return new Date(ms).toISOString().replace("Z", "-06:00");
}

async function fetchCalendarEvents(serviceAccount, calendarId) {
  const accessToken = await getGoogleAccessToken(serviceAccount);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?singleEvents=true&maxResults=2500`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gcal_import_list_failed calendar=${calendarId} status=${res.status} body=${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.items || [];
}

// The dry-run plan: one row per Google event, classified against the
// target's existing resources + bookings. Pure given its inputs, so the
// same inputs always hash to the same plan (CTL-CAL-01).
function buildPlan(resources, existingBookings, eventsByResource) {
  const plan = [];
  for (const resource of resources) {
    const events = eventsByResource.get(resource.id) || [];
    for (const event of events) {
      const startIso = parseOffsetDateTime(event.start);
      const endIso = parseOffsetDateTime(event.end);
      if (!startIso || !endIso) {
        plan.push({ resource_id: resource.id, source_event_id: event.id, outcome: "needs_review", reason: "no_offset_or_all_day" });
        continue;
      }
      const conflict = existingBookings.some(
        (b) => b.resource_id === resource.id && b.start_at === startIso && b.end_at === endIso && b.status !== "cancelled"
      );
      plan.push({
        resource_id: resource.id,
        source_event_id: event.id,
        start_at_utc: startIso,
        start_at_costa_rica: toCostaRicaDisplay(startIso),
        end_at_utc: endIso,
        end_at_costa_rica: toCostaRicaDisplay(endIso),
        outcome: conflict ? "already_imported_or_conflict" : "new",
      });
    }
  }
  return plan;
}

function hashPlan(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

async function runDryRun(args) {
  const dbOpts = { remote: args.remote, persistTo: args.persistTo || DEFAULT_PERSIST_DIR };
  const resources = d1Query(args.target, dbOpts, "SELECT id, name, google_calendar_id FROM resources WHERE google_calendar_id IS NOT NULL");
  const existingBookings = d1Query(args.target, dbOpts, "SELECT resource_id, start_at, end_at, status FROM bookings");

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log("GOOGLE_SERVICE_ACCOUNT_JSON is not set -- cannot fetch Google Calendar events.");
    console.log(`Resources with a calendar configured in "${args.target}":`);
    for (const r of resources) console.log(`  - ${r.name} (${r.id}) -> ${r.google_calendar_id}`);
    console.log("Nothing was written.");
    return;
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const eventsByResource = new Map();
  for (const r of resources) {
    eventsByResource.set(r.id, await fetchCalendarEvents(serviceAccount, r.google_calendar_id));
  }

  const plan = buildPlan(resources, existingBookings, eventsByResource);
  const hash = hashPlan(plan);

  console.log(`Dry-run plan for "${args.target}" (${plan.length} Google event(s) across ${resources.length} resource(s)):`);
  for (const row of plan) console.log(`  ${row.outcome.padEnd(24)} ${row.resource_id} ${row.source_event_id} ${row.start_at_costa_rica || "(needs_review: " + row.reason + ")"}`);
  console.log("");
  console.log(`diff-sha256=${hash}`);
  console.log("Nothing was written. Re-run with --apply --diff-sha256=<hash above> to apply exactly this plan.");
}

async function runApply(args) {
  if (!args.target) throw new ImportRefused("--apply requires --target=<database name> (CTL-CAL-01)");
  if (!args.diffSha256) throw new ImportRefused("--apply requires --diff-sha256=<hash of the reviewed dry run> (CTL-CAL-01)");

  const dbOpts = { remote: args.remote, persistTo: args.persistTo || DEFAULT_PERSIST_DIR };

  // CTL-CAL-04 first and cheaply, before any Google call is made.
  requireNonPreview(args.target, dbOpts);

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new ImportRefused("GOOGLE_SERVICE_ACCOUNT_JSON is not set -- cannot recompute the dry run to check the hash");
  }
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const resources = d1Query(args.target, dbOpts, "SELECT id, name, google_calendar_id FROM resources WHERE google_calendar_id IS NOT NULL");
  const existingBookings = d1Query(args.target, dbOpts, "SELECT resource_id, start_at, end_at, status FROM bookings");
  const eventsByResource = new Map();
  for (const r of resources) eventsByResource.set(r.id, await fetchCalendarEvents(serviceAccount, r.google_calendar_id));
  const plan = buildPlan(resources, existingBookings, eventsByResource);
  const freshHash = hashPlan(plan);

  if (freshHash !== args.diffSha256) {
    // CTL-CAL-01 / GEN-30: a member rebooked (or anything else in the
    // source changed) between review and apply. Safe refusal -- the
    // reviewer re-runs the dry run and reviews the new plan.
    throw new ImportRefused(`stale diff: --diff-sha256=${args.diffSha256} does not match the plan recomputed now (${freshHash}); re-review and retry`);
  }

  // CTL-CAL-02: the import writes only through booking.js's own
  // exported functions, never a direct INSERT -- and that function
  // does not exist yet (see "Known gap" at the top of this file and
  // the per-part return). Refusing here, loudly, is correct: a
  // fabricated success would be worse than this.
  throw new ImportRefused(
    "apply_not_wired: src/portal/booking.js does not yet export an import-write function for this script to call through (CTL-CAL-02). Nothing was written."
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.target && !args.apply)) {
    printUsage();
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      console.log("");
      console.log("GOOGLE_SERVICE_ACCOUNT_JSON is not set -- there is nothing to import from Google yet.");
    }
    return;
  }

  if (args.apply) {
    await runApply(args);
    return;
  }

  if (!args.target) {
    throw new ImportRefused("--target=<database name> is required for a dry run");
  }
  await runDryRun(args);
}

main().catch((err) => {
  if (err instanceof ImportRefused) {
    console.error(`REFUSED: ${err.message}`);
    process.exit(1);
  }
  console.error(`gcal-import failed: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
