# B1 / B2: HTTP pull (Fetch) and when WebSocket appears

## Paper baselines (B1 / B2)

In the reported evaluation, **B1** and **B2** are **pull-only** static hosting with **client-side** tile selection:

- **B1:** Caddy with **`protocols h1` only**, `Cache-Control: no-store`, tiles under **`/assets/20_lod/…`**, same-origin static assets — see the authors’ **`campus2_bounding_boxes-HTTP1.1`** + built **`slm2viewer_HTTP1.1`** layout (not vendored in this artifact). The viewer uses **`useLocalRVC: true`** and leaves **`rcServerAddress`** empty; **no WebSocket** RVC channel.

- **B2:** Caddy with **`protocols h1 h2 h3`**, TLS, same static URL layout over **HTTP/3** — parallel to **`campus2_bounding_boxes-caddy_HTTP3`** and the corresponding viewer build. Again **client-side RVC**, **no WebSocket**.

Reproduce the same *shape* inside this repo with **`server/Caddyfile.b1.example`** and **`server/Caddyfile.b2.example`** (paths point at `dataset/toy_example/`).

---

## Extracted `SLM2Loader.js` (two scheduling modes)

1. **Local RVC** — `useLocalRVC: true`: `sceneCullingLocal()` drives tile lists; **HTTP GET** still loads splats via `gsResource` (see below). Matches the paper’s B1/B2 control plane.

2. **Server WebSocket RVC** — `useLocalRVC: false` and non-empty **`rcServerAddress`** (`ws://…`): `sceneCulling()` sends camera JSON on a WebSocket and receives `list` / `weight` payloads. This path is **optional** for integrations/tests; it is **not** what the paper labels as the HTTP/1.1 baseline transport.

---

## HTTP pull for `.splat` tiles (B1 / B2 data plane)

| Step | Where in `SLM2Loader.js` |
|------|-------------------------|
| Build URLs | `generateLoadingTasks_GS()` — `url = this.gsResource + loadingLOD + "/" + tile_hash + "-L" + loadingLOD + ".splat"`. |
| Issue requests | `processLoadingTasks_GS()` — `SplatLoader().load(nextTask.url, …)` → browser **Fetch/XHR** (HTTP/1.1 on B1, HTTP/3 on B2 when the page origin uses QUIC). |
| Initial list (optional) | `initLoad()` — `FileLoader` GETs `modelToLoadList_GS.json` from `resourcesBaseUrl` when not using WebTransport. |

**Telemetry:** call `TileTelemetry.recordLogicalRequestStart` / `recordReq` **before** the fetch for each tile when instrumenting B1/B2; B3/B4 use `recordFromStream` for WebTransport.

---

## WebSocket RVC (optional; extracted client only)

| Step | Where in `SLM2Loader.js` |
|------|-------------------------|
| Connect | `startConnect()` opens `WebSocket(this.server_ip)` when not using WebTransport. |
| Send camera | `sceneCulling()` — `mvp` + **`cameraPos`** (root-local), `ws.send(JSON.stringify(camera_data))`. |
| Receive tile list | `ws.onmessage` — JSON with string fields `list` / `weight` (JSON-encoded arrays), `generateLoadingTasks_GS(...)`. |

**Optional server:** `server/server_b1_http_rvc.js` — Node static + WebSocket; default path **`/rvc`** is **not** standard — set **`B1_WS_PATH`** if you need another mount. **`npm run start:b1:ws-rvc`** in `server/`.

---

## Viewer URLs (artifact Caddy examples)

**B1 (`Caddyfile.b1.example`, port 8080):**

- `resourcesBaseUrl`: `http://<host>:8080/assets`
- `gsResource`: `http://<host>:8080/assets/20_lod/`
- `useLocalRVC: true`, `rcServerAddress: ""`

**B2 (`Caddyfile.b2.example`, port 8543, HTTPS):**

- `resourcesBaseUrl`: `https://<host>:8543/assets`
- `gsResource`: `https://<host>:8543/assets/20_lod/`
- `useLocalRVC: true`, `rcServerAddress: ""`

WebTransport (B3/B4) is documented in the root **`README.md`**.
