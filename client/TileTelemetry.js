/**
 * 全局细粒度瓦片埋点 (Global Fine-grained Tile Telemetry)
 * 用于 B1/B2/B3/B4 统一记录 Per-tile 生命周期，生成顶会实验图表
 *
 * 公平性（TTFB / TTLB）：
 * - B1/B2：在发起 HTTP 传输前调用 recordReq → req_time = T_logic_request_start
 * - B3/B4：在开始消费该 WT stream 前（stream.getReader() 前一刻）记 logicRequestStart，
 *   与 B1/B2「调用底层传输前」对齐；禁止仅用 stream 内构造的 ttfbMs 冒充 req_time。
 * 时间语义：全部为相对 t0 的 ms；ttfb_ms = first_byte_time - req_time（与上式一致）
 * 字段：experiment_id, run_id, baseline_id, tile_id, lod, bytes,
 *       vpap_score, is_critical,
 *       enqueue_time, req_time, first_byte_time, complete_time,
 *       ttfb_ms, ttlb_ms (导出时附加)
 * 去重：每 (run_id, baseline_id, tile_id, lod) 仅一条，首次到达记，重复加 duplicate_count
 */

const TILE_SIZE = 0.7788;
/** 与 metric_fairness_postprocess.MIN_DECODABLE_PAYLOAD_BYTES 一致：排除纯元数据包 */
const MIN_DECODABLE_PAYLOAD_BYTES = 256;
const ORIGIN_GRID_X = 524267;
const ORIGIN_GRID_Z = 524285;

function getTilePosFromHash(hash) {
  const m = String(hash).match(/tile_\d+_(\d+)_(\d+)/);
  if (!m) return null;
  const gx = parseInt(m[1], 10);
  const gz = parseInt(m[2], 10);
  return {
    x: (gx - ORIGIN_GRID_X) * TILE_SIZE,
    y: 0,
    z: (gz - ORIGIN_GRID_Z) * TILE_SIZE
  };
}

/** VPAP: P(i) = 0.7 * score_view + 0.3 * score_dist */
function computeVPAPScore(cameraPos, cameraForward, tilePos) {
  if (!cameraPos || !tilePos) return 0.5;
  const cx = cameraPos[0] ?? 0, cy = cameraPos[1] ?? 0, cz = cameraPos[2] ?? 0;
  const tx = tilePos.x, ty = tilePos.y, tz = tilePos.z;
  const dx = tx - cx, dy = ty - cy, dz = tz - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-6) return 1;
  const vx = dx / dist, vy = dy / dist, vz = dz / dist;
  let scoreView = 0.5;
  if (cameraForward && cameraForward.length >= 3) {
    const fx = cameraForward[0] ?? 0, fy = cameraForward[1] ?? 0, fz = cameraForward[2] ?? 0;
    const dot = fx * vx + fy * vy + fz * vz;
    scoreView = dot < 0.5 ? 0 : dot;
  }
  const scoreDist = 1 / (1 + dist / 2000);
  return 0.7 * scoreView + 0.3 * scoreDist;
}

/** is_critical = 点积 > 0.5（在视野 60° 内） */
function computeIsCritical(cameraPos, cameraForward, tilePos) {
  if (!cameraPos || !cameraForward || !tilePos) return false;
  const cx = cameraPos[0] ?? 0, cy = cameraPos[1] ?? 0, cz = cameraPos[2] ?? 0;
  const fx = cameraForward[0] ?? 0, fy = cameraForward[1] ?? 0, fz = cameraForward[2] ?? 0;
  const tx = tilePos.x, ty = tilePos.y, tz = tilePos.z;
  const dx = tx - cx, dy = ty - cy, dz = tz - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-6) return true;
  const vx = dx / dist, vy = dy / dist, vz = dz / dist;
  const dot = fx * vx + fy * vy + fz * vz;
  return dot > 0.5;
}

function normalizeBaselineId(b) {
  const s = String(b || '').toLowerCase();
  if (s.includes('1') || s === 'b1') return 'B1';
  if (s.includes('2') || s === 'b2') return 'B2';
  if (s.includes('3') || s === 'b3') return 'B3';
  if (s.includes('4') || s === 'b4') return 'B4';
  return s || 'unknown';
}

