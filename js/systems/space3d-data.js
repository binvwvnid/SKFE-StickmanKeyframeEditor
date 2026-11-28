/* ============================================================================
   SKFE 轻量 3D 模式 · 阶段 3 数据层
   ----------------------------------------------------------------------------
   职责：
   1. 工程级 / 元件级 3D 默认值；
   2. 旧工程无感兼容：读取时补默认值，不批量写回；
   3. 关键帧通用插值实现，由 keyframes.js 的 postInterpolate 钩子调用；
   4. 编组父变换的局部坐标换算，供 3D 场景层复用。

   本文件不引用 Three.js，也不写 DOM，保持纯数据。
   ============================================================================ */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined') ? window : globalThis;
  root.SKFE = root.SKFE || {};
  root.SKFE.systems = root.SKFE.systems || {};

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function finite(v, fallback) {
    if (v == null || v === '') return fallback;
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function projectDefaults() {
    return {
      space3dMode: false,
      /* v7.9.5：2D / 3D 摄像机拆成两个独立工程槽位。 */
      camera2d: {
        cameraId: null,
        zoom: 1,
        offset: { x: 0, y: 0 }
      },
      camera3d: {
        name: '3D 摄像机',
        mode: 'perspective',
        fov: 50,
        near: 1,
        far: 20000,
        orthoHeight: 1080,
        /* 3D 摄像机取景尺寸：与 2D 一样按宽高比取框，默认 16:9。 */
        width: 1920,
        height: 1080,
        position: { x: 0, y: 0, z: -1200 },
        rotation: { x: 0, y: 0, z: 0 },
        targetId: null,
        targetOffset: { x: 0, y: 0, z: 0 }
      }
    };
  }

  function objectDefaults() {
    return {
      z: 0,
      rx: 0,
      ry: 0,
      billboard: false,
      parentCameraId: null
    };
  }

  function normalizeProject(raw) {
    var out = projectDefaults();
    if (!raw || typeof raw !== 'object') return out;

    /* 允许两种形态：工程顶层平铺字段，或嵌套在 raw.space3d 里。 */
    var input = (raw.space3d && typeof raw.space3d === 'object') ? raw.space3d : raw;
    out.space3dMode = !!input.space3dMode;

    var c2 = input.camera2d;
    if (c2 && typeof c2 === 'object') {
      out.camera2d.cameraId = c2.cameraId == null ? null : c2.cameraId;
      out.camera2d.zoom = finite(c2.zoom, out.camera2d.zoom);
      if (c2.offset && typeof c2.offset === 'object') {
        out.camera2d.offset.x = finite(c2.offset.x, 0);
        out.camera2d.offset.y = finite(c2.offset.y, 0);
      }
    }

    var src = input.camera3d;
    if (src && typeof src === 'object') {
      var dst = out.camera3d;
      dst.name = typeof src.name === 'string' && src.name.trim() ? src.name : dst.name;
      if (src.mode === 'orthographic' || src.mode === 'perspective') dst.mode = src.mode;
      dst.fov = finite(src.fov, dst.fov);
      dst.near = finite(src.near, dst.near);
      dst.far = finite(src.far, dst.far);
      dst.orthoHeight = finite(src.orthoHeight, dst.orthoHeight);
      dst.width = Math.max(1, finite(src.width, dst.width));
      dst.height = Math.max(1, finite(src.height, dst.height));
      if (src.position && typeof src.position === 'object') {
        dst.position.x = finite(src.position.x, dst.position.x);
        dst.position.y = finite(src.position.y, dst.position.y);
        dst.position.z = finite(src.position.z, dst.position.z);
      }
      if (src.rotation && typeof src.rotation === 'object') {
        dst.rotation.x = finite(src.rotation.x, dst.rotation.x);
        dst.rotation.y = finite(src.rotation.y, dst.rotation.y);
        dst.rotation.z = finite(src.rotation.z, dst.rotation.z);
      }
      if (src.targetOffset && typeof src.targetOffset === 'object') {
        dst.targetOffset.x = finite(src.targetOffset.x, dst.targetOffset.x);
        dst.targetOffset.y = finite(src.targetOffset.y, dst.targetOffset.y);
        dst.targetOffset.z = finite(src.targetOffset.z, dst.targetOffset.z);
      }
      dst.targetId = src.targetId == null ? null : src.targetId;
    }
    return out;
  }

  /* 读取对象的 3D 状态：旧对象没有 space3d 时返回默认值，但不写回对象。 */
  function readObjectState(o) {
    var out = objectDefaults();
    var s = o && o.space3d;
    if (!s || typeof s !== 'object') return out;
    out.z = finite(s.z, out.z);
    out.rx = finite(s.rx, out.rx);
    out.ry = finite(s.ry, out.ry);
    out.billboard = !!s.billboard;
    out.parentCameraId = s.parentCameraId == null ? null : s.parentCameraId;
    return out;
  }

  /* 用户实际编辑 3D 属性时才补默认值；旧工程打开 / 工程恢复不调用，避免批量写回。 */
  function ensureObjectState(o) {
    if (!o || typeof o !== 'object') return null;
    if (!o.space3d || typeof o.space3d !== 'object') o.space3d = objectDefaults();
    var d = objectDefaults();
    Object.keys(d).forEach(function (k) {
      if (o.space3d[k] === undefined) o.space3d[k] = d[k];
    });
    return o.space3d;
  }

  /* rx / ry 在作品数据里是弧度；面板显示时才换算成角度。 */
  function angleLerp(a, b, u) {
    var TWO_PI = Math.PI * 2;
    var delta = b - a;
    while (delta > Math.PI) delta -= TWO_PI;
    while (delta < -Math.PI) delta += TWO_PI;
    return a + delta * u;
  }

  function numLerp(a, b, u) {
    return a + (b - a) * u;
  }

  /* keyframes.js 通用钩子实现。obj 是 o1 的克隆；只有任一端真的有 space3d
     字段时才写入，保证旧工程派生帧不会被静默补字段。 */
  function interpolateInto(obj, o1, o2, prog) {
    if (!obj || !o1 || !o2) return;
    var has3d = !!(o1.space3d || o2.space3d);
    if (!has3d) return;

    var a = readObjectState(o1);
    var b = readObjectState(o2);
    var p = prog || function () { return 0; };

    ensureObjectState(obj);
    obj.space3d.z = numLerp(a.z, b.z, p('space3d.z'));
    obj.space3d.rx = angleLerp(a.rx, b.rx, p('space3d.rx'));
    obj.space3d.ry = angleLerp(a.ry, b.ry, p('space3d.ry'));
    /* 离散字段沿用起点；不在派生帧里做无意义的“半布尔值”。 */
    obj.space3d.billboard = !!a.billboard;
    obj.space3d.parentCameraId = a.parentCameraId;
  }

  /* 编组父变换：与 app.js 的 groupOuterAffine() 同语义，坐标仍是 SKFE 内部 y 向下。 */
  function groupBase(g) {
    if (!g || typeof g !== 'object') {
      return { cx: 0, cy: 0, dx: 0, dy: 0, x: 0, y: 0, rot: 0, s: 1, mirror: false };
    }
    var cx = finite(g.bx, finite(g.x, 0));
    var cy = finite(g.by, finite(g.y, 0));
    var x = finite(g.x, cx);
    var y = finite(g.y, cy);
    return {
      cx: cx,
      cy: cy,
      dx: x - cx,
      dy: y - cy,
      x: x,
      y: y,
      rot: finite(g.rot, 0),
      s: finite(g.scale, 1),
      mirror: !!g.mirror
    };
  }

  /* 内部坐标 p -> 组父变换后的内部坐标。 */
  function groupPointToWorld(p, g) {
    var a = groupBase(g);
    var x = p.x - a.cx;
    var y = p.y - a.cy;
    if (a.mirror) x = -x;
    x *= a.s; y *= a.s;
    var r = a.rot * Math.PI / 180;
    var cos = Math.cos(r), sin = Math.sin(r);
    var rx = x * cos - y * sin;
    var ry = x * sin + y * cos;
    return { x: rx + a.cx + a.dx, y: ry + a.cy + a.dy };
  }

  /* 组父变换后的内部坐标 p -> 组内局部坐标（逆变换）。 */
  function groupPointToLocal(p, g) {
    var a = groupBase(g);
    var x = p.x - (a.cx + a.dx);
    var y = p.y - (a.cy + a.dy);
    var r = -a.rot * Math.PI / 180;
    var cos = Math.cos(r), sin = Math.sin(r);
    var rx = x * cos - y * sin;
    var ry = x * sin + y * cos;
    if (a.s !== 0) { rx /= a.s; ry /= a.s; }
    if (a.mirror) rx = -rx;
    return { x: rx + a.cx, y: ry + a.cy };
  }

  /* Stage 3 工程级状态保存在数据模块，app.js 只做序列化转发。 */
  var projectState = projectDefaults();

  function getProjectState() {
    return clone(projectState);
  }

  function setProjectState(raw) {
    projectState = normalizeProject(raw);
    return clone(projectState);
  }

  function setMode(on) {
    projectState.space3dMode = !!on;
  }

  /* 进入 3D 时确保工程里一定有一份 3D 摄像机设置。
     这里只补默认值，不新增作品相机元件，也不写入关键帧。 */
  function ensureCamera3D() {
    if (!projectState.camera3d || typeof projectState.camera3d !== 'object') {
      projectState.camera3d = projectDefaults().camera3d;
    }
    return clone(projectState.camera3d);
  }

  function ensureCamera2D() {
    if (!projectState.camera2d || typeof projectState.camera2d !== 'object') {
      projectState.camera2d = projectDefaults().camera2d;
    }
    return clone(projectState.camera2d);
  }

  var api = {
    projectDefaults: projectDefaults,
    objectDefaults: objectDefaults,
    normalizeProject: normalizeProject,
    getProjectState: getProjectState,
    setProjectState: setProjectState,
    setMode: setMode,
    ensureCamera2D: ensureCamera2D,
    ensureCamera3D: ensureCamera3D,
    readObjectState: readObjectState,
    ensureObjectState: ensureObjectState,
    interpolateInto: interpolateInto,
    groupBase: groupBase,
    groupPointToWorld: groupPointToWorld,
    groupPointToLocal: groupPointToLocal
  };

  root.SKFE.systems.space3dData = api;

  /* 注册到 keyframes.js 的通用钩子。keyframes.js 不含任何 3D 专用逻辑。
     落帧前补齐字段（含摄像机），派生帧求值时再统一插值。 */
  var KF = root.SKFE.systems.keyframes;
  if (KF && typeof KF.setPreMarkKey === 'function') {
    KF.setPreMarkKey(ensureObjectState);
  }
  if (KF && typeof KF.setPostInterpolate === 'function') {
    KF.setPostInterpolate(interpolateInto);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
