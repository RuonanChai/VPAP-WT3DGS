# Network emulation

- **`tc_shape_example.sh`**: host-level delay/loss via Linux `tc netem`. Set `VPAP_TC_IFACE`, `VPAP_TC_DELAY_MS`, `VPAP_TC_LOSS` as needed.
- **Mininet**: not bundled; place servers and the browser client on Mininet hosts and apply shaping on the **bottleneck** link (or equivalent `tc` on switch ports).
- **Same conditions for all baselines:** In our evaluation, **B1, B2, B3, and VPAP (B4) were run under identical Mininet (or `tc`) settings**—same bandwidth, delay, loss, and queue discipline on the path between the content server and the client—so throughput and QoE numbers are comparable across baselines. Reproduce by applying the **same** profile before each baseline run; only the server process (HTTP/WS, HTTP/3+Caddy, or WebTransport) and client `rcServerAddress` / `gsResource` change.
- **Automation**: for repeated runs (e.g. 100 trials), wrap: start server → apply shaping → open client / Selenium → save `metrics_client.json` → remove `tc` → kill processes. Adapt from your lab’s driver scripts.
