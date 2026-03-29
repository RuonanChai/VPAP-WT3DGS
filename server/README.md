# Server programs (baselines)

| Command | Baseline | Role |
|---------|----------|------|
| `npm run start:b1` | **B1** | **Caddy** HTTP/1.1 static (`Caddyfile.b1.example`) — paper-accurate pull baseline. |
| `npm run start:b1:ws-rvc` | *(optional)* | Node HTTP + WebSocket RVC (`server_b1_http_rvc.js`) for `SLM2Loader` WS mode only; **not** the paper B1 setup. |
| `npm run start:b2` | **B2** | **Caddy** HTTP/3 static (`Caddyfile.b2.example`). |
| `npm run start:b3` | **B3** | WebTransport flat `sendOrder`, UDP **9444**, `/wt`. |
| `npm run start:vpap` | **B4** | VPAP WebTransport, UDP **8444**, `/wt`. |

Install [Caddy](https://caddyserver.com/) for B1/B2. TLS for B2/B3/B4: `server/certs/` or paths in Caddyfile / `VPAP_TLS_*`.

See the repository root **`README.md`** for Mininet / `tc` and viewer URLs.
