import scheduleMutations from '../schedule-mutations.js';

const { setScheduleNextTrigger } = scheduleMutations;

export function runScheduleMutationCases(assertPass) {
  assertPass(
    Object.keys(scheduleMutations).join(',') === 'setScheduleNextTrigger'
      && Object.isFrozen(scheduleMutations),
    'schedule mutation module 只导出冻结的 next-trigger 写入 primitive'
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
}
