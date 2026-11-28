# SKFE 插件 API 参考

> 适用版本：SKFE v8.0.0　│　插件 API v2.1.0　│　核实日期：2026-11-28
> 源码仓库：https://github.com/binvwvnid/SKFE-StickmanKeyframeEditor
>
> **这份文档给谁**：插件作者，以及被托付写插件的 AI。
>
> **这份文档的用法**：只讲"照着抄就能跑"的公开接口；内部设计背景与取舍不随仓库发布。
> 这里所有签名、字段名、DOM id、事件名都逐条对着 SKFE v8.0.0 源码核实过，**没有一处是猜的**。
>
> **关于行号**：文中所有 `文件:行号` 基于 v8.0.0 快照，仅供快速定位；源码后续改动会让行号漂移。
> 找不到时用**函数名 / 常量名 / DOM id / 事件名**搜索，不要依赖行号。
>
> **授权提醒**：SKFE 不是开源项目。只允许两种情况：① 获得作者明确授权后修改；② 按官方接口制作并私下分享插件。
> 禁止二次公开发布本体或修改版、打包售卖、抹消作者署名、QQ 群与版本水印。
> 完整条款见 `README.md` 开头与作者工具包内《版权与授权声明.md》。

---

## 0. 先读这段：三个致命前提

**前提一：内部接口已常驻暴露，无需 `?debug=1`。**
P0 已实施：`window.__skfe` 无条件暴露（app.js:17172），并同时挂到
`window.SKFE.__skfe`（app.js:17244）与兼容别名 `window.__SKFE_DBG`。
插件直接用 `S.__skfe` 即可。前提是宿主 `js/plugins/host.js` 已在 `app.js` 之后加载
（index.html 末尾），否则 `SKFE.plugin` 不存在、插件面板无法导入。

**前提二：参数签名必须照这里写，不能凭函数名猜。**
举三个真实坑：
- `addObjectToFrames(obj)` 只接**一个元件对象**，不是 `(x, y, type)`。
- `renderFrameToDataURL(...)` 名字叫 DataURL，实际返回 **canvas 对象**，不是字符串。
- `getTrackSlot(trackId, idx)` 的 `trackId` 不做字符串转换，传数字会取不到。

**前提三：改完状态必须自己请求刷新。**
宿主不会自动帮你重绘。改完 `AppState` 后调用：
```js
window.SKFE.core.eventBus.EventBus.emit('need:render');
```
这是"刷新界面"的正确姿势。别调 `renderScene()`——它只往画布上画，不更新任何 UI。

---

## 1. 运行时环境

### 1.1 命名空间树

所有能力都挂在 `window` 上。下面是**当前源码里真实存在**的全局对象：

```
window
├── SKFE
│   ├── core
│   │   ├── constants       P, TAU, displayY, TRACK_ALL_ID
│   │   ├── eventBus        .EventBus.on / .emit          （没有 off）
│   │   ├── colorUtils      darkenColor, hexToRgb, ...
│   │   └── geometry        along, norm, distToSeg, ...
│   ├── features
│   │   ├── ease            TWEEN_EASE_PRESETS, getEaseFunction, ...
│   │   ├── theme           getConfig, applyThemeConfig, ...
│   │   ├── colorTools      sampleCanvasColor, openSwatches, ...
│   │   ├── export          exportPNGsAsZip, exportGIF, exportMP4, ...  （多为 async）
│   │   └── trackStrip      render, refresh, copyKeys, ...
│   ├── systems
│   │   ├── autosave        openAutoArchiveDB, saveToAutoArchive, ...
│   │   ├── brush           setOn, setBrushType, getBrushConfig, setBucketMode, ...
│   │   ├── camera          makeCamera, getCameraViewTransform, drawCameraViewMask, ...
│   │   ├── distort         solveHomography, setEnabled, drawWarpedBitmap, ...
│   │   ├── eraser          setOn, startStroke, hitObject, cancelStroke, ...
│   │   ├── group           createGroup, ungroup, enterGroup, exitGroup, ...
│   │   ├── headShapes      get, list, path2d, draw, ...
│   │   ├── keyframes       KEY, DERIVED, markKey, locate, interpolateObject, ...
│   │   ├── space3d         setEnabled, setCameraMode, renderFrameToCanvas, ...
│   │   ├── space3dData     camera2d / camera3d 默认值、归一化、编组坐标换算
│   │   ├── space3dExport   isActive, renderFrameToCanvas, renderFrameToDataURL
│   │   └── spatial         defaultLines, drawZVariedLimb, ...
│   ├── platform            isNative, save, saveBlob, saveDataURL, ...
│   ├── __skfe              ← 内部接口全量常驻（见第 2 节）
│   ├── api                 ← v2.0.0 全开放入口（见第 2.9 节）
│   └── plugin              importFile / list / api / current
├── SKFE_LOCALES            多语言词条
├── SKFE_I18N / t           多语言框架
├── SKFEIcon / SKFEApplyIcons   图标库
└── __skfe / __SKFE_DBG     ← 已常驻暴露（app.js:17172/17241/17244）
```

### 1.2 初始化时序（重要）

- `app.js` 是一个大 IIFE（app.js:2 `(function () {` … 17245 `})();`），**不是 ES module**。
- 事件监听在 `init()` 里绑定，`init()` 是被立即调用的 IIFE（app.js:16958–17021），
  **没有**包在 `DOMContentLoaded` 里。
- `app.js` 不是最后一个 `<script>`：它后面还有 `js/vendor/jszip.min.js` 和
  `js/plugins/host.js`（index.html:1225–1226）。`app.js` 执行时 DOM 已就绪。
- **结论**：插件宿主放在 `app.js` 之后加载是安全的——DOM 和 `AppState` 都已就绪。
  插件入口 `index.js` 由宿主在执行导入时运行，此时 DOM 早已就绪，可直接操作。

### 1.3 事件系统

`EventBus` 定义在 js/core/event-bus.js，v7.8.4 起方法完整：

