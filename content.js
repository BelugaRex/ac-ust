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
    window.dispatchEvent(new CustomEvent('__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'));
    sendResponse({ success: true, cancelled: true });
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
    setPagePowerOffTimer(msg.minutes, msg.targetAt).then(result => sendResponse(result));
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
  const switchControl = findACSwitch();
  if (!switchControl) return { isOn: null, error: '未唯一找到 AC 开关元素' };
  const antSwitch = switchControl.matches?.('button.ant-switch[role="switch"]')
    ? switchControl
    : null;
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

  return getLegacyACStatus(switchControl);
}

// 基于 DOM 的 disabled 状态判定，而非余额数值：free mode 下余额为 0 也不禁用。
function isAntACSwitchDisabled(sw) {
  if (!sw) return false;
  return sw.disabled === true
    || sw.hasAttribute?.('disabled')
    || sw.getAttribute?.('aria-disabled') === 'true'
    || String(sw.className || '').includes('ant-switch-disabled');
}

// 提取（Fowler Extract Function）：读取已经 AC 语义唯一定位的旧版开关。
function getLegacyACStatus(legacySwitch) {
  if (legacySwitch) return { isOn: !!legacySwitch.checked, source: 'legacy-semantic-switch' };
  return { isOn: null, error: '未找到 AC 开关元素' };
}

