// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

// i18n 辅助函数
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.length ? subs : undefined) || key;

const AC_PAGE = 'https://w5.ab.ust.hk/njggt/app/home';
const STORAGE_KEY = 'ac_schedule';

let schedule = {
  enabled: false,
  mode: 'pwm',
  clockMode: true,  // true=基于实际钟表整点(单数开/双数关), false=传统相对间隔
  onMinutes: 60,    // 时钟模式下固定 60；间隔模式下默认开分钟数
  offMinutes: 60,   // 时钟模式下固定 60；间隔模式下默认关分钟数
  pwmState: 'off',  // 下一次闹钟触发后要切换到的目标状态
  nextTriggerAt: 0,       // 当前阶段的绝对触发时间戳 (ms) — 传统间隔模式唯一真相源
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

function getLegacyAlarmEndMs() {
  if (!schedule.alarmCreatedAt || !schedule.alarmDelayMinutes) return 0;
  return schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000;
}

function getStoredAlarmEndMs() {
  if (schedule.nextTriggerAt) return schedule.nextTriggerAt;
  return getLegacyAlarmEndMs();
}

function setNextTriggerAt(nextTriggerAt) {
  schedule.nextTriggerAt = nextTriggerAt > 0 ? nextTriggerAt : 0;
}

async function syncStoredTriggerFromAlarm(alarm, reason = '从现有 PWM 闹钟同步绝对触发时间') {
  if (!schedule.enabled || isClockMode()) return false;

  const scheduledTime = alarm?.scheduledTime;
  if (!scheduledTime || scheduledTime <= Date.now()) return false;

  const legacyEnd = getLegacyAlarmEndMs();
  const needsNextTriggerSync = schedule.nextTriggerAt !== scheduledTime;
  const needsLegacySync = !legacyEnd || Math.abs(legacyEnd - scheduledTime) > 1500;

  if (!needsNextTriggerSync && !needsLegacySync) return false;

  const remainingMinutes = Math.max(1, (scheduledTime - Date.now()) / 60000);
  setNextTriggerAt(scheduledTime);
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = remainingMinutes;
  await persistSchedule(reason, { syncFromLiveAlarm: false });
  console.log(`[AC扩展] ${reason}: ${new Date(scheduledTime).toLocaleTimeString()}`);
  return true;
}

function getLiveAlarmEndMs(alarm) {
  const scheduledTime = alarm?.scheduledTime;
  return scheduledTime && scheduledTime > Date.now() ? scheduledTime : 0;
}

async function backfillNextTriggerAt(persist = false) {
  if (schedule.nextTriggerAt) return schedule.nextTriggerAt;

  // 第一层：用已保存的阶段时间重算
  const legacyEnd = getLegacyAlarmEndMs();
  if (legacyEnd) {
    schedule.nextTriggerAt = legacyEnd;
    if (persist) {
      await persistSchedule('backfillNextTriggerAt', { syncFromLiveAlarm: false });
    }
    return legacyEnd;
  }

  // 第二层：legacy 字段也丢了，但 live alarm 还在 → 从 alarm 恢复
  if (schedule.enabled && !isClockMode()) {
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    const liveDueAt = getLiveAlarmEndMs(liveAlarm);
    if (liveDueAt) {
      schedule.nextTriggerAt = liveDueAt;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (liveDueAt - Date.now()) / 60000);
      if (persist) {
        await persistSchedule('backfillNextTriggerAt-fromLiveAlarm', { syncFromLiveAlarm: false });
      }
      console.log(`[AC扩展] backfillNextTriggerAt: 从 live alarm 恢复 nextTriggerAt=${new Date(liveDueAt).toLocaleTimeString()}`);
      return liveDueAt;
    }
  }

  return 0;
}

