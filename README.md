# VPAP-WT3DGS — Viewport- and LOD-Aware Prioritization over WebTransport for Tiled 3D Gaussian Splatting

**Paper placeholder URL:** `https://anonymous.4open.science/r/VPAP-xxxx` (replace with the link returned by [Anonymous GitHub](https://anonymous.4open.science) after you mirror a **public GitHub** repository).

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

## (b) Quick start

### 1. Dataset (toy example)

Populate `dataset/toy_example/` per `dataset/README.md` (splat files, mapping JSON, `reference_manifest.json`). You may start from `reference_manifest.example.json`.

### 2. TLS material

Place `web3d.local.pem` and `web3d.local-key.pem` under `server/certs/` (or set `VPAP_TLS_*` / `VPAP_CERT_DIR`).

### 3. VPAP WebTransport server

```bash
cd server
npm install
npm run start:vpap
```

Default: UDP **8444**, path `/wt`. Assets default to `../dataset/toy_example` (override with `VPAP_ASSETS_DIR`).

### 4. Flat-sendOrder baseline (ablation)

```bash
cd server
npm run start:baseline
```

Default: UDP **9444**, path `/wt`.

### 5. Client integration

The reference modules under `client/` are extracted from the full viewer:

- **`SLM2Loader.js`** — `WebTransport` session, bidirectional camera stream, `incomingUnidirectionalStreams` consumption, fair **TTFB** timestamps (`logicRequestStart` before `getReader()`), **`TileTelemetry`** hooks.
- **`TileTelemetry.js`** — per-tile records (AAT / enqueue / first byte / complete).
- **`SpatioTemporalQoETracker.js`** — time-sampled QoE (e.g. **50 ms** interval in this build) for paper metrics.

Integrate these into your bundled viewer or serve your full static build separately; point `rcServerAddress` to `webtransport://<host>:8444/wt` (VPAP) or `:9444` (baseline).

---

## (c) Reproducing network limits

See `network_emulation/README.md` and `network_emulation/tc_shape_example.sh` for Linux **netem** delay/loss. For **Mininet**, apply equivalent shaping on the bottleneck link between server and client hosts. Document the same conditions for all baselines.

---

## (d) Code structure

| Directory | Contents |
|-----------|----------|
| **`server/`** | `server_vpap.js` (VPAP + `sendOrder`), `server_baseline_flat_sendorder.js`, `tileSelection.js`, `StreamMetrics.js`, `VPAP_SCHEDULING.md` |
| **`client/`** | WebTransport receive path + `TileTelemetry` + `SpatioTemporalQoETracker` |
| **`network_emulation/`** | `tc` example + README |
| **`dataset/`** | Toy layout, examples, **no large binaries** in git by default (see `.gitignore`) |
| **`analysis_and_plotting/`** | Matplotlib scripts for QoE / CPU / memory style figures (inputs: aggregated CSVs from your evaluation pipeline) |

---

## Anonymous mirror workflow

1. Push this tree to a **public** GitHub repo (see **`GITHUB_SETUP.md`**).
2. Open [anonymous.4open.science](https://anonymous.4open.science/dashboard) → **Anonymize your repository** → paste the **GitHub repo URL**.
3. Use the generated `https://anonymous.4open.science/r/...` link in the paper.

---

## License

MIT (see `LICENSE` if present; otherwise follow your institution’s default).
