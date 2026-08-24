const PWM_PHASE_MINUTE_MS = 60_000;
const PWM_PHASE_RETRY_MINUTES = 1;
const SMART_MODE_ON_HARD_MAX_MINUTES = 25;

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

function pwmPhasePageTimerTarget(observations, fallbackTargetAt, now) {
  const pageTimerTargetAt = Number(observations?.pageTimerTargetAt);
  return Number.isFinite(pageTimerTargetAt) && pageTimerTargetAt > now
    ? pageTimerTargetAt
    : fallbackTargetAt;
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

  const nextTriggerAt = pwmPhasePageTimerTarget(
    observations,
    now + durations.onMinutes * PWM_PHASE_MINUTE_MS,
    now
  );
  return pwmPhaseCommitPlan(
    'on-phase-committed',
    'off',
    nextTriggerAt,
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

  const alignedTriggerAt = pwmPhasePageTimerTarget(
    observations,
    nextTriggerAt,
    now
  );

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

  const { nextAligned, legacyAligned, requireLegacyAlignment } = computeTriggerAlignment(
    schedule,
    liveScheduledTime,
    opts
  );

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

// 提取（Fowler Extract Function）：三方对齐判定——nextTriggerAt 与 legacy 推算值分别在容差内对齐 live 时间。
function computeTriggerAlignment(schedule, liveScheduledTime, opts) {
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

  return { nextAligned, legacyAligned, requireLegacyAlignment };
}

// 整点边界：返回下一个整点（HH:00:00.000）的绝对毫秒时间。
// 用于天气闹钟 ac-smart-weather（天文台 rhrread 数据每小时整点更新），与智能模式周期长度无关。
function nextHourBoundary(now = Date.now()) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

// 智能模式半点对齐：返回下一个半点（HH:00 或 HH:30:00.000）的绝对毫秒时间。
// 30 分钟控制周期下，ON 相位锚定到半点边界。
function nextHalfHourBoundary(now = Date.now()) {
  const d = new Date(now);
  if (d.getMinutes() < 30) {
    d.setMinutes(30, 0, 0);
  } else {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
  }
  return d.getTime();
}

function halfHourBoundaryAtOrBefore(now = Date.now()) {
  const d = new Date(now);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return d.getTime();
}

function isHalfHourBoundary(timestamp) {
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value)) return false;
  const d = new Date(value);
  return (d.getMinutes() === 0 || d.getMinutes() === 30)
    && d.getSeconds() === 0
    && d.getMilliseconds() === 0;
}

function nextHalfHourBoundaryAtOrAfter(timestamp) {
  return isHalfHourBoundary(timestamp)
    ? Number(timestamp)
    : nextHalfHourBoundary(timestamp);
}

function smartModePageTimerTargetAt(
  onMinutes,
  now = Date.now(),
  boundaryAt = halfHourBoundaryAtOrBefore(now)
) {
  const duration = Number(onMinutes);
  if (!Number.isInteger(duration) || duration <= 0
      || duration > SMART_MODE_ON_HARD_MAX_MINUTES
      || !isHalfHourBoundary(boundaryAt)) {
    return 0;
  }
  return Number(boundaryAt) + duration * PWM_PHASE_MINUTE_MS;
}

