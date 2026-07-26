# C5 — Cross-scene (bonsai) validation

Checks that controlled-ordering gains are not confined to the outdoor `campus2` tile layout.

## Isolation

| Fixed | Varied |
|-------|--------|
| WebTransport substrate, WTS-L vs WTS-V semantics, seed-matched pose / budget | Scene assets: indoor **bonsai** progressive tiles |
| Telemetry schema (`metrics_client.json`) | Motion: at least `trace_fixed` and `trace_fast_turn` |

## Dataset layout

Place bonsai assets beside the toy campus layout (do **not** commit large binaries):

```
dataset/
  toy_example/          # campus2 (existing)
  bonsai_example/       # you provide: 20_lod/, mapping JSON, reference_manifest.json
```

Point the server at the bonsai tree:

```bash
export VPAP_ASSETS_DIR="$(pwd)/dataset/bonsai_example"
export VPAP_SCHEDULE_POLICY=vpap
node server/server_vpap.js
```

## Workflow

```bash
export VPAP_EXPERIMENT_CMD="python /path/to/run_experiment.py"
python experiments/c5_cross_scene/run_bonsai_batch.py \
  --policies WTS-L,WTS-V \
  --traces trace_fixed,trace_fast_turn \
  --runs-per-cell 10
```

## Outputs

```
logs/bonsai/<tag>/
  run_<policy>_<trace>_rXX/metrics_client.json
  bonsai_manifest.json
```

Report paired WTS-V−WTS-L effects per motion regime; keep render checkpoints for visual audit in the paper artifact package (not in this anonymous code mirror).
