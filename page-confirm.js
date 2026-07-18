// ============================================================
// Page Script - 注入到网页主环境
// 负责接管页面自身的 window.confirm，content script 的隔离环境无法做到这一点
// ============================================================

(() => {
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
  let acStateRequestInFlight = null;
  let acStateRequestTarget = null;

  window.addEventListener('__AC_EXTENSION_TOGGLE_AC__', async (event) => {
    const { requestId, action } = event.detail || {};
    if (!requestId || (action !== 'on' && action !== 'off')) return;

    const needOn = action === 'on';
    const result = await requestACState(needOn);
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

    const checked = sw.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') {
      return { isOn: checked === 'true', source: 'main-world-ant-switch' };
    }

    const text = (sw.textContent || '').trim().toUpperCase();
    if (text.includes('ON')) return { isOn: true, source: 'main-world-text' };
    if (text.includes('OFF')) return { isOn: false, source: 'main-world-text' };

    const input = sw.querySelector?.('input[type="checkbox"]');
    if (input) return { isOn: !!input.checked, source: 'main-world-input' };

    return { isOn: null, error: '主世界无法判断 AC 状态' };
  }

  async function requestACState(targetState) {
    if (acStateRequestInFlight) {
      if (acStateRequestTarget === targetState) {
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
    acStateRequestInFlight = ensureACState(targetState);
    try {
      return await acStateRequestInFlight;
    } finally {
      acStateRequestInFlight = null;
      acStateRequestTarget = null;
    }
  }

  // 递归状态收敛：每轮只做「查状态 → 必要时 click 一次 → 等 10 秒 → 递归复查」。
  // 所有物理开关尝试都集中在这里，content/background 不再叠加点击重试；
  // 当前生产调度仅传入 true（ON），OFF 完全由页面定时器执行。
  async function ensureACState(targetState, clickCount = 0) {
    const current = getACStatusInPageWorld();
    if (typeof current.isOn === 'boolean' && current.isOn === targetState) {
      console.log(`[AC扩展] ensureACState: 已达到 ${targetState ? 'ON' : 'OFF'}，点击数=${clickCount}`);
      return {
        success: true,
        alreadyDone: clickCount === 0,
        verified: true,
        stable: true,
        status: current,
        clicks: clickCount,
        via: 'main-world-ensureACState'
      };
    }

    if (clickCount >= MAX_AC_SWITCH_CLICKS) {
      console.warn(`[AC扩展] ensureACState: ${MAX_AC_SWITCH_CLICKS} 次点击后仍未达到 ${targetState ? 'ON' : 'OFF'}`);
      return {
        success: false,
        verified: false,
        status: current,
        clicks: clickCount,
        error: `主世界已点击 ${MAX_AC_SWITCH_CLICKS} 次仍未达到 ${targetState ? 'ON' : 'OFF'}`,
        via: 'main-world-ensureACState'
      };
    }

    const sw = await waitForACSwitchInPageWorld(5000);
    if (!sw) {
      return {
        success: false,
        verified: false,
        status: current,
        clicks: clickCount,
        error: '主世界等待 AC 开关超时',
        via: 'main-world-ensureACState'
      };
    }

    // 等待 DOM 的过程中状态可能已被另一设备改变，点击前必须再检查一次。
    const beforeClick = getACStatusInPageWorld();
    if (typeof beforeClick.isOn === 'boolean' && beforeClick.isOn === targetState) {
      return {
        success: true,
        alreadyDone: clickCount === 0,
        verified: true,
        stable: true,
        status: beforeClick,
        clicks: clickCount,
        via: 'main-world-ensureACState'
      };
    }

    console.log(`[AC扩展] ensureACState: 当前=${beforeClick.isOn}，目标=${targetState}，执行第 ${clickCount + 1} 次单击`);
    if (!clickElementOnceInPageWorld(sw)) {
      return {
        success: false,
        verified: false,
        status: beforeClick,
        clicks: clickCount,
        error: '主世界 AC 开关 click() 调用失败',
        via: 'main-world-ensureACState'
      };
    }

    await clickConfirmDialogInPageWorld(3000);
    await sleepInPageWorld(AC_STATE_SETTLE_MS);
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

  async function clickConfirmDialogInPageWorld(timeoutMs) {
    const start = Date.now();
    const texts = ['确定', '确认', 'OK', 'Ok', 'ok', 'Yes', 'YES'];
    while (Date.now() - start <= timeoutMs) {
      const buttons = Array.from(document.querySelectorAll(
        '.ant-modal-confirm-btns button, .ant-modal button, .ant-popconfirm-buttons button, [role="dialog"] button'
      ));
      const btn = buttons.find((button) => {
        const text = (button.textContent || '').trim();
        return texts.includes(text) || button.matches('.ant-btn-primary') || String(button.className || '').includes('ant-btn-primary');
      });
      if (btn) {
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
