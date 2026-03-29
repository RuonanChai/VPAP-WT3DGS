/**
 * WebTransport Tile Server (Fixed & Optimized)
 * 
 * Responsibilities:
 * - Receive client camera pose
 * - Compute visible tiles (distance-based)
 * - Push tiles over QUIC/WebTransport streams
 * - Progressive LOD scheduling
 * 
 * Notes:
 * 1. Coordinate alignment (client 100x scale) for distance math
 * 2. Optional stale-frame discard to reduce head-of-line blocking at app layer
 * 3. Newline-delimited JSON for camera updates
 * 
 * Requires Node.js 20+
 * Run: node server_vpap.js
 */

import { Http3Server } from '@fails-components/webtransport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StreamMetrics } from './StreamMetrics.js';
import { getFixedSelectionFromList, selectTiles } from './tileSelection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Settings
const PORT = Number(process.env.VPAP_PORT || 8444);
const SCALING_FACTOR = 100.0; // Client world scale factor (legacy)

// TLS: no hard-coded sibling repos; use env or ./certs
const CERT_DIR = process.env.VPAP_CERT_DIR
  ? path.resolve(process.env.VPAP_CERT_DIR)
  : path.join(__dirname, 'certs');
const FULLCHAIN_CANDIDATE = process.env.VPAP_TLS_FULLCHAIN
  ? path.resolve(process.env.VPAP_TLS_FULLCHAIN)
  : path.join(CERT_DIR, 'fullchain.pem');
const CERT_PATH_LOCAL = process.env.VPAP_TLS_CERT
  ? path.resolve(process.env.VPAP_TLS_CERT)
  : path.join(CERT_DIR, 'web3d.local.pem');
const KEY_PATH_LOCAL = process.env.VPAP_TLS_KEY
  ? path.resolve(process.env.VPAP_TLS_KEY)
  : path.join(CERT_DIR, 'web3d.local-key.pem');

const KEY_PATH = KEY_PATH_LOCAL;
const CERT_PATH_LEAF = CERT_PATH_LOCAL;
const CERT_PATH = fs.existsSync(FULLCHAIN_CANDIDATE) ? FULLCHAIN_CANDIDATE : CERT_PATH_LEAF;

// Assets default: ../dataset/toy_example (see dataset/README.md)
const BASELINE4_ASSETS = process.env.VPAP_ASSETS_DIR
  ? path.resolve(process.env.VPAP_ASSETS_DIR)
  : path.join(__dirname, '../dataset/toy_example');
const TILES_BASE_PATH = path.join(BASELINE4_ASSETS, '20_lod');
const INIT_LIST_PATH = path.join(BASELINE4_ASSETS, 'initial_selection.json');
const INIT_LIST_FALLBACK = path.join(BASELINE4_ASSETS, 'modelToLoadList_GS.json');
const REFERENCE_MANIFEST_PATH = process.env.VPAP_REFERENCE_MANIFEST
  ? path.resolve(process.env.VPAP_REFERENCE_MANIFEST)
  : path.join(BASELINE4_ASSETS, 'reference_manifest.json');
const MAPPING_PATH_BASELINE4 = path.join(BASELINE4_ASSETS, 'custom_bounding_boxes_mapping-campus2.json');
const MAPPING_PATH_LOCAL = path.join(BASELINE4_ASSETS, 'custom_bounding_boxes_mapping-campus2.json');

// Tile mapping (custom_bounding_boxes_mapping-campus2.json)
let tilesMapping = null;
// Initial tile list (initial_selection.json)
let initialLoadList = null;
// B4: fixed tile set for processCameraData (fairness vs other baselines)
let fixedSelectionTiles = [];
const fixedTileTargetLodMap = new Map();

// Tiles read from disk on demand (OS page cache); no in-memory preload

// Load mapping and initial lists
function loadTilesMapping() {
  try {
    // Prefer assets under VPAP_ASSETS_DIR, then local fallbacks
    const mappingPath = fs.existsSync(MAPPING_PATH_BASELINE4) ? MAPPING_PATH_BASELINE4 : MAPPING_PATH_LOCAL;
    const data = fs.readFileSync(mappingPath, 'utf8');
    tilesMapping = JSON.parse(data);
    console.log(`✅ Loaded ${Object.keys(tilesMapping).length} tiles mapping`);
    
    // Prefer reference_manifest.json for locked workload across baselines
    if (fs.existsSync(REFERENCE_MANIFEST_PATH)) {
      const manifest = JSON.parse(fs.readFileSync(REFERENCE_MANIFEST_PATH, 'utf8'));
      const items = Array.isArray(manifest?.items) ? manifest.items : [];
      fixedSelectionTiles = items.map((x) => ({
        hash: x.tile_id,
        lod: Math.max(1, Math.min(4, Number(x.target_lod || x.lod || 1))),
        weight: Number(x.weight || 500),
        distance: Number(x.distance || 0),
      }));
      fixedTileTargetLodMap.clear();
      for (const t of fixedSelectionTiles) fixedTileTargetLodMap.set(t.hash, t.lod);
      console.log(`✅ B4 locked reference_manifest: ${fixedSelectionTiles.length} tiles`);
    } else {
      // Fallback: legacy initial_selection.json
      const initPath = fs.existsSync(INIT_LIST_PATH) ? INIT_LIST_PATH : INIT_LIST_FALLBACK;
      if (fs.existsSync(initPath)) {
        const initData = fs.readFileSync(initPath, 'utf8');
        initialLoadList = JSON.parse(initData);
        if (initialLoadList.tileList && initialLoadList.tileList.length > 0) {
          fixedSelectionTiles = getFixedSelectionFromList(initialLoadList);
          for (const t of fixedSelectionTiles) fixedTileTargetLodMap.set(t.hash, t.lod);
          console.log(`✅ B4 fallback initial_selection: ${fixedSelectionTiles.length} tiles`);
        } else {
          console.warn(`⚠️ Initial list is empty`);
          initialLoadList = null;
        }
      } else {
        console.warn(`⚠️ Initial list not found at ${initPath}, startup might be blurry.`);
      }
    }
  } catch (error) {
    console.error('❌ Failed to load resources:', error);
    process.exit(1);
  }
}