/** tile_id 跨 baseline 稳定：统一为 tile_XX_YYYY_ZZZZ 格式 */
function normalizeTileId(id) {
  const s = String(id || '').trim();
  if (/^tile_\d+_\d+_\d+$/.test(s)) return s;
  const m = s.match(/tile_(\d+)_(\d+)_(\d+)/);
  return m ? `tile_${m[1]}_${m[2]}_${m[3]}` : s;
}

/** LOD 统一：1-4 整数，L1=最粗 L4=最细 */
function normalizeLod(lod) {
  const n = parseInt(lod, 10);
  if (isNaN(n) || n < 1) return 1;
  if (n > 4) return 4;
  return n;
}

class TileTelemetryLogger {
  constructor(options = {}) {
    this.baselineId = normalizeBaselineId(options.baselineId || (typeof window !== 'undefined' && window.__BASELINE__));
    this.experimentId = options.experimentId || (typeof window !== 'undefined' && window.__EXPERIMENT_ID__) || 'unknown';
    this.runId = options.runId || (typeof window !== 'undefined' && window.__RUN_ID__) || (this.experimentId + '_' + this.baselineId);
    this.t0 = null;
    this.records = new Map(); // key: `${tile_id}-L${lod}` -> record，每 key 仅一条
    this.enabled = options.enabled !== false;
  }

  _ensureT0() {
    if (this.t0 == null) {
      // 🔥 零点对齐：优先使用实验 Phase 0 完成时设置的全局 t0，确保 B1/B2/B3/B4 物理时刻一致
      this.t0 = (typeof window !== 'undefined' && typeof window.__TELEMETRY_T0__ === 'number')
        ? window.__TELEMETRY_T0__
        : performance.now();
    }
  }

  _rel(ts) {
    if (ts == null) return null;
    this._ensureT0();
    return Math.round((ts - this.t0) * 100) / 100;
  }

  _key(tileId, lod) {
    return `${normalizeTileId(tileId)}-L${normalizeLod(lod)}`;
  }

  _getOrCreate(tileId, lod, vpapScore, isCritical) {
    const tid = normalizeTileId(tileId);
    const lid = normalizeLod(lod);
    const key = this._key(tid, lid);
    let r = this.records.get(key);
    if (!r) {
      r = {
        experiment_id: this.experimentId,
        run_id: this.runId,
        baseline_id: this.baselineId,
        tile_id: tid,
        lod: lid,
        bytes: 0,
        vpap_score: vpapScore ?? 0.5,
        is_critical: !!isCritical,
        enqueue_time: null,
        req_time: null,
        first_byte_time: null,
        first_decodable_byte_time: null,
        complete_time: null,
        duplicate_count: 0,
        request_start_source: null
      };
      this.records.set(key, r);
    }
    return r;
  }

  /** 瓦片入队（请求生成时刻），去重：仅首次设置 */
  recordEnqueue(tileId, lod, options = {}) {
    if (!this.enabled) return;
    const { vpapScore, isCritical, cameraPos, cameraForward } = options;
    let vpap = vpapScore;
    let critical = isCritical;
    if (vpap == null || critical == null) {
      const tilePos = getTilePosFromHash(tileId);
      if (tilePos) {
        vpap = vpap ?? computeVPAPScore(cameraPos, cameraForward, tilePos);
        critical = critical ?? computeIsCritical(cameraPos, cameraForward, tilePos);
      }
    }
    const r = this._getOrCreate(tileId, lod, vpap, critical);
    if (r.enqueue_time != null) return; // 去重
    const now = performance.now();
    this._ensureT0();
    r.enqueue_time = this._rel(now);
  }

  /**
   * 统一 API：逻辑请求起点（HTTP：fetch 前；WT：getReader 前，且应在 session.ready 之后）
   * @alias recordReq
   */
  recordLogicalRequestStart(tileId, lod, options = {}) {
    if (!this.enabled) return;
    const r = this._getOrCreate(tileId, lod);
    if (r.req_time != null) return;
    const now = performance.now();
    this._ensureT0();
    r.req_time = this._rel(now);
    r.request_start_source = options.source || 'http_fetch_before';
  }

