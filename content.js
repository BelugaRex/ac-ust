// ============================================================
// Content Script - 注入到 w5.ab.ust.hk/njggt/app/* 页面
// 负责隔离世界状态读取，并把开关目标委派给主世界 page-confirm.js
// ============================================================

// 幂等守卫：scripting.executeScript 兜底可能与 manifest content_scripts
// 在同一隔离世界重复执行本文件，导致 onMessage 监听器重复注册或顶层 const
// 重声明抖动。包进 IIFE + 哨兵，对齐 page-confirm.js 的 __AC_EXTENSION_TOGGLE_PATCHED__ 范式。
(() => {
if (self.__AC_CONTENT_LOADED__) return;
self.__AC_CONTENT_LOADED__ = true;

// i18n — content script 运行在隔离世界，不能 importScripts，用内联 fetch loader
const _i18nCache = {};
let _i18nReady = false;
async function _i18nLoad() {
  if (_i18nReady) return;
  try {
    const ui = (chrome.i18n?.getUILanguage?.() || 'zh_CN').replace('-', '_');
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

// ----- 监听来自 background 的消息 -----
// 触发 i18n 加载（不阻塞，翻译加载失败不影响核心功能）
_i18nLoad();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'on' || msg.action === 'off') {
    toggleACSwitch(msg.action).then(result => sendResponse(result));
    return true; // 异步响应
  }
  if (msg.action === 'status') {
    getAuthoritativeACStatus().then(result => sendResponse(result));
    return true;
  }
  if (msg.action === 'setTimer') {
    setPagePowerOffTimer(msg.minutes).then(result => sendResponse(result));
    return true;
  }
  if (msg.action === 'getPageTimer') {
    // v0.5.10：读 picker 当前值——跨设备主同步通道（UST 服务器同步给所有会话）
    sendResponse(getPagePowerOffTimer());
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

async function getAuthoritativeACStatus() {
  const mainWorldStatus = await requestMainWorldStatus(3000);
  if (typeof mainWorldStatus?.isOn === 'boolean') {
    return { ...mainWorldStatus, via: 'main-world' };
  }

  const isolatedStatus = getACStatus();
  if (typeof isolatedStatus?.isOn === 'boolean') {
    return mainWorldStatus?.error
      ? { ...isolatedStatus, fallbackError: mainWorldStatus.error, via: 'isolated-fallback' }
      : isolatedStatus;
  }

  return mainWorldStatus?.error
    ? { ...isolatedStatus, fallbackError: mainWorldStatus.error }
    : isolatedStatus;
}

// ----- 切换 AC 开关 -----
  async function toggleACSwitch(targetAction) {
  console.log(`[AC扩展] 准备切换 AC: ${targetAction}`);

  // 隔离世界只确认页面已渲染，然后把目标状态交给主世界 ensureACState()。
  // 状态预检、单次 click、10 秒等待与递归复查全部由主世界统一负责。
  const switchEl = await waitForSwitch(10000);
  if (!switchEl) {
    return { success: false, error: t('contentTimeout') };
  }

  const mainWorldResult = await requestMainWorldToggle(targetAction, 65000);

  if (mainWorldResult?.success) {
    console.log('[AC扩展] 主世界切换成功:', mainWorldResult);
    return mainWorldResult;
  }

  // 主世界失败后不在隔离世界接力点击；下一步只交给后台延迟重试。
  console.warn('[AC扩展] 主世界切换未成功，隔离世界不再接力点击（避免双切噪音）:', mainWorldResult || 'null');
  return {
    success: false,
    action: targetAction,
    verified: false,
    via: 'isolated-delegated-to-main',
    mainWorldResult,
    error: mainWorldResult?.error || t('contentRetryExhausted', targetAction)
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

async function requestMainWorldStatus(timeoutMs) {
  return new Promise((resolve) => {
    const requestId = `ac-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let done = false;

    const cleanup = () => {
      window.removeEventListener('__AC_EXTENSION_GET_STATUS_RESULT__', onResult);
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

    window.addEventListener('__AC_EXTENSION_GET_STATUS_RESULT__', onResult);
    window.dispatchEvent(new CustomEvent('__AC_EXTENSION_GET_STATUS__', {
      detail: { requestId }
    }));

    setTimeout(() => finish({ isOn: null, error: '主世界状态读取超时' }), timeoutMs);
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

    const pickerInput = findPowerOffTimerInput();
    if (!pickerInput) {
      return { success: false, error: t('contentNoInput') };
    }

    const hours = target.getHours();
    const mins = target.getMinutes();
    const value = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

    console.log(`[AC扩展] 模拟手动输入页面关机时间: ${value} (${requestedMinutes} 分钟后${crossesMidnight ? '，跨午夜' : ''})`);

    const typed = await typeTimeIntoPickerInput(pickerInput, value);
    if (!typed) {
      return { success: false, error: t('contentInputRejected', String(value)) };
    }

    const confirmedValue = (pickerInput.value || pickerInput.getAttribute('title') || value).trim();
    return {
      success: true,
      hours,
      minutes: mins,
      requestedMinutes,
      actualDelayMinutes: requestedMinutes,
      crossesMidnight,
      value: confirmedValue,
      title: (pickerInput.getAttribute('title') || '').trim()
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
