#!/usr/bin/env bash
# B2: Caddy HTTP/3 static (see Caddyfile.b2.example)
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v caddy >/dev/null 2>&1; then
  echo "Install Caddy v2+ (https://caddyserver.com/docs/install) and ensure 'caddy' is on PATH."
  exit 1
fi
caddy run --config Caddyfile.b2.example
