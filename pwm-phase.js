const PWM_PHASE_MINUTE_MS = 60_000;
const PWM_PHASE_RETRY_MINUTES = 1;

function pwmPhaseNow(opts) {
  return Number.isFinite(opts?.now) ? opts.now : Date.now();
}

function pwmPhaseTolerance(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function pwmPhaseDurations(schedule) {
  const onMinutes = Number(schedule?.onMinutes);
  const offMinutes = Number(schedule?.offMinutes);
  if (!Number.isFinite(onMinutes) || onMinutes <= 0
      || !Number.isFinite(offMinutes) || offMinutes <= 0) {
    return null;
  }
  return { onMinutes, offMinutes };
}

function pwmPhaseTargetAction(schedule) {
  return schedule?.pwmState === 'on' || schedule?.pwmState === 'off'
    ? schedule.pwmState
    : null;
}

function pwmPhaseRetryPlan(reason, nextAction, now, proofAction) {
  const nextTriggerAt = now + PWM_PHASE_RETRY_MINUTES * PWM_PHASE_MINUTE_MS;
  return {
    kind: 'retry',
    reason,
    nextAction,
    nextTriggerAt,
    delayMinutes: PWM_PHASE_RETRY_MINUTES,
    retryMinutes: PWM_PHASE_RETRY_MINUTES,
    ...(proofAction ? { proofAction } : {}),
    phasePatch: { pwmState: nextAction, nextTriggerAt }
  };
}

function pwmPhaseCommitPlan(reason, nextAction, nextTriggerAt, now, proofAction) {
  return {
    kind: 'commit',
    reason,
    nextAction,
    nextTriggerAt,
    delayMinutes: Math.max(1, (nextTriggerAt - now) / PWM_PHASE_MINUTE_MS),
    ...(proofAction ? { proofAction } : {}),
    phasePatch: { pwmState: nextAction, nextTriggerAt }
  };
}

function planPwmTargetStep(schedule, targetAction, observations, now, durations) {
  if (targetAction === 'on') {
    return planPwmOnTargetStep(schedule, observations, now, durations);
  }

  if (observations?.acIsOn === false || observations?.proofFresh === true) {
    return pwmPhaseCommitPlan(
      observations?.acIsOn === false ? 'ac-already-off' : 'off-proof-fresh',
      'on',
      now + durations.offMinutes * PWM_PHASE_MINUTE_MS,
      now,
      'clear'
    );
  }

  if (observations?.shortTimerAttempted !== true) {
    return {
      kind: 'hold',
      reason: 'short-page-timer-required',
      nextAction: 'off',
      prerequisite: 'set-short-page-timer',
      timerMinutes: PWM_PHASE_RETRY_MINUTES,
      phasePatch: { pwmState: 'off', nextTriggerAt: 0 }
    };
  }

  return pwmPhaseRetryPlan('off-proof-retry', 'off', now);
}

// 提取（Fowler Extract Function）：ON 相位目标步决策——开机确认链 → 页面定时器链 → 提交 OFF。
function planPwmOnTargetStep(schedule, observations, now, durations) {
  const onConfirmed = observations?.acIsOn === true
    || observations?.toggleSucceeded === true;
  if (!onConfirmed) {
    if (observations?.toggleSucceeded === false) {
      return pwmPhaseRetryPlan('toggle-on-failed', 'on', now, 'clear');
    }
    return {
      kind: 'hold',
      reason: 'toggle-on-required',
      nextAction: 'on',
      proofAction: 'clear',
      prerequisite: 'toggle-on',
      phasePatch: { pwmState: 'on', nextTriggerAt: 0 }
    };
  }

  if (typeof observations?.pageTimerSucceeded !== 'boolean') {
    return {
      kind: 'hold',
      reason: 'page-timer-required',
      nextAction: 'on',
      proofAction: 'clear',
      prerequisite: 'set-page-timer',
      timerMinutes: durations.onMinutes,
      phasePatch: { pwmState: 'on', nextTriggerAt: 0 }
    };
  }

  if (!observations.pageTimerSucceeded) {
    return pwmPhaseRetryPlan('page-timer-failed', 'on', now, 'clear');
  }

  return pwmPhaseCommitPlan(
    'on-phase-committed',
    'off',
    now + durations.onMinutes * PWM_PHASE_MINUTE_MS,
    now
  );
}

function planPwmStep(schedule, observations = {}, opts = {}) {
  const now = pwmPhaseNow(opts);
  if (!schedule?.enabled) return { kind: 'noop', reason: 'disabled' };

  const durations = pwmPhaseDurations(schedule);
  if (!durations) return { kind: 'refuse', reason: 'invalid-duration' };

  const targetAction = pwmPhaseTargetAction(schedule);
  if (!targetAction) return { kind: 'refuse', reason: 'invalid-state' };

  return planPwmTargetStep(
    schedule,
    targetAction,
    observations,
    now,
    durations
  );
}

function planPwmRecovery(schedule, expiredScheduledTime, observations = {}, opts = {}) {
  const now = pwmPhaseNow(opts);
  if (!schedule?.enabled) return { kind: 'noop', reason: 'disabled' };

  const durations = pwmPhaseDurations(schedule);
  if (!durations) return { kind: 'refuse', reason: 'invalid-duration' };

  const expiredBoundary = Number(expiredScheduledTime);
  if (!Number.isFinite(expiredBoundary) || expiredBoundary <= 0) {
    return { kind: 'refuse', reason: 'invalid-expired-trigger' };
  }
  if (expiredBoundary >= now) {
    return { kind: 'refuse', reason: 'trigger-not-expired' };
  }

  let nextAction = pwmPhaseTargetAction(schedule);
  if (!nextAction) return { kind: 'refuse', reason: 'invalid-state' };

  const advancedBoundary = advanceExpiredBoundary(nextAction, expiredBoundary, now, durations);
  if (!advancedBoundary) return { kind: 'refuse', reason: 'invalid-duration' };
  nextAction = advancedBoundary.nextAction;
  const nextTriggerAt = advancedBoundary.nextTriggerAt;

  if (nextAction === 'on') {
    return pwmPhaseCommitPlan(
      'advanced-to-future-boundary',
      'on',
      nextTriggerAt,
      now
    );
  }

  if (observations.acIsOn === false) {
    return pwmPhaseCommitPlan(
      'ac-already-off',
      'on',
      nextTriggerAt,
      now,
      'clear'
    );
  }

  const delayMinutes = Math.max(1, (nextTriggerAt - now) / PWM_PHASE_MINUTE_MS);
  if (typeof observations.pageTimerSucceeded !== 'boolean') {
    return {
      kind: 'hold',
      reason: 'page-timer-required',
      nextAction: 'off',
      nextTriggerAt,
      delayMinutes,
      prerequisite: 'set-page-timer',
      timerMinutes: Math.ceil(delayMinutes),
      phasePatch: { pwmState: 'on' }
    };
  }

  if (!observations.pageTimerSucceeded) {
    return pwmPhaseRetryPlan('page-timer-failed', 'off', now);
  }

  const pageTimerTargetAt = Number(observations.pageTimerTargetAt);
  const alignedTriggerAt = Number.isFinite(pageTimerTargetAt) && pageTimerTargetAt > now
    ? pageTimerTargetAt
    : nextTriggerAt;

  return pwmPhaseCommitPlan(
    'page-timer-confirmed',
    'off',
    alignedTriggerAt,
    now
  );
}

// 提取（Fowler Extract Function）：从过期边界推进到下一个未来周期边界（跳过整周期、逐相位翻转与时长安全阀）。
function advanceExpiredBoundary(nextAction, expiredBoundary, now, durations) {
  const cycleMs = (durations.onMinutes + durations.offMinutes) * PWM_PHASE_MINUTE_MS;
  let nextTriggerAt = expiredBoundary;
  const fullCycles = Math.floor((now - nextTriggerAt) / cycleMs);
  if (fullCycles > 0) nextTriggerAt += fullCycles * cycleMs;

  while (nextTriggerAt <= now) {
    const durationMinutes = nextAction === 'on'
      ? durations.onMinutes
      : durations.offMinutes;
    const advancedTrigger = nextTriggerAt + durationMinutes * PWM_PHASE_MINUTE_MS;
    if (!Number.isFinite(advancedTrigger) || advancedTrigger <= nextTriggerAt) {
      return null;
    }
    nextTriggerAt = advancedTrigger;
    nextAction = nextAction === 'on' ? 'off' : 'on';
  }
  return { nextAction, nextTriggerAt };
}

function reconcilePwmTrigger(schedule, liveAlarm, opts = {}) {
  const now = pwmPhaseNow(opts);
  if (!schedule?.enabled && opts?.allowDisabled !== true) {
    return { kind: 'noop', reason: 'disabled' };
  }

  const liveScheduledTime = Number(liveAlarm?.scheduledTime);
  if (!Number.isFinite(liveScheduledTime) || liveScheduledTime <= now) {
    return { kind: 'noop', reason: 'no-future-live-alarm' };
  }

  const nextTriggerToleranceMs = pwmPhaseTolerance(
    opts?.nextTriggerToleranceMs,
    1500
  );
  const legacyTriggerToleranceMs = pwmPhaseTolerance(
    opts?.legacyTriggerToleranceMs,
    1500
  );
  const requireLegacyAlignment = opts?.requireLegacyAlignment !== false;
  const nextTriggerAt = Number(schedule?.nextTriggerAt);
  const alarmCreatedAt = Number(schedule?.alarmCreatedAt);
  const alarmDelayMinutes = Number(schedule?.alarmDelayMinutes);
  const legacyTriggerAt = alarmCreatedAt + alarmDelayMinutes * PWM_PHASE_MINUTE_MS;
  const nextAligned = Number.isFinite(nextTriggerAt)
    && Math.abs(nextTriggerAt - liveScheduledTime) <= nextTriggerToleranceMs;
  const legacyAligned = alarmCreatedAt > 0
    && alarmDelayMinutes > 0
    && Number.isFinite(legacyTriggerAt)
    && Math.abs(legacyTriggerAt - liveScheduledTime) <= legacyTriggerToleranceMs;

  if (nextAligned && (!requireLegacyAlignment || legacyAligned)) {
    return { kind: 'noop', reason: 'already-aligned' };
  }

  return {
    kind: 'sync-live',
    reason: 'live-alarm-drift',
    liveScheduledTime,
    phasePatch: {
      nextTriggerAt: liveScheduledTime,
      alarmCreatedAt: now,
      alarmDelayMinutes: Math.max(
        1,
        (liveScheduledTime - now) / PWM_PHASE_MINUTE_MS
      )
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    planPwmStep,
    planPwmRecovery,
    reconcilePwmTrigger
  };
}