// 4x4 matrix × 4x1 vector
function multiplyMatrixVector(matrix, vector) {
  const [x, y, z, w] = vector;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w
  ];
}

// VPAP: tile center from hash (same convention as tileSelection.js)
const TILE_SIZE = 0.7788;
const ORIGIN_GRID_X = 524267;
const ORIGIN_GRID_Z = 524285;
function getTilePosFromHash(hash) {
  const m = String(hash).match(/tile_\d+_(\d+)_(\d+)/);
  if (!m) return null;
  const gx = parseInt(m[1]);
  const gz = parseInt(m[2]);
  return {
    x: (gx - ORIGIN_GRID_X) * TILE_SIZE,
    y: 0,
    z: (gz - ORIGIN_GRID_Z) * TILE_SIZE
  };
}

// VPAP viewport-aware score P(i)
// P(i) = 0.7 * score_view + 0.3 * score_dist
function computeVPAPScore(cameraPos, cameraForward, tilePos) {
  if (!cameraPos || !cameraForward || !tilePos) return 0.5; // fallback
  const cx = cameraPos[0] ?? 0, cy = cameraPos[1] ?? 0, cz = cameraPos[2] ?? 0;
  const fx = cameraForward[0] ?? 0, fy = cameraForward[1] ?? 0, fz = cameraForward[2] ?? 0;
  const tx = tilePos.x, ty = tilePos.y, tz = tilePos.z;
  const dx = tx - cx, dy = ty - cy, dz = tz - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-6) return 1; // coincident
  const vecToTileLen = dist;
  const vx = dx / vecToTileLen, vy = dy / vecToTileLen, vz = dz / vecToTileLen;
  const dot = fx * vx + fy * vy + fz * vz;
  const scoreView = dot < 0.5 ? 0 : dot;
  const scoreDist = 1 / (1 + dist / 2000);
  return 0.7 * scoreView + 0.3 * scoreDist;
}

// Optional frustum test; if disabled, always true
function isTileInView(mvpMatrix, worldPos, enable = true) {
  if (!enable) return true;
  if (!Array.isArray(mvpMatrix) || mvpMatrix.length !== 16) return true;
  const [cx, cy, cz, cw] = multiplyMatrixVector(mvpMatrix, [worldPos.x, worldPos.y, worldPos.z, 1]);
  // cw <= 0: behind camera
  if (cw <= 0) return false;
  const nx = cx / cw;
  const ny = cy / cw;
  const nz = cz / cw;
    // Loosen frustum margin so center tiles are not over-culled (matches client CameraFrameUpscale=1.2)
    const margin = 1.2;
    // Keep tiles in frustum and in front of camera
    // nz > 0.1: in front of camera (threshold relaxed with wider margin)
    return nx > -margin && nx < margin && ny > -margin && ny < margin && nz > 0.1 && nz < 1.1;
}

