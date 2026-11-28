// js/systems/camera.js
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.camera = (function () {
  'use strict';

  let D = null;
  /* 取景框外遮罩固定 70% 透明（即 30% 不透明）。
     以前做成滑条只改变 pink 的深浅，因为遮罩下面根本没有内容，看起来像透明度失效；
     现在 2D / 3D 都会先绘制取景框外的底层画面，再用这层 30% 遮罩压暗。 */
  const CAMERA_MASK_ALPHA = 0.3;
  function init(deps) { D = deps; }

function makeCamera(x, y) {
  return {
    id: D.nextUid(), type: 'camera', cameraMode: '2d', name: '2D 摄像机',
    x, y, w: 640, h: 360, scale: 1, rot: 0, alpha: 1,
    locked: false, layer: 9000, eraser: []
  };
}

function findCameraObject() {
  for (const id in D.AppState.tracks) {
    const t = D.AppState.tracks[id];
    if (!t || !t.frames) continue;
    const hit = t.frames.find(d => d && d.type === 'camera');
    if (hit) return hit;
  }
  return D.AppState.objects.find(o => o && o.type === 'camera') || null;
}

function getCameraViewObject() {
  /* v7.9.5：摄像机视角只能由右上角浮窗按钮显式进入。
     旧逻辑靠「当前是摄像机子轨道」推断，点元件 / 锚点时会被 select() 改轨道，
     表现为“点一下就进了摄像机视角”。现在改成显式状态。 */
  if (!D.isCameraView2DActive || !D.isCameraView2DActive()) return null;
  const cam = D.getCurrentCameraObject && D.getCurrentCameraObject();
  return (cam && cam.type === 'camera') ? cam : null;
}

function getCameraViewTransform(cam) {
  const cw = D.getCanvas().clientWidth || window.innerWidth || 1;
  const ch = D.getCanvas().clientHeight || window.innerHeight || 1;
  const camW = Math.max(1, cam.w * (cam.scale || 1));
  const camH = Math.max(1, cam.h * (cam.scale || 1));
  const baseFit = Math.max(0.0001, Math.min(cw / camW, ch / camH) * 0.92);
  const fit = baseFit * D.getCamViewZoom();
  const viewW = camW * fit, viewH = camH * fit;
  const cx = cw / 2 + D.getCamViewOffset().x;
  const cy = ch / 2 + D.getCamViewOffset().y;
  return {
    fit, cx, cy,
    rot: (cam.rot || 0) * Math.PI / 180,
    camW, camH, cw, ch, viewW, viewH,
    left: cx - viewW / 2, top: cy - viewH / 2
  };
}

function cameraScreenToWorld(screen, cam, t) {
  const dx = screen.x - t.cx, dy = screen.y - t.cy;
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  return {
    x: cam.x + (dx * c - dy * s) / t.fit,
    y: cam.y + (dx * s + dy * c) / t.fit
  };
}

function pointInCameraRect(cam, p, pad) {
  pad = pad || 0;
  const w = cam.w * (cam.scale || 1) + pad * 2;
  const h = cam.h * (cam.scale || 1) + pad * 2;
  const dx = p.x - cam.x, dy = p.y - cam.y;
  const rot = (cam.rot || 0) * Math.PI / 180;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
}

function pointNearCameraBorder(cam, p, tol) {
  const w = cam.w * (cam.scale || 1), h = cam.h * (cam.scale || 1);
  const dx = p.x - cam.x, dy = p.y - cam.y;
  const rot = (cam.rot || 0) * Math.PI / 180;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  if (Math.abs(lx) > w / 2 + tol || Math.abs(ly) > h / 2 + tol) return false;
  return Math.min(Math.abs(Math.abs(lx) - w / 2), Math.abs(Math.abs(ly) - h / 2)) <= tol;
}

function findCameraHit(p) {
  const list = D.AppState.objects.filter(o => o && o.type === 'camera' && !o.locked);
  const tol = 14 / Math.max(0.01, D.getActiveViewScale());
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (pointNearCameraBorder(c, p, tol)) return c;
    if (c === D.AppState.selected && pointInCameraRect(c, p, 0)) return c;
  }
  return null;
}

function queueCamera(cam, isSel, isExporting, opts) {
  if (isExporting || (opts && opts.isGhost)) return;
  const s = cam.scale || 1;
  const w = cam.w * s, h = cam.h * s;
  const rot = (cam.rot || 0) * Math.PI / 180;
  D.pushRenderQueue({
    level: 50000,
    draw: () => {
      D.getCtx().save();
      D.getCtx().translate(cam.x, cam.y);
      D.getCtx().rotate(rot);
      D.getCtx().fillStyle = isSel ? 'rgba(74,144,255,.10)' : 'rgba(74,144,255,.045)';
      D.getCtx().fillRect(-w / 2, -h / 2, w, h);
      D.getCtx().setLineDash([10 / D.AppState.viewScale, 7 / D.AppState.viewScale]);
      D.getCtx().lineWidth = 2 / D.AppState.viewScale;
      D.getCtx().strokeStyle = isSel ? 'rgba(74,144,255,.95)' : 'rgba(74,144,255,.55)';
      D.getCtx().strokeRect(-w / 2, -h / 2, w, h);
      D.getCtx().setLineDash([]);
      D.getCtx().lineWidth = 1 / D.AppState.viewScale;
      D.getCtx().strokeStyle = 'rgba(74,144,255,.28)';
      for (let i = 1; i <= 2; i++) {
        D.getCtx().beginPath(); D.getCtx().moveTo(-w / 2 + w * i / 3, -h / 2); D.getCtx().lineTo(-w / 2 + w * i / 3, h / 2); D.getCtx().stroke();
        D.getCtx().beginPath(); D.getCtx().moveTo(-w / 2, -h / 2 + h * i / 3); D.getCtx().lineTo(w / 2, -h / 2 + h * i / 3); D.getCtx().stroke();
      }
      const fs = 13 / D.AppState.viewScale;
      D.getCtx().font = `600 ${fs}px system-ui, sans-serif`;
      D.getCtx().textAlign = 'left'; D.getCtx().textBaseline = 'middle';
      const label = '🎥 ' + (cam.name || 'camera');
      const tw = D.getCtx().measureText(label).width;
      D.getCtx().fillStyle = 'rgba(15,23,42,.72)';
      D.getCtx().fillRect(-w / 2, -h / 2 - fs * 2.1, Math.min(w, tw + fs), fs * 1.7);
      D.getCtx().fillStyle = '#fff';
      D.getCtx().fillText(label, -w / 2 + fs * 0.4, -h / 2 - fs * 1.25);
      D.getCtx().restore();
    }
  });
}

/* 取景框外遮罩：2D 相机视角与 3D 相机视角共用同一套颜色 / 透明度 / 几何。 */
function getCameraMaskPrimary() {
  try {
    const cfg = D.getThemeConfig && D.getThemeConfig();
    if (cfg && cfg.primary) return cfg.primary;
  } catch (_) {}
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
    if (v) return v;
  } catch (_) {}
  return '#ed9e94';
}

