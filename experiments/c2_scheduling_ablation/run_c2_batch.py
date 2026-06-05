#!/usr/bin/env python3
"""C2 scheduling ablation: five WTS policies on the same WebTransport substrate (fixed viewport)."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))

from orchestrator_utils import (  # noqa: E402
    artifact_python,
    logs_root,
    run_dir,
    run_trial,
    save_json,
    verify_run,
)

POLICIES = [
    ("wtsn", "none", "WTS-N"),
    ("wtsl", "lod", "WTS-L"),
    ("wtsd", "dist", "WTS-D"),
    ("wtsf", "frustum", "WTS-F"),
    ("wtsv", "vpap", "WTS-V"),
]
RESTART = Path(__file__).resolve().parent / "restart_wt_server.sh"


def restart_server(policy_env: str) -> None:
    if not RESTART.is_file():
        raise FileNotFoundError(RESTART)
    subprocess.run(["bash", str(RESTART), policy_env], check=True, timeout=30)


def main() -> int:
    ap = argparse.ArgumentParser(description="C2 scheduling ablation batch driver")
    ap.add_argument("--batch-date", default=datetime.now().strftime("%Y%m%d"))
    ap.add_argument("--runs-per-policy", type=int, default=5)
    ap.add_argument("--baseline", default="baseline4")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    ckpt = logs_root() / f"c2_ablation_{args.batch_date}.json"
    completed: set[str] = set()
    manifest: list[dict] = []
    if args.resume and ckpt.is_file():
        data = json.loads(ckpt.read_text(encoding="utf-8"))
        completed = set(data.get("completed_run_ids", []))
        manifest = data.get("manifest", [])

    total = len(POLICIES) * args.runs_per_policy
    print(f"[C2] policies={len(POLICIES)} runs/policy={args.runs_per_policy} total={total}")

    counter = 0
    for tag, policy_env, label in POLICIES:
        for idx in range(1, args.runs_per_policy + 1):
            counter += 1
            run_id = f"c2_{tag}_{idx:03d}"
            full_id = f"{args.batch_date}_{run_id}"
            rd = run_dir(args.baseline, run_id)

            if args.resume and run_id in completed and rd.is_dir() and verify_run(rd)[0]:
                print(f"[{counter}/{total}] skip PASS {run_id}")
                continue

            print(f"\n[{counter}/{total}] {label} run={run_id}")
            if args.dry_run:
                continue

            restart_server(policy_env)
            ok = run_trial(
                baseline=args.baseline,
                run_id=run_id,
                trace_id="trace1",
                cache_state="cold",
                extra_env={"VPAP_SCHEDULE_POLICY": policy_env, "VPAP_TRACE_DURATION_MS": "0"},
            )
            gate_ok, detail = verify_run(rd) if ok else (False, {})
            entry = {
                "run_id": run_id,
                "policy": label,
                "policy_env": policy_env,
                "success": ok,
                "gate_pass": gate_ok,
                "run_dir": str(rd),
            }
            manifest.append(entry)
            if ok and gate_ok:
                completed.add(run_id)
            save_json(ckpt, {
                "batch_date": args.batch_date,
                "completed_run_ids": sorted(completed),
                "manifest": manifest,
            })

    print(f"\n[C2] checkpoint: {ckpt}")
    print(f"[C2] PASS runs: {len(completed)}/{total}")
    return 0 if len(completed) == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