// Visible tiles by distance (matches static client policy; frustum off in this path)
function computeVisibleTiles(cameraData) {
  const { cameraPos } = cameraData;
  const mvpMatrix = cameraData.mvp;
  const frustumEnabled = Array.isArray(mvpMatrix) && mvpMatrix.length === 16;
  // Dynamic range from camera (no fixed focus bubble)
  // const FOCUS_CENTER = { x: -28158.88, y: 0, z: -20181.29 };
  // const FOCUS_RADIUS = 1000;
  
  // All tile ids from mapping (same as client)
  const tileList = Array.isArray(tilesMapping)
    ? tilesMapping.filter(Boolean)
    : Object.values(tilesMapping || {}).filter(Boolean);
  
  if (tileList.length === 0) {
    console.warn('tilesMapping empty');
    return [];
  }
  
  const tileSize = 0.7788;
  const originGridX = 524267;
  const originGridZ = 524285;
  
  // Camera position in local space (client already scaled)
  const camPos = cameraPos || [0, 0, 0];
  const cameraWorldPos = {
    x: camPos[0] || 0,
    y: camPos[1] || 0,
    z: camPos[2] || 0
  };
  
  const tileListWithWeight = [];
  
  // Distance logic aligned with client (frustum hooks available)
  for (let i = 0; i < tileList.length; i++) {
    const tileHash = tileList[i];
    const m = tileHash.match(/tile_\d+_(\d+)_(\d+)/);
    if (!m) continue;
    
    const gx = parseInt(m[1]);
    const gz = parseInt(m[2]);
    
    const wx = (gx - originGridX) * tileSize;
    const wz = (gz - originGridZ) * tileSize;
    const wy = 0;
    
    // Match HTTP/1.1 baseline: distance sort only (no frustum cull here)
    // Euclidean distance to tile center
    const dx = cameraWorldPos.x - wx;
    const dy = cameraWorldPos.y - wy;
    const dz = cameraWorldPos.z - wz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Add all tiles; nearest-first approximates center importance (HTTP/1.1 parity)
    tileListWithWeight.push({ 
      hash: tileHash, 
      distance: dist
    });
  }
  
  // No frustum-only empty set here
  // If empty, no tiles
  if (tileListWithWeight.length === 0) {
    console.warn('⚠️ No tiles found (tileListWithWeight is empty)');
    return [];
  }

  // Sort by distance ascending (nearest first); matches HTTP/1.1 baseline
  tileListWithWeight.sort((a, b) => a.distance - b.distance);
  
  // Cap visible tiles (experiment INITIAL_TILE_CAP)
  const MAX_VISIBLE = 300;
  
  // Debug: first 10 tiles before cap
  if (tileListWithWeight.length > 0) {
    const debugTiles = tileListWithWeight.slice(0, 10).map(t => {
      const m = t.hash.match(/tile_\d+_(\d+)_(\d+)/);
      let tilePos = 'N/A';
      if (m) {
        const gx = parseInt(m[1]);
        const gz = parseInt(m[2]);
        const wx = ((gx - originGridX) * tileSize).toFixed(2);
        const wz = ((gz - originGridZ) * tileSize).toFixed(2);
        tilePos = `[${wx}, 0, ${wz}]`;
      }
      return {
        hash: t.hash,
        distance: t.distance.toFixed(2),
        pos: tilePos
      };
    });
    console.log(`🔍 [Before MAX_VISIBLE] First 10 tiles:`, debugTiles);
  }
  
  if (tileListWithWeight.length > MAX_VISIBLE) {
    tileListWithWeight.length = MAX_VISIBLE;
  }
  
  // Debug: after cap
  if (tileListWithWeight.length > 0) {
    console.log(`🔍 [After MAX_VISIBLE=${MAX_VISIBLE}] Selected ${tileListWithWeight.length} tiles`);
  }
  
  // Distance→weight buckets (fixed thresholds; aligns with client LOD policy)
  tileListWithWeight.forEach((t) => {
    let weight = 500;
    if (t.distance < 500) weight = 20000;      // L4
    else if (t.distance < 1000) weight = 17000; // L3
    else if (t.distance < 2000) weight = 9000;  // L2
    else if (t.distance < 4000) weight = 3000;  // L1
    t.weight = weight;
  });
  
  // Debug: distance/weight histogram
  if (tileListWithWeight.length > 0) {
    const minDist = tileListWithWeight[0].distance;
    const maxDist = tileListWithWeight[tileListWithWeight.length - 1].distance;
    const weightCounts = { 500: 0, 3000: 0, 9000: 0, 17000: 0, 20000: 0 };
    tileListWithWeight.forEach(t => {
      weightCounts[t.weight] = (weightCounts[t.weight] || 0) + 1;
    });
    console.log(`📏 Distance range: min=${minDist.toFixed(2)}, max=${maxDist.toFixed(2)}`);
    console.log(`⚖️ Weight distribution: 500=${weightCounts[500]}, 3000=${weightCounts[3000]}, 9000=${weightCounts[9000]}, 17000=${weightCounts[17000]}, 20000=${weightCounts[20000]}`);
    
    // Nearest 5 tiles
    const nearest5 = tileListWithWeight.slice(0, 5);
    console.log(`🎯 Nearest 5 tiles:`, nearest5.map(t => 
      `hash=${t.hash}, dist=${t.distance.toFixed(2)}, weight=${t.weight}, LOD=${getLodFromWeight(t.weight)}`
    ));
  }
  
  // Final visible tile records with LOD
  const visibleTiles = tileListWithWeight.map(t => {
    // LOD from weight (client getLodFromWeight)
    const lod = getLodFromWeight(t.weight);
    
    return {
      hash: t.hash,
      lod: lod,
      weight: t.weight,
      distance: t.distance
    };
  });
  
  // Return capped list; client may further filter
  return visibleTiles;
}

// LOD from weight (matches client)
function getLodFromWeight(weight) {
  let lod = 1;
  if (weight > 2000) {
    lod = 2;
  }
  if (weight > 8000) {
    lod = 3;
  }
  if (weight > 16000) {
    lod = 4;
  }
  return lod;
}

// Fallback: distance-only visible set when MVP invalid
function computeVisibleTilesByDistance(cameraData) {
  const { cameraPos } = cameraData;
  
  const tileList = Array.isArray(tilesMapping)
    ? tilesMapping.filter(Boolean)
    : Object.values(tilesMapping || {}).filter(Boolean);
  
  if (tileList.length === 0) {
    return [];
  }
  
  const tileSize = 0.7788;
  const originGridX = 524267;
  const originGridZ = 524285;
  
  // Camera in local space
  const camPos = cameraPos || [0, 0, 0];
  const cameraWorldPos = {
    x: camPos[0] || 0,
    y: camPos[1] || 0,
    z: camPos[2] || 0
  };
  
  const tileListWithWeight = [];
  
  for (let i = 0; i < tileList.length; i++) {
    const tileHash = tileList[i];
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
    
    let weight = 500;
    if (dist < 150) weight = 20000;
    else if (dist < 400) weight = 17000;
    else if (dist < 900) weight = 9000;
    else if (dist < 2000) weight = 3000
    
    tileListWithWeight.push({ hash: tileHash, weight, distance: dist });
  }
  
  // Sort by distance
  tileListWithWeight.sort((a, b) => a.distance - b.distance);
  
  const visibleTiles = tileListWithWeight.map(t => {
    const lod = getLodFromWeight(t.weight);
    
    return {
      hash: t.hash,
      lod: lod,
      weight: t.weight,
      distance: t.distance
    };
  });
  
  return visibleTiles;
}