  /** 底层协议发出请求，去重：仅首次设置 */
  recordReq(tileId, lod) {
    this.recordLogicalRequestStart(tileId, lod, { source: 'http_fetch_before' });
  }

  /** 首次累计负载达到可解码阈值（与 Python MIN_DECODABLE 对齐） */
  recordFirstDecodablePayload(tileId, lod, loadedBytes) {
    if (!this.enabled) return;
    if (loadedBytes == null || loadedBytes < MIN_DECODABLE_PAYLOAD_BYTES) return;
    const r = this._getOrCreate(tileId, lod);
    if (r.first_decodable_byte_time != null) return;
    const now = performance.now();
    this._ensureT0();
    r.first_decodable_byte_time = this._rel(now);
  }

  /** 首次收到第一字节（绝对时间戳），去重：仅首次 onProgress>0 */
  recordFirstByte(tileId, lod) {
    if (!this.enabled) return;
    const r = this._getOrCreate(tileId, lod);
    if (r.first_byte_time != null) { r.duplicate_count = (r.duplicate_count || 0) + 1; return; }
    const now = performance.now();
    this._ensureT0();
    r.first_byte_time = this._rel(now);
  }

  /** 首次完整接收（绝对时间戳），去重：仅首次 */
  recordComplete(tileId, lod, bytes) {
    if (!this.enabled) return;
    const r = this._getOrCreate(tileId, lod);
    if (r.complete_time != null) { r.duplicate_count = (r.duplicate_count || 0) + 1; return; }
    const now = performance.now();
    this._ensureT0();
    r.complete_time = this._rel(now);
    if (bytes != null) r.bytes = bytes;
    this._emit(r);
  }

  /** 兼容旧 API */
  recordFb(tileId, lod) { this.recordFirstByte(tileId, lod); }
  recordComp(tileId, lod, bytes) { this.recordComplete(tileId, lod, bytes); }

  /**
   * B3/B4 WebTransport：req_time 必须由 SLM2Loader 传入「逻辑请求起点」——与 B1/B2 在 fetch 前 recordReq 对齐。
   * @param {object} options
   * @param {number} options.logicRequestStart - performance.now()，在 stream.getReader() / 开始 read 之前记录（与 fetch 前 recordReq 等价）
   * @param {number} options.firstByteAt - performance.now()，首字节到达（任意 chunk 含字节即可）
   * @param {number} options.completeAt - performance.now()，该 tile 二进制接收完成
   * @deprecated options.t0, options.ttfbMs, options.ttlbMs - 旧版；缺省公平字段时降级并告警
   */
  recordFromStream(tileId, lod, options = {}) {
    if (!this.enabled) return;
    const {
      bytes,
      cameraPos,
      cameraForward,
      logicRequestStart,
      firstByteAt,
      firstDecodableByteAt,
      completeAt,
      t0,
      ttfbMs,
      ttlbMs,
    } = options;
    const tilePos = getTilePosFromHash(tileId);
    const vpapScore = tilePos ? computeVPAPScore(cameraPos, cameraForward, tilePos) : 0.5;
    const isCritical = tilePos ? computeIsCritical(cameraPos, cameraForward, tilePos) : false;
    const r = this._getOrCreate(tileId, lod, vpapScore, isCritical);
    if (r.complete_time != null) { r.duplicate_count = (r.duplicate_count || 0) + 1; return; }
    this._ensureT0();
    const rel = (ts) => Math.round((ts - this.t0) * 100) / 100;

    if (
      typeof logicRequestStart === 'number' &&
      typeof firstByteAt === 'number' &&
      typeof completeAt === 'number'
    ) {
      r.enqueue_time = rel(logicRequestStart);
      r.req_time = rel(logicRequestStart);
      r.first_byte_time = rel(firstByteAt);
      if (typeof firstDecodableByteAt === 'number') {
        r.first_decodable_byte_time = rel(firstDecodableByteAt);
      }
      r.complete_time = rel(completeAt);
      if (bytes != null) r.bytes = bytes;
      const wtReady = typeof window !== 'undefined' && window.__WT_SESSION_READY__ === true;
      r.request_start_source = wtReady
        ? 'wt_getreader_after_session_ready'
        : 'wt_getreader_session_ready_unknown';
      this._emit(r);
      return;
    }

    if (typeof window !== 'undefined' && window.__EXPERIMENT_MODE__) {
      console.warn(
        '[TileTelemetry] recordFromStream: 缺少 logicRequestStart/firstByteAt/completeAt，已回退到旧 t0/ttfbMs/ttlbMs（与 B1/B2 不可比）'
      );
    }
    const streamStart = t0 != null ? t0 : performance.now();
    r.enqueue_time = rel(streamStart);
    r.req_time = rel(streamStart);
    r.first_byte_time = (ttfbMs != null && ttfbMs >= 0) ? rel(streamStart + ttfbMs) : null;
    r.complete_time = (ttlbMs != null && ttlbMs >= 0) ? rel(streamStart + ttlbMs) : null;
    if (bytes != null) r.bytes = bytes;
    r.request_start_source = 'legacy_stream_ttfb_ms_deprecated';
    this._emit(r);
  }

