# Supplementary experiments

Reproducible **drivers** for the evaluation dimensions in the paper. This mirror ships **code only** (no plotting scripts, no raw result archives).

| ID | Experiment | Isolation | Default baselines |
|----|------------|-----------|-------------------|
| **Phase3** | Protocol stack | HTTP/1.1, HTTP/3, WT, WT+VPAP | B1–B4 (root `README.md` §b) |
| **C1** | Network emulation | Same locked selection; `tc netem` grid | B3 vs B4 |
| **C2** | Scheduling ablation | Same WT substrate; fixed viewport | WTS-N/L/D/F/V on B4 |
| **C3** | Dynamic viewport | 60 s camera replay | B3 vs B4 |
| **C4** | Two-host LAN | Server vs client hosts | WTS-N/L/V on B4 |
| **C5** | Cross-scene | Indoor bonsai assets | WTS-L/V |
| **C6** | OFAT sensitivity | `VPAP_ALPHA/BETA/TAU/INITIAL_LOAD` | WTS-L/V |

All runs assume:

1. Locked reference set from `experiments/common/golden/initial_selection_trace1.json` (or scene-specific manifest).
2. Each trial writes `logs/<baseline>/run_<run_id>/metrics_client.json`.
3. Optional gate: `experiments/common/verify_telemetry_gate.py`.

## Prerequisites

```bash
cd server && npm install
python3 -m venv ../venv && source ../venv/bin/activate
pip install -r experiments/requirements.txt
```

## Browser driver

Orchestrators do **not** vendor Selenium. Set `VPAP_EXPERIMENT_CMD` or `VPAP_PYTHON` + `VPAP_EXPERIMENT_SCRIPT` (see `driver/README.md`).

## Quick commands

```bash
# C2
bash experiments/c2_scheduling_ablation/restart_wt_server.sh vpap
python experiments/c2_scheduling_ablation/run_c2_batch.py --runs-per-policy 5

# C1
python experiments/c1_netem/run_netem_grid.py --runs-per-cell 3

# C3
python experiments/c3_dynamic_viewport/run_c3_batch.py --runs-per-cell 3

# C4 / C5 / C6 (see per-directory README for env)
python experiments/c4_two_host_lan/run_two_host_batch.py --dry-run
python experiments/c5_cross_scene/run_bonsai_batch.py --dry-run
python experiments/c6_sensitivity_ofat/run_sensitivity_batch.py --dry-run

# Schedule overhead
VPAP_OVERHEAD_LOG=./logs/overhead.jsonl VPAP_SCHEDULE_POLICY=vpap node server/server_vpap.js
python experiments/common/summarize_schedule_overhead.py logs/overhead.jsonl
```

## Scheduling policies (C2 / C4–C6)

| Label | `VPAP_SCHEDULE_POLICY` |
|-------|------------------------|
| WTS-N | `none` |
| WTS-L | `lod` |
| WTS-D | `dist` |
| WTS-F | `frustum` |
| WTS-V | `vpap` |

Utility knobs (C6): `VPAP_ALPHA`, `VPAP_BETA`, `VPAP_TAU`, `VPAP_DNORM`, `VPAP_INITIAL_LOAD` — see `server/VPAP_SCHEDULING.md`.

## Interpretation notes

- **C2** fixed-viewport: LOD-first can dominate static cold start; C1/C3/C4 probe where live ranking remains useful.
- **C1** applies the **same** netem profile to every compared cell.
- **C4** must not embed personal machine inventories in git; use env vars only.
- **C5** requires a separately provisioned bonsai asset tree (`VPAP_ASSETS_DIR`).
