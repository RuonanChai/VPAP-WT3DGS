# VPAP-WT3DGS — Research artifact and reproduction package

**Viewport- and LOD-aware prioritization over WebTransport for tiled 3D Gaussian splatting**

This repository provides the standalone artifact for reproducing the evaluation in our paper. It implements a unified 3D Gaussian Splatting (3DGS) streaming testbed to compare four transport strategies under strictly controlled fairness: legacy pull-based protocols (HTTP/1.1 and HTTP/3), naive push (vanilla WebTransport), and our proposed VPAP (Viewport- and LOD-Aware Prioritization over WebTransport).

To facilitate end-to-end reproducibility, this repository includes the complete evaluation pipeline: client/server modules, network emulation configurations, a sample dataset layout, and automated plotting scripts to generate the paper’s figures.

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

## (b) Quick start — reproducing the baselines

**Prerequisites (all baselines):** Populate `dataset/toy_example/` per `dataset/README.md` (splats, `custom_bounding_boxes_mapping-campus2.json`, `reference_manifest.json`). **B1/B2** require [Caddy](https://caddyserver.com/) v2+. **B3/B4** require TLS material under `server/certs/` (`web3d.local.pem`, `web3d.local-key.pem`) or `VPAP_TLS_*` / `VPAP_CERT_DIR`.

```bash
cd server
npm install
```

### B1

**Paper baseline:** HTTP/1.1 **pull** only — **Caddy** serves static tiles ( **`protocols h1`**, `Cache-Control: no-store` ). Tile **scheduling is on the client** (`useLocalRVC: true`, empty `rcServerAddress`); this matches the authors’ **`campus2_bounding_boxes-HTTP1.1`** + **`slm2viewer_HTTP1.1`** workflow (those trees are not vendored here).

**In this repository**, run the portable analogue:

```bash
cd server
npm run start:b1
```

(`caddy run --config Caddyfile.b1.example` — default **8080**, URLs under **`/assets/…`** mapped to `dataset/toy_example/`.)

**Viewer:** `resourcesBaseUrl` = `http://<host>:8080/assets`, `gsResource` = `http://<host>:8080/assets/20_lod/`, `useLocalRVC: true`, `rcServerAddress: ""`, `schedulingStrategy` not `webtransport`.

**Optional:** `npm run start:b1:ws-rvc` runs **`server_b1_http_rvc.js`** — a **Node** shim for the extracted `SLM2Loader` **WebSocket** RVC path only (default mount **`/rvc`**, configurable via `B1_WS_PATH`). That is **not** the paper’s B1 transport.

Details: **`client/HTTP_PULL_AND_RVC.md`**.

### B2

**Paper baseline:** same pull + **client-side RVC** as B1, over **HTTP/3** (Caddy **`protocols h1 h2 h3`**, TLS), parallel to **`campus2_bounding_boxes-caddy_HTTP3`** and the corresponding viewer build — **no WebSocket** RVC.

```bash
cd server
npm run start:b2
```

(or `./scripts/start_b2_caddy.sh` / `scripts\start_b2_caddy.ps1` — same `Caddyfile.b2.example`, default HTTPS **8543**; edit hosts / Caddyfile for `web3d.local` if needed.)

**Viewer:** `resourcesBaseUrl` = `https://<host>:8543/assets`, `gsResource` = `https://<host>:8543/assets/20_lod/`, `useLocalRVC: true`, `rcServerAddress: ""`. Trust the cert in `server/certs/`.

### B3

WebTransport **push** with **uniform** `sendOrder` (vanilla WT baseline).

```bash
cd server
npm run start:b3
```

UDP **9444**, path **`/wt`**. Client: `webtransport://<host>:9444/wt`, `schedulingStrategy: 'webtransport'`.

### B4

WebTransport **push** with **VPAP** (`sendOrder` by viewport/LOD).

```bash
cd server
npm run start:vpap
```

UDP **8444**, path **`/wt`**. Client: `webtransport://<host>:8444/wt`, `schedulingStrategy: 'webtransport'`.

### Client integration

**`client/`:** **`SLM2Loader.js`**, **`TileTelemetry.js`**, **`SpatioTemporalQoETracker.js`** — see **`client/README.md`**.


---

## (c) Reproducing experiments — network / Mininet

See **`network_emulation/README.md`** and **`network_emulation/tc_shape_example.sh`** for Linux **netem** delay/loss.

**Mininet:** we applied the **same** emulated network (bandwidth, delay, loss, queue discipline on the bottleneck between server and client) for **B1, B2, B3, and VPAP (B4)**. Only the server stack and client endpoints change across baselines; **do not** change `tc`/Mininet parameters between runs you intend to compare.

For Mininet topology, place the tile server(s) and the browser host on the correct sides of the bottleneck and document the identical profile in your paper’s experimental setup section.

---

## (d) Code structure

| Directory | Contents |
|-----------|----------|
| **`server/`** | **`Caddyfile.b1.example` (B1)**, **`Caddyfile.b2.example` (B2)**, `server_baseline_flat_sendorder.js` (B3), `server_vpap.js` (B4), optional **`server_b1_http_rvc.js`** (WebSocket RVC shim), `tileSelection.js`, `StreamMetrics.js`, `VPAP_SCHEDULING.md`, **`README.md`**, `scripts/` |
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