| 方法 | 签名 | 说明 |
|---|---|---|
| `on` | `on(event, callback)` | 注册回调 |
| `off` | `off(event, callback)` | 退订指定回调，返回是否删掉 |
| `once` | `once(event, callback)` | 只触发一次，返回包装后的回调 |
| `clear` | `clear(event?)` | 清一个事件或全部事件 |
| `emit` | `emit(event, ...args)` | 派发；每个回调被 try/catch 包裹，出错只打日志 |

旧插件依赖「没有 off」的假设仍然安全：`off` 是新增方法，不改 `on/emit` 语义。
新插件建议在 `plugin.onDisable()` 里退订监听。

四个事件的真实语义：

| 事件 | 参数 | 触发后的效果 | 什么时候用 |
|---|---|---|---|
| `need:render` | 无 | 调 `render()`：重绘画布 + 刷新图层列表 + 刷新帧栏 + 更新各 UI（app.js:16963–16965、7593–7611；行号以源码为准） | 改了元件/帧数据后 |
| `need:syncUI` | 无 | 调 `syncUI()`：同步各面板控件的 disabled/checked/display 状态，**不重绘画布**（16967–16969） | 只改了控件状态时 |
| `app:update` | 可选 `label` 字符串 | 一次做完 `render()` + `syncUI()` + `saveHistory(label)`（16976–16980） | 最省事的整体刷新 |
| `history:save` | `label` 字符串，可选 `coalesceMs` 合并窗口 | 压入撤销栈快照（16971–16973、541–560） | 手动记一笔历史 |

**推荐用法**：改完元件数据 → `emit('need:render')`；想同时记历史 → `emit('app:update', '我的操作')`。

---

## 2. 内部接口 `window.SKFE.__skfe`（已常驻可用）

P0 已实施：源码在 app.js:17172–17239 定义这些函数，无条件挂到 `window.__skfe`，
并同步挂到 `window.SKFE.__skfe`（app.js:17244）与别名 `window.__SKFE_DBG`（app.js:17241）。
下表是**逐项查源码**得到的真实签名。

### 2.1 常量与引用（不是函数）

| 导出名 | 真实值 | 说明 |
|---|---|---|
| `AppState` | 对象引用 | 实时状态容器，见第 3.1 节。改它 = 直接改编辑器状态 |
| `KF` | `SKFE.systems.keyframes` | 关键帧系统，见第 4 节 |
| `EventBus` | `SKFE.core.eventBus.EventBus` | 事件总线 |
| `TRACK_ALL_ID` | `'all'` | 主轨 id（constants.js:11） |
| `projectVersion` | `3` | 工程格式版本（app.js:804） |

### 2.2 帧操作

| 函数 | 真实签名 | 返回 | 副作用 / 注意 |
|---|---|---|---|
| `goToFrame` | `(i)` | `void` | 跳到第 i 帧（0 基）；越界直接 return；会 emit `need:render` + `need:syncUI`；**不写历史** |
| `goto` | `(i)` | `void` | `goToFrame(i)` + 额外一次 `need:render` |
| `addFrame` | `()` | `void` | 当前帧后插帧；写历史；emit render/syncUI/history:save |
| `deleteFrame` | `()` | `void` | 删当前帧；只剩 1 帧时 alert 并返回；写历史 |
| `insertFrames` | `(n)` | `void` | 段内插 n 帧；导出入口**不校验范围**（UI 才校验 1–60），自己传合法值 |
| `trimTrailingEmptyFrames` | `()` | `void` | 删所有轨道尾部空帧，至少留 1 帧 |
| `deleteSelectedFrames` | `()` | `void` | 需处于多选模式且已选帧；写历史 |
| `updateFrameBar` | `()` | `void` | 重建帧栏 DOM、同步滑条；不 emit render | 
| `syncFrameRef` | `()` | `void` | 把 `AppState.objects` 按 id 写回各轨道当前帧槽位；派生帧不写回 |
| `markCurrentFrameModified` | `()` | `void` | 标记当前帧已改、落自动关键帧、清缩略图、调度自动存档；**不压历史** |
| `applyFrameMove` | `(from, to, opts)` | `boolean` | `opts.reorder=true` 为整帧重排，否则覆盖落点姿态；写历史 |
| `getFrameStartTime` | `(idx)` | `number`（秒） | 累加前 idx 帧 duration / 1000 |

### 2.3 元件与选区

| 函数 | 真实签名 | 返回 | 副作用 / 注意 |
|---|---|---|---|
| `makeFigure` | `(x, y, color, lw)` | figure 对象 | `color` 默认 `'#111111'`，`lw` 默认 `10.5`；不挂到场景，要再调 `addObjectToFrames` |
| `addObjectToFrames` | `(obj)` | `void` | **只接一个对象**；`obj.type === 'video'` 直接忽略；新建一条以 obj.id 为键的轨道 |
| `select` | `(obj)` | `void` | 选中元件；会改 `activeTrackId`、`selected` 等 |
| `deleteSelected` | `()` | `void` | 删选中元件；emit `app:update('删除对象')`；**不写历史** |
| `cloneSelected` | `()` | `void` | 复制选中元件（新 id、+1 图层、位移 +46/+34）；写历史 |
| `getLayerUIObjects` | `()` | `Array<object>` | 纯读：当前帧对象按图层降序，过滤 video |
| `getObjectBounds` | `(o)` | `{left,right,top,bottom}` | 纯读：含扭曲/旋转/缩放的世界包围盒 |
| `applyLayerOrder` | `(ordered)` | `void` | 传排好序的对象数组；写历史 + markModified |
| `mainKeyStateAt` | `(idx)` | `'none' \| 'all' \| 'partial'` | 纯读 |
| `kfPartialNames` | `(idx)` | `string[]` | 纯读 |
| `kfChipKind` | `(i)` | `'blank' \| 'key' \| 'partial' \| 'derived' \| 'manual'` | 纯读 |

### 2.4 轨道与关键帧

