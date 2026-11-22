/*! SKFE 编组系统 v7.9.1
 *  把多个元件编成一个「组」：成员保留各自的轨道与真实数据，只是多一个 groupId 标签；
 *  另建一条 type:'group' 的载体轨作为一等父变换节点，承载整体位移/缩放/旋转/镜像/透明度与中心锚点。
 *
 *  核心语义（用户明确要求）：
 *   - 组是整体对象，中心锚点 (ax/ay=0) 就是它的局部坐标原点；
 *   - 整体变换由组载体承载，不会改写成员元件的真实数据；
 *   - 组外只显示组；进组后成员轨展开，成员显示为原样（跳过父变换，直接画成员）。
 *
 *  本模块不直接依赖 app.js 内部作用域，全部通过 setHooks 注入（与 distort/camera 同构）。 */
(function () {
  'use strict';

  const H = {
    getTracks: null,        // () => tracks map
    getFrame: null,         // (id, idx) => obj | null
    getObjsAt: null,        // (idx) => current frame object list
    getObb: null,           // (obj) => source OBB {corners:[4]}
    renderMembers: null,    // (members, opts) => void 画成员到当前 ctx（世界坐标）
    getCtx: null,           // () => canvas 2d ctx（可变）
    getSelected: null,      // () => obj|null
    select: null,           // (obj) => void
    getFrameIndex: null,    // () => number
    getTotalFrames: null,   // () => number
    nextUid: null,          // () => number
    generateName: null,     // (obj) => void
    cloneKeepImg: null,     // (obj) => deep clone keeping img
    setTracksDirty: null,   // () => void 数据改过之后的统一收尾(刷新/渲染/历史)
    onEnterGroup: null,     // () => void 进组前清掉组载体的选中/扭曲框/变换框状态
    onExitGroup: null,      // (gid) => void 退出时按成员最新范围等比扩框，保持原组效果
    t: null                 // (key, fallback) => string
  };
  function setHooks(h) { if (!h) return; for (const k in h) if (Object.prototype.hasOwnProperty.call(h, k)) H[k] = h[k]; }
  function call(name) { const f = H[name]; return typeof f === 'function' ? f.apply(null, [].slice.call(arguments, 1)) : null; }
  function tr(k, fb) { return call('t', k, fb) || fb; }

  /* 正在编辑的组载体 id（字符串轨 id）；null 表示不在任何组内 */
  let editingGroupId = null;
  function getEditingGroupId() { return editingGroupId; }
  function setEditingGroupId(gid) { editingGroupId = gid ? String(gid) : null; }
  function isEditing(gid) { return !!gid && editingGroupId === String(gid); }

  function tracks() { return call('getTracks') || {}; }
  function isGroup(o) { return !!(o && o.type === 'group'); }
  function gidOf(o) { return (o && o.groupId) ? String(o.groupId) : null; }

  /* 当前帧所有组载体对象 */
  function groupsAt(idx) {
    const n = idx != null ? idx : call('getFrameIndex');
    const out = [];
    const tk = tracks();
    for (const id in tk) {
      const o = call('getFrame', id, n);
      if (isGroup(o)) { o.__gid = id; out.push(o); }
    }
    return out;
  }

  /* 某组在某帧的成员对象列表（不修改它们的数据） */
  function membersOf(gid, idx) {
    const g = String(gid);
    const n = idx != null ? idx : call('getFrameIndex');
    const out = [];
    const tk = tracks();
    for (const id in tk) {
      if (id === g) continue;
      const o = call('getFrame', id, n);
      if (o && gidOf(o) === g && !isGroup(o)) out.push(o);
    }
    return out;
  }

  /* 某组在哪些帧出场（载体轨非空的帧索引），用于把载体铺到成员并集 */
  function groupSpan(gid) {
    const t = tracks()[String(gid)];
    if (!t || !t.frames) return { a: -1, b: -1 };
    let a = -1, b = -1;
    for (let i = 0; i < t.frames.length; i++) {
      if (t.frames[i]) { if (a < 0) a = i; b = i; }
    }
    return { a, b };
  }

  /* 由一组成员轨 id 建组。members 为轨 id 字符串数组。返回载体轨 id 或 null。 */
  function createGroup(memberIds) {
    const ids = (memberIds || []).map(String).filter(Boolean);
    if (ids.length < 2) return null;
    const n = call('getFrameIndex');
    const tk = tracks();
    const total = Math.max(1, call('getTotalFrames') || 1);

    /* 校验：成员必须存在、不是组/摄像机/参考视频/音频、尚未属于别的组 */
    const valid = [];
    for (const id of ids) {
      const o = call('getFrame', id, n);
      if (!o || isGroup(o)) continue;
      if (o.type === 'camera' || o.type === 'video' || o.type === 'audioClip') continue;
      if (gidOf(o)) continue;                       // 已在别的组里 → 不重复编入
      valid.push(id);
    }
    if (valid.length < 2) return null;

    /* 计算成员并集帧范围 + 世界包围盒。
       v7.9.0 修正：不能只取当前帧。用户要的是「元件」语义 —— 火柴人跨很多帧走动、
       长条留在原地时，组的总框要把整段运动的全部范围都包住，中心作为默认锚点。 */
    let a = total, b = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of valid) {
      const t = tk[id];
      if (t && t.frames) {
        for (let i = 0; i < t.frames.length; i++) if (t.frames[i]) { if (i < a) a = i; if (i > b) b = i; }
      }
      /* 每一帧都求值一次：拿的是最终画面位置，不是原始数据，也不改成员本身。 */
      for (let i = 0; i < total; i++) {
        const oi = call('getFrame', id, i);
        if (!oi) continue;
        const obb = call('getObb', oi);
        if (!obb || !obb.corners) continue;
        for (const p of obb.corners) {
          if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
      }
    }
    if (!(maxX > minX && maxY > minY)) { a = 0; b = total - 1; minX = 0; minY = 0; maxX = 1; maxY = 1; }
    if (a > b) { a = 0; b = total - 1; }

    const gnum = call('nextUid');
    /* 载体轨 id 必须与载体对象 id 对齐：主程序绝大多数轨道逻辑（全局属性、
       撤销、删除、clip 伸缩、缩略图）都按 String(obj.id) 找 track。 */
    const gid = String(gnum);
    const kids = valid.slice();

    /* 编组名字按现有组顺序编号：编组1 / 编组2 / 编组3……
       不用全局 uid，否则建过几个元件后第一组会从很大的数字开始。 */
    let groupNo = 1;
    for (const tid in tk) {
      const t = tk[tid];
      if (!t || !t.frames) continue;
      for (const slot of t.frames) {
        if (!slot || slot.type !== 'group') continue;
        const m = String(slot.name || '').match(/(\d+)\s*$/);
        if (m) groupNo = Math.max(groupNo, parseInt(m[1], 10) + 1);
      }
    }

    /* 1) 给所有成员所有帧贴 groupId（对象级，不是单帧） */
    for (const id of valid) {
      const t = tk[id];
      if (!t || !t.frames) continue;
      for (let i = 0; i < t.frames.length; i++) {
        const o = t.frames[i];
        if (o && typeof o === 'object' && !o.__d) o.groupId = gid;
      }
    }

    /* 2) 建载体对象（外层变换初值 = 成员并集包围盒中心，w/h = 盒尺寸） */
    const proto = {
      id: gnum, gid: gid, type: 'group', childIds: kids,
      x: (minX + maxX) / 2, y: (minY + maxY) / 2,
      bx: (minX + maxX) / 2, by: (minY + maxY) / 2,   // 建组时的原始中心
      w: maxX - minX, h: maxY - minY,
      scale: 1, rot: 0, mirror: false, alpha: 1,
      /* v7.9.0：编组锚点固定在组包围盒中心；旋转 / 缩放用这个中心识别，不跟成员自身锚点混淆 */
      ax: 0, ay: 0,
      layer: 0, hidden: false, locked: false,
      distort: { enabled: false, corners: null }
    };
    call('generateName', proto);
    proto.name = tr('group.name', '编组') + groupNo;

    /* 3) 建载体轨，铺满成员并集帧范围；每帧一份 clone，同 id */
    const arr = new Array(total).fill(null);
    for (let i = a; i <= b; i++) {
      const c = call('cloneKeepImg', proto);
      c.id = proto.id;
      arr[i] = c;
    }
    tk[gid] = { name: proto.name || 'Group', frames: arr };

    if (typeof setEditingGroupId === 'function') setEditingGroupId(null);
    if (call('setTracksDirty')) call('setTracksDirty');
    return gid;
  }

  /* 解组：清掉成员所有帧的 groupId，删除载体轨；不改动成员任何画面数据 */
  function ungroup(gid) {
    const g = String(gid);
    const tk = tracks();
    const carrier = call('getFrame', g, call('getFrameIndex'));
    const kids = (carrier && carrier.childIds) ? carrier.childIds.slice() : [];
    /* 兜底：即便 childIds 丢了，也按当前帧 groupId 扫一遍 */
    for (const id in tk) {
      if (id === g) continue;
      const t = tk[id];
      if (!t || !t.frames) continue;
      for (let i = 0; i < t.frames.length; i++) {
        const o = t.frames[i];
        if (o && typeof o === 'object' && gidOf(o) === g) o.groupId = undefined;
      }
    }
    delete tk[g];
    if (editingGroupId === g) editingGroupId = null;
    if (call('setTracksDirty')) call('setTracksDirty');
    return kids;
  }

  /* 删除整组：解组只留在画布上会残留成员，所以这里把成员轨一起删掉。
     返回被删掉的成员 id，调用方负责释放媒体源、刷新 UI 与记历史。 */
  function deleteGroup(gid) {
    const g = String(gid);
    const tk = tracks();
    if (!tk[g]) return [];
    const kids = new Set();
    const carrierFrames = tk[g].frames || [];
    for (const slot of carrierFrames) {
      if (slot && slot.type === 'group' && Array.isArray(slot.childIds)) {
        slot.childIds.forEach(id => kids.add(String(id)));
      }
    }
    /* 兜底：childIds 丢了也按所有帧的 groupId 扫 */
    for (const id in tk) {
      if (id === g) continue;
      const t = tk[id];
      if (!t || !t.frames) continue;
      for (const slot of t.frames) {
        if (slot && typeof slot === 'object' && gidOf(slot) === g) { kids.add(String(id)); break; }
      }
    }
    const ids = Array.from(kids).filter(id => id && id !== g);
    ungroup(g);                    /* 清 groupId + 删载体轨 */
    ids.forEach(id => { delete tk[id]; });
    if (editingGroupId === g) editingGroupId = null;
    if (call('setTracksDirty')) call('setTracksDirty');
    return ids;
  }

  /* 进入 / 退出组编辑 */
  function enterGroup(gid) {
    if (!tracks()[String(gid)]) return;
    /* 进组后只编辑成员：组载体不能被选中，它的扭曲框/变换框也必须收起。
       所有入口（元件列表双击、底部按钮、轨道按钮）统一在这里清状态。 */
    if (typeof H.onEnterGroup === 'function') call('onEnterGroup');
    editingGroupId = String(gid);
    if (call('setTracksDirty')) call('setTracksDirty');
  }
  function exitGroup() {
    if (!editingGroupId) return;
    /* 先按成员最新范围等比扩框，再清编辑态；扩框只动载体 w/h 与扭曲基准，
       不动成员数据、组锚点、外层 affine，因此原组变换/扭曲效果保持不变。 */
    if (typeof H.onExitGroup === 'function') call('onExitGroup', editingGroupId);
    editingGroupId = null;
    if (call('setTracksDirty')) call('setTracksDirty');
  }

  SKFE = SKFE || {};
  SKFE.systems = SKFE.systems || {};
  SKFE.systems.group = {
    setHooks,
    isGroup, gidOf, groupsAt, membersOf, groupSpan,
    createGroup, ungroup, deleteGroup,
    getEditingGroupId, setEditingGroupId, isEditing, enterGroup, exitGroup
  };
})();