// 从已过期的闹钟时间推进到下一个未来周期边界。
// 不会切换 AC 状态——只负责把闹钟推进到正确的未来时间点。
async function advanceExpiredAlarmToNextBoundary(expiredScheduledTime) {
  if (!expiredScheduledTime || expiredScheduledTime >= Date.now()) return false;

  let boundary = expiredScheduledTime;
  let nextAction = schedule.pwmState; // 已过期闹钟原本要执行的动作

  // 推进直到找到未来边界
  while (boundary <= Date.now()) {
    const durationMs = (nextAction === 'on' ? schedule.onMinutes : schedule.offMinutes) * 60000;
    boundary += durationMs;
    nextAction = nextAction === 'on' ? 'off' : 'on';
  }

  const remainingMinutes = Math.max(1, (boundary - Date.now()) / 60000);

  await chrome.alarms.clear('ac-pwm');
  await createAlarm('ac-pwm', { delayInMinutes: remainingMinutes });
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });

  schedule.pwmState = nextAction;
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = remainingMinutes;
  setNextTriggerAt(boundary);

  await persistSchedule('advanceExpiredAlarmToNextBoundary', { syncFromLiveAlarm: false });
  await updateBadge();

  console.log(`[AC扩展] 从过期闹钟推进: 原=${new Date(expiredScheduledTime).toLocaleTimeString()} 新=${new Date(boundary).toLocaleTimeString()} 下一动作=${nextAction}`);
  return true;
}

async function restoreIntervalAlarmFromStorage(reason = '按 storage 剩余时间恢复 PWM 闹钟') {
  if (!schedule.enabled || isClockMode()) return false;

  const now = Date.now();
  const liveAlarm = await chrome.alarms.get('ac-pwm');
  const liveDueAt = getLiveAlarmEndMs(liveAlarm);
  const storedDueAt = getStoredAlarmEndMs();
  const targetDueAt = liveDueAt || (storedDueAt > now ? storedDueAt : 0);

  if (!targetDueAt || targetDueAt <= now) return false;

  if (liveDueAt) {
    await syncStoredTriggerFromAlarm(liveAlarm, `${reason}（沿用现有活闹钟）`);
    await updateBadge();
    return true;
  }

  const remainingMinutes = Math.max(1, (targetDueAt - now) / 60000);
  await chrome.alarms.clear('ac-pwm');
  await createAlarm('ac-pwm', { delayInMinutes: remainingMinutes });
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });

  const restoredAlarm = await chrome.alarms.get('ac-pwm');
  if (!restoredAlarm?.scheduledTime) {
    console.error('[AC扩展] restoreIntervalAlarmFromStorage 失败：ac-pwm 未成功恢复');
    return false;
  }

  if (!schedule.nextTriggerAt || schedule.nextTriggerAt !== targetDueAt) {
    setNextTriggerAt(targetDueAt);
    await persistSchedule(reason, { syncFromLiveAlarm: false });
  }

  await updateBadge();
  console.log(`[AC扩展] ${reason}，剩余 ${remainingMinutes.toFixed(2)} 分钟`);
  return true;
}

async function createAlarm(name, info) {
  try {
    const { persistAcrossSessions, ...safeInfo } = info || {};
    await chrome.alarms.create(name, safeInfo);
    // 验证创建成功
    const verify = await chrome.alarms.get(name);
    if (!verify) console.error('[AC扩展] createAlarm 失败: ' + name + ' ' + JSON.stringify(safeInfo));
  } catch (e) {
    console.error('[AC扩展] createAlarm 异常: ' + name, e?.message);
  }
}

async function loadScheduleFromStorage() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (saved[STORAGE_KEY]) {
    schedule = { ...schedule, ...saved[STORAGE_KEY] };
  }
  return schedule;
}

async function persistSchedule(reason = '', options = {}) {
  const { syncFromLiveAlarm = true } = options;

  if (syncFromLiveAlarm && schedule.enabled && !isClockMode()) {
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    const liveDueAt = getLiveAlarmEndMs(liveAlarm);

    if (liveDueAt && (!schedule.nextTriggerAt || Math.abs(schedule.nextTriggerAt - liveDueAt) > 1500)) {
      setNextTriggerAt(liveDueAt);
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (liveDueAt - Date.now()) / 60000);
      if (reason) {
        console.log(`[AC扩展] ${reason}: 写入前按 live alarm 修正 nextTriggerAt`);
      }
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: { ...schedule } });
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

