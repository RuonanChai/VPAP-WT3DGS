# Dataset (toy example)

Anonymous artifact size limits usually **exclude** multi‑GB splat corpora. This folder holds a **layout contract** and placeholders.

## Layout under `toy_example/`

| Path | Purpose |
|------|---------|
| `20_lod/L1/…/L4/` | Per-LOD `.splat` chunks, named `{tile_hash}-L{lod}.splat` (must match server reader) |
| `custom_bounding_boxes_mapping-campus2.json` | Tile id list / mapping used by the viewer and server |
| `reference_manifest.json` | Locked workload: list of `tile_id`, `target_lod`, `weight`, `distance` (fair baselines) |
| `initial_selection.json` | Optional fallback initial list (`tileList`, `weightList`) |
| `modelToLoadList_GS.json` | Optional legacy list |
| `camera_trace.json` | **Recommended**: time-stamped camera poses (position, forward, optional MVP) for reproducible viewport |

## How to populate

1. Export a **small spatial patch** (e.g. 5–20 tiles) with **L1–L4** from your preprocessing pipeline.
2. Copy the corresponding mapping/manifest snippets so tile hashes align with the paper’s toy scene.
3. Record a **short camera trajectory** used in figures and attach as `camera_trace.json` (schema documented in your paper appendix).

Do **not** commit access logs or machine-specific paths.
