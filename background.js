// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

const AC_PAGE = 'https://w5.ab.ust.hk/njggt/app/home';
const STORAGE_KEY = 'ac_schedule';

let schedule = {
  enabled: false,
  mode: 'pwm',
  clockMode: true,  // true=基于实际钟表整点(单数开/双数关), false=传统相对间隔
  onMinutes: 60,    // 时钟模式下固定 60；间隔模式下默认开分钟数
  offMinutes: 60,   // 时钟模式下固定 60；间隔模式下默认关分钟数
  pwmState: 'off',  // 下一次闹钟触发后要切换到的目标状态
  alarmCreatedAt: 0,      // 闹钟创建时的时间戳 (ms) — 时钟模式不使用
  alarmDelayMinutes: 0,   // 闹钟设定的延迟 (分钟) — 时钟模式不使用
  pageTimerMinutes: null,
  pageTimerError: '',
  pageTimerRetryAt: 0
};

let pwmStepRunning = false;

// ----- 时钟模式辅助函数 -----
function getNextHourBoundary(fromMs = Date.now()) {
  const d = new Date(fromMs);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

function getHourAction(timestamp = Date.now()) {
  // 单数整点(1,3,5,...,23) → ON；双数整点(0,2,4,...,22) → OFF
  const hour = new Date(timestamp).getHours();
  return (hour % 2 === 1) ? 'on' : 'off';
}

function isClockMode() {
  return !!(schedule.clockMode && schedule.mode === 'pwm');
}

async function createAlarm(name, info) {
  // Edge/Chrome MV3 的 chrome.alarms.create 不支持 persistAcrossSessions。
  // 闹钟本身会由浏览器保存；重启后再由 init()/watchdog 从 storage 恢复。
  const { persistAcrossSessions, ...safeInfo } = info || {};
  await chrome.alarms.create(name, safeInfo);
}

async function loadScheduleFromStorage() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (saved[STORAGE_KEY]) {
    schedule = { ...schedule, ...saved[STORAGE_KEY] };
  }
  return schedule;
}

async function ensurePulseAlarm() {
  // delayInMinutes: 0.5 在部分 Edge 版本中仍不支持，兜底用 1 分钟
  const existing = await chrome.alarms.get('ac-pwm-pulse');
  if (!existing) {
    await createAlarm('ac-pwm-pulse', { delayInMinutes: 1 });
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

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ----- 初始化就绪信号（防止消息处理器在 init 完成前执行）-----
let initResolve;
const initReady = new Promise(resolve => { initResolve = resolve; });

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
  if (!schedule.enabled) return;
  await ensurePulseAlarm();
  const alarm = await chrome.alarms.get('ac-pwm');
  if (!alarm) {
    console.warn('[AC扩展] 看门狗：PWM 闹钟缺失，补执行当前整点动作');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  } else if (alarm.scheduledTime <= Date.now() - 60000) {
    console.warn('[AC扩展] 看门狗：PWM 闹钟已过期，触发执行...');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }
}

async function pwmPulseCheck() {
  await loadScheduleFromStorage();
  if (!schedule.enabled) return;

  await ensurePulseAlarm();
  await updateBadge();

  // 时钟模式：检查闹钟是否还在，若已过期则补执行被跳过的动作
  if (isClockMode()) {
    const alarm = await chrome.alarms.get('ac-pwm');
    if (!alarm || alarm.scheduledTime <= Date.now() - 60000) {
      console.warn('[AC扩展] PWM 心跳：时钟模式闹钟缺失/过期，补执行当前整点动作');
      await runPwmStep();
    }
    return;
  }

  // 传统间隔模式
  const hasClock = schedule.alarmCreatedAt && schedule.alarmDelayMinutes;
  const dueAt = hasClock ? schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000 : 0;

  if (!hasClock) {
    console.warn('[AC扩展] PWM 心跳：storage 中无倒计时，重建闹钟');
    await repairScheduleClock();
    return;
  }

  if (dueAt <= Date.now()) {
    console.warn('[AC扩展] PWM 心跳：检测到已到期，执行 PWM 步骤');
    await runPwmStep();
    return;
  }

  const alarm = await chrome.alarms.get('ac-pwm');
  if (!alarm || alarm.scheduledTime <= Date.now() - 60000) {
    const remainingMinutes = Math.max(1, (dueAt - Date.now()) / 60000);
    await createAlarm('ac-pwm', { delayInMinutes: remainingMinutes });
    console.warn(`[AC扩展] PWM 心跳：主闹钟缺失/过期，已恢复，剩余 ${remainingMinutes.toFixed(2)} 分钟`);
  }
}

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  try {
    await loadScheduleFromStorage();
    await ensureOffscreen();
    startHeartbeat();
    await setupAlarms();
    await updateBadge();
    await ensurePulseAlarm();
    if (schedule.enabled) {
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    }
    if (schedule.enabled && schedule.pageTimerRetryAt && schedule.pageTimerRetryAt > Date.now()) {
      await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
    }
    console.log('[AC扩展] 初始化完成', schedule);
  } catch (e) {
    console.error('[AC扩展] 初始化失败，但仍允许消息处理:', e);
  } finally {
    initResolve();
  }
}

