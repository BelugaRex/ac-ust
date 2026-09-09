// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

// i18n 辅助函数 — 使用 fetch-based I18n 模块（绕过 chrome.i18n 不可靠性）
importScripts('i18n.js');
importScripts('sync-helpers.js');  // 跨设备同步的纯函数（composeSyncPayload / computePhaseAdoption）
importScripts('schedule-mutations.js');
importScripts('smart-retry.js');
importScripts('pwm-retry.js');
importScripts('pwm-phase.js');  // PWM 阶段推进、恢复与 live alarm 对齐的纯决策
importScripts('smart-phase.js');  // 智能模式半点调度与绝对关机目标纯决策
importScripts('smart-recovery.js');
importScripts('interval-recovery.js');
importScripts('recovery-coordinator.js');
importScripts('smart-mode.js');  // 智能模式纯决策（computeSmartOnMinutes 等，无 chrome.* 副作用）
const t = (key, ...subs) => I18n.t(key, ...subs);

// ===== Packaged-only control lifecycle audit =====
// build.sh 在发布包中注入三项构建身份；源码/dev 环境保持禁用且零写入。
const BUILD_TIME = 'dev';
const BUILD_TIME_EPOCH_MS = 0;
const BUILD_SOURCE_SHA256 = 'dev';
const CONTROL_AUDIT_KEY = 'ac_dist_control_audit_v1';
const CONTROL_AUDIT_SCHEMA_VERSION = 1;
const CONTROL_AUDIT_MAX_EVENTS = 128;
const CONTROL_AUDIT_MISSED_WAKE_GRACE_MS = 60 * 1000;
const CONTROL_AUDIT_EVENT_FIELDS = Object.freeze([
  'seq',
  'at',
  'controlId',
  'attempt',
  'stage',
  'result',
  'code',
  'action',
  'scheduledAt',
  'originBoundaryAt',
  'targetAt',
  'retryAt',
  'build'
]);
const CONTROL_AUDIT_NUMBER_FIELDS = new Set([
  'seq',
  'at',
  'attempt',
  'scheduledAt',
  'originBoundaryAt',
  'targetAt',
  'retryAt'
]);
const CONTROL_AUDIT_ACTIVE_STRING_FIELDS = Object.freeze([
  'controlId',
  'action',
  'lastStage'
]);
const CONTROL_AUDIT_ACTIVE_NUMBER_FIELDS = Object.freeze([
  'attempt',
  'scheduledAt',
  'originBoundaryAt',
  'targetAt',
  'retryAt',
  'deliveryAt',
  'confirmedAt'
]);

let controlAuditStorageChain = Promise.resolve();

function isValidControlAuditManifestVersion(value) {
  const parts = typeof value === 'string' ? value.split('.') : [];
  return parts.length >= 1
    && parts.length <= 4
    && parts.every(part => /^(?:0|[1-9]\d*)$/.test(part)
      && Number(part) <= 65535);
}

function isValidControlAuditBuildTime(value) {
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
    : null;
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59;
}

function getPackagedControlAuditBuild() {
  const epoch = Number(BUILD_TIME_EPOCH_MS);
  const buildTime = String(BUILD_TIME || '');
  const sha256 = String(BUILD_SOURCE_SHA256 || '').toLowerCase();
  let version = '';
  try {
    version = String(chrome.runtime.getManifest().version || '');
  } catch (_) {
    return '';
  }
  if (!Number.isSafeInteger(epoch)
      || epoch <= 0
      || !isValidControlAuditBuildTime(buildTime)
      || !/^[a-f0-9]{64}$/.test(sha256)
      || !isValidControlAuditManifestVersion(version)) {
    return '';
  }
  return `${version}|${buildTime}|${epoch}|${sha256}`;
}

function sanitizeControlAuditString(value, maxLength = 160) {
  if (typeof value !== 'string') return '';
  if (/<[^>]{1,200}>/.test(value)
      || /(?:https?|chrome-extension|file):\/\/\S+/i.test(value)
      || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value)
      || /\b(?:tabid|account|balance|weather|schedule|document|dom|outerhtml|innerhtml)\b/i.test(value)
      || /账号|账户|余额|天气|日程|排程|调度对象/u.test(value)) {
    return '';
  }
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeControlAuditNumber(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  if ((field === 'seq' || field === 'attempt') && number < 1) return null;
  if (field === 'attempt') return Math.min(number, 9999);
  return number;
}

function sanitizeControlAuditEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = {};
  for (const field of CONTROL_AUDIT_EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (CONTROL_AUDIT_NUMBER_FIELDS.has(field)) {
      const number = sanitizeControlAuditNumber(value[field], field);
      if (number !== null) event[field] = number;
      continue;
    }
    const string = sanitizeControlAuditString(
      value[field],
      field === 'controlId' || field === 'build' ? 220 : 80
    );
    if (string) event[field] = string;
  }
  if (!event.seq
      || !event.at
      || !event.controlId
      || !event.attempt
      || !event.stage
      || !event.result
      || !event.action
      || !event.build) {
    return null;
  }
  return event;
}

function normalizeControlAuditActive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const active = {};
  for (const field of CONTROL_AUDIT_ACTIVE_STRING_FIELDS) {
    const string = sanitizeControlAuditString(
      value[field],
      field === 'controlId' ? 220 : 80
    );
    if (string) active[field] = string;
  }
  for (const field of CONTROL_AUDIT_ACTIVE_NUMBER_FIELDS) {
    const number = sanitizeControlAuditNumber(value[field], field);
    if (number !== null) active[field] = number;
  }
  active.awaitingRetry = value.awaitingRetry === true;
  active.attention = value.attention === true;
  if (!active.controlId
      || active.action !== 'on'
      || !active.attempt
      || !active.originBoundaryAt) {
    return null;
  }
  return active;
}

function createEmptyControlAuditEnvelope(build) {
  return {
    schemaVersion: CONTROL_AUDIT_SCHEMA_VERSION,
    build,
    nextSeq: 1,
    active: null,
    events: []
  };
}

function normalizeControlAuditEnvelope(value, build) {
  if (!value
      || typeof value !== 'object'
      || value.schemaVersion !== CONTROL_AUDIT_SCHEMA_VERSION
      || value.build !== build) {
    return createEmptyControlAuditEnvelope(build);
  }
  const events = Array.isArray(value.events)
    ? value.events
      .map(sanitizeControlAuditEvent)
      .filter(event => event?.build === build)
      .slice(-CONTROL_AUDIT_MAX_EVENTS)
    : [];
  const maximumSeq = events.reduce(
    (maximum, event) => Math.max(maximum, event.seq),
    0
  );
  const requestedNextSeq = sanitizeControlAuditNumber(value.nextSeq, 'seq');
  return {
    schemaVersion: CONTROL_AUDIT_SCHEMA_VERSION,
    build,
    nextSeq: Math.max(maximumSeq + 1, requestedNextSeq || 1),
    active: normalizeControlAuditActive(value.active),
    events
  };
}

function runControlAuditStorageMutation(mutate) {
  const build = getPackagedControlAuditBuild();
  if (!build) return Promise.resolve(null);

  const operation = controlAuditStorageChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(CONTROL_AUDIT_KEY);
      const envelope = normalizeControlAuditEnvelope(
        stored?.[CONTROL_AUDIT_KEY],
        build
      );
      const outcome = mutate(envelope, build) || {};
      if (outcome.changed === true) {
        await chrome.storage.local.set({ [CONTROL_AUDIT_KEY]: envelope });
      }
      return outcome.value ?? null;
    })
    .catch(() => null);
  controlAuditStorageChain = operation.then(() => {}, () => {});
  return operation;
}

function appendControlAuditEnvelopeEvent(envelope, value) {
  const event = sanitizeControlAuditEvent({
    ...value,
    seq: envelope.nextSeq,
    at: Date.now(),
    build: envelope.build
  });
  if (!event) return null;
  envelope.nextSeq += 1;
  envelope.events = [...envelope.events, event]
    .slice(-CONTROL_AUDIT_MAX_EVENTS);
  return event;
}

function createControlAuditId(build, action, originBoundaryAt) {
  return sanitizeControlAuditString(
    `control|${build}|${action}|${originBoundaryAt}`,
    220
  );
}

function getControlAuditHalfHourBoundary(value) {
  const timestamp = sanitizeControlAuditNumber(value, 'originBoundaryAt');
  if (!(timestamp > 0)) return 0;
  return Math.floor(timestamp / (30 * 60 * 1000)) * 30 * 60 * 1000;
}

function tightenControlAuditTargetAt(active, value) {
  const target = sanitizeControlAuditNumber(value, 'targetAt');
  const current = sanitizeControlAuditNumber(active?.targetAt, 'targetAt');
  if (target > 0 && (!(current > 0) || target < current)) {
    active.targetAt = target;
  }
  return sanitizeControlAuditNumber(active?.targetAt, 'targetAt') || 0;
}

function recordControlAuditPlanned({
  scheduledAt,
  originBoundaryAt = scheduledAt,
  targetAt = 0
} = {}) {
  return runControlAuditStorageMutation((envelope, build) => {
    const scheduled = sanitizeControlAuditNumber(scheduledAt, 'scheduledAt');
    const boundary = getControlAuditHalfHourBoundary(originBoundaryAt);
    const target = sanitizeControlAuditNumber(targetAt, 'targetAt');
    if (!(scheduled > 0) || !(boundary > 0)) return { changed: false };

    const controlId = createControlAuditId(build, 'on', boundary);
    if (envelope.active?.controlId === controlId) {
      envelope.active.scheduledAt = scheduled;
      tightenControlAuditTargetAt(envelope.active, target);
      return { changed: true, value: controlId };
    }
    if (envelope.active) {
      appendControlAuditEnvelopeEvent(envelope, {
        controlId: envelope.active.controlId,
        attempt: envelope.active.attempt,
        stage: 'terminal',
        result: 'superseded',
        code: 'next-boundary',
        action: 'on',
        scheduledAt: envelope.active.scheduledAt,
        originBoundaryAt: envelope.active.originBoundaryAt,
        targetAt: envelope.active.targetAt,
        retryAt: envelope.active.retryAt
      });
    }

    envelope.active = {
      controlId,
      attempt: 1,
      action: 'on',
      scheduledAt: scheduled,
      originBoundaryAt: boundary,
      targetAt: target > 0 ? target : 0,
      retryAt: 0,
      deliveryAt: 0,
      confirmedAt: 0,
      awaitingRetry: false,
      attention: false,
      lastStage: 'planned'
    };
    appendControlAuditEnvelopeEvent(envelope, {
      controlId,
      attempt: 1,
      stage: 'planned',
      result: 'ok',
      code: 'alarm-verified',
      action: 'on',
      scheduledAt: scheduled,
      originBoundaryAt: boundary,
      targetAt: target
    });
    return { changed: true, value: controlId };
  });
}

function appendActiveControlAuditEvent(stage, result, details = {}, update = null) {
  return runControlAuditStorageMutation((envelope) => {
    const active = envelope.active;
    if (!active) return { changed: false };
    if (typeof update === 'function') update(active);
    active.lastStage = sanitizeControlAuditString(stage, 80) || active.lastStage;
    const event = appendControlAuditEnvelopeEvent(envelope, {
      controlId: active.controlId,
      attempt: active.attempt,
      stage,
      result,
      code: details.code,
      action: 'on',
      scheduledAt: details.scheduledAt || active.scheduledAt,
      originBoundaryAt: active.originBoundaryAt,
      targetAt: active.targetAt,
      retryAt: details.retryAt || active.retryAt
    });
    return { changed: !!event, value: event };
  });
}

function recordControlAuditDelivery(scheduledAt) {
  return runControlAuditStorageMutation((envelope) => {
    const active = envelope.active;
    const scheduled = sanitizeControlAuditNumber(scheduledAt, 'scheduledAt');
    if (!active || !(scheduled > 0) || scheduled !== active.scheduledAt) {
      return { changed: false, value: false };
    }
    if (active.awaitingRetry) {
      active.attempt = Math.min(9999, active.attempt + 1);
    }
    active.awaitingRetry = false;
    active.deliveryAt = Date.now();
    active.lastStage = 'delivery';
    const event = appendControlAuditEnvelopeEvent(envelope, {
      controlId: active.controlId,
      attempt: active.attempt,
      stage: 'delivery',
      result: 'started',
      code: 'alarm-delivered',
      action: 'on',
      scheduledAt: scheduled,
      originBoundaryAt: active.originBoundaryAt,
      targetAt: active.targetAt,
      retryAt: active.retryAt
    });
    return { changed: !!event, value: event || false };
  });
}

function recordControlAuditAdmission(result, code) {
  return appendActiveControlAuditEvent('admission', result, { code });
}

function recordControlAuditTimerPrearm(result, targetAt = 0, code = '') {
  return appendActiveControlAuditEvent(
    'timer-prearm',
    result,
    { code, targetAt },
    active => {
      tightenControlAuditTargetAt(active, targetAt);
      if (result === 'failed') active.attention = true;
    }
  );
}

function recordControlAuditDispatch(code = 'dispatch-started') {
  return appendActiveControlAuditEvent('on-dispatch', 'started', { code });
}

function recordControlAuditOnOutcome(confirmed, code) {
  return appendActiveControlAuditEvent(
    confirmed ? 'on-confirmed' : 'on-failed',
    confirmed ? 'ok' : 'failed',
    { code },
    active => {
      if (confirmed) {
        active.confirmedAt = Date.now();
        active.attention = false;
      } else {
        active.attention = true;
      }
    }
  );
}

function recordControlAuditRetryScheduled(retryAt, code = 'retry-scheduled') {
  const retry = sanitizeControlAuditNumber(retryAt, 'retryAt');
  if (!(retry > 0)) return Promise.resolve(null);
  return appendActiveControlAuditEvent(
    'retry-scheduled',
    'ok',
    { code, scheduledAt: retry, retryAt: retry },
    active => {
      active.retryAt = retry;
      active.scheduledAt = retry;
      active.deliveryAt = 0;
      active.awaitingRetry = true;
      active.attention = true;
    }
  );
}

function recordControlAuditTerminal(result, code = '') {
  return runControlAuditStorageMutation((envelope) => {
    const active = envelope.active;
    if (!active) return { changed: false };
    const event = appendControlAuditEnvelopeEvent(envelope, {
      controlId: active.controlId,
      attempt: active.attempt,
      stage: 'terminal',
      result,
      code,
      action: 'on',
      scheduledAt: active.scheduledAt,
      originBoundaryAt: active.originBoundaryAt,
      targetAt: active.targetAt,
      retryAt: active.retryAt
    });
    active.lastStage = 'terminal';
    if (result === 'confirmed' || result === 'disabled') {
      envelope.active = null;
    } else {
      active.awaitingRetry = false;
      active.attention = true;
    }
    return { changed: !!event, value: event };
  });
}

function recordControlAuditMissedWake(source) {
  return runControlAuditStorageMutation((envelope) => {
    const active = envelope.active;
    const now = Date.now();
    if (!active
        || active.deliveryAt > 0
        || !(active.scheduledAt > 0)
        || active.scheduledAt + CONTROL_AUDIT_MISSED_WAKE_GRACE_MS > now
        || active.lastStage === 'terminal'
        || active.lastStage === 'missed-wake') {
      return { changed: false, value: false };
    }
    active.attention = true;
    active.lastStage = 'missed-wake';
    const event = appendControlAuditEnvelopeEvent(envelope, {
      controlId: active.controlId,
      attempt: active.attempt,
      stage: 'missed-wake',
      result: 'failed',
      code: source === 'watchdog' ? 'watchdog-overdue' : 'init-overdue',
      action: 'on',
      scheduledAt: active.scheduledAt,
      originBoundaryAt: active.originBoundaryAt,
      targetAt: active.targetAt,
      retryAt: active.retryAt
    });
    return { changed: !!event, value: !!event };
  });
}

function shouldShowControlAuditBadge() {
  return runControlAuditStorageMutation((envelope) => {
    const active = envelope.active;
    return {
      changed: false,
      value: !!active
        && active.action === 'on'
        && active.confirmedAt === 0
        && (active.deliveryAt > 0 || active.attention === true)
    };
  }).then(Boolean);
}

function flushControlAuditStorage() {
  return controlAuditStorageChain.catch(() => {});
}

const AC_PAGE = 'https://w5.ab.ust.hk/njggt/app/home';
const PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS = [10000, 15000, 20000];
// setTimer 写入超时必须覆盖 content.js 的有界最坏完成时间：
// 3 次输入尝试 ×（5s 稳定等待 + 3s OK + 3s 确认）+ 4s 定位 ≈ 39s。
// 若 30s 就超时，会在 content script 仍在重试时误报「探测超时」，掩盖真实失败阶段。
const PAGE_TIMER_WRITE_TIMEOUT_MS = 60000;
const STORAGE_KEY = 'ac_schedule';
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
// 通过 syncedAt 对比即可识别并静默跳过；同时承担 last-writer-wins 的本地参照。
const SYNC_KEY = 'ac_schedule_sync';
let lastSyncedAt = 0;

let schedule = {
  enabled: false,
  mode: 'pwm',
  clockMode: false,  // v0.5.x 起只保留间隔模式（false）。字段保留向后兼容，UI 不再暴露开关。
  onMinutes: 60,    // 间隔模式下默认开分钟数
  offMinutes: 60,   // 间隔模式下默认关分钟数
  pwmState: 'off',  // 下一次闹钟触发后要切换到的目标状态
  nextTriggerAt: 0,       // 当前阶段的绝对触发时间戳 (ms) — 传统间隔模式唯一真相源
  pwmClockPlannedAt: 0,
  smartState: 'on',       // Smart 分子自己的下一动作
  smartNextTriggerAt: 0,  // Smart 分子绑定的 ac-smart 绝对触发时间
  smartClockPlannedAt: 0,
  smartPlannedOnAt: 0,  // 连轴转退出后的补开锚点（可离开半点网格）
  alarmCreatedAt: 0,    // 闹钟创建时的时间戳 (ms) — 时钟模式不使用
  alarmDelayMinutes: 0,   // 闹钟设定的延迟 (分钟) — 时钟模式不使用
  pageTimerMinutes: null,
  pageTimerTargetAt: 0,
  pageTimerError: '',
  pageTimerRetryAt: 0,
  pageTimerRetryMinutes: 0,
  smartOnBoundaryAt: 0,
  smartOffSafetyTimerUsed: false,
  smartRetryKind: '',
  smartRetryBoundaryAt: 0,
  smartRetryScheduledAt: 0,
  pwmRetryKind: '',
  pwmRetryBoundaryAt: 0,
  pwmRetryScheduledAt: 0,
  activeHours: { enabled: false, start: '08:00', end: '23:00' },  // 两种自动控制共用的运行时段（白名单，同日）
  smartMode: { enabled: false, sensitivity: 5 }  // v0.8.0: 智能模式（天气驱动的开启时长，灵敏度 0~10 档位）
};

let pwmStepRunning = false;
let pwmStepRunningRevision = null;
let smartStepRunning = false;
let smartStepRunningRevision = null;
let pwmRuntimeRevision = 0;
let smartRuntimeRevision = 0;
let timerBasedShutdownRevision = 0;
let scheduleLoadBlockedRevision = null;
let lastPwmStepAt = 0;  // A4: 看门狗 cooldown 追踪
let lastSmartStepAt = 0;
let acToggleInFlight = null;
let acToggleInFlightAction = null;
let acToggleInFlightNotAfterAt = 0;
let acToggleInFlightRequiresAutomation = false;
let acToggleInFlightAutomationRevision = null;
let acToggleInFlightAutomationMode = null;
let acToggleInFlightControlTabId = null;

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

function claimPwmStepOwnership() {
  const automationRevision = pwmRuntimeRevision += 1;
  pwmStepRunning = true;
  pwmStepRunningRevision = automationRevision;
  return automationRevision;
}

function releasePwmStepOwnership(automationRevision) {
  if (pwmStepRunningRevision !== automationRevision) return false;
  lastPwmStepAt = Date.now();
  pwmStepRunning = false;
  pwmStepRunningRevision = null;
  return true;
}

function isCurrentSmartStepRunning() {
  return smartStepRunning && smartStepRunningRevision === smartRuntimeRevision;
}

function claimSmartStepOwnership() {
  const automationRevision = smartRuntimeRevision += 1;
  smartStepRunning = true;
  smartStepRunningRevision = automationRevision;
  return automationRevision;
}

function releaseSmartStepOwnership(automationRevision) {
  if (smartStepRunningRevision !== automationRevision) return false;
  lastSmartStepAt = Date.now();
  smartStepRunning = false;
  smartStepRunningRevision = null;
  return true;
}

