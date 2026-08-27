(function exposeRecoveryCoordinator(root, factory) {
  const dependencies = typeof module !== 'undefined' && module.exports
    ? {
        ...require('./smart-recovery.js'),
        ...require('./interval-recovery.js')
      }
    : root;
  const api = factory(dependencies);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createRecoveryCoordinator({
  planSmartRecovery,
  planIntervalRecovery
}) {
  function planPwmLifecycleRecovery(schedule, context = {}) {
    const smartDecision = planSmartRecovery(schedule, context);
    if (smartDecision.kind === 'recover-smart-current-cycle') {
      return smartDecision;
    }

    const intervalDecision = planIntervalRecovery(context);
    return {
      ...intervalDecision,
      smartDecisionReason: smartDecision.reason
    };
  }

  return { planPwmLifecycleRecovery };
});
