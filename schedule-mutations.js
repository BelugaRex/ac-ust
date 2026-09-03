(function exposeScheduleMutations(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createScheduleMutations() {
  'use strict';

  function setScheduleNextTrigger(scheduleState, nextTriggerAt, options = {}) {
    const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
    scheduleState.nextTriggerAt = normalizedAt;
  }

  function setSchedulePwmClockIntent(scheduleState, nextTriggerAt, options = {}) {
    const previousAt = Number(scheduleState.nextTriggerAt) || 0;
    const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
    const requestedPlannedAt = Number(options?.plannedAt);
    const existingPlannedAt = Number(scheduleState.pwmClockPlannedAt) || 0;
    const legacyPlannedAt = Number(scheduleState.alarmCreatedAt) || 0;
    const toleranceMs = Number(options?.toleranceMs) || 0;
    const sameClock = previousAt > 0
      && normalizedAt > 0
      && Math.abs(previousAt - normalizedAt) <= toleranceMs;

    scheduleState.nextTriggerAt = normalizedAt;
    if (normalizedAt <= 0) {
      scheduleState.pwmClockPlannedAt = 0;
    } else if (Number.isFinite(requestedPlannedAt) && requestedPlannedAt > 0) {
      scheduleState.pwmClockPlannedAt = requestedPlannedAt;
    } else if (!sameClock || existingPlannedAt <= 0) {
      const readNow = typeof options?.readNow === 'function'
        ? options.readNow
        : Date.now;
      scheduleState.pwmClockPlannedAt = sameClock && legacyPlannedAt > 0
        ? legacyPlannedAt
        : readNow();
    }
    scheduleState.alarmCreatedAt = 0;
    scheduleState.alarmDelayMinutes = 0;
  }

  function setScheduleSmartClockIntent(scheduleState, nextTriggerAt, options = {}) {
    const previousAt = Number(scheduleState.smartNextTriggerAt) || 0;
    const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
    const requestedPlannedAt = Number(options?.plannedAt);
    const existingPlannedAt = Number(scheduleState.smartClockPlannedAt) || 0;
    const toleranceMs = Number(options?.toleranceMs) || 0;
    const sameClock = previousAt > 0
      && normalizedAt > 0
      && Math.abs(previousAt - normalizedAt) <= toleranceMs;

    scheduleState.smartNextTriggerAt = normalizedAt;
    if (normalizedAt <= 0) {
      scheduleState.smartClockPlannedAt = 0;
    } else if (Number.isFinite(requestedPlannedAt) && requestedPlannedAt > 0) {
      scheduleState.smartClockPlannedAt = requestedPlannedAt;
    } else if (!sameClock || existingPlannedAt <= 0) {
      const readNow = typeof options?.readNow === 'function'
        ? options.readNow
        : Date.now;
      scheduleState.smartClockPlannedAt = readNow();
    }
  }

  function replaceSchedulePwmRetryState(
    scheduleState,
    { kind = '', boundaryAt = 0, scheduledAt = 0 } = {}
  ) {
    scheduleState.pwmRetryKind = kind;
    scheduleState.pwmRetryBoundaryAt = boundaryAt;
    scheduleState.pwmRetryScheduledAt = scheduledAt;
  }

  function replaceScheduleSmartRetryState(
    scheduleState,
    { kind = '', boundaryAt = 0, scheduledAt = 0 } = {}
  ) {
    scheduleState.smartRetryKind = kind;
    scheduleState.smartRetryBoundaryAt = boundaryAt;
    scheduleState.smartRetryScheduledAt = scheduledAt;
  }

  function replaceSchedulePageTimerRetryState(
    scheduleState,
    { retryAt = 0, retryMinutes = 0 } = {}
  ) {
    scheduleState.pageTimerRetryAt = retryAt;
    scheduleState.pageTimerRetryMinutes = retryMinutes;
  }

  function replaceSchedulePageTimerState(
    scheduleState,
    {
      minutes = null,
      targetAt = 0,
      error = '',
      retryAt = 0,
      retryMinutes = 0
    } = {}
  ) {
    scheduleState.pageTimerMinutes = minutes;
    scheduleState.pageTimerTargetAt = targetAt;
    scheduleState.pageTimerError = error;
    replaceSchedulePageTimerRetryState(scheduleState, {
      retryAt,
      retryMinutes
    });
  }

  function recordSchedulePageTimerFailureState(
    scheduleState,
    error,
    retryState = {}
  ) {
    replaceSchedulePageTimerState(scheduleState, {
      error,
      retryAt: retryState.retryAt,
      retryMinutes: retryState.retryMinutes
    });
  }

  function clearSchedulePageTimerProofState(scheduleState) {
    recordSchedulePageTimerProofState(scheduleState, null, 0);
  }

  function recordSchedulePageTimerProofState(scheduleState, minutes, targetAt) {
    replaceSchedulePageTimerState(scheduleState, { minutes, targetAt });
  }

  return Object.freeze({
    setScheduleNextTrigger,
    setSchedulePwmClockIntent,
    setScheduleSmartClockIntent,
    replaceSchedulePwmRetryState,
    replaceScheduleSmartRetryState,
    replaceSchedulePageTimerRetryState,
    replaceSchedulePageTimerState,
    recordSchedulePageTimerFailureState,
    clearSchedulePageTimerProofState,
    recordSchedulePageTimerProofState
  });
});
