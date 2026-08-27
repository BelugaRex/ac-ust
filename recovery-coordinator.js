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
  function isHalfHourBoundary(timestamp, toleranceMs = 1500) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return false;
    const date = new Date(value);
    const lowerBoundary = new Date(value);
    lowerBoundary.setMinutes(date.getMinutes() < 30 ? 0 : 30, 0, 0);
    const upperBoundaryAt = lowerBoundary.getTime() + 30 * 60_000;
    const tolerance = Number.isFinite(Number(toleranceMs))
      ? Math.max(0, Number(toleranceMs))
      : 1500;
    return Math.min(
      Math.abs(value - lowerBoundary.getTime()),
      Math.abs(upperBoundaryAt - value)
    ) <= tolerance;
  }

  function planPwmLifecycleRecovery(schedule, context = {}) {
    const smartDecision = planSmartRecovery(schedule, context);
    if (smartDecision.kind === 'recover-smart-current-cycle') {
      return smartDecision;
    }

    const intervalDecision = planIntervalRecovery(context);
    const intervalKeepsFutureClock = intervalDecision.kind === 'preserve-live-alarm'
      || intervalDecision.kind === 'restore-stored-alarm';
    const smartNextAction = context.smartNextAction === 'on'
        || context.smartNextAction === 'off'
      ? context.smartNextAction
      : schedule?.pwmState;
    // 智能 OFF 的下一次 ON 只能由 :00/:30 边界触发。22:50 一类残留
    // interval clock 不可信；只有带 typed ownership 的一分钟 smart retry
    // 可显式越过半点约束。
    if (schedule?.enabled
        && schedule?.smartMode?.enabled
        && smartNextAction === 'on'
        && intervalKeepsFutureClock
        && context.allowNonBoundarySmartClock !== true
        && !isHalfHourBoundary(
          intervalDecision.scheduledTime,
          context.smartBoundaryToleranceMs
        )) {
      return {
        kind: 'repair-clock',
        strategy: 'smart',
        reason: 'untrusted-smart-on-clock',
        nextAction: 'on',
        smartDecisionReason: smartDecision.reason
      };
    }
    return {
      ...intervalDecision,
      smartDecisionReason: smartDecision.reason
    };
  }

  return { planPwmLifecycleRecovery };
});
