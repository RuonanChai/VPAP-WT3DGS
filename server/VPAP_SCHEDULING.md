# VPAP scheduling and WebTransport `sendOrder`

This artifact’s reference implementation is in **`server_vpap.js`**.

## Viewport-aware score (per tile)

Function **`computeVPAPScore(cameraPos, cameraForward, tilePos)`** combines:

- **View alignment**: dot product between camera forward and direction to tile center; outside a cone the score is zeroed (implementation threshold `dot < 0.5`).
- **Distance**: `1 / (1 + dist/2000)` so nearer tiles score higher.

This matches the paper’s **viewport / saliency** term in the priority model (denoted \(S_{i,\ell}\) in the paper; server uses one score per tile for ordering chunks, combined with LOD level).

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

## Baseline without VPAP

**`server_baseline_flat_sendorder.js`** uses the same transport and batching but **does not** differentiate `sendOrder` by VPAP (flat priority), for controlled comparison.
