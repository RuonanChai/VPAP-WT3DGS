#!/usr/bin/env python3
"""Aggregate C3 dynamic viewport runs by trace and baseline."""

from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))

from metrics import compute_run_metrics  # noqa: E402

TRACE_LABELS = {
    "fixed": "Fixed",
    "slow_pan": "Slow pan",
    "fast_turn": "Fast turn",
    "abrupt": "Abrupt jump",
}


def discover_runs(logs_root: Path, baseline: str) -> list[Path]:
    bdir = logs_root / baseline
    if not bdir.is_dir():
        return []
    return sorted(p for p in bdir.iterdir() if p.is_dir() and "c3_" in p.name)


def trace_key_from_name(name: str) -> str | None:
    m = re.search(r"c3_(fixed|slow_pan|fast_turn|abrupt)_", name)
    return m.group(1) if m else None


def q_vis(run_dir: Path) -> float | None:
    mp = run_dir / "metrics_client.json"
    if not mp.is_file():
        return None
    metrics = json.loads(mp.read_text(encoding="utf-8"))
    parsed = compute_run_metrics(metrics, [20000], [15000])
    return parsed.get("viewer_q_vis_normalized_avg")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs-root", type=Path, default=Path("logs"))
    ap.add_argument("--output", type=Path, default=None)
    args = ap.parse_args()

    rows = []
    for trace_key, label in TRACE_LABELS.items():
        b3_vals, b4_vals = [], []
        for baseline, bucket in (("baseline3", b3_vals), ("baseline4", b4_vals)):
            for rd in discover_runs(args.logs_root, baseline):
                if trace_key_from_name(rd.name) != trace_key:
                    continue
                q = q_vis(rd)
                if q is not None:
                    bucket.append(q)
        row = {
            "trace": label,
            "n_b3": len(b3_vals),
            "n_b4": len(b4_vals),
            "q_vis_b3": statistics.mean(b3_vals) if b3_vals else "",
            "q_vis_b4": statistics.mean(b4_vals) if b4_vals else "",
        }
        if b3_vals and b4_vals:
            row["delta_pct"] = 100.0 * (row["q_vis_b4"] - row["q_vis_b3"]) / row["q_vis_b3"]
        rows.append(row)

    out = args.output or (args.logs_root / "c3_viewport_summary.csv")
    fields = ["trace", "n_b3", "n_b4", "q_vis_b3", "q_vis_b4", "delta_pct"]
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow(row)

    print(f"Wrote {out}")
    for row in rows:
        print(f"  {row['trace']}: B3={row.get('q_vis_b3','')} B4={row.get('q_vis_b4','')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