| 函数 | 真实签名 | 返回 | 副作用 / 注意 |
|---|---|---|---|
| `getTrackSlot` | `(trackId, idx)` | 原始槽位对象或 `null` | `trackId` **不做字符串转换**，要传字符串 id |
| `getTrackFrame` | `(trackId, idx)` | 求值后帧对象或 `null` | 派生帧会经 `evaluateDerived` 求值 |
| `getObjectsForFrameAt` | `(idx, trackId)` | `Array<object>` | `trackId` 省略或 `'all'` 时取所有轨道 |
| `getCombinedObjectsForRender` | `()` | `Array<object>` | 当前帧合并渲染列表 |
| `getCombinedObjectsForRenderAt` | `(idx)` | `Array<object>` | 纯读：指定帧合并列表 |
| `getTrackLength` | `(trackId)` | `number` | 纯读 |
| `reconcileAllTracks` | `(opts)` | `void` | 归一化所有轨道槽位；`{adoptPlain:false}` 表示只清悬空派生 |
| `pruneEmptyTracks` | `()` | `number`（删掉几条） | 删全空轨道 |
| `toggleKeyframe` | `()` | `void` | 切换当前帧关键帧；写历史 |
| `markKey` | `(trackId, idx, origin)` | `boolean` | `origin` 默认 `'sub'`；会补空帧；**不写历史、不重绘** |
| `applyEase` | `(key)` | `number`（改了几段） | `key` 是缓动键名，如 `'easeInOut'`；写历史 |
| `applyChannelEase` | `(objId, part, key)` | `number` | `key` 传 falsy 表示删除该分部设置 |
| `fillLooseFrames` | `(trackId)` | `number`（填了几帧） | 首/末关键帧外补齐静止帧 |
| `buildTweenFrames` | `(f1, f2, count, trackId, i1, i2)` | `Array<帧对象>` | f1/f2 可传帧对象或索引；**不写回 AppState**，要自己插入 |
| `segmentAhead` | `(trackId, idx)` | `{a, b}` 或 `null` | 纯读 |
| `repairTailAfterLastKey` | `(trackId)` | `number` | 修末关键帧之后的尾部 |
| `bumpKfEval` | `()` | `void` | 清派生帧求值缓存；改了关键帧数据后可调 |

### 2.5 渲染与导出

| 函数 | 真实签名 | 返回 | 副作用 / 注意 |
|---|---|---|---|
| `renderScene` | `(list, opts)` | `void` | **底层绘制**，只画到当前 ctx，不刷 UI。`opts={isExporting,refList,...}` |
| `renderFrameToDataURL` | `(frame, outW, outH, options, trackId, outCanvas)` | **HTMLCanvasElement** | 名字误导：`frame` 可为索引或帧对象，`outCanvas` 可选复用；要 dataURL 得自己 `.toDataURL('image/png')` |
| `exportImage` | `(format)` | `void` | `format='png'` 走 PNG，其它走 JPEG(0.92)；同步触发下载 |
| `exportSelectedPNGs` | `()` | `void` | 内部 async 打包 ZIP |
| `exportSelectedSVGs` | `()` | `void` | 内部 async 打包 ZIP，扫所有轨道 |
| `exportSelectedJPGs` | `()` | `void` | 逐张下载，setTimeout 错开 |
| `exportSelectedGIF` | `()` | `void` | 内部 async |
| `exportProjectJSON` | `()` | `{version, frames, tracks, ...}` | 触发 .json 下载并**返回当前工程数据对象**；不改 AppState |
| `importProjectJSON` | `(file)` | `void` | `file` 是 File 对象；异步读、校验版本、加载 |

**v7.8.1 补充**：导出面板新增 `exportSelectedSVGs()`（内部 async 打包 ZIP，只取矢量元件，
文字/位图/视频/发光/扭曲不导出），`exportSelectedPNGs()`、`exportSelectedJPGs()`、
`exportSelectedGIF()` 仍保持原有语义。UI 上的「导出并保存项目」= `exportProjectJSON(name)` +
`projectLibrary.save(data, name)` + `projectLibrary.refresh()`，不是单独的新底层 API。
| `deserializeProject` | `(data)` | `{newFrames, newTracks, promises}` | 纯解析，不改状态 |
| `applyLoadedProject` | `(data)` | `Promise` | 大面积覆盖 AppState 与全局设置；**不写历史** |
| `exportActionPresets` | `()` | `void` | 导出动作预设 json |

### 2.6 撤销栈与事务

| 函数 | 真实签名 | 返回 | 说明 |
|---|---|---|---|
| `undo` | `()` | `void` | 只有 1 条历史时不做事 |
| `redo` | `()` | `void` | redo 栈空时不做事 |
| `saveHistory` | `(label, coalesceMs)` | `void` | `label` 默认 `'编辑'`；`coalesceMs>0` 时同标签短时间合并 |
| `historySize` | `()` | `number` | 撤销栈长度 |
| `historyTop` | `()` | `string \| null` | 栈顶 label |
| `historyDump` | `()` | `string[]` | 调试用 |
| `txBegin` | `(label)` | `boolean` | 开事务，记录前快照；嵌套返回 false |
| `txEnd` | `()` | `boolean` | 前后快照不同才压历史 |
| `txRun` | `(label, fn)` | `fn()` 的返回值 | 自动 begin/end，推荐用这个包批量修改 |
| `isTxOpen` | `()` | `boolean` | 事务是否开着 |

**批量修改的标准写法**：
```js
S.__skfe.txRun('批量改名', () => {
  // 这里做多次修改，最后只产生一条历史
  const objs = S.__skfe.getLayerUIObjects();
  objs.forEach(o => { o.name = 'X-' + o.id; });
  S.__skfe.markCurrentFrameModified();
});
S.core.eventBus.EventBus.emit('need:render');
```

### 2.7 工程库（IndexedDB）