// ----- 设置/更新 PWM 循环闹钟 -----
async function setupAlarms(startImmediately = false) {
  if (!schedule.enabled) {
    await chrome.alarms.clear('ac-pwm');
    await chrome.alarms.clear('ac-pwm-pulse');
    await chrome.alarms.clear('ac-badge-tick');
    await updateBadge();
    console.log('[AC扩展] PWM 定时未启用');
    return;
  }

  await ensurePulseAlarm();
  schedule.onMinutes = sanitizeMinutes(schedule.onMinutes, 30);
  schedule.offMinutes = sanitizeMinutes(schedule.offMinutes, 30);

  if (startImmediately) {
    await chrome.alarms.clear('ac-pwm');
    schedule.pwmState = 'on';
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await runPwmStep();
    return;
  }

  // ----- 时钟模式：对齐到下一个整点 -----
  if (isClockMode()) {
    const nextBoundary = getNextHourBoundary();
    await chrome.alarms.clear('ac-pwm');
    await createAlarm('ac-pwm', { when: nextBoundary });
    // 设置 pwmState 为下一个整点应执行的动作
    schedule.pwmState = getHourAction(nextBoundary);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await updateBadge();
    const nextHour = new Date(nextBoundary).getHours();
    console.log(`[AC扩展] 时钟模式：下个整点 ${nextHour}:00，动作=${schedule.pwmState}`);
    return;
  }

  // ----- 传统间隔模式 -----
  const now = Date.now();
  const existingEnd = schedule.alarmCreatedAt && schedule.alarmDelayMinutes
    ? schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000
    : 0;
  const remainingMinutes = existingEnd > now
    ? Math.max(1, (existingEnd - now) / 60000)
    : null;

  if (remainingMinutes) {
    await createAlarm('ac-pwm', { delayInMinutes: remainingMinutes });
    await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await updateBadge();
    console.log(`[AC扩展] PWM 闹钟已恢复 - 剩余:${remainingMinutes.toFixed(2)}分钟`);
    return;
  }

  if (existingEnd && existingEnd <= now) {
    console.warn('[AC扩展] PWM 计划时间已过，立即补执行到期动作');
    await runPwmStep();
    return;
  }

  const existingAlarm = await chrome.alarms.get('ac-pwm');
  if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime > now) {
    await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
    await updateBadge();
    console.log('[AC扩展] 沿用浏览器中已有的 PWM 闹钟');
    return;
  }

  await repairScheduleClock();
  console.log('[AC扩展] PWM 闹钟缺失，已按当前状态重建');
}

function sanitizeMinutes(value, fallback) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes < 1) return fallback;
  return minutes;
}

async function updateBadge() {
  if (!schedule.enabled) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: '冷气定时控制' });
    return;
  }

  // 时钟模式：显示下一个整点
  if (isClockMode()) {
    const boundary = getNextHourBoundary();
    const remainingMs = boundary - Date.now();
    if (remainingMs <= 0) {
      await chrome.action.setBadgeText({ text: 'now' });
      await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      await chrome.action.setTitle({ title: '即将切换冷气状态' });
      return;
    }
    const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
    const badgeText = remainingMin > 999 ? '999+' : String(remainingMin);
    const nextAction = getHourAction(boundary);
    const nextHour = new Date(boundary).getHours();
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: nextAction === 'on' ? '#16a34a' : '#64748b' });
    await chrome.action.setTitle({
      title: `${nextHour}:00 ${nextAction === 'on' ? '开启' : '关闭'}冷气，约 ${remainingMin} 分钟后`
    });
    return;
  }

  // 传统间隔模式
  if (!schedule.alarmCreatedAt || !schedule.alarmDelayMinutes) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: '冷气定时控制' });
    return;
  }

  const nextAction = schedule.pwmState;
  const alarmEnd = schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000;
  const remainingMs = alarmEnd - Date.now();

  if (remainingMs <= 0) {
    await chrome.action.setBadgeText({ text: 'now' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    await chrome.action.setTitle({ title: `即将${nextAction === 'on' ? '开启' : '关闭'}冷气` });
    return;
  }

  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const badgeText = remainingMinutes > 999 ? '999+' : String(remainingMinutes);
  const currentOn = schedule.pwmState !== 'on';

  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({ color: currentOn ? '#16a34a' : '#64748b' });
  await chrome.action.setTitle({
    title: `${currentOn ? '冷气运行中' : '冷气已关闭'}，约 ${remainingMinutes} 分钟后自动${nextAction === 'on' ? '开启' : '关闭'}`
  });
}

async function runPwmStep() {
  if (!schedule.enabled) return;
  if (pwmStepRunning) {
    console.warn('[AC扩展] PWM 步骤已在执行，跳过重复触发');
    return;
  }
  pwmStepRunning = true;

  try {
    await loadScheduleFromStorage();
    if (!schedule.enabled) return;

    // ----- 时钟模式：基于整点判动作 -----
    if (isClockMode()) {
      const now = Date.now();
      const targetAction = getHourAction(now);
      const nextBoundary = getNextHourBoundary(now);

      // 写下一阶段：下个整点的动作
      schedule.pwmState = getHourAction(nextBoundary);
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;

      await chrome.alarms.clear('ac-pwm');
      await createAlarm('ac-pwm', { when: nextBoundary });
      await ensurePulseAlarm();
      await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      await updateBadge();

      const nextHour = new Date(nextBoundary).getHours();
      console.log(`[AC扩展] 时钟模式：当前 ${new Date(now).getHours()}:${String(new Date(now).getMinutes()).padStart(2,'0')} → ${targetAction}，下个整点 ${nextHour}:00 → ${schedule.pwmState}`);

      // 执行开关并独立验证
      const needOnClock = targetAction === 'on';
      let toggleOkClock = false;
      for (let retry = 0; retry < 3 && !toggleOkClock; retry++) {
        try {
          const tr = await toggleAC(targetAction);
          if (!tr?.success) schedule.pageTimerError = `自动${needOnClock?'开启':'关闭'}未确认`;
        } catch (e) {
          schedule.pageTimerError = `自动${needOnClock?'开启':'关闭'}异常：${e?.message||String(e)}`;
        }
        await sleep(3000);
        const actual = await getCurrentACStatus();
        if (typeof actual?.isOn === 'boolean' && actual.isOn === needOnClock) {
          toggleOkClock = true;
          schedule.pageTimerError = '';
        } else if (retry < 2) {
          console.warn(`[AC扩展] 时钟模式独立验证失败(重试${retry+1}/2)`);
        }
      }
      if (!toggleOkClock) schedule.pageTimerError = schedule.pageTimerError || '验证失败';
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });

      if (targetAction === 'on') {
        await setPageTimer(60);
      }
      return;
    }

    // ----- 传统间隔模式 -----
    const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
    const currentDuration = targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes;
    const nextState = targetAction === 'on' ? 'off' : 'on';
    const delay = Math.max(1, currentDuration);

    schedule.pwmState = nextState;
    schedule.alarmCreatedAt = Date.now();
    schedule.alarmDelayMinutes = delay;
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;

    await createAlarm('ac-pwm', { delayInMinutes: delay });
    const verify = await chrome.alarms.get('ac-pwm');
    if (!verify) {
      console.error('[AC扩展] PWM 闹钟创建失败，重试...');
      await createAlarm('ac-pwm', { delayInMinutes: delay });
    }
    await ensurePulseAlarm();
    await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await updateBadge();

    console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);
    
    // 执行开关并独立验证（最多重试 2 次，防 AntD 回滚假成功）
    const needOn = targetAction === 'on';
    let toggleOk = false;
    for (let retry = 0; retry < 3 && !toggleOk; retry++) {
      try {
        const toggleResult = await toggleAC(targetAction);
        if (!toggleResult?.success) {
          schedule.pageTimerError = `自动${needOn ? '开启' : '关闭'}未确认：${toggleResult?.error || '未知错误'}`;
        }
      } catch (e) {
        schedule.pageTimerError = `自动${needOn ? '开启' : '关闭'}异常：${e?.message || String(e)}`;
      }
      // 独立验证：等页面稳定后检查 AC 实际状态
      await sleep(3000);
      const actual = await getCurrentACStatus();
      if (typeof actual?.isOn === 'boolean' && actual.isOn === needOn) {
        toggleOk = true;
        schedule.pageTimerError = '';
        console.log(`[AC扩展] PWM 独立验证通过：AC=${needOn ? 'ON' : 'OFF'}`);
      } else if (retry < 2) {
        console.warn(`[AC扩展] PWM 独立验证失败(重试${retry+1}/2)：期望=${needOn?'ON':'OFF'} 实际=${actual?.isOn}`);
      }
    }
    if (!toggleOk) {
      schedule.pageTimerError = schedule.pageTimerError || `自动${needOn ? '开启' : '关闭'}验证失败`;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });

    if (targetAction === 'on') {
      await setPageTimer(schedule.onMinutes);
    }

    console.log(`[AC扩展] PWM 下一阶段:${nextState}，${currentDuration}分钟后触发`);
  } finally {
    pwmStepRunning = false;
  }
}

// ----- 设置页面自带定时器（安全网，自动关不用手动开）-----
async function setPageTimer(minutes) {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  if (tabs.length === 0) {
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = 'AC 页面未打开，无法设置页面关机保险';
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tabs[0].id, {
      action: 'setTimer',
      minutes
    });
    if (result?.success) {
      schedule.pageTimerMinutes = result.actualDelayMinutes || minutes;
      schedule.pageTimerError = '';
      schedule.pageTimerRetryAt = 0;
      await chrome.alarms.clear('ac-page-timer-retry');
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      console.log(`[AC扩展] 页面定时器已设置为 ${result.value || minutes} (安全网)`);
    } else if (result?.crossesMidnight) {
      schedule.pageTimerMinutes = null;
      schedule.pageTimerError = '跨日 PWM 已启用；页面关机保险将在午夜后自动补设';
      schedule.pageTimerRetryAt = result.retryAt || getNextPageTimerRetryAt();
      await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      console.log('[AC扩展] 页面定时器跨日，已安排午夜后补设');
    } else {
      schedule.pageTimerMinutes = null;
      schedule.pageTimerError = result?.error || '页面定时器设置失败';
      schedule.pageTimerRetryAt = 0;
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      console.warn('[AC扩展] 页面定时器设置失败:', schedule.pageTimerError);
    }
  } catch (e) {
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = e?.message || String(e);
    schedule.pageTimerRetryAt = 0;
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    console.warn('[AC扩展] 设置页面定时器异常:', e);
  }
}

// ----- 闹钟触发时执行 -----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Edge/Chrome 可能因为 alarm 唤醒 Service Worker。
  // 必须等 storage 恢复完成，否则 schedule.enabled 还是默认 false，会跳过自动关机。
  await initReady;
  await loadScheduleFromStorage();

  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);

  if (alarm.name === 'ac-pwm-pulse') {
    await pwmPulseCheck();
    // delayInMinutes 不支持 periodInMinutes，每次触发后重新创建
    await createAlarm('ac-pwm-pulse', { delayInMinutes: 1 });
    return;
  }
  
  if (alarm.name === 'ac-pwm') {
    // 旧闹钟去重：仅在传统间隔模式下检查（时钟模式不使用 alarmCreatedAt）
    if (!isClockMode() && alarm.scheduledTime && schedule.alarmCreatedAt && alarm.scheduledTime <= schedule.alarmCreatedAt + 1000) {
      console.warn('[AC扩展] 忽略已被补执行处理过的旧 PWM 闹钟');
      return;
    }
    try {
      await runPwmStep();
    } catch (e) {
      console.error('[AC扩展] PWM 步骤执行失败:', e);
      if (schedule.enabled) {
        if (isClockMode()) {
          await repairScheduleClock();
        } else {
          const delay = Math.max(1, schedule.pwmState === 'on' ? schedule.onMinutes : schedule.offMinutes);
          await createAlarm('ac-pwm', { delayInMinutes: delay });
          schedule.alarmCreatedAt = Date.now();
          schedule.alarmDelayMinutes = delay;
          await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
        }
      }
    }
  }

  if (alarm.name === 'ac-watchdog') {
    await watchdogCheck();
  }

  if (alarm.name === 'ac-badge-tick') {
    await updateBadge();
  }

  if (alarm.name === 'ac-page-timer-retry') {
    if (schedule.enabled && schedule.pwmState === 'off') {
      await setPageTimer(schedule.onMinutes);
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
async function ensureContentScriptLoaded(tabId) {
  try {
    // 尝试发一个轻量消息探测 content script 是否就绪
    await chrome.tabs.sendMessage(tabId, { action: 'status' });
    return true;
  } catch (_) {
    // content script 未加载，用 scripting API 强制注入
    // 关键：content.js 注入 ISOLATED world，page-confirm.js 必须注入 MAIN world
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
        injectImmediately: true
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['page-confirm.js'],
        world: 'MAIN',
        injectImmediately: true
      });
      console.log('[AC扩展] scripting.executeScript 兜底注入完成 (ISOLATED + MAIN)');
      // 注入后给一点时间初始化
      await sleep(2000);
      return true;
    } catch (e2) {
      console.error('[AC扩展] scripting.executeScript 兜底注入失败:', e2?.message);
      return false;
    }
  }
}

// ----- 切换 AC 状态 -----
async function toggleAC(action) {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  
  if (tabs.length > 0) {
    let tab = tabs[0];
    // Edge/Chrome 可能丢弃后台标签页以节省内存，content script 会被卸载。
    // 检测到 discarded 时先 reload 恢复，再执行操作。
    if (tab.discarded) {
      console.log('[AC扩展] 标签页已被浏览器丢弃，正在恢复...');
      await chrome.tabs.reload(tab.id);
      await waitForTabReady(tab.id, 30000);
      // reload 后 tab 对象可能过期，重新获取
      try { tab = await chrome.tabs.get(tab.id); } catch (_) { /* tab might be gone */ }
    }
    return waitUntil(_toggleOnExistingTab(tab, action));
  }

  console.log('[AC扩展] 没有打开页面，创建新标签...');
  const created = await chrome.tabs.create({ url: AC_PAGE, active: false });
  return waitUntil(_toggleOnNewTab(created?.id, action));
}

async function _toggleOnExistingTab(tab, action) {
  // 先探测 content script 是否就绪，未就绪则用 scripting 兜底注入
  const ready = await ensureContentScriptLoaded(tab.id);
  if (!ready) {
    return retryExistingTabToggle(tab.id, action, 'content script 注入失败');
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action });
    console.log(`[AC扩展] ${action} 命令返回:`, result);
    if (!result?.success) {
      console.warn('[AC扩展] 页面返回未确认，重试:', result);
      return retryExistingTabToggle(tab.id, action, result?.error || `${action} 命令未确认`);
    }
    return { success: true, tabId: tab.id, result };
  } catch (e) {
    console.error('[AC扩展] 发送消息失败，重试:', e?.message);
    return retryExistingTabToggle(tab.id, action, e?.message || String(e));
  }
}

async function _toggleOnNewTab(tabId, action) {
  return retryToggle(action, 4, tabId, true);
}

async function retryExistingTabToggle(tabId, action, originalError = '') {
  try {
    await chrome.tabs.reload(tabId);
    await waitForTabReady(tabId, 30000);
    await ensureContentScriptLoaded(tabId);
  } catch (e) {
    console.warn('[AC扩展] 刷新页面失败，尝试 scripting 兜底:', e?.message);
    await ensureContentScriptLoaded(tabId);
  }

  const result = await waitUntil(retryToggle(action, 4, tabId, false));
  if (!result?.success && originalError) {
    return { ...result, error: `${originalError}; 刷新重试后仍失败：${result?.error || '未知错误'}` };
  }
  return result;
}

