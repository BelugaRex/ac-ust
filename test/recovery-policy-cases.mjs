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
    pwmState: 'on',
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
      && planSmartRecovery({ ...smartSchedule, pwmState: 'off' }, {
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
    ...smartSchedule,
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
      && coordinatedInterval.smartDecisionReason === 'smart-mode-disabled',
    '恢复协调器在智能策略旁路后交由普通循环策略处理');

  const untrustedSmartStoredClock = planPwmLifecycleRecovery({
    ...smartSchedule,
    onMinutes: 0,
    offMinutes: 30,
    pwmState: 'on'
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
    pwmState: 'on'
  }, {
    now: at(22, 25),
    plannedActionAt: at(22, 26),
    liveAlarmAt: 0,
    storedAlarmAt: at(22, 26),
    maxOnMinutes: 25,
    allowNonBoundarySmartClock: true,
    missingClockAction: 'repair-clock'
  });
  const driftedSmartBoundary = planPwmLifecycleRecovery({
    ...smartSchedule,
    pwmState: 'on'
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
    pwmState: 'off',
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
    pwmState: 'off',
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
  assertPass(untrustedSmartStoredClock.kind === 'repair-clock'
      && untrustedSmartStoredClock.reason === 'untrusted-smart-on-clock'
      && ownedSmartRetryClock.kind === 'restore-stored-alarm'
      && ownedSmartRetryClock.scheduledTime === at(22, 26)
      && driftedSmartBoundary.kind === 'preserve-live-alarm'
      && driftedSmartBoundary.scheduledTime === at(22, 30) + 500.5
      && preparedWeatherProjectedOff.kind === 'repair-clock'
      && preparedWeatherProjectedOff.reason === 'untrusted-smart-on-clock'
      && actualOffPhaseClock.kind === 'preserve-live-alarm',
    '智能 ON 拒绝 22:50 残留钟；天气临时投影 OFF 仍沿用原 ON 所有权；真实 OFF、typed retry 与 1500ms 内边界漂移可保留');
}