  _emit(record) {
    const row = this._toExportRow(record);
    if (typeof window !== 'undefined') {
      if (!window.__TILE_TELEMETRY_RECORDS__) window.__TILE_TELEMETRY_RECORDS__ = [];
      window.__TILE_TELEMETRY_RECORDS__.push(row);
    }
  }

  _toExportRow(r) {
    const req = r.req_time;
    const fb = r.first_byte_time;
    const fd = r.first_decodable_byte_time;
    const comp = r.complete_time;
    const ttfb_ms = (req != null && fb != null) ? Math.round((fb - req) * 100) / 100 : null;
    const ttlb_ms = (req != null && comp != null) ? Math.round((comp - req) * 100) / 100 : null;
    const ttfb_strict_ms = ttfb_ms;
    const ttlb_strict_ms = ttlb_ms;
    return {
      ...r,
      ttfb_ms,
      ttlb_ms,
      ttfb_strict_ms,
      ttlb_strict_ms,
      application_request_start_ts: req,
      min_decodable_bytes_threshold: MIN_DECODABLE_PAYLOAD_BYTES
    };
  }

  export() {
    return Array.from(this.records.values()).map(r => this._toExportRow(r));
  }

  exportJSON() {
    return JSON.stringify(this.export(), null, 0);
  }

  exportCSV() {
    const rows = this.export();
    if (rows.length === 0) return '';
    const headers = ['experiment_id', 'run_id', 'baseline_id', 'tile_id', 'lod', 'bytes', 'vpap_score', 'is_critical', 'enqueue_time', 'req_time', 'first_byte_time', 'first_decodable_byte_time', 'complete_time', 'request_start_source', 'ttfb_ms', 'ttlb_ms', 'ttfb_strict_ms', 'ttlb_strict_ms', 'duplicate_count'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      const vals = headers.map(h => {
        const v = r[h];
        if (v === null || v === undefined) return '';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return String(v);
      });
      lines.push(vals.join(','));
    }
    return lines.join('\n');
  }
}

let _defaultLogger = null;

function getTileTelemetryLogger(options) {
  if (options) {
    _defaultLogger = new TileTelemetryLogger(options);
  }
  if (!_defaultLogger) {
    _defaultLogger = new TileTelemetryLogger();
  }
  return _defaultLogger;
}

if (typeof window !== 'undefined') {
  window.TileTelemetry = {
    TileTelemetryLogger,
    getTileTelemetryLogger,
    getTilePosFromHash,
    computeVPAPScore,
    computeIsCritical,
    normalizeTileId,
    normalizeLod,
    normalizeBaselineId,
    MIN_DECODABLE_PAYLOAD_BYTES,
    recordLogicalRequestStart: function (tileId, lod, opt) {
      return getTileTelemetryLogger().recordLogicalRequestStart(tileId, lod, opt || {});
    }
  };
}