| 函数 | 真实签名 | 返回 |
|---|---|---|
| `projectLibrary.save` | `(data, name)` | `Promise<{id,name,frameCount,savedAt,version,data}>` |
| `projectLibrary.list` | `()` | `Promise<Array<rec>>`，按 savedAt 降序 |
| `projectLibrary.get` | `(id)` | `Promise<rec \| null>` |
| `projectLibrary.remove` | `(id)` | `Promise<void>` |
| `projectLibrary.refresh` | `()` | `void`，重建 `#projectList` DOM |

### 2.8 v7.8.1 补充导出的接口

下列函数已从 v7.7.8 的「待扩充」清单**正式加入 `window.__skfe`**，可直接调用：

| 函数 | 真实签名 | 返回 / 说明 |
|---|---|---|
| `setActiveTool` | `(name)` | `void`；传当前同名会关闭；如 `'layer'`、`'canvas'`、`'mask'` |
| `zoomViewAt` | `(clientX, clientY, factor)` | `boolean`；factor>0；以鼠标点为锚缩放 |
| `clampViewOffset` | `()` | `boolean`；保证画布至少 5% 在屏内 |
| `canvasPosLocked` | `()` | `boolean`；视图固定后画布坐标锁定 |
| `getFrameStartTime` | `(idx)` | `number`（秒） |
| `getTrackLength` | `(trackId)` | `number` |
| `toggleDistortMode` | `()` | `void`；切当前选中元件的四角扭曲 |
| `makeVideoClip` | `(videoEl, dataUrl, w, h, x, y, durMs, fps)` | videoClip 对象 |
| `playVideoClips` | `(idx)` | `void` |
| `seekVideoClipsToFrame` | `(idx)` | `void`；24ms 防抖 |
| `applyBasicMaskToCanvas` | `(c, W, H, M, obb, cfg)` | `void`；底层绘制，参数复杂 |
| `applyChromaMaskToCanvas` | `(c, W, H, M, obb, cfg)` | `void`；同上 |

> **v7.8.4 更新**：`makeAudioClip` / `playAudioClips` / `pauseAudioClips` /
> `disposeAudioClipSource` / `audioClipSources` / `collectAudioTimeline` 已全部暴露到 `__skfe`。
> 更推荐直接用第 2.9 节的 `api.media.addAudio()`，它会创建媒体元素、加入轨道并按帧区间铺好段落。

### 2.9 全开放 API `window.SKFE.api`（v2.1.0，MCP 插件首选）

`js/plugins/api.js` 在 `app.js` 之后、`host.js` 之前加载，提供一个稳定、结构化、可 JSON 调用的全开放入口。
**完全信任，没有沙箱**：`api.raw` 与主程序共享同一份 `window / document / SKFE / AppState` 引用。

代码型插件的入口函数现在收到第三个参数 `api`，旧的两参数插件不受影响：

```js
new Function('SKFE', 'plugin', 'api', code)(SKFE, runtime, SKFE.api);
```

#### 2.9.1 命名空间

| 路径 | 用途 |
|---|---|
| `api.raw` | 原始引用：`window / document / SKFE / App / Bus / Group / TrackStrip` |
| `api.get(path)` / `api.set(path, value)` | 对 `SKFE` 下任意路径读写；支持 `window.` / `document.` / `SKFE.` 前缀 |
| `api.call(path, ...args)` / `api.invoke(path, argsArray)` | 调 `SKFE` 下任意函数，例如 `api.call('features.export.exportMP4')` |
| `api.evaluate(expr)` / `api.execute(code)` | 在当前页面上下文求值 / 执行代码 |
| `api.state` | 实时状态读写、跳帧、补丁式修改 |
| `api.data` | 工程快照、轨道 / 帧读写、媒体源信息、导出音轨事件 |
| `api.object` | 元件构造、加入、选中、包围盒 |
| `api.media` | 加音频 / 视频元件，播放控制 |
| `api.frame` / `api.keyframe` | 帧与关键帧操作 |
| `api.group` / `api.loop` | 编组、循环填充 |
| `api.ui` | DOM 查询、点击、改值、改面板、工具切换、轨道模式 |
| `api.events` | `on / once / off / clear / emit / list` |
| `api.history` | `undo / redo / save / run` |
| `api.export` | PNG / JPG / GIF / SVG / MP4 / WebM / 工程 |
| `api.render` | 底层绘制入口 |
| `api.brush` | 画笔模式、画笔类型（default / blob / crayon）、配置、油漆桶、预设 |
| `api.eraser` | 橡皮模式、笔迹控制、尺寸 / 直线模式、清除 |
| `api.camera` | 2D 摄像机对象、取景框、遮罩、预览浮窗 |
| `api.space3d` | 3D 模式开关、摄像机视角、3D 离屏渲染、Gizmo |
| `api.space3dData` | camera2d / camera3d 默认值、工程归一化、对象级 3D 状态 |
| `api.space3dExport` | 3D 导出分流、SVG 允许状态 |
| `api.camera3d` | 3D 摄像机虚拟轨、逐帧求值、播放 / 导出应用 |
| `api.canvas` | 画布边界、固定视图、导出尺寸 |
| `api.mcp` | JSON-RPC 风格调用入口，见下 |

#### 2.9.2 MCP / JSON-RPC 调用

```js
// 列出全部稳定方法
api.mcp.methods();

// 直接调用
api.mcp.call('project.get');
api.mcp.call('ui.setValue', { selector: '#projectNameInput', value: '我的工程' });
api.mcp.call('media.addAudio', { dataUrl, start: 0, end: 11, volume: 0.8 });

// JSON-RPC 2.0 信封（适合 MCP Server / Bridge 转发）
api.mcp.dispatch({
  jsonrpc: '2.0',
  id: 1,
  method: 'skfe.state.frame.set',
  params: { index: 12 }
});
// → { jsonrpc: '2.0', id: 1, result: 12 }
```

`method` 支持可选 `skfe.` 前缀。未知方法返回 `error.code = -32603`。
批量操作用 `history.run`：

```js
api.mcp.call('history.run', {
  label: 'MCP 批量改帧',
  ops: [
    { method: 'state.frame.set', params: { index: 3 } },
    { method: 'track.setFrame', params: { id: '2', index: 3, object: obj } }
  ]
});
```