async function retryToggle(action, retries, preferredTabId = null, closeAfterSuccess = false) {
  for (let i = 0; i < retries; i++) {
    const tab = await getReadyACTab(preferredTabId, 30000);
    if (!tab?.id) {
      console.log(`[AC扩展] 重试 ${i + 1} 未找到可用 AC 页面`);
      continue;
    }

    // 官方推荐：每次重试前确保 content script 已注入
    await ensureContentScriptLoaded(tab.id);

    try {
      const result = await chrome.tabs.sendMessage(tab.id, { action });
      if (!result?.success) {
        console.log(`[AC扩展] 重试 ${i + 1} 未确认:`, result);
        continue;
      }
      console.log(`[AC扩展] 重试成功 (${i + 1}/${retries})`);
      // 只关闭扩展自动创建的标签，不能关闭用户原本打开的 HKUST 页面。
      if (closeAfterSuccess && preferredTabId) {
        chrome.alarms.create(`ac-close-tab-${preferredTabId}`, { delayInMinutes: 1 });
      }
      return { success: true, tabId: tab.id, result };
    } catch (e) {
      console.log(`[AC扩展] 重试 ${i + 1} 失败:`, e?.message || String(e));
      await sleep(750);
    }
  }
  console.error('[AC扩展] 所有重试失败');
  return { success: false, error: 'AC 页面未就绪，无法完成开关操作' };
}

async function getReadyACTab(preferredTabId = null, timeoutMs = 30000) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (isACTab(tab)) {
        await waitForTabReady(tab.id, timeoutMs);
        return tab;
      }
    } catch (_) {
      // preferred tab 已关闭，回退到查询现有页面
    }
  }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const tab = tabs[0];
  if (!tab?.id) return null;
  await waitForTabReady(tab.id, timeoutMs);
  return tab;
}

async function waitForTabReady(tabId, timeoutMs = 30000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'complete' && isACTab(tab)) return true;

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
      if (changeInfo.status === 'complete' && isACTab(updatedTab)) {
        finish(true);
      }
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function isACTab(tab) {
  return !!tab?.url && tab.url.startsWith('https://w5.ab.ust.hk/njggt/app/');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getNextPageTimerRetryAt() {
  const retry = new Date();
  retry.setDate(retry.getDate() + 1);
  retry.setHours(0, 1, 0, 0);
  return retry.getTime();
}

async function getCurrentACStatus() {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  if (tabs.length === 0) {
    return { isOn: null, error: 'AC 页面未打开' };
  }
  try {
    return await chrome.tabs.sendMessage(tabs[0].id, { action: 'status' });
  } catch (e) {
    return { isOn: null, error: 'AC 页面未就绪' };
  }
}

async function ensureScheduleClock() {
  await loadScheduleFromStorage();
  if (!schedule.enabled) return;

  await ensurePulseAlarm();

  // 时钟模式：检查是否已有有效的未来闹钟
  if (isClockMode()) {
    const existingAlarm = await chrome.alarms.get('ac-pwm');
    if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime > Date.now()) {
      return;
    }
    // 闹钟缺失或已过期 → 补执行当前整点动作
    await runPwmStep();
    return;
  }

  // 传统间隔模式
  const existingAlarm = await chrome.alarms.get('ac-pwm');
  if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime > Date.now()) {
    return;
  }

  const hasClock = schedule.alarmCreatedAt && schedule.alarmDelayMinutes;
  const alarmEnd = hasClock ? schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000 : 0;

  if (alarmEnd > Date.now()) return;

  if (hasClock) {
    await runPwmStep();
    return;
  }

  await repairScheduleClock();
}