const AUTOMATION_RUNTIME_ALARMS = new Set([
  'ac-pwm',
  'ac-smart',
  'ac-badge-tick',
  'ac-watchdog'
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

function isWithinActiveHours(now = new Date()) {
  const ah = schedule.activeHours;
  if (!ah || !ah.enabled) return true;  // 未启用 = 永远在时段内
  const start = parseHHMM(ah.start);
  const end = parseHHMM(ah.end);
  if (start < 0 || end < 0 || start >= end) return false;  // 非法配置安全暂停，等待用户修正
  const curMin = now.getHours() * 60 + now.getMinutes();
  return curMin >= start && curMin < end;
}

function isAutomationAllowed(now = new Date()) {
  return schedule.enabled && isWithinActiveHours(now);
}

function isAutomationOperationCurrent(automationRevision, automationMode = 'pwm') {
  const runtimeRevision = automationMode === 'smart'
    ? smartRuntimeRevision
    : pwmRuntimeRevision;
  if ((automationMode === 'smart') !== isSmartAutomationEnabled()) return false;
  return Number.isSafeInteger(automationRevision)
    && automationRevision === runtimeRevision
    && isAutomationAllowed();
}

async function abortStaleAutomation(
  automationRevision,
  reason,
  automationMode = 'pwm'
) {
  if (isAutomationOperationCurrent(automationRevision, automationMode)) return false;
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

  if (schedule.activeHours?.enabled && isWithinActiveHours(now)) {
    const activeBoundaryAt = getNextActiveBoundary(now);
    if (activeBoundaryAt > nowMs) {
      deadline = deadline > 0
        ? Math.min(deadline, activeBoundaryAt)
        : activeBoundaryAt;
    }
  }

  return deadline;
}

// 调度下一次 active hours 边界闹钟
async function rescheduleActiveBoundary() {
  try {
    await chrome.alarms.clear('ac-active-boundary');
  } catch (_) { /* ignore */ }
  const next = getNextActiveBoundary();
  if (!next) return;
  await createAlarm('ac-active-boundary', { when: next });
}

// 调度下一次 :10/:50 天气预取（智能模式启用时；否则清除闹钟）。
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
  // 重新调度下一次边界（先调度，避免后续 await 抛出时漏掉）
  await rescheduleActiveBoundary();

  // 提取（Fowler Extract Function）：退出运行时段暂停路径——B1 顺序：先 persist 已重置运行态再执行长流程关机。
  async function shutdownAfterActiveHoursLeave() {
    await resetDisabledAutomationRuntime();
    // B1（active-hours 离开）：先 persist 已重置运行态再执行长流程关机 — 与
    // updateSchedule、applySyncedPhase 同步停用路径保持顺序一致，避免 SW 在
    // verifyPageTimerPersistence 长流程中被杀导致闹钟自愈"复活" PWM。
    await persistSchedule('active-hours-leave-pre-shutdown', { syncFromLiveAlarm: false });
    const shutdownResult = await requestTimerBasedShutdown('active-hours-leave');
    if (!shutdownResult?.success) {
      schedule.pageTimerError = `退出运行时段后页面关机定时器未确认：${shutdownResult?.error || '未知错误'}`;
    }
  }

  const inside = isWithinActiveHours();
  if (inside && schedule.enabled) {
    // 进入运行时段 → 恢复用户已启用的自动控制
    console.log('[ac-ust] active hours: entering, resume automation');
    if (isSmartAutomationEnabled()) setSmartNextAction('on');
    else schedule.pwmState = 'on';
    await persistSchedule('active-hours-enter-pre-setup', { syncFromLiveAlarm: false });
    await setupAlarms(true);
    if (isAutomationAllowed()) {
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    }
  } else if (!inside && schedule.enabled) {
    // 退出运行时段 → 暂停自动控制并停机，但保留用户启用意图
    console.log('[ac-ust] active hours: leaving, pause automation');
    await shutdownAfterActiveHoursLeave();
    await rescheduleSmartWeatherAlarm();
  }
}

function getLegacyAlarmEndMs() {
  if (!schedule.alarmCreatedAt || !schedule.alarmDelayMinutes) return 0;
  return schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000;
}

function getStoredAlarmEndMs() {
  if (isSmartAutomationEnabled()) {
    return Number(schedule.smartNextTriggerAt) > 0
      ? Number(schedule.smartNextTriggerAt)
      : 0;
  }
  if (Number(schedule.nextTriggerAt) > 0) return Number(schedule.nextTriggerAt);
  return getLegacyAlarmEndMs();
}

function isSmartAutomationEnabled(scheduleState = schedule) {
  return scheduleState?.smartMode?.enabled === true;
}

function getAutomationAlarmName(scheduleState = schedule) {
  return isSmartAutomationEnabled(scheduleState) ? 'ac-smart' : 'ac-pwm';
}

async function getAutomationAlarm(scheduleState = schedule) {
  return chrome.alarms.get(getAutomationAlarmName(scheduleState));
}

function normalizeAutomationSchedule(state) {
  const normalized = { ...state };
  if (normalized.smartState !== 'on' && normalized.smartState !== 'off') {
    normalized.smartState = 'on';
  }
  if (!Number.isFinite(Number(normalized.smartNextTriggerAt))) {
    normalized.smartNextTriggerAt = 0;
  }
  if (!Number.isFinite(Number(normalized.pwmClockPlannedAt))) {
    normalized.pwmClockPlannedAt = 0;
  }
  if (typeof normalized.smartRetryKind !== 'string') {
    normalized.smartRetryKind = '';
  }
  if (!Number.isFinite(Number(normalized.smartRetryBoundaryAt))) {
    normalized.smartRetryBoundaryAt = 0;
  }
  if (!Number.isFinite(Number(normalized.smartRetryScheduledAt))) {
    normalized.smartRetryScheduledAt = 0;
  }
  return normalized;
}

function setSmartNextAction(nextAction) {
  const normalizedAction = nextAction === 'off' ? 'off' : 'on';
  schedule.smartState = normalizedAction;
}

function setSmartNextTriggerAt(nextTriggerAt, options = {}) {
  if (typeof setScheduleSmartClockIntent === 'function') {
    setScheduleSmartClockIntent(schedule, nextTriggerAt, options);
    return;
  }
  const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
  schedule.smartNextTriggerAt = normalizedAt;
  schedule.smartClockPlannedAt = normalizedAt > 0
    ? Number(options.plannedAt) || Date.now()
    : 0;
}

function setPwmNextTriggerAt(nextTriggerAt, options = {}) {
  if (typeof setSchedulePwmClockIntent === 'function') {
    setSchedulePwmClockIntent(schedule, nextTriggerAt, {
      plannedAt: options.plannedAt,
      toleranceMs: options.toleranceMs ?? 1500,
      readNow: () => Date.now()
    });
    return;
  }
  const normalizedAt = Number(nextTriggerAt) > 0 ? Number(nextTriggerAt) : 0;
  schedule.nextTriggerAt = normalizedAt;
  schedule.pwmClockPlannedAt = normalizedAt > 0
    ? Number(options.plannedAt) || Date.now()
    : 0;
}

function replaceSmartRetryState(retryState = {}) {
  if (typeof replaceScheduleSmartRetryState === 'function') {
    replaceScheduleSmartRetryState(schedule, retryState);
    return;
  }
  schedule.smartRetryKind = retryState.kind || '';
  schedule.smartRetryBoundaryAt = Number(retryState.boundaryAt) || 0;
  schedule.smartRetryScheduledAt = Number(retryState.scheduledAt) || 0;
}

function replacePwmRetryState(retryState = {}) {
  if (typeof replaceSchedulePwmRetryState === 'function') {
    replaceSchedulePwmRetryState(schedule, retryState);
    return;
  }
  schedule.pwmRetryKind = retryState.kind || '';
  schedule.pwmRetryBoundaryAt = Number(retryState.boundaryAt) || 0;
  schedule.pwmRetryScheduledAt = Number(retryState.scheduledAt) || 0;
}

function markSmartOnSafetyTimerRetry() {
  const scheduledAt = Number(schedule.smartNextTriggerAt) || 0;
  if (!schedule.smartMode?.enabled
      || schedule.smartState !== 'on'
      || scheduledAt <= 0) {
    replaceSmartRetryState();
    return false;
  }
  replaceSmartRetryState({
    kind: typeof SMART_RETRY_KINDS === 'object'
      ? SMART_RETRY_KINDS.ON_SAFETY_TIMER
      : 'smart-on-safety-timer',
    boundaryAt: Number(schedule.smartOnBoundaryAt) || 0,
    scheduledAt
  });
  return true;
}

function realignSmartRetryStateToVerifiedClock() {
  const descriptor = typeof getSmartRetryDescriptor === 'function'
    ? getSmartRetryDescriptor(schedule.smartRetryKind)
    : null;
  const scheduledAt = Number(schedule.smartNextTriggerAt) || 0;
  if (!descriptor || scheduledAt <= 0) {
    replaceSmartRetryState();
    return false;
  }
  replaceSmartRetryState({
    kind: descriptor.kind,
    boundaryAt: Number(schedule.smartRetryBoundaryAt) || 0,
    scheduledAt
  });
  return true;
}

function realignPwmRetryStateToVerifiedClock() {
  const descriptor = typeof getPwmRetryDescriptor === 'function'
    ? getPwmRetryDescriptor(schedule.pwmRetryKind)
    : null;
  const scheduledAt = Number(schedule.nextTriggerAt) || 0;
  if (!descriptor || scheduledAt <= 0) {
    replacePwmRetryState();
    return false;
  }
  replacePwmRetryState({
    kind: descriptor.kind,
    boundaryAt: Number(schedule.pwmRetryBoundaryAt) || 0,
    scheduledAt
  });
  return true;
}

function markPwmRetry(kind) {
  const descriptor = typeof getPwmRetryDescriptor === 'function'
    ? getPwmRetryDescriptor(kind)
    : null;
  const scheduledAt = Number(schedule.nextTriggerAt) || 0;
  if (!descriptor
      || isSmartAutomationEnabled()
      || scheduledAt <= 0) {
    replacePwmRetryState();
    return false;
  }
  replacePwmRetryState({
    kind: descriptor.kind,
    boundaryAt: 0,
    scheduledAt
  });
  return true;
}

// ===== 智能模式：将军澳 JKB 天气取数 + 动态时长 =====
// 香港天文台为将军澳提供独立的气温、相对湿度与 10 分钟平均风开放数据。
// smart-mode.js 按同一站名精确合并三个源，并由 JKB 气温 + 湿度推导露点；天气仅作为
// 本机运行态缓存，不进入 sync。
const SMART_WEATHER_KEY = 'ac_smart_weather';
const SMART_WEATHER_PLAN_KEY = 'ac_smart_weather_plan';
const SMART_WEATHER_URLS = Object.freeze({
  temperature: 'https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv',
  humidity: 'https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_humidity.csv',
  wind: 'https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_10min_wind.csv'
});
const SMART_WEATHER_TTL_MS = 60 * 60 * 1000;
let smartWeatherInFlight = null;
let smartReapplyInFlight = false;  // 滑块松开后即时重设 Power-off after 的单飞守卫

async function fetchSmartWeatherResource(resourceName) {
  const response = await fetch(SMART_WEATHER_URLS[resourceName], { cache: 'no-store' });
  if (!response.ok) throw new Error(`${resourceName} 天气接口 HTTP ${response.status}`);
  return response.text();
}

async function fetchSmartWeather() {
  const [temperatureCsv, humidityCsv, windCsv] = await Promise.all([
    fetchSmartWeatherResource('temperature'),
    fetchSmartWeatherResource('humidity'),
    fetchSmartWeatherResource('wind')
  ]);
  const parsed = parseTseungKwanOWeather({
    temperatureCsv,
    humidityCsv,
    windCsv
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

function applySmartDurationDecision(decision) {
  if (decision.runThrough === true) {
    // 连轴转：整周期开启，off=0 是有意取值（区别于 30/30 零时长哨兵）。
    schedule.onMinutes = SMART_MODE.CYCLE_MINUTES;
    schedule.offMinutes = 0;
    return;
  }
  if (decision.onMinutes === 0) {
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
  const minimumCycleOffMinutes = SMART_MODE.CYCLE_MINUTES - SMART_MODE.ON_MAX;
  schedule.offMinutes = Math.max(
    minimumCycleOffMinutes,
    sanitizeMinutes(schedule.offMinutes, minimumCycleOffMinutes)
  );
}

async function applySmartDurationsForBoundary(boundaryAt) {
  if (!schedule.enabled || !schedule.smartMode?.enabled) return null;

  const stored = await chrome.storage.local.get([
    SMART_WEATHER_PLAN_KEY,
    SMART_WEATHER_KEY
  ]);
  let decision = consumeSmartWeatherDecision(stored[SMART_WEATHER_PLAN_KEY], {
    boundaryAt,
    sensitivity: schedule.smartMode.sensitivity
  });
  if (!decision?.valid && typeof consumeStoredSmartWeatherDecision === 'function') {
    decision = consumeStoredSmartWeatherDecision(stored[SMART_WEATHER_KEY], {
      boundaryAt,
      sensitivity: schedule.smartMode.sensitivity
    });
  }

  if (!decision?.valid) {
    applySmartDurationFallback();
    return null;
  }

  applySmartDurationDecision(decision);
  return decision;
}

async function applyPreparedSmartModeDurations() {
  if (!schedule.enabled || !schedule.smartMode?.enabled) return;
  if (schedule.smartState !== 'on') return;

  const boundaryAt = currentSmartControlBoundary();
  const stored = await chrome.storage.local.get(SMART_WEATHER_PLAN_KEY);
  const suggested = consumeSmartWeatherDecision(stored[SMART_WEATHER_PLAN_KEY], {
    boundaryAt,
    sensitivity: schedule.smartMode.sensitivity
  });

  if (!suggested?.valid) {
    applySmartDurationFallback();
    console.warn('[AC扩展] 智能模式：目标边界预计算缺失，本周期沿用安全时长');
    return;
  }

  applySmartDurationDecision(suggested);

  console.log(
    `[AC扩展] 智能模式预计算: boundary=${new Date(boundaryAt).toLocaleTimeString()}`
    + ` K=${suggested.k.toFixed(3)} Teq=${suggested.teq.toFixed(1)}°C`
    + ` t_raw=${suggested.tRaw.toFixed(1)}`
    + ` → on=${suggested.onMinutes}min / off=${schedule.offMinutes}min`
  );
}

// 智能模式：滑块松开后立即按新灵敏度重设当前 ON 相位的 Power-off after。
// 配合 updateSchedule(restart=false)——后者只持久化灵敏度、不打断当前周期；
// 本函数补上「即时反馈」，让页面关机定时器不再等下一个 30 分钟周期才变化。
// 仅 AC 当前处于 ON 相位(smartState='off')时重设页面定时器；AC 关闭时只更新派生时长，
// 下一 ON 相位自然采用新值。整个过程异步执行，不阻塞 popup 的 updateSchedule 响应。
async function reapplySmartSensitivityNow() {
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || !schedule.smartMode?.enabled) return;
  const smartStepIsRunning = () => typeof isCurrentSmartStepRunning === 'function'
    ? isCurrentSmartStepRunning()
    : typeof smartStepRunning === 'boolean' && smartStepRunning;
  if (smartStepIsRunning()) return;  // 避免与正在执行的 Smart 步骤并发操作页面定时器

  const wasOnPhase = schedule.smartState === 'off';
  const oldSmartState = schedule.smartState;
  const oldOnMinutes = Number(schedule.onMinutes) || 0;
  const oldOffMinutes = Number(schedule.offMinutes) || 0;
  const oldTriggerAt = Number(schedule.smartNextTriggerAt) || 0;
  const oldSmartBoundaryAt = Number(schedule.smartOnBoundaryAt) || 0;
  const oldSmartRuntimeRevision = smartRuntimeRevision;

  const weather = await readStoredSmartWeather();
  if ((typeof isAutomationAllowed === 'function' && !isAutomationAllowed())
      || !schedule.smartMode?.enabled || smartStepIsRunning()
      || smartRuntimeRevision !== oldSmartRuntimeRevision
      || schedule.smartState !== oldSmartState
      || (Number(schedule.onMinutes) || 0) !== oldOnMinutes
      || (Number(schedule.offMinutes) || 0) !== oldOffMinutes
      || (Number(schedule.smartNextTriggerAt) || 0) !== oldTriggerAt
      || (Number(schedule.smartOnBoundaryAt) || 0) !== oldSmartBoundaryAt) {
    return;
  }
  const suggested = computeSmartOnMinutes({
    sensitivity: schedule.smartMode.sensitivity,
    temperature: weather.temperature,
    dewPoint: weather.dewPoint,
    windSpeedMs: weather.windSpeedMs
  });

  if (!suggested.valid) return;  // 天气不可用 → 保持当前周期不变

  // 落地派生 on/off（on=0 用占位，语义与 applySmartModeDurations 保持一致）
  if (suggested.runThrough === true) {
    schedule.onMinutes = SMART_MODE.CYCLE_MINUTES;
    schedule.offMinutes = 0;
  } else {
    schedule.onMinutes = suggested.onMinutes === 0
      ? SMART_MODE.CYCLE_MINUTES
      : suggested.onMinutes;
    schedule.offMinutes = Math.max(1, suggested.offMinutes);
  }

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
  const nextMinuteTargetAt = Math.floor(nowMs / 60000 + 1) * 60000;
  const smartDeadlineAt = computedSmartDeadlineAt > nowMs
    ? computedSmartDeadlineAt
    : nextMinuteTargetAt;
  const minutes = Math.max(1, Math.ceil((smartDeadlineAt - nowMs) / 60000));

  // 先清旧 alarm，避免旧关机时刻在慢速新鲜页验证期间抢跑；页面写入方返回
  // 已对齐 UST HH:MM 接口的绝对 targetAt，再用同一值恢复扩展倒计时。
  await clearSmartAlarm(oldSmartRuntimeRevision);
  if (!isAutomationOperationCurrent(oldSmartRuntimeRevision, 'smart')
      || !isSmartAutomationEnabled()) return;
  replaceSmartRetryState();
  setSmartNextTriggerAt(0);
  const timerResult = await setPageTimer(minutes, {
    retryOnFailure: false,
    targetAt: smartDeadlineAt,
    automationRevision: oldSmartRuntimeRevision,
    automationMode: 'smart'
  });
  if (await abortStaleAutomation(
    oldSmartRuntimeRevision,
    'reapply-smart-sensitivity-active-hours-paused',
    'smart'
  )) return;
  if (!timerResult?.success) {
    setSmartNextAction('on');
    schedule.pageTimerError = `灵敏度即时应用时页面关机定时器未确认：${timerResult?.error || '未知错误'}；1 分钟后重试`;
    const alarmCreated = await createAutomationAlarmFromPlan(
      'ac-smart',
      { nextTriggerAt: Date.now() + 60000 },
      'reapply-smart-pageTimer-failed',
      oldSmartRuntimeRevision,
      'smart'
    );
    if (alarmCreated === false) return;
    markSmartOnSafetyTimerRetry();
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      oldSmartRuntimeRevision,
      'reapply-smart-retry-active-hours-paused',
      'smart'
    )) return;
    await persistSchedule('reapply-smart-sensitivity-pageTimer-failed');
    await updateBadge();
    return;
  }

  const reapplyPlan = { nextTriggerAt: schedule.pageTimerTargetAt };
  const alarmCreated = await createAutomationAlarmFromPlan(
    'ac-smart',
    reapplyPlan,
    'reapply-smart-sensitivity',
    oldSmartRuntimeRevision,
    'smart'
  );
  if (alarmCreated === false) return;
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (await abortStaleAutomation(
    oldSmartRuntimeRevision,
    'reapply-smart-commit-active-hours-paused',
    'smart'
  )) return;
  await persistSchedule('reapply-smart-sensitivity-on-phase');
  await updateBadge();

  console.log(
    `[AC扩展] 滑块灵敏度即时应用: sens=${schedule.smartMode.sensitivity}`
    + ` → on=${suggested.onMinutes}min, 页面目标 ${new globalThis.Date(schedule.pageTimerTargetAt).toLocaleTimeString()}`
  );
}

function clearPageTimerProofState() {
  schedule.pageTimerMinutes = null;
  schedule.pageTimerTargetAt = 0;
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
}

function applySmartPlanState(plan) {
  if (!plan?.phasePatch) return;
  const { nextTriggerAt, ...phasePatch } = plan.phasePatch;
  Object.assign(schedule, phasePatch);
  if (Object.prototype.hasOwnProperty.call(plan.phasePatch, 'nextTriggerAt')) {
    setSmartNextTriggerAt(nextTriggerAt, {
      plannedAt: plan.smartClockPlannedAt
    });
  }
}

function applyPwmPlanState(plan) {
  if (plan?.proofAction === 'clear') clearPageTimerProofState();
  if (plan?.phasePatch) {
    const { nextTriggerAt, ...phasePatch } = plan.phasePatch;
    const plannedAt = Number(plan.pwmClockPlannedAt)
      || Number(phasePatch.pwmClockPlannedAt)
      || Number(phasePatch.alarmCreatedAt)
      || 0;
    Object.assign(schedule, phasePatch);
    if (Object.prototype.hasOwnProperty.call(plan.phasePatch, 'nextTriggerAt')) {
      setPwmNextTriggerAt(nextTriggerAt, { plannedAt });
      if (Number(phasePatch.alarmCreatedAt) > 0) {
        schedule.alarmCreatedAt = phasePatch.alarmCreatedAt;
        schedule.alarmDelayMinutes = phasePatch.alarmDelayMinutes;
      }
    }
  }
}

async function resetDisabledAutomationRuntime() {
  await recordControlAuditTerminal('disabled', 'automation-disabled');
  const smartEnabled = isSmartAutomationEnabled();
  pwmRuntimeRevision += 1;
  smartRuntimeRevision += 1;
  if (typeof invalidateTimerBasedShutdown === 'function') {
    invalidateTimerBasedShutdown();
  }
  if (typeof cancelAutomaticOnRequests === 'function') {
    await cancelAutomaticOnRequests();
  }
  scheduleLoadBlockedRevision = pwmRuntimeRevision;
  lastPwmStepAt = 0;
  lastSmartStepAt = 0;
  if (smartEnabled) {
    schedule.smartState = 'on';
    schedule.smartOnBoundaryAt = 0;
    replaceSmartRetryState();
    setSmartNextTriggerAt(0);
    await clearSmartAlarm(null, true);
  } else {
    schedule.pwmState = 'off';
    schedule.smartOnBoundaryAt = 0;
    replacePwmRetryState();
    setPwmNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await clearPwmAlarm(null, true);
  }
  await chrome.alarms.clear('ac-badge-tick');
  await chrome.alarms.clear('ac-watchdog');
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
  if (Number(schedule.nextTriggerAt) > 0) return Number(schedule.nextTriggerAt);

  // 第一层：用已保存的阶段时间重算
  const legacyEnd = getLegacyAlarmEndMs();
  if (legacyEnd) {
    setPwmNextTriggerAt(legacyEnd, { plannedAt: schedule.alarmCreatedAt });
    if (persist) {
      await persistSchedule('backfillNextTriggerAt', { syncFromLiveAlarm: false });
    }
    return legacyEnd;
  }

  // 第二层：legacy 字段也丢了，但 live alarm 还在 → 从 alarm 恢复
  if (isAutomationAllowed()) {
    const automationRevision = pwmRuntimeRevision;
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    if (!isAutomationOperationCurrent(automationRevision)) return 0;
    const plan = reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS);
    if (plan.kind === 'sync-live') {
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
    await clearPwmAlarm(automationRevision);
    const alarmCreated = await createPwmAlarmFromPlan(
      plan,
      'advance-pageTimer-failed',
      automationRevision
    );
    if (alarmCreated === false) return false;
    if (plan.reason === 'page-timer-failed') {
      markPwmRetry(PWM_RETRY_KINDS.PAGE_TIMER);
    } else {
      markPwmRetry(PWM_RETRY_KINDS.TOGGLE);
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
  replacePwmRetryState();
  if (plan.proofAction === 'clear') {
    await chrome.alarms.clear('ac-page-timer-retry');
  }
  await clearPwmAlarm(automationRevision);
  const alarmCreated = await createPwmAlarmFromPlan(
    plan,
    'advance-recovery',
    automationRevision
  );
  if (alarmCreated === false) return false;
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
  if (alarmCreated === false) return false;
  realignPwmRetryStateToVerifiedClock();
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

let automationAlarmWriteChain = Promise.resolve();

async function clearAutomationAlarm(
  alarmName,
  automationRevision = null,
  force = false
) {
  const automationMode = alarmName === 'ac-smart' ? 'smart' : 'pwm';
  return runSerializedAutomationAlarmWrite(async () => {
    if (!force && !isAutomationAlarmWriteCurrent(automationRevision, automationMode)) return false;
    await chrome.alarms.clear(alarmName);
    return force || isAutomationAlarmWriteCurrent(automationRevision, automationMode);
  });
}

function recordAutomationAlarmProjection(
  alarmName,
  scheduledTime,
  alarmCreatedAt
) {
  const verifiedScheduledTime = Number(scheduledTime);
  const createdAt = Number(alarmCreatedAt);
  if (!Number.isFinite(verifiedScheduledTime)
      || !Number.isFinite(createdAt)
      || verifiedScheduledTime <= 0
      || createdAt <= 0) {
    return false;
  }

  if (alarmName === 'ac-smart') {
    setSmartNextTriggerAt(verifiedScheduledTime, { plannedAt: createdAt });
    return true;
  }

  if (alarmName !== 'ac-pwm') return false;

  setPwmNextTriggerAt(verifiedScheduledTime, {
    plannedAt: createdAt
  });
  schedule.alarmCreatedAt = createdAt;
  schedule.alarmDelayMinutes = (verifiedScheduledTime - createdAt) / 60000;
  return true;
}

async function createAutomationAlarmFromPlan(
  alarmName,
  plan,
  logTag = 'automation',
  automationRevision = null
) {
  const automationMode = alarmName === 'ac-smart' ? 'smart' : 'pwm';
  const nextTriggerAt = Number(plan?.nextTriggerAt);
  if (!Number.isFinite(nextTriggerAt) || nextTriggerAt <= Date.now()) {
    throw new Error(`${logTag}: automation plan 缺少未来触发时间`);
  }

  return runSerializedAutomationAlarmWrite(async () => {
    if (!isAutomationAlarmWriteCurrent(automationRevision, automationMode)) return false;

    const alarmCreatedAt = Date.now();
    let created = await createAlarm(alarmName, { when: nextTriggerAt });
    let verify = created ? await chrome.alarms.get(alarmName) : null;
    if ((!created || !verify) && isAutomationAlarmWriteCurrent(automationRevision, automationMode)) {
      console.error(`[AC扩展] ${logTag}: ${alarmName} 创建失败，重试...`);
      created = await createAlarm(alarmName, { when: nextTriggerAt });
      verify = created ? await chrome.alarms.get(alarmName) : null;
    }
    const verifiedScheduledTime = Number(verify?.scheduledTime);
    if (!created
        || !Number.isFinite(verifiedScheduledTime)
        || verifiedScheduledTime <= Date.now()
        || !isAutomationAlarmWriteCurrent(automationRevision, automationMode)) {
      await chrome.alarms.clear(alarmName);
      return false;
    }

    return recordAutomationAlarmProjection(
      alarmName,
      verifiedScheduledTime,
      alarmCreatedAt
    );
  });
}

function runSerializedAutomationAlarmWrite(operation) {
  const queued = automationAlarmWriteChain
    .catch(() => {})
    .then(operation);
  automationAlarmWriteChain = queued.catch(() => {});
  return queued;
}

function isAutomationAlarmWriteCurrent(automationRevision, automationMode = 'pwm') {
  return automationRevision === null
    ? isAutomationAllowed()
    : isAutomationOperationCurrent(automationRevision, automationMode);
}

async function clearPwmAlarm(automationRevision = null, force = false) {
  return clearAutomationAlarm('ac-pwm', automationRevision, force);
}

async function clearSmartAlarm(automationRevision = null, force = false) {
  return clearAutomationAlarm('ac-smart', automationRevision, force);
}

async function clearAutomationRuntimeAlarmsWhileBlocked(
  blockedRevision = null
) {
  const smartEnabled = isSmartAutomationEnabled();
  const currentRevision = smartEnabled ? smartRuntimeRevision : pwmRuntimeRevision;
  const effectiveRevision = blockedRevision === null
    ? currentRevision
    : blockedRevision;
  const automationMode = smartEnabled ? 'smart' : 'pwm';
  const blockIsCurrent = () => (
    effectiveRevision === (
      automationMode === 'smart' ? smartRuntimeRevision : pwmRuntimeRevision
    ) && !isAutomationAllowed()
  );
  if (!blockIsCurrent()) return false;

  const clearCurrentAutomationAlarm = smartEnabled ? clearSmartAlarm : clearPwmAlarm;
  await clearCurrentAutomationAlarm(null, true);
  if (!blockIsCurrent()) return false;
  await chrome.alarms.clear('ac-badge-tick');
  if (!blockIsCurrent()) return false;
  await chrome.alarms.clear('ac-watchdog');
  return blockIsCurrent();
}

async function createPwmAlarmWithVerify(
  delay,
  logTag = 'PWM',
  automationRevision = null
) {
  return runSerializedAutomationAlarmWrite(async () => {
    if (!isAutomationAlarmWriteCurrent(automationRevision)) return false;

    const alarmCreatedAt = Date.now();
    let created = await createAlarm('ac-pwm', { delayInMinutes: delay });
    if (!created && isAutomationAlarmWriteCurrent(automationRevision)) {
      console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
      created = await createAlarm('ac-pwm', { delayInMinutes: delay });
    }
    const verify = created ? await chrome.alarms.get('ac-pwm') : null;
    const verifiedScheduledTime = Number(verify?.scheduledTime);
    if (!created
        || !Number.isFinite(verifiedScheduledTime)
        || verifiedScheduledTime <= Date.now()
        || !isAutomationAlarmWriteCurrent(automationRevision)) {
      await chrome.alarms.clear('ac-pwm');
      return false;
    }

    return recordAutomationAlarmProjection(
      'ac-pwm',
      verifiedScheduledTime,
      alarmCreatedAt
    );
  });
}

async function createPwmAlarmFromPlan(
  plan,
  logTag = 'PWM',
  automationRevision = null
) {
  const nextTriggerAt = Number(plan?.nextTriggerAt);
  if (!Number.isFinite(nextTriggerAt) || nextTriggerAt <= Date.now()) {
    throw new Error(`${logTag}: PWM plan 缺少未来触发时间`);
  }

  return runSerializedAutomationAlarmWrite(async () => {
    if (!isAutomationAlarmWriteCurrent(automationRevision)) return false;

    const alarmCreatedAt = Date.now();
    let created = await createAlarm('ac-pwm', { when: nextTriggerAt });
    let verify = created ? await chrome.alarms.get('ac-pwm') : null;
    if ((!created || !verify) && isAutomationAlarmWriteCurrent(automationRevision)) {
      console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
      created = await createAlarm('ac-pwm', { when: nextTriggerAt });
      verify = created ? await chrome.alarms.get('ac-pwm') : null;
    }
    const verifiedScheduledTime = Number(verify?.scheduledTime);
    if (!created
        || !Number.isFinite(verifiedScheduledTime)
        || verifiedScheduledTime <= Date.now()
        || !isAutomationAlarmWriteCurrent(automationRevision)) {
      await chrome.alarms.clear('ac-pwm');
      return false;
    }

    // 提取（Fowler Extract Function）：PWM 本地控制 ON 计划审计（打包态才落盘）。
    // 仅在 plan 目标为 ON 且触发边界为整点/半点时，于 alarm 验证成功后建立 planned。
    if (plan?.nextAction === 'on') {
      const originBoundaryAt = getControlAuditHalfHourBoundary(nextTriggerAt);
      if (originBoundaryAt === nextTriggerAt) {
        await recordControlAuditPlanned({
          scheduledAt: verifiedScheduledTime,
          originBoundaryAt,
          targetAt: Number(plan?.pageTimerTargetAt) || 0
        });
      }
    }

    return recordAutomationAlarmProjection(
      'ac-pwm',
      verifiedScheduledTime,
      alarmCreatedAt
    );
  });
}

async function loadScheduleFromStorage() {
  const automationMode = isSmartAutomationEnabled() ? 'smart' : 'pwm';
  const automationRevision = automationMode === 'smart'
    ? smartRuntimeRevision
    : pwmRuntimeRevision;
  if (scheduleLoadBlockedRevision === pwmRuntimeRevision) return schedule;
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const revisionIsCurrent = automationMode === 'smart'
    ? automationRevision === smartRuntimeRevision
    : automationRevision === pwmRuntimeRevision;
  if (!revisionIsCurrent || scheduleLoadBlockedRevision === pwmRuntimeRevision) return schedule;
  if (saved[STORAGE_KEY]) {
    schedule = normalizeAutomationSchedule({
      ...schedule,
      ...saved[STORAGE_KEY]
    });
  }
  return schedule;
}

async function persistSchedule(reason = '', options = {}) {
  const { syncFromLiveAlarm = !isSmartAutomationEnabled() } = options;

  if (syncFromLiveAlarm && !isSmartAutomationEnabled() && isAutomationAllowed()) {
    const automationRevision = pwmRuntimeRevision;
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    if (isAutomationOperationCurrent(automationRevision)) {
      const plan = reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS);
      if (plan.kind === 'sync-live') {
        applyPwmPlanState(plan);
        if (reason) {
          console.log(`[AC扩展] ${reason}: 写入前按 live alarm 修正 nextTriggerAt`);
        }
      }
    }
  }

  if (!schedule.smartMode?.enabled) schedule.smartOnBoundaryAt = 0;
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...schedule } });
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

const _syncOpLock = { busy: false };

// 把当前内存 schedule 瘦化后写入 chrome.storage.sync。
// reason 用于日志。失败静默降级。
async function syncScheduleToSync(reason = '') {
  if (!chrome.storage?.sync) return;  // 受限上下文（incognito / 策略禁用）
  try {
    const now = Date.now();
    const slim = composeSyncPayload(schedule, now);
    await chrome.storage.sync.set({ [SYNC_KEY]: slim });
    lastSyncedAt = now;  // 标记本次写入的时间，避免 onChanged 自回环误采纳
    if (reason) {
      const phaseMode = slim.phase?.mode === 'smart' ? 'Smart' : 'PWM';
      const automationAlarmName = phaseMode === 'Smart' ? 'ac-smart' : 'ac-pwm';
      const phaseTriggerAt = Number(slim.phase?.nextTriggerAt) || 0;
      console.log(`[AC扩展] sync ↑ ${reason}: mode=${phaseMode}, alarm=${automationAlarmName}, phase=${slim.phase?.mode || 'unknown'}, nextTriggerAt=${phaseTriggerAt ? new Date(phaseTriggerAt).toLocaleString() : '无'}, enabled=${slim.enabled}`);
    }
  } catch (e) {
    console.warn('[AC扩展] sync 写入失败（未登录浏览器同步 / 配额超限？）:', e?.message);
    void appendDiagnosticLog('warn', 'sync-write', e);
  }
}

// 把远端 sync 对象合并到本地 schedule + 重排闹钟。返回 true=已变更并持久化。
// 注意：调用方需要保证不并发（_syncOpLock 守卫）。
async function applySyncedPhase(remote, reason = '') {
  if (!remote || typeof remote !== 'object') return false;

  // 提取（Fowler Extract Function）：同步停用路径——B1 顺序：先 persist 停用状态，再走页面定时器关机。
  async function shutdownAfterSyncDisable({ activeHoursPause = false } = {}) {
    await resetDisabledAutomationRuntime();
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

  // 1) config 字段无相位守卫——直接 last-writer-wins 采纳
  const wasSmartEnabled = isSmartAutomationEnabled();
  const localAutomationMode = wasSmartEnabled ? 'smart' : 'pwm';
  const configMode = typeof remote.smartMode?.enabled === 'boolean'
    ? (remote.smartMode.enabled ? 'smart' : 'pwm')
    : localAutomationMode;
  const cfg = computeConfigDiff(schedule, remote, {
    mode: configMode,
    protectSmartDurations: configMode === 'smart'
  });
  let configChanged = false;
  let activeHoursChanged = false;
  if (cfg.changed) {
    for (const [k, v] of Object.entries(cfg.fields)) {
      schedule[k] = v;
      if (k === 'activeHours') activeHoursChanged = true;
    }
    configChanged = true;
  }
  const enabledChanged = cfg.fields.enabled !== undefined;
  const nowEnabled = schedule.enabled;
  const smartModeChanged = wasSmartEnabled !== isSmartAutomationEnabled();
  const automationAllowed = isAutomationAllowed();
  if (smartModeChanged) {
    pwmRuntimeRevision += 1;
    smartRuntimeRevision += 1;
    scheduleLoadBlockedRevision = pwmRuntimeRevision;
    await clearAutomationAlarm(
      wasSmartEnabled ? 'ac-smart' : 'ac-pwm',
      null,
      true
    );
    lastPwmStepAt = 0;
    lastSmartStepAt = 0;
    if (wasSmartEnabled) {
      schedule.smartState = 'on';
      schedule.smartOnBoundaryAt = 0;
      replaceSmartRetryState();
      setSmartNextTriggerAt(0);
    } else {
      schedule.pwmState = 'off';
      replacePwmRetryState();
      setPwmNextTriggerAt(0);
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;
    }
  }

  // 2) 相位字段需通过严格守卫（陈旧/容忍/自回环），computePhaseAdoption 决策。
  // Smart 与 PWM 分别重排自己的 live alarm；旧字段只作为同步协议投影。
  async function adoptPhaseAndRearm(remote, automationAllowed) {
    const smartEnabled = isSmartAutomationEnabled();
    const automationMode = smartEnabled ? 'smart' : 'pwm';
    const automationRevision = smartEnabled
      ? smartRuntimeRevision
      : pwmRuntimeRevision;
    const hasRemotePhase = Object.prototype.hasOwnProperty.call(remote, 'phase');
    const legacySmartMigration = automationMode === 'smart'
      && !hasRemotePhase
      && remote.smartMode?.enabled === true
      && (remote.pwmState === 'on' || remote.pwmState === 'off')
      && typeof remote.nextTriggerAt === 'number'
      && Number.isFinite(remote.nextTriggerAt)
      && !Object.prototype.hasOwnProperty.call(remote, 'smartState')
      && !Object.prototype.hasOwnProperty.call(remote, 'smartNextTriggerAt');
    const adopt = computePhaseAdoption(schedule, remote, {
      lastSyncedAt,
      mode: automationMode,
      legacyMigration: legacySmartMigration
    });
    if (!adopt || adopt.mode !== automationMode) return false;
    if (!automationAllowed
        || !isAutomationOperationCurrent(automationRevision, automationMode)) return false;

    if (smartEnabled) {
      const oldSmartState = schedule.smartState;
      const oldTrigger = Number(schedule.smartNextTriggerAt) || 0;
      const oldPlannedAt = Number(schedule.smartClockPlannedAt) || 0;
      setSmartNextAction(adopt.state);
      setSmartNextTriggerAt(adopt.nextTriggerAt, {
        plannedAt: adopt.clockPlannedAt
      });
      const clockChanged = oldTrigger !== schedule.smartNextTriggerAt;
      const phaseChanged = oldSmartState !== schedule.smartState || clockChanged;
      const metadataChanged = oldPlannedAt !== Number(schedule.smartClockPlannedAt || 0);

      if (phaseChanged && automationAllowed) {
        replaceSmartRetryState();
        try {
          await clearSmartAlarm(automationRevision);
          if (adopt.nextTriggerAt > Date.now()) {
            const alarmCreated = await createAutomationAlarmFromPlan(
              'ac-smart',
              { nextTriggerAt: adopt.nextTriggerAt },
              'sync-smart-phase-adopt',
              automationRevision
            );
            if (alarmCreated === false) return false;
          } else {
            await repairSmartScheduleClock();
          }
        } catch (e) {
          console.warn('[AC扩展] sync 合并：重排 ac-smart 闹钟失败:', e?.message);
        }
      }
      return phaseChanged || metadataChanged;
    }

    const oldPwmState = schedule.pwmState;
    const oldTrigger = schedule.nextTriggerAt;
    const oldPlannedAt = Number(schedule.pwmClockPlannedAt)
      || Number(schedule.alarmCreatedAt)
      || 0;
    const adoptedPwmClockPlannedAt = Number(adopt.clockPlannedAt) || 0;
    schedule.pwmState = adopt.state;
    setPwmNextTriggerAt(adopt.nextTriggerAt, {
      plannedAt: adoptedPwmClockPlannedAt
    });
    schedule.alarmCreatedAt = Date.now();
    schedule.alarmDelayMinutes = Math.max(1, (adopt.nextTriggerAt - Date.now()) / 60000);
    const clockChanged = oldTrigger !== schedule.nextTriggerAt;
    const phaseChanged = oldPwmState !== schedule.pwmState || clockChanged;
    const metadataChanged = oldPlannedAt !== Number(schedule.pwmClockPlannedAt || 0);

    if (phaseChanged && automationAllowed) {
      if (typeof replacePwmRetryState === 'function') {
        replacePwmRetryState();
      }
      try {
        await clearPwmAlarm(automationRevision);
        const delayMs = adopt.nextTriggerAt - Date.now();
        if (delayMs > 0) {
          // 用绝对时间调度，让多设备对齐到同一时刻（非 delayInMinutes 各自倒计时）
          const alarmCreated = await createPwmAlarmFromPlan(
            { nextTriggerAt: adopt.nextTriggerAt },
            'sync-phase-adopt',
            automationRevision
          );
          if (alarmCreated === false) return false;
        } else {
          // 远端时戳已过期（在 staleMs 60s 窗口内）——推进到下一未来周期边界
          await advanceExpiredAlarmToNextBoundary(
            adopt.nextTriggerAt,
            automationRevision
          );
        }
      } catch (e) {
        console.warn('[AC扩展] sync 合并：重排 ac-pwm 闹钟失败:', e?.message);
      }
    }
    return phaseChanged || metadataChanged;
  }

  const phaseChanged = await adoptPhaseAndRearm(remote, automationAllowed);

  // 3) 闹钟基础设施重建——只由 config 变更驱动；phase 路径按当前模式管理 live alarm
  //    关键修复：若 enabled 在 sync 中翻为 true 但无相位（远端刚 enable 还没跑完第一步），
  //    只持久化 enabled=true 却不建闹钟，设备 B 永远不会真正执行自动控制。
  //    反之 enabled 翻为 false 也必须主动清理闹钟 + 停机，否则设备 B 继续跑本地自动控制。
  let didAlarmInfra = false;
  if (enabledChanged || activeHoursChanged || smartModeChanged) {
    if (!nowEnabled) {
      if (enabledChanged) {
        // true → false：清所有自动控制相关闹钟 + 停机（B1 顺序：先 persist 再关）
        await shutdownAfterSyncDisable();
        didAlarmInfra = true;
      }
    } else if (!automationAllowed) {
      // enabled 意图保持开启，但 activeHours 当前在时段外：立即暂停，不伪造 disabled。
      await shutdownAfterSyncDisable({ activeHoursPause: true });
      await rescheduleSmartWeatherAlarm();
      didAlarmInfra = true;
    } else if (enabledChanged || !wasAutomationAllowed || smartModeChanged) {
      // false → true：按是否已采纳相位决定是否立即启动当前模式 cycle
      if (phaseChanged) {
        // phase 路径已建当前模式 live alarm；这里只补看门狗 + badge-tick
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      } else {
        // 无相位 → 本地按当前模式全新起一轮（与 updateSchedule enabled→true 路径一致）
        if (isSmartAutomationEnabled()) setSmartNextAction('on');
        else schedule.pwmState = 'on';
        // 先 persist 内存新状态（enabled=true、当前模式下一动作='on'），避免 setupAlarms(true)
        // → 当前模式 runner 顶部 loadScheduleFromStorage() 用 storage 旧值（enabled=false）
        // 覆盖内存导致 runner 提前返回、闹钟基础设施丢失。
        await persistSchedule('sync-enabled-pre-setup', { syncFromLiveAlarm: false });
        await setupAlarms(true);  // startImmediately → 当前模式 runner，内部建立对应 live alarm + badge-tick
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      }
      didAlarmInfra = true;
    }
  }

  // 4) active hours 边界闹钟：activeHours 变更或相位重排后都应重调度
  if (activeHoursChanged || phaseChanged) {
    rescheduleActiveBoundary();
  }

  // 标记最新已知的 remote.syncedAt——即便没采纳相位，也防止稍后 onChanged 自回环再次触发
  if (remote.syncedAt) lastSyncedAt = Math.max(lastSyncedAt, remote.syncedAt);

  const changed = configChanged || phaseChanged;
  if (changed) {
    await persistSchedule(reason || 'sync-采纳', { syncFromLiveAlarm: false });
    if (phaseChanged) {
      const adoptedMode = isSmartAutomationEnabled() ? 'Smart' : 'PWM';
      const adoptedAlarmName = isSmartAutomationEnabled() ? 'ac-smart' : 'ac-pwm';
      if (isSmartAutomationEnabled()) {
        console.log(`[AC扩展] sync ↓ ${reason}: mode=${adoptedMode}, alarm=${adoptedAlarmName}, 已采纳远端相位 smartState=${schedule.smartState}, smartNextTriggerAt=${new Date(schedule.smartNextTriggerAt).toLocaleString()}`);
      } else {
        console.log(`[AC扩展] sync ↓ ${reason}: mode=${adoptedMode}, alarm=${adoptedAlarmName}, 已采纳远端相位 pwmState=${schedule.pwmState}, nextTriggerAt=${new Date(schedule.nextTriggerAt).toLocaleString()}`);
      }
    }
    if (configChanged) {
      console.log(`[AC扩展] sync ↓ ${reason}: 已采纳远端 config:`, cfg.fields);
    }
    if (didAlarmInfra) {
      console.log(`[AC扩展] sync ↓ ${reason}: enabled=${wasEnabled}→${nowEnabled}，已重建闹钟基础设施`);
    }
  }
  return changed;
}

// 从 chrome.storage.sync 拉取并尝试合并。reason 用于日志。
// 传 explicitRemote 可跳过读取（onChanged 已传入 newValue）；否则从 sync store 读。
async function tryAdoptSyncedState(reason = '', explicitRemote = null) {
  if (_syncOpLock.busy) {
    console.log(`[AC扩展] sync 合并跳过（上次仍在处理）: ${reason}`);
    return false;
  }
  _syncOpLock.busy = true;
  try {
    let remote = explicitRemote;
    if (!remote && chrome.storage?.sync) {
      try {
        const got = await chrome.storage.sync.get(SYNC_KEY);
        remote = got?.[SYNC_KEY] || null;
      } catch (e) {
        console.warn('[AC扩展] sync 读取失败:', e?.message);
        return false;
      }
    }
    if (!remote) return false;
    return await applySyncedPhase(remote, reason);
  } finally {
    _syncOpLock.busy = false;
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
  if (isSmartAutomationEnabled()
      || !isAutomationAllowed()
      || isCurrentPwmStepRunning()) return false;
  const automationRevision = pwmRuntimeRevision;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    if (!isAutomationOperationCurrent(automationRevision)
        || isCurrentPwmStepRunning()) return false;
    const tab = tabs.find(isACHomePageTab);
    if (!tab?.id) return false;

    const result = await sendReadMessageToExactACHome(tab.id, { action: 'getPageTimer' });
    if (!isAutomationOperationCurrent(automationRevision)
        || isCurrentPwmStepRunning()) return false;
    if (!result || !result.found) return false;

    const adopt = computePageTimerAdoption(schedule, result, { now: Date.now() });
    if (!adopt) return false;
    if (!isAutomationOperationCurrent(automationRevision)) return false;

    // 采纳 page timer 值作为权威"关"时刻
    const oldTrigger = schedule.nextTriggerAt;
    replacePwmRetryState();
    setPwmNextTriggerAt(adopt.nextTriggerAt);
    schedule.alarmCreatedAt = Date.now();
    schedule.alarmDelayMinutes = Math.max(1, (adopt.nextTriggerAt - Date.now()) / 60000);

    // 重排 ac-pwm 闹钟到新时刻
    await clearPwmAlarm(automationRevision);
    const delayMs = adopt.nextTriggerAt - Date.now();
    if (delayMs > 0) {
      const alarmCreated = await createPwmAlarmFromPlan(
        { nextTriggerAt: adopt.nextTriggerAt },
        'page-timer-adopt',
        automationRevision
      );
      if (alarmCreated === false) return false;
    } else {
      await advanceExpiredAlarmToNextBoundary(
        adopt.nextTriggerAt,
        automationRevision
      );
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
    // AC 页面可能尚未完全加载 / content script 未就绪——静默降级
    console.warn(`[AC扩展] page-timer ${reason} 读取失败（可能页面未就绪）:`, e?.message);
    void appendDiagnosticLog('warn', 'page-timer-adopt', e);
    return false;
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
  await loadScheduleFromStorage();
  if (!isAutomationAllowed()) {
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (!isAutomationAllowed()) return;
  }
  await recordControlAuditMissedWake('watchdog');

  if (isSmartAutomationEnabled()) {
    const automationRevision = smartRuntimeRevision;
    const alarm = await chrome.alarms.get('ac-smart');
    if (!isAutomationOperationCurrent(automationRevision, 'smart')) return;
    if (!alarm || alarm.scheduledTime <= Date.now() - 60000) {
      // 与 setupAlarms.recoverSmartAlarm 同款修复：无活闹钟但 storage 里还有过期触发意图时，
      // 交给 runSmartStep 做 late-wake recovery，而不是 repairSmartScheduleClock 直接顺延，
      // 避免错过刚过半点的开机。
      const storedEnd = getStoredAlarmEndMs();
      const overdueTriggerAt = alarm?.scheduledTime
        ? alarm.scheduledTime
        : (storedEnd > 0 && storedEnd <= Date.now() ? storedEnd : 0);
      if (overdueTriggerAt) {
        await runSmartStep({ scheduledTime: overdueTriggerAt });
      } else {
        await repairSmartScheduleClock();
      }
      return;
    }
    setSmartNextTriggerAt(alarm.scheduledTime);
    await persistSchedule('watchdogCheck-smart', { syncFromLiveAlarm: false });
    await updateBadge();
    return;
  }

  // 提取（Fowler Extract Function）：看门狗缺失闹钟恢复——按剩余时间补恢复，失败则补执行当前阶段动作。
  async function recoverMissingPwmAlarm() {
    const restored = await restoreIntervalAlarmFromStorage('看门狗：PWM 闹钟缺失，已按剩余时间补恢复');
    if (restored) return;
    console.warn('[AC扩展] 看门狗：PWM 闹钟缺失，补执行当前阶段动作');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }

  // 提取（Fowler Extract Function）：看门狗过期闹钟恢复——补恢复 → 推进下一周期边界 → 补执行。
  async function recoverExpiredPwmAlarm(alarm) {
    const restored = await restoreIntervalAlarmFromStorage('看门狗：PWM 闹钟过期，已按剩余时间补恢复');
    if (restored) return;
    // 尝试从已过期闹钟推进到下一周期边界，避免重置为整段 60 分钟
    const advanced = await advanceExpiredAlarmToNextBoundary(alarm.scheduledTime);
    if (advanced) return;
    console.warn('[AC扩展] 看门狗：PWM 闹钟已过期，触发执行...');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }

  const automationRevision = pwmRuntimeRevision;
  const alarm = await chrome.alarms.get('ac-pwm');
  if (!isAutomationOperationCurrent(automationRevision)) return;

  // 活闹钟存在 → 确保 storage 的 nextTriggerAt 与 alarm 同步（防止 SW 被 kill 后丢失）
  const triggerPlan = await persistReconciledPwmTrigger(
    alarm,
    'watchdogCheck',
    PWM_TRIGGER_NEXT_ONLY_OPTIONS,
    automationRevision
  );
  if (triggerPlan) {
    console.log('[AC扩展] 看门狗：已同步 nextTriggerAt ← live alarm');
  }

  if (!alarm) {
    await recoverMissingPwmAlarm();
  } else if (alarm.scheduledTime <= Date.now() - 60000) {
    await recoverExpiredPwmAlarm(alarm);
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
      // 终极防线：init 完成时，从当前模式 live alarm 同步 nextTriggerAt 到 storage。
      // 防止 SW 跑早期版本代码、setupAlarms 走重建路径、或某条 persist 漏 sync 时出现
      // "活闹钟在但 storage 缺绝对触发时间" 的红灯。init 末尾是端到端最后一道闭环。
      if (isAutomationAllowed()) {
        const automationRevision = isSmartAutomationEnabled()
          ? smartRuntimeRevision
          : pwmRuntimeRevision;
        const finalLiveAlarm = await chrome.alarms.get(getAutomationAlarmName());
        if (isSmartAutomationEnabled()) {
          if (getLiveAlarmEndMs(finalLiveAlarm)) {
            setSmartNextTriggerAt(finalLiveAlarm.scheduledTime);
            await persistSchedule('init-finalSync-smart', {
              syncFromLiveAlarm: false
            });
          }
          return;
        }
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
    await recordControlAuditMissedWake('init');
    if (!isSmartAutomationEnabled()) await backfillNextTriggerAt(true);
    if (schedule.enabled && !isAutomationAllowed()) {
      await onActiveBoundaryCrossed();
    }
    // [v0.5.6] 跨设备同步：在 setupAlarms 之前尝试从 chrome.storage.sync 采用远端相位。
    // 如有 sync 数据则合并到本地 schedule，再 setupAlarms，保证本机闹钟从对齐相位出发。
    // 新装在另一台设备的扩展启动时会先采用主机的 nextTriggerAt，避免本地从默认值跑偏。
    await tryAdoptSyncedState('init');
    // v0.5.10：page timer 已升为跨设备主同步通道（无论 pwmState 都会尝试对齐）
    await tryAdoptPageTimer('init');
    await ensureOffscreen();
    startHeartbeat();
    // 尽早放行消息处理：setupAlarms 会跑 runSmartStep → setPageTimer 等页面操作，
    // 最长可达 60s（BFCache 恢复 / 新鲜页验证）。若让 initReady 等到 setupAlarms 结束，
    // 「召唤医生」的 ensureDiagnostics 会因 await initReady 而超时。
    // runSmartStep 内部有 isCurrentSmartStepRunning/claimSmartStepOwnership 防重入，
    // 提前放行不会造成并发步骤冲突；initCompletedAt 仍在整段 init 结束后才标记。
    initResolve();
    await setupAlarms();
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
async function setupAlarms(startImmediately = false) {
  await rescheduleSmartWeatherAlarm();
  if (!isAutomationAllowed()) {
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (!isAutomationAllowed()) {
      await updateBadge();
      console.log(`[AC扩展] 自动控制${schedule.enabled ? '在运行时段外暂停' : '未启用'}`);
      return;
    }
  }

  if (isSmartAutomationEnabled()) {
    if (startImmediately) {
      smartRuntimeRevision += 1;
      lastSmartStepAt = 0;
      const setupRevision = smartRuntimeRevision;
      if (typeof invalidateTimerBasedShutdown === 'function') {
        invalidateTimerBasedShutdown();
      }
      await cancelAutomaticOnRequests();
      await chrome.alarms.clear('ac-page-timer-retry');
      schedule.pageTimerRetryAt = 0;
      schedule.pageTimerRetryMinutes = 0;
      await clearSmartAlarm(setupRevision);
      if (!isAutomationOperationCurrent(setupRevision, 'smart')) return;
      replaceSmartRetryState();
      setSmartNextTriggerAt(0);
      schedule.smartOnBoundaryAt = 0;
      setSmartNextAction('on');
      await runSmartStep();
      return;
    }

      const smartSetupRevision = smartRuntimeRevision;
      const smartSetupIsCurrent = () => isAutomationOperationCurrent(
        smartSetupRevision,
        'smart'
      );
      if (!smartSetupIsCurrent()) return;

    async function recoverSmartAlarm() {
      const now = Date.now();
      const existingAlarm = await chrome.alarms.get('ac-smart');
        if (!smartSetupIsCurrent()) return;
      const liveDueAt = getLiveAlarmEndMs(existingAlarm);
      if (liveDueAt) {
          if (!smartSetupIsCurrent()) return;
        setSmartNextTriggerAt(liveDueAt);
        await persistSchedule('setupAlarms: 沿用现有 Smart 闹钟', {
          syncFromLiveAlarm: false
        });
        await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
        await updateBadge();
        console.log('[AC扩展] 沿用浏览器中已有的 Smart 闹钟');
        return;
      }

      const existingEnd = getStoredAlarmEndMs();
      if (existingEnd > now) {
        if (!smartSetupIsCurrent()) return;
        await clearSmartAlarm(smartSetupRevision);
        if (!smartSetupIsCurrent()) return;
        const alarmCreated = await createAutomationAlarmFromPlan(
          'ac-smart',
          { nextTriggerAt: existingEnd },
          'restore-smart',
          smartRuntimeRevision
        );
        if (alarmCreated) {
          await persistSchedule('restore-smart', { syncFromLiveAlarm: false });
          await updateBadge();
          return;
        }
      }

      // 已过期（或刚被消费）的触发意图：统一交给 runSmartStep，而不是直接 repairSmartScheduleClock。
      // repairSmartScheduleClock 看到「AC OFF」会一律按「等待下一半点开机」重建，从而在 SW 被
      // 逐出后错过刚过半点的开机（例如 02:30 该开机、02:31 醒来却直接排到 03:00）。
      // 这里优先用 storage 里记录的过期触发时间，让 runSmartStep 的 late-wake recovery 判断
      // 是补开机（跑道仍够）还是顺延下一半点。
      const overdueTriggerAt = (existingAlarm?.scheduledTime
          && existingAlarm.scheduledTime <= now)
        ? existingAlarm.scheduledTime
        : (existingEnd > 0 && existingEnd <= now ? existingEnd : 0);
      if (overdueTriggerAt) {
        if (!smartSetupIsCurrent()) return;
        await runSmartStep({ scheduledTime: overdueTriggerAt });
        return;
      }

      if (!smartSetupIsCurrent()) return;
      await repairSmartScheduleClock();
      console.log('[AC扩展] Smart 闹钟缺失，已按当前状态重建');
    }

    await recoverSmartAlarm();
    return;
  }

  schedule.onMinutes = sanitizeMinutes(schedule.onMinutes, 30);
  schedule.offMinutes = sanitizeMinutes(schedule.offMinutes, 30);

  if (startImmediately) {
    pwmRuntimeRevision += 1;
    lastPwmStepAt = 0;
    const setupRevision = pwmRuntimeRevision;
    if (typeof invalidateTimerBasedShutdown === 'function') {
      invalidateTimerBasedShutdown();
    }
    await cancelAutomaticOnRequests();
    await chrome.alarms.clear('ac-page-timer-retry');
    schedule.pageTimerRetryAt = 0;
    schedule.pageTimerRetryMinutes = 0;
    await clearPwmAlarm(setupRevision);
    if (!isAutomationOperationCurrent(setupRevision)) return;
    replacePwmRetryState();
    setPwmNextTriggerAt(0);
    schedule.pwmState = 'on';
    // 不在这里写 storage——runPwmStep() 执行完毕后会写入完整的正确状态
    await runPwmStep();
    return;
  }

  // ----- 间隔模式 -----
  // 提取（Fowler Extract Function）：间隔模式下的闹钟恢复链——live 沿用 → storage 恢复 → 过期推进 → 立即补执行 → 重建。
  const pwmSetupRevision = pwmRuntimeRevision;
  const pwmSetupIsCurrent = () => isAutomationOperationCurrent(
    pwmSetupRevision,
    'pwm'
  );
  if (!pwmSetupIsCurrent()) return;

  async function recoverIntervalAlarm() {
    const now = Date.now();
    const existingAlarm = await chrome.alarms.get('ac-pwm');
    if (!pwmSetupIsCurrent()) return;
    const liveDueAt = getLiveAlarmEndMs(existingAlarm);
    if (liveDueAt) {
      if (!pwmSetupIsCurrent()) return;
      await syncStoredTriggerFromAlarm(existingAlarm, 'setupAlarms: 沿用现有 PWM 闹钟');
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      await updateBadge();
      console.log('[AC扩展] 沿用浏览器中已有的 PWM 闹钟');
      return;
    }

    const existingEnd = getStoredAlarmEndMs();
    const remainingMinutes = existingEnd > now
      ? Math.max(1, (existingEnd - now) / 60000)
      : null;

    if (remainingMinutes) {
      if (!pwmSetupIsCurrent()) return;
      const restored = await restoreIntervalAlarmFromStorage('PWM 闹钟已恢复');
      if (restored) return;
    }

    // 闹钟和 storage 都不在将来 → 尝试从已过期的闹钟时间推进
    if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime <= now) {
      if (!pwmSetupIsCurrent()) return;
      const advanced = await advanceExpiredAlarmToNextBoundary(existingAlarm.scheduledTime);
      if (advanced) {
        console.log('[AC扩展] 已从过期闹钟推进到下一周期边界');
        return;
      }
    }

    if (existingEnd && existingEnd <= now) {
      console.warn('[AC扩展] PWM 计划时间已过，立即补执行到期动作');
      if (!pwmSetupIsCurrent()) return;
      await runPwmStep();
      return;
    }

    if (!pwmSetupIsCurrent()) return;
    await repairScheduleClock();
    console.log('[AC扩展] PWM 闹钟缺失，已按当前状态重建');
  }

  await recoverIntervalAlarm();
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
  if (await shouldShowControlAuditBadge()) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setTitle({ title: '自动开启未确认' });
    return;
  }

  // 页面定时器错误同样置红，避免绿色倒计时掩盖「自动控制上次失败」。
  if (schedule.pageTimerError) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setTitle({ title: String(schedule.pageTimerError).slice(0, 120) });
    return;
  }

  // 当前模式的 live alarm；旧 pwmState/nextTriggerAt 只用于兼容展示投影。
  const liveAlarm = await getAutomationAlarm();
  const liveAlarmEnd = getLiveAlarmEndMs(liveAlarm);
  const storedAlarmEnd = getStoredAlarmEndMs();
  const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);
  if (!nextBoundary) {
    await clearBadge();
    return;
  }

  const nextAction = isSmartAutomationEnabled()
    ? schedule.smartState
    : schedule.pwmState;
  const remainingMs = nextBoundary - Date.now();

  if (remainingMs <= 0) {
    await chrome.action.setBadgeText({ text: 'now' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    await chrome.action.setTitle({ title: t('badgeIntervalSoon', t(nextAction === 'on' ? 'actionOn' : 'actionOff')) });
    return;
  }

  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const badgeText = remainingMinutes > 999 ? '999+' : String(remainingMinutes);
  const currentOn = nextAction !== 'on';

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

async function runSmartStep(alarmContext = {}) {
  if (!isAutomationAllowed() || !isSmartAutomationEnabled()) return;
  if (isCurrentSmartStepRunning()) {
    console.warn('[AC扩展] 智能步骤已在执行，跳过重复触发');
    return;
  }
  if (Date.now() - lastSmartStepAt < 5000) {
    console.warn('[AC扩展] 智能步骤距上次执行不足 5s，跳过重复触发');
    return;
  }

  const automationRevision = claimSmartStepOwnership();

  async function commitSmartAlarm(nextTriggerAt, reason, afterAlarmVerified) {
    const nextAt = Number(nextTriggerAt);
    if (!Number.isFinite(nextAt) || nextAt <= Date.now()) {
      throw new Error(`智能计划缺少未来触发时间: ${reason}`);
    }
    replaceSmartRetryState();
    await clearSmartAlarm(automationRevision);
    const alarmCreated = await createAutomationAlarmFromPlan(
      'ac-smart',
      { nextTriggerAt: nextAt },
      reason,
      automationRevision
    );
    if (alarmCreated === false) return false;
    if (typeof afterAlarmVerified === 'function') {
      await afterAlarmVerified();
    }
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      automationRevision,
      `runSmartStep-${reason}-active-hours-paused`,
      'smart'
    )) return false;
    await persistSchedule(`runSmartStep-${reason}`, { syncFromLiveAlarm: false });
    await updateBadge();
    return true;
  }

  async function commitSmartOnRetry(boundaryAt, now, reason) {
    const retryPlan = planSmartOnRetryExceptionRecovery(
      schedule,
      boundaryAt,
      { now, retryAt: now + 60000 }
    );
    if (!retryPlan || Number(retryPlan.nextTriggerAt) <= now) return false;
    applySmartPlanState(retryPlan);
    const retryKind = retryPlan.kind === 'retry-smart-on-exception'
      ? typeof SMART_RETRY_KINDS === 'object'
        ? SMART_RETRY_KINDS.ON
        : 'smart-on'
      : '';
    return commitSmartAlarm(
      retryPlan.nextTriggerAt,
      reason,
      retryKind
        ? () => replaceSmartRetryState({
            kind: retryKind,
            boundaryAt: Number(retryPlan.boundaryAt) || 0,
            scheduledAt: Number(schedule.smartNextTriggerAt)
              || retryPlan.nextTriggerAt
          })
        : undefined
    );
  }

  try {
    await waitUntil((async () => {
      await loadScheduleFromStorage();
      if (!isAutomationOperationCurrent(automationRevision, 'smart')
          || !isSmartAutomationEnabled()) return;

      const now = Date.now();
      const liveAlarm = await chrome.alarms.get('ac-smart');
      const alarmScheduledAt = Number(alarmContext?.scheduledTime)
        || Number(liveAlarm?.scheduledTime)
        || 0;
      const boundaryAt = normalizeHalfHourAlarmBoundary(alarmScheduledAt);
      if (schedule.smartState === 'on' && boundaryAt > 0 && boundaryAt <= now + 1500) {
        await applySmartDurationsForBoundary(boundaryAt);
        if (await abortStaleAutomation(
          automationRevision,
          'runSmartStep-weather-active-hours-paused',
          'smart'
        )) return;
      }

      let typedRetryClock = null;
      if (schedule.smartState === 'on' && alarmScheduledAt > 0) {
        const clock = classifySmartOnClock(schedule, alarmScheduledAt, {
          now,
          plannedAt: schedule.smartClockPlannedAt,
          nextAction: 'on',
          toleranceMs: 1500,
          allowDue: true,
          requirePlannedAt: true
        });
        if (clock?.applicable && !clock.valid) {
          await repairSmartScheduleClock({
            smartOnExpectedBoundaryAt: Number(clock.expectedAt) || 0
          });
          return;
        }
        if (clock?.valid && clock.kind === 'typed-retry'
            && normalizeHalfHourAlarmBoundary(alarmScheduledAt) === 0
            && isSmartHalfHourBoundary(Number(clock.boundaryAt))) {
          typedRetryClock = clock;
        }
      }

      let plan = planSmartStep(schedule, {
        now,
        alarmScheduledAt
      });
      // Service Worker may deliver an exact half-hour alarm late. Re-evaluate
      // the current cycle before deferring; only proceed when the full safety
      // runway remains, so a late wake cannot turn into an unsafe short run.
      if (plan?.kind === 'defer'
          && (plan.reason === 'smart-on-window-expired'
            || plan.reason === 'smart-on-runway-too-short')) {
        const recoveryPlan = planSmartModeOnWindow(schedule, {
          now,
          maxOnMinutes: SMART_MODE.ON_MAX,
          acIsOn: false,
          boundaryAt: boundaryAt || alarmScheduledAt,
          triggeredBoundaryAt: boundaryAt || alarmScheduledAt,
          recoverCurrentCycle: true
        });
        if (recoveryPlan?.kind === 'allow') {
          plan = {
            kind: 'start',
            reason: 'smart-on-late-wake-recovery',
            nextAction: 'off',
            boundaryAt: recoveryPlan.boundaryAt,
            windowEndsAt: recoveryPlan.windowEndsAt,
            onMinutes: schedule.onMinutes,
            targetAt: recoveryPlan.pageTimerTargetAt,
            nextTriggerAt: recoveryPlan.pageTimerTargetAt
          };
        }
      }
      if (typedRetryClock) {
        // 智能 ON 预布防失败后的非半点重试：ac-smart 一分钟后再次触发，
        // 但 alarmScheduledAt 不再是半点边界。分类器已识别 typed-retry marker，
        // 这里以原半点边界与绝对关机截止直接重跑「写关机时间 → 确认开机」，
        // 而不是把本周期剩余 ON 时间白白延到下一半点。
        const retryTargetAt = Number(typedRetryClock.pageTimerTargetAt);
        plan = {
          kind: 'start',
          reason: 'smart-on-typed-retry',
          nextAction: 'off',
          boundaryAt: Number(typedRetryClock.boundaryAt),
          windowEndsAt: retryTargetAt,
          onMinutes: Number(schedule.onMinutes),
          targetAt: retryTargetAt,
          nextTriggerAt: retryTargetAt
        };
      }
      if (!plan || plan.kind === 'noop') return;
      if (plan.nextAction === 'on') {
        alignSmartModeNextTrigger(plan, now, { notBeforeAt: now + 1 });
      }

      if (plan.kind === 'wait') {
        if (plan.nextTriggerAt > now) {
          await commitSmartAlarm(plan.nextTriggerAt, 'smart-off-wait');
        } else {
          await repairSmartScheduleClock();
        }
        return;
      }

      if (plan.kind === 'start') {
        // 连轴转退出后的补开启动：锚点已由 planSmartOnAfterConfirmedOff 规划，
        // 跳过半点网格窗口校验（planSmartModeOnWindow），直接采用绝对目标。
        const plannedStart = plan.reason === 'smart-on-planned-start';
        const onWindowPlan = plannedStart
          ? {
              kind: 'allow',
              reason: plan.reason,
              boundaryAt: plan.boundaryAt,
              pageTimerTargetAt: plan.targetAt,
              windowEndsAt: plan.windowEndsAt
            }
          : planSmartModeOnWindow(schedule, {
              now,
              maxOnMinutes: SMART_MODE.ON_MAX,
              acIsOn: false,
              boundaryAt: plan.boundaryAt,
              triggeredBoundaryAt: plan.boundaryAt
            });
        if (onWindowPlan.kind !== 'allow') {
          await commitSmartOnRetry(
            plan.boundaryAt,
            now,
            'smart-on-window-retry'
          );
          return;
        }

        const targetAt = Number(onWindowPlan.pageTimerTargetAt) > now
          ? onWindowPlan.pageTimerTargetAt
          : plan.targetAt;
        const plannedWindowEndsAt = Number(onWindowPlan.windowEndsAt) > now
          ? onWindowPlan.windowEndsAt
          : plan.windowEndsAt;
        const activeHoursDeadlineAt = getAutomaticOnDeadline(plannedWindowEndsAt);
        const windowEndsAt = activeHoursDeadlineAt > 0
          ? activeHoursDeadlineAt
          : plannedWindowEndsAt;
        schedule.smartOnBoundaryAt = onWindowPlan.boundaryAt || plan.boundaryAt;
        schedule.smartOffSafetyTimerUsed = false;
        const timerMinutes = Math.max(
          1,
          Math.ceil((targetAt - now) / 60000)
        );
        const armResult = await armPowerOffTimerEnsuringOn(timerMinutes, {
          targetAt,
          automaticOnDeadlineAt: windowEndsAt,
          automationRevision,
          automationMode: 'smart',
          requireAutomationAllowed: true
        });
        if (await abortStaleAutomation(
          automationRevision,
          'runSmartStep-arm-active-hours-paused',
          'smart'
        )) return;

        if (!armResult?.success) {
          if (armResult.failureStage === 'write') {
            schedule.pageTimerError = `智能自动开启前页面关机定时器未确认：${formatPageTimerFailureEvidence({
              error: armResult.error,
              failureStage: armResult.pageTimerFailureStage,
              expectedValue: armResult.pageTimerExpectedValue,
              observedValue: armResult.pageTimerObservedValue,
              observedTitle: armResult.pageTimerObservedTitle,
              visibleDropdownCount: armResult.pageTimerVisibleDropdownCount
            })}`;
            await commitSmartOnRetry(
              plan.boundaryAt,
              Date.now(),
              'smart-on-page-timer-retry'
            );
            return;
          }
          if (armResult.failureStage === 'ensure-on') {
            schedule.pageTimerError = '智能自动开启未确认；本轮不重复点击，等待下一半点';
            await commitSmartOnRetry(
              plan.boundaryAt,
              Date.now(),
              'smart-on-confirmation-retry'
            );
            return;
          }
          // 关机定时器验证失败（新鲜页读回空）：不再补设 1 分钟安全定时器（那会让空调
          // 每分钟开关一次、很伤压缩机），也不再立刻重试；保持空调当前状态，推迟到下一半点再试。
          schedule.pageTimerError = `智能开启后关机定时器未确认：${armResult.error || '未知错误'}`;
          clearPageTimerProofState();
          schedule.smartOnBoundaryAt = 0;
          await commitSmartAlarm(
            nextSmartHalfHourBoundary(now),
            'smart-on-verify-failed-defer'
          );
          return;
        }

        schedule.pageTimerMinutes = armResult.actualDelayMinutes || timerMinutes;
        schedule.pageTimerTargetAt = armResult.targetAt;
        schedule.pageTimerError = '';
        schedule.pageTimerRetryAt = 0;
        schedule.pageTimerRetryMinutes = 0;
        await chrome.alarms.clear('ac-page-timer-retry');
        await persistSchedule('smart-on-page-timer-confirmed', {
          syncFromLiveAlarm: false
        });

        setSmartNextAction('off');
        schedule.smartPlannedOnAt = 0;
        // 连轴转周期：ac-smart 闹钟放在页面关机保险丝引爆前 1 分钟，
        // 届时评估下一周期需求——继续连转则推前保险丝，压缩机不停机。
        const offAlarmAt = schedule.offMinutes === 0
          && schedule.onMinutes === SMART_MODE.CYCLE_MINUTES
          ? Math.max(now + 60000, targetAt - 60000)
          : targetAt;
        await commitSmartAlarm(offAlarmAt, 'smart-off-boundary');
        return;
      }

      if (plan.kind === 'finish') {
        if (await abortStaleAutomation(
          automationRevision,
          'runSmartStep-off-boundary-active-hours-paused',
          'smart'
        )) return;
        // 连轴转：ac-smart 在保险丝引爆前 1 分钟触发。先消费下一边界天气决策，
        // 仍超 25 分钟则把保险丝推到下一边界（压缩机不停机）；需求回落则让
        // 保险丝照常引爆（服务器关机），再按新时长在离格锚点补开，占空比无损。
        const runThroughCycle = schedule.onMinutes === SMART_MODE.CYCLE_MINUTES
          && Number(schedule.offMinutes) === 0;
        const fuseTargetAt = Number(schedule.pageTimerTargetAt) || 0;
        if (runThroughCycle && fuseTargetAt > now + 30000) {
          const nextBoundaryAt = plan.nextTriggerAt;
          const nextDecision =
            await applySmartDurationsForBoundary(nextBoundaryAt);
          if (await abortStaleAutomation(
            automationRevision,
            'runSmartStep-runthrough-extend-active-hours-paused',
            'smart'
          )) return;
          if (nextDecision?.runThrough === true) {
            const continuedTargetAt =
              nextBoundaryAt + SMART_MODE.CYCLE_MINUTES * 60000;
            const timerMinutes = Math.max(
              1,
              Math.ceil((continuedTargetAt - now) / 60000)
            );
            const armResult = await armPowerOffTimerEnsuringOn(timerMinutes, {
              targetAt: continuedTargetAt,
              automationRevision,
              automationMode: 'smart',
              requireAutomationAllowed: true
            });
            if (armResult?.success) {
              schedule.pageTimerMinutes =
                armResult.actualDelayMinutes || timerMinutes;
              schedule.pageTimerTargetAt = armResult.targetAt;
              schedule.pageTimerError = '';
              schedule.pageTimerRetryAt = 0;
              schedule.pageTimerRetryMinutes = 0;
              schedule.smartOnBoundaryAt = nextBoundaryAt;
              schedule.smartPlannedOnAt = 0;
              await chrome.alarms.clear('ac-page-timer-retry');
              await persistSchedule('smart-runthrough-continue', {
                syncFromLiveAlarm: false
              });
              setSmartNextAction('off');
              await commitSmartAlarm(
                continuedTargetAt - 60000,
                'smart-runthrough-continue'
              );
              return;
            }
            // 保险丝改写失败：原保险丝照常引爆（服务器关机），落入常规退出路径。
          } else if (
            nextDecision?.valid === true
            && Number(nextDecision.onMinutes) > 0
          ) {
            const plannedOnAt = nextBoundaryAt
              + (SMART_MODE.CYCLE_MINUTES - Number(nextDecision.onMinutes))
              * 60000;
            const afterConfirmedOffPlan = planSmartOnAfterConfirmedOff(
              schedule,
              { now, confirmedOffAt: now, plannedOnAt }
            );
            if (afterConfirmedOffPlan.kind !== 'refuse') {
              alignSmartModeNextTrigger(
                afterConfirmedOffPlan,
                now,
                { notBeforeAt: plan.nextTriggerAt }
              );
              applySmartPlanState(afterConfirmedOffPlan);
              schedule.smartPlannedOnAt = plannedOnAt;
              schedule.smartOnBoundaryAt = 0;
              clearPageTimerProofState();
              replaceSmartRetryState();
              await commitSmartAlarm(
                afterConfirmedOffPlan.nextTriggerAt,
                'smart-on-boundary'
              );
              return;
            }
          }
          schedule.smartPlannedOnAt = 0;
        }
        // 关机时间（Power-off after）由 UST 服务器保证执行：只要已写入关机时间，学校
        // 一定会帮忙关机。此处无需读回 AC 状态确认、也无需补设 1 分钟安全定时器。
        clearPageTimerProofState();
        schedule.smartOnBoundaryAt = 0;
        schedule.smartOffSafetyTimerUsed = false;
        schedule.pageTimerError = '';
        const afterConfirmedOffPlan = planSmartOnAfterConfirmedOff(schedule, {
          now,
          confirmedOffAt: now
        });
        if (afterConfirmedOffPlan.kind === 'refuse') {
          await commitSmartAlarm(plan.nextTriggerAt, 'smart-on-boundary');
          return;
        }
        alignSmartModeNextTrigger(
          afterConfirmedOffPlan,
          now,
          { notBeforeAt: plan.nextTriggerAt }
        );
        applySmartPlanState(afterConfirmedOffPlan);
        schedule.smartOnBoundaryAt = 0;
        replaceSmartRetryState();
        await commitSmartAlarm(
          afterConfirmedOffPlan.nextTriggerAt,
          'smart-on-boundary'
        );
        return;
      }

      if (plan.kind === 'skip') {
        schedule.smartOnBoundaryAt = 0;
        clearPageTimerProofState();
      }
      applySmartPlanState(plan);
      if (!plan.phasePatch) setSmartNextAction('on');
      await commitSmartAlarm(plan.nextTriggerAt, `smart-${plan.kind}`);
    })());
  } catch (error) {
    console.error('[AC扩展] 智能步骤执行失败:', error);
    void appendDiagnosticLog('error', 'smart-step', error);
  } finally {
    releaseSmartStepOwnership(automationRevision);
  }
}

async function runPwmStep() {
  if (isSmartAutomationEnabled()) return;
  if (!isAutomationAllowed()) {
    await recordControlAuditAdmission('failed', 'automation-blocked');
    return;
  }
  if (isCurrentPwmStepRunning()) {
    await recordControlAuditAdmission('failed', 'step-in-flight');
    console.warn('[AC扩展] PWM 步骤已在执行，跳过重复触发');
    return;
  }
  // A4: 看门狗 5s cooldown — 防止看门狗与闹钟竞态导致重复触发
  if (Date.now() - lastPwmStepAt < 5000) {
    await recordControlAuditAdmission('failed', 'cooldown');
    console.warn('[AC扩展] PWM 步骤距上次执行不足 5s，跳过（看门狗 cooldown）');
    return;
  }
  const automationRevision = claimPwmStepOwnership();
  let controlAuditOnOutcomeRecorded = false;

  // 提取（Fowler Extract Function）：PWM ON 相位原子布防——一次调用 armPowerOffTimerEnsuringOn
  // 完成「写关机时间 → 确认开机 → 开新页验证」，观察结果写回 observations；
  // 开机审计经 ensureOn 钩子在 toggle 前后插入，外围绝不重复点击。
  async function resolvePageTimerArmHold(plan, observations) {
    applyPwmPlanState(plan);
    await recordControlAuditTimerPrearm(
      'started',
      0,
      'prearm-started'
    );

    const armResult = await armPowerOffTimerEnsuringOn(plan.timerMinutes, {
      automaticOnDeadlineAt: getAutomaticOnDeadline(),
      automationRevision,
      automationMode: 'pwm',
      requireAutomationAllowed: true,
      ensureOn: async (notAfterAt, controlTabId) => {
        await recordControlAuditDispatch();
        try {
          const toggleResult = await toggleAC('on', {
            requireAutomationAllowed: true,
            automationRevision,
            controlTabId,
            ...(notAfterAt > 0 ? { notAfterAt } : {})
          });
          observations.toggleSucceeded = !!toggleResult?.success;
          observations.toggleError = toggleResult?.error || '';
          return toggleResult;
        } catch (e) {
          observations.toggleSucceeded = false;
          observations.toggleError = e?.message || String(e);
          return { success: false, error: observations.toggleError };
        }
      }
    });

    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-arm-active-hours-paused'
    )) return null;

    const writeSucceeded = armResult?.failureStage !== 'write';
    await recordControlAuditTimerPrearm(
      writeSucceeded ? 'ok' : 'failed',
      Number(armResult?.targetAt) || 0,
      writeSucceeded ? 'prearm-confirmed' : 'prearm-unconfirmed'
    );

    observations.pageTimerSucceeded = writeSucceeded;
    observations.pageTimerTargetAt = Number(armResult?.targetAt) || 0;
    observations.pageTimerValue = String(armResult?.value || '').trim();
    observations.acIsOn = armResult?.acIsOn === true;
    observations.pageTimerVerified = armResult?.success === true;

    if (armResult?.toggledOn) {
      observations.toggleSucceeded = armResult?.acIsOn === true;
      if (armResult?.acIsOn === true) {
        await recordControlAuditOnOutcome(true, 'status-confirmed');
        await recordControlAuditTerminal('confirmed', 'status-confirmed');
        controlAuditOnOutcomeRecorded = true;
        schedule.pageTimerError = '';
        console.log('[AC扩展] PWM 开机只读复核通过：AC=ON');
      } else {
        await recordControlAuditOnOutcome(false, 'status-unconfirmed');
        controlAuditOnOutcomeRecorded = true;
        console.warn('[AC扩展] PWM 本轮未开机：外围不重复点击，1分钟后重试');
      }
    }

    if (armResult?.failureStage === 'verify') {
      const safety = await setPageTimer(1, {
        retryOnFailure: false,
        automationRevision
      });
      observations.pageTimerError = `开机后关机定时器未确认：${armResult.error || '未知错误'}${safety?.success ? '；已补设 1 分钟关机' : ''}`;
      await recordControlAuditTimerPrearm(
        'failed',
        Number(armResult?.targetAt) || 0,
        'prearm-unpersisted'
      );
    } else if (armResult?.failureStage === 'ensure-on') {
      observations.toggleError = armResult.error || '自动开启未确认';
    } else if (armResult?.success) {
      observations.pageTimerError = '';
      schedule.pageTimerError = '';
      await recordControlAuditTimerPrearm(
        'ok',
        Number(armResult?.targetAt) || 0,
        'prearm-persisted'
      );
    } else {
      observations.pageTimerError = armResult.error || '';
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
    const isPageTimerRetry = plan.reason === 'page-timer-failed'
      || plan.reason === 'page-timer-verify-failed';
    const failureDetail = isPageTimerRetry
      ? observations.pageTimerError
      : observations.toggleError;
    applyPwmPlanState(plan);
    if (plan.reason === 'page-timer-failed' && targetAction === 'on') {
      schedule.pageTimerError = `自动开启前页面关机定时器未确认：${failureDetail || '未知错误'}；保持 on 相位，1 分钟后重试 setPageTimer`;
    } else if (plan.reason === 'page-timer-verify-failed') {
      schedule.pageTimerError = failureDetail || schedule.pageTimerError
        || '开机后关机定时器未确认，1分钟后重试';
    } else {
      schedule.pageTimerError = failureDetail || schedule.pageTimerError
        || `自动${targetAction === 'on' ? '开启' : '关闭'}验证失败，1分钟后重试`;
    }
    const alarmCreated = await createPwmAlarmFromPlan(
      plan,
      isPageTimerRetry ? 'PWM-pageTimer-failed' : 'PWM失败重试',
      automationRevision
    );
    if (alarmCreated === false) return;
    markPwmRetry(
      isPageTimerRetry
        ? PWM_RETRY_KINDS.PAGE_TIMER
        : PWM_RETRY_KINDS.TOGGLE
    );
    await recordControlAuditRetryScheduled(
      Number(plan.nextTriggerAt),
      isPageTimerRetry
        ? 'prearm-retry'
        : 'dispatch-retry'
    );
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    if (await abortStaleAutomation(
      automationRevision,
      'runPwmStep-retry-active-hours-paused'
    )) return;
    await persistSchedule(
      isPageTimerRetry
        ? 'runPwmStep-on-pageTimer-failed'
        : 'runPwmStep-interval'
    );
    await updateBadge();
    console.warn(`[AC扩展] PWM 未提交，保持 pwmState=${schedule.pwmState}，1分钟后重试`);
  }

  return waitUntil((async () => {
  try {
    await loadScheduleFromStorage();
    if (!isAutomationAllowed() || isSmartAutomationEnabled()) {
      await recordControlAuditAdmission('failed', 'revision-stale');
      return;
    }
    await recordControlAuditAdmission('ok', 'revision-current');

    const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
    const currentDuration = Number(
      targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes
    );
    let observations = {};
    let plan = planPwmStep(schedule, observations);
    if (plan.kind === 'refuse') {
      await recordControlAuditTerminal('failed', 'planner-refused');
      schedule.pageTimerError = `PWM 阶段拒绝执行：${plan.reason}`;
      console.warn(`[AC扩展] ${schedule.pageTimerError}`);
      await persistSchedule('runPwmStep-refused', { syncFromLiveAlarm: false });
      return;
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

    if (preCheckStatus?.isOn === (targetAction === 'on')) {
      console.log(`[AC扩展] 预检：AC 已在目标状态 (${targetAction})，跳过 ON 点击但仍按 planner 确认安全前置`);
    }

    if (targetAction === 'off' && observations.proofFresh === true) {
      console.log(`[AC扩展] PWM 关机边界：页面定时器已正确设置 (${schedule.pageTimerMinutes} 分钟)，不点击开关`);
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'arm-page-timer') {
      plan = await resolvePageTimerArmHold(plan, observations);
      if (!plan) return;
    }

    if (plan.kind === 'refuse') {
      await recordControlAuditTerminal('failed', 'pwm-planner-refused');
      schedule.pageTimerError = `PWM 自动阶段被拒绝：${plan.reason}`;
      await persistSchedule('runPwmStep-refused', { syncFromLiveAlarm: false });
      return;
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

    if (targetAction === 'on'
        && observations.acIsOn === true
        && !controlAuditOnOutcomeRecorded) {
      await recordControlAuditOnOutcome(true, 'already-on');
      await recordControlAuditTerminal('confirmed', 'already-on');
      controlAuditOnOutcomeRecorded = true;
    }

    replacePwmRetryState();

    applyPwmPlanState(plan);
  if (await abortStaleAutomation(
    automationRevision,
    'runPwmStep-commit-active-hours-paused'
  )) return;
  const alarmCreated = await createPwmAlarmFromPlan(plan, 'PWM', automationRevision);
  if (alarmCreated === false) return;
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
    await syncScheduleToSync('runPwmStep');
  } finally {
    releasePwmStepOwnership(automationRevision);
  }
  })());
}

// 通过新鲜页面确认 Power-off after 已离开当前 React 状态并真正持久化。
// 写入来源页无论是用户页还是扩展自建隐藏页都不能刷新：过早导航可能中断 UST
// 的异步提交。每次读回都新建临时隐藏页，按退避窗口等待服务器落盘后再验证。
async function verifyPageTimerPersistence(
  expectedValue,
  {
    automationRevision = null,
    automationMode = 'pwm',
    shutdownRevision = null,
    notAfterAt = 0
  } = {}
)
{
  let lastActualValue = '';
  let lastFailure = '';
  let lastAcIsOn = null;

  const shutdownVerificationIsCurrent = () => shutdownRevision === null
    || (typeof isTimerBasedShutdownCurrent === 'function'
      && isTimerBasedShutdownCurrent(shutdownRevision));
  const verificationIsCurrent = () => (
    (automationRevision === null
      || isAutomationOperationCurrent(automationRevision, automationMode))
    && shutdownVerificationIsCurrent()
    && (!(notAfterAt > 0) || Date.now() < notAfterAt)
  );
  const staleVerificationResult = () => {
    if (automationRevision !== null
      && !isAutomationOperationCurrent(automationRevision, automationMode)) {
      return { success: false, automationStale: true };
    }
    if (!shutdownVerificationIsCurrent()) {
      return { success: false, shutdownStale: true };
    }
    return { success: false, automaticDeadlineExpired: true };
  };

  // 提取（Fowler Extract Function）：单次新鲜页读回尝试——建临时隐藏页、读回、比对、回收。
  async function attemptPersistenceRead(expectedValue, attempt) {
    let verifierTabId = null;
    try {
      if (!verificationIsCurrent()) {
        return staleVerificationResult();
      }
      await sleep(PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS[attempt]);
      if (!verificationIsCurrent()) {
        return staleVerificationResult();
      }

      const verifierTab = await chrome.tabs.create({ url: AC_PAGE, active: false });
      verifierTabId = verifierTab?.id || null;
      if (!verifierTabId) throw new Error('无法创建页面定时器验证标签页');
      // 兜底回收闹钟：每轮验证页若 SW 在 sleep(30000) 窗口被杀导致 finally 不执行，
      // 1 分钟后该闹钟兜底关闭隐藏标签，避免泄漏。与 setPageTimer / _toggleOnNewTab 同模式。
      chrome.alarms.create(`ac-close-tab-${verifierTabId}`, { delayInMinutes: 1 });

      const pageReady = await waitForTabReady(verifierTabId, 30000);
      if (!pageReady) throw new Error('页面定时器验证页等待就绪超时');
      if (!verificationIsCurrent()) return staleVerificationResult();
      const verifierTarget = await getExactACHomeTab(verifierTabId);
      if (!verifierTarget) throw new Error('页面定时器验证页未停留在精确 home URL');
      if (!verificationIsCurrent()) return staleVerificationResult();
      // 新鲜页 React 组件可能还没把服务器端定时器渲染到 picker，读回空只是「没加载出来」；
      // 轮询读回直到有值或超时，避免把加载延迟误判为「未持久化」。
      let readback = null;
      const readbackDeadline = Date.now() + 12000;
      while (Date.now() < readbackDeadline) {
        readback = await sendReadMessageToExactACHome(
          verifierTabId,
          { action: 'getPageTimer' }
        );
        if (!verificationIsCurrent()) {
          return staleVerificationResult();
        }
        if (readback?.value || readback?.title) break;
        await sleep(1000);
      }
      const actualValue = String(readback?.value || readback?.title || '').trim();
      const statusReadback = await sendReadMessageToExactACHome(
        verifierTabId,
        { action: 'status' }
      );
      const freshAcIsOn = statusReadback?.isOn === true;
      if (isPersistedPageTimerMatch(readback, expectedValue)) {
        return { success: true, value: actualValue, acIsOn: freshAcIsOn };
      }

      lastFailure = `第 ${attempt + 1} 次新鲜页读回不匹配（期望 ${expectedValue}，实际 ${actualValue || '空'}）`;
      return { success: false, actualValue, acIsOn: freshAcIsOn };
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
    if (attemptResult.automationStale
        || attemptResult.shutdownStale
        || attemptResult.automaticDeadlineExpired) {
      return attemptResult;
    }
    if (attemptResult.success) {
      return {
        success: true,
        value: attemptResult.value,
        acIsOn: attemptResult.acIsOn,
        attempts: attempt + 1
      };
    }
    if (attemptResult.actualValue !== undefined) {
      lastActualValue = attemptResult.actualValue;
    }
    if (attemptResult.acIsOn !== undefined) {
      lastAcIsOn = attemptResult.acIsOn;
    }
  }

  return {
    success: false,
    error: `页面定时器经 ${PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length} 次新鲜页验证后仍未持久化：${lastFailure || '未知错误'}`,
    actualValue: lastActualValue,
    acIsOn: lastAcIsOn,
    attempts: PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length
  };
}

// 新鲜页必须同时读到 value/title；仅 value 可能只是 React 本地状态，不能证明 UST 已持久化。
function isPersistedPageTimerMatch(readback, expectedValue) {
  return readback?.found === true
    && String(readback.value || '').trim() === expectedValue
    && String(readback.title || '').trim() === expectedValue;
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

async function clearSupersededTimerBasedShutdownRetry() {
  const shutdownRevision = invalidateTimerBasedShutdown();
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
  await chrome.alarms.clear('ac-page-timer-retry');
  if (!isTimerBasedShutdownCurrent(shutdownRevision)) return false;
  await persistSchedule(
    'clear-superseded-timer-based-shutdown-retry',
    { syncFromLiveAlarm: false }
  );
  return isTimerBasedShutdownCurrent(shutdownRevision);
}

let pageTimerMessageWriteChain = Promise.resolve();

// 原子（Fowler Extract Function）：自动化操作 / 定时关机是否仍当前的共享谓词——
// setPageTimer 与 sendSerializedPageTimerMessage 重复，抽成可复用原子。
function automationOperationIsCurrent(automationRevision, automationMode) {
  return automationRevision === null
    || isAutomationOperationCurrent(automationRevision, automationMode);
}

function timerBasedShutdownIsCurrent(shutdownRevision) {
  return shutdownRevision === null
    || (typeof isTimerBasedShutdownCurrent === 'function'
      && isTimerBasedShutdownCurrent(shutdownRevision));
}

function sendSerializedPageTimerMessage(
  tabId,
  message,
  automationRevision = null,
  timeoutMs = 0,
  shutdownRevision = null,
  automationMode = 'pwm'
) {
  const operation = pageTimerMessageWriteChain
    .catch(() => {})
    .then(async () => {
      const shutdownWriteIsCurrent = () => timerBasedShutdownIsCurrent(shutdownRevision);
      const writeIsCurrent = () => (
        automationOperationIsCurrent(automationRevision, automationMode)
        && shutdownWriteIsCurrent()
      );
      const staleWriteResult = () => !shutdownWriteIsCurrent()
        ? { success: false, shutdownStale: true, error: '关机请求已失效' }
        : { success: false, automationStale: true, error: '自动控制已暂停' };
      if (!writeIsCurrent()) return staleWriteResult();
      const result = await sendMessageToExactACHome(
        tabId,
        message,
        {
          ...(timeoutMs > 0 ? { timeoutMs } : {}),
          ensureCurrent: writeIsCurrent
        }
      );
      if (!writeIsCurrent()) return staleWriteResult();
      return result;
    });
  pageTimerMessageWriteChain = operation.catch(() => {});
  return operation;
}

const PAGE_TIMER_RECOVERABLE_FAILURE_STAGES = new Set([
  'type-character',
  'confirm-stable',
  'typing-exception',
  'stabilize-control',
  'open-picker',
  'clear-input',
  'change',
  'enter',
  'locate-control',
  'final-control'
]);
const PAGE_TIMER_FAILURE_STRING_LIMITS = Object.freeze({
  error: 240,
  failureStage: 48,
  expectedValue: 16,
  observedValue: 16,
  observedTitle: 16
});
const PAGE_TIMER_FAILURE_NUMBER_LIMITS = Object.freeze({
  attempt: 3,
  inputReplacementCount: 99,
  controlCount: 99,
  visibleDropdownCount: 99,
  elapsedMs: 120000
});

function sanitizePageTimerFailureText(value, maxLength) {
  return String(value ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]{0,200}?<\/\1>/gi, '[redacted]')
    .replace(/<[^>]{1,200}>/g, '[redacted]')
    .replace(/\b(?:tabId|document|body|outerHTML|innerHTML)\b(?:\s*[:=]\s*\S+)?/gi, '[redacted]')
    .slice(0, maxLength);
}

function normalizePageTimerFailure(failure, fallbackError = '') {
  const source = failure && typeof failure === 'object' ? failure : {};
  const sourceError = typeof source.error === 'string' ? source.error : '';
  const normalized = {
    success: false,
    error: sanitizePageTimerFailureText(
      sourceError || fallbackError || t('bgPageTimerFailed'),
      PAGE_TIMER_FAILURE_STRING_LIMITS.error
    )
  };

  for (const [field, maxLength] of Object.entries(PAGE_TIMER_FAILURE_STRING_LIMITS)) {
    if (field === 'error' || typeof source[field] !== 'string') continue;
    normalized[field] = sanitizePageTimerFailureText(source[field], maxLength);
  }
  for (const [field, maximum] of Object.entries(PAGE_TIMER_FAILURE_NUMBER_LIMITS)) {
    if (typeof source[field] !== 'number' || !Number.isFinite(source[field])) continue;
    normalized[field] = Math.min(maximum, Math.max(0, Math.trunc(source[field])));
  }
  return normalized;
}

  function formatPageTimerFailureEvidence(failure, fallbackError = '未知错误') {
    const normalized = normalizePageTimerFailure(failure, fallbackError);
    const evidence = [];
    if (normalized.failureStage) evidence.push(`stage=${normalized.failureStage}`);
    if (normalized.expectedValue) evidence.push(`expected=${normalized.expectedValue}`);
    if (normalized.observedValue) evidence.push(`value=${normalized.observedValue}`);
    if (normalized.observedTitle) evidence.push(`title=${normalized.observedTitle}`);
    if (normalized.visibleDropdownCount > 0) {
      evidence.push(`dropdowns=${normalized.visibleDropdownCount}`);
    }
    return evidence.length
      ? `${normalized.error} [${evidence.join(', ')}]`
      : normalized.error;
  }

function isRecoverablePageTimerTransportFailure(error) {
  return /(?:receiving end|message channel|message port|port (?:closed|disconnected)|\btimeout\b|timed out|探测超时|消息[^，。]{0,24}超时)/i
    .test(String(error || ''));
}

// BFCache 断口：页面被移入 back/forward cache 后，其 content script 上下文被冻结，
// 消息通道随之关闭。重新注入 content script 无法唤醒被冻结的旧文档，必须刷新该页
// （隐藏写入页，非用户页）让文档重新激活后再写；与 toggle 流程的刷新自愈同模式。
function isBfcachePortClosed(error) {
  return /back\/forward cache/i.test(String(error || ''));
}

function isRecoverablePageTimerFailure(failure) {
  if (!failure || typeof failure !== 'object'
      || failure.automationStale === true
      || failure.automaticDeadlineExpired === true
      || failure.invalidTarget === true
      || failure.urlDrift === true
      || failure.discarded === true) {
    return false;
  }
  if (Number(failure.controlCount) > 1
      || Number(failure.visibleDropdownCount) > 1) {
    return false;
  }
  if (failure.transportFailure === true) {
    return isRecoverablePageTimerTransportFailure(failure.error);
  }
  return PAGE_TIMER_RECOVERABLE_FAILURE_STAGES.has(failure.failureStage);
}

// ----- 设置页面自带定时器（安全网，自动关不用手动开）-----
// 提取（Fowler Extract/Move Function）：绝对截止过期结果——原为 setPageTimer 内嵌闭包，
// 只捕获 fixedTargetAt，提到模块级消除闭包捕获，便于复用与测试。
function deadlineExpiredResult(fixedTargetAt) {
  return {
    success: false,
    automaticDeadlineExpired: true,
    error: '定时器目标时间已过期',
    targetAt: Number.isSafeInteger(fixedTargetAt) ? fixedTargetAt : 0
  };
}

function staleAutomationResult(fixedTargetAt) {
  return {
    success: false,
    automationStale: true,
    error: '自动控制已暂停',
    targetAt: Number.isSafeInteger(fixedTargetAt) ? fixedTargetAt : 0
  };
}

function operationDeadlineIsCurrent(operationNotAfterAt) {
  return Number.isSafeInteger(operationNotAfterAt)
    && operationNotAfterAt > Date.now();
}

async function setPageTimer(
  minutes,
  {
    retryOnFailure = true,
    targetAt = 0,
    automaticOnDeadlineAt = 0,
    automationRevision = null,
    automationMode = 'pwm',
    shutdownRevision = null,
    deferVerification = false
  } = {}
) {
  const autoCreatedTabIds = [];
  let retainedControlTabId = null;
  const requestedMinutes = Number.isFinite(Number(minutes)) && Number(minutes) > 0
    ? Number(minutes)
    : 1;
  const startedAt = Date.now();
  const hasExplicitTarget = targetAt !== 0;
  const explicitTargetAt = Number(targetAt);
  const fixedTargetAt = hasExplicitTarget
    ? explicitTargetAt
    : Math.ceil((startedAt + requestedMinutes * 60000) / 60000) * 60000;
  const requestedAutomaticDeadlineAt = Number(automaticOnDeadlineAt);
  const validAutomaticDeadlineAt = Number.isSafeInteger(requestedAutomaticDeadlineAt)
      && requestedAutomaticDeadlineAt > 0
    ? requestedAutomaticDeadlineAt
    : 0;
  const operationNotAfterAt = validAutomaticDeadlineAt > 0
    ? Math.min(fixedTargetAt, validAutomaticDeadlineAt)
    : fixedTargetAt;

  const staleShutdownResult = () => ({
    success: false,
    shutdownStale: true,
    error: '关机请求已失效',
    targetAt: Number.isSafeInteger(fixedTargetAt) ? fixedTargetAt : 0
  });
  const automationWriteIsCurrent = () => automationOperationIsCurrent(automationRevision, automationMode);
  const shutdownWriteIsCurrent = () => timerBasedShutdownIsCurrent(shutdownRevision);
  const pageTimerWriteIsCurrent = () => automationWriteIsCurrent()
    && shutdownWriteIsCurrent();
  const staleWriteResult = () => shutdownWriteIsCurrent()
    ? staleAutomationResult(fixedTargetAt)
    : staleShutdownResult();

  const finishFailure = async (failure, reason) => {
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    const normalizedFailure = normalizePageTimerFailure(
      failure,
      t('bgPageTimerFailed')
    );
    normalizedFailure.targetAt = Number.isSafeInteger(fixedTargetAt)
      ? fixedTargetAt
      : 0;
    if (failure?.automaticDeadlineExpired === true) {
      normalizedFailure.automaticDeadlineExpired = true;
    }
    schedule.pageTimerMinutes = null;
    schedule.pageTimerTargetAt = 0;
    schedule.pageTimerError = normalizedFailure.error;

    if (retryOnFailure) {
      await schedulePageTimerRetry(minutes, reason);
    } else {
      schedule.pageTimerRetryAt = 0;
      schedule.pageTimerRetryMinutes = 0;
      await chrome.alarms.clear('ac-page-timer-retry');
    }

    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    await persistSchedule(`setPageTimer-${reason}`);
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    console.warn('[AC扩展] 页面定时器设置失败:', schedule.pageTimerError);
    return normalizedFailure;
  };

  const getWritableExactHomeTab = async (tabId) => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return { failure: { success: false, error: '页面定时器目标标签已关闭' } };
    }
    if (tab?.discarded) {
      return {
        failure: {
          success: false,
          discarded: true,
          error: '页面定时器目标标签已被浏览器丢弃'
        }
      };
    }
    if (!isACHomePageTab(tab)) {
      return {
        failure: {
          success: false,
          invalidTarget: true,
          urlDrift: true,
          error: '页面定时器目标标签已离开精确 home URL'
        }
      };
    }
    return { tab };
  };

  const createHiddenWriteTab = async () => {
    if (!pageTimerWriteIsCurrent()) {
      return { failure: staleWriteResult() };
    }
    if (autoCreatedTabIds.length >= 1) {
      return { failure: { success: false, error: '页面定时器隐藏写入页已达到上限' } };
    }
    const tab = await chrome.tabs.create({ url: AC_PAGE, active: false });
    if (!Number.isInteger(tab?.id)) {
      return { failure: { success: false, error: t('bgPageTimerNoTab') } };
    }
    autoCreatedTabIds.push(tab.id);
    // 在任何长等待前登记 SW 被逐出时的兜底回收；给两次写入及三轮读回留足时间。
    // 正常退出仍由 finally 改为一分钟回收，不中断服务器的异步提交。
    await chrome.alarms.create(`ac-close-tab-${tab.id}`, { delayInMinutes: 10 });
    if (!pageTimerWriteIsCurrent()) {
      return { failure: staleWriteResult() };
    }
    console.log('[AC扩展] 页面定时器：已创建一个隐藏精确 home 写入页');
    return { tab };
  };

  const writeFixedTargetOnce = async (tabId, forceReinject = false) => {
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    if (!operationDeadlineIsCurrent(operationNotAfterAt)) return deadlineExpiredResult(fixedTargetAt);

    const ready = await waitForTabReady(tabId, 30000, isACHomePageTab);
    if (!ready) {
      return {
        success: false,
        transportFailure: true,
        error: 'AC 页面等待就绪超时'
      };
    }
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    if (!operationDeadlineIsCurrent(operationNotAfterAt)) return deadlineExpiredResult(fixedTargetAt);
    const writable = await getWritableExactHomeTab(tabId);
    if (writable.failure) return writable.failure;

    const contentReady = forceReinject
      ? await injectContentScriptsIntoExactHome(tabId)
      : await ensureContentScriptLoaded(tabId);
    if (!contentReady) {
      return {
        success: false,
        transportFailure: true,
        error: forceReinject
          ? 'AC 页面 content script 强制重新注入失败'
          : 'AC 页面 content script 未就绪'
      };
    }
    const stillWritable = await getWritableExactHomeTab(tabId);
    if (stillWritable.failure) return stillWritable.failure;
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    if (!operationDeadlineIsCurrent(operationNotAfterAt)) return deadlineExpiredResult(fixedTargetAt);

    let result;
    try {
      result = await sendSerializedPageTimerMessage(tabId, {
        action: 'setTimer',
        minutes,
        targetAt: fixedTargetAt,
        allowLocalOnly: deferVerification
      }, automationRevision, PAGE_TIMER_WRITE_TIMEOUT_MS, shutdownRevision, automationMode);
    } catch (error) {
      return {
        success: false,
        transportFailure: true,
        error: error?.message || String(error)
      };
    }
    if (result?.automationStale || result?.shutdownStale) return result;
    const finalWritable = await getWritableExactHomeTab(tabId);
    if (finalWritable.failure) return finalWritable.failure;
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    if (!operationDeadlineIsCurrent(operationNotAfterAt)) return deadlineExpiredResult(fixedTargetAt);
    if (result?.invalidTarget) {
      return { ...result, invalidTarget: true };
    }
    return result && typeof result === 'object'
      ? result
      : { success: false, error: t('bgPageTimerFailed') };
  };

  // 提取（Fowler Extract Function）：页面定时器成功后的证明记录——固定目标、清重试态、持久化并回传验证结果。
  const recordPageTimerProof = async (result, verification) => {
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    if (!operationDeadlineIsCurrent(operationNotAfterAt)) {
      return finishFailure(deadlineExpiredResult(fixedTargetAt), 'automatic-deadline-expired');
    }
    const resultTargetAt = Number(result.targetAt);
    if (!Number.isSafeInteger(resultTargetAt)
        || resultTargetAt !== fixedTargetAt
        || resultTargetAt <= Date.now()) {
      return finishFailure({
        success: false,
        error: '页面定时器未返回本次固定的未来绝对目标时间'
      }, 'invalid-target');
    }
    schedule.pageTimerTargetAt = resultTargetAt;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;
    schedule.pageTimerRetryMinutes = 0;
    await chrome.alarms.clear('ac-page-timer-retry');
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    await persistSchedule('setPageTimer-success');
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    console.log(`[AC扩展] 页面定时器已由新鲜页面确认: ${verification.value} (安全网)`);
    return { ...result, verified: true, verification };
  };

  try {
    if (!pageTimerWriteIsCurrent()) return staleWriteResult();
    if (!Number.isSafeInteger(fixedTargetAt)
        || fixedTargetAt <= startedAt
        || fixedTargetAt % 60000 !== 0
      || (hasExplicitTarget && !Number.isSafeInteger(targetAt))
        || (automaticOnDeadlineAt !== 0
          && !Number.isSafeInteger(automaticOnDeadlineAt))
        || (automaticOnDeadlineAt !== 0 && validAutomaticDeadlineAt === 0)) {
      return await finishFailure({
        success: false,
        error: '页面定时器绝对目标或自动开启截止时间无效'
      }, 'invalid-target');
    }
    if (!operationDeadlineIsCurrent(operationNotAfterAt)) {
      return await finishFailure(deadlineExpiredResult(fixedTargetAt), 'automatic-deadline-expired');
    }

    // 不碰用户页面的输入焦点，也不复用已长期隐藏、可能按分钟节流的旧页。
    // 新页仍受普通后台节流；保留有界等待及真实读回，绝不靠置前兜底。
    const created = await createHiddenWriteTab();
    if (created.failure) return await finishFailure(created.failure, 'no-tab');
    const tab = created.tab;

    let result = await writeFixedTargetOnce(tab.id);
    if (!result?.success && isRecoverablePageTimerFailure(result)) {
      // BFCache 断口：写入页被移入 back/forward cache（UST 登录/CAS 重定向链所致），
      // 重新注入无法唤醒冻结文档。先刷新该隐藏写入页让文档重新激活，再带注入重试。
      if (isBfcachePortClosed(result.error)) {
        try {
          await refreshACControlPage(tab.id);
        } catch (_) {
          // 刷新失败仍继续原重注入重试，不吞掉原始失败。
        }
      }
      result = await writeFixedTargetOnce(tab.id, true);
    }

    if (result?.automationStale
        || result?.shutdownStale
        || !pageTimerWriteIsCurrent()) {
      return staleWriteResult();
    }
    if (result?.automaticDeadlineExpired || !operationDeadlineIsCurrent(operationNotAfterAt)) {
      return await finishFailure(
        deadlineExpiredResult(fixedTargetAt),
        'automatic-deadline-expired'
      );
    }
    if (!result?.success) {
      return await finishFailure(result, 'failed');
    }
    if (Number(result.targetAt) !== fixedTargetAt) {
      return await finishFailure({
        success: false,
        error: '页面定时器写入结果改变了原绝对目标时间'
      }, 'invalid-target');
    }

    const expectedValue = String(result.value || '').trim();
    if (!expectedValue) {
      return await finishFailure({
        success: false,
        error: '页面定时器未返回可验证的目标时间'
      }, 'empty-value');
    }
    if (deferVerification) {
      // 把十分钟兜底及页面所有权交给整个布防流程，不能在开机仍进行时一分钟回收。
      retainedControlTabId = tab.id;
      return {
        success: true,
        controlTabId: tab.id,
        targetAt: fixedTargetAt,
        value: expectedValue,
        actualDelayMinutes: result.actualDelayMinutes || requestedMinutes,
        deferredVerification: true
      };
    }

    const verification = await verifyPageTimerPersistence(expectedValue, {
      automationRevision,
      automationMode,
      shutdownRevision,
      notAfterAt: operationNotAfterAt
    });
    if (verification.automationStale
        || verification.shutdownStale
        || !pageTimerWriteIsCurrent()) {
      return staleWriteResult();
    }
    if (verification.automaticDeadlineExpired || !operationDeadlineIsCurrent(operationNotAfterAt)) {
      return await finishFailure(
        deadlineExpiredResult(fixedTargetAt),
        'automatic-deadline-expired'
      );
    }
    if (!verification.success) {
      return await finishFailure({
        success: false,
        error: verification.error || '页面定时器新鲜页面验证后未确认'
      }, 'persistence-check-failed');
    }

    schedule.pageTimerMinutes = result.actualDelayMinutes || requestedMinutes;
    return await recordPageTimerProof(result, verification);
  } catch (error) {
    return await finishFailure({
      success: false,
      error: error?.message || String(error)
    }, 'exception');
  } finally {
    for (const tabId of autoCreatedTabIds) {
      if (tabId === retainedControlTabId) continue;
      chrome.alarms.create(`ac-close-tab-${tabId}`, { delayInMinutes: 1 });
    }
  }
}

async function requestTimerBasedShutdown(reason = '', minutes = 1) {
  const shutdownRevision = typeof claimTimerBasedShutdown === 'function'
    ? claimTimerBasedShutdown()
    : null;
  const shutdownIsCurrent = () => shutdownRevision === null
    || (typeof isTimerBasedShutdownCurrent === 'function'
      && isTimerBasedShutdownCurrent(shutdownRevision));
  const staleShutdownResult = () => ({
    success: false,
    shutdownStale: true,
    timerBased: true,
    error: '关机请求已失效',
    reason
  });
  if (!shutdownIsCurrent()) return staleShutdownResult();
  const requestedMinutes = Math.max(1, sanitizeMinutes(minutes, 1));
  const latestReusableTargetAt = Date.now() + requestedMinutes * 60000 + 90000;
  if (isPageTimerProofFresh(schedule)
      && Number(schedule.pageTimerTargetAt) <= latestReusableTargetAt) {
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
    if (!shutdownIsCurrent()) return staleShutdownResult();
  }

  const status = await getCurrentACStatus();
  if (!shutdownIsCurrent()) return staleShutdownResult();
  if (status?.isOn === false) {
    if (hadStaleProof) {
      await persistSchedule(`${reason}-clear-stale-page-timer-proof`);
    }
    return { success: true, alreadyDone: true, timerBased: true, reason };
  }

  const result = await setPageTimer(requestedMinutes, { shutdownRevision });
  if (!shutdownIsCurrent() || result?.shutdownStale) {
    return staleShutdownResult();
  }
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

// 原子（Fowler Extract/Move Function）：设置关机时间并保证开机后落盘验证。
// 组合三个既有原子——setPageTimer（写入，defer 验证）、toggleAC（开机）、
// verifyPageTimerPersistence（独立新鲜页读回）——供智能模式与 PWM 共用同一
// 「写 → 确认开机 → 开新页验证」时序。Power-off after 只在开机态被服务器保留，
// 所以必须先本地写入、开机确认后再读回；读回前绝不刷新写入来源页。
// ensureOn 可选钩子让调用方在开机前后插入自己的审计/副作用，缺省直接 toggleAC。
async function armPowerOffTimerEnsuringOn(
  minutes,
  {
    targetAt = 0,
    automaticOnDeadlineAt = 0,
    automationRevision = null,
    automationMode = 'pwm',
    shutdownRevision = null,
    requireAutomationAllowed = true,
    ensureOn = null
  } = {}
) {
  const writeResult = await setPageTimer(minutes, {
    retryOnFailure: false,
    targetAt,
    automaticOnDeadlineAt,
    automationRevision,
    automationMode,
    shutdownRevision,
    deferVerification: true
  });
  if (writeResult?.automationStale || writeResult?.shutdownStale) {
    return { ...writeResult, success: false, failureStage: 'write' };
  }
  if (!writeResult?.success) {
    return {
      success: false,
      failureStage: 'write',
      error: writeResult?.error || '页面关机定时器写入失败',
      pageTimerFailureStage: writeResult?.failureStage || '',
      pageTimerExpectedValue: writeResult?.expectedValue || '',
      pageTimerObservedValue: writeResult?.observedValue || '',
      pageTimerObservedTitle: writeResult?.observedTitle || '',
      pageTimerVisibleDropdownCount: writeResult?.visibleDropdownCount || 0,
      targetAt: Number(writeResult?.targetAt) || 0,
      automaticDeadlineExpired: writeResult?.automaticDeadlineExpired === true
    };
  }
  const value = String(writeResult.value || '').trim();
  const fixedTargetAt = Number(writeResult.targetAt);
  const controlTabId = writeResult.controlTabId;
  const notAfterAt = automaticOnDeadlineAt > 0
    ? Math.min(fixedTargetAt, automaticOnDeadlineAt)
    : fixedTargetAt;

  try {
  if (!Number.isInteger(controlTabId)) {
    return { success: false, failureStage: 'ensure-on', error: '后台控制页缺失', targetAt: fixedTargetAt };
  }
  const before = await getCurrentACStatus(controlTabId);
  let acIsOn = before?.isOn === true;
  let toggledOn = false;
  if (!acIsOn) {
    let toggleResult;
    if (typeof ensureOn === 'function') {
      toggleResult = await ensureOn(notAfterAt, controlTabId);
    } else {
      toggleResult = await toggleAC('on', {
        notAfterAt,
        controlTabId,
        requireAutomationAllowed,
        automationRevision,
        automationMode
      });
    }
    toggledOn = true;
    if (!toggleResult?.success) {
      return { success: false, failureStage: 'ensure-on', error: toggleResult?.error || '自动开启未确认', value, targetAt: fixedTargetAt, acIsOn: false, toggledOn };
    }
    // 开机需要时间：点击后服务器/页面异步变 ON，且 BFCache 恢复重载可能刚完成。
    // 这里轮询确认直到 ON 或超时，而不是单次读取即判失败（否则会过早放弃并刷新）。
    const confirmDeadline = Date.now() + 15000;
    let after = await getCurrentACStatus(controlTabId);
    while (after?.isOn !== true && Date.now() < confirmDeadline) {
      await sleep(1500);
      after = await getCurrentACStatus(controlTabId);
    }
    acIsOn = after?.isOn === true;
    if (!acIsOn) {
      return {
        success: false,
        failureStage: 'ensure-on',
        error: '自动开启未确认',
        value,
        targetAt: fixedTargetAt,
        acIsOn: false,
        toggledOn
      };
    }
  }

  const verification = await verifyPageTimerPersistence(value, {
    automationRevision,
    automationMode,
    shutdownRevision,
    notAfterAt
  });
  if (verification.automationStale || verification.shutdownStale) {
    return {
      success: false,
      failureStage: 'verify',
      automationStale: verification.automationStale === true,
      shutdownStale: verification.shutdownStale === true,
      error: '自动控制已暂停',
      value,
      targetAt: fixedTargetAt,
      acIsOn,
      toggledOn
    };
  }
  // 新鲜页复核到「未开机」或「定时器被清空」：确保开机后补设关机时间（Power-off after 只在
  // ON 时被服务器保留，之前 OFF 态写入可能未持久化，开机会把 OFF 态写入的定时器清空）。
  // 复核失败按 ensure-on / verify 各自回退，不改变原失败语义。
  if (verification.acIsOn === false || !verification.success) {
    const recoveryToggle = await toggleAC('on', {
      notAfterAt,
      controlTabId,
      requireAutomationAllowed,
      automationRevision,
      automationMode
    });
    const recoveryDeadline = Date.now() + 15000;
    let recoveryStatus = await getCurrentACStatus(controlTabId);
    while (recoveryToggle?.success && recoveryStatus?.isOn !== true && Date.now() < recoveryDeadline) {
      await sleep(1500);
      recoveryStatus = await getCurrentACStatus(controlTabId);
    }
    if (!recoveryToggle?.success || recoveryStatus?.isOn !== true) {
      return {
        success: false,
        failureStage: 'ensure-on',
        error: '自动开启未确认（新鲜页复核未开机后重试开机仍未确认）',
        value,
        targetAt: fixedTargetAt,
        acIsOn: false,
        toggledOn
      };
    }
    const supplement = await setPageTimer(minutes, {
      retryOnFailure: false,
      targetAt: fixedTargetAt,
      automaticOnDeadlineAt,
      automationRevision,
      automationMode,
      shutdownRevision,
      deferVerification: false
    });
    if (!supplement?.success) {
      return {
        success: false,
        failureStage: 'verify',
        error: supplement?.error || '补设关机时间失败',
        value,
        targetAt: fixedTargetAt,
        acIsOn: true,
        toggledOn
      };
    }
    return {
      success: true,
      value,
      targetAt: fixedTargetAt,
      actualDelayMinutes: supplement.actualDelayMinutes || minutes,
      verification: supplement.verification,
      acIsOn: true,
      toggledOn,
      supplemented: true
    };
  }

  return {
    success: true,
    value,
    targetAt: fixedTargetAt,
    actualDelayMinutes: writeResult.actualDelayMinutes || minutes,
    verification,
    acIsOn,
    toggledOn
  };
  } finally {
    if (Number.isInteger(controlTabId)) {
      await chrome.alarms.create(`ac-close-tab-${controlTabId}`, { delayInMinutes: 1 });
    }
  }
}

// ----- 闹钟触发时执行 -----
// 提取（Fowler Extract Function）：自动化闹钟入口——把 ac-smart/ac-pwm 路由集中到单一入口，
// 智能/循环各自执行链不再散落在 onAlarm 里，便于单路径调试。
async function runAutomationStepForAlarm(alarm) {
  if (alarm.name === 'ac-smart') {
    if (!isSmartAutomationEnabled()) {
      await clearSmartAlarm(null, true);
      return;
    }
    try {
      await runSmartStep({ scheduledTime: alarm.scheduledTime });
    } catch (e) {
      console.error('[AC扩展] Smart 步骤执行失败:', e);
      void appendDiagnosticLog('error', 'alarm-ac-smart', e);
    }
    return;
  }
  if (alarm.name === 'ac-pwm') {
    if (isSmartAutomationEnabled()) {
      await clearPwmAlarm(null, true);
      return;
    }
    // pwmStepRunning 已在 runPwmStep 内部防重入，此处无需再做去重；
    // 原先基于 alarmCreatedAt 的去重会在 SW 被闹钟唤醒后误杀合法闹钟
    // （init()→setupAlarms()→syncStoredTriggerFromAlarm() 会覆写 alarmCreatedAt 为 Date.now()，
    //   导致 alarm.scheduledTime ≈ Date.now() ≤ alarmCreatedAt+1000 成立，闹钟被丢弃）。
    const pwmAlarmModeAtDelivery = !isSmartAutomationEnabled();
    const pwmRuntimeRevisionAtDelivery = pwmRuntimeRevision;
    try {
      await runPwmStep();
    } catch (e) {
      console.error('[AC扩展] PWM 步骤执行失败:', e);
      void appendDiagnosticLog('error', 'alarm-ac-pwm', e);
      if (pwmAlarmModeAtDelivery
          && !isSmartAutomationEnabled()
          && isAutomationAllowed()
          && pwmRuntimeRevision === pwmRuntimeRevisionAtDelivery + 1
          && isAutomationOperationCurrent(pwmRuntimeRevision, 'pwm')) {
        const automationRevision = pwmRuntimeRevision;
        const delay = Math.max(1, schedule.pwmState === 'on' ? schedule.onMinutes : schedule.offMinutes);
        const alarmCreated = await createPwmAlarmWithVerify(
          delay,
          'onAlarm-error-recovery',
          automationRevision
        );
        if (alarmCreated === false) return;
        replacePwmRetryState();
        if (!isAutomationOperationCurrent(automationRevision, 'pwm')) return;
        await persistSchedule('onAlarm-error-recovery');
      }
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'ac-pwm' || alarm.name === 'ac-smart') {
    await recordControlAuditDelivery(alarm.scheduledTime);
  }
  // Edge/Chrome 可能因为 alarm 唤醒 Service Worker。
  // 必须等 storage 恢复完成，否则 schedule.enabled 还是默认 false，会跳过自动关机。
  await initReady;
  await loadScheduleFromStorage();

  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);

  if (alarm.name === 'ac-badge-tick') {
    // 每分钟刷新角标
    await updateBadge();
    // L2 长连接保活不变量:每分钟顺带确保 offscreen 文档仍在,
    // 防止 Chrome/Edge 在长时间无活跃后回收 offscreen 文档导致端口失活。
    await ensureOffscreen();
    if (isAutomationAllowed()) {
      try {
        const automationRevision = isSmartAutomationEnabled()
          ? smartRuntimeRevision
          : pwmRuntimeRevision;
        const liveAlarm = await getAutomationAlarm();
        if (isSmartAutomationEnabled()) {
          if (getLiveAlarmEndMs(liveAlarm)) {
              setSmartNextTriggerAt(liveAlarm.scheduledTime);
            await persistSchedule('badge-tick-smart-sync', {
              syncFromLiveAlarm: false
            });
          }
        } else {
          const triggerPlan = await persistReconciledPwmTrigger(
            liveAlarm,
            'badge-tick-sync',
            PWM_TRIGGER_NEXT_ONLY_OPTIONS,
            automationRevision
          );
          if (triggerPlan) {
            console.log(`[AC扩展] badge-tick: 已同步 nextTriggerAt ← live alarm (${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()})`);
          }
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

  if (alarm.name === 'ac-smart' || alarm.name === 'ac-pwm') {
    await runAutomationStepForAlarm(alarm);
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
        recoverStuckTransientHomeTabs().catch(e => /* 不阻塞闹钟流程 */ {});
      }
    } catch (e) {
      console.error('[AC扩展] 看门狗执行失败:', e);
      void appendDiagnosticLog('error', 'alarm-watchdog', e);
    }
  }

  if (alarm.name === 'ac-active-boundary') {
    try {
      await onActiveBoundaryCrossed();
    } catch (e) {
      console.warn('[AC扩展] active hours boundary 处理失败:', e?.message);
      void appendDiagnosticLog('warn', 'alarm-active-boundary', e);
      rescheduleActiveBoundary();  // 出错也重新调度，避免漏掉下次
    }
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
    if (isAutomationAllowed()) {
      await clearSupersededTimerBasedShutdownRetry();
      return;
    }
    if (schedule.pageTimerRetryAt) {
      const retryMinutes = schedule.pageTimerRetryMinutes || 1;
      await requestTimerBasedShutdown('page-timer-retry', retryMinutes);
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
    return true;
  } catch (error) {
    console.log('[AC扩展] content script 接收端缺失，尝试原页重新注入:', error?.message);
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
    automationMode = 'pwm',
    ensureCurrent = null
  } = {}
) {
  const messageIsCurrent = () => typeof ensureCurrent !== 'function'
    || ensureCurrent();
  if (!messageIsCurrent()) {
    return { success: false, pageTimerStale: true, error: '页面定时器写入已失效' };
  }
  const tab = await getExactACHomeTab(tabId);
  if (!tab) throw new Error('拒绝向非精确 AC home 标签发送消息');
  if (!messageIsCurrent()) {
    return { success: false, pageTimerStale: true, error: '页面定时器写入已失效' };
  }
  if (requireAutomationAllowed && message?.action === 'on') {
    const automaticOnIsCurrent = automationRevision === null
      ? isAutomationAllowed()
      : isAutomationOperationCurrent(automationRevision, automationMode);
    if (!automaticOnIsCurrent) {
      throw new Error('运行时段外已暂停自动开启');
    }
  }

  if (!messageIsCurrent()) {
    return { success: false, pageTimerStale: true, error: '页面定时器写入已失效' };
  }
  const responsePromise = chrome.tabs.sendMessage(tabId, message);
  if (!(timeoutMs > 0)) return responsePromise;

  let timeoutId;
  try {
    return await Promise.race([
      responsePromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`content script ${message?.action || 'unknown'} 探测超时`));
        }, timeoutMs);
      })
    ]);
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
        // 没有正在运行的 content listener 时无需恢复、注入或刷新页面。
      }
    }));
}

