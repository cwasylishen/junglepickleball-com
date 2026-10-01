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
PERSIST_DIR="/tmp/jp-portal-test-d1-state"

echo "== Local D1: reset + apply migrations + seed =="
rm -rf "$PERSIST_DIR"
npx wrangler d1 migrations apply PORTAL_DB --local --persist-to "$PERSIST_DIR"
npx wrangler d1 execute PORTAL_DB --local --persist-to "$PERSIST_DIR" --file=scripts/seed-preview.sql

echo "== Starting wrangler dev --local on :8799 =="
PORTAL_DEV_LOGIN=1 STRIPE_WEBHOOK_SECRET=whsec_local_test_only \
  npx wrangler dev --local --port 8799 --persist-to "$PERSIST_DIR" \
  --var PORTAL_DEV_LOGIN:1 --var STRIPE_WEBHOOK_SECRET:whsec_local_test_only \
  > /tmp/jp-portal-test-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "Waiting for the server to answer..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:8799/api/portal/me"; then
    break
  fi
  sleep 1
done

echo "== Running node --test (black-box HTTP against :8799) =="
set +e
# This Node build does not glob a directory passed directly to --test
# (confirmed: `node --test tests` fails with MODULE_NOT_FOUND even
# though `node --test tests/some.test.mjs` works), so the test files are
# collected explicitly with `find` instead of passing the directory.
# --test-concurrency=1: every foundation test shares one local D1
# against the one running server, so test FILES must run serially (a
# test file that mutates portal_meta or accounts restores it afterwards,
# but two files doing that at once would race).
TEST_FILES=$(find tests -name '*.test.mjs' | sort)
PORTAL_TEST_BASE_URL="http://127.0.0.1:8799" PORTAL_TEST_PERSIST_DIR="$PERSIST_DIR" \
  node --test --test-concurrency=1 --test-reporter=spec $TEST_FILES
STATUS=$?
set -e

kill "$SERVER_PID" 2>/dev/null || true
trap - EXIT
exit $STATUS
