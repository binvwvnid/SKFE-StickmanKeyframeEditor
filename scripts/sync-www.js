/**
 * 把源码（index.html / style.css / js/**）同步到一个干净的 www/ 目录，
 * 并注入 PWA 相关的 <link> 与 Service Worker 注册。
 *
 * 为什么不在根目录直接打包：
 *  - Capacitor 的 webDir 需要一个"只含前端产物"的目录，避免把 node_modules / android 一起拷进 App；
 *  - PWA 的 manifest / SW 只在 http(s) 下有意义，注入到产物里，源码双击 file:// 打开仍然干净。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/* 从 README.md 全文生成「使用说明」浮窗内容。
   为什么生成 js 而不是运行时 fetch README：
   - 用户经常直接双击根目录 index.html（file://），fetch 本地文件会被浏览器 CORS 拦；
   - PWA / Electron / 安卓壳都要能用，生成静态 JS 最稳；
   - README 仍是唯一内容来源，不会在两处文案之间漂移。 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMd(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  /* 目录锚点不能开新标签（点了会闪退/开无用页面），单独标记由前端拦截成浮窗内滚动 */
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
    if (href.charAt(0) === '#') {
      return '<a class="skfe-help-anchor" href="' + href + '">' + label + '</a>';
    }
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  /* README 里的裸网址（网页版 / 安装包 / 项目分享）也做成可点击链接。
     放在最后一步，避免命中上面已生成的 <a href="..."> 或 <code>。 */
  out = out.replace(/(^|[\s：:：(])(https?:\/\/[^\s<>"']+)/g,
    (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
  return out;
}

/* 生成标题 id，规则与 GitHub 目录锚点一致：小写、空格转 -、去掉标点、保留中英文数字 */
function mdSlug(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^\w\u4e00-\u9fa5\- ]/g, '')
    .replace(/\s+/g, '-');
}

function splitTableRow(line) {
  return line.trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(s => s.trim());
}

function isTableSeparator(line) {
  const t = line.trim();
  if (!t.includes('-')) return false;
  return t.replace(/\|/g, '').replace(/[\s:-]/g, '') === '';
}

function readmeToHtml(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (t.startsWith('```')) {
      closeLists();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i++; }
      out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }

    if (t.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeLists();
      const header = splitTableRow(lines[i]);
      i += 2;
      out.push('<table><thead><tr>' + header.map(c => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>');
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitTableRow(lines[i]);
        out.push('<tr>' + cells.map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>');
        i++;
      }
      i--;
      out.push('</tbody></table>');
      continue;
    }

    if (!t) { closeLists(); continue; }
    if (t === '---') { closeLists(); out.push('<hr>'); continue; }

    let m = raw.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      closeLists();
      const level = Math.min(6, m[1].length + 1);
      const id = mdSlug(m[2]);
      out.push('<h' + level + (id ? ' id="' + id + '"' : '') + '>' + inlineMd(m[2]) + '</h' + level + '>');
      continue;
    }
    m = raw.match(/^-\s+(.*)$/);
    if (m) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push('<li>' + inlineMd(m[1]) + '</li>');
      continue;
    }
    m = raw.match(/^\d+\.\s+(.*)$/);
    if (m) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push('<li>' + inlineMd(m[1]) + '</li>');
      continue;
    }
    m = raw.match(/^>\s?(.*)$/);
    if (m) { closeLists(); out.push('<p class="skfe-help-quote">' + inlineMd(m[1]) + '</p>'); continue; }

    closeLists();
    out.push('<p>' + inlineMd(raw) + '</p>');
  }
  closeLists();
  return out.join('');
}

function buildHelpContent() {
  const readmeZhPath = path.join(ROOT, 'README.md');
  const readmeEnPath = path.join(ROOT, 'README.en.md');
  const zhHtml = fs.existsSync(readmeZhPath)
    ? readmeToHtml(fs.readFileSync(readmeZhPath, 'utf8'))
    : '<p>README.md 不存在，帮助内容未生成。</p>';
  const enHtml = fs.existsSync(readmeEnPath)
    ? readmeToHtml(fs.readFileSync(readmeEnPath, 'utf8'))
    : '<p>README.en.md is missing; English help content was not generated.</p>';
  const js = [
    '/* 自动生成：由 scripts/sync-www.js 从 README.md / README.en.md 全文生成。请勿手改。 */',
    'window.SKFE = window.SKFE || {};',
    'window.SKFE.helpContent = {',
    "  source: 'README.md',",
    "  title: '使用说明',",
    '  html: ' + JSON.stringify(zhHtml) + ', /* 兼容旧调用：默认中文 */',
    "  zh: { source: 'README.md', title: '使用说明', html: " + JSON.stringify(zhHtml) + ' },',
    "  en: { source: 'README.en.md', title: 'Guide', html: " + JSON.stringify(enHtml) + ' },',
    '};',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'js', 'help-content.js'), js, 'utf8');
  console.log('[sync] 从 README.md / README.en.md 生成中英帮助内容');
}

