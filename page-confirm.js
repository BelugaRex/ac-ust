// ============================================================
// Page Script - 注入到网页主环境
// 负责接管页面自身的 window.confirm，content script 的隔离环境无法做到这一点
// ============================================================

(() => {
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

  if (!window.__AC_EXTENSION_DIALOG_PATCHED__) {
    window.__AC_EXTENSION_DIALOG_PATCHED__ = true;

    const originalConfirm = window.confirm.bind(window);
    const originalAlert = window.alert.bind(window);
    const originalPrompt = window.prompt.bind(window);

    window.confirm = function(message) {
      console.log('[AC扩展] 已自动确认原生 confirm 弹窗:', message);
      return true;
    };

    window.alert = function(message) {
      console.log('[AC扩展] 已自动关闭原生 alert 弹窗:', message);
    };

    window.prompt = function(message, defaultValue = '') {
      console.log('[AC扩展] 已自动处理原生 prompt 弹窗:', message);
      return defaultValue;
    };

  }

  if (window.__AC_EXTENSION_TOGGLE_PATCHED__) return;
  window.__AC_EXTENSION_TOGGLE_PATCHED__ = true;

  const MAX_AC_SWITCH_CLICKS = 3;
  const AC_STATE_SETTLE_MS = 10000;
  const EXECUTION_SUCCESS_TIMEOUT_MS = 15000;
  let acStateRequestInFlight = null;
  let acStateRequestTarget = null;
  let acStateRequestNotAfterAt = 0;
  let acStateRequestCancellationRevision = null;
  let automaticOnCancellationRevision = 0;

  window.addEventListener('__AC_EXTENSION_CANCEL_AUTOMATIC_ON__', () => {
    automaticOnCancellationRevision += 1;
  });

  function isVisibleExecutionMessageElement(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.hasAttribute?.('hidden') || element.getAttribute?.('aria-hidden') === 'true') {
      return false;
    }
    const style = typeof globalThis.getComputedStyle === 'function'
      ? globalThis.getComputedStyle(element)
      : null;
    if (style && (style.display === 'none'
        || style.visibility === 'hidden'
        || style.opacity === '0')) {
      return false;
    }
    return (element.getClientRects?.().length || 0) > 0;
  }

  function getExecutionSuccessCandidatesInPageWorld() {
    const root = document.body || document.documentElement;
    if (!root) return [];
    return Array.from(root.querySelectorAll('*'))
      .map(element => ({
        element,
        text: String(element.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(({ element, text }) => text.length <= 200
        && /execution succeeded/i.test(text)
        && isVisibleExecutionMessageElement(element));
  }

  // 在 click 前登记 MutationObserver，保存会在确认框等待期间闪过的网页成功提示。
  // 只接受本次新增/重新出现的可见提示，页面上遗留的成功提示不能放行本次操作。
  function startExecutionSuccessWaitInPageWorld(
    cancellationRevision = null,
    timeoutMs = EXECUTION_SUCCESS_TIMEOUT_MS
  ) {
    const baselineNodes = new Map(getExecutionSuccessCandidatesInPageWorld()
      .map(candidate => [candidate.element, candidate.text]));
    const hiddenBaselineNodes = new Set();
    const timeout = Math.max(1, Number(timeoutMs) || EXECUTION_SUCCESS_TIMEOUT_MS);
    const startedAt = Date.now();
    let finish;
    const result = new Promise(resolve => {
      let settled = false;
      let timeoutId = 0;
      let pollId = 0;
      let observer = null;
      finish = result => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (pollId) clearInterval(pollId);
        observer?.disconnect();
        resolve(result);
      };
      const check = () => {
        if (Number.isSafeInteger(cancellationRevision)
            && cancellationRevision !== automaticOnCancellationRevision) {
          finish({ success: false, cancelled: true, error: '请求已被后台取消' });
          return;
        }
        const candidates = getExecutionSuccessCandidatesInPageWorld();
        const currentNodes = new Set(candidates.map(candidate => candidate.element));
        for (const element of baselineNodes.keys()) {
          if (!currentNodes.has(element)) hiddenBaselineNodes.add(element);
        }
        const freshCandidate = candidates.find(candidate => {
          const previousText = baselineNodes.get(candidate.element);
          return previousText === undefined
            || previousText !== candidate.text
            || hiddenBaselineNodes.has(candidate.element);
        });
        if (freshCandidate) {
          finish({ success: true, via: 'page-message', text: freshCandidate.text });
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          finish({ success: false, error: '等待 Execution succeeded 成功弹窗超时' });
        }
      };
      if (typeof MutationObserver === 'function' && document.documentElement) {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
        });
      }
      timeoutId = setTimeout(() => finish({
        success: false,
        error: '等待 Execution succeeded 成功弹窗超时'
      }), timeout);
      pollId = setInterval(check, 200);
      check();
    });
    return {
      result,
      cancel: () => finish({ success: false, cancelled: true, error: '成功提示等待已取消' })
    };
  }

  window.addEventListener('__AC_EXTENSION_TOGGLE_AC__', async (event) => {
    const {
      requestId,
      action,
      notAfterAt = 0,
      cancellationRevision = automaticOnCancellationRevision
    } = event.detail || {};
    if (!requestId || action !== 'on') {
      if (requestId) {
        window.dispatchEvent(new CustomEvent('__AC_EXTENSION_TOGGLE_AC_RESULT__', {
          detail: {
            requestId,
            action,
            success: false,
            verified: false,
            error: 'OFF 操作已禁用；自动关机只允许使用 Power-off after',
            via: 'main-world-ensureACState'
          }
        }));
      }
      return;
    }

    let result;
    try {
      requestACState.cancellationRevision = Number(cancellationRevision);
      result = await requestACState(true, notAfterAt);
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
    window.dispatchEvent(new CustomEvent('__AC_EXTENSION_TOGGLE_AC_RESULT__', {
      detail: { requestId, action, ...result }
    }));
  });

  window.addEventListener('__AC_EXTENSION_GET_STATUS__', (event) => {
    const { requestId } = event.detail || {};
    if (!requestId) return;

    const result = getACStatusInPageWorld();
    window.dispatchEvent(new CustomEvent('__AC_EXTENSION_GET_STATUS_RESULT__', {
      detail: { requestId, ...result }
    }));
  });

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

    const input = sw.querySelector?.('input[type="checkbox"]');
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
    const requestedCancellationRevision = Number(
      requestACState.cancellationRevision
    );
    if (requestedNotAfterAt !== 0 && !Number.isSafeInteger(requestedNotAfterAt)) {
      return {
        success: false,
        verified: false,
        error: '自动开启窗口截止时间无效',
        via: 'main-world-ensureACState'
      };
    }
    if (!Number.isSafeInteger(requestedCancellationRevision)
        || requestedCancellationRevision < 0
        || requestedCancellationRevision !== automaticOnCancellationRevision) {
      return {
        success: false,
        verified: false,
        cancelled: true,
        error: '请求已被后台取消',
        via: 'main-world-ensureACState'
      };
    }
    if (acStateRequestInFlight) {
      if (acStateRequestTarget === targetState
          && acStateRequestNotAfterAt === requestedNotAfterAt
          && acStateRequestCancellationRevision
            === requestedCancellationRevision) {
        console.log(`[AC扩展] ensureACState: 合并重复的 ${targetState ? 'ON' : 'OFF'} 请求`);
        return acStateRequestInFlight;
      }
      return {
        success: false,
        busy: true,
        error: `另一个 ${acStateRequestTarget ? 'ON' : 'OFF'} 操作仍在进行，本次请求不重复点击`,
        via: 'main-world-ensureACState'
      };
    }

    acStateRequestTarget = targetState;
    acStateRequestNotAfterAt = requestedNotAfterAt;
    acStateRequestCancellationRevision = requestedCancellationRevision;
    ensureACState.notAfterAt = requestedNotAfterAt;
    ensureACState.cancellationRevision = requestedCancellationRevision;
    acStateRequestInFlight = ensureACState(targetState);
    try {
      return await acStateRequestInFlight;
    } finally {
      acStateRequestInFlight = null;
      acStateRequestTarget = null;
      acStateRequestNotAfterAt = 0;
      acStateRequestCancellationRevision = null;
      ensureACState.notAfterAt = 0;
      ensureACState.cancellationRevision = null;
    }
  }

  // 递归状态收敛：查状态 → click 一次 → 等 Execution succeeded → 稳定后复查。
  // 所有物理开关尝试都集中在这里，content/background 不再叠加点击重试；
  // 当前生产调度仅传入 true（ON），OFF 完全由页面定时器执行。
  async function ensureACState(targetState, clickCount = 0) {
    // 提取（Fowler Extract Function）：统一结果形状——避免三处成功/四处失败对象重复构造。
    function successResult(status, clickCount) {
      return {
        success: true,
        alreadyDone: clickCount === 0,
        verified: true,
        stable: true,
        status,
        clicks: clickCount,
        via: 'main-world-ensureACState'
      };
    }
    function failureResult(status, clickCount, error) {
      return {
        success: false,
        verified: false,
        status,
        clicks: clickCount,
        error,
        via: 'main-world-ensureACState'
      };
    }
    function getOnWindowError() {
      const notAfterAt = Number(ensureACState.notAfterAt) || 0;
      if (!targetState || notAfterAt === 0) return '';
      if (!Number.isSafeInteger(notAfterAt)) return '自动开启窗口截止时间无效';
      return Date.now() >= notAfterAt ? '自动开启窗口已结束' : '';
    }
    function getAutomaticOnCancellationError() {
      const cancellationRevision = Number(ensureACState.cancellationRevision);
      if (typeof automaticOnCancellationRevision !== 'number'
          || !Number.isSafeInteger(cancellationRevision)) return '';
      return cancellationRevision === automaticOnCancellationRevision
        ? ''
        : '请求已被后台取消';
    }

    const currentCancellationError = getAutomaticOnCancellationError();
    if (currentCancellationError) {
      return failureResult(null, clickCount, currentCancellationError);
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
    const afterWaitCancellationError = getAutomaticOnCancellationError();
    if (afterWaitCancellationError) {
      return failureResult(current, clickCount, afterWaitCancellationError);
    }
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
    const beforeClickCancellationError = getAutomaticOnCancellationError();
    if (beforeClickCancellationError) {
      return failureResult(beforeClick, clickCount, beforeClickCancellationError);
    }

    const executionWait = startExecutionSuccessWaitInPageWorld(
      Number(ensureACState.cancellationRevision)
    );
    console.log(`[AC扩展] ensureACState: 当前=${beforeClick.isOn}，目标=${targetState}，执行第 ${clickCount + 1} 次单击`);
    let dialogConfirmed = false;
    let executionSuccess;
    try {
      if (!clickElementOnceInPageWorld(sw)) {
        return failureResult(beforeClick, clickCount, '主世界 AC 开关 click() 调用失败');
      }
      dialogConfirmed = await clickConfirmDialogInPageWorld(
        5000,
        Number(ensureACState.notAfterAt) || 0,
        Number(ensureACState.cancellationRevision)
      );
      executionSuccess = await executionWait.result;
    } finally {
      executionWait.cancel();
    }
    const afterExecutionCancellationError = getAutomaticOnCancellationError();
    if (afterExecutionCancellationError) {
      return failureResult(beforeClick, clickCount + 1, afterExecutionCancellationError);
    }
    if (!executionSuccess?.success) {
      console.warn(`[AC扩展] ensureACState: 第 ${clickCount + 1} 次点击后未等到 Execution succeeded: ${executionSuccess?.error || '未知错误'}`);
      return {
        ...failureResult(
          beforeClick,
          clickCount + 1,
          executionSuccess?.error || '等待 Execution succeeded 成功弹窗超时'
        ),
        executionSuccessUnconfirmed: true
      };
    }
    const afterClick = getACStatusInPageWorld();
    const reachedTarget = typeof afterClick.isOn === 'boolean' && afterClick.isOn === targetState;
    const afterClickMessage = `[AC扩展] ensureACState: 第 ${clickCount + 1} 次点击后状态=${JSON.stringify(afterClick)}，确认弹窗=${dialogConfirmed ? '已点击' : '未发现'}，Execution succeeded=${executionSuccess.via}`;
    if (reachedTarget) {
      console.log(afterClickMessage);
    } else {
      console.warn(afterClickMessage);
    }
    await sleepInPageWorld(AC_STATE_SETTLE_MS);
    const afterSettleCancellationError = getAutomaticOnCancellationError();
    if (afterSettleCancellationError) {
      return failureResult(afterClick, clickCount + 1, afterSettleCancellationError);
    }
    return ensureACState(targetState, clickCount + 1);
  }

  function findACSwitchInPageWorld() {
    const labels = Array.from(document.querySelectorAll('small'));
    for (const small of labels) {
      const text = (small.textContent || '').trim();
      if (text === 'Air Conditioning Status' || text === 'AirConditioning Status') {
        let container = small.closest('[class*="row"]') || small.closest('div[style*="flex"]') || small.parentElement?.parentElement;
        for (let i = 0; i < 10 && container; i++) {
          const antSwitch = container.querySelector('button.ant-switch[role="switch"]');
          if (antSwitch) return antSwitch;
          container = container.parentElement;
        }
      }
    }

    const switches = Array.from(document.querySelectorAll('button.ant-switch[role="switch"]'));
    if (switches.length === 1) return switches[0];
    for (const sw of switches) {
      const text = (sw.closest('[style*="flex"]') || sw.parentElement?.parentElement || sw.parentElement || sw).textContent || '';
      if (text.includes('Air Conditioning') || text.includes('AC')) return sw;
    }

    const legacy = document.querySelector('.ui.toggle.checkbox input[type="checkbox"]') || document.querySelector('.ui.toggle.checkbox');
    return legacy || switches[0] || null;
  }

  function clickElementOnceInPageWorld(element) {
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    try {
      element.click();
      return true;
    } catch (error) {
      console.warn('[AC扩展] 单次 click() 失败:', error?.message || String(error));
      return false;
    }
  }

  async function clickConfirmDialogInPageWorld(
    timeoutMs,
    notAfterAt = 0,
    cancellationRevision = null
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
    while (Date.now() - start <= timeoutMs) {
      if (cancellationRevision !== null
          && typeof automaticOnCancellationRevision === 'number'
          && cancellationRevision !== automaticOnCancellationRevision) {
        return false;
      }
      const buttons = Array.from(document.querySelectorAll(
        '.ant-modal-confirm-btns button, .ant-modal button, .ant-popconfirm-buttons button, '
        + '[role="dialog"] button, [role="alertdialog"] button, .ui.modal button, .ui.modal .actions button, .modal button'
      ));
      const btn = buttons.find((button) => {
        const text = (button.textContent || '').trim();
        return confirmTexts.includes(text) || isPrimaryButton(button);
      });
      if (btn) {
        if (cancellationRevision !== null
            && typeof automaticOnCancellationRevision === 'number'
            && cancellationRevision !== automaticOnCancellationRevision) {
          return false;
        }
        if (notAfterAt !== 0
            && (!Number.isSafeInteger(notAfterAt) || Date.now() >= notAfterAt)) {
          console.warn('[AC扩展] ensureACState: 确认弹窗出现时自动开启窗口已结束，不再点击确认');
          return false;
        }
        clickElementOnceInPageWorld(btn);
        return true;
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
