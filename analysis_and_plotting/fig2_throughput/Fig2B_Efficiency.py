#!/usr/bin/env python3
"""Fig2B: per-baseline efficiency boxplot (no outliers), broken y-axis variant."""
from __future__ import annotations

from pathlib import Path

import math

import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import pandas as pd
import seaborn as sns

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


def load_merged(output_dir: Path) -> pd.DataFrame:
    exp = pd.read_csv(output_dir / "experiment_summary.csv")
    net = pd.read_csv(output_dir / "network_summary.csv")
    df = exp.merge(net, on=["baseline", "run_id"], how="inner")
    labels = {
        "baseline1": "HTTP/1.1",
        "baseline2": "HTTP/3",
        "baseline3": "WT",
        "baseline4": "WT+VPAP",
    }
    df["baseline_name"] = df["baseline"].map(labels)
    eff = pd.to_numeric(df["efficiency"], errors="coerce")
    df["efficiency_qoe_per_gb"] = eff * 1000.0
    return df.dropna(subset=["efficiency_qoe_per_gb"])


def plot_fig2b() -> None:
    here = Path(__file__).resolve().parent
    output_dir = here.parent
    df = load_merged(output_dir)
    order = ["HTTP/1.1", "HTTP/3", "WT", "WT+VPAP"]
    palette = setup_style()

    # Vertical boxplot: x=baseline, y=efficiency
    fig, ax = plt.subplots(figsize=(8, 6))
    sns.boxplot(
        data=df,
        x="baseline_name",
        y="efficiency_qoe_per_gb",
        order=order,
        hue="baseline_name",
        hue_order=order,
        palette=palette,
        width=0.78,
        linewidth=1.8,
        fliersize=0,
        legend=False,
        ax=ax,
    )
    ax.set_xlabel("")
    ax.set_ylabel("Efficiency")
    ax.tick_params(axis="x", labelrotation=0)
    ax.margins(x=0.0)

    # Tighter y-range from global quantiles (does not clip box extents)
    values = df["efficiency_qoe_per_gb"].dropna().astype(float)
    if len(values) >= 10:
        q01 = float(values.quantile(0.01))
        q99 = float(values.quantile(0.99))
        span = max(1e-9, q99 - q01)
        y_min = max(0.25, q01 - 0.05 * span)
        y_max = q99 + 0.08 * span
        ax.set_ylim(y_min, y_max)

    ax.set_axisbelow(True)
    ax.grid(axis="y", linestyle="-", linewidth=0.8, alpha=0.35)
    ax.grid(axis="x", visible=False)

    # Ceiling line: B4 (WT+VPAP) q75
    boost_color = "#C82423"
    ceiling_base = "WT+VPAP"  # baseline4
    ceiling_vals = df.loc[df["baseline_name"] == ceiling_base, "efficiency_qoe_per_gb"].dropna().astype(float)
    ceiling_y = float(ceiling_vals.quantile(0.75)) if len(ceiling_vals) else float("nan")

    if math.isfinite(ceiling_y):
        ax.axhline(ceiling_y, linestyle="--", lw=1.8, color=boost_color, alpha=0.9)

        # First three baselines: dashed vertical from each q75 to ceiling_y, label +%
        for i, bname in enumerate(order[:3]):
            vals_i = df.loc[df["baseline_name"] == bname, "efficiency_qoe_per_gb"].dropna().astype(float)
            if len(vals_i) == 0:
                continue
            y_i = float(vals_i.quantile(0.75))
            if y_i <= 0:
                continue
            pct = (ceiling_y - y_i) / y_i * 100.0
            x_pos = i  # seaborn category index ~0..3
            ax.vlines(x_pos, y_i, ceiling_y, colors=boost_color, linestyles="--", lw=1.6, alpha=0.95)
            # Place text near ceiling_y to avoid covering boxes
            y_text = min(ceiling_y + 0.02 * (ax.get_ylim()[1] - ax.get_ylim()[0]), ax.get_ylim()[1] - 1e-6)
            ax.text(
                x_pos,
                y_text,
                f"+{pct:.0f}%",
                ha="center",
                va="bottom",
                fontsize=27,
                fontweight="bold",
                color=boost_color,
            )

    sns.despine(ax=ax)
    fig.tight_layout(pad=0.75)

    out = here / "Fig2B_efficiency.pdf"
    _savefig_pdf(fig, out)
    plt.close(fig)
    print(f"Generated {out}")
    return

    # Broken y-axis: lower and upper panels for low/high ranges
    # Break chosen to span WT high quantiles and WT+VPAP low quantiles without excessive clipping.
    values = df["efficiency_qoe_per_gb"].dropna().astype(float)
    wt = df.loc[df["baseline_name"] == "WT", "efficiency_qoe_per_gb"].dropna().astype(float)
    vpap = (
        df.loc[df["baseline_name"] == "WT+VPAP", "efficiency_qoe_per_gb"].dropna().astype(float)
    )

    # Fallback bounds
    all_min = float(values.min()) if len(values) else 0.3
    all_max = float(values.max()) if len(values) else 2.5

    y_wt_hi = float(wt.quantile(0.95)) if len(wt) else 1.6
    y_vpap_lo = float(vpap.quantile(0.05)) if len(vpap) else 2.1

    if y_vpap_lo > y_wt_hi + 0.1:
        y_break = 0.5 * (y_wt_hi + y_vpap_lo)
    else:
        y_break = 1.9

    # Panel y-limits with small margin (whiskers/arrows not clipped)
    y_bottom_min = max(0.25, float(values.quantile(0.05)) - 0.05 * max(1e-6, y_break - all_min))
    y_bottom_max = y_break
    y_top_min = y_break
    y_top_max = min(all_max + 0.05 * (all_max - y_break + 1e-6), 2.7)

    fig = plt.figure(figsize=(8, 6))
    gs = gridspec.GridSpec(2, 1, height_ratios=[1.05, 0.95], hspace=0.04)
    ax_bottom = fig.add_subplot(gs[0])
    ax_top = fig.add_subplot(gs[1], sharex=ax_bottom)

    # Draw boxplots twice in different y windows (clipping is intentional for broken axis)
    sns.boxplot(
        data=df,
        x="baseline_name",
        y="efficiency_qoe_per_gb",
        order=order,
        hue="baseline_name",
        hue_order=order,
        palette=palette,
        width=0.78,
        linewidth=1.8,
        fliersize=0,
        legend=False,
        ax=ax_bottom,
    )
    sns.boxplot(
        data=df,
        x="baseline_name",
        y="efficiency_qoe_per_gb",
        order=order,
        hue="baseline_name",
        hue_order=order,
        palette=palette,
        width=0.78,
        linewidth=1.8,
        fliersize=0,
        legend=False,
        ax=ax_top,
    )

    # X labels only on bottom axis
    ax_top.tick_params(axis="x", labelbottom=False)
    ax_bottom.tick_params(axis="x", labelrotation=0)

    # Axis limits
    ax_bottom.set_xlim(-0.35, len(order) - 0.35)
    ax_bottom.set_ylim(y_bottom_min, y_bottom_max)
    ax_top.set_xlim(-0.35, len(order) - 0.35)
    ax_top.set_ylim(y_top_min, y_top_max)

    ax_bottom.set_xlabel("")
    ax_top.set_xlabel("")
    ax_bottom.set_ylabel("Efficiency")
    ax_top.set_ylabel("")

    # Grid: y on both panels, x off
    ax_bottom.set_axisbelow(True)
    ax_top.set_axisbelow(True)
    ax_bottom.grid(axis="y", linestyle="-", linewidth=0.8, alpha=0.35)
    ax_top.grid(axis="y", linestyle="-", linewidth=0.8, alpha=0.35)
    ax_bottom.grid(axis="x", visible=False)
    ax_top.grid(axis="x", visible=False)

    # Break marks between panels
    ax_top.spines["bottom"].set_visible(False)
    ax_bottom.spines["top"].set_visible(False)

    d = 0.013
    kwargs = dict(transform=ax_top.transAxes, color="black", clip_on=False, linewidth=1.3)
    ax_top.plot((-d, +d), (-d, +d), **kwargs)
    ax_top.plot((1 - d, 1 + d), (-d, +d), **kwargs)

    kwargs.update(transform=ax_bottom.transAxes)
    ax_bottom.plot((-d, +d), (1 - d, 1 + d), **kwargs)
    ax_bottom.plot((1 - d, 1 + d), (1 - d, 1 + d), **kwargs)

    # Annotations split across panels so nothing spans the break
    if len(wt) and len(vpap):
        boost_color = "#C82423"
        y_start = float(wt.quantile(0.75))
        y_end = float(vpap.quantile(0.75))
        x_arrow = (order.index("WT") + order.index("WT+VPAP")) / 2.0

        boost_pct = float("nan")
        if y_start > 0:
            boost_pct = (y_end - y_start) / y_start * 100.0

        # bottom：y_start -> y_break
        if y_start < y_bottom_max:
            ax_bottom.annotate(
                "",
                xy=(x_arrow, y_bottom_max),
                xytext=(x_arrow, y_start),
                arrowprops=dict(arrowstyle="->", lw=1.8, color=boost_color),
            )

        # top：y_break -> y_end
        if y_end > y_top_min:
            ax_top.annotate(
                "",
                xy=(x_arrow, y_end),
                xytext=(x_arrow, y_top_min),
                arrowprops=dict(arrowstyle="->", lw=1.8, color=boost_color),
            )

        if math.isfinite(boost_pct):
            y_text = min(y_top_max - 0.05 * (y_top_max - y_top_min), y_end + 0.12)
            label = f"↑ {boost_pct:.0f}% QoE Boost"
            ax_top.text(
                x_arrow,
                y_text,
                label,
                ha="center",
                va="bottom",
                fontsize=25,
                fontweight="bold",
                color=boost_color,
            )

    sns.despine(ax=ax_bottom)
    sns.despine(ax=ax_top)

    fig.tight_layout(pad=0.75)

    out = here / "Fig2B_efficiency.pdf"
    _savefig_pdf(fig, out)
    plt.close(fig)
    print(f"Generated {out}")


if __name__ == "__main__":
    plot_fig2b()
