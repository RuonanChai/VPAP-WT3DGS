/**
 * WebTransport Tile Server (Fixed & Optimized)
 * 
 * 功能：
 * - 接收客户端相机位置数据
 * - 计算可见 tile（基于距离）
 * - 通过 QUIC stream 主动推送 tile
 * - 支持动态 LOD 调度
 * 
 * 关键修正：
 * 1. 坐标系对齐：处理客户端 100x 缩放导致的距离计算错误
 * 2. 性能优化：WebTransport 丢弃旧帧逻辑，防止应用层队头阻塞
 * 3. 简化 JSON 解析：使用换行符分隔，避免手动计数括号
 * 
 * 注意：需要 Node.js 20+
 * 启动命令：node server_vpap.js
 */

import { Http3Server } from '@fails-components/webtransport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StreamMetrics } from './StreamMetrics.js';
import { getFixedSelectionFromList, selectTiles } from './tileSelection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const PORT = Number(process.env.VPAP_PORT || 8444);
const SCALING_FACTOR = 100.0; // 客户端缩放因子

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

// Tile 映射数据（从 custom_bounding_boxes_mapping-campus2.json 加载）
let tilesMapping = null;
// 初始加载列表（从 initial_selection.json 加载）
let initialLoadList = null;
// 🔥 B4 固定 selection：用于 processCameraData，不按相机动态选 tile
let fixedSelectionTiles = [];
const fixedTileTargetLodMap = new Map();

// Tile 从物理盘按需读取（依赖 OS Page Cache），不再预加载内存

// 加载 tile 映射和初始列表
function loadTilesMapping() {
  try {
    // 优先使用 baseline4 自己的文件，然后是 baseline3，最后是本地
    const mappingPath = fs.existsSync(MAPPING_PATH_BASELINE4) ? MAPPING_PATH_BASELINE4 : MAPPING_PATH_LOCAL;
    const data = fs.readFileSync(mappingPath, 'utf8');
    tilesMapping = JSON.parse(data);
    console.log(`✅ Loaded ${Object.keys(tilesMapping).length} tiles mapping`);
    
    // 优先使用统一 reference_manifest，确保四组工作量一致
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
      // 兜底：沿用旧 initial_selection
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

// 🔥 矩阵乘法：4x4 矩阵 × 4x1 向量
function multiplyMatrixVector(matrix, vector) {
  const [x, y, z, w] = vector;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w
  ];
}

// 🔥 VPAP：从 tile hash 解析瓦片中心坐标（与 tileSelection.js 一致）
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

// 🔥 VPAP：视点与渲染感知调度打分
// P(i) = 0.7 * score_view + 0.3 * score_dist
function computeVPAPScore(cameraPos, cameraForward, tilePos) {
  if (!cameraPos || !cameraForward || !tilePos) return 0.5; // fallback
  const cx = cameraPos[0] ?? 0, cy = cameraPos[1] ?? 0, cz = cameraPos[2] ?? 0;
  const fx = cameraForward[0] ?? 0, fy = cameraForward[1] ?? 0, fz = cameraForward[2] ?? 0;
  const tx = tilePos.x, ty = tilePos.y, tz = tilePos.z;
  const dx = tx - cx, dy = ty - cy, dz = tz - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-6) return 1; // 重合
  const vecToTileLen = dist;
  const vx = dx / vecToTileLen, vy = dy / vecToTileLen, vz = dz / vecToTileLen;
  const dot = fx * vx + fy * vy + fz * vz;
  const scoreView = dot < 0.5 ? 0 : dot;
  const scoreDist = 1 / (1 + dist / 2000);
  return 0.7 * scoreView + 0.3 * scoreDist;
}

// （可选）视锥检测；若关闭则直接返回 true
function isTileInView(mvpMatrix, worldPos, enable = true) {
  if (!enable) return true;
  if (!Array.isArray(mvpMatrix) || mvpMatrix.length !== 16) return true;
  const [cx, cy, cz, cw] = multiplyMatrixVector(mvpMatrix, [worldPos.x, worldPos.y, worldPos.z, 1]);
  // cw <= 0 通常在相机背面，直接剔除
  if (cw <= 0) return false;
  const nx = cx / cw;
  const ny = cy / cw;
  const nz = cz / cw;
    // 🔥 放宽视锥过滤边界，确保屏幕中心的 tile 不被过滤
    // 问题：margin = 0.6 太严格，导致视锥过滤失败，fallback 时选择的 tile 不在屏幕中心
    // 解决：放宽 margin 到 1.2（与客户端 CameraFrameUpscale = 1.2 一致），确保屏幕中心的 tile 通过过滤
    const margin = 1.2; // 从 0.6 放宽到 1.2，与客户端 CameraFrameUpscale = 1.2 一致
    // 仅保留视锥内且在相机前方的 tile
    // 🔥 关键：nz > 0.1 确保 tile 在相机前方（不是紧贴相机背面）
    // 注意：nz 阈值从 0.2 降到 0.1，因为 margin 已经放宽，可以更宽松地检查深度
    return nx > -margin && nx < margin && ny > -margin && ny < margin && nz > 0.1 && nz < 1.1;
}