// ----- 切换 AC 状态 -----
async function toggleAC(
  action,
  {
    notAfterAt = 0,
    requireAutomationAllowed = false,
    automationRevision = null,
    automationMode = 'pwm',
    controlTabId = null
  } = {}
) {
  const requestedNotAfterAt = notAfterAt === 0
    ? 0
    : Number(notAfterAt);
  const requestedRequiresAutomation = action === 'on' && requireAutomationAllowed === true;
  const requestedAutomationRevision = requestedRequiresAutomation
    ? automationRevision
    : null;
  if (requestedNotAfterAt !== 0 && !Number.isSafeInteger(requestedNotAfterAt)) {
    return { success: false, error: '自动开启窗口截止时间无效' };
  }
  const requestedAutomationIsCurrent = requestedAutomationRevision === null
    ? isAutomationAllowed()
    : isAutomationOperationCurrent(requestedAutomationRevision, automationMode);
  if (requestedRequiresAutomation && !requestedAutomationIsCurrent) {
    return { success: false, automationPausedByActiveHours: true, error: '运行时段外已暂停自动开启' };
  }
  if (acToggleInFlight) {
    if (acToggleInFlightAction === action
        && acToggleInFlightNotAfterAt === requestedNotAfterAt
      && acToggleInFlightRequiresAutomation === requestedRequiresAutomation
        && acToggleInFlightAutomationRevision === requestedAutomationRevision
        && acToggleInFlightAutomationMode === automationMode
        && acToggleInFlightControlTabId === controlTabId) {
      console.log(`[AC扩展] 合并重复的 toggleAC(${action}) 请求`);
      return acToggleInFlight;
    }
    return {
      success: false,
      busy: true,
      error: `toggleAC(${acToggleInFlightAction}) 仍在执行，本次 ${action} 不重复点击`
    };
  }

  acToggleInFlightAction = action;
  acToggleInFlightNotAfterAt = requestedNotAfterAt;
  acToggleInFlightRequiresAutomation = requestedRequiresAutomation;
  acToggleInFlightAutomationRevision = requestedAutomationRevision;
  acToggleInFlightAutomationMode = automationMode;
  acToggleInFlightControlTabId = controlTabId;
  acToggleInFlight = toggleACOnce(action, {
    notAfterAt: requestedNotAfterAt,
    requireAutomationAllowed: requestedRequiresAutomation,
    automationRevision: requestedAutomationRevision,
    automationMode,
    controlTabId
  });
  try {
    return await acToggleInFlight;
  } finally {
    acToggleInFlight = null;
    acToggleInFlightAction = null;
    acToggleInFlightNotAfterAt = 0;
    acToggleInFlightRequiresAutomation = false;
    acToggleInFlightAutomationRevision = null;
    acToggleInFlightAutomationMode = null;
    acToggleInFlightControlTabId = null;
  }
}