// SW 状态可观测性:记录启动与 init 完成时间,供诊断面板使用
let swStartupTime = Date.now();
let initCompletedAt = 0;

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
  const alarm = await chrome.alarms.get('ac-pwm');

  // 活闹钟存在 → 确保 storage 的 nextTriggerAt 与 alarm 同步（防止 SW 被 kill 后丢失）
  if (alarm?.scheduledTime && alarm.scheduledTime > Date.now() && !isClockMode()) {
    if (!schedule.nextTriggerAt || Math.abs(schedule.nextTriggerAt - alarm.scheduledTime) > 1500) {
      setNextTriggerAt(alarm.scheduledTime);
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (alarm.scheduledTime - Date.now()) / 60000);
      await persistSchedule('watchdogCheck', { syncFromLiveAlarm: false });
      console.log('[AC扩展] 看门狗：已同步 nextTriggerAt ← live alarm');
    }
  }

  if (!alarm) {
    const restored = await restoreIntervalAlarmFromStorage('看门狗：PWM 闹钟缺失，已按剩余时间补恢复');
    if (restored) return;
    console.warn('[AC扩展] 看门狗：PWM 闹钟缺失，补执行当前阶段动作');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  } else if (alarm.scheduledTime <= Date.now() - 60000) {
    const restored = await restoreIntervalAlarmFromStorage('看门狗：PWM 闹钟过期，已按剩余时间补恢复');
    if (restored) return;
    // 尝试从已过期闹钟推进到下一周期边界，避免重置为整段 60 分钟
    const advanced = await advanceExpiredAlarmToNextBoundary(alarm.scheduledTime);
    if (advanced) return;
    console.warn('[AC扩展] 看门狗：PWM 闹钟已过期，触发执行...');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }
}

