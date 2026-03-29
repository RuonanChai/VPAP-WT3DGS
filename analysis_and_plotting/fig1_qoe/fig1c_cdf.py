#!/usr/bin/env python3
"""
Fig1C: CDF of absolute tile arrival time (first-byte time relative to session T0).

Unlike per-request TTFB/TSL, this uses one wall clock to compare when chunks arrive across baselines.
Smoothing: interpolate ECDF on a dense log-spaced grid (not a step function).
"""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from matplotlib.lines import Line2D
from matplotlib.transforms import blended_transform_factory


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


def setup_style():
    """Fig1C-only rcParams and palette (separate from generate_fig1_BC.py)."""
    sns.set_theme(style="ticks")
    plt.rcParams.update(
        {
            # Bump font sizes (+3pt vs default)
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
    return ["#5DA5DA", "#F6C85F", "#66C2A5", "#F28E2B"]


def _smooth_ecdf_loggrid(x_ms: np.ndarray, n_grid: int = 2048) -> tuple[np.ndarray, np.ndarray]:
    """Sample log10(x) uniformly; return smooth ECDF curve."""
    x = np.sort(x_ms[np.isfinite(x_ms) & (x_ms > 0)])
    if x.size == 0:
        return np.array([]), np.array([])
    n = x.size
    lo, hi = np.log10(x.min()), np.log10(x.max())
    if hi - lo < 1e-9:
        hi = lo + 1e-3
    grid = np.logspace(lo, hi, n_grid)
    idx = np.searchsorted(x, grid, side="right")
    cdf = idx / n
    return grid, cdf


def plot_absolute_arrival_cdf() -> None:
    here = Path(__file__).resolve().parent
    output_dir = here.parent
    tile_path = output_dir / "tile_level.csv"

    labels = {
        "baseline1": "HTTP/1.1",
        "baseline2": "HTTP/3",
        "baseline3": "WT",
        "baseline4": "WT+VPAP",
    }
    order = ["baseline1", "baseline2", "baseline3", "baseline4"]
    palette = setup_style()

    tile_df = pd.read_csv(tile_path)
    tile_df["time_s"] = pd.to_numeric(tile_df["time_s"], errors="coerce")
    tile_df["ttfb_ms"] = pd.to_numeric(tile_df["ttfb_ms"], errors="coerce")
    # Absolute first-byte arrival (ms) = same as parse_tile_metrics: (req−T0)+(fb−req)
    tile_df["absolute_arrival_ms"] = tile_df["time_s"] * 1000.0 + tile_df["ttfb_ms"]
    tile_df = tile_df.dropna(subset=["absolute_arrival_ms"])
    tile_df = tile_df[tile_df["absolute_arrival_ms"] > 0]

    fig, ax = plt.subplots(figsize=(7, 5))
    # x in data (log), y in axes fraction so median labels do not stack on the CDF axis
    trans_x_axes_y = blended_transform_factory(ax.transData, ax.transAxes)
    # Stagger median label heights per baseline
    median_y_axes = {
        "baseline1": 0.93,
        "baseline2": 0.84,
        "baseline3": 0.70,
        "baseline4": 0.56,
    }
    curve_handles = []
    med = tile_df.groupby("baseline")["absolute_arrival_ms"].median().to_dict()
    _med_vals = [float(v) for v in med.values() if np.isfinite(v)]
    _med_of_meds = float(np.median(_med_vals)) if _med_vals else 0.0

    for i, b in enumerate(order):
        sub = tile_df.loc[tile_df["baseline"] == b, "absolute_arrival_ms"].values
        if sub.size == 0:
            continue
        gx, gy = _smooth_ecdf_loggrid(sub.astype(float))
        if gx.size == 0:
            continue
        ax.plot(gx, gy, color=palette[i], linewidth=2.4, solid_capstyle="round", label=labels[b])
        curve_handles.append(
            Line2D([0], [0], color=palette[i], lw=2.4, linestyle="-", label=labels[b])
        )

        m = float(med.get(b, np.nan))
        if not np.isnan(m):
            ax.axvline(m, color=palette[i], linestyle="--", linewidth=2.2, alpha=0.95)
            # High medians: label left of vline; low medians: right, to reduce overlap
            if _med_of_meds > 0 and m > _med_of_meds * 1.4:
                x_pos = m * 0.90
                ha = "right"
            else:
                x_pos = m * 1.08
                ha = "left"
            y_axes = median_y_axes.get(b, 0.75)
            ax.text(
                x_pos,
                y_axes,
                f"{m / 1000:.2f}s",
                transform=trans_x_axes_y,
                ha=ha,
                va="center",
                color="black",
                fontsize=22,
                bbox=dict(facecolor=palette[i], edgecolor="none", alpha=0.88, pad=0.32),
            )

    ax.set_xscale("log")
    ax.set_xlabel("")
    ax.set_ylabel("CDF")
    handles = curve_handles.copy()
    handles.append(Line2D([0], [0], color="black", lw=2.2, linestyle="--", label="median arrival time"))
    ax.legend(
        handles=handles,
        frameon=False,
        ncol=1,
        loc="upper left",
        fontsize=21,
        handlelength=2.0,
        borderaxespad=0.2,
    )
    sns.despine(ax=ax)

    fig.tight_layout(pad=1.2)

    out = here / "Fig1C_TSL_CDF.pdf"
    _savefig_pdf(fig, out)
    plt.close(fig)
    # Avoid unicode emoji in Windows console (GBK encoding) to prevent UnicodeEncodeError
    print(f"Generated {out} (Absolute Tile Arrival Time CDF)")


if __name__ == "__main__":
    plot_absolute_arrival_cdf()
