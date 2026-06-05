#!/usr/bin/env python3
"""C1 network emulation grid: 3x3x3 bandwidth x RTT x loss, B3 vs B4."""

from __future__ import annotations

import argparse
import itertools
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))

from orchestrator_utils import logs_root, run_trial, save_json, verify_run  # noqa: E402

NETEM_SCRIPT = Path(__file__).resolve().parent / "netem_control.sh"
BANDWIDTHS_MBIT = [25, 50, 100]
RTTS_MS = [10, 50, 100]
LOSS_PERCENT = [0, 0.5, 1.0]
DEFAULT_BASELINES = ["baseline3", "baseline4"]


def wsl_bash(cmd: str, timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["wsl", "-e", "bash", "-c", cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def apply_netem(bw: int, rtt: int, loss: float, iface: str) -> bool:
    script_posix = wsl_bash(f"wslpath '{NETEM_SCRIPT}'", timeout=10).stdout.strip()
    cmd = (
        f"export NETEM_IFACE={iface} && "
        f"sudo -n bash {script_posix} apply {bw} {rtt} {loss}"
    )
    result = wsl_bash(cmd, timeout=15)
    if result.returncode != 0:
        print(f"[netem FAIL] {result.stderr.strip()}")
        return False
    return True


def clear_netem(iface: str) -> None:
    script_posix = wsl_bash(f"wslpath '{NETEM_SCRIPT}'").stdout.strip()
    wsl_bash(f"export NETEM_IFACE={iface} && sudo -n bash {script_posix} reset", timeout=10)


def main() -> int:
    ap = argparse.ArgumentParser(description="C1 netem grid driver (B3 vs B4)")
    ap.add_argument("--baselines", nargs="+", default=DEFAULT_BASELINES)
    ap.add_argument("--runs-per-cell", type=int, default=3)
    ap.add_argument("--iface", default=os.environ.get("NETEM_IFACE", "lo"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-netem", action="store_true")
    ap.add_argument("--bw", nargs="+", type=int, default=BANDWIDTHS_MBIT)
    ap.add_argument("--rtt", nargs="+", type=int, default=RTTS_MS)
    ap.add_argument("--loss", nargs="+", type=float, default=LOSS_PERCENT)
    args = ap.parse_args()

    grid = list(itertools.product(args.bw, args.rtt, args.loss))
    total = len(grid) * len(args.baselines) * args.runs_per_cell
    print(f"[C1] {len(grid)} cells x {len(args.baselines)} baselines x {args.runs_per_cell} = {total} runs")

    if args.dry_run:
        for cell in grid:
            print(f"  {cell[0]}Mbps / {cell[1]}ms / {cell[2]}%")
        return 0

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    manifest: list[dict] = []

    try:
        for idx, (bw, rtt, loss) in enumerate(grid):
            label = f"{bw}mbps_{rtt}ms_{loss}pct"
            print(f"\n[{idx + 1}/{len(grid)}] {label}")
            if not args.skip_netem:
                if not apply_netem(bw, rtt, loss, args.iface):
                    print("  skip cell (netem apply failed)")
                    continue
            time.sleep(1)

            for baseline in args.baselines:
                for run_idx in range(args.runs_per_cell):
                    run_id = f"{ts}_netem_{label}_{baseline}_run_{run_idx:03d}"
                    ok = run_trial(
                        baseline=baseline,
                        run_id=run_id,
                        trace_id="trace1",
                        cache_state="warm",
                    )
                    rd = logs_root() / baseline / f"run_{run_id}"
                    gate_ok, _ = verify_run(rd) if ok else (False, {})
                    manifest.append({
                        "bw_mbit": bw,
                        "rtt_ms": rtt,
                        "loss_pct": loss,
                        "baseline": baseline,
                        "run_idx": run_idx,
                        "run_id": run_id,
                        "success": ok,
                        "gate_pass": gate_ok,
                    })

            if not args.skip_netem:
                clear_netem(args.iface)
    finally:
        if not args.skip_netem:
            clear_netem(args.iface)

    out = logs_root() / f"grid_manifest_{ts}.json"
    save_json(out, manifest)
    passed = sum(1 for m in manifest if m.get("gate_pass"))
    print(f"\n[C1] manifest: {out}")
    print(f"[C1] gate PASS: {passed}/{len(manifest)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
