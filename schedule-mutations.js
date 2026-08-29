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
    const previousAt = Number(scheduleState.nextTriggerAt) || 0;
    const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
    const requestedPlannedAt = Number(options?.plannedAt);
    const existingPlannedAt = Number(scheduleState.smartClockPlannedAt) || 0;
    const legacyPlannedAt = Number(scheduleState.alarmCreatedAt) || 0;
    const toleranceMs = Number(options?.toleranceMs) || 0;
    const sameClock = previousAt > 0
      && normalizedAt > 0
      && Math.abs(previousAt - normalizedAt) <= toleranceMs;

    scheduleState.nextTriggerAt = normalizedAt;
    if (normalizedAt <= 0) {
      scheduleState.smartClockPlannedAt = 0;
    } else if (Number.isFinite(requestedPlannedAt) && requestedPlannedAt > 0) {
      scheduleState.smartClockPlannedAt = requestedPlannedAt;
    } else if (!sameClock || existingPlannedAt <= 0) {
      const readNow = typeof options?.readNow === 'function'
        ? options.readNow
        : Date.now;
      scheduleState.smartClockPlannedAt = sameClock && legacyPlannedAt > 0
        ? legacyPlannedAt
        : readNow();
    }
  }

  return Object.freeze({ setScheduleNextTrigger });
});
