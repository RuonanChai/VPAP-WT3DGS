# C6 — OFAT sensitivity (utility / init-load knobs)

Descriptive one-factor-at-a-time probes of VPAP utility parameters on the same WebTransport substrate.

## Parameters

| Block | Environment | Settings (paper defaults shaded in tables) |
|-------|-------------|--------------------------------------------|
| `(α, β)` | `VPAP_ALPHA`, `VPAP_BETA` | `(0.5,0.5)`, `(0.7,0.3)`, `(0.9,0.1)` |
| `τ` | `VPAP_TAU` | `0.3`, `0.5`, `0.7` |
| init-load | `VPAP_INITIAL_LOAD` | `50`, `100`, `150` |

Restart `server_vpap.js` after changing env so the process picks up new weights.

## Workflow

```bash
export VPAP_EXPERIMENT_CMD="python /path/to/run_experiment.py"
# Prefer two-host placement when matching the paper's sensitivity table.
python experiments/c6_sensitivity_ofat/run_sensitivity_batch.py --runs-per-setting 5
```

Each setting runs WTS-L vs WTS-V under a fixed viewport (and optionally `trace_fast_turn`).

## Overhead companion

```bash
export VPAP_OVERHEAD_LOG="$(pwd)/logs/overhead.jsonl"
VPAP_SCHEDULE_POLICY=vpap node server/server_vpap.js
# ... run live sessions ...
python experiments/common/summarize_schedule_overhead.py logs/overhead.jsonl
```

Reports median / P95 `schedule_ms` over genuine schedule updates (scoring + within-tier sort, before stream I/O).