// WeakMap: latest requestId per session (optional stale-frame discard)
const sessionLatestRequestId = new WeakMap();
// Serialize processCameraData per session so L1 completes before L2/L3/L4
const sessionProcessCameraPromise = new WeakMap();
// Per session: which LOD layers were already pushed (progressive L1..L4)
// Shape: Map<tileHash, Set<lod>>
const sessionTileLodSetMap = new WeakMap();
// Last camera pose for movement detection
const sessionLastCameraPos = new WeakMap();
// Last frame's tile hash set
const sessionLastTileHashes = new WeakMap();

// Serialized pipeline: all L1 before any L2, etc.
function scheduleProcessCameraData(cameraData, session) {
  let prev = sessionProcessCameraPromise.get(session);
  if (!prev) prev = Promise.resolve();
  const next = prev
    .then(() => processCameraData(cameraData, session))
    .catch((e) => {
      console.error('❌ processCameraData error:', e);
    });
  sessionProcessCameraPromise.set(session, next);
  return next;
}

// Handle camera update and push tiles
async function processCameraData(cameraData, session) {
  const myId = cameraData.id;
  
  // Stale-frame discard disabled for baseline fairness
  const latestId = sessionLatestRequestId.get(session) || 0;
  // Fairness: no application-layer frame truncation vs other baselines
  try {
    console.log(`📥 [processCameraData] camera update (requestId: ${cameraData.id})`);
    if (cameraData.cameraPos) {
      console.log(`📍 [processCameraData] cameraPos: [${cameraData.cameraPos[0]?.toFixed(2)}, ${cameraData.cameraPos[1]?.toFixed(2)}, ${cameraData.cameraPos[2]?.toFixed(2)}]`);
    }
    
    // Fairness: same fixed tile set as B1–B3; only send order differs (VPAP)
    let visibleTiles = fixedSelectionTiles.length ? fixedSelectionTiles : selectTiles(cameraData, tilesMapping);
    console.log(`🎯 [processCameraData] selected: ${visibleTiles.length} tiles`);
    
    // LOD histogram
    const lodCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    visibleTiles.forEach(t => lodCounts[t.lod] = (lodCounts[t.lod] || 0) + 1);
    console.log(`📊 [processCameraData] LOD counts: L1=${lodCounts[1]}, L2=${lodCounts[2]}, L3=${lodCounts[3]}, L4=${lodCounts[4]}`);
    
    // Debug: first 10 tiles
    if (visibleTiles.length > 0) {
      console.log(`🔍 First 10 tiles:`, visibleTiles.slice(0, 10).map(t => 
        `${t.hash} L${t.lod} (weight=${t.weight}, dist=${t.distance.toFixed(2)})`
      ));
    }
    
    // Sort: higher target LOD first, then nearer distance
    const sortedTiles = [...visibleTiles].sort((a, b) => {
      if (a.lod !== b.lod) {
        return b.lod - a.lod; // higher LOD first
      }
      return a.distance - b.distance; // same LOD: nearer first
    });
    
    // Detect camera motion beyond threshold
    const lastCameraPos = sessionLastCameraPos.get(session);
    const currentCameraPos = cameraData.cameraPos ? 
      `${cameraData.cameraPos[0]?.toFixed(1)},${cameraData.cameraPos[1]?.toFixed(1)},${cameraData.cameraPos[2]?.toFixed(1)}` : null;
    const CAMERA_MOVE_THRESHOLD = 10.0; // small moves still trigger updates
    let cameraMoved = false;
    if (lastCameraPos && currentCameraPos) {
      const [lx, ly, lz] = lastCameraPos.split(',').map(Number);
      const [cx, cy, cz] = currentCameraPos.split(',').map(Number);
      const moveDist = Math.sqrt((cx - lx) ** 2 + (cy - ly) ** 2 + (cz - lz) ** 2);
      cameraMoved = moveDist > CAMERA_MOVE_THRESHOLD;
      if (cameraMoved) {
        console.log(`📷 Camera moved ${moveDist.toFixed(2)} units, allowing re-push for new tiles`);
      }
    }
    if (currentCameraPos) {
      sessionLastCameraPos.set(session, currentCameraPos);
    }
    
    // Progressive LOD: push 1..targetLod per tile; track pushed LODs in Map
    const tileLodSetMap = sessionTileLodSetMap.get(session) || new Map();
    sessionTileLodSetMap.set(session, tileLodSetMap);
    const requiredTiles = []; // { hash, lod, weight, distance, prevLodSet, ... }
    
    // Count newly seen tile hashes
    const newTileHashes = new Set();
    for (const t of sortedTiles) {
      if (!tileLodSetMap.has(t.hash)) {
        newTileHashes.add(t.hash);
      }
    }
    
    // Heuristic: initial load if few LOD chunks pushed so far
    const totalPushedTiles = Array.from(tileLodSetMap.values()).reduce((sum, lodSet) => sum + lodSet.size, 0);
    const isInitialLoad = totalPushedTiles < 100;
    
    // Build missing LOD work items per tile
    let newTileCount = 0;
    let newTileWithNeededLods = 0;
    for (const t of sortedTiles) {
      const prevLodSet = tileLodSetMap.get(t.hash) || new Set();
      const targetLod = t.lod; // e.g. 4 => L1..L4
      const isNewTile = prevLodSet.size === 0;
      
      if (isNewTile) {
        newTileCount++;
      }
      
      // Initial load: VPAP orders within each LOD; still send 1..targetLod per tile
      if (isInitialLoad) {
        const targetLod = t.lod;
        const tilePos = getTilePosFromHash(t.hash);
        const vpapScore = tilePos && cameraData.cameraForward
          ? computeVPAPScore(cameraData.cameraPos, cameraData.cameraForward, tilePos)
          : 0.5;
        for (let lod = 1; lod <= targetLod; lod++) {
          if (!prevLodSet.has(lod)) {
            requiredTiles.push({
              hash: t.hash,
              lod: lod,
              weight: t.weight,
              distance: t.distance,
              targetLod: targetLod,
              prevLodSet: prevLodSet,
              isNewTile: isNewTile,
              vpapScore
            });
          }
        }
        if (isNewTile && targetLod > 0) {
          newTileWithNeededLods++;
        }
      } else {
        // Camera updates: push missing LODs up to targetLod (no duplicates)
        
        if (targetLod > 0) {
          // Missing LODs from 1..targetLod
          const missingLods = [];
          for (let lod = 1; lod <= targetLod; lod++) {
            if (!prevLodSet.has(lod)) {
              missingLods.push(lod);
            }
          }
          
          // Skip already-pushed LODs
          if (missingLods.length > 0) {
            const tilePos = getTilePosFromHash(t.hash);
            const vpapScore = tilePos && cameraData.cameraForward
              ? computeVPAPScore(cameraData.cameraPos, cameraData.cameraForward, tilePos)
              : 0.5;
            for (const lod of missingLods) {
              requiredTiles.push({
                hash: t.hash,
                lod: lod,
                weight: t.weight,
                distance: t.distance,
                targetLod: targetLod,
                prevLodSet: prevLodSet,
                isNewTile: isNewTile,
                vpapScore
              });
            }
            if (isNewTile) {
              newTileWithNeededLods++;
            }
          }
        }
      }
    }
    
    // Debug: new tiles
    if (newTileCount > 0) {
      console.log(`🆕 Found ${newTileCount} new tiles (never pushed before), ${newTileWithNeededLods} have needed LODs`);
      if (newTileCount > newTileWithNeededLods) {
        console.warn(`   ⚠️ ${newTileCount - newTileWithNeededLods} new tiles have no needed LODs (targetLod might be 0 or invalid)`);
      }
    }
    const dedupSkip = sortedTiles.length - (new Set(requiredTiles.map(t => t.hash)).size);
    
    // Debug: tile set delta vs last frame
    const currentTileHashes = new Set(sortedTiles.map(t => t.hash));
    const lastTileHashes = sessionLastTileHashes.get(session);
    if (lastTileHashes) {
      const commonHashes = new Set([...currentTileHashes].filter(h => lastTileHashes.has(h)));
      const newHashes = new Set([...currentTileHashes].filter(h => !lastTileHashes.has(h)));
      const removedHashes = new Set([...lastTileHashes].filter(h => !currentTileHashes.has(h)));
      if (newHashes.size > 0 || removedHashes.size > 0) {
        console.log(`🔄 Tile set changed: +${newHashes.size} new, -${removedHashes.size} removed, ${commonHashes.size} common`);
        if (newHashes.size > 0 && newHashes.size <= 5) {
          console.log(`   New tile hashes: ${Array.from(newHashes).join(', ')}`);
          // Debug: new tile work items
          for (const newHash of newHashes) {
            const newTileRequired = requiredTiles.filter(t => t.hash === newHash);
            const newTileInSorted = sortedTiles.find(t => t.hash === newHash);
            if (newTileRequired.length === 0 && newTileInSorted) {
              const prevLodSet = tileLodSetMap.get(newHash) || new Set();
              console.log(`   ⚠️ New tile ${newHash} (targetLod=${newTileInSorted.lod}, prevLods=[${Array.from(prevLodSet).join(',')}]) was NOT added to requiredTiles!`);
            } else if (newTileRequired.length > 0) {
              const lods = newTileRequired.map(t => `L${t.lod}`).join('+');
              console.log(`   ✅ New tile ${newHash} will push: ${lods}`);
            }
          }
        }
      } else {
        console.log(`⚠️ Tile set unchanged: all ${currentTileHashes.size} tiles are the same as last frame`);
      }
    }
    // Remember tile set for next frame
    sessionLastTileHashes.set(session, currentTileHashes);
    
    // Two-level order: (1) all L1 before any L2..L4; (2) within same LOD, higher VPAP first
    requiredTiles.sort((a, b) => {
      if (a.lod !== b.lod) return a.lod - b.lod; // L1 before L2 before L3 before L4
      if (a.vpapScore != null && b.vpapScore != null) {
        return b.vpapScore - a.vpapScore; // same LOD: higher VPAP first
      }
      return a.distance - b.distance;
    });
    
    const tilesToPush = requiredTiles;
    
    // Batched concurrency (WebTransport has a finite stream budget; huge batches => "No streams available")
    const CONCURRENT_BATCH_SIZE = isInitialLoad ? 120 : 100;
    const BATCH_DELAY_MS = isInitialLoad ? 2 : 10;
    
    if (isInitialLoad) {
      const lodCounts = {};
      tilesToPush.forEach(t => {
        lodCounts[`L${t.lod}`] = (lodCounts[`L${t.lod}`] || 0) + 1;
      });
      console.log(`🚀 Initial load mode: batch_size=${CONCURRENT_BATCH_SIZE}, delay=${BATCH_DELAY_MS}ms`);
      console.log(`   📊 LOD distribution: ${Object.entries(lodCounts).map(([lod, count]) => `${lod}=${count}`).join(', ')}`);
    }
    
    if (dedupSkip > 0) {
      console.log(`♻️ Skip ${dedupSkip} tiles (all LODs already pushed for these tiles)`);
      // Debug: sample skipped tiles (fully pushed)
      const skippedHashes = sortedTiles.filter(t => {
        const prevLodSet = tileLodSetMap.get(t.hash) || new Set();
        for (let lod = 1; lod <= t.lod; lod++) {
          if (!prevLodSet.has(lod)) {
            return false;
          }
        }
        return true;
      }).slice(0, 5).map(t => t.hash);
      if (skippedHashes.length > 0) {
        console.log(`   Skipped tile samples: ${skippedHashes.join(', ')}`);
      }
    }
    if (requiredTiles.length > 0) {
      // Debug: group LODs by tile
      const tileGroups = {};
      requiredTiles.forEach(t => {
        if (!tileGroups[t.hash]) {
          tileGroups[t.hash] = [];
        }
        tileGroups[t.hash].push(t.lod);
      });
      const sampleTiles = Object.entries(tileGroups).slice(0, 5);
      console.log(`📋 Will push ${requiredTiles.length} LOD chunks for ${Object.keys(tileGroups).length} tiles`);
      if (isInitialLoad) {
        console.log(`   🎯 Initial load strategy: Level 2A - all L1 first (VPAP-sorted), then L2→L3→L4`);
      } else {
        console.log(`   🎯 Subsequent load: Push LOD based on distance (far→L1, near→L4, no duplicates)`);
      }
      sampleTiles.forEach(([hash, lods]) => {
        console.log(`   ${hash}: L${lods.sort((a, b) => a - b).join('+L')}`);
      });
    }
    
    let totalPushed = 0;
    let totalSkipped = 0;
    const pushStartTime = Date.now();

    // Warm OS page cache on initial load (optional preload)
    if (isInitialLoad && tilesToPush.length > 0) {
      const preloadStartTime = Date.now();
      console.log(`📦 Preloading ${tilesToPush.length} tiles to cache...`);
      const preloadPromises = tilesToPush.map(tile => 
        readTileFile(tile.hash, tile.lod).catch(() => null)
      );
      await Promise.allSettled(preloadPromises);
      const preloadElapsed = Date.now() - preloadStartTime;
      console.log(`✅ Preload completed: ${preloadElapsed}ms (${(preloadElapsed / tilesToPush.length).toFixed(1)}ms/tile)`);
    }
    
    // Push in batches
    for (let batchStart = 0; batchStart < tilesToPush.length; batchStart += CONCURRENT_BATCH_SIZE) {
      const batch = tilesToPush.slice(batchStart, batchStart + CONCURRENT_BATCH_SIZE);
      const batchNum = Math.floor(batchStart / CONCURRENT_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(tilesToPush.length / CONCURRENT_BATCH_SIZE);
      const batchStartTime = Date.now();

      // Fairness: no application-layer batch abort vs other baselines

      // Concurrent push for this batch
      const pushPromises = batch.map(async (tile) => {
        try {
          const ok = await pushSingleTile(session, { ...tile });
          if (ok) {
            // Track pushed LOD (progressive loading)
            const lodSet = tileLodSetMap.get(tile.hash) || new Set();
            lodSet.add(tile.lod);
            tileLodSetMap.set(tile.hash, lodSet);
            return { success: true, hash: tile.hash, lod: tile.lod };
          } else {
            return { success: false, hash: tile.hash, reason: 'push_failed' };
        }
      } catch (error) {
          const errorMsg = error?.message || String(error);
          // session closed vs other errors
          if (errorMsg.includes('Session') || errorMsg.includes('closed') || errorMsg.includes('Connection lost')) {
            return { success: false, hash: tile.hash, reason: 'session_closed' };
          }
          return { success: false, hash: tile.hash, reason: 'error', error: errorMsg };
        }
      });
    
      // Await batch (QUIC flow control)
      const results = await Promise.allSettled(pushPromises);
      const batchPushed = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
      const batchSkipped = results.length - batchPushed;
      const batchElapsed = Date.now() - batchStartTime;

      totalPushed += batchPushed;
      totalSkipped += batchSkipped;

      // Batch timing log
      if (batchPushed > 0) {
        const avgTimePerTile = batchElapsed / batchPushed;
        console.log(`📤 Batch ${batchNum}/${totalBatches}: ${batchPushed} pushed, ${batchSkipped} skipped (${totalPushed}/${tilesToPush.length} total) | ${batchElapsed}ms (${avgTimePerTile.toFixed(1)}ms/tile)`);
      }
      
      // Sample error histogram if first batch fully fails
      if (batchPushed === 0 && batch.length > 0 && batchNum === 1 && Math.random() < 0.1) {
        const reasons = {};
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value) {
            const reason = r.value.reason || 'unknown';
            reasons[reason] = (reasons[reason] || 0) + 1;
          } else if (r.status === 'rejected') {
            reasons['promise_rejected'] = (reasons['promise_rejected'] || 0) + 1;
          }
        });
        console.warn(`⚠️ First batch failed (sample):`, reasons);
      }
      
      // Inter-batch delay to avoid exhausting stream slots
      if (batchNum < totalBatches) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    // Final push summary
    const totalElapsed = Date.now() - pushStartTime;
    if (totalPushed === 0) {
      console.warn(`⚠️ Tile push completed with zero success: pushed=${totalPushed}, skipped=${totalSkipped} (total ${tilesToPush.length} tiles) | ${totalElapsed}ms`);
    } else {
      const avgTimePerTile = totalElapsed / totalPushed;
      const tilesPerSecond = (totalPushed / (totalElapsed / 1000)).toFixed(1);
      console.log(`✅ Tile push completed: ${totalPushed} pushed, ${totalSkipped} skipped (total ${tilesToPush.length} tiles) | ${totalElapsed}ms (${avgTimePerTile.toFixed(1)}ms/tile, ${tilesPerSecond} tiles/s)`);
    }
  } catch (error) {
    console.error('❌ Error processing camera data:', error);
  }
}

