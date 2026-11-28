// js/features/export.js
window.SKFE = window.SKFE || {};
SKFE.features = SKFE.features || {};

SKFE.features.export = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  /* 阶段 4：3D 地面网格由导出面板单独控制；未找到开关时按旧行为包含。 */
  function s3ExportGridEnabled() {
    const cb = document.getElementById('s3ExportGrid');
    return !cb || !!cb.checked;
  }

  /* 导出帧率必须以工程 FPS 设置为准。
     旧逻辑从首帧 duration 反推，首帧若是自定义时长就会和设置不符；
     桌面录制路还写死 captureStream(30)，导出文件会被标成 30fps。 */
  function exportFPS() {
    const n = D && typeof D.getDefaultFPS === 'function' ? Number(D.getDefaultFPS()) : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= 60) return Math.round(n);
    const dur = Number(D && D.AppState && D.AppState.frames && D.AppState.frames[0] && D.AppState.frames[0].duration);
    return Math.max(1, Math.min(60, Math.round(1000 / (Number.isFinite(dur) && dur > 0 ? dur : 83))));
  }

  let jszipLoading = null;
  function getJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jszipLoading) return jszipLoading;
    jszipLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => { jszipLoading = null; reject(new Error('JSZip load failed')); };
      document.head.appendChild(script);
    });
    return jszipLoading;
  }

  async function exportPNGsAsZip(frameList, trackId, options) {
    if (!frameList || !frameList.length) return;
    const btn = document.getElementById('btnExportPNGSeq');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '准备打包...'; }
    
    try {
      const JSZip = await getJSZip();
      const zip = new JSZip();
      const outW = options.outW;
      const outH = options.outH;
      const crop = options.crop;
      const transparent = options.transparent;

      for (let i = 0; i < frameList.length; i++) {
        if (btn) btn.textContent = `打包中 ${i + 1}/${frameList.length}`;
        const fr = frameList[i];
        const idx = D.AppState.frames.indexOf(fr);
        const safeIdx = idx >= 0 ? idx : 0;
        /* v7.7.1：先把视频元件 seek 到该帧，画面才准确 */
        await D.prepareVideoClipsForFrame(safeIdx);
        const off = D.renderFrameToDataURL(fr, outW, outH, { transparent, crop }, trackId);
        const dataUrl = off.toDataURL('image/png');
        const base64Data = dataUrl.split(',')[1];
        
        const fileName = `frame_${String(safeIdx + 1).padStart(3, '0')}.png`;
        zip.file(fileName, base64Data, { base64: true });
        
        if (i % 5 === 4) await new Promise(r => setTimeout(r, 0)); // 防卡顿
      }

      if (btn) btn.textContent = '生成 ZIP...';
      const blob = await zip.generateAsync({ type: 'blob' });
      SKFE.platform.save(blob, 'stickman_frames_' + Date.now() + '.zip');
      
    } catch (err) {
      console.warn('ZIP打包失败，降级为逐个下载', err);
      alert('ZIP 库加载失败，将自动降级为逐个下载（若浏览器拦截请在地址栏允许）。');
      // 降级逻辑
      const urls = frameList.map(fr => {
        const idx = D.AppState.frames.indexOf(fr);
        const safeIdx = idx >= 0 ? idx : 0;
        const off = D.renderFrameToDataURL(fr, options.outW, options.outH, { transparent: options.transparent, crop: options.crop }, trackId);
        return { url: off.toDataURL('image/png'), label: safeIdx + 1 };
      });
      urls.forEach((u, i) => {
        setTimeout(() => {
          SKFE.platform.save(u.url, `frame_${String(u.label).padStart(3, '0')}.png`);
        }, i * 150);
      });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
      D.EventBus.emit('need:render');
    }
  }

  /* ==================== v7.7.0 SVG 序列帧导出 ====================
     录制式矢量导出器：把现有 Canvas 2D 绘制调用录成 SVG 元素，
     直接复用 renderScene 的关节几何与图层排序，不重复实现一套渲染器。
     范围（用户确认）：只导矢量元件 figure / shape / ink；
     文字（bubble）、位图（image/acc/video）、发光、扭曲一律不导出。 */
  function svgXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function svgNum(v) {
    if (!isFinite(v)) return '0';
    const r = Math.round(v * 1000) / 1000;
    return (r === 0) ? '0' : String(r);
  }

  function createSvgRecorder() {
    const defs = [];
    const body = [];
    let seq = 0;
    let M = [1, 0, 0, 1, 0, 0];
    let pathD = [];
    let pathM = M.slice();
    let pathOpen = false;
    let S = { fill: '#000000', stroke: 'none', lw: 1, cap: 'butt', join: 'miter', alpha: 1, dash: null, rule: 'nonzero' };
    const mStack = [], sStack = [];

    function mul(a, b) {
      return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5]
      ];
    }
    function mstr(mm) { return 'matrix(' + mm.map(svgNum).join(',') + ')'; }
    function color(v) {
      if (v == null || v === 'transparent' || v === 'none') return 'none';
      if (typeof v === 'string') return svgXml(v);
      if (v && v.__svgGrad) return 'url(#' + v.__svgGrad + ')';
      return 'none';
    }
    function notePath() { if (!pathOpen) { pathM = M.slice(); pathOpen = true; } }
    function pushSeg(s) { notePath(); pathD.push(s); }
    function makeGrad(kind, coords) {
      const id = 'skfe-g' + (++seq);
      const g = { __svgGrad: id, stops: [], addColorStop(p, c) { this.stops.push([p, c]); } };
      defs.push({ id, kind, coords, stops: g.stops });
      return g;
    }
    function emit(kind, ds, mm, rule) {
      const fill = (kind === 'stroke') ? 'none' : color(S.fill);
      const stroke = (kind === 'fill') ? 'none' : color(S.stroke);
      if (fill === 'none' && stroke === 'none') return;
      let at = 'd="' + svgXml(ds) + '" transform="' + mstr(mm) + '"';
      at += ' fill="' + fill + '" fill-rule="' + (rule || S.rule) + '" stroke="' + stroke + '"';
      if (stroke !== 'none') {
        at += ' stroke-width="' + svgNum(S.lw) + '"';
        if (S.cap && S.cap !== 'butt') at += ' stroke-linecap="' + svgXml(S.cap) + '"';
        if (S.join && S.join !== 'miter') at += ' stroke-linejoin="' + svgXml(S.join) + '"';
        if (S.dash && S.dash.length) at += ' stroke-dasharray="' + S.dash.map(svgNum).join(',') + '"';
      }
      if (S.alpha < 1) at += ' opacity="' + svgNum(S.alpha) + '"';
      body.push('<path ' + at + '/>');
    }
    function flush(kind, rule, dOverride, mOverride) {
      const ds = dOverride || pathD.join(' ');
      /* v7.7.4：Path2D（手绘头型）没有走 moveTo/lineTo，pathM 还是上一条路径的矩阵，
         必须改用 fill/stroke 当下的 M，否则头型会被上一个路径的变换放大到画布外。 */
      if (ds && ds.trim()) emit(kind, ds, mOverride || pathM, rule || S.rule);
      pathD = []; pathOpen = false;
    }
    function rectPath(x, y, w, h) {
      return 'M' + svgNum(x) + ',' + svgNum(y) + 'h' + svgNum(w) + 'v' + svgNum(h) + 'h' + svgNum(-w) + 'Z';
    }

    const c = {
      __isSvgRecorder: true, /* v7.7.3：像素级蒙版在 SVG 序列里跳过，保持原矢量导出路径 */
      canvas: { width: 0, height: 0 },
      save() { mStack.push(M.slice()); sStack.push(Object.assign({}, S)); },
      restore() { if (mStack.length) M = mStack.pop(); if (sStack.length) S = sStack.pop(); },
      translate(x, y) { M = mul(M, [1, 0, 0, 1, x, y]); },
      scale(x, y) { M = mul(M, [x, 0, 0, (y == null ? x : y), 0, 0]); },
      rotate(r) { const co = Math.cos(r), si = Math.sin(r); M = mul(M, [co, si, -si, co, 0, 0]); },
      transform(a, b, c2, d, e, f) { M = mul(M, [a, b, c2, d, e, f]); },
      setTransform(a, b, c2, d, e, f) { M = [a, b, c2, d, e, f]; },
      resetTransform() { M = [1, 0, 0, 1, 0, 0]; },
      getTransform() {
        const q = M;
        return { a: q[0], b: q[1], c: q[2], d: q[3], e: q[4], f: q[5], m22: q[0], m12: q[2], m21: q[1], toString() { return mstr(q); } };
      },
      beginPath() { pathD = []; pathOpen = false; },
      closePath() { pushSeg('Z'); },
      moveTo(x, y) { pushSeg('M' + svgNum(x) + ',' + svgNum(y)); },
      lineTo(x, y) { pushSeg('L' + svgNum(x) + ',' + svgNum(y)); },
      quadraticCurveTo(cx, cy, x, y) { pushSeg('Q' + svgNum(cx) + ',' + svgNum(cy) + ' ' + svgNum(x) + ',' + svgNum(y)); },
      bezierCurveTo(x1, y1, x2, y2, x, y) {
        pushSeg('C' + svgNum(x1) + ',' + svgNum(y1) + ' ' + svgNum(x2) + ',' + svgNum(y2) + ' ' + svgNum(x) + ',' + svgNum(y));
      },
      arcTo() {},
      ellipse(x, y, rx, ry, ro, s, e, ccw) {
        const sx = x + rx * Math.cos(s) * Math.cos(ro) - ry * Math.sin(s) * Math.sin(ro);
        const sy = y + rx * Math.cos(s) * Math.sin(ro) + ry * Math.sin(s) * Math.cos(ro);
        pushSeg('M' + svgNum(sx) + ',' + svgNum(sy));
        let delta = e - s;
        if (!ccw && delta <= 0) delta += 2 * Math.PI;
        if (ccw && delta >= 0) delta -= 2 * Math.PI;
        const large = Math.abs(delta) > Math.PI ? 1 : 0;
        const sweep = delta > 0 ? 1 : 0;
        const ex = x + rx * Math.cos(e) * Math.cos(ro) - ry * Math.sin(e) * Math.sin(ro);
        const ey = y + rx * Math.cos(e) * Math.sin(ro) + ry * Math.sin(e) * Math.cos(ro);
        pushSeg('A' + svgNum(rx) + ',' + svgNum(ry) + ' ' + svgNum(ro * 180 / Math.PI) + ' ' + large + ',' + sweep + ' ' + svgNum(ex) + ',' + svgNum(ey));
      },
      arc(x, y, r, s, e, ccw) {
        r = Math.abs(r);
        const sx = x + r * Math.cos(s), sy = y + r * Math.sin(s);
        pushSeg('M' + svgNum(sx) + ',' + svgNum(sy));
        let delta = e - s;
        if (!ccw && delta <= 0) delta += 2 * Math.PI;
        if (ccw && delta >= 0) delta -= 2 * Math.PI;
        const large = Math.abs(delta) > Math.PI ? 1 : 0;
        const sweep = delta > 0 ? 1 : 0;
        if (Math.abs(delta) >= 2 * Math.PI - 1e-6) {
          const mx = x - r * Math.cos(s), my = y - r * Math.sin(s);
          pushSeg('A' + svgNum(r) + ',' + svgNum(r) + ' 0 1,' + sweep + ' ' + svgNum(mx) + ',' + svgNum(my));
          pushSeg('A' + svgNum(r) + ',' + svgNum(r) + ' 0 1,' + sweep + ' ' + svgNum(sx) + ',' + svgNum(sy));
        } else {
          pushSeg('A' + svgNum(r) + ',' + svgNum(r) + ' 0 ' + large + ',' + sweep + ' ' + svgNum(x + r * Math.cos(e)) + ',' + svgNum(y + r * Math.sin(e)));
        }
      },
      rect(x, y, w, h) { pushSeg(rectPath(x, y, w, h)); },
      roundRect() {},
      fill(arg, rule) {
        if (arg && arg.__svgD !== undefined) { flush('fill', rule === 'evenodd' ? 'evenodd' : undefined, arg.__svgD, M.slice()); return; }
        flush('fill', rule === 'evenodd' ? 'evenodd' : undefined);
      },
      stroke(arg) {
        if (arg && arg.__svgD !== undefined) { flush('stroke', undefined, arg.__svgD, M.slice()); return; }
        flush('stroke');
      },
      fillRect(x, y, w, h) {
        const saved = pathD, savedM = pathM, savedOpen = pathOpen;
        pathD = [rectPath(x, y, w, h)]; pathOpen = true;
        flush('fill');
        pathD = saved; pathM = savedM; pathOpen = savedOpen;
      },
      strokeRect(x, y, w, h) {
        const saved = pathD, savedM = pathM, savedOpen = pathOpen;
        pathD = [rectPath(x, y, w, h)]; pathOpen = true;
        flush('stroke');
        pathD = saved; pathM = savedM; pathOpen = savedOpen;
      },
      clearRect() {},
      clip() {},
      isPointInPath() { return false; },
      createLinearGradient(x0, y0, x1, y1) { return makeGrad('linear', [x0, y0, x1, y1]); },
      createRadialGradient(x0, y0, r0, x1, y1, r1) { return makeGrad('radial', [x0, y0, r0, x1, y1, r1]); },
      createConicGradient() { return makeGrad('linear', [0, 0, 0, 0]); },
      createPattern() { return null; },
      fillText() {}, strokeText() {},
      measureText(t) { return { width: String(t == null ? '' : t).length * 6 }; },
      drawImage() {},
      createImageData() { return null; },
      getImageData() { return { data: new Uint8ClampedArray(0) }; },
      putImageData() {}
    };
    const props = {
      fillStyle: 'fill', strokeStyle: 'stroke', lineWidth: 'lw', lineCap: 'cap', lineJoin: 'join',
      globalAlpha: 'alpha', miterLimit: 'miter', font: 'font', textAlign: 'align', textBaseline: 'baseline',
      filter: 'filter', globalCompositeOperation: 'gco', shadowBlur: 'shadowBlur', shadowColor: 'shadowColor',
      shadowOffsetX: 'shadowOffX', shadowOffsetY: 'shadowOffY', imageSmoothingEnabled: 'smooth'
    };
    Object.keys(props).forEach(k => {
      Object.defineProperty(c, k, {
        get() { return S[props[k]] == null ? (k === 'fillStyle' || k === 'strokeStyle' ? '#000000' : S[props[k]]) : S[props[k]]; },
        set(v) { S[props[k]] = v; },
        enumerable: true, configurable: true
      });
    });
    c.setLineDash = function (a) { S.dash = Array.isArray(a) ? a.slice() : null; };
    c.getLineDash = function () { return S.dash ? S.dash.slice() : []; };

    c.toSVG = function (w, h) {
      const defStr = defs.map(g => {
        const stops = g.stops.map(p => '<stop offset="' + svgNum(p[0]) + '" stop-color="' + color(p[1]) + '"/>').join('');
        if (g.kind === 'radial') {
          const q = g.coords;
          return '<radialGradient id="' + g.id + '" gradientUnits="userSpaceOnUse" cx="' + svgNum(q[3]) + '" cy="' + svgNum(q[4]) + '" r="' + svgNum(q[5]) + '" fx="' + svgNum(q[0]) + '" fy="' + svgNum(q[1]) + '">' + stops + '</radialGradient>';
        }
        const q = g.coords;
        return '<linearGradient id="' + g.id + '" gradientUnits="userSpaceOnUse" x1="' + svgNum(q[0]) + '" y1="' + svgNum(q[1]) + '" x2="' + svgNum(q[2]) + '" y2="' + svgNum(q[3]) + '">' + stops + '</linearGradient>';
      }).join('');
      return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgNum(w) + '" height="' + svgNum(h) + '" viewBox="0 0 ' + svgNum(w) + ' ' + svgNum(h) + '">\n' +
        '<title>SKFE vector frame</title>\n' +
        (defStr ? '<defs>' + defStr + '</defs>\n' : '') +
        body.join('\n') + '\n</svg>\n';
    };
    return c;
  }

  /* 只保留矢量元件；统计被跳过的类型用于文字提示 */
  function svgFilterList(list) {
    const keep = [];
    const skipped = { bitmap: 0, text: 0, glow: 0, distort: 0 };
    (list || []).forEach(o => {
      if (!o || o.hidden) return;
      if (o.type === 'shape' || o.type === 'ink') { keep.push(o); return; }
      if (o.type === 'figure') {
        let dm = null;
        try { dm = SKFE.systems.distort && SKFE.systems.distort.getMapping(o); } catch (_) {}
        if (dm) { skipped.distort++; return; }
        if (o.glow && o.glow.enabled) { skipped.glow++; return; }
        keep.push(o);
        return;
      }
      if (o.type === 'bubble') { skipped.text++; return; }
      skipped.bitmap++;
    });
    return { keep, skipped };
  }

  /* 与 renderFrameToDataURL 相同的取景计算，但画进录制器 */
  function renderFrameToSVG(frame, outW, outH, options, trackId) {
    options = options || {};
    const idx = (typeof frame === 'number') ? frame : D.AppState.frames.indexOf(frame);
    const safeIdx = idx >= 0 ? idx : D.AppState.currentFrameIndex;
    const tid = (trackId != null && trackId !== D.TRACK_ALL_ID)
      ? String(trackId)
      : ((options.trackId != null && options.trackId !== D.TRACK_ALL_ID) ? String(options.trackId) : null);
    const safeTid = (tid && D.isCameraTrackId && D.isCameraTrackId(tid)) ? null : tid;
    const fullList = D.getObjectsForFrameAt(safeIdx, safeTid);
    const filt = svgFilterList(fullList);
    let scale = 1, cx = 0, cy = 0, rotation = 0;
    const camAt = (options.crop || options.ignoreCamera || D.shouldSkipCameraForExport()) ? null : D.getCameraAtFrame(safeIdx);
    if (options.crop) {
      scale = options.crop.scale; cx = options.crop.cx; cy = options.crop.cy; rotation = options.crop.rotation || 0;
    } else if (camAt) {
      const cc = D.cameraToCrop(camAt, outW, outH);
      scale = cc.scale; cx = cc.cx; cy = cc.cy; rotation = cc.rotation;
    } else {
      const crop = D.getExportCrop(outW, outH, safeTid);
      scale = crop.scale; cx = crop.cx; cy = crop.cy; rotation = crop.rotation || 0;
    }
    const rec = createSvgRecorder();
    rec.canvas.width = outW; rec.canvas.height = outH;
    if (!options.transparent) rec.fillStyle = D.getPageBgColor(), rec.fillRect(0, 0, outW, outH);
    rec.translate(outW / 2, outH / 2);
    rec.rotate(-rotation);
    rec.scale(scale, scale);
    rec.translate(-cx, -cy);
    const savedCtx = D.getCtx();
    D.setCtx(rec);
    try {
      D.renderScene(filt.keep, { isExporting: true, includeHidden: false, refList: fullList, frameIndex: safeIdx });
    } finally {
      D.setCtx(savedCtx);
    }
    return { svg: rec.toSVG(outW, outH), skipped: filt.skipped };
  }

  async function exportSVGsAsZip(frameList, trackId, options) {
    const S3X = window.SKFE && window.SKFE.systems && SKFE.systems.space3dExport;
    if (S3X && typeof S3X.isSvgAllowed === 'function' && !S3X.isSvgAllowed()) {
      alert('3D 模式不支持 SVG 序列导出。\n请关闭 3D 后导出，或改用 PNG / GIF / MP4。');
      return;
    }
    if (!frameList || !frameList.length) return;
    const btn = document.getElementById('btnExportSVGSeq');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '准备打包...'; }
    const skippedTotal = { bitmap: 0, text: 0, glow: 0, distort: 0 };
    try {
      const JSZip = await getJSZip();
      const zip = new JSZip();
      for (let i = 0; i < frameList.length; i++) {
        if (btn) btn.textContent = '打包中 ' + (i + 1) + '/' + frameList.length;
        const fr = frameList[i];
        const idx = D.AppState.frames.indexOf(fr);
        const safeIdx = idx >= 0 ? idx : 0;
        const res = renderFrameToSVG(fr, options.outW, options.outH, options, trackId);
        Object.keys(skippedTotal).forEach(k => { skippedTotal[k] += res.skipped[k]; });
        zip.file('frame_' + String(safeIdx + 1).padStart(3, '0') + '.svg', res.svg);
        if (i % 5 === 4) await new Promise(r => setTimeout(r, 0));
      }
      if (btn) btn.textContent = '生成 ZIP...';
      const blob = await zip.generateAsync({ type: 'blob' });
      SKFE.platform.save(blob, 'stickman_svg_' + Date.now() + '.zip');
      const parts = [];
      if (skippedTotal.distort) parts.push('扭曲元件 ' + skippedTotal.distort + ' 个');
      if (skippedTotal.glow) parts.push('发光元件 ' + skippedTotal.glow + ' 个');
      if (skippedTotal.text) parts.push('文字元件 ' + skippedTotal.text + ' 个');
      if (skippedTotal.bitmap) parts.push('位图元件 ' + skippedTotal.bitmap + ' 个');
      if (parts.length) {
        alert('SVG 序列已导出（仅矢量元件）。\n未导出：' + parts.join('、') + '。\n这些效果/元件不受 SVG 支持，如需保留请使用 PNG 序列。');
      } else {
        alert('SVG 序列已导出。');
      }
    } catch (err) {
      console.warn('SVG ZIP 打包失败，降级为逐个下载', err);
      alert('ZIP 库加载失败，将自动降级为逐个下载（若浏览器拦截请在地址栏允许）。');
      frameList.forEach((fr, i) => {
        const idx = D.AppState.frames.indexOf(fr);
        const safeIdx = idx >= 0 ? idx : 0;
        const res = renderFrameToSVG(fr, options.outW, options.outH, options, trackId);
        SKFE.platform.save(res.svg, 'frame_' + String(safeIdx + 1).padStart(3, '0') + '.svg');
      });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
      D.EventBus.emit('need:render');
    }
  }

  function exportSVGSeq() {
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const _sz = D.getExportSize();
    const outW = _sz.w, outH = _sz.h;
    const transparent = document.getElementById('gifTransparent').checked;
    /* v7.7.2：SVG 序列必须扫全部轨道。
       之前沿用了 PNG 的「当前子轨道」tid：插入视频后会自动切到视频自己的子轨道，
       导出时 getObjectsForFrameAt 只拿到 videoClip → svgFilterList 把它当位图跳过 →
       每一帧都是 279 字节的空 SVG（Windows 显示 1KB）。这就是「SVG 全 1KB」的真因。
       矢量导出本就该导出画布上所有 figure/shape/ink，不受当前选中的子轨道影响。 */
    const tid = null;
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const list = D.AppState.frames.slice(0, contentFrameCount(null));
    const crop = cam ? null : D.getCropForFrames(list, outW, outH, null);
    exportSVGsAsZip(list, null, { outW, outH, crop, transparent });
  }

  let gifencLib = null;
  async function getGifenc() {
    if (gifencLib) return gifencLib;
    const mod = await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js');
    gifencLib = mod;
    return mod;
  }

  async function exportGIF(frameList, trackId) {
    let tid = (trackId != null && trackId !== D.TRACK_ALL_ID) ? String(trackId) : null;
    if (trackId === undefined && D.isSubTrackMode()) tid = String(D.AppState.activeTrackId);
    const list = (frameList && frameList.length) ? frameList : D.AppState.frames;
    if (list.length === 0) return;
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const transparent = document.getElementById('gifTransparent').checked;
    const _sz = D.getExportSize();
    const outW = _sz.w, outH = _sz.h;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let gifenc;
    try { gifenc = await getGifenc(); }
    catch (e) {
      if (confirm('GIF 编码库加载失败（可能没有网络）。\n是否改为导出 PNG 序列？')) exportPNGSeq();
      return;
    }
    const { GIFEncoder, quantize, applyPalette } = gifenc;
    const gif = GIFEncoder();
    const btn = document.getElementById('btnExportGIF');
    const oldText = btn.textContent;
    btn.disabled = true;
    
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const crop = cam ? null : D.getCropForFrames(list, outW, outH, tid);
    try {
      /* ---------- 步骤 1：渲染并二值化 alpha ---------- */
      const renderedFrames = [];
      for (let i = 0; i < list.length; i++) {
        btn.textContent = `GIF ${i + 1}/${list.length}`;
        const gidx = D.AppState.frames.indexOf(list[i]);
        await D.prepareVideoClipsForFrame(gidx >= 0 ? gidx : i);
        /* 3D GIF 只有 256 色，编辑器里 0.38 的细网格线会被量化成断续小块；
           导出帧临时提高网格不透明度，量化后线条保持连续。showGrid 仍由导出面板开关控制。 */
        const off = D.renderFrameToDataURL(list[i], outW, outH, {
          transparent,
          crop,
          gridOpacity: 1
        }, tid);
        const imgData = off.getContext('2d').getImageData(0, 0, outW, outH);
        if (transparent) {
          const data = imgData.data;
          for (let p = 3; p < data.length; p += 4) data[p] = data[p] >= 128 ? 255 : 0;
        }
        renderedFrames.push(imgData);
        if (i % 2 === 1) await new Promise(r => setTimeout(r, 0));
      }

      /* ---------- 步骤 2：采样不透明像素 ----------
         - 采样密度：每 2 像素（之前 16 像素太稀疏 → 调色板缺色 → 闪烁）
         - 跳过透明像素（避免透明色占不透明色槽位） */
      btn.textContent = '量化...';
      const samplePixels = [];
      for (let i = 0; i < renderedFrames.length; i++) {
        const data = renderedFrames[i].data;
        for (let j = 0; j < data.length; j += 4 * 2) {
          if (transparent && data[j + 3] < 128) continue;
          samplePixels.push(data[j], data[j + 1], data[j + 2], 255);
        }
      }
      if (samplePixels.length === 0) {
        alert('当前所有帧都是空白，无法导出 GIF');
        return;
      }
      const sampleArr = new Uint8ClampedArray(samplePixels);

      /* ---------- 步骤 3：构建稳定调色板 ----------
         透明模式用 rgb565（5/6/5 bit 精度，比 rgba4444 高 4 倍）
         索引 0 手动占位给透明，其余 255 槽给不透明色
         相同颜色每帧都映射到同一索引 → 不会闪烁 */
      let globalPalette;
      let opaquePalette = null;
      let useFormat = 'rgb565';

      if (transparent) {
        try {
          opaquePalette = quantize(sampleArr, 255, { format: 'rgb565' });
          useFormat = 'rgb565';
        } catch (err) {
          /* 兜底：极老版本 gifenc 可能不认 rgb565 */
          opaquePalette = quantize(sampleArr, 255, { format: 'rgba4444' });
          useFormat = 'rgba4444';
        }
        /* 统一为 4 分量，索引 0 = 纯透明 */
        globalPalette = [[0, 0, 0, 0]].concat(
          opaquePalette.map(c => [c[0], c[1], c[2], 255])
        );
      } else {
        globalPalette = quantize(sampleArr, 256, { format: 'rgb565' });
      }

      /* ---------- 步骤 4：逐帧写 GIF ---------- */
      for (let i = 0; i < renderedFrames.length; i++) {
        btn.textContent = `GIF ${i + 1}/${renderedFrames.length}`;
        const imgData = renderedFrames[i];
        const data = imgData.data;
        const delay = Math.max(10, list[i].duration | 0);

        let index;
        if (transparent) {
          /* rgb565 格式忽略 alpha 做最近邻匹配，再手工覆盖透明像素 */
          index = applyPalette(data, opaquePalette, useFormat);
          for (let k = 0; k < data.length; k += 4) {
            if (data[k + 3] < 128) {
              index[k >> 2] = 0;                                /* 透明 → 索引 0 */
            } else {
              index[k >> 2] = Math.min(255, index[k >> 2] + 1); /* 不透明 → 偏移 +1 */
            }
          }
        } else {
          index = applyPalette(data, globalPalette, 'rgb565');
        }

        gif.writeFrame(index, outW, outH, {
          palette: globalPalette,
          delay,
          transparent,
          transparentIndex: transparent ? 0 : undefined
        });
        await new Promise(r => setTimeout(r, 0));
      }

      gif.finish();
      const bytes = gif.bytes();
      const blob = new Blob([bytes], { type: 'image/gif' });
      if (isIOS) {
        const reader = new FileReader();
        reader.onload = function (e) {
          const dataUrl = e.target.result;
          const overlay = document.createElement('div');
          overlay.className = 'ios-save-overlay';
          overlay.innerHTML = `
            <div class="ios-save-title">请长按下方图片，选择“存储到照片”</div>
            <img src="${dataUrl}" class="ios-save-img">
            <button class="btn-primary ios-save-btn" onclick="this.parentElement.remove()">完成 / 关闭</button>
          `;
          document.body.appendChild(overlay);
        };
        reader.readAsDataURL(blob);
      } else {
        SKFE.platform.save(blob, 'stickman_anim_' + Date.now() + (transparent ? '_transparent' : '') + '.gif');
      }
    } catch (e) {
      alert('GIF 导出失败：' + e.message);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
      D.EventBus.emit('need:render');
    }
  }

  /* ==================== v7.8.4：导出音轨 ====================
     音频元件 / 视频元件都在轨道上按段落出场。这里先按真实帧时长把整段时间线
     离线混成一条 PCM，再分别喂给 MediaRecorder 的音频轨或 WebCodecs 的 AAC 编码器。
     没有音频事件时全部跳过，导出行为与旧版完全一致。 */
  const EXPORT_AUDIO_RATE = 48000;
  const exportAudioDecodeCache = new Map();

  function audioCacheKey(url) {
    return url.length + '|' + url.slice(0, 80) + '|' + url.slice(-40);
  }

  async function decodeExportAudio(url) {
    if (!url) return null;
    const key = audioCacheKey(url);
    if (exportAudioDecodeCache.has(key)) return exportAudioDecodeCache.get(key);
    const task = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const probe = new Ctor(2, 1, EXPORT_AUDIO_RATE);
        const buf = await probe.decodeAudioData(arr);
        return buf || null;
      } catch (_) {
        /* 视频容器里的音轨在部分浏览器上 decodeAudioData 不支持 —— 跳过，不影响画面导出 */
        return null;
      }
    })();
    exportAudioDecodeCache.set(key, task);
    return task;
  }

  async function renderExportAudio(n, tid) {
    let events = [];
    try { events = D.collectAudioTimeline ? (D.collectAudioTimeline(n, tid) || []) : []; }
    catch (_) { return null; }
    if (!events.length) return null;
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctor) return null;
    let totalMs = 0;
    for (let i = 0; i < n; i++) totalMs += (D.AppState.frames[i] && D.AppState.frames[i].duration) || 83;
    const totalSec = Math.max(totalMs / 1000, events.reduce((m, e) => Math.max(m, e.startSec + e.durationSec), 0));
    if (!(totalSec > 0)) return null;
    const offline = new Ctor(2, Math.max(1, Math.ceil(totalSec * EXPORT_AUDIO_RATE)), EXPORT_AUDIO_RATE);
    let mixed = false;
    for (const ev of events) {
      const buf = await decodeExportAudio(ev.url);
      if (!buf || !buf.duration) continue;
      const off = Math.max(0, Math.min(buf.duration - 0.001, ev.offsetSec || 0));
      const dur = Math.min(ev.durationSec || 0, buf.duration - off);
      if (!(dur > 0.001)) continue;
      const src = offline.createBufferSource();
      const gain = offline.createGain();
      src.buffer = buf;
      gain.gain.value = typeof ev.volume === 'number' ? Math.max(0, Math.min(1, ev.volume)) : 1;
      src.connect(gain).connect(offline.destination);
      src.start(Math.max(0, ev.startSec || 0), off, dur);
      mixed = true;
    }
    if (!mixed) return null;
    return await offline.startRendering();
  }

  async function attachExportAudioToStream(stream, buffer) {
    if (!buffer) return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !stream) return null;
    let ctx = null;
    try {
      ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(dest);
      try { await ctx.resume(); } catch (_) {}
      src.start(0);
      stream.getAudioTracks().forEach(t => stream.removeTrack(t));
      const audioTrack = dest.stream.getAudioTracks()[0] || null;
      if (audioTrack) stream.addTrack(audioTrack);
      return { ctx, src, audioTrack };
    } catch (_) {
      try { if (ctx) ctx.close(); } catch (_) {}
      return null;
    }
  }

  function stopExportAudio(audio) {
    if (!audio) return;
    try { if (audio.src) audio.src.stop(); } catch (_) {}
    try { if (audio.audioTrack) audio.audioTrack.stop(); } catch (_) {}
    try { if (audio.ctx) audio.ctx.close(); } catch (_) {}
  }

  /* WebCodecs MP4：把 PCM 切成 1024 帧一块，编码成 AAC-LC 后交给 mp4-muxer */
  async function encodeAudioForMuxer(buffer, addChunk) {
    const AE = window.AudioEncoder;
    const AD = window.AudioData;
    if (!AE || !AD || !buffer) return false;
    const cfg = {
      codec: 'mp4a.40.2',
      sampleRate: buffer.sampleRate,
      numberOfChannels: buffer.numberOfChannels,
      bitrate: 128000
    };
    let probe = null;
    try {
      probe = new AE({ output() {}, error() {} });
      probe.configure(cfg);
    } catch (_) {
      try { if (probe) probe.close(); } catch (_) {}
      return false;
    }
    try { probe.close(); } catch (_) {}

    let encError = null;
    const encoder = new AE({
      output: (chunk, meta) => { try { addChunk(chunk, meta); } catch (e) { encError = e; } },
      error: (e) => { encError = e; }
    });
    try { encoder.configure(cfg); }
    catch (_) { try { encoder.close(); } catch (_) {} return false; }

    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const block = 1024;
    try {
      for (let off = 0; off < buffer.length; off += block) {
        if (encError) throw encError;
        const count = Math.min(block, buffer.length - off);
        const data = new Float32Array(count * buffer.numberOfChannels);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          data.set(chans[c].subarray(off, off + count), c * count);
        }
        const ad = new AD({
          format: 'f32-planar',
          sampleRate: buffer.sampleRate,
          numberOfFrames: count,
          numberOfChannels: buffer.numberOfChannels,
          timestamp: Math.round(off / buffer.sampleRate * 1e6),
          data
        });
        encoder.encode(ad);
        ad.close();
        if (encoder.encodeQueueSize > 16) await new Promise(r => setTimeout(r, 0));
      }
      await encoder.flush();
      if (encError) throw encError;
      return true;
    } catch (e) {
      try { console.warn('[MP4] 音轨编码失败，改为只导出画面：' + (e && e.message ? e.message : e)); } catch (_) {}
      return false;
    } finally {
      try { encoder.close(); } catch (_) {}
    }
  }

  /* ==================== WebM 视频 ==================== */
  async function exportVideo() {
    if (D.AppState.frames.length === 0) return;
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const tid = D.isSubTrackMode() ? String(D.AppState.activeTrackId) : null;
    const outW = 800, outH = 800;
    const crop = D.getExportCrop(outW, outH, tid);
    const recCanvas = document.createElement('canvas');
    recCanvas.width = outW; recCanvas.height = outH;
    const recCtx = recCanvas.getContext('2d', { alpha: true });
    const stream = recCanvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    /* v7.8.4：先离线混音，再把音频轨塞进同一个 MediaStream，WebM 才会带声音 */
    const vN = contentFrameCount(tid);
    const audioBuffer = await renderExportAudio(vN, tid);
    const exportAudio = await attachExportAudioToStream(stream, audioBuffer);
    let mimeType = 'video/webm';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mimeType = 'video/webm;codecs=vp9';
    else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) mimeType = 'video/webm;codecs=vp8';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const blobPromise = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    const savedCtx = D.getCtx();
    D.setCtx(recCtx);
    /* v7.4.6：只录到「最后一个有内容的帧」，时间轴尾巴上的空白帧不要 */
    try {
      for (let i = 0; i < vN; i++) {
        await D.prepareVideoClipsForFrame(i); /* v7.7.1：视频元件定格到该帧 */
        const S3X = window.SKFE && window.SKFE.systems && SKFE.systems.space3dExport;
        if (S3X && typeof S3X.isActive === 'function' && S3X.isActive()) {
          S3X.renderFrameToCanvas(recCanvas, outW, outH, i, {
            transparent: false,
            bgColor: D.getPageBgColor(),
            trackId: tid,
            showGrid: s3ExportGridEnabled(),
            camera3dFrame: D.getCamera3DFrame ? D.getCamera3DFrame(i) : null
          });
        } else {
          recCtx.save();
          recCtx.setTransform(1, 0, 0, 1, 0, 0);
          recCtx.clearRect(0, 0, outW, outH);
          recCtx.fillStyle = D.getPageBgColor();
          recCtx.fillRect(0, 0, outW, outH);
          recCtx.translate(outW / 2, outH / 2);
          if (crop.rotation) recCtx.rotate(-crop.rotation);
          recCtx.scale(crop.scale, crop.scale);
          recCtx.translate(-crop.cx, -crop.cy);
          if (D.AppState.canvasBoundsEnabled) {
            recCtx.save();
            recCtx.translate(D.AppState.canvasBounds.x + D.AppState.canvasBounds.w / 2, D.AppState.canvasBounds.y + D.AppState.canvasBounds.h / 2);
            recCtx.rotate(D.AppState.canvasBounds.rotation || 0);
            recCtx.beginPath();
            recCtx.rect(-D.AppState.canvasBounds.w / 2, -D.AppState.canvasBounds.h / 2, D.AppState.canvasBounds.w, D.AppState.canvasBounds.h);
            recCtx.clip();
            recCtx.restore();
          }
          D.renderScene(D.getObjectsForFrameAt(i, tid), { isExporting: true, frameIndex: i });
          recCtx.restore();
        }
        if (track.requestFrame) track.requestFrame();
        await new Promise(r => setTimeout(r, D.AppState.frames[i].duration));
      }
    } catch (e) {
      alert('导出失败：' + e.message);
    } finally {
      D.setCtx(savedCtx);
      recorder.stop();
      stopExportAudio(exportAudio);
      D.EventBus.emit('need:render');
    }
    const blob = await blobPromise;
    SKFE.platform.save(blob, 'stickman_video_' + Date.now() + '.webm');
  }

  /* ==================== MP4 ====================
     v7.4.6：两条路。
     ① 浏览器自带 MP4 录制（桌面 Chrome / Edge 有）—— 直接用 MediaRecorder，实时录。
     ② 移动端（Android Chrome / WebView）没有 MediaRecorder('video/mp4')，
        以前直接弹「不支持」就没了。现在改走 WebCodecs 的 VideoEncoder(H.264)
        + 内置的 mp4-muxer 封装成真正的 MP4 —— 不依赖实时录制，画多快编多快。 */
  function getMP4MimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4;codecs=h264', 'video/mp4'];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return null;
  }

  /* 有没有「WebCodecs 编码 + mp4 封装」这一套 */
  function canEncodeMp4() {
    return typeof window.VideoEncoder !== 'undefined' &&
      typeof window.VideoFrame !== 'undefined' &&
      !!(window.Mp4Muxer && window.Mp4Muxer.Muxer && window.Mp4Muxer.ArrayBufferTarget);
  }

  /* v7.6.1~7.6.5：反复修复 —— 安卓端 H.264 导出。
     五层问题逐个击破：
       1) isConfigSupported() 在 Android WebView 上误报 false → 用真正 configure() 实测；
       2) 探测用临时编码器 close 后硬件资源未异步释放 → 真正导出构造+配置带退避重试；
       3) codec string 的 AVC level 撑不住目标像素（如 1200×1200 需要 level 4.0，
          但默认 avc1.42001f 是 3.1，只到 921600）→ 按像素数动态选够高的 level；
       4) 高清档 configure() 过了、真到 new VideoEncoder()/encode() 才报
          "Encoder creation error." → 探测阶段就真编 1 帧，并把「码率阶梯 +
          分辨率阶梯」变成可回退的候选列表，整段导出失败就换下一档重来；
       5) 降档到 1280×720 后取景没重算，没画布时不再像 JPG 那样自动框选，
          画面出框 → 每次换档按新尺寸重算 baseCrop。
     桌面路径不走这里（走 MediaRecorder），改动只影响移动端 WebCodecs 路。 */
  /* AVC level → 最大帧像素数（MaxFS × 256）。codec string 末两位是 level 的十六进制：
     3.1=0x1F(921600)、3.2=0x20(1308160)、4.0=0x28(2097152)、
     4.1=0x29、4.2=0x2A(2228224)、5.0=0x32(5652480)。
     安卓 WebView 的 configure() 只校验字符串格式、不校验实际像素数，
     若 codec 声明的 level 撑不住目标分辨率，要到 encode() 才报
     "exceeds the maximum coded area ... You must either specify a lower
     resolution or higher AVC level." —— 所以必须在探测阶段就按像素数选够高的 level。 */
  function avcLevelForPixels(px) {
    if (px <= 921600) return '1f';
    if (px <= 1308160) return '20';
    if (px <= 2097152) return '28';
    if (px <= 2228224) return '2a';
    return '32';
  }

  /* v7.6.4：探测要「真编一帧」。Android WebView 的 configure() 经常放过
     硬件根本吃不下或码率过高的配置，直到 new VideoEncoder() / encode() /
     flush() 才抛 "Encoder creation error."。只做 configure 实测不够，
     这里构造一个同尺寸黑帧真的编码并 flush，过了才算可用。 */
  async function probeAvcConfig(cfg) {
    let probe = null;
    let probeErr = null;
    try {
      probe = new window.VideoEncoder({
        output() {},
        error: (e) => { probeErr = e; }
      });
      probe.configure(cfg);
      const cv = document.createElement('canvas');
      cv.width = cfg.width;
      cv.height = cfg.height;
      const cx = cv.getContext('2d', { alpha: false });
      cx.fillStyle = '#000000';
      cx.fillRect(0, 0, cv.width, cv.height);
      let vf = null;
      try {
        vf = new window.VideoFrame(cv, { timestamp: 0, duration: 1000 });
        probe.encode(vf, { keyFrame: true });
      } finally {
        if (vf) { try { vf.close(); } catch (_) {} }
      }
      let timer = null;
      try {
        await Promise.race([
          probe.flush(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timeout')), 1500); })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (probeErr) return false;
      return true;
    } catch (_) {
      return false;
    } finally {
      if (probe) { try { probe.close(); } catch (_) {} }
      /* 安卓硬编码器释放是异步的，探测完给一点缓冲，别连着把真正编码器挤掉 */
      await new Promise(r => setTimeout(r, 60));
    }
  }

  /* v7.6.4：返回「下一个」可用候选。excludeKeys 里是已经试过且整段导出失败的，
     调用方失败后再次调用，就会沿 码率阶梯 → 分辨率阶梯 继续往下退。 */
  async function pickAvcConfig(w, h, fps, bitrate, excludeKeys) {
    const skip = new Set(Array.isArray(excludeKeys) ? excludeKeys : []);
    /* 分辨率阶梯：优先用户选的尺寸，再逐级降。保持比例、偶数宽高（H.264 要求）。 */
    const sizes = [[w, h]];
    for (const s of [[1280, 720], [960, 540], [854, 480], [640, 360]]) {
      if (s[0] < sizes[0][0] && s[1] < sizes[0][1]) sizes.push(s);
    }
    for (const raw of sizes) {
      const ow = Math.max(2, raw[0] - (raw[0] % 2));
      const oh = Math.max(2, raw[1] - (raw[1] % 2));
      const fullBr = Math.max(400000, Math.round(ow * oh * fps * 0.12));
      /* 码率阶梯：高清档 1080p/3 倍高清算出来的 5~7 Mbps 远超很多安卓机
         硬编码上限。先试原码率，再试 4M、2M，尽量保住用户选的分辨率。 */
      const bitrates = [fullBr, Math.min(fullBr, 4000000), 2000000]
        .filter((v, i, a) => v <= fullBr && a.indexOf(v) === i);
      for (const br of bitrates) {
        /* 按这一档分辨率的像素数算出所需最低 level，把每个 profile 的 level 段替换掉。
           基线 / 主档 / 高档都试：不同机器硬编码器支持的 profile 不一样。 */
        const lvl = avcLevelForPixels(ow * oh);
        /* avc1.<profile><compat><level>：compat 固定 00，level 两位十六进制 */
        const codecs = [
          'avc1.4200' + lvl,   // Baseline
          'avc1.4d00' + lvl,   // Main
          'avc1.6400' + lvl    // High
        ];
        for (const codec of codecs) {
          /* 两种变体：带 avc.format（mp4-muxer 需要 avcC），以及不带（部分 WebView 不认这个字段） */
          const variants = [
            { codec: codec, width: ow, height: oh, bitrate: br, framerate: fps, avc: { format: 'avc' } },
            { codec: codec, width: ow, height: oh, bitrate: br, framerate: fps }
          ];
          for (const cfg of variants) {
            const key = JSON.stringify(cfg);
            if (skip.has(key)) continue;
            if (await probeAvcConfig(cfg)) {
              return { cfg, outW: ow, outH: oh, bitrate: br, key };
            }
          }
        }
      }
    }
    return null;
  }

  /* 导出到「最后一个有内容的帧」为止 —— 时间轴尾巴上那些谁都没出场的空白帧不要录进去 */
  function contentFrameCount(tid) {
    const total = D.AppState.frames.length;
    const ids = tid ? [String(tid)] : Object.keys(D.AppState.tracks || {});
    let last = -1;
    ids.forEach((id) => {
      const t = D.AppState.tracks[id];
      if (!t || !t.frames) return;
      for (let i = 0; i < t.frames.length; i++) {
        const f = t.frames[i];
        if (f && !(f.__d)) last = Math.max(last, i);
      }
    });
    if (last < 0) return total;
    return Math.min(total, last + 1);
  }

  /* v7.6.5：取景单独拆出来。v7.6.4 的降级阶梯会把 800×800 降到 1280×720（16:9），
     但 baseCrop 还是按原尺寸算的，导致「没有画布时自动框选」失效、内容出框。
     现在每次换档都按新尺寸重算，跟 JPG 的 getExportCrop 走同一套逻辑。 */
  function mp4BaseCrop(outW, outH, tid, cam) {
    if (cam && cam.w > 0 && cam.h > 0) return null;
    if (D.AppState.canvasBoundsEnabled) {
      const cb = D.AppState.canvasBounds;
      const rad = cb.rotation || 0;
      const ac = Math.abs(Math.cos(rad));
      const as = Math.abs(Math.sin(rad));
      /* 跟 getExportCrop 一致：旋转后的包围盒也要算进去，否则斜的画布会被裁 */
      const rw = cb.w * ac + cb.h * as;
      const rh = cb.w * as + cb.h * ac;
      return {
        cx: cb.x + cb.w / 2,
        cy: cb.y + cb.h / 2,
        scale: Math.min(outW / rw, outH / rh),
        rotation: rad
      };
    }
    const ec = D.getExportCrop(outW, outH, tid || null);
    return { cx: ec.cx, cy: ec.cy, scale: ec.scale, rotation: ec.rotation || 0 };
  }

  /* 画布尺寸 / 取景 / 背景 —— 两条路共用 */
  function mp4Setup(tid) {
    const isHD = document.getElementById('gifHD3x').checked;
    const is1080 = !!(document.getElementById('hd1080p') && document.getElementById('hd1080p').checked);
    const bgColor = (document.getElementById('mp4BgColor') && document.getElementById('mp4BgColor').value) || D.getPageBgColor();
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const baseSize = is1080 ? 1920 : (isHD ? 1200 : 800);
    let outW, outH;

    /* 3D 模式：导出尺寸必须取 3D 摄像机宽高比，而不是 2D 摄像机 / 画布边界。 */
    const S3X = window.SKFE && window.SKFE.systems && SKFE.systems.space3dExport;
    if (S3X && typeof S3X.isActive === 'function' && S3X.isActive()) {
      const cam3 = D.getCamera3DFrame ? D.getCamera3DFrame(0) : null;
      const cw = Math.max(1, Number(cam3 && cam3.width) || 1920);
      const ch = Math.max(1, Number(cam3 && cam3.height) || 1080);
      const a = cw / ch;
      if (a >= 1) { outW = baseSize; outH = Math.round(baseSize / a); }
      else { outH = baseSize; outW = Math.round(baseSize * a); }
      outW = Math.max(2, outW - (outW % 2));
      outH = Math.max(2, outH - (outH % 2));
      return { outW: outW, outH: outH, baseCrop: null, cam: null, bgColor: bgColor };
    }

    if (cam && cam.w > 0 && cam.h > 0) {
      const a = cam.w / cam.h;
      if (a >= 1) { outW = baseSize; outH = Math.round(baseSize / a); }
      else { outH = baseSize; outW = Math.round(baseSize * a); }
    } else if (D.AppState.canvasBoundsEnabled) {
      const sz = D.getExportSize();
      outW = sz.w; outH = sz.h;
    } else {
      outW = baseSize; outH = baseSize;
    }
    outW = Math.max(2, outW - (outW % 2));
    outH = Math.max(2, outH - (outH % 2));
    return {
      outW: outW, outH: outH,
      baseCrop: mp4BaseCrop(outW, outH, tid, cam),
      cam: cam, bgColor: bgColor
    };
  }

  /* 把第 i 帧画到导出画布上（两条路共用，免得改一处漏一处） */
  function paintFrame(recCtx, i, plan, tid) {
    /* 阶段 4：3D 模式按摄像机视角直接渲染进录制画布；2D 路径逐行保持原样。 */
    const S3X = window.SKFE && window.SKFE.systems && SKFE.systems.space3dExport;
    if (S3X && typeof S3X.isActive === 'function' && S3X.isActive()) {
      S3X.renderFrameToCanvas(recCtx.canvas, plan.outW, plan.outH, i, {
        transparent: false,
        bgColor: plan.bgColor,
        trackId: tid,
        showGrid: s3ExportGridEnabled(),
        camera3dFrame: D.getCamera3DFrame ? D.getCamera3DFrame(i) : null
      });
      return;
    }

    let curCrop = plan.baseCrop;
    if (plan.cam) {
      const frameCam = D.getCameraAtFrame(i) || plan.cam;
      const cc = D.cameraToCrop(frameCam, plan.outW, plan.outH);
      curCrop = { cx: cc.cx, cy: cc.cy, scale: cc.scale, rotation: cc.rotation || 0 };
    }
    recCtx.save();
    recCtx.setTransform(1, 0, 0, 1, 0, 0);
    recCtx.fillStyle = plan.bgColor;
    recCtx.fillRect(0, 0, plan.outW, plan.outH);
    recCtx.translate(plan.outW / 2, plan.outH / 2);
    if (curCrop) {
      if (curCrop.rotation) recCtx.rotate(-curCrop.rotation);
      recCtx.scale(curCrop.scale, curCrop.scale);
      recCtx.translate(-curCrop.cx, -curCrop.cy);
    }
    if (D.AppState.canvasBoundsEnabled) {
      recCtx.save();
      recCtx.translate(D.AppState.canvasBounds.x + D.AppState.canvasBounds.w / 2, D.AppState.canvasBounds.y + D.AppState.canvasBounds.h / 2);
      recCtx.rotate(D.AppState.canvasBounds.rotation || 0);
      recCtx.beginPath();
      recCtx.rect(-D.AppState.canvasBounds.w / 2, -D.AppState.canvasBounds.h / 2, D.AppState.canvasBounds.w, D.AppState.canvasBounds.h);
      recCtx.clip();
      recCtx.restore();
    }
    D.renderScene(D.getObjectsForFrameAt(i, tid), { isExporting: true, frameIndex: i });
    recCtx.restore();
  }

  /* ② WebCodecs 编码 → mp4-muxer 封装（移动端主用） */
  let lastDowngradeNotice = '';

  async function exportMP4WithEncoder(plan, tid, triedKeys) {
    const mux = window.Mp4Muxer;
    const n = contentFrameCount(tid);
    if (!n) throw new Error('没有可导出的帧');
    /* v7.8.4：WebCodecs 路先把整段音轨混好；设备没有 AAC 编码器就只导出画面 */
    const audioBuffer = await renderExportAudio(n, tid);
    const hasAudioTrack = !!(audioBuffer && window.AudioEncoder && window.AudioData);
    const tried = Array.isArray(triedKeys) ? triedKeys : [];
    /* 每次回退都从用户最初选的尺寸重新算阶梯，避免越退越偏 */
    const reqW = plan.outW, reqH = plan.outH;
    const fps = exportFPS();
    const bitrate = Math.max(800000, Math.round(reqW * reqH * fps * 0.12));
    const picked = await pickAvcConfig(reqW, reqH, fps, bitrate, tried);
    if (!picked) {
      throw new Error('这台设备的浏览器无法编码所选高清视频（已尝试降低码率与分辨率），请关掉 3 倍高清 / 1080p 后重试');
    }
    tried.push(picked.key);
    const cfg = picked.cfg;
    /* 用实测可用的尺寸建画布与封装器；paintFrame 也按这个尺寸铺底，否则上下留黑边 */
    const outW = picked.outW, outH = picked.outH;
    plan.outW = outW; plan.outH = outH;
    /* v7.6.5：降档后必须重算取景，否则 800×800 的 baseCrop 被套到 1280×720 上，
       没有画布时就不会像 JPG 那样自动框选，画面会被裁掉。 */
    plan.baseCrop = mp4BaseCrop(outW, outH, tid, plan.cam);
    if (outW !== reqW || outH !== reqH || picked.bitrate < bitrate * 0.9) {
      try {
        console.warn('[MP4] 高清参数不被设备支持，改用 ' + outW + '×' + outH + ' / ' +
          (picked.bitrate / 1000000).toFixed(1) + 'Mbps 导出');
      } catch (_) {}
    }

    const btn = document.getElementById('btnExportMP4');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; }
    let encoder = null;
    let encError = null;
    let lastErr = null;
    let savedCtx = null;
    let muxer = null;
    let buf = null;
    let success = false;

    try {
      const recCanvas = document.createElement('canvas');
      recCanvas.width = outW; recCanvas.height = outH;
      const recCtx = recCanvas.getContext('2d', { alpha: false });
      const muxOptions = {
        target: new mux.ArrayBufferTarget(),
        video: { codec: 'avc', width: outW, height: outH, frameRate: fps },
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset'
      };
      if (hasAudioTrack) {
        muxOptions.audio = {
          codec: 'aac',
          numberOfChannels: audioBuffer.numberOfChannels,
          sampleRate: audioBuffer.sampleRate
        };
      }
      muxer = new mux.Muxer(muxOptions);

      /* v7.6.2：构造 + configure 一起重试，等安卓异步释放硬件编码器。
         v7.6.4：这里再失败不再直接报错，而是交给外层换下一个候选配置。 */
      const backoff = [120, 300, 600, 1000];
      for (let attempt = 0; attempt < backoff.length; attempt++) {
        let cand = null;
        try {
          cand = new window.VideoEncoder({
            output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (_) {} },
            error: (e) => { encError = e; }
          });
          cand.configure(cfg);
          encoder = cand;
          break;
        } catch (e) {
          lastErr = e;
          try { if (cand) cand.close(); } catch (_) {}
          if (backoff[attempt]) await new Promise(r => setTimeout(r, backoff[attempt]));
        }
      }
      if (!encoder) throw (lastErr || new Error('Encoder creation error.'));

      savedCtx = D.getCtx();
      D.setCtx(recCtx);
      let tUs = 0;
      for (let i = 0; i < n; i++) {
        if (encError) throw encError;
        if (btn) btn.textContent = `MP4 ${i + 1}/${n}`;
        await D.prepareVideoClipsForFrame(i); /* v7.7.1：视频元件定格到该帧 */
        paintFrame(recCtx, i, plan, tid);
        const frameObj = D.AppState.frames[i] || {};
        const durUs = Math.max(1000, Math.round((frameObj.duration || Math.round(1000 / fps)) * 1000));
        let vf = null;
        try {
          vf = new window.VideoFrame(recCanvas, { timestamp: tUs, duration: durUs });
          encoder.encode(vf, { keyFrame: (i % Math.max(1, fps)) === 0 });
        } finally {
          if (vf) { try { vf.close(); } catch (_) {} }
        }
        tUs += durUs;
        /* 编码是异步的：队列堆太多就喘一口气，顺便让进度文字刷出来 */
        if (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 8));
        else if (i % 6 === 0) await new Promise(r => setTimeout(r, 0));
      }
      await encoder.flush();
      if (encError) throw encError;
      if (hasAudioTrack) {
        await encodeAudioForMuxer(audioBuffer, (chunk, meta) => muxer.addAudioChunk(chunk, meta));
      }
      muxer.finalize();
      buf = muxer.target.buffer;
      if (!buf || !buf.byteLength) throw new Error('没有生成视频数据');
      success = true;
    } catch (e) {
      lastErr = e;
    } finally {
      try { if (encoder) encoder.close(); } catch (_) {}
      if (savedCtx) D.setCtx(savedCtx);
      if (btn) { btn.textContent = oldText; btn.disabled = false; }
      D.EventBus.emit('need:render');
    }

    if (success) {
      SKFE.platform.save(new Blob([buf], { type: 'video/mp4' }), 'stickman_video_' + Date.now() + '.mp4');
      /* 只有真的降档了才提示，且同一条提示一次会话只弹一次，不打扰正常导出 */
      if ((outW !== reqW || outH !== reqH || picked.bitrate < bitrate * 0.9)) {
        const msg = '这台设备无法用所选高清参数编码，已自动降到 ' + outW + '×' + outH + ' / ' +
          (picked.bitrate / 1000000).toFixed(1) + 'Mbps 导出。若想更快，可在导出面板关掉 3 倍高清 / 1080p。';
        if (msg !== lastDowngradeNotice) {
          lastDowngradeNotice = msg;
          try { alert(msg); } catch (_) {}
        }
      }
      return;
    }

    /* v7.6.4：整段导出失败（含 Encoder creation error / encode 阶段报错）就换下一档。
       最多再试 8 次，避免候选列表过长时无限重来。 */
    if (tried.length < 8) {
      plan.outW = reqW; plan.outH = reqH;
      try { console.warn('[MP4] 编码失败，换下一档配置重试：' + ((lastErr && lastErr.message) || lastErr)); } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
      return exportMP4WithEncoder(plan, tid, tried);
    }
    throw (lastErr || new Error('编码器暂时不可用，请关掉 1080p 或重启 App'));
  }

  /* ① 浏览器自带 MP4 录制（桌面） */
  async function exportMP4WithRecorder(plan, mimeType, tid) {
    const n = contentFrameCount(tid);
    const fps = exportFPS();
    const recCanvas = document.createElement('canvas');
    recCanvas.width = plan.outW; recCanvas.height = plan.outH;
    const recCtx = recCanvas.getContext('2d', { alpha: false });
    /* 之前写死 30，导致界面设为 12fps 导出的 MP4 仍被标成 30fps。 */
    const stream = recCanvas.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    /* v7.8.4：桌面录制路也把离线混好的音频挂到同一个 stream */
    const audioBuffer = await renderExportAudio(n, tid);
    const exportAudio = await attachExportAudioToStream(stream, audioBuffer);
    let recorder;
    try { recorder = new MediaRecorder(stream, { mimeType: mimeType }); }
    catch (e) { throw new Error('创建 MP4 录制器失败：' + e.message); }
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const blobPromise = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/mp4' })); });
    const btn = document.getElementById('btnExportMP4');
    const oldText = btn ? btn.textContent : '';
    if (btn) btn.disabled = true;
    recorder.start();
    const savedCtx = D.getCtx();
    D.setCtx(recCtx);
    try {
      for (let i = 0; i < n; i++) {
        if (btn) btn.textContent = `MP4 ${i + 1}/${n}`;
        await D.prepareVideoClipsForFrame(i); /* v7.7.1：视频元件定格到该帧 */
        paintFrame(recCtx, i, plan, tid);
        if (track.requestFrame) track.requestFrame();
        await new Promise(r => setTimeout(r, (D.AppState.frames[i] && D.AppState.frames[i].duration) || 83));
      }
    } finally {
      D.setCtx(savedCtx);
      recorder.stop();
      stopExportAudio(exportAudio);
      if (btn) { btn.textContent = oldText; btn.disabled = false; }
      D.EventBus.emit('need:render');
    }
    const blob = await blobPromise;
    if (!blob || blob.size === 0) throw new Error('未生成视频数据');
    SKFE.platform.save(blob, 'stickman_video_' + Date.now() + '.mp4');
  }

  /* 触屏移动端判定（v7.4.6）：手机上的 MediaRecorder 对 mp4 常常「嘴上说支持、录出来不是那么回事」，
     所以移动端有 WebCodecs 就优先走编码路，别再赌 MediaRecorder。 */
  function looksMobile() {
    try {
      const ua = navigator.userAgent || '';
      if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OpenHarmony/i.test(ua)) return true;
      /* iPadOS 13+ 的 UA 伪装成 Macintosh，靠触摸点数 + 没有精确指针补一刀 */
      if (navigator.maxTouchPoints > 1) {
        let fine = false;
        try { fine = window.matchMedia('(pointer: fine)').matches; } catch (_) {}
        if (!fine) return true;
      }
    } catch (_) {}
    return false;
  }

  async function exportMP4() {
    if (D.AppState.frames.length === 0) return;
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const tid = D.isSubTrackMode() ? String(D.AppState.activeTrackId) : null;
    const mimeType = getMP4MimeType();
    const encOk = canEncodeMp4();
    if (!mimeType && !encOk) {
      alert('这台设备的浏览器不支持 MP4 导出。\n可以先用「导出 GIF」或「导出 PNG 序列」，或换 Chrome / Edge 桌面版。');
      return;
    }
    const plan = mp4Setup(tid);
    /* 选路（v7.4.6 + v7.8.4）：
       移动端 / 根本没有 mp4 录制能力 → 先走 WebCodecs 编码；
       桌面且能录 mp4 → 先走 MediaRecorder（老路径，行为不变）。
       有音轨但设备没有 AAC 编码器时，优先用 MediaRecorder 录，避免导出一条静音视频。 */
    let hasAudioEvents = false;
    try {
      hasAudioEvents = !!(D.collectAudioTimeline && D.collectAudioTimeline(contentFrameCount(tid), tid).length);
    } catch (_) {}
    const canEncodeAudio = !!(window.AudioEncoder && window.AudioData);
    const preferEncoder = encOk && (!mimeType || looksMobile()) && !(hasAudioEvents && !canEncodeAudio && !!mimeType);
    const steps = [];
    if (preferEncoder) {
      steps.push(() => exportMP4WithEncoder(plan, tid));
      if (mimeType) steps.push(() => exportMP4WithRecorder(plan, mimeType, tid));
    } else {
      if (mimeType) steps.push(() => exportMP4WithRecorder(plan, mimeType, tid));
      if (encOk) steps.push(() => exportMP4WithEncoder(plan, tid));
    }
    let lastErr = null;
    for (let k = 0; k < steps.length; k++) {
      try { await steps[k](); return; }
      catch (e) { lastErr = e; }
    }
    alert('MP4 导出失败：' + (lastErr && lastErr.message ? lastErr.message : lastErr));
  }

  function exportPNGSeq() {
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const _sz = D.getExportSize();
    const outW = _sz.w;
    const outH = _sz.h;
    const transparent = document.getElementById('gifTransparent').checked;
    const tid = D.isSubTrackMode() ? String(D.AppState.activeTrackId) : null;
    
    // 如果存在摄像机且未开启画布优先，则传 null，让 renderFrameToDataURL 逐帧计算
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const crop = cam ? null : D.getExportCrop(outW, outH, tid);
    
    exportPNGsAsZip(D.AppState.frames, tid, {
      outW,
      outH,
      crop,
      transparent
    });
  }

  return {
    init,
    getJSZip,
    exportPNGsAsZip,
    getGifenc,
    exportGIF,
    getMP4MimeType,
    exportMP4,
    exportVideo,
    exportPNGSeq,
    exportSVGsAsZip,
    exportSVGSeq
  };
})();
