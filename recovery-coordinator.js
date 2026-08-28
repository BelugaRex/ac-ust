(function exposeRecoveryCoordinator(root, factory) {
  const dependencies = typeof module !== 'undefined' && module.exports
    ? {
        ...require('./smart-recovery.js'),
        ...require('./interval-recovery.js'),
        ...require('./pwm-phase.js')
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
  planIntervalRecovery,
  classifySmartOnClock
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
    const intervalDecision = planIntervalRecovery(context);
    const intervalKeepsFutureClock = intervalDecision.kind === 'preserve-live-alarm'
      || intervalDecision.kind === 'restore-stored-alarm';
    const intervalHasScheduledClock = Number(intervalDecision.scheduledTime) > 0;
    const smartNextAction = context.smartNextAction === 'on'
        || context.smartNextAction === 'off'
      ? context.smartNextAction
      : schedule?.pwmState;
    // 智能 OFF 的下一次 ON 必须属于“现在应到的最近半点”。三方一致的
    // 19:30 仍可能已经跳过 19:00；只有 marker、alarm 与剩余 ON 截止都
    // 匹配的 typed retry 可显式越过普通半点约束。
    const smartClockAssessment = typeof classifySmartOnClock === 'function'
      ? classifySmartOnClock(
          { ...schedule, pwmState: smartNextAction },
          intervalDecision.scheduledTime,
          {
            now: context.now,
            plannedAt: context.smartClockPlannedAt,
            nextAction: smartNextAction,
            toleranceMs: context.smartBoundaryToleranceMs,
            allowDue: !intervalKeepsFutureClock,
            requirePlannedAt: context.requireSmartClockPlannedAt === true
          }
        )
      : null;
    if (schedule?.enabled
        && schedule?.smartMode?.enabled
        && smartNextAction === 'on'
        && intervalHasScheduledClock
        && (smartClockAssessment
          ? !smartClockAssessment.valid
          : (context.allowNonBoundarySmartClock !== true
            && !isHalfHourBoundary(
              intervalDecision.scheduledTime,
              context.smartBoundaryToleranceMs
            )))) {
      const skippedNearestBoundary = smartClockAssessment?.kind
        === 'skipped-nearest-boundary';
      return {
        kind: 'repair-clock',
        strategy: 'smart',
        reason: skippedNearestBoundary
          ? 'skipped-nearest-smart-on-boundary'
          : 'untrusted-smart-on-clock',
        nextAction: 'on',
        ...(Number(smartClockAssessment?.expectedAt) > 0
          ? { expectedAt: smartClockAssessment.expectedAt }
          : {}),
        smartDecisionReason: smartDecision.reason
      };
    }
    if (intervalKeepsFutureClock
        && smartClockAssessment?.valid
        && (smartClockAssessment.kind === 'safety-skip'
          || smartClockAssessment.kind === 'safety-timer-retry')) {
      return {
        ...intervalDecision,
        smartDecisionReason: 'explicit-smart-on-safety-skip'
      };
    }
    if (smartDecision.kind === 'recover-smart-current-cycle') {
      return smartDecision;
    }
    return {
      ...intervalDecision,
      smartDecisionReason: smartDecision.reason
    };
  }

  return { planPwmLifecycleRecovery };
});
