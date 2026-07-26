# VPAP-WT3DGS — Anonymous research artifact

**Viewport- and LOD-aware prioritization over WebTransport for tiled 3D Gaussian splatting**

This repository is the **double-blind** code artifact linked from the paper. It provides a standalone testbed to compare HTTP/1.1, HTTP/3, plain WebTransport, and WT+VPAP under a locked admission / useful-byte contract, plus drivers for the supplementary studies reported in the evaluation (network grid, scheduling ablation, motion traces, two-host LAN, cross-scene, OFAT sensitivity, and schedule-overhead logging).

**Not included (by design):** paper figures’ plotting scripts, raw run logs, and scene binary assets. Provide your own dataset under `dataset/` and your own browser automation via `VPAP_EXPERIMENT_CMD`.

---

## Double-blind / anonymity

- Do **not** commit author names, affiliations, emails, personal hostnames, or lab IP inventories.
- Configure machines only through environment variables (see C4 README).
- Publish via [Anonymous GitHub](https://anonymous.4open.science) from a public mirror; cite only the `anonymous.4open.science` URL in the submission.

---

## (a) System requirements

| Component | Notes |
|-----------|--------|
| **Node.js** | ≥ 20 (`@fails-components/webtransport`) |
| **OS** | Linux recommended for `tc`; macOS/Windows OK for server + local browser |
| **Browser** | Chromium with WebTransport enabled |
| **TLS** | Use [mkcert](https://github.com/FiloSottile/mkcert) or your CA; cert SAN must match the WebTransport URL host/IP |
| **Python** | 3.10+ for experiment drivers (`experiments/requirements.txt`) |

---

## (b) Quick start — baselines

**Prerequisites:** Populate `dataset/toy_example/` per `dataset/README.md`. **B1/B2** need [Caddy](https://caddyserver.com/) v2+. **B3/B4** need TLS under `server/certs/` or `VPAP_TLS_*` / `VPAP_CERT_DIR`.

```bash
cd server && npm install
```

| Baseline | Command | Role |
|----------|---------|------|
| B1 | `npm run start:b1` | HTTP/1.1 pull (diagnostic) |
| B2 | `npm run start:b2` | HTTP/3 pull (diagnostic) |
| B3 | `npm run start:b3` | Plain WebTransport (WTS-N substrate) |
| B4 | `npm run start:vpap` | WebTransport + VPAP (`VPAP_SCHEDULE_POLICY`) |

Client integration: `client/` (`SLM2Loader.js`, telemetry helpers). Details: `client/HTTP_PULL_AND_RVC.md`, `server/README.md`.

---

## (c) Supplementary experiments

See **`experiments/README.md`**. Drivers call your browser script through `VPAP_EXPERIMENT_CMD` / `VPAP_PYTHON`+`VPAP_EXPERIMENT_SCRIPT` (contract in `experiments/driver/README.md`).

| ID | Directory | Isolates |
|----|-----------|----------|
| Phase3 | §b baselines | Transport stack |
| **C1** | `experiments/c1_netem/` | 3×3×3 netem grid (B3 vs B4) |
| **C2** | `experiments/c2_scheduling_ablation/` | WTS-N/L/D/F/V on B4 |
| **C3** | `experiments/c3_dynamic_viewport/` | Motion traces |
| **C4** | `experiments/c4_two_host_lan/` | Two-host LAN (+ optional shaped cell) |
| **C5** | `experiments/c5_cross_scene/` | Indoor bonsai cross-scene |
| **C6** | `experiments/c6_sensitivity_ofat/` | OFAT on `VPAP_ALPHA/BETA/TAU/INITIAL_LOAD` |
| Overhead | `VPAP_OVERHEAD_LOG` + `experiments/common/summarize_schedule_overhead.py` | Schedule-update latency JSONL |

Example:

```bash
export VPAP_EXPERIMENT_CMD="python /path/to/run_experiment.py"

python experiments/c2_scheduling_ablation/run_c2_batch.py --runs-per-policy 5
python experiments/c1_netem/run_netem_grid.py --runs-per-cell 3
python experiments/c3_dynamic_viewport/run_c3_batch.py --runs-per-cell 3
python experiments/c4_two_host_lan/run_two_host_batch.py --dry-run
python experiments/c5_cross_scene/run_bonsai_batch.py --dry-run
python experiments/c6_sensitivity_ofat/run_sensitivity_batch.py --dry-run
```

Network shaping: `network_emulation/` and `experiments/c1_netem/netem_control.sh`.

---

## (d) Code structure

| Path | Contents |
|------|----------|
| `server/` | B1/B2 Caddy examples; B3 flat WT; B4 `server_vpap.js` (policies, utility knobs, optional overhead log) |
| `client/` | Loader + telemetry helpers |
| `experiments/` | C1–C6 drivers, golden selection, gates |
| `network_emulation/` | `tc` examples |
| `dataset/` | Layout + examples (**no large `.splat` binaries** in git) |

---

## License

MIT (see `LICENSE`).
