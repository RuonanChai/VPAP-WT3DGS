from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


def plot_smoothed_median_rss_line() -> None:
    here = Path(__file__).resolve().parent
    output_dir = here.parent  # paper_eval_pipeline/output

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
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "lines.linewidth": 3,
        }
    )

    # Pastel palette aligned with the provided style image
    palette = ["#2a557f", "#45bc9c", "#f05076", "#ffcd6e"]
    labels_map = {
        "baseline1": "HTTP/1.1",
        "baseline2": "HTTP/3",
        "baseline3": "WT",
        "baseline4": "WT+VPAP",
    }
    order_names = ["HTTP/1.1", "HTTP/3", "WT", "WT+VPAP"]
    color_map = dict(zip(order_names, palette))

    df = pd.read_csv(output_dir / "resource_usage.csv")
    df["baseline_name"] = df["baseline"].map(labels_map)
    df = df[df["baseline_name"].notna()].copy()

    # Per (baseline, time_s): median across runs, then rolling smooth (main curve)
    stat = (
        df.groupby(["baseline_name", "time_s"], as_index=False)["memory_mb"]
        .median()
        .rename(columns={"memory_mb": "memory_median_mb"})
    )
    stat = stat.sort_values(["baseline_name", "time_s"])

    # Sample interval (often 0.5s); use median for robustness
    unique_ts = sorted(stat["time_s"].unique().tolist())
    if len(unique_ts) >= 2:
        import numpy as np

        dts = np.diff(unique_ts)
        dt = float(np.median(dts)) if len(dts) else 0.5
    else:
        dt = 0.5

    # Heavy smoothing: wide rolling mean; no CI band
    smooth_seconds = 3.0  # larger = smoother
    window_points = max(3, int(round(smooth_seconds / dt)))
    # Prefer odd window for centered rolling mean
    if window_points % 2 == 0:
        window_points += 1

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.yaxis.grid(True, linestyle="--", color="gray", alpha=0.4)
    ax.set_axisbelow(True)

    marker_map = {
        "HTTP/1.1": "o",
        "HTTP/3": "s",
        "WT": "^",
        "WT+VPAP": "D",
    }
    for b in order_names:
        sb = stat[stat["baseline_name"] == b].sort_values("time_s").copy()
        if sb.empty:
            continue
        sb["memory_smooth"] = (
            sb["memory_median_mb"].rolling(window=window_points, center=True, min_periods=1).mean()
        )
        ax.plot(
            sb["time_s"],
            sb["memory_smooth"],
            color=color_map[b],
            label=b,
            linewidth=4.4,  # +10% thicker than 4.0
            marker=marker_map[b],
            markersize=6,
            markevery=max(1, int(round(2.0 / dt))),
        )

    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Client RSS (MB)")
    ax.margins(x=0.01)
    sns.despine(ax=ax, left=True)
    ax.legend(title="", loc="lower right", frameon=True, ncol=2)

    fig.tight_layout()
    # New filename plus legacy alias for LaTeX includegraphics
    out_new = here / "Fig3B_Memory.pdf"
    out_old_compat = here / "Fig_Milestone_Memory_Bar.pdf"
    fig.savefig(out_new, format="pdf", bbox_inches="tight")
    fig.savefig(out_old_compat, format="pdf", bbox_inches="tight")
    plt.close(fig)
    print(f"Generated {out_new}")


plot_smoothed_median_rss_line()