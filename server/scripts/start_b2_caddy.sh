#!/usr/bin/env bash
# B2: HTTP/3 static assets + WSS RVC (proxied to Node B1 WebSocket).
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v caddy >/dev/null 2>&1; then
  echo "Install Caddy v2+ (https://caddyserver.com/docs/install) and ensure 'caddy' is on PATH."
  exit 1
fi
echo "1) In another terminal, start B1 WebSocket-only:"
echo "   B1_STATIC_ENABLED=0 B1_HTTP_PORT=7080 node server_b1_http_rvc.js"
echo "2) Then this script runs Caddy on :7443 (edit Caddyfile.b2.example for host/certs)."
caddy run --config Caddyfile.b2.example
