(function exposeSmartPhase(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function createSmartPhase() {
  'use strict';

  const getSmartRetryDescriptor = typeof module !== 'undefined' && module.exports
    ? require('./smart-retry.js').getSmartRetryDescriptor
    : globalThis.getSmartRetryDescriptor;

  const MINUTE_MS = 60_000;
  const ON_WINDOW_MS = MINUTE_MS;
  const MIN_OFF_MINUTES = 5;
  const ON_MAX_MINUTES = 25;
  const ALARM_TOLERANCE_MS = 1500;

  function smartPhaseNow(opts = {}) {
    return Number.isFinite(opts.now) ? opts.now : Date.now();
  }

  function smartHalfHourBoundaryAtOrBefore(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return 0;
    const date = new Date(value);
    date.setMinutes(date.getMinutes() < 30 ? 0 : 30, 0, 0);
    return date.getTime();
  }

  function nextSmartHalfHourBoundary(timestamp = Date.now()) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return 0;
    const date = new Date(value);
    if (date.getMinutes() < 30) {
      date.setMinutes(30, 0, 0);
    } else {
      date.setMinutes(0, 0, 0);
      date.setHours(date.getHours() + 1);
    }
    return date.getTime();
  }

  function isSmartHalfHourBoundary(timestamp) {
    const value = Number(timestamp);
    if (!Number.isSafeInteger(value)) return false;
    const date = new Date(value);
    return (date.getMinutes() === 0 || date.getMinutes() === 30)
      && date.getSeconds() === 0
      && date.getMilliseconds() === 0;
  }

  function normalizeSmartHalfHourAlarmBoundary(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const lower = smartHalfHourBoundaryAtOrBefore(value);
    const upper = nextSmartHalfHourBoundary(value);
    const boundary = Math.abs(value - lower) <= Math.abs(upper - value)
      ? lower
      : upper;
    return Math.abs(value - boundary) <= ALARM_TOLERANCE_MS ? boundary : 0;
  }

  function smartPageTimerTargetAt(onMinutes, now = Date.now(), boundaryAt) {
    const duration = Number(onMinutes);
    const boundary = boundaryAt === undefined
      ? smartHalfHourBoundaryAtOrBefore(now)
      : Number(boundaryAt);
    if (!Number.isInteger(duration)
        || duration <= 0
        || duration > ON_MAX_MINUTES
        || !isSmartHalfHourBoundary(boundary)) {
      return 0;
    }
    return boundary + duration * MINUTE_MS;
  }

  function hasMinimumOnRunway(targetAt, now) {
    return Number.isFinite(Number(targetAt))
      && Number.isFinite(Number(now))
      && Number(targetAt) - Number(now) >= MIN_OFF_MINUTES * MINUTE_MS;
  }

  function planSmartStep(schedule, opts = {}) {
    const now = smartPhaseNow(opts);
    if (!schedule?.enabled) return { kind: 'noop', reason: 'disabled' };
    if (schedule?.smartMode?.enabled !== true) {
      return { kind: 'noop', reason: 'smart-mode-disabled' };
    }

    const storedOnMinutes = Number(schedule.onMinutes);
    const onMinutes = storedOnMinutes === 30
      && Number(schedule.offMinutes) === 30
      ? 0
      : storedOnMinutes;
    const alarmAt = Number(opts.alarmScheduledAt);
    const boundaryAt = normalizeSmartHalfHourAlarmBoundary(alarmAt);
    const nextBoundaryAt = nextSmartHalfHourBoundary(now);
    const nextAction = schedule.smartState === 'off' ? 'off' : 'on';

    if (nextAction === 'off') {
      if (!Number.isFinite(alarmAt) || alarmAt <= 0 || alarmAt > now + ALARM_TOLERANCE_MS) {
        return {
          kind: 'wait',
          reason: 'smart-off-alarm-not-due',
          nextAction: 'off',
          nextTriggerAt: alarmAt > now ? alarmAt : 0
        };
      }
      return {
        kind: 'finish',
        reason: 'smart-off-boundary',
        nextAction: 'on',
        offAt: alarmAt,
        nextTriggerAt: nextSmartHalfHourBoundary(Math.max(now, alarmAt + MIN_OFF_MINUTES * MINUTE_MS))
      };
    }

    if (!boundaryAt || boundaryAt > now + ALARM_TOLERANCE_MS) {
      return {
        kind: 'defer',
        reason: 'smart-on-requires-half-hour-alarm',
        nextAction: 'on',
        nextTriggerAt: nextBoundaryAt
      };
    }

    const windowEndsAt = boundaryAt + ON_WINDOW_MS;
    const targetAt = smartPageTimerTargetAt(onMinutes, boundaryAt);
    if (onMinutes <= 0) {
      return {
        kind: 'skip',
        reason: 'smart-zero-duration',
        nextAction: 'on',
        boundaryAt,
        nextTriggerAt: nextSmartHalfHourBoundary(boundaryAt)
      };
    }
    if (now >= windowEndsAt || !hasMinimumOnRunway(targetAt, now)) {
      return {
        kind: 'defer',
        reason: now >= windowEndsAt
          ? 'smart-on-window-expired'
          : 'smart-on-runway-too-short',
        nextAction: 'on',
        nextTriggerAt: nextSmartHalfHourBoundary(now)
      };
    }

    return {
      kind: 'start',
      reason: 'smart-on-half-hour',
      nextAction: 'off',
      boundaryAt,
      windowEndsAt,
      onMinutes,
      targetAt,
      nextTriggerAt: targetAt
    };
  }

  function smartPhaseTolerance(value, fallback) {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  }

  function planComfortSmartCycle(planningNow, minimumTargetAt, opts = {}) {
    const now = Number(planningNow);
    const minimum = Number(minimumTargetAt);
    const requestedStableMinutes = Number(opts.minimumStableMinutes);
    const minimumStableMinutes = Number.isFinite(requestedStableMinutes)
      ? Math.max(0, requestedStableMinutes)
      : MIN_OFF_MINUTES;
    if (!Number.isFinite(now) || !Number.isFinite(minimum)) {
      return { boundaryAt: 0, rollsIntoNextBoundary: false };
    }
    const nextBoundaryAt = nextSmartHalfHourBoundary(now);
    const shortOffGapMs = nextBoundaryAt - minimum;
    const rollsIntoNextBoundary = minimum >= nextBoundaryAt
      || (shortOffGapMs > 0
        && shortOffGapMs < minimumStableMinutes * MINUTE_MS);
    return {
      boundaryAt: rollsIntoNextBoundary
        ? nextBoundaryAt
        : smartHalfHourBoundaryAtOrBefore(now),
      rollsIntoNextBoundary
    };
  }

  function nextSmartHalfHourBoundaryAtOrAfter(timestamp) {
    return isSmartHalfHourBoundary(timestamp)
      ? Number(timestamp)
      : nextSmartHalfHourBoundary(timestamp);
  }

  function nextSafeSmartPageTimerTargetAt(now = Date.now()) {
    const nowMs = Number(now);
    if (!Number.isFinite(nowMs)) return 0;
    return Math.ceil((nowMs + MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  }

  function hasMinimumSmartOnRunway(targetAt, actionAt) {
    const target = Number(targetAt);
    const action = Number(actionAt);
    return Number.isFinite(target)
      && Number.isFinite(action)
      && target - action >= MIN_OFF_MINUTES * MINUTE_MS;
  }

  function planSmartModeOnWindow(schedule, opts = {}) {
    const now = smartPhaseNow(opts);
    const onMinutes = Number(schedule?.onMinutes);
    const requestedMaxOnMinutes = opts?.maxOnMinutes === undefined
      ? ON_MAX_MINUTES
      : Number(opts.maxOnMinutes);
    const maxOnMinutes = Math.min(requestedMaxOnMinutes, ON_MAX_MINUTES);
    if (!Number.isInteger(onMinutes) || onMinutes <= 0
        || !Number.isFinite(maxOnMinutes) || maxOnMinutes <= 0
        || onMinutes > maxOnMinutes) {
      return { kind: 'refuse', reason: 'invalid-smart-on-duration' };
    }

    const acIsOn = opts?.acIsOn === true;
    const recoverCurrentCycle = opts?.recoverCurrentCycle === true;
    const storedBoundaryAt = Number(opts?.boundaryAt);
    const triggeredBoundaryAt = normalizeSmartHalfHourAlarmBoundary(
      opts?.triggeredBoundaryAt
    );
    const triggeredPageTimerTargetAt = smartPageTimerTargetAt(
      onMinutes,
      triggeredBoundaryAt
    );
    const hasTriggeredBoundary = isSmartHalfHourBoundary(triggeredBoundaryAt)
      && triggeredBoundaryAt <= now
      && triggeredPageTimerTargetAt >= nextSafeSmartPageTimerTargetAt(now);
    const hasActiveBoundary = acIsOn
      && isSmartHalfHourBoundary(storedBoundaryAt)
      && storedBoundaryAt <= now;
    const useTriggeredBoundary = hasTriggeredBoundary
      && (!hasActiveBoundary || triggeredBoundaryAt > storedBoundaryAt);
    const boundaryAt = useTriggeredBoundary
      ? triggeredBoundaryAt
      : hasActiveBoundary
        ? storedBoundaryAt
        : smartHalfHourBoundaryAtOrBefore(now);
    const pageTimerTargetAt = smartPageTimerTargetAt(onMinutes, boundaryAt);
    if (acIsOn) {
      if (!hasActiveBoundary && !hasTriggeredBoundary) {
        return {
          kind: 'allow',
          reason: 'smart-on-overrun-shutdown',
          boundaryAt: 0,
          pageTimerTargetAt: nextSafeSmartPageTimerTargetAt(now)
        };
      }
      if (pageTimerTargetAt > now) {
        return {
          kind: 'allow',
          reason: 'smart-on-already-active',
          boundaryAt,
          pageTimerTargetAt
        };
      }
      return {
        kind: 'allow',
        reason: 'smart-on-overrun-shutdown',
        boundaryAt,
        pageTimerTargetAt: nextSafeSmartPageTimerTargetAt(now)
      };
    }

    if (hasTriggeredBoundary
        && hasMinimumSmartOnRunway(pageTimerTargetAt, now)) {
      return {
        kind: 'allow',
        reason: 'smart-on-scheduled-boundary',
        boundaryAt,
        windowEndsAt: pageTimerTargetAt,
        pageTimerTargetAt
      };
    }

    if (recoverCurrentCycle
        && hasMinimumSmartOnRunway(pageTimerTargetAt, now)) {
      return {
        kind: 'allow',
        reason: 'smart-on-current-cycle-recovery',
        boundaryAt,
        windowEndsAt: pageTimerTargetAt,
        pageTimerTargetAt
      };
    }

    if (now - boundaryAt < MINUTE_MS
        && hasMinimumSmartOnRunway(pageTimerTargetAt, now)) {
      return {
        kind: 'allow',
        reason: 'smart-on-window',
        boundaryAt,
        windowEndsAt: boundaryAt + MINUTE_MS,
        pageTimerTargetAt
      };
    }

    const nextTriggerAt = nextSmartHalfHourBoundary(now);
    return {
      kind: 'defer',
      reason: 'wait-for-smart-on-window',
      nextAction: 'on',
      nextTriggerAt,
      delayMinutes: Math.max(1, (nextTriggerAt - now) / MINUTE_MS),
      phasePatch: { smartState: 'on', nextTriggerAt }
    };
  }

  function planSmartOnRetryExceptionRecovery(schedule, boundaryAt, opts = {}) {
    const now = smartPhaseNow(opts);
    const requestedRetryAt = Number.isFinite(opts?.retryAt)
      ? Number(opts.retryAt)
      : now + MINUTE_MS;
    const onMinutes = Number(schedule?.onMinutes);
    const normalizedBoundaryAt = normalizeSmartHalfHourAlarmBoundary(boundaryAt);
    const targetAt = normalizedBoundaryAt + onMinutes * MINUTE_MS;
    const canRetry = Number.isInteger(onMinutes)
      && onMinutes > 0
      && onMinutes <= ON_MAX_MINUTES
      && isSmartHalfHourBoundary(normalizedBoundaryAt)
      && normalizedBoundaryAt > 0
      && requestedRetryAt > now
      && hasMinimumSmartOnRunway(targetAt, requestedRetryAt);
    if (canRetry) {
      return {
        kind: 'retry-smart-on-exception',
        reason: 'smart-on-retry-exception-safe',
        nextAction: 'on',
        nextTriggerAt: requestedRetryAt,
        boundaryAt: normalizedBoundaryAt,
        pageTimerTargetAt: targetAt,
        phasePatch: { smartState: 'on', nextTriggerAt: requestedRetryAt }
      };
    }

    const nextTriggerAt = nextSmartHalfHourBoundary(now);
    return {
      kind: 'defer',
      reason: 'smart-on-retry-exception-unsafe',
      nextAction: 'on',
      nextTriggerAt,
      delayMinutes: Math.max(1, (nextTriggerAt - now) / MINUTE_MS),
      phasePatch: { smartState: 'on', nextTriggerAt }
    };
  }

  function planSmartOnAfterConfirmedOff(schedule, opts = {}) {
    const now = smartPhaseNow(opts);
    const confirmedOffAt = Number(opts?.confirmedOffAt);
    const minOffMinutes = Number(opts?.minOffMinutes);
    const storedOnMinutes = Number(schedule?.onMinutes);
    const noRunSentinel = storedOnMinutes === 30
      && Number(schedule?.offMinutes) === 30;
    const onMinutes = noRunSentinel ? 0 : storedOnMinutes;
    const validOnDuration = Number.isInteger(onMinutes)
      && onMinutes >= 0
      && onMinutes <= ON_MAX_MINUTES;
    if (!schedule?.enabled
        || schedule?.smartMode?.enabled !== true
        || !Number.isFinite(confirmedOffAt)
        || confirmedOffAt <= 0
        || confirmedOffAt > now
        || !Number.isFinite(minOffMinutes)
        || minOffMinutes <= 0) {
      return { kind: 'refuse', reason: 'invalid-smart-off-confirmation' };
    }

    const requestedBoundaryAt = normalizeSmartHalfHourAlarmBoundary(opts?.boundaryAt);
    const boundaryAt = requestedBoundaryAt > 0
      ? requestedBoundaryAt
      : nextSmartHalfHourBoundary(now);
    const nearestBoundaryAt = nextSmartHalfHourBoundary(now);
    const notBeforeAt = confirmedOffAt + minOffMinutes * MINUTE_MS;
    const planBoundaryEvaluation = (nextTriggerAt, reason) => {
      const markerBoundaryAt = smartHalfHourBoundaryAtOrBefore(nextTriggerAt - 1);
      return {
        kind: 'smart-on-safety-skip',
        reason,
        nextAction: 'on',
        nextTriggerAt,
        boundaryAt: markerBoundaryAt,
        skippedBoundaryAt: boundaryAt,
        pageTimerTargetAt: onMinutes > 0
          ? smartPageTimerTargetAt(onMinutes, nextTriggerAt)
          : 0,
        delayMinutes: Math.max(1, (nextTriggerAt - now) / MINUTE_MS),
        phasePatch: { smartState: 'on', nextTriggerAt }
      };
    };
    if (!validOnDuration) {
      return planBoundaryEvaluation(
        nextSmartHalfHourBoundaryAtOrAfter(notBeforeAt),
        'smart-invalid-duration-next-evaluation'
      );
    }
    if (onMinutes === 0) {
      return planBoundaryEvaluation(
        nextSmartHalfHourBoundaryAtOrAfter(notBeforeAt),
        'smart-zero-duration-next-evaluation'
      );
    }
    if (boundaryAt >= notBeforeAt) {
      if (boundaryAt === nearestBoundaryAt) {
        return {
          kind: 'smart-on-boundary',
          reason: 'compressor-safe-nearest-boundary',
          nextAction: 'on',
          nextTriggerAt: boundaryAt,
          boundaryAt,
          pageTimerTargetAt: smartPageTimerTargetAt(onMinutes, boundaryAt),
          delayMinutes: Math.max(1, (boundaryAt - now) / MINUTE_MS),
          phasePatch: { smartState: 'on', nextTriggerAt: boundaryAt }
        };
      }
      return planBoundaryEvaluation(
        boundaryAt,
        'compressor-safe-requested-later-boundary'
      );
    }

    const retryPlan = planSmartOnRetryExceptionRecovery(
      schedule,
      boundaryAt,
      { now, retryAt: notBeforeAt }
    );
    if (retryPlan.kind === 'retry-smart-on-exception') {
      return {
        ...retryPlan,
        kind: 'smart-on-safe-delay',
        reason: 'compressor-min-off-safe-delay',
        delayMinutes: Math.max(1, (retryPlan.nextTriggerAt - now) / MINUTE_MS)
      };
    }

    const nextTriggerAt = nextSmartHalfHourBoundaryAtOrAfter(notBeforeAt);
    return planBoundaryEvaluation(
      nextTriggerAt,
      'compressor-min-off-window-exhausted'
    );
  }

  function classifySmartOnClock(schedule, candidateAt, opts = {}) {
    const now = smartPhaseNow(opts);
    const candidate = Number(candidateAt);
    const nextAction = opts?.nextAction === 'on' || opts?.nextAction === 'off'
      ? opts.nextAction
      : schedule?.smartState;
    const toleranceMs = smartPhaseTolerance(
      Number(opts?.toleranceMs),
      ALARM_TOLERANCE_MS
    );
    const allowDue = opts?.allowDue === true;
    const requirePlannedAt = opts?.requirePlannedAt === true;
    const storedOnMinutes = Number(schedule?.onMinutes);
    const onMinutes = storedOnMinutes === 30 && Number(schedule?.offMinutes) === 30
      ? 0
      : storedOnMinutes;
    if (!schedule?.enabled
        || schedule?.smartMode?.enabled !== true
        || nextAction !== 'on') {
      return {
        applicable: false,
        valid: true,
        kind: 'not-applicable',
        candidateAt: Number.isFinite(candidate) ? candidate : 0,
        expectedAt: 0,
        boundaryAt: 0
      };
    }

    const requestedPlannedAt = Number(opts?.plannedAt);
    const hasDurablePlannedAt = Number.isFinite(requestedPlannedAt)
      && requestedPlannedAt > 0
      && requestedPlannedAt <= now + toleranceMs;
    const plannedAt = hasDurablePlannedAt ? requestedPlannedAt : now;
    const plannedLowerBoundaryAt = smartHalfHourBoundaryAtOrBefore(plannedAt);
    const candidateBoundaryAt = normalizeSmartHalfHourAlarmBoundary(candidate);
    const plannedBoundaryAt = normalizeSmartHalfHourAlarmBoundary(plannedAt);
    const candidateOwnsPlannedBoundary = hasDurablePlannedAt
      && plannedBoundaryAt > 0
      && candidateBoundaryAt === plannedBoundaryAt;
    const expectedAt = hasDurablePlannedAt
      ? (candidateOwnsPlannedBoundary
        ? plannedBoundaryAt
        : nextSmartHalfHourBoundary(plannedAt))
      : (plannedAt - plannedLowerBoundaryAt <= toleranceMs
        ? plannedLowerBoundaryAt
        : nextSmartHalfHourBoundary(plannedAt));

    const retryKind = String(schedule?.smartRetryKind || '');
    const retryDescriptor = getSmartRetryDescriptor(retryKind);
    const retryBoundaryAt = Number(schedule?.smartRetryBoundaryAt);
    const retryScheduledAt = Number(schedule?.smartRetryScheduledAt);
    const retryTargetAt = smartPageTimerTargetAt(onMinutes, retryBoundaryAt);
    const validTypedRetry = retryDescriptor?.ownsTypedSmartOn === true
      && schedule?.smartState === 'on'
      && isSmartHalfHourBoundary(retryBoundaryAt)
      && Number.isFinite(retryScheduledAt)
      && Math.abs(candidate - retryScheduledAt) <= toleranceMs
      && candidate >= retryBoundaryAt
      && hasMinimumSmartOnRunway(retryTargetAt, Math.max(now, candidate));
    if (validTypedRetry) {
      return {
        applicable: true,
        valid: true,
        kind: 'typed-retry',
        retryKind,
        candidateAt: candidate,
        expectedAt,
        boundaryAt: retryBoundaryAt,
        pageTimerTargetAt: retryTargetAt
      };
    }

    const validSafetyTimerRetry = retryDescriptor?.repairsSafetyTimer === true
      && schedule?.smartState === 'on'
      && (retryBoundaryAt === 0 || isSmartHalfHourBoundary(retryBoundaryAt))
      && Number.isFinite(retryScheduledAt)
      && Math.abs(candidate - retryScheduledAt) <= toleranceMs;
    if (validSafetyTimerRetry
        && (candidate > now - toleranceMs || allowDue)) {
      return {
        applicable: true,
        valid: true,
        kind: 'safety-timer-retry',
        retryKind,
        candidateAt: candidate,
        expectedAt,
        boundaryAt: retryBoundaryAt
      };
    }

    const validSafetySkip = retryDescriptor?.reevaluatesAtNextBoundary === true
      && schedule?.smartState === 'on'
      && isSmartHalfHourBoundary(retryBoundaryAt)
      && Number.isFinite(retryScheduledAt)
      && Math.abs(candidate - retryScheduledAt) <= toleranceMs
      && Math.abs(candidate - nextSmartHalfHourBoundary(retryBoundaryAt)) <= toleranceMs;
    const safetySkipBoundaryAt = normalizeSmartHalfHourAlarmBoundary(candidate);
    const safetySkipTargetAt = smartPageTimerTargetAt(onMinutes, safetySkipBoundaryAt);
    const safetySkipDueSafe = onMinutes === 0
      ? now - candidate < MINUTE_MS
      : hasMinimumSmartOnRunway(safetySkipTargetAt, Math.max(now, candidate));
    if (validSafetySkip
        && (candidate > now - toleranceMs || (allowDue && safetySkipDueSafe))) {
      return {
        applicable: true,
        valid: true,
        kind: 'safety-skip',
        retryKind,
        candidateAt: candidate,
        expectedAt,
        boundaryAt: retryBoundaryAt
      };
    }

    if (retryDescriptor) {
      return {
        applicable: true,
        valid: false,
        kind: candidate <= now - toleranceMs
          ? 'smart-on-marker-expired'
          : 'smart-on-marker-mismatch',
        retryKind,
        candidateAt: Number.isFinite(candidate) ? candidate : 0,
        expectedAt,
        boundaryAt: Number.isFinite(retryBoundaryAt) ? retryBoundaryAt : 0
      };
    }

    if (requirePlannedAt && !hasDurablePlannedAt) {
      return {
        applicable: true,
        valid: false,
        kind: 'missing-clock-origin',
        candidateAt: Number.isFinite(candidate) ? candidate : 0,
        expectedAt,
        boundaryAt: 0
      };
    }

    const candidateMatchesExpected = Number.isFinite(candidate)
      && Math.abs(candidate - expectedAt) <= toleranceMs;
    const expectedPageTimerTargetAt = smartPageTimerTargetAt(onMinutes, expectedAt);
    const expectedDueSafe = onMinutes === 0
      ? now - candidate < MINUTE_MS
      : hasMinimumSmartOnRunway(expectedPageTimerTargetAt, Math.max(now, candidate));
    if (!Number.isFinite(candidate)
        || (candidate <= now - toleranceMs
          && !(allowDue && candidateMatchesExpected && expectedDueSafe))) {
      return {
        applicable: true,
        valid: false,
        kind: 'missing-or-expired-clock',
        candidateAt: Number.isFinite(candidate) ? candidate : 0,
        expectedAt,
        boundaryAt: expectedAt
      };
    }

    if (candidateMatchesExpected) {
      return {
        applicable: true,
        valid: true,
        kind: 'nearest-boundary',
        candidateAt: candidate,
        expectedAt,
        boundaryAt: expectedAt,
        pageTimerTargetAt: smartPageTimerTargetAt(onMinutes, expectedAt)
      };
    }

    return {
      applicable: true,
      valid: false,
      kind: candidateBoundaryAt > expectedAt
        ? 'skipped-nearest-boundary'
        : 'untrusted-nonboundary',
      candidateAt: candidate,
      expectedAt,
      boundaryAt: candidateBoundaryAt || 0
    };
  }

  function alignSmartModeNextTrigger(plan, now = Date.now(), options = {}) {
    if (!plan || plan.nextAction !== 'on') return;
    const currentTriggerAt = Number(plan.nextTriggerAt);
    if (!Number.isFinite(currentTriggerAt) || currentTriggerAt <= now) return;
    const requestedNotBeforeAt = Number(options?.notBeforeAt);
    const notBeforeAt = Number.isFinite(requestedNotBeforeAt)
      ? Math.max(now + 1, requestedNotBeforeAt)
      : now + 1;
    if (isSmartHalfHourBoundary(currentTriggerAt) && currentTriggerAt >= notBeforeAt) return;
    const nextBoundary = nextSmartHalfHourBoundaryAtOrAfter(notBeforeAt);
    if (nextBoundary <= now) return;
    plan.nextTriggerAt = nextBoundary;
    if (typeof plan.delayMinutes === 'number') {
      plan.delayMinutes = Math.max(1, (nextBoundary - now) / MINUTE_MS);
    }
    if (plan.phasePatch) plan.phasePatch.nextTriggerAt = nextBoundary;
  }

  function smartWeatherTargetBoundaryAt(prefetchAt) {
    const value = Number(prefetchAt);
    if (!Number.isSafeInteger(value)) return 0;
    const date = new Date(value);
    if (date.getSeconds() !== 0 || date.getMilliseconds() !== 0) return 0;
    if (date.getMinutes() === 20) {
      date.setMinutes(30, 0, 0);
      return date.getTime();
    }
    if (date.getMinutes() === 50) {
      date.setMinutes(0, 0, 0);
      date.setHours(date.getHours() + 1);
      return date.getTime();
    }
    return 0;
  }

  function planNextSmartWeatherPrefetch(now = Date.now()) {
    const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const nextTwenty = new Date(nowMs);
    nextTwenty.setMinutes(20, 0, 0);
    const nextFifty = new Date(nowMs);
    nextFifty.setMinutes(50, 0, 0);
    let prefetchAt;
    if (nextTwenty.getTime() > nowMs) {
      prefetchAt = nextTwenty.getTime();
    } else if (nextFifty.getTime() > nowMs) {
      prefetchAt = nextFifty.getTime();
    } else {
      nextTwenty.setHours(nextTwenty.getHours() + 1);
      prefetchAt = nextTwenty.getTime();
    }
    return {
      prefetchAt,
      boundaryAt: smartWeatherTargetBoundaryAt(prefetchAt)
    };
  }

  const nextHalfHourBoundary = nextSmartHalfHourBoundary;
  const halfHourBoundaryAtOrBefore = smartHalfHourBoundaryAtOrBefore;
  const isHalfHourBoundary = isSmartHalfHourBoundary;
  const normalizeHalfHourAlarmBoundary = normalizeSmartHalfHourAlarmBoundary;
  const nextHalfHourBoundaryAtOrAfter = nextSmartHalfHourBoundaryAtOrAfter;
  const nextSafePageTimerTargetAt = nextSafeSmartPageTimerTargetAt;
  const smartModePageTimerTargetAt = smartPageTimerTargetAt;

  return Object.freeze({
    planSmartStep,
    planComfortSmartCycle,
    MIN_OFF_MINUTES,
    ON_MAX_MINUTES,
    ALARM_TOLERANCE_MS,
    smartHalfHourBoundaryAtOrBefore,
    nextSmartHalfHourBoundary,
    isSmartHalfHourBoundary,
    normalizeSmartHalfHourAlarmBoundary,
    nextSmartHalfHourBoundaryAtOrAfter,
    nextSafeSmartPageTimerTargetAt,
    hasMinimumSmartOnRunway,
    smartPageTimerTargetAt,
    smartModePageTimerTargetAt,
    planNextSmartWeatherPrefetch,
    smartWeatherTargetBoundaryAt,
    planSmartModeOnWindow,
    planSmartOnRetryExceptionRecovery,
    planSmartOnAfterConfirmedOff,
    classifySmartOnClock,
    alignSmartModeNextTrigger,
    nextHalfHourBoundary,
    halfHourBoundaryAtOrBefore,
    isHalfHourBoundary,
    normalizeHalfHourAlarmBoundary,
    nextHalfHourBoundaryAtOrAfter,
    nextSafePageTimerTargetAt
  });
});