// 智能控制自动 ON 门禁：只允许在 HH:00/HH:30 这一分钟内启动，并把关机
// 截止时间固定为“半点边界 + onMinutes”，避免浏览器迟唤醒与 UST 分钟上取整
// 把 5 分钟关闭窗口压短。循环定时不调用此函数，保持任意分钟切换。
function planSmartModeOnWindow(schedule, opts = {}) {
  const now = pwmPhaseNow(opts);
  const onMinutes = Number(schedule?.onMinutes);
  const requestedMaxOnMinutes = opts?.maxOnMinutes === undefined
    ? SMART_MODE_ON_HARD_MAX_MINUTES
    : Number(opts.maxOnMinutes);
  const maxOnMinutes = Math.min(
    requestedMaxOnMinutes,
    SMART_MODE_ON_HARD_MAX_MINUTES
  );
  if (!Number.isInteger(onMinutes) || onMinutes <= 0
      || !Number.isFinite(maxOnMinutes) || maxOnMinutes <= 0
      || onMinutes > maxOnMinutes) {
    return { kind: 'refuse', reason: 'invalid-smart-on-duration' };
  }

  const acIsOn = opts?.acIsOn === true;
  const storedBoundaryAt = Number(opts?.boundaryAt);
  const hasActiveBoundary = acIsOn
    && isHalfHourBoundary(storedBoundaryAt)
    && storedBoundaryAt <= now;
  const boundaryAt = hasActiveBoundary
    ? storedBoundaryAt
    : halfHourBoundaryAtOrBefore(now);
  const pageTimerTargetAt = smartModePageTimerTargetAt(onMinutes, now, boundaryAt);
  if (acIsOn) {
    if (!hasActiveBoundary) {
      return {
        kind: 'allow',
        reason: 'smart-on-overrun-shutdown',
        boundaryAt: 0,
        pageTimerTargetAt: Math.floor(now / PWM_PHASE_MINUTE_MS + 1)
          * PWM_PHASE_MINUTE_MS
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
      pageTimerTargetAt: Math.floor(now / PWM_PHASE_MINUTE_MS + 1)
        * PWM_PHASE_MINUTE_MS
    };
  }

  if (now - boundaryAt < PWM_PHASE_MINUTE_MS && pageTimerTargetAt > now) {
    return {
      kind: 'allow',
      reason: 'smart-on-window',
      boundaryAt,
      windowEndsAt: boundaryAt + PWM_PHASE_MINUTE_MS,
      pageTimerTargetAt
    };
  }

  const nextTriggerAt = nextHalfHourBoundary(now);
  return {
    kind: 'defer',
    reason: 'wait-for-smart-on-window',
    nextAction: 'on',
    nextTriggerAt,
    delayMinutes: Math.max(1, (nextTriggerAt - now) / PWM_PHASE_MINUTE_MS),
    phasePatch: { pwmState: 'on', nextTriggerAt }
  };
}

// 智能模式：把 OFF 提交的下一 ON 触发锚定到半点，使 30 分钟周期与半点对齐。
// ON 提交（nextAction='off'）保持 now + onMinutes 不变——因 ON 相位已在半点开始，
// 其结束时刻（半点 + onMinutes）天然落在半点节奏上。
function alignSmartModeNextTrigger(plan, now = Date.now(), options = {}) {
  if (!plan || plan.nextAction !== 'on') return;
  const currentTriggerAt = Number(plan.nextTriggerAt);
  if (!Number.isFinite(currentTriggerAt) || currentTriggerAt <= now) return;
  const requestedNotBeforeAt = Number(options?.notBeforeAt);
  const notBeforeAt = Number.isFinite(requestedNotBeforeAt)
    ? Math.max(now + 1, requestedNotBeforeAt)
    : now + 1;
  if (isHalfHourBoundary(currentTriggerAt) && currentTriggerAt >= notBeforeAt) return;
  const nextBoundary = nextHalfHourBoundaryAtOrAfter(notBeforeAt);
  if (nextBoundary <= now) return;
  plan.nextTriggerAt = nextBoundary;
  if (typeof plan.delayMinutes === 'number') {
    plan.delayMinutes = Math.max(1, (nextBoundary - now) / PWM_PHASE_MINUTE_MS);
  }
  if (plan.phasePatch) {
    plan.phasePatch.nextTriggerAt = nextBoundary;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    planPwmStep,
    planPwmRecovery,
    reconcilePwmTrigger,
    nextHourBoundary,
    nextHalfHourBoundary,
    smartModePageTimerTargetAt,
    planSmartModeOnWindow,
    alignSmartModeNextTrigger
  };
}