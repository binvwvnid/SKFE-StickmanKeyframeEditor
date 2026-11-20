#!/usr/bin/env node
/* SKFE 插件格式校验脚本
 * 用法：node js/plugin-kit/validate-plugin.js <path>
 *   <path> 可以是 .json（数据型）、.zip（代码型），或含 manifest.json 的目录。
 * 只校验格式，不校验安全性（完全信任模型下没有安全边界可校验）。
 * 版本号从 js/version.js 读取，不硬编码。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');           // js/
const VERSION_FILE = path.join(ROOT, 'version.js');

function readVersion() {
  const txt = fs.readFileSync(VERSION_FILE, 'utf8');
  const m = txt.match(/SKFE\.version\s*=\s*'([^']+)'/);
  return m ? m[1] : '0.0.0';
}
function parseVer(v) {
  return String(v || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
}
function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  return 0;
}
function satisfies(range, current) {
  const m = String(range || '').match(/^(>=|<=|=|>|<)?\s*(\d+\.\d+\.\d+)$/);
  if (!m) return true; // 无法解析则放行（与宿主一致）
  const op = m[1] || '>=', c = cmpVer(current, m[2]);
  if (op === '>') return c > 0;
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  if (op === '=') return c === 0;
  return c >= 0;
}

const REQUIRED = ['id', 'name', 'version', 'type', 'skfeVersion'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function validateManifest(m, ctx) {
  const errs = [];
  REQUIRED.forEach(k => { if (!m[k]) errs.push('缺少必填字段: ' + k); });
  if (m.id && !ID_RE.test(m.id)) errs.push('id 格式不合法（应为字母/数字开头，只含 A-Za-z0-9._-）: ' + m.id);
  if (m.version && !SEMVER_RE.test(m.version)) errs.push('version 不是 semver（如 1.0.0）: ' + m.version);
  if (m.type && m.type !== 'data' && m.type !== 'code') errs.push('type 必须是 "data" 或 "code": ' + m.type);
  if (m.skfeVersion && !/^(>=|<=|=|>|<)?\s*\d+\.\d+\.\d+$/.test(m.skfeVersion)) {
    errs.push('skfeVersion 不是可解析的范围（如 >=7.7.0）: ' + m.skfeVersion);
  }
  if (m.type === 'code' && !m.entry) errs.push('代码型插件缺少 entry 字段');
  if (m.type === 'data' && !m.contributes) errs.push('数据型插件缺少 contributes 字段');
  return errs;
}

function inspectDir(dir) {
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) return { errs: ['目录内缺少 manifest.json'] };
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); }
  catch (e) { return { errs: ['manifest.json 解析失败: ' + e.message] }; }
  const errs = validateManifest(m);
  const files = [];
  (function walk(d, rel) {
    fs.readdirSync(d).forEach(n => {
      const p = path.join(d, n), r = rel ? rel + '/' + n : n;
      if (fs.statSync(p).isDirectory()) walk(p, r); else files.push(r);
    });
  })(dir, '');
  if (m.type === 'code') {
    if (m.entry && !files.includes(m.entry) && !fs.existsSync(path.join(dir, m.entry))) errs.push('entry 文件不存在: ' + m.entry);
    if (m.icon && !files.includes(m.icon) && !fs.existsSync(path.join(dir, m.icon))) errs.push('图标文件不存在: ' + m.icon);
  }
  return { manifest: m, errs, files };
}

function inspectJson(file) {
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { errs: ['JSON 解析失败: ' + e.message] }; }
  const errs = validateManifest(m);
  if (m.type === 'data' && !m.contributes) errs.push('数据型插件缺少 contributes 字段');
  return { manifest: m, errs, files: [path.basename(file)] };
}

function inspectZip(file) {
  let JSZip;
  try { JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js')); }
  catch (e) { return { errs: ['无法加载内置 JSZip: ' + e.message] }; }
  return JSZip.loadAsync(fs.readFileSync(file)).then(zip => {
    const mf = zip.file('manifest.json');
    if (!mf) return { errs: ['zip 根目录缺少 manifest.json'] };
    return mf.async('string').then(txt => {
      let m;
      try { m = JSON.parse(txt); }
      catch (e) { return { errs: ['manifest.json 解析失败: ' + e.message] }; }
      const errs = validateManifest(m);
      const files = Object.keys(zip.files).filter(n => !zip.files[n].dir);
      if (m.type === 'code') {
        if (m.entry && !files.includes(m.entry)) errs.push('entry 文件不存在于 zip: ' + m.entry);
        if (m.icon && !files.includes(m.icon)) errs.push('图标文件不存在于 zip: ' + m.icon);
      }
      return { manifest: m, errs, files };
    });
  });
}

function report(result, filePath, version) {
  const m = result.manifest || {};
  console.log('\n=== SKFE 插件格式校验 ===');
  console.log('文件: ' + filePath);
  console.log('当前 SKFE 版本: ' + version);
  if (m.id) {
    console.log('id: ' + m.id + '  name: ' + m.name + '  type: ' + m.type + '  version: ' + m.version);
    if (m.skfeVersion) {
      const ok = satisfies(m.skfeVersion, version);
      console.log('skfeVersion: ' + m.skfeVersion + '  ' + (ok ? '[兼容]' : '[警告：可能不兼容，宿主仍会放行]'));
    }
  }
  if (result.files) console.log('文件数: ' + result.files.length + '  ' + result.files.slice(0, 12).join(', '));
  if (result.errs && result.errs.length) {
    console.log('\n[失败] 发现 ' + result.errs.length + ' 个问题:');
    result.errs.forEach(e => console.log('  - ' + e));
    process.exitCode = 1;
  } else {
    console.log('\n[通过] 格式校验通过，可以导入。');
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log('用法: node js/plugin-kit/validate-plugin.js <path>');
    console.log('  <path> 为 .json / .zip 文件或含 manifest.json 的目录');
    process.exit(1);
  }
  const version = readVersion();
  const target = path.resolve(arg);
  let result;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) result = inspectDir(target);
  else if (/\.zip$/i.test(target)) result = inspectZip(target);
  else if (/\.json$/i.test(target)) result = inspectJson(target);
  else { console.log('不支持的文件类型: ' + target); process.exit(1); }

  Promise.resolve(result).then(r => report(r, target, version)).catch(e => {
    console.error('校验出错: ' + (e && e.stack || e));
    process.exitCode = 1;
  });
}
main();