function cameraMaskFill(alpha) {
  const cu = window.SKFE && SKFE.core && SKFE.core.colorUtils;
  if (cu && typeof cu.themeHexToRgba === 'function') return cu.themeHexToRgba(getCameraMaskPrimary(), alpha);
  return 'rgba(237,158,148,' + alpha + ')';
}

function drawCameraViewMask(ctx, cw, ch, rect, opts) {
  if (!ctx || !rect) return;
  const alpha = (opts && Number.isFinite(opts.alpha)) ? opts.alpha : getCameraMaskAlpha();
  const outer = (opts && opts.bounds) || { left: 0, top: 0, width: cw, height: ch };
  ctx.save();
  ctx.fillStyle = cameraMaskFill(alpha);
  ctx.beginPath();
  ctx.rect(outer.left, outer.top, outer.width, outer.height);
  ctx.rect(rect.left, rect.top, rect.width, rect.height);
  ctx.fill('evenodd');
  if (opts && opts.border) {
    ctx.strokeStyle = getCameraMaskPrimary();
    ctx.lineWidth = opts.borderWidth || 1;
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }
  ctx.restore();
}

function getCameraMaskAlpha() {
  return CAMERA_MASK_ALPHA;
}

/* 兼容旧调用：透明度现在固定，滑条已移除，不再读 / 写缓存。 */
function setCameraMaskAlpha() {
  return CAMERA_MASK_ALPHA;
}