async function toggleACOnce(action, options = {}) {
  // 自动布防必须沿用自己的后台页；消失/漂移/丢弃均失败，不换到用户页。
  if (options.controlTabId !== null && options.controlTabId !== undefined) {
    const controlTab = await getExactACHomeTab(options.controlTabId);
    if (!controlTab || controlTab.discarded) {
      return { success: false, invalidTarget: true, error: '后台控制页已不可用' };
    }
    return waitUntil(_toggleOnExistingTab(controlTab, action, options));
  }
  // A1: 顶层幂等预检 — 先查当前 AC 真实状态，已是目标则跳过，避免多余开关噪音
  const needOn = action === 'on';
  try {
    const preStatus = await getCurrentACStatus();
    if (typeof preStatus?.isOn === 'boolean' && preStatus.isOn === needOn) {
      console.log(`[AC扩展] 幂等预检：AC 已在目标状态 (${action})，跳过切换`);
      return { success: true, alreadyDone: true, action };
    }
  } catch (_) { /* 预检失败不影响主流程 */ }

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

  return attemptACToggleWithRecovery(tab.id, action, 1, '', options);
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
    // BFCache 断口（页面进入 back/forward cache 导致消息通道关闭）是页面导航的预期现象，
    // 且随后 attemptACToggleWithRecovery 会刷新页面重试自愈，故降级为 warn，
    // 避免污染「本构建以来异常」统计；其余发送失败（注入失败、未知错误等）仍按 error 记录。
    const bfcachePortClosed = /back\/forward cache/i.test(String(error?.message || error));
    console.error('[AC扩展] 发送消息失败:', error?.message);
    void appendDiagnosticLog(bfcachePortClosed ? 'warn' : 'error', 'toggle-message', error);
    return { success: false, tabId, error: error?.message || String(error) };
  }
}

