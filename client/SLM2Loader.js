import {
  PerspectiveCamera,
  Object3D,
  Matrix4,
  FileLoader,
  FloatType,
  ImageBitmapLoader,
  Vector3, // coordinate transforms
} from 'three';

import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';


import { CacheMgr } from './CacheMgr.js';
import { Vector2 } from 'three';


import { SplatLoader } from '../splats/loaders/SplatLoader.ts';
import { GSTask } from './CacheMgr.js';

export class SLM2Loader 
{
  constructor () 
  {
    this.sceneConfig = null;

    this.isSceneInitialized = false;

    this.resourcesBaseUrl = null;
    this.rcServerAddress = null;
    this.schedulingStrategy = 'auto';

    this.modelToLoadList = [];
    this.modelIsLoading = false;

    this.modelCacheMgr = new CacheMgr({sceneMgr: this});

    this.clientWidth = 800;
    this.clientHeight = 600;

    this.DebugMode = false;

    this.MeshLodLevel = 0; // -1: raw, >= 0: LODi

    //TODO: Async image loading:
    // https://stackoverflow.com/questions/67775759/cant-use-three-js-texture-loader-in-javascript-worker
    this.textureLoader = new ImageBitmapLoader();//TextureLoader();
    this.exrLoader = new EXRLoader().setDataType(FloatType);
    this.hdrjpgLoader = null;

    this.loadedTextures = {};

    this.rvCameraHash = null;

    this.tilesMapping = null;
    this.modelToLoadList_GS = {};
    this.loadingTaskList_GS = [];
    this.tileIsLoading = false;
    this.GSLoaderCount = 16; // concurrent GS decode workers

    // Throttle WebTransport tile completion -> addObject_GS to reduce main-thread long tasks / GC stalls
    this._wtAddObjectInFlight = 0;
    this._wtAddObjectMaxInFlight = Math.max(2, Math.floor(this.GSLoaderCount / 4));
    this._wtAddObjectWaiters = [];

    // WebTransport client state
    this.wt = null;
    this.wtStreamWriter = null;
    this.wtStreamReader = null;
    this.requestId = 0;
    
    // Process each WT tile immediately (lower latency than batching draws)
  }

