/* ============================================================
 * SKFE 全开放插件 API v2.0.0  (js/plugins/api.js)
 * ------------------------------------------------------------
 * 完全信任模型下的统一入口：数据、状态、界面、事件、媒体、导出、
 * 编组、循环、关键帧，以及 SKFE 命名空间下任意路径的动态读写 / 调用。
 *
 * 这个对象不是沙箱：插件拿到的是主程序同一份引用。
 * 加载顺序：app.js 之后、js/plugins/host.js 之前。
 * ============================================================ */
(function () {
  'use strict';

  var SKFE = (window.SKFE = window.SKFE || {});
  if (SKFE.api) return;

  var App = SKFE.__skfe || window.__skfe || null;
  var Bus = SKFE.core && SKFE.core.eventBus && SKFE.core.eventBus.EventBus || null;
  var Group = SKFE.systems && SKFE.systems.group || null;
  var TrackStrip = SKFE.features && SKFE.features.trackStrip || null;

  function clone(value) {
    if (value == null) return value;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }

  function deepMerge(target, patch) {
    Object.keys(patch || {}).forEach(function (k) {
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

  function toParts(path) {
    return Array.isArray(path) ? path.slice() : String(path).split('.');
  }

  function resolve(path) {
    var parts = toParts(path);
    var root = SKFE;
    if (parts[0] === 'window') { root = window; parts.shift(); }
    else if (parts[0] === 'document') { root = document; parts.shift(); }
    else if (parts[0] === 'SKFE') { root = SKFE; parts.shift(); }
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (node == null) return { root: root, parts: parts, parent: null, leaf: parts[parts.length - 1], value: undefined };
      node = node[parts[i]];
    }
    var leaf = parts[parts.length - 1];
    return {
      root: root,
      parts: parts,
      parent: node,
      leaf: leaf,
      value: (node == null ? undefined : node[leaf])
    };
  }

  function get(path) {
    var r = resolve(path);
    return r.value;
  }

  function set(path, value) {
    var r = resolve(path);
    if (!r.parent) throw new Error('路径父节点不存在: ' + path);
    r.parent[r.leaf] = value;
    return value;
  }

  function call(path, args) {
    var r = resolve(path);
    if (typeof r.value !== 'function') throw new Error('不是可调用路径: ' + path);
    return r.value.apply(r.parent, Array.isArray(args) ? args : []);
  }

  function refresh(opts) {
    opts = opts || {};
    if (opts.silent) return;
    if (!Bus) return;
    if (opts.history) Bus.emit('app:update', opts.history);
    else {
      Bus.emit('need:render');
      if (opts.sync !== false) Bus.emit('need:syncUI');
    }
  }

  function requireApp() {
    if (!App) throw new Error('SKFE.__skfe 未就绪');
    return App;
  }

  function find(selector, root) {
    return (root || document).querySelector(selector);
  }

  function findAll(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function fireEl(el, type) {
    var Ctor = type === 'change' ? Event : InputEvent;
    var ev;
    try { ev = new Ctor(type, { bubbles: true }); }
    catch (_) { ev = document.createEvent('Event'); ev.initEvent(type, true, true); }
    el.dispatchEvent(ev);
  }

  function elementInfo(el) {
    if (!el) return null;
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id || null,
      className: String(el.className || ''),
      text: (el.textContent || '').trim().slice(0, 300),
      value: el.value === undefined ? null : String(el.value),
      checked: el.checked === undefined ? null : !!el.checked,
      disabled: el.disabled === undefined ? null : !!el.disabled,
      hidden: !!el.hidden || getComputedStyle(el).display === 'none',
      rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null
    };
  }

  function stateGet() {
    return clone(requireApp().AppState);
  }

  function statePatch(patch, opts) {
    var a = requireApp();
    deepMerge(a.AppState, patch || {});
    refresh(opts);
    return clone(a.AppState);
  }

  function projectGet() {
    var a = requireApp();
    if (typeof a.getProjectData === 'function') return clone(a.getProjectData());
    return clone({ frames: a.AppState.frames, tracks: a.AppState.tracks });
  }

  function projectApply(data) {
    var a = requireApp();
    return Promise.resolve(a.applyLoadedProject(clone(data))).then(function (r) {
      refresh({ sync: false });
      return r;
    });
  }

  function addMediaObject(kind, cfg) {
    var a = requireApp();
    cfg = cfg || {};
    var url = cfg.dataUrl || cfg.url || '';
    if (!url) throw new Error('缺少 dataUrl');
    var media = document.createElement('video');
    media.muted = true;
    media.playsInline = true;
    media.preload = 'auto';
    media.src = url;
    var obj;
    if (kind === 'audio') {
      obj = a.makeAudioClip(media, url, cfg.durationMs || 0, cfg.fps || 12);
      if (cfg.volume !== undefined) obj.volume = Math.max(0, Math.min(1, cfg.volume));
    } else {
      obj = a.makeVideoClip(media, url, cfg.w || 640, cfg.h || 360,
        cfg.x || 0, cfg.y || 0, cfg.durationMs || 0, cfg.fps || 12);
    }
    if (cfg.name) obj.name = String(cfg.name);
    a.addObjectToFrames(obj);
    var start = cfg.start;
    var end = cfg.end;
    if (typeof start === 'number' && typeof end === 'number') {
      var tr = a.AppState.tracks[String(obj.id)];
      if (tr && tr.frames) {
        var src = clone(obj);
        for (var i = Math.max(0, start); i <= Math.min(tr.frames.length - 1, end); i++) {
          tr.frames[i] = clone(src);
        }
      }
    }
    a.bumpKfEval();
    refresh({ history: cfg.history || (kind === 'audio' ? '插件：加入音频' : '插件：加入视频') });
    return obj.id;
  }

  function fillFrames(id, obj, start, end) {
    var a = requireApp();
    var tr = a.AppState.tracks[String(id)];
    if (!tr || !tr.frames) throw new Error('轨道不存在: ' + id);
    var lo = Math.max(0, Number(start) || 0);
    var hi = Math.min(tr.frames.length - 1, Number(end) || lo);
    for (var i = lo; i <= hi; i++) tr.frames[i] = clone(obj);
    a.bumpKfEval();
    return tr.frames.length;
  }

  var api = {
    version: '2.0.0',
    permissions: { fullAccess: true, sandbox: false, network: true, dom: true, data: true },

    /* 原始引用：与主程序完全同一份对象 */
    raw: {
      window: window,
      document: document,
      SKFE: SKFE,
      App: App,
      Bus: Bus,
      Group: Group,
      TrackStrip: TrackStrip
    },

    /* 动态路径读写 / 调用：覆盖所有已挂到 window / SKFE 下的能力 */
    get: get,
    set: set,
    call: call,
    invoke: function (path) {
      return call(path, Array.prototype.slice.call(arguments, 1));
    },
    evaluate: function (expression) {
      return new Function('SKFE', 'api', 'plugin', 'return (' + expression + ');')(
        SKFE, api, SKFE.plugin && SKFE.plugin.current
      );
    },
    execute: function (code) {
      return new Function('SKFE', 'api', 'plugin', code)(
        SKFE, api, SKFE.plugin && SKFE.plugin.current
      );
    },
    refresh: refresh,

    state: {
      raw: function () { return requireApp().AppState; },
      get: stateGet,
      patch: statePatch,
      set: function (path, value, opts) {
        set('SKFE.__skfe.AppState.' + path, value);
        refresh(opts);
        return stateGet();
      },
      getFrameIndex: function () { return requireApp().AppState.currentFrameIndex; },
      setFrameIndex: function (i, opts) {
        requireApp().goToFrame(i);
        refresh(opts);
        return requireApp().AppState.currentFrameIndex;
      }
    },

    data: {
      project: projectGet,
      applyProject: projectApply,
      clone: clone,
      getTrack: function (id) {
        var t = requireApp().AppState.tracks[String(id)];
        return t ? clone(t) : null;
      },
      setTrackFrame: function (id, idx, obj, opts) {
        var a = requireApp();
        var t = a.AppState.tracks[String(id)];
        if (!t) throw new Error('轨道不存在: ' + id);
        while (t.frames.length <= idx) t.frames.push(null);
        t.frames[idx] = obj == null ? null : clone(obj);
        a.bumpKfEval();
        refresh(opts);
        return clone(t.frames[idx]);
      },
      fillFrames: function (id, obj, start, end, opts) {
        var r = fillFrames(id, obj, start, end);
        refresh(opts);
        return r;
      },
      getFrameObjects: function (idx, trackId) {
        return clone(requireApp().getObjectsForFrameAt(
          typeof idx === 'number' ? idx : requireApp().AppState.currentFrameIndex,
          trackId || null
        ));
      },
      mediaSources: function () {
        var a = requireApp();
        function info(map) {
          var out = [];
          map.forEach(function (src, id) {
            out.push({
              id: id,
              hasData: !!src.dataUrl,
              hasBlobUrl: !!src.blobUrl,
              duration: src.video && isFinite(src.video.duration) ? src.video.duration : null,
              readyState: src.video ? src.video.readyState : null
            });
          });
          return out;
        }
        return { audio: info(a.audioClipSources), video: info(a.videoClipSources) };
      },
      audioEvents: function (n, tid) {
        var a = requireApp();
        return clone(a.collectAudioTimeline(n || a.AppState.frames.length, tid || null));
      }
    },

    object: {
      makeFigure: function (x, y, color, lw) { return requireApp().makeFigure(x, y, color, lw); },
      makeShape: function (type, x, y) { return requireApp().makeShape(type, x, y); },
      makeAccessory: function (img, x, y) { return requireApp().makeAccessory(img, x, y); },
      makeBubble: function (x, y) { return requireApp().makeBubble(x, y); },
      makeCamera: function (x, y) { return SKFE.systems.camera.makeCamera(x, y); },
      makeMaskField: function () { return clone(requireApp().makeMaskField()); },
      makeDistortField: function () { return clone(requireApp().makeDistortField()); },
      add: function (obj, opts) {
        requireApp().addObjectToFrames(obj);
        refresh(opts);
        return obj && obj.id;
      },
      select: function (obj) { requireApp().select(obj); refresh({ sync: false }); },
      bounds: function (o) { return requireApp().getObjectBounds(o); }
    },

    media: {
      addAudio: function (cfg) { return addMediaObject('audio', cfg); },
      addVideo: function (cfg) { return addMediaObject('video', cfg); },
      playAudio: function (idx) { requireApp().playAudioClips(idx); },
      pauseAudio: function () { requireApp().pauseAudioClips(); },
      playVideo: function (idx) { requireApp().playVideoClips(idx); }
    },

    frame: {
      goto: function (i, opts) { requireApp().goToFrame(i); refresh(opts); },
      add: function (opts) { requireApp().addFrame(); refresh(opts); },
      delete: function (opts) { requireApp().deleteFrame(); refresh(opts); },
      insert: function (n, opts) { requireApp().insertFrames(n); refresh(opts); },
      trimTail: function (opts) { requireApp().trimTrailingEmptyFrames(); refresh(opts); },
      startTime: function (i) { return requireApp().getFrameStartTime(i); }
    },

    keyframe: {
      toggle: function (opts) { requireApp().toggleKeyframe(); refresh(opts); },
      mark: function (trackId, idx, origin, opts) {
        var r = requireApp().markKey(trackId, idx, origin);
        refresh(opts);
        return r;
      },
      applyEase: function (key, opts) {
        var r = requireApp().applyEase(key);
        refresh(opts);
        return r;
      },
      applyChannelEase: function (objId, part, key, opts) {
        var r = requireApp().applyChannelEase(objId, part, key);
        refresh(opts);
        return r;
      },
      segment: function (trackId, idx) { return requireApp().segmentAhead(trackId, idx); },
      info: function (idx) {
        var a = requireApp();
        return {
          state: a.mainKeyStateAt(idx),
          partial: a.kfPartialNames(idx),
          kind: a.kfChipKind(idx)
        };
      }
    },

    group: {
      list: function () {
        if (!Group) return [];
        var ids = new Set();
        var tracks = requireApp().AppState.tracks;
        Object.keys(tracks).forEach(function (id) {
          (tracks[id].frames || []).forEach(function (slot) {
            if (slot && slot.type === 'group') ids.add(String(slot.gid || slot.id));
            else if (slot && slot.groupId != null) ids.add(String(slot.groupId));
          });
        });
        return Array.from(ids);
      },
      create: function (ids, opts) {
        if (!Group) throw new Error('编组系统未加载');
        var g = Group.createGroup(ids || []);
        refresh(opts);
        return g;
      },
      ungroup: function (gid, opts) {
        if (!Group) return false;
        var r = Group.ungroup(gid);
        refresh(opts);
        return r;
      },
      delete: function (gid, opts) {
        var a = requireApp();
        var r = a.deleteGroupById(gid);
        refresh(opts);
        return r;
      },
      enter: function (gid, opts) {
        if (!Group) return false;
        Group.enterGroup(gid);
        refresh(opts && opts.silent !== false ? opts : { sync: false });
        return true;
      },
      exit: function (opts) {
        if (!Group) return false;
        Group.exitGroup();
        refresh(opts && opts.silent !== false ? opts : { sync: false });
        return true;
      },
      editingId: function () { return Group ? Group.getEditingGroupId() : null; }
    },

    loop: {
      select: function (list) { if (TrackStrip) TrackStrip.debugSetClipSel(list || []); },
      selected: function () { return TrackStrip ? clone(TrackStrip.selectedClips()) : []; },
      get: function (id) { return TrackStrip ? clone(TrackStrip.debugLoops(id)) : []; },
      isOn: function (id, a, b) { return TrackStrip ? TrackStrip.isLoopClip(id, a, b) : false; },
      toggle: function () {
        if (!TrackStrip) return false;
        TrackStrip.toggleClipLoop();
        refresh({ sync: false });
        return true;
      }
    },

    ui: {
      query: function (selector, root) { return find(selector, root); },
      queryAll: function (selector, root) { return findAll(selector, root); },
      info: function (selector, root) { return elementInfo(find(selector, root)); },
      infoAll: function (selector, root) {
        return findAll(selector, root).map(function (el) { return elementInfo(el); });
      },
      anchors: function () {
        return findAll('button[id], input[id], select[id], textarea[id]').map(function (el) {
          return {
            selector: '#' + el.id,
            tag: String(el.tagName || '').toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 80),
            type: el.type || null
          };
        });
      },
      click: function (selector, opts) {
        var el = find(selector);
        if (!el) throw new Error('元素不存在: ' + selector);
        el.click();
        refresh(opts);
        return true;
      },
      setValue: function (selector, value, opts) {
        var el = find(selector);
        if (!el) throw new Error('元素不存在: ' + selector);
        el.value = value;
        fireEl(el, 'input');
        fireEl(el, 'change');
        refresh(opts);
        return el.value;
      },
      setChecked: function (selector, checked, opts) {
        var el = find(selector);
        if (!el) throw new Error('元素不存在: ' + selector);
        el.checked = !!checked;
        fireEl(el, 'change');
        refresh(opts);
        return el.checked;
      },
      setText: function (selector, text, opts) {
        var el = find(selector);
        if (!el) throw new Error('元素不存在: ' + selector);
        el.textContent = text == null ? '' : String(text);
        refresh(opts);
        return el.textContent;
      },
      setHTML: function (selector, html, opts) {
        var el = find(selector);
        if (!el) throw new Error('元素不存在: ' + selector);
        el.innerHTML = html == null ? '' : String(html);
        refresh(opts);
        return el.innerHTML;
      },
      attr: function (selector, name, value) {
        var el = find(selector);
        if (!el) throw new Error('元素不存在: ' + selector);
        if (value === undefined) return el.getAttribute(name);
        el.setAttribute(name, value);
        return value;
      },
      openSheet: function (key) {
        requireApp().switchUiSheet(key);
        return key || null;
      },
      setTool: function (name) { requireApp().setActiveTool(name); },
      trackMode: function (on) {
        if (!TrackStrip) return false;
        TrackStrip.setEnabled(!!on);
        return !!on;
      },
      dockTimeline: function (mode) {
        requireApp().applyTimelineDock(mode);
        refresh();
        return mode;
      },
      waitFor: function (selector, timeout) {
        var limit = timeout || 5000;
        return new Promise(function (resolve, reject) {
          var t0 = Date.now();
          (function tick() {
            var el = find(selector);
            if (el) { resolve(el); return; }
            if (Date.now() - t0 >= limit) { reject(new Error('等待元素超时: ' + selector)); return; }
            setTimeout(tick, 50);
          })();
        });
      }
    },

    events: {
      on: function (event, cb) { if (Bus) Bus.on(event, cb); return cb; },
      once: function (event, cb) { return Bus ? Bus.once(event, cb) : cb; },
      off: function (event, cb) { return Bus ? Bus.off(event, cb) : false; },
      clear: function (event) { return Bus ? Bus.clear(event) : false; },
      emit: function (event) {
        if (!Bus) return;
        Bus.emit.apply(Bus, arguments);
      },
      list: function () { return Bus ? Object.keys(Bus.events || {}) : []; }
    },

    history: {
      undo: function () { requireApp().undo(); refresh(); },
      redo: function () { requireApp().redo(); refresh(); },
      save: function (label, ms) { requireApp().saveHistory(label, ms); },
      run: function (label, fn) {
        var r = requireApp().txRun(label, fn);
        refresh();
        return r;
      },
      size: function () { return requireApp().historySize(); }
    },

    export: {
      image: function (format) { requireApp().exportImage(format); },
      pngs: function () { requireApp().exportSelectedPNGs(); },
      jpgs: function () { requireApp().exportSelectedJPGs(); },
      gif: function () { requireApp().exportSelectedGIF(); },
      svg: function () { requireApp().exportSelectedSVGs(); },
      mp4: function () { return SKFE.features.export.exportMP4(); },
      webm: function () { return SKFE.features.export.exportVideo(); },
      project: function (name) { return requireApp().exportProjectJSON(name); }
    },

    render: {
      frameToCanvas: function (frame, w, h, options, trackId) {
        return requireApp().renderFrameToDataURL(frame, w, h, options, trackId);
      },
      scene: function (list, opts) { requireApp().renderScene(list, opts); }
    },

    /* MCP / JSON-RPC 风格入口：AI 插件只需要 call(method, params) 一个函数 */
    mcp: {
      methods: function () { return Object.keys(methods).sort(); },
      call: function (method, params) {
        var name = String(method || '').replace(/^skfe\./, '');
        var fn = methods[name];
        if (!fn) throw new Error('未知 MCP 方法: ' + method);
        return fn(params || {});
      },
      dispatch: function (request) {
        var req = request || {};
        try {
          return {
            jsonrpc: '2.0',
            id: req.id === undefined ? null : req.id,
            result: api.mcp.call(req.method, req.params || {})
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id: req.id === undefined ? null : req.id,
            error: { code: -32603, message: String(err && err.message || err) }
          };
        }
      }
    }
  };

  var methods = {
    'api.version': function () { return api.version; },
    'state.get': function (p) { return stateGet(); },
    'state.patch': function (p) { return statePatch(p.patch || p, p); },
    'state.frame.set': function (p) { return api.state.setFrameIndex(p.index, p); },
    'project.get': function () { return projectGet(); },
    'project.apply': function (p) { return projectApply(p.data || p); },
    'track.get': function (p) { return api.data.getTrack(p.id); },
    'track.setFrame': function (p) { return api.data.setTrackFrame(p.id, p.index, p.object, p); },
    'track.fillFrames': function (p) { return api.data.fillFrames(p.id, p.object, p.start, p.end, p); },
    'frame.objects': function (p) { return api.data.getFrameObjects(p.index, p.trackId); },
    'object.add': function (p) { return api.object.add(p.object, p); },
    'object.makeFigure': function (p) { return api.object.makeFigure(p.x || 0, p.y || 0, p.color, p.lw); },
    'media.addAudio': function (p) { return api.media.addAudio(p); },
    'media.addVideo': function (p) { return api.media.addVideo(p); },
    'media.sources': function () { return api.data.mediaSources(); },
    'media.audioEvents': function (p) { return api.data.audioEvents(p.frames, p.trackId); },
    'keyframe.toggle': function (p) { return api.keyframe.toggle(p); },
    'keyframe.mark': function (p) { return api.keyframe.mark(p.trackId, p.index, p.origin, p); },
    'keyframe.info': function (p) { return api.keyframe.info(p.index); },
    'group.list': function () { return api.group.list(); },
    'group.create': function (p) { return api.group.create(p.ids, p); },
    'group.delete': function (p) { return api.group.delete(p.id, p); },
    'group.enter': function (p) { return api.group.enter(p.id, p); },
    'group.exit': function (p) { return api.group.exit(p); },
    'loop.get': function (p) { return api.loop.get(p.id); },
    'loop.toggle': function (p) { return api.loop.toggle(); },
    'ui.anchors': function () { return api.ui.anchors(); },
    'ui.info': function (p) { return api.ui.info(p.selector); },
    'ui.click': function (p) { return api.ui.click(p.selector, p); },
    'ui.setValue': function (p) { return api.ui.setValue(p.selector, p.value, p); },
    'ui.setChecked': function (p) { return api.ui.setChecked(p.selector, p.checked, p); },
    'ui.setText': function (p) { return api.ui.setText(p.selector, p.text, p); },
    'ui.openSheet': function (p) { return api.ui.openSheet(p.key); },
    'ui.setTool': function (p) { return api.ui.setTool(p.name); },
    'ui.trackMode': function (p) { return api.ui.trackMode(p.on); },
    'events.list': function () { return api.events.list(); },
    'events.emit': function (p) { return api.events.emit.apply(api.events, [p.event].concat(p.args || [])); },
    'history.undo': function () { return api.history.undo(); },
    'history.redo': function () { return api.history.redo(); },
    'history.run': function (p) {
      var a = requireApp();
      return a.txRun(p.label || 'MCP 批量操作', function () {
        return (p.ops || []).map(function (op) {
          return api.mcp.call(op.method, op.params || {});
        });
      });
    },
    'export.mp4': function () { return api.export.mp4(); },
    'export.webm': function () { return api.export.webm(); },
    'export.project': function (p) { return api.export.project(p.name); },
    'raw.get': function (p) { return clone(get(p.path)); },
    'raw.set': function (p) { return set(p.path, p.value); },
    'raw.call': function (p) { return clone(call(p.path, p.args || [])); },
    'raw.evaluate': function (p) { return clone(api.evaluate(p.expression)); },
    'raw.execute': function (p) { return clone(api.execute(p.code)); }
  };

  SKFE.api = api;
})();
