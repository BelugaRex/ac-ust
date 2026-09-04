// ============================================================
// Content Script - 注入到 w5.ab.ust.hk/njggt/app/* 页面
// 负责隔离世界状态读取，并把开关目标委派给主世界 page-confirm.js
// ============================================================

// scripting.executeScript 兜底可能与 manifest content_scripts 在同一隔离世界
// 重复执行本文件。IIFE 隔离顶层声明；消息监听器引用保存在 global 上，重注入时
// 先移除旧监听器再登记新监听器。不能只看 loaded 哨兵提前 return：扩展 reload
// 后旧页面可能保留 JS global，却已失去旧 extension runtime 的消息接收端。
(() => {

// i18n — content script 运行在隔离世界，不能 importScripts，用内联 fetch loader
const _i18nCache = {};
let _i18nReady = false;
function normalizeContentLocale(raw) {
  const normalized = String(raw || 'zh_CN').replace('-', '_');
  if (/^en(?:_|$)/i.test(normalized)) return 'en';
  return normalized;
}
async function _i18nLoad() {
  if (_i18nReady) return;
  try {
    const ui = normalizeContentLocale(chrome.i18n?.getUILanguage?.());
    const tryLoad = async (lang) => {
      const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
      return res.ok ? res.json() : null;
    };
    _i18nCache[ui] = await tryLoad(ui);
    _i18nCache.zh_CN = _i18nCache.zh_CN || await tryLoad('zh_CN');
    _i18nReady = true;
  } catch (_) { /* 翻译加载失败不阻塞核心功能 */ }
}
function _i18nPick() {
  return (_i18nCache[Object.keys(_i18nCache).find(k => k !== 'zh_CN' && _i18nCache[k])]) || _i18nCache.zh_CN || {};
}
const t = (key, ...subs) => {
  const msgs = _i18nPick();
  let msg = msgs[key]?.message || key;
  subs.forEach((s, i) => { msg = msg.split(`$${i+1}`).join(String(s)); });
  return msg;
};

console.log('[AC扩展] Content script 已加载');

const AC_HOME_URL = 'https://w5.ab.ust.hk/njggt/app/home';
function isExactACHomeContext() {
  return window.top === window && window.location.href === AC_HOME_URL;
}

function getAutomaticOnCancellationRevision() {
  const revision = Number(self.__AC_AUTOMATIC_ON_CANCELLATION_REVISION__);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function cancelAutomaticOnInContentWorld() {
  const revision = getAutomaticOnCancellationRevision() + 1;
  self.__AC_AUTOMATIC_ON_CANCELLATION_REVISION__ = revision;
  window.dispatchEvent(new CustomEvent('__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'));
  return revision;
}

// ----- 监听来自 background 的消息 -----
// 触发 i18n 加载（不阻塞，翻译加载失败不影响核心功能）
_i18nLoad();
const previousContentMessageListener = self.__AC_CONTENT_MESSAGE_LISTENER__;
if (typeof previousContentMessageListener === 'function') {
  try {
    chrome.runtime.onMessage.removeListener(previousContentMessageListener);
  } catch (_) { /* 旧 extension context 已失效时直接登记新监听器 */ }
}

const contentMessageListener = (msg, sender, sendResponse) => {
  const action = msg?.action;
  if (action === 'ping') {
    sendResponse({ success: true });
    return false;
  }

  const isACOperation = action === 'on'
    || action === 'off'
    || action === 'cancelAutomaticOn'
    || action === 'status'
    || action === 'setTimer'
    || action === 'getPageTimer';
  if (isACOperation && !isExactACHomeContext()) {
    sendResponse({ success: false, invalidTarget: true, error: '拒绝在非精确 AC home 页面执行空调操作' });
    return false;
  }
  if (action === 'cancelAutomaticOn') {
    const cancellationRevision = cancelAutomaticOnInContentWorld();
    sendResponse({ success: true, cancelled: true, cancellationRevision });
    return false;
  }
  if (action === 'off') {
    sendResponse({
      success: false,
      error: 'OFF 操作已禁用；自动关机只允许使用 Power-off after'
    });
    return false;
  }
  if (action === 'on') {
    toggleACSwitch(action, msg.notAfterAt).then(result => sendResponse(result));
    return true; // 异步响应
  }
  if (action === 'status') {
    getAuthoritativeACStatus().then(result => sendResponse(result));
    return true;
  }
  if (action === 'setTimer') {
    setPagePowerOffTimer(msg.minutes, msg.targetAt, msg.allowLocalOnly === true)
      .then(result => sendResponse(result));
    return true;
  }
  if (action === 'getPageTimer') {
    // v0.5.10：读 picker 当前值——跨设备主同步通道（UST 服务器同步给所有会话）
    sendResponse(getPagePowerOffTimer());
    return true;
  }
  return false;
};
chrome.runtime.onMessage.addListener(contentMessageListener);
self.__AC_CONTENT_MESSAGE_LISTENER__ = contentMessageListener;
self.__AC_CONTENT_LOADED__ = true;

// ----- 内容脚本错误回传：把隔离世界未捕获异常上报给 SW 记入诊断日志 -----
if (!self.__AC_CONTENT_ERROR_REPORTED__) {
  self.__AC_CONTENT_ERROR_REPORTED__ = true;

  function reportContentError(source, message) {
    try {
      const request = chrome.runtime.sendMessage({
        type: 'reportContentError',
        source,
        error: String(message)
      });
      if (request && typeof request.catch === 'function') request.catch(() => {});
    } catch (_) { /* SW 未就绪或上下文失效时静默，不阻塞页面 */ }
  }

  window.addEventListener('error', (event) => {
    reportContentError('content-script-error', event?.error?.message || event?.message || '未知错误');
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportContentError('content-script-unhandledrejection', event?.reason?.message || String(event?.reason));
  });
  // 主世界（page-confirm.js）无法直接调用 chrome.runtime，经 CustomEvent 桥接回传。
  window.addEventListener('__AC_EXTENSION_PAGE_ERROR__', (event) => {
    const detail = event.detail || {};
    if (!detail?.message) return;
    reportContentError(detail.source || 'page-confirm-error', detail.message);
  });
}

// ----- 获取当前 AC 状态 -----
function getACStatus() {
  const antSwitch = findAntACSwitch();
  if (antSwitch) {
    const disabled = isAntACSwitchDisabled(antSwitch);
    const checked = antSwitch.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') {
      return { isOn: checked === 'true', disabled, source: 'ant-switch' };
    }

    const text = (antSwitch.textContent || '').trim().toUpperCase();
    if (text.includes('ON')) return { isOn: true, disabled, source: 'ant-switch-text' };
    if (text.includes('OFF')) return { isOn: false, disabled, source: 'ant-switch-text' };
  }

  return getLegacyACStatus();
}

// 基于 DOM 的 disabled 状态判定，而非余额数值：free mode 下余额为 0 也不禁用。
function isAntACSwitchDisabled(sw) {
  if (!sw) return false;
  return sw.disabled === true
    || sw.hasAttribute?.('disabled')
    || sw.getAttribute?.('aria-disabled') === 'true'
    || String(sw.className || '').includes('ant-switch-disabled');
}

// 提取（Fowler Extract Function）：旧版页面 Semantic UI toggle 的状态扫描与兜底匹配。
function getLegacyACStatus() {
  // 旧版页面: 通过 DOM 判断 Semantic UI toggle 状态
  const checkboxes = document.querySelectorAll('.ui.toggle.checkbox input[type="checkbox"]');
  for (const cb of checkboxes) {
    // 确认是 AC 开关（附近有 "Air Conditioning" 文本）
    const parent = cb.closest('.row') || cb.closest('[class*="column"]');
    if (parent) {
      const text = parent.textContent || '';
      if (text.includes('Air Conditioning') || text.includes('ON') || text.includes('OFF')) {
        return { isOn: cb.checked };
      }
    }
    // 也检查最近的包含 ON/OFF 文本的元素
    const nearby = cb.parentElement?.parentElement?.parentElement;
    if (nearby) {
      const text = nearby.textContent || '';
      if (text.includes('Air Conditioning')) {
        return { isOn: cb.checked };
      }
    }
  }
  
  // 方法2: 查找所有 toggle checkbox
  if (checkboxes.length > 0) {
    return { isOn: checkboxes[0].checked, note: '最佳匹配' };
  }
  
  return { isOn: null, error: '未找到 AC 开关元素' };
}

async function getAuthoritativeACStatus() {
  const withBalance = (status) => {
    const balance = getACBalanceSnapshot();
    return balance.state === 'available'
      ? { ...status, balanceState: balance.state, balanceMinutes: balance.balanceMinutes }
      : { ...status, balanceState: balance.state };
  };

  const mainWorldStatus = await requestMainWorldStatus(3000);
  if (typeof mainWorldStatus?.isOn === 'boolean') {
    return withBalance({ ...mainWorldStatus, via: 'main-world' });
  }

  const isolatedStatus = getACStatus();
  if (typeof isolatedStatus?.isOn === 'boolean') {
    return withBalance(mainWorldStatus?.error
      ? { ...isolatedStatus, fallbackError: mainWorldStatus.error, via: 'isolated-fallback' }
      : isolatedStatus);
  }

  return withBalance(mainWorldStatus?.error
    ? { ...isolatedStatus, fallbackError: mainWorldStatus.error }
    : isolatedStatus);
}

// 页面余额环会同时显示当前剩余分钟数（如 "242 min"）和周期总额。
// 只在 "Air Conditioning Balance" 标题所在区块读取 .ant-progress-text，
// 避免误把下方 "16100 min balance" 的总额当成当前余额。
function hasChargeModeLabel(elements) {
  return Array.from(elements || []).some(
    element => (element.textContent || '').trim() === 'Charge Mode'
  );
}

function classifyACBalanceReading(elements, ...values) {
  const labels = Array.from(elements || [])
    .map(element => (element.textContent || '').trim())
    .filter(Boolean);
  const balanceMinutes = parseBalanceMinutes(...values);

  if (hasChargeModeLabel(elements)) {
    return Number.isFinite(balanceMinutes)
      ? { state: 'available', balanceMinutes }
      : { state: 'unavailable', balanceMinutes: null };
  }

  const hasExplicitOtherMode = labels.some(label =>
    label !== 'Charge Mode' && /\S+\s+Mode$/i.test(label)
  );
  return {
    state: hasExplicitOtherMode ? 'not-charge-mode' : 'unavailable',
    balanceMinutes: null
  };
}

function getACBalanceSnapshot() {
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const heading = headings.find(el => (el.textContent || '').trim() === 'Air Conditioning Balance');
  if (!heading) return { state: 'unavailable', balanceMinutes: null };

  let container = heading.parentElement;
  for (let depth = 0; depth < 8 && container; depth++) {
    const value = container.querySelector('.ant-progress-text');
    if (value) {
      return classifyACBalanceReading(
        container.querySelectorAll('small'),
        value.textContent,
        value.getAttribute('title')
      );
    }
    container = container.parentElement;
  }
  return { state: 'unavailable', balanceMinutes: null };
}

// ----- 切换 AC 开关 -----
  async function toggleACSwitch(targetAction, notAfterAt = 0) {
  console.log(`[AC扩展] 准备切换 AC: ${targetAction}`);

  if (targetAction !== 'on') {
    return { success: false, error: 'OFF 操作已禁用；请使用 Power-off after' };
  }

  if (notAfterAt !== 0 && !Number.isSafeInteger(notAfterAt)) {
    return { success: false, error: '自动开启窗口截止时间无效' };
  }

  const cancellationRevision = getAutomaticOnCancellationRevision();

  // 隔离世界只确认页面已渲染，然后把目标状态交给主世界 ensureACState()。
  // 状态预检、单次 click、10 秒等待与递归复查全部由主世界统一负责。
  const switchEl = await waitForSwitch(10000);
  if (cancellationRevision !== getAutomaticOnCancellationRevision()) {
    return { success: false, cancelled: true, error: '请求已被后台取消' };
  }
  if (!switchEl) {
    return { success: false, error: t('contentTimeout') };
  }

  requestMainWorldToggle.cancellationRevision = cancellationRevision;
  let mainWorldResult;
  try {
    mainWorldResult = await requestMainWorldToggle(targetAction, 90000, notAfterAt);
  } finally {
    if (requestMainWorldToggle.cancellationRevision === cancellationRevision) {
      requestMainWorldToggle.cancellationRevision = null;
    }
  }

  if (cancellationRevision !== getAutomaticOnCancellationRevision()) {
    return { success: false, cancelled: true, error: '请求已被后台取消' };
  }

  if (mainWorldResult?.success) {
    console.log('[AC扩展] 主世界切换成功:', mainWorldResult);
    return mainWorldResult;
  }

  // 主世界失败后不在隔离世界接力点击；下一步只交给后台延迟重试。
  console.warn('[AC扩展] 主世界切换未成功，隔离世界不再接力点击（避免双切噪音）:', mainWorldResult ? JSON.stringify(mainWorldResult) : 'null');
  return {
    success: false,
    action: targetAction,
    verified: false,
    via: 'isolated-delegated-to-main',
    mainWorldResult,
    error: mainWorldResult?.error || t('contentRetryExhausted', targetAction)
  };
}

function requestMainWorldResult({
  requestIdPrefix,
  requestEvent,
  resultEvent,
  payload = {},
  timeoutMs,
  timeoutResult
}) {
  return new Promise((resolve) => {
    const requestId = `${requestIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let done = false;

    const cleanup = () => {
      window.removeEventListener(resultEvent, onResult);
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const onResult = (event) => {
      const detail = event.detail || {};
      if (detail.requestId !== requestId) return;
      const { requestId: _requestId, ...result } = detail;
      finish(result);
    };

    window.addEventListener(resultEvent, onResult);
    window.dispatchEvent(new CustomEvent(requestEvent, {
      detail: { requestId, ...payload }
    }));

    setTimeout(() => finish(timeoutResult), timeoutMs);
  });
}

async function requestMainWorldToggle(targetAction, timeoutMs, notAfterAt = 0) {
  const cancellationRevision = Number(requestMainWorldToggle.cancellationRevision);
  return requestMainWorldResult({
    requestIdPrefix: 'ac',
    requestEvent: '__AC_EXTENSION_TOGGLE_AC__',
    resultEvent: '__AC_EXTENSION_TOGGLE_AC_RESULT__',
    payload: {
      action: targetAction,
      ...(notAfterAt !== 0 ? { notAfterAt } : {}),
      ...(Number.isSafeInteger(cancellationRevision) && cancellationRevision >= 0
        ? { cancellationRevision }
        : {})
    },
    timeoutMs,
    timeoutResult: null
  });
}

async function requestMainWorldStatus(timeoutMs) {
  return requestMainWorldResult({
    requestIdPrefix: 'ac-status',
    requestEvent: '__AC_EXTENSION_GET_STATUS__',
    resultEvent: '__AC_EXTENSION_GET_STATUS_RESULT__',
    timeoutMs,
    timeoutResult: { isOn: null, error: '主世界状态读取超时' }
  });
}

// ----- 等待开关元素出现 (带超时) -----
function waitForSwitch(timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    function tryFind() {
      const el = findACSwitch();
      if (el) {
        resolve(el);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(tryFind, 500);
    }
    
    tryFind();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const POWER_OFF_TIMER_MAX_TYPING_ATTEMPTS = 3;
const POWER_OFF_TIMER_WHOLE_VALUE_FALLBACK_STAGES = new Set([
  'type-character'
]);

function normalizePowerOffTimerDiagnosticText(value, maxLength) {
  return String(value ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .replace(/\btabId\b(?:\s*[:=]\s*\S+)?/gi, 'tab')
    .slice(0, maxLength);
}

function boundedPowerOffTimerCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(99, Math.max(0, Math.trunc(numeric)))
    : 0;
}

function boundedPowerOffTimerElapsed(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(120000, Math.max(0, Math.trunc(numeric)))
    : 0;
}

function createPowerOffTimerFailure(error, details = {}) {
  return {
    success: false,
    error: normalizePowerOffTimerDiagnosticText(error, 240) || '页面定时器设置失败',
    failureStage: normalizePowerOffTimerDiagnosticText(details.failureStage, 48) || 'unknown',
    attempt: Math.min(
      POWER_OFF_TIMER_MAX_TYPING_ATTEMPTS,
      boundedPowerOffTimerCount(details.attempt)
    ),
    expectedValue: normalizePowerOffTimerDiagnosticText(details.expectedValue, 16),
    observedValue: normalizePowerOffTimerDiagnosticText(details.observedValue, 16),
    observedTitle: normalizePowerOffTimerDiagnosticText(details.observedTitle, 16),
    inputReplacementCount: boundedPowerOffTimerCount(details.inputReplacementCount),
    controlCount: boundedPowerOffTimerCount(details.controlCount),
    visibleDropdownCount: boundedPowerOffTimerCount(details.visibleDropdownCount),
    elapsedMs: boundedPowerOffTimerElapsed(details.elapsedMs)
  };
}

function getPowerOffTimerObservation(state = findPowerOffTimerControlState()) {
  const input = state.control?.input || null;
  return {
    observedValue: (input?.value || '').trim(),
    observedTitle: (input?.getAttribute?.('title') || '').trim(),
    controlCount: state.controlCount,
    visibleDropdownCount: findVisiblePickerDropdowns().length
  };
}

function createPowerOffTimerTypingFailure(failureStage, details = {}) {
  const state = details.state || findPowerOffTimerControlState();
  return {
    success: false,
    retryable: details.retryable !== false,
    failureStage,
    inputReplacementCount: details.inputReplacementCount || 0,
    ...getPowerOffTimerObservation(state),
    ...(details.observedValue === undefined ? {} : { observedValue: details.observedValue }),
    ...(details.observedTitle === undefined ? {} : { observedTitle: details.observedTitle }),
    ...(details.visibleDropdownCount === undefined
      ? {}
      : { visibleDropdownCount: details.visibleDropdownCount })
  };
}

// 页面重渲染（session 重登录 / AC 状态切换 / billing 刷新）会让「Power-off after」
// picker 短暂消失或重挂载，750ms 骑不过去；延长稳定等待到 5s，
// 避免在页面尚未稳定时以「stabilize-control」过早放弃自动开启。
async function waitForStablePowerOffTimerControl(
  timeoutMs = 5000,
  pollIntervalMs = 50
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 1);
  let previousControl = null;
  let lastState = findPowerOffTimerControlState();

  while (Date.now() <= deadline) {
    const state = findPowerOffTimerControlState();
    if (state.controlCount > 1) {
      return createPowerOffTimerTypingFailure('locate-control', {
        state,
        retryable: false
      });
    }
    if (state.control
        && previousControl?.input === state.control.input
        && previousControl?.picker === state.control.picker) {
      return { success: true, ...state };
    }
    previousControl = state.control;
    lastState = state;
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  return createPowerOffTimerTypingFailure('stabilize-control', { state: lastState });
}

function resolveLivePowerOffTimerControl(
  previousInput,
  expectedPrefix,
  diagnostics,
  failureStage
) {
  const state = findPowerOffTimerControlState();
  if (!state.control) {
    return createPowerOffTimerTypingFailure(failureStage, {
      state,
      inputReplacementCount: diagnostics.inputReplacementCount,
      retryable: state.controlCount <= 1
    });
  }

  if (previousInput && state.control.input !== previousInput) {
    diagnostics.inputReplacementCount += 1;
  }
  const observedValue = String(state.control.input.value || '');
  if (expectedPrefix !== null && observedValue !== expectedPrefix) {
    return createPowerOffTimerTypingFailure(failureStage, {
      state,
      observedValue,
      inputReplacementCount: diagnostics.inputReplacementCount
    });
  }
  return { success: true, ...state };
}

// AntD 确认后 React 可能短暂同时保留旧树与新树。最终值必须由同一个
// 唯一语义 live input 连续承载 500ms，且本次新打开的 dropdown 已关闭。
// 提交成功的硬信号是 value 与 title 同时等于期望 HH:MM：原生 value setter
// 只写 value、不写 title；若 title 仍为空说明 AntD 的 onOk 未触发、服务器未持久化，
// 此时本地 DOM 看似已写入，但新鲜页读回仍为空，必须在本地确认阶段就判为未提交。
function isPowerOffTimerConfirmationAccepted({
  input,
  rawValue,
  rawTitle,
  expectedValue,
  allowLocalOnly = false,
  ariaExpanded,
  visibleDropdowns,
  visibleBefore,
  openedDropdown
}) {
  const dropdownClosed = ariaExpanded !== 'true'
    && (!openedDropdown || !visibleDropdowns.includes(openedDropdown))
    && visibleDropdowns.every(dropdown => visibleBefore.has(dropdown));
  return !!input
    && rawValue === expectedValue
    && (rawTitle === expectedValue || (allowLocalOnly && rawTitle === ''))
    && dropdownClosed;
}

async function waitForConfirmedPowerOffTimerInput(
  value,
  {
    timeoutMs = 3000,
    pollIntervalMs = 50,
    stableWindowMs = 500,
    allowLocalOnly = false,
    visibleBefore = new Set(),
    openedDropdown = null,
    inputReplacementCount = 0,
    lastInput = null
  } = {}
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 1);
  const requiredStableMs = Math.max(0, Number(stableWindowMs) || 0);
  let stableInput = null;
  let stableValue = '';
  let stableTitle = '';
  let stableAriaExpanded = '';
  let stableVisibleDropdowns = [];
  let stableSince = 0;
  let previousInput = lastInput;
  let replacements = inputReplacementCount;
  let lastState = findPowerOffTimerControlState();
  let lastValue = '';
  let lastTitle = '';
  let lastVisibleDropdownCount = findVisiblePickerDropdowns().length;

  while (Date.now() <= deadline) {
    const state = findPowerOffTimerControlState();
    const input = state.control?.input || null;
    if (previousInput && input && previousInput !== input) replacements += 1;
    previousInput = input;
    const rawValue = (input?.value || '').trim();
    const rawTitle = (input?.getAttribute?.('title') || '').trim();
    const visibleDropdowns = findVisiblePickerDropdowns();
    lastState = state;
    lastValue = rawValue;
    lastTitle = rawTitle;
    lastVisibleDropdownCount = visibleDropdowns.length;
    if (state.controlCount === 1 && isPowerOffTimerConfirmationAccepted({
      input,
      rawValue,
      rawTitle,
      expectedValue: value,
      allowLocalOnly,
      ariaExpanded: input?.getAttribute?.('aria-expanded'),
      visibleDropdowns,
      visibleBefore,
      openedDropdown
    })) {
      const ariaExpanded = input?.getAttribute?.('aria-expanded') || '';
      const sameVisibleDropdowns = visibleDropdowns.length
        === stableVisibleDropdowns.length
        && visibleDropdowns.every(
          (dropdown, index) => dropdown === stableVisibleDropdowns[index]
        );
      if (input !== stableInput
          || rawValue !== stableValue
          || rawTitle !== stableTitle
          || ariaExpanded !== stableAriaExpanded
          || !sameVisibleDropdowns) {
        stableInput = input;
        stableValue = rawValue;
        stableTitle = rawTitle;
        stableAriaExpanded = ariaExpanded;
        stableVisibleDropdowns = [...visibleDropdowns];
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= requiredStableMs) {
        return {
          success: true,
          input,
          inputReplacementCount: replacements,
          visibleBefore,
          openedDropdown,
          ...getPowerOffTimerObservation(state)
        };
      }
    } else {
      stableInput = null;
      stableValue = '';
      stableTitle = '';
      stableAriaExpanded = '';
      stableVisibleDropdowns = [];
      stableSince = 0;
    }

    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  return createPowerOffTimerTypingFailure('confirm-stable', {
    state: lastState,
    observedValue: lastValue,
    observedTitle: lastTitle,
    visibleDropdownCount: lastVisibleDropdownCount,
    inputReplacementCount: replacements,
    retryable: lastState.controlCount <= 1
  });
}

function setNativeInputValue(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
}

async function typeTimeIntoPickerInput(input, value, allowLocalOnly = false) {
  const initialState = findPowerOffTimerControlState();
  if (!initialState.control || initialState.control.input !== input) {
    return createPowerOffTimerTypingFailure('locate-control', {
      state: initialState,
      retryable: false
    });
  }
  // 受控 AntD picker 单次模拟输入可能被 React 中途回退；有限重试提高可靠性。
  let totalReplacementCount = 0;
  let lastFailure = null;
  if (closePowerOffPickerDropdowns(input) > 0) {
    await sleep(100);
  }
  const visibleDropdownsBefore = new Set(findVisiblePickerDropdowns());

  for (let attempt = 1; attempt <= POWER_OFF_TIMER_MAX_TYPING_ATTEMPTS; attempt++) {
    const stableControl = await waitForStablePowerOffTimerControl();
    if (!stableControl.success) {
      lastFailure = {
        ...stableControl,
        attempt,
        inputReplacementCount: totalReplacementCount
      };
      if (stableControl.retryable === false) break;
      continue;
    }
    try {
      const useWholeValueFallback = attempt === 2
        && POWER_OFF_TIMER_WHOLE_VALUE_FALLBACK_STAGES.has(lastFailure?.failureStage);
      const result = await typeOnceIntoPickerInput(
        stableControl.control.picker,
        stableControl.control.input,
        value,
        visibleDropdownsBefore,
        { wholeValue: useWholeValueFallback, allowLocalOnly }
      );
      totalReplacementCount += result.inputReplacementCount || 0;
      if (result.success) {
        return {
          ...result,
          attempt,
          inputReplacementCount: totalReplacementCount
        };
      }
      lastFailure = {
        ...result,
        attempt,
        inputReplacementCount: totalReplacementCount
      };
      console.warn(`[AC扩展] 页面定时器输入第 ${attempt} 次未接受 ${value}`);
      if (result.retryable === false) break;
    } catch (e) {
      lastFailure = {
        ...createPowerOffTimerTypingFailure('typing-exception', {
          inputReplacementCount: totalReplacementCount
        }),
        attempt
      };
      console.warn(`[AC扩展] 页面定时器输入第 ${attempt} 次异常:`, e?.message || e);
    }
  }

  return lastFailure || createPowerOffTimerTypingFailure('typing-exhausted', {
    inputReplacementCount: totalReplacementCount
  });
}

// 单次模拟手动输入。每个 input 事件后重新从 Power-off after 语义定位
// 当前 live input；保留已接受前缀的节点替换可继续，回滚或歧义交给外层重试。
async function typeOnceIntoPickerInput(
  picker,
  input,
  value,
  visibleDropdownsBefore,
  { wholeValue = false, allowLocalOnly = false } = {}
) {
  const initialState = findPowerOffTimerControlState();
  if (!initialState.control
      || initialState.control.input !== input
      || initialState.control.picker !== picker) {
    return createPowerOffTimerTypingFailure('locate-control', {
      state: initialState,
      retryable: false
    });
  }

  const operationVisibleDropdownsBefore = visibleDropdownsBefore instanceof Set
    ? visibleDropdownsBefore
    : new Set(findVisiblePickerDropdowns());
  const diagnostics = { inputReplacementCount: 0 };
  const readonlyStates = new Map();
  const makeWritable = (liveInput) => {
    if (!readonlyStates.has(liveInput)) {
      readonlyStates.set(liveInput, liveInput.hasAttribute('readonly'));
    }
    liveInput.removeAttribute('readonly');
  };
  let currentControl = initialState.control;

  try {
    makeWritable(currentControl.input);
    if (currentControl.input.getAttribute('aria-expanded') !== 'true') {
      // AntD 的下拉层由 mousedown 打开；原生 click() 只触发 click 不触发 mousedown，
      // 对 readonly 输入框打不开下拉层。先派发 mousedown/mouseup 再 focus/click。
      currentControl.input.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true
      }));
      currentControl.input.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true
      }));
      currentControl.input.focus();
      currentControl.input.click();
      await sleep(100);
    } else {
      currentControl.input.focus();
    }

    let live = resolveLivePowerOffTimerControl(
      currentControl.input,
      null,
      diagnostics,
      'open-picker'
    );
    if (!live.success) return live;
    currentControl = live.control;
    makeWritable(currentControl.input);
    currentControl.input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true
    }));
    live = resolveLivePowerOffTimerControl(
      currentControl.input,
      null,
      diagnostics,
      'clear-input'
    );
    if (!live.success) return live;
    currentControl = live.control;
    makeWritable(currentControl.input);
    setNativeInputValue(currentControl.input, '');
    currentControl.input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
      data: null
    }));
    await sleep(50);
    live = resolveLivePowerOffTimerControl(
      currentControl.input,
      '',
      diagnostics,
      'clear-input'
    );
    if (!live.success) return live;
    currentControl = live.control;

    if (wholeValue) {
      live = resolveLivePowerOffTimerControl(
        currentControl.input,
        '',
        diagnostics,
        'type-character'
      );
      if (!live.success) return live;
      currentControl = live.control;
      makeWritable(currentControl.input);
      setNativeInputValue(currentControl.input, value);
      currentControl.input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value
      }));
      await sleep(50);
      live = resolveLivePowerOffTimerControl(
        currentControl.input,
        value,
        diagnostics,
        'type-character'
      );
      if (!live.success) return live;
      currentControl = live.control;
    } else {
      let acceptedPrefix = '';
      for (const char of value) {
        live = resolveLivePowerOffTimerControl(
          currentControl.input,
          acceptedPrefix,
          diagnostics,
          'type-character'
        );
        if (!live.success) return live;
        currentControl = live.control;
        makeWritable(currentControl.input);
        currentControl.input.dispatchEvent(new KeyboardEvent('keydown', {
          key: char,
          bubbles: true
        }));
        live = resolveLivePowerOffTimerControl(
          currentControl.input,
          acceptedPrefix,
          diagnostics,
          'type-character'
        );
        if (!live.success) return live;
        currentControl = live.control;
        makeWritable(currentControl.input);
        const nextPrefix = acceptedPrefix + char;
        setNativeInputValue(currentControl.input, nextPrefix);
        currentControl.input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: char
        }));
        await sleep(30);
        live = resolveLivePowerOffTimerControl(
          currentControl.input,
          nextPrefix,
          diagnostics,
          'type-character'
        );
        if (!live.success) return live;
        currentControl = live.control;
        currentControl.input.dispatchEvent(new KeyboardEvent('keyup', {
          key: char,
          bubbles: true
        }));
        acceptedPrefix = nextPrefix;
      }
    }

    live = resolveLivePowerOffTimerControl(
      currentControl.input,
      value,
      diagnostics,
      'change'
    );
    if (!live.success) return live;
    currentControl = live.control;
    currentControl.input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(30);
    live = resolveLivePowerOffTimerControl(
      currentControl.input,
      value,
      diagnostics,
      'change'
    );
    if (!live.success) return live;
    currentControl = live.control;
    // 不再派发 Enter：rc-picker 的 Enter 在「本地输入」阶段就会触发 onOk 提交，
    // 此时 AC 尚未开机，提交会被服务端拒绝并触发整页刷新，导致后续点选单元格/OK
    // 被中断（表现为「输入框未接受时间」）。改为直接点选时刻单元格再点 OK 完成提交。

    // 只读输入框打字不改 rc-picker 内部值，先点选时刻单元格再点 OK，
    // 确保 OK 提交的是目标时刻而非空值（结构未知时返回 false，不影响原链路）。
    clickPowerOffTimeCells(currentControl, operationVisibleDropdownsBefore, value);

    const okResult = clickUniquePowerOffPickerOk(
      currentControl,
      operationVisibleDropdownsBefore
    );
    if (!okResult.accepted) {
      return createPowerOffTimerTypingFailure('select-ok', {
        state: findPowerOffTimerControlState(),
        inputReplacementCount: diagnostics.inputReplacementCount,
        visibleDropdownCount: okResult.visibleDropdownCount,
        retryable: false
      });
    }
    if (okResult.clicked) await sleep(300);

    return waitForConfirmedPowerOffTimerInput(value, {
      timeoutMs: 3000,
      pollIntervalMs: 50,
      stableWindowMs: 500,
      allowLocalOnly,
      visibleBefore: operationVisibleDropdownsBefore,
      openedDropdown: okResult.openedDropdown,
      inputReplacementCount: diagnostics.inputReplacementCount,
      lastInput: currentControl.input
    });
  } finally {
    for (const [changedInput, hadReadonly] of readonlyStates) {
      if (hadReadonly) changedInput.setAttribute('readonly', '');
    }
  }
}

// ----- 查找 AC 开关 DOM 元素 -----
function findACSwitch() {
  const antSwitch = findAntACSwitch();
  if (antSwitch) return antSwitch;

  // 查找包含 "Air Conditioning" 文本的区域，然后找其中的 toggle checkbox
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    if (el.children.length === 0 && el.textContent?.trim() === 'Air Conditioning Status') {
      // 向上找包含 toggle checkbox 的父容器
      let container = el.parentElement;
      for (let i = 0; i < 10 && container; i++) {
        const toggle = container.querySelector('.ui.toggle.checkbox');
        if (toggle) return toggle;
        container = container.parentElement;
      }
    }
  }
  
  // 备用: 直接找页面上唯一的 toggle checkbox
  const toggles = document.querySelectorAll('.ui.toggle.checkbox');
  if (toggles.length === 1) return toggles[0];
  
  // 如果有多个，找包含 ON/OFF 文本的那个
  for (const toggle of toggles) {
    const text = toggle.textContent || '';
    if ((text.includes('ON') || text.includes('OFF')) && toggle.querySelector('input[type="checkbox"]')) {
      return toggle;
    }
  }
  
  return toggles.length > 0 ? toggles[0] : null;
}

function findAntACSwitch() {
  const statusLabels = Array.from(document.querySelectorAll('small'));
  for (const small of statusLabels) {
    const text = (small.textContent || '').trim();
    if (text === 'Air Conditioning Status' || text === 'AirConditioning Status') {
      let container = small.closest('[class*="row"]') || small.closest('div[style*="flex"]') || small.parentElement?.parentElement;
      for (let i = 0; i < 8 && container; i++) {
        const antSwitch = container.querySelector('button.ant-switch[role="switch"]');
        if (antSwitch) return antSwitch;
        container = container.parentElement;
      }
    }
  }

  const antSwitches = document.querySelectorAll('button.ant-switch[role="switch"]');
  if (antSwitches.length === 1) return antSwitches[0];
  if (antSwitches.length > 1) {
    for (const sw of antSwitches) {
      const parentText = (sw.closest('[class*="row"]') || sw.parentElement?.parentElement || sw.parentElement || sw)?.textContent || '';
      if (parentText.includes('Air Conditioning') || parentText.includes('AC')) {
        return sw;
      }
    }
    return antSwitches[0];
  }

  return null;
}

// ----- 设置页面自带的定时关闭（作为保险）-----
async function setPagePowerOffTimer(
  totalMinutes,
  requestedTargetAt = 0,
  allowLocalOnly = false
) {
  console.log(`[AC扩展] 尝试设置页面定时器: ${totalMinutes} 分钟`);

  const startedAt = Date.now();
  let expectedValue = '';
  try {
    const {
      requestedMinutes,
      actualDelayMinutes,
      targetAt,
      crossesMidnight,
      hours,
      minutes: mins,
      value
    } = computePageTimerTarget(totalMinutes, Date.now(), requestedTargetAt);
    expectedValue = value;

    // 页面可能正处于重渲染（session 重登录 / AC 状态切换），此时「Power-off after」
    // 区块会短暂消失（附近只剩 Power Consumption）。先短等待重试定位，再判定失败。
    let initialState = findPowerOffTimerControlState();
    if (!initialState.control && initialState.controlCount === 0) {
      const locateDeadline = Date.now() + 4000;
      while (!initialState.control && Date.now() < locateDeadline) {
        await sleep(200);
        initialState = findPowerOffTimerControlState();
      }
    }
    if (!initialState.control) {
      const labelHints = collectPowerOffTimerLabelHints();
      return createPowerOffTimerFailure(
        initialState.controlCount > 1
          ? 'Power-off after 控件无法唯一关联'
          : `${t('contentNoInput')}${labelHints ? `；附近标签: ${labelHints}` : ''}`,
        {
          failureStage: 'locate-control',
          expectedValue,
          ...getPowerOffTimerObservation(initialState),
          elapsedMs: Date.now() - startedAt
        }
      );
    }

    console.log(`[AC扩展] 模拟手动输入页面关机时间: ${value} (${requestedMinutes} 分钟后${crossesMidnight ? '，跨午夜' : ''})`);

    const typed = await typeTimeIntoPickerInput(
      initialState.control.input,
      value,
      allowLocalOnly
    );
    if (!typed.success) {
      return createPowerOffTimerFailure(
        t('contentInputRejected', String(value)),
        {
          ...typed,
          expectedValue,
          elapsedMs: Date.now() - startedAt
        }
      );
    }

    const finalState = findPowerOffTimerControlState();
    if (!finalState.control || finalState.control.input !== typed.input) {
      return createPowerOffTimerFailure(
        'Power-off after 控件在最终确认后不再唯一',
        {
          failureStage: 'final-control',
          attempt: typed.attempt,
          expectedValue,
          inputReplacementCount: typed.inputReplacementCount,
          ...getPowerOffTimerObservation(finalState),
          elapsedMs: Date.now() - startedAt
        }
      );
    }
    const confirmedInput = finalState.control.input;
    const confirmedRawValue = (confirmedInput.value || '').trim();
    const confirmedTitle = (confirmedInput.getAttribute('title') || '').trim();
    const finalVisibleDropdowns = findVisiblePickerDropdowns();
    if (!isPowerOffTimerConfirmationAccepted({
      input: confirmedInput,
      rawValue: confirmedRawValue,
      rawTitle: confirmedTitle,
      expectedValue,
      allowLocalOnly,
      ariaExpanded: confirmedInput.getAttribute('aria-expanded'),
      visibleDropdowns: finalVisibleDropdowns,
      visibleBefore: typed.visibleBefore instanceof Set ? typed.visibleBefore : new Set(),
      openedDropdown: typed.openedDropdown || null
    })) {
      return createPowerOffTimerFailure('页面定时器最终确认失效', {
        failureStage: 'final-confirmation',
        attempt: typed.attempt,
        expectedValue,
        observedValue: confirmedRawValue,
        observedTitle: confirmedTitle,
        inputReplacementCount: typed.inputReplacementCount,
        controlCount: finalState.controlCount,
        visibleDropdownCount: finalVisibleDropdowns.length,
        elapsedMs: Date.now() - startedAt
      });
    }
    const confirmedValue = confirmedRawValue || confirmedTitle;
    return {
      success: true,
      hours,
      minutes: mins,
      requestedMinutes,
      actualDelayMinutes,
      targetAt,
      crossesMidnight,
      value: confirmedValue,
      title: confirmedTitle,
      locallyAccepted: allowLocalOnly && confirmedTitle !== expectedValue
    };
  } catch (e) {
    return createPowerOffTimerFailure(expectedValue ? '页面定时器设置异常' : String(e), {
      failureStage: expectedValue ? 'exception' : 'compute-target',
      expectedValue,
      ...getPowerOffTimerObservation(),
      elapsedMs: Date.now() - startedAt
    });
  }
}

// 提取（Fowler Extract Function）：页面关机定时器目标时刻的纯计算（分钟数 → HH:MM 与跨午夜判断）。
function computePageTimerTarget(totalMinutes, nowMs = Date.now(), requestedTargetAt = 0) {
  const numericMinutes = Number(totalMinutes);
  const requestedMinutes = Number.isFinite(numericMinutes) && numericMinutes > 0
    ? numericMinutes
    : 1;
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const absoluteTargetAt = requestedTargetAt;
  const hasExplicitAbsoluteTarget = requestedTargetAt !== 0;
  const hasValidAbsoluteTarget = Number.isSafeInteger(absoluteTargetAt)
    && absoluteTargetAt > safeNowMs
    && absoluteTargetAt % 60000 === 0;
  if (hasExplicitAbsoluteTarget && !hasValidAbsoluteTarget) {
    throw new Error('显式绝对目标时间无效、已过期或未对齐整分钟');
  }
  const targetAt = hasValidAbsoluteTarget
    ? absoluteTargetAt
    : Math.ceil((safeNowMs + requestedMinutes * 60000) / 60000) * 60000;
  const now = new Date(safeNowMs);
  const target = new Date(targetAt);
  const crossesMidnight = target.toDateString() !== now.toDateString();
  const hours = target.getHours();
  const mins = target.getMinutes();
  const value = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  return {
    requestedMinutes,
    actualDelayMinutes: (targetAt - safeNowMs) / 60000,
    targetAt,
    crossesMidnight,
    hours,
    minutes: mins,
    value
  };
}

// 找到 "Power-off after" 旁的定时器输入框
function findPowerOffTimerInput() {
  return findPowerOffTimerControlState().control?.input || null;
}

function isPowerOffAfterLabel(text) {
  return /^power[\s-]*off\s+after\b/i.test(String(text || '').trim());
}

// 诊断辅助：定位失败时，回传页面实际存在、且与关机定时器语义相关的短标签文本，
// 用于识别 UST 页面改版后的真实标签文案（有界 + 只保留 off/after/power/time 等关键词）。
function collectPowerOffTimerLabelHints(maxCount = 6) {
  return Array.from(document.querySelectorAll(
    'small, label, p, h1, h2, h3, h4, h5, h6, div, span'
  ))
    .filter(el => el.children.length === 0)
    .map(el => String(el.textContent || '').trim())
    .filter(text => text.length > 0 && text.length <= 60
      && /off|after|power|time|select|shut|turn|schedule/i.test(text))
    .slice(0, maxCount)
    .join(' | ');
}

function hasExplicitPowerOffTimerAssociation(label, picker, input) {
  const labelId = String(label.id || label.getAttribute?.('id') || '');
  const inputId = String(input.id || input.getAttribute?.('id') || '');
  const labelFor = String(label.getAttribute?.('for') || '');
  if (inputId && labelFor === inputId) return true;
  if (!labelId) return false;
  return [picker, input].some(element => (
    ['aria-labelledby', 'aria-describedby'].some(attribute => (
      String(element.getAttribute?.(attribute) || '').split(/\s+/).includes(labelId)
    ))
  ));
}

// 兜底定位：UST 页面改版后 "Power-off after" 标签文案可能变化，
// 但输入框 placeholder="Select time" 长期稳定，据此唯一关联输入框。
function findPowerOffTimerInputByPlaceholder() {
  const inputs = Array.from(document.querySelectorAll('.ant-picker input'))
    .filter(input => String(input.type || '').toLowerCase() !== 'hidden')
    .filter(input => input.isConnected !== false)
    .filter(input => /^select\s+time$/i.test(
      String(input.getAttribute?.('placeholder') || '').trim()
    ));
  return inputs.length === 1 ? inputs[0] : null;
}

function findPowerOffTimerControlState() {
  const MAX_IMPLICIT_ASSOCIATION_DEPTH = 4;
  const labels = Array.from(document.querySelectorAll('small, label, div, span'))
    .filter(label => label.children.length === 0 && isPowerOffAfterLabel(label.textContent));
  const controls = new Map();

  for (const label of labels) {
    let container = label.parentElement;
    for (let depth = 0; depth < 8 && container; depth++) {
      const pickers = Array.from(container.querySelectorAll('.ant-picker'));
      if (pickers.length === 0) {
        container = container.parentElement;
        continue;
      }
      const candidates = pickers
        .map((picker) => {
          const inputs = Array.from(picker.querySelectorAll('input'))
            .filter(input => String(input.type || '').toLowerCase() !== 'hidden')
            .filter(input => input.isConnected !== false);
          const input = inputs.length === 1 ? inputs[0] : null;
          const associated = input && (
            depth <= MAX_IMPLICIT_ASSOCIATION_DEPTH
            || hasExplicitPowerOffTimerAssociation(label, picker, input)
          );
          return associated
            ? { label, container, picker, input: inputs[0] }
            : null;
        })
        .filter(Boolean);
      for (const candidate of candidates) controls.set(candidate.input, candidate);
      break;
    }
  }

  // 兜底：标签语义匹配失败时，回退到 placeholder="Select time" 的输入框。
  if (controls.size === 0) {
    const fallbackInput = findPowerOffTimerInputByPlaceholder();
    if (fallbackInput) {
      const picker = typeof fallbackInput.closest === 'function'
        ? fallbackInput.closest('.ant-picker')
        : null;
      controls.set(fallbackInput, {
        label: null,
        container: picker?.parentElement || null,
        picker,
        input: fallbackInput
      });
    }
  }

  return {
    control: controls.size === 1 ? controls.values().next().value : null,
    controlCount: controls.size
  };
}

function findVisiblePickerDropdowns() {
  return Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter((dropdown) => {
    const cls = String(dropdown.className || '');
    const style = String(dropdown.getAttribute?.('style') || '');
    return !dropdown.hidden
      && dropdown.getAttribute?.('aria-hidden') !== 'true'
      && !cls.includes('ant-picker-dropdown-hidden')
      && !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
  });
}

// 关闭上次尝试遗留的下拉层（rc-picker 通过 Escape 关闭），
// 避免遗留 dropdown 与本次新打开的下拉层叠加，被误判为「多个可见 OK」而 select-ok 失败。
function closePowerOffPickerDropdowns(input) {
  if (!input || typeof input.dispatchEvent !== 'function') return 0;
  const visible = findVisiblePickerDropdowns();
  if (visible.length === 0) return 0;
  try {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
  } catch (_) {
    return 0;
  }
  return visible.length;
}

function resolvePowerOffPickerDropdown(control, visibleBefore) {
  const visible = findVisiblePickerDropdowns();
  const newlyVisible = visible.filter(dropdown => !visibleBefore.has(dropdown));
  if (newlyVisible.length > 1) {
    return { dropdown: null, openedDropdown: null, ambiguous: true, visible };
  }

  const relationIds = new Set();
  for (const element of [control.input, control.picker]) {
    for (const attribute of ['aria-controls', 'aria-owns']) {
      String(element.getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean)
        .forEach(id => relationIds.add(id));
    }
  }
  const linked = Array.from(relationIds)
    .map(id => document.getElementById?.(id))
    .filter(element => element?.matches?.('.ant-picker-dropdown'))
    .filter(element => visible.includes(element));
  if (linked.length > 1
      || (linked.length === 1
        && newlyVisible.length === 1
        && linked[0] !== newlyVisible[0])) {
    return { dropdown: null, openedDropdown: null, ambiguous: true, visible };
  }

  let dropdown = linked[0] || newlyVisible[0] || null;
  if (!dropdown && visible.length > 0) {
    return { dropdown: null, openedDropdown: null, ambiguous: true, visible };
  }
  return {
    dropdown,
    openedDropdown: dropdown && !visibleBefore.has(dropdown) ? dropdown : null,
    ambiguous: false,
    visible
  };
}

// 只读 picker 下打字不会更新 rc-picker 内部值，OK 提交的仍是空值；
// 正确做法是像真实用户一样在下拉层点选时刻单元格（小时 + 分钟），再点 OK。
// 结构未知时安全返回 false，不抛错、不猜测。
function clickPowerOffTimeCells(control, visibleBefore, value) {
  const resolved = resolvePowerOffPickerDropdown(control, visibleBefore);
  if (resolved.ambiguous || !resolved.dropdown) return false;
  const parts = String(value || '').split(':');
  const hours = String(parts[0] || '').trim();
  const minutes = String(parts[1] || '').trim();
  if (!/^\d{1,2}$/.test(hours) || !/^\d{1,2}$/.test(minutes)) return false;
  const columns = Array.from(
    resolved.dropdown.querySelectorAll('.ant-picker-time-panel-column')
  );
  if (columns.length < 2) return false;
  const findCell = (column, text) => Array.from(column.querySelectorAll('li')).find(
    cell => {
      const cellText = String(cell.textContent || '').trim();
      return cellText === text || cellText === String(Number(text));
    }
  );
  const hourCell = findCell(columns[0], hours);
  const minuteCell = findCell(columns[1], minutes);
  if (!hourCell || !minuteCell) return false;
  hourCell.click();
  minuteCell.click();
  return true;
}

function clickUniquePowerOffPickerOk(control, visibleBefore) {
  const resolved = resolvePowerOffPickerDropdown(control, visibleBefore);
  if (resolved.ambiguous) {
    console.warn('[AC扩展] Power-off after 下拉层无法唯一关联，拒绝猜测 OK');
    return {
      accepted: false,
      clicked: false,
      openedDropdown: null,
      visibleDropdownCount: resolved.visible.length
    };
  }
  if (!resolved.dropdown) {
    return {
      accepted: true,
      clicked: false,
      openedDropdown: null,
      visibleDropdownCount: resolved.visible.length
    };
  }

  const visibleEnabledButtons = resolved.visible.flatMap(dropdown => Array.from(
    dropdown.querySelectorAll('.ant-picker-ok button:not([disabled])')
  ).filter(button => button.disabled !== true));
  if (visibleEnabledButtons.length > 1) {
    console.warn('[AC扩展] 可见下拉层有多个 enabled OK，拒绝猜测');
    return {
      accepted: false,
      clicked: false,
      openedDropdown: resolved.openedDropdown,
      visibleDropdownCount: resolved.visible.length
    };
  }

  const buttons = Array.from(
    resolved.dropdown.querySelectorAll('.ant-picker-ok button:not([disabled])')
  ).filter(button => button.disabled !== true);
  if (buttons.length > 1) {
    console.warn('[AC扩展] Power-off after 下拉层有多个 enabled OK，拒绝猜测');
    return {
      accepted: false,
      clicked: false,
      openedDropdown: resolved.openedDropdown,
      visibleDropdownCount: resolved.visible.length
    };
  }
  if (buttons.length === 1) buttons[0].click();
  return {
    accepted: true,
    clicked: buttons.length === 1,
    openedDropdown: resolved.openedDropdown,
    visibleDropdownCount: resolved.visible.length
  };
}

// ----- v0.5.10: 读取页面已设置的 "Power-off after" 定时器值（跨设备主同步通道） -----
// 与 setPagePowerOffTimer（写）互补——读 picker 当前的 HH:MM 值，
// 供 background.js 跨设备 phase 校验（见 sync-helpers.js computePageTimerAdoption）。
// 只读 DOM，不计算时戳——纯函数 parsePageTimerValue 在 sync-helpers.js 负责解析。
function getPagePowerOffTimer() {
  const pickerInput = findPowerOffTimerInput();
  if (!pickerInput) {
    return { found: false, value: null };
  }
  // 实测页面在已设定时会同时把 HH:MM 写到 value 和 title；关机后两者为空。
  // value 为主，title 仅作刷新后读取时的兼容回退，避免 AntD 属性更新时序误判。
  const value = (pickerInput.value || '').trim();
  const title = (pickerInput.getAttribute('title') || '').trim();
  const effectiveValue = value || title;
  if (!/^\d{2}:\d{2}$/.test(effectiveValue)) {
    // picker 有 DOM 但值空/格式不认——可能是空选或未设
    return { found: true, value: effectiveValue || null, title: title || null };
  }
  return { found: true, value: effectiveValue, title: title || null };
}

})(); // end 幂等守卫 IIFE