#### 2.9.3 UI 操作要点

- `api.ui.click('#btnPlay')` 直接触发真实按钮点击，走完整应用逻辑。
- `api.ui.setValue('#projectNameInput', 'X')` 会派发 `input` + `change`。
- `api.ui.anchors()` 返回所有带 id 的按钮 / 输入框 / 选择器，适合 AI 先「看界面」再操作。
- `api.ui.openSheet('export')` 打开底部栏导出分区；`api.ui.trackMode(true)` 进入轨道模式。
- 直接改 DOM 也可以，`api.raw.document` 就是页面真实 document。

#### 2.9.4 新增媒体快捷入口

```js
const audioId = api.media.addAudio({
  dataUrl: 'data:audio/wav;base64,...',
  durationMs: 1000,
  fps: 12,
  start: 0,
  end: 11,
  volume: 0.8,
  name: '背景音'
});

const videoId = api.media.addVideo({
  dataUrl: 'data:video/mp4;base64,...',
  w: 640, h: 360, x: 0, y: 0,
  durationMs: 1000, fps: 12,
  start: 0, end: 11
});
```

`start / end` 是帧区间（含端点），不传则只创建轨道对象，由 `addObjectToFrames` 决定出场。

#### 2.9.5 v8.0.0 新增接口

API 版本从 `2.0.0` 升到 `2.1.0`，旧接口全部保留。新入口直接调用主程序同一份模块实例：

| 路径 | 常用方法 |
|---|---|
| `api.brush` | `setOn/isOn`、`getType/setType/listTypes`、`getConfig/setConfig`、`setBucketMode/isBucketMode/toggleBucketMode`、`bucketFill/bucketFillAt`、`getPresets/applyPreset/deletePreset` |
| `api.eraser` | `setOn/isOn`、`size/setSize`、`lineMode/setLineMode`、`startStroke/updateStroke/finishStroke/cancelStroke`、`clearFrame/clearAll` |
| `api.camera` | `makeCamera/findCameraObject/getViewObject/getViewTransform`、`drawMask`、`getMaskAlpha/setMaskAlpha`、`updatePreview/fitViewToAvailableArea` |
| `api.space3d` | `isEnabled/setEnabled`、`isCameraView`、`setCameraMode`、`alignViewToExportCamera`、`renderFrameToCanvas`、`setGizmoMode/getGizmoMode` |
| `api.space3dData` | `getProjectState/setProjectState`、`setMode`、`ensureCamera2D/ensureCamera3D`、`readObjectState/ensureObjectState` |
| `api.space3dExport` | `isActive`、`renderFrameToCanvas`、`renderFrameToDataURL`、`isSvgAllowed` |
| `api.camera3d` | `trackId`、`getFrameAt`、`getObject`、`applyToState`、`syncFromState`、`fillFullLength`、`resetToDefault` |
| `api.canvas` | `getViewPinned/setViewPinned/posLocked`、`setBoundsEnabled`、`getBounds`、`getExportSize` |

画笔类型接口示例：

```js
const api = window.SKFE.api;

api.brush.listTypes();        // ['default', 'blob', 'crayon']
api.brush.getType();          // 当前类型
api.brush.setType('blob');    // 切柳叶笔
api.brush.setConfig({ type: 'crayon', size: 8, stabilize: 0.5 });
api.brush.getConfig();        // 读取完整画笔配置
```

3D 摄像机逐帧接口示例：

```js
const api = window.SKFE.api;
const frame3d = api.camera3d.getFrameAt(api.state.getFrameIndex());
api.camera3d.applyToState(api.state.getFrameIndex());
api.space3d.setEnabled(true);
api.space3d.setCameraMode('camera');
```

MCP 也暴露了对应方法，例如：

```js
api.mcp.call('brush.type.set', { type: 'crayon' });
api.mcp.call('brush.config.set', { patch: { size: 8, stabilize: 0.5 } });
api.mcp.call('space3d.set', { on: true });
api.mcp.call('camera3d.frame', { index: 12 });
api.mcp.call('canvas.pin', { on: true });
```

---

## 3. 数据结构

### 3.1 AppState（app.js:40–54）

```js
{
  frames: [{ id: 1, duration: 83, isTween: false }],  // 主帧元信息，不含 objects
  tracks: {},                // { '元件id': { name, frames: [obj|null, ...] } }
  objects: [],               // 当前帧合并渲染列表（派生数据，别当数据源写）
  selected: null,            // 当前选中元件对象
  viewOffset: { x: 0, y: 0 },
  viewScale: 1,              // 范围 0.02 ~ 80
  currentFrameIndex: 0,      // 0 基
  activeTrackId: 'all',
  canvasBounds: { x: -400, y: -400, w: 800, h: 800, rotation: 0 },
  canvasBoundsEnabled: false,
  canvasSelected: false
}
```

**关键认知**：真正的数据在 `tracks`，不在 `objects`。`objects` 是每次渲染时由各轨道当前帧合并出来的。
要改某一帧的元件，改 `AppState.tracks[id].frames[frameIndex]`。

### 3.2 元件对象：合法 type 清单

| type | 构造入口 | 说明 |
|---|---|---|
| `'figure'` | `makeFigure(x,y,color,lw)` app.js:2869 | 火柴人 |
| `'shape'` | `makeShape(shapeType,x,y)` app.js:2990 | 形状；shape 值 `circle/rect/tri` |
| `'acc'` | `makeAccessory()` app.js:3005 | 配件 |
| `'videoClip'` | `makeVideoClip(...)` app.js:3030 | 独立视频元件 |
| `'audioClip'` | 内部 `makeAudioClip(...)`，**未暴露到 `__skfe`** | 音频元件；只播声音、不进元件列表、轨道置底、仅音量可调 |
| `'bubble'` | `makeBubble()` app.js:3218 | 对话气泡 |
| `'ink'` | brush.js:884 | 矢量画笔笔迹 |
| `'camera'` | `makeCamera(x,y)` camera.js:11 | 摄像机 |
| `'video'` | app.js:1589 | 参考视频伪元件，**不进轨道、不导出** |