function renderCameraViewScene(cam, trackAlphaOpts) {
  const t = getCameraViewTransform(cam);
  const list = D.getCombinedObjectsForRender().filter(o => o && o.type !== 'camera');

  /* 摄像机视角就是整块画布的摄像机画面；取景框外只是同一画面的透明覆盖，
     不是另一套编辑器画面。之前的外圈常规场景会让遮罩内外变成两个画面。 */
  const cu = window.SKFE && SKFE.core && SKFE.core.colorUtils;
  const bgAlpha = D.getPageBgAlpha();
  D.getCtx().save();
  D.getCtx().fillStyle = bgAlpha < 1 && cu && cu.themeHexToRgba
    ? cu.themeHexToRgba(D.getPageBgColor(), bgAlpha)
    : D.getPageBgColor();
  D.getCtx().fillRect(0, 0, t.cw, t.ch);
  D.getCtx().translate(t.cx, t.cy);
  D.getCtx().rotate(-t.rot);
  D.getCtx().scale(t.fit, t.fit);
  D.getCtx().translate(-cam.x, -cam.y);

  if (D.isGroundLineEnabled()) D.drawGroundLine();

  if (D.getOnionEnabled() && !D.getIsPlaying()) {
    for (let d = D.getOnionBefore(); d >= 1; d--) {
      const idx = D.AppState.currentFrameIndex - d;
      if (idx < 0 || idx >= D.AppState.frames.length) continue;
      const a = D.ONION_ALPHA * Math.pow(0.85, d - 1);
      D.renderScene(D.getTrackObjectsAt(idx), Object.assign({ alphaMul: a, tint: D.ONION_COLOR_BEFORE, isGhost: true }, trackAlphaOpts));
    }
    for (let d = D.getOnionAfter(); d >= 1; d--) {
      const idx = D.AppState.currentFrameIndex + d;
      if (idx < 0 || idx >= D.AppState.frames.length) continue;
      const a = D.ONION_ALPHA * Math.pow(0.85, d - 1);
      D.renderScene(D.getTrackObjectsAt(idx), Object.assign({ alphaMul: a, tint: D.ONION_COLOR_AFTER, isGhost: true }, trackAlphaOpts));
    }
  }

  D.renderScene(list, Object.assign({ isExporting: false }, trackAlphaOpts));
  D.getCtx().restore();

  /* 取景框外遮罩：尺寸直接取当前取景变换，透明度与 3D 相机视角共用一份设置。 */
  drawCameraViewMask(D.getCtx(), t.cw, t.ch,
    { left: t.left, top: t.top, width: t.viewW, height: t.viewH },
    { alpha: getCameraMaskAlpha() });

  /* 取景框 + 安全框 + 提示 */
  D.getCtx().save();
  D.getCtx().strokeStyle = 'rgba(255,255,255,.92)';
  D.getCtx().lineWidth = 2;
  D.getCtx().strokeRect(t.left, t.top, t.viewW, t.viewH);
  D.getCtx().strokeStyle = 'rgba(74,144,255,.85)';
  D.getCtx().lineWidth = 1;
  D.getCtx().setLineDash([6, 4]);
  D.getCtx().strokeRect(t.left + t.viewW * 0.05, t.top + t.viewH * 0.05, t.viewW * 0.9, t.viewH * 0.9);
  D.getCtx().setLineDash([]);
  D.getCtx().fillStyle = 'rgba(15,23,42,.72)';
  const label = '🎥 摄像机视角 · 拖动画面平移';
  D.getCtx().font = '600 12px system-ui, sans-serif';
  const tw = D.getCtx().measureText(label).width + 18;
  D.getCtx().fillRect(t.left + 10, t.top + 10, tw, 26);
  D.getCtx().fillStyle = '#fff';
  D.getCtx().textAlign = 'left'; D.getCtx().textBaseline = 'middle';
  D.getCtx().fillText(label, t.left + 19, t.top + 24);
  D.getCtx().restore();
}