// HTTP/1.1 pushed a full list; WebTransport waits for client-driven visibility
async function pushInitialTiles(session) {
  console.log('[pushInitialTiles] skip server-side full push; wait for client camera');
}

// pushSingleTile with bounded retries
async function pushSingleTile(session, tile, retryCount = 0) {
  const maxAllowedLod = fixedTileTargetLodMap.get(tile.hash);
  if (fixedTileTargetLodMap.size > 0 && (maxAllowedLod == null || tile.lod < 1 || tile.lod > maxAllowedLod)) {
    return false;
  }
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 50;
  
  const tileData = await readTileFile(tile.hash, tile.lod);
  if (!tileData) {
    // Missing file: no retry
    if (retryCount === 0) {
    console.error(`❌ Failed to read tile ${tile.hash} L${tile.lod}`);
    }
    return false;
  }

  let streamOpened = false;

  try {
    // Skip if session already closed
    try {
      const isClosed = await Promise.race([
        Promise.resolve(session.closed),
        new Promise(resolve => setTimeout(() => resolve(false), 1))
      ]);
      if (isClosed) {
        return false;
      }
    } catch (e) {
      // ignore .closed probe errors
    }

    // VPAP: lower sendOrder => higher priority; higher vpap => lower sendOrder within same LOD
    const vpap = tile.vpapScore ?? 0.5;
    const sendOrder = BigInt(tile.lod * 10000 + Math.floor((1 - vpap) * 1000));
    const tileStream = await session.createUnidirectionalStream({
      sendOrder: sendOrder,
      sendGroup: null
    });
    
    // Validate stream
    if (!tileStream) {
      console.error(`❌ createUnidirectionalStream returned undefined for ${tile.hash} L${tile.lod}`);
      return false;
    }
    
    streamMetrics.streamOpened();
    streamOpened = true;
    
    const writer = tileStream.getWriter();
    const metadata = { hash: tile.hash, lod: tile.lod, weight: tile.weight, size: tileData.length };
    
    // Protocol: JSON + \n + Binary
    const header = JSON.stringify(metadata) + '\n';
    await writer.write(new TextEncoder().encode(header));
    await writer.write(tileData);
    streamMetrics.addPayloadBytes(tileData.length);
    await writer.close();
    
    // Some stacks omit stream.closed; still count close
    if (tileStream.closed && typeof tileStream.closed.then === 'function') {
      tileStream.closed.then(() => {
        streamMetrics.streamClosed();
      }).catch(() => {
        streamMetrics.streamClosed();
      });
    } else {
      streamMetrics.streamClosed();
    }
    
    return true;
  } catch (e) {
    // Keep stream open/close metrics paired
    if (streamOpened) {
      streamMetrics.streamClosed();
    }
    
    const errorMsg = e?.message || String(e);
    if (errorMsg.includes('Session') || errorMsg.includes('closed') || errorMsg.includes('Connection lost')) {
      return false;
    }
    if (errorMsg.includes('No streams available') && retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
      return pushSingleTile(session, tile, retryCount + 1);
    }
    if (retryCount === 0) {
      // Throttle error logs (~10% sample)
      if (Math.random() < 0.1) {
        console.error(`❌ pushSingleTile failed for ${tile.hash} L${tile.lod}:`, errorMsg);
      }
    }
    return false;
  }
}