// 🔥 根据距离计算可见 tile（完全复制客户端静态模式的逻辑，不使用视锥剔除）
function computeVisibleTiles(cameraData) {
  const { cameraPos } = cameraData;
  const mvpMatrix = cameraData.mvp;
  const frustumEnabled = Array.isArray(mvpMatrix) && mvpMatrix.length === 16;
  // 🔥 移除固定聚焦区域，改为基于相机位置的动态范围（让鼠标滑动时能加载新 tile）
  // const FOCUS_CENTER = { x: -28158.88, y: 0, z: -20181.29 };
  // const FOCUS_RADIUS = 1000;
  
  // 从 tilesMapping 获取所有 tile（与客户端一致）
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
  
  // 🔥 使用客户端发送的相机位置（客户端已转换为局部坐标，无需除以缩放因子）
  const camPos = cameraPos || [0, 0, 0];
  const cameraWorldPos = {
    x: camPos[0] || 0,
    y: camPos[1] || 0,
    z: camPos[2] || 0
  };
  
  const tileListWithWeight = [];
  
  // 🔥 完全复制客户端的距离逻辑，附加视锥过滤
  for (let i = 0; i < tileList.length; i++) {
    const tileHash = tileList[i];
    const m = tileHash.match(/tile_\d+_(\d+)_(\d+)/);
    if (!m) continue;
    
    const gx = parseInt(m[1]);
    const gz = parseInt(m[2]);
    
    const wx = (gx - originGridX) * tileSize;
    const wz = (gz - originGridZ) * tileSize;
    const wy = 0;
    
    // 🔥 与 HTTP/1.1 版本完全一致：不使用视锥过滤，只按距离排序
    // HTTP/1.1 版本的成功经验：不使用视锥过滤，只按距离排序，简单、可靠、正确
    // 问题：视锥过滤和 isInFront 检查导致很多屏幕中央的 tile 被过滤掉
    // 解决：移除视锥过滤和 isInFront 检查，只按距离排序（与 HTTP/1.1 版本完全一致）
    
    // 计算距离（与客户端 Vector3.distanceTo 一致）
    const dx = cameraWorldPos.x - wx;
    const dy = cameraWorldPos.y - wy;
    const dz = cameraWorldPos.z - wz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // 🔥 与 HTTP/1.1 版本完全一致：直接添加所有 tile，不检查视锥和相机前方
    // HTTP/1.1 版本不使用视锥过滤，只按距离排序，距离近的 tile 通常在屏幕中心
    tileListWithWeight.push({ 
      hash: tileHash, 
      distance: dist
    });
  }
  
  // 🔥 与 HTTP/1.1 版本完全一致：不使用视锥过滤，不需要 fallback
  // HTTP/1.1 版本不使用视锥过滤，所以不会出现 "Frustum culled to zero" 的情况
  // 如果 tileListWithWeight 为空，说明没有 tile，直接返回
  if (tileListWithWeight.length === 0) {
    console.warn('⚠️ No tiles found (tileListWithWeight is empty)');
    return [];
  }

  // 🔥 与 HTTP/1.1 版本完全一致：只按距离排序（近的优先）
  // 问题：深度值排序可能导致相机背后的 tile 被优先选择（深度值计算可能错误）
  // 解决：移除深度值排序，只按距离排序，与 HTTP/1.1 版本一致
  // HTTP/1.1 版本的成功经验：简单就是美，只按距离排序，不需要复杂的深度值计算
  tileListWithWeight.sort((a, b) => a.distance - b.distance);
  
  // 🔥 优化：减少初始 tile 数量，只推送最重要的 tile（与 HTTP/1.1 版本一致）
  // HTTP/1.1 版本使用预选的 60 个 tile，WebTransport 版本也使用 60 个 tile
  // 这样可以将总 LOD chunks 从 1200 降到 240（60 tile × 4 LOD），与 HTTP/1.1 版本完全一致
  // 🔥 关键：只选择相机前方的 tile（已通过视锥过滤或 fallback 时的相机前方检查）
  const MAX_VISIBLE = 300; // 与 experiment INITIAL_TILE_CAP 一致，初始加载 300 tile
  
  // 🔥 调试：在限制数量之前，输出前 10 个 tile 的详细信息
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
  
  // 🔥 调试：在限制数量之后，输出最终选中的 tile 信息
  if (tileListWithWeight.length > 0) {
    console.log(`🔍 [After MAX_VISIBLE=${MAX_VISIBLE}] Selected ${tileListWithWeight.length} tiles`);
  }
  
  // 🔥 与 HTTP/1.1 版本一致：使用基于距离的固定阈值分配权重（不使用动态分桶）
  // 🔥 优化：放宽权重阈值，让更多 tile 获得更高的 LOD，确保画面清晰
  // 原阈值太严格（dist < 150 才能 L4），导致距离稍远的 tile 只能获得 L1，画面模糊
  tileListWithWeight.forEach((t) => {
    // 🔥 计算权重（放宽阈值，让更多 tile 获得 L4）
    let weight = 500;
    if (t.distance < 500) weight = 20000;      // L4（从 150 放宽到 500，提升 3.3 倍）
    else if (t.distance < 1000) weight = 17000; // L3（从 400 放宽到 1000，提升 2.5 倍）
    else if (t.distance < 2000) weight = 9000;   // L2（从 900 放宽到 2000，提升 2.2 倍）
    else if (t.distance < 4000) weight = 3000;  // L1（从 2000 放宽到 4000，提升 2 倍）
    t.weight = weight;
  });
  
  // 🔥 调试：输出距离和权重分布（在权重计算之后）
  if (tileListWithWeight.length > 0) {
    const minDist = tileListWithWeight[0].distance;
    const maxDist = tileListWithWeight[tileListWithWeight.length - 1].distance;
    const weightCounts = { 500: 0, 3000: 0, 9000: 0, 17000: 0, 20000: 0 };
    tileListWithWeight.forEach(t => {
      weightCounts[t.weight] = (weightCounts[t.weight] || 0) + 1;
    });
    console.log(`📏 Distance range: min=${minDist.toFixed(2)}, max=${maxDist.toFixed(2)}`);
    console.log(`⚖️ Weight distribution: 500=${weightCounts[500]}, 3000=${weightCounts[3000]}, 9000=${weightCounts[9000]}, 17000=${weightCounts[17000]}, 20000=${weightCounts[20000]}`);
    
    // 输出前5个最近的tile
    const nearest5 = tileListWithWeight.slice(0, 5);
    console.log(`🎯 Nearest 5 tiles:`, nearest5.map(t => 
      `hash=${t.hash}, dist=${t.distance.toFixed(2)}, weight=${t.weight}, LOD=${getLodFromWeight(t.weight)}`
    ));
  }
  
  // 🔥 转换为服务器需要的格式，并计算 LOD
  const visibleTiles = tileListWithWeight.map(t => {
    // 根据权重确定 LOD（与客户端 getLodFromWeight 一致）
    const lod = getLodFromWeight(t.weight);
    
    return {
      hash: t.hash,
      lod: lod,
      weight: t.weight,
      distance: t.distance
    };
  });
  
  // 🔥 返回所有 tile（与客户端一致，客户端会自己控制加载数量）
  return visibleTiles;
}

