// ============================================================
// Page Script - 注入到网页主环境
// 负责在扩展发起的 AC ON 点击栈内处理页面原生对话框，
// 并在主世界中完成唯一 AC 开关与确认框的语义定位。
// ============================================================

(() => {
  const PAGE_BUILD_TIME = 'dev';
  const PAGE_BUILD_TIME_EPOCH_MS = 0;
  const PAGE_MAIN_LISTENER_ID = `${PAGE_BUILD_TIME_EPOCH_MS || 'dev'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const MAIN_BRIDGE_CHANNEL = `__AC_EXTENSION_${PAGE_BUILD_TIME_EPOCH_MS || 'dev'}`;
  const MAIN_BRIDGE_EVENTS = {
    cancel: `${MAIN_BRIDGE_CHANNEL}_CANCEL_AUTOMATIC_ON__`,
    toggle: `${MAIN_BRIDGE_CHANNEL}_TOGGLE_AC__`,
    toggleResult: `${MAIN_BRIDGE_CHANNEL}_TOGGLE_AC_RESULT__`,
    status: `${MAIN_BRIDGE_CHANNEL}_GET_STATUS__`,
    statusResult: `${MAIN_BRIDGE_CHANNEL}_GET_STATUS_RESULT__`,
    runtime: `${MAIN_BRIDGE_CHANNEL}_GET_RUNTIME__`,
    runtimeResult: `${MAIN_BRIDGE_CHANNEL}_GET_RUNTIME_RESULT__`
  };
  const previousMainBridge = window.__AC_EXTENSION_MAIN_BRIDGE__;
  const previousMainBridgeLease = window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__;
  const mainBridgeLease = previousMainBridgeLease || {
    cancelRevision: 0,
    inFlight: null,
    target: null,
    notAfterAt: 0,
    ownerGeneration: 0,
    blockedUntil: 0,
    uncertainClickOwner: '',
    uncertainClickUntil: 0
  };
  window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__ = mainBridgeLease;
  const legacyBridgeIsolated = window.__AC_EXTENSION_TOGGLE_PATCHED__ === true
    && !previousMainBridge;
  let predecessorMainBridgeDrain = Promise.resolve(null);
  let predecessorMainBridgeUnknown = false;
  try {
    if (typeof previousMainBridge?.cancelAndDrain === 'function') {
      predecessorMainBridgeDrain = Promise.resolve(
        previousMainBridge.cancelAndDrain()
      ).catch(() => null);
      previousMainBridge.dispose?.({ cancel: false });
    } else if (previousMainBridge || legacyBridgeIsolated) {
      predecessorMainBridgeUnknown = true;
      const cancelEvents = new Set(['__AC_EXTENSION_CANCEL_AUTOMATIC_ON__']);
      if (previousMainBridge?.channel) {
        cancelEvents.add(`${previousMainBridge.channel}_CANCEL_AUTOMATIC_ON__`);
      }
      for (const type of cancelEvents) {
        window.dispatchEvent(new CustomEvent(type));
      }
      previousMainBridge?.dispose?.();
    }
  } catch (_) {
    predecessorMainBridgeUnknown = true;
  }
  const mainBridgeOwnerGeneration = (Number(mainBridgeLease.ownerGeneration) || 0) + 1;
  mainBridgeLease.ownerGeneration = mainBridgeOwnerGeneration;
  const mainBridgeListeners = [];
  const addMainBridgeListener = (type, listener) => {
    window.addEventListener(type, listener);
    mainBridgeListeners.push([type, listener]);
  };

  function getMainRuntimeIdentity() {
    return {
      runtimeIdentity: {
        main: {
          buildTime: PAGE_BUILD_TIME,
          buildTimeEpochMs: PAGE_BUILD_TIME_EPOCH_MS,
          listenerId: PAGE_MAIN_LISTENER_ID,
          channel: MAIN_BRIDGE_CHANNEL,
          legacyBridgeIsolated
        }
      }
    };
  }

  // 主世界错误桥接（仅注册一次）：page-confirm 无法调用 chrome.runtime，
  // 只把扩展自身脚本的未捕获异常经 CustomEvent 交给 content.js 回传 SW。
  if (!window.__AC_EXTENSION_ERROR_PATCHED__) {
    window.__AC_EXTENSION_ERROR_PATCHED__ = true;

    function reportPageError(source, message) {
      try {
        window.dispatchEvent(new CustomEvent('__AC_EXTENSION_PAGE_ERROR__', {
          detail: { source, message: String(message) }
        }));
      } catch (_) { /* 桥接失败不阻塞页面 */ }
    }

    function isExtensionCode(filename, stack) {
      return String(filename || '').startsWith('chrome-extension://')
        || String(stack || '').includes('chrome-extension://');
    }

    window.addEventListener('error', (event) => {
      // 只回传扩展自身脚本的异常，避免把 UST 页面自己的报错混进诊断日志。
      if (!isExtensionCode(event?.filename, event?.error?.stack)) return;
      reportPageError('page-confirm-error', event?.error?.message || event?.message || '未知错误');
    });
    window.addEventListener('unhandledrejection', (event) => {
      if (!isExtensionCode('', event?.reason?.stack)) return;
      reportPageError('page-confirm-unhandledrejection', event?.reason?.message || String(event?.reason));
    });
  }

  // 旧版用永久 boolean 阻止重注入。现在保留该标志仅供兼容识别；当前
  // build 使用版本化事件频道和可释放 registry，因此无需刷新页面即可接管。
  window.__AC_EXTENSION_TOGGLE_PATCHED__ = true;

  const MAX_AC_SWITCH_CLICKS = 3;
  const AC_STATE_SETTLE_MS = 10000;
  const AC_ON_SUCCESS_TEXT = 'Execution succeeded';
  const AC_EXECUTION_SUCCESS_TIMEOUT_MS = 15000;
  const HOT_TAKEOVER_CLICK_QUIET_MS = 60_000;
  if (predecessorMainBridgeUnknown) {
    mainBridgeLease.blockedUntil = Math.max(
      Number(mainBridgeLease.blockedUntil) || 0,
      Date.now() + HOT_TAKEOVER_CLICK_QUIET_MS
    );
  }
  let activeAcStateRequest = null;
  let automaticOnCancellationRevision = Number(mainBridgeLease.cancelRevision) || 0;

  const handleAutomaticOnCancel = () => {
    automaticOnCancellationRevision += 1;
    mainBridgeLease.cancelRevision = automaticOnCancellationRevision;
  };
  addMainBridgeListener(MAIN_BRIDGE_EVENTS.cancel, handleAutomaticOnCancel);

  const handleToggleRequest = async (event) => {
    const { requestId, action, notAfterAt = 0 } = event.detail || {};
    if (!requestId || action !== 'on') {
      if (requestId) {
        window.dispatchEvent(new CustomEvent(MAIN_BRIDGE_EVENTS.toggleResult, {
          detail: {
            requestId,
            action,
            success: false,
            verified: false,
            error: 'OFF 操作已禁用；自动关机只允许使用 Power-off after',
            via: 'main-world-ensureACState',
            ...getMainRuntimeIdentity()
          }
        }));
      }
      return;
    }

    let result;
    try {
      await predecessorMainBridgeDrain;
      if (mainBridgeLease.ownerGeneration !== mainBridgeOwnerGeneration) {
        result = {
          success: false,
          verified: false,
          busy: true,
          takeoverPending: true,
          error: '主世界控制已由更新的脚本接管',
          via: 'main-world-ensureACState'
        };
      }
      const takeoverStatus = getACStatusInPageWorld();
      if (!result
          && Number(mainBridgeLease.blockedUntil) > Date.now()
          && takeoverStatus?.isOn !== true) {
        result = {
          success: false,
          verified: false,
          busy: true,
          takeoverPending: true,
          error: '旧主世界 ON 请求已取消，等待下一轮安全重试',
          via: 'main-world-ensureACState'
        };
      } else if (!result) {
        result = await requestACState(true, notAfterAt);
      }
    } catch (error) {
      // ensureACState 异常时也必须回包，否则隔离世界会静默等满超时拿到 null，
      // 并误触发后台的「刷新恢复」链路。这里显式回失败，让上层可诊断。
      result = {
        success: false,
        verified: false,
        error: `主世界切换抛异常: ${error?.message || String(error)}`,
        via: 'main-world-ensureACState'
      };
    }
    window.dispatchEvent(new CustomEvent(MAIN_BRIDGE_EVENTS.toggleResult, {
      detail: { requestId, action, ...result, ...getMainRuntimeIdentity() }
    }));
  };
  addMainBridgeListener(MAIN_BRIDGE_EVENTS.toggle, handleToggleRequest);

  const handleStatusRequest = (event) => {
    const { requestId } = event.detail || {};
    if (!requestId) return;

    const result = getACStatusInPageWorld();
    window.dispatchEvent(new CustomEvent(MAIN_BRIDGE_EVENTS.statusResult, {
      detail: { requestId, ...result, ...getMainRuntimeIdentity() }
    }));
  };
  addMainBridgeListener(MAIN_BRIDGE_EVENTS.status, handleStatusRequest);

  const handleRuntimeRequest = (event) => {
    const { requestId } = event.detail || {};
    if (!requestId) return;
    window.dispatchEvent(new CustomEvent(MAIN_BRIDGE_EVENTS.runtimeResult, {
      detail: { requestId, success: true, ...getMainRuntimeIdentity() }
    }));
  };
  addMainBridgeListener(MAIN_BRIDGE_EVENTS.runtime, handleRuntimeRequest);

  window.__AC_EXTENSION_MAIN_BRIDGE__ = {
    buildTime: PAGE_BUILD_TIME,
    buildTimeEpochMs: PAGE_BUILD_TIME_EPOCH_MS,
    listenerId: PAGE_MAIN_LISTENER_ID,
    channel: MAIN_BRIDGE_CHANNEL,
    cancelAndDrain() {
      handleAutomaticOnCancel();
      const pending = activeAcStateRequest?.promise || mainBridgeLease.inFlight;
      return pending
        ? Promise.resolve(pending).catch(() => null)
        : Promise.resolve(null);
    },
    dispose({ cancel = true } = {}) {
      const drain = cancel
        ? this.cancelAndDrain()
        : Promise.resolve(null);
      for (const [type, listener] of mainBridgeListeners) {
        window.removeEventListener(type, listener);
      }
      mainBridgeListeners.length = 0;
      return drain;
    }
  };

  function getACStatusInPageWorld() {
    const sw = findACSwitchInPageWorld();
    if (!sw) return { isOn: null, error: '主世界未找到 AC 开关' };

    const disabled = isACSwitchDisabledInPageWorld(sw);
    const checked = sw.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') {
      return { isOn: checked === 'true', disabled, source: 'main-world-ant-switch' };
    }

    const text = (sw.textContent || '').trim().toUpperCase();
    if (text.includes('ON')) return { isOn: true, disabled, source: 'main-world-text' };
    if (text.includes('OFF')) return { isOn: false, disabled, source: 'main-world-text' };

    const input = sw.matches?.('input[type="checkbox"]')
      ? sw
      : sw.querySelector?.('input[type="checkbox"]');
    if (input) return { isOn: !!input.checked, disabled, source: 'main-world-input' };

    return { isOn: null, disabled, error: '主世界无法判断 AC 状态' };
  }

  // 基于 DOM 的 disabled 状态判定，而非余额数值：free mode 下余额为 0 也不禁用。
  // 页面把开关设 disabled 的条件 = (余额<=0 || 余额百分比<=0 || 加载中) && free_mode===null，
  // free mode 时 DOM 无 disabled 标记，本函数返回 false，仍可正常点击开机。
  function isACSwitchDisabledInPageWorld(sw) {
    if (!sw) return false;
    return sw.disabled === true
      || sw.hasAttribute?.('disabled')
      || sw.getAttribute?.('aria-disabled') === 'true'
      || String(sw.className || '').includes('ant-switch-disabled');
  }

  async function requestACState(targetState, notAfterAt = 0) {
    const requestedNotAfterAt = notAfterAt === 0 ? 0 : Number(notAfterAt);
    if (requestedNotAfterAt !== 0 && !Number.isSafeInteger(requestedNotAfterAt)) {
      return {
        success: false,
        verified: false,
        error: '自动开启窗口截止时间无效',
        via: 'main-world-ensureACState'
      };
    }
    if (activeAcStateRequest) {
      if (activeAcStateRequest.attempt.targetState === targetState
          && activeAcStateRequest.attempt.notAfterAt === requestedNotAfterAt) {
        console.log(`[AC扩展] ensureACState: 合并重复的 ${targetState ? 'ON' : 'OFF'} 请求`);
        return activeAcStateRequest.promise;
      }
      return {
        success: false,
        busy: true,
        error: `另一个 ${activeAcStateRequest.attempt.targetState ? 'ON' : 'OFF'} 操作仍在进行，本次请求不重复点击`,
        via: 'main-world-ensureACState'
      };
    }
    if (mainBridgeLease.inFlight) {
      return {
        success: false,
        busy: true,
        error: '前一个主世界操作仍在收口，本次请求不重复点击',
        via: 'main-world-ensureACState'
      };
    }

    const attempt = Object.freeze({
      targetState,
      notAfterAt: requestedNotAfterAt,
      cancellationRevision: automaticOnCancellationRevision,
      ownerGeneration: mainBridgeOwnerGeneration,
      requestId: `${PAGE_MAIN_LISTENER_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    const promise = ensureACState(attempt);
    activeAcStateRequest = { attempt, promise };
    mainBridgeLease.inFlight = promise;
    mainBridgeLease.target = targetState;
    mainBridgeLease.notAfterAt = requestedNotAfterAt;
    try {
      return await promise;
    } finally {
      if (mainBridgeLease.inFlight === promise) {
        mainBridgeLease.inFlight = null;
        mainBridgeLease.target = null;
        mainBridgeLease.notAfterAt = 0;
      }
      activeAcStateRequest = null;
    }
  }

  // 递归状态收敛：每轮只做「查状态 → 必要时 click 一次 → 等本次成功提示 →
  // 若状态仍未收敛则等 10 秒后递归复查」。
  // 所有物理开关尝试都集中在这里，content/background 不再叠加点击重试；
  // 当前生产调度仅传入 true（ON），OFF 完全由页面定时器执行。
  async function ensureACState(attempt, clickCount = 0) {
    const { targetState } = attempt;
    // 提取（Fowler Extract Function）：统一结果形状——避免三处成功/四处失败对象重复构造。
    function successResult(status, clickCount) {
      if (targetState && status?.isOn === true) {
        mainBridgeLease.uncertainClickOwner = '';
        mainBridgeLease.uncertainClickUntil = 0;
        mainBridgeLease.blockedUntil = 0;
      }
      return {
        success: true,
        alreadyDone: clickCount === 0,
        executionSucceeded: clickCount > 0,
        verified: true,
        stable: true,
        status,
        clicks: clickCount,
        via: 'main-world-ensureACState'
      };
    }
    function failureResult(status, clickCount, error, details = {}) {
      return {
        success: false,
        verified: false,
        status,
        clicks: clickCount,
        error,
        via: 'main-world-ensureACState',
        ...details
      };
    }
    function getOnWindowError() {
      if (attempt.cancellationRevision !== automaticOnCancellationRevision) {
        return '请求已被后台取消';
      }
      if (attempt.ownerGeneration !== mainBridgeLease.ownerGeneration) {
        return '请求已由更新的主世界脚本接管';
      }
      const notAfterAt = Number(attempt.notAfterAt) || 0;
      if (!targetState || notAfterAt === 0) return '';
      if (!Number.isSafeInteger(notAfterAt)) return '自动开启窗口截止时间无效';
      return Date.now() >= notAfterAt ? '自动开启窗口已结束' : '';
    }

    const current = getACStatusInPageWorld();
    if (typeof current.isOn === 'boolean' && current.isOn === targetState) {
      console.log(`[AC扩展] ensureACState: 已达到 ${targetState ? 'ON' : 'OFF'}，点击数=${clickCount}`);
      return successResult(current, clickCount);
    }

    const currentWindowError = getOnWindowError();
    if (currentWindowError) {
      return failureResult(current, clickCount, currentWindowError);
    }

    if (current.disabled) {
      console.warn(`[AC扩展] ensureACState: AC 开关被禁用（余额不足或页面加载中），无法切换到 ${targetState ? 'ON' : 'OFF'}`);
      return failureResult(current, clickCount, 'AC 开关被禁用（余额不足或页面加载中），无法切换');
    }

    if (clickCount >= MAX_AC_SWITCH_CLICKS) {
      console.warn(`[AC扩展] ensureACState: ${MAX_AC_SWITCH_CLICKS} 次点击后仍未达到 ${targetState ? 'ON' : 'OFF'}，最终状态=${JSON.stringify(current)}`);
      return failureResult(current, clickCount, `主世界已点击 ${MAX_AC_SWITCH_CLICKS} 次仍未达到 ${targetState ? 'ON' : 'OFF'}（状态=${JSON.stringify(current)}）`);
    }

    const sw = await waitForACSwitchInPageWorld(5000);
    if (!sw) {
      return failureResult(current, clickCount, '主世界等待 AC 开关超时');
    }

    // 等待 DOM 的过程中状态可能已被另一设备改变，点击前必须再检查一次。
    const beforeClick = getACStatusInPageWorld();
    if (typeof beforeClick.isOn === 'boolean' && beforeClick.isOn === targetState) {
      return successResult(beforeClick, clickCount);
    }
    const beforeClickWindowError = getOnWindowError();
    if (beforeClickWindowError) {
      return failureResult(beforeClick, clickCount, beforeClickWindowError);
    }
    if (beforeClick.disabled) {
      console.warn('[AC扩展] ensureACState: 点击前 AC 开关被禁用，无法切换');
      return failureResult(beforeClick, clickCount, 'AC 开关被禁用（余额不足或页面加载中），无法切换');
    }

    const clickOwner = String(attempt.requestId || '');
    if (targetState
        && mainBridgeLease.uncertainClickOwner
        && mainBridgeLease.uncertainClickOwner !== clickOwner
        && Number(mainBridgeLease.uncertainClickUntil) > Date.now()) {
      return failureResult(beforeClick, clickCount, '前任 ON 点击仍可能在途', {
        busy: true,
        takeoverPending: true
      });
    }

    console.log(`[AC扩展] ensureACState: 当前=${beforeClick.isOn}，目标=${targetState}，执行第 ${clickCount + 1} 次单击`);
    const executionSuccessBaseline = new Set(
      findACToggleExecutionSuccessMessagesInPageWorld()
    );
    mainBridgeLease.uncertainClickOwner = clickOwner;
    mainBridgeLease.uncertainClickUntil = Date.now() + HOT_TAKEOVER_CLICK_QUIET_MS;
    if (!clickElementOnceInPageWorld(sw)) {
      if (mainBridgeLease.uncertainClickOwner === clickOwner) {
        mainBridgeLease.uncertainClickOwner = '';
        mainBridgeLease.uncertainClickUntil = 0;
      }
      return failureResult(beforeClick, clickCount, '主世界 AC 开关 click() 调用失败');
    }

    // 点击后立即开始等待，和确认框轮询并行；否则无确认框时短暂 toast 可能先消失。
    const executionSuccessPromise = waitForNewACToggleExecutionSuccessInPageWorld(
      executionSuccessBaseline,
      AC_EXECUTION_SUCCESS_TIMEOUT_MS,
      Number(attempt.notAfterAt) || 0,
      attempt.cancellationRevision
    );
    const dialogWait = { stopped: false };
    const dialogPromise = clickConfirmDialogInPageWorld(
      5000,
      Number(attempt.notAfterAt) || 0,
      attempt.cancellationRevision,
      () => dialogWait.stopped
    );
    const executionSuccess = await executionSuccessPromise;
    dialogWait.stopped = true;
    const dialogConfirmed = await dialogPromise;
    const afterClick = getACStatusInPageWorld();
    const afterClickWindowError = getOnWindowError();
    if (afterClickWindowError) {
      return failureResult(afterClick, clickCount + 1, afterClickWindowError);
    }
    if (!executionSuccess.success) {
      return failureResult(
        afterClick,
        clickCount + 1,
        executionSuccess.error,
        {
          executionConfirmationMissing:
            executionSuccess.executionConfirmationMissing === true
        }
      );
    }
    const settled = await waitForTargetACStateInPageWorld(
      targetState,
      AC_STATE_SETTLE_MS,
      Number(attempt.notAfterAt) || 0,
      attempt.cancellationRevision
    );
    const settledStatus = settled.status || afterClick;
    if (settled.error) {
      return failureResult(settledStatus, clickCount + 1, settled.error);
    }
    const reachedTarget = settled.reached === true;
    const afterClickMessage = `[AC扩展] ensureACState: 第 ${clickCount + 1} 次点击后状态=${JSON.stringify(settledStatus)}，确认弹窗=${dialogConfirmed ? '已点击' : '未发现'}，页面提示=${AC_ON_SUCCESS_TEXT}`;
    if (reachedTarget) {
      console.log(afterClickMessage);
      return successResult(settledStatus, clickCount + 1);
    } else {
      console.warn(afterClickMessage);
    }
    return ensureACState(attempt, clickCount + 1);
  }

  function findACToggleExecutionSuccessMessagesInPageWorld() {
    const candidates = Array.from(new Set(document.querySelectorAll(
      '.ant-message-notice-content, '
      + '.ant-message-custom-content.ant-message-success, '
      + '[role="alert"].ant-message-success'
    )));
    return candidates.filter((node) => {
      const className = String(node.className || '');
      const hasSuccessSemantics = /(?:^|\s)ant-message-success(?:\s|$)/.test(className)
        || !!node.querySelector?.('.ant-message-success');
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      return hasSuccessSemantics
        && text === AC_ON_SUCCESS_TEXT
        && isACToggleExecutionMessageVisibleInPageWorld(node);
    });
  }

  function isACToggleExecutionMessageVisibleInPageWorld(node) {
    for (let current = node; current; current = current.parentElement) {
      const className = String(current.className || '');
      const style = String(current.getAttribute?.('style') || '');
      if (current.hidden
          || current.getAttribute?.('aria-hidden') === 'true'
          || /(?:^|\s)(?:ant-message-notice-hidden|hidden)(?:\s|$)/.test(className)
          || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
        return false;
      }
    }
    return true;
  }

  async function waitForNewACToggleExecutionSuccessInPageWorld(
    baselineMessages,
    timeoutMs,
    notAfterAt = 0,
    cancellationRevision = automaticOnCancellationRevision
  ) {
    const baseline = baselineMessages instanceof Set
      ? baselineMessages
      : new Set(baselineMessages || []);
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      if (cancellationRevision !== automaticOnCancellationRevision) {
        return { success: false, error: '请求已被后台取消' };
      }
      if (notAfterAt !== 0
          && (!Number.isSafeInteger(notAfterAt) || Date.now() >= notAfterAt)) {
        return { success: false, error: '自动开启窗口已结束' };
      }
      const freshMessage = findACToggleExecutionSuccessMessagesInPageWorld()
        .find(node => !baseline.has(node));
      if (freshMessage) {
        return { success: true, message: AC_ON_SUCCESS_TEXT };
      }
      await sleepInPageWorld(100);
    }
    return {
      success: false,
      executionConfirmationMissing: true,
      error: `页面未出现新的 ${AC_ON_SUCCESS_TEXT} 成功提示`
    };
  }

  async function waitForTargetACStateInPageWorld(
    targetState,
    timeoutMs,
    notAfterAt = 0,
    cancellationRevision = automaticOnCancellationRevision
  ) {
    const start = Date.now();
    let status = getACStatusInPageWorld();
    while (Date.now() - start <= timeoutMs) {
      if (cancellationRevision !== automaticOnCancellationRevision) {
        return { reached: false, status, error: '请求已被后台取消' };
      }
      if (notAfterAt !== 0
          && (!Number.isSafeInteger(notAfterAt) || Date.now() >= notAfterAt)) {
        return { reached: false, status, error: '自动开启窗口已结束' };
      }
      if (typeof status?.isOn === 'boolean' && status.isOn === targetState) {
        return { reached: true, status };
      }
      if (Date.now() - start >= timeoutMs) break;
      await sleepInPageWorld(100);
      status = getACStatusInPageWorld();
    }
    return { reached: false, status };
  }

  function findACSwitchInPageWorld() {
    return findUniqueACControlInPageWorld(
      'button.ant-switch[role="switch"], .ui.toggle.checkbox input[type="checkbox"]'
    );
  }

  function findUniqueACControlInPageWorld(selector) {
    const labels = Array.from(document.querySelectorAll('small, label, span, div'))
      .filter(label => label.children.length === 0 && isACStatusLabelInPageWorld(label.textContent));
    const matches = new Set();

    for (const label of labels) {
      let container = label.parentElement;
      for (let depth = 0; depth < 10 && container; depth++) {
        const candidates = Array.from(container.querySelectorAll(selector));
        if (candidates.length === 1) {
          matches.add(candidates[0]);
          break;
        }
        // 向上只会扩大范围；当前语义区已含多个候选时不再猜测。
        if (candidates.length > 1) break;
        container = container.parentElement;
      }
    }

    return matches.size === 1 ? matches.values().next().value : null;
  }

  function isACStatusLabelInPageWorld(text) {
    return /^air\s*conditioning\s+status$/i.test(String(text || '').trim());
  }

  function clickElementOnceInPageWorld(element) {
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    try {
      withScopedNativeDialogsInPageWorld(() => element.click());
      return true;
    } catch (error) {
      console.warn('[AC扩展] 单次 click() 失败:', error?.message || String(error));
      return false;
    }
  }

  // 原生 confirm/alert/prompt 只在扩展的同步点击调用栈内代理。
  // 无论 click() 成功或抛异常，finally 都恢复页面当前的原函数引用。
  function withScopedNativeDialogsInPageWorld(clickAction) {
    const previousConfirm = window.confirm;
    const previousAlert = window.alert;
    const previousPrompt = window.prompt;
    const scopedConfirm = (message) => {
      console.log('[AC扩展] 已自动确认本次 AC ON 的原生 confirm:', message);
      return true;
    };
    const scopedAlert = (message) => {
      console.log('[AC扩展] 已自动关闭本次 AC ON 的原生 alert:', message);
    };
    const scopedPrompt = (message, defaultValue = '') => {
      console.log('[AC扩展] 已自动处理本次 AC ON 的原生 prompt:', message);
      return defaultValue;
    };

    window.confirm = scopedConfirm;
    window.alert = scopedAlert;
    window.prompt = scopedPrompt;
    try {
      return clickAction();
    } finally {
      if (window.confirm === scopedConfirm) window.confirm = previousConfirm;
      if (window.alert === scopedAlert) window.alert = previousAlert;
      if (window.prompt === scopedPrompt) window.prompt = previousPrompt;
    }
  }

  async function clickConfirmDialogInPageWorld(
    timeoutMs,
    notAfterAt = 0,
    cancellationRevision = automaticOnCancellationRevision,
    shouldStop = () => false
  ) {
    const start = Date.now();
    const confirmTexts = [
      '确定', '确认', '开启', '打开', '启用', '是',
      'OK', 'Ok', 'ok', 'Yes', 'YES', 'Confirm', 'Turn On', 'Proceed',
      'Continue', 'Accept', 'Agree', 'Enable', 'Start'
    ];
    const isPrimaryButton = (button) => {
      const cls = String(button.className || '');
      return cls.includes('ant-btn-primary')
        || cls.includes('ui primary')
        || cls.includes('ui positive')
        || cls.includes('btn-primary')
        || cls.includes('btn-confirm');
    };
    const isVisibleDialog = (dialog) => {
      for (let node = dialog; node; node = node.parentElement) {
        const cls = String(node.className || '');
        const style = String(node.getAttribute?.('style') || '');
        if (node.hidden
            || node.getAttribute?.('aria-hidden') === 'true'
            || /(?:^|\s)(?:ant-modal-hidden|ant-popover-hidden|hidden)(?:\s|$)/.test(cls)
            || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
          return false;
        }
      }
      return true;
    };
    const isACDialog = (dialog) => (
      /air\s*conditioning|aircondition(?:ing)?|\ba\s*\/\s*c\b|\bAC\b|空调/i
        .test(dialog.textContent || '')
    );
    const findUniqueACDialog = () => {
      const allDialogs = Array.from(new Set(document.querySelectorAll(
        '.ant-modal-confirm, .ant-popconfirm, [role="alertdialog"], [role="dialog"], '
        + '.ui.modal, .modal'
      ))).filter(dialog => isVisibleDialog(dialog) && isACDialog(dialog));
      // 同一弹窗可能同时命中 role 和 class；只保留最内层语义容器。
      const innermostDialogs = allDialogs.filter(dialog => !allDialogs.some(
        other => other !== dialog && dialog.contains?.(other)
      ));
      return innermostDialogs.length === 1 ? innermostDialogs[0] : null;
    };
    while (Date.now() - start <= timeoutMs) {
      if (shouldStop()) return false;
      if (cancellationRevision !== automaticOnCancellationRevision) {
        console.warn('[AC扩展] ensureACState: 自动开启请求已被后台取消');
        return false;
      }
      if (notAfterAt !== 0
          && (!Number.isSafeInteger(notAfterAt) || Date.now() >= notAfterAt)) {
        console.warn('[AC扩展] ensureACState: 等待确认框时自动开启窗口已结束');
        return false;
      }
      const dialog = findUniqueACDialog();
      const buttons = dialog ? Array.from(dialog.querySelectorAll('button')) : [];
      const confirmButtons = buttons.filter((button) => {
        const text = (button.textContent || '').trim();
        const enabled = button.disabled !== true
          && !button.hasAttribute?.('disabled')
          && button.getAttribute?.('aria-disabled') !== 'true';
        return enabled && (confirmTexts.includes(text) || isPrimaryButton(button));
      });
      if (confirmButtons.length > 1) {
        console.warn('[AC扩展] ensureACState: AC 确认框存在多个确认候选，拒绝猜测');
        return false;
      }
      if (confirmButtons.length === 1) {
        return clickElementOnceInPageWorld(confirmButtons[0]);
      }
      await sleepInPageWorld(200);
    }
    return false;
  }

  async function waitForACSwitchInPageWorld(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      const sw = findACSwitchInPageWorld();
      if (sw) return sw;
      await sleepInPageWorld(300);
    }
    return null;
  }

  function sleepInPageWorld(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
