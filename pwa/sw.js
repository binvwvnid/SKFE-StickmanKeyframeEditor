/* SKFE PWA service worker
   策略：核心壳文件 stale-while-revalidate（先给缓存、后台更新），
   其余同源 GET 运行时缓存。版本号变了就整体换新，避免旧缓存卡住。 */
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
           底部栏分区标题栏圆角与内边距；PWA 缓存标签随 7.8.0 同步，避免旧缓存卡住。 */
const VERSION = 'skfe-v7.8.1';
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
    caches.open(VERSION).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