  _wtAcquireAddObjectSlot() {
    if (this._wtAddObjectInFlight < this._wtAddObjectMaxInFlight) {
      this._wtAddObjectInFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._wtAddObjectWaiters.push(resolve);
    }).then(() => {
      this._wtAddObjectInFlight++;
    });
  }

  _wtReleaseAddObjectSlot() {
    this._wtAddObjectInFlight = Math.max(0, this._wtAddObjectInFlight - 1);
    const next = this._wtAddObjectWaiters.shift();
    if (next) next();
  }

  async _wtAddObject_GS_throttled(task, buffer) {
    if (!buffer || !task) return;
    await this._wtAcquireAddObjectSlot();
    try {
      this.modelCacheMgr.addObject_GS(task, buffer);
    } finally {
      this._wtReleaseAddObjectSlot();
    }
  }

  getMaterials()
  {
    var mtls = [];

    if (this.sceneConfig && this.sceneConfig.materials)
    {
      for (var key in this.sceneConfig.materials.data)
      {
        var item = this.sceneConfig.materials.data[key];

        for (var _key in item)
        {
          var _item = item[_key];

          mtls.push(_item.material);
        };
      };
    }

    return mtls;
  }


  update(dt, time)
  {
    if (this.isSceneInitialized == false)
    {
      return;
    }

    this.updateLoading(dt);

    // this.modelCacheMgr.update(time);
    // this.modelCacheMgr.update_GS(time);

    this.syncCamera();
  }

  syncCamera()
  {
    this.backCamera.position.copy(this.activeCamera.position);
    this.backCamera.rotation.copy(this.activeCamera.rotation);

    this.backCamera.updateMatrixWorld();
    
    // B4 local RVC: client-side tile + LOD selection (no WT server scheduling)
    if (this.useLocalRVC) {
      this.sceneCullingLocal();
      return;
    }
    // WebTransport (B3/B4): stream camera updates to server
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      this.sceneCullingWebTransport();
    }
  }

  getLoadingTaskList()
  {
    return this.loadingTaskList_GS;
  }

  /**
   * B4 local RVC: distance-based tile + LOD without server-side selection.
   */
  sceneCullingLocal() {
    if (!this.tilesMapping || !this.rootScene) return;

    const posHashResolution = 1;
    const cameraPosHash = (this.activeCamera.position.x * posHashResolution).toFixed(0) + "-" +
      (this.activeCamera.position.y * posHashResolution).toFixed(0) + "-" +
      (this.activeCamera.position.z * posHashResolution).toFixed(0);
    if (this._localRvcLastHash === cameraPosHash) return;
    this._localRvcLastHash = cameraPosHash;

    const tileList = Object.values(this.tilesMapping).filter(Boolean);
    if (tileList.length === 0) return;

    const cameraWorldPos = this.activeCamera.position.clone();
    if (this.rootScene && this.rootScene.matrixWorld) {
      const inverseRoot = this.rootScene.matrixWorld.clone().invert();
      cameraWorldPos.applyMatrix4(inverseRoot);
    }
    const cam = { x: cameraWorldPos.x, y: cameraWorldPos.y, z: cameraWorldPos.z };

    const TILE_SIZE = 0.7788;
    const ORIGIN_GRID_X = 524267;
    const ORIGIN_GRID_Z = 524285;
    const MAX_VISIBLE = 300;

    const tileListWithWeight = [];
    for (const tileHash of tileList) {
      const m = String(tileHash).match(/tile_\d+_(\d+)_(\d+)/);
      if (!m) continue;
      const gx = parseInt(m[1], 10);
      const gz = parseInt(m[2], 10);
      const wx = (gx - ORIGIN_GRID_X) * TILE_SIZE;
      const wz = (gz - ORIGIN_GRID_Z) * TILE_SIZE;
      const wy = 0;
      const dx = cam.x - wx;
      const dy = cam.y - wy;
      const dz = cam.z - wz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let weight = 500;
      if (dist < 500) weight = 20000;
      else if (dist < 1000) weight = 17000;
      else if (dist < 2000) weight = 9000;
      else if (dist < 4000) weight = 3000;
      tileListWithWeight.push({ hash: tileHash, weight, distance: dist });
    }
    tileListWithWeight.sort((a, b) => a.distance - b.distance);
    if (tileListWithWeight.length > MAX_VISIBLE) tileListWithWeight.length = MAX_VISIBLE;

    const tileListOut = tileListWithWeight.map(t => t.hash);
    const weightListOut = tileListWithWeight.map(t => t.weight);
    this.generateLoadingTasks_GS(tileListOut, weightListOut);
  }

  sceneCulling() 
  {
    // WebTransport scheduling path
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      this.sceneCullingWebTransport();
      return;
    }

    // HTTP/1.1 WebSocket path
    if(!this.ws){
      return;
    }
    if(this.ws.readyState == WebSocket.CLOSED){
      this.startConnect();
      return;
    }
    if(this.ws.readyState != WebSocket.OPEN)
    {
      return;
    }

    if (this.isSceneInitialized == false)
    {
      return;
    }

    if (this.lastCameraPosHash == undefined)
    {
      this.lastCameraPosHash = null;
      this.lastCameraRotHash = null;
      this.lastScreenSizeHash = null;
    }

    var posHashResolution = 1;
    var rotHashResolution = 5;
    var cameraPosHash = (this.activeCamera.position.x * posHashResolution).toFixed(0) + "-" + 
                        (this.activeCamera.position.y * posHashResolution).toFixed(0) + "-" + 
                        (this.activeCamera.position.z * posHashResolution).toFixed(0);
    var cameraRotHash = (this.activeCamera.rotation.x * rotHashResolution).toFixed(0) + "-" + 
                        (this.activeCamera.rotation.y * rotHashResolution).toFixed(0) + "-" +
                        (this.activeCamera.rotation.z * rotHashResolution).toFixed(0);

    var screenSizeHash = this.clientWidth + "-" + this.clientHeight;
    if (
        // this.disableCameraHash ||
        (cameraPosHash != this.lastCameraPosHash ||
        cameraRotHash != this.lastCameraRotHash ||
        screenSizeHash != this.lastScreenSizeHash) || 
        this.requestId < 2 // force two updates at startup
        )
    {
      
      this.lastCameraPosHash = cameraPosHash;
      this.lastCameraRotHash = cameraRotHash;
      this.lastScreenSizeHash = screenSizeHash;

      const viewMatrix = this.backCamera.matrixWorldInverse;
      const projectionMatrix = this.backCamera.projectionMatrix;
      const mvpMatrix = new Matrix4();
      mvpMatrix.multiplyMatrices(projectionMatrix, viewMatrix);

      const rootMatrix = this.rootScene.matrixWorld;

      mvpMatrix.multiply(rootMatrix);

      let mvp = [];

      mvpMatrix.elements.map(value => {
          mvp.push(value);
      });

      // Widen viewport slightly to reduce popping when the camera moves
      var CameraFrameUpscale = 1.2;
      var clientWidth = Math.round(this.clientWidth * CameraFrameUpscale);
      var clientHeight = Math.round(this.clientHeight * CameraFrameUpscale);

      if(!clientWidth > 0 || !clientHeight > 0)
      {
        return;
      }

      var newCameraHash = cameraPosHash + ':' + cameraRotHash;

      const localCameraPosB1 = new Vector3();
      localCameraPosB1.copy(this.activeCamera.position);
      const invRootB1 =
        this.rootScene && this.rootScene.matrixWorld ? this.rootScene.matrixWorld.clone().invert() : null;
      if (invRootB1) localCameraPosB1.applyMatrix4(invRootB1);

      let camera_data = {
          "type": 0,
          "id": this.requestId,
          "mvp": mvp,
          "width": clientWidth, 
          "height": clientHeight,
          "cull": 0,
          "hash": (this.rvCameraHash == null ? '0' : newCameraHash),
          "cameraPos": [localCameraPosB1.x, localCameraPosB1.y, localCameraPosB1.z],
      };

      // Update with new hash
      this.rvCameraHash = newCameraHash;

      this.ws.send(JSON.stringify(camera_data));

      // this.requestMap[camera_data.id] = {
      //   "start": new Date().getTime(),
      //   "foi_received": 0,
      //   "foi_sent": 0,
      //   "end": 0
      // }

      this.requestId++;
    }
  }

  // WebTransport: send camera pose (same payload shape as HTTP/1.1 WebSocket path)
  sceneCullingWebTransport() {
    if (!this.wt || !this.wtStreamWriter || !this.connected) {
      return;
    }

    if (this.isSceneInitialized == false) {
      return;
    }

    if (this.lastCameraPosHash == undefined) {
      this.lastCameraPosHash = null;
      this.lastCameraRotHash = null;
      this.lastScreenSizeHash = null;
    }

    // Same hash quantization as HTTP/1.1 path
    var posHashResolution = 1;
    var rotHashResolution = 5;
    var cameraPosHash = (this.activeCamera.position.x * posHashResolution).toFixed(0) + "-" + 
                        (this.activeCamera.position.y * posHashResolution).toFixed(0) + "-" + 
                        (this.activeCamera.position.z * posHashResolution).toFixed(0);
    var cameraRotHash = (this.activeCamera.rotation.x * rotHashResolution).toFixed(0) + "-" + 
                        (this.activeCamera.rotation.y * rotHashResolution).toFixed(0) + "-" +
                        (this.activeCamera.rotation.z * rotHashResolution).toFixed(0);

    var screenSizeHash = this.clientWidth + "-" + this.clientHeight;
    if (
        // this.disableCameraHash ||
        (cameraPosHash != this.lastCameraPosHash ||
        cameraRotHash != this.lastCameraRotHash ||
        screenSizeHash != this.lastScreenSizeHash) || 
        this.requestId < 2 // force two updates at startup
        )
    {
      
      this.lastCameraPosHash = cameraPosHash;
      this.lastCameraRotHash = cameraRotHash;
      this.lastScreenSizeHash = screenSizeHash;

      // Compute MVP (kept consistent with HTTP/1.1 client)
      if (this.rootScene) {
        this.rootScene.updateMatrixWorld(true);
      }
      
      const viewMatrix = this.backCamera.matrixWorldInverse;
      const projectionMatrix = this.backCamera.projectionMatrix;
      const mvpMatrix = new Matrix4();
      mvpMatrix.multiplyMatrices(projectionMatrix, viewMatrix);

      const rootMatrix = this.rootScene ? this.rootScene.matrixWorld : new Matrix4();
      mvpMatrix.multiply(rootMatrix);
      
      // Debug: log rootScene transform once
      if (!this._rootSceneDebugged && this.rootScene) {
        console.log('[SLM2Loader] rootScene transform:', {
          rotation: [
            (this.rootScene.rotation.x * 180 / Math.PI).toFixed(2),
            (this.rootScene.rotation.y * 180 / Math.PI).toFixed(2),
            (this.rootScene.rotation.z * 180 / Math.PI).toFixed(2)
          ],
          scale: [this.rootScene.scale.x.toFixed(2), this.rootScene.scale.y.toFixed(2), this.rootScene.scale.z.toFixed(2)],
          position: [this.rootScene.position.x.toFixed(2), this.rootScene.position.y.toFixed(2), this.rootScene.position.z.toFixed(2)]
        });
        this._rootSceneDebugged = true;
      }

      let mvp = [];
      mvpMatrix.elements.map(value => {
          mvp.push(value);
      });

      // Viewport upscale (same as HTTP/1.1)
      var CameraFrameUpscale = 1.2;
      var clientWidth = Math.round(this.clientWidth * CameraFrameUpscale);
      var clientHeight = Math.round(this.clientHeight * CameraFrameUpscale);

      if(!clientWidth > 0 || !clientHeight > 0)
      {
        return;
      }

      var newCameraHash = cameraPosHash + ':' + cameraRotHash;
      
      // World camera position -> rootScene local space
      const localCameraPos = new Vector3();
      localCameraPos.copy(this.activeCamera.position);
      const inverseRootMatrix = this.rootScene && this.rootScene.matrixWorld ? this.rootScene.matrixWorld.clone().invert() : null;
      if (inverseRootMatrix) {
        localCameraPos.applyMatrix4(inverseRootMatrix);
      }
      
      // VPAP: forward in same local frame as cameraPos
      const localCameraForward = new Vector3();
      if (this.controls && this.controls.target) {
        const localTarget = this.controls.target.clone();
        if (inverseRootMatrix) localTarget.applyMatrix4(inverseRootMatrix);
        localCameraForward.subVectors(localTarget, localCameraPos).normalize();
      } else {
        this.activeCamera.getWorldDirection(localCameraForward);
        if (inverseRootMatrix) localCameraForward.transformDirection(inverseRootMatrix);
      }
      
      // Debug: log coordinate transform once
      if (!this._cameraCoordConverted) {
        console.log('[SLM2Loader] camera coord transform:', {
          worldPos: [
            this.activeCamera.position.x.toFixed(2),
            this.activeCamera.position.y.toFixed(2),
            this.activeCamera.position.z.toFixed(2)
          ],
          localPos: [
            localCameraPos.x.toFixed(2),
            localCameraPos.y.toFixed(2),
            localCameraPos.z.toFixed(2)
          ],
          rootSceneScale: this.rootScene ? [
            this.rootScene.scale.x.toFixed(2),
            this.rootScene.scale.y.toFixed(2),
            this.rootScene.scale.z.toFixed(2)
          ] : 'N/A',
          rootSceneRotation: this.rootScene ? [
            (this.rootScene.rotation.x * 180 / Math.PI).toFixed(2),
            (this.rootScene.rotation.y * 180 / Math.PI).toFixed(2),
            (this.rootScene.rotation.z * 180 / Math.PI).toFixed(2)
          ] : 'N/A'
        });
        this._cameraCoordConverted = true;
      }
      
      // Telemetry: camera for VPAP in receiveTileStreams
      this._telemetryCameraPos = [localCameraPos.x, localCameraPos.y, localCameraPos.z];
      this._telemetryCameraForward = [localCameraForward.x, localCameraForward.y, localCameraForward.z];

      // B4 VPAP needs cameraForward
      let camera_data = {
          "type": 0,
          "id": this.requestId,
          "mvp": mvp,
          "width": clientWidth, 
          "height": clientHeight,
          "cull": 0,
          "hash": (this.rvCameraHash == null ? '0' : newCameraHash),
          "cameraPos": [localCameraPos.x, localCameraPos.y, localCameraPos.z],
          "cameraForward": [localCameraForward.x, localCameraForward.y, localCameraForward.z]
      };

      this.rvCameraHash = newCameraHash;

      try {
        const encoder = new TextEncoder();
        const dataToSend = JSON.stringify(camera_data) + '\n';
        console.log(`[SLM2Loader] sending camera pose (requestId: ${this.requestId}):`, {
          cameraPos: camera_data.cameraPos,
          id: camera_data.id,
          cameraPosStr: `[${camera_data.cameraPos[0]?.toFixed(2)}, ${camera_data.cameraPos[1]?.toFixed(2)}, ${camera_data.cameraPos[2]?.toFixed(2)}]`
        });
        this.wtStreamWriter.write(encoder.encode(dataToSend)).catch(e => {
          console.error('[SLM2Loader] failed to send camera pose:', e);
        });
        this._lastCameraPoseSendTime = performance.now();
      } catch (error) {
        console.error('[SLM2Loader] failed to send camera pose:', error);
      }

      this.requestId++;
    }
  }




  startConnect()
  {
    var scope = this;

    this.loadingTimescale = 1;

    this.requestId = 0;
    this.requestMap = {};

    // WebTransport URL
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      this.startConnectWebTransport();
      return;
    }

    // HTTP/1.1 WebSocket path
    this.server_ip = this.rcServerAddress;//'ws://127.0.0.1:5600';

    this.ws = new WebSocket(this.server_ip)
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = (evt) => {
      scope.connected = true
        console.log("rc server connect succeed")
    }
    this.ws.onclose = (evt) => 
    {
      scope.connected = false;
      console.log('onclose');
    }

    this.ws.onmessage = function (event) 
    {
      const arrayBuffer = event.data;
      const dataView = new DataView(arrayBuffer);
      const decoder = new TextDecoder('utf-8');
      const jsonString = decoder.decode(dataView);
      const jsonObject = JSON.parse(jsonString);
      const modelList = JSON.parse(jsonObject.list);
      const weightList = JSON.parse(jsonObject.weight);
      
      // scope.requestMap[jsonObject.id].foi_received = jsonObject.start;
      // scope.requestMap[jsonObject.id].foi_sent = jsonObject.end;
      // scope.requestMap[jsonObject.id].end = new Date().getTime();

      const tileList = modelList.map(id => scope.tilesMapping[id]);
      // if(weightList[0] < 500){
      //   scope.rootScene.visible = false;
      // }else{
      //   scope.rootScene.visible = true;
      // }

      // scope.refreshLoadingTask_GS(tileList, weightList);
      scope.generateLoadingTasks_GS(tileList, weightList);

      // if (scope.cullingCallback)
      // {
      //   scope.cullingCallback(modelList, weightList);

      //   scope.cullingCallback = null;
      // }
      // else
      // {
      //   scope.refreshLoadingTask(modelList, weightList);
      // }

      if (scope.DebugMode) console.time('loading');
    };
  }

  // WebTransport session
  async startConnectWebTransport() {
    var scope = this;

    if (!this.rcServerAddress || !this.rcServerAddress.startsWith('webtransport://')) {
      console.error('[SLM2Loader] Invalid WebTransport URL:', this.rcServerAddress);
      return;
    }

    // Browser API expects https://
    const wtUrl = this.rcServerAddress.replace('webtransport://', 'https://');

    try {
      console.log('[SLM2Loader] WebTransport connecting:', wtUrl);
      this.wt = new WebTransport(wtUrl);
      
      await this.wt.ready;
      this.connected = true;
      this._lastCameraPoseSendTime = performance.now();
      if (typeof window !== 'undefined') {
        window.__WT_SESSION_READY__ = true;
        window.__WT_SESSION_READY_AT__ = performance.now();
      }
      console.log('[SLM2Loader] WebTransport connected');

      console.log('[SLM2Loader] creating bidirectional stream for camera pose...');
      const bidirectionalStream = await this.wt.createBidirectionalStream();
      console.log('[SLM2Loader] bidirectional stream ready');
      this.wtStreamWriter = bidirectionalStream.writable.getWriter();
      console.log('[SLM2Loader] bidirectional stream writer acquired');

      // Incoming tile streams
      this.receiveTileStreams();

      this.wt.closed.then(() => {
        console.log('[SLM2Loader] WebTransport closed');
        this.connected = false;
      }).catch(error => {
        console.error('[SLM2Loader] WebTransport error:', error);
        this.connected = false;
      });

    } catch (error) {
      console.error('[SLM2Loader] WebTransport connect failed:', error);
      this.connected = false;
      if (typeof window !== 'undefined') {
        window.__WT_SESSION_READY__ = false;
      }
    }
  }

  // Consume unidirectional tile streams from server
  async receiveTileStreams() {
    var scope = this;

    if (!this.wt) return;

    // Stats: tiles received in first 5s
    if (!this._initialTileStats) {
      this._initialTileStats = {
        startTime: Date.now(),
        lodCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
        totalCount: 0
      };
      setTimeout(() => {
        console.log('[SLM2Loader] initial tile stats (first 5s):', {
          total: scope._initialTileStats.totalCount,
          lodCounts: scope._initialTileStats.lodCounts,
          lodDistribution: {
            LOD1: ((scope._initialTileStats.lodCounts[1] / scope._initialTileStats.totalCount) * 100).toFixed(1) + '%',
            LOD2: ((scope._initialTileStats.lodCounts[2] / scope._initialTileStats.totalCount) * 100).toFixed(1) + '%',
            LOD3: ((scope._initialTileStats.lodCounts[3] / scope._initialTileStats.totalCount) * 100).toFixed(1) + '%',
            LOD4: ((scope._initialTileStats.lodCounts[4] / scope._initialTileStats.totalCount) * 100).toFixed(1) + '%'
          }
        });
      }, 5000);
    }
    
    // Cumulative receive stats (vs server push count)
    if (!this._totalReceiveStats) {
      this._totalReceiveStats = {
        startTime: Date.now(),
        lodCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
        totalCount: 0,
        receivedTiles: new Set() // dedupe by tile+LOD key
      };
    }

    try {
      const streamReader = this.wt.incomingUnidirectionalStreams.getReader();

      while (true) {
        const { done, value: stream } = await streamReader.read();
        if (done) break;

        // Process each stream asynchronously so the reader loop stays responsive
        Promise.resolve().then(async () => {
          // Fairness: logic_request_start aligned with B1/B2 (before consuming the stream)
          const logicRequestStart = performance.now();
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          let textBuffer = new Uint8Array(0);
          let metadata = null;
          let binaryChunks = [];
          let metadataRead = false;
          let firstByteAt = null;
          let firstDecodableAt = null;
          const markDecodable = () => {
            if (firstDecodableAt != null) return;
            let sum = 0;
            for (let i = 0; i < binaryChunks.length; i++) sum += binaryChunks[i].length;
            if (sum >= 256) firstDecodableAt = performance.now();
          };

          while (true) {
            const { done: streamDone, value: chunk } = await reader.read();
            if (firstByteAt === null && chunk && chunk.length > 0) {
              firstByteAt = performance.now();
            }
            if (streamDone) {
              const completeAt = performance.now();
              // Flush trailing binary on stream end
              if (metadata && binaryChunks.length > 0) {
                const totalSize = binaryChunks.reduce((sum, c) => sum + c.length, 0);
                const tileData = new Uint8Array(totalSize);
                let offset = 0;
                for (const c of binaryChunks) {
                  tileData.set(c, offset);
                  offset += c.length;
                }
                
                // GSTask-compatible task object
                const task = {
                  hash: metadata.hash,
                  targetLOD: metadata.lod,
                  loadingLOD: metadata.lod,
                  url: '', // not used for WebTransport
                  weight: metadata.weight || 0
                };
                
                if (tileData.buffer && tileData.buffer.byteLength > 0) {
                  const fbAt = firstByteAt != null ? firstByteAt : logicRequestStart;
                  const ttfbFair = fbAt - logicRequestStart;
                  const ttlbFair = completeAt - logicRequestStart;
                  if (typeof window.__RECORD_TILE_TTFB_TTLB__ === 'function') {
                    window.__RECORD_TILE_TTFB_TTLB__(Math.max(0, ttfbFair), Math.max(0, ttlbFair), metadata.hash || '');
                  }
                  // B3/B4 TileTelemetry: TTFB = first_byte - logic_request_start (same as B1/B2)
                  if (window.__EXPERIMENT_MODE__ && window.TileTelemetry) {
                    const tel = window.TileTelemetry.getTileTelemetryLogger();
                    let camPos = scope._telemetryCameraPos;
                    let camFwd = scope._telemetryCameraForward;
                    if (!camPos && scope.activeCamera && scope.rootScene) {
                      const p = scope.activeCamera.position.clone();
                      p.applyMatrix4(scope.rootScene.matrixWorld.clone().invert());
                      camPos = [p.x, p.y, p.z];
                      if (scope.controls && scope.controls.target) {
                        const f = scope.controls.target.clone().sub(scope.activeCamera.position).normalize();
                        f.transformDirection(scope.rootScene.matrixWorld.clone().invert());
                        camFwd = [f.x, f.y, f.z];
                      }
                    }
                    tel.recordFromStream(metadata.hash, metadata.lod || 1, {
                      bytes: tileData.length,
                      logicRequestStart,
                      firstByteAt: fbAt,
                      firstDecodableByteAt: firstDecodableAt != null ? firstDecodableAt : undefined,
                      completeAt,
                      cameraPos: camPos,
                      cameraForward: camFwd
                    });
                  }
                  await scope._wtAddObject_GS_throttled(task, tileData.buffer);
                  
                  // Initial-window stats
                  const elapsed = Date.now() - scope._initialTileStats.startTime;
                  if (elapsed < 5000) {
                    scope._initialTileStats.totalCount++;
                    const lod = metadata.lod || 1;
                    scope._initialTileStats.lodCounts[lod] = (scope._initialTileStats.lodCounts[lod] || 0) + 1;
                  }
                  
                  // Cumulative stats
                  if (scope._totalReceiveStats) {
                    scope._totalReceiveStats.totalCount++;
                    const lod = metadata.lod || 1;
                    scope._totalReceiveStats.lodCounts[lod] = (scope._totalReceiveStats.lodCounts[lod] || 0) + 1;
                    scope._totalReceiveStats.receivedTiles.add(`${metadata.hash}-L${lod}`);
                    if (!scope._totalReceiveStats.receivedTileIds) scope._totalReceiveStats.receivedTileIds = new Set();
                    scope._totalReceiveStats.receivedTileIds.add(metadata.hash);
                    // Fairness: unique tile ids (one count per tile, not per LOD)
                    if (window.__EXPERIMENT_MODE__) {
                      window.__WEBTRANSPORT_LOADED_COUNT__ = scope._totalReceiveStats.receivedTileIds.size;
                    }
                  }
                  
                  console.log(`[SLM2Loader] ✅ Received tile ${metadata.hash} L${metadata.lod} (${tileData.length} bytes)`);
                } else {
                  console.error(`[SLM2Loader] ❌ Invalid tile data for ${metadata.hash}: buffer is null or empty`);
                }
              }
              break;
            }

            if (!metadataRead) {
              // Append chunk to text buffer until newline
              const newBuffer = new Uint8Array(textBuffer.length + chunk.length);
              newBuffer.set(textBuffer, 0);
              newBuffer.set(chunk, textBuffer.length);
              textBuffer = newBuffer;

              // Find newline (0x0A)
              let newlineIndex = -1;
              for (let i = 0; i < textBuffer.length; i++) {
                if (textBuffer[i] === 0x0A) {
                  newlineIndex = i;
                  break;
                }
              }

              if (newlineIndex !== -1) {
                // Parse JSON metadata line
                const metadataBytes = textBuffer.slice(0, newlineIndex);
                const metadataText = decoder.decode(metadataBytes);
                metadata = JSON.parse(metadataText);
                metadataRead = true;

                // Bytes after newline are tile payload
                if (textBuffer.length > newlineIndex + 1) {
                  const binaryStart = textBuffer.slice(newlineIndex + 1);
                  binaryChunks.push(binaryStart);
                  markDecodable();
                }
                textBuffer = new Uint8Array(0);
              }
            } else {
              // Binary tile chunks
              binaryChunks.push(chunk);
              markDecodable();
            }
          }
        }).catch(error => {
          console.error('[SLM2Loader] tile stream handler error:', error);
        });
      }
      
      // Drain any legacy batch queue if present
      if (this.tileBatchQueue.length > 0) {
        this.processTileBatch();
      }
    } catch (error) {
      console.error('[SLM2Loader] receiveTileStreams error:', error);
    }
    
    // Periodic cumulative stats (every 10s)
    if (this._totalReceiveStats) {
      setInterval(() => {
        const stats = this._totalReceiveStats;
        const elapsed = (Date.now() - stats.startTime) / 1000;
        const tilesPerSecond = (stats.totalCount / elapsed).toFixed(1);
        console.log(`[SLM2Loader] receive stats (${elapsed.toFixed(1)}s uptime):`, {
          total: stats.totalCount,
          uniqueTiles: stats.receivedTiles.size,
          lodCounts: stats.lodCounts,
          tilesPerSecond: tilesPerSecond,
          lodDistribution: {
            L1: ((stats.lodCounts[1] / stats.totalCount) * 100).toFixed(1) + '%',
            L2: ((stats.lodCounts[2] / stats.totalCount) * 100).toFixed(1) + '%',
            L3: ((stats.lodCounts[3] / stats.totalCount) * 100).toFixed(1) + '%',
            L4: ((stats.lodCounts[4] / stats.totalCount) * 100).toFixed(1) + '%'
          }
        });
      }, 10000);
    }
  }

  updateLoading(dt)
  {
    if (this.debugLoadingMode)
    {
      this.processLoadingList();
    }
    else
    {
      if (this.cullingUpdateDelta == undefined)
      {
        this.cullingUpdateDelta = 1000;
      }
      // Culling tick: 40ms (was 80ms) for snappier updates
      if (this.cullingUpdateDelta > 40)
      {
        if (this.useLocalRVC) {
          this.sceneCullingLocal();
        } else {
          this.sceneCulling();
        }
        this.cullingUpdateDelta = 0;
      }
  
      this.cullingUpdateDelta += dt;

      // this.processLoadingList();
      // this.processLoadingList_GS();
      this.processLoadingTasks_GS();
    }
  }




  setSize(clientWidth, clientHeight)
  {
    this.clientWidth = clientWidth;
    this.clientHeight = clientHeight;

    this.backCamera.aspect = clientWidth / clientHeight;
    this.backCamera.updateProjectionMatrix();

    this.screenPixelReciprocal = 1.0 / (this.clientWidth * this.clientHeight);
  }

  getRVCServerUrl(sceneName, callback)
  {
    var scope = this;
    // Use load balancer only when lbServer is non-empty
    if (this.lbServer != undefined && this.lbServer != null && this.lbServer.trim() !== '')
    {
      var requestOptions = {
        method: 'GET',
        redirect: 'follow'
      };
      
      var lbsURL = this.lbServer + "/getRVC?scene=" + sceneName;
      console.log(lbsURL);
      fetch(lbsURL, requestOptions)
        .then(response => {
          if (response.status != 200)
          {
            throw new Error('LB Server no response!');
          }
          else
          {
            return response.text();
          }
        })
        .then(result => {
          if (result == undefined)
          {
            throw new Error('No avilable rvc candiate!');
          }
          var rtData = JSON.parse(result);
          if (rtData.data != null && rtData.data.url != null)
          {
            scope.rcServerAddress = rtData.data.url;
            console.log('new rc url: ' + scope.rcServerAddress);

            if (callback)
            {
              callback();
            }
          }
          else
          {
            throw new Error('No valid rvc url!');
          }
        })
        .catch(error => {
          console.log(error)
          if (callback)
          {
            callback();
          }
        });
    }
    else
    {
      // No LB: use rcServerAddress from config
      if (callback)
      {
        callback();
      }
    }
  }

  load(baseConfig, renderer, camera, options, callback)
  {
    this.resourcesBaseUrl = baseConfig.loader.resourcesBaseUrl;
    this.resourcesWS = baseConfig.loader.resourcesWS;
    this.rcServerAddress = baseConfig.loader.rcServerAddress;
    this.schedulingStrategy = baseConfig.loader.schedulingStrategy;
    this.lbServer = baseConfig.lbServer;
    this.gsResource = baseConfig.loader.gsResource;
    // B4 local RVC: client-side tile+LOD when true
    this.useLocalRVC = baseConfig.loader.useLocalRVC === true;

    this.modelCacheMgr.setSchedulingStrategy(this.schedulingStrategy);

    this.options = options;

    this.renderer = renderer;
  
    const backFov = camera.fov * 1.1;
    this.backCamera = new PerspectiveCamera(backFov, camera.aspect, camera.near, camera.far);
    this.activeCamera = camera;
    this.syncCamera();

    var initalSize = new Vector2();
    this.renderer.getSize(initalSize);
    this.setSize(initalSize.x, initalSize.y);

    var scope = this;
    // Load scene config and tile mapping, then connect
    var sceneConfigPromise = new Promise((resolve, reject) => {
      var fileLoader = new FileLoader();
      fileLoader.load(this.resourcesBaseUrl + "/sceneWeb.json", function(data) {
        scope.sceneConfig = JSON.parse(data);

        if (callback) {
          callback(scope.sceneConfig.config);
        }
        scope.isSceneInitialized = true;
        resolve();

      }, undefined, function(error) {
        console.error('Failed to load sceneWeb.json:', error);
        reject(error);
      });
    });

    var tilesMappingPromise = new Promise((resolve, reject) => {
      var fileLoader = new FileLoader();
      fileLoader.load("assets/custom_bounding_boxes_mapping-campus2.json", (data) => {
        scope.tilesMapping = JSON.parse(data);
        resolve();
      }, undefined, (error) => {
        console.error('Failed to load custom_bounding_boxes_mapping-campus2.json:', error);
        reject(error);
      });
    });

    Promise.all([sceneConfigPromise, tilesMappingPromise]).then(() => {
      if (scope.useLocalRVC) {
        console.log('[SLM2Loader] B4 local RVC: distance-based tile + LOD');
        scope.sceneCullingLocal();
      } else {
        scope.getRVCServerUrl(baseConfig.name, function() {
          scope.startConnect();
        });
      }
    }).catch((error) => {
      console.error('Scene init or tilesMapping failed; cannot connect:', error);
    });

    this.rootScene = new Object3D();
    // No root rotation
    this.rootScene.rotation.x = 0;
    // Flip X so B1–B4 match reference campus orientation
    this.rootScene.scale.set(-100, -100, 100);
    // World matrix must be current before camera/local transforms
    this.rootScene.updateMatrixWorld(true);

    this.initLoad();

    return this.rootScene;
  }


  async processLoadedTask_GS(task, buffer){
    // Single throttle for HTTP, local RVC, and WebTransport addObject_GS paths
    await this._wtAddObject_GS_throttled(task, buffer);
    return buffer;
  }

  processLoadingTasks_GS()
  {
    var scope = this;
    if (this.loadingTaskList_GS.length == 0 ||
      scope.GSLoaderCount <= 0)
    {
      return;
    }

    // Queue order preserves high-LOD-first (list built L4->L1)
    while (scope.GSLoaderCount > 0 && this.loadingTaskList_GS.length > 0)
    {
      let nextTask = this.loadingTaskList_GS.shift();

      const newTask = new Promise((resolve, reject) => 
        {
            new SplatLoader().load(nextTask.url, (buffer) => 
          {
            scope
              .processLoadedTask_GS(nextTask, buffer)
              .then(() => resolve(buffer))
              .catch(() => resolve(buffer));

          }, null, function(err)
          {
            console.error(err);
            resolve();
          });
        });

        newTask.then(() => {
          scope.GSLoaderCount += nextTask.loadingLOD;
        });

        scope.GSLoaderCount -= nextTask.loadingLOD;
    }

  }

  initLoad()
  {
    // B4: sceneCullingLocal drives loads; no JSON preload
    if (this.useLocalRVC) {
      this.modelToLoadList_GS = { tileList: [], weightList: [] };
      return;
    }
    // B3 WebTransport: server pushes tiles; skip modelToLoadList_GS.json
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      console.log('[SLM2Loader] WebTransport: skipping initLoad, waiting for server tiles');
      this.modelToLoadList_GS = { tileList: [], weightList: [] };
      return;
    }

    // HTTP/1.1: load modelToLoadList_GS.json from assets
    const scope = this;
    const fileLoader = new FileLoader();
    // Full URL from resourcesBaseUrl when set
    const modelListUrl = this.resourcesBaseUrl ? 
      (this.resourcesBaseUrl.endsWith('/') ? this.resourcesBaseUrl : this.resourcesBaseUrl + '/') + 'modelToLoadList_GS.json' :
      'assets/modelToLoadList_GS.json';
    fileLoader.load(modelListUrl, function(data) {
      try {
        let modelToLoadList_GS = JSON.parse(data);
        const tileList = modelToLoadList_GS.tileList;
        const weightList = modelToLoadList_GS.weightList;
        scope.generateLoadingTasks_GS(tileList, weightList);
      } catch (e) {
        console.error('Failed to parse modelToLoadList_GS.json:', e);
        scope.modelToLoadList_GS = { tileList: [], weightList: [] };
      }
    }, undefined, function(err) {
      console.error('Failed to load modelToLoadList_GS.json:', err);
      scope.modelToLoadList_GS = { tileList: [], weightList: [] };
    });

  }

  refreshLoadingTask_GS(tileList, weightList)
  {
    this.modelToLoadList_GS = {
      tileList: tileList,
      weightList: weightList
    }
  }

  getLoadingTaskList_GS()
  {
     const dataStr = JSON.stringify(this.modelToLoadList_GS, null, 2);
     const blob = new Blob([dataStr], { type: "application/json" });
     const url = URL.createObjectURL(blob);
     const a = document.createElement('a');
     a.href = url;
     a.download = 'modelToLoadList_GS.json';
     document.body.appendChild(a);
     a.click();
     document.body.removeChild(a);
     URL.revokeObjectURL(url);
  }

  generateLoadingTasks_GS(tileList, weightList)
  {
    // B3 WT: visibility only; local RVC over HTTP still fetches splats
    if (!this.useLocalRVC && (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://')))) {
      // Refresh visibility only (no HTTP fetch tasks)
      this.modelCacheMgr.refreshVisible_GS(tileList, weightList);
      this.loadingTaskList_GS = [];
      return;
    }

    // HTTP/1.1: build fetch tasks
    let loadingTaskList = [[],[],[],[]];
    for (var tIdx = tileList.length - 1; tIdx >= 0; tIdx--)
    {
      const tile_hash = tileList[tIdx];
      const tile_weight = weightList[tIdx];
      const targerLOD = this.getLodFromWeight(tile_weight);
      const neededLODs = this.modelCacheMgr.tryCacheHit_GS(tile_hash, targerLOD, this.rootScene);
      for (let i = 0; i < neededLODs.length; i++) {
        const loadingLOD = neededLODs[i];
        const url = this.gsResource + loadingLOD + "/" + tile_hash + "-L" + loadingLOD + ".splat";
        // const url = "http://localhost:8082/L" + loadingLOD + "/" + tile_hash + "-L" + loadingLOD + ".splat";
        loadingTaskList[4-loadingLOD].push(new GSTask(tile_hash, targerLOD, loadingLOD, url, tile_weight));
      }
    }

    this.modelCacheMgr.refreshVisible_GS(tileList, weightList);
    this.loadingTaskList_GS = loadingTaskList.flat();
  }

  getLodFromWeight(weight) {
    // Weight thresholds match HTTP/1.1 server mapping L1–L4
    if (weight > 16000) {
      return 4;
    } else if (weight > 8000) {
      return 3;
    } else if (weight > 2000) {
      return 2;
    } else {
      return 1;
    }
  }

}