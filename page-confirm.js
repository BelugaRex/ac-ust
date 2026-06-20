// ============================================================
// Page Script - 注入到网页主环境
// 负责接管页面自身的 window.confirm，content script 的隔离环境无法做到这一点
// ============================================================

(() => {
  if (window.__AC_EXTENSION_DIALOG_PATCHED__) return;
  window.__AC_EXTENSION_DIALOG_PATCHED__ = true;

  const originalConfirm = window.confirm.bind(window);
  const originalAlert = window.alert.bind(window);
  const originalPrompt = window.prompt.bind(window);

  window.confirm = function(message) {
    console.log('[AC扩展] 已自动确认原生 confirm 弹窗:', message);
    return true;
  };

  window.alert = function(message) {
    console.log('[AC扩展] 已自动关闭原生 alert 弹窗:', message);
  };

  window.prompt = function(message, defaultValue = '') {
    console.log('[AC扩展] 已自动处理原生 prompt 弹窗:', message);
    return defaultValue;
  };

  window.__AC_EXTENSION_RESTORE_DIALOGS__ = function() {
    window.confirm = originalConfirm;
    window.alert = originalAlert;
    window.prompt = originalPrompt;
    delete window.__AC_EXTENSION_DIALOG_PATCHED__;
    delete window.__AC_EXTENSION_RESTORE_DIALOGS__;
  };
})();