async function repairScheduleClock() {
  if (!schedule.enabled) {
    return { success: false, reason: '定时未启用', schedule };
  }

  // 时钟模式：对齐到下一个整点
  if (isClockMode()) {
    const nextBoundary = getNextHourBoundary();
    schedule.pwmState = getHourAction(nextBoundary);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await chrome.alarms.clear('ac-pwm');
    await createAlarm('ac-pwm', { when: nextBoundary });
    await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await updateBadge();
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status } };
  }

  // 传统间隔模式
  const status = await getCurrentACStatus();
  const currentOn = typeof status?.isOn === 'boolean'
    ? status.isOn
    : schedule.pwmState !== 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);

  schedule.pwmState = currentOn ? 'off' : 'on';
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = delay;

  await createAlarm('ac-pwm', { delayInMinutes: delay });
  const verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error('[AC扩展] repair: PWM 闹钟创建失败，重试...');
    await createAlarm('ac-pwm', { delayInMinutes: delay });
  }
  await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
  await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
  await updateBadge();

  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

async function getScheduleSnapshot() {
  await ensureScheduleClock();

  const alarm = await chrome.alarms.get('ac-pwm');
  let snapshot = { ...schedule };

  // 时钟模式：用整点边界时间
  if (isClockMode()) {
    const nextBoundary = getNextHourBoundary();
    snapshot.alarmCreatedAt = 0;
    snapshot.alarmDelayMinutes = 0;
    snapshot._nextBoundary = nextBoundary;
    snapshot._nextAction = getHourAction(nextBoundary);
    const status = await getCurrentACStatus();
    return { ...snapshot, actualStatus: status };
  }

  // 传统间隔模式
  if (schedule.enabled && alarm?.scheduledTime) {
    const remainingMs = alarm.scheduledTime - Date.now();
    if (remainingMs > 0) {
      snapshot.alarmCreatedAt = Date.now();
      snapshot.alarmDelayMinutes = remainingMs / 60000;
    }
  }

  const status = await getCurrentACStatus();
  // 自动纠偏：如果实际 AC 状态与 pwmState 推断不符，修正 pwmState
  if (typeof status?.isOn === 'boolean' && schedule.enabled) {
    const inferredOn = schedule.pwmState !== 'on'; // 下个动作是 on 说明当前是 off
    if (status.isOn !== inferredOn) {
      console.warn(`[AC扩展] 状态纠偏：推断=${inferredOn?'ON':'OFF'} 实际=${status.isOn?'ON':'OFF'}，修正 pwmState`);
      schedule.pwmState = status.isOn ? 'off' : 'on';
      snapshot.pwmState = schedule.pwmState;
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    }
  }
  return { ...snapshot, actualStatus: status };
}

