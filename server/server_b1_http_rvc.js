/**
 * B1 baseline: HTTP/1.1 static tiles + WebSocket RVC (camera-driven tile list).
 * Uses the same tileSelection.js and reference_manifest lock as B3/B4 for fair comparison.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { selectTiles } from './tileSelection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.B1_HTTP_PORT || process.env.B1_PORT || 7080);
const ASSETS_ROOT = process.env.VPAP_ASSETS_DIR
  ? path.resolve(process.env.VPAP_ASSETS_DIR)
  : path.join(__dirname, '../dataset/toy_example');
const REFERENCE_MANIFEST_PATH = process.env.VPAP_REFERENCE_MANIFEST
  ? path.resolve(process.env.VPAP_REFERENCE_MANIFEST)
  : path.join(ASSETS_ROOT, 'reference_manifest.json');
const WS_PATH = process.env.B1_WS_PATH || '/rvc';
const STATIC_ENABLED = process.env.B1_STATIC_ENABLED !== '0';

/** Raw mapping JSON (array of hashes or id->hash object); passed to selectTiles + model id resolution */
let mappingData = [];
let fixedSelectionTiles = [];

function loadMapping() {
  const mappingPath = path.join(ASSETS_ROOT, 'custom_bounding_boxes_mapping-campus2.json');
  const mappingContent = fs.readFileSync(mappingPath, 'utf-8');
  mappingData = JSON.parse(mappingContent);
  const n = Array.isArray(mappingData)
    ? mappingData.filter(Boolean).length
    : Object.keys(mappingData || {}).length;
  console.log(`[B1] Loaded mapping with ${n} tile entries`);
}

function loadReferenceManifest() {
  try {
    if (!fs.existsSync(REFERENCE_MANIFEST_PATH)) {
      console.warn(`[B1] reference_manifest not found: ${REFERENCE_MANIFEST_PATH} (camera-driven selectTiles only)`);
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(REFERENCE_MANIFEST_PATH, 'utf-8'));
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    fixedSelectionTiles = items.map((x) => ({
      hash: x.tile_id,
      lod: Math.max(1, Math.min(4, Number(x.target_lod || x.lod || 1))),
      weight: Number(x.weight || 500),
      distance: Number(x.distance || 0),
    }));
    console.log(`[B1] Locked reference_manifest: ${fixedSelectionTiles.length} tiles`);
  } catch (e) {
    console.error('[B1] Failed to load reference_manifest:', e?.message || e);
  }
}

function modelIdForHash(h) {
  if (Array.isArray(mappingData)) {
    const i = mappingData.indexOf(h);
    return i >= 0 ? i : null;
  }
  if (mappingData && typeof mappingData === 'object') {
    for (const k of Object.keys(mappingData)) {
      if (mappingData[k] === h) return k;
    }
  }
  return null;
}

function buildRvcMessage(cameraData) {
  const visibleTiles =
    fixedSelectionTiles.length > 0 ? fixedSelectionTiles : selectTiles(cameraData, mappingData);
  const modelList = [];
  const weightList = [];
  for (const t of visibleTiles) {
    const id = modelIdForHash(t.hash);
    if (id == null) continue;
    modelList.push(id);
    weightList.push(t.weight);
  }
  return {
    list: JSON.stringify(modelList),
    weight: JSON.stringify(weightList),
    id: cameraData.id ?? 0,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.splat': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

function staticHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(ASSETS_ROOT, path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (!filePath.startsWith(ASSETS_ROOT)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    });
    res.end(data);
  });
}

function onHttpRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }
  if (STATIC_ENABLED) {
    staticHandler(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('B1 static disabled; use B2 Caddy or set B1_STATIC_ENABLED=1');
}

loadMapping();
loadReferenceManifest();

const server = http.createServer(onHttpRequest);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', `http://${req.headers.host}`);
  if (u.pathname === WS_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
          const cameraData = JSON.parse(text);
          const payload = buildRvcMessage(cameraData);
          const buf = Buffer.from(JSON.stringify(payload), 'utf8');
          ws.send(buf);
        } catch (e) {
          console.error('[B1] WebSocket message error:', e?.message || e);
        }
      });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[B1] HTTP/1.1 ${STATIC_ENABLED ? 'static' : '(static off)'} + WebSocket RVC`);
  console.log(`[B1]   HTTP  GET  http://0.0.0.0:${PORT}/  (assets root: ${ASSETS_ROOT})`);
  console.log(`[B1]   WebSocket ws://<host>:${PORT}${WS_PATH}`);
});
