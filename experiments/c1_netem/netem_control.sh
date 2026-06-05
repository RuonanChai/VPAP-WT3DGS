#!/bin/bash
# Apply or reset Linux tc netem shaping (bandwidth, RTT, loss).
set -euo pipefail

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

    echo "[netem] ${BW_MBPS}Mbps RTT=${RTT_MS}ms loss=${LOSS_PCT}% on ${IFACE}"
    sudo tc qdisc del dev "$IFACE" root 2>/dev/null || true
    sudo tc qdisc add dev "$IFACE" root handle 1: htb default 10
    sudo tc class add dev "$IFACE" parent 1: classid 1:10 htb \
        rate "${BW_MBPS}mbit" ceil "${BW_MBPS}mbit" burst 15k
    if awk "BEGIN {exit !($LOSS_PCT > 0)}"; then
        sudo tc qdisc add dev "$IFACE" parent 1:10 handle 10: netem \
            delay "${DELAY_MS}ms" 5ms distribution normal loss "${LOSS_PCT}%"
    else
        sudo tc qdisc add dev "$IFACE" parent 1:10 handle 10: netem \
            delay "${DELAY_MS}ms" 5ms distribution normal
    fi
}

reset_netem() {
    echo "[netem] reset ${IFACE}"
    sudo tc qdisc del dev "$IFACE" root 2>/dev/null || true
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
