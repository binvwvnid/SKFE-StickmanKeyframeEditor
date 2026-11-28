(function () {
  'use strict';

  if (!window.THREE) {
    document.body.innerHTML = '<div style="padding:24px;color:#b00">Three.js 加载失败，请确认 vendor/three.min.js 存在。</div>';
    return;
  }

  var isMobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OpenHarmony/i.test(navigator.userAgent) ||
    ('ontouchstart' in window && window.innerWidth < 900);
  var maxTexture = isMobile ? 1024 : 2048;
  var domainState = {
    x: 0,
    displayY: 0,
    zDepth: 0
  };

  function toThree(x, displayY, zDepth) {
    return new THREE.Vector3(x, displayY, -zDepth);
  }

  function fromThree(v) {
    domainState.x = v.x;
    domainState.displayY = v.y;
    domainState.zDepth = -v.z;
    return domainState;
  }

  var $ = function (id) { return document.getElementById(id); };
  var host = $('canvasHost');
  var chipMode = $('chipMode');
  var chipFps = $('chipFps');
  var selObject = $('selObject');
  var selJoint = $('selJoint');
  var inputMode = $('inputMode');
  var uvText = $('uvText');
  var hitBadge = $('hitBadge');
  var objectList = $('objectList');
  var groupState = $('groupState');

  var theme = {
    bg: '#f7f5ea',
    alpha: 1,
    primary: '#ed9e94',
    grid: '#b92d5d',
    text: '#551029'
  };

  var renderer = new THREE.WebGLRenderer({
    antialias: !isMobile,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
  renderer.domElement.style.touchAction = 'none';
  host.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  var objects = [];
  var groupDemo = new THREE.Group();
  scene.add(groupDemo);
  var grouped = false;

  var perspective = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  var orthographic = new THREE.OrthographicCamera(-500, 500, 300, -300, 1, 20000);
  var cameraMode = 'perspective';
  var activeCamera = perspective;

  var orbit = {
    theta: 0.38,
    phi: 1.28,
    distance: 980,
    target: new THREE.Vector3(0, 20, 0)
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function updateCamera() {
    orbit.phi = clamp(orbit.phi, 0.12, Math.PI - 0.12);
    orbit.distance = clamp(orbit.distance, 240, 3600);

    var sp = Math.sin(orbit.phi);
    var pos = new THREE.Vector3(
      orbit.distance * sp * Math.sin(orbit.theta),
      orbit.distance * Math.cos(orbit.phi),
      orbit.distance * sp * Math.cos(orbit.theta)
    ).add(orbit.target);

    activeCamera.position.copy(pos);
    activeCamera.lookAt(orbit.target);

    var w = host.clientWidth || 900;
    var h = host.clientHeight || 600;
    var aspect = w / Math.max(1, h);
    var viewH = orbit.distance * 0.72;

    perspective.aspect = aspect;
    perspective.updateProjectionMatrix();

    orthographic.left = -viewH * aspect / 2;
    orthographic.right = viewH * aspect / 2;
    orthographic.top = viewH / 2;
    orthographic.bottom = -viewH / 2;
    orthographic.updateProjectionMatrix();
  }

  function setCameraMode(mode) {
    cameraMode = mode;
    activeCamera = mode === 'orthographic' ? orthographic : perspective;
    chipMode.textContent = mode === 'orthographic' ? '正交' : '透视';
    $('btnOrthographic').classList.toggle('active', mode === 'orthographic');
    $('btnPerspective').classList.toggle('active', mode === 'perspective');
    updateCamera();
  }

  function resetView() {
    orbit.theta = 0.38;
    orbit.phi = 1.28;
    orbit.distance = 980;
    orbit.target.set(0, 20, 0);
    updateCamera();
  }

  function makeStickmanTexture() {
    var cv = document.createElement('canvas');
    var size = Math.min(512, maxTexture);
    cv.width = size;
    cv.height = size;
    var c = cv.getContext('2d');
    var k = size / 512;

    c.clearRect(0, 0, size, size);
    c.save();
    c.scale(k, k);
    c.strokeStyle = '#551029';
    c.fillStyle = '#ed9e94';
    c.lineWidth = 20;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    c.beginPath();
    c.moveTo(256, 210);
    c.lineTo(256, 320);
    c.stroke();

    c.beginPath();
    c.moveTo(256, 240);
    c.lineTo(170, 290);
    c.moveTo(256, 240);
    c.lineTo(342, 290);
    c.stroke();

    c.beginPath();
    c.moveTo(256, 320);
    c.lineTo(210, 430);
    c.moveTo(256, 320);
    c.lineTo(302, 430);
    c.stroke();

    c.beginPath();
    c.arc(256, 150, 46, 0, Math.PI * 2);
    c.fill();
    c.stroke();

    c.fillStyle = '#551029';
    c.font = 'bold 30px sans-serif';
    c.textAlign = 'center';
    c.fillText('火柴人卡片', 256, 495);

    c.fillStyle = '#ffffff';
    c.strokeStyle = '#b92d5d';
    c.lineWidth = 4;
    var joints = {
      head: { x: 256, y: 150, r: 42 },
      torso: { x: 256, y: 250, r: 36 },
      handL: { x: 170, y: 290, r: 34 },
      handR: { x: 342, y: 290, r: 34 },
      footL: { x: 210, y: 430, r: 34 },
      footR: { x: 302, y: 430, r: 34 }
    };
    Object.keys(joints).forEach(function (key) {
      var j = joints[key];
      c.beginPath();
      c.arc(j.x, j.y, 9, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    });
    c.restore();

    return { canvas: cv, texture: new THREE.CanvasTexture(cv), joints: joints, size: 512 };
  }

  function makeCardTexture(title, colorA, colorB) {
    var cv = document.createElement('canvas');
    var size = Math.min(512, maxTexture);
    cv.width = size;
    cv.height = Math.round(size * 0.62);
    var c = cv.getContext('2d');
    var g = c.createLinearGradient(0, 0, cv.width, cv.height);
    g.addColorStop(0, colorA);
    g.addColorStop(1, colorB);
    c.fillStyle = g;
    c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = 'rgba(85,16,41,.55)';
    c.lineWidth = 8;
    c.strokeRect(4, 4, cv.width - 8, cv.height - 8);
    c.fillStyle = '#551029';
    c.font = 'bold 42px sans-serif';
    c.textAlign = 'center';
    c.fillText(title, cv.width / 2, cv.height / 2 + 14);
    return { canvas: cv, texture: new THREE.CanvasTexture(cv) };
  }

  function addPlane(opts) {
    var src = opts.source;
    var tex = src.texture;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(opts.w, opts.h), mat);
    mesh.position.copy(toThree(opts.x, opts.displayY, opts.zDepth));
    mesh.userData = {
      name: opts.name,
      sourceCanvas: src.canvas,
      sourceSize: src.size || Math.max(src.canvas.width, src.canvas.height),
      joints: src.joints || null,
      baseX: opts.x,
      baseDisplayY: opts.displayY,
      baseZDepth: opts.zDepth
    };
    scene.add(mesh);
    objects.push(mesh);
    return mesh;
  }

  var figure = addPlane({
    name: '火柴人卡片',
    source: makeStickmanTexture(),
    w: 260, h: 260,
    x: -180, displayY: 20, zDepth: 0
  });

  var farCard = addPlane({
    name: '远景图片卡片',
    source: makeCardTexture('远景 Z=+240', '#f9c3c5', '#ffffff'),
    w: 300, h: 186,
    x: 190, displayY: 120, zDepth: 240
  });

  var nearCard = addPlane({
    name: '近景形状卡片',
    source: makeCardTexture('近景 Z=-160', '#ffd9d5', '#ed9e94'),
    w: 300, h: 186,
    x: 220, displayY: -100, zDepth: -160
  });

  var selectionBox = new THREE.BoxHelper(figure, new THREE.Color(theme.primary));
  selectionBox.visible = false;
  scene.add(selectionBox);
  var selected = null;

  var grid = null;
  function rebuildGrid() {
    if (grid) {
      scene.remove(grid);
      if (grid.geometry) grid.geometry.dispose();
      if (grid.material) grid.material.dispose();
    }
    grid = new THREE.GridHelper(2400, 48, new THREE.Color(theme.primary), new THREE.Color(theme.grid));
    grid.position.y = -185;
    grid.material.transparent = true;
    grid.material.opacity = 0.42;
    scene.add(grid);
  }

  function applyTheme(cfg) {
    if (cfg) Object.assign(theme, cfg);
    document.documentElement.style.setProperty('--bg-page', theme.bg);
    document.documentElement.style.setProperty('--text-main', theme.text);
    document.documentElement.style.setProperty('--text-sub', theme.grid);
    document.documentElement.style.setProperty('--primary', theme.primary);
    document.documentElement.style.setProperty('--border', theme.primary);

    renderer.setClearColor(new THREE.Color(theme.bg), theme.alpha);
    rebuildGrid();
    if (selectionBox && selectionBox.material) selectionBox.material.color.set(theme.primary);

    $('themeBg').value = theme.bg;
    $('themeBgVal').textContent = theme.bg;
    $('themeAlpha').value = String(theme.alpha);
    $('themeAlphaVal').textContent = Number(theme.alpha).toFixed(2);
    $('themePrimary').value = theme.primary;
    $('themePrimaryVal').textContent = theme.primary;
    $('themeGrid').value = theme.grid;
    $('themeGridVal').textContent = theme.grid;
    $('themeText').value = theme.text;
    $('themeTextVal').textContent = theme.text;
  }

  function selectObject(mesh, jointName) {
    selected = mesh || null;
    if (selectionBox) {
      selectionBox.visible = !!selected;
      if (selected) selectionBox.setFromObject(selected);
    }
    selObject.textContent = selected ? selected.userData.name : '无';
    selJoint.textContent = jointName || '无';
    Array.prototype.forEach.call(objectList.children, function (el) {
      el.classList.toggle('active', !!selected && el.dataset.id === String(selected.id));
    });
  }

  function buildObjectList() {
    objectList.innerHTML = '';
    objects.forEach(function (mesh) {
      var d = fromThree(mesh.position);
      var el = document.createElement('div');
      el.className = 'object-item';
      el.dataset.id = String(mesh.id);
      el.innerHTML = '<span>' + mesh.userData.name + '</span><small>Z ' + d.zDepth.toFixed(0) + '</small>';
      el.addEventListener('click', function () { selectObject(mesh, null); });
      objectList.appendChild(el);
    });
  }

  var raycaster = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var pointers = new Map();
  var gesture = null;
  var dragPlane = new THREE.Plane();
  var dragOffset = new THREE.Vector3();
  var pinchStart = null;

  function setNdcFromEvent(e) {
    var r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1;
  }

  function pickAt(e) {
    setNdcFromEvent(e);
    raycaster.setFromCamera(ndc, activeCamera);
    var hits = raycaster.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  }

  function jointFromUv(mesh, uv) {
    var joints = mesh.userData.joints;
    if (!joints || !uv) return null;
    var px = uv.x * mesh.userData.sourceSize;
    var py = (1 - uv.y) * mesh.userData.sourceSize;
    var best = null;
    var bestD = Infinity;
    Object.keys(joints).forEach(function (key) {
      var j = joints[key];
      var d = Math.hypot(px - j.x, py - j.y);
      if (d <= j.r && d < bestD) { best = key; bestD = d; }
    });
    return best;
  }

  function beginPlaneDrag(mesh, e) {
    setNdcFromEvent(e);
    raycaster.setFromCamera(ndc, activeCamera);
    var normal = new THREE.Vector3();
    activeCamera.getWorldDirection(normal);
    dragPlane.setFromNormalAndCoplanarPoint(normal, mesh.position);
    var p = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, p)) dragOffset.copy(mesh.position).sub(p);
    else dragOffset.set(0, 0, 0);
  }

  function updatePlaneDrag(mesh, e) {
    setNdcFromEvent(e);
    raycaster.setFromCamera(ndc, activeCamera);
    var p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(dragPlane, p)) return;
    mesh.position.copy(p).add(dragOffset);
    var d = fromThree(mesh.position);
    mesh.userData.zDepth = d.zDepth;
    if (selectionBox.visible && selected === mesh) selectionBox.setFromObject(mesh);
    buildObjectList();
  }

  function distanceOfPointers() {
    var arr = Array.from(pointers.values());
    if (arr.length < 2) return 0;
    return Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
  }

  function midpointOfPointers() {
    var arr = Array.from(pointers.values());
    return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
  }

  function onPointerDown(e) {
    e.preventDefault();
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });

    if (pointers.size >= 2) {
      gesture = { type: 'pinch' };
      pinchStart = {
        dist: Math.max(1, distanceOfPointers()),
        mid: midpointOfPointers(),
        orbitDistance: orbit.distance,
        target: orbit.target.clone()
      };
      inputMode.textContent = '双指缩放 / 平移';
      return;
    }

    var hit = pickAt(e);
    if (!hit) {
      gesture = { type: 'orbit', x: e.clientX, y: e.clientY, theta: orbit.theta, phi: orbit.phi };
      inputMode.textContent = '旋转视角';
      hitBadge.textContent = '空白 → 视角';
      return;
    }

    var mesh = hit.object;
    var joint = jointFromUv(mesh, hit.uv);
    uvText.textContent = hit.uv ? (hit.uv.x.toFixed(2) + ', ' + hit.uv.y.toFixed(2)) : '--';
    selectObject(mesh, joint);

    if (joint) {
      gesture = { type: 'joint' };
      inputMode.textContent = '命中关节';
      hitBadge.textContent = '关节：' + joint;
    } else {
      gesture = { type: 'drag', mesh: mesh };
      beginPlaneDrag(mesh, e);
      inputMode.textContent = '拖动面片';
      hitBadge.textContent = '面片：' + mesh.userData.name;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    var p = pointers.get(e.pointerId);
    p.x = e.clientX;
    p.y = e.clientY;

    if (gesture && gesture.type === 'pinch' && pointers.size >= 2) {
      var dist = Math.max(1, distanceOfPointers());
      var ratio = pinchStart.dist / dist;
      orbit.distance = clamp(pinchStart.orbitDistance * ratio, 240, 3600);

      var mid = midpointOfPointers();
      var dx = mid.x - pinchStart.mid.x;
      var dy = mid.y - pinchStart.mid.y;
      var right = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrix, 0);
      var up = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrix, 1);
      var scale = orbit.distance * 0.0014;
      orbit.target.copy(pinchStart.target)
        .addScaledVector(right, -dx * scale)
        .addScaledVector(up, dy * scale);
      updateCamera();
      return;
    }

    if (!gesture) return;

    if (gesture.type === 'orbit') {
      var ddx = e.clientX - gesture.x;
      var ddy = e.clientY - gesture.y;
      orbit.theta = gesture.theta - ddx * 0.006;
      orbit.phi = gesture.phi - ddy * 0.006;
      updateCamera();
    } else if (gesture.type === 'drag') {
      updatePlaneDrag(gesture.mesh, e);
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      gesture = null;
      pinchStart = null;
      inputMode.textContent = '待机';
    } else if (pointers.size === 1) {
      gesture = { type: 'orbit', x: e.clientX, y: e.clientY, theta: orbit.theta, phi: orbit.phi };
      pinchStart = null;
      inputMode.textContent = '旋转视角';
    }
  }

  function onWheel(e) {
    e.preventDefault();
    orbit.distance *= e.deltaY > 0 ? 1.1 : 0.9;
    updateCamera();
  }

  function exportPng() {
    var oldSize = renderer.getSize(new THREE.Vector2());
    var oldRatio = renderer.getPixelRatio();
    var oldAspect = perspective.aspect;
    var w = 1280;
    var h = 720;

    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    perspective.aspect = w / h;
    perspective.updateProjectionMatrix();
    var viewH = orbit.distance * 0.72;
    orthographic.left = -viewH * (w / h) / 2;
    orthographic.right = viewH * (w / h) / 2;
    orthographic.top = viewH / 2;
    orthographic.bottom = -viewH / 2;
    orthographic.updateProjectionMatrix();
    renderer.render(scene, activeCamera);

    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(renderer.domElement, 0, 0, w, h);

    var a = document.createElement('a');
    a.download = 'space3d-validator-' + Date.now() + '.png';
    a.href = out.toDataURL('image/png');
    a.click();

    renderer.setPixelRatio(oldRatio);
    renderer.setSize(oldSize.x, oldSize.y, false);
    perspective.aspect = oldAspect;
    perspective.updateProjectionMatrix();
    updateCamera();
  }

  function toggleGroup() {
    if (!grouped) {
      groupDemo.attach(farCard);
      groupDemo.attach(nearCard);
      grouped = true;
      groupState.textContent = '已编组：远景 + 近景';
    } else {
      scene.attach(farCard);
      scene.attach(nearCard);
      grouped = false;
      groupState.textContent = '未编组';
    }
    buildObjectList();
  }

  function rotateGroup() {
    if (!grouped) toggleGroup();
    groupDemo.rotation.y += THREE.MathUtils.degToRad(15);
    if (selectionBox.visible && selected) selectionBox.setFromObject(selected);
    buildObjectList();
  }

  function bindThemeInputs() {
    $('themeBg').addEventListener('input', function () { theme.bg = this.value; applyTheme(); });
    $('themeAlpha').addEventListener('input', function () { theme.alpha = Number(this.value); applyTheme(); });
    $('themePrimary').addEventListener('input', function () { theme.primary = this.value; applyTheme(); });
    $('themeGrid').addEventListener('input', function () { theme.grid = this.value; applyTheme(); });
    $('themeText').addEventListener('input', function () { theme.text = this.value; applyTheme(); });
    $('btnApplyDemoTheme').addEventListener('click', function () {
      applyTheme({ bg: '#f7f5ea', alpha: 1, primary: '#ed9e94', grid: '#b92d5d', text: '#551029' });
    });
    $('btnApplyDarkDemo').addEventListener('click', function () {
      applyTheme({ bg: '#1f2230', alpha: 1, primary: '#7dd3fc', grid: '#60a5fa', text: '#e5e7eb' });
    });
  }

  $('btnPerspective').addEventListener('click', function () { setCameraMode('perspective'); });
  $('btnOrthographic').addEventListener('click', function () { setCameraMode('orthographic'); });
  $('btnResetView').addEventListener('click', resetView);
  $('btnExportPng').addEventListener('click', exportPng);
  $('btnClearSelection').addEventListener('click', function () {
    selectObject(null, null);
    hitBadge.textContent = '未命中';
    uvText.textContent = '--';
  });
  $('btnGroupDemo').addEventListener('click', toggleGroup);
  $('btnRotateGroup').addEventListener('click', rotateGroup);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  function resize() {
    var w = Math.max(1, host.clientWidth);
    var h = Math.max(1, host.clientHeight);
    var need = renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio()) ||
      renderer.domElement.height !== Math.floor(h * renderer.getPixelRatio());
    if (need) renderer.setSize(w, h, false);
    updateCamera();
  }

  applyTheme();
  buildObjectList();
  setCameraMode('perspective');
  resetView();
  resize();

  $('deviceText').textContent = isMobile ? '移动端参数' : '桌面端参数';
  $('dprText').textContent = String(renderer.getPixelRatio());
  $('aaText').textContent = isMobile ? '关闭' : '开启';
  $('texText').textContent = maxTexture + 'px';

  var frames = 0;
  var lastFps = performance.now();
  function loop(t) {
    resize();
    renderer.render(scene, activeCamera);
    frames++;
    if (t - lastFps >= 1000) {
      chipFps.textContent = 'FPS ' + Math.round(frames * 1000 / (t - lastFps));
      frames = 0;
      lastFps = t;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