// 判断是否处于 UST 会话重登录的瞬态 URL（login / CAS 回调）。
// 这些 URL 会在几秒内自动跳回 home；强行 tabs.update 到 home 反而可能打断 CAS 回调，
// 造成反复 BFCache。只有非重登录的业务漂移（billing-cycle 等）才导航回 home。
function isTransientAuthRedirectUrl(url) {
  return /\/(?:login|callback\/cas)(?:\?|$)/i.test(String(url || ''));
}

async function refreshACControlPage(tabId) {
  try {
    const currentTab = await chrome.tabs.get(tabId);
    if (isACHomePageTab(currentTab)) {
      await chrome.tabs.reload(tabId);
    } else if (!isTransientAuthRedirectUrl(currentTab?.url)) {
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

// 看门狗回收：把卡在瞬态重登录 URL（login / CAS 回调）的 UST 标签导航回精确 home。
// 正常重登录几秒内自然回跳，只有服务端异常（如 CAS 回调 504）才会让标签长期停留；
// 看门狗每 5 分钟运行一次，此时仍停在瞬态 URL 的标签即为「卡死」。5 分钟粒度远大于
// 秒级回跳，导航回 home 不会打断进行中的 CAS，并可让下一轮自动开启重新读到精确 home 页。
async function recoverStuckTransientHomeTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)
          || !isTransientAuthRedirectUrl(tab.url)
          || tab.discarded) {
        continue;
      }
      try {
        await chrome.tabs.update(tab.id, { url: AC_PAGE });
        console.log(`[AC扩展] 看门狗：回收卡在瞬态 URL 的标签 ${tab.id} → home`);
      } catch (_) {
        // 标签可能已被关闭或改 URL，静默跳过。
      }
    }
  } catch (_) {
    // tabs.query 失败时静默跳过，不阻塞看门狗主流程。
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
  if (result.success || result.invalidTarget || refreshesRemaining <= 0) {
    if (!result.success && initialError) {
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
      : !isAutomationOperationCurrent(
        options?.automationRevision,
        options?.automationMode || 'pwm'
      ))) {
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
    automationRevision: options?.automationRevision ?? null,
    automationMode: options?.automationMode || 'pwm'
  });
  console.log(`[AC扩展] ${action} 命令返回:`, result);
  if (!result?.success) {
    console.warn('[AC扩展] 页面返回未确认:', result);
    return {
      success: false,
      tabId,
      result,
      error: result?.error || `${action} 命令未确认`
    };
  }
  return { success: true, tabId, result };
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
      let tab = await chrome.tabs.get(preferredTabId);
      if (isACHomePageTab(tab)) {
        await waitForTabReady(tab.id, timeoutMs);
        tab = await chrome.tabs.get(tab.id);
        if (isACHomePageTab(tab)) return tab;
      }
    } catch (_) {
      // preferred tab 已关闭，回退到查询现有页面
    }
  }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  let tab = tabs.find(isACHomePageTab);
  if (!tab?.id) return null;
  await waitForTabReady(tab.id, timeoutMs);
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

