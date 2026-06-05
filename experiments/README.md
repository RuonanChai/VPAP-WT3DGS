# Supplementary experiments (revised evaluation)

This directory contains **reproducible drivers** for the four evaluation dimensions described in the paper:

| ID | Experiment | Isolation | Default baselines |
|----|------------|-----------|-------------------|
| **Phase3** | Protocol stack comparison | HTTP/1.1, HTTP/3, WT, WT+VPAP | B1–B4 (`README.md` §b) |
| **C1** | Network emulation | Same locked selection; `tc netem` grid | B3 vs B4 |
| **C2** | Scheduling ablation | Same WebTransport substrate; fixed viewport | WTS-N/L/D/F/V on B4 |
| **C3** | Dynamic viewport | 60 s camera replay during Phase 2 | B3 vs B4 |

All supplementary runs assume:

1. **Locked reference set** — 300 tiles from `experiments/common/golden/initial_selection_trace1.json` (injected by your browser driver).
2. **Fair telemetry** — each trial writes `logs/<baseline>/run_<run_id>/metrics_client.json`.
3. **Quality gate** — `experiments/common/verify_telemetry_gate.py` checks selection lock, byte usefulness, and minimum viewport quality.

## Prerequisites

```bash
cd server && npm install
python3 -m venv ../venv && source ../venv/bin/activate
pip install -r experiments/requirements.txt
```

Generate TLS certificates (see root `README.md`). Populate `dataset/toy_example/` per `dataset/README.md`.

## Browser driver interface

Orchestrators do **not** bundle a full Selenium viewer. Set:

```bash
export VPAP_EXPERIMENT_CMD="python /path/to/your/run_experiment.py"
export VPAP_LOGS_ROOT="$(pwd)/logs"   # optional; default ./logs
```

Your driver must accept:

```
--baseline {baseline1|baseline2|baseline3|baseline4}
--run-id <string>
--cache-state {cold|warm}
--trace-id <trace1|trace_fixed|trace_slow_pan|...>
```

and honor environment variables:

| Variable | Used by | Purpose |
|----------|---------|---------|
| `VPAP_SCHEDULE_POLICY` | C2 | `none`, `lod`, `dist`, `frustum`, `vpap` |
| `VPAP_TRACE_DURATION_MS` | C3 | Phase-2 replay length (`60000` for C3; `0` for C2) |
| `VPAP_SKIP_NETLOG` | all | Skip Chrome netlog (recommended) |

See `driver/README.md` for integration details.

## Quick commands

### C2 — scheduling ablation (five policies, fixed viewport)

```bash
bash experiments/c2_scheduling_ablation/restart_wt_server.sh vpap   # smoke test
python experiments/c2_scheduling_ablation/run_c2_batch.py --runs-per-policy 5
python experiments/c2_scheduling_ablation/summarize_c2_ablation.py --baseline-dir logs/baseline4
```

Policies map to `VPAP_SCHEDULE_POLICY` on `server/server_vpap.js`:

| Label | Env value | Ordering rule |
|-------|-----------|---------------|
| WTS-N | `none` | FIFO / uniform `sendOrder` |
| WTS-L | `lod` | Coarse-to-fine LOD only |
| WTS-D | `dist` | Distance only |
| WTS-F | `frustum` | In-frustum first, then distance |
| WTS-V | `vpap` | LOD + viewport utility (VPAP) |

### C1 — network emulation grid (B3 vs B4)

Requires WSL2/Linux with passwordless `sudo` for `tc`, or run with `--skip-netem` on localhost.

```bash
python experiments/c1_netem/run_netem_grid.py --runs-per-cell 3
python experiments/c1_netem/summarize_c1_netem.py logs/grid_manifest_*.json --logs-root logs
```

Grid defaults: bandwidth `{25,50,100}` Mbps × RTT `{10,50,100}` ms × loss `{0,0.5,1.0}` %.

### C3 — dynamic viewport traces

Camera traces ship under `experiments/c3_dynamic_viewport/traces/`. Copy or symlink them into your driver’s trace directory.

```bash
python experiments/c3_dynamic_viewport/run_c3_batch.py --runs-per-cell 3 --trace-duration-ms 60000
python experiments/c3_dynamic_viewport/summarize_c3_viewport.py --logs-root logs
```

### Verify a single run

```bash
python experiments/common/verify_telemetry_gate.py logs/baseline4/run_c2_wtsv_001
```

## Output layout

```
logs/
  baseline3/  run_<run_id>/metrics_client.json
  baseline4/  run_<run_id>/metrics_client.json
  grid_manifest_<timestamp>.json      # C1
  c2_ablation_<date>.json             # C2 checkpoint
  c3_viewport_checkpoint.json         # C3 checkpoint
```

## Interpretation notes (aligned with the paper)

- **C2** uses a **fixed viewport** during Phase 1. WTS-L (LOD-only) can outperform WTS-V on static cold-start metrics; C1/C3 test settings where utility varies under network stress or camera motion.
- **C1** compares **transport + scheduling stack** (B3 vs B4) under emulated WAN; apply the **same** netem profile to every cell before comparing.
- **C3** requires `trace_duration >= 60000` ms in `experiment_metadata.json`; runs with zero Phase-2 duration are rejected by the C3 orchestrator.