// Async disk read (.splat); relies on OS page cache
async function readTileFile(tileHash, lod) {
  const filePath = path.join(TILES_BASE_PATH, `L${lod}`, `${tileHash}-L${lod}.splat`);
  try {
    return await fs.promises.readFile(filePath);
  } catch (e) {
    return null;
  }
}

// WebTransport / HTTP3 server
const wt = new Http3Server({
  port: PORT,
  host: '0.0.0.0',
  cert: fs.readFileSync(CERT_PATH, 'utf8'),
  privKey: fs.readFileSync(KEY_PATH, 'utf8'),
  secret: 'webtransport-tile-server-secret',
  path: '/wt'
});

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error('TLS certificate or key missing');
  console.error(`   cert: ${CERT_PATH}`);
  console.error(`   key: ${KEY_PATH}`);
  console.error('Use mkcert or set VPAP_TLS_* / VPAP_CERT_DIR');
  process.exit(1);
}

loadTilesMapping();

const streamMetrics = new StreamMetrics('baseline4', {
  run_id: `run_${Date.now()}`,
  scenario_id: 'gs-campus',
  cache_state: 'cold',
  camera_trace_id: 'default'
});

try {
  wt.startServer();
  console.log(`🚀 WebTransport Tile Server running on port ${PORT}`);
  console.log(`📁 Tiles path: ${TILES_BASE_PATH}`);
  console.log(`📜 Certificate: ${CERT_PATH}`);
  console.log('✅ Server started, waiting for connections...');
} catch (error) {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
}

