# Client modules (extract)

These files are **reference extracts** from the full WebGL/WebGPU viewer. Integrate them into your build pipeline (e.g. Vite/Webpack) or compare against your shipped bundle.

| File | Role |
|------|------|
| `SLM2Loader.js` | WebTransport connect, camera bidirectional stream, unidirectional tile ingress, fair timing for telemetry |
| `TileTelemetry.js` | Per-tile lifecycle logging for exported experiment JSON |
| `SpatioTemporalQoETracker.js` | Periodic QoE sampling (50 ms in this snapshot) and multi-term composition |

PSNR/SSIM (if used in the paper) typically live in an offline **analysis** or **capture** path; add your scripts under `analysis_and_plotting/` if you ship them.
