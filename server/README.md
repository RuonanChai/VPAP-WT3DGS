# Server programs (baselines)

| Command | Baseline | Description |
|---------|----------|-------------|
| `npm run start:b1` | **B1** | HTTP/1.1 static files + WebSocket RVC on `ws://…:7080/rvc` (default). Env: `B1_HTTP_PORT`, `VPAP_ASSETS_DIR`, `B1_STATIC_ENABLED` (`0` = WebSocket only for pairing with Caddy B2). |
| `npm run start:b3` | **B3** | WebTransport **flat** `sendOrder` (`server_baseline_flat_sendorder.js`), UDP **9444**, path `/wt`. |
| `npm run start:vpap` | **B4 / VPAP** | WebTransport + viewport/LOD-aware `sendOrder` (`server_vpap.js`), UDP **8444**, path `/wt`. |

**B2 (HTTP/3 pull):** not a separate Node binary. Install [Caddy](https://caddyserver.com/), start B1 with `B1_STATIC_ENABLED=0`, then run `scripts/start_b2_caddy.sh` or `scripts/start_b2_caddy.ps1` (uses `Caddyfile.b2.example`).

TLS: reuse `server/certs/` (same as WebTransport) or set paths inside the Caddyfile.

See the repository root **`README.md`** for Mininet / `tc` and client URLs.
