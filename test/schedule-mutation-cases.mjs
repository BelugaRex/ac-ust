import scheduleMutations from '../schedule-mutations.js';

const {
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
} = scheduleMutations;

export function runScheduleMutationCases(assertPass) {
  assertPass(
    Object.keys(scheduleMutations).join(',')
      === [
        'setScheduleNextTrigger',
        'setSchedulePwmClockIntent',
        'setScheduleSmartClockIntent',
        'replaceSchedulePwmRetryState',
        'replaceScheduleSmartRetryState',
        'replaceSchedulePageTimerRetryState',
        'replaceSchedulePageTimerState',
        'recordSchedulePageTimerFailureState',
        'clearSchedulePageTimerProofState',
        'recordSchedulePageTimerProofState'
      ].join(',')
      && Object.isFrozen(scheduleMutations),
    'schedule mutation module 只导出冻结的复合状态写入 primitives'
  );
  assertPass(
    typeof replaceSchedulePageTimerState === 'function',
    '页面 timer 五字段支持精确 replacement，保留 proof 与错误并存的事务状态'
  );

  const originAt = 1_787_983_200_017;
  const targetAt = 1_787_983_440_000.25;
  const schedule = {
    nextTriggerAt: 0,
    smartNextTriggerAt: 111,
    smartClockPlannedAt: 222,
    pwmClockPlannedAt: 333,
    alarmCreatedAt: 444,
    alarmDelayMinutes: 5,
    pwmRetryKind: 'pwm-old',
    pwmRetryBoundaryAt: 555,
    pwmRetryScheduledAt: 666,
    smartRetryKind: 'smart-old',
    smartRetryBoundaryAt: 777,
    smartRetryScheduledAt: 888,
    pwmState: 'pwm-state'
  };
  let nowReads = 0;
  const options = {
    toleranceMs: 1500,
    readNow: () => { nowReads += 1; return originAt; }
  };

  setScheduleNextTrigger(schedule, targetAt, options);
  assertPass(
    schedule.nextTriggerAt === targetAt
      && schedule.smartNextTriggerAt === 111
      && schedule.smartClockPlannedAt === 222
      && schedule.pwmClockPlannedAt === 333
      && schedule.alarmCreatedAt === 444
      && schedule.alarmDelayMinutes === 5
      && schedule.pwmRetryKind === 'pwm-old'
      && schedule.pwmRetryBoundaryAt === 555
      && schedule.pwmRetryScheduledAt === 666
      && schedule.smartRetryKind === 'smart-old'
      && schedule.smartRetryBoundaryAt === 777
      && schedule.smartRetryScheduledAt === 888
      && schedule.pwmState === 'pwm-state'
      && nowReads === 0,
    'generic setter 只更新 nextTriggerAt，不读取 origin 或污染任一 namespace'
  );

  setScheduleNextTrigger(schedule, 0, {
    ...options,
    plannedAt: originAt
  });
  assertPass(
    schedule.nextTriggerAt === 0
      && schedule.smartNextTriggerAt === 111
      && schedule.smartClockPlannedAt === 222
      && schedule.pwmClockPlannedAt === 333
      && schedule.alarmCreatedAt === 444
      && schedule.alarmDelayMinutes === 5
      && schedule.pwmRetryKind === 'pwm-old'
      && schedule.pwmRetryBoundaryAt === 555
      && schedule.pwmRetryScheduledAt === 666
      && schedule.smartRetryKind === 'smart-old'
      && schedule.smartRetryBoundaryAt === 777
      && schedule.smartRetryScheduledAt === 888
      && schedule.pwmState === 'pwm-state'
      && nowReads === 0,
    'generic setter 清除时仍只更新 nextTriggerAt，并忽略 plannedAt/readNow'
  );

  const remoteOriginAt = originAt - 600_000;
  const pwmIntentSchedule = {
    nextTriggerAt: targetAt,
    smartNextTriggerAt: targetAt - 1000,
    smartClockPlannedAt: originAt - 2000,
    pwmClockPlannedAt: originAt - 1000,
    alarmCreatedAt: originAt,
    alarmDelayMinutes: 4,
    untouched: 'kept'
  };
  setSchedulePwmClockIntent(pwmIntentSchedule, targetAt + 500, options);
  assertPass(
    pwmIntentSchedule.nextTriggerAt === targetAt + 500
      && pwmIntentSchedule.pwmClockPlannedAt === originAt - 1000
      && pwmIntentSchedule.smartNextTriggerAt === targetAt - 1000
      && pwmIntentSchedule.smartClockPlannedAt === originAt - 2000
      && pwmIntentSchedule.alarmCreatedAt === 0
      && pwmIntentSchedule.alarmDelayMinutes === 0
      && pwmIntentSchedule.untouched === 'kept'
      && nowReads === 0,
    'same-clock PWM intent 保留旧 pwm origin，且清理 legacy alarm metadata'
  );

  setSchedulePwmClockIntent(pwmIntentSchedule, targetAt + 3000, options);
  assertPass(
    pwmIntentSchedule.nextTriggerAt === targetAt + 3000
      && pwmIntentSchedule.pwmClockPlannedAt === originAt
      && pwmIntentSchedule.smartNextTriggerAt === targetAt - 1000
      && pwmIntentSchedule.smartClockPlannedAt === originAt - 2000
      && pwmIntentSchedule.alarmCreatedAt === 0
      && pwmIntentSchedule.alarmDelayMinutes === 0
      && nowReads === 1,
    '新时钟 PWM intent 惰性创建新的 pwm origin，不读取 Smart namespace'
  );

  setSchedulePwmClockIntent(pwmIntentSchedule, targetAt + 3500, {
    ...options,
    plannedAt: remoteOriginAt
  });
  assertPass(
    pwmIntentSchedule.nextTriggerAt === targetAt + 3500
      && pwmIntentSchedule.pwmClockPlannedAt === remoteOriginAt
      && pwmIntentSchedule.smartNextTriggerAt === targetAt - 1000
      && pwmIntentSchedule.smartClockPlannedAt === originAt - 2000
      && pwmIntentSchedule.alarmCreatedAt === 0
      && pwmIntentSchedule.alarmDelayMinutes === 0
      && nowReads === 1,
    '显式 PWM origin 覆盖为新来源，并继续清理 legacy alarm metadata'
  );

  setSchedulePwmClockIntent(pwmIntentSchedule, 0, options);
  assertPass(
    pwmIntentSchedule.nextTriggerAt === 0
      && pwmIntentSchedule.pwmClockPlannedAt === 0
      && pwmIntentSchedule.smartNextTriggerAt === targetAt - 1000
      && pwmIntentSchedule.smartClockPlannedAt === originAt - 2000
      && pwmIntentSchedule.alarmCreatedAt === 0
      && pwmIntentSchedule.alarmDelayMinutes === 0
      && nowReads === 1,
    '清除 PWM clock intent 只清 PWM 时钟与 legacy metadata，不改变 Smart origin'
  );

  const smartIntentSchedule = {
    nextTriggerAt: targetAt,
    pwmClockPlannedAt: remoteOriginAt,
    smartNextTriggerAt: targetAt,
    smartClockPlannedAt: originAt - 2000,
    alarmCreatedAt: originAt - 3000,
    alarmDelayMinutes: 7,
    untouched: 'kept'
  };
  setScheduleSmartClockIntent(smartIntentSchedule, targetAt + 3000, options);
  assertPass(
    smartIntentSchedule.smartNextTriggerAt === targetAt + 3000
      && smartIntentSchedule.smartClockPlannedAt === originAt
      && smartIntentSchedule.nextTriggerAt === targetAt
      && smartIntentSchedule.pwmClockPlannedAt === remoteOriginAt
      && smartIntentSchedule.alarmCreatedAt === originAt - 3000
      && smartIntentSchedule.alarmDelayMinutes === 7
      && smartIntentSchedule.untouched === 'kept'
      && nowReads === 2,
    'Smart clock intent 只更新 Smart trigger/origin，不污染 PWM 或 alarm metadata'
  );

  setScheduleSmartClockIntent(smartIntentSchedule, targetAt + 3500, {
    ...options,
    plannedAt: remoteOriginAt
  });
  assertPass(
    smartIntentSchedule.smartNextTriggerAt === targetAt + 3500
      && smartIntentSchedule.smartClockPlannedAt === remoteOriginAt
      && smartIntentSchedule.nextTriggerAt === targetAt
      && smartIntentSchedule.pwmClockPlannedAt === remoteOriginAt
      && smartIntentSchedule.alarmCreatedAt === originAt - 3000
      && smartIntentSchedule.alarmDelayMinutes === 7
      && nowReads === 2,
    '显式 Smart origin 只覆盖 Smart namespace，并保留 PWM 与 alarm metadata'
  );

  setScheduleSmartClockIntent(smartIntentSchedule, 0, options);
  assertPass(
    smartIntentSchedule.smartNextTriggerAt === 0
      && smartIntentSchedule.smartClockPlannedAt === 0
      && smartIntentSchedule.nextTriggerAt === targetAt
      && smartIntentSchedule.pwmClockPlannedAt === remoteOriginAt
      && smartIntentSchedule.alarmCreatedAt === originAt - 3000
      && smartIntentSchedule.alarmDelayMinutes === 7
      && nowReads === 2,
    '清除 Smart clock intent 只清 Smart 时钟，不改变 PWM 与 alarm metadata'
  );

  const retrySchedule = {
    pwmRetryKind: 'old-kind',
    pwmRetryBoundaryAt: 111,
    pwmRetryScheduledAt: 222,
    smartRetryKind: 'smart-old-kind',
    smartRetryBoundaryAt: 333,
    smartRetryScheduledAt: 444,
    untouched: 'kept'
  };
  const fractionalRetryAt = targetAt + 0.5;
  replaceSchedulePwmRetryState(retrySchedule, {
    kind: 'unknown-kind',
    boundaryAt: originAt,
    scheduledAt: fractionalRetryAt
  });
  assertPass(
    retrySchedule.pwmRetryKind === 'unknown-kind'
      && retrySchedule.pwmRetryBoundaryAt === originAt
      && retrySchedule.pwmRetryScheduledAt === fractionalRetryAt
      && retrySchedule.smartRetryKind === 'smart-old-kind'
      && retrySchedule.smartRetryBoundaryAt === 333
      && retrySchedule.smartRetryScheduledAt === 444
      && retrySchedule.untouched === 'kept',
    'PWM retry primitive 原样原子替换三字段，不交叉写入 Smart retry'
  );

  replaceSchedulePwmRetryState(retrySchedule);
  assertPass(
    retrySchedule.pwmRetryKind === ''
      && retrySchedule.pwmRetryBoundaryAt === 0
      && retrySchedule.pwmRetryScheduledAt === 0
      && retrySchedule.smartRetryKind === 'smart-old-kind'
      && retrySchedule.smartRetryBoundaryAt === 333
      && retrySchedule.smartRetryScheduledAt === 444
      && retrySchedule.untouched === 'kept',
    '空 PWM retry replacement 只清 PWM retry 三字段'
  );

  const smartRetrySchedule = {
    pwmRetryKind: 'pwm-kind',
    pwmRetryBoundaryAt: 555,
    pwmRetryScheduledAt: 666,
    smartRetryKind: 'old-smart-kind',
    smartRetryBoundaryAt: 777,
    smartRetryScheduledAt: 888,
    untouched: 'kept'
  };
  replaceScheduleSmartRetryState(smartRetrySchedule, {
    kind: 'unknown-smart-kind',
    boundaryAt: originAt,
    scheduledAt: fractionalRetryAt
  });
  assertPass(
    smartRetrySchedule.smartRetryKind === 'unknown-smart-kind'
      && smartRetrySchedule.smartRetryBoundaryAt === originAt
      && smartRetrySchedule.smartRetryScheduledAt === fractionalRetryAt
      && smartRetrySchedule.pwmRetryKind === 'pwm-kind'
      && smartRetrySchedule.pwmRetryBoundaryAt === 555
      && smartRetrySchedule.pwmRetryScheduledAt === 666
      && smartRetrySchedule.untouched === 'kept',
    'Smart retry primitive 原样原子替换三字段，不交叉写入 PWM retry'
  );

  replaceScheduleSmartRetryState(smartRetrySchedule);
  assertPass(
    smartRetrySchedule.smartRetryKind === ''
      && smartRetrySchedule.smartRetryBoundaryAt === 0
      && smartRetrySchedule.smartRetryScheduledAt === 0
      && smartRetrySchedule.pwmRetryKind === 'pwm-kind'
      && smartRetrySchedule.pwmRetryBoundaryAt === 555
      && smartRetrySchedule.pwmRetryScheduledAt === 666
      && smartRetrySchedule.untouched === 'kept',
    '空 Smart retry replacement 只清 Smart retry 三字段'
  );

  const pageRetrySchedule = {
    pageTimerMinutes: 8,
    pageTimerTargetAt: targetAt,
    pageTimerError: 'kept error',
    pageTimerRetryAt: 111,
    pageTimerRetryMinutes: 2,
    pwmState: 'on'
  };
  const fractionalPageRetryAt = targetAt + 0.75;
  replaceSchedulePageTimerRetryState(pageRetrySchedule, {
    retryAt: fractionalPageRetryAt,
    retryMinutes: -2.5
  });
  assertPass(
    pageRetrySchedule.pageTimerRetryAt === fractionalPageRetryAt
      && pageRetrySchedule.pageTimerRetryMinutes === -2.5
      && pageRetrySchedule.pageTimerMinutes === 8
      && pageRetrySchedule.pageTimerTargetAt === targetAt
      && pageRetrySchedule.pageTimerError === 'kept error'
      && pageRetrySchedule.pwmState === 'on',
    '页面 retry primitive 原样替换二字段，不转换值或污染 proof/PWM'
  );

  replaceSchedulePageTimerRetryState(pageRetrySchedule);
  assertPass(
    pageRetrySchedule.pageTimerRetryAt === 0
      && pageRetrySchedule.pageTimerRetryMinutes === 0
      && pageRetrySchedule.pageTimerMinutes === 8
      && pageRetrySchedule.pageTimerError === 'kept error',
    '空页面 retry replacement 只清 retry 二字段'
  );

  const exactPageTimerState = {
    pageTimerMinutes: null,
    pageTimerTargetAt: 0,
    pageTimerError: '',
    pageTimerRetryAt: 0,
    pageTimerRetryMinutes: 0,
    configSentinel: 'kept'
  };
  const exactError = { raw: 'verified timer but alarm failed' };
  replaceSchedulePageTimerState(exactPageTimerState, {
    minutes: 17.5,
    targetAt: targetAt + 0.125,
    error: exactError,
    retryAt: fractionalPageRetryAt,
    retryMinutes: 2.25
  });
  assertPass(
    exactPageTimerState.pageTimerMinutes === 17.5
      && exactPageTimerState.pageTimerTargetAt === targetAt + 0.125
      && exactPageTimerState.pageTimerError === exactError
      && exactPageTimerState.pageTimerRetryAt === fractionalPageRetryAt
      && exactPageTimerState.pageTimerRetryMinutes === 2.25
      && exactPageTimerState.configSentinel === 'kept',
    '精确页面 timer replacement 原样提交 proof/error/retry 五字段并保留无关配置'
  );

  const failureError = { raw: 'failure' };
  recordSchedulePageTimerFailureState(pageRetrySchedule, failureError, {
    retryAt: fractionalPageRetryAt,
    retryMinutes: 1.25
  });
  assertPass(
    pageRetrySchedule.pageTimerMinutes === null
      && pageRetrySchedule.pageTimerTargetAt === 0
      && pageRetrySchedule.pageTimerError === failureError
      && pageRetrySchedule.pageTimerRetryAt === fractionalPageRetryAt
      && pageRetrySchedule.pageTimerRetryMinutes === 1.25
      && pageRetrySchedule.pwmState === 'on',
    '失败 primitive 同步提交完整五字段，不转换 caller 已决定的值'
  );

  recordSchedulePageTimerFailureState(pageRetrySchedule, 'no retry');
  assertPass(
    pageRetrySchedule.pageTimerMinutes === null
      && pageRetrySchedule.pageTimerTargetAt === 0
      && pageRetrySchedule.pageTimerError === 'no retry'
      && pageRetrySchedule.pageTimerRetryAt === 0
      && pageRetrySchedule.pageTimerRetryMinutes === 0
      && pageRetrySchedule.pwmState === 'on',
    '失败 primitive 省略 retry intent 时同步清 retry 二字段'
  );

  const proofSchedule = {
    pageTimerMinutes: 7,
    pageTimerTargetAt: 111,
    pageTimerError: 'old error',
    pageTimerRetryAt: 222,
    pageTimerRetryMinutes: 1,
    pwmState: 'off'
  };
  const proofMinutes = 22.5;
  const proofTargetAt = targetAt + 0.25;
  recordSchedulePageTimerProofState(proofSchedule, proofMinutes, proofTargetAt);
  assertPass(
    proofSchedule.pageTimerMinutes === proofMinutes
      && proofSchedule.pageTimerTargetAt === proofTargetAt
      && proofSchedule.pageTimerError === ''
      && proofSchedule.pageTimerRetryAt === 0
      && proofSchedule.pageTimerRetryMinutes === 0
      && proofSchedule.pwmState === 'off',
    '成功 proof 同步提交五字段，不转换调用方已经验证的值'
  );

  clearSchedulePageTimerProofState(proofSchedule);
  assertPass(
    proofSchedule.pageTimerMinutes === null
      && proofSchedule.pageTimerTargetAt === 0
      && proofSchedule.pageTimerError === ''
      && proofSchedule.pageTimerRetryAt === 0
      && proofSchedule.pageTimerRetryMinutes === 0
      && proofSchedule.pwmState === 'off',
    '清 proof 同步清五字段且不污染 PWM 相位'
  );
}
