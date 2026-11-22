/* 维护脚本：重新生成「SKFE插件作者工具包.zip」。在 SKFE 仓库根目录运行：node js/plugin-kit/build-kit.js */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');          // SKFE 仓库根目录
const KIT = __dirname;                                     // <根目录>/js/plugin-kit
let JSZip;
try { JSZip = require(path.join(ROOT, 'js', 'vendor', 'jszip.min.js')); }
catch (e) { console.error('加载 JSZip 失败:', e.message); process.exit(1); }

const zip = new JSZip();

function add(fromDisk, zipName) {
  const buf = fs.readFileSync(fromDisk);
  zip.file(zipName, buf);
  console.log('  + ' + zipName + '  (' + buf.length + ' B)');
}

console.log('打包 SKFE 插件作者工具包：');
// 说明文档（注意：内部设计稿 / 排雷记录 / 手册是给作者本人和 AI 看的，禁止打进这个公开工具包）
add(path.join(ROOT, '插件API参考.md'), '插件API参考.md');
add(path.join(KIT, '版权与授权声明.md'), '版权与授权声明.md');
add(path.join(KIT, 'README.md'), 'README-插件作者工具包.md');
// 模板与工具
add(path.join(KIT, 'manifest.template.json'), 'manifest.template.json');
add(path.join(KIT, 'manifest-code.json'), 'manifest-code.json');
add(path.join(KIT, 'validate-plugin.js'), 'validate-plugin.js');
add(path.join(KIT, 'build-kit.js'), 'build-kit.js');
// 示例代码与示例插件
add(path.join(KIT, 'example-code.js'), 'example-code.js');
add(path.join(KIT, 'example-data.json'), 'example-data.json');
add(path.join(KIT, 'example-code.zip'), '示例插件-代码型.zip');
// 画布网格叠加示例插件源码目录
const gridDir = path.join(ROOT, 'plugins', 'canvas-grid');
if (fs.existsSync(path.join(gridDir, 'manifest.json'))) {
  add(path.join(gridDir, 'manifest.json'), '示例插件-画布网格/manifest.json');
  add(path.join(gridDir, 'index.js'), '示例插件-画布网格/index.js');
  add(path.join(gridDir, 'README.md'), '示例插件-画布网格/README.md');
  console.log('    （已包含画布网格示例插件源码）');
  const readyZip = path.join(ROOT, 'plugins', 'canvas-grid.zip');
  if (fs.existsSync(readyZip)) {
    add(readyZip, 'canvas-grid.zip');
    console.log('    （已包含可直接导入的画布网格插件 zip）');
  }
}

const out = path.join(KIT, 'SKFE插件作者工具包.zip');
zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  .then(buf => {
    fs.writeFileSync(out, buf);
    console.log('\n完成: ' + out + '  (' + buf.length + ' B)');
  })
  .catch(e => { console.error('生成失败:', e); process.exit(1); });