function updateCameraPreview() {
  const el = document.getElementById('cameraPreviewFloat');
  const cvs = document.getElementById('cameraPreviewCanvas');
  if (!el || !cvs) return;
  if (!D.isCameraPreviewVisible()) { el.style.display = 'none'; return; }

  /* 3D 开启后，预览浮窗必须显示 3D 摄像机视角的导出画面，
     不能继续用旧的 2D 摄像机裁切渲染，否则用户看到的和导出不一致。 */
  const S3 = window.SKFE && window.SKFE.systems && window.SKFE.systems.space3d;
  const S3E = window.SKFE && window.SKFE.systems && window.SKFE.systems.space3dExport;
  const preview3D = !!(S3 && typeof S3.isEnabled === 'function' && S3.isEnabled() &&
    S3E && typeof S3E.isActive === 'function' && S3E.isActive());

  const cam = D.getCurrentCameraObject();
  if (!cam && !preview3D) { el.style.display = 'none'; return; }
  el.style.display = 'block';

  const wrapW = Math.max(120, (el.clientWidth || 260) - 16);
  const aspect = cam ? Math.max(0.05, cam.w / Math.max(1, cam.h)) : 16 / 9;
  let pw = wrapW;
  let ph = Math.round(pw / aspect);
  const maxH = Math.max(100, Math.round(window.innerHeight * 0.42));
  if (ph > maxH) { ph = maxH; pw = Math.round(ph * aspect); }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const needW = Math.max(2, Math.round(pw * dpr));
  const needH = Math.max(2, Math.round(ph * dpr));
  cvs.style.width = pw + 'px';
  cvs.style.height = ph + 'px';

  if (preview3D) {
    const bg = D.getPageBgAlpha() < 1
      ? SKFE.core.colorUtils.themeHexToRgba(D.getPageBgColor(), D.getPageBgAlpha())
      : D.getPageBgColor();
    const ok = S3E.renderFrameToCanvas(cvs, needW, needH,
      D.AppState ? D.AppState.currentFrameIndex : 0,
      { showGrid: false, bgColor: bg });
    if (ok) return;
  }

  /* 2D 路径保持不变；3D 渲染失败时也退回这里，不让浮窗空白。 */
  if (!cam) return;
  if (cvs.width !== needW) cvs.width = needW;
  if (cvs.height !== needH) cvs.height = needH;
  const pc = cvs.getContext('2d');
  pc.setTransform(dpr, 0, 0, dpr, 0, 0);
  pc.clearRect(0, 0, pw, ph);
  pc.fillStyle = D.getPageBgAlpha() < 1 ? SKFE.core.colorUtils.themeHexToRgba(D.getPageBgColor(), D.getPageBgAlpha()) : D.getPageBgColor();
  pc.fillRect(0, 0, pw, ph);
  const fit = Math.min(pw / Math.max(1, cam.w * (cam.scale || 1)), ph / Math.max(1, cam.h * (cam.scale || 1)));
  const saved = D.getCtx();
  D.setCtx(pc);
  try {
    pc.save();
    pc.translate(pw / 2, ph / 2);
    pc.rotate(-(cam.rot || 0) * Math.PI / 180);
    pc.scale(fit, fit);
    pc.translate(-cam.x, -cam.y);
    const list = D.getCombinedObjectsForRender().filter(o => o && o.type !== 'camera');
    D.renderScene(list, { isExporting: true });
    pc.restore();
  } catch (_) {
  } finally {
    D.setCtx(saved);
  }
}

