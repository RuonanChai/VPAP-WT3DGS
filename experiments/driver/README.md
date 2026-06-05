# Browser trial driver (integration contract)

Supplementary experiment orchestrators invoke an external **browser automation script** via `VPAP_EXPERIMENT_CMD`.

## Required CLI

Your script must implement:

```text
python run_experiment.py \
  --baseline baseline4 \
  --run-id c2_wtsv_001 \
  --cache-state cold \
  --trace-id trace1
```

## Required outputs

For run id `c2_wtsv_001` and baseline `baseline4`, write:

```text
logs/baseline4/run_c2_wtsv_001/
  metrics_client.json          # required
  experiment_metadata.json     # required for C3 (must record trace_duration)
  tile_telemetry (inside metrics_client.json)
  initial_selection (inside metrics_client.json — locked 300-tile set)
```

## Golden reference injection

Before starting Phase 1, inject the locked selection from:

`experiments/common/golden/initial_selection_trace1.json`

into the viewer (e.g. `window.__LOCKED_INITIAL_SELECTION__`) so all baselines and policies share the same reference set.

## Trace files (C3)

Shipped traces (JSON arrays of timed camera poses):

| trace_id | File |
|----------|------|
| `trace_fixed` | `experiments/c3_dynamic_viewport/traces/trace_fixed.json` |
| `trace_slow_pan` | `trace_slow_pan.json` |
| `trace_fast_turn` | `trace_fast_turn.json` |
| `trace_abrupt_jump` | `trace_abrupt_jump.json` |

Set `VPAP_TRACE_DURATION_MS=60000` and pass `--trace-id trace_slow_pan` (etc.) for C3.

## Example environment

Copy `config.env.example` and export variables before running batch scripts:

```bash
source experiments/driver/config.env.example
python experiments/c2_scheduling_ablation/run_c2_batch.py --dry-run
```

## Baseline endpoints (default ports)

| Baseline | Server command | Client URL (example) |
|----------|----------------|----------------------|
| B1 | `npm run start:b1` | `http://localhost:8080/` |
| B2 | `npm run start:b2` | `https://web3d.local:8543/` |
| B3 | `npm run start:b3` | `webtransport://web3d.local:9444/wt` |
| B4 | `npm run start:vpap` | `webtransport://web3d.local:8444/wt` |

Adjust hostnames and ports to match your TLS certificate SAN entries.
