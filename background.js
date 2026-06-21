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

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (saved[STORAGE_KEY]) {
    schedule = { ...schedule, ...saved[STORAGE_KEY] };
  }
  await setupAlarms();
  await updateBadge();
  if (schedule.enabled && schedule.pageTimerRetryAt && schedule.pageTimerRetryAt > Date.now()) {
    await chrome.alarms.create('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
  }
  console.log('[AC扩展] 初始化完成', schedule);
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
    await chrome.alarms.create('ac-pwm', {
      delayInMinutes: remainingMinutes
    });
    await chrome.alarms.create('ac-badge-tick', { periodInMinutes: 1 });
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await updateBadge();
    console.log(`[AC扩展] PWM 闹钟已恢复 - 剩余:${remainingMinutes.toFixed(2)}分钟`);
    return;
  }

  const existingAlarm = await chrome.alarms.get('ac-pwm');
  if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime > now) {
    await chrome.alarms.create('ac-badge-tick', { periodInMinutes: 1 });
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

  await chrome.alarms.create('ac-pwm', {
    delayInMinutes: delay
  });
  // 验证 alarm 确实创建成功
  const verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error('[AC扩展] PWM 闹钟创建失败，重试...');
    await chrome.alarms.create('ac-pwm', { delayInMinutes: delay });
  }
  await chrome.alarms.create('ac-badge-tick', { periodInMinutes: 1 });
  await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
  await updateBadge();

  console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);
  await toggleAC(targetAction);

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
      await chrome.alarms.create('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
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
  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);
  
  if (alarm.name === 'ac-pwm') {
    try {
      await runPwmStep();
    } catch (e) {
      console.error('[AC扩展] PWM 步骤执行失败:', e);
      // 紧急修复：重新创建闹钟防止循环中断
      if (schedule.enabled) {
        const delay = Math.max(1, schedule.pwmState === 'on' ? schedule.onMinutes : schedule.offMinutes);
        await chrome.alarms.create('ac-pwm', { delayInMinutes: delay });
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = delay;
        await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
      }
    }
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
      await chrome.tabs.sendMessage(tab.id, { action: action });
      console.log(`[AC扩展] 已发送 ${action} 命令到页面`);
    } catch (e) {
      console.error('[AC扩展] 发送消息失败', e);
    }
  } else {
    // 没有打开的页面，打开新标签
    console.log('[AC扩展] 没有打开页面，创建新标签...');
    await chrome.tabs.create({ url: AC_PAGE, active: false });
    // 页面打开后 content script 会自动执行，我们需要等待它加载
    // 通过延迟重试机制
    retryToggle(action, 3);
  }
}

async function retryToggle(action, retries) {
  for (let i = 0; i < retries; i++) {
    await sleep(5000); // 等5秒让页面加载
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    if (tabs.length > 0) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { action: action });
        console.log(`[AC扩展] 重试成功 (${i + 1}/${retries})`);
        // 关闭自动打开的标签
        setTimeout(() => chrome.tabs.remove(tabs[0].id), 60000);
        return;
      } catch (e) {
        console.log(`[AC扩展] 重试 ${i + 1} 失败`);
      }
    }
  }
  console.error('[AC扩展] 所有重试失败');
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

  await chrome.alarms.create('ac-pwm', { delayInMinutes: delay });
  const verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error('[AC扩展] repair: PWM 闹钟创建失败，重试...');
    await chrome.alarms.create('ac-pwm', { delayInMinutes: delay });
  }
  await chrome.alarms.create('ac-badge-tick', { periodInMinutes: 1 });
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
  await toggleAC(action);

  if (!schedule.enabled) {
    return { success: true, schedule };
  }

  const currentOn = action === 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);
  schedule.pwmState = currentOn ? 'off' : 'on';
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = delay;
  schedule.pageTimerMinutes = null;
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;

  await chrome.alarms.create('ac-pwm', { delayInMinutes: delay });
  const verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error('[AC扩展] toggle: PWM 闹钟创建失败，重试...');
    await chrome.alarms.create('ac-pwm', { delayInMinutes: delay });
  }
  await chrome.alarms.create('ac-badge-tick', { periodInMinutes: 1 });
  await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
  await updateBadge();

  if (currentOn) {
    await setPageTimer(schedule.onMinutes);
  }

  const status = await getCurrentACStatus();
  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

// ----- 监听来自 popup 的消息 -----
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg.type === 'updateSchedule') {
    const wasEnabled = schedule.enabled;
    schedule = {
      ...schedule,
      ...msg.data,
      mode: 'pwm',
      onMinutes: sanitizeMinutes(msg.data?.onMinutes ?? schedule.onMinutes, 30),
      offMinutes: sanitizeMinutes(msg.data?.offMinutes ?? schedule.offMinutes, 30)
    };

    if (!schedule.enabled) {
      schedule.pwmState = 'off';
      schedule.alarmCreatedAt = 0;
      schedule.alarmDelayMinutes = 0;
      schedule.pageTimerMinutes = null;
      schedule.pageTimerError = '';
      schedule.pageTimerRetryAt = 0;
      await chrome.alarms.clear('ac-page-timer-retry');
      await chrome.alarms.clear('ac-badge-tick');
      await updateBadge();
      await toggleAC('off');
    } else if (!wasEnabled || msg.data?.restart) {
      schedule.pwmState = 'on';
    }

    chrome.storage.local.set({ [STORAGE_KEY]: schedule }).then(async () => {
      await setupAlarms(schedule.enabled && (!wasEnabled || msg.data?.restart));
      sendResponse({ success: true, schedule });
    });
    return true;
  }
  if (msg.type === 'getSchedule') {
    getScheduleSnapshot().then(snapshot => sendResponse(snapshot));
    return true;
  }
  if (msg.type === 'repairSchedule') {
    repairScheduleClock().then(result => sendResponse(result));
    return true;
  }
  if (msg.type === 'toggleNow') {
    toggleNowAndSync(msg.action).then(result => sendResponse(result));
    return true; // 异步响应
  }
  if (msg.type === 'getBalance') {
    getBalanceFromPage().then(balance => sendResponse(balance));
    return true;
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
