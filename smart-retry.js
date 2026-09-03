(function exposeSmartRetry(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createSmartRetry() {
  'use strict';

  const SMART_RETRY_KINDS = Object.freeze({
    ON: 'smart-on',
    ON_SAFE_DELAY: 'smart-on-safe-delay',
    ON_SAFETY_SKIP: 'smart-on-safety-skip',
    ON_SAFETY_TIMER: 'smart-on-safety-timer'
  });

  const descriptor = (kind, options) => Object.freeze({ kind, ...options });
  const SMART_RETRY_DESCRIPTORS = Object.freeze({
    [SMART_RETRY_KINDS.ON]: descriptor(SMART_RETRY_KINDS.ON, {
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
    [SMART_RETRY_KINDS.ON_SAFE_DELAY]: descriptor(
      SMART_RETRY_KINDS.ON_SAFE_DELAY,
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
    [SMART_RETRY_KINDS.ON_SAFETY_SKIP]: descriptor(
      SMART_RETRY_KINDS.ON_SAFETY_SKIP,
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
    [SMART_RETRY_KINDS.ON_SAFETY_TIMER]: descriptor(
      SMART_RETRY_KINDS.ON_SAFETY_TIMER,
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

  function getSmartRetryDescriptor(value) {
    const key = String(value || '');
    return Object.hasOwn(SMART_RETRY_DESCRIPTORS, key)
      ? SMART_RETRY_DESCRIPTORS[key]
      : null;
  }

  function normalizeSmartRetryKind(value, fallback = SMART_RETRY_KINDS.ON) {
    const requested = getSmartRetryDescriptor(value);
    if (requested) return requested.kind;
    return getSmartRetryDescriptor(fallback)?.kind || SMART_RETRY_KINDS.ON;
  }

  return Object.freeze({
    SMART_RETRY_KINDS,
    getSmartRetryDescriptor,
    normalizeSmartRetryKind
  });
});