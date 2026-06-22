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

    window.__AC_EXTENSION_RESTORE_DIALOGS__ = function() {
      window.confirm = originalConfirm;
      window.alert = originalAlert;
      window.prompt = originalPrompt;
      delete window.__AC_EXTENSION_DIALOG_PATCHED__;
      delete window.__AC_EXTENSION_RESTORE_DIALOGS__;
    };
  }

  if (window.__AC_EXTENSION_TOGGLE_PATCHED__) return;
  window.__AC_EXTENSION_TOGGLE_PATCHED__ = true;

  window.addEventListener('__AC_EXTENSION_TOGGLE_AC__', async (event) => {
    const { requestId, action } = event.detail || {};
    if (!requestId || (action !== 'on' && action !== 'off')) return;

    const needOn = action === 'on';
    const result = await toggleACInPageWorld(needOn, action);
    window.dispatchEvent(new CustomEvent('__AC_EXTENSION_TOGGLE_AC_RESULT__', {
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

  async function toggleACInPageWorld(needOn, action) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const sw = await waitForACSwitchInPageWorld(10000);
      if (!sw) return { success: false, error: '主世界等待 AC 开关超时' };

      const before = getACStatusInPageWorld();
      console.log(`[AC扩展] 主世界 AC 状态(尝试 ${attempt}/3):`, before);
      if (before.isOn === needOn) {
        return { success: true, alreadyDone: true, verified: true, action, status: before, via: 'main-world' };
      }

      dispatchUserClickInPageWorld(sw);
      console.log('[AC扩展] 主世界已点击 AC 开关');

      const confirmed = await clickConfirmDialogInPageWorld(5000);
      const verified = await waitForTargetStatusInPageWorld(needOn, 9000);
      if (verified.success) {
        return { success: true, verified: true, confirmed, action, attempts: attempt, status: verified.status, via: 'main-world' };
      }

      console.warn('[AC扩展] 主世界点击后状态未改变，准备重试:', verified.status);
      await sleepInPageWorld(1000);
    }

    return { success: false, verified: false, action, status: getACStatusInPageWorld(), error: `主世界已尝试 3 次，但 AC 未变成 ${action}` };
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

  function dispatchUserClickInPageWorld(element) {
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const options = { bubbles: true, cancelable: true, view: window, composed: true };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try {
        const event = type.startsWith('pointer')
          ? new PointerEvent(type, options)
          : new MouseEvent(type, options);
        element.dispatchEvent(event);
      } catch (_) {}
    }
    // Ant Design 开关（button.ant-switch[role="switch"]）走 React 合成事件，
    // mouseup 已触发 React click handler；再调 .click() 会导致双切（ON→OFF→ON）。
    // 仅对非 AntD 元素补 .click() 兜底。
    if (!element.matches?.('button.ant-switch[role="switch"]')) {
      element.click?.();
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
        dispatchUserClickInPageWorld(btn);
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

  async function waitForTargetStatusInPageWorld(needOn, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      const status = getACStatusInPageWorld();
      if (status.isOn === needOn) return { success: true, status };
      await sleepInPageWorld(300);
    }
    return { success: false, status: getACStatusInPageWorld() };
  }

  function sleepInPageWorld(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
