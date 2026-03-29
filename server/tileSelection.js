// Unified Tile Selection Module
// Purpose: Ensure fair comparison - all methods use the same tile selection logic
// This module determines WHICH tiles to load, not HOW to load them
// 
// Usage:
//   const selectedTiles = selectTiles(cameraData, tilesMapping);
//   Returns: Array of { hash, lod, weight, distance }
//
// All baselines (1, 2, 3, 4) MUST use this same function for fair comparison

export function selectTiles(cameraData, tilesMapping) {
  const { cameraPos } = cameraData;
  const cam = cameraPos || [0, 0, 0];
  const cameraWorldPos = { x: cam[0] || 0, y: cam[1] || 0, z: cam[2] || 0 };
  
  const tileSize = 0.7788;
  const originGridX = 524267;
  const originGridZ = 524285;
  
  const tileList = Array.isArray(tilesMapping)
    ? tilesMapping.filter(Boolean)
    : Object.values(tilesMapping || {}).filter(Boolean);
  
  if (tileList.length === 0) {
    return [];
  }
  
  // Step 1: Calculate distance and weight for each tile
  const tileListWithWeight = [];
  for (const tileHash of tileList) {
    const m = tileHash.match(/tile_\d+_(\d+)_(\d+)/);
    if (!m) continue;
    
    const gx = parseInt(m[1]);
    const gz = parseInt(m[2]);
    const wx = (gx - originGridX) * tileSize;
    const wz = (gz - originGridZ) * tileSize;
    const wy = 0;
    
    const dx = cameraWorldPos.x - wx;
    const dy = cameraWorldPos.y - wy;
    const dz = cameraWorldPos.z - wz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Calculate weight based on distance (same thresholds as baseline4)
    let weight = 500;
    if (dist < 500) weight = 20000;      // L4
    else if (dist < 1000) weight = 17000; // L3
    else if (dist < 2000) weight = 9000;  // L2
    else if (dist < 4000) weight = 3000; // L1
    
    tileListWithWeight.push({ hash: tileHash, weight, distance: dist });
  }
  
  // Step 2: Sort by distance (nearest first)
  tileListWithWeight.sort((a, b) => a.distance - b.distance);
  
  // Step 3: Limit to MAX_VISIBLE (same as baseline4)
  const MAX_VISIBLE = 300;
  if (tileListWithWeight.length > MAX_VISIBLE) {
    tileListWithWeight.length = MAX_VISIBLE;
  }
  
  // Step 4: Convert to final format with LOD
  const selectedTiles = tileListWithWeight.map(t => {
    const lod = getLodFromWeight(t.weight);
    return {
      hash: t.hash,
      lod: lod,
      weight: t.weight,
      distance: t.distance
    };
  });
  
  return selectedTiles;
}

// LOD calculation (same as baseline4)
function getLodFromWeight(weight) {
  let lod = 1;
  if (weight > 2000) lod = 2;
  if (weight > 8000) lod = 3;
  if (weight > 16000) lod = 4;
  return lod;
}

// Fixed selection from initial_selection.json (no per-frame camera-driven tile set)
export function getFixedSelectionFromList(initialList) {
  if (!initialList || !initialList.tileList || !initialList.weightList) return [];
  const tileList = initialList.tileList;
  const weightList = initialList.weightList;
  const result = [];
  for (let i = 0; i < tileList.length; i++) {
    const hash = tileList[i];
    const weight = weightList[i] ?? 500;
    const lod = getLodFromWeight(weight);
    result.push({ hash, lod, weight, distance: -weight });
  }
  return result;
}

