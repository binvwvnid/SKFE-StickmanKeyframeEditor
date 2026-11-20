/* ============================================================
 * SKFE 本地插件宿主 v1.0.0  (js/plugins/host.js)
 * ------------------------------------------------------------
 * 纯本地、完全信任模型：插件由用户手动导入，只写 IndexedDB，
 * 不改动任何仓库源码。职责：解析 / 校验 / 存储 / 执行 / 管理。
 *
 * 加载顺序：必须在 js/app.js 之后（window.SKFE.__skfe 已就绪）。
 * 数据与代码型共用一套 manifest；数据型合并 window.SKFE 下路径，
 * 代码型以 new Function 执行 zip 内入口 JS，拥有与主程序同级能力。
 * ============================================================ */
(function () {
  'use strict';

  var SKFE = (window.SKFE = window.SKFE || {});
  var T = function (key, vars) { return window.t ? window.t(key, vars) : key; };

  /* ---------------- IndexedDB ---------------- */
  var DB_NAME = 'skfe-plugins';
  var STORE = 'plugins';
  var db = null;

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (db) { resolve(db); return; }
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var database = e.target.result;
          if (!database.objectStoreNames.contains(STORE)) {
            database.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function (e) { db = e.target.result; resolve(db); };
        req.onerror = function (e) { reject(e.target.error); };
      } catch (err) { reject(err); }
    });
  }

  function dbGetAll() {
    return openDB().then(function (database) {
      return new Promise(function (resolve, reject) {
        var req = database.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function dbPut(record) {
    return openDB().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  function dbDelete(id) {
    return openDB().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  /* ---------------- 版本比较 ---------------- */
  function parseVer(v) {
    var parts = String(v || '0.0.0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  function cmpVer(a, b) {
    for (var i = 0; i < 3; i++) {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
    return 0;
  }
  /** 校验 skfeVersion 范围；支持 >= / > / = / 纯版本号。无法解析时返回 true（不误杀）。 */
  function satisfies(range, current) {
    if (!range || !String(range).trim()) return true;
    var m = String(range).trim().match(/^(>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})/);
    if (!m) return true;
    var op = m[1] || '>=';
    var need = parseVer(m[2]);
    var cur = parseVer(current);
    var c = cmpVer(cur, need);
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '<=') return c <= 0;
    if (op === '=') return c === 0;
    return c >= 0; /* >= 及默认 */
  }

  /* ---------------- manifest 校验 ---------------- */
  var REQUIRED = ['id', 'name', 'version', 'type', 'skfeVersion'];
  function validate(manifest) {
    var missing = REQUIRED.filter(function (k) { return !manifest[k]; });
    if (missing.length) return { ok: false, error: T('plugin.missingField', { fields: missing.join(', ') }) };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id)) {
      return { ok: false, error: 'Invalid plugin id: ' + manifest.id };
    }
    if (manifest.type !== 'data' && manifest.type !== 'code') {
      return { ok: false, error: 'manifest.type must be "data" or "code"' };
    }
    return { ok: true };
  }

  /* ---------------- 文件读取 ---------------- */
  var TEXT_EXT = /\.(js|json|css|txt|svg|html?|md|xml|csv|yaml|yml)$/i;

  /* JSZip 的 file.async() 不支持 'dataURL'（support 里无此项），
     二进制统一读成 base64，再按扩展名拼成 data URL 供 assetURL() 使用。 */
  var MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    pdf: 'application/pdf'
  };
  function toDataURL(name, base64) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var mime = MIME[ext] || 'application/octet-stream';
    return 'data:' + mime + ';base64,' + base64;
  }

  function readDataFile(file) {
    return file.text().then(function (text) {
      var manifest;
      try { manifest = JSON.parse(text); }
      catch (e) { throw new Error(T('plugin.badJson', { msg: e.message })); }
      return {
        manifest: manifest,
        files: { 'manifest.json': text },
        format: 'data'
      };
    });
  }

  function readCodeFile(file) {
    if (typeof JSZip === 'undefined') {
      return Promise.reject(new Error('JSZip 未加载（js/vendor/jszip.min.js 缺失）'));
    }
    return file.arrayBuffer().then(function (buf) {
      return JSZip.loadAsync(buf);
    }).then(function (zip) {
      var manifestFile = zip.file('manifest.json');
      if (!manifestFile) throw new Error(T('plugin.noManifest'));
      return manifestFile.async('string').then(function (mtext) {
        var manifest;
        try { manifest = JSON.parse(mtext); }
        catch (e) { throw new Error(T('plugin.badJson', { msg: e.message })); }
        var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir; });
        var jobs = names.map(function (name) {
          var isText = TEXT_EXT.test(name);
          return zip.file(name).async(isText ? 'string' : 'base64').then(function (content) {
            return { name: name, content: isText ? content : toDataURL(name, content) };
          });
        });
        return Promise.all(jobs).then(function (pairs) {
          var files = {};
          pairs.forEach(function (p) { files[p.name] = p.content; });
          return { manifest: manifest, files: files, format: 'code' };
        });
      });
    });
  }

  /* ---------------- 执行插件 ---------------- */
  function deepMerge(target, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else {
        target[k] = v;
      }
    });
    return target;
  }

  /** 数据型：contributes 的键是 window.SKFE 下的相对路径，递归合并，失败跳过并报错。 */
  function applyData(record) {
    var contributes = record.manifest.contributes || {};
    Object.keys(contributes).forEach(function (path) {
      try {
        var parts = path.split('.');
        var node = SKFE;
        for (var i = 0; i < parts.length - 1; i++) {
          if (node == null || typeof node !== 'object') {
            throw new Error('路径断裂: ' + parts.slice(0, i + 1).join('.'));
          }
          node = node[parts[i]];
        }
        var leaf = parts[parts.length - 1];
        if (node == null || typeof node !== 'object') {
          throw new Error('父路径不存在: ' + parts.slice(0, -1).join('.'));
        }
        var value = contributes[path];
        var prev = node[leaf];
        if (prev && typeof prev === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
          deepMerge(prev, value);
        } else {
          node[leaf] = value;
        }
      } catch (err) {
        console.warn('[SKFE plugin] 数据覆写失败', record.manifest.id, path, err);
      }
    });
    var bus = SKFE.core && SKFE.core.eventBus && SKFE.core.eventBus.EventBus;
    if (bus) bus.emit('need:render');
  }

  var disableHandlers = {}; /* pluginId -> fn[]（可选约定） */

  /** 代码型：new Function 执行入口 JS，完全信任，暴露读取自身资源的 runtime。 */
  function applyCode(record) {
    var manifest = record.manifest;
    var entry = manifest.entry || 'index.js';
    var files = record.files || {};
    var code = files[entry];
    if (typeof code !== 'string') throw new Error('入口文件不存在: ' + entry);

    function readFile(path) {
      var key = Object.keys(files).filter(function (n) { return n === path || n.endsWith('/' + path); })[0];
      if (!key) return Promise.reject(new Error('文件不存在: ' + path));
      return Promise.resolve(files[key]);
    }
    function assetURL(path) {
      var key = Object.keys(files).filter(function (n) { return n === path || n.endsWith('/' + path); })[0];
      if (!key) return null;
      var v = files[key];
      if (typeof v === 'string' && v.indexOf('data:') === 0) return v;
      return null;
    }

    var runtime = {
      id: manifest.id,
      version: manifest.version,
      files: files,
      readFile: readFile,
      assetURL: assetURL,
      onDisable: function (fn) {
        (disableHandlers[manifest.id] = disableHandlers[manifest.id] || []).push(fn);
      }
    };
    SKFE.plugin = SKFE.plugin || {};
    SKFE.plugin.current = runtime;

    /* 插件能力：window.SKFE.__skfe（内部接口）+ SKFE.core/features/systems + DOM + 网络，全部可达 */
    var runner = new Function('SKFE', 'plugin', '"use strict";\n' + code);
    runner(SKFE, runtime);
  }

  function runRecord(record) {
    try {
      if (record.manifest.type === 'code') applyCode(record);
      else applyData(record);
    } catch (err) {
      console.error('[SKFE plugin] 执行失败', record.manifest.id, err);
    }
  }

  /* ---------------- 导入流程 ---------------- */
  function importFile(file) {
    var name = (file.name || '').toLowerCase();
    var isJson = name.endsWith('.json');
    var isZip = name.endsWith('.zip');
    if (!isJson && !isZip) return Promise.reject(new Error(T('plugin.rejectFormat')));

    return (isZip ? readCodeFile(file) : readDataFile(file)).then(function (parsed) {
      var check = validate(parsed.manifest);
      if (!check.ok) throw new Error(check.error);

      /* 代码型：文件引用存在性校验 */
      if (parsed.manifest.type === 'code') {
        var entry = parsed.manifest.entry || 'index.js';
        if (!parsed.files[entry]) throw new Error('入口文件不存在于压缩包: ' + entry);
      }

      var versionOK = satisfies(parsed.manifest.skfeVersion, SKFE.version);
      var upgrade = false;

      return dbGetAll().then(function (all) {
        var existing = all.filter(function (r) { return r.id === parsed.manifest.id; })[0];
        if (existing) {
          upgrade = true;
          if (!window.confirm(T('plugin.sameIdUpgrade', { name: parsed.manifest.name }))) {
            throw new Error('__CANCELLED__');
          }
        }
        if (!versionOK) {
          var msg = T('plugin.versionWarn') + '\n' +
            T('plugin.manifestNeeds', { need: parsed.manifest.skfeVersion, cur: SKFE.version });
          if (!window.confirm(msg + '\n\n' + T('plugin.keepImport') + ' / ' + T('plugin.cancel') + ' ?')) {
            throw new Error('__CANCELLED__');
          }
        }
        if (parsed.manifest.type === 'code') {
          if (!window.confirm(T('plugin.riskTitle') + '\n\n' + T('plugin.riskBody'))) {
            throw new Error('__CANCELLED__');
          }
        }
        var record = {
          id: parsed.manifest.id,
          manifest: parsed.manifest,
          files: parsed.files,
          enabled: existing ? existing.enabled : true,
          installedAt: existing ? existing.installedAt : Date.now()
        };
        return dbPut(record).then(function () {
          if (record.enabled) runRecord(record); /* 立即执行（升级保留启用态时同样立即生效） */
          return record;
        });
      });
    });
  }

  /* ---------------- UI 渲染 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function renderList() {
    var box = document.getElementById('pluginList');
    if (!box) return;
    dbGetAll().then(function (all) {
      all.sort(function (a, b) { return (a.installedAt || 0) - (b.installedAt || 0); });
      if (!all.length) {
        box.innerHTML = '<div class="plugin-empty">' + esc(T('plugin.empty')) + '</div>';
        return;
      }
      box.innerHTML = all.map(function (r) {
        var m = r.manifest;
        var typeLabel = m.type === 'code' ? T('plugin.typeCode') : T('plugin.typeData');
        var badgeCls = m.type === 'code' ? 'code' : '';
        var statusLabel = r.enabled ? T('plugin.enabled') : T('plugin.disabled');
        var offCls = r.enabled ? '' : 'off';
        var toggleLabel = r.enabled ? T('plugin.btnDisable') : T('plugin.btnEnable');
        var meta = 'v' + esc(m.version) + ' · SKFE ' + esc(m.skfeVersion) + (m.author ? ' · ' + esc(m.author) : '');
        return '<div class="plugin-card ' + offCls + '" data-id="' + esc(r.id) + '">' +
          '<div class="plugin-head">' +
            '<span class="plugin-title">' + esc(m.name) + '</span>' +
            '<span class="plugin-badge ' + badgeCls + '">' + esc(typeLabel) + '</span>' +
            '<span class="plugin-badge ' + (r.enabled ? '' : 'off') + '">' + esc(statusLabel) + '</span>' +
          '</div>' +
          '<div class="plugin-meta">' + meta + (m.description ? '<br>' + esc(m.description) : '') + '</div>' +
          '<div class="plugin-actions">' +
            '<button class="btn-xs btn-soft" data-act="toggle" data-id="' + esc(r.id) + '">' + esc(toggleLabel) + '</button>' +
            '<button class="btn-xs btn-danger" data-act="delete" data-id="' + esc(r.id) + '">' + esc(T('plugin.btnDelete')) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }).catch(function (err) {
      box.innerHTML = '<div class="plugin-empty">' + esc(T('plugin.importFail', { msg: err.message })) + '</div>';
    });
  }

  function bindUI() {
    var fileInput = document.getElementById('pluginFileInput');
    var importBtn = document.getElementById('btnImportPlugin');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        importFile(file).then(function (record) {
          alert(T('plugin.importOk', { name: record.manifest.name }));
          renderList();
        }).catch(function (err) {
          if (err.message === '__CANCELLED__') return;
          alert(T('plugin.importFail', { msg: err.message }));
        });
      });
    }
    var list = document.getElementById('pluginList');
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-act]');
        if (!btn) return;
        var id = btn.getAttribute('data-id');
        var act = btn.getAttribute('data-act');
        if (act === 'toggle') {
          dbGetAll().then(function (all) {
            var rec = all.filter(function (r) { return r.id === id; })[0];
            if (!rec) return;
            rec.enabled = !rec.enabled;
            return dbPut(rec).then(renderList);
          });
        } else if (act === 'delete') {
          dbGetAll().then(function (all) {
            var rec = all.filter(function (r) { return r.id === id; })[0];
            if (!rec) return;
            if (!window.confirm(T('plugin.confirmDelete', { name: rec.manifest.name }))) return;
            var handlers = disableHandlers[id] || [];
            handlers.forEach(function (fn) { try { fn(); } catch (e) {} });
            return dbDelete(id).then(function () {
              alert(T('plugin.needReload'));
              renderList();
            });
          });
        }
      });
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    /* mountUiSheets 把分区标题 append 到了末尾，移到顶部保持与其它分区一致 */
    var sheet = document.getElementById('sheetPlugins');
    if (sheet) {
      var head = sheet.querySelector('.ui-sheet-head');
      if (head && sheet.firstChild !== head) sheet.insertBefore(head, sheet.firstChild);
    }
    bindUI();
    renderList();

    /* 扫描并运行已启用插件，按 installedAt 升序 */
    dbGetAll().then(function (all) {
      all = all.filter(function (r) { return r.enabled; });
      all.sort(function (a, b) { return (a.installedAt || 0) - (b.installedAt || 0); });
      all.forEach(runRecord);
    }).catch(function (err) {
      console.warn('[SKFE plugin] 启动扫描失败', err);
    });
  }

  /* 公开 API（供插件与排障使用） */
  SKFE.plugin = SKFE.plugin || {};
  SKFE.plugin.importFile = importFile;
  SKFE.plugin.list = dbGetAll;
  SKFE.plugin.version = '1.0.0';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
