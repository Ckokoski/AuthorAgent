#!/usr/bin/env bash
#
# AuthorClaw smoke test
# ─────────────────────
# Boots the gateway and verifies that bearer-token auth (security review item #1)
# is enforced. Covers startup, the /api/* gate, the dashboard token injection,
# and the AUTHORCLAW_AUTH_DISABLED=1 escape hatch.
#
# Hermetic and non-destructive:
#   - Supplies AUTHORCLAW_AUTH_TOKEN via the environment, so the server uses a
#     known token and never generates/writes one to .env.
#   - Binds 127.0.0.1 only (never exposes the LAN, even in the auth-disabled phase).
#   - Uses the project's normal vault-key handling and does not modify .env.
#
# Usage:
#   tests/smoke-test.sh        # quiet — prints [PASS]/[FAIL] per check
#   tests/smoke-test.sh -v     # verbose — also streams the captured server log
#
# Exit: 0 = all checks passed, 1 = a check failed, 2 = preflight error.

set -uo pipefail

HOST=127.0.0.1
PORT=3847
BASE="http://${HOST}:${PORT}"
TEST_TOKEN="smoke-test-token-0123456789abcdef"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

SERVER_LOG="$(mktemp)"
SERVER_PID=""
FAILED=0

log()  { printf '%s\n' "$*"; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; FAILED=1; }

cleanup() {
  stop_server
  if [ "$VERBOSE" -eq 1 ] || [ "$FAILED" -ne 0 ]; then
    log ""
    log "── captured server log ──"
    cat "$SERVER_LOG"
  fi
  rm -f "$SERVER_LOG"
}
trap cleanup EXIT

# code <curl-args...> : print the HTTP status code for a request
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }

# acao <origin> <curl-args...> : print the Access-Control-Allow-Origin response
# header the server returns for a request carrying that Origin (empty if none).
acao() {
  local origin="$1"; shift
  curl -s -D - -o /dev/null --max-time 5 -H "Origin: $origin" "$@" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}'
}

# rheader <name> <curl-args...> : print the named response header's value (empty if absent)
rheader() {
  local name="$1"; shift
  curl -s -D - -o /dev/null --max-time 5 "$@" \
    | tr -d '\r' | awk -v n="$(printf '%s' "$name" | tr 'A-Z' 'a-z')" \
        -F': ' 'tolower($1)==n{sub(/^[^:]*: /,"");print}'
}

# start_server <extra-env=val...> : launch the gateway and wait until it serves
start_server() {
  : > "$SERVER_LOG"
  env AUTHORCLAW_BIND="$HOST" "$@" \
    node --import tsx "$ROOT_DIR/gateway/src/index.ts" > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  local i
  for i in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "$BASE/" && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || { log "ERROR: server exited during startup"; return 1; }
    sleep 0.5
  done
  log "ERROR: server did not become ready within timeout"
  return 1
}

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null
  local i
  for i in $(seq 1 25); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.2; done
  SERVER_PID=""
}

# ════════════════════════════════════════════════════════════
log "AuthorClaw smoke test"

# Preflight: the port must be free so we test our own process, not a stray one.
if curl -s -o /dev/null --max-time 2 "$BASE/" 2>/dev/null; then
  log "ERROR: something is already listening on ${BASE} — stop it before running the smoke test."
  exit 2
fi

# ── Phase 1: auth ENABLED ──
log ""
log "Phase 1: startup + bearer-token auth enforced"
start_server AUTHORCLAW_AUTH_TOKEN="$TEST_TOKEN" || exit 1
pass "server started and serves ${BASE}/"

[ "$(code "$BASE/api/status")" = "401" ] \
  && pass "no token -> 401" || fail "no token should be 401"

[ "$(code -H "Authorization: Bearer $TEST_TOKEN" "$BASE/api/status")" = "200" ] \
  && pass "valid bearer -> 200" || fail "valid bearer should be 200"

[ "$(code "$BASE/api/status?token=$TEST_TOKEN")" = "200" ] \
  && pass "valid ?token= query -> 200" || fail "valid ?token= query should be 200"

[ "$(code -H "Authorization: Bearer wrong-token" "$BASE/api/status")" = "401" ] \
  && pass "wrong token -> 401" || fail "wrong token should be 401"

HTML="$(curl -s --max-time 5 "$BASE/")"
case "$HTML" in
  *"__AUTHORCLAW_AUTH_TOKEN__"*) fail "dashboard still contains the unsubstituted token placeholder" ;;
  *"$TEST_TOKEN"*)               pass "dashboard / serves with token injected" ;;
  *)                             fail "dashboard / missing injected token" ;;
esac

