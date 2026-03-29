"""Fig1B only (completion rate bar chart). For Fig1C run fig1c_cdf.py in this folder."""
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


def _savefig_pdf(fig, path: Path) -> Path:
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
    """Styling for Fig1B only (this script does not emit Fig1C)."""
    sns.set_theme(style="ticks")
    plt.rcParams.update({
        # Bump font sizes (+3pt vs default)
        'font.size': 24,
        'axes.labelsize': 25,
        'axes.titlesize': 25,
        'xtick.labelsize': 23,
        'ytick.labelsize': 23,
        'legend.fontsize': 21,
        'lines.linewidth': 2.2,
        'pdf.fonttype': 42,
        'ps.fonttype': 42,
    })
    # User-specified 4-color scheme
    return ["#5DA5DA", "#F6C85F", "#66C2A5", "#F28E2B"]

def plot_distributions():
    here = Path(__file__).resolve().parent
    output_dir = here.parent
    df = pd.read_csv(output_dir / 'experiment_summary.csv')
    
    # Map baseline ids to display names
    labels = {"baseline1": "HTTP/1.1", "baseline2": "HTTP/3", "baseline3": "WT", "baseline4": "WT+VPAP"}
    df['baseline_name'] = df['baseline'].map(labels)
    order = ["HTTP/1.1", "HTTP/3", "WT", "WT+VPAP"]
    palette = setup_style()

    # Completion rate as percent
    df['completion_rate_pct'] = df['completion_rate'] * 100

    # ---------------------------------------------------------
    # 1B. Completion Rate: bar + bootstrap CI + run-level dots
    # ---------------------------------------------------------
    fig1, ax1 = plt.subplots(figsize=(7, 5))
    sns.barplot(
        data=df,
        x='baseline_name',
        y='completion_rate_pct',
        order=order,
        hue='baseline_name',
        dodge=False,
        palette=palette,
        errorbar=('ci', 90),
        width=0.6,
        ax=ax1
    )
    if ax1.get_legend() is not None:
        ax1.get_legend().remove()
    ax1.set_xlabel("")
    ax1.set_ylabel("Completion Rate (%)")
    ax1.set_ylim(70, 102)
    ax1.tick_params(axis='x', labelrotation=0)
    # Annotate per-baseline median completion on top of bars
    comp_med = (
        df.groupby('baseline_name', as_index=False)['completion_rate_pct']
        .median()
        .set_index('baseline_name')['completion_rate_pct']
        .to_dict()
    )
    for i, bname in enumerate(order):
        v = comp_med.get(bname, np.nan)
        if pd.isna(v):
            continue
        ax1.text(i, v + 0.9, f"{v:.1f}%", ha='center', va='bottom', fontsize=22, fontweight='bold')
    sns.despine(ax=ax1)

    fig1.tight_layout(pad=1.2)
    _savefig_pdf(fig1, here / "Fig1B_Completion_Bar.pdf")
    plt.close(fig1)

    # Avoid unicode emoji in Windows console (GBK encoding) to prevent UnicodeEncodeError
    print("Generated Fig1B_Completion_Bar.pdf")

if __name__ == "__main__":
    plot_distributions()
