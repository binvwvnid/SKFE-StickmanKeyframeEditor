/* SKFE PWA service worker
   策略：同源 GET 一律 network-first（先取网络，成功即更新缓存并返回本次结果），
   离线才回退运行时缓存。绝不让旧 HTML / 旧 JS 先渲染再被替换，消除刷新时的旧页面闪现。 */
/* 缓存标签：改这个字符串即可让浏览器丢弃旧缓存。
   v7.7.1：SVG 导出按钮补进导出面板 + 视频元件改整体视频（带声音、不抽帧）。
   v7.7.3：非火柴人元件蒙版按钮（基础蒙版 + 色度抠图）。
   v7.7.4：蒙版参数改一项即自动启用；删除视频清理音轨；SVG 手绘头型矩阵修正。
   v7.7.6：视频默认铺满原长、只在轨道段落内播放画面与声音；蒙版/色度抠图拆成两个独立开关。
   v7.7.0：正式发布——含上述全部新功能（SVG 序列 / 视频元件 / 蒙版），随 package.json 同步。
   v7.7.7：移动端轨道改为「按下即拖」（原长按 1 秒判定导致长按拖动/拉长段落没反应）；
           触屏手柄命中区 10→22px；竖滑仍可滚动轨道。
   v7.7.8：画布至少 5% 留在屏幕内（所有平移/缩放加 clamp）；固定视图后禁止改画布 xy 世界坐标。
   v7.8.0：本地插件系统（数据型/代码型，完全信任模型）；主题面板背景渐变内置为原生功能；
           底部栏分区标题栏圆角与内边距；PWA 缓存标签随 7.8.0 同步，避免旧缓存卡住。
   v7.8.3o：编组旋转 + 四角扭曲组合：修正 warpCv 世界→像素矩阵 b/c 写反。
   v7.8.3p：编组按一等父变换对象实现，中心锚点为局部原点；恢复扭曲源图的组父变换，扭曲框跟随旋转框。
   v7.8.3q：进入编组时统一清掉组载体的选中态、扭曲编辑框与变换框，属性面板不再显示组。
   v7.8.3r：退出编组时按组锚点等比扩大组框，保持组外层变换与扭曲形状不变，成员不再被旧框裁掉。
   v7.8.3s：轨道控制栏文案明确为「复制关键帧 / 粘贴关键帧」，与帧面板「复制帧」区分。
   v7.8.3t：轨道 clip / 编组段循环填充；开启后拉长按原段周期重复，关闭时仍复制边缘帧。
   v7.8.3u：工具栏顺序；手机轨道底部栏占位与播放头居中、全面板双指缩放；循环周期缩短不裁切；删除编组连带成员。
   v7.8.4a：恢复 v7.8.1 移动端轨道底部栏机制；手机复制/粘贴关键帧恢复文字；工程音轨导入后就绪补播；MP4/WebM 导出混入音频。
   v7.8.4b：新增 js/plugins/api.js 全开放插件/MCP API；代码型插件注入 api 第三参数；EventBus 补 off/once/clear。
   v7.8.4c：修复安卓客户端插件作者工具包 ZIP 下载——原生壳改用 platform.saveURL 写文件并系统分享。
   v7.9.3：移动端播放头固定与横滑、油漆桶、画笔类型、扭曲操作优化；缓存标签随之刷新。 */
const VERSION = 'skfe-local-v7.9.3';
const SHELL = ['./', './index.html', './style.css', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => {
            c.put(req, copy.clone());
            /* 带 ?v= 刷新的导航也要覆盖预缓存首页，避免下一次离线回退拿到旧 HTML。 */
            if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
              c.put('./', copy.clone());
              c.put('./index.html', copy.clone());
            }
          }).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => {
        if (r) return r;
        /* 带查询串的导航在离线时回落到预缓存首页 */
        return req.mode === 'navigate'
          ? caches.match('./').then((r2) => r2 || caches.match('./index.html'))
          : null;
      }))
  );
});
