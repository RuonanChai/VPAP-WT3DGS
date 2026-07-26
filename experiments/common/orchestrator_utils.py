#!/usr/bin/env python3
"""Shared helpers for supplementary experiment orchestrators."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ARTIFACT_ROOT = Path(__file__).resolve().parents[2]
COMMON = ARTIFACT_ROOT / "experiments" / "common"
GOLDEN = COMMON / "golden" / "initial_selection_trace1.json"
DEFAULT_LOGS = ARTIFACT_ROOT / "logs"


def artifact_python() -> Path:
    venv = ARTIFACT_ROOT / "venv" / "bin" / "python"
    if venv.is_file():
        return venv
    return Path(sys.executable)


def logs_root() -> Path:
    return Path(os.environ.get("VPAP_LOGS_ROOT", str(DEFAULT_LOGS)))


def experiment_cmd() -> list[str]:
    """Return argv prefix for one browser trial (must accept --baseline --run-id --cache-state --trace-id)."""
    # Use separate environment variables to avoid Windows path parsing issues
    python_path = os.environ.get("VPAP_PYTHON", "").strip()
    script_path = os.environ.get("VPAP_EXPERIMENT_SCRIPT", "").strip()

    if python_path and script_path:
        # Verify paths exist
        if not os.path.isfile(python_path):
            raise RuntimeError(f"VPAP_PYTHON not found: {python_path}")
        if not os.path.isfile(script_path):
            raise RuntimeError(f"VPAP_EXPERIMENT_SCRIPT not found: {script_path}")
        return [python_path, script_path]

    # Fallback to legacy VPAP_EXPERIMENT_CMD (prefer shlex so Windows paths with spaces work)
    raw = os.environ.get("VPAP_EXPERIMENT_CMD", "").strip()
    if not raw:
        raise RuntimeError(
            "Set VPAP_PYTHON and VPAP_EXPERIMENT_SCRIPT, e.g.:\n"
            '  export VPAP_PYTHON="$(which python3)"\n'
            '  export VPAP_EXPERIMENT_SCRIPT="/path/to/run_experiment.py"\n'
            "See experiments/driver/README.md for the required interface."
        )
    import shlex

    try:
        parts = shlex.split(raw, posix=os.name != "nt")
    except ValueError:
        parts = raw.split()
    if len(parts) < 2:
        raise RuntimeError(
            "VPAP_EXPERIMENT_CMD must contain python + script. "
            "Prefer VPAP_PYTHON and VPAP_EXPERIMENT_SCRIPT on Windows."
        )
    return parts


def run_trial(
    *,
    baseline: str,
    run_id: str,
    trace_id: str = "trace1",
    cache_state: str = "cold",
    extra_env: dict[str, str] | None = None,
    timeout_s: int = 360,
) -> bool:
    env = os.environ.copy()
    env.setdefault("VPAP_SKIP_NETLOG", "1")
    if extra_env:
        env.update(extra_env)

    cmd = [
        *experiment_cmd(),
        "--baseline", baseline,
        "--run-id", run_id,
        "--cache-state", cache_state,
        "--trace-id", trace_id,
    ]
    print(f"[trial] {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        cwd=str(ARTIFACT_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout)[-500:]
        print(f"[trial FAIL] exit={result.returncode}\n{tail}")
        return False
    return True


def run_dir(baseline: str, run_id: str) -> Path:
    return logs_root() / baseline / f"run_{run_id}"


def verify_run(run_dir_path: Path) -> tuple[bool, dict]:
    gate = COMMON / "verify_telemetry_gate.py"
    py = artifact_python()
    result = subprocess.run(
        [str(py), str(gate), str(run_dir_path)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    ok = result.returncode == 0
    detail: dict = {}
    metrics = run_dir_path / "metrics_client.json"
    if metrics.is_file():
        try:
            detail = json.loads(metrics.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return ok, {"stdout": result.stdout, "metrics_present": metrics.is_file(), "detail": detail}


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
