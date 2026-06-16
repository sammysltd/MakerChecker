#!/usr/bin/env bash
# End-to-end smoke for the runnable examples. Boots a throwaway Postgres + the
# seeded server, runs each demo against it, asserts expected output, tears down.
# The live-agent capstone runs only when GEMINI_API_KEY is set (it calls a real
# model); the deterministic demos always run.
#
#   bash scripts/e2e-examples.sh
#
# Requires PostgreSQL 17 binaries (brew install postgresql@17) and a built repo
# (corepack pnpm run build). Set PG_BIN to override the postgres bin directory.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"

find_pg_bin() {
  for d in "${PG_BIN:-}" /usr/local/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@17/bin /usr/lib/postgresql/17/bin /usr/local/bin; do
    [ -n "$d" ] && [ -x "$d/initdb" ] && { echo "$d"; return; }
  done
  command -v initdb >/dev/null 2>&1 && { echo ""; return; }
  echo "NO_PG"
}
PGBIN="$(find_pg_bin)"
[ "$PGBIN" = "NO_PG" ] && { echo "No postgres binaries found (set PG_BIN or install postgresql@17)."; exit 1; }
pg() { if [ -n "$PGBIN" ]; then "$PGBIN/$1" "${@:2}"; else "$1" "${@:2}"; fi; }

PGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mc-e2e-pg.XXXXXX")"
DATADIR="$(mktemp -d "${TMPDIR:-/tmp}/mc-e2e-data.XXXXXX")"
SRVLOG="$(mktemp "${TMPDIR:-/tmp}/mc-e2e-srv.XXXXXX.log")"
PGPORT=$((20000 + RANDOM % 9000))
SRVPORT=3939
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  pg pg_ctl -D "$PGDIR" -m fast stop >/dev/null 2>&1
  rm -rf "$PGDIR" "$DATADIR" "$SRVLOG" 2>/dev/null
}
trap cleanup EXIT

echo "== provision postgres on :$PGPORT =="
pg initdb -D "$PGDIR" -U postgres -A trust >/dev/null 2>&1 || { echo "initdb FAILED"; exit 1; }
pg pg_ctl -D "$PGDIR" -o "-p $PGPORT -c listen_addresses=127.0.0.1" -w start -l "$PGDIR/log" >/dev/null 2>&1 || { echo "pg start FAILED"; cat "$PGDIR/log"; exit 1; }
DBURL="postgres://postgres@127.0.0.1:$PGPORT/makerchecker"
pg psql "postgres://postgres@127.0.0.1:$PGPORT/postgres" -c "CREATE DATABASE makerchecker" >/dev/null 2>&1 || { echo "createdb FAILED"; exit 1; }

echo "== start server on :$SRVPORT (seeded, auth disabled) =="
cd "$REPO" || exit 1
DATABASE_URL="$DBURL" MAKERCHECKER_SEED_DEMO=1 MAKERCHECKER_AUTH_DISABLED=1 \
  MAKERCHECKER_DISABLE_RATE_LIMIT=1 \
  DEMO_DATA_DIR="$REPO/examples" MAKERCHECKER_DATA_DIR="$DATADIR" PORT=$SRVPORT \
  node packages/server/dist/index.js > "$SRVLOG" 2>&1 &
SERVER_PID=$!
ok=0
for i in $(seq 1 60); do
  curl -fsS "http://localhost:$SRVPORT/healthz" >/dev/null 2>&1 && { ok=1; break; }
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "SERVER DIED:"; tail -40 "$SRVLOG"; exit 1; }
  sleep 1
done
[ "$ok" = 1 ] || { echo "healthz TIMEOUT:"; tail -40 "$SRVLOG"; exit 1; }
echo "server healthy."

export MAKERCHECKER_URL="http://localhost:$SRVPORT"
PASS=0; FAIL=0
run_demo() {
  local name="$1" script="$2" expect="$3"
  echo; echo "---------- $name ----------"
  local out rc
  out="$(node "$script" 2>&1)"; rc=$?
  echo "$out" | tail -16
  if [ $rc -eq 0 ] && echo "$out" | grep -qiE "$expect"; then echo "[$name] PASS"; PASS=$((PASS+1))
  else echo "[$name] FAIL (rc=$rc; expected /$expect/)"; FAIL=$((FAIL+1)); fi
}

run_demo "sdk-demo (daily-cash-reconciliation)" "examples/sdk-demo.mjs" "audit chain: ok=true"
run_demo "governed-tool-demo (deny + SoD)" "examples/middleware/governed-tool-demo.mjs" "audit chain: ok=true"
run_demo "langchain connector demo" "examples/connectors/langchain/governed-langchain-demo.mjs" "denied"

# Live-agent capstone: a real Gemini agent blocked by the argument-level grant
# policy. Runs only with a key (calls a real model); skipped otherwise.
if [ -n "${GEMINI_API_KEY:-}" ]; then
  echo "== seed wallet-agent role with a destination allowlist on transfer@1 =="
  pg psql "$DBURL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO roles (name, limits)
  VALUES ('wallet-role', '{"skills":{"transfer@1":{"allowlist":{"field":"destination","values":["0xSAFE"]}}}}');
INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
  VALUES ('transfer', 1, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING;
INSERT INTO agents (name, role_id) SELECT 'wallet-agent', id FROM roles WHERE name='wallet-role';
INSERT INTO role_skill_grants (role_id, skill_id)
  SELECT r.id, s.id FROM roles r, skills s WHERE r.name='wallet-role' AND s.name='transfer' AND s.version=1;
SQL
  run_demo "live Gemini agent (arg-policy block)" "examples/connectors/langchain/live-agent-arg-policy-demo.mjs" "BLOCKED.*limit_allowlist"
else
  echo; echo "---------- live Gemini agent: SKIPPED (set GEMINI_API_KEY to run) ----------"
fi

# Incident scenarios: each example configures MakerChecker for a real-world
# rogue-AI incident, drives a governed agent through the proxy, and verifies the
# audit chain. Each ends with a verified chain when its control fires.
for demo in "$REPO"/examples/*/demo.mjs; do
  run_demo "incident: $(basename "$(dirname "$demo")")" "$demo" "audit chain: ok=true"
done

echo; echo "================ SUMMARY: PASS=$PASS FAIL=$FAIL ================"
[ "$FAIL" = 0 ]
