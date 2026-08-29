(function exposeAcPageContract(root, factory) {
  const api = factory();
  const isBrowserWorld = typeof self !== 'undefined' && root === self;
  if (isBrowserWorld) {
    Object.defineProperty(root, '__AC_EXTENSION_PAGE_CONTRACT__', {
      value: api,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createAcPageContract() {
  'use strict';

  const AC_SWITCH_SELECTOR = 'button.ant-switch[role="switch"], .ui.toggle.checkbox input[type="checkbox"]';

  function isACStatusLabel(text) {
    return /^air\s*conditioning\s+status$/i.test(String(text || '').trim());
  }

  function findUniqueACControl(root, selector = AC_SWITCH_SELECTOR) {
    const labels = Array.from(root.querySelectorAll('small, label, span, div'))
      .filter(label => label.children.length === 0 && isACStatusLabel(label.textContent));
    const matches = new Set();

    for (const label of labels) {
      let container = label.parentElement;
      for (let depth = 0; depth < 10 && container; depth++) {
        const candidates = Array.from(container.querySelectorAll(selector));
        if (candidates.length === 1) {
          matches.add(candidates[0]);
          break;
        }
        if (candidates.length > 1) break;
        container = container.parentElement;
      }
    }

    return matches.size === 1 ? matches.values().next().value : null;
  }

  function isACSwitchDisabled(sw) {
    if (!sw) return false;
    return sw.disabled === true
      || sw.hasAttribute?.('disabled')
      || sw.getAttribute?.('aria-disabled') === 'true'
      || String(sw.className || '').includes('ant-switch-disabled');
  }

  return Object.freeze({
    AC_SWITCH_SELECTOR,
    isACStatusLabel,
    findUniqueACControl,
    isACSwitchDisabled
  });
});