// 🔥 LOD 计算函数（与客户端 getLodFromWeight 完全一致）
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

// 🔥 降级方案：仅基于距离的剔除（当 MVP 矩阵无效时使用）
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
  
  // 🔥 使用客户端发送的相机位置（客户端已转换为局部坐标，无需除以缩放因子）
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
    
    // 🔥 计算权重（调整阈值，让高清判定更宽容）
    let weight = 500;
    if (dist < 150) weight = 20000;      // 原 100 -> 150 (更容易LOD4)
    else if (dist < 400) weight = 17000; // L3
    else if (dist < 900) weight = 9000;  // L2
    else if (dist < 2000) weight = 3000; // L1
    
    tileListWithWeight.push({ hash: tileHash, weight, distance: dist });
  }
  
  // 按距离排序（近的优先）
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

// 🔥 使用 WeakMap 跟踪每个 session 的最新 requestId（用于丢弃旧帧）
const sessionLatestRequestId = new WeakMap();
// 🔥 方案 2A：per-session 序列化，防止并发 processCameraData 导致 L2/L3/L4 在 L1 之前发送
const sessionProcessCameraPromise = new WeakMap();
// 🔥 记录每个 session 已经推送过的 LOD 集合（支持渐进式加载：L1+L2+L3+L4）
// 格式：Map<tileHash, Set<lod>>，例如 { "tile_xxx": Set([1, 2, 3, 4]) }
const sessionTileLodSetMap = new WeakMap();
// 🔥 记录上次相机位置，用于检测视角变化
const sessionLastCameraPos = new WeakMap();
// 🔥 记录上次计算的tile hash集合，用于检测tile集合变化
const sessionLastTileHashes = new WeakMap();

