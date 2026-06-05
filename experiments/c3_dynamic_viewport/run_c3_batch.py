#!/usr/bin/env python3
"""C3 dynamic viewport: four camera traces x B3/B4 with 60s Phase-2 replay."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))

from orchestrator_utils import logs_root, run_dir, run_trial, save_json, verify_run  # noqa: E402

TRACES = [
    ("trace_fixed", "fixed"),
    ("trace_slow_pan", "slow_pan"),
    ("trace_fast_turn", "fast_turn"),
    ("trace_abrupt_jump", "abrupt"),
]
BASELINES = [
    ("baseline3", "b3"),
    ("baseline4", "b4"),
]


def is_valid_c3_run(run_dir_path: Path) -> bool:
    meta = run_dir_path / "experiment_metadata.json"
    if not meta.is_file():
        return False
    try:
        md = json.loads(meta.read_text(encoding="utf-8"))
        return int(md.get("experiment_params", {}).get("trace_duration", 0) or 0) >= 60000
    except (json.JSONDecodeError, TypeError, ValueError):
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="C3 dynamic viewport batch driver")
    ap.add_argument("--batch-date", default=datetime.now().strftime("%Y%m%d"))
    ap.add_argument("--runs-per-cell", type=int, default=3)
    ap.add_argument("--trace-duration-ms", type=int, default=60000)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ckpt = logs_root() / "c3_viewport_checkpoint.json"
    completed: set[str] = set()
    manifest: list[dict] = []
    if args.resume and ckpt.is_file():
        data = json.loads(ckpt.read_text(encoding="utf-8"))
        completed = set(data.get("completed_run_ids", []))
        manifest = data.get("manifest", [])

    total = len(TRACES) * len(BASELINES) * args.runs_per_cell
    print(f"[C3] traces={len(TRACES)} baselines=2 runs/cell={args.runs_per_cell} total={total}")

    counter = 0
    for trace_id, trace_key in TRACES:
        for baseline, bl_short in BASELINES:
            for idx in range(args.runs_per_cell):
                counter += 1
                run_id = f"{args.batch_date}_c3_{trace_key}_{bl_short}_{idx:03d}"
                rd = run_dir(baseline, run_id)

                if args.resume and run_id in completed and is_valid_c3_run(rd) and verify_run(rd)[0]:
                    print(f"[{counter}/{total}] skip PASS {run_id}")
                    continue

                print(f"\n[{counter}/{total}] {run_id} trace={trace_id}")
                if args.dry_run:
                    continue

                ok = run_trial(
                    baseline=baseline,
                    run_id=run_id,
                    trace_id=trace_id,
                    cache_state="warm",
                    extra_env={"VPAP_TRACE_DURATION_MS": str(args.trace_duration_ms)},
                )
                gate_ok, _ = verify_run(rd) if ok else (False, {})
                valid = is_valid_c3_run(rd)
                entry = {
                    "run_id": run_id,
                    "trace_id": trace_id,
                    "baseline": baseline,
                    "success": ok,
                    "gate_pass": gate_ok,
                    "valid_c3": valid,
                    "run_dir": str(rd),
                }
                manifest.append(entry)
                if ok and gate_ok and valid:
                    completed.add(run_id)
                save_json(ckpt, {
                    "batch_date": args.batch_date,
                    "completed_run_ids": sorted(completed),
                    "manifest": manifest,
                })

    print(f"\n[C3] checkpoint: {ckpt}")
    print(f"[C3] PASS runs: {len(completed)}/{total}")
    return 0 if len(completed) == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