async function getCurrentACStatus(controlTabId = null) {
  const tabs = controlTabId === null
    ? await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' })
    : [await getExactACHomeTab(controlTabId)];
  const tab = tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded);
  if (!tab?.id) {
    return { isOn: null, error: '精确 AC home 页面未打开' };
  }
  try {
    return await sendReadMessageToExactACHome(tab.id, { action: 'status' });
  } catch (e) {
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

async function repairSmartScheduleClock(options = {}) {
  const rearmPageTimer = options.rearmPageTimer !== false;
  await loadScheduleFromStorage();
  if (!schedule.enabled || !isAutomationAllowed() || !isSmartAutomationEnabled()) {
    return {
      success: false,
      reason: schedule.enabled ? '运行时段外暂停' : '定时未启用',
      schedule
    };
  }

  const automationRevision = smartRuntimeRevision;
  const now = Date.now();
  const storedSmartNextTriggerAt = Number(schedule.smartNextTriggerAt) || 0;
  const liveAlarm = await chrome.alarms.get('ac-smart');
  if (getLiveAlarmEndMs(liveAlarm)) {
    const clock = classifySmartOnClock(schedule, liveAlarm.scheduledTime, {
      now,
      plannedAt: schedule.smartClockPlannedAt,
      nextAction: schedule.smartState,
      toleranceMs: 1500,
      requirePlannedAt: true
    });
    if (!clock?.applicable || clock.valid) {
      setSmartNextTriggerAt(liveAlarm.scheduledTime);
      await persistSchedule('repairSmartScheduleClock-live', {
        syncFromLiveAlarm: false
      });
      return { success: true, repairedFromLiveAlarm: true, schedule };
    }
    options = {
      ...options,
      smartOnExpectedBoundaryAt: Number(clock.expectedAt) || 0
    };
  }

  const status = await getCurrentACStatus();
  if (await abortStaleAutomation(
    automationRevision,
    'repair-smart-status-active-hours-paused',
    'smart'
  )) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  if (typeof status?.isOn !== 'boolean') {
    schedule.pageTimerError = `Smart 时钟修复无法确认冷气状态：${status?.error || '状态未知'}`;
    await persistSchedule('repairSmartScheduleClock-status-unknown', {
      syncFromLiveAlarm: false
    });
    return { success: false, reason: schedule.pageTimerError, schedule };
  }

  if (status.isOn) {
    if (!rearmPageTimer) {
      // 只读时钟修复（诊断）：不写页面定时器、不重建运行闹钟，只把 storage 时钟对齐到
      // 已有 live 闹钟，避免「时间已设好仍反复重设」。
      const live = await chrome.alarms.get('ac-smart');
      const syncedFromLive = getLiveAlarmEndMs(live);
      if (syncedFromLive) {
        setSmartNextTriggerAt(live.scheduledTime);
      }
      await persistSchedule('repairSmartScheduleClock-readonly', {
        syncFromLiveAlarm: false
      });
      return {
        success: true,
        rearmSkipped: true,
        repairedFromLiveAlarm: syncedFromLive,
        schedule: { ...schedule, actualStatus: status }
      };
    }
    // 页面定时器证明仍新鲜：定时器已正确设置，无需因 onMinutes 天气变化而重写，
    // 避免「反复设置关机时间」。只把 ac-smart 闹钟对齐到已确认的 pageTimerTargetAt。
    const freshProofTargetAt = isPageTimerProofFresh(schedule)
      ? Number(schedule.pageTimerTargetAt)
      : 0;
    // 即使 storage 证明缺失（如首轮验证失败未记录证明），页面已有定时器也跳过重写，
    // 避免把已设好的时间改来改去、误报「未确认」。
    const pageTimer = await getCurrentPageTimer();
    const pageTimerParsed = pageTimer?.found && pageTimer?.value
      ? parsePageTimerValue(String(pageTimer.value).trim(), now)
      : null;
    const pageTimerTargetAt = pageTimerParsed?.valid ? pageTimerParsed.targetMs : 0;
    const existingTargetAt = freshProofTargetAt > now
      ? freshProofTargetAt
      : (pageTimerTargetAt > now ? pageTimerTargetAt : 0);
    if (existingTargetAt > now) {
      setSmartNextAction('off');
      schedule.pageTimerError = '';
      await clearSmartAlarm(automationRevision);
      const alarmCreated = await createAutomationAlarmFromPlan(
        'ac-smart',
        { nextTriggerAt: existingTargetAt },
        'repair-smart-on-proof-fresh',
        automationRevision
      );
      if (alarmCreated === false) {
        return { success: false, reason: 'Smart 闹钟重建失败', schedule };
      }
      await persistSchedule('repairSmartScheduleClock-proof-fresh', {
        syncFromLiveAlarm: false
      });
      await updateBadge();
      return { success: true, schedule: { ...schedule, actualStatus: status } };
    }

    const storedBoundaryAt = normalizeSmartHalfHourAlarmBoundary(
      schedule.smartOnBoundaryAt
    );
    // smartOnBoundaryAt 陈旧（0/非法）时退回当前半点边界：否则会把仍在 ON 窗口内的
    // 空调误判为「窗口已过」，触发「下一分钟关机」兜底导致提前关机。
    const effectiveBoundaryAt = storedBoundaryAt > 0
      ? storedBoundaryAt
      : smartHalfHourBoundaryAtOrBefore(now);
    const storedTargetAt = smartPageTimerTargetAt(
      Number(schedule.onMinutes),
      now,
      effectiveBoundaryAt
    );
    const smartOnWindowPlan = planSmartModeOnWindow(schedule, {
      now,
      maxOnMinutes: SMART_MODE.ON_MAX,
      acIsOn: true,
      boundaryAt: effectiveBoundaryAt
    });
    const plannedTargetAt = Number(smartOnWindowPlan?.pageTimerTargetAt) || 0;
    const targetAt = plannedTargetAt > now
      ? plannedTargetAt
      : storedTargetAt > now
      ? storedTargetAt
      : storedSmartNextTriggerAt > now
      ? storedSmartNextTriggerAt
      : nextSafeSmartPageTimerTargetAt(now);
    const timerResult = await setPageTimer(
      Math.max(1, Math.ceil((targetAt - now) / 60000)),
      {
        retryOnFailure: false,
        targetAt,
        automationRevision,
        automationMode: 'smart'
      }
    );
    if (await abortStaleAutomation(
      automationRevision,
      'repair-smart-timer-active-hours-paused',
      'smart'
    )) {
      return { success: false, reason: '运行时段外暂停', schedule };
    }
    if (!timerResult?.success) {
      schedule.pageTimerError = `Smart 关机定时器未确认：${timerResult?.error || '未知错误'}${timerResult?.failureStage ? `（${timerResult.failureStage}）` : ''}；1 分钟后重试`;
      const retryPlan = planSmartOnRetryExceptionRecovery(
        schedule,
        storedBoundaryAt,
        { now, retryAt: now + 60000 }
      );
      applySmartPlanState(retryPlan);
      schedule.smartOnBoundaryAt = Number(retryPlan.boundaryAt) || 0;
      const retryKind = retryPlan.kind === 'retry-smart-on-exception'
        ? typeof SMART_RETRY_KINDS === 'object'
          ? SMART_RETRY_KINDS.ON
          : 'smart-on'
        : '';
      replaceSmartRetryState();
      await clearSmartAlarm(automationRevision);
      const alarmCreated = await createAutomationAlarmFromPlan(
        'ac-smart',
        { nextTriggerAt: retryPlan.nextTriggerAt },
        'repair-smart-pageTimer-failed',
        automationRevision
      );
      if (!alarmCreated) return { success: false, reason: schedule.pageTimerError, schedule };
      if (retryKind) {
        replaceSmartRetryState({
          kind: retryKind,
          boundaryAt: Number(retryPlan.boundaryAt) || 0,
          scheduledAt: Number(schedule.smartNextTriggerAt)
            || retryPlan.nextTriggerAt
        });
      }
      await persistSchedule('repairSmartScheduleClock-pageTimer-failed', {
        syncFromLiveAlarm: false
      });
      await updateBadge();
      return { success: false, reason: schedule.pageTimerError, schedule };
    }

    setSmartNextAction('off');
    schedule.smartOnBoundaryAt = storedTargetAt > now ? storedBoundaryAt : 0;
    schedule.pageTimerError = '';
    await clearSmartAlarm(automationRevision);
    const alarmCreated = await createAutomationAlarmFromPlan(
      'ac-smart',
      { nextTriggerAt: timerResult.targetAt },
      'repair-smart-on',
      automationRevision
    );
    if (!alarmCreated) return { success: false, reason: 'Smart 闹钟重建失败', schedule };
    await persistSchedule('repairSmartScheduleClock-on', {
      syncFromLiveAlarm: false
    });
    await updateBadge();
    return { success: true, schedule: { ...schedule, actualStatus: status } };
  }

  const requestedBoundaryAt = Number(options.smartOnExpectedBoundaryAt);
  const requestedBoundary = isSmartHalfHourBoundary(requestedBoundaryAt)
      && requestedBoundaryAt > now
    ? requestedBoundaryAt
    : nextSmartHalfHourBoundary(now);
  const offPlan = {
    nextAction: 'on',
    nextTriggerAt: requestedBoundary,
    phasePatch: { smartState: 'on', nextTriggerAt: requestedBoundary }
  };
  alignSmartModeNextTrigger(
    offPlan,
    now
  );
  applySmartPlanState(offPlan);
  schedule.smartOnBoundaryAt = 0;
  replaceSmartRetryState();
  await clearSmartAlarm(automationRevision);
  const alarmCreated = await createAutomationAlarmFromPlan(
    'ac-smart',
    { nextTriggerAt: offPlan.nextTriggerAt },
    'repair-smart-off',
    automationRevision
  );
  if (!alarmCreated) return { success: false, reason: 'Smart 闹钟重建失败', schedule };
  await persistSchedule('repairSmartScheduleClock-off', {
    syncFromLiveAlarm: false
  });
  await updateBadge();
  return { success: true, repairedPwmClock: true, schedule: { ...schedule, actualStatus: status } };
}

async function ensureScheduleClock() {
  await loadScheduleFromStorage();
  if (!isAutomationAllowed()) return;
  await backfillNextTriggerAt(true);
  const now = Date.now();
  const existingAlarm = await chrome.alarms.get('ac-pwm');
  const rawAlarmAt = Number(existingAlarm?.scheduledTime) || 0;
  const liveAlarmAt = rawAlarmAt > now ? rawAlarmAt : 0;
  const storedAlarmAt = getStoredAlarmEndMs();
  const recoveryPlan = typeof planIntervalRecovery === 'function'
    ? planIntervalRecovery({
        now,
        pwmClockPlannedAt: Number(schedule.pwmClockPlannedAt)
          || Number(schedule.alarmCreatedAt)
          || 0,
        plannedActionAt: liveAlarmAt || (storedAlarmAt > now ? storedAlarmAt : 0),
        liveAlarmAt,
        storedAlarmAt,
        expiredAlarmAt: rawAlarmAt > 0 && rawAlarmAt <= now ? rawAlarmAt : 0,
        missingClockAction: 'repair-clock',
      })
    : null;

  if (recoveryPlan?.kind === 'repair-clock') {
    const automationRevision = pwmRuntimeRevision;
    await clearPwmAlarm(automationRevision);
    if (!isAutomationOperationCurrent(automationRevision)) return;
    replacePwmRetryState();
    setPwmNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await persistSchedule('ensureScheduleClock-revoke-untrusted-clock', {
      syncFromLiveAlarm: false
    });
    const repair = await repairScheduleClock();
    return {
      ...repair,
      repairedPwmClock: true,
      recoveryPlan
    };
  }

  if (getLiveAlarmEndMs(existingAlarm)) {
    await syncStoredTriggerFromAlarm(existingAlarm, 'ensureScheduleClock: 同步现有 PWM 闹钟');
    return { success: true, recoveryPlan };
  }

  const restored = await restoreIntervalAlarmFromStorage('PWM 主闹钟缺失，已按剩余时间补建');
  if (restored) return { success: true, restored: true, recoveryPlan };

  const alarmEnd = getStoredAlarmEndMs();
  const hasClock = !!alarmEnd;

  if (alarmEnd > Date.now()) return;

  // 尝试从已过期的闹钟时间推进到下一周期边界
  if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime <= Date.now()) {
    const advanced = await advanceExpiredAlarmToNextBoundary(existingAlarm.scheduledTime);
    if (advanced) return { success: true, advanced: true, recoveryPlan };
  }

  if (hasClock) {
    await runPwmStep();
    return { success: true, executedDueAction: true, recoveryPlan };
  }

  return repairScheduleClock();
}

