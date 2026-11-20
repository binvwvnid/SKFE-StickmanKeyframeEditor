/* SKFE 代码型插件示例 —— index.js
 * 功能：在真实工具容器 #toolChips 加一个按钮，点一下在当前帧加一个火柴人。
 * 打包：把本文件改名为 index.js，与 manifest.json 一起压成 zip 即可导入。
 */
(function () {
  'use strict';

  var S = window.SKFE;
  var App = S && S.__skfe;                 // P0 已常驻暴露
  var Bus = S && S.core && S.core.eventBus && S.core.eventBus.EventBus;

  if (!App || !Bus) {
    console.warn('[示例插件] 内部接口未就绪，插件未加载');
    return;
  }

  function addStickman() {
    // makeFigure(x, y, color, lw) —— 真实签名
    var fig = App.makeFigure(0, 0, '#111111', 10.5);
    // addObjectToFrames(obj) —— 只接一个对象
    App.addObjectToFrames(fig);
    // 记历史 + 整体刷新
    Bus.emit('app:update', '示例插件：加火柴人');
  }

  function install() {
    var bar = document.getElementById('toolChips');   // 真实容器，不是 #toolbar
    if (!bar) return;
    var btn = document.createElement('button');
    btn.className = 'tool-chip';
    btn.textContent = '加火柴人';
    btn.addEventListener('click', addStickman);
    bar.appendChild(btn);
    console.log('[示例插件] 已安装');
  }

  install();
})();
