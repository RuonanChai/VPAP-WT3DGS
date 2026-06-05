#!/usr/bin/env python3
"""Telemetry gate for C2 (fixed viewport) and C3 (dynamic viewport) runs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

COMMON = Path(__file__).resolve().parent
sys.path.insert(0, str(COMMON))

from metrics import build_reference, compute_run_metrics, load_golden
GOLDEN = COMMON / "golden" / "initial_selection_trace1.json"
DEFAULT_DEADLINES = [3000, 5000, 10000, 15000]
DEFAULT_CHECKPOINTS = [3000, 5000, 10000, 15000]
MIN_TARGET_MET_20S = 120
MIN_Q_EQ_AT_15S = 0.75

GATES = {
    "G1_golden_selection_match": lambda r: r["golden_match"] == r["n_ref"],
    "G2_target_lod_histogram": lambda r: r["lod_hist"] == {1: 9, 4: 291},
    "G3_ref_bytes_coverage": lambda r: r["ref_with_bytes"] >= 295,
    "G4_target_met_20s": lambda r: r["target_met_20s"] >= MIN_TARGET_MET_20S,
    "G5_useful_byte_fraction": lambda r: (r["useful_byte_fraction"] or 0) >= 0.95,
    "G6_q_eq_at_15s": lambda r: (r["q_eq_at_15000ms"] or 0) >= MIN_Q_EQ_AT_15S,
    "G7_q_vis_normalized_avg": lambda r: (r["q_vis_normalized_avg"] or 0) >= 0.55,
}


def analyze_run(metrics_path: Path, golden_ref: dict[str, int]) -> dict:
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    ref = build_reference(metrics)
    telem = metrics.get("tile_telemetry", []) or []

    golden_match = sum(1 for tid, lod in ref.items() if golden_ref.get(tid) == lod)
    lod_hist: dict[int, int] = {}
    for lod in ref.values():
        lod_hist[lod] = lod_hist.get(lod, 0) + 1

    ref_bytes: set[str] = set()
    ref_complete: dict[str, dict[int, float]] = {tid: {} for tid in ref}
    for r in telem:
        b = r.get("bytes") or 0
        if b <= 0:
            continue
        tid = str(r.get("tile_id", ""))
        if tid not in ref:
            continue
        ref_bytes.add(tid)
        try:
            lod = int(r.get("lod"))
        except (TypeError, ValueError):
            continue
        ct = r.get("complete_time")
        if ct is None:
            continue
        tgt = ref[tid]
        if 1 <= lod <= tgt:
            prev = ref_complete[tid].get(lod)
            if prev is None or ct < prev:
                ref_complete[tid][lod] = ct

    target_met_20s = sum(
        1 for tid, tgt in ref.items()
        if ref_complete[tid].get(tgt) is not None and ref_complete[tid][tgt] <= 20000
    )

    parsed = compute_run_metrics(metrics, DEFAULT_DEADLINES, DEFAULT_CHECKPOINTS)
    stq = metrics.get("spatio_temporal_qoe", {}) or {}

    return {
        "n_ref": len(ref),
        "golden_match": golden_match,
        "lod_hist": lod_hist,
        "ref_with_bytes": len(ref_bytes),
        "target_met_20s": target_met_20s,
        "useful_byte_fraction": parsed.get("useful_byte_fraction_app"),
        "q_eq_at_15000ms": parsed.get("q_eq_at_15000ms"),
        "q_vis_normalized_avg": parsed.get("viewer_q_vis_normalized_avg")
        or stq.get("q_vis_normalized_avg"),
        "t_80_ms": parsed.get("t_80_ms"),
        "qoe_final": stq.get("qoe_final"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify a single experiment run directory.")
    ap.add_argument("run_dir", type=Path, help="Directory containing metrics_client.json")
    args = ap.parse_args()
    run_dir = args.run_dir.resolve()
    metrics_path = run_dir / "metrics_client.json"
    if not metrics_path.is_file():
        print(f"FAIL: missing {metrics_path}")
        return 2

    golden_ref = load_golden(GOLDEN)
    result = analyze_run(metrics_path, golden_ref)
    print(f"Gate report: {run_dir.name}")
    print(json.dumps(result, indent=2))

    failed = [name for name, fn in GATES.items() if not fn(result)]
    for name, fn in GATES.items():
        status = "PASS" if fn(result) else "FAIL"
        print(f"  [{status}] {name}")

    if failed:
        print(f"\nOVERALL: FAIL ({len(failed)} gates)")
        return 1
    print("\nOVERALL: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
