import {
  PerspectiveCamera,
  Object3D,
  Matrix4,
  FileLoader,
  FloatType,
  ImageBitmapLoader,
  Vector3, // 🔥 添加 Vector3 用于坐标转换
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
    this.GSLoaderCount = 16; // 🔥 优化：增加并发加载数量，从8提升到16，加快初始加载速度

    // 🔥 任务1：WebTransport 流消费节流（限制同时触发 addObject_GS 的并发数）
    // 目标：避免大量 tile stream 在同一时刻完成后，短时间内并发触发 CacheMgr/GaussianSplattingMesh 合成，
    // 从而造成主线程长任务与 QoE/fidelity “平顶”。
    this._wtAddObjectInFlight = 0;
    // 降低 addObject_GS 同时在主线程合成的并发，减少 Long Tasks/GC 抖动导致的 tile 处理排队
    this._wtAddObjectMaxInFlight = Math.max(2, Math.floor(this.GSLoaderCount / 4));
    this._wtAddObjectWaiters = [];

    // WebTransport 相关属性
    this.wt = null;
    this.wtStreamWriter = null;
    this.wtStreamReader = null;
    this.requestId = 0;
    
    // 🔥 移除批量处理：立即处理 tile，利用 WebTransport 的并发优势
    // 批量渲染虽然可以减少渲染调用，但引入了延迟，导致感觉更慢
    // 改为立即处理，每个 tile 独立处理，不阻塞
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
    
    // 🔥 B4 本地 RVC：按远近选 tile + 定 LOD，不依赖 WebTransport 服务器
    if (this.useLocalRVC) {
      this.sceneCullingLocal();
      return;
    }
    // WebTransport 模式（B3 全部加载）：持续检测相机变化并发送更新
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      this.sceneCullingWebTransport();
    }
  }

  getLoadingTaskList()
  {
    return this.loadingTaskList_GS;
  }

  /**
   * B4 本地 RVC：按相机到 tile 的距离选 tile + 定 LOD，不依赖外部服务器
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
    // 检测 WebTransport 模式
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      this.sceneCullingWebTransport();
      return;
    }

    // HTTP1.1 版本的 WebSocket 逻辑
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
        this.requestId < 2 // 初始阶段强制刷新两次
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

      // 创建一个 Matrix4 对象
      let mvp = [];

      // 遍历 elements 数组，将每个元素精度转换成两位小数
      mvpMatrix.elements.map(value => {
          mvp.push(value); // 保留两位小数，并将字符串转换回数字
      });

      // 放大视口，以便获得更为富裕的可见集合，在摄像机转动时减少构件缺失
      var CameraFrameUpscale = 1.2;
      var clientWidth = Math.round(this.clientWidth * CameraFrameUpscale);
      var clientHeight = Math.round(this.clientHeight * CameraFrameUpscale);

      if(!clientWidth > 0 || !clientHeight > 0)
      {
        return;
      }

      var newCameraHash = cameraPosHash + ':' + cameraRotHash;
      let camera_data = {
          "type": 0,
          "id": this.requestId,
          "mvp": mvp,
          "width": clientWidth, 
          "height": clientHeight,
          "cull": 0, // 0: no cull, 1: front cull, 2: back cull
          "hash": (this.rvCameraHash == null ? '0' : newCameraHash)
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

  // WebTransport 模式：发送相机数据（完全按照 HTTP1.1 版本的逻辑）
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

    // HTTP1.1 版本的精度阈值
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
        this.requestId < 2 // 初始阶段强制刷新两次
        )
    {
      
      this.lastCameraPosHash = cameraPosHash;
      this.lastCameraRotHash = cameraRotHash;
      this.lastScreenSizeHash = screenSizeHash;

      // HTTP1.1 版本：计算 MVP 矩阵（虽然服务器可能不使用，但保持一致性）
      // 🔥 确保 rootScene 的矩阵已更新
      if (this.rootScene) {
        this.rootScene.updateMatrixWorld(true);
      }
      
      const viewMatrix = this.backCamera.matrixWorldInverse;
      const projectionMatrix = this.backCamera.projectionMatrix;
      const mvpMatrix = new Matrix4();
      mvpMatrix.multiplyMatrices(projectionMatrix, viewMatrix);

      const rootMatrix = this.rootScene ? this.rootScene.matrixWorld : new Matrix4();
      mvpMatrix.multiply(rootMatrix);
      
      // 🔥 调试：输出 rootScene 的变换信息（仅在首次调用时）
      if (!this._rootSceneDebugged && this.rootScene) {
        console.log('[SLM2Loader] 🔍 rootScene 变换信息:', {
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

      // HTTP1.1 版本的视口放大
      var CameraFrameUpscale = 1.2;
      var clientWidth = Math.round(this.clientWidth * CameraFrameUpscale);
      var clientHeight = Math.round(this.clientHeight * CameraFrameUpscale);

      if(!clientWidth > 0 || !clientHeight > 0)
      {
        return;
      }

      var newCameraHash = cameraPosHash + ':' + cameraRotHash;
      
      // 🔥🔥🔥 [关键修复] 将相机世界坐标转换为 rootScene 的局部坐标 🔥🔥🔥
      const localCameraPos = new Vector3();
      localCameraPos.copy(this.activeCamera.position);
      const inverseRootMatrix = this.rootScene && this.rootScene.matrixWorld ? this.rootScene.matrixWorld.clone().invert() : null;
      if (inverseRootMatrix) {
        localCameraPos.applyMatrix4(inverseRootMatrix);
      }
      
      // 🔥 VPAP：相机正前方方向向量（与 cameraPos 同一局部坐标系）
      const localCameraForward = new Vector3();
      if (this.controls && this.controls.target) {
        const localTarget = this.controls.target.clone();
        if (inverseRootMatrix) localTarget.applyMatrix4(inverseRootMatrix);
        localCameraForward.subVectors(localTarget, localCameraPos).normalize();
      } else {
        this.activeCamera.getWorldDirection(localCameraForward);
        if (inverseRootMatrix) localCameraForward.transformDirection(inverseRootMatrix);
      }
      
      // 🔥 调试：输出坐标转换信息（仅在首次调用时）
      if (!this._cameraCoordConverted) {
        console.log('[SLM2Loader] 🔍 相机坐标转换:', {
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
      
      // 🔥 B3/B4 埋点：存储当前相机供 receiveTileStreams 计算 VPAP
      this._telemetryCameraPos = [localCameraPos.x, localCameraPos.y, localCameraPos.z];
      this._telemetryCameraForward = [localCameraForward.x, localCameraForward.y, localCameraForward.z];

      // 发送相机数据（B4 VPAP 需要 cameraForward）
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
        console.log(`📤 [SLM2Loader] 发送相机数据 (requestId: ${this.requestId}):`, {
          cameraPos: camera_data.cameraPos,
          id: camera_data.id,
          cameraPosStr: `[${camera_data.cameraPos[0]?.toFixed(2)}, ${camera_data.cameraPos[1]?.toFixed(2)}, ${camera_data.cameraPos[2]?.toFixed(2)}]`
        });
        this.wtStreamWriter.write(encoder.encode(dataToSend)).catch(e => {
          console.error('[SLM2Loader] ❌ 发送相机数据失败:', e);
        });
        this._lastCameraPoseSendTime = performance.now();
      } catch (error) {
        console.error('[SLM2Loader] ❌ 发送相机数据失败:', error);
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

    // 检测 WebTransport URL
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      this.startConnectWebTransport();
      return;
    }

    // HTTP1.1 版本的 WebSocket 逻辑
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
      const decoder = new TextDecoder('utf-8'); // 假设数据是以UTF-8编码的
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

  // WebTransport 连接
  async startConnectWebTransport() {
    var scope = this;

    if (!this.rcServerAddress || !this.rcServerAddress.startsWith('webtransport://')) {
      console.error('[SLM2Loader] Invalid WebTransport URL:', this.rcServerAddress);
      return;
    }

    // 将 webtransport:// 转换为 https://
    const wtUrl = this.rcServerAddress.replace('webtransport://', 'https://');

    try {
      console.log('[SLM2Loader] 🔵 WebTransport: 尝试连接', wtUrl);
      this.wt = new WebTransport(wtUrl);
      
      await this.wt.ready;
      this.connected = true;
      this._lastCameraPoseSendTime = performance.now();
      if (typeof window !== 'undefined') {
        window.__WT_SESSION_READY__ = true;
        window.__WT_SESSION_READY_AT__ = performance.now();
      }
      console.log('[SLM2Loader] ✅ WebTransport 连接成功');

      // 创建双向流用于发送相机数据
      console.log('[SLM2Loader] 🔵 创建双向流用于发送相机数据...');
      const bidirectionalStream = await this.wt.createBidirectionalStream();
      console.log('[SLM2Loader] ✅ 双向流创建成功');
      this.wtStreamWriter = bidirectionalStream.writable.getWriter();
      console.log('[SLM2Loader] ✅ 双向流 writer 已获取');

      // 开始接收 tile stream
      this.receiveTileStreams();

      // 监听连接关闭
      this.wt.closed.then(() => {
        console.log('[SLM2Loader] 🔴 WebTransport 连接关闭');
        this.connected = false;
      }).catch(error => {
        console.error('[SLM2Loader] ❌ WebTransport 连接错误:', error);
        this.connected = false;
      });

    } catch (error) {
      console.error('[SLM2Loader] ❌ WebTransport 连接失败:', error);
      this.connected = false;
      if (typeof window !== 'undefined') {
        window.__WT_SESSION_READY__ = false;
      }
    }
  }

  // 接收 WebTransport tile stream
  async receiveTileStreams() {
    var scope = this;

    if (!this.wt) return;

    // 🔥 统计初始 tile 接收情况
    if (!this._initialTileStats) {
      this._initialTileStats = {
        startTime: Date.now(),
        lodCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
        totalCount: 0
      };
      // 5秒后输出统计信息
      setTimeout(() => {
        console.log('[SLM2Loader] 📊 初始 tile 接收统计 (前5秒):', {
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
    
    // 🔥 完整接收统计（用于对比服务器推送数量）
    if (!this._totalReceiveStats) {
      this._totalReceiveStats = {
        startTime: Date.now(),
        lodCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
        totalCount: 0,
        receivedTiles: new Set() // 记录已接收的tile hash（去重）
      };
    }

    try {
      const streamReader = this.wt.incomingUnidirectionalStreams.getReader();

      while (true) {
        const { done, value: stream } = await streamReader.read();
        if (done) break;

        // 🔥 优化：立即异步处理 stream，不阻塞读取循环
        // 使用 Promise.resolve().then() 确保异步执行，不阻塞主循环
        Promise.resolve().then(async () => {
          // 公平性：T_logic_request_start —— 与 B1/B2 在 fetch 前 recordReq 对齐；此处为开始消费该 WT stream 之前（等价于「调用底层接收接口」前）
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
              // 流结束时处理剩余数据
              if (metadata && binaryChunks.length > 0) {
                const totalSize = binaryChunks.reduce((sum, c) => sum + c.length, 0);
                const tileData = new Uint8Array(totalSize);
                let offset = 0;
                for (const c of binaryChunks) {
                  tileData.set(c, offset);
                  offset += c.length;
                }
                
                // 创建正确的 task 对象格式（与 GSTask 一致）
                const task = {
                  hash: metadata.hash,
                  targetLOD: metadata.lod,
                  loadingLOD: metadata.lod,
                  url: '', // WebTransport 模式下不需要 URL
                  weight: metadata.weight || 0
                };
                
                if (tileData.buffer && tileData.buffer.byteLength > 0) {
                  const fbAt = firstByteAt != null ? firstByteAt : logicRequestStart;
                  const ttfbFair = fbAt - logicRequestStart;
                  const ttlbFair = completeAt - logicRequestStart;
                  if (typeof window.__RECORD_TILE_TTFB_TTLB__ === 'function') {
                    window.__RECORD_TILE_TTFB_TTLB__(Math.max(0, ttfbFair), Math.max(0, ttlbFair), metadata.hash || '');
                  }
                  // B3/B4：TileTelemetry 使用与 B1/B2 相同的 TTFB 定义 —— first_byte - logic_request_start
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
                  // 🔥 优化：立即处理，不使用批量队列（减少延迟）
                  // 批量渲染虽然可以减少渲染调用，但引入了延迟，导致感觉更慢
                  // 改为立即处理，利用 WebTransport 的并发优势
                  await scope._wtAddObject_GS_throttled(task, tileData.buffer);
                  
                  // 🔥 统计初始 tile（前5秒）
                  const elapsed = Date.now() - scope._initialTileStats.startTime;
                  if (elapsed < 5000) {
                    scope._initialTileStats.totalCount++;
                    const lod = metadata.lod || 1;
                    scope._initialTileStats.lodCounts[lod] = (scope._initialTileStats.lodCounts[lod] || 0) + 1;
                  }
                  
                  // 🔥 完整接收统计（用于对比服务器推送数量）
                  if (scope._totalReceiveStats) {
                    scope._totalReceiveStats.totalCount++;
                    const lod = metadata.lod || 1;
                    scope._totalReceiveStats.lodCounts[lod] = (scope._totalReceiveStats.lodCounts[lod] || 0) + 1;
                    scope._totalReceiveStats.receivedTiles.add(`${metadata.hash}-L${lod}`);
                    if (!scope._totalReceiveStats.receivedTileIds) scope._totalReceiveStats.receivedTileIds = new Set();
                    scope._totalReceiveStats.receivedTileIds.add(metadata.hash);
                    // 公平性：loadedCount = 唯一 tile 数（去重，同一 tile 多 LOD 只算 1）
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
              // 合并当前 chunk 到 textBuffer
              const newBuffer = new Uint8Array(textBuffer.length + chunk.length);
              newBuffer.set(textBuffer, 0);
              newBuffer.set(chunk, textBuffer.length);
              textBuffer = newBuffer;

              // 查找 \n 的位置（字节 0x0A）
              let newlineIndex = -1;
              for (let i = 0; i < textBuffer.length; i++) {
                if (textBuffer[i] === 0x0A) {
                  newlineIndex = i;
                  break;
                }
              }

              if (newlineIndex !== -1) {
                // 找到 \n，解析元数据
                const metadataBytes = textBuffer.slice(0, newlineIndex);
                const metadataText = decoder.decode(metadataBytes);
                metadata = JSON.parse(metadataText);
                metadataRead = true;

                // 剩余的数据是二进制 tile 数据的开始
                if (textBuffer.length > newlineIndex + 1) {
                  const binaryStart = textBuffer.slice(newlineIndex + 1);
                  binaryChunks.push(binaryStart);
                  markDecodable();
                }
                textBuffer = new Uint8Array(0);
              }
            } else {
              // 读取二进制 tile 数据
              binaryChunks.push(chunk);
              markDecodable();
            }
          }
        }).catch(error => {
          console.error('[SLM2Loader] ❌ 处理 tile stream 错误:', error);
        });
      }
      
      // 🔥 确保所有待处理的 tile 都被处理
      if (this.tileBatchQueue.length > 0) {
        this.processTileBatch();
      }
    } catch (error) {
      console.error('[SLM2Loader] ❌ 接收 tile stream 错误:', error);
    }
    
    // 🔥 定期输出完整接收统计（每10秒）
    if (this._totalReceiveStats) {
      setInterval(() => {
        const stats = this._totalReceiveStats;
        const elapsed = (Date.now() - stats.startTime) / 1000;
        const tilesPerSecond = (stats.totalCount / elapsed).toFixed(1);
        console.log(`[SLM2Loader] 📊 完整接收统计 (运行${elapsed.toFixed(1)}秒):`, {
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
      }, 10000); // 每10秒输出一次
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
      // 🔥 优化：降低剔除更新间隔，从80ms降到40ms，提升响应速度
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
    // 检查 lbServer 是否存在且不为空字符串
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
      // lbServer 为空，直接使用配置中的 rcServerAddress
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
    // 🔥 B4 本地 RVC：true 时按远近选 tile + 定 LOD，不依赖 WebTransport 服务器
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
    // 这里增加两个文件的异步加载，两个都加载完后再执行 startConnect
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
        console.error("加载 sceneWeb.json 失败:", error);
        reject(error);
      });
    });

    var tilesMappingPromise = new Promise((resolve, reject) => {
      var fileLoader = new FileLoader();
      fileLoader.load("assets/custom_bounding_boxes_mapping-campus2.json", (data) => {
        scope.tilesMapping = JSON.parse(data);
        resolve();
      }, undefined, (error) => {
        console.error('加载 custom_bounding_boxes_mapping-campus2.json 失败:', error);
        reject(error);
      });
    });

    Promise.all([sceneConfigPromise, tilesMappingPromise]).then(() => {
      if (scope.useLocalRVC) {
        console.log('[SLM2Loader] B4 本地 RVC 模式：按远近选 tile + 定 LOD');
        scope.sceneCullingLocal();
      } else {
        scope.getRVCServerUrl(baseConfig.name, function() {
          scope.startConnect();
        });
      }
    }).catch((error) => {
      console.error('初始化场景配置或tilesMapping失败，无法连接服务器:', error);
    });

    this.rootScene = new Object3D();
    // 🔥 彻底移除旋转 (保持为 0)
    this.rootScene.rotation.x = 0;
    // 🔥🔥🔥 修正左右镜像：图1(正确学校) vs 图2(B4) 左右颠倒
    // 翻转 X 轴使 B1/B2/B3/B4 与正确学校方向一致
    this.rootScene.scale.set(-100, -100, 100);
    // 🔥 确保矩阵更新（这步很重要，对坐标转换至关重要）
    this.rootScene.updateMatrixWorld(true);

    this.initLoad();

    return this.rootScene;
  }


  async processLoadedTask_GS(task, buffer){
    // 让 HTTP/本地 RVC/WT 的 addObject_GS 统一走同一个并发阀，
    // 以避免大量 tile 完成后短时间并发触发 CacheMgr/GaussianSplattingMesh 合成。
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

    // 按队列顺序加载，保证高LOD优先（生成列表时已按 L4->L1 排序）
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
    // 🔥 B4 本地 RVC：由 sceneCullingLocal 驱动，不预加载
    if (this.useLocalRVC) {
      this.modelToLoadList_GS = { tileList: [], weightList: [] };
      return;
    }
    // WebTransport 模式（B3）：初始 tile 由服务器推送，不需要客户端加载 modelToLoadList_GS.json
    if (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://'))) {
      console.log('[SLM2Loader] WebTransport 模式：跳过 initLoad，等待服务器推送初始 tile');
      this.modelToLoadList_GS = { tileList: [], weightList: [] };
      return;
    }

    // HTTP1.1 模式：从assets中读取modelToLoadList_GS.json并解析到this.modelToLoadList_GS
    const scope = this;
    const fileLoader = new FileLoader();
    // 🔥 修复路径：使用 resourcesBaseUrl 构建完整路径
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
    // 🔥 WebTransport 模式（B3）或本地 RVC 使用 HTTP 时：WebTransport 由服务器推送，本地 RVC 用 HTTP 拉取
    if (!this.useLocalRVC && (this.schedulingStrategy === 'webtransport' || (this.rcServerAddress && this.rcServerAddress.startsWith('webtransport://')))) {
      // 只更新可见性，不生成 HTTP 任务
      this.modelCacheMgr.refreshVisible_GS(tileList, weightList);
      this.loadingTaskList_GS = []; // 清空任务列表
      return;
    }

    // HTTP1.1 模式：生成 HTTP fetch 任务
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
    // 与 HTTP1.1 保持一致的权重阈值，避免 L1-L4 对应关系颠倒
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