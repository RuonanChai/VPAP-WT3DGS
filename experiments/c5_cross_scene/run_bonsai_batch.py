#!/usr/bin/env python3
"""C5 cross-scene (bonsai) batch driver."""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))
from orchestrator_utils import logs_root, run_trial, save_json  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--policies", default="WTS-L,WTS-V")
    ap.add_argument("--traces", default="trace_fixed,trace_fast_turn")
    ap.add_argument("--runs-per-cell", type=int, default=10)
    ap.add_argument("--cache-state", default="cold")
    ap.add_argument("--baseline", default="baseline4")
    ap.add_argument("--tag", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.environ.get("VPAP_ASSETS_DIR"):
        print("WARNING: VPAP_ASSETS_DIR unset — server must already point at bonsai assets", file=sys.stderr)

    policies = [p.strip() for p in args.policies.split(",") if p.strip()]
    traces = [t.strip() for t in args.traces.split(",") if t.strip()]
    out_root = logs_root() / "bonsai" / args.tag
    out_root.mkdir(parents=True, exist_ok=True)
    policy_env = {"WTS-L": "lod", "WTS-V": "vpap", "WTS-N": "none"}
    manifest: dict = {"experiment": "c5_cross_scene", "tag": args.tag, "runs": []}

    for pol in policies:
        for trace in traces:
            for i in range(args.runs_per_cell):
                run_id = f"bonsai_{pol.replace('-', '').lower()}_{trace}_r{i:02d}"
                print(f"=== {run_id} ===", flush=True)
                if args.dry_run:
                    manifest["runs"].append({"run_id": run_id, "dry_run": True})
                    continue
                ok = run_trial(
                    baseline=args.baseline,
                    run_id=run_id,
                    cache_state=args.cache_state,
                    trace_id=trace,
                    extra_env={"VPAP_SCHEDULE_POLICY": policy_env.get(pol, "vpap")},
                )
                manifest["runs"].append({"run_id": run_id, "policy": pol, "trace": trace, "ok": ok})
                if not ok:
                    save_json(out_root / "bonsai_manifest.json", manifest)
                    return 1
                time.sleep(1.0)
    save_json(out_root / "bonsai_manifest.json", manifest)
    print("C5 batch done ->", out_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
