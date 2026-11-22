// js/core/event-bus.js
window.SKFE = window.SKFE || {};
SKFE.core = SKFE.core || {};

SKFE.core.eventBus = (function () {
  'use strict';

  const EventBus = {
    events: {},
    on(event, callback) {
      if (!this.events[event]) this.events[event] = [];
      this.events[event].push(callback);
    },
    /* v7.8.4：插件/MCP 需要能退订。保留 on/emit 原语义，只追加 off/once/clear。 */
    off(event, callback) {
      const list = this.events[event];
      if (!list) return false;
      const i = list.indexOf(callback);
      if (i < 0) return false;
      list.splice(i, 1);
      if (!list.length) delete this.events[event];
      return true;
    },
    once(event, callback) {
      const self = this;
      const wrapped = (...args) => {
        self.off(event, wrapped);
        callback(...args);
      };
      this.on(event, wrapped);
      return wrapped;
    },
    clear(event) {
      if (event == null) { this.events = {}; return true; }
      if (!this.events[event]) return false;
      delete this.events[event];
      return true;
    },
    emit(event, ...args) {
      if (!this.events[event]) return;
      this.events[event].forEach(callback => {
        try { callback(...args); } catch (err) { console.error(`[EventBus] 事件 "${event}" 执行出错:`, err); }
      });
    }
  };

  return { EventBus };
})();