# CORS unset -> deny: a cross-origin request gets no Access-Control-Allow-Origin.
[ -z "$(acao "http://evil.example" -H "Authorization: Bearer $TEST_TOKEN" "$BASE/api/status")" ] \
  && pass "CORS: cross-origin denied by default (no Access-Control-Allow-Origin)" \
  || fail "CORS: disallowed origin unexpectedly got an Access-Control-Allow-Origin"

# CSP: connect-src is tightened to 'self' (no permissive "*"). The dashboard only
# ever fetches its own origin, so the directive must be exactly "connect-src 'self'".
CSP="$(rheader content-security-policy "$BASE/")"
case "$CSP" in
  *"connect-src 'self';"*|*"connect-src 'self'") pass "CSP: connect-src is 'self'" ;;
  *)                                             fail "CSP: connect-src not tightened to 'self' (got: $CSP)" ;;
esac
case "$CSP" in
  *"connect-src"*"*"*) fail "CSP: connect-src still contains a permissive '*'" ;;
  *)                   pass "CSP: connect-src has no permissive '*'" ;;
esac

stop_server

# ── Phase 2: auth DISABLED escape hatch ──
log ""
log "Phase 2: AUTHORCLAW_AUTH_DISABLED=1 escape hatch"
start_server AUTHORCLAW_AUTH_DISABLED=1 || exit 1

grep -q "AUTH DISABLED" "$SERVER_LOG" \
  && pass "startup prints the AUTH DISABLED warning" || fail "missing AUTH DISABLED warning"

[ "$(code "$BASE/api/status")" = "200" ] \
  && pass "auth disabled, no token -> 200" || fail "auth disabled should allow 200"

stop_server

# ── Phase 3: CORS allowlist (AUTHORCLAW_CORS_ORIGINS) ──
log ""
log "Phase 3: CORS allowlist"
ALLOWED="http://allowed.test:9999"
start_server AUTHORCLAW_AUTH_TOKEN="$TEST_TOKEN" AUTHORCLAW_CORS_ORIGINS="$ALLOWED" || exit 1

[ "$(acao "$ALLOWED" -H "Authorization: Bearer $TEST_TOKEN" "$BASE/api/status")" = "$ALLOWED" ] \
  && pass "CORS: listed origin echoed in Access-Control-Allow-Origin" \
  || fail "CORS: listed origin not echoed"

[ -z "$(acao "http://other.test:1234" -H "Authorization: Bearer $TEST_TOKEN" "$BASE/api/status")" ] \
  && pass "CORS: unlisted origin gets no Access-Control-Allow-Origin" \
  || fail "CORS: unlisted origin unexpectedly allowed"

stop_server

# ── Phase 4: source-IP allowlist (AUTHORCLAW_ALLOWED_IPS + trust-proxy) ──
# Trust-proxy lets us drive the client IP via X-Forwarded-For so allow/deny is
# deterministic from loopback. Allowlist = one exact IP + one CIDR.
log ""
log "Phase 4: source-IP allowlist"
start_server AUTHORCLAW_AUTH_TOKEN="$TEST_TOKEN" \
             AUTHORCLAW_ALLOWED_IPS="203.0.113.7,10.0.0.0/24" \
             AUTHORCLAW_TRUST_PROXY=1 || exit 1
AUTHH=(-H "Authorization: Bearer $TEST_TOKEN")

grep -q "IP allowlist: 2 rule(s) enforced" "$SERVER_LOG" \
  && pass "startup logs the enforced allowlist" || fail "missing IP-allowlist enforcement log"

[ "$(code "${AUTHH[@]}" -H "X-Forwarded-For: 203.0.113.7" "$BASE/api/status")" = "200" ] \
  && pass "listed IP (via XFF) -> 200" || fail "listed IP should be 200"

[ "$(code "${AUTHH[@]}" -H "X-Forwarded-For: 10.0.0.55" "$BASE/api/status")" = "200" ] \
  && pass "IP inside listed CIDR -> 200" || fail "CIDR member should be 200"

[ "$(code "${AUTHH[@]}" -H "X-Forwarded-For: 203.0.113.9" "$BASE/api/status")" = "403" ] \
  && pass "unlisted IP -> 403 (in front of auth, even with valid token)" || fail "unlisted IP should be 403"

[ "$(code "${AUTHH[@]}" "$BASE/api/status")" = "200" ] \
  && pass "loopback (no XFF) always allowed (recovery path)" || fail "loopback should be allowed"

stop_server

# ── Result ──
log ""
if [ "$FAILED" -eq 0 ]; then
  log "All smoke checks passed."
  exit 0
fi
log "Smoke test FAILED."
exit 1
