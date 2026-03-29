# Client modules (extract)

These files are **reference extracts** from the full WebGL/WebGPU viewer. Integrate them into your build pipeline (e.g. Vite/Webpack) or compare against your shipped bundle.

| File | Role |
|------|------|
| `SLM2Loader.js` | WebTransport (B3/B4); B1/B2 **pull** + **local RVC** (paper) or optional WebSocket RVC — see **`HTTP_PULL_AND_RVC.md`** |
| `TileTelemetry.js` | Per-tile lifecycle logging for exported experiment JSON |
| `SpatioTemporalQoETracker.js` | Periodic QoE sampling (50 ms in this snapshot) and multi-term composition |

PSNR/SSIM (if used in the paper) typically live in an offline **analysis** or **capture** path; add your scripts under `analysis_and_plotting/` if you ship them.
