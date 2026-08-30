// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

// i18n 辅助函数 — 使用 fetch-based I18n 模块（绕过 chrome.i18n 不可靠性）
importScripts('i18n.js');
importScripts('sync-helpers.js');  // 跨设备同步的纯函数（composeSyncPayload / computePhaseAdoption）
importScripts('schedule-mutations.js');  // schedule 复合字段的受控 mutation primitives
importScripts('pwm-retry.js');  // PWM retry kind 的唯一语义目录（纯决策）
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
const PAGE_TIMER_RETRY_ALARM = 'ac-page-timer-retry';
const COMFORT_START_MINUTES = 5;
const COMFORT_START_RETRY_MS = 60_000;
const COMFORT_START_END_ALARM = 'ac-comfort-end';
const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
const STORAGE_KEY = 'ac_schedule';
const MANUAL_OFF_ADMISSION_KEY = 'ac_manual_off_admission';
const MANUAL_OFF_ADMISSION_SCHEMA_VERSION = 1;
const MANUAL_OFF_ADMISSION_RETRY_ALARM = 'ac-manual-off-admission-retry';
const DEFERRED_SYNC_DISABLE_KEY = 'ac_deferred_sync_disable';
const LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY =
  'ac_local_schedule_mutation_cutoff';
const LOCAL_TERMINAL_AUTHORITY_KEY = 'ac_local_terminal_authority';
const LOCAL_TERMINAL_AUTHORITY_SCHEMA_VERSION = 1;
const DEFERRED_SYNC_DISABLE_RETRY_ALARM = 'ac-deferred-sync-disable-retry';
const DEFERRED_SYNC_SUCCESSOR_RETRY_ALARM = 'ac-deferred-sync-successor-retry';
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
const SCHEDULE_READ_RETRY_ALARM = 'ac-schedule-read-retry';
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
const SYNC_PAYLOAD_RECEIPT_KEY = 'ac_schedule_sync_payload_receipt';
const SYNC_PAYLOAD_RECEIPT_SCHEMA_VERSION = 1;
const SYNC_PENDING_PUBLISH_KEY = 'ac_schedule_sync_publish_pending';
let lastSyncedAt = 0;
let syncWatermarkLoaded = false;
let completedSyncPayloadReceipt = null;
let syncWriteChain = Promise.resolve();
let syncWatermarkWriteChain = Promise.resolve();
let syncWatermarkWriteGeneration = 0;
let syncWatermarkWritesInFlight = 0;
let syncPublishGeneration = 0;
let syncWriteOperationsInFlight = 0;
let syncPublishRetryAlarmWriteChain = Promise.resolve();
let syncPublishRetryAlarmWriteGeneration = 0;
let syncPublishRetryAlarmWritesInFlight = 0;
const activeLocalSyncEchoIdentities = new Set();

function normalizeSyncAuthorityTimestamp(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeSyncAuthorityCutoff(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function canonicalizeSyncPayloadIdentity(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) {
    throw new TypeError('sync payload identity cannot contain cycles');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => canonicalizeSyncPayloadIdentity(item, seen));
    }
    const canonical = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalizeSyncPayloadIdentity(value[key], seen);
    }
    return canonical;
  } finally {
    seen.delete(value);
  }
}

function getSyncPayloadIdentity(value) {
  if (!value || typeof value !== 'object') return '';
  try {
    return JSON.stringify(canonicalizeSyncPayloadIdentity(value));
  } catch (_) {
    return '';
  }
}

function normalizeSyncPayloadReceipt(value) {
  if (!value || typeof value !== 'object'
      || Number(value.schemaVersion) !== SYNC_PAYLOAD_RECEIPT_SCHEMA_VERSION) {
    return null;
  }
  const syncedAt = normalizeSyncAuthorityTimestamp(value.syncedAt);
  const identity = typeof value.identity === 'string' ? value.identity : '';
  const hasCoveredMutation = Object.prototype.hasOwnProperty.call(
    value,
    'coveredLocalMutationObservedAt'
  );
  const coveredLocalMutationObservedAt = Number(
    value.coveredLocalMutationObservedAt
  );
  if (!(syncedAt > 0)
      || !identity
      || !hasCoveredMutation
      || !Number.isSafeInteger(coveredLocalMutationObservedAt)
      || coveredLocalMutationObservedAt < 0) {
    return null;
  }
  return Object.freeze({
    schemaVersion: SYNC_PAYLOAD_RECEIPT_SCHEMA_VERSION,
    syncedAt,
    identity,
    coveredLocalMutationObservedAt
  });
}

function hasDurableCompletedSyncPayloadReceiptBeforeCurrentMutation(value) {
  const syncedAt = normalizeSyncAuthorityTimestamp(value?.syncedAt);
  const identity = getSyncPayloadIdentity(value);
  return syncWatermarkLoaded
    && syncedAt > 0
    && !!identity
    && lastSyncedAt >= syncedAt
    && completedSyncPayloadReceipt?.syncedAt === syncedAt
    && completedSyncPayloadReceipt?.identity === identity
    && localScheduleMutationCommittedObservedAt
      > completedSyncPayloadReceipt.coveredLocalMutationObservedAt;
}

function rememberLocalSyncPayload(value) {
  const identity = getSyncPayloadIdentity(value);
  if (identity) activeLocalSyncEchoIdentities.add(identity);
  return identity;
}

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
let explicitDisableDurableWriteChain = Promise.resolve();
let manualToggleIntentEpoch = 0;
let manualToggleIntentAction = '';
let manualToggleIntentSource = '';
let manualToggleIntentCompletedEpoch = 0;
let manualToggleIntentCompletedAction = '';
let completedLocalTerminalAuthority = null;
let manualTogglePhaseCommitPendingEpoch = 0;
let manualOffCancellationChain = Promise.resolve();
// 启动时先 fail-closed；init 的第一项持久读取只有确认“没有 pending OFF”
// 才会放行。这样 storage.get 尚未返回时，sync/onChanged 也不能抢跑自动 ON。
let manualOffAutomaticOnBlocked = true;
let manualOffAdmissionLoaded = false;
let manualOffAdmissionToken = '';
let manualOffAdmissionRequestedAt = 0;
let manualOffAdmissionRestoredFromStorage = false;
let manualOffAdmissionLocalMutationObservedAt = 0;
let manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
let manualOffAdmissionMutationCoverageComplete = false;
let manualOffAdmissionPredecessorSuccessorObservedAt = 0;
let manualOffAdmissionPredecessorSuccessorIdentity = '';
let manualOffAdmissionSequence = 0;
let manualOffAdmissionWriteChain = Promise.resolve();
let manualOffAdmissionReleasedThroughRequestedAt = 0;
let manualOffAdmissionPredecessorRequestedAt = 0;
let manualOffAdmissionPredecessorTokens = [];
let manualOffAdmissionFlightToken = '';
let manualOffAdmissionFlightPromise = null;
const manualOffRetryAlarmOperationsInFlight = new Set();
// 启动首轮多源读取失败时，manual-OFF 的 authority 基线必须固定在首读
// 开始时；fresh reclassify 不能拿“修复开始时”的较新用户 epoch 反向复活旧 OFF。
let startupManualOffClassificationPending = false;
let startupManualOffClassificationIntentEpoch = 0;
let deferredSyncDisableLoaded = false;
let deferredSyncDisablePending = false;
let deferredSyncDisableEpoch = 0;
// 每轮 safety F 都有独立谱系。T 只有携带当前 exact id，才能在跨 SW、
// 墙钟回拨/快进后仍证明自己确实发生在这轮 F 之后。
let deferredSyncDisableSafetyAuthorityId = '';
let deferredSyncLastClearedSafetyAuthorityId = '';
let deferredSyncDisableRemoteSnapshot = null;
let deferredSyncDisableRemoteSnapshotComplete = false;
let deferredSyncDisableSyntheticReadFailure = false;
let deferredSyncDisableObservedAt = 0;
let deferredSyncDisableSuccessorSnapshot = null;
let deferredSyncDisableSuccessorObservedAt = 0;
let remoteSyncAuthorityObservedAt = 0;
let localScheduleAuthorityObservedAt = 0;
let localScheduleMutationObservedAt = 0;
let deferredSyncDisableSuccessorLocalAuthorityGeneration = 0;
let localScheduleMutationGeneration = 0;
let localScheduleMutationCommitPendingGeneration = 0;
let localScheduleMutationCommittedObservedAt = 0;
const localScheduleMutationObservedAtByGeneration = new Map();
let syncAuthorityDurableBaselineLoaded = false;
let syncAuthorityDurableBaselineLoadPromise = null;
let startupManualOffAdmissionRestorePromise = null;
let syncAuthorityPreBaselineSequence = 0;
let syncAuthorityDurablePreBaselineSequenceReservedThrough = 0;
const syncAuthorityPreBaselineSequenceByObservedAt = new Map();
let deferredSyncDisableAuthorityOrderObservedAt = 0;
let deferredSyncDisableAuthorityPreBaselineSequence = 0;
let deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
let deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
let deferredSyncDisableSuccessorRetryAlarmName = '';
let deferredSyncDisableLocalMutationGeneration = 0;
let deferredSyncDisableSuccessorMutationGeneration = 0;
let deferredSyncDisableRetryAlarmNames = new Set();
let deferredSyncDisableReleasedRetryAlarmNames = new Set();
const deferredSyncDisableRetryAlarmOperationsInFlight = new Set();
let deferredSyncSuccessorRetryAlarmEntries = new Map();
let deferredSyncSuccessorReleasedRetryAlarmNames = new Set();
let deferredSyncSuccessorReleasedThroughObservedAt = 0;
let deferredSyncSuccessorEnumerationPendingEpoch = 0;
let deferredSyncDisableDurableReceiptEpoch = 0;
let deferredSyncDisableDurableReceiptIdentity = '';
const deferredSyncSuccessorRetryAlarmOperationsInFlight = new Set();
// 只记录当前 SW 实际收到的 remote disable 到达次序；启动恢复发现的
// 既有 durable pending 不递增。这样本机用户 authority 可以覆盖到达前的
// 旧记录，但绝不能在长 schedule/phase 等待后清掉后来才到的停用。
let remoteDisableArrivalGeneration = 0;
// 每个非本机 echo 的 sync onChanged 都递增；用于约束异步 sync.get
// 快照，防止读取中的旧 F 在后到 T 已登记后反向清掉 T。
let syncInboundArrivalGeneration = 0;
let localScheduleAuthorityGeneration = 0;
let deferredSyncDisableLocalScheduleAuthorityGeneration = 0;
let startupDeferredDisableSupersededByUserIntent = false;
// startup safety read 与其 await 中到达的用户 intent 绑定。它只是一张
// transient owner，不是 terminal authority；请求成功或失败收口都必须按
// exact epoch 释放，旧请求也不能清掉更新的 owner。
let startupRestoreSupersedingIntentEpoch = 0;
// 所有会改变自动控制终止语义的 local storage 写共用一条 FIFO。
// chrome.storage.local.set 的 Promise 完成顺序没有跨调用保证；若 schedule、
// manual-OFF marker、deferred disable 各自裸写，旧 writer 可以在明确停用之后
// 才落盘并在下一次 SW 启动时复活 enabled=true。
let criticalLocalStateWriteChain = Promise.resolve();
let schedulePersistenceAuthorityEpoch = 0;
let syncPhaseAdoptionAdmissionEpoch = 0;
let syncPhaseAdoptionAdmissionOwner = 0;
const syncPhaseAdoptionAdmissionWaiters = [];
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

function normalizeLocalTerminalAuthority(value) {
  if (!value || typeof value !== 'object'
      || value.schemaVersion !== LOCAL_TERMINAL_AUTHORITY_SCHEMA_VERSION) {
    return null;
  }
  const action = value.action === 'off'
    ? 'off'
    : value.action === 'disable'
      ? 'disable'
      : value.action === 'on'
        ? 'on'
        : '';
  const observedAt = Number(value.observedAt) || 0;
  if (!action || observedAt <= 0) return null;
  return Object.freeze({
    schemaVersion: LOCAL_TERMINAL_AUTHORITY_SCHEMA_VERSION,
    action,
    observedAt,
    consumedRemoteDisableRetryAlarmNames: [...new Set(
      (Array.isArray(value.consumedRemoteDisableRetryAlarmNames)
        ? value.consumedRemoteDisableRetryAlarmNames
        : [])
        .map(name => String(name || ''))
        .filter(Boolean)
    )],
    completedAt: Number(value.completedAt) || 0
  });
}

function adoptLocalTerminalAuthority(value) {
  const normalized = normalizeLocalTerminalAuthority(value);
  if (!normalized) return null;
  if (!completedLocalTerminalAuthority
      || normalized.observedAt
        >= completedLocalTerminalAuthority.observedAt) {
    completedLocalTerminalAuthority = normalized;
  }
  return completedLocalTerminalAuthority;
}

function localTerminalAuthorityCoversObservedAt(observedAt) {
  const cutoff = Number(observedAt) || 0;
  return cutoff > 0
    && Number(completedLocalTerminalAuthority?.observedAt) >= cutoff;
}

function localTerminalAuthorityCoversRemoteDisable(identity) {
  const retryAlarmName = String(identity?.name || '');
  return !!completedLocalTerminalAuthority
    && retryAlarmName
    && completedLocalTerminalAuthority
      .consumedRemoteDisableRetryAlarmNames
      .includes(retryAlarmName);
}

function claimManualToggleIntent(action) {
  const normalizedAction = action === 'off'
    ? 'off'
    : action === 'disable'
      ? 'disable'
      : 'on';
  // 每个到达的用户请求都换 epoch：即使上次意图也是 OFF，
  // 两次 OFF 之间也可能已有一轮新的自动 ON 在途。同向幂等由
  // schedule/page FIFO 与真实状态预检实现，不能用复用 owner 换取。
  manualToggleIntentEpoch += 1;
  manualToggleIntentAction = normalizedAction;
  manualToggleIntentSource = 'user';
  // 在任何 await 前让仍在读取 live alarm 的旧 persistSchedule 失效。
  // 已经进入 storage.set 的旧写则由 criticalLocalStateWriteChain 保证先于
  // 本意图的 durable commit 完成。
  schedulePersistenceAuthorityEpoch += 1;
  if (normalizedAction === 'on') {
    // 后到手动 ON 要同步撤销所有旧自动 ON/OFF 与页面 shutdown writer；
    // durable manual-OFF marker 仍保留到新 ON 真正取得 phase owner 并清理成功。
    pwmRuntimeRevision += 1;
    invalidateTimerBasedShutdown();
    syncPublishGeneration += 1;
  }
  return manualToggleIntentEpoch;
}

function isManualToggleIntentCurrent(intentEpoch, action) {
  const normalizedAction = action === 'off'
    ? 'off'
    : action === 'disable'
      ? 'disable'
      : 'on';
  return Number.isSafeInteger(intentEpoch)
    && intentEpoch > 0
    && intentEpoch === manualToggleIntentEpoch
    && manualToggleIntentAction === normalizedAction;
}

function isManualToggleIntentEpochCurrent(intentEpoch) {
  return Number.isSafeInteger(intentEpoch)
    && intentEpoch >= 0
    && intentEpoch === manualToggleIntentEpoch;
}

async function persistCompletedLocalTerminalAuthority(
  intentEpoch,
  action,
  mutationObservedAt
) {
  const normalizedAction = action === 'off'
    ? 'off'
    : action === 'disable'
      ? 'disable'
      : 'on';
  if (!isManualToggleIntentCurrent(intentEpoch, normalizedAction)) {
    return false;
  }
  const observedAt = Math.max(
    Number(mutationObservedAt) || 0,
    manualToggleIntentCompletedEpoch === intentEpoch
      ? Number(completedLocalTerminalAuthority?.observedAt) || 0
      : 0
  );
  if (observedAt <= 0) return false;
  const authorityIsCurrent = () => (
    isManualToggleIntentCurrent(intentEpoch, normalizedAction)
  );
  const persisted = await runSerializedCriticalLocalStateWrite(async () => {
    if (!authorityIsCurrent()) return false;
    const current = normalizeLocalTerminalAuthority(
      completedLocalTerminalAuthority
    );
    const consumedRemoteDisableRetryAlarmNames = [...new Set([
      ...(current?.consumedRemoteDisableRetryAlarmNames || []),
      ...deferredSyncDisableReleasedRetryAlarmNames
    ])];
    const receipt = Object.freeze({
      schemaVersion: LOCAL_TERMINAL_AUTHORITY_SCHEMA_VERSION,
      action: normalizedAction,
      observedAt: Math.max(
        observedAt,
        Number(current?.observedAt) || 0
      ),
      consumedRemoteDisableRetryAlarmNames,
      completedAt: Date.now()
    });
    await chrome.storage.local.set({
      [LOCAL_TERMINAL_AUTHORITY_KEY]: receipt
    });
    if (!authorityIsCurrent()) return false;
    adoptLocalTerminalAuthority(receipt);
    return true;
  });
  return persisted && authorityIsCurrent();
}

async function finalizeCompletedManualToggleAuthority(
  intentEpoch,
  action,
  mutationObservedAt = 0
) {
  const normalizedAction = action === 'off'
    ? 'off'
    : action === 'disable'
      ? 'disable'
      : 'on';
  const terminalAuthorityPersisted =
    await persistCompletedLocalTerminalAuthority(
      intentEpoch,
      normalizedAction,
      mutationObservedAt
        || completedLocalTerminalAuthority?.observedAt
    );
  if (!terminalAuthorityPersisted) return false;
  manualToggleIntentCompletedEpoch = intentEpoch;
  manualToggleIntentCompletedAction = normalizedAction;
  if (!manualOffAutomaticOnBlocked
      && manualOffAdmissionPredecessorTokens.length === 0
      && !manualOffAdmissionToken) {
    return true;
  }
  return releaseManualOffAdmissionForAuthority(
    intentEpoch,
    normalizedAction
  );
}

function finishManualTogglePhaseCommit(intentEpoch) {
  releaseStartupRestoreSupersession(intentEpoch);
  if (manualTogglePhaseCommitPendingEpoch !== intentEpoch) return;
  manualTogglePhaseCommitPendingEpoch = 0;
  drainDeferredSyncAdoptionAfterManualOffAdmission();
}

function isStartupRestoreSupersededByUserIntent() {
  return startupRestoreSupersedingIntentEpoch > 0;
}

function releaseStartupRestoreSupersession(intentEpoch) {
  const epoch = Number(intentEpoch) || 0;
  if (epoch > 0 && startupRestoreSupersedingIntentEpoch === epoch) {
    startupRestoreSupersedingIntentEpoch = 0;
    return true;
  }
  return false;
}

function drainAfterLocalScheduleMutation(reason) {
  if (manualOffAutomaticOnBlocked && manualOffAdmissionToken) {
    void waitUntil(
      resumePendingManualOffAdmission(reason).catch(error => {
        console.warn('[AC扩展] 本机设置收口后恢复手动关机失败:', error?.message);
      })
    );
    return;
  }
  if (!deferredSyncDisableSuccessorSnapshot) return;
  void waitUntil(
    tryAdoptSyncedState(reason).catch(error => {
      console.warn('[AC扩展] 本机设置收口后重放 remote successor 失败:', error?.message);
    })
  );
}

function finishLocalScheduleMutationCommit(mutationGeneration) {
  if (localScheduleMutationCommitPendingGeneration
      !== mutationGeneration) return;
  const mutationObservedAt = Number(
    localScheduleMutationObservedAtByGeneration.get(mutationGeneration)
  ) || 0;
  if (mutationObservedAt <= 0
      || localScheduleMutationCommittedObservedAt < mutationObservedAt) {
    // 请求在首次 durable intent 前失败：显式撤销 transient admission。
    // 它既不能 terminal/discard T，也不能靠 offscreen keepalive 永久卡住
    // mailbox；后续 T 仍按已有 durable authority 重放。
    localScheduleMutationCommitPendingGeneration = 0;
    localScheduleMutationObservedAtByGeneration.delete(mutationGeneration);
    if (deferredSyncDisableSuccessorSnapshot
        && deferredSyncDisableSuccessorMutationGeneration
          < mutationGeneration) {
      // M 没有 durable authority，不能拿它的 transient generation 淘汰
      // 更早已登记的 T。把当前 mailbox 重标到已撤销 generation 后重放。
      deferredSyncDisableSuccessorMutationGeneration = mutationGeneration;
    }
    drainAfterLocalScheduleMutation('local-schedule-mutation-aborted');
    return;
  }
  localScheduleMutationCommitPendingGeneration = 0;
  localScheduleMutationObservedAtByGeneration.delete(mutationGeneration);
  drainAfterLocalScheduleMutation('local-schedule-mutation-committed');
}

function recordCommittedLocalScheduleMutation(cutoffObservedAt) {
  const cutoff = Number(cutoffObservedAt) || 0;
  if (cutoff <= 0) return;
  localScheduleMutationCommittedObservedAt = Math.max(
    localScheduleMutationCommittedObservedAt,
    cutoff
  );
}

function getEffectiveDeferredRemoteAuthorityObservedAt() {
  const successorObservedAt =
    Number(deferredSyncDisableSuccessorObservedAt) || 0;
  if (deferredSyncDisableSuccessorSnapshot && successorObservedAt > 0) {
    return Number(
      deferredSyncDisableSuccessorAuthorityOrderObservedAt
    ) || successorObservedAt;
  }
  if (deferredSyncDisablePending) {
    return Number(deferredSyncDisableAuthorityOrderObservedAt)
      || Number(deferredSyncDisableObservedAt)
      || 0;
  }
  return 0;
}

function hasCommittedLocalMutationAfterDeferredRemoteAuthority() {
  const remoteObservedAt =
    getEffectiveDeferredRemoteAuthorityObservedAt();
  return remoteObservedAt > 0
    && localScheduleMutationCommittedObservedAt > remoteObservedAt;
}

function claimLocalScheduleMutationIntent() {
  localScheduleMutationGeneration += 1;
  localScheduleMutationObservedAt = nextSyncAuthorityObservedAt();
  localScheduleMutationObservedAtByGeneration.clear();
  localScheduleMutationObservedAtByGeneration.set(
    localScheduleMutationGeneration,
    localScheduleMutationObservedAt
  );
  localScheduleMutationCommitPendingGeneration =
    localScheduleMutationGeneration;
  return localScheduleMutationGeneration;
}

async function commitLocalScheduleMutationAuthority(
  mutationGeneration,
  reason = ''
) {
  const mutationIsCurrent = () => (
    mutationGeneration > 0
    && mutationGeneration === localScheduleMutationGeneration
    && mutationGeneration === localScheduleMutationCommitPendingGeneration
  );
  if (!mutationIsCurrent()
      || !await ensureSyncAuthorityDurableBaselineLoaded()) return false;
  const cutoffObservedAt = Number(
    localScheduleMutationObservedAtByGeneration.get(mutationGeneration)
  ) || 0;
  if (cutoffObservedAt <= 0 || !mutationIsCurrent()) return false;
  const scheduleSnapshot = snapshotScheduleForLocalPersistence();
  syncPublishGeneration += 1;
  let releasedRetryAlarmNames = [];
  const committed = await runSerializedCriticalLocalStateWrite(async () => {
    if (!mutationIsCurrent()) return false;
    releasedRetryAlarmNames =
      await captureDeferredSyncSuccessorRetryAlarmsBeforeLocalMutation(
        mutationGeneration,
        cutoffObservedAt
      );
    if (!mutationIsCurrent()) return false;
    const capturedSuccessorReceipt =
      snapshotCurrentDeferredSyncSuccessorPredecessor({
        mutationGeneration,
        cutoffObservedAt
      });
    const durableCutoffObservedAt = Math.max(
      localScheduleMutationCommittedObservedAt,
      cutoffObservedAt
    );
    const durableReleasedRetryAlarmNames = [...new Set([
      ...deferredSyncSuccessorReleasedRetryAlarmNames,
      ...releasedRetryAlarmNames
    ])];
    let deferredMailboxSnapshot =
      snapshotDeferredSyncDisableMailbox(reason) || {
        pending: false,
        safetyCutoffObservedAt: deferredSyncDisableObservedAt,
        updatedAt: Date.now(),
        reason: String(reason || ''),
        releasedRetryAlarmNames: [
          ...deferredSyncDisableReleasedRetryAlarmNames
        ],
        releasedSuccessorThroughObservedAt:
          deferredSyncSuccessorReleasedThroughObservedAt
      };
    deferredMailboxSnapshot = omitCapturedDeferredSyncSuccessor(
      deferredMailboxSnapshot,
      capturedSuccessorReceipt
    );
    deferredMailboxSnapshot.localMutationCutoffObservedAt =
      durableCutoffObservedAt;
    deferredMailboxSnapshot.releasedSuccessorRetryAlarmNames =
      durableReleasedRetryAlarmNames;
    const durableMailboxSnapshot = mergeDeferredSyncSafetyMetadata(
      deferredMailboxSnapshot
    );
    const coveredManualOffToken = String(
      manualOffAdmissionToken || ''
    );
    const coveredManualOffMarker = coveredManualOffToken
        && manualOffAutomaticOnBlocked
      ? {
          schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
          state: 'pending',
          token: coveredManualOffToken,
          requestedAt: Number(manualOffAdmissionRequestedAt) || Date.now(),
          localMutationObservedAt: Math.max(
            Number(manualOffAdmissionLocalMutationObservedAt) || 0,
            cutoffObservedAt
          ),
          localMutationPredecessorRetryAlarmNames:
            [...releasedRetryAlarmNames],
          localMutationPredecessorCoverageComplete: true,
          localMutationCoverageCommitObservedAt: cutoffObservedAt,
          localMutationPredecessorSuccessorObservedAt:
            Number(capturedSuccessorReceipt?.observedAt) || 0,
          localMutationPredecessorSuccessorIdentity:
            String(capturedSuccessorReceipt?.identity || '')
        }
      : null;
    await chrome.storage.local.set({
      [STORAGE_KEY]: scheduleSnapshot,
      [LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]: durableCutoffObservedAt,
      [DEFERRED_SYNC_DISABLE_KEY]: durableMailboxSnapshot,
      ...(coveredManualOffMarker
        ? { [MANUAL_OFF_ADMISSION_KEY]: coveredManualOffMarker }
        : {}),
      [SYNC_PENDING_PUBLISH_KEY]: true
    });
    recordCommittedLocalScheduleMutation(durableCutoffObservedAt);
    for (const name of releasedRetryAlarmNames) {
      deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
    }
    discardCapturedDeferredSyncSuccessorInMemory(
      capturedSuccessorReceipt
    );
    if (coveredManualOffMarker
        && manualOffAdmissionToken === coveredManualOffToken) {
      manualOffAdmissionPredecessorSuccessorRetryAlarmNames =
        [...releasedRetryAlarmNames];
      manualOffAdmissionMutationCoverageComplete = true;
      manualOffAdmissionLocalMutationObservedAt = Math.max(
        manualOffAdmissionLocalMutationObservedAt,
        cutoffObservedAt
      );
      manualOffAdmissionPredecessorSuccessorObservedAt =
        Number(capturedSuccessorReceipt?.observedAt) || 0;
      manualOffAdmissionPredecessorSuccessorIdentity =
        String(capturedSuccessorReceipt?.identity || '');
    }
    return mutationIsCurrent();
  });
  if (committed && releasedRetryAlarmNames.length > 0) {
    await clearDeferredSyncSuccessorRetryAlarms(
      releasedRetryAlarmNames,
      { preserveReleasedNames: true }
    ).catch(error => {
      console.warn('[AC扩展] 清理被本机 mutation 淘汰的 successor 恢复钟失败:', error?.message);
    });
  }
  return committed;
}

function reclaimPendingManualOffAfterFailedAuthority(
  intentEpoch,
  action,
  ensureCurrent = null
) {
  if (!isManualToggleIntentCurrent(intentEpoch, action)
      || (typeof ensureCurrent === 'function' && !ensureCurrent())
      || !manualOffAutomaticOnBlocked) return 0;
  if (!manualOffAdmissionToken
      && manualOffAdmissionPredecessorTokens.length > 0) {
    manualOffAdmissionToken = manualOffAdmissionPredecessorTokens.at(-1);
    manualOffAdmissionRequestedAt = Math.max(
      manualOffAdmissionRequestedAt,
      manualOffAdmissionPredecessorRequestedAt,
      1
    );
  }
  if (!manualOffAdmissionToken) return 0;
  manualToggleIntentEpoch += 1;
  manualToggleIntentAction = 'off';
  manualToggleIntentSource = 'recovery';
  schedulePersistenceAuthorityEpoch += 1;
  pwmRuntimeRevision += 1;
  syncPublishGeneration += 1;
  invalidateTimerBasedShutdown();
  return manualToggleIntentEpoch;
}

function createManualOffAdmissionToken(intentEpoch) {
  manualOffAdmissionSequence += 1;
  return [
    Date.now(),
    intentEpoch,
    manualOffAdmissionSequence,
    Math.random().toString(36).slice(2)
  ].join(':');
}

function isPendingManualOffAdmissionValue(value) {
  return value?.schemaVersion === MANUAL_OFF_ADMISSION_SCHEMA_VERSION
    && (value?.state === undefined || value?.state === 'pending')
    && typeof value?.token === 'string'
    && value.token.length > 0
    && Number.isFinite(Number(value.requestedAt));
}

function createReleasedManualOffAdmissionValue({
  token = manualOffAdmissionToken,
  requestedAt = manualOffAdmissionRequestedAt,
  releasedTokens = []
} = {}) {
  const releasedThroughRequestedAt = Math.max(
    manualOffAdmissionReleasedThroughRequestedAt,
    Number(requestedAt) || 0
  );
  return Object.freeze({
    schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
    state: 'released',
    releasedAt: Date.now(),
    releasedToken: String(token || ''),
    releasedTokens: [...new Set([
      String(token || ''),
      ...releasedTokens.map(value => String(value || ''))
    ].filter(Boolean))],
    releasedThroughRequestedAt
  });
}

function createManualOffRetryAlarmName(
  token,
  requestedAt,
  localMutationObservedAt = manualOffAdmissionLocalMutationObservedAt
) {
  return [
    MANUAL_OFF_ADMISSION_RETRY_ALARM,
    Math.trunc(Number(requestedAt) || 0),
    Math.max(0, Math.trunc(Number(localMutationObservedAt) || 0)),
    encodeURIComponent(String(token || ''))
  ].join(':');
}

function parseManualOffRetryAlarm(alarm) {
  const name = String(alarm?.name || '');
  const prefix = `${MANUAL_OFF_ADMISSION_RETRY_ALARM}:`;
  if (!name.startsWith(prefix)) return null;
  const identity = name.slice(prefix.length);
  const separator = identity.indexOf(':');
  if (separator <= 0) return null;
  const requestedAt = Number(identity.slice(0, separator)) || 0;
  const encodedIdentity = identity.slice(separator + 1);
  const mutationSeparator = encodedIdentity.indexOf(':');
  const possibleMutationObservedAt = mutationSeparator > 0
    ? Number(encodedIdentity.slice(0, mutationSeparator)) || 0
    : 0;
  const localMutationObservedAt = possibleMutationObservedAt > 0
    ? possibleMutationObservedAt
    : 0;
  const encodedToken = mutationSeparator > 0
      && possibleMutationObservedAt >= 0
    ? encodedIdentity.slice(mutationSeparator + 1)
    : encodedIdentity;
  let token = '';
  try {
    token = decodeURIComponent(encodedToken);
  } catch (_) {
    return null;
  }
  if (!(requestedAt > 0) || !token) return null;
  return Object.freeze({
    alarm,
    name,
    requestedAt,
    token,
    localMutationObservedAt
  });
}

async function getManualOffRetryAlarmIdentities() {
  const alarms = await chrome.alarms.getAll();
  return alarms
    .map(parseManualOffRetryAlarm)
    .filter(Boolean)
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

function isManualOffRetryIdentityReleasedByMarker(identity, marker) {
  if (!identity || marker?.state !== 'released') return false;
  const releasedTokens = new Set([
    String(marker.releasedToken || ''),
    ...(Array.isArray(marker.releasedTokens)
      ? marker.releasedTokens.map(value => String(value || ''))
      : [])
  ].filter(Boolean));
  if (releasedTokens.has(identity.token)) return true;
  if (Array.isArray(marker.releasedTokens)) return false;
  const releasedThroughRequestedAt = Object.prototype.hasOwnProperty.call(
    marker,
    'releasedThroughRequestedAt'
  )
    ? Number(marker.releasedThroughRequestedAt) || 0
    : Number(marker.releasedAt) || 0;
  return identity.requestedAt <= releasedThroughRequestedAt;
}

function classifyManualOffAdmissionCredentials(
  storedMarker,
  retryAlarmIdentities,
  intentEpochAtRead
) {
  const identities = Array.isArray(retryAlarmIdentities)
    ? retryAlarmIdentities
    : [];
  const releasedThroughRequestedAt = storedMarker?.state === 'released'
    ? (Object.prototype.hasOwnProperty.call(
        storedMarker,
        'releasedThroughRequestedAt'
      )
        ? Number(storedMarker.releasedThroughRequestedAt) || 0
        : Number(storedMarker.releasedAt) || 0)
    : 0;
  manualOffAdmissionReleasedThroughRequestedAt = Math.max(
    manualOffAdmissionReleasedThroughRequestedAt,
    releasedThroughRequestedAt
  );
  const liveRetryAlarmIdentities = identities.filter(identity => (
    !isManualOffRetryIdentityReleasedByMarker(identity, storedMarker)
  ));
  const inMemoryIdentity = manualOffAdmissionToken
    ? {
        token: manualOffAdmissionToken,
        requestedAt: Number(manualOffAdmissionRequestedAt) || 0
      }
    : null;
  const inMemoryPendingMarker = manualOffAutomaticOnBlocked
      && manualOffAdmissionToken
      && manualToggleIntentAction === 'off'
      && !isManualOffRetryIdentityReleasedByMarker(
        inMemoryIdentity,
        storedMarker
      )
    ? {
        schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
        state: 'pending',
        token: manualOffAdmissionToken,
        requestedAt: Number(manualOffAdmissionRequestedAt) || 0,
        localMutationObservedAt:
          Number(manualOffAdmissionLocalMutationObservedAt) || 0,
        localMutationPredecessorRetryAlarmNames:
          [...manualOffAdmissionPredecessorSuccessorRetryAlarmNames],
        localMutationPredecessorCoverageComplete:
          manualOffAdmissionMutationCoverageComplete,
        localMutationPredecessorSuccessorObservedAt:
          Number(manualOffAdmissionPredecessorSuccessorObservedAt) || 0,
        localMutationPredecessorSuccessorIdentity:
          String(manualOffAdmissionPredecessorSuccessorIdentity || '')
      }
    : null;
  const storedPendingAt = isPendingManualOffAdmissionValue(storedMarker)
    ? Number(storedMarker.requestedAt) || 0
    : 0;
  const inMemoryPendingAt = isPendingManualOffAdmissionValue(
    inMemoryPendingMarker
  )
    ? Number(inMemoryPendingMarker.requestedAt) || 0
    : 0;
  const baselineMarker = inMemoryPendingAt > storedPendingAt
    ? inMemoryPendingMarker
    : storedMarker;
  const baselinePendingAt = Math.max(
    storedPendingAt,
    inMemoryPendingAt
  );
  const latestRetryIdentity = liveRetryAlarmIdentities
    .filter(identity => identity.requestedAt > baselinePendingAt)
    .at(-1) || null;
  const recoveredMarker = latestRetryIdentity
    ? {
        schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
        state: 'pending',
        token: latestRetryIdentity.token,
        requestedAt: latestRetryIdentity.requestedAt,
        localMutationObservedAt:
          Number(latestRetryIdentity.localMutationObservedAt) || 0,
        localMutationPredecessorRetryAlarmNames: [],
        localMutationPredecessorCoverageComplete: false,
        localMutationPredecessorSuccessorObservedAt: 0,
        localMutationPredecessorSuccessorIdentity: ''
      }
    : baselineMarker;
  const recoveredPending = isPendingManualOffAdmissionValue(
    recoveredMarker
  );
  const predecessorIdentities = liveRetryAlarmIdentities.filter(identity => (
    !recoveredPending
    || identity.token !== recoveredMarker.token
    || identity.requestedAt !== Number(recoveredMarker.requestedAt)
  ));
  if (predecessorIdentities.length > 0) {
    manualOffAdmissionPredecessorRequestedAt = Math.max(
      manualOffAdmissionPredecessorRequestedAt,
      ...predecessorIdentities.map(identity => identity.requestedAt)
    );
    manualOffAdmissionPredecessorTokens = [...new Set([
      ...manualOffAdmissionPredecessorTokens,
      ...predecessorIdentities.map(identity => identity.token)
    ].filter(Boolean))];
  }
  manualOffAdmissionLoaded = true;

  if (intentEpochAtRead !== manualToggleIntentEpoch) {
    if (recoveredPending) {
      manualOffAdmissionPredecessorRequestedAt = Math.max(
        manualOffAdmissionPredecessorRequestedAt,
        Number(recoveredMarker.requestedAt) || 0
      );
      manualOffAdmissionPredecessorTokens = [...new Set([
        ...manualOffAdmissionPredecessorTokens,
        String(recoveredMarker.token || '')
      ].filter(Boolean))];
    }
    return Object.freeze({
      pending: false,
      superseded: true,
      marker: recoveredMarker
    });
  }

  const recoveredLocalMutationObservedAt = Number(
    recoveredMarker?.localMutationObservedAt
  ) || 0;
  if (recoveredPending
      && manualToggleIntentSource !== 'user'
      && localTerminalAuthorityCoversObservedAt(
        recoveredLocalMutationObservedAt
      )) {
    manualToggleIntentEpoch += 1;
    manualToggleIntentAction = completedLocalTerminalAuthority.action;
    manualToggleIntentSource = 'completed-recovery';
    manualToggleIntentCompletedEpoch = manualToggleIntentEpoch;
    manualToggleIntentCompletedAction = manualToggleIntentAction;
    manualOffAdmissionPredecessorRequestedAt = Math.max(
      manualOffAdmissionPredecessorRequestedAt,
      Number(recoveredMarker.requestedAt) || 0
    );
    manualOffAdmissionPredecessorTokens = [...new Set([
      ...manualOffAdmissionPredecessorTokens,
      String(recoveredMarker.token || '')
    ].filter(Boolean))];
    manualOffAutomaticOnBlocked = true;
    return Object.freeze({
      pending: false,
      superseded: true,
      completedUserAuthority: true,
      marker: recoveredMarker
    });
  }

  const recoveredMatchesCurrentUserOff = recoveredPending
    && manualToggleIntentSource === 'user'
    && manualToggleIntentAction === 'off'
    && manualOffAdmissionToken === String(recoveredMarker.token || '')
    && Number(manualOffAdmissionRequestedAt)
      === Number(recoveredMarker.requestedAt);
  if (recoveredPending
      && manualToggleIntentSource === 'user'
      && !recoveredMatchesCurrentUserOff) {
    // alarm delivery 不是新的用户意图。当前 SW 已同步 claim 过真实用户
    // ON/OFF/disable 时，任何此前未登记的 orphan credential 都只能作为
    // predecessor；若新 authority 失败，专用 reclaim 路径再恢复它。
    manualOffAdmissionPredecessorRequestedAt = Math.max(
      manualOffAdmissionPredecessorRequestedAt,
      Number(recoveredMarker.requestedAt) || 0
    );
    manualOffAdmissionPredecessorTokens = [...new Set([
      ...manualOffAdmissionPredecessorTokens,
      String(recoveredMarker.token || '')
    ].filter(Boolean))];
    // 持有准入直到当前 user authority 原子写 released tombstone；否则 ON
    // 可成功但 orphan alarm 仍存活，并在下次 SW 重启重新关机。
    manualOffAutomaticOnBlocked = true;
    const completedUserAuthority =
      manualToggleIntentCompletedEpoch === manualToggleIntentEpoch
      && manualToggleIntentCompletedAction === manualToggleIntentAction;
    return Object.freeze({
      pending: false,
      superseded: true,
      completedUserAuthority,
      marker: recoveredMarker
    });
  }

  if (recoveredMarker == null || recoveredMarker?.state === 'released') {
    manualOffAdmissionToken = '';
    manualOffAdmissionRequestedAt = 0;
    manualOffAdmissionRestoredFromStorage = false;
    manualOffAdmissionLocalMutationObservedAt = 0;
    manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
    manualOffAdmissionMutationCoverageComplete = false;
    manualOffAdmissionPredecessorSuccessorObservedAt = 0;
    manualOffAdmissionPredecessorSuccessorIdentity = '';
    manualOffAutomaticOnBlocked = false;
    return Object.freeze({
      pending: false,
      superseded: false,
      marker: recoveredMarker
    });
  }

  if (!recoveredPending) {
    manualOffAutomaticOnBlocked = true;
    return Object.freeze({
      pending: false,
      invalid: true,
      superseded: false,
      marker: recoveredMarker
    });
  }

  const recoveredToken = String(recoveredMarker.token || '');
  const recoveredRequestedAt = Number(recoveredMarker.requestedAt) || 0;
  if (manualOffAdmissionToken !== recoveredToken
      || manualOffAdmissionRequestedAt !== recoveredRequestedAt
      || manualToggleIntentAction !== 'off') {
    manualToggleIntentEpoch += 1;
    manualToggleIntentAction = 'off';
    manualToggleIntentSource = 'recovery';
  }
  manualOffAdmissionToken = recoveredToken;
  manualOffAdmissionRequestedAt = recoveredRequestedAt;
  manualOffAdmissionRestoredFromStorage = true;
  manualOffAdmissionLocalMutationObservedAt =
    Number(recoveredMarker.localMutationObservedAt) || 0;
  manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [...new Set(
    (Array.isArray(
      recoveredMarker.localMutationPredecessorRetryAlarmNames
    )
      ? recoveredMarker.localMutationPredecessorRetryAlarmNames
      : [])
      .map(value => String(value || ''))
      .filter(Boolean)
  )];
  manualOffAdmissionMutationCoverageComplete =
    recoveredMarker.localMutationPredecessorCoverageComplete === true;
  manualOffAdmissionPredecessorSuccessorObservedAt = Number(
    recoveredMarker.localMutationPredecessorSuccessorObservedAt
  ) || 0;
  manualOffAdmissionPredecessorSuccessorIdentity = String(
    recoveredMarker.localMutationPredecessorSuccessorIdentity || ''
  );
  manualOffAutomaticOnBlocked = true;
  return Object.freeze({
    pending: true,
    superseded: false,
    marker: recoveredMarker
  });
}

async function refreshManualOffAdmissionFromDurableCredentials() {
  const startupClassificationAtRead =
    startupManualOffClassificationPending;
  const intentEpochAtRead = startupClassificationAtRead
    ? startupManualOffClassificationIntentEpoch
    : manualToggleIntentEpoch;
  try {
    return await runSerializedManualOffAdmissionWrite(() => (
      runSerializedCriticalLocalStateWrite(async () => {
        // marker/alarm 的读取也必须在 canonical manual->critical FIFO 内。
        // 否则 release 可夹在锁外快照与 apply 之间，旧 pending 会复活。
        await waitForManualOffRetryAlarmOperationsToSettle();
        const [stored, retryAlarmIdentities] = await Promise.all([
          chrome.storage.local.get([
            MANUAL_OFF_ADMISSION_KEY,
            LOCAL_TERMINAL_AUTHORITY_KEY
          ]),
          getManualOffRetryAlarmIdentities()
        ]);
        adoptLocalTerminalAuthority(
          stored?.[LOCAL_TERMINAL_AUTHORITY_KEY]
        );
        const classification = classifyManualOffAdmissionCredentials(
          stored?.[MANUAL_OFF_ADMISSION_KEY],
          retryAlarmIdentities,
          intentEpochAtRead
        );
        if (startupClassificationAtRead
            && startupManualOffClassificationPending
            && startupManualOffClassificationIntentEpoch
              === intentEpochAtRead) {
          startupManualOffClassificationPending = false;
          startupManualOffClassificationIntentEpoch = 0;
        }
        return classification;
      })
    ));
  } catch (error) {
    manualOffAdmissionLoaded = true;
    manualOffAutomaticOnBlocked = true;
    // marker-only OFF 可能没有 immutable retry alarm；用旧固定名只做
    // reclassification wakeup，不把 scheduledTime 当 authority。
    void Promise.resolve(chrome.alarms.create(
      MANUAL_OFF_ADMISSION_RETRY_ALARM,
      { delayInMinutes: 1, periodInMinutes: 1 }
    )).catch(() => {});
    console.warn('[AC扩展] fresh manual-OFF credential 分类失败:', error?.message);
    void appendDiagnosticLog(
      'warn',
      'manual-off-admission-reclassify',
      error
    );
    return Object.freeze({
      pending: false,
      uncertain: true,
      superseded: false,
      marker: null
    });
  }
}

async function clearManualOffRetryAlarmsThrough(requestedAt) {
  const through = Number(requestedAt) || 0;
  const identities = await getManualOffRetryAlarmIdentities();
  const names = identities
    .filter(identity => identity.requestedAt <= through)
    .map(identity => identity.name);
  // 清理开发中旧固定名 alarm；它没有不可变 generation，released tombstone
  // 后只能视为 stale，绝不能再从滚动 scheduledTime 反推出 pending。
  const legacy = await chrome.alarms.get(MANUAL_OFF_ADMISSION_RETRY_ALARM);
  if (legacy) names.push(MANUAL_OFF_ADMISSION_RETRY_ALARM);
  await Promise.all(names.map(name => chrome.alarms.clear(name)));
  return true;
}

function createSyncAuthorityAlarmOrderToken(
  authorityOrderObservedAt,
  authorityPreBaselineSequence = 0
) {
  const order = Math.max(
    1,
    Math.trunc(Number(authorityOrderObservedAt) || Date.now())
  );
  const sequence = Math.max(
    0,
    Math.trunc(Number(authorityPreBaselineSequence) || 0)
  );
  return `a${order}.${sequence}`;
}

function parseSyncAuthorityAlarmOrderToken(value) {
  const match = String(value || '').match(/^a(\d+)\.(\d+)$/);
  if (!match) return null;
  const authorityOrderObservedAt = Number(match[1]) || 0;
  const authorityPreBaselineSequence = Number(match[2]) || 0;
  if (!(authorityOrderObservedAt > 0)) return null;
  return Object.freeze({
    authorityOrderObservedAt,
    authorityPreBaselineSequence
  });
}

function createDeferredSyncDisableRetryAlarmName(
  receivedAt = Date.now(),
  remote = deferredSyncDisableRemoteSnapshot,
  safetyAuthorityId = deferredSyncDisableSafetyAuthorityId,
  authorityOrderObservedAt = receivedAt,
  authorityPreBaselineSequence = 0
) {
  const compactRemote = remote?.enabled === false
    ? compactDeferredSyncSuccessorPayload({ ...remote, enabled: true })
    : null;
  const encodedRemote = compactRemote
    ? encodeURIComponent(JSON.stringify(compactRemote))
    : '';
  const base = [
    DEFERRED_SYNC_DISABLE_RETRY_ALARM,
    Math.max(1, Math.trunc(Number(receivedAt) || Date.now())),
    Math.random().toString(36).slice(2),
    createSyncAuthorityAlarmOrderToken(
      authorityOrderObservedAt,
      authorityPreBaselineSequence
    )
  ];
  const normalizedSafetyAuthorityId =
    normalizeDeferredSyncDisableSafetyAuthorityId(safetyAuthorityId);
  return normalizedSafetyAuthorityId
    ? [
        ...base,
        encodeURIComponent(normalizedSafetyAuthorityId),
        encodedRemote
      ].join(':')
    : [...base, encodedRemote].join(':');
}

function parseDeferredSyncDisableRetryAlarm(alarm) {
  const name = String(alarm?.name || '');
  const prefix = `${DEFERRED_SYNC_DISABLE_RETRY_ALARM}:`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(':');
  if (parts.length < 3 || parts.length > 5) return null;
  const [receivedAtText, token = ''] = parts;
  let metadataIndex = 2;
  const authorityOrder = parseSyncAuthorityAlarmOrderToken(
    parts[metadataIndex]
  );
  if (authorityOrder) metadataIndex += 1;
  const remainingParts = parts.length - metadataIndex;
  if (remainingParts !== 1 && remainingParts !== 2) return null;
  const encodedSafetyAuthorityId = remainingParts === 2
    ? parts[metadataIndex]
    : '';
  const encodedRemote = parts.at(-1) || '';
  const receivedAt = Number(receivedAtText) || 0;
  if (!(receivedAt > 0) || !token) return null;
  let safetyAuthorityId = '';
  if (encodedSafetyAuthorityId) {
    try {
      safetyAuthorityId = normalizeDeferredSyncDisableSafetyAuthorityId(
        decodeURIComponent(encodedSafetyAuthorityId)
      );
    } catch (_) {
      return null;
    }
    if (!safetyAuthorityId) return null;
  }
  let remote = null;
  if (encodedRemote) {
    try {
      const expanded = expandDeferredSyncSuccessorPayload(
        JSON.parse(decodeURIComponent(encodedRemote))
      );
      if (expanded) remote = { ...expanded, enabled: false };
    } catch (_) { /* legacy / corrupt credential stays safety-only */ }
  }
  return Object.freeze({
    alarm,
    name,
    receivedAt,
    token,
    remote,
    safetyAuthorityId,
    authorityOrderObservedAt:
      authorityOrder?.authorityOrderObservedAt || receivedAt,
    authorityPreBaselineSequence:
      authorityOrder?.authorityPreBaselineSequence || 0
  });
}

function deferredSyncDisableRetryIdentityMatchesDurableAuthority(
  identity,
  durableRecord
) {
  if (!identity
      || durableRecord?.pending !== true
      || !(Number(durableRecord?.authorityOrderObservedAt) > 0)) {
    return false;
  }
  const primaryRetryAlarmName = String(
    durableRecord?.retryAlarmName || ''
  );
  if (primaryRetryAlarmName) {
    return identity.name === primaryRetryAlarmName;
  }
  // 旧 schema 没有 primary name 时，只接受 safety lineage + raw + payload
  // 三者完全相同的 alarm。仅 raw/payload 可能在 ABA 后误绑另一轮 F。
  const durableSafetyAuthorityId =
    normalizeDeferredSyncDisableSafetyAuthorityId(
      durableRecord?.safetyAuthorityId
    );
  return !!durableSafetyAuthorityId
    && identity.safetyAuthorityId === durableSafetyAuthorityId
    && Number(identity.receivedAt) === Number(durableRecord?.receivedAt)
    && getSyncPayloadIdentity(identity.remote)
      === getSyncPayloadIdentity(durableRecord?.remote);
}

function canonicalizeDeferredSyncDisableRetryAuthority(
  identity,
  durableRecord
) {
  if (!deferredSyncDisableRetryIdentityMatchesDurableAuthority(
    identity,
    durableRecord
  )) {
    return { ...identity, sourceKind: 'alarm' };
  }
  // alarm name/raw 是 immutable credential；排序时只替换已经由 durable
  // mailbox 消费过的 logical tuple，绝不把旧 preseq 再注入。
  return {
    ...identity,
    sourceKind: 'durable-alarm',
    safetyAuthorityId:
      normalizeDeferredSyncDisableSafetyAuthorityId(
        identity.safetyAuthorityId
      ) || normalizeDeferredSyncDisableSafetyAuthorityId(
        durableRecord.safetyAuthorityId
      ),
    authorityOrderObservedAt:
      Number(durableRecord.authorityOrderObservedAt)
      || Number(durableRecord.receivedAt)
      || Number(identity.receivedAt)
      || 0,
    authorityPreBaselineSequence:
      Number(durableRecord.authorityPreBaselineSequence) || 0
  };
}

function selectLatestDeferredSyncDisableCredential({
  durableRecord = null,
  memoryCredential = null,
  retryAlarmIdentities = []
} = {}) {
  const candidates = [];
  let durableCandidate = null;
  if (durableRecord?.pending === true) {
    durableCandidate = {
      sourceKind: 'durable',
      name: String(durableRecord?.retryAlarmName || ''),
      receivedAt: Number(durableRecord?.receivedAt) || 0,
      authorityOrderObservedAt:
        Number(durableRecord?.authorityOrderObservedAt)
        || Number(durableRecord?.receivedAt)
        || 0,
      authorityPreBaselineSequence:
        Number(durableRecord?.authorityPreBaselineSequence) || 0,
      safetyAuthorityId:
        normalizeDeferredSyncDisableSafetyAuthorityId(
          durableRecord?.safetyAuthorityId
        ),
      remote: durableRecord?.remote
          && typeof durableRecord.remote === 'object'
          && durableRecord.remote.enabled === false
        ? { ...durableRecord.remote, enabled: false }
        : null
    };
    candidates.push(durableCandidate);
  }
  if (memoryCredential && typeof memoryCredential === 'object') {
    candidates.push({
      ...memoryCredential,
      sourceKind: 'memory',
      remote: memoryCredential.remote
          && typeof memoryCredential.remote === 'object'
          && memoryCredential.remote.enabled === false
        ? { ...memoryCredential.remote, enabled: false }
        : null
    });
  }
  for (const identity of Array.isArray(retryAlarmIdentities)
    ? retryAlarmIdentities
    : []) {
    candidates.push(
      canonicalizeDeferredSyncDisableRetryAuthority(
        identity,
        durableRecord
      )
    );
  }

  let credential = null;
  let conflictingLatestAuthority = false;
  for (const candidate of candidates) {
    if (!credential) {
      credential = candidate;
      continue;
    }
    const comparison = compareSyncAuthorityOrderTuples(
      candidate,
      credential
    );
    if (comparison > 0) {
      credential = candidate;
      conflictingLatestAuthority = false;
      continue;
    }
    if (comparison < 0) continue;
    const candidateIdentity = getSyncPayloadIdentity(candidate.remote);
    const currentIdentity = getSyncPayloadIdentity(credential.remote);
    const candidateSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        candidate.safetyAuthorityId
      );
    const currentSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        credential.safetyAuthorityId
      );
    if ((candidateIdentity && currentIdentity
          && candidateIdentity !== currentIdentity)
        || (candidateSafetyAuthorityId && currentSafetyAuthorityId
          && candidateSafetyAuthorityId !== currentSafetyAuthorityId)) {
      conflictingLatestAuthority = true;
      continue;
    }
    // 同一 durable credential 的 legacy record 可能缺 compact payload；
    // exact alarm 可以补全它，但不同 authority 绝不按 syncedAt 拼接。
    if (!currentIdentity && candidateIdentity) credential = candidate;
  }

  const remote = credential?.remote
      && typeof credential.remote === 'object'
      && credential.remote.enabled === false
    ? { ...credential.remote, enabled: false }
    : null;
  const remoteIdentity = getSyncPayloadIdentity(remote);
  const durableRemoteIdentity = getSyncPayloadIdentity(
    durableCandidate?.remote
  );
  const durableCoversAllKnownAuthorities = !!durableCandidate
    && !!durableRemoteIdentity
    && durableRemoteIdentity === remoteIdentity
    && !conflictingLatestAuthority
    && candidates.every(candidate => (
      compareSyncAuthorityOrderTuples(candidate, durableCandidate) <= 0
    ));
  return Object.freeze({
    credential: credential ? Object.freeze({ ...credential }) : null,
    remote,
    complete: !!remote && !conflictingLatestAuthority,
    // 保留旧字段名，调用方契约不变；含义已提升为“durable 是最新完整
    // authority”，不再用 syncedAt 最大值替代本机 arrival ordering。
    durableCoversAllKnownWatermarks:
      durableCoversAllKnownAuthorities
  });
}

async function getDeferredSyncDisableRetryAlarmIdentities() {
  const alarms = await chrome.alarms.getAll();
  return alarms
    .map(parseDeferredSyncDisableRetryAlarm)
    .filter(Boolean)
    .sort(compareSyncAuthorityOrderTuples);
}

function trackDeferredSyncDisableRetryAlarmOperation(promise) {
  const tracked = Promise.resolve(promise);
  deferredSyncDisableRetryAlarmOperationsInFlight.add(tracked);
  void tracked.finally(() => {
    deferredSyncDisableRetryAlarmOperationsInFlight.delete(tracked);
  }).catch(() => {});
  return tracked;
}

async function waitForDeferredSyncDisableRetryAlarmOperationsToSettle() {
  while (deferredSyncDisableRetryAlarmOperationsInFlight.size > 0) {
    await Promise.allSettled([
      ...deferredSyncDisableRetryAlarmOperationsInFlight
    ]);
  }
}

async function clearDeferredSyncDisableRetryAlarms(
  names,
  { preserveReleasedNames = false } = {}
) {
  const uniqueNames = [...new Set(
    (Array.isArray(names) ? names : [])
      .map(value => String(value || ''))
      .filter(Boolean)
  )];
  await Promise.all(uniqueNames.map(name => chrome.alarms.clear(name)));
  for (const name of uniqueNames) {
    deferredSyncDisableRetryAlarmNames.delete(name);
    if (!preserveReleasedNames) {
      deferredSyncDisableReleasedRetryAlarmNames.delete(name);
    }
  }
  return true;
}

function compactDeferredSyncSuccessorPayload(remote) {
  if (!remote || typeof remote !== 'object' || remote.enabled !== true) {
    return null;
  }
  const has = key => Object.prototype.hasOwnProperty.call(remote, key);
  const activeHours = remote?.activeHours || {};
  const smartMode = remote?.smartMode || {};
  const hasOnMinutes = has('onMinutes');
  const hasOffMinutes = has('offMinutes');
  const hasActiveHours = has('activeHours');
  const hasSmartMode = has('smartMode');
  const hasPwmState = has('pwmState');
  const hasNextTriggerAt = has('nextTriggerAt');
  const hasSmartClockPlannedAt = has('smartClockPlannedAt');
  const hasSyncedAt = has('syncedAt');
  if ((hasOnMinutes
        && (typeof remote.onMinutes !== 'number'
          || !Number.isFinite(remote.onMinutes)))
      || (hasOffMinutes
        && (typeof remote.offMinutes !== 'number'
          || !Number.isFinite(remote.offMinutes)))
      || (hasActiveHours
        && (!remote.activeHours
          || typeof remote.activeHours !== 'object'
          || typeof activeHours.enabled !== 'boolean'
          || typeof activeHours.start !== 'string'
          || typeof activeHours.end !== 'string'
          || activeHours.start.length > 8
          || activeHours.end.length > 8))
      || (hasSmartMode
        && (!remote.smartMode
          || typeof remote.smartMode !== 'object'
          || typeof smartMode.enabled !== 'boolean'
          || typeof smartMode.sensitivity !== 'number'
          || !Number.isFinite(smartMode.sensitivity)))
      || (hasPwmState
        && remote.pwmState !== 'on'
        && remote.pwmState !== 'off')
      || (hasNextTriggerAt
        && (typeof remote.nextTriggerAt !== 'number'
          || !Number.isFinite(remote.nextTriggerAt)))
      || (hasSmartClockPlannedAt
        && (typeof remote.smartClockPlannedAt !== 'number'
          || !Number.isFinite(remote.smartClockPlannedAt)))
      || (hasSyncedAt
        && (typeof remote.syncedAt !== 'number'
          || !Number.isFinite(remote.syncedAt)))) {
    return null;
  }
  const presenceMask =
    (hasOnMinutes ? 1 : 0)
    | (hasOffMinutes ? 2 : 0)
    | (hasActiveHours ? 4 : 0)
    | (hasSmartMode ? 8 : 0)
    | (hasPwmState ? 16 : 0)
    | (hasNextTriggerAt ? 32 : 0)
    | (hasSmartClockPlannedAt ? 64 : 0)
    | (hasSyncedAt ? 128 : 0);
  return [
    1,
    presenceMask,
    hasOnMinutes ? remote.onMinutes : null,
    hasOffMinutes ? remote.offMinutes : null,
    hasActiveHours && activeHours.enabled === true ? 1 : 0,
    hasActiveHours ? activeHours.start : '',
    hasActiveHours ? activeHours.end : '',
    hasSmartMode && smartMode.enabled === true ? 1 : 0,
    hasSmartMode ? smartMode.sensitivity : null,
    hasPwmState && remote.pwmState === 'on' ? 1 : 0,
    hasNextTriggerAt ? remote.nextTriggerAt : null,
    hasSmartClockPlannedAt ? remote.smartClockPlannedAt : null,
    hasSyncedAt ? remote.syncedAt : null
  ];
}

function normalizeDeferredSyncDisableSafetyAuthorityId(value) {
  const normalized = String(value || '');
  return /^[A-Za-z0-9._-]{1,96}$/.test(normalized)
    ? normalized
    : '';
}

function createDeferredSyncDisableSafetyAuthorityId() {
  return [
    'f',
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2)
  ].join('-').slice(0, 96);
}

function expandDeferredSyncSuccessorPayload(compact) {
  if (!Array.isArray(compact)
      || compact.length !== 13
      || compact[0] !== 1
      || !Number.isSafeInteger(compact[1])
      || compact[1] < 0
      || compact[1] > 255) return null;
  const presenceMask = compact[1];
  const isFiniteNumber = index => (
    typeof compact[index] === 'number'
    && Number.isFinite(compact[index])
  );
  const isBit = index => compact[index] === 0 || compact[index] === 1;
  if ((presenceMask & 1 && !isFiniteNumber(2))
      || (presenceMask & 2 && !isFiniteNumber(3))
      || (presenceMask & 4
        && (!isBit(4)
          || typeof compact[5] !== 'string'
          || typeof compact[6] !== 'string'
          || compact[5].length > 8
          || compact[6].length > 8))
      || (presenceMask & 8
        && (!isBit(7) || !isFiniteNumber(8)))
      || (presenceMask & 16 && !isBit(9))
      || (presenceMask & 32 && !isFiniteNumber(10))
      || (presenceMask & 64 && !isFiniteNumber(11))
      || (presenceMask & 128 && !isFiniteNumber(12))) {
    return null;
  }
  return {
    enabled: true,
    ...(presenceMask & 1 ? { onMinutes: compact[2] } : {}),
    ...(presenceMask & 2 ? { offMinutes: compact[3] } : {}),
    ...(presenceMask & 4
      ? {
          activeHours: {
            enabled: compact[4] === 1,
            start: compact[5],
            end: compact[6]
          }
        }
      : {}),
    ...(presenceMask & 8
      ? {
          smartMode: {
            enabled: compact[7] === 1,
            sensitivity: compact[8]
          }
        }
      : {}),
    ...(presenceMask & 16
      ? { pwmState: compact[9] === 1 ? 'on' : 'off' }
      : {}),
    ...(presenceMask & 32 ? { nextTriggerAt: compact[10] } : {}),
    ...(presenceMask & 64
      ? { smartClockPlannedAt: compact[11] }
      : {}),
    ...(presenceMask & 128 ? { syncedAt: compact[12] } : {})
  };
}

function createDeferredSyncSuccessorRetryAlarmName(
  remote,
  observedAt,
  predecessorSafetyAuthorityId = '',
  authorityOrderObservedAt = observedAt,
  authorityPreBaselineSequence = 0
) {
  const compact = compactDeferredSyncSuccessorPayload(remote);
  if (!compact) return '';
  const payload = encodeURIComponent(JSON.stringify(compact));
  const base = [
    DEFERRED_SYNC_SUCCESSOR_RETRY_ALARM,
    Math.max(1, Math.trunc(Number(observedAt) || Date.now())),
    Math.random().toString(36).slice(2),
    createSyncAuthorityAlarmOrderToken(
      authorityOrderObservedAt,
      authorityPreBaselineSequence
    )
  ];
  const safetyAuthorityId =
    normalizeDeferredSyncDisableSafetyAuthorityId(
      predecessorSafetyAuthorityId
    );
  return safetyAuthorityId
    ? [...base, encodeURIComponent(safetyAuthorityId), payload].join(':')
    : [...base, payload].join(':');
}

function parseDeferredSyncSuccessorRetryAlarm(alarm) {
  const name = String(alarm?.name || '');
  const prefix = `${DEFERRED_SYNC_SUCCESSOR_RETRY_ALARM}:`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(':');
  if (parts.length < 3 || parts.length > 5) return null;
  const [observedAtText, token = ''] = parts;
  let metadataIndex = 2;
  const authorityOrder = parseSyncAuthorityAlarmOrderToken(
    parts[metadataIndex]
  );
  if (authorityOrder) metadataIndex += 1;
  const remainingParts = parts.length - metadataIndex;
  if (remainingParts !== 1 && remainingParts !== 2) return null;
  const encodedSafetyAuthorityId = remainingParts === 2
    ? parts[metadataIndex]
    : '';
  const encodedPayload = parts.at(-1) || '';
  const observedAt = Number(observedAtText) || 0;
  if (!(observedAt > 0) || !token || !encodedPayload) return null;
  try {
    const predecessorSafetyAuthorityId = encodedSafetyAuthorityId
      ? normalizeDeferredSyncDisableSafetyAuthorityId(
          decodeURIComponent(encodedSafetyAuthorityId)
        )
      : '';
    if (encodedSafetyAuthorityId && !predecessorSafetyAuthorityId) {
      return null;
    }
    const remote = expandDeferredSyncSuccessorPayload(
      JSON.parse(decodeURIComponent(encodedPayload))
    );
    if (!remote) return null;
    return Object.freeze({
      alarm,
      name,
      observedAt,
      token,
      remote,
      predecessorSafetyAuthorityId,
      authorityOrderObservedAt:
        authorityOrder?.authorityOrderObservedAt || observedAt,
      authorityPreBaselineSequence:
        authorityOrder?.authorityPreBaselineSequence || 0
    });
  } catch (_) {
    return null;
  }
}

async function getDeferredSyncSuccessorRetryAlarmIdentities() {
  const alarms = await chrome.alarms.getAll();
  return alarms
    .map(parseDeferredSyncSuccessorRetryAlarm)
    .filter(Boolean)
    .sort(compareSyncAuthorityOrderTuples);
}

function createDeferredSyncSuccessorClassificationWake(
  identity,
  reason = 'unknown T lineage'
) {
  if (!identity?.name) return Promise.resolve(false);
  const stableAlarm = {
    name: identity.name,
    // periodic T 的 live scheduledTime 每分钟前进，不能进入 dedupe key；
    // exact T name + immutable observedAt 已足以唯一标识 classification owner。
    scheduledTime: (Number(identity.observedAt) || Date.now()) + 60_000,
    periodInMinutes: 0
  };
  return createScheduleReadRetryWake(
    stableAlarm,
    reason,
    { identityToken: 'successor-lineage' }
  );
}

function getDeferredSyncSuccessorClassificationWakeName(name) {
  const identity = parseDeferredSyncSuccessorRetryAlarm({
    name: String(name || '')
  });
  if (!identity) return '';
  return createScheduleReadRetryAlarmName({
    name: identity.name,
    scheduledTime: identity.observedAt + 60_000,
    periodInMinutes: 0
  }, 'successor-lineage');
}

function trackDeferredSyncSuccessorRetryAlarmOperation(promise) {
  const tracked = Promise.resolve(promise);
  deferredSyncSuccessorRetryAlarmOperationsInFlight.add(tracked);
  void tracked.finally(() => {
    deferredSyncSuccessorRetryAlarmOperationsInFlight.delete(tracked);
  }).catch(() => {});
  return tracked;
}

async function waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle() {
  while (deferredSyncSuccessorRetryAlarmOperationsInFlight.size > 0) {
    await Promise.allSettled([
      ...deferredSyncSuccessorRetryAlarmOperationsInFlight
    ]);
  }
}

async function clearDeferredSyncSuccessorRetryAlarms(
  names,
  { preserveReleasedNames = false } = {}
) {
  const uniqueNames = [...new Set(
    (Array.isArray(names) ? names : [])
      .map(value => String(value || ''))
      .filter(Boolean)
  )];
  await Promise.all(uniqueNames.flatMap(name => {
    const classificationWakeName =
      getDeferredSyncSuccessorClassificationWakeName(name);
    return [
      chrome.alarms.clear(name),
      ...(classificationWakeName
        ? [chrome.alarms.clear(classificationWakeName)]
        : [])
    ];
  }));
  for (const name of uniqueNames) {
    deferredSyncSuccessorRetryAlarmEntries.delete(name);
    if (!preserveReleasedNames) {
      deferredSyncSuccessorReleasedRetryAlarmNames.delete(name);
    }
  }
  return true;
}

async function captureDeferredSyncSuccessorRetryAlarmsThrough(
  authorityOrderObservedAt,
  {
    includeUnknown = false,
    authorityPreBaselineSequence = 0
  } = {}
) {
  const through = Math.max(0, Number(authorityOrderObservedAt) || 0);
  if (through <= 0) return [];
  const cutoffTuple = {
    authorityOrderObservedAt: through,
    authorityPreBaselineSequence
  };
  await waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle();
  const identities = await getDeferredSyncSuccessorRetryAlarmIdentities();
  return [...new Set([
    ...[...deferredSyncSuccessorRetryAlarmEntries.entries()]
      .filter(([, entry]) => (
        !(deferredSyncDisableSafetyAuthorityId
          && entry?.predecessorSafetyAuthorityId
            === deferredSyncDisableSafetyAuthorityId)
        && isSyncAuthorityOrderTupleAtOrBefore(entry, cutoffTuple)
      ))
      .map(([name]) => name),
    ...identities
      .filter(identity => (
        !(deferredSyncDisableSafetyAuthorityId
          && identity.predecessorSafetyAuthorityId
            === deferredSyncDisableSafetyAuthorityId)
        && ((includeUnknown
            && !deferredSyncSuccessorRetryAlarmEntries.has(identity.name))
          || isSyncAuthorityOrderTupleAtOrBefore(
            deferredSyncSuccessorRetryAlarmEntries.get(identity.name)
              || identity,
            cutoffTuple
          ))
      ))
      .map(identity => identity.name)
  ])];
}

async function captureDeferredSyncSuccessorRetryAlarmsBeforeLocalMutation(
  mutationGeneration,
  cutoffObservedAt
) {
  const generation = Number(mutationGeneration) || 0;
  const cutoff = Math.max(0, Number(cutoffObservedAt) || 0);
  if (generation <= 0 || cutoff <= 0) return [];
  await waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle();
  const identities = await getDeferredSyncSuccessorRetryAlarmIdentities();
  const cutoffTuple = {
    authorityOrderObservedAt: cutoff,
    authorityPreBaselineSequence:
      getSyncAuthorityPreBaselineSequence(cutoff)
  };
  return [...new Set([
    ...[...deferredSyncSuccessorRetryAlarmEntries.entries()]
      .filter(([, entry]) => (
        Number(entry?.scheduleMutationGeneration) !== generation
        || isSyncAuthorityOrderTupleAtOrBefore(entry, cutoffTuple)
      ))
      .map(([name]) => name),
    // init 的 getAll 失败时，旧 SW 留下的 future-clock T 不在 map，单靠
    // 数字 cutoff 无法判断先后。M 提交必须把所有未知 exact identity 一并
    // durable；同 SW 在 M 后到达的 T 会先登记当前 generation，因而保留。
    ...identities
      .filter(identity => (
        !deferredSyncSuccessorRetryAlarmEntries.has(identity.name)
      ))
      .map(identity => identity.name)
  ])];
}

async function captureAllDeferredSyncSuccessorRetryAlarmNames() {
  await waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle();
  const identities = await getDeferredSyncSuccessorRetryAlarmIdentities();
  return [...new Set([
    ...deferredSyncSuccessorRetryAlarmEntries.keys(),
    ...identities.map(identity => identity.name)
  ])];
}

function snapshotCurrentDeferredSyncSuccessorPredecessor({
  retryAlarmNames = null,
  mutationGeneration = 0,
  cutoffObservedAt = 0
} = {}) {
  if (!deferredSyncDisableSuccessorSnapshot) return null;
  const observedAt = Number(deferredSyncDisableSuccessorObservedAt) || 0;
  const authorityOrderObservedAt = Number(
    deferredSyncDisableSuccessorAuthorityOrderObservedAt
  ) || observedAt;
  const identity = getSyncPayloadIdentity(
    deferredSyncDisableSuccessorSnapshot
  );
  if (!identity || observedAt <= 0) return null;
  let exactCredentialCaptured = false;
  if (Array.isArray(retryAlarmNames)) {
    const capturedNames = new Set(retryAlarmNames);
    exactCredentialCaptured =
      [...deferredSyncSuccessorRetryAlarmEntries.entries()]
      .some(([name, entry]) => (
        capturedNames.has(name)
        && Number(entry?.observedAt) === observedAt
        && getSyncPayloadIdentity(entry?.remote) === identity
      ));
  }
  const generation = Number(mutationGeneration) || 0;
  const cutoff = Number(cutoffObservedAt) || 0;
  const mutationPredecessor = generation > 0
    && (deferredSyncDisableSuccessorMutationGeneration !== generation
      || isSyncAuthorityOrderTupleAtOrBefore({
        observedAt,
        authorityOrderObservedAt,
        authorityPreBaselineSequence:
          deferredSyncDisableSuccessorAuthorityPreBaselineSequence
      }, {
        authorityOrderObservedAt: cutoff,
        authorityPreBaselineSequence:
          getSyncAuthorityPreBaselineSequence(cutoff)
      }));
  const isPredecessor = exactCredentialCaptured || mutationPredecessor;
  return isPredecessor
    ? Object.freeze({
        observedAt,
        identity,
        retryAlarmName:
          deferredSyncDisableSuccessorRetryAlarmName
      })
    : null;
}

function isCurrentDeferredSyncSuccessorReceipt(receipt) {
  return !!receipt
    && Number(deferredSyncDisableSuccessorObservedAt)
      === Number(receipt.observedAt)
    && getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
      === receipt.identity
    && (!Object.prototype.hasOwnProperty.call(
      receipt,
      'retryAlarmName'
    ) || String(deferredSyncDisableSuccessorRetryAlarmName || '')
      === String(receipt.retryAlarmName || ''));
}

function omitCapturedDeferredSyncSuccessor(record, receipt) {
  if (!record || typeof record !== 'object' || !receipt) return record;
  const recordObservedAt = Number(record?.successor?.observedAt) || 0;
  const recordIdentity = getSyncPayloadIdentity(record?.successor?.remote);
  if (recordObservedAt !== Number(receipt.observedAt)
      || recordIdentity !== receipt.identity) {
    return record;
  }
  const sanitized = { ...record };
  delete sanitized.successor;
  return sanitized;
}

function discardCapturedDeferredSyncSuccessorInMemory(receipt) {
  if (!isCurrentDeferredSyncSuccessorReceipt(receipt)) return false;
  deferredSyncDisableSuccessorSnapshot = null;
  deferredSyncDisableSuccessorObservedAt = 0;
  deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
  deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
  deferredSyncDisableSuccessorRetryAlarmName = '';
  deferredSyncDisableSuccessorLocalAuthorityGeneration = 0;
  deferredSyncDisableSuccessorMutationGeneration = 0;
  return true;
}

function nextSyncAuthorityObservedAt() {
  const observedAt = Math.max(
    Date.now(),
    remoteSyncAuthorityObservedAt + 1
  );
  remoteSyncAuthorityObservedAt = observedAt;
  if (!syncAuthorityDurableBaselineLoaded) {
    syncAuthorityPreBaselineSequence += 1;
    syncAuthorityPreBaselineSequenceByObservedAt.set(
      observedAt,
      syncAuthorityPreBaselineSequence
    );
  }
  return observedAt;
}

function getSyncAuthorityPreBaselineSequence(observedAt) {
  return Number(
    syncAuthorityPreBaselineSequenceByObservedAt.get(Number(observedAt))
  ) || 0;
}

function normalizeSyncAuthorityOrderTuple({
  observedAt = 0,
  authorityOrderObservedAt = observedAt,
  authorityPreBaselineSequence = 0
} = {}) {
  const rawObservedAt = Math.max(0, Number(observedAt) || 0);
  return Object.freeze({
    observedAt: rawObservedAt,
    authorityOrderObservedAt: Math.max(
      rawObservedAt,
      Number(authorityOrderObservedAt) || 0
    ),
    authorityPreBaselineSequence: Math.max(
      0,
      Math.trunc(Number(authorityPreBaselineSequence) || 0)
    )
  });
}

function isSyncAuthorityOrderTupleAtOrBefore(candidate, cutoff) {
  const candidateTuple = normalizeSyncAuthorityOrderTuple(candidate);
  const cutoffTuple = normalizeSyncAuthorityOrderTuple(cutoff);
  if (candidateTuple.authorityPreBaselineSequence > 0
      && cutoffTuple.authorityPreBaselineSequence > 0) {
    return candidateTuple.authorityPreBaselineSequence
      <= cutoffTuple.authorityPreBaselineSequence;
  }
  if (candidateTuple.authorityPreBaselineSequence > 0) {
    // 当前 SW 在 durable cutoff 读取前新分配的 sequence，一定发生在该
    // durable authority 之后；墙钟 raw 小于 future cutoff 也不能反转。
    return false;
  }
  if (cutoffTuple.authorityPreBaselineSequence > 0) {
    return true;
  }
  return candidateTuple.authorityOrderObservedAt
    <= cutoffTuple.authorityOrderObservedAt;
}

function isSyncAuthorityOrderTupleBefore(candidate, cutoff) {
  const candidateTuple = normalizeSyncAuthorityOrderTuple(candidate);
  const cutoffTuple = normalizeSyncAuthorityOrderTuple(cutoff);
  if (candidateTuple.authorityPreBaselineSequence > 0
      && cutoffTuple.authorityPreBaselineSequence > 0) {
    return candidateTuple.authorityPreBaselineSequence
      < cutoffTuple.authorityPreBaselineSequence;
  }
  if (candidateTuple.authorityPreBaselineSequence > 0) return false;
  if (cutoffTuple.authorityPreBaselineSequence > 0) return true;
  return candidateTuple.authorityOrderObservedAt
    < cutoffTuple.authorityOrderObservedAt;
}

function compareSyncAuthorityOrderTuples(left, right) {
  const leftTuple = normalizeSyncAuthorityOrderTuple(left);
  const rightTuple = normalizeSyncAuthorityOrderTuple(right);
  const leftSequence = leftTuple.authorityPreBaselineSequence;
  const rightSequence = rightTuple.authorityPreBaselineSequence;
  if (leftSequence > 0 && rightSequence > 0) {
    return leftSequence - rightSequence;
  }
  if (leftSequence > 0) return 1;
  if (rightSequence > 0) return -1;
  return leftTuple.authorityOrderObservedAt
    - rightTuple.authorityOrderObservedAt;
}

function rebaseSyncAuthorityOrderTuple(tuple, durableBaseline) {
  const normalized = normalizeSyncAuthorityOrderTuple(tuple);
  return Object.freeze({
    observedAt: normalized.observedAt,
    authorityOrderObservedAt:
      normalized.authorityPreBaselineSequence > 0
        ? Math.max(
            normalized.authorityOrderObservedAt,
            (Number(durableBaseline) || 0)
              + normalized.authorityPreBaselineSequence
          )
        : normalized.authorityOrderObservedAt,
    authorityPreBaselineSequence: 0
  });
}

function reserveDurableSyncAuthorityPreBaselineSequencesThrough(value) {
  const requestedThrough = Number(value) || 0;
  const reservationDelta = requestedThrough
    - syncAuthorityDurablePreBaselineSequenceReservedThrough;
  if (reservationDelta <= 0) return;
  for (const [observedAt, sequence] of
    syncAuthorityPreBaselineSequenceByObservedAt) {
    syncAuthorityPreBaselineSequenceByObservedAt.set(
      observedAt,
      sequence + reservationDelta
    );
  }
  syncAuthorityPreBaselineSequence += reservationDelta;
  syncAuthorityDurablePreBaselineSequenceReservedThrough =
    requestedThrough;
  const currentDisableSequence =
    getSyncAuthorityPreBaselineSequence(
      deferredSyncDisableAuthorityOrderObservedAt
    );
  if (deferredSyncDisableAuthorityPreBaselineSequence > 0
      && currentDisableSequence > 0) {
    deferredSyncDisableAuthorityPreBaselineSequence =
      currentDisableSequence;
  }
  const currentSuccessorSequence = getSyncAuthorityPreBaselineSequence(
    deferredSyncDisableSuccessorAuthorityOrderObservedAt
  );
  if (deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
      && currentSuccessorSequence > 0) {
    deferredSyncDisableSuccessorAuthorityPreBaselineSequence =
      currentSuccessorSequence;
  }
  for (const [name, entry] of deferredSyncSuccessorRetryAlarmEntries) {
    const currentEntrySequence = getSyncAuthorityPreBaselineSequence(
      entry?.authorityOrderObservedAt
    );
    if ((Number(entry?.authorityPreBaselineSequence) || 0) <= 0
        || currentEntrySequence <= 0) continue;
    deferredSyncSuccessorRetryAlarmEntries.set(name, {
      ...entry,
      authorityPreBaselineSequence: currentEntrySequence
    });
  }
  const pendingEnvelope = _syncOpLock?.pendingRemoteCausalEnvelope;
  const pendingEnvelopeSequence = getSyncAuthorityPreBaselineSequence(
    pendingEnvelope?.authorityOrderObservedAt
  );
  if ((Number(pendingEnvelope?.authorityPreBaselineSequence) || 0) > 0
      && pendingEnvelopeSequence > 0) {
    _syncOpLock.pendingRemoteCausalEnvelope = Object.freeze({
      ...pendingEnvelope,
      authorityPreBaselineSequence: pendingEnvelopeSequence
    });
  }
}

function rebaseSyncAuthorityObservedAt(observedAt, durableBaseline) {
  const value = Number(observedAt) || 0;
  const sequence = getSyncAuthorityPreBaselineSequence(value);
  return sequence > 0
    ? Math.max(value, durableBaseline + sequence)
    : value;
}

async function completeSyncAuthorityDurableBaseline(durableBaseline) {
  if (syncAuthorityDurableBaselineLoaded) return true;
  if (deferredSyncDisableSyntheticReadFailure) return false;
  const baseline = Math.max(
    Number(durableBaseline) || 0,
    localScheduleMutationCommittedObservedAt
  );
  const rebaseLocalAuthorities = () => {
    localScheduleAuthorityObservedAt = rebaseSyncAuthorityObservedAt(
      localScheduleAuthorityObservedAt,
      baseline
    );
    localScheduleMutationObservedAt = rebaseSyncAuthorityObservedAt(
      localScheduleMutationObservedAt,
      baseline
    );
    for (const [generation, observedAt] of
      localScheduleMutationObservedAtByGeneration) {
      localScheduleMutationObservedAtByGeneration.set(
        generation,
        rebaseSyncAuthorityObservedAt(observedAt, baseline)
      );
    }
    localScheduleMutationObservedAt = Math.max(
      localScheduleMutationObservedAt,
      ...localScheduleMutationObservedAtByGeneration.values()
    );
  };
  rebaseLocalAuthorities();

  const hasPreBaselineRemoteAuthority = () => (
    deferredSyncDisableAuthorityPreBaselineSequence > 0
    || deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
    || Number(
      _syncOpLock?.pendingRemoteCausalEnvelope
        ?.authorityPreBaselineSequence
    ) > 0
  );
  if (!hasPreBaselineRemoteAuthority()) {
    remoteSyncAuthorityObservedAt = Math.max(
      remoteSyncAuthorityObservedAt,
      baseline,
      localScheduleAuthorityObservedAt,
      localScheduleMutationObservedAt
    );
    syncAuthorityDurableBaselineLoaded = true;
    syncAuthorityPreBaselineSequenceByObservedAt.clear();
    return true;
  }

  return runSerializedCriticalLocalStateWrite(async () => {
    while (!syncAuthorityDurableBaselineLoaded) {
      const sequenceAtStart = syncAuthorityPreBaselineSequence;
      rebaseLocalAuthorities();
      const disableIdentity = getSyncPayloadIdentity(
        deferredSyncDisableRemoteSnapshot
      );
      const disableObservedAtAtStart =
        deferredSyncDisableObservedAt;
      const successorIdentity = getSyncPayloadIdentity(
        deferredSyncDisableSuccessorSnapshot
      );
      const successorObservedAtAtStart =
        deferredSyncDisableSuccessorObservedAt;
      const successorRetryAlarmNameAtStart =
        deferredSyncDisableSuccessorRetryAlarmName;
      const disablePreBaselineSequence =
        deferredSyncDisableAuthorityPreBaselineSequence;
      const successorPreBaselineSequence =
        deferredSyncDisableSuccessorAuthorityPreBaselineSequence;
      const pendingRemoteCausalEnvelopeAtStart =
        _syncOpLock.pendingRemoteCausalEnvelope;
      const successorRetryEntryTuplesAtStart = new Map(
        [...deferredSyncSuccessorRetryAlarmEntries.entries()].map(
          ([name, entry]) => [
            name,
            {
              identity: getSyncPayloadIdentity(entry?.remote),
              observedAt: Number(entry?.observedAt) || 0,
              authorityOrderObservedAt:
                Number(entry?.authorityOrderObservedAt)
                || Number(entry?.observedAt)
                || 0,
              authorityPreBaselineSequence:
                Number(entry?.authorityPreBaselineSequence) || 0
            }
          ]
        )
      );
      if (disablePreBaselineSequence > 0) {
        deferredSyncDisableAuthorityOrderObservedAt = Math.max(
          Number(deferredSyncDisableAuthorityOrderObservedAt) || 0,
          Number(deferredSyncDisableObservedAt) || 0,
          baseline + disablePreBaselineSequence
        );
        deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
          deferredSyncSuccessorReleasedThroughObservedAt,
          deferredSyncDisableAuthorityOrderObservedAt
        );
      }
      if (successorPreBaselineSequence > 0) {
        deferredSyncDisableSuccessorAuthorityOrderObservedAt = Math.max(
          Number(
            deferredSyncDisableSuccessorAuthorityOrderObservedAt
          ) || 0,
          Number(deferredSyncDisableSuccessorObservedAt) || 0,
          baseline + successorPreBaselineSequence
        );
      }
      remoteSyncAuthorityObservedAt = Math.max(
        remoteSyncAuthorityObservedAt,
        baseline,
        localScheduleAuthorityObservedAt,
        localScheduleMutationObservedAt,
        deferredSyncDisableAuthorityOrderObservedAt,
        deferredSyncDisableSuccessorAuthorityOrderObservedAt
      );
      deferredSyncDisableAuthorityPreBaselineSequence = 0;
      deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
      const mailboxSnapshot = snapshotDeferredSyncDisableMailbox(
        'sync-authority-baseline-rebase'
      );
      try {
        if (mailboxSnapshot) {
          await chrome.storage.local.set({
            [DEFERRED_SYNC_DISABLE_KEY]:
              mergeDeferredSyncSafetyMetadata(mailboxSnapshot)
          });
        }
      } catch (error) {
        if (getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot)
              === disableIdentity
            && deferredSyncDisableObservedAt
              === disableObservedAtAtStart) {
          deferredSyncDisableAuthorityPreBaselineSequence =
            disablePreBaselineSequence;
        }
        if (getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
              === successorIdentity
            && deferredSyncDisableSuccessorObservedAt
              === successorObservedAtAtStart) {
          deferredSyncDisableSuccessorAuthorityPreBaselineSequence =
            successorPreBaselineSequence;
        }
        throw error;
      }
      for (const [name, tupleAtStart] of
        successorRetryEntryTuplesAtStart) {
        const currentEntry = deferredSyncSuccessorRetryAlarmEntries.get(name);
        if (!currentEntry
            || getSyncPayloadIdentity(currentEntry.remote)
              !== tupleAtStart.identity
            || Number(currentEntry.observedAt)
              !== tupleAtStart.observedAt
            || (Number(currentEntry.authorityOrderObservedAt)
                || Number(currentEntry.observedAt)
                || 0) !== tupleAtStart.authorityOrderObservedAt
            || (Number(currentEntry.authorityPreBaselineSequence) || 0)
              !== tupleAtStart.authorityPreBaselineSequence) {
          continue;
        }
        const rebasedEntry = rebaseSyncAuthorityOrderTuple(
          tupleAtStart,
          baseline
        );
        deferredSyncSuccessorRetryAlarmEntries.set(name, {
          ...currentEntry,
          authorityOrderObservedAt:
            rebasedEntry.authorityOrderObservedAt,
          authorityPreBaselineSequence: 0
        });
      }
      if (pendingRemoteCausalEnvelopeAtStart
          && _syncOpLock.pendingRemoteCausalEnvelope
            === pendingRemoteCausalEnvelopeAtStart
          && Number(
            pendingRemoteCausalEnvelopeAtStart
              .authorityPreBaselineSequence
          ) > 0
          && Number(
            pendingRemoteCausalEnvelopeAtStart
              .authorityPreBaselineSequence
          ) <= sequenceAtStart) {
        const rebasedPendingEnvelope = rebaseSyncAuthorityOrderTuple(
          pendingRemoteCausalEnvelopeAtStart,
          baseline
        );
        _syncOpLock.pendingRemoteCausalEnvelope = Object.freeze({
          ...pendingRemoteCausalEnvelopeAtStart,
          authorityOrderObservedAt:
            rebasedPendingEnvelope.authorityOrderObservedAt,
          authorityPreBaselineSequence: 0
        });
      }
      if (sequenceAtStart !== syncAuthorityPreBaselineSequence
          || disableIdentity !== getSyncPayloadIdentity(
            deferredSyncDisableRemoteSnapshot
          )
          || disableObservedAtAtStart
            !== deferredSyncDisableObservedAt
          || successorIdentity !== getSyncPayloadIdentity(
            deferredSyncDisableSuccessorSnapshot
          )
          || successorObservedAtAtStart
            !== deferredSyncDisableSuccessorObservedAt
          || successorRetryAlarmNameAtStart
            !== deferredSyncDisableSuccessorRetryAlarmName
          || deferredSyncDisableAuthorityPreBaselineSequence > 0
          || deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
          || Number(
            _syncOpLock.pendingRemoteCausalEnvelope
              ?.authorityPreBaselineSequence
          ) > 0) {
        continue;
      }
      syncAuthorityDurableBaselineLoaded = true;
      syncAuthorityPreBaselineSequenceByObservedAt.clear();
      return true;
    }
    return true;
  });
}

async function ensureSyncAuthorityDurableBaselineLoaded() {
  if (syncAuthorityDurableBaselineLoaded) return true;
  if (syncAuthorityDurableBaselineLoadPromise) {
    return syncAuthorityDurableBaselineLoadPromise;
  }
  syncAuthorityDurableBaselineLoadPromise = (async () => {
    if (startupManualOffAdmissionRestorePromise) {
      await startupManualOffAdmissionRestorePromise;
    }
    // startup 多源读取失败只建立内存 admission block。fresh classifier
    // 证明真实 F/无 F 前，绝不能把随机 synthetic lineage 写成 durable authority。
    if (deferredSyncDisableSyntheticReadFailure) return false;
    const stored = await chrome.storage.local.get([
      LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY,
      DEFERRED_SYNC_DISABLE_KEY
    ]);
    const durableDeferredDisable = stored?.[DEFERRED_SYNC_DISABLE_KEY];
    reserveDurableSyncAuthorityPreBaselineSequencesThrough(Math.max(
      Number(durableDeferredDisable?.authorityPreBaselineSequence) || 0,
      Number(
        durableDeferredDisable?.successor?.authorityPreBaselineSequence
      ) || 0
    ));
    const durableLocalMutationCutoff = Math.max(
      Number(stored?.[LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]) || 0,
      Number(durableDeferredDisable?.localMutationCutoffObservedAt) || 0
    );
    const authorityAllocationBaseline = Math.max(
      durableLocalMutationCutoff,
      durableDeferredDisable?.pending === true
        ? Number(durableDeferredDisable?.authorityOrderObservedAt)
            || Number(durableDeferredDisable?.receivedAt)
            || 0
        : 0,
      Number(
        durableDeferredDisable?.successor?.authorityOrderObservedAt
      ) || Number(durableDeferredDisable?.successor?.observedAt) || 0,
      Number(
        durableDeferredDisable?.releasedSuccessorThroughObservedAt
      ) || 0
    );
    recordCommittedLocalScheduleMutation(durableLocalMutationCutoff);
    return completeSyncAuthorityDurableBaseline(
      authorityAllocationBaseline
    );
  })().catch(error => {
    console.warn('[AC扩展] sync authority durable baseline 读取失败:', error?.message);
    void appendDiagnosticLog('warn', 'sync-authority-baseline', error);
    return false;
  }).finally(() => {
    syncAuthorityDurableBaselineLoadPromise = null;
  });
  return syncAuthorityDurableBaselineLoadPromise;
}

function runSerializedCriticalLocalStateWrite(operation) {
  const queued = criticalLocalStateWriteChain
    .catch(() => {})
    .then(operation);
  criticalLocalStateWriteChain = queued.catch(() => {});
  return queued;
}

function runSerializedManualOffAdmissionWrite(operation) {
  const queued = manualOffAdmissionWriteChain.then(operation, operation);
  manualOffAdmissionWriteChain = queued.catch(() => {});
  return queued;
}

function trackManualOffRetryAlarmOperation(promise) {
  const tracked = Promise.resolve(promise);
  manualOffRetryAlarmOperationsInFlight.add(tracked);
  void tracked.finally(() => {
    manualOffRetryAlarmOperationsInFlight.delete(tracked);
  }).catch(() => {});
  return tracked;
}

async function waitForManualOffRetryAlarmOperationsToSettle() {
  while (manualOffRetryAlarmOperationsInFlight.size > 0) {
    await Promise.allSettled([...manualOffRetryAlarmOperationsInFlight]);
  }
}

function runManualOffAdmissionFlight(token, operation) {
  const normalizedToken = String(token || '');
  if (normalizedToken
      && manualOffAdmissionFlightToken === normalizedToken
      && manualOffAdmissionFlightPromise) {
    return manualOffAdmissionFlightPromise;
  }
  let operationPromise;
  try {
    operationPromise = Promise.resolve(operation());
  } catch (error) {
    operationPromise = Promise.reject(error);
  }
  let trackedPromise;
  trackedPromise = operationPromise.finally(() => {
    if (manualOffAdmissionFlightPromise === trackedPromise) {
      manualOffAdmissionFlightToken = '';
      manualOffAdmissionFlightPromise = null;
    }
    if (manualOffAutomaticOnBlocked
        && manualOffAdmissionToken === normalizedToken) {
      void waitUntil(
        trackManualOffRetryAlarmOperation(
          ensureManualOffAdmissionRetryAlarm(
            normalizedToken,
            manualOffAdmissionRequestedAt
          )
        ).catch(error => {
          console.warn('[AC扩展] 手动关机事务未收口且重试钟重建失败:', error?.message);
        })
      );
    }
  });
  manualOffAdmissionFlightToken = normalizedToken;
  manualOffAdmissionFlightPromise = trackedPromise;
  // alarm delivery 可能只观察而不 await；预先安装 rejection handler。
  void trackedPromise.catch(() => {});
  return trackedPromise;
}

async function ensureManualOffAdmissionRetryAlarm(token, requestedAt) {
  const retryOwnerIsCurrent = () => (
    manualOffAutomaticOnBlocked
    && manualOffAdmissionToken === String(token || '')
    && Number(manualOffAdmissionRequestedAt) === Number(requestedAt)
  );
  if (!retryOwnerIsCurrent()) return false;
  const retryAlarmName = createManualOffRetryAlarmName(token, requestedAt);
  const existing = await chrome.alarms.get(retryAlarmName);
  if (!retryOwnerIsCurrent()) return false;
  if (existing) return true;
  await chrome.alarms.create(retryAlarmName, {
    when: Math.max(Date.now() + 60000, Number(requestedAt) + 60000),
    periodInMinutes: 1
  });
  if (!retryOwnerIsCurrent()) {
    await chrome.alarms.clear(retryAlarmName).catch(() => {});
    return false;
  }
  return !!await chrome.alarms.get(retryAlarmName);
}

function beginDurableManualOffAdmission(
  intentEpoch,
  mutationGeneration = 0
) {
  const requestedAt = Math.max(
    Date.now(),
    manualOffAdmissionRequestedAt + 1,
    manualOffAdmissionReleasedThroughRequestedAt + 1
  );
  const token = createManualOffAdmissionToken(intentEpoch);
  manualOffAdmissionToken = token;
  manualOffAdmissionRequestedAt = requestedAt;
  manualOffAdmissionRestoredFromStorage = false;
  const localMutationObservedAt = Number(
    localScheduleMutationObservedAtByGeneration.get(mutationGeneration)
  ) || 0;
  const retryAlarmName = createManualOffRetryAlarmName(
    token,
    requestedAt,
    localMutationObservedAt
  );
  manualOffAdmissionLocalMutationObservedAt = localMutationObservedAt;
  manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
  manualOffAdmissionMutationCoverageComplete = false;
  manualOffAdmissionPredecessorSuccessorObservedAt = 0;
  manualOffAdmissionPredecessorSuccessorIdentity = '';
  manualOffAdmissionLoaded = true;
  manualOffAutomaticOnBlocked = true;
  // marker 期间到达的 remote phase 必须排在本地 OFF 发布之后。
  syncPublishGeneration += 1;
  const markerBase = {
    schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
    state: 'pending',
    token,
    requestedAt,
    localMutationObservedAt,
    localMutationPredecessorRetryAlarmNames: [],
    localMutationPredecessorCoverageComplete: false,
    localMutationPredecessorSuccessorObservedAt: 0,
    localMutationPredecessorSuccessorIdentity: ''
  };
  // alarm reservation 不得排在旧 admission release 的尾部；新 OFF 已在
  // 内存 claim 后，即使旧 chain 仍在清理，也必须立刻拥有跨 SW 恢复凭证。
  const retryAlarmPromise = trackManualOffRetryAlarmOperation((async () => {
    await chrome.alarms.create(retryAlarmName, {
      when: requestedAt + 60000,
      periodInMinutes: 1
    });
    return !!await chrome.alarms.get(retryAlarmName);
  })());
  void retryAlarmPromise.catch(() => {});
  // retry alarm 与 marker 写并行，但不能成为物理 OFF 的前置条件。基础
  // marker 一旦 durable 就先放行紧急制动；T exact coverage 由真正的 M
  // commit 同批补齐，或由重启恢复在制动已经启动后保守枚举。
  const durablePromise = runSerializedManualOffAdmissionWrite(async () => {
    if (!isManualToggleIntentCurrent(intentEpoch, 'off')
        || manualOffAdmissionToken !== token) {
      return { persisted: false, stale: true, retryAlarmCreated: false };
    }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runSerializedCriticalLocalStateWrite(() => (
          chrome.storage.local.set({
            [MANUAL_OFF_ADMISSION_KEY]: markerBase
          })
        ));
        if (isManualToggleIntentCurrent(intentEpoch, 'off')
            && manualOffAdmissionToken === token) {
          return {
            persisted: true,
            stale: false,
            retryAlarmPending: true
          };
        }
        return {
          persisted: false,
          stale: true,
          retryAlarmPending: true
        };
      } catch (error) {
        lastError = error;
      }
    }
    console.warn('[AC扩展] 手动关机准入标记持久化失败，保留重试钟:', lastError?.message);
    void appendDiagnosticLog('warn', 'manual-off-admission-write', lastError);
    return {
      persisted: false,
      stale: false,
      retryAlarmPending: true,
      error: lastError?.message || '手动关机准入标记持久化失败'
    };
  });
  void waitUntil(retryAlarmPromise.catch(error => {
    console.warn('[AC扩展] 手动关机持久重试钟创建失败:', error?.message);
    return false;
  }));
  void durablePromise.catch(() => {});
  return Object.freeze({ token, requestedAt, durablePromise });
}

function completeRecoveredManualOffLocalMutationCoverage(
  admissionToken
) {
  const token = String(admissionToken || '');
  return runSerializedManualOffAdmissionWrite(async () => {
    const coverageIsCurrent = () => (
      token
      && manualOffAutomaticOnBlocked
      && manualOffAdmissionToken === token
    );
    if (!coverageIsCurrent()) return false;
    if (manualOffAdmissionLocalMutationObservedAt > 0
        && manualOffAdmissionMutationCoverageComplete) {
      return true;
    }

    // 后到用户 M 必须先完整提交或撤销；恢复事务不能 claim 新 generation，
    // 更不能把 M 后到达的 T 当成旧 marker 的 predecessor。init 会先完成
    // 紧急 OFF 并退出，M finally 再主动唤醒同 token recovery。
    if (localScheduleMutationCommitPendingGeneration > 0) return false;
    const mutationGenerationAtCoverage = localScheduleMutationGeneration;
    const recoveredLocalMutationObservedAt =
      Number(manualOffAdmissionLocalMutationObservedAt) > 0
        ? Number(manualOffAdmissionLocalMutationObservedAt)
        : nextSyncAuthorityObservedAt();
    const successorBeforeCoverage = deferredSyncDisableSuccessorSnapshot
      ? {
          observedAt: Number(deferredSyncDisableSuccessorObservedAt) || 0,
          identity: getSyncPayloadIdentity(
            deferredSyncDisableSuccessorSnapshot
          )
        }
      : null;
    let predecessorRetryAlarmNames;
    try {
      predecessorRetryAlarmNames =
        await captureAllDeferredSyncSuccessorRetryAlarmNames();
    } catch (error) {
      console.warn('[AC扩展] 恢复手动关机 M exact coverage 失败:', error?.message);
      return false;
    }
    const capturedSuccessorReceipt =
      snapshotCurrentDeferredSyncSuccessorPredecessor({
        retryAlarmNames: predecessorRetryAlarmNames
      });
    if (successorBeforeCoverage
        && isCurrentDeferredSyncSuccessorReceipt(successorBeforeCoverage)
        && !capturedSuccessorReceipt) {
      // 同一 mailbox 在完整 alarm enumeration 后仍没有 exact credential，
      // 无法证明它是 predecessor 还是后继。保持 OFF fail-closed，不能用
      // 数值时间猜测并释放 marker。
      return false;
    }
    if (!coverageIsCurrent()
        || localScheduleMutationCommitPendingGeneration > 0
        || localScheduleMutationGeneration
          !== mutationGenerationAtCoverage) {
      return false;
    }
    const marker = {
      schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
      state: 'pending',
      token,
      requestedAt: Number(manualOffAdmissionRequestedAt) || Date.now(),
      localMutationObservedAt: recoveredLocalMutationObservedAt,
      localMutationPredecessorRetryAlarmNames:
        [...predecessorRetryAlarmNames],
      localMutationPredecessorCoverageComplete: true,
      localMutationPredecessorSuccessorObservedAt:
        Number(capturedSuccessorReceipt?.observedAt) || 0,
      localMutationPredecessorSuccessorIdentity:
        String(capturedSuccessorReceipt?.identity || ''),
      localMutationCoverageRecoveredAt: Date.now()
    };
    try {
      const markerPersisted = await runSerializedCriticalLocalStateWrite(async () => {
        if (!coverageIsCurrent()
            || localScheduleMutationCommitPendingGeneration > 0
            || localScheduleMutationGeneration
              !== mutationGenerationAtCoverage) {
          return false;
        }
        await chrome.storage.local.set({
          [MANUAL_OFF_ADMISSION_KEY]: marker
        });
        return true;
      });
      if (!markerPersisted) return false;
    } catch (error) {
      console.warn('[AC扩展] 恢复手动关机 M coverage 持久化失败:', error?.message);
      return false;
    }
    if (!coverageIsCurrent()
        || localScheduleMutationCommitPendingGeneration > 0
        || localScheduleMutationGeneration
          !== mutationGenerationAtCoverage) {
      return false;
    }
    manualOffAdmissionPredecessorSuccessorRetryAlarmNames =
      [...predecessorRetryAlarmNames];
    manualOffAdmissionMutationCoverageComplete = true;
    manualOffAdmissionLocalMutationObservedAt =
      recoveredLocalMutationObservedAt;
    manualOffAdmissionPredecessorSuccessorObservedAt =
      Number(capturedSuccessorReceipt?.observedAt) || 0;
    manualOffAdmissionPredecessorSuccessorIdentity =
      String(capturedSuccessorReceipt?.identity || '');
    return true;
  });
}

function snapshotStartupEarlySyncSuccessorCausalEnvelope(
  pendingRemote = _syncOpLock.pendingRemote,
  scheduleAuthorityGeneration =
    _syncOpLock.pendingRemoteScheduleAuthorityGeneration,
  scheduleMutationGeneration =
    _syncOpLock.pendingRemoteMutationGeneration
) {
  if (!pendingRemote
      || typeof pendingRemote !== 'object'
      || pendingRemote.enabled === false) return null;
  const pendingIdentity = getSyncPayloadIdentity(pendingRemote);
  if (!pendingIdentity) return null;
  const matchingRetryEntries = [
    ...deferredSyncSuccessorRetryAlarmEntries.entries()
  ].filter(([, entry]) => (
    getSyncPayloadIdentity(entry?.remote) === pendingIdentity
    && Number(entry?.observedAt) > 0
  ));
  const [retryAlarmName = '', retryEntry = null] =
    matchingRetryEntries.reduce((latest, candidate) => {
      if (!latest) return candidate;
      return compareSyncAuthorityOrderTuples(candidate[1], latest[1]) >= 0
        ? candidate
        : latest;
    }, null) || [];
  const currentSuccessorMatches = getSyncPayloadIdentity(
    deferredSyncDisableSuccessorSnapshot
  ) === pendingIdentity;
  const observedAt = Number(retryEntry?.observedAt)
    || (currentSuccessorMatches
      ? Number(deferredSyncDisableSuccessorObservedAt) || 0
      : 0);
  if (observedAt <= 0) return null;
  return Object.freeze({
    remote: { ...pendingRemote },
    observedAt,
    authorityOrderObservedAt:
      Number(retryEntry?.authorityOrderObservedAt)
      || (currentSuccessorMatches
        ? Number(
            deferredSyncDisableSuccessorAuthorityOrderObservedAt
          ) || 0
        : 0)
      || observedAt,
    authorityPreBaselineSequence:
      Number(retryEntry?.authorityPreBaselineSequence)
      || (currentSuccessorMatches
        ? Number(
            deferredSyncDisableSuccessorAuthorityPreBaselineSequence
          ) || 0
        : 0),
    retryAlarmName: String(retryAlarmName || ''),
    scheduleAuthorityGeneration: Number.isSafeInteger(
      retryEntry?.scheduleAuthorityGeneration
    )
      ? retryEntry.scheduleAuthorityGeneration
      : scheduleAuthorityGeneration,
    scheduleMutationGeneration: Number.isSafeInteger(
      retryEntry?.scheduleMutationGeneration
    )
      ? retryEntry.scheduleMutationGeneration
      : scheduleMutationGeneration
  });
}

async function restoreDurableManualOffAdmission() {
  const intentEpochAtRead = manualToggleIntentEpoch;
  const deferredDisableEpochAtRead = deferredSyncDisableEpoch;
  const localScheduleAuthorityGenerationAtRead =
    localScheduleAuthorityGeneration;
  const localScheduleMutationGenerationAtRead =
    localScheduleMutationGeneration;
  let observedStored = null;
  let observedRetryAlarmIdentities = [];
  let observedDeferredDisableRetryAlarmIdentities = [];
  let observedDeferredSuccessorRetryAlarmIdentities = [];
  let localSafetyStateReadComplete = false;
  let deferredDisableRetryAlarmReadComplete = false;
  try {
    const [
      storedResult,
      retryAlarmResult,
      deferredDisableRetryAlarmResult,
      deferredSuccessorRetryAlarmResult
    ] = await Promise.allSettled([
      chrome.storage.local.get([
        MANUAL_OFF_ADMISSION_KEY,
        DEFERRED_SYNC_DISABLE_KEY,
        LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY,
        LOCAL_TERMINAL_AUTHORITY_KEY
      ]),
      getManualOffRetryAlarmIdentities(),
      getDeferredSyncDisableRetryAlarmIdentities(),
      getDeferredSyncSuccessorRetryAlarmIdentities()
    ]);
    if (storedResult.status === 'fulfilled') {
      observedStored = storedResult.value;
      localSafetyStateReadComplete = true;
    }
    if (retryAlarmResult.status === 'fulfilled') {
      observedRetryAlarmIdentities = retryAlarmResult.value;
    }
    if (deferredDisableRetryAlarmResult.status === 'fulfilled') {
      observedDeferredDisableRetryAlarmIdentities =
        deferredDisableRetryAlarmResult.value;
      deferredDisableRetryAlarmReadComplete = true;
    }
    if (deferredSuccessorRetryAlarmResult.status === 'fulfilled') {
      observedDeferredSuccessorRetryAlarmIdentities =
        deferredSuccessorRetryAlarmResult.value;
    }
    if (storedResult.status === 'rejected') throw storedResult.reason;
    if (retryAlarmResult.status === 'rejected') throw retryAlarmResult.reason;
    if (deferredDisableRetryAlarmResult.status === 'rejected') {
      throw deferredDisableRetryAlarmResult.reason;
    }
    if (deferredSuccessorRetryAlarmResult.status === 'rejected') {
      throw deferredSuccessorRetryAlarmResult.reason;
    }
    // onChanged F/T 可以在 startup 多源读取期间先取得新 epoch。其后这份
    // 旧快照只可贡献单调 metadata，不能替换当前 authority/credential sets。
    const deferredDisableRestoreOwnsState =
      deferredDisableEpochAtRead === deferredSyncDisableEpoch;
    startupManualOffClassificationPending = false;
    startupManualOffClassificationIntentEpoch = 0;
    const stored = observedStored;
    adoptLocalTerminalAuthority(stored?.[LOCAL_TERMINAL_AUTHORITY_KEY]);
    const retryAlarmIdentities = observedRetryAlarmIdentities;
    manualOffAdmissionLoaded = true;
    deferredSyncDisableLoaded = true;
    const durableDeferredDisable = stored?.[DEFERRED_SYNC_DISABLE_KEY];
    const durableSuccessor = durableDeferredDisable?.successor?.remote;
    const normalizedDurableSuccessor = durableSuccessor
        && typeof durableSuccessor === 'object'
        && durableSuccessor.enabled !== false
      ? { ...durableSuccessor }
      : null;
    const durableSuccessorObservedAt = normalizedDurableSuccessor
      ? Number(durableDeferredDisable?.successor?.observedAt) || 0
      : 0;
    const durableSuccessorAuthorityOrderObservedAt =
      normalizedDurableSuccessor
        ? Number(
            durableDeferredDisable?.successor?.authorityOrderObservedAt
          ) || durableSuccessorObservedAt
        : 0;
    const durableSuccessorAuthorityPreBaselineSequence =
      normalizedDurableSuccessor
        ? Number(
            durableDeferredDisable?.successor
              ?.authorityPreBaselineSequence
          ) || 0
        : 0;
    const durableSuccessorRetryAlarmName = normalizedDurableSuccessor
      ? String(
          durableDeferredDisable?.successor?.retryAlarmName || ''
        )
      : '';
    reserveDurableSyncAuthorityPreBaselineSequencesThrough(Math.max(
      Number(durableDeferredDisable?.authorityPreBaselineSequence) || 0,
      durableSuccessorAuthorityPreBaselineSequence,
      ...observedDeferredDisableRetryAlarmIdentities.map(identity => (
        Number(identity.authorityPreBaselineSequence) || 0
      )),
      ...observedDeferredSuccessorRetryAlarmIdentities.map(identity => (
        Number(identity.authorityPreBaselineSequence) || 0
      ))
    ));
    const releasedDeferredDisableRetryAlarmNames = new Set(
      Array.isArray(durableDeferredDisable?.releasedRetryAlarmNames)
        ? durableDeferredDisable.releasedRetryAlarmNames
          .map(value => String(value || ''))
          .filter(Boolean)
        : []
    );
    deferredSyncDisableReleasedRetryAlarmNames = new Set([
      ...deferredSyncDisableReleasedRetryAlarmNames,
      ...releasedDeferredDisableRetryAlarmNames
    ]);
    const liveDeferredDisableRetryAlarmIdentities =
      observedDeferredDisableRetryAlarmIdentities.filter(identity => (
        !releasedDeferredDisableRetryAlarmNames.has(identity.name)
      ));
    if (deferredDisableRestoreOwnsState) {
      deferredSyncDisableRetryAlarmNames = new Set(
        liveDeferredDisableRetryAlarmIdentities.map(identity => identity.name)
      );
    } else {
      for (const identity of liveDeferredDisableRetryAlarmIdentities) {
        if (!deferredSyncDisableRetryAlarmNames.has(identity.name)) {
          deferredSyncDisableReleasedRetryAlarmNames.add(identity.name);
        }
      }
    }
    const retryAlarmProvesDeferredDisable =
      liveDeferredDisableRetryAlarmIdentities.length > 0;
    const conservativeDisableRecovery =
      selectLatestDeferredSyncDisableCredential({
        durableRecord: durableDeferredDisable,
        retryAlarmIdentities:
          liveDeferredDisableRetryAlarmIdentities
      });
    const restoredDisableCredential =
      conservativeDisableRecovery.credential;
    // safety cutoff 是“已见过哪些 F”的单调 coverage；current credential raw
    // 必须来自 winner 本身，二者不可再拼成 Franken tuple。
    const latestDeferredDisableSafetyCutoffObservedAt = Math.max(
      Number(durableDeferredDisable?.safetyCutoffObservedAt) || 0,
      durableDeferredDisable?.pending === true
        ? Number(durableDeferredDisable.receivedAt) || 0
        : 0,
      ...liveDeferredDisableRetryAlarmIdentities.map(identity => (
        Number(identity.receivedAt) || 0
      ))
    );
    const durableSuccessorPredecessorCoverageThroughObservedAt = Math.max(
      Number(
        durableDeferredDisable
          ?.successorPredecessorCoverageThroughObservedAt
      ) || 0,
      durableDeferredDisable?.successorPredecessorCoverageComplete === true
        ? Math.max(
            Number(durableDeferredDisable?.safetyCutoffObservedAt) || 0,
            Number(durableDeferredDisable?.receivedAt) || 0
          )
        : 0
    );
    const successorPredecessorCoverageIsComplete =
      durableDeferredDisable?.pending === true
      && durableSuccessorPredecessorCoverageThroughObservedAt
        >= latestDeferredDisableSafetyCutoffObservedAt;
    if (!retryAlarmProvesDeferredDisable
        && observedDeferredDisableRetryAlarmIdentities.length > 0) {
      void clearDeferredSyncDisableRetryAlarms(
        observedDeferredDisableRetryAlarmIdentities.map(identity => identity.name),
        { preserveReleasedNames: true }
      ).catch(() => {});
    }
    const releasedDeferredSuccessorRetryAlarmNames = new Set(
      Array.isArray(durableDeferredDisable?.releasedSuccessorRetryAlarmNames)
        ? durableDeferredDisable.releasedSuccessorRetryAlarmNames
          .map(value => String(value || ''))
          .filter(Boolean)
        : []
    );
    const deferredDisableWillBePending =
      durableDeferredDisable?.pending === true
      || retryAlarmProvesDeferredDisable;
    const durableSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        durableDeferredDisable?.safetyAuthorityId
      );
    const durableDisableAuthorityIsCurrent =
      conservativeDisableRecovery.durableCoversAllKnownWatermarks;
    const restoredDisableAuthorityTuple =
      normalizeSyncAuthorityOrderTuple({
        observedAt:
          Number(restoredDisableCredential?.receivedAt) || 0,
        authorityOrderObservedAt:
          Number(
            restoredDisableCredential?.authorityOrderObservedAt
          ) || Number(restoredDisableCredential?.receivedAt) || 0,
        authorityPreBaselineSequence:
          Number(
            restoredDisableCredential?.authorityPreBaselineSequence
          ) || 0
      });
    const restoredDisableObservedAt =
      restoredDisableAuthorityTuple.observedAt
      || latestDeferredDisableSafetyCutoffObservedAt;
    const restoredDisableAuthorityOrderObservedAt =
      restoredDisableAuthorityTuple.authorityOrderObservedAt
      || restoredDisableObservedAt;
    const restoredDisableAuthorityPreBaselineSequence =
      restoredDisableAuthorityTuple.authorityPreBaselineSequence;
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      deferredSyncSuccessorReleasedThroughObservedAt,
      restoredDisableAuthorityOrderObservedAt
    );
    const restoredSafetyAuthorityId = deferredDisableWillBePending
      ? normalizeDeferredSyncDisableSafetyAuthorityId(
          restoredDisableCredential?.safetyAuthorityId
        ) || (durableDisableAuthorityIsCurrent
          ? durableSafetyAuthorityId
          : '') || createDeferredSyncDisableSafetyAuthorityId()
      : '';
    const restoredLastClearedSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        durableDeferredDisable?.releasedSafetyAuthorityId
      ) || deferredSyncLastClearedSafetyAuthorityId;
    const durableSuccessorIsExactlyReleased = !!normalizedDurableSuccessor
      && (durableSuccessorRetryAlarmName
        ? releasedDeferredSuccessorRetryAlarmNames.has(
            durableSuccessorRetryAlarmName
          )
        : [...releasedDeferredSuccessorRetryAlarmNames].some(name => {
            const identity = parseDeferredSyncSuccessorRetryAlarm({ name });
            return !!identity
              && identity.observedAt === durableSuccessorObservedAt
              && getSyncPayloadIdentity(identity.remote)
                === getSyncPayloadIdentity(normalizedDurableSuccessor);
          }));
    const durableSuccessorPredecessorSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        durableDeferredDisable?.successor
          ?.predecessorSafetyAuthorityId
      );
    const successorCredentialSurvivesPendingSafety = (
      ...predecessorSafetyAuthorityIds
    ) => {
      const explicitLineages = [...new Set(
        predecessorSafetyAuthorityIds
          .map(normalizeDeferredSyncDisableSafetyAuthorityId)
          .filter(Boolean)
      )];
      if (explicitLineages.length > 1) return false;
      return explicitLineages.length === 1
        ? explicitLineages[0] === restoredSafetyAuthorityId
        : successorPredecessorCoverageIsComplete;
    };
    const durableSuccessorIsTrustedForPendingSafety =
      deferredDisableWillBePending
      && durableDeferredDisable?.pending === true
      && durableDisableAuthorityIsCurrent
      && !!normalizedDurableSuccessor
      && !durableSuccessorIsExactlyReleased;
    const durableSuccessorSurvivesPredecessor = deferredDisableWillBePending
      ? durableSuccessorIsTrustedForPendingSafety
        && successorCredentialSurvivesPendingSafety(
          durableSuccessorPredecessorSafetyAuthorityId
        )
      : !!normalizedDurableSuccessor
        && !durableSuccessorIsExactlyReleased;
    deferredSyncSuccessorReleasedRetryAlarmNames = new Set([
      ...deferredSyncSuccessorReleasedRetryAlarmNames,
      ...releasedDeferredSuccessorRetryAlarmNames
    ]);
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      Number(
        durableDeferredDisable?.releasedSuccessorThroughObservedAt
      ) || 0,
      restoredDisableAuthorityOrderObservedAt
    );
    localScheduleMutationCommittedObservedAt = Math.max(
      localScheduleMutationCommittedObservedAt,
      Number(stored?.[LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]) || 0,
      Number(durableDeferredDisable?.localMutationCutoffObservedAt) || 0
    );
    localScheduleMutationObservedAt = Math.max(
      localScheduleMutationObservedAt,
      localScheduleMutationCommittedObservedAt
    );
    const liveDeferredSuccessorRetryAlarmIdentities =
      observedDeferredSuccessorRetryAlarmIdentities.filter(identity => (
        !releasedDeferredSuccessorRetryAlarmNames.has(identity.name)
        && (deferredDisableWillBePending
          ? durableSuccessorSurvivesPredecessor
            && successorCredentialSurvivesPendingSafety(
              durableSuccessorPredecessorSafetyAuthorityId,
              identity.predecessorSafetyAuthorityId
            )
          : !!normalizedDurableSuccessor
            && !durableSuccessorIsExactlyReleased)
        && identity.observedAt === durableSuccessorObservedAt
        && getSyncPayloadIdentity(identity.remote)
          === getSyncPayloadIdentity(normalizedDurableSuccessor)
        && (!durableSuccessorRetryAlarmName
          || identity.name === durableSuccessorRetryAlarmName)
      ));
    const startupUnknownSuccessorRetryAlarmIdentities =
      observedDeferredSuccessorRetryAlarmIdentities.filter(identity => (
        !releasedDeferredSuccessorRetryAlarmNames.has(identity.name)
        && !liveDeferredSuccessorRetryAlarmIdentities.some(known => (
          known.name === identity.name
        ))
      ));
    const latestAlarmSuccessor =
      liveDeferredSuccessorRetryAlarmIdentities.reduce(
        (latest, identity) => {
          if (!latest) return identity;
          return compareSyncAuthorityOrderTuples(identity, latest) >= 0
            ? identity
            : latest;
        },
        null
      );
    const durableSuccessorAuthorityTuple =
      normalizeSyncAuthorityOrderTuple({
        observedAt: durableSuccessorObservedAt,
        authorityOrderObservedAt:
          durableSuccessorAuthorityOrderObservedAt,
        authorityPreBaselineSequence:
          durableSuccessorAuthorityPreBaselineSequence
      });
    const latestAlarmSuccessorAuthorityTuple =
      normalizeSyncAuthorityOrderTuple({
        observedAt: Number(latestAlarmSuccessor?.observedAt) || 0,
        authorityOrderObservedAt:
          Number(latestAlarmSuccessor?.authorityOrderObservedAt)
          || Number(latestAlarmSuccessor?.observedAt)
          || 0,
        authorityPreBaselineSequence:
          Number(latestAlarmSuccessor?.authorityPreBaselineSequence) || 0
      });
    const durableSuccessorAuthorityIsCanonical =
      !!normalizedDurableSuccessor
      && Number(
        durableDeferredDisable?.successor?.authorityOrderObservedAt
      ) > 0;
    const restoredSuccessorAuthorityTuple =
      durableSuccessorAuthorityIsCanonical
        ? durableSuccessorAuthorityTuple
        : latestAlarmSuccessor
          ? latestAlarmSuccessorAuthorityTuple
          : durableSuccessorAuthorityTuple;
    if (deferredDisableRestoreOwnsState) {
      deferredSyncSuccessorRetryAlarmEntries = new Map(
        liveDeferredSuccessorRetryAlarmIdentities.map(identity => [
          identity.name,
          {
            remote: { ...identity.remote },
            observedAt: identity.observedAt,
            authorityOrderObservedAt:
              restoredSuccessorAuthorityTuple.authorityOrderObservedAt,
            authorityPreBaselineSequence:
              restoredSuccessorAuthorityTuple
                .authorityPreBaselineSequence,
            predecessorSafetyAuthorityId:
              durableSuccessorPredecessorSafetyAuthorityId
              || identity.predecessorSafetyAuthorityId,
            scheduleAuthorityGeneration:
              localScheduleAuthorityGenerationAtRead,
            scheduleMutationGeneration:
              localScheduleMutationGenerationAtRead
          }
        ])
      );
    }
    const restoredSuccessor = durableSuccessorSurvivesPredecessor
      ? normalizedDurableSuccessor
      : null;
    const restoredSuccessorObservedAt = durableSuccessorSurvivesPredecessor
      ? durableSuccessorObservedAt
      : 0;
    const restoredSuccessorAuthorityOrderObservedAt =
      durableSuccessorSurvivesPredecessor
        ? restoredSuccessorAuthorityTuple.authorityOrderObservedAt
        : 0;
    const restoredSuccessorAuthorityPreBaselineSequence =
      durableSuccessorSurvivesPredecessor
        ? restoredSuccessorAuthorityTuple
            .authorityPreBaselineSequence
        : 0;
    const restoredSuccessorRetryAlarmName =
      durableSuccessorSurvivesPredecessor
        ? durableSuccessorRetryAlarmName
          || String(latestAlarmSuccessor?.name || '')
        : '';
    remoteSyncAuthorityObservedAt = Math.max(
      remoteSyncAuthorityObservedAt,
      latestDeferredDisableSafetyCutoffObservedAt,
      restoredDisableAuthorityOrderObservedAt,
      deferredSyncSuccessorReleasedThroughObservedAt,
      localScheduleMutationCommittedObservedAt,
      restoredSuccessorObservedAt,
      restoredSuccessorAuthorityOrderObservedAt,
      ...observedDeferredDisableRetryAlarmIdentities.map(identity => (
        Number(identity.receivedAt) || 0
      )),
      Number(observedDeferredSuccessorRetryAlarmIdentities.at(-1)?.observedAt)
        || 0,
      ...observedDeferredDisableRetryAlarmIdentities.map(identity => (
        Number(identity.authorityOrderObservedAt) || 0
      )),
      ...observedDeferredSuccessorRetryAlarmIdentities.map(identity => (
        Number(identity.authorityOrderObservedAt) || 0
      ))
    );
    const liveDeferredSuccessorRetryAlarmNames = new Set(
      liveDeferredSuccessorRetryAlarmIdentities.map(identity => identity.name)
    );
    const coveredDeferredSuccessorRetryAlarmNames =
      observedDeferredSuccessorRetryAlarmIdentities
        .filter(identity => (
          !startupUnknownSuccessorRetryAlarmIdentities.some(unknown => (
            unknown.name === identity.name
          ))
          &&
          !liveDeferredSuccessorRetryAlarmNames.has(identity.name)
        ))
        .map(identity => identity.name);
    if (deferredDisableRestoreOwnsState
        && coveredDeferredSuccessorRetryAlarmNames.length > 0) {
      void clearDeferredSyncSuccessorRetryAlarms(
        coveredDeferredSuccessorRetryAlarmNames,
        { preserveReleasedNames: true }
      ).catch(() => {});
    }
    if (deferredDisableRestoreOwnsState) {
      deferredSyncDisableSyntheticReadFailure = false;
      deferredSyncDisablePending =
        durableDeferredDisable?.pending === true
        || retryAlarmProvesDeferredDisable;
      deferredSyncDisableObservedAt = restoredDisableObservedAt;
      deferredSyncDisableAuthorityOrderObservedAt =
        deferredSyncDisablePending
          ? restoredDisableAuthorityOrderObservedAt
          : 0;
      deferredSyncDisableAuthorityPreBaselineSequence =
        deferredSyncDisablePending
          ? restoredDisableAuthorityPreBaselineSequence
          : 0;
      if (deferredSyncDisablePending) {
        deferredSyncDisableEpoch += 1;
        deferredSyncDisableSafetyAuthorityId =
          restoredSafetyAuthorityId;
        deferredSyncSuccessorEnumerationPendingEpoch =
          successorPredecessorCoverageIsComplete
              && startupUnknownSuccessorRetryAlarmIdentities.length === 0
            ? 0
            : deferredSyncDisableEpoch;
        const recoveredDisableRemote = conservativeDisableRecovery.remote;
        deferredSyncDisableRemoteSnapshot =
          recoveredDisableRemote
            && typeof recoveredDisableRemote === 'object'
            ? { ...recoveredDisableRemote, enabled: false }
            : {
                enabled: false,
                // receivedAt 是本机墙钟，不是远端 Lamport 水位。旧 marker
                // 缺 remote payload 时只做安全停用，绝不能推进 sync watermark。
                syncedAt: 0
              };
        deferredSyncDisableRemoteSnapshotComplete =
          conservativeDisableRecovery.complete;
        if (durableDeferredDisable?.pending === true
            && conservativeDisableRecovery
              .durableCoversAllKnownWatermarks) {
          deferredSyncDisableDurableReceiptEpoch =
            deferredSyncDisableEpoch;
          deferredSyncDisableDurableReceiptIdentity =
            getDeferredSyncDisableReceiptIdentity();
        } else {
          deferredSyncDisableDurableReceiptEpoch = 0;
          deferredSyncDisableDurableReceiptIdentity = '';
        }
        deferredSyncDisableLocalScheduleAuthorityGeneration =
          localScheduleAuthorityGenerationAtRead;
        deferredSyncDisableSuccessorSnapshot = restoredSuccessor;
        deferredSyncDisableSuccessorObservedAt = restoredSuccessor
          ? restoredSuccessorObservedAt
          : 0;
        deferredSyncDisableSuccessorAuthorityOrderObservedAt =
          restoredSuccessor
            ? restoredSuccessorAuthorityOrderObservedAt
            : 0;
        deferredSyncDisableSuccessorAuthorityPreBaselineSequence =
          restoredSuccessor
            ? restoredSuccessorAuthorityPreBaselineSequence
            : 0;
        deferredSyncDisableSuccessorRetryAlarmName = restoredSuccessor
          ? restoredSuccessorRetryAlarmName
          : '';
        deferredSyncDisableSuccessorLocalAuthorityGeneration =
          localScheduleAuthorityGenerationAtRead;
        deferredSyncDisableLocalMutationGeneration =
          localScheduleMutationGenerationAtRead;
        deferredSyncDisableSuccessorMutationGeneration =
          localScheduleMutationGenerationAtRead;
      } else {
        deferredSyncDisableSafetyAuthorityId = '';
        deferredSyncLastClearedSafetyAuthorityId =
          restoredLastClearedSafetyAuthorityId;
        deferredSyncSuccessorEnumerationPendingEpoch = 0;
        deferredSyncDisableDurableReceiptEpoch = 0;
        deferredSyncDisableDurableReceiptIdentity = '';
        deferredSyncDisableRemoteSnapshot = null;
        deferredSyncDisableRemoteSnapshotComplete = false;
        deferredSyncDisableSuccessorSnapshot =
          (durableDeferredDisable?.safetyCleared === true
            || !!latestAlarmSuccessor)
            ? restoredSuccessor
            : null;
        deferredSyncDisableSuccessorObservedAt =
          deferredSyncDisableSuccessorSnapshot
            ? restoredSuccessorObservedAt
            : 0;
        deferredSyncDisableSuccessorAuthorityOrderObservedAt =
          deferredSyncDisableSuccessorSnapshot
            ? restoredSuccessorAuthorityOrderObservedAt
            : 0;
        deferredSyncDisableSuccessorAuthorityPreBaselineSequence =
          deferredSyncDisableSuccessorSnapshot
            ? restoredSuccessorAuthorityPreBaselineSequence
            : 0;
        deferredSyncDisableSuccessorRetryAlarmName =
          deferredSyncDisableSuccessorSnapshot
            ? restoredSuccessorRetryAlarmName
            : '';
        deferredSyncDisableSuccessorLocalAuthorityGeneration =
          deferredSyncDisableSuccessorSnapshot
            ? localScheduleAuthorityGenerationAtRead
            : 0;
        deferredSyncDisableLocalMutationGeneration =
          localScheduleMutationGenerationAtRead;
        deferredSyncDisableSuccessorMutationGeneration =
          deferredSyncDisableSuccessorSnapshot
            ? localScheduleMutationGenerationAtRead
            : 0;
        deferredSyncDisableLocalScheduleAuthorityGeneration =
          localScheduleAuthorityGeneration;
      }
    }
    if (deferredDisableRestoreOwnsState
        && startupUnknownSuccessorRetryAlarmIdentities.length > 0) {
      // future-clock legacy T 保持原 alarm，不在 startup 用 observedAt 预塞
      // mailbox。每个 exact identity 都另建近端 typed wake；generic adopt
      // 只负责 store 收敛，不能替代原 T 的 lineage 分类入口。
      void Promise.allSettled([
        ...startupUnknownSuccessorRetryAlarmIdentities.map(identity => (
          createDeferredSyncSuccessorClassificationWake(
            identity,
            'startup unknown T lineage'
          )
        )),
        scheduleSyncRetry('adopt')
      ]);
    }
    const startupEarlySyncSuccessor =
      _syncOpLock.pendingRemoteCausalEnvelope;
    if (startupEarlySyncSuccessor
        && typeof startupEarlySyncSuccessor === 'object'
        && startupEarlySyncSuccessor.remote?.enabled !== false
        && _syncOpLock.pendingRemote
        && typeof _syncOpLock.pendingRemote === 'object'
        && _syncOpLock.pendingRemote?.enabled !== false
        && getSyncPayloadIdentity(startupEarlySyncSuccessor.remote)
          === getSyncPayloadIdentity(_syncOpLock.pendingRemote)) {
      // T 可在首次 storage.get 尚未返回时先进入内存 mailbox。若存在 durable
      // F，它是 F 的后继；若只是启动/manual-OFF fail-close，它仍须先 durable，
      // 避免旧本机 phase publish 在 SW crash 前覆盖 sync store 后把 T 永久抹掉。
      const successorReceipt =
        rememberRemoteSyncSuccessorAfterDeferredDisable(
          startupEarlySyncSuccessor.remote,
          'startup-restore-early-successor',
          {
            scheduleAuthorityGeneration:
              startupEarlySyncSuccessor.scheduleAuthorityGeneration,
            scheduleMutationGeneration:
              startupEarlySyncSuccessor.scheduleMutationGeneration,
            credentialObservedAt:
              startupEarlySyncSuccessor.observedAt,
            credentialRetryAlarmName:
              startupEarlySyncSuccessor.retryAlarmName,
            credentialAuthorityOrderObservedAt:
              startupEarlySyncSuccessor.authorityOrderObservedAt,
            credentialAuthorityPreBaselineSequence:
              startupEarlySyncSuccessor.authorityPreBaselineSequence,
            preserveCausalObservation: true
          }
        );
      if (successorReceipt) await successorReceipt;
    }
    const storedMarker = stored?.[MANUAL_OFF_ADMISSION_KEY];
    const releasedAt = storedMarker?.state === 'released'
      ? Number(storedMarker.releasedAt) || 0
      : 0;
    const hasReleasedThrough = storedMarker?.state === 'released'
      && Object.prototype.hasOwnProperty.call(
        storedMarker,
        'releasedThroughRequestedAt'
      );
    const releasedThroughRequestedAt = storedMarker?.state === 'released'
      ? (hasReleasedThrough
          ? Number(storedMarker.releasedThroughRequestedAt) || 0
          : releasedAt)
      : 0;
    manualOffAdmissionReleasedThroughRequestedAt = Math.max(
      manualOffAdmissionReleasedThroughRequestedAt,
      releasedThroughRequestedAt
    );
    const releasedTokens = new Set(
      storedMarker?.state === 'released'
        ? [
            String(storedMarker.releasedToken || ''),
            ...(Array.isArray(storedMarker.releasedTokens)
              ? storedMarker.releasedTokens.map(value => String(value || ''))
              : [])
          ].filter(Boolean)
        : []
    );
    const hasReleasedTokenCoverage = storedMarker?.state === 'released'
      && Array.isArray(storedMarker.releasedTokens);
    const storedPendingAt = isPendingManualOffAdmissionValue(storedMarker)
      ? Number(storedMarker.requestedAt) || 0
      : 0;
    const retryIdentity = retryAlarmIdentities
      .filter(identity => (
        !releasedTokens.has(identity.token)
        && (hasReleasedTokenCoverage
          || identity.requestedAt > releasedThroughRequestedAt)
        && identity.requestedAt > storedPendingAt
      ))
      .at(-1) || null;
    const marker = retryIdentity
      ? {
          schemaVersion: MANUAL_OFF_ADMISSION_SCHEMA_VERSION,
          state: 'pending',
          token: retryIdentity.token,
          requestedAt: retryIdentity.requestedAt,
          localMutationObservedAt:
            Number(retryIdentity.localMutationObservedAt) || 0,
          localMutationPredecessorRetryAlarmNames: [],
          localMutationPredecessorCoverageComplete: false,
          localMutationPredecessorSuccessorObservedAt: 0,
          localMutationPredecessorSuccessorIdentity: ''
        }
      : storedMarker;
    // 用户消息可以在 initReady 前同步 claim。迟到的启动读取不能把 action
    // 改回 OFF，也不能先消费 remote disable；但旧 pending identity 必须作为
    // predecessor 留给后到用户 authority 原子 tombstone，否则旧 alarm 会在
    // 下一次 SW 重启复活。
    if (intentEpochAtRead !== manualToggleIntentEpoch) {
      startupRestoreSupersedingIntentEpoch = manualToggleIntentEpoch;
      startupDeferredDisableSupersededByUserIntent =
        deferredSyncDisablePending;
      if (isPendingManualOffAdmissionValue(marker)) {
        manualOffAdmissionPredecessorRequestedAt = Math.max(
          manualOffAdmissionPredecessorRequestedAt,
          Number(marker.requestedAt) || 0
        );
        manualOffAdmissionPredecessorTokens = [...new Set([
          ...manualOffAdmissionPredecessorTokens,
          String(marker.token || '')
        ].filter(Boolean))];
        manualOffAutomaticOnBlocked = true;
      } else if (marker != null && marker?.state !== 'released') {
        manualOffAutomaticOnBlocked = true;
      }
      return;
    }
    startupRestoreSupersedingIntentEpoch = 0;
    startupDeferredDisableSupersededByUserIntent = false;
    const markerLocalMutationObservedAt =
      Number(marker?.localMutationObservedAt) || 0;
    if (isPendingManualOffAdmissionValue(marker)
        && localTerminalAuthorityCoversObservedAt(
          markerLocalMutationObservedAt
        )) {
      // 已完成的用户 ON/OFF/disable authority 可能在 terminal getAll 后才
      // 看见旧 A。终态 M receipt 与 A 自带的 M observedAt 建立跨 SW
      // lineage；普通或失败中的 M 没有这张 receipt，仍按 OFF fail-close。
      manualToggleIntentEpoch += 1;
      manualToggleIntentAction = completedLocalTerminalAuthority.action;
      manualToggleIntentSource = 'completed-recovery';
      manualToggleIntentCompletedEpoch = manualToggleIntentEpoch;
      manualToggleIntentCompletedAction = manualToggleIntentAction;
      manualOffAdmissionToken = '';
      manualOffAdmissionRequestedAt = 0;
      manualOffAdmissionPredecessorRequestedAt = Math.max(
        manualOffAdmissionPredecessorRequestedAt,
        Number(marker.requestedAt) || 0
      );
      manualOffAdmissionPredecessorTokens = [...new Set([
        ...manualOffAdmissionPredecessorTokens,
        String(marker.token || '')
      ].filter(Boolean))];
      manualOffAdmissionLoaded = true;
      manualOffAutomaticOnBlocked = true;
      const terminalized = await finalizeCompletedManualToggleAuthority(
        manualToggleIntentEpoch,
        manualToggleIntentAction,
        completedLocalTerminalAuthority.observedAt
      ).catch(() => false);
      if (!terminalized) {
        void createAlarm(MANUAL_OFF_ADMISSION_RETRY_ALARM, {
          delayInMinutes: 1,
          periodInMinutes: 1
        });
      }
      return;
    }
    if (marker == null || marker?.state === 'released') {
      manualOffAdmissionToken = '';
      manualOffAdmissionRequestedAt = 0;
      manualOffAdmissionRestoredFromStorage = false;
      manualOffAdmissionLocalMutationObservedAt = 0;
      manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
      manualOffAdmissionMutationCoverageComplete = false;
      manualOffAdmissionPredecessorSuccessorObservedAt = 0;
      manualOffAdmissionPredecessorSuccessorIdentity = '';
      manualOffAutomaticOnBlocked = false;
      await clearManualOffRetryAlarmsThrough(
        manualOffAdmissionReleasedThroughRequestedAt
      ).catch(() => {});
      return;
    }
    if (!isPendingManualOffAdmissionValue(marker)) {
      manualOffAdmissionToken = '';
      manualOffAdmissionRequestedAt = 0;
      manualOffAdmissionRestoredFromStorage = false;
      manualOffAdmissionLocalMutationObservedAt = 0;
      manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
      manualOffAdmissionMutationCoverageComplete = false;
      manualOffAdmissionPredecessorSuccessorObservedAt = 0;
      manualOffAdmissionPredecessorSuccessorIdentity = '';
      manualOffAutomaticOnBlocked = true;
      const error = new Error('手动关机准入标记格式无效');
      console.warn('[AC扩展] 手动关机准入标记损坏，保持自动 ON 阻断');
      void appendDiagnosticLog('warn', 'manual-off-admission-invalid', error);
      return;
    }
    manualToggleIntentEpoch += 1;
    manualToggleIntentAction = 'off';
    manualToggleIntentSource = 'recovery';
    manualOffAdmissionToken = marker.token;
    manualOffAdmissionRequestedAt = Number(marker.requestedAt) || Date.now();
    manualOffAdmissionRestoredFromStorage = true;
    manualOffAdmissionLocalMutationObservedAt =
      Number(marker.localMutationObservedAt) || 0;
    manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [...new Set(
      (Array.isArray(marker.localMutationPredecessorRetryAlarmNames)
        ? marker.localMutationPredecessorRetryAlarmNames
        : [])
        .map(value => String(value || ''))
        .filter(Boolean)
    )];
    manualOffAdmissionMutationCoverageComplete =
      marker.localMutationPredecessorCoverageComplete === true;
    manualOffAdmissionPredecessorSuccessorObservedAt =
      Number(marker.localMutationPredecessorSuccessorObservedAt) || 0;
    manualOffAdmissionPredecessorSuccessorIdentity =
      String(marker.localMutationPredecessorSuccessorIdentity || '');
    manualOffAutomaticOnBlocked = true;
    // periodic alarm 覆盖整个 pending -> released 事务；只有 released
    // tombstone 与 schedule 已原子落盘后才能清除。
  } catch (error) {
    adoptLocalTerminalAuthority(
      observedStored?.[LOCAL_TERMINAL_AUTHORITY_KEY]
    );
    startupManualOffClassificationPending = true;
    startupManualOffClassificationIntentEpoch = intentEpochAtRead;
    const partialMarker = observedStored?.[MANUAL_OFF_ADMISSION_KEY];
    const partialDeferredDisable = observedStored?.[DEFERRED_SYNC_DISABLE_KEY];
    if (deferredDisableEpochAtRead !== deferredSyncDisableEpoch) {
      // 读取失败不拥有期间已到达的 F2/T2。保留当前完整 tuple/lineage/sets，
      // 只吸收确知 tombstone 与 durable cutoff；fresh repair 负责重读三源。
      reserveDurableSyncAuthorityPreBaselineSequencesThrough(Math.max(
        Number(partialDeferredDisable?.authorityPreBaselineSequence) || 0,
        Number(
          partialDeferredDisable?.successor
            ?.authorityPreBaselineSequence
        ) || 0,
        ...observedDeferredDisableRetryAlarmIdentities.map(identity => (
          Number(identity.authorityPreBaselineSequence) || 0
        )),
        ...observedDeferredSuccessorRetryAlarmIdentities.map(identity => (
          Number(identity.authorityPreBaselineSequence) || 0
        ))
      ));
      const partialReleasedDisableRetryAlarmNames =
        Array.isArray(partialDeferredDisable?.releasedRetryAlarmNames)
          ? partialDeferredDisable.releasedRetryAlarmNames
            .map(value => String(value || ''))
            .filter(Boolean)
          : [];
      for (const name of partialReleasedDisableRetryAlarmNames) {
        deferredSyncDisableReleasedRetryAlarmNames.add(name);
      }
      for (const identity of observedDeferredDisableRetryAlarmIdentities) {
        if (!deferredSyncDisableRetryAlarmNames.has(identity.name)) {
          deferredSyncDisableReleasedRetryAlarmNames.add(identity.name);
        }
      }
      const partialReleasedSuccessorRetryAlarmNames =
        Array.isArray(
          partialDeferredDisable?.releasedSuccessorRetryAlarmNames
        )
          ? partialDeferredDisable.releasedSuccessorRetryAlarmNames
            .map(value => String(value || ''))
            .filter(Boolean)
          : [];
      for (const name of partialReleasedSuccessorRetryAlarmNames) {
        deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
      }
      recordCommittedLocalScheduleMutation(Math.max(
        Number(observedStored?.[LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]) || 0,
        Number(partialDeferredDisable?.localMutationCutoffObservedAt) || 0
      ));
      manualOffAdmissionLoaded = true;
      startupRestoreSupersedingIntentEpoch =
        intentEpochAtRead !== manualToggleIntentEpoch
          ? manualToggleIntentEpoch
          : 0;
      if (intentEpochAtRead === manualToggleIntentEpoch) {
        manualOffAdmissionToken = '';
        manualOffAdmissionRequestedAt = 0;
        manualOffAdmissionRestoredFromStorage = false;
        manualOffAdmissionLocalMutationObservedAt = 0;
        manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
        manualOffAdmissionMutationCoverageComplete = false;
        manualOffAdmissionPredecessorSuccessorObservedAt = 0;
        manualOffAdmissionPredecessorSuccessorIdentity = '';
        manualOffAutomaticOnBlocked = true;
      }
      void Promise.allSettled([
        ...observedDeferredSuccessorRetryAlarmIdentities.map(identity => (
          createDeferredSyncSuccessorClassificationWake(
            identity,
            'startup superseded partial-read unknown T lineage'
          )
        )),
        scheduleSyncRetry('adopt')
      ]);
      console.warn(
        '[AC扩展] 启动安全读取失败但已有更新 authority；保留当前 F/T 并等待 fresh 分类:',
        error?.message
      );
      void appendDiagnosticLog('warn', 'manual-off-admission-read', error);
      return;
    }
    reserveDurableSyncAuthorityPreBaselineSequencesThrough(Math.max(
      Number(partialDeferredDisable?.authorityPreBaselineSequence) || 0,
      Number(
        partialDeferredDisable?.successor?.authorityPreBaselineSequence
      ) || 0,
      ...observedDeferredDisableRetryAlarmIdentities.map(identity => (
        Number(identity.authorityPreBaselineSequence) || 0
      )),
      ...observedDeferredSuccessorRetryAlarmIdentities.map(identity => (
        Number(identity.authorityPreBaselineSequence) || 0
      ))
    ));
    const partialReleasedDisableRetryAlarmNames = new Set(
      Array.isArray(partialDeferredDisable?.releasedRetryAlarmNames)
        ? partialDeferredDisable.releasedRetryAlarmNames
          .map(value => String(value || ''))
          .filter(Boolean)
        : []
    );
    const partialLiveDisableRetryAlarms =
      observedDeferredDisableRetryAlarmIdentities.filter(identity => (
        !partialReleasedDisableRetryAlarmNames.has(identity.name)
      ));
    const partialConservativeDisableRecovery =
      selectLatestDeferredSyncDisableCredential({
        durableRecord: partialDeferredDisable,
        retryAlarmIdentities: partialLiveDisableRetryAlarms
      });
    const partialRecoveredDisableCredential =
      partialConservativeDisableRecovery.credential;
    const partialLatestDisableSafetyCutoffObservedAt = Math.max(
      Number(partialDeferredDisable?.safetyCutoffObservedAt) || 0,
      partialDeferredDisable?.pending === true
        ? Number(partialDeferredDisable.receivedAt) || 0
        : 0,
      ...partialLiveDisableRetryAlarms.map(identity => (
        Number(identity.receivedAt) || 0
      ))
    );
    const partialReleasedSuccessorRetryAlarmNames = new Set(
      Array.isArray(partialDeferredDisable?.releasedSuccessorRetryAlarmNames)
        ? partialDeferredDisable.releasedSuccessorRetryAlarmNames
          .map(value => String(value || ''))
          .filter(Boolean)
        : []
    );
    deferredSyncSuccessorReleasedRetryAlarmNames = new Set(
      partialReleasedSuccessorRetryAlarmNames
    );
    deferredSyncDisableObservedAt =
      Number(partialRecoveredDisableCredential?.receivedAt)
      || partialLatestDisableSafetyCutoffObservedAt;
    deferredSyncDisableAuthorityOrderObservedAt =
      Number(
        partialRecoveredDisableCredential?.authorityOrderObservedAt
      ) || deferredSyncDisableObservedAt;
    deferredSyncDisableAuthorityPreBaselineSequence =
      Number(
        partialRecoveredDisableCredential
          ?.authorityPreBaselineSequence
      ) || 0;
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      Number(
        partialDeferredDisable?.releasedSuccessorThroughObservedAt
      ) || 0,
      partialLatestDisableSafetyCutoffObservedAt,
      deferredSyncDisableAuthorityOrderObservedAt
    );
    localScheduleMutationCommittedObservedAt = Math.max(
      localScheduleMutationCommittedObservedAt,
      Number(observedStored?.[LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]) || 0,
      Number(partialDeferredDisable?.localMutationCutoffObservedAt) || 0
    );
    localScheduleMutationObservedAt = Math.max(
      localScheduleMutationObservedAt,
      localScheduleMutationCommittedObservedAt
    );
    // 任一 startup source 读取失败时，不能用 observedAt 把已见 T 预塞
    // mailbox；它们保持原 exact alarm，等 fresh 全源读取/lineage 分类。
    deferredSyncSuccessorRetryAlarmEntries = new Map();
    const partialDeferredSuccessor = null;
    const partialDeferredSuccessorObservedAt = 0;
    deferredSyncDisableRetryAlarmNames = new Set(
      partialLiveDisableRetryAlarms.map(identity => identity.name)
    );
    deferredSyncDisableReleasedRetryAlarmNames = new Set(
      partialReleasedDisableRetryAlarmNames
    );
    remoteSyncAuthorityObservedAt = Math.max(
      remoteSyncAuthorityObservedAt,
      partialLatestDisableSafetyCutoffObservedAt,
      deferredSyncSuccessorReleasedThroughObservedAt,
      localScheduleMutationCommittedObservedAt,
      partialDeferredSuccessorObservedAt,
      ...observedDeferredDisableRetryAlarmIdentities.map(identity => (
        Number(identity.receivedAt) || 0
      )),
      Number(observedDeferredSuccessorRetryAlarmIdentities.at(-1)?.observedAt)
        || 0
    );
    // 任一 admission / credential 读取失败只建立 transient classification
    // block，不能伪装成新的 F/Lamport authority。否则 synthetic 墙钟会把
    // 首轮 getAll 漏掉的真实 manual-OFF 或 alarm-only T/F 错判为 predecessor。
    const partialPending = isPendingManualOffAdmissionValue(partialMarker)
      ? [
          {
            token: String(partialMarker.token || ''),
            requestedAt: Number(partialMarker.requestedAt) || 0
          }
        ]
      : [];
    const partialIdentities = [
      ...partialPending,
      ...observedRetryAlarmIdentities
    ];
    if (partialIdentities.length > 0) {
      manualOffAdmissionPredecessorRequestedAt = Math.max(
        manualOffAdmissionPredecessorRequestedAt,
        ...partialIdentities.map(identity => Number(identity.requestedAt) || 0)
      );
      manualOffAdmissionPredecessorTokens = [...new Set([
        ...manualOffAdmissionPredecessorTokens,
        ...partialIdentities.map(identity => String(identity.token || ''))
      ].filter(Boolean))];
    }
    manualOffAdmissionLoaded = true;
    deferredSyncDisableLoaded = true;
    deferredSyncDisablePending = true;
    deferredSyncDisableSyntheticReadFailure = true;
    deferredSyncDisableEpoch += 1;
    const partialDurableSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        partialDeferredDisable?.safetyAuthorityId
      );
    const partialLiveSafetyAuthorityIds = [...new Set(
      partialLiveDisableRetryAlarms
        .map(identity => identity.safetyAuthorityId)
        .filter(Boolean)
    )];
    deferredSyncDisableSafetyAuthorityId =
      localSafetyStateReadComplete
          && deferredDisableRetryAlarmReadComplete
          && partialDeferredDisable?.pending === true
          && partialDurableSafetyAuthorityId
          && partialLiveDisableRetryAlarms.every(identity => (
            identity.safetyAuthorityId
              === partialDurableSafetyAuthorityId
            || identity.name
              === String(partialDeferredDisable?.retryAlarmName || '')
          ))
        ? partialDurableSafetyAuthorityId
        : localSafetyStateReadComplete
            && deferredDisableRetryAlarmReadComplete
            && partialDeferredDisable?.pending !== true
            && partialLiveDisableRetryAlarms.length > 0
            && partialLiveDisableRetryAlarms.every(identity => (
              identity.safetyAuthorityId
              && identity.safetyAuthorityId
                === partialLiveSafetyAuthorityIds[0]
            ))
          ? partialLiveSafetyAuthorityIds[0]
          : createDeferredSyncDisableSafetyAuthorityId();
    deferredSyncLastClearedSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        partialDeferredDisable?.releasedSafetyAuthorityId
      ) || deferredSyncLastClearedSafetyAuthorityId;
    deferredSyncSuccessorEnumerationPendingEpoch = deferredSyncDisableEpoch;
    const partialRecoveredDisableRemote =
      partialConservativeDisableRecovery.remote;
    deferredSyncDisableRemoteSnapshot =
      partialRecoveredDisableRemote
        && typeof partialRecoveredDisableRemote === 'object'
        ? { ...partialRecoveredDisableRemote, enabled: false }
        : { enabled: false, syncedAt: 0 };
    deferredSyncDisableRemoteSnapshotComplete =
      localSafetyStateReadComplete
      && deferredDisableRetryAlarmReadComplete
      && (partialConservativeDisableRecovery.complete
        // 没有任何 F credential 时，这是本机因读取失败创建的 synthetic F，
        // syncedAt=0 是完整语义；只有 legacy alarm-only F 缺失远端水位。
        || (!partialDeferredDisable?.remote
          && partialLiveDisableRetryAlarms.length === 0));
    // read-failure block 没有 durable receipt；release 前必须 fresh 重读
    // manual/F/T 三类凭证，并为真实 F 统一重写 exact snapshot。
    deferredSyncDisableDurableReceiptEpoch = 0;
    deferredSyncDisableDurableReceiptIdentity = '';
    deferredSyncDisableSuccessorSnapshot = partialDeferredSuccessor;
    deferredSyncDisableSuccessorObservedAt =
      partialDeferredSuccessorObservedAt;
    deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
    deferredSyncDisableSuccessorRetryAlarmName = '';
    deferredSyncDisableSuccessorLocalAuthorityGeneration =
      partialDeferredSuccessor
        ? localScheduleAuthorityGenerationAtRead
        : 0;
    deferredSyncDisableLocalMutationGeneration =
      localScheduleMutationGenerationAtRead;
    deferredSyncDisableSuccessorMutationGeneration =
      partialDeferredSuccessor
        ? localScheduleMutationGenerationAtRead
        : 0;
    deferredSyncDisableLocalScheduleAuthorityGeneration =
      localScheduleAuthorityGenerationAtRead;
    startupDeferredDisableSupersededByUserIntent =
      intentEpochAtRead !== manualToggleIntentEpoch;
    startupRestoreSupersedingIntentEpoch =
      intentEpochAtRead !== manualToggleIntentEpoch
        ? manualToggleIntentEpoch
        : 0;
    if (intentEpochAtRead === manualToggleIntentEpoch) {
      manualOffAdmissionToken = '';
      manualOffAdmissionRequestedAt = 0;
      manualOffAdmissionRestoredFromStorage = false;
      manualOffAdmissionLocalMutationObservedAt = 0;
      manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
      manualOffAdmissionMutationCoverageComplete = false;
      manualOffAdmissionPredecessorSuccessorObservedAt = 0;
      manualOffAdmissionPredecessorSuccessorIdentity = '';
      manualOffAutomaticOnBlocked = true;
    }
    if (observedDeferredSuccessorRetryAlarmIdentities.length > 0) {
      void Promise.allSettled([
        ...observedDeferredSuccessorRetryAlarmIdentities.map(identity => (
          createDeferredSyncSuccessorClassificationWake(
            identity,
            'startup partial-read unknown T lineage'
          )
        )),
        scheduleSyncRetry('adopt')
      ]);
    }
    // 任一 startup source 读取失败时，不能把早到 T 绑定到本轮随机
    // synthetic F lineage。保留原 exact alarm + pending envelope，等 fresh
    // manual/F/T 全源分类成功后再重绑。
    console.warn('[AC扩展] 读取手动关机准入标记失败，保持自动 ON 阻断:', error?.message);
    void appendDiagnosticLog('warn', 'manual-off-admission-read', error);
  }
}

function snapshotScheduleForLocalPersistence() {
  if (!schedule.smartMode?.enabled) {
    schedule.smartOnBoundaryAt = 0;
    clearPwmRetryState();
  }
  return { ...schedule };
}

function snapshotDeferredSyncDisableMailbox(reason = '') {
  if (deferredSyncDisablePending) {
    return {
      pending: true,
      ...(deferredSyncDisableSafetyAuthorityId
        ? {
            safetyAuthorityId:
              deferredSyncDisableSafetyAuthorityId
          }
        : {}),
      receivedAt: deferredSyncDisableObservedAt,
      authorityOrderObservedAt:
        deferredSyncDisableAuthorityOrderObservedAt
        || deferredSyncDisableObservedAt,
      ...(deferredSyncDisableAuthorityPreBaselineSequence > 0
        ? {
            authorityPreBaselineSequence:
              deferredSyncDisableAuthorityPreBaselineSequence
          }
        : {}),
      safetyCutoffObservedAt: deferredSyncDisableObservedAt,
      localMutationCutoffObservedAt:
        localScheduleMutationCommittedObservedAt,
      updatedAt: Date.now(),
      reason: String(reason || ''),
      remote: deferredSyncDisableRemoteSnapshot
        ? { ...deferredSyncDisableRemoteSnapshot }
        : { enabled: false, syncedAt: 0 },
      ...(deferredSyncDisableSuccessorSnapshot
        ? {
            successor: {
              observedAt: deferredSyncDisableSuccessorObservedAt
                || Date.now(),
              ...(deferredSyncDisableSuccessorRetryAlarmName
                ? {
                    retryAlarmName:
                      deferredSyncDisableSuccessorRetryAlarmName
                  }
                : {}),
              authorityOrderObservedAt:
                deferredSyncDisableSuccessorAuthorityOrderObservedAt
                || deferredSyncDisableSuccessorObservedAt
                || Date.now(),
              ...(deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
                ? {
                    authorityPreBaselineSequence:
                      deferredSyncDisableSuccessorAuthorityPreBaselineSequence
                  }
                : {}),
              ...(deferredSyncDisableSafetyAuthorityId
                ? {
                    predecessorSafetyAuthorityId:
                      deferredSyncDisableSafetyAuthorityId
                  }
                : {}),
              remote: { ...deferredSyncDisableSuccessorSnapshot }
            }
          }
        : {}),
      releasedRetryAlarmNames: [
        ...deferredSyncDisableReleasedRetryAlarmNames
      ],
      releasedSuccessorRetryAlarmNames: [
        ...deferredSyncSuccessorReleasedRetryAlarmNames
      ],
      releasedSuccessorThroughObservedAt:
        deferredSyncSuccessorReleasedThroughObservedAt
    };
  }
  if (deferredSyncDisableSuccessorSnapshot) {
    return {
      pending: false,
      safetyCleared: true,
      safetyCutoffObservedAt: deferredSyncDisableObservedAt,
      localMutationCutoffObservedAt:
        localScheduleMutationCommittedObservedAt,
      updatedAt: Date.now(),
      reason: String(reason || ''),
      successor: {
        observedAt: deferredSyncDisableSuccessorObservedAt
          || Date.now(),
        ...(deferredSyncDisableSuccessorRetryAlarmName
          ? {
              retryAlarmName:
                deferredSyncDisableSuccessorRetryAlarmName
            }
          : {}),
        authorityOrderObservedAt:
          deferredSyncDisableSuccessorAuthorityOrderObservedAt
          || deferredSyncDisableSuccessorObservedAt
          || Date.now(),
        ...(deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
          ? {
              authorityPreBaselineSequence:
                deferredSyncDisableSuccessorAuthorityPreBaselineSequence
            }
          : {}),
        remote: { ...deferredSyncDisableSuccessorSnapshot }
      },
      releasedRetryAlarmNames: [
        ...deferredSyncDisableReleasedRetryAlarmNames
      ],
      releasedSuccessorRetryAlarmNames: [
        ...deferredSyncSuccessorReleasedRetryAlarmNames
      ],
      releasedSuccessorThroughObservedAt:
        deferredSyncSuccessorReleasedThroughObservedAt
    };
  }
  return null;
}

function mergeDeferredSyncSafetyMetadata(record) {
  const snapshot = record && typeof record === 'object' ? record : {};
  return {
    ...snapshot,
    ...(snapshot.pending === true
        && deferredSyncDisableSafetyAuthorityId
      ? {
          safetyAuthorityId:
            deferredSyncDisableSafetyAuthorityId
        }
      : {}),
    ...(snapshot.pending === false
        && (deferredSyncDisableSafetyAuthorityId
          || deferredSyncLastClearedSafetyAuthorityId)
      ? {
          releasedSafetyAuthorityId:
            deferredSyncDisableSafetyAuthorityId
            || deferredSyncLastClearedSafetyAuthorityId
        }
      : {}),
    safetyCutoffObservedAt: Math.max(
      Number(snapshot.safetyCutoffObservedAt) || 0,
      deferredSyncDisableObservedAt
    ),
    localMutationCutoffObservedAt: Math.max(
      Number(snapshot.localMutationCutoffObservedAt) || 0,
      localScheduleMutationCommittedObservedAt
    ),
    releasedRetryAlarmNames: [...new Set([
      ...deferredSyncDisableReleasedRetryAlarmNames,
      ...(Array.isArray(snapshot.releasedRetryAlarmNames)
        ? snapshot.releasedRetryAlarmNames
        : [])
    ])],
    releasedSuccessorRetryAlarmNames: [...new Set([
      ...deferredSyncSuccessorReleasedRetryAlarmNames,
      ...(Array.isArray(snapshot.releasedSuccessorRetryAlarmNames)
        ? snapshot.releasedSuccessorRetryAlarmNames
        : [])
    ])],
    releasedSuccessorThroughObservedAt: Math.max(
      Number(snapshot.releasedSuccessorThroughObservedAt) || 0,
      deferredSyncSuccessorReleasedThroughObservedAt
    ),
    successorPredecessorCoverageThroughObservedAt: Math.max(
      Number(
        snapshot.successorPredecessorCoverageThroughObservedAt
      ) || 0,
      snapshot.successorPredecessorCoverageComplete === true
        ? Number(snapshot.safetyCutoffObservedAt) || 0
        : 0,
      deferredSyncDisablePending
          && deferredSyncSuccessorEnumerationPendingEpoch === 0
        ? deferredSyncDisableObservedAt
        : 0
    )
  };
}

function getDeferredSyncDisableReceiptIdentity() {
  return getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot);
}

function markDeferredSyncDisableDurableReceipt(epoch, identity) {
  if (!deferredSyncDisablePending
      || !deferredSyncDisableRemoteSnapshotComplete
      || deferredSyncDisableEpoch !== epoch
      || getDeferredSyncDisableReceiptIdentity() !== identity) {
    return false;
  }
  deferredSyncDisableDurableReceiptEpoch = epoch;
  deferredSyncDisableDurableReceiptIdentity = identity;
  return true;
}

function hasCurrentDeferredSyncDisableDurableReceipt() {
  return deferredSyncDisablePending
    && deferredSyncDisableRemoteSnapshotComplete
    && deferredSyncDisableDurableReceiptEpoch === deferredSyncDisableEpoch
    && deferredSyncDisableDurableReceiptIdentity
      === getDeferredSyncDisableReceiptIdentity();
}

function isDeferredSyncDisableReleaseReceiptCurrent(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.pending !== deferredSyncDisablePending
      || receipt.epoch !== deferredSyncDisableEpoch) return false;
  if (!receipt.pending) return true;
  return receipt.identity === getDeferredSyncDisableReceiptIdentity()
    && hasCurrentDeferredSyncDisableDurableReceipt()
    && receipt.watermarkDurable === true
    && lastSyncedAt >= receipt.syncedAt;
}

async function repairCurrentDeferredSyncDisableDurableReceipt(
  expectedEpoch,
  expectedIdentity,
  reason = ''
) {
  const startupManualClassificationAtRead =
    startupManualOffClassificationPending;
  const manualIntentEpochAtRead = startupManualClassificationAtRead
    ? startupManualOffClassificationIntentEpoch
    : manualToggleIntentEpoch;
  const receiptIsCurrent = () => (
    deferredSyncDisablePending
    && deferredSyncDisableEpoch === expectedEpoch
    && getDeferredSyncDisableReceiptIdentity() === expectedIdentity
  );
  const repaired = await runSerializedCriticalLocalStateWrite(async () => {
    if (!receiptIsCurrent()) return false;

    const storedSafetyState = await chrome.storage.local.get([
      DEFERRED_SYNC_DISABLE_KEY,
      MANUAL_OFF_ADMISSION_KEY
    ]);
    if (!receiptIsCurrent()) return false;
    const storedDeferredDisable =
      storedSafetyState?.[DEFERRED_SYNC_DISABLE_KEY];
    const durableReleasedDisableRetryAlarmNames = new Set([
      ...deferredSyncDisableReleasedRetryAlarmNames,
      ...(Array.isArray(storedDeferredDisable?.releasedRetryAlarmNames)
        ? storedDeferredDisable.releasedRetryAlarmNames
          .map(value => String(value || ''))
          .filter(Boolean)
        : [])
    ]);
    const durableReleasedSuccessorRetryAlarmNames = new Set([
      ...deferredSyncSuccessorReleasedRetryAlarmNames,
      ...(Array.isArray(
        storedDeferredDisable?.releasedSuccessorRetryAlarmNames
      )
        ? storedDeferredDisable.releasedSuccessorRetryAlarmNames
          .map(value => String(value || ''))
          .filter(Boolean)
        : [])
    ]);
    deferredSyncDisableReleasedRetryAlarmNames =
      durableReleasedDisableRetryAlarmNames;
    deferredSyncSuccessorReleasedRetryAlarmNames =
      durableReleasedSuccessorRetryAlarmNames;
    localScheduleMutationCommittedObservedAt = Math.max(
      localScheduleMutationCommittedObservedAt,
      Number(storedDeferredDisable?.localMutationCutoffObservedAt) || 0
    );
    localScheduleMutationObservedAt = Math.max(
      localScheduleMutationObservedAt,
      localScheduleMutationCommittedObservedAt
    );
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      deferredSyncSuccessorReleasedThroughObservedAt,
      Number(storedDeferredDisable?.releasedSuccessorThroughObservedAt) || 0
    );
    remoteSyncAuthorityObservedAt = Math.max(
      remoteSyncAuthorityObservedAt,
      deferredSyncDisableObservedAt,
      deferredSyncDisableAuthorityOrderObservedAt,
      deferredSyncSuccessorReleasedThroughObservedAt,
      localScheduleMutationCommittedObservedAt,
      Number(storedDeferredDisable?.successor?.observedAt) || 0,
      Number(
        storedDeferredDisable?.successor?.authorityOrderObservedAt
      ) || 0
    );
    // startup catch 分支可能漏读一个更晚 exact F。receipt repair 不再用
    // numeric coverage 从旧 local snapshot 复活 T；完整 startup 已按
    // safetyAuthorityId 恢复，剩余 alarm/store 交给 stable classifier。
    await waitForDeferredSyncDisableRetryAlarmOperationsToSettle();
    const disableRetryAlarmIdentities =
      (await getDeferredSyncDisableRetryAlarmIdentities())
        .filter(identity => (
          !durableReleasedDisableRetryAlarmNames.has(identity.name)
        ));
    if (!receiptIsCurrent()) return false;
    if (startupManualClassificationAtRead
        && startupManualOffClassificationPending
        && startupManualOffClassificationIntentEpoch
          === manualIntentEpochAtRead) {
      await waitForManualOffRetryAlarmOperationsToSettle();
      const manualOffRetryAlarmIdentities =
        await getManualOffRetryAlarmIdentities();
      if (!receiptIsCurrent()) return false;
      classifyManualOffAdmissionCredentials(
        storedSafetyState?.[MANUAL_OFF_ADMISSION_KEY],
        manualOffRetryAlarmIdentities,
        manualIntentEpochAtRead
      );
      startupManualOffClassificationPending = false;
      startupManualOffClassificationIntentEpoch = 0;
    }
    if (deferredSyncDisableSyntheticReadFailure
        && storedDeferredDisable?.pending !== true
        && disableRetryAlarmIdentities.length === 0) {
      // transient startup F 不是事件 authority。未知 alarm 即使带旧 F
      // lineage，也可能已被更晚本机 M 淘汰；不从 alarm 直接恢复，当前
      // sync store 会由 fixed adopt retry fresh 读取。
      // startup 读取不确定性只是 transient admission block，不是新的跨设备
      // disable authority。fresh local+alarm 分类证明没有 live F 后，在任何
      // schedule=false 写入前撤销 synthetic block，保留已恢复的 durable T。
      finalizeDeferredSyncDisableClearInMemory({
        preserveSuccessor: !!deferredSyncDisableSuccessorSnapshot
      });
      return false;
    }
    const hydratedDisableRetryAlarmIdentities =
      disableRetryAlarmIdentities.map(identity => (
        !identity.remote
          && deferredSyncDisableRemoteSnapshotComplete
          && deferredSyncDisableRetryAlarmNames.has(identity.name)
          ? {
              ...identity,
              // legacy name 自身仍不伪造 remote watermark；只有 fresh/full
              // current F 已建立后，才允许它加入同一 safety batch exact set。
              remote: deferredSyncDisableRemoteSnapshot
            }
          : identity
      ));
    const conservativeRecovery =
      selectLatestDeferredSyncDisableCredential({
        durableRecord: storedDeferredDisable,
        memoryCredential: deferredSyncDisableSyntheticReadFailure
          ? null
          : {
              receivedAt: deferredSyncDisableObservedAt,
              authorityOrderObservedAt:
                deferredSyncDisableAuthorityOrderObservedAt
                || deferredSyncDisableObservedAt,
              authorityPreBaselineSequence:
                deferredSyncDisableAuthorityPreBaselineSequence,
              safetyAuthorityId:
                deferredSyncDisableSafetyAuthorityId,
              remote: deferredSyncDisableRemoteSnapshotComplete
                ? deferredSyncDisableRemoteSnapshot
                : null
            },
        retryAlarmIdentities:
          hydratedDisableRetryAlarmIdentities
      });
    if (!conservativeRecovery.complete) return false;
    const selectedIdentity = getSyncPayloadIdentity(
      conservativeRecovery.remote
    );
    const selectedCredential = conservativeRecovery.credential;
    const selectedCredentialName = String(
      selectedCredential?.name || ''
    );
    const selectedSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        selectedCredential?.safetyAuthorityId
      );
    const selectedCredentialIsNewAuthority =
      selectedIdentity !== expectedIdentity
      || Number(selectedCredential?.receivedAt)
        !== Number(deferredSyncDisableObservedAt)
      || (Number(selectedCredential?.authorityOrderObservedAt)
          || Number(selectedCredential?.receivedAt)
          || 0) !== (
        Number(deferredSyncDisableAuthorityOrderObservedAt)
        || Number(deferredSyncDisableObservedAt)
        || 0
      )
      || (Number(selectedCredential?.authorityPreBaselineSequence) || 0)
        !== Number(
          deferredSyncDisableAuthorityPreBaselineSequence
        )
      || (!!selectedSafetyAuthorityId
        && selectedSafetyAuthorityId
          !== deferredSyncDisableSafetyAuthorityId)
      || (!!selectedCredentialName
        && !deferredSyncDisableRetryAlarmNames.has(
          selectedCredentialName
        ));
    if (selectedCredentialIsNewAuthority) {
      const selectedLiveIdentity = disableRetryAlarmIdentities.find(
        identity => identity.name === selectedCredentialName
      );
      // 不能先只换 remote，再让 T 在下一轮 storage.get 窗口绑定旧
      // lineage。复用完整 new-F claim，一次换 epoch/raw/order/safety/name，
      // 同时 exact tombstone 旧 T；durable writer 排在本 repair 之后执行。
      void deferRemoteSyncDisableWhileManualOffBlocked(
        conservativeRecovery.remote,
        `${reason || 'deferred-sync-disable-repair'}-promote-winner`,
        localScheduleAuthorityGeneration,
        {
          scheduleMutationGeneration:
            localScheduleMutationGeneration,
          credentialReceivedAt:
            Number(selectedCredential.receivedAt) || 0,
          credentialRetryAlarmName: selectedLiveIdentity
            ? selectedCredentialName
            : '',
          credentialSafetyAuthorityId:
            selectedSafetyAuthorityId,
          credentialAuthorityOrderObservedAt:
            Number(
              selectedCredential.authorityOrderObservedAt
            ) || Number(selectedCredential.receivedAt) || 0,
          credentialAuthorityPreBaselineSequence:
            Number(
              selectedCredential.authorityPreBaselineSequence
            ) || 0,
          credentialRemoteComplete: true,
          preserveCredentialAuthority: true,
          recoverFromRetryCredential: !!selectedLiveIdentity
        }
      );
      return false;
    }
    if (!deferredSyncDisableRemoteSnapshotComplete
        || selectedIdentity !== expectedIdentity) {
      deferredSyncDisableRemoteSnapshot = {
        ...conservativeRecovery.remote,
        enabled: false
      };
      deferredSyncDisableRemoteSnapshotComplete = true;
      deferredSyncDisableDurableReceiptEpoch = 0;
      deferredSyncDisableDurableReceiptIdentity = '';
      return false;
    }
    const repairedCredential = conservativeRecovery.credential;
    const repairedAuthorityTuple = normalizeSyncAuthorityOrderTuple({
      observedAt: Number(repairedCredential?.receivedAt) || 0,
      authorityOrderObservedAt:
        Number(repairedCredential?.authorityOrderObservedAt)
        || Number(repairedCredential?.receivedAt)
        || 0,
      authorityPreBaselineSequence:
        Number(repairedCredential?.authorityPreBaselineSequence) || 0
    });
    const repairedSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        repairedCredential?.safetyAuthorityId
      );
    deferredSyncDisableObservedAt =
      repairedAuthorityTuple.observedAt
      || Number(storedDeferredDisable?.safetyCutoffObservedAt)
      || deferredSyncDisableObservedAt;
    deferredSyncDisableAuthorityOrderObservedAt =
      repairedAuthorityTuple.authorityOrderObservedAt
      || deferredSyncDisableObservedAt;
    deferredSyncDisableAuthorityPreBaselineSequence =
      repairedAuthorityTuple.authorityPreBaselineSequence;
    deferredSyncDisableSafetyAuthorityId =
      repairedSafetyAuthorityId
      || createDeferredSyncDisableSafetyAuthorityId();
    deferredSyncDisableRetryAlarmNames = new Set(
      disableRetryAlarmIdentities.map(identity => identity.name)
    );
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      deferredSyncSuccessorReleasedThroughObservedAt,
      deferredSyncDisableAuthorityOrderObservedAt
    );
    remoteSyncAuthorityObservedAt = Math.max(
      remoteSyncAuthorityObservedAt,
      deferredSyncDisableAuthorityOrderObservedAt
    );
    deferredSyncDisableDurableReceiptEpoch = 0;
    deferredSyncDisableDurableReceiptIdentity = '';
    const uncoveredBaselineDisableRetryAlarmNames = [];
    for (const identity of disableRetryAlarmIdentities) {
      const knownLegacyCredential = !identity.remote
        && deferredSyncDisableRetryAlarmNames.has(identity.name);
      if (!identity.remote && !knownLegacyCredential) {
        // 未登记 legacy F 仍是独立的未知 safety credential。
        return false;
      }
      // repair baseline 可以把本轮已经同时看见的多个 complete F 保守折叠
      // 成一个 safety batch（winner payload 已由 conservativeRecovery 选择），
      // 并把每个 exact name 同批 durable。stable final scan 之后新增的 F2
      // 仍不在这组 name 中，只会 abort，不会被顺手 tombstone。
      uncoveredBaselineDisableRetryAlarmNames.push(identity.name);
    }
    if (hasCurrentDeferredSyncDisableDurableReceipt()
        && uncoveredBaselineDisableRetryAlarmNames.length === 0) {
      // 这次 local + exact alarm fresh 分类已完整成功；若本轮源自 startup
      // partial-read，现已证明它是真实 F，而不是仅用于 fail-close 的
      // synthetic admission block。
      deferredSyncDisableSyntheticReadFailure = false;
      return true;
    }

    let predecessorRetryAlarmNames = [];
    let predecessorCoverageComplete = false;
    try {
      predecessorRetryAlarmNames =
        await captureDeferredSyncSuccessorRetryAlarmsThrough(
          deferredSyncDisableAuthorityOrderObservedAt
            || deferredSyncDisableObservedAt,
          {
            includeUnknown: true,
            authorityPreBaselineSequence:
              deferredSyncDisableAuthorityPreBaselineSequence
          }
        );
      predecessorCoverageComplete = true;
    } catch (error) {
      // Durable F 本身优先于枚举完整性。覆盖未知时保留 pending epoch；
      // 下次启动会把所有已见 T exact identity 当作 predecessor。
      console.warn('[AC扩展] 修复 remote disable receipt 时枚举 T 失败:', error?.message);
    }
    if (!receiptIsCurrent()) return false;

    const mailbox = snapshotDeferredSyncDisableMailbox(reason);
    if (!mailbox) return false;
    const coveredDisableRetryAlarmNames =
      uncoveredBaselineDisableRetryAlarmNames;
    mailbox.releasedRetryAlarmNames = [...new Set([
      ...(Array.isArray(mailbox.releasedRetryAlarmNames)
        ? mailbox.releasedRetryAlarmNames
        : []),
      ...coveredDisableRetryAlarmNames
    ])];
    mailbox.releasedSuccessorRetryAlarmNames = [...new Set([
      ...(Array.isArray(mailbox.releasedSuccessorRetryAlarmNames)
        ? mailbox.releasedSuccessorRetryAlarmNames
        : []),
      ...predecessorRetryAlarmNames
    ])];
    if (predecessorCoverageComplete) {
      mailbox.successorPredecessorCoverageThroughObservedAt = Math.max(
        Number(mailbox.successorPredecessorCoverageThroughObservedAt) || 0,
        deferredSyncDisableObservedAt
      );
    }

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await chrome.storage.local.set({
          [DEFERRED_SYNC_DISABLE_KEY]:
            mergeDeferredSyncSafetyMetadata(mailbox)
        });
        if (!receiptIsCurrent()) return false;
        for (const name of coveredDisableRetryAlarmNames) {
          deferredSyncDisableReleasedRetryAlarmNames.add(name);
        }
        for (const name of predecessorRetryAlarmNames) {
          deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
        }
        if (predecessorCoverageComplete) {
          deferredSyncSuccessorEnumerationPendingEpoch = 0;
        }
        const receiptMarked = markDeferredSyncDisableDurableReceipt(
          expectedEpoch,
          expectedIdentity
        );
        if (receiptMarked) {
          deferredSyncDisableSyntheticReadFailure = false;
        }
        return receiptMarked;
      } catch (error) {
        lastError = error;
        if (!receiptIsCurrent()) return false;
      }
    }
    throw lastError || new Error('remote disable durable receipt 修复失败');
  }).catch(error => {
    console.warn('[AC扩展] remote disable durable receipt 修复失败:', error?.message);
    void appendDiagnosticLog(
      'warn',
      'deferred-sync-disable-receipt',
      error
    );
    return false;
  });
  return repaired;
}

async function prepareDeferredSyncDisableForRelease(
  ensureCurrent,
  reason = 'deferred-sync-disable-release'
) {
  const ownerIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  const failClosed = async () => {
    await scheduleSyncRetry('adopt').catch(() => {});
    return null;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!ownerIsCurrent()) return null;
    if (!deferredSyncDisablePending) {
      return Object.freeze({
        pending: false,
        epoch: deferredSyncDisableEpoch,
        identity: '',
        syncedAt: 0,
        watermarkDurable: true
      });
    }

    const epoch = deferredSyncDisableEpoch;
    const identity = getDeferredSyncDisableReceiptIdentity();
    const durable =
      await repairCurrentDeferredSyncDisableDurableReceipt(
        epoch,
        identity,
        `${reason}-receipt`
      );
    if (!ownerIsCurrent()) return null;
    if (epoch !== deferredSyncDisableEpoch
        || identity !== getDeferredSyncDisableReceiptIdentity()) {
      continue;
    }
    if (!durable || !hasCurrentDeferredSyncDisableDurableReceipt()) {
      return failClosed();
    }

    const syncedAt = normalizeSyncAuthorityTimestamp(
      deferredSyncDisableRemoteSnapshot?.syncedAt
    );
    const loadedWatermark = await loadSyncWatermark();
    if (!ownerIsCurrent()) return null;
    if (epoch !== deferredSyncDisableEpoch
        || identity !== getDeferredSyncDisableReceiptIdentity()) {
      continue;
    }
    if (loadedWatermark === null) return failClosed();
    if (syncedAt > 0) {
      const persisted = await persistSyncWatermark(syncedAt);
      if (!ownerIsCurrent()) return null;
      if (epoch !== deferredSyncDisableEpoch
          || identity !== getDeferredSyncDisableReceiptIdentity()) {
        continue;
      }
      if (!persisted) return failClosed();
    }
    const receipt = Object.freeze({
      pending: true,
      epoch,
      identity,
      syncedAt,
      watermarkDurable: true
    });
    if (isDeferredSyncDisableReleaseReceiptCurrent(receipt)) {
      return receipt;
    }
  }
  return failClosed();
}

function isStableDeferredSyncDisableReleaseReceiptCurrent(receipt) {
  if (!receipt || typeof receipt !== 'object'
      || !isDeferredSyncDisableReleaseReceiptCurrent(receipt)) {
    return false;
  }
  return receipt.remoteDisableArrivalGeneration
      === remoteDisableArrivalGeneration
    && receipt.syncInboundArrivalGeneration
      === syncInboundArrivalGeneration
    && receipt.safetyAuthorityId
      === deferredSyncDisableSafetyAuthorityId
    && receipt.successorIdentity
      === getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
    && receipt.successorObservedAt
      === (deferredSyncDisableSuccessorSnapshot
        ? deferredSyncDisableSuccessorObservedAt
        : 0)
    && receipt.successorRetryAlarmName
      === (deferredSyncDisableSuccessorSnapshot
        ? deferredSyncDisableSuccessorRetryAlarmName
        : '');
}

function isStableSyncStoreAuthorityReceiptCurrent(
  receipt,
  ensureCurrent = null
) {
  return !!receipt
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
    && receipt.inboundGeneration === syncInboundArrivalGeneration
    && receipt.outboundGeneration === syncPublishGeneration
    && receipt.writeChain === syncWriteChain
    && syncWriteOperationsInFlight === 0
    && receipt.watermarkWriteGeneration === syncWatermarkWriteGeneration
    && receipt.watermarkWriteChain === syncWatermarkWriteChain
    && syncWatermarkWritesInFlight === 0
    && receipt.publishRetryAlarmGeneration
      === syncPublishRetryAlarmWriteGeneration
    && syncPublishRetryAlarmWritesInFlight === 0;
}

async function readStableSyncStoreAuthorityReceipt(
  ensureCurrent = null,
  {
    attempts = 3,
    waitForExistingOutbound = false,
    outboundWaitTimeoutMs = 4000
  } = {}
) {
  const ownerIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  if (!ownerIsCurrent() || !chrome.storage?.sync) return null;
  const retryAlarmIdentity = alarm => JSON.stringify({
    present: !!alarm,
    scheduledTime: Number(alarm?.scheduledTime) || 0,
    periodInMinutes: Number(alarm?.periodInMinutes) || 0
  });
  const waitForLocalWriterBarriers = (watermarkChain, retryAlarmChain) => (
    new Promise(resolve => {
      const timeoutId = setTimeout(() => resolve(false), 1500);
      Promise.allSettled([watermarkChain, retryAlarmChain]).then(() => {
        clearTimeout(timeoutId);
        resolve(true);
      });
    })
  );
  const waitForExistingOutboundBarrier = outboundChain => (
    new Promise(resolve => {
      const timeoutId = setTimeout(
        () => resolve(false),
        Math.max(0, Number(outboundWaitTimeoutMs) || 0)
      );
      Promise.resolve(outboundChain).then(
        () => {
          clearTimeout(timeoutId);
          resolve(true);
        },
        () => {
          clearTimeout(timeoutId);
          resolve(true);
        }
      );
    })
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // F safety path 不等待可能卡住的旧 sync.set；它会保留 durable
    // marker/alarm 并由 fixed retry 重入。明确 ON 已先 durable 写入 OFF
    // admission，允许 opt-in 等待捕获的 predecessor writer，再从物理 store
    // 重新分类；等待期间任何 inbound/remote-F/owner 变化都使本次请求 stale。
    if (!ownerIsCurrent()) return null;
    if (syncWriteOperationsInFlight !== 0) {
      if (!waitForExistingOutbound) return null;
      const outboundBarrierAtWait = syncWriteChain;
      const inboundGenerationAtWait = syncInboundArrivalGeneration;
      const remoteDisableGenerationAtWait = remoteDisableArrivalGeneration;
      const writerSettled = await waitForExistingOutboundBarrier(
        outboundBarrierAtWait
      );
      if (!writerSettled
          || !ownerIsCurrent()
          || inboundGenerationAtWait !== syncInboundArrivalGeneration
          || remoteDisableGenerationAtWait
            !== remoteDisableArrivalGeneration) {
        return null;
      }
      if (outboundBarrierAtWait !== syncWriteChain
          || syncWriteOperationsInFlight !== 0) {
        continue;
      }
      continue;
    }
    const watermarkBarrierAtWait = syncWatermarkWriteChain;
    const retryAlarmBarrierAtWait = syncPublishRetryAlarmWriteChain;
    const watermarkGenerationAtWait = syncWatermarkWriteGeneration;
    const retryAlarmGenerationAtWait =
      syncPublishRetryAlarmWriteGeneration;
    if ((syncWatermarkWritesInFlight !== 0
        || syncPublishRetryAlarmWritesInFlight !== 0)
        && !await waitForLocalWriterBarriers(
          watermarkBarrierAtWait,
          retryAlarmBarrierAtWait
        )) {
      return null;
    }
    if (!ownerIsCurrent()
        || syncWriteOperationsInFlight !== 0
        || syncWatermarkWritesInFlight !== 0
        || syncPublishRetryAlarmWritesInFlight !== 0
        || watermarkBarrierAtWait !== syncWatermarkWriteChain
        || retryAlarmBarrierAtWait !== syncPublishRetryAlarmWriteChain
        || watermarkGenerationAtWait !== syncWatermarkWriteGeneration
        || retryAlarmGenerationAtWait
          !== syncPublishRetryAlarmWriteGeneration) {
      continue;
    }
    const outboundGenerationAtRead = syncPublishGeneration;
    const writeChainAtRead = syncWriteChain;
    const watermarkWriteGenerationAtRead = syncWatermarkWriteGeneration;
    const watermarkWriteChainAtRead = syncWatermarkWriteChain;
    const publishRetryAlarmGenerationAtRead =
      syncPublishRetryAlarmWriteGeneration;
    const outboundReceiptIsCurrent = () => (
      ownerIsCurrent()
      && syncPublishGeneration === outboundGenerationAtRead
      && syncWriteChain === writeChainAtRead
      && syncWriteOperationsInFlight === 0
      && syncWatermarkWriteGeneration === watermarkWriteGenerationAtRead
      && syncWatermarkWriteChain === watermarkWriteChainAtRead
      && syncWatermarkWritesInFlight === 0
      && syncPublishRetryAlarmWriteGeneration
        === publishRetryAlarmGenerationAtRead
      && syncPublishRetryAlarmWritesInFlight === 0
    );
    const [publishStateBefore, retryBefore] = await Promise.all([
      getSyncPublishAuthorityState(),
      chrome.alarms.get('ac-sync-publish-retry')
    ]);
    if (publishStateBefore === null || !outboundReceiptIsCurrent()) continue;
    const inboundGenerationAtRead = syncInboundArrivalGeneration;
    const stored = await chrome.storage.sync.get(SYNC_KEY);
    if (!outboundReceiptIsCurrent()
        || inboundGenerationAtRead !== syncInboundArrivalGeneration) {
      continue;
    }
    const [publishStateAfter, retryAfter] = await Promise.all([
      getSyncPublishAuthorityState(),
      chrome.alarms.get('ac-sync-publish-retry')
    ]);
    if (publishStateAfter === null
        || !outboundReceiptIsCurrent()
        || inboundGenerationAtRead !== syncInboundArrivalGeneration
        || publishStateBefore.pending !== publishStateAfter.pending
        || publishStateBefore.localMutationCutoffObservedAt
          !== publishStateAfter.localMutationCutoffObservedAt
        || retryAlarmIdentity(retryBefore)
          !== retryAlarmIdentity(retryAfter)) {
      continue;
    }
    return Object.freeze({
      remote: stored?.[SYNC_KEY] || null,
      pendingPublish: publishStateAfter.pending,
      localMutationCutoffObservedAt:
        publishStateAfter.localMutationCutoffObservedAt,
      publishRetryPresent: !!retryAfter,
      outboundUnresolved: publishStateAfter.pending || !!retryAfter,
      inboundGeneration: inboundGenerationAtRead,
      outboundGeneration: outboundGenerationAtRead,
      writeChain: writeChainAtRead,
      watermarkWriteGeneration: watermarkWriteGenerationAtRead,
      watermarkWriteChain: watermarkWriteChainAtRead,
      publishRetryAlarmGeneration:
        publishRetryAlarmGenerationAtRead
    });
  }
  return null;
}

async function classifyUnknownDeferredSyncSuccessorCredentials(
  identities,
  ensureCurrent,
  reason = 'unknown-successor-classification'
) {
  let candidates = (Array.isArray(identities) ? identities : [])
    .filter(identity => (
      identity?.name
      && identity?.remote
      && !deferredSyncSuccessorReleasedRetryAlarmNames.has(identity.name)
      && !deferredSyncSuccessorRetryAlarmEntries.has(identity.name)
    ));
  if (candidates.length === 0) return true;
  const expectedEpoch = deferredSyncDisableEpoch;
  const expectedIdentity = getDeferredSyncDisableReceiptIdentity();
  const expectedSafetyAuthorityId =
    deferredSyncDisableSafetyAuthorityId;
  const ownerIsCurrent = () => (
    deferredSyncDisablePending
    && deferredSyncDisableEpoch === expectedEpoch
    && getDeferredSyncDisableReceiptIdentity() === expectedIdentity
    && deferredSyncDisableSafetyAuthorityId
      === expectedSafetyAuthorityId
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  if (!ownerIsCurrent()) return false;

  const tombstoneAll = async (entries, suffix) => {
    for (const identity of entries) {
      if (!ownerIsCurrent()) return false;
      if (!await tombstoneDeferredSyncSuccessorRetryIdentity(
        identity,
        `${reason}-${suffix}`
      )) return false;
    }
    return ownerIsCurrent();
  };

  // 带谱系且不属于当前 F 的 T 一定是 predecessor。相同 F 谱系只证明
  // “发生在 F 后”，不能证明它晚于随后可能已提交的本机 M；只要 alarm
  // 未在 current durable successor map 中，就仍必须 fresh-store 分类。
  const mismatchedLineage = candidates.filter(identity => (
    identity.predecessorSafetyAuthorityId
    && identity.predecessorSafetyAuthorityId
      !== expectedSafetyAuthorityId
  ));
  if (!await tombstoneAll(mismatchedLineage, 'foreign-lineage-predecessor')) {
    return false;
  }
  candidates = candidates.filter(identity => (
    !identity.predecessorSafetyAuthorityId
    || identity.predecessorSafetyAuthorityId
      === expectedSafetyAuthorityId
  ));
  if (candidates.length === 0) return ownerIsCurrent();
  if (!chrome.storage?.sync) return false;

  let storeReceipt = null;
  try {
    storeReceipt = await readStableSyncStoreAuthorityReceipt(
      ownerIsCurrent
    );
  } catch (error) {
    console.warn('[AC扩展] 未知 T 的 stable sync 分类失败:', error?.message);
    return false;
  }
  const stableReadIsCurrent = () => (
    isStableSyncStoreAuthorityReceiptCurrent(
      storeReceipt,
      ownerIsCurrent
    )
  );
  if (!stableReadIsCurrent()) return false;

  const remote = storeReceipt.remote;
  const outboundUnresolved = storeReceipt.outboundUnresolved;
  const remoteIsTrue = !!remote
    && typeof remote === 'object'
    && remote.enabled !== false;
  if (remoteIsTrue && outboundUnresolved) {
    // store T 可能只是 F 前本机 publish 的晚到结果；固定 alarm 或 marker
    // 任一仍在都禁止把它升级成 post-F successor。它不是死锁条件：当前
    // F 会继续 settle，并在 clear 后用 false publish 修复 store。
    return tombstoneAll(
      candidates,
      'legacy-predecessor-with-unresolved-outbound'
    );
  }
  if (remoteIsTrue) {
    const remoteIdentity = getSyncPayloadIdentity(remote);
    const currentSuccessorIdentity = getSyncPayloadIdentity(
      deferredSyncDisableSuccessorSnapshot
    );
    if (remoteIdentity !== currentSuccessorIdentity) {
      const freshSuccessorPersisted =
        await rememberRemoteSyncSuccessorAfterDeferredDisable(
          remote,
          `${reason}-fresh-sync-current-successor`
        );
      if (!freshSuccessorPersisted
          || !await freshSuccessorPersisted
          || !stableReadIsCurrent()) {
        return false;
      }
    }
  }

  // fresh store 只证明当前 desired T，不证明任何旧 alarm 的先后关系。
  // 当前 T 已用新的 F lineage/observedAt 登记；所有 legacy exact names
  // 均作为 predecessor 墓碑化，禁止 byte-identical future-clock T 复活。
  return tombstoneAll(candidates, 'legacy-predecessor-after-fresh-sync');
}

async function classifyUnknownDeferredSyncSuccessorAfterSafetyRelease(
  identity,
  ensureCurrent = null,
  reason = 'released-safety-successor-classification'
) {
  if (!identity?.name || !identity?.remote) return false;
  const expectedDeferredEpoch = deferredSyncDisableEpoch;
  const expectedReleasedSafetyAuthorityId =
    deferredSyncLastClearedSafetyAuthorityId;
  const expectedMutationGeneration = localScheduleMutationGeneration;
  const expectedMutationCutoff =
    localScheduleMutationCommittedObservedAt;
  const expectedScheduleAuthorityGeneration =
    localScheduleAuthorityGeneration;
  const expectedManualIntentEpoch = manualToggleIntentEpoch;
  const ownerIsCurrent = () => (
    !deferredSyncDisablePending
    && deferredSyncDisableEpoch === expectedDeferredEpoch
    && deferredSyncLastClearedSafetyAuthorityId
      === expectedReleasedSafetyAuthorityId
    && localScheduleMutationGeneration === expectedMutationGeneration
    && localScheduleMutationCommittedObservedAt
      === expectedMutationCutoff
    && localScheduleMutationCommitPendingGeneration === 0
    && localScheduleAuthorityGeneration
      === expectedScheduleAuthorityGeneration
    && manualToggleIntentEpoch === expectedManualIntentEpoch
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  if (!ownerIsCurrent()) return false;

  let storeReceipt = null;
  try {
    storeReceipt = await readStableSyncStoreAuthorityReceipt(
      ownerIsCurrent
    );
  } catch (error) {
    console.warn('[AC扩展] F clear 后未知 T stable 分类失败:', error?.message);
    return false;
  }
  const stableReadIsCurrent = () => (
    ownerIsCurrent()
    && isStableSyncStoreAuthorityReceiptCurrent(
      storeReceipt,
      ownerIsCurrent
    )
  );
  if (!stableReadIsCurrent()) return false;

  const remote = storeReceipt.remote;
  const remoteIsTrue = !!remote
    && typeof remote === 'object'
    && remote.enabled !== false;
  if (remoteIsTrue && storeReceipt.outboundUnresolved) {
    // unresolved 本机 outbound 可能把 pre-M T 暂时留在 store。既不恢复、
    // 也不删除唯一 alarm credential，等 publish/retry 收口后重新分类。
    return false;
  }
  if (remoteIsTrue) {
    // 先建立独立 durable wake，再淘汰旧 alarm。否则 tombstone 成功、立即
    // crash 且原 scheduledTime 在远未来时，当前 store T 会失去近端入口。
    const retryReady = await scheduleSyncRetry('adopt');
    if (!retryReady || !stableReadIsCurrent()) return false;
  }

  const tombstoned = await tombstoneDeferredSyncSuccessorRetryIdentity(
    identity,
    `${reason}-old-credential`
  );
  if (!tombstoned) return false;
  if (!stableReadIsCurrent()) return false;
  if (remote && typeof remote === 'object') {
    await tryAdoptSyncedState(`${reason}-fresh-store`, remote);
  }
  return true;
}

async function prepareStableDeferredSyncDisableRelease(
  ensureCurrent,
  reason = 'deferred-sync-disable-stable-release'
) {
  const ownerIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const baseReceipt = await prepareDeferredSyncDisableForRelease(
      ensureCurrent,
      reason
    );
    if (!ownerIsCurrent()
        || !isDeferredSyncDisableReleaseReceiptCurrent(baseReceipt)) {
      return null;
    }
    await Promise.all([
      waitForDeferredSyncDisableRetryAlarmOperationsToSettle(),
      waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle()
    ]);
    if (!ownerIsCurrent()
        || !isDeferredSyncDisableReleaseReceiptCurrent(baseReceipt)) {
      continue;
    }
    const [disableIdentities, successorIdentities] = await Promise.all([
      getDeferredSyncDisableRetryAlarmIdentities(),
      getDeferredSyncSuccessorRetryAlarmIdentities()
    ]);
    if (!ownerIsCurrent()
        || !isDeferredSyncDisableReleaseReceiptCurrent(baseReceipt)) {
      continue;
    }
    const releasedDisableNames = [...new Set(
      deferredSyncDisableReleasedRetryAlarmNames
    )];
    const releasedSuccessorNames = [...new Set(
      deferredSyncSuccessorReleasedRetryAlarmNames
    )];
    const releasedDisableSet = new Set(releasedDisableNames);
    const releasedSuccessorSet = new Set(releasedSuccessorNames);
    const knownSuccessorNames = new Set(
      deferredSyncSuccessorRetryAlarmEntries.keys()
    );
    const uncoveredDisableIdentities = disableIdentities.filter(identity => (
      !releasedDisableSet.has(identity.name)
    ));
    const unknownSuccessorIdentities = successorIdentities.filter(identity => (
      !releasedSuccessorSet.has(identity.name)
      && !knownSuccessorNames.has(identity.name)
    ));
    if (uncoveredDisableIdentities.length > 0) {
      // F delta 必须先按 exact credential 换 safety epoch，不能在本轮
      // release union 里顺手吸收。
      await Promise.allSettled(uncoveredDisableIdentities.map(
        identity => createScheduleReadRetryWake({
        name: identity.name,
        scheduledTime: Number(identity?.alarm?.scheduledTime)
          || (Number(identity.receivedAt || identity.observedAt) + 60_000)
        }, 'F final-release delta')
      ));
      await scheduleSyncRetry('adopt').catch(() => {});
      return null;
    }
    if (unknownSuccessorIdentities.length > 0) {
      const classified =
        await classifyUnknownDeferredSyncSuccessorCredentials(
          unknownSuccessorIdentities,
          ownerIsCurrent,
          `${reason}-final-scan`
        ).catch(() => false);
      if (classified && ownerIsCurrent()) {
        // classifier 会 durable tombstone 或登记新的 exact successor；
        // base receipt 已过期，从头冻结完整集合。
        continue;
      }
      await Promise.allSettled([
        ...unknownSuccessorIdentities.map(identity => (
          createDeferredSyncSuccessorClassificationWake(
            identity,
            'F final-release unknown T lineage'
          )
        )),
        scheduleSyncRetry('adopt')
      ]);
      return null;
    }
    const receipt = Object.freeze({
      ...baseReceipt,
      remoteDisableArrivalGeneration,
      syncInboundArrivalGeneration,
      safetyAuthorityId: deferredSyncDisableSafetyAuthorityId,
      successorIdentity: getSyncPayloadIdentity(
        deferredSyncDisableSuccessorSnapshot
      ),
      successorObservedAt: deferredSyncDisableSuccessorSnapshot
        ? deferredSyncDisableSuccessorObservedAt
        : 0,
      successorRetryAlarmName: deferredSyncDisableSuccessorSnapshot
        ? deferredSyncDisableSuccessorRetryAlarmName
        : '',
      releasedDisableRetryAlarmNames: Object.freeze(
        releasedDisableNames
      ),
      releasedSuccessorRetryAlarmNames: Object.freeze(
        releasedSuccessorNames
      ),
      liveDisableRetryAlarmNames: Object.freeze(
        disableIdentities.map(identity => identity.name)
      ),
      liveSuccessorRetryAlarmIdentities: Object.freeze(
        successorIdentities.map(identity => Object.freeze({
          name: identity.name,
          observedAt: identity.observedAt,
          remoteIdentity: getSyncPayloadIdentity(identity.remote)
        }))
      ),
      successorRetryAlarmEntries: Object.freeze(
        [...deferredSyncSuccessorRetryAlarmEntries.entries()]
          .map(([name, entry]) => Object.freeze({
            name,
            observedAt: Number(entry?.observedAt) || 0,
            authorityOrderObservedAt:
              Number(entry?.authorityOrderObservedAt)
              || Number(entry?.observedAt)
              || 0,
            remoteIdentity: getSyncPayloadIdentity(entry?.remote),
            scheduleAuthorityGeneration:
              entry?.scheduleAuthorityGeneration,
            scheduleMutationGeneration:
              entry?.scheduleMutationGeneration
          }))
      )
    });
    if (isStableDeferredSyncDisableReleaseReceiptCurrent(receipt)) {
      return receipt;
    }
  }
  await scheduleSyncRetry('adopt').catch(() => {});
  return null;
}

async function validateStableDeferredSyncDisableRelease(receipt) {
  if (!isStableDeferredSyncDisableReleaseReceiptCurrent(receipt)) {
    return false;
  }
  await Promise.all([
    waitForDeferredSyncDisableRetryAlarmOperationsToSettle(),
    waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle()
  ]);
  if (!isStableDeferredSyncDisableReleaseReceiptCurrent(receipt)) {
    return false;
  }
  const [disableIdentities, successorIdentities] = await Promise.all([
    getDeferredSyncDisableRetryAlarmIdentities(),
    getDeferredSyncSuccessorRetryAlarmIdentities()
  ]);
  if (!isStableDeferredSyncDisableReleaseReceiptCurrent(receipt)) {
    return false;
  }
  const allowedDisableNames = new Set([
    ...receipt.releasedDisableRetryAlarmNames,
    ...receipt.liveDisableRetryAlarmNames
  ]);
  const allowedSuccessorNames = new Set([
    ...receipt.releasedSuccessorRetryAlarmNames,
    ...receipt.liveSuccessorRetryAlarmIdentities.map(identity => identity.name)
  ]);
  const unexpectedDisableIdentities = disableIdentities.filter(identity => (
    !allowedDisableNames.has(identity.name)
  ));
  const unexpectedSuccessorIdentities = successorIdentities.filter(identity => (
    !allowedSuccessorNames.has(identity.name)
  ));
  if (unexpectedDisableIdentities.length > 0
      || unexpectedSuccessorIdentities.length > 0) {
    // validator 运行在 critical local FIFO 内，不能在这里递归进入会写
    // tombstone/mailbox 的 T classifier。F/T 都保留原 exact credential，
    // 另建 typed wake 回到外层 prepare 分类；generic adopt 只收敛 store。
    await Promise.allSettled([
      ...unexpectedDisableIdentities.map(identity => (
        createScheduleReadRetryWake({
          name: identity.name,
          scheduledTime: Number(identity?.alarm?.scheduledTime)
            || (Number(identity.receivedAt || identity.observedAt) + 60_000)
        }, 'F critical final-scan delta')
      )),
      ...unexpectedSuccessorIdentities.map(identity => (
        createDeferredSyncSuccessorClassificationWake(
          identity,
          'T critical final-scan delta'
        )
      )),
      scheduleSyncRetry('adopt')
    ]);
    return false;
  }
  return disableIdentities.every(identity => (
    allowedDisableNames.has(identity.name)
  )) && successorIdentities.every(identity => (
    allowedSuccessorNames.has(identity.name)
  ));
}

function finalizeDeferredSyncDisableClearInMemory({
  preserveSuccessor = false
} = {}) {
  const clearingSyntheticReadFailure =
    deferredSyncDisableSyntheticReadFailure;
  deferredSyncDisableLoaded = true;
  deferredSyncDisablePending = false;
  deferredSyncDisableEpoch += 1;
  if (!clearingSyntheticReadFailure) {
    deferredSyncLastClearedSafetyAuthorityId =
      deferredSyncDisableSafetyAuthorityId
      || deferredSyncLastClearedSafetyAuthorityId;
  }
  deferredSyncDisableSafetyAuthorityId = '';
  deferredSyncSuccessorEnumerationPendingEpoch = 0;
  deferredSyncDisableDurableReceiptEpoch = 0;
  deferredSyncDisableDurableReceiptIdentity = '';
  deferredSyncDisableRemoteSnapshot = null;
  deferredSyncDisableRemoteSnapshotComplete = false;
  deferredSyncDisableSyntheticReadFailure = false;
  deferredSyncDisableAuthorityOrderObservedAt = 0;
  deferredSyncDisableAuthorityPreBaselineSequence = 0;
  if (!preserveSuccessor) {
    deferredSyncDisableSuccessorSnapshot = null;
    deferredSyncDisableSuccessorObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
    deferredSyncDisableSuccessorRetryAlarmName = '';
    deferredSyncDisableSuccessorLocalAuthorityGeneration = 0;
    deferredSyncDisableSuccessorMutationGeneration = 0;
  }
  deferredSyncDisableLocalScheduleAuthorityGeneration =
    localScheduleAuthorityGeneration;
  startupDeferredDisableSupersededByUserIntent = false;
}

async function commitScheduleAuthority({
  ensureCurrent,
  markSyncPublishPending = false,
  clearDeferredSyncDisable = false,
  reason = ''
}) {
  const deferredDisableReleaseReceipt = clearDeferredSyncDisable
    ? await prepareStableDeferredSyncDisableRelease(
        ensureCurrent,
        reason || 'schedule-authority'
      )
    : null;
  if (clearDeferredSyncDisable
      && !isStableDeferredSyncDisableReleaseReceiptCurrent(
        deferredDisableReleaseReceipt
      )) {
    return false;
  }
  const scheduleSnapshot = snapshotScheduleForLocalPersistence();
  const deferredDisableEpochAtCommit = deferredSyncDisableEpoch;
  let deferredDisableFinalized = false;
  const authorityIsCurrent = () => (
    (typeof ensureCurrent !== 'function' || ensureCurrent())
    && (!clearDeferredSyncDisable
      || (deferredDisableFinalized
        ? (!deferredSyncDisablePending
          && deferredSyncDisableEpoch === deferredDisableEpochAtCommit + 1)
        : (deferredSyncDisableEpoch === deferredDisableEpochAtCommit
          && isStableDeferredSyncDisableReleaseReceiptCurrent(
            deferredDisableReleaseReceipt
          ))))
  );
  if (!authorityIsCurrent()) return false;
  const releasedDeferredDisableRetryAlarmNames = clearDeferredSyncDisable
    ? [...deferredDisableReleaseReceipt.releasedDisableRetryAlarmNames]
    : [];
  const frozenSuccessorRetryAlarmEntries = clearDeferredSyncDisable
    ? deferredDisableReleaseReceipt.successorRetryAlarmEntries
    : [];
  const discardedSuccessorRetryAlarmNames = clearDeferredSyncDisable
    ? [...new Set([
        ...frozenSuccessorRetryAlarmEntries
          .filter(entry => (
            entry.scheduleAuthorityGeneration
              !== localScheduleAuthorityGeneration
            || (deferredSyncDisableSuccessorAuthorityOrderObservedAt > 0
              && isSyncAuthorityOrderTupleBefore(entry, {
                observedAt: deferredSyncDisableSuccessorObservedAt,
                authorityOrderObservedAt:
                  deferredSyncDisableSuccessorAuthorityOrderObservedAt,
                authorityPreBaselineSequence:
                  deferredSyncDisableSuccessorAuthorityPreBaselineSequence
              }))
          ))
          .map(entry => entry.name)
      ])]
    : [];
  const releasedSuccessorRetryAlarmNames = [...new Set([
    ...(clearDeferredSyncDisable
      ? deferredDisableReleaseReceipt.releasedSuccessorRetryAlarmNames
      : deferredSyncSuccessorReleasedRetryAlarmNames),
    ...discardedSuccessorRetryAlarmNames
  ])];
  const releasedSuccessorThroughObservedAt = clearDeferredSyncDisable
    ? Math.max(
        deferredSyncSuccessorReleasedThroughObservedAt,
        localScheduleAuthorityObservedAt,
        ...frozenSuccessorRetryAlarmEntries
          .filter(entry => (
            discardedSuccessorRetryAlarmNames.includes(entry.name)
          ))
          .map(entry => Number(entry?.authorityOrderObservedAt)
            || Number(entry?.observedAt)
            || 0)
      )
    : deferredSyncSuccessorReleasedThroughObservedAt;
  if (!authorityIsCurrent()) return false;
  const committed = await runSerializedCriticalLocalStateWrite(async () => {
    while (authorityIsCurrent()) {
      if (clearDeferredSyncDisable
          && !await validateStableDeferredSyncDisableRelease(
            deferredDisableReleaseReceipt
          )) {
        return false;
      }
      // 只有在本次明确本机 authority 已到达之后观察到的 remote successor
      // 才能越过这次 clear。早于本机 L 的 T 被本机设置淘汰；在 storage.set
      // await 窗口后到的 T 则必须与 schedule 一起 durable，不能因时机丢失。
      const preserveSuccessor = clearDeferredSyncDisable
        && !!deferredSyncDisableSuccessorSnapshot
        && deferredSyncDisableSuccessorLocalAuthorityGeneration
          === localScheduleAuthorityGeneration;
      const successorSnapshot = preserveSuccessor
        ? { ...deferredSyncDisableSuccessorSnapshot }
        : null;
      const successorIdentity = getSyncPayloadIdentity(successorSnapshot);
      const successorObservedAt = preserveSuccessor
        ? deferredSyncDisableSuccessorObservedAt
        : 0;
      const successorRetryAlarmName = preserveSuccessor
        ? deferredSyncDisableSuccessorRetryAlarmName
        : '';
      const durableDeferredDisableRecord = clearDeferredSyncDisable
        ? mergeDeferredSyncSafetyMetadata(successorSnapshot
          ? {
              pending: false,
              safetyCleared: true,
              safetyCutoffObservedAt: deferredSyncDisableObservedAt,
              localMutationCutoffObservedAt:
                localScheduleMutationCommittedObservedAt,
              clearedAt: Date.now(),
              successor: {
                observedAt: successorObservedAt || Date.now(),
                ...(successorRetryAlarmName
                  ? {
                      retryAlarmName:
                        successorRetryAlarmName
                    }
                  : {}),
                authorityOrderObservedAt:
                  deferredSyncDisableSuccessorAuthorityOrderObservedAt
                  || successorObservedAt
                  || Date.now(),
                ...(deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
                  ? {
                      authorityPreBaselineSequence:
                        deferredSyncDisableSuccessorAuthorityPreBaselineSequence
                    }
                  : {}),
                remote: successorSnapshot
              },
              releasedRetryAlarmNames:
                releasedDeferredDisableRetryAlarmNames,
              releasedSuccessorRetryAlarmNames,
              releasedSuccessorThroughObservedAt
            }
          : {
              pending: false,
              safetyCutoffObservedAt: deferredSyncDisableObservedAt,
              localMutationCutoffObservedAt:
                localScheduleMutationCommittedObservedAt,
              clearedAt: Date.now(),
              releasedRetryAlarmNames:
                releasedDeferredDisableRetryAlarmNames,
              releasedSuccessorRetryAlarmNames,
              releasedSuccessorThroughObservedAt
            })
        : null;
      await chrome.storage.local.set({
        [STORAGE_KEY]: scheduleSnapshot,
        ...(durableDeferredDisableRecord
          ? { [DEFERRED_SYNC_DISABLE_KEY]: durableDeferredDisableRecord }
          : {}),
        ...(markSyncPublishPending
          ? { [SYNC_PENDING_PUBLISH_KEY]: true }
          : {})
      });
      if (!authorityIsCurrent()) return false;
      if (clearDeferredSyncDisable) {
        const latestPreservableSuccessor =
          deferredSyncDisableSuccessorSnapshot
          && deferredSyncDisableSuccessorLocalAuthorityGeneration
            === localScheduleAuthorityGeneration
            ? deferredSyncDisableSuccessorSnapshot
            : null;
        if (successorIdentity
              !== getSyncPayloadIdentity(latestPreservableSuccessor)
            || successorObservedAt
              !== (latestPreservableSuccessor
                ? deferredSyncDisableSuccessorObservedAt
                : 0)
            || successorRetryAlarmName
              !== (latestPreservableSuccessor
                ? deferredSyncDisableSuccessorRetryAlarmName
                : '')) {
          continue;
        }
        for (const name of releasedDeferredDisableRetryAlarmNames) {
          deferredSyncDisableReleasedRetryAlarmNames.add(name);
        }
        for (const name of discardedSuccessorRetryAlarmNames) {
          deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
        }
        deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
          deferredSyncSuccessorReleasedThroughObservedAt,
          releasedSuccessorThroughObservedAt
        );
        finalizeDeferredSyncDisableClearInMemory({
          preserveSuccessor: !!successorSnapshot
        });
        deferredDisableFinalized = true;
      }
      return true;
    }
    return false;
  });
  if (!committed) return false;
  if (!authorityIsCurrent()) return false;
  if (discardedSuccessorRetryAlarmNames.length > 0) {
    await clearDeferredSyncSuccessorRetryAlarms(
      discardedSuccessorRetryAlarmNames,
      { preserveReleasedNames: true }
    ).catch(error => {
      console.warn('[AC扩展] 清理被本机 authority 淘汰的 successor 恢复钟失败:', error?.message);
    });
  }
  if (releasedDeferredDisableRetryAlarmNames.length > 0) {
    await clearDeferredSyncDisableRetryAlarms(
      releasedDeferredDisableRetryAlarmNames,
      { preserveReleasedNames: true }
    ).catch(error => {
      console.warn('[AC扩展] 清理 remote disable 恢复钟失败:', error?.message);
    });
  }
  if (scheduleLoadBlockedRevision === pwmRuntimeRevision) {
    scheduleLoadBlockedRevision = null;
  }
  if (reason) console.log(`[AC扩展] ${reason}: schedule authority 已持久化`);
  return true;
}

function commitScheduleAndReleaseManualOffAdmission({
  ensureCurrent,
  markSyncPublishPending = false,
  clearDeferredSyncDisable = false,
  preserveDeferredSyncSuccessor = false,
  drainDeferredSync = true,
  reason = ''
}) {
  const scheduleSnapshot = snapshotScheduleForLocalPersistence();
  let deferredDisableEpochAtCommit = deferredSyncDisableEpoch;
  let deferredDisableReleaseReceipt = null;
  let deferredDisableFinalized = false;
  const manualIntentEpochAtCommit = manualToggleIntentEpoch;
  const releasedToken = manualOffAdmissionToken;
  const releasedRequestedAt = Math.max(
    Number(manualOffAdmissionRequestedAt) || 0,
    manualOffAdmissionPredecessorRequestedAt
  );
  const releasedLocalMutationObservedAt = Number(
    manualOffAdmissionLocalMutationObservedAt
  ) || 0;
  const releasedLocalMutationPredecessorRetryAlarmNames = [...new Set(
    manualOffAdmissionPredecessorSuccessorRetryAlarmNames
      .map(value => String(value || ''))
      .filter(Boolean)
  )];
  const releasedLocalMutationCoverageComplete =
    manualOffAdmissionMutationCoverageComplete;
  const storedCapturedSuccessorReceipt =
      manualOffAdmissionPredecessorSuccessorObservedAt > 0
      && manualOffAdmissionPredecessorSuccessorIdentity
    ? Object.freeze({
        observedAt:
          manualOffAdmissionPredecessorSuccessorObservedAt,
        identity: manualOffAdmissionPredecessorSuccessorIdentity
      })
    : null;
  const releasedCapturedSuccessorReceipt =
    storedCapturedSuccessorReceipt
    || snapshotCurrentDeferredSyncSuccessorPredecessor({
      retryAlarmNames:
        releasedLocalMutationPredecessorRetryAlarmNames
    });
  const predecessorTokens = [...manualOffAdmissionPredecessorTokens];
  return runSerializedManualOffAdmissionWrite(async () => {
    if (clearDeferredSyncDisable) {
      deferredDisableReleaseReceipt =
        await prepareStableDeferredSyncDisableRelease(
          ensureCurrent,
          reason || 'manual-off-admission-release'
        );
      if (!isStableDeferredSyncDisableReleaseReceiptCurrent(
        deferredDisableReleaseReceipt
      )) {
        return false;
      }
      deferredDisableEpochAtCommit = deferredDisableReleaseReceipt.epoch;
    }
    const releaseIsCurrent = () => (
      deferredDisableFinalized
        ? (!deferredSyncDisablePending
          && deferredSyncDisableEpoch === deferredDisableEpochAtCommit + 1
          && manualToggleIntentEpoch === manualIntentEpochAtCommit
          && manualOffAdmissionToken === releasedToken)
        : ((typeof ensureCurrent !== 'function' || ensureCurrent())
          && (!clearDeferredSyncDisable
            || (deferredSyncDisableEpoch === deferredDisableEpochAtCommit
              && isStableDeferredSyncDisableReleaseReceiptCurrent(
                deferredDisableReleaseReceipt
              ))))
    );
    if (!releaseIsCurrent()) return false;
    if (releasedLocalMutationObservedAt > 0
        && !releasedLocalMutationCoverageComplete) {
      return false;
    }
    await waitForManualOffRetryAlarmOperationsToSettle();
    if (!releaseIsCurrent()) return false;
    const retryAlarmIdentities = await getManualOffRetryAlarmIdentities();
    if (!releaseIsCurrent()) return false;
    const releaseThrough = Math.max(
      manualOffAdmissionReleasedThroughRequestedAt,
      Number(releasedRequestedAt) || 0,
      ...retryAlarmIdentities.map(identity => Number(identity.requestedAt) || 0)
    );
    const releasedMarker = createReleasedManualOffAdmissionValue({
      token: releasedToken,
      requestedAt: releaseThrough,
      releasedTokens: [
        ...predecessorTokens,
        // 启动 storage/getAll 同时失败时，内存可能不知道旧 pending
        // token。authority 已在 getAll 前取得 intent；后到 OFF 会先换
        // epoch 令 releaseIsCurrent 失败，因此这里可安全覆盖本轮观察到的
        // 全部前任 retry 身份，防止旧钟在下一次 SW 启动时复活。
        ...retryAlarmIdentities.map(identity => identity.token)
      ]
    });
    const releasedDeferredDisableRetryAlarmNames = clearDeferredSyncDisable
      ? [...deferredDisableReleaseReceipt.releasedDisableRetryAlarmNames]
      : [];
    const releasedSafetyPredecessorSuccessorRetryAlarmNames =
      clearDeferredSyncDisable
        ? [...deferredDisableReleaseReceipt.releasedSuccessorRetryAlarmNames]
        : [];
    const durableReleasedSuccessorRetryAlarmNames = [...new Set([
      ...deferredSyncSuccessorReleasedRetryAlarmNames,
      ...releasedSafetyPredecessorSuccessorRetryAlarmNames,
      ...(releasedLocalMutationCoverageComplete
        ? releasedLocalMutationPredecessorRetryAlarmNames
        : [])
    ])];
    const durableReleasedSuccessorThroughObservedAt = Math.max(
      deferredSyncSuccessorReleasedThroughObservedAt,
      deferredSyncDisableAuthorityOrderObservedAt
        || deferredSyncDisableObservedAt
    );
    if (!releaseIsCurrent()) return false;
    const releaseCarriesLocalMutationAuthority =
      releasedLocalMutationObservedAt > 0
      && releasedLocalMutationCoverageComplete;
    const durableLocalMutationCutoffObservedAt =
      releaseCarriesLocalMutationAuthority
        ? Math.max(
            localScheduleMutationCommittedObservedAt,
            releasedLocalMutationObservedAt
          )
        : 0;
    const releasedSuccessorRetryAlarmNamesToClear = [...new Set([
      ...releasedSafetyPredecessorSuccessorRetryAlarmNames,
      ...(releaseCarriesLocalMutationAuthority
        ? releasedLocalMutationPredecessorRetryAlarmNames
        : [])
    ])];
    const committed = await runSerializedCriticalLocalStateWrite(async () => {
      while (releaseIsCurrent()) {
        if (clearDeferredSyncDisable
            && !await validateStableDeferredSyncDisableRelease(
              deferredDisableReleaseReceipt
            )) {
          return false;
        }
        const capturedSuccessorIsCurrent =
          isCurrentDeferredSyncSuccessorReceipt(
            releasedCapturedSuccessorReceipt
          );
        const successorSnapshot = clearDeferredSyncDisable
            && preserveDeferredSyncSuccessor
            && deferredSyncDisableSuccessorSnapshot
            && !capturedSuccessorIsCurrent
          ? { ...deferredSyncDisableSuccessorSnapshot }
          : null;
        const successorIdentity = getSyncPayloadIdentity(successorSnapshot);
        const successorObservedAt = successorSnapshot
          ? deferredSyncDisableSuccessorObservedAt
          : 0;
        const successorRetryAlarmName = successorSnapshot
          ? deferredSyncDisableSuccessorRetryAlarmName
          : '';
        let durableDeferredDisableRecord = clearDeferredSyncDisable
          ? (successorSnapshot
            ? {
                pending: false,
                safetyCleared: true,
                safetyCutoffObservedAt:
                  deferredSyncDisableObservedAt,
                localMutationCutoffObservedAt:
                  localScheduleMutationCommittedObservedAt,
                clearedAt: Date.now(),
                successor: {
                  observedAt: successorObservedAt || Date.now(),
                  ...(successorRetryAlarmName
                    ? {
                        retryAlarmName:
                          successorRetryAlarmName
                      }
                    : {}),
                  authorityOrderObservedAt:
                    deferredSyncDisableSuccessorAuthorityOrderObservedAt
                    || successorObservedAt
                    || Date.now(),
                  ...(deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
                    ? {
                        authorityPreBaselineSequence:
                          deferredSyncDisableSuccessorAuthorityPreBaselineSequence
                      }
                    : {}),
                  remote: successorSnapshot
                },
                releasedRetryAlarmNames:
                  releasedDeferredDisableRetryAlarmNames,
                releasedSuccessorRetryAlarmNames:
                  durableReleasedSuccessorRetryAlarmNames,
                releasedSuccessorThroughObservedAt:
                  durableReleasedSuccessorThroughObservedAt
              }
            : {
                pending: false,
                safetyCutoffObservedAt:
                  deferredSyncDisableObservedAt,
                localMutationCutoffObservedAt:
                  localScheduleMutationCommittedObservedAt,
                clearedAt: Date.now(),
                releasedRetryAlarmNames:
                  releasedDeferredDisableRetryAlarmNames,
                releasedSuccessorRetryAlarmNames:
                  durableReleasedSuccessorRetryAlarmNames,
                releasedSuccessorThroughObservedAt:
                  durableReleasedSuccessorThroughObservedAt
              })
          : null;
        if (releaseCarriesLocalMutationAuthority) {
          durableDeferredDisableRecord = durableDeferredDisableRecord
            || snapshotDeferredSyncDisableMailbox(reason)
            || {
              pending: false,
              safetyCutoffObservedAt: deferredSyncDisableObservedAt,
              updatedAt: Date.now(),
              reason: String(reason || ''),
              releasedRetryAlarmNames: [
                ...deferredSyncDisableReleasedRetryAlarmNames
              ],
              releasedSuccessorThroughObservedAt:
                deferredSyncSuccessorReleasedThroughObservedAt
            };
          durableDeferredDisableRecord.localMutationCutoffObservedAt =
            durableLocalMutationCutoffObservedAt;
          durableDeferredDisableRecord.releasedSuccessorRetryAlarmNames =
            [...new Set([
              ...(Array.isArray(
                durableDeferredDisableRecord
                  .releasedSuccessorRetryAlarmNames
              )
                ? durableDeferredDisableRecord
                  .releasedSuccessorRetryAlarmNames
                : []),
              ...releasedLocalMutationPredecessorRetryAlarmNames
            ])];
        }
        durableDeferredDisableRecord =
          omitCapturedDeferredSyncSuccessor(
            durableDeferredDisableRecord,
            releasedCapturedSuccessorReceipt
          );
        if (durableDeferredDisableRecord) {
          durableDeferredDisableRecord =
            mergeDeferredSyncSafetyMetadata(
              durableDeferredDisableRecord
            );
        }
        await chrome.storage.local.set({
          [STORAGE_KEY]: scheduleSnapshot,
          [MANUAL_OFF_ADMISSION_KEY]: releasedMarker,
          ...(releaseCarriesLocalMutationAuthority
            ? {
                [LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]:
                  durableLocalMutationCutoffObservedAt
              }
            : {}),
          ...(durableDeferredDisableRecord
            ? { [DEFERRED_SYNC_DISABLE_KEY]: durableDeferredDisableRecord }
            : {}),
          ...(markSyncPublishPending
              || releaseCarriesLocalMutationAuthority
            ? { [SYNC_PENDING_PUBLISH_KEY]: true }
            : {})
        });
        if (releaseCarriesLocalMutationAuthority) {
          recordCommittedLocalScheduleMutation(
            durableLocalMutationCutoffObservedAt
          );
          for (const name of
            releasedLocalMutationPredecessorRetryAlarmNames) {
            deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
          }
        }
        discardCapturedDeferredSyncSuccessorInMemory(
          releasedCapturedSuccessorReceipt
        );
        if (!releaseIsCurrent()) return false;
        if (clearDeferredSyncDisable) {
          const latestSuccessor = preserveDeferredSyncSuccessor
            ? deferredSyncDisableSuccessorSnapshot
            : null;
          if (successorIdentity !== getSyncPayloadIdentity(latestSuccessor)
              || successorObservedAt
                !== (latestSuccessor
                  ? deferredSyncDisableSuccessorObservedAt
                  : 0)
              || successorRetryAlarmName
                !== (latestSuccessor
                  ? deferredSyncDisableSuccessorRetryAlarmName
                  : '')) {
            continue;
          }
          for (const name of releasedDeferredDisableRetryAlarmNames) {
            deferredSyncDisableReleasedRetryAlarmNames.add(name);
          }
          for (const name of
            releasedSafetyPredecessorSuccessorRetryAlarmNames) {
            deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
          }
          deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
            deferredSyncSuccessorReleasedThroughObservedAt,
            durableReleasedSuccessorThroughObservedAt
          );
          // 与 durable marker 同一 critical callback 内完成内存切换，令在
          // storage.set await 中排队的旧 successor writer 看到 pending=false。
          finalizeDeferredSyncDisableClearInMemory({
            preserveSuccessor: preserveDeferredSyncSuccessor
          });
          deferredDisableFinalized = true;
        }
        return true;
      }
      return false;
    });
    if (!committed) return false;
    if (releasedDeferredDisableRetryAlarmNames.length > 0) {
      await clearDeferredSyncDisableRetryAlarms(
        releasedDeferredDisableRetryAlarmNames,
        { preserveReleasedNames: true }
      ).catch(error => {
        console.warn('[AC扩展] 清理 remote disable 恢复钟失败:', error?.message);
      });
    }
    if (releasedSuccessorRetryAlarmNamesToClear.length > 0) {
      await clearDeferredSyncSuccessorRetryAlarms(
        releasedSuccessorRetryAlarmNamesToClear,
        { preserveReleasedNames: true }
      ).catch(error => {
        console.warn('[AC扩展] 清理被本机 OFF authority 淘汰的 successor 恢复钟失败:', error?.message);
      });
    }
    if (!releaseIsCurrent()) return false;
    manualOffAdmissionReleasedThroughRequestedAt = Math.max(
      manualOffAdmissionReleasedThroughRequestedAt,
      Number(releasedMarker.releasedThroughRequestedAt) || 0
    );
    try {
      await clearManualOffRetryAlarmsThrough(
        manualOffAdmissionReleasedThroughRequestedAt
      );
    } catch (_) { /* released tombstone makes a stale retry alarm harmless */ }
    if (!releaseIsCurrent()) return false;
    manualOffAdmissionToken = '';
    manualOffAdmissionRequestedAt = 0;
    manualOffAdmissionRestoredFromStorage = false;
    manualOffAdmissionLocalMutationObservedAt = 0;
    manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
    manualOffAdmissionMutationCoverageComplete = false;
    manualOffAdmissionPredecessorSuccessorObservedAt = 0;
    manualOffAdmissionPredecessorSuccessorIdentity = '';
    manualOffAdmissionPredecessorRequestedAt = 0;
    manualOffAdmissionPredecessorTokens = [];
    manualOffAdmissionLoaded = true;
    manualOffAutomaticOnBlocked = false;
    startupRestoreSupersedingIntentEpoch = 0;
    if (scheduleLoadBlockedRevision === pwmRuntimeRevision) {
      scheduleLoadBlockedRevision = null;
    }
    if (reason) console.log(`[AC扩展] ${reason}: 手动关机准入已持久收口`);
    if (!markSyncPublishPending && drainDeferredSync) {
      drainDeferredSyncAdoptionAfterManualOffAdmission();
    }
    return true;
  });
}

function releaseManualOffAdmissionForAuthority(intentEpoch, action) {
  const normalizedAction = action === 'off'
    ? 'off'
    : action === 'disable'
      ? 'disable'
      : 'on';
  const deferredDisableEpochAtRelease = deferredSyncDisableEpoch;
  const releasedToken = manualOffAdmissionToken;
  const releasedRequestedAt = Math.max(
    Number(manualOffAdmissionRequestedAt) || 0,
    manualOffAdmissionPredecessorRequestedAt
  );
  const predecessorTokens = [...manualOffAdmissionPredecessorTokens];
  return runSerializedManualOffAdmissionWrite(async () => {
    const releaseIsCurrent = () => (
      isManualToggleIntentCurrent(intentEpoch, normalizedAction)
      && !deferredSyncDisablePending
      && deferredSyncDisableEpoch === deferredDisableEpochAtRelease
    );
    if (!releaseIsCurrent()) return false;
    if (manualOffAdmissionLocalMutationObservedAt > 0
        && !manualOffAdmissionMutationCoverageComplete) {
      return false;
    }
    await waitForManualOffRetryAlarmOperationsToSettle();
    if (!releaseIsCurrent()) return false;
    const retryAlarmIdentities = await getManualOffRetryAlarmIdentities();
    if (!releaseIsCurrent()) return false;
    const releaseThrough = Math.max(
      manualOffAdmissionReleasedThroughRequestedAt,
      Number(releasedRequestedAt) || 0,
      ...retryAlarmIdentities.map(identity => Number(identity.requestedAt) || 0)
    );
    const releasedMarker = createReleasedManualOffAdmissionValue({
      token: releasedToken,
      requestedAt: releaseThrough,
      releasedTokens: [
        ...predecessorTokens,
        ...retryAlarmIdentities.map(identity => identity.token)
      ]
    });
    await runSerializedCriticalLocalStateWrite(() => (
      chrome.storage.local.set({
        [MANUAL_OFF_ADMISSION_KEY]: releasedMarker
      })
    ));
    if (!releaseIsCurrent()) return false;
    manualOffAdmissionReleasedThroughRequestedAt = Math.max(
      manualOffAdmissionReleasedThroughRequestedAt,
      Number(releasedMarker.releasedThroughRequestedAt) || 0
    );
    try {
      await clearManualOffRetryAlarmsThrough(
        manualOffAdmissionReleasedThroughRequestedAt
      );
    } catch (_) { /* released tombstone makes a stale retry alarm harmless */ }
    if (!releaseIsCurrent()) return false;
    manualOffAdmissionToken = '';
    manualOffAdmissionRequestedAt = 0;
    manualOffAdmissionRestoredFromStorage = false;
    manualOffAdmissionLocalMutationObservedAt = 0;
    manualOffAdmissionPredecessorSuccessorRetryAlarmNames = [];
    manualOffAdmissionMutationCoverageComplete = false;
    manualOffAdmissionPredecessorSuccessorObservedAt = 0;
    manualOffAdmissionPredecessorSuccessorIdentity = '';
    manualOffAdmissionPredecessorRequestedAt = 0;
    manualOffAdmissionPredecessorTokens = [];
    manualOffAdmissionLoaded = true;
    manualOffAutomaticOnBlocked = false;
    startupRestoreSupersedingIntentEpoch = 0;
    return true;
  });
}

function releaseManualOffAdmissionForManualOn(intentEpoch) {
  return releaseManualOffAdmissionForAuthority(intentEpoch, 'on');
}

function queueManualOffAutomaticOnCancellation({
  claimRevision = true,
  holdManualOffAdmission = true
} = {}) {
  // 同步失效整个在途自动事务，不只是最后的页面点击。
  // 下一轮自动任务会捕获新 revision，因此这不会永久停用调度。
  if (claimRevision) pwmRuntimeRevision += 1;
  if (holdManualOffAdmission) manualOffAutomaticOnBlocked = true;
  // 取消也必须 FIFO。若两个 OFF 并发查 tab，较旧的 cancel 可能
  // 在更新 ON 入场后才抵达主世界，反向取消最新意图。
  manualOffCancellationChain = manualOffCancellationChain
    .catch(() => {})
    .then(() => cancelAutomaticOnRequests())
    .catch((error) => {
      console.warn('[AC扩展] 手动关机取消在途 ON 失败:', error?.message);
      void appendDiagnosticLog('warn', 'manual-off-cancel-on', error);
    });
  return manualOffCancellationChain;
}

async function waitForManualOffCancellationToSettle() {
  let observed;
  do {
    observed = manualOffCancellationChain;
    await observed.catch(() => {});
  } while (observed !== manualOffCancellationChain);
}

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
  const retryStatus = getPwmRetryDescriptor(schedule.pwmRetryKind)?.diagnosticStatus;
  if (retryStatus) return retryStatus;
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

function claimSyncPhaseAdoptionAdmissionWhenAvailable() {
  const admissionEpoch = claimSyncPhaseAdoptionAdmission();
  if (admissionEpoch > 0) return Promise.resolve(admissionEpoch);
  return new Promise(resolve => {
    syncPhaseAdoptionAdmissionWaiters.push(resolve);
  });
}

function releaseSyncPhaseAdoptionAdmission(admissionEpoch) {
  if (syncPhaseAdoptionAdmissionOwner !== admissionEpoch) return false;
  const nextWaiter = syncPhaseAdoptionAdmissionWaiters.shift();
  if (nextWaiter) {
    // 直接把 owner 交给最早等待者；不能先暴露 owner=0 再异步唤醒，
    // 否则 sync/page/alarm 可在 waiter 的微任务恢复前插队，令用户更新饿死。
    const nextAdmissionEpoch = ++syncPhaseAdoptionAdmissionEpoch;
    syncPhaseAdoptionAdmissionOwner = nextAdmissionEpoch;
    nextWaiter(nextAdmissionEpoch);
    return true;
  }
  syncPhaseAdoptionAdmissionOwner = 0;
  if (smartReapplyPending
      && !smartReapplyInFlight
      && !pwmStepRunning) {
    void waitUntil(runSmartReapplyLoop());
  }
  return true;
}

function isSyncPhaseAdoptionAdmissionBlocked() {
  return syncPhaseAdoptionAdmissionOwner > 0;
}

function isSyncPhaseAdoptionAdmissionOwnerCurrent(admissionEpoch) {
  const expectedEpoch = Number(admissionEpoch);
  return Number.isSafeInteger(expectedEpoch)
    && expectedEpoch > 0
    && syncPhaseAdoptionAdmissionOwner === expectedEpoch;
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
  if (smartReapplyPending
      && !smartReapplyInFlight
      && !isSyncPhaseAdoptionAdmissionBlocked()) {
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

async function scheduleComfortStartEndAlarm(options = {}) {
  const requestedUntil = Number(options?.until);
  const hasRequestedUntil = Number.isFinite(requestedUntil) && requestedUntil > 0;
  const isCurrent = typeof options?.isCurrent === 'function'
    ? options.isCurrent
    : null;
  await chrome.alarms.clear(COMFORT_START_END_ALARM);
  if (isCurrent && !isCurrent()) return false;

  const until = hasRequestedUntil
    ? requestedUntil
    : (Number(schedule.comfortStartUntil) || 0);
  if (until <= Date.now()) return false;
  if (!isCurrent && !isComfortStartActive()) return false;
  return createAlarm(COMFORT_START_END_ALARM, {
    when: until,
    ...(isCurrent ? { ensureCurrent: isCurrent } : {})
  });
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
  setPwmClockIntent(retryAt);
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
  setPwmClockIntent(retryAt > now ? retryAt : 0);
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
  const manualToggleIntentEpochAtAdmission = manualToggleIntentEpoch;
  const comfortActuatorIsCurrent = () => (
    isManualToggleIntentEpochCurrent(manualToggleIntentEpochAtAdmission)
    && !manualOffAutomaticOnBlocked
  );

  function applyComfortStartClaimState(claimState) {
    clearPwmRetryState();
    schedule.comfortStartUntil = claimState.minimumTargetAt;
    schedule.comfortStartOnConfirmedAt = claimState.onConfirmedAt;
    schedule.pwmState = 'on';
    setPwmClockIntent(0);
    replaceSchedulePageTimerRetryState(schedule);
  }

  function applyComfortStartCompleteIntent(completeIntent) {
    schedule.comfortStartUntil = completeIntent.comfortStartUntil;
    schedule.comfortStartOnConfirmedAt = completeIntent.comfortStartOnConfirmedAt;
    schedule.pwmState = completeIntent.pwmState;
    replaceSchedulePwmRetryState(schedule, {
      kind: completeIntent.pwmRetryKind,
      boundaryAt: completeIntent.pwmRetryBoundaryAt,
      scheduledAt: completeIntent.pwmRetryScheduledAt
    });
  }

  function applyComfortStartCompleteState(completeState) {
    if (!replayVerifiedPwmClockState(completeState)) return false;
    applyComfortStartCompleteIntent(completeState);
    return true;
  }

  function replayComfortStartCompleteState(completeState, automationRevision) {
    // storage.onChanged 可在同一 revision 内把顶层 schedule 换成较早快照。
    // 先凭 revision 认领，再重放本事务字段；完整门禁随后读取已恢复的
    // comfort marker，同时仍保留 replacement 的 enabled/config/pageTimer*。
    if (automationRevision !== pwmRuntimeRevision) return false;
    if (!applyComfortStartCompleteState(completeState)) return false;
    return isAutomationOperationCurrent(automationRevision);
  }

  if (!schedule.enabled
      || !isComfortStartAuthorityAllowed()
      || !comfortActuatorIsCurrent()) {
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
  const claimState = Object.freeze({
    minimumTargetAt: provisionalPlan.minimumTargetAt,
    onConfirmedAt: restoreExistingMinimum ? existingOnConfirmedAt : 0
  });

  pwmRuntimeRevision += 1;
  const automationRevision = pwmRuntimeRevision;
  invalidateTimerBasedShutdown();
  applyComfortStartClaimState(claimState);
  await cancelAutomaticOnRequests();
  if (activeAcToggleAttempt?.promise) {
    await activeAcToggleAttempt.promise.catch(() => {});
  }
  await clearPwmAlarm(automationRevision);
  const retryAlarmClear = await writePageTimerRetryAlarm({
    action: 'clear',
    isCurrent: () => (
      isAutomationOperationCurrent(automationRevision)
      && comfortActuatorIsCurrent()
    )
  });
  await chrome.alarms.clear('ac-comfort-end');
  if (retryAlarmClear.stale
      || !isAutomationOperationCurrent(automationRevision)
      || !comfortActuatorIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  applyComfortStartClaimState(claimState);
  await persistSchedule(`comfort-start-${reason}-claim`, { syncFromLiveAlarm: false });

  // OFF 页面先读取当前 picker，预置时保留用户已有的更晚关机目标；随后
  // toggleAC 把预置、ON 与新鲜页确认锁在同一 tab 事务中。
  const pageTimerBeforeOn = await getCurrentPageTimer();
  if (!isAutomationOperationCurrent(automationRevision)
      || !comfortActuatorIsCurrent()) {
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
    pageTimerTargetAt: provisionalPlan.targetAt,
    ensureCurrent: comfortActuatorIsCurrent
  });
  if (!isAutomationOperationCurrent(automationRevision)
      || !comfortActuatorIsCurrent()) {
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
  if (!isAutomationOperationCurrent(automationRevision)
      || !comfortActuatorIsCurrent()) {
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
      automationRevision,
      ensureCurrent: comfortActuatorIsCurrent
    });
  if (!isAutomationOperationCurrent(automationRevision)
      || !comfortActuatorIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  if (!timerResult?.success) {
    return deferComfortStart(
      timerResult?.error || 'Power-off after 新鲜页验证失败',
      automationRevision
    );
  }

  const completeIntent = Object.freeze({
    comfortStartUntil: comfortPlan.minimumTargetAt,
    comfortStartOnConfirmedAt: reuseConfirmedMinimum
      ? existingOnConfirmedAt
      : confirmedAt,
    pwmState: 'off',
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  });
  applyComfortStartCompleteIntent(completeIntent);
  const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
    { nextTriggerAt: comfortPlan.targetAt },
    'comfort-start-complete',
    automationRevision
  );
  if (!alarmWrite.created) {
    if (automationRevision !== pwmRuntimeRevision
        || !isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)) {
      return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
    }
    return deferComfortStart('PWM 主闹钟创建失败', automationRevision);
  }
  if (automationRevision !== pwmRuntimeRevision
      || !isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  const verifiedClockState = snapshotVerifiedPwmClockState(alarmWrite.writeOwner);
  if (!verifiedClockState) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  const completeState = Object.freeze({
    ...completeIntent,
    ...verifiedClockState
  });
  const completeStateIsCurrent = () => replayComfortStartCompleteState(
    completeState,
    automationRevision
  ) && comfortActuatorIsCurrent();
  if (!completeStateIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }

  await createAlarm('ac-badge-tick', {
    delayInMinutes: 1,
    ensureCurrent: completeStateIsCurrent
  });
  if (!completeStateIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  await createAlarm('ac-watchdog', {
    periodInMinutes: 5,
    ensureCurrent: completeStateIsCurrent
  });
  if (!completeStateIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  if (comfortPlan.targetAt > comfortPlan.minimumTargetAt + 1000) {
    await scheduleComfortStartEndAlarm({
      until: completeState.comfortStartUntil,
      isCurrent: completeStateIsCurrent
    });
  } else {
    await chrome.alarms.clear(COMFORT_START_END_ALARM);
  }
  if (!completeStateIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
  await persistSchedule(`comfort-start-${reason}-complete`, {
    syncFromLiveAlarm: false
  });
  if (!completeStateIsCurrent()) {
    return { success: false, cancelled: true, error: '自动控制已关闭或启动请求已失效' };
  }
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

async function finishExplicitDisablePreemption(preemptionPromise = null) {
  const preemptSteps = [
    ['clear-comfort-end', () => chrome.alarms.clear('ac-comfort-end')],
    ['cancel-automatic-on', () => preemptionPromise
      || queueManualOffAutomaticOnCancellation({
        claimRevision: false,
        holdManualOffAdmission: false
      })]
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

function isComfortStartAuthorityAllowed() {
  return schedule.enabled === true
    && syncAuthorityDurableBaselineLoaded
    && manualOffAdmissionLoaded
    && !manualOffAutomaticOnBlocked
    && deferredSyncDisableLoaded
    && !deferredSyncDisablePending
    && !automaticOnAdmissionBlocked;
}

function isAutomationAllowed(now = new Date()) {
  return syncAuthorityDurableBaselineLoaded
    && manualOffAdmissionLoaded
    && !manualOffAutomaticOnBlocked
    && deferredSyncDisableLoaded
    && !deferredSyncDisablePending
    && !automaticOnAdmissionBlocked
    && isAutomationAllowedForSchedule(schedule, now);
}

function isAutomationAllowedIgnoringManualOff(now = new Date()) {
  return syncAuthorityDurableBaselineLoaded
    && deferredSyncDisableLoaded
    && !deferredSyncDisablePending
    && !automaticOnAdmissionBlocked
    && isAutomationAllowedForSchedule(schedule, now);
}

function isAutomationOperationCurrent(automationRevision) {
  return Number.isSafeInteger(automationRevision)
    && automationRevision === pwmRuntimeRevision
    && isAutomationAllowed();
}

function isAutomationOperationCurrentIgnoringManualOff(automationRevision) {
  return Number.isSafeInteger(automationRevision)
    && automationRevision === pwmRuntimeRevision
    && isAutomationAllowedIgnoringManualOff();
}

async function abortStaleAutomation(
  automationRevision,
  reason,
  { phaseAdmissionEpoch = 0 } = {}
) {
  if (isAutomationOperationCurrent(automationRevision)) return false;
  if (schedule.enabled && !isWithinActiveHours()) {
    console.warn(`[AC扩展] ${reason}: 自动操作跨越运行时段边界，重新执行暂停关机`);
    await onActiveBoundaryCrossed({ phaseAdmissionEpoch });
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
async function onActiveBoundaryCrossed({ phaseAdmissionEpoch: ownedEpoch = 0 } = {}) {
  // 关闭运行时段后迟到/遗留的同名 alarm 只能被消费，不能把当前 smart
  // owner 当作“进入时段”重新 fresh start。
  if (!schedule.activeHours?.enabled) {
    await completeActiveBoundaryProcessing();
    return true;
  }
  const ownsExistingAdmission = isSyncPhaseAdoptionAdmissionOwnerCurrent(
    ownedEpoch
  );
  if (isSyncPhaseAdoptionAdmissionBlocked() && !ownsExistingAdmission) {
    await deferActiveBoundaryForPhaseAdoption();
    return false;
  }
  // 检查到 claim 之间无 await；active-boundary 和 sync/page adoption
  // 从此共用同一把排他锁，直到页面动作、storage 和 live alarm 收口。
  const phaseAdmissionEpoch = ownsExistingAdmission
    ? Number(ownedEpoch)
    : claimSyncPhaseAdoptionAdmission();
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
    if (!ownsExistingAdmission) {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair('active-boundary-complete');
    }
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
  setScheduleNextTrigger(schedule, nextTriggerAt, {
    plannedAt: options?.plannedAt,
    toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
    readNow: () => Date.now()
  });
}

function setPwmClockIntent(nextTriggerAt, options = {}) {
  setSchedulePwmClockIntent(schedule, nextTriggerAt, {
    plannedAt: options?.plannedAt,
    toleranceMs: PWM_RETRY_ALARM_TOLERANCE_MS,
    readNow: () => Date.now()
  });
}

function snapshotPwmClockIntentState() {
  const clockState = {
    nextTriggerAt: Number(schedule.nextTriggerAt),
    smartClockPlannedAt: Number(schedule.smartClockPlannedAt)
  };
  if (!Object.values(clockState).every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('PWM durable intent clock 不完整');
  }
  return Object.freeze(clockState);
}

function replayPwmClockIntentState(clockState) {
  setPwmClockIntent(clockState.nextTriggerAt, {
    plannedAt: clockState.smartClockPlannedAt
  });
  return true;
}

function snapshotPhaseAdoptionIntentState(options = {}) {
  const nextTriggerAt = Number(schedule.nextTriggerAt) || 0;
  const smartClockPlannedAt = Number(schedule.smartClockPlannedAt) || 0;
  if (options.allowMissingClock !== true
      && (nextTriggerAt <= 0 || smartClockPlannedAt <= 0)) {
    throw new Error('phase adoption durable intent clock 不完整');
  }
  const hasPageTimerError = Object.prototype.hasOwnProperty.call(
    options,
    'pageTimerError'
  );
  return Object.freeze({
    pwmState: schedule.pwmState,
    clockIntentState: Object.freeze({
      nextTriggerAt,
      smartClockPlannedAt
    }),
    pwmRetryKind: String(schedule.pwmRetryKind || ''),
    pwmRetryBoundaryAt: Number(schedule.pwmRetryBoundaryAt) || 0,
    pwmRetryScheduledAt: Number(schedule.pwmRetryScheduledAt) || 0,
    ...(hasPageTimerError
      ? { pageTimerError: String(options.pageTimerError || '') }
      : {})
  });
}

function replayPhaseAdoptionIntentState(adoptionState, options = {}) {
  if (!adoptionState || typeof adoptionState !== 'object') return false;
  if (options.replayClock !== false) {
    const clockState = adoptionState.clockIntentState;
    const nextTriggerAt = Number(clockState?.nextTriggerAt) || 0;
    if (nextTriggerAt > 0) {
      if (!replayPwmClockIntentState(clockState)) return false;
    } else {
      setPwmClockIntent(0);
    }
  }
  schedule.pwmState = adoptionState.pwmState;
  replaceSchedulePwmRetryState(schedule, {
    kind: adoptionState.pwmRetryKind,
    boundaryAt: adoptionState.pwmRetryBoundaryAt,
    scheduledAt: adoptionState.pwmRetryScheduledAt
  });
  if (Object.prototype.hasOwnProperty.call(adoptionState, 'pageTimerError')) {
    schedule.pageTimerError = adoptionState.pageTimerError;
  }
  return true;
}

function withPhaseAdoptionPageTimerError(adoptionState, pageTimerError) {
  return Object.freeze({
    ...adoptionState,
    pageTimerError: String(pageTimerError || '')
  });
}

function snapshotVerifiedPwmClockState(pwmAlarmWriteOwner) {
  if (!isPwmAlarmWriteOwnerCurrent(pwmAlarmWriteOwner)) return null;
  const clockState = {
    nextTriggerAt: Number(schedule.nextTriggerAt),
    smartClockPlannedAt: Number(schedule.smartClockPlannedAt),
    alarmCreatedAt: Number(schedule.alarmCreatedAt),
    alarmDelayMinutes: Number(schedule.alarmDelayMinutes),
    pwmAlarmWriteOwner: Number(pwmAlarmWriteOwner)
  };
  const clockValues = [
    clockState.nextTriggerAt,
    clockState.smartClockPlannedAt,
    clockState.alarmCreatedAt,
    clockState.alarmDelayMinutes
  ];
  if (!clockValues.every(value => Number.isFinite(value) && value > 0)
      || !Number.isSafeInteger(clockState.pwmAlarmWriteOwner)
      || clockState.pwmAlarmWriteOwner <= 0) {
    throw new Error('PWM 建钟成功但 verified clock 不完整');
  }
  return Object.freeze(clockState);
}

function replayVerifiedPwmClockState(clockState) {
  if (!isPwmAlarmWriteOwnerCurrent(clockState?.pwmAlarmWriteOwner)) return false;
  setNextTriggerAt(clockState.nextTriggerAt, {
    plannedAt: clockState.smartClockPlannedAt
  });
  schedule.alarmCreatedAt = clockState.alarmCreatedAt;
  schedule.alarmDelayMinutes = clockState.alarmDelayMinutes;
  return true;
}

async function persistOwnedPwmAlarmFailure({
  isCurrent,
  replayState,
  persistReason
}) {
  if (!isCurrent()) return false;
  await createAlarm('ac-watchdog', { periodInMinutes: 5 });
  if (!isCurrent() || replayState() !== true) return false;
  await persistSchedule(persistReason, { syncFromLiveAlarm: false });
  if (!isCurrent() || replayState() !== true) return false;
  return true;
}

async function persistOwnedVerifiedPwmState({
  isCurrent,
  verifiedClockState,
  replayState,
  persistReason
}) {
  const replayOwnedState = () => {
    if (!isCurrent()) return false;
    if (!replayVerifiedPwmClockState(verifiedClockState)) return false;
    if (replayState() !== true) return false;
    return isCurrent();
  };
  if (!replayOwnedState()) return false;
  await persistSchedule(persistReason, { syncFromLiveAlarm: false });
  return replayOwnedState();
}

async function commitOwnedPwmAlarmPlan({
  plan,
  logTag,
  automationRevision,
  previousWriteOwner = 0,
  plannedAt = 0,
  isCurrent,
  onOwnedClockChanged = null,
  replayFailureState,
  replaySuccessState,
  failurePersistReason,
  successPersistReason
}) {
  if (typeof isCurrent !== 'function'
      || typeof replayFailureState !== 'function'
      || typeof replaySuccessState !== 'function') {
    throw new TypeError('owned PWM alarm commit 缺少 state owner/replay');
  }
  const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
    plan,
    logTag,
    automationRevision,
    {
      plannedAt,
      previousWriteOwner,
      ensureCurrent: isCurrent
    }
  );
  if (alarmWrite.created && typeof onOwnedClockChanged === 'function') {
    onOwnedClockChanged();
  }
  const writeIsCurrent = () => (
    isCurrent()
    && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
  );
  const result = (created, persisted, stale) => Object.freeze({
    created,
    persisted,
    stale,
    writeOwner: alarmWrite.writeOwner
  });

  if (!alarmWrite.created) {
    if (!writeIsCurrent()) return result(false, false, true);
    const failurePersisted = await persistOwnedPwmAlarmFailure({
      isCurrent: writeIsCurrent,
      replayState: replayFailureState,
      persistReason: failurePersistReason
    });
    if (!failurePersisted) return result(false, false, true);
    await updateBadge();
    if (!writeIsCurrent()) return result(false, true, true);
    return result(false, true, false);
  }

  const verifiedClockState = snapshotVerifiedPwmClockState(
    alarmWrite.writeOwner
  );
  if (!verifiedClockState) return result(true, false, true);
  await createAlarm('ac-badge-tick', {
    delayInMinutes: 1,
    ensureCurrent: writeIsCurrent
  });
  if (!writeIsCurrent()) return result(true, false, true);
  const successPersisted = await persistOwnedVerifiedPwmState({
    isCurrent: writeIsCurrent,
    verifiedClockState,
    replayState: replaySuccessState,
    persistReason: successPersistReason
  });
  if (!successPersisted) return result(true, false, true);
  await updateBadge();
  if (!writeIsCurrent()) return result(true, true, true);
  return result(true, true, false);
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
    const repair = await repairScheduleClock({
      phaseAdmissionEpoch: context.phaseAdmissionEpoch
    });
    return {
      handled: repair?.success === true,
      fallbackAction: action,
      repair
    };
  }
  return { handled: false, fallbackAction: 'none' };
}

async function recoverPwmLifecycle(context = {}) {
  if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(context.phaseAdmissionEpoch)) {
    return {
      handled: false,
      plan: { kind: 'noop', reason: 'sync-phase-adoption-in-progress' }
    };
  }
  const automationRevision = Number.isSafeInteger(context.automationRevision)
    ? context.automationRevision
    : pwmRuntimeRevision;
  const requestedPreviousWriteOwner = context.previousWriteOwner;
  const hasPreviousWriteOwner = Number.isSafeInteger(
    requestedPreviousWriteOwner
  ) && requestedPreviousWriteOwner > 0;
  const recoveryContextIsCurrent = () => (
    isAutomationOperationCurrent(automationRevision)
    && isSyncPhaseAdoptionAdmissionOwnerCurrent(context.phaseAdmissionEpoch)
    && (typeof context.ensureCurrent !== 'function'
      || context.ensureCurrent())
    && (typeof context.isPageTimerStateCurrent !== 'function'
      || context.isPageTimerStateCurrent())
    && (!hasPreviousWriteOwner
      || isPwmAlarmWriteGenerationCurrent(requestedPreviousWriteOwner))
  );
  if (!recoveryContextIsCurrent()) {
    await abortStaleAutomation(
      automationRevision,
      'lifecycle-entry-active-hours-paused',
      { phaseAdmissionEpoch: context.phaseAdmissionEpoch }
    );
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
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
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
      boundaryAt,
      ensureCurrent: recoveryContextIsCurrent,
      onOwnedStateChanged: context.onOwnedPhaseStateChanged
    });
    if (!recoveryContextIsCurrent()) {
      await abortStaleAutomation(
        automationRevision,
        'lifecycle-prepare-active-hours-paused',
        { phaseAdmissionEpoch: context.phaseAdmissionEpoch }
      );
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
      if (typeof context.onDeferredExecutionStarted === 'function') {
        context.onDeferredExecutionStarted(execution);
      }
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
        automationRevision,
        context.phaseAdmissionEpoch
      );
      return { handled: true, plan, triggerPlan };
    }
    const synced = await syncStoredTriggerFromAlarm(
      context.existingAlarm,
      reason,
      automationRevision,
      context.phaseAdmissionEpoch
    );
    return { handled: synced, plan };
  }

  if (plan.kind === 'restore-stored-alarm') {
    const restored = await restoreIntervalAlarmFromStorage(
      context.restoreReason || `${context.source || 'lifecycle'}: 按 storage 恢复 PWM 闹钟`,
      context.phaseAdmissionEpoch
    );
    if (restored) return { handled: true, plan };
    const fallback = await executePwmLifecycleRecoveryFallback(
      context.failureAction,
      context
    );
    return { ...fallback, plan };
  }

  if (plan.kind === 'advance-expired-alarm') {
    if (!recoveryContextIsCurrent()) {
      await abortStaleAutomation(
        automationRevision,
        'lifecycle-expired-active-hours-paused',
        { phaseAdmissionEpoch: context.phaseAdmissionEpoch }
      );
      return { handled: false, plan: { kind: 'noop', reason: 'caller-stale' } };
    }
    const expiredRecovery = await executeExpiredIntervalRecovery(
      plan.scheduledTime,
      automationRevision,
      {
        returnReceipt: context.returnPwmCommitReceipt === true,
        phaseAdmissionEpoch: context.phaseAdmissionEpoch,
        previousWriteOwner: context.previousWriteOwner,
        ensureCurrent: context.ensureCurrent,
        isPageTimerStateCurrent: context.isPageTimerStateCurrent,
        onPageTimerWriteOwnerClaimed: context.onPageTimerWriteOwnerClaimed,
        onOwnedPhaseStateChanged: context.onOwnedPhaseStateChanged
      }
    );
    const advanced = expiredRecovery === true
      || expiredRecovery?.advanced === true;
    if (advanced) {
      return {
        handled: true,
        plan,
        ...(expiredRecovery && typeof expiredRecovery === 'object'
          ? { pwmCommitReceipt: expiredRecovery }
          : {})
      };
    }
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
      phaseAdmissionEpoch: context.phaseAdmissionEpoch,
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

async function waitForScheduleUpdatesToSettle() {
  while (true) {
    const observed = scheduleUpdateChain;
    await observed.catch(() => {});
    if (observed === scheduleUpdateChain) return;
  }
}

function runSerializedSchedulePhaseOperation(operation, reason = 'schedule-phase') {
  return runSerializedScheduleUpdate(async () => {
    // 独立 schedule writer 遵守 schedule -> phase 的唯一锁顺序。已经持有
    // phase 的调用方必须直接借用，不能调用本包装器反向等待 schedule。
    const phaseAdmissionEpoch = await claimSyncPhaseAdoptionAdmissionWhenAvailable();
    try {
      return await operation(phaseAdmissionEpoch);
    } finally {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair(`${reason}-complete`);
    }
  });
}

async function runSmartReapplyLoop() {
  smartReapplyInFlight = true;
  let deferredUntilOwnerRelease = false;
  try {
    do {
      smartReapplyPending = false;
      try {
        const outcome = await reapplySmartSensitivityNow();
        if (outcome?.deferred) {
          smartReapplyPending = true;
          if (!pwmStepRunning
              && !isSyncPhaseAdoptionAdmissionBlocked()) continue;
          deferredUntilOwnerRelease = true;
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
    if (!deferredUntilOwnerRelease) smartReapplyPending = false;
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
  const ensureCurrent = typeof options.ensureCurrent === 'function'
    ? options.ensureCurrent
    : null;
  const onOwnedStateChanged = typeof options.onOwnedStateChanged === 'function'
    ? options.onOwnedStateChanged
    : null;
  if (ensureCurrent && !ensureCurrent()) return false;
  const preparationOwner = snapshotSmartPreparationOwner();
  const preparationIsCurrent = () => (
    isSmartPreparationOwnerCurrent(preparationOwner)
    && (!ensureCurrent || ensureCurrent())
  );
  const recordOwnedStateChanged = () => {
    if (onOwnedStateChanged) onOwnedStateChanged();
  };

  try {
    const requestedBoundaryAt = Number(options.boundaryAt);
    const boundaryAt = Number.isSafeInteger(requestedBoundaryAt) && requestedBoundaryAt > 0
      ? requestedBoundaryAt
      : currentSmartControlBoundary();
    const stored = await chrome.storage.local.get(SMART_WEATHER_PLAN_KEY);
    if (!preparationIsCurrent()) return false;
    let suggested = consumeSmartWeatherDecision(stored[SMART_WEATHER_PLAN_KEY], {
      boundaryAt,
      sensitivity: preparationOwner.smartSensitivity
    });

    if (!suggested?.valid) {
      const cachedWeather = await readStoredSmartWeather();
      if (!preparationIsCurrent()) return false;
      suggested = consumeStoredSmartWeatherDecision(cachedWeather, {
        boundaryAt,
        sensitivity: preparationOwner.smartSensitivity
      });
    }

    if (!preparationIsCurrent()) return false;
    if (!suggested?.valid) {
      applySmartDurationFallback();
      recordOwnedStateChanged();
      console.warn('[AC扩展] 智能模式：目标边界预计算缺失，本周期沿用安全时长');
      return false;
    }

    applySmartDurationDecision(suggested);
    recordOwnedStateChanged();

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
    if (!preparationIsCurrent()) return false;
    applySmartDurationFallback();
    recordOwnedStateChanged();
    console.warn('[AC扩展] 智能模式预计算读取失败，本周期沿用安全时长:', error?.message);
    void appendDiagnosticLog('warn', 'smart-duration-prepare', error);
    return false;
  }
}

function snapshotSmartReapplyState(derivedState, pageTimerState, options = {}) {
  if (!isPageTimerWriteOwnerCurrent(pageTimerState?.pageTimerWriteOwner)) {
    return null;
  }
  const hasPageTimerError = Object.prototype.hasOwnProperty.call(
    options,
    'pageTimerError'
  );
  return Object.freeze({
    onMinutes: derivedState.onMinutes,
    offMinutes: derivedState.offMinutes,
    smartOnBoundaryAt: Number(derivedState.smartOnBoundaryAt) || 0,
    pageTimerState: Object.freeze({
      pageTimerMinutes: pageTimerState.pageTimerMinutes ?? null,
      pageTimerTargetAt: Number(pageTimerState.pageTimerTargetAt) || 0,
      pageTimerError: hasPageTimerError
        ? options.pageTimerError
        : (pageTimerState.pageTimerError ?? ''),
      pageTimerRetryAt: Number(pageTimerState.pageTimerRetryAt) || 0,
      pageTimerRetryMinutes: Number(pageTimerState.pageTimerRetryMinutes) || 0,
      pageTimerWriteOwner: Number(pageTimerState.pageTimerWriteOwner)
    })
  });
}

function replaySmartReapplyState(reapplyState) {
  if (!replayOwnedPageTimerState(reapplyState?.pageTimerState)) return false;
  schedule.onMinutes = reapplyState.onMinutes;
  schedule.offMinutes = reapplyState.offMinutes;
  schedule.smartOnBoundaryAt = reapplyState.smartOnBoundaryAt;
  return true;
}

function withSmartReapplyPageTimerError(reapplyState, pageTimerError) {
  return Object.freeze({
    ...reapplyState,
    pageTimerState: Object.freeze({
      ...reapplyState.pageTimerState,
      pageTimerError
    })
  });
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
  if (pwmStepRunning || isSyncPhaseAdoptionAdmissionBlocked()) {
    return { deferred: true };
  }
  // 一分钟 smart-on 重试是已持久化事务；滑块值本身已由 updateSchedule 保存，
  // 但不能在事务中途改写 onMinutes/绝对截止。新灵敏度由下一半点消费。
  if (getActiveSmartOnPwmRetryContext(schedule).hasTypedSmartOnRetry) {
    return { retryProtected: true };
  }

  const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) return { deferred: true };
  try {

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
  if (pwmStepRunning
      || !isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
    return { deferred: true };
  }
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
  const reapplyOwner = Object.freeze({
    automationRevision: oldPwmRuntimeRevision,
    pwmState: oldPwmState,
    mode: schedule.mode,
    clockMode: !!schedule.clockMode,
    smartSensitivity: schedule.smartMode.sensitivity
  });
  const suggested = computeSmartOnMinutes({
    sensitivity: reapplyOwner.smartSensitivity,
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
  const reapplyDurations = Object.freeze({
    onMinutes: schedule.onMinutes,
    offMinutes: schedule.offMinutes
  });

  if (!wasOnPhase) {
    await persistSchedule('reapply-smart-sensitivity-off-phase', {
      syncFromLiveAlarm: false
    });
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
  // storage.onChanged 可在任意后续 await 中整体替换 schedule；事务字段必须
  // 在首个 await 前冻结，不能事后从可替换全局对象回读。
  const reapplyDerivedState = Object.freeze({
    ...reapplyDurations,
    smartOnBoundaryAt: activeSmartBoundaryAt
  });
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

  const reapplyContextIsCurrent = () => (
    isAutomationOperationCurrent(reapplyOwner.automationRevision)
    && !pwmStepRunning
    && isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && schedule.pwmState === reapplyOwner.pwmState
    && schedule.mode === reapplyOwner.mode
    && !!schedule.clockMode === reapplyOwner.clockMode
    && schedule.smartMode?.enabled === true
    && schedule.smartMode.sensitivity === reapplyOwner.smartSensitivity
    && !getActiveSmartOnPwmRetryContext(schedule).hasTypedSmartOnRetry
  );

  // 先清旧 alarm，避免旧关机时刻在慢速新鲜页验证期间抢跑；页面写入方返回
  // 已对齐 UST HH:MM 接口的绝对 targetAt，再用同一值恢复扩展倒计时。
  const clearAlarmWrite = await clearPwmAlarmWithReceipt(
    oldPwmRuntimeRevision
  );
  if (!clearAlarmWrite.cleared
      || await abortStaleAutomation(
        oldPwmRuntimeRevision,
        'reapply-smart-clear-active-hours-paused',
        { phaseAdmissionEpoch }
      )
      || !reapplyContextIsCurrent()
      || !isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)) {
    return { retry: true };
  }
  setPwmClockIntent(0);
  const timerResult = await setPageTimer(minutes, {
    retryOnFailure: false,
    targetAt: smartDeadlineAt,
    automationRevision: oldPwmRuntimeRevision,
    ensureCurrent: () => (
      reapplyContextIsCurrent()
      && isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)
    )
  });
  if (await abortStaleAutomation(
    oldPwmRuntimeRevision,
    'reapply-smart-sensitivity-active-hours-paused',
    { phaseAdmissionEpoch }
  )) return;
  const pageTimerWriteOwner = Number(timerResult?.pageTimerWriteOwner) || 0;
  const reapplyStateIsCurrent = () => (
    reapplyContextIsCurrent()
    && isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
  );
  if (!reapplyStateIsCurrent()
      || !isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)) {
    return { retry: true };
  }
  if (!timerResult?.success) {
    const pageTimerError = `灵敏度即时应用时页面关机定时器未确认：${timerResult?.error || '未知错误'}；1 分钟后重试`;
    const reapplyRetryState = snapshotSmartReapplyState(
      reapplyDerivedState,
      timerResult?.pageTimerState,
      { pageTimerError }
    );
    if (!reapplyRetryState
        || !replaySmartReapplyState(reapplyRetryState)) {
      return { retry: true };
    }
    const retryAt = Date.now() + 60000;
    setPwmClockIntent(retryAt);
    const retryClockIntentState = snapshotPwmClockIntentState();
    const retryAlarmFailureState = withSmartReapplyPageTimerError(
      reapplyRetryState,
      `${pageTimerError}；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复`
    );
    await persistSchedule('reapply-smart-sensitivity-pageTimer-retry-intent', {
      syncFromLiveAlarm: false
    });
    if (!reapplyStateIsCurrent()) return { retry: true };
    const retryCommit = await commitOwnedPwmAlarmPlan({
      plan: { nextTriggerAt: retryAt },
      logTag: 'reapply-smart-pageTimer-failed',
      automationRevision: oldPwmRuntimeRevision,
      previousWriteOwner: clearAlarmWrite.writeOwner,
      plannedAt: retryClockIntentState.smartClockPlannedAt,
      isCurrent: reapplyStateIsCurrent,
      replayFailureState: () => {
        replayPwmClockIntentState(retryClockIntentState);
        return replaySmartReapplyState(retryAlarmFailureState);
      },
      replaySuccessState: () => replaySmartReapplyState(reapplyRetryState),
      failurePersistReason: 'reapply-smart-sensitivity-pageTimer-retry-alarm-failed',
      successPersistReason: 'reapply-smart-sensitivity-pageTimer-failed'
    });
    if (retryCommit.stale) {
      await abortStaleAutomation(
        oldPwmRuntimeRevision,
        'reapply-smart-retry-active-hours-paused',
        { phaseAdmissionEpoch }
      );
      return { retry: true };
    }
    if (!retryCommit.created) {
      return { success: false, deferred: true, alarmCreated: false };
    }
    return;
  }

  const reapplyTargetAt = Number(timerResult.targetAt) || 0;
  const reapplyCommitState = snapshotSmartReapplyState(
    reapplyDerivedState,
    timerResult.pageTimerState
  );
  if (!reapplyCommitState || reapplyTargetAt <= nowMs) {
    return { retry: true };
  }
  setPwmClockIntent(reapplyTargetAt);
  const reapplyClockIntentState = snapshotPwmClockIntentState();
  const reapplyAlarmFailureState = withSmartReapplyPageTimerError(
    reapplyCommitState,
    '灵敏度即时应用已确认页面关机时间，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复'
  );
  await persistSchedule('reapply-smart-sensitivity-commit-intent', {
    syncFromLiveAlarm: false
  });
  const reapplyPlan = { nextTriggerAt: reapplyTargetAt };
  if (!reapplyStateIsCurrent()) return { retry: true };
  const reapplyCommit = await commitOwnedPwmAlarmPlan({
    plan: reapplyPlan,
    logTag: 'reapply-smart-sensitivity',
    automationRevision: oldPwmRuntimeRevision,
    previousWriteOwner: clearAlarmWrite.writeOwner,
    plannedAt: reapplyClockIntentState.smartClockPlannedAt,
    isCurrent: reapplyStateIsCurrent,
    replayFailureState: () => {
      replayPwmClockIntentState(reapplyClockIntentState);
      return replaySmartReapplyState(reapplyAlarmFailureState);
    },
    replaySuccessState: () => replaySmartReapplyState(reapplyCommitState),
    failurePersistReason: 'reapply-smart-sensitivity-commit-alarm-failed',
    successPersistReason: 'reapply-smart-sensitivity-on-phase'
  });
  if (reapplyCommit.stale) {
    await abortStaleAutomation(
      oldPwmRuntimeRevision,
      'reapply-smart-commit-active-hours-paused',
      { phaseAdmissionEpoch }
    );
    return { retry: true };
  }
  if (!reapplyCommit.created) {
    return { success: false, deferred: true, alarmCreated: false };
  }

  console.log(
    `[AC扩展] 滑块灵敏度即时应用: sens=${reapplyOwner.smartSensitivity}`
    + ` → on=${suggested.onMinutes}min, 页面目标 ${new Date(reapplyTargetAt).toLocaleTimeString()}`
  );
  } finally {
    releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
    drainDeferredScheduleRepair('smart-reapply-complete');
  }
}

function clearPageTimerProofState() {
  const pageTimerWriteOwner = invalidatePageTimerWriteOwner();
  clearSchedulePageTimerProofState(schedule);
  return pageTimerWriteOwner;
}

function clearPwmRetryState() {
  replaceSchedulePwmRetryState(schedule);
}

function setSmartOnPwmRetryState(targetAction, retryScheduledAt, options = {}) {
  clearPwmRetryState();
  const requestedKind = String(options?.kind || '');
  const retryKind = normalizePwmRetryKind(requestedKind);
  const retryDescriptor = getPwmRetryDescriptor(retryKind);
  const boundaryAt = Number.isFinite(Number(options?.boundaryAt))
    ? Number(options.boundaryAt)
    : Number(schedule.smartOnBoundaryAt);
  const scheduledAt = Number(retryScheduledAt);
  const boundaryDate = new Date(boundaryAt);
  const exactHalfHour = Number.isSafeInteger(boundaryAt)
    && (boundaryDate.getMinutes() === 0 || boundaryDate.getMinutes() === 30)
    && boundaryDate.getSeconds() === 0
    && boundaryDate.getMilliseconds() === 0;
  const boundaryOptionalRetry = retryDescriptor?.boundaryRequired === false;
  if (!schedule.smartMode?.enabled
      || targetAction !== 'on'
      || (!boundaryOptionalRetry && (!exactHalfHour || boundaryAt <= 0))
      || (boundaryOptionalRetry && boundaryAt !== 0 && !exactHalfHour)
      || !Number.isFinite(scheduledAt)
      || scheduledAt <= 0) return;
  replaceSchedulePwmRetryState(schedule, {
    kind: retryKind,
    boundaryAt: exactHalfHour ? boundaryAt : 0,
    scheduledAt
  });
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
  const retryDescriptor = getPwmRetryDescriptor(retryKind);
  const hasStoredSmartOnRetry = retryDescriptor?.storedSmartOnRetry === true;
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
  const hasTypedSmartOnRetry = retryDescriptor?.ownsTypedSmartOn === true
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
  const hasSafetyTimerRetry = retryDescriptor?.repairsSafetyTimer === true
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

function classifyPwmSmartRetryAdmission(scheduleSnapshot, scheduledTime) {
  const candidate = getSmartOnPwmRetryContext(scheduleSnapshot, scheduledTime);
  const isTyped = candidate.hasTypedSmartOnRetry === true;
  const clearInvalidOwner = candidate.hasStoredSmartOnRetry === true && !isTyped;
  return Object.freeze({
    isTyped,
    boundaryAt: Number(candidate.boundaryAt) || 0,
    priorError: String(candidate.priorError || ''),
    rejectedError: clearInvalidOwner
      ? `智能开机重试身份不匹配：${scheduleSnapshot?.pageTimerError || '原重试闹钟已失效'}；等待可信半点或新周期`
      : '',
    clearInvalidOwner
  });
}

function activatePwmSmartRetryContext(admission, scheduleSnapshot, now = Date.now) {
  const targetAt = Number(admission?.boundaryAt)
    + Number(scheduleSnapshot?.onMinutes) * 60000;
  const active = admission?.isTyped === true
    && scheduleSnapshot?.smartMode?.enabled
    && scheduleSnapshot?.pwmState === 'on'
    && targetAt >= nextSafePageTimerTargetAt(now());
  return Object.freeze({ ...admission, active, targetAt });
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
    const durableRetryDescriptor = getPwmRetryDescriptor(durableRetryKind);
    const retryOwnsBoundary = durableRetryDescriptor !== null
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
  setPwmClockIntent(0);
}

function applyPwmPlanState(plan) {
  const pageTimerWriteOwner = plan?.proofAction === 'clear'
    ? clearPageTimerProofState()
    : 0;
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
  return pageTimerWriteOwner;
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
  clearPwmRetryState();
  setPwmClockIntent(0);
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
    : null,
  phaseAdmissionEpoch = 0
) {
  const requiresPhaseOwner = Number.isSafeInteger(phaseAdmissionEpoch)
    && phaseAdmissionEpoch > 0;
  const reconciliationIsCurrent = () => (
    requiresPhaseOwner
      ? isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
      : !isSyncPhaseAdoptionAdmissionBlocked()
  );
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || (automationRevision !== null
        && typeof isAutomationOperationCurrent === 'function'
        && !isAutomationOperationCurrent(automationRevision))
      || !reconciliationIsCurrent()) {
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
        && !isAutomationOperationCurrent(automationRevision))
      || !reconciliationIsCurrent()) {
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
    : null,
  phaseAdmissionEpoch = 0
) {
  const plan = await persistReconciledPwmTrigger(
    alarm,
    reason,
    PWM_TRIGGER_STRICT_OPTIONS,
    automationRevision,
    phaseAdmissionEpoch
  );
  if (!plan) {
    // persistReconciledPwmTrigger 的 null 同时覆盖两种完全不同的结果：
    // live clock 已严格对齐（无需写 storage），以及 caller/clock 已失效。
    // 不能把前者当成主钟未收口，否则保留一个已完全对齐的 live clock 也会报错。
    // 用重新读取的 durable+live owner 证明区分二者，并把证明前后都锁在
    // 同一个 phase admission；证明期间若换主，旧 caller 仍 fail closed。
    const requiresPhaseOwner = Number.isSafeInteger(phaseAdmissionEpoch)
      && phaseAdmissionEpoch > 0;
    const reconciliationOwnerIsCurrent = () => (
      requiresPhaseOwner
        ? isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
        : !isSyncPhaseAdoptionAdmissionBlocked()
    );
    if (!reconciliationOwnerIsCurrent()) return false;
    const committed = await hasDurableLivePwmOwner(automationRevision);
    return committed === true && reconciliationOwnerIsCurrent();
  }

  console.log(`[AC扩展] ${reason}: ${new Date(plan.liveScheduledTime).toLocaleTimeString()}`);
  return true;
}

function getLiveAlarmEndMs(alarm) {
  const scheduledTime = alarm?.scheduledTime;
  return scheduledTime && scheduledTime > Date.now() ? scheduledTime : 0;
}

async function backfillNextTriggerAt(
  persist = false,
  phaseAdmissionEpoch = 0
) {
  const requiresPhaseOwner = Number.isSafeInteger(phaseAdmissionEpoch)
    && phaseAdmissionEpoch > 0;
  const backfillIsCurrent = () => (
    requiresPhaseOwner
      ? isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
      : !isSyncPhaseAdoptionAdmissionBlocked()
  );
  if (!backfillIsCurrent()) return 0;
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
      if (!backfillIsCurrent()) return 0;
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
    if (!isAutomationOperationCurrent(automationRevision)
        || !backfillIsCurrent()) return 0;
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
      if (!backfillIsCurrent()) return 0;
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
  phaseAdmissionEpoch = 0,
  options = {}
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
    failureAction: 'none',
    returnPwmCommitReceipt: true,
    previousWriteOwner: options.previousWriteOwner,
    ensureCurrent: options.ensureCurrent,
    isPageTimerStateCurrent: options.isPageTimerStateCurrent,
    onPageTimerWriteOwnerClaimed: options.onPageTimerWriteOwnerClaimed,
    onOwnedPhaseStateChanged: options.onOwnedPhaseStateChanged
  });
  const commitReceipt = recovery.pwmCommitReceipt;
  const commitPageTimerWriteOwner = Number.isSafeInteger(
    commitReceipt?.pageTimerWriteOwner
  ) && commitReceipt.pageTimerWriteOwner > 0
    ? commitReceipt.pageTimerWriteOwner
    : 0;
  const commitPageTimerState = commitPageTimerWriteOwner > 0
      ? snapshotOwnedPageTimerState(
        commitPageTimerWriteOwner,
        commitReceipt?.pageTimerState ?? null
      )
    : null;
  const commitVerifiedClockState = commitReceipt?.verifiedClockState;
  const commitPhaseState = commitReceipt?.phaseState;
  const replayCommitOwnedState = () => {
    if (!continuationIsCurrent()) return false;
    if (!replayVerifiedPwmClockState(commitVerifiedClockState)) return false;
    if (!commitPhaseState || typeof commitPhaseState !== 'object') return false;
    Object.assign(schedule, commitPhaseState);
    if (commitPageTimerWriteOwner > 0
        && (commitPageTimerState === null
          || !replayOwnedPageTimerState(commitPageTimerState))) {
      return false;
    }
    return continuationIsCurrent()
      && isPwmAlarmWriteOwnerCurrent(commitReceipt?.writeOwner);
  };
  const failedReceipt = () => Object.freeze({
    advanced: false,
    persisted: false,
    writeOwner: Number(commitReceipt?.writeOwner) || 0,
    pageTimerWriteOwner: commitPageTimerWriteOwner,
    pageTimerState: commitPageTimerState,
    verifiedClockState: commitVerifiedClockState,
    phaseState: commitPhaseState
  });
  const continuationIsCurrent = () => (
    (typeof options.ensureCurrent !== 'function' || options.ensureCurrent())
    && (typeof options.isPageTimerStateCurrent !== 'function'
      || commitPageTimerWriteOwner > 0
      || options.isPageTimerStateCurrent())
    && (commitPageTimerWriteOwner <= 0
      || isPageTimerWriteOwnerCurrent(commitPageTimerWriteOwner))
  );
  if (recovery.handled !== true
      || commitReceipt?.advanced !== true
      || commitReceipt.persisted !== true
      || !continuationIsCurrent()
      || !replayCommitOwnedState()
      || !isPwmAlarmWriteOwnerCurrent(commitReceipt.writeOwner)) {
    return failedReceipt();
  }

  // shared executor 的 cooldown/early-return 过去会被包装成 handled=true。
  // adoption 已清旧钟时，只有 durable future owner 与 live ac-pwm 同时存在
  // 且对齐，才算真的推进成功；否则由 adoption catch 走 fresh-status repair。
  const now = Date.now();
  const liveAt = Number((await chrome.alarms.get('ac-pwm'))?.scheduledTime) || 0;
  if (!replayCommitOwnedState()
      || !isPwmAlarmWriteOwnerCurrent(commitReceipt.writeOwner)
      || Number(schedule.nextTriggerAt) <= now
      || liveAt <= now
      || Math.abs(Number(schedule.nextTriggerAt) - liveAt)
        > PWM_RETRY_ALARM_TOLERANCE_MS
      || Math.abs(Number(commitReceipt.nextTriggerAt) - liveAt)
        > PWM_RETRY_ALARM_TOLERANCE_MS) {
    return failedReceipt();
  }
  return Object.freeze({
    advanced: true,
    persisted: true,
    writeOwner: commitReceipt.writeOwner,
    nextTriggerAt: Number(commitReceipt.nextTriggerAt),
    pageTimerWriteOwner: commitPageTimerWriteOwner,
    pageTimerState: commitPageTimerState,
    verifiedClockState: commitVerifiedClockState,
    phaseState: commitPhaseState
  });
}

// 普通循环模式的过期相位执行器。策略选择由 recoverPwmLifecycle 统一完成；
// 本函数只保留页面定时器、闹钟与 storage 等副作用。
async function executeExpiredIntervalRecovery(
  expiredScheduledTime,
  automationRevision = pwmRuntimeRevision,
  options = {}
) {
  let pageTimerWriteOwner = 0;
  let ownedPageTimerState = null;
  const requestedPreviousWriteOwner = options.previousWriteOwner;
  let expectedPwmWriteGeneration = Number.isSafeInteger(requestedPreviousWriteOwner)
      && requestedPreviousWriteOwner > 0
    ? requestedPreviousWriteOwner
    : pwmAlarmWriteGeneration;
  const callerIsCurrent = () => (
    typeof options.ensureCurrent !== 'function' || options.ensureCurrent()
  );
  const pageTimerStateIsCurrent = () => (
    pageTimerWriteOwner > 0
      ? isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
      : (typeof options.isPageTimerStateCurrent !== 'function'
        || options.isPageTimerStateCurrent())
  );
  const baseRecoveryIsCurrent = () => (
    isAutomationOperationCurrent(automationRevision)
    && isSyncPhaseAdoptionAdmissionOwnerCurrent(options.phaseAdmissionEpoch)
    && callerIsCurrent()
    && pageTimerStateIsCurrent()
  );
  const recoveryIsCurrent = () => (
    baseRecoveryIsCurrent()
    && isPwmAlarmWriteGenerationCurrent(expectedPwmWriteGeneration)
  );
  const takePageTimerWriteOwner = (owner, pageTimerState = undefined) => {
    const claimedOwner = owner;
    if (!Number.isSafeInteger(claimedOwner) || claimedOwner <= 0) return 0;
    pageTimerWriteOwner = claimedOwner;
    ownedPageTimerState = snapshotOwnedPageTimerState(
      claimedOwner,
      pageTimerState === undefined ? schedule : pageTimerState
    );
    if (!ownedPageTimerState) return 0;
    if (typeof options.onPageTimerWriteOwnerClaimed === 'function') {
      options.onPageTimerWriteOwnerClaimed(claimedOwner);
    }
    return claimedOwner;
  };
  const captureOwnedPageTimerState = () => {
    if (pageTimerWriteOwner <= 0) return true;
    ownedPageTimerState = snapshotOwnedPageTimerState(
      pageTimerWriteOwner,
      schedule
    );
    return ownedPageTimerState !== null;
  };
  const replayRecoveryPageTimerState = () => (
    pageTimerWriteOwner <= 0
      || (ownedPageTimerState !== null
        && replayOwnedPageTimerState(ownedPageTimerState))
  );
  const replayRecoveryIntentState = (clockIntentState, phaseState) => {
    if (!recoveryIsCurrent()) return false;
    replayPwmClockIntentState(clockIntentState);
    Object.assign(schedule, phaseState);
    if (!replayRecoveryPageTimerState()) return false;
    recordOwnedPhaseMutation();
    return recoveryIsCurrent();
  };
  const persistRecoveryIntent = async (
    persistReason,
    clockIntentState,
    phaseState
  ) => {
    if (!replayRecoveryIntentState(clockIntentState, phaseState)) return false;
    await persistSchedule(persistReason, { syncFromLiveAlarm: false });
    return replayRecoveryIntentState(clockIntentState, phaseState);
  };
  const recordOwnedPhaseMutation = () => {
    if (typeof options.onOwnedPhaseStateChanged === 'function') {
      options.onOwnedPhaseStateChanged();
    }
  };
  const clearExpectedPwmAlarm = async () => {
    const clearAlarmWrite = await clearPwmAlarmWithReceipt(
      automationRevision,
      false,
      {
        expectedWriteGeneration: expectedPwmWriteGeneration,
        ensureCurrent: baseRecoveryIsCurrent
      }
    );
    if (clearAlarmWrite.writeOwner > 0) {
      expectedPwmWriteGeneration = clearAlarmWrite.writeOwner;
    }
    return clearAlarmWrite;
  };
  const successfulRecovery = (
    alarmWrite,
    verifiedClockState,
    phaseState
  ) => options.returnReceipt === true
    ? Object.freeze({
        advanced: true,
        persisted: true,
        writeOwner: alarmWrite.writeOwner,
        nextTriggerAt: Number(schedule.nextTriggerAt),
        pageTimerWriteOwner,
        pageTimerState: ownedPageTimerState,
        verifiedClockState,
        phaseState
      })
    : true;
  if (!recoveryIsCurrent()) return false;

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
      'advance-expired-active-hours-paused',
      { phaseAdmissionEpoch: options.phaseAdmissionEpoch }
    ) || !recoveryIsCurrent()) return false;
    observations = { acIsOn: status?.isOn };
    plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);

    if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
      takePageTimerWriteOwner(applyPwmPlanState(plan));
      recordOwnedPhaseMutation();
      if (!recoveryIsCurrent()) return false;
      const timerResult = await setPageTimer(plan.timerMinutes, {
        retryOnFailure: false,
        automationRevision,
        ensureCurrent: recoveryIsCurrent,
        onWriteOwnerClaimed: takePageTimerWriteOwner
      });
      takePageTimerWriteOwner(
        timerResult?.pageTimerWriteOwner,
        timerResult?.pageTimerState ?? null
      );
      if (await abortStaleAutomation(
        automationRevision,
        'advance-expired-page-timer-active-hours-paused',
        { phaseAdmissionEpoch: options.phaseAdmissionEpoch }
      ) || !recoveryIsCurrent()
        || !replayRecoveryPageTimerState()) return false;
      observations = {
        ...observations,
        pageTimerSucceeded: !!timerResult?.success,
        pageTimerTargetAt: Number(timerResult?.targetAt)
      };
      plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);
    }
  }

  if (plan.kind === 'retry') {
    const retryPhaseState = { ...plan.phasePatch };
    delete retryPhaseState.nextTriggerAt;
    Object.freeze(retryPhaseState);
    takePageTimerWriteOwner(applyPwmPlanState(plan));
    setPwmClockIntent(schedule.nextTriggerAt, {
      plannedAt: schedule.smartClockPlannedAt
    });
    recordOwnedPhaseMutation();
    if (!recoveryIsCurrent() || !replayRecoveryPageTimerState()) return false;
    const retryClockIntentState = snapshotPwmClockIntentState();
    schedule.pageTimerError = `过期闹钟恢复时页面关机定时器未确认：${schedule.pageTimerError || '未知错误'}；1 分钟后重试`;
    if (!captureOwnedPageTimerState()) return false;
    const retryAlarmFailureError = `${schedule.pageTimerError}；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复`;
    const retryAlarmFailurePageTimerState = snapshotOwnedPageTimerState(
      pageTimerWriteOwner,
      {
        ...ownedPageTimerState,
        pageTimerError: retryAlarmFailureError
      }
    );
    if (!retryAlarmFailurePageTimerState) return false;
    if (!await persistRecoveryIntent(
      'advanceExpiredAlarmToNextBoundary-retry-intent',
      retryClockIntentState,
      retryPhaseState
    )) return false;
    const clearAlarmWrite = await clearExpectedPwmAlarm();
    if (!clearAlarmWrite.cleared
        || !recoveryIsCurrent()
        || !replayRecoveryIntentState(
          retryClockIntentState,
          retryPhaseState
        )) return false;
    const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
      plan,
      'advance-pageTimer-failed',
      automationRevision,
      {
        expectedWriteGeneration: expectedPwmWriteGeneration,
        ensureCurrent: baseRecoveryIsCurrent
      }
    );
    if (alarmWrite.writeOwner > 0) {
      expectedPwmWriteGeneration = alarmWrite.writeOwner;
    }
    recordOwnedPhaseMutation();
    if (!recoveryIsCurrent()) return false;
    if (!alarmWrite.created) {
      if (!replayRecoveryIntentState(
        retryClockIntentState,
        retryPhaseState
      )) return false;
      const failureIsCurrent = () => (
        baseRecoveryIsCurrent()
        && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
      );
      await persistOwnedPwmAlarmFailure({
        isCurrent: failureIsCurrent,
        replayState: () => {
          replayPwmClockIntentState(retryClockIntentState);
          Object.assign(schedule, retryPhaseState);
          if (!replayOwnedPageTimerState(
            retryAlarmFailurePageTimerState
          )) return false;
          recordOwnedPhaseMutation();
          return true;
        },
        persistReason: 'advanceExpiredAlarmToNextBoundary-retry-alarm-failed'
      });
      return false;
    }
    const verifiedClockState = snapshotVerifiedPwmClockState(alarmWrite.writeOwner);
    if (!verifiedClockState) return false;
    const replayRetryCommitState = () => {
      if (!recoveryIsCurrent()) return false;
      if (!replayVerifiedPwmClockState(verifiedClockState)) return false;
      Object.assign(schedule, retryPhaseState);
      if (!replayRecoveryPageTimerState()) return false;
      recordOwnedPhaseMutation();
      return recoveryIsCurrent();
    };
    await createAlarm('ac-badge-tick', {
      delayInMinutes: 1,
      ensureCurrent: recoveryIsCurrent
    });
    if (!replayRetryCommitState()) return false;
    if (await abortStaleAutomation(
      automationRevision,
      'advance-retry-active-hours-paused',
      { phaseAdmissionEpoch: options.phaseAdmissionEpoch }
    )) return false;
    if (!replayRetryCommitState()) return false;
    const retryPersisted = await persistOwnedVerifiedPwmState({
      isCurrent: recoveryIsCurrent,
      verifiedClockState,
      replayState: () => {
        Object.assign(schedule, retryPhaseState);
        if (!replayRecoveryPageTimerState()) return false;
        recordOwnedPhaseMutation();
        return true;
      },
      persistReason: 'advanceExpiredAlarmToNextBoundary-pageTimer-failed'
    });
    if (!retryPersisted || !replayRetryCommitState()) return false;
    await updateBadge();
    if (!replayRetryCommitState()) return false;
    return successfulRecovery(alarmWrite, verifiedClockState, retryPhaseState);
  }

  if (plan.kind !== 'commit') return false;

  const committedPhaseState = { ...plan.phasePatch };
  delete committedPhaseState.nextTriggerAt;
  Object.freeze(committedPhaseState);
  takePageTimerWriteOwner(applyPwmPlanState(plan));
  recordOwnedPhaseMutation();
  if (!recoveryIsCurrent() || !replayRecoveryPageTimerState()) return false;
  if (plan.proofAction === 'clear') {
    const replayPlan = Object.freeze({
      ...plan,
      phasePatch: plan.phasePatch
        ? Object.freeze({ ...plan.phasePatch })
        : plan.phasePatch,
      smartClockPlannedAt: Number(schedule.smartClockPlannedAt)
        || Number(plan.smartClockPlannedAt)
        || 0
    });
    const retryAlarmClear = await writePageTimerRetryAlarm({
      action: 'clear',
      isCurrent: () => (
        recoveryIsCurrent()
        && isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
      )
    });
    if (retryAlarmClear.stale
        || !recoveryIsCurrent()
        || !isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
        || !replayRecoveryPageTimerState()) return false;
    takePageTimerWriteOwner(applyPwmPlanState(replayPlan));
    recordOwnedPhaseMutation();
  }
  setPwmClockIntent(schedule.nextTriggerAt, {
    plannedAt: schedule.smartClockPlannedAt
  });
  recordOwnedPhaseMutation();
  if (!recoveryIsCurrent() || !replayRecoveryPageTimerState()) return false;
  const committedClockIntentState = snapshotPwmClockIntentState();
  if (!await persistRecoveryIntent(
    'advanceExpiredAlarmToNextBoundary-commit-intent',
    committedClockIntentState,
    committedPhaseState
  )) return false;
  const clearAlarmWrite = await clearExpectedPwmAlarm();
  if (!clearAlarmWrite.cleared
      || !recoveryIsCurrent()
      || !replayRecoveryIntentState(
        committedClockIntentState,
        committedPhaseState
      )) return false;
  const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
    plan,
    'advance-recovery',
    automationRevision,
    {
      expectedWriteGeneration: expectedPwmWriteGeneration,
      ensureCurrent: () => (
        baseRecoveryIsCurrent()
        && (plan.proofAction !== 'clear'
          || isPageTimerWriteOwnerCurrent(pageTimerWriteOwner))
      )
    }
  );
  if (alarmWrite.writeOwner > 0) {
    expectedPwmWriteGeneration = alarmWrite.writeOwner;
  }
  recordOwnedPhaseMutation();
  if (!recoveryIsCurrent()) return false;
  if (!alarmWrite.created) {
    if (!replayRecoveryIntentState(
      committedClockIntentState,
      committedPhaseState
    )) return false;
    const commitAlarmFailureError = '过期相位已推进，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复';
    if (pageTimerWriteOwner <= 0) {
      takePageTimerWriteOwner(invalidatePageTimerWriteOwner());
    }
    const commitAlarmFailurePageTimerState = snapshotOwnedPageTimerState(
      pageTimerWriteOwner,
      {
        ...ownedPageTimerState,
        pageTimerError: commitAlarmFailureError
      }
    );
    if (!commitAlarmFailurePageTimerState) return false;
    const failureIsCurrent = () => (
      baseRecoveryIsCurrent()
      && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
      && isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
    );
    await persistOwnedPwmAlarmFailure({
      isCurrent: failureIsCurrent,
      replayState: () => {
        replayPwmClockIntentState(committedClockIntentState);
        Object.assign(schedule, committedPhaseState);
        if (!replayOwnedPageTimerState(
          commitAlarmFailurePageTimerState
        )) return false;
        recordOwnedPhaseMutation();
        return true;
      },
      persistReason: 'advanceExpiredAlarmToNextBoundary-commit-alarm-failed'
    });
    return false;
  }
  const verifiedClockState = snapshotVerifiedPwmClockState(alarmWrite.writeOwner);
  if (!verifiedClockState) return false;
  const replayCommitState = () => {
    if (!recoveryIsCurrent()) return false;
    if (!replayVerifiedPwmClockState(verifiedClockState)) return false;
    Object.assign(schedule, committedPhaseState);
    if (!replayRecoveryPageTimerState()) return false;
    recordOwnedPhaseMutation();
    return recoveryIsCurrent();
  };
  await createAlarm('ac-badge-tick', {
    delayInMinutes: 1,
    ensureCurrent: recoveryIsCurrent
  });
  if (!replayCommitState()) return false;
  if (await abortStaleAutomation(
    automationRevision,
    'advance-commit-active-hours-paused',
    { phaseAdmissionEpoch: options.phaseAdmissionEpoch }
  )) return false;
  if (!replayCommitState()) return false;
  const commitPersisted = await persistOwnedVerifiedPwmState({
    isCurrent: recoveryIsCurrent,
    verifiedClockState,
    replayState: () => {
      Object.assign(schedule, committedPhaseState);
      if (!replayRecoveryPageTimerState()) return false;
      recordOwnedPhaseMutation();
      return true;
    },
    persistReason: 'advanceExpiredAlarmToNextBoundary'
  });
  if (!commitPersisted || !replayCommitState()) return false;
  await updateBadge();
  if (!replayCommitState()) return false;

  console.log(`[AC扩展] 从过期闹钟推进: 原=${new Date(expiredScheduledTime).toLocaleTimeString()} 新=${new Date(schedule.nextTriggerAt).toLocaleTimeString()} 下一动作=${schedule.pwmState}`);
  return successfulRecovery(alarmWrite, verifiedClockState, committedPhaseState);
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

async function restoreIntervalAlarmFromStorage(
  reason = '按 storage 剩余时间恢复 PWM 闹钟',
  phaseAdmissionEpoch = 0
) {
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
      automationRevision,
      phaseAdmissionEpoch
    );
    await updateBadge();
    return true;
  }

  const remainingMinutes = Math.max(1, (targetDueAt - now) / 60000);
  const restoreClockIntentState = Object.freeze({
    nextTriggerAt: targetDueAt,
    smartClockPlannedAt: Number(schedule.smartClockPlannedAt)
      || Number(schedule.alarmCreatedAt)
      || now
  });
  await clearPwmAlarm(automationRevision);
  const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
    { nextTriggerAt: targetDueAt },
    'restore-interval',
    automationRevision,
    { plannedAt: restoreClockIntentState.smartClockPlannedAt }
  );
  const restoreWriteIsCurrent = () => (
    isAutomationOperationCurrent(automationRevision)
    && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
  );
  if (!alarmWrite.created) {
    const restoreAlarmFailureError = 'storage 时钟恢复时 PWM 闹钟创建失败；等待看门狗继续恢复';
    await persistOwnedPwmAlarmFailure({
      isCurrent: restoreWriteIsCurrent,
      replayState: () => {
        replayPwmClockIntentState(restoreClockIntentState);
        schedule.pageTimerError = restoreAlarmFailureError;
        return true;
      },
      persistReason: 'restore-interval-alarm-failed'
    });
    return false;
  }
  const verifiedClockState = snapshotVerifiedPwmClockState(alarmWrite.writeOwner);
  if (!verifiedClockState) return false;
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  const restorePersisted = await persistOwnedVerifiedPwmState({
    isCurrent: restoreWriteIsCurrent,
    verifiedClockState,
    replayState: () => true,
    persistReason: reason
  });
  if (!restorePersisted) return false;

  await updateBadge();
  console.log(`[AC扩展] ${reason}，剩余 ${remainingMinutes.toFixed(2)} 分钟`);
  return true;
}

async function createAlarm(name, info) {
  try {
    const isAutomationRuntimeAlarm = AUTOMATION_RUNTIME_ALARMS.has(name);
    const ensureCurrent = typeof info?.ensureCurrent === 'function'
      ? info.ensureCurrent
      : null;
    const allowManualOffAdmission = info?.allowManualOffAdmission === true;
    const runtimeAlarmWriteIsCurrent = () => {
      if (ensureCurrent && !ensureCurrent()) return false;
      return allowManualOffAdmission
        ? isAutomationAllowedIgnoringManualOff()
        : isAutomationAllowed();
    };
    if (isAutomationRuntimeAlarm && !runtimeAlarmWriteIsCurrent()) {
      await chrome.alarms.clear(name);
      return false;
    }

    const {
      persistAcrossSessions,
      ensureCurrent: _ensureCurrent,
      allowManualOffAdmission: _allowManualOffAdmission,
      ...safeInfo
    } = info || {};
    await chrome.alarms.create(name, safeInfo);
    if (isAutomationRuntimeAlarm && !runtimeAlarmWriteIsCurrent()) {
      await chrome.alarms.clear(name);
      return false;
    }

    // 验证创建成功
    const verify = await chrome.alarms.get(name);
    if (isAutomationRuntimeAlarm && !runtimeAlarmWriteIsCurrent()) {
      await chrome.alarms.clear(name);
      return false;
    }
    if (!verify) console.error('[AC扩展] createAlarm 失败: ' + name + ' ' + JSON.stringify(safeInfo));
    return !!verify;
  } catch (e) {
    console.error('[AC扩展] createAlarm 异常: ' + name, e?.message);
    void appendDiagnosticLog('error', 'create-alarm', e);
    return false;
  }
}

let pageTimerRetryAlarmWriteChain = Promise.resolve();
let pageTimerRetryAlarmWriteGeneration = 0;

function runSerializedPageTimerRetryAlarmWrite(operation) {
  const queued = pageTimerRetryAlarmWriteChain
    .catch(() => {})
    .then(operation);
  pageTimerRetryAlarmWriteChain = queued.catch(() => {});
  return queued;
}

async function clearPageTimerRetryAlarmPhysical() {
  return chrome.alarms.clear(PAGE_TIMER_RETRY_ALARM);
}

async function writePageTimerRetryAlarm({
  action,
  when = 0,
  isCurrent
} = {}) {
  if (!['clear', 'create', 'replace'].includes(action)) {
    throw new TypeError(`未知页面定时器重试闹钟操作: ${action}`);
  }
  if (typeof isCurrent !== 'function') {
    throw new TypeError('页面定时器重试闹钟写入缺少 owner guard');
  }
  const targetAt = Number(when);
  if (action !== 'clear'
      && (!Number.isSafeInteger(targetAt) || targetAt <= 0)) {
    throw new TypeError('页面定时器重试闹钟缺少有效 when');
  }
  if (!isCurrent()) {
    return { stale: true, action, when: targetAt, alarmCreated: false };
  }

  pageTimerRetryAlarmWriteGeneration += 1;
  const owner = pageTimerRetryAlarmWriteGeneration;
  const ownerIsCurrent = () => (
    owner === pageTimerRetryAlarmWriteGeneration
    && isCurrent()
  );
  const result = (stale, alarmCreated = false) => ({
    stale,
    action,
    when: action === 'clear' ? 0 : targetAt,
    alarmCreated
  });

  return runSerializedPageTimerRetryAlarmWrite(async () => {
    if (!ownerIsCurrent()) return result(true);
    if (action !== 'create') {
      await clearPageTimerRetryAlarmPhysical();
      if (!ownerIsCurrent()) return result(true);
      if (action === 'clear') return result(false);
    }

    const alarmCreated = await createAlarm(PAGE_TIMER_RETRY_ALARM, {
      when: targetAt
    });
    if (!ownerIsCurrent()) {
      // 新 owner 的物理写入仍在本队列后方；先清掉本次迟到 create，
      // 再放行新 owner，避免旧 alarm 在 durable intent 之后落地。
      await clearPageTimerRetryAlarmPhysical();
      return result(true);
    }
    return result(false, alarmCreated);
  });
}

let pwmAlarmWriteChain = Promise.resolve();
let pwmAlarmWriteGeneration = 0;

function claimPwmAlarmWriteOwner() {
  pwmAlarmWriteGeneration += 1;
  return pwmAlarmWriteGeneration;
}

function isPwmAlarmWriteOwnerCurrent(owner) {
  return owner > 0 && owner === pwmAlarmWriteGeneration;
}

function isPwmAlarmWriteGenerationCurrent(generation) {
  return Number.isSafeInteger(generation)
    && generation >= 0
    && generation === pwmAlarmWriteGeneration;
}

function runSerializedPwmAlarmWrite(operation) {
  const queued = pwmAlarmWriteChain
    .catch(() => {})
    .then(operation);
  pwmAlarmWriteChain = queued.catch(() => {});
  return queued;
}

function isPwmAlarmWriteCurrent(
  automationRevision,
  { allowManualOffAdmission = false } = {}
) {
  if (automationRevision === null) {
    return allowManualOffAdmission
      ? isAutomationAllowedIgnoringManualOff()
      : isAutomationAllowed();
  }
  return allowManualOffAdmission
    ? isAutomationOperationCurrentIgnoringManualOff(automationRevision)
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

async function clearPwmAlarmWithReceipt(
  automationRevision = null,
  force = false,
  options = {}
) {
  const ensureCurrent = typeof options?.ensureCurrent === 'function'
    ? options.ensureCurrent
    : null;
  const expectedWriteGeneration = options?.expectedWriteGeneration;
  const hasExpectedWriteGeneration = Number.isSafeInteger(expectedWriteGeneration)
    && expectedWriteGeneration >= 0;
  const clearIsCurrent = () => (
    (force || isPwmAlarmWriteCurrent(automationRevision))
    && (!ensureCurrent || ensureCurrent())
  );
  return runSerializedPwmAlarmWrite(async () => {
    if (!clearIsCurrent()
        || (hasExpectedWriteGeneration
          && !isPwmAlarmWriteGenerationCurrent(expectedWriteGeneration))) {
      return Object.freeze({ cleared: false, stale: true, writeOwner: 0 });
    }
    const writeOwner = claimPwmAlarmWriteOwner();
    try {
      await chrome.alarms.clear('ac-pwm');
      return Object.freeze({
        cleared: clearIsCurrent(),
        writeOwner
      });
    } catch (error) {
      console.error('[AC扩展] PWM 闹钟清理失败:', error?.message);
      return Object.freeze({
        cleared: false,
        writeOwner,
        error: error?.message || String(error)
      });
    }
  });
}

async function clearPwmAlarm(automationRevision = null, force = false) {
  const result = await clearPwmAlarmWithReceipt(automationRevision, force);
  if (result.error) throw new Error(result.error);
  return result.cleared;
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
    claimPwmAlarmWriteOwner();
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

async function createPwmAlarmFromPlanWithReceipt(
  plan,
  logTag = 'PWM',
  automationRevision = null,
  options = {}
) {
  const nextTriggerAt = Number(plan?.nextTriggerAt);
  const ensureCurrent = typeof options?.ensureCurrent === 'function'
    ? options.ensureCurrent
    : null;
  const allowManualOffAdmission = options?.allowManualOffAdmission === true;
  const previousWriteOwner = options?.previousWriteOwner;
  const hasPreviousWriteOwner = Number.isSafeInteger(previousWriteOwner)
    && previousWriteOwner > 0;
  const requestedExpectedWriteGeneration = options?.expectedWriteGeneration;
  const expectedWriteGeneration = hasPreviousWriteOwner
    ? previousWriteOwner
    : requestedExpectedWriteGeneration;
  const hasExpectedWriteGeneration = Number.isSafeInteger(expectedWriteGeneration)
    && expectedWriteGeneration >= 0;
  const requestedPlannedAt = Number(options?.plannedAt);
  const hasRequestedPlannedAt = Number.isFinite(requestedPlannedAt)
    && requestedPlannedAt > 0;
  const alarmWriteIsCurrent = () => (
    isPwmAlarmWriteCurrent(automationRevision, { allowManualOffAdmission })
    && (!ensureCurrent || ensureCurrent())
  );
  if (!Number.isFinite(nextTriggerAt) || nextTriggerAt <= 0) {
    console.error(`[AC扩展] ${logTag}: PWM plan 缺少有效触发时间`);
    return Object.freeze({ created: false, writeOwner: 0 });
  }

  return runSerializedPwmAlarmWrite(async () => {
    if (!alarmWriteIsCurrent()
        || (hasExpectedWriteGeneration
          && !isPwmAlarmWriteGenerationCurrent(expectedWriteGeneration))) {
      return Object.freeze({ created: false, writeOwner: 0 });
    }
    const writeOwner = claimPwmAlarmWriteOwner();
    const result = created => Object.freeze({ created, writeOwner });
    try {
      const alarmCreatedAt = Date.now();
      if (nextTriggerAt <= alarmCreatedAt) {
        await failPwmAlarmWrite(logTag, new Error('PWM 目标在排队期间已过期'));
        return result(false);
      }
      const alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - alarmCreatedAt) / 60000
      );
      let created = await createAlarm('ac-pwm', {
        when: nextTriggerAt,
        ensureCurrent: alarmWriteIsCurrent,
        allowManualOffAdmission
      });
      let verify = created ? await chrome.alarms.get('ac-pwm') : null;
      if ((!created || !verify) && alarmWriteIsCurrent()) {
        console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
        created = await createAlarm('ac-pwm', {
          when: nextTriggerAt,
          ensureCurrent: alarmWriteIsCurrent,
          allowManualOffAdmission
        });
        verify = created ? await chrome.alarms.get('ac-pwm') : null;
      }
      if (!created || !verify || !alarmWriteIsCurrent()) {
        await failPwmAlarmWrite(logTag);
        return result(false);
      }

      schedule.alarmCreatedAt = alarmCreatedAt;
      schedule.alarmDelayMinutes = alarmDelayMinutes;
      setNextTriggerAt(verify.scheduledTime || nextTriggerAt, {
        ...(hasRequestedPlannedAt ? { plannedAt: requestedPlannedAt } : {})
      });
      return result(true);
    } catch (error) {
      await failPwmAlarmWrite(logTag, error);
      return result(false);
    }
  });
}

async function createPwmAlarmFromPlan(
  plan,
  logTag = 'PWM',
  automationRevision = null
) {
  const nextTriggerAt = Number(plan?.nextTriggerAt);
  if (Number.isFinite(nextTriggerAt)
      && nextTriggerAt > 0
      && nextTriggerAt <= Date.now()) {
    console.error(`[AC扩展] ${logTag}: PWM plan 缺少未来触发时间`);
    return false;
  }
  const result = await createPwmAlarmFromPlanWithReceipt(
    plan,
    logTag,
    automationRevision
  );
  return result.created;
}

async function loadScheduleFromStorage() {
  // 读取也先跨过当前 critical write barrier，避免拿到一半事务的旧
  // ac_schedule；若等待期间又有 user authority 入队，继续等到队尾稳定。
  while (true) {
    const observedWriteChain = criticalLocalStateWriteChain;
    await observedWriteChain.catch(() => {});
    if (observedWriteChain === criticalLocalStateWriteChain) break;
  }
  // Phase adoption 在 reservation 内先换 revision、再提交 durable intent。
  // Popup/诊断的普通 reload 不能在这段窗口把旧 storage 合并回新内存相位。
  if (isSyncPhaseAdoptionAdmissionBlocked()
      || pageTimerWritesInFlight > 0) return schedule;
  // 不能只比较 get() 前后的 blocked 布尔值。一个 phase writer 可以在
  // await 窗口内完整经历 claim -> commit -> release，前后都是 false，
  // 但这次读取已是旧快照。单调 epoch 将这个 ABA 收口。
  const phaseAdmissionEpochAtRead = syncPhaseAdoptionAdmissionEpoch;
  const pageTimerWriteGenerationAtRead = pageTimerWriteGeneration;
  const automationRevision = pwmRuntimeRevision;
  const persistenceAuthorityEpoch = schedulePersistenceAuthorityEpoch;
  if (scheduleLoadBlockedRevision === automationRevision) return schedule;
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (isSyncPhaseAdoptionAdmissionBlocked()
      || phaseAdmissionEpochAtRead !== syncPhaseAdoptionAdmissionEpoch
      || pageTimerWritesInFlight > 0
      || pageTimerWriteGenerationAtRead !== pageTimerWriteGeneration
      || automationRevision !== pwmRuntimeRevision
      || persistenceAuthorityEpoch !== schedulePersistenceAuthorityEpoch
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
  const persistenceAuthorityEpoch = schedulePersistenceAuthorityEpoch;
  const {
    syncFromLiveAlarm = true,
    markSyncPublishPending = false
  } = options;
  if (!schedule.smartMode?.enabled) {
    schedule.smartOnBoundaryAt = 0;
    clearPwmRetryState();
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

  const scheduleSnapshot = { ...schedule };
  return runSerializedCriticalLocalStateWrite(async () => {
    if (persistenceAuthorityEpoch !== schedulePersistenceAuthorityEpoch) {
      return false;
    }
    // mailbox 是单调 safety state，必须在真正取得 critical FIFO 后现取；
    // 否则排在 terminal/tombstone writer 后面的旧快照会反向擦除 exact names。
    const deferredMailboxSnapshot =
      hasCommittedLocalMutationAfterDeferredRemoteAuthority()
        ? mergeDeferredSyncSafetyMetadata(
            snapshotDeferredSyncDisableMailbox(reason)
          )
        : null;
    await chrome.storage.local.set({
      [STORAGE_KEY]: scheduleSnapshot,
      ...(deferredMailboxSnapshot
        ? { [DEFERRED_SYNC_DISABLE_KEY]: deferredMailboxSnapshot }
        : {}),
      ...(markSyncPublishPending
        ? { [SYNC_PENDING_PUBLISH_KEY]: true }
        : {})
    });
    if (persistenceAuthorityEpoch !== schedulePersistenceAuthorityEpoch) {
      return false;
    }
    if (scheduleLoadBlockedRevision === pwmRuntimeRevision) {
      scheduleLoadBlockedRevision = null;
    }
    return true;
  });
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
  pendingRemoteCausalEnvelope: null,
  pendingRemoteScheduleAuthorityGeneration: 0,
  pendingRemoteMutationGeneration: 0,
  rereadAfterSafetyDisable: false,
  pendingOutbound: false,
  pendingOutboundReason: ''
};

function queuePendingSyncAdoption(reason = '', explicitRemote = null) {
  _syncOpLock.pending = true;
  _syncOpLock.pendingReason = reason || _syncOpLock.pendingReason;
  if (!explicitRemote || typeof explicitRemote !== 'object') return;

  if (explicitRemote.enabled === false) {
    // 到达更晚的 safety predecessor 淘汰此前所有普通候选；只有它之后
    // 再收到的非本机 true 才有资格在停用收口后重读。
    _syncOpLock.pendingRemote = explicitRemote;
    _syncOpLock.pendingRemoteCausalEnvelope = null;
    _syncOpLock.pendingRemoteScheduleAuthorityGeneration =
      localScheduleAuthorityGeneration;
    _syncOpLock.pendingRemoteMutationGeneration =
      localScheduleMutationGeneration;
    _syncOpLock.rereadAfterSafetyDisable = false;
    return;
  }
  if (deferredSyncDisablePending
      || _syncOpLock.pendingRemote?.enabled === false) {
    if (deferredSyncDisableSyntheticReadFailure
        && explicitRemote.enabled !== false
        && _syncOpLock.pendingRemote?.enabled !== false) {
      const pendingAt = normalizeSyncAuthorityTimestamp(
        _syncOpLock.pendingRemote?.syncedAt
      );
      const incomingAt = normalizeSyncAuthorityTimestamp(
        explicitRemote.syncedAt
      );
      if (!_syncOpLock.pendingRemote || incomingAt >= pendingAt) {
        _syncOpLock.pendingRemote = explicitRemote;
        _syncOpLock.pendingRemoteCausalEnvelope =
          snapshotStartupEarlySyncSuccessorCausalEnvelope(
            explicitRemote,
            localScheduleAuthorityGeneration,
            localScheduleMutationGeneration
          );
        _syncOpLock.pendingRemoteScheduleAuthorityGeneration =
          localScheduleAuthorityGeneration;
        _syncOpLock.pendingRemoteMutationGeneration =
          localScheduleMutationGeneration;
      }
    }
    // true 不能覆盖尚未消费的 false；只登记“false 成功后 fresh read”。
    _syncOpLock.rereadAfterSafetyDisable = true;
    return;
  }

  const pendingAt = normalizeSyncAuthorityTimestamp(
    _syncOpLock.pendingRemote?.syncedAt
  );
  const incomingAt = normalizeSyncAuthorityTimestamp(
    explicitRemote.syncedAt
  );
  if (!_syncOpLock.pendingRemote || incomingAt >= pendingAt) {
    _syncOpLock.pendingRemote = explicitRemote;
    _syncOpLock.pendingRemoteCausalEnvelope =
      snapshotStartupEarlySyncSuccessorCausalEnvelope(
        explicitRemote,
        localScheduleAuthorityGeneration,
        localScheduleMutationGeneration
      );
    _syncOpLock.pendingRemoteScheduleAuthorityGeneration =
      localScheduleAuthorityGeneration;
    _syncOpLock.pendingRemoteMutationGeneration =
      localScheduleMutationGeneration;
  }
}

function drainDeferredSyncAdoptionAfterManualOffAdmission() {
  if (manualOffAutomaticOnBlocked || !_syncOpLock.pending) return;
  void waitUntil(
    tryAdoptSyncedState('manual-off-admission-release')
      .catch(error => {
        console.warn('[AC扩展] 手动关机收口后重放 sync 失败:', error?.message);
      })
  );
}

function deferRemoteSyncDisableWhileManualOffBlocked(
  remote,
  reason = '',
  scheduleAuthorityGeneration = localScheduleAuthorityGeneration,
  {
    scheduleMutationGeneration = localScheduleMutationGeneration,
    credentialReceivedAt = 0,
    credentialRetryAlarmName = '',
    credentialSafetyAuthorityId = '',
    credentialAuthorityOrderObservedAt = 0,
    credentialAuthorityPreBaselineSequence = 0,
    credentialRemoteComplete = true,
    preserveCredentialAuthority = false,
    recoverFromRetryCredential = false
  } = {}
) {
  const remoteSnapshot = remote && typeof remote === 'object'
    ? { ...remote, enabled: false }
    : { enabled: false, syncedAt: 0 };
  const preservingCredentialAuthority =
    (preserveCredentialAuthority === true
      || recoverFromRetryCredential === true)
    && Number(credentialReceivedAt) > 0;
  const recoveringExactCredential = preservingCredentialAuthority
    && !!String(credentialRetryAlarmName || '');
  const receivedAt = preservingCredentialAuthority
    ? Number(credentialReceivedAt)
    : Date.now();
  const authorityOrderObservedAt = preservingCredentialAuthority
    ? Number(credentialAuthorityOrderObservedAt) || receivedAt
    : nextSyncAuthorityObservedAt();
  remoteSyncAuthorityObservedAt = Math.max(
    remoteSyncAuthorityObservedAt,
    authorityOrderObservedAt
  );
  const authorityPreBaselineSequence = preservingCredentialAuthority
    ? Number(credentialAuthorityPreBaselineSequence) || 0
    : getSyncAuthorityPreBaselineSequence(authorityOrderObservedAt);
  // 新 F claim 必须把此前仍登记的 F exact names 一并冻结。只在后续
  // receipt repair 才发现旧 F，会留下“F2 record 已 durable、F1 alarm 仍
  // live”的 crash 窗口；重启时 immutable F1 的已消费 sequence 可能复活。
  const supersededDisableRetryAlarmNames = new Set(
    deferredSyncDisableRetryAlarmNames
  );
  // alarm-only F 没有 durable predecessor coverage。跨 SW 墙钟可回拨，
  // observedAt>receivedAt 不能证明 T 是 post-F；当前已见 T 一律 exact
  // tombstone，随后 fresh sync preflight 会把真正仍在 store 的 T 重新登记。
  const supersededSuccessorRetryAlarmNames = new Set([
    ...deferredSyncSuccessorRetryAlarmEntries.keys()
  ]);
  for (const name of supersededSuccessorRetryAlarmNames) {
    deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
  }
  deferredSyncDisableLoaded = true;
  deferredSyncDisablePending = true;
  deferredSyncDisableEpoch += 1;
  deferredSyncDisableSafetyAuthorityId =
    (preservingCredentialAuthority
      ? normalizeDeferredSyncDisableSafetyAuthorityId(
          credentialSafetyAuthorityId
        )
      : '') || createDeferredSyncDisableSafetyAuthorityId();
  const deferredSyncDisableSafetyAuthorityIdAtClaim =
    deferredSyncDisableSafetyAuthorityId;
  deferredSyncDisableRemoteSnapshot = remoteSnapshot;
  deferredSyncDisableRemoteSnapshotComplete =
    !preservingCredentialAuthority || credentialRemoteComplete === true;
  deferredSyncDisableSyntheticReadFailure = false;
  deferredSyncDisableDurableReceiptEpoch = 0;
  deferredSyncDisableDurableReceiptIdentity = '';
  deferredSyncDisableSuccessorSnapshot = null;
  deferredSyncDisableSuccessorObservedAt = 0;
  deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
  deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
  deferredSyncDisableSuccessorRetryAlarmName = '';
  deferredSyncDisableSuccessorLocalAuthorityGeneration = 0;
  deferredSyncDisableLocalMutationGeneration = Number.isSafeInteger(
    scheduleMutationGeneration
  )
    ? scheduleMutationGeneration
    : localScheduleMutationGeneration;
  deferredSyncDisableSuccessorMutationGeneration = 0;
  const deferredScheduleAuthorityGeneration =
    Number.isSafeInteger(scheduleAuthorityGeneration)
      ? scheduleAuthorityGeneration
      : localScheduleAuthorityGeneration;
  deferredSyncDisableLocalScheduleAuthorityGeneration =
    deferredScheduleAuthorityGeneration;
  startupDeferredDisableSupersededByUserIntent = false;
  const recordEpoch = deferredSyncDisableEpoch;
  deferredSyncSuccessorEnumerationPendingEpoch = recordEpoch;
  deferredSyncDisableObservedAt = receivedAt;
  deferredSyncDisableAuthorityOrderObservedAt =
    authorityOrderObservedAt;
  deferredSyncDisableAuthorityPreBaselineSequence =
    authorityPreBaselineSequence;
  deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
    deferredSyncSuccessorReleasedThroughObservedAt,
    deferredSyncDisableAuthorityOrderObservedAt
  );
  const retryAlarmName = recoveringExactCredential
    ? String(credentialRetryAlarmName)
    : createDeferredSyncDisableRetryAlarmName(
        receivedAt,
        remoteSnapshot,
        deferredSyncDisableSafetyAuthorityId,
        authorityOrderObservedAt,
        authorityPreBaselineSequence
      );
  // alarm recovery 的 caller 会先登记 incoming exact name；它是本轮主凭证，
  // 不能被自己的 predecessor tombstone 覆盖。
  supersededDisableRetryAlarmNames.delete(retryAlarmName);
  for (const name of supersededDisableRetryAlarmNames) {
    deferredSyncDisableReleasedRetryAlarmNames.add(name);
  }
  deferredSyncDisableRetryAlarmNames.add(retryAlarmName);
  schedulePersistenceAuthorityEpoch += 1;
  // 远端停用淘汰到达前的本机 outbound。若旧 sync.set 已越过最后检查，
  // generation 仍会阻止它清 publish marker，安全停用收口后由当前 false 修复 store。
  syncPublishGeneration += 1;
  pwmRuntimeRevision += 1;
  invalidateTimerBasedShutdown();
  const retryCredentialPromise = recoveringExactCredential
    ? Promise.resolve(true)
    : trackDeferredSyncDisableRetryAlarmOperation((async () => {
      await chrome.alarms.create(retryAlarmName, {
        when: receivedAt + 60000,
        periodInMinutes: 1
      });
      return !!await chrome.alarms.get(retryAlarmName);
    })()).catch(error => {
      console.warn('[AC扩展] remote disable 持久恢复钟创建失败:', error?.message);
      void appendDiagnosticLog(
        'warn',
        'deferred-sync-disable-retry-alarm',
        error
      );
      return false;
    });
  const cancellationPromise = queueManualOffAutomaticOnCancellation({
    claimRevision: false,
    holdManualOffAdmission: false
  });
  const retryPromise = scheduleSyncRetry('adopt');
  const recordIsCurrent = () => (
    deferredSyncDisablePending
    && deferredSyncDisableEpoch === recordEpoch
    && deferredSyncDisableObservedAt === receivedAt
    && deferredSyncDisableSafetyAuthorityId
      === deferredSyncDisableSafetyAuthorityIdAtClaim
    && getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot)
      === getSyncPayloadIdentity(remoteSnapshot)
  );
  const durableRecordPromise = runSerializedCriticalLocalStateWrite(async () => {
    if (!recordIsCurrent()) return false;
    // startup getAll 可能与本轮 F claim 交错并把旧集合回灌。真正落盘前
    // fresh 枚举 live F，确保 F1 exact tombstone 不依赖任何内存快照。
    await waitForDeferredSyncDisableRetryAlarmOperationsToSettle();
    if (!recordIsCurrent()) return false;
    const discoveredDisableRetryAlarmIdentities =
      await getDeferredSyncDisableRetryAlarmIdentities();
    if (!recordIsCurrent()) return false;
    for (const identity of discoveredDisableRetryAlarmIdentities) {
      if (identity.name === retryAlarmName) continue;
      supersededDisableRetryAlarmNames.add(identity.name);
      deferredSyncDisableReleasedRetryAlarmNames.add(identity.name);
    }
    const discoveredPredecessorRetryAlarmNames =
      await captureDeferredSyncSuccessorRetryAlarmsThrough(
        deferredSyncDisableAuthorityOrderObservedAt || receivedAt,
        {
          includeUnknown: true,
          authorityPreBaselineSequence:
            deferredSyncDisableAuthorityPreBaselineSequence
          }
        );
    // capture/getAll 会让出事件循环；期间后到 F 必须令本 writer 在落盘前
    // 退出，不能写一份 F2 locals + F3 globals 的混合 mailbox。
    if (!recordIsCurrent()) return false;
    for (const name of discoveredPredecessorRetryAlarmNames) {
      supersededSuccessorRetryAlarmNames.add(name);
      // F credential 已在并发创建；即使下面 durable record 暂时失败，当前
      // SW 也不能让已枚举的 old-T alarm 抢先按 successor 恢复。
      deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
    }
    const record = mergeDeferredSyncSafetyMetadata({
      pending: true,
      receivedAt,
      authorityOrderObservedAt:
        deferredSyncDisableAuthorityOrderObservedAt || receivedAt,
      ...(deferredSyncDisableAuthorityPreBaselineSequence > 0
        ? {
            authorityPreBaselineSequence:
              deferredSyncDisableAuthorityPreBaselineSequence
          }
        : {}),
      safetyCutoffObservedAt: receivedAt,
      localMutationCutoffObservedAt:
        localScheduleMutationCommittedObservedAt,
      reason: String(reason || ''),
      ...(deferredSyncDisableRemoteSnapshotComplete
        ? { remote: remoteSnapshot }
        : {}),
      retryAlarmName,
      releasedRetryAlarmNames: [...new Set([
        ...deferredSyncDisableReleasedRetryAlarmNames,
        ...supersededDisableRetryAlarmNames
      ])],
      releasedSuccessorRetryAlarmNames: [...new Set([
        ...deferredSyncSuccessorReleasedRetryAlarmNames,
        ...supersededSuccessorRetryAlarmNames
      ])],
      releasedSuccessorThroughObservedAt:
        deferredSyncSuccessorReleasedThroughObservedAt,
      successorPredecessorCoverageThroughObservedAt: receivedAt
    });
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!recordIsCurrent()) return false;
        await chrome.storage.local.set({ [DEFERRED_SYNC_DISABLE_KEY]: record });
        if (recordIsCurrent()) {
          markDeferredSyncDisableDurableReceipt(
            recordEpoch,
            getSyncPayloadIdentity(remoteSnapshot)
          );
          deferredSyncSuccessorEnumerationPendingEpoch = 0;
        }
        for (const name of supersededSuccessorRetryAlarmNames) {
          deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
        }
        return recordIsCurrent();
      } catch (error) {
        lastError = error;
        if (!recordIsCurrent()) return false;
      }
    }
    throw lastError || new Error('remote disable marker 写入失败');
  }).catch(error => {
    console.warn('[AC扩展] 持久化延后 remote disable 失败:', error?.message);
    void appendDiagnosticLog('warn', 'deferred-sync-disable-write', error);
    return false;
  });
  // 不等长 phase owner，先像本机手动 OFF 一样预约 1 分钟页面关机保险。
  // 后到显式 enable/manual ON 会换 config/timer owner 令这张旧票失效；
  // 后到 remote true 仍须先消费这个 safety predecessor。
  const emergencyShutdownPromise = requestTimerBasedShutdown(
    'remote-sync-disable-arrival',
    1,
    {
      ensureCurrent: () => (
        deferredSyncDisablePending
        && deferredSyncDisableEpoch === recordEpoch
        && deferredSyncDisableLocalScheduleAuthorityGeneration
          === deferredScheduleAuthorityGeneration
        && localScheduleAuthorityGeneration
          === deferredScheduleAuthorityGeneration
      )
    }
  ).catch(error => {
    console.warn('[AC扩展] remote disable 紧急关机定时器失败:', error?.message);
    void appendDiagnosticLog('warn', 'deferred-sync-disable-emergency-timer', error);
    return { success: false, error: error?.message || String(error) };
  });
  const supersededSuccessorCleanupPromise = Promise.all([
    durableRecordPromise,
    retryCredentialPromise
  ]).then(async ([recordPersisted, retryCredentialPersisted]) => {
    // 只有 exact tombstone 已和 F record 一起 durable，才可物理删除 T。
    // 单独的 F alarm 不携带 exact names，提前 clear 会在失败时丢恢复证据。
    if (!recordPersisted
        || !retryCredentialPersisted
        || supersededSuccessorRetryAlarmNames.size === 0) return false;
    await waitForDeferredSyncSuccessorRetryAlarmOperationsToSettle();
    return clearDeferredSyncSuccessorRetryAlarms(
      [...supersededSuccessorRetryAlarmNames],
      { preserveReleasedNames: true }
    );
  }).catch(error => {
    console.warn('[AC扩展] 清理被 F 淘汰的 remote successor 恢复钟失败:', error?.message);
    return false;
  });
  const supersededDisableCleanupPromise = Promise.all([
    durableRecordPromise,
    retryCredentialPromise
  ]).then(async ([recordPersisted, retryCredentialPersisted]) => {
    // F2 record、F2 alarm 与 F1 exact tombstone 三者都已 durable 后，才可
    // 删除旧 F。这样任一中途 crash 都至少保留一份可恢复 safety credential。
    if (!recordPersisted
        || !retryCredentialPersisted
        || supersededDisableRetryAlarmNames.size === 0) return false;
    await waitForDeferredSyncDisableRetryAlarmOperationsToSettle();
    return clearDeferredSyncDisableRetryAlarms(
      [...supersededDisableRetryAlarmNames],
      { preserveReleasedNames: true }
    );
  }).catch(error => {
    console.warn('[AC扩展] 清理被新 F 淘汰的旧 F 恢复钟失败:', error?.message);
    return false;
  });
  // onChanged 不能 await；显式保活覆盖 durable record、主世界取消、
  // 紧急 timer 和 adopt retry。任一失败都保留内存 pending，init 继续 fail-close。
  void waitUntil(
    Promise.allSettled([
      durableRecordPromise,
      retryCredentialPromise,
      cancellationPromise,
      emergencyShutdownPromise,
      retryPromise,
      supersededSuccessorCleanupPromise,
      supersededDisableCleanupPromise
    ])
  );
  return durableRecordPromise;
}

function rememberUnclassifiedRemoteSyncSuccessorDuringSyntheticReadFailure(
  remote,
  reason = ''
) {
  if ((deferredSyncDisableLoaded
        && !deferredSyncDisableSyntheticReadFailure)
      || !remote
      || typeof remote !== 'object'
      || remote.enabled === false) return null;
  const successorSnapshot = { ...remote };
  const successorObservedAt = Date.now();
  const successorAuthorityOrderObservedAt = nextSyncAuthorityObservedAt();
  const successorAuthorityPreBaselineSequence =
    getSyncAuthorityPreBaselineSequence(
      successorAuthorityOrderObservedAt
    );
  const successorAuthorityGeneration = localScheduleAuthorityGeneration;
  const successorMutationGeneration = localScheduleMutationGeneration;
  const successorRetryAlarmName =
    createDeferredSyncSuccessorRetryAlarmName(
      successorSnapshot,
      successorObservedAt,
      '',
      successorAuthorityOrderObservedAt,
      successorAuthorityPreBaselineSequence
    );
  if (!successorRetryAlarmName) return null;
  deferredSyncSuccessorRetryAlarmEntries.set(successorRetryAlarmName, {
    remote: successorSnapshot,
    observedAt: successorObservedAt,
    authorityOrderObservedAt: successorAuthorityOrderObservedAt,
    authorityPreBaselineSequence:
      successorAuthorityPreBaselineSequence,
    predecessorSafetyAuthorityId: '',
    scheduleAuthorityGeneration: successorAuthorityGeneration,
    scheduleMutationGeneration: successorMutationGeneration
  });
  deferredSyncDisableSuccessorSnapshot = successorSnapshot;
  deferredSyncDisableSuccessorObservedAt = successorObservedAt;
  deferredSyncDisableSuccessorAuthorityOrderObservedAt =
    successorAuthorityOrderObservedAt;
  deferredSyncDisableSuccessorAuthorityPreBaselineSequence =
    successorAuthorityPreBaselineSequence;
  deferredSyncDisableSuccessorRetryAlarmName = successorRetryAlarmName;
  deferredSyncDisableSuccessorLocalAuthorityGeneration =
    successorAuthorityGeneration;
  deferredSyncDisableSuccessorMutationGeneration =
    successorMutationGeneration;
  _syncOpLock.rereadAfterSafetyDisable = true;
  const retryCredentialPromise =
    trackDeferredSyncSuccessorRetryAlarmOperation((async () => {
      await chrome.alarms.create(successorRetryAlarmName, {
        when: successorObservedAt + 60_000,
        periodInMinutes: 1
      });
      return !!await chrome.alarms.get(successorRetryAlarmName);
    })()).catch(error => {
      console.warn('[AC扩展] startup 未分类 remote successor 恢复钟创建失败:', error?.message);
      void appendDiagnosticLog(
        'warn',
        'startup-unclassified-sync-successor-retry-alarm',
        error
      );
      return false;
    });
  void waitUntil(Promise.allSettled([
    retryCredentialPromise,
    scheduleSyncRetry('adopt')
  ]));
  return retryCredentialPromise;
}

function rememberRemoteSyncSuccessorAfterDeferredDisable(
  remote,
  reason = '',
  {
    scheduleAuthorityGeneration = localScheduleAuthorityGeneration,
    scheduleMutationGeneration = localScheduleMutationGeneration,
    credentialObservedAt = 0,
    credentialRetryAlarmName = '',
    credentialAuthorityOrderObservedAt = 0,
    credentialAuthorityPreBaselineSequence = 0,
    recoverFromRetryCredential = false,
    preserveCausalObservation = false
  } = {}
) {
  const preservingCausalObservation = preserveCausalObservation === true
    && Number(credentialObservedAt) > 0;
  const recoveringExactCredential = recoverFromRetryCredential === true
    && Number(credentialObservedAt) > 0
    && !!String(credentialRetryAlarmName || '');
  const reusingCausalObservation = recoveringExactCredential
    || preservingCausalObservation;
  const requestedRetryAlarmName = String(
    credentialRetryAlarmName || ''
  );
  if ((!recoveringExactCredential
        && !preservingCausalObservation
        && !deferredSyncDisablePending
        && !deferredSyncDisableSuccessorSnapshot
        && !manualOffAutomaticOnBlocked)
      || !remote
      || typeof remote !== 'object'
      || remote.enabled === false) return null;
  const safetyAlreadyCleared = !deferredSyncDisablePending;
  const predecessorEpoch = deferredSyncDisableEpoch;
  const predecessorIdentity = getSyncPayloadIdentity(
    deferredSyncDisableRemoteSnapshot
  );
  const parsedRetryCredential = reusingCausalObservation
      && requestedRetryAlarmName
    ? parseDeferredSyncSuccessorRetryAlarm({
        name: requestedRetryAlarmName
      })
    : null;
  const lastClearedSafetyAuthorityIdAtStart =
    deferredSyncLastClearedSafetyAuthorityId;
  const causalPredecessorSafetyAuthorityId =
    normalizeDeferredSyncDisableSafetyAuthorityId(
      safetyAlreadyCleared
        ? deferredSyncLastClearedSafetyAuthorityId
        : deferredSyncDisableSafetyAuthorityId
    );
  const parsedPredecessorSafetyAuthorityId =
    normalizeDeferredSyncDisableSafetyAuthorityId(
      parsedRetryCredential?.predecessorSafetyAuthorityId
    );
  const retryCredentialNeedsRebinding = preservingCausalObservation
    && !!requestedRetryAlarmName
    && parsedPredecessorSafetyAuthorityId
      !== causalPredecessorSafetyAuthorityId;
  const reusingExactRetryCredential = reusingCausalObservation
    && !!requestedRetryAlarmName
    && !retryCredentialNeedsRebinding;
  const predecessorSafetyAuthorityId = preservingCausalObservation
    ? causalPredecessorSafetyAuthorityId
    : safetyAlreadyCleared
      ? parsedPredecessorSafetyAuthorityId
      : normalizeDeferredSyncDisableSafetyAuthorityId(
          recoveringExactCredential
            ? parsedPredecessorSafetyAuthorityId
            : deferredSyncDisableSafetyAuthorityId
        );
  if (safetyAlreadyCleared
      && recoveringExactCredential
      && !preservingCausalObservation
      && (!predecessorSafetyAuthorityId
        || predecessorSafetyAuthorityId
          !== lastClearedSafetyAuthorityIdAtStart)) {
    return null;
  }
  const successorAuthorityGeneration = Number.isSafeInteger(
    scheduleAuthorityGeneration
  )
    ? scheduleAuthorityGeneration
    : localScheduleAuthorityGeneration;
  const successorMutationGeneration = Number.isSafeInteger(
    scheduleMutationGeneration
  )
    ? scheduleMutationGeneration
    : localScheduleMutationGeneration;
  const successorSnapshot = { ...remote };
  const successorObservedAt = reusingCausalObservation
    ? Number(credentialObservedAt)
    : Date.now();
  const credentialAuthorityMetadataProvided =
    Number(credentialAuthorityOrderObservedAt) > 0;
  const successorAuthorityOrderObservedAt = reusingCausalObservation
    ? (credentialAuthorityMetadataProvided
        ? Number(credentialAuthorityOrderObservedAt)
        : Number(parsedRetryCredential?.authorityOrderObservedAt))
        || Number(parsedRetryCredential?.authorityOrderObservedAt)
        || successorObservedAt
    : nextSyncAuthorityObservedAt();
  const successorAuthorityPreBaselineSequence = reusingCausalObservation
    ? (credentialAuthorityMetadataProvided
        ? Math.max(
            0,
            Number(credentialAuthorityPreBaselineSequence) || 0
          )
        : Number(parsedRetryCredential?.authorityPreBaselineSequence) || 0)
    : getSyncAuthorityPreBaselineSequence(
        successorAuthorityOrderObservedAt
      );
  remoteSyncAuthorityObservedAt = Math.max(
    remoteSyncAuthorityObservedAt,
    successorAuthorityOrderObservedAt
  );
  const successorRetryAlarmName =
    reusingExactRetryCredential
      ? String(credentialRetryAlarmName)
      : createDeferredSyncSuccessorRetryAlarmName(
          successorSnapshot,
          successorObservedAt,
          predecessorSafetyAuthorityId,
          successorAuthorityOrderObservedAt,
          successorAuthorityPreBaselineSequence
        );
  const supersededRetryAlarmName = retryCredentialNeedsRebinding
    ? requestedRetryAlarmName
    : '';
  if (successorRetryAlarmName) {
    deferredSyncSuccessorRetryAlarmEntries.set(successorRetryAlarmName, {
      remote: successorSnapshot,
      observedAt: successorObservedAt,
      authorityOrderObservedAt: successorAuthorityOrderObservedAt,
      authorityPreBaselineSequence:
        successorAuthorityPreBaselineSequence,
      predecessorSafetyAuthorityId,
      scheduleAuthorityGeneration: successorAuthorityGeneration,
      scheduleMutationGeneration: successorMutationGeneration
    });
  }
  deferredSyncDisableSuccessorSnapshot = successorSnapshot;
  deferredSyncDisableSuccessorObservedAt = successorObservedAt;
  deferredSyncDisableSuccessorAuthorityOrderObservedAt =
    successorAuthorityOrderObservedAt;
  deferredSyncDisableSuccessorAuthorityPreBaselineSequence =
    successorAuthorityPreBaselineSequence;
  deferredSyncDisableSuccessorRetryAlarmName = successorRetryAlarmName;
  deferredSyncDisableSuccessorLocalAuthorityGeneration =
    successorAuthorityGeneration;
  deferredSyncDisableSuccessorMutationGeneration =
    successorMutationGeneration;
  _syncOpLock.rereadAfterSafetyDisable = true;

  const successorRetryCredentialPromise = successorRetryAlarmName
      && !reusingExactRetryCredential
    ? trackDeferredSyncSuccessorRetryAlarmOperation((async () => {
        await chrome.alarms.create(successorRetryAlarmName, {
          when: successorObservedAt + 60000,
          periodInMinutes: 1
        });
        return !!await chrome.alarms.get(successorRetryAlarmName);
      })()).catch(error => {
        console.warn('[AC扩展] remote successor 持久恢复钟创建失败:', error?.message);
        void appendDiagnosticLog(
          'warn',
          'deferred-sync-successor-retry-alarm',
          error
        );
        return false;
      })
    : Promise.resolve(
        reusingExactRetryCredential
      );

  const durableSuccessorPromise = runSerializedCriticalLocalStateWrite(async () => {
    const predecessorIsCurrent = () => (
      deferredSyncDisablePending === !safetyAlreadyCleared
      && deferredSyncDisableEpoch === predecessorEpoch
      && (safetyAlreadyCleared
        ? (preservingCausalObservation
          ? deferredSyncLastClearedSafetyAuthorityId
              === lastClearedSafetyAuthorityIdAtStart
          : (!recoveringExactCredential
          || (deferredSyncLastClearedSafetyAuthorityId
              === lastClearedSafetyAuthorityIdAtStart
            && predecessorSafetyAuthorityId
              === lastClearedSafetyAuthorityIdAtStart)))
        : (getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot)
            === predecessorIdentity
          && deferredSyncDisableSafetyAuthorityId
            === predecessorSafetyAuthorityId))
      && getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
        === getSyncPayloadIdentity(successorSnapshot)
      && deferredSyncDisableSuccessorObservedAt === successorObservedAt
      && deferredSyncDisableSuccessorRetryAlarmName
        === successorRetryAlarmName
    );
    if (!predecessorIsCurrent()) return false;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await chrome.storage.local.set({
          [DEFERRED_SYNC_DISABLE_KEY]: mergeDeferredSyncSafetyMetadata({
            pending: !safetyAlreadyCleared,
            ...(safetyAlreadyCleared ? { safetyCleared: true } : {}),
            ...(!safetyAlreadyCleared
              ? {
                  receivedAt: deferredSyncDisableObservedAt,
                  authorityOrderObservedAt:
                    deferredSyncDisableAuthorityOrderObservedAt
                    || deferredSyncDisableObservedAt,
                  ...(deferredSyncDisableAuthorityPreBaselineSequence > 0
                    ? {
                        authorityPreBaselineSequence:
                          deferredSyncDisableAuthorityPreBaselineSequence
                      }
                    : {})
                }
              : {}),
            safetyCutoffObservedAt: deferredSyncDisableObservedAt,
            localMutationCutoffObservedAt:
              localScheduleMutationCommittedObservedAt,
            updatedAt: Date.now(),
            reason: String(reason || ''),
            ...(!safetyAlreadyCleared
              ? { remote: { ...deferredSyncDisableRemoteSnapshot } }
              : {}),
            successor: {
              observedAt: successorObservedAt,
              ...(successorRetryAlarmName
                ? { retryAlarmName: successorRetryAlarmName }
                : {}),
              authorityOrderObservedAt:
                deferredSyncDisableSuccessorAuthorityOrderObservedAt
                || successorObservedAt,
              ...(deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
                ? {
                    authorityPreBaselineSequence:
                      deferredSyncDisableSuccessorAuthorityPreBaselineSequence
                  }
                : {}),
              ...(predecessorSafetyAuthorityId
                ? { predecessorSafetyAuthorityId }
                : {}),
              remote: successorSnapshot
            },
            releasedRetryAlarmNames: [
              ...deferredSyncDisableReleasedRetryAlarmNames
            ],
            releasedSuccessorRetryAlarmNames: [...new Set([
              ...deferredSyncSuccessorReleasedRetryAlarmNames,
              supersededRetryAlarmName
            ].filter(Boolean))],
            releasedSuccessorThroughObservedAt:
              deferredSyncSuccessorReleasedThroughObservedAt
          })
        });
        const stillCurrent = predecessorIsCurrent();
        return stillCurrent;
      } catch (error) {
        lastError = error;
        if (!predecessorIsCurrent()) return false;
      }
    }
    throw lastError || new Error('remote disable successor 写入失败');
  }).catch(error => {
    console.warn('[AC扩展] 持久化 remote disable 后继失败:', error?.message);
    void appendDiagnosticLog('warn', 'deferred-sync-successor-write', error);
    return false;
  });
  const supersededRetryCredentialCleanupPromise =
    supersededRetryAlarmName
      ? Promise.all([
          durableSuccessorPromise,
          successorRetryCredentialPromise
        ]).then(async ([persisted, replacementCredentialReady]) => {
          if (!persisted || !replacementCredentialReady) return false;
          deferredSyncSuccessorReleasedRetryAlarmNames.add(
            supersededRetryAlarmName
          );
          await clearDeferredSyncSuccessorRetryAlarms(
            [supersededRetryAlarmName],
            { preserveReleasedNames: true }
          );
          return true;
        }).catch(error => {
          console.warn('[AC扩展] 清理已重绑 remote successor 恢复钟失败:', error?.message);
          return false;
        })
      : Promise.resolve(true);
  void waitUntil(Promise.allSettled([
    durableSuccessorPromise,
    successorRetryCredentialPromise,
    supersededRetryCredentialCleanupPromise,
    scheduleSyncRetry('adopt')
  ]));
  return durableSuccessorPromise;
}

function isDeferredSyncDisableSuccessorCandidate(remote) {
  return !!deferredSyncDisableSuccessorSnapshot
    && !!remote
    && typeof remote === 'object'
    && remote.enabled !== false
    && getSyncPayloadIdentity(remote)
      === getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot);
}

async function tombstoneDeferredSyncDisableRetryIdentity(
  identity,
  reason = ''
) {
  const retryAlarmName = String(identity?.name || '');
  if (!retryAlarmName) return false;
  const persisted = await runSerializedCriticalLocalStateWrite(async () => {
    while (true) {
      const stateEpoch = deferredSyncDisableEpoch;
      const statePending = deferredSyncDisablePending;
      const stateRemoteIdentity = getSyncPayloadIdentity(
        deferredSyncDisableRemoteSnapshot
      );
      const stateSuccessorIdentity = getSyncPayloadIdentity(
        deferredSyncDisableSuccessorSnapshot
      );
      const stateIsCurrent = () => (
        deferredSyncDisableEpoch === stateEpoch
        && deferredSyncDisablePending === statePending
        && getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot)
          === stateRemoteIdentity
        && getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
          === stateSuccessorIdentity
      );
      const mailboxSnapshot = snapshotDeferredSyncDisableMailbox(reason) || {
        pending: false,
        safetyCutoffObservedAt: deferredSyncDisableObservedAt,
        localMutationCutoffObservedAt:
          localScheduleMutationCommittedObservedAt,
        updatedAt: Date.now(),
        reason: String(reason || ''),
        releasedSuccessorRetryAlarmNames: [
          ...deferredSyncSuccessorReleasedRetryAlarmNames
        ],
        releasedSuccessorThroughObservedAt:
          deferredSyncSuccessorReleasedThroughObservedAt
      };
      mailboxSnapshot.releasedRetryAlarmNames = [...new Set([
        ...deferredSyncDisableReleasedRetryAlarmNames,
        retryAlarmName
      ])];
      await chrome.storage.local.set({
        [DEFERRED_SYNC_DISABLE_KEY]:
          mergeDeferredSyncSafetyMetadata(mailboxSnapshot)
      });
      deferredSyncDisableReleasedRetryAlarmNames.add(retryAlarmName);
      if (stateIsCurrent()) return true;
    }
  });
  if (!persisted) return false;
  await clearDeferredSyncDisableRetryAlarms(
    [retryAlarmName],
    { preserveReleasedNames: true }
  ).catch(error => {
    console.warn('[AC扩展] 清理 stale remote disable 恢复钟失败:', error?.message);
  });
  return true;
}

async function tombstoneDeferredSyncSuccessorRetryIdentity(
  identity,
  reason = ''
) {
  const retryAlarmName = String(identity?.name || '');
  if (!retryAlarmName) return false;
  const persisted = await runSerializedCriticalLocalStateWrite(async () => {
    while (true) {
      const stateEpoch = deferredSyncDisableEpoch;
      const statePending = deferredSyncDisablePending;
      const stateSuccessorIdentity = getSyncPayloadIdentity(
        deferredSyncDisableSuccessorSnapshot
      );
      const stateSuccessorObservedAt =
        deferredSyncDisableSuccessorObservedAt;
      const stateIsCurrent = () => (
        deferredSyncDisableEpoch === stateEpoch
        && deferredSyncDisablePending === statePending
        && getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
          === stateSuccessorIdentity
        && deferredSyncDisableSuccessorObservedAt
          === stateSuccessorObservedAt
      );
      const durableRetryAlarmNames = [...new Set([
        ...deferredSyncSuccessorReleasedRetryAlarmNames,
        retryAlarmName
      ])];
      const mailboxSnapshot = snapshotDeferredSyncDisableMailbox(reason) || {
        pending: false,
        safetyCutoffObservedAt: deferredSyncDisableObservedAt,
        localMutationCutoffObservedAt:
          localScheduleMutationCommittedObservedAt,
        updatedAt: Date.now(),
        reason: String(reason || ''),
        releasedRetryAlarmNames: [
          ...deferredSyncDisableReleasedRetryAlarmNames
        ],
        releasedSuccessorThroughObservedAt:
          deferredSyncSuccessorReleasedThroughObservedAt
      };
      mailboxSnapshot.releasedSuccessorRetryAlarmNames =
        durableRetryAlarmNames;
      mailboxSnapshot.releasedSuccessorThroughObservedAt =
        deferredSyncSuccessorReleasedThroughObservedAt;
      await chrome.storage.local.set({
        [DEFERRED_SYNC_DISABLE_KEY]:
          mergeDeferredSyncSafetyMetadata(mailboxSnapshot)
      });
      // storage.set 已 durable 后立刻推进内存 tombstone；若后到 writer 已
      // 排队，它会在同一 FIFO 中携带这枚名字，不能反向擦除。
      deferredSyncSuccessorReleasedRetryAlarmNames.add(retryAlarmName);
      if (stateIsCurrent()) return true;
    }
  });
  if (!persisted) return false;
  await clearDeferredSyncSuccessorRetryAlarms(
    [retryAlarmName],
    { preserveReleasedNames: true }
  ).catch(error => {
    console.warn('[AC扩展] 清理 stale successor 恢复钟失败:', error?.message);
  });
  return true;
}

async function clearDeferredSyncDisableSuccessorAfterAdoption(remote) {
  if (!isDeferredSyncDisableSuccessorCandidate(remote)) return true;
  const successorIdentity = getSyncPayloadIdentity(remote);
  const successorObservedAt = deferredSyncDisableSuccessorObservedAt;
  const successorRetryAlarmName =
    deferredSyncDisableSuccessorRetryAlarmName;
  const successorAuthorityOrderObservedAt =
    deferredSyncDisableSuccessorAuthorityOrderObservedAt
    || successorObservedAt;
  const successorAuthorityGeneration =
    deferredSyncDisableSuccessorLocalAuthorityGeneration;
  const releasedRetryAlarmNames =
    await captureDeferredSyncSuccessorRetryAlarmsThrough(
      successorAuthorityOrderObservedAt,
      {
        authorityPreBaselineSequence:
          deferredSyncDisableSuccessorAuthorityPreBaselineSequence
      }
    );
  const durableReleasedRetryAlarmNames = [...new Set([
    ...deferredSyncSuccessorReleasedRetryAlarmNames,
    ...releasedRetryAlarmNames
  ])];
  const releasedThroughObservedAt = Math.max(
    deferredSyncSuccessorReleasedThroughObservedAt,
    successorAuthorityOrderObservedAt
  );
  let terminalTombstonePersisted = false;
  const cleared = await runSerializedCriticalLocalStateWrite(async () => {
    const successorIsCurrent = () => (
      !deferredSyncDisablePending
      && localScheduleAuthorityGeneration
        === successorAuthorityGeneration
      && getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
        === successorIdentity
      && deferredSyncDisableSuccessorObservedAt === successorObservedAt
      && deferredSyncDisableSuccessorRetryAlarmName
        === successorRetryAlarmName
    );
    if (!successorIsCurrent()) return false;
    await chrome.storage.local.set({
      [DEFERRED_SYNC_DISABLE_KEY]: mergeDeferredSyncSafetyMetadata({
        pending: false,
        safetyCutoffObservedAt: deferredSyncDisableObservedAt,
        localMutationCutoffObservedAt:
          localScheduleMutationCommittedObservedAt,
        successorAppliedAt: Date.now(),
        releasedRetryAlarmNames: [
          ...deferredSyncDisableReleasedRetryAlarmNames
        ],
        releasedSuccessorRetryAlarmNames:
          durableReleasedRetryAlarmNames,
        releasedSuccessorThroughObservedAt: releasedThroughObservedAt
      })
    });
    terminalTombstonePersisted = true;
    for (const name of releasedRetryAlarmNames) {
      deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
    }
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      deferredSyncSuccessorReleasedThroughObservedAt,
      releasedThroughObservedAt
    );
    if (!successorIsCurrent()) return false;
    deferredSyncDisableSuccessorSnapshot = null;
    deferredSyncDisableSuccessorObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
    deferredSyncDisableSuccessorRetryAlarmName = '';
    deferredSyncDisableSuccessorLocalAuthorityGeneration = 0;
    deferredSyncDisableSuccessorMutationGeneration = 0;
    return true;
  });
  if (terminalTombstonePersisted && releasedRetryAlarmNames.length > 0) {
    await clearDeferredSyncSuccessorRetryAlarms(
      releasedRetryAlarmNames
    ).catch(error => {
      console.warn('[AC扩展] 清理已采纳 successor 恢复钟失败:', error?.message);
    });
  }
  return cleared;
}

async function discardStaleDeferredSyncDisableSuccessor(
  remote,
  reason = ''
) {
  if (!isDeferredSyncDisableSuccessorCandidate(remote)) return true;
  const successorIdentity = getSyncPayloadIdentity(remote);
  const successorObservedAt = deferredSyncDisableSuccessorObservedAt;
  const successorRetryAlarmName =
    deferredSyncDisableSuccessorRetryAlarmName;
  const successorAuthorityOrderObservedAt =
    deferredSyncDisableSuccessorAuthorityOrderObservedAt
    || successorObservedAt;
  const releasedRetryAlarmNames =
    await captureDeferredSyncSuccessorRetryAlarmsThrough(
      successorAuthorityOrderObservedAt,
      {
        authorityPreBaselineSequence:
          deferredSyncDisableSuccessorAuthorityPreBaselineSequence
      }
    );
  const durableReleasedRetryAlarmNames = [...new Set([
    ...deferredSyncSuccessorReleasedRetryAlarmNames,
    ...releasedRetryAlarmNames
  ])];
  const releasedThroughObservedAt = Math.max(
    deferredSyncSuccessorReleasedThroughObservedAt,
    successorAuthorityOrderObservedAt
  );
  let terminalTombstonePersisted = false;
  const discarded = await runSerializedCriticalLocalStateWrite(async () => {
    const successorIsStillStale = () => (
      !deferredSyncDisablePending
      && getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
        === successorIdentity
      && deferredSyncDisableSuccessorObservedAt === successorObservedAt
      && deferredSyncDisableSuccessorRetryAlarmName
        === successorRetryAlarmName
    );
    if (!successorIsStillStale()) return false;
    await chrome.storage.local.set({
      [DEFERRED_SYNC_DISABLE_KEY]: mergeDeferredSyncSafetyMetadata({
        pending: false,
        safetyCutoffObservedAt: deferredSyncDisableObservedAt,
        localMutationCutoffObservedAt:
          localScheduleMutationCommittedObservedAt,
        successorDiscardedAt: Date.now(),
        discardReason: String(reason || ''),
        releasedRetryAlarmNames: [
          ...deferredSyncDisableReleasedRetryAlarmNames
        ],
        releasedSuccessorRetryAlarmNames:
          durableReleasedRetryAlarmNames,
        releasedSuccessorThroughObservedAt: releasedThroughObservedAt
      })
    });
    terminalTombstonePersisted = true;
    for (const name of releasedRetryAlarmNames) {
      deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
    }
    deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
      deferredSyncSuccessorReleasedThroughObservedAt,
      releasedThroughObservedAt
    );
    if (!successorIsStillStale()) return false;
    deferredSyncDisableSuccessorSnapshot = null;
    deferredSyncDisableSuccessorObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityOrderObservedAt = 0;
    deferredSyncDisableSuccessorAuthorityPreBaselineSequence = 0;
    deferredSyncDisableSuccessorRetryAlarmName = '';
    deferredSyncDisableSuccessorLocalAuthorityGeneration = 0;
    deferredSyncDisableSuccessorMutationGeneration = 0;
    return true;
  });
  if (terminalTombstonePersisted && releasedRetryAlarmNames.length > 0) {
    await clearDeferredSyncSuccessorRetryAlarms(
      releasedRetryAlarmNames
    ).catch(error => {
      console.warn('[AC扩展] 清理已淘汰 successor 恢复钟失败:', error?.message);
    });
  }
  return discarded;
}

async function clearDeferredSyncDisableAfterRemoteAdoption(expectedEpoch) {
  if (!deferredSyncDisablePending) return true;
  if (!(expectedEpoch > 0) || deferredSyncDisableEpoch !== expectedEpoch) {
    return false;
  }
  const releaseReceipt = await prepareStableDeferredSyncDisableRelease(
    () => (
      deferredSyncDisablePending
      && deferredSyncDisableEpoch === expectedEpoch
    ),
    'remote-disable-adoption'
  );
  if (!isStableDeferredSyncDisableReleaseReceiptCurrent(releaseReceipt)) {
    return false;
  }
  const releasedDeferredDisableRetryAlarmNames =
    [...releaseReceipt.releasedDisableRetryAlarmNames];
  const releasedSafetyPredecessorSuccessorRetryAlarmNames =
    [...releaseReceipt.releasedSuccessorRetryAlarmNames];
  const durableReleasedSuccessorRetryAlarmNames = [...new Set([
    ...deferredSyncSuccessorReleasedRetryAlarmNames,
    ...releasedSafetyPredecessorSuccessorRetryAlarmNames
  ])];
  const durableReleasedSuccessorThroughObservedAt = Math.max(
    deferredSyncSuccessorReleasedThroughObservedAt,
    deferredSyncDisableAuthorityOrderObservedAt
      || deferredSyncDisableObservedAt
  );
  if (!deferredSyncDisablePending
      || deferredSyncDisableEpoch !== expectedEpoch
      || !isStableDeferredSyncDisableReleaseReceiptCurrent(releaseReceipt)) {
    return false;
  }
  const cleared = await runSerializedCriticalLocalStateWrite(async () => {
    while (deferredSyncDisablePending
        && deferredSyncDisableEpoch === expectedEpoch
        && isStableDeferredSyncDisableReleaseReceiptCurrent(releaseReceipt)) {
      if (!await validateStableDeferredSyncDisableRelease(
        releaseReceipt
      )) {
        return false;
      }
      const successorSnapshot = deferredSyncDisableSuccessorSnapshot
        ? { ...deferredSyncDisableSuccessorSnapshot }
        : null;
      const successorIdentity = getSyncPayloadIdentity(successorSnapshot);
      const successorObservedAt = successorSnapshot
        ? deferredSyncDisableSuccessorObservedAt
        : 0;
      const successorRetryAlarmName = successorSnapshot
        ? deferredSyncDisableSuccessorRetryAlarmName
        : '';
      await chrome.storage.local.set({
        [DEFERRED_SYNC_DISABLE_KEY]: mergeDeferredSyncSafetyMetadata(
          successorSnapshot
          ? {
              pending: false,
              safetyCleared: true,
              safetyCutoffObservedAt: deferredSyncDisableObservedAt,
              localMutationCutoffObservedAt:
                localScheduleMutationCommittedObservedAt,
              clearedAt: Date.now(),
              successor: {
                observedAt: successorObservedAt || Date.now(),
                ...(successorRetryAlarmName
                  ? {
                      retryAlarmName:
                        successorRetryAlarmName
                    }
                  : {}),
                authorityOrderObservedAt:
                  deferredSyncDisableSuccessorAuthorityOrderObservedAt
                  || successorObservedAt
                  || Date.now(),
                ...(deferredSyncDisableSuccessorAuthorityPreBaselineSequence > 0
                  ? {
                      authorityPreBaselineSequence:
                        deferredSyncDisableSuccessorAuthorityPreBaselineSequence
                    }
                  : {}),
                remote: successorSnapshot
              },
              releasedRetryAlarmNames:
                releasedDeferredDisableRetryAlarmNames,
              releasedSuccessorRetryAlarmNames:
                durableReleasedSuccessorRetryAlarmNames,
              releasedSuccessorThroughObservedAt:
                durableReleasedSuccessorThroughObservedAt
            }
          : {
              pending: false,
              safetyCutoffObservedAt: deferredSyncDisableObservedAt,
              localMutationCutoffObservedAt:
                localScheduleMutationCommittedObservedAt,
              clearedAt: Date.now(),
              releasedRetryAlarmNames:
                releasedDeferredDisableRetryAlarmNames,
              releasedSuccessorRetryAlarmNames:
                durableReleasedSuccessorRetryAlarmNames,
              releasedSuccessorThroughObservedAt:
                durableReleasedSuccessorThroughObservedAt
            }
        )
      });
      if (!deferredSyncDisablePending
          || deferredSyncDisableEpoch !== expectedEpoch
          || !isStableDeferredSyncDisableReleaseReceiptCurrent(
            releaseReceipt
          )) {
        return false;
      }
      // true 可在 storage.set 的 await 窗口到达；直到 durable marker 与
      // 最新内存 successor 身份相同才原子 finalize，避免 SW crash 丢 mailbox。
      if (successorIdentity
            !== getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
          || successorObservedAt
            !== (deferredSyncDisableSuccessorSnapshot
              ? deferredSyncDisableSuccessorObservedAt
              : 0)
          || successorRetryAlarmName
            !== (deferredSyncDisableSuccessorSnapshot
              ? deferredSyncDisableSuccessorRetryAlarmName
              : '')) {
        continue;
      }
      for (const name of releasedDeferredDisableRetryAlarmNames) {
        deferredSyncDisableReleasedRetryAlarmNames.add(name);
      }
      for (const name of
        releasedSafetyPredecessorSuccessorRetryAlarmNames) {
        deferredSyncSuccessorReleasedRetryAlarmNames.add(name);
      }
      deferredSyncSuccessorReleasedThroughObservedAt = Math.max(
        deferredSyncSuccessorReleasedThroughObservedAt,
        durableReleasedSuccessorThroughObservedAt
      );
      finalizeDeferredSyncDisableClearInMemory({ preserveSuccessor: true });
      return true;
    }
    return false;
  });
  if (cleared && releasedDeferredDisableRetryAlarmNames.length > 0) {
    await clearDeferredSyncDisableRetryAlarms(
      releasedDeferredDisableRetryAlarmNames,
      { preserveReleasedNames: true }
    ).catch(error => {
      console.warn('[AC扩展] 清理 remote disable 恢复钟失败:', error?.message);
    });
  }
  if (cleared
      && releasedSafetyPredecessorSuccessorRetryAlarmNames.length > 0) {
    await clearDeferredSyncSuccessorRetryAlarms(
      releasedSafetyPredecessorSuccessorRetryAlarmNames,
      { preserveReleasedNames: true }
    ).catch(error => {
      console.warn('[AC扩展] 清理被 safety F 淘汰的 successor 恢复钟失败:', error?.message);
    });
  }
  return cleared;
}

async function setSyncPublishPending(
  pending,
  { ensureCurrent = null } = {}
) {
  const writeIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  try {
    return !!await runSerializedCriticalLocalStateWrite(async () => {
      if (!writeIsCurrent()) return false;
      if (pending) {
        await chrome.storage.local.set({
          [SYNC_PENDING_PUBLISH_KEY]: true
        });
      } else {
        await chrome.storage.local.remove(SYNC_PENDING_PUBLISH_KEY);
      }
      return writeIsCurrent();
    });
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

async function getSyncPublishAuthorityState() {
  try {
    const stored = await chrome.storage.local.get([
      SYNC_PENDING_PUBLISH_KEY,
      LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY
    ]);
    return Object.freeze({
      pending: stored?.[SYNC_PENDING_PUBLISH_KEY] === true,
      localMutationCutoffObservedAt: Math.max(
        0,
        Number(stored?.[LOCAL_SCHEDULE_MUTATION_CUTOFF_KEY]) || 0
      )
    });
  } catch (error) {
    console.warn('[AC扩展] sync publish authority 读取失败:', error?.message);
    return null;
  }
}

function runSerializedSyncPublishRetryAlarmWrite(operation) {
  syncPublishRetryAlarmWritesInFlight += 1;
  const queued = syncPublishRetryAlarmWriteChain
    .catch(() => {})
    .then(operation);
  const tracked = queued.finally(() => {
    syncPublishRetryAlarmWritesInFlight = Math.max(
      0,
      syncPublishRetryAlarmWritesInFlight - 1
    );
  });
  syncPublishRetryAlarmWriteChain = tracked.catch(() => {});
  return tracked;
}

function createSyncPublishRetryAlarmReceipt() {
  const generation = ++syncPublishRetryAlarmWriteGeneration;
  return runSerializedSyncPublishRetryAlarmWrite(async () => {
    if (generation !== syncPublishRetryAlarmWriteGeneration) {
      return Object.freeze({ created: false, generation, stale: true });
    }
    const created = await createAlarm(
      'ac-sync-publish-retry',
      { delayInMinutes: 1 }
    );
    return Object.freeze({
      created: !!created
        && generation === syncPublishRetryAlarmWriteGeneration,
      generation,
      stale: generation !== syncPublishRetryAlarmWriteGeneration
    });
  });
}

function clearSyncPublishRetryAlarmWithReceipt(
  receipt,
  ensureCurrent = null
) {
  const generation = Number(receipt?.generation) || 0;
  const clearIsCurrent = () => (
    generation > 0
    && generation === syncPublishRetryAlarmWriteGeneration
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  return runSerializedSyncPublishRetryAlarmWrite(async () => {
    if (!clearIsCurrent()) return false;
    const cleared = await chrome.alarms.clear('ac-sync-publish-retry');
    // 后到 create 会先换 generation，再排到本 clear 之后；即使 clear
    // I/O 期间 owner 变化，新 alarm 也必然最后落盘，旧 writer 无法删它。
    return clearIsCurrent() && cleared;
  });
}

async function scheduleSyncRetry(
  kind = 'publish',
  { returnReceipt = false } = {}
) {
  if (kind === 'adopt') {
    return createAlarm('ac-sync-adopt-retry', { delayInMinutes: 1 });
  }
  const receipt = await createSyncPublishRetryAlarmReceipt();
  return returnReceipt ? receipt : receipt.created;
}

async function loadSyncWatermark() {
  if (syncWatermarkLoaded) return lastSyncedAt;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const writeGenerationAtRead = syncWatermarkWriteGeneration;
      const writeChainAtRead = syncWatermarkWriteChain;
      await writeChainAtRead.catch(() => {});
      if (writeGenerationAtRead !== syncWatermarkWriteGeneration
          || writeChainAtRead !== syncWatermarkWriteChain
          || syncWatermarkWritesInFlight !== 0) {
        continue;
      }
      const stored = await chrome.storage.local.get([
        SYNC_WATERMARK_KEY,
        SYNC_PAYLOAD_RECEIPT_KEY
      ]);
      if (writeGenerationAtRead !== syncWatermarkWriteGeneration
          || writeChainAtRead !== syncWatermarkWriteChain
          || syncWatermarkWritesInFlight !== 0) {
        continue;
      }
      const durableWatermark = normalizeSyncAuthorityCutoff(
        stored?.[SYNC_WATERMARK_KEY]
      );
      lastSyncedAt = Math.max(lastSyncedAt, durableWatermark);
      const payloadReceipt = normalizeSyncPayloadReceipt(
        stored?.[SYNC_PAYLOAD_RECEIPT_KEY]
      );
      // receipt 与 scalar watermark 是同一 local.set 的完成凭据。若磁盘上
      // receipt 跑在 scalar 前面，只能视为损坏/部分迁移；以后 scalar-only
      // observation 前进也不得“追认”这张尚未被 durable watermark 覆盖的票。
      completedSyncPayloadReceipt = payloadReceipt
          && payloadReceipt.syncedAt <= durableWatermark
        ? payloadReceipt
        : null;
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

async function persistSyncWatermark(
  value,
  payload = null,
  { coveredLocalMutationObservedAt = null } = {}
) {
  const requestedAt = normalizeSyncAuthorityTimestamp(value);
  if (!(requestedAt > 0)) return false;
  const payloadIdentity = normalizeSyncAuthorityTimestamp(payload?.syncedAt)
      === requestedAt
    ? getSyncPayloadIdentity(payload)
    : '';
  const payloadReceipt = payloadIdentity
    ? Object.freeze({
        schemaVersion: SYNC_PAYLOAD_RECEIPT_SCHEMA_VERSION,
        syncedAt: requestedAt,
        identity: payloadIdentity,
        coveredLocalMutationObservedAt: Math.max(
          0,
          coveredLocalMutationObservedAt === null
            ? Number(localScheduleMutationCommittedObservedAt) || 0
            : Number(coveredLocalMutationObservedAt) || 0
        )
      })
    : null;
  syncWatermarkWriteGeneration += 1;
  syncWatermarkWritesInFlight += 1;
  const write = syncWatermarkWriteChain.then(async () => {
    const watermarkAt = Math.max(lastSyncedAt, requestedAt);
    const retainedPayloadReceipt = payloadReceipt
      || (completedSyncPayloadReceipt
          && completedSyncPayloadReceipt.syncedAt <= watermarkAt
        ? completedSyncPayloadReceipt
        : null);
    // 内存水位先单调前进，即使 local 暂时写失败，本 SW 生命周期内
    // 也不会重放已确认的快照；重启后仍会从上次 durable 水位重试。
    lastSyncedAt = watermarkAt;
    syncWatermarkLoaded = true;
    try {
      await chrome.storage.local.set({
        [SYNC_WATERMARK_KEY]: watermarkAt,
        // scalar-only observation 也原子保留或 tombstone 当前合法 receipt。
        // 否则磁盘上的 future/corrupt receipt 会在 scalar 追平并重启后复活。
        [SYNC_PAYLOAD_RECEIPT_KEY]: retainedPayloadReceipt
      });
      // 只有 local.set 成功后，这两个内存字段才代表 durable receipt。
      // 写失败时保留旧 exact identity；不得把易失状态当成可跳过 F 的证据。
      if (payloadReceipt) {
        completedSyncPayloadReceipt = payloadReceipt;
      } else if (!retainedPayloadReceipt) {
        completedSyncPayloadReceipt = null;
      }
      return true;
    } catch (error) {
      console.warn('[AC扩展] sync watermark 写入失败:', error?.message);
      return false;
    }
  }).finally(() => {
    syncWatermarkWritesInFlight = Math.max(
      0,
      syncWatermarkWritesInFlight - 1
    );
  });
  syncWatermarkWriteChain = write.catch(() => {});
  return write;
}

// 把当前内存 schedule 瘦化后写入 chrome.storage.sync。
// reason 用于日志。失败静默降级。
async function syncScheduleToSync(reason = '') {
  if (!chrome.storage?.sync) return;  // 受限上下文（incognito / 策略禁用）
  if (!await ensureSyncAuthorityDurableBaselineLoaded()) {
    await Promise.allSettled([
      setSyncPublishPending(true),
      scheduleSyncRetry('publish')
    ]);
    return false;
  }
  if ((automaticOnAdmissionBlocked && schedule.enabled === true)
      || manualOffAutomaticOnBlocked
      || deferredSyncDisablePending
      || deferredSyncDisableSuccessorSnapshot
      || isStartupRestoreSupersededByUserIntent()) {
    const blockedByDeferredSuccessor = !manualOffAutomaticOnBlocked
      && !deferredSyncDisablePending
      && !!deferredSyncDisableSuccessorSnapshot;
    await Promise.allSettled([
      setSyncPublishPending(true),
      scheduleSyncRetry('publish'),
      ...(blockedByDeferredSuccessor
        ? [scheduleSyncRetry('adopt')]
        : [])
    ]);
    if (blockedByDeferredSuccessor) {
      queuePendingSyncAdoption(
        reason || 'sync-publish-blocked-by-successor',
        deferredSyncDisableSuccessorSnapshot
      );
      drainDeferredSyncAdoptionAfterManualOffAdmission();
    }
    return false;
  }
  const writeGeneration = ++syncPublishGeneration;
  const publishPayloadIdentityAtRequest = getSyncPayloadIdentity(
    composeSyncPayload(schedule, 0)
  );
  const publishIntentIsCurrent = () => (
    syncPublishGeneration === writeGeneration
    && getSyncPayloadIdentity(composeSyncPayload(schedule, 0))
      === publishPayloadIdentityAtRequest
    && !(automaticOnAdmissionBlocked && schedule.enabled === true)
    && !manualOffAutomaticOnBlocked
    && !deferredSyncDisablePending
    && !deferredSyncDisableSuccessorSnapshot
    && !isStartupRestoreSupersededByUserIntent()
  );
  let writeClaimed = false;
  let releaseWrite = null;
  // 在第一次 await 前先安装共享 barrier；随后到达的 inbound 必须等本次
  // publish 完成。durable marker + alarm 让连续 storage 读取失败或 SW 重启
  // 也不会永久吞掉最后一次本机停用／相位提交。
  const pendingMark = setSyncPublishPending(true);
  const retryAlarm = scheduleSyncRetry('publish', {
    returnReceipt: true
  });
  let publishRetryAlarmReceipt = null;
  try {
    const [pendingMarkResult, retryAlarmResult] =
      await Promise.allSettled([pendingMark, retryAlarm]);
    publishRetryAlarmReceipt = retryAlarmResult.status === 'fulfilled'
      ? retryAlarmResult.value
      : null;
    const durableOutboundCredentialReady =
      (pendingMarkResult.status === 'fulfilled'
        && pendingMarkResult.value === true)
      || (retryAlarmResult.status === 'fulfilled'
        && retryAlarmResult.value?.created === true);
    if (!durableOutboundCredentialReady) {
      // 没有 durable marker 或 fixed retry alarm，旧 T 若在 sync.set 中
      // 跨过后到 F，重启后就没有任何证据能证明它是本机 predecessor。
      // 因此双凭据失败时必须在物理外发前停住。
      console.warn('[AC扩展] sync 外发凭据均未持久化，取消本次写入');
      void appendDiagnosticLog(
        'warn',
        'sync-publish-credential',
        new Error('sync pending marker 与 publish retry alarm 均不可用')
      );
      return false;
    }
    if (_syncOpLock.busy) {
      _syncOpLock.pendingOutbound = true;
      _syncOpLock.pendingOutboundReason = reason;
      return false;
    }
    // 任一本机 pending outbound 在物理 set 前都必须 fresh-read sync store。
    // 否则 SW 重启后的旧 true 可在 onChanged 尚未投递时覆盖另一设备刚写的
    // false。此时尚未登记本次 in-flight，stable reader 才能证明没有旧 writer。
    const remoteSafetyReady =
      await refreshRemoteDisableBeforeLocalRelease(
        publishIntentIsCurrent,
        `${reason || 'sync-publish'}-remote-safety-preflight`,
        {
          // local false 覆盖 remote false 不会放宽安全，且 F settle 后的
          // corrective publish 不能把同一份 store F 再恢复成新 F。
          allowSafeLocalDisablePublish: schedule.enabled === false
        }
      );
    if (!remoteSafetyReady || !publishIntentIsCurrent()) return false;

    // 同一 SW 内的外发写串行，避免 T2 先完成、T1 后完成导致
    // sync store 与 durable watermark 倒退。stable preflight 之后同步 claim，
    // 中间没有 await；后到 writer 会换 generation，使本次在 set 前退出。
    syncWriteOperationsInFlight += 1;
    writeClaimed = true;
    const previousWrite = syncWriteChain;
    syncWriteChain = new Promise(resolve => { releaseWrite = resolve; });
    await previousWrite.catch(() => {});
    if (!publishIntentIsCurrent()) return false;
    if (_syncOpLock.busy) {
      _syncOpLock.pendingOutbound = true;
      _syncOpLock.pendingOutboundReason = reason;
      return false;
    }
    const loadedWatermark = await loadSyncWatermark();
    if (loadedWatermark === null) {
      throw new Error('sync watermark 暂时不可读，已取消本次 sync 写入');
    }
    if (!publishIntentIsCurrent()) return false;
    const wallNow = Date.now();
    // Lamport 式时戳：本机已见过快时钟对端后，后续显式停用等
    // 本地写入仍必须比已知版本新。wallNow 仍用于相位过期判定。
    const writeAt = Math.max(wallNow, lastSyncedAt + 1);
    const retryKind = String(schedule.pwmRetryKind || '');
    const retryDescriptor = getPwmRetryDescriptor(retryKind);
    // timer-only repair 表示 AC 可能已 ON、但关机保险尚未确认。同步一个
    // 明确的近期 OFF 动作：新版对端会保留任何更早 OFF，而旧版／新设备
    // 也会建 OFF alarm，不会把 enabled=true + 无 phase 误解为立即新开一轮。
    const projectSafetyTimerOff = schedule.smartMode?.enabled === true
      && retryDescriptor?.syncProjection === 'safety-timer-off';
    // 其余 smart ON retry/safety-wait 发生在 AC 尚未确认 ON 时。它们投影成
    // “下一半点执行 OFF”的安全哨兵，以替换对端旧 ON actuator；源端提交正常
    // OFF phase 后再同步真实截止。源端中断时，对端也只会幂等确认 OFF。
    const projectSafetySentinel = schedule.smartMode?.enabled === true
      && retryDescriptor?.syncProjection === 'safety-sentinel';
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
    if (!publishIntentIsCurrent()) return false;
    const publishedMutationCutoffAtWrite =
      localScheduleMutationCommittedObservedAt;
    // onChanged 只能按这份完整 payload 身份识别本机 echo；“当前有任意
    // outbound 在途”不能证明同时到达的另一台设备 false 是自回环。
    const localEchoIdentity = rememberLocalSyncPayload(slim);
    try {
      await chrome.storage.sync.set({ [SYNC_KEY]: slim });
    } finally {
      // storage.onChanged 正常会先消费这张票；set 同值不触发事件或 API
      // 异常时只给短暂投递宽限，禁止历史 payload 永久享有 echo 豁免。
      setTimeout(() => {
        activeLocalSyncEchoIdentities.delete(localEchoIdentity);
      }, 5000);
    }
    // 只有 sync.set 成功后才能声称该版本已发布。失败写不推进
    // durable watermark，否则重启后会错误屏蔽 sync store 里仍然合法的旧版本。
    const watermarkPersisted = await persistSyncWatermark(
      writeAt,
      slim,
      {
        coveredLocalMutationObservedAt:
          publishedMutationCutoffAtWrite
      }
    );
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
      const cleanupIsCurrent = () => (
        syncPublishGeneration === writeGeneration
      );
      const markerCleared = await setSyncPublishPending(false, {
        ensureCurrent: cleanupIsCurrent
      });
      if (markerCleared && syncPublishGeneration === writeGeneration) {
        await clearSyncPublishRetryAlarmWithReceipt(
          publishRetryAlarmReceipt,
          cleanupIsCurrent
        );
      }
      // remove/clear 都是异步的；若其间出现新请求，恢复 marker + alarm，
      // 不能让旧成功清理覆盖新请求的持久重试凭证。
      if (syncPublishGeneration !== writeGeneration) {
        await setSyncPublishPending(true);
        await scheduleSyncRetry('publish');
      }
    }
    drainDeferredSyncAdoptionAfterManualOffAdmission();
    return true;
  } catch (e) {
    console.warn('[AC扩展] sync 写入失败（未登录浏览器同步 / 配额超限？）:', e?.message);
    void appendDiagnosticLog('warn', 'sync-write', e);
    await scheduleSyncRetry('publish');
    return false;
  } finally {
    if (writeClaimed) {
      syncWriteOperationsInFlight = Math.max(
        0,
        syncWriteOperationsInFlight - 1
      );
      releaseWrite?.();
    }
  }
}

// 把远端 sync 对象合并到本地 schedule + 重排闹钟。返回 true=已变更并持久化。
// 注意：调用方需要保证不并发（_syncOpLock 守卫）。
async function applySyncedPhase(remote, reason = '', options = {}) {
  if (!remote || typeof remote !== 'object') return false;
  if (!await ensureSyncAuthorityDurableBaselineLoaded()) {
    await scheduleSyncRetry('adopt');
    return false;
  }
  const syncAdmissionEpoch = typeof automaticDisableAdmissionEpoch === 'number'
    ? automaticDisableAdmissionEpoch
    : 0;
  // config authority 与物理 actuator 分轴：显式本机 enable/disable 才换 L；
  // 一次性 manual ON 不换 L，因此不能越过已经到达的 remote disable。
  let syncScheduleAuthorityGeneration = Number.isSafeInteger(
    options.scheduleAuthorityGeneration
  )
    ? options.scheduleAuthorityGeneration
    : localScheduleAuthorityGeneration;
  let syncScheduleMutationGeneration = Number.isSafeInteger(
    options.scheduleMutationGeneration
  )
    ? options.scheduleMutationGeneration
    : localScheduleMutationGeneration;
  const syncAdoptionPreempted = () => (
    localScheduleAuthorityGeneration !== syncScheduleAuthorityGeneration
    || (remote.enabled !== false
      && localScheduleMutationGeneration
        !== syncScheduleMutationGeneration)
    || (remote.enabled !== false
      && typeof automaticOnAdmissionBlocked === 'boolean'
      && automaticOnAdmissionBlocked)
    || (typeof automaticDisableAdmissionEpoch === 'number'
      && automaticDisableAdmissionEpoch !== syncAdmissionEpoch)
  );
  const loadedWatermark = await loadSyncWatermark();
  if (loadedWatermark === null) {
    await scheduleSyncRetry('adopt');
    return false;
  }
  const remoteSyncedAt = normalizeSyncAuthorityTimestamp(remote.syncedAt);
  if (!(remoteSyncedAt > 0)) {
    if (remote.enabled === false && !deferredSyncDisablePending) {
      deferRemoteSyncDisableWhileManualOffBlocked(
        remote,
        `${reason}-invalid-syncedAt`,
        syncScheduleAuthorityGeneration
      );
    }
    await scheduleSyncRetry('adopt');
    return false;
  }
  const remoteIsDeferredSuccessor =
    isDeferredSyncDisableSuccessorCandidate(remote);
  let deferredDisableEpochAtAdoption = 0;
  // 显式停用是跨时钟的安全优先级。旧版／离线设备可能用较慢墙钟
  // 写出一份在 sync store 中更晚到达、但 syncedAt 数值更小的 disable。
  // 不能因全局 watermark 继续自动控制。
  const isExactDeferredSafetyDisable = () => (
    remote?.enabled === false
    && deferredSyncDisablePending
    && getSyncPayloadIdentity(remote)
      === getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot)
  );
  const lowerClockSafetyDisable = remote?.enabled === false
    && (schedule.enabled === true || isExactDeferredSafetyDisable());
  if (remoteSyncedAt > 0
      && remoteSyncedAt <= lastSyncedAt
      && !lowerClockSafetyDisable) {
    console.log(`[AC扩展] sync ↓ ${reason}: 忽略陈旧或自回环快照 syncedAt=${remoteSyncedAt}`);
    if (remoteIsDeferredSuccessor) {
      await clearDeferredSyncDisableSuccessorAfterAdoption(remote);
    }
    return false;
  }
  if (remote.enabled === false) {
    if (!deferredSyncDisablePending) {
      deferRemoteSyncDisableWhileManualOffBlocked(
        remote,
        reason,
        syncScheduleAuthorityGeneration
      );
    }
    deferredDisableEpochAtAdoption = deferredSyncDisableEpoch;
    syncScheduleAuthorityGeneration =
      deferredSyncDisableLocalScheduleAuthorityGeneration;
    syncScheduleMutationGeneration =
      deferredSyncDisableLocalMutationGeneration;
    // startup 任一 safety source 读取失败时创建的 synthetic F 只是一道
    // 自动 ON admission block，不是 remote config/actuator authority。真实
    // F 也必须先拥有当前 durable exact receipt；否则此处 commit 会用
    // cutoff=0 的内存 mailbox 覆盖刚从 storage 恢复的本机 M。
    if (deferredSyncDisableSyntheticReadFailure
        || !hasCurrentDeferredSyncDisableDurableReceipt()) {
      await scheduleSyncRetry('adopt');
      return false;
    }
  }
  // 远端 config、相位、active-hours 基础设施属于同一事务。等待当前
  // boundary/page/watchdog owner 完整收口后直接接棒，随后直到 durable
  // commit + live alarm 完成都持有同一 epoch；不能先 LWW 改 config，再发现
  // 相位锁被旧事务占用而留下“新配置、旧/无主钟”。
  const phaseAdmissionEpoch = await claimSyncPhaseAdoptionAdmissionWhenAvailable();
  if (phaseAdmissionEpoch <= 0) return false;
  const remoteConfigAuthorityIsCurrent = () => (
    isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && !syncAdoptionPreempted()
    && (remote.enabled !== false
      || (deferredSyncDisablePending
        && deferredDisableEpochAtAdoption === deferredSyncDisableEpoch
        && isExactDeferredSafetyDisable()))
  );
  let remoteDisableScheduleCommitted = false;
  try {

  // 提取（Fowler Extract Function）：同步停用路径——B1 顺序：先 persist 停用状态，再走页面定时器关机。
  async function shutdownAfterSyncDisable({ activeHoursPause = false } = {}) {
    await resetDisabledPwmRuntime();
    // B1（同步停用）：先 persist 停用状态再执行长流程关机 — 防止 SW 在
    // verifyPageTimerPersistence 的 2 分钟+等待中被杀后，storage 仍是 enabled=true
    // 导致重启后闹钟自愈"复活" PWM。末尾 `if (changed)` persist 仍处理相位/activeHours。
    if (remote.enabled === false) {
      remoteDisableScheduleCommitted = await commitScheduleAuthority({
        ensureCurrent: remoteConfigAuthorityIsCurrent,
        reason: activeHoursPause
          ? 'sync-active-hours-paused-pre-shutdown'
          : 'sync-disabled-pre-shutdown'
      });
      if (!remoteDisableScheduleCommitted) {
        throw new Error('远端停用 schedule authority 已被后续配置接管');
      }
    } else if (activeHoursPause) {
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
  // F 到达后若本机又提交普通设置，F 仍必须强制 enabled=false，但不能
  // 用随包携带的旧 onMinutes/activeHours/phase 吞掉更晚本机字段。
  // F/T 的配置屏障只来自 durable M cutoff；单纯 arrival generation 会在
  // M storage throw/abort 后残留，不能给从未提交的本机设置制造 authority。
  const remoteCarriesDeferredAuthority =
    remote.enabled === false || remoteIsDeferredSuccessor;
  const remoteMustPreserveLaterLocalConfig =
    remoteCarriesDeferredAuthority
      ? hasCommittedLocalMutationAfterDeferredRemoteAuthority()
      : syncScheduleMutationGeneration !== localScheduleMutationGeneration;
  const remoteForConfigAndPhase = remoteMustPreserveLaterLocalConfig
    ? { enabled: remote.enabled, syncedAt: remoteSyncedAt }
    : remote;
  // 1) config 字段无相位守卫——直接 last-writer-wins 采纳
  const rawCfg = computeConfigDiff(schedule, remoteForConfigAndPhase);
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
  let phaseAdoptionWriteOwner = 0;
  let phaseAdoptionExpectedWriteGeneration = null;
  let phaseAdoptionPageTimerWriteOwner = 0;
  let phaseAdoptionPageTimerState = null;
  let phaseAdoptionDurableCommitted = false;
  let phaseAdoptionStale = false;
  let phaseAdoptionIncomplete = false;
  async function adoptPhaseAndRearm(remote, automationAllowed) {
    let automationRevision = pwmRuntimeRevision;
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
    const phaseOwnerIsCurrent = () => (
      isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
      && !syncAdoptionPreempted()
      && isAutomationOperationCurrent(automationRevision)
      && (phaseAdoptionPageTimerWriteOwner <= 0
        || isPageTimerWriteOwnerCurrent(phaseAdoptionPageTimerWriteOwner))
    );
    const phasePwmPredecessorIsCurrent = () => (
      isPwmAlarmWriteGenerationCurrent(
        phaseAdoptionExpectedWriteGeneration
      )
    );
    const takePhasePageTimerWriteOwner = (owner, pageTimerState = undefined) => {
      const claimedOwner = owner;
      if (Number.isSafeInteger(claimedOwner) && claimedOwner > 0) {
        phaseAdoptionPageTimerWriteOwner = claimedOwner;
        phaseAdoptionPageTimerState = snapshotOwnedPageTimerState(
          claimedOwner,
          pageTimerState === undefined ? schedule : pageTimerState
        );
      }
    };
    const replayPhasePageTimerState = () => (
      phaseAdoptionPageTimerWriteOwner <= 0
        || (phaseAdoptionPageTimerState !== null
          && replayOwnedPageTimerState(phaseAdoptionPageTimerState))
    );
    if (phaseNeedsOwnership) {
        // revision 抢占与旧 live alarm 清除之间存在 await 窗口。先保留一把独立
        // admission reservation，使已送达的旧 alarm/watchdog 也无法趁取消请求
        // 等待期间 claim 新 revision；reservation 直到 durable intent + rearm 收口。
        if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
          phaseAdoptionIncomplete = true;
          await scheduleSyncRetry('adopt');
          return false;
        }
        automationRevision = pwmRuntimeRevision += 1;
        invalidateTimerBasedShutdown();
        // 在任何 await 前冻结当前 PWM generation。后到的同 revision writer
        // 一旦接管，首次 clear 必须 stale-return，不能清掉它的新 live alarm。
        phaseAdoptionExpectedWriteGeneration = pwmAlarmWriteGeneration;
        try {
          await cancelAutomaticOnRequests();
        } catch (error) {
          console.warn('[AC扩展] sync 相位抢占：取消旧自动 ON 失败，继续以新 revision 收口:', error?.message);
          void appendDiagnosticLog('warn', 'sync-phase-preempt', error);
        }
        if (syncAdoptionPreempted()) {
          phaseAdoptionIncomplete = true;
          return false;
        }
        if (!isAutomationOperationCurrent(automationRevision)) {
          // 非明确停用的 owner 抢占意味着这份已通过语义门禁的 remote phase
          // 尚未 durable；必须留下重试入口，不能静默丢失。
          phaseAdoptionIncomplete = true;
          await scheduleSyncRetry('adopt');
          return false;
        }
        if (!phasePwmPredecessorIsCurrent()) {
          phaseAdoptionIncomplete = true;
          await scheduleSyncRetry('adopt');
          return false;
        }
      }

      const oldPwmState = schedule.pwmState;
      const oldTrigger = schedule.nextTriggerAt;
      const oldSmartClockPlannedAt = Number(schedule.smartClockPlannedAt) || 0;
      schedule.pwmState = adopt.pwmState;
      const adoptedPlannedAt = Number(remote?.smartClockPlannedAt) || 0;
      if (phaseNeedsOwnership) {
        setPwmClockIntent(adopt.nextTriggerAt, {
          plannedAt: adoptedPlannedAt
        });
      } else {
        setNextTriggerAt(adopt.nextTriggerAt, {
          plannedAt: adoptedPlannedAt
        });
      }
      const phaseChanged = phaseNeedsOwnership
        || oldPwmState !== schedule.pwmState
        || oldTrigger !== schedule.nextTriggerAt;
      const originChanged = oldSmartClockPlannedAt
        !== Number(schedule.smartClockPlannedAt || 0);
      if (!phaseChanged && originChanged) {
        phaseMetadataChanged = true;
        return false;
      }
      if (phaseChanged) clearPwmRetryState();

      if (phaseChanged && automationAllowed) {
        const phaseIntentState = snapshotPhaseAdoptionIntentState();
        try {
          // 先把远端 phase/绝对边界写成 durable intent，再清旧 live alarm。
          // create=false 时诊断/看门狗才能看见新所有权，而非重载旧 storage 假绿。
          await persistSchedule('sync-phase-adopt-intent', { syncFromLiveAlarm: false });
          if (!phaseOwnerIsCurrent()
              || !phasePwmPredecessorIsCurrent()
              || !replayPhaseAdoptionIntentState(phaseIntentState)) {
            phaseAdoptionStale = true;
            throw new Error('同步相位 durable intent 已被后续 owner 接管');
          }
          const delayMs = adopt.nextTriggerAt - Date.now();
          if (delayMs > 0) {
            const clearAlarmWrite = await clearPwmAlarmWithReceipt(
              automationRevision,
              false,
              {
                expectedWriteGeneration: phaseAdoptionExpectedWriteGeneration,
                ensureCurrent: phaseOwnerIsCurrent
              }
            );
            phaseAdoptionWriteOwner = clearAlarmWrite.writeOwner;
            if (clearAlarmWrite.writeOwner > 0) {
              phaseAdoptionExpectedWriteGeneration = clearAlarmWrite.writeOwner;
            }
            if (!phaseOwnerIsCurrent()
                || !isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)) {
              phaseAdoptionStale = true;
              throw new Error('同步相位首次 clear 的 predecessor 已失效');
            }
            if (!clearAlarmWrite.cleared) {
              throw new Error(
                clearAlarmWrite.error || '同步相位清理旧 PWM 闹钟失败'
              );
            }
            // 用绝对时间调度，让多设备对齐到同一时刻（非 delayInMinutes 各自倒计时）
            const alarmFailureState = withPhaseAdoptionPageTimerError(
              phaseIntentState,
              '同步相位已采纳，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复'
            );
            const phaseCommit = await commitOwnedPwmAlarmPlan({
              plan: { nextTriggerAt: adopt.nextTriggerAt },
              logTag: 'sync-phase-adopt',
              automationRevision,
              previousWriteOwner: clearAlarmWrite.writeOwner,
              plannedAt: phaseIntentState.clockIntentState.smartClockPlannedAt,
              isCurrent: phaseOwnerIsCurrent,
              replayFailureState: () => replayPhaseAdoptionIntentState(
                alarmFailureState
              ),
              replaySuccessState: () => replayPhaseAdoptionIntentState(
                phaseIntentState,
                { replayClock: false }
              ),
              failurePersistReason: 'sync-phase-adopt-alarm-failed',
              successPersistReason: 'sync-phase-adopt'
            });
            phaseAdoptionWriteOwner = phaseCommit.writeOwner
              || phaseAdoptionWriteOwner;
            if (phaseCommit.writeOwner > 0) {
              phaseAdoptionExpectedWriteGeneration = phaseCommit.writeOwner;
            }
            if (phaseCommit.stale) {
              phaseAdoptionStale = true;
              throw new Error('同步相位建钟提交已被后续 owner 接管');
            }
            phaseAdoptionDurableCommitted = phaseCommit.persisted;
            if (!phaseCommit.created) {
              const failedExpectedBoundaryAt = remoteClockAssessment.applicable
                ? Number(remoteClockAssessment.boundaryAt)
                  || Number(remoteClockAssessment.expectedAt)
                  || 0
                : 0;
              const failedPhaseIsCurrent = () => (
                phaseOwnerIsCurrent()
                && isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner)
              );
              await createAlarm('ac-watchdog', {
                delayInMinutes: 1,
                periodInMinutes: 5,
                ensureCurrent: failedPhaseIsCurrent
              });
              if (!failedPhaseIsCurrent()) {
                phaseAdoptionStale = true;
                return false;
              }
              await scheduleSyncRetry('adopt');
              if (!failedPhaseIsCurrent()) {
                phaseAdoptionStale = true;
                return false;
              }
              queueDeferredScheduleRepair({
                smartOnExpectedBoundaryAt: failedExpectedBoundaryAt,
                revokeInvalidSmartOnClock: failedExpectedBoundaryAt > 0,
                revokeOwnerRevision: automationRevision,
                preserveRevokeAcrossSupersededRepair:
                  failedExpectedBoundaryAt > 0
              });
              return true;
            }
          } else {
            // 远端时戳已过期（在 staleMs 60s 窗口内）——推进到下一未来周期边界
            const clearAlarmWrite = await clearPwmAlarmWithReceipt(
              automationRevision,
              false,
              {
                expectedWriteGeneration: phaseAdoptionExpectedWriteGeneration,
                ensureCurrent: phaseOwnerIsCurrent
              }
            );
            phaseAdoptionWriteOwner = clearAlarmWrite.writeOwner;
            if (clearAlarmWrite.writeOwner > 0) {
              phaseAdoptionExpectedWriteGeneration = clearAlarmWrite.writeOwner;
            }
            if (!phaseOwnerIsCurrent()
                || !isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)) {
              phaseAdoptionStale = true;
              throw new Error('同步过期相位 clear 的 predecessor 已失效');
            }
            if (!clearAlarmWrite.cleared) {
              throw new Error(
                clearAlarmWrite.error || '同步过期相位清理旧 PWM 闹钟失败'
              );
            }
            const advanceReceipt = await advanceExpiredAlarmToNextBoundary(
              adopt.nextTriggerAt,
              automationRevision,
              phaseAdmissionEpoch,
              {
                previousWriteOwner: clearAlarmWrite.writeOwner,
                ensureCurrent: phaseOwnerIsCurrent,
                onPageTimerWriteOwnerClaimed: takePhasePageTimerWriteOwner
              }
            );
            phaseAdoptionWriteOwner = Number(advanceReceipt.writeOwner)
              || phaseAdoptionWriteOwner;
            if (advanceReceipt.writeOwner > 0) {
              phaseAdoptionExpectedWriteGeneration = advanceReceipt.writeOwner;
            }
            takePhasePageTimerWriteOwner(
              advanceReceipt.pageTimerWriteOwner,
              advanceReceipt.pageTimerState ?? null
            );
            if (!replayPhasePageTimerState()) {
              phaseAdoptionStale = true;
              throw new Error('同步过期相位页面证明已被后续 owner 接管');
            }
            if (!advanceReceipt.advanced || !advanceReceipt.persisted) {
              throw new Error('同步过期相位未建立未来恢复时钟');
            }
            phaseAdoptionDurableCommitted = true;
            if (!phaseOwnerIsCurrent()
                || !isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner)) {
              phaseAdoptionStale = true;
              throw new Error('同步过期相位恢复已被后续 owner 接管');
            }
          }
        } catch (e) {
          console.warn('[AC扩展] sync 合并：重排 ac-pwm 闹钟失败:', e?.message);
          const phaseWriteOwnerLost = phaseAdoptionWriteOwner > 0
            && !isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner);
          if (!phaseOwnerIsCurrent()
              || phaseWriteOwnerLost
              || !phasePwmPredecessorIsCurrent()
              || phaseAdoptionStale) {
            phaseAdoptionStale = true;
            // owner-authorized expired recovery 可能已换 revision。只有 storage、
            // 内存和 live alarm 三方收口且语义有效才保护它；仅 claim 未提交的
            // 新 revision 仍须沿原半点立即 fresh-status repair。
            const replacementProof = await proveStableDurableLivePwmOwner(
              pwmRuntimeRevision,
              'sync 新 phase owner'
            );
            if (!replacementProof.automationAllowed) {
              await abortStaleAutomation(
                automationRevision,
                'sync-phase-owner-active-hours-paused',
                { phaseAdmissionEpoch }
              );
              return true;
            }
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
            if (phaseAdoptionPageTimerWriteOwner <= 0
                || isPageTimerWriteOwnerCurrent(phaseAdoptionPageTimerWriteOwner)) {
              schedule.pageTimerError = `同步相位的新 owner 未完成稳定 durable/live 收口：${e?.message || String(e)}；立即修复主钟`;
            }
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
          setPwmClockIntent(0);
          const failureState = snapshotPhaseAdoptionIntentState({
            allowMissingClock: true,
            pageTimerError: `同步相位重排失败：${e?.message || String(e)}；立即修复主钟`
          });
          const failureIsCurrent = () => (
            phaseOwnerIsCurrent()
            && phasePwmPredecessorIsCurrent()
          );
          let failurePersisted = false;
          try {
            failurePersisted = await persistOwnedPwmAlarmFailure({
              isCurrent: failureIsCurrent,
              replayState: () => replayPhaseAdoptionIntentState(failureState),
              persistReason: 'sync-phase-adopt-error'
            });
          } catch (persistError) {
            console.warn('[AC扩展] sync 相位失败态持久化失败，仍继续即时修复:', persistError?.message);
            void appendDiagnosticLog(
              'warn',
              'sync-phase-adopt-failure-persist',
              persistError
            );
          }
          try {
            await createAlarm('ac-watchdog', {
              delayInMinutes: 1,
              periodInMinutes: 5,
              ensureCurrent: failureIsCurrent
            });
          } catch (watchdogError) {
            console.warn('[AC扩展] sync 相位失败后备看门狗创建失败:', watchdogError?.message);
          }
          if (!failureIsCurrent()) {
            phaseAdoptionStale = true;
            return false;
          }
          try {
            await scheduleSyncRetry('adopt');
          } catch (retryError) {
            console.warn('[AC扩展] sync 相位采纳重试创建失败:', retryError?.message);
          }
          if (!failureIsCurrent()) {
            phaseAdoptionStale = true;
            return false;
          }
          queueDeferredScheduleRepair({
            smartOnExpectedBoundaryAt: failedExpectedBoundaryAt,
            revokeInvalidSmartOnClock: failedExpectedBoundaryAt > 0,
            revokeOwnerRevision: automationRevision,
            preserveRevokeAcrossSupersededRepair: failedExpectedBoundaryAt > 0
          });
          // 物理 clear / durable persist 任何一环未知时都不能把 remote 标成
          // 已处理；保留 adopt retry 和原 watermark，repair 收口后仍可重放。
          phaseAdoptionIncomplete = true;
          if (failurePersisted) {
            console.warn('[AC扩展] sync 相位失败态已持久化，但 remote 保持未处理等待重放');
          }
          return false;
        }
      }
    return phaseChanged;
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
    : await adoptPhaseAndRearm(remoteForConfigAndPhase, automationAllowed);
  const phaseCommitIsCurrent = () => (
    !phaseChanged
    || (phaseAdoptionDurableCommitted
      && phaseAdoptionWriteOwner > 0
      && isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner)
      && (phaseAdoptionPageTimerWriteOwner <= 0
        || (phaseAdoptionPageTimerState !== null
          && isPageTimerWriteOwnerCurrent(
            phaseAdoptionPageTimerWriteOwner
          ))))
  );
  const replayCommittedPhasePageTimerState = () => (
    phaseAdoptionPageTimerWriteOwner <= 0
      || (phaseAdoptionPageTimerState !== null
        && replayOwnedPageTimerState(phaseAdoptionPageTimerState))
  );
  if (syncAdoptionPreempted()
      || phaseAdoptionIncomplete
      || phaseAdoptionStale
      || !phaseCommitIsCurrent()
      || !replayCommittedPhasePageTimerState()) return false;

  // 3) 闹钟基础设施重建——只由 config 变更驱动（相位路径只管 ac-pwm）
  //    关键修复：若 enabled 在 sync 中翻为 true 但无相位（远端刚 enable 还没跑完第一步），
  //    只持久化 enabled=true 却不建闹钟，设备 B 永远不会真正执行 PWM。
  //    反之 enabled 翻为 false 也必须主动清理闹钟 + 停机，否则设备 B 继续跑本地 PWM。
  let didAlarmInfra = false;
  if (enabledChanged || activeHoursChanged || remote.enabled === false) {
    if (remotePhaseRejected && (enabledChanged || !wasAutomationAllowed)) {
      // 旧版 sync 可能没有 smartClockPlannedAt；不得让“相位拒绝”退化成
      // false→true 无相位立即开机。保持 fail-closed disabled，等下一份带可信
      // phase 的快照再恢复。
      schedule.enabled = false;
      nowEnabled = false;
      await shutdownAfterSyncDisable();
      didAlarmInfra = true;
    } else if (!nowEnabled) {
      if (enabledChanged || remote.enabled === false) {
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
        const setupSucceeded = await setupAlarms(true, {
          phaseAdmissionEpoch
        });
        if (!setupSucceeded) return false;
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      }
      didAlarmInfra = true;
    }
  }
  if (!phaseCommitIsCurrent()
      || !replayCommittedPhasePageTimerState()) return false;

  // 4) active hours 边界闹钟：activeHours 变更或相位重排后都应重调度
  if (activeHoursChanged || phaseChanged) {
    await rescheduleActiveBoundary();
  }

  if (syncAdoptionPreempted()
      || !phaseCommitIsCurrent()
      || !replayCommittedPhasePageTimerState()) return false;

  const changed = configChanged || phaseChanged || phaseMetadataChanged;
  // 先把采纳后的 schedule 落盘，再推进“已处理 remote”水位。
  // 即便本次 diff 为空也会重落一次：若上次 persist 失败后内存已
  // 变更，重试不能因 diff 变空就跳过 durable commit。
  if ((changed || remoteSyncedAt > 0)
      && !(phaseChanged && phaseAdoptionDurableCommitted)) {
    await persistSchedule(
      changed ? (reason || 'sync-采纳') : 'sync-已处理快照',
      { syncFromLiveAlarm: false }
    );
  }
  if (!phaseCommitIsCurrent()
      || !replayCommittedPhasePageTimerState()) return false;
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
  if (!phaseCommitIsCurrent()
      || !replayCommittedPhasePageTimerState()) return false;
  if (remote.enabled === false && !remoteDisableScheduleCommitted) {
    remoteDisableScheduleCommitted = await commitScheduleAuthority({
      ensureCurrent: remoteConfigAuthorityIsCurrent,
      reason: reason || 'sync-disable-adoption'
    });
    if (!remoteDisableScheduleCommitted) return false;
  }
  if (remote.enabled === false
      && deferredDisableEpochAtAdoption > 0) {
    // schedule=false 与幂等 shutdown 已 durable 后先清 fail-close record，
    // 再推进 watermark。若 watermark 写失败，重放 remote 仍是幂等；反向
    // 顺序会让一次 clear 失败被已推进的水位永久屏蔽。
    const cleared = await clearDeferredSyncDisableAfterRemoteAdoption(
      deferredDisableEpochAtAdoption
    );
    if (!cleared) return false;
  }
  // schedule durable commit 成功后才标记已见；写水位失败时保留当前
  // 内存抑制，重启后安全重放同一快照。
  if (remoteSyncedAt > 0) {
    await persistSyncWatermark(remoteSyncedAt, remote);
  }
  if (remoteIsDeferredSuccessor) {
    const successorCleared =
      await clearDeferredSyncDisableSuccessorAfterAdoption(remote);
    if (!successorCleared) return false;
  }
  if (!phaseCommitIsCurrent()
      || !replayCommittedPhasePageTimerState()) return false;
  return changed;
  } finally {
    releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
    drainDeferredScheduleRepair('apply-synced-phase-complete');
  }
}

// 从 chrome.storage.sync 拉取并尝试合并。reason 用于日志。
// 传 explicitRemote 可跳过读取（onChanged 已传入 newValue）；否则从 sync store 读。
async function tryAdoptSyncedState(reason = '', explicitRemote = null) {
  let successorReceipt = null;
  if ((deferredSyncDisablePending
        || deferredSyncDisableSuccessorSnapshot
        || manualOffAutomaticOnBlocked)
      && explicitRemote
      && typeof explicitRemote === 'object'
      && explicitRemote.enabled !== false
      && getSyncPayloadIdentity(explicitRemote)
        !== getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)) {
    successorReceipt = (!deferredSyncDisableLoaded
        || deferredSyncDisableSyntheticReadFailure)
      ? rememberUnclassifiedRemoteSyncSuccessorDuringSyntheticReadFailure(
          explicitRemote,
          reason
        )
      : rememberRemoteSyncSuccessorAfterDeferredDisable(
          explicitRemote,
          reason
        );
  }
  // 本机手动 OFF 尚未完成 durable off-phase 时，远端 config/phase 不得
  // 改写本地安全事务；但事件不能丢，尤其 remote enabled=false 必须在
  // marker 收口后第一时间消费。
  if (manualOffAutomaticOnBlocked) {
    queuePendingSyncAdoption(
      reason || 'manual-off-admission-blocked',
      explicitRemote
    );
    if (successorReceipt) await successorReceipt;
    if (explicitRemote && typeof explicitRemote === 'object') {
      if (explicitRemote.enabled === false
          && (!deferredSyncDisablePending
            || deferredSyncDisableSyntheticReadFailure)) {
        deferRemoteSyncDisableWhileManualOffBlocked(explicitRemote, reason);
      }
    }
    return false;
  }
  const queuePendingAdoption = () => {
    queuePendingSyncAdoption(reason, explicitRemote);
    console.log(`[AC扩展] sync 合并排队（上次仍在处理）: ${reason}`);
    return false;
  };
  if (_syncOpLock.busy) {
    return queuePendingAdoption();
  }

  // 先排空在本次入站之前已经登记的 outbound barrier，再取得入站锁。
  // 循环复核 identity，覆盖 await 已解析 promise 的微任务窗口内新登记的写。
  let overlappedOutbound = false;
  if (!deferredSyncDisablePending) {
    while (true) {
      const observedWriteChain = syncWriteChain;
      if (syncWriteOperationsInFlight > 0) overlappedOutbound = true;
      await observedWriteChain.catch(() => {});
      if (observedWriteChain === syncWriteChain) break;
      overlappedOutbound = true;
    }
  } else {
    // safety predecessor 不等可能卡住的旧 outbound；defer 已换 publish
    // generation，旧写即使越过最后检查也不能清 durable retry marker。
    overlappedOutbound = syncWriteOperationsInFlight > 0;
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
  if (deferredSyncDisablePending) {
    if (remote && remote.enabled !== false) {
      _syncOpLock.rereadAfterSafetyDisable = true;
    }
    remote = deferredSyncDisableRemoteSnapshot
      ? { ...deferredSyncDisableRemoteSnapshot, enabled: false }
      : { enabled: false, syncedAt: 0 };
    requestReason = `${reason || 'sync'}-deferred-disable-predecessor`;
  } else if (deferredSyncDisableSuccessorSnapshot) {
    remote = { ...deferredSyncDisableSuccessorSnapshot };
    requestReason = `${reason || 'sync'}-deferred-disable-successor`;
  }
  let readAttempts = 0;
  try {
    const pendingPublish = await getSyncPublishPending();
    const publishRetryAlarm = await chrome.alarms.get('ac-sync-publish-retry');
    const handlingSafetyPredecessor = remote?.enabled === false
      && deferredSyncDisablePending
      && getSyncPayloadIdentity(remote)
        === getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot);
    const handlingDeferredSuccessor =
      isDeferredSyncDisableSuccessorCandidate(remote);
    if (pendingPublish !== false || publishRetryAlarm) {
      _syncOpLock.pendingOutbound = true;
      _syncOpLock.pendingOutboundReason = handlingSafetyPredecessor
        ? 'sync-after-safety-disable'
        : handlingDeferredSuccessor
          ? 'sync-after-safety-successor'
          : 'sync-durable-publish-preempts-inbound';
      if (!handlingSafetyPredecessor && !handlingDeferredSuccessor) {
        await scheduleSyncRetry('publish');
        return false;
      }
    }
    while (true) {
      if (!remote
          && !deferredSyncDisablePending
          && deferredSyncDisableSuccessorSnapshot) {
        remote = { ...deferredSyncDisableSuccessorSnapshot };
        requestReason = 'sync-after-safety-disable-successor';
      }
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
        const candidateIsDeferredSuccessor =
          isDeferredSyncDisableSuccessorCandidate(candidate);
        const candidateSuccessorLocalAuthorityGeneration =
          deferredSyncDisableSuccessorLocalAuthorityGeneration;
        const candidateSuccessorMutationGeneration =
          deferredSyncDisableSuccessorMutationGeneration;
        // 等待共享 schedule 队列时，显式 disable 总能淘汰旧 candidate；
        // 其余快照仍按 syncedAt 选新，避免乱序旧事件掩盖较新失败。
          const pendingSupersedesCandidate = () => {
            if (!_syncOpLock.pending) return false;
            const pendingRemote = _syncOpLock.pendingRemote;
            if (candidate?.enabled === false) {
              const candidateIsExactSafetyPredecessor =
                deferredSyncDisablePending
                && getSyncPayloadIdentity(candidate)
                  === getSyncPayloadIdentity(
                    deferredSyncDisableRemoteSnapshot
                  );
              if (!candidateIsExactSafetyPredecessor) return true;
              // 后到 true 只登记 reread，不能用 pendingRemote=null 淘汰
              // 正在等待 schedule FIFO 的 exact false；后到 F2 才能接棒。
              return pendingRemote?.enabled === false;
            }
            if (!pendingRemote) return true;
            if (pendingRemote.enabled === false) return true;
          const pendingAt = normalizeSyncAuthorityTimestamp(
            pendingRemote.syncedAt
          );
          const candidateAt = normalizeSyncAuthorityTimestamp(
            candidate?.syncedAt
          );
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
            const candidateIsSafetyPredecessor = candidate?.enabled === false
              && deferredSyncDisablePending
              && getSyncPayloadIdentity(candidate)
                === getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot);
            if (candidateIsSafetyPredecessor) {
              if (localPublishPending !== false) {
                _syncOpLock.pendingOutbound = true;
                _syncOpLock.pendingOutboundReason = 'sync-after-safety-disable';
              }
            } else if (candidateIsDeferredSuccessor) {
              const successorAuthorityIsCurrent =
                candidateSuccessorLocalAuthorityGeneration
                  === localScheduleAuthorityGeneration;
              const successorMutationIsCurrent =
                candidateSuccessorMutationGeneration
                  === localScheduleMutationGeneration;
              const candidateMutationStillCommitting =
                localScheduleMutationCommitPendingGeneration > 0
                && localScheduleMutationCommitPendingGeneration
                  >= candidateSuccessorMutationGeneration;
              if (candidateMutationStillCommitting) {
                // 用户 M 已到达但其 schedule/phase 尚在共享 FIFO 后方。
                // 同 generation 的 T 也必须等待：它是在 M arrival 后到达，
                // 应在 M durable/abort 后重放，不能抢在 M 前写 schedule。
                // 当前只保留 mailbox 并退出；finish 会主动 drain。
                return false;
              }
              if (!successorAuthorityIsCurrent
                  || !successorMutationIsCurrent) {
                await discardStaleDeferredSyncDisableSuccessor(
                  candidate,
                  successorAuthorityIsCurrent
                    ? 'later-local-schedule-mutation'
                    : 'later-local-explicit-authority'
                );
                _syncOpLock.pendingOutbound = true;
                _syncOpLock.pendingOutboundReason =
                  'sync-after-stale-safety-successor';
                return false;
              }
            } else if (_syncOpLock.pendingOutbound
                || localPublishPending !== false) {
              _syncOpLock.pendingOutbound = true;
              _syncOpLock.pendingOutboundReason = 'sync-local-publish-preempts-inbound';
              await scheduleSyncRetry('publish');
              return false;
            }
            return applySyncedPhase(
              candidate,
              candidateReason,
              candidateIsDeferredSuccessor
                ? {
                    scheduleAuthorityGeneration:
                      candidateSuccessorLocalAuthorityGeneration,
                    scheduleMutationGeneration:
                      candidateSuccessorMutationGeneration
                  }
                : {}
            );
          });
          applied = changed || applied;
          if (candidateIsDeferredSuccessor
              && isDeferredSyncDisableSuccessorCandidate(candidate)) {
            await scheduleSyncRetry('adopt');
          }
        } catch (e) {
          console.warn('[AC扩展] sync 合并失败:', e?.message);
          void appendDiagnosticLog('warn', 'sync-adopt', e);
          if (!pendingSupersedesCandidate()) {
            await scheduleSyncRetry('adopt');
            throw e;
          }
        }
      }
      if (!deferredSyncDisablePending
          && _syncOpLock.rereadAfterSafetyDisable) {
        // false 已 durable + shutdown + clear；事件副本只证明“有后继”，
        // 真正候选必须重读当前 sync store，避免中途又被第三份快照覆盖。
        _syncOpLock.rereadAfterSafetyDisable = false;
        _syncOpLock.pending = true;
        _syncOpLock.pendingReason = 'sync-after-safety-disable-reread';
        _syncOpLock.pendingRemote = null;
        _syncOpLock.pendingRemoteCausalEnvelope = null;
        _syncOpLock.pendingRemoteScheduleAuthorityGeneration = 0;
        _syncOpLock.pendingRemoteMutationGeneration = 0;
      }
      if (!_syncOpLock.pending) return applied;

      // busy 期间的事件只作为“有更新”信号；重新读取 sync 区，避免事件副本
      // 被后到的自回环覆盖。优先消费事件携带的最新快照；缺失时才重读 sync 区。
      requestReason = _syncOpLock.pendingReason || 'pending-sync';
      remote = _syncOpLock.pendingRemote;
      _syncOpLock.pending = false;
      _syncOpLock.pendingReason = '';
      _syncOpLock.pendingRemote = null;
      _syncOpLock.pendingRemoteCausalEnvelope = null;
      _syncOpLock.pendingRemoteScheduleAuthorityGeneration = 0;
      _syncOpLock.pendingRemoteMutationGeneration = 0;
      readAttempts = 0;
    }
  } finally {
    const pendingOutbound = _syncOpLock.pendingOutbound;
    const pendingOutboundReason = _syncOpLock.pendingOutboundReason;
    _syncOpLock.busy = false;
    _syncOpLock.pending = false;
    _syncOpLock.pendingReason = '';
    _syncOpLock.pendingRemote = null;
    _syncOpLock.pendingRemoteCausalEnvelope = null;
    _syncOpLock.pendingRemoteScheduleAuthorityGeneration = 0;
    _syncOpLock.pendingRemoteMutationGeneration = 0;
    if (!deferredSyncDisablePending) {
      _syncOpLock.rereadAfterSafetyDisable = false;
    }
    _syncOpLock.pendingOutbound = false;
    _syncOpLock.pendingOutboundReason = '';
    if (pendingOutbound) {
      if (deferredSyncDisableSuccessorSnapshot) {
        // predecessor 的旧 publish marker 不能在 successor 采纳失败时
        // 把当前 local false 覆盖回 sync store；保留 marker，先重试 mailbox。
        await scheduleSyncRetry('adopt');
      } else {
        await syncScheduleToSync(
          pendingOutboundReason || 'sync-after-inbound'
        );
      }
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
  let phaseAdoptionWriteOwner = 0;
  let phaseAdoptionExpectedWriteGeneration = null;
  let phaseAdoptionPageTimerWriteOwner = 0;
  let phaseAdoptionPageTimerState = null;
  let phaseAdoptionCommitted = false;
  let phaseAdoptionStale = false;
  let pageTimerReadReceipt = null;
  let pageReadContext = null;
  const snapshotPageReadContext = () => Object.freeze({
    pwmState: schedule.pwmState,
    nextTriggerAt: Number(schedule.nextTriggerAt) || 0,
    onMinutes: Number(schedule.onMinutes) || 0,
    offMinutes: Number(schedule.offMinutes) || 0,
    mode: String(schedule.mode || ''),
    smartModeEnabled: schedule.smartMode?.enabled === true,
    smartModeSensitivity: Number(schedule.smartMode?.sensitivity) || 0,
    clockMode: !!schedule.clockMode,
    activeHours: JSON.stringify(schedule.activeHours || {}),
    comfortStartUntil: Number(schedule.comfortStartUntil) || 0
  });
  const refreshPageReadContext = () => {
    pageReadContext = snapshotPageReadContext();
  };
  const pageReadContextIsCurrent = () => (
    pageReadContext !== null
    && schedule.pwmState === pageReadContext.pwmState
    && Number(schedule.nextTriggerAt || 0) === pageReadContext.nextTriggerAt
    && Number(schedule.onMinutes || 0) === pageReadContext.onMinutes
    && Number(schedule.offMinutes || 0) === pageReadContext.offMinutes
    && String(schedule.mode || '') === pageReadContext.mode
    && (schedule.smartMode?.enabled === true)
      === pageReadContext.smartModeEnabled
    && (Number(schedule.smartMode?.sensitivity) || 0)
      === pageReadContext.smartModeSensitivity
    && (!!schedule.clockMode) === pageReadContext.clockMode
    && JSON.stringify(schedule.activeHours || {}) === pageReadContext.activeHours
    && Number(schedule.comfortStartUntil || 0)
      === pageReadContext.comfortStartUntil
  );
  const pageTimerStateIsCurrent = () => (
    phaseAdoptionPageTimerWriteOwner > 0
      ? (phaseAdoptionPageTimerState !== null
        && isPageTimerWriteOwnerCurrent(phaseAdoptionPageTimerWriteOwner))
      : isPageTimerReadReceiptCurrent(pageTimerReadReceipt)
  );
  const phaseOwnerIsCurrent = () => (
    isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && isAutomationOperationCurrent(automationRevision)
    && pageReadContextIsCurrent()
    && pageTimerStateIsCurrent()
  );
  const phasePwmPredecessorIsCurrent = () => (
    isPwmAlarmWriteGenerationCurrent(phaseAdoptionExpectedWriteGeneration)
  );
  const takePhasePageTimerWriteOwner = (owner, pageTimerState = undefined) => {
    const claimedOwner = owner;
    if (Number.isSafeInteger(claimedOwner) && claimedOwner > 0) {
      phaseAdoptionPageTimerWriteOwner = claimedOwner;
      phaseAdoptionPageTimerState = snapshotOwnedPageTimerState(
        claimedOwner,
        pageTimerState === undefined ? schedule : pageTimerState
      );
    }
  };
  const replayPhasePageTimerState = () => (
    phaseAdoptionPageTimerWriteOwner <= 0
      || (phaseAdoptionPageTimerState !== null
        && replayOwnedPageTimerState(phaseAdoptionPageTimerState))
  );
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
    refreshPageReadContext();
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    const tab = tabs.find(isACHomePageTab);
    if (!tab?.id) return false;

    pageTimerReadReceipt = await sendSerializedPageTimerRead(
      tab.id,
      { action: 'getPageTimer' }
    );
    if (pageTimerReadReceipt.stale
        || !isPageTimerReadReceiptCurrent(pageTimerReadReceipt)) return false;
    const result = pageTimerReadReceipt.result;
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
    const latestLivePwmAlarm = await chrome.alarms.get('ac-pwm');
    const latestRetryContext = getActiveSmartOnPwmRetryContext(
      schedule,
      latestLivePwmAlarm?.scheduledTime
    );
    const latestClockException = getOwnedSmartOnClockException(
      schedule,
      latestLivePwmAlarm?.scheduledTime,
      Date.now()
    );
    if (latestRetryContext.hasTypedSmartOnRetry
        || latestClockException.hasOwnedException
        || !pageReadContextIsCurrent()
        || !isPageTimerReadReceiptCurrent(pageTimerReadReceipt)) {
      console.log(`[AC扩展] page timer ↓ ${reason}: 页面读取期间 phase owner 已变化，放弃旧采纳计划`);
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
    phaseAdoptionExpectedWriteGeneration = pwmAlarmWriteGeneration;
    if (!phaseOwnerIsCurrent() || !phasePwmPredecessorIsCurrent()) {
      phaseAdoptionStale = true;
      return false;
    }

    // 采纳 page timer 值作为权威"关"时刻
    const oldTrigger = schedule.nextTriggerAt;
    clearPwmRetryState();
    setPwmClockIntent(adopt.nextTriggerAt);
    refreshPageReadContext();
    const phaseIntentState = snapshotPhaseAdoptionIntentState();

    // 重排 ac-pwm 闹钟到新时刻
    await persistSchedule(`page-timer-adopt-intent (${reason})`, {
      syncFromLiveAlarm: false
    });
    if (!phaseOwnerIsCurrent()
        || !phasePwmPredecessorIsCurrent()
        || !replayPhaseAdoptionIntentState(phaseIntentState)) {
      phaseAdoptionStale = true;
      throw new Error('页面相位 durable intent 已被后续 owner 接管');
    }
    const delayMs = adopt.nextTriggerAt - Date.now();
    if (delayMs > 0) {
      const clearAlarmWrite = await clearPwmAlarmWithReceipt(
        automationRevision,
        false,
        {
          expectedWriteGeneration: phaseAdoptionExpectedWriteGeneration,
          ensureCurrent: phaseOwnerIsCurrent
        }
      );
      phaseAdoptionWriteOwner = clearAlarmWrite.writeOwner;
      if (clearAlarmWrite.writeOwner > 0) {
        phaseAdoptionExpectedWriteGeneration = clearAlarmWrite.writeOwner;
      }
      if (!phaseOwnerIsCurrent()
          || !isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)) {
        phaseAdoptionStale = true;
        throw new Error('页面相位首次 clear 的 predecessor 已失效');
      }
      if (!clearAlarmWrite.cleared) {
        throw new Error(
          clearAlarmWrite.error || '页面相位清理旧 PWM 闹钟失败'
        );
      }
      const alarmFailureState = withPhaseAdoptionPageTimerError(
        phaseIntentState,
        '页面关机时间已采纳，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复'
      );
      const phaseCommit = await commitOwnedPwmAlarmPlan({
        plan: { nextTriggerAt: adopt.nextTriggerAt },
        logTag: 'page-timer-adopt',
        automationRevision,
        previousWriteOwner: clearAlarmWrite.writeOwner,
        plannedAt: phaseIntentState.clockIntentState.smartClockPlannedAt,
        isCurrent: phaseOwnerIsCurrent,
        onOwnedClockChanged: refreshPageReadContext,
        replayFailureState: () => replayPhaseAdoptionIntentState(
          alarmFailureState
        ),
        replaySuccessState: () => replayPhaseAdoptionIntentState(
          phaseIntentState,
          { replayClock: false }
        ),
        failurePersistReason: `page-timer-adopt-alarm-failed (${reason})`,
        successPersistReason: `page-timer-adopt (${reason})`
      });
      phaseAdoptionWriteOwner = phaseCommit.writeOwner
        || phaseAdoptionWriteOwner;
      if (phaseCommit.writeOwner > 0) {
        phaseAdoptionExpectedWriteGeneration = phaseCommit.writeOwner;
      }
      if (phaseCommit.stale) {
        phaseAdoptionStale = true;
        throw new Error('页面相位建钟提交已被后续 owner 接管');
      }
      phaseAdoptionCommitted = phaseCommit.persisted;
      if (!phaseCommit.created) {
        const failedPhaseIsCurrent = () => (
          phaseOwnerIsCurrent()
          && isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner)
        );
        await createAlarm('ac-watchdog', {
          delayInMinutes: 1,
          periodInMinutes: 5,
          ensureCurrent: failedPhaseIsCurrent
        });
        if (!failedPhaseIsCurrent()) {
          phaseAdoptionStale = true;
          return false;
        }
        queueDeferredScheduleRepair({
          smartOnExpectedBoundaryAt: pageAdoptionExpectedBoundaryAt,
          revokeInvalidSmartOnClock: pageAdoptionExpectedBoundaryAt > 0,
          revokeOwnerRevision: automationRevision,
          preserveRevokeAcrossSupersededRepair:
            pageAdoptionExpectedBoundaryAt > 0
        });
        return false;
      }
    } else {
      const clearAlarmWrite = await clearPwmAlarmWithReceipt(
        automationRevision,
        false,
        {
          expectedWriteGeneration: phaseAdoptionExpectedWriteGeneration,
          ensureCurrent: phaseOwnerIsCurrent
        }
      );
      phaseAdoptionWriteOwner = clearAlarmWrite.writeOwner;
      if (clearAlarmWrite.writeOwner > 0) {
        phaseAdoptionExpectedWriteGeneration = clearAlarmWrite.writeOwner;
      }
      if (!phaseOwnerIsCurrent()
          || !isPwmAlarmWriteOwnerCurrent(clearAlarmWrite.writeOwner)) {
        phaseAdoptionStale = true;
        throw new Error('页面过期相位 clear 的 predecessor 已失效');
      }
      if (!clearAlarmWrite.cleared) {
        throw new Error(
          clearAlarmWrite.error || '页面过期相位清理旧 PWM 闹钟失败'
        );
      }
      const advanceReceipt = await advanceExpiredAlarmToNextBoundary(
        adopt.nextTriggerAt,
        automationRevision,
        phaseAdmissionEpoch,
        {
          previousWriteOwner: clearAlarmWrite.writeOwner,
          ensureCurrent: phaseOwnerIsCurrent,
          isPageTimerStateCurrent: pageTimerStateIsCurrent,
          onPageTimerWriteOwnerClaimed: takePhasePageTimerWriteOwner,
          onOwnedPhaseStateChanged: refreshPageReadContext
        }
      );
      phaseAdoptionWriteOwner = Number(advanceReceipt.writeOwner)
        || phaseAdoptionWriteOwner;
      if (advanceReceipt.writeOwner > 0) {
        phaseAdoptionExpectedWriteGeneration = advanceReceipt.writeOwner;
      }
      takePhasePageTimerWriteOwner(
        advanceReceipt.pageTimerWriteOwner,
        advanceReceipt.pageTimerState ?? null
      );
      if (!replayPhasePageTimerState()) {
        phaseAdoptionStale = true;
        throw new Error('页面过期相位证明已被后续 owner 接管');
      }
      if (!advanceReceipt.advanced || !advanceReceipt.persisted) {
        throw new Error('页面过期相位未建立未来恢复时钟');
      }
      phaseAdoptionCommitted = true;
      if (!phaseOwnerIsCurrent()
          || !isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner)) {
        phaseAdoptionStale = true;
        throw new Error('页面过期相位恢复已被后续 owner 接管');
      }
    }

    const phaseCommitIsCurrent = () => (
      phaseOwnerIsCurrent()
      && phaseAdoptionCommitted
      && phaseAdoptionWriteOwner > 0
      && isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner)
    );
    if (!phaseCommitIsCurrent() || !replayPhasePageTimerState()) return false;
    let activeBoundaryError = null;
    try {
      await rescheduleActiveBoundary();
    } catch (error) {
      activeBoundaryError = error;
    }
    const activeHoursPaused = await abortStaleAutomation(
      automationRevision,
      'page-timer-adopt-active-hours-paused',
      { phaseAdmissionEpoch }
    );
    if (activeBoundaryError) throw activeBoundaryError;
    if (activeHoursPaused
        || !phaseCommitIsCurrent()
        || !replayPhasePageTimerState()) return false;
    // 把修正后的相位推回 sync——让仅靠 sync 的设备也间接对齐到 page timer 的时刻
    await syncScheduleToSync(`page-timer-adopt (${reason})`);
    if (await abortStaleAutomation(
      automationRevision,
      'page-timer-adopt-sync-active-hours-paused',
      { phaseAdmissionEpoch }
    ) || !phaseCommitIsCurrent()
      || !replayPhasePageTimerState()) return false;

    const oldStr = oldTrigger ? new Date(oldTrigger).toLocaleTimeString() : '无';
    console.log(`[AC扩展] page-timer ↓ ${reason}: 采纳 picker=${result.value} → nextTriggerAt=${new Date(adopt.nextTriggerAt).toLocaleTimeString()} (旧 ${oldStr}), 因=${adopt.reason}, pwmState=${schedule.pwmState}`);
    return true;
  } catch (e) {
    if (phaseAdmissionEpoch > 0) {
      const phaseWriteOwnerLost = phaseAdoptionWriteOwner > 0
        && !isPwmAlarmWriteOwnerCurrent(phaseAdoptionWriteOwner);
      if (phaseAdoptionCommitted
          && phaseOwnerIsCurrent()
          && !phaseWriteOwnerLost) {
        replayPhasePageTimerState();
        console.warn(`[AC扩展] page-timer ${reason} phase 已提交，后处理失败:`, e?.message);
        void appendDiagnosticLog('warn', 'page-timer-adopt-post-commit', e);
        return false;
      }
      if (!phaseOwnerIsCurrent()
          || phaseWriteOwnerLost
          || !phasePwmPredecessorIsCurrent()
          || phaseAdoptionStale) {
        phaseAdoptionStale = true;
        const replacementProof = await proveStableDurableLivePwmOwner(
          pwmRuntimeRevision,
          'page timer 新 phase owner'
        );
        if (!replacementProof.automationAllowed) {
          await abortStaleAutomation(
            automationRevision,
            'page-phase-owner-active-hours-paused',
            { phaseAdmissionEpoch }
          );
          return false;
        }
        const replacementRevision = replacementProof.automationRevision;
        if (replacementProof.stable && replacementProof.committed) {
          console.warn(`[AC扩展] page-timer ${reason} 后处理失败，但 phase 已由新 owner 接管:`, e?.message);
          void appendDiagnosticLog('warn', 'page-timer-adopt-post-owner', e);
          return false;
        }
        if (pageTimerStateIsCurrent()) {
          schedule.pageTimerError = `页面定时器相位的新 owner 未完成稳定 durable/live 收口：${e?.message || String(e)}；立即修复主钟`;
        }
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
      setPwmClockIntent(0);
      refreshPageReadContext();
      const failureState = snapshotPhaseAdoptionIntentState({
        allowMissingClock: true,
        pageTimerError: `页面定时器相位采纳未收口：${e?.message || String(e)}；立即修复主钟`
      });
      const failureIsCurrent = () => (
        phaseOwnerIsCurrent()
        && phasePwmPredecessorIsCurrent()
      );
      let failurePersisted = false;
      try {
        failurePersisted = await persistOwnedPwmAlarmFailure({
          isCurrent: failureIsCurrent,
          replayState: () => replayPhaseAdoptionIntentState(failureState),
          persistReason: `page-timer-adopt-error (${reason})`
        });
      } catch (persistError) {
        console.warn('[AC扩展] page timer 采纳失败态持久化失败，仍继续即时修复:', persistError?.message);
        void appendDiagnosticLog(
          'warn',
          'page-timer-adopt-failure-persist',
          persistError
        );
      }
      try {
        await createAlarm('ac-watchdog', {
          delayInMinutes: 1,
          periodInMinutes: 5,
          ensureCurrent: failureIsCurrent
        });
      } catch (watchdogError) {
        console.warn('[AC扩展] page timer 采纳失败后备看门狗创建失败:', watchdogError?.message);
      }
      if (!failureIsCurrent()) {
        phaseAdoptionStale = true;
        return false;
      }
      queueDeferredScheduleRepair({
        smartOnExpectedBoundaryAt: pageAdoptionExpectedBoundaryAt,
        revokeInvalidSmartOnClock: pageAdoptionExpectedBoundaryAt > 0,
        revokeOwnerRevision: automationRevision,
        preserveRevokeAcrossSupersededRepair:
          pageAdoptionExpectedBoundaryAt > 0
      });
      console.warn(
        `[AC扩展] page-timer ${reason} 采纳失败，已排队即时修复${failurePersisted ? '' : '（失败态未持久化）'}:`,
        e?.message
      );
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
  // watchdog 不是普通只读检查：过期/缺钟时会准备智能时长、写页面 timer、
  // 提交新 phase 与 live alarm。它必须和 sync/page/update/boundary 共用相位
  // admission；否则 popup 的 loadScheduleFromStorage 可在长页面 await 中把
  // durable 旧时长灌回，最终形成“旧时长 + 新边界”的拼接状态。
  const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) return;
  try {
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
      phaseAdmissionEpoch,
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
  } finally {
    releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
    drainDeferredScheduleRepair('watchdog-complete');
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
    const retryOwnerIsCurrent = () => (
      (Number(schedule.pageTimerRetryMinutes) || 0) === retryMinutes
      && (Number(schedule.pageTimerRetryAt) || 0) === retryAt
    );
    if (retryMinutes > 0) {
      if (retryAt > Date.now()) {
        const retryAlarmWrite = await writePageTimerRetryAlarm({
          action: 'create',
          when: retryAt,
          isCurrent: retryOwnerIsCurrent
        });
        if (retryAlarmWrite.stale) return;
      } else {
        const retryIntent = createPageTimerRetryIntent(retryMinutes);
        const retryState = await schedulePageTimerRetry(
          retryIntent,
          '启动恢复错过的页面定时器重试',
          retryOwnerIsCurrent
        );
        if (retryState.stale || !retryOwnerIsCurrent()) return;
        replaceSchedulePageTimerRetryState(schedule, retryState);
        await persistSchedule('init-recover-overdue-page-timer-retry', { syncFromLiveAlarm: false });
      }
    }
  }

  try {
    // 必须是 init 的第一项 I/O。pending manual OFF 在任何 sync/page/setup/
    // repair 恢复前先进入 fail-closed，并由下面的专用恢复事务收口。
    const startupRestorePromise = restoreDurableManualOffAdmission();
    startupManualOffAdmissionRestorePromise = startupRestorePromise;
    try {
      await startupRestorePromise;
    } finally {
      if (startupManualOffAdmissionRestorePromise
          === startupRestorePromise) {
        startupManualOffAdmissionRestorePromise = null;
      }
    }
    if (!await ensureSyncAuthorityDurableBaselineLoaded()) {
      await scheduleSyncRetry('adopt').catch(() => false);
    }
    // 版本变化时先清空遗留诊断日志，再继续 init（后续新异常正常追加）。
    await reconcileDiagnosticLogVersion();
    // 提取（Fowler Extract Function）：init 终极防线——间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
    async function syncFinalLiveAlarmOnInit() {
      // 终极防线：init 完成时，间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
      // 防止 SW 跑早期版本代码、setupAlarms 走重建路径、或某条 persist 漏 sync 时出现
      // "活闹钟在但 storage 缺绝对触发时间" 的红灯。init 末尾是端到端最后一道闭环。
      if (!isAutomationAllowed()) return;

      const phaseAdmissionEpoch =
        await claimSyncPhaseAdoptionAdmissionWhenAvailable();
      try {
        if (
          !isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
          || !isAutomationAllowed()
        ) {
          return;
        }
        const automationRevision = pwmRuntimeRevision;
        const finalLiveAlarm = await chrome.alarms.get('ac-pwm');
        const triggerPlan = await persistReconciledPwmTrigger(
          finalLiveAlarm,
          'init-finalSync',
          PWM_TRIGGER_NEXT_ONLY_OPTIONS,
          automationRevision,
          phaseAdmissionEpoch
        );
        if (triggerPlan) {
          console.log(`[AC扩展] init 末尾: 已从 live alarm 强制同步 nextTriggerAt=${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()}`);
        }
      } finally {
        releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
        drainDeferredScheduleRepair('init-final-sync-complete');
      }
    }

    // 加载 i18n 翻译（SW 上下文也需用 t() 做角标/标题）
    await I18n.load();
    await loadScheduleFromStorage();
    if (startupManualOffClassificationPending) {
      // manual OFF 是最高优先级的物理安全动作；它的 fresh 分类不能依赖
      // sync preflight。先恢复 marker/alarm-only OFF，再处理 F/T。
      await refreshManualOffAdmissionFromDurableCredentials();
    }
    if (manualOffAutomaticOnBlocked
        && manualOffAdmissionToken
        && manualOffAdmissionRestoredFromStorage) {
      await resumePendingManualOffAdmission('init-recovery');
    } else if (deferredSyncDisablePending
        && !startupDeferredDisableSupersededByUserIntent) {
      await runSerializedSchedulePhaseOperation(
        phaseAdmissionEpoch => settleDeferredSyncDisable(
          phaseAdmissionEpoch,
          { reason: 'init' }
        ),
        'init-deferred-sync-disable'
      );
      // synthetic startup block 的 fresh 分类可能在 settle 内恢复出唯一的
      // marker/alarm-only manual OFF。它优先于 F/T 后续处理，不能等下一次
      // periodic alarm（该 alarm 创建本身也可能曾失败）。
      if (manualOffAutomaticOnBlocked
          && manualOffAdmissionToken
          && manualOffAdmissionRestoredFromStorage) {
        await ensureManualOffAdmissionRetryAlarm(
          manualOffAdmissionToken,
          manualOffAdmissionRequestedAt
        ).catch(() => false);
        await resumePendingManualOffAdmission(
          'init-reclassified-recovery'
        );
      }
    }
    // marker 已恢复／收口后才创建自动运行时 alarm；pending 或读取失败时
    // createAlarm 自身继续 fail-closed，不能清除恢复证据后抢跑。
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await runSerializedSchedulePhaseOperation(
      phaseAdmissionEpoch => backfillNextTriggerAt(
        true,
        phaseAdmissionEpoch
      ),
      'init-backfill-next-trigger'
    );
    if (syncAuthorityDurableBaselineLoaded
        && schedule.enabled
        && !manualOffAutomaticOnBlocked
        && !isAutomationAllowed()) {
      await onActiveBoundaryCrossed();
    }
    // 上次本机 publish 若在 watermark/storage 瞬时失败中断，必须先重放
    // durable local intent，再考虑采纳 sync store；否则一次明确停用可被旧
    // enabled 快照覆盖且因为停用后无 PWM 活动而永久不再触发同步。
    if (!isStartupRestoreSupersededByUserIntent()
        && !startupDeferredDisableSupersededByUserIntent
        && !manualOffAutomaticOnBlocked
        && !deferredSyncDisablePending) {
      const pendingSyncPublish = await getSyncPublishPending();
      const pendingSyncPublishAlarm = await chrome.alarms.get(
        'ac-sync-publish-retry'
      );
      if (pendingSyncPublish === true || pendingSyncPublishAlarm) {
        await syncScheduleToSync('init-pending-publish');
      } else if (pendingSyncPublish === null) {
        await scheduleSyncRetry('publish');
      }
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
      await runSerializedSchedulePhaseOperation(
        () => runComfortStart('startup-recovery'),
        'startup-comfort-recovery'
      );
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
  const requestedPhaseAdmissionEpoch = Number(options.phaseAdmissionEpoch) || 0;
  const ownsBorrowedPhaseAdmission = isSyncPhaseAdoptionAdmissionOwnerCurrent(
    requestedPhaseAdmissionEpoch
  );
  if (requestedPhaseAdmissionEpoch > 0 && !ownsBorrowedPhaseAdmission) {
    return false;
  }
  const phaseAdmissionEpoch = ownsBorrowedPhaseAdmission
    ? requestedPhaseAdmissionEpoch
    : claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) return false;
  try {
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
    phaseAdmissionEpoch,
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
  } finally {
    if (!ownsBorrowedPhaseAdmission) {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair('setup-alarms-complete');
    }
  }
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
  if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
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
  const manualToggleIntentEpochAtAdmission = manualToggleIntentEpoch;
  const automaticOnActuatorIsCurrent = () => (
    isManualToggleIntentEpochCurrent(manualToggleIntentEpochAtAdmission)
    && !manualOffAutomaticOnBlocked
  );
  if (schedule.pwmState === 'on' && !automaticOnActuatorIsCurrent()) {
    console.warn('[AC扩展] 用户关机正在收口，拒绝旧自动 ON 事务入场');
    return;
  }
  const automationRevision = claimPwmStepOwnership();
  invalidateTimerBasedShutdown();
  const requestedScheduledTime = Number(scheduledTime);
  const pwmTriggerScheduledTime = Number.isFinite(requestedScheduledTime)
    && requestedScheduledTime > 0
    ? requestedScheduledTime
    : 0;
  const recoveringSmartCurrentCycle = recoveryPlan?.kind
    === 'recover-smart-current-cycle';
  let pwmExceptionRecoveryContext = null;

  function capturePwmExceptionRecoveryContext(smartRetry, smartOnWindow = undefined) {
    const triggerAt = pwmTriggerScheduledTime;
    const retryContext = smartRetry.isTyped
      ? {
          hasTypedSmartOnRetry: true,
          boundaryAt: smartRetry.boundaryAt,
          priorError: smartRetry.priorError
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

  function planSmartAutomaticOn(smartRetry, targetAction, acIsOn) {
    if (!(schedule.smartMode?.enabled && targetAction === 'on')) return null;
    return planSmartModeOnWindow(schedule, {
      maxOnMinutes: SMART_MODE.ON_MAX,
      acIsOn,
      boundaryAt: smartRetry.active
        ? smartRetry.boundaryAt
        : schedule.smartOnBoundaryAt,
      triggeredBoundaryAt: smartRetry.active
        ? smartRetry.boundaryAt
        : pwmTriggerScheduledTime,
      recoverCurrentCycle: smartRetry.active || recoveringSmartCurrentCycle
    });
  }

  // 提取（Fowler Extract Function）：应用智能 ON 窗口。只有 allow 路径保留
  // 原有的持久化 await；无窗口和 defer 路径同步返回，不新增控制权交还点。
  function prepareSmartOnWindow(plan, targetAction, observations, smartRetry) {
    const smartOnWindow = planSmartAutomaticOn(
      smartRetry,
      targetAction,
      observations.acIsOn
    );
    let persistence = null;
    let requiresPersistence = false;
    if (smartOnWindow?.kind === 'allow') {
      observations.smartPageTimerTargetAt = Number(smartOnWindow.pageTimerTargetAt);
      observations.smartOnWindowEndsAt = Number(smartOnWindow.windowEndsAt) || 0;
      schedule.smartOnBoundaryAt = Number(smartOnWindow.boundaryAt) || 0;
      requiresPersistence = true;
      persistence = persistSchedule('runPwmStep-smart-on-boundary', { syncFromLiveAlarm: false });
    } else {
      if (smartOnWindow) {
        schedule.smartOnBoundaryAt = 0;
        plan = smartOnWindow;
      }
    }
    return { plan, smartOnWindow, persistence, requiresPersistence };
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
        pageTimerTargetAt: observations.smartPageTimerTargetAt || 0,
        ensureCurrent: automaticOnActuatorIsCurrent
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
      'runPwmStep-retry-active-hours-paused',
      { phaseAdmissionEpoch }
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

  function prepareSmartCommitPlan(plan, targetAction) {
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

    return { plan, smartLocalExceptionBoundaryAt, smartLocalExceptionKind };
  }

  return waitUntil((async () => {
  try {
    await loadScheduleFromStorage();
    if (!isAutomationAllowed()) return;

    const smartRetryAdmission = classifyPwmSmartRetryAdmission(
      schedule,
      pwmTriggerScheduledTime
    );
    if (smartRetryAdmission.clearInvalidOwner) {
      clearPwmRetryState();
    }

    // typed retry 必须保留首败时已持久化的时长/相位；新半点天气只能由真正的
    // 新周期消费，不能在旧事务恢复期间先清 marker 或改写 pwmState。
    if (!smartRetryAdmission.isTyped) {
      const smartPreparedBoundaryAt = currentSmartControlBoundary(pwmTriggerScheduledTime);
      await applyPreparedSmartModeDurations({
        allowActiveOnPhase: recoveringSmartCurrentCycle,
        ...(smartPreparedBoundaryAt > 0 ? { boundaryAt: smartPreparedBoundaryAt } : {})
      });
    }
    // 到这里已消费本半点天气计划。异常恢复必须以此刻的 action/on/off 为准，
    // 不能回退到 shared executor 入场时的旧 12/18 或默认 30/30。
    capturePwmExceptionRecoveryContext(smartRetryAdmission);
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-weather-active-hours-paused',
      { phaseAdmissionEpoch }
    )) return;

    const smartRetryContext = activatePwmSmartRetryContext(
      smartRetryAdmission,
      schedule
    );

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
      capturePwmExceptionRecoveryContext(smartRetryContext);
      await clearPwmAlarm(automationRevision);
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-smart-current-cycle-active-hours-paused',
        { phaseAdmissionEpoch }
      )) return;
      setPwmClockIntent(0);
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
    if (smartRetryContext.isTyped && smartRetryContext.priorError) {
      schedule.pageTimerError = smartRetryContext.priorError;
    } else if (smartRetryContext.rejectedError) {
      schedule.pageTimerError = smartRetryContext.rejectedError;
    }

    console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);

    const preCheckStatus = await getCurrentACStatus();
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-status-active-hours-paused',
      { phaseAdmissionEpoch }
    )) return;
    observations.acIsOn = preCheckStatus?.isOn;
    if (targetAction === 'off') {
      observations.proofFresh = isPageTimerProofFresh(schedule);
    }
    plan = planPwmStep(schedule, observations);

    const smartOnWindowResolution = prepareSmartOnWindow(
      plan,
      targetAction,
      observations,
      smartRetryContext
    );
    if (smartOnWindowResolution.requiresPersistence) {
      await smartOnWindowResolution.persistence;
    }
    plan = smartOnWindowResolution.plan;
    capturePwmExceptionRecoveryContext(
      smartRetryContext,
      smartOnWindowResolution.smartOnWindow
    );

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
        'runPwmStep-toggle-active-hours-paused',
        { phaseAdmissionEpoch }
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
      if (smartRetryContext.isTyped) {
        schedule.pageTimerError = `本周期智能开机重试已超过安全关机余量：${smartRetryContext.priorError || '自动开启未确认'}；等待下一个半点`;
      } else if (smartRetryContext.rejectedError) {
        schedule.pageTimerError = smartRetryContext.rejectedError;
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
        'runPwmStep-deferred-active-hours-paused',
        { phaseAdmissionEpoch }
      )) return;
      await persistSchedule('runPwmStep-smart-on-deferred');
      await updateBadge();
      if (await abortStaleAutomation(
        automationRevision,
        'runPwmStep-deferred-sync-active-hours-paused',
        { phaseAdmissionEpoch }
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
        'runPwmStep-page-timer-active-hours-paused',
        { phaseAdmissionEpoch }
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
        'runPwmStep-short-timer-active-hours-paused',
        { phaseAdmissionEpoch }
      )) return;
    }

    if (plan.kind === 'retry') {
      await resolveRetryPlan(plan, observations, targetAction);
      return;
    }

    if (plan.kind !== 'commit') {
      throw new Error(`未处理的 PWM plan: ${plan.kind}/${plan.reason}`);
    }

    const smartCommit = prepareSmartCommitPlan(plan, targetAction);
    plan = smartCommit.plan;
    const {
      smartLocalExceptionBoundaryAt,
      smartLocalExceptionKind
    } = smartCommit;

    applyPwmPlanState(plan);
  if (await abortStaleAutomation(
    automationRevision,
    'runPwmStep-commit-active-hours-paused',
    { phaseAdmissionEpoch }
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
      'runPwmStep-persist-active-hours-paused',
      { phaseAdmissionEpoch }
    )) return;
    await persistSchedule('runPwmStep-interval');
    await updateBadge();

    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-sync-active-hours-paused',
      { phaseAdmissionEpoch }
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
  setPwmClockIntent(recoveryPlan.nextTriggerAt);

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
  setPwmClockIntent(recoveryPlan.nextTriggerAt);

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
  phaseAdmissionEpoch: requestedPhaseAdmissionEpoch = 0,
  source = 'pwm',
  beforeRun = null
} = {}) {
  const ownsBorrowedPhaseAdmission = isSyncPhaseAdoptionAdmissionOwnerCurrent(
    requestedPhaseAdmissionEpoch
  );
  if (requestedPhaseAdmissionEpoch > 0 && !ownsBorrowedPhaseAdmission) {
    return false;
  }
  const phaseAdmissionEpoch = ownsBorrowedPhaseAdmission
    ? requestedPhaseAdmissionEpoch
    : claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) return false;
  try {
  if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
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
    if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
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
    if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
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
      const proceed = await beforeRun({ phaseAdmissionEpoch });
      if (proceed === false) {
        diagnosticOutcomeStatus = 'skipped';
        diagnosticOutcomeReason = 'before-run-declined';
        return true;
      }
      if (Number.isSafeInteger(proceed?.automationRevision)) {
        continuationAutomationRevision = proceed.automationRevision;
      }
      if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
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
    if (await abortStaleAutomation(
      failedRevision,
      'pwm-exception-active-hours-paused',
      { phaseAdmissionEpoch }
    )) {
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
    const typedRecovery = await recoverTypedSmartOnAlarmException(
      alarm,
      error,
      failedRevision,
      Date.now(),
      recoveryRetryContext
    );
    if (await abortStaleAutomation(
      failedRevision,
      'pwm-typed-recovery-active-hours-paused',
      { phaseAdmissionEpoch }
    )) {
      diagnosticOutcomeStatus = 'stale';
      diagnosticOutcomeReason = 'typed-recovery-owner-revoked';
      return false;
    }
    if (typedRecovery) {
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
    if (await abortStaleAutomation(
      failedRevision,
      'pwm-generic-recovery-active-hours-paused',
      { phaseAdmissionEpoch }
    )) {
      diagnosticOutcomeStatus = 'stale';
      diagnosticOutcomeReason = 'generic-recovery-owner-revoked';
      return false;
    }
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
  } finally {
    if (!ownsBorrowedPhaseAdmission) {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair('pwm-executor-phase-complete');
    }
  }
}

// 通过新鲜页面确认 Power-off after 已离开当前 React 状态并真正持久化。
// 写入来源页无论是用户页还是扩展自建隐藏页都不能刷新：过早导航可能中断 UST
// 的异步提交。每次读回都新建临时隐藏页，按退避窗口等待服务器落盘后再验证。
async function verifyPageTimerPersistence(
  expectedValue,
  {
    automationRevision = null,
    shutdownRevision = null,
    ensureCurrent = null
  } = {}
) {
  let lastActualValue = '';
  let lastFailure = '';
  const persistenceWriteIsCurrent = () => (
    automationRevision === null
      || isAutomationOperationCurrent(automationRevision)
  ) && (
    shutdownRevision === null
      || isTimerBasedShutdownCurrent(shutdownRevision)
  ) && (
    typeof ensureCurrent !== 'function' || ensureCurrent()
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
function createPageTimerRetryIntent(minutes) {
  return Object.freeze({
    retryMinutes: Math.max(1, sanitizeMinutes(minutes, 1)),
    retryAt: Date.now() + 60 * 1000
  });
}

async function schedulePageTimerRetry(
  retryState,
  reason = '',
  isCurrent = () => true
) {
  const retryMinutes = retryState.retryMinutes;
  const retryAt = retryState.retryAt;
  const staleResult = () => ({
    stale: true,
    retryMinutes,
    retryAt,
    alarmCreated: false
  });
  const retryAlarmWrite = await writePageTimerRetryAlarm({
    action: 'replace',
    when: retryAt,
    isCurrent
  });
  if (retryAlarmWrite.stale) return staleResult();
  console.warn(`[AC扩展] 页面定时器将于 1 分钟后重试（${retryMinutes} 分钟，${reason || '未说明原因'}）`);
  return {
    stale: false,
    retryMinutes,
    retryAt,
    alarmCreated: retryAlarmWrite.alarmCreated
  };
}

let pageTimerMessageWriteChain = Promise.resolve();
let pageTimerWriteGeneration = 0;
let pageTimerWritesInFlight = 0;

function claimPageTimerWriteOwner(isLifecycleCurrent) {
  if (!isLifecycleCurrent()) return 0;
  pageTimerWriteGeneration += 1;
  return pageTimerWriteGeneration;
}

function invalidatePageTimerWriteOwner() {
  pageTimerWriteGeneration += 1;
  return pageTimerWriteGeneration;
}

function isPageTimerWriteOwnerCurrent(owner) {
  return owner > 0 && owner === pageTimerWriteGeneration;
}

function claimPageTimerWriteLease(isLifecycleCurrent) {
  if (typeof isLifecycleCurrent !== 'function') {
    throw new TypeError('页面定时器 writer lease 缺少 lifecycle guard');
  }
  const owner = claimPageTimerWriteOwner(isLifecycleCurrent);
  if (owner <= 0) return null;
  pageTimerWritesInFlight += 1;
  let released = false;
  return Object.freeze({
    owner,
    isCurrent: () => (
      !released
      && isPageTimerWriteOwnerCurrent(owner)
      && isLifecycleCurrent()
    ),
    release: () => {
      if (released) return false;
      released = true;
      pageTimerWritesInFlight = Math.max(0, pageTimerWritesInFlight - 1);
      return true;
    }
  });
}

function isPageTimerReadReceiptCurrent(receipt) {
  return Number.isSafeInteger(receipt?.pageTimerWriteGeneration)
    && receipt.pageTimerWriteGeneration === pageTimerWriteGeneration
    && pageTimerWritesInFlight === 0;
}

// Page timer adoption is a passive read, so readiness recovery / reinjection
// must not occupy the safety-critical writer FIFO.  Exact generation checks on
// both sides make a concurrent writer invalidate this read without waiting for
// the passive probe to finish.
async function sendSerializedPageTimerRead(tabId, message) {
  const pageTimerWriteGenerationAtRead = pageTimerWriteGeneration;
  const staleResult = () => Object.freeze({
    result: null,
    stale: true,
    pageTimerWriteGeneration: pageTimerWriteGenerationAtRead
  });
  if (pageTimerWritesInFlight > 0) return staleResult();
  const result = await sendReadMessageToExactACHome(tabId, message);
  if (pageTimerWriteGenerationAtRead !== pageTimerWriteGeneration
      || pageTimerWritesInFlight > 0) return staleResult();
  return Object.freeze({
    result,
    stale: false,
    pageTimerWriteGeneration: pageTimerWriteGenerationAtRead
  });
}

function createOwnedPageTimerStateReceipt(pageTimerWriteOwner, state) {
  if (!isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)) return null;
  return Object.freeze({
    pageTimerMinutes: state.minutes ?? null,
    pageTimerTargetAt: Number(state.targetAt) || 0,
    pageTimerError: state.error ?? '',
    pageTimerRetryAt: Number(state.retryAt) || 0,
    pageTimerRetryMinutes: Number(state.retryMinutes) || 0,
    pageTimerWriteOwner: Number(pageTimerWriteOwner)
  });
}

function snapshotOwnedPageTimerState(
  pageTimerWriteOwner,
  source = schedule
) {
  if (!source || typeof source !== 'object') return null;
  if (source?.pageTimerWriteOwner !== undefined
      && source.pageTimerWriteOwner !== pageTimerWriteOwner) {
    return null;
  }
  return createOwnedPageTimerStateReceipt(pageTimerWriteOwner, {
    minutes: source?.pageTimerMinutes,
    targetAt: source?.pageTimerTargetAt,
    error: source?.pageTimerError,
    retryAt: source?.pageTimerRetryAt,
    retryMinutes: source?.pageTimerRetryMinutes
  });
}

function replayOwnedPageTimerState(pageTimerState) {
  if (!isPageTimerWriteOwnerCurrent(pageTimerState?.pageTimerWriteOwner)) {
    return false;
  }
  replaceSchedulePageTimerState(schedule, {
    minutes: pageTimerState.pageTimerMinutes,
    targetAt: pageTimerState.pageTimerTargetAt,
    error: pageTimerState.pageTimerError,
    retryAt: pageTimerState.pageTimerRetryAt,
    retryMinutes: pageTimerState.pageTimerRetryMinutes
  });
  return true;
}

function sendSerializedPageTimerMessage(
  tabId,
  message,
  automationRevision = null,
  shutdownRevision = null,
  pageTimerWriteOwner = 0,
  ensureCurrent = null
) {
  const pageTimerWriteIsCurrent = () => (
    (pageTimerWriteOwner <= 0
      || isPageTimerWriteOwnerCurrent(pageTimerWriteOwner))
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  const stalePageTimerResult = () => ({
    success: false,
    pageTimerStale: true,
    error: '页面定时器请求已被后续请求替代'
  });
  const serializedMessageIsCurrent = () => (
    pageTimerWriteIsCurrent()
    && (automationRevision === null
      || isAutomationOperationCurrent(automationRevision))
    && (shutdownRevision === null
      || isTimerBasedShutdownCurrent(shutdownRevision))
  );
  const classifyStaleSerializedMessage = () => {
    if (!pageTimerWriteIsCurrent()) return stalePageTimerResult();
    if (automationRevision !== null
        && !isAutomationOperationCurrent(automationRevision)) {
      return { success: false, automationStale: true, error: '自动控制已暂停' };
    }
    if (shutdownRevision !== null
        && !isTimerBasedShutdownCurrent(shutdownRevision)) {
      return { success: false, shutdownStale: true, error: '关机请求已失效' };
    }
    return { success: false, messageStale: true, error: '页面消息请求已失效' };
  };
  const operation = pageTimerMessageWriteChain
    .catch(() => {})
    .then(async () => {
      // 必须在串行队列内部复核；旧 writer 可能在等待 tab/content 时被新 writer 抢占，
      // 随后才排到新 writer 后面。若只在入队前检查，真实页面会被旧 timer 覆盖。
      if (!pageTimerWriteIsCurrent()) return stalePageTimerResult();
      if (automationRevision !== null
          && !isAutomationOperationCurrent(automationRevision)) {
        return { success: false, automationStale: true, error: '自动控制已暂停' };
      }
      if (shutdownRevision !== null
          && !isTimerBasedShutdownCurrent(shutdownRevision)) {
        return { success: false, shutdownStale: true, error: '关机请求已失效' };
      }
      const result = await sendMessageToExactACHome(tabId, message, {
        // getExactACHomeTab() itself awaits chrome.tabs.get(). A newer page
        // writer may take ownership during that await, so the low-level sender
        // must repeat this guard immediately before the physical sendMessage.
        ensureCurrent: serializedMessageIsCurrent
      });
      if (result?.messageStale === true) {
        return classifyStaleSerializedMessage();
      }
      if (!pageTimerWriteIsCurrent()) return stalePageTimerResult();
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
    shutdownRevision = null,
    pageTimerWriteOwner = 0,
    ensureCurrent = null
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
  }, automationRevision, shutdownRevision, pageTimerWriteOwner, ensureCurrent);
  if (result?.pageTimerStale
      || result?.automationStale
      || result?.shutdownStale
      || !result?.success) {
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
    shutdownRevision = null,
    ensureCurrent = null,
    onWriteOwnerClaimed = null
  } = {}
) {
  const runtimeOwnerRevision = pwmRuntimeRevision;
  let pageTimerWriteOwner = 0;
  let pageTimerWriteLease = null;
  let terminalFinalizerStarted = false;
  let autoCreatedTabId = null;

  const staleAutomationResult = () => ({
    success: false,
    automationStale: true,
    shutdownStale: shutdownRevision !== null,
    error: shutdownRevision !== null ? '关机请求已失效' : '自动控制已暂停',
    pageTimerWriteOwner
  });

  const lifecycleWriteIsCurrent = () => (
    automationRevision === null
      || isAutomationOperationCurrent(automationRevision)
  ) && (
    shutdownRevision === null
      || isTimerBasedShutdownCurrent(shutdownRevision)
  ) && (
    automationRevision !== null
      || shutdownRevision !== null
      || pwmRuntimeRevision === runtimeOwnerRevision
  ) && (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );

  const automationWriteIsCurrent = () => (
    isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
    && lifecycleWriteIsCurrent()
  );

  const finishFailure = async (failure, reason) => {
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    const pageTimerError = failure.error || t('bgPageTimerFailed');
    const previousPageTimerState = {
      minutes: schedule.pageTimerMinutes,
      targetAt: schedule.pageTimerTargetAt,
      error: schedule.pageTimerError,
      retryAt: schedule.pageTimerRetryAt,
      retryMinutes: schedule.pageTimerRetryMinutes
    };
    let retryState = retryOnFailure
      ? createPageTimerRetryIntent(minutes)
      : {};
    // 同步失效旧 proof，避免 alarm await 窗口被其他关机请求误当成新鲜证明复用。
    recordSchedulePageTimerFailureState(schedule, pageTimerError, retryState);
    const pageTimerStateMatches = state => (
      schedule.pageTimerMinutes === state.minutes
      && schedule.pageTimerTargetAt === state.targetAt
      && schedule.pageTimerError === state.error
      && schedule.pageTimerRetryAt === state.retryAt
      && schedule.pageTimerRetryMinutes === state.retryMinutes
    );
    const failureStateIsCurrent = () => automationWriteIsCurrent() && (
      automationRevision !== null
      || shutdownRevision !== null
      || pageTimerStateMatches(previousPageTimerState)
      || pageTimerStateMatches({
        minutes: null,
        targetAt: 0,
        error: pageTimerError,
        retryAt: retryState.retryAt ?? 0,
        retryMinutes: retryState.retryMinutes ?? 0
      })
    );

    if (retryOnFailure) {
      const retryResult = await schedulePageTimerRetry(
        retryState,
        reason,
        failureStateIsCurrent
      );
      if (retryResult.stale) return staleAutomationResult();
      retryState = retryResult;
    } else {
      const retryAlarmClear = await writePageTimerRetryAlarm({
        action: 'clear',
        isCurrent: failureStateIsCurrent
      });
      if (retryAlarmClear.stale) return staleAutomationResult();
    }

    if (!failureStateIsCurrent()) return staleAutomationResult();
    recordSchedulePageTimerFailureState(schedule, pageTimerError, retryState);
    const pageTimerState = createOwnedPageTimerStateReceipt(
      pageTimerWriteOwner,
      {
        minutes: null,
        targetAt: 0,
        error: pageTimerError,
        retryAt: retryState.retryAt,
        retryMinutes: retryState.retryMinutes
      }
    );
    if (!pageTimerState) return staleAutomationResult();
    // 页面 failure 只拥有 pageTimer*；PWM 主钟由外围 phase transaction 对账。
    await persistSchedule(`setPageTimer-${reason}`, { syncFromLiveAlarm: false });
    if (!automationWriteIsCurrent()
        || !replayOwnedPageTimerState(pageTimerState)) {
      return staleAutomationResult();
    }
    console.warn('[AC扩展] 页面定时器设置失败:', pageTimerError);
    return { ...failure, pageTimerWriteOwner, pageTimerState };
  };

  // 提取（Fowler Extract Function）：页面定时器成功后的证明记录——解析目标时刻、清重试态、持久化并回传验证结果。
  const recordPageTimerProof = async (result, minutes, verification) => {
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    const proofMinutes = result.actualDelayMinutes || minutes;
    const targetAt = Number(result.targetAt);
    if (!Number.isSafeInteger(targetAt) || targetAt <= Date.now()) {
      return finishFailure({
        success: false,
        error: '页面定时器未返回有效的未来绝对目标时间'
      }, 'invalid-target');
    }
    const retryAlarmClear = await writePageTimerRetryAlarm({
      action: 'clear',
      isCurrent: automationWriteIsCurrent
    });
    if (retryAlarmClear.stale) return staleAutomationResult();
    if (!automationWriteIsCurrent()) return staleAutomationResult();
    recordSchedulePageTimerProofState(
      schedule,
      proofMinutes,
      targetAt
    );
    const pageTimerState = createOwnedPageTimerStateReceipt(
      pageTimerWriteOwner,
      {
        minutes: proofMinutes,
        targetAt,
        error: '',
        retryAt: 0,
        retryMinutes: 0
      }
    );
    if (!pageTimerState) return staleAutomationResult();
    // 页面 proof 只拥有 pageTimer*；PWM 主钟由外围 phase transaction 对账。
    await persistSchedule('setPageTimer-success', { syncFromLiveAlarm: false });
    if (!automationWriteIsCurrent()
        || !replayOwnedPageTimerState(pageTimerState)) {
      return staleAutomationResult();
    }
    console.log(`[AC扩展] 页面定时器已由新鲜页面确认: ${verification.value} (安全网)`);
    return {
      ...result,
      verified: true,
      verification,
      pageTimerWriteOwner,
      pageTimerState
    };
  };

  const finalizeFailure = async (failure, reason) => {
    terminalFinalizerStarted = true;
    return finishFailure(failure, reason);
  };

  const finalizeProof = async (result, requestedMinutes, verification) => {
    terminalFinalizerStarted = true;
    return recordPageTimerProof(result, requestedMinutes, verification);
  };

  try {
    // 失效 lifecycle 不得仅凭一次调用就抢占正在运行的有效 page-timer writer。
    pageTimerWriteLease = claimPageTimerWriteLease(lifecycleWriteIsCurrent);
    if (!pageTimerWriteLease) return staleAutomationResult();
    pageTimerWriteOwner = pageTimerWriteLease.owner;
    if (typeof onWriteOwnerClaimed === 'function') {
      onWriteOwnerClaimed(pageTimerWriteOwner);
    }
    let tab = Number.isInteger(preferredTabId)
      ? await getExactACHomeTab(preferredTabId)
      : null;
    if (Number.isInteger(preferredTabId) && (!tab || tab.discarded)) {
      throw new Error('指定的页面定时器标签已离开精确 home URL');
    }
    if (!automationWriteIsCurrent()) return staleAutomationResult();

    if (!tab) {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
      if (!automationWriteIsCurrent()) return staleAutomationResult();
      tab = tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded) || null;
    }

    if (!tab?.id) {
      tab = await chrome.tabs.create({ url: AC_PAGE, active: false });
      autoCreatedTabId = tab?.id || null;
      if (!autoCreatedTabId) throw new Error(t('bgPageTimerNoTab'));
      console.log('[AC扩展] 页面定时器：无现有 AC 页面，已创建隐藏标签页');
    }
    if (!automationWriteIsCurrent()) return staleAutomationResult();

    const result = await writePageTimerOnExactHomeTab(tab.id, minutes, {
      targetAt,
      automationRevision,
      shutdownRevision,
      pageTimerWriteOwner,
      ensureCurrent
    });
    if (result?.pageTimerStale
        || result?.automationStale
        || result?.shutdownStale) return { ...result, pageTimerWriteOwner };
    if (!result?.success) {
      return await finalizeFailure(
        result || { success: false, error: t('bgPageTimerFailed') },
        'failed'
      );
    }

    const expectedValue = String(result.value || '').trim();
    if (!expectedValue) {
      return await finalizeFailure(
        { success: false, error: '页面定时器未返回可验证的目标时间' },
        'empty-value'
      );
    }

    const verification = await verifyPageTimerPersistence(expectedValue, {
      automationRevision,
      shutdownRevision,
      ensureCurrent: automationWriteIsCurrent
    });
    if (verification.automationStale
        || verification.shutdownStale
        || !automationWriteIsCurrent()) {
      return staleAutomationResult();
    }
    if (!verification.success) {
      return await finalizeFailure({
        success: false,
        error: verification.error || '页面定时器新鲜页面验证后未确认'
      }, 'persistence-check-failed');
    }

    return await finalizeProof(result, minutes, verification);
  } catch (e) {
    // 终态 persistence 自身失败时不得再次进入 finishFailure，避免双写；但
    // 外层 finally 仍要等它真正 settle 后才释放 passive-read admission。
    if (terminalFinalizerStarted) throw e;
    return await finalizeFailure(
      { success: false, error: e?.message || String(e) },
      'exception'
    );
  } finally {
    pageTimerWriteLease?.release();
    if (autoCreatedTabId) {
      chrome.alarms.create(`ac-close-tab-${autoCreatedTabId}`, { delayInMinutes: 1 });
    }
  }
}

async function clearSupersededTimerBasedShutdownRetry() {
  const shutdownRevision = invalidateTimerBasedShutdown();
  replaceSchedulePageTimerRetryState(schedule);
  const retryAlarmClear = await writePageTimerRetryAlarm({
    action: 'clear',
    isCurrent: () => isTimerBasedShutdownCurrent(shutdownRevision)
  });
  if (retryAlarmClear.stale) return false;
  if (!isTimerBasedShutdownCurrent(shutdownRevision)) return false;
  replaceSchedulePageTimerRetryState(schedule);
  await persistSchedule(
    'clear-superseded-timer-based-shutdown-retry',
    { syncFromLiveAlarm: false }
  );
  return true;
}

function canReusePageTimerProof(state, requestedMinutes, now) {
  const targetAt = Number(state?.pageTimerTargetAt);
  const latestTargetAt = now + requestedMinutes * 60000 + 90000;
  return Number.isFinite(targetAt)
    && targetAt > now
    && targetAt <= latestTargetAt
    && isPageTimerProofFresh(state, { now });
}

async function persistOwnedPageTimerStateAgainstDurableSchedule(
  pageTimerState,
  reason = '',
  ensureCurrent = null
) {
  const pageTimerOwnerIsCurrent = () => (
    isPageTimerWriteOwnerCurrent(pageTimerState?.pageTimerWriteOwner)
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  if (!pageTimerOwnerIsCurrent()) return false;
  try {
    return await runSerializedCriticalLocalStateWrite(async () => {
      if (!pageTimerOwnerIsCurrent()) return false;
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (!pageTimerOwnerIsCurrent()) return false;
      const durableSchedule = stored?.[STORAGE_KEY];
      if (!durableSchedule || typeof durableSchedule !== 'object') {
        throw new Error('页面定时器字段提交时缺少 durable schedule');
      }
      const mergedSchedule = { ...durableSchedule };
      replaceSchedulePageTimerState(mergedSchedule, {
        minutes: pageTimerState.pageTimerMinutes,
        targetAt: pageTimerState.pageTimerTargetAt,
        error: pageTimerState.pageTimerError,
        retryAt: pageTimerState.pageTimerRetryAt,
        retryMinutes: pageTimerState.pageTimerRetryMinutes
      });
      if (!pageTimerOwnerIsCurrent()) return false;
      await chrome.storage.local.set({
        [STORAGE_KEY]: mergedSchedule
      });
      if (!pageTimerOwnerIsCurrent()) return false;
      return replayOwnedPageTimerState(pageTimerState);
    });
  } catch (error) {
    console.warn(
      `[AC扩展] ${reason || '页面定时器字段'} 持久化失败:`,
      error?.message
    );
    throw error;
  }
}

async function requestTimerBasedShutdown(
  reason = '',
  minutes = 1,
  { ensureCurrent = null } = {}
) {
  const shutdownRevision = claimTimerBasedShutdown();
  const shutdownIsCurrent = () => (
    isTimerBasedShutdownCurrent(shutdownRevision)
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  const staleShutdownResult = () => ({
    success: false,
    shutdownStale: true,
    error: '关机请求已失效',
    reason
  });
  if (!shutdownIsCurrent()) return staleShutdownResult();
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

  let pageTimerWriteOwner = clearPageTimerProofState();
  const retryAlarmClear = await writePageTimerRetryAlarm({
    action: 'clear',
    isCurrent: () => (
      shutdownIsCurrent()
      && isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
    )
  });
  if (retryAlarmClear.stale
      || !shutdownIsCurrent()
      || !isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)) {
    return staleShutdownResult();
  }
  pageTimerWriteOwner = clearPageTimerProofState();

  if (!shutdownIsCurrent()) return staleShutdownResult();
  const status = await getCurrentACStatus();
  if (!shutdownIsCurrent()
      || !isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)) {
    return staleShutdownResult();
  }
  pageTimerWriteOwner = clearPageTimerProofState();
  if (status?.isOn === false) {
    const clearedPageTimerState = snapshotOwnedPageTimerState(
      pageTimerWriteOwner
    );
    if (!clearedPageTimerState) return staleShutdownResult();
    const persisted = await persistOwnedPageTimerStateAgainstDurableSchedule(
      clearedPageTimerState,
      `${reason}-clear-stale-page-timer-proof`,
      shutdownIsCurrent
    );
    if (!persisted) return staleShutdownResult();
    return { success: true, alreadyDone: true, timerBased: true, reason };
  }

  const result = await setPageTimer(requestedMinutes, {
    shutdownRevision,
    ensureCurrent: shutdownIsCurrent
  });
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

function createScheduleReadRetryAlarmName(alarm, identityToken = '') {
  const originalName = String(alarm?.name || '');
  const originalScheduledTime = Math.max(
    1,
    Math.trunc(Number(alarm?.scheduledTime) || Date.now())
  );
  const originalPeriod = Math.max(
    0,
    Number(alarm?.periodInMinutes) || 0
  );
  const token = String(identityToken || '')
    || Math.random().toString(36).slice(2);
  return [
    SCHEDULE_READ_RETRY_ALARM,
    encodeURIComponent(originalName),
    originalScheduledTime,
    originalPeriod,
    token
  ].join(':');
}

function parseScheduleReadRetryAlarm(alarm) {
  const retryAlarmName = String(alarm?.name || '');
  const prefix = `${SCHEDULE_READ_RETRY_ALARM}:`;
  if (!retryAlarmName.startsWith(prefix)) return null;
  const [encodedName = '', scheduledTimeText = '', periodText = '', token = ''] =
    retryAlarmName.slice(prefix.length).split(':');
  let name = '';
  try {
    name = decodeURIComponent(encodedName);
  } catch (_) {
    return null;
  }
  const scheduledTime = Number(scheduledTimeText) || 0;
  const periodInMinutes = Number(periodText) || 0;
  if (!name || name.startsWith(`${SCHEDULE_READ_RETRY_ALARM}:`)
      || scheduledTime <= 0 || !token) return null;
  return Object.freeze({
    retryAlarmName,
    name,
    scheduledTime,
    periodInMinutes
  });
}

async function createScheduleReadRetryWake(
  alarm,
  reason = '',
  { identityToken = '' } = {}
) {
  const retryAlarmName = createScheduleReadRetryAlarmName(
    alarm,
    identityToken
  );
  const retryAt = Date.now() + 60_000;
  const created = await createAlarm(retryAlarmName, { when: retryAt });
  if (created) {
    console.warn(
      `[AC扩展] ${reason || 'schedule owner 暂不可读'}，保留 ${alarm.name}`
        + `@${Number(alarm.scheduledTime) || 0} 并在 1 分钟后重试`
    );
  }
  return created;
}

function captureScheduleReadRequeueReceipt(alarm, activeBoundaryRetry) {
  return Object.freeze({
    alarmName: String(alarm?.name || ''),
    scheduledTime: Number(alarm?.scheduledTime) || 0,
    localScheduleMutationGeneration,
    localScheduleAuthorityGeneration,
    schedulePersistenceAuthorityEpoch,
    syncPhaseAdoptionAdmissionEpoch,
    syncPhaseAdoptionAdmissionOwner,
    pwmRuntimeRevision,
    pwmAlarmWriteGeneration,
    pageTimerRetryAlarmWriteGeneration,
    pageTimerWriteGeneration,
    timerBasedShutdownRevision,
    activeBoundaryCompletionGeneration,
    activeBoundaryRetryAt: Number(activeBoundaryRetry?.retryAt) || 0,
    activeBoundaryRetryMode: String(activeBoundaryRetry?.mode || ''),
    activeBoundaryRetryBoundaryAt:
      Number(activeBoundaryRetry?.boundaryAt) || 0
  });
}

function isScheduleReadRequeueReceiptCurrent(receipt) {
  return !!receipt
    && receipt.localScheduleMutationGeneration
      === localScheduleMutationGeneration
    && receipt.localScheduleAuthorityGeneration
      === localScheduleAuthorityGeneration
    && receipt.schedulePersistenceAuthorityEpoch
      === schedulePersistenceAuthorityEpoch
    && receipt.syncPhaseAdoptionAdmissionEpoch
      === syncPhaseAdoptionAdmissionEpoch
    && receipt.syncPhaseAdoptionAdmissionOwner
      === syncPhaseAdoptionAdmissionOwner
    && receipt.pwmRuntimeRevision === pwmRuntimeRevision
    && receipt.pwmAlarmWriteGeneration === pwmAlarmWriteGeneration
    && receipt.pageTimerRetryAlarmWriteGeneration
      === pageTimerRetryAlarmWriteGeneration
    && receipt.pageTimerWriteGeneration === pageTimerWriteGeneration
    && receipt.timerBasedShutdownRevision === timerBasedShutdownRevision
    && receipt.activeBoundaryCompletionGeneration
      === activeBoundaryCompletionGeneration;
}

async function requeueAlarmAfterScheduleReadFailure(
  alarm,
  receipt
) {
  const alarmName = String(alarm?.name || '');
  if (!alarmName) return false;
  const activeBoundaryAlarm = alarmName === 'ac-active-boundary'
    || alarmName === ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM;
  const preserveOriginalDelivery = reason => (
    createScheduleReadRetryWake(alarm, reason)
  );
  const operation = async () => {
    if (!isScheduleReadRequeueReceiptCurrent(receipt)) {
      // broad M/phase counters can be transient claims whose writer later fails.
      // 独立 typed wake 不覆盖任何新 owner，让下一次按原 deliveryAt 复判。
      return preserveOriginalDelivery(
        `${alarmName} owner 在读取期间变化`
      );
    }
    if (activeBoundaryAlarm) {
      const durableRetry = await readDurableActiveBoundaryRetry();
      if (!isScheduleReadRequeueReceiptCurrent(receipt)) {
        return preserveOriginalDelivery(
          'active-boundary owner 在 durable 复读期间变化'
        );
      }
      if (!durableRetry.readOk) {
        return createScheduleReadRetryWake(
          alarm,
          'active-boundary durable owner 读取失败'
        );
      }
      const durableOwnerUnchanged =
        durableRetry.retryAt === receipt.activeBoundaryRetryAt
        && durableRetry.mode === receipt.activeBoundaryRetryMode
        && durableRetry.boundaryAt
          === receipt.activeBoundaryRetryBoundaryAt;
      if (!durableOwnerUnchanged) return true;
      const oppositeName = alarmName === ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM
        ? 'ac-active-boundary'
        : ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM;
      let sameAlarm;
      let oppositeAlarm;
      try {
        [sameAlarm, oppositeAlarm] = await Promise.all([
          chrome.alarms.get(alarmName),
          chrome.alarms.get(oppositeName)
        ]);
      } catch (_) {
        return createScheduleReadRetryWake(
          alarm,
          'active-boundary live owner 读取失败'
        );
      }
      if (!isScheduleReadRequeueReceiptCurrent(receipt)) {
        return preserveOriginalDelivery(
          'active-boundary owner 在 live 复读期间变化'
        );
      }
      const now = Date.now();
      if (Number(sameAlarm?.scheduledTime) > now
          || Number(oppositeAlarm?.scheduledTime) > now) {
        return true;
      }
    } else {
      let existing;
      try {
        existing = await chrome.alarms.get(alarmName);
      } catch (_) {
        // owner unknown 时只建独立 typed wake；绝不能把 unknown 当 absent
        // 并用同名 create 覆盖可能已经存在的新 owner。
        return createScheduleReadRetryWake(
          alarm,
          `${alarmName} live owner 读取失败`
        );
      }
      if (!isScheduleReadRequeueReceiptCurrent(receipt)) {
        return preserveOriginalDelivery(
          `${alarmName} owner 在 live 复读期间变化`
        );
      }
      if (Number(existing?.scheduledTime) > Date.now()) return true;
    }
    if (!isScheduleReadRequeueReceiptCurrent(receipt)) {
      return preserveOriginalDelivery(
        `${alarmName} owner 在最终重排前变化`
      );
    }
    return createScheduleReadRetryWake(
      alarm,
      `${alarmName} schedule 读取失败`
    );
  };

  try {
    if (activeBoundaryAlarm) {
      return !!await runSerializedActiveBoundaryMutation(operation);
    }
    if (alarmName === 'ac-pwm') {
      return !!await runSerializedPwmAlarmWrite(operation);
    }
    if (alarmName === PAGE_TIMER_RETRY_ALARM) {
      return !!await runSerializedPageTimerRetryAlarmWrite(operation);
    }
    return !!await operation();
  } catch (error) {
    console.warn(`[AC扩展] schedule 读取失败后续约 ${alarmName} 失败:`, error?.message);
    void appendDiagnosticLog(
      'error',
      'alarm-schedule-read-requeue',
      error
    );
    return false;
  }
}

// ----- 闹钟触发时执行 -----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Edge/Chrome 可能因为 alarm 唤醒 Service Worker。
  // 必须等 storage 恢复完成，否则 schedule.enabled 还是默认 false，会跳过自动关机。
  await initReady;
  const scheduleReadRetryIdentity = parseScheduleReadRetryAlarm(alarm);
  if (scheduleReadRetryIdentity) {
    // typed wake 只延后 owner 读取；语义处理继续使用原 alarm 身份/触发时刻。
    // 尤其 ac-pwm 不能伪装成 now+1min 的新边界，否则会把整个 OFF 周期延长。
    alarm = {
      ...alarm,
      name: scheduleReadRetryIdentity.name,
      scheduledTime: scheduleReadRetryIdentity.scheduledTime,
      ...(scheduleReadRetryIdentity.periodInMinutes > 0
        ? {
            periodInMinutes:
              scheduleReadRetryIdentity.periodInMinutes
          }
        : {}),
      scheduleReadRetryAlarmName:
        scheduleReadRetryIdentity.retryAlarmName
    };
  }
  const deferredDisableRetryIdentity =
    parseDeferredSyncDisableRetryAlarm(alarm);
  if (deferredDisableRetryIdentity) {
    if (deferredSyncDisablePending) {
      const currentDisableIdentity =
        getDeferredSyncDisableReceiptIdentity();
      const alarmDisableIdentity = getSyncPayloadIdentity(
        deferredDisableRetryIdentity.remote
      );
      const exactCurrentCredentialName =
        deferredSyncDisableRetryAlarmNames.has(
          deferredDisableRetryIdentity.name
        );
      const exactCurrentSafetyLineage =
        !deferredDisableRetryIdentity.safetyAuthorityId
        || deferredDisableRetryIdentity.safetyAuthorityId
          === deferredSyncDisableSafetyAuthorityId;
      const sameCurrentCredential =
        deferredDisableRetryIdentity.remote
        && exactCurrentCredentialName
        && exactCurrentSafetyLineage
        && deferredSyncDisableRemoteSnapshotComplete
        && alarmDisableIdentity === currentDisableIdentity;
      const sameCurrentLegacyCredential =
        !deferredDisableRetryIdentity.remote
        && !deferredSyncDisableRemoteSnapshotComplete
        && deferredDisableRetryIdentity.receivedAt
          === deferredSyncDisableObservedAt
        && exactCurrentCredentialName
        && exactCurrentSafetyLineage;
      if (!sameCurrentCredential
          && !sameCurrentLegacyCredential
          && !deferredSyncDisableReleasedRetryAlarmNames.has(
            deferredDisableRetryIdentity.name
          )) {
        // F2 无论 remote syncedAt 高低都是新的 safety arrival。先用它的
        // exact name/receivedAt 换 epoch；legacy F 保持 incomplete fail-close，
        // 后续 fresh sync preflight 才能补全 payload。
        deferredSyncDisableRetryAlarmNames.add(
          deferredDisableRetryIdentity.name
        );
        await deferRemoteSyncDisableWhileManualOffBlocked(
          deferredDisableRetryIdentity.remote
            || deferredSyncDisableRemoteSnapshot
            || { enabled: false, syncedAt: 0 },
          'deferred-sync-disable-alarm-merge',
          localScheduleAuthorityGeneration,
          {
            credentialReceivedAt:
              deferredDisableRetryIdentity.receivedAt,
            credentialRetryAlarmName:
              deferredDisableRetryIdentity.name,
            credentialSafetyAuthorityId:
              deferredDisableRetryIdentity.safetyAuthorityId,
            credentialAuthorityOrderObservedAt:
              deferredDisableRetryIdentity.authorityOrderObservedAt,
            credentialAuthorityPreBaselineSequence:
              deferredDisableRetryIdentity
                .authorityPreBaselineSequence,
            credentialRemoteComplete:
              !!deferredDisableRetryIdentity.remote,
            recoverFromRetryCredential: true
          }
        ).catch(error => {
          console.warn('[AC扩展] 后到 alarm-only remote disable 合并失败:', error?.message);
        });
      }
    }
    if (!deferredSyncDisablePending) {
      if (deferredSyncDisableReleasedRetryAlarmNames.has(
        deferredDisableRetryIdentity.name
      )) {
        await chrome.alarms.clear(deferredDisableRetryIdentity.name);
        deferredSyncDisableRetryAlarmNames.delete(
          deferredDisableRetryIdentity.name
        );
        // exact tombstone 必须保留；否则同名 residual alarm 可在 ABA 后复活。
        return;
      }
      if (deferredDisableRetryIdentity.remote
          && localTerminalAuthorityCoversRemoteDisable(
            deferredDisableRetryIdentity
          )) {
        // 只有 durable terminal user authority 才能覆盖迟显 F；普通 config
        // M 或仍在途/失败的 ON 没有 terminal receipt，必须继续恢复 F。
        // 判序只用 terminal receipt 已消费的 exact F alarm name；相同 payload
        // 也可能是 terminal 之后重放的新 F，不能跨 credential 去重。
        // 本机 receivedAt 与 remote syncedAt 都可能回拨，不能作范围淘汰。
        await tombstoneDeferredSyncDisableRetryIdentity(
          deferredDisableRetryIdentity,
          'deferred-sync-disable-terminal-user-predecessor'
        );
        return;
      }
      // getAll 之后才可见、或 record 写失败的 alarm 可能是唯一 F credential。
      // compact payload 可直接重建；legacy payload 仍代表 safety OFF，但不推进
      // remote watermark。先登记原 exact name，再创建新的 durable receipt。
      deferredSyncDisableRetryAlarmNames.add(
        deferredDisableRetryIdentity.name
      );
      await deferRemoteSyncDisableWhileManualOffBlocked(
        deferredDisableRetryIdentity.remote || {
          enabled: false,
          syncedAt: 0
        },
        'deferred-sync-disable-alarm-recover',
        localScheduleAuthorityGeneration,
        {
          credentialReceivedAt:
            deferredDisableRetryIdentity.receivedAt,
          credentialRetryAlarmName:
            deferredDisableRetryIdentity.name,
          credentialSafetyAuthorityId:
            deferredDisableRetryIdentity.safetyAuthorityId,
          credentialAuthorityOrderObservedAt:
            deferredDisableRetryIdentity.authorityOrderObservedAt,
          credentialAuthorityPreBaselineSequence:
            deferredDisableRetryIdentity.authorityPreBaselineSequence,
          credentialRemoteComplete:
            !!deferredDisableRetryIdentity.remote,
          recoverFromRetryCredential: true
        }
      ).catch(error => {
        console.warn('[AC扩展] alarm-only remote disable 恢复失败:', error?.message);
      });
    }
    await runSerializedSchedulePhaseOperation(
      phaseAdmissionEpoch => settleDeferredSyncDisable(
        phaseAdmissionEpoch,
        { reason: 'deferred-sync-disable-retry-alarm' }
      ),
      'deferred-sync-disable-retry-alarm'
    );
    return;
  }
  const deferredSuccessorRetryIdentity =
    parseDeferredSyncSuccessorRetryAlarm(alarm);
  if (deferredSuccessorRetryIdentity) {
    const retryEntry = deferredSyncSuccessorRetryAlarmEntries.get(
      deferredSuccessorRetryIdentity.name
    );
    if (deferredSyncSuccessorReleasedRetryAlarmNames.has(
      deferredSuccessorRetryIdentity.name
    )) {
      await tombstoneDeferredSyncSuccessorRetryIdentity(
        deferredSuccessorRetryIdentity,
        'deferred-sync-successor-exact-tombstone'
      );
      return;
    }
    const currentSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        deferredSyncDisableSafetyAuthorityId
      );
    const parsedPredecessorSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        deferredSuccessorRetryIdentity.predecessorSafetyAuthorityId
      );
    const registeredPredecessorSafetyAuthorityId =
      normalizeDeferredSyncDisableSafetyAuthorityId(
        retryEntry?.predecessorSafetyAuthorityId
      );
    const retryIdentityHasForeignLineage =
      deferredSyncDisablePending
      && [
        parsedPredecessorSafetyAuthorityId,
        registeredPredecessorSafetyAuthorityId
      ].some(safetyAuthorityId => (
        safetyAuthorityId
        && safetyAuthorityId !== currentSafetyAuthorityId
      ));
    if (retryIdentityHasForeignLineage) {
      // startup 可因 durable T mailbox 与 live alarm 精确匹配而预登记该
      // credential，但 coverage incomplete 时 successor 本身仍会被拒绝。
      // alarm delivery 也必须重新核对当前 F lineage，不能把“已登记”当作
      // current predecessor proof，否则 future-clock Tpre 会绕过 unknown
      // classifier 并从 retry path 复活。
      await tombstoneDeferredSyncSuccessorRetryIdentity(
        deferredSuccessorRetryIdentity,
        'deferred-sync-successor-registered-foreign-lineage'
      );
      return;
    }
    const pendingLocalMutationObservedAt = Number(
      localScheduleMutationObservedAtByGeneration.get(
        localScheduleMutationCommitPendingGeneration
      )
    ) || 0;
    const localMutationStillCommitting =
      localScheduleMutationCommitPendingGeneration > 0
      && pendingLocalMutationObservedAt > 0
      && localScheduleMutationCommittedObservedAt
        < pendingLocalMutationObservedAt;
    if (!retryEntry && localMutationStillCommitting) {
      // 未登记的 alarm 可能是旧 SW 的 future-clock T。M 尚未 durable 时
      // 既不能恢复它、也不能 tombstone；保留 periodic credential，等 M
      // 在同一原子提交中枚举 exact identity 后再决定。
      await Promise.allSettled([
        createDeferredSyncSuccessorClassificationWake(
          deferredSuccessorRetryIdentity,
          'local M committing unknown T lineage'
        ),
        scheduleSyncRetry('adopt')
      ]);
      return;
    }
    if (!retryEntry && deferredSyncDisablePending) {
      const classified =
        await classifyUnknownDeferredSyncSuccessorCredentials(
          [deferredSuccessorRetryIdentity],
          () => deferredSyncDisablePending,
          'deferred-sync-successor-alarm-unknown'
        ).catch(() => false);
      if (classified) {
        await tryAdoptSyncedState(
          'deferred-sync-successor-alarm-classified'
        );
      } else {
        await Promise.allSettled([
          createDeferredSyncSuccessorClassificationWake(
            deferredSuccessorRetryIdentity,
            'pending F unknown T classification retry'
          ),
          scheduleSyncRetry('adopt')
        ]);
      }
      return;
    }
    if (!retryEntry && !deferredSyncDisablePending) {
      const classified =
        await classifyUnknownDeferredSyncSuccessorAfterSafetyRelease(
          deferredSuccessorRetryIdentity,
          () => !deferredSyncDisablePending,
          'deferred-sync-successor-after-clear'
        ).catch(() => false);
      if (!classified) {
        await Promise.allSettled([
          createDeferredSyncSuccessorClassificationWake(
            deferredSuccessorRetryIdentity,
            'released F unknown T classification retry'
          ),
          scheduleSyncRetry('adopt')
        ]);
      }
      return;
    }
    const retryIdentityIsCurrent = !!retryEntry
      && deferredSuccessorRetryIdentity.name
        === deferredSyncDisableSuccessorRetryAlarmName
      && deferredSuccessorRetryIdentity.observedAt
        === deferredSyncDisableSuccessorObservedAt
      && getSyncPayloadIdentity(deferredSuccessorRetryIdentity.remote)
        === getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)
      && getSyncPayloadIdentity(retryEntry.remote)
        === getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot);
    const retryIdentityIsExactlyReleased =
      deferredSyncSuccessorReleasedRetryAlarmNames.has(
        deferredSuccessorRetryIdentity.name
      );
    const retryAuthorityOrderObservedAt = Number(
      retryEntry?.authorityOrderObservedAt
    ) || deferredSuccessorRetryIdentity.observedAt;
    const retryAuthorityTuple = retryEntry || {
      observedAt: deferredSuccessorRetryIdentity.observedAt,
      authorityOrderObservedAt:
        deferredSuccessorRetryIdentity.authorityOrderObservedAt,
      authorityPreBaselineSequence:
        deferredSuccessorRetryIdentity.authorityPreBaselineSequence
    };
    const retryIdentityIsReleased =
      retryIdentityIsExactlyReleased
      || (!deferredSyncDisableSyntheticReadFailure
        && isSyncAuthorityOrderTupleAtOrBefore(
          retryAuthorityTuple,
          {
            authorityOrderObservedAt:
              deferredSyncDisableAuthorityOrderObservedAt
              || deferredSyncDisableObservedAt,
            authorityPreBaselineSequence:
              deferredSyncDisableAuthorityPreBaselineSequence
          }
        ))
      || isSyncAuthorityOrderTupleAtOrBefore(
        retryAuthorityTuple,
        {
          authorityOrderObservedAt:
            deferredSyncSuccessorReleasedThroughObservedAt
        }
      )
      || isSyncAuthorityOrderTupleAtOrBefore(
        retryAuthorityTuple,
        {
          authorityOrderObservedAt:
            localScheduleMutationCommittedObservedAt
        }
      );
    if (retryIdentityIsExactlyReleased) {
      await tombstoneDeferredSyncSuccessorRetryIdentity(
        deferredSuccessorRetryIdentity,
        'deferred-sync-successor-released-alarm'
      );
      return;
    }
    if (retryIdentityIsCurrent) {
      // 只唤醒当前 durable mailbox；绝不把 alarm payload 当新 onChanged
      // 再登记一次，否则旧 T1 可被重赋 observedAt 后反转 T2。
      await tryAdoptSyncedState(
        'deferred-sync-successor-retry-alarm'
      );
      return;
    }
    const retryIdentityIsSupersededCredentialForCurrentSuccessor =
      !!deferredSyncDisableSuccessorSnapshot
      && deferredSuccessorRetryIdentity.name
        !== deferredSyncDisableSuccessorRetryAlarmName
      && deferredSuccessorRetryIdentity.observedAt
        === deferredSyncDisableSuccessorObservedAt
      && getSyncPayloadIdentity(deferredSuccessorRetryIdentity.remote)
        === getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot);
    if (retryIdentityIsSupersededCredentialForCurrentSuccessor) {
      await Promise.allSettled([
        createDeferredSyncSuccessorClassificationWake(
          deferredSuccessorRetryIdentity,
          'successor credential rebind pending'
        ),
        scheduleSyncRetry('adopt')
      ]);
      return;
    }
    if (retryIdentityIsReleased) {
      await tombstoneDeferredSyncSuccessorRetryIdentity(
        deferredSuccessorRetryIdentity,
        'deferred-sync-successor-released-cutoff-alarm'
      );
      return;
    }
    const hasNewerAuthority =
      (remoteSyncAuthorityObservedAt > retryAuthorityOrderObservedAt
        && isSyncAuthorityOrderTupleAtOrBefore(
          retryAuthorityTuple,
          { authorityOrderObservedAt: remoteSyncAuthorityObservedAt }
        ))
      || isSyncAuthorityOrderTupleAtOrBefore(
        retryAuthorityTuple,
        {
          authorityOrderObservedAt: localScheduleAuthorityObservedAt,
          authorityPreBaselineSequence:
            getSyncAuthorityPreBaselineSequence(
              localScheduleAuthorityObservedAt
            )
        }
      )
      || isSyncAuthorityOrderTupleAtOrBefore(
        retryAuthorityTuple,
        {
          authorityOrderObservedAt:
            localScheduleMutationCommittedObservedAt
        }
      );
    if (hasNewerAuthority) {
      await tombstoneDeferredSyncSuccessorRetryIdentity(
        deferredSuccessorRetryIdentity,
        'deferred-sync-successor-stale-alarm'
      );
      return;
    }
    // 极窄恢复窗：alarm 在 init 的 getAll 之后才变为可见，而主 mailbox
    // 写又失败。沿用 alarm 内 exact observedAt/name，不能生成新 authority。
    const recovered = rememberRemoteSyncSuccessorAfterDeferredDisable(
      deferredSuccessorRetryIdentity.remote,
      'deferred-sync-successor-alarm-recover',
      {
        credentialObservedAt: deferredSuccessorRetryIdentity.observedAt,
        credentialRetryAlarmName: deferredSuccessorRetryIdentity.name,
        credentialAuthorityOrderObservedAt:
          deferredSuccessorRetryIdentity.authorityOrderObservedAt,
        credentialAuthorityPreBaselineSequence:
          deferredSuccessorRetryIdentity.authorityPreBaselineSequence,
        recoverFromRetryCredential: true
      }
    );
    if (recovered) await recovered;
    await tryAdoptSyncedState(
      'deferred-sync-successor-retry-alarm-recovered'
    );
    return;
  }
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
    let sameAlarm;
    let oppositeAlarm;
    try {
      [sameAlarm, oppositeAlarm] = await Promise.all([
        chrome.alarms.get(alarm.name),
        chrome.alarms.get(oppositeAlarmName)
      ]);
    } catch (error) {
      await createScheduleReadRetryWake(
        alarm,
        'active-boundary live owner 暂不可读'
      ).catch(() => false);
      void appendDiagnosticLog(
        'warn',
        'alarm-active-boundary-live-owner-read',
        error
      );
      return;
    }
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
    const requeued = await createScheduleReadRetryWake(
      alarm,
      'active-boundary durable owner 暂不可读'
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
    } else if (alarm.name === 'ac-pwm') {
      // ac-pwm 是 one-shot owner；generic phase claim 并不承诺代执行这次
      // delivery。独立 typed wake 保留原 scheduledTime，phase 释放后再按
      // durable phase identity 判执行/过期，不能只记日志等 watchdog。
      await createScheduleReadRetryWake(
        alarm,
        'sync 相位接管占用 ac-pwm delivery'
      );
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
  const scheduleReadRequeueReceipt =
    captureScheduleReadRequeueReceipt(alarm, activeBoundaryRetry);
  try {
    await loadScheduleFromStorage();
  } catch (error) {
    const requeued = await requeueAlarmAfterScheduleReadFailure(
      alarm,
      scheduleReadRequeueReceipt
    );
    console.warn(
      `[AC扩展] 闹钟 ${alarm.name} 的 schedule 重读失败，${requeued ? '已续约' : '续约失败'}:`,
      error?.message
    );
    void appendDiagnosticLog('warn', 'alarm-schedule-read', error);
    return;
  }
  if (phaseSensitiveAlarm && isSyncPhaseAdoptionAdmissionBlocked()) {
    await deferPhaseSensitiveAlarm();
    return;
  }

  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);

  if (alarm.name === 'ac-sync-publish-retry') {
    if (manualOffAutomaticOnBlocked
        || deferredSyncDisablePending
        || isStartupRestoreSupersededByUserIntent()) {
      await scheduleSyncRetry('publish');
      return;
    }
    await syncScheduleToSync('alarm-sync-publish-retry');
    return;
  }

  if (alarm.name === 'ac-sync-adopt-retry') {
    if (deferredSyncDisableSyntheticReadFailure
        && deferredSyncDisablePending) {
      await repairCurrentDeferredSyncDisableDurableReceipt(
        deferredSyncDisableEpoch,
        getDeferredSyncDisableReceiptIdentity(),
        'alarm-sync-adopt-retry-synthetic-classification'
      );
      if (deferredSyncDisableSyntheticReadFailure) {
        await scheduleSyncRetry('adopt').catch(() => false);
        return;
      }
    }
    if (!await ensureSyncAuthorityDurableBaselineLoaded()) {
      await scheduleSyncRetry('adopt').catch(() => false);
      return;
    }
    await tryAdoptSyncedState('alarm-sync-adopt-retry');
    if (isAutomationAllowed()) {
      await setupAlarms();
      await Promise.allSettled([
        createAlarm('ac-badge-tick', { delayInMinutes: 1 }),
        createAlarm('ac-watchdog', { periodInMinutes: 5 })
      ]);
    } else if (schedule.enabled
        && !manualOffAutomaticOnBlocked
        && !deferredSyncDisablePending) {
      await onActiveBoundaryCrossed();
    }
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
      const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
      try {
        // badge 是低优先级校准；phase 忙时跳过本轮，不排队阻塞同步/用户更新。
        // self-claim 成功后把 live read + reconcile + durable persist 锁在同一 epoch。
        if (phaseAdmissionEpoch > 0) {
          const automationRevision = pwmRuntimeRevision;
          const liveAlarm = await chrome.alarms.get('ac-pwm');
          const triggerPlan = await persistReconciledPwmTrigger(
            liveAlarm,
            'badge-tick-sync',
            PWM_TRIGGER_NEXT_ONLY_OPTIONS,
            automationRevision,
            phaseAdmissionEpoch
          );
          if (triggerPlan) {
            console.log(`[AC扩展] badge-tick: 已同步 nextTriggerAt ← live alarm (${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()})`);
          }
        }
      } catch (e) {
        console.warn('[AC扩展] badge-tick 同步失败:', e?.message);
        void appendDiagnosticLog('warn', 'alarm-badge-tick', e);
      } finally {
        if (phaseAdmissionEpoch > 0) {
          releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
          drainDeferredScheduleRepair('badge-tick-sync-complete');
        }
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
      beforeRun: async ({ phaseAdmissionEpoch }) => {
      const comfortUntil = Number(schedule.comfortStartUntil) || 0;
      if (comfortUntil > 0) {
        const alarmAt = Number(alarm.scheduledTime) || Date.now();
        if (isComfortStartActive() && alarmAt + 1000 < comfortUntil) {
          let comfortRetryResult = null;
          try {
            // executor 已持有 phase admission。这里若再排 schedule queue，
            // 会与“schedule callback 等 phase owner”的 sync/update 路径互等。
            // 直接在同一 owner 下完成 comfort 前置事务，收口后才释放给队列。
            if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
              return false;
            }
            comfortRetryResult = await retryComfortStartAndFinishIfExpired('retry');
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
        if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
          return false;
        }
        const comfortEnd = await finishComfortStart('pwm-boundary');
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
      await runSerializedSchedulePhaseOperation(async (
        phaseAdmissionEpoch
      ) => {
        if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
          return { continuePwm: false };
        }
        const resumeComfortPwmIfNeeded = async (result) => {
          const comfortContinuationRevision = Number(
            result?.continuationAutomationRevision
          );
          if (!result?.continuePwm
              || !Number.isSafeInteger(comfortContinuationRevision)) {
            return result;
          }
          const resumed = await executePwmStepWithRecovery({
            automationRevision: comfortContinuationRevision,
            phaseAdmissionEpoch,
            source: 'alarm-comfort-end-resume'
          });
          return { ...result, resumed };
        };
        if (isComfortStartActive() && schedule.pwmState === 'on') {
          const retryResult = await retryComfortStartAndFinishIfExpired('retry');
          return resumeComfortPwmIfNeeded(retryResult);
        }
        const finishResult = await finishComfortStart('end-alarm');
        if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
          return { finishResult, continuePwm: false };
        }
        // main clock 必须在 finish 收口后、同一 phase owner 下复读。锁外预读
        // 可能漏掉刚创建的未来边界，随后 scheduledTime=0 会提前抢跑它。
        const comfortClockNow = Date.now();
        const livePwmAt = Number(
          (await chrome.alarms.get('ac-pwm'))?.scheduledTime
        ) || 0;
        if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
          return { finishResult, continuePwm: false };
        }
        const storedPwmAt = Number(schedule.nextTriggerAt) || 0;
        const futureMainClockAt = livePwmAt
            > comfortClockNow + PWM_RETRY_ALARM_TOLERANCE_MS
          ? livePwmAt
          : storedPwmAt > comfortClockNow + PWM_RETRY_ALARM_TOLERANCE_MS
            ? storedPwmAt
            : 0;
        const result = {
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
        return resumeComfortPwmIfNeeded(result);
      }, 'comfort-end');
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

  const manualOffRetryIdentity = parseManualOffRetryAlarm(alarm);
  if (manualOffRetryIdentity) {
    if (manualOffAutomaticOnBlocked
        && manualOffAdmissionToken === manualOffRetryIdentity.token
        && Number(manualOffAdmissionRequestedAt)
          === manualOffRetryIdentity.requestedAt) {
      await resumePendingManualOffAdmission('admission-retry');
    } else if (manualOffAdmissionPredecessorTokens.includes(
      manualOffRetryIdentity.token
    ) && !startupManualOffClassificationPending) {
      // startup 读取已被后到 user authority 抢占；predecessor alarm 只保留
      // 恢复凭证，不能猜测 action，也不能在 authority 失败时自我清除。
      // 已完成 authority 的 terminal write 若曾瞬断，则每次 periodic A
      // 都要重试 exact tombstone；不能因 predecessor fast-path 永久阻断。
      if (manualToggleIntentCompletedEpoch === manualToggleIntentEpoch
          && manualToggleIntentCompletedAction === manualToggleIntentAction) {
        await finalizeCompletedManualToggleAuthority(
          manualToggleIntentCompletedEpoch,
          manualToggleIntentCompletedAction,
          completedLocalTerminalAuthority?.observedAt
        ).catch(() => false);
      }
      return;
    } else {
      const classification =
        await refreshManualOffAdmissionFromDurableCredentials();
      if (classification.uncertain) return;
      if (classification.completedUserAuthority) {
        await finalizeCompletedManualToggleAuthority(
          manualToggleIntentCompletedEpoch,
          manualToggleIntentCompletedAction,
          completedLocalTerminalAuthority?.observedAt
        ).catch(() => false);
        return;
      }
      if (classification.superseded) return;
      if (manualOffAutomaticOnBlocked && manualOffAdmissionToken) {
        await resumePendingManualOffAdmission('admission-alarm-recover');
        return;
      }
      if (isManualOffRetryIdentityReleasedByMarker(
        manualOffRetryIdentity,
        classification.marker
      )) {
        await chrome.alarms.clear(alarm.name);
      }
    }
    return;
  }
  if (alarm.name === MANUAL_OFF_ADMISSION_RETRY_ALARM) {
    // 固定名 alarm 不携带 immutable generation，只能唤醒 fresh
    // marker/alarm 分类，不能用 scheduledTime 复活 OFF。
    const classification =
      await refreshManualOffAdmissionFromDurableCredentials();
    if (classification.uncertain) return;
    if (classification.completedUserAuthority
        || (manualToggleIntentCompletedEpoch === manualToggleIntentEpoch
          && manualToggleIntentCompletedAction
            === manualToggleIntentAction)) {
      const terminalized = await finalizeCompletedManualToggleAuthority(
        manualToggleIntentCompletedEpoch,
        manualToggleIntentCompletedAction,
        completedLocalTerminalAuthority?.observedAt
      ).catch(() => false);
      if (!terminalized) return;
    } else if (manualOffAutomaticOnBlocked && manualOffAdmissionToken) {
      await ensureManualOffAdmissionRetryAlarm(
        manualOffAdmissionToken,
        manualOffAdmissionRequestedAt
      ).catch(() => false);
      await resumePendingManualOffAdmission(
        'admission-classification-retry'
      );
    }
    await chrome.alarms.clear(alarm.name);
    return;
  }

  if (alarm.name === 'ac-page-timer-retry') {
    if (schedule.pageTimerRetryAt) {
      if (isAutomationAllowed()) {
        await clearSupersededTimerBasedShutdownRetry();
        return;
      }
      const retryResult = await requestTimerBasedShutdown(
        'page-timer-retry',
        1
      );
      if (retryResult?.success
          && manualOffAutomaticOnBlocked
          && manualOffAdmissionToken) {
        await resumePendingManualOffAdmission('page-timer-retry');
      }
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
      files: ['billing-helpers.js', 'ac-page-contract.js', 'content.js'],
      injectImmediately: true
    });
    if (!await getExactACHomeTab(tabId)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['ac-page-contract.js', 'page-confirm.js'],
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
    automationRevision = null,
    ensureCurrent = null
  } = {}
) {
  const messageIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  const staleMessageResult = () => ({
    success: false,
    messageStale: true,
    error: '消息请求已被后续请求替代'
  });
  if (!messageIsCurrent()) return staleMessageResult();
  const tab = await getExactACHomeTab(tabId);
  if (!messageIsCurrent()) return staleMessageResult();
  if (!tab) throw new Error('拒绝向非精确 AC home 标签发送消息');
  if (requireAutomationAllowed && message?.action === 'on') {
    const automaticOnIsCurrent = automationRevision === null
      ? isAutomationAllowed()
      : isAutomationOperationCurrent(automationRevision);
    if (!automaticOnIsCurrent) {
      throw new Error('运行时段外已暂停自动开启');
    }
  }

  // 此检查与 sendMessage 之间不得插入 await；它是 owner/revision 对物理
  // 页面副作用的最后一道门，而不只是队列层的逻辑完成检查。
  if (!messageIsCurrent()) return staleMessageResult();
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
    automationRevision = null,
    ensureCurrent = null
  } = {}
) {
  const timerMinutes = sanitizeMinutes(pageTimerMinutes, 0);
  const callerIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  if (!callerIsCurrent()) {
    return {
      success: false,
      pageTimerStale: true,
      pageTimerPrepared: false,
      error: '开机请求已被后续用户操作替代'
    };
  }
  if (!Number.isInteger(tab?.id) || timerMinutes <= 0) {
    return { success: false, pageTimerPrepared: false, error: '开机前页面定时器参数无效' };
  }

  const timerOptions = {
    retryOnFailure: false,
    targetAt: pageTimerTargetAt,
    preferredTabId: tab.id,
    automationRevision,
    ensureCurrent: callerIsCurrent
  };
  const initialStatus = await getACStatusFromExactHomeTab(tab.id);
  if (!callerIsCurrent()) {
    return {
      success: false,
      pageTimerStale: true,
      pageTimerPrepared: false,
      error: '开机请求已被后续用户操作替代'
    };
  }
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
  const provisionalRuntimeRevision = pwmRuntimeRevision;
  const provisionalLifecycleIsCurrent = () => (
    callerIsCurrent()
    && (automationRevision === null
      ? pwmRuntimeRevision === provisionalRuntimeRevision
      : isAutomationOperationCurrent(automationRevision))
  ) && (
    requireAutomationAllowed !== true
      || (automationRevision === null
        ? isAutomationAllowed()
        : isAutomationOperationCurrent(automationRevision))
  );
  const provisionalWriteLease = claimPageTimerWriteLease(
    provisionalLifecycleIsCurrent
  );
  if (!provisionalWriteLease) {
    return {
      success: false,
      pageTimerStale: true,
      pageTimerPrepared: false,
      error: '开机前页面关机定时器事务已失效'
    };
  }
  const provisionalWriteIsCurrent = provisionalWriteLease.isCurrent;
  const staleProvisionalResult = (prepared = false) => ({
    success: false,
    pageTimerStale: true,
    pageTimerPrepared: prepared,
    pageTimerWriteOwner: provisionalWriteLease.owner,
    error: '开机前页面关机定时器事务已被后续请求替代'
  });

  try {
    const preparedTimer = await writePageTimerOnExactHomeTab(tab.id, timerMinutes, {
      targetAt: pageTimerTargetAt,
      automationRevision,
      pageTimerWriteOwner: provisionalWriteLease.owner,
      ensureCurrent: provisionalWriteIsCurrent
    });
    if (!preparedTimer?.success) {
      return {
        success: false,
        pageTimerPrepared: false,
        error: preparedTimer?.error || '开机前页面关机定时器预置失败',
        preparedTimer
      };
    }
    if (!provisionalWriteIsCurrent()) return staleProvisionalResult(true);

    const exactTabAfterPrepare = await getExactACHomeTab(tab.id);
    if (!provisionalWriteIsCurrent()) return staleProvisionalResult(true);
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
      {
        notAfterAt,
        requireAutomationAllowed,
        automationRevision,
        pageTimerWriteOwner: provisionalWriteLease.owner,
        ensureCurrent: provisionalWriteIsCurrent
      }
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
    if (!provisionalWriteIsCurrent()) {
      return {
        ...staleProvisionalResult(true),
        actualOn,
        toggleSucceeded: actualOn,
        toggleAmbiguous,
        toggleResult
      };
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
  } finally {
    provisionalWriteLease.release();
  }
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
    pageTimerTargetAt = 0,
    ensureCurrent = null
  } = {}
) {
  const callerIsCurrent = () => (
    typeof ensureCurrent !== 'function' || ensureCurrent()
  );
  if (action === 'on') {
    await waitForManualOffCancellationToSettle();
  }
  if (!callerIsCurrent()) {
    return { success: false, requestStale: true, error: '开关请求已被后续用户操作替代' };
  }
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
  if (!callerIsCurrent()) {
    return { success: false, requestStale: true, error: '开关请求已被后续用户操作替代' };
  }
  while (activeAcToggleAttempt) {
    const predecessor = activeAcToggleAttempt;
    let predecessorIsCurrent = false;
    try {
      predecessorIsCurrent = typeof predecessor.ensureCurrent !== 'function'
        || predecessor.ensureCurrent();
    } catch (_) {
      predecessorIsCurrent = false;
    }
    if (predecessorIsCurrent
        && sameAcToggleRequest(predecessor.request, request)) {
      console.log(`[AC扩展] 合并重复的 toggleAC(${action}) 请求`);
      return predecessor.promise;
    }
    if (predecessorIsCurrent) {
      return {
        success: false,
        busy: true,
        error: `toggleAC(${predecessor.request.action}) 仍在执行，本次 ${action} 不重复点击`
      };
    }
    // 后到 user authority 已令 predecessor 失效；等待它完整退出 DOM/确认
    // 临界区，再以当前 owner 重新做真实状态预检。不能复用一个必然 stale
    // 的 Promise，也不能 busy-return 把最新 ON 吞掉。
    await predecessor.promise.catch(() => {});
    if (!callerIsCurrent()) {
      return { success: false, requestStale: true, error: '开关请求已被后续用户操作替代' };
    }
  }

  const attempt = {
    request,
    promise: toggleACOnce(action, {
      notAfterAt: request.notAfterAt,
      requireAutomationAllowed: request.requireAutomationAllowed,
      automationRevision: request.automationRevision,
      pageTimerMinutes: request.pageTimerMinutes,
      pageTimerTargetAt: request.pageTimerTargetAt,
      ensureCurrent: callerIsCurrent
    }),
    ensureCurrent: callerIsCurrent
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
  const callerIsCurrent = () => (
    typeof options?.ensureCurrent !== 'function' || options.ensureCurrent()
  );
  const staleToggleResult = () => ({
    success: false,
    requestStale: true,
    error: '开关请求已被后续用户操作替代'
  });
  if (!callerIsCurrent()) return staleToggleResult();
  const preparePageTimer = needOn && Number(options?.pageTimerMinutes) > 0;
  if (!preparePageTimer) {
    try {
      const preStatus = await getCurrentACStatus();
      if (!callerIsCurrent()) return staleToggleResult();
      if (typeof preStatus?.isOn === 'boolean' && preStatus.isOn === needOn) {
        console.log(`[AC扩展] 幂等预检：AC 已在目标状态 (${action})，跳过切换`);
        return { success: true, alreadyDone: true, action };
      }
    } catch (_) { /* 预检失败不影响主流程 */ }
  }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  if (!callerIsCurrent()) return staleToggleResult();
  const homeTab = tabs.find(tab => isACHomePageTab(tab) && !tab.discarded);

  if (homeTab?.id) {
    return waitUntil(_toggleOnExistingTab(homeTab, action, options));
  }

  console.log('[AC扩展] 没有精确 AC home 页面，创建隐藏标签...');
  const created = await chrome.tabs.create({ url: AC_PAGE, active: false });
  if (!callerIsCurrent()) {
    if (Number.isInteger(created?.id)) {
      chrome.alarms.create(`ac-close-tab-${created.id}`, { delayInMinutes: 1 });
    }
    return staleToggleResult();
  }
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
  const toggleMessage = {
    action,
    ...(notAfterAt > 0 ? { notAfterAt } : {})
  };
  const pageTimerWriteOwner = options?.pageTimerWriteOwner;
  const ensureCurrent = typeof options?.ensureCurrent === 'function'
    ? options.ensureCurrent
    : null;
  // 预置 timer 后的 ON 与所有后继 timer 写入共用同一 FIFO。后继 writer
  // 若在 ON 排队时抢占 owner，旧 ON 在真实发送前退出；若 ON 已发送，后继
  // timer 只能在它收口后落页，因此预置保险不会被并发写入提前拆掉。
  const result = Number.isSafeInteger(pageTimerWriteOwner)
      && pageTimerWriteOwner > 0
    ? await sendSerializedPageTimerMessage(
        tabId,
        toggleMessage,
        options?.automationRevision ?? null,
        null,
        pageTimerWriteOwner,
        ensureCurrent
      )
    : await sendMessageToExactACHome(tabId, toggleMessage, {
        requireAutomationAllowed: options?.requireAutomationAllowed === true,
        automationRevision: options?.automationRevision ?? null,
        ensureCurrent
      });
  console.log(`[AC扩展] ${action} 命令返回:`, result);
  if (!result?.success) {
    console.warn('[AC扩展] 页面返回未确认:', result);
    return {
      success: false,
      tabId,
      result,
      pageTimerStale: result?.pageTimerStale === true,
      automationStale: result?.automationStale === true,
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
  const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) return;
  let deferredExecution = null;
  let releaseAdmissionOnReturn = true;
  try {
    if (isComfortStartActive()) return;
    if (!isAutomationAllowed()) return;
    await backfillNextTriggerAt(false, phaseAdmissionEpoch);
    const now = Date.now();
    const existingAlarm = await chrome.alarms.get('ac-pwm');
    const rawAlarmAt = Number(existingAlarm?.scheduledTime) || 0;
    const liveAlarmAt = rawAlarmAt > now ? rawAlarmAt : 0;
    const storedAlarmAt = getStoredAlarmEndMs();
    const hasClock = storedAlarmAt > 0;
    const recovery = await recoverPwmLifecycle({
      source: 'ensureScheduleClock',
      phaseAdmissionEpoch,
      now,
      existingAlarm,
      liveAlarmAt,
      storedAlarmAt,
      expiredAlarmAt: rawAlarmAt > 0 && rawAlarmAt <= now ? rawAlarmAt : 0,
      plannedActionAt: liveAlarmAt || (storedAlarmAt > now ? storedAlarmAt : 0),
      missingClockAction: 'repair-clock',
      failureAction: hasClock ? 'execute-current' : 'repair-clock',
      deferSmartCurrentCycleExecution:
        options.deferSmartCurrentCycleExecution === true,
      onDeferredExecutionStarted: execution => {
        deferredExecution = execution;
      },
      preserveLiveReason: 'ensureScheduleClock: 同步现有 PWM 闹钟',
      restoreReason: 'PWM 主闹钟缺失，已按剩余时间补建'
    });
    if (deferredExecution) {
      releaseAdmissionOnReturn = false;
      const releaseAfterDeferredExecution = Promise.resolve(deferredExecution)
        .catch(() => {})
        .finally(() => {
          releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
          drainDeferredScheduleRepair('ensure-schedule-clock-deferred-complete');
        });
      void waitUntil(releaseAfterDeferredExecution);
    }
    return recovery;
  } finally {
    if (releaseAdmissionOnReturn) {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair('ensure-schedule-clock-complete');
    }
  }
}

async function repairScheduleClock(options = {}) {
  // repair 会在物理 ON 时写 Power-off after；pending manual OFF 已预约
  // 自己的 1 分钟 successor，generic repair 不得把它延长成普通 onMinutes。
  if (!isAutomationAllowed()) {
    return {
      success: false,
      deferred: manualOffAutomaticOnBlocked,
      reason: manualOffAutomaticOnBlocked
        ? '手动关机正在持久收口'
        : '自动控制未启用或在运行时段外暂停',
      schedule
    };
  }
  const requestedPhaseAdmissionEpoch = Number(options.phaseAdmissionEpoch) || 0;
  const ownsBorrowedPhaseAdmission = isSyncPhaseAdoptionAdmissionOwnerCurrent(
    requestedPhaseAdmissionEpoch
  );
  if (requestedPhaseAdmissionEpoch > 0 && !ownsBorrowedPhaseAdmission) {
    return {
      success: false,
      stale: true,
      reason: 'repair phase admission owner changed',
      schedule
    };
  }
  const phaseAdmissionEpoch = ownsBorrowedPhaseAdmission
    ? requestedPhaseAdmissionEpoch
    : claimSyncPhaseAdoptionAdmission();
  if (phaseAdmissionEpoch <= 0) {
    const deferredOptions = { ...options };
    delete deferredOptions.phaseAdmissionEpoch;
    queueDeferredScheduleRepair(deferredOptions);
    return {
      success: false,
      deferred: true,
      reason: 'phase admission in progress',
      schedule
    };
  }
  options = { ...options, phaseAdmissionEpoch };
  try {
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
  if (pwmExecutionWithRecoveryCount > 0 || isCurrentPwmStepRunning()) {
    const deferredOptions = { ...options };
    delete deferredOptions.phaseAdmissionEpoch;
    queueDeferredScheduleRepair(deferredOptions);
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
    phaseAdmissionEpoch,
    repairEpoch: requestedRepairEpoch
  };
  if (repairScheduleClock.inFlight) {
    const activeContext = repairScheduleClock.inFlightContext || {};
    if (activeContext.revokeInvalidSmartOnClock === true
        && repairContext.revokeInvalidSmartOnClock !== true) {
      return await repairScheduleClock.inFlight;
    }
    const sameContext = activeContext.automationRevision
        === repairContext.automationRevision
      && activeContext.smartOnExpectedBoundaryAt
        === repairContext.smartOnExpectedBoundaryAt
      && activeContext.revokeInvalidSmartOnClock
        === repairContext.revokeInvalidSmartOnClock
      && activeContext.phaseAdmissionEpoch
        === repairContext.phaseAdmissionEpoch
      && activeContext.repairEpoch === repairContext.repairEpoch;
    if (sameContext) return await repairScheduleClock.inFlight;

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
    return await repairScheduleClock.trailingPromise;
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
    if (!isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)) {
      return true;
    }
    return abortStaleAutomation(
      automationRevision,
      reason,
      { phaseAdmissionEpoch }
    );
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
      setPwmClockIntent(retryAt);
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
    replaceSchedulePageTimerRetryState(schedule);
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
        || !isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
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
    setPwmClockIntent(0);
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
  const restored = await restoreIntervalAlarmFromStorage(
    'repair: 按已记录绝对触发时间恢复 PWM 闹钟',
    phaseAdmissionEpoch
  );
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
  setPwmClockIntent(repairPlan.nextTriggerAt);
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
  return await trackedRepair;
  } finally {
    if (!ownsBorrowedPhaseAdmission) {
      releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
      drainDeferredScheduleRepair('repair-schedule-clock-complete');
    }
  }
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

async function settleDeferredSyncDisable(
  phaseAdmissionEpoch,
  {
    ensureCurrent = null,
    existingTimerResult = null,
    reason = 'manual-off'
  } = {}
) {
  if (!deferredSyncDisablePending) return null;
  if (!await ensureSyncAuthorityDurableBaselineLoaded()) {
    await scheduleSyncRetry('adopt').catch(() => {});
    return {
      success: false,
      remoteSafetyReadPending: true,
      deferredRetryPending: true
    };
  }
  const manualEpoch = manualToggleIntentEpoch;
  const settlementOwnerIsCurrent = () => (
    isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && manualEpoch === manualToggleIntentEpoch
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  const remoteSafetyReady =
    await refreshRemoteDisableBeforeLocalRelease(
      settlementOwnerIsCurrent,
      `${reason}-deferred-sync-disable-preflight`,
      { preserveRemoteTrueAsSuccessor: true }
    );
  if (!remoteSafetyReady || !settlementOwnerIsCurrent()) {
    return {
      success: false,
      remoteSafetyReadPending: true,
      deferredRetryPending: true
    };
  }
  if (!deferredSyncDisablePending) {
    return {
      success: false,
      safetyCredentialReleased: true,
      remoteDisabled: false
    };
  }
  const preliminaryReleaseReceipt =
    await prepareDeferredSyncDisableForRelease(
      settlementOwnerIsCurrent,
      `${reason}-deferred-sync-disable-preflight`
    );
  if (!settlementOwnerIsCurrent()) {
    return { success: false, stale: true };
  }
  if (!deferredSyncDisablePending) {
    return {
      success: false,
      safetyCredentialReleased: true,
      remoteDisabled: false
    };
  }
  if (!isDeferredSyncDisableReleaseReceiptCurrent(
    preliminaryReleaseReceipt
  )) {
    return {
      success: false,
      remoteSafetyReadPending: true,
      deferredRetryPending: true
    };
  }
  const deferredEpoch = preliminaryReleaseReceipt.epoch;
  const deferredScheduleAuthorityGeneration =
    deferredSyncDisableLocalScheduleAuthorityGeneration;
  const beforeCommitIsCurrent = () => (
    settlementOwnerIsCurrent()
    && deferredSyncDisablePending
    && deferredEpoch === deferredSyncDisableEpoch
    && isDeferredSyncDisableReleaseReceiptCurrent(
      preliminaryReleaseReceipt
    )
    && deferredScheduleAuthorityGeneration
      === localScheduleAuthorityGeneration
  );
  if (!beforeCommitIsCurrent()) return { success: false, stale: true };

  const disableAdmissionEpoch = ++automaticDisableAdmissionEpoch;
  automaticOnAdmissionBlocked = true;
  pwmRuntimeRevision += 1;
  syncPublishGeneration += 1;
  invalidateTimerBasedShutdown();
  schedule.enabled = false;
  schedule.comfortStartUntil = 0;
  schedule.comfortStartOnConfirmedAt = 0;
  // 先只提交 disabled schedule，保留 F/manual-OFF recovery marker。页面
  // 1 分钟关机尚未 durable 前若 SW 终止，下一次启动仍会从 marker 重放，
  // 不能出现“storage 已 clear，但真实 AC 仍开着且无人恢复”的终止窗。
  const disableIntentCommitted = await commitScheduleAuthority({
    ensureCurrent: beforeCommitIsCurrent,
    markSyncPublishPending: true,
    reason: `${reason}-deferred-sync-disable-intent`
  });
  if (!disableIntentCommitted) return { success: false, stale: true };

  const disableOwnerIsCurrent = () => (
    isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && disableAdmissionEpoch === automaticDisableAdmissionEpoch
    && manualEpoch === manualToggleIntentEpoch
    && schedule.enabled === false
  );
  await finishExplicitDisablePreemption();
  if (!disableOwnerIsCurrent()) return { success: false, stale: true };
  await resetDisabledPwmRuntime();
  if (!disableOwnerIsCurrent()) return { success: false, stale: true };
  const timerResult = existingTimerResult?.success
    ? existingTimerResult
    : await requestTimerBasedShutdown(
        `${reason}-deferred-sync-disable`,
        1,
        { ensureCurrent: disableOwnerIsCurrent }
      );
  if (!disableOwnerIsCurrent()) return { success: false, stale: true };
  if (!timerResult?.success) {
    // requestTimerBasedShutdown 已登记自己的 retry state；F 与 manual marker
    // 继续 pending，确保失败/终止后只会重试安全停用，不会放行自动 ON。
    return {
      success: false,
      error: timerResult?.error,
      result: timerResult,
      remoteDisabled: false,
      deferredRetryPending: true,
      schedule: { ...schedule }
    };
  }
  const committed = await commitScheduleAndReleaseManualOffAdmission({
    ensureCurrent: disableOwnerIsCurrent,
    markSyncPublishPending: true,
    clearDeferredSyncDisable: true,
    preserveDeferredSyncSuccessor: true,
    reason: `${reason}-deferred-sync-disable`
  });
  if (!committed || !disableOwnerIsCurrent()) {
    return { success: false, stale: true };
  }
  await syncScheduleToSync(`${reason}-deferred-sync-disable`);
  if (disableOwnerIsCurrent()) {
    releaseExplicitDisableAdmission(disableAdmissionEpoch);
  }
  drainDeferredSyncAdoptionAfterManualOffAdmission();
  const status = await getCurrentACStatus();
  return {
    success: !!timerResult?.success,
    error: timerResult?.error,
    result: timerResult,
    remoteDisabled: true,
    schedule: { ...schedule, actualStatus: status }
  };
}

async function recoverSafetyAfterFailedUserAuthority(
  intentEpoch,
  action,
  reason = 'user-authority-failed',
  { ensureCurrent = null } = {}
) {
  const failedAuthorityIsCurrent = () => (
    isManualToggleIntentCurrent(intentEpoch, action)
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  if (!failedAuthorityIsCurrent()) return null;

  if (deferredSyncDisablePending) {
    try {
      const settled = await runSerializedSchedulePhaseOperation(
        phaseAdmissionEpoch => settleDeferredSyncDisable(
          phaseAdmissionEpoch,
          {
            ensureCurrent: failedAuthorityIsCurrent,
            reason
          }
        ),
        `${reason}-deferred-disable`
      );
      if (!failedAuthorityIsCurrent()) return null;
      if (settled?.remoteDisabled) return settled;
    } catch (error) {
      console.warn('[AC扩展] 用户 authority 失败后的 remote disable 收口失败:', error?.message);
    }
  }

  const reclaimedEpoch = reclaimPendingManualOffAfterFailedAuthority(
    intentEpoch,
    action,
    failedAuthorityIsCurrent
  );
  if (reclaimedEpoch <= 0) return null;
  return resumePendingManualOffAdmission(`${reason}-resume-off`);
}

async function finalizeManualOffAutomationPhase(
  phaseAdmissionEpoch,
  ensureCurrent,
  admissionToken = manualOffAdmissionToken
) {
  const manualIntentEpochAtStart = manualToggleIntentEpoch;
  const requestPhaseIsCurrent = () => (
    isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && isManualToggleIntentCurrent(manualIntentEpochAtStart, 'off')
  );
  const phaseIsCurrent = () => (
    requestPhaseIsCurrent()
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
    && manualOffAutomaticOnBlocked
    && manualOffAdmissionToken === admissionToken
  );
  const settlePendingDisable = async existingTimerResult => {
    const settled = await settleDeferredSyncDisable(phaseAdmissionEpoch, {
      ensureCurrent: requestPhaseIsCurrent,
      existingTimerResult,
      reason: 'toggleNowAndSync-off'
    });
    if (settled?.safetyCredentialReleased && phaseIsCurrent()) {
      return finalizeManualOffAutomationPhase(
        phaseAdmissionEpoch,
        ensureCurrent,
        admissionToken
      );
    }
    return settled;
  };
  const staleResult = () => ({
    success: false,
    shutdownStale: true,
    error: '手动关机请求已被后续用户操作替代'
  });
  if (!phaseIsCurrent()) return staleResult();

  // 首次不等 phase 的 timer 是紧急制动；等旧 schedule/phase writer
  // 收口后必须再写一次，否则旧 ON 可在等待窗口里后 claim page
  // owner，反向覆盖用户的 1 分钟关机保险。
  const timerResult = await requestTimerBasedShutdown(
    'toggle-now-off-finalize',
    1,
    { ensureCurrent: phaseIsCurrent }
  );
  if (!phaseIsCurrent()) return staleResult();
  const remoteSafetyReady = await refreshRemoteDisableBeforeLocalRelease(
    phaseIsCurrent,
    'toggleNowAndSync-off-finalize'
  );
  if (!remoteSafetyReady || !phaseIsCurrent()) {
    return {
      success: false,
      remoteSafetyReadPending: !remoteSafetyReady,
      error: '手动关机发布前未能确认远端停用状态，保持自动 ON 阻断'
    };
  }
  if (deferredSyncDisablePending) {
    return settlePendingDisable(timerResult);
  }
  const terminalDeferredEpoch = deferredSyncDisableEpoch;
  const normalPhaseIsCurrent = () => (
    phaseIsCurrent()
    && !deferredSyncDisablePending
    && deferredSyncDisableEpoch === terminalDeferredEpoch
  );
  if (!timerResult?.success || !isAutomationAllowedIgnoringManualOff()) {
    const status = await getCurrentACStatus();
    if (!normalPhaseIsCurrent()) {
      return deferredSyncDisablePending && requestPhaseIsCurrent()
        ? settlePendingDisable(timerResult)
        : staleResult();
    }
    if (timerResult?.success) {
      const released = await commitScheduleAndReleaseManualOffAdmission({
        ensureCurrent: normalPhaseIsCurrent,
        drainDeferredSync: false,
        reason: 'toggleNowAndSync-off-paused'
      });
      if (!released) {
        return deferredSyncDisablePending && requestPhaseIsCurrent()
          ? settlePendingDisable(timerResult)
          : staleResult();
      }
      if (deferredSyncDisablePending && requestPhaseIsCurrent()) {
        return settlePendingDisable(timerResult);
      }
      await syncScheduleToSync('toggleNowAndSync-off-paused');
    }
    return {
      success: !!timerResult?.success,
      error: timerResult?.error,
      result: timerResult,
      schedule: { ...schedule, actualStatus: status }
    };
  }

  const automationRevision = pwmRuntimeRevision;
  const ownerIsCurrent = () => (
    normalPhaseIsCurrent()
    && isAutomationOperationCurrentIgnoringManualOff(automationRevision)
  );
  schedule.comfortStartUntil = 0;
  schedule.comfortStartOnConfirmedAt = 0;
  schedule.pwmState = 'on';
  clearPwmRetryState();
  const offConfirmedAt = Math.max(
    Date.now() + 60000,
    Number(schedule.pageTimerTargetAt) || 0
  );
  // 规划时仍要显式携带“请求到达时的最近半点”。
  // 例如 19:29:30 请求关机、预计 19:30:30 物理 OFF，19:30
  // 已跨过，必须产生该 boundary 的 typed safe-delay/skip，不能
  // 把 20:00 伪装成普通“最近未来半点”。
  const smartBoundaryAtRequest = nextHalfHourBoundary(
    Number(manualOffAdmissionRequestedAt) || Date.now()
  );
  const smartOffPlan = schedule.smartMode?.enabled === true
    ? planSmartOnAfterConfirmedOff(schedule, {
        now: offConfirmedAt,
        confirmedOffAt: offConfirmedAt,
        minOffMinutes: SMART_MODE.MIN_OFF_MINUTES,
        boundaryAt: smartBoundaryAtRequest
      })
    : null;
  const smartMinOffAt = offConfirmedAt
    + SMART_MODE.MIN_OFF_MINUTES * 60000;
  const firstSmartBoundaryAt = nextHalfHourBoundary(offConfirmedAt);
  const safeSmartFallbackAt = firstSmartBoundaryAt >= smartMinOffAt
    ? firstSmartBoundaryAt
    : nextHalfHourBoundary(firstSmartBoundaryAt);
  const resolvedSmartOffPlan = schedule.smartMode?.enabled === true
      && smartOffPlan?.kind === 'refuse'
    ? {
        kind: 'smart-on-safety-skip',
        nextTriggerAt: safeSmartFallbackAt,
        boundaryAt: halfHourBoundaryAtOrBefore(safeSmartFallbackAt - 1)
      }
    : smartOffPlan;
  const nextAutomaticOnAt = schedule.smartMode?.enabled === true
    ? (Number(resolvedSmartOffPlan?.nextTriggerAt) > offConfirmedAt
        ? Number(resolvedSmartOffPlan.nextTriggerAt)
        : safeSmartFallbackAt)
    : offConfirmedAt
      + Math.max(1, sanitizeMinutes(schedule.offMinutes, 30)) * 60000;
  if (schedule.smartMode?.enabled === true
      && (resolvedSmartOffPlan?.kind === 'smart-on-safe-delay'
        || resolvedSmartOffPlan?.kind === 'smart-on-safety-skip')) {
    const smartBoundaryAt = Number(resolvedSmartOffPlan.boundaryAt)
      || halfHourBoundaryAtOrBefore(nextAutomaticOnAt - 1);
    schedule.smartOnBoundaryAt = smartBoundaryAt;
    setSmartOnPwmRetryState('on', nextAutomaticOnAt, {
      kind: resolvedSmartOffPlan.kind,
      boundaryAt: smartBoundaryAt
    });
  } else {
    schedule.smartOnBoundaryAt = 0;
    clearPwmRetryState();
  }
  setPwmClockIntent(nextAutomaticOnAt);
  const offPhaseIntent = snapshotPhaseAdoptionIntentState();

  await chrome.alarms.clear('ac-comfort-end');
  if (!ownerIsCurrent()) return staleResult();
  replayPhaseAdoptionIntentState(offPhaseIntent);
  await persistSchedule('toggleNowAndSync-off-phase-intent', {
    syncFromLiveAlarm: false
  });
  if (!ownerIsCurrent()) return staleResult();

  const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
    { nextTriggerAt: nextAutomaticOnAt },
    'toggle-now-off-phase',
    automationRevision,
    {
      ensureCurrent: ownerIsCurrent,
      allowManualOffAdmission: true
    }
  );
  if (!ownerIsCurrent()) return staleResult();
  if (!alarmWrite.created) {
    replayPhaseAdoptionIntentState(offPhaseIntent);
    schedule.pageTimerError = '手动关机已布防，但下一次自动开机闹钟创建失败；等待看门狗恢复';
    const released = await commitScheduleAndReleaseManualOffAdmission({
      ensureCurrent: ownerIsCurrent,
      drainDeferredSync: false,
      reason: 'toggleNowAndSync-off-phase-alarm-failed'
    });
    if (!released) {
      return deferredSyncDisablePending && requestPhaseIsCurrent()
        ? settlePendingDisable(timerResult)
        : staleResult();
    }
    if (deferredSyncDisablePending && requestPhaseIsCurrent()) {
      return settlePendingDisable(timerResult);
    }
    await syncScheduleToSync('toggleNowAndSync-off-phase-alarm-failed');
    const releasedOwnerIsCurrent = () => (
      requestPhaseIsCurrent()
      && automationRevision === pwmRuntimeRevision
      && isAutomationAllowed()
    );
    await createAlarm('ac-watchdog', {
      periodInMinutes: 5,
      ensureCurrent: releasedOwnerIsCurrent
    });
    return {
      success: false,
      error: schedule.pageTimerError,
      result: timerResult,
      schedule: { ...schedule }
    };
  }

  const verifiedClockState = snapshotVerifiedPwmClockState(
    alarmWrite.writeOwner
  );
  const commitIsCurrent = () => (
    ownerIsCurrent()
    && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
  );
  if (!verifiedClockState || !commitIsCurrent()) return staleResult();
  if (!replayVerifiedPwmClockState(verifiedClockState)
      || !replayPhaseAdoptionIntentState(offPhaseIntent, {
        replayClock: false
      })) {
    return staleResult();
  }
  if (!commitIsCurrent()) return staleResult();
  const released = await commitScheduleAndReleaseManualOffAdmission({
    ensureCurrent: commitIsCurrent,
    drainDeferredSync: false,
    reason: 'toggleNowAndSync-off-phase'
  });
  if (!released) {
    return deferredSyncDisablePending && requestPhaseIsCurrent()
      ? settlePendingDisable(timerResult)
      : staleResult();
  }
  if (deferredSyncDisablePending && requestPhaseIsCurrent()) {
    return settlePendingDisable(timerResult);
  }
  await syncScheduleToSync('toggleNowAndSync-off-phase');
  const releasedCommitIsCurrent = () => (
    requestPhaseIsCurrent()
    && automationRevision === pwmRuntimeRevision
    && isAutomationAllowed()
    && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
  );
  await createAlarm('ac-badge-tick', {
    delayInMinutes: 1,
    ensureCurrent: releasedCommitIsCurrent
  });
  await createAlarm('ac-watchdog', {
    periodInMinutes: 5,
    ensureCurrent: releasedCommitIsCurrent
  });
  if (!releasedCommitIsCurrent()) return staleResult();
  await updateBadge();
  const status = await getCurrentACStatus();
  if (!releasedCommitIsCurrent()) return staleResult();
  return {
    success: true,
    result: timerResult,
    schedule: { ...schedule, actualStatus: status }
  };
}

async function refreshRemoteDisableBeforeLocalRelease(
  ensureCurrent,
  reason = 'manual-off-recovery',
  {
    preserveRemoteTrueAsSuccessor = false,
    allowSafeLocalDisablePublish = false,
    waitForExistingOutbound = false,
    outboundWaitTimeoutMs = 4000
  } = {}
) {
  if (!chrome.storage?.sync) return true;
  const failClosedForRetry = async () => {
    await scheduleSyncRetry('adopt').catch(() => {});
    return false;
  };
  try {
    let storeReceipt = await readStableSyncStoreAuthorityReceipt(
      ensureCurrent,
      { waitForExistingOutbound, outboundWaitTimeoutMs }
    );
    if (!isStableSyncStoreAuthorityReceiptCurrent(
      storeReceipt,
      ensureCurrent
    )) {
      return failClosedForRetry();
    }
    const remote = storeReceipt.remote;
    const outboundUnresolved = storeReceipt.outboundUnresolved;
    if (remote && typeof remote === 'object' && remote.enabled === false) {
      const alreadyPendingExactDisable = deferredSyncDisablePending
        && deferredSyncDisableRemoteSnapshotComplete
        && getSyncPayloadIdentity(remote)
          === getSyncPayloadIdentity(deferredSyncDisableRemoteSnapshot);
      const localDisableCannotOverwriteRemoteSafety =
        allowSafeLocalDisablePublish === true
        && schedule.enabled === false;
      const loadedWatermark = await loadSyncWatermark();
      if (loadedWatermark === null
          || !isStableSyncStoreAuthorityReceiptCurrent(
            storeReceipt,
            ensureCurrent
          )) {
        if (!alreadyPendingExactDisable
            && !localDisableCannotOverwriteRemoteSafety) {
          const disablePersisted =
            await deferRemoteSyncDisableWhileManualOffBlocked(
              remote,
              `${reason}-sync-preflight-unread-receipt`
            );
          if (!disablePersisted) return failClosedForRetry();
        }
        return failClosedForRetry();
      }
      // syncedAt 水位不能识别慢时钟 peer 的后到 F。只有 stable store 中的
      // 完整 payload 与 durable publish receipt 精确相同，且更晚的本机 M
      // 已 durable，才证明它是当前用户动作可覆盖的本机 predecessor。
      const remoteDisableAlreadyConsumed = !deferredSyncDisablePending
        && deferredSyncDisableLoaded
        && manualOffAdmissionLoaded
        && syncAuthorityDurableBaselineLoaded
        && hasDurableCompletedSyncPayloadReceiptBeforeCurrentMutation(remote)
        && storeReceipt.localMutationCutoffObservedAt
          === localScheduleMutationCommittedObservedAt
        // 第一阶段 M 会把新 schedule/cutoff/pending=true 原子持久化，
        // 所以 current marker 可与旧 retry alarm 共存；marker=false 而只剩
        // retry 时无法证明 credential 已被这个新 M 接管，仍 fail closed。
        && (outboundUnresolved === false
          || storeReceipt.pendingPublish === true);
      if (!alreadyPendingExactDisable
          && !remoteDisableAlreadyConsumed
          && !localDisableCannotOverwriteRemoteSafety) {
        const disablePersisted =
          await deferRemoteSyncDisableWhileManualOffBlocked(
            remote,
            `${reason}-sync-preflight`
          );
        if (!disablePersisted) return failClosedForRetry();
      }
    }
    if (preserveRemoteTrueAsSuccessor
        && deferredSyncDisablePending
        && remote
        && typeof remote === 'object'
        && remote.enabled !== false
        && getSyncPayloadIdentity(remote)
          !== getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot)) {
      if (outboundUnresolved) {
        // pending marker/fixed retry 证明 store T 仍可能是 F 前本机写的
        // late result；不得给它签当前 F lineage，但继续收口 F，clear 后
        // 当前 false publish 会修复 store，避免 marker 自身造成死锁。
      } else {
        const successorPersisted =
          await rememberRemoteSyncSuccessorAfterDeferredDisable(
            remote,
            `${reason}-sync-preflight-successor`
          );
        if (!successorPersisted) return failClosedForRetry();
      }
    }
    if (typeof ensureCurrent === 'function' && !ensureCurrent()) {
      return false;
    }

    // exact 内存 F 不是 durable receipt；统一 helper 会补写 record、吸收
    // 当前 exact F 的 Lamport，并在每个 await 后复核 epoch+identity。
    if (deferredSyncDisablePending) {
      const releaseReceipt = await prepareDeferredSyncDisableForRelease(
        ensureCurrent,
        `${reason}-sync-preflight`
      );
      if (!isDeferredSyncDisableReleaseReceiptCurrent(releaseReceipt)) {
        return failClosedForRetry();
      }
    }

    // fresh read 到的普通 T 若不是已经登记的 post-F successor，就属于
    // 本次本机动作已观察到的 predecessor。即使选择不采纳其 config，
    // 后续 outbound 的 Lamport 也必须严格大于它；当前 successor mailbox
    // 则保留给 F 收口后的正式 adoption，不能提前用 watermark 吞掉。
    const remoteIsCurrentDeferredSuccessor = !!remote
      && typeof remote === 'object'
      && remote.enabled !== false
      && getSyncPayloadIdentity(remote)
        === getSyncPayloadIdentity(deferredSyncDisableSuccessorSnapshot);
    const observedRemoteSyncedAt = !remoteIsCurrentDeferredSuccessor
      ? normalizeSyncAuthorityTimestamp(remote?.syncedAt)
      : 0;
    if (observedRemoteSyncedAt > 0) {
      const loadedWatermark = await loadSyncWatermark();
      if (loadedWatermark === null) return failClosedForRetry();
      if (typeof ensureCurrent === 'function' && !ensureCurrent()) {
        return false;
      }
      if (observedRemoteSyncedAt > loadedWatermark) {
        const observedRemoteIdentity = getSyncPayloadIdentity(remote);
        const watermarkPersisted =
          await persistSyncWatermark(observedRemoteSyncedAt);
        if (!watermarkPersisted) return failClosedForRetry();
        // 本次 watermark writer 会有意换掉 stable receipt 的 generation。
        // 写后重新读取物理 store；只接受仍是同一完整 payload 的新 receipt。
        storeReceipt = await readStableSyncStoreAuthorityReceipt(
          ensureCurrent,
          { waitForExistingOutbound, outboundWaitTimeoutMs }
        );
        if (!isStableSyncStoreAuthorityReceiptCurrent(
          storeReceipt,
          ensureCurrent
        ) || getSyncPayloadIdentity(storeReceipt.remote)
            !== observedRemoteIdentity) {
          return failClosedForRetry();
        }
      }
    }
    if (!isStableSyncStoreAuthorityReceiptCurrent(
      storeReceipt,
      ensureCurrent
    )) {
      const observedRemoteIdentity = getSyncPayloadIdentity(remote);
      storeReceipt = await readStableSyncStoreAuthorityReceipt(
        ensureCurrent,
        { waitForExistingOutbound, outboundWaitTimeoutMs }
      );
      if (!isStableSyncStoreAuthorityReceiptCurrent(
        storeReceipt,
        ensureCurrent
      ) || getSyncPayloadIdentity(storeReceipt.remote)
          !== observedRemoteIdentity) {
        return failClosedForRetry();
      }
    }
    return typeof ensureCurrent !== 'function' || ensureCurrent();
  } catch (error) {
    console.warn('[AC扩展] 手动关机恢复前读取 sync safety 失败:', error?.message);
    return failClosedForRetry();
  }
}

async function resumePendingManualOffAdmission(reason = 'recovery') {
  const admissionToken = manualOffAdmissionToken;
  if (!manualOffAutomaticOnBlocked || !admissionToken) return false;
  const admissionIntentEpoch = manualToggleIntentEpoch;
  if (!isManualToggleIntentCurrent(admissionIntentEpoch, 'off')) return false;
  return runManualOffAdmissionFlight(admissionToken, async () => {
    const recoveryIsCurrent = () => (
      isManualToggleIntentCurrent(admissionIntentEpoch, 'off')
      && manualOffAutomaticOnBlocked
      && manualOffAdmissionToken === admissionToken
    );
    if (!recoveryIsCurrent()) return false;

    // 新 SW 没有上一实例的 runtime revision；重新失效可能仍存活的页面 ON
    // request，并先启动紧急 1 分钟 timer。随后同步预约 phase successor，
    // generic repair/watchdog 只能排在本事务之后。同 token retry 由 flight
    // 复用，不会每分钟反向取消仍在做页面持久验证的首轮事务。
    pwmRuntimeRevision += 1;
    invalidateTimerBasedShutdown();
    await queueManualOffAutomaticOnCancellation({ claimRevision: false });
    if (!recoveryIsCurrent()) return false;

    const immediatePromise = toggleNowAndSync('off', {
      ensureCurrent: recoveryIsCurrent
    });
    const mutationCoveragePromise =
      completeRecoveredManualOffLocalMutationCoverage(admissionToken);
    const finalizePromise = runSerializedSchedulePhaseOperation(
      async phaseAdmissionEpoch => {
        const [immediateResult, mutationCoverageComplete] =
          await Promise.all([
            immediatePromise,
            mutationCoveragePromise
          ]);
        if (!recoveryIsCurrent()) return immediateResult;
        if (!mutationCoverageComplete) {
          return {
            ...immediateResult,
            success: false,
            localMutationCoveragePending: true,
            error: '后到本机设置仍在提交，手动关机保持阻断并等待重试'
          };
        }
        const result = await finalizeManualOffAutomationPhase(
          phaseAdmissionEpoch,
          recoveryIsCurrent,
          admissionToken
        );
        return { ...result, immediateResult };
      },
      `manual-toggle-off-${reason}`
    );
    const result = await finalizePromise;
    if (!result?.success && manualOffAutomaticOnBlocked) {
      console.warn('[AC扩展] 启动恢复手动关机尚未收口，继续阻断自动 ON');
    }
    return result;
  });
}

async function toggleNowAndSync(
  action,
  {
    phaseAdmissionEpoch = 0,
    ensureCurrent = null
  } = {}
) {
  const manualToggleIsCurrent = () => (
    isSyncPhaseAdoptionAdmissionOwnerCurrent(phaseAdmissionEpoch)
    && (typeof ensureCurrent !== 'function' || ensureCurrent())
  );
  const staleManualOnResult = () => ({
    success: false,
    phaseStale: true,
    error: '手动开机请求已被后续设置或开关意图替代'
  });

  // 提取（Fowler Extract Function）：手动开机后的 ON 相位布防——清旧 alarm、新鲜页确认关机定时器，失败保持 on 相位 1 分钟重试。
  async function armOnPhaseTimerAndAlarms(preparedTimerResult = null) {
    // 手动开机同样是一个新的 PWM ON 阶段。先清旧 alarm 以免验证期间旧的
    // OFF 边界抢跑；新鲜页确认失败则保持 pwmState='on'，下一次不会再点击。
    if (!manualToggleIsCurrent()) return staleManualOnResult();
    prepareFreshPwmStartState();
    const clearAlarmWrite = await clearPwmAlarmWithReceipt(
      automationRevision,
      false,
      { ensureCurrent: manualToggleIsCurrent }
    );
    if (!clearAlarmWrite.cleared || !manualToggleIsCurrent()) {
      return staleManualOnResult();
    }

    const preparedPageTimerWriteOwner = Number(
      preparedTimerResult?.pageTimerWriteOwner
    ) || 0;
    const preparedTimerIsCurrent = preparedTimerResult?.success === true
      && preparedPageTimerWriteOwner > 0
      && isPageTimerWriteOwnerCurrent(preparedPageTimerWriteOwner);
    const timerResult = preparedTimerIsCurrent
      ? preparedTimerResult
      : await setPageTimer(schedule.onMinutes, {
        retryOnFailure: false,
        automationRevision,
        ensureCurrent: manualToggleIsCurrent
      });
    if (!manualToggleIsCurrent()) return staleManualOnResult();
    const pageTimerWriteOwner = Number(timerResult?.pageTimerWriteOwner) || 0;
    if (pageTimerWriteOwner <= 0
        || !isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)) {
      return staleManualOnResult();
    }
    if (await abortStaleAutomation(
      automationRevision,
      'toggle-page-timer-active-hours-paused',
      { phaseAdmissionEpoch }
    )) {
      const status = await getCurrentACStatus();
      return { success: true, schedule: { ...schedule, actualStatus: status } };
    }
    if (!timerResult?.success) {
      schedule.pageTimerError = `手动开机后页面关机定时器未确认：${timerResult?.error || '未知错误'}；保持 on 相位，1 分钟后重试`;
      const retryAt = Date.now() + 60000;
      setPwmClockIntent(retryAt);
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
      if (!manualToggleIsCurrent()
          || !isAutomationOperationCurrent(automationRevision)) {
        return staleManualOnResult();
      }
      if (safetyTimerRetry) {
        await syncScheduleToSync('toggleNowAndSync-pageTimer-retry-hold');
        if (!manualToggleIsCurrent()
            || !isAutomationOperationCurrent(automationRevision)) {
          return staleManualOnResult();
        }
      }
      const retryAlarmWrite = await createPwmAlarmFromPlanWithReceipt(
        { nextTriggerAt: retryAt },
        'toggle-pageTimer-failed',
        automationRevision,
        { ensureCurrent: manualToggleIsCurrent }
      );
      if (!manualToggleIsCurrent()
          || !isAutomationOperationCurrent(automationRevision)) {
        return staleManualOnResult();
      }
      const alarmCreated = retryAlarmWrite.created;
      if (alarmCreated === false) {
        schedule.pageTimerError += '；PWM 恢复闹钟创建失败，等待看门狗按 durable intent 恢复';
        await createAlarm('ac-watchdog', {
          periodInMinutes: 5,
          ensureCurrent: manualToggleIsCurrent
        });
        if (!manualToggleIsCurrent()
            || !isAutomationOperationCurrent(automationRevision)) {
          return staleManualOnResult();
        }
        await persistSchedule('toggleNowAndSync-pageTimer-retry-alarm-failed', {
          syncFromLiveAlarm: false
        });
        if (!manualToggleIsCurrent()
            || !isAutomationOperationCurrent(automationRevision)) {
          return staleManualOnResult();
        }
        if (safetyTimerRetry) {
          await syncScheduleToSync('toggleNowAndSync-pageTimer-retry-alarm-failed');
          if (!manualToggleIsCurrent()
              || !isAutomationOperationCurrent(automationRevision)) {
            return staleManualOnResult();
          }
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
      await createAlarm('ac-badge-tick', {
        delayInMinutes: 1,
        ensureCurrent: manualToggleIsCurrent
      });
      if (!manualToggleIsCurrent()
          || !isAutomationOperationCurrent(automationRevision)) {
        return staleManualOnResult();
      }
      if (await abortStaleAutomation(
        automationRevision,
        'toggle-retry-active-hours-paused',
        { phaseAdmissionEpoch }
      )) {
        const status = await getCurrentACStatus();
        return { success: true, schedule: { ...schedule, actualStatus: status } };
      }
      await persistSchedule('toggleNowAndSync-pageTimer-failed');
      if (!manualToggleIsCurrent()
          || !isAutomationOperationCurrent(automationRevision)) {
        return staleManualOnResult();
      }
      if (safetyTimerRetry) {
        await syncScheduleToSync('toggleNowAndSync-pageTimer-failed');
        if (!manualToggleIsCurrent()
            || !isAutomationOperationCurrent(automationRevision)) {
          return staleManualOnResult();
        }
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
    if (typeof ensureCurrent === 'function' && !ensureCurrent()) {
      return {
        success: false,
        requestStale: true,
        error: '手动关机请求已被后续用户操作替代'
      };
    }
    const timerResult = await requestTimerBasedShutdown(
      'toggle-now-off',
      1,
      { ensureCurrent }
    );
    const status = await getCurrentACStatus();
    return {
      success: !!timerResult?.success,
      error: timerResult?.error,
      schedule: { ...schedule, actualStatus: status },
      result: timerResult
    };
  }

  if (!manualToggleIsCurrent()) {
    return staleManualOnResult();
  }

  const automationWasAllowed = isAutomationAllowed();
  const automationRevision = pwmRuntimeRevision;
  if (automationWasAllowed) {
    const pageTimerWriteOwner = clearPageTimerProofState();
    clearPwmRetryState();
    const retryAlarmClear = await writePageTimerRetryAlarm({
      action: 'clear',
      isCurrent: () => (
        isAutomationOperationCurrent(automationRevision)
        && isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)
      )
    });
    if (retryAlarmClear.stale
        || !isAutomationOperationCurrent(automationRevision)
        || !isPageTimerWriteOwnerCurrent(pageTimerWriteOwner)) {
      const status = await getCurrentACStatus();
      return {
        success: false,
        automationStale: true,
        error: '自动控制事务已被后续请求替代',
        schedule: { ...schedule, actualStatus: status }
      };
    }
    clearPageTimerProofState();
    clearPwmRetryState();
    await persistSchedule('toggleNowAndSync-on-intent', { syncFromLiveAlarm: false });
  }
  if (!manualToggleIsCurrent()) {
    return staleManualOnResult();
  }
  const toggleResult = await toggleAC('on', {
    pageTimerMinutes: schedule.onMinutes,
    pageTimerTargetAt: 0,
    ensureCurrent: manualToggleIsCurrent,
    ...(automationWasAllowed
      ? {
          requireAutomationAllowed: true,
          automationRevision
        }
      : {})
  });

  if (!manualToggleIsCurrent()) return staleManualOnResult();
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
    if (!manualToggleIsCurrent()) return staleManualOnResult();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }

  // 间隔模式
  const currentOn = action === 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);

  if (currentOn) {
    const failedResult = await armOnPhaseTimerAndAlarms(toggleResult.pageTimerResult);
    if (failedResult) return failedResult;
  }
  if (!manualToggleIsCurrent()) return staleManualOnResult();

  schedule.pwmState = currentOn ? 'off' : 'on';
  const manualCommitState = Object.freeze({
    pwmState: schedule.pwmState,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  });
  const togglePlan = currentOn
    ? { nextTriggerAt: schedule.pageTimerTargetAt }
    : { nextTriggerAt: Date.now() + delay * 60000 };
  setPwmClockIntent(togglePlan.nextTriggerAt);
  const manualClockIntentState = snapshotPwmClockIntentState();
  await persistSchedule('toggleNowAndSync-commit-intent', {
    syncFromLiveAlarm: false
  });
  if (!manualToggleIsCurrent()) return staleManualOnResult();
  const alarmWrite = await createPwmAlarmFromPlanWithReceipt(
    togglePlan,
    'toggle',
    automationRevision,
    { ensureCurrent: manualToggleIsCurrent }
  );
  if (!alarmWrite.created) {
    const manualAlarmFailureError = `手动${currentOn ? '开机' : '关机'}已确认，但 PWM 闹钟创建失败；等待看门狗按 durable intent 恢复`;
    const failureIsCurrent = () => (
      isAutomationOperationCurrent(automationRevision)
      && isPwmAlarmWriteOwnerCurrent(alarmWrite.writeOwner)
      && manualToggleIsCurrent()
    );
    const failurePersisted = await persistOwnedPwmAlarmFailure({
      isCurrent: failureIsCurrent,
      replayState: () => {
        replayPwmClockIntentState(manualClockIntentState);
        schedule.pwmState = manualCommitState.pwmState;
        replaceSchedulePwmRetryState(schedule, {
          kind: manualCommitState.pwmRetryKind,
          boundaryAt: manualCommitState.pwmRetryBoundaryAt,
          scheduledAt: manualCommitState.pwmRetryScheduledAt
        });
        schedule.pageTimerError = manualAlarmFailureError;
        return true;
      },
      persistReason: 'toggleNowAndSync-commit-alarm-failed'
    });
    if (!failurePersisted) {
      const status = await getCurrentACStatus();
      return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
    }
    await updateBadge();
    const status = await getCurrentACStatus();
    return {
      success: false,
      error: schedule.pageTimerError,
      schedule: { ...schedule, actualStatus: status },
      result: toggleResult
    };
  }
  const verifiedClockState = snapshotVerifiedPwmClockState(alarmWrite.writeOwner);
  if (!verifiedClockState) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }
  await createAlarm('ac-badge-tick', {
    delayInMinutes: 1,
    ensureCurrent: manualToggleIsCurrent
  });
  if (await abortStaleAutomation(
    automationRevision,
    'toggle-commit-active-hours-paused',
    { phaseAdmissionEpoch }
  )) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }
  if (!isAutomationOperationCurrent(automationRevision)
      || !manualToggleIsCurrent()) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }
  if (!replayVerifiedPwmClockState(verifiedClockState)) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }
  schedule.pwmState = manualCommitState.pwmState;
  replaceSchedulePwmRetryState(schedule, {
    kind: manualCommitState.pwmRetryKind,
    boundaryAt: manualCommitState.pwmRetryBoundaryAt,
    scheduledAt: manualCommitState.pwmRetryScheduledAt
  });
  await persistSchedule('toggleNowAndSync-interval', { syncFromLiveAlarm: false });
  if (!manualToggleIsCurrent()) return staleManualOnResult();
  await updateBadge();

  const status = await getCurrentACStatus();
  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

function cloneDiagnosticValue(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

function snapshotAlarm(alarm) {
  return alarm ? {
    scheduledTime: Number(alarm.scheduledTime) || 0,
    ...(Number.isFinite(Number(alarm.periodInMinutes))
      ? { periodInMinutes: Number(alarm.periodInMinutes) }
      : {})
  } : null;
}

async function readDiagnosticExternal(label, read, readErrors) {
  try {
    return await read();
  } catch (error) {
    readErrors.push(`${label}: ${String(error?.message || error).slice(0, 120)}`);
    return null;
  }
}

async function snapshotNamedAlarms(
  readErrors = [],
  includePageTimerRetry = false
) {
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
}

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

async function captureDiagnosticSnapshotAttempt(captureAttempts, firstObservedAt) {
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
}

async function captureDiagnosticSnapshot() {
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
}

function buildDiagnosticResultEnvelope({
  result,
  requestAt,
  before,
  repairs,
  lifecycle,
  after
}) {
  return {
    ...result,
    schemaVersion: 2,
    evidence: {
      requestAt,
      before,
      repair: {
        requested: true,
        items: [...repairs],
        lifecycle: cloneDiagnosticValue(lifecycle)
      },
      after
    }
  };
}

function recordClearedAlarmRepairs(repairs, before, after) {
  const names = {
    badge: 'badge-alarm-cleared',
    watchdog: 'watchdog-alarm-cleared',
    pwm: 'pwm-alarm-cleared',
    smartWeather: 'smart-weather-alarm-cleared'
  };
  Object.entries(names).forEach(([key, repair]) => {
    if (before?.[key] && !after?.[key]) repairs.push(repair);
  });
}

async function createDeferredPhaseAdoptionDiagnosticRepair() {
  const alarms = await snapshotNamedAlarms();
  return {
    result: {
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
    },
    lifecycle: null
  };
}

async function repairDisabledDiagnosticRuntime(repairs) {
  const beforeAlarms = await snapshotNamedAlarms();
  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    return createDeferredPhaseAdoptionDiagnosticRepair();
  }
  await clearAutomationRuntimeAlarmsWhileBlocked();
  if (isAutomationAllowed()) return { restart: true };
  await chrome.alarms.clear('ac-smart-weather');
  if (schedule.enabled) return { restart: true };
  const afterAlarms = await snapshotNamedAlarms();
  recordClearedAlarmRepairs(repairs, beforeAlarms, afterAlarms);
  return {
    result: {
      success: Object.values(afterAlarms).every(alarm => !alarm),
      enabled: false,
      repaired: repairs.length > 0,
      before: beforeAlarms,
      repairs,
      schedule: { ...schedule },
      pwmStepRunning: false,
      alarms: afterAlarms
    },
    lifecycle: null
  };
}

async function repairPausedDiagnosticRuntime(repairs) {
  const beforeAlarms = await snapshotNamedAlarms();
  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    return createDeferredPhaseAdoptionDiagnosticRepair();
  }
  await clearAutomationRuntimeAlarmsWhileBlocked();
  if (isAutomationAllowed()) return { restart: true };
  let smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
  if (schedule.smartMode?.enabled && !smartWeatherAlarm) {
    await rescheduleSmartWeatherAlarm();
    smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
    if (smartWeatherAlarm) repairs.push('smart-weather-alarm');
  }
  if (isAutomationAllowed()) return { restart: true };
  const afterAlarms = await snapshotNamedAlarms();
  recordClearedAlarmRepairs(repairs, beforeAlarms, afterAlarms);
  return {
    result: {
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
    },
    lifecycle: null
  };
}

function recordDiagnosticLifecycleRepairs(repairs, {
  lifecycle,
  previousPwmState,
  previousPwmAlarmAt,
  currentPwmAlarmAt
}) {
  const smartCurrentCycleRecovered = lifecycle?.handled === true
    && lifecycle?.plan?.kind === 'recover-smart-current-cycle'
    && (schedule.pwmState !== previousPwmState
      || currentPwmAlarmAt !== previousPwmAlarmAt);
  if (smartCurrentCycleRecovered) {
    repairs.push('smart-current-cycle');
    if (!repairs.includes('pwm-alarm')) repairs.push('pwm-alarm');
  }
  const smartCurrentCycleStarted = lifecycle?.started === true
    && lifecycle?.plan?.kind === 'recover-smart-current-cycle';
  if (smartCurrentCycleStarted) repairs.push('smart-current-cycle-started');
  const smartOnClockRepaired = lifecycle?.handled === true
    && lifecycle?.plan?.kind === 'repair-clock'
    && lifecycle?.plan?.reason === 'skipped-nearest-smart-on-boundary';
  if (smartOnClockRepaired) {
    repairs.push('smart-on-clock');
    if (!repairs.includes('pwm-alarm')) repairs.push('pwm-alarm');
  }
  return { smartCurrentCycleStarted };
}

async function repairEnabledDiagnosticRuntime(repairs) {
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
    return createDeferredPhaseAdoptionDiagnosticRepair();
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
  pwmAlarm = await chrome.alarms.get('ac-pwm');
  if (pwmNeededRepair && pwmAlarm) repairs.push('pwm-alarm');
  const { smartCurrentCycleStarted } = recordDiagnosticLifecycleRepairs(repairs, {
    lifecycle: diagnosticLifecycleRecovery,
    previousPwmState: diagnosticPwmStateBefore,
    previousPwmAlarmAt: diagnosticPwmAlarmAtBefore,
    currentPwmAlarmAt: Number(pwmAlarm?.scheduledTime)
  });

  // 活闹钟存在但 storage 可能缺失 nextTriggerAt → 直接回写（不依赖 syncStoredTriggerFromAlarm 的边界判断）
  // 当前周期恢复已启动时，pwmAlarm 仍可能是恢复前的 23:00 旧快照；此处回写会
  // 在同一 revision 内把旧钟重新认领为真相。等 executor 预置 timer/开机并写入
  // 新绝对截止后再由下一轮诊断校准，in-flight 阶段禁止触碰 trigger storage。
  let triggerPlan = null;
  if (!smartCurrentCycleStarted) {
    const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();
    try {
      if (phaseAdmissionEpoch > 0) {
        const reconciliationRevision = pwmRuntimeRevision;
        const reconciliationAlarm = await chrome.alarms.get('ac-pwm');
        triggerPlan = await persistReconciledPwmTrigger(
          reconciliationAlarm,
          'ensureDiagnosticAlarms',
          PWM_TRIGGER_NEXT_ONLY_OPTIONS,
          reconciliationRevision,
          phaseAdmissionEpoch
        );
      }
    } finally {
      if (phaseAdmissionEpoch > 0) {
        releaseSyncPhaseAdoptionAdmission(phaseAdmissionEpoch);
        drainDeferredScheduleRepair('diagnostic-trigger-sync-complete');
      }
    }
  }
  if (triggerPlan) {
    repairs.push('pwm-trigger');
  }

  const pwmStepInFlight = isCurrentPwmStepRunning() || comfortStartInFlight;

  return {
    result: {
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
        watchdog: watchdogAlarm ? {
          scheduledTime: watchdogAlarm.scheduledTime,
          periodInMinutes: watchdogAlarm.periodInMinutes
        } : null,
        pwm: pwmAlarm ? { scheduledTime: pwmAlarm.scheduledTime } : null,
        smartWeather: smartWeatherAlarm
          ? { scheduledTime: smartWeatherAlarm.scheduledTime }
          : null
      }
    },
    lifecycle: diagnosticLifecycleRecovery
  };
}

async function repairDiagnosticRuntime(repairs) {
  if (isSyncPhaseAdoptionAdmissionBlocked()) {
    return createDeferredPhaseAdoptionDiagnosticRepair();
  }
  if (!schedule.enabled) return repairDisabledDiagnosticRuntime(repairs);
  if (!isAutomationAllowed()) return repairPausedDiagnosticRuntime(repairs);
  return repairEnabledDiagnosticRuntime(repairs);
}

async function ensureDiagnosticAlarms() {
  const diagnosticRequestAt = Date.now();
  const repairs = [];
  const diagnosticBefore = await captureDiagnosticSnapshot();
  await loadScheduleFromStorage();
  const repair = await repairDiagnosticRuntime(repairs);
  if (repair.restart) return ensureDiagnosticAlarms();
  const diagnosticAfter = await captureDiagnosticSnapshot();
  return buildDiagnosticResultEnvelope({
    result: repair.result,
    requestAt: diagnosticRequestAt,
    before: diagnosticBefore,
    repairs,
    lifecycle: repair.lifecycle,
    after: diagnosticAfter
  });
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
  // 在任何 await（包括 initReady）之前记录用户最新开关意图。
  // 后到 OFF 可立即使排队中的旧 ON 失效；后到 ON 也会阻止
  // 旧 OFF 的页面定时器在真实页面上延迟落地。
  const hasDeclaredScheduleAutomationIntent = msg.type === 'updateSchedule'
    && msg.data != null
    && Object.prototype.hasOwnProperty.call(msg.data, 'automationIntent');
  const declaredScheduleAutomationIntent = hasDeclaredScheduleAutomationIntent
    ? String(msg.data.automationIntent || '')
    : '';
  const scheduleAutomationIntent = msg.type !== 'updateSchedule'
    ? ''
    : msg.data?.enabled === true
        && declaredScheduleAutomationIntent === 'enable'
      ? 'enable'
      : msg.data?.enabled === false
          && (declaredScheduleAutomationIntent === 'disable'
            || !hasDeclaredScheduleAutomationIntent)
        ? 'disable'
        : '';
  const localScheduleMutationGenerationAtArrival =
    msg.type === 'updateSchedule' || msg.type === 'toggleNow'
      ? claimLocalScheduleMutationIntent()
      : localScheduleMutationGeneration;
  let localScheduleAuthorityGenerationAtArrival =
    localScheduleAuthorityGeneration;
  if (scheduleAutomationIntent === 'enable'
      || scheduleAutomationIntent === 'disable') {
    localScheduleAuthorityGenerationAtArrival =
      ++localScheduleAuthorityGeneration;
    localScheduleAuthorityObservedAt = nextSyncAuthorityObservedAt();
  }
  if (scheduleAutomationIntent
      && deferredSyncDisablePending
      && deferredSyncDisableLocalScheduleAuthorityGeneration
        !== localScheduleAuthorityGenerationAtArrival) {
    startupDeferredDisableSupersededByUserIntent = true;
  }
  const explicitScheduleEnableIntentEpoch = scheduleAutomationIntent === 'enable'
    ? claimManualToggleIntent('on')
    : 0;
  const explicitScheduleDisableIntentEpoch = scheduleAutomationIntent === 'disable'
    ? claimManualToggleIntent('disable')
    : 0;
  const explicitScheduleDisableAdmissionEpoch = scheduleAutomationIntent === 'disable'
    ? preemptAutomaticOnForExplicitDisable()
    : 0;
  const scheduleAuthorityRemoteDisableGenerationAtArrival =
    remoteDisableArrivalGeneration;
  // 明确停用一到达就预约主世界取消。durable config 写若阻塞或失败，
  // 也不能让已经发出的旧自动 ON 因为“尚未进入 finish”而失去取消机会。
  const explicitScheduleDisablePreemptionPromise =
    scheduleAutomationIntent === 'disable'
      ? queueManualOffAutomaticOnCancellation({
          claimRevision: false,
          holdManualOffAdmission: false
        })
      : Promise.resolve();
  const scheduleUpdateAdmissionEpochAtArrival = automaticDisableAdmissionEpoch;
  const manualToggleRequestAction = msg?.action === 'off' ? 'off' : 'on';
  const manualToggleRequestEpoch = msg.type === 'toggleNow'
    ? claimManualToggleIntent(manualToggleRequestAction)
    : 0;
  if (msg.type === 'toggleNow') {
    manualTogglePhaseCommitPendingEpoch = manualToggleRequestEpoch;
  }
  const manualToggleAutomaticAdmissionEpoch = automaticDisableAdmissionEpoch;
  const manualOffAdmission = msg.type === 'toggleNow'
      && manualToggleRequestAction === 'off'
    ? beginDurableManualOffAdmission(
        manualToggleRequestEpoch,
        localScheduleMutationGenerationAtArrival
      )
    : null;
  const manualOffPreemptionPromise = msg.type === 'toggleNow'
      && manualToggleRequestAction === 'off'
    ? queueManualOffAutomaticOnCancellation()
    : Promise.resolve();

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
        manualOffAutomaticOnBlocked,
        manualOffAdmissionLoaded,
        manualOffAdmissionPending: !!manualOffAdmissionToken,
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
      const updateAdmissionEpoch = scheduleUpdateAdmissionEpochAtArrival;
      const explicitDisablePreviousEnabled = scheduleAutomationIntent === 'disable'
        ? schedule.enabled === true
        : null;
      let explicitDisableAdmissionEpoch = explicitScheduleDisableAdmissionEpoch;
      let explicitDisableDurablyPersisted = false;
      let explicitEnableDurablyPersisted = false;
      let explicitEnableFalseAdmissionDurablyPersisted = false;
      let scheduleBeforeExplicitEnable = null;
      let explicitEnableFalseAdmissionSnapshot = null;
      let explicitDisableIntentPromise = null;
      let updatePhaseAdmissionEpoch = 0;
      const cloneScheduleForUpdateRollback = source => source
        ? {
            ...source,
            activeHours: { ...(source.activeHours || {}) },
            smartMode: { ...(source.smartMode || {}) }
          }
        : null;
      try {
        if (scheduleAutomationIntent === 'disable') {
          // 先同步 claim revision/admission，再把 enabled=false 与 publish
          // marker 作为第一个异步 I/O 原子落盘。清 alarm／content request
          // 可能很慢，绝不能排在 durable disable intent 前面。
          schedule.enabled = false;
          const explicitDisableIsCurrent = () => (
            explicitDisableAdmissionEpoch > 0
            && explicitDisableAdmissionEpoch === automaticDisableAdmissionEpoch
            && localScheduleAuthorityGenerationAtArrival
              === localScheduleAuthorityGeneration
            && scheduleAuthorityRemoteDisableGenerationAtArrival
              === remoteDisableArrivalGeneration
          );
          explicitDisableIntentPromise = (async () => {
            const mutationIntentCommitted =
              await commitLocalScheduleMutationAuthority(
                localScheduleMutationGenerationAtArrival,
                'updateSchedule-disable-local-mutation-intent'
              );
            if (!mutationIntentCommitted) {
              throw new Error('明确停用的本机 mutation intent 未持久化');
            }
            // sync preflight 可能阻塞/失败，但本机明确 OFF 的页面保险不能
            // 因跨设备读取而延后。M intent 已 durable 后立即并行布防；
            // 后到 enable 会换 admission/intent，使这张旧票自行 stale。
            const [emergencyShutdownResult, remoteSafetyReady] =
              await Promise.all([
                requestTimerBasedShutdown(
                  'updateSchedule-disable-preflight',
                  1,
                  { ensureCurrent: explicitDisableIsCurrent }
                ),
                refreshRemoteDisableBeforeLocalRelease(
                  explicitDisableIsCurrent,
                  'updateSchedule-disable'
                )
              ]);
            if (!emergencyShutdownResult?.success) {
              schedule.pageTimerError =
                `明确停用已保存，但页面关机保险未确认：${emergencyShutdownResult?.error || '未知错误'}`;
            }
            if (!remoteSafetyReady || !explicitDisableIsCurrent()) {
              throw new Error('明确停用发布前未能确认远端 Lamport safety');
            }
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                const committed =
                  await commitScheduleAuthority({
                    ensureCurrent: explicitDisableIsCurrent,
                    markSyncPublishPending: true,
                    clearDeferredSyncDisable: true,
                    reason: 'updateSchedule-disable-admission-intent'
                  });
                if (committed) return true;
                break;
              } catch (error) {
                lastError = error;
                if (!explicitDisableIsCurrent()) throw error;
              }
            }
            throw lastError
              || new Error('明确停用已被后续自动控制或远端停用替代');
          })();
          // 这是“前序写已 settle”的栅栏，不是永久错误槽。失败由所属的
          // updateSchedule 请求处理；后续一次性手动 ON 只需等它收口，不能
          // 永久重放历史 rejection。
          explicitDisableDurableWriteChain = explicitDisableIntentPromise
            .catch(() => {});
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
        if (isManualToggleIntentCurrent(
          explicitScheduleDisableIntentEpoch,
          'disable'
        )) {
          const released = await releaseManualOffAdmissionForAuthority(
            explicitScheduleDisableIntentEpoch,
            'disable'
          );
          if (!released && isManualToggleIntentCurrent(
            explicitScheduleDisableIntentEpoch,
            'disable'
          )) {
            throw new Error('明确停用已保存，但手动关机准入未能安全释放');
          }
        }
        await scheduleSyncRetry('publish');
        await finishExplicitDisablePreemption(
          explicitScheduleDisablePreemptionPromise
        );
      }
      // 设置更新、sync/page adoption 与 active-boundary 必须使用同一把相位
      // admission。旧边界若正在长页面 I/O，这里等待它完整收口并直接接棒；
      // 新配置尚未写入 schedule，因此旧事务不会看到半新半旧的 activeHours。
      updatePhaseAdmissionEpoch = await claimSyncPhaseAdoptionAdmissionWhenAvailable();
      const staleByExplicitDisable = () => scheduleAutomationIntent !== 'disable'
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

      const scheduleBeforeOrdinaryMutation = scheduleAutomationIntent === ''
        ? {
            ...schedule,
            activeHours: { ...(schedule.activeHours || {}) },
            smartMode: { ...(schedule.smartMode || {}) }
          }
        : null;
      const rollbackOrdinaryMutation = () => {
        if (!scheduleBeforeOrdinaryMutation) return;
        // ordinary config 无权改变 enabled；后到 explicit disable 却会在
        // queue 外同步置 false。回滚失败 M 的配置字段时保留该安全门禁。
        const enabledAfterConcurrentAuthority = schedule.enabled;
        schedule = {
          ...scheduleBeforeOrdinaryMutation,
          enabled: enabledAfterConcurrentAuthority,
          activeHours: {
            ...(scheduleBeforeOrdinaryMutation.activeHours || {})
          },
          smartMode: {
            ...(scheduleBeforeOrdinaryMutation.smartMode || {})
          }
        };
      };

      const wasEnabled = explicitDisablePreviousEnabled === null
        ? schedule.enabled
        : explicitDisablePreviousEnabled;
      const wasAutomationAllowed = isAutomationAllowed();
      if (scheduleAutomationIntent === 'enable') {
        scheduleBeforeExplicitEnable =
          cloneScheduleForUpdateRollback(schedule);
        // enabled=true 只有 durable authority commit 后才有资格启动自动 ON。
        // 该临时 admission 也覆盖 storage I/O 失败留下的内存半提交。
        automaticOnAdmissionBlocked = true;
      }
      const previousActiveHours = JSON.stringify(schedule.activeHours);
      // 防止 restart 泄漏到 schedule 对象中；手动时长单独取出，智能模式下不上送覆盖。
      const {
        restart,
        automationIntent: _automationIntent,
        enabled: _requestedEnabled,
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
        enabled: scheduleAutomationIntent === 'enable'
          ? true
          : scheduleAutomationIntent === 'disable'
            ? false
            : schedule.enabled,
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
      const explicitEnableIsCurrent = () => (
        scheduleAutomationIntent === 'enable'
        && updateAdmissionEpoch === automaticDisableAdmissionEpoch
        && localScheduleAuthorityGenerationAtArrival
          === localScheduleAuthorityGeneration
        && scheduleAuthorityRemoteDisableGenerationAtArrival
          === remoteDisableArrivalGeneration
      );
      // 用户目标 schedule 已完整合并；在任何页面/闹钟长事务前，先原子
      // durable schedule + M cutoff + exact pre-M T tombstone。后续即使 SW
      // 终止，旧 successor 也不能跨重启覆盖已经落盘的用户设置。
      let localMutationIntentCommitted = false;
      const requestedExplicitEnable = scheduleAutomationIntent === 'enable'
        ? schedule.enabled
        : null;
      if (requestedExplicitEnable !== null) {
        // 任何明确 enable 都不能在 remote Lamport preflight 前
        // durable true（包括 true→true）。先提交 config/M cutoff + OFF
        // admission；preflight 成功后 commitScheduleAuthority 才完成
        // 第二阶段 true authority。
        schedule.enabled = false;
        explicitEnableFalseAdmissionSnapshot =
          cloneScheduleForUpdateRollback(
            snapshotScheduleForLocalPersistence()
          );
      }
      try {
        localMutationIntentCommitted =
          await commitLocalScheduleMutationAuthority(
            localScheduleMutationGenerationAtArrival,
            'updateSchedule-local-mutation-intent'
          );
      } catch (error) {
        rollbackOrdinaryMutation();
        throw error;
      }
      if (!localMutationIntentCommitted) {
        rollbackOrdinaryMutation();
        throw new Error('本机设置 intent 未持久化');
      }
      if (requestedExplicitEnable !== null) {
        explicitEnableFalseAdmissionDurablyPersisted = true;
        if (explicitEnableIsCurrent()) {
          schedule.enabled = requestedExplicitEnable;
        }
      }
      // 天气只由 :20/:50 的 ac-smart-weather 预取（setupAlarms 已调度），此处不即时拉取。

      const activeHoursChanged = previousActiveHours !== JSON.stringify(schedule.activeHours);
      const automationAllowed = scheduleAutomationIntent === 'enable'
        ? manualOffAdmissionLoaded
          && !manualOffAutomaticOnBlocked
          && deferredSyncDisableLoaded
          && !deferredSyncDisablePending
          && isAutomationAllowedForSchedule(schedule)
        : isAutomationAllowed();
      const comfortRequested = !wasEnabled && schedule.enabled;
      let offResult = null;
      let comfortStart = null;
      let startImmediately = false;
      if (!schedule.enabled) {
        if (wasEnabled || scheduleAutomationIntent === 'disable') {
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

      if (scheduleAutomationIntent === 'enable') {
        const remoteSafetyReady =
          await refreshRemoteDisableBeforeLocalRelease(
            explicitEnableIsCurrent,
            'updateSchedule-enable',
            { waitForExistingOutbound: true }
          );
        if (!remoteSafetyReady || !explicitEnableIsCurrent()) {
          throw new Error('明确启用发布前未能确认远端 Lamport safety');
        }
        let committed = false;
        let lastEnableCommitError = null;
        for (let attempt = 0; attempt < 2 && !committed; attempt += 1) {
          try {
            committed = await commitScheduleAuthority({
              ensureCurrent: explicitEnableIsCurrent,
              markSyncPublishPending: true,
              clearDeferredSyncDisable: true,
              reason: 'updateSchedule-enable'
            });
            if (!committed) break;
          } catch (error) {
            lastEnableCommitError = error;
            if (!explicitEnableIsCurrent()) throw error;
          }
        }
        if (!committed) {
          throw lastEnableCommitError
            || new Error('明确启用已被后续自动控制或远端停用替代');
        }
        explicitEnableDurablyPersisted = true;
        if (isManualToggleIntentCurrent(
          explicitScheduleEnableIntentEpoch,
          'on'
        )) {
          const released = await releaseManualOffAdmissionForAuthority(
            explicitScheduleEnableIntentEpoch,
            'on'
          );
          if (!released && isManualToggleIntentCurrent(
            explicitScheduleEnableIntentEpoch,
            'on'
          )) {
            throw new Error('明确启用已保存，但手动关机准入未能安全释放');
          }
        }
      } else {
        await persistSchedule('updateSchedule');
      }
      if (staleByExplicitDisable()) {
        throw new Error('设置请求已被更晚的明确停用取消');
      }
      if (scheduleAutomationIntent === 'disable') {
        explicitDisableDurablyPersisted = true;
      } else if (scheduleAutomationIntent === 'enable'
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
        const setupSucceeded = await setupAlarms(startImmediately, {
          phaseAdmissionEpoch: updatePhaseAdmissionEpoch
        });
        if (schedule.enabled && isAutomationAllowed() && !setupSucceeded) {
          throw new Error('设置已保存，但 PWM 主钟未收口');
        }
      }
      // 管理看门狗和每分钟 PWM 心跳闹钟
      if (isAutomationAllowed()) {
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      }
      // active hours 边界闹钟：每次 schedule 改变都重新调度
      await rescheduleActiveBoundary();
      // [v0.5.6] 跨设备同步：用户改设置 / toggle 是低频事件，立即推送
      // 在 sendResponse 之前完成推送，让 popup 拿到已推送的状态（虽然异步到达对端有时延）。
      await syncScheduleToSync('updateSchedule');
      if (scheduleAutomationIntent === 'enable'
          || scheduleAutomationIntent === 'disable') {
        const completionPersisted =
          await finalizeCompletedManualToggleAuthority(
          scheduleAutomationIntent === 'enable'
            ? explicitScheduleEnableIntentEpoch
            : explicitScheduleDisableIntentEpoch,
          scheduleAutomationIntent === 'enable' ? 'on' : 'disable',
          Number(localScheduleMutationObservedAtByGeneration.get(
            localScheduleMutationGenerationAtArrival
          )) || localScheduleMutationCommittedObservedAt
        );
        if (!completionPersisted) {
          throw new Error('本机自动化 authority 未能终态覆盖迟显 OFF 凭证');
        }
      }
      sendResponse({ success: true, schedule, offResult, comfortStart });
        });
      } catch (error) {
        // recovery 会重新进入 schedule->phase FIFO；先归还本 update 已借的
        // phase owner，否则 catch 等 recovery、recovery 等 finally 形成自锁。
        if (updatePhaseAdmissionEpoch > 0) {
          releaseSyncPhaseAdoptionAdmission(updatePhaseAdmissionEpoch);
          drainDeferredScheduleRepair('update-schedule-failed-before-recovery');
          updatePhaseAdmissionEpoch = 0;
        }
        if (scheduleAutomationIntent === 'enable'
            && !explicitEnableDurablyPersisted
            && scheduleBeforeExplicitEnable) {
          // 第一阶段 M 已把“本次新 config + enabled=false”原子落盘时，
          // 失败回滚必须保留同一快照；回到旧 config 会让内存和 durable
          // 状态分叉，并使下一次 load/persist 的结果取决于交错。
          schedule = cloneScheduleForUpdateRollback(
            explicitEnableFalseAdmissionDurablyPersisted
              ? explicitEnableFalseAdmissionSnapshot
              : scheduleBeforeExplicitEnable
          );
        }
        const failedIntentEpoch = scheduleAutomationIntent === 'enable'
          ? explicitScheduleEnableIntentEpoch
          : scheduleAutomationIntent === 'disable'
            ? explicitScheduleDisableIntentEpoch
            : 0;
        const failedIntentAction = scheduleAutomationIntent === 'disable'
          ? 'disable'
          : 'on';
        if (failedIntentEpoch > 0) {
          const failedUpdateAuthorityIsCurrent = () => (
            isManualToggleIntentCurrent(
              failedIntentEpoch,
              failedIntentAction
            )
            && localScheduleAuthorityGenerationAtArrival
              === localScheduleAuthorityGeneration
            && scheduleAuthorityRemoteDisableGenerationAtArrival
              === remoteDisableArrivalGeneration
            && (scheduleAutomationIntent === 'disable'
              ? explicitDisableAdmissionEpoch > 0
                && explicitDisableAdmissionEpoch
                  === automaticDisableAdmissionEpoch
              : scheduleAutomationIntent === 'enable'
                ? updateAdmissionEpoch === automaticDisableAdmissionEpoch
                : true)
          );
          await recoverSafetyAfterFailedUserAuthority(
            failedIntentEpoch,
            failedIntentAction,
            `updateSchedule-${scheduleAutomationIntent}-failed`,
            { ensureCurrent: failedUpdateAuthorityIsCurrent }
          );
        }
        throw error;
      } finally {
        if (explicitScheduleDisableAdmissionEpoch > 0) {
          // 成功路径已经在 finish 中等待；失败路径也必须把入场时预约的
          // cancel 票接到本次 message event 生命周期，不能留下会随 MV3
          // Service Worker 一起终止的裸 Promise。
          await explicitScheduleDisablePreemptionPromise.catch(() => {});
        }
        if (updatePhaseAdmissionEpoch > 0) {
          releaseSyncPhaseAdoptionAdmission(updatePhaseAdmissionEpoch);
          drainDeferredScheduleRepair('update-schedule-complete');
        }
        if (explicitDisableAdmissionEpoch > 0 && explicitDisableDurablyPersisted) {
          releaseExplicitDisableAdmission(explicitDisableAdmissionEpoch);
        }
        releaseStartupRestoreSupersession(
          scheduleAutomationIntent === 'enable'
            ? explicitScheduleEnableIntentEpoch
            : scheduleAutomationIntent === 'disable'
              ? explicitScheduleDisableIntentEpoch
              : 0
        );
        finishLocalScheduleMutationCommit(
          localScheduleMutationGenerationAtArrival
        );
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
      if (msg.action === 'off') {
        const admissionToken = manualOffAdmission?.token || '';
        const manualOffIsCurrent = () => (
          isManualToggleIntentCurrent(
            manualToggleRequestEpoch,
            'off'
          )
          && manualOffAutomaticOnBlocked
          && manualOffAdmissionToken === admissionToken
        );
        const result = await runManualOffAdmissionFlight(
          admissionToken,
          async () => {
            const admissionReceipt = await manualOffAdmission?.durablePromise;
            await manualOffPreemptionPromise;
            if (!manualOffIsCurrent()) {
              return {
                success: false,
                requestStale: true,
                error: '手动关机准入未持久化或已被后续用户操作替代'
              };
            }
            const immediatePromise = toggleNowAndSync('off', {
              ensureCurrent: manualOffIsCurrent
            });
            const mutationIntentPromise =
              commitLocalScheduleMutationAuthority(
                localScheduleMutationGenerationAtArrival,
                'toggleNow-off-local-mutation-intent'
              );
            void mutationIntentPromise.catch(() => {});
            // immediate timer 一启动就同步登记 schedule→phase successor；callback
            // 可以等 timer，但后到 repair/watchdog 已无法插队延长 1 分钟关机。
            const finalResult = await runSerializedSchedulePhaseOperation(
              async phaseAdmissionEpoch => {
                const [immediateResult, mutationIntentCommitted] =
                  await Promise.all([
                    immediatePromise,
                    mutationIntentPromise
                  ]);
                if (!mutationIntentCommitted) {
                  throw new Error('手动关机的本机 mutation intent 未持久化');
                }
                if (!manualOffIsCurrent()) return immediateResult;
                const phaseResult = await finalizeManualOffAutomationPhase(
                  phaseAdmissionEpoch,
                  manualOffIsCurrent,
                  admissionToken
                );
                return { ...phaseResult, immediateResult };
              },
              'manual-toggle-off'
            );
            return {
              ...finalResult,
              ...(!admissionReceipt?.persisted
                ? { admissionWarning: admissionReceipt?.error || '' }
                : {})
            };
          }
        );
        if (result?.success
            && isManualToggleIntentCurrent(
              manualToggleRequestEpoch,
              'off'
            )) {
          const completionPersisted =
            await finalizeCompletedManualToggleAuthority(
            manualToggleRequestEpoch,
            'off',
            Number(localScheduleMutationObservedAtByGeneration.get(
              localScheduleMutationGenerationAtArrival
            )) || localScheduleMutationCommittedObservedAt
          );
          if (!completionPersisted) {
            throw new Error('手动关机 authority 未能终态覆盖迟显 OFF 凭证');
          }
        }
        finishManualTogglePhaseCommit(manualToggleRequestEpoch);
        finishLocalScheduleMutationCommit(
          localScheduleMutationGenerationAtArrival
        );
        sendResponse(result);
        return;
      }
      const manualOnIsCurrent = () => (
        manualToggleAutomaticAdmissionEpoch === automaticDisableAdmissionEpoch
        && scheduleAuthorityRemoteDisableGenerationAtArrival
          === remoteDisableArrivalGeneration
        && isManualToggleIntentCurrent(
          manualToggleRequestEpoch,
          'on'
        )
      );
      let result;
      try {
        // 先到的 explicit disable 必须先把 automation=false durable；manual ON
        // 只是一回物理动作，不能用自己的 actuator epoch 取消该终止 authority。
        await explicitDisableDurableWriteChain;
        await waitForScheduleUpdatesToSettle();
        result = await runSerializedSchedulePhaseOperation(
          async phaseAdmissionEpoch => {
          if (!manualOnIsCurrent()) {
            return {
              success: false,
              phaseStale: true,
              error: '手动开机请求已被后续设置或开关意图替代'
            };
          }
          const mutationIntentCommitted =
            await commitLocalScheduleMutationAuthority(
              localScheduleMutationGenerationAtArrival,
              'toggleNow-on-local-mutation-intent'
            );
          if (!mutationIntentCommitted) {
            throw new Error('手动开机的本机 mutation intent 未持久化');
          }
          const remoteSafetyReady =
            await refreshRemoteDisableBeforeLocalRelease(
              manualOnIsCurrent,
              'toggleNow-on',
              { waitForExistingOutbound: true }
            );
          if (!remoteSafetyReady || !manualOnIsCurrent()) {
            return {
              success: false,
              phaseStale: !manualOnIsCurrent(),
              remoteSafetyReadPending: !remoteSafetyReady,
              error: '手动开机前未能确认远端停用状态，保持自动 ON 阻断'
            };
          }
          const consumeDeferredDisable = async () => {
            schedule.enabled = false;
            const consumed = await commitScheduleAndReleaseManualOffAdmission({
              ensureCurrent: manualOnIsCurrent,
              markSyncPublishPending: true,
              clearDeferredSyncDisable: true,
              preserveDeferredSyncSuccessor: true,
              reason: 'toggleNowAndSync-on-consume-deferred-disable'
            });
            if (consumed && manualOnIsCurrent()) {
              await resetDisabledPwmRuntime();
            }
            return consumed;
          };
          if (manualOffAutomaticOnBlocked
              || manualOffAdmissionToken
              || deferredSyncDisablePending) {
            let released;
            if (deferredSyncDisablePending) {
              // 手动 ON 不等于重新启用自动控制。先原子消费远端 disable，
              // durable schedule 保持 disabled，再清旧自动 runtime，最后才
              // 执行这一次物理 ON。
              released = await consumeDeferredDisable();
            } else {
              released = await releaseManualOffAdmissionForManualOn(
                manualToggleRequestEpoch
              );
              if (!released
                  && deferredSyncDisablePending
                  && manualOnIsCurrent()) {
                released = await consumeDeferredDisable();
              }
            }
            if (!released || !manualOnIsCurrent()) {
              return {
                success: false,
                phaseStale: true,
                error: '手动开机未能取得持久准入'
              };
            }
          }
          // 远端 F 的 transient automatic-ON admission 可能由刚被本次 ON
          // 抢占的 settle owner 持有。schedule 仍是 durable false；释放这把
          // 临时锁只允许后继 T 被采纳，不会把一次性物理 ON 误当成自动启用。
          if (manualOnIsCurrent()) {
            releaseExplicitDisableAdmission(
              manualToggleAutomaticAdmissionEpoch
            );
          }
          const toggleResult = await toggleNowAndSync('on', {
            phaseAdmissionEpoch,
            ensureCurrent: manualOnIsCurrent
          });
          if (!manualOnIsCurrent()) {
            return {
              success: false,
              phaseStale: true,
              error: '手动开机请求在页面操作期间失去 authority'
            };
          }
          await syncScheduleToSync('toggleNowAndSync-on');
          if (!manualOnIsCurrent()) {
            return {
              success: false,
              phaseStale: true,
              error: '手动开机请求在同步收口期间失去 authority'
            };
          }
          return toggleResult;
          },
          'manual-toggle-on'
        );
      } catch (error) {
        await recoverSafetyAfterFailedUserAuthority(
          manualToggleRequestEpoch,
          'on',
          'manual-toggle-on-failed',
          { ensureCurrent: manualOnIsCurrent }
        );
        throw error;
      }
      if (result?.success && !manualOnIsCurrent()) {
        result = {
          ...result,
          success: false,
          phaseStale: true,
          error: '手动开机完成前已被后续 safety authority 替代'
        };
      } else if (result?.success) {
        const completionPersisted =
          await finalizeCompletedManualToggleAuthority(
            manualToggleRequestEpoch,
            'on',
            Number(localScheduleMutationObservedAtByGeneration.get(
              localScheduleMutationGenerationAtArrival
            )) || localScheduleMutationCommittedObservedAt
          );
        if (!completionPersisted) {
          result = manualOnIsCurrent()
            ? {
                ...result,
                success: false,
                error: '手动开机 authority 未能终态覆盖迟显 OFF 凭证'
              }
            : {
                ...result,
                success: false,
                phaseStale: true,
                error: '手动开机终态写入时已被后续 safety authority 替代'
              };
        }
      }
      const safetyRecovery = !result?.success && manualOnIsCurrent()
        ? await recoverSafetyAfterFailedUserAuthority(
            manualToggleRequestEpoch,
            'on',
            'manual-toggle-on-unsuccessful',
            { ensureCurrent: manualOnIsCurrent }
          )
        : null;
      finishManualTogglePhaseCommit(manualToggleRequestEpoch);
      finishLocalScheduleMutationCommit(
        localScheduleMutationGenerationAtArrival
      );
      sendResponse({
        ...result,
        ...(safetyRecovery ? { safetyRecovery } : {})
      });
      return;
    }
    if (msg.type === 'ensureDiagnostics') {
      const result = await ensureDiagnosticAlarms();
      sendResponse(result);
      return;
    }
  })().catch((e) => {
    if (msg?.type === 'toggleNow') {
      finishManualTogglePhaseCommit(manualToggleRequestEpoch);
      finishLocalScheduleMutationCommit(
        localScheduleMutationGenerationAtArrival
      );
    } else if (msg?.type === 'updateSchedule') {
      releaseStartupRestoreSupersession(
        scheduleAutomationIntent === 'enable'
          ? explicitScheduleEnableIntentEpoch
          : scheduleAutomationIntent === 'disable'
            ? explicitScheduleDisableIntentEpoch
            : 0
      );
    }
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
      await runSerializedCriticalLocalStateWrite(() => (
        chrome.storage.local.set({
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
        })
      ));
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
        await runSerializedSchedulePhaseOperation(
          () => runComfortStart('install'),
          'install-comfort-start'
        );
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
    // STORAGE_KEY 的唯一 writer 是本 background；persistSchedule 写入前的
    // schedule 才是当前事务 owner。延迟到达的本地 onChanged 若反向 merge，
    // 会把 await 之后的新 phase/page proof 覆盖成刚落盘的旧快照。
    // 其他上下文只通过消息提交设置，真正的启动恢复显式走
    // loadScheduleFromStorage()，因此这里仅消费自写通知，禁止隐式回灌。
    return;
  }

  if (areaName === 'sync' && changes[SYNC_KEY]?.newValue) {
    const incomingSyncValue = changes[SYNC_KEY].newValue;
    const incomingIdentity = getSyncPayloadIdentity(incomingSyncValue);
    const knownLocalEcho = incomingIdentity
      && activeLocalSyncEchoIdentities.delete(incomingIdentity);
    if (knownLocalEcho) {
      console.log('[AC扩展] sync ↓ onChanged：已消费本机完整 payload echo');
      return;
    }
    if (incomingSyncValue.enabled === false
        && hasDurableCompletedSyncPayloadReceiptBeforeCurrentMutation(
          incomingSyncValue
        )) {
      // sync.set 的 Promise 可先于 onChanged 投递完成。若其间更晚本机 M
      // 已 durable，active echo ticket 又恰好过期，exact completed payload
      // 仍只是该 M 的本机 predecessor；不得把晚投递通知误升格成新远端 F。
      console.log('[AC扩展] sync ↓ onChanged：已忽略 durable 本机 predecessor');
      return;
    }
    syncInboundArrivalGeneration += 1;
    if (incomingSyncValue.enabled === false) {
      remoteDisableArrivalGeneration += 1;
      // 后到 remote disable 在任何 schedule/phase owner 前同步 fail-close：
      // bump revision、持久登记、取消主世界 ON。真正采纳成功才清 pending。
      deferRemoteSyncDisableWhileManualOffBlocked(
        incomingSyncValue,
        'onChanged-sync-arrival'
      );
    }
    // [v0.5.6] 收到远端 sync 变更 → 异步合并到本地培训 + 重排闹钟。
    // 不在此 await（onChanged 是同步事件回调，不能阻塞）——tryAdoptSyncedState 自带 _syncOpLock
    // 互斥保证并发安全。applySyncedPhase 内部会触发 persistSchedule 触发一次 local 变更 →
    // 上面 local 分支自动同步内存（不会无限循环，因 sync 写采用 lastSyncedAt 守卫）。
    console.log('[AC扩展] sync ↓ onChanged：收到远端变更，启动异步合并');
    void waitUntil(
      tryAdoptSyncedState('onChanged-sync', incomingSyncValue)
    ).catch(e => console.warn('[AC扩展] onChanged sync 合并失败:', e?.message));
  }
});

// ----- 启动 -----
init();
