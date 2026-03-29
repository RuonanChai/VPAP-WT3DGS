# VPAP-WT3DGS — Viewport- and LOD-Aware Prioritization over WebTransport for Tiled 3D Gaussian Splatting

This repository is a **standalone artifact**: VPAP scheduling on the **WebTransport `sendOrder`** API, a matching **browser client** path (stream ingestion + telemetry), **network emulation** notes, a **toy dataset layout**, and **plotting scripts** aligned with the paper’s figures.

---

## (a) System requirements

| Component | Notes |
|-----------|--------|
| **Node.js** | ≥ 20 (`@fails-components/webtransport`) |
| **OS** | Linux recommended for `tc`; macOS/Windows OK for server + local browser |
| **Browser** | Chromium with WebTransport enabled |
| **TLS** | Use [mkcert](https://github.com/FiloSottile/mkcert) or your CA; cert SAN must match the WebTransport URL host/IP |
| **Python** (plots) | 3.10+; see `analysis_and_plotting/requirements.txt` |

---

## (b) Quick start — run each baseline

**Prerequisites (all baselines):** populate `dataset/toy_example/` per `dataset/README.md` (splats, `custom_bounding_boxes_mapping-campus2.json`, `reference_manifest.json`). For WebTransport (B3/B4), place TLS files under `server/certs/` (`web3d.local.pem`, `web3d.local-key.pem`) or set `VPAP_TLS_*` / `VPAP_CERT_DIR`.

```bash
cd server
npm install
```

### B1 — HTTP/1.1 static + WebSocket RVC

Starts **HTTP/1.1** file server and a **WebSocket** RVC endpoint on the same port (default **7080**).

```bash
cd server
npm run start:b1
```

- Static root: `../dataset/toy_example` (override with `VPAP_ASSETS_DIR`).
- WebSocket URL path: **`/rvc`** (override with `B1_WS_PATH`).
- **Viewer:** `rcServerAddress` = `ws://<host>:7080/rvc`, `resourcesBaseUrl` = `http://<host>:7080/`, `gsResource` = `http://<host>:7080/20_lod/`, `schedulingStrategy` ≠ `webtransport` and not a `webtransport://` URL.

HTTP pull + RVC flow is summarized in **`client/HTTP_PULL_AND_RVC.md`**.

### B2 — HTTP/3 static + WSS (Caddy) + same RVC logic as B1

B2 uses **Caddy** for **HTTP/3** static serving and proxies **`/rvc`** to the Node B1 WebSocket server.

**Terminal A — WebSocket only (no static files from Node):**

```bash
cd server
# Linux / macOS / Git Bash
B1_STATIC_ENABLED=0 B1_HTTP_PORT=7080 node server_b1_http_rvc.js
```

```cmd
REM Windows CMD
set B1_STATIC_ENABLED=0
set B1_HTTP_PORT=7080
node server_b1_http_rvc.js
```

**Terminal B — Caddy (edit `server/Caddyfile.b2.example` for host/certs if needed):**

```bash
cd server
./scripts/start_b2_caddy.sh
```

On Windows: `powershell -ExecutionPolicy Bypass -File scripts\start_b2_caddy.ps1`

- **Viewer:** `resourcesBaseUrl` / `gsResource` → `https://<host>:7443/…`, `rcServerAddress` → `wss://<host>:7443/rvc` (trust the same CA as in the Caddyfile).

### B3 — WebTransport, flat `sendOrder` (native WT baseline)

```bash
cd server
npm run start:b3
```

Default: UDP **9444**, path **`/wt`**. Client: `webtransport://<host>:9444/wt`, `schedulingStrategy: 'webtransport'`.

### B4 — VPAP (WebTransport + viewport/LOD-aware `sendOrder`)

```bash
cd server
npm run start:vpap
```

Default: UDP **8444**, path **`/wt`**. Client: `webtransport://<host>:8444/wt`, `schedulingStrategy: 'webtransport'`.

### Client modules

Under **`client/`**: **`SLM2Loader.js`** (WT + WebSocket + HTTP pull), **`TileTelemetry.js`**, **`SpatioTemporalQoETracker.js`**. Integrate into your viewer bundle; see **`client/README.md`** and **`client/HTTP_PULL_AND_RVC.md`**.

---

## (c) Reproducing experiments — network / Mininet

See **`network_emulation/README.md`** and **`network_emulation/tc_shape_example.sh`** for Linux **netem** delay/loss.

**Mininet:** we applied the **same** emulated network (bandwidth, delay, loss, queue discipline on the bottleneck between server and client) for **B1, B2, B3, and VPAP (B4)**. Only the server stack and client endpoints change across baselines; **do not** change `tc`/Mininet parameters between runs you intend to compare.

For Mininet topology, place the tile server(s) and the browser host on the correct sides of the bottleneck and document the identical profile in your paper’s experimental setup section.

---

## (d) Code structure

| Directory | Contents |
|-----------|----------|
| **`server/`** | `server_vpap.js` (B4), `server_baseline_flat_sendorder.js` (B3), **`server_b1_http_rvc.js` (B1)**, `Caddyfile.b2.example` + **`scripts/start_b2_caddy.*` (B2)**, `tileSelection.js`, `StreamMetrics.js`, `VPAP_SCHEDULING.md`, **`README.md`** |
| **`client/`** | `SLM2Loader.js` (WT + WebSocket + HTTP pull), `TileTelemetry`, `SpatioTemporalQoETracker`, **`HTTP_PULL_AND_RVC.md`** |
| **`network_emulation/`** | `tc` example + README |
| **`dataset/`** | Toy layout, examples, **no large binaries** in git by default (see `.gitignore`) |
| **`analysis_and_plotting/`** | `fig1_qoe/`, **`fig2_throughput/`** (`Fig2A_Throughput.py`, `Fig2B_Efficiency.py`), `fig3_cpu_memory/` — Matplotlib scripts (inputs: aggregated CSVs from your evaluation pipeline) |

---

## Anonymous mirror workflow

1. Push this tree to a **public** GitHub repo (see **`GITHUB_SETUP.md`**).
2. Open [anonymous.4open.science](https://anonymous.4open.science/dashboard) → **Anonymize your repository** → paste the **GitHub repo URL**.
3. Use the generated `https://anonymous.4open.science/r/...` link in the paper.

---

## License

MIT (see `LICENSE` if present; otherwise follow your institution’s default).
