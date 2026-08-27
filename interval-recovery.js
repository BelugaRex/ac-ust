(function exposeIntervalRecovery(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createIntervalRecovery() {
  function futureTimestamp(value, now) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > now ? timestamp : 0;
  }

  function dueTimestamp(value, now) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now
      ? timestamp
      : 0;
  }

  function intervalPlan(kind, reason, scheduledTime = 0) {
    return {
      kind,
      strategy: 'interval',
      reason,
      ...(scheduledTime > 0 ? { scheduledTime } : {})
    };
  }

  function planIntervalRecovery(context = {}) {
    const now = Number.isFinite(context.now) ? context.now : Date.now();
    const liveAlarmAt = futureTimestamp(context.liveAlarmAt, now);
    if (liveAlarmAt) {
      return intervalPlan('preserve-live-alarm', 'future-live-alarm', liveAlarmAt);
    }

    const storedAlarmAt = futureTimestamp(context.storedAlarmAt, now);
    if (storedAlarmAt) {
      return intervalPlan('restore-stored-alarm', 'future-stored-alarm', storedAlarmAt);
    }

    const expiredAlarmAt = dueTimestamp(context.expiredAlarmAt, now);
    if (expiredAlarmAt) {
      return intervalPlan('advance-expired-alarm', 'expired-live-alarm', expiredAlarmAt);
    }

    const storedDueAt = dueTimestamp(context.storedAlarmAt, now);
    if (storedDueAt) {
      return intervalPlan('execute-due-action', 'stored-action-due', storedDueAt);
    }

    if (context.missingClockAction === 'execute-current') {
      return intervalPlan('execute-current-action', 'missing-clock-execute-current');
    }
    if (context.missingClockAction === 'repair-clock') {
      return intervalPlan('repair-clock', 'missing-clock-repair');
    }
    return intervalPlan('noop', 'no-recovery-needed');
  }

  return { planIntervalRecovery };
});
