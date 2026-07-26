#!/bin/bash
# Apply or reset Linux tc netem shaping (bandwidth, RTT, loss).
#
# Default recipe uses a single netem root with fixed one-way delay (RTT/2) and
# optional loss (no jitter distribution). HTB+jitter can interact poorly with
# QUIC on some hosts; override with custom tc if your platform requires it.
# Set NETEM_IFACE to the bottleneck egress device (default: lo).
set -euo pipefail
TC_BIN="tc"
if ! tc -V >/dev/null 2>&1; then TC_BIN="sudo tc"; fi

IFACE="${NETEM_IFACE:-lo}"

usage() {
    echo "Usage: $0 apply <bandwidth_mbps> <rtt_ms> [loss_percent]"
    echo "       $0 reset"
    exit 1
}

apply_netem() {
    local BW_MBPS="$1"
    local RTT_MS="$2"
    local LOSS_PCT="${3:-0}"
    local DELAY_MS=$(( RTT_MS / 2 ))

    echo "[netem] cell_bw=${BW_MBPS}Mbps RTT=${RTT_MS}ms loss=${LOSS_PCT}% on ${IFACE} (fixed-delay netem; no HTB/jitter)"
    $TC_BIN qdisc del dev "$IFACE" root 2>/dev/null || true
    if awk "BEGIN {exit !($LOSS_PCT > 0)}"; then
        $TC_BIN qdisc add dev "$IFACE" root handle 1: netem \
            delay "${DELAY_MS}ms" loss "${LOSS_PCT}%" limit 10000
    else
        $TC_BIN qdisc add dev "$IFACE" root handle 1: netem \
            delay "${DELAY_MS}ms" limit 10000
    fi
}

reset_netem() {
    echo "[netem] reset ${IFACE}"
    $TC_BIN qdisc del dev "$IFACE" root 2>/dev/null || true
}

[[ $# -ge 1 ]] || usage
case "$1" in
    apply)
        [[ $# -ge 3 ]] || usage
        apply_netem "$2" "$3" "${4:-0}"
        ;;
    reset)
        reset_netem
        ;;
    *)
        usage
        ;;
esac
