import scheduleMutations from '../schedule-mutations.js';

const {
  setScheduleNextTrigger,
  setSchedulePwmClockIntent,
  replaceSchedulePwmRetryState,
  replaceSchedulePageTimerRetryState,
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
        'replaceSchedulePwmRetryState',
        'replaceSchedulePageTimerRetryState',
        'recordSchedulePageTimerFailureState',
        'clearSchedulePageTimerProofState',
        'recordSchedulePageTimerProofState'
      ].join(',')
      && Object.isFrozen(scheduleMutations),
    'schedule mutation module 只导出冻结的复合状态写入 primitives'
  );

  const originAt = 1_787_983_200_017;
  const targetAt = 1_787_983_440_000.25;
  const schedule = {
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    alarmCreatedAt: 0
  };
  let nowReads = 0;
  const options = {
    toleranceMs: 1500,
    readNow: () => { nowReads += 1; return originAt; }
  };

  setScheduleNextTrigger(schedule, targetAt, options);
  assertPass(
    schedule.nextTriggerAt === targetAt
      && schedule.smartClockPlannedAt === originAt
      && nowReads === 1,
    '新时钟保留小数毫秒，并只读取一次 immutable origin'
  );

  setScheduleNextTrigger(schedule, targetAt + 1500, options);
  assertPass(
    schedule.nextTriggerAt === targetAt + 1500
      && schedule.smartClockPlannedAt === originAt
      && nowReads === 1,
    '容差边界内的 live verify 保留原 origin，且不读取当前时间'
  );

  const remoteOriginAt = originAt - 600_000;
  setScheduleNextTrigger(schedule, targetAt + 500, {
    ...options,
    plannedAt: remoteOriginAt
  });
  assertPass(
    schedule.smartClockPlannedAt === remoteOriginAt && nowReads === 1,
    '显式远端 origin 无条件覆盖同钟 origin，且不读取当前时间'
  );

  const legacySchedule = {
    nextTriggerAt: targetAt,
    smartClockPlannedAt: 0,
    alarmCreatedAt: originAt - 1000
  };
  setScheduleNextTrigger(legacySchedule, targetAt + 500, options);
  assertPass(
    legacySchedule.smartClockPlannedAt === originAt - 1000 && nowReads === 1,
    '同钟缺少 origin 时继承 legacy alarmCreatedAt，不制造新来源'
  );

  setScheduleNextTrigger(schedule, targetAt + 2000.001, options);
  assertPass(
    schedule.smartClockPlannedAt === originAt && nowReads === 2,
    '超过容差即认领新时钟，并惰性读取一次新 origin'
  );

  setScheduleNextTrigger(schedule, 0, options);
  assertPass(
    schedule.nextTriggerAt === 0
      && schedule.smartClockPlannedAt === 0
      && nowReads === 2,
    '清除时钟同步清除 origin，且不读取当前时间'
  );

  const intentSchedule = {
    nextTriggerAt: targetAt,
    smartClockPlannedAt: 0,
    alarmCreatedAt: originAt,
    alarmDelayMinutes: 4,
    untouched: 'kept'
  };
  setSchedulePwmClockIntent(intentSchedule, targetAt + 500, options);
  assertPass(
    intentSchedule.nextTriggerAt === targetAt + 500
      && intentSchedule.smartClockPlannedAt === originAt
      && intentSchedule.alarmCreatedAt === 0
      && intentSchedule.alarmDelayMinutes === 0
      && intentSchedule.untouched === 'kept'
      && nowReads === 2,
    'same-clock intent 先继承 legacy origin，再清 verified alarm metadata'
  );

  setSchedulePwmClockIntent(intentSchedule, targetAt + 3000, {
    ...options,
    plannedAt: remoteOriginAt
  });
  assertPass(
    intentSchedule.nextTriggerAt === targetAt + 3000
      && intentSchedule.smartClockPlannedAt === remoteOriginAt
      && intentSchedule.alarmCreatedAt === 0
      && intentSchedule.alarmDelayMinutes === 0
      && nowReads === 2,
    '显式 origin 的新 intent 保留来源并声明尚无 verified alarm'
  );

  setSchedulePwmClockIntent(intentSchedule, 0, options);
  assertPass(
    intentSchedule.nextTriggerAt === 0
      && intentSchedule.smartClockPlannedAt === 0
      && intentSchedule.alarmCreatedAt === 0
      && intentSchedule.alarmDelayMinutes === 0
      && nowReads === 2,
    '撤销 clock intent 同步清四个时钟字段且不读取当前时间'
  );

  const retrySchedule = {
    pwmRetryKind: 'old-kind',
    pwmRetryBoundaryAt: 111,
    pwmRetryScheduledAt: 222,
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
      && retrySchedule.untouched === 'kept',
    'retry primitive 原样原子替换三字段，不吞掉 unknown kind 或小数毫秒'
  );

  replaceSchedulePwmRetryState(retrySchedule);
  assertPass(
    retrySchedule.pwmRetryKind === ''
      && retrySchedule.pwmRetryBoundaryAt === 0
      && retrySchedule.pwmRetryScheduledAt === 0
      && retrySchedule.untouched === 'kept',
    '空 retry replacement 只清 retry 三字段'
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
