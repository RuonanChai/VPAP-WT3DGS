#!/usr/bin/env python3
"""C4 two-host LAN batch driver (portable; no lab-specific defaults)."""
from __future__ import annotations

import argparse
import json
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
    ap.add_argument("--policies", default="WTS-N,WTS-L,WTS-V")
    ap.add_argument("--runs-per-policy", type=int, default=10)
    ap.add_argument("--trace-id", default="trace_fixed")
    ap.add_argument("--cache-state", default="cold")
    ap.add_argument("--baseline", default="baseline4")
    ap.add_argument("--tag", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for req in ("VPAP_LAN_SERVER_HOST", "VPAP_LAN_CLIENT_HOST"):
        if not os.environ.get(req):
            print(f"WARNING: {req} unset — driver must resolve hosts itself", file=sys.stderr)

    policies = [p.strip() for p in args.policies.split(",") if p.strip()]
    out_root = logs_root() / "lan" / args.tag
    out_root.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        "experiment": "c4_two_host_lan",
        "tag": args.tag,
        "utc": datetime.now(timezone.utc).isoformat(),
        "policies": policies,
        "runs": [],
    }
    policy_env = {
        "WTS-N": "none",
        "WTS-L": "lod",
        "WTS-V": "vpap",
        "WTS-D": "dist",
        "WTS-F": "frustum",
    }
    for pol in policies:
        for i in range(args.runs_per_policy):
            run_id = f"lan_{pol.replace('-', '').lower()}_r{i:02d}"
            print(f"=== {run_id} ===", flush=True)
            if args.dry_run:
                manifest["runs"].append({"run_id": run_id, "dry_run": True})
                continue
            ok = run_trial(
                baseline=args.baseline,
                run_id=run_id,
                cache_state=args.cache_state,
                trace_id=args.trace_id,
                extra_env={"VPAP_SCHEDULE_POLICY": policy_env.get(pol, "vpap")},
            )
            manifest["runs"].append({"run_id": run_id, "policy": pol, "ok": ok})
            if not ok:
                save_json(out_root / "lan_manifest.json", manifest)
                return 1
            time.sleep(1.0)
    save_json(out_root / "lan_manifest.json", manifest)
    print("C4 batch done ->", out_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