async function repairScheduleClock() {
  const automationRevision = pwmRuntimeRevision;
  // 提取（Fowler Extract Function）：当前为 ON 时的关机过渡——先保留 ON 安全检查点，新鲜页确认定时器后才恢复 OFF。
  async function tryArmOffTransition(status) {
    // 先保留“下一步 ON”的安全检查点；只有新鲜页面确认关机定时器后，
    // 才允许恢复为下一步 OFF。
    schedule.pwmState = 'on';
    const nowMs = Date.now();
    const timerResult = await setPageTimer(schedule.onMinutes, {
      retryOnFailure: false,
      automationRevision,
    });
    if (await abortStaleAutomation(
      automationRevision,
      'repair-page-timer-active-hours-paused'
    )) {
      return { success: false, reason: '运行时段外暂停', schedule };
    }
    if (!timerResult?.success) {
      schedule.pageTimerError = `时钟修复时页面关机定时器未确认：${timerResult?.error || '未知错误'}；保持 on 相位，1 分钟后重试`;
      const alarmCreated = await createPwmAlarmWithVerify(
        1,
        'repair-pageTimer-failed',
        automationRevision
      );
      if (alarmCreated === false) {
        return { success: false, reason: '运行时段外暂停', schedule };
      }
      markPwmRetry(PWM_RETRY_KINDS.PAGE_TIMER);
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      if (await abortStaleAutomation(
        automationRevision,
        'repair-retry-active-hours-paused'
      )) {
        return { success: false, reason: '运行时段外暂停', schedule };
      }
      await persistSchedule('repairScheduleClock-pageTimer-failed');
      await updateBadge();
      return { success: false, reason: schedule.pageTimerError, schedule: { ...schedule, actualStatus: status } };
    }
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

  const restored = await restoreIntervalAlarmFromStorage('repair: 按已记录绝对触发时间恢复 PWM 闹钟');
  if (await abortStaleAutomation(
    automationRevision,
    'repair-restore-active-hours-paused'
  )) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  if (restored) {
    await updateBadge();
    const status = await getCurrentACStatus();
    return { success: true, repairedFromStoredBoundary: true, schedule: { ...schedule, actualStatus: status } };
  }

  const status = await getCurrentACStatus();
  if (await abortStaleAutomation(
    automationRevision,
    'repair-status-active-hours-paused'
  )) {
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
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);

  if (currentOn) {
    const failedResult = await tryArmOffTransition(status);
    if (failedResult) return failedResult;
  }

  schedule.pwmState = currentOn ? 'off' : 'on';
  replacePwmRetryState();
  const repairPlan = currentOn
    ? { nextTriggerAt: schedule.pageTimerTargetAt }
    : { nextTriggerAt: Date.now() + delay * 60000 };
  const alarmCreated = await createPwmAlarmFromPlan(
    repairPlan,
    'repair',
    automationRevision
  );
  if (alarmCreated === false) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  if (await abortStaleAutomation(
    automationRevision,
    'repair-commit-active-hours-paused'
  )) {
    return { success: false, reason: '运行时段外暂停', schedule };
  }
  await persistSchedule('repairScheduleClock-interval');
  await updateBadge();

  return { success: true, schedule: { ...schedule, actualStatus: status } };
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
    const smartEnabled = snapshot.smartMode?.enabled === true;
    const projectCurrentMode = () => {
      if (smartEnabled) {
        snapshot.pwmState = snapshot.smartState;
        snapshot.nextTriggerAt = Number(snapshot.smartNextTriggerAt) || 0;
        snapshot.alarmCreatedAt = 0;
        snapshot.alarmDelayMinutes = 0;
        snapshot._clockPlannedAt = Number(snapshot.smartClockPlannedAt) || 0;
        return;
      }
      snapshot._clockPlannedAt = Number(snapshot.pwmClockPlannedAt)
        || Number(snapshot.alarmCreatedAt)
        || 0;
    };

    if (snapshot._automationPausedByActiveHours) {
      if (smartEnabled) {
        snapshot.smartNextTriggerAt = 0;
        snapshot.smartClockPlannedAt = 0;
      } else {
        snapshot.nextTriggerAt = 0;
        snapshot.pwmClockPlannedAt = 0;
        snapshot.alarmCreatedAt = 0;
        snapshot.alarmDelayMinutes = 0;
      }
      snapshot.nextTriggerAt = 0;
      delete snapshot._nextBoundary;
      projectCurrentMode();
      return;
    }

    if (smartEnabled) {
      if (liveAlarmEnd) snapshot.smartNextTriggerAt = liveAlarmEnd;
    } else {
      if (!snapshot.nextTriggerAt) {
        const legacyEnd = snapshot.alarmCreatedAt && snapshot.alarmDelayMinutes
          ? snapshot.alarmCreatedAt + snapshot.alarmDelayMinutes * 60000
          : 0;
        if (legacyEnd) snapshot.nextTriggerAt = legacyEnd;
      }
      const triggerPlan = reconcilePwmTrigger(snapshot, alarm, PWM_TRIGGER_SNAPSHOT_OPTIONS);
      if (triggerPlan.kind === 'sync-live') {
        Object.assign(snapshot, triggerPlan.phasePatch);
        snapshot.pwmClockPlannedAt = Number(snapshot.pwmClockPlannedAt)
          || Number(snapshot.alarmCreatedAt)
          || 0;
      }
    }

    projectCurrentMode();
    const storedAlarmEnd = smartEnabled
      ? Number(snapshot.smartNextTriggerAt) || 0
      : Number(snapshot.nextTriggerAt) || (
        snapshot.alarmCreatedAt && snapshot.alarmDelayMinutes
          ? snapshot.alarmCreatedAt + snapshot.alarmDelayMinutes * 60000
          : 0
      );
    const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);

    if (snapshot.enabled && !snapshot._automationPausedByActiveHours && nextBoundary) {
      const remainingMs = nextBoundary - Date.now();
      if (remainingMs > 0) {
        snapshot._nextBoundary = nextBoundary;
        if (smartEnabled) {
          snapshot.smartNextTriggerAt = nextBoundary;
          snapshot.nextTriggerAt = nextBoundary;
        } else {
          snapshot.alarmCreatedAt = Date.now();
          snapshot.alarmDelayMinutes = remainingMs / 60000;
        }
      }
    }
  }

  const alarm = await chrome.alarms.get(getAutomationAlarmName());
  const liveAlarmEnd = getLiveAlarmEndMs(alarm);
  const snapshot = { ...schedule };
  const insideActiveHours = typeof isWithinActiveHours === 'function'
    ? isWithinActiveHours()
    : true;
  snapshot._insideActiveHours = insideActiveHours;
  snapshot._automationPausedByActiveHours = schedule.enabled && !insideActiveHours;
  snapshot._clockPlannedAt = isSmartAutomationEnabled()
    ? Number(schedule.smartClockPlannedAt) || 0
    : Number(schedule.pwmClockPlannedAt)
      || Number(schedule.alarmCreatedAt)
      || 0;
  snapshot._nextAction = isSmartAutomationEnabled()
    ? schedule.smartState
    : schedule.pwmState;

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

