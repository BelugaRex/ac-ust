const getPwmRetryDescriptorForPhase = typeof module !== 'undefined' && module.exports
  ? require('./pwm-retry.js').getPwmRetryDescriptor
  : globalThis.getPwmRetryDescriptor;

const PWM_PHASE_MINUTE_MS = 60_000;
const PWM_PHASE_RETRY_MINUTES = 1;
const SMART_MODE_ON_HARD_MAX_MINUTES = 25;
const PWM_ALARM_BOUNDARY_TOLERANCE_MS = 1500;

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

// 智能天气预取槽只接受精确 :20/:50，并分别绑定下一 :30/:00 控制边界。
function smartWeatherTargetBoundaryAt(prefetchAt) {
  const value = Number(prefetchAt);
  if (!Number.isSafeInteger(value)) return 0;
  const d = new Date(value);
  if (d.getSeconds() !== 0 || d.getMilliseconds() !== 0) return 0;
  if (d.getMinutes() === 20) {
    d.setMinutes(30, 0, 0);
    return d.getTime();
  }
  if (d.getMinutes() === 50) {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  return 0;
}

// 返回严格晚于 now 的下一次 :20/:50 一次性预取计划。
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

// chrome.alarms 的 scheduledTime 可能与请求的整半点有极小漂移。这里只把距离
// 最近 :00/:30 不超过 1500ms 的值归一化；更远的普通调用仍不能冒充可信半点。
function normalizeHalfHourAlarmBoundary(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const lowerBoundary = halfHourBoundaryAtOrBefore(value);
  const upperBoundary = nextHalfHourBoundary(value);
  const lowerDistance = Math.abs(value - lowerBoundary);
  const upperDistance = Math.abs(upperBoundary - value);
  const boundaryAt = lowerDistance <= upperDistance
    ? lowerBoundary
    : upperBoundary;
  return Math.abs(value - boundaryAt) <= PWM_ALARM_BOUNDARY_TOLERANCE_MS
    ? boundaryAt
    : 0;
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

// UST 的 HH:MM 控件会把不足一分钟的目标上取整。直接请求“下一分钟”时，若当前
// 已过整分，02:11:01 → 02:12 只剩 59 秒，页面会持久化为 02:13。这里先生成
// 至少完整一分钟后的整分目标，使写入值与新鲜页读回值一致。
function nextSafePageTimerTargetAt(now = Date.now()) {
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return 0;
  return Math.ceil((nowMs + PWM_PHASE_MINUTE_MS) / PWM_PHASE_MINUTE_MS)
    * PWM_PHASE_MINUTE_MS;
}

// 智能控制自动 ON 门禁：普通调用只允许在 HH:00/HH:30 这一分钟内启动；
// 真正的半点 ac-pwm alarm，或明确的生命周期恢复路径，可补执行当前剩余 ON
// 相位。三者都把关机截止固定为“半点边界 + onMinutes”，不把延迟补到周期末尾。
// 循环定时不调用。
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
  const recoverCurrentCycle = opts?.recoverCurrentCycle === true;
  const storedBoundaryAt = Number(opts?.boundaryAt);
  const triggeredBoundaryAt = normalizeHalfHourAlarmBoundary(
    opts?.triggeredBoundaryAt
  );
  const triggeredPageTimerTargetAt = smartModePageTimerTargetAt(
    onMinutes,
    now,
    triggeredBoundaryAt
  );
  const hasTriggeredBoundary = isHalfHourBoundary(triggeredBoundaryAt)
    && triggeredBoundaryAt <= now
    && triggeredPageTimerTargetAt >= nextSafePageTimerTargetAt(now);
  const hasActiveBoundary = acIsOn
    && isHalfHourBoundary(storedBoundaryAt)
    && storedBoundaryAt <= now;
  const useTriggeredBoundary = hasTriggeredBoundary
    && (!hasActiveBoundary || triggeredBoundaryAt > storedBoundaryAt);
  const boundaryAt = useTriggeredBoundary
    ? triggeredBoundaryAt
    : hasActiveBoundary
      ? storedBoundaryAt
      : halfHourBoundaryAtOrBefore(now);
  const pageTimerTargetAt = smartModePageTimerTargetAt(onMinutes, now, boundaryAt);
  if (acIsOn) {
    if (!hasActiveBoundary && !hasTriggeredBoundary) {
      return {
        kind: 'allow',
        reason: 'smart-on-overrun-shutdown',
        boundaryAt: 0,
        pageTimerTargetAt: nextSafePageTimerTargetAt(now)
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
      pageTimerTargetAt: nextSafePageTimerTargetAt(now)
    };
  }

  // 只有真正的 ac-pwm 半点 alarm（或启动期从其绝对 storage 时刻补执行）可以
  // 越过首分钟继续当前 ON 相位；截止仍锁在原半点 + onMinutes，不把延迟补到末尾。
  if (hasTriggeredBoundary) {
    return {
      kind: 'allow',
      reason: 'smart-on-scheduled-boundary',
      boundaryAt,
      windowEndsAt: pageTimerTargetAt,
      pageTimerTargetAt
    };
  }

  if (recoverCurrentCycle
      && pageTimerTargetAt >= nextSafePageTimerTargetAt(now)) {
    return {
      kind: 'allow',
      reason: 'smart-on-current-cycle-recovery',
      boundaryAt,
      windowEndsAt: pageTimerTargetAt,
      pageTimerTargetAt
    };
  }

  if (now - boundaryAt < PWM_PHASE_MINUTE_MS
      && pageTimerTargetAt >= nextSafePageTimerTargetAt(now)) {
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

// typed smart-on retry 自身异常时仍须保持原半点事务：只有下一次一分钟重试
// 到达时还留有完整页面定时器安全余量才续试，否则明确延至下一半点。
function planSmartOnRetryExceptionRecovery(schedule, boundaryAt, opts = {}) {
  const now = pwmPhaseNow(opts);
  const requestedRetryAt = Number.isFinite(opts?.retryAt)
    ? Number(opts.retryAt)
    : now + PWM_PHASE_MINUTE_MS;
  const onMinutes = Number(schedule?.onMinutes);
  const normalizedBoundaryAt = normalizeHalfHourAlarmBoundary(boundaryAt);
  const targetAt = normalizedBoundaryAt + onMinutes * PWM_PHASE_MINUTE_MS;
  const canRetry = Number.isInteger(onMinutes)
    && onMinutes > 0
    && onMinutes <= SMART_MODE_ON_HARD_MAX_MINUTES
    && isHalfHourBoundary(normalizedBoundaryAt)
    && normalizedBoundaryAt > 0
    && requestedRetryAt > now
    && targetAt >= nextSafePageTimerTargetAt(requestedRetryAt);
  if (canRetry) {
    return {
      kind: 'retry-smart-on-exception',
      reason: 'smart-on-retry-exception-safe',
      nextAction: 'on',
      nextTriggerAt: requestedRetryAt,
      boundaryAt: normalizedBoundaryAt,
      pageTimerTargetAt: targetAt,
      phasePatch: { pwmState: 'on', nextTriggerAt: requestedRetryAt }
    };
  }

  const nextTriggerAt = nextHalfHourBoundary(now);
  return {
    kind: 'defer',
    reason: 'smart-on-retry-exception-unsafe',
    nextAction: 'on',
    nextTriggerAt,
    delayMinutes: Math.max(1, (nextTriggerAt - now) / PWM_PHASE_MINUTE_MS),
    phasePatch: { pwmState: 'on', nextTriggerAt }
  };
}

// 已确认物理 OFF 后规划下一次智能 ON。普通路径仍取最近未来半点；若恢复链
// 的实际关机太晚，五分钟压缩机保护跨过该半点，则以该半点拥有的 typed retry
// 在最早安全时刻补执行剩余 ON 窗口。窗口余量不足时才显式跳到后一个半点。
function planSmartOnAfterConfirmedOff(schedule, opts = {}) {
  const now = pwmPhaseNow(opts);
  const confirmedOffAt = Number(opts?.confirmedOffAt);
  const minOffMinutes = Number(opts?.minOffMinutes);
  const storedOnMinutes = Number(schedule?.onMinutes);
  const noRunSentinel = storedOnMinutes === 30
    && Number(schedule?.offMinutes) === 30;
  const onMinutes = noRunSentinel ? 0 : storedOnMinutes;
  const validOnDuration = Number.isInteger(onMinutes)
    && onMinutes >= 0
    && onMinutes <= SMART_MODE_ON_HARD_MAX_MINUTES;
  if (!schedule?.enabled
      || schedule?.smartMode?.enabled !== true
      || !Number.isFinite(confirmedOffAt)
      || confirmedOffAt <= 0
      || confirmedOffAt > now
      || !Number.isFinite(minOffMinutes)
      || minOffMinutes <= 0) {
    return { kind: 'refuse', reason: 'invalid-smart-off-confirmation' };
  }

  const requestedBoundaryAt = normalizeHalfHourAlarmBoundary(opts?.boundaryAt);
  const boundaryAt = requestedBoundaryAt > 0
    ? requestedBoundaryAt
    : nextHalfHourBoundary(now);
  const nearestBoundaryAt = nextHalfHourBoundary(now);
  const notBeforeAt = confirmedOffAt + minOffMinutes * PWM_PHASE_MINUTE_MS;
  const planBoundaryEvaluation = (nextTriggerAt, reason) => {
    const markerBoundaryAt = halfHourBoundaryAtOrBefore(nextTriggerAt - 1);
    return {
      kind: 'smart-on-safety-skip',
      reason,
      nextAction: 'on',
      nextTriggerAt,
      boundaryAt: markerBoundaryAt,
      skippedBoundaryAt: boundaryAt,
      pageTimerTargetAt: onMinutes > 0
        ? smartModePageTimerTargetAt(onMinutes, now, nextTriggerAt)
        : 0,
      delayMinutes: Math.max(1, (nextTriggerAt - now) / PWM_PHASE_MINUTE_MS),
      phasePatch: { pwmState: 'on', nextTriggerAt }
    };
  };
  if (!validOnDuration) {
    return planBoundaryEvaluation(
      nextHalfHourBoundaryAtOrAfter(notBeforeAt),
      'smart-invalid-duration-next-evaluation'
    );
  }
  if (onMinutes === 0) {
    return planBoundaryEvaluation(
      nextHalfHourBoundaryAtOrAfter(notBeforeAt),
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
        pageTimerTargetAt: smartModePageTimerTargetAt(
          onMinutes,
          now,
          boundaryAt
        ),
        delayMinutes: Math.max(1, (boundaryAt - now) / PWM_PHASE_MINUTE_MS),
        phasePatch: { pwmState: 'on', nextTriggerAt: boundaryAt }
      };
    }
    return planBoundaryEvaluation(
      boundaryAt,
      'compressor-safe-requested-later-boundary'
    );
  }

  const retryPlan = onMinutes > 0
    ? planSmartOnRetryExceptionRecovery(
        schedule,
        boundaryAt,
        { now, retryAt: notBeforeAt }
      )
    : { kind: 'defer', reason: 'smart-on-duration-zero' };
  if (retryPlan.kind === 'retry-smart-on-exception') {
    return {
      ...retryPlan,
      kind: 'smart-on-safe-delay',
      reason: 'compressor-min-off-safe-delay',
      delayMinutes: Math.max(1, (retryPlan.nextTriggerAt - now) / PWM_PHASE_MINUTE_MS)
    };
  }

  const nextTriggerAt = nextHalfHourBoundaryAtOrAfter(notBeforeAt);
  return planBoundaryEvaluation(
    nextTriggerAt,
    'compressor-min-off-window-exhausted'
  );
}

// 对智能下一 ON 时钟做语义校验。三方一致只证明同一个时戳被复制，不能证明
// 它属于“现在应到的最近半点”。唯一例外是 marker、alarm 与剩余 ON 截止都
// 匹配的本机 typed retry。
function classifySmartOnClock(schedule, candidateAt, opts = {}) {
  const now = pwmPhaseNow(opts);
  const candidate = Number(candidateAt);
  const nextAction = opts?.nextAction === 'on' || opts?.nextAction === 'off'
    ? opts.nextAction
    : schedule?.pwmState;
  const toleranceMs = pwmPhaseTolerance(
    Number(opts?.toleranceMs),
    PWM_ALARM_BOUNDARY_TOLERANCE_MS
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

  // expectedAt 必须锚定在 durable 计划生成时刻，而不是每次诊断的当前时刻。
  // 否则 18:56 错排的 19:30 到 19:03 会突然变成“最近半点”并假绿。
  const requestedPlannedAt = Number(opts?.plannedAt);
  const hasDurablePlannedAt = Number.isFinite(requestedPlannedAt)
      && requestedPlannedAt > 0
      && requestedPlannedAt <= now + toleranceMs;
  const plannedAt = hasDurablePlannedAt
    ? requestedPlannedAt
    : now;
  const plannedLowerBoundaryAt = halfHourBoundaryAtOrBefore(plannedAt);
  const candidateBoundaryAt = normalizeHalfHourAlarmBoundary(candidate);
  const plannedBoundaryAt = normalizeHalfHourAlarmBoundary(plannedAt);
  // 兼容旧版在 alarm 已到点后才记录 origin 的快照：只有 candidate 本身就是
  // 该到期半点时，才允许把“边界后 1.5s 内”的 origin 解释为当前边界。
  // 若 candidate 是下一半点（例如 19:30:00.017 确认 OFF 后计划 20:00），
  // origin 靠近 19:30 绝不能反过来把合法 20:00 判成跳周期。
  const candidateOwnsPlannedBoundary = hasDurablePlannedAt
    && plannedBoundaryAt > 0
    && candidateBoundaryAt === plannedBoundaryAt;
  const expectedAt = hasDurablePlannedAt
    ? (candidateOwnsPlannedBoundary
      ? plannedBoundaryAt
      : nextHalfHourBoundary(plannedAt))
    : (plannedAt - plannedLowerBoundaryAt <= toleranceMs
      ? plannedLowerBoundaryAt
      : nextHalfHourBoundary(plannedAt));

  const retryKind = String(schedule?.pwmRetryKind || '');
  const retryDescriptor = getPwmRetryDescriptorForPhase(retryKind);
  const retryBoundaryAt = Number(schedule?.pwmRetryBoundaryAt);
  const retryScheduledAt = Number(schedule?.pwmRetryScheduledAt);
  const retryTargetAt = smartModePageTimerTargetAt(
    onMinutes,
    Math.max(now, candidate),
    retryBoundaryAt
  );
  const validTypedRetry = retryDescriptor?.ownsTypedSmartOn === true
    && schedule?.pwmState === 'on'
    && isHalfHourBoundary(retryBoundaryAt)
    && Number.isFinite(retryScheduledAt)
    && Math.abs(candidate - retryScheduledAt) <= toleranceMs
    && candidate >= retryBoundaryAt
    && retryTargetAt >= nextSafePageTimerTargetAt(Math.max(now, candidate));
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

  // 页面 timer 写入失败后的安全重试只会重新观察实际状态并修复关机保险；
  // 它不拥有普通半点 ON 权限，boundary 可为 0。tuple 必须精确绑定 durable
  // scheduledAt，alarm 到期时由 repair 路径处理，绝不能落入普通 toggle。
  const validSafetyTimerRetry = retryDescriptor?.repairsSafetyTimer === true
    && schedule?.pwmState === 'on'
    && (retryBoundaryAt === 0 || isHalfHourBoundary(retryBoundaryAt))
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

  // 若五分钟压缩机保护已经吃完原半点的剩余 ON 窗口，允许一个显式
  // safety-skip marker 把下一次评估交给后一个半点。它不是 typed ON retry，
  // 到时必须走普通半点天气与 ON 门禁。
  const validSafetySkip = retryDescriptor?.reevaluatesAtNextBoundary === true
    && schedule?.pwmState === 'on'
    && isHalfHourBoundary(retryBoundaryAt)
    && Number.isFinite(retryScheduledAt)
    && Math.abs(candidate - retryScheduledAt) <= toleranceMs
    && Math.abs(candidate - nextHalfHourBoundary(retryBoundaryAt)) <= toleranceMs;
  const safetySkipBoundaryAt = normalizeHalfHourAlarmBoundary(candidate);
  const safetySkipTargetAt = smartModePageTimerTargetAt(
    onMinutes,
    Math.max(now, candidate),
    safetySkipBoundaryAt
  );
  const safetySkipDueSafe = onMinutes === 0
    ? now - candidate < PWM_PHASE_MINUTE_MS
    : safetySkipTargetAt >= nextSafePageTimerTargetAt(now);
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

  // Durable marker 是排他性的执行身份，而不是普通半点的可选提示。只要
  // storage 声称存在 smart ON exception，但 tuple / cutoff / live ownership
  // 任一不匹配，就必须判红；绝不能降级为 nearest-boundary 后假绿。
  const hasSmartOnMarker = retryDescriptor !== null;
  if (hasSmartOnMarker) {
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
  const expectedPageTimerTargetAt = smartModePageTimerTargetAt(
    onMinutes,
    Math.max(now, candidate),
    expectedAt
  );
  const expectedDueSafe = onMinutes === 0
    ? now - candidate < PWM_PHASE_MINUTE_MS
    : expectedPageTimerTargetAt >= nextSafePageTimerTargetAt(now);
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
      pageTimerTargetAt: smartModePageTimerTargetAt(
        onMinutes,
        candidate,
        expectedAt
      )
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
    planNextSmartWeatherPrefetch,
    smartWeatherTargetBoundaryAt,
    nextHalfHourBoundary,
    halfHourBoundaryAtOrBefore,
    smartModePageTimerTargetAt,
    nextSafePageTimerTargetAt,
    planSmartModeOnWindow,
    planSmartOnRetryExceptionRecovery,
    planSmartOnAfterConfirmedOff,
    classifySmartOnClock,
    alignSmartModeNextTrigger
  };
}
