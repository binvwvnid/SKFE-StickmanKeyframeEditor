// js/core/geometry.js
window.SKFE = window.SKFE || {};
SKFE.core = SKFE.core || {};

SKFE.core.geometry = (function () {
  'use strict';

  const along = (p, ang, len) => ({ x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len });
  const norm = a => Math.atan2(Math.sin(a), Math.cos(a));

  function distToSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
    const t = c1 / c2;
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  }

  function worldToFigureLocal(fig, p) {
    let dx = p.x - fig.x, dy = p.y - fig.y;
    const rot = (fig.rot || 0) * Math.PI / 180;
    if (rot) {
      const c = Math.cos(-rot), s = Math.sin(-rot);
      const nx = dx * c - dy * s;
      const ny = dx * s + dy * c;
      dx = nx; dy = ny;
    }
    if (fig.mirror) dx = -dx;
    return { x: fig.x + dx, y: fig.y + dy };
  }

  /* ===== v7.9.4：柳叶笔（Blob）=====
     输入是一串笔画点（世界 / 屏幕 / ink 局部坐标都可以），输出一条闭合多边形。
     规则：
       1. 先抽掉几乎重合的点，避免 Chaikin 平滑时被重复点拖歪；
       2. 画成闭合区域时，只做平滑填充；
       3. 开放轨迹则沿切线法线左右扩成不规则有机块，首尾自动闭合。 */
  function dedupePoints(points) {
    const out = [];
    for (const p of points || []) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      const q = { x: p.x, y: p.y, w: p.w || 0 };
      const last = out[out.length - 1];
      if (last && Math.hypot(q.x - last.x, q.y - last.y) < 0.05) {
        last.w = Math.max(last.w, q.w);
        continue;
      }
      out.push(q);
    }
    return out;
  }

  function chaikin(points, closed, iterations) {
    let out = points.slice();
    for (let k = 0; k < iterations; k++) {
      if (out.length < 2) break;
      const next = [];
      if (closed) {
        const n = out.length;
        for (let i = 0; i < n; i++) {
          const p = out[i], q = out[(i + 1) % n];
          next.push({
            x: p.x * 0.75 + q.x * 0.25,
            y: p.y * 0.75 + q.y * 0.25,
            w: (p.w || 0) * 0.75 + (q.w || 0) * 0.25
          });
        }
      } else {
        next.push(out[0]);
        for (let i = 0; i < out.length - 1; i++) {
          const p = out[i], q = out[i + 1];
          next.push({
            x: p.x * 0.75 + q.x * 0.25,
            y: p.y * 0.75 + q.y * 0.25,
            w: (p.w || 0) * 0.75 + (q.w || 0) * 0.25
          });
          next.push({
            x: p.x * 0.25 + q.x * 0.75,
            y: p.y * 0.25 + q.y * 0.75,
            w: (p.w || 0) * 0.25 + (q.w || 0) * 0.75
          });
        }
        next.push(out[out.length - 1]);
      }
      out = next;
    }
    return out;
  }

  function circleLoop(p, radius, steps) {
    const r = Math.max(0.5, radius || 1);
    const n = steps || 16;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, w: p.w || 0 });
    }
    return out;
  }

  function blobLoopFromPoints(points, seed) {
    const raw = dedupePoints(points);
    if (!raw.length) return [];
    /* 柳叶笔只画轨迹路径：单点 / 原地抖动不再生成圆点。蜡笔的单点颗粒走自己的函数。 */
    if (raw.length === 1) return [];

    /* 起点附近若有一小圈手抖轨迹，会包出一个看起来像独立点的形状。
       只有确认为「原地抖动簇」才整段去掉；正常起笔从第一点保留，不能把轨迹截短。 */
    let maxW = 1;
    for (const p of raw) maxW = Math.max(maxW, p.w || 0);
    const stayRadius = Math.max(1.2, maxW);
    let startAt = -1;
    let clusterLen = 0;
    for (let i = 1; i < raw.length; i++) {
      const d = Math.hypot(raw[i].x - raw[0].x, raw[i].y - raw[0].y);
      if (d > stayRadius) {
        startAt = (i >= 3 && clusterLen > stayRadius * 0.8) ? i : 0;
        break;
      }
      clusterLen += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    }
    if (startAt < 0) return []; /* 整笔都在起点附近 = 点一下，不画 */
    const trimmed = raw.slice(startAt);
    if (trimmed.length < 2) return [];

    let len = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < trimmed.length; i++) {
      const p = trimmed[i];
      if (i) len += Math.hypot(p.x - trimmed[i - 1].x, p.y - trimmed[i - 1].y);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const chord = Math.hypot(trimmed[trimmed.length - 1].x - trimmed[0].x, trimmed[trimmed.length - 1].y - trimmed[0].y);
    const diag = Math.max(1e-6, Math.hypot(maxX - minX, maxY - minY));
    const isClosed = trimmed.length >= 5 && chord < len * 0.32 && len > diag * 1.4;
    const smooth = chaikin(trimmed, isClosed, 2);
    if (isClosed) return smooth;

    const phase = (typeof seed === 'number' && isFinite(seed)) ? seed : 0;
    const left = [], right = [];
    const n = smooth.length;
    for (let i = 0; i < n; i++) {
      const p = smooth[i];
      const prev = smooth[Math.max(0, i - 1)];
      const next = smooth[Math.min(n - 1, i + 1)];
      let dx = next.x - prev.x, dy = next.y - prev.y;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      const nx = -dy, ny = dx;
      const t = n <= 1 ? 0 : i / (n - 1);
      const base = Math.max(0.6, (p.w || 2) / 2);
      const organic = 1
        + 0.16 * Math.sin(i * 0.71 + phase)
        + 0.09 * Math.sin(i * 1.93 + phase * 0.37);
      /* 起步和收笔不再额外缩成圆头；起点抖动簇已在上面裁掉。 */
      const cap = 0.92 + 0.08 * Math.sin(Math.PI * t);
      const r = Math.max(0.45, base * organic * cap);
      left.push({ x: p.x + nx * r, y: p.y + ny * r, w: p.w || 0 });
      right.push({ x: p.x - nx * r, y: p.y - ny * r, w: p.w || 0 });
    }
    return left.concat(right.reverse());
  }

  /* ===== v7.9.4：蜡笔颗粒 =====
     蜡笔不是平滑线，而是沿笔迹定点下一批带随机偏移的小色块。
     参数全部由 seed + 段号 + 颗粒号推导，渲染 / 导出 / 缩放 / 变形时结果稳定。 */
  function hashUnit(a, b, seed) {
    const v = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453123;
    return v - Math.floor(v);
  }

  function crayonDabsFromPoints(points, seed) {
    const raw = dedupePoints(points);
    if (!raw.length) return [];
    const s = (typeof seed === 'number' && isFinite(seed)) ? seed : 0;
    const dabs = [];

    if (raw.length === 1) {
      const p = raw[0];
      const width = Math.max(1.5, p.w || 2);
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = hashUnit(i, 1, s) * Math.PI * 2;
        const r = width * (0.06 + 0.24 * hashUnit(i, 2, s));
        dabs.push({
          x: p.x + Math.cos(a) * r,
          y: p.y + Math.sin(a) * r,
          w: width * (0.38 + 0.58 * hashUnit(i, 3, s)),
          h: width * (0.22 + 0.34 * hashUnit(i, 4, s)),
          angle: a + (hashUnit(i, 5, s) - 0.5) * 0.5,
          alpha: 0.58 + 0.38 * hashUnit(i, 6, s),
          skew: hashUnit(i, 7, s)
        });
      }
      return dabs;
    }

    let dabId = 0;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.08) continue;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      const width = Math.max(1.5, (a.w + b.w) / 2 || ((a.w || 0) + (b.w || 0)) / 2);
      const spacing = Math.max(0.6, width * 0.11);
      const count = Math.max(1, Math.min(72, Math.floor(len / spacing)));
      for (let j = 0; j < count; j++) {
        const t = (j + 0.5) / count;
        const id = dabId++;
        const off = (hashUnit(id, 1, s) - 0.5) * width * 0.52;
        const px = a.x + dx * t + nx * off;
        const py = a.y + dy * t + ny * off;
        const along = width * (0.34 + 0.54 * hashUnit(id, 2, s));
        const thick = width * (0.20 + 0.32 * hashUnit(id, 3, s));
        const angle = Math.atan2(uy, ux) + (hashUnit(id, 4, s) - 0.5) * 0.42;
        const alpha = 0.58 + 0.38 * hashUnit(id, 5, s);
        dabs.push({ x: px, y: py, w: along, h: thick, angle, alpha, skew: hashUnit(id, 6, s) });
      }
    }
    return dabs;
  }

  /* 蜡笔底层：先铺一层半透明连续的蜡迹，让颗粒不再是孤立小方块；
     这层不是包边，只是同色蜡质底层，宽度仍等于画笔尺寸。 */
  function paintCrayonBase(c, points, color, mapFn, scaleFn, alpha) {
    const pts = dedupePoints(points);
    if (!c || !pts.length || !color) return;
    const baseAlpha = (typeof c.globalAlpha === 'number') ? c.globalAlpha : 1;
    c.save();
    c.globalAlpha = baseAlpha * (alpha == null ? 0.42 : alpha);
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (pts.length === 1) {
      const q = mapFn ? mapFn(pts[0]) : pts[0];
      const k = scaleFn ? scaleFn(pts[0]) : 1;
      c.beginPath();
      c.arc(q.x, q.y, Math.max(0.6, (pts[0].w || 2) * k / 2), 0, Math.PI * 2);
      c.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const qa = mapFn ? mapFn(a) : a;
        const qb = mapFn ? mapFn(b) : b;
        const ka = scaleFn ? scaleFn(a) : 1;
        const kb = scaleFn ? scaleFn(b) : 1;
        c.lineWidth = Math.max(0.6, ((a.w || 0) * ka + (b.w || 0) * kb) / 2);
        c.beginPath();
        c.moveTo(qa.x, qa.y);
        c.lineTo(qb.x, qb.y);
        c.stroke();
      }
    }
    c.restore();
    c.globalAlpha = baseAlpha;
  }

  function paintCrayonDabs(c, dabs, mapFn, scaleFn) {
    if (!c || !dabs || !dabs.length) return;
    const baseAlpha = (typeof c.globalAlpha === 'number') ? c.globalAlpha : 1;
    for (const d of dabs) {
      const q = mapFn ? mapFn(d) : d;
      const k = scaleFn ? scaleFn(d) : 1;
      const w = d.w * k, h = d.h * k;
      const sk = d.skew == null ? 0.2 : d.skew;
      c.save();
      c.globalAlpha = baseAlpha * (d.alpha == null ? 1 : d.alpha);
      c.translate(q.x, q.y);
      c.rotate(d.angle || 0);
      c.beginPath();
      c.moveTo(-w * 0.5, -h * (0.34 + sk * 0.18));
      c.lineTo(w * (0.28 + sk * 0.18), -h * 0.5);
      c.lineTo(w * 0.5, h * (0.28 + sk * 0.20));
      c.lineTo(-w * (0.30 + sk * 0.16), h * 0.5);
      c.closePath();
      c.fill();
      c.restore();
    }
    c.globalAlpha = baseAlpha;
  }

  /* ===== v7.9.4b：单条蜡笔线的粗糙炭笔感 =====
     旧版只有同色短笔触，边缘还是太整齐。这里在短笔触外再撒一层「边角碎屑」，
     然后把整条笔迹画进一次性离屏层，用固定种子的纸纹噪点抠出细小白洞。
     离屏层保证 destination-out 只吃掉蜡笔本身，不会擦掉下面的画布内容。 */
  function crayonEdgeDabsFromPoints(points, seed) {
    const raw = dedupePoints(points);
    if (!raw.length) return [];
    const s = (typeof seed === 'number' && isFinite(seed)) ? seed : 0;
    const dabs = [];
    let id = 0;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.08) continue;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      const width = Math.max(1.5, (a.w + b.w) / 2 || ((a.w || 0) + (b.w || 0)) / 2);
      const spacing = Math.max(0.9, width * 0.16);
      const count = Math.max(1, Math.min(96, Math.floor(len / spacing)));
      for (let j = 0; j < count; j++) {
        const t = (j + 0.5) / count;
        const n = id++;
        const side = hashUnit(n, 11, s) < 0.5 ? -1 : 1;
        const off = side * width * (0.38 + 0.30 * hashUnit(n, 12, s));
        dabs.push({
          x: a.x + dx * t + nx * off,
          y: a.y + dy * t + ny * off,
          w: width * (0.14 + 0.34 * hashUnit(n, 13, s)),
          h: width * (0.10 + 0.24 * hashUnit(n, 14, s)),
          angle: Math.atan2(uy, ux) + (hashUnit(n, 15, s) - 0.5) * 1.1,
          alpha: 0.28 + 0.46 * hashUnit(n, 16, s),
          skew: hashUnit(n, 17, s)
        });
      }
    }
    return dabs;
  }

  function crayonGrainBounds(pts, mapFn, scaleFn) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const q = mapFn ? mapFn(p) : p;
      const k = scaleFn ? scaleFn(p) : 1;
      if (!q || !isFinite(q.x) || !isFinite(q.y)) continue;
      const r = Math.max(1.5, (p.w || 2) * k * 0.72);
      if (q.x - r < minX) minX = q.x - r;
      if (q.y - r < minY) minY = q.y - r;
      if (q.x + r > maxX) maxX = q.x + r;
      if (q.y + r > maxY) maxY = q.y + r;
    }
    if (!isFinite(minX)) return null;
    return { x: Math.floor(minX - 3), y: Math.floor(minY - 3), w: Math.ceil(maxX - minX + 6), h: Math.ceil(maxY - minY + 6) };
  }

  let crayonScratchCanvas = null;
  let crayonScratchCtx = null;
  function getCrayonScratch(w, h, dpr) {
    const pw = Math.max(1, Math.ceil(w * dpr));
    const ph = Math.max(1, Math.ceil(h * dpr));
    if (!crayonScratchCanvas) {
      crayonScratchCanvas = document.createElement('canvas');
      crayonScratchCtx = crayonScratchCanvas.getContext('2d');
    }
    if (crayonScratchCanvas.width !== pw || crayonScratchCanvas.height !== ph) {
      crayonScratchCanvas.width = pw;
      crayonScratchCanvas.height = ph;
    }
    crayonScratchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    crayonScratchCtx.clearRect(0, 0, w, h);
    return crayonScratchCtx;
  }

  function applyCrayonPaperGrain(c, w, h, seed) {
    if (!c || w <= 0 || h <= 0) return;
    const s = (typeof seed === 'number' && isFinite(seed)) ? seed : 0;
    const step = 2.35;
    let id = 0;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = '#000';
    for (let gy = 0; gy < h; gy += step) {
      for (let gx = 0; gx < w; gx += step) {
        const n = id++;
        if (hashUnit(n, 21, s) < 0.31) continue;
        const x = gx + (hashUnit(n, 22, s) - 0.5) * step;
        const y = gy + (hashUnit(n, 23, s) - 0.5) * step;
        const r = 0.28 + 0.72 * hashUnit(n, 24, s);
        c.globalAlpha = 0.38 + 0.62 * hashUnit(n, 25, s);
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  /** 三套渲染共用的单条蜡笔线：离屏合成后再贴回目标画布。
      mapFn/scaleFn 既可以是 null（局部坐标），也可以是 worldToScreen 或扭曲 mapWorld。 */
  function drawCrayonStroke(c, points, color, seed, mapFn, scaleFn) {
    if (!c || !points || !points.length || !color) return;
    const pts = dedupePoints(points);
    if (!pts.length) return;
    const box = crayonGrainBounds(pts, mapFn, scaleFn);
    if (!box || box.w <= 0 || box.h <= 0) return;

    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (box.w * box.h * dpr * dpr > 16000000) {
      /* 超长笔迹退回原画法，避免离屏层过大拖垮手机 */
      c.save();
      paintCrayonBase(c, pts, color, mapFn, scaleFn, 0.40);
      c.fillStyle = color;
      paintCrayonDabs(c, crayonDabsFromPoints(pts, seed), mapFn, scaleFn);
      c.restore();
      return;
    }

    const sc = getCrayonScratch(box.w, box.h, dpr);
    sc.save();
    sc.translate(-box.x, -box.y);
    paintCrayonBase(sc, pts, color, mapFn, scaleFn, 0.36);
    sc.fillStyle = color;
    paintCrayonDabs(sc, crayonDabsFromPoints(pts, seed), mapFn, scaleFn);
    paintCrayonDabs(sc, crayonEdgeDabsFromPoints(pts, seed), mapFn, scaleFn);
    sc.restore();

    applyCrayonPaperGrain(sc, box.w, box.h, seed);
    c.save();
    c.drawImage(crayonScratchCanvas, box.x, box.y, box.w, box.h);
    c.restore();
  }

  return { along, norm, distToSeg, worldToFigureLocal, blobLoopFromPoints, crayonDabsFromPoints, crayonEdgeDabsFromPoints, paintCrayonBase, paintCrayonDabs, drawCrayonStroke };
})();