**没有 `'rect'` 这个 type**——`rect` 只是 `shape` 字段的取值。

### 3.3 figure 完整字段（app.js:2869–2924）

```js
{
  spatial: { strength: 0, lines: SKFE.systems.spatial.defaultLines() },
  id: 1, type: 'figure', name: 'Stickman',
  x, y, color: '#111111', lw: 10.5,
  alpha: 1, scale: 2, locked: false, rot: 0, mirror: false,
  shadowEnabled: false, shadowColor: '#000000', shadowAlpha: 0.3,
  shadowOffX: 0, shadowOffY: 0, shadowScaleX: 1, shadowScaleY: 1,
  headFillCustom: false, headFillColor: '#111111',
  headShape: 'TCO',               // 'circle'|'Vic'|'TCO'|'TDL'|'TSC'
  bodyScale: { head:1.83, arm:0.98, leg:1.16, torso:0.62, foreArm:0.41, shin:0.49 },
  headAngle: -Math.PI/2 - 15*Math.PI/180,
  headOffset: { x:0, y:0 },
  light: { enabled:false, color:'#ffbb66', size:1.0, angle:315 },
  glow: { enabled:false, color:'#000000', alpha:0.45, blur:14, offsetX:3, offsetY:-4, spread:0, includeAcc:false },
  joint: { enabled:false, color:'#ff0000', len:0.5 },
  jointSmooth: 1,
  extremity: { enabled:false, armAngleL:30°, armAngleR:30°, legAngleL:30°, legAngleR:30°, armRatio:0.23, legRatio:0.23 },
  depth: { enabled:false, useCustom:false, customColor:'#555555' },
  ikEnabled: false,
  distort: { enabled:false, corners:null, baseW:0, baseH:0 },
  pinned: { footL:false, footR:false, handL:false, handR:false, pelvis:false },
  pinnedPos: { footL:null, footR:null, handL:null, handR:null, pelvis:null },
  layer: { body:1, head:2, armL:1, armR:1, legL:1, legR:1 },
  a: { torso, waist, armL:{u,f}, armR:{u,f}, legL:{u,f}, legR:{u,f} }  // 弧度
}
```

### 3.4 其他类型关键字段

**shape**（app.js:2990）：上面公共字段 + `shape, fillColor, strokeColor, strokeWidth, bindTo, targetId, offX, offY`

**videoClip**（app.js:3030）：公共字段 + `videoFrame, videoLoop`，`img` 是 video 元素

**audioClip**（v7.8.1，内部 `makeAudioClip`）：公共字段 + `volume`（0~1，默认 1）。
音源本体存在 app.js 内部 Map `audioClipSources` 中，元件对象本身**没有** `img`；
它不进元件列表、不画画面、不参与静态导出，只在自己的轨道段落区间播放声音。

**bubble**（app.js:3218）：公共字段 + `text, textColor, fontSize, fillColor, strokeColor, strokeWidth, gradientColor, isGradient`

**ink**（brush.js:884）：
```js
{
  id, type: 'ink', name, x, y, w, h, scale:1, rot, alpha:1,
  layer:10, locked:false, mirror:false, ax:0, ay:0,
  bindTo, targetId, offX, offY,
  strokes: [{ z, color, borderColor, borderWidth, outlineUnder, points:[{x,y,w}] }],
  eraser:  [{ z, size, points:[{x,y}] }]
}
```

**mask 字段**（`makeMaskField()`, app.js:2938–2960）：
`{enabled, mode, basicEnabled, chromaEnabled, shape, x, y, w, h, feather, invert, chromaColor, similarity, smoothness, hueTolerance, saturationTolerance, valueTolerance, spillReduction, edgeFeather, chromaInvert}`

### 3.5 轨道与槽位

```js
AppState.tracks = {
  '1': {
    name: 'Stickman',
    frames: [ obj, null, {__d:1}, obj2, ... ]   // 长度与 frames 对齐
  }
}
```

`frames[i]` 四种身份（keyframes.js）：

| 值 | 身份 | 判定 |
|---|---|---|
| `null` | blank 空白帧 | `KF.isBlank(d)` |
| 对象 + `__k` 字段 | key 关键帧 | `KF.isKey(d)` |
| 对象、无标记 | plain 普通帧 | `KF.isPlain(d)` |
| `{ __d: 1 }` | derived 派生帧（插值算出） | `KF.isDerived(d)` |

关键帧标记 `__k = { o: 'main'|'sub', c: {ease, ch} }`（keyframes.js:56–68）。
派生帧求值由 `KF.evaluateTrack(track, idx, ctx)` 完成，**永不回写**成关键帧。

### 3.6 工程 JSON 结构（app.js:1002–1014）

```js
{
  version: 3, minVersion: 3,
  frames: [{id, duration, isTween}],
  tracks: { [id]: {name, frames:[obj|null]} },
  currentFrameIndex, defaultFPS,
  groundLineEnabled, groundLineY,
  onionEnabled, onionBefore, onionAfter,
  canvasBounds, canvasBoundsEnabled,
  pageBgColor, gridEnabled, gridSize,
  canvasMaskEnabled, canvasMaskAlpha, canvasMaskBgColor, canvasMaskGridColor
}
```

**不包含** `objects`、`selected`、`viewOffset`、`viewScale`、`activeTrackId`——这些只在运行时存在。
存图片时 `img` 会被换成 `imgSrc`（app.js:807–831），videoClip 还会有
`videoSrc/videoW/videoH/videoDurMs/videoFps`；v7.8.1 起 audioClip 还会有
`audioSrc`（整轨只写一次）、`audioDurMs`、`audioFps`、`volume`。

---

## 4. 关键帧系统 `KF`（`SKFE.systems.keyframes`）

