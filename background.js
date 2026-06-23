// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

const AC_PAGE = 'https://w5.ab.ust.hk/njggt/app/home';
const STORAGE_KEY = 'ac_schedule';

let schedule = {
  enabled: false,
  mode: 'pwm',
  onMinutes: 30,   // 默认开 30 分钟
  offMinutes: 30,  // 默认关 30 分钟
  pwmState: 'off', // 下一次闹钟触发后要切换到的目标状态
  alarmCreatedAt: 0,      // 闹钟创建时的时间戳 (ms)
  alarmDelayMinutes: 0,   // 闹钟设定的延迟 (分钟)
  pageTimerMinutes: null, // 页面定时器已设的分钟数 (null=未设置)
  pageTimerError: '',     // 页面定时器失败原因
  pageTimerRetryAt: 0     // 跨日时，午夜后重试设置页面定时器的时间戳
};

async function createAlarm(name, info) {
  // Edge/Chrome MV3 的 chrome.alarms.create 不支持 persistAcrossSessions。
  // 闹钟本身会由浏览器保存；重启后再由 init()/watchdog 从 storage 恢复。
  const { persistAcrossSessions, ...safeInfo } = info || {};
  await chrome.alarms.create(name, safeInfo);
}

// ----- 初始化就绪信号（防止消息处理器在 init 完成前执行）-----
let initResolve;
const initReady = new Promise(resolve => { initResolve = resolve; });

// ----- 保活：创建 Offscreen Document 维持 SW 不休眠 -----
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
  if (!schedule.enabled) return;
  const alarm = await chrome.alarms.get('ac-pwm');
  if (!alarm) {
    console.warn('[AC扩展] 看门狗：PWM 闹钟缺失，正在重建...');
    await repairScheduleClock();
  } else if (alarm.scheduledTime <= Date.now() - 60000) {
    console.warn('[AC扩展] 看门狗：PWM 闹钟已过期，触发执行...');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }
}

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  try {
    const saved = await chrome.storage.local.get(STORAGE_KEY);
    if (saved[STORAGE_KEY]) {
      schedule = { ...schedule, ...saved[STORAGE_KEY] };
    }
    await ensureOffscreen();
    await setupAlarms();
    await updateBadge();
    if (schedule.enabled) {
      // 看门狗闹钟：每 5 分钟检查 PWM 闹钟是否还在
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    }
    if (schedule.enabled && schedule.pageTimerRetryAt && schedule.pageTimerRetryAt > Date.now()) {
      await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
    }
    console.log('[AC扩展] 初始化完成', schedule);
  } catch (e) {
    // 不能让初始化异常卡死 initReady，否则 popup 会一直拿不到真实 storage 状态。
    console.error('[AC扩展] 初始化失败，但仍允许消息处理:', e);
  } finally {
    initResolve();
  }
}