async function pwmPulseCheck() {
  await loadScheduleFromStorage();
  if (!schedule.enabled) return;
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
  const liveAlarm = await chrome.alarms.get('ac-pwm');
  const liveDueAt = getLiveAlarmEndMs(liveAlarm);
  if (liveDueAt) {
    await syncStoredTriggerFromAlarm(liveAlarm, 'PWM 心跳：同步现有 PWM 闹钟触发时间');
    return;
  }

  const dueAt = getStoredAlarmEndMs();
  const hasClock = dueAt > Date.now();

  if (!hasClock) {
    if (dueAt) {
      console.warn('[AC扩展] PWM 心跳：检测到已到期，执行 PWM 步骤');
      await runPwmStep();
      return;
    }
    console.warn('[AC扩展] PWM 心跳：storage 中无倒计时，重建闹钟');
    await repairScheduleClock();
    return;
  }

  if (!liveAlarm || liveAlarm.scheduledTime <= Date.now() - 60000) {
    const remainingMinutes = Math.max(1, (dueAt - Date.now()) / 60000);
    await createAlarm('ac-pwm', { delayInMinutes: remainingMinutes });
    console.warn(`[AC扩展] PWM 心跳：主闹钟缺失/过期，已恢复，剩余 ${remainingMinutes.toFixed(2)} 分钟`);
  }
}

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  try {
    // 最先确保 badge-tick alarm 存在（PWM 补检 + 角标 + SW 保活）
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await loadScheduleFromStorage();
    await backfillNextTriggerAt(true);
    await ensureOffscreen();
    startHeartbeat();
    await setupAlarms();
    await updateBadge();
    if (schedule.enabled) {
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    }
    if (schedule.enabled && schedule.pageTimerRetryAt && schedule.pageTimerRetryAt > Date.now()) {
      await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
    }
    // 终极防线：init 完成时，间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
    // 防止 SW 跑早期版本代码、setupAlarms 走重建路径、或某条 persist 漏 sync 时出现
    // "活闹钟在但 storage 缺绝对触发时间" 的红灯。init 末尾是端到端最后一道闭环。
    if (schedule.enabled && !isClockMode()) {
      const finalLiveAlarm = await chrome.alarms.get('ac-pwm');
      const finalLiveDueAt = getLiveAlarmEndMs(finalLiveAlarm);
      if (finalLiveDueAt && (!schedule.nextTriggerAt || Math.abs(schedule.nextTriggerAt - finalLiveDueAt) > 1500)) {
        setNextTriggerAt(finalLiveDueAt);
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = Math.max(1, (finalLiveDueAt - Date.now()) / 60000);
        await persistSchedule('init-finalSync', { syncFromLiveAlarm: false });
        console.log(`[AC扩展] init 末尾: 已从 live alarm 强制同步 nextTriggerAt=${new Date(finalLiveDueAt).toLocaleTimeString()}`);
      }
    }
    // init 完成:打开 SW 启动时间跟踪
    swStartupTime = Date.now();
    initCompletedAt = swStartupTime;
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
  schedule.onMinutes = sanitizeMinutes(schedule.onMinutes, 30);
  schedule.offMinutes = sanitizeMinutes(schedule.offMinutes, 30);

  if (startImmediately) {
    await chrome.alarms.clear('ac-pwm');
    schedule.pwmState = 'on';
    // 不在这里写 storage——runPwmStep() 执行完毕后会写入完整的正确状态
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
    setNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule('setupAlarms-clock', { syncFromLiveAlarm: false });
    await updateBadge();
    const nextHour = new Date(nextBoundary).getHours();
    console.log(`[AC扩展] 时钟模式：下个整点 ${nextHour}:00，动作=${schedule.pwmState}`);
    return;
  }

  // ----- 传统间隔模式 -----
  const now = Date.now();
  const existingAlarm = await chrome.alarms.get('ac-pwm');
  const liveDueAt = getLiveAlarmEndMs(existingAlarm);
  if (liveDueAt) {
    await syncStoredTriggerFromAlarm(existingAlarm, 'setupAlarms: 沿用现有 PWM 闹钟');
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await updateBadge();
    console.log('[AC扩展] 沿用浏览器中已有的 PWM 闹钟');
    return;
  }

  const existingEnd = getStoredAlarmEndMs();
  const remainingMinutes = existingEnd > now
    ? Math.max(1, (existingEnd - now) / 60000)
    : null;

  if (remainingMinutes) {
    const restored = await restoreIntervalAlarmFromStorage('PWM 闹钟已恢复');
    if (restored) return;
  }

  // 闹钟和 storage 都不在将来 → 尝试从已过期的闹钟时间推进
  if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime <= now) {
    const advanced = await advanceExpiredAlarmToNextBoundary(existingAlarm.scheduledTime);
    if (advanced) {
      console.log('[AC扩展] 已从过期闹钟推进到下一周期边界');
      return;
    }
  }

  if (existingEnd && existingEnd <= now) {
    console.warn('[AC扩展] PWM 计划时间已过，立即补执行到期动作');
    await runPwmStep();
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
    await chrome.action.setTitle({ title: t('badgeDefault') });
    return;
  }

  // 时钟模式：显示下一个整点
  if (isClockMode()) {
    const boundary = getNextHourBoundary();
    const remainingMs = boundary - Date.now();
    if (remainingMs <= 0) {
      await chrome.action.setBadgeText({ text: 'now' });
      await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      await chrome.action.setTitle({ title: t('badgeClockSoon') });
      return;
    }
    const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
    const badgeText = remainingMin > 999 ? '999+' : String(remainingMin);
    const nextAction = getHourAction(boundary);
    const nextHour = new Date(boundary).getHours();
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: nextAction === 'on' ? '#16a34a' : '#64748b' });
    await chrome.action.setTitle({
      title: t('badgeClockCountdown', String(nextHour), t(nextAction === 'on' ? 'actionOn' : 'actionOff'), String(remainingMin))
    });
    return;
  }

  // 传统间隔模式
  const liveAlarm = await chrome.alarms.get('ac-pwm');
  const liveAlarmEnd = getLiveAlarmEndMs(liveAlarm);
  const storedAlarmEnd = getStoredAlarmEndMs();
  const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);
  if (!nextBoundary) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: t('badgeDefault') });
    return;
  }

  const nextAction = schedule.pwmState;
  const remainingMs = nextBoundary - Date.now();

  if (remainingMs <= 0) {
    await chrome.action.setBadgeText({ text: 'now' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    await chrome.action.setTitle({ title: t('badgeIntervalSoon', t(nextAction === 'on' ? 'actionOn' : 'actionOff')) });
    return;
  }

  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const badgeText = remainingMinutes > 999 ? '999+' : String(remainingMinutes);
  const currentOn = schedule.pwmState !== 'on';

  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({ color: currentOn ? '#16a34a' : '#64748b' });
  await chrome.action.setTitle({
    title: t('badgeIntervalCountdown', t(currentOn ? 'acRunning' : 'acStopped'), String(remainingMinutes), t(nextAction === 'on' ? 'actionOn' : 'actionOff'))
  });
}

async function runPwmStep() {
  if (!schedule.enabled) return;
  if (pwmStepRunning) {
    console.warn('[AC扩展] PWM 步骤已在执行，跳过重复触发');
    return;
  }
  pwmStepRunning = true;

  return waitUntil((async () => {
  try {
    await loadScheduleFromStorage();
    if (!schedule.enabled) return;

    // ----- 时钟模式：基于整点判动作 -----
    if (isClockMode()) {
      const now = Date.now();
      const targetAction = getHourAction(now);
      const nextBoundary = getNextHourBoundary(now);
      const nextHourAction = getHourAction(nextBoundary);
      const nextHour = new Date(nextBoundary).getHours();
      console.log(`[AC扩展] 时钟模式：当前 ${new Date(now).getHours()}:${String(new Date(now).getMinutes()).padStart(2,'0')} → ${targetAction}，下个整点 ${nextHour}:00 → ${nextHourAction}`);

      // 先执行开关并独立验证，成功后再更新 pwmState 和创建闹钟
      const needOnClock = targetAction === 'on';
      let toggleOkClock = false;

      // 预检：切换前确认当前 AC 真实状态
      const preCheckClock = await getCurrentACStatus();
      if (typeof preCheckClock?.isOn === 'boolean' && preCheckClock.isOn === needOnClock) {
        console.log(`[AC扩展] 预检：时钟模式 AC 已在目标状态 (${targetAction})，跳过切换`);
        toggleOkClock = true;
      }

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

      if (toggleOkClock) {
        // 开关成功：更新 pwmState 为下个整点的动作
        schedule.pwmState = nextHourAction;
        setNextTriggerAt(0);
        schedule.alarmCreatedAt = 0;
        schedule.alarmDelayMinutes = 0;
        await chrome.alarms.clear('ac-pwm');
        await createAlarm('ac-pwm', { when: nextBoundary });
      } else {
        // 开关失败：保持 pwmState 不变，1 分钟后重试
        schedule.pageTimerError = schedule.pageTimerError || '验证失败，1分钟后重试';
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = 1;
        setNextTriggerAt(schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000);
        await chrome.alarms.clear('ac-pwm');
        await createAlarm('ac-pwm', { delayInMinutes: 1 });
      }

      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      await persistSchedule('runPwmStep-clock');
      await updateBadge();

      if (targetAction === 'on' && toggleOkClock) {
        await setPageTimer(60);
      }
      return;
    }

    // ----- 传统间隔模式 -----
    const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
    const currentDuration = targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes;
    const nextState = targetAction === 'on' ? 'off' : 'on';
    const delay = Math.max(1, currentDuration);

    // 先清空即将废弃的 page timer 标记
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;

    console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);

    // 预检：切换前先确认当前 AC 真实状态，避免对已达标状态重复操作
    const needOn = targetAction === 'on';
    let toggleOk = false;
    const preCheckStatus = await getCurrentACStatus();
    if (typeof preCheckStatus?.isOn === 'boolean' && preCheckStatus.isOn === needOn) {
      console.log(`[AC扩展] 预检：AC 已在目标状态 (${targetAction})，跳过切换，直接推进周期`);
      toggleOk = true;
    }

    // 执行开关并独立验证（最多重试 3 次，防 AntD 回滚假成功）
    for (let retry = 0; retry < 3 && !toggleOk; retry++) {
      // 第 2 次起强制 reload AC tab:toggleAC 内部 reload 只在 sendMessage 异常时触发,
      // 若 content.js 返回假成功(点击了但 React 状态没变),永远不会 reload,陷入软重试死循环。
      // 用户报告"到时间不关空调"的根因之一就是这个 — reload 后 React 状态会重置。
      if (retry > 0) {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
          if (tabs[0]?.id) {
            console.warn(`[AC扩展] PWM 重试 ${retry}/2: 强制 reload AC tab 清空 React 卡住状态`);
            await chrome.tabs.reload(tabs[0].id);
            await waitForTabReady(tabs[0].id, 30000);
            await ensureContentScriptLoaded(tabs[0].id);
          }
        } catch (e) {
          console.warn('[AC扩展] PWM 重试 reload 失败,继续 toggleAC:', e?.message);
        }
      }
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

    // 只有开关确认成功后才翻转 pwmState 并创建下一次闹钟
    if (toggleOk) {
      schedule.pwmState = nextState;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = delay;
      await createAlarm('ac-pwm', { delayInMinutes: delay });
      const verify = await chrome.alarms.get('ac-pwm');
      setNextTriggerAt(verify?.scheduledTime || (schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000));
      if (!verify) {
        console.error('[AC扩展] PWM 闹钟创建失败，重试...');
        await createAlarm('ac-pwm', { delayInMinutes: delay });
      }
      console.log(`[AC扩展] PWM 下一阶段:${nextState}，${currentDuration}分钟后触发`);
    } else {
      // 开关失败：保持 pwmState 不变，1 分钟后重试
      schedule.pageTimerError = schedule.pageTimerError || `自动${needOn ? '开启' : '关闭'}验证失败，1分钟后重试`;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = 1;
      await createAlarm('ac-pwm', { delayInMinutes: 1 });
      setNextTriggerAt(schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000);
      console.warn(`[AC扩展] PWM 开关失败，保持 pwmState=${schedule.pwmState}，1分钟后重试`);
    }

    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule('runPwmStep-interval');
    await updateBadge();

    if (targetAction === 'on' && toggleOk) {
      await setPageTimer(schedule.onMinutes);
    }
  } finally {
    pwmStepRunning = false;
  }
  })());
}

