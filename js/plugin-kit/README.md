# SKFE 插件作者工具包

这套工具帮你制作**纯本地插件**：你打包好插件文件私下分享给别人，对方在 SKFE 底部栏「插件」分区导入，只在他的浏览器本地生效，不改动 SKFE 源码。

> **授权声明（务必先读）**：SKFE 由 **binvwvnid** 创作，**不是开源项目**。仅允许你**制作插件并私下分享插件文件**；未经作者书面许可，**不得二次公开发布 SKFE 本体或其修改版**，**不得抹消作者署名**。完整条款见本包内 `版权与授权声明.md`。

> **项目地址**：https://github.com/binvwvnid/SKFE-StickmanKeyframeEditor （在线版：https://binvwvnid.github.io/SKFE-StickmanKeyframeEditor/）

> 获取方式：打开 SKFE → 底部栏「插件」分区 →「一键下载全部（ZIP）」，这一个包里就有本工具包的全部内容（含授权声明、接口设计文档、API 参考、模板、校验脚本、示例）。无需再逐个下载。

---

## 一、两种插件

| 类型 | 文件格式 | 能做什么 |
|---|---|---|
| 数据型 | 单个 `.json` | 覆写 `SKFE.*` 下的配置（配色、头型、笔刷等），不执行代码 |
| 代码型 | `.zip`（内含 `manifest.json` + JS） | 完全开放：加按钮、改 UI、包装内部函数、联网，与主程序同级权限 |

代码型是**完全信任模型**——没有沙箱、没有权限限制。只把插件发给信任的人。

---

## 二、manifest 字段

```
id           必填  反向域名格式，如 com.author.myplugin，全局唯一
name         必填  显示名
version      必填  semver，如 1.0.0
type         必填  固定为 data 或 code
skfeVersion  必填  如 >=7.7.0；不满足只警告不拦截
entry        代码型必填  zip 内的 JS 入口路径
icon         可选  zip 内的图标路径
contributes  数据型必填  要覆写的数据，键为 SKFE.* 路径
```

数据型的 manifest 和数据写在同一份 JSON；代码型的 manifest 单独放在 zip 根目录。

---

## 三、快速开始

### 数据型（最简单）

1. 复制 `manifest.template.json`，改 `id` / `name` / `contributes`。
2. 存成 `我的插件.json` 即可分享。

现成示例见 `example-data.json`，可直接导入测试。

### 代码型

1. 复制 `manifest-code.json` 改名为 `manifest.json`，填好字段。
2. 复制 `example-code.js` 改名为 `index.js`，按需求改代码。
3. 把这两个文件压成 `我的插件.zip`（**manifest.json 和入口 JS 必须在 zip 根目录**）。
4. 可加入图片等资源，代码里用 `plugin.assetURL('assets/图标.png')` 取 data URL，
   或用 `plugin.readFile('assets/说明.txt')` 读文本。

现成示例见 `示例插件-代码型.zip`，可直接导入测试；`canvas-grid.zip` 是「画布网格叠加」的可导入插件——它在「画布」分区底部加一个开关按钮，开启后画布叠加一层线网格，演示加控件、渲染后补画、禁用清理。源码见 `示例插件-画布网格/`，想自己改再按上面第 3 步打包。

> 注意：本工具包 ZIP（你从面板「一键下载全部」拿到的那个）是**资料合集，不能直接导入**。导入必须选 `canvas-grid.zip` / `示例插件-代码型.zip` 这类插件 zip，且 zip 根目录要直接有 `manifest.json`。

---

## 四、可用的内部接口（代码型）

插件运行时拿到 `window.SKFE`：

- `SKFE.__skfe` —— 主程序内部接口（帧、元件、轨道、关键帧、撤销、导出等几十个函数）
- `SKFE.core.eventBus.EventBus` —— 事件总线，只有 `on` / `emit`，**没有 `off`**
  - 事件：`app:update` / `history:save` / `need:render` / `need:syncUI`
- `SKFE.core` / `SKFE.features` / `SKFE.systems` —— 各子系统公开方法

改完数据后要 `SKFE.core.eventBus.EventBus.emit('need:render')` 才会刷新界面。

> 页面里**没有** `#toolbar`，真实工具容器是 `#toolChips`。
> 完整函数签名、数据结构和端到端示例见本包内的 `插件API参考.md`（GitHub 仓库地址见文首）。
> 文中的源码行号基于 v7.7.8 快照，源码改动后请以函数名 / DOM id / 事件名搜索为准。

---

## 五、打包前自检

```
node js/plugin-kit/validate-plugin.js 我的插件.json
node js/plugin-kit/validate-plugin.js 我的插件.zip
```

校验脚本检查：必填字段、`id` 格式、semver、范围表达式、代码型 `entry`/图标是否真实存在。
版本号从 `js/version.js` 读取，不硬编码。只校验格式，不校验安全性。

---

## 六、安装后注意

- 删除 / 禁用插件后需**刷新页面**才彻底生效（插件改动都在运行时内存里）。
- 用户清除浏览器数据会丢失所有已装插件，请让对方自己留底插件文件。
- 同名 `id` 再次导入视为升级，保留原启用状态。

---

## 七、重新打包工具包（维护者用）

改动过上面的文档 / 示例后，在 SKFE 根目录运行：

```
node js/plugin-kit/build-kit.js
```

会重新生成 `js/plugin-kit/SKFE插件作者工具包.zip`（含根目录两份文档 + 本目录工具 + 画布网格示例源码）。普通用户不需要这一步，直接从面板下载即可。
