(function exposePwmRetry(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createPwmRetry() {
  'use strict';

  const PWM_RETRY_KINDS = Object.freeze({
    PAGE_TIMER: 'pwm-page-timer',
    TOGGLE: 'pwm-toggle'
  });

  const descriptor = (kind, options) => Object.freeze({ kind, ...options });
  const PWM_RETRY_DESCRIPTORS = Object.freeze({
    [PWM_RETRY_KINDS.PAGE_TIMER]: descriptor(PWM_RETRY_KINDS.PAGE_TIMER, {
      requiresPageTimer: true,
      presentation: 'page-timer-retry'
    }),
    [PWM_RETRY_KINDS.TOGGLE]: descriptor(PWM_RETRY_KINDS.TOGGLE, {
      requiresPageTimer: false,
      presentation: 'toggle-retry'
    })
  });

  function getPwmRetryDescriptor(value) {
    const key = String(value || '');
    return Object.hasOwn(PWM_RETRY_DESCRIPTORS, key)
      ? PWM_RETRY_DESCRIPTORS[key]
      : null;
  }

  function normalizePwmRetryKind(value, fallback = PWM_RETRY_KINDS.PAGE_TIMER) {
    const requested = getPwmRetryDescriptor(value);
    if (requested) return requested.kind;
    return getPwmRetryDescriptor(fallback)?.kind || PWM_RETRY_KINDS.PAGE_TIMER;
  }

  return Object.freeze({
    PWM_RETRY_KINDS,
    getPwmRetryDescriptor,
    normalizePwmRetryKind
  });
});
