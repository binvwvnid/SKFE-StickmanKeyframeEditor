/* ============================================================================
   track-strip.js — 轨道视图（v7.4.x，类 AM / 剪映的多轨时间轴）
   ----------------------------------------------------------------------------
   三条硬约束（改这个文件前先看这三条，否则很容易把工程数据写坏）：

   1. 轨道数据只认 AppState.tracks —— 读用 getTrackFrame / KF.segments，
      写只通过本文件的 takeRange / putRange / vacate，最后必须走 reconcileTrack。
   2. 段规则：任意相邻两个关键帧之间叫一个「段」，段内所有空槽都会被
      reconcileTrack 填成派生帧（= 那一帧元件在场）。所以
        · 让元件「不出场」只有一条合法路子：在某帧落一个 hidden 关键帧，
          它到下一个关键帧之间的派生帧就全部算「不在场」；
        · 拉长/补帧只能用**普通帧**（不带 __k），否则会平白多出关键帧。
   3. 一次拖拽 = 一步撤销：pointerdown 时取快照，pointerup 时 pushPre + saveHistory。

   本文件不修改 updateFrameBar / 帧块 DOM / 拖帧 / 多选 / 补间，只订阅事件总线
   被动刷新（rAF 去抖 + 数据指纹比对），所以不点「轨道」按钮时行为与旧版一致。
   ============================================================================ */