async function toggleSmartNowAndSync(action) {
  if (action === 'off') {
    const timerResult = await requestTimerBasedShutdown('toggle-smart-now-off');
    const status = await getCurrentACStatus();
    return {
      success: !!timerResult?.success,
      error: timerResult?.error,
      schedule: { ...schedule, actualStatus: status },
      result: timerResult
    };
  }

  const toggleResult = await toggleAC('on');
  if (!toggleResult?.success || !isAutomationAllowed()) {
    const status = await getCurrentACStatus();
    return {
      success: !!toggleResult?.success,
      error: toggleResult?.error,
      schedule: { ...schedule, actualStatus: status },
      result: toggleResult
    };
  }

  const automationRevision = smartRuntimeRevision;
  const now = Date.now();
  const boundaryAt = smartHalfHourBoundaryAtOrBefore(now);
  const anchoredTargetAt = smartPageTimerTargetAt(
    Number(schedule.onMinutes),
    now,
    boundaryAt
  );
  const targetAt = anchoredTargetAt > now
    ? anchoredTargetAt
    : nextSafeSmartPageTimerTargetAt(now);
  const timerResult = await setPageTimer(
    Math.max(1, Math.ceil((targetAt - now) / 60000)),
    {
      retryOnFailure: false,
      targetAt,
      automationRevision,
      automationMode: 'smart'
    }
  );
  if (!timerResult?.success) {
    const status = await getCurrentACStatus();
    return {
      success: false,
      error: timerResult?.error || 'Smart 页面关机定时器未确认',
      schedule: { ...schedule, actualStatus: status },
      result: timerResult
    };
  }

  setSmartNextAction('off');
  schedule.smartOnBoundaryAt = anchoredTargetAt > now ? boundaryAt : 0;
  await clearSmartAlarm(automationRevision);
  const alarmCreated = await createAutomationAlarmFromPlan(
    'ac-smart',
    { nextTriggerAt: timerResult.targetAt },
    'toggle-smart-now',
    automationRevision
  );
  if (!alarmCreated) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }
  await persistSchedule('toggleSmartNowAndSync', { syncFromLiveAlarm: false });
  await updateBadge();
  const status = await getCurrentACStatus();
  return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
}

async function toggleNowAndSync(action) {
  if (isSmartAutomationEnabled()) return toggleSmartNowAndSync(action);

  // 提取（Fowler Extract Function）：手动开机后的 ON 相位布防——清旧 alarm、新鲜页确认关机定时器，失败保持 on 相位 1 分钟重试。
  async function armOnPhaseTimerAndAlarms() {
    // 手动开机同样是一个新的 PWM ON 阶段。先清旧 alarm 以免验证期间旧的
    // OFF 边界抢跑；新鲜页确认失败则保持 pwmState='on'，下一次不会再点击。
    schedule.pwmState = 'on';
    replacePwmRetryState();
    setPwmNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await clearPwmAlarm(automationRevision);

    const timerResult = await setPageTimer(schedule.onMinutes, {
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
      const alarmCreated = await createPwmAlarmWithVerify(
        1,
        'toggle-pageTimer-failed',
        automationRevision
      );
      if (alarmCreated === false) {
        const status = await getCurrentACStatus();
        return { success: true, schedule: { ...schedule, actualStatus: status } };
      }
      markPwmRetry(PWM_RETRY_KINDS.PAGE_TIMER);
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      if (await abortStaleAutomation(
        automationRevision,
        'toggle-retry-active-hours-paused'
      )) {
        const status = await getCurrentACStatus();
        return { success: true, schedule: { ...schedule, actualStatus: status } };
      }
      await persistSchedule('toggleNowAndSync-pageTimer-failed');
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
  const toggleResult = await toggleAC('on');

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
  const automationRevision = pwmRuntimeRevision;

  // 间隔模式
  const currentOn = action === 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);
  clearPageTimerProofState();
  await chrome.alarms.clear('ac-page-timer-retry');

  if (currentOn) {
    const failedResult = await armOnPhaseTimerAndAlarms();
    if (failedResult) return failedResult;
  }

  schedule.pwmState = currentOn ? 'off' : 'on';
  const togglePlan = currentOn
    ? { nextTriggerAt: schedule.pageTimerTargetAt }
    : { nextTriggerAt: Date.now() + delay * 60000 };
  const alarmCreated = await createPwmAlarmFromPlan(
    togglePlan,
    'toggle',
    automationRevision
  );
  if (alarmCreated === false) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
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
  await loadScheduleFromStorage();
  const smartEnabled = isSmartAutomationEnabled();
  const automationAlarmName = getAutomationAlarmName();

  if (!schedule.enabled) {
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (isAutomationAllowed()) return ensureDiagnosticAlarms();
    await chrome.alarms.clear('ac-smart-weather');
    if (schedule.enabled) return ensureDiagnosticAlarms();
    return {
      success: true,
      enabled: false,
      repaired: false,
      schedule: { ...schedule },
      alarms: {
        badge: null,
        watchdog: null,
        pwm: null,
        smart: null,
        automation: null,
        smartWeather: null
      }
    };
  }

  if (!isAutomationAllowed()) {
    await clearAutomationRuntimeAlarmsWhileBlocked();
    if (isAutomationAllowed()) return ensureDiagnosticAlarms();
    let smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
    if (schedule.smartMode?.enabled && !smartWeatherAlarm) {
      await rescheduleSmartWeatherAlarm();
      smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
    }
    if (isAutomationAllowed()) return ensureDiagnosticAlarms();
    return {
      success: true,
      enabled: true,
      automationPausedByActiveHours: true,
      repaired: false,
      schedule: {
        ...schedule,
        _insideActiveHours: false,
        _automationPausedByActiveHours: true
      },
      alarms: {
        badge: null,
        watchdog: null,
        pwm: null,
        smart: null,
        automation: null,
        smartWeather: smartWeatherAlarm
          ? { scheduledTime: smartWeatherAlarm.scheduledTime }
          : null
      }
    };
  }

  let repaired = false;
  const repairs = [];

  let badgeAlarm = await chrome.alarms.get('ac-badge-tick');
  if (!badgeAlarm || badgeAlarm.scheduledTime <= Date.now()) {
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    repaired = true;
    repairs.push('badge-alarm');
  }

  let watchdogAlarm = await chrome.alarms.get('ac-watchdog');
  if (!watchdogAlarm) {
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    repaired = true;
    repairs.push('watchdog-alarm');
  }

  let automationAlarm = await chrome.alarms.get(automationAlarmName);
  const automationAlarmBeforeRecovery = Number(automationAlarm?.scheduledTime) || 0;
  const clockRecovery = smartEnabled
    ? await repairSmartScheduleClock({ rearmPageTimer: false })
    : await ensureScheduleClock();
  automationAlarm = await chrome.alarms.get(automationAlarmName);
  if (clockRecovery?.repairedPwmClock || clockRecovery?.repairedFromLiveAlarm) {
    repaired = true;
    repairs.push(smartEnabled ? 'smart-clock' : 'pwm-clock');
  }
  if ((!automationAlarmBeforeRecovery && automationAlarm)
      || (automationAlarmBeforeRecovery > 0
        && Number(automationAlarm?.scheduledTime) !== automationAlarmBeforeRecovery)) {
    repaired = true;
    repairs.push(smartEnabled ? 'smart-alarm' : 'pwm-alarm');
  }

  // 智能模式天气闹钟自愈：ac-smart-weather 是 v0.8.0 新增闹钟，不在既有 5 闹钟
  // 自愈清单里；丢失后天气缓存冻结，等效温度/建议分钟数不再更新。与 badge-tick/watchdog 一样补建。
  let smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
  if (schedule.smartMode?.enabled && !smartWeatherAlarm) {
    await rescheduleSmartWeatherAlarm();
    smartWeatherAlarm = await chrome.alarms.get('ac-smart-weather');
    repaired = true;
    repairs.push('smart-weather-alarm');
  }

  badgeAlarm = await chrome.alarms.get('ac-badge-tick');
  watchdogAlarm = await chrome.alarms.get('ac-watchdog');
  const diagnosticRevision = smartEnabled
    ? smartRuntimeRevision
    : pwmRuntimeRevision;
  automationAlarm = await chrome.alarms.get(automationAlarmName);

  if (smartEnabled) {
    if (getLiveAlarmEndMs(automationAlarm)) {
      setSmartNextTriggerAt(automationAlarm.scheduledTime);
      await persistSchedule('ensureDiagnosticAlarms-smart', {
        syncFromLiveAlarm: false
      });
    }
  } else {
    // 活闹钟存在但 storage 可能缺失 nextTriggerAt → 直接回写
    const triggerPlan = await persistReconciledPwmTrigger(
      automationAlarm,
      'ensureDiagnosticAlarms',
      PWM_TRIGGER_NEXT_ONLY_OPTIONS,
      diagnosticRevision
    );
    if (triggerPlan) {
      repaired = true;
      repairs.push('pwm-trigger');
    }
  }

  const pwmAlarm = smartEnabled ? null : automationAlarm;
  const smartAlarm = smartEnabled ? automationAlarm : null;

  return {
    success: !!badgeAlarm
      && !!watchdogAlarm
      && !!automationAlarm
      && (!smartEnabled || !!smartWeatherAlarm),
    enabled: true,
    repaired,
    repairs: [...new Set(repairs)],
    schedule: { ...schedule },
    alarms: {
      badge: badgeAlarm ? { scheduledTime: badgeAlarm.scheduledTime } : null,
      watchdog: watchdogAlarm ? { scheduledTime: watchdogAlarm.scheduledTime, periodInMinutes: watchdogAlarm.periodInMinutes } : null,
      pwm: pwmAlarm ? { scheduledTime: pwmAlarm.scheduledTime } : null,
      smart: smartAlarm ? { scheduledTime: smartAlarm.scheduledTime } : null,
      automation: automationAlarm ? {
        name: automationAlarm.name,
        scheduledTime: automationAlarm.scheduledTime
      } : null,
      smartWeather: smartWeatherAlarm ? { scheduledTime: smartWeatherAlarm.scheduledTime } : null
    }
  };
}

const BACKGROUND_MESSAGE_TYPES = new Set([
  'getSwStatus',
  'updateSchedule',
  'getSchedule',
  'getScheduleLite',
  'getPageTimer',
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
      getAutomationAlarm(),
      chrome.offscreen.hasDocument().catch(() => false)
    ]).then(([liveAlarm, offscreenAlive]) => {
      sendResponse({
        success: true,
        swStartupTime,
        initCompletedAt,
        swAgeMs: now - swStartupTime,
        initCompleted: !!initCompletedAt,
        initAgeMs: initCompletedAt ? (now - initCompletedAt) : -1,
        memorySchedule: { ...schedule },
        liveAlarmName: getAutomationAlarmName(),
        liveAlarmScheduledTime: liveAlarm?.scheduledTime || 0,
        offscreenAlive: !!offscreenAlive
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
      // 提取（Fowler Extract Function）：用户停用路径——B1 顺序：先持久化"已关闭"状态再执行关机。
      const shutdownAfterScheduleDisable = async ({ activeHoursPause = false } = {}) => {
        await resetDisabledAutomationRuntime();
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

      const wasEnabled = schedule.enabled;
      const wasSmartEnabled = isSmartAutomationEnabled();
      const wasAutomationAllowed = isAutomationAllowed();
      const previousActiveHours = JSON.stringify(schedule.activeHours);
      // 防止 restart 泄漏到 schedule 对象中；手动时长单独取出，智能模式下不上送覆盖。
      const {
        restart,
        onMinutes: manualOn,
        offMinutes: manualOff,
        _insideActiveHours,
        _automationPausedByActiveHours,
        enabled: requestedEnabled,
        activeHours: requestedActiveHours,
        smartMode: requestedSmartMode,
        clockMode: requestedClockMode
      } = msg.data;
      // 智能模式开启时，on/off 时长是派生值（控制边界消费预计算天气快照）。
      // 弹窗在智能模式下已隐藏手动时长输入，其上送的 manualOn/manualOff 是过期值，直接覆盖会
      // 污染 storage（余额估算、诊断面板、过期闹钟恢复都会读到错误时长，让灵敏度滑块看似无效）。
      const smartEnabled = !!(requestedSmartMode?.enabled ?? schedule.smartMode?.enabled);
      schedule = {
        ...schedule,
        ...(typeof requestedEnabled === 'boolean' ? { enabled: requestedEnabled } : {}),
        mode: 'pwm',
        clockMode: requestedClockMode !== undefined ? !!requestedClockMode : schedule.clockMode
      };
      if (!smartEnabled) {
        schedule.onMinutes = sanitizeMinutes(manualOn ?? schedule.onMinutes, 30);
        schedule.offMinutes = sanitizeMinutes(manualOff ?? schedule.offMinutes, 30);
      }
      // activeHours 单独 merge（嵌套对象）
      if (requestedActiveHours && typeof requestedActiveHours === 'object') {
        schedule.activeHours = {
          enabled: !!requestedActiveHours.enabled,
          start: typeof requestedActiveHours.start === 'string' ? requestedActiveHours.start : (schedule.activeHours?.start || '08:00'),
          end: typeof requestedActiveHours.end === 'string' ? requestedActiveHours.end : (schedule.activeHours?.end || '23:00')
        };
      }
      // smartMode 单独 merge（嵌套对象，v0.8.0）
      if (requestedSmartMode && typeof requestedSmartMode === 'object') {
        schedule.smartMode = {
          enabled: !!requestedSmartMode.enabled,
          sensitivity: normalizeSmartSensitivity(requestedSmartMode.sensitivity)
        };
      }
      // 天气只由 :10/:50 的 ac-smart-weather 预取（setupAlarms 已调度），此处不即时拉取。

      const activeHoursChanged = previousActiveHours !== JSON.stringify(schedule.activeHours);
      const smartModeChanged = wasSmartEnabled !== isSmartAutomationEnabled();
      const automationAllowed = isAutomationAllowed();
      if (smartModeChanged) {
        pwmRuntimeRevision += 1;
        smartRuntimeRevision += 1;
        scheduleLoadBlockedRevision = pwmRuntimeRevision;
        if (!isSmartAutomationEnabled()) schedule.smartOnBoundaryAt = 0;
        await clearAutomationAlarm(
          wasSmartEnabled ? 'ac-smart' : 'ac-pwm',
          null,
          true
        );
      }
      let offResult = null;
      if (!schedule.enabled) {
        if (wasEnabled) {
          offResult = await shutdownAfterScheduleDisable();
        }
      } else if (!automationAllowed
          && (wasAutomationAllowed || !wasEnabled || activeHoursChanged || restart)) {
        offResult = await shutdownAfterScheduleDisable({ activeHoursPause: true });
      } else if (automationAllowed && (!wasAutomationAllowed || restart || smartModeChanged)) {
        if (isSmartAutomationEnabled()) setSmartNextAction('on');
        else schedule.pwmState = 'on';
        // 不在这里 clear nextTriggerAt——让接下来的当前模式 runner 用正确值覆写。
        // 如果在这里清零，storage 会被写入 nextTriggerAt=0，弹窗读到就会显示缺失。
      }

      await persistSchedule('updateSchedule');
      // 先应答 popup，再在后台执行「立即起一轮」等长任务：setupAlarms(startImmediately)
      // 会直接 await runSmartStep/runPwmStep，其中包含页面定时器写入与新鲜页读回
      // （最坏要等 60s 写入超时 + 重试）。放在 sendResponse 之前会让模式切换时的弹窗
      // 看起来卡死。持久化已完成，popup 每秒轮询会补齐后续状态。
      sendResponse({ success: true, schedule, offResult });
      waitUntil((async () => {
        await setupAlarms(
          automationAllowed && (!wasAutomationAllowed || restart || smartModeChanged)
        );
        // 管理看门狗和每分钟 PWM 心跳闹钟
        if (isAutomationAllowed()) {
          await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        }
        // active hours 边界闹钟：每次 schedule 改变都重新调度
        rescheduleActiveBoundary();
        // [v0.5.6] 跨设备同步：用户改设置 / toggle 是低频事件，立即推送
        await syncScheduleToSync('updateSchedule');
      })().catch((e) => {
        console.warn('[AC扩展] updateSchedule 后续步骤失败:', e?.message);
        void appendDiagnosticLog('error', 'updateSchedule-followup', e);
      }));
      return;
    }
    if (msg.type === 'reapplySmartNow') {
      // 滑块松开后的即时反馈：立即应答，不阻塞 popup；重设在后台 waitUntil 保活执行。
      sendResponse({ success: true, accepted: !smartReapplyInFlight });
      if (!smartReapplyInFlight) {
        smartReapplyInFlight = true;
        waitUntil(reapplySmartSensitivityNow())
          .catch((e) => {
            console.warn('[AC扩展] 滑块灵敏度即时应用失败:', e?.message);
            void appendDiagnosticLog('warn', 'reapply-smart-now', e);
          })
          .finally(() => { smartReapplyInFlight = false; });
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
    if (msg.type === 'refreshSmartWeather') {
      const weather = await readStoredSmartWeather();
      sendResponse({ success: true, weather });
      return;
    }
    if (msg.type === 'repairSchedule') {
      const result = isSmartAutomationEnabled()
        ? await repairSmartScheduleClock()
        : await repairScheduleClock();
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
    const existing = await chrome.storage.local.get(STORAGE_KEY);
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
          pwmClockPlannedAt: 0,
          smartClockPlannedAt: 0,
          alarmCreatedAt: 0,
          alarmDelayMinutes: 0,
          pageTimerTargetAt: 0,
          pageTimerRetryMinutes: 0,
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
