#!/usr/bin/env bash
# Restart B4 WebTransport server (server_vpap.js) with a scheduling policy (C2 ablation).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_DIR="$ARTIFACT_ROOT/server"
LOG_DIR="${VPAP_LOG_DIR:-$ARTIFACT_ROOT/logs/_service_logs}"
POLICY="${1:-vpap}"
PORT="${VPAP_PORT:-8444}"

mkdir -p "$LOG_DIR"
PIDFILE="$LOG_DIR/b4_wt.pid"
LOGFILE="$LOG_DIR/b4_wt.log"

if [[ -f "$PIDFILE" ]]; then
  OLD_PID="$(cat "$PIDFILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[restart] stopping pid=$OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PIDFILE"
fi

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/udp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  lsof -ti "UDP:${PORT}" | xargs -r kill -9 2>/dev/null || true
fi

sleep 1
echo "[restart] starting policy=$POLICY port=$PORT"
(
  cd "$SERVER_DIR"
  export VPAP_SCHEDULE_POLICY="$POLICY"
  export VPAP_PORT="$PORT"
  # Optional: VPAP_OVERHEAD_LOG, VPAP_ALPHA/BETA/TAU, VPAP_ASSETS_DIR, TLS env
  node server_vpap.js >>"$LOGFILE" 2>&1
) &
echo $! >"$PIDFILE"
sleep 3

if grep -q "Schedule policy:" "$LOGFILE" 2>/dev/null; then
  grep "Schedule policy:" "$LOGFILE" | tail -1
else
  echo "[restart] server log: $LOGFILE"
fi
