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
    SMART_ON: 'smart-on',
    SMART_ON_SAFE_DELAY: 'smart-on-safe-delay',
    SMART_ON_SAFETY_SKIP: 'smart-on-safety-skip',
    SMART_ON_SAFETY_TIMER: 'smart-on-safety-timer'
  });

  const descriptor = (kind, options) => Object.freeze({ kind, ...options });
  const PWM_RETRY_DESCRIPTORS = Object.freeze({
    [PWM_RETRY_KINDS.SMART_ON]: descriptor(PWM_RETRY_KINDS.SMART_ON, {
      storedSmartOnRetry: true,
      ownsTypedSmartOn: true,
      repairsSafetyTimer: false,
      boundaryRequired: true,
      reevaluatesAtNextBoundary: false,
      syncProjection: 'safety-sentinel',
      presentation: '',
      presentationAlways: false,
      diagnosticStatus: ''
    }),
    [PWM_RETRY_KINDS.SMART_ON_SAFE_DELAY]: descriptor(
      PWM_RETRY_KINDS.SMART_ON_SAFE_DELAY,
      {
        storedSmartOnRetry: true,
        ownsTypedSmartOn: true,
        repairsSafetyTimer: false,
        boundaryRequired: true,
        reevaluatesAtNextBoundary: false,
        syncProjection: 'safety-sentinel',
        presentation: 'smart-safe-delay',
        presentationAlways: false,
        diagnosticStatus: ''
      }
    ),
    [PWM_RETRY_KINDS.SMART_ON_SAFETY_SKIP]: descriptor(
      PWM_RETRY_KINDS.SMART_ON_SAFETY_SKIP,
      {
        storedSmartOnRetry: false,
        ownsTypedSmartOn: false,
        repairsSafetyTimer: false,
        boundaryRequired: true,
        reevaluatesAtNextBoundary: true,
        syncProjection: 'safety-sentinel',
        presentation: 'smart-safety-skip',
        presentationAlways: false,
        diagnosticStatus: 'deferred'
      }
    ),
    [PWM_RETRY_KINDS.SMART_ON_SAFETY_TIMER]: descriptor(
      PWM_RETRY_KINDS.SMART_ON_SAFETY_TIMER,
      {
        storedSmartOnRetry: true,
        ownsTypedSmartOn: false,
        repairsSafetyTimer: true,
        boundaryRequired: false,
        reevaluatesAtNextBoundary: false,
        syncProjection: 'safety-timer-off',
        presentation: 'safety-retry',
        presentationAlways: true,
        diagnosticStatus: ''
      }
    )
  });

  function getPwmRetryDescriptor(value) {
    const key = String(value || '');
    return Object.hasOwn(PWM_RETRY_DESCRIPTORS, key)
      ? PWM_RETRY_DESCRIPTORS[key]
      : null;
  }

  function normalizePwmRetryKind(value, fallback = PWM_RETRY_KINDS.SMART_ON) {
    const requested = getPwmRetryDescriptor(value);
    if (requested) return requested.kind;
    return getPwmRetryDescriptor(fallback)?.kind || PWM_RETRY_KINDS.SMART_ON;
  }

  return Object.freeze({
    PWM_RETRY_KINDS,
    getPwmRetryDescriptor,
    normalizePwmRetryKind
  });
});