/* 从 SKFE更新记录.md 生成「更新记录」浮窗内容。
   与帮助浮窗同理：生成静态 JS，避免 file:// / PWA / 原生壳下 fetch Markdown 被拦。
   更新记录只有一份中文时间线，中英文界面都读同一份（条目本身是历史记录，不翻译）。 */
function buildChangeLogContent() {
  const mdPath = path.join(ROOT, 'SKFE更新记录.md');
  const html = fs.existsSync(mdPath)
    ? readmeToHtml(fs.readFileSync(mdPath, 'utf8'))
    : '<p>更新记录暂不可用，SKFE更新记录.md 未找到。</p>';
  const js = [
    '/* 自动生成：由 scripts/sync-www.js 从 SKFE更新记录.md 全文生成。请勿手改。 */',
    'window.SKFE = window.SKFE || {};',
    'window.SKFE.changeLogContent = {',
    "  source: 'SKFE更新记录.md',",
    "  title: '更新记录',",
    '  html: ' + JSON.stringify(html) + ', /* 兼容默认调用 */',
    "  zh: { source: 'SKFE更新记录.md', title: '更新记录', html: " + JSON.stringify(html) + ' },',
    "  en: { source: 'SKFE更新记录.md', title: 'Changelog', html: " + JSON.stringify(html) + ' },',
    '};',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'js', 'changelog-content.js'), js, 'utf8');
  console.log('[sync] 从 SKFE更新记录.md 生成更新记录内容');
}

console.log('[sync] 清理 www/');
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

console.log('[sync] 复制前端文件');
buildHelpContent();
buildChangeLogContent();
for (const f of ['index.html', 'style.css']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
copyDir(path.join(ROOT, 'js'), path.join(OUT, 'js'));

// PWA 资源
const pwaDir = path.join(ROOT, 'pwa');
if (fs.existsSync(pwaDir)) {
  copyDir(pwaDir, OUT);
  console.log('[sync] 复制 PWA 资源');
}

// 注入 manifest / 图标 / SW 注册
const headInject = [
  '  <link rel="manifest" href="./manifest.webmanifest">',
  '  <link rel="icon" type="image/png" href="./icons/icon-192.png">',
  '  <meta name="theme-color" content="#2f7d4f">',
  '  <meta name="apple-mobile-web-app-capable" content="yes">',
  '  <meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '  <meta name="apple-mobile-web-app-title" content="SKFE">',
  '  <link rel="apple-touch-icon" href="./icons/icon-192.png">',
  ''
].join('\n');

const bodyInject = [
  '',
  '  <!-- PWA：仅在 http(s) 下注册 Service Worker，file:// 与 Capacitor 内部协议下自动跳过 -->',
  '  <script>',
  '  (function () {',
  "    if (!/^https?:$/.test(location.protocol)) return;",
  '    /* v7.0.1：原生壳（Capacitor）里资源本来就是本地的，再套一层 SW 只会让',
  '       升级后仍旧跑到旧缓存里的 JS —— 那时表现就是「导出全部没反应」。直接跳过。 */',
  '    try {',
  '      var C = window.Capacitor;',
  '      if (C && ((typeof C.isNativePlatform === "function" && C.isNativePlatform()) || C.isNative === true)) return;',
  '    } catch (e) {}',
  "    if ('serviceWorker' in navigator) {",
  "      window.addEventListener('load', function () {",
  "        navigator.serviceWorker.register('./sw.js').catch(function () {});",
  '      });',
  '    }',
  '  })();',
  '  </script>',
  '</body>'
].join('\n');

const idxPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(idxPath, 'utf8');
if (!html.includes('manifest.webmanifest')) {
  html = html.replace('</head>', headInject + '</head>');
}
if (!html.includes("navigator.serviceWorker.register")) {
  // 注意：源码里 </body> 后面还跟着注释（`</body> <!-- ... -->`），不能按行尾匹配
  html = html.replace('</body>', bodyInject);
}
fs.writeFileSync(idxPath, html);

// 自检：确保关键文件都在
const required = ['index.html', 'style.css', 'js/app.js', 'js/help-content.js', 'js/changelog-content.js', 'js/systems/headShapes.js', 'js/systems/keyframes.js', 'manifest.webmanifest', 'sw.js'];
const missing = required.filter(f => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
  console.error('[sync] 缺少文件: ' + missing.join(', '));
  process.exit(1);
}

// 统计体积，便于判断安装包大小
let bytes = 0;
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p); else bytes += st.size;
  }
})(OUT);

console.log(`[sync] 完成 → www/  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
