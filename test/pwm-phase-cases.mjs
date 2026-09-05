import pwmPhase from '../pwm-phase.js';
import smartPhase from '../smart-phase.js';

const MINUTE_MS = 60_000;
const {
  planPwmStep,
  planPwmRecovery,
  reconcilePwmTrigger
} = pwmPhase;
const {
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
} = smartPhase;

export function runPwmPhaseCases(assertPass) {
  const now = 1_700_000_000_000;
  const plans = [];
  const keep = plan => (plans.push(plan), plan);
  const base = {
    enabled: true,
    pwmState: 'on',
    onMinutes: 10,
    offMinutes: 20,
    nextTriggerAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0
  };

  assertPass(
    Object.keys(pwmPhase).sort().join(',')
      === 'planPwmRecovery,planPwmStep,reconcilePwmTrigger'
      && typeof smartPhase.planSmartStep === 'function'
      && typeof smartPhase.planSmartModeOnWindow === 'function'
      && typeof nextSafePageTimerTargetAt === 'function'
      && typeof halfHourBoundaryAtOrBefore === 'function',
    'PWM phase 只导出 PWM 规划函数，Smart phase 独立导出智能策略'
  );

  // 智能天气在 :20/:50 预取并绑定下一 :30/:00 控制边界；调度始终严格晚于 now。
  const hourTime = (h, m, s = 0, ms = 0) => new Date(2026, 7, 17, h, m, s, ms).getTime();
  const smartSchedule = onMinutes => ({
    enabled: true,
    smartMode: { enabled: true },
    smartState: 'on',
    onMinutes
  });
  const prefetchCases = [
    [hourTime(14, 19, 59, 999), hourTime(14, 20), hourTime(14, 30)],
    [hourTime(14, 20), hourTime(14, 50), hourTime(15, 0)],
    [hourTime(14, 49, 59, 999), hourTime(14, 50), hourTime(15, 0)],
    [hourTime(14, 50), hourTime(15, 20), hourTime(15, 30)],
    [hourTime(23, 50), hourTime(24, 20), hourTime(24, 30)]
  ];
  assertPass(prefetchCases.every(([input, prefetchAt, boundaryAt]) => {
    const plan = planNextSmartWeatherPrefetch(input);
    return plan.prefetchAt === prefetchAt && plan.boundaryAt === boundaryAt;
  }), 'planNextSmartWeatherPrefetch: :20/:50 严格未来交替并正确跨小时/跨日');
  assertPass(smartWeatherTargetBoundaryAt(hourTime(14, 20)) === hourTime(14, 30)
      && smartWeatherTargetBoundaryAt(hourTime(14, 50)) === hourTime(15, 0)
      && smartWeatherTargetBoundaryAt(hourTime(14, 20, 0, 1)) === 0
      && smartWeatherTargetBoundaryAt(hourTime(14, 10)) === 0
      && smartWeatherTargetBoundaryAt(hourTime(14, 30)) === 0,
    'smartWeatherTargetBoundaryAt: 仅接受精确 :20/:50 槽并映射到 :30/:00');

  // 智能模式半点对齐：nextHalfHourBoundary 驱动 30 分钟控制周期。
  assertPass(nextHalfHourBoundary(hourTime(13, 10)) === hourTime(13, 30),
    'nextHalfHourBoundary: 13:10 → 13:30');
  assertPass(nextHalfHourBoundary(hourTime(13, 45)) === hourTime(14, 0),
    'nextHalfHourBoundary: 13:45 → 14:00');
  assertPass(nextHalfHourBoundary(hourTime(13, 30)) === hourTime(14, 0),
    'nextHalfHourBoundary: 半点也进到下一个半点');

  const safeRetryException = planSmartOnRetryExceptionRecovery(
    smartSchedule(21),
    hourTime(13, 30),
    { now: hourTime(13, 31), retryAt: hourTime(13, 32) }
  );
  const unsafeRetryException = planSmartOnRetryExceptionRecovery(
    smartSchedule(21),
    hourTime(13, 30),
    { now: hourTime(13, 49, 30), retryAt: hourTime(13, 50, 30) }
  );
  assertPass(safeRetryException.kind === 'retry-smart-on-exception'
      && safeRetryException.nextTriggerAt === hourTime(13, 32)
      && safeRetryException.pageTimerTargetAt === hourTime(13, 51)
      && unsafeRetryException.kind === 'defer'
      && unsafeRetryException.nextTriggerAt === hourTime(14, 0),
    'planSmartOnRetryExceptionRecovery: 异常只续一分钟且保留原截止；余量不足明确延至下一半点');

  const smartBeforeWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(13, 29, 59, 999), maxOnMinutes: 25 }
  );
  const smartAtWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(13, 30), maxOnMinutes: 25 }
  );
  const smartLateInWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(13, 30, 59, 999), maxOnMinutes: 25 }
  );
  const smartAfterWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(13, 31), maxOnMinutes: 25 }
  );
  const smartAtHourWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(14, 0), maxOnMinutes: 25 }
  );
  const smartLateHourWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(14, 0, 59, 999), maxOnMinutes: 25 }
  );
  const smartAfterHourWindow = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(14, 1), maxOnMinutes: 25 }
  );
  assertPass(smartBeforeWindow.kind === 'defer'
      && smartBeforeWindow.nextTriggerAt === hourTime(13, 30)
      && smartBeforeWindow.phasePatch.smartState === 'on'
      && smartAtWindow.kind === 'allow'
      && smartAtWindow.boundaryAt === hourTime(13, 30)
      && smartAtWindow.windowEndsAt === hourTime(13, 31)
      && smartAtWindow.pageTimerTargetAt === hourTime(13, 55)
      && smartLateInWindow.kind === 'allow'
      && smartLateInWindow.windowEndsAt === hourTime(13, 31)
      && smartLateInWindow.pageTimerTargetAt === hourTime(13, 55)
      && smartAfterWindow.kind === 'defer'
      && smartAfterWindow.nextTriggerAt === hourTime(14, 0)
      && smartAtHourWindow.kind === 'allow'
      && smartAtHourWindow.pageTimerTargetAt === hourTime(14, 25)
      && smartLateHourWindow.kind === 'allow'
      && smartLateHourWindow.pageTimerTargetAt === hourTime(14, 25)
      && smartAfterHourWindow.kind === 'defer'
      && smartAfterHourWindow.nextTriggerAt === hourTime(14, 30),
    'planSmartModeOnWindow: 智能自动 ON 仅在 :00/:30 分钟执行，并锚定半点绝对关机截止时间');

  const exactFiveMinuteSmartOn = planSmartModeOnWindow(
    smartSchedule(5),
    {
      now: hourTime(13, 30),
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30)
    }
  );
  const shortFiveMinuteSmartOn = planSmartModeOnWindow(
    smartSchedule(5),
    {
      now: hourTime(13, 30, 0, 1),
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30)
    }
  );
  const exactFiveMinuteRemainder = planSmartModeOnWindow(
    smartSchedule(6),
    {
      now: hourTime(13, 31),
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30)
    }
  );
  const shortFiveMinuteRemainder = planSmartModeOnWindow(
    smartSchedule(6),
    {
      now: hourTime(13, 31, 0, 1),
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30)
    }
  );
  assertPass(exactFiveMinuteSmartOn.kind === 'allow'
      && exactFiveMinuteSmartOn.pageTimerTargetAt === hourTime(13, 35)
      && shortFiveMinuteSmartOn.kind === 'defer'
      && shortFiveMinuteSmartOn.nextTriggerAt === hourTime(14, 0)
      && exactFiveMinuteRemainder.kind === 'allow'
      && exactFiveMinuteRemainder.pageTimerTargetAt === hourTime(13, 36)
      && shortFiveMinuteRemainder.kind === 'defer'
      && shortFiveMinuteRemainder.nextTriggerAt === hourTime(14, 0),
    'planSmartModeOnWindow: 独立保留最短 ON 余量防抖，不足五分钟跳过，恰好五分钟保留');

  const exactFiveMinuteRetry = planSmartOnRetryExceptionRecovery(
    smartSchedule(6),
    hourTime(13, 30),
    { now: hourTime(13, 30, 30), retryAt: hourTime(13, 31) }
  );
  const shortFiveMinuteRetry = planSmartOnRetryExceptionRecovery(
    smartSchedule(6),
    hourTime(13, 30),
    { now: hourTime(13, 30, 30), retryAt: hourTime(13, 31, 0, 1) }
  );
  assertPass(exactFiveMinuteRetry.kind === 'retry-smart-on-exception'
      && exactFiveMinuteRetry.pageTimerTargetAt === hourTime(13, 36)
      && shortFiveMinuteRetry.kind === 'defer'
      && shortFiveMinuteRetry.nextTriggerAt === hourTime(14, 0),
    'planSmartOnRetryExceptionRecovery: typed retry 保留最短 ON 余量，且不延长原周期截止');

  const delayedBoundaryNow = hourTime(13, 31, 5);
  const delayedBoundaryTarget = hourTime(13, 55);
  const driftedBoundary1ms = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: delayedBoundaryNow,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30, 0, 1)
    }
  );
  const driftedBoundary1499ms = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: delayedBoundaryNow,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30, 1, 499)
    }
  );
  const driftedBoundary1500ms = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: delayedBoundaryNow,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30, 1, 500)
    }
  );
  const driftedFractionalBoundary = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: delayedBoundaryNow,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30) + 500.5
    }
  );
  const untrustedBoundary1501ms = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: delayedBoundaryNow,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: hourTime(13, 30, 1, 501)
    }
  );
  assertPass(driftedBoundary1ms.kind === 'allow'
      && driftedBoundary1ms.reason === 'smart-on-scheduled-boundary'
      && driftedBoundary1ms.boundaryAt === hourTime(13, 30)
      && driftedBoundary1ms.pageTimerTargetAt === delayedBoundaryTarget
      && driftedBoundary1499ms.kind === 'allow'
      && driftedBoundary1499ms.boundaryAt === hourTime(13, 30)
      && driftedBoundary1499ms.pageTimerTargetAt === delayedBoundaryTarget
      && driftedBoundary1500ms.kind === 'allow'
      && driftedBoundary1500ms.boundaryAt === hourTime(13, 30)
      && driftedFractionalBoundary.kind === 'allow'
      && driftedFractionalBoundary.boundaryAt === hourTime(13, 30)
      && untrustedBoundary1501ms.kind === 'defer',
    'planSmartModeOnWindow: 浏览器半点闹钟不超过 1500ms 漂移仍归一到原边界，超过上限才拒绝');
  assertPass(planSmartModeOnWindow(
    smartSchedule(26),
    { now: hourTime(13, 30), maxOnMinutes: 25 }
  ).kind === 'refuse'
      && planSmartModeOnWindow(
        smartSchedule(26),
        { now: hourTime(13, 30), maxOnMinutes: 30 }
      ).kind === 'refuse',
  'planSmartModeOnWindow: 25 分钟为不可由调用参数放宽的智能 ON 硬上限');
  assertPass(smartModePageTimerTargetAt(25, hourTime(13, 30, 59, 999)) === hourTime(13, 55),
    'smartModePageTimerTargetAt: 延迟唤醒仍以半点 + 25 分钟关机');
  const smartAlreadyOnRetry = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: hourTime(13, 45),
      maxOnMinutes: 25,
      acIsOn: true,
      boundaryAt: hourTime(13, 30)
    }
  );
  const smartAlreadyOnOverrun = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: hourTime(13, 55),
      maxOnMinutes: 25,
      acIsOn: true,
      boundaryAt: hourTime(13, 30)
    }
  );
  const smartAlreadyOnAcrossBoundary = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: hourTime(14, 0),
      maxOnMinutes: 25,
      acIsOn: true,
      boundaryAt: hourTime(13, 30)
    }
  );
  const smartAlreadyOnMissingBoundary = planSmartModeOnWindow(
    smartSchedule(25),
    { now: hourTime(14, 0), maxOnMinutes: 25, acIsOn: true }
  );
  const smartAlreadyOnInvalidBoundary = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: hourTime(14, 0),
      maxOnMinutes: 25,
      acIsOn: true,
      boundaryAt: hourTime(13, 31)
    }
  );
  const smartAlreadyOnFutureBoundary = planSmartModeOnWindow(
    smartSchedule(25),
    {
      now: hourTime(13, 45),
      maxOnMinutes: 25,
      acIsOn: true,
      boundaryAt: hourTime(14, 0)
    }
  );
  assertPass(smartAlreadyOnRetry.kind === 'allow'
      && smartAlreadyOnRetry.reason === 'smart-on-already-active'
      && smartAlreadyOnRetry.pageTimerTargetAt === hourTime(13, 55)
      && smartAlreadyOnOverrun.kind === 'allow'
      && smartAlreadyOnOverrun.reason === 'smart-on-overrun-shutdown'
      && smartAlreadyOnOverrun.pageTimerTargetAt === hourTime(13, 56)
      && smartAlreadyOnAcrossBoundary.kind === 'allow'
      && smartAlreadyOnAcrossBoundary.reason === 'smart-on-overrun-shutdown'
      && smartAlreadyOnAcrossBoundary.boundaryAt === hourTime(13, 30)
      && smartAlreadyOnAcrossBoundary.pageTimerTargetAt === hourTime(14, 1)
      && smartAlreadyOnMissingBoundary.reason === 'smart-on-overrun-shutdown'
      && smartAlreadyOnMissingBoundary.boundaryAt === 0
      && smartAlreadyOnMissingBoundary.pageTimerTargetAt === hourTime(14, 1)
      && smartAlreadyOnInvalidBoundary.reason === 'smart-on-overrun-shutdown'
      && smartAlreadyOnInvalidBoundary.boundaryAt === 0
      && smartAlreadyOnInvalidBoundary.pageTimerTargetAt === hourTime(14, 1)
      && smartAlreadyOnFutureBoundary.reason === 'smart-on-overrun-shutdown'
      && smartAlreadyOnFutureBoundary.boundaryAt === 0
      && smartAlreadyOnFutureBoundary.pageTimerTargetAt === hourTime(13, 46),
    'planSmartModeOnWindow: AC 已开启时只沿用有效原半点，缺失、非法、未来或过期锚点只安排下一整分钟关机');
  assertPass(smartModePageTimerTargetAt(
    10,
    hourTime(13, 15),
    hourTime(13, 0)
  ) === hourTime(13, 10)
      && smartModePageTimerTargetAt(
        10,
        hourTime(13, 15),
        hourTime(13, 1)
      ) === 0,
    'smartModePageTimerTargetAt: 灵敏度重设可沿用原半点锚点，并拒绝非半点锚点');

  const smartOffCommit = {
    kind: 'commit',
    nextAction: 'on',
    nextTriggerAt: hourTime(14, 20),
    delayMinutes: 37,
    phasePatch: { smartState: 'on', nextTriggerAt: hourTime(14, 20) }
  };
  alignSmartModeNextTrigger(smartOffCommit, hourTime(13, 10));
  assertPass(smartOffCommit.nextTriggerAt === hourTime(13, 30)
      && smartOffCommit.phasePatch.nextTriggerAt === hourTime(13, 30),
    'alignSmartModeNextTrigger: OFF 提交的下一 ON 触发对齐到半点');

  const recoveredOverrunOffAt = hourTime(18, 56, 0, 17);
  const recoveredBoundaryAt = hourTime(19, 0);
  const recoveredSafeRetryAt = recoveredBoundaryAt;
  const recoveredOffClock = typeof planSmartOnAfterConfirmedOff === 'function'
    ? planSmartOnAfterConfirmedOff({
        enabled: true,
        smartState: 'on',
        onMinutes: 23,
        offMinutes: 7,
        smartMode: { enabled: true }
      }, {
        now: recoveredOverrunOffAt,
        confirmedOffAt: recoveredOverrunOffAt,
      })
    : null;
  assertPass(recoveredOffClock?.kind === 'smart-on-boundary'
      && recoveredOffClock.nextTriggerAt === recoveredBoundaryAt
      && recoveredOffClock.phasePatch.nextTriggerAt === recoveredBoundaryAt
      && recoveredOffClock.boundaryAt === recoveredBoundaryAt
      && recoveredOffClock.pageTimerTargetAt === hourTime(19, 23)
      && recoveredOffClock.nextTriggerAt < hourTime(19, 30),
    'planSmartOnAfterConfirmedOff: 18:56 确认关机后直接采用 19:00 半点，不增加五分钟保护');

  const classifyNow = hourTime(18, 58, 57);
  const lateSmartClock = typeof classifySmartOnClock === 'function'
    ? classifySmartOnClock({
        enabled: true,
        smartState: 'on',
        onMinutes: 23,
        smartMode: { enabled: true }
      }, hourTime(19, 30), { now: classifyNow })
    : null;
  const nearestSmartClock = typeof classifySmartOnClock === 'function'
    ? classifySmartOnClock({
        enabled: true,
        smartState: 'on',
        onMinutes: 23,
        smartMode: { enabled: true }
      }, hourTime(19, 0), { now: classifyNow })
    : null;
  const typedSafeClock = typeof classifySmartOnClock === 'function'
    ? classifySmartOnClock({
        enabled: true,
        smartState: 'on',
        onMinutes: 23,
        smartMode: { enabled: true },
        smartRetryKind: 'smart-on-safe-delay',
        smartRetryBoundaryAt: hourTime(19, 0),
        smartRetryScheduledAt: recoveredSafeRetryAt
      }, recoveredSafeRetryAt, { now: classifyNow })
    : null;
  const stillLateAfterBoundary = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    smartMode: { enabled: true }
  }, hourTime(19, 30), {
    now: hourTime(19, 3),
    plannedAt: recoveredOverrunOffAt
  });
  const exhaustedOffClock = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 3,
    offMinutes: 27,
    smartMode: { enabled: true }
  }, {
    now: hourTime(18, 59),
    confirmedOffAt: hourTime(18, 59),
  });
  const typedSafetySkipClock = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 3,
    smartMode: { enabled: true },
    smartRetryKind: 'smart-on-safety-skip',
    smartRetryBoundaryAt: hourTime(19, 0),
    smartRetryScheduledAt: hourTime(19, 30)
  }, hourTime(19, 30), {
    now: hourTime(19, 3),
    plannedAt: hourTime(18, 59)
  });
  const zeroDurationNearBoundary = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 0,
    offMinutes: 30,
    smartMode: { enabled: true }
  }, {
    now: hourTime(22, 28),
    confirmedOffAt: hourTime(22, 28),
  });
  const encodedZeroDurationNearBoundary = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 30,
    offMinutes: 30,
    smartMode: { enabled: true }
  }, {
    now: hourTime(22, 28),
    confirmedOffAt: hourTime(22, 28),
  });
  const postBoundaryNormalClock = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    smartMode: { enabled: true }
  }, hourTime(19, 0), {
    now: hourTime(18, 30, 0, 200),
    plannedAt: hourTime(18, 30, 0, 200)
  });
  const boundaryOffCommitNextClock = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    smartMode: { enabled: true }
  }, hourTime(20, 0), {
    now: hourTime(19, 30, 0, 17),
    plannedAt: hourTime(19, 30, 0, 17),
    requirePlannedAt: true
  });
  const ordinarySafeBoundary = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    smartMode: { enabled: true }
  }, {
    now: hourTime(18, 50),
    confirmedOffAt: hourTime(18, 50),
  });
  const zeroDurationSafeBoundary = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 0,
    offMinutes: 30,
    smartMode: { enabled: true }
  }, {
    now: hourTime(22, 20),
    confirmedOffAt: hourTime(22, 20),
  });
  const invalidDurationBoundary = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 26,
    offMinutes: 4,
    smartMode: { enabled: true }
  }, {
    now: hourTime(22, 28),
    confirmedOffAt: hourTime(22, 28),
  });
  const oneMinuteWindowExhausted = planSmartOnAfterConfirmedOff({
    enabled: true,
    smartState: 'on',
    onMinutes: 1,
    offMinutes: 29,
    smartMode: { enabled: true }
  }, {
    now: hourTime(18, 59, 0, 1),
    confirmedOffAt: hourTime(18, 59, 0, 1),
    boundaryAt: hourTime(19, 0)
  });
  const mismatchedMarkerClock = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    smartMode: { enabled: true },
    smartRetryKind: 'smart-on-safe-delay',
    smartRetryBoundaryAt: hourTime(19, 0),
    smartRetryScheduledAt: hourTime(19, 5)
  }, hourTime(19, 30), {
    now: hourTime(19, 21),
    plannedAt: hourTime(18, 56)
  });
  const safetyTimerClock = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    smartMode: { enabled: true },
    smartRetryKind: 'smart-on-safety-timer',
    smartRetryBoundaryAt: 0,
    smartRetryScheduledAt: hourTime(18, 53)
  }, hourTime(18, 53), {
    now: hourTime(18, 54),
    plannedAt: hourTime(18, 52),
    allowDue: true,
    requirePlannedAt: true
  });
  const originlessNearestClock = classifySmartOnClock({
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    smartMode: { enabled: true }
  }, hourTime(19, 0), {
    now: hourTime(18, 58),
    plannedAt: 0,
    requirePlannedAt: true
  });
  assertPass(lateSmartClock?.applicable === true
      && lateSmartClock.valid === false
      && lateSmartClock.kind === 'skipped-nearest-boundary'
      && lateSmartClock.expectedAt === hourTime(19, 0)
      && nearestSmartClock?.valid === true
      && nearestSmartClock.kind === 'nearest-boundary'
      && typedSafeClock?.valid === true
      && typedSafeClock.kind === 'typed-retry'
      && typedSafeClock.boundaryAt === hourTime(19, 0)
      && typedSafeClock.pageTimerTargetAt === hourTime(19, 23)
      && stillLateAfterBoundary.valid === false
      && stillLateAfterBoundary.expectedAt === hourTime(19, 0)
      && exhaustedOffClock.kind === 'smart-on-boundary'
      && exhaustedOffClock.nextTriggerAt === hourTime(19, 0)
      && typedSafetySkipClock.valid === true
      && typedSafetySkipClock.kind === 'safety-skip'
      && zeroDurationNearBoundary.kind === 'smart-on-safety-skip'
      && zeroDurationNearBoundary.nextTriggerAt === hourTime(22, 30)
      && encodedZeroDurationNearBoundary.kind === 'smart-on-safety-skip'
      && encodedZeroDurationNearBoundary.nextTriggerAt === hourTime(22, 30)
      && postBoundaryNormalClock.valid === true
      && postBoundaryNormalClock.expectedAt === hourTime(19, 0)
      && boundaryOffCommitNextClock.valid === true
      && boundaryOffCommitNextClock.expectedAt === hourTime(20, 0)
      && ordinarySafeBoundary.kind === 'smart-on-boundary'
      && ordinarySafeBoundary.nextTriggerAt === hourTime(19, 0)
      && zeroDurationSafeBoundary.kind === 'smart-on-safety-skip'
      && zeroDurationSafeBoundary.nextTriggerAt === hourTime(22, 30)
      && invalidDurationBoundary.kind === 'smart-on-safety-skip'
      && invalidDurationBoundary.nextTriggerAt === hourTime(22, 30)
      && oneMinuteWindowExhausted.kind === 'smart-on-boundary'
      && oneMinuteWindowExhausted.nextTriggerAt === hourTime(19, 0)
      && mismatchedMarkerClock.valid === false
      && mismatchedMarkerClock.kind === 'smart-on-marker-mismatch'
      && safetyTimerClock.valid === true
      && safetyTimerClock.kind === 'safety-timer-retry'
      && originlessNearestClock.valid === false
      && originlessNearestClock.kind === 'missing-clock-origin',
    'classifySmartOnClock: durable 计划时刻保持 19:00 所有权；显式安全延迟与窗口耗尽 marker 才可越过普通半点门禁');

  const smartOnCommit = {
    kind: 'commit',
    nextAction: 'off',
    nextTriggerAt: hourTime(14, 23),
    delayMinutes: 23,
    phasePatch: { smartState: 'off', nextTriggerAt: hourTime(14, 23) }
  };
  alignSmartModeNextTrigger(smartOnCommit, hourTime(14, 0));
  assertPass(smartOnCommit.nextTriggerAt === hourTime(14, 23),
    'alignSmartModeNextTrigger: ON 提交保持 now + onMinutes 不变');

  const immutableSchedule = { ...base, nested: { value: 1 } };
  const immutableAlarm = { scheduledTime: now + 10 * MINUTE_MS };
  const immutableObservations = {
    acIsOn: true,
    pageTimerSucceeded: true,
    pageTimerTargetAt: now + 8 * MINUTE_MS
  };
  const immutableOpts = {
    now,
    nextTriggerToleranceMs: 0,
    legacyTriggerToleranceMs: 0
  };
  const immutableBefore = JSON.stringify({
    immutableSchedule,
    immutableAlarm,
    immutableObservations,
    immutableOpts
  });
  reconcilePwmTrigger(immutableSchedule, immutableAlarm, immutableOpts);
  planPwmRecovery(
    immutableSchedule,
    now - 25 * MINUTE_MS,
    immutableObservations,
    immutableOpts
  );
  planPwmStep(immutableSchedule, immutableObservations, immutableOpts);
  assertPass(
    JSON.stringify({
      immutableSchedule,
      immutableAlarm,
      immutableObservations,
      immutableOpts
    }) === immutableBefore,
    '三个 PWM phase 函数均不修改输入'
  );

  const liveScheduledTime = now + 10 * MINUTE_MS;
  const disabledReconcile = keep(reconcilePwmTrigger(
    { ...base, enabled: false },
    { scheduledTime: liveScheduledTime },
    { now }
  ));
  assertPass(
    disabledReconcile.kind === 'noop' && disabledReconcile.reason === 'disabled',
    'reconcile: disabled → noop'
  );

  const invalidLivePlans = [
    reconcilePwmTrigger(base, null, { now }),
    reconcilePwmTrigger(base, { scheduledTime: now }, { now }),
    reconcilePwmTrigger(base, { scheduledTime: 'invalid' }, { now })
  ].map(keep);
  assertPass(
    invalidLivePlans.every(plan => plan.kind === 'noop'),
    'reconcile: 缺失、非未来或非法 live alarm → noop'
  );

  const alignedReconcile = keep(reconcilePwmTrigger({
    ...base,
    nextTriggerAt: liveScheduledTime + 1500,
    alarmCreatedAt: now,
    alarmDelayMinutes: (liveScheduledTime - now - 1500) / MINUTE_MS
  }, { scheduledTime: liveScheduledTime }, { now }));
  assertPass(
    alignedReconcile.kind === 'noop' && alignedReconcile.reason === 'already-aligned',
    'reconcile: next 与 legacy 均在 1500ms 容差内 → noop'
  );

  const driftReconcile = keep(reconcilePwmTrigger(
    base,
    { scheduledTime: now + 2 * MINUTE_MS },
    { now }
  ));
  assertPass(
    driftReconcile.kind === 'sync-live'
      && driftReconcile.reason === 'live-alarm-drift'
      && driftReconcile.liveScheduledTime === now + 2 * MINUTE_MS
      && driftReconcile.phasePatch.nextTriggerAt === now + 2 * MINUTE_MS
      && driftReconcile.phasePatch.alarmCreatedAt === now
      && driftReconcile.phasePatch.alarmDelayMinutes === 2,
    'reconcile: drift → 以 live alarm 同步 next 与 legacy 字段'
  );

  const legacyMismatch = keep(reconcilePwmTrigger({
    ...base,
    nextTriggerAt: liveScheduledTime,
    alarmCreatedAt: now,
    alarmDelayMinutes: 1
  }, { scheduledTime: liveScheduledTime }, { now }));
  assertPass(
    legacyMismatch.kind === 'sync-live',
    'reconcile: next 已对齐但 legacy 漂移仍需同步'
  );

  const exactSchedule = {
    ...base,
    nextTriggerAt: liveScheduledTime,
    alarmCreatedAt: now,
    alarmDelayMinutes: (liveScheduledTime - now) / MINUTE_MS
  };
  const strictExact = keep(reconcilePwmTrigger(
    exactSchedule,
    { scheduledTime: liveScheduledTime },
    { now, nextTriggerToleranceMs: 0, legacyTriggerToleranceMs: 0 }
  ));
  const strictDrift = keep(reconcilePwmTrigger(
    { ...exactSchedule, nextTriggerAt: liveScheduledTime + 1 },
    { scheduledTime: liveScheduledTime },
    { now, nextTriggerToleranceMs: 0, legacyTriggerToleranceMs: 0 }
  ));
  assertPass(
    strictExact.kind === 'noop' && strictDrift.kind === 'sync-live',
    'reconcile: tolerance=0 仅接受完全相等'
  );

  const expiredBoundary = now - 25 * MINUTE_MS;
  const recoveryOnSchedule = { ...base, pwmState: 'on' };
  const recoveryOffSchedule = { ...base, pwmState: 'off' };
  const recoveredOn = keep(planPwmRecovery(
    recoveryOnSchedule,
    expiredBoundary,
    {},
    { now }
  ));
  const recoveredOff = keep(planPwmRecovery(
    recoveryOffSchedule,
    expiredBoundary,
    { pageTimerSucceeded: true },
    { now }
  ));
  assertPass(
    recoveredOn.kind === 'commit'
      && recoveredOn.nextAction === 'on'
      && recoveredOn.nextTriggerAt === now + 5 * MINUTE_MS
      && recoveredOff.kind === 'commit'
      && recoveredOff.nextAction === 'off'
      && recoveredOff.nextTriggerAt === now + 5 * MINUTE_MS,
    'recovery: 按 ON/OFF 时长交替推进到首个未来边界'
  );

  const invalidRecoveryPlans = [
    planPwmRecovery({ ...base, onMinutes: 0 }, expiredBoundary, {}, { now }),
    planPwmRecovery({ ...base, offMinutes: Number.POSITIVE_INFINITY }, expiredBoundary, {}, { now }),
    planPwmRecovery(base, now + MINUTE_MS, {}, { now })
  ].map(keep);
  assertPass(
    invalidRecoveryPlans.every(plan => plan.kind === 'refuse'),
    'recovery: 非正/非有限时长或未过期边界 → refuse'
  );

  const recoveryAlreadyOff = keep(planPwmRecovery(
    recoveryOffSchedule,
    expiredBoundary,
    { acIsOn: false },
    { now }
  ));
  assertPass(
    recoveryAlreadyOff.kind === 'commit'
      && recoveryAlreadyOff.nextAction === 'on'
      && recoveryAlreadyOff.proofAction === 'clear',
    'recovery: AC 已关时保守提交下一步 ON 并清证明'
  );

  const recoveryTimerHold = keep(planPwmRecovery(
    recoveryOffSchedule,
    expiredBoundary,
    {},
    { now }
  ));
  const recoveryTimerFailure = keep(planPwmRecovery(
    recoveryOffSchedule,
    expiredBoundary,
    { pageTimerSucceeded: false },
    { now }
  ));
  const recoveryTimerTargetAt = now + 8 * MINUTE_MS;
  const recoveryTimerSuccess = keep(planPwmRecovery(
    recoveryOffSchedule,
    expiredBoundary,
    { pageTimerSucceeded: true, pageTimerTargetAt: recoveryTimerTargetAt },
    { now }
  ));
  assertPass(
    recoveryTimerHold.kind === 'hold'
      && recoveryTimerHold.prerequisite === 'set-page-timer'
      && recoveryTimerHold.timerMinutes === 5
      && recoveryTimerFailure.kind === 'retry'
      && recoveryTimerFailure.retryMinutes === 1
      && recoveryTimerFailure.phasePatch.pwmState === 'on'
      && recoveryTimerSuccess.kind === 'commit'
      && recoveryTimerSuccess.nextAction === 'off'
      && recoveryTimerSuccess.nextTriggerAt === recoveryTimerTargetAt,
    'recovery: page timer 前置、失败重试与成功目标对齐'
  );

  const stepOnSchedule = { ...base, pwmState: 'on', onMinutes: 12, offMinutes: 8 };
  const stepOffSchedule = { ...stepOnSchedule, pwmState: 'off' };
  const loopModeAtArbitraryMinute = keep(planPwmStep(
    stepOnSchedule,
    {},
    { now: hourTime(13, 17) }
  ));
  const loopOnTargetAt = hourTime(13, 29);
  const loopOnCommitAtArbitraryMinute = keep(planPwmStep(
    stepOnSchedule,
    {
      toggleSucceeded: true,
      pageTimerSucceeded: true,
      pageTimerVerified: true,
      pageTimerTargetAt: loopOnTargetAt
    },
    { now: hourTime(13, 17) }
  ));
  const loopOffCommitAtArbitraryMinute = keep(planPwmStep(
    stepOffSchedule,
    { acIsOn: false },
    { now: loopOnTargetAt }
  ));
  const stepDisabled = keep(planPwmStep(
    { ...stepOnSchedule, enabled: false },
    {},
    { now }
  ));
  const onTimerFirstMatrix = [undefined, false, true].map(acIsOn => keep(planPwmStep(
    stepOnSchedule,
    { acIsOn },
    { now }
  )));
  const onToggleRetry = keep(planPwmStep(
    stepOnSchedule,
    { acIsOn: false, pageTimerSucceeded: true },
    { now }
  ));
  const onUnknownToggleRetry = keep(planPwmStep(
    stepOnSchedule,
    { pageTimerSucceeded: true },
    { now }
  ));
  const onAlreadyOn = keep(planPwmStep(stepOnSchedule, { acIsOn: true }, { now }));
  const onVerifyRetry = keep(planPwmStep(
    stepOnSchedule,
    { acIsOn: true, pageTimerSucceeded: true },
    { now }
  ));
  const onVerifyFailure = keep(planPwmStep(
    stepOnSchedule,
    { acIsOn: true, pageTimerSucceeded: true, pageTimerVerified: false },
    { now }
  ));
  const onToggleFailure = keep(planPwmStep(
    stepOnSchedule,
    { acIsOn: false, pageTimerSucceeded: true, toggleSucceeded: false },
    { now }
  ));
  const onTimerFailure = keep(planPwmStep(
    stepOnSchedule,
    { acIsOn: false, toggleSucceeded: true, pageTimerSucceeded: false },
    { now }
  ));
  const onCommit = keep(planPwmStep(
    stepOnSchedule,
    { toggleSucceeded: true, pageTimerSucceeded: true, pageTimerVerified: true },
    { now }
  ));
  const onPageTimerTargetAt = now + 13 * MINUTE_MS;
  const onCommitWithPageTarget = keep(planPwmStep(
    stepOnSchedule,
    {
      toggleSucceeded: true,
      pageTimerSucceeded: true,
      pageTimerVerified: true,
      pageTimerTargetAt: onPageTimerTargetAt
    },
    { now }
  ));
  const onCommitWithExpiredPageTarget = keep(planPwmStep(
    stepOnSchedule,
    {
      toggleSucceeded: true,
      pageTimerSucceeded: true,
      pageTimerVerified: true,
      pageTimerTargetAt: now
    },
    { now }
  ));
  const onCommitWithInvalidPageTarget = keep(planPwmStep(
    stepOnSchedule,
    {
      toggleSucceeded: true,
      pageTimerSucceeded: true,
      pageTimerVerified: true,
      pageTimerTargetAt: Number.NaN
    },
    { now }
  ));
  assertPass(
    loopModeAtArbitraryMinute.kind === 'hold'
      && loopModeAtArbitraryMinute.prerequisite === 'arm-page-timer'
      && loopOnCommitAtArbitraryMinute.kind === 'commit'
      && loopOnCommitAtArbitraryMinute.nextAction === 'off'
      && loopOnCommitAtArbitraryMinute.nextTriggerAt === hourTime(13, 29)
      && loopOffCommitAtArbitraryMinute.kind === 'commit'
      && loopOffCommitAtArbitraryMinute.nextAction === 'on'
      && loopOffCommitAtArbitraryMinute.nextTriggerAt === hourTime(13, 37)
      && stepDisabled.kind === 'noop'
      && onTimerFirstMatrix.every(plan => plan.kind === 'hold'
        && plan.prerequisite === 'arm-page-timer'
        && plan.timerMinutes === 12)
      && onToggleRetry.kind === 'retry'
      && onToggleRetry.reason === 'toggle-on-failed'
      && onUnknownToggleRetry.kind === 'retry'
      && onUnknownToggleRetry.reason === 'toggle-on-failed'
      && onAlreadyOn.kind === 'hold'
      && onAlreadyOn.prerequisite === 'arm-page-timer'
      && onAlreadyOn.timerMinutes === 12
      && onVerifyRetry.kind === 'retry'
      && onVerifyRetry.reason === 'page-timer-verify-failed'
      && onVerifyFailure.kind === 'retry'
      && onVerifyFailure.reason === 'page-timer-verify-failed'
      && onVerifyFailure.phasePatch.pwmState === 'on'
      && onToggleFailure.kind === 'retry'
      && onToggleFailure.reason === 'toggle-on-failed'
      && onToggleFailure.retryMinutes === 1
      && onTimerFailure.kind === 'retry'
      && onTimerFailure.reason === 'page-timer-failed'
      && onTimerFailure.phasePatch.pwmState === 'on'
      && onCommit.kind === 'commit'
      && onCommit.nextAction === 'off'
      && onCommit.delayMinutes === 12,
    'step ON/OFF: ON 先写 timer、再按 AC 状态请求单次 ON，开机后新鲜页验证关机定时器才提交'
  );
  assertPass(
    onCommitWithPageTarget.nextTriggerAt === onPageTimerTargetAt
      && onCommitWithPageTarget.phasePatch.nextTriggerAt === onPageTimerTargetAt
      && onCommitWithExpiredPageTarget.nextTriggerAt === now + 12 * MINUTE_MS
      && onCommitWithInvalidPageTarget.nextTriggerAt === now + 12 * MINUTE_MS,
    'step ON: 优先采纳未来页面绝对目标，过期或非法目标回退相对时长'
  );

  const offFreshProof = keep(planPwmStep(
    stepOffSchedule,
    { acIsOn: true, proofFresh: true },
    { now }
  ));
  const offTimerHold = keep(planPwmStep(
    stepOffSchedule,
    { acIsOn: true, proofFresh: false },
    { now }
  ));
  const offTimerRetries = [true, false].map(shortTimerSucceeded => keep(planPwmStep(
    stepOffSchedule,
    {
      acIsOn: true,
      proofFresh: false,
      shortTimerAttempted: true,
      shortTimerSucceeded
    },
    { now }
  )));
  const offPhysicallyOff = keep(planPwmStep(
    stepOffSchedule,
    { acIsOn: false, proofFresh: false },
    { now }
  ));
  assertPass(
    offFreshProof.kind === 'commit'
      && offFreshProof.nextAction === 'on'
      && offFreshProof.proofAction === 'clear'
      && offTimerHold.kind === 'hold'
      && offTimerHold.prerequisite === 'set-short-page-timer'
      && offTimerHold.timerMinutes === 1
      && offTimerRetries.every(plan => plan.kind === 'retry' && plan.retryMinutes === 1)
      && offPhysicallyOff.kind === 'commit'
      && offPhysicallyOff.nextAction === 'on'
      && offPhysicallyOff.proofAction === 'clear',
    'step OFF: fresh proof、短定时器重试与实际已关路径正确'
  );

  assertPass(
    plans.filter(plan => plan.kind === 'commit')
      .every(plan => Number.isFinite(plan.nextTriggerAt) && plan.nextTriggerAt > now),
    '所有 commit 的 nextTriggerAt 均严格位于未来'
  );
  assertPass(
    plans.filter(plan => plan.kind === 'retry')
      .every(plan => plan.retryMinutes === 1 && plan.delayMinutes === 1),
    '所有 retry 均固定为 1 分钟'
  );
  assertPass(
    plans.every(plan => !['click-off', 'toggle-off'].includes(plan.prerequisite)),
    '任何 plan 都不会要求 OFF 点击前置动作'
  );
}