// Export stream metrics every 60s
setInterval(async () => {
  try {
    const filename = streamMetrics.generateFilename('latest');
    await streamMetrics.writeToFile(path.join(__dirname, filename));
  } catch (e) {
    console.error('❌ Failed to export stream metrics:', e);
  }
}, 60000);

// Export metrics on SIGINT
process.on('SIGINT', async () => {
  console.log('\n📊 Exporting final stream metrics...');
  try {
    const filename = streamMetrics.generateFilename('final');
    await streamMetrics.writeToFile(path.join(__dirname, filename));
    console.log('✅ Stream metrics exported');
  } catch (e) {
    console.error('❌ Failed to export stream metrics:', e);
  }
  process.exit(0);
});

// Accept WebTransport sessions
(async () => {
  try {
    console.log('📡 Waiting for WebTransport sessions on /wt...');
    const sessionStream = await wt.sessionStream('/wt');
    const sessionReader = sessionStream.getReader();
    
    while (true) {
      const { done, value: session } = await sessionReader.read();
      if (done) {
        console.log('🔴 Server session stream closed');
        break;
      }
      
      console.log('✅ New WebTransport session');
      
      sessionLatestRequestId.set(session, 0);
      sessionTileLodSetMap.set(session, new Map()); // Map<tileHash, Set<lod>>

      await session.ready;
      console.log('✅ Session ready');
      console.log('📡 [Server] session:', typeof session, session.constructor?.name);
      console.log('📡 [Server] incomingBidirectionalStreams:', 'incomingBidirectionalStreams' in session);

      pushInitialTiles(session).catch(e => console.error('❌ Initial tiles push error:', e));

      session.closed.then(() => {
        console.log('🔴 WebTransport session closed');
      }).catch(error => {
        console.error('❌ Session close error:', error);
      });
      
      console.log('📡 [Server] waiting for bidi streams (camera)...');
      console.log('📡 [Server] time:', new Date().toISOString());
      (async () => {
        try {
          console.log('📡 [Server] bidi stream loop start');
          console.log('📡 [Server] session:', session);
          console.log('📡 [Server] session.incomingBidirectionalStreams:', session.incomingBidirectionalStreams);
          
          if (!session.incomingBidirectionalStreams) {
            console.error('❌ [Server] session.incomingBidirectionalStreams is null/undefined!');
            console.error('❌ [Server] session keys:', Object.keys(session));
            return;
          }
          
          const streams = session.incomingBidirectionalStreams;
          console.log('📡 [Server] streams:', streams);
          const reader = streams.getReader();
          
          console.log('📡 [Server] bidi reader ready');
          
          while (true) {
            try {
              const { value: stream, done } = await reader.read();
              
              if (done) {
                console.log('📡 [Server] bidi reader done');
                break;
              }
              
              if (!stream) {
                console.warn('⚠️ [Server] null stream');
                continue;
              }
              
              console.log('✅ [Server] new bidi stream');

              (async () => {
                try {
                  const streamReader = stream.readable.getReader();
                  const decoder = new TextDecoder();
                  let buffer = '';
                  
                  while (true) {
                    const { value: chunk, done: streamDone } = await streamReader.read();
                    
                    if (streamDone) {
                      if (buffer.trim()) {
                        try {
                          const cameraData = JSON.parse(buffer.trim());
                          console.log(`📥 [Server] camera JSON at stream end (requestId: ${cameraData.id})`);
                          sessionLatestRequestId.set(session, cameraData.id);
                          scheduleProcessCameraData(cameraData, session);
                        } catch (error) {
                          console.error('❌ Failed to parse final camera data:', error);
                        }
                      }
                      break;
                    }
                    
                    if (!chunk) {
                      console.warn('⚠️ [Server] null chunk');
                      continue;
                    }
                    
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                      if (line.trim()) {
                        try {
                          const cameraData = JSON.parse(line);
                          console.log(`📥 [Server] camera JSON (requestId: ${cameraData.id})`);
                          sessionLatestRequestId.set(session, cameraData.id);
                          scheduleProcessCameraData(cameraData, session);
                        } catch (error) {
                          console.error('❌ JSON parse error:', error, 'Line:', line.substring(0, 100));
                        }
                      }
                    }
                  }
                } catch (error) {
                  console.error('❌ Stream reading error:', error);
                }
              })().catch(error => {
                console.error('❌ Stream handler error:', error);
              });
            } catch (error) {
              console.error('❌ Reader.read() error:', error);
              break;
            }
          }
        } catch (error) {
          console.error('❌ Stream processing error:', error);
        }
      })();
    }
  } catch (error) {
    console.error('❌ Session stream error:', error);
  }
})();

