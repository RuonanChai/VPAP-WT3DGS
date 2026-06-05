#!/usr/bin/env python3
"""CoNEXT-style metrics from a single run's metrics_client.json (locked reference set)."""

from __future__ import annotations

import json
import math
from pathlib import Path

LOD_LAYER_WEIGHTS = [0.5, 0.2, 0.15, 0.15]
DEFAULT_T_TARGETS = [0.5, 0.8, 0.9]


def _safe_num(x):
    return x if isinstance(x, (int, float)) and not (isinstance(x, float) and math.isnan(x)) else None


def build_reference(metrics: dict) -> dict[str, int]:
    """tile_id -> target_lod from locked initial_selection."""
    ref: dict[str, int] = {}
    for e in metrics.get("initial_selection", []) or []:
        tid = e.get("tile_id") or e.get("hash")
        if not tid:
            continue
        try:
            tgt = max(1, min(4, int(e.get("lod", 1))))
        except (TypeError, ValueError):
            tgt = 1
        ref[str(tid)] = tgt
    return ref


def compute_run_metrics(
    metrics: dict,
    deadlines_ms: list[int],
    checkpoints_ms: list[int],
) -> dict:
    ref = build_reference(metrics)
    n_ref = len(ref)
    telem = metrics.get("tile_telemetry", []) or []

    useful_bytes = 0
    wasted_bytes_app = 0
    total_payload_bytes_telem = 0
    ref_complete: dict[str, dict[int, float]] = {tid: {} for tid in ref}

    for r in telem:
        tid = str(r.get("tile_id", ""))
        lod = r.get("lod")
        b = r.get("bytes", 0) or 0
        if b <= 0:
            continue
        try:
            lod = int(lod)
        except (TypeError, ValueError):
            continue
        total_payload_bytes_telem += b
        tgt = ref.get(tid)
        is_useful = tgt is not None and 1 <= lod <= tgt
        if is_useful:
            useful_bytes += b
            ct = _safe_num(r.get("complete_time"))
            if ct is not None:
                prev = ref_complete[tid].get(lod)
                if prev is None or ct < prev:
                    ref_complete[tid][lod] = ct
        else:
            wasted_bytes_app += b

    events: list[tuple[float, float]] = []
    for tid, tgt in ref.items():
        den_i = sum(LOD_LAYER_WEIGHTS[l - 1] for l in range(1, tgt + 1))
        if den_i <= 0 or n_ref == 0:
            continue
        for lod, ct in ref_complete[tid].items():
            if 1 <= lod <= tgt:
                events.append((ct, (LOD_LAYER_WEIGHTS[lod - 1] / den_i) / n_ref))
    events.sort(key=lambda e: e[0])

    q_at_checkpoint = {cp: 0.0 for cp in checkpoints_ms}
    cum = 0.0
    ei = 0
    for cp in sorted(checkpoints_ms):
        while ei < len(events) and events[ei][0] <= cp:
            cum += events[ei][1]
            ei += 1
        q_at_checkpoint[cp] = cum

    t_targets = {thr: None for thr in DEFAULT_T_TARGETS}
    cum = 0.0
    for t_ms, delta in events:
        cum += delta
        for thr in DEFAULT_T_TARGETS:
            if t_targets[thr] is None and cum >= thr:
                t_targets[thr] = t_ms

    target_complete_time: dict[str, float | None] = {}
    target_met_15s = 0
    target_met_20s = 0
    for tid, tgt in ref.items():
        ct = ref_complete[tid].get(tgt)
        target_complete_time[tid] = ct
        if ct is not None and ct <= 15000:
            target_met_15s += 1
        if ct is not None and ct <= 20000:
            target_met_20s += 1

    deadline_miss = {}
    for d in deadlines_ms:
        miss = sum(
            1 for tid in ref
            if target_complete_time[tid] is None or target_complete_time[tid] > d
        )
        deadline_miss[d] = miss / n_ref if n_ref else None

    mf = metrics.get("metric_fairness", {}) or {}
    stq = metrics.get("spatio_temporal_qoe", {}) or {}
    payload_bytes_app = _safe_num(mf.get("payload_bytes_total")) or total_payload_bytes_telem
    useful_fraction = (useful_bytes / payload_bytes_app) if payload_bytes_app else None

    return {
        "n_ref": n_ref,
        "target_met_15s": target_met_15s,
        "target_met_20s": target_met_20s,
        "useful_byte_fraction_app": useful_fraction,
        "q_eq_at_15000ms": q_at_checkpoint.get(15000),
        "t_80_ms": t_targets.get(0.8),
        "viewer_q_vis_normalized_avg": stq.get("q_vis_normalized_avg") or stq.get("q_vis_avg"),
        "qoe_final": stq.get("qoe_final"),
        "deadline_miss": deadline_miss,
    }


def load_golden(path: Path) -> dict[str, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    ref: dict[str, int] = {}
    for e in data:
        tid = e.get("tile_id") or e.get("hash")
        if tid:
            ref[str(tid)] = int(e.get("lod", 1))
    return ref