| 常量 | 值 |
|---|---|
| `KEY` | `'__k'` |
| `DERIVED` | `'__d'` |
| `DERIVED_SLOT` | `Object.freeze({__d:1})` |

| 方法 | 签名 | 用途 |
|---|---|---|
| `isReal / isKey / isPlain / isDerived / isBlank` | `(d)` | 判定槽位身份 |
| `kindOf` | `(d)` | → `'blank'\|'derived'\|'key'\|'plain'` |
| `markKey` | `(d, origin, curve)` | 打关键帧标记；`origin` 为 `'main'\|'sub'` |
| `clearKey` | `(d)` | 清标记 |
| `curveOf / setCurve` | `(d)` / `(d, curve)` | 读写曲线 `{ease, ch}` |
| `stripFrameMarks` | `(obj)` | 深拷贝时剥掉 `__k`/`__d` |
| `keyIndices` | `(frames)` | 所有关键帧下标 |
| `segments` | `(frames)` | `[{a,b}]` 段列表 |
| `segmentContaining` | `(frames, idx)` | 所在段 |
| `locate` | `(frames, idx)` | `{kind, a, b, u}` |
| `reconcileTrack` | `(t, opts)` | 归一化，→ `{adopted:[], dropped:[]}` |
| `countKinds` | `(frames)` | → `{key,plain,derived,blank}` |
| `interpolateObject` | `(o1, o2, u, ctx)` | 插值 |
| `evaluateTrack` | `(track, idx, ctx)` | 求值指定帧 |

---

## 5. 子系统 API 速查

只列插件最常用的。全部方法名见各文件导出块。

### 5.1 `SKFE.core.constants`
`P`（骨骼尺寸 `{torso:82, headR:17, upperArm:40, foreArm:38, thigh:45, shin:45, lw:6}`）、
`TAU`、`displayY(y=>-y)`、`TRACK_ALL_ID='all'`。

### 5.2 `SKFE.core.colorUtils`
`darkenColor(hex, factor=0.55)`、`hexToRgb(hex)`、`rgbToHex(r,g,b)`、
`lerpColor(c1,c2,t)`、`themeHexToRgba(hex,alpha)`、`themeMixHex(hex,target,ratio)`。

### 5.3 `SKFE.core.geometry`
`along(p,ang,len)`、`norm(a)`、`distToSeg(p,a,b)`、`worldToFigureLocal(fig,p)`。

### 5.4 `SKFE.features.ease`
`TWEEN_EASE_PRESETS`（`linear/easeIn/easeOut/easeInOut`）、
`getEaseFunction(key, params)` → `(u)=>number`、
`getEaseBezier(key, params)`、`cubicBezierEase(x,x1,y1,x2,y2)`、`easeThumbPath(input)`。

### 5.5 `SKFE.features.export`（多为 async）
`exportPNGsAsZip(frameList, trackId, options)`、
`exportSVGsAsZip(frameList, trackId, options)`、
`exportGIF(frameList, trackId)`、`exportMP4()`、`exportVideo()`、
`getJSZip()` → `Promise<JSZip>`、`getMP4MimeType()`。

### 5.6 `SKFE.platform`
`isNative()`、`save(data, filename)`、`saveBlob(blob, filename)`、
`saveDataURL(dataUrl, filename)`、`saveURL(url, filename)`（后四个 async）、
`dataUrlToBlob(dataUrl)`、`diag()`。

`saveURL()` 用于静态资源下载（例如插件作者工具包 ZIP）：原生壳里会先 `fetch` 成 Blob，
再走原生写文件 + 系统分享；网页 / 桌面仍可直接使用 `<a download>`。

### 5.7 `SKFE.systems.brush`
`setOn(bool)`、`isOn()`、`getPresets()` → `{id,name,bindTo,offX,offY}[]`、
`applyPresetById(id)`、`savePreset()`、`deletePresetById(id)`、`getEditingInk()`。

### 5.8 `SKFE.systems.distort`
`setEnabled(o, on)`、`supports(o)`、`isActive(o)`、`defaultCorners(w,h)`、
`solveHomography(src,dst)`、`applyHomography(x,y,h)`、`drawWarpedBitmap(ctx,source,mp,opts)`。

### 5.9 `SKFE.systems.headShapes`
`get(id)`、`list()` → `{id,ratio}[]`、`has(id)`、
`path2d(id)` → Path2D、`draw(ctx,id,cx,cy,radius,angle,callback)`。
可用 id：`Vic/TCO/TDL/TSC`。

### 5.10 `SKFE.systems.camera`
`makeCamera(x,y)`、`findCameraObject()`、`getCameraViewTransform(cam)`、
`cameraScreenToWorld(screen, cam, t)`、`renderCameraViewScene(cam, trackAlphaOpts)`。

---

## 6. DOM 锚点表（全部来自 index.html，真实存在）

| 用途 | 选择器 |
|---|---|
| 主画布 | `#c` |
| 画笔叠加画布 | `#brushOverlay` |
| **工具按钮容器** | `#toolChips` |
| 工具切换按钮 | `#toolChips .tool-chip[data-tool]` |
| 图层列表 | `#layerList` |
| 时间轴 | `#timeline` |
| 帧列表 | `#frameBar` |
| 时间轴滑条 | `#timelineScrubber` |
| 加帧 / 删帧 / 复制帧 | `#btnAddFrame` / `#btnDelFrame` / `#btnDupFrame` |
| 播放 / 上一帧 / 下一帧 | `#btnPlay` / `#btnPrevFrame` / `#btnNextFrame` |
| 关键帧 / 插帧 | `#btnKeyframe` / `#btnTween` |
| 导出 PNG / JPG | `#btnExportPNG` / `#btnExportJPG` |
| 撤销 / 重做 | `#btnUndo` / `#btnRedo` |
| 加火柴人 / 复制 / 重置 | `#btnNew` / `#btnClone` / `#btnReset` |
| 导入插件 / 插件列表（v7.8.1） | `#btnImportPlugin` / `#pluginFileInput` / `#pluginList` |

