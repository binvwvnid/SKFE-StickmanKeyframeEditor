/* ============================================================
 * SKFE 代码型示例插件 —— 画布网格叠加
 * ------------------------------------------------------------
 * 效果：在「画布」分区底部加一个开关按钮，开启后画布上叠加一层
 *       线网格（与 SKFE 自带的点阵网格不同），可自定义间距与颜色。
 *
 * 用到的真实接口（均已在源码核实）：
 *   - SKFE.__skfe.AppState.viewScale / viewOffset —— 视图缩放与偏移
 *   - SKFE.core.eventBus.EventBus.on('need:render') —— 渲染后补画
 *   - 画布 #c、document.getElementById('c').getContext('2d')
 *
 * 关键点：EventBus 只有 on/emit，没有 off。禁用时不能注销监听，
 *   所以用 installed 标志让回调直接返回（这是官方推荐做法）。
 *   网格只在编辑时叠加，不影响任何导出（导出走独立 octx）。
 *
 * 数据：localStorage（skfe_plugin_canvas_grid_v1），只存本机。
 * 清理：plugin.onDisable 移除 UI 与监听生效标志。
 * ============================================================ */
(function () {
  'use strict';

  var S = window.SKFE || {};
  var App = S.__skfe;
  var Bus = S.core && S.core.eventBus && S.core.eventBus.EventBus;

  if (!App || !Bus || !App.AppState) {
    console.warn('[画布网格] 内部接口未就绪，插件未加载');
    return;
  }

  var STORE_KEY = 'skfe_plugin_canvas_grid_v1';
  var PANEL_ID = 'skfe-plugin-canvas-grid-panel';

  /* ---------- 状态 ---------- */
  function defaults() { return { enabled: false, size: 64, color: '#7aa7c7', alpha: 0.3 }; }
  function loadState() {
    var def = defaults();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return def;
      var s = JSON.parse(raw);
      return {
        enabled: !!s.enabled,
        size: Math.max(16, Math.min(400, Number(s.size) || def.size)),
        color: s.color || def.color,
        alpha: Math.max(0.05, Math.min(1, Number(s.alpha) || def.alpha))
      };
    } catch (e) { return def; }
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  var state = loadState();
  var installed = true;   /* onDisable 后置 false —— 代替不存在的 EventBus.off */

  /* ---------- 颜色 #rrggbb + alpha → rgba() ---------- */
  function rgba(hex, a) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return 'rgba(122,167,199,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- 核心：在画布上叠加线网格（屏幕坐标系） ---------- */
  function drawOverlay() {
    if (!installed || !state.enabled) return;
    var cv = document.getElementById('c');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var A = App.AppState;
    var sc = A.viewScale || 1;
    var ox = A.viewOffset && A.viewOffset.x || 0;
    var oy = A.viewOffset && A.viewOffset.y || 0;

    /* 世界间距 size → 屏幕间距；跟随视图缩放，与自带点阵网格对齐 */
    var step = state.size * sc;
    if (step < 4) return;   /* 缩得太小就不画，避免铺满细线 */

    /* 屏幕坐标下第一条网格线的位置（对 step 取模，支持负偏移） */
    var startX = ((ox % step) + step) % step;
    var startY = ((oy % step) + step) % step;
    var w = cv.clientWidth;
    var h = cv.clientHeight;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   /* 强制回到屏幕坐标系 */
    ctx.strokeStyle = rgba(state.color, state.alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = startX; x <= w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (var y = startY; y <= h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
    ctx.restore();
  }

  /* 该监听在 app.js 自身的 need:render 监听之后注册，
     所以 emit 时先跑主程序渲染、再跑这里 —— 网格叠在最上层。 */
  Bus.on('need:render', drawOverlay);

  /* ---------- 构建 UI：追加到「画布」分区底部 ---------- */
  function panelRoot() {
    return document.querySelector('.tool-panel[data-tool="canvas"]') ||
           document.getElementById('canvasSettingsPanel');
  }

  function buildUI() {
    var panel = panelRoot();
    if (!panel) return;
    var old = document.getElementById(PANEL_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.className = 'subpanel';
    box.id = PANEL_ID;
    box.style.marginTop = '10px';
    box.innerHTML =
      '<div class="row" style="margin-top:6px;">' +
        '<button id="skfeGridToggle" class="btn-soft" style="flex:1;">' +
          (state.enabled ? '关闭网格叠加' : '开启网格叠加') + '</button>' +
      '</div>' +
      '<div id="skfeGridOpts" class="subpanel"' + (state.enabled ? '' : ' hidden') + '>' +
        '<div class="row slider"><label>网格间距</label>' +
          '<input type="range" id="skfeGridSize" min="16" max="200" step="4" value="' + state.size + '">' +
          '<span class="val" id="skfeGridSizeVal">' + state.size + '</span></div>' +
        '<div class="row"><label>网格颜色</label>' +
          '<input type="color" id="skfeGridColor" value="' + state.color + '"></div>' +
      '</div>' +
      '<div class="hint" style="font-size:10px;opacity:.75;margin-top:4px;">' +
        '插件示例：叠加线网格辅助对位，仅编辑时可见，不写入导出文件。</div>';

    panel.appendChild(box);

    var btn = document.getElementById('skfeGridToggle');
    var opts = document.getElementById('skfeGridOpts');
    var size = document.getElementById('skfeGridSize');
    var sizeVal = document.getElementById('skfeGridSizeVal');
    var color = document.getElementById('skfeGridColor');

    btn.addEventListener('click', function () {
      state.enabled = !state.enabled;
      btn.textContent = state.enabled ? '关闭网格叠加' : '开启网格叠加';
      opts.hidden = !state.enabled;
      saveState();
      Bus.emit('need:render');
    });
    size.addEventListener('input', function () {
      state.size = Number(size.value) || 64;
      sizeVal.textContent = state.size;
      saveState();
      Bus.emit('need:render');
    });
    color.addEventListener('input', function () {
      state.color = color.value;
      saveState();
      Bus.emit('need:render');
    });
  }

  buildUI();

  /* ---------- 禁用/删除时清理（EventBus 无 off，用标志位） ---------- */
  function cleanup() {
    installed = false;
    var box = document.getElementById(PANEL_ID);
    if (box && box.parentNode) box.parentNode.removeChild(box);
    Bus.emit('need:render');   /* 触发一次重绘，把已画的网格刷掉 */
  }
  if (plugin && typeof plugin.onDisable === 'function') plugin.onDisable(cleanup);
})();
