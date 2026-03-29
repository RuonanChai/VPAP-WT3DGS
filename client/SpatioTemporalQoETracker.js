/**
 * Spatio-Temporal Viewport-centric QoE Tracker
 *
 * Legacy: Q_vis(t) on dynamic viewport subset (min(L_load,L_tgt)/L_tgt per tile).
 * Primary (fairness): Q_vis_normalized on fixed __INITIAL_SELECTION__ reference set,
 * U_i = (sum_{l=1..L_tgt} w_l * I_l(t)) / (sum_{l=1..L_tgt} w_l), I_l in {0,1} from TileTelemetry
 * complete_time; w_l default [0.5,0.2,0.15,0.15] for L1..L4 (weak dependency / independent layers).
 * W_i = normalized VPAP over the reference set.
 *
 * Export: legacy q_vis_* + q_vis_normalized_*, t80_ms_normalized (null if never >= 0.8).
 */

(function () {
  'use strict';

  const SAMPLE_INTERVAL_MS = 50;
  // Standardized Multi-term QoE (SIGCOMM/NSDI-ready)
  //
  // IMPORTANT (paper semantics):
  // - Freeze Ratio is a unified client-side interruption metric shared by all four baselines.
  // - Protocol-specific network stall signals are retained only for diagnosis, not for cross-baseline QoE comparison.
  //
  // QoE_Final = Fidelity_Score - Freeze_Penalty - Instability_Penalty
  // Fidelity_Score = (1/T) * ∫ Q_vis_normalized(t) dt,  T=20s
  // Freeze_Penalty = α * (Total_Freeze_Duration / T)
  // Instability_Penalty = β * mean(|ΔQ_vis_norm|)
  // Paper: α=0.2 (3DGS tolerates peripheral blur; focus on Fidelity), β=0.1
  const QOE_WINDOW_S = 15;
  const STALL_ALPHA = 0.2;
  const INSTABILITY_BETA = 0.1;

  // Unified client-side Freeze detection (application-layer interruption)
  // Default parameters (can be overridden via options if needed)
  const FREEZE_MIN_MS = 200;
  const FREEZE_EPS_Q = 0.002;
  const STARTUP_GRACE_MS = 1000;

  const TILE_SIZE = 0.7788;
  const ORIGIN_GRID_X = 524267;
  const ORIGIN_GRID_Z = 524285;

  /** Per-LOD utility weights L1..L4 (independent-layer model; renormalized over 1..L_target per tile). */
  const LOD_LAYER_WEIGHTS = [0.5, 0.2, 0.15, 0.15];

  function normalizeTileId(id) {
    const s = String(id || '').trim();
    if (/^tile_\d+_\d+_\d+$/.test(s)) return s;
    const m = s.match(/tile_(\d+)_(\d+)_(\d+)/);
    return m ? 'tile_' + m[1] + '_' + m[2] + '_' + m[3] : s;
  }

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

  function computeVPAPScore(cameraPos, cameraForward, tilePos) {
    if (!cameraPos || !cameraForward || !tilePos) return 0.5;
    const cx = cameraPos[0] ?? 0, cy = cameraPos[1] ?? 0, cz = cameraPos[2] ?? 0;
    const fx = cameraForward[0] ?? 0, fy = cameraForward[1] ?? 0, fz = cameraForward[2] ?? 0;
    const tx = tilePos.x, ty = tilePos.y, tz = tilePos.z;
    const dx = tx - cx, dy = ty - cy, dz = tz - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) return 1;
    const vx = dx / dist, vy = dy / dist, vz = dz / dist;
    const dot = fx * vx + fy * vy + fz * vz;
    if (dot < 0.5) return 0;
    const scoreView = dot;
    const scoreDist = 1 / (1 + dist / 2000);
    return 0.7 * scoreView + 0.3 * scoreDist;
  }

  function getLodFromWeight(weight) {
    if (weight > 16000) return 4;
    if (weight > 8000) return 3;
    if (weight > 2000) return 2;
    return 1;
  }

  function selectTilesWithWeight(cameraPos, tilesMapping) {
    if (!tilesMapping) return [];
    const tileList = Array.isArray(tilesMapping)
      ? tilesMapping.filter(Boolean)
      : Object.values(tilesMapping).filter(Boolean);
    if (tileList.length === 0) return [];
    const cam = { x: cameraPos[0] || 0, y: cameraPos[1] || 0, z: cameraPos[2] || 0 };
    const tileListWithWeight = [];
    for (const tileHash of tileList) {
      const m = String(tileHash).match(/tile_\d+_(\d+)_(\d+)/);
      if (!m) continue;
      const gx = parseInt(m[1], 10), gz = parseInt(m[2], 10);
      const wx = (gx - ORIGIN_GRID_X) * TILE_SIZE;
      const wz = (gz - ORIGIN_GRID_Z) * TILE_SIZE;
      const dx = cam.x - wx, dy = cam.y - 0, dz = cam.z - wz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let weight = 500;
      if (dist < 500) weight = 20000;
      else if (dist < 1000) weight = 17000;
      else if (dist < 2000) weight = 9000;
      else if (dist < 4000) weight = 3000;
      tileListWithWeight.push({ hash: tileHash, weight, distance: dist });
    }
    tileListWithWeight.sort((a, b) => a.distance - b.distance);
    if (tileListWithWeight.length > 300) tileListWithWeight.length = 300;
    return tileListWithWeight.map(t => ({
      hash: t.hash,
      lod: getLodFromWeight(t.weight),
      weight: t.weight,
      distance: t.distance
    }));
  }

  class SpatioTemporalQoETracker {
    constructor(options) {
      options = options || {};
      this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
      this.qoeWindowS = options.qoeWindowS ?? QOE_WINDOW_S;
      this.stallAlpha = options.stallAlpha ?? STALL_ALPHA;
      this.instabilityBeta = options.instabilityBeta ?? INSTABILITY_BETA;
      this.freezeMinMs = options.freezeMinMs ?? FREEZE_MIN_MS;
      this.freezeEpsQ = options.freezeEpsQ ?? FREEZE_EPS_Q;
      this.startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS;
      const lw = options.lodLayerWeights;
      this.lodLayerWeights = Array.isArray(lw) && lw.length >= 4
        ? lw.slice(0, 4).map(function (x) { return Number(x); })
        : LOD_LAYER_WEIGHTS.slice();
      this.qVisSamples = [];
      this.intervalId = null;
      this.startTime = null;
      this.t0 = null;
      this._referenceSet = null;
      this._referenceTargetLodSummary = null;
      // Stall events: [{start_ms, end_ms, reason?}]
      // If your player already tracks stalls, you can push into window.__STALL_EVENTS__ and we will export it.
      this.stallEvents = [];

      // Freeze detection state (application-layer interruption)
      this._freeze = {
        lastQ: null,
        lastQChangeMs: 0,
        lastContentUpdateMs: 0,
        lastContentSig: null,
        currentStartMs: null,
        events: []
      };
    }

    _getElapsedMsForTelemetry() {
      if (typeof window !== 'undefined' && typeof window.__TELEMETRY_T0__ === 'number') {
        const t0 = Number(window.__TELEMETRY_T0__);
        // Support both clocks:
        // - performance.now() baseline (small ms)
        // - Date.now() baseline (epoch ms)
        if (Number.isFinite(t0) && t0 > 1e12) {
          return Date.now() - t0;
        }
        return performance.now() - t0;
      }
      return Date.now() - this.startTime;
    }

    _getTelemetryRecords() {
      try {
        if (window.TileTelemetry && window.TileTelemetry.getTileTelemetryLogger) {
          const tel = window.TileTelemetry.getTileTelemetryLogger();
          const rows = tel && tel.export && tel.export();
          if (Array.isArray(rows) && rows.length) return rows;
        }
      } catch (_) {}
      const rows2 = window.__TILE_TELEMETRY_RECORDS__ || [];
      return Array.isArray(rows2) ? rows2 : [];
    }

    /** Set of LOD levels l in {1..4} with complete_time <= elapsedMs (TileTelemetry). */
    _getCompletedLodSet(tileId, elapsedMs) {
      const completed = new Set();
      if (!tileId || typeof elapsedMs !== 'number') return completed;
      const tid = normalizeTileId(tileId);
      const rows = this._getTelemetryRecords();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || normalizeTileId(r.tile_id) !== tid) continue;
        const ct = r.complete_time;
        if (typeof ct !== 'number' || ct > elapsedMs) continue;
        let L = parseInt(r.lod, 10);
        if (isNaN(L) || L < 1) L = 1;
        if (L > 4) L = 4;
        completed.add(L);
      }
      return completed;
    }

    /**
     * U_i(t) = (sum_{l=1..L_tgt} w_l * I_l(t)) / (sum_{l=1..L_tgt} w_l), I_l from telemetry completion.
     */
    _getWeightedLodUtility(tileId, elapsedMs, L_target) {
      const Lt = Math.max(1, Math.min(4, parseInt(L_target, 10) || 1));
      const weights = this.lodLayerWeights || LOD_LAYER_WEIGHTS;
      const completed = this._getCompletedLodSet(tileId, elapsedMs);
      let num = 0;
      let den = 0;
      for (let l = 1; l <= Lt; l++) {
        const w = Number(weights[l - 1]);
        if (!isFinite(w) || w <= 0) continue;
        den += w;
        if (completed.has(l)) num += w;
      }
      return den > 1e-12 ? num / den : 0;
    }

    /** Highest L such that LODs 1..L all have complete_time <= elapsedMs (diagnostics / legacy). */
    _getConsecutiveLoadedLod(tileId, elapsedMs) {
      const completed = this._getCompletedLodSet(tileId, elapsedMs);
      let k = 0;
      for (let L = 1; L <= 4; L++) {
        if (completed.has(L)) k = L;
        else break;
      }
      return k;
    }

    _getLoadedLodFromTelemetryMax(tileId, elapsedMs) {
      if (!tileId) return 0;
      const rows = this._getTelemetryRecords();
      let maxLod = 0;
      for (const r of rows) {
        if (!r || normalizeTileId(r.tile_id) !== normalizeTileId(tileId)) continue;
        const ct = r.complete_time;
        if (typeof ct === 'number' && typeof elapsedMs === 'number' && ct <= elapsedMs) {
          const lod = parseInt(r.lod, 10) || 0;
          if (lod > maxLod) maxLod = lod;
        }
      }
      return maxLod;
    }

    _initReferenceSet() {
      this._referenceSet = [];
      this._referenceTargetLodSummary = {};
      const init = typeof window !== 'undefined' && window.__INITIAL_SELECTION__;
      if (!Array.isArray(init) || init.length === 0) {
        console.warn('[SpatioTemporalQoE] __INITIAL_SELECTION__ missing; q_vis_normalized uses empty reference.');
        return;
      }
      for (let i = 0; i < init.length; i++) {
        const e = init[i];
        const tile_id = e.tile_id || e.hash;
        if (!tile_id) continue;
        const L_target = Math.max(1, Math.min(4, parseInt(e.lod, 10) || 1));
        this._referenceSet.push({ tile_id: String(tile_id), L_target: L_target });
        const k = 'L' + L_target;
        this._referenceTargetLodSummary[k] = (this._referenceTargetLodSummary[k] || 0) + 1;
      }
      console.log('[SpatioTemporalQoE] Reference tiles:', this._referenceSet.length, 'L_target summary:', JSON.stringify(this._referenceTargetLodSummary));
    }

    _getCameraBasis() {
      const v = window.viewer;
      if (!v || !v.slm2Loader) return null;
      const loader = v.slm2Loader;
      let cameraPos, cameraForward;
      if (loader.rootScene && loader.rootScene.matrixWorld) {
        const inverseRoot = loader.rootScene.matrixWorld.clone().invert();
        const localPos = v.activeCamera.position.clone().applyMatrix4(inverseRoot);
        cameraPos = [localPos.x, localPos.y, localPos.z];
        const localTarget = v.controls.target.clone().applyMatrix4(inverseRoot);
        const fwd = localTarget.sub(localPos).normalize();
        cameraForward = [fwd.x, fwd.y, fwd.z];
      } else {
        cameraPos = [v.activeCamera.position.x, v.activeCamera.position.y, v.activeCamera.position.z];
        const tx = v.controls.target.x - v.activeCamera.position.x;
        const ty = v.controls.target.y - v.activeCamera.position.y;
        const tz = v.controls.target.z - v.activeCamera.position.z;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
        cameraForward = len > 1e-6 ? [tx / len, ty / len, tz / len] : [0, 0, -1];
      }
      return { cameraPos, cameraForward };
    }

    getViewerSnapshot() {
      const v = window.viewer;
      if (!v || !v.slm2Loader) return null;
      const loader = v.slm2Loader;
      const cacheMgr = loader.modelCacheMgr;
      const tilesMapping = loader.tilesMapping;
      if (!tilesMapping || !cacheMgr || !cacheMgr.objectsPool_GS) return null;

      let cameraPos, cameraForward;
      if (loader.rootScene && loader.rootScene.matrixWorld) {
        const inverseRoot = loader.rootScene.matrixWorld.clone().invert();
        const localPos = v.activeCamera.position.clone().applyMatrix4(inverseRoot);
        cameraPos = [localPos.x, localPos.y, localPos.z];
        const localTarget = v.controls.target.clone().applyMatrix4(inverseRoot);
        const fwd = localTarget.sub(localPos).normalize();
        cameraForward = [fwd.x, fwd.y, fwd.z];
      } else {
        cameraPos = [v.activeCamera.position.x, v.activeCamera.position.y, v.activeCamera.position.z];
        const tx = v.controls.target.x - v.activeCamera.position.x;
        const ty = v.controls.target.y - v.activeCamera.position.y;
        const tz = v.controls.target.z - v.activeCamera.position.z;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
        cameraForward = len > 1e-6 ? [tx / len, ty / len, tz / len] : [0, 0, -1];
      }

      const selectedTiles = selectTilesWithWeight(cameraPos, tilesMapping);
      const objectsPool = cacheMgr.objectsPool_GS;
      const viewportTiles = [];
      let vpapTotal = 0;
      const vpapScores = [];

      for (const t of selectedTiles) {
        const tilePos = getTilePosFromHash(t.hash);
        const vpap = computeVPAPScore(cameraPos, cameraForward, tilePos);
        vpapScores.push({ hash: t.hash, vpap, targetLod: t.lod });
        vpapTotal += vpap;
      }
      const elapsedMs = this._getElapsedMsForTelemetry();

      for (let i = 0; i < selectedTiles.length; i++) {
        const t = selectedTiles[i];
        const obj = objectsPool[t.hash];
        let loadedLod = obj ? (obj.lodLevel || 0) : 0;
        if (!loadedLod) {
          loadedLod = this._getLoadedLodFromTelemetryMax(t.hash, elapsedMs);
        }
        const targetLod = t.lod;
        const vpap = vpapScores[i].vpap;
        const wi = vpapTotal > 0 ? vpap / vpapTotal : 1 / selectedTiles.length;
        viewportTiles.push({ hash: t.hash, loadedLod, targetLod, wi, vpap });
      }
      return { cameraPos, cameraForward, viewportTiles };
    }

    computeQvis(snapshot) {
      if (!snapshot || !snapshot.viewportTiles.length) return 0;
      let qVis = 0;
      for (const t of snapshot.viewportTiles) {
        const L_i = Math.max(0, t.loadedLod);
        const L_target = Math.max(1, t.targetLod);
        const U_i = Math.min(L_i, L_target) / L_target;
        qVis += t.wi * U_i;
      }
      return qVis;
    }

    computeQvisNormalized(elapsedMs) {
      if (!this._referenceSet || this._referenceSet.length === 0) return 0;
      const cam = this._getCameraBasis();
      if (!cam) return 0;
      const n = this._referenceSet.length;
      const raw = [];
      let s = 0;
      for (let i = 0; i < n; i++) {
        const ref = this._referenceSet[i];
        const tilePos = getTilePosFromHash(ref.tile_id);
        const vpap = tilePos ? computeVPAPScore(cam.cameraPos, cam.cameraForward, tilePos) : 0;
        raw.push(vpap);
        s += vpap;
      }
      const denom = s > 1e-9 ? s : n;
      let q = 0;
      for (let i = 0; i < n; i++) {
        const Wi = s > 1e-9 ? raw[i] / s : 1 / n;
        const ref = this._referenceSet[i];
        const Ui = this._getWeightedLodUtility(ref.tile_id, elapsedMs, ref.L_target);
        q += Wi * Math.max(0, Math.min(1, Ui));
      }
      return q;
    }

    sample() {
      const elapsed_ms = this._getElapsedMsForTelemetry();
      const snapshot = this.getViewerSnapshot();
      let q_vis = 0;
      if (snapshot) q_vis = this.computeQvis(snapshot);
      const q_vis_normalized = this.computeQvisNormalized(elapsed_ms);
      const t_k = this.t0 ? performance.now() - this.t0 : 0;
      this.qVisSamples.push({
        t_k: t_k,
        q_vis: q_vis,
        q_vis_normalized: q_vis_normalized,
        elapsed_ms: elapsed_ms
      });

      // -------- Unified Freeze detection (client-side) --------
      // We treat "visible content updated" as reference-set render-ready progress derived from TileTelemetry:
      // any increase in (count_loaded_L1, sum_ref_weighted_utility) indicates new content entering the scene.
      this._freezeTick(elapsed_ms, q_vis_normalized);
    }

    /** Center-weighted: avoid penalizing VPAP when only edge tiles are pending. */
    _getReferenceContentSignature(elapsedMs, centerOnly = false) {
      const ref = this._referenceSet || [];
      if (!ref.length) return { loaded_l1: 0, sum_ui: 0 };
      let tiles = ref;
      if (centerOnly && ref.length > 30) {
        const cam = this._getCameraBasis();
        if (cam) {
          const scored = ref.map((r) => {
            const tilePos = getTilePosFromHash(r.tile_id);
            const vpap = tilePos ? computeVPAPScore(cam.cameraPos, cam.cameraForward, tilePos) : 0;
            return { ...r, vpap };
          });
          scored.sort((a, b) => (b.vpap || 0) - (a.vpap || 0));
          tiles = scored.slice(0, 30);
        }
      }
      let loadedL1 = 0;
      let sumUi = 0;
      for (let i = 0; i < tiles.length; i++) {
        const tid = tiles[i].tile_id;
        const L_tgt = Math.max(1, Math.min(4, parseInt(tiles[i].L_target, 10) || 1));
        const completed = this._getCompletedLodSet(tid, elapsedMs);
        if (completed.has(1)) loadedL1 += 1;
        sumUi += this._getWeightedLodUtility(tid, elapsedMs, L_tgt);
      }
      return { loaded_l1: loadedL1, sum_ui: sumUi, center_count: tiles.length };
    }

    _freezeTick(elapsedMs, qVisNorm) {
      const st = this._freeze;
      if (!st) return;
      if (typeof elapsedMs !== 'number' || elapsedMs < 0) return;

      // Initialize times
      if (st.lastQChangeMs === 0 && elapsedMs > 0) st.lastQChangeMs = elapsedMs;
      if (st.lastContentUpdateMs === 0 && elapsedMs > 0) st.lastContentUpdateMs = elapsedMs;

      // Startup grace period
      if (elapsedMs < (Number(this.startupGraceMs) || STARTUP_GRACE_MS)) {
        st.lastQ = qVisNorm;
        st.lastQChangeMs = elapsedMs;
        st.lastContentUpdateMs = elapsedMs;
        st.lastContentSig = this._getReferenceContentSignature(elapsedMs, true);
        if (st.currentStartMs != null) st.currentStartMs = null;
        return;
      }
      // Only count freeze after minimum fidelity (avoid "initialization" as stall)
      const minFidelityForFreeze = 0.2;
      if (typeof qVisNorm === 'number' && qVisNorm < minFidelityForFreeze) {
        st.lastQ = qVisNorm;
        st.lastQChangeMs = elapsedMs;
        st.lastContentUpdateMs = elapsedMs;
        st.lastContentSig = this._getReferenceContentSignature(elapsedMs, true);
        if (st.currentStartMs != null) st.currentStartMs = null;
        return;
      }

      // Q change
      if (st.lastQ == null) {
        st.lastQ = qVisNorm;
        st.lastQChangeMs = elapsedMs;
      } else if (typeof qVisNorm === 'number' && Math.abs(qVisNorm - st.lastQ) > (Number(this.freezeEpsQ) || FREEZE_EPS_Q)) {
        st.lastQ = qVisNorm;
        st.lastQChangeMs = elapsedMs;
      }

      // Visible content update: center-weighted (avoid penalizing VPAP edge delay)
      const sig = this._getReferenceContentSignature(elapsedMs, true);
      const centerCount = sig.center_count || 30;
      // Center survival complete: all center tiles have L1 -> don't count freeze for "waiting for edge"
      // B4 的 VPAP 会先发中心、后发边缘；中心完成后等待边缘不应算 Freeze
      if (sig.loaded_l1 >= centerCount) {
        st.lastContentUpdateMs = elapsedMs;
        st.lastContentSig = sig;
      } else if (st.lastContentSig == null) {
        st.lastContentSig = sig;
        st.lastContentUpdateMs = elapsedMs;
      } else {
        const prev = st.lastContentSig;
        const prevSum = typeof prev.sum_ui === 'number' ? prev.sum_ui : prev.sum_lod;
        const curSum = typeof sig.sum_ui === 'number' ? sig.sum_ui : sig.sum_lod;
        if ((sig.loaded_l1 > prev.loaded_l1) || (typeof curSum === 'number' && typeof prevSum === 'number' && curSum > prevSum + 1e-9)) {
          st.lastContentUpdateMs = elapsedMs;
        }
        st.lastContentSig = sig;
      }

      const minMs = Number(this.freezeMinMs) || FREEZE_MIN_MS;
      const qStalled = (elapsedMs - st.lastQChangeMs) >= minMs;
      const contentStalled = (elapsedMs - st.lastContentUpdateMs) >= minMs;
      const isFreeze = qStalled && contentStalled;

      if (isFreeze) {
        if (st.currentStartMs == null) st.currentStartMs = elapsedMs;
      } else {
        if (st.currentStartMs != null) {
          const dur = elapsedMs - st.currentStartMs;
          if (dur >= minMs) {
            st.events.push({
              start_ms: st.currentStartMs,
              end_ms: elapsedMs,
              duration_ms: dur,
              reason: 'qvis_stalled'
            });
          }
          st.currentStartMs = null;
        }
      }
    }

    /**
     * Optional API for runtime stall tracking.
     * - startStall(reason): opens a stall event (end_ms filled on endStall)
     * - endStall(): closes the latest open event
     *
     * Note: We DO NOT force q_vis to 0 during stalls. Penalty is computed independently.
     */
    startStall(reason) {
      const nowMs = this._getElapsedMsForTelemetry();
      this.stallEvents.push({ start_ms: nowMs, end_ms: null, reason: reason || null });
    }

    endStall() {
      const nowMs = this._getElapsedMsForTelemetry();
      for (let i = this.stallEvents.length - 1; i >= 0; i--) {
        const e = this.stallEvents[i];
        if (e && typeof e.start_ms === 'number' && e.end_ms == null) {
          e.end_ms = nowMs;
          return;
        }
      }
      console.warn('[SpatioTemporalQoE] endStall() called without open stall event.');
    }

    start() {
      if (this.intervalId) return;
      this.qVisSamples = [];
      this.stallEvents = [];
      this.startTime = Date.now();
      this.t0 = window.__TELEMETRY_T0__
        ? performance.now() - (Date.now() - window.__TELEMETRY_T0__)
        : performance.now();
      this._initReferenceSet();
      this.intervalId = setInterval(() => this.sample(), this.sampleIntervalMs);
      console.log('[SpatioTemporalQoE] Started tracking, sample interval:', this.sampleIntervalMs, 'ms');
    }

    stop() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      console.log('[SpatioTemporalQoE] Stopped, samples:', this.qVisSamples.length);
    }

    compute() {
      const K = this.qVisSamples.length;
      const empty = {
        q_vis_avg: 0,
        p_def: 1,
        // Legacy fields kept for backward-compat consumers. They are no longer used for scoring.
        t_80_ms: null,
        qoe: 0,
        q_vis_timeseries: [],
        sample_count: 0,
        q_vis_legacy_note: 'legacy: dynamic viewport tile set; min(loaded,maxLOD)/target per tile — do NOT use for cross-baseline scoring',
        q_vis_normalized_definition:
          'reference set: U_i = sum_l=1..L_tgt(w_l*I_l)/sum_l=1..L_tgt(w_l) from TileTelemetry; Wi = VPAP; default w=[0.5,0.2,0.15,0.15] for L1..L4',
        q_vis_normalized_timeseries: [],
        q_vis_normalized_avg: 0,
        // Standardized QoE terms
        qoe_window_s: this.qoeWindowS,
        fidelity_score: 0,
        // Unified interruption metric (Freeze) for cross-baseline comparison
        freeze_events: [],
        total_freeze_duration_ms: 0,
        freeze_ratio: 0,
        freeze_event_count: 0,
        freeze_penalty_alpha: this.stallAlpha,
        freeze_penalty: 0,
        // Keep stall_events for diagnosis only (not used by QoE_Final)
        stall_events: [],
        total_stall_duration_s: 0,
        instability_beta: this.instabilityBeta,
        instability: 0,
        instability_penalty: 0,
        qoe_final: 0,
        reference_tile_count: this._referenceSet ? this._referenceSet.length : 0,
        reference_target_lod_summary: this._referenceTargetLodSummary || {}
      };
      if (K === 0) {
        return empty;
      }

      const qVisAvg = this.qVisSamples.reduce((a, x) => a + x.q_vis, 0) / K;
      const pDef = 1 - qVisAvg;

      const qNormAvg = this.qVisSamples.reduce((a, x) => a + x.q_vis_normalized, 0) / K;

      // -------- Standardized QoE (time in seconds) --------
      const T = Math.max(0.001, Number(this.qoeWindowS) || QOE_WINDOW_S);
      const windowEndMs = T * 1000;

      // Fidelity_Score = (1/T) * integral_0^T q_vis_normalized(t) dt
      let fidelity = 0;
      let auc = 0;
      let prev = null;
      let prevT = null;
      let samplesInWindow = 0;
      for (let i = 0; i < this.qVisSamples.length; i++) {
        const s = this.qVisSamples[i];
        const tMs = typeof s.elapsed_ms === 'number' ? s.elapsed_ms : null;
        const q = typeof s.q_vis_normalized === 'number' ? s.q_vis_normalized : null;
        if (tMs == null || q == null) continue;
        if (tMs < 0) continue;
        if (tMs > windowEndMs) break;
        if (prev != null && prevT != null && tMs > prevT) {
          auc += ((prev + q) / 2) * ((tMs - prevT) / 1000);
        }
        prev = q;
        prevT = tMs;
        samplesInWindow++;
      }
      if (samplesInWindow === 0) {
        console.warn('[SpatioTemporalQoE] Warning: q_vis_normalized_timeseries missing/empty; Fidelity defaults to 0.');
        fidelity = 0;
      } else {
        // If last sample before T, we intentionally do not extrapolate beyond last sample.
        fidelity = auc / T;
      }

      // -------- Freeze (unified interruption) --------
      // Ensure last freeze event is closed at window end.
      const freezeEvents = Array.isArray(this._freeze?.events) ? [...this._freeze.events] : [];
      const curStart = this._freeze?.currentStartMs;
      if (typeof curStart === 'number' && curStart >= 0 && curStart < windowEndMs) {
        const end = windowEndMs;
        const dur = end - curStart;
        const minMs = Number(this.freezeMinMs) || FREEZE_MIN_MS;
        if (dur >= minMs) {
          freezeEvents.push({ start_ms: curStart, end_ms: end, duration_ms: dur, reason: 'qvis_stalled' });
        }
      }
      let freezeTotalMs = 0;
      for (const e of freezeEvents) {
        if (!e) continue;
        const d = e.duration_ms;
        if (typeof d === 'number' && d > 0) freezeTotalMs += d;
      }
      freezeTotalMs = Math.max(0, Math.min(windowEndMs, freezeTotalMs));
      const freezeRatio = Math.min(1, Math.max(0, freezeTotalMs / windowEndMs));
      const freezePenalty = (Number(this.stallAlpha) || STALL_ALPHA) * freezeRatio;

      // -------- Stall events (diagnosis only) --------
      // We keep exporting this if present, but it does NOT affect QoE_Final.
      const exportedStallsRaw = (typeof window !== 'undefined' && Array.isArray(window.__STALL_EVENTS__) && window.__STALL_EVENTS__.length)
        ? window.__STALL_EVENTS__
        : this.stallEvents;
      const stallEvents = [];
      let stallTotalS = 0;
      if (Array.isArray(exportedStallsRaw)) {
        for (const e of exportedStallsRaw) {
          if (!e) continue;
          const startMs = (typeof e.start_ms === 'number') ? e.start_ms : (typeof e.start === 'number' ? e.start : null);
          const endMs = (typeof e.end_ms === 'number') ? e.end_ms : (typeof e.end === 'number' ? e.end : null);
          if (startMs == null) continue;
          const endMs2 = (endMs == null) ? windowEndMs : endMs;
          const a = Math.max(0, Math.min(windowEndMs, startMs));
          const b = Math.max(0, Math.min(windowEndMs, endMs2));
          if (b <= a) continue;
          stallEvents.push({
            start_s: a / 1000,
            end_s: b / 1000,
            duration_s: (b - a) / 1000,
            reason: e.reason || null
          });
          stallTotalS += (b - a) / 1000;
        }
      }

      // Instability = mean absolute delta of q_vis_normalized within window
      let instability = 0;
      let nDiff = 0;
      let lastQ = null;
      for (let i = 0; i < this.qVisSamples.length; i++) {
        const s = this.qVisSamples[i];
        const tMs = typeof s.elapsed_ms === 'number' ? s.elapsed_ms : null;
        const q = typeof s.q_vis_normalized === 'number' ? s.q_vis_normalized : null;
        if (tMs == null || q == null) continue;
        if (tMs < 0) continue;
        if (tMs > windowEndMs) break;
        if (lastQ != null) {
          instability += Math.abs(q - lastQ);
          nDiff++;
        }
        lastQ = q;
      }
      if (nDiff === 0) {
        console.warn('[SpatioTemporalQoE] Warning: insufficient q_vis_normalized samples for instability; Instability defaults to 0.');
        instability = 0;
      } else {
        instability = instability / nDiff;
      }
      const instabilityPenalty = (Number(this.instabilityBeta) || INSTABILITY_BETA) * instability;

      const qoeFinal = fidelity - freezePenalty - instabilityPenalty;

      return {
        q_vis_avg: qVisAvg,
        p_def: pDef,
        // Keep legacy field names for consumers, but qoe now maps to QoE_Final.
        t_80_ms: null,
        qoe: qoeFinal,
        q_vis_timeseries: this.qVisSamples.map(s => ({ t_ms: s.elapsed_ms, q_vis: s.q_vis })),
        sample_count: K,
        q_vis_legacy_note: 'legacy: dynamic viewport tile set — use q_vis_normalized_* for cross-baseline comparison',
        q_vis_normalized_definition:
          'reference set: U_i = sum_l=1..L_tgt(w_l*I_l)/sum_l=1..L_tgt(w_l) from TileTelemetry; Wi = VPAP; default w=[0.5,0.2,0.15,0.15] for L1..L4',
        q_vis_normalized_timeseries: this.qVisSamples.map(s => ({
          t_ms: s.elapsed_ms,
          q_vis_normalized: s.q_vis_normalized
        })),
        q_vis_normalized_avg: qNormAvg,
        // Standardized QoE terms (seconds-based)
        qoe_window_s: T,
        fidelity_score: fidelity,
        freeze_events: freezeEvents,
        total_freeze_duration_ms: freezeTotalMs,
        freeze_ratio: freezeRatio,
        freeze_event_count: freezeEvents.length,
        freeze_penalty_alpha: (Number(this.stallAlpha) || STALL_ALPHA),
        freeze_penalty: freezePenalty,
        // diagnosis-only
        stall_events: stallEvents,
        total_stall_duration_s: stallTotalS,
        instability_beta: (Number(this.instabilityBeta) || INSTABILITY_BETA),
        instability: instability,
        instability_penalty: instabilityPenalty,
        qoe_final: qoeFinal,
        reference_tile_count: this._referenceSet ? this._referenceSet.length : 0,
        reference_target_lod_summary: this._referenceTargetLodSummary || {}
      };
    }

    export() {
      const result = this.compute();
      this.stop();
      return result;
    }
  }

  window.SpatioTemporalQoETracker = SpatioTemporalQoETracker;
  console.log('[SpatioTemporalQoE] Tracker class registered');
})();
