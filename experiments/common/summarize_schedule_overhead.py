#!/usr/bin/env python3
"""Summarize VPAP schedule-update overhead from a JSONL overhead log.

Enable logging on the server:
  VPAP_OVERHEAD_LOG=./logs/overhead.jsonl VPAP_SCHEDULE_POLICY=vpap node server/server_vpap.js

Then:
  python experiments/common/summarize_schedule_overhead.py logs/overhead.jsonl
"""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl", type=Path)
    ap.add_argument("--kind", default="schedule")
    args = ap.parse_args()
    xs: list[float] = []
    with args.jsonl.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            ev = json.loads(line)
            if ev.get("kind") != args.kind:
                continue
            v = ev.get("schedule_ms")
            if isinstance(v, (int, float)):
                xs.append(float(v))
    if not xs:
        print("no samples")
        return 2
    xs.sort()
    def pct(p: float) -> float:
        i = min(len(xs) - 1, max(0, int(round((p / 100.0) * (len(xs) - 1)))))
        return xs[i]
    out = {
        "n": len(xs),
        "median_ms": statistics.median(xs),
        "p95_ms": pct(95),
        "mean_ms": statistics.fmean(xs),
        "max_ms": max(xs),
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
