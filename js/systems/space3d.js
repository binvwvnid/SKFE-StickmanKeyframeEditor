/* ============================================================================
   SKFE 轻量 3D 模式 · 阶段 2 独立模块
   ----------------------------------------------------------------------------
   设计原则：
   1. 默认关闭；关闭时不创建 renderer、不注册事件、不改 2D 数据。
   2. 3D 核心逻辑全部在本文件，现有 2D 文件只保留少量开关 / 转发钩子。
   3. 正式 3D 不提供自定义主题色控件；背景与网格直接套用 SKFE 当前主题配置。
   4. 观察视角不进作品数据；元件 3D 属性与导出取景由独立数据层管理。
   ============================================================================ */
(function () {
  'use strict';

  var root = window.SKFE = window.SKFE || {};
  root.systems = root.systems || {};

  var THREE_LIB = window.THREE;
  var deps = null;
  var dataApi = root.systems.space3dData || null;
  var enabled = false;
  var initialized = false;
  var renderer = null;
  var canvas = null;
  var scene = null;
  var worldRoot = null;
  var grid = null;
  var cameraMarker = null;
  /* 摄像机视角遮罩：和 2D 相机视角共用 camera.js 的 drawCameraViewMask()，
     取景框外只是同一画面的 30% 主题色透明覆盖（70% 透明）。 */
  var cameraMaskCanvas = null;
  var cameraMaskCtx = null;
  var btn = null;
  var perspective = null;
  var orthographic = null;
  var activeCamera = null;
  var cameraMode = 'perspective';
  var viewFov = 50;
  var viewOrthoHeight = null;
  var cameraViewActive = false;
  /* 导出期间临时指定当前帧的 3D 摄像机：实时预览读 state.camera3d，
     逐帧导出读这里，避免所有帧都用当前固定机位。 */
  var exportCameraFrame = null;
  /* 3D 摄像机视锥辅助线的远端深度；半宽 / 半高按摄像机 FOV 与宽高比实时算。 */
  var CAMERA_FRUSTUM_DEPTH = 270;
  /* 阶段 4：导出期间临时指定帧 / 子轨道 / 输出画布尺寸，结束后恢复编辑器状态。 */
  var frameOverride = null;
  var exportViewport = null;
  var lastStageLeft = 0;
  var lastStageTop = 0;
  var lastStageW = 0;
  var lastStageH = 0;
  var rafId = 0;
  var lastSignature = '';
  /* 阶段 5：火柴人关节手柄覆盖层与拖拽状态。只显示当前选中火柴人，摄像机视角让位给相机手势。 */
  var jointOverlay = null;
  var jointCtx = null;
  var jointHandles = [];
  var jointDrag = null;
  /* 阶段 5：Blender 风格 3D 变换手柄，命中优先级高于关节手柄与视角手势。 */
  var gizmoGroup = null;
  var gizmoMode = 'translate';
  var gizmoDrag = null;
  /* 阶段 5：3D 画布点击命中元件。只在“按下到抬起没有位移”的小动作里选中，避免旋转视角时误选。 */
  var pendingSelect = null;
  /* 旋转环缩放分母：越大环越小、线越细。用户要求在上一版基础上再缩 1/3。 */
  var GIZMO_RING_SCALE_DIV = 360;
  var GIZMO_AXES = {
    x: { dir: [1, 0, 0], rotDir: [1, 0, 0], color: 0xff5f5f, propPos: 'posX', propRot: 'rotX' },
    y: { dir: [0, 1, 0], rotDir: [0, 1, 0], color: 0x6ee787, propPos: 'posY', propRot: 'rotY' },
    /* SKFE 的 Z 深度远离镜头为正，Three 内部是 -Z；旋转轴仍按 Three +Z 计算。 */
    z: { dir: [0, 0, -1], rotDir: [0, 0, 1], color: 0x5fa8ff, propPos: 'posZ', propRot: 'rotZ' }
  };
  var theme = {
    canvasBg: '#f7f5ea',
    canvasAlpha: 1,
    primary: '#ed9e94',
    textSub: '#b92d5d',
    borderColor: '#f9c3c5',
    textMain: '#551029'
  };

  var isMobile = false;
  var maxTexture = 3072;
  var textureScale = 3;
  /* 调参时对象签名会频繁变化：复用同一张离屏 canvas / CanvasTexture / Material，
     避免每帧新建 WebGL 纹理并重新上传造成 3D 画面闪烁。 */
  var textureCache = new Map();
  var TEXTURE_CACHE_LIMIT = 120;

  /* SKFE 内部坐标 y 向下为正；3D 里地面高度保留同一套语义，渲染时取负。
     默认 400 只是没有火柴人 / 没有地面参考线时的兜底值；通常会自动取当前帧脚底。 */
  var DEFAULT_GROUND_Y = 400;
  var groundY = DEFAULT_GROUND_Y;
  /* 地面只在第一次生成 3D 场景时按当前帧脚底定位；之后元件上下移动不再重新吸附。 */
  var groundInitialized = false;

  /* 地面网格自动拓展：始终保持 100 世界单位一格，走远后自动加大网格范围。 */
  var GRID_STEP = 100;
  var MIN_GRID_SIZE = 3200;
  var gridSize = MIN_GRID_SIZE;

  var orbit = {
    theta: 0.42,
    phi: 1.25,
    distance: 1800,
    target: { x: 0, y: 0, z: 0 }
  };

  var pointers = new Map();
  var gesture = null;
  var pinchStart = null;

  function log() {
    try { console.log('[space3d]', arguments.length === 1 ? arguments[0] : Array.prototype.slice.call(arguments)); } catch (_) {}
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function rgba(hex, alpha) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'rgba(237, 158, 148, ' + alpha + ')';
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function toThree(x, displayY, zDepth) {
    /* SKFE 显示 Y 向上；space3d.z 远离镜头为正，Three 内部用 -z。 */
    return new THREE_LIB.Vector3(x, displayY, -zDepth);
  }

  function getDisplayCenter(b) {
    return {
      x: (b.left + b.right) / 2,
      y: -((b.top + b.bottom) / 2)
    };
  }

  function safeBounds(o) {
    try {
      var b = deps.getObjectBounds(o);
      if (b && [b.left, b.right, b.top, b.bottom].every(Number.isFinite)) return b;
    } catch (_) {}
    var w = Math.max(1, Number(o.w) || 100);
    var h = Math.max(1, Number(o.h) || 100);
    return { left: (o.x || 0) - w / 2, right: (o.x || 0) + w / 2, top: (o.y || 0) - h / 2, bottom: (o.y || 0) + h / 2 };
  }

  function finite(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function figureConstants() {
    var p = root.core && root.core.constants && root.core.constants.P;
    return p || { torso: 82, headR: 17, upperArm: 40, foreArm: 38, thigh: 45, shin: 45, lw: 6 };
  }

  function bodyScaleVal(bs, key, generalKey, fallback) {
    var v = finite(bs && bs[key]);
    if (v != null && v > 0) return v;
    v = finite(bs && bs[generalKey]);
    if (v != null && v > 0) return v;
    return fallback;
  }

  /* 火柴人专用“稳定包围框”：
     2D 的 getObjectBounds() 会随当前关节姿势变化，直接拿它做 3D 面片会让纹理尺寸、
     geometry 尺寸和几何偏移每帧都变。这里用盆骨为中心、按骨骼长度上限算一个足够大的
     对称范围；关节角度变化不会改变它，因此画面位置与尺寸都保持稳定。 */
  function stableFigureBounds(o) {
    var P = figureConstants();
    var x = finite(o.x) || 0;
    var y = finite(o.y) || 0;
    var g = Math.abs(finite(o.scale) || 1);
    var bs = o.bodyScale || {};

    var torsoLen = P.torso * bodyScaleVal(bs, 'torso', 'torso', 1) * g;
    var headR = P.headR * bodyScaleVal(bs, 'head', 'head', 1) * g;
    var armBase = (P.upperArm + P.foreArm) *
      Math.max(bodyScaleVal(bs, 'armL', 'arm', 1), bodyScaleVal(bs, 'armR', 'arm', 1)) * g;
    var legBase = (P.thigh + P.shin) *
      Math.max(bodyScaleVal(bs, 'legL', 'leg', 1), bodyScaleVal(bs, 'legR', 'leg', 1)) * g;

    var headOff = o.headOffset || {};
    var headOffReach = Math.max(Math.abs(finite(headOff.x) || 0), Math.abs(finite(headOff.y) || 0));
    var headReach = torsoLen + headR * 2 + headOffReach;
    var armReach = torsoLen + headR + armBase;
    var radius = Math.max(headReach, armReach, legBase, (finite(P.lw) || 6) * g);

    /* 2D 旋转后包围框会放大到对角线，始终留出 sqrt(2) 余量。
       过去只在 rot 非零时突然乘 1.45，Z 旋转一过 0 就会让面片尺寸跳一下；
       这里固定留余量，尺寸不再随是否旋转突变。 */
    radius *= 1.45;

    var pad = (finite(o.lw) || 6) * g / 2 + 12;
    var glow = o.glow || {};
    if (glow.enabled) {
      pad += (Math.abs(finite(glow.blur) || 0) +
        Math.abs(finite(glow.spread) || 0) +
        Math.max(Math.abs(finite(glow.offsetX) || 0), Math.abs(finite(glow.offsetY) || 0))) * g;
    }

    radius += pad;
    return { left: x - radius, right: x + radius, top: y - radius, bottom: y + radius };
  }

  function getRenderBounds(o) {
    if (o && o.type === 'figure') return stableFigureBounds(o);
    return safeBounds(o);
  }

  function getRenderableList() {
    if (!deps || !deps.getObjectsForFrameAt) return [];
    var frameIndex = frameOverride && Number.isFinite(frameOverride.index)
      ? frameOverride.index
      : (deps.AppState ? deps.AppState.currentFrameIndex : 0);
    var tid = frameOverride && frameOverride.trackId != null && frameOverride.trackId !== deps.TRACK_ALL_ID
      ? String(frameOverride.trackId)
      : null;
    var raw = (tid ? deps.getObjectsForFrameAt(frameIndex, tid) : deps.getObjectsForFrameAt(frameIndex)) || [];
    return raw.filter(function (o) {
      if (!o || o.hidden) return false;
      var t = o.type;
      if (t === 'camera' || t === 'audioClip' || t === 'video') return false;
      return true;
    });
  }

  function findListObject(list, id) {
    if (!list || id == null) return null;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i] && list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  function findGroupCarrier(o, list) {
    if (!o || o.groupId == null) return null;
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (g && g.type === 'group' && String(g.id) === String(o.groupId)) return g;
    }
    return null;
  }

  function getBindParent(o, list) {
    if (!o || !o.bindTo || o.bindTo === 'none' || !o.targetId) return null;
    var p = findListObject(list, o.targetId);
    return (p && p.type === 'figure') ? p : null;
  }

  /* 挂载元件的 z 是相对挂载点的量；世界深度要叠加父火柴人 / 所属编组的 z。 */
  function getObject3DDepth(o, list) {
    var d = finite(o && o.space3d && o.space3d.z) || 0;
    var carrier = findGroupCarrier(o, list);
    if (carrier) d += finite(carrier.space3d && carrier.space3d.z) || 0;
    return d;
  }

  /* 阶段 6：跟随目标的位置锚点，与 3D mesh 落点保持一致。
     火柴人取盆骨，编组取父变换锚点，其余元件取面片中心；Z 按 Three 内部 -z 存储。 */
  function getObjectWorldPosition(id) {
    if (id == null || !THREE_LIB) return null;
    var list = getRenderableList();
    var o = null;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) { o = list[i]; break; }
    }
    if (!o) return null;

    var carrier = findGroupCarrier(o, list);
    var bindParent = getBindParent(o, list);

    var internal;
    if (o.type === 'figure') {
      internal = { x: finite(o.x) || 0, y: finite(o.y) || 0 };
    } else if (o.type === 'group' && dataApi && typeof dataApi.groupBase === 'function') {
      var ga = dataApi.groupBase(o);
      internal = { x: ga.x, y: ga.y };
    } else {
      var b = getRenderBounds(o);
      internal = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
    }

    /* 组内成员跟随的是父变换后的世界锚点，不是原始局部坐标。 */
    if (carrier && dataApi && typeof dataApi.groupPointToWorld === 'function') {
      internal = dataApi.groupPointToWorld(internal, carrier);
    }
    var depth = getObject3DDepth(o, list);
    if (bindParent) depth += getObject3DDepth(bindParent, list);
    return toThree(internal.x, -internal.y, depth);
  }

  /* 跟随目标时，面板与手势里的 position 是“当前实际机位”，
     targetOffset 保存它相对目标锚点的偏移；目标移动后画面保持同样构图。 */
  function getEffectiveCameraPosition(cam) {
    var p = (cam && cam.position) || {};
    var px = finite(p.x), py = finite(p.y), pz = finite(p.z);
    if (!THREE_LIB) return { x: px == null ? 0 : px, y: py == null ? 0 : py, z: pz == null ? -1200 : pz };
    var base = new THREE_LIB.Vector3(
      px == null ? 0 : px,
      py == null ? 0 : py,
      pz == null ? -1200 : pz
    );
    if (!cam || !cam.targetId) return base;
    var target = getObjectWorldPosition(cam.targetId);
    if (!target) return base;
    var off = cam.targetOffset || {};
    var ox = finite(off.x), oy = finite(off.y), oz = finite(off.z);
    /* 旧工程若已有 targetId 但没有 offset，视为“沿用当前机位偏移”，避免镜头贴到目标身上。 */
    if (ox == null && oy == null && oz == null) return target.clone().add(base);
    return target.clone().add(new THREE_LIB.Vector3(ox || 0, oy || 0, oz == null ? -1200 : oz));
  }

  function bindExportCameraTarget(id) {
    if (!dataApi) return;
    var state = dataApi.getProjectState();
    var cam = state.camera3d;
    if (!cam) return;
    if (id != null && String(id)) {
      var target = getObjectWorldPosition(id);
      if (target) {
        var eff = getEffectiveCameraPosition(cam);
        cam.targetOffset = { x: eff.x - target.x, y: eff.y - target.y, z: eff.z - target.z };
      }
      cam.targetId = String(id);
    } else {
      cam.targetId = null;
    }
    dataApi.setProjectState(state);
    applyExportCameraLive();
    if (deps && deps.requestSyncUI) deps.requestSyncUI();
  }

  /* 3D 地面优先取当前帧火柴人脚底；没有火柴人时才退回 SKFE 地面参考线 / 可视元件最低边。
     脚底用 jointData 的 foot/toe 精确位置，不受地面参考线默认值干扰。 */
  function computeGroundY(list) {
    var figureFeet = [];
    var allBottoms = [];

    list.forEach(function (o) {
      if (o.type === 'figure' && deps && deps.getFigureFootY) {
        var footY = finite(deps.getFigureFootY(o));
        if (footY != null) figureFeet.push(footY);
      }
      var bottom = finite(safeBounds(o).bottom);
      if (bottom != null) allBottoms.push(bottom);
    });

    if (figureFeet.length) return Math.max.apply(null, figureFeet);

    var enabled = false;
    try { enabled = !!(deps && deps.isGroundLineEnabled && deps.isGroundLineEnabled()); } catch (_) {}
    if (enabled && deps && deps.getGroundLineY) {
      var lineY = finite(deps.getGroundLineY());
      if (lineY != null) return lineY;
    }

    return allBottoms.length ? Math.max.apply(null, allBottoms) : DEFAULT_GROUND_Y;
  }

  function setGroundY(y) {
    var v = finite(y);
    if (v == null) return;
    groundY = v;
    if (grid) grid.position.y = -v;
  }

  function ensureGridExtent(list) {
    var reachX = Math.abs(finite(orbit.target.x) || 0);
    var reachZ = Math.abs(finite(orbit.target.z) || 0);

    list.forEach(function (o) {
      var b = safeBounds(o);
      reachX = Math.max(reachX, Math.abs(b.left), Math.abs(b.right));
      var z = finite(o.space3d && o.space3d.z) || 0;
      reachZ = Math.max(reachZ, Math.abs(z));
    });

    /* 以原点为中心向外扩，留 800 世界单位余量；按 400 取整避免频繁重建。 */
    var need = Math.max(MIN_GRID_SIZE, (Math.max(reachX, reachZ) + 800) * 2);
    need = Math.ceil(need / 400) * 400;
    if (need > gridSize || need < gridSize * 0.5) {
      gridSize = need;
      rebuildGrid();
    }
  }

  function getDisplayBounds(list) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    list.forEach(function (o) {
      var b = safeBounds(o);
      minX = Math.min(minX, b.left);
      maxX = Math.max(maxX, b.right);
      /* SKFE 内部 y 向下，显示 / 3D 都要取负。 */
      minY = Math.min(minY, -b.bottom);
      maxY = Math.max(maxY, -b.top);
    });
    if (minX === Infinity) {
      minX = -200; maxX = 200; minY = -200; maxY = 200;
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  function fitViewToScene() {
    var list = getRenderableList();
    if (list.length) {
      if (!groundInitialized) {
        setGroundY(computeGroundY(list));
        groundInitialized = true;
      }
      ensureGridExtent(list);
    }

    if (!list.length) {
      orbit.target = { x: 0, y: 0, z: 0 };
      orbit.distance = 1800;
      updateCamera();
      return;
    }

    var b = getDisplayBounds(list);
    var wWorld = Math.max(1, b.maxX - b.minX);
    var hWorld = Math.max(1, b.maxY - b.minY);
    var rect = getStageRect();
    var aspect = Math.max(0.45, Math.max(1, rect.width) / Math.max(1, rect.height));
    var dist = Math.max(1800, hWorld * 2.4, wWorld / aspect * 1.8);

    orbit.target.x = (b.minX + b.maxX) / 2;
    orbit.target.y = (b.minY + b.maxY) / 2;
    orbit.target.z = 0;
    orbit.distance = Number.isFinite(dist) && dist > 0 ? dist : 1800;
    updateCamera();
  }

  function ensureRenderer() {
    if (renderer || !THREE_LIB) return;

    isMobile = !!(deps && deps.isMobile);
    /* 2D 火柴人是矢量式绘制指令，但 3D 面片必须用 CanvasTexture 栅格化。
       这里提高离屏倍率，避免放大后发糊；移动端折中到 2x / 1536px。 */
    textureScale = isMobile ? 2 : 3;
    maxTexture = isMobile ? 1536 : 3072;

    renderer = new THREE_LIB.WebGLRenderer({
      antialias: !isMobile,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));

    canvas = renderer.domElement;
    canvas.id = 'space3dCanvas';
    canvas.style.display = 'none';
    canvas.style.touchAction = 'none';
    document.body.appendChild(canvas);

    /* 关节手柄画在 WebGL 之上的透明 2D 层；指针事件仍全部由 WebGL canvas 接管，
       这样未命中手柄时原有观察视角手势完全不变。 */
    jointOverlay = document.createElement('canvas');
    jointOverlay.id = 'space3dJointOverlay';
    jointOverlay.style.display = 'none';
    jointOverlay.style.pointerEvents = 'none';
    jointOverlay.style.position = 'fixed';
    jointOverlay.style.zIndex = '7';
    jointOverlay.style.touchAction = 'none';
    document.body.appendChild(jointOverlay);
    jointCtx = jointOverlay.getContext('2d');

    /* 摄像机取景框遮罩：2D canvas 覆盖在 WebGL 之上，只画取景框外的主题色 50% 区域；
       不参与指针事件，也不进导出 canvas。 */
    cameraMaskCanvas = document.createElement('canvas');
    cameraMaskCanvas.id = 'space3dCameraMask';
    cameraMaskCanvas.hidden = true;
    cameraMaskCanvas.style.display = 'none';
    cameraMaskCanvas.style.touchAction = 'none';
    document.body.appendChild(cameraMaskCanvas);
    cameraMaskCtx = cameraMaskCanvas.getContext('2d');
    updateCameraMask();

    scene = new THREE_LIB.Scene();
    worldRoot = new THREE_LIB.Group();
    scene.add(worldRoot);
    buildGizmo();
    createCameraMarker();

    perspective = new THREE_LIB.PerspectiveCamera(50, 1, 1, 20000);
    orthographic = new THREE_LIB.OrthographicCamera(-500, 500, 300, -300, 1, 20000);
    activeCamera = perspective;

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('auxclick', onAuxClick);
    canvas.addEventListener('contextmenu', function (e) { if (enabled) e.preventDefault(); });
    canvas.addEventListener('wheel', onWheel, { passive: false });

    /* 用户要求移除“3D 查看模式”提示徽章，3D 状态由底部栏和摄像机按钮体现。 */

    resize();
    applyTheme();
    /* 工程可能在 renderer 创建前就写入了正交取景，这里按保存的 cameraMode 落一次。 */
    setCameraMode(cameraMode);
  }

  function updateCamera() {
    if (!activeCamera) return;

    /* 观察视角手势不再限制俯仰角和距离；只在数值失效时恢复默认值。 */
    if (!Number.isFinite(orbit.phi)) orbit.phi = 1.25;
    if (!Number.isFinite(orbit.distance) || orbit.distance === 0) orbit.distance = 1800;

    if (cameraViewActive) {
      /* 摄像机视角：实时预览读工程状态；逐帧导出读 exportCameraFrame。
         之前这里无条件读 state.camera3d，导致 MP4 / GIF 虽然传了 camera3dFrame，
         真正落到 Three 相机的仍是当前固定机位。 */
      var cam = exportCameraFrame || (dataApi ? dataApi.getProjectState().camera3d : null);
      if (cam) {
        var p = getEffectiveCameraPosition(cam);
        var r = cam.rotation || {};
        activeCamera.position.set(
          finite(p.x) == null ? 0 : finite(p.x),
          finite(p.y) == null ? 0 : finite(p.y),
          finite(p.z) == null ? -1200 : finite(p.z)
        );
        activeCamera.rotation.order = 'YXZ';
        activeCamera.rotation.set(
          (finite(r.x) == null ? 0 : finite(r.x)) * Math.PI / 180,
          (finite(r.y) == null ? 0 : finite(r.y)) * Math.PI / 180,
          (finite(r.z) == null ? 0 : finite(r.z)) * Math.PI / 180
        );
      }
    } else {
      var sp = Math.sin(orbit.phi);
      var pos = new THREE_LIB.Vector3(
        orbit.distance * sp * Math.sin(orbit.theta),
        orbit.distance * Math.cos(orbit.phi),
        orbit.distance * sp * Math.cos(orbit.theta)
      );
      pos.x += orbit.target.x;
      pos.y += orbit.target.y;
      pos.z += orbit.target.z;

      activeCamera.position.copy(pos);
      activeCamera.lookAt(orbit.target.x, orbit.target.y, orbit.target.z);
    }

    var rect = getCameraViewportRect();
    var stage = getStageRect();
    var aspect;
    var viewH;
    var viewOffset = null;
    var fov = clamp(viewFov, 10, 120);

    if (cameraViewActive && !exportViewport) {
      /* 摄像机视角下整块画布只显示摄像机画面，遮罩外圈是同一画面的透明覆盖。
         投影按整块画布取 aspect 以免拉伸；再按取景框高度占比反推 FOV / 正交高度，
         保证取景框内的构图与导出画面一致。 */
      aspect = Math.max(0.05, stage.width) / Math.max(0.05, stage.height);
      var cropFrac = clamp(rect.height / Math.max(1, stage.height), 0.05, 1);
      perspective.fov = clamp(2 * Math.atan(Math.tan(fov * Math.PI / 360) / cropFrac) * 180 / Math.PI, 10, 179);
      viewH = (viewOrthoHeight == null ? orbit.distance * 0.68 : viewOrthoHeight) / cropFrac;
      /* 取景框为了避开左侧 UI / 时间轴，中心可能不在画布中心。
         用 viewOffset 把投影中心移到取景框中心，视锥对角线才能和遮罩框重合。 */
      viewOffset = {
        fullW: Math.max(1, Math.round(stage.width)),
        fullH: Math.max(1, Math.round(stage.height)),
        /* setViewOffset 是“把渲染窗口挪到哪”，相机中心落点 = 舞台中心 - offset。
           所以要把相机中心移到取景框中心，offset 必须取舞台中心减取景框中心。 */
        x: (stage.left + stage.width / 2) - (rect.left + rect.width / 2),
        y: (stage.top + stage.height / 2) - (rect.top + rect.height / 2)
      };
    } else {
      aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      perspective.fov = fov;
      viewH = viewOrthoHeight == null ? orbit.distance * 0.68 : viewOrthoHeight;
      perspective.clearViewOffset();
      orthographic.clearViewOffset();
    }

    perspective.aspect = aspect;
    perspective.updateProjectionMatrix();

    orthographic.left = -viewH * aspect / 2;
    orthographic.right = viewH * aspect / 2;
    orthographic.top = viewH / 2;
    orthographic.bottom = -viewH / 2;

    if (viewOffset) {
      perspective.setViewOffset(viewOffset.fullW, viewOffset.fullH, viewOffset.x, viewOffset.y,
        viewOffset.fullW, viewOffset.fullH);
      orthographic.setViewOffset(viewOffset.fullW, viewOffset.fullH, viewOffset.x, viewOffset.y,
        viewOffset.fullW, viewOffset.fullH);
    } else {
      orthographic.updateProjectionMatrix();
    }
  }

  function setCameraMode(mode) {
    cameraMode = mode === 'orthographic' ? 'orthographic' : 'perspective';
    activeCamera = cameraMode === 'orthographic' ? orthographic : perspective;
    updateCamera();
  }

  /* 把一组导出取景参数落到 Three 相机；导出与实时摄像机视角共用，避免两套参数解释。 */
  function configureExportCamera(cam) {
    if (!cam) return;
    viewFov = clamp(Number(cam.fov) || 50, 10, 120);
    viewOrthoHeight = cam.mode === 'orthographic'
      ? clamp(Number(cam.orthoHeight) || 1080, 100, 20000)
      : null;
    setCameraMode(cam.mode);
  }

  /* 摄像机参数变化后的实时应用：滑条 / 数字框 / 元件同步都会走这里。
     关键：这里只刷新相机与画面，绝不改变「是否处于摄像机视角」。
     之前这里的 cameraViewActive = true 会让任何元件改帧、3D 手柄抬起都隐式进入摄像机视角。 */
  function applyExportCameraLive() {
    if (!dataApi) return;
    var cam = dataApi.getProjectState().camera3d;
    if (!cam) return;
    configureExportCamera(cam);
    /* 即使没进入摄像机视角，也要立刻刷新取景标记与遮罩，参数滑条不能“没反应”。 */
    updateCameraMarker();
    updateCameraMask();
    if (enabled) renderFrame();
  }

  /* 显式进入摄像机视角：只有右上角按钮 / 摄像机参数入口可以调用。 */
  function enterCameraView() {
    applyExportCameraLive();
    cameraViewActive = true;
    if (deps && deps.requestSyncUI) deps.requestSyncUI();
    if (enabled) renderFrame();
  }

  function getStageRect() {
    /* 导出时相机宽高比以输出画布为准，不能沿用编辑器画布。 */
    if (exportViewport) return { left: 0, top: 0, width: exportViewport.width, height: exportViewport.height };
    var base = deps && deps.getCanvas ? deps.getCanvas() : document.getElementById('c');
    if (!base) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    var r = base.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /* 编辑器可用区：必须像 2D 摄像机一样避开左侧 UI 面板和底部 / 顶部时间轴。
     以前 3D 取景框按整个窗口短边算中心方形，底边会钻到时间轴下面，
     这就是遮罩尺寸一直对不上的根因。 */
  function getEditorAvailableRect() {
    var stage = getStageRect();
    var left = stage.left;
    var top = stage.top;
    var right = stage.left + stage.width;
    var bottom = stage.top + stage.height;
    var mobile = !!(deps && deps.isMobile);

    var ui = deps && deps.getUiPanel ? deps.getUiPanel() : null;
    if (ui && (!mobile || !ui.classList.contains('hidden'))) {
      var ur = ui.getBoundingClientRect();
      if (mobile) bottom = Math.min(bottom, ur.top);
      else left = Math.max(left, ur.right);
    }

    var tl = deps && deps.getTimelineEl ? deps.getTimelineEl() : null;
    if (tl && getComputedStyle(tl).display !== 'none') {
      var tr = tl.getBoundingClientRect();
      var dock = deps && deps.getTimelineDock ? deps.getTimelineDock() : 'bottom';
      if (dock === 'top') top = Math.max(top, tr.bottom);
      else bottom = Math.min(bottom, tr.top);
    }

    return {
      left: left,
      top: top,
      width: Math.max(80, right - left),
      height: Math.max(80, bottom - top)
    };
  }

  /* 摄像机视角取景框：按 camera3d 的宽高比在可用区里取最大居中矩形，
     和 2D 摄像机一样由摄像机尺寸决定，而不是固定正方形。 */
  function getCameraViewportRect() {
    var r = getStageRect();
    if (!cameraViewActive || exportViewport) return r;
    var avail = getEditorAvailableRect();
    var cam = dataApi ? dataApi.getProjectState().camera3d : null;
    var cw = cam && finite(cam.width) > 0 ? finite(cam.width) : 1920;
    var ch = cam && finite(cam.height) > 0 ? finite(cam.height) : 1080;
    var aspect = Math.max(0.05, cw / ch);

    var maxW = Math.max(80, avail.width * 0.92);
    var maxH = Math.max(80, avail.height * 0.92);
    var w = Math.min(maxW, maxH * aspect);
    var h = w / aspect;
    if (h > maxH) { h = maxH; w = h * aspect; }
    w = Math.max(80, Math.min(w, avail.width));
    h = Math.max(80, Math.min(h, avail.height));

    return {
      left: avail.left + (avail.width - w) / 2,
      top: avail.top + (avail.height - h) / 2,
      width: w,
      height: h
    };
  }

  function resize() {
    if (!renderer || !canvas) return;
    var r = getStageRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));

    /* 每帧调用 setSize 会重建 WebGL drawing buffer 并清屏，调参时表现为闪屏。
       尺寸 / 位置没变化就只更新相机，不碰 canvas。 */
    if (w !== lastStageW || h !== lastStageH ||
        r.left !== lastStageLeft || r.top !== lastStageTop) {
      canvas.style.left = r.left + 'px';
      canvas.style.top = r.top + 'px';
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      renderer.setSize(w, h, false);
      lastStageLeft = r.left;
      lastStageTop = r.top;
      lastStageW = w;
      lastStageH = h;
    }
    updateCamera();
    updateCameraMask();
  }

  function rebuildGrid() {
    if (!scene) return;
    if (grid) {
      scene.remove(grid);
      if (grid.geometry) grid.geometry.dispose();
      if (grid.material) grid.material.dispose();
    }
    var primary = theme.primary || '#ed9e94';
    var secondary = theme.textSub || theme.borderColor || '#b92d5d';
    /* 网格单元固定 100 世界单位，尺寸按元件范围自动扩张，避免走远后网格断掉。 */
    grid = new THREE_LIB.GridHelper(gridSize, Math.max(8, Math.round(gridSize / GRID_STEP)), new THREE_LIB.Color(primary), new THREE_LIB.Color(secondary));
    grid.position.y = -groundY;
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    /* 网格必须先画且不写深度，否则透明排序会把背后的网格线压到前景面片上。 */
    grid.material.depthWrite = false;
    grid.renderOrder = -1000;
    scene.add(grid);
  }

  /* 3D 空间里的摄像机标记：机身 + 镜头 + 视锥 + 文字标签。
     它只反映工程里的摄像机视角参数，不是新的作品元件。 */
  function markGizmoPart(obj, axis, kind) {
    obj.userData.gizmoAxis = axis;
    obj.userData.gizmoKind = kind;
    obj.renderOrder = 9999;
    return obj;
  }

  function styleGizmoMaterial(mat) {
    if (!mat) return;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.transparent = true;
    mat.opacity = 0.95;
  }

  function buildGizmo() {
    if (gizmoGroup || !scene) return;
    gizmoGroup = new THREE_LIB.Group();
    gizmoGroup.name = 'skfe-gizmo';
    gizmoGroup.renderOrder = 9999;

    Object.keys(GIZMO_AXES).forEach(function (axis) {
      var cfg = GIZMO_AXES[axis];
      var dir = new THREE_LIB.Vector3(cfg.dir[0], cfg.dir[1], cfg.dir[2]).normalize();

      var arrow = new THREE_LIB.ArrowHelper(dir, new THREE_LIB.Vector3(0, 0, 0), 120, cfg.color, 30, 16);
      arrow.traverse(function (node) {
        if (node.material) styleGizmoMaterial(node.material);
        markGizmoPart(node, axis, 'translate');
      });
      markGizmoPart(arrow, axis, 'translate');
      gizmoGroup.add(arrow);
      cfg.arrow = arrow;

      /* 旋转环几何基数仍为 120，实际显示时按 size / GIZMO_RING_SCALE_DIV 缩放；
         可见半径与线宽同步变细，命中环单独加粗保证还能点中。 */
      var ringGeo = new THREE_LIB.TorusGeometry(120, 7, 10, 72);
      var ringMat = new THREE_LIB.MeshBasicMaterial({ color: cfg.color, side: THREE_LIB.DoubleSide });
      styleGizmoMaterial(ringMat);
      var ring = new THREE_LIB.Mesh(ringGeo, ringMat);
      if (axis === 'x') ring.rotation.y = Math.PI / 2;
      else if (axis === 'y') ring.rotation.x = Math.PI / 2;
      markGizmoPart(ring, axis, 'rotate');
      ring.renderOrder = 9999;
      gizmoGroup.add(ring);
      cfg.ring = ring;

      /* 蓝色 Z 环过去只有 5 单位线宽，鼠标稍微偏一点就点不到。
         叠一层不可见但可命中的粗环，专门放大点击范围，不参与显示。 */
      var hitGeo = new THREE_LIB.TorusGeometry(120, 40, 6, 48);
      var hitMat = new THREE_LIB.MeshBasicMaterial({
        color: cfg.color, side: THREE_LIB.DoubleSide,
        transparent: true, opacity: 0, depthTest: false, depthWrite: false, colorWrite: false
      });
      var ringHit = new THREE_LIB.Mesh(hitGeo, hitMat);
      if (axis === 'x') ringHit.rotation.y = Math.PI / 2;
      else if (axis === 'y') ringHit.rotation.x = Math.PI / 2;
      markGizmoPart(ringHit, axis, 'rotate');
      gizmoGroup.add(ringHit);
      cfg.ringHit = ringHit;
    });

    gizmoGroup.visible = false;
    scene.add(gizmoGroup);
  }

  function makeCameraLabelSprite() {
    var cv = document.createElement('canvas');
    cv.width = 320; cv.height = 72;
    var c = cv.getContext('2d');
    var bg = theme.primary || '#ed9e94';
    var fg = theme.textMain || '#551029';
    var r = 16;
    c.beginPath();
    c.moveTo(r, 0);
    c.lineTo(cv.width - r, 0);
    c.quadraticCurveTo(cv.width, 0, cv.width, r);
    c.lineTo(cv.width, cv.height - r);
    c.quadraticCurveTo(cv.width, cv.height, cv.width - r, cv.height);
    c.lineTo(r, cv.height);
    c.quadraticCurveTo(0, cv.height, 0, cv.height - r);
    c.lineTo(0, r);
    c.quadraticCurveTo(0, 0, r, 0);
    c.closePath();
    c.fillStyle = bg; c.fill();
    c.font = 'bold 28px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = fg; c.fillText('摄像机视角', cv.width / 2, cv.height / 2 + 1);
    var tex = new THREE_LIB.CanvasTexture(cv);
    tex.minFilter = THREE_LIB.LinearFilter;
    tex.magFilter = THREE_LIB.LinearFilter;
    var sprite = new THREE_LIB.Sprite(new THREE_LIB.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false
    }));
    sprite.scale.set(180, 40, 1);
    sprite.renderOrder = 1000;
    return sprite;
  }

  function createCameraMarker() {
    if (!scene || cameraMarker) return;
    var primary = theme.primary || '#ed9e94';
    var secondary = theme.textSub || theme.borderColor || '#b92d5d';
    var group = new THREE_LIB.Group();
    group.renderOrder = 999;

    var body = new THREE_LIB.Mesh(
      new THREE_LIB.BoxGeometry(90, 60, 50),
      new THREE_LIB.MeshBasicMaterial({ color: primary, wireframe: true, transparent: true, opacity: 0.9, depthTest: false })
    );
    body.renderOrder = 999;
    group.add(body);

    var lens = new THREE_LIB.Mesh(
      new THREE_LIB.ConeGeometry(18, 38, 16),
      new THREE_LIB.MeshBasicMaterial({ color: primary, transparent: true, opacity: 0.55, depthTest: false })
    );
    lens.rotation.x = -Math.PI / 2;
    lens.position.z = -42;
    lens.renderOrder = 999;
    group.add(lens);

    /* 单位几何：半宽 / 半高在 updateCameraMarker() 中按摄像机宽高比与 FOV 实时缩放，
       不再写死 145×82，否则切比例或改 FOV 后对角线框既不同步也偏小。 */
    var hw = 1, hh = 1, z0 = -62, z1 = -CAMERA_FRUSTUM_DEPTH;
    var corners = [[-hw, -hh, z1], [hw, -hh, z1], [hw, hh, z1], [-hw, hh, z1]];
    var seg = [];
    corners.forEach(function (p) {
      seg.push(0, 0, z0, p[0], p[1], p[2]);
    });
    for (var i = 0; i < 4; i++) {
      var a = corners[i], b = corners[(i + 1) % 4];
      seg.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    var frustumGeo = new THREE_LIB.BufferGeometry();
    frustumGeo.setAttribute('position', new THREE_LIB.Float32BufferAttribute(seg, 3));
    var frustum = new THREE_LIB.LineSegments(
      frustumGeo,
      new THREE_LIB.LineBasicMaterial({ color: secondary, transparent: true, opacity: 0.5, depthTest: false })
    );
    frustum.renderOrder = 999;
    group.add(frustum);

    var label = makeCameraLabelSprite();
    label.position.set(0, 76, 0);
    group.add(label);

    group.userData.body = body;
    group.userData.lens = lens;
    group.userData.frustum = frustum;
    group.userData.label = label;
    cameraMarker = group;
    scene.add(group);
  }

  function refreshCameraMarkerTheme() {
    if (!cameraMarker) return;
    var primary = theme.primary || '#ed9e94';
    var secondary = theme.textSub || theme.borderColor || '#b92d5d';
    cameraMarker.userData.body.material.color.set(primary);
    cameraMarker.userData.lens.material.color.set(primary);
    cameraMarker.userData.frustum.material.color.set(secondary);
  }

  /* 与 2D 相机视角共用 drawing：取景框外 = 同一画面叠主题色 30%（70% 透明），取景框内保持透明。 */
  function updateCameraMask() {
    if (!cameraMaskCanvas || !cameraMaskCtx) return;
    var show = !!(enabled && cameraViewActive && !exportViewport);
    cameraMaskCanvas.hidden = !show;
    cameraMaskCanvas.style.display = show ? 'block' : 'none';
    if (!show) return;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var stage = getStageRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var needW = Math.max(1, Math.round(vw * dpr));
    var needH = Math.max(1, Math.round(vh * dpr));
    if (cameraMaskCanvas.width !== needW) cameraMaskCanvas.width = needW;
    if (cameraMaskCanvas.height !== needH) cameraMaskCanvas.height = needH;
    cameraMaskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cameraMaskCtx.clearRect(0, 0, vw, vh);

    var r = getCameraViewportRect();
    var camApi = root.SKFE && root.SKFE.systems && root.SKFE.systems.camera;
    var alpha = camApi && typeof camApi.getCameraMaskAlpha === 'function'
      ? camApi.getCameraMaskAlpha() : 0.3;
    if (camApi && typeof camApi.drawCameraViewMask === 'function') {
      camApi.drawCameraViewMask(cameraMaskCtx, vw, vh,
        { left: r.left, top: r.top, width: r.width, height: r.height },
        {
          alpha: alpha,
          border: true,
          borderWidth: 1,
          bounds: { left: stage.left, top: stage.top, width: stage.width, height: stage.height }
        });
      return;
    }

    /* 兼容兜底：camera.js 尚未加载时仍按同一视觉规则画。 */
    var primary = theme.primary || '#ed9e94';
    cameraMaskCtx.fillStyle = rgba(primary, alpha);
    cameraMaskCtx.beginPath();
    cameraMaskCtx.rect(stage.left, stage.top, stage.width, stage.height);
    cameraMaskCtx.rect(r.left, r.top, r.width, r.height);
    cameraMaskCtx.fill('evenodd');
    cameraMaskCtx.strokeStyle = primary;
    cameraMaskCtx.lineWidth = 1;
    cameraMaskCtx.strokeRect(r.left, r.top, r.width, r.height);
  }

  function updateCameraMarker() {
    if (!cameraMarker || !dataApi) return;
    var cam = dataApi.getProjectState().camera3d;
    if (!cam) { cameraMarker.visible = false; return; }
    /* 摄像机视角保留取景框；只隐藏会贴在镜头上的机身、尖锥和标签。 */
    cameraMarker.visible = enabled;
    cameraMarker.userData.body.visible = !cameraViewActive;
    cameraMarker.userData.lens.visible = !cameraViewActive;
    cameraMarker.userData.label.visible = !cameraViewActive;
    cameraMarker.userData.frustum.visible = true;

    /* 对角线框按 camera3d 宽高比与 FOV / 正交高度实时缩放。
       旧值写死 145×82，改比例后框仍是 16:9 且明显偏小。 */
    var frustum = cameraMarker.userData.frustum;
    if (frustum) {
      var fw = finite(cam.width), fh = finite(cam.height);
      var markerAspect = (fw == null || fw <= 0 ? 1920 : fw) / (fh == null || fh <= 0 ? 1080 : fh);
      var halfH;
      if (cameraMode === 'orthographic') {
        var oh = finite(viewOrthoHeight);
        halfH = Math.max(1, oh == null ? 1080 : oh) / 2;
      } else {
        var fovVal = finite(viewFov);
        halfH = CAMERA_FRUSTUM_DEPTH * Math.tan(clamp(fovVal == null ? 50 : fovVal, 10, 120) * Math.PI / 360);
      }
      frustum.scale.set(Math.max(1, halfH * markerAspect), Math.max(1, halfH), 1);
    }

    var p = getEffectiveCameraPosition(cam), r = cam.rotation || {};
    cameraMarker.position.set(
      finite(p.x) == null ? 0 : finite(p.x),
      finite(p.y) == null ? 0 : finite(p.y),
      finite(p.z) == null ? -1200 : finite(p.z)
    );
    cameraMarker.rotation.order = 'YXZ';
    cameraMarker.rotation.set(
      (finite(r.x) == null ? 0 : finite(r.x)) * Math.PI / 180,
      (finite(r.y) == null ? 0 : finite(r.y)) * Math.PI / 180,
      (finite(r.z) == null ? 0 : finite(r.z)) * Math.PI / 180
    );
  }

  function applyTheme(cfg) {
    if (cfg && typeof cfg === 'object') {
      theme = Object.assign({}, theme, cfg);
    } else if (deps && deps.getThemeConfig) {
      var t = deps.getThemeConfig();
      if (t) theme = Object.assign({}, theme, t);
    }

    if (!renderer) return;
    var bg = (deps && deps.getPageBgColor && deps.getPageBgColor()) || theme.canvasBg || '#f7f5ea';
    var alpha = (deps && deps.getPageBgAlpha && deps.getPageBgAlpha());
    if (alpha == null || !Number.isFinite(Number(alpha))) alpha = theme.canvasAlpha == null ? 1 : Number(theme.canvasAlpha);
    renderer.setClearColor(new THREE_LIB.Color(bg), clamp(Number(alpha), 0, 1));
    rebuildGrid();
    refreshCameraMarkerTheme();
    updateCameraMask();
  }

  function stableStringify(v) {
    var seen = new WeakSet();
    try {
      return JSON.stringify(v, function (key, val) {
        if (val == null || typeof val !== 'object') return val;
        if (typeof HTMLCanvasElement !== 'undefined' && val instanceof HTMLCanvasElement) return '[canvas]';
        if (typeof HTMLImageElement !== 'undefined' && val instanceof HTMLImageElement) return '[image]';
        if (typeof HTMLMediaElement !== 'undefined' && val instanceof HTMLMediaElement) return '[media]';
        if (seen.has(val)) return '[circular]';
        seen.add(val);
        return val;
      }) || '';
    } catch (_) {
      return String((v && v.id) || '');
    }
  }

  function textureCacheId(o) {
    return [String(frameOverride && frameOverride.trackId || ''), String(o && o.type), String(o && o.id)].join(':');
  }

  function objectDrawKey(o, b, frameIndex) {
    return [
      String(frameIndex),
      String(frameOverride && frameOverride.trackId || ''),
      String(textureScale),
      String(maxTexture),
      b.left, b.top, b.right, b.bottom,
      stableStringify(theme),
      stableStringify(o)
    ].join('|');
  }

  function touchTextureCache(cacheId) {
    var entry = textureCache.get(cacheId);
    if (!entry) return;
    textureCache.delete(cacheId);
    textureCache.set(cacheId, entry);
  }

  function pruneTextureCache() {
    while (textureCache.size > TEXTURE_CACHE_LIMIT) {
      var oldestId = textureCache.keys().next().value;
      var old = textureCache.get(oldestId);
      textureCache.delete(oldestId);
      if (!old) continue;
      try { old.texture.dispose(); } catch (_) {}
      try { old.material.dispose(); } catch (_) {}
    }
  }

  function makeObjectTexture(o, list, frameIndex) {
    var b = getRenderBounds(o);
    var pad = 28;
    var minX = b.left - pad;
    var minY = b.top - pad;
    var maxX = b.right + pad;
    var maxY = b.bottom + pad;
    var wWorld = Math.max(1, maxX - minX);
    var hWorld = Math.max(1, maxY - minY);

    var k = textureScale;
    if (wWorld * k > maxTexture) k = maxTexture / wWorld;
    if (hWorld * k > maxTexture) k = maxTexture / hWorld;
    var cw = Math.max(1, Math.ceil(wWorld * k));
    var ch = Math.max(1, Math.ceil(hWorld * k));

    var cacheId = textureCacheId(o);
    var drawKey = objectDrawKey(o, b, frameIndex);
    var entry = textureCache.get(cacheId);
    if (entry && entry.key === drawKey && entry.canvas.width === cw && entry.canvas.height === ch) {
      touchTextureCache(cacheId);
      return entry;
    }

    if (!entry) {
      var cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      var tex = new THREE_LIB.CanvasTexture(cv);
      tex.minFilter = THREE_LIB.LinearFilter;
      tex.magFilter = THREE_LIB.LinearFilter;
      tex.generateMipmaps = false;
      try { tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); } catch (_) {}
      tex.userData = tex.userData || {};
      tex.userData.skfeCached = true;
      var mat = new THREE_LIB.MeshBasicMaterial({
        map: tex,
        transparent: true,
        side: THREE_LIB.DoubleSide,
        depthWrite: false
      });
      mat.userData = mat.userData || {};
      mat.userData.skfeCached = true;
      entry = { canvas: cv, texture: tex, material: mat, key: '', w: wWorld, h: hWorld, bounds: b };
      textureCache.set(cacheId, entry);
    } else {
      if (entry.canvas.width !== cw || entry.canvas.height !== ch) {
        entry.canvas.width = cw;
        entry.canvas.height = ch;
      }
      touchTextureCache(cacheId);
    }

    var octx = entry.canvas.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    octx.setTransform(k, 0, 0, k, -minX * k, -minY * k);

    var saved = deps.getCtx();
    deps.setCtx(octx);
    try {
      deps.renderScene([o], {
        isExporting: true,
        asGroupMembers: true,
        refList: list,
        frameIndex: frameIndex
      });
    } catch (e) {
      log('texture fail', o && o.type, o && o.id, e);
    } finally {
      deps.setCtx(saved);
    }

    entry.key = drawKey;
    entry.w = wWorld;
    entry.h = hWorld;
    entry.bounds = b;
    entry.texture.needsUpdate = true;
    return entry;
  }

  function decoratePlane(mesh, o) {
    /* makeObjectTexture 已按 getObjectBounds() 的最终世界尺寸渲染纹理，
       o.scale / o.rot 已经烘进贴图和 mesh 位置，这里不能再二次应用，
       否则火柴人会被放大两倍，脚底也会掉到地面网格以下。 */
    mesh.rotation.x = Number(o.space3d && o.space3d.rx) || 0;
    mesh.rotation.y = Number(o.space3d && o.space3d.ry) || 0;
    mesh.userData.skfeId = o.id;
    mesh.userData.skfeType = o.type;
    mesh.userData.skfeBillboard = !!(o.space3d && o.space3d.billboard);
    /* Billboard 只负责“面向摄像机”，rx / ry 作为相对相机的旋转偏移保留，
       否则面板改旋转参数时数值会变但画面完全没反应。 */
    mesh.userData.skfeBillboardRot = {
      x: finite(o.space3d && o.space3d.rx) || 0,
      y: finite(o.space3d && o.space3d.ry) || 0
    };
    return mesh;
  }

  /* 火柴人的 x / y 是盆骨点；其他元件仍沿用面片中心。 */
  function getDisplayAnchor(o, b) {
    if (o && o.type === 'figure') {
      return { x: finite(o.x) || 0, y: -(finite(o.y) || 0) };
    }
    return getDisplayCenter(b);
  }

  function getInternalAnchor(o, b) {
    if (o && o.type === 'figure') {
      return { x: finite(o.x) || 0, y: finite(o.y) || 0 };
    }
    return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  }

  function makePlaneAt(o, list, frameIndex, meshPos, geometryOffset) {
    var src = makeObjectTexture(o, list, frameIndex);
    var geometry = new THREE_LIB.PlaneGeometry(src.w, src.h);
    /* 纹理仍按面片中心绘制；几何体相对盆骨锚点偏移，旋转中心才是盆骨。 */
    if (geometryOffset) geometry.translate(geometryOffset.x, geometryOffset.y, 0);
    var mesh = new THREE_LIB.Mesh(geometry, src.material);
    mesh.position.copy(meshPos);
    mesh.renderOrder = 10;
    mesh.userData.skfeBounds = src.bounds;
    mesh.userData.skfeTexW = src.w;
    mesh.userData.skfeTexH = src.h;
    mesh.userData.skfeGeomOffset = geometryOffset ? { x: geometryOffset.x, y: geometryOffset.y } : { x: 0, y: 0 };
    return decoratePlane(mesh, o);
  }

  function makePlane(o, list, frameIndex, parentPos) {
    var b = getRenderBounds(o);
    var center = getDisplayCenter(b);
    var anchor = getDisplayAnchor(o, b);
    var meshPos = toThree(anchor.x, anchor.y, Number(o.space3d && o.space3d.z) || 0);
    var geometryOffset = null;
    if (o && o.type === 'figure') {
      geometryOffset = new THREE_LIB.Vector3(center.x - anchor.x, center.y - anchor.y, 0);
    }
    if (parentPos) meshPos.sub(parentPos);
    return makePlaneAt(o, list, frameIndex, meshPos, geometryOffset);
  }

  function disposeTree(obj) {
    if (!obj) return;
    obj.traverse(function (node) {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        var mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach(function (m) {
          if (m && m.userData && m.userData.skfeCached) return;
          if (m && m.map && !(m.map.userData && m.map.userData.skfeCached)) m.map.dispose();
          if (m) m.dispose();
        });
      }
    });
  }

  function clearWorld() {
    if (!worldRoot) return;
    while (worldRoot.children.length) {
      var c = worldRoot.children[0];
      worldRoot.remove(c);
      disposeTree(c);
    }
  }

  function buildSignature(list, frameIndex) {
    var parts = [String(frameIndex)];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o) continue;
      /* 火柴人的 bodyScale（身体比例）、extremity（小手小脚）、headAngle/headOffset
         等字段都会影响纹理，但旧场景签名只收了 o.a，导致这些参数改了 3D 不重建。
         这里对 figure 使用完整稳定签名；非 figure 仍保留原来的轻量签名。 */
      var visualSig = o.type === 'figure'
        ? stableStringify(o)
        : (JSON.stringify(o.space3d || null) + ',' + JSON.stringify(o.a || null));
      parts.push(String(o.id) + ':' + String(o.type) + ':' +
        String(o.x) + ',' + String(o.y) + ',' + String(o.rot) + ',' + String(o.scale) + ',' +
        String(o.mirror || false) + ',' + String(o.bx) + ',' + String(o.by) + ',' +
        String(o.groupId || '') + ',' + String(o.hidden || false) + ',' + visualSig);
    }
    return parts.join('|');
  }

  function syncScene() {
    if (!worldRoot || !deps) return;
    var frameIndex = frameOverride && Number.isFinite(frameOverride.index)
      ? frameOverride.index
      : (deps.AppState ? deps.AppState.currentFrameIndex : 0);
    var list = getRenderableList();
    /* 地面高度只在首次生成场景时取当前帧脚底，之后固定；网格范围仍可按元件移动自动拓展。 */
    if (!groundInitialized && list.length) {
      setGroundY(computeGroundY(list));
      groundInitialized = true;
    }
    ensureGridExtent(list);

    var sig = buildSignature(list, frameIndex);
    if (sig === lastSignature) return;
    lastSignature = sig;

    clearWorld();

    var carriers = list.filter(function (o) { return o.type === 'group'; });
    var carrierIds = {};
    carriers.forEach(function (g) { carrierIds[String(g.id)] = g; });

    var grouped = {};
    list.forEach(function (o) {
      var gid = o.groupId != null ? String(o.groupId) : '';
      if (gid && carrierIds[gid]) grouped[gid] = grouped[gid] || [];
      if (gid && carrierIds[gid]) grouped[gid].push(o);
    });

    var renderedIds = {};

    carriers.forEach(function (g) {
      var members = grouped[String(g.id)] || [];
      var parent = new THREE_LIB.Group();
      parent.userData.skfeBillboard = !!(g.space3d && g.space3d.billboard);
      parent.userData.skfeBillboardRot = {
        x: finite(g.space3d && g.space3d.rx) || 0,
        y: finite(g.space3d && g.space3d.ry) || 0
      };

      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      members.forEach(function (m) {
        var b = safeBounds(m);
        minX = Math.min(minX, b.left); maxX = Math.max(maxX, b.right);
        minY = Math.min(minY, b.top); maxY = Math.max(maxY, b.bottom);
      });
      if (!members.length) {
        var gb = safeBounds(g);
        minX = gb.left; maxX = gb.right; minY = gb.top; maxY = gb.bottom;
      }

      /* 父变换锚点沿用 2D 编组的 bx/by 语义：
         世界点 = T(当前锚点) · R(rot) · S(scale) · T(-建组锚点) · 成员原始坐标。
         Three 里把“建组锚点”放到父节点局部原点，成员局部坐标由 data 层换算。 */
      var ga = dataApi && dataApi.groupBase ? dataApi.groupBase(g) : { cx: 0, cy: 0, dx: 0, dy: 0, rot: 0, s: 1, mirror: false };
      var parentPos = toThree(ga.x, -ga.y, Number(g.space3d && g.space3d.z) || 0);
      parent.position.copy(parentPos);
      parent.rotation.x = Number(g.space3d && g.space3d.rx) || 0;
      parent.rotation.y = Number(g.space3d && g.space3d.ry) || 0;
      parent.rotation.z = -(ga.rot * Math.PI / 180);
      /* 组 scale 是 2D 画面缩放；3D 深度不能被一起放大，否则不同深度成员的相对关系会变。 */
      parent.scale.set(ga.mirror ? -ga.s : ga.s, ga.s, 1);

      if (members.length) {
        members.forEach(function (m) {
          var b = getRenderBounds(m);
          var internalCenter = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
          var internalAnchor = getInternalAnchor(m, b);
          /* 成员局部坐标 = 原始内部坐标 - 建组锚点；再翻成 Three 的 y 向上。
             火柴人成员用盆骨作为自身锚点，避免四肢动作改变时带动锚点。 */
          var meshPos = new THREE_LIB.Vector3(
            internalAnchor.x - ga.cx,
            ga.cy - internalAnchor.y,
            -(Number(m.space3d && m.space3d.z) || 0)
          );
          var geometryOffset = null;
          if (m && m.type === 'figure') {
            geometryOffset = new THREE_LIB.Vector3(
              internalCenter.x - internalAnchor.x,
              internalAnchor.y - internalCenter.y,
              0
            );
          }
          var mesh = makePlaneAt(m, list, frameIndex, meshPos, geometryOffset);
          parent.add(mesh);
          renderedIds[String(m.id)] = true;
        });
      } else {
        parent.add(makePlane(g, list, frameIndex, parentPos));
      }
      worldRoot.add(parent);
      renderedIds[String(g.id)] = true;
    });

    list.forEach(function (o) {
      if (renderedIds[String(o.id)]) return;

      /* 挂载元件：自己的 z/rx/ry 是相对挂载点的量；父火柴人的 3D 位移与旋转
         通过独立的父变换节点叠加，保证父级 z/rx/ry 改动时配饰一起走。 */
      var bindParent = getBindParent(o, list);
      if (bindParent) {
        var b = getRenderBounds(o);
        var center = getDisplayCenter(b);
        var pInternal = { x: finite(bindParent.x) || 0, y: finite(bindParent.y) || 0 };
        var pCarrier = findGroupCarrier(bindParent, list);
        if (pCarrier && dataApi && typeof dataApi.groupPointToWorld === 'function') {
          pInternal = dataApi.groupPointToWorld(pInternal, pCarrier);
        }
        var pAnchor = { x: pInternal.x, y: -pInternal.y };

        var holder = new THREE_LIB.Group();
        holder.position.copy(toThree(pAnchor.x, pAnchor.y, getObject3DDepth(bindParent, list)));
        holder.rotation.x = Number(bindParent.space3d && bindParent.space3d.rx) || 0;
        holder.rotation.y = Number(bindParent.space3d && bindParent.space3d.ry) || 0;

        var childPos = new THREE_LIB.Vector3(
          center.x - pAnchor.x,
          center.y - pAnchor.y,
          -getObject3DDepth(o, list)
        );
        holder.add(makePlaneAt(o, list, frameIndex, childPos, null));
        worldRoot.add(holder);
        renderedIds[String(o.id)] = true;
        return;
      }

      worldRoot.add(makePlane(o, list, frameIndex, null));
      renderedIds[String(o.id)] = true;
    });

    /* 等本帧所有对象都重新 touch 过缓存后再淘汰旧项，避免误删当前场景仍在用的材质。 */
    pruneTextureCache();
  }

  /* Billboard 面向的是作品里的“摄像机视角”参数，而不是自由观察视角。
     这样即使在自由观察状态下调镜头，元件朝向仍以导出取景为准。 */
  function getBillboardCameraQuaternion() {
    var cam = dataApi ? dataApi.getProjectState().camera3d : null;
    if (!cam || !cam.rotation) return activeCamera.quaternion.clone();
    var r = cam.rotation || {};
    return new THREE_LIB.Quaternion().setFromEuler(new THREE_LIB.Euler(
      (finite(r.x) || 0) * Math.PI / 180,
      (finite(r.y) || 0) * Math.PI / 180,
      (finite(r.z) || 0) * Math.PI / 180,
      'YXZ'
    ));
  }

  function applyBillboards() {
    if (!worldRoot || !activeCamera) return;
    worldRoot.updateMatrixWorld(true);
    var billboardCamQ = getBillboardCameraQuaternion();
    worldRoot.traverse(function (node) {
      if (!node.userData || !node.userData.skfeBillboard) return;
      var br = node.userData.skfeBillboardRot || { x: 0, y: 0 };
      var offsetQ = new THREE_LIB.Quaternion().setFromEuler(new THREE_LIB.Euler(
        finite(br.x) || 0, finite(br.y) || 0, 0, 'YXZ'
      ));
      var targetQ = billboardCamQ.clone().multiply(offsetQ);
      if (node.parent && node.parent !== worldRoot) {
        var parentQ = new THREE_LIB.Quaternion();
        node.parent.getWorldQuaternion(parentQ);
        parentQ.invert();
        node.quaternion.copy(parentQ.multiply(targetQ));
      } else {
        node.quaternion.copy(targetQ);
      }
    });
  }

  /* 阶段 4：把指定帧按「摄像机视角」渲染进普通 2D canvas。
     只临时借用编辑器 renderer，导出结束后恢复尺寸 / pixelRatio / 清屏色 / 观察状态；
     GIF / PNG / MP4 编码器拿到的仍然是普通 canvas，不需要改编码链路。 */
  function renderFrameToCanvas(targetCanvas, outW, outH, frameIndex, options) {
    if (!enabled || !renderer || !targetCanvas || !THREE_LIB) return false;
    options = options || {};

    var prevOverride = frameOverride;
    var prevViewport = exportViewport;
    var prevCameraView = cameraViewActive;
    var prevExportCameraFrame = exportCameraFrame;
    var prevMode = cameraMode;
    var prevFov = viewFov;
    var prevOrtho = viewOrthoHeight;
    var prevPixelRatio = renderer.getPixelRatio();
    var prevClearColor = new THREE_LIB.Color();
    try { renderer.getClearColor(prevClearColor); } catch (_) { prevClearColor.set('#000000'); }
    var prevClearAlpha = renderer.getClearAlpha();
    var prevMarkerVisible = cameraMarker ? cameraMarker.visible : null;
    var prevGizmoVisible = gizmoGroup ? gizmoGroup.visible : null;
    var prevGridVisible = grid ? grid.visible : null;
    var prevGridOpacity = grid && grid.material ? grid.material.opacity : null;

    try {
      frameOverride = {
        index: Number.isFinite(frameIndex) ? frameIndex : (deps.AppState ? deps.AppState.currentFrameIndex : 0),
        trackId: options.trackId == null ? null : options.trackId
      };
      exportViewport = { left: 0, top: 0, width: Math.max(1, outW | 0), height: Math.max(1, outH | 0) };
      cameraViewActive = true;

      /* 导出逐帧优先用 camera3d 虚拟轨求值结果，保证关键帧在视频里真的生效。 */
      var cam = options.camera3dFrame || getExportCamera();
      if (!cam && dataApi && dataApi.ensureCamera3D) cam = dataApi.ensureCamera3D();
      /* 关键：configureExportCamera() / updateCamera() 必须通过这里拿到当前帧机位，
         否则它们会退回 state.camera3d，导出就不是虚拟轨的全轨道视角。 */
      exportCameraFrame = cam;
      if (cam) configureExportCamera(cam);
      else setCameraMode('perspective');

      lastSignature = '';
      syncScene();
      applyBillboards();
      /* 跟随目标要在场景按目标帧重建后再算机位，确保逐帧导出也跟对位置。 */
      updateCamera();
      if (cameraMarker) cameraMarker.visible = false;
      /* 位移 / 旋转手柄只是编辑器辅助，任何导出都不允许入画。 */
      if (gizmoGroup) gizmoGroup.visible = false;
      /* 地面网格是导出辅助层：透明 PNG 可关闭，JPG / 视频按面板开关保留。
         GIF 只有 256 色，0.38 透明度的细线会被量化成断续小点，导出时可显式提高不透明度。 */
      if (grid) {
        grid.visible = options.showGrid !== false;
        if (Number.isFinite(options.gridOpacity)) {
          grid.material.opacity = clamp(options.gridOpacity, 0, 1);
        }
      }

      targetCanvas.width = exportViewport.width;
      targetCanvas.height = exportViewport.height;
      var tctx = targetCanvas.getContext('2d');
      if (!tctx) return false;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      if (!options.transparent) {
        tctx.fillStyle = options.bgColor || (deps && deps.getPageBgColor && deps.getPageBgColor()) || theme.canvasBg || '#ffffff';
        tctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
      }

      renderer.setPixelRatio(1);
      renderer.setSize(targetCanvas.width, targetCanvas.height, false);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, targetCanvas.width, targetCanvas.height);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(scene, activeCamera);
      tctx.drawImage(renderer.domElement, 0, 0, targetCanvas.width, targetCanvas.height);
      return true;
    } finally {
      frameOverride = prevOverride;
      exportViewport = prevViewport;
      cameraViewActive = prevCameraView;
      exportCameraFrame = prevExportCameraFrame;
      viewFov = prevFov;
      viewOrthoHeight = prevOrtho;
      setCameraMode(prevMode);
      try { renderer.setClearColor(prevClearColor, prevClearAlpha); } catch (_) {}
      try { renderer.setPixelRatio(prevPixelRatio); } catch (_) {}
      if (cameraMarker && prevMarkerVisible != null) cameraMarker.visible = prevMarkerVisible;
      if (gizmoGroup && prevGizmoVisible != null) gizmoGroup.visible = prevGizmoVisible;
      if (grid && prevGridVisible != null) grid.visible = prevGridVisible;
      if (grid && grid.material && Number.isFinite(prevGridOpacity)) {
        grid.material.opacity = prevGridOpacity;
      }
      /* 导出临时改过 renderer 尺寸，强制下一次 resize 真正恢复绘制缓冲。 */
      lastStageW = 0;
      lastStageH = 0;
      try { resize(); } catch (_) {}
    }
  }

  function renderFrame() {
    if (!enabled || !renderer) return;
    syncScene();
    applyBillboards();
    updateCamera();
    updateCameraMarker();
    syncGizmo();
    updateCameraMask();

    var useCamViewport = !!(cameraViewActive && !exportViewport);
    if (useCamViewport) {
      /* 摄像机视角：整块画布只渲染摄像机画面。遮罩只是取景框外同一画面的透明覆盖，
         不再用观察视角画外圈，否则遮罩内外会是两个不同画面。 */
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
      renderer.clear(true, true, true);
    } else {
      renderer.setScissorTest(false);
    }
    renderer.render(scene, activeCamera);
    drawJointOverlay();
  }

  function loop() {
    if (!enabled) return;
    resize();
    renderFrame();
    rafId = requestAnimationFrame(loop);
  }

  function setEnabled(on) {
    if (on) ensureRenderer();
    if (!renderer) return;

    enabled = !!on;
    if (dataApi) dataApi.setMode(enabled);
    document.body.classList.toggle('space3d-mode', enabled);
    if (btn) {
      btn.classList.toggle('on', enabled);
      btn.textContent = enabled ? '关闭 3D（返回 2D）' : '开启 3D';
      btn.title = enabled ? '关闭 3D，返回 2D' : '开启 3D 查看模式';
    }
    canvas.style.display = enabled ? 'block' : 'none';
    canvas.style.pointerEvents = enabled ? 'auto' : 'none';
    if (jointOverlay) jointOverlay.style.display = 'none';
    if (!enabled) { jointHandles = []; jointDrag = null; gizmoDrag = null; pendingSelect = null; if (gizmoGroup) gizmoGroup.visible = false; }

    if (enabled) {
      /* 每次重新进入 3D 都视为一次新的场景生成：重新取一次当前帧脚底，随后固定。 */
      groundInitialized = false;
      applyTheme();
      lastSignature = '';
      resize();
      fitViewToScene();
      renderFrame();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(rafId);
      rafId = 0;
      cameraViewActive = false;
      clearWorld();
      lastSignature = '';
      updateCamera();
      updateCameraMask();
    }

    if (deps && deps.requestRender) deps.requestRender();
  }

  function isEnabled() { return enabled; }

  function getProjectState() {
    return dataApi ? dataApi.getProjectState() : null;
  }

  function applyProjectState(raw) {
    if (!dataApi) return;
    var state = dataApi.setProjectState(raw);
    var cam = state && state.camera3d;
    if (cam) {
      setCameraMode(cam.mode);
      viewFov = clamp(Number(cam.fov) || 50, 10, 120);
    }
    var want = !!(state && state.space3dMode);
    if (initialized && want !== enabled) setEnabled(want);
  }

  function getExportCamera() {
    var state = getProjectState();
    return state ? state.camera3d : null;
  }

  function distanceOfPointers() {
    var arr = Array.from(pointers.values());
    if (arr.length < 2) return 0;
    return Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
  }

  function midpointOfPointers() {
    var arr = Array.from(pointers.values());
    if (arr.length < 2) return { x: 0, y: 0 };
    return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
  }

  function readCameraData() {
    if (!dataApi) return null;
    var cam = dataApi.getProjectState().camera3d;
    if (cam && cam.targetId) {
      /* 跟随里所有手势都以“当前实际机位”为基准，写回时再换算成相对偏移。 */
      var eff = getEffectiveCameraPosition(cam);
      cam.position = { x: eff.x, y: eff.y, z: eff.z };
    }
    return cam;
  }

  function writeCameraData(cam) {
    if (!dataApi || !cam) return;
    if (cam.targetId) {
      var target = getObjectWorldPosition(cam.targetId);
      if (target) {
        var p = cam.position || {};
        var px = finite(p.x), py = finite(p.y), pz = finite(p.z);
        cam.targetOffset = {
          x: (px == null ? 0 : px) - target.x,
          y: (py == null ? 0 : py) - target.y,
          z: (pz == null ? -1200 : pz) - target.z
        };
      }
    }
    var state = dataApi.getProjectState();
    state.camera3d = cam;
    dataApi.setProjectState(state);
    applyExportCameraLive();
    if (deps && deps.requestSyncUI) deps.requestSyncUI();
  }

  function cameraBasis(rotation) {
    var q = new THREE_LIB.Quaternion().setFromEuler(new THREE_LIB.Euler(
      (finite(rotation && rotation.x) || 0) * Math.PI / 180,
      (finite(rotation && rotation.y) || 0) * Math.PI / 180,
      (finite(rotation && rotation.z) || 0) * Math.PI / 180,
      'YXZ'
    ));
    return {
      right: new THREE_LIB.Vector3(1, 0, 0).applyQuaternion(q),
      up: new THREE_LIB.Vector3(0, 1, 0).applyQuaternion(q),
      forward: new THREE_LIB.Vector3(0, 0, -1).applyQuaternion(q)
    };
  }

  function cameraPanScale(cam) {
    /* 平移灵敏度跟随摄像机自身深度，不再做上下限截断；深度为 0 时退化为 1。 */
    var z = Math.abs(finite(cam && cam.position && cam.position.z) || 0);
    var s = z / 1200;
    return Number.isFinite(s) && s !== 0 ? s : 1;
  }

  function findObjectMesh(id) {
    var found = null;
    if (!worldRoot || id == null) return null;
    worldRoot.traverse(function (node) {
      if (found || !node.isMesh || !node.userData) return;
      if (String(node.userData.skfeId) === String(id)) found = node;
    });
    return found;
  }

  function findFigureMesh(id) {
    var mesh = findObjectMesh(id);
    return (mesh && mesh.userData.skfeType === 'figure') ? mesh : null;
  }

  /* renderScene 把火柴人的 rot / mirror 烘进 2D 纹理：
     绘制变换是 平移锚点 → 旋转 → 镜像 → 平移回，锚点就是盆骨 o.x/o.y。
     因此关节点投影到纹理时必须先做同样变换，否则 Z 旋转后蓝点会脱离火柴人。 */
  function figurePointToTexture(o, p2) {
    if (!o) return p2;
    var ax = finite(o.x) || 0;
    var ay = finite(o.y) || 0;
    var x = p2.x, y = p2.y;
    if (o.mirror) x = ax * 2 - x;
    var rot = (finite(o.rot) || 0) * Math.PI / 180;
    if (rot) {
      var dx = x - ax, dy = y - ay;
      var c = Math.cos(rot), s = Math.sin(rot);
      x = ax + c * dx - s * dy;
      y = ay + s * dx + c * dy;
    }
    return { x: x, y: y };
  }

  function figureTextureToPoint(o, tex) {
    if (!o) return tex;
    var ax = finite(o.x) || 0;
    var ay = finite(o.y) || 0;
    var x = tex.x, y = tex.y;
    var rot = (finite(o.rot) || 0) * Math.PI / 180;
    if (rot) {
      var dx = x - ax, dy = y - ay;
      var c = Math.cos(rot), s = Math.sin(rot);
      x = ax + c * dx + s * dy;
      y = ay - s * dx + c * dy;
    }
    if (o.mirror) x = ax * 2 - x;
    return { x: x, y: y };
  }

  /* 关节点半径不能直接写死像素：观察视角缩放后，蓝点必须跟火柴人一起变大 / 变小。
     这里量一段火柴人自身世界长度的投影像素，按固定比例换算半径。 */
  function projectedLengthPx(mesh, a, b, rect) {
    if (!mesh || !activeCamera || !rect) return 0;
    activeCamera.updateMatrixWorld(true);
    var pa = a.clone().applyMatrix4(mesh.matrixWorld).project(activeCamera);
    var pb = b.clone().applyMatrix4(mesh.matrixWorld).project(activeCamera);
    if (!isFinite(pa.x) || !isFinite(pa.y) || !isFinite(pb.x) || !isFinite(pb.y)) return 0;
    var ax = rect.left + (pa.x * 0.5 + 0.5) * rect.width;
    var ay = rect.top + (-pa.y * 0.5 + 0.5) * rect.height;
    var bx = rect.left + (pb.x * 0.5 + 0.5) * rect.width;
    var by = rect.top + (-pb.y * 0.5 + 0.5) * rect.height;
    return Math.hypot(bx - ax, by - ay);
  }

  function jointPointToScreen(mesh, p2, rect, o) {
    var b = mesh.userData.skfeBounds;
    var texW = mesh.userData.skfeTexW || 1;
    var texH = mesh.userData.skfeTexH || 1;
    var off = mesh.userData.skfeGeomOffset || { x: 0, y: 0 };
    if (!b) return null;
    /* p2 是火柴人内部关节坐标，先按烘进纹理的 rot/mirror 变换。 */
    var tp = (mesh.userData.skfeType === 'figure') ? figurePointToTexture(o, p2) : p2;
    var u = (tp.x - b.left) / Math.max(0.0001, b.right - b.left);
    var v = (tp.y - b.top) / Math.max(0.0001, b.bottom - b.top);
    var local = new THREE_LIB.Vector3(
      off.x + (u - 0.5) * texW,
      off.y + (0.5 - v) * texH,
      0
    );
    var world = local.applyMatrix4(mesh.matrixWorld);
    var ndc = world.clone().project(activeCamera);
    if (!isFinite(ndc.x) || !isFinite(ndc.y)) return null;
    return {
      x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height
    };
  }

  function screenToFigureLocal(mesh, clientX, clientY, o) {
    var r = canvas ? canvas.getBoundingClientRect() : getStageRect();
    if (!r.width || !r.height) return null;
    var ndc = new THREE_LIB.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    var ray = new THREE_LIB.Raycaster();
    ray.setFromCamera(ndc, activeCamera);
    var hits = ray.intersectObject(mesh, false);
    if (!hits.length) return null;
    var local = mesh.worldToLocal(hits[0].point.clone());
    var b = mesh.userData.skfeBounds;
    var texW = mesh.userData.skfeTexW || 1;
    var texH = mesh.userData.skfeTexH || 1;
    var off = mesh.userData.skfeGeomOffset || { x: 0, y: 0 };
    if (!b) return null;
    var u = (local.x - off.x) / texW + 0.5;
    var v = 0.5 - (local.y - off.y) / texH;
    var tex = {
      x: b.left + u * (b.right - b.left),
      y: b.top + v * (b.bottom - b.top)
    };
    /* 纹理坐标是旋转 / 镜像后的结果，反变换回火柴人内部关节坐标。 */
    return (mesh.userData.skfeType === 'figure') ? figureTextureToPoint(o, tex) : tex;
  }

  function syncGizmo() {
    if (!gizmoGroup) return;
    var sel = (deps && deps.AppState) ? deps.AppState.selected : null;
    var show = !!(enabled && !exportViewport && sel && !sel.locked &&
      !(deps.getIsPlaying && deps.getIsPlaying()) &&
      !['camera', 'audioClip', 'video'].includes(sel.type));
    if (!show) {
      gizmoGroup.visible = false;
      return;
    }
    var mesh = findObjectMesh(sel.id);
    if (!mesh) {
      gizmoGroup.visible = false;
      return;
    }
    var pos = new THREE_LIB.Vector3();
    mesh.getWorldPosition(pos);
    var dist = activeCamera.position ? activeCamera.position.distanceTo(pos) : orbit.distance;
    var size = clamp(dist * 0.11, 45, 260);

    /* Blender 风格手柄偏在元件右侧，不压住元件自身。
       右方向取当前观察 / 摄像机视角的屏幕右轴，随视角一起转。 */
    activeCamera.updateMatrixWorld(true);
    var right = new THREE_LIB.Vector3().setFromMatrixColumn(activeCamera.matrix, 0);
    if (right.lengthSq() < 0.000001) right.set(1, 0, 0);
    right.normalize();
    /* 拖拽期间冻结手柄中心：元件旋转后锚点可能微动，如果每帧重算中心，
       旋转角度会突然跳一下，表现为元件瞬间变大 / 蓝色环点不中。 */
    if (gizmoDrag && gizmoDrag.center) {
      gizmoGroup.position.copy(gizmoDrag.center);
    } else {
      gizmoGroup.position.copy(pos).addScaledVector(right, size * 0.62);
    }
    gizmoGroup.visible = true;

    Object.keys(GIZMO_AXES).forEach(function (axis) {
      var cfg = GIZMO_AXES[axis];
      if (gizmoMode === 'translate') {
        if (cfg.arrow) {
          cfg.arrow.visible = true;
          cfg.arrow.setLength(size, size * 0.24, size * 0.12);
        }
        if (cfg.ring) cfg.ring.visible = false;
        if (cfg.ringHit) cfg.ringHit.visible = false;
      } else {
        if (cfg.arrow) cfg.arrow.visible = false;
        if (cfg.ring) {
          cfg.ring.visible = true;
          /* 直径与线宽按同一系数缩小，保持粗细比例。 */
          cfg.ring.scale.setScalar(size / GIZMO_RING_SCALE_DIV);
        }
        if (cfg.ringHit) {
          cfg.ringHit.visible = true;
          cfg.ringHit.scale.setScalar(size / GIZMO_RING_SCALE_DIV);
        }
      }
    });
    gizmoGroup.updateMatrixWorld(true);
  }

  function pointerRay(clientX, clientY) {
    if (!canvas) return null;
    var r = cameraViewActive ? getStageRect() : canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    /* 摄像机视角下整块画布是同一画面，但只有取景框内参与点选 / 手柄命中。 */
    if (cameraViewActive) {
      var crop = getCameraViewportRect();
      if (clientX < crop.left || clientX > crop.left + crop.width ||
          clientY < crop.top || clientY > crop.top + crop.height) return null;
    }
    var ndc = new THREE_LIB.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    var ray = new THREE_LIB.Raycaster();
    ray.setFromCamera(ndc, activeCamera);
    return ray;
  }

  function hitGizmo(clientX, clientY) {
    if (!gizmoGroup || !gizmoGroup.visible) return null;
    var ray = pointerRay(clientX, clientY);
    if (!ray) return null;
    gizmoGroup.updateMatrixWorld(true);
    var hits = ray.intersectObject(gizmoGroup, true);
    for (var i = 0; i < hits.length; i++) {
      var node = hits[i].object;
      while (node && node !== gizmoGroup) {
        if (node.userData && node.userData.gizmoAxis && node.userData.gizmoKind === gizmoMode) {
          return { axis: node.userData.gizmoAxis, kind: node.userData.gizmoKind, point: hits[i].point.clone(), clientX: clientX, clientY: clientY };
        }
        node = node.parent;
      }
    }
    return null;
  }

  /* 从 3D 画面直接点选元件：raycast 命中的面片带 skfeId，再回当前帧渲染列表找真实对象。 */
  function pickObjectAt(clientX, clientY) {
    if (!worldRoot || !deps || !deps.select) return null;
    var ray = pointerRay(clientX, clientY);
    if (!ray) return null;
    worldRoot.updateMatrixWorld(true);
    var hits = ray.intersectObject(worldRoot, true);
    if (!hits.length) return null;
    var byId = {};
    getRenderableList().forEach(function (o) { if (o && o.id != null) byId[String(o.id)] = o; });
    for (var i = 0; i < hits.length; i++) {
      var node = hits[i].object;
      while (node && node !== worldRoot) {
        var id = node.userData && node.userData.skfeId;
        if (id != null && byId[String(id)]) return byId[String(id)];
        node = node.parent;
      }
    }
    return null;
  }

  function intersectPlane(ray, plane) {
    if (!ray || !plane) return null;
    var out = new THREE_LIB.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }

  function beginGizmoDrag(hit, pointerId) {
    if (!deps || !deps.getObject3DTransform || !deps.setObject3DTransform) return false;
    var start = deps.getObject3DTransform();
    if (!start) return false;
    var cfg = GIZMO_AXES[hit.axis];
    if (!cfg) return false;
    var axis = new THREE_LIB.Vector3(
      (hit.kind === 'translate' ? cfg.dir : cfg.rotDir)[0],
      (hit.kind === 'translate' ? cfg.dir : cfg.rotDir)[1],
      (hit.kind === 'translate' ? cfg.dir : cfg.rotDir)[2]
    ).normalize();
    var drag = {
      axis: hit.axis,
      kind: hit.kind,
      pointerId: pointerId,
      axisVec: axis,
      start: start,
      plane: null,
      startPoint: null,
      startVec: null,
      center: null,
      lastAngle: 0,
      lastValue: 0
    };
    if (hit.kind === 'translate') {
      var camDir = activeCamera.position.clone().sub(hit.point).normalize();
      var normal = new THREE_LIB.Vector3().crossVectors(axis, camDir).cross(axis);
      if (normal.lengthSq() < 0.000001) normal.copy(camDir);
      normal.normalize();
      drag.plane = new THREE_LIB.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
      drag.startPoint = hit.point.clone();
    } else {
      /* 冻结中心，整段旋转拖拽都围绕同一个点算角度，避免元件锚点微动引起跳变。 */
      drag.center = gizmoGroup.position.clone();
      drag.plane = new THREE_LIB.Plane().setFromNormalAndCoplanarPoint(axis, drag.center);
      var ray = pointerRay(hit.clientX, hit.clientY);
      var p0 = intersectPlane(ray, drag.plane);
      drag.startVec = p0 ? p0.sub(drag.center).normalize() : new THREE_LIB.Vector3(1, 0, 0);
      if (drag.startVec.lengthSq() < 0.000001) drag.startVec.set(1, 0, 0);
      drag.lastAngle = 0;
      drag.lastValue = Number.isFinite(start[cfg.propRot]) ? start[cfg.propRot] : 0;
    }
    gizmoDrag = drag;
    if (deps.begin3DTransformDrag) deps.begin3DTransformDrag();
    return true;
  }

  function updateGizmoDrag(e) {
    if (!gizmoDrag || !deps || !deps.setObject3DTransform) return;
    var ray = pointerRay(e.clientX, e.clientY);
    var cur = intersectPlane(ray, gizmoDrag.plane);
    if (!cur) return;
    var cfg = GIZMO_AXES[gizmoDrag.axis];
    var patch = {};
    if (gizmoDrag.kind === 'translate') {
      var delta = cur.sub(gizmoDrag.startPoint).dot(gizmoDrag.axisVec);
      /* Z 的 cfg.dir 已经是 Three 内部 -Z，与 space3d.z 正向一致，不能再取反。 */
      patch[cfg.propPos] = gizmoDrag.start[cfg.propPos] + delta;
    } else {
      /* 用拖拽开始时冻结的中心，不用实时 gizmoGroup.position。 */
      var v = cur.sub(gizmoDrag.center || gizmoGroup.position);
      if (v.lengthSq() < 0.000001) return;
      v.normalize();
      var cross = new THREE_LIB.Vector3().crossVectors(gizmoDrag.startVec, v);
      var curAngle = Math.atan2(gizmoDrag.axisVec.dot(cross), gizmoDrag.startVec.dot(v));
      /* 用相邻角度差累计，避免 ±180° 绕回时 atan2 从 +π 跳到 -π 造成整圈突跳。 */
      var step = curAngle - gizmoDrag.lastAngle;
      if (step > Math.PI) step -= Math.PI * 2;
      else if (step < -Math.PI) step += Math.PI * 2;
      gizmoDrag.lastAngle = curAngle;
      gizmoDrag.lastValue += step * 180 / Math.PI;
      patch[cfg.propRot] = gizmoDrag.lastValue;
    }
    deps.setObject3DTransform(patch);
  }

  function endGizmoDrag() {
    if (!gizmoDrag) return;
    gizmoDrag = null;
    if (deps && deps.end3DTransformDrag) deps.end3DTransformDrag();
  }

  function drawJointOverlay() {
    jointHandles = [];
    if (!jointOverlay || !jointCtx) return;
    var show = !!(enabled && !exportViewport && !cameraViewActive && deps && deps.AppState &&
      deps.AppState.selected && deps.AppState.selected.type === 'figure' &&
      !deps.AppState.selected.locked && !(deps.getIsPlaying && deps.getIsPlaying()));
    if (!show) { jointOverlay.style.display = 'none'; return; }

    var r = getStageRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.max(1, Math.round(r.width * dpr));
    var ph = Math.max(1, Math.round(r.height * dpr));
    if (jointOverlay.width !== pw || jointOverlay.height !== ph) {
      jointOverlay.width = pw;
      jointOverlay.height = ph;
    }
    jointOverlay.style.display = 'block';
    jointOverlay.style.left = r.left + 'px';
    jointOverlay.style.top = r.top + 'px';
    jointOverlay.style.width = r.width + 'px';
    jointOverlay.style.height = r.height + 'px';
    jointCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    jointCtx.clearRect(0, 0, r.width, r.height);

    var o = deps.AppState.selected;
    var mesh = findFigureMesh(o.id);
    if (!mesh || !deps.getFigureHandles) return;
    var handles = deps.getFigureHandles(o) || [];
    var texH = Math.max(1, Number(mesh.userData.skfeTexH) || 1);
    var figPx = projectedLengthPx(
      mesh,
      new THREE_LIB.Vector3(0, texH / 2, 0),
      new THREE_LIB.Vector3(0, -texH / 2, 0),
      r
    );
    /* 半径随火柴人投影高度变化：视角拉近 / 推远时，蓝点相对人物大小保持恒定。 */
    var radius = clamp(figPx * (isMobile ? 0.010 : 0.008), isMobile ? 2.5 : 2, isMobile ? 15 : 12);
    var lineWidth = clamp(radius * 0.28, 1, 2.4);
    var hitRadius = Math.max(radius + (isMobile ? 6 : 4), radius * 1.7);
    handles.forEach(function (h) {
      if (!h || !h.p) return;
      var s = jointPointToScreen(mesh, h.p, r, o);
      if (!s || s.x < r.left - 20 || s.x > r.left + r.width + 20 ||
          s.y < r.top - 20 || s.y > r.top + r.height + 20) return;
      jointHandles.push({ name: h.name, x: s.x, y: s.y, o: o, hitRadius: hitRadius });
      jointCtx.beginPath();
      jointCtx.arc(s.x, s.y, radius, 0, Math.PI * 2);
      jointCtx.fillStyle = 'rgba(74,144,255,.85)';
      jointCtx.fill();
      jointCtx.lineWidth = lineWidth;
      jointCtx.strokeStyle = '#fff';
      jointCtx.stroke();
    });
  }

  function hitJointHandle(clientX, clientY) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < jointHandles.length; i++) {
      var h = jointHandles[i];
      var d = Math.hypot(clientX - h.x, clientY - h.y);
      var limit = h.hitRadius || (isMobile ? 18 : 12);
      if (d < limit && d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  function onPointerDown(e) {
    if (!enabled) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size > 1) pendingSelect = null;

    /* 阶段 5：3D 变换手柄点击优先级最高，其次关节手柄，最后才是视角手势。 */
    if (!gizmoDrag && pointers.size === 1 &&
        (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen')) {
      var gh = hitGizmo(e.clientX, e.clientY);
      if (gh && beginGizmoDrag(gh, e.pointerId)) {
        gesture = null;
        pinchStart = null;
        pendingSelect = null;
        canvas.style.cursor = 'grabbing';
        return;
      }
    }

    /* 阶段 5：命中火柴人关节手柄时优先拖关节，未命中才走原有观察 / 摄像机手势。 */
    if (!cameraViewActive && !jointDrag && pointers.size === 1 &&
        (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen')) {
      var h = hitJointHandle(e.clientX, e.clientY);
      if (h && deps && deps.beginFigureJointDrag) {
        var st = deps.beginFigureJointDrag(h.o, h.name);
        if (st) {
          jointDrag = { state: st, pointerId: e.pointerId, mesh: findFigureMesh(h.o.id), o: h.o };
          gesture = null;
          pinchStart = null;
          pendingSelect = null;
          canvas.style.cursor = 'grabbing';
          return;
        }
      }
    }

    /* 阶段 5：未命中手柄时先记下这次点选，抬起时若没有明显拖动就选中命中的元件。
       这样左键拖拽观察视角仍然照常工作，不会因为起手落在面片上就误选。 */
    if (!pendingSelect && pointers.size === 1 &&
        (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen')) {
      pendingSelect = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        obj: pickObjectAt(e.clientX, e.clientY),
        moved: false
      };
    }

    /* 摄像机视角：单指 / 左键旋转；双指平移+缩放；中键 / 右键平移。 */
    if (cameraViewActive) {
      var cam0 = readCameraData();
      if (!cam0) return;
      if (pointers.size >= 2) {
        gesture = { type: 'cameraPinch' };
        pinchStart = { camera: true, dist: Math.max(1, distanceOfPointers()), mid: midpointOfPointers(), cam: cam0 };
        return;
      }
      if (e.button === 1 || e.button === 2) {
        gesture = { type: 'cameraPan', x: e.clientX, y: e.clientY, cam: cam0 };
        canvas.style.cursor = 'grabbing';
        return;
      }
      gesture = { type: 'cameraOrbit', x: e.clientX, y: e.clientY, cam: cam0 };
      return;
    }

    if (pointers.size >= 2) {
      gesture = { type: 'pinch' };
      pinchStart = {
        dist: Math.max(1, distanceOfPointers()),
        mid: midpointOfPointers(),
        distance: orbit.distance,
        target: Object.assign({}, orbit.target)
      };
      return;
    }

    /* 自由观察视角：PC 鼠标中键平移，移动端双指平移。 */
    if (e.button === 1) {
      gesture = {
        type: 'pan',
        x: e.clientX,
        y: e.clientY,
        target: Object.assign({}, orbit.target)
      };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0 || e.pointerType === 'touch') {
      gesture = { type: 'orbit', x: e.clientX, y: e.clientY, theta: orbit.theta, phi: orbit.phi };
    }
  }

  function onPointerMove(e) {
    if (!enabled || !pointers.has(e.pointerId)) return;
    e.preventDefault();
    var p = pointers.get(e.pointerId);
    p.x = e.clientX;
    p.y = e.clientY;

    if (pendingSelect && e.pointerId === pendingSelect.pointerId &&
        Math.hypot(e.clientX - pendingSelect.x, e.clientY - pendingSelect.y) > 6) {
      pendingSelect.moved = true;
    }

    if (gizmoDrag && e.pointerId === gizmoDrag.pointerId) {
      updateGizmoDrag(e);
      return;
    }

    if (jointDrag && e.pointerId === jointDrag.pointerId) {
      var lp = jointDrag.mesh ? screenToFigureLocal(jointDrag.mesh, e.clientX, e.clientY, jointDrag.o) : null;
      if (lp && deps && deps.applyFigureJointDrag) deps.applyFigureJointDrag(jointDrag.state, lp);
      return;
    }

    if (cameraViewActive && gesture && gesture.type === 'cameraOrbit') {
      var camOrbit = readCameraData();
      if (!camOrbit) return;
      camOrbit.rotation = camOrbit.rotation || { x: 0, y: 0, z: 0 };
      /* 与自由观察的左键拖拽保持同向同速：0.006 rad/px ≈ 0.34°/px。 */
      /* 摄像机视角拖拽不再把角度夹在 ±180°，超过后继续按真实累计值旋转。 */
      camOrbit.rotation.y = (finite(gesture.cam.rotation && gesture.cam.rotation.y) || 0) - (e.clientX - gesture.x) * 0.34;
      camOrbit.rotation.x = (finite(gesture.cam.rotation && gesture.cam.rotation.x) || 0) - (e.clientY - gesture.y) * 0.34;
      writeCameraData(camOrbit);
      return;
    }

    if (cameraViewActive && gesture && gesture.type === 'cameraPan') {
      var camPan = readCameraData();
      if (!camPan) return;
      var basisPan = cameraBasis(gesture.cam.rotation);
      var panScaleCam = cameraPanScale(gesture.cam);
      var dxCam = e.clientX - gesture.x;
      var dyCam = e.clientY - gesture.y;
      var basePan = gesture.cam.position || { x: 0, y: 0, z: -1200 };
      camPan.position = {
        x: (finite(basePan.x) || 0) - basisPan.right.x * dxCam * panScaleCam + basisPan.up.x * dyCam * panScaleCam,
        y: (finite(basePan.y) || 0) - basisPan.right.y * dxCam * panScaleCam + basisPan.up.y * dyCam * panScaleCam,
        z: (finite(basePan.z) == null ? -1200 : finite(basePan.z)) - basisPan.right.z * dxCam * panScaleCam + basisPan.up.z * dyCam * panScaleCam
      };
      writeCameraData(camPan);
      return;
    }

    if (cameraViewActive && gesture && gesture.type === 'cameraPinch' && pointers.size >= 2) {
      var camPinch = readCameraData();
      if (!camPinch || !pinchStart || !pinchStart.cam) return;
      var basisPinch = cameraBasis(pinchStart.cam.rotation);
      var pinchScale = cameraPanScale(pinchStart.cam);
      var nowDist = Math.max(1, distanceOfPointers());
      var midNow = midpointOfPointers();
      var dxPinch = midNow.x - pinchStart.mid.x;
      var dyPinch = midNow.y - pinchStart.mid.y;
      var dolly = (pinchStart.dist - nowDist) * pinchScale * 2;
      var basePinch = pinchStart.cam.position || { x: 0, y: 0, z: -1200 };
      camPinch.position = {
        x: (finite(basePinch.x) || 0) - basisPinch.right.x * dxPinch * pinchScale + basisPinch.up.x * dyPinch * pinchScale + basisPinch.forward.x * dolly,
        y: (finite(basePinch.y) || 0) - basisPinch.right.y * dxPinch * pinchScale + basisPinch.up.y * dyPinch * pinchScale + basisPinch.forward.y * dolly,
        z: (finite(basePinch.z) == null ? -1200 : finite(basePinch.z)) - basisPinch.right.z * dxPinch * pinchScale + basisPinch.up.z * dyPinch * pinchScale + basisPinch.forward.z * dolly
      };
      writeCameraData(camPinch);
      return;
    }

    if (gesture && gesture.type === 'pinch' && pointers.size >= 2) {
      var dist = Math.max(1, distanceOfPointers());
      var nextDistance = pinchStart.distance * (pinchStart.dist / dist);
      orbit.distance = Number.isFinite(nextDistance) && nextDistance !== 0 ? nextDistance : pinchStart.distance;

      var mid = midpointOfPointers();
      var dx = mid.x - pinchStart.mid.x;
      var dy = mid.y - pinchStart.mid.y;
      var right = new THREE_LIB.Vector3().setFromMatrixColumn(activeCamera.matrix, 0);
      var up = new THREE_LIB.Vector3().setFromMatrixColumn(activeCamera.matrix, 1);
      var scale = orbit.distance * 0.0014;
      orbit.target.x = pinchStart.target.x - right.x * dx * scale + up.x * dy * scale;
      orbit.target.y = pinchStart.target.y - right.y * dx * scale + up.y * dy * scale;
      orbit.target.z = pinchStart.target.z - right.z * dx * scale + up.z * dy * scale;
      updateCamera();
      return;
    }

    if (gesture && gesture.type === 'pan') {
      var dxPan = e.clientX - gesture.x;
      var dyPan = e.clientY - gesture.y;
      var rightPan = new THREE_LIB.Vector3().setFromMatrixColumn(activeCamera.matrix, 0);
      var upPan = new THREE_LIB.Vector3().setFromMatrixColumn(activeCamera.matrix, 1);
      var panScale = orbit.distance * 0.0014;
      orbit.target.x = gesture.target.x - rightPan.x * dxPan * panScale + upPan.x * dyPan * panScale;
      orbit.target.y = gesture.target.y - rightPan.y * dxPan * panScale + upPan.y * dyPan * panScale;
      orbit.target.z = gesture.target.z - rightPan.z * dxPan * panScale + upPan.z * dyPan * panScale;
      updateCamera();
      return;
    }

    if (gesture && gesture.type === 'orbit') {
      orbit.theta = gesture.theta - (e.clientX - gesture.x) * 0.006;
      orbit.phi = gesture.phi - (e.clientY - gesture.y) * 0.006;
      updateCamera();
    }
  }

  function onPointerUp(e) {
    if (gizmoDrag && e.pointerId === gizmoDrag.pointerId) {
      endGizmoDrag();
      if (canvas) canvas.style.cursor = '';
    }
    if (jointDrag && e.pointerId === jointDrag.pointerId) {
      jointDrag = null;
      if (deps && deps.endFigureJointDrag) deps.endFigureJointDrag();
      if (canvas) canvas.style.cursor = '';
    }
    if (pendingSelect && e.pointerId === pendingSelect.pointerId) {
      var pick = pendingSelect;
      pendingSelect = null;
      if (!pick.moved && pick.obj && deps && deps.select) deps.select(pick.obj);
    }
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      gesture = null;
      pinchStart = null;
      if (canvas) canvas.style.cursor = '';
    } else if (pointers.size === 1) {
      var remain = pointers.values().next().value;
      if (cameraViewActive) {
        gesture = { type: 'cameraOrbit', x: remain.x, y: remain.y, cam: readCameraData() };
      } else {
        gesture = { type: 'orbit', x: remain.x, y: remain.y, theta: orbit.theta, phi: orbit.phi };
      }
      pinchStart = null;
      if (canvas) canvas.style.cursor = '';
    }
  }

  function onAuxClick(e) {
    if (!enabled) return;
    e.preventDefault();
  }

  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    if (cameraViewActive) {
      var cam = readCameraData();
      if (!cam) return;
      var basis = cameraBasis(cam.rotation);
      var p = cam.position || {};
      var zoomBase = Math.max(1, Math.abs(finite(p.z) || 0));
      /* 与自由观察滚轮一致：每格约 10% 的前后移动，方向相反即为拉远。 */
      var dolly = (e.deltaY > 0 ? -1 : 1) * zoomBase * 0.1;
      cam.position = {
        x: (finite(p.x) || 0) + basis.forward.x * dolly,
        y: (finite(p.y) || 0) + basis.forward.y * dolly,
        z: (finite(p.z) == null ? -1200 : finite(p.z)) + basis.forward.z * dolly
      };
      writeCameraData(cam);
      return;
    }
    orbit.distance *= e.deltaY > 0 ? 1.1 : 0.9;
    updateCamera();
  }

  function resetView() {
    cameraViewActive = false;
    orbit.theta = 0.42;
    orbit.phi = 1.25;
    fitViewToScene();
  }

  /* 进入摄像机视角：直接按工程里的位置 / 旋转参数驱动相机。 */
  function alignViewToExportCamera() {
    enterCameraView();
  }

  function isCameraView() { return cameraViewActive; }

  function init(d) {
    if (initialized) return;
    deps = d || {};
    initialized = true;

    /* 3D 入口已迁到底部栏面板；按钮点击由 app.js 绑定，本模块只负责状态显示。
       保留同一 ID 是为了让面板里的总开关能直接反映模块状态。 */
    btn = document.getElementById('btnSpace3DMode');
    /* 自动存档 / 工程恢复可能早于 init 写入状态；初始化完成后补应用一次。 */
    if (dataApi && dataApi.getProjectState().space3dMode) setEnabled(true);
    if (!THREE_LIB) {
      btn && (btn.disabled = true);
      log('Three.js 未加载，3D 模式不可用');
    }
  }

  root.systems.space3d = {
    init: init,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    renderFrame: renderFrame,
    renderFrameToCanvas: renderFrameToCanvas,
    applyTheme: applyTheme,
    getProjectState: getProjectState,
    applyProjectState: applyProjectState,
    getExportCamera: getExportCamera,
    getObjectWorldPosition: getObjectWorldPosition,
    getEffectiveCameraPosition: getEffectiveCameraPosition,
    bindExportCameraTarget: bindExportCameraTarget,
    setCameraMode: setCameraMode,
    alignViewToExportCamera: alignViewToExportCamera,
    applyExportCameraLive: applyExportCameraLive,
    isCameraView: isCameraView,
    resetView: resetView,
    resize: resize,
    updateCameraMask: updateCameraMask,
    setGizmoMode: function (mode) {
      gizmoMode = (mode === 'rotate' || mode === 'translate') ? mode : 'translate';
      if (enabled) renderFrame();
      return gizmoMode;
    },
    getGizmoMode: function () { return gizmoMode; }
  };
})();