(function () {
  'use strict';

  const root = window;
  root.SKFE = root.SKFE || {};
  root.SKFE.features = root.SKFE.features || {};

  const COLW_KEY = 'skfe_track_colw_v1';
  const HEIGHT_KEY = 'skfe_track_h_v1';
  const MODE_KEY = 'skfe_track_mode_v1';

  const GUTTER = 108;      /* 左列宽（眼睛 + 元件名），sticky 不随横向滚动 */
  const ROW_H = 32;        /* 每条轨道高度 */
  const RULER_H = 22;      /* 顶部刻度尺高度 */
  const HANDLE_W = 10;     /* 两端手柄的命中宽度（鼠标） */
  const HANDLE_W_TOUCH = 22; /* v7.7.0：触屏手指粗，手柄命中区放大，否则拉长段落几乎点不中 */
  const KEY_HIT = 13;      /* 关键帧菱形的命中直径 */
  const MIN_H = 160;       /* 面板最小高度 */
  const MAX_FRAMES = 600;  /* 拖拽时允许撑长的上限，防止误拖出几万帧 */
  const TIME_MIN_CW = 14;  /* 列宽小于它就改用「分:秒」刻度 */
  const COLW_STEPS = [6, 8, 10, 13, 16, 20, 26, 33, 42, 54];

  let api = null;
  let enabled = false;
  let colW = 26;
  /* v7.4.9：左列宽度在样式里是跟着断点变的（桌面 108 / 手机 84），
     所以只能在渲染时读一次 --ts-gutter 存这儿，不能再用写死的 GUTTER 算播放头。 */
  let gutterPx = GUTTER;
  let panelH = 240;        /* 面板高度默认值：约 4~5 条轨道，屏幕上还留得出画布 */
  let drag = null;
  let selClip = null;      /* 最近点选的那一条长条 { id, a, b } —— 分割认它 */
  let selClips = [];       /* v7.4.4：多选长条（框选 / Ctrl 点选）。整体移动、整体删除认它 */
  let lastPickedId = null; /* 最近点过的轨道：切帧会把 AppState.selected 清空，靠它兜底 */
  let lastSig = '';        /* 上次渲染时的数据指纹，用来跳过无变化的重画 */
  let refreshQueued = false;

  /* ---- v7.4.3：关键帧多选 / 剪切板 ----
     token 就是 '轨道id|帧号'，跨轨道共用一套 —— 和 AM 的 layerId|channel|frame 同一个思路，
     这样「框选一片、整体平移、复制到另一条轨」都不需要额外的数据结构。 */
  let selKeys = new Set();   /* 选中的关键帧 token 集合 */
  let keyClip = null;        /* 剪切板：{ base: 最小帧号, items: [{ id, off, obj }] } */

  const $ = (id) => document.getElementById(id);

  function T(key, fallback) {
    if (typeof window.t !== 'function') return fallback;
    const v = window.t(key);
    return (v == null || v === key) ? fallback : v;
  }
  function KF() { return root.SKFE.systems.keyframes; }
  function tracksMap() { return api ? api.tracks() : {}; }
  function totalFrames() { return Math.max(1, api ? api.totalFrames() : 1); }
  function fps() { const f = api && api.fps ? api.fps() : 12; return (f > 0 ? f : 12); }

  /* v7.8.4：音频波形占位。第一版不做真实采样解码（视频音轨浏览器无法直接 decode），
     用元件 id + 段序号派生的「平滑包络 + 细竖线」画一条近似截图的声波带，随长条宽度铺满。
     包络由几个不同频率的正弦叠加，呈连绵起伏（而非逐柱乱跳）；再叠一层低通平滑噪声做细节。
     同一个 id/段每次画出的形状一致，不会因重绘跳动。 */
  const waveCache = new Map();
  function audioWaveURL(id, si, width) {
    const w = Math.max(16, Math.round(width));
    const key = id + '|' + si + '|' + w;
    if (waveCache.has(key)) return waveCache.get(key);
    const h = 22;
    let seed = 0;
    const s = String(id) + ':' + si;
    for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
    /* 由 id 派生三个相位，让不同音频的包络各异但各自稳定 */
    const p1 = ((seed & 1023) / 1023) * Math.PI * 2;
    const p2 = (((seed >>> 10) & 1023) / 1023) * Math.PI * 2;
    const p3 = (((seed >>> 20) & 1023) / 1023) * Math.PI * 2;
    let rng = (seed >>> 5) >>> 0;
    const nextRand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 4294967296;
    };
    const bars = [];
    const step = 2;
    let noise = 0.5;
    for (let x = 0; x < w; x += step) {
      const u = w > 1 ? x / (w - 1) : 0;
      /* 平滑包络：多频正弦叠加，形成连续的波峰波谷 */
      let env = 0.52
        + 0.28 * Math.sin(u * Math.PI * 2.4 + p1)
        + 0.16 * Math.sin(u * Math.PI * 6.3 + p2)
        + 0.09 * Math.sin(u * Math.PI * 12.7 + p3);
      env = Math.max(0.08, Math.min(1, env));
      /* 低通噪声：细节起伏但相邻柱不跳变 */
      noise = noise * 0.68 + nextRand() * 0.32;
      const a = env * (0.82 + noise * 0.18);
      const bh = Math.max(1, Math.round(a * h));
      bars.push('<rect x="' + x + '" y="' + ((h - bh) / 2).toFixed(1) + '" width="1" height="' + bh + '"/>');
    }
    /* v7.8.5：写成明确深色，不依赖 currentColor —— 背景图是独立文档，
       拿不到宿主元素的 CSS color，之前可能因此画成和长条同色而看不见。 */
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
      '" fill="#5b2b38" fill-opacity=".72" shape-rendering="crispEdges">' + bars.join('') + '</svg>';
    let url;
    try { url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
    catch (_) { url = ''; }
    if (waveCache.size > 400) waveCache.clear();
    waveCache.set(key, url);
    return url;
  }

  /* 左列（眼睛 + 元件名）实际多宽 —— 单一真值来源是样式里的 --ts-gutter。
     手机断点下它是 84px，JS 再写死 108 的话播放头会整体右偏一格多（v7.4.9 修的）。 */
  function readGutter() {
    const strip = $('trackStrip');
    if (!strip) return GUTTER;
    const v = parseFloat(getComputedStyle(strip).getPropertyValue('--ts-gutter'));
    return (isFinite(v) && v > 0) ? v : GUTTER;
  }

  /* ---------------- 关键帧 token ----------------
     '轨道id|帧号'。轨道 id 里不会有 '|'（都是数字或 UUID），所以从后往前找分隔符最稳。 */
  function ktok(id, i) { return String(id) + '|' + i; }
  function untok(tok) {
    const s = String(tok);
    const p = s.lastIndexOf('|');
    if (p < 0) return null;
    const i = parseInt(s.slice(p + 1), 10);
    if (!isFinite(i) || i < 0) return null;
    return { id: s.slice(0, p), i };
  }
  /* 只留「这一帧真的是关键帧」的 token —— 撤销 / 切帧之后集合里会留垃圾 */
  function liveSelKeys() {
    const map = tracksMap();
    const out = [];
    selKeys.forEach((tok) => {
      const p = untok(tok);
      if (!p) { selKeys.delete(tok); return; }
      const t = map[p.id];
      if (!t || !t.frames || !KF().isKey(t.frames[p.i])) { selKeys.delete(tok); return; }
      out.push(p);
    });
    return out;
  }
  function clearKeySel() {
    if (!selKeys.size) return;
    selKeys.clear();
    const cv = $('tsCanvas');
    if (cv) cv.querySelectorAll('.ts-key.sel').forEach(el => el.classList.remove('sel'));
  }

  /* ---------------- 长条多选 ----------------
     单选时 selClips 就是一条，selClip 指同一条（分割 / 关键帧按钮只认单条）。
     框选、批量移动、批量删除都读 selClips。 */
  function isClipSelected(id, a, b) {
    for (let i = 0; i < selClips.length; i++) {
      const c = selClips[i];
      if (String(c.id) === String(id) && c.a === a && c.b === b) return true;
    }
    return false;
  }
  function setClipSel(list, primary) {
    const seen = Object.create(null);
    const out = [];
    (list || []).forEach((c) => {
      if (!c) return;
      const k = c.id + '|' + c.a + '|' + c.b;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ id: String(c.id), a: +c.a, b: +c.b });
    });
    selClips = out;
    selClip = primary || out[0] || null;
    if (selClip) { lastPickedId = selClip.id; }
  }
  function clearClipSel() {
    selClips = [];
    selClip = null;
  }

  /* ---------------- 出场判定 ---------------- */
  /* 某一帧这个元件在不在：键帧/普通帧看自身，派生帧和段内空槽都看「段起点那一帧」的 hidden。
     和 KF.locate 的分段规则严格对齐，不自己另发明一套。 */
  function presentAt(arr, segs, i) {
    const slot = arr[i];
    const inSeg = segContaining(segs, i);
    if (slot == null || KF().isDerived(slot)) {
      if (!inSeg) return false;
      const head = arr[inSeg.a];
      return !(head && head.hidden);
    }
    return !slot.hidden;
  }

  function segContaining(segs, i) {
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (i >= s.a && i <= s.b) return s;
    }
    return null;
  }

  /* 分割标记：关键帧的 __k.cut = 1 表示「这一帧起算新的一段长条」。
     ⚠️ 必须挂在 __k 里面，不能直接写成 slot.__cut ——
        keyframes.js 的 cloneForEval 只剥 __k/__d，其余属性会原样带进派生帧，
        段内每一帧都会跟着带上这个标记，于是满屏都是假的分割点。 */
  function isCut(slot) {
    return !!(slot && !KF().isDerived(slot) && slot.__k && slot.__k.cut);
  }
  function setCut(o, on) {
    if (!o || !o.__k) return o;
    if (on) o.__k.cut = 1; else delete o.__k.cut;
    return o;
  }

  /* ---------------- 段落循环标记（v7.9.0） ----------------
     循环是「clip 段」的属性，不是某一帧的属性：挂在 track.loops = [{a,b}]。
     这样不会污染帧对象，也不会被 cloneForEval() 带进求值结果。
     ⚠️ 每一帧存画面，loops 单独记段落范围；拉长时按原段周期重复填充，
     缩短时把范围裁掉，关闭循环后回退到旧的「复制边缘帧」行为。 */
  function loopsOf(id) {
    const t = trackOf(id);
    if (!t) return [];
    if (!Array.isArray(t.loops)) t.loops = [];
    return t.loops;
  }
  function pruneLoops(id) {
    const loops = loopsOf(id);
    t_loop: for (let i = loops.length - 1; i >= 0; i--) {
      const l = loops[i];
      if (!l || !isFinite(l.a) || !isFinite(l.b) || l.b <= l.a) { loops.splice(i, 1); continue t_loop; }
      for (let j = 0; j < i; j++) {
        const m = loops[j];
        if (m && m.a === l.a && m.b === l.b) { loops.splice(i, 1); continue t_loop; }
      }
    }
    return loops;
  }
  /* v7.9.2：loops 存的是「原始循环周期」，不是当前被裁短后的可见范围。
     当前 clip [a,b] 只要落在周期内，就仍属于这段循环；拉长时继续按原周期取样。 */
  function findLoopForClip(id, a, b) {
    const loops = loopsOf(id);
    let hit = null;
    for (const l of loops) {
      if (!l || l.a > a || l.b < b) continue;
      if (!hit || (l.b - l.a) > (hit.b - hit.a)) hit = l;
    }
    return hit;
  }
  function isLoopClip(id, a, b) { return !!findLoopForClip(id, a, b); }
  function loopPeriodOf(id, a, b) { return findLoopForClip(id, a, b); }
  /* 循环周期必须自带画面快照：缩短后轨道上只留前 5 帧，但原 1-9 的内容仍要能被再次拉长取回。 */
  function makeLoopSource(id, a, b) {
    const srcs = takeRange(id, a, b);
    return srcs.map((o) => {
      if (!o) return null;
      const c = api.clone(o);
      if (c.__k) delete c.__k.cut;
      return c;
    });
  }
  function setLoopAt(id, a, b, on) {
    const loops = loopsOf(id);
    const at = findLoopForClip(id, a, b);
    if (on) {
      if (!at) loops.push({ a: a, b: b, srcs: makeLoopSource(id, a, b) });
    } else if (at) {
      loops.splice(loops.indexOf(at), 1);
    }
    pruneLoops(id);
  }
  function moveLoopRange(id, oldA, oldB, d) {
    const l = findLoopForClip(id, oldA, oldB);
    if (!l) return;
    l.a += d; l.b += d;
    pruneLoops(id);
  }
  function clearLoopsIn(id, from, to) {
    const loops = loopsOf(id);
    for (let i = loops.length - 1; i >= 0; i--) {
      const l = loops[i];
      if (l && l.b >= from && l.a <= to) loops.splice(i, 1);
    }
  }
  function modIndex(x, n) { return ((x % n) + n) % n; }

  /* 取循环周期里的第 i 帧：一律从周期自带快照取样，不从当前轨道取。
     这样缩短到 1-5 后再拉长，仍能完整拿回原 1-9 的画面。 */
  function loopFillFrame(id, loop, i) {
    if (!loop) return null;
    const len = loop.b - loop.a + 1;
    if (!(len > 0)) return null;
    const si = loop.a + modIndex(i - loop.a, len);
    if (Array.isArray(loop.srcs) && loop.srcs.length === len) {
      const src = loop.srcs[modIndex(i - loop.a, len)];
      return src ? api.clone(src) : null;
    }
    const o = cloneAt(id, si);
    if (o && o.__k) delete o.__k.cut;
    return o;
  }

  /* 连续的「在场」帧合并成一条长条；__cut 处也要断开（分割出来的左右两段） */
  function computeSpans(arr) {
    const segs = KF().segments(arr);
    const n = Math.max(totalFrames(), arr.length);
    const out = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const on = presentAt(arr, segs, i);
      const cut = i > 0 && on && isCut(arr[i]);
      if (on) {
        if (cur && !cut) cur.b = i;
        else { if (cur) out.push(cur); cur = { a: i, b: i }; }
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------------- 数据指纹 ---------------- */
  /* 轨道数、帧数、每帧的槽位身份 / 显隐 / 分割标记。
     比整块重画便宜得多，用来避免「滑条一动就重建上千个 DOM」。 */
  function signature() {
    const map = tracksMap();
    /* 缩略图开关 / 图案版本也算进指纹：不然改了动作、切了缩略图，长条上的小图不跟着换 */
    const thumbOn = (api && api.thumbMode && api.thumbMode()) ? 'T' : 't';
    const thumbRev = (api && api.thumbRev) ? api.thumbRev() : 0;
    /* v7.9.0：进入 / 退出组只改视图状态，不改轨道数据；把它算进指纹，
       need:syncUI 才能立刻把轨道从「组载体」切到「组内成员」。 */
    const SG = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
    const editing = SG ? (SG.getEditingGroupId() || '') : '';
    let s = editing + '@' + gutterPx + '@' + totalFrames() + '#' + colW + '#' + thumbOn + thumbRev + '#';
    for (const id in map) {
      const arr = (map[id] && map[id].frames) || [];
      s += id + ':' + arr.length + ':' + (map[id].name || '') + ':';
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (slot == null) s += '.';
        else if (KF().isDerived(slot)) s += 'd';
        else s += (KF().isKey(slot) ? 'k' : 'p') + (slot.hidden ? 'h' : '') + ((slot.__k && slot.__k.cut) ? 'c' : '');
      }
      /* v7.9.0：循环标记住在 track.loops，不在帧槽里；不进指纹的话点「循环」长条不会立刻重画。 */
      const loops = Array.isArray(map[id].loops) ? map[id].loops.map(l => (l ? l.a + '-' + l.b : '')).join(',') : '';
      s += 'L' + loops + ';';
    }
    return s;
  }

  /* ---------------- 刻度 ---------------- */
  function fmtClock(frame) {
    const sec = Math.floor(frame / fps());
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  /* 列宽太小就改成分:秒刻度（和剪映一样，缩到一定程度就不再数帧了） */
  function rulerStep() {
    if (colW < TIME_MIN_CW) {
      const secPx = fps() * colW;                    /* 1 秒占多少像素 */
      const stepSec = secPx >= 56 ? 1 : Math.ceil(56 / secPx);
      return { step: Math.max(1, Math.round(stepSec * fps())), time: true };
    }
    return { step: colW >= 22 ? 1 : (colW >= 12 ? 5 : 10), time: false };
  }

  /* ---------------- 渲染 ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* 高亮「最近点过的那一行」，不重画整块（拖拽/点选时用，避免抖动） */
  function markRow(id) {
    const cv = $('tsCanvas');
    if (!cv) return;
    cv.querySelectorAll('.ts-row[data-id]').forEach((r) => {
      r.classList.toggle('ts-row-sel', String(r.dataset.id) === String(id));
    });
    updateTrackGroupButtons();
    updateTrackLoopButton();
  }

  /* v7.9.0：「进入编组 / 退出编组」按钮只在选中组载体或正在组内时出现。 */
  function updateTrackGroupButtons() {
    const btn = $('btnTrackEnterGroup');
    if (!btn) return;
    const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
    const editing = G ? G.getEditingGroupId() : null;
    const id = (selClip && selClip.id) || lastPickedId;
    const selectedGid = api && api.selectedGroupId ? api.selectedGroupId() : null;
    const t = id ? tracksMap()[id] : null;
    let isCarrier = false;
    if (t && t.frames) {
      for (const d of t.frames) {
        if (d && d.type === 'group') { isCarrier = true; break; }
      }
    }
    const show = !!(editing || isCarrier || selectedGid);
    btn.style.display = show ? 'inline-flex' : 'none';
    const icon = editing ? 'exit-group' : 'enter-group';
    const ic = btn.querySelector('i[data-icon]');
    if (ic && ic.getAttribute('data-icon') !== icon) {
      ic.setAttribute('data-icon', icon);
      ic.removeAttribute('data-icon-done');
      if (root.SKFEApplyIcons) root.SKFEApplyIcons(ic);
    }
    const label = btn.querySelector('span');
    const text = editing ? T('group.exit', '退出编组') : T('track.enterGroup', '进入编组');
    btn.title = text;
    if (label) label.textContent = text;
  }

  /* v7.9.0：循环按钮跟随「选中的那一段」。进组后成员不自开循环，按钮隐藏，
     循环统一在组外对编组段设置，避免组循环和成员循环叠加。 */
  function updateTrackLoopButton() {
    const btn = $('btnTrackLoop');
    if (!btn) return;
    const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
    const editing = G ? G.getEditingGroupId() : null;
    if (editing) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    const clip = selClip || (selClips.length ? selClips[0] : null);
    const on = !!(clip && isLoopClip(clip.id, clip.a, clip.b));
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? T('track.loopOn', '已开启循环：拉长时会重复原段内容') : T('track.loopTitle', '开启后拉长该段会按原段内容循环重复');
    const label = btn.querySelector('span');
    if (label) label.textContent = T('track.loop', '循环');
  }

  function render() {
    const wrap = $('trackStrip');
    const cv = $('tsCanvas');
    if (!wrap || !cv) return;
    gutterPx = readGutter();   /* v7.4.9：先量左列宽，播放头 / 画布宽度都要用它 */
    lastSig = signature();
    updateTrackGroupButtons();
    updateTrackLoopButton();

    const map = tracksMap();
    /* v7.4.7：全空白帧的轨道不画行 —— 元件已经彻底删掉了，这一行不该留在面板里。
       （数据层由 pruneEmptyTracks 清，这里再兜一层，避免别的入口漏扫。） */
    const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
    const editingGid = G ? G.getEditingGroupId() : null;
    /* v7.9.0：编组后，组外只显示组载体轨；点进组后只显示该组成员轨。
       成员数据仍留在各自真实轨道里，只是这一帧不列出来。 */
    const groupInfoOf = (id) => {
      const t = map[id];
      if (!t || !t.frames) return null;
      for (const d of t.frames) {
        if (!d) continue;
        if (d.type === 'group') return { isCarrier: true, gid: String(d.gid || d.id) };
        if (d.groupId != null) return { isCarrier: false, gid: String(d.groupId) };
      }
      return null;
    };
    const ids = Object.keys(map).filter(id => {
      if (!(map[id] && map[id].frames && map[id].frames.some(d => d != null))) return false;
      const gi = groupInfoOf(id);
      if (editingGid) return !!gi && !gi.isCarrier && gi.gid === String(editingGid);
      return !(gi && !gi.isCarrier);
    });
    /* v7.8.1：音频轨永远置底（元件列表里根本不出现），其余保持原顺序 */
    const isAudioTrack = (id) => {
      const frames = map[id] && map[id].frames;
      return !!(frames && frames.some(d => d && d.type === 'audioClip'));
    };
    ids.sort((a, b) => (isAudioTrack(a) ? 1 : 0) - (isAudioTrack(b) ? 1 : 0));
    const total = Math.max(totalFrames(), 1);
    const width = total * colW;
    const rowsH = Math.max(ids.length, 1) * ROW_H;
    cv.style.width = (gutterPx + width) + 'px';
    cv.style.height = (RULER_H + rowsH) + 'px';
    cv.style.setProperty('--cw', colW + 'px');

    if (!ids.length) {
      cv.innerHTML = '<div class="ts-empty">' + T('track.empty', '还没有元件。先在画布上添加一个元件，它的轨道就会出现在这里。') + '</div>';
      return;
    }

    const cur = api.currentFrame();
    const rs = rulerStep();
    /* 高级设置里「帧缩略图」开着时，长条也铺一层小图（像 AM 那样） */
    const thumbOn = !!(api.thumbMode && api.thumbMode());
    let html = '';

    /* 刻度尺（v7.8.1：去掉 ＋/－ 按钮，改由轨道区滚轮 / 双指捏合缩放） */
    html += '<div class="ts-row ts-ruler-row">';
    html += '<div class="ts-gutter ts-gutter-head">' +
      '<span>' + T('track.gutterHead', '元件') + '</span>' +
      '</div>';
    html += '<div class="ts-lane ts-ruler" style="width:' + width + 'px">';
    for (let i = 0; i < total; i += rs.step) {
      html += '<span class="ts-tick" style="left:' + (i * colW) + 'px">' +
        (rs.time ? fmtClock(i) : (i + 1)) + '</span>';
    }
    html += '</div></div>';

    /* 每个元件一行 */
    ids.forEach((id) => {
      const t = map[id];
      const arr = t.frames;
      const spans = computeSpans(arr);
      /* 眼睛状态看「这条轨上有没有 hidden 数据」，不能看第一段 —— 全隐藏时一段都没有 */
      const hidden = arr.some(x => x && !KF().isDerived(x) && x.hidden);
      const name = t.name || id;

      html += '<div class="ts-row' + (String(id) === String(lastPickedId) ? ' ts-row-sel' : '') + '" data-id="' + esc(id) + '">';
      html += '<div class="ts-gutter">';
      html += '<button class="ts-eye' + (hidden ? ' off' : '') + '" type="button" data-eye="' + esc(id) + '" title="' +
        (hidden ? T('track.show', '点击显示（全帧生效）') : T('track.hide', '点击隐藏（全帧生效）')) + '">' +
        '<i data-icon="' + (hidden ? 'forbid' : 'preview-open') + '"></i></button>';
      html += '<span class="ts-name" title="' + esc(name) + '">' + esc(name) + '</span>';
      html += '</div>';
      html += '<div class="ts-lane" style="width:' + width + 'px">';
      spans.forEach((s, si) => {
        const left = s.a * colW;
        const w = Math.max(colW, (s.b - s.a + 1) * colW);
        const label = (s.a + 1) + (s.b > s.a ? '–' + (s.b + 1) : '');
        const sel = isClipSelected(id, s.a, s.b);
        const looped = isLoopClip(id, s.a, s.b);
        /* 缩略图：只取这一段的头一帧，横向平铺成胶片条 —— 每段只渲染一次，不拖慢大工程 */
        const trackData = map[id].frames[s.a];
        const isAudio = !!(trackData && trackData.type === 'audioClip');
        let cls = '', style = 'left:' + left + 'px;width:' + w + 'px';
        if (isAudio) {
          /* v7.8.1：音频轨显示波形柱体（占位），不取画面缩略图 */
          const wave = audioWaveURL(id, si, Math.round(w));
          /* v7.8.5：style 属性本身用双引号包着，这里内部必须改单引号；
             否则数据 URL 里的双引号会提前闭合 style 属性，浏览器只解析到 url( ，长条就是空白。 */
          if (wave) {
            cls = ' has-wave';
            style += ";background-image:url('" + String(wave).replace(/'/g, '%27') + "')";
          }
        } else if (thumbOn && api.renderThumb) {
          let url = null;
          try { url = api.renderThumb(id, s.a); } catch (_) { url = null; }
          if (url) { cls = ' has-thumb'; style += ';background-image:url(' + url + ')'; }
        }
        /* 选中的长条两端冒出 ‹ › 两个把手（对应两条 10px 的命中区），一眼能看出可以拖 */
        html += '<div class="ts-clip' + cls + (sel ? ' sel' : '') + (looped ? ' loop' : '') + '" data-id="' + esc(id) + '" data-si="' + si + '" data-a="' + s.a + '" data-b="' + s.b + '"' +
          ' style="' + style + '">' +
          '<i class="ts-h ts-h-l">‹</i><span class="ts-lab">' + (looped ? '⟳ ' : '') + label + '</span><i class="ts-h ts-h-r">›</i></div>';
      });
      /* 关键帧菱形：压在长条正中间，可以单拖（改这一帧的时间）／Ctrl 点选多颗 */
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (!KF().isKey(slot)) continue;
        html += '<i class="ts-key' + (slot.hidden ? ' off' : '') + (isCut(slot) ? ' cut' : '') +
          (selKeys.has(ktok(id, i)) ? ' sel' : '') +
          '" data-id="' + esc(id) + '" data-i="' + i + '" style="left:' + (i * colW + colW / 2) + 'px"></i>';
      }
      html += '</div></div>';
    });

    /* 播放头放在所选帧的正中间 */
    html += '<div class="ts-playhead" style="left:' + (gutterPx + cur * colW + colW / 2) + 'px;height:' + (RULER_H + rowsH) + 'px"></div>';

    cv.innerHTML = html;
    if (root.SKFEApplyIcons) root.SKFEApplyIcons(cv);
    scrollPlayheadIntoView();
  }

  /* v7.9.2：播放头默认停在可视轨道区正中；空白区左右拖就是换帧读取画面。 */
  function scrollPlayheadIntoView() {
    const sc = $('tsScroll');
    if (!sc || !enabled) return;
    const viewW = Math.max(1, sc.clientWidth - gutterPx);
    const x = api.currentFrame() * colW + colW / 2;
    sc.scrollLeft = Math.max(0, x - viewW / 2);
  }

  function syncPlayhead() {
    const ph = document.querySelector('#tsCanvas .ts-playhead');
    if (!ph) return;
    ph.style.left = (gutterPx + api.currentFrame() * colW + colW / 2) + 'px';
  }

  /* ---------------- 写回工具 ---------------- */
  function ensureLen(arr, n) { while (arr.length < n) arr.push(null); }

  function trackOf(id) {
    const t = tracksMap()[id];
    if (!t) return null;
    if (!t.frames) t.frames = [];
    return t;
  }

  function cloneAt(id, i) {
    const o = api.getTrackFrame(id, i);
    return o ? api.clone(o) : null;
  }

  /* 普通帧：不挂关键帧标记（拉长时用 —— 要求「不要在末尾加关键帧」） */
  function plainFrom(o) {
    if (!o) return null;
    const c = api.clone(o);
    KF().clearKey(c);   /* 顺带把 __k（含分割标记）一起摘掉 */
    return c;
  }

  /* markKey 会把 __k 整个换掉（曲线和分割标记都住在里面），所以先记住分割标记再按回去 */
  function markKeyKeep(o, origin, curve) {
    if (!o) return o;
    const cut = isCut(o);
    KF().markKey(o, origin || 'sub', curve);
    if (cut) setCut(o, true);
    return o;
  }

  /* 关键帧：带上原来那段曲线的配置。keepCut=false 用于「腾空」时新造的隐藏段头 ——
     那是全新的一帧「此处不出场」，不该继承分割标记，否则会平白多切一刀。 */
  function keyFrom(o, hidden, keepCut) {
    if (!o) return null;
    const c = api.clone(o);
    if (keepCut === false) KF().markKey(c, 'sub', KF().curveOf(o));
    else markKeyKeep(c, 'sub', KF().curveOf(o));
    c.hidden = !!hidden;
    return c;
  }

  /* 把 [a..b] 求值后抓出来（原本是关键帧的那些保持关键帧身份和曲线） */
  function takeRange(id, a, b) {
    const t = trackOf(id);
    const arr = t ? t.frames : [];
    const out = [];
    for (let i = a; i <= b; i++) {
      const o = cloneAt(id, i);
      if (!o) { out.push(null); continue; }
      const raw = arr[i];
      if (KF().isKey(raw)) markKeyKeep(o, 'sub', KF().curveOf(raw));
      else KF().clearKey(o);
      o.hidden = !!raw.hidden;
      setCut(o, isCut(raw));
      out.push(o);
    }
    return out;
  }

  /* 把一串帧写到 [na..]：首帧一定是可见关键帧（新段的锚点），其余沿用原来的身份 */
  function putRange(arr, na, srcs) {
    ensureLen(arr, na + srcs.length);
    for (let k = 0; k < srcs.length; k++) {
      const o = srcs[k];
      if (!o) { arr[na + k] = null; continue; }
      const c = api.clone(o);
      if (k === 0) { markKeyKeep(c, 'sub'); c.hidden = false; }
      else if (!KF().isKey(o)) KF().clearKey(c);
      arr[na + k] = c;
    }
  }

  /* 让 [from..to] 不再出场。
     段内（前面已经有关键帧、且后面也还有关键帧）必须落一个 hidden 关键帧当「不见段的头」，
     否则前一个关键帧的段会一路盖过来，把这里又填成可见。
     v7.4.4：后面**没有**关键帧时不再插这颗 —— 那时候清空就够，
     否则缩短长条会在空白处留下一个谁也点不掉的隐藏菱形（就是「轨道缩短后空白处还有帧」那个 bug）。 */
  /* 干净清空一段：不留「隐藏头」，裁短专用 */
  function clearFrames(arr, from, to) {
    for (let i = Math.max(0, from); i <= to && i < arr.length; i++) arr[i] = null;
  }

  function vacate(id, arr, from, to) {
    if (to < from || from < 0) return;
    ensureLen(arr, to + 1);
    let keyBefore = false;
    for (let i = 0; i < from; i++) { if (KF().isKey(arr[i])) { keyBefore = true; break; } }
    let keyAfter = false;
    for (let i = to + 1; i < arr.length; i++) { if (KF().isKey(arr[i])) { keyAfter = true; break; } }
    if (keyBefore && keyAfter) {
      const head = keyFrom(cloneAt(id, from), true, false);
      arr[from] = head || null;
    } else {
      arr[from] = null;
    }
    for (let i = from + 1; i <= to; i++) arr[i] = null;
  }

  /* 每一步操作的最后一步：段内空槽归位 + 记一步历史。
     ⚠️ 历史里存的是**操作之后**的状态 —— app.js 的 undo() 是「弹掉栈顶、恢复到新栈顶」，
        所以每条记录都必须等于它那一刻的当前状态，否则一次撤销会退两步。
     v7.4.3：外层若已经开了事务（一次拖拽 / 一次粘贴 / 一次批量删），这一步只改数据不记历史，
        由 txEnd 统一压一条 —— 一个手势 = 一步撤销。 */
  function commit(ids, label) {
    (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
      const t = trackOf(id);
      if (t) KF().reconcileTrack(t);
    });
    /* ⚠️ 必须重取当前帧的渲染对象（api.refreshObjects）：
       getTrackFrame 对关键帧 / 普通帧返回的就是槽位对象本身，而 AppState.objects
       里留着的还是改动之前那一份。少了这一步，下一次 goToFrame 的 syncFrameRef
       会因为「不是同一个对象」把关键帧槽位覆写成普通帧 —— 关键帧、分割标记全丢，
       表现就是「点一下别处，段落就散架」。 */
    if (api.refreshObjects) api.refreshObjects();
    /* v7.4.6：裁短 / 删掉尾部之后把时间轴尾巴收干净，别留一串谁都不出场的空白帧 */
    if (api.trimTail) { try { api.trimTail(); } catch (_) {} }
    /* v7.4.7：整条轨被清空（元件已经不出场）→ 这一行直接消失，别留空壳 */
    if (api.pruneTracks) { try { api.pruneTracks(); } catch (_) {} }
    api.afterChange();
    if (api.isTxOpen && api.isTxOpen()) return;
    api.pushPre(api.snapshot(), label);
  }

  /* 把一整段操作包进一个事务。没有 isTxOpen 的旧内核也不会炸：begin/end 缺席时退化成原来的 commit 记法。
     ⚠️ 必须在**改数据之前** begin，否则 begin 取到的那份「操作前快照」已经包含改动，
        txEnd 会认为「啥都没变」而不记历史 —— 表现就是「改了、撤销却没反应」。
        单步操作（分割 / 删除 / 开关键帧）不需要事务：commit 里已经按操作后状态记了一步。 */
  function withTx(label, fn) {
    const can = !!(api && api.txBegin && api.txEnd);
    if (can) api.txBegin(label);
    try {
      return fn();
    } finally {
      if (can) api.txEnd();
    }
  }


  /* ---------------- 伸缩 / 平移 ---------------- */
  /* 拖拽的横向边界：平移和两端伸缩共用一套 —— 左端最多贴到前一条长条的右边，
     右端最多贴到后一条的左边，否则往外一拽就把隔壁那段吃掉（看着像段落散架）。 */
  function moveBounds(id, a, b) {
    const t = tracksMap()[id];
    const spans = t ? computeSpans(t.frames) : [];
    let lo = -a, hi = MAX_FRAMES - b;
    spans.forEach((s) => {
      if (s.a === a && s.b === b) return;
      if (s.b < a) lo = Math.max(lo, s.b + 1 - a);
      else if (s.a > b) hi = Math.min(hi, s.a - 1 - b);
    });
    return { lo: lo, hi: hi };
  }

  /* 右端拉到 nb。
     loopPeriod 为 null 时保持旧语义：拉长复制边缘帧为普通帧；
     loopPeriod={a,b} 时按原段周期重复填充（关键帧 / 曲线也按周期复刻，cut 不复刻）。 */
  function stretchRight(id, a, b, nb, loopPeriod) {
    const t = trackOf(id);
    if (!t) return;
    const arr = t.frames;
    ensureLen(arr, Math.max(totalFrames(), arr.length));
    if (nb > b) {
      ensureLen(arr, nb + 1);
      if (loopPeriod) {
        for (let i = b + 1; i <= nb; i++) arr[i] = loopFillFrame(id, loopPeriod, i);
      } else {
        const base = plainFrom(cloneAt(id, b));
        if (!base) return;
        for (let i = b + 1; i <= nb; i++) arr[i] = api.clone(base);
      }
    } else if (nb < b) {
      /* 裁短（v7.4.5）：拖到 14 就把 15 之后全裁掉，落在里面的关键帧（比如 17）一起取消；
         剩下的尾巴（最后一个保留关键帧 +1 … 14）定格成那颗关键帧的姿势 ——
         不然 17 一没，6 后面就成了「段外」，补间撤掉后这几帧会直接消失。 */
      const anchor = lastKeyAtOrBefore(id, nb);
      const hold = anchor >= 0 ? plainFrom(cloneAt(id, anchor)) : null;
      /* 用干净清空：vacate 会在两侧都有关键帧时落一颗「隐藏头」，
         裁短的场合那颗头正好落在新区间外面（15 帧），又会变成看不见的残留。 */
      clearFrames(arr, nb + 1, b);
      /* v7.9.2：循环段缩短保留原段前几帧的真实画面（1-9 缩到 5 就显示 1-5），
         并从周期快照重新烘焙可见帧；原 1-9 的内容仍留在 loop.srcs 里。 */
      if (loopPeriod) {
        for (let i = a; i <= nb; i++) arr[i] = loopFillFrame(id, loopPeriod, i);
      } else if (hold) {
        for (let i = anchor + 1; i <= nb; i++) arr[i] = api.clone(hold);
      }
    }
  }

  /* 轨道上 <= idx 的最后一颗关键帧；没有就 -1 */
  function lastKeyAtOrBefore(id, idx) {
    const t = trackOf(id);
    const arr = t ? t.frames : [];
    for (let i = Math.min(idx, arr.length - 1); i >= 0; i--) {
      if (arr[i] && KF().isKey(arr[i])) return i;
    }
    return -1;
  }

  /* 轨道上 >= idx 的第一颗关键帧；没有就 -1 */
  function firstKeyAtOrAfter(id, idx) {
    const t = trackOf(id);
    const arr = t ? t.frames : [];
    for (let i = Math.max(0, idx); i < arr.length; i++) {
      if (arr[i] && KF().isKey(arr[i])) return i;
    }
    return -1;
  }

  /* 左端拉到 na。loopPeriod 为 null 时沿用旧语义（头是关键帧就一起左移，其余复制边缘帧）；
     loopPeriod={a,b} 时按原段周期反向取样：新帧 na…a-1 对应原周期尾部，边界自然接上。 */
  function stretchLeft(id, a, b, na, loopPeriod) {
    const t = trackOf(id);
    if (!t) return;
    const arr = t.frames;
    ensureLen(arr, Math.max(totalFrames(), arr.length));
    if (na < a) {
      if (loopPeriod) {
        for (let i = na; i < a; i++) arr[i] = loopFillFrame(id, loopPeriod, i);
      } else {
        const base = plainFrom(cloneAt(id, a));
        if (!base) return;
        const head = arr[a];
        const headIsKey = !!(head && !KF().isDerived(head) && KF().isKey(head));
        if (headIsKey) {
          /* 关键帧当头的段：头跟着挪到新的左端，原位置退回普通帧（不然会多出一个菱形） */
          arr[na] = api.clone(head);
          arr[a] = api.clone(base);
          for (let i = na + 1; i < a; i++) arr[i] = api.clone(base);
        } else {
          for (let i = na; i < a; i++) {
            const s = arr[i];
            /* 让位给新长出来的帧：这里原有的隐藏关键帧（腾空留下的）先摘掉 */
            if (s && !KF().isDerived(s) && KF().isKey(s) && s.hidden) KF().clearKey(s);
            arr[i] = api.clone(base);
          }
        }
      }
    } else if (na > a) {
      /* 裁短左端（v7.4.5）：拖到 9 就把 9 之前全裁掉，落在里面的关键帧（比如 1、6）一起取消；
         剩下的头（9 … 后面第一颗保留关键帧 -1）定格成那颗关键帧的姿势，
         和右端裁短是同一套语义（只是取的是右边的锚点）。 */
      const anchor = firstKeyAtOrAfter(id, na);
      const hold = anchor >= 0 ? plainFrom(cloneAt(id, anchor)) : null;
      clearFrames(arr, a, na - 1);
      /* v7.9.2：循环段左端缩短同样从周期快照烘焙可见帧，原周期不裁 */
      if (loopPeriod) {
        for (let i = na; i <= b; i++) arr[i] = loopFillFrame(id, loopPeriod, i);
      } else if (hold) {
        for (let i = na; i < anchor; i++) arr[i] = api.clone(hold);
      }
    }
  }

  /* 挂在某个元件上的配饰（画笔 / 贴件…）的轨道 id —— 主体变了它们要跟着变 */
  function boundIdsOf(id) {
    if (!api || !api.boundIds) return [];
    try { return api.boundIds(id) || []; } catch (_) { return []; }
  }

  /* v7.9.0：判断一条轨是不是组载体（按任意帧里的 type:'group' 认，不依赖当前播放头） */
  function isGroupCarrierTrack(id) {
    const t = tracksMap()[id];
    if (!t || !t.frames) return false;
    return t.frames.some(d => !!(d && d.type === 'group'));
  }

  /* v7.9.0：组载体长条拖动时，成员轨必须跟着同一手势一起动 */
  function groupMemberIdsOf(id) {
    if (!api || !api.groupMemberIds) return [];
    try { return (api.groupMemberIds(id) || []).map(String).filter(x => x && x !== String(id)); }
    catch (_) { return []; }
  }

  function applyDrag(st, d) {
    const t = trackOf(st.id);
    if (!t) return;
    const arr = t.frames;
    ensureLen(arr, Math.max(totalFrames(), arr.length));
    const ids = [st.id];
    const memberIds = groupMemberIdsOf(st.id);

    if (st.mode === 'm') {
      /* 平移：抓出整段 → 原位腾空 → 写到新位置 */
      const srcs = takeRange(st.id, st.a, st.b);
      const na = st.a + d, nb = st.b + d;
      vacate(st.id, arr, st.a, st.b);
      putRange(arr, na, srcs);
      if (nb < st.b) vacate(st.id, arr, nb + 1, st.b);   /* 往左挪时右端要腾干净 */
      moveLoopRange(st.id, st.a, st.b, d);
      /* 组内成员同段一起平移，保持一个手势一步撤销 */
      memberIds.forEach((mid) => {
        if (!trackOf(mid)) return;
        const mArr = trackOf(mid).frames;
        const mSrcs = takeRange(mid, st.a, st.b);
        vacate(mid, mArr, st.a, st.b);
        putRange(mArr, na, mSrcs);
        if (nb < st.b) vacate(mid, mArr, nb + 1, st.b);
        moveLoopRange(mid, st.a, st.b, d);
        if (ids.indexOf(mid) < 0) ids.push(mid);
      });
    } else if (st.mode === 'r') {
      const b = st.b, nb = b + d;
      /* v7.9.2：用「原始循环周期」取样。缩短只裁可见范围，不改 period；
         再拉长时从周期开头继续重复，例如 1-9 缩到 5 再拉到 17 = 1-9 + 1-8。 */
      const parentPeriod = loopPeriodOf(st.id, st.a, st.b);
      stretchRight(st.id, st.a, b, nb, parentPeriod);
      /* 配饰跟着一起伸缩：只有「原来和主体同一端」的那些才跟，免得把别人拉长 */
      boundIdsOf(st.id).forEach((bid) => {
        const sp = computeSpans((tracksMap()[bid] || {}).frames || []).filter(x => x.b === b && x.a <= st.a);
        if (!sp.length) return;
        const own = sp[sp.length - 1];
        const period = loopPeriodOf(bid, own.a, own.b) || parentPeriod;
        stretchRight(bid, own.a, b, nb, period);
        if (ids.indexOf(bid) < 0) ids.push(bid);
      });
      /* 组成员无论原本占组内的哪一段，右端都跟到组的新右端 */
      memberIds.forEach((mid) => {
        const spans = computeSpans((tracksMap()[mid] || {}).frames || [])
          .filter(x => x.a < st.b && x.b >= st.a);
        if (!spans.length) return;
        const sp = spans[spans.length - 1];
        const period = loopPeriodOf(mid, st.a, st.b) || loopPeriodOf(mid, sp.a, sp.b);
        stretchRight(mid, st.a, sp.b, nb, period);
        if (ids.indexOf(mid) < 0) ids.push(mid);
      });
    } else {
      const a = st.a, na = a + d;
      const parentPeriod = loopPeriodOf(st.id, st.a, st.b);
      stretchLeft(st.id, a, st.b, na, parentPeriod);
      boundIdsOf(st.id).forEach((bid) => {
        const sp = computeSpans((tracksMap()[bid] || {}).frames || []).filter(x => x.a === a && x.b >= st.b);
        if (!sp.length) return;
        const own = sp[0];
        const period = loopPeriodOf(bid, own.a, own.b) || parentPeriod;
        stretchLeft(bid, own.a, own.b, na, period);
        if (ids.indexOf(bid) < 0) ids.push(bid);
      });
      /* 组成员无论原本占组内的哪一段，左端都跟到组的新左端 */
      memberIds.forEach((mid) => {
        const spans = computeSpans((tracksMap()[mid] || {}).frames || [])
          .filter(x => x.a < st.b && x.b >= st.a);
        if (!spans.length) return;
        const sp = spans[0];
        const period = loopPeriodOf(mid, st.a, st.b) || loopPeriodOf(mid, sp.a, sp.b);
        stretchLeft(mid, st.a, sp.b, na, period);
        if (ids.indexOf(mid) < 0) ids.push(mid);
      });
    }
    commit(ids, T('track.dragLabel', '调整轨道'));
  }

  /* ---------------- 多条长条整体平移（框选后用） ----------------
     每条各自按自己的邻居夹紧，再取交集 —— 这样一起拖的时候不会有一条撞进隔壁。 */
  function multiMoveBounds(items) {
    let lo = -MAX_FRAMES, hi = MAX_FRAMES;
    items.forEach((c) => {
      const bd = moveBounds(c.id, c.a, c.b);
      lo = Math.max(lo, bd.lo);
      hi = Math.min(hi, bd.hi);
    });
    if (!isFinite(lo)) lo = -MAX_FRAMES;
    if (!isFinite(hi)) hi = MAX_FRAMES;
    if (lo > hi) return { lo: 0, hi: 0 };     /* 互相顶死：不许动，免得写坏数据 */
    return { lo: lo, hi: hi };
  }

  function applyClipsMove(items, d) {
    if (!d) return;
    const ids = [];
    /* 从右往左处理：右边先腾空，左边再落位，同一轨道上两条也不会互相吃格子 */
    items.slice().sort((x, y) => (x.id === y.id ? y.a - x.a : (x.id < y.id ? -1 : 1))).forEach((c) => {
      const t = trackOf(c.id);
      if (!t) return;
      const arr = t.frames;
      ensureLen(arr, Math.max(totalFrames(), arr.length));
      const srcs = takeRange(c.id, c.a, c.b);
      const na = c.a + d, nb = c.b + d;
      vacate(c.id, arr, c.a, c.b);
      putRange(arr, na, srcs);
      if (nb < c.b) vacate(c.id, arr, nb + 1, c.b);
      moveLoopRange(c.id, c.a, c.b, d);
      if (ids.indexOf(c.id) < 0) ids.push(c.id);
    });
    commit(ids, T('track.moveClipLabel', '整体移动长条'));
    /* 落位之后按新的位置重选，接着还能再拖 */
    setClipSel(items.map(c => ({ id: c.id, a: c.a + d, b: c.b + d })));
  }

  /* ---------------- 多条长条整组拉长 / 缩短（v7.4.9） ----------------
     框选一堆长条之后抓任意一端，整组一起变长变短（d 帧），不用一条一条拉。
     每条各走一遍 applyDrag：配饰的跟随、裁短时「剩下的尾巴定格成保留锚点」、
     裁掉的帧里关键帧一并取消 —— 这些语义全都和单条完全一致，
     另写一套数据逻辑只会和单条的行为分叉。 */
  function applyClipsResize(items, d, mode) {
    if (!d || !items.length) return;
    items.forEach((c) => {
      applyDrag({ id: c.id, a: c.a, b: c.b, mode: mode }, d);
    });
    /* 长度变了：按新范围重选，接着还能继续拉 */
    setClipSel(items.map(c => (mode === 'r'
      ? { id: c.id, a: c.a, b: c.b + d }
      : { id: c.id, a: c.a + d, b: c.b })));
  }

  /* 整组伸缩的夹紧区间：各条各自算，再取交集（和整组平移同一个思路） */
  function multiResizeBounds(items, mode) {
    let lo = -MAX_FRAMES, hi = MAX_FRAMES;
    items.forEach((c) => {
      const bd = moveBounds(c.id, c.a, c.b);
      if (mode === 'r') {
        lo = Math.max(lo, c.a - c.b);     /* 至少剩 1 帧 */
        hi = Math.min(hi, bd.hi);         /* 不能吃掉后面那一段 */
      } else {
        lo = Math.max(lo, bd.lo);         /* 不能吃掉前面那一段 */
        hi = Math.min(hi, c.b - c.a);
      }
    });
    if (!isFinite(lo)) lo = -MAX_FRAMES;
    if (!isFinite(hi)) hi = MAX_FRAMES;
    if (lo > hi) return { lo: 0, hi: 0 };
    return { lo: lo, hi: hi };
  }

  /* ---------------- 关键帧平移 / 复制 / 粘贴 ----------------
     v7.4.3 语义调整：拖关键帧 = 改它落在第几帧（用户最初要的就是这个），
     想保留原来那颗就按住 Alt（= 复制到落点）。单颗和整组用同一套键位。 */
  function applyKeyDrag(st, to) {
    const t = trackOf(st.id);
    if (!t) return;
    const arr = t.frames;
    const src = cloneAt(st.id, st.i);
    if (!src) return;
    const raw = arr[st.i];
    KF().markKey(src, 'sub', raw ? KF().curveOf(raw) : null);
    src.hidden = !!(raw && raw.hidden);
    setCut(src, isCut(raw));
    ensureLen(arr, to + 1);
    arr[to] = src;
    if (!st.alt) arr[st.i] = null;     /* 默认挪位；Alt = 复制（原帧留着） */
    commit(st.id, st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'));
  }

  /* 整组平移的横向夹紧：任一颗都不能跑到第 0 帧之前 / 600 帧之后 */
  function clampKeyDelta(items, raw) {
    let lo = -MAX_FRAMES, hi = MAX_FRAMES;
    items.forEach((it) => {
      lo = Math.max(lo, -it.i);
      hi = Math.min(hi, MAX_FRAMES - 1 - it.i);
    });
    return Math.max(lo, Math.min(hi, raw));
  }

  /* 整组平移：先抓出所有源（带曲线 / 分割 / 隐藏态），把原位置统一腾空，再统一写到落点。
     先腾后写是关键 —— 否则往右挪时前一颗会把自己后一颗的源覆盖掉。 */
  function applyKeysDrag(st) {
    const d = st.d;
    if (!d) return;
    const plan = [];
    const ids = [];
    st.items.forEach((it) => {
      const t = trackOf(it.id);
      if (!t || !t.frames) return;
      const raw = t.frames[it.i];
      if (!KF().isKey(raw)) return;
      const o = cloneAt(it.id, it.i);
      if (!o) return;
      markKeyKeep(o, 'sub', KF().curveOf(raw));
      o.hidden = !!raw.hidden;
      setCut(o, isCut(raw));
      plan.push({ id: it.id, from: it.i, to: it.i + d, obj: o });
      if (ids.indexOf(it.id) < 0) ids.push(it.id);
    });
    if (!plan.length) return;
    plan.forEach((p) => {                       /* 1. 先腾空 */
      const t = trackOf(p.id);
      if (t) { ensureLen(t.frames, p.from + 1); t.frames[p.from] = null; }
    });
    plan.forEach((p) => {                       /* 2. 再落到新位置 */
      const t = trackOf(p.id);
      if (!t) return;
      ensureLen(t.frames, p.to + 1);
      t.frames[p.to] = api.clone(p.obj);
    });
    commit(ids, st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'));
  }

  /* 复制选中的关键帧：以最小帧号归一成 off，粘贴时落在播放头 */
  function copyKeys() {
    const items = liveSelKeys();
    if (!items.length) { api.toast(T('track.copyNone', '先点选关键帧（Ctrl / ⌘ 点可以多选），再复制')); return false; }
    let base = Infinity;
    items.forEach((it) => { base = Math.min(base, it.i); });
    const list = [];
    items.forEach((it) => {
      const t = tracksMap()[it.id];
      const raw = t && t.frames ? t.frames[it.i] : null;
      if (!raw) return;
      const o = cloneAt(it.id, it.i);
      if (!o) return;
      markKeyKeep(o, 'sub', KF().curveOf(raw));
      o.hidden = !!raw.hidden;
      setCut(o, isCut(raw));
      list.push({ id: it.id, off: it.i - base, obj: o });
    });
    if (!list.length) return false;
    keyClip = { items: list };
    api.toast(T('track.copyDone', '已复制 %n 颗关键帧，到目标帧按粘贴').replace('%n', list.length));
    return true;
  }

  function pasteKeys() {
    if (!keyClip || !keyClip.items.length) { api.toast(T('track.pasteEmpty', '剪切板里还没有关键帧')); return false; }
    const at = api.currentFrame();
    const ids = [];
    const picked = [];
    withTx(T('track.pasteLabel', '粘贴关键帧'), () => {
      keyClip.items.forEach((it) => {
        const to = at + it.off;
        if (to < 0 || to >= MAX_FRAMES) return;
        const t = trackOf(it.id);
        if (!t) return;
        ensureLen(t.frames, to + 1);
        t.frames[to] = api.clone(it.obj);
        picked.push(ktok(it.id, to));
        if (ids.indexOf(it.id) < 0) ids.push(it.id);
      });
      if (ids.length) commit(ids, T('track.pasteLabel', '粘贴关键帧'));
    });
    if (!ids.length) { api.toast(T('track.pasteEmpty', '剪切板里还没有关键帧')); return false; }
    selKeys = new Set(picked);        /* 粘完直接选中，方便接着整组拖 */
    lastPickedId = ids[0];
    render();
    api.toast(T('track.pasteDone', '已粘贴 %n 颗关键帧').replace('%n', picked.length));
    return true;
  }

  /* 删掉一颗关键帧：先把这一段前后「靠补间撑着的派生帧」定格成普通帧，再摘掉关键帧身份。
     不这么做的话，段一消失，那些派生帧会被 reconcileTrack 清成空槽 ——
     画面会在段中间突然断掉几帧（用户看到的就是「删个关键帧怎么没了半段」）。 */
  function dropKey(id, i) {
    const t = trackOf(id);
    if (!t || !t.frames) return false;
    const arr = t.frames;
    const cur = arr[i];
    if (!cur || !KF().isKey(cur)) return false;
    const hidden = !!cur.hidden;
    let prevKey = -1, nextKey = -1;
    for (let k = i - 1; k >= 0; k--) { if (KF().isKey(arr[k])) { prevKey = k; break; } }
    for (let k = i + 1; k < arr.length; k++) { if (KF().isKey(arr[k])) { nextKey = k; break; } }
    const bake = (from, to) => {
      for (let k = from; k <= to; k++) {
        const slot = arr[k];
        if (slot && !KF().isDerived(slot)) continue;   /* 本身就有画面：不动它 */
        const c = plainFrom(cloneAt(id, k));
        if (c) { c.hidden = false; arr[k] = c; }
      }
    };
    /* 顺序要紧：先按「关键帧还在」时的求值结果烘焙，再来动这一帧本身 */
    if (prevKey >= 0) bake(prevKey + 1, i - 1);
    if (nextKey >= 0) bake(i + 1, nextKey - 1);
    const keep = plainFrom(cloneAt(id, i));
    if (keep) { keep.hidden = hidden; arr[i] = keep; } else arr[i] = null;
    return true;
  }

  /* 删掉选中的关键帧：画面留着，只摘掉「关键帧」这个身份（和「取消关键帧」同一套语义） */
  function deleteSelKeys() {
    const items = liveSelKeys();
    if (!items.length) return false;
    const ids = [];
    withTx(T('track.keyDelLabel', '删除关键帧'), () => {
      /* 同一轨道从右往左删，避免「先删右边把左边的段撑长」影响后面的烘焙 */
      items.slice().sort((a, b) => (a.id === b.id ? b.i - a.i : (a.id < b.id ? -1 : 1)))
        .forEach((it) => {
          const t = trackOf(it.id);
          if (!t || !t.frames) return;
          dropKey(it.id, it.i);
          if (ids.indexOf(it.id) < 0) ids.push(it.id);
        });
      if (ids.length) commit(ids, T('track.keyDelLabel', '删除关键帧'));
    });
    selKeys.clear();
    render();
    api.toast(T('track.keyDelDone', '已删除 %n 颗关键帧').replace('%n', items.length));
    return true;
  }

  /* 双击某颗关键帧 = 选中这一整条轨上的全部关键帧（整轨平移/复制用） */
  function selectTrackKeys(id) {
    const t = tracksMap()[id];
    if (!t || !t.frames) return;
    selKeys.clear();
    for (let i = 0; i < t.frames.length; i++) {
      if (KF().isKey(t.frames[i])) selKeys.add(ktok(id, i));
    }
    render();
  }

  /* ---------------- 分割 / 删除 / 关键帧 ---------------- */
  function needClip() {
    api.toast(T('track.needPick', '先在轨道上点一条长条，选中要操作的段'));
    return null;
  }

  /* v7.9.0：给选中的 clip / 编组段开关循环填充。
     组整体优先：组外选中编组段时开关组循环，内部成员按同一组周期重复；
     进组后不单独给成员开循环，避免组循环与成员循环叠加。 */
  function toggleClipLoop() {
    const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
    if (G && G.getEditingGroupId()) {
      api.toast(T('track.loopInGroup', '编组循环请在组外选中编组段设置'));
      return;
    }
    const clip = selClip || (selClips.length ? selClips[0] : null);
    if (!clip) return needClip();
    const on = !isLoopClip(clip.id, clip.a, clip.b);
    const label = on ? T('track.loopEnable', '开启段落循环') : T('track.loopDisable', '关闭段落循环');
    const ids = [clip.id];
    withTx(label, () => {
      setLoopAt(clip.id, clip.a, clip.b, on);
      /* 组载体：成员轨按组周期一起标记；这样拖动组两端时它们会按同一周期重复 */
      groupMemberIdsOf(clip.id).forEach((mid) => {
        setLoopAt(mid, clip.a, clip.b, on);
        if (ids.indexOf(mid) < 0) ids.push(mid);
      });
      /* 普通元件的绑定配饰：按各自与主体重叠的段标记，主体循环时一起重复 */
      boundIdsOf(clip.id).forEach((bid) => {
        const spans = computeSpans((tracksMap()[bid] || {}).frames || [])
          .filter(x => x.b >= clip.a && x.a <= clip.b);
        spans.forEach((sp) => setLoopAt(bid, sp.a, sp.b, on));
        if (spans.length && ids.indexOf(bid) < 0) ids.push(bid);
      });
      commit(ids, label);
    });
    render();
    api.toast(on ? T('track.loopOn', '已开启循环：拉长时会重复原段内容') : T('track.loopOff', '已关闭循环：拉长复制边缘帧'));
  }

  /* 分割：在播放头把当前段切成左右两段（剪映式），两边都还在，只是各自成段 */
  function split() {
    const clip = selClip;
    if (!clip) return needClip();
    const t = trackOf(clip.id);
    if (!t) return needClip();
    const arr = t.frames;
    const i = api.currentFrame();
    if (i <= clip.a || i > clip.b) {
      api.toast(T('track.splitOut', '播放头要落在选中长条的中间（不含左端）才能分割'));
      return;
    }
    const src = keyFrom(cloneAt(clip.id, i), false);
    if (!src) return;
    setCut(src, true);
    ensureLen(arr, Math.max(clip.b, i) + 1);
    arr[i] = src;
    /* v7.9.2：分割不裁循环周期；两半只要仍落在原周期内就都按原周期继续循环 */
    commit(clip.id, T('track.splitLabel', '分割'));
    setClipSel([{ id: clip.id, a: i, b: clip.b }]);   /* 分割后选中右半段 */
    render();
    api.toast(T('track.splitDone', '已从这一帧分成左右两段，可以各自拖了'));
  }

  /* 删除选中的长条（可以是框选出来的好几条；范围变空白，前后两段自动接上） */
  function deleteClip() {
    const list = selClips.slice();
    if (!list.length && selClip) list.push(selClip);
    if (!list.length) return needClip();
    /* v7.9.0：删到编组载体 = 删除整组（成员轨一起删），不能只清载体留下成员残留 */
    const groupIds = [];
    list.forEach((c) => {
      if (isGroupCarrierTrack(c.id) && groupIds.indexOf(String(c.id)) < 0) groupIds.push(String(c.id));
    });
    if (groupIds.length) {
      let done = 0;
      groupIds.forEach((gid) => { if (api && api.deleteGroup && api.deleteGroup(gid)) done++; });
      clearClipSel();
      lastPickedId = null;
      render();
      api.toast(T('track.groupDelDone', '已删除编组及其内部元件').replace('%n', done));
      return;
    }
    const ids = [];
    const n = list.length;
    withTx(T('track.delLabel', '删除这一段的帧'), () => {
      /* 从右往左：右边先腾空，左边的 vacate 才不会把右边刚写进去的撑长 */
      list.slice().sort((x, y) => (x.id === y.id ? y.a - x.a : (x.id < y.id ? -1 : 1))).forEach((clip) => {
        const t = trackOf(clip.id);
        if (!t) return;
        ensureLen(t.frames, Math.max(totalFrames(), t.frames.length));
        vacate(clip.id, t.frames, clip.a, clip.b);
        clearLoopsIn(clip.id, clip.a, clip.b);
        if (ids.indexOf(clip.id) < 0) ids.push(clip.id);
      });
      if (ids.length) commit(ids, T('track.delLabel', '删除这一段的帧'));
    });
    clearClipSel();
    lastPickedId = null;
    render();
    api.toast(n > 1
      ? T('track.delDoneMulti', '已删除 %n 段').replace('%n', n)
      : T('track.delDone', '这一段已经删掉'));
  }

  /* 关键帧：给「选中的那条轨」在播放头处开/关关键帧（轨道模式下不认子轨选择器） */
  function toggleKey() {
    const id = (selClip && selClip.id) || lastPickedId;
    if (!id) { api.toast(T('track.needPick', '先在轨道上点一条长条，选中要操作的段')); return; }
    const t = trackOf(id);
    if (!t) return;
    const arr = t.frames;
    const i = api.currentFrame();
    ensureLen(arr, i + 1);
    if (KF().isKey(arr[i])) {
      /* 取消关键帧：画面留着，周围靠补间撑着的帧先定格，免得段一没就断档 */
      dropKey(id, i);
    } else {
      /* v7.4.3：这一帧本来是空白（段外没画面）时，借最近的姿势补一张 —— 否则「打了关键帧却没有画面」。
         先取本帧的求值结果，取不到再找最近的一帧（nearestPose 已剥掉帧身份）。 */
      const pose = cloneAt(id, i) || (api.nearestPose ? api.nearestPose(id, i) : null);
      const src = keyFrom(pose, false);
      if (!src) { api.toast(T('track.keyNoPose', '这一帧和前后都没有画面，先画点东西再打关键帧')); return; }
      arr[i] = src;
    }
    commit(id, T('track.keyLabel', '关键帧'));
    render();
  }

  /* ---------------- 缩放（v7.8.1：滚轮 / 双指，＋－ 按钮已移除） ---------------- */
  let zoomRaf = 0;
  let zoomPending = null;

  /* 以锚点帧把列宽设成 next；连续手势用 rAF 合并重绘。
     v7.8.3：放大时锚点固定在可视区左端（gutter 右侧第一帧），左端显示不动；
     缩小时仍以指针 / 双指中点所在帧为锚点（缩小行为保持不变）。 */
  function zoomTo(next, clientX) {
    zoomPending = { next: next, clientX: clientX };
    if (zoomRaf) return;
    zoomRaf = requestAnimationFrame(() => {
      zoomRaf = 0;
      const z = zoomPending;
      zoomPending = null;
      if (!z || !enabled) return;
      const min = COLW_STEPS[0], max = COLW_STEPS[COLW_STEPS.length - 1];
      const v = Math.max(min, Math.min(max, Math.round(z.next)));
      if (v === colW) return;
      const sc = $('tsScroll');
      const rect = sc ? sc.getBoundingClientRect() : null;
      const anchorLeft = v > colW; /* 放大 → 锚左端；缩小 → 锚指针 */
      const px = (anchorLeft && rect) ? (rect.left + gutterPx) : z.clientX;
      let anchor = null;
      if (sc && rect && typeof px === 'number') {
        anchor = (sc.scrollLeft + px - rect.left - gutterPx) / colW;
      }
      colW = v;
      try { localStorage.setItem(COLW_KEY, String(colW)); } catch (_) {}
      render();
      if (sc && rect && anchor != null && isFinite(anchor)) {
        sc.scrollLeft = Math.max(0, anchor * colW - (px - rect.left - gutterPx));
      }
    });
  }

  /* 档位缩放（滚轮用）。连续捏合后 colW 可能落在档位之间，取最近档位再走一步。 */
  function zoom(dir, clientX) {
    let k = 0;
    for (let i = 1; i < COLW_STEPS.length; i++) {
      if (Math.abs(COLW_STEPS[i] - colW) < Math.abs(COLW_STEPS[k] - colW)) k = i;
    }
    k = Math.max(0, Math.min(COLW_STEPS.length - 1, k + (dir > 0 ? 1 : -1)));
    zoomTo(COLW_STEPS[k], clientX);
  }

  /* ---------------- 框选（空白处按住拖） ---------------- */
  let marqEl = null;

  function marqueeEl() {
    const cv = $('tsCanvas');
    if (marqEl && marqEl.parentNode === cv) return marqEl;
    if (!cv) return null;
    marqEl = document.createElement('div');
    marqEl.className = 'ts-marquee';
    marqEl.hidden = true;
    cv.appendChild(marqEl);
    return marqEl;
  }
  function hideMarquee() {
    if (marqEl) { marqEl.hidden = true; marqEl.style.width = '0px'; marqEl.style.height = '0px'; }
  }
  /* 选框配色跟着主题高亮走（v7.4.6）：读 --color-primary，再压暗 42% 保证在
     浅色面板和缩略图上都看得清 —— 以前写死深绿，换主题还是绿的。 */
  function paintMarquee() {
    const el = marqueeEl();
    if (!el) return;
    let base = '#7d9bc4';
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
      if (v) base = v;
    } catch (_) {}
    const cu = (window.SKFE && SKFE.core && SKFE.core.colorUtils) || null;
    const strong = cu ? cu.themeMixHex(base, '#000000', 0.42) : base;
    el.style.borderColor = strong;
    el.style.background = cu ? cu.themeHexToRgba(strong, 0.10) : 'rgba(0,0,0,.08)';
  }
  /* 这一行里覆盖第 i 帧的长条（没有就取第一条） */
  function clipAt(id, i) {
    const cv = $('tsCanvas');
    if (!cv) return null;
    const list = Array.prototype.slice.call(cv.querySelectorAll('.ts-clip[data-id="' + id + '"]'));
    if (!list.length) return null;
    return list.filter(c => i >= +c.dataset.a && i <= +c.dataset.b)[0] || list[0];
  }
  /* 视口坐标的矩形 ∩ 每条长条的包围盒 —— 全用视口坐标，滚动/缩放都不用自己算 */
  function clipsInRect(rect) {
    const cv = $('tsCanvas');
    if (!cv || !rect) return [];
    const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
    const out = [];
    cv.querySelectorAll('.ts-clip').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right < rect.x || r.left > x2 || r.bottom < rect.y || r.top > y2) return;
      out.push({ id: el.dataset.id, a: +el.dataset.a, b: +el.dataset.b, top: r.top });
    });
    out.sort((p, q2) => p.top - q2.top);
    return out;
  }

  /* ---------------- 交互绑定 ---------------- */

  /* v7.4.9：长条 / 关键帧改成「长按 1 秒才进入拖动」。
     手指按在长条上本来分不清「想拖」还是「想滚」——一按下就认定要拖，
     结果手指还没动，位置就先被挪了一格。现在的分工：
       · 按住 1 秒 → 震一下、进入拖动（松手才算数，中途数据不动）
       · 1 秒内抬手 → 当作点一下（选中这一行 / 跳到这一帧）
       · 1 秒内划走 → 当作滚动轨道（长条铺满整行，不给平移就没法滚）
     鼠标不受影响：PC 端按下即拖，加延时只会变难用。 */
  const LONG_PRESS_MS = 1000;
  const PAN_SLOP = 8;        /* 长按计时期间允许的手抖 */

  let press = null;   /* 待判定的长按：{ sx, sy, timer, tap } */
  let pan = null;     /* 长按没等到就划走了 → 平移轨道 */

  /* v7.8.1：轨道区双指捏合缩放（仅轨道模式），与单指拖拽互斥。
     v7.9.2：手机端作用范围从顶部刻度尺扩大到整个下方面板 #trackStrip。 */
  const pinchPointers = new Map();
  let pinching = false;
  let pinch0 = null;

  function inTrackPanel(target) {
    return !!(target && target.closest && target.closest('#trackStrip'));
  }
  function clearDragVisual(st) {
    if (!st) return;
    if (st.els) st.els.forEach(x => x.el && x.el.classList.remove('dragging'));
    if (st.el) st.el.classList.remove('dragging', 'drag-l', 'drag-r', 'drag-m');
  }

  function clearPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  /* 列的基准：任意一条 lane 都和长条左端对齐，横向滚动时一起动；
     canvas 是视口，拿它算会在滚动后错位。 */
  function laneRef() {
    const cv = $('tsCanvas');
    return cv.querySelector('.ts-lane') || cv;
  }

  /* 屏幕横坐标 → 第几帧（夹在 0 … 总帧数-1 之内） */
  function frameAt(clientX) {
    const r = laneRef().getBoundingClientRect();
    const i = Math.floor((clientX - r.left) / colW);
    return Math.max(0, Math.min(totalFrames() - 1, i));
  }

  /* v7.8.2：是否落在顶部刻度尺行（用户截图里的蓝色时间刻度范围）。
     滚轮 / 双指缩放只在这一行生效；下方长条区域的滚轮交还原生上下滚动。 */
  function inRuler(target) {
    return !!(target && target.closest && target.closest('.ts-ruler-row'));
  }

  function bindDrag() {
    const cv = $('tsCanvas');
    if (!cv || cv.dataset.bound === '1') return;
    cv.dataset.bound = '1';

    /* begin = 真正开始拖（建 drag + 加 .dragging）；tap = 短按做什么
       v7.7.0：触屏改成「按下即拖」，和桌面一致。
       旧逻辑要求触屏静止长按 1 秒才进入拖动，期间手指滑出 8px 就被判成「想滚动」
       并 clearPress；但长条铺满整行、滚动本就无意义，于是既没拖也没滚 ——
       用户看到的就是「长按拖动 / 拉长段落完全没反应」。
       现在按下立即 begin()：短按（没移动）仍由 finish() 里 !st.moved 分支走点选，
       触屏靠 touch-action:none 保证原生滚动不抢手势；要滚动请用刻度尺横滑刷时间线。 */
    const armOrBegin = (e, begin, tap) => {
      clearPress();
      begin();
    };

    /* 空白处短按：跳帧 + 选中这一行的长条 + 选中这一行的元件。
       先跳帧再选：goToFrame 会重建 AppState.objects，反过来的话选中的是旧对象。 */
    const tapFrameAt = (i, rowId) => {
      if (i >= 0 && i < totalFrames()) api.goToFrame(i);
      if (rowId) {
        lastPickedId = rowId;
        const segEl = clipAt(rowId, i);
        if (segEl) setClipSel([{ id: rowId, a: +segEl.dataset.a, b: +segEl.dataset.b }]);
        api.selectTrack(rowId);
        markRow(rowId);
      }
      render();
    };

    /* 关键帧短按：把播放头挪过去 + 选中这一行的元件。
       （点在一条「这一帧本来空白」的轨上，不挪播放头就 selectTrack 不到元件。） */
    const tapKeys = (items) => {
      if (!items || !items.length) return;
      if (items.length === 1 && items[0].i !== api.currentFrame()) api.goToFrame(items[0].i);
      api.selectTrack(items[0].id);
    };

    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      /* v7.9.2：手机端双指缩放覆盖整个下方面板（长条 / 空白 / 刻度尺都行）。
         PC 滚轮仍只在蓝色刻度尺行生效，两套手势互不干扰。 */
      if (e.pointerType !== 'mouse' && inTrackPanel(e.target)) {
        pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchPointers.size >= 2) {
          clearPress();
          clearDragVisual(drag);
          drag = null; pan = null;
          pinching = true;
          const pts = Array.from(pinchPointers.values());
          pinch0 = {
            d: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
            cw: colW
          };
          try { cv.setPointerCapture(e.pointerId); } catch (_) {}
          e.preventDefault();
          return;
        }
      }
      if (pinching) { e.preventDefault(); return; }

      /* 眼睛是「按一下」的动作，交给 click 处理；捏合中不启动任何拖拽 */
      if (e.target.closest('[data-eye]') || pinching) return;

      /* v7.4.9：刻度尺（时间显示那一栏）按住拖 = 刷时间线，按一下 = 跳到那一帧。
         放在最前面：这一栏只有 22px 高，拖它的人想的是拖时间线，不该起框选。 */
      if (e.target.closest('.ts-ruler')) {
        const i0 = frameAt(e.clientX);
        drag = { kind: 'scrub', last: i0, moved: false };
        if (i0 !== api.currentFrame()) api.goToFrame(i0);
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
        return;
      }

      /* 关键帧菱形：单拖改这一帧的时间；Ctrl / ⌘ / Shift 点 = 加选或减选 */
      const kEl = e.target.closest('.ts-key');
      if (kEl) {
        const kid = kEl.dataset.id;
        const ki = +kEl.dataset.i;
        const tok = ktok(kid, ki);
        const additive = !!(e.ctrlKey || e.metaKey || e.shiftKey);

        if (additive) {
          /* 只调选择，不起拖拽 —— 否则 Ctrl 点一下总会跟上一次 pointermove 的手势 */
          if (selKeys.has(tok)) selKeys.delete(tok); else selKeys.add(tok);
          kEl.classList.toggle('sel', selKeys.has(tok));
          selClip = null;
          lastPickedId = kid;
          markRow(kid);
          e.preventDefault();
          return;
        }

        /* 点在没被选中的那颗上 = 改单选这一颗；点在已选中的里面 = 保留整组，一起拖 */
        if (!selKeys.has(tok)) {
          selKeys.clear();
          selKeys.add(tok);
        } else {
          liveSelKeys();   /* 顺手把撤销之后残留的脏 token 清掉 */
        }
        cv.querySelectorAll('.ts-key').forEach((el) => {
          el.classList.toggle('sel', selKeys.has(ktok(el.dataset.id, el.dataset.i)));
        });

        const items = liveSelKeys();
        selClip = null;
        lastPickedId = kid;
        markRow(kid);

        const begin = () => {
          const byTok = Object.create(null);
          cv.querySelectorAll('.ts-key').forEach((el) => { byTok[ktok(el.dataset.id, el.dataset.i)] = el; });
          const els = [];
          items.forEach((it) => {
            const el = byTok[ktok(it.id, it.i)];
            if (el) els.push({ i: it.i, el });
          });
          drag = {
            kind: 'keys',
            items,
            els,
            startX: e.clientX,
            startY: e.clientY,
            isTouch: e.pointerType !== 'mouse',
            d: 0,
            alt: !!e.altKey,
            moved: false
          };
          els.forEach(x => x.el.classList.add('dragging'));
          try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        };
        armOrBegin(e, begin, () => tapKeys(items));
        e.preventDefault();
        return;
      }

      const clip = e.target.closest('.ts-clip');
      if (clip) {
        const rect = clip.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        /* v7.7.0：触屏手指粗，两端手柄命中区放大到 HANDLE_W_TOUCH（鼠标仍用 10px）。
           但长条本身很窄时（1~2 帧）不能让两端把手把整条吃光，取 1/3 宽兜底。 */
        const hw = Math.min(e.pointerType === 'mouse' ? HANDLE_W : HANDLE_W_TOUCH, rect.width / 3);
        const mode = dx <= hw ? 'l' : (rect.width - dx <= hw ? 'r' : 'm');
        const cid = clip.dataset.id;
        const ca = +clip.dataset.a, cb = +clip.dataset.b;
        const additive = !!(e.ctrlKey || e.metaKey || e.shiftKey);

        /* 点一条没被选中的 = 单选它；点在「已经多选」的其中一条上 = 保留整组 */
        if (!isClipSelected(cid, ca, cb)) {
          if (additive && selClips.length) setClipSel(selClips.concat([{ id: cid, a: ca, b: cb }]), { id: cid, a: ca, b: cb });
          else setClipSel([{ id: cid, a: ca, b: cb }]);
        } else {
          setClipSel(selClips, { id: cid, a: ca, b: cb });   /* 只换「主选」 */
        }
        lastPickedId = cid;
        clearKeySel();              /* 选中长条就不再认关键帧多选，两套选择互斥 */
        markRow(cid);
        cv.querySelectorAll('.ts-clip').forEach((el) => {
          el.classList.toggle('sel', isClipSelected(el.dataset.id, +el.dataset.a, +el.dataset.b));
        });

        /* v7.4.9：多选之后抓中间 = 整组平移，抓任意一端 = 整组一起拉长 / 缩短 */
        const group = selClips.length > 1 ? selClips.slice() : null;
        const els = [];
        if (group) {
          group.forEach((c) => {
            const el = cv.querySelector('.ts-clip[data-id="' + c.id + '"][data-a="' + c.a + '"][data-b="' + c.b + '"]');
            if (el) els.push({ c: c, el: el });
          });
        }

        const begin = () => {
          drag = {
            kind: 'clip',
            id: cid,
            si: +clip.dataset.si,
            a: ca,
            b: cb,
            mode,
            startX: e.clientX,
            startY: e.clientY,
            isTouch: e.pointerType !== 'mouse',
            d: 0,
            el: clip,
            group: group,
            els: els,
            moved: false
          };
          (group ? els.map(x => x.el) : [clip]).forEach(el => el.classList.add('dragging', 'drag-' + mode));
          try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        };
        armOrBegin(e, begin, () => {
          /* 短按 = 只选中这个元件和这条长条，不切子轨、不动帧号 */
          api.selectTrack(cid);
          render();
        });
        e.preventDefault();
        return;
      }

      /* v7.4.5：面板任意空白处都能起框选 —— 轨道行、左侧标签列、行间空隙都算
         （刻度尺现在归「刷时间线」，长条 / 关键帧 / 按钮在上面各自 return）。
         短按 = 跳帧 + 选中这一行的元件；按住拖 = 框选多条长条。
         这一处**不加长按门槛**：空白处本来就是手机上唯一能原生滚动的区域，
         一加延时反而把滚动抢走了。 */
      const rowEl = e.target.closest('.ts-row[data-id]');
      const lr = laneRef().getBoundingClientRect();
      const startFrame = Math.floor((e.clientX - lr.left) / colW);
      if (e.pointerType !== 'mouse') {
        /* v7.9.2：手机空白区左右拖 = 逐帧读取画面；上下拖 = 滚动轨道。
           PC 仍保留框选。 */
        drag = {
          kind: 'blankTouch',
          i: startFrame,
          startFrame: startFrame,
          rowId: rowEl ? rowEl.dataset.id : null,
          sx: e.clientX,
          sy: e.clientY,
          mode: null,
          moved: false
        };
      } else {
        paintMarquee();   /* v7.4.6：每次起手重新按当前主题上色 */
        drag = {
          kind: 'marquee',
          i: startFrame,
          rowId: rowEl ? rowEl.dataset.id : null,
          sx: e.clientX,
          sy: e.clientY,
          rect: null,
          moved: false
        };
      }
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    });

    /* 按一下的动作：眼睛（缩放已改为滚轮 / 双指，不再有按钮） */
    cv.addEventListener('click', (e) => {
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        lastPickedId = eye.dataset.eye;
        api.toggleHidden(eye.dataset.eye);
        render();   /* 隐藏态只发 need:render，这里自己跟一次，图标和长条才会立刻变 */
      }
    });

    /* 双击某颗关键帧 = 选中这一整条轨上的所有关键帧（整轨平移 / 复制的最短路径） */
    cv.addEventListener('dblclick', (e) => {
      const kEl = e.target.closest('.ts-key');
      if (!kEl) return;
      selectTrackKeys(kEl.dataset.id);
      e.preventDefault();
    });

    cv.addEventListener('pointermove', (e) => {
      /* v7.8.1：两指捏合 —— 按初始间距比例缩放列宽，以双指中点为锚点 */
      if (pinchPointers.has(e.pointerId)) {
        pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (pinching && pinch0 && pinchPointers.size >= 2) {
        const pts = Array.from(pinchPointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        zoomTo(pinch0.cw * d / pinch0.d, (pts[0].x + pts[1].x) / 2);
        e.preventDefault();
        return;
      }
      /* v7.9.2：手机空白区左右拖 = 读取画面，上下拖 = 滚动轨道 */
      if (drag && drag.kind === 'blankTouch') {
        const vx = e.clientX - drag.sx, vy = e.clientY - drag.sy;
        if (!drag.mode && (Math.abs(vx) > PAN_SLOP || Math.abs(vy) > PAN_SLOP)) {
          drag.mode = Math.abs(vx) > Math.abs(vy) ? 'scrub' : 'pan';
        }
        if (drag.mode === 'scrub') {
          const i = Math.max(0, Math.min(totalFrames() - 1, drag.startFrame + Math.round(vx / colW)));
          drag.moved = true;
          if (i !== drag.last) { drag.last = i; api.goToFrame(i); }
        } else if (drag.mode === 'pan') {
          const sc = $('tsScroll');
          if (sc) pan = { sc: sc, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
          drag = null;
        }
        e.preventDefault();
        return;
      }

      /* 长按还没到就划走了：不是拖长条，是想滚轨道 —— 改成平移 */
      if (press && !drag) {
        const dx = e.clientX - press.sx, dy = e.clientY - press.sy;
        if (Math.abs(dx) > PAN_SLOP || Math.abs(dy) > PAN_SLOP) {
          clearPress();
          const sc = $('tsScroll');
          if (sc) pan = { sc: sc, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
        }
        return;
      }
      if (pan) {
        pan.sc.scrollLeft = pan.left - (e.clientX - pan.x);
        pan.sc.scrollTop = pan.top - (e.clientY - pan.y);
        return;
      }

      if (!drag) {
        /* 光标提示：手柄处左右箭头，关键帧上抓手 */
        const clip = e.target.closest('.ts-clip');
        if (clip) {
          const rect = clip.getBoundingClientRect();
          const dx = e.clientX - rect.left;
          clip.style.cursor = (dx <= HANDLE_W || rect.width - dx <= HANDLE_W) ? 'ew-resize' : 'grab';
        }
        return;
      }

      /* v7.7.0：触屏按下即拖后，长条区域不再靠 press 判定滚动。
         这里补回「竖向滑动 = 滚动轨道」：手指主要竖着划（|dy| 明显大于 |dx|）
         且还没产生水平位移时，撤销刚建的拖动、转成滚动，让多轨道面板仍能上下翻。
         水平划走则保留拖动（拖长条 / 平移段）。 */
      if (drag.isTouch && !drag.moved && (drag.kind === 'clip' || drag.kind === 'keys')) {
        const vx = Math.abs(e.clientX - drag.startX), vy = Math.abs(e.clientY - drag.startY);
        if (vy > PAN_SLOP && vy > vx * 1.4) {
          if (drag.els) drag.els.forEach(x => x.el.classList.remove('dragging'));
          if (drag.el) drag.el.classList.remove('dragging', 'drag-l', 'drag-r', 'drag-m');
          drag = null;
          const sc = $('tsScroll');
          if (sc) pan = { sc: sc, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
          return;
        }
      }

      /* 刷时间线：手指划到哪一帧就跳哪一帧 */
      if (drag.kind === 'scrub') {
        const i = frameAt(e.clientX);
        if (i === drag.last) return;
        drag.last = i;
        drag.moved = true;
        api.goToFrame(i);
        return;
      }

      if (drag.kind === 'keys') {
        const raw = Math.round((e.clientX - drag.startX) / colW);
        const d = clampKeyDelta(drag.items, raw);
        if (d === drag.d) return;
        drag.d = d;
        drag.moved = d !== 0;
        /* 只挪 DOM，不碰数据 —— 整组一起走同一格数 */
        drag.els.forEach((x) => { x.el.style.left = ((x.i + d) * colW + colW / 2) + 'px'; });
        return;
      }

      /* 框选：空白处按住拖出一个选框，压到哪几条长条就选哪几条 */
      if (drag.kind === 'marquee') {
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   /* 抖动阈值：短按还是当点击 */
        drag.moved = true;
        drag.rect = {
          x: Math.min(drag.sx, e.clientX), y: Math.min(drag.sy, e.clientY),
          w: Math.abs(dx), h: Math.abs(dy)
        };
        const el = marqueeEl();
        const cr = cv.getBoundingClientRect();
        el.hidden = false;
        el.style.left = (drag.rect.x - cr.left) + 'px';
        el.style.top = (drag.rect.y - cr.top) + 'px';
        el.style.width = drag.rect.w + 'px';
        el.style.height = drag.rect.h + 'px';
        const hits = clipsInRect(drag.rect);
        cv.querySelectorAll('.ts-clip').forEach((c) => {
          const on = hits.some(h => String(h.id) === c.dataset.id && h.a === +c.dataset.a && h.b === +c.dataset.b);
          c.classList.toggle('sel', on);
        });
        return;
      }

      const raw = Math.round((e.clientX - drag.startX) / colW);
      let d = raw;
      if (drag.group) {
        /* 整组：抓中间一起平移；抓两端一起拉长 / 缩短 */
        const bd = (drag.mode === 'm') ? multiMoveBounds(drag.group) : multiResizeBounds(drag.group, drag.mode);
        d = Math.max(bd.lo, Math.min(bd.hi, d));
      } else if (drag.mode === 'm') {
        const bd = moveBounds(drag.id, drag.a, drag.b);
        d = Math.max(bd.lo, Math.min(bd.hi, d));
      } else if (drag.mode === 'r') {
        const bd = moveBounds(drag.id, drag.a, drag.b);
        d = Math.max(-(drag.b - drag.a), Math.min(bd.hi, d));
      } else {
        const bd = moveBounds(drag.id, drag.a, drag.b);
        d = Math.max(bd.lo, Math.min(drag.b - drag.a, d));
      }
      if (d === drag.d) return;
      drag.d = d;
      drag.moved = d !== 0;

      /* 只动 DOM，不碰数据 */
      if (drag.group) {
        drag.els.forEach((x) => {
          const c = x.c;
          let ta = c.a, tb = c.b;
          if (drag.mode === 'm') { ta = c.a + d; tb = c.b + d; }
          else if (drag.mode === 'r') { tb = c.b + d; }
          else { ta = c.a + d; }
          x.el.style.left = (ta * colW) + 'px';
          x.el.style.width = Math.max(colW, (tb - ta + 1) * colW) + 'px';
          const lab = x.el.querySelector('.ts-lab');
          if (lab) lab.textContent = (ta + 1) + (tb > ta ? '–' + (tb + 1) : '');
        });
        return;
      }
      const el = drag.el;
      if (drag.mode === 'm') {
        el.style.left = ((drag.a + d) * colW) + 'px';
        el.querySelector('.ts-lab').textContent = (drag.a + d + 1) + '–' + (drag.b + d + 1);
      } else if (drag.mode === 'r') {
        el.style.width = Math.max(colW, (drag.b - drag.a + 1 + d) * colW) + 'px';
        el.querySelector('.ts-lab').textContent = (drag.a + 1) + '–' + (drag.b + d + 1);
      } else {
        el.style.left = ((drag.a + d) * colW) + 'px';
        el.style.width = Math.max(colW, (drag.b - drag.a + 1 - d) * colW) + 'px';
        el.querySelector('.ts-lab').textContent = (drag.a + d + 1) + '–' + (drag.b + 1);
      }
    });

    const finish = (e) => {
      const isCancel = !!(e && e.type === 'pointercancel');
      /* 长按没到就抬手 = 短按：走 tap，不碰数据（被系统打断取消时不算点选） */
      if (press) {
        const p = press;
        clearPress();
        try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
        if (p.tap && !isCancel) p.tap();
        return;
      }
      if (pan) {
        pan = null;
        try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
        return;
      }
      if (!drag) return;
      const st = drag;
      drag = null;
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      if (st.kind === 'marquee') hideMarquee();
      if (st.els) st.els.forEach(x => x.el.classList.remove('dragging'));
      else if (st.el) st.el.classList.remove('dragging', 'drag-l', 'drag-r', 'drag-m');

      /* 刷时间线：一路上已经跳过去了，松手什么都不用做，也不进历史 */
      if (st.kind === 'scrub') return;
      if (st.kind === 'blankTouch') {
        if (!st.moved && !isCancel) tapFrameAt(st.i, st.rowId);
        else if (st.moved) render();
        return;
      }

      if (st.kind === 'marquee') {
        if (!st.moved) {
          /* 短按 = 跳帧 + 选中这一行的长条（已经选中的不会被清掉）。
             v7.4.6：以前这里会 clearClipSel + clearKeySel —— 点一下旁边空白，
             正在编辑的那条轨就掉了选中，很别扭。现在只有 Esc 才清选择。 */
          tapFrameAt(st.i, st.rowId);
          return;
        }
        const hits = clipsInRect(st.rect || { x: 0, y: 0, w: 0, h: 0 });
        clearKeySel();
        if (!hits.length) {
          clearClipSel();
          render();
          api.toast(T('track.marqueeNone', '框选范围内没有长条 —— 要把框拖到长条上'));
          return;
        }
        /* 主选 = 最上面那条；用户框完直接按 Delete 就能整段删 */
        setClipSel(hits, hits[0]);
        render();
        api.toast(T('track.marqueeDone', '已选中 %n 段长条：可以整组拖动、整组拉长 / 缩短，或按删除').replace('%n', hits.length));
        return;
      }

      if (st.kind === 'keys') {
        if (!st.moved) {
          /* v7.4.4：点轨道上的关键帧也算「点了这一行」，顺手把这行的元件选上，
             用户点完就能直接去左上属性面板改它。 */
          tapKeys(st.items);
          return;
        }
        if (st.items.length === 1) {
          const one = st.items[0];
          withTx(st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'),
            () => applyKeyDrag({ id: one.id, i: one.i, alt: st.alt }, one.i + st.d));
        } else {
          withTx(st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'),
            () => applyKeysDrag(st));
        }
        render();
        return;
      }

      if (!st.moved) {
        /* 没拖动 = 点选：只选中这个元件和这条长条，不切子轨、不动帧号 */
        api.selectTrack(st.id);
        render();
        return;
      }
      if (st.group) {
        /* 整组：平移 / 整组拉长缩短 —— 一步撤销 */
        withTx(st.mode === 'm' ? T('track.moveClipLabel', '整体移动长条') : T('track.resizeClipLabel', '整体拉长 / 缩短长条'),
          () => {
            if (st.mode === 'm') applyClipsMove(st.group, st.d);
            else applyClipsResize(st.group, st.d, st.mode);
          });
      } else {
        withTx(T('track.dragLabel', '调整轨道'), () => applyDrag(st, st.d));
        /* v7.9.0：单条拖完也把选区更新到新范围，循环按钮才能继续保持正确激活态 */
        setClipSel([st.mode === 'm'
          ? { id: st.id, a: st.a + st.d, b: st.b + st.d }
          : (st.mode === 'r'
            ? { id: st.id, a: st.a, b: st.b + st.d }
            : { id: st.id, a: st.a + st.d, b: st.b })]);
      }
      render();
    };
    /* v7.8.1：抬手释放捏合指针，双指结束后不残留单指拖拽状态 */
    const releasePinch = (e) => {
      pinchPointers.delete(e.pointerId);
      if (pinching && pinchPointers.size < 2) {
        pinching = false; pinch0 = null;
        drag = null; pan = null;
        render();
      }
    };
    cv.addEventListener('pointerup', releasePinch);
    cv.addEventListener('pointercancel', releasePinch);
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', finish);

    /* v7.8.2：PC 滚轮缩放只在顶部刻度尺行（蓝色范围）生效；
       下方长条区域不拦截，滚轮保持原生上下移动；Shift+滚轮仍留给横向滚动。 */
    const sc = $('tsScroll');
    if (sc) {
      sc.addEventListener('wheel', (e) => {
        if (!enabled) return;
        if (e.shiftKey) return;
        if (!inRuler(e.target)) return; /* 长条区域：交给原生上下滚动 */
        e.preventDefault();
        zoom(e.deltaY < 0 ? 1 : -1, e.clientX);
      }, { passive: false });
    }

    /* 阻止浏览器把轨道区的双指识别成页面缩放（pointer 事件拦不住原生 pinch） */
    const strip = $('trackStrip');
    if (strip) {
      const blockNativePinch = (e) => {
        if (e.touches && e.touches.length >= 2) e.preventDefault();
      };
      strip.addEventListener('touchstart', blockNativePinch, { passive: false });
      strip.addEventListener('touchmove', blockNativePinch, { passive: false });
    }
  }

  /* 键盘：Ctrl/⌘+C 复制、Ctrl/⌘+V 粘贴、Delete 删除选中的关键帧、Esc 取消选择。
     用捕获阶段 + stopPropagation：只有在「真的选了关键帧」时才拦，
     其余情况一律放行给 app.js 原来的快捷键（删元件、复制元件…）。 */
  function bindKeys() {
    if (document.body.dataset.tsKeys === '1') return;
    document.body.dataset.tsKeys = '1';
    document.addEventListener('keydown', (e) => {
      if (!enabled) return;
      const el = e.target;
      const tag = (el && el.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      const mod = !!(e.ctrlKey || e.metaKey);
      const has = selKeys.size > 0;

      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (!has) return;
        e.preventDefault(); e.stopPropagation();
        copyKeys();
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        if (!keyClip) return;
        e.preventDefault(); e.stopPropagation();
        pasteKeys();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (has) {
          e.preventDefault(); e.stopPropagation();
          deleteSelKeys();
          return;
        }
        /* 没选关键帧但要删「框选出来的一整组」→ 删这几段。
           只选了一条时不抢 Delete：那时候 Delete 还是删元件（和以前一样）。 */
        if (selClips.length > 1) {
          e.preventDefault(); e.stopPropagation();
          deleteClip();
        }
        return;
      }
      if (e.key === 'Escape' && (has || selClips.length)) {
        clearKeySel();
        clearClipSel();
        render();
        return;
      }
    }, true);
  }

  /* 面板高度拖拽 */
  function bindGrip() {
    const grip = $('tlGrip');
    const tl = $('timeline');
    if (!grip || !tl || grip.dataset.bound === '1') return;
    grip.dataset.bound = '1';
    let st = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      st = { y: e.clientY, h: tl.offsetHeight };
      grip.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!st) return;
      const maxH = Math.round(window.innerHeight * 0.72);
      panelH = Math.max(MIN_H, Math.min(maxH, st.h - (e.clientY - st.y)));
      applyHeight();
      api.relayout();
    });
    const up = () => {
      if (!st) return;
      st = null;
      grip.classList.remove('dragging');
      try { localStorage.setItem(HEIGHT_KEY, String(Math.round(panelH))); } catch (_) {}
      api.relayout();
    };
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  /* 轨道模式下，「关键帧 / 复制 / 粘贴」按钮要认轨道里的选中状态，而不是子轨选择器。
     用捕获阶段先拦下来，再 stopPropagation —— 这样不必改动 app.js 里原来的监听。 */
  function bindToolbar() {
    const tl = $('timeline');
    if (!tl || tl.dataset.tsTools === '1') return;
    tl.dataset.tsTools = '1';
    tl.addEventListener('click', (e) => {
      if (!enabled) return;
      /* v7.9.0：轨道上的进入编组按钮 —— 只在选中组载体 / 已在组内时可见 */
      if (e.target.closest('#btnTrackEnterGroup')) {
        e.stopPropagation();
        e.preventDefault();
        const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
        if (!G) return;
        const editing = G.getEditingGroupId();
        if (editing) G.exitGroup();
        else {
          const selectedGid = api && api.selectedGroupId ? api.selectedGroupId() : null;
          const id = (selClip && selClip.id) || lastPickedId || selectedGid;
          let gid = selectedGid || null;
          const t = id ? tracksMap()[id] : null;
          if (!gid && t && t.frames) {
            for (const d of t.frames) {
              if (d && d.type === 'group') { gid = String(d.gid || d.id); break; }
            }
          }
          if (gid) G.enterGroup(gid);
          else api.toast(T('track.needPick', '先在轨道上点一条长条，选中要操作的段'));
        }
        clearClipSel();
        render();
        return;
      }
      if (e.target.closest('#btnKeyframe')) {
        e.stopPropagation();
        e.preventDefault();
        toggleKey();
        return;
      }
      if (e.target.closest('#btnTrackKeyCopy')) {
        e.stopPropagation();
        e.preventDefault();
        copyKeys();
        return;
      }
      if (e.target.closest('#btnTrackKeyPaste')) {
        e.stopPropagation();
        e.preventDefault();
        pasteKeys();
        return;
      }
      if (e.target.closest('#btnTrackLoop')) {
        e.stopPropagation();
        e.preventDefault();
        toggleClipLoop();
      }
    }, true);
  }

  function applyHeight() {
    const tl = $('timeline');
    if (!tl) return;
    if (enabled) tl.style.height = Math.round(panelH) + 'px';
    else tl.style.height = '';
  }

  /* ---------------- 模式开关 ---------------- */
  let dockBefore = null;   /* 进来之前是不是置顶的，退出时还原 */

  function setEnabled(on) {
    const tl = $('timeline');
    const strip = $('trackStrip');
    const btn = $('btnTrackMode');
    if (!tl || !strip) return;
    enabled = !!on;
    if (!on) {
      /* v7.9.0：切回帧动画模式时，收起「点轨道切回」的箭头提示 */
      const tip = document.getElementById('trackModeTip');
      if (tip) { tip.hidden = true; tip.style.opacity = '1'; }
    }
    tl.classList.toggle('track-mode', enabled);
    strip.hidden = !enabled;
    if (btn) {
      btn.classList.toggle('active', enabled);
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
    /* 控制面板与底部栏要压在轨道面板之上 */
    document.body.classList.toggle('track-mode-on', enabled);
    if (!enabled) { clearClipSel(); selKeys.clear(); }

    /* 「轨道面板要在控制面板下方」—— 开着的时候就先临时落到屏幕底部 */
    if (enabled) {
      if (api && api.getDock && api.setDock && api.getDock() === 'top') {
        dockBefore = 'top';
        api.setDock('bottom');
      }
    } else if (dockBefore === 'top') {
      dockBefore = null;
      if (api && api.setDock) api.setDock('top');
    }

    applyHeight();
    if (enabled) render();
    try { localStorage.setItem(MODE_KEY, enabled ? '1' : '0'); } catch (_) {}
    if (api) api.relayout();
  }

  /* ---------------- 对外 ---------------- */
  const TrackStrip = {
    init(a) {
      api = a;
      try {
        const c = parseInt(localStorage.getItem(COLW_KEY) || '', 10);
        if (COLW_STEPS.indexOf(c) >= 0) colW = c;
        const h = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10);
        if (h >= MIN_H) panelH = h;
      } catch (_) {}

      bindGrip();
      bindDrag();
      bindToolbar();
      bindKeys();

      /* v7.4.9：视口宽度一变，样式断点可能换掉左列宽（108 ↔ 84）—— 量到的宽度变了就重画，
         否则播放头会按旧的左列宽偏着走。 */
      window.addEventListener('resize', () => {
        if (!enabled) return;
        if (readGutter() === gutterPx) return;
        render();
      });

      /* 完全被动地跟随现有事件总线：不改 app.js 里任何一个函数，
         现有功能该发什么事件照发，这边只是「听到就顺手更新一下自己」。 */
      const bus = root.SKFE.core && root.SKFE.core.eventBus && root.SKFE.core.eventBus.EventBus;
      if (bus) {
        bus.on('need:syncUI', () => TrackStrip.scheduleRefresh());
        bus.on('app:update', () => TrackStrip.scheduleRefresh());
        /* v7.4.2：高级设置里切「帧缩略图」只发 need:render，不跟一下长条上的小图不会变 */
        bus.on('need:render', () => TrackStrip.scheduleRefresh());
      }

      const btn = $('btnTrackMode');
      if (btn) btn.addEventListener('click', () => setEnabled(!enabled));

      const splitBtn = $('btnSplit');
      if (splitBtn) splitBtn.addEventListener('click', split);
      const delBtn = $('btnTrackDel');
      if (delBtn) delBtn.addEventListener('click', deleteClip);

      /* v7.9.0 编组：把框选的多条轨道编组 / 解散选中的组（与元件列表按钮效果一致）。
         轨道本身只产出「要编组的轨 id 列表」，真正的数据写入由 SKFE.systems.group 完成。 */
      const grpBtn = $('btnTrackGroup');
      if (grpBtn) grpBtn.addEventListener('click', () => {
        const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
        if (!G) return;
        const ids = (selClips.length ? selClips : (keyClip ? keyClip.items : [])).map(c => String(c.id));
        if (ids.length < 2) { if (root.alert) root.alert('请先框选多条轨道（Ctrl/⌘ 点选或框选）再编组'); return; }
        G.createGroup(ids);
        clearClipSel();
      });
      const ungrpBtn = $('btnTrackUngroup');
      if (ungrpBtn) ungrpBtn.addEventListener('click', () => {
        const G = root.SKFE && root.SKFE.systems && root.SKFE.systems.group;
        if (!G) return;
        const ids = (selClips.length ? selClips : (keyClip ? keyClip.items : [])).map(c => String(c.id));
        let gid = null;
        for (const id of ids) {
          const fr = api.getTrackFrame(id, api.currentFrame());
          if (fr && G.isGroup(fr)) { gid = String(fr.gid || fr.id); break; }
        }
        if (!gid) { if (root.alert) root.alert('请先选中一个组轨道'); return; }
        G.ungroup(gid);
        clearClipSel();
      });

      /* 恢复上次的模式；手机屏幕矮，默认不给开 */
      let restore = false;
      try { restore = localStorage.getItem(MODE_KEY) === '1'; } catch (_) {}
      if (restore && !a.isMobile()) setEnabled(true);
      else { applyHeight(); }
    },

    render,
    syncPlayhead,

    /* 外部（撤销 / 导入工程 / 恢复快照）之后重画。
       need:syncUI 一类的广播很密（滑条拖动也会发），这里 rAF 去抖 + 数据指纹比对，
       没有真变化就什么都不做，保证「新增功能不拖慢原有功能」。 */
    scheduleRefresh() {
      if (!enabled || refreshQueued) return;
      refreshQueued = true;
      root.requestAnimationFrame(() => {
        refreshQueued = false;
        if (!enabled) return;
        syncPlayhead();
        if (signature() !== lastSig) render();
      });
    },
    refresh() { if (enabled) render(); },
    isEnabled() { return enabled; },
    setEnabled,
    getColW() { return colW; },

    /* 调试 / 测试入口（也方便以后接右键菜单） */
    copyKeys,
    pasteKeys,
    deleteSelKeys,
    /* v7.9.0：编组长条伸缩的无头回归入口（内部 applyDrag 保持私有） */
    debugApplyDrag(st, d) {
      applyDrag(st, d);
      setClipSel([st.mode === 'm'
        ? { id: st.id, a: st.a + d, b: st.b + d }
        : (st.mode === 'r'
          ? { id: st.id, a: st.a, b: st.b + d }
          : { id: st.id, a: st.a + d, b: st.b })]);
      if (enabled) render();
    },
    /* v7.9.0：段落循环的无头回归入口 */
    toggleClipLoop,
    isLoopClip,
    debugSetClipSel(list) { setClipSel(list || []); if (enabled) render(); },
    debugLoops(id) { return loopsOf(id).map(l => ({ a: l.a, b: l.b })); },
    /* 长条选择（框选 / 多选）的调试入口 */
    selectedClips() { return selClips.slice(); },
    clearClipSel() { clearClipSel(); if (enabled) render(); },
    deleteClips() { deleteClip(); },
    selectAllKeys(id) { selectTrackKeys(id); },
    selectedKeys() { return liveSelKeys(); },
    hasClip() { return !!(keyClip && keyClip.items.length); },
    clearKeySel() { clearKeySel(); if (enabled) render(); }
  };

  root.SKFE.features.trackStrip = TrackStrip;
})();
