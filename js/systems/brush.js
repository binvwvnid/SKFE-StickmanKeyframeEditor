// js/systems/brush.js
// SKFE 画笔元件系统 v5.1.0 —— 矢量画笔（type: 'ink'）
// 说明：与 eraser.js 同一套模块范式（IIFE + init(deps) + boot()），
//       所有依赖通过 D.xxx 访问，不引入任何外部库。
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.brush = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  /* ==================== i18n 小工具 ==================== */
  function tr(key, fallback) {
    try {
      if (typeof window.t === 'function') {
        const s = window.t(key);
        if (s && s !== key) return s;
      }
    } catch (_) {}
    return fallback;
  }

  /* ==================== 状态 ==================== */
  let brushOn = false;              // 画笔模式是否开启
  let bucketMode = false;           // v7.9.2：油漆桶模式（点画布闭合区域填充）
  let editingInk = null;            // 正在编辑的 ink 元件（null 表示新建模式）
  /* v6.2.0：会话内的笔迹 / 橡皮 / 实时笔画**一律用世界坐标 + 世界宽度**。
     以前存屏幕坐标、收笔时才除以缩放，导致：换个缩放级别画同一笔，绝对粗细就变了；
     画到一半滚轮缩放，已落下的笔迹还停在旧屏幕位置，会错位断裂。
     改成世界坐标后，渲染时按当前视图投影 —— 缩放多少都不影响画面里的真实粗细。 */
  let baseStrokes = [];             // 进入时的初始笔迹（世界坐标）
  let baseErasers = [];             // 进入时的初始橡皮（世界坐标）
  let baseFills = [];               // 进入时的区域填充（世界坐标，v7.9.3）
  let ops = [];                     // 本次编辑的操作栈（{ type:'stroke'|'erase', data }）
  let current = null;               // 当前笔画（实时）
  let penTip = { x: 0, y: 0 };      // 防抖笔尖位置（世界坐标）
  let target = { x: 0, y: 0 };      // 指针目标位置（世界坐标）
  let lastTipPos = { x: 0, y: 0 };
  let targetTime = 0;
  let releaseDeadline = 0;
  let drawing = false;
  let rafId = 0;
  let finishTimer = 0;              // 收笔兜底定时器（rAF 被节流时仍然提交笔画）
  let lastFrameTime = 0;
  let loopTimer = 0;                // rAF 兜底计时器
  let lastTickAt = 0;               // 上一次 tick 的时间戳（判断 rAF 是否被节流）
  let isPenPointer = false;
  let tipPressure = 0.5;
  let pointers = new Map();         // v6.2.0：按下的指针（双指 = 缩放/平移画布）
  let pinchLastDist = 0;            // 上一次双指间距，用于算缩放倍率
  let pinchLastMid = null;          // v7.0.2：上一次双指中点，用于双指拖动平移视图
  let _prevSelected = null;         // 进入前的选中状态
  let _prevUndoDepth = 0;

  /* ==================== 画笔配置（面板驱动） ==================== */
  const cfg = {
    v: 5,              /* v6.2.0：size / borderWidth 改成世界单位；v7.9.4：新增画笔类型；默认防抖改为 50 */
    type: 'default',   /* v7.9.4：default = 原画笔；blob = 柳叶笔；crayon = 蜡笔 */
    color: '#111111',
    borderColor: '#1a1a1a',
    borderWidth: 3,
    borderEnabled: true,
    outlineUnder: true, /* v6.2.0：勾选后，这几笔的边统一铺在所有笔芯下面 */
    size: 6,
    stabilize: 0.5      /* v7.9.4：默认 50，新用户直接得到更顺滑的手感 */
  };
  /* 面板配置持久化（不影响项目数据） */
  const CFG_KEY = 'skfe_brush_cfg_v1';
  function loadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        if (o.type === 'start') cfg.type = 'crayon'; /* v7.9.4：起步点已改成蜡笔 */
        else if (o.type === 'default' || o.type === 'blob' || o.type === 'crayon') cfg.type = o.type;
        if (typeof o.color === 'string') cfg.color = o.color;
        if (typeof o.borderColor === 'string') cfg.borderColor = o.borderColor;
        if (typeof o.borderWidth === 'number') cfg.borderWidth = o.borderWidth;
        if (typeof o.borderEnabled === 'boolean') cfg.borderEnabled = o.borderEnabled;
        if (typeof o.outlineUnder === 'boolean') cfg.outlineUnder = o.outlineUnder;
        if (typeof o.size === 'number') cfg.size = o.size;
        if (typeof o.stabilize === 'number') cfg.stabilize = o.stabilize;
        /* 老配置存的是屏幕像素，按当前缩放折算成世界单位，避免升级后粗细突然差好几倍 */
        if (o.v !== 2 && o.v !== 3 && o.v !== 4 && o.v !== 5) {
          const kv = worldUnitScreenLen();
          if (kv > 1e-6 && Math.abs(kv - 1) > 1e-3) {
            cfg.size = Math.max(0.2, Math.min(120, cfg.size / kv));
            cfg.borderWidth = Math.max(0, Math.min(40, cfg.borderWidth / kv));
          }
        }
        /* v7.9.4：默认防抖从 0 改为 50。老配置只迁移一次到 50；
           v5 之后保留用户自己调过的数值。 */
        if (o.v !== 5) {
          cfg.stabilize = 0.5;
          cfg.v = 5;
          saveCfg();
        }
      }
    } catch (_) {}
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
  }

  /* ==================== 双层绘制状态 ==================== */
  let overlayCtx = null;
  let overlay = null;
  let DPR = 1;

  /* ==================== 初始化 ==================== */
  function boot() {
    overlay = document.getElementById('brushOverlay');
    if (!overlay) return;
    overlayCtx = overlay.getContext('2d');
    loadCfg();
    syncOverlaySize();
    bindUI();
    bindBrushTypeUI();
    bindFloatBar();
    bindPresetUI();
    loadPresets();
    refreshPresetOptions();
    bindPointer();
    bindHotkeys();
    bindOutsideClickExit();
    window.addEventListener('resize', syncOverlaySize);
    /* 选中状态变化时刷新「编辑选中画笔」按钮可用性 */
    D.EventBus.on('need:syncUI', refreshButtons);
    applyCfgToPanel();
    restoreCfgInputs();
    syncBrushBtn();
  }

  function syncOverlaySize() {
    if (!overlay) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    overlay.width = Math.round(w * DPR);
    overlay.height = Math.round(h * DPR);
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
    if (overlayCtx) {
      overlayCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      overlayCtx.lineCap = 'round';
      overlayCtx.lineJoin = 'round';
    }
    if (brushOn) renderOverlay();
  }

  /* brush-v5.1.0: 实现 §6.1.5 —— 面板绑定（画笔 / 橡皮合并面板） */
  function bindUI() {
    const $ = (id) => document.getElementById(id);

    const btnBrushToggle = $('btnBrushToggle');
    if (btnBrushToggle) {
      btnBrushToggle.addEventListener('click', () => {
        setOn(!brushOn);
      });
    }

    const color = $('brushColor');
    if (color) {
      color.addEventListener('input', () => {
        cfg.color = color.value;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const borderCb = $('brushBorderEnabled');
    if (borderCb) {
      borderCb.addEventListener('change', () => {
        cfg.borderEnabled = !!borderCb.checked;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    /* v6.2.0：描边铺底 —— 只有勾选之后画的笔才参与分层；
       已经画好的笔不受影响（标记存在每一笔上，不是渲染时全局一刀切）。 */
    const outlineCb = $('brushOutlineUnder');
    if (outlineCb) {
      outlineCb.checked = !!cfg.outlineUnder;
      outlineCb.addEventListener('change', () => {
        cfg.outlineUnder = !!outlineCb.checked;
        saveCfg();
        D.showToast(cfg.outlineUnder
          ? tr('brush.outlineUnderOn', '描边铺底已开：之后画的笔，边不会压住别的芯')
          : tr('brush.outlineUnderOff', '描边铺底已关：恢复每笔各自先边后芯'));
      });
    }

    const borderColor = $('brushBorderColor');
    if (borderColor) {
      borderColor.addEventListener('input', () => { cfg.borderColor = borderColor.value; saveCfg(); });
    }

    const borderWidth = $('brushBorderWidth');
    const borderWidthVal = $('brushBorderWidthVal');
    if (borderWidth) {
      borderWidth.addEventListener('input', () => {
        cfg.borderWidth = Math.max(0, Math.min(40, parseInt(borderWidth.value, 10) || 0));
        if (borderWidthVal) borderWidthVal.textContent = cfg.borderWidth;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const size = $('brushSize');
    const sizeVal = $('brushSizeVal');
    if (size) {
      size.addEventListener('input', () => {
        cfg.size = Math.max(1, Math.min(120, parseInt(size.value, 10) || 6));
        if (sizeVal) sizeVal.textContent = cfg.size;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const stab = $('brushStabilize');
    const stabVal = $('brushStabilizeVal');
    if (stab) {
      stab.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, parseInt(stab.value, 10) || 0));
        cfg.stabilize = v / 100;
        if (stabVal) stabVal.textContent = v;
        saveCfg();
      });
    }

    /* 编辑选中的画笔元件（显式入口，不使用双击） */
    const btnEdit = $('btnBrushEdit');
    if (btnEdit) {
      btnEdit.addEventListener('click', () => {
        const sel = D.getSelected();
        if (!sel || sel.type !== 'ink') {
          D.showToast(tr('brush.noInkSelected', '请先选中一个画笔元件，再点「编辑选中画笔」'));
          return;
        }
        if (sel.locked) {
          D.showToast(tr('brush.locked', '该画笔元件已锁定，请先解锁'));
          return;
        }
        if (!brushOn) setOn(true);
        openEdit(sel);
      });
    }

    /* 油漆桶：只填选中的闭合笔画，颜色取当前画笔颜色 */
    const btnBucket = $('btnBrushBucket');
    if (btnBucket) btnBucket.addEventListener('click', toggleBucketMode);

    const btnClearFrame = $('btnBrushClearFrame');
    if (btnClearFrame) {
      btnClearFrame.addEventListener('click', () => {
        if (!window.confirm(tr('brush.confirmClearFrame', '确定删除本帧所有画笔元件吗？'))) return;
        const n = D.deleteInkOnCurrentFrame();
        if (n) D.showToast(tr('brush.toastClearedFrame', '已清除本帧画笔元件'));
      });
    }

    /* 橡皮擦面板控件：交给 eraser.js 自己的 initUI 处理，
       这里只处理「在画笔模式下切到擦除」的互斥关系。 */
    const btnEraserToggle = $('btnEraserToggle');
    if (btnEraserToggle) {
      btnEraserToggle.addEventListener('click', () => {
        /* eraser.js 的监听器先执行切换，这里在下一拍读取结果 */
        setTimeout(() => {
          if (brushOn) {
            if (D.eraserIsOn()) {
              D.showToast(tr('brush.toastEraseOn', '画笔模式内已切换到擦除：拖动可擦掉笔迹'));
            }
            updateBrushCursorSize();
          }
        }, 0);
      });
    }

    const eraserSize = $('eraserSize');
    if (eraserSize) {
      eraserSize.addEventListener('input', () => {
        D.eraserSetSize(parseInt(eraserSize.value, 10) || 15);
        updateBrushCursorSize();
      });
    }
    const eraserLine = $('eraserLineMode');
    if (eraserLine) {
      eraserLine.addEventListener('change', () => D.eraserSetLineMode(!!eraserLine.checked));
    }
  }

  /* ===== v7.9.4：画笔类型（默认 / 柳叶笔） ===== */
  function bindBrushTypeUI() {
    const btn = document.getElementById('btnBrushType');
    const float = document.getElementById('brushTypeFloat');
    const close = document.getElementById('brushTypeClose');
    if (btn) btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBrushTypeFloat();
    });
    if (close) close.addEventListener('click', (e) => {
      e.stopPropagation();
      if (float) float.hidden = true;
    });
    if (float) {
      float.querySelectorAll('.brush-type-option').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          setBrushType(opt.getAttribute('data-brush-type') || 'default');
          float.hidden = true;
        });
      });
      document.addEventListener('pointerdown', (e) => {
        if (!float || float.hidden) return;
        if (e.target.closest && (e.target.closest('#brushTypeFloat') || e.target.closest('#btnBrushType'))) return;
        float.hidden = true;
      }, true);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !float.hidden) {
          e.preventDefault();
          float.hidden = true;
        }
      });
      window.addEventListener('resize', positionBrushTypeFloat);
    }
    syncBrushTypeUI();
  }

  function positionBrushTypeFloat() {
    const float = document.getElementById('brushTypeFloat');
    if (!float || float.hidden) return;
    /* 先清掉上一次的显式尺寸，避免多次打开时高度缓存导致位置偏移 */
    float.style.width = '';
    float.style.height = '';
    float.style.left = '15vw';
    float.style.top = '15vh';
    const w = float.offsetWidth || Math.round(window.innerWidth * 0.7);
    const h = float.offsetHeight || Math.round(window.innerHeight * 0.4);
    float.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
    float.style.top = Math.round((window.innerHeight - h) / 2) + 'px';
  }

  function openBrushTypeFloat() {
    const float = document.getElementById('brushTypeFloat');
    if (!float) return;
    /* 和其它「说明」浮窗保持互斥，避免叠在一起 */
    ['quickHelpFloat', 'changeLogFloat', 'globalEditHelpFloat'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    syncBrushTypeUI();
    float.hidden = !float.hidden;
    if (!float.hidden) positionBrushTypeFloat();
  }

  function setBrushType(type) {
    const next = (type === 'blob' || type === 'crayon') ? type : 'default';
    if (current) finishCurrentStroke();
    cfg.type = next;
    saveCfg();
    syncBrushTypeUI();
    const key = next === 'blob' ? 'brush.typeToastBlob' : next === 'crayon' ? 'brush.typeToastCrayon' : 'brush.typeToastDefault';
    const fallback = next === 'blob' ? '画笔类型：柳叶笔' : next === 'crayon' ? '画笔类型：蜡笔' : '画笔类型：默认';
    D.showToast(tr(key, fallback), 'ink', 1800);
  }

  function syncBrushTypeUI() {
    const label = document.getElementById('brushTypeLabel');
    const key = cfg.type === 'blob' ? 'brush.typeBlob' : cfg.type === 'crayon' ? 'brush.typeCrayon' : 'brush.typeDefault';
    const fallback = cfg.type === 'blob' ? '柳叶笔' : cfg.type === 'crayon' ? '蜡笔' : '默认';
    if (label) {
      label.textContent = tr(key, fallback);
      label.setAttribute('data-i18n', key);
    }
    const btn = document.getElementById('btnBrushType');
    if (btn) btn.classList.toggle('on', cfg.type !== 'default');

    /* 蜡笔没有包边：控件直接禁用，状态仍留在 cfg 里，切回默认时恢复用户原设置 */
    const noBorder = cfg.type === 'crayon';
    ['brushBorderEnabled', 'brushBorderColor', 'brushBorderWidth', 'brushOutlineUnder'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = noBorder;
        const lab = el.closest('label');
        if (lab) {
          if (noBorder) lab.classList.add('disabled');
          else lab.classList.remove('disabled');
        }
      }
    });
    const float = document.getElementById('brushTypeFloat');
    if (float) {
      float.querySelectorAll('.brush-type-option').forEach((opt) => {
        opt.classList.toggle('on', opt.getAttribute('data-brush-type') === cfg.type);
      });
    }
  }

  function currentPointWidth() {
    const base = widthAt();
    /* 柳叶笔的「芯粗细」当成有机块的半宽基准，默认 6 时直径约 12，更适合当填充块。
       蜡笔仍按普通宽度，颗粒只在宽度范围内撒点。 */
    return cfg.type === 'blob' ? Math.max(2, base * 2) : base;
  }

  function applyCfgToPanel() {
    const $ = (id) => document.getElementById(id);
    const map = [
      ['brushColor', cfg.color],
      ['brushBorderColor', cfg.borderColor],
      ['brushBorderWidth', cfg.borderWidth],
      ['brushSize', cfg.size],
      ['brushStabilize', Math.round(cfg.stabilize * 100)]
    ];
    map.forEach(([id, v]) => { const el = $(id); if (el) el.value = v; });
    const bw = $('brushBorderWidthVal'); if (bw) bw.textContent = cfg.borderWidth;
    const sv = $('brushSizeVal'); if (sv) sv.textContent = cfg.size;
    const st = $('brushStabilizeVal'); if (st) st.textContent = Math.round(cfg.stabilize * 100);
    const bc = $('brushBorderEnabled'); if (bc) bc.checked = !!cfg.borderEnabled;
    const oc = $('brushOutlineUnder'); if (oc) oc.checked = !!cfg.outlineUnder;
    syncBrushTypeUI();
  }

  function restoreCfgInputs() {
    const er = document.getElementById('eraserSize');
    if (er) er.value = D.eraserGetSize();
    const erv = document.getElementById('eraserSizeVal');
    if (erv) erv.textContent = D.eraserGetSize();
  }

  /* brush-v5.1.0: 实现 §6.1.6 —— 浮动工具栏（撤销上一笔 / 清空 / 取消 / 确定） */
  function bindFloatBar() {
    const bar = document.getElementById('brushFloatBar');
    if (!bar) return;
    const undo = document.getElementById('bfUndo');
    if (undo) undo.onclick = () => undoLast();
    const clear = document.getElementById('bfClear');
    if (clear) {
      clear.onclick = () => {
        if (ops.length === 0 && baseStrokes.length === 0 && baseErasers.length === 0) return;
        if (!window.confirm(tr('brush.confirmClear', '确定清空所有笔迹吗？'))) return;
        clearAll();
      };
    }
    const cancelBtn = document.getElementById('bfCancel');
    if (cancelBtn) cancelBtn.onclick = () => setOn(false);
    const ok = document.getElementById('bfConfirm');
    if (ok) ok.onclick = () => finalize();
  }

  function refreshButtons() {
    const hasContent = (ops.length > 0) || (baseStrokes.length > 0) || (baseErasers.length > 0);
    const c = document.getElementById('bfConfirm');
    if (c) c.disabled = !hasContent;
    const u = document.getElementById('bfUndo');
    if (u) u.disabled = ops.length === 0;
    const cl = document.getElementById('bfClear');
    if (cl) cl.disabled = !hasContent;
    const sel = D.getSelected();
    const edit = document.getElementById('btnBrushEdit');
    if (edit) edit.disabled = !(sel && sel.type === 'ink' && !sel.locked);
    /* 油漆桶按画布闭合区域工作，不依赖当前选中项，所以按钮始终可用 */
    const bucket = document.getElementById('btnBrushBucket');
    if (bucket) { bucket.disabled = false; bucket.classList.toggle('on', bucketMode); }
  }

  /* brush-v5.1.0: 实现 §6.1.2 —— 开关画笔模式（body.brush-mode + overlay 接管指针） */
  function setOn(on) {
    on = !!on;
    if (on === brushOn) return;
    if (on && bucketMode) setBucketMode(false);
    brushOn = on;
    if (on) {
      if (D.isPlaying && D.isPlaying()) D.pause();
      /* 与橡皮擦互斥：进入画笔时关闭独立擦除 */
      D.eraserSetOn(false);
      _prevSelected = D.getSelected();
      _prevUndoDepth = D.getUndoDepth ? D.getUndoDepth() : 0;
      document.body.classList.add('brush-mode');
      const bar = document.getElementById('brushFloatBar');
      if (bar) bar.style.display = 'flex';
      syncOverlaySize();
      if (!editingInk && ops.length === 0 && baseStrokes.length === 0 && !current) openNew();
      refreshButtons();
      syncBrushBtn();
      D.refreshUI();
      D.showToast(tr('brush.toastOn', '画笔已开启，点击画布开始绘制'));
      D.EventBus.emit('need:render');
    } else {
      document.body.classList.remove('brush-mode');
      const bar = document.getElementById('brushFloatBar');
      if (bar) bar.style.display = 'none';
      cancel();
      syncBrushBtn();
      hideBrushCursor();
    }
  }

  function isOn() { return brushOn; }

  function syncBrushBtn() {
    const btn = document.getElementById('btnBrushToggle');
    if (!btn) return;
    btn.classList.toggle('on', brushOn);
    const key = brushOn ? 'brush.enableOff' : 'brush.enable';
    btn.textContent = tr(key, brushOn ? '🖌 退出画笔' : '🖌 开启画笔');
    /* 同步 data-i18n，语言切换后仍显示正确文案 */
    btn.setAttribute('data-i18n', key);
  }

  /* brush-v5.1.0: 实现 §6.1.3 —— 新建绘制会话（clean session） */
  function openNew() {
    editingInk = null;
    baseStrokes.length = 0;
    baseErasers.length = 0;
    baseFills.length = 0;
    ops.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    penTip = { x: 0, y: 0 };
    target = { x: 0, y: 0 };
    lastTipPos = { x: 0, y: 0 };
    syncOverlaySize();
    renderOverlay();
    refreshButtons();
  }

  /* brush-v5.1.0: 实现 §6.2.1 —— 局部坐标 → 世界坐标（读回已有笔迹） */
  function inkToWorld(ink) {
    const M = D.getInkLocalMatrix(ink);
    const applyM = (p) => ({
      x: M.a * p.x + M.c * p.y + M.e,
      y: M.b * p.x + M.d * p.y + M.f
    });
    /* 局部单位 → 世界长度（均匀缩放 + 旋转，用向量长度量） */
    const o0 = applyM({ x: 0, y: 0 });
    const o1 = applyM({ x: 1, y: 0 });
    const scaleUnit = Math.hypot(o1.x - o0.x, o1.y - o0.y) || 1;

    const strokes = (ink.strokes || []).map(s => ({
      z: (typeof s.z === 'number' ? s.z : 0),        /* brush-v5.1.2: 落笔顺序 */
      type: s.type === 'blob' ? 'blob' : (s.type === 'crayon' || s.type === 'start') ? 'crayon' : 'default',  /* v7.9.4: 柳叶笔类型 */
      blobSeed: (typeof s.blobSeed === 'number' ? s.blobSeed : 0),
      color: s.color,
      borderColor: s.borderColor || null,
      outlineUnder: !!s.outlineUnder,                /* v6.2.0: 描边铺底标记 */
      fill: s.fill ? JSON.parse(JSON.stringify(s.fill)) : null, /* v7.9.2: 油漆桶填充 */

      borderWidth: (s.borderWidth || 0) * scaleUnit,
      points: (s.points || []).map(p => {
        const w = applyM(p);
        return { x: w.x, y: w.y, w: (p.w || 0) * scaleUnit };
      })
    }));

    /* eraser.size 在渲染时按"世界宽度"使用（drawMask 不参与局部缩放），故直接取世界值 */
    const erasers = (ink.eraser || []).map(er => ({
      z: (typeof er.z === 'number' ? er.z : 1e9),    /* 旧数据没有 z → 视作最后擦除 */
      size: er.size || 1,
      points: (er.points || []).map(p => {
        const w = applyM(p);
        return { x: w.x, y: w.y };
      })
    }));

    /* v7.9.3：区域填充的环也跟着 ink 一起做局部→世界变换，重绘编辑不会丢 */
    const fills = (ink.fills || []).map(f => ({
      id: f.id,
      color: f.color,
      loops: (f.loops || []).map(loop => loop.map(p => applyM(p)))
    }));

    return { strokes, erasers, fills };
  }

  /* brush-v5.1.0: 实现 §6.1.4 —— 打开重绘（旧笔迹回显 + 追加 + 局部擦除） */
  function openEdit(ink) {
    if (!ink || ink.type !== 'ink') return false;
    /* 元件可能已被删除（历史回滚 / 其他轨道） */
    const exists = D.getObjects().some(o => o && o.id === ink.id);
    if (!exists) { cancel(); return false; }

    const world = inkToWorld(ink);

    /* v6.2.0：直接沿用世界坐标，不再换算成屏幕坐标 —— 之后每次渲染按当前视图投影，
       所以编辑过程中缩放画布，旧笔迹会跟着一起缩放，不会和主画布错位。 */
    baseStrokes = world.strokes.map(s => ({
      z: s.z,                                        /* brush-v5.1.2: 保留原有落笔顺序 */
      color: s.color,
      borderColor: s.borderColor,
      borderWidth: s.borderWidth,
      outlineUnder: !!s.outlineUnder,                 /* v6.2.0: 描边铺底标记 */
      fill: s.fill,                                   /* v7.9.2: 油漆桶填充 */

      points: s.points.map(p => ({ x: p.x, y: p.y, w: p.w }))
    }));

    baseErasers = world.erasers.map(er => ({
      z: er.z,                                       /* brush-v5.1.2: 遮罩的擦除顺序 */
      size: er.size,
      points: er.points.map(p => ({ x: p.x, y: p.y }))
    }));
    baseFills = JSON.parse(JSON.stringify(world.fills || []));

    editingInk = ink;
    ops.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    syncOverlaySize();
    renderOverlay();
    refreshButtons();
    D.showToast(tr('brush.hintEdit', '正在重新编辑画笔元件：旧笔迹已载入，可用橡皮擦局部擦除'));
    D.EventBus.emit('need:render');
    return true;
  }

  /* 世界单位 → 屏幕长度（随视图缩放 / 摄像机视角变化） */
  function worldUnitScreenLen() {
    const a = D.worldToScreen({ x: 0, y: 0 });
    const b = D.worldToScreen({ x: 1, y: 0 });
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return d > 1e-6 ? d : 1;
  }

  /* ===== v6.2.0：世界 ⇄ 屏幕 =====
     overlay 铺满窗口（position:fixed; inset:0），主画布固定在左上角，
     所以 overlay 局部坐标和画布局部坐标是同一套，可以直接互转。 */
  function screenToWorldPt(p) {
    const w = D.screenToWorld(p.x, p.y);
    return { x: w.x, y: w.y };
  }

  /* 视图签名：世界→屏幕是仿射变换，原点和两个单位向量就能完整捕捉平移/缩放/旋转（含摄像机视角） */
  function viewSignature() {
    const o = D.worldToScreen({ x: 0, y: 0 });
    const ex = D.worldToScreen({ x: 1, y: 0 });
    const ey = D.worldToScreen({ x: 0, y: 1 });
    return o.x.toFixed(3) + ',' + o.y.toFixed(3) + ',' +
           ex.x.toFixed(3) + ',' + ex.y.toFixed(3) + ',' +
           ey.x.toFixed(3) + ',' + ey.y.toFixed(3);
  }

  /* 把一笔的世界点投影成屏幕点（带缓存：视图没变时只补新增点，避免每帧重算整笔） */
  function ensureProjected(s, sig, kv) {
    if (!s) return null;
    const pts = s.points || [];
    if (!s._spts || s._vs !== sig) {
      const out = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const sp = D.worldToScreen({ x: p.x, y: p.y });
        out[i] = { x: sp.x, y: sp.y, w: (p.w || 0) * kv };
      }
      s._spts = out;
      s._vs = sig;
      return out;
    }
    if (s._spts.length < pts.length) {
      for (let i = s._spts.length; i < pts.length; i++) {
        const p = pts[i];
        const sp = D.worldToScreen({ x: p.x, y: p.y });
        s._spts.push({ x: sp.x, y: sp.y, w: (p.w || 0) * kv });
      }
    } else if (s._spts.length > pts.length) {
      s._spts.length = pts.length;
    }
    return s._spts;
  }

  /* brush-v5.1.0: 实现 §7.1 —— 自动绑定（优先选中火柴人，否则最近关节点） */
  function pickTargetFigure(centerWorld) {
    const sel = D.getSelected();
    if (sel && sel.type === 'figure') return sel;
    const figs = D.getObjects().filter(o => o && o.type === 'figure');
    if (!figs.length) return null;
    let best = null, bestD = Infinity;
    for (const f of figs) {
      const d = Math.hypot((f.x || 0) - centerWorld.x, (f.y || 0) - centerWorld.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  /* 火柴人自身旋转/镜像（渲染时套在绑定对象外层） */
  function figRenderTransform(fig) {
    const tr = D.getBoundFigureTransform({ bindTo: 'head', targetId: fig.id, type: 'ink' });
    if (!tr) return null;
    return tr;
  }

  function toFigRenderSpace(fig, ftr, p) {
    if (!ftr) return p;
    const cx = fig.x || 0, cy = fig.y || 0;
    let dx = p.x - cx, dy = p.y - cy;
    if (ftr.rot) {
      const a = ftr.rot * Math.PI / 180;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = dx * c - dy * s, ny = dx * s + dy * c;
      dx = nx; dy = ny;
    }
    if (ftr.mirror) dx = -dx;
    return { x: cx + dx, y: cy + dy };
  }

  /* 12 个关节点里挑离 ink 中心最近的（用渲染后的世界坐标比较） */
  function pickMount(fig, centerWorld) {
    const j = D.jointData(fig);
    const pts = {
      head: j.headC, neck: j.neck, waist: j.waistPoint, pelvis: j.pelvis,
      handL: j.handL, handR: j.handR, elbowL: j.elbowL, elbowR: j.elbowR,
      footL: j.footL, footR: j.footR, kneeL: j.thighL, kneeR: j.thighR
    };
    const ftr = figRenderTransform(fig);
    let best = 'head', bestD = Infinity;
    for (const k in pts) {
      const p = toFigRenderSpace(fig, ftr, pts[k]);
      const d = Math.hypot(p.x - centerWorld.x, p.y - centerWorld.y);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /* brush-v5.1.0: 实现 §6.2.2 —— 世界笔迹 → ink 元件字段（含绑定反算） */
  /* worldStrokes: [{color,borderColor,borderWidth(世界),points:[{x,y,w(世界)}]}]
     worldErasers: [{size(世界),points:[{x,y}]}] */
  function buildFromWorld(worldStrokes, worldErasers, opts) {
    opts = opts || {};

    /* 1. 世界包围盒（含线宽与外扩边） */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of worldStrokes) {
      const bw = s.borderWidth || 0;
      const blobPad = s.type === 'blob' ? 1.5 : 1; /* 柳叶笔有机边缘可能比半宽略外扩 */
      for (const p of s.points) {
        const half = (Math.max(p.w || 0, 1) / 2 + bw) * blobPad;
        if (p.x - half < minX) minX = p.x - half;
        if (p.y - half < minY) minY = p.y - half;
        if (p.x + half > maxX) maxX = p.x + half;
        if (p.y + half > maxY) maxY = p.y + half;
      }
    }
    if (!isFinite(minX)) return null;
    if (maxX - minX < 1) { maxX = minX + 1; }
    if (maxY - minY < 1) { maxY = minY + 1; }

    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const boxW = maxX - minX, boxH = maxY - minY;

    /* 2. 绑定目标：重绘时沿用原绑定（避免每次编辑都跳到别的关节），新建时自动挑选 */
    let fig = null, bindTo = 'none';
    if (opts.keepBind && opts.keepBind.bindTo && opts.keepBind.bindTo !== 'none' && opts.keepBind.targetId) {
      fig = D.findFigureById(opts.keepBind.targetId);
      if (fig) bindTo = opts.keepBind.bindTo;
    }
    if (!fig) {
      fig = pickTargetFigure(center);
      if (fig) bindTo = pickMount(fig, center);
    }
    if (opts.forceNoBind) { fig = null; bindTo = 'none'; }

    /* 3. 无火柴人 → 直接按世界坐标存（不绑定） */
    if (!fig || bindTo === 'none') {
      return {
        x: center.x, y: center.y, w: boxW, h: boxH,
        bindTo: 'none', targetId: null, offX: 0, offY: 0, rot: 0,
        strokes: worldStrokes.map(s => ({
          z: s.z,                                  /* brush-v5.1.2: 落笔顺序（不绑定分支） */
          type: s.type === 'blob' ? 'blob' : (s.type === 'crayon' || s.type === 'start') ? 'crayon' : 'default',
          blobSeed: (typeof s.blobSeed === 'number' ? s.blobSeed : 0),
          color: s.color,
          borderColor: s.borderColor,
          borderWidth: s.borderWidth || 0,
          outlineUnder: !!s.outlineUnder,           /* v6.2.0: 描边铺底标记 */
          fill: s.fill,                             /* v7.9.2: 油漆桶填充 */

          points: s.points.map(p => ({ x: p.x - center.x, y: p.y - center.y, w: p.w }))
        })),
        eraser: worldErasers.map(er => ({
          z: er.z,                               /* brush-v5.1.2: 擦除顺序（不绑定分支） */
          size: er.size,
          points: er.points.map(p => ({ x: p.x - center.x, y: p.y - center.y }))
        })),
        fills: (opts.fills || []).map(f => ({
          id: f.id, color: f.color,
          loops: (f.loops || []).map(loop => loop.map(p => ({ x: p.x - center.x, y: p.y - center.y })))
        }))
      };
    }

    /* 4. 挂载点基准（未套用火柴人旋转/镜像的坐标） */
    const base = D.getBindBase({ bindTo: bindTo, targetId: fig.id, type: 'ink' });
    if (!base) {
      return buildFromWorld(worldStrokes, worldErasers, { forceNoBind: true });
    }
    const g = (base.scale || fig.scale || 1) || 1;
    const ba = base.angle || 0;

    /* 5. 火柴人渲染变换 T(p)=c+R(S(p-c))，求逆把"画面上看到的点"还原到火柴人自身坐标系 */
    const ftr = figRenderTransform(fig);
    const cx = fig.x || 0, cy = fig.y || 0;
    const rotRad = (ftr && ftr.rot ? ftr.rot : 0) * Math.PI / 180;
    const mir = !!(ftr && ftr.mirror);
    const invT = (p) => {
      let dx = p.x - cx, dy = p.y - cy;
      if (rotRad) {
        const c = Math.cos(-rotRad), s = Math.sin(-rotRad);
        const nx = dx * c - dy * s, ny = dx * s + dy * c;
        dx = nx; dy = ny;
      }
      if (mir) dx = -dx;
      return { x: cx + dx, y: cy + dy };
    };

    /* 6. 以"逆变换后的中心"作为 ink 的局部原点，保证绑定后世界位置不偏移 */
    const cInv = invT(center);
    const localOf = (p) => {
      const q = invT(p);
      let lx = (q.x - cInv.x) / g;
      const ly = (q.y - cInv.y) / g;
      return { x: lx, y: ly };
    };

    const strokes = worldStrokes.map(s => ({
      z: s.z,                                    /* brush-v5.1.2: 落笔顺序 */
      type: s.type === 'blob' ? 'blob' : (s.type === 'crayon' || s.type === 'start') ? 'crayon' : 'default',
      blobSeed: (typeof s.blobSeed === 'number' ? s.blobSeed : 0),
      color: s.color,
      borderColor: s.borderColor,
      borderWidth: (s.borderWidth || 0) / g,
      outlineUnder: !!s.outlineUnder,             /* v6.2.0: 描边铺底标记 */
      fill: s.fill,                               /* v7.9.2: 油漆桶填充 */

      points: s.points.map(p => {
        const l = localOf(p);
        return { x: l.x, y: l.y, w: (p.w || 0) / g };
      })
    }));

    const eraser = worldErasers.map(er => ({
      z: er.z,                                   /* brush-v5.1.2: 擦除顺序 */
      /* 遮罩宽度按世界单位绘制（drawMask 不做局部缩放） */
      size: er.size,
      points: er.points.map(p => localOf(p))
    }));

    const fills = (opts.fills || []).map(f => ({
      id: f.id, color: f.color,
      loops: (f.loops || []).map(loop => loop.map(p => localOf(p)))
    }));

    /* 7. 反算 offX/offY：使 getBindTransform(ink) 落在 cInv 上 */
    const dx = cInv.x - base.x, dy = cInv.y - base.y;
    const cs = Math.cos(-ba), sn = Math.sin(-ba);
    const offX = (dx * cs - dy * sn) / g;
    const offY = (dx * sn + dy * cs) / g;

    /* 8. rot 抵消挂载角度 → 绑定后笔迹方向与"画的时候"完全一致 */
    const rotDeg = -ba * 180 / Math.PI;

    return {
      x: center.x, y: center.y, w: boxW / g, h: boxH / g,
      bindTo: bindTo, targetId: fig.id, offX: offX, offY: offY, rot: rotDeg,
      strokes: strokes,
      eraser: eraser,
      fills: fills
    };
  }

  /* 给已有 ink 重新计算绑定（保持世界外观不变） */
  function autoBind(ink) {
    if (!ink || ink.type !== 'ink') return false;
    const world = inkToWorld(ink);
    const built = buildFromWorld(world.strokes, world.erasers, { keepBind: null, fills: world.fills });
    if (!built) return false;
    applyBuilt(ink, built);
    D.EventBus.emit('need:render');
    return true;
  }

  function applyBuilt(ink, built) {
    ink.x = built.x;
    ink.y = built.y;
    ink.w = built.w;
    ink.h = built.h;
    ink.rot = built.rot;
    ink.bindTo = built.bindTo;
    ink.targetId = built.targetId;
    ink.offX = built.offX;
    ink.offY = built.offY;
    ink.strokes = built.strokes;
    ink.eraser = built.eraser;
    ink.fills = built.fills || [];
  }

  /* brush-v5.1.1: 点到线段距离（屏幕/世界同一套算法） */
  function distPointSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 1e-9) t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
  }

  /* v7.9.2：闭合判定。判据与 QuickShape 的 qsAnalyze 完全一致：
     首尾弦长小于路径总长的 30%，且总长大于包围盒对角线的 1.55 倍。
     缩放无关，局部坐标 / 世界坐标都能直接用。 */
  function isStrokeClosed(pts) {
    if (!pts || pts.length < 4) return false;
    let L = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i) L += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const diag = Math.max(1e-6, Math.hypot(maxX - minX, maxY - minY));
    const p0 = pts[0], p1 = pts[pts.length - 1];
    const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    return chord < L * 0.30 && L > diag * 1.55;
  }

  /* v7.9.2：把填充写进指定笔画，并只落一次历史 */
  function commitFill(ink, indexes) {
    let n = 0;
    ink.strokes = (ink.strokes || []).map((s, i) => {
      if (indexes.indexOf(i) < 0 || !s || !isStrokeClosed(s.points)) return s;
      n++;
      const copy = Object.assign({}, s);
      copy.fill = { color: cfg.color };
      return copy;
    });
    if (!n) return false;
    D.setGlobalProp(ink, 'strokes', JSON.parse(JSON.stringify(ink.strokes)));
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.EventBus.emit('history:save', tr('brush.bucket', '油漆桶填充'));
    D.showToast(tr('brush.bucketDone', '已填充 %n 条闭合笔画').replace('%n', String(n)), 'ink', 2200);
    return true;
  }

  /* v7.9.3：区域级油漆桶。
     判定单位从「整条笔画」改成「点击点所在的封闭连通区域」。
     做法：在 ink 局部坐标离屏画一张边界 mask → 从点击点 flood fill →
     如果连通区碰到 mask 边缘就说明没闭合，拒绝；否则把该连通区描成多边形存进 ink.fills。 */

  /* 点是否落在已存填充的环内（多环用 evenodd，天然支持洞） */
  function pointInFillLoops(loops, x, y) {
    if (!loops || !loops.length) return false;
    let inside = false;
    for (const loop of loops) {
      if (!loop || loop.length < 3) continue;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const a = loop[i], b = loop[j];
        if (((a.y > y) !== (b.y > y)) &&
            (x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
      }
    }
    return inside;
  }

  function loopArea(loop) {
    let s = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      s += (loop[j].x + loop[i].x) * (loop[j].y - loop[i].y);
    }
    return s / 2;
  }

  /* Ramer-Douglas-Peucker：把像素描出来的密点压成可存的矢量环 */
  function rdpSimplify(points, tol) {
    if (!points || points.length <= 2) return (points || []).slice();
    const first = points[0], last = points[points.length - 1];
    const dx = last.x - first.x, dy = last.y - first.y;
    const den = Math.hypot(dx, dy);
    let maxD = -1, idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const d = den < 1e-9
        ? Math.hypot(p.x - first.x, p.y - first.y)
        : Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / den;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD <= tol) return [first, last];
    const a = rdpSimplify(points.slice(0, idx + 1), tol);
    const b = rdpSimplify(points.slice(idx), tol);
    return a.slice(0, -1).concat(b);
  }

  function simplifyLoop(pts, tol) {
    if (!pts || pts.length < 5) return pts || [];
    const seq = pts.concat([pts[0]]);
    const out = rdpSimplify(seq, tol);
    if (out.length > 1 &&
        Math.abs(out[0].x - out[out.length - 1].x) < 1e-6 &&
        Math.abs(out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
    return out.length >= 3 ? out : pts;
  }

  /* 把连通区向外扩几像素，让矢量填充钻到笔画下面，消除白缝。
     只在 mask 像素上做，不改变“是否闭合”的判定（判定用的是扩张前的 region）。 */
  function dilateRegion(region, w, h, iterations) {
    let cur = region;
    for (let k = 0; k < iterations; k++) {
      const next = new Uint8Array(cur.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (!cur[idx]) continue;
          next[idx] = 1;
          if (x > 0) next[idx - 1] = 1;
          if (x < w - 1) next[idx + 1] = 1;
          if (y > 0) next[idx - w] = 1;
          if (y < h - 1) next[idx + w] = 1;
          if (x > 0 && y > 0) next[idx - w - 1] = 1;
          if (x < w - 1 && y > 0) next[idx - w + 1] = 1;
          if (x > 0 && y < h - 1) next[idx + w - 1] = 1;
          if (x < w - 1 && y < h - 1) next[idx + w + 1] = 1;
        }
      }
      cur = next;
    }
    return cur;
  }

  /* 两条线段的最短距离：相交为 0，端点互相投影也能算出相接距离 */
  function segSegDistance(a, b, c, d) {
    return Math.min(
      distPointSeg(a, c, d), distPointSeg(b, c, d),
      distPointSeg(c, a, b), distPointSeg(d, a, b)
    );
  }

  function distToPolyline(p, pts) {
    if (!pts || !pts.length) return Infinity;
    if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      best = Math.min(best, distPointSeg(p, pts[i - 1], pts[i]));
    }
    return best;
  }

  /* 把当前帧所有可编辑笔迹摊平成世界坐标节点；不再区分 ink 元件层级 */
  function buildStrokeNodes() {
    const objs = (D.getObjects && D.getObjects()) || [];
    const nodes = [];
    if (!D.getInkLocalMatrix) return nodes;
    for (const ink of objs) {
      if (!ink || ink.type !== 'ink' || ink.locked || !ink.strokes) continue;
      const M = D.getInkLocalMatrix(ink);
      if (!M) continue;
      const apply = (p) => ({ x: M.a * p.x + M.c * p.y + M.e, y: M.b * p.x + M.d * p.y + M.f });
      const o = apply({ x: 0, y: 0 }), u = apply({ x: 1, y: 0 });
      const scaleUnit = Math.hypot(u.x - o.x, u.y - o.y) || 1;

      for (let si = 0; si < ink.strokes.length; si++) {
        const s = ink.strokes[si];
        const raw = (s && s.points) || [];
        if (!raw.length) continue;
        let maxHalf = 0;
        const pts = raw.map(p => {
          const half = ((p.w || 0) / 2 + (s.borderWidth || 0)) * scaleUnit;
          maxHalf = Math.max(maxHalf, half);
          const q = apply(p);
          return { x: q.x, y: q.y, half };
        });
        /* 柳叶笔按真实填充多边形判定点击，而不是只看中心点连线 */
        let loop = null;
        if (s.type === 'blob' && SKFE.core.geometry && SKFE.core.geometry.blobLoopFromPoints) {
          const localLoop = SKFE.core.geometry.blobLoopFromPoints(raw, s.blobSeed || 0);
          if (localLoop.length >= 3) loop = localLoop.map(apply);
        }
        const bboxPts = loop || pts;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of bboxPts) {
          const half = loop ? 1 : (p.half || 0);
          minX = Math.min(minX, p.x - half); maxX = Math.max(maxX, p.x + half);
          minY = Math.min(minY, p.y - half); maxY = Math.max(maxY, p.y + half);
        }
        nodes.push({ ink, si, pts, loop, maxHalf, minX, minY, maxX, maxY });
      }
    }
    return nodes;
  }

  /* 找到点击命中的笔迹，并把所有与它相交/接触（含跨元件）的笔迹作为一个连通分量返回 */
  function findConnectedStrokeGroup(wp) {
    const nodes = buildStrokeNodes();
    if (!nodes.length || !wp) return null;

    let hit = -1, best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = distToPolyline(wp, nodes[i].pts);
      const inBlob = !!(nodes[i].loop && pointInFillLoops([nodes[i].loop], wp.x, wp.y));
      if ((inBlob || d <= nodes[i].maxHalf + 2) && (inBlob ? 0 : d) < best) {
        hit = i;
        best = inBlob ? 0 : d;
      }
    }
    if (hit < 0) return null;

    const parent = nodes.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const A = nodes[i], B = nodes[j];
        const touchDist = A.maxHalf + B.maxHalf + 1;
        if (A.maxX + 1 < B.minX || B.maxX + 1 < A.minX ||
            A.maxY + 1 < B.minY || B.maxY + 1 < A.minY) continue;
        let touch = false;
        for (let ai = 1; ai < A.pts.length && !touch; ai++) {
          for (let bj = 1; bj < B.pts.length; bj++) {
            if (segSegDistance(A.pts[ai - 1], A.pts[ai], B.pts[bj - 1], B.pts[bj]) <= touchDist) {
              touch = true; break;
            }
          }
        }
        if (!touch && A.pts.length === 1) touch = distToPolyline(A.pts[0], B.pts) <= touchDist;
        if (!touch && B.pts.length === 1) touch = distToPolyline(B.pts[0], A.pts) <= touchDist;
        if (touch) union(i, j);
      }
    }

    const root = find(hit);
    const groups = new Map();
    for (let i = 0; i < nodes.length; i++) {
      if (find(i) !== root) continue;
      const ink = nodes[i].ink;
      let g = groups.get(ink.id);
      if (!g) { g = { ink, indexes: [] }; groups.set(ink.id, g); }
      g.indexes.push(nodes[i].si);
    }
    return Array.from(groups.values());
  }

  /* 把区域 mask 的像素边界描成闭合环；evenodd 渲染时环方向无所谓 */
  function traceRegionLoops(region, w, h) {
    const edges = new Map();
    const k = (x, y) => x + ',' + y;
    const add = (x1, y1, x2, y2) => {
      const key = k(x1, y1);
      let arr = edges.get(key);
      if (!arr) { arr = []; edges.set(key, arr); }
      arr.push({ x: x2, y: y2 });
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!region[idx]) continue;
        if (y === 0 || !region[idx - w]) add(x, y, x + 1, y);
        if (x === w - 1 || !region[idx + 1]) add(x + 1, y, x + 1, y + 1);
        if (y === h - 1 || !region[idx + w]) add(x + 1, y + 1, x, y + 1);
        if (x === 0 || !region[idx - 1]) add(x, y + 1, x, y);
      }
    }
    const loops = [];
    while (edges.size) {
      const firstKey = edges.keys().next().value;
      const start = firstKey.split(',').map(Number);
      let cur = { x: start[0], y: start[1] };
      const loop = [];
      let guard = 0;
      while (guard++ < 200000) {
        const key = k(cur.x, cur.y);
        const arr = edges.get(key);
        if (!arr || !arr.length) break;
        const next = arr.shift();
        if (!arr.length) edges.delete(key);
        loop.push({ x: cur.x, y: cur.y });
        cur = next;
        if (cur.x === start[0] && cur.y === start[1]) break;
      }
      if (loop.length >= 4) loops.push(loop);
    }
    return loops;
  }

  /* 在 ink 局部坐标里算出点击点所在区域；返回可存储的环数组，或 null 表示开放区域 */
  function buildRegionFill(ink, lx, ly) {
    const strokes = (ink && ink.strokes) || [];
    if (!strokes.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      const pts = (s && s.points) || [];
      if (pts.length < 2) continue;
      const bw = s.borderWidth || 0;
      for (const p of pts) {
        const half = (p.w || 0) / 2 + bw;
        if (p.x - half < minX) minX = p.x - half;
        if (p.y - half < minY) minY = p.y - half;
        if (p.x + half > maxX) maxX = p.x + half;
        if (p.y + half > maxY) maxY = p.y + half;
      }
    }
    if (!isFinite(minX)) return null;

    const pad = Math.max(6, Math.min(60, Math.max(maxX - minX, maxY - minY) * 0.08));
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const spanW = Math.max(1, maxX - minX), spanH = Math.max(1, maxY - minY);
    let rs = 2;
    if (spanW * rs > 2048 || spanH * rs > 2048) {
      rs = Math.max(0.25, Math.min(2048 / spanW, 2048 / spanH));
    }
    const cw = Math.max(4, Math.ceil(spanW * rs));
    const ch = Math.max(4, Math.ceil(spanH * rs));

    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.setTransform(rs, 0, 0, rs, -minX * rs, -minY * rs);
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    c.lineCap = 'round';
    c.lineJoin = 'round';

    for (const s of strokes) {
      const pts = (s && s.points) || [];
      if (pts.length < 2) continue;
      if (s.type === 'blob' && SKFE.core.geometry && SKFE.core.geometry.blobLoopFromPoints) {
        const loop = SKFE.core.geometry.blobLoopFromPoints(pts, s.blobSeed || 0);
        if (loop.length >= 3) {
          c.beginPath();
          c.moveTo(loop[0].x, loop[0].y);
          for (let i = 1; i < loop.length; i++) c.lineTo(loop[i].x, loop[i].y);
          c.closePath();
          c.fill();
          continue;
        }
      }
      let lw = 0;
      for (const p of pts) lw = Math.max(lw, (p.w || 0) + 2 * (s.borderWidth || 0));
      c.lineWidth = Math.max(1.5 / rs, lw + 1 / rs);
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.stroke();
    }

    /* 橡皮也算边界：被擦开的地方不能当成可填的封闭面 */
    const M = D.getInkLocalMatrix ? D.getInkLocalMatrix(ink) : null;
    let scaleUnit = 1;
    if (M) {
      const o = { x: M.a * 0 + M.c * 0 + M.e, y: M.b * 0 + M.d * 0 + M.f };
      const u = { x: M.a * 1 + M.c * 0 + M.e, y: M.b * 1 + M.d * 0 + M.f };
      scaleUnit = Math.hypot(u.x - o.x, u.y - o.y) || 1;
    }
    for (const er of (ink.eraser || [])) {
      const pts = (er && er.points) || [];
      if (!pts.length) continue;
      c.lineWidth = Math.max(2 / rs, (er.size || 1) / scaleUnit + 1 / rs);
      if (pts.length === 1) {
        c.beginPath();
        c.arc(pts[0].x, pts[0].y, c.lineWidth / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.stroke();
      }
    }

    const data = c.getImageData(0, 0, cw, ch).data;
    const total = cw * ch;
    const boundary = new Uint8Array(total);
    for (let i = 0; i < total; i++) boundary[i] = data[i * 4 + 3] > 8 ? 1 : 0;

    const sx = Math.floor((lx - minX) * rs), sy = Math.floor((ly - minY) * rs);
    if (sx < 0 || sy < 0 || sx >= cw || sy >= ch) return null;
    const start = sy * cw + sx;
    if (boundary[start]) return null;

    const region = new Uint8Array(total);
    const stack = [start];
    region[start] = 1;
    let open = false, count = 0;
    while (stack.length) {
      const idx = stack.pop();
      count++;
      const x = idx % cw, y = (idx / cw) | 0;
      if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) { open = true; break; }
      const nb = [];
      if (x > 0) nb.push(idx - 1);
      if (x < cw - 1) nb.push(idx + 1);
      if (y > 0) nb.push(idx - cw);
      if (y < ch - 1) nb.push(idx + cw);
      for (const ni of nb) {
        if (!region[ni] && !boundary[ni]) { region[ni] = 1; stack.push(ni); }
      }
    }
    if (open || count < 4) return null;

    /* 闭合判定用原始 region；描环前把区域向外扩一点，让填充压到笔画下面，消除白缝 */
    const grow = Math.min(4, Math.max(2, Math.round(1.5 * rs)));
    const grown = dilateRegion(region, cw, ch, grow);
    const loops = [];
    for (const raw of traceRegionLoops(grown, cw, ch)) {
      const pts = raw.map(v => ({ x: minX + v.x / rs, y: minY + v.y / rs }));
      const simp = simplifyLoop(pts, 0.6 / rs);
      if (simp.length >= 3 && Math.abs(loopArea(simp)) > 2) loops.push(simp);
    }
    return loops.length ? loops : null;
  }

  /* 改一整条连续笔迹的颜色（Live Paint 的「给边上色」语义） */
  function recolorStrokeGroup(groups, color) {
    let n = 0;
    for (const g of groups || []) {
      const strokes = JSON.parse(JSON.stringify((g.ink.strokes || [])));
      for (const i of g.indexes) {
        const s = strokes[i];
        if (!s) continue;
        s.color = color;
        /* 描边和笔芯一起换色，否则黑色外框会盖住新颜色，看起来像没改 */
        s.borderColor = color;
        n++;
      }
      g.ink.strokes = strokes;
      D.setGlobalProp(g.ink, 'strokes', JSON.parse(JSON.stringify(strokes)));
    }
    if (!n) return false;
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.EventBus.emit('history:save', tr('brush.bucketStroke', '笔迹改色'));
    D.showToast(tr('brush.bucketStrokeDone', '已将 %n 条相连笔迹改为当前画笔颜色').replace('%n', String(n)), 'ink', 2200);
    return true;
  }

  /* 写入 / 改色一个区域填充，只落一次历史 */
  function commitRegionFill(ink, index, color, loops) {
    const fills = (ink.fills || []).map(f => JSON.parse(JSON.stringify(f)));
    if (index >= 0 && fills[index]) {
      fills[index].color = color;
    } else {
      fills.push({
        id: 'fill-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        color: color,
        loops: JSON.parse(JSON.stringify(loops || []))
      });
    }
    ink.fills = fills;
    D.setGlobalProp(ink, 'fills', JSON.parse(JSON.stringify(fills)));

    /* 新模型不再用 stroke.fill；顺手清掉旧版本留下的整笔填充，避免叠色 */
    if ((ink.strokes || []).some(s => s && s.fill)) {
      const cleared = (ink.strokes || []).map(s => {
        if (!s || !s.fill) return s;
        const copy = Object.assign({}, s);
        delete copy.fill;
        return copy;
      });
      ink.strokes = cleared;
      D.setGlobalProp(ink, 'strokes', JSON.parse(JSON.stringify(cleared)));
    }
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.EventBus.emit('history:save', tr('brush.bucket', '油漆桶填充'));
    D.showToast(tr('brush.bucketDone', '已填充 1 个闭合区域'), 'ink', 2200);
    return true;
  }

  /* v7.9.3：油漆桶主交互 —— 点画布，填 / 改点击点所在的封闭连通区域 */
  function bucketFillAt(clientX, clientY) {
    if (!D.screenToWorld || !D.getObjects || !D.getInkLocalMatrix) return;
    const wp = D.screenToWorld(clientX, clientY);
    if (!wp) return;
    const objs = D.getObjects() || [];

    /* 先跨元件判笔迹连通分量：相交 / 接触的笔迹视为一个整体，一起改色 */
    const strokeGroup = findConnectedStrokeGroup(wp);
    if (strokeGroup) { recolorStrokeGroup(strokeGroup, cfg.color); return; }

    for (let oi = objs.length - 1; oi >= 0; oi--) {
      const ink = objs[oi];
      if (!ink || ink.type !== 'ink' || ink.locked || !ink.strokes) continue;
      const M = D.getInkLocalMatrix(ink);
      if (!M) continue;
      const det = M.a * M.d - M.b * M.c;
      if (!isFinite(det) || Math.abs(det) < 1e-9) continue;
      const dx = wp.x - M.e, dy = wp.y - M.f;
      const lx = (M.d * dx - M.c * dy) / det;
      const ly = (-M.b * dx + M.a * dy) / det;

      /* 已填区域：再点一次只改这一块；同时用当前扩张算法重算环，顺手修掉旧白缝 */
      const fills = ink.fills || [];
      for (let fi = fills.length - 1; fi >= 0; fi--) {
        const f = fills[fi];
        if (f && f.loops && pointInFillLoops(f.loops, lx, ly)) {
          const refreshed = buildRegionFill(ink, lx, ly);
          commitRegionFill(ink, fi, cfg.color, refreshed || f.loops);
          return;
        }
      }

      const loops = buildRegionFill(ink, lx, ly);
      if (loops) { commitRegionFill(ink, -1, cfg.color, loops); return; }
    }
    D.showToast(tr('brush.bucketRegionFail', '这里不是闭合区域，无法填充'));
  }

  /* v7.9.2：保留 API —— 直接填充选中元件的全部闭合笔画 */
  function bucketFill() {
    const sel = D.getSelected && D.getSelected();
    if (!sel || sel.type !== 'ink') {
      D.showToast(tr('brush.bucketNoSel', '请先选中一个画笔元件，再使用油漆桶'));
      return;
    }
    if (sel.locked) {
      D.showToast(tr('brush.locked', '该画笔元件已锁定，请先解锁'));
      return;
    }
    const indexes = [];
    (sel.strokes || []).forEach((s, i) => { if (isStrokeClosed(s && s.points)) indexes.push(i); });
    if (!indexes.length) {
      D.showToast(tr('brush.bucketNoClosed', '没有可填充的闭合笔画，非闭合笔画禁止填充'));
      return;
    }
    commitFill(sel, indexes);
  }

  /* v7.9.2：面板按钮切换油漆桶模式；开启时先确定当前画笔会话 */
  function setBucketMode(on, silent) {
    on = !!on;
    if (on === bucketMode) return;
    if (on && brushOn) { finalize(); setOn(false); }
    bucketMode = on;
    document.body.classList.toggle('bucket-mode', bucketMode);
    const btn = document.getElementById('btnBrushBucket');
    if (btn) btn.classList.toggle('on', bucketMode);
    if (!silent) {
      D.showToast(tr(bucketMode ? 'brush.bucketOn' : 'brush.bucketOff',
        bucketMode ? '油漆桶已开启：点击闭合图形内部填充，再点按钮关闭' : '油漆桶已关闭'));
    }
    D.EventBus.emit('need:render');
  }
  function toggleBucketMode() { setBucketMode(!bucketMode); }

  /* brush-v5.1.1: 把一段擦除遮罩裁剪到"已有笔迹的覆盖范围"内。
     只留下真正压到笔迹的点（边缘少量外扩保留，保证擦边效果不变），
     空白处的点直接丢弃；并按连续性切段，避免远点连成一条直线误擦。 */
  function clipEraseToStrokes(er, strokes, kv) {
    const pts = (er && er.points) || [];
    if (!pts.length) return [];
    /* v6.2.0：数据是世界坐标，1.5px 的余量要换算成世界长度 */
    const reach = Math.max(1, er.size || 1) / 2 + 1.5 / (kv || 1);
    const segs = [];
    for (const s of strokes) {
      const sp = s.points || [];
      if (!sp.length) continue;
      const bw = (s.borderWidth || 0) / 2;
      for (let i = 0; i < sp.length; i++) {
        const a = sp[i], b = sp[Math.min(i + 1, sp.length - 1)];
        segs.push({ a, b, hw: Math.max(a.w || 0, b.w || 0) / 2 + bw });
      }
    }
    if (!segs.length) return [];
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push({ size: er.size, points: run }); run = []; } };
    for (const p of pts) {
      let hit = false;
      for (const sg of segs) {
        if (distPointSeg(p, sg.a, sg.b) - sg.hw <= reach) { hit = true; break; }
      }
      if (hit) run.push(p);
      else flush();
    }
    flush();
    return out;
  }

  /* brush-v5.1.0: 实现 §6.1.12 —— 退出（确定写入元件 / 取消丢弃） */
  function finalize() {
    /* 未收尾的当前笔画先提交，避免"最后一下"被丢掉 */
    if (current) finishCurrentStroke();
    /* 视图缩放系数：只用于把像素级容差换算成世界长度，不再参与笔宽换算 */
    const kvFinal = worldUnitScreenLen();
    /* 1. 按时间顺序收集笔迹 / 擦除（世界坐标）
       brush-v5.1.1: 擦除遮罩只保留"真正擦到已有笔迹"的部分 —— 空白处不留罩。
       brush-v5.1.2: 每个笔迹与每段遮罩都带一个落笔序号 z，渲染时按 z 依次落笔，
       擦除只会吃掉"它之前"的笔迹，所以"先擦除、再画上去"的新笔迹不会再被旧遮罩擦掉。 */
    const seq = [];                 /* 有序：{kind:'stroke'|'erase', data, z} */
    const allStrokes = [];          /* 供裁剪使用：此刻已存在的笔迹 */
    let zNext = 0;

    /* 进入编辑时已有的内容，先按它们自己的 z 复位（旧数据：笔迹 0，遮罩最后） */
    const baseItems = [];
    for (const s of baseStrokes) baseItems.push({ kind: 'stroke', data: s, z: (typeof s.z === 'number' ? s.z : 0) });
    for (const er of baseErasers) baseItems.push({ kind: 'erase', data: er, z: (typeof er.z === 'number' ? er.z : 1e9) });
    baseItems.sort((a, b) => a.z - b.z);

    for (const it of baseItems) {
      if (it.kind === 'stroke') {
        allStrokes.push(it.data);
        seq.push({ kind: 'stroke', data: it.data, z: zNext++ });
      } else {
        /* 旧遮罩按"进入时的笔迹"复核一次，顺手清理历史数据里落在空白处的罩 */
        for (const run of clipEraseToStrokes(it.data, allStrokes, kvFinal)) seq.push({ kind: 'erase', data: run, z: zNext++ });
      }
    }
    for (const op of ops) {
      if (op.type === 'stroke') {
        allStrokes.push(op.data);
        seq.push({ kind: 'stroke', data: op.data, z: zNext++ });
      } else if (op.type === 'erase') {
        for (const run of clipEraseToStrokes(op.data, allStrokes, kvFinal)) seq.push({ kind: 'erase', data: run, z: zNext++ });
      }
    }
    const orderedStrokes = seq.filter(it => it.kind === 'stroke');
    if (!orderedStrokes.length) { cancel(); return; }

    /* 2. 数据本来就是世界坐标（v6.2.0），这里只做纯拷贝 + 补 z / 描边铺底标记 */
    const worldStrokes = orderedStrokes.map(it => {
      const s = it.data;
      return {
        z: it.z,
        color: s.color,
        borderColor: s.borderColor || null,
        borderWidth: s.borderWidth || 0,
        outlineUnder: !!s.outlineUnder,
        fill: s.fill,                                 /* v7.9.2: 油漆桶填充 */
        points: s.points.map(p => {
          return { x: p.x, y: p.y, w: (p.w || 0) };
        })
      };
    });
    const worldErasers = seq.filter(it => it.kind === 'erase').map(it => {
      const er = it.data;
      return {
        z: it.z,
        size: er.size || 1,
        points: er.points.map(p => ({ x: p.x, y: p.y }))
      };
    });

    /* 3. 决定绑定并生成局部数据 */
    const keepBind = editingInk
      ? { bindTo: editingInk.bindTo, targetId: editingInk.targetId }
      : null;
    const built = buildFromWorld(worldStrokes, worldErasers, { keepBind: keepBind, fills: baseFills });
    if (!built) { cancel(); return; }

    if (editingInk) {
      /* 4a. 更新已有元件 */
      const ink = editingInk;
      applyBuilt(ink, built);
      /* 全局属性联动（globalEditEnabled 时同步所有帧） */
      D.setGlobalProp(ink, 'strokes', JSON.parse(JSON.stringify(built.strokes)));
      D.setGlobalProp(ink, 'eraser', JSON.parse(JSON.stringify(built.eraser)));
      D.setGlobalProp(ink, 'fills', JSON.parse(JSON.stringify(built.fills || [])));
      D.setGlobalProp(ink, 'x', ink.x);
      D.setGlobalProp(ink, 'y', ink.y);
      D.setGlobalProp(ink, 'w', ink.w);
      D.setGlobalProp(ink, 'h', ink.h);
      D.setGlobalProp(ink, 'rot', ink.rot);
      D.setGlobalProp(ink, 'bindTo', ink.bindTo);
      D.setGlobalProp(ink, 'targetId', ink.targetId);
      D.setGlobalProp(ink, 'offX', ink.offX);
      D.setGlobalProp(ink, 'offY', ink.offY);
      D.markCurrentFrameModified();
      D.invalidateAllFrameThumbs();
      /* 记录"修改后"的快照，保证 Ctrl+Z / Ctrl+Y 都能正确回退与重做 */
      D.EventBus.emit('history:save', '更新画笔元件');
      resetSession();
      D.refreshUI();
      D.EventBus.emit('need:render');
      /* v6.3.0：确认后像坐标浮窗那样提示绑定对象与挂载点，几秒后自动消失 */
      D.showToast(bindSummary(tr('brush.toastUpdate', '画笔元件已更新'), ink), 'ink', 2600);
      return;
    }

    /* 4b. 新建元件 */
    const ink = {
      id: D.nextUid(),
      type: 'ink',
      name: D.generateName('ink'),
      x: built.x, y: built.y,
      w: built.w, h: built.h,
      scale: 1, rot: built.rot, alpha: 1,
      layer: 10,
      locked: false, mirror: false,
      ax: 0, ay: 0,
      bindTo: built.bindTo, targetId: built.targetId,
      offX: built.offX, offY: built.offY,
      strokes: built.strokes,
      eraser: built.eraser,
      fills: built.fills || []
    };
    D.addObjectToFrames(ink);
    /* 先结束会话，避免 queueInk 把新元件当作"编辑中"跳过 */
    const prevSel = _prevSelected;
    resetSession();
    D.select(ink);
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.EventBus.emit('history:save', '新建画笔元件');
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.showToast(bindSummary(tr('brush.toastConfirm', '已生成画笔元件'), ink), 'ink', 2600);
    _prevSelected = prevSel;
  }

  /* v6.3.0：画笔元件确认后的提示文案 —— 「已生成画笔元件 ｜ 绑定：火柴人1 · 左手」。
     挂载点的中文名直接取绑定下拉框里那一项的文字，天然跟随语言切换。 */
  function bindSummary(head, ink) {
    if (!ink || !ink.bindTo || ink.bindTo === 'none' || !ink.targetId) {
      return head + ' ｜ ' + tr('brush.toastNoBind', '未绑定（画布上没有火柴人）');
    }
    let figName = '';
    try {
      const fig = D.findFigureById && D.findFigureById(ink.targetId);
      if (fig && fig.name) figName = fig.name;
    } catch (_) {}
    let anchor = ink.bindTo;
    try {
      const sel = document.getElementById('accBind');
      const opt = sel && sel.querySelector('option[value="' + ink.bindTo + '"]');
      if (opt && opt.textContent) anchor = opt.textContent.trim();
    } catch (_) {}
    return head + ' ｜ ' + tr('brush.toastBindTo', '已绑定') + '：' +
      (figName ? figName + ' · ' : '') + anchor;
  }

  function resetSession() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = 0; }
    pointers.clear(); pinchLastDist = 0; pinchLastMid = null;   /* v6.2.0：清掉多指状态，避免下次进画笔还停在缩放态 */
    resetQuickShape(); lastMoveAt = 0;
    editingInk = null;
    baseStrokes.length = 0;
    baseErasers.length = 0;
    baseFills.length = 0;
    ops.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    clearOverlay();
    refreshButtons();
  }

  function cancel() {
    const had = !!editingInk || ops.length > 0 || baseStrokes.length > 0 || baseErasers.length > 0 || baseFills.length > 0 || !!current;
    resetSession();
    /* 未确定就退出 → 恢复进入前的选中状态（已确定时 had 为 false，不动选中） */
    if (had && _prevSelected) {
      const p = _prevSelected;
      _prevSelected = null;
      try { D.select(p); } catch (_) {}
    }
    D.EventBus.emit('need:render');
  }

  /* brush-v5.1.0: 实现 §6.1.9 —— Overlay 重绘（旧笔迹 + 本次操作 + 当前笔画） */
  function clearOverlay() {
    if (!overlayCtx || !overlay) return;
    overlayCtx.clearRect(0, 0, overlay.width / DPR, overlay.height / DPR);
  }

  /* v7.9.3：画区域填充（多环 evenodd，洞自动挖空）。mapFn 把点转成当前坐标系。 */
  function drawFillSet(c, fills, mapFn) {
    for (const f of fills || []) {
      if (!f || !f.color || !f.loops || !f.loops.length) continue;
      c.save();
      c.fillStyle = f.color;
      c.beginPath();
      for (const loop of f.loops) {
        if (!loop || loop.length < 3) continue;
        const p0 = mapFn(loop[0]);
        c.moveTo(p0.x, p0.y);
        for (let i = 1; i < loop.length; i++) {
          const p = mapFn(loop[i]);
          c.lineTo(p.x, p.y);
        }
        c.closePath();
      }
      c.fill('evenodd');
      c.restore();
    }
  }

  function renderOverlay() {
    if (!overlayCtx) return;
    const W = overlay.width / DPR;
    const H = overlay.height / DPR;
    overlayCtx.clearRect(0, 0, W, H);

    /* v6.2.0：会话数据是世界坐标，渲染前统一按当前视图投影一次（带缓存） */
    const sig = viewSignature();
    const kv = worldUnitScreenLen();

    /* v7.9.3：区域填充垫在笔迹下面，编辑时也能看到 */
    drawFillSet(overlayCtx, baseFills, D.worldToScreen);

    /* brush-v5.1.2: 基线内容也按 z 顺序回放（旧遮罩不再盖在后来补画的笔迹上），
       编辑过程中所见即所得，和点「确定」后的结果是同一套顺序。 */
    const baseItems = [];
    for (const s of baseStrokes) baseItems.push({ kind: 'stroke', z: (typeof s.z === 'number' ? s.z : 0), data: s });
    for (const er of baseErasers) baseItems.push({ kind: 'erase', z: (typeof er.z === 'number' ? er.z : 1e9), data: er });
    baseItems.sort((a, b) => a.z - b.z);

    const items = baseItems.slice();
    for (const op of ops) items.push({ kind: op.type, data: op.data });
    if (current) items.push({ kind: current.type, data: current.data });

    drawItems(overlayCtx, items, sig, kv);
  }

  /* v6.2.0：绘制一整个序列。
     勾选了「描边铺底」的笔迹会被合并成一组：先把这组所有笔的边画完，再统一画芯，
     这样后一笔的边就不会压在前一笔的芯上（外描边 / paint-order: stroke fill 的效果）。
     橡皮与未勾选的笔会打断分组，保持原来的落笔顺序。 */
  function drawItems(c, items, sig, kv) {
    let group = [];
    const flush = () => {
      if (!group.length) return;
      for (const s of group) drawStroke(c, s, sig, kv, 'border');
      for (const s of group) drawStroke(c, s, sig, kv, 'core');
      group = [];
    };
    for (const it of items) {
      if (it.kind === 'stroke' && it.data && it.data.outlineUnder) { group.push(it.data); continue; }
      flush();
      if (it.kind === 'stroke') drawStroke(c, it.data, sig, kv, 'both');
      else if (it.kind === 'erase') drawErase(c, it.data, sig, kv);
    }
    flush();
  }

  /* pass: 'both' = 先边后芯；'border' / 'core' = 分层绘制时只画其中一层 */
  function drawStroke(c, s, sig, kv, pass) {
    if (!s) return;
    const pts = ensureProjected(s, sig, kv);
    if (!pts || !pts.length) return;
    pass = pass || 'both';
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const bw = (s.borderWidth || 0) * kv;   /* 世界边界宽 → 屏幕宽 */

    /* v7.9.4：柳叶笔 = 不规则有机填充块。整笔只有一层填充 + 可选描边，
       所以 core 趟直接跳过；描边铺底分组也只在 border 趟画一次。 */
    if (s.type === 'blob') {
      if (pass === 'core') { c.restore(); return; }
      const loop = (SKFE.core.geometry && SKFE.core.geometry.blobLoopFromPoints)
        ? SKFE.core.geometry.blobLoopFromPoints(pts, s.blobSeed || 0)
        : [];
      if (loop.length >= 3) {
        c.beginPath();
        c.moveTo(loop[0].x, loop[0].y);
        for (let i = 1; i < loop.length; i++) c.lineTo(loop[i].x, loop[i].y);
        c.closePath();
        c.fillStyle = s.color;
        c.fill();
        if (s.borderWidth > 0 && s.borderColor && bw > 0) {
          c.strokeStyle = s.borderColor;
          c.lineWidth = bw;
          c.stroke();
        }
      }
      c.restore();
      return;
    }

    /* v7.9.4：蜡笔 = 沿路径撒颗粒短笔触，无包边、无普通圆头线 */
    if (s.type === 'crayon') {
      if (pass === 'core') { c.restore(); return; }
      SKFE.core.geometry.drawCrayonStroke(c, pts, s.color, s.blobSeed || 0, null, null);
      c.restore();
      return;
    }

    /* v7.9.2：填充画在边和芯之前；分组时只在 border 趟画一次，避免 core 趟再盖住描边。 */
    if (pass === 'both' || pass === 'border') {
      if (!baseFills.length && s.fill && s.fill.color && pts.length >= 4) {
        c.fillStyle = s.fill.color;
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.closePath();
        c.fill();
      }
    }

    if (pass !== 'core' && s.borderWidth > 0 && s.borderColor) {
      c.strokeStyle = s.borderColor;
      c.fillStyle = s.borderColor;
      if (pts.length === 1) {
        const p = pts[0];
        c.beginPath();
        c.arc(p.x, p.y, Math.max(p.w / 2, 0.4) + bw, 0, Math.PI * 2);
        c.fill();
      } else {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          c.lineWidth = ((a.w + b.w) / 2) + bw * 2;
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
      }
    }

    if (pass === 'border') { c.restore(); return; }

    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    if (pts.length === 1) {
      const p = pts[0];
      c.beginPath();
      c.arc(p.x, p.y, Math.max(p.w / 2, 0.4), 0, Math.PI * 2);
      c.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        c.lineWidth = Math.max(0.4, (a.w + b.w) / 2);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
    }
    c.restore();
  }

  function drawErase(c, er, sig, kv) {
    if (!er) return;
    const pts = ensureProjected(er, sig, kv);
    if (!pts || !pts.length) return;
    const size = Math.max(0.5, (er.size || 1) * kv);   /* 世界宽度 → 屏幕宽 */
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = size;
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, Math.max(0.5, size / 2), 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) c.moveTo(pts[i].x, pts[i].y);
        else c.lineTo(pts[i].x, pts[i].y);
      }
      c.stroke();
    }
    c.restore();
  }

  /* brush-v5.1.0: 实现 §6.1.10 —— 防抖追逐（requestAnimationFrame）+ 实时落笔 */
  function startLoop() {
    if (rafId) return;
    lastFrameTime = performance.now();
    lastTickAt = lastFrameTime;
    rafId = requestAnimationFrame(tick);
    startWatchdog();
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    stopWatchdog();
  }

  /* brush-v5.1.0: rAF 在后台标签页/无头环境会被节流到几乎不触发，
     用计时器兜底推动同一个 tick，保证笔迹不会因为掉帧而丢点 */
  function startWatchdog() {
    if (loopTimer) return;
    loopTimer = setInterval(function () {
      if (!current) { stopWatchdog(); return; }
      const now = performance.now();
      if (now - lastTickAt > 60) tick(now, true);
    }, 40);
  }

  function stopWatchdog() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
  }

  function tick(now, viaTimer) {
    if (!viaTimer) rafId = 0;
    lastTickAt = now;
    if (!current) { drawing = false; stopLoop(); return; }

    const dt = Math.max(1, Math.min(now - lastFrameTime, 40));
    lastFrameTime = now;
    /* v6.2.0：会话是世界坐标，而手感阈值是「屏幕像素」量级，这里换算一下，
       保证放大到 800% 和缩小到 20% 时，笔画跟随指针的速度一样 */
    const kv = worldUnitScreenLen();

    /* === 0. QuickShape：末端静止 → 吸附标准图形；拖动改大小/角度；再静止 → 轮换 === */
    /* 柳叶笔不走直线、圆等 QuickShape 吸附，避免把有机块吞掉；蜡笔可以正常吸附 */
    const specialType = current.data && current.data.type === 'blob';
    if (drawing && current.type === 'stroke' && !specialType) {
      if (!qs) qsTryStart(now, kv);
      else qsDragUpdate(now, kv);
    }

    /* === 1. 笔尖追逐指针（防抖） === */
    const dx = target.x - penTip.x, dy = target.y - penTip.y;
    const dist = Math.hypot(dx, dy);
    let changed = false;

    if (qs) {
      /* QuickShape 期间笔迹由图形生成，笔尖直接贴合指针，不再追加原始点 */
      penTip.x = target.x;
      penTip.y = target.y;
    } else if (dist > 0.01 / kv) {
      const s = Math.max(0, Math.min(0.98, cfg.stabilize));
      const inv = 1 - s;
      const inv3 = inv * inv * inv;
      let baseSpeed = 0.35 + inv3 * 20;          /* 屏幕像素 / 帧 */
      let distFactor = 0.05 + inv3 * 1.5;
      if (now - targetTime > 70) { baseSpeed *= 2.4; distFactor *= 1.8; }
      const stepPx = baseSpeed + (dist * kv) * distFactor;
      const move = Math.min(dist, stepPx / kv);
      if (dist - move < 0.25 / kv) { penTip.x = target.x; penTip.y = target.y; }
      else { penTip.x += (dx / dist) * move; penTip.y += (dy / dist) * move; }

      /* === 2. 落笔 === */
      const ddx = penTip.x - lastTipPos.x, ddy = penTip.y - lastTipPos.y;
      const d = Math.hypot(ddx, ddy);
      if (d > 0.2 / kv) {
        if (current.type === 'stroke') {
          current.data.points.push({ x: penTip.x, y: penTip.y, w: currentPointWidth() });
        } else {
          current.data.points.push({ x: penTip.x, y: penTip.y });
        }
        lastTipPos.x = penTip.x;
        lastTipPos.y = penTip.y;
        changed = true;
      }
    }

    if (changed) renderOverlay();

    /* === 3. 松手收尾 === */
    if (!drawing) {
      const remain = Math.hypot(target.x - penTip.x, target.y - penTip.y);
      if (remain < 0.4 / kv || now > releaseDeadline) { finishCurrentStroke(); return; }
    }
    if (!viaTimer) rafId = requestAnimationFrame(tick);
  }

  /* 笔宽（v6.2.0）：恒定值，单位是世界单位。
     以前按速度 / 压感调制（起笔速度 0 时 1.12 倍、快速移动降到 0.52 倍），
     一笔之内粗细能差两倍多，起笔那个圆头看起来就是个黑点 —— 现在整笔同宽。 */
  function widthAt() {
    return Math.max(0.05, cfg.size);
  }

  /* ==================== v6.2.0 QuickShape（末端长按 → 标准图形） ====================
     手感设计（对齐 Procreate）：
       · 画完一笔先别抬笔，笔尖停住 0.45s → 这一笔立刻吸附成识别出的标准图形；
       · 继续按住拖动 → 改大小 / 角度（直线、折线、曲线锚定起点；圆、椭圆锚定圆心）；
       · 成形后再停 0.45s → 在候选图形之间轮换（曲线 → 直线 → 折线 / 圆 → 椭圆…）；
       · 抬笔即确认，undo 可撤销。 */
  const QS_HOLD_MS = 450;          /* 末端静止多久触发识别 */
  const QS_SWITCH_MS = 1100;       /* 已成形后要继续静止多久才轮换图形（刻意拉长：
                                      正常"停一下吸附"不会误触发成下一种形状） */
  let lastMoveAt = 0;              /* 指针最后一次真正移动的时间戳 */
  let qsLastScreen = { x: 0, y: 0 };
  let qsMoveAccum = 0;             /* 位移累计：手很慢地画（每帧只动零点几像素）也算在动 */
  let qs = null;                   /* QuickShape 会话状态 */

  function qsPathLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
  }

  /* Douglas–Peucker 简化 */
  function qsSimplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    let maxD = -1, idx = 0;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distPointSeg(pts[i], a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      const left = qsSimplify(pts.slice(0, idx + 1), tol);
      const right = qsSimplify(pts.slice(idx), tol);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  /* 按弧长均匀重采样 */
  function qsResample(pts, count) {
    const total = qsPathLen(pts);
    if (!(total > 1e-9) || count < 2 || pts.length < 2) return pts.slice();
    const step = total / (count - 1);
    const out = [{ x: pts[0].x, y: pts[0].y }];
    let segStart = pts[0], acc = 0, need = step, i = 1;
    while (i < pts.length && out.length < count - 1) {
      const segEnd = pts[i];
      const seg = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);
      if (seg > 1e-12) {
        while (acc + seg >= need && out.length < count - 1) {
          const t = (need - acc) / seg;
          out.push({
            x: segStart.x + (segEnd.x - segStart.x) * t,
            y: segStart.y + (segEnd.y - segStart.y) * t
          });
          need += step;
        }
      }
      acc += seg; segStart = segEnd; i++;
    }
    out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
    return out;
  }

  /* 用点云主轴拟合椭圆：rot 为长轴角度，rx/ry 为半轴 */
  function qsFitEllipse(pts) {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    sxx /= n; syy /= n; sxy /= n;
    let rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const c = Math.cos(rot), s = Math.sin(rot);
    let su2 = 0, sv2 = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      su2 += u * u; sv2 += v * v;
    }
    /* 用轴向 RMS 求半轴（对完整椭圆是精确解，且不会被个别抖动点带偏；
       以前用 max|u|，手绘的毛刺会把某一轴顶大 5~8%） */
    let rx = Math.sqrt(2 * su2 / n), ry = Math.sqrt(2 * sv2 / n);
    if (ry > rx) { const t = rx; rx = ry; ry = t; rot += Math.PI / 2; }
    return { cx: mx, cy: my, rx: Math.max(rx, 1e-6), ry: Math.max(ry, 1e-6), rot };
  }

  /* 折点尖锐程度（最大转角，弧度）—— 判断像不像"折线" */
  function qsCornerness(verts) {
    let maxTurn = 0;
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[i - 1], b = verts[i], c = verts[i + 1];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const cs = (v1x * v2x + v1y * v2y) / (l1 * l2);
      const ang = Math.acos(Math.max(-1, Math.min(1, cs)));
      if (ang > maxTurn) maxTurn = ang;
    }
    return maxTurn;
  }

  function qsAnalyze(raw) {
    const pts = raw;
    const n = pts.length;
    if (n < 4) return null;
    const p0 = pts[0], p1 = pts[n - 1];
    let L = 0;
    let minX = p0.x, maxX = p0.x, minY = p0.y, maxY = p0.y;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i) L += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!(L > 1e-9)) return null;
    const diag = Math.max(1e-6, Math.hypot(maxX - minX, maxY - minY));
    const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const closed = chord < L * 0.30 && L > diag * 1.55;
    let straight = 1;
    if (chord > diag * 0.15) {
      let maxD = 0;
      for (let i = 1; i < n - 1; i++) maxD = Math.max(maxD, distPointSeg(pts[i], p0, p1));
      straight = maxD / chord;
    }
    const verts = qsSimplify(pts, diag * 0.05);
    const segCount = Math.max(3, Math.min(12, Math.round(L / (diag * 0.18)) + 2));
    const smoothVerts = qsResample(pts, segCount);
    return {
      p0, p1, L, diag, chord, closed, straight,
      verts, smoothVerts,
      ell: qsFitEllipse(pts)
    };
  }

  function qsCandidates(geo) {
    const out = [];
    const add = (k) => { if (out.indexOf(k) < 0) out.push(k); };
    if (geo.closed) {
      const ratio = Math.min(geo.ell.rx, geo.ell.ry) / Math.max(geo.ell.rx, geo.ell.ry);
      if (ratio > 0.86) { add('circle'); add('ellipse'); }
      else { add('ellipse'); add('circle'); }
      add('curve');
    } else {
      const turn = qsCornerness(geo.verts);
      const polyOK = geo.verts.length >= 3 && geo.verts.length <= 9;
      const lineOK = geo.straight < 0.09;
      if (lineOK) add('line');
      if (polyOK && turn > 0.55) add('polyline');
      add('curve');
      if (polyOK && turn <= 0.55) add('polyline');
      add('line');
    }
    return out;
  }

  /* 折线 / 曲线：把顶点做「起点不动、末点跟手」的旋转+缩放，天然支持改大小与角度 */
  function qsTransformVerts(verts, tip) {
    const A = verts[0], B = verts[verts.length - 1];
    const v0x = B.x - A.x, v0y = B.y - A.y;
    const v1x = tip.x - A.x, v1y = tip.y - A.y;
    const l0 = Math.hypot(v0x, v0y), l1 = Math.hypot(v1x, v1y);
    if (!(l0 > 1e-9) || !(l1 > 1e-9)) return verts;
    const k = Math.max(0.05, Math.min(40, l1 / l0));
    const ang = Math.atan2(v0x * v1y - v0y * v1x, v0x * v1x + v0y * v1y);
    const c = Math.cos(ang), s = Math.sin(ang);
    return verts.map((p) => {
      const dx = (p.x - A.x) * k, dy = (p.y - A.y) * k;
      return { x: A.x + dx * c - dy * s, y: A.y + dx * s + dy * c };
    });
  }

  /* Catmull-Rom 插值成平滑曲线 */
  function qsSpline(verts, perSeg) {
    const n = verts.length;
    if (n < 3) return verts.slice();
    const at = (i) => verts[Math.max(0, Math.min(n - 1, i))];
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let j = 0; j < perSeg; j++) {
        const t = j / perSeg, t2 = t * t, t3 = t2 * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    out.push({ x: verts[n - 1].x, y: verts[n - 1].y });
    return out;
  }

  function qsBuild(kind, geo, q) {
    const w = Math.max(0.05, cfg.size);
    const out = [];
    const P = (x, y) => out.push({ x, y, w });
    const tip = q.tip;

    if (kind === 'line') {
      const A = geo.p0, B = tip;
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      const step = Math.max(0.35, w * 0.45);
      const nStep = Math.max(2, Math.min(600, Math.ceil(len / step)));
      for (let i = 0; i <= nStep; i++) P(A.x + (B.x - A.x) * i / nStep, A.y + (B.y - A.y) * i / nStep);
      return out;
    }

    if (kind === 'circle' || kind === 'ellipse') {
      const e = geo.ell;
      /* 以圆心为锚：拖动点离圆心多远，就按比例放大 —— 落点即原比例（k=1），不会一触发就跳变 */
      const base = Math.max(q.baseDist, Math.max(e.rx, e.ry) * 0.02, 1e-6);
      const cur = Math.hypot(tip.x - e.cx, tip.y - e.cy);
      const k = Math.max(0.05, Math.min(40, cur / base));
      let rx = e.rx * k, ry = e.ry * k;
      /* 判成正圆就真的画成正圆（椭圆则保留手绘的长短轴比例） */
      if (kind === 'circle') { const r = (rx + ry) / 2; rx = r; ry = r; }
      const c = Math.cos(e.rot), s = Math.sin(e.rot);
      const N = 128;
      for (let i = 0; i <= N; i++) {
        const t = i / N * Math.PI * 2;
        const px = Math.cos(t) * rx, py = Math.sin(t) * ry;
        P(e.cx + px * c - py * s, e.cy + px * s + py * c);
      }
      return out;
    }

    if (kind === 'polyline') {
      const vs = qsTransformVerts(geo.verts, tip);
      if (vs.length < 2) return out;
      for (let i = 0; i < vs.length; i++) {
        if (i > 0) {
          /* 长边补点，保证描边宽度与圆角衔接正常 */
          const a = vs[i - 1], b = vs[i];
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          const k = Math.max(1, Math.min(60, Math.ceil(seg / Math.max(0.4, w * 0.5))));
          for (let j = 1; j <= k; j++) P(a.x + (b.x - a.x) * j / k, a.y + (b.y - a.y) * j / k);
        } else P(vs[0].x, vs[0].y);
      }
      return out;
    }

    /* curve */
    const vs = qsTransformVerts(geo.smoothVerts, tip);
    const sp = qsSpline(vs, Math.max(6, Math.min(16, Math.round(120 / Math.max(2, vs.length)))));
    for (const p of sp) P(p.x, p.y);
    return out;
  }

  function qsApply() {
    if (!qs || !current || current.type !== 'stroke') return;
    const pts = qsBuild(qs.cands[qs.idx], qs.geo, qs);
    if (pts && pts.length >= 2) {
      current.data.points = pts;
      /* 点集整体换掉了，投影缓存必须作废，否则 overlay 还画着旧的屏幕坐标 */
      current.data._vs = null;
      current.data._spts = null;
    }
  }

  function qsTryStart(now, kv) {
    if (!current || current.type !== 'stroke' || qs) return;
    if (now - lastMoveAt < QS_HOLD_MS) return;
    /* 笔尖必须已经追上指针，才说明用户是真的停住了 */
    if (Math.hypot(target.x - penTip.x, target.y - penTip.y) * kv > 2.5) return;
    const pts = current.data.points;
    if (!pts || pts.length < 4) return;
    if (qsPathLen(pts) * kv < 12) return;
    const geo = qsAnalyze(pts);
    if (!geo) return;
    const cands = qsCandidates(geo);
    if (!cands.length) return;
    const tip = { x: target.x, y: target.y };
    qs = {
      geo, cands, idx: 0,
      raw: pts.slice(),                       /* 原始笔迹：指针取消时还原 */
      tip,
      baseDist: Math.max(1e-6, Math.hypot(tip.x - geo.ell.cx, tip.y - geo.ell.cy)),
      stillSince: now
    };
    qsApply();
  }

  function qsDragUpdate(now, kv) {
    if (!qs) return;
    if (Math.hypot(target.x - qs.tip.x, target.y - qs.tip.y) * kv > 0.4) {
      qs.tip.x = target.x;
      qs.tip.y = target.y;
      qsApply();
      renderOverlay();
      qs.stillSince = now;
      return;
    }
    /* 成形后继续静止 → 轮换候选图形 */
    if (now - lastMoveAt >= QS_SWITCH_MS && now - qs.stillSince >= QS_SWITCH_MS) {
      qs.stillSince = now;
      if (qs.cands.length > 1) {
        qs.idx = (qs.idx + 1) % qs.cands.length;
        qsApply();
        renderOverlay();
      }
    }
  }

  function resetQuickShape() { qs = null; }

  /* v7.0.2：这一笔到现在为止是不是只有「一个点」。
     双指手势的第一根手指落下时必然会先起笔，如果随后马上按下第二根手指，
     这一笔实际什么都没画 —— 判成点就整笔丢掉，否则画布上会凭空多个黑点。 */
  function isDotStroke() {
    if (!current || !current.data || !current.data.points) return true;
    const pts = current.data.points;
    if (pts.length <= 1) return true;
    const kv = worldUnitScreenLen();
    const p0 = pts[0];
    let maxD = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - p0.x, pts[i].y - p0.y);
      if (d > maxD) maxD = d;
    }
    return maxD * kv <= 12;   /* 屏幕位移不到 12px，当点处理 */
  }

  /* 丢掉当前这一笔（不提交、不进历史） */
  function discardCurrentStroke() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = 0; }
    current = null;
    drawing = false;
    resetQuickShape();
    stopLoop();
    renderOverlay();
    refreshButtons();
  }

  function finishCurrentStroke() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = 0; }
    if (!current) { drawing = false; resetQuickShape(); stopLoop(); renderOverlay(); return; }
    if (current.type === 'stroke') ops.push({ type: 'stroke', data: current.data });
    else ops.push({ type: 'erase', data: current.data });
    current = null;
    drawing = false;
    resetQuickShape();
    stopLoop();
    renderOverlay();
    refreshButtons();
  }

  /* brush-v5.1.0: 实现 §6.1.11 —— 指针事件（落笔 / 追逐 / 收笔） */
  function bindPointer() {
    overlay.addEventListener('pointerdown', onDown);
    /* v7.9.2：油漆桶模式接管画布点击，点闭合区域即填充 */
    overlay.addEventListener('pointerdown', (e) => {
      if (!bucketMode || brushOn) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      bucketFillAt(e.clientX, e.clientY);
    });
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    /* v6.2.0：绘制过程中也要能缩放画布（overlay 会挡住画布，滚轮得在这里转交） */
    overlay.addEventListener('wheel', (e) => {
      if (!brushOn) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      if (D.zoomViewAt && D.zoomViewAt(e.clientX, e.clientY, factor)) renderOverlay();
    }, { passive: false });
    /* 光标更新注册在 eraser.initUI 之后，保证覆盖 eraser.js 的光标逻辑 */
    document.addEventListener('pointermove', onDocMoveCursor, { passive: true });
    document.addEventListener('pointerleave', hideBrushCursor);
  }

  function localPoint(e) {
    const rect = overlay.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onDown(e) {
    if (!brushOn) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();

    /* v6.2.0：第二根手指按下 = 进入双指手势（缩放 + 拖动平移）。
       v7.0.2：正在起笔的那一下如果是「一个点」，直接丢掉 —— 双指是操作视图，不是画画。 */
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      if (drawing || current) {
        if (isDotStroke()) discardCurrentStroke();
        else finishCurrentStroke();
      }
      const arr = Array.from(pointers.values());
      pinchLastDist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      pinchLastMid = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
      try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }

    if (current) finishCurrentStroke();
    try { overlay.setPointerCapture(e.pointerId); } catch (_) {}

    /* v6.2.0：指针位置转成世界坐标，会话内一路都用世界坐标 */
    const kv = worldUnitScreenLen();
    const sp0 = localPoint(e);
    const p = screenToWorldPt(sp0);
    penTip = { x: p.x, y: p.y };
    target = { x: p.x, y: p.y };
    lastTipPos = { x: p.x, y: p.y };
    targetTime = performance.now();
    releaseDeadline = 0;
    /* QuickShape 静止计时：落笔即开始计时 */
    lastMoveAt = performance.now();
    qsLastScreen = { x: sp0.x, y: sp0.y };
    qsMoveAccum = 0;
    resetQuickShape();
    isPenPointer = e.pointerType === 'pen';
    tipPressure = (isPenPointer && e.pressure > 0) ? e.pressure : 0.5;
    drawing = true;

    if (D.eraserIsOn()) {
      /* 画笔模式内切到橡皮 → 本次笔画是一段擦除遮罩（尺寸同样换算成世界单位） */
      current = {
        type: 'erase',
        data: { size: Math.max(0.5, D.eraserGetSize() * 2.6 / kv), points: [{ x: p.x, y: p.y }] }
      };
    } else {
      current = {
        type: 'stroke',
        data: {
          /* v7.9.4：三种画笔类型都存进 stroke，changed later only affects new strokes */
          type: (cfg.type === 'blob' || cfg.type === 'crayon') ? cfg.type : 'default',
          blobSeed: Math.random() * 1000,
          color: cfg.color,
          /* 蜡笔没有包边，强制写空，避免以后切回默认又被旧边色描出来 */
          borderColor: (cfg.borderEnabled && cfg.type !== 'crayon') ? cfg.borderColor : null,
          borderWidth: (cfg.borderEnabled && cfg.type !== 'crayon') ? cfg.borderWidth : 0,
          /* v6.2.0：勾选「描边铺底」后，这笔的边会统一铺在所有芯下面 */
          outlineUnder: !!(cfg.borderEnabled && cfg.outlineUnder && cfg.type !== 'crayon'),
          points: [{ x: p.x, y: p.y, w: currentPointWidth() }]
        }
      };
    }
    renderOverlay();
    startLoop();
  }

  function onMove(e) {
    if (!brushOn) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    /* 双指：以两指中点为锚缩放，并把中点的位移当成拖动平移 —— 不落笔 */
    if (pointers.size >= 2) {
      e.preventDefault();
      const arr = Array.from(pointers.values());
      const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      const mx = (arr[0].x + arr[1].x) / 2;
      const my = (arr[0].y + arr[1].y) / 2;
      if (pinchLastDist > 2 && d > 2) {
        const factor = d / pinchLastDist;
        if (Math.abs(factor - 1) > 0.002 && D.zoomViewAt) {
          if (D.zoomViewAt(mx, my, factor)) renderOverlay();
        }
        pinchLastDist = d;
      }
      /* v7.0.2：双指平移。缩放已经把中点钉在原地，这里补上中点自身的位移，
         手感就和画布上直接双指拖动一致：两指一起挪，画面跟着走。 */
      if (pinchLastMid && D.panView) {
        const dx = mx - pinchLastMid.x, dy = my - pinchLastMid.y;
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
          if (D.panView(dx, dy)) renderOverlay();
        }
      }
      pinchLastMid = { x: mx, y: my };
      return;
    }

    if (!drawing || !current) return;
    e.preventDefault();
    const sp = localPoint(e);
    const p = screenToWorldPt(sp);
    target.x = p.x;
    target.y = p.y;
    targetTime = performance.now();
    /* QuickShape：按位移累计重置静止计时。
       不能只看单次移动距离 —— 手很慢地匀速画时每帧可能只动 0.5px，
       用单帧阈值会误判成"停住了"，画到一半突然变直线。 */
    const mv = Math.abs(sp.x - qsLastScreen.x) + Math.abs(sp.y - qsLastScreen.y);
    if (mv > 0) {
      qsMoveAccum += mv;
      qsLastScreen.x = sp.x;
      qsLastScreen.y = sp.y;
      if (qsMoveAccum > 2) { lastMoveAt = performance.now(); qsMoveAccum = 0; }
    }
    const pr = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
    tipPressure = tipPressure * 0.65 + pr * 0.35;

    /* v6.3.0：防抖为 0 时走「直接落笔」快路径 —— 不等下一帧 rAF，
       指针到哪儿笔迹就到哪儿。以前一律靠 rAF 追逐，手感上总慢半拍。 */
    if (cfg.stabilize <= 0.02 && !qs) {
      penTip.x = p.x;
      penTip.y = p.y;
      const ddx = penTip.x - lastTipPos.x, ddy = penTip.y - lastTipPos.y;
      const d = Math.hypot(ddx, ddy);
      const kvNow = worldUnitScreenLen();
      if (d > 0.2 / kvNow) {
        if (current.type === 'stroke') current.data.points.push({ x: penTip.x, y: penTip.y, w: currentPointWidth() });
        else current.data.points.push({ x: penTip.x, y: penTip.y });
        lastTipPos.x = penTip.x;
        lastTipPos.y = penTip.y;
        renderOverlay();
      }
    }
    startLoop();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { pinchLastDist = 0; pinchLastMid = null; }
    if (!drawing) {
      try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    /* 系统取消（来电 / 手势冲突）→ 放弃 QuickShape 变形，回到手绘笔迹 */
    if (e.type === 'pointercancel' && qs && current && current.type === 'stroke') {
      current.data.points = qs.raw;
      resetQuickShape();
      renderOverlay();
    }
    drawing = false;
    releaseDeadline = performance.now() + 400;
    startLoop();
    /* 兜底：标签页后台 / rAF 被节流时，用定时器保证笔画一定会提交 */
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      finishTimer = 0;
      if (current && !drawing) finishCurrentStroke();
    }, 460);
    try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
  }

  /* brush-v5.1.0: 实现 §6.1.14 —— 圆形光标（复用 #eraserCursor） */
  function brushCursorRadius() {
    /* 光标是屏幕尺寸，所以世界笔宽要乘回当前缩放；否则放大画布后光标会比笔迹细一圈 */
    const kv = worldUnitScreenLen();
    if (D.eraserIsOn()) return Math.max(4, D.eraserGetSize() * 2.6 / 2);
    const bw = cfg.borderEnabled ? cfg.borderWidth * 2 : 0;
    return Math.max(4, (cfg.size + bw) * kv / 2);
  }

  function updateBrushCursorSize() {
    /* 尺寸在下一次 pointermove 时应用，这里只做即时刷新（指针不动时也更新） */
    const cursor = document.getElementById('eraserCursor');
    if (!cursor || !brushOn) return;
    const d = brushCursorRadius() * 2;
    cursor.style.width = d + 'px';
    cursor.style.height = d + 'px';
    if (D.eraserIsOn()) cursor.style.borderColor = '';
    else cursor.style.borderColor = cfg.color;
  }

  function onDocMoveCursor(e) {
    if (!brushOn) { return; }
    const cursor = document.getElementById('eraserCursor');
    if (!cursor) return;
    /* 只有指针在画笔画布上时显示圆形光标 */
    const overOverlay = (e.target === overlay);
    if (!overOverlay) { hideBrushCursor(); return; }
    const d = brushCursorRadius() * 2;
    cursor.style.setProperty('display', 'block', 'important');
    cursor.style.width = d + 'px';
    cursor.style.height = d + 'px';
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
    if (D.eraserIsOn()) cursor.style.borderColor = '';
    else cursor.style.borderColor = cfg.color;
  }

  function hideBrushCursor() {
    const cursor = document.getElementById('eraserCursor');
    if (!cursor) return;
    if (brushOn) cursor.style.setProperty('display', 'none', 'important');
  }

  /* brush-v5.1.0: 实现 §6.1.13 —— 快捷键（会话内接管，不影响旧笔迹） */
  function bindHotkeys() {
    window.addEventListener('keydown', (e) => {
      if (!brushOn) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = (e.key || '').toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
        if (k === 'y') { e.preventDefault(); e.stopPropagation(); return; }
        return;
      }
      if (k === 'escape') { e.preventDefault(); e.stopPropagation(); setOn(false); return; }
      if (k === 'z') { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
      /* 画笔模式下禁止切换帧 / 播放 / 删除 / 复制 / 重置等画布级快捷键 */
      if (k === ' ' || k === 'arrowleft' || k === 'arrowright' ||
          k === 'delete' || k === 'backspace' || k === 'c' || k === 'r') {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* 点击面板以外的区域 → 退出画笔模式（避免误触其它元件 / 时间轴） */
  function bindOutsideClickExit() {
    document.addEventListener('pointerdown', (e) => {
      if (!brushOn) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t === overlay || t.id === 'brushOverlay') return;
      if (t.closest('#brushFloatBar')) return;
      if (t.closest('#brushTypeFloat') || t.closest('#btnBrushType')) return;
      if (t.closest('.tool-panel[data-tool="eraser"]')) return;
      if (t.closest('#toolChips .tool-chip[data-tool="eraser"]')) return;
      setOn(false);
    }, true);
  }

  /* brush-v5.1.0: 实现 §6.1.15 —— 会话内撤销上一笔 / 清空 */
  function undoLast() {
    if (!ops.length) return;
    ops.pop();
    renderOverlay();
    refreshButtons();
  }

  function clearAll() {
    ops.length = 0;
    baseStrokes.length = 0;
    baseErasers.length = 0;
    baseFills.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    renderOverlay();
    refreshButtons();
  }

  /* ==================== 画笔预设（v5.1.1：笔迹 + 挂载位置） ==================== */
  const PRESET_KEY = 'skfe_ink_presets_v1';
  let presets = [];

  function cloneJSON(v) { return JSON.parse(JSON.stringify(v == null ? null : v)); }

  function loadPresets() {
    try {
      const raw = localStorage.getItem(PRESET_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      presets = Array.isArray(arr) ? arr.filter(p => p && p.id && Array.isArray(p.strokes)) : [];
    } catch (_) { presets = []; }
  }

  function savePresets() {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (_) {}
  }

  function refreshPresetOptions(selectId) {
    const sel = document.getElementById('inkPresetSelect');
    if (!sel) return;
    const keep = selectId || sel.value;
    sel.innerHTML = '';
    if (!presets.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = tr('brushPreset.empty', '还没有预设');
      o.setAttribute('data-i18n', 'brushPreset.empty'); /* v7.2.2：挂上 data-i18n，切语言时能跟着刷新 */
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const p of presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.bindTo && p.bindTo !== 'none' ? ' · ' + p.bindTo : '');
      sel.appendChild(o);
    }
    if (keep && presets.some(p => p.id === keep)) sel.value = keep;
  }

  /* 把当前选中的 ink 存成预设（笔迹用局部单位，可直接复用；同时记录挂载点与偏移） */
  function savePresetFromSelection() {
    const sel = D.getSelected();
    if (!sel || sel.type !== 'ink') {
      D.showToast(tr('brushPreset.toastNeedInk', '请先选中一个画笔元件，再存为预设'));
      return false;
    }
    const nameEl = document.getElementById('inkPresetName');
    const typed = nameEl ? nameEl.value.trim().slice(0, 20) : '';
    const name = typed || sel.name || D.generateName('ink');
    /* 相对旋转：抵消挂载角度后的"用户额外旋转"，换关节复用也不会歪 */
    const base = (sel.bindTo && sel.bindTo !== 'none' && sel.targetId) ? D.getBindBase(sel) : null;
    const baseDeg = base ? base.angle * 180 / Math.PI : 0;
    const data = {
      id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
      name: name,
      at: Date.now(),
      strokes: cloneJSON(sel.strokes || []),
      eraser: cloneJSON(sel.eraser || []),
      bindTo: sel.bindTo || 'none',
      offX: sel.offX || 0,
      offY: sel.offY || 0,
      relRot: (sel.rot || 0) + baseDeg,
      scale: sel.scale || 1,
      w: sel.w || 1,
      h: sel.h || 1,
      alpha: sel.alpha == null ? 1 : sel.alpha,
      layer: sel.layer == null ? 10 : sel.layer
    };
    const dup = presets.findIndex(p => p.name === name);
    if (dup >= 0) presets[dup] = data;
    else presets.unshift(data);
    savePresets();
    refreshPresetOptions(data.id);
    if (nameEl) nameEl.value = '';
    D.showToast(tr('brushPreset.toastSaved', '已保存预设：') + name);
    return true;
  }

  /* 应用预设：按记录的挂载点 + 偏移挂到当前选中的火柴人（没有则第一个火柴人） */
  function applyPreset(preset) {
    if (!preset) {
      D.showToast(tr('brushPreset.toastNoPreset', '请先在列表里选择一个预设'));
      return false;
    }
    const sel = D.getSelected();
    let fig = (sel && sel.type === 'figure') ? sel : null;
    if (!fig) fig = D.getObjects().find(o => o && o.type === 'figure') || null;

    const ink = {
      id: D.nextUid(),
      type: 'ink',
      name: preset.name || D.generateName('ink'),
      x: 0, y: 0,
      w: preset.w || 1, h: preset.h || 1,
      scale: preset.scale || 1,
      rot: preset.relRot || 0,
      alpha: preset.alpha == null ? 1 : preset.alpha,
      layer: preset.layer == null ? 10 : preset.layer,
      locked: false, mirror: false, ax: 0, ay: 0,
      bindTo: 'none', targetId: null, offX: 0, offY: 0,
      strokes: cloneJSON(preset.strokes || []),
      eraser: cloneJSON(preset.eraser || [])
    };

    const canBind = !!(fig && preset.bindTo && preset.bindTo !== 'none');
    if (canBind) {
      ink.bindTo = preset.bindTo;
      ink.targetId = fig.id;
      ink.offX = preset.offX || 0;
      ink.offY = preset.offY || 0;
      const base = D.getBindBase({ bindTo: ink.bindTo, targetId: fig.id, type: 'ink' });
      if (base) {
        const g = base.scale || 1;
        const ox = ink.offX * g, oy = ink.offY * g;
        ink.x = base.x + Math.cos(base.angle) * ox - Math.sin(base.angle) * oy;
        ink.y = base.y + Math.sin(base.angle) * ox + Math.cos(base.angle) * oy;
        /* 抵消新挂载点的角度，保持"画的时候"的方向 */
        ink.rot = -(base.angle * 180 / Math.PI) + (preset.relRot || 0);
      } else {
        ink.x = fig.x; ink.y = fig.y;
      }
    } else {
      /* 无火柴人：放在当前视图中心 */
      const c = D.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      ink.x = c.x; ink.y = c.y;
      if (fig) D.showToast(tr('brushPreset.noFigure', '当前画布没有火柴人，预设将按未绑定方式放置'));
    }

    D.addObjectToFrames(ink);
    D.select(ink);
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.EventBus.emit('history:save', '应用画笔预设');
    D.showToast(tr('brushPreset.toastApplied', '已应用预设：') + (preset.name || ''));
    return true;
  }

  function deletePresetById(id) {
    const i = presets.findIndex(p => p.id === id);
    if (i < 0) return false;
    presets.splice(i, 1);
    savePresets();
    refreshPresetOptions();
    D.showToast(tr('brushPreset.toastDeleted', '预设已删除'));
    return true;
  }

  function bindPresetUI() {
    const $ = (id) => document.getElementById(id);
    const btnSave = $('btnInkPresetSave');
    const btnApply = $('btnInkPresetApply');
    const btnDel = $('btnInkPresetDelete');
    const selEl = $('inkPresetSelect');
    if (btnSave) btnSave.addEventListener('click', () => savePresetFromSelection());
    if (btnApply) btnApply.addEventListener('click', () => {
      const id = selEl ? selEl.value : '';
      const p = presets.find(x => x.id === id);
      applyPreset(p);
    });
    if (btnDel) btnDel.addEventListener('click', () => {
      const id = selEl ? selEl.value : '';
      const p = presets.find(x => x.id === id);
      if (!p) { D.showToast(tr('brushPreset.toastNoPreset', '请先在列表里选择一个预设')); return; }
      if (!window.confirm(tr('brushPreset.confirmDelete', '确定删除这个画笔预设吗？'))) return;
      deletePresetById(id);
    });
  }

  /* ==================== 对外 API ==================== */
  function getEditingInk() { return editingInk; }

  return {
    init,
    boot,
    setOn,
    isOn,
    openNew,
    openEdit,
    finalize,
    cancel,
    autoBind,
    getEditingInk,
    undoLast,
    clearAll,
    /* v7.9.2：油漆桶填充选中画笔元件的闭合笔画 */
    bucketFill,
    bucketFillAt,
    setBucketMode,
    isBucketMode: () => bucketMode,
    isStrokeClosed,
    /* 预设 */
    getPresets: () => presets.map(p => ({ id: p.id, name: p.name, bindTo: p.bindTo, offX: p.offX, offY: p.offY })),
    savePreset: () => savePresetFromSelection(),
    applyPresetById: (id) => applyPreset(presets.find(p => p.id === id)),
    deletePresetById,
    /* v7.0.2：无头回归用的状态快照，不参与任何功能 */
    _debug: () => ({
      on: brushOn,
      drawing: drawing,
      ops: ops.length,
      points: (current && current.data && current.data.points) ? current.data.points.length : -1,
      pointers: pointers.size
    })
  };
})();
