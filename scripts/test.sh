#!/usr/bin/env bash
# PIN-16 test harness. Runs entirely against local D1 and a local
# `wrangler dev` -- nothing here ever touches a remote resource, and
# --remote is never passed to a d1 command.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== CTL-SEC-01: secret scan (tracked + untracked, not-ignored files) =="
# whsec_local_test_only (S-13) never matches this pattern -- it has no
# run of 10+ alphanumerics after the prefix -- so it needs no special
# exemption; a real key or webhook secret, which does, still fails.
MATCHES=$(git ls-files --cached --others --exclude-standard -z \
  | xargs -0 grep -lE 'sk_live_[A-Za-z0-9]{10,}|sk_test_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}' 2>/dev/null || true)
if [ -n "$MATCHES" ]; then
  echo "SECRET SCAN FAILED, offending files:" >&2
  echo "$MATCHES" >&2
  exit 1
fi
echo "ok: no live-looking secret found."

# Local D1 state is persisted OUTSIDE the project tree. `[assets]
# directory = "./"` makes wrangler watch the whole repo to serve/rebuild
# it; persisting state inside the repo (the default .wrangler/state) made
# every query's SQLite WAL write look like a source change to that
# watcher, which reloaded the server, which re-ran the health-check
# request below, which wrote the WAL again -- an infinite "Reloading
# local server..." loop that never reached "Ready on". Persisting
# outside the watched tree breaks that loop.
#
# portal(FR1): JP_TEST_PORT/JP_TEST_STATE/JP_TEST_INSPECTOR_PORT are all
# overridable (default unchanged) so two invocations of this script --
# e.g. this fix round's own full-suite run alongside another part's --
# never collide on the same port, D1 persist dir or inspector socket.
PORT="${JP_TEST_PORT:-8799}"
PERSIST_DIR="${JP_TEST_STATE:-/tmp/jp-portal-test-d1-state}"
INSPECTOR_PORT="${JP_TEST_INSPECTOR_PORT:-9229}"
# The server log is per-port so two suite runs never write one file. Tests
# that assert a log line (the webhook dispatcher's "ignored" line) read it
# through PORTAL_TEST_SERVER_LOG.
SERVER_LOG="${JP_TEST_SERVER_LOG:-/tmp/jp-portal-test-server-$PORT.log}"

# Refuse to run if something already listens on the test port or the
# inspector port. Otherwise `wrangler dev` fails to start, the readiness
# loop below is answered by the OTHER service, and every test runs against
# the wrong server (seen on 2026-10-04: port 8811 belonged to a bun service).
for busy_port in "$PORT" "$INSPECTOR_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${busy_port}$"; then
    echo "port $busy_port is already in use; set JP_TEST_PORT and JP_TEST_INSPECTOR_PORT to free ports" >&2
    exit 2
  fi
done

echo "== Local D1: reset + apply migrations + seed (port=$PORT state=$PERSIST_DIR) =="
rm -rf "$PERSIST_DIR"
npx wrangler d1 migrations apply PORTAL_DB --local --persist-to "$PERSIST_DIR"
npx wrangler d1 execute PORTAL_DB --local --persist-to "$PERSIST_DIR" --file=scripts/seed-preview.sql

# portal(QA3): LOCAL-ONLY QA fixture, loaded AFTER the preview seed, into
# the same ephemeral --persist-to D1 only. Never --remote, never run
# against the real preview D1 -- see tests/fixtures/seed-test.sql's own
# header for why it exists (demo-account starvation, S-1 e).
echo "== Local D1: QA-only fixture (tests/fixtures/seed-test.sql) =="
npx wrangler d1 execute PORTAL_DB --local --persist-to "$PERSIST_DIR" --file=tests/fixtures/seed-test.sql

echo "== Starting wrangler dev --local on :$PORT (inspector :$INSPECTOR_PORT) =="
# GLOW_LIST_KEY is a throwaway value for the local server only; the webhook
# dispatcher test reads Glow's list view with it to see a signup turn paid.
PORTAL_DEV_LOGIN=1 STRIPE_WEBHOOK_SECRET=whsec_local_test_only \
  npx wrangler dev --local --port "$PORT" --inspector-port "$INSPECTOR_PORT" --persist-to "$PERSIST_DIR" \
  --var PORTAL_DEV_LOGIN:1 --var STRIPE_WEBHOOK_SECRET:whsec_local_test_only --var GLOW_LIST_KEY:glow-list-key-local-test \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "Waiting for the server to answer..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/portal/me"; then
    break
  fi
  sleep 1
done

echo "== Running node --test (black-box HTTP against :$PORT) =="
set +e
# This Node build does not glob a directory passed directly to --test
# (confirmed: `node --test tests` fails with MODULE_NOT_FOUND even
# though `node --test tests/some.test.mjs` works), so the test files are
# collected explicitly with `find` instead of passing the directory.
# --test-concurrency=1: every foundation test shares one local D1
# against the one running server, so test FILES must run serially (a
# test file that mutates portal_meta or accounts restores it afterwards,
# but two files doing that at once would race).
# --test-timeout (portal(FR1), raised by QA3): a hung request/assertion
# fails that one test/file instead of hanging the whole suite (and this
# script's caller) indefinitely. QA3 (2026-10-01) raised 60000ms ->
# 180000ms: on this shared host, `d1()` (tests/foundation/helpers.mjs)
# spins up a real `wrangler d1 execute` CLI process per call, and
# several OTHER seats' `wrangler dev`/`d1 execute` processes were
# running concurrently against the same box at QA3's dispatch time
# (confirmed via `ps aux` -- ports 8891/8901/8981/8991/18921 etc., none
# of them this run's own) -- under that contention a single d1() call
# that normally takes well under a second took 10-30s, and files with
# several d1() calls per test blew the old 60s ceiling before their own
# assertions ever got a chance to run (a harness/environment failure,
# not a product one; named rather than silently raised without record).
# JP_TEST_FILES (space-separated paths) runs just those files against the same
# server, for a quick check while building. Unset, the whole suite runs.
TEST_FILES="${JP_TEST_FILES:-$(find tests -name '*.test.mjs' | sort)}"
PORTAL_TEST_BASE_URL="http://127.0.0.1:$PORT" PORTAL_TEST_PERSIST_DIR="$PERSIST_DIR" PORTAL_TEST_SERVER_LOG="$SERVER_LOG" \
  node --test --test-concurrency=1 --test-timeout=180000 --test-reporter=spec $TEST_FILES
STATUS=$?
set -e

kill "$SERVER_PID" 2>/dev/null || true
trap - EXIT
exit $STATUS