// ----- 设置页面自带定时器（安全网，自动关不用手动开）-----
async function setPageTimer(minutes) {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  if (tabs.length === 0) {
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = t('bgPageTimerNoTab');
    await persistSchedule('setPageTimer-no-tab');
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
      await persistSchedule('setPageTimer-success');
      console.log(`[AC扩展] 页面定时器已设置为 ${result.value || minutes} (安全网)`);
    } else if (result?.crossesMidnight) {
      schedule.pageTimerMinutes = null;
      schedule.pageTimerError = t('bgPageTimerCrossDay');
      schedule.pageTimerRetryAt = result.retryAt || getNextPageTimerRetryAt();
      await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
      await persistSchedule('setPageTimer-cross-midnight');
      console.log('[AC扩展] 页面定时器跨日，已安排午夜后补设');
    } else {
      schedule.pageTimerMinutes = null;
      schedule.pageTimerError = result?.error || t('bgPageTimerFailed');
      schedule.pageTimerRetryAt = 0;
      await persistSchedule('setPageTimer-failed');
      console.warn('[AC扩展] 页面定时器设置失败:', schedule.pageTimerError);
    }
  } catch (e) {
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = e?.message || String(e);
    schedule.pageTimerRetryAt = 0;
    await persistSchedule('setPageTimer-exception');
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

  if (alarm.name === 'ac-badge-tick') {
    // 每分钟刷新角标
    await updateBadge();
    // 间隔模式下的 storage 一致性校准:PWM 步骤漏写 storage 时,1 分钟内会被这里纠正。
    // 这样诊断面板看到的 storage.nextTriggerAt 永远不会落后 live ac-pwm 超过 1 分钟。
    if (schedule.enabled && !isClockMode()) {
      try {
        const liveAlarm = await chrome.alarms.get('ac-pwm');
        const liveDueAt = getLiveAlarmEndMs(liveAlarm);
        if (liveDueAt && (!schedule.nextTriggerAt || Math.abs(schedule.nextTriggerAt - liveDueAt) > 1500)) {
          setNextTriggerAt(liveDueAt);
          schedule.alarmCreatedAt = Date.now();
          schedule.alarmDelayMinutes = Math.max(1, (liveDueAt - Date.now()) / 60000);
          await persistSchedule('badge-tick-sync', { syncFromLiveAlarm: false });
          console.log(`[AC扩展] badge-tick: 已同步 nextTriggerAt ← live alarm (${new Date(liveDueAt).toLocaleTimeString()})`);
        }
      } catch (e) {
        console.warn('[AC扩展] badge-tick 同步失败:', e?.message);
      }
    }
    // delayInMinutes 是一次性的，触发后重新创建
    if (schedule.enabled) await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    return;
  }
  
  if (alarm.name === 'ac-pwm') {
    // pwmStepRunning 已在 runPwmStep 内部防重入，此处无需再做去重；
    // 原先基于 alarmCreatedAt 的去重会在 SW 被闹钟唤醒后误杀合法闹钟
    // （init()→setupAlarms()→syncStoredTriggerFromAlarm() 会覆写 alarmCreatedAt 为 Date.now()，
    //   导致 alarm.scheduledTime ≈ Date.now() ≤ alarmCreatedAt+1000 成立，闹钟被丢弃）。
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
          setNextTriggerAt(schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000);
          await persistSchedule('onAlarm-error-recovery');
        }
      }
    }
  }

  if (alarm.name === 'ac-watchdog') {
    await watchdogCheck();
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
  await backfillNextTriggerAt(false);
  if (!schedule.enabled) return;
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
  if (getLiveAlarmEndMs(existingAlarm)) {
    await syncStoredTriggerFromAlarm(existingAlarm, 'ensureScheduleClock: 同步现有 PWM 闹钟');
    return;
  }

  const restored = await restoreIntervalAlarmFromStorage('PWM 主闹钟缺失，已按剩余时间补建');
  if (restored) return;

  const alarmEnd = getStoredAlarmEndMs();
  const hasClock = !!alarmEnd;

  if (alarmEnd > Date.now()) return;

  // 尝试从已过期的闹钟时间推进到下一周期边界
  if (existingAlarm?.scheduledTime && existingAlarm.scheduledTime <= Date.now()) {
    const advanced = await advanceExpiredAlarmToNextBoundary(existingAlarm.scheduledTime);
    if (advanced) return;
  }

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
    setNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await chrome.alarms.clear('ac-pwm');
    await createAlarm('ac-pwm', { when: nextBoundary });
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule('repairScheduleClock-clock', { syncFromLiveAlarm: false });
    await updateBadge();
    const status = await getCurrentACStatus();
    return { success: true, schedule: { ...schedule, actualStatus: status } };
  }

  // 传统间隔模式
  const restored = await restoreIntervalAlarmFromStorage('repair: 按已记录绝对触发时间恢复 PWM 闹钟');
  if (restored) {
    await updateBadge();
    const status = await getCurrentACStatus();
    return { success: true, repairedFromStoredBoundary: true, schedule: { ...schedule, actualStatus: status } };
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
  setNextTriggerAt(verify?.scheduledTime || (schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000));
  if (!verify) {
    console.error('[AC扩展] repair: PWM 闹钟创建失败，重试...');
    await createAlarm('ac-pwm', { delayInMinutes: delay });
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule('repairScheduleClock-interval');
  await updateBadge();

  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

async function getScheduleSnapshot() {
  await loadScheduleFromStorage();
  await backfillNextTriggerAt(false);

  const alarm = await chrome.alarms.get('ac-pwm');
  let liveAlarmEnd = 0;

  if (!isClockMode()) {
    liveAlarmEnd = getLiveAlarmEndMs(alarm);
    // 活闹钟存在但 storage 可能缺失 nextTriggerAt → 先更新内存与 storage，再生成快照
    if (liveAlarmEnd && (!schedule.nextTriggerAt || Math.abs(schedule.nextTriggerAt - alarm.scheduledTime) > 1500)) {
      setNextTriggerAt(alarm.scheduledTime);
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (alarm.scheduledTime - Date.now()) / 60000);
      await persistSchedule('getScheduleSnapshot', { syncFromLiveAlarm: false });
    }
  }

  let snapshot = { ...schedule };
  const storedAlarmEnd = getStoredAlarmEndMs();

  // 时钟模式：用整点边界时间
  if (isClockMode()) {
    const alarmBoundary = alarm?.scheduledTime && alarm.scheduledTime > Date.now()
      ? alarm.scheduledTime
      : 0;
    const nextBoundary = alarmBoundary || getNextHourBoundary();
    snapshot.alarmCreatedAt = 0;
    snapshot.alarmDelayMinutes = 0;
    snapshot._nextBoundary = nextBoundary;
    snapshot._nextAction = getHourAction(nextBoundary);
    const status = await getCurrentACStatus();
    return { ...snapshot, actualStatus: status };
  }

  // 传统间隔模式
  const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);

  if (schedule.enabled && nextBoundary) {
    const remainingMs = nextBoundary - Date.now();
    if (remainingMs > 0) {
      snapshot._nextBoundary = nextBoundary;
      snapshot.alarmCreatedAt = Date.now();
      snapshot.alarmDelayMinutes = remainingMs / 60000;
    }
  }

  const status = await getCurrentACStatus();
  // 弹窗轮询只读展示，不在这里改写 storage 或重建闹钟，避免重新打开弹窗时漂移触发时间。
  if (typeof status?.isOn === 'boolean' && schedule.enabled) {
    snapshot._effectivePwmState = status.isOn ? 'off' : 'on';
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
    setNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    schedule.pageTimerMinutes = null;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;
    await chrome.alarms.clear('ac-pwm');
    await createAlarm('ac-pwm', { when: nextBoundary });
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule('toggleNowAndSync-clock', { syncFromLiveAlarm: false });
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
  setNextTriggerAt(verify?.scheduledTime || (schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000));
  if (!verify) {
    console.error('[AC扩展] toggle: PWM 闹钟创建失败，重试...');
    await createAlarm('ac-pwm', { delayInMinutes: delay });
  }
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule('toggleNowAndSync-interval');
  await updateBadge();

  if (currentOn) {
    await setPageTimer(schedule.onMinutes);
  }

  const status = await getCurrentACStatus();
  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

async function ensureDiagnosticAlarms() {
  await loadScheduleFromStorage();

  if (!schedule.enabled) {
    await chrome.alarms.clear('ac-badge-tick');
    await chrome.alarms.clear('ac-watchdog');
    return {
      success: true,
      enabled: false,
      repaired: false,
      schedule: { ...schedule },
      alarms: { badge: null, watchdog: null, pwm: null }
    };
  }

  let repaired = false;

  let badgeAlarm = await chrome.alarms.get('ac-badge-tick');
  if (!badgeAlarm || badgeAlarm.scheduledTime <= Date.now()) {
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    repaired = true;
  }

  let watchdogAlarm = await chrome.alarms.get('ac-watchdog');
  if (!watchdogAlarm) {
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    repaired = true;
  }

  let pwmAlarm = await chrome.alarms.get('ac-pwm');
  if (!pwmAlarm || pwmAlarm.scheduledTime <= Date.now() - 60000) {
    await ensureScheduleClock();
    repaired = true;
  }

  badgeAlarm = await chrome.alarms.get('ac-badge-tick');
  watchdogAlarm = await chrome.alarms.get('ac-watchdog');
  pwmAlarm = await chrome.alarms.get('ac-pwm');

  // 活闹钟存在但 storage 可能缺失 nextTriggerAt → 直接回写（不依赖 syncStoredTriggerFromAlarm 的边界判断）
  if (pwmAlarm?.scheduledTime && pwmAlarm.scheduledTime > Date.now()) {
    if (!schedule.nextTriggerAt || Math.abs(schedule.nextTriggerAt - pwmAlarm.scheduledTime) > 1500) {
      setNextTriggerAt(pwmAlarm.scheduledTime);
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (pwmAlarm.scheduledTime - Date.now()) / 60000);
      await persistSchedule('ensureDiagnosticAlarms', { syncFromLiveAlarm: false });
      repaired = true;
    }
  }

  return {
    success: !!badgeAlarm && !!pwmAlarm,
    enabled: true,
    repaired,
    schedule: { ...schedule },
    alarms: {
      badge: badgeAlarm ? { scheduledTime: badgeAlarm.scheduledTime } : null,
      watchdog: watchdogAlarm ? { scheduledTime: watchdogAlarm.scheduledTime, periodInMinutes: watchdogAlarm.periodInMinutes } : null,
      pwm: pwmAlarm ? { scheduledTime: pwmAlarm.scheduledTime } : null
    }
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // getSwStatus 是纯只读诊断接口(swStartupTime / initCompletedAt / schedule / live alarm),
  // 不依赖 init 完成。放在 await initReady 之前响应,防止 init 卡住时诊断面板拿不到 SW 状态。
  if (msg.type === 'getSwStatus') {
    const now = Date.now();
    chrome.alarms.get('ac-pwm').then((liveAlarm) => {
      sendResponse({
        success: true,
        swStartupTime,
        initCompletedAt,
        swAgeMs: now - swStartupTime,
        initCompleted: !!initCompletedAt,
        initAgeMs: initCompletedAt ? (now - initCompletedAt) : -1,
        memorySchedule: { ...schedule },
        liveAlarmScheduledTime: liveAlarm?.scheduledTime || 0
      });
    }).catch((e) => {
      sendResponse({ success: false, error: e?.message || String(e), swStartupTime, initCompletedAt });
    });
    return true;
  }

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
        setNextTriggerAt(0);
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
        // 不在这里 clear nextTriggerAt——让接下来的 runPwmStep() 用正确值覆写。
        // 如果在这里清零，storage 会被写入 nextTriggerAt=0，弹窗读到就会显示缺失。
      }

      await persistSchedule('updateSchedule');
      await setupAlarms(schedule.enabled && (!wasEnabled || restart));
      // 管理看门狗和每分钟 PWM 心跳闹钟
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
    if (msg.type === 'ensureDiagnostics') {
      const result = await ensureDiagnosticAlarms();
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
        nextTriggerAt: 0,
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
