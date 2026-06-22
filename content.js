// ============================================================
// Content Script - 注入到 w5.ab.ust.hk/njggt/app/* 页面
// 负责与页面交互：读取状态、点击开关
// ============================================================

console.log('[AC扩展] Content script 已加载');

// ----- 监听来自 background 的消息 -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'on' || msg.action === 'off') {
    toggleACSwitch(msg.action).then(result => sendResponse(result));
    return true; // 异步响应
  }
  if (msg.action === 'status') {
    sendResponse(getACStatus());
  }
  if (msg.action === 'balance') {
    sendResponse(getBalanceInfo());
  }
  if (msg.action === 'setTimer') {
    setPagePowerOffTimer(msg.minutes).then(result => sendResponse(result));
    return true;
  }
  return true;
});

// ----- 获取当前 AC 状态 -----
function getACStatus() {
  const antSwitch = findAntACSwitch();
  if (antSwitch) {
    const checked = antSwitch.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') {
      return { isOn: checked === 'true', source: 'ant-switch' };
    }

    const text = (antSwitch.textContent || '').trim().toUpperCase();
    if (text.includes('ON')) return { isOn: true, source: 'ant-switch-text' };
    if (text.includes('OFF')) return { isOn: false, source: 'ant-switch-text' };
  }

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

// ----- 切换 AC 开关 -----
async function toggleACSwitch(targetAction) {
  console.log(`[AC扩展] 准备切换 AC: ${targetAction}`);
  const needOn = (targetAction === 'on');

  for (let attempt = 1; attempt <= 3; attempt++) {
    // 等待开关元素出现 (React 可能需要时间渲染)
    const switchEl = await waitForSwitch(10000);
    if (!switchEl) {
      return { success: false, error: '等待超时，未找到 AC 开关。请确保页面已完全加载' };
    }
    
    // 先检查当前状态
    const currentStatus = getACStatus();
    console.log(`[AC扩展] 当前状态(尝试 ${attempt}/3):`, currentStatus);
    
    // 判断是否需要切换
    if (currentStatus.isOn === needOn) {
      console.log(`[AC扩展] AC 已处于目标状态 (${targetAction})，无需操作`);
      return { success: true, alreadyDone: true, action: targetAction, verified: true, status: currentStatus };
    }

    if (typeof currentStatus.isOn !== 'boolean') {
      console.warn('[AC扩展] 当前 AC 状态未知，仍尝试点击开关');
    }
    
    // 关键: 覆盖 window.confirm 自动确认
    const originalConfirm = window.confirm;
    window.confirm = function(msg) {
      console.log('[AC扩展] 自动确认弹窗:', msg);
      window.confirm = originalConfirm;
      return true;
    };
    
    const mainWorldResult = await requestMainWorldToggle(targetAction, 25000);
    if (mainWorldResult?.success) {
      console.log('[AC扩展] 主世界切换成功:', mainWorldResult);
      return mainWorldResult;
    }
    if (mainWorldResult) {
      console.warn('[AC扩展] 主世界切换未成功，回退到隔离世界点击:', mainWorldResult);
    }

    // 回退：点击开关。Ant Design 的开关本身就是 button；旧版页面点 input/label 或容器。
    const clickTarget = getSwitchClickTarget(switchEl);
    dispatchUserClick(clickTarget);
    console.log('[AC扩展] 已模拟用户点击开关');

    const confirmed = await clickConfirmDialog(5000);
    if (confirmed) {
      console.log('[AC扩展] 已自动确认页面弹窗');
    }
    
    // 等2秒后恢复 confirm
    setTimeout(() => {
      if (window.confirm !== originalConfirm) {
        window.confirm = originalConfirm;
      }
    }, 2000);

    const verifiedStatus = await waitForTargetACStatus(needOn, 8000);
    if (verifiedStatus.success) {
      return {
        success: true,
        action: targetAction,
        confirmed,
        verified: true,
        attempts: attempt,
        status: verifiedStatus.status
      };
    }

    console.warn(`[AC扩展] 点击后状态未变成 ${targetAction}，准备重试`, verifiedStatus.status);
    await sleep(1000);
  }

  const finalStatus = getACStatus();
  return {
    success: false,
    action: targetAction,
    verified: false,
    status: finalStatus,
    error: `已尝试 3 次，但 AC 未变成 ${targetAction}`
  };
}