async function waitForReadableACStatus(timeoutMs = 750, pollIntervalMs = 50) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 1);
  let status = getACStatus();

  while (typeof status?.isOn !== 'boolean' && Date.now() < deadline) {
    await sleep(interval);
    status = getACStatus();
  }
  return status;
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

  // React 切换受控组件时可能短暂同时保留旧／新开关；只读等待唯一状态恢复，
  // 不刷新页面、不触发点击，持续歧义仍返回 unknown。
  const recoveredStatus = await waitForReadableACStatus();
  if (typeof recoveredStatus?.isOn === 'boolean') {
    return withBalance(mainWorldStatus?.error
      ? { ...recoveredStatus, fallbackError: mainWorldStatus.error, via: 'isolated-retry' }
      : { ...recoveredStatus, via: 'isolated-retry' });
  }

  return withBalance(mainWorldStatus?.error
    ? { ...recoveredStatus, fallbackError: mainWorldStatus.error }
    : recoveredStatus);
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

  // 隔离世界只确认页面已渲染，然后把目标状态交给主世界 ensureACState()。
  // 状态预检、单次 click、页面成功提示与状态复查全部由主世界统一负责。
  const switchEl = await waitForSwitch(10000);
  if (!switchEl) {
    return { success: false, error: t('contentTimeout') };
  }

  const mainWorldResult = await requestMainWorldToggle(targetAction, 90000, notAfterAt);

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
    executionConfirmationMissing:
      mainWorldResult?.executionConfirmationMissing === true,
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
  return requestMainWorldResult({
    requestIdPrefix: 'ac',
    requestEvent: '__AC_EXTENSION_TOGGLE_AC__',
    resultEvent: '__AC_EXTENSION_TOGGLE_AC_RESULT__',
    payload: {
      action: targetAction,
      ...(notAfterAt !== 0 ? { notAfterAt } : {})
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

async function waitForStablePowerOffTimerControl(
  timeoutMs = 750,
  pollIntervalMs = 50
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 1);
  let previousControl = null;

  while (Date.now() <= deadline) {
    const control = findPowerOffTimerControl();
    if (control
        && previousControl?.input === control.input
        && previousControl?.picker === control.picker) {
      return control;
    }
    previousControl = control;
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  return null;
}

// AntD 确认后 React 可能短暂同时保留旧树与新树。只在同一个唯一语义控件
// 连续两次承载目标值时返回；持续歧义、空值或节点继续替换都会超时失败关闭。
async function waitForConfirmedPowerOffTimerInput(
  value,
  timeoutMs = 2000,
  pollIntervalMs = 50
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(pollIntervalMs) || 1);
  let previousInput = null;

  while (Date.now() <= deadline) {
    const input = findPowerOffTimerInput();
    const confirmedValue = input
      ? (input.value || input.getAttribute('title') || '').trim()
      : '';
    if (input && confirmedValue === value) {
      if (input === previousInput) return input;
      previousInput = input;
    } else {
      previousInput = null;
    }

    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  return null;
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

async function typeTimeIntoPickerInput(input, value) {
  const initialControl = findPowerOffTimerControl();
  if (!initialControl || initialControl.input !== input) return false;
  // 受控 AntD picker 单次模拟输入可能被 React 中途回退；有限重试提高可靠性。
  const MAX_TYPING_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_TYPING_ATTEMPTS; attempt++) {
    const control = await waitForStablePowerOffTimerControl();
    if (!control) {
      console.warn(`[AC扩展] 页面定时器输入第 ${attempt} 次等待唯一控件超时`);
      continue;
    }
    const attemptInput = control.input;
    const hadReadonly = attemptInput.hasAttribute('readonly');
    try {
      if (await typeOnceIntoPickerInput(control.picker, attemptInput, value)) {
        return true;
      }
      console.warn(`[AC扩展] 页面定时器输入第 ${attempt} 次未接受 ${value}`);
    } catch (e) {
      console.warn(`[AC扩展] 页面定时器输入第 ${attempt} 次异常:`, e?.message || e);
    } finally {
      if (hadReadonly) attemptInput.setAttribute('readonly', '');
    }
  }

  return false;
}

// 单次模拟手动输入。成功判定同时接受 value 与 title 命中目标 HH:MM：
// 受控 picker 可能只把确认值写到二者之一，避免只读时序差异误报「输入框未接受时间」。
async function typeOnceIntoPickerInput(picker, input, value) {
  const control = findPowerOffTimerControl();
  if (!control || control.input !== input || control.picker !== picker) return false;
  const visibleDropdownsBefore = new Set(findVisiblePickerDropdowns());
  input.removeAttribute('readonly');
  picker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  picker.click();
  input.focus();
  input.click();
  await sleep(100);

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
  setNativeInputValue(input, '');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  await sleep(50);

  for (const char of value) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    setNativeInputValue(input, input.value + char);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await sleep(30);
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  await sleep(300);

  const okResult = clickUniquePowerOffPickerOk(control, visibleDropdownsBefore);
  if (!okResult.accepted) return false;
  if (okResult.clicked) {
    await sleep(300);
  }

  const inputValue = (input.value || '').trim();
  const inputTitle = (input.getAttribute('title') || '').trim();
  return inputValue === value || inputTitle === value;
}

// ----- 查找 AC 开关 DOM 元素 -----
function findACSwitch() {
  return findUniqueACControl(
    'button.ant-switch[role="switch"], .ui.toggle.checkbox input[type="checkbox"]'
  );
}

function findUniqueACControl(selector) {
  const labels = Array.from(document.querySelectorAll('small, label, span, div'))
    .filter(label => label.children.length === 0 && isACStatusLabel(label.textContent));
  const matches = new Set();

  for (const label of labels) {
    let container = label.parentElement;
    for (let depth = 0; depth < 10 && container; depth++) {
      const candidates = Array.from(container.querySelectorAll(selector));
      if (candidates.length === 1) {
        matches.add(candidates[0]);
        break;
      }
      if (candidates.length > 1) break;
      container = container.parentElement;
    }
  }

  return matches.size === 1 ? matches.values().next().value : null;
}

function isACStatusLabel(text) {
  return /^air\s*conditioning\s+status$/i.test(String(text || '').trim());
}

// ----- 设置页面自带的定时关闭（作为保险）-----
async function setPagePowerOffTimer(totalMinutes, requestedTargetAt = 0) {
  console.log(`[AC扩展] 尝试设置页面定时器: ${totalMinutes} 分钟`);

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

    const pickerInput = findPowerOffTimerInput();
    if (!pickerInput) {
      return { success: false, error: t('contentNoInput') };
    }

    console.log(`[AC扩展] 模拟手动输入页面关机时间: ${value} (${requestedMinutes} 分钟后${crossesMidnight ? '，跨午夜' : ''})`);

    const typed = await typeTimeIntoPickerInput(pickerInput, value);
    if (!typed) {
      return { success: false, error: t('contentInputRejected', String(value)) };
    }

    // 受控组件可在确认后用等价新节点承载最终值；等待 DOM 恢复唯一，而非
    // 在 React 双树过渡期间猜选第一个候选或把正常节点替换误判为失败。
    const confirmedInput = await waitForConfirmedPowerOffTimerInput(value);
    if (!confirmedInput) {
      return findPowerOffTimerInput()
        ? { success: false, error: t('contentInputRejected', String(value)) }
        : { success: false, error: 'Power-off after 控件在写入期间发生歧义' };
    }
    const confirmedValue = (confirmedInput.value || confirmedInput.getAttribute('title') || '').trim();
    return {
      success: true,
      hours,
      minutes: mins,
      requestedMinutes,
      actualDelayMinutes,
      targetAt,
      crossesMidnight,
      value: confirmedValue,
      title: (confirmedInput.getAttribute('title') || '').trim()
    };
  } catch (e) {
    return { success: false, error: String(e) };
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
  return findPowerOffTimerControl()?.input || null;
}

function findPowerOffTimerControl() {
  const labels = Array.from(document.querySelectorAll('small, label, div, span'))
    .filter(label => label.children.length === 0 && isPowerOffAfterLabel(label.textContent));
  const controls = new Map();

  for (const label of labels) {
    let container = label.parentElement;
    for (let depth = 0; depth < 8 && container; depth++) {
      const candidates = Array.from(container.querySelectorAll('.ant-picker'))
        .map((picker) => {
          const inputs = Array.from(picker.querySelectorAll('input'))
            .filter(input => String(input.type || '').toLowerCase() !== 'hidden');
          return inputs.length === 1 ? { label, container, picker, input: inputs[0] } : null;
        })
        .filter(Boolean);
      if (candidates.length === 1) {
        controls.set(candidates[0].input, candidates[0]);
        break;
      }
      if (candidates.length > 1) break;
      container = container.parentElement;
    }
  }

  return controls.size === 1 ? controls.values().next().value : null;
}

function isPowerOffAfterLabel(text) {
  return /^power[\s-]*off\s+after\s*:?$/i.test(String(text || '').trim());
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

function resolvePowerOffPickerDropdown(control, visibleBefore) {
  const relationIds = new Set();
  for (const element of [control.input, control.picker]) {
    for (const attribute of ['aria-controls', 'aria-owns']) {
      String(element.getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean)
        .forEach(id => relationIds.add(id));
    }
  }
  const visible = findVisiblePickerDropdowns();
  const linked = Array.from(relationIds)
    .map(id => document.getElementById?.(id))
    .filter(element => element?.matches?.('.ant-picker-dropdown'))
    .filter(element => visible.includes(element));
  if (linked.length > 1) return { dropdown: null, ambiguous: true };
  if (linked.length === 1) return { dropdown: linked[0], ambiguous: false };

  const newlyVisible = visible.filter(dropdown => !visibleBefore.has(dropdown));
  if (newlyVisible.length > 1) return { dropdown: null, ambiguous: true };
  if (newlyVisible.length === 1) return { dropdown: newlyVisible[0], ambiguous: false };

  const pickerOwnsFocus = document.activeElement === control.input
    || control.input.getAttribute?.('aria-expanded') === 'true';
  if (pickerOwnsFocus && visibleBefore.size === 0 && visible.length === 1) {
    return { dropdown: visible[0], ambiguous: false };
  }
  return { dropdown: null, ambiguous: visible.length > 0 };
}

function clickUniquePowerOffPickerOk(control, visibleBefore) {
  const { dropdown, ambiguous } = resolvePowerOffPickerDropdown(control, visibleBefore);
  if (ambiguous) {
    console.warn('[AC扩展] Power-off after 下拉层无法唯一关联，拒绝猜测 OK');
    return { accepted: false, clicked: false };
  }
  if (!dropdown) return { accepted: true, clicked: false };

  const buttons = Array.from(dropdown.querySelectorAll('.ant-picker-ok button:not([disabled])'));
  if (buttons.length > 1) {
    console.warn('[AC扩展] Power-off after 下拉层有多个 OK，拒绝猜测');
    return { accepted: false, clicked: false };
  }
  if (buttons.length === 1) buttons[0].click();
  return { accepted: true, clicked: buttons.length === 1 };
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
