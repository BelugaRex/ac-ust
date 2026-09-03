import smartRecovery from '../smart-recovery.js';
import intervalRecovery from '../interval-recovery.js';
import recoveryCoordinator from '../recovery-coordinator.js';

const MINUTE_MS = 60_000;
const { planSmartRecovery } = smartRecovery;
const { planIntervalRecovery } = intervalRecovery;
const { planPwmLifecycleRecovery } = recoveryCoordinator;

export function runRecoveryPolicyCases(assertPass) {
  const at = (hour, minute, second = 0) => (
    new Date(2026, 7, 27, hour, minute, second, 0).getTime()
  );
  const boundaryAt = at(17, 30);
  const now = at(17, 37, 7);
  const smartSchedule = {
    enabled: true,
    smartState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    smartMode: { enabled: true }
  };

  assertPass(Object.keys(smartRecovery).join(',') === 'planSmartRecovery'
      && Object.keys(intervalRecovery).join(',') === 'planIntervalRecovery'
      && Object.keys(recoveryCoordinator).join(',') === 'planPwmLifecycleRecovery',
    '恢复模块只导出各自的单一纯策略入口');

  const smartCurrentCycle = planSmartRecovery(smartSchedule, {
    now,
    plannedActionAt: at(18, 0),
    maxOnMinutes: 25
  });
  assertPass(smartCurrentCycle.kind === 'recover-smart-current-cycle'
      && smartCurrentCycle.strategy === 'smart'
      && smartCurrentCycle.scheduledTime === boundaryAt
      && smartCurrentCycle.pageTimerTargetAt === at(17, 53),
    '智能恢复模块补当前剩余 ON 窗口并保留原半点绝对截止');

  const preservedShortRetry = planSmartRecovery(smartSchedule, {
    now,
    plannedActionAt: now + MINUTE_MS,
    maxOnMinutes: 25
  });
  assertPass(preservedShortRetry.kind === 'pass'
      && preservedShortRetry.reason === 'current-cycle-action-preserved',
    '智能恢复模块保留当前周期内的一分钟失败重试');

  const lateSmartRecovery = planSmartRecovery(smartSchedule, {
    now: at(17, 52, 30),
    plannedActionAt: at(18, 0),
    maxOnMinutes: 25
  });
  assertPass(lateSmartRecovery.kind === 'pass'
      && lateSmartRecovery.reason === 'wait-for-smart-on-window',
    '智能恢复模块在页面定时器安全余量不足时拒绝补开');

  const exactFiveMinuteRecovery = planSmartRecovery({
    ...smartSchedule,
    onMinutes: 23
  }, {
    now: at(17, 48),
    plannedActionAt: at(18, 0),
    maxOnMinutes: 25
  });
  const shortFiveMinuteRecovery = planSmartRecovery({
    ...smartSchedule,
    onMinutes: 23
  }, {
    now: at(17, 48) + 1,
    plannedActionAt: at(18, 0),
    maxOnMinutes: 25
  });
  assertPass(exactFiveMinuteRecovery.kind === 'recover-smart-current-cycle'
      && exactFiveMinuteRecovery.pageTimerTargetAt === at(17, 53)
      && shortFiveMinuteRecovery.kind === 'pass'
      && shortFiveMinuteRecovery.reason === 'wait-for-smart-on-window',
    '智能恢复模块仅在实际 ON 余量至少五分钟时补开；不足五分钟折叠短 ON，恰好五分钟保留');

  assertPass(planSmartRecovery({ ...smartSchedule, enabled: false }, {
    now,
    plannedActionAt: at(18, 0),
    maxOnMinutes: 25
  }).reason === 'automation-disabled'
      && planSmartRecovery({ ...smartSchedule, smartMode: { enabled: false } }, {
        now,
        plannedActionAt: at(18, 0),
        maxOnMinutes: 25
      }).reason === 'smart-mode-disabled'
      && planSmartRecovery({ ...smartSchedule, smartState: 'off' }, {
        now,
        plannedActionAt: at(18, 0),
        maxOnMinutes: 25
      }).reason === 'next-action-not-on',
    '智能恢复模块对停用自动控制、非智能模式与非 ON 动作明确旁路');

  assertPass(planIntervalRecovery({
    now,
    liveAlarmAt: at(17, 45),
    storedAlarmAt: at(17, 46)
  }).kind === 'preserve-live-alarm',
  '循环恢复模块优先保留未来 live alarm');

  assertPass(planIntervalRecovery({
    now,
    liveAlarmAt: 0,
    storedAlarmAt: at(17, 46)
  }).kind === 'restore-stored-alarm',
  '循环恢复模块在 live 缺失时恢复未来 storage 边界');

  const expiredInterval = planIntervalRecovery({
    now,
    expiredAlarmAt: at(17, 30),
    storedAlarmAt: at(17, 30)
  });
  assertPass(expiredInterval.kind === 'advance-expired-alarm'
      && expiredInterval.scheduledTime === at(17, 30),
    '循环恢复模块把明确过期 alarm 交给相位推进器');

  const storedDue = planIntervalRecovery({
    now,
    storedAlarmAt: at(17, 30)
  });
  assertPass(storedDue.kind === 'execute-due-action'
      && storedDue.scheduledTime === at(17, 30),
    '循环恢复模块在仅 storage 到期时补执行原计划动作');

  assertPass(planIntervalRecovery({
    now,
    missingClockAction: 'execute-current'
  }).kind === 'execute-current-action'
      && planIntervalRecovery({
        now,
        missingClockAction: 'repair-clock'
      }).kind === 'repair-clock'
      && planIntervalRecovery({
        now,
        missingClockAction: 'noop'
      }).kind === 'noop',
    '循环恢复模块用明确缺钟动作取代事件来源中的隐式布尔分支');

  const coordinatedSmart = planPwmLifecycleRecovery(smartSchedule, {
    now,
    plannedActionAt: at(18, 0),
    liveAlarmAt: at(18, 0),
    storedAlarmAt: at(18, 0),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  assertPass(coordinatedSmart.kind === 'recover-smart-current-cycle'
      && coordinatedSmart.strategy === 'smart',
    '恢复协调器优先选择仍安全的智能当前周期恢复');

  const coordinatedInterval = planPwmLifecycleRecovery({
    enabled: true,
    pwmState: 'on',
    smartMode: { enabled: false }
  }, {
    now,
    liveAlarmAt: at(17, 45),
    storedAlarmAt: at(17, 46),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  assertPass(coordinatedInterval.kind === 'preserve-live-alarm'
      && coordinatedInterval.strategy === 'interval'
      && !Object.prototype.hasOwnProperty.call(coordinatedInterval, 'smartDecisionReason'),
    '恢复协调器按当前模式选择普通循环策略，不携带 Smart fallback 语义');

  const untrustedSmartStoredClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    onMinutes: 0,
    offMinutes: 30,
    smartState: 'on'
  }, {
    now: at(22, 25),
    plannedActionAt: at(22, 50),
    liveAlarmAt: 0,
    storedAlarmAt: at(22, 50),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const ownedSmartRetryClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on',
    smartRetryKind: 'smart-on',
    smartRetryBoundaryAt: at(22, 0),
    smartRetryScheduledAt: at(22, 18)
  }, {
    now: at(22, 17),
    plannedActionAt: at(22, 18),
    liveAlarmAt: 0,
    storedAlarmAt: at(22, 18),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const shortSmartRetryClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on',
    smartRetryKind: 'smart-on',
    smartRetryBoundaryAt: at(22, 0),
    smartRetryScheduledAt: at(22, 22)
  }, {
    now: at(22, 21),
    plannedActionAt: at(22, 22),
    liveAlarmAt: 0,
    storedAlarmAt: at(22, 22),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const driftedSmartBoundary = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on'
  }, {
    now: at(22, 30) + 200.25,
    plannedActionAt: at(22, 30) + 500.5,
    liveAlarmAt: at(22, 30) + 500.5,
    storedAlarmAt: at(22, 30) + 500.5,
    maxOnMinutes: 25,
    smartBoundaryToleranceMs: 1500,
    missingClockAction: 'repair-clock'
  });
  const preparedWeatherProjectedOff = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'off',
    onMinutes: 0,
    offMinutes: 30
  }, {
    now: at(22, 31),
    plannedActionAt: at(22, 50),
    liveAlarmAt: at(22, 50),
    storedAlarmAt: at(22, 50),
    smartNextAction: 'on',
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const actualOffPhaseClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'off',
    onMinutes: 0,
    offMinutes: 30
  }, {
    now: at(22, 31),
    plannedActionAt: at(22, 50),
    liveAlarmAt: at(22, 50),
    storedAlarmAt: at(22, 50),
    smartNextAction: 'off',
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const exactButSkippedSmartClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on'
  }, {
    now: at(18, 58, 57),
    plannedActionAt: at(19, 30),
    liveAlarmAt: at(19, 30),
    storedAlarmAt: at(19, 30),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const nearestSmartBoundaryClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on'
  }, {
    now: at(18, 58, 57),
    plannedActionAt: at(19, 0),
    liveAlarmAt: at(19, 0),
    storedAlarmAt: at(19, 0),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const skippedClockStillInvalidAt1903 = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on'
  }, {
    now: at(19, 3),
    smartClockPlannedAt: at(18, 56),
    plannedActionAt: at(19, 30),
    liveAlarmAt: at(19, 30),
    storedAlarmAt: at(19, 30),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const explicitSafetySkipPreserved = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on',
    onMinutes: 3,
    offMinutes: 27,
    smartRetryKind: 'smart-on-safety-skip',
    smartRetryBoundaryAt: at(19, 0),
    smartRetryScheduledAt: at(19, 30)
  }, {
    now: at(19, 1),
    smartClockPlannedAt: at(18, 59),
    plannedActionAt: at(19, 30),
    liveAlarmAt: at(19, 30),
    storedAlarmAt: at(19, 30),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const badClockDue = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on'
  }, {
    now: at(19, 30),
    smartClockPlannedAt: at(18, 56),
    plannedActionAt: at(19, 30),
    storedAlarmAt: at(19, 30),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  const badClockExpired = planPwmLifecycleRecovery({
    ...smartSchedule,
    smartState: 'on'
  }, {
    now: at(19, 30, 2),
    smartClockPlannedAt: at(18, 56),
    plannedActionAt: at(19, 30),
    expiredAlarmAt: at(19, 30),
    maxOnMinutes: 25,
    missingClockAction: 'repair-clock'
  });
  assertPass(untrustedSmartStoredClock.kind === 'repair-clock'
      && untrustedSmartStoredClock.reason === 'untrusted-smart-on-clock'
      && ownedSmartRetryClock.kind === 'restore-stored-alarm'
      && ownedSmartRetryClock.scheduledTime === at(22, 18)
      && shortSmartRetryClock.kind === 'repair-clock'
      && shortSmartRetryClock.reason === 'untrusted-smart-on-clock'
      && driftedSmartBoundary.kind === 'preserve-live-alarm'
      && driftedSmartBoundary.scheduledTime === at(22, 30) + 500.5
      && preparedWeatherProjectedOff.kind === 'repair-clock'
      && preparedWeatherProjectedOff.reason === 'untrusted-smart-on-clock'
      && actualOffPhaseClock.kind === 'preserve-live-alarm'
      && exactButSkippedSmartClock.kind === 'repair-clock'
      && exactButSkippedSmartClock.reason === 'skipped-nearest-smart-on-boundary'
      && exactButSkippedSmartClock.expectedAt === at(19, 0)
      && nearestSmartBoundaryClock.kind === 'preserve-live-alarm'
      && nearestSmartBoundaryClock.scheduledTime === at(19, 0)
      && skippedClockStillInvalidAt1903.kind === 'repair-clock'
      && skippedClockStillInvalidAt1903.expectedAt === at(19, 0)
      && explicitSafetySkipPreserved.kind === 'preserve-live-alarm'
      && explicitSafetySkipPreserved.smartDecisionReason
        === 'explicit-smart-on-safety-skip'
      && badClockDue.kind === 'repair-clock'
      && badClockDue.expectedAt === at(19, 0)
      && badClockExpired.kind === 'repair-clock'
      && badClockExpired.expectedAt === at(19, 0),
    '智能 ON 拒绝非半点、跳周期钟与不足五分钟的 typed retry；恰好五分钟、真实 OFF、最近边界与 1500ms 漂移可保留');
}
