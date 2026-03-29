# Network emulation

- **`tc_shape_example.sh`**: host-level delay/loss via Linux `tc netem`. Set `VPAP_TC_IFACE`, `VPAP_TC_DELAY_MS`, `VPAP_TC_LOSS` as needed.
- **Mininet**: not bundled; place the WebTransport server and browser client on two hosts and apply comparable shaping on the bottleneck link, or bridge through a Mininet switch with `tc` on switch ports.
- **Automation**: for repeated runs (e.g. 100 trials), wrap: start server → apply shaping → open client / Selenium → save `metrics_client.json` → remove `tc` → kill processes. Adapt from your lab’s driver scripts.
