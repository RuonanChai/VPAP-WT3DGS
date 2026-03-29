#!/usr/bin/env python3
"""Fig1B: final QoE vs run index line chart -> Fig1B_QoE_Line_by_Run.pdf"""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns


def main() -> None:
    fig_dir = Path(__file__).resolve().parent
    base = fig_dir.parent
    in_csv = base / "experiment_summary.csv"
    out_dir = fig_dir

    df = pd.read_csv(in_csv)[["baseline", "run_id", "qoe_final"]].copy()
    df["qoe_final"] = pd.to_numeric(df["qoe_final"], errors="coerce")
    df = df.dropna(subset=["qoe_final"])

    order = ["baseline1", "baseline2", "baseline3", "baseline4"]
    labels = {
        "baseline1": "HTTP/1.1",
        "baseline2": "HTTP/3",
        "baseline3": "WT",
        "baseline4": "WT+VPAP",
    }
    palette = sns.color_palette("colorblind", 4)
    colors = {b: palette[i] for i, b in enumerate(order)}

    plt.rcParams.update(
        {
            "font.size": 26,
            "axes.labelsize": 28,
            "axes.titlesize": 28,
            "xtick.labelsize": 24,
            "ytick.labelsize": 24,
            "legend.fontsize": 22,
            "lines.linewidth": 3,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )
    sns.set_style("ticks")

    # Line chart by run index
    fig, ax = plt.subplots(figsize=(14, 6.5))
    for b in order:
        sb = df[df["baseline"] == b].copy()
        if sb.empty:
            continue
        sb["eval_idx"] = sb["run_id"].str.extract(r"run_eval(\d+)").astype(float)
        sb = sb.sort_values("eval_idx")
        ax.plot(sb["eval_idx"], sb["qoe_final"], color=colors[b], alpha=0.95, label=labels[b])
    ax.set_xlabel("Run Index")
    ax.set_ylabel("Final QoE Score")
    ax.legend(
        frameon=False,
        ncol=2,
        loc="upper center",
        bbox_to_anchor=(0.5, 1.18),
        columnspacing=1.2,
        handlelength=2.2,
        handletextpad=0.5,
        borderaxespad=0.2,
    )
    sns.despine(ax=ax)
    fig.tight_layout()
    out_pdf = out_dir / "Fig1B_QoE_Line_by_Run.pdf"
    try:
        fig.savefig(out_pdf, format="pdf", bbox_inches="tight")
    except PermissionError:
        alt = out_dir / "regen"
        alt.mkdir(exist_ok=True)
        p = alt / "Fig1B_QoE_Line_by_Run.pdf"
        fig.savefig(p, format="pdf", bbox_inches="tight")
        print(f"[warn] could not overwrite {out_pdf}; wrote {p}")
    plt.close(fig)

    print(f"[ok] {out_pdf}")


if __name__ == "__main__":
    main()