// ----- 设置/更新 PWM 循环闹钟 -----
async function setupAlarms(startImmediately = false) {
  if (!schedule.enabled) {
    await chrome.alarms.clear('ac-pwm');
    await chrome.alarms.clear('ac-badge-tick');
    await updateBadge();
    console.log('[AC扩展] PWM 定时未启用');
    return;
  }

  schedule.onMinutes = sanitizeMinutes(schedule.onMinutes, 30);
  schedule.offMinutes = sanitizeMinutes(schedule.offMinutes, 30);
  schedule.mode = 'pwm';

  if (startImmediately) {
    await chrome.alarms.clear('ac-pwm');
    schedule.pwmState = 'on';
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await runPwmStep();
    return;
  }

  const now = Date.now();
  const existingEnd = schedule.alarmCreatedAt && schedule.alarmDelayMinutes
    ? schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000
    : 0;
  const remainingMinutes = existingEnd > now
    ? Math.max(1, (existingEnd - now) / 60000)
    : null;

  if (remainingMinutes) {
    await createAlarm('ac-pwm', {
      delayInMinutes: remainingMinutes
    });
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
  if (!schedule.enabled || !schedule.alarmCreatedAt || !schedule.alarmDelayMinutes) {
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

  const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
  const currentDuration = targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes;
  const nextState = targetAction === 'on' ? 'off' : 'on';
  const delay = Math.max(1, currentDuration);

  // 先写入下一阶段倒计时，再操作页面。
  // 这样 popup 一打开就能看到倒计时，不会因为页面操作慢显示“同步中”。
  schedule.pwmState = nextState;
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = delay;
  schedule.pageTimerMinutes = null;
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;

  await createAlarm('ac-pwm', {
    delayInMinutes: delay
  });
  // 验证 alarm 确实创建成功
  const verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error('[AC扩展] PWM 闹钟创建失败，重试...');
    await createAlarm('ac-pwm', { delayInMinutes: delay });
  }
  await createAlarm('ac-badge-tick', { periodInMinutes: 1 });
  await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
  await updateBadge();

  console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);
  
  // 切换 AC 状态——即使失败也不影响闹钟（闹钟已创建），但要记录失败原因。
  try {
    const toggleResult = await toggleAC(targetAction);
    if (!toggleResult?.success) {
      schedule.pageTimerError = `自动${targetAction === 'on' ? '开启' : '关闭'}未确认：${toggleResult?.error || '未知错误'}`;
      await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      console.warn('[AC扩展] PWM 切换未确认:', toggleResult);
    }
  } catch (e) {
    schedule.pageTimerError = `自动${targetAction === 'on' ? '开启' : '关闭'}异常：${e?.message || String(e)}`;
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    console.error('[AC扩展] toggleAC 失败（闹钟不受影响）:', e?.message);
  }

  // 开启冷气时同步设置页面定时器作为保险。
  // 页面保险失败也不影响 PWM 循环。
  if (targetAction === 'on') {
    await setPageTimer(schedule.onMinutes);
  }

  console.log(`[AC扩展] PWM 下一阶段:${nextState}，${currentDuration}分钟后触发`);
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

  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);
  
  if (alarm.name === 'ac-pwm') {
    // 如果 init()/watchdog 已经因为过期补执行过一次，旧 alarm 事件可能随后才送达。
    // 此时 alarm.scheduledTime 会早于新的 alarmCreatedAt，必须忽略，避免 off 后立刻又 on。
    if (alarm.scheduledTime && schedule.alarmCreatedAt && alarm.scheduledTime <= schedule.alarmCreatedAt + 1000) {
      console.warn('[AC扩展] 忽略已被补执行处理过的旧 PWM 闹钟');
      return;
    }
    try {
      await runPwmStep();
    } catch (e) {
      console.error('[AC扩展] PWM 步骤执行失败:', e);
      // 紧急修复：重新创建闹钟防止循环中断
      if (schedule.enabled) {
        const delay = Math.max(1, schedule.pwmState === 'on' ? schedule.onMinutes : schedule.offMinutes);
        await createAlarm('ac-pwm', { delayInMinutes: delay });
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = delay;
        await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
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
});

// ----- 切换 AC 状态 -----
async function toggleAC(action) {
  // 查找已打开的页面
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  
  if (tabs.length > 0) {
    // 在已有页面上执行
    const tab = tabs[0];
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { action: action });
      console.log(`[AC扩展] ${action} 命令返回:`, result);
      if (!result?.success) {
        console.warn('[AC扩展] 页面返回未确认，刷新页面后重试:', result);
        return retryExistingTabToggle(tab.id, action, result?.error || `${action} 命令未确认`);
      }
      return { success: true, tabId: tab.id, result };
    } catch (e) {
      console.error('[AC扩展] 发送消息失败，可能是页面未注入 content script，刷新页面后重试', e);
      return retryExistingTabToggle(tab.id, action, e?.message || String(e));
    }
  }

  // 没有打开的页面，打开新标签并等待 content script 就绪后执行。
  // 关闭“启用定时”时也必须尽力关机，不能只异步排队后立刻返回成功。
  console.log('[AC扩展] 没有打开页面，创建新标签...');
  const created = await chrome.tabs.create({ url: AC_PAGE, active: false });
  return retryToggle(action, 3, created?.id, true);
}

async function retryExistingTabToggle(tabId, action, originalError = '') {
  try {
    await chrome.tabs.reload(tabId);
  } catch (e) {
    console.warn('[AC扩展] 刷新页面失败，仍尝试直接重试:', e?.message);
  }

  const result = await retryToggle(action, 4, tabId, false);
  if (!result?.success && originalError) {
    return { ...result, error: `${originalError}; 刷新重试后仍失败：${result?.error || '未知错误'}` };
  }
  return result;
}

async function retryToggle(action, retries, preferredTabId = null, closeAfterSuccess = false) {
  for (let i = 0; i < retries; i++) {
    await sleep(5000); // 等5秒让页面加载
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    if (tabs.length > 0) {
      const tab = preferredTabId
        ? (tabs.find(t => t.id === preferredTabId) || tabs[0])
        : tabs[0];
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { action: action });
        if (!result?.success) {
          console.log(`[AC扩展] 重试 ${i + 1} 未确认:`, result);
          continue;
        }
        console.log(`[AC扩展] 重试成功 (${i + 1}/${retries})`);
        // 只关闭扩展自动创建的标签，不能关闭用户原本打开的 HKUST 页面。
        if (closeAfterSuccess && preferredTabId) setTimeout(() => chrome.tabs.remove(preferredTabId), 60000);
        return { success: true, tabId: tab.id, result };
      } catch (e) {
        console.log(`[AC扩展] 重试 ${i + 1} 失败`);
      }
    }
  }
  console.error('[AC扩展] 所有重试失败');
  return { success: false, error: 'AC 页面未就绪，无法完成开关操作' };
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
  if (!schedule.enabled) return;

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

  if (schedule.enabled && alarm?.scheduledTime) {
    const remainingMs = alarm.scheduledTime - Date.now();
    if (remainingMs > 0) {
      snapshot.alarmCreatedAt = Date.now();
      snapshot.alarmDelayMinutes = remainingMs / 60000;
    }
  }

  const status = await getCurrentACStatus();
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
      // 管理看门狗闹钟
      if (schedule.enabled) {
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
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

// ----- 启动 -----
init();
