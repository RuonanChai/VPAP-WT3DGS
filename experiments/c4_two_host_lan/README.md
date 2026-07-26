# C4 — Two-host LAN validation

Validates that WTS-V / WTS-L / WTS-N effects transfer beyond same-host co-location.

## Isolation

| Fixed | Varied |
|-------|--------|
| Admitted tile set, useful-byte contract, Chrome major version class | Host placement: media+scheduler on server host; headed Chromium on client host |
| `VPAP_SCHEDULE_POLICY` semantics | Optional representative `tc netem` cell on the server egress |

## Requirements

1. Two machines on a private LAN (or equivalent routed path).
2. Server host runs Caddy (HTTPS assets) + `server/server_vpap.js` (WebTransport).
3. Client host runs headed Chromium with remote debugging enabled.
4. Your `VPAP_EXPERIMENT_CMD` driver can attach to the client browser over SSH tunnel / CDP.

**Double-blind note:** do not commit personal usernames, lab IPs, or institutional paths. Configure via environment variables only.

## Environment

| Variable | Meaning | Example |
|----------|---------|---------|
| `VPAP_LAN_SERVER_HOST` | Server address used by the client | `192.168.0.10` |
| `VPAP_LAN_CLIENT_HOST` | Client SSH / CDP host | `192.168.0.20` |
| `VPAP_LAN_CLIENT_USER` | SSH user on client | `client` |
| `VPAP_LAN_SSH_KEY` | SSH private key path | `~/.ssh/id_ed25519` |
| `VPAP_EXPERIMENT_CMD` | Browser trial driver (same contract as C1–C3) | see `../driver/README.md` |

## Minimal workflow

```bash
# On server host: start assets + WT+VPAP
cd server && npm run start:vpap

# From orchestrator host (often the server):
export VPAP_EXPERIMENT_CMD="python /path/to/run_experiment.py"
python experiments/c4_two_host_lan/run_two_host_batch.py \
  --policies WTS-N,WTS-L,WTS-V \
  --runs-per-policy 10 \
  --trace-id trace_fixed
```

Optional shaped cell (same netem helper as C1):

```bash
NETEM_IFACE=eth0 sudo -E bash experiments/c1_netem/netem_control.sh apply 50 50 0.5
python experiments/c4_two_host_lan/run_two_host_batch.py --tag emulated_50_50_0p5 ...
NETEM_IFACE=eth0 sudo -E bash experiments/c1_netem/netem_control.sh reset
```

## Outputs

```
logs/lan/<tag>/
  run_<policy>_rXX/metrics_client.json
  lan_manifest.json
```

Summarize paired contrasts with your analysis pipeline (artifact ships drivers only; **no result CSVs or plot scripts**).
