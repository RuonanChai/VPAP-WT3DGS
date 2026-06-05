#!/usr/bin/env python3
"""Summarize C1 netem grid manifest into per-cell Q_vis means."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

EXPERIMENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENTS / "common"))

from metrics import compute_run_metrics  # noqa: E402


def q_vis_from_run(run_dir: Path) -> float | None:
    mp = run_dir / "metrics_client.json"
    if not mp.is_file():
        return None
    metrics = json.loads(mp.read_text(encoding="utf-8"))
    parsed = compute_run_metrics(metrics, [20000], [15000])
    return parsed.get("viewer_q_vis_normalized_avg")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest", type=Path, help="grid_manifest_*.json from run_netem_grid.py")
    ap.add_argument("--logs-root", type=Path, default=Path("logs"))
    ap.add_argument("--output", type=Path, default=None)
    args = ap.parse_args()

    entries = json.loads(args.manifest.read_text(encoding="utf-8"))
    cells: dict[tuple, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

    for e in entries:
        if not e.get("gate_pass"):
            continue
        key = (e["bw_mbit"], e["rtt_ms"], e["loss_pct"])
        baseline = e["baseline"]
        rd = args.logs_root / baseline / f"run_{e['run_id']}"
        q = q_vis_from_run(rd)
        if q is not None:
            cells[key][baseline].append(q)

    rows = []
    for key in sorted(cells.keys()):
        bw, rtt, loss = key
        b3 = cells[key].get("baseline3", [])
        b4 = cells[key].get("baseline4", [])
        row = {
            "bw_mbit": bw,
            "rtt_ms": rtt,
            "loss_pct": loss,
            "n_b3": len(b3),
            "n_b4": len(b4),
            "q_vis_b3": statistics.mean(b3) if b3 else "",
            "q_vis_b4": statistics.mean(b4) if b4 else "",
        }
        if b3 and b4:
            row["delta_q_vis"] = row["q_vis_b4"] - row["q_vis_b3"]
            row["winner"] = "B4" if row["delta_q_vis"] > 0 else ("B3" if row["delta_q_vis"] < 0 else "tie")
        rows.append(row)

    out = args.output or args.manifest.with_name(args.manifest.stem + "_summary.csv")
    fields = list(rows[0].keys()) if rows else []
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow(row)

    b4_wins = sum(1 for r in rows if r.get("winner") == "B4")
    print(f"Wrote {out}")
    print(f"Cells with both baselines: {len(rows)}; B4 wins on Q_vis: {b4_wins}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
