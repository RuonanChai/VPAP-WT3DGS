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
            # 统一字号调大：按 Fig1C.py 的 rcParams（36-47）
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

    # 为每个 baseline / time_s 取跨 run 的中位数，然后做滚动平滑（骨干曲线）
    stat = (
        df.groupby(["baseline_name", "time_s"], as_index=False)["memory_mb"]
        .median()
        .rename(columns={"memory_mb": "memory_median_mb"})
    )
    stat = stat.sort_values(["baseline_name", "time_s"])

    # 计算采样间隔（通常 0.5s；取中位数用于鲁棒）
    unique_ts = sorted(stat["time_s"].unique().tolist())
    if len(unique_ts) >= 2:
        import numpy as np

        dts = np.diff(unique_ts)
        dt = float(np.median(dts)) if len(dts) else 0.5
    else:
        dt = 0.5

    # “极度平滑”：用较大窗口的滚动均值；不做任何阴影/CI
    smooth_seconds = 3.0  # 平滑尺度（越大越平滑）
    window_points = max(3, int(round(smooth_seconds / dt)))
    # rolling 需要奇数窗口更居中一些
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
    # 同时输出新旧文件名，避免你后续替换 includegraphics 时出错
    out_new = here / "Fig3B_Memory.pdf"
    out_old_compat = here / "Fig_Milestone_Memory_Bar.pdf"
    fig.savefig(out_new, format="pdf", bbox_inches="tight")
    fig.savefig(out_old_compat, format="pdf", bbox_inches="tight")
    plt.close(fig)
    print(f"Generated {out_new}")


plot_smoothed_median_rss_line()