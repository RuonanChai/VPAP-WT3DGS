// Baseline3: WebTransport without any application-level optimization
// Purpose: Isolate protocol capability from application-level scheduling optimization
// 
// Constraints:
// - ✅ Use WebTransport/QUIC as transport protocol
// - ✅ One tile-lod per stream
// - ✅ Application order: initial_selection tile order; per tile L1→L2→L3→L4 (no cross-tile LOD scheduling)
// - ✅ Fair transport: batched concurrent sends (same realization as B4: batch size + inter-batch delay)
// - ❌ NO FoV/VPAP or other application-level reordering vs B1/B2 initial queue
// - ❌ NO server-side priority differentiation (same sendOrder for all streams)
//
// IMPORTANT: For fair comparison, baseline3 uses the SAME tile selection logic
// as other baselines (via tileSelection.js), but different loading strategy.

import { Http3Server } from '@fails-components/webtransport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectTiles } from './tileSelection.js';
import { StreamMetrics } from './StreamMetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.VPAP_BASELINE_PORT || 9444);
const CERT_DIR = process.env.VPAP_CERT_DIR
  ? path.resolve(process.env.VPAP_CERT_DIR)
  : path.join(__dirname, 'certs');
const FULLCHAIN_CANDIDATE = process.env.VPAP_TLS_FULLCHAIN
  ? path.resolve(process.env.VPAP_TLS_FULLCHAIN)
  : path.join(CERT_DIR, 'fullchain.pem');
const CERT_LEAF = process.env.VPAP_TLS_CERT
  ? path.resolve(process.env.VPAP_TLS_CERT)
  : path.join(CERT_DIR, 'web3d.local.pem');
const KEY_PATH = process.env.VPAP_TLS_KEY
  ? path.resolve(process.env.VPAP_TLS_KEY)
  : path.join(CERT_DIR, 'web3d.local-key.pem');
const CERT_PATH = fs.existsSync(FULLCHAIN_CANDIDATE) ? FULLCHAIN_CANDIDATE : CERT_LEAF;
const ASSETS_ROOT = process.env.VPAP_ASSETS_DIR
  ? path.resolve(process.env.VPAP_ASSETS_DIR)
  : path.join(__dirname, '../dataset/toy_example');
const TILES_BASE_PATH = path.join(ASSETS_ROOT, '20_lod');
const INIT_LIST_PATH = path.join(ASSETS_ROOT, 'modelToLoadList_GS.json');
const REFERENCE_MANIFEST_PATH = process.env.VPAP_REFERENCE_MANIFEST
  ? path.resolve(process.env.VPAP_REFERENCE_MANIFEST)
  : path.join(ASSETS_ROOT, 'reference_manifest.json');
const fixedTileTargetLodMap = new Map(); // tileHash -> targetLod
let fixedSelectionTiles = [];

// 与 B4 对齐的「公平」传输实现：仅影响 QUIC 上同时存在的流数量，不改变 tile/LOD 语义顺序
const B3_CONCURRENT_INITIAL = 120;
const B3_CONCURRENT_CAMERA = 100;
const B3_BATCH_DELAY_INITIAL_MS = 2;
const B3_BATCH_DELAY_CAMERA_MS = 10;

// Check certificates
if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error('❌ Certificate files not found!');
  console.error(`   Cert: ${CERT_PATH}`);
  console.error(`   Key: ${KEY_PATH}`);
  process.exit(1);
}

// Load all tiles mapping
let tilesMapping = [];
try {
  const mappingPath = path.join(ASSETS_ROOT, 'custom_bounding_boxes_mapping-campus2.json');
  const mappingContent = fs.readFileSync(mappingPath, 'utf-8');
  const mappingJson = JSON.parse(mappingContent);
  tilesMapping = Array.isArray(mappingJson) ? mappingJson.filter(Boolean) : Object.values(mappingJson || {}).filter(Boolean);
  console.log(`📋 Loaded ${tilesMapping.length} tiles from mapping`);
} catch (e) {
  console.error('❌ Failed to load tiles mapping:', e.message);
  process.exit(1);
}

// Load fixed manifest for workload lock (same object set across baselines)
try {
  if (fs.existsSync(REFERENCE_MANIFEST_PATH)) {
    const manifest = JSON.parse(fs.readFileSync(REFERENCE_MANIFEST_PATH, 'utf-8'));
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    fixedSelectionTiles = items.map((x) => ({
      hash: x.tile_id,
      lod: Math.max(1, Math.min(4, Number(x.target_lod || x.lod || 1))),
      weight: Number(x.weight || 500),
      distance: Number(x.distance || 0),
    }));
    for (const t of fixedSelectionTiles) fixedTileTargetLodMap.set(t.hash, t.lod);
    console.log(`📌 B3 locked reference_manifest: ${fixedSelectionTiles.length} tiles`);
  } else {
    console.warn(`[WARN] B3 reference_manifest not found: ${REFERENCE_MANIFEST_PATH}`);
  }
} catch (e) {
  console.error('[ERR] Failed to load B3 reference_manifest:', e?.message || e);
}

// Create WebTransport server
console.log('🔧 Creating WebTransport server...');
console.log(`   Port: ${PORT}`);
console.log(`   Host: 0.0.0.0`);
console.log(`   Cert: ${CERT_PATH}`);
console.log(`   Key: ${KEY_PATH}`);

const server = new Http3Server({
  port: PORT,
  host: '0.0.0.0',
  cert: fs.readFileSync(CERT_PATH, 'utf8'),
  privKey: fs.readFileSync(KEY_PATH, 'utf8'),
  secret: 'webtransport-tile-server-secret',
  path: '/wt'
});

console.log('✅ WebTransport server object created');

// 🔥 初始化服务端性能指标记录（baseline3），包含元数据
const streamMetrics = new StreamMetrics('baseline3', {
  run_id: `run_${Date.now()}`,
  scenario_id: 'gs-campus',
  cache_state: 'cold', // 首次加载为 cold，后续为 warm
  camera_trace_id: 'default'
});

// 文件缓存（LRU）：不改变任何调度语义，只减少重复磁盘 I/O
const tileDataCache = new Map();   // key: `${tileHash}-L${lod}` -> Buffer
const MAX_CACHE_ITEMS = 800;       // 可先调 500/800/1000，看内存

function touchCache(key, value) {
  if (tileDataCache.has(key)) {
    tileDataCache.delete(key);
  }
  tileDataCache.set(key, value);

  if (tileDataCache.size > MAX_CACHE_ITEMS) {
    const oldestKey = tileDataCache.keys().next().value;
    tileDataCache.delete(oldestKey);
  }
}

async function getTileData(tileHash, lod) {
  const key = `${tileHash}-L${lod}`;
  if (tileDataCache.has(key)) {
    const data = tileDataCache.get(key);
    // LRU touch
    tileDataCache.delete(key);
    tileDataCache.set(key, data);
    return data;
  }

  const fileName = `${tileHash}-L${lod}.splat`;
  const filePath = path.join(TILES_BASE_PATH, `L${lod}`, fileName);

  try {
    const data = await fs.promises.readFile(filePath);
    touchCache(key, data);
    return data;
  } catch (e) {
    return null;
  }
}

try {
  server.startServer();
  console.log(`🚀 Baseline3: WebTransport (no optimization) running at https://web3d.local:${PORT}/wt`);
  console.log(`📁 Tiles path: ${TILES_BASE_PATH}`);
  console.log(`📋 Certificate: ${CERT_PATH}`);
  console.log(`🔑 Private key: ${KEY_PATH}`);
  console.log(`🌐 Listening on: 0.0.0.0:${PORT}`);
  console.log('✅ Server started, waiting for connections...');
  console.log('💡 If connections fail, check:');
  console.log('   1. Firewall allows UDP port', PORT);
  console.log('   2. TLS certificate SAN matches the host/IP in your WebTransport URL');
  console.log('   3. Browser trusts mkcert root certificate');
} catch (error) {
  console.error('❌ Failed to start server:', error);
  console.error('   Error details:', error.message);
  console.error('   Stack:', error.stack);
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

// Handle WebTransport sessions
(async () => {
  try {
    console.log('🔵 Setting up WebTransport session handler...');
    console.log('   Path: /wt');
    const sessionStream = await server.sessionStream('/wt');
    console.log('✅ Session stream obtained');
    const sessionReader = sessionStream.getReader();
    console.log('✅ Session stream reader created');
    console.log('🔵 Now waiting for WebTransport connections...');
    console.log('   When a browser connects, you should see "New WebTransport session received"');
    
    while (true) {
      console.log('📥 Waiting for next session...');
      const { done, value: session } = await sessionReader.read();
      if (done) {
        console.log('🔴 Session stream ended');
        break;
      }
      
      console.log('✅ New WebTransport session received!');
      console.log('   Session object:', session ? 'valid' : 'null');
      await session.ready;
      
      session.closed.then(() => {
        console.log('🔴 Session closed');
      }).catch(error => {
        console.error('❌ Session close error:', error);
      });

      // 防重传：以 (tileHash, targetLod) 为粒度
      // 公平性：只影响“重复发包”，不影响“应用层发起顺序”
      session.sentTiles = new Set();
      
      // Baseline3: Initial load - use SAME tile selection as other baselines
      // For initial load, we need a default camera position (same as other baselines)
      // This ensures fair comparison: same tiles selected, only loading differs
      const initialCameraData = {
        cameraPos: [-31225.02, 12724.57, -26389.44] // Same initial camera as other baselines
      };
      const initialSelectedTiles = fixedSelectionTiles.length ? fixedSelectionTiles : selectTiles(initialCameraData, tilesMapping);
      
      console.log(`📤 Initial load: push ${initialSelectedTiles.length} selected tiles (lod=1..targetLod)`);
      await pushBaseline3WorkQueue(session, initialSelectedTiles, true);
      
      // Handle bidirectional streams (receive camera data)
      // Baseline3: Uses SAME tile selection as other baselines (for fair comparison)
      // but different loading strategy (no optimization, sequential push)
      (async () => {
        try {
          const streams = session.incomingBidirectionalStreams;
          const reader = streams.getReader();
          
          while (true) {
            const { value: stream, done } = await reader.read();
            if (done) break;
            if (!stream) continue;
            
            // Read camera data
            const streamReader = stream.readable.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
              const { value: chunk, done: streamDone } = await streamReader.read();
              if (streamDone) break;
              buffer += decoder.decode(chunk, { stream: true });
              
              // Process complete JSON lines
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const cameraData = JSON.parse(line);
                  
                  // 🔥 FAIR COMPARISON: Use SAME tile selection as other baselines
                  // This ensures we load the SAME tiles, only the loading strategy differs
                  const selectedTiles = fixedSelectionTiles.length ? fixedSelectionTiles : selectTiles(cameraData, tilesMapping);
                  
                  // Baseline3: Push selected tiles sequentially (no optimization)
                  // Push lod=1..targetLod to align object set with HTTP cold-start
                  console.log(`📤 Camera update: push ${selectedTiles.length} selected tiles (lod=1..targetLod)`);
                  await pushBaseline3WorkQueue(session, selectedTiles, false);
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }
          }
        } catch (error) {
          // Ignore stream handling errors
        }
      })();
    }
  } catch (error) {
    console.error('❌ Session stream error:', error);
    process.exit(1);
  }
})();

/** 展平为严格顺序的 (hash, lod) 队列：先 tile 序，每 tile 内 L1..targetLod */
function buildBaseline3WorkQueue(tileList) {
  const work = [];
  for (const tile of tileList) {
    const targetLod = Math.max(1, Math.min(4, Number(tile?.lod || 1)));
    for (let lod = 1; lod <= targetLod; lod++) {
      work.push({ hash: tile.hash, lod });
    }
  }
  return work;
}