// 🔥 方案 2A：序列化 processCameraData，确保 L1 全发完再发 L2/L3/L4（防止并发导致顺序错乱）
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

// 处理相机数据并推送 tile
async function processCameraData(cameraData, session) {
  const myId = cameraData.id;
  
  // 🔥 性能优化：更早地中止过时的帧，避免重复计算
  // 🔥 降低敏感度：允许落后 2 帧以内继续处理（避免鼠标滑动时全部被中止）
  const latestId = sessionLatestRequestId.get(session) || 0;
  // 公平性约束：Baseline 对比必须避免应用层丢帧/截断
  // -> 不做 "latestId > myId + x" 的 frame discard
  try {
    console.log(`📥 [processCameraData] 收到相机数据 (requestId: ${cameraData.id})`);
    if (cameraData.cameraPos) {
      console.log(`📍 [processCameraData] 相机位置: [${cameraData.cameraPos[0]?.toFixed(2)}, ${cameraData.cameraPos[1]?.toFixed(2)}, ${cameraData.cameraPos[2]?.toFixed(2)}]`);
    }
    
    // 公平性锁定：B4 使用与 B1/B2/B3 相同的固定对象集合，仅改变发送顺序（VPAP）
    let visibleTiles = fixedSelectionTiles.length ? fixedSelectionTiles : selectTiles(cameraData, tilesMapping);
    console.log(`🎯 [processCameraData] selected: ${visibleTiles.length} tiles`);
    
    // 统计 LOD 分布
    const lodCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    visibleTiles.forEach(t => lodCounts[t.lod] = (lodCounts[t.lod] || 0) + 1);
    console.log(`📊 [processCameraData] LOD分布: L1=${lodCounts[1]}, L2=${lodCounts[2]}, L3=${lodCounts[3]}, L4=${lodCounts[4]}`);
    
    // 🔥 调试：输出前10个tile的详细信息
    if (visibleTiles.length > 0) {
      console.log(`🔍 First 10 tiles:`, visibleTiles.slice(0, 10).map(t => 
        `${t.hash} L${t.lod} (weight=${t.weight}, dist=${t.distance.toFixed(2)})`
      ));
    }
    
    // 🔥 按优先级排序：高 LOD（高精度）优先推送
    // L4 > L3 > L2 > L1，同 LOD 按距离排序
    const sortedTiles = [...visibleTiles].sort((a, b) => {
      if (a.lod !== b.lod) {
        return b.lod - a.lod; // 高 LOD 优先
      }
      return a.distance - b.distance; // 同 LOD 按距离
    });
    
    // 🔥 检测相机位置变化，如果移动超过阈值，允许重新推送（清除部分缓存）
    const lastCameraPos = sessionLastCameraPos.get(session);
    const currentCameraPos = cameraData.cameraPos ? 
      `${cameraData.cameraPos[0]?.toFixed(1)},${cameraData.cameraPos[1]?.toFixed(1)},${cameraData.cameraPos[2]?.toFixed(1)}` : null;
    const CAMERA_MOVE_THRESHOLD = 10.0; // 🔥 降低阈值到 10，让鼠标滑动时更容易触发
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
    
    // 🔥 渐进式加载：每个tile需要推送L1+L2+L3+L4（从1到目标LOD）
    // 格式：Map<tileHash, Set<lod>>，记录已推送的LOD集合
    const tileLodSetMap = sessionTileLodSetMap.get(session) || new Map();
    sessionTileLodSetMap.set(session, tileLodSetMap);
    const requiredTiles = []; // 格式：{ hash, lod, weight, distance, prevLodSet }
    
    // 🔥 统计：检查是否有新的 tile hash
    const newTileHashes = new Set();
    for (const t of sortedTiles) {
      if (!tileLodSetMap.has(t.hash)) {
        newTileHashes.add(t.hash);
      }
    }
    
    // 🔥 检测是否为初始加载（已推送的tile数量很少）
    const totalPushedTiles = Array.from(tileLodSetMap.values()).reduce((sum, lodSet) => sum + lodSet.size, 0);
    const isInitialLoad = totalPushedTiles < 100; // 如果已推送的LOD总数少于100，认为是初始加载
    
    // 🔥 为每个tile生成需要推送的LOD列表（渐进式加载）
    let newTileCount = 0;
    let newTileWithNeededLods = 0;
    for (const t of sortedTiles) {
      const prevLodSet = tileLodSetMap.get(t.hash) || new Set();
      const targetLod = t.lod; // 目标LOD（例如：4表示需要L1+L2+L3+L4）
      const isNewTile = prevLodSet.size === 0; // 新tile（从未推送过任何LOD）
      
      if (isNewTile) {
        newTileCount++;
      }
      
      // 🔥 初始加载策略（VPAP 论文口径）：屏幕内的 tile 优先推送高 LOD
      // 公平性约束：初始阶段必须严格遵守 `1..targetLod`
      if (isInitialLoad) {
        const targetLod = t.lod; // 目标 LOD（例如：4表示需要 L1+L2+L3+L4；2表示仅需要 L1+L2）
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
        // 🔥 后续加载：根据距离推送对应 LOD（远→L1，近→L4），不重复推送
        // 策略：
        // - 距离远（targetLod = 1）：只推送 L1（如果还没推送过）
        // - 距离近（targetLod = 2/3/4）：推送从 L1 到 targetLod 的所有缺失 LOD
        //   注意：L4 需要 L1+L2+L3+L4 才能清晰，所以如果基础层缺失，需要先推送基础层
        
        if (targetLod > 0) {
          // 收集所有缺失的 LOD（优先高 LOD：targetLod→L1）
          const missingLods = [];
          for (let lod = 1; lod <= targetLod; lod++) {
            if (!prevLodSet.has(lod)) {
              missingLods.push(lod);
            }
          }
          
          // 只推送缺失的 LOD，不重复推送
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
    
    // 🔥 调试：检查新tile的处理情况
    if (newTileCount > 0) {
      console.log(`🆕 Found ${newTileCount} new tiles (never pushed before), ${newTileWithNeededLods} have needed LODs`);
      if (newTileCount > newTileWithNeededLods) {
        console.warn(`   ⚠️ ${newTileCount - newTileWithNeededLods} new tiles have no needed LODs (targetLod might be 0 or invalid)`);
      }
    }
    const dedupSkip = sortedTiles.length - (new Set(requiredTiles.map(t => t.hash)).size);
    
    // 🔥 调试：检查本次计算的tile hash集合是否与上次不同
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
          // 🔥 调试：检查新tile是否被正确添加到requiredTiles
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
    // 保存本次tile hash集合
    sessionLastTileHashes.set(session, currentTileHashes);
    
    // 🔥 方案 2A：两级保底 (survival-first, view-aware-second)
    // Level 1：全体 L1 必须先于任何 L2/L3/L4 → priority(L1) > priority(L2) > priority(L3) > priority(L4)
    // Level 2：在 L1 内部再按 VPAP 排序（最关键 L1 最先发）
    // 顺序：先发所有 L1（VPAP 高者优先）→ L1 发完再进入 L2 → L2 发完再 L3 → L3 发完再 L4
    requiredTiles.sort((a, b) => {
      if (a.lod !== b.lod) return a.lod - b.lod; // L1 先于 L2 先于 L3 先于 L4
      if (a.vpapScore != null && b.vpapScore != null) {
        return b.vpapScore - a.vpapScore; // 同 LOD 内：高 VPAP 优先
      }
      return a.distance - b.distance;
    });
    
    const tilesToPush = requiredTiles;
    
    // 🔥 优化并发设置：根据性能数据优化
    // 性能分析：每个tile耗时约15ms（文件读取5-10ms + 网络传输5-10ms）
    // 客户端处理速度：GSLoaderCount=16，每个tile处理时间未知
    // 优化策略：增加批次大小，减少批次延迟，提高吞吐量
    // 初始加载：批次大小30（快速推送L1），延迟5ms（最小延迟）
    // 后续加载：批次大小25（推送多LOD），延迟10ms（减少延迟）
    // 🔥 批次大小限制：WebTransport 有流资源限制，不能设置太大
    // 如果批次太大（如500+），会导致：
    // 1. 一次性创建太多流，触发 "No streams available" 错误
    // 2. 连接被关闭（"Connection lost"）
    // 3. 客户端无法接收数据
    // 🔥 性能优化：初始加载时，L1 文件小，可以更激进
    // 批次大小：初始加载40（提升33%），后续25（稳定）
    // 批次延迟：初始加载2ms（减少60%），后续10ms（稳定）
    const CONCURRENT_BATCH_SIZE = isInitialLoad ? 120 : 100; //初始加载40并发，后续25并发
    const BATCH_DELAY_MS = isInitialLoad ? 2 : 10; // 初始加载2ms延迟，后续10ms延迟
    
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
      // 🔥 调试：输出前 5 个被跳过的 tile hash
      const skippedHashes = sortedTiles.filter(t => {
        const prevLodSet = tileLodSetMap.get(t.hash) || new Set();
        // 检查是否所有需要的LOD都已推送（从1到targetLod）
        for (let lod = 1; lod <= t.lod; lod++) {
          if (!prevLodSet.has(lod)) {
            return false; // 还有缺失的LOD
          }
        }
        return true; // 所有LOD都已推送
      }).slice(0, 5).map(t => t.hash);
      if (skippedHashes.length > 0) {
        console.log(`   Skipped tile samples: ${skippedHashes.join(', ')}`);
      }
    }
    if (requiredTiles.length > 0) {
      // 🔥 按tile分组显示，显示每个tile需要推送的LOD
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
    const pushStartTime = Date.now(); // 🔥 性能监控：记录开始时间
    
    // 🔥 性能优化：预加载所有文件到缓存（初始加载时）
    // 这样可以避免批次处理时的文件 I/O 等待，大幅提升性能
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
    
    // 🔥 分批并发推送（每批 CONCURRENT_BATCH_SIZE 个）
    for (let batchStart = 0; batchStart < tilesToPush.length; batchStart += CONCURRENT_BATCH_SIZE) {
      const batch = tilesToPush.slice(batchStart, batchStart + CONCURRENT_BATCH_SIZE);
      const batchNum = Math.floor(batchStart / CONCURRENT_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(tilesToPush.length / CONCURRENT_BATCH_SIZE);
      const batchStartTime = Date.now(); // 🔥 性能监控：记录批次开始时间
      
      // 公平性约束：Baseline 对比必须避免应用层批次中止
      // -> 不做 "latestIdBeforeBatch > myId + x" 的 batch abort
      
      // 🔥 并发推送当前批次的所有 tile（移除单个 tile 的中止检查，减少开销）
      const pushPromises = batch.map(async (tile) => {
        try {
          // 🔥 移除单个 tile 的过时检查，只在批次级别检查
          // 移除频繁的 session.closed 检查，pushSingleTile 内部会处理错误
          
          const ok = await pushSingleTile(session, { ...tile });
          if (ok) {
            // 🔥 更新已推送的LOD集合（渐进式加载）
            const lodSet = tileLodSetMap.get(tile.hash) || new Set();
            lodSet.add(tile.lod);
            tileLodSetMap.set(tile.hash, lodSet);
            return { success: true, hash: tile.hash, lod: tile.lod };
          } else {
            return { success: false, hash: tile.hash, reason: 'push_failed' };
        }
      } catch (error) {
          const errorMsg = error?.message || String(error);
          // 🔥 区分 session 关闭和其他错误
          if (errorMsg.includes('Session') || errorMsg.includes('closed') || errorMsg.includes('Connection lost')) {
            return { success: false, hash: tile.hash, reason: 'session_closed' };
          }
          return { success: false, hash: tile.hash, reason: 'error', error: errorMsg };
        }
      });
    
      // 🔥 等待当前批次并发推送完成（QUIC 会自动处理流控和拥塞）
      const results = await Promise.allSettled(pushPromises);
      const batchPushed = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
      const batchSkipped = results.length - batchPushed;
      const batchElapsed = Date.now() - batchStartTime; // 🔥 性能监控：批次耗时
      
      totalPushed += batchPushed;
      totalSkipped += batchSkipped;
      
      // 🔥 批次进度日志（包含性能信息）
      if (batchPushed > 0) {
        const avgTimePerTile = batchElapsed / batchPushed;
        console.log(`📤 Batch ${batchNum}/${totalBatches}: ${batchPushed} pushed, ${batchSkipped} skipped (${totalPushed}/${tilesToPush.length} total) | ${batchElapsed}ms (${avgTimePerTile.toFixed(1)}ms/tile)`);
      }
      
      // 🔥 如果当前批次全部失败，输出详细错误（仅第一批，且限制频率）
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
      
      // 公平性约束：Baseline 对比必须避免应用层批次中止
      
      // 🔥 批次间延迟，让流资源有时间释放（避免 "No streams available"）
      if (batchNum < totalBatches) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    // 🔥 最终统计（包含性能信息）
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

// 🔥 [新增] 推送初始高清列表 - HTTP1.1版本逻辑：强制推送LOD4
async function pushInitialTiles(session) {
  // HTTP1.1 初始列表会推全部 tile，WebTransport 改为跳过，避免加载全图。
  console.log('[pushInitialTiles] ⏭️ 跳过初始全量推送，等待客户端首帧视角计算可见集合');
}

// 🔥 [新增] 封装单次推送逻辑（带重试机制）
async function pushSingleTile(session, tile, retryCount = 0) {
  const maxAllowedLod = fixedTileTargetLodMap.get(tile.hash);
  if (fixedTileTargetLodMap.size > 0 && (maxAllowedLod == null || tile.lod < 1 || tile.lod > maxAllowedLod)) {
    return false;
  }
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 50;
  
  const tileData = await readTileFile(tile.hash, tile.lod);
  if (!tileData) {
    // 文件读取失败不重试
    if (retryCount === 0) {
    console.error(`❌ Failed to read tile ${tile.hash} L${tile.lod}`);
    }
    return false;
  }

  let streamOpened = false; // 🔥 跟踪是否已记录 stream opened
  
  try {
    // 🔥 快速检查 session 状态（避免在已关闭的 session 上创建 stream）
    try {
      const isClosed = await Promise.race([
        Promise.resolve(session.closed),
        new Promise(resolve => setTimeout(() => resolve(false), 1))
      ]);
      if (isClosed) {
        return false; // Session 已关闭，不重试
      }
    } catch (e) {
      // session.closed 检查失败，继续尝试
    }
    
    // 🔥 B4 VPAP：sendOrder 越低优先级越高；同 LOD 内高 VPAP 得低 sendOrder
    const vpap = tile.vpapScore ?? 0.5;
    const sendOrder = BigInt(tile.lod * 10000 + Math.floor((1 - vpap) * 1000));
    const tileStream = await session.createUnidirectionalStream({
      sendOrder: sendOrder,
      sendGroup: null
    });
    
    // 🔥 检查 stream 是否有效
    if (!tileStream) {
      console.error(`❌ createUnidirectionalStream returned undefined for ${tile.hash} L${tile.lod}`);
      return false;
    }
    
    // 🔥 性能指标：记录 stream opened（只有在成功创建 stream 后）
    streamMetrics.streamOpened();
    streamOpened = true; // 标记已记录
    
    const writer = tileStream.getWriter();
    const metadata = { hash: tile.hash, lod: tile.lod, weight: tile.weight, size: tileData.length };
    
    // Protocol: JSON + \n + Binary
    const header = JSON.stringify(metadata) + '\n';
    await writer.write(new TextEncoder().encode(header));
    await writer.write(tileData);
    streamMetrics.addPayloadBytes(tileData.length);
    await writer.close();
    
    // 🔥 性能指标：记录 stream closed（安全检查）
    // 某些 WebTransport 实现可能没有 closed 属性
    if (tileStream.closed && typeof tileStream.closed.then === 'function') {
      tileStream.closed.then(() => {
        streamMetrics.streamClosed();
      }).catch(() => {
        streamMetrics.streamClosed(); // 即使出错也记录关闭
      });
    } else {
      // 如果没有 closed 属性，在 writer.close() 完成后立即记录关闭
      streamMetrics.streamClosed();
    }
    
    return true;
  } catch (e) {
    // 🔥 关键修复：如果 stream 已打开但后续失败，必须记录 stream 关闭
    // 确保 streamOpened() 和 streamClosed() 成对出现，避免计数错误
    if (streamOpened) {
      streamMetrics.streamClosed();
    }
    
    const errorMsg = e?.message || String(e);
    // 🔥 Session 关闭时不重试
    if (errorMsg.includes('Session') || errorMsg.includes('closed') || errorMsg.includes('Connection lost')) {
      return false; // Session 已关闭，不重试
    }
    // 🔥 "No streams available" 时重试，其他错误不重试
    if (errorMsg.includes('No streams available') && retryCount < MAX_RETRIES) {
      // 延迟后重试
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
      return pushSingleTile(session, tile, retryCount + 1);
    }
    // 只输出第一次失败的错误（避免刷屏）
    if (retryCount === 0) {
      // 限制错误日志输出（每 10 个失败才输出一次）
      if (Math.random() < 0.1) {
        console.error(`❌ pushSingleTile failed for ${tile.hash} L${tile.lod}:`, errorMsg);
      }
    }
    return false;
  }
}

// 读取 tile 数据：从物理盘异步读取（依赖 OS Page Cache），分批并发避免 EMFILE
async function readTileFile(tileHash, lod) {
  const filePath = path.join(TILES_BASE_PATH, `L${lod}`, `${tileHash}-L${lod}.splat`);
  try {
    return await fs.promises.readFile(filePath);
  } catch (e) {
    return null;
  }
}

// 创建 WebTransport 服务器（使用 Http3Server，支持 QUIC）
const wt = new Http3Server({
  port: PORT,
  host: '0.0.0.0',
  cert: fs.readFileSync(CERT_PATH, 'utf8'),
  privKey: fs.readFileSync(KEY_PATH, 'utf8'),
  secret: 'webtransport-tile-server-secret', // 🔥 必需参数
  path: '/wt'
});

// 启动服务器
// 检查证书文件是否存在
if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error('❌ 证书文件不存在！');
  console.error(`   证书路径: ${CERT_PATH}`);
  console.error(`   私钥路径: ${KEY_PATH}`);
  console.error('\n请使用 mkcert 生成证书：');
  console.error('   mkcert web3d.local');
  process.exit(1);
}

// 加载 tile 映射
loadTilesMapping();

// 🔥 初始化服务端性能指标记录（baseline4），包含元数据
const streamMetrics = new StreamMetrics('baseline4', {
  run_id: `run_${Date.now()}`,
  scenario_id: 'gs-campus',
  cache_state: 'cold', // 首次加载为 cold，后续为 warm
  camera_trace_id: 'default'
});

// 启动 WebTransport 服务器
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

// 🔥 定期导出指标（每60秒），文件名包含元数据
setInterval(async () => {
  try {
    const filename = streamMetrics.generateFilename('latest');
    await streamMetrics.writeToFile(path.join(__dirname, filename));
  } catch (e) {
    console.error('❌ Failed to export stream metrics:', e);
  }
}, 60000);

// 🔥 服务器关闭时导出最终指标，文件名包含元数据
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

// 处理 WebTransport 会话（在服务器启动后）
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
      
      // 🔥 初始化该 Session 的最新 requestId 和 LOD 集合映射
      sessionLatestRequestId.set(session, 0);
      sessionTileLodSetMap.set(session, new Map()); // Map<tileHash, Set<lod>>
      
      // 等待会话就绪
      await session.ready;
      console.log('✅ Session ready');
      console.log('📡 [Server] Session 对象:', typeof session, session.constructor?.name);
      console.log('📡 [Server] Session 是否有 incomingBidirectionalStreams:', 'incomingBidirectionalStreams' in session);
      
      // 🔥 [关键修复] 连接建立后，立刻推送初始列表！
      pushInitialTiles(session).catch(e => console.error('❌ Initial tiles push error:', e));
      
      // 处理会话关闭
      session.closed.then(() => {
        console.log('🔴 WebTransport session closed');
      }).catch(error => {
        console.error('❌ Session close error:', error);
      });
      
      // 🔥 处理双向流（接收客户端相机数据）- 必须在 session ready 之后立即开始监听
      console.log('📡 [Server] 准备开始监听双向流（接收客户端相机数据）...');
      console.log('📡 [Server] 当前时间:', new Date().toISOString());
      (async () => {
        try {
          console.log('📡 [Server] 开始监听双向流（接收客户端相机数据）...');
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
          
          console.log('📡 [Server] 双向流 reader 已创建，等待客户端创建双向流...');
          
          while (true) {
            try {
              const { value: stream, done } = await reader.read();
              
              if (done) {
                console.log('📡 [Server] 双向流读取完成（done=true）');
                break;
              }
              
              if (!stream) {
                console.warn('⚠️ [Server] 收到 null stream，跳过');
                continue;
              }
              
              console.log('✅ [Server] 收到新的双向流，开始读取相机数据...');
              
              // 🔥 为每个双向流创建独立的处理任务
              (async () => {
                try {
                  // 读取客户端发送的相机数据
                  const streamReader = stream.readable.getReader();
                  const decoder = new TextDecoder();
                  let buffer = ''; // 🔥 用于累积不完整的 JSON 数据
                  
                  while (true) {
                    const { value: chunk, done: streamDone } = await streamReader.read();
                    
                    if (streamDone) {
                      // 流结束时处理剩余的 buffer
                      if (buffer.trim()) {
                        try {
                          const cameraData = JSON.parse(buffer.trim());
                          console.log(`📥 [Server] 流结束时收到相机数据 (requestId: ${cameraData.id})`);
                          // 🔥 更新该 Session 的最新 ID
                          sessionLatestRequestId.set(session, cameraData.id);
                          // 🔥 方案 2A：序列化执行，确保 L1 全发完再发 L2/L3/L4
                          scheduleProcessCameraData(cameraData, session);
                        } catch (error) {
                          console.error('❌ Failed to parse final camera data:', error);
                        }
                      }
                      break;
                    }
                    
                    if (!chunk) {
                      console.warn('⚠️ [Server] 收到 null chunk，跳过');
                      continue;
                    }
                    
                    // 🔥 使用换行符分割（客户端发送时末尾加 '\n'）
                    buffer += decoder.decode(chunk, { stream: true });
                    
                    // 使用换行符分割
                    const lines = buffer.split('\n');
                    
                    // 最后一部分可能不完整，保留在 buffer 中
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                      if (line.trim()) {
                        try {
                          const cameraData = JSON.parse(line);
                          console.log(`📥 [Server] 收到相机数据 (requestId: ${cameraData.id})`);
                          
                          // 🔥 更新该 Session 的最新 ID
                          sessionLatestRequestId.set(session, cameraData.id);
                          
                          // 🔥 方案 2A：序列化执行，确保 L1 全发完再发 L2/L3/L4
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

// 错误处理已在启动时处理
