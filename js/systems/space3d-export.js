/* ============================================================================
   SKFE 轻量 3D 模式 · 阶段 4 导出适配层
   ----------------------------------------------------------------------------
   职责：
   1. 判断当前是否处于 3D 导出路径；
   2. 把「指定帧 + 导出尺寸 + 透明/背景色」转发给 space3d.js 的离屏渲染 API；
   3. 让 GIF / PNG / JPG / MP4 / WebM 继续吃普通 2D canvas，不改原编码器；
   4. SVG 序列是 2D 矢量录制器，3D 面片无法无损转成 SVG，因此 3D 下禁用。

   本文件不引用 Three.js，不碰编码库，只在 2D 导出入口做最小分流。
   ============================================================================ */
(function () {
  'use strict';

  var root = window.SKFE = window.SKFE || {};
  root.systems = root.systems || {};

  function scene3d() {
    return root.systems && root.systems.space3d;
  }

  function isActive() {
    var s = scene3d();
    return !!(s && typeof s.isEnabled === 'function' && s.isEnabled() &&
      typeof s.renderFrameToCanvas === 'function');
  }

  function renderFrameToCanvas(targetCanvas, outW, outH, frameIndex, options) {
    var s = scene3d();
    if (!s || typeof s.renderFrameToCanvas !== 'function') return false;
    return !!s.renderFrameToCanvas(targetCanvas, outW, outH, frameIndex, options);
  }

  /* 与 app.js 的 renderFrameToDataURL 返回形态一致：始终返回一张 2D canvas。 */
  function renderFrameToDataURL(frameIndex, outW, outH, options, trackId, outCanvas) {
    var opts = Object.assign({}, options || {});
    if (trackId != null) opts.trackId = trackId;
    var off = outCanvas || document.createElement('canvas');
    if (!renderFrameToCanvas(off, outW, outH, frameIndex, opts)) return null;
    return off;
  }

  root.systems.space3dExport = {
    isActive: isActive,
    renderFrameToCanvas: renderFrameToCanvas,
    renderFrameToDataURL: renderFrameToDataURL,
    isSvgAllowed: function () { return !isActive(); }
  };
})();