async function toggleNowAndSync(action) {
  const toggleResult = await toggleAC(action);

  if (!toggleResult?.success) {
    return {
      success: false,
      error: toggleResult?.error || `${action} 命令未确认`,
      result: toggleResult,
      schedule
    };
  }

  if (!schedule.enabled) {
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status }, result: toggleResult };
  }

  // 时钟模式：手动切换后重新对齐到下一个整点
  if (isClockMode()) {
    const nextBoundary = getNextHourBoundary();
    schedule.pwmState = getHourAction(nextBoundary);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;
    await chrome.alarms.clear('ac-pwm');
    await createAlarm('ac-pwm', { when: nextBoundary });
    await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await updateBadge();
    if (action === 'on') {
      await setPageTimer(60);
    }
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status } };
  }

  // 传统间隔模式
  const currentOn = action === 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);
  schedule.pwmState = currentOn ? 'off' : 'on';
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = delay;
  schedule.pageTimerMinutes = null;
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;

  await createAlarm('ac-pwm', { delayInMinutes: delay });
  const verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error('[AC扩展] toggle: PWM 闹钟创建失败，重试...');
    await createAlarm('ac-pwm', { delayInMinutes: delay });
  }
  await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
  await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
  await updateBadge();

  if (currentOn) {
    await setPageTimer(schedule.onMinutes);
  }

  const status = await getCurrentACStatus();
  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // 等待 init() 完成，防止使用尚未从 storage 加载的默认 schedule
    await initReady;

    if (msg.type === 'updateSchedule') {
      const wasEnabled = schedule.enabled;
      const { restart, ...data } = msg.data;  // 防止 restart 泄漏到 schedule 对象中
      schedule = {
        ...schedule,
        ...data,
        mode: 'pwm',
        clockMode: data.clockMode !== undefined ? !!data.clockMode : schedule.clockMode,
        onMinutes: sanitizeMinutes(data.onMinutes ?? schedule.onMinutes, 30),
        offMinutes: sanitizeMinutes(data.offMinutes ?? schedule.offMinutes, 30)
      };

      let offResult = null;
      if (!schedule.enabled) {
        schedule.pwmState = 'off';
        schedule.alarmCreatedAt = 0;
        schedule.alarmDelayMinutes = 0;
        schedule.pageTimerMinutes = null;
        schedule.pageTimerError = '';
        schedule.pageTimerRetryAt = 0;
        await chrome.alarms.clear('ac-pwm');
        await chrome.alarms.clear('ac-pwm-pulse');
        await chrome.alarms.clear('ac-page-timer-retry');
        await chrome.alarms.clear('ac-badge-tick');
        await chrome.alarms.clear('ac-watchdog');
        await updateBadge();
        offResult = await toggleAC('off');
        if (!offResult?.success) {
          schedule.pageTimerError = `定时已关闭，但关机命令未确认：${offResult?.error || '未知错误'}`;
        }
      } else if (!wasEnabled || restart) {
        schedule.pwmState = 'on';
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      await setupAlarms(schedule.enabled && (!wasEnabled || restart));
      // 管理看门狗和每分钟 PWM 心跳闹钟
      if (schedule.enabled) {
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        await ensurePulseAlarm();
      }
      sendResponse({ success: true, schedule, offResult });
      return;
    }
    if (msg.type === 'getSchedule') {
      const snapshot = await getScheduleSnapshot();
      sendResponse(snapshot);
      return;
    }
    if (msg.type === 'repairSchedule') {
      const result = await repairScheduleClock();
      sendResponse(result);
      return;
    }
    if (msg.type === 'toggleNow') {
      const result = await toggleNowAndSync(msg.action);
      sendResponse(result);
      return;
    }
    if (msg.type === 'getBalance') {
      const balance = await getBalanceFromPage();
      sendResponse(balance);
      return;
    }
  })().catch((e) => {
    console.error('[AC扩展] 消息处理失败:', msg?.type, e);
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

// ----- 从页面读取余额 -----
async function getBalanceFromPage() {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  if (tabs.length === 0) {
    return { error: '请先打开 HKUST Power Meter 页面' };
  }
  try {
    const balance = await chrome.tabs.sendMessage(tabs[0].id, { action: 'balance' });
    return balance;
  } catch (e) {
    return { error: '无法读取余额，请刷新页面后重试' };
  }
}

// ----- 启动/恢复兜底 -----
chrome.runtime.onStartup.addListener(() => {
  console.log('[AC扩展] 浏览器启动，恢复 PWM 闹钟');
  initReady.then(() => setupAlarms()).catch(e => console.error('[AC扩展] onStartup 恢复失败:', e));
});

// ----- 官方推荐：首次安装/更新时初始化 -----
chrome.runtime.onInstalled.addListener(async (details) => {
  await initReady;
  if (details.reason === 'install') {
    // 首次安装：写默认设置
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        enabled: false,
        mode: 'pwm',
        clockMode: true,
        onMinutes: 60,
        offMinutes: 60,
        pwmState: 'off',
        alarmCreatedAt: 0,
        alarmDelayMinutes: 0
      }
    });
    console.log('[AC扩展] 首次安装，已设置默认值（时钟模式）');
  } else if (details.reason === 'update') {
    console.log(`[AC扩展] 已更新（${details.previousVersion} → ${chrome.runtime.getManifest().version}）`);
  }
});

// ----- 官方推荐：检测到新版本自动热更新 -----
chrome.runtime.onUpdateAvailable.addListener(() => {
  console.log('[AC扩展] 检测到新版本，自动重新加载...');
  chrome.runtime.reload();
});

// ----- storage 变动监听：只同步内存状态 -----
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY]?.newValue) return;
  // 只同步内存状态。不要在每次 storage 写入后 setupAlarms，
  // 否则 runPwmStep 写入下一阶段倒计时时会反复重建闹钟，影响无弹窗后台执行。
  schedule = { ...schedule, ...changes[STORAGE_KEY].newValue };
});

// ----- 启动 -----
init();