async function requestMainWorldToggle(targetAction, timeoutMs) {
  return new Promise((resolve) => {
    const requestId = `ac-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let done = false;

    const cleanup = () => {
      window.removeEventListener('__AC_EXTENSION_TOGGLE_AC_RESULT__', onResult);
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

    window.addEventListener('__AC_EXTENSION_TOGGLE_AC_RESULT__', onResult);
    window.dispatchEvent(new CustomEvent('__AC_EXTENSION_TOGGLE_AC__', {
      detail: { requestId, action: targetAction }
    }));

    setTimeout(() => finish(null), timeoutMs);
  });
}

async function waitForTargetACStatus(needOn, timeoutMs) {
  const startTime = Date.now();
  while (Date.now() - startTime <= timeoutMs) {
    const status = getACStatus();
    if (status.isOn === needOn) {
      return { success: true, status };
    }
    await sleep(300);
  }
  return { success: false, status: getACStatus() };
}

function getSwitchClickTarget(switchEl) {
  if (switchEl.matches?.('button.ant-switch')) return switchEl;
  const input = switchEl.querySelector?.('input[type="checkbox"]');
  if (input) return input;
  return switchEl.querySelector?.('label') || switchEl;
}

function dispatchUserClick(element) {
  if (!element) return;
  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  element.focus?.();

  const options = { bubbles: true, cancelable: true, view: window };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    try {
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, options)
        : new MouseEvent(type, options);
      element.dispatchEvent(event);
    } catch (_) {
      // 某些浏览器上下文没有 PointerEvent；继续走 MouseEvent / click。
    }
  }
  element.click?.();

  if (element.matches?.('input[type="checkbox"]')) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ----- 自动点击 Ant Design / 页面内确认弹窗 -----
async function clickConfirmDialog(timeoutMs) {
  const startTime = Date.now();
  const confirmTexts = ['确定', '确认', 'OK', 'Ok', 'ok', 'Yes', 'YES'];

  while (Date.now() - startTime <= timeoutMs) {
    const buttons = Array.from(document.querySelectorAll(
      '.ant-modal-confirm-btns button, .ant-modal button, .ant-popconfirm-buttons button, [role="dialog"] button'
    ));

    const confirmButton = buttons.find((button) => {
      const text = (button.textContent || '').trim();
      const className = button.className || '';
      return confirmTexts.includes(text)
        || button.matches('.ant-btn-primary')
        || String(className).includes('ant-btn-primary');
    });

    if (confirmButton) {
      dispatchUserClick(confirmButton);
      return true;
    }

    await sleep(200);
  }

  return false;
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

function getNextMidnightTimestamp() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(0, 1, 0, 0);
  return next.getTime();
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
  const picker = input.closest('.ant-picker') || input;
  const hadReadonly = input.hasAttribute('readonly');

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

  const okButton = document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-ok button:not([disabled])');
  if (okButton) {
    okButton.click();
    await sleep(300);
  }

  if (hadReadonly) input.setAttribute('readonly', '');

  return input.value === value;
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
async function setPagePowerOffTimer(totalMinutes) {
  console.log(`[AC扩展] 尝试设置页面定时器: ${totalMinutes} 分钟`);

  try {
    const requestedMinutes = Math.max(1, parseInt(totalMinutes, 10) || 1);
    const now = new Date();
    const target = new Date(now.getTime() + requestedMinutes * 60000);
    const crossesMidnight = target.toDateString() !== now.toDateString();

    if (crossesMidnight) {
      return {
        success: false,
        crossesMidnight: true,
        retryAt: getNextMidnightTimestamp(),
        error: '页面定时器只能选择当天时间，跨日 PWM 将由扩展闹钟继续执行'
      };
    }

    const pickerInput = findPowerOffTimerInput();
    if (!pickerInput) {
      return { success: false, error: '未找到页面定时器输入框' };
    }

    const hours = target.getHours();
    const mins = target.getMinutes();
    const value = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

    console.log(`[AC扩展] 模拟手动输入页面关机时间: ${value} (${requestedMinutes} 分钟后)`);

    const typed = await typeTimeIntoPickerInput(pickerInput, value);
    if (!typed) {
      return { success: false, error: `输入框未接受时间 ${value}` };
    }

    return {
      success: true,
      hours,
      minutes: mins,
      requestedMinutes,
      actualDelayMinutes: requestedMinutes,
      crossesMidnight: false,
      value: pickerInput.value || value
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// 找到 "Power-off after" 旁的定时器输入框
function findPowerOffTimerInput() {
  // 方法1: 通过 "Power-off after" 文本定位
  const labels = Array.from(document.querySelectorAll('small, div, span'));
  for (const label of labels) {
    if (label.children.length === 0 && /power.off\s*after/i.test(label.textContent || '')) {
      // 向上找到包含 ant-picker 的容器
      let container = label.parentElement;
      for (let i = 0; i < 8 && container; i++) {
        const input = container.querySelector('.ant-picker input');
        if (input) return input;
        container = container.parentElement;
      }
    }
  }

  // 方法2: 直接找页面上唯一的 ant-picker input
  const pickerInputs = document.querySelectorAll('.ant-picker input');
  if (pickerInputs.length === 1) return pickerInputs[0];

  // 方法3: 在包含 "Power-off" 文本的附近区域找
  const body = document.body.textContent || '';
  if (/power.off\s*after/i.test(body)) {
    for (const input of pickerInputs) {
      const parentText = (input.closest('[style*="flex"]') || input.parentElement?.parentElement?.parentElement)?.textContent || '';
      if (/power.off/i.test(parentText)) return input;
    }
  }

  return pickerInputs.length > 0 ? pickerInputs[0] : null;
}

// 等待 Ant Design 下拉面板出现
function waitForDropdown(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const panel = document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)');
      if (panel) {
        resolve(panel);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, 200);
    }
    check();
  });
}

// 在时间列中选中指定项
async function selectTimeColumnItem(column, targetValue) {
  const normalized = String(targetValue);
  const padded = normalized.padStart(2, '0');

  function findAndClick() {
    const cells = column.querySelectorAll('.ant-picker-time-panel-cell');
    for (const cell of cells) {
      const text = (cell.textContent || '').trim();
      const disabled = cell.classList.contains('ant-picker-time-panel-cell-disabled');
      if (!disabled && (text === normalized || text === padded)) {
        const inner = cell.querySelector('.ant-picker-time-panel-cell-inner') || cell;
        inner.scrollIntoView?.({ block: 'center' });
        inner.click();
        return true;
      }
    }
    return false;
  }

  if (findAndClick()) return true;

  // Ant Design 时间列可能需要先滚动到目标项再点击
  const scroller = column.matches('ul') ? column : (column.querySelector('ul') || column);
  const firstCell = column.querySelector('.ant-picker-time-panel-cell');
  const estimatedIndex = parseInt(normalized, 10);
  const cellHeight = firstCell?.offsetHeight || 28;
  if (scroller && Number.isFinite(estimatedIndex)) {
    scroller.scrollTop = Math.max(0, estimatedIndex * cellHeight);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(250);
  }

  return findAndClick();
}

function getBalanceInfo() {
  return { error: '余额读取已停用' };
}
