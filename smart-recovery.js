(function exposeSmartRecovery(root, factory) {
  const dependencies = typeof module !== 'undefined' && module.exports
    ? require('./smart-phase.js')
    : root;
  const api = factory(dependencies);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createSmartRecovery({
  planSmartModeOnWindow,
  classifySmartOnClock
}) {
  function passSmartRecovery(reason) {
    return { kind: 'pass', strategy: 'smart', reason };
  }

  function getSmartRecoveryCandidateAt(context) {
    const candidates = [
      context.candidateAt,
      context.liveAlarmAt,
      context.expiredAlarmAt,
      context.storedAlarmAt
    ];
    return candidates
      .map(Number)
      .find(candidate => Number.isFinite(candidate) && candidate > 0) || 0;
  }

  function preserveSmartAlarm(context, candidateAt, reason) {
    const now = Number(context.now);
    const liveAlarmAt = Number(context.liveAlarmAt);
    const storedAlarmAt = Number(context.storedAlarmAt);
    const liveIsFuture = Number.isFinite(liveAlarmAt) && liveAlarmAt > now;
    const storedIsFuture = Number.isFinite(storedAlarmAt) && storedAlarmAt > now;
    const scheduledTime = liveIsFuture
      ? liveAlarmAt
      : storedIsFuture
        ? storedAlarmAt
        : candidateAt;
    return {
      kind: liveIsFuture ? 'preserve-live-alarm' : 'restore-stored-alarm',
      strategy: 'smart',
      reason,
      smartDecisionReason: reason,
      scheduledTime
    };
  }

  function planSmartRecovery(schedule, context = {}) {
    if (!schedule?.enabled) return passSmartRecovery('automation-disabled');
    if (!schedule?.smartMode?.enabled) return passSmartRecovery('smart-mode-disabled');
    const contextNextAction = context.smartNextAction === 'on'
      || context.smartNextAction === 'off'
      ? context.smartNextAction
      : schedule.smartState;
    if (contextNextAction !== 'on') {
      const now = Number.isFinite(context.now) ? context.now : Date.now();
      const liveAlarmAt = Number(context.liveAlarmAt);
      const storedAlarmAt = Number(context.storedAlarmAt);
      const futureAlarmAt = [liveAlarmAt, storedAlarmAt]
        .find(candidate => Number.isFinite(candidate) && candidate > now) || 0;
      return futureAlarmAt > 0
        ? preserveSmartAlarm(context, futureAlarmAt, 'current-smart-alarm-preserved')
        : passSmartRecovery('next-action-not-on');
    }

    const recoverySchedule = schedule.smartState === 'on'
      ? schedule
      : { ...schedule, smartState: 'on' };
    const candidateAt = getSmartRecoveryCandidateAt(context);
    let clock = null;
    if (typeof classifySmartOnClock === 'function'
        && candidateAt > 0) {
      clock = classifySmartOnClock(recoverySchedule, candidateAt, {
        now: context.now,
        plannedAt: context.smartClockPlannedAt,
        nextAction: 'on',
        toleranceMs: context.smartBoundaryToleranceMs,
        allowDue: context.allowDue === true,
        requirePlannedAt: context.requireSmartClockPlannedAt === true
      });
      if (clock?.applicable && !clock.valid) {
        return {
          kind: 'repair-clock',
          strategy: 'smart',
          reason: clock.kind === 'skipped-nearest-boundary'
              && Number(recoverySchedule.onMinutes) > 0
            ? 'skipped-nearest-smart-on-boundary'
            : 'untrusted-smart-on-clock',
          nextAction: 'on',
          ...(Number(clock.expectedAt) > 0
            ? { expectedAt: clock.expectedAt }
            : {})
        };
      }
        if (clock?.valid && clock.kind === 'safety-skip') {
          return preserveSmartAlarm(context, candidateAt, 'explicit-smart-on-safety-skip');
        }
        if (clock?.valid && clock.kind === 'safety-timer-retry') {
          return preserveSmartAlarm(context, candidateAt, 'smart-safety-timer-retry-preserved');
        }
        if (clock?.valid && clock.kind === 'typed-retry'
            && Number(context.storedAlarmAt) > Number(context.now)) {
          return preserveSmartAlarm(context, candidateAt, 'smart-typed-retry-preserved');
        }
    }
    if (typeof planSmartModeOnWindow !== 'function') {
      return passSmartRecovery('smart-window-planner-unavailable');
    }

    const now = Number.isFinite(context.now) ? context.now : Date.now();
      const maxOnMinutes = context.maxOnMinutes === undefined
        ? undefined
        : Number(context.maxOnMinutes);
      const recoveryWindow = planSmartModeOnWindow(recoverySchedule, {
      now,
      maxOnMinutes,
      acIsOn: false,
      recoverCurrentCycle: true
    });
      const plannedActionAt = Number(context.plannedActionAt);
      const currentWindowEndsAt = Number(recoveryWindow?.pageTimerTargetAt);
      if (clock?.valid
          && Number(context.liveAlarmAt) > now
          && plannedActionAt > now
          && plannedActionAt <= currentWindowEndsAt) {
        return preserveSmartAlarm(context, candidateAt, 'current-smart-alarm-preserved');
      }
      if (clock?.valid
          && Number(context.liveAlarmAt) > now
          && Number(context.liveAlarmAt) === candidateAt
          && recoveryWindow?.kind !== 'allow') {
        return preserveSmartAlarm(context, candidateAt, 'current-smart-alarm-preserved');
      }
    if (recoveryWindow?.kind !== 'allow'
        || recoveryWindow.reason !== 'smart-on-current-cycle-recovery') {
      return passSmartRecovery(recoveryWindow?.reason || 'no-current-smart-window');
    }

    if (Number.isFinite(plannedActionAt)
        && plannedActionAt > now
        && plannedActionAt <= currentWindowEndsAt) {
      return passSmartRecovery('current-cycle-action-preserved');
    }

    return {
      kind: 'recover-smart-current-cycle',
      strategy: 'smart',
      reason: recoveryWindow.reason,
      nextAction: 'on',
      scheduledTime: recoveryWindow.boundaryAt,
      boundaryAt: recoveryWindow.boundaryAt,
      windowEndsAt: recoveryWindow.windowEndsAt,
      pageTimerTargetAt: recoveryWindow.pageTimerTargetAt
    };
  }

  return { planSmartRecovery };
});