/**
 * 公平并发：按队列分批 Promise.allSettled，批大小与批间延迟与 B4 一致；不改变队列语义。
 */
async function pushBaseline3WorkQueue(session, tileList, isInitialLoad) {
  const workQueue = buildBaseline3WorkQueue(tileList);
  if (workQueue.length === 0) return;

  const CONCURRENT_BATCH_SIZE = isInitialLoad ? B3_CONCURRENT_INITIAL : B3_CONCURRENT_CAMERA;
  const BATCH_DELAY_MS = isInitialLoad ? B3_BATCH_DELAY_INITIAL_MS : B3_BATCH_DELAY_CAMERA_MS;
  const totalBatches = Math.ceil(workQueue.length / CONCURRENT_BATCH_SIZE);

  console.log(
    `📤 B3 fair transport: ${workQueue.length} chunks, batch=${CONCURRENT_BATCH_SIZE}, delay=${BATCH_DELAY_MS}ms (${totalBatches} batches)`
  );

  if (isInitialLoad) {
    const t0 = Date.now();
    await Promise.allSettled(workQueue.map((w) => getTileData(w.hash, w.lod)));
    console.log(`📦 B3 preload into LRU: ${Date.now() - t0}ms`);
  }

  const pushStartTime = Date.now();
  let totalOk = 0;

  for (let batchStart = 0; batchStart < workQueue.length; batchStart += CONCURRENT_BATCH_SIZE) {
    const batch = workQueue.slice(batchStart, batchStart + CONCURRENT_BATCH_SIZE);
    const batchNum = Math.floor(batchStart / CONCURRENT_BATCH_SIZE) + 1;
    const tBatch = Date.now();

    const pushPromises = batch.map((w) => pushTileActual(session, w.hash, w.lod));
    const results = await Promise.allSettled(pushPromises);
    const batchOk = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    totalOk += batchOk;

    if (batchOk > 0) {
      const elapsed = Date.now() - tBatch;
      console.log(
        `📤 B3 batch ${batchNum}/${totalBatches}: ok=${batchOk}/${batch.length} | ${elapsed}ms (${(elapsed / batchOk).toFixed(1)}ms/chunk)`
      );
    }

    if (batchNum < totalBatches) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  const totalElapsed = Date.now() - pushStartTime;
  console.log(`✅ B3 push done: ${totalOk}/${workQueue.length} ok | ${totalElapsed}ms`);
}

// Baseline3 单个 tile-lod 的底层写入；sendOrder 恒定，无应用层调序
async function pushTileActual(session, tileHash, lod) {
  const maxAllowedLod = fixedTileTargetLodMap.get(tileHash);
  if (fixedTileTargetLodMap.size > 0 && (maxAllowedLod == null || lod < 1 || lod > maxAllowedLod)) {
    return true;
  }
  const tileKey = `${tileHash}-L${lod}`;
  if (session.sentTiles.has(tileKey)) return true;
  session.sentTiles.add(tileKey);

  const data = await getTileData(tileHash, lod);
  if (!data) {
    session.sentTiles.delete(tileKey);
    return false;
  }

  let stream;
  try {
    stream = await session.createUnidirectionalStream({
      sendOrder: BigInt(100),
      sendGroup: null
    });
    streamMetrics.streamOpened();
  } catch (e) {
    session.sentTiles.delete(tileKey);
    return false;
  }

  try {
    const writer = stream.getWriter();
    const header = JSON.stringify({
      hash: tileHash,
      lod: lod,
      size: data.length
    }) + '\n';

    await writer.write(new TextEncoder().encode(header));
    await writer.write(data);
    streamMetrics.addPayloadBytes(data.length);
    await writer.close();
    return true;
  } catch (e) {
    return false;
  } finally {
    streamMetrics.streamClosed();
  }
}