function initCameraPreviewFloat() {
  const el = document.getElementById('cameraPreviewFloat');
  const head = document.getElementById('cameraPreviewHead');
  const closeBtn = document.getElementById('btnCloseCameraPreview');
  if (!el) return;
  el.style.right = '20px';
  el.style.bottom = '120px';
  if (closeBtn) closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    D.setCameraPreviewVisible(false);
    const cb = document.getElementById('cameraPreviewCheck');
    if (cb) cb.checked = false;
    D.syncAdvToggles();
    updateCameraPreview();
  });
  if (!head) return;
  let st = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = el.getBoundingClientRect();
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    st = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    try { head.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!st) return;
    el.style.left = Math.max(0, Math.min(window.innerWidth - 80, st.left + e.clientX - st.x)) + 'px';
    el.style.top = Math.max(0, Math.min(window.innerHeight - 40, st.top + e.clientY - st.y)) + 'px';
  });
  const end = (e) => {
    if (!st) return;
    st = null;
    try { head.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

function fitCameraViewToAvailableArea() {
  const cam = getCameraViewObject();
  if (!cam) return;

  const cw = D.getCanvas().clientWidth || window.innerWidth || 1;
  const ch = D.getCanvas().clientHeight || window.innerHeight || 1;
  const camW = Math.max(1, cam.w * (cam.scale || 1));
  const camH = Math.max(1, cam.h * (cam.scale || 1));
  const baseFit = Math.max(0.0001, Math.min(cw / camW, ch / camH) * 0.92);

  /* 计算可用区域（避开左侧 UI 面板和上/下时间轴） */
  const timelineVisible = getComputedStyle(D.getTimelineEl()).display !== 'none';
  const uiRect = D.getUiPanel().getBoundingClientRect();
  const timelineRect = D.getTimelineEl().getBoundingClientRect();

  let availLeft = 0, availRight = cw;
  let availTop = 0, availBottom = ch;

  if (D.isMobile) {
    if (!D.getUiPanel().classList.contains('hidden')) {
      availBottom = Math.min(availBottom, uiRect.top);
    }
  } else {
    availLeft = Math.max(availLeft, uiRect.right);
  }
  if (timelineVisible) {
    if (D.getTimelineDock() === 'top') {
      availTop = Math.max(availTop, timelineRect.bottom);
    } else {
      availBottom = Math.min(availBottom, timelineRect.top);
    }
  }

  const availW = Math.max(80, availRight - availLeft);
  const availH = Math.max(80, availBottom - availTop);

  /* 让 fit = baseFit * D.getCamViewZoom() ≈ min(availW/camW, availH/camH) * 0.92 */
  const desiredFit = Math.min(availW / camW, availH / camH) * 0.92;
  D.setCamViewZoom(Math.max(0.05, Math.min(20, desiredFit / baseFit)));

  /* 让取景框中心落在可用区域中心 */
  D.getCamViewOffset().x = (availLeft + availRight) / 2 - cw / 2;
  D.getCamViewOffset().y = (availTop + availBottom) / 2 - ch / 2;
}

function initCameraUI() {
  const addBtn = document.getElementById('btnCamera');
  if (addBtn) addBtn.addEventListener('click', () => {
    /* 同一个「摄像机」按钮：2D 模式只添加 / 替换 2D 摄像机；3D 模式只重置 3D 摄像机。 */
    const in3D = typeof D.is3DModeActive === 'function' ? !!D.is3DModeActive() : false;
    if (in3D) {
      if (!confirm('当前项目中已有 3D 摄像机，是否替换为默认 3D 摄像机？')) return;
      const cam3d = typeof D.resetCamera3DToDefault === 'function' ? D.resetCamera3DToDefault() : null;
      if (!cam3d) return;
      D.AppState.objects = D.getCombinedObjectsForRender();
      D.AppState.selected = cam3d;
      if (typeof D.refreshSubTrackOptions === 'function') D.refreshSubTrackOptions();
      D.EventBus.emit('app:update', '替换 3D 摄像机');
      return;
    }

    const existing = findCameraObject();
    if (existing) {
      if (!confirm('当前项目中已存在 2D 摄像机，是否替换为新摄像机？')) return;
      for (const id in D.AppState.tracks) {
        const t = D.AppState.tracks[id];
        if (t && t.frames && t.frames.some(d => d && d.type === 'camera')) delete D.AppState.tracks[id];
      }
      D.AppState.objects = D.AppState.objects.filter(o => o && o.type !== 'camera');
      if (D.isCameraTrackId(D.AppState.activeTrackId)) D.AppState.activeTrackId = D.TRACK_ALL_ID;
    }
    const sp = D.getSpawnPoint();
    const cam = makeCamera(sp.x, sp.y);
    /* 摄像机默认名固定 camera，不再走通用数字命名。 */
    D.addObjectToFrames(cam);
    /* 摄像机默认铺满总轨道长度（镜头贯穿全片）。 */
    if (typeof D.fillCameraToFullLength === 'function') D.fillCameraToFullLength(cam);
    else D.syncMainLengthFromTracks();
    /* 添加 / 替换摄像机后不自动进入摄像机视角；进入视角只能点右上角浮窗按钮。 */
    D.AppState.objects = D.getCombinedObjectsForRender();
    D.AppState.selected = cam;
    D.refreshSubTrackOptions();
    D.EventBus.emit('app:update', '添加 2D 摄像机');
  });

  document.querySelectorAll('.camera-ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cam = (D.AppState.selected && D.AppState.selected.type === 'camera') ? D.AppState.selected : D.getCurrentCameraObject();
      if (!cam) return;
      const parts = (btn.dataset.ratio || '16:9').split(':').map(Number);
      const rw = Math.max(1, parts[0] || 16);
      const rh = Math.max(1, parts[1] || 9);
      const longSide = 640;
      let w, h;
      if (rw >= rh) { w = longSide; h = Math.round(longSide * rh / rw); }
      else { h = longSide; w = Math.round(longSide * rw / rh); }
      cam.w = w; cam.h = h;
      if (D.isGlobalEdit()) {
        D.setGlobalProp(cam, 'w', w);
        D.setGlobalProp(cam, 'h', h);
      }
      D.invalidateAllFrameThumbs();
      D.EventBus.emit('app:update', '切换摄像机比例');
    });
  });

  const previewCb = document.getElementById('cameraPreviewCheck');
  if (previewCb) {
    previewCb.addEventListener('change', () => {
      D.setCameraPreviewVisible(!!previewCb.checked);
      updateCameraPreview();
    });
  }
}

  return {
    init,
    makeCamera,
    findCameraObject,
    getCameraViewObject,
    getCameraViewTransform,
    cameraScreenToWorld,
    pointInCameraRect,
    pointNearCameraBorder,
    findCameraHit,
    queueCamera,
    renderCameraViewScene,
    drawCameraViewMask,
    getCameraMaskPrimary,
    getCameraMaskAlpha,
    setCameraMaskAlpha,
    updateCameraPreview,
    initPreviewFloat: initCameraPreviewFloat,
    fitCameraViewToAvailableArea,
    initUI: initCameraUI
  };
})();
