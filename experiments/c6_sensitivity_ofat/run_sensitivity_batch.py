#!/usr/bin/env python3
"""C6 OFAT sensitivity batch: restart-free env injection per trial (driver/server must honor env)."""
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

SETTINGS = [
    ("alpha_beta", "0.5_0.5", {"VPAP_ALPHA": "0.5", "VPAP_BETA": "0.5"}),
    ("alpha_beta", "0.7_0.3", {"VPAP_ALPHA": "0.7", "VPAP_BETA": "0.3"}),
    ("alpha_beta", "0.9_0.1", {"VPAP_ALPHA": "0.9", "VPAP_BETA": "0.1"}),
    ("tau", "0.3", {"VPAP_TAU": "0.3"}),
    ("tau", "0.5", {"VPAP_TAU": "0.5"}),
    ("tau", "0.7", {"VPAP_TAU": "0.7"}),
    ("initial_load", "50", {"VPAP_INITIAL_LOAD": "50"}),
    ("initial_load", "100", {"VPAP_INITIAL_LOAD": "100"}),
    ("initial_load", "150", {"VPAP_INITIAL_LOAD": "150"}),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-per-setting", type=int, default=5)
    ap.add_argument("--traces", default="trace_fixed")
    ap.add_argument("--baseline", default="baseline4")
    ap.add_argument("--tag", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    traces = [t.strip() for t in args.traces.split(",") if t.strip()]
    out_root = logs_root() / "sensitivity" / args.tag
    out_root.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"experiment": "c6_sensitivity_ofat", "tag": args.tag, "runs": []}

    print(
        "NOTE: Restart server_vpap.js between OFAT blocks so VPAP_* env changes apply.",
        flush=True,
    )

    for param, setting, envmap in SETTINGS:
        for trace in traces:
            for rep in range(args.runs_per_setting):
                for pol, penv in (("WTS-L", "lod"), ("WTS-V", "vpap")):
                    run_id = f"sens_{param}_{setting}_{trace}_r{rep:02d}_{pol.replace('-', '').lower()}"
                    print(f"=== {run_id} ===", flush=True)
                    if args.dry_run:
                        manifest["runs"].append({"run_id": run_id, "dry_run": True})
                        continue
                    extra = dict(envmap)
                    extra["VPAP_SCHEDULE_POLICY"] = penv
                    ok = run_trial(
                        baseline=args.baseline,
                        run_id=run_id,
                        cache_state="cold",
                        trace_id=trace,
                        extra_env=extra,
                    )
                    manifest["runs"].append(
                        {
                            "run_id": run_id,
                            "param": param,
                            "setting": setting,
                            "trace": trace,
                            "policy": pol,
                            "ok": ok,
                        }
                    )
                    if not ok:
                        save_json(out_root / "sensitivity_manifest.json", manifest)
                        return 1
                    time.sleep(0.5)
    save_json(out_root / "sensitivity_manifest.json", manifest)
    print("C6 batch done ->", out_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
