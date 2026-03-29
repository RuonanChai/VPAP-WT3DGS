#!/usr/bin/env bash
# Linux tc/netem example: controlled delay and loss on interface $VPAP_TC_IFACE.
set -euo pipefail
IFACE="${VPAP_TC_IFACE:-eth0}"
DELAY_MS="${VPAP_TC_DELAY_MS:-50}"
LOSS_PCT="${VPAP_TC_LOSS:-0}"
echo "Applying netem on ${IFACE}: delay ${DELAY_MS}ms loss ${LOSS_PCT}%"
sudo tc qdisc add dev "${IFACE}" root handle 1: htb default 30
sudo tc class add dev "${IFACE}" parent 1: classid 1:1 htb rate 1000mbit
sudo tc qdisc add dev "${IFACE}" parent 1:1 handle 10: netem delay "${DELAY_MS}ms" loss "${LOSS_PCT}%"
tc qdisc show dev "${IFACE}"
echo "Cleanup: sudo tc qdisc del dev ${IFACE} root"
