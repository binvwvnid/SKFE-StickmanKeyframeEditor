/* SKFE version: 单一版本号来源
 * 页面显示、插件 skfeVersion 校验都从这里读。
 * 升级版本时只改这一处（package.json / sw.js 仍需各自同步，它们是发布元数据）。
 * 加载顺序：必须在 i18n.js 之前，这样首次 applyTranslations 就能拿到版本号。
 */
window.SKFE = window.SKFE || {};
window.SKFE.version = '7.8.1';
