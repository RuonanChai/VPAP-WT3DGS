# B1 / B2: HTTP pull (Fetch) and WebSocket RVC (reference)

This artifact’s **`SLM2Loader.js`** combines:

1. **Remote culling / scheduling** — WebSocket (B1/B2) or WebTransport camera stream (B3/B4).
2. **Tile payload download** — **HTTP GET** per splat URL built under `gsResource` (traditional pull).

WebTransport ingestion (B3/B4) is documented in the main `README.md` and `client/README.md`. This file maps **B1/B2** to concrete code paths.

---

## 1. WebSocket RVC (B1 / B2 control plane)

| Step | Where in `SLM2Loader.js` |
|------|-------------------------|
| Connect | `startConnect()` — skips WebTransport when `schedulingStrategy !== 'webtransport'` and `rcServerAddress` is not `webtransport://…`; opens `WebSocket(this.server_ip)`. |
| Send camera | `sceneCulling()` — builds `mvp`, optional **`cameraPos`** (root-local, aligned with `tileSelection.js` on the server), then `ws.send(JSON.stringify(camera_data))`. |
| Receive tile list | `ws.onmessage` — parses UTF-8 JSON with `list` and `weight` (each JSON-encoded array), maps ids through `tilesMapping`, calls `generateLoadingTasks_GS(tileList, weightList)`. |

**Server-side counterpart (artifact):** `server/server_b1_http_rvc.js` — HTTP/1.1 static files + WebSocket on `/rvc` (configurable via `B1_WS_PATH`). For B2, Caddy terminates TLS/HTTP/3 for static files and **proxies** `/rvc` to the same Node process (`server/Caddyfile.b2.example`).

---

## 2. HTTP pull for `.splat` tiles (B1 / B2 data plane)

| Step | Where in `SLM2Loader.js` |
|------|-------------------------|
| Build URLs | `generateLoadingTasks_GS()` — for each `(tile_hash, weight)` from RVC: `url = this.gsResource + loadingLOD + "/" + tile_hash + "-L" + loadingLOD + ".splat"`. |
| Issue requests | `processLoadingTasks_GS()` — `SplatLoader().load(nextTask.url, …)` which uses the browser **Fetch/XHR** stack (HTTP/1.1 on B1, HTTP/3 on B2 when the origin is served over QUIC). |
| Initial list (optional) | `initLoad()` — `FileLoader` GETs `modelToLoadList_GS.json` from `resourcesBaseUrl` when not using WebTransport; seeds work before the first RVC message. |

**Telemetry (fair TTFB):** call `TileTelemetry.recordLogicalRequestStart` / `recordReq` **before** the underlying fetch starts for each tile task (your `CacheMgr` / loader wrapper should hook this; B3/B4 use `recordFromStream` instead).

---

## 3. Configuration knobs (viewer)

Typical B1 setup:

- `rcServerAddress`: `ws://<host>:7080/rvc` (or your deployed path).
- `resourcesBaseUrl`: `http://<host>:7080/` (must serve `sceneWeb.json`, mapping JSON, etc.).
- `gsResource`: `http://<host>:7080/20_lod/` (trailing slash must concatenate to `L{n}/{hash}-L{n}.splat`).
- `schedulingStrategy`: anything other than `'webtransport'` if you are not using WT.

Typical B2 setup (Caddy + B1 WS-only):

- `resourcesBaseUrl` / `gsResource`: `https://<host>:7443/…` (same TLS trust as experiments).
- `rcServerAddress`: `wss://<host>:7443/rvc` (proxied to Node `server_b1_http_rvc.js` on port 7080).

---

## 4. Relation to B3 / B4

- **B3 / B4** disable the per-tile HTTP queue for pushed tiles when `schedulingStrategy === 'webtransport'` (see `generateLoadingTasks_GS` early return) and ingest via `receiveTileStreams()` instead.
- **B1 / B2** rely on **RVC + repeated GETs** as described above; keep **`tileSelection.js`** semantics aligned on the server so all baselines see the same tile *set* when using `reference_manifest.json`.
