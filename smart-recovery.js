(function exposeSmartRecovery(root, factory) {
  const dependencies = typeof module !== 'undefined' && module.exports
    ? require('./pwm-phase.js')
    : root;
  const api = factory(dependencies);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createSmartRecovery({
  planSmartModeOnWindow
}) {
  function passSmartRecovery(reason) {
    return { kind: 'pass', strategy: 'smart', reason };
  }

  function planSmartRecovery(schedule, context = {}) {
    if (!schedule?.enabled) return passSmartRecovery('automation-disabled');
    if (!schedule?.smartMode?.enabled) return passSmartRecovery('smart-mode-disabled');
    if (typeof planSmartModeOnWindow !== 'function') {
      return passSmartRecovery('smart-window-planner-unavailable');
    }

    const now = Number.isFinite(context.now) ? context.now : Date.now();
    const maxOnMinutes = Number(context.maxOnMinutes);
    const recoveryWindow = planSmartModeOnWindow(schedule, {
      now,
      maxOnMinutes,
      acIsOn: false,
      recoverCurrentCycle: true
    });
    if (recoveryWindow?.kind !== 'allow'
        || recoveryWindow.reason !== 'smart-on-current-cycle-recovery') {
      return passSmartRecovery(recoveryWindow?.reason || 'no-current-smart-window');
    }

    const plannedActionAt = Number(context.plannedActionAt);
    const currentWindowEndsAt = Number(recoveryWindow.pageTimerTargetAt);
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