**`data-tool` 合法值**（8 个）：`layer`、`proportion`、`joints`、`glow`、`mask`、`eraser`、`canvas`、`theme`。
切换工具调 `S.__skfe.setActiveTool(name)`，别自己改 class。

**面板 class**：`.tool-chip`、`.tool-chips`、`.tool-panel`、`.subpanel`。

**警告：页面里没有 `#toolbar`。** 别照抄网上那些用 `#toolbar` 的示例。

---

## 7. 端到端示例插件

### 7.1 数据型（`.json`）

```json
{
  "id": "com.example.mycolors",
  "name": "我的配色",
  "version": "1.0.0",
  "type": "data",
  "skfeVersion": ">=7.7.0",
  "contributes": {
    "core.colorUtils.MY_BRAND": { "primary": "#C8102E", "gold": "#F2C200" }
  }
}
```

### 7.2 代码型（`.zip` 内的 `index.js`）

功能：在真实工具容器加一个按钮，点一下在当前帧加一个火柴人。

```js
(function () {
  'use strict';

  var S = window.SKFE;
  var App = S.__skfe;                      // P0 后存在
  var Bus = S.core.eventBus.EventBus;

  if (!App) {
    console.warn('[my-plugin] 内部接口未就绪，插件未加载');
    return;
  }

  function addStickman() {
    // 1. 用真实签名造元件：makeFigure(x, y, color, lw)
    var fig = App.makeFigure(0, 0, '#111111', 10.5);

    // 2. 用真实签名加进场景：addObjectToFrames(obj) —— 只接一个对象
    App.addObjectToFrames(fig);

    // 3. 记一笔历史 + 整体刷新
    Bus.emit('app:update', '插件：加火柴人');
  }

  function install() {
    var bar = document.getElementById('toolChips');   // 真实容器，不是 #toolbar
    if (!bar) return;

    var btn = document.createElement('button');
    btn.className = 'tool-chip';
    btn.textContent = '加火柴人';
    btn.addEventListener('click', addStickman);
    bar.appendChild(btn);

    console.log('[my-plugin] 已安装');
  }

  // 宿主在 app.js 之后加载，插件入口执行时 DOM 已就绪，直接执行即可
  install();
})();
```

### 7.3 稍微复杂：包装内部函数

```js
(function () {
  var App = window.SKFE.__skfe;
  if (!App) return;

  var original = App.goToFrame;
  App.goToFrame = function (i) {
    console.log('[my-plugin] 跳到帧', i);
    return original.apply(this, arguments);   // 保留原行为
  };
  // 注：包装后主程序内部对 goToFrame 的调用不会走这个代理，
  // 因为内部是闭包直接引用局部函数。只能拦截通过 S.__skfe.goToFrame 的调用。
})();
```

### 7.4 完整可导入示例：画布网格叠加

作者工具包里的 `canvas-grid.zip` 是一个**可直接导入**的完整代码型插件，
演示了「加按钮 + 渲染后补画 + 无 off 的清理」三件事，源码见 `示例插件-画布网格/`。
关键片段：

```js
// 视图参数（源码核实：app.js:47–48）
var A = S.__skfe.AppState;             // A.viewScale / A.viewOffset.x / .y
var Bus = S.core.eventBus.EventBus;

// 渲染后补画：插件监听注册在 app.js 之后，所以排在它的 render() 后面执行
Bus.on('need:render', function () {
  var cv = document.getElementById('c');
  var ctx = cv.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var step = 64 * A.viewScale;          // 世界间距 → 屏幕间距
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 回到屏幕坐标系
  ctx.beginPath();
  // …按 A.viewOffset 取模算起点，画横竖线…
  ctx.stroke();
  ctx.restore();
});

// EventBus 没有 off：禁用时用标志位让回调直接返回
plugin.onDisable(function () { installed = false; Bus.emit('need:render'); });
```

> 该网格只在编辑画布上叠加，导出走独立 `octx`，不受影响。

---

## 8. 插件作者的检查清单

发布前逐条确认：

- [ ] `manifest.json` 的 `type` 是 `data` 或 `code`，不是 `"data | code"` 这种字面量
- [ ] 代码型 zip 根目录有 `manifest.json` 和 `entry` 指向的 js
- [ ] 所有 `S.__skfe.xxx(...)` 调用的参数个数、顺序和本参考一致
- [ ] 没有用 `#toolbar` 这类不存在的 DOM 选择器
- [ ] 改完状态后 emit 了 `need:render` 或 `app:update`
- [ ] 如果注册了事件监听，已在 `plugin.onDisable()` 里用 `api.events.off()` 退订
- [ ] 没有假设 `renderFrameToDataURL()` 返回字符串（返回 canvas）
- [ ] 没有把 `objects` 当数据源写（数据源是 `tracks`）
- [ ] 多步修改用 `txRun()` 包起来，避免产生一堆历史记录
- [ ] 音频元件优先走 `api.media.addAudio()`，不要把 audioClip 塞进元件列表
- [ ] MCP 插件优先用 `api.mcp.call()` / `api.mcp.dispatch()`，不要在协议层手写 DOM 选择逻辑

---

## 9. 来源索引

| 内容 | 文件 |
|---|---|
| `__skfe` 导出块 | js/app.js:17172–17239 |
| AppState 定义 | js/app.js:40–54 |
| 元件构造 | js/app.js:2869–3038、3218 |
| 关键帧系统 | js/systems/keyframes.js |
| 事件总线 | js/core/event-bus.js:8–20 |
| 事件订阅与初始化 | js/app.js:16958–17021 |
| 全开放插件 / MCP API（`window.SKFE.api`） | js/plugins/api.js |
| 插件宿主运行时（导入 / 执行 / 列表） | js/plugins/host.js |
| 事件总线（含 off / once / clear） | js/core/event-bus.js |
| DOM 结构 | index.html:10–1226 |
| 子系统导出 | 各 js/core、js/features、js/systems 文件导出块 |
| 工程格式 | js/app.js:1001–1065、804–853 |
