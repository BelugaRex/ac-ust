// Popup 独立兜底诊断：先于主脚本加载。
// popup.js 正常注册完整诊断后，本脚本只记录错误并完全让路；主脚本未就绪时，
// 本脚本只读采集最小现场，不自愈、不读取 URL、DOM 原文、账号或余额。
(function setupPopupDiagnosticFallback() {
  'use strict';

  const FALLBACK_BUILD_TIME = 'dev';
  const FALLBACK_BUILD_TIME_EPOCH_MS = 0;
  const FALLBACK_BUILD_SOURCE_SHA256 = 'dev';
  const FALLBACK_MESSAGE_TIMEOUT_MS = 3000;
  const MAX_CAPTURED_POPUP_ERRORS = 5;
  const capturedErrors = [];
  const state = { active: false, lines: [] };
  const fallbackMessages = {
    diagnoseFallbackSummary: 'Popup main diagnostics unavailable; showing a read-only fallback report',
    diagnoseFallbackCapturedError: 'Captured Popup error: $1',
    diagnoseFallbackNoCapturedError: 'No Popup error event was captured before fallback activation',
    diagnoseFallbackDocument: 'Popup document: readyState=$1, visibility=$2, viewport=$3×$4, content=$5×$6',
    diagnoseFallbackSchedule: 'Safe schedule snapshot: $1',
    diagnoseFallbackAlarms: 'ac-* alarms: $1',
    diagnoseFallbackHeartbeat: 'storage heartbeat age: $1',
    diagnoseFallbackSw: 'Service Worker snapshot: initCompleted=$1, live ac-pwm=$2',
    diagnoseFallbackSectionFailed: '$1 snapshot failed: $2',
    diagnoseFallbackPartial: 'Partial fallback report: no repair was attempted; copy it as-is for support',
    copyDiagDone: 'Diagnostic report copied',
    copyFailed: 'Copy failed'
  };

  function sanitizeFallbackError(value) {
    return String(value?.message || value || 'unknown error')
      .replace(/(?:https?|chrome-extension|file):\/\/[^\s)\]]+/gi, '[url]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  function sanitizeFallbackToken(value, fallback = '?') {
    const token = String(value ?? '').replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 40);
    return token || fallback;
  }

  function formatFallbackBrowser(userAgent) {
    const value = String(userAgent || '');
    const edgeVersion = value.match(/Edg\/([\d.]+)/)?.[1];
    if (edgeVersion) return `Edge ${edgeVersion}`;
    const chromeVersion = value.match(/Chrome\/([\d.]+)/)?.[1];
    return chromeVersion ? `Chrome ${chromeVersion}` : 'Unknown';
  }

  function formatFallbackTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp).toLocaleString()
      : '∅';
  }

  function formatFallbackSchedule(schedule) {
    const value = schedule && typeof schedule === 'object' ? schedule : {};
    const activeHours = value.activeHours && typeof value.activeHours === 'object'
      ? value.activeHours
      : {};
    const smartMode = value.smartMode && typeof value.smartMode === 'object'
      ? value.smartMode
      : {};
    return [
      `enabled=${value.enabled === true}`,
      `mode=${sanitizeFallbackToken(value.mode)}`,
      `clockMode=${value.clockMode === true}`,
      `pwmState=${sanitizeFallbackToken(value.pwmState)}`,
      `nextTriggerAt=${formatFallbackTimestamp(value.nextTriggerAt)}`,
      `activeHours=${activeHours.enabled === true}:${sanitizeFallbackToken(activeHours.start)}-${sanitizeFallbackToken(activeHours.end)}`,
      `smartMode=${smartMode.enabled === true}:sensitivity=${Number.isFinite(Number(smartMode.sensitivity)) ? Number(smartMode.sensitivity) : '?'}`,
      `pageTimerError=${Boolean(value.pageTimerError)}`,
      `pageTimerRetryAt=${formatFallbackTimestamp(value.pageTimerRetryAt)}`
    ].join(', ');
  }

  async function loadFallbackTranslations() {
    try {
      await globalThis.I18n?.load?.();
      globalThis.I18n?.applyToDOM?.();
      document.documentElement.lang = globalThis.I18n?.getLang?.().replace('_', '-') || 'en';
    } catch (_) {
      // i18n 自身失效时继续使用本文件内置英文，确保仍能产出报告。
    }
  }

  function fallbackTranslate(key, ...subs) {
    let message = '';
    try {
      message = globalThis.I18n?.t?.(key, ...subs) || '';
    } catch (_) {
      message = '';
    }
    if (message && message !== key) return message;
    message = fallbackMessages[key] || key;
    subs.forEach((sub, index) => {
      message = message.split(`$${index + 1}`).join(String(sub));
    });
    return message;
  }

  function recordPopupError(error) {
    const message = sanitizeFallbackError(error);
    if (!message || capturedErrors.some(item => item.message === message)) return;
    capturedErrors.push({ message, timestamp: Date.now() });
    if (capturedErrors.length > MAX_CAPTURED_POPUP_ERRORS) capturedErrors.shift();
  }

  globalThis.addEventListener('error', (event) => {
    recordPopupError(event.error || event.message);
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    recordPopupError(event.reason);
  });

  async function sendFallbackRuntimeMessage(message) {
    let timeoutId;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('timeout')), FALLBACK_MESSAGE_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function renderFallbackLines(lines) {
    const content = document.getElementById('diagContent');
    if (!content) return;
    const fragment = document.createDocumentFragment();
    lines.forEach((line, index) => {
      if (index > 0) fragment.append(document.createElement('br'));
      fragment.append(document.createTextNode(line));
    });
    content.replaceChildren(fragment);
  }

  function setFallbackStatus(message, type = '') {
    const status = document.getElementById('status');
    if (!status) return;
    status.textContent = message;
    status.className = `status ${type}`;
  }

  async function copyFallbackReport() {
    const newline = String.fromCharCode(10);
    const text = '```' + newline + state.lines.join(newline) + newline + '```';
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    }
  }

  function getFallbackControlAuditBuild() {
    const epoch = Number(FALLBACK_BUILD_TIME_EPOCH_MS);
    const buildTime = String(FALLBACK_BUILD_TIME || '');
    const sha256 = String(FALLBACK_BUILD_SOURCE_SHA256 || '').toLowerCase();
    let version = '';
    try {
      version = String(chrome.runtime.getManifest().version || '');
    } catch (_) {
      return '';
    }
    if (!Number.isSafeInteger(epoch)
        || epoch <= 0
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(buildTime)
        || !/^[a-f0-9]{64}$/.test(sha256)
        || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version)) {
      return '';
    }
    return `${version}|${buildTime}|${epoch}|${sha256}`;
  }

  function sanitizeFallbackAuditText(value, maxLength = 220) {
    if (typeof value !== 'string'
        || /<[^>]{1,200}>/.test(value)
        || /(?:https?|chrome-extension|file):\/\/\S+/i.test(value)
        || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value)) {
      return '';
    }
    return value
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function fallbackAuditInteger(value, positive = false) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= (positive ? 1 : 0)
      ? number
      : 0;
  }

  async function readFallbackControlAuditSnapshot() {
    const build = getFallbackControlAuditBuild();
    if (!build) return null;
    try {
      const stored = await chrome.storage.local.get('ac_dist_control_audit_v1');
      const envelope = stored?.ac_dist_control_audit_v1;
      if (!envelope
          || typeof envelope !== 'object'
          || envelope.schemaVersion !== 1
          || envelope.build !== build
          || !envelope.active
          || typeof envelope.active !== 'object') {
        return null;
      }
      const controlId = sanitizeFallbackAuditText(envelope.active.controlId);
      if (!controlId || envelope.active.action !== 'on') return null;
      const active = {
        controlId,
        action: 'on',
        scheduledAt: fallbackAuditInteger(envelope.active.scheduledAt),
        confirmedAt: fallbackAuditInteger(envelope.active.confirmedAt)
      };
      const now = Date.now();
      const events = Array.isArray(envelope.events)
        ? envelope.events
          .filter(event => event
            && typeof event === 'object'
            && event.build === build
            && event.controlId === controlId)
          .map(event => ({
            seq: fallbackAuditInteger(event.seq, true),
            at: fallbackAuditInteger(event.at),
            attempt: fallbackAuditInteger(event.attempt, true),
            stage: sanitizeFallbackAuditText(event.stage, 80),
            result: sanitizeFallbackAuditText(event.result, 80),
            code: sanitizeFallbackAuditText(event.code, 80)
          }))
          .filter(event => event.seq
            && event.at
            && event.at <= now
            && event.attempt
            && event.stage
            && event.result)
          .sort((left, right) => left.seq - right.seq || left.at - right.at)
        : [];
      return { build, controlId, active, events, capturedAt: now };
    } catch (_) {
      return null;
    }
  }

  function appendFallbackControlAuditLines(lines, snapshot) {
    if (!snapshot) return;
    if (snapshot.active.scheduledAt > 0
        && snapshot.active.scheduledAt <= snapshot.capturedAt
        && snapshot.active.confirmedAt === 0) {
      lines.push(
        `❌ [AC-START-MISSED] scheduledAt=${formatFallbackTimestamp(snapshot.active.scheduledAt)}`
      );
    }
    snapshot.events.forEach((event) => {
      lines.push(
        `ℹ️ [AC-START-LIFECYCLE] seq=${event.seq}`
        + ` attempt=${event.attempt}`
        + ` stage=${event.stage}`
        + ` result=${event.result}`
        + `${event.code ? ` code=${event.code}` : ''}`
        + ` at=${formatFallbackTimestamp(event.at)}`
      );
    });
  }

  async function runFallbackDiagnostic() {
    const diagnoseButton = document.getElementById('btnDiagnose');
    const result = document.getElementById('diagnoseResult');
    const copyButton = document.getElementById('btnCopyDiag');
    state.active = true;
    state.lines = [];
    if (diagnoseButton) diagnoseButton.disabled = true;
    if (copyButton) copyButton.hidden = true;
    if (result) result.style.display = 'block';

    await loadFallbackTranslations();
  const controlAuditSnapshot = await readFallbackControlAuditSnapshot();
    const root = document.documentElement;
    const body = document.body;
    const manifest = chrome.runtime.getManifest();
    const viewportWidth = Math.round(root.clientWidth || globalThis.innerWidth || 0);
    const viewportHeight = Math.round(root.clientHeight || globalThis.innerHeight || 0);
    const contentWidth = Math.round(Math.max(root.scrollWidth || 0, body?.scrollWidth || 0));
    const contentHeight = Math.round(Math.max(root.scrollHeight || 0, body?.scrollHeight || 0));
    const lines = [
      `⚠️ [POPUP-MAIN-FAILED] ${fallbackTranslate('diagnoseFallbackSummary')}`,
      `ℹ️ ${new Date().toLocaleString()}`,
      `ℹ️ version=${sanitizeFallbackToken(manifest.version)}, browser=${formatFallbackBrowser(navigator.userAgent)}`,
      `ℹ️ ${fallbackTranslate(
        'diagnoseFallbackDocument',
        document.readyState,
        document.visibilityState,
        viewportWidth,
        viewportHeight,
        contentWidth,
        contentHeight
      )}`
    ];

    if (capturedErrors.length) {
      capturedErrors.forEach(({ message }) => {
        lines.push(`⚠️ [POPUP-RUNTIME-ERROR] ${fallbackTranslate('diagnoseFallbackCapturedError', message)}`);
      });
    } else {
      lines.push(`ℹ️ ${fallbackTranslate('diagnoseFallbackNoCapturedError')}`);
    }

    appendFallbackControlAuditLines(lines, controlAuditSnapshot);

    const [storageResult, alarmsResult, swResult] = await Promise.allSettled([
      chrome.storage.local.get(['ac_schedule', '__heartbeat']),
      chrome.alarms.getAll(),
      sendFallbackRuntimeMessage({ type: 'getSwStatus' })
    ]);

    if (storageResult.status === 'fulfilled') {
      const stored = storageResult.value || {};
      lines.push(`✅ ${fallbackTranslate('diagnoseFallbackSchedule', formatFallbackSchedule(stored.ac_schedule))}`);
      const heartbeat = Number(stored.__heartbeat);
      const heartbeatAge = Number.isFinite(heartbeat) && heartbeat > 0 && heartbeat <= Date.now()
        ? `${Math.round((Date.now() - heartbeat) / 1000)}s`
        : 'unknown';
      lines.push(`ℹ️ ${fallbackTranslate('diagnoseFallbackHeartbeat', heartbeatAge)}`);
    } else {
      lines.push(`❌ [POPUP-STORAGE-READ-FAILED] ${fallbackTranslate(
        'diagnoseFallbackSectionFailed',
        'storage',
        sanitizeFallbackError(storageResult.reason)
      )}`);
    }

    if (alarmsResult.status === 'fulfilled') {
      const alarmText = (alarmsResult.value || [])
        .filter(alarm => typeof alarm?.name === 'string' && alarm.name.startsWith('ac-'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(alarm => `${sanitizeFallbackToken(alarm.name)}@${formatFallbackTimestamp(alarm.scheduledTime)}`)
        .join(' | ') || 'none';
      lines.push(`✅ ${fallbackTranslate('diagnoseFallbackAlarms', alarmText)}`);
    } else {
      lines.push(`⚠️ [POPUP-ALARMS-READ-FAILED] ${fallbackTranslate(
        'diagnoseFallbackSectionFailed',
        'alarms',
        sanitizeFallbackError(alarmsResult.reason)
      )}`);
    }

    if (swResult.status === 'fulfilled' && swResult.value?.success === true) {
      lines.push(`✅ ${fallbackTranslate(
        'diagnoseFallbackSw',
        swResult.value.initCompleted === true,
        formatFallbackTimestamp(swResult.value.liveAlarmScheduledTime)
      )}`);
    } else {
      const reason = swResult.status === 'rejected'
        ? swResult.reason
        : swResult.value?.error || 'unavailable';
      lines.push(`⚠️ [POPUP-SW-UNAVAILABLE] ${fallbackTranslate(
        'diagnoseFallbackSectionFailed',
        'Service Worker',
        sanitizeFallbackError(reason)
      )}`);
    }

    lines.push(`ℹ️ ${fallbackTranslate('diagnoseFallbackPartial')}`);
    state.lines = lines;
    renderFallbackLines(lines);
    if (copyButton) copyButton.hidden = false;
    if (diagnoseButton) diagnoseButton.disabled = false;
    result?.focus();
    setFallbackStatus(fallbackTranslate('diagnoseFallbackPartial'), '');
  }

  const diagnoseButton = document.getElementById('btnDiagnose');
  const copyButton = document.getElementById('btnCopyDiag');
  diagnoseButton?.addEventListener('click', (event) => {
    if (globalThis.__AC_POPUP_DIAGNOSTICS_READY__ === true) return;
    event.stopImmediatePropagation();
    void runFallbackDiagnostic().catch((error) => {
      recordPopupError(error);
      state.lines = [
        `❌ [POPUP-FALLBACK-FAILED] ${fallbackTranslate(
          'diagnoseFallbackSectionFailed',
          'fallback',
          sanitizeFallbackError(error)
        )}`
      ];
      renderFallbackLines(state.lines);
      if (diagnoseButton) diagnoseButton.disabled = false;
      if (copyButton) copyButton.hidden = false;
    });
  });
  copyButton?.addEventListener('click', (event) => {
    if (!state.active) return;
    event.stopImmediatePropagation();
    void copyFallbackReport().then((copied) => {
      setFallbackStatus(fallbackTranslate(copied ? 'copyDiagDone' : 'copyFailed'), copied ? 'success' : 'error');
    });
  });

  globalThis.ACPopupDiagnosticFallback = Object.freeze({
    getCapturedErrors: () => capturedErrors.map(item => ({ ...item }))
  });
})();
