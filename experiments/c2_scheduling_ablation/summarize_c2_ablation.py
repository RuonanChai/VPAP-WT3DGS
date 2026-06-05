#!/usr/bin/env python3
"""Aggregate C2 scheduling ablation runs into a CSV summary."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))

from metrics import compute_run_metrics  # noqa: E402

POLICIES = {
    "wtsn": "WTS-N",
    "wtsl": "WTS-L",
    "wtsd": "WTS-D",
    "wtsf": "WTS-F",
    "wtsv": "WTS-V",
}


def load_run(run_dir: Path) -> dict | None:
    metrics_path = run_dir / "metrics_client.json"
    if not metrics_path.is_file():
        return None
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    parsed = compute_run_metrics(metrics, [20000], [15000])
    stq = metrics.get("spatio_temporal_qoe", {}) or {}
    t80 = parsed.get("t_80_ms")
    if t80 is None:
        t80 = stq.get("t_80_ms")
    return {
        "run": run_dir.name,
        "q_vis_avg": parsed.get("viewer_q_vis_normalized_avg") or stq.get("q_vis_avg"),
        "t_q80_s": (t80 / 1000.0) if t80 is not None else None,
        "q_eq_at_15s": parsed.get("q_eq_at_15000ms"),
        "qoe_final": stq.get("qoe_final"),
    }


def summarize(root: Path) -> list[dict]:
    rows: list[dict] = []
    for tag, label in POLICIES.items():
        runs = []
        for i in range(1, 6):
            rd = root / f"run_c2_{tag}_{i:03d}"
            r = load_run(rd)
            if r:
                runs.append(r)
        if not runs:
            rows.append({"policy": label, "n": 0})
            continue

        def mean(key):
            xs = [x[key] for x in runs if x.get(key) is not None]
            return statistics.mean(xs) if xs else None

        rows.append({
            "policy": label,
            "n": len(runs),
            "t_q80_s_mean": mean("t_q80_s"),
            "q_vis_mean": mean("q_vis_avg"),
            "q_eq_at_15s_mean": mean("q_eq_at_15s"),
            "qoe_final_mean": mean("qoe_final"),
        })
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline-dir", type=Path, required=True,
                    help="e.g. logs/baseline4")
    ap.add_argument("--output", type=Path, default=None)
    args = ap.parse_args()

    rows = summarize(args.baseline_dir.resolve())
    out = args.output or (args.baseline_dir / "c2_ablation_summary.csv")
    out.parent.mkdir(parents=True, exist_ok=True)

    fields = ["policy", "n", "t_q80_s_mean", "q_vis_mean", "q_eq_at_15s_mean", "qoe_final_mean"]
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow({k: (f"{row[k]:.4f}" if isinstance(row.get(k), float) else row.get(k, "")) for k in fields})

    print(f"Wrote {out}")
    for row in rows:
        if row.get("n", 0) == 0:
            print(f"  {row['policy']}: no runs")
            continue
        print(
            f"  {row['policy']} n={row['n']} "
            f"t_q80={row.get('t_q80_s_mean', 0):.2f}s "
            f"Q_vis={row.get('q_vis_mean', 0):.3f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
