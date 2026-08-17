import pwmPhase from '../pwm-phase.js';

const MINUTE_MS = 60_000;
const {
  planPwmStep,
  planPwmRecovery,
  reconcilePwmTrigger,
  nextHourBoundary,
  nextHalfHourBoundary,
  alignSmartModeNextTrigger
} = pwmPhase;

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
      === 'alignSmartModeNextTrigger,nextHalfHourBoundary,nextHourBoundary,planPwmRecovery,planPwmStep,reconcilePwmTrigger',
    'PWM phase module 导出规划函数与整点/半点对齐函数'
  );

  // 智能模式整点/半点对齐：nextHourBoundary（天气整点刷新）与 nextHalfHourBoundary（30 分钟周期）
  const hourTime = (h, m) => new Date(2026, 7, 17, h, m, 0).getTime();
  assertPass(nextHourBoundary(hourTime(13, 20)) === hourTime(14, 0),
    'nextHourBoundary: 13:20 → 14:00');
  assertPass(nextHourBoundary(hourTime(14, 0)) === hourTime(15, 0),
    'nextHourBoundary: 整点也进到下一小时');
  assertPass(nextHalfHourBoundary(hourTime(13, 10)) === hourTime(13, 30),
    'nextHalfHourBoundary: 13:10 → 13:30');
  assertPass(nextHalfHourBoundary(hourTime(13, 45)) === hourTime(14, 0),
    'nextHalfHourBoundary: 13:45 → 14:00');
  assertPass(nextHalfHourBoundary(hourTime(13, 30)) === hourTime(14, 0),
    'nextHalfHourBoundary: 半点也进到下一个半点');

  const smartOffCommit = {
    kind: 'commit',
    nextAction: 'on',
    nextTriggerAt: hourTime(14, 20),
    delayMinutes: 37,
    phasePatch: { pwmState: 'on', nextTriggerAt: hourTime(14, 20) }
  };
  alignSmartModeNextTrigger(smartOffCommit, hourTime(13, 10));
  assertPass(smartOffCommit.nextTriggerAt === hourTime(13, 30)
      && smartOffCommit.phasePatch.nextTriggerAt === hourTime(13, 30),
    'alignSmartModeNextTrigger: OFF 提交的下一 ON 触发对齐到半点');

  const smartOnCommit = {
    kind: 'commit',
    nextAction: 'off',
    nextTriggerAt: hourTime(14, 23),
    delayMinutes: 23,
    phasePatch: { pwmState: 'off', nextTriggerAt: hourTime(14, 23) }
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
      && recoveryTimerFailure.phasePatch.pwmState === 'off'
      && recoveryTimerSuccess.kind === 'commit'
      && recoveryTimerSuccess.nextAction === 'off'
      && recoveryTimerSuccess.nextTriggerAt === recoveryTimerTargetAt,
    'recovery: page timer 前置、失败重试与成功目标对齐'
  );

  const stepOnSchedule = { ...base, pwmState: 'on', onMinutes: 12, offMinutes: 8 };
  const stepOffSchedule = { ...stepOnSchedule, pwmState: 'off' };
  const stepDisabled = keep(planPwmStep(
    { ...stepOnSchedule, enabled: false },
    {},
    { now }
  ));
  const onToggleHold = keep(planPwmStep(stepOnSchedule, {}, { now }));
  const onAlreadyOn = keep(planPwmStep(stepOnSchedule, { acIsOn: true }, { now }));
  const onToggleFailure = keep(planPwmStep(
    stepOnSchedule,
    { acIsOn: false, toggleSucceeded: false },
    { now }
  ));
  const onTimerFailure = keep(planPwmStep(
    stepOnSchedule,
    { toggleSucceeded: true, pageTimerSucceeded: false },
    { now }
  ));
  const onCommit = keep(planPwmStep(
    stepOnSchedule,
    { toggleSucceeded: true, pageTimerSucceeded: true },
    { now }
  ));
  assertPass(
    stepDisabled.kind === 'noop'
      && onToggleHold.kind === 'hold'
      && onToggleHold.prerequisite === 'toggle-on'
      && onToggleHold.proofAction === 'clear'
      && onAlreadyOn.kind === 'hold'
      && onAlreadyOn.prerequisite === 'set-page-timer'
      && onAlreadyOn.timerMinutes === 12
      && onToggleFailure.kind === 'retry'
      && onToggleFailure.retryMinutes === 1
      && onTimerFailure.kind === 'retry'
      && onTimerFailure.phasePatch.pwmState === 'on'
      && onCommit.kind === 'commit'
      && onCommit.nextAction === 'off'
      && onCommit.delayMinutes === 12,
    'step ON: toggle、already-on、page timer 与 commit 路径正确'
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