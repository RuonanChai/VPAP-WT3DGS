# VPAP scheduling and WebTransport `sendOrder`

This artifact’s reference implementation is in **`server_vpap.js`**.

## Viewport-aware score (per tile)

Function **`computeVPAPScore(cameraPos, cameraForward, tilePos)`** combines:

- **View alignment**: dot product between camera forward and direction to tile center; outside a cone the score is zeroed (`dot < VPAP_TAU`, default `0.5`).
- **Distance**: `1 / (1 + dist/VPAP_DNORM)` (default `DNORM=2000`) so nearer tiles score higher.
- **Weights**: `P = VPAP_ALPHA * score_view + VPAP_BETA * score_dist` (defaults `0.7` / `0.3`).

Override via environment before starting `server_vpap.js` (OFAT / C6). Also `VPAP_INITIAL_LOAD` controls the initial-load batching threshold (default `100`).

This matches the paper’s **viewport / saliency** term in the priority model.

## Progressive LOD and send order

1. **Workload**: tiles come from `reference_manifest.json` (locked set) or fallback selection.
2. **Chunks to send**: for each tile, missing LOD layers from 1 up to `target_lod` are enqueued.
3. **Application-level order**: sort so **all L1 chunks are scheduled before any L2**, then L3, then L4. **Within the same LOD**, higher `computeVPAPScore` is scheduled first.
4. **QUIC / WebTransport**: each chunk is one **unidirectional** stream created with:

```javascript
const vpap = tile.vpapScore ?? 0.5;
const sendOrder = BigInt(tile.lod * 10000 + Math.floor((1 - vpap) * 1000));
await session.createUnidirectionalStream({ sendOrder, sendGroup: null });
```

**Smaller `sendOrder` ⇒ higher send priority** under the scheduler used by `@fails-components/webtransport`. LOD is encoded in the high-order part (`lod * 10000`); viewport score refines ordering within the same LOD via `(1 - vpap) * 1000`.

## C2 scheduling ablation (`VPAP_SCHEDULE_POLICY`)

Set **`VPAP_SCHEDULE_POLICY`** before starting `server_vpap.js` (see `experiments/c2_scheduling_ablation/restart_wt_server.sh`):

| Policy | Env value | Tile sort order | `sendOrder` |
|--------|-----------|-----------------|-------------|
| WTS-N | `none` | FIFO (no reorder) | `0` |
| WTS-L | `lod` | Coarse-to-fine LOD | `lod * 10000` |
| WTS-D | `dist` | Nearest first | `floor(distance)` |
| WTS-F | `frustum` | In-frustum first, then distance | `(in_view ? 0 : 50000) + floor(distance)` |
| WTS-V | `vpap` | LOD ascending, then utility descending | `lod * 10000 + floor((1-vpap)*1000)` |

All variants share the same WebTransport transport, locked 300-tile reference set, and client telemetry schema.

## Schedule overhead log

Set **`VPAP_OVERHEAD_LOG=/path/to/overhead.jsonl`**. Each genuine schedule update appends one JSON line with `kind: "schedule"` and `schedule_ms` (scoring + within-tier sort, before stream I/O). Summarize with:

```bash
python experiments/common/summarize_schedule_overhead.py /path/to/overhead.jsonl
```

## Baseline without VPAP

**`server_baseline_flat_sendorder.js`** uses the same transport and batching but **does not** differentiate `sendOrder` by VPAP (flat priority), for controlled comparison.
