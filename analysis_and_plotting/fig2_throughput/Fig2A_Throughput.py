#!/usr/bin/env python3
"""Fig2A: bar chart of total transferred payload (MB) with 95% CI (no scatter).

Expected totals:
- HTTP/1.1 baseline drops ~20% of chunks → lower payload (~280 MB).
- Native WT and WT+VPAP complete the full download (~304 MB).
"""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

# Four bands top-to-bottom → baseline1…4 (HTTP/1.1 … WT+VPAP); keep legacy Fig2 colors
PALETTE = ["#FDE69A", "#F9C0C0", "#FF8379", "#009193"]


def _savefig_pdf(fig: plt.Figure, path: Path) -> Path:
    try:
        fig.savefig(path, format="pdf", bbox_inches="tight")
        return path
    except PermissionError:
        alt = path.parent / "regen"
        alt.mkdir(exist_ok=True)
        p = alt / path.name
        fig.savefig(p, format="pdf", bbox_inches="tight")
        print(f"[warn] locked {path}; wrote {p}")
        return p


def setup_style() -> list[str]:
    sns.set_theme(style="ticks")
    plt.rcParams.update(
        {
            # Larger fonts (aligned with fig1c_cdf rcParams)
            "font.size": 24,
            "axes.labelsize": 25,
            "axes.titlesize": 25,
            "xtick.labelsize": 23,
            "ytick.labelsize": 23,
            "legend.fontsize": 21,
            "lines.linewidth": 2.2,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )
    return PALETTE


def load_payload_mb(output_dir: Path) -> pd.DataFrame:
    """Load bytes_total from network_summary.csv and convert to MB."""
    net = pd.read_csv(output_dir / "network_summary.csv")
    labels = {
        "baseline1": "HTTP/1.1",
        "baseline2": "HTTP/3",
        "baseline3": "WT",
        "baseline4": "WT+VPAP",
    }
    net["baseline_name"] = net["baseline"].map(labels)
    net = net[net["baseline_name"].notna()].copy()
    net["bytes_total"] = pd.to_numeric(net["bytes_total"], errors="coerce")
    net["payload_mb"] = net["bytes_total"] / 1_000_000.0
    return net.dropna(subset=["payload_mb"])


def plot_fig2a() -> None:
    here = Path(__file__).resolve().parent
    output_dir = here.parent
    df = load_payload_mb(output_dir)
    order = ["HTTP/1.1", "HTTP/3", "WT", "WT+VPAP"]
    palette = setup_style()

    fig, ax = plt.subplots(figsize=(8, 6))
    sns.barplot(
        data=df,
        x="baseline_name",
        y="payload_mb",
        order=order,
        hue="baseline_name",
        dodge=False,
        palette=palette,
        errorbar=("ci", 95),
        capsize=0.15,
        width=0.6,
        ax=ax,
    )
    if ax.get_legend() is not None:
        ax.get_legend().remove()

    ax.set_xlabel("")
    ax.set_ylabel("Total Transferred Payload (MB)")
    ax.tick_params(axis="x", labelrotation=0)
    ax.set_ylim(250, 320)
    # Value labels on bar tops (font size matches Fig1B style)
    bars = [p for p in ax.patches if p.get_width() > 0]
    for i, bar in enumerate(bars):
        v = float(bar.get_height())
        if not np.isfinite(v):
            continue
        x = bar.get_x() + bar.get_width() / 2.0
        ax.text(
            x,
            v + 4.0,
            f"{v:.0f}",
            ha="center",
            va="bottom",
            fontsize=27,
            fontweight="bold",
            color="black",
        )
    sns.despine(ax=ax)

    fig.tight_layout(pad=1.0)
    out = here / "Fig2A_Throughput.pdf"
    _savefig_pdf(fig, out)
    plt.close(fig)
    print(f"Generated {out}")


if __name__ == "__main__":
    plot_fig2a()
