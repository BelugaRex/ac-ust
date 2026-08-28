// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

// i18n 辅助函数 — 使用 fetch-based I18n 模块（绕过 chrome.i18n 不可靠性）
importScripts('i18n.js');
importScripts('sync-helpers.js');  // 跨设备同步的纯函数（composeSyncPayload / computePhaseAdoption）
importScripts('pwm-phase.js');  // PWM 阶段推进、恢复与 live alarm 对齐的纯决策
importScripts('smart-recovery.js');  // 智能当前周期恢复策略（纯决策）
importScripts('interval-recovery.js');  // 普通循环 alarm/storage 恢复策略（纯决策）
importScripts('recovery-coordinator.js');  // 智能优先、循环兜底的恢复协调策略（纯决策）
importScripts('smart-mode.js');  // 智能模式纯决策（computeSmartOnMinutes 等，无 chrome.* 副作用）
const t = (key, ...subs) => I18n.t(key, ...subs);

// build.sh 会在 dist 中与 popup.js 注入同一构建身份；源码保留 dev 占位。
const BUILD_TIME = 'dev';
const BUILD_TIME_EPOCH_MS = 0;

function isMatchingRuntimeComponentBuild(component) {
  if (!(Number(BUILD_TIME_EPOCH_MS) > 0)) return null;
  return Number(component?.buildTimeEpochMs) === Number(BUILD_TIME_EPOCH_MS)
    && String(component?.buildTime || '') === BUILD_TIME;
}

function assessContentRuntimeIdentity(probe) {
  const runtimeIdentity = probe?.runtimeIdentity || {};
  const contentMatches = isMatchingRuntimeComponentBuild(runtimeIdentity.content);
  const mainMatches = isMatchingRuntimeComponentBuild(runtimeIdentity.main);
  const formalBuild = Number(BUILD_TIME_EPOCH_MS) > 0;
  return {
    formalBuild,
    valid: formalBuild
      ? contentMatches === true && mainMatches === true
      : probe != null,
    contentMatches,
    mainMatches,
    expected: {
      buildTime: BUILD_TIME,
      buildTimeEpochMs: BUILD_TIME_EPOCH_MS
    },
    actual: runtimeIdentity,
    code: formalBuild && (contentMatches !== true || mainMatches !== true)
      ? 'CONTENT-RUNTIME-MISMATCH'
      : ''
  };
}

const AC_PAGE = 'https://w5.ab.ust.hk/njggt/app/home';
const PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS = [10000, 15000, 20000];
const COMFORT_START_MINUTES = 5;
const COMFORT_START_RETRY_MS = 60_000;
const COMFORT_START_END_ALARM = 'ac-comfort-end';
const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
const STORAGE_KEY = 'ac_schedule';
const PWM_LAST_OUTCOME_KEY = 'ac_pwm_last_outcome';
const PWM_OUTCOME_SCHEMA_VERSION = 1;
const ACTIVE_BOUNDARY_RETRY_KEY = 'ac_active_boundary_retry_at';
const ACTIVE_BOUNDARY_RETRY_MODE_KEY = 'ac_active_boundary_retry_mode';
const ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY = 'ac_active_boundary_retry_boundary_at';
const ACTIVE_BOUNDARY_RETRY_MODE_ACTION = 'action';
const ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE = 'schedule';
const ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM = 'ac-active-boundary-schedule-retry';
const ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM = 'ac-active-boundary-owner-read-retry';
const ACTIVE_BOUNDARY_RETRY_MS = 60_000;
const INSTALL_BOOTSTRAP_KEY = 'ac_install_bootstrap_complete';
const DIAGNOSTIC_LOG_KEY = 'ac_diagnostic_log';
const DIAGNOSTIC_LOG_MAX_ENTRIES = 50;
const DIAGNOSTIC_LOG_MAX_MESSAGE_LENGTH = 300;

let diagnosticLogWriteChain = Promise.resolve();

function normalizeDiagnosticMessage(error) {
  let message;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    message = error.message;
  } else {
    message = String(error ?? '未知错误');
  }
  return message
    .replace(/(?:https?|chrome-extension):\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .slice(0, DIAGNOSTIC_LOG_MAX_MESSAGE_LENGTH);
}

function appendDiagnosticLog(level, source, error) {
  const entry = {
    timestamp: Date.now(),
    level: level === 'warn' ? 'warn' : 'error',
    source: String(source || 'unknown').slice(0, 80),
    message: normalizeDiagnosticMessage(error)
  };

  diagnosticLogWriteChain = diagnosticLogWriteChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(DIAGNOSTIC_LOG_KEY);
      const previous = Array.isArray(stored?.[DIAGNOSTIC_LOG_KEY])
        ? stored[DIAGNOSTIC_LOG_KEY]
        : [];
      const next = [...previous, entry].slice(-DIAGNOSTIC_LOG_MAX_ENTRIES);
      await chrome.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: next });
    })
    .catch(() => {});

  return diagnosticLogWriteChain;
}

self.addEventListener('error', (event) => {
  void appendDiagnosticLog('error', 'service-worker-error', event?.error || event?.message);
});

self.addEventListener('unhandledrejection', (event) => {
  void appendDiagnosticLog('error', 'service-worker-unhandledrejection', event?.reason);
});

// 跨设备同步：瘦化版 schedule 写到 chrome.storage.sync。详见 sync-helpers.js 注释。
// 同步对象在 sync 区存储键名，由 background.js 独立维护（与 local.ac_schedule 解耦）。
// lastSyncedAt 用于自回环抑制——Chrome 会把"自己写的 sync"也回灌回本地 onChanged，
// 通过 syncedAt 对比即可识别并静默跳过；本机 watermark 令该边界跨 SW/浏览器
// 重启保持，避免自己的旧安全哨兵回滚后来已提交的正常 phase。
const SYNC_KEY = 'ac_schedule_sync';
const SYNC_WATERMARK_KEY = 'ac_schedule_sync_watermark';
const SYNC_PENDING_PUBLISH_KEY = 'ac_schedule_sync_publish_pending';
let lastSyncedAt = 0;
let syncWatermarkLoaded = false;
let syncWriteChain = Promise.resolve();
let syncWatermarkWriteChain = Promise.resolve();
let syncPublishGeneration = 0;
let syncWriteOperationsInFlight = 0;

let schedule = {
  enabled: false,
  mode: 'pwm',
  clockMode: false,  // v0.5.x 起只保留间隔模式（false）。字段保留向后兼容，UI 不再暴露开关。
  onMinutes: 60,    // 间隔模式下默认开分钟数
  offMinutes: 60,   // 间隔模式下默认关分钟数
  pwmState: 'off',  // 下一次闹钟触发后要切换到的目标状态
  nextTriggerAt: 0,       // 当前阶段的绝对触发时间戳 (ms) — 传统间隔模式唯一真相源
  smartClockPlannedAt: 0, // 当前绝对时钟最初生成时刻；重建 live alarm 时保持不变
  alarmCreatedAt: 0,      // 闹钟创建时的时间戳 (ms) — 时钟模式不使用
  alarmDelayMinutes: 0,   // 闹钟设定的延迟 (分钟) — 时钟模式不使用
  pageTimerMinutes: null,
  pageTimerTargetAt: 0,
  pageTimerError: '',
  pageTimerRetryAt: 0,
  pageTimerRetryMinutes: 0,
  comfortStartUntil: 0,
  comfortStartOnConfirmedAt: 0,
  smartOnBoundaryAt: 0,
  pwmRetryKind: '',
  pwmRetryBoundaryAt: 0,
  pwmRetryScheduledAt: 0,
  activeHours: { enabled: false, start: '08:00', end: '23:00' },  // 两种自动控制共用的运行时段（白名单，同日）
  smartMode: { enabled: false, sensitivity: 5 }  // v0.8.0: 智能模式（天气驱动的开启时长，灵敏度 0~10 档位）
};

let pwmStepRunning = false;
let pwmStepRunningRevision = null;
let pwmRuntimeRevision = 0;
let automaticDisableAdmissionEpoch = 0;
let automaticOnAdmissionBlocked = false;
let syncPhaseAdoptionAdmissionEpoch = 0;
let syncPhaseAdoptionAdmissionOwner = 0;
let activeBoundaryDeferredForPhaseAdoption = false;
let activeBoundaryOwnerReadDeferred = false;
let activeBoundaryMutationChain = Promise.resolve();
let activeBoundaryCompletionGeneration = 0;
let pwmExecutionWithRecoveryCount = 0;
let pwmDiagnosticAttemptSequence = 0;
let activePwmAttempts = new Map();
let currentPwmAttempt = null;
let lastPwmOutcome = null;
let pwmOutcomeWriteGeneration = 0;
let deferredRepairAfterPwmOptions = null;
let scheduleRepairEpoch = 0;
let scheduleLoadBlockedRevision = null;
let lastPwmStepAt = 0;  // A4: 看门狗 cooldown 追踪
let activeAcToggleAttempt = null;
let timerBasedShutdownRevision = 0;

function claimTimerBasedShutdown() {
  timerBasedShutdownRevision += 1;
  return timerBasedShutdownRevision;
}

function invalidateTimerBasedShutdown() {
  timerBasedShutdownRevision += 1;
  return timerBasedShutdownRevision;
}

function isTimerBasedShutdownCurrent(shutdownRevision) {
  return Number.isSafeInteger(shutdownRevision)
    && shutdownRevision === timerBasedShutdownRevision;
}

function isCurrentPwmStepRunning() {
  return pwmStepRunning && pwmStepRunningRevision === pwmRuntimeRevision;
}

function beginPwmDiagnosticAttempt({ source, scheduledTime, automationRevision }) {
  const attempt = {
    attemptId: ++pwmDiagnosticAttemptSequence,
    source: String(source || 'pwm'),
    scheduledAt: Number(scheduledTime) || 0,
    action: schedule.pwmState === 'on' ? 'on' : 'off',
    boundaryAt: Number(schedule.pwmRetryBoundaryAt)
      || Number(schedule.smartOnBoundaryAt)
      || 0,
    retryKind: String(schedule.pwmRetryKind || ''),
    retryScheduledAt: Number(schedule.pwmRetryScheduledAt) || 0,
    automationRevision,
    startedAt: Date.now()
  };
  activePwmAttempts.set(attempt.attemptId, attempt);
  currentPwmAttempt = [...activePwmAttempts.values()]
    .sort((left, right) => left.attemptId - right.attemptId)[0] || null;
  return attempt.attemptId;
}

function getActivePwmDiagnosticAttempts() {
  return [...activePwmAttempts.values()]
    .sort((left, right) => left.attemptId - right.attemptId)
    .slice(0, 8)
    .map(attempt => ({ ...attempt }));
}

function normalizePwmDiagnosticOutcome(value) {
  if (!value || typeof value !== 'object') return null;
  const boundedText = (input, maxLength) => String(input || '').slice(0, maxLength);
  const diagnosticText = (input, maxLength) => (
    typeof normalizeDiagnosticMessage === 'function'
      ? normalizeDiagnosticMessage(input).slice(0, maxLength)
      : boundedText(input, maxLength)
  );
  const finiteNumber = input => Number.isFinite(Number(input)) ? Number(input) : 0;
  const currentBuildTime = typeof BUILD_TIME === 'string' ? BUILD_TIME : 'dev';
  const currentBuildEpoch = typeof BUILD_TIME_EPOCH_MS === 'number'
    ? BUILD_TIME_EPOCH_MS
    : 0;
  const normalized = {
    schemaVersion: typeof PWM_OUTCOME_SCHEMA_VERSION === 'number'
      ? PWM_OUTCOME_SCHEMA_VERSION
      : 1,
    buildTime: Object.hasOwn(value, 'buildTime')
      ? boundedText(value.buildTime, 32)
      : currentBuildTime,
    buildTimeEpochMs: Object.hasOwn(value, 'buildTimeEpochMs')
      ? finiteNumber(value.buildTimeEpochMs)
      : currentBuildEpoch,
    workerStartedAt: Object.hasOwn(value, 'workerStartedAt')
      ? finiteNumber(value.workerStartedAt)
      : (typeof swStartupTime === 'number' ? swStartupTime : 0),
    attemptId: finiteNumber(value.attemptId),
    source: boundedText(value.source, 80),
    scheduledAt: finiteNumber(value.scheduledAt),
    action: value.action === 'off' ? 'off' : 'on',
    boundaryAt: finiteNumber(value.boundaryAt),
    retryKind: boundedText(value.retryKind, 80),
    retryScheduledAt: finiteNumber(value.retryScheduledAt),
    automationRevision: finiteNumber(value.automationRevision),
    startedAt: finiteNumber(value.startedAt),
    finishedAt: finiteNumber(value.finishedAt),
    status: boundedText(value.status, 40),
    reason: boundedText(value.reason, 160),
    error: diagnosticText(value.error, 300),
    nextTriggerAt: finiteNumber(value.nextTriggerAt),
    retryBoundaryAt: finiteNumber(value.retryBoundaryAt),
    pageTimerTargetAt: finiteNumber(value.pageTimerTargetAt),
    pageTimerError: diagnosticText(value.pageTimerError, 300)
  };
  return normalized.finishedAt > 0 ? normalized : null;
}

function selectLatestPwmDiagnosticOutcome(memoryOutcome, persistedOutcome) {
  const memory = normalizePwmDiagnosticOutcome(memoryOutcome);
  const persisted = normalizePwmDiagnosticOutcome(persistedOutcome);
  if (!memory) return persisted;
  if (!persisted) return memory;
  return persisted.finishedAt > memory.finishedAt ? persisted : memory;
}

async function readPersistedPwmDiagnosticOutcome() {
  try {
    const stored = await chrome.storage.local.get(PWM_LAST_OUTCOME_KEY);
    const outcome = normalizePwmDiagnosticOutcome(stored?.[PWM_LAST_OUTCOME_KEY]);
    if (!outcome) return null;
    if (outcome.buildTimeEpochMs !== BUILD_TIME_EPOCH_MS
        || outcome.buildTime !== BUILD_TIME) return null;
    return outcome;
  } catch (_) {
    return null;
  }
}

async function persistPwmDiagnosticOutcomeBestEffort(outcome) {
  const normalized = normalizePwmDiagnosticOutcome(outcome);
  if (!normalized) return false;
  let observedGeneration = ++pwmOutcomeWriteGeneration;
  let candidate = normalized;
  try {
    // 每次写完成后都重检 generation。一次性纠偏仍可能被第三代结果穿插：
    // A 补写 B 时 C 已落盘，迟到的 B 会再次覆盖 C。循环直到“本次写对应的
    // generation 仍是当前值”，才能保证最后完成的旧 writer 也把最新内存结果盖回。
    while (true) {
      await chrome.storage.local.set({ [PWM_LAST_OUTCOME_KEY]: candidate });
      if (observedGeneration === pwmOutcomeWriteGeneration) return true;
      observedGeneration = pwmOutcomeWriteGeneration;
      candidate = normalizePwmDiagnosticOutcome(lastPwmOutcome);
      if (!candidate) return false;
    }
  } catch (error) {
    console.warn('[AC扩展] 最近 PWM 结果持久化失败:', error?.message || error);
    return false;
  }
}

async function waitForPwmDiagnosticOutcomePersistence(
  outcome,
  timeoutMs = 250
) {
  const persistence = persistPwmDiagnosticOutcomeBestEffort(outcome);
  try {
    return await Promise.race([
      persistence,
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
    ]);
  } catch (_) {
    return false;
  }
}

function finishPwmDiagnosticAttempt(attemptId, status, reason = '', error = '') {
  const attempt = activePwmAttempts.get(attemptId);
  if (!attempt) return null;
  lastPwmOutcome = normalizePwmDiagnosticOutcome({
    ...attempt,
    finishedAt: Date.now(),
    status: String(status || 'unknown'),
    reason: String(reason || ''),
    error: String(error || ''),
    nextTriggerAt: Number(schedule.nextTriggerAt) || 0,
    retryKind: String(schedule.pwmRetryKind || ''),
    retryBoundaryAt: Number(schedule.pwmRetryBoundaryAt) || 0,
    retryScheduledAt: Number(schedule.pwmRetryScheduledAt) || 0,
    pageTimerTargetAt: Number(schedule.pageTimerTargetAt) || 0,
    pageTimerError: String(schedule.pageTimerError || '')
  });
  activePwmAttempts.delete(attemptId);
  currentPwmAttempt = [...activePwmAttempts.values()]
    .sort((left, right) => left.attemptId - right.attemptId)[0] || null;
  return lastPwmOutcome ? { ...lastPwmOutcome } : null;
}

function inferPwmDiagnosticOutcomeStatus() {
  if (schedule.pwmRetryKind === 'smart-on-safety-skip') return 'deferred';
  if (schedule.pageTimerError && Number(schedule.nextTriggerAt) > Date.now()) {
    return 'retry-scheduled';
  }
  return 'settled';
}

function claimPwmStepOwnership() {
  const automationRevision = pwmRuntimeRevision += 1;
  pwmStepRunning = true;
  pwmStepRunningRevision = automationRevision;
  return automationRevision;
}

function claimSyncPhaseAdoptionAdmission() {
  if (syncPhaseAdoptionAdmissionOwner > 0) return 0;
  const admissionEpoch = ++syncPhaseAdoptionAdmissionEpoch;
  syncPhaseAdoptionAdmissionOwner = admissionEpoch;
  return admissionEpoch;
}

function releaseSyncPhaseAdoptionAdmission(admissionEpoch) {
  if (syncPhaseAdoptionAdmissionOwner !== admissionEpoch) return false;
  syncPhaseAdoptionAdmissionOwner = 0;
  return true;
}

function isSyncPhaseAdoptionAdmissionBlocked() {
  return syncPhaseAdoptionAdmissionOwner > 0;
}

function isSyncPhaseAdoptionAdmissionBlockedFor(admissionEpoch = 0) {
  return syncPhaseAdoptionAdmissionOwner > 0
    && syncPhaseAdoptionAdmissionOwner !== Number(admissionEpoch);
}

function mergeScheduleRepairOptions(previous = {}, options = {}) {
  const previousOptions = previous && typeof previous === 'object'
    ? previous
    : {};
  const incomingOptions = options && typeof options === 'object'
    ? options
    : {};
  const previousBoundaryAt = Number(previousOptions.smartOnExpectedBoundaryAt) || 0;
  const incomingBoundaryAt = Number(incomingOptions.smartOnExpectedBoundaryAt) || 0;
  const incomingRevoke = incomingOptions.revokeInvalidSmartOnClock === true;
  const previousRevoke = previousOptions.revokeInvalidSmartOnClock === true;
  return {
    ...previousOptions,
    ...incomingOptions,
    // 后到的普通 repair 不得擦掉已从错误智能钟提取出的可信半点。
    smartOnExpectedBoundaryAt: incomingBoundaryAt || previousBoundaryAt,
    revokeInvalidSmartOnClock: incomingRevoke || previousRevoke,
    revokeOwnerRevision: incomingRevoke
        && Number.isSafeInteger(incomingOptions.revokeOwnerRevision)
      ? incomingOptions.revokeOwnerRevision
      : previousOptions.revokeOwnerRevision,
    preserveRevokeAcrossSupersededRepair:
      incomingOptions.preserveRevokeAcrossSupersededRepair === true
      || previousOptions.preserveRevokeAcrossSupersededRepair === true,
    discardStaleRevoke: incomingOptions.discardStaleRevoke === true
      || previousOptions.discardStaleRevoke === true
  };
}

function queueDeferredScheduleRepair(options = {}) {
  deferredRepairAfterPwmOptions = {
    ...mergeScheduleRepairOptions(deferredRepairAfterPwmOptions, options),
    queuedAutomationRevision: pwmRuntimeRevision
  };
  return deferredRepairAfterPwmOptions;
}

function normalizeDeferredScheduleRepairOptions(queued = {}) {
  const options = { ...queued };
  delete options.queuedAutomationRevision;
  if (options.revokeInvalidSmartOnClock === true) {
    const revokeOwnerRevision = Number(options.revokeOwnerRevision);
    if (!Number.isSafeInteger(revokeOwnerRevision)
        || revokeOwnerRevision !== pwmRuntimeRevision) {
      // invalid-clock 的判断只能撤销同一 automation revision 的钟。若队列
      // 等待期间 sync/page timer 已接管新 phase，旧判断随 owner 一起失效。
      options.revokeInvalidSmartOnClock = false;
      options.smartOnExpectedBoundaryAt = 0;
      options.discardStaleRevoke = true;
      return options;
    }
  }
  const expectedBoundaryAt = Number(options.smartOnExpectedBoundaryAt) || 0;
  if (expectedBoundaryAt <= 0) return options;

  const retryContext = getActiveSmartOnPwmRetryContext(
    schedule,
    Number(schedule.nextTriggerAt) || 0
  );
  const currentClockAssessment = classifySmartOnClock(
    schedule,
    Number(schedule.nextTriggerAt) || 0,
    {
      now: Date.now(),
      plannedAt: Number(schedule.smartClockPlannedAt)
        || Number(schedule.alarmCreatedAt)
        || 0,
      nextAction: schedule.pwmState,
      toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
      requirePlannedAt: true
    }
  );
  const stillOwned = Number(schedule.smartOnBoundaryAt) === expectedBoundaryAt
    || Number(retryContext.boundaryAt) === expectedBoundaryAt
    || Number(currentClockAssessment?.expectedAt) === expectedBoundaryAt;
  if (options.revokeInvalidSmartOnClock === true
      && (!currentClockAssessment.applicable
        || currentClockAssessment.valid)
      && options.preserveRevokeAcrossSupersededRepair !== true) {
    // 同一 revision 的 PWM executor 可能在 repair 排队期间已经提交合法新钟，
    // 或已推进成下一步 OFF（不再属于“非法智能 ON 钟”）；只有明确抢占了
    // 旧 generic repair 的 revoke 才可跨过该中间提交。
    options.revokeInvalidSmartOnClock = false;
    options.smartOnExpectedBoundaryAt = 0;
    options.discardStaleRevoke = true;
    return options;
  }
  if (!stillOwned && options.revokeInvalidSmartOnClock !== true) {
    options.smartOnExpectedBoundaryAt = 0;
  }
  return options;
}

function drainDeferredScheduleRepair(reason = '') {
  if (pwmExecutionWithRecoveryCount > 0
      || isSyncPhaseAdoptionAdmissionBlocked()
      || !deferredRepairAfterPwmOptions) return false;
  const queued = deferredRepairAfterPwmOptions;
  deferredRepairAfterPwmOptions = null;
  const options = normalizeDeferredScheduleRepairOptions(queued);
  void waitUntil(repairScheduleClock(options)).catch((error) => {
    console.warn(`[AC扩展] 延迟时钟修复失败${reason ? ` (${reason})` : ''}:`, error?.message);
    void appendDiagnosticLog('warn', 'deferred-schedule-repair', error);
  });
  return true;
}

function releasePwmStepOwnership(automationRevision) {
  if (pwmStepRunningRevision !== automationRevision) return false;
  lastPwmStepAt = Date.now();
  pwmStepRunning = false;
  pwmStepRunningRevision = null;
  if (smartReapplyPending && !smartReapplyInFlight) {
    void waitUntil(runSmartReapplyLoop());
  }
  return true;
}

const AUTOMATION_RUNTIME_ALARMS = new Set([
  'ac-pwm',
  'ac-badge-tick',
  'ac-watchdog',
  COMFORT_START_END_ALARM
]);

const PWM_TRIGGER_STRICT_OPTIONS = Object.freeze({
  nextTriggerToleranceMs: 0,
  legacyTriggerToleranceMs: 1500,
  requireLegacyAlignment: true
});
const PWM_TRIGGER_NEXT_ONLY_OPTIONS = Object.freeze({
  nextTriggerToleranceMs: 1500,
  requireLegacyAlignment: false
});
const PWM_TRIGGER_SNAPSHOT_OPTIONS = Object.freeze({
  ...PWM_TRIGGER_NEXT_ONLY_OPTIONS,
  allowDisabled: true
});

// ===== 五分钟舒适启动（仅 false→true / 首次安装） =====
// 这是本机运行态，不进入 chrome.storage.sync。它临时越过 active-hours 门禁，
// 但不绕过任何页面安全条件：ON 仍必须经唯一 toggleAC 链确认新的
// `Execution succeeded`；Power-off after 仍必须经独立新鲜页读回。
function isComfortStartActive(now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const until = Number(schedule.comfortStartUntil) || 0;
  return schedule.enabled === true
    && Number.isFinite(nowMs)
    && until > nowMs;
}

async function scheduleComfortStartEndAlarm() {
  await chrome.alarms.clear('ac-comfort-end');
  const until = Number(schedule.comfortStartUntil) || 0;
  if (!isComfortStartActive() || until <= Date.now()) return false;
  return createAlarm(COMFORT_START_END_ALARM, { when: until });
}

// ac-pwm 两次创建都失败时，用独立 comfort alarm 保住同一重试时刻。
// alarm handler 在 marker 尚未到期时会重新进入 runComfortStart('retry')；
// 到期时则进入 finishComfortStart，不会把舒适期无限延长。
async function scheduleComfortRetryFallback(retryAt) {
  await chrome.alarms.clear(COMFORT_START_END_ALARM);
  const when = Number(retryAt);
  const until = Number(schedule.comfortStartUntil) || 0;
  if (!isComfortStartActive()
      || !Number.isFinite(when)
      || when <= Date.now()
      || when > until) return false;
  return createAlarm(COMFORT_START_END_ALARM, { when });
}

async function deferComfortFinish(
  error,
  automationRevision,
  priorConfirmedAt = 0
) {
  if (automationRevision !== pwmRuntimeRevision || !schedule.enabled) {
    return { handled: false, automationAllowed: false, error: error?.message || String(error) };
  }

  const retryAt = Date.now() + COMFORT_START_RETRY_MS;
  schedule.comfortStartUntil = retryAt;
  schedule.comfortStartOnConfirmedAt = Number(priorConfirmedAt) || 0;
  schedule.pageTimerError = `五分钟舒适启动结束处理失败：${error?.message || String(error)}；1 分钟后重试`;
  setNextTriggerAt(retryAt);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  let intentPersisted = false;
  let recoveryPersistError = null;
  try {
    await persistSchedule('comfort-finish-retry-intent', { syncFromLiveAlarm: false });
    intentPersisted = true;
  } catch (persistError) {
    // storage 瞬断时仍继续建立 live 恢复钟；否则 reset 已清完所有 alarm，
    // 外层若用旧 revision 判 stale 会留下 ON 且完全无恢复入口。
    recoveryPersistError = persistError;
    schedule.pageTimerError += `；恢复意图写入失败：${persistError?.message || String(persistError)}`;
  }
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { handled: false, automationAllowed: false, cancelled: true };
  }

  let alarmCreated = false;
  try {
    alarmCreated = await createPwmAlarmFromPlan(
      { nextTriggerAt: retryAt },
      'comfort-finish-retry',
      automationRevision
    );
  } catch (alarmError) {
    recoveryPersistError ||= alarmError;
  }
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { handled: false, automationAllowed: false, cancelled: true };
  }
  let fallbackCreated = false;
  if (!alarmCreated) {
    try {
      fallbackCreated = await scheduleComfortRetryFallback(retryAt);
    } catch (fallbackError) {
      recoveryPersistError ||= fallbackError;
    }
  }
  if (!alarmCreated) {
    schedule.pageTimerError += fallbackCreated
      ? '；PWM 主闹钟创建失败，已改用舒适恢复闹钟'
      : '；恢复闹钟创建失败，等待 Service Worker 重启恢复 durable intent';
  }
  const badgeCreated = await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  const watchdogCreated = await createAlarm('ac-watchdog', { periodInMinutes: 5 });
  try {
    await persistSchedule(
      alarmCreated ? 'comfort-finish-retry' : 'comfort-finish-retry-alarm-failed',
      { syncFromLiveAlarm: false }
    );
    intentPersisted = true;
  } catch (persistError) {
    recoveryPersistError ||= persistError;
  }
  try {
    await updateBadge();
  } catch (badgeError) {
    recoveryPersistError ||= badgeError;
  }
  void appendDiagnosticLog('warn', 'comfort-finish', new Error(schedule.pageTimerError));
  if (!intentPersisted && !alarmCreated && !fallbackCreated && !watchdogCreated) {
    throw tagPwmAutomationError(
      recoveryPersistError || new Error('五分钟舒适启动结束恢复无持久状态或恢复闹钟'),
      automationRevision,
      null
    );
  }
  return {
    handled: true,
    active: true,
    automationAllowed: true,
    deferred: true,
    retryAt: alarmCreated ? schedule.nextTriggerAt : retryAt,
    fallbackCreated,
    badgeCreated,
    watchdogCreated,
    intentPersisted
  };
}

async function finishComfortStart(reason = '') {
  let automationRevision = pwmRuntimeRevision;
  const until = Number(schedule.comfortStartUntil) || 0;
  if (!until) {
    await chrome.alarms.clear('ac-comfort-end');
    return {
      handled: false,
      automationAllowed: isAutomationOperationCurrent(automationRevision),
      automationRevision
    };
  }

  if (Date.now() + 1000 < until) {
    await scheduleComfortStartEndAlarm();
    return {
      handled: true,
      active: true,
      automationAllowed: isAutomationOperationCurrent(automationRevision),
      automationRevision
    };
  }

  const priorConfirmedAt = Number(schedule.comfortStartOnConfirmedAt) || 0;
  try {
    schedule.comfortStartUntil = 0;
    schedule.comfortStartOnConfirmedAt = 0;
    await chrome.alarms.clear('ac-comfort-end');
    if (!schedule.enabled) {
      await persistSchedule(`comfort-start-ended-${reason || 'disabled'}`, {
        syncFromLiveAlarm: false
      });
      return { handled: true, automationAllowed: false };
    }

    if (!isWithinActiveHours()) {
      // resetDisabledPwmRuntime 会在任何 await 前先 claim 新 revision。即使它在
      // 后续清钟/更新 badge 时抛错，结束恢复也必须沿用这个新 owner，不能拿
      // 入场时的旧 revision 被误判 stale 后丢失恢复时钟。
      try {
        await resetDisabledPwmRuntime();
      } finally {
        automationRevision = pwmRuntimeRevision;
      }
      await persistSchedule('comfort-start-ended-outside-hours-pre-shutdown', {
        syncFromLiveAlarm: false
      });
      const shutdownResult = await requestTimerBasedShutdown('comfort-start-ended-outside-hours');
      if (!shutdownResult?.success) {
        schedule.pageTimerError = `五分钟舒适启动结束后页面关机定时器未确认：${shutdownResult?.error || '未知错误'}`;
        await persistSchedule('comfort-start-ended-outside-hours-failed', {
          syncFromLiveAlarm: false
        });
      }
      await rescheduleSmartWeatherAlarm();
      return { handled: true, automationAllowed: false, shutdownResult };
    }

    await persistSchedule(`comfort-start-ended-${reason || 'inside-hours'}`, {
      syncFromLiveAlarm: false
    });
    if (!isAutomationOperationCurrent(automationRevision)) {
      return {
        handled: false,
        automationAllowed: false,
        cancelled: true,
        automationRevision
      };
    }
    return { handled: true, automationAllowed: true, automationRevision };
  } catch (error) {
    console.warn('[AC扩展] 五分钟舒适启动结束事务失败，安排一分钟恢复:', error?.message);
    void appendDiagnosticLog('warn', 'comfort-finish-transition', error);
    return deferComfortFinish(error, automationRevision, priorConfirmedAt);
  }
}

// 舒适 retry 可能在页面确认的长 await 中跨过截止点。此时 retry 会因
// marker 到期而 cancelled；必须立刻完成 finish 事务，不能把已消费的 alarm
// 当作成功处理后留下 nextTriggerAt=0。
async function retryComfortStartAndFinishIfExpired(reason = 'retry') {
  let retryResult = null;
  let retryError = null;
  try {
    retryResult = await runComfortStart(reason);
  } catch (error) {
    retryError = error;
  }
  const expiredMarker = Number(schedule.comfortStartUntil) > 0
    && !isComfortStartActive();
  const retryOwnedUntil = Math.max(
    Number(retryResult?.retryAt) || 0,
    Number(schedule.nextTriggerAt) || 0
  );
  // 跨 T 后 defer 既可能返回 cancelled（时段外），也可能在时段内返回
  // success:false + retryAt=0；两者只要没有未来恢复 ownership 都必须 finish。
  if (schedule.enabled && expiredMarker && (
    retryError
    || (retryResult?.success !== true && retryOwnedUntil <= Date.now())
  )) {
    const finishResult = await finishComfortStart(`${reason}-expired`);
    return {
      retryResult,
      retryError,
      finishResult,
      crossedDeadline: true,
      continuePwm: finishResult?.handled === true
        && finishResult?.automationAllowed === true
        && finishResult?.deferred !== true,
      continuationAutomationRevision:
        Number.isSafeInteger(finishResult?.automationRevision)
          ? finishResult.automationRevision
          : null
    };
  }
  if (retryError) throw retryError;
  return { retryResult, crossedDeadline: false, continuePwm: false };
}

function shouldResumePwmAfterComfortFinish(finishResult, futureMainClockAt = 0) {
  return !(Number(futureMainClockAt) > 0)
    && finishResult?.handled === true
    && finishResult?.automationAllowed === true
    && finishResult?.deferred !== true;
}

async function deferComfortStart(error, automationRevision) {
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }

  const now = Date.now();
  const until = Number(schedule.comfortStartUntil) || 0;
  const retryAt = Math.min(now + COMFORT_START_RETRY_MS, until || (now + COMFORT_START_RETRY_MS));
  schedule.pwmState = 'on';
  schedule.pageTimerError = `五分钟舒适启动未确认：${error || '未知错误'}；1 分钟后重试`;
  setNextTriggerAt(retryAt > now ? retryAt : 0);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  // retryAt 是建 live alarm 前的 durable intent；create=false 或 SW 中断后，
  // startup recovery 仍能认领同一舒适事务，不会只剩误导性的文案。
  await persistSchedule('comfort-start-retry-intent', { syncFromLiveAlarm: false });
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  const alarmCreated = retryAt > now
    ? await createPwmAlarmFromPlan(
      { nextTriggerAt: retryAt },
      'comfort-start-retry',
      automationRevision
    )
    : false;
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  let fallbackCreated = false;
  if (alarmCreated) {
    await scheduleComfortStartEndAlarm();
  } else {
    fallbackCreated = await scheduleComfortRetryFallback(retryAt);
  }
  if (!alarmCreated) {
    schedule.pageTimerError += fallbackCreated
      ? '；PWM 主闹钟创建失败，已改用舒适恢复闹钟'
      : '；恢复闹钟创建失败，等待 Service Worker 重启恢复 durable intent';
  }
  if (alarmCreated) await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  await persistSchedule('comfort-start-retry', { syncFromLiveAlarm: false });
  await updateBadge();
  void appendDiagnosticLog('warn', 'comfort-start', new Error(schedule.pageTimerError));
  return {
    success: false,
    error: schedule.pageTimerError,
    retryAt: alarmCreated
      ? schedule.nextTriggerAt
      : (fallbackCreated ? retryAt : 0),
    fallbackCreated,
    minimumMinutes: COMFORT_START_MINUTES
  };
}

async function runComfortStart(reason = 'user-enable') {
  if (!schedule.enabled) {
    return { success: false, cancelled: true, error: '自动控制未启用' };
  }

  const now = Date.now();
  const existingMinimumTargetAt = Number(schedule.comfortStartUntil) || 0;
  const existingOnConfirmedAt = Number(schedule.comfortStartOnConfirmedAt) || 0;
  const restoreExistingMinimum = (reason === 'retry' || reason === 'startup-recovery')
    && existingMinimumTargetAt > now;
  const reuseConfirmedMinimum = restoreExistingMinimum && existingOnConfirmedAt > 0;
  let provisionalPlan = planComfortStart({}, null, {
    now,
    minutes: COMFORT_START_MINUTES,
    ...(restoreExistingMinimum ? { minimumTargetAt: existingMinimumTargetAt } : {})
  });

  pwmRuntimeRevision += 1;
  const automationRevision = pwmRuntimeRevision;
  invalidateTimerBasedShutdown();
  clearPwmRetryState();
  schedule.comfortStartUntil = provisionalPlan.minimumTargetAt;
  if (!restoreExistingMinimum) schedule.comfortStartOnConfirmedAt = 0;
  schedule.pwmState = 'on';
  setNextTriggerAt(0);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
  await cancelAutomaticOnRequests();
  if (activeAcToggleAttempt?.promise) {
    await activeAcToggleAttempt.promise.catch(() => {});
  }
  await clearPwmAlarm(automationRevision);
  await chrome.alarms.clear('ac-page-timer-retry');
  await chrome.alarms.clear('ac-comfort-end');
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  await persistSchedule(`comfort-start-${reason}-claim`, { syncFromLiveAlarm: false });

  // OFF 页面先读取当前 picker，预置时保留用户已有的更晚关机目标；随后
  // toggleAC 把预置、ON 与新鲜页确认锁在同一 tab 事务中。
  const pageTimerBeforeOn = await getCurrentPageTimer();
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  provisionalPlan = planComfortStart(schedule, pageTimerBeforeOn, {
    now: Date.now(),
    minutes: COMFORT_START_MINUTES,
    minimumTargetAt: schedule.comfortStartUntil
  });

  const toggleResult = await toggleAC('on', {
    notAfterAt: schedule.comfortStartUntil,
    requireAutomationAllowed: true,
    automationRevision,
    pageTimerMinutes: provisionalPlan.timerMinutes,
    pageTimerTargetAt: provisionalPlan.targetAt
  });
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  if (!toggleResult?.success) {
    return deferComfortStart(
      toggleResult?.error || '页面未确认新的 Execution succeeded',
      automationRevision
    );
  }

  // 新点击必须先等 Execution succeeded + ON 收敛；已经 ON 则由 toggleAC
  // 幂等预检零点击成功。两条路径到这里才允许读取并设置 Power-off after。
  const confirmedAt = Date.now();
  if (!reuseConfirmedMinimum) {
    const confirmedFloorPlan = planComfortStart({}, null, {
      now: confirmedAt,
      minutes: COMFORT_START_MINUTES
    });
    schedule.comfortStartOnConfirmedAt = confirmedAt;
    // 在下一次页面 await 前立即换成“确认 ON 后五分钟”的 floor。否则 ON 若在
    // 原尝试窗口末尾才收敛，getPageTimer 的几秒等待会被旧截止误判为失效。
    schedule.comfortStartUntil = confirmedFloorPlan.minimumTargetAt;
  }
  await persistSchedule(`comfort-start-${reason}-confirmed-on`, {
    syncFromLiveAlarm: false
  });
  const pageTimerInput = await getCurrentPageTimer();
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  const comfortPlan = planComfortStart(schedule, pageTimerInput, {
    now: confirmedAt,
    minutes: COMFORT_START_MINUTES,
    ...(reuseConfirmedMinimum ? { minimumTargetAt: existingMinimumTargetAt } : {})
  });
  schedule.comfortStartUntil = comfortPlan.minimumTargetAt;

  const timerResult = comfortPlan.reuseFreshProof
    ? {
      success: true,
      alreadyArmed: true,
      targetAt: comfortPlan.targetAt,
      actualDelayMinutes: comfortPlan.timerMinutes
    }
    : await setPageTimer(comfortPlan.timerMinutes, {
      retryOnFailure: false,
      targetAt: comfortPlan.targetAt,
      automationRevision
    });
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  if (!timerResult?.success) {
    return deferComfortStart(
      timerResult?.error || 'Power-off after 新鲜页验证失败',
      automationRevision
    );
  }

  schedule.pwmState = 'off';
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
  const alarmCreated = await createPwmAlarmFromPlan(
    { nextTriggerAt: comfortPlan.targetAt },
    'comfort-start-complete',
    automationRevision
  );
  if (!alarmCreated) {
    return deferComfortStart('PWM 主闹钟创建失败', automationRevision);
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await createAlarm('ac-watchdog', { periodInMinutes: 5 });
  if (comfortPlan.targetAt > comfortPlan.minimumTargetAt + 1000) {
    await scheduleComfortStartEndAlarm();
  } else {
    await chrome.alarms.clear('ac-comfort-end');
  }
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  await persistSchedule(`comfort-start-${reason}-complete`, {
    syncFromLiveAlarm: false
  });
  await updateBadge();
  return {
    success: true,
    alreadyOn: toggleResult.alreadyDone === true,
    targetAt: comfortPlan.targetAt,
    minimumTargetAt: comfortPlan.minimumTargetAt,
    preservedLaterTimer: comfortPlan.targetAt > comfortPlan.minimumTargetAt,
    minimumMinutes: COMFORT_START_MINUTES
  };
}

function preemptAutomaticOnForExplicitDisable() {
  const admissionEpoch = ++automaticDisableAdmissionEpoch;
  // 让任何已捕获旧 enabled payload 的 outbound 失去清理 marker/alarm
  // 的资格；否则旧写完成可擦掉刚落地的 disable publish intent。
  syncPublishGeneration += 1;
  automaticOnAdmissionBlocked = true;
  pwmRuntimeRevision += 1;
  schedule.comfortStartUntil = 0;
  schedule.comfortStartOnConfirmedAt = 0;
  invalidateTimerBasedShutdown();
  return admissionEpoch;
}

async function finishExplicitDisablePreemption() {
  const preemptSteps = [
    ['clear-comfort-end', () => chrome.alarms.clear('ac-comfort-end')],
    ['cancel-automatic-on', () => cancelAutomaticOnRequests()]
  ];
  await Promise.all(preemptSteps.map(async ([step, operation]) => {
    try {
      await operation();
    } catch (error) {
      console.warn(`[AC扩展] 明确停用预清理失败（${step}），继续持久化停用`, error);
      void appendDiagnosticLog('warn', `explicit-disable-${step}`, error);
    }
  }));
}

function releaseExplicitDisableAdmission(admissionEpoch) {
  if (admissionEpoch === automaticDisableAdmissionEpoch) {
    automaticOnAdmissionBlocked = false;
  }
}

// ===== Active Hours（两种自动控制共用的运行时段白名单） =====
// 启用后：在 [start, end) 时段内允许循环定时或智能控制运行；时段外暂停自动执行。
// 同日时段（start < end 强制）。跨日场景用户应该用反向设置（如 23:00-07:00 关 = 07:00-23:00 开）。
function parseHHMM(s) {
  if (typeof s !== 'string') return -1;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

function isWithinActiveHoursForSchedule(scheduleSnapshot, now = new Date()) {
  const ah = scheduleSnapshot?.activeHours;
  if (!ah || !ah.enabled) return true;  // 未启用 = 永远在时段内
  const start = parseHHMM(ah.start);
  const end = parseHHMM(ah.end);
  if (start < 0 || end < 0 || start >= end) return false;  // 非法配置安全暂停，等待用户修正
  const curMin = now.getHours() * 60 + now.getMinutes();
  return curMin >= start && curMin < end;
}

function isWithinActiveHours(now = new Date()) {
  return isWithinActiveHoursForSchedule(schedule, now);
}

function isAutomationAllowedForSchedule(scheduleSnapshot, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const comfortActive = Number.isFinite(nowMs)
    && Number(scheduleSnapshot?.comfortStartUntil) > nowMs;
  return scheduleSnapshot?.enabled === true
    && (isWithinActiveHoursForSchedule(scheduleSnapshot, now) || comfortActive);
}

function isAutomationAllowed(now = new Date()) {
  return !automaticOnAdmissionBlocked
    && isAutomationAllowedForSchedule(schedule, now);
}

function isAutomationOperationCurrent(automationRevision) {
  return Number.isSafeInteger(automationRevision)
    && automationRevision === pwmRuntimeRevision
    && isAutomationAllowed();
}

async function abortStaleAutomation(automationRevision, reason) {
  if (isAutomationOperationCurrent(automationRevision)) return false;
  if (schedule.enabled && !isWithinActiveHours()) {
    console.warn(`[AC扩展] ${reason}: 自动操作跨越运行时段边界，重新执行暂停关机`);
    await onActiveBoundaryCrossed();
  }
  return true;
}

// 返回下一次状态切换的时间戳（ms）。返回 0 表示无需调度（未启用或非法）。
function getNextActiveBoundary(now = new Date()) {
  const ah = schedule.activeHours;
  if (!ah || !ah.enabled) return 0;
  const start = parseHHMM(ah.start);
  const end = parseHHMM(ah.end);
  if (start < 0 || end < 0 || start >= end) return 0;
  const curMin = now.getHours() * 60 + now.getMinutes();

  // 找下一个 end（退出运行时段）
  let nextEnd = new Date(now);
  nextEnd.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (curMin >= end) nextEnd.setDate(nextEnd.getDate() + 1);

  // 找下一个 start（进入运行时段）
  let nextStart = new Date(now);
  nextStart.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (curMin >= start) nextStart.setDate(nextStart.getDate() + 1);

  return nextStart.getTime() < nextEnd.getTime() ? nextStart.getTime() : nextEnd.getTime();
}

function getAutomaticOnDeadline(requestedDeadline = 0, now = new Date()) {
  const nowMs = now.getTime();
  const requested = Number(requestedDeadline);
  let deadline = Number.isSafeInteger(requested) && requested > 0
    ? requested
    : 0;

  if (!isComfortStartActive(now)
      && schedule.activeHours?.enabled && isWithinActiveHours(now)) {
    const activeBoundaryAt = getNextActiveBoundary(now);
    if (activeBoundaryAt > nowMs) {
      deadline = deadline > 0
        ? Math.min(deadline, activeBoundaryAt)
        : activeBoundaryAt;
    }
  }

  return deadline;
}

function normalizeActiveBoundaryRetryMode(mode, retryAt = 0) {
  if (mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE) {
    return ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE;
  }
  return retryAt > 0 ? ACTIVE_BOUNDARY_RETRY_MODE_ACTION : '';
}

async function readDurableActiveBoundaryRetry() {
  try {
    const stored = await chrome.storage.local.get([
      ACTIVE_BOUNDARY_RETRY_KEY,
      ACTIVE_BOUNDARY_RETRY_MODE_KEY,
      ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY
    ]);
    const retryAt = Number(stored?.[ACTIVE_BOUNDARY_RETRY_KEY]) || 0;
    return {
      retryAt,
      mode: normalizeActiveBoundaryRetryMode(
        stored?.[ACTIVE_BOUNDARY_RETRY_MODE_KEY],
        retryAt
      ),
      boundaryAt: Number(stored?.[ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]) || 0,
      readOk: true
    };
  } catch (error) {
    console.warn('[AC扩展] 读取 active-boundary 重试标记失败:', error?.message);
    return { retryAt: 0, mode: '', boundaryAt: 0, readOk: false };
  }
}

async function readDurableActiveBoundaryRetryAt() {
  return (await readDurableActiveBoundaryRetry()).retryAt;
}

async function createActiveBoundaryAlarmWithRetry(when, options = {}) {
  const alarmName = options.alarmName
    || (options.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
      ? ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM
      : 'ac-active-boundary');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createAlarm(alarmName, { when })) {
      try {
        const verified = await chrome.alarms.get(alarmName);
        if (Math.abs(Number(verified?.scheduledTime) - Number(when))
            <= PWM_RETRY_ALARM_TOLERANCE_MS) return true;
      } catch (_) { /* retry below */ }
    }
    if (attempt === 0) {
      // 第一次 create 成功但紧接着 get 未见的 API 瞬断，给同一
      // event promise 一次短重试；不依赖会被 SW 回收的裸 setTimeout。
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}

function runSerializedActiveBoundaryMutation(operation) {
  const queued = activeBoundaryMutationChain
    .catch(() => {})
    .then(operation);
  activeBoundaryMutationChain = queued.catch(() => {});
  return queued;
}

async function armActiveBoundaryOwnerReadRetryUnsafe(reason = 'owner-read') {
  const retryAt = Date.now() + ACTIVE_BOUNDARY_RETRY_MS;
  activeBoundaryOwnerReadDeferred = true;
  if (!await createActiveBoundaryAlarmWithRetry(retryAt, {
    alarmName: ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM
  })) {
    throw new Error('ac-active-boundary owner-read 重试钟创建后验证失败');
  }
  console.warn(`[AC扩展] ${reason}，1 分钟后只重读 active-boundary owner`);
  return retryAt;
}

async function armActiveBoundaryRetryUnsafe(
  reason = 'phase-adoption',
  options = {}
) {
  const retryAt = Date.now() + ACTIVE_BOUNDARY_RETRY_MS;
  const retryMode = options.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
    ? ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
    : ACTIVE_BOUNDARY_RETRY_MODE_ACTION;
  const retryBoundaryAt = retryMode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
    ? Number(options.boundaryAt) || 0
    : 0;
  activeBoundaryDeferredForPhaseAdoption = true;
  try {
    // 独立 key 避免在 phase reservation 中用整个 schedule 覆盖新 owner。
    // mode 与 at 同批落盘：动作已经成功时，下一次只能补自然钟，绝不能
    // 重新执行 setupAlarms(true) 后移已建立的 PWM owner。
    await chrome.storage.local.set({
      [ACTIVE_BOUNDARY_RETRY_KEY]: retryAt,
      [ACTIVE_BOUNDARY_RETRY_MODE_KEY]: retryMode,
      [ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]: retryBoundaryAt
    });
  } catch (error) {
    // live alarm 仍是跨 SW 的第二道证据；本次不因 marker 瞬断放弃建钟。
    console.warn('[AC扩展] 写入 active-boundary 重试标记失败:', error?.message);
  }
  // alarm 名自身也编码 retry kind：即使 storage mode 本次写/读失败，
  // schedule-only delivery 仍无法降级成 action 并重跑边界动作。
  try {
    await Promise.all([
      chrome.alarms.clear(
        retryMode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
          ? 'ac-active-boundary'
          : ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM
      ),
      chrome.alarms.clear(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM)
    ]);
  } catch (_) { /* the typed alarm remains authoritative */ }
  if (!await createActiveBoundaryAlarmWithRetry(retryAt, { mode: retryMode })) {
    // marker 故意保留，下次 init/任意扩展事件会再尝试恢复；
    // 当前 handler 必须报失败，不能把“有 marker 无唤醒钟”当成已收口。
    throw new Error('ac-active-boundary 重试闹钟创建后验证失败');
  }
  activeBoundaryOwnerReadDeferred = false;
  console.warn(`[AC扩展] ${reason} 尚未收口，1 分钟后重试 ac-active-boundary`);
  return retryAt;
}

async function clearActiveBoundaryRetryMarkerUnsafe() {
  try {
    await chrome.storage.local.set({
      [ACTIVE_BOUNDARY_RETRY_KEY]: 0,
      [ACTIVE_BOUNDARY_RETRY_MODE_KEY]: '',
      [ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]: 0
    });
    activeBoundaryDeferredForPhaseAdoption = false;
    return true;
  } catch (error) {
    // 保留内存 flag 与 1 分钟钟，不让未清理的 durable marker
    // 在下次 init 把已排好的自然边界反复覆盖。
    activeBoundaryDeferredForPhaseAdoption = true;
    console.warn('[AC扩展] 清理 active-boundary 重试标记失败:', error?.message);
    return false;
  }
}

// 调度下一次 active hours 边界闹钟。pending retry 同时以独立
// storage marker 和 live alarm 表示；init 不得把它覆盖成下一个自然边界。
async function rescheduleActiveBoundaryUnsafe(options = {}) {
  const consumePending = options.consumePending === true;
  let existingActionAlarm = null;
  let existingScheduleAlarm = null;
  let existingOwnerReadAlarm = null;
  [existingActionAlarm, existingScheduleAlarm, existingOwnerReadAlarm] =
    await Promise.all([
    chrome.alarms.get('ac-active-boundary').catch(() => null),
    chrome.alarms.get(ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM).catch(() => null),
    chrome.alarms.get(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM).catch(() => null)
    ]);
  const now = Date.now();
  const naturalBoundaryAt = getNextActiveBoundary(new Date(now));
  const durableRetry = consumePending
    ? { retryAt: 0, mode: '', boundaryAt: 0 }
    : await readDurableActiveBoundaryRetry();
  const durableRetryAt = durableRetry.retryAt;
  const durableRetryBoundaryAt = durableRetry.boundaryAt;
  const scheduleAlarmAt = Number(existingScheduleAlarm?.scheduledTime) || 0;
  const actionAlarmAt = Number(existingActionAlarm?.scheduledTime) || 0;

  // active hours 已关闭时，同名遗留钟绝不是新的进入时段请求。清掉本地
  // retry 基础设施并保留当前 PWM owner；handler 也有同一硬门禁，抵御
  // clear 失败后迟到的 delivery。
  if (!schedule.activeHours?.enabled) {
    try {
      await Promise.all([
        chrome.alarms.clear('ac-active-boundary'),
        chrome.alarms.clear(ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM),
        chrome.alarms.clear(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM)
      ]);
    } catch (_) { /* late delivery is guarded by onActiveBoundaryCrossed */ }
    if (!consumePending && !await clearActiveBoundaryRetryMarkerUnsafe()) {
      throw new Error('active hours 已关闭但边界重试标记未清理');
    }
    activeBoundaryOwnerReadDeferred = false;
    return true;
  }

  if (!consumePending && durableRetry.readOk === false) {
    // init/storage 瞬断时绝不能猜 action/schedule，更不能覆盖尚未读出的
    // 三枚 durable marker。neutral alarm 只负责稍后重读，不执行边界动作。
    return armActiveBoundaryOwnerReadRetryUnsafe(
      'active-boundary durable owner 暂不可读'
    );
  }
  if (existingOwnerReadAlarm) {
    try {
      await chrome.alarms.clear(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM);
    } catch (_) { /* stale neutral delivery is action-free */ }
  }
  activeBoundaryOwnerReadDeferred = false;
  let durableRetryMode = durableRetry.mode;
  if (!consumePending) {
    if (durableRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_ACTION
        && scheduleAlarmAt
          > durableRetryAt + PWM_RETRY_ALARM_TOLERANCE_MS) {
      durableRetryMode = ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE;
    } else if (durableRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
        && actionAlarmAt > durableRetryAt + PWM_RETRY_ALARM_TOLERANCE_MS
        && actionAlarmAt <= now + ACTIVE_BOUNDARY_RETRY_MS
          + PWM_RETRY_ALARM_TOLERANCE_MS) {
      durableRetryMode = ACTIVE_BOUNDARY_RETRY_MODE_ACTION;
    } else if (!durableRetry.mode && scheduleAlarmAt > 0) {
      durableRetryMode = ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE;
    }
  }
  const existingAlarm = durableRetryMode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
    ? existingScheduleAlarm
    : existingActionAlarm;
  const existingAt = Number(existingAlarm?.scheduledTime) || 0;
  let effectiveRetryAt = durableRetryAt;
  let effectiveRetryBoundaryAt = durableRetryBoundaryAt;
  if (!consumePending && durableRetryMode !== durableRetry.mode
      && existingAt > 0) {
    effectiveRetryAt = existingAt;
    effectiveRetryBoundaryAt =
      durableRetryMode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
        ? durableRetryBoundaryAt || getNextActiveBoundary(new Date(
          existingAt - ACTIVE_BOUNDARY_RETRY_MS
            - PWM_RETRY_ALARM_TOLERANCE_MS
        ))
        : 0;
    try {
      // typed alarm 比旧 durable owner 更新时，先把 durable timestamp/mode
      // 收到同一身份；listener 仍只接受精确 scheduledTime。
      await chrome.storage.local.set({
        [ACTIVE_BOUNDARY_RETRY_KEY]: effectiveRetryAt,
        [ACTIVE_BOUNDARY_RETRY_MODE_KEY]: durableRetryMode,
        [ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]: effectiveRetryBoundaryAt
      });
    } catch (_) { /* typed alarm + delivery ownership仍可完成接管 */ }
  }

  const liveRetryPending = !consumePending
    && existingAt > now
    && existingAt <= now + ACTIVE_BOUNDARY_RETRY_MS
      + PWM_RETRY_ALARM_TOLERANCE_MS
    && (naturalBoundaryAt <= 0
      || Math.abs(existingAt - naturalBoundaryAt)
        > PWM_RETRY_ALARM_TOLERANCE_MS);
  const overdueBoundaryPending = !consumePending
    && existingAt > 0
    && existingAt <= now;
  const retryPending = !consumePending
    && (activeBoundaryDeferredForPhaseAdoption
      || effectiveRetryAt > 0
      || liveRetryPending
      || overdueBoundaryPending);

  if (retryPending) {
    activeBoundaryDeferredForPhaseAdoption = true;
    if (effectiveRetryAt <= now) {
      if (effectiveRetryAt <= 0 && existingAt > now) {
        try {
          await chrome.storage.local.set({
            [ACTIVE_BOUNDARY_RETRY_KEY]: existingAt,
            [ACTIVE_BOUNDARY_RETRY_MODE_KEY]: durableRetryMode,
            [ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]: effectiveRetryBoundaryAt
          });
        } catch (_) { /* typed alarm name still preserves retry semantics */ }
        return existingAt;
      }
      return armActiveBoundaryRetryUnsafe(
        'active-boundary durable retry',
        { mode: durableRetryMode, boundaryAt: effectiveRetryBoundaryAt }
      );
    }
    if (existingAt > now
        && Math.abs(existingAt - effectiveRetryAt)
          <= PWM_RETRY_ALARM_TOLERANCE_MS) return existingAt;
    try {
      await Promise.all([
        chrome.alarms.clear('ac-active-boundary'),
        chrome.alarms.clear(ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM),
        chrome.alarms.clear(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM)
      ]);
    } catch (_) { /* ignore */ }
    if (!await createActiveBoundaryAlarmWithRetry(
      effectiveRetryAt,
      { mode: durableRetryMode }
    )) {
      return armActiveBoundaryRetryUnsafe(
        'durable active-boundary 恢复失败',
        { mode: durableRetryMode, boundaryAt: effectiveRetryBoundaryAt }
      );
    }
    return effectiveRetryAt;
  }

  if (naturalBoundaryAt > now
      && existingAt > now
      && scheduleAlarmAt <= 0
      && Math.abs(existingAt - naturalBoundaryAt)
        <= PWM_RETRY_ALARM_TOLERANCE_MS) {
    return existingAt;
  }
  try {
    await Promise.all([
      chrome.alarms.clear('ac-active-boundary'),
      chrome.alarms.clear(ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM),
      chrome.alarms.clear(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM)
    ]);
  } catch (_) { /* ignore */ }
  if (!naturalBoundaryAt) return true;
  // clear await 若恰好跨过边界，不能用新时刻重算到下一个
  // start/end。保留 captured boundary 的待处理身份，1 分钟后幂等重放。
  if (naturalBoundaryAt <= Date.now() + PWM_RETRY_ALARM_TOLERANCE_MS) {
    return armActiveBoundaryRetryUnsafe(
      'active-boundary 调度跨过边界',
      { mode: ACTIVE_BOUNDARY_RETRY_MODE_ACTION }
    );
  }
  if (!await createActiveBoundaryAlarmWithRetry(naturalBoundaryAt)) {
    return armActiveBoundaryRetryUnsafe(
      'active-boundary 自然钟创建失败',
      {
        mode: ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE,
        boundaryAt: naturalBoundaryAt
      }
    );
  }
  return naturalBoundaryAt;
}

function armActiveBoundaryRetry(reason = 'phase-adoption', options = {}) {
  return runSerializedActiveBoundaryMutation(
    () => armActiveBoundaryRetryUnsafe(reason, options)
  );
}

function armActiveBoundaryOwnerReadRetry(reason = 'owner-read') {
  return runSerializedActiveBoundaryMutation(
    () => armActiveBoundaryOwnerReadRetryUnsafe(reason)
  );
}

function rescheduleActiveBoundary(options = {}) {
  return runSerializedActiveBoundaryMutation(
    () => rescheduleActiveBoundaryUnsafe(options)
  );
}

function completeActiveBoundaryProcessing(options = {}) {
  const expectedRetryAt = Number(options.expectedRetryAt) || 0;
  const expectedRetryMode = options.expectedRetryMode || '';
  const expectedRetryBoundaryAt =
    Number(options.expectedRetryBoundaryAt) || 0;
  const expectedDeliveryAt = Number(options.expectedDeliveryAt)
    || expectedRetryAt;
  const expectedAlarmName = options.expectedAlarmName || '';
  const allowMarkerlessTypedOwner =
    options.allowMarkerlessTypedOwner === true;
  const requireExpectedOwner = options.requireExpectedOwner === true;
  return runSerializedActiveBoundaryMutation(async () => {
    let completionStarted = false;
    try {
      if (requireExpectedOwner) {
        const currentRetry = await readDurableActiveBoundaryRetry();
        if (!currentRetry.readOk) {
          throw new Error('active-boundary owner 复检失败');
        }
        let expectedOwnerMatches =
          Math.abs(currentRetry.retryAt - expectedRetryAt)
            <= PWM_RETRY_ALARM_TOLERANCE_MS
          && currentRetry.mode === expectedRetryMode
          && Math.abs(currentRetry.boundaryAt - expectedRetryBoundaryAt)
            <= PWM_RETRY_ALARM_TOLERANCE_MS;
        if (!expectedOwnerMatches && allowMarkerlessTypedOwner
            && expectedAlarmName
            && (currentRetry.retryAt <= 0
              || expectedDeliveryAt
                > currentRetry.retryAt + PWM_RETRY_ALARM_TOLERANCE_MS)) {
          const liveExpected = await chrome.alarms.get(expectedAlarmName)
            .catch(() => null);
          expectedOwnerMatches = Math.abs(
            Number(liveExpected?.scheduledTime) - expectedDeliveryAt
          ) <= PWM_RETRY_ALARM_TOLERANCE_MS;
        }
        if (!expectedOwnerMatches) {
          return false;
        }
        if (expectedAlarmName) {
          const newerSameAlarm = await chrome.alarms.get(expectedAlarmName)
            .catch(() => null);
          const newerSameAt = Number(newerSameAlarm?.scheduledTime) || 0;
          if (newerSameAt
                > expectedDeliveryAt + PWM_RETRY_ALARM_TOLERANCE_MS
              && newerSameAt <= Date.now() + ACTIVE_BOUNDARY_RETRY_MS
                + PWM_RETRY_ALARM_TOLERANCE_MS) {
            return false;
          }
          const oppositeAlarmName = expectedAlarmName
              === ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM
            ? 'ac-active-boundary'
            : ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM;
          const oppositeAlarm = await chrome.alarms.get(oppositeAlarmName)
            .catch(() => null);
          const oppositeAt = Number(oppositeAlarm?.scheduledTime) || 0;
          if (oppositeAt
                > expectedDeliveryAt + PWM_RETRY_ALARM_TOLERANCE_MS
              && oppositeAt <= Date.now() + ACTIVE_BOUNDARY_RETRY_MS
                + PWM_RETRY_ALARM_TOLERANCE_MS) {
            return false;
          }
        }
      }
      completionStarted = true;
      if (!await clearActiveBoundaryRetryMarkerUnsafe()) {
        throw new Error('active-boundary 重试标记未清理');
      }
      return await rescheduleActiveBoundaryUnsafe({ consumePending: true });
    } finally {
      // 必须在 clear + natural/schedule-only rearm 的全部 await 结束后再提交。
      // complete 期间任何时点观察到旧 phase owner 的 defer 都捕获旧代次，
      // 排到本事务之后时只能 no-op。
      if (completionStarted) activeBoundaryCompletionGeneration += 1;
    }
  });
}

function deferActiveBoundaryForPhaseAdoption() {
  const observedCompletionGeneration = activeBoundaryCompletionGeneration;
  return runSerializedActiveBoundaryMutation(() => {
    // delivery 在 successful complete 占用 mutation chain 时看到旧 phase
    // owner 并排队，轮到它执行时不得重新污染已经清理的 marker/自然钟。
    if (activeBoundaryCompletionGeneration !== observedCompletionGeneration) {
      return false;
    }
    return armActiveBoundaryRetryUnsafe(
      'sync 相位接管',
      { mode: ACTIVE_BOUNDARY_RETRY_MODE_ACTION }
    );
  });
}

// 调度下一次 :20/:50 天气预取（智能模式启用时；否则清除闹钟）。
async function rescheduleSmartWeatherAlarm() {
  try {
    await chrome.alarms.clear('ac-smart-weather');
  } catch (_) { /* ignore */ }
  if (!schedule.smartMode?.enabled) return;
  const plan = planNextSmartWeatherPrefetch(Date.now());
  await createAlarm('ac-smart-weather', { when: plan.prefetchAt });
}

// 边界闹钟触发：进入/退出运行时段，恢复/暂停已启用的自动控制
async function onActiveBoundaryCrossed() {
  // 关闭运行时段后迟到/遗留的同名 alarm 只能被消费，不能把当前 smart
  // owner 当作“进入时段”重新 fresh start。
  if (!schedule.activeHours?.enabled) {
    await completeActiveBoundaryProcessing();
    return true;
  }
  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    await deferActiveBoundaryForPhaseAdoption();
    return false;
  }
  // 检查到 claim 之间无 await；active-boundary 和 sync/page adoption
  // 从此共用同一把排他锁，直到页面动作、storage 和 live alarm 收口。
  const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) {
    await deferActiveBoundaryForPhaseAdoption();
    return false;
  }

  // 提取（Fowler Extract Function）：退出运行时段暂停路径——B1 顺序：先 persist 已重置运行态再执行长流程关机。
  async function shutdownAfterActiveHoursLeave() {
    await resetDisabledPwmRuntime();
    // B1（active-hours 离开）：先 persist 已重置运行态再执行长流程关机 — 与
    // updateSchedule、applySyncedPhase 同步停用路径保持顺序一致，避免 SW 在
    // verifyPageTimerPersistence 长流程中被杀导致闹钟自愈"复活" PWM。
    await persistSchedule('active-hours-leave-pre-shutdown', { syncFromLiveAlarm: false });
    const shutdownResult = await requestTimerBasedShutdown('active-hours-leave');
    if (!shutdownResult?.success) {
      schedule.pageTimerError = `退出运行时段后页面关机定时器未确认：${shutdownResult?.error || '未知错误'}`;
      return false;
    }
    return true;
  }

  let boundaryActionCompleted = false;
  let boundaryRetryAt = 0;
  try {
    // 先把“本次边界尚未完成”持久化。任意 await 中 SW 退出时，
    // init 都会恢复这枚 1 分钟钟；只有动作真正收口后才消费。
    boundaryRetryAt = await armActiveBoundaryRetry('active-boundary 处理');
    if (!schedule.activeHours?.enabled) {
      boundaryActionCompleted = true;
      if (await completeActiveBoundaryProcessing({
        requireExpectedOwner: true,
        expectedRetryAt: boundaryRetryAt,
        expectedRetryMode: ACTIVE_BOUNDARY_RETRY_MODE_ACTION,
        expectedDeliveryAt: boundaryRetryAt,
        expectedAlarmName: 'ac-active-boundary',
        allowMarkerlessTypedOwner: true
      }) === false) {
        return false;
      }
      return true;
    }

    // 舒适启动是用户刚刚显式开启自动控制后的短暂优先阶段。边界到达只记录并
    // 调度下一次；独立 ac-comfort-end 会在满五分钟后恢复正常时段策略。
    if (isComfortStartActive()) {
      console.log('[ac-ust] active hours boundary: comfort start still active');
    } else {
      const inside = isWithinActiveHours();
      if (inside && schedule.enabled) {
        // 进入运行时段 → 恢复用户已启用的自动控制
        console.log('[ac-ust] active hours: entering, resume automation');
        schedule.pwmState = 'on';
        await persistSchedule('active-hours-enter-pre-setup', { syncFromLiveAlarm: false });
        if (!schedule.activeHours?.enabled) {
          boundaryActionCompleted = true;
          if (await completeActiveBoundaryProcessing({
            requireExpectedOwner: true,
            expectedRetryAt: boundaryRetryAt,
            expectedRetryMode: ACTIVE_BOUNDARY_RETRY_MODE_ACTION,
            expectedDeliveryAt: boundaryRetryAt,
            expectedAlarmName: 'ac-active-boundary',
            allowMarkerlessTypedOwner: true
          }) === false) {
            return false;
          }
          return true;
        }
        const setupSucceeded = await setupAlarms(true, { phaseAdmissionEpoch });
        if (!setupSucceeded) {
          throw new Error('进入运行时段后 PWM 主钟未收口');
        }
        if (isAutomationAllowed()) {
          await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        }
      } else if (!inside && schedule.enabled) {
        // 退出运行时段 → 暂停自动控制并停机，但保留用户启用意图
        console.log('[ac-ust] active hours: leaving, pause automation');
        if (!await shutdownAfterActiveHoursLeave()) {
          throw new Error(schedule.pageTimerError || '退出运行时段关机未收口');
        }
        await rescheduleSmartWeatherAlarm();
      }
    }
    boundaryActionCompleted = true;
    if (await completeActiveBoundaryProcessing({
      requireExpectedOwner: true,
      expectedRetryAt: boundaryRetryAt,
      expectedRetryMode: ACTIVE_BOUNDARY_RETRY_MODE_ACTION,
      expectedDeliveryAt: boundaryRetryAt,
      expectedAlarmName: 'ac-active-boundary',
      allowMarkerlessTypedOwner: true
    }) === false) {
      return false;
    }
    return true;
  } catch (error) {
    try {
      await armActiveBoundaryRetry(
        boundaryActionCompleted
          ? 'active-boundary 动作已完成但自然钟未收口'
          : 'active-boundary 失败',
        {
          mode: boundaryActionCompleted
            ? ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
            : ACTIVE_BOUNDARY_RETRY_MODE_ACTION,
          boundaryAt: boundaryActionCompleted
            ? getNextActiveBoundary()
            : 0
        }
      );
    } catch (retryError) {
      console.warn('[AC扩展] active-boundary 失败且重试钟创建失败:', retryError?.message);
    }
    throw error;
  } finally {
    releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
    drainDeferredScheduleRepair('active-boundary-complete');
  }
}

function getLegacyAlarmEndMs() {
  if (!schedule.alarmCreatedAt || !schedule.alarmDelayMinutes) return 0;
  return schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000;
}

function getStoredAlarmEndMs() {
  if (schedule.nextTriggerAt) return schedule.nextTriggerAt;
  return getLegacyAlarmEndMs();
}

function setNextTriggerAt(nextTriggerAt, options = {}) {
  const previousAt = Number(schedule.nextTriggerAt) || 0;
  const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
  const requestedPlannedAt = Number(options?.plannedAt);
  const existingPlannedAt = Number(schedule.smartClockPlannedAt) || 0;
  const legacyPlannedAt = Number(schedule.alarmCreatedAt) || 0;
  const sameClock = previousAt > 0
    && normalizedAt > 0
    && Math.abs(previousAt - normalizedAt) <= PWM_RETRY_ALARM_TOLERANCE_MS;
  schedule.nextTriggerAt = normalizedAt;
  if (normalizedAt <= 0) {
    schedule.smartClockPlannedAt = 0;
  } else if (Number.isFinite(requestedPlannedAt) && requestedPlannedAt > 0) {
    schedule.smartClockPlannedAt = requestedPlannedAt;
  } else if (!sameClock || existingPlannedAt <= 0) {
    schedule.smartClockPlannedAt = sameClock && legacyPlannedAt > 0
      ? legacyPlannedAt
      : Date.now();
  }
}

async function executePwmLifecycleRecoveryFallback(action, context) {
  if (action === 'execute-current') {
    const handled = await executePwmStepWithRecovery({
      automationRevision: context.automationRevision,
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
      source: `${context.source || 'lifecycle'}-fallback-current`
    });
    return { handled, fallbackAction: action };
  }
  if (action === 'repair-clock') {
    await repairScheduleClock();
    return { handled: true, fallbackAction: action };
  }
  return { handled: false, fallbackAction: 'none' };
}

async function recoverPwmLifecycle(context = {}) {
  if (isSyncPhaseAdoptionAdmissionBlockedFor(context.phaseAdmissionEpoch)) {
    return {
      handled: false,
      plan: { kind: 'noop', reason: 'sync-phase-adoption-in-progress' }
    };
  }
  const automationRevision = Number.isSafeInteger(context.automationRevision)
    ? context.automationRevision
    : pwmRuntimeRevision;
  if (!isAutomationOperationCurrent(automationRevision)) {
    return { handled: false, plan: { kind: 'noop', reason: 'automation-stale' } };
  }

  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const smartClockPlannedAt = Number(context.smartClockPlannedAt)
    || Number(schedule.smartClockPlannedAt)
    || Number(schedule.alarmCreatedAt)
    || 0;
  const rawLiveAlarmAt = Number(context.existingAlarm?.scheduledTime);
  // typed retry 的事务所有权先于新半点天气：否则跨到 :00/:30 恢复时，新的
  // onMinutes=0 计划会先清 marker/改相位，再把旧 retry 错交给 interval。
  const retryAlarmAt = Number.isFinite(rawLiveAlarmAt) && rawLiveAlarmAt > 0
    ? rawLiveAlarmAt
    : Number(schedule.nextTriggerAt);
  const futureLifecycleClockAt = Number.isFinite(rawLiveAlarmAt)
      && rawLiveAlarmAt > now
    ? rawLiveAlarmAt
    : (Number(schedule.nextTriggerAt) > now
      ? Number(schedule.nextTriggerAt)
      : 0);
  const lifecycleClockAssessment = classifySmartOnClock(
    schedule,
    futureLifecycleClockAt,
    {
      now,
      plannedAt: smartClockPlannedAt,
      nextAction: schedule.pwmState,
      toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
      requirePlannedAt: true
    }
  );
  const hasOwnedSmartBoundaryWait = futureLifecycleClockAt > now
    && lifecycleClockAssessment.valid
    && (lifecycleClockAssessment.kind === 'safety-skip'
      || lifecycleClockAssessment.kind === 'safety-timer-retry');
  const lifecycleRetryContext = getActiveSmartOnPwmRetryContext(
    schedule,
    rawLiveAlarmAt,
    { now }
  );
  if (lifecycleRetryContext.hasTypedSmartOnRetry
      && Number.isFinite(retryAlarmAt)
      && retryAlarmAt > 0
      && retryAlarmAt <= now) {
    const retryPlan = {
      kind: 'execute-smart-on-retry',
      strategy: 'smart',
      reason: 'typed-smart-on-retry-due',
      scheduledTime: retryAlarmAt,
      boundaryAt: lifecycleRetryContext.boundaryAt
    };
    const handled = await executePwmStepWithRecovery({
      scheduledTime: retryAlarmAt,
      automationRevision,
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
      source: `${context.source || 'lifecycle'}-typed-retry`
    });
    return { handled, plan: retryPlan };
  }
  if (lifecycleRetryContext.hasSafetyTimerRetry
      && Number.isFinite(retryAlarmAt)
      && retryAlarmAt > 0
      && retryAlarmAt <= now) {
    const retryPlan = {
      kind: 'repair-smart-on-safety-timer',
      strategy: 'smart',
      reason: 'typed-smart-on-safety-timer-due',
      scheduledTime: retryAlarmAt,
      boundaryAt: lifecycleRetryContext.boundaryAt
    };
    const repair = await repairScheduleClock({
      smartOnExpectedBoundaryAt: lifecycleRetryContext.boundaryAt
    });
    return { handled: repair?.success === true, plan: retryPlan, repair };
  }

  let preparedRuntimeSnapshot = null;
  if (!lifecycleRetryContext.hasTypedSmartOnRetry
      && !hasOwnedSmartBoundaryWait) {
    preparedRuntimeSnapshot = snapshotPreparedSmartRuntime();
    const boundaryAt = halfHourBoundaryAtOrBefore(now);
    await applyPreparedSmartModeDurations({
      allowActiveOnPhase: true,
      boundaryAt
    });
    if (!isAutomationOperationCurrent(automationRevision)) {
      return { handled: false, plan: { kind: 'noop', reason: 'automation-stale' } };
    }
    // weather await 期间若用户/sync 已认领新配置或新 phase clock，旧 context
    // 中的 existingAlarm/plannedActionAt 已失效；立即退出，绝不继续 rollback
    // 或把 storage 对齐回旧钟。新 owner 会自行 setup/rearm。
    if (!isSmartPreparationOwnerCurrent(preparedRuntimeSnapshot.owner)) {
      return { handled: false, plan: { kind: 'noop', reason: 'schedule-owner-changed' } };
    }
  }

  const liveAlarmAt = Object.hasOwn(context, 'liveAlarmAt')
    ? Number(context.liveAlarmAt) || 0
    : (Number.isFinite(rawLiveAlarmAt) && rawLiveAlarmAt > now ? rawLiveAlarmAt : 0);
  const storedAlarmAt = Object.hasOwn(context, 'storedAlarmAt')
    ? Number(context.storedAlarmAt) || 0
    : getStoredAlarmEndMs();
  const plannedActionAt = Object.hasOwn(context, 'plannedActionAt')
    ? Number(context.plannedActionAt) || 0
    : (liveAlarmAt || (storedAlarmAt > now ? storedAlarmAt : 0));

  const plan = planPwmLifecycleRecovery(schedule, {
    now,
    // 天气读取可把 on=0 暂时投影为 pwmState='off'。时钟信任必须沿用读取前
    // 的 next-action ownership，否则 22:50 残留钟会冒充合法 OFF 截止并跳过 22:30。
    smartNextAction: preparedRuntimeSnapshot?.pwmState || schedule.pwmState,
    smartClockPlannedAt,
    plannedActionAt,
    liveAlarmAt,
    storedAlarmAt,
    expiredAlarmAt: Number(context.expiredAlarmAt) || 0,
    allowNonBoundarySmartClock: lifecycleRetryContext.hasTypedSmartOnRetry,
    smartBoundaryToleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
    requireSmartClockPlannedAt: true,
    missingClockAction: context.missingClockAction,
    maxOnMinutes: SMART_MODE.ON_MAX
  });

  // 当前半点天气只用于判断是否应补执行当前周期。若协调器决定保留现有
  // future live/stored clock，本轮不得把旧边界的 on=0 或时长写进未来动作；
  // 真正到达未来半点时，runPwmStep 会消费该边界自己的预取计划。
  if (plan.kind === 'preserve-live-alarm'
      || plan.kind === 'restore-stored-alarm') {
    restorePreparedSmartRuntime(preparedRuntimeSnapshot);
  }

  if (plan.kind === 'recover-smart-current-cycle') {
    console.warn(
      `[AC扩展] 智能当前周期恢复：立即补执行 ON，绝对关机点=${new Date(plan.pageTimerTargetAt).toLocaleTimeString()}`
    );
    const execution = executePwmStepWithRecovery({
      scheduledTime: plan.scheduledTime,
      recoveryPlan: plan,
      automationRevision,
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
      source: `${context.source || 'lifecycle'}-smart-current-cycle`
    });
    if (context.deferSmartCurrentCycleExecution === true) {
      // 诊断 RPC 只有 10 秒预算，而页面 timer 的首轮新鲜页验证本身就等待 10 秒。
      // 先启动并由 waitUntil 保活，立即把 in-flight 事实回给 Popup；最终成功/失败仍由
      // 同一 executor 持久化，下次诊断读取终态，避免“后台成功但本次先报 timeout”。
      void waitUntil(execution).catch((error) => {
        console.error('[AC扩展] 诊断启动的智能当前周期恢复异常:', error);
        void appendDiagnosticLog('error', 'diagnostic-smart-current-cycle', error);
      });
      return { handled: true, started: true, plan };
    }
    const handled = await execution;
    return { handled, plan };
  }

  if (plan.kind === 'preserve-live-alarm') {
    const reason = context.preserveLiveReason
      || `${context.source || 'lifecycle'}: 同步现有 PWM 闹钟`;
    if (context.preserveLiveStrategy === 'next-only') {
      const triggerPlan = await persistReconciledPwmTrigger(
        context.existingAlarm,
        reason,
        PWM_TRIGGER_NEXT_ONLY_OPTIONS,
        automationRevision
      );
      return { handled: true, plan, triggerPlan };
    }
    const synced = await syncStoredTriggerFromAlarm(
      context.existingAlarm,
      reason,
      automationRevision
    );
    return { handled: synced, plan };
  }

  if (plan.kind === 'restore-stored-alarm') {
    const restored = await restoreIntervalAlarmFromStorage(
      context.restoreReason || `${context.source || 'lifecycle'}: 按 storage 恢复 PWM 闹钟`
    );
    if (restored) return { handled: true, plan };
    const fallback = await executePwmLifecycleRecoveryFallback(
      context.failureAction,
      context
    );
    return { ...fallback, plan };
  }

  if (plan.kind === 'advance-expired-alarm') {
    const advanced = await executeExpiredIntervalRecovery(
      plan.scheduledTime,
      automationRevision
    );
    if (advanced) return { handled: true, plan };
    const fallback = await executePwmLifecycleRecoveryFallback(
      context.failureAction,
      context
    );
    return { ...fallback, plan };
  }

  if (plan.kind === 'execute-due-action') {
    const handled = await executePwmStepWithRecovery({
      scheduledTime: plan.scheduledTime,
      automationRevision,
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
      source: `${context.source || 'lifecycle'}-due-action`
    });
    return { handled, plan };
  }

  if (plan.kind === 'execute-current-action') {
    const handled = await executePwmStepWithRecovery({
      automationRevision,
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
      source: `${context.source || 'lifecycle'}-current-action`
    });
    return { handled, plan };
  }

  if (plan.kind === 'repair-clock') {
    const expectedBoundaryAt = Number(plan.expectedAt) || 0;
    const invalidSmartOnClock = plan.strategy === 'smart'
      && (plan.reason === 'skipped-nearest-smart-on-boundary'
        || plan.reason === 'untrusted-smart-on-clock');
    const repair = await repairScheduleClock({
      smartOnExpectedBoundaryAt: expectedBoundaryAt,
      revokeInvalidSmartOnClock: invalidSmartOnClock,
      ...(invalidSmartOnClock
        ? { revokeOwnerRevision: automationRevision }
        : {})
    });
    return { handled: repair?.success === true, plan, repair };
  }

  return { handled: false, plan };
}

// ===== 智能模式：将军澳 JKB 天气取数 + 动态时长 =====
// 香港天文台为将军澳提供独立的气温、相对湿度、10 分钟平均风与站点雨量开放数据。
// smart-mode.js 按同一站名精确合并四个源，并由 JKB 气温 + 湿度推导露点；天气仅作为
// 本机运行态缓存，不进入 sync。
const SMART_WEATHER_KEY = 'ac_smart_weather';
const SMART_WEATHER_PLAN_KEY = 'ac_smart_weather_plan';
const SMART_WEATHER_URLS = Object.freeze({
  temperature: 'https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv',
  humidity: 'https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_humidity.csv',
  wind: 'https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_10min_wind.csv',
  rainfall: 'https://data.weather.gov.hk/weatherAPI/opendata/hourlyRainfall.php?lang=en'
});
const SMART_WEATHER_TTL_MS = 60 * 60 * 1000;
let smartWeatherInFlight = null;
let smartReapplyInFlight = false;  // 滑块松开后即时重设 Power-off after 的单飞守卫
let smartReapplyPending = false;
let scheduleUpdateChain = Promise.resolve();

function runSerializedScheduleUpdate(operation) {
  const current = scheduleUpdateChain.then(operation, operation);
  scheduleUpdateChain = current.catch(() => {});
  return current;
}

async function runSmartReapplyLoop() {
  smartReapplyInFlight = true;
  let deferredUntilPwmRelease = false;
  try {
    do {
      smartReapplyPending = false;
      try {
        const outcome = await reapplySmartSensitivityNow();
        if (outcome?.deferred) {
          smartReapplyPending = true;
          if (!pwmStepRunning) continue;
          deferredUntilPwmRelease = true;
          break;
        }
        if (outcome?.retry) smartReapplyPending = true;
      } catch (e) {
        console.warn('[AC扩展] 滑块灵敏度即时应用失败:', e?.message);
        void appendDiagnosticLog('warn', 'reapply-smart-now', e);
      }
    } while (smartReapplyPending);
  } finally {
    smartReapplyInFlight = false;
    if (!deferredUntilPwmRelease) smartReapplyPending = false;
  }
}

async function fetchSmartWeatherResource(resourceName, responseType) {
  const response = await fetch(SMART_WEATHER_URLS[resourceName], { cache: 'no-store' });
  if (!response.ok) throw new Error(`${resourceName} 天气接口 HTTP ${response.status}`);
  return responseType === 'json' ? response.json() : response.text();
}

async function fetchSmartWeather() {
  const [temperatureCsv, humidityCsv, windCsv, rainfallData] = await Promise.all([
    fetchSmartWeatherResource('temperature', 'text'),
    fetchSmartWeatherResource('humidity', 'text'),
    fetchSmartWeatherResource('wind', 'text'),
    fetchSmartWeatherResource('rainfall', 'json')
  ]);
  const parsed = parseTseungKwanOWeather({
    temperatureCsv,
    humidityCsv,
    windCsv,
    rainfallData
  });
  if (!parsed) throw new Error('将军澳天气数据缺失或格式异常');
  return { fetchedAt: Date.now(), ...parsed };
}

async function readStoredSmartWeather() {
  const cached = (await chrome.storage.local.get(SMART_WEATHER_KEY))[SMART_WEATHER_KEY];
  if (cached && cached.fetchedAt) {
    return {
      ...cached,
      stale: (Date.now() - cached.fetchedAt) >= SMART_WEATHER_TTL_MS,
      error: ''
    };
  }
  return {
    fetchedAt: 0,
    temperature: null,
    dewPoint: null,
    windSpeedMs: null,
    rainMm: null,
    relativeHumidity: null,
    stale: true,
    error: 'no-cache'
  };
}

// 读取天气观测：缓存未过期直接返回，否则单飞拉取。
// 拉取失败回退旧缓存并标记 stale；无缓存则返回错误占位（调用方退化为手动时长）。
async function getSmartWeather({ force = false } = {}) {
  const cached = await readStoredSmartWeather();
  if (!force && cached && cached.fetchedAt
      && (Date.now() - cached.fetchedAt) < SMART_WEATHER_TTL_MS) {
    return { ...cached, stale: false, error: '' };
  }
  if (smartWeatherInFlight) return smartWeatherInFlight;

  smartWeatherInFlight = (async () => {
    try {
      const weather = await fetchSmartWeather();
      await chrome.storage.local.set({ [SMART_WEATHER_KEY]: weather });
      return { ...weather, stale: false, error: '' };
    } catch (e) {
      console.warn('[AC扩展] 智能模式天气拉取失败:', e?.message);
      void appendDiagnosticLog('warn', 'smart-weather', e);
      const cached = (await chrome.storage.local.get(SMART_WEATHER_KEY))[SMART_WEATHER_KEY];
      if (cached && cached.fetchedAt) {
        return { ...cached, stale: true, error: e?.message || String(e) };
      }
      return {
        fetchedAt: 0,
        temperature: null,
        dewPoint: null,
        windSpeedMs: null,
        rainMm: null,
        relativeHumidity: null,
        stale: true,
        error: e?.message || String(e)
      };
    } finally {
      smartWeatherInFlight = null;
    }
  })();
  return smartWeatherInFlight;
}

async function prepareSmartWeatherForBoundary(boundaryAt) {
  if (!schedule.smartMode?.enabled) return null;
  const weather = await getSmartWeather({ force: true });
  const plan = prepareSmartWeatherDecision({
    boundaryAt,
    preparedAt: Date.now(),
    sensitivity: schedule.smartMode.sensitivity,
    weather
  });
  if (!plan || !schedule.smartMode?.enabled) return null;
  await chrome.storage.local.set({ [SMART_WEATHER_PLAN_KEY]: plan });
  return plan;
}

function currentSmartControlBoundary(now = Date.now()) {
  const date = new Date(now);
  if ((date.getMinutes() !== 0 && date.getMinutes() !== 30)
      || date.getSeconds() > 59) {
    return 0;
  }
  date.setSeconds(0, 0);
  return date.getTime();
}

// 天气准备会跨 storage await；期间用户或 sync 可能切模式/灵敏度/时段。
// 用不可变标量 token 认领本次读取，避免旧智能事务回写新手动配置。
function snapshotSmartPreparationOwner() {
  return {
    pwmRuntimeRevision,
    enabled: schedule.enabled === true,
    mode: schedule.mode,
    clockMode: !!schedule.clockMode,
    smartEnabled: schedule.smartMode?.enabled === true,
    smartSensitivity: schedule.smartMode?.sensitivity,
    activeHoursEnabled: schedule.activeHours?.enabled === true,
    activeHoursStart: schedule.activeHours?.start,
    activeHoursEnd: schedule.activeHours?.end,
    // 天气准备本身不会改写 clock ownership；sync/另一相位事务会。
    nextTriggerAt: Number(schedule.nextTriggerAt) || 0,
    smartClockPlannedAt: Number(schedule.smartClockPlannedAt) || 0,
    alarmCreatedAt: Number(schedule.alarmCreatedAt) || 0,
    alarmDelayMinutes: Number(schedule.alarmDelayMinutes) || 0
  };
}

function isSmartPreparationOwnerCurrent(owner) {
  if (!owner) return false;
  const current = snapshotSmartPreparationOwner();
  return Object.keys(current).every(key => current[key] === owner[key]);
}

function snapshotPreparedSmartRuntime() {
  return {
    owner: snapshotSmartPreparationOwner(),
    pwmState: schedule.pwmState,
    onMinutes: schedule.onMinutes,
    offMinutes: schedule.offMinutes,
    smartOnBoundaryAt: schedule.smartOnBoundaryAt,
    pwmRetryKind: schedule.pwmRetryKind,
    pwmRetryBoundaryAt: schedule.pwmRetryBoundaryAt,
    pwmRetryScheduledAt: schedule.pwmRetryScheduledAt
  };
}

function restorePreparedSmartRuntime(snapshot) {
  if (!snapshot || !isSmartPreparationOwnerCurrent(snapshot.owner)) return false;
  const { owner, ...runtime } = snapshot;
  Object.assign(schedule, runtime);
  return true;
}

function applySmartDurationDecision(decision) {
  if (decision.onMinutes === 0) {
    clearPwmRetryState();
    schedule.pwmState = 'off';
    schedule.onMinutes = SMART_MODE.CYCLE_MINUTES;
    schedule.offMinutes = SMART_MODE.CYCLE_MINUTES;
  } else {
    schedule.onMinutes = decision.onMinutes;
    schedule.offMinutes = Math.max(1, decision.offMinutes);
  }
}

function applySmartDurationFallback() {
  schedule.onMinutes = Math.min(
    SMART_MODE.ON_MAX,
    sanitizeMinutes(schedule.onMinutes, SMART_MODE.ON_MAX)
  );
  schedule.offMinutes = Math.max(
    SMART_MODE.MIN_OFF_MINUTES,
    sanitizeMinutes(schedule.offMinutes, SMART_MODE.MIN_OFF_MINUTES)
  );
}

async function applyPreparedSmartModeDurations(options = {}) {
  if (!schedule.enabled || !schedule.smartMode?.enabled) return false;
  if (options.allowActiveOnPhase !== true && schedule.pwmState !== 'on') return false;
  const preparationOwner = snapshotSmartPreparationOwner();

  try {
    const requestedBoundaryAt = Number(options.boundaryAt);
    const boundaryAt = Number.isSafeInteger(requestedBoundaryAt) && requestedBoundaryAt > 0
      ? requestedBoundaryAt
      : currentSmartControlBoundary();
    const stored = await chrome.storage.local.get(SMART_WEATHER_PLAN_KEY);
    if (!isSmartPreparationOwnerCurrent(preparationOwner)) return false;
    let suggested = consumeSmartWeatherDecision(stored[SMART_WEATHER_PLAN_KEY], {
      boundaryAt,
      sensitivity: preparationOwner.smartSensitivity
    });

    if (!suggested?.valid) {
      const cachedWeather = await readStoredSmartWeather();
      if (!isSmartPreparationOwnerCurrent(preparationOwner)) return false;
      suggested = consumeStoredSmartWeatherDecision(cachedWeather, {
        boundaryAt,
        sensitivity: preparationOwner.smartSensitivity
      });
    }

    if (!isSmartPreparationOwnerCurrent(preparationOwner)) return false;
    if (!suggested?.valid) {
      applySmartDurationFallback();
      console.warn('[AC扩展] 智能模式：目标边界预计算缺失，本周期沿用安全时长');
      return false;
    }

    applySmartDurationDecision(suggested);

    console.log(
      `[AC扩展] 智能模式预计算: boundary=${new Date(boundaryAt).toLocaleTimeString()}`
      + ` K=${suggested.k.toFixed(3)} Teq=${suggested.teq.toFixed(1)}°C`
      + ` rain×${suggested.rainFactor.toFixed(3)} t_raw=${suggested.tRaw.toFixed(1)}`
      + ` → on=${suggested.onMinutes}min / off=${schedule.offMinutes}min`
    );
    return true;
  } catch (error) {
    // lifecycle/init 也会在 planner 前读取预计算；storage 瞬时失败不能让
    // setupAlarms 整段退出并漏建 watchdog。沿用已校验的安全时长继续排钟。
    if (!isSmartPreparationOwnerCurrent(preparationOwner)) return false;
    applySmartDurationFallback();
    console.warn('[AC扩展] 智能模式预计算读取失败，本周期沿用安全时长:', error?.message);
    void appendDiagnosticLog('warn', 'smart-duration-prepare', error);
    return false;
  }
}

// 智能模式：滑块松开后立即按新灵敏度重设当前 ON 相位的 Power-off after。
// 配合 updateSchedule(restart=false)——后者只持久化灵敏度、不打断当前周期；
// 本函数补上「即时反馈」，让页面关机定时器不再等下一个 30 分钟周期才变化。
// 仅 AC 当前处于 ON 相位(pwmState='off')时重设页面定时器；AC 关闭时只更新派生时长，
// 下一 ON 相位自然采用新值。整个过程异步执行，不阻塞 popup 的 updateSchedule 响应。
async function reapplySmartSensitivityNow() {
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || !schedule.smartMode?.enabled) return;
  if (isComfortStartActive()) return { comfortStartActive: true };
  if (pwmStepRunning) return { deferred: true };  // PWM 释放后尾随重算
  // 一分钟 smart-on 重试是已持久化事务；滑块值本身已由 updateSchedule 保存，
  // 但不能在事务中途改写 onMinutes/绝对截止。新灵敏度由下一半点消费。
  if (getActiveSmartOnPwmRetryContext(schedule).hasTypedSmartOnRetry) {
    return { retryProtected: true };
  }

  const wasOnPhase = schedule.pwmState === 'off';
  const oldPwmState = schedule.pwmState;
  const oldOnMinutes = Number(schedule.onMinutes) || 0;
  const oldOffMinutes = Number(schedule.offMinutes) || 0;
  const oldTriggerAt = Number(schedule.nextTriggerAt) || 0;
  const oldSmartBoundaryAt = Number(schedule.smartOnBoundaryAt) || 0;
  const oldPwmRuntimeRevision = pwmRuntimeRevision;

  const weather = await readStoredSmartWeather();
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || !schedule.smartMode?.enabled) return;
  if (pwmStepRunning) return { deferred: true };
  if (getActiveSmartOnPwmRetryContext(schedule).hasTypedSmartOnRetry) {
    return { retryProtected: true };
  }
  if (pwmRuntimeRevision !== oldPwmRuntimeRevision
      || schedule.pwmState !== oldPwmState
      || (Number(schedule.onMinutes) || 0) !== oldOnMinutes
      || (Number(schedule.offMinutes) || 0) !== oldOffMinutes
      || (Number(schedule.nextTriggerAt) || 0) !== oldTriggerAt
      || (Number(schedule.smartOnBoundaryAt) || 0) !== oldSmartBoundaryAt) {
    return { retry: true };
  }
  const suggested = computeSmartOnMinutes({
    sensitivity: schedule.smartMode.sensitivity,
    temperature: weather.temperature,
    dewPoint: weather.dewPoint,
    windSpeedMs: weather.windSpeedMs,
    rainMm: weather.rainMm
  });

  if (!suggested.valid) return;  // 天气不可用 → 保持当前周期不变

  // 落地派生 on/off（on=0 用占位，语义与 applySmartModeDurations 保持一致）
  schedule.onMinutes = suggested.onMinutes === 0
    ? SMART_MODE.CYCLE_MINUTES
    : suggested.onMinutes;
  schedule.offMinutes = Math.max(1, suggested.offMinutes);

  if (!wasOnPhase) {
    await persistSchedule('reapply-smart-sensitivity-off-phase');
    return;
  }

  // AC 当前 ON：沿用原半点锚点重设 Power-off after，不从当前时刻重获完整 ON 时长。
  const nowMs = Date.now();
  const previousSmartBoundaryAt = oldTriggerAt - oldOnMinutes * 60000;
  const storedSmartBoundaryAt = Number(schedule.smartOnBoundaryAt);
  const storedSmartDeadlineAt = smartModePageTimerTargetAt(
    oldOnMinutes,
    nowMs,
    storedSmartBoundaryAt
  );
  const previousSmartDeadlineAt = smartModePageTimerTargetAt(
    oldOnMinutes,
    nowMs,
    previousSmartBoundaryAt
  );
  const activeSmartBoundaryAt = storedSmartDeadlineAt > 0
      && storedSmartBoundaryAt <= nowMs
    ? storedSmartBoundaryAt
    : storedSmartBoundaryAt === 0
        && previousSmartDeadlineAt > 0
        && previousSmartBoundaryAt <= nowMs
      ? previousSmartBoundaryAt
      : 0;
  schedule.smartOnBoundaryAt = activeSmartBoundaryAt;
  const computedSmartDeadlineAt = suggested.onMinutes > 0
    ? smartModePageTimerTargetAt(
      suggested.onMinutes,
      nowMs,
      activeSmartBoundaryAt
    )
    : 0;
  const nextMinuteTargetAt = nextSafePageTimerTargetAt(nowMs);
  const smartDeadlineAt = computedSmartDeadlineAt > nowMs
    ? computedSmartDeadlineAt
    : nextMinuteTargetAt;
  const minutes = Math.max(1, Math.ceil((smartDeadlineAt - nowMs) / 60000));

  // 先清旧 alarm，避免旧关机时刻在慢速新鲜页验证期间抢跑；页面写入方返回
  // 已对齐 UST HH:MM 接口的绝对 targetAt，再用同一值恢复扩展倒计时。
  await clearPwmAlarm(oldPwmRuntimeRevision);
  setNextTriggerAt(0);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  const timerResult = await setPageTimer(minutes, {
    retryOnFailure: false,
    targetAt: smartDeadlineAt,
    automationRevision: oldPwmRuntimeRevision
  });
  if (await abortStaleAutomation(
    oldPwmRuntimeRevision,
    'reapply-smart-sensitivity-active-hours-paused'
  )) return;
  if (!timerResult?.success) {
    schedule.pageTimerError = `灵敏度即时应用时页面关机定时器未确认：${timerResult?.error || '未知错误'}；1 分钟后重试`;
    const retryAt = Date.now() + 60000;
    setNextTriggerAt(retryAt);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await persistSchedule('reapply-smart-sensitivity-pageTimer-retry-intent', {
      syncFromLiveAlarm: false
    });
    const alarmCreated = await createPwmAlarmFromPlan(
      { nextTriggerAt: retryAt },
      'reapply-smart-pageTimer-failed',
      oldPwmRuntimeRevision
    );
    if (alarmCreated === false) {
      schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复';
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      await persistSchedule('reapply-smart-sensitivity-pageTimer-retry-alarm-failed', {
        syncFromLiveAlarm: false
      });
      await updateBadge();
      return { success: false, deferred: true, alarmCreated: false };
    }
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      oldPwmRuntimeRevision,
      'reapply-smart-retry-active-hours-paused'
    )) return;
    await persistSchedule('reapply-smart-sensitivity-pageTimer-failed');
    await updateBadge();
    return;
  }

  const reapplyTargetAt = Number(schedule.pageTimerTargetAt) || 0;
  setNextTriggerAt(reapplyTargetAt);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  await persistSchedule('reapply-smart-sensitivity-commit-intent', {
    syncFromLiveAlarm: false
  });
  const reapplyPlan = { nextTriggerAt: reapplyTargetAt };
  const alarmCreated = await createPwmAlarmFromPlan(
    reapplyPlan,
    'reapply-smart-sensitivity',
    oldPwmRuntimeRevision
  );
  if (alarmCreated === false) {
    schedule.pageTimerError = '灵敏度即时应用已确认页面关机时间，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复';
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    await persistSchedule('reapply-smart-sensitivity-commit-alarm-failed', {
      syncFromLiveAlarm: false
    });
    await updateBadge();
    return { success: false, deferred: true, alarmCreated: false };
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (await abortStaleAutomation(
    oldPwmRuntimeRevision,
    'reapply-smart-commit-active-hours-paused'
  )) return;
  await persistSchedule('reapply-smart-sensitivity-on-phase');
  await updateBadge();

  console.log(
    `[AC扩展] 滑块灵敏度即时应用: sens=${schedule.smartMode.sensitivity}`
    + ` → on=${suggested.onMinutes}min, 页面目标 ${new Date(schedule.pageTimerTargetAt).toLocaleTimeString()}`
  );
}

function clearPageTimerProofState() {
  schedule.pageTimerMinutes = null;
  schedule.pageTimerTargetAt = 0;
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
}

function clearPwmRetryState() {
  schedule.pwmRetryKind = '';
  schedule.pwmRetryBoundaryAt = 0;
  schedule.pwmRetryScheduledAt = 0;
}

function setSmartOnPwmRetryState(targetAction, retryScheduledAt, options = {}) {
  clearPwmRetryState();
  const requestedKind = String(options?.kind || '');
  const retryKind = requestedKind === 'smart-on-safe-delay'
      || requestedKind === 'smart-on-safety-skip'
      || requestedKind === 'smart-on-safety-timer'
    ? requestedKind
    : 'smart-on';
  const boundaryAt = Number.isFinite(Number(options?.boundaryAt))
    ? Number(options.boundaryAt)
    : Number(schedule.smartOnBoundaryAt);
  const scheduledAt = Number(retryScheduledAt);
  const boundaryDate = new Date(boundaryAt);
  const exactHalfHour = Number.isSafeInteger(boundaryAt)
    && (boundaryDate.getMinutes() === 0 || boundaryDate.getMinutes() === 30)
    && boundaryDate.getSeconds() === 0
    && boundaryDate.getMilliseconds() === 0;
  const boundaryOptionalRetry = retryKind === 'smart-on-safety-timer';
  if (!schedule.smartMode?.enabled
      || targetAction !== 'on'
      || (!boundaryOptionalRetry && (!exactHalfHour || boundaryAt <= 0))
      || (boundaryOptionalRetry && boundaryAt !== 0 && !exactHalfHour)
      || !Number.isFinite(scheduledAt)
      || scheduledAt <= 0) return;
  schedule.pwmRetryKind = retryKind;
  schedule.pwmRetryBoundaryAt = exactHalfHour ? boundaryAt : 0;
  schedule.pwmRetryScheduledAt = scheduledAt;
}

function getSmartOnPwmRetryContext(scheduleSnapshot, scheduledTime, options = {}) {
  const boundaryAt = Number(scheduleSnapshot?.pwmRetryBoundaryAt);
  const retryScheduledAt = Number(scheduleSnapshot?.pwmRetryScheduledAt);
  const triggerAt = Number(scheduledTime);
  const boundaryDate = new Date(boundaryAt);
  const exactHalfHour = Number.isSafeInteger(boundaryAt)
    && (boundaryDate.getMinutes() === 0 || boundaryDate.getMinutes() === 30)
    && boundaryDate.getSeconds() === 0
    && boundaryDate.getMilliseconds() === 0;
  const retryKind = String(scheduleSnapshot?.pwmRetryKind || '');
  const hasStoredSmartOnRetry = retryKind === 'smart-on'
    || retryKind === 'smart-on-safe-delay'
    || retryKind === 'smart-on-safety-timer';
  const semanticAssessment = typeof classifySmartOnClock === 'function'
    ? classifySmartOnClock(scheduleSnapshot, triggerAt, {
        now: Number.isFinite(Number(options?.now))
          ? Number(options.now)
          : triggerAt,
        plannedAt: Number(scheduleSnapshot?.smartClockPlannedAt)
          || Number(scheduleSnapshot?.alarmCreatedAt)
          || 0,
        nextAction: 'on',
        toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
        allowDue: true,
        requirePlannedAt: true
      })
    : null;
  const hasTypedSmartOnRetry = hasStoredSmartOnRetry
    && scheduleSnapshot?.smartMode?.enabled === true
    && scheduleSnapshot?.pwmState === 'on'
    && exactHalfHour
    && boundaryAt > 0
    && Number.isFinite(retryScheduledAt)
    && retryScheduledAt > 0
    && Number.isFinite(triggerAt)
    && triggerAt > 0
    && Math.abs(triggerAt - retryScheduledAt)
      <= PWM_RETRY_ALARM_TOLERANCE_MS
    && (!semanticAssessment || semanticAssessment.kind === 'typed-retry');
  const hasSafetyTimerRetry = retryKind === 'smart-on-safety-timer'
    && scheduleSnapshot?.smartMode?.enabled === true
    && scheduleSnapshot?.pwmState === 'on'
    && Number.isFinite(retryScheduledAt)
    && retryScheduledAt > 0
    && Number.isFinite(triggerAt)
    && triggerAt > 0
    && Math.abs(triggerAt - retryScheduledAt)
      <= PWM_RETRY_ALARM_TOLERANCE_MS
    && (!semanticAssessment
      || semanticAssessment.kind === 'safety-timer-retry');
  return {
    hasStoredSmartOnRetry,
    hasTypedSmartOnRetry,
    hasSafetyTimerRetry,
    kind: hasTypedSmartOnRetry || hasSafetyTimerRetry ? retryKind : '',
    boundaryAt: hasTypedSmartOnRetry || hasSafetyTimerRetry ? boundaryAt : 0,
    priorError: hasTypedSmartOnRetry || hasSafetyTimerRetry
      ? String(scheduleSnapshot?.pageTimerError || '')
      : ''
  };
}

function getActiveSmartOnPwmRetryContext(
  scheduleSnapshot,
  liveAlarmScheduledTime = 0,
  options = {}
) {
  const liveAt = Number(liveAlarmScheduledTime);
  const storedAt = Number(scheduleSnapshot?.nextTriggerAt);
  // live alarm 是浏览器当前所有权；存在时不得退回匹配可能已经过期的 storage。
  const authoritativeTriggerAt = Number.isFinite(liveAt) && liveAt > 0
    ? liveAt
    : storedAt;
  return getSmartOnPwmRetryContext(
    scheduleSnapshot,
    authoritativeTriggerAt,
    options
  );
}

function getOwnedSmartOnClockException(
  scheduleSnapshot,
  scheduledTime,
  now = Date.now()
) {
  const liveAt = Number(scheduledTime);
  const storedAt = Number(scheduleSnapshot?.nextTriggerAt);
  // 与 typed retry 的 ownership 规则一致：live alarm 存在时它是权威；若
  // Chrome 丢钟，则 durable storage 仍须保护 safe-delay / safety-skip 意图，
  // 直到 lifecycle 明确恢复或撤销，不能让 sync/page picker 趁空覆盖。
  const candidateAt = Number.isFinite(liveAt) && liveAt > 0
    ? liveAt
    : storedAt;
  const assessment = classifySmartOnClock(scheduleSnapshot, candidateAt, {
    now,
    plannedAt: Number(scheduleSnapshot?.smartClockPlannedAt)
      || Number(scheduleSnapshot?.alarmCreatedAt)
      || 0,
    nextAction: scheduleSnapshot?.pwmState,
    toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
    allowDue: true,
    requirePlannedAt: true
  });
  const hasOwnedException = candidateAt > 0
    && assessment.valid
    && (assessment.kind === 'typed-retry'
      || assessment.kind === 'safety-skip'
      || assessment.kind === 'safety-timer-retry');
  return { ...assessment, hasOwnedException };
}

function assessPwmAlarmDelivery(
  scheduleSnapshot,
  scheduledTime,
  now = Date.now()
) {
  const eventAt = Number(scheduledTime);
  const storedNextAt = Number(scheduleSnapshot?.nextTriggerAt);
  const legacyAt = Number(scheduleSnapshot?.alarmCreatedAt)
    + Number(scheduleSnapshot?.alarmDelayMinutes) * 60000;
  const durableAt = Number.isFinite(storedNextAt) && storedNextAt > 0
    ? storedNextAt
    : (Number.isFinite(legacyAt) && legacyAt > 0 ? legacyAt : 0);
  if (!Number.isFinite(eventAt) || eventAt <= 0 || durableAt <= 0) {
    return { accepted: false, reason: 'missing-durable-clock', eventAt, durableAt };
  }
  // 即使送达事件本身已失配，也先审计 durable clock 的智能语义。这样
  // 19:00 旧事件撞上“计划于 18:56 的非法 19:30 ON”时，repair 仍能拿到
  // expectedAt=19:00，而不是退化成无边界普通修复并再次跳到 19:30。
  const smartClockAssessment = classifySmartOnClock(
    scheduleSnapshot,
    durableAt,
    {
      now,
      plannedAt: Number(scheduleSnapshot?.smartClockPlannedAt)
        || Number(scheduleSnapshot?.alarmCreatedAt)
        || 0,
      nextAction: scheduleSnapshot?.pwmState,
      toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
      allowDue: true,
      requirePlannedAt: true
    }
  );
  if (Math.abs(eventAt - durableAt) > PWM_RETRY_ALARM_TOLERANCE_MS) {
    return {
      accepted: false,
      reason: 'alarm-owner-mismatch',
      eventAt,
      durableAt,
      ...(smartClockAssessment.applicable && !smartClockAssessment.valid
        ? { smartClockAssessment }
        : {})
    };
  }
  const comfortStartUntil = Number(scheduleSnapshot?.comfortStartUntil);
  if (Number.isFinite(comfortStartUntil)
      && comfortStartUntil > 0
      && eventAt <= comfortStartUntil + PWM_RETRY_ALARM_TOLERANCE_MS) {
    return {
      accepted: true,
      reason: 'comfort-start-durable-clock',
      eventAt,
      durableAt
    };
  }
  if (smartClockAssessment.applicable && !smartClockAssessment.valid) {
    return {
      accepted: false,
      reason: smartClockAssessment.kind,
      eventAt,
      durableAt,
      smartClockAssessment
    };
  }
  return { accepted: true, reason: 'durable-clock-match', eventAt, durableAt };
}

async function hasDurableLivePwmOwner(automationRevision, options = {}) {
  if (!isAutomationOperationCurrent(automationRevision)) return false;
  const [saved, liveAlarm] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    chrome.alarms.get('ac-pwm')
  ]);
  if (!isAutomationOperationCurrent(automationRevision)) return false;
  const durableSchedule = saved?.[STORAGE_KEY];
  if (!durableSchedule || typeof durableSchedule !== 'object') return false;

  const now = Date.now();
  const memoryAt = Number(schedule.nextTriggerAt) || 0;
  const durableAt = Number(durableSchedule.nextTriggerAt) || 0;
  const liveAt = Number(liveAlarm?.scheduledTime) || 0;
  if (memoryAt <= now || durableAt <= now || liveAt <= now
      || durableSchedule.pwmState !== schedule.pwmState
      || Math.abs(memoryAt - durableAt) > PWM_RETRY_ALARM_TOLERANCE_MS
      || Math.abs(liveAt - durableAt) > PWM_RETRY_ALARM_TOLERANCE_MS) {
    return false;
  }
  const delivery = assessPwmAlarmDelivery(
    durableSchedule,
    liveAt,
    now
  );
  if (delivery.accepted !== true) return false;

  const expectedBoundaryAt = Number(options.expectedSmartOnBoundaryAt) || 0;
  if (expectedBoundaryAt > 0) {
    // preserve-revoke 只能保护仍拥有原始半点的完整 replacement。
    // 这防止旧 generic repair 用新 plannedAt 把 19:30 “洗成” nearest
    // boundary，同时允许 19:05 typed retry 或已 ON 后的 19:23 OFF 钟被保护。
    const durableBoundaryAt = Number(durableSchedule.smartOnBoundaryAt) || 0;
    const durableRetryBoundaryAt = Number(durableSchedule.pwmRetryBoundaryAt) || 0;
    const durableRetryKind = String(durableSchedule.pwmRetryKind || '');
    const retryOwnsBoundary = [
      'smart-on',
      'smart-on-safe-delay',
      'smart-on-safety-skip',
      'smart-on-safety-timer'
    ].includes(durableRetryKind)
      && durableRetryBoundaryAt === expectedBoundaryAt;
    const exactBoundaryOwner = durableSchedule.pwmState === 'on'
      && Math.abs(durableAt - expectedBoundaryAt)
        <= PWM_RETRY_ALARM_TOLERANCE_MS;
    const expectedOffAt = smartModePageTimerTargetAt(
      Number(durableSchedule.onMinutes),
      now,
      expectedBoundaryAt
    );
    const completedOnOwner = durableSchedule.pwmState === 'off'
      && durableBoundaryAt === expectedBoundaryAt
      && expectedOffAt > now
      && Math.abs(durableAt - expectedOffAt)
        <= PWM_RETRY_ALARM_TOLERANCE_MS;
    if (!retryOwnsBoundary && !exactBoundaryOwner && !completedOnOwner) {
      return false;
    }
  }
  return true;
}

// replacement owner 的证明本身含 storage/alarm await。等待期间 revision
// 可能再次换主；只能保护一个在证明结束时仍是 current 的 owner。
async function proveStableDurableLivePwmOwner(
  initialRevision,
  reason = 'phase replacement owner'
) {
  let candidateRevision = Number.isSafeInteger(initialRevision)
    ? initialRevision
    : pwmRuntimeRevision;
  let lastProofError = null;

  // phase reservation 会拦截自动 phase 入口；少数已经在途的显式设置
  // 仍可换主。有界重证避免在持续用户操作下占住 SW；未稳定则由调用方
  // 按最新 revision 排队 repair，绝不把一次 stale proof 当成成功。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isAutomationAllowed()) {
      return {
        automationAllowed: false,
        committed: false,
        stable: true,
        automationRevision: pwmRuntimeRevision,
        proofError: lastProofError
      };
    }

    let committed = false;
    try {
      committed = await hasDurableLivePwmOwner(candidateRevision);
    } catch (error) {
      lastProofError = error;
      console.warn(`[AC扩展] ${reason} 收口证明读取失败:`, error?.message);
    }

    if (!isAutomationAllowed()) {
      return {
        automationAllowed: false,
        committed: false,
        stable: true,
        automationRevision: pwmRuntimeRevision,
        proofError: lastProofError
      };
    }
    if (isAutomationOperationCurrent(candidateRevision)) {
      return {
        automationAllowed: true,
        committed,
        stable: true,
        automationRevision: candidateRevision,
        proofError: lastProofError
      };
    }
    candidateRevision = pwmRuntimeRevision;
  }

  return {
    automationAllowed: isAutomationAllowed(),
    committed: false,
    stable: false,
    automationRevision: pwmRuntimeRevision,
    proofError: lastProofError
  };
}

function prepareFreshPwmStartState() {
  clearPwmRetryState();
  schedule.pwmState = 'on';
  setNextTriggerAt(0);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
}

function applyPwmPlanState(plan) {
  if (plan?.proofAction === 'clear') clearPageTimerProofState();
  if (plan?.phasePatch) {
    const phasePatch = { ...plan.phasePatch };
    const hasNextTrigger = Object.prototype.hasOwnProperty.call(
      phasePatch,
      'nextTriggerAt'
    );
    const nextTriggerAt = phasePatch.nextTriggerAt;
    delete phasePatch.nextTriggerAt;
    Object.assign(schedule, phasePatch);
    if (hasNextTrigger) {
      setNextTriggerAt(nextTriggerAt, {
        plannedAt: Number(plan?.smartClockPlannedAt) || 0
      });
    }
  }
}

async function resetDisabledPwmRuntime() {
  pwmRuntimeRevision += 1;
  await cancelAutomaticOnRequests();
  scheduleLoadBlockedRevision = pwmRuntimeRevision;
  lastPwmStepAt = 0;
  schedule.comfortStartUntil = 0;
  schedule.comfortStartOnConfirmedAt = 0;
  schedule.pwmState = 'off';
  schedule.smartOnBoundaryAt = 0;
  schedule.pwmRetryKind = '';
  schedule.pwmRetryBoundaryAt = 0;
  schedule.pwmRetryScheduledAt = 0;
  setNextTriggerAt(0);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  await clearPwmAlarm(null, true);
  await chrome.alarms.clear('ac-badge-tick');
  await chrome.alarms.clear('ac-watchdog');
  await chrome.alarms.clear('ac-comfort-end');
  await updateBadge();
}

async function persistReconciledPwmTrigger(
  alarm,
  reason,
  options,
  automationRevision = typeof pwmRuntimeRevision === 'number'
    ? pwmRuntimeRevision
    : null
) {
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || (automationRevision !== null
        && typeof isAutomationOperationCurrent === 'function'
        && !isAutomationOperationCurrent(automationRevision))) {
    return null;
  }
  const plan = reconcilePwmTrigger(schedule, alarm, options);
  if (plan.kind !== 'sync-live') return null;
  const smartClockAssessment = typeof classifySmartOnClock === 'function'
    ? classifySmartOnClock(schedule, plan.liveScheduledTime, {
        now: Date.now(),
        plannedAt: Number(schedule.smartClockPlannedAt)
          || Number(schedule.alarmCreatedAt)
          || 0,
        nextAction: schedule.pwmState,
        toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
        requirePlannedAt: true
      })
    : null;
  if (smartClockAssessment?.applicable && !smartClockAssessment.valid) {
    console.warn(
      `[AC扩展] 拒绝把语义无效智能 ON 闹钟写回 storage (${smartClockAssessment.kind})`
    );
    return null;
  }
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || (automationRevision !== null
        && typeof isAutomationOperationCurrent === 'function'
        && !isAutomationOperationCurrent(automationRevision))) {
    return null;
  }

  applyPwmPlanState(plan);
  await persistSchedule(reason, { syncFromLiveAlarm: false });
  return plan;
}

async function syncStoredTriggerFromAlarm(
  alarm,
  reason = '从现有 PWM 闹钟同步绝对触发时间',
  automationRevision = typeof pwmRuntimeRevision === 'number'
    ? pwmRuntimeRevision
    : null
) {
  const plan = await persistReconciledPwmTrigger(
    alarm,
    reason,
    PWM_TRIGGER_STRICT_OPTIONS,
    automationRevision
  );
  if (!plan) return false;

  console.log(`[AC扩展] ${reason}: ${new Date(plan.liveScheduledTime).toLocaleTimeString()}`);
  return true;
}

function getLiveAlarmEndMs(alarm) {
  const scheduledTime = alarm?.scheduledTime;
  return scheduledTime && scheduledTime > Date.now() ? scheduledTime : 0;
}

async function backfillNextTriggerAt(persist = false) {
  if (schedule.nextTriggerAt) return schedule.nextTriggerAt;

  // 第一层：用已保存的阶段时间重算
  const legacyEnd = getLegacyAlarmEndMs();
  if (legacyEnd) {
    const legacyClockAssessment = classifySmartOnClock(schedule, legacyEnd, {
      now: Date.now(),
      plannedAt: Number(schedule.smartClockPlannedAt)
        || Number(schedule.alarmCreatedAt)
        || 0,
      nextAction: schedule.pwmState,
      toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
      requirePlannedAt: true
    });
    if (!legacyClockAssessment.applicable || legacyClockAssessment.valid) {
      setNextTriggerAt(legacyEnd);
      if (persist) {
        await persistSchedule('backfillNextTriggerAt', { syncFromLiveAlarm: false });
      }
      return legacyEnd;
    }
    console.warn(
      `[AC扩展] backfillNextTriggerAt: 拒绝语义无效智能 ON legacy clock (${legacyClockAssessment.kind})`
    );
  }

  // 第二层：legacy 字段也丢了，但 live alarm 还在 → 从 alarm 恢复
  if (isAutomationAllowed()) {
    const automationRevision = pwmRuntimeRevision;
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    if (!isAutomationOperationCurrent(automationRevision)) return 0;
    const plan = reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS);
    if (plan.kind === 'sync-live') {
      const smartClockAssessment = classifySmartOnClock(
        schedule,
        plan.liveScheduledTime,
        {
          now: Date.now(),
          plannedAt: Number(schedule.smartClockPlannedAt)
            || Number(schedule.alarmCreatedAt)
            || 0,
          nextAction: schedule.pwmState,
          toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
          requirePlannedAt: true
        }
      );
      if (smartClockAssessment.applicable && !smartClockAssessment.valid) {
        console.warn(
          `[AC扩展] backfillNextTriggerAt: 拒绝语义无效智能 ON live alarm (${smartClockAssessment.kind})`
        );
        return 0;
      }
      applyPwmPlanState(plan);
      if (persist) {
        await persistSchedule('backfillNextTriggerAt-fromLiveAlarm', { syncFromLiveAlarm: false });
      }
      console.log(`[AC扩展] backfillNextTriggerAt: 从 live alarm 恢复 nextTriggerAt=${new Date(plan.liveScheduledTime).toLocaleTimeString()}`);
      return plan.liveScheduledTime;
    }
  }

  return 0;
}

// 从已过期的闹钟时间推进到下一个未来周期边界。
// 不会点击 AC 开关；但若恢复后理论上正处于 ON 阶段，必须先重新武装并
// 通过新鲜页面确认 Power-off after，不能直接造出无关机证明的 OFF 相位。
async function advanceExpiredAlarmToNextBoundary(
  expiredScheduledTime,
  automationRevision = pwmRuntimeRevision,
  phaseAdmissionEpoch = 0
) {
  const recovery = await recoverPwmLifecycle({
    source: 'expired-alarm',
    automationRevision,
    phaseAdmissionEpoch,
    expiredAlarmAt: expiredScheduledTime,
    liveAlarmAt: 0,
    storedAlarmAt: 0,
    plannedActionAt: 0,
    missingClockAction: 'noop',
    failureAction: 'none'
  });
  if (recovery.handled !== true) return false;

  // shared executor 的 cooldown/early-return 过去会被包装成 handled=true。
  // adoption 已清旧钟时，只有 durable future owner 与 live ac-pwm 同时存在
  // 且对齐，才算真的推进成功；否则由 adoption catch 走 fresh-status repair。
  const now = Date.now();
  const durableAt = Number(schedule.nextTriggerAt) || 0;
  const liveAt = Number((await chrome.alarms.get('ac-pwm'))?.scheduledTime) || 0;
  return durableAt > now
    && liveAt > now
    && Math.abs(durableAt - liveAt) <= PWM_RETRY_ALARM_TOLERANCE_MS;
}

// 普通循环模式的过期相位执行器。策略选择由 recoverPwmLifecycle 统一完成；
// 本函数只保留页面定时器、闹钟与 storage 等副作用。
async function executeExpiredIntervalRecovery(
  expiredScheduledTime,
  automationRevision = pwmRuntimeRevision
) {
  if (!isAutomationOperationCurrent(automationRevision)) return false;

  const recoverySchedule = { ...schedule };
  let observations = {};
  let plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);
  if (plan.kind === 'noop' || plan.kind === 'refuse') {
    if (plan.kind === 'refuse') {
      console.warn(`[AC扩展] 过期闹钟恢复被拒绝: ${plan.reason}`);
    }
    return false;
  }

  if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
    const status = await getCurrentACStatus();
    if (await abortStaleAutomation(
      automationRevision,
      'advance-expired-active-hours-paused'
    )) return false;
    observations = { acIsOn: status?.isOn };
    plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);

    if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
      applyPwmPlanState(plan);
      const timerResult = await setPageTimer(plan.timerMinutes, {
        retryOnFailure: false,
        automationRevision
      });
      if (await abortStaleAutomation(
        automationRevision,
        'advance-expired-page-timer-active-hours-paused'
      )) return false;
      observations = {
        ...observations,
        pageTimerSucceeded: !!timerResult?.success,
        pageTimerTargetAt: Number(timerResult?.targetAt)
      };
      plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);
    }
  }

  if (plan.kind === 'retry') {
    applyPwmPlanState(plan);
    schedule.pageTimerError = `过期闹钟恢复时页面关机定时器未确认：${schedule.pageTimerError || '未知错误'}；1 分钟后重试`;
    await persistSchedule('advanceExpiredAlarmToNextBoundary-retry-intent', {
      syncFromLiveAlarm: false
    });
    await clearPwmAlarm(automationRevision);
    const alarmCreated = await createPwmAlarmFromPlan(
      plan,
      'advance-pageTimer-failed',
      automationRevision
    );
    if (alarmCreated === false) {
      schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复';
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      await persistSchedule('advanceExpiredAlarmToNextBoundary-retry-alarm-failed', {
        syncFromLiveAlarm: false
      });
      return false;
    }
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      automationRevision,
      'advance-retry-active-hours-paused'
    )) return false;
    await persistSchedule('advanceExpiredAlarmToNextBoundary-pageTimer-failed', { syncFromLiveAlarm: false });
    await updateBadge();
    return true;
  }

  if (plan.kind !== 'commit') return false;

  applyPwmPlanState(plan);
  if (plan.proofAction === 'clear') {
    await chrome.alarms.clear('ac-page-timer-retry');
  }
  await persistSchedule('advanceExpiredAlarmToNextBoundary-commit-intent', {
    syncFromLiveAlarm: false
  });
  await clearPwmAlarm(automationRevision);
  const alarmCreated = await createPwmAlarmFromPlan(
    plan,
    'advance-recovery',
    automationRevision
  );
  if (alarmCreated === false) {
    schedule.pageTimerError = '过期相位已推进，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复';
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    await persistSchedule('advanceExpiredAlarmToNextBoundary-commit-alarm-failed', {
      syncFromLiveAlarm: false
    });
    return false;
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (await abortStaleAutomation(
    automationRevision,
    'advance-commit-active-hours-paused'
  )) return false;
  await persistSchedule('advanceExpiredAlarmToNextBoundary', { syncFromLiveAlarm: false });
  await updateBadge();

  console.log(`[AC扩展] 从过期闹钟推进: 原=${new Date(expiredScheduledTime).toLocaleTimeString()} 新=${new Date(schedule.nextTriggerAt).toLocaleTimeString()} 下一动作=${schedule.pwmState}`);
  return true;
}

function isTrustedHalfHourAlarmBoundary(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return false;
  const lowerBoundaryAt = halfHourBoundaryAtOrBefore(value);
  const upperBoundaryAt = nextHalfHourBoundary(value);
  return Math.min(
    Math.abs(value - lowerBoundaryAt),
    Math.abs(upperBoundaryAt - value)
  ) <= PWM_RETRY_ALARM_TOLERANCE_MS;
}

async function restoreIntervalAlarmFromStorage(reason = '按 storage 剩余时间恢复 PWM 闹钟') {
  if (!isAutomationAllowed()) return false;
  const automationRevision = pwmRuntimeRevision;

  const now = Date.now();
  const liveAlarm = await chrome.alarms.get('ac-pwm');
  if (!isAutomationOperationCurrent(automationRevision)) return false;
  const liveDueAt = getLiveAlarmEndMs(liveAlarm);
  const storedDueAt = getStoredAlarmEndMs();
  const targetDueAt = liveDueAt || (storedDueAt > now ? storedDueAt : 0);

  if (!targetDueAt || targetDueAt <= now) return false;
  const smartClockAssessment = classifySmartOnClock(
    schedule,
    targetDueAt,
    {
      now,
      plannedAt: Number(schedule.smartClockPlannedAt)
        || Number(schedule.alarmCreatedAt)
        || 0,
      nextAction: schedule.pwmState,
      toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
      requirePlannedAt: true
    }
  );
  if (smartClockAssessment.applicable && !smartClockAssessment.valid) {
    console.warn(
      `[AC扩展] 拒绝恢复不可信智能 ON 时钟 (${smartClockAssessment.kind})，改由 lifecycle 重建`
    );
    return false;
  }

  if (liveDueAt) {
    await syncStoredTriggerFromAlarm(
      liveAlarm,
      `${reason}（沿用现有活闹钟）`,
      automationRevision
    );
    await updateBadge();
    return true;
  }

  const remainingMinutes = Math.max(1, (targetDueAt - now) / 60000);
  await clearPwmAlarm(automationRevision);
  const alarmCreated = await createPwmAlarmFromPlan(
    { nextTriggerAt: targetDueAt },
    'restore-interval',
    automationRevision
  );
  if (alarmCreated === false) {
    schedule.pageTimerError = 'storage 时钟恢复时 PWM 闹钟创建失败；等待看门狗继续恢复';
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    await persistSchedule('restore-interval-alarm-failed', { syncFromLiveAlarm: false });
    return false;
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (!isAutomationOperationCurrent(automationRevision)) return false;
  await persistSchedule(reason, { syncFromLiveAlarm: false });

  await updateBadge();
  console.log(`[AC扩展] ${reason}，剩余 ${remainingMinutes.toFixed(2)} 分钟`);
  return true;
}

async function createAlarm(name, info) {
  try {
    const isAutomationRuntimeAlarm = AUTOMATION_RUNTIME_ALARMS.has(name);
    if (isAutomationRuntimeAlarm && !isAutomationAllowed()) {
      await chrome.alarms.clear(name);
      return false;
    }

    const { persistAcrossSessions, ...safeInfo } = info || {};
    await chrome.alarms.create(name, safeInfo);
    if (isAutomationRuntimeAlarm && !isAutomationAllowed()) {
      await chrome.alarms.clear(name);
      return false;
    }

    // 验证创建成功
    const verify = await chrome.alarms.get(name);
    if (!verify) console.error('[AC扩展] createAlarm 失败: ' + name + ' ' + JSON.stringify(safeInfo));
    return !!verify;
  } catch (e) {
    console.error('[AC扩展] createAlarm 异常: ' + name, e?.message);
    void appendDiagnosticLog('error', 'create-alarm', e);
    return false;
  }
}

let pwmAlarmWriteChain = Promise.resolve();

function runSerializedPwmAlarmWrite(operation) {
  const queued = pwmAlarmWriteChain
    .catch(() => {})
    .then(operation);
  pwmAlarmWriteChain = queued.catch(() => {});
  return queued;
}

function isPwmAlarmWriteCurrent(automationRevision) {
  return automationRevision === null
    ? isAutomationAllowed()
    : isAutomationOperationCurrent(automationRevision);
}

async function failPwmAlarmWrite(logTag, error = null) {
  const detail = error?.message || String(error || '创建后验证失败');
  console.error(`[AC扩展] ${logTag}: PWM 闹钟写入失败`, detail);
  try {
    await chrome.alarms.clear('ac-pwm');
  } catch (clearError) {
    console.error(`[AC扩展] ${logTag}: PWM 失败收口清理异常`, clearError?.message);
  }
  return false;
}

async function clearPwmAlarm(automationRevision = null, force = false) {
  return runSerializedPwmAlarmWrite(async () => {
    if (!force && !isPwmAlarmWriteCurrent(automationRevision)) return false;
    await chrome.alarms.clear('ac-pwm');
    return force || isPwmAlarmWriteCurrent(automationRevision);
  });
}

async function clearAutomationRuntimeAlarmsWhileBlocked(
  blockedRevision = pwmRuntimeRevision
) {
  const blockIsCurrent = () => (
    blockedRevision === pwmRuntimeRevision && !isAutomationAllowed()
  );
  if (!blockIsCurrent()) return false;

  await clearPwmAlarm(null, true);
  if (!blockIsCurrent()) return false;
  await chrome.alarms.clear('ac-badge-tick');
  if (!blockIsCurrent()) return false;
  await chrome.alarms.clear('ac-watchdog');
  if (!blockIsCurrent()) return false;
  await chrome.alarms.clear('ac-comfort-end');
  return blockIsCurrent();
}

async function createPwmAlarmWithVerify(
  delay,
  logTag = 'PWM',
  automationRevision = null
) {
  return runSerializedPwmAlarmWrite(async () => {
    if (!isPwmAlarmWriteCurrent(automationRevision)) return false;
    try {
      const alarmCreatedAt = Date.now();
      const alarmDelayMinutes = Number(delay);
      if (!Number.isFinite(alarmDelayMinutes) || alarmDelayMinutes <= 0) {
        return failPwmAlarmWrite(logTag, new Error('PWM 延迟不是正数'));
      }
      let created = await createAlarm('ac-pwm', { delayInMinutes: alarmDelayMinutes });
      if (!created && isPwmAlarmWriteCurrent(automationRevision)) {
        console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
        created = await createAlarm('ac-pwm', { delayInMinutes: alarmDelayMinutes });
      }
      const verify = created ? await chrome.alarms.get('ac-pwm') : null;
      if (!created || !verify || !isPwmAlarmWriteCurrent(automationRevision)) {
        return failPwmAlarmWrite(logTag);
      }

      schedule.alarmCreatedAt = alarmCreatedAt;
      schedule.alarmDelayMinutes = alarmDelayMinutes;
      setNextTriggerAt(verify.scheduledTime
        || (alarmCreatedAt + alarmDelayMinutes * 60000));
      return true;
    } catch (error) {
      return failPwmAlarmWrite(logTag, error);
    }
  });
}

async function createPwmAlarmFromPlan(
  plan,
  logTag = 'PWM',
  automationRevision = null
) {
  const nextTriggerAt = Number(plan?.nextTriggerAt);
  if (!Number.isFinite(nextTriggerAt) || nextTriggerAt <= Date.now()) {
    console.error(`[AC扩展] ${logTag}: PWM plan 缺少未来触发时间`);
    return false;
  }

  return runSerializedPwmAlarmWrite(async () => {
    if (!isPwmAlarmWriteCurrent(automationRevision)) return false;
    try {
      const alarmCreatedAt = Date.now();
      if (nextTriggerAt <= alarmCreatedAt) {
        return failPwmAlarmWrite(logTag, new Error('PWM 目标在排队期间已过期'));
      }
      const alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - alarmCreatedAt) / 60000
      );
      let created = await createAlarm('ac-pwm', { when: nextTriggerAt });
      let verify = created ? await chrome.alarms.get('ac-pwm') : null;
      if ((!created || !verify) && isPwmAlarmWriteCurrent(automationRevision)) {
        console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
        created = await createAlarm('ac-pwm', { when: nextTriggerAt });
        verify = created ? await chrome.alarms.get('ac-pwm') : null;
      }
      if (!created || !verify || !isPwmAlarmWriteCurrent(automationRevision)) {
        return failPwmAlarmWrite(logTag);
      }

      schedule.alarmCreatedAt = alarmCreatedAt;
      schedule.alarmDelayMinutes = alarmDelayMinutes;
      setNextTriggerAt(verify.scheduledTime || nextTriggerAt);
      return true;
    } catch (error) {
      return failPwmAlarmWrite(logTag, error);
    }
  });
}

async function loadScheduleFromStorage() {
  // Phase adoption 在 reservation 内先换 revision、再提交 durable intent。
  // Popup/诊断的普通 reload 不能在这段窗口把旧 storage 合并回新内存相位。
  if (isSyncPhaseAdoptionAdmissionBlocked()) return schedule;
  const automationRevision = pwmRuntimeRevision;
  if (scheduleLoadBlockedRevision === automationRevision) return schedule;
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (isSyncPhaseAdoptionAdmissionBlocked()
      || automationRevision !== pwmRuntimeRevision
      || scheduleLoadBlockedRevision === automationRevision) return schedule;
  if (saved[STORAGE_KEY]) {
    schedule = { ...schedule, ...saved[STORAGE_KEY] };
    if (!(Number(schedule.smartClockPlannedAt) > 0)
        && Number(schedule.nextTriggerAt) > 0
        && Number(schedule.alarmCreatedAt) > 0) {
      schedule.smartClockPlannedAt = Number(schedule.alarmCreatedAt);
    }
  }
  return schedule;
}

async function persistSchedule(reason = '', options = {}) {
  const {
    syncFromLiveAlarm = true,
    markSyncPublishPending = false
  } = options;
  if (!schedule.smartMode?.enabled) {
    schedule.smartOnBoundaryAt = 0;
    schedule.pwmRetryKind = '';
    schedule.pwmRetryBoundaryAt = 0;
    schedule.pwmRetryScheduledAt = 0;
  }

  if (syncFromLiveAlarm && isAutomationAllowed()) {
    const automationRevision = pwmRuntimeRevision;
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    if (isAutomationOperationCurrent(automationRevision)) {
      const plan = reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS);
      if (plan.kind === 'sync-live') {
        const smartClockAssessment = typeof classifySmartOnClock === 'function'
          ? classifySmartOnClock(schedule, plan.liveScheduledTime, {
              now: Date.now(),
              plannedAt: Number(schedule.smartClockPlannedAt)
                || Number(schedule.alarmCreatedAt)
                || 0,
              nextAction: schedule.pwmState,
              toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
              requirePlannedAt: true
            })
          : null;
        if (!smartClockAssessment?.applicable || smartClockAssessment.valid) {
          applyPwmPlanState(plan);
          if (reason) {
            console.log(`[AC扩展] ${reason}: 写入前按 live alarm 修正 nextTriggerAt`);
          }
        } else {
          console.warn(
            `[AC扩展] ${reason}: 拒绝语义无效智能 ON live alarm (${smartClockAssessment.kind})`
          );
        }
      }
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...schedule },
    ...(markSyncPublishPending
      ? { [SYNC_PENDING_PUBLISH_KEY]: true }
      : {})
  });
  if (scheduleLoadBlockedRevision === pwmRuntimeRevision) {
    scheduleLoadBlockedRevision = null;
  }
}

// ============================================================
// 跨设备同步 — chrome.storage.sync 集成层
// ============================================================
//
// 触发同步写入的时机（节流策略，远低于 sync 配额 100 写/小时、1200 写/天）：
//   • runPwmStep 每次成功的阶段翻转 (toggleOk=true) — 60min 周期 ≈ 24 写/天
//   • updateSchedule handler（用户改设置/toggle）— 用户发起，低频
//   • onInstalled install—— push 默认配置到 sync（若 sync 为空）
//   • init() 启动时—— 不写入，只读采纳
//
// 不同步：__heartbeat（20s 一次会打爆配额）、pageTimer*（本机页面态）、
//        alarmCreatedAt/alarmDelayMinutes（旧版字段）、watchdogCheck 的微调（噪音）。
// 失败重试时不同步（pwmState 没变，避免 PWM 死循环反复打 sync）。
//
// 同步对象结构（瘦化）：见 sync-helpers.js 的 composeSyncPayload。
// 自回环抑制：自己写入的 sync 会触发本地 onChanged，通过 syncedAt 对比识别为自写
// 并静默跳过——computePhaseAdoption 内部 lastSyncedAt 守卫已覆盖。
//
// 优雅降级：用户未登录浏览器同步 / sync 配额超限 / 企业策略禁用 → 异常被静默吞掉，
// 行为退化为现有本地 storage 模式（无回归）。

const _syncOpLock = {
  busy: false,
  pending: false,
  pendingReason: '',
  pendingRemote: null,
  pendingOutbound: false,
  pendingOutboundReason: ''
};

async function setSyncPublishPending(pending) {
  try {
    if (pending) {
      await chrome.storage.local.set({ [SYNC_PENDING_PUBLISH_KEY]: true });
    } else {
      await chrome.storage.local.remove(SYNC_PENDING_PUBLISH_KEY);
    }
    return true;
  } catch (error) {
    console.warn('[AC扩展] sync pending marker 写入失败:', error?.message);
    return false;
  }
}

async function getSyncPublishPending() {
  try {
    const stored = await chrome.storage.local.get(SYNC_PENDING_PUBLISH_KEY);
    return stored?.[SYNC_PENDING_PUBLISH_KEY] === true;
  } catch (error) {
    console.warn('[AC扩展] sync pending marker 读取失败:', error?.message);
    return null;
  }
}

async function scheduleSyncRetry(kind = 'publish') {
  const alarmName = kind === 'adopt'
    ? 'ac-sync-adopt-retry'
    : 'ac-sync-publish-retry';
  return createAlarm(alarmName, { delayInMinutes: 1 });
}

async function loadSyncWatermark() {
  if (syncWatermarkLoaded) return lastSyncedAt;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stored = await chrome.storage.local.get(SYNC_WATERMARK_KEY);
      lastSyncedAt = Math.max(
        lastSyncedAt,
        Number(stored?.[SYNC_WATERMARK_KEY]) || 0
      );
      syncWatermarkLoaded = true;
      return lastSyncedAt;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn('[AC扩展] sync watermark 读取失败:', lastError?.message);
  // 一次有界重读仍失败时，不得把 0 当成已加载。入站采纳
  // 必须 fail closed，否则本机旧安全哨兵可能在 SW 重启后回滚新相位。
  // 返回 null 只停止本次 sync，不中断 init 后续的本地闹钟恢复。
  return null;
}

async function persistSyncWatermark(value) {
  const requestedAt = Number(value) || 0;
  if (!(requestedAt > 0)) return false;
  const write = syncWatermarkWriteChain.then(async () => {
    const watermarkAt = Math.max(lastSyncedAt, requestedAt);
    // 内存水位先单调前进，即使 local 暂时写失败，本 SW 生命周期内
    // 也不会重放已确认的快照；重启后仍会从上次 durable 水位重试。
    lastSyncedAt = watermarkAt;
    syncWatermarkLoaded = true;
    try {
      await chrome.storage.local.set({ [SYNC_WATERMARK_KEY]: watermarkAt });
      return true;
    } catch (error) {
      console.warn('[AC扩展] sync watermark 写入失败:', error?.message);
      return false;
    }
  });
  syncWatermarkWriteChain = write.catch(() => {});
  return write;
}

// 把当前内存 schedule 瘦化后写入 chrome.storage.sync。
// reason 用于日志。失败静默降级。
async function syncScheduleToSync(reason = '') {
  if (!chrome.storage?.sync) return;  // 受限上下文（incognito / 策略禁用）
  syncPublishGeneration += 1;
  syncWriteOperationsInFlight += 1;
  // 同一 SW 内的外发写串行，避免 T2 先完成、T1 后完成导致
  // sync store 与 durable watermark 倒退。
  const previousWrite = syncWriteChain;
  let releaseWrite;
  syncWriteChain = new Promise(resolve => { releaseWrite = resolve; });
  // 在第一次 await 前先安装共享 barrier；随后到达的 inbound 必须等本次
  // publish 完成。durable marker + alarm 让连续 storage 读取失败或 SW 重启
  // 也不会永久吞掉最后一次本机停用／相位提交。
  const pendingMark = setSyncPublishPending(true);
  const retryAlarm = scheduleSyncRetry('publish');
  try {
    await Promise.allSettled([pendingMark, retryAlarm]);
    await previousWrite.catch(() => {});
    if (_syncOpLock.busy) {
      _syncOpLock.pendingOutbound = true;
      _syncOpLock.pendingOutboundReason = reason;
      return false;
    }
    const loadedWatermark = await loadSyncWatermark();
    if (loadedWatermark === null) {
      throw new Error('sync watermark 暂时不可读，已取消本次 sync 写入');
    }
    // 本次实际写入前读取最新 generation。若后续又有 publish 请求到达，
    // 本次成功也不能清掉由后续请求持有的 durable pending marker。
    const writeGeneration = syncPublishGeneration;
    const wallNow = Date.now();
    // Lamport 式时戳：本机已见过快时钟对端后，后续显式停用等
    // 本地写入仍必须比已知版本新。wallNow 仍用于相位过期判定。
    const writeAt = Math.max(wallNow, lastSyncedAt + 1);
    const retryKind = String(schedule.pwmRetryKind || '');
    // timer-only repair 表示 AC 可能已 ON、但关机保险尚未确认。同步一个
    // 明确的近期 OFF 动作：新版对端会保留任何更早 OFF，而旧版／新设备
    // 也会建 OFF alarm，不会把 enabled=true + 无 phase 误解为立即新开一轮。
    const projectSafetyTimerOff = schedule.smartMode?.enabled === true
      && retryKind === 'smart-on-safety-timer';
    // 其余 smart ON retry/safety-wait 发生在 AC 尚未确认 ON 时。它们投影成
    // “下一半点执行 OFF”的安全哨兵，以替换对端旧 ON actuator；源端提交正常
    // OFF phase 后再同步真实截止。源端中断时，对端也只会幂等确认 OFF。
    const projectSafetySentinel = schedule.smartMode?.enabled === true
      && ['smart-on', 'smart-on-safe-delay', 'smart-on-safety-skip']
        .includes(retryKind);
    const safetySentinelAt = projectSafetySentinel
      ? nextHalfHourBoundary(Math.max(wallNow, Number(schedule.nextTriggerAt) || wallNow))
      : 0;
    const safetyTimerOffAt = projectSafetyTimerOff
      ? Math.max(Number(schedule.nextTriggerAt) || 0, wallNow + 60000)
      : 0;
    const syncSchedule = projectSafetyTimerOff
        ? {
            ...schedule,
            pwmState: 'off',
            nextTriggerAt: safetyTimerOffAt
          }
        : projectSafetySentinel
          ? {
            ...schedule,
            pwmState: 'off',
            nextTriggerAt: safetySentinelAt
            }
          : schedule;
    const slim = {
      ...composeSyncPayload(syncSchedule, wallNow),
      syncedAt: writeAt
    };
    await chrome.storage.sync.set({ [SYNC_KEY]: slim });
    // 只有 sync.set 成功后才能声称该版本已发布。失败写不推进
    // durable watermark，否则重启后会错误屏蔽 sync store 里仍然合法的旧版本。
    const watermarkPersisted = await persistSyncWatermark(writeAt);
    if (!watermarkPersisted) {
      void appendDiagnosticLog(
        'warn',
        'sync-watermark',
        new Error(`sync 已写入但 watermark 未持久化: ${writeAt}`)
      );
      return false;
    }
    if (reason) {
      console.log(`[AC扩展] sync ↑ ${reason}: nextTriggerAt=${slim.nextTriggerAt ? new Date(slim.nextTriggerAt).toLocaleString() : '无'}, enabled=${slim.enabled}`);
    }
    if (syncPublishGeneration === writeGeneration) {
      const markerCleared = await setSyncPublishPending(false);
      if (markerCleared && syncPublishGeneration === writeGeneration) {
        await chrome.alarms.clear('ac-sync-publish-retry');
      }
      // remove/clear 都是异步的；若其间出现新请求，恢复 marker + alarm，
      // 不能让旧成功清理覆盖新请求的持久重试凭证。
      if (syncPublishGeneration !== writeGeneration) {
        await setSyncPublishPending(true);
        await scheduleSyncRetry('publish');
      }
    }
    return true;
  } catch (e) {
    console.warn('[AC扩展] sync 写入失败（未登录浏览器同步 / 配额超限？）:', e?.message);
    void appendDiagnosticLog('warn', 'sync-write', e);
    await scheduleSyncRetry('publish');
    return false;
  } finally {
    syncWriteOperationsInFlight = Math.max(0, syncWriteOperationsInFlight - 1);
    releaseWrite();
  }
}

// 把远端 sync 对象合并到本地 schedule + 重排闹钟。返回 true=已变更并持久化。
// 注意：调用方需要保证不并发（_syncOpLock 守卫）。
async function applySyncedPhase(remote, reason = '') {
  if (!remote || typeof remote !== 'object') return false;
  const syncAdmissionEpoch = typeof automaticDisableAdmissionEpoch === 'number'
    ? automaticDisableAdmissionEpoch
    : 0;
  const syncAdoptionPreempted = () => (
    (typeof automaticOnAdmissionBlocked === 'boolean'
      && automaticOnAdmissionBlocked)
    || (typeof automaticDisableAdmissionEpoch === 'number'
      && automaticDisableAdmissionEpoch !== syncAdmissionEpoch)
  );
  const loadedWatermark = await loadSyncWatermark();
  if (loadedWatermark === null) {
    await scheduleSyncRetry('adopt');
    return false;
  }
  const remoteSyncedAt = Number(remote.syncedAt) || 0;
  // 显式停用是跨时钟的安全优先级。旧版／离线设备可能用较慢墙钟
  // 写出一份在 sync store 中更晚到达、但 syncedAt 数值更小的 disable。
  // 不能因全局 watermark 继续自动控制。
  const lowerClockSafetyDisable = remote?.enabled === false
    && schedule.enabled === true;
  if (remoteSyncedAt > 0
      && remoteSyncedAt <= lastSyncedAt
      && !lowerClockSafetyDisable) {
    console.log(`[AC扩展] sync ↓ ${reason}: 忽略陈旧或自回环快照 syncedAt=${remoteSyncedAt}`);
    return false;
  }

  // 提取（Fowler Extract Function）：同步停用路径——B1 顺序：先 persist 停用状态，再走页面定时器关机。
  async function shutdownAfterSyncDisable({ activeHoursPause = false } = {}) {
    await resetDisabledPwmRuntime();
    // B1（同步停用）：先 persist 停用状态再执行长流程关机 — 防止 SW 在
    // verifyPageTimerPersistence 的 2 分钟+等待中被杀后，storage 仍是 enabled=true
    // 导致重启后闹钟自愈"复活" PWM。末尾 `if (changed)` persist 仍处理相位/activeHours。
    if (activeHoursPause) {
      await persistSchedule('sync-active-hours-paused-pre-shutdown', { syncFromLiveAlarm: false });
    } else {
      await persistSchedule('sync-disabled-pre-shutdown', { syncFromLiveAlarm: false });
    }
    // 自动关机只依赖 UST 页面定时器，不再点击 AC 开关。
    const shutdownResult = activeHoursPause
      ? await requestTimerBasedShutdown('sync-active-hours-paused')
      : await requestTimerBasedShutdown('sync-disabled');
    if (!shutdownResult?.success) {
      schedule.pageTimerError = `${activeHoursPause ? '同步运行时段暂停' : '同步停用'}后页面关机定时器未确认：${shutdownResult?.error || '未知错误'}`;
    }
  }

  // 先记录 enabled 旧值——config 采纳后判断是否需要重建闹钟基础设施
  const wasEnabled = schedule.enabled;
  const wasAutomationAllowed = isAutomationAllowed();
  // retry ownership 必须在 config 写入前捕获；否则远端旧 on/off 会先改坏
  // 本地事务，后面的相位保护即使生效也已经太迟。
  const localPwmAlarmBeforeConfig = wasAutomationAllowed
    ? await chrome.alarms.get('ac-pwm')
    : null;
  if (syncAdoptionPreempted()) {
    console.log(`[AC扩展] sync ↓ ${reason}: 已被更晚的本机明确停用抢占`);
    return false;
  }
  const localRetryBeforeConfig = getActiveSmartOnPwmRetryContext(
    schedule,
    localPwmAlarmBeforeConfig?.scheduledTime
  );
  const localExceptionBeforeConfig = getOwnedSmartOnClockException(
    schedule,
    localPwmAlarmBeforeConfig?.scheduledTime,
    Date.now()
  );
  // 1) config 字段无相位守卫——直接 last-writer-wins 采纳
  const rawCfg = computeConfigDiff(schedule, remote);
  const prospectiveSchedule = { ...schedule, ...rawCfg.fields };
  const retryRemainsOwned = wasAutomationAllowed
    && (localRetryBeforeConfig.hasTypedSmartOnRetry
      || localExceptionBeforeConfig.hasOwnedException)
    && prospectiveSchedule.smartMode?.enabled === true
    && isAutomationAllowedForSchedule(prospectiveSchedule);
  const cfg = protectSmartOnRetryConfigDiff(
    rawCfg,
    retryRemainsOwned
  );
  let configChanged = false;
  let activeHoursChanged = false;
  let remotePhaseRejected = false;
  if (cfg.changed) {
    for (const [k, v] of Object.entries(cfg.fields)) {
      schedule[k] = v;
      if (k === 'activeHours') activeHoursChanged = true;
    }
    configChanged = true;
  }
  const enabledChanged = cfg.fields.enabled !== undefined;
  let nowEnabled = schedule.enabled;
  const automationAllowed = isAutomationAllowed();
  let phaseMetadataChanged = false;

  // 2) 相位字段需通过严格守卫（陈旧/容忍/自回环），computePhaseAdoption 决策
  // 提取（Fowler Extract Function）：相位采纳 + ac-pwm 重排；远端时戳过期则推进到下一未来边界。
  async function adoptPhaseAndRearm(remote, automationAllowed) {
    let automationRevision = pwmRuntimeRevision;
    let phaseAdmissionEpoch = 0;
    const adopt = computePhaseAdoption(schedule, remote, { lastSyncedAt });
    if (!adopt) return false;
    if (isComfortStartActive()) return false;
    if (!automationAllowed || !isAutomationOperationCurrent(automationRevision)) return false;
    // sync payload 不携带本机 retry marker；远端 future clock 只能按 phase
    // 原始生成时刻证明“最近半点”。syncedAt 只是本次配置 push 时间，不能
    // 给旧坏钟重新锚定；旧版本缺失 origin 时 fail closed，只采纳配置。
    const remoteClockAssessment = classifySmartOnClock(
      { ...schedule, pwmState: adopt.pwmState },
      adopt.nextTriggerAt,
      {
        now: Date.now(),
        plannedAt: Number(remote?.smartClockPlannedAt) || 0,
        nextAction: adopt.pwmState,
        toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
        allowDue: true,
        requirePlannedAt: true
      }
    );
    if (remoteClockAssessment.applicable && !remoteClockAssessment.valid) {
      remotePhaseRejected = true;
      console.warn(
        `[AC扩展] sync ↓ ${reason}: 拒绝语义无效智能 ON 时钟 (${remoteClockAssessment.kind})`
      );
      return false;
    }

    const phaseNeedsOwnership = schedule.pwmState !== adopt.pwmState
      || Number(schedule.nextTriggerAt) !== Number(adopt.nextTriggerAt);
    try {
      if (phaseNeedsOwnership) {
        // revision 抢占与旧 live alarm 清除之间存在 await 窗口。先保留一把独立
        // admission reservation，使已送达的旧 alarm/watchdog 也无法趁取消请求
        // 等待期间 claim 新 revision；reservation 直到 durable intent + rearm 收口。
        phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
        if (phaseAdmissionEpoch <= 0) {
          await scheduleSyncRetry('adopt');
          return false;
        }
        automationRevision = pwmRuntimeRevision += 1;
        invalidateTimerBasedShutdown();
        try {
          await cancelAutomaticOnRequests();
        } catch (error) {
          console.warn('[AC扩展] sync 相位抢占：取消旧自动 ON 失败，继续以新 revision 收口:', error?.message);
          void appendDiagnosticLog('warn', 'sync-phase-preempt', error);
        }
        if (syncAdoptionPreempted()) return false;
        if (!isAutomationOperationCurrent(automationRevision)) {
          // 非明确停用的 owner 抢占意味着这份已通过语义门禁的 remote phase
          // 尚未 durable；必须留下重试入口，不能静默丢失。
          await scheduleSyncRetry('adopt');
          return false;
        }
      }

      const oldPwmState = schedule.pwmState;
      const oldTrigger = schedule.nextTriggerAt;
      const oldSmartClockPlannedAt = Number(schedule.smartClockPlannedAt) || 0;
      schedule.pwmState = adopt.pwmState;
      setNextTriggerAt(adopt.nextTriggerAt, {
        plannedAt: Number(remote?.smartClockPlannedAt) || 0
      });
      const phaseChanged = phaseNeedsOwnership
        || oldPwmState !== schedule.pwmState
        || oldTrigger !== schedule.nextTriggerAt;
      const originChanged = oldSmartClockPlannedAt
        !== Number(schedule.smartClockPlannedAt || 0);
      if (!phaseChanged && originChanged) {
        phaseMetadataChanged = true;
        return false;
      }
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (adopt.nextTriggerAt - Date.now()) / 60000);
      if (phaseChanged) clearPwmRetryState();

      if (phaseChanged && automationAllowed) {
        try {
          // 先把远端 phase/绝对边界写成 durable intent，再清旧 live alarm。
          // create=false 时诊断/看门狗才能看见新所有权，而非重载旧 storage 假绿。
          await persistSchedule('sync-phase-adopt-intent', { syncFromLiveAlarm: false });
          await clearPwmAlarm(automationRevision);
          const delayMs = adopt.nextTriggerAt - Date.now();
          if (delayMs > 0) {
            // 用绝对时间调度，让多设备对齐到同一时刻（非 delayInMinutes 各自倒计时）
            const alarmCreated = await createPwmAlarmFromPlan(
              { nextTriggerAt: adopt.nextTriggerAt },
              'sync-phase-adopt',
              automationRevision
            );
            if (alarmCreated === false) {
              schedule.pageTimerError = '同步相位已采纳，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复';
              await persistSchedule('sync-phase-adopt-alarm-failed', {
                syncFromLiveAlarm: false
              });
              throw new Error('同步相位已采纳，但 PWM 闹钟创建失败');
            }
          } else {
            // 远端时戳已过期（在 staleMs 60s 窗口内）——推进到下一未来周期边界
            const advanced = await advanceExpiredAlarmToNextBoundary(
              adopt.nextTriggerAt,
              automationRevision,
              phaseAdmissionEpoch
            );
            if (!advanced) {
              throw new Error('同步过期相位未建立未来恢复时钟');
            }
          }
        } catch (e) {
          console.warn('[AC扩展] sync 合并：重排 ac-pwm 闹钟失败:', e?.message);
          if (!isAutomationOperationCurrent(automationRevision)) {
            // owner-authorized expired recovery 可能已换 revision。只有 storage、
            // 内存和 live alarm 三方收口且语义有效才保护它；仅 claim 未提交的
            // 新 revision 仍须沿原半点立即 fresh-status repair。
            const replacementProof = await proveStableDurableLivePwmOwner(
              pwmRuntimeRevision,
              'sync 新 phase owner'
            );
            if (!replacementProof.automationAllowed) return true;
            const replacementRevision = replacementProof.automationRevision;
            if (replacementProof.stable && replacementProof.committed) {
              void appendDiagnosticLog('warn', 'sync-phase-adopt-post-owner', e);
              return true;
            }
            const recoveryBoundaryAt = remoteClockAssessment.applicable
              ? Number(remoteClockAssessment.boundaryAt)
                || Number(remoteClockAssessment.expectedAt)
                || 0
              : 0;
            schedule.pageTimerError = `同步相位的新 owner 未完成稳定 durable/live 收口：${e?.message || String(e)}；立即修复主钟`;
            queueDeferredScheduleRepair({
              smartOnExpectedBoundaryAt: recoveryBoundaryAt,
              revokeInvalidSmartOnClock: recoveryBoundaryAt > 0,
              revokeOwnerRevision: replacementRevision,
              preserveRevokeAcrossSupersededRepair: recoveryBoundaryAt > 0
            });
            try {
              await createAlarm('ac-watchdog', {
                delayInMinutes: 1,
                periodInMinutes: 5
              });
            } catch (watchdogError) {
              console.warn('[AC扩展] sync 新 owner 未收口后备看门狗创建失败:', watchdogError?.message);
            }
            return true;
          }
          const failedExpectedBoundaryAt = remoteClockAssessment.applicable
            ? Number(remoteClockAssessment.boundaryAt)
              || Number(remoteClockAssessment.expectedAt)
              || 0
            : 0;
          clearPwmRetryState();
          setNextTriggerAt(0);
          schedule.alarmCreatedAt = 0;
          schedule.alarmDelayMinutes = 0;
          schedule.pageTimerError = `同步相位重排失败：${e?.message || String(e)}；立即修复主钟`;
          try {
            await persistSchedule('sync-phase-adopt-error', {
              syncFromLiveAlarm: false
            });
          } catch (persistError) {
            console.warn('[AC扩展] sync 相位失败状态持久化失败:', persistError?.message);
          }
          try {
            await clearPwmAlarm(automationRevision);
          } catch (clearError) {
            console.warn('[AC扩展] sync 相位失败清理旧闹钟失败:', clearError?.message);
          }
          queueDeferredScheduleRepair({
            smartOnExpectedBoundaryAt: failedExpectedBoundaryAt,
            revokeInvalidSmartOnClock: failedExpectedBoundaryAt > 0,
            revokeOwnerRevision: automationRevision,
            preserveRevokeAcrossSupersededRepair: failedExpectedBoundaryAt > 0
          });
          try {
            await createAlarm('ac-watchdog', {
              delayInMinutes: 1,
              periodInMinutes: 5
            });
          } catch (watchdogError) {
            console.warn('[AC扩展] sync 相位失败后备看门狗创建失败:', watchdogError?.message);
          }
          try {
            await scheduleSyncRetry('adopt');
          } catch (retryError) {
            console.warn('[AC扩展] sync 相位采纳重试创建失败:', retryError?.message);
          }
          return true;
        }
      }
      return phaseChanged;
    } finally {
      if (phaseAdmissionEpoch > 0) {
        releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      }
    }
  }

  const localPwmAlarm = automationAllowed ? localPwmAlarmBeforeConfig : null;
  const localRetryContext = getActiveSmartOnPwmRetryContext(
    schedule,
    localPwmAlarm?.scheduledTime
  );
  const localClockException = getOwnedSmartOnClockException(
    schedule,
    localPwmAlarm?.scheduledTime,
    Date.now()
  );
  const protectLocalSmartOnRetry = automationAllowed
    && (localRetryContext.hasTypedSmartOnRetry
      || localClockException.hasOwnedException);
  if (protectLocalSmartOnRetry) {
    console.log(`[AC扩展] sync ↓ ${reason}: 本地 smart-on 安全事务进行中，暂不采纳远端 on/off 时长与相位`);
  }
  const phaseChanged = protectLocalSmartOnRetry
    ? false
    : await adoptPhaseAndRearm(remote, automationAllowed);
  if (syncAdoptionPreempted()) return false;

  // 3) 闹钟基础设施重建——只由 config 变更驱动（相位路径只管 ac-pwm）
  //    关键修复：若 enabled 在 sync 中翻为 true 但无相位（远端刚 enable 还没跑完第一步），
  //    只持久化 enabled=true 却不建闹钟，设备 B 永远不会真正执行 PWM。
  //    反之 enabled 翻为 false 也必须主动清理闹钟 + 停机，否则设备 B 继续跑本地 PWM。
  let didAlarmInfra = false;
  if (enabledChanged || activeHoursChanged) {
    if (remotePhaseRejected && (enabledChanged || !wasAutomationAllowed)) {
      // 旧版 sync 可能没有 smartClockPlannedAt；不得让“相位拒绝”退化成
      // false→true 无相位立即开机。保持 fail-closed disabled，等下一份带可信
      // phase 的快照再恢复。
      schedule.enabled = false;
      nowEnabled = false;
      await shutdownAfterSyncDisable();
      didAlarmInfra = true;
    } else if (!nowEnabled) {
      if (enabledChanged) {
        // true → false：清所有 PWM 相关闹钟 + 停机（B1 顺序：先 persist 再关）
        await shutdownAfterSyncDisable();
        didAlarmInfra = true;
      }
    } else if (!automationAllowed) {
      // enabled 意图保持开启，但 activeHours 当前在时段外：立即暂停，不伪造 disabled。
      await shutdownAfterSyncDisable({ activeHoursPause: true });
      await rescheduleSmartWeatherAlarm();
      didAlarmInfra = true;
    } else if (enabledChanged || !wasAutomationAllowed) {
      // false → true：按是否已采纳相位决定是否立即新起 PWM cycle
      if (phaseChanged) {
        // 相位路径已建 ac-pwm；只补看门狗 + badge-tick（相位路径不管这两个）
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      } else {
        // 无相位 → 本地全新起一轮 PWM（与 updateSchedule enabled→true 路径一致）
        schedule.pwmState = 'on';
        // 先 persist 内存新状态（enabled=true、pwmState='on'），避免 setupAlarms(true)
        // → runPwmStep() 顶部 loadScheduleFromStorage() 用 storage 旧值（enabled=false）
        // 覆盖内存导致 runPwmStep 提前返回、闹钟基础设施丢失。
        await persistSchedule('sync-enabled-pre-setup', { syncFromLiveAlarm: false });
        if (syncAdoptionPreempted()) return false;
        await setupAlarms(true);  // startImmediately → runPwmStep，内部建 ac-pwm + badge-tick
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      }
      didAlarmInfra = true;
    }
  }

  // 4) active hours 边界闹钟：activeHours 变更或相位重排后都应重调度
  if (activeHoursChanged || phaseChanged) {
    rescheduleActiveBoundary();
  }

  if (syncAdoptionPreempted()) return false;

  const changed = configChanged || phaseChanged || phaseMetadataChanged;
  // 先把采纳后的 schedule 落盘，再推进“已处理 remote”水位。
  // 即便本次 diff 为空也会重落一次：若上次 persist 失败后内存已
  // 变更，重试不能因 diff 变空就跳过 durable commit。
  if (changed || remoteSyncedAt > 0) {
    await persistSchedule(
      changed ? (reason || 'sync-采纳') : 'sync-已处理快照',
      { syncFromLiveAlarm: false }
    );
  }
  if (changed) {
    if (phaseChanged) {
      console.log(`[AC扩展] sync ↓ ${reason}: 已采纳远端相位 pwmState=${schedule.pwmState}, nextTriggerAt=${new Date(schedule.nextTriggerAt).toLocaleString()}`);
    }
    if (phaseMetadataChanged) {
      console.log(`[AC扩展] sync ↓ ${reason}: 已补全远端智能时钟来源`);
    }
    if (configChanged) {
      console.log(`[AC扩展] sync ↓ ${reason}: 已采纳远端 config:`, cfg.fields);
    }
    if (didAlarmInfra) {
      console.log(`[AC扩展] sync ↓ ${reason}: enabled=${wasEnabled}→${nowEnabled}，已重建闹钟基础设施`);
    }
  }
  // schedule durable commit 成功后才标记已见；写水位失败时保留当前
  // 内存抑制，重启后安全重放同一快照。
  if (remoteSyncedAt > 0) {
    await persistSyncWatermark(remoteSyncedAt);
  }
  return changed;
}

// 从 chrome.storage.sync 拉取并尝试合并。reason 用于日志。
// 传 explicitRemote 可跳过读取（onChanged 已传入 newValue）；否则从 sync store 读。
async function tryAdoptSyncedState(reason = '', explicitRemote = null) {
  const queuePendingAdoption = () => {
    _syncOpLock.pending = true;
    _syncOpLock.pendingReason = reason;
    if (explicitRemote && typeof explicitRemote === 'object') {
      const pendingAt = Number(_syncOpLock.pendingRemote?.syncedAt) || 0;
      const incomingAt = Number(explicitRemote.syncedAt) || 0;
      // 数值时钟正常时保留较新快照；但显式 disable 是跨时钟的安全
      // 例外，慢时钟旧端后发也必须有机会停止本机自动控制。
      if (!_syncOpLock.pendingRemote
          || explicitRemote.enabled === false
          || incomingAt >= pendingAt) {
        _syncOpLock.pendingRemote = explicitRemote;
      }
    }
    console.log(`[AC扩展] sync 合并排队（上次仍在处理）: ${reason}`);
    return false;
  };
  if (_syncOpLock.busy) {
    return queuePendingAdoption();
  }

  // 先排空在本次入站之前已经登记的 outbound barrier，再取得入站锁。
  // 循环复核 identity，覆盖 await 已解析 promise 的微任务窗口内新登记的写。
  let overlappedOutbound = false;
  while (true) {
    const observedWriteChain = syncWriteChain;
    if (syncWriteOperationsInFlight > 0) overlappedOutbound = true;
    await observedWriteChain.catch(() => {});
    if (observedWriteChain === syncWriteChain) break;
    overlappedOutbound = true;
  }
  if (_syncOpLock.busy) {
    return queuePendingAdoption();
  }
  _syncOpLock.busy = true;
  let applied = false;
  let requestReason = reason;
  // event snapshot 与 outbound 发生重叠时，其到达次序不能代表 physical
  // sync store 的最终写入次序。barrier 排空后丢弃副本并重读当前 store：
  // 若远端最后写则采用远端；若本机最后写则读回自写并由 watermark 忽略。
  let remote = overlappedOutbound ? null : explicitRemote;
  let readAttempts = 0;
  try {
    const pendingPublish = await getSyncPublishPending();
    const publishRetryAlarm = await chrome.alarms.get('ac-sync-publish-retry');
    if (pendingPublish !== false || publishRetryAlarm) {
      _syncOpLock.pendingOutbound = true;
      _syncOpLock.pendingOutboundReason = 'sync-durable-publish-preempts-inbound';
      await scheduleSyncRetry('publish');
      return false;
    }
    while (true) {
      if (!remote && chrome.storage?.sync) {
        try {
          const got = await chrome.storage.sync.get(SYNC_KEY);
          remote = got?.[SYNC_KEY] || null;
          readAttempts = 0;
        } catch (e) {
          console.warn('[AC扩展] sync 读取失败:', e?.message);
          remote = null;
          if (readAttempts < 1) {
            readAttempts += 1;
            continue;
          }
          await scheduleSyncRetry('adopt');
        }
      }
      if (remote) {
        const candidate = remote;
        const candidateReason = requestReason;
        // 等待共享 schedule 队列时，显式 disable 总能淘汰旧 candidate；
        // 其余快照仍按 syncedAt 选新，避免乱序旧事件掩盖较新失败。
        const pendingSupersedesCandidate = () => {
          if (!_syncOpLock.pending) return false;
          const pendingRemote = _syncOpLock.pendingRemote;
          if (!pendingRemote) return true;
          if (pendingRemote.enabled === false) return true;
          const pendingAt = Number(pendingRemote.syncedAt) || 0;
          const candidateAt = Number(candidate?.syncedAt) || 0;
          return pendingAt >= candidateAt;
        };
        try {
          const changed = await runSerializedScheduleUpdate(async () => {
            // 等待共享队列期间若已有更新到达，旧快照尚未产生副作用，直接淘汰。
            if (pendingSupersedesCandidate()) return false;
            // 本地 mutation 可能早已持有 schedule queue，并在本次 inbound
            // 排队后才 atomic persist schedule + publish marker。再次检查可
            // 防止远端旧 enabled 覆盖本机刚确认的明确停用。
            const localPublishPending = await getSyncPublishPending();
            if (_syncOpLock.pendingOutbound || localPublishPending !== false) {
              _syncOpLock.pendingOutbound = true;
              _syncOpLock.pendingOutboundReason = 'sync-local-publish-preempts-inbound';
              await scheduleSyncRetry('publish');
              return false;
            }
            return applySyncedPhase(candidate, candidateReason);
          });
          applied = changed || applied;
        } catch (e) {
          console.warn('[AC扩展] sync 合并失败:', e?.message);
          void appendDiagnosticLog('warn', 'sync-adopt', e);
          if (!pendingSupersedesCandidate()) {
            await scheduleSyncRetry('adopt');
            throw e;
          }
        }
      }
      if (!_syncOpLock.pending) return applied;

      // busy 期间的事件只作为“有更新”信号；重新读取 sync 区，避免事件副本
      // 被后到的自回环覆盖。优先消费事件携带的最新快照；缺失时才重读 sync 区。
      requestReason = _syncOpLock.pendingReason || 'pending-sync';
      remote = _syncOpLock.pendingRemote;
      _syncOpLock.pending = false;
      _syncOpLock.pendingReason = '';
      _syncOpLock.pendingRemote = null;
      readAttempts = 0;
    }
  } finally {
    const pendingOutbound = _syncOpLock.pendingOutbound;
    const pendingOutboundReason = _syncOpLock.pendingOutboundReason;
    _syncOpLock.busy = false;
    _syncOpLock.pending = false;
    _syncOpLock.pendingReason = '';
    _syncOpLock.pendingRemote = null;
    _syncOpLock.pendingOutbound = false;
    _syncOpLock.pendingOutboundReason = '';
    if (pendingOutbound) {
      await syncScheduleToSync(
        pendingOutboundReason || 'sync-after-inbound'
      );
    }
    drainDeferredScheduleRepair('sync-adopt-complete');
  }
}

// ----- v0.5.10: 页面定时器作为跨设备主同步通道 -----
// UST 服务器已确认："Power-off after" 定时器值会同步到同一账号的所有会话。
// chrome.storage.sync 在 Chrome/Edge 跨浏览器时互不互通——只有 page timer
// 能跨浏览器账号同步（只要登录同一 UST 账号）。
//
// v0.5.10 修正了 v0.5.7 的 pwmState 条件 bug（之前仅 pwmState='on' 才采纳，
// 但 pwmState='off' (AC 正开) 才是页面定时器有值的时刻）。现在两个相位都会
// 对齐：pwmState='off' 直接采纳 page timer 值；pwmState='on' 从 page timer
// 掉算下一轮"开"边界 (pageOffAt + offMinutes)。
//
// 本函数：找到打开的 AC 页面 → 发 getPageTimer 消息 → content.js 读 picker →
// computePageTimerAdoption 决策 → 若采纳则更新 nextTriggerAt + 重排 ac-pwm 闹钟 +
// 把修正后的相位推回 chrome.storage.sync。
//
// 优雅降级：page timer 并非服务器同步时，读回的是本机刚写的值——偏差 <
// toleranceMs(60s)，computePageTimerAdoption 返回 null，不干预，功能等于关闭。
async function tryAdoptPageTimer(reason = '') {
  if (!isAutomationAllowed()
      || isComfortStartActive()
      || isCurrentPwmStepRunning()
      || pwmExecutionWithRecoveryCount > 0
      || repairScheduleClock.inFlight
      || isSyncPhaseAdoptionAdmissionBlocked()) return false;
  let automationRevision = pwmRuntimeRevision;
  let phaseAdmissionEpoch = 0;
  let pageAdoptionExpectedBoundaryAt = 0;
  try {
    const livePwmAlarm = await chrome.alarms.get('ac-pwm');
    const retryContext = getActiveSmartOnPwmRetryContext(
      schedule,
      livePwmAlarm?.scheduledTime
    );
    const localClockException = getOwnedSmartOnClockException(
      schedule,
      livePwmAlarm?.scheduledTime,
      Date.now()
    );
    if (retryContext.hasTypedSmartOnRetry
        || localClockException.hasOwnedException) {
      console.log(`[AC扩展] page timer ↓ ${reason}: smart-on 安全事务进行中，暂不采纳预置关机时间`);
      return false;
    }
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    const tab = tabs.find(isACHomePageTab);
    if (!tab?.id) return false;

    const result = await sendReadMessageToExactACHome(tab.id, { action: 'getPageTimer' });
    if (!result || !result.found) return false;

    const adopt = computePageTimerAdoption(schedule, result, { now: Date.now() });
    if (!adopt) return false;
    const pageClockAssessment = classifySmartOnClock(
      schedule,
      adopt.nextTriggerAt,
      {
        now: Date.now(),
        plannedAt: Number(schedule.smartClockPlannedAt)
          || Number(schedule.alarmCreatedAt)
          || 0,
        nextAction: schedule.pwmState,
        toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
        allowDue: true,
        requirePlannedAt: true
      }
    );
    pageAdoptionExpectedBoundaryAt = pageClockAssessment.applicable
      ? Number(pageClockAssessment.boundaryAt)
        || Number(pageClockAssessment.expectedAt)
        || 0
      : 0;
    if (pageClockAssessment.applicable && !pageClockAssessment.valid) {
      console.warn(
        `[AC扩展] page timer ↓ ${reason}: 拒绝语义无效智能 ON 时钟 (${pageClockAssessment.kind})`
      );
      return false;
    }
    if (isComfortStartActive()
        || isCurrentPwmStepRunning()
        || pwmExecutionWithRecoveryCount > 0
        || repairScheduleClock.inFlight
        || isSyncPhaseAdoptionAdmissionBlocked()
        || !isAutomationOperationCurrent(automationRevision)) return false;

    // Page timer 与 chrome.sync 都会改写同一 phase clock。两者共用排他
    // reservation；claim 后再换 revision，使已验权但尚未入 executor 的旧事件
    // fail closed，直到 durable intent + alarm rearm 完整收口。
    phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
    if (phaseAdmissionEpoch <= 0) return false;
    automationRevision = pwmRuntimeRevision += 1;
    invalidateTimerBasedShutdown();

    // 采纳 page timer 值作为权威"关"时刻
    const oldTrigger = schedule.nextTriggerAt;
    clearPwmRetryState();
    setNextTriggerAt(adopt.nextTriggerAt);
    schedule.alarmCreatedAt = Date.now();
    schedule.alarmDelayMinutes = Math.max(1, (adopt.nextTriggerAt - Date.now()) / 60000);

    // 重排 ac-pwm 闹钟到新时刻
    await persistSchedule(`page-timer-adopt-intent (${reason})`, {
      syncFromLiveAlarm: false
    });
    await clearPwmAlarm(automationRevision);
    const delayMs = adopt.nextTriggerAt - Date.now();
    if (delayMs > 0) {
      const alarmCreated = await createPwmAlarmFromPlan(
        { nextTriggerAt: adopt.nextTriggerAt },
        'page-timer-adopt',
        automationRevision
      );
      if (alarmCreated === false) {
        schedule.pageTimerError = '页面关机时间已采纳，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复';
        await persistSchedule(`page-timer-adopt-alarm-failed (${reason})`, {
          syncFromLiveAlarm: false
        });
        throw new Error('页面关机时间已采纳，但 PWM 闹钟创建失败');
      }
    } else {
      const advanced = await advanceExpiredAlarmToNextBoundary(
        adopt.nextTriggerAt,
        automationRevision,
        phaseAdmissionEpoch
      );
      if (!advanced) {
        throw new Error('页面过期相位未建立未来恢复时钟');
      }
    }

    await rescheduleActiveBoundary();
    if (await abortStaleAutomation(
      automationRevision,
      'page-timer-adopt-active-hours-paused'
    )) return false;
    await persistSchedule(`page-timer-adopt (${reason})`, { syncFromLiveAlarm: false });
    if (await abortStaleAutomation(
      automationRevision,
      'page-timer-adopt-sync-active-hours-paused'
    )) return false;
    // 把修正后的相位推回 sync——让仅靠 sync 的设备也间接对齐到 page timer 的时刻
    await syncScheduleToSync(`page-timer-adopt (${reason})`);

    const oldStr = oldTrigger ? new Date(oldTrigger).toLocaleTimeString() : '无';
    console.log(`[AC扩展] page-timer ↓ ${reason}: 采纳 picker=${result.value} → nextTriggerAt=${new Date(adopt.nextTriggerAt).toLocaleTimeString()} (旧 ${oldStr}), 因=${adopt.reason}, pwmState=${schedule.pwmState}`);
    return true;
  } catch (e) {
    if (phaseAdmissionEpoch > 0) {
      if (!isAutomationOperationCurrent(automationRevision)) {
        const replacementProof = await proveStableDurableLivePwmOwner(
          pwmRuntimeRevision,
          'page timer 新 phase owner'
        );
        if (!replacementProof.automationAllowed) return false;
        const replacementRevision = replacementProof.automationRevision;
        if (replacementProof.stable && replacementProof.committed) {
          console.warn(`[AC扩展] page-timer ${reason} 后处理失败，但 phase 已由新 owner 接管:`, e?.message);
          void appendDiagnosticLog('warn', 'page-timer-adopt-post-owner', e);
          return false;
        }
        schedule.pageTimerError = `页面定时器相位的新 owner 未完成稳定 durable/live 收口：${e?.message || String(e)}；立即修复主钟`;
        queueDeferredScheduleRepair({
          smartOnExpectedBoundaryAt: pageAdoptionExpectedBoundaryAt,
          revokeInvalidSmartOnClock: pageAdoptionExpectedBoundaryAt > 0,
          revokeOwnerRevision: replacementRevision,
          preserveRevokeAcrossSupersededRepair:
            pageAdoptionExpectedBoundaryAt > 0
        });
        try {
          await createAlarm('ac-watchdog', {
            delayInMinutes: 1,
            periodInMinutes: 5
          });
        } catch (watchdogError) {
          console.warn('[AC扩展] page timer 新 owner 未收口后备看门狗创建失败:', watchdogError?.message);
        }
        return false;
      }
      // claim 后旧 alarm 可能已被浏览器送达或清除。此时不能再按普通页面
      // 读取失败静默返回：先持久化“无可信主钟”，释放 reservation 后立即
      // 走只读 repair；一分钟 watchdog 是 SW 在两步间退出时的 durable 后备。
      clearPwmRetryState();
      setNextTriggerAt(0);
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;
      schedule.pageTimerError = `页面定时器相位采纳未收口：${e?.message || String(e)}；立即修复主钟`;
      try {
        await persistSchedule(`page-timer-adopt-error (${reason})`, {
          syncFromLiveAlarm: false
        });
      } catch (persistError) {
        console.warn('[AC扩展] page timer 采纳失败状态持久化失败:', persistError?.message);
      }
      try {
        await clearPwmAlarm(automationRevision);
      } catch (clearError) {
        console.warn('[AC扩展] page timer 采纳失败清理旧闹钟失败:', clearError?.message);
      }
      queueDeferredScheduleRepair({
        smartOnExpectedBoundaryAt: pageAdoptionExpectedBoundaryAt,
        revokeInvalidSmartOnClock: pageAdoptionExpectedBoundaryAt > 0,
        revokeOwnerRevision: automationRevision,
        preserveRevokeAcrossSupersededRepair:
          pageAdoptionExpectedBoundaryAt > 0
      });
      try {
        await createAlarm('ac-watchdog', {
          delayInMinutes: 1,
          periodInMinutes: 5
        });
      } catch (watchdogError) {
        console.warn('[AC扩展] page timer 采纳失败后备看门狗创建失败:', watchdogError?.message);
      }
      console.warn(`[AC扩展] page-timer ${reason} 采纳失败，已排队即时修复:`, e?.message);
    } else {
      // claim 前只是 AC 页面尚未完全加载 / content script 未就绪，可静默降级。
      console.warn(`[AC扩展] page-timer ${reason} 读取失败（可能页面未就绪）:`, e?.message);
    }
    void appendDiagnosticLog('warn', 'page-timer-adopt', e);
    return false;
  } finally {
    if (phaseAdmissionEpoch > 0) {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair('page-timer-adopt-complete');
    }
  }
}

// ----- 官方推荐：setInterval heartbeat — 每 20s 写 storage 重置 SW 空闲计时器 -----
// Chrome 官方文档明确使用 setInterval + chrome.storage.local.set 作为保活心跳。
// chrome.storage.local.set 是扩展 API 调用，每次调用都会重置 SW 的 30 秒空闲超时。
// setInterval 在 SW 存活期间可靠；SW 被杀死后由 alarms 唤醒并重建。
let heartbeatInterval = null;

async function runHeartbeat() {
  try {
    await chrome.storage.local.set({ '__heartbeat': Date.now() });
  } catch (_) { /* ignore */ }
  if (activeBoundaryOwnerReadDeferred) {
    try {
      await rescheduleActiveBoundary();
    } catch (error) {
      console.warn('[AC扩展] heartbeat 重读 active-boundary owner 失败:', error?.message);
    }
    return;
  }
  if (activeBoundaryDeferredForPhaseAdoption) {
    try {
      const [liveBoundary, durableRetryAt] = await Promise.all([
        chrome.alarms.get('ac-active-boundary'),
        readDurableActiveBoundaryRetryAt()
      ]);
      const liveAt = Number(liveBoundary?.scheduledTime) || 0;
      if (durableRetryAt <= 0
          || Math.abs(liveAt - durableRetryAt)
            > PWM_RETRY_ALARM_TOLERANCE_MS) {
        await rescheduleActiveBoundary();
      }
    } catch (error) {
      // durable marker 仍保留；20s heartbeat 与下次 init 会继续尝试建钟。
      console.warn('[AC扩展] heartbeat 恢复 active-boundary 重试钟失败:', error?.message);
    }
  }
}

function startHeartbeat() {
  if (heartbeatInterval) return;
  runHeartbeat();
  heartbeatInterval = setInterval(runHeartbeat, 20 * 1000);
}

// ----- 初始化就绪信号（防止消息处理器在 init 完成前执行）-----
let initResolve;
const initReady = new Promise(resolve => { initResolve = resolve; });

// SW 状态可观测性:记录启动与 init 完成时间,供诊断面板使用
let swStartupTime = Date.now();
let initCompletedAt = 0;

async function ensureOffscreen() {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: '保持 Service Worker 活跃以确保 PWM 定时任务可靠运行'
      });
      console.log('[AC扩展] Offscreen 保活页面已创建');
    }
  } catch (e) {
    console.warn('[AC扩展] Offscreen 创建失败（Edge 版本可能过低）:', e?.message);
  }
}

// ----- 看门狗：定期检查 PWM 闹钟完整性 -----
async function watchdogCheck() {
  if (isSyncPhaseAdoptionAdmissionBlocked()) return;
  await loadScheduleFromStorage();
  if (isSyncPhaseAdoptionAdmissionBlocked()) return;
  if (!isAutomationAllowed()) {
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (!isAutomationAllowed()) return;
  }

  const automationRevision = pwmRuntimeRevision;
  const alarm = await chrome.alarms.get('ac-pwm');
  if (!isAutomationOperationCurrent(automationRevision)) return;
  const now = Date.now();
  const rawAlarmAt = Number(alarm?.scheduledTime) || 0;
  const storedAlarmAt = getStoredAlarmEndMs();
  const alarmIsFuture = rawAlarmAt > now;
  const alarmIsExpired = rawAlarmAt > 0 && rawAlarmAt <= now - 60000;
  const storedRecoveryAt = storedAlarmAt > now ? storedAlarmAt : 0;
  const recovery = await recoverPwmLifecycle({
    source: 'watchdogCheck',
    now,
    automationRevision,
    existingAlarm: alarm,
    liveAlarmAt: alarmIsFuture ? rawAlarmAt : 0,
    storedAlarmAt: alarmIsFuture || !alarm || alarmIsExpired
      ? storedRecoveryAt
      : 0,
    expiredAlarmAt: alarmIsExpired ? rawAlarmAt : 0,
    plannedActionAt: alarmIsFuture ? rawAlarmAt : storedRecoveryAt,
    missingClockAction: !alarm ? 'execute-current' : 'noop',
    failureAction: 'execute-current',
    preserveLiveStrategy: 'next-only',
    preserveLiveReason: 'watchdogCheck',
    restoreReason: alarmIsExpired
      ? '看门狗：PWM 闹钟过期，已按剩余时间补恢复'
      : '看门狗：PWM 闹钟缺失，已按剩余时间补恢复'
  });

  if (recovery.triggerPlan) {
    console.log('[AC扩展] 看门狗：已同步 nextTriggerAt ← live alarm');
  }
  if (recovery.fallbackAction === 'execute-current') {
    console.warn(`[AC扩展] 看门狗：PWM 闹钟${alarm ? '恢复失败' : '缺失'}，补执行当前阶段动作`);
  }
}

// ----- 诊断日志按版本自动重置 -----
// 扩展版本变化（首次运行新代码 / 更新 / 版本 bump）时清空旧日志，
// 避免上一版本的遗留异常在诊断面板里持续显示、误导排障。仅本机 storage.local。
const DIAGNOSTIC_LOG_VERSION_KEY = 'ac_diagnostic_log_version';

async function reconcileDiagnosticLogVersion() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get(DIAGNOSTIC_LOG_VERSION_KEY);
    if (stored[DIAGNOSTIC_LOG_VERSION_KEY] === currentVersion) return;
    await chrome.storage.local.remove(DIAGNOSTIC_LOG_KEY);
    await chrome.storage.local.set({ [DIAGNOSTIC_LOG_VERSION_KEY]: currentVersion });
  } catch (_) {
    // 清理失败不阻塞 init；异常日志本身继续按环形缓冲追加。
  }
}

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  // 提取（Fowler Extract Function）：启动时恢复页面定时器重试（不依赖 schedule.enabled）。
  async function recoverPageTimerRetryOnStartup() {
    // 关闭 PWM / 离开运行时段后也可能仍需补设 1 分钟关机定时器，
    // 因此不以 schedule.enabled 为前提恢复该重试闹钟。浏览器关闭期间错过的
    // retry 也必须重新排程，不能因原时间已经过去而静默放弃关机安全网。
    const retryMinutes = Number(schedule.pageTimerRetryMinutes) || 0;
    const retryAt = Number(schedule.pageTimerRetryAt) || 0;
    if (retryMinutes > 0) {
      if (retryAt > Date.now()) {
        await createAlarm('ac-page-timer-retry', { when: retryAt });
      } else {
        await schedulePageTimerRetry(retryMinutes, '启动恢复错过的页面定时器重试');
        await persistSchedule('init-recover-overdue-page-timer-retry', { syncFromLiveAlarm: false });
      }
    }
  }

  try {
    // 版本变化时先清空遗留诊断日志，再继续 init（后续新异常正常追加）。
    await reconcileDiagnosticLogVersion();
    // 提取（Fowler Extract Function）：init 终极防线——间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
    async function syncFinalLiveAlarmOnInit() {
      // 终极防线：init 完成时，间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
      // 防止 SW 跑早期版本代码、setupAlarms 走重建路径、或某条 persist 漏 sync 时出现
      // "活闹钟在但 storage 缺绝对触发时间" 的红灯。init 末尾是端到端最后一道闭环。
      if (isAutomationAllowed()) {
        const automationRevision = pwmRuntimeRevision;
        const finalLiveAlarm = await chrome.alarms.get('ac-pwm');
        const triggerPlan = await persistReconciledPwmTrigger(
          finalLiveAlarm,
          'init-finalSync',
          PWM_TRIGGER_NEXT_ONLY_OPTIONS,
          automationRevision
        );
        if (triggerPlan) {
          console.log(`[AC扩展] init 末尾: 已从 live alarm 强制同步 nextTriggerAt=${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()}`);
        }
      }
    }

    // 加载 i18n 翻译（SW 上下文也需用 t() 做角标/标题）
    await I18n.load();
    // 最先确保 badge-tick alarm 存在（PWM 补检 + 角标 + SW 保活）
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await loadScheduleFromStorage();
    await backfillNextTriggerAt(true);
    if (schedule.enabled && !isAutomationAllowed()) {
      await onActiveBoundaryCrossed();
    }
    // 上次本机 publish 若在 watermark/storage 瞬时失败中断，必须先重放
    // durable local intent，再考虑采纳 sync store；否则一次明确停用可被旧
    // enabled 快照覆盖且因为停用后无 PWM 活动而永久不再触发同步。
    const pendingSyncPublish = await getSyncPublishPending();
    const pendingSyncPublishAlarm = await chrome.alarms.get(
      'ac-sync-publish-retry'
    );
    if (pendingSyncPublish === true || pendingSyncPublishAlarm) {
      await syncScheduleToSync('init-pending-publish');
    } else if (pendingSyncPublish === null) {
      await scheduleSyncRetry('publish');
    }
    // [v0.5.6] 跨设备同步：在 setupAlarms 之前尝试从 chrome.storage.sync 采用远端相位。
    // 如有 sync 数据则合并到本地 schedule，再 setupAlarms，保证本机闹钟从对齐相位出发。
    // 新装在另一台设备的扩展启动时会先采用主机的 nextTriggerAt，避免本地从默认值跑偏。
    await tryAdoptSyncedState('init');
    // v0.5.10：page timer 已升为跨设备主同步通道（无论 pwmState 都会尝试对齐）
    if (!isComfortStartActive()) {
      await tryAdoptPageTimer('init');
    }
    await ensureOffscreen();
    startHeartbeat();
    if (isComfortStartActive()) {
      // 仅恢复 storage 中已存在的舒适事务；普通 SW 重启不会创建新事务。
      await runSerializedScheduleUpdate(() => runComfortStart('startup-recovery'));
    } else {
      await setupAlarms();
    }
    await updateBadge();
    if (isAutomationAllowed()) {
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    }
    await recoverPageTimerRetryOnStartup();
    await syncFinalLiveAlarmOnInit();
    // init 完成:打开 SW 启动时间跟踪
    swStartupTime = Date.now();
    initCompletedAt = swStartupTime;
    // active hours 边界闹钟：每次 init 都重新调度
    rescheduleActiveBoundary();
    console.log('[AC扩展] 初始化完成', schedule);
  } catch (e) {
    console.error('[AC扩展] 初始化失败，但仍允许消息处理:', e);
    void appendDiagnosticLog('error', 'init', e);
  } finally {
    initResolve();
  }
}

// ----- 设置/更新 PWM 循环闹钟 -----
async function setupAlarms(startImmediately = false, options = {}) {
  const phaseAdmissionEpoch = Number(options.phaseAdmissionEpoch) || 0;
  await rescheduleSmartWeatherAlarm();
  if (!isAutomationAllowed()) {
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (!isAutomationAllowed()) {
      await updateBadge();
      console.log(`[AC扩展] 自动控制${schedule.enabled ? '在运行时段外暂停' : '未启用'}`);
      return false;
    }
  }
  schedule.onMinutes = sanitizeMinutes(schedule.onMinutes, 30);
  schedule.offMinutes = sanitizeMinutes(schedule.offMinutes, 30);

  if (startImmediately) {
    await cancelAutomaticOnRequests();
    pwmRuntimeRevision += 1;
    lastPwmStepAt = 0;
    invalidateTimerBasedShutdown();
    const setupRevision = pwmRuntimeRevision;
    await clearPwmAlarm(setupRevision);
    if (!isAutomationOperationCurrent(setupRevision)) return false;
    prepareFreshPwmStartState();
    // runPwmStep() 会先从 storage 重载；先持久化新的周期所有权，避免旧的
    // smart-on retry marker/pwmState 被重新灌回并误消费。
    await persistSchedule('setupAlarms-start-intent', { syncFromLiveAlarm: false });
    if (!isAutomationOperationCurrent(setupRevision)) return false;
    const executed = await executePwmStepWithRecovery({
      automationRevision: setupRevision,
      phaseAdmissionEpoch,
      source: 'setupAlarms-startImmediately'
    });
    if (!executed || !isAutomationAllowed()) return false;
    return hasDurableLivePwmOwner(pwmRuntimeRevision);
  }

  // 恢复入口只提供事实与来源策略；智能/循环选择由纯协调器完成。
  const now = Date.now();
  const existingAlarm = await chrome.alarms.get('ac-pwm');
  const rawAlarmAt = Number(existingAlarm?.scheduledTime) || 0;
  const liveDueAt = rawAlarmAt > now ? rawAlarmAt : 0;
  const storedDueAt = getStoredAlarmEndMs();
  const recovery = await recoverPwmLifecycle({
    source: 'setupAlarms',
    now,
    existingAlarm,
    liveAlarmAt: liveDueAt,
    storedAlarmAt: storedDueAt,
    expiredAlarmAt: rawAlarmAt > 0 && rawAlarmAt <= now ? rawAlarmAt : 0,
    plannedActionAt: liveDueAt || (storedDueAt > now ? storedDueAt : 0),
    missingClockAction: 'repair-clock',
    failureAction: 'repair-clock',
    preserveLiveReason: 'setupAlarms: 沿用现有 PWM 闹钟',
    restoreReason: 'PWM 闹钟已恢复'
  });

  if (recovery.plan.kind === 'preserve-live-alarm') {
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await updateBadge();
    console.log('[AC扩展] 沿用浏览器中已有的 PWM 闹钟');
  } else if (recovery.plan.kind === 'advance-expired-alarm' && recovery.handled) {
    console.log('[AC扩展] 已从过期闹钟推进到下一周期边界');
  } else if (recovery.plan.kind === 'execute-due-action') {
    console.warn('[AC扩展] PWM 计划时间已过，立即补执行到期动作');
  } else if (recovery.plan.kind === 'repair-clock') {
    console.log('[AC扩展] PWM 闹钟缺失，已按当前状态重建');
  }
  return recovery.handled === true;
}

function sanitizeMinutes(value, fallback) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes < 1) return fallback;
  return minutes;
}

async function updateBadge() {
  if (!isAutomationAllowed()) {
    await clearBadge();
    return;
  }

  // 间隔模式
  const liveAlarm = await chrome.alarms.get('ac-pwm');
  const liveAlarmEnd = getLiveAlarmEndMs(liveAlarm);
  const storedAlarmEnd = getStoredAlarmEndMs();
  const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);
  if (!nextBoundary) {
    await clearBadge();
    return;
  }

  const nextAction = schedule.pwmState;
  const remainingMs = nextBoundary - Date.now();

  if (remainingMs <= 0) {
    await chrome.action.setBadgeText({ text: 'now' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    await chrome.action.setTitle({ title: t('badgeIntervalSoon', t(nextAction === 'on' ? 'actionOn' : 'actionOff')) });
    return;
  }

  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const badgeText = remainingMinutes > 999 ? '999+' : String(remainingMinutes);
  const currentOn = schedule.pwmState !== 'on';

  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({ color: currentOn ? '#16a34a' : '#64748b' });
  await chrome.action.setTitle({
    title: t('badgeIntervalCountdown', t(currentOn ? 'acRunning' : 'acStopped'), String(remainingMinutes), t(nextAction === 'on' ? 'actionOn' : 'actionOff'))
  });
}

// 提取（Fowler Extract Function）：清空角标文案与标题（禁用/无边界两条路径共用）。
async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: t('badgeDefault') });
}

function tagPwmAutomationError(error, automationRevision, recoveryContext = null) {
  const taggedError = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperties(taggedError, {
      pwmAutomationRevision: {
        configurable: true,
        value: automationRevision
      },
      pwmRecoveryContext: {
        configurable: true,
        value: recoveryContext
      }
    });
    return taggedError;
  } catch {
    const wrappedError = new Error(taggedError.message);
    wrappedError.cause = taggedError;
    wrappedError.pwmAutomationRevision = automationRevision;
    wrappedError.pwmRecoveryContext = recoveryContext;
    return wrappedError;
  }
}

async function runPwmStep({
  scheduledTime = 0,
  recoveryPlan = null,
  expectedAutomationRevision = null,
  phaseAdmissionEpoch = 0
} = {}) {
  if (!isAutomationAllowed()) return;
  if (isSyncPhaseAdoptionAdmissionBlockedFor(phaseAdmissionEpoch)) {
    console.warn('[AC扩展] sync 相位接管尚未收口，拒绝旧 PWM 步骤入场');
    return;
  }
  if (Number.isSafeInteger(expectedAutomationRevision)
      && !isAutomationOperationCurrent(expectedAutomationRevision)) {
    console.warn('[AC扩展] PWM 步骤入场 revision 已换主，零动作退出');
    return;
  }
  if (isCurrentPwmStepRunning()) {
    console.warn('[AC扩展] PWM 步骤已在执行，跳过重复触发');
    return;
  }
  // A4: 看门狗 5s cooldown — 防止看门狗与闹钟竞态导致重复触发
  if (Date.now() - lastPwmStepAt < 5000) {
    console.warn('[AC扩展] PWM 步骤距上次执行不足 5s，跳过（看门狗 cooldown）');
    return;
  }
  // expected revision 复检到 claim 之间没有 await；phase adoption 无法在
  // 两者之间释放 reservation 后让旧事件按新 schedule 重新 claim。
  const automationRevision = claimPwmStepOwnership();
  invalidateTimerBasedShutdown();
  const requestedScheduledTime = Number(scheduledTime);
  const pwmTriggerScheduledTime = Number.isFinite(requestedScheduledTime)
    && requestedScheduledTime > 0
    ? requestedScheduledTime
    : 0;
  const recoveringSmartCurrentCycle = recoveryPlan?.kind
    === 'recover-smart-current-cycle';
  let hasTypedSmartOnRetry = false;
  let retryingSmartOn = false;
  let smartOnRetryBoundaryAt = 0;
  let priorPwmRetryError = '';
  let rejectedSmartOnRetryError = '';
  let pwmExceptionRecoveryContext = null;

  function capturePwmExceptionRecoveryContext(smartOnWindow = undefined) {
    const triggerAt = pwmTriggerScheduledTime;
    const retryContext = hasTypedSmartOnRetry
      ? {
          hasTypedSmartOnRetry: true,
          boundaryAt: smartOnRetryBoundaryAt,
          priorError: priorPwmRetryError
        }
      : getSmartOnPwmRetryContext(schedule, triggerAt);
    const resolvedSmartOnWindow = smartOnWindow === undefined
        && triggerAt > 0
        && schedule.smartMode?.enabled === true
        && schedule.pwmState === 'on'
      ? planSmartModeOnWindow(schedule, {
          now: Math.max(Date.now(), triggerAt),
          maxOnMinutes: SMART_MODE.ON_MAX,
          acIsOn: false,
          triggeredBoundaryAt: triggerAt,
          recoverCurrentCycle: recoveringSmartCurrentCycle
        })
      : (smartOnWindow ?? null);
    pwmExceptionRecoveryContext = {
      retryContext,
      snapshot: {
        pwmState: schedule.pwmState,
        onMinutes: schedule.onMinutes,
        offMinutes: schedule.offMinutes,
        smartOnBoundaryAt: schedule.smartOnBoundaryAt
      },
      smartOnWindow: resolvedSmartOnWindow
    };
  }

  function planSmartAutomaticOn(targetAction, acIsOn) {
    if (!(schedule.smartMode?.enabled && targetAction === 'on')) return null;
    return planSmartModeOnWindow(schedule, {
      maxOnMinutes: SMART_MODE.ON_MAX,
      acIsOn,
      boundaryAt: retryingSmartOn
        ? smartOnRetryBoundaryAt
        : schedule.smartOnBoundaryAt,
      triggeredBoundaryAt: retryingSmartOn
        ? smartOnRetryBoundaryAt
        : pwmTriggerScheduledTime,
      recoverCurrentCycle: retryingSmartOn || recoveringSmartCurrentCycle
    });
  }

  // 提取（Fowler Extract Function）：PWM 开机 hold 分支——单次点击 + 只读复核，不在外围重试。
  // 观察结果写回 observations，最终返回重新规划后的 plan。
  async function resolveToggleOnHold(plan, observations) {
    try {
      const toggleResult = await toggleAC('on', {
        notAfterAt: getAutomaticOnDeadline(observations.smartOnWindowEndsAt || 0),
        requireAutomationAllowed: true,
        automationRevision,
        pageTimerMinutes: schedule.onMinutes,
        pageTimerTargetAt: observations.smartPageTimerTargetAt || 0
      });
      observations.toggleSucceeded = toggleResult?.toggleSucceeded === true
        || (!!toggleResult?.success && !toggleResult?.pageTimerResult);
      observations.toggleAlreadyDone = toggleResult?.alreadyDone === true;
      observations.toggleError = toggleResult?.error || '';
      if (toggleResult?.actualOn === true) observations.acIsOn = true;
      if (toggleResult?.pageTimerResult) {
        observations.pageTimerSucceeded = toggleResult.pageTimerResult.success === true;
        observations.pageTimerTargetAt = Number(toggleResult.pageTimerResult.targetAt);
        observations.pageTimerError = toggleResult.pageTimerResult.error || '';
      }
      if (observations.toggleAlreadyDone) {
        observations.acIsOn = true;
        console.log('[AC扩展] 页面已 ON，零点击，已直接确认 Power-off after');
      }
      if (observations.toggleSucceeded && observations.pageTimerSucceeded === false) {
        schedule.pageTimerError = `开机已确认，但页面关机定时器未确认：${observations.pageTimerError || observations.toggleError || '未知错误'}`;
      } else if (!observations.toggleSucceeded) {
        schedule.pageTimerError = `自动开启未确认：${toggleResult?.error || '未知错误'}`;
      }
    } catch (e) {
      observations.toggleSucceeded = false;
      observations.toggleError = e?.message || String(e);
      schedule.pageTimerError = `自动开启异常：${observations.toggleError}`;
    }

    if (!observations.toggleSucceeded) {
      const actual = await getCurrentACStatus();
      if (actual?.isOn === true) {
        schedule.pageTimerError = `自动开启未确认：${observations.toggleError || '页面未出现 Execution succeeded'}；AC 虽显示 ON，本轮仍不推进`;
        console.warn('[AC扩展] PWM 开机只读复核仅见 AC=ON，缺少本次成功提示，不改判成功');
      } else {
        console.warn(`[AC扩展] PWM 本轮未开机：实际=${actual?.isOn}；外围不重复点击，1分钟后重试`);
      }
    }
    return planPwmStep(schedule, observations);
  }

  // 提取（Fowler Extract Function）：PWM 关机补时 hold 分支——页面定时器证明缺失时补设 1 分钟定时器。
  async function resolveShortTimerHold(plan, observations) {
    applyPwmPlanState(plan);
    const timerResult = await setPageTimer(plan.timerMinutes, {
      retryOnFailure: false,
      automationRevision
    });
    observations.shortTimerAttempted = true;
    observations.shortTimerSucceeded = !!timerResult?.success;
    schedule.pageTimerError = timerResult?.success
      ? '原页面关机定时器缺失，已补设 1 分钟定时器；本轮不推进且不点击开关'
      : `页面关机定时器未正确设置：${timerResult?.error || '未知错误'}`;
    console.warn('[AC扩展] PWM 关机边界：页面定时器证明缺失，已尝试补设 1 分钟定时器；不点击开关');
    return planPwmStep(schedule, observations);
  }

  // 提取（Fowler Extract Function）：PWM 失败重试分支——写失败诊断、排 1 分钟重试，调用点随后提前返回。
  async function resolveRetryPlan(plan, observations, targetAction) {
    const failureDetail = plan.reason === 'page-timer-failed'
      ? observations.pageTimerError
      : observations.toggleError;
    const timerRepairOnly = plan.reason === 'page-timer-failed'
      && targetAction === 'on';
    const retryMarkerOptions = timerRepairOnly
      ? {
          kind: 'smart-on-safety-timer',
          boundaryAt: Number(schedule.smartOnBoundaryAt) || 0
        }
      : {};
    applyPwmPlanState(plan);
    if (plan.reason === 'page-timer-failed' && targetAction === 'on') {
      schedule.pageTimerError = `开机已成功，但页面关机定时器未确认：${failureDetail || '未知错误'}；保持 on 相位，1 分钟后重试 setPageTimer`;
    } else {
      schedule.pageTimerError = failureDetail || schedule.pageTimerError
        || `自动${targetAction === 'on' ? '开启' : '关闭'}验证失败，1分钟后重试`;
    }
    // 两阶段持久化：先把原半点 + 请求重试时刻写入 storage，再创建 alarm。
    // SW 若在两步之间退出，init/watchdog 可从 durable intent 恢复；创建成功后
    // 再用 chrome.alarms 验证得到的 canonical scheduledTime 覆写。
    setSmartOnPwmRetryState(
      targetAction,
      plan.nextTriggerAt,
      retryMarkerOptions
    );
    await persistSchedule('runPwmStep-retry-intent', { syncFromLiveAlarm: false });
    const alarmCreated = await createPwmAlarmFromPlan(
      plan,
      plan.reason === 'page-timer-failed' ? 'PWM-pageTimer-failed' : 'PWM失败重试',
      automationRevision
    );
    if (alarmCreated === false) {
      if (!isAutomationOperationCurrent(automationRevision)) return;
      schedule.pageTimerError = `${schedule.pageTimerError}；PWM 重试闹钟创建失败，等待看门狗恢复`;
      await persistSchedule('runPwmStep-retry-alarm-failed', { syncFromLiveAlarm: false });
      return;
    }
    setSmartOnPwmRetryState(
      targetAction,
      schedule.nextTriggerAt,
      retryMarkerOptions
    );
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-retry-active-hours-paused'
    )) return;
    await persistSchedule(
      plan.reason === 'page-timer-failed'
        ? 'runPwmStep-on-pageTimer-failed'
        : 'runPwmStep-interval'
    );
    await updateBadge();
    if (schedule.pwmRetryKind) {
      await syncScheduleToSync('runPwmStep-smart-on-retry-hold');
    }
    console.warn(`[AC扩展] PWM 未提交，保持 pwmState=${schedule.pwmState}，1分钟后重试`);
  }

  return waitUntil((async () => {
  try {
    await loadScheduleFromStorage();
    if (!isAutomationAllowed()) return;

    const smartOnRetryContext = getSmartOnPwmRetryContext(
      schedule,
      pwmTriggerScheduledTime
    );
    hasTypedSmartOnRetry = smartOnRetryContext.hasTypedSmartOnRetry;
    smartOnRetryBoundaryAt = smartOnRetryContext.boundaryAt;
    priorPwmRetryError = smartOnRetryContext.priorError;
    if (smartOnRetryContext.hasStoredSmartOnRetry && !hasTypedSmartOnRetry) {
      rejectedSmartOnRetryError = `智能开机重试身份不匹配：${schedule.pageTimerError || '原重试闹钟已失效'}；等待可信半点或新周期`;
      clearPwmRetryState();
    }

    // typed retry 必须保留首败时已持久化的时长/相位；新半点天气只能由真正的
    // 新周期消费，不能在旧事务恢复期间先清 marker 或改写 pwmState。
    if (!hasTypedSmartOnRetry) {
      const smartPreparedBoundaryAt = currentSmartControlBoundary(pwmTriggerScheduledTime);
      await applyPreparedSmartModeDurations({
        allowActiveOnPhase: recoveringSmartCurrentCycle,
        ...(smartPreparedBoundaryAt > 0 ? { boundaryAt: smartPreparedBoundaryAt } : {})
      });
    }
    // 到这里已消费本半点天气计划。异常恢复必须以此刻的 action/on/off 为准，
    // 不能回退到 shared executor 入场时的旧 12/18 或默认 30/30。
    capturePwmExceptionRecoveryContext();
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-weather-active-hours-paused'
    )) return;

    const smartOnRetryTargetAt = smartOnRetryBoundaryAt
      + Number(schedule.onMinutes) * 60000;
    retryingSmartOn = hasTypedSmartOnRetry
      && schedule.smartMode?.enabled
      && schedule.pwmState === 'on'
      && smartOnRetryTargetAt >= nextSafePageTimerTargetAt(Date.now());

    if (recoveringSmartCurrentCycle) {
      const refreshedRecoveryPlan = planSmartRecovery(schedule, {
        now: Date.now(),
        plannedActionAt: 0,
        maxOnMinutes: SMART_MODE.ON_MAX
      });
      if (refreshedRecoveryPlan.kind === 'recover-smart-current-cycle') {
        schedule.pwmState = 'on';
      } else {
        // 首次恢复判断后的异步天气/存储读取可能跨过安全余量，或把本周期改成
        // 不开机。不能 silent return：先释放旧时钟，再交给下方统一 planner
        // 明确 defer、执行 OFF，或按最新模式继续，保证本次恢复一定落下新时钟。
        console.warn(
          `[AC扩展] 智能当前周期恢复重新规划：${refreshedRecoveryPlan.reason || '状态已变化'}`
        );
      }
      capturePwmExceptionRecoveryContext();
      await clearPwmAlarm(automationRevision);
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-smart-current-cycle-active-hours-paused'
      )) return;
      setNextTriggerAt(0);
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;
    }

    const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
    const currentDuration = Number(
      targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes
    );
    let observations = {};
    let plan = planPwmStep(schedule, observations);
    if (plan.kind === 'refuse') {
      schedule.pageTimerError = `PWM 阶段拒绝执行：${plan.reason}`;
      console.warn(`[AC扩展] ${schedule.pageTimerError}`);
      await persistSchedule('runPwmStep-refused', { syncFromLiveAlarm: false });
      return;
    }

    applyPwmPlanState(plan);
    if (hasTypedSmartOnRetry && priorPwmRetryError) {
      schedule.pageTimerError = priorPwmRetryError;
    } else if (rejectedSmartOnRetryError) {
      schedule.pageTimerError = rejectedSmartOnRetryError;
    }

    console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);

    const preCheckStatus = await getCurrentACStatus();
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-status-active-hours-paused'
    )) return;
    observations.acIsOn = preCheckStatus?.isOn;
    if (targetAction === 'off') {
      observations.proofFresh = isPageTimerProofFresh(schedule);
    }
    plan = planPwmStep(schedule, observations);

    const smartOnWindow = planSmartAutomaticOn(targetAction, observations.acIsOn);
    if (smartOnWindow?.kind === 'allow') {
      observations.smartPageTimerTargetAt = Number(smartOnWindow.pageTimerTargetAt);
      observations.smartOnWindowEndsAt = Number(smartOnWindow.windowEndsAt) || 0;
      schedule.smartOnBoundaryAt = Number(smartOnWindow.boundaryAt) || 0;
      await persistSchedule('runPwmStep-smart-on-boundary', { syncFromLiveAlarm: false });
    } else if (smartOnWindow) {
      schedule.smartOnBoundaryAt = 0;
      plan = smartOnWindow;
    }
    capturePwmExceptionRecoveryContext(smartOnWindow);

    if (preCheckStatus?.isOn === (targetAction === 'on')) {
      console.log(`[AC扩展] 预检：AC 已在目标状态 (${targetAction})，跳过切换，直接推进周期`);
    }

    if (targetAction === 'off' && observations.proofFresh === true) {
      console.log(`[AC扩展] PWM 关机边界：页面定时器已正确设置 (${schedule.pageTimerMinutes} 分钟)，不点击开关`);
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'toggle-on') {
      plan = await resolveToggleOnHold(plan, observations);
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-toggle-active-hours-paused'
      )) return;
    }

    if (plan.kind === 'defer') {
      applyPwmPlanState(plan);
      const deferredBoundaryAt = halfHourBoundaryAtOrBefore(
        Number(plan.nextTriggerAt) - 1
      );
      setSmartOnPwmRetryState('on', plan.nextTriggerAt, {
        kind: 'smart-on-safety-skip',
        boundaryAt: deferredBoundaryAt
      });
      if (hasTypedSmartOnRetry) {
        schedule.pageTimerError = `本周期智能开机重试已超过安全关机余量：${priorPwmRetryError || '自动开启未确认'}；等待下一个半点`;
      } else if (rejectedSmartOnRetryError) {
        schedule.pageTimerError = rejectedSmartOnRetryError;
      }
      // 先把“下一半点 + marker 已清”的终态写入 storage。live alarm 若创建
      // 失败，看门狗仍可从 durable clock 恢复，不会复活旧一分钟事务。
      await persistSchedule('runPwmStep-smart-on-deferred-intent', { syncFromLiveAlarm: false });
      await clearPwmAlarm(automationRevision);
      const alarmCreated = await createPwmAlarmFromPlan(
        plan,
        'PWM-smart-on-deferred',
        automationRevision
      );
      if (alarmCreated === false) {
        if (!isAutomationOperationCurrent(automationRevision)) return;
        schedule.pageTimerError += '；下一半点闹钟创建失败，等待看门狗恢复';
        await persistSchedule('runPwmStep-smart-on-deferred-alarm-failed', { syncFromLiveAlarm: false });
        return;
      }
      setSmartOnPwmRetryState('on', schedule.nextTriggerAt, {
        kind: 'smart-on-safety-skip',
        boundaryAt: deferredBoundaryAt
      });
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-deferred-active-hours-paused'
      )) return;
      await persistSchedule('runPwmStep-smart-on-deferred');
      await updateBadge();
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-deferred-sync-active-hours-paused'
      )) return;
      await syncScheduleToSync('runPwmStep-smart-on-deferred');
      console.log(`[AC扩展] 智能自动开启等待下一个半点: ${new Date(plan.nextTriggerAt).toLocaleTimeString()}`);
      return;
    }

    if (plan.kind === 'refuse') {
      clearPwmRetryState();
      schedule.pageTimerError = `智能自动开启被拒绝：${plan.reason}`;
      await persistSchedule('runPwmStep-smart-on-refused', { syncFromLiveAlarm: false });
      return;
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
      applyPwmPlanState(plan);
      const pageTimerResult = await setPageTimer(plan.timerMinutes, {
        retryOnFailure: false,
        targetAt: observations.smartPageTimerTargetAt || 0,
        automationRevision
      });
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-page-timer-active-hours-paused'
      )) return;
      observations.pageTimerSucceeded = !!pageTimerResult?.success;
      observations.pageTimerTargetAt = Number(pageTimerResult?.targetAt);
      observations.pageTimerError = pageTimerResult?.error || schedule.pageTimerError || '';
      plan = planPwmStep(schedule, observations);
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'set-short-page-timer') {
      plan = await resolveShortTimerHold(plan, observations);
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-short-timer-active-hours-paused'
      )) return;
    }

    if (plan.kind === 'retry') {
      await resolveRetryPlan(plan, observations, targetAction);
      return;
    }

    if (plan.kind !== 'commit') {
      throw new Error(`未处理的 PWM plan: ${plan.kind}/${plan.reason}`);
    }

    let smartLocalExceptionBoundaryAt = 0;
    let smartLocalExceptionKind = '';
    clearPwmRetryState();
    schedule.pageTimerError = '';

    // 智能模式：把下一 ON 触发对齐到半点，30 分钟周期锚定半点。
    if (schedule.smartMode?.enabled) {
      const recordedOffAt = Number(schedule.pageTimerTargetAt);
      const observedCommitAt = Date.now();
      const smartAlignNow = targetAction === 'off'
        ? Math.max(
            observedCommitAt,
            Number.isFinite(recordedOffAt) && recordedOffAt > 0
              ? recordedOffAt
              : 0
          )
        : observedCommitAt;
      const notBeforeAt = smartAlignNow + SMART_MODE.MIN_OFF_MINUTES * 60000;
      const activeSmartBoundaryAt = Number(schedule.smartOnBoundaryAt);
      const expectedSmartOffAt = smartModePageTimerTargetAt(
        Number(schedule.onMinutes),
        smartAlignNow,
        activeSmartBoundaryAt
      );
      const retainedSmartBoundaryAt = expectedSmartOffAt
          >= nextSafePageTimerTargetAt(smartAlignNow)
        ? activeSmartBoundaryAt
        : 0;
      const safeDelayPlan = targetAction === 'off'
        ? planSmartOnAfterConfirmedOff(schedule, {
            now: smartAlignNow,
            confirmedOffAt: smartAlignNow,
            minOffMinutes: SMART_MODE.MIN_OFF_MINUTES,
            ...(retainedSmartBoundaryAt > 0
              ? { boundaryAt: retainedSmartBoundaryAt }
              : {})
          })
        : null;
      if (safeDelayPlan?.kind === 'smart-on-safe-delay'
          || safeDelayPlan?.kind === 'smart-on-safety-skip') {
        // 保留原 commit/proofAction，只改下一时钟；否则会丢掉 OFF proof clear。
        plan.nextTriggerAt = safeDelayPlan.nextTriggerAt;
        plan.delayMinutes = safeDelayPlan.delayMinutes;
        if (plan.phasePatch) {
          plan.phasePatch.nextTriggerAt = safeDelayPlan.nextTriggerAt;
        }
        smartLocalExceptionBoundaryAt = safeDelayPlan.boundaryAt;
        smartLocalExceptionKind = safeDelayPlan.kind;
        schedule.smartOnBoundaryAt = smartLocalExceptionBoundaryAt;
        setSmartOnPwmRetryState('on', safeDelayPlan.nextTriggerAt, {
          kind: smartLocalExceptionKind,
          boundaryAt: smartLocalExceptionBoundaryAt
        });
        const actionLabel = smartLocalExceptionKind === 'smart-on-safe-delay'
          ? '压缩机保护后补开'
          : '本周期窗口不足，跳到下一半点重新评估';
        console.warn(
          `[AC扩展] 恢复关机晚于原截止：保留 ${new Date(smartLocalExceptionBoundaryAt).toLocaleTimeString()}`
          + ` 所有权，${actionLabel} ${new Date(safeDelayPlan.nextTriggerAt).toLocaleTimeString()}`
        );
      } else {
        alignSmartModeNextTrigger(plan, smartAlignNow, { notBeforeAt });
      }
    }

    applyPwmPlanState(plan);
  if (await abortStaleAutomation(
    automationRevision,
    'runPwmStep-commit-active-hours-paused'
  )) return;
  // phase/nextTriggerAt 是浏览器建钟前的 durable intent；若 live alarm 创建
  // 失败，watchdog 可恢复同一绝对截止，诊断也不会再出现“无钟绿灯”。
  await persistSchedule('runPwmStep-commit-intent', { syncFromLiveAlarm: false });
  const alarmCreated = await createPwmAlarmFromPlan(plan, 'PWM', automationRevision);
  if (alarmCreated === false) {
    if (!isAutomationOperationCurrent(automationRevision)) return;
    schedule.pageTimerError = 'PWM 下一阶段闹钟创建失败，等待看门狗恢复';
    await persistSchedule('runPwmStep-commit-alarm-failed', { syncFromLiveAlarm: false });
    return;
  }
    if (smartLocalExceptionBoundaryAt > 0) {
      setSmartOnPwmRetryState('on', schedule.nextTriggerAt, {
        kind: smartLocalExceptionKind,
        boundaryAt: smartLocalExceptionBoundaryAt
      });
    }
    console.log(`[AC扩展] PWM 下一阶段:${schedule.pwmState}，${currentDuration}分钟后触发`);

    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-persist-active-hours-paused'
    )) return;
    await persistSchedule('runPwmStep-interval');
    await updateBadge();

    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-sync-active-hours-paused'
    )) return;
    // exception marker 由 sync 投影成下一半点 OFF 哨兵，先取消其他设备旧 ON
    // actuator；本机补开成功并提交正常 OFF phase 后会同步真实截止。
    await syncScheduleToSync('runPwmStep');
  } catch (error) {
    throw tagPwmAutomationError(
      error,
      automationRevision,
      pwmExceptionRecoveryContext
    );
  } finally {
    releasePwmStepOwnership(automationRevision);
  }
  })());
}

async function recoverTypedSmartOnAlarmException(
  alarm,
  error,
  automationRevision,
  now = Date.now(),
  retryContextSnapshot = null
) {
  const liveRetryContext = getSmartOnPwmRetryContext(schedule, alarm?.scheduledTime);
  const retryContext = retryContextSnapshot?.hasTypedSmartOnRetry
    ? retryContextSnapshot
    : liveRetryContext;
  if (!retryContext.hasTypedSmartOnRetry) return false;
  if (!isAutomationOperationCurrent(automationRevision)
      || schedule.smartMode?.enabled !== true) return true;

  const recoveryPlan = planSmartOnRetryExceptionRecovery(
    schedule,
    retryContext.boundaryAt,
    { now, retryAt: now + 60000 }
  );
  const priorError = String(schedule.pageTimerError || retryContext.priorError || '').trim();
  schedule.pageTimerError = `${priorError ? `${priorError}；` : ''}`
    + `智能开机重试执行异常：${error?.message || String(error)}`
    + (recoveryPlan.kind === 'defer' ? '；本周期安全余量不足，等待下一个半点' : '；1 分钟后重试');
  schedule.pwmState = 'on';
  setNextTriggerAt(recoveryPlan.nextTriggerAt);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;

  if (recoveryPlan.kind === 'retry-smart-on-exception') {
    schedule.smartOnBoundaryAt = retryContext.boundaryAt;
    setSmartOnPwmRetryState('on', recoveryPlan.nextTriggerAt);
  } else {
    clearPwmRetryState();
    schedule.smartOnBoundaryAt = 0;
  }
  await persistSchedule('onAlarm-smart-on-error-intent', { syncFromLiveAlarm: false });

  const alarmCreated = await createPwmAlarmFromPlan(
    recoveryPlan,
    recoveryPlan.kind === 'defer'
      ? 'onAlarm-smart-on-error-deferred'
      : 'onAlarm-smart-on-error-retry',
    automationRevision
  );
  if (alarmCreated === false) {
    if (!isAutomationOperationCurrent(automationRevision)) return true;
    schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗恢复';
    await persistSchedule('onAlarm-smart-on-error-alarm-failed', { syncFromLiveAlarm: false });
    return true;
  }
  if (!isAutomationOperationCurrent(automationRevision)) return true;

  if (recoveryPlan.kind === 'retry-smart-on-exception') {
    setSmartOnPwmRetryState('on', schedule.nextTriggerAt);
  } else {
    clearPwmRetryState();
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule(
    recoveryPlan.kind === 'defer'
      ? 'onAlarm-smart-on-error-deferred'
      : 'onAlarm-smart-on-error-retry'
  );
  return true;
}

async function recoverGenericPwmAlarmException(
  alarm,
  error,
  automationRevision,
  incomingSnapshot,
  incomingSmartOnWindow,
  now = Date.now()
) {
  if (!isAutomationOperationCurrent(automationRevision)) return true;

  const incomingState = incomingSnapshot?.pwmState === 'off' ? 'off' : 'on';
  const scheduledSmartOn = incomingState === 'on'
    && schedule.smartMode?.enabled === true
    && incomingSmartOnWindow?.kind === 'allow'
    && incomingSmartOnWindow.reason === 'smart-on-scheduled-boundary';
  if (scheduledSmartOn) {
    schedule.onMinutes = Number(incomingSnapshot.onMinutes);
    schedule.offMinutes = Number(incomingSnapshot.offMinutes);
  }
  schedule.pwmState = incomingState;

  const requestedRetryAt = now + 60000;
  const recoveryPlan = scheduledSmartOn
    ? planSmartOnRetryExceptionRecovery(
      schedule,
      incomingSmartOnWindow.boundaryAt,
      { now, retryAt: requestedRetryAt }
    )
    : {
        kind: 'retry-pwm-exception',
        reason: 'pwm-alarm-exception',
        nextAction: incomingState,
        nextTriggerAt: requestedRetryAt,
        phasePatch: { pwmState: incomingState, nextTriggerAt: requestedRetryAt }
      };
  schedule.pageTimerError = `PWM 步骤执行异常：${error?.message || String(error)}`
    + (recoveryPlan.kind === 'defer' ? '；本周期安全余量不足，等待下一个半点' : '；1 分钟后重试');
  setNextTriggerAt(recoveryPlan.nextTriggerAt);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;

  if (recoveryPlan.kind === 'retry-smart-on-exception') {
    schedule.smartOnBoundaryAt = incomingSmartOnWindow.boundaryAt;
    setSmartOnPwmRetryState('on', recoveryPlan.nextTriggerAt);
  } else {
    clearPwmRetryState();
    if (recoveryPlan.kind === 'defer') schedule.smartOnBoundaryAt = 0;
  }
  await persistSchedule('onAlarm-error-recovery-intent', { syncFromLiveAlarm: false });

  const alarmCreated = await createPwmAlarmFromPlan(
    recoveryPlan,
    recoveryPlan.kind === 'defer'
      ? 'onAlarm-error-recovery-deferred'
      : 'onAlarm-error-recovery-retry',
    automationRevision
  );
  if (alarmCreated === false) {
    if (!isAutomationOperationCurrent(automationRevision)) return true;
    schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗恢复';
    await persistSchedule('onAlarm-error-recovery-alarm-failed', { syncFromLiveAlarm: false });
    return true;
  }
  if (!isAutomationOperationCurrent(automationRevision)) return true;

  if (recoveryPlan.kind === 'retry-smart-on-exception') {
    setSmartOnPwmRetryState('on', schedule.nextTriggerAt);
  } else {
    clearPwmRetryState();
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule(
    recoveryPlan.kind === 'defer'
      ? 'onAlarm-error-recovery-deferred'
      : 'onAlarm-error-recovery-retry'
  );
  return true;
}

// 所有 PWM 入口共享同一异常边界。入场时先冻结 action、时长、半点与 retry
// ownership；runPwmStep 即使在内部推进/清 marker 后抛错，也只能恢复本次
// revision。启动恢复、watchdog 与 live ac-pwm 因此不会再各自遗漏异常重排。
async function executePwmStepWithRecovery({
  scheduledTime = 0,
  recoveryPlan = null,
  automationRevision = pwmRuntimeRevision,
  phaseAdmissionEpoch = 0,
  source = 'pwm',
  beforeRun = null
} = {}) {
  if (isSyncPhaseAdoptionAdmissionBlockedFor(phaseAdmissionEpoch)
      || deferredRepairAfterPwmOptions
      || !isAutomationOperationCurrent(automationRevision)) return false;

  let continuationAutomationRevision = automationRevision;
  // repair 先入场时，不能让已送达 alarm 在其长页面 I/O 中途冻结旧 action。
  // 等全部 in-flight/trailing repair 收口，再以 durable + live clock 重新入场；
  // 等待结束到计数 claim 之间没有 await，新 repair 会看到计数并转为 trailing。
  let waitedForRepair = false;
  while (repairScheduleClock.inFlight) {
    const activeRepair = repairScheduleClock.inFlight;
    await activeRepair.catch(() => {});
    waitedForRepair = true;
    if (isSyncPhaseAdoptionAdmissionBlockedFor(phaseAdmissionEpoch)
        || deferredRepairAfterPwmOptions
        || !isAutomationOperationCurrent(automationRevision)) return false;
  }

  pwmExecutionWithRecoveryCount += 1;
  const diagnosticAttemptId = typeof beginPwmDiagnosticAttempt === 'function'
    ? beginPwmDiagnosticAttempt({ source, scheduledTime, automationRevision })
    : 0;
  let diagnosticOutcomeStatus = 'failed';
  let diagnosticOutcomeReason = 'executor did not settle';
  let diagnosticOutcomeError = '';
  try {
  const triggerAt = Number(scheduledTime) || 0;
  if (waitedForRepair) {
    if (triggerAt <= 0) {
      console.warn('[AC扩展] repair 已收口，无绝对时钟的旧执行请求不再盲目补动作');
      diagnosticOutcomeStatus = 'skipped';
      diagnosticOutcomeReason = 'repair-finished-without-owned-clock';
      return false;
    }
    await loadScheduleFromStorage();
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    if (isSyncPhaseAdoptionAdmissionBlockedFor(phaseAdmissionEpoch)
        || deferredRepairAfterPwmOptions
        || !isAutomationOperationCurrent(automationRevision)) return false;
    const postRepairDelivery = assessPwmAlarmDelivery(
      schedule,
      triggerAt,
      Date.now()
    );
    const liveAt = Number(liveAlarm?.scheduledTime) || 0;
    const liveStillOwned = liveAt <= 0
      || Math.abs(liveAt - triggerAt) <= PWM_RETRY_ALARM_TOLERANCE_MS;
    if (!postRepairDelivery.accepted || !liveStillOwned) {
      console.warn(
        `[AC扩展] repair 后旧 PWM 事件已失去所有权 (${postRepairDelivery.reason})，零动作退出`
      );
      diagnosticOutcomeStatus = 'stale';
      diagnosticOutcomeReason = postRepairDelivery.reason || 'live-owner-changed';
      return false;
    }
  }
  const alarm = { name: 'ac-pwm', scheduledTime: triggerAt };
  const incomingSmartOnRetryContext = getSmartOnPwmRetryContext(
    schedule,
    triggerAt
  );
  const incomingPwmSnapshot = {
    pwmState: schedule.pwmState,
    onMinutes: schedule.onMinutes,
    offMinutes: schedule.offMinutes,
    smartOnBoundaryAt: schedule.smartOnBoundaryAt
  };
  const alarmReceivedAt = Math.max(Date.now(), triggerAt);
  const incomingSmartOnWindow = triggerAt > 0
      && schedule.smartMode?.enabled === true
      && schedule.pwmState === 'on'
    ? planSmartModeOnWindow(schedule, {
        now: alarmReceivedAt,
        maxOnMinutes: SMART_MODE.ON_MAX,
        acIsOn: false,
        triggeredBoundaryAt: triggerAt
      })
    : null;

  try {
    if (typeof beforeRun === 'function') {
      const proceed = await beforeRun();
      if (proceed === false) {
        diagnosticOutcomeStatus = 'skipped';
        diagnosticOutcomeReason = 'before-run-declined';
        return true;
      }
      if (Number.isSafeInteger(proceed?.automationRevision)) {
        continuationAutomationRevision = proceed.automationRevision;
      }
      if (isSyncPhaseAdoptionAdmissionBlockedFor(phaseAdmissionEpoch)
          || deferredRepairAfterPwmOptions
          || !isAutomationOperationCurrent(continuationAutomationRevision)) {
        console.warn('[AC扩展] PWM 前置恢复后 phase owner 已改变，零动作退出');
        diagnosticOutcomeStatus = 'stale';
        diagnosticOutcomeReason = 'phase-owner-changed-after-before-run';
        return false;
      }
    }
    await runPwmStep({
      scheduledTime: triggerAt,
      recoveryPlan,
      expectedAutomationRevision: continuationAutomationRevision,
      phaseAdmissionEpoch
    });
    diagnosticOutcomeStatus = typeof inferPwmDiagnosticOutcomeStatus === 'function'
      ? inferPwmDiagnosticOutcomeStatus()
      : 'settled';
    diagnosticOutcomeReason = schedule.pageTimerError
      ? 'schedule-retains-page-timer-error'
      : 'run-pwm-step-settled';
    return true;
  } catch (error) {
    console.error(`[AC扩展] PWM 步骤执行失败 (${source}):`, error);
    void appendDiagnosticLog('error', source, error);
    const failedRevision = Number.isSafeInteger(error?.pwmAutomationRevision)
      ? error.pwmAutomationRevision
      : continuationAutomationRevision;
    diagnosticOutcomeError = error?.message || String(error);
    if (!isAutomationOperationCurrent(failedRevision)) {
      diagnosticOutcomeStatus = 'stale';
      diagnosticOutcomeReason = 'exception-owner-revoked';
      return false;
    }
    const postPrepareContext = error?.pwmRecoveryContext;
    const recoveryRetryContext = postPrepareContext?.retryContext
      || incomingSmartOnRetryContext;
    const recoverySnapshot = postPrepareContext?.snapshot
      || incomingPwmSnapshot;
    const recoverySmartOnWindow = Object.hasOwn(
      postPrepareContext || {},
      'smartOnWindow'
    )
      ? postPrepareContext.smartOnWindow
      : incomingSmartOnWindow;
    if (await recoverTypedSmartOnAlarmException(
      alarm,
      error,
      failedRevision,
      Date.now(),
      recoveryRetryContext
    )) {
      diagnosticOutcomeStatus = typeof inferPwmDiagnosticOutcomeStatus === 'function'
        ? inferPwmDiagnosticOutcomeStatus()
        : 'recovered';
      diagnosticOutcomeReason = 'typed-smart-on-exception-recovered';
      return true;
    }
    const genericRecovery = await recoverGenericPwmAlarmException(
      alarm,
      error,
      failedRevision,
      recoverySnapshot,
      recoverySmartOnWindow
    );
    diagnosticOutcomeStatus = genericRecovery
      ? (typeof inferPwmDiagnosticOutcomeStatus === 'function'
          ? inferPwmDiagnosticOutcomeStatus()
          : 'recovered')
      : 'failed';
    diagnosticOutcomeReason = genericRecovery
      ? 'generic-exception-recovered'
      : 'generic-exception-unrecovered';
    return genericRecovery;
  }
  } finally {
    let completedDiagnosticOutcome = null;
    if (diagnosticAttemptId > 0
        && typeof finishPwmDiagnosticAttempt === 'function') {
      completedDiagnosticOutcome = finishPwmDiagnosticAttempt(
        diagnosticAttemptId,
        diagnosticOutcomeStatus,
        diagnosticOutcomeReason,
        diagnosticOutcomeError
      );
    }
    pwmExecutionWithRecoveryCount = Math.max(
      0,
      pwmExecutionWithRecoveryCount - 1
    );
    // shared executor 的异常恢复也已经结束后，才允许 repair 观察/改写 phase。
    // phase adoption 若仍持有 reservation，队列会保留到完整 sync 收口后。
    drainDeferredScheduleRepair('pwm-executor-complete');
    // local 持久化是诊断旁路：在 owner/repair 门禁释放后等待一个永不 reject
    // 的 best-effort 写，不能改变 executor 原返回值或原异常。
    if (completedDiagnosticOutcome
        && typeof waitForPwmDiagnosticOutcomePersistence === 'function') {
      await waitForPwmDiagnosticOutcomePersistence(completedDiagnosticOutcome);
    }
  }
}

// 通过新鲜页面确认 Power-off after 已离开当前 React 状态并真正持久化。
// 写入来源页无论是用户页还是扩展自建隐藏页都不能刷新：过早导航可能中断 UST
// 的异步提交。每次读回都新建临时隐藏页，按退避窗口等待服务器落盘后再验证。
async function verifyPageTimerPersistence(
  expectedValue,
  { automationRevision = null, shutdownRevision = null } = {}
) {
  let lastActualValue = '';
  let lastFailure = '';
  const persistenceWriteIsCurrent = () => (
    automationRevision === null
      || isAutomationOperationCurrent(automationRevision)
  ) && (
    shutdownRevision === null
      || isTimerBasedShutdownCurrent(shutdownRevision)
  );

  // 提取（Fowler Extract Function）：单次新鲜页读回尝试——建临时隐藏页、读回、比对、回收。
  async function attemptPersistenceRead(expectedValue, attempt) {
    let verifierTabId = null;
    try {
      if (!persistenceWriteIsCurrent()) {
        return { success: false, automationStale: true, shutdownStale: true };
      }
      await sleep(PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS[attempt]);
      if (!persistenceWriteIsCurrent()) {
        return { success: false, automationStale: true, shutdownStale: true };
      }

      const verifierTab = await chrome.tabs.create({ url: AC_PAGE, active: false });
      verifierTabId = verifierTab?.id || null;
      if (!verifierTabId) throw new Error('无法创建页面定时器验证标签页');
      // 兜底回收闹钟：每轮验证页若 SW 在 sleep(30000) 窗口被杀导致 finally 不执行，
      // 1 分钟后该闹钟兜底关闭隐藏标签，避免泄漏。与 setPageTimer / _toggleOnNewTab 同模式。
      chrome.alarms.create(`ac-close-tab-${verifierTabId}`, { delayInMinutes: 1 });

      const pageReady = await waitForTabReady(
        verifierTabId,
        30000,
        isACHomePageTab
      );
      if (!pageReady) throw new Error('页面定时器验证页等待就绪超时');
      const verifierTarget = await getExactACHomeTab(verifierTabId);
      if (!verifierTarget) throw new Error('页面定时器验证页未停留在精确 home URL');
      const readback = await sendReadMessageToExactACHome(
        verifierTabId,
        { action: 'getPageTimer' }
      );
      if (!persistenceWriteIsCurrent()) {
        return { success: false, automationStale: true, shutdownStale: true };
      }
      const actualValue = String(readback?.value || readback?.title || '').trim();
      if (readback?.found && actualValue === expectedValue) {
        return { success: true, value: actualValue };
      }

      lastFailure = `第 ${attempt + 1} 次新鲜页读回不匹配（期望 ${expectedValue}，实际 ${actualValue || '空'}）`;
      return { success: false, actualValue };
    } catch (e) {
      lastFailure = `第 ${attempt + 1} 次新鲜页验证异常：${e?.message || String(e)}`;
      return { success: false };
    } finally {
      // 每个临时验证页只负责一次全新导航读回，立即回收；写入来源页仍由
      // setPageTimer finally 中已有的 ac-close-tab-* 延迟回收逻辑统一处理。
      if (verifierTabId) {
        try { await chrome.tabs.remove(verifierTabId); } catch (_) { /* tab may already be closed */ }
        // 标签已正常回收，清掉上面登记的兜底闹钟，避免误关后续重用同 id 的标签。
        try { await chrome.alarms.clear(`ac-close-tab-${verifierTabId}`); } catch (_) { /* alarm may already fire or absent */ }
      }
    }
  }

  for (let attempt = 0; attempt < PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length; attempt++) {
    const attemptResult = await attemptPersistenceRead(expectedValue, attempt);
    if (attemptResult.automationStale || attemptResult.shutdownStale) {
      return attemptResult;
    }
    if (attemptResult.success) {
      return { success: true, value: attemptResult.value, attempts: attempt + 1 };
    }
    if (attemptResult.actualValue !== undefined) {
      lastActualValue = attemptResult.actualValue;
    }
  }

  return {
    success: false,
    error: `页面定时器经 ${PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length} 次新鲜页验证后仍未持久化：${lastFailure || '未知错误'}`,
    actualValue: lastActualValue,
    attempts: PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length
  };
}

// 关机定时器设置失败时，记录明确的目标分钟数并用独立闹钟持续重试。
// 该路径服务于“关闭 PWM / 退出运行时段 / sync 停用”等已清除 ac-pwm 的场景；
// 正常 PWM 步骤另有 ac-pwm 1 分钟重试，调用 setPageTimer 时会关闭本重试。
async function schedulePageTimerRetry(minutes, reason = '') {
  const retryMinutes = Math.max(1, sanitizeMinutes(minutes, 1));
  schedule.pageTimerRetryMinutes = retryMinutes;
  schedule.pageTimerRetryAt = Date.now() + 60 * 1000;
  await chrome.alarms.clear('ac-page-timer-retry');
  await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
  console.warn(`[AC扩展] 页面定时器将于 1 分钟后重试（${retryMinutes} 分钟，${reason || '未说明原因'}）`);
}

let pageTimerMessageWriteChain = Promise.resolve();

function sendSerializedPageTimerMessage(
  tabId,
  message,
  automationRevision = null,
  shutdownRevision = null
) {
  const operation = pageTimerMessageWriteChain
    .catch(() => {})
    .then(async () => {
      if (automationRevision !== null
          && !isAutomationOperationCurrent(automationRevision)) {
        return { success: false, automationStale: true, error: '自动控制已暂停' };
      }
      if (shutdownRevision !== null
          && !isTimerBasedShutdownCurrent(shutdownRevision)) {
        return { success: false, shutdownStale: true, error: '关机请求已失效' };
      }
      const result = await sendMessageToExactACHome(tabId, message);
      if (automationRevision !== null
          && !isAutomationOperationCurrent(automationRevision)) {
        return { success: false, automationStale: true, error: '自动控制已暂停' };
      }
      if (shutdownRevision !== null
          && !isTimerBasedShutdownCurrent(shutdownRevision)) {
        return { success: false, shutdownStale: true, error: '关机请求已失效' };
      }
      return result;
    });
  pageTimerMessageWriteChain = operation.catch(() => {});
  return operation;
}

// 提取（Fowler Extract Function）：只在已锁定的精确 home tab 写入 picker。
// 这是“先保险后开机”的 provisional 写入原语；本函数不写 storage proof，
// 正式证明仍由 setPageTimer() 在 ON 后通过独立新鲜页确认。
async function writePageTimerOnExactHomeTab(
  tabId,
  minutes,
  {
    targetAt = 0,
    automationRevision = null,
    shutdownRevision = null
  } = {}
) {
  const pageReady = await waitForTabReady(tabId, 30000, isACHomePageTab);
  if (!pageReady) return { success: false, error: 'AC 页面等待就绪超时' };
  const tab = await getExactACHomeTab(tabId);
  if (!tab || tab.discarded) {
    return { success: false, invalidTarget: true, error: '页面定时器目标标签已离开精确 home URL' };
  }
  const contentReady = await ensureContentScriptLoaded(tabId);
  if (!contentReady) return { success: false, error: 'AC 页面 content script 未就绪' };

  const result = await sendSerializedPageTimerMessage(tabId, {
    action: 'setTimer',
    minutes,
    targetAt
  }, automationRevision, shutdownRevision);
  if (result?.automationStale || result?.shutdownStale || !result?.success) {
    return result || { success: false, error: t('bgPageTimerFailed') };
  }
  const value = String(result.value || '').trim();
  const resolvedTargetAt = Number(result.targetAt);
  if (!value || !Number.isSafeInteger(resolvedTargetAt) || resolvedTargetAt <= Date.now()) {
    return { success: false, error: '页面定时器预置未返回可验证的未来目标时间' };
  }
  return result;
}

// ----- 设置页面自带定时器（安全网，自动关不用手动开）-----
async function setPageTimer(
  minutes,
  {
    retryOnFailure = true,
    targetAt = 0,
    preferredTabId = null,
    automationRevision = null,
    shutdownRevision = null
  } = {}
) {
  let autoCreatedTabId = null;

  const staleAutomationResult = () => ({
    success: false,
    automationStale: true,
    shutdownStale: shutdownRevision !== null,
    error: shutdownRevision !== null ? '关机请求已失效' : '自动控制已暂停'
  });

  const automationWriteIsCurrent = () => (
    automationRevision === null
      || isAutomationOperationCurrent(automationRevision)
  ) && (
    shutdownRevision === null
      || isTimerBasedShutdownCurrent(shutdownRevision)
  );

  const finishFailure = async (failure, reason) => {
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    schedule.pageTimerMinutes = null;
    schedule.pageTimerTargetAt = 0;
    schedule.pageTimerError = failure.error || t('bgPageTimerFailed');

    if (retryOnFailure) {
      await schedulePageTimerRetry(minutes, reason);
    } else {
      schedule.pageTimerRetryAt = 0;
      schedule.pageTimerRetryMinutes = 0;
      await chrome.alarms.clear('ac-page-timer-retry');
    }

    if (!automationWriteIsCurrent()) return staleAutomationResult();
    await persistSchedule(`setPageTimer-${reason}`);
    console.warn('[AC扩展] 页面定时器设置失败:', schedule.pageTimerError);
    return failure;
  };

  // 提取（Fowler Extract Function）：页面定时器成功后的证明记录——解析目标时刻、清重试态、持久化并回传验证结果。
  const recordPageTimerProof = async (result, minutes, verification) => {
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    const targetAt = Number(result.targetAt);
    if (!Number.isSafeInteger(targetAt) || targetAt <= Date.now()) {
      return finishFailure({
        success: false,
        error: '页面定时器未返回有效的未来绝对目标时间'
      }, 'invalid-target');
    }
    await chrome.alarms.clear('ac-page-timer-retry');
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    schedule.pageTimerTargetAt = targetAt;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;
    schedule.pageTimerRetryMinutes = 0;
    await persistSchedule('setPageTimer-success');
    console.log(`[AC扩展] 页面定时器已由新鲜页面确认: ${verification.value} (安全网)`);
    return { ...result, verified: true, verification };
  };

  try {
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    let tab = Number.isInteger(preferredTabId)
      ? await getExactACHomeTab(preferredTabId)
      : null;
    if (Number.isInteger(preferredTabId) && (!tab || tab.discarded)) {
      throw new Error('指定的页面定时器标签已离开精确 home URL');
    }

    if (!tab) {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
      tab = tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded) || null;
    }

    if (!tab?.id) {
      tab = await chrome.tabs.create({ url: AC_PAGE, active: false });
      autoCreatedTabId = tab?.id || null;
      if (!autoCreatedTabId) throw new Error(t('bgPageTimerNoTab'));
      console.log('[AC扩展] 页面定时器：无现有 AC 页面，已创建隐藏标签页');
    }

    const result = await writePageTimerOnExactHomeTab(tab.id, minutes, {
      targetAt,
      automationRevision,
      shutdownRevision
    });
    if (result?.automationStale || result?.shutdownStale) return result;
    if (!result?.success) {
      return await finishFailure(result || { success: false, error: t('bgPageTimerFailed') }, 'failed');
    }

    const expectedValue = String(result.value || '').trim();
    if (!expectedValue) {
      return await finishFailure({ success: false, error: '页面定时器未返回可验证的目标时间' }, 'empty-value');
    }

    const verification = await verifyPageTimerPersistence(expectedValue, {
      automationRevision,
      shutdownRevision
    });
    if (verification.automationStale
        || verification.shutdownStale
        || !automationWriteIsCurrent()) {
      return staleAutomationResult();
    }
    if (!verification.success) {
      return await finishFailure({
        success: false,
        error: verification.error || '页面定时器新鲜页面验证后未确认'
      }, 'persistence-check-failed');
    }

    schedule.pageTimerMinutes = result.actualDelayMinutes || minutes;
    return await recordPageTimerProof(result, minutes, verification);
  } catch (e) {
    return await finishFailure({ success: false, error: e?.message || String(e) }, 'exception');
  } finally {
    if (autoCreatedTabId) {
      chrome.alarms.create(`ac-close-tab-${autoCreatedTabId}`, { delayInMinutes: 1 });
    }
  }
}

async function clearSupersededTimerBasedShutdownRetry() {
  invalidateTimerBasedShutdown();
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
  await chrome.alarms.clear('ac-page-timer-retry');
  await persistSchedule(
    'clear-superseded-timer-based-shutdown-retry',
    { syncFromLiveAlarm: false }
  );
}

function canReusePageTimerProof(state, requestedMinutes, now) {
  const targetAt = Number(state?.pageTimerTargetAt);
  const latestTargetAt = now + requestedMinutes * 60000 + 90000;
  return Number.isFinite(targetAt)
    && targetAt > now
    && targetAt <= latestTargetAt
    && isPageTimerProofFresh(state, { now });
}

async function requestTimerBasedShutdown(reason = '', minutes = 1) {
  const shutdownRevision = claimTimerBasedShutdown();
  const requestedMinutes = Math.max(1, sanitizeMinutes(minutes, 1));
  const now = Date.now();
  if (canReusePageTimerProof(schedule, requestedMinutes, now)) {
    console.log(`[AC扩展] ${reason}: 页面关机定时器已正确设置 (${schedule.pageTimerMinutes} 分钟)，无需点击或重设`);
    return {
      success: true,
      alreadyArmed: true,
      timerBased: true,
      minutes: schedule.pageTimerMinutes,
      reason
    };
  }

  const hadStaleProof = Number(schedule.pageTimerMinutes) > 0
    || Number(schedule.pageTimerTargetAt) > 0
    || Number(schedule.pageTimerRetryAt) > 0
    || Number(schedule.pageTimerRetryMinutes) > 0;
  if (hadStaleProof) {
    clearPageTimerProofState();
    await chrome.alarms.clear('ac-page-timer-retry');
  }

  if (!isTimerBasedShutdownCurrent(shutdownRevision)) {
    return { success: false, shutdownStale: true, error: '关机请求已失效', reason };
  }
  const status = await getCurrentACStatus();
  if (!isTimerBasedShutdownCurrent(shutdownRevision)) {
    return { success: false, shutdownStale: true, error: '关机请求已失效', reason };
  }
  if (status?.isOn === false) {
    if (hadStaleProof) {
      await persistSchedule(`${reason}-clear-stale-page-timer-proof`);
    }
    return { success: true, alreadyDone: true, timerBased: true, reason };
  }

  const result = await setPageTimer(requestedMinutes, { shutdownRevision });
  if (result?.shutdownStale) return result;
  if (result?.success) {
    console.log(`[AC扩展] ${reason}: 已请求页面定时器在 ${requestedMinutes} 分钟后关机（不点击开关）`);
    return { success: true, timerBased: true, minutes: requestedMinutes, result, reason };
  }

  return {
    success: false,
    timerBased: true,
    error: result?.error || '页面关机定时器设置失败',
    result,
    reason
  };
}

// ----- 闹钟触发时执行 -----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Edge/Chrome 可能因为 alarm 唤醒 Service Worker。
  // 必须等 storage 恢复完成，否则 schedule.enabled 还是默认 false，会跳过自动关机。
  await initReady;
  if (alarm.name === ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM) {
    try {
      await rescheduleActiveBoundary();
    } catch (error) {
      try {
        await armActiveBoundaryOwnerReadRetry(
          'active-boundary owner 重读仍失败'
        );
      } catch (retryError) {
        console.warn('[AC扩展] active-boundary owner 重读与重试钟均失败:', retryError?.message);
      }
      void appendDiagnosticLog('warn', 'alarm-active-boundary-owner-read', error);
    }
    return;
  }
  const activeBoundaryAlarm = alarm.name === 'ac-active-boundary'
    || alarm.name === ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM;
  const typedScheduleBoundaryAlarm =
    alarm.name === ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM;
  let activeBoundaryRetry = {
    retryAt: 0,
    mode: '',
    boundaryAt: 0,
    readOk: true
  };
  if (activeBoundaryAlarm) {
    activeBoundaryRetry = await readDurableActiveBoundaryRetry();
  }
  const activeBoundaryAlarmAt = Number(alarm.scheduledTime) || 0;
  let oppositeActiveBoundaryAlarmAt = 0;
  let sameActiveBoundaryAlarmAt = 0;
  if (activeBoundaryAlarm) {
    const oppositeAlarmName = typedScheduleBoundaryAlarm
      ? 'ac-active-boundary'
      : ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM;
    const [sameAlarm, oppositeAlarm] = await Promise.all([
      chrome.alarms.get(alarm.name).catch(() => null),
      chrome.alarms.get(oppositeAlarmName).catch(() => null)
    ]);
    sameActiveBoundaryAlarmAt = Number(sameAlarm?.scheduledTime) || 0;
    oppositeActiveBoundaryAlarmAt = Number(oppositeAlarm?.scheduledTime) || 0;
  }
  const configuredNaturalBoundaryAt = alarm.name === 'ac-active-boundary'
    ? getNextActiveBoundary(new Date(
      activeBoundaryAlarmAt - PWM_RETRY_ALARM_TOLERANCE_MS - 1
    ))
    : 0;
  const deliveryIsConfiguredNaturalBoundary = configuredNaturalBoundaryAt > 0
    && Math.abs(configuredNaturalBoundaryAt - activeBoundaryAlarmAt)
      <= PWM_RETRY_ALARM_TOLERANCE_MS;
  if (sameActiveBoundaryAlarmAt
      > activeBoundaryAlarmAt + PWM_RETRY_ALARM_TOLERANCE_MS
      && !deliveryIsConfiguredNaturalBoundary) {
    console.warn(`[AC扩展] 忽略已有较新同名 owner 的旧 ${alarm.name}`);
    return;
  }
  const newerOppositeRetryOwner = oppositeActiveBoundaryAlarmAt
      > activeBoundaryAlarmAt + PWM_RETRY_ALARM_TOLERANCE_MS
    && oppositeActiveBoundaryAlarmAt
      <= Date.now() + ACTIVE_BOUNDARY_RETRY_MS
        + PWM_RETRY_ALARM_TOLERANCE_MS;
  if (newerOppositeRetryOwner) {
    console.warn(`[AC扩展] 忽略已有较新 opposite owner 的旧 ${alarm.name}`);
    return;
  }

  // storage 瞬断时不猜 owner，也不消费另一个较新的 retry。schedule-only
  // 若下一次重读前将跨 captured boundary，就升级成 typed action，避免每次
  // +1min 漂移 provenance 后把已经到期的进入/退出动作遗忘。
  if (activeBoundaryAlarm && activeBoundaryRetry.readOk === false) {
    const inferredUnreadBoundaryAt = typedScheduleBoundaryAlarm
      ? getNextActiveBoundary(new Date(
        activeBoundaryAlarmAt - ACTIVE_BOUNDARY_RETRY_MS
          - PWM_RETRY_ALARM_TOLERANCE_MS
      ))
      : 0;
    const unreadRetryAt = Date.now() + ACTIVE_BOUNDARY_RETRY_MS;
    const unreadRetryMode = typedScheduleBoundaryAlarm
        && (inferredUnreadBoundaryAt <= 0
          || inferredUnreadBoundaryAt
            > unreadRetryAt + PWM_RETRY_ALARM_TOLERANCE_MS)
      ? ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
      : ACTIVE_BOUNDARY_RETRY_MODE_ACTION;
    const requeued = await createActiveBoundaryAlarmWithRetry(
      unreadRetryAt,
      { mode: unreadRetryMode }
    );
    if (!requeued) {
      const retryError = new Error('active-boundary owner 读取失败且 typed retry 未建立');
      void appendDiagnosticLog('error', 'alarm-active-boundary-owner-read', retryError);
      throw retryError;
    }
    console.warn(`[AC扩展] active-boundary owner 暂不可读，延后 ${alarm.name}`);
    return;
  }

  const inferredScheduleBoundaryAt = typedScheduleBoundaryAlarm
    ? getNextActiveBoundary(new Date(
      activeBoundaryAlarmAt - ACTIVE_BOUNDARY_RETRY_MS
        - PWM_RETRY_ALARM_TOLERANCE_MS
    ))
    : 0;
  const scheduleRetryBoundaryAt = Number(activeBoundaryRetry.boundaryAt)
    || inferredScheduleBoundaryAt;
  const deliveryMatchesRetryOwner = activeBoundaryRetry.retryAt > 0
    && Math.abs(activeBoundaryAlarmAt - activeBoundaryRetry.retryAt)
      <= PWM_RETRY_ALARM_TOLERANCE_MS;
  const laterSameTypeDelivery = activeBoundaryRetry.retryAt > 0
    && activeBoundaryAlarmAt
      > activeBoundaryRetry.retryAt + PWM_RETRY_ALARM_TOLERANCE_MS
    && ((typedScheduleBoundaryAlarm
        && activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE)
      || (alarm.name === 'ac-active-boundary'
        && activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_ACTION));
  if (laterSameTypeDelivery) {
    // 读失败后的 typed wake-up 只负责唤醒 owner repair；先把 durable/live
    // timestamp 重新收成精确一致，下一次 delivery 才能执行语义动作。
    await rescheduleActiveBoundary();
    return;
  }
  const deliveryMatchesCapturedBoundary = scheduleRetryBoundaryAt > 0
    && Math.abs(activeBoundaryAlarmAt - scheduleRetryBoundaryAt)
      <= PWM_RETRY_ALARM_TOLERANCE_MS;
  const typedScheduleSupersedesOlderAction = typedScheduleBoundaryAlarm
    && activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_ACTION
    && activeBoundaryAlarmAt
      > activeBoundaryRetry.retryAt + PWM_RETRY_ALARM_TOLERANCE_MS;
  const typedActionSupersedesOlderSchedule =
    alarm.name === 'ac-active-boundary'
    && activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
    && activeBoundaryAlarmAt
      > activeBoundaryRetry.retryAt + PWM_RETRY_ALARM_TOLERANCE_MS;
  const scheduleRetryOwner = typedScheduleBoundaryAlarm
    && ((activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
        && deliveryMatchesRetryOwner)
      || activeBoundaryRetry.retryAt <= 0
      || typedScheduleSupersedesOlderAction);
  const actionRetryOwner = alarm.name === 'ac-active-boundary'
    && ((activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_ACTION
        && deliveryMatchesRetryOwner)
      || typedActionSupersedesOlderSchedule);
  const markerlessActionOrNaturalOwner = alarm.name === 'ac-active-boundary'
    && activeBoundaryRetry.retryAt <= 0;
  const capturedNaturalBoundaryOwner = alarm.name === 'ac-active-boundary'
    && activeBoundaryRetry.mode === ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE
    && deliveryMatchesCapturedBoundary;
  const activeBoundaryDeliveryOwned = scheduleRetryOwner
    || actionRetryOwner
    || markerlessActionOrNaturalOwner
    || capturedNaturalBoundaryOwner;

  // opposite kind 的 clear 即使失败，迟到 delivery 也无权改写较新的
  // durable (mode,retryAt) owner。
  if (activeBoundaryAlarm && !activeBoundaryDeliveryOwned) {
    console.warn(`[AC扩展] 忽略失去 owner 的旧 ${alarm.name}`);
    return;
  }

  const scheduleRetryCrossedBoundary =
    scheduleRetryOwner
    && scheduleRetryBoundaryAt > 0
    && scheduleRetryBoundaryAt <= Date.now() + PWM_RETRY_ALARM_TOLERANCE_MS;
  const scheduleOnlyActiveBoundaryDelivery =
    scheduleRetryOwner
    && !scheduleRetryCrossedBoundary;
  const activeBoundaryActionDelivery = actionRetryOwner
    || markerlessActionOrNaturalOwner
    || capturedNaturalBoundaryOwner
    || scheduleRetryCrossedBoundary;

  // 自然钟创建失败后的 +1min 只补基础设施；边界动作（尤其
  // setupAlarms(true)）已经成功，绝不能再次执行而后移当前 PWM 相位。
  if (scheduleOnlyActiveBoundaryDelivery) {
    try {
      const completed = await completeActiveBoundaryProcessing({
        requireExpectedOwner: true,
        expectedRetryAt: activeBoundaryRetry.retryAt,
        expectedRetryMode: activeBoundaryRetry.mode,
        expectedRetryBoundaryAt: activeBoundaryRetry.boundaryAt,
        expectedDeliveryAt: activeBoundaryAlarmAt,
        expectedAlarmName: alarm.name
      });
      if (completed === false) {
        console.warn('[AC扩展] schedule-only delivery 已失去 owner，零动作退出');
      }
    } catch (error) {
      try {
        await armActiveBoundaryRetry(
          'active-boundary 仅补钟失败',
          {
            mode: ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE,
            boundaryAt: scheduleRetryBoundaryAt
          }
        );
      } catch (retryError) {
        console.warn('[AC扩展] active-boundary 仅补钟失败且重试钟创建失败:', retryError?.message);
      }
      void appendDiagnosticLog('warn', 'alarm-active-boundary-schedule', error);
    }
    return;
  }
  const phaseSensitiveAlarm = alarm.name === 'ac-pwm'
    || alarm.name === 'ac-watchdog'
    || alarm.name === 'ac-badge-tick'
    || (activeBoundaryActionDelivery
      && schedule.activeHours?.enabled === true);
  const deferPhaseSensitiveAlarm = async () => {
    if (alarm.name === 'ac-badge-tick') {
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    } else if (activeBoundaryActionDelivery) {
      await deferActiveBoundaryForPhaseAdoption();
      return;
    }
    console.warn(`[AC扩展] sync 相位接管尚未收口，延后 ${alarm.name}`);
  };
  // 先于 storage reload 守门：若 reservation 已持有，按其新 revision
  // load 旧 storage 会反向覆盖尚未 durable 的 remote phase。
  if (phaseSensitiveAlarm && isSyncPhaseAdoptionAdmissionBlocked()) {
    await deferPhaseSensitiveAlarm();
    return;
  }
  await loadScheduleFromStorage();
  if (phaseSensitiveAlarm && isSyncPhaseAdoptionAdmissionBlocked()) {
    await deferPhaseSensitiveAlarm();
    return;
  }

  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);

  if (alarm.name === 'ac-sync-publish-retry') {
    await syncScheduleToSync('alarm-sync-publish-retry');
    return;
  }

  if (alarm.name === 'ac-sync-adopt-retry') {
    await tryAdoptSyncedState('alarm-sync-adopt-retry');
    return;
  }

  if (alarm.name === 'ac-badge-tick') {
    // 每分钟刷新角标
    await updateBadge();
    // L2 长连接保活不变量:每分钟顺带确保 offscreen 文档仍在,
    // 防止 Chrome/Edge 在长时间无活跃后回收 offscreen 文档导致端口失活。
    await ensureOffscreen();
    // 间隔模式下的 storage 一致性校准:PWM 步骤漏写 storage 时,1 分钟内会被这里纠正。
    // 这样诊断面板看到的 storage.nextTriggerAt 永远不会落后 live ac-pwm 超过 1 分钟。
    if (isAutomationAllowed()) {
      try {
        const automationRevision = pwmRuntimeRevision;
        const liveAlarm = await chrome.alarms.get('ac-pwm');
        const triggerPlan = await persistReconciledPwmTrigger(
          liveAlarm,
          'badge-tick-sync',
          PWM_TRIGGER_NEXT_ONLY_OPTIONS,
          automationRevision
        );
        if (triggerPlan) {
          console.log(`[AC扩展] badge-tick: 已同步 nextTriggerAt ← live alarm (${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()})`);
        }
      } catch (e) {
        console.warn('[AC扩展] badge-tick 同步失败:', e?.message);
        void appendDiagnosticLog('warn', 'alarm-badge-tick', e);
      }
    }
    // delayInMinutes 是一次性的，触发后重新创建
    if (isAutomationAllowed()) await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    return;
  }
  
  if (alarm.name === 'ac-pwm') {
    const deliveryNow = Date.now();
    const deliveryAssessment = assessPwmAlarmDelivery(
      schedule,
      alarm.scheduledTime,
      deliveryNow
    );
    if (!deliveryAssessment.accepted) {
      console.warn(
        `[AC扩展] 拒绝失配 ac-pwm 事件 (${deliveryAssessment.reason})；改走只读状态的 repair 路径`
      );
      const invalidSmartOnClock = deliveryAssessment.smartClockAssessment
        ?.applicable === true
        && deliveryAssessment.smartClockAssessment?.valid === false;
      await repairScheduleClock({
        smartOnExpectedBoundaryAt: Number(
          deliveryAssessment.smartClockAssessment?.expectedAt
        ) || 0,
        revokeInvalidSmartOnClock: invalidSmartOnClock,
        ...(invalidSmartOnClock
          ? { revokeOwnerRevision: pwmRuntimeRevision }
          : {})
      });
      return;
    }
    const deliveryRetryContext = getSmartOnPwmRetryContext(
      schedule,
      alarm.scheduledTime,
      { now: deliveryNow }
    );
    if (deliveryRetryContext.hasSafetyTimerRetry) {
      await repairScheduleClock({
        smartOnExpectedBoundaryAt: deliveryRetryContext.boundaryAt
      });
      return;
    }
    // pwmStepRunning 已在 runPwmStep 内部防重入，此处无需再做去重；
    // 原先基于 alarmCreatedAt 的去重会在 SW 被闹钟唤醒后误杀合法闹钟
    // （init()→setupAlarms()→syncStoredTriggerFromAlarm() 会覆写 alarmCreatedAt 为 Date.now()，
    //   导致 alarm.scheduledTime ≈ Date.now() ≤ alarmCreatedAt+1000 成立，闹钟被丢弃）。
    // 舒适启动的前置恢复与正式 PWM 共用异常边界；任何一步抛错都会保留
    // 本次闹钟的 revision/action，并只建立安全的一分钟恢复时钟。
    const alarmAutomationRevision = pwmRuntimeRevision;
    await executePwmStepWithRecovery({
      scheduledTime: alarm.scheduledTime,
      automationRevision: alarmAutomationRevision,
      source: 'alarm-ac-pwm',
      beforeRun: async () => {
      const comfortUntil = Number(schedule.comfortStartUntil) || 0;
      if (comfortUntil > 0) {
        const alarmAt = Number(alarm.scheduledTime) || Date.now();
        if (isComfortStartActive() && alarmAt + 1000 < comfortUntil) {
          let comfortRetryResult = null;
          try {
            comfortRetryResult = await runSerializedScheduleUpdate(
              () => retryComfortStartAndFinishIfExpired('retry')
            );
          } catch (error) {
            // runComfortStart 会 claim 新 revision 并先清旧主钟；异常时必须用
            // 新 owner 的 comfort defer 补钟，不能让 shared executor 按旧 revision
            // 误判 stale 后静默等待 watchdog。
            const comfortRevision = pwmRuntimeRevision;
            try {
              await deferComfortStart(
                error?.message || String(error),
                comfortRevision
              );
            } catch (recoveryError) {
              throw tagPwmAutomationError(
                recoveryError,
                comfortRevision,
                null
              );
            }
          }
          return comfortRetryResult?.continuePwm === true
            ? {
                automationRevision:
                  comfortRetryResult.continuationAutomationRevision
              }
            : false;
        }
        const comfortEnd = await runSerializedScheduleUpdate(
          () => finishComfortStart('pwm-boundary')
        );
        if (!comfortEnd?.automationAllowed || comfortEnd?.deferred) return false;
        return { automationRevision: comfortEnd.automationRevision };
      }
        return { automationRevision: alarmAutomationRevision };
      }
    });
    return;
  }

  if (alarm.name === 'ac-watchdog') {
    try {
      await watchdogCheck();
      // v0.5.10：看门狗每 5 分钟尝试从打开的 AC 页面读取 page timer。
      //         page timer 现为跨设备主同步通道——不再限制 pwmState='on'。
      //         无 AC 页面则静默跳过；5 分钟间隔避免频繁读 DOM。
      if (isAutomationAllowed()) {
        tryAdoptPageTimer('watchdog').catch(e => /* 不阻塞闹钟流程 */ {});
      }
    } catch (e) {
      console.error('[AC扩展] 看门狗执行失败:', e);
      void appendDiagnosticLog('error', 'alarm-watchdog', e);
    }
  }

  if (activeBoundaryActionDelivery) {
    try {
      await onActiveBoundaryCrossed();
    } catch (e) {
      console.warn('[AC扩展] active hours boundary 处理失败:', e?.message);
      void appendDiagnosticLog('warn', 'alarm-active-boundary', e);
      rescheduleActiveBoundary();  // 出错也重新调度，避免漏掉下次
    }
  }

  if (alarm.name === 'ac-comfort-end') {
    try {
      const comfortAlarmNow = Date.now();
      const livePwmAt = Number((await chrome.alarms.get('ac-pwm'))?.scheduledTime) || 0;
      const storedPwmAt = Number(schedule.nextTriggerAt) || 0;
      const futureMainClockAt = livePwmAt > comfortAlarmNow + PWM_RETRY_ALARM_TOLERANCE_MS
        ? livePwmAt
        : storedPwmAt > comfortAlarmNow + PWM_RETRY_ALARM_TOLERANCE_MS
          ? storedPwmAt
          : 0;
      const comfortResult = await runSerializedScheduleUpdate(async () => {
        if (isComfortStartActive() && schedule.pwmState === 'on') {
          return retryComfortStartAndFinishIfExpired('retry');
        }
        const finishResult = await finishComfortStart('end-alarm');
        return {
          finishResult,
          // 正常 comfort-end 可能早于用户原有的更晚 page timer/ac-pwm；这里只
          // 结束舒适标记，不提前消费仍有所有权的普通 PWM 边界。若本 alarm
          // 是主钟创建失败后的 fallback（无未来 main clock），则立即恢复 PWM。
          continuePwm: shouldResumePwmAfterComfortFinish(
            finishResult,
            futureMainClockAt
          ),
          continuationAutomationRevision: finishResult?.automationRevision
        };
      });
      const comfortContinuationRevision = Number(
        comfortResult?.continuationAutomationRevision
      );
      if (comfortResult?.continuePwm
          && Number.isSafeInteger(comfortContinuationRevision)) {
        await executePwmStepWithRecovery({
          automationRevision: comfortContinuationRevision,
          source: 'alarm-comfort-end-resume'
        });
      }
    } catch (e) {
      console.warn('[AC扩展] 五分钟舒适启动结束处理失败:', e?.message);
      void appendDiagnosticLog('warn', 'alarm-comfort-start-end', e);
      await scheduleComfortStartEndAlarm();
    }
    return;
  }

  if (alarm.name === 'ac-smart-weather') {
    const boundaryAt = smartWeatherTargetBoundaryAt(alarm.scheduledTime);
    await rescheduleSmartWeatherAlarm();
    if (schedule.smartMode?.enabled && boundaryAt > Date.now()) {
      try {
        const prepared = await prepareSmartWeatherForBoundary(boundaryAt);
        if (!prepared) {
          console.warn('[AC扩展] 智能天气预取未生成有效边界快照，保留最近成功快照');
        }
      } catch (e) {
        console.warn('[AC扩展] 智能天气预取失败:', e?.message);
      }
    }
  }

  if (alarm.name === 'ac-page-timer-retry') {
    if (schedule.pageTimerRetryAt) {
      if (isAutomationAllowed()) {
        await clearSupersededTimerBasedShutdownRetry();
        return;
      }
      await requestTimerBasedShutdown('page-timer-retry', 1);
    }
  }

  if (alarm.name.startsWith('ac-close-tab-')) {
    const tabId = Number.parseInt(alarm.name.slice('ac-close-tab-'.length), 10);
    if (Number.isFinite(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch (_) { /* tab may already be closed */ }
    }
  }
});

// ----- 官方推荐：长时间操作保活，防止 SW 在异步等待期间被杀死 -----
async function waitUntil(promise) {
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25 * 1000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

// ----- 官方推荐：scripting.executeScript 兜底，当 content script 未加载时强制注入 -----
const CONTENT_SCRIPT_PROBE_TIMEOUT_MS = 1000;
const CONTENT_SCRIPT_READ_TIMEOUT_MS = 1000;

async function ensureContentScriptLoaded(tabId) {
  if (!await getExactACHomeTab(tabId)) return false;
  try {
    // 健康路径只探测一次；扩展 reload 后旧标签没有接收端时立即注入，
    // 不再先空等多轮。注入不刷新、不导航用户页面。
    const probe = await sendMessageToExactACHome(
      tabId,
      { action: 'ping' },
      { timeoutMs: CONTENT_SCRIPT_PROBE_TIMEOUT_MS }
    );
    if (probe?.success !== true) throw new Error('content script 健康探测返回异常');
    const runtimeIdentityAssessment = assessContentRuntimeIdentity(probe);
    if (!runtimeIdentityAssessment.valid) {
      throw new Error(
        `content/main 构建身份不一致 (${runtimeIdentityAssessment.code || 'unknown'})`
      );
    }
    return true;
  } catch (error) {
    console.log('[AC扩展] content script 缺失或混版，尝试原页重新注入:', error?.message);
  }

  return injectContentScriptsIntoExactHome(tabId);
}

// 错误页（chrome-error:// 网络/服务器失败等）不是代码缺陷，而是页面暂时不可用：
// 此时 tab.url 仍等于 AC_PAGE，精确守门放行，但 executeScript 会抛
// "Frame with ID 0 is showing error page"。读路径不得刷新页面，识别后降级为
// 告警并返回失败，交给看门狗 / PWM 重试在页面恢复后自然重试。
function isErrorPageError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error ?? '');
  return /showing error page/i.test(message);
}

async function injectContentScriptsIntoExactHome(tabId) {
  try {
    if (!await getExactACHomeTab(tabId)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['billing-helpers.js', 'content.js'],
      injectImmediately: true
    });
    if (!await getExactACHomeTab(tabId)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-confirm.js'],
      world: 'MAIN',
      injectImmediately: true
    });
    if (!await getExactACHomeTab(tabId)) return false;
    const probe = await sendMessageToExactACHome(
      tabId,
      { action: 'ping' },
      { timeoutMs: CONTENT_SCRIPT_PROBE_TIMEOUT_MS }
    );
    if (probe?.success !== true) throw new Error('重注入后的 content script 健康探测返回异常');
    const runtimeIdentityAssessment = assessContentRuntimeIdentity(probe);
    if (!runtimeIdentityAssessment.valid) {
      throw new Error('重注入后的 content/main 构建身份仍不一致');
    }
    console.log('[AC扩展] scripting.executeScript 兜底注入并复核完成 (ISOLATED + MAIN)');
    return true;
  } catch (error) {
    if (isErrorPageError(error)) {
      console.warn('[AC扩展] AC 页面正在显示错误页（网络/服务器问题），本次注入跳过，等待重试:', error?.message);
      void appendDiagnosticLog('warn', 'content-script-injection', error);
      return false;
    }
    console.error('[AC扩展] scripting.executeScript 兜底注入失败:', error?.message);
    void appendDiagnosticLog('error', 'content-script-injection', error);
    return false;
  }
}

// 诊断首现场只读探针：不注入、不刷新、不导航。旧 content 只回
// {success:true} 时会明确显示缺少 build 身份，而不会先自愈再假装原本正常。
async function inspectContentRuntime() {
  const tabs = await chrome.tabs.query({
    url: 'https://w5.ab.ust.hk/njggt/app/*'
  });
  const exactHomeTabs = tabs.filter(isACHomePageTab);
  const tab = exactHomeTabs.find(candidate => !candidate.discarded) || null;
  if (!tab?.id) {
    return {
      success: true,
      found: false,
      exactHomeTabCount: exactHomeTabs.length,
      runtimeIdentityAssessment: null
    };
  }
  try {
    const probe = await sendMessageToExactACHome(
      tab.id,
      { action: 'ping' },
      { timeoutMs: CONTENT_SCRIPT_PROBE_TIMEOUT_MS }
    );
    return {
      success: probe?.success === true,
      found: true,
      tabId: tab.id,
      probe,
      runtimeIdentityAssessment: assessContentRuntimeIdentity(probe)
    };
  } catch (error) {
    return {
      success: false,
      found: true,
      tabId: tab.id,
      error: error?.message || String(error),
      runtimeIdentityAssessment: assessContentRuntimeIdentity(null)
    };
  }
}

async function sendReadMessageToExactACHome(tabId, message) {
  const contentReady = await ensureContentScriptLoaded(tabId);
  if (!contentReady) throw new Error('AC 页面 content script 未就绪');

  try {
    return await sendMessageToExactACHome(
      tabId,
      message,
      { timeoutMs: CONTENT_SCRIPT_READ_TIMEOUT_MS }
    );
  } catch (error) {
    console.warn('[AC扩展] content script 只读消息无响应，强制原页重新注入:', error?.message);
    const recovered = await injectContentScriptsIntoExactHome(tabId);
    if (!recovered) throw error;
    return sendMessageToExactACHome(
      tabId,
      message,
      { timeoutMs: CONTENT_SCRIPT_READ_TIMEOUT_MS }
    );
  }
}

async function getExactACHomeTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return isACHomePageTab(tab) ? tab : null;
  } catch (_) {
    return null;
  }
}

async function sendMessageToExactACHome(
  tabId,
  message,
  {
    timeoutMs = 0,
    requireAutomationAllowed = false,
    automationRevision = null
  } = {}
) {
  const tab = await getExactACHomeTab(tabId);
  if (!tab) throw new Error('拒绝向非精确 AC home 标签发送消息');
  if (requireAutomationAllowed && message?.action === 'on') {
    const automaticOnIsCurrent = automationRevision === null
      ? isAutomationAllowed()
      : isAutomationOperationCurrent(automationRevision);
    if (!automaticOnIsCurrent) {
      throw new Error('运行时段外已暂停自动开启');
    }
  }

  const responsePromise = chrome.tabs.sendMessage(tabId, message);

  let timeoutId;
  try {
    const response = timeoutMs > 0
      ? await Promise.race([
          responsePromise,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`content script ${message?.action || 'unknown'} 探测超时`));
            }, timeoutMs);
          })
        ])
      : await responsePromise;
    if (message?.action !== 'ping') {
      const runtimeIdentityAssessment = assessContentRuntimeIdentity(response);
      if (!runtimeIdentityAssessment.valid) {
        throw new Error(
          `content/main 构建身份不一致，拒绝 ${message?.action || 'unknown'} 响应`
        );
      }
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cancelAutomaticOnRequests() {
  const tabs = await chrome.tabs.query({
    url: 'https://w5.ab.ust.hk/njggt/app/*'
  });
  await Promise.all(tabs
    .filter(tab => isACHomePageTab(tab) && Number.isInteger(tab?.id))
    .map(async tab => {
      try {
        await sendMessageToExactACHome(tab.id, {
          action: 'cancelAutomaticOn'
        });
      } catch (_) {
        // 没有正在运行的 content listener 时无需恢复或注入。
      }
    }));
}

// 提取（Fowler Extract Function）：同一精确 home tab 上完成
// OFF → 预置 Power-off after → ON → 新鲜页确认。预置后的物理 ON 禁止刷新
// 恢复；失败由外围下一轮从重新预置开始，避免刷新丢 timer 后再开机。
async function turnOnWithPreparedPageTimer(
  tab,
  {
    pageTimerMinutes,
    pageTimerTargetAt = 0,
    notAfterAt = 0,
    requireAutomationAllowed = false,
    automationRevision = null
  } = {}
) {
  const timerMinutes = sanitizeMinutes(pageTimerMinutes, 0);
  if (!Number.isInteger(tab?.id) || timerMinutes <= 0) {
    return { success: false, pageTimerPrepared: false, error: '开机前页面定时器参数无效' };
  }

  const timerOptions = {
    retryOnFailure: false,
    targetAt: pageTimerTargetAt,
    preferredTabId: tab.id,
    automationRevision
  };
  const initialStatus = await getACStatusFromExactHomeTab(tab.id);
  if (initialStatus?.isOn === true) {
    const pageTimerResult = await setPageTimer(timerMinutes, timerOptions);
    return {
      success: pageTimerResult?.success === true,
      alreadyDone: true,
      toggleSucceeded: true,
      actualOn: true,
      pageTimerPrepared: false,
      pageTimerResult,
      error: pageTimerResult?.success ? '' : pageTimerResult?.error
    };
  }

  const preparedTimer = await writePageTimerOnExactHomeTab(tab.id, timerMinutes, {
    targetAt: pageTimerTargetAt,
    automationRevision
  });
  if (!preparedTimer?.success) {
    return {
      success: false,
      pageTimerPrepared: false,
      error: preparedTimer?.error || '开机前页面关机定时器预置失败',
      preparedTimer
    };
  }

  const exactTabAfterPrepare = await getExactACHomeTab(tab.id);
  if (!exactTabAfterPrepare || exactTabAfterPrepare.discarded) {
    return {
      success: false,
      invalidTarget: true,
      pageTimerPrepared: true,
      error: '页面定时器预置后标签未停留在精确 home URL；本轮拒绝开机'
    };
  }

  const toggleResult = await attemptACToggleWithRecovery(
    tab.id,
    'on',
    0,
    '',
    { notAfterAt, requireAutomationAllowed, automationRevision }
  );
  let actualOn = toggleResult?.success === true;
  let toggleAmbiguous = false;
  if (!actualOn) {
    const actualStatus = await getACStatusFromExactHomeTab(tab.id);
    actualOn = actualStatus?.isOn === true;
    if (!actualOn) {
      return {
        ...toggleResult,
        success: false,
        actualOn: false,
        pageTimerPrepared: true,
        error: toggleResult?.error || '开机未确认，保留预置 timer 并等待整笔重试'
      };
    }
    toggleAmbiguous = true;
    console.warn('[AC扩展] 开机结果含糊但同页状态已 ON；不再点击，仅验证预置关机保险');
  }

  // 正常路径已经等到新的 Execution succeeded + ON；含糊路径只读确认 ON。
  // 两者都在同一来源 tab 重写同一计划，然后才由独立新鲜页记录正式 proof。
  const pageTimerResult = await setPageTimer(timerMinutes, timerOptions);
  if (!pageTimerResult?.success) {
    return {
      success: false,
      toggleSucceeded: true,
      toggleAmbiguous,
      actualOn: true,
      pageTimerPrepared: true,
      toggleResult,
      pageTimerResult,
      error: pageTimerResult?.error || '开机已完成，但页面关机定时器未通过新鲜页验证'
    };
  }

  return {
    success: true,
    alreadyDone: toggleResult?.alreadyDone === true,
    toggleSucceeded: true,
    toggleAmbiguous,
    actualOn: true,
    pageTimerPrepared: true,
    toggleResult,
    pageTimerResult
  };
}

// ----- 切换 AC 状态 -----
function normalizeAcToggleRequest(
  action,
  {
    notAfterAt = 0,
    requireAutomationAllowed = false,
    automationRevision = null,
    pageTimerMinutes = 0,
    pageTimerTargetAt = 0
  } = {}
) {
  const requestedNotAfterAt = notAfterAt === 0
    ? 0
    : Number(notAfterAt);
  const requestedRequiresAutomation = action === 'on' && requireAutomationAllowed === true;
  const requestedAutomationRevision = requestedRequiresAutomation
    ? automationRevision
    : null;
  const requestedPageTimerMinutes = action === 'on'
    ? sanitizeMinutes(pageTimerMinutes, 0)
    : 0;
  const requestedPageTimerTargetAt = action === 'on'
    ? Number(pageTimerTargetAt) || 0
    : 0;
  if (requestedNotAfterAt !== 0 && !Number.isSafeInteger(requestedNotAfterAt)) {
    return { success: false, error: '自动开启窗口截止时间无效' };
  }
  if (pageTimerMinutes !== 0 && requestedPageTimerMinutes <= 0) {
    return { success: false, error: '开机前页面定时器分钟数无效' };
  }
  if (requestedPageTimerTargetAt !== 0
      && (!Number.isSafeInteger(requestedPageTimerTargetAt)
        || requestedPageTimerTargetAt <= Date.now())) {
    return { success: false, error: '开机前页面定时器绝对目标无效' };
  }
  return {
    request: {
      action,
      notAfterAt: requestedNotAfterAt,
      requireAutomationAllowed: requestedRequiresAutomation,
      automationRevision: requestedAutomationRevision,
      pageTimerMinutes: requestedPageTimerMinutes,
      pageTimerTargetAt: requestedPageTimerTargetAt
    }
  };
}

function sameAcToggleRequest(left, right) {
  return left?.action === right?.action
    && left?.notAfterAt === right?.notAfterAt
    && left?.requireAutomationAllowed === right?.requireAutomationAllowed
    && left?.automationRevision === right?.automationRevision
    && left?.pageTimerMinutes === right?.pageTimerMinutes
    && left?.pageTimerTargetAt === right?.pageTimerTargetAt;
}

async function toggleAC(
  action,
  {
    notAfterAt = 0,
    requireAutomationAllowed = false,
    automationRevision = null,
    pageTimerMinutes = 0,
    pageTimerTargetAt = 0
  } = {}
) {
  const normalized = normalizeAcToggleRequest(action, {
    notAfterAt,
    requireAutomationAllowed,
    automationRevision,
    pageTimerMinutes,
    pageTimerTargetAt
  });
  if (!normalized.request) return normalized;
  const request = normalized.request;
  const requestedAutomationIsCurrent = request.automationRevision === null
    ? isAutomationAllowed()
    : isAutomationOperationCurrent(request.automationRevision);
  if (request.requireAutomationAllowed && !requestedAutomationIsCurrent) {
    return { success: false, automationPausedByActiveHours: true, error: '运行时段外已暂停自动开启' };
  }
  if (activeAcToggleAttempt) {
    if (sameAcToggleRequest(activeAcToggleAttempt.request, request)) {
      console.log(`[AC扩展] 合并重复的 toggleAC(${action}) 请求`);
      return activeAcToggleAttempt.promise;
    }
    return {
      success: false,
      busy: true,
      error: `toggleAC(${activeAcToggleAttempt.request.action}) 仍在执行，本次 ${action} 不重复点击`
    };
  }

  const attempt = {
    request,
    promise: toggleACOnce(action, {
      notAfterAt: request.notAfterAt,
      requireAutomationAllowed: request.requireAutomationAllowed,
      automationRevision: request.automationRevision,
      pageTimerMinutes: request.pageTimerMinutes,
      pageTimerTargetAt: request.pageTimerTargetAt
    })
  };
  activeAcToggleAttempt = attempt;
  try {
    return await attempt.promise;
  } finally {
    if (activeAcToggleAttempt === attempt) activeAcToggleAttempt = null;
  }
}

async function toggleACOnce(action, options = {}) {
  // A1: 顶层幂等预检 — 先查当前 AC 真实状态，已是目标则跳过，避免多余开关噪音
  const needOn = action === 'on';
  const preparePageTimer = needOn && Number(options?.pageTimerMinutes) > 0;
  if (!preparePageTimer) {
    try {
      const preStatus = await getCurrentACStatus();
      if (typeof preStatus?.isOn === 'boolean' && preStatus.isOn === needOn) {
        console.log(`[AC扩展] 幂等预检：AC 已在目标状态 (${action})，跳过切换`);
        return { success: true, alreadyDone: true, action };
      }
    } catch (_) { /* 预检失败不影响主流程 */ }
  }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const homeTab = tabs.find(tab => isACHomePageTab(tab) && !tab.discarded);

  if (homeTab?.id) {
    return waitUntil(_toggleOnExistingTab(homeTab, action, options));
  }

  console.log('[AC扩展] 没有精确 AC home 页面，创建隐藏标签...');
  const created = await chrome.tabs.create({ url: AC_PAGE, active: false });
  return waitUntil(_toggleOnNewTab(created?.id, action, options));
}

async function _toggleOnExistingTab(tab, action, options = {}) {
  // 操作目标必须从始至终精确等于 AC_PAGE。billing-cycle、warning、登录回调、
  // query/hash 变体和相似路径都属于用户页面，禁止导航、注入或发送空调消息。
  if (!isACHomePageTab(tab)) {
    return {
      success: false,
      invalidTarget: true,
      error: '拒绝在非精确 AC home 标签执行空调操作'
    };
  }

  if (action === 'on' && Number(options?.pageTimerMinutes) > 0) {
    return turnOnWithPreparedPageTimer(tab, options);
  }

  return attemptACToggleWithRecovery(tab.id, action, 1, '', options);
}

function isTerminalACToggleRecoveryResult(action, result, options = {}, now = Date.now()) {
  if (action !== 'on') return false;
  if (result?.automationPausedByActiveHours === true) return true;
  if (result?.executionConfirmationMissing === true) return true;

  const notAfterAt = Number(options?.notAfterAt);
  return Number.isSafeInteger(notAfterAt)
    && notAfterAt > 0
    && now >= notAfterAt;
}

async function attemptACToggleOnExactHome(tabId, action, options = {}) {
  if (!await getExactACHomeTab(tabId)) {
    return {
      success: false,
      invalidTarget: true,
      tabId,
      error: '拒绝在非精确 AC home 标签执行空调操作'
    };
  }

  const ready = await ensureContentScriptLoaded(tabId);
  if (!ready) {
    return { success: false, tabId, error: 'content script 注入失败' };
  }

  try {
    return await sendACToggleMessage(tabId, action, options);
  } catch (error) {
    console.error('[AC扩展] 发送消息失败:', error?.message);
    void appendDiagnosticLog('error', 'toggle-message', error);
    return { success: false, tabId, error: error?.message || String(error) };
  }
}

async function refreshACControlPage(tabId) {
  try {
    const currentTab = await chrome.tabs.get(tabId);
    if (isACHomePageTab(currentTab)) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url: AC_PAGE });
    }

    const pageReady = await waitForTabReady(tabId, 30000, isACHomePageTab);
    if (!pageReady) throw new Error('刷新后的 AC home 未在 30 秒内就绪');
    const readyTab = await getExactACHomeTab(tabId);
    if (!readyTab) {
      throw new Error('刷新后目标标签未停留在精确 AC home');
    }
    return readyTab;
  } catch (error) {
    console.error('[AC扩展] 恢复 AC 控制页面失败:', error?.message);
    void appendDiagnosticLog('error', 'toggle-refresh-recovery', error);
    return null;
  }
}

async function attemptACToggleWithRecovery(
  tabId,
  action,
  refreshesRemaining = 1,
  initialError = '',
  options = {}
) {
  const result = await attemptACToggleOnExactHome(tabId, action, options);
  const terminalResult = isTerminalACToggleRecoveryResult(action, result, options);
  if (result.success || result.invalidTarget || terminalResult || refreshesRemaining <= 0) {
    if (!result.success && initialError && !terminalResult) {
      void appendDiagnosticLog('error', 'toggle-refresh-recovery', new Error(result.error));
    }
    return initialError
      ? { ...result, recoveredByPageRefresh: true, initialError }
      : result;
  }

  const firstError = initialError || result.error || `${action} 首次操作未确认`;
  console.warn('[AC扩展] 空调操作未成功，恢复 AC 控制页面后重试:', firstError);
  const refreshedTab = await refreshACControlPage(tabId);
  if (!refreshedTab) {
    return {
      success: false,
      tabId,
      recoveredByPageRefresh: true,
      initialError: firstError,
      error: 'AC 控制页面恢复失败'
    };
  }

  return attemptACToggleWithRecovery(
    tabId,
    action,
    refreshesRemaining - 1,
    firstError,
    options
  );
}

async function sendACToggleMessage(tabId, action, options = {}) {
  const notAfterAt = Number(options?.notAfterAt) || 0;
  if (action === 'on'
      && options?.requireAutomationAllowed === true
    && (options?.automationRevision === null
      ? !isAutomationAllowed()
      : !isAutomationOperationCurrent(options?.automationRevision))) {
    return {
      success: false,
      tabId,
      automationPausedByActiveHours: true,
      error: '运行时段外已暂停自动开启'
    };
  }
  const result = await sendMessageToExactACHome(tabId, {
    action,
    ...(notAfterAt > 0 ? { notAfterAt } : {})
  }, {
    requireAutomationAllowed: options?.requireAutomationAllowed === true,
    automationRevision: options?.automationRevision ?? null
  });
  console.log(`[AC扩展] ${action} 命令返回:`, result);
  if (!result?.success) {
    console.warn('[AC扩展] 页面返回未确认:', result);
    return {
      success: false,
      tabId,
      result,
      executionConfirmationMissing: result?.executionConfirmationMissing === true,
      error: result?.error || `${action} 命令未确认`
    };
  }
  return {
    success: true,
    alreadyDone: result?.alreadyDone === true,
    tabId,
    result
  };
}

async function _toggleOnNewTab(tabId, action, options = {}) {
  try {
    const tab = await getReadyACTab(tabId, 30000);
    if (!tab?.id) {
      return { success: false, error: '新建的 AC 页面未就绪' };
    }

    return await _toggleOnExistingTab(tab, action, options);
  } finally {
    // 只关闭扩展自动创建的标签，不能关闭用户原本打开的 HKUST 页面。
    if (Number.isInteger(tabId)) {
      chrome.alarms.create(`ac-close-tab-${tabId}`, { delayInMinutes: 1 });
    }
  }
}

async function getReadyACTab(preferredTabId = null, timeoutMs = 30000) {
  if (preferredTabId) {
    try {
      const pageReady = await waitForTabReady(
        preferredTabId,
        timeoutMs,
        isACHomePageTab
      );
      if (pageReady) {
        const tab = await chrome.tabs.get(preferredTabId);
        if (isACHomePageTab(tab)) return tab;
      }
    } catch (_) {
      // preferred tab 已关闭，回退到查询现有页面
    }
  }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  let tab = tabs.find(isACHomePageTab);
  if (!tab?.id) return null;
  const pageReady = await waitForTabReady(tab.id, timeoutMs, isACHomePageTab);
  if (!pageReady) return null;
  tab = await chrome.tabs.get(tab.id);
  return isACHomePageTab(tab) ? tab : null;
}

async function waitForTabReady(tabId, timeoutMs = 30000, isReadyTab = isACTab) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'complete' && isReadyTab(tab)) return true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };

    const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete' && isReadyTab(updatedTab)) {
        finish(true);
      }
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((latestTab) => {
      if (latestTab?.status === 'complete' && isReadyTab(latestTab)) finish(true);
    }).catch(() => {});
  });
}

function isACTab(tab) {
  return !!tab?.url && tab.url.startsWith('https://w5.ab.ust.hk/njggt/app/');
}

// 与 isACTab 的宽匹配事实有别：所有 AC 读写只接受完整 URL 精确等于 AC_PAGE。
// slash、query、hash、相似路径、业务子页与登录回调都不能被当作操作目标。
function isACHomePageTab(tab) {
  return tab?.url === AC_PAGE;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getACStatusFromExactHomeTab(tabId) {
  try {
    return await sendReadMessageToExactACHome(tabId, { action: 'status' });
  } catch (error) {
    return { isOn: null, error: error?.message || 'AC 页面未就绪' };
  }
}

async function getCurrentACStatus() {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const tab = tabs.find(isACHomePageTab);
  if (!tab?.id) {
    return { isOn: null, error: '精确 AC home 页面未打开' };
  }
  try {
    return await sendReadMessageToExactACHome(tab.id, { action: 'status' });
  } catch (_) {
    return { isOn: null, error: 'AC 页面未就绪' };
  }
}

async function getCurrentPageTimer() {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const tab = tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded);
  if (!tab?.id) {
    return { found: false, value: null, error: '精确 AC home 页面未打开' };
  }
  try {
    return await sendReadMessageToExactACHome(tab.id, { action: 'getPageTimer' });
  } catch (error) {
    return { found: false, value: null, error: error?.message || 'AC 页面未就绪' };
  }
}

async function ensureScheduleClock(options = {}) {
  if (isSyncPhaseAdoptionAdmissionBlocked()) return;
  await loadScheduleFromStorage();
  if (isSyncPhaseAdoptionAdmissionBlocked()) return;
  if (isComfortStartActive()) return;
  if (!isAutomationAllowed()) return;
  await backfillNextTriggerAt(false);
  const now = Date.now();
  const existingAlarm = await chrome.alarms.get('ac-pwm');
  const rawAlarmAt = Number(existingAlarm?.scheduledTime) || 0;
  const liveAlarmAt = rawAlarmAt > now ? rawAlarmAt : 0;
  const storedAlarmAt = getStoredAlarmEndMs();
  const hasClock = storedAlarmAt > 0;
  return recoverPwmLifecycle({
    source: 'ensureScheduleClock',
    now,
    existingAlarm,
    liveAlarmAt,
    storedAlarmAt,
    expiredAlarmAt: rawAlarmAt > 0 && rawAlarmAt <= now ? rawAlarmAt : 0,
    plannedActionAt: liveAlarmAt || (storedAlarmAt > now ? storedAlarmAt : 0),
    missingClockAction: 'repair-clock',
    failureAction: hasClock ? 'execute-current' : 'repair-clock',
    deferSmartCurrentCycleExecution: options.deferSmartCurrentCycleExecution === true,
    preserveLiveReason: 'ensureScheduleClock: 同步现有 PWM 闹钟',
    restoreReason: 'PWM 主闹钟缺失，已按剩余时间补建'
  });
}

async function repairScheduleClock(options = {}) {
  if (options.discardStaleRevoke === true) {
    return {
      success: false,
      stale: true,
      reason: 'invalid-clock revoke owner is stale',
      schedule
    };
  }
  if (options.revokeInvalidSmartOnClock === true) {
    const revokeOwnerRevision = Number(options.revokeOwnerRevision);
    if (!Number.isSafeInteger(revokeOwnerRevision)
        || revokeOwnerRevision !== pwmRuntimeRevision) {
      return {
        success: false,
        stale: true,
        reason: 'invalid-clock revoke owner changed',
        schedule
      };
    }
    if (repairScheduleClock.inFlight) {
      options = {
        ...options,
        preserveRevokeAcrossSupersededRepair: true
      };
    }
    // 高优先级非法钟撤销先同步换 epoch；已有 generic repair 在任何长 await
    // 返回后都会失权，不能先提交一份“新鲜”19:30 洗白 trailing 判断。
    scheduleRepairEpoch += 1;
  }
  const requestedRepairEpoch = scheduleRepairEpoch;
  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    queueDeferredScheduleRepair(options);
    return {
      success: false,
      deferred: true,
      reason: 'sync phase adoption in progress',
      schedule
    };
  }
  if (pwmExecutionWithRecoveryCount > 0 || isCurrentPwmStepRunning()) {
    queueDeferredScheduleRepair(options);
    return {
      success: false,
      deferred: true,
      reason: 'PWM execution in progress',
      schedule
    };
  }
  // alarm / watchdog / 诊断 / Popup 都可能同时要求修复。同一时刻只运行
  // 一条长页面 timer 事务；其余调用共享结果，避免早启动的失败结果
  // 在晚启动的成功结果之后回写旧 safety marker / 一分钟 alarm。
  const repairContext = {
    automationRevision: pwmRuntimeRevision,
    smartOnExpectedBoundaryAt: Number(options.smartOnExpectedBoundaryAt) || 0,
    revokeInvalidSmartOnClock: options.revokeInvalidSmartOnClock === true,
    revokeOwnerRevision: Number.isSafeInteger(options.revokeOwnerRevision)
      ? options.revokeOwnerRevision
      : null,
    preserveRevokeAcrossSupersededRepair:
      options.preserveRevokeAcrossSupersededRepair === true,
    repairEpoch: requestedRepairEpoch
  };
  if (repairScheduleClock.inFlight) {
    const activeContext = repairScheduleClock.inFlightContext || {};
    if (activeContext.revokeInvalidSmartOnClock === true
        && repairContext.revokeInvalidSmartOnClock !== true) {
      return repairScheduleClock.inFlight;
    }
    const sameContext = activeContext.automationRevision
        === repairContext.automationRevision
      && activeContext.smartOnExpectedBoundaryAt
        === repairContext.smartOnExpectedBoundaryAt
      && activeContext.revokeInvalidSmartOnClock
        === repairContext.revokeInvalidSmartOnClock
      && activeContext.repairEpoch === repairContext.repairEpoch;
    if (sameContext) return repairScheduleClock.inFlight;

    // 旧 repair 的长页面 I/O 期间若 revision／智能边界换主，新 alarm
    // 已被浏览器消费，不能只复用注定 stale 的旧 promise。合并成一次
    // trailing repair，并保留最后到达的完整 options。
    const trailingWithActiveOwner = mergeScheduleRepairOptions(
      {
        smartOnExpectedBoundaryAt: Number(
          activeContext.smartOnExpectedBoundaryAt
        ) || 0,
        revokeInvalidSmartOnClock:
          activeContext.revokeInvalidSmartOnClock === true,
        revokeOwnerRevision: activeContext.revokeOwnerRevision,
        preserveRevokeAcrossSupersededRepair:
          activeContext.preserveRevokeAcrossSupersededRepair === true
      },
      repairScheduleClock.trailingOptions || {}
    );
    repairScheduleClock.trailingOptions = mergeScheduleRepairOptions(
      trailingWithActiveOwner,
      options
    );
    if (!repairScheduleClock.trailingPromise) {
      const activeRepair = repairScheduleClock.inFlight;
      repairScheduleClock.trailingPromise = activeRepair
        .catch(() => {})
        .then(() => {
          const trailingOptions = normalizeDeferredScheduleRepairOptions(
            repairScheduleClock.trailingOptions || {}
          );
          repairScheduleClock.trailingOptions = null;
          repairScheduleClock.trailingPromise = null;
          return repairScheduleClock(trailingOptions);
        });
    }
    return repairScheduleClock.trailingPromise;
  }
  const repairOperation = (async () => {
  if (isComfortStartActive()) {
    return { success: false, reason: '五分钟舒适启动进行中', schedule };
  }
  const automationRevision = pwmRuntimeRevision;
  const repairEpoch = repairContext.repairEpoch;
  const abortStaleRepair = async (reason) => {
    if (repairEpoch !== scheduleRepairEpoch) {
      console.warn(`[AC扩展] ${reason}: repair epoch 已被更高优先级撤销请求抢占`);
      return true;
    }
    return abortStaleAutomation(automationRevision, reason);
  };
  // 提取（Fowler Extract Function）：当前为 ON 时的关机过渡——先保留 ON 安全检查点，新鲜页确认定时器后才恢复 OFF。
  async function tryArmOffTransition(status) {
    // 先保留“下一步 ON”的安全检查点；只有新鲜页面确认关机定时器后，
    // 才允许恢复为下一步 OFF。
    schedule.pwmState = 'on';
    const nowMs = Date.now();
    const nextMinuteTargetAt = nextSafePageTimerTargetAt(nowMs);
    let smartTargetAt = 0;
    if (schedule.smartMode?.enabled) {
      const smartRepairPlan = planSmartModeOnWindow(schedule, {
        now: nowMs,
        maxOnMinutes: SMART_MODE.ON_MAX,
        acIsOn: true,
        boundaryAt: schedule.smartOnBoundaryAt
      });
      const plannedSmartTargetAt = Number(smartRepairPlan?.pageTimerTargetAt);
      smartTargetAt = smartRepairPlan?.kind === 'allow'
          && Number.isSafeInteger(plannedSmartTargetAt)
          && plannedSmartTargetAt > nowMs
        ? plannedSmartTargetAt
        : nextMinuteTargetAt;
      schedule.smartOnBoundaryAt = Number(smartRepairPlan?.boundaryAt) || 0;
    }
    const timerMinutes = smartTargetAt > 0
      ? Math.max(1, Math.ceil((smartTargetAt - nowMs) / 60000))
      : schedule.onMinutes;
    const timerResult = await setPageTimer(timerMinutes, {
      retryOnFailure: false,
      automationRevision,
      ...(smartTargetAt > 0 ? { targetAt: smartTargetAt } : {})
    });
    if (await abortStaleRepair('repair-page-timer-active-hours-paused')) {
      return { success: false, reason: '运行时段外暂停', schedule };
    }
    if (!timerResult?.success) {
      schedule.pageTimerError = `时钟修复时页面关机定时器未确认：${timerResult?.error || '未知错误'}；保持 on 相位，1 分钟后重试`;
      const retryPlannedAt = Date.now();
      const retryAt = retryPlannedAt + 60000;
      setNextTriggerAt(retryAt);
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;
      const retryBoundaryAt = Number(schedule.smartOnBoundaryAt) || 0;
      const repairRetryKind = 'smart-on-safety-timer';
      setSmartOnPwmRetryState('on', retryAt, {
        kind: repairRetryKind,
        boundaryAt: retryBoundaryAt
      });
      await persistSchedule('repairScheduleClock-pageTimer-retry-intent', {
        syncFromLiveAlarm: false
      });
      if (await abortStaleRepair('repair-page-timer-retry-intent-stale')) {
        return { success: false, reason: '修复事务已失效', schedule };
      }
      await syncScheduleToSync('repairScheduleClock-pageTimer-retry-hold');
      if (await abortStaleRepair('repair-page-timer-retry-sync-stale')) {
        return { success: false, reason: '修复事务已失效', schedule };
      }
      const alarmCreated = await createPwmAlarmWithVerify(
        1,
        'repair-pageTimer-failed',
        automationRevision
      );
      if (alarmCreated === false) {
        if (await abortStaleRepair(
          'repair-page-timer-alarm-failed-active-hours-paused'
        )) {
          return { success: false, reason: '修复事务已失效', schedule };
        }
        schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复';
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        await persistSchedule('repairScheduleClock-pageTimer-retry-alarm-failed', {
          syncFromLiveAlarm: false
        });
        await syncScheduleToSync('repairScheduleClock-pageTimer-retry-alarm-failed');
        return { success: false, reason: schedule.pageTimerError, schedule };
      }
      setSmartOnPwmRetryState('on', schedule.nextTriggerAt, {
        kind: repairRetryKind,
        boundaryAt: retryBoundaryAt
      });
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      if (await abortStaleRepair('repair-retry-active-hours-paused')) {
        return { success: false, reason: '运行时段外暂停', schedule };
      }
      await persistSchedule('repairScheduleClock-pageTimer-failed');
      await updateBadge();
      await syncScheduleToSync('repairScheduleClock-pageTimer-failed');
      return { success: false, reason: schedule.pageTimerError, schedule: { ...schedule, actualStatus: status } };
    }
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;
    schedule.pageTimerRetryMinutes = 0;
    return null;
  }

  if (!schedule.enabled
      || (typeof isAutomationAllowed === 'function' && !isAutomationAllowed())) {
    return {
      success: false,
      reason: schedule.enabled ? '运行时段外暂停' : '定时未启用',
      schedule
    };
  }

  if (options.revokeInvalidSmartOnClock === true
      && options.preserveRevokeAcrossSupersededRepair === true) {
    let replacementCommitted = false;
    try {
      replacementCommitted = await hasDurableLivePwmOwner(
        automationRevision,
        {
          expectedSmartOnBoundaryAt:
            Number(options.smartOnExpectedBoundaryAt) || 0
        }
      );
    } catch (proofError) {
      console.warn('[AC扩展] invalid-clock revoke 前 replacement owner 证明读取失败:', proofError?.message);
    }
    // proof await 期间的换主/更高优先级 repair 先于本次结论。
    // 该复检到下方撤钟之间无 await，不给 stale proof 破坏新 owner。
    if (repairEpoch !== scheduleRepairEpoch
        || !isAutomationOperationCurrent(automationRevision)) {
      return { success: false, stale: true, reason: 'replacement owner changed during proof', schedule };
    }
    if (replacementCommitted) {
      console.warn('[AC扩展] replacement owner 已完成 durable/live 收口，丢弃 stale invalid-clock revoke');
      return {
        success: true,
        preservedReplacementOwner: true,
        reason: 'replacement owner committed',
        schedule
      };
    }
  }

  if (options.revokeInvalidSmartOnClock === true) {
    const expectedBoundaryAt = Number(options.smartOnExpectedBoundaryAt) || 0;
    // 撤销非法 future clock 必须与随后的权威状态观察/重排属于同一 repair
    // single-flight。否则已有 generic repair 可在“清钟”和“带 boundary 重排”
    // 之间提交另一份 fresh 但仍跳周期的 19:30，并被尾随 restore 当成健康钟。
    schedule.smartOnBoundaryAt = expectedBoundaryAt;
    clearPwmRetryState();
    setNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await persistSchedule('smart-on-clock-repair-ownership', {
      syncFromLiveAlarm: false
    });
    await clearPwmAlarm(automationRevision);
    if (await abortStaleRepair(
      'repair-invalid-clock-revoke-active-hours-paused'
    )) {
      return { success: false, reason: '修复事务已失效', schedule };
    }
  }

  // 间隔模式
  const restored = await restoreIntervalAlarmFromStorage('repair: 按已记录绝对触发时间恢复 PWM 闹钟');
  if (await abortStaleRepair('repair-restore-active-hours-paused')) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  if (restored) {
    await updateBadge();
    const status = await getCurrentACStatus();
    return { success: true, repairedFromStoredBoundary: true, schedule: { ...schedule, actualStatus: status } };
  }

  const status = await getCurrentACStatus();
  if (await abortStaleRepair('repair-status-active-hours-paused')) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  if (typeof status?.isOn !== 'boolean') {
    schedule.pageTimerError = `时钟修复无法确认冷气状态：${status?.error || '状态未知'}；未改相位且未点击开关`;
    await persistSchedule('repairScheduleClock-status-unknown', {
      syncFromLiveAlarm: false
    });
    return { success: false, reason: schedule.pageTimerError, schedule };
  }
  const currentOn = status.isOn;
  if (!currentOn) {
    // 新鲜页面已经证明物理 OFF；此前 ON/page-timer 失败属于上一事务，不能
    // 在新的安全 ON 计划提交后继续把诊断染红。
    clearPageTimerProofState();
  }
  if (currentOn && schedule.smartMode?.enabled) {
    await applyPreparedSmartModeDurations({
      allowActiveOnPhase: true,
      boundaryAt: schedule.smartOnBoundaryAt
    });
    if (await abortStaleRepair('repair-smart-duration-active-hours-paused')) {
      return { success: false, reason: '运行时段外暂停', schedule };
    }
  }
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);

  if (currentOn) {
    const failedResult = await tryArmOffTransition(status);
    if (failedResult) return failedResult;
  }

  schedule.pwmState = currentOn ? 'off' : 'on';
  let repairLocalExceptionBoundaryAt = 0;
  let repairLocalExceptionKind = '';
  const repairNow = Date.now();
  const confirmedOffPlan = !currentOn && schedule.smartMode?.enabled
    ? planSmartOnAfterConfirmedOff(schedule, {
        now: repairNow,
        // 缺钟／错误未来钟没有可信的更早 OFF 证明；从本次权威 OFF 观察起算
        // 五分钟，宁可稍晚补开，也不能因语义修复缩短压缩机保护。
        confirmedOffAt: repairNow,
        minOffMinutes: SMART_MODE.MIN_OFF_MINUTES,
        ...(Number(options.smartOnExpectedBoundaryAt) > 0
          ? { boundaryAt: Number(options.smartOnExpectedBoundaryAt) }
          : {})
      })
    : null;
  const minOffNotBeforeAt = repairNow
    + SMART_MODE.MIN_OFF_MINUTES * 60000;
  const firstFutureBoundaryAt = nextHalfHourBoundary(repairNow);
  const invalidDurationFallbackAt = firstFutureBoundaryAt >= minOffNotBeforeAt
    ? firstFutureBoundaryAt
    : nextHalfHourBoundary(firstFutureBoundaryAt);
  const safeConfirmedOffPlan = !currentOn
      && schedule.smartMode?.enabled
      && confirmedOffPlan?.kind === 'refuse'
    ? {
        kind: 'smart-on-safety-skip',
        nextTriggerAt: invalidDurationFallbackAt,
        boundaryAt: firstFutureBoundaryAt === invalidDurationFallbackAt
          ? halfHourBoundaryAtOrBefore(repairNow)
          : firstFutureBoundaryAt
      }
    : confirmedOffPlan;
  clearPwmRetryState();
  const repairPlan = currentOn
    ? { nextTriggerAt: schedule.pageTimerTargetAt }
    : {
        // 智能模式的控制边界固定在 :00/:30。缺钟恢复若沿用旧天气的
        // offMinutes（例如 22:20 读到 22:00 的 on=0/off=30），会错误排到
        // 22:50 并跳过 22:30 的新天气。普通循环仍按相对 offMinutes 修复。
        nextTriggerAt: schedule.smartMode?.enabled
          && Number(safeConfirmedOffPlan?.nextTriggerAt) > repairNow
          ? safeConfirmedOffPlan.nextTriggerAt
          : schedule.smartMode?.enabled
            ? invalidDurationFallbackAt
            : repairNow + delay * 60000
      };
  if (safeConfirmedOffPlan?.kind === 'smart-on-safe-delay'
      || safeConfirmedOffPlan?.kind === 'smart-on-safety-skip') {
    repairLocalExceptionBoundaryAt = safeConfirmedOffPlan.boundaryAt;
    repairLocalExceptionKind = safeConfirmedOffPlan.kind;
    schedule.smartOnBoundaryAt = repairLocalExceptionBoundaryAt;
    setSmartOnPwmRetryState('on', repairPlan.nextTriggerAt, {
      kind: repairLocalExceptionKind,
      boundaryAt: repairLocalExceptionBoundaryAt
    });
  }
  setNextTriggerAt(repairPlan.nextTriggerAt);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  await persistSchedule('repairScheduleClock-commit-intent', {
    syncFromLiveAlarm: false
  });
  if (await abortStaleRepair('repair-commit-intent-stale')) {
    return { success: false, reason: '修复事务已失效', schedule };
  }
  if (repairLocalExceptionBoundaryAt > 0) {
    await syncScheduleToSync('repairScheduleClock-smart-on-hold');
    if (await abortStaleRepair('repair-smart-on-hold-sync-stale')) {
      return { success: false, reason: '修复事务已失效', schedule };
    }
  }
  const alarmCreated = await createPwmAlarmFromPlan(
    repairPlan,
    'repair',
    automationRevision
  );
  if (await abortStaleRepair('repair-alarm-commit-stale')) {
    return { success: false, reason: '修复事务已失效', schedule };
  }
  if (alarmCreated === false) {
    if (await abortStaleRepair(
      'repair-commit-alarm-failed-active-hours-paused'
    )) {
      return { success: false, reason: '修复事务已失效', schedule };
    }
    schedule.pageTimerError = '时钟修复已确定下一阶段，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复';
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    await persistSchedule('repairScheduleClock-commit-alarm-failed', {
      syncFromLiveAlarm: false
    });
    if (repairLocalExceptionBoundaryAt > 0) {
      await syncScheduleToSync('repairScheduleClock-smart-on-hold-alarm-failed');
    }
    return { success: false, reason: schedule.pageTimerError, schedule };
  }
  if (repairLocalExceptionBoundaryAt > 0) {
    setSmartOnPwmRetryState('on', schedule.nextTriggerAt, {
      kind: repairLocalExceptionKind,
      boundaryAt: repairLocalExceptionBoundaryAt
    });
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (await abortStaleRepair('repair-commit-active-hours-paused')) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  await persistSchedule('repairScheduleClock-interval');
  await updateBadge();
  await syncScheduleToSync('repairScheduleClock');

  return { success: true, schedule: { ...schedule, actualStatus: status } };
  })();
  const trackedRepair = repairOperation.finally(() => {
    if (repairScheduleClock.inFlight === trackedRepair) {
      repairScheduleClock.inFlight = null;
      repairScheduleClock.inFlightContext = null;
    }
  });
  repairScheduleClock.inFlight = trackedRepair;
  repairScheduleClock.inFlightContext = repairContext;
  return trackedRepair;
}

// 弹窗 est（Est. until）依赖 full 轮询带回的页面余额。页面重渲染、home
// 暂不可读等瞬态只允许沿用最近有效值；明确离开 Charge Mode 才清除缓存。
// storage.local 让缓存跨完整浏览器重启保留，storage.session 作为同会话热缓存
// 和旧版本迁移源；popup 另有同语义内存缓存，覆盖 lite 轮询和单次消息异常。
const BALANCE_CACHE_KEY = 'ac_balance_cache';
let lastKnownBalanceMinutes = null;
let persistedLocalBalanceMinutes = null;
let persistedSessionBalanceMinutes = null;
let balanceCacheLoaded = false;
let localBalanceCacheStored = false;
let sessionBalanceCacheStored = false;
let balanceCacheLoadPromise = null;

async function loadBalanceCache() {
  if (balanceCacheLoaded) return lastKnownBalanceMinutes;
  if (balanceCacheLoadPromise) return balanceCacheLoadPromise;

  balanceCacheLoadPromise = (async () => {
    const localStorage = chrome.storage?.local;
    const sessionStorage = chrome.storage?.session;
    let localStored = {};
    let sessionStored = {};

    if (localStorage) {
      try {
        localStored = await localStorage.get(BALANCE_CACHE_KEY);
      } catch (error) {
        console.warn('[AC扩展] 读取余额 local 缓存失败:', error?.message);
      }
    }
    if (sessionStorage) {
      try {
        sessionStored = await sessionStorage.get(BALANCE_CACHE_KEY);
      } catch (error) {
        console.warn('[AC扩展] 读取余额 session 缓存失败:', error?.message);
      }
    }

    localBalanceCacheStored = Object.prototype.hasOwnProperty.call(
      localStored || {}, BALANCE_CACHE_KEY
    );
    sessionBalanceCacheStored = Object.prototype.hasOwnProperty.call(
      sessionStored || {}, BALANCE_CACHE_KEY
    );
    const localBalance = localStored?.[BALANCE_CACHE_KEY];
    const sessionBalance = sessionStored?.[BALANCE_CACHE_KEY];
    persistedLocalBalanceMinutes = Number.isFinite(localBalance) ? localBalance : null;
    persistedSessionBalanceMinutes = Number.isFinite(sessionBalance) ? sessionBalance : null;
    lastKnownBalanceMinutes = Number.isFinite(persistedLocalBalanceMinutes)
      ? persistedLocalBalanceMinutes
      : persistedSessionBalanceMinutes;
    balanceCacheLoaded = true;

    if (Number.isFinite(lastKnownBalanceMinutes)) {
      if (localStorage && persistedLocalBalanceMinutes !== lastKnownBalanceMinutes) {
        try {
          await localStorage.set({ [BALANCE_CACHE_KEY]: lastKnownBalanceMinutes });
          persistedLocalBalanceMinutes = lastKnownBalanceMinutes;
          localBalanceCacheStored = true;
        } catch (error) {
          console.warn('[AC扩展] 迁移余额到 local 缓存失败:', error?.message);
        }
      }
      if (sessionStorage && persistedSessionBalanceMinutes !== lastKnownBalanceMinutes) {
        try {
          await sessionStorage.set({ [BALANCE_CACHE_KEY]: lastKnownBalanceMinutes });
          persistedSessionBalanceMinutes = lastKnownBalanceMinutes;
          sessionBalanceCacheStored = true;
        } catch (error) {
          console.warn('[AC扩展] 回填余额 session 缓存失败:', error?.message);
        }
      }
    }
    return lastKnownBalanceMinutes;
  })();

  try {
    return await balanceCacheLoadPromise;
  } finally {
    balanceCacheLoadPromise = null;
  }
}

async function rememberBalanceMinutes(balanceMinutes) {
  lastKnownBalanceMinutes = balanceMinutes;
  balanceCacheLoaded = true;

  const localStorage = chrome.storage?.local;
  const sessionStorage = chrome.storage?.session;
  if (localStorage && (!localBalanceCacheStored || persistedLocalBalanceMinutes !== balanceMinutes)) {
    try {
      await localStorage.set({ [BALANCE_CACHE_KEY]: balanceMinutes });
      persistedLocalBalanceMinutes = balanceMinutes;
      localBalanceCacheStored = true;
    } catch (error) {
      console.warn('[AC扩展] 写入余额 local 缓存失败:', error?.message);
    }
  }
  if (sessionStorage && (!sessionBalanceCacheStored || persistedSessionBalanceMinutes !== balanceMinutes)) {
    try {
      await sessionStorage.set({ [BALANCE_CACHE_KEY]: balanceMinutes });
      persistedSessionBalanceMinutes = balanceMinutes;
      sessionBalanceCacheStored = true;
    } catch (error) {
      console.warn('[AC扩展] 写入余额 session 缓存失败:', error?.message);
    }
  }
}

async function clearBalanceCache() {
  lastKnownBalanceMinutes = null;
  balanceCacheLoaded = true;

  const localStorage = chrome.storage?.local;
  const sessionStorage = chrome.storage?.session;
  if (localStorage) {
    try {
      await localStorage.remove(BALANCE_CACHE_KEY);
      persistedLocalBalanceMinutes = null;
      localBalanceCacheStored = false;
    } catch (error) {
      console.warn('[AC扩展] 清除余额 local 缓存失败:', error?.message);
    }
  }
  if (sessionStorage) {
    try {
      await sessionStorage.remove(BALANCE_CACHE_KEY);
      persistedSessionBalanceMinutes = null;
      sessionBalanceCacheStored = false;
    } catch (error) {
      console.warn('[AC扩展] 清除余额 session 缓存失败:', error?.message);
    }
  }
}

async function mergeBalanceReading(status) {
  if (!status || typeof status !== 'object') return status;

  await loadBalanceCache();
  const merged = { ...status };
  if (typeof merged.balanceMinutes === 'number' && Number.isFinite(merged.balanceMinutes)) {
    await rememberBalanceMinutes(merged.balanceMinutes);
  } else if (merged.balanceState === 'not-charge-mode') {
    await clearBalanceCache();
    delete merged.balanceMinutes;
  } else if (Number.isFinite(lastKnownBalanceMinutes)) {
    merged.balanceMinutes = lastKnownBalanceMinutes;
  }
  return merged;
}

async function getScheduleSnapshot(lite = false) {
  await loadScheduleFromStorage();

  // 提取（Fowler Extract Function）：快照富化——legacy 回填 → live 对齐 → 边界与剩余分钟补丁（保持只读，不落盘）。
  function enrichScheduleSnapshot(snapshot, alarm, liveAlarmEnd) {
    // getSchedule/getScheduleLite 是 popup 的普通轮询入口，必须保持只读。
    // live alarm 或旧相对字段只能补充本次返回快照；持久化自愈留给 init、
    // watchdog 和用户主动触发的诊断，避免打开 popup 改变下一次 PWM 调度。
    if (snapshot._automationPausedByActiveHours) {
      snapshot.nextTriggerAt = 0;
      snapshot.alarmCreatedAt = 0;
      snapshot.alarmDelayMinutes = 0;
      return;
    }

    if (!snapshot.nextTriggerAt) {
      const legacyEnd = getLegacyAlarmEndMs();
      if (legacyEnd) snapshot.nextTriggerAt = legacyEnd;
    }

    if (!snapshot._phaseAdoptionInFlight) {
      const triggerPlan = reconcilePwmTrigger(
        snapshot,
        alarm,
        PWM_TRIGGER_SNAPSHOT_OPTIONS
      );
      if (triggerPlan.kind === 'sync-live') {
        Object.assign(snapshot, triggerPlan.phasePatch);
      }
    }

    const storedAlarmEnd = snapshot.nextTriggerAt || (
      snapshot.alarmCreatedAt && snapshot.alarmDelayMinutes
        ? snapshot.alarmCreatedAt + snapshot.alarmDelayMinutes * 60000
        : 0
    );
    const nextBoundary = (!snapshot._phaseAdoptionInFlight && liveAlarmEnd)
      || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);

    if (snapshot.enabled && !snapshot._automationPausedByActiveHours && nextBoundary) {
      const remainingMs = nextBoundary - Date.now();
      if (remainingMs > 0) {
        snapshot._nextBoundary = nextBoundary;
        snapshot.alarmCreatedAt = Date.now();
        snapshot.alarmDelayMinutes = remainingMs / 60000;
      }
    }
  }

  const alarm = await chrome.alarms.get('ac-pwm');
  const liveAlarmEnd = getLiveAlarmEndMs(alarm);
  const phaseAdoptionInFlight = isSyncPhaseAdoptionAdmissionBlocked();
  const snapshot = {
    ...schedule,
    // enrich 会为 UI 剩余分钟改写 alarmCreatedAt；另存 durable 生成时刻供
    // Popup 做“是否跳过最近智能半点”的语义校验。
    _clockPlannedAt: Number(schedule.smartClockPlannedAt)
      || Number(schedule.alarmCreatedAt)
      || 0,
    _pwmStepRunning: isCurrentPwmStepRunning(),
    _phaseAdoptionInFlight: phaseAdoptionInFlight
  };
  const insideActiveHours = typeof isWithinActiveHours === 'function'
    ? isWithinActiveHours()
    : true;
  snapshot._insideActiveHours = insideActiveHours;
  snapshot._comfortStartActive = isComfortStartActive();
  snapshot._automationPausedByActiveHours = schedule.enabled
    && !insideActiveHours
    && !snapshot._comfortStartActive;

  enrichScheduleSnapshot(snapshot, alarm, liveAlarmEnd);

  if (lite) {
    // Lite 模式：跳过 getCurrentACStatus（tabs.query + sendMessage），仅返回调度快照
    return { ...snapshot, actualStatus: null };
  }

  const status = await mergeBalanceReading(await getCurrentACStatus());
  // 弹窗轮询只读展示，不在这里改写 storage 或重建闹钟，避免重新打开弹窗时漂移触发时间。
  if (typeof status?.isOn === 'boolean'
      && snapshot.enabled && !snapshot._automationPausedByActiveHours) {
    snapshot._effectivePwmState = status.isOn ? 'off' : 'on';
  }
  return { ...snapshot, actualStatus: status };
}

async function toggleNowAndSync(action) {
  // 提取（Fowler Extract Function）：手动开机后的 ON 相位布防——清旧 alarm、新鲜页确认关机定时器，失败保持 on 相位 1 分钟重试。
  async function armOnPhaseTimerAndAlarms(preparedTimerResult = null) {
    // 手动开机同样是一个新的 PWM ON 阶段。先清旧 alarm 以免验证期间旧的
    // OFF 边界抢跑；新鲜页确认失败则保持 pwmState='on'，下一次不会再点击。
    prepareFreshPwmStartState();
    await clearPwmAlarm(automationRevision);

    const timerResult = preparedTimerResult?.success === true
      ? preparedTimerResult
      : await setPageTimer(schedule.onMinutes, {
        retryOnFailure: false,
        automationRevision
      });
    if (await abortStaleAutomation(
      automationRevision,
      'toggle-page-timer-active-hours-paused'
    )) {
      const status = await getCurrentACStatus();
      return { success: true, schedule: { ...schedule, actualStatus: status } };
    }
    if (!timerResult?.success) {
      schedule.pageTimerError = `手动开机后页面关机定时器未确认：${timerResult?.error || '未知错误'}；保持 on 相位，1 分钟后重试`;
      const retryAt = Date.now() + 60000;
      setNextTriggerAt(retryAt);
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;
      const retryBoundaryAt = Number(schedule.smartOnBoundaryAt) || 0;
      const safetyTimerRetry = schedule.smartMode?.enabled === true;
      if (safetyTimerRetry) {
        setSmartOnPwmRetryState('on', retryAt, {
          kind: 'smart-on-safety-timer',
          boundaryAt: retryBoundaryAt
        });
      }
      await persistSchedule('toggleNowAndSync-pageTimer-retry-intent', {
        syncFromLiveAlarm: false
      });
      if (safetyTimerRetry) {
        await syncScheduleToSync('toggleNowAndSync-pageTimer-retry-hold');
      }
      const alarmCreated = await createPwmAlarmWithVerify(
        1,
        'toggle-pageTimer-failed',
        automationRevision
      );
      if (alarmCreated === false) {
        schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复';
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        await persistSchedule('toggleNowAndSync-pageTimer-retry-alarm-failed', {
          syncFromLiveAlarm: false
        });
        if (safetyTimerRetry) {
          await syncScheduleToSync('toggleNowAndSync-pageTimer-retry-alarm-failed');
        }
        await updateBadge();
        const status = await getCurrentACStatus();
        return {
          success: false,
          error: schedule.pageTimerError,
          result: timerResult,
          schedule: { ...schedule, actualStatus: status }
        };
      }
      if (safetyTimerRetry) {
        setSmartOnPwmRetryState('on', schedule.nextTriggerAt, {
          kind: 'smart-on-safety-timer',
          boundaryAt: retryBoundaryAt
        });
      }
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      if (await abortStaleAutomation(
        automationRevision,
        'toggle-retry-active-hours-paused'
      )) {
        const status = await getCurrentACStatus();
        return { success: true, schedule: { ...schedule, actualStatus: status } };
      }
      await persistSchedule('toggleNowAndSync-pageTimer-failed');
      if (safetyTimerRetry) {
        await syncScheduleToSync('toggleNowAndSync-pageTimer-failed');
      }
      await updateBadge();
      const status = await getCurrentACStatus();
      return {
        success: false,
        error: schedule.pageTimerError,
        result: timerResult,
        schedule: { ...schedule, actualStatus: status }
      };
    }
    return null;
  }

  if (action === 'off') {
    const timerResult = await requestTimerBasedShutdown('toggle-now-off');
    const status = await getCurrentACStatus();
    return {
      success: !!timerResult?.success,
      error: timerResult?.error,
      schedule: { ...schedule, actualStatus: status },
      result: timerResult
    };
  }

  const automationWasAllowed = isAutomationAllowed();
  const automationRevision = pwmRuntimeRevision;
  if (automationWasAllowed) {
    clearPageTimerProofState();
    clearPwmRetryState();
    await chrome.alarms.clear('ac-page-timer-retry');
    await persistSchedule('toggleNowAndSync-on-intent', { syncFromLiveAlarm: false });
  }
  const toggleResult = await toggleAC('on', {
    pageTimerMinutes: schedule.onMinutes,
    pageTimerTargetAt: 0
  });

  if (!toggleResult?.success) {
    return {
      success: false,
      error: toggleResult?.error || `${action} 命令未确认`,
      result: toggleResult,
      schedule
    };
  }

  if (!automationWasAllowed || !isAutomationAllowed()) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }

  // 间隔模式
  const currentOn = action === 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);

  if (currentOn) {
    const failedResult = await armOnPhaseTimerAndAlarms(toggleResult.pageTimerResult);
    if (failedResult) return failedResult;
  }

  schedule.pwmState = currentOn ? 'off' : 'on';
  const togglePlan = currentOn
    ? { nextTriggerAt: schedule.pageTimerTargetAt }
    : { nextTriggerAt: Date.now() + delay * 60000 };
  setNextTriggerAt(togglePlan.nextTriggerAt);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  await persistSchedule('toggleNowAndSync-commit-intent', {
    syncFromLiveAlarm: false
  });
  const alarmCreated = await createPwmAlarmFromPlan(
    togglePlan,
    'toggle',
    automationRevision
  );
  if (alarmCreated === false) {
    schedule.pageTimerError = `手动${currentOn ? '开机' : '关机'}已确认，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复`;
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    await persistSchedule('toggleNowAndSync-commit-alarm-failed', {
      syncFromLiveAlarm: false
    });
    await updateBadge();
    const status = await getCurrentACStatus();
    return {
      success: false,
      error: schedule.pageTimerError,
      schedule: { ...schedule, actualStatus: status },
      result: toggleResult
    };
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (await abortStaleAutomation(
    automationRevision,
    'toggle-commit-active-hours-paused'
  )) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }
  await persistSchedule('toggleNowAndSync-interval');
  await updateBadge();

  const status = await getCurrentACStatus();
  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

async function ensureDiagnosticAlarms() {
  const diagnosticRequestAt = Date.now();
  const repairs = [];
  const cloneDiagnosticValue = value => {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  };
  const snapshotAlarm = alarm => alarm ? {
    scheduledTime: Number(alarm.scheduledTime) || 0,
    ...(Number.isFinite(Number(alarm.periodInMinutes))
      ? { periodInMinutes: Number(alarm.periodInMinutes) }
      : {})
  } : null;
  const readDiagnosticExternal = async (label, read, readErrors) => {
    try {
      return await read();
    } catch (error) {
      readErrors.push(`${label}: ${String(error?.message || error).slice(0, 120)}`);
      return null;
    }
  };
  const snapshotNamedAlarms = async (
    readErrors = [],
    includePageTimerRetry = false
  ) => {
    const names = [
      ['badge', 'ac-badge-tick'],
      ['watchdog', 'ac-watchdog'],
      ['pwm', 'ac-pwm'],
      ['smartWeather', 'ac-smart-weather'],
      ...(includePageTimerRetry
        ? [['pageTimerRetry', 'ac-page-timer-retry']]
        : [])
    ];
    const values = await Promise.all(names.map(([, alarmName]) => (
      readDiagnosticExternal(
        `alarm:${alarmName}`,
        () => chrome.alarms.get(alarmName),
        readErrors
      )
    )));
    return Object.fromEntries(names.map(([key], index) => (
      [key, snapshotAlarm(values[index])]
    )));
  };
  function readDiagnosticRuntimeState() {
    return {
      memorySchedule: cloneDiagnosticValue(schedule) || {},
      revision: typeof pwmRuntimeRevision === 'number' ? pwmRuntimeRevision : 0,
      pwmStepRunning: typeof isCurrentPwmStepRunning === 'function'
        ? isCurrentPwmStepRunning()
        : false,
      runningRevision: typeof pwmStepRunningRevision === 'number'
        ? pwmStepRunningRevision
        : null,
      phaseAdoptionInFlight: typeof isSyncPhaseAdoptionAdmissionBlocked === 'function'
        ? isSyncPhaseAdoptionAdmissionBlocked()
        : false,
      phaseAdoptionOwner: typeof syncPhaseAdoptionAdmissionOwner === 'number'
        ? syncPhaseAdoptionAdmissionOwner
        : 0,
      pwmExecutionCount: typeof pwmExecutionWithRecoveryCount === 'number'
        ? pwmExecutionWithRecoveryCount
        : 0,
      repairInFlight: typeof repairScheduleClock === 'function'
        && !!repairScheduleClock.inFlight,
      currentAttempt: typeof currentPwmAttempt === 'object'
        ? cloneDiagnosticValue(currentPwmAttempt)
        : null,
      currentAttempts: typeof getActivePwmDiagnosticAttempts === 'function'
        ? cloneDiagnosticValue(getActivePwmDiagnosticAttempts())
        : [],
      lastOutcome: typeof lastPwmOutcome === 'object'
        ? cloneDiagnosticValue(lastPwmOutcome)
        : null
    };
  }
  function diagnosticSnapshotFingerprint(state) {
    return JSON.stringify({
      memorySchedule: state?.memorySchedule || {},
      revision: state?.revision || 0,
      pwmStepRunning: state?.pwmStepRunning === true,
      runningRevision: state?.runningRevision ?? null,
      phaseAdoptionInFlight: state?.phaseAdoptionInFlight === true,
      phaseAdoptionOwner: state?.phaseAdoptionOwner || 0,
      pwmExecutionCount: state?.pwmExecutionCount || 0,
      repairInFlight: state?.repairInFlight === true,
      currentAttempt: state?.currentAttempt || null,
      currentAttempts: state?.currentAttempts || [],
      lastOutcome: state?.lastOutcome || null
    });
  }
  const captureDiagnosticSnapshotAttempt = async (
    captureAttempts,
    firstObservedAt
  ) => {
    const capturedAt = Date.now();
    const startState = readDiagnosticRuntimeState();
    const readErrors = [];
    const storageAvailable = typeof chrome.storage?.local?.get === 'function';
    const [stored, persistedEnvelope, alarms] = await Promise.all([
      storageAvailable
        ? readDiagnosticExternal(
            'storage:ac_schedule',
            () => chrome.storage.local.get('ac_schedule'),
            readErrors
          )
        : Promise.resolve({}),
      storageAvailable
        ? readDiagnosticExternal(
            `storage:${typeof PWM_LAST_OUTCOME_KEY === 'string'
              ? PWM_LAST_OUTCOME_KEY
              : 'ac_pwm_last_outcome'}`,
            () => chrome.storage.local.get(
              typeof PWM_LAST_OUTCOME_KEY === 'string'
                ? PWM_LAST_OUTCOME_KEY
                : 'ac_pwm_last_outcome'
            ),
            readErrors
          )
        : Promise.resolve({}),
      snapshotNamedAlarms(readErrors, true)
    ]);
    const endState = readDiagnosticRuntimeState();
    const coherent = diagnosticSnapshotFingerprint(startState)
      === diagnosticSnapshotFingerprint(endState);
    const persistedKey = typeof PWM_LAST_OUTCOME_KEY === 'string'
      ? PWM_LAST_OUTCOME_KEY
      : 'ac_pwm_last_outcome';
    const persistedRaw = persistedEnvelope?.[persistedKey] || null;
    let persistedOutcome = typeof normalizePwmDiagnosticOutcome === 'function'
      ? normalizePwmDiagnosticOutcome(persistedRaw)
      : cloneDiagnosticValue(persistedRaw);
    if (persistedOutcome
        && typeof BUILD_TIME === 'string'
        && typeof BUILD_TIME_EPOCH_MS === 'number'
        && (persistedOutcome.buildTime !== BUILD_TIME
          || persistedOutcome.buildTimeEpochMs !== BUILD_TIME_EPOCH_MS)) {
      persistedOutcome = null;
    }
    const latestOutcome = typeof selectLatestPwmDiagnosticOutcome === 'function'
      ? selectLatestPwmDiagnosticOutcome(startState.lastOutcome, persistedOutcome)
      : (startState.lastOutcome || persistedOutcome || null);
    const liveAlarmAt = Number(alarms?.pwm?.scheduledTime) || 0;
    return {
      firstObservedAt,
      capturedAt,
      captureAttempts,
      coherent,
      complete: readErrors.length === 0,
      readErrors,
      coherenceReason: coherent ? '' : 'runtime-changed-during-capture',
      memorySchedule: startState.memorySchedule,
      storedSchedule: cloneDiagnosticValue(stored?.ac_schedule) || {},
      alarms,
      owner: {
        action: startState.memorySchedule.pwmState === 'on' ? 'on' : 'off',
        pwmState: startState.memorySchedule.pwmState || '',
        kind: startState.memorySchedule.pwmRetryKind || 'phase',
        boundaryAt: Number(startState.memorySchedule.pwmRetryBoundaryAt)
          || Number(startState.memorySchedule.smartOnBoundaryAt)
          || 0,
        scheduledAt: Number(startState.memorySchedule.pwmRetryScheduledAt)
          || Number(startState.memorySchedule.nextTriggerAt)
          || liveAlarmAt,
        liveAlarmAt
      },
      runtime: {
        revision: startState.revision,
        pwmStepRunning: startState.pwmStepRunning,
        runningRevision: startState.runningRevision,
        phaseAdoptionInFlight: startState.phaseAdoptionInFlight,
        pwmExecutionCount: startState.pwmExecutionCount,
        repairInFlight: startState.repairInFlight,
        currentAttempt: startState.currentAttempt,
        currentAttempts: startState.currentAttempts,
        activeAttemptCount: startState.currentAttempts.length,
        lastOutcome: latestOutcome
      }
    };
  };
  const captureDiagnosticSnapshot = async () => {
    const firstObservedAt = Date.now();
    const first = await captureDiagnosticSnapshotAttempt(1, firstObservedAt);
    if (first.coherent && first.complete) return first;
    const second = await captureDiagnosticSnapshotAttempt(2, firstObservedAt);
    return {
      ...second,
      coherenceReason: second.coherent
        ? (first.coherent ? '' : 'runtime-changed-during-first-capture')
        : 'runtime-changed-during-capture',
      completenessReason: second.complete
        ? ''
        : 'external-read-incomplete-after-retry'
    };
  };
  const diagnosticBefore = await captureDiagnosticSnapshot();
  await loadScheduleFromStorage();
  const finalizeDiagnosticResult = async (result, lifecycle = null) => {
    const diagnosticAfter = await captureDiagnosticSnapshot();
    return {
      ...result,
      schemaVersion: 2,
      evidence: {
        requestAt: diagnosticRequestAt,
        before: diagnosticBefore,
        repair: {
          requested: true,
          items: [...repairs],
          lifecycle: cloneDiagnosticValue(lifecycle)
        },
        after: diagnosticAfter
      }
    };
  };
  const snapshotDeferredPhaseAdoption = async () => {
    const alarms = await snapshotNamedAlarms();
    return finalizeDiagnosticResult({
      success: false,
      deferred: true,
      reason: 'phase adoption in progress',
      enabled: schedule.enabled === true,
      repaired: false,
      before: alarms,
      repairs: [],
      schedule: { ...schedule, _phaseAdoptionInFlight: true },
      pwmStepRunning: isCurrentPwmStepRunning(),
      alarms
    });
  };
  const recordClearedAlarmRepairs = (before, after) => {
    const names = {
      badge: 'badge-alarm-cleared',
      watchdog: 'watchdog-alarm-cleared',
      pwm: 'pwm-alarm-cleared',
      smartWeather: 'smart-weather-alarm-cleared'
    };
    Object.entries(names).forEach(([key, repair]) => {
      if (before?.[key] && !after?.[key]) repairs.push(repair);
    });
  };

  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    return snapshotDeferredPhaseAdoption();
  }

  if (!schedule.enabled) {
    const beforeAlarms = await snapshotNamedAlarms();
    if (isSyncPhaseAdoptionAdmissionBlocked()) {
      return snapshotDeferredPhaseAdoption();
    }
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (isAutomationAllowed()) return ensureDiagnosticAlarms();
    await chrome.alarms.clear('ac-smart-weather');
    if (schedule.enabled) return ensureDiagnosticAlarms();
    const afterAlarms = await snapshotNamedAlarms();
    recordClearedAlarmRepairs(beforeAlarms, afterAlarms);
    return finalizeDiagnosticResult({
      success: Object.values(afterAlarms).every(alarm => !alarm),
      enabled: false,
      repaired: repairs.length > 0,
      before: beforeAlarms,
      repairs,
      schedule: { ...schedule },
      pwmStepRunning: false,
      alarms: afterAlarms
    });
  }

  if (!isAutomationAllowed()) {
    const beforeAlarms = await snapshotNamedAlarms();
    if (isSyncPhaseAdoptionAdmissionBlocked()) {
      return snapshotDeferredPhaseAdoption();
    }
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (isAutomationAllowed()) return ensureDiagnosticAlarms();
    let smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
    if (schedule.smartMode?.enabled && !smartWeatherAlarm) {
      await rescheduleSmartWeatherAlarm();
      smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
      if (smartWeatherAlarm) repairs.push('smart-weather-alarm');
    }
    if (isAutomationAllowed()) return ensureDiagnosticAlarms();
    const afterAlarms = await snapshotNamedAlarms();
    recordClearedAlarmRepairs(beforeAlarms, afterAlarms);
    return finalizeDiagnosticResult({
      success: !afterAlarms.badge
        && !afterAlarms.watchdog
        && !afterAlarms.pwm
        && (!schedule.smartMode?.enabled || !!afterAlarms.smartWeather),
      enabled: true,
      automationPausedByActiveHours: true,
      repaired: repairs.length > 0,
      before: beforeAlarms,
      repairs,
      schedule: {
        ...schedule,
        _insideActiveHours: false,
        _automationPausedByActiveHours: true
      },
      pwmStepRunning: false,
      alarms: afterAlarms
    });
  }

  let badgeAlarm = await chrome.alarms.get('ac-badge-tick');
  let watchdogAlarm = await chrome.alarms.get('ac-watchdog');
  let pwmAlarm = await chrome.alarms.get('ac-pwm');
  let smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
  const beforeAlarms = {
    badge: snapshotAlarm(badgeAlarm),
    watchdog: snapshotAlarm(watchdogAlarm),
    pwm: snapshotAlarm(pwmAlarm),
    smartWeather: snapshotAlarm(smartWeatherAlarm)
  };
  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    return snapshotDeferredPhaseAdoption();
  }

  if (!badgeAlarm || badgeAlarm.scheduledTime <= Date.now()) {
    if (await createAlarm('ac-badge-tick', { delayInMinutes: 1 })) {
      repairs.push('badge-alarm');
    }
  }

  if (!watchdogAlarm) {
    if (await createAlarm('ac-watchdog', { periodInMinutes: 5 })) {
      repairs.push('watchdog-alarm');
    }
  }

  const comfortStartInFlight = isComfortStartActive() && !pwmAlarm;
  const pwmNeededRepair = !comfortStartInFlight
    && (!pwmAlarm || pwmAlarm.scheduledTime <= Date.now() - 60000);
  const inspectSmartCurrentCycle = !comfortStartInFlight
    && schedule.smartMode?.enabled === true
    && schedule.pwmState === 'on';
  const diagnosticPwmStateBefore = schedule.pwmState;
  const diagnosticPwmAlarmAtBefore = Number(pwmAlarm?.scheduledTime) || 0;
  let diagnosticLifecycleRecovery = null;
  if (pwmNeededRepair || inspectSmartCurrentCycle) {
    diagnosticLifecycleRecovery = await ensureScheduleClock({
      deferSmartCurrentCycleExecution: inspectSmartCurrentCycle
    });
  }

  // 智能模式天气闹钟自愈：ac-smart-weather 是 v0.8.0 新增闹钟，不在既有 5 闹钟
  // 自愈清单里；丢失后天气缓存冻结，等效温度/建议分钟数不再更新。与 badge-tick/watchdog 一样补建。
  if (schedule.smartMode?.enabled && !smartWeatherAlarm) {
    await rescheduleSmartWeatherAlarm();
    smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
    if (smartWeatherAlarm) repairs.push('smart-weather-alarm');
  }

  badgeAlarm = await chrome.alarms.get('ac-badge-tick');
  watchdogAlarm = await chrome.alarms.get('ac-watchdog');
  const diagnosticRevision = pwmRuntimeRevision;
  pwmAlarm = await chrome.alarms.get('ac-pwm');
  if (pwmNeededRepair && pwmAlarm) repairs.push('pwm-alarm');
  const smartCurrentCycleRecovered = diagnosticLifecycleRecovery?.handled === true
    && diagnosticLifecycleRecovery?.plan?.kind === 'recover-smart-current-cycle'
    && (schedule.pwmState !== diagnosticPwmStateBefore
      || Number(pwmAlarm?.scheduledTime) !== diagnosticPwmAlarmAtBefore);
  if (smartCurrentCycleRecovered) {
    repairs.push('smart-current-cycle');
    if (!repairs.includes('pwm-alarm')) repairs.push('pwm-alarm');
  }
  const smartCurrentCycleStarted = diagnosticLifecycleRecovery?.started === true
    && diagnosticLifecycleRecovery?.plan?.kind === 'recover-smart-current-cycle';
  if (smartCurrentCycleStarted) {
    repairs.push('smart-current-cycle-started');
  }
  const smartOnClockRepaired = diagnosticLifecycleRecovery?.handled === true
    && diagnosticLifecycleRecovery?.plan?.kind === 'repair-clock'
    && diagnosticLifecycleRecovery?.plan?.reason === 'skipped-nearest-smart-on-boundary';
  if (smartOnClockRepaired) {
    repairs.push('smart-on-clock');
    if (!repairs.includes('pwm-alarm')) repairs.push('pwm-alarm');
  }

  // 活闹钟存在但 storage 可能缺失 nextTriggerAt → 直接回写（不依赖 syncStoredTriggerFromAlarm 的边界判断）
  // 当前周期恢复已启动时，pwmAlarm 仍可能是恢复前的 23:00 旧快照；此处回写会
  // 在同一 revision 内把旧钟重新认领为真相。等 executor 预置 timer/开机并写入
  // 新绝对截止后再由下一轮诊断校准，in-flight 阶段禁止触碰 trigger storage。
  const triggerPlan = smartCurrentCycleStarted
      || isSyncPhaseAdoptionAdmissionBlocked()
    ? null
    : await persistReconciledPwmTrigger(
      pwmAlarm,
      'ensureDiagnosticAlarms',
      PWM_TRIGGER_NEXT_ONLY_OPTIONS,
      diagnosticRevision
    );
  if (triggerPlan) {
    repairs.push('pwm-trigger');
  }

  const pwmStepInFlight = isCurrentPwmStepRunning() || comfortStartInFlight;

  return finalizeDiagnosticResult({
    success: !!badgeAlarm
      && !!watchdogAlarm
      && (!!pwmAlarm || pwmStepInFlight)
      && (!schedule.smartMode?.enabled || !!smartWeatherAlarm),
    enabled: true,
    repaired: repairs.length > 0,
    before: beforeAlarms,
    repairs,
    schedule: { ...schedule },
    pwmStepRunning: pwmStepInFlight,
    alarms: {
      badge: badgeAlarm ? { scheduledTime: badgeAlarm.scheduledTime } : null,
      watchdog: watchdogAlarm ? { scheduledTime: watchdogAlarm.scheduledTime, periodInMinutes: watchdogAlarm.periodInMinutes } : null,
      pwm: pwmAlarm ? { scheduledTime: pwmAlarm.scheduledTime } : null,
      smartWeather: smartWeatherAlarm ? { scheduledTime: smartWeatherAlarm.scheduledTime } : null
    }
  }, diagnosticLifecycleRecovery);
}

const BACKGROUND_MESSAGE_TYPES = new Set([
  'getSwStatus',
  'updateSchedule',
  'getSchedule',
  'getScheduleLite',
  'getPageTimer',
  'inspectContentRuntime',
  'refreshSmartWeather',
  'reapplySmartNow',
  'repairSchedule',
  'toggleNow',
  'ensureDiagnostics',
  'reportContentError'
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!BACKGROUND_MESSAGE_TYPES.has(msg?.type)) return false;

  // getSwStatus 是纯只读诊断接口(swStartupTime / initCompletedAt / schedule / live alarm),
  // 不依赖 init 完成。放在 await initReady 之前响应,防止 init 卡住时诊断面板拿不到 SW 状态。
  if (msg.type === 'getSwStatus') {
    const now = Date.now();
    // L2 offscreen 长连接保活页(阶段58)存活状态:Chrome 110+ 支持 chrome.offscreen API,
    // 早期 Edge 可能抛异常,catch 后 false 兼容老版本。
    Promise.all([
      chrome.alarms.get('ac-pwm'),
      chrome.offscreen.hasDocument().catch(() => false),
      readPersistedPwmDiagnosticOutcome()
    ]).then(([liveAlarm, offscreenAlive, persistedPwmOutcome]) => {
      const latestPwmOutcome = selectLatestPwmDiagnosticOutcome(
        lastPwmOutcome,
        persistedPwmOutcome
      );
      sendResponse({
        success: true,
        swStartupTime,
        initCompletedAt,
        swAgeMs: now - swStartupTime,
        initCompleted: !!initCompletedAt,
        initAgeMs: initCompletedAt ? (now - initCompletedAt) : -1,
        memorySchedule: { ...schedule },
        liveAlarmScheduledTime: liveAlarm?.scheduledTime || 0,
        pwmRuntimeRevision,
        pwmStepRunning: isCurrentPwmStepRunning(),
        pwmExecutionWithRecoveryCount,
        currentPwmAttempt: currentPwmAttempt ? { ...currentPwmAttempt } : null,
        currentPwmAttempts: getActivePwmDiagnosticAttempts(),
        activePwmAttemptCount: activePwmAttempts.size,
        lastPwmOutcome: latestPwmOutcome ? { ...latestPwmOutcome } : null,
        offscreenAlive: !!offscreenAlive,
        buildTime: BUILD_TIME,
        buildTimeEpochMs: BUILD_TIME_EPOCH_MS
      });
    }).catch((e) => {
      sendResponse({ success: false, error: e?.message || String(e), swStartupTime, initCompletedAt });
    });
    return true;
  }

  if (msg.type === 'reportContentError') {
    // 内容脚本错误回传（fire-and-forget）：content.js / page-confirm.js 采集到未捕获异常后
    // 上报，写入本机诊断日志，让「复制诊断」一并带出页面脚本错误。
    void appendDiagnosticLog(
      msg.level === 'warn' ? 'warn' : 'error',
      String(msg.source || 'content-script').slice(0, 80),
      msg.error || msg.message
    );
    sendResponse({ success: true });
    return false;
  }

  (async () => {
    // 等待 init() 完成，防止使用尚未从 storage 加载的默认 schedule
    await initReady;

    if (msg.type === 'updateSchedule') {
      // 明确停用不排在长达数十秒的页面确认之后：先失效 revision 并向主世界
      // 发送取消，再进入串行事务完成 storage/闹钟/关机定时器收口。
      const updateAdmissionEpoch = automaticDisableAdmissionEpoch;
      const explicitDisablePreviousEnabled = msg.data?.enabled === false
        ? schedule.enabled === true
        : null;
      let explicitDisableAdmissionEpoch = 0;
      let explicitDisableDurablyPersisted = false;
      let explicitDisableIntentPromise = null;
      try {
        if (msg.data?.enabled === false) {
          // 先同步 claim revision/admission，再把 enabled=false 与 publish
          // marker 作为第一个异步 I/O 原子落盘。清 alarm／content request
          // 可能很慢，绝不能排在 durable disable intent 前面。
          explicitDisableAdmissionEpoch = preemptAutomaticOnForExplicitDisable();
          schedule.enabled = false;
          explicitDisableIntentPromise = persistSchedule(
            'updateSchedule-disable-admission-intent',
            {
              syncFromLiveAlarm: false,
              markSyncPublishPending: true
            }
          );
          // queue reservation 在下一行同步发生；先挂 rejection handler，避免
          // 前序长事务令 intent promise 在真正 await 前产生未处理拒绝。
          void explicitDisableIntentPromise.catch(() => {});
        }
        await runSerializedScheduleUpdate(async () => {
      if (explicitDisableIntentPromise) {
        // disable 在首次 await 前已发起 durable 写，同时本 callback 已同步
        // 占住 schedule queue。更晚 enable 必须排在完整停用收口之后执行，
        // 不会被旧 cancelAutomaticOn 反向取消。
        await explicitDisableIntentPromise;
        explicitDisableDurablyPersisted = true;
        await scheduleSyncRetry('publish');
        await finishExplicitDisablePreemption();
      }
      const staleByExplicitDisable = () => msg.data?.enabled !== false
        && updateAdmissionEpoch !== automaticDisableAdmissionEpoch;
      if (staleByExplicitDisable()) {
        throw new Error('设置请求已被更晚的明确停用取消');
      }
      // 提取（Fowler Extract Function）：用户停用路径——B1 顺序：先持久化"已关闭"状态再执行关机。
      const shutdownAfterScheduleDisable = async ({ activeHoursPause = false } = {}) => {
        await resetDisabledPwmRuntime();
        // B1: 先持久化"已关闭"状态，再执行关机 — 确保即便 toggleAC 因 SW 终止而丢失，状态已写入 storage
        if (activeHoursPause) {
          await persistSchedule('updateSchedule-active-hours-paused', { syncFromLiveAlarm: false });
        } else {
          await persistSchedule('updateSchedule');
        }
        const offResult = activeHoursPause
          ? await requestTimerBasedShutdown('schedule-active-hours-paused')
          : await requestTimerBasedShutdown('schedule-disabled');
        if (!offResult?.success) {
          schedule.pageTimerError = `${activeHoursPause ? '运行时段外已暂停' : '定时已关闭'}，但页面关机定时器未确认：${offResult?.error || '未知错误'}`;
        }
        return offResult;
      };

      const wasEnabled = explicitDisablePreviousEnabled === null
        ? schedule.enabled
        : explicitDisablePreviousEnabled;
      const wasAutomationAllowed = isAutomationAllowed();
      const previousActiveHours = JSON.stringify(schedule.activeHours);
      // 防止 restart 泄漏到 schedule 对象中；手动时长单独取出，智能模式下不上送覆盖。
      const {
        restart,
        onMinutes: manualOn,
        offMinutes: manualOff,
        _insideActiveHours,
        _automationPausedByActiveHours,
        ...data
      } = msg.data;
      // 智能模式开启时，on/off 时长是派生值（控制边界消费预计算天气快照）。
      // 弹窗在智能模式下已隐藏手动时长输入，其上送的 manualOn/manualOff 是过期值，直接覆盖会
      // 污染 storage（余额估算、诊断面板、过期闹钟恢复都会读到错误时长，让灵敏度滑块看似无效）。
      const smartEnabled = !!(data.smartMode?.enabled ?? schedule.smartMode?.enabled);
      schedule = {
        ...schedule,
        ...data,
        mode: 'pwm',
        clockMode: data.clockMode !== undefined ? !!data.clockMode : schedule.clockMode
      };
      if (!smartEnabled) {
        schedule.onMinutes = sanitizeMinutes(manualOn ?? schedule.onMinutes, 30);
        schedule.offMinutes = sanitizeMinutes(manualOff ?? schedule.offMinutes, 30);
      }
      // activeHours 单独 merge（嵌套对象）
      if (data.activeHours && typeof data.activeHours === 'object') {
        schedule.activeHours = {
          enabled: !!data.activeHours.enabled,
          start: typeof data.activeHours.start === 'string' ? data.activeHours.start : (schedule.activeHours?.start || '08:00'),
          end: typeof data.activeHours.end === 'string' ? data.activeHours.end : (schedule.activeHours?.end || '23:00')
        };
      }
      // smartMode 单独 merge（嵌套对象，v0.8.0）
      if (data.smartMode && typeof data.smartMode === 'object') {
        schedule.smartMode = {
          enabled: !!data.smartMode.enabled,
          sensitivity: normalizeSmartSensitivity(data.smartMode.sensitivity)
        };
      }
      // 天气只由 :20/:50 的 ac-smart-weather 预取（setupAlarms 已调度），此处不即时拉取。

      const activeHoursChanged = previousActiveHours !== JSON.stringify(schedule.activeHours);
      const automationAllowed = isAutomationAllowed();
      const comfortRequested = !wasEnabled && schedule.enabled;
      let offResult = null;
      let comfortStart = null;
      let startImmediately = false;
      if (!schedule.enabled) {
        if (wasEnabled) {
          offResult = await shutdownAfterScheduleDisable();
        }
      } else if (!comfortRequested && !automationAllowed
          && (wasAutomationAllowed || !wasEnabled || activeHoursChanged || restart)) {
        offResult = await shutdownAfterScheduleDisable({ activeHoursPause: true });
      } else if (!comfortRequested && automationAllowed
          && (!wasAutomationAllowed || restart)
          && !isComfortStartActive()) {
        schedule.pwmState = 'on';
        startImmediately = true;
        // 不在这里 clear nextTriggerAt——让接下来的 runPwmStep() 用正确值覆写。
        // 如果在这里清零，storage 会被写入 nextTriggerAt=0，弹窗读到就会显示缺失。
      }

      await persistSchedule('updateSchedule');
      if (staleByExplicitDisable()) {
        throw new Error('设置请求已被更晚的明确停用取消');
      }
      if (msg.data?.enabled === false) {
        explicitDisableDurablyPersisted = true;
      } else if (msg.data?.enabled === true
          && updateAdmissionEpoch === automaticDisableAdmissionEpoch) {
        // 先前停用若未能落盘会保持 fail-closed；用户随后明确且成功地重新启用，
        // 才以同一 admission epoch 解除阻断。更晚到达的停用会改变 epoch，旧 enable 无权解除。
        releaseExplicitDisableAdmission(updateAdmissionEpoch);
      }
      if (comfortRequested) {
        // 启用意图必须先成功落盘并解除同 epoch 的 fail-closed 准入，再进入舒适
        // 启动。否则一次失败的停用落盘会让下一次明确 enable 被自己的准入锁
        // 取消，同时又因 comfortRequested 跳过 setupAlarms，形成“成功但不开机”。
        comfortStart = await runComfortStart('user-enable');
        await rescheduleSmartWeatherAlarm();
      } else {
        await setupAlarms(startImmediately);
      }
      // 管理看门狗和每分钟 PWM 心跳闹钟
      if (isAutomationAllowed()) {
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      }
      // active hours 边界闹钟：每次 schedule 改变都重新调度
      rescheduleActiveBoundary();
      // [v0.5.6] 跨设备同步：用户改设置 / toggle 是低频事件，立即推送
      // 在 sendResponse 之前完成推送，让 popup 拿到已推送的状态（虽然异步到达对端有时延）。
      await syncScheduleToSync('updateSchedule');
      sendResponse({ success: true, schedule, offResult, comfortStart });
        });
      } finally {
        if (explicitDisableAdmissionEpoch > 0 && explicitDisableDurablyPersisted) {
          releaseExplicitDisableAdmission(explicitDisableAdmissionEpoch);
        }
      }
      return;
    }
    if (msg.type === 'reapplySmartNow') {
      // 滑块松开后的即时反馈：正在执行时记录 trailing rerun，不丢弃最后一次灵敏度。
      const queued = smartReapplyInFlight;
      if (queued) smartReapplyPending = true;
      sendResponse({ success: true, accepted: true, queued });
      if (!queued) {
        waitUntil(runSmartReapplyLoop());
      }
      return;
    }
    if (msg.type === 'getSchedule') {
      const snapshot = await getScheduleSnapshot();
      sendResponse(snapshot);
      return;
    }
    if (msg.type === 'getScheduleLite') {
      // 轻量轮询：跳过 getCurrentACStatus，降低 90% chrome.* I/O
      const snapshot = await getScheduleSnapshot(true);
      sendResponse(snapshot);
      return;
    }
    if (msg.type === 'getPageTimer') {
      const pageTimer = await getCurrentPageTimer();
      sendResponse(pageTimer);
      return;
    }
    if (msg.type === 'inspectContentRuntime') {
      const result = await inspectContentRuntime();
      sendResponse(result);
      return;
    }
    if (msg.type === 'refreshSmartWeather') {
      const weather = await readStoredSmartWeather();
      sendResponse({ success: true, weather });
      return;
    }
    if (msg.type === 'repairSchedule') {
      const result = await repairScheduleClock();
      sendResponse(result);
      return;
    }
    if (msg.type === 'toggleNow') {
      const result = await toggleNowAndSync(msg.action);
      sendResponse(result);
      return;
    }
    if (msg.type === 'ensureDiagnostics') {
      const result = await ensureDiagnosticAlarms();
      sendResponse(result);
      return;
    }
  })().catch((e) => {
    console.error('[AC扩展] 消息处理失败:', msg?.type, e);
    void appendDiagnosticLog('error', `message-${msg?.type || 'unknown'}`, e);
    sendResponse({ success: false, error: e?.message || String(e), schedule });
  });
  return true;
});

// ----- 保活端口：接收 offscreen / popup 心跳，保持 SW 存活 -----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen-keepalive') {
    console.log('[AC扩展] Offscreen 保活端口已连接');
    port.onMessage.addListener((msg) => {
      if (msg.type === 'heartbeat') {
        // 回复心跳确认，维持双向连接
        port.postMessage({ type: 'heartbeat-ack', ts: Date.now() });
      }
    });
    port.onDisconnect.addListener(() => {
      console.log('[AC扩展] Offscreen 保活端口断开');
    });
    return;
  }

  if (port.name === 'popup-keepalive') {
    console.log('[AC扩展] Popup 保活端口已连接');
    port.onDisconnect.addListener(() => {
      console.log('[AC扩展] Popup 保活端口断开');
    });
  }
});

// ----- 启动/恢复兜底 -----
chrome.runtime.onStartup.addListener(() => {
  console.log('[AC扩展] 浏览器启动，恢复 PWM 闹钟');
  initReady.then(() => setupAlarms()).catch((e) => {
    console.error('[AC扩展] onStartup 恢复失败:', e);
    void appendDiagnosticLog('error', 'on-startup', e);
  });
});

// ----- 官方推荐：首次安装/更新时初始化 -----
chrome.runtime.onInstalled.addListener(async (details) => {
  await initReady;
  if (details.reason === 'install') {
    // [v0.5.6] init() 已先尝试从 chrome.storage.sync 采用远端状态。
    // 这里仅当本地仍无 schedule 时才写默认值——避免在另一台设备已运行 PWM 时
    // 用本地默认值覆盖刚被 sync 同步过来的相位。
    const existing = await chrome.storage.local.get([STORAGE_KEY, INSTALL_BOOTSTRAP_KEY]);
    // Load Unpacked 等环境可能在同一 profile 的后续启动中再次报告 install。
    // 先以 local marker 认领且只处理一次；否则安装回调尾声会把普通浏览器重启
    // 或用户稍后的 false→true 误认成首次安装，再启动第二条舒适事务。
    const firstInstallBootstrap = existing[INSTALL_BOOTSTRAP_KEY] !== true;
    const installComfortEligible = firstInstallBootstrap
      && existing[STORAGE_KEY]?.enabled === true;
    if (firstInstallBootstrap) {
      await chrome.storage.local.set({ [INSTALL_BOOTSTRAP_KEY]: true });
    }
    if (!existing[STORAGE_KEY]) {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          enabled: false,
          mode: 'pwm',
          clockMode: false,
          onMinutes: 60,
          offMinutes: 60,
          pwmState: 'off',
          nextTriggerAt: 0,
          alarmCreatedAt: 0,
          alarmDelayMinutes: 0,
          pageTimerTargetAt: 0,
          pageTimerRetryMinutes: 0,
          comfortStartUntil: 0,
          comfortStartOnConfirmedAt: 0,
          smartOnBoundaryAt: 0,
          pwmRetryKind: '',
          pwmRetryBoundaryAt: 0,
          pwmRetryScheduledAt: 0,
          activeHours: { enabled: false, start: '08:00', end: '23:00' },
          smartMode: { enabled: false, sensitivity: 5 }
        }
      });
      console.log('[AC扩展] 首次安装，已设置默认值（间隔模式）');
      // 若 sync 区也空，则把默认配置 seed 给 sync——让后续在其他设备安装的扩展
      // 自动拿到默认值；若 sync 已有（其他设备先装过），不覆盖。
      if (chrome.storage?.sync) {
        try {
          const syncExisting = await chrome.storage.sync.get(SYNC_KEY);
          if (!syncExisting[SYNC_KEY]) {
            await syncScheduleToSync('install-seed');
          }
        } catch (e) {
          console.warn('[AC扩展] install-seed sync 推送失败:', e?.message);
        }
      }
    } else {
      console.log('[AC扩展] 首次安装：检测到 schedule 已存在（init 采用 sync 或迁移）跳过默认写入');
    }
    await loadScheduleFromStorage();
    if (schedule.enabled) {
      if (installComfortEligible && !isComfortStartActive()) {
        await runSerializedScheduleUpdate(() => runComfortStart('install'));
      }
    }
  } else if (details.reason === 'update') {
    console.log(`[AC扩展] 已更新（${details.previousVersion} → ${chrome.runtime.getManifest().version}）`);
    // [v0.5.6] 更新时把当前 schedule seed 给 sync（若 sync 空），方便新设备加入
    if (chrome.storage?.sync) {
      try {
        const syncExisting = await chrome.storage.sync.get(SYNC_KEY);
        if (!syncExisting[SYNC_KEY] && schedule?.enabled) {
          await syncScheduleToSync('update-seed');
        }
      } catch (_) { /* ignore */ }
    }
  }
});

// ----- 官方推荐：检测到新版本自动热更新 -----
chrome.runtime.onUpdateAvailable.addListener(() => {
  console.log('[AC扩展] 检测到新版本，自动重新加载...');
  chrome.runtime.reload();
});

// ----- storage 变动监听：local 只同步内存状态，sync 触发跨设备合并 -----
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]?.newValue) {
    // 只同步内存状态。不要在每次 storage 写入后 setupAlarms，
    // 否则 runPwmStep 写入下一阶段倒计时时会反复重建闹钟，影响无弹窗后台执行。
    schedule = { ...schedule, ...changes[STORAGE_KEY].newValue };
    return;
  }

  if (areaName === 'sync' && changes[SYNC_KEY]?.newValue) {
    // [v0.5.6] 收到远端 sync 变更 → 异步合并到本地培训 + 重排闹钟。
    // 不在此 await（onChanged 是同步事件回调，不能阻塞）——tryAdoptSyncedState 自带 _syncOpLock
    // 互斥保证并发安全。applySyncedPhase 内部会触发 persistSchedule 触发一次 local 变更 →
    // 上面 local 分支自动同步内存（不会无限循环，因 sync 写采用 lastSyncedAt 守卫）。
    console.log('[AC扩展] sync ↓ onChanged：收到远端变更，启动异步合并');
    tryAdoptSyncedState('onChanged-sync', changes[SYNC_KEY].newValue)
      .catch(e => console.warn('[AC扩展] onChanged sync 合并失败:', e?.message));
  }
});

// ----- 启动 -----
init();
