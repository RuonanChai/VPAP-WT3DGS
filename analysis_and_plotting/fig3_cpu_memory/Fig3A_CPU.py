from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


def plot_session_averaged_cpu_box() -> None:
    here = Path(__file__).resolve().parent
    output_dir = here.parent  # paper_eval_pipeline/output
    sns.set_theme(style="ticks")
    plt.rcParams.update(
        {
            # Larger fonts (aligned with fig1c_cdf rcParams)
            "font.size": 24,
            "axes.labelsize": 19,
            "axes.titlesize": 25,
            "xtick.labelsize": 19,
            "ytick.labelsize": 19,
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

    df = pd.read_csv(output_dir / "resource_usage.csv")
    df["baseline_name"] = df["baseline"].map(labels_map)
    df = df[df["baseline_name"].notna()].copy()

    # Run-level average CPU usage (session-averaged per run)
    cpu_run = (
        df.groupby(["baseline_name", "run_id"], as_index=False)["cpu_usage"]
        .mean()
        .rename(columns={"cpu_usage": "avg_cpu_usage"})
    )

    fig, ax = plt.subplots(figsize=(6, 5))
    ax.yaxis.grid(True, linestyle="--", color="gray", alpha=0.4)
    ax.set_axisbelow(True)

    sns.boxplot(
        data=cpu_run,
        x="baseline_name",
        y="avg_cpu_usage",
        order=order_names,
        palette=palette,
        ax=ax,
        width=0.6,
        linewidth=2.0,
        boxprops=dict(alpha=0.85),
        fliersize=0,
        hue="baseline_name",
        legend=False,
    )

    ax.set_xlabel("")
    ax.set_ylabel("Average CPU Usage (CPU%)")
    ax.margins(x=0.08)
    sns.despine(ax=ax, left=True)

    fig.tight_layout()

    # Write new filename and legacy alias for LaTeX includegraphics
    out_new = here / "Fig3A_CPU.pdf"
    out_old_compat = here / "Fig_Peak_Memory_Box.pdf"
    fig.savefig(out_new, format="pdf", bbox_inches="tight")
    fig.savefig(out_old_compat, format="pdf", bbox_inches="tight")
    plt.close(fig)
    print(f"Generated {out_new}")


plot_session_averaged_cpu_box()