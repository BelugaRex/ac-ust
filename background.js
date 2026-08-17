// ============================================================
// Background Service Worker - 管理定时任务
// ============================================================

// i18n 辅助函数 — 使用 fetch-based I18n 模块（绕过 chrome.i18n 不可靠性）
importScripts('i18n.js');
importScripts('sync-helpers.js');  // 跨设备同步的纯函数（composeSyncPayload / computePhaseAdoption）
importScripts('pwm-phase.js');  // PWM 阶段推进、恢复与 live alarm 对齐的纯决策
importScripts('smart-mode.js');  // 智能模式纯决策（computeSmartOnMinutes 等，无 chrome.* 副作用）
const t = (key, ...subs) => I18n.t(key, ...subs);

const AC_PAGE = 'https://w5.ab.ust.hk/njggt/app/home';
const PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS = [10000, 15000, 20000];
const STORAGE_KEY = 'ac_schedule';
const DIAGNOSTIC_LOG_KEY = 'ac_diagnostic_log';
const DIAGNOSTIC_LOG_MAX_ENTRIES = 50;
const DIAGNOSTIC_LOG_MAX_MESSAGE_LENGTH = 300;

let diagnosticLogWriteChain = Promise.resolve();

function normalizeDiagnosticMessage(error) {
  let message;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    message = error.message;
  } else {
    message = String(error ?? '未知错误');
  }
  return message
    .replace(/(?:https?|chrome-extension):\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .slice(0, DIAGNOSTIC_LOG_MAX_MESSAGE_LENGTH);
}

function appendDiagnosticLog(level, source, error) {
  const entry = {
    timestamp: Date.now(),
    level: level === 'warn' ? 'warn' : 'error',
    source: String(source || 'unknown').slice(0, 80),
    message: normalizeDiagnosticMessage(error)
  };

  diagnosticLogWriteChain = diagnosticLogWriteChain
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(DIAGNOSTIC_LOG_KEY);
      const previous = Array.isArray(stored?.[DIAGNOSTIC_LOG_KEY])
        ? stored[DIAGNOSTIC_LOG_KEY]
        : [];
      const next = [...previous, entry].slice(-DIAGNOSTIC_LOG_MAX_ENTRIES);
      await chrome.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: next });
    })
    .catch(() => {});

  return diagnosticLogWriteChain;
}

self.addEventListener('error', (event) => {
  void appendDiagnosticLog('error', 'service-worker-error', event?.error || event?.message);
});

self.addEventListener('unhandledrejection', (event) => {
  void appendDiagnosticLog('error', 'service-worker-unhandledrejection', event?.reason);
});

// 跨设备同步：瘦化版 schedule 写到 chrome.storage.sync。详见 sync-helpers.js 注释。
// 同步对象在 sync 区存储键名，由 background.js 独立维护（与 local.ac_schedule 解耦）。
// lastSyncedAt 用于自回环抑制——Chrome 会把"自己写的 sync"也回灌回本地 onChanged，
// 通过 syncedAt 对比即可识别并静默跳过；同时承担 last-writer-wins 的本地参照。
const SYNC_KEY = 'ac_schedule_sync';
let lastSyncedAt = 0;

let schedule = {
  enabled: false,
  mode: 'pwm',
  clockMode: false,  // v0.5.x 起只保留间隔模式（false）。字段保留向后兼容，UI 不再暴露开关。
  onMinutes: 60,    // 间隔模式下默认开分钟数
  offMinutes: 60,   // 间隔模式下默认关分钟数
  pwmState: 'off',  // 下一次闹钟触发后要切换到的目标状态
  nextTriggerAt: 0,       // 当前阶段的绝对触发时间戳 (ms) — 传统间隔模式唯一真相源
  alarmCreatedAt: 0,      // 闹钟创建时的时间戳 (ms) — 时钟模式不使用
  alarmDelayMinutes: 0,   // 闹钟设定的延迟 (分钟) — 时钟模式不使用
  pageTimerMinutes: null,
  pageTimerTargetAt: 0,
  pageTimerError: '',
  pageTimerRetryAt: 0,
  pageTimerRetryMinutes: 0,
  activeHours: { enabled: false, start: '08:00', end: '23:00' },  // v0.5.x: PWM 运行时段（白名单，同日）
  smartMode: { enabled: false, sensitivity: 50 }  // v0.8.0: 智能模式（天气驱动的开启时长，灵敏度 0~100）
};

let pwmStepRunning = false;
let lastPwmStepAt = 0;  // A4: 看门狗 cooldown 追踪
let acToggleInFlight = null;
let acToggleInFlightAction = null;

const PWM_TRIGGER_STRICT_OPTIONS = Object.freeze({
  nextTriggerToleranceMs: 0,
  legacyTriggerToleranceMs: 1500,
  requireLegacyAlignment: true
});
const PWM_TRIGGER_NEXT_ONLY_OPTIONS = Object.freeze({
  nextTriggerToleranceMs: 1500,
  requireLegacyAlignment: false
});
const PWM_TRIGGER_SNAPSHOT_OPTIONS = Object.freeze({
  ...PWM_TRIGGER_NEXT_ONLY_OPTIONS,
  allowDisabled: true
});

// ===== Active Hours (PWM 运行时段，白名单) =====
// 启用后：在 [start, end) 时段内 PWM 自动运行；时段外自动关闭 PWM（避免噪音）。
// 同日时段（start < end 强制）。跨日场景用户应该用反向设置（如 23:00-07:00 关 = 07:00-23:00 开）。
function parseHHMM(s) {
  if (typeof s !== 'string') return -1;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

function isWithinActiveHours(now = new Date()) {
  const ah = schedule.activeHours;
  if (!ah || !ah.enabled) return true;  // 未启用 = 永远在时段内
  const start = parseHHMM(ah.start);
  const end = parseHHMM(ah.end);
  if (start < 0 || end < 0 || start >= end) return true;  // 非法配置 = 不限制
  const curMin = now.getHours() * 60 + now.getMinutes();
  return curMin >= start && curMin < end;
}

// 返回下一次状态切换的时间戳（ms）。返回 0 表示无需调度（未启用或非法）。
function getNextActiveBoundary(now = new Date()) {
  const ah = schedule.activeHours;
  if (!ah || !ah.enabled) return 0;
  const start = parseHHMM(ah.start);
  const end = parseHHMM(ah.end);
  if (start < 0 || end < 0 || start >= end) return 0;
  const curMin = now.getHours() * 60 + now.getMinutes();

  // 找下一个 end（退出运行时段）
  let nextEnd = new Date(now);
  nextEnd.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (curMin >= end) nextEnd.setDate(nextEnd.getDate() + 1);

  // 找下一个 start（进入运行时段）
  let nextStart = new Date(now);
  nextStart.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (curMin >= start) nextStart.setDate(nextStart.getDate() + 1);

  return nextStart.getTime() < nextEnd.getTime() ? nextStart.getTime() : nextEnd.getTime();
}

// 调度下一次 active hours 边界闹钟
async function rescheduleActiveBoundary() {
  try {
    await chrome.alarms.clear('ac-active-boundary');
  } catch (_) { /* ignore */ }
  const next = getNextActiveBoundary();
  if (!next) return;
  const delayMin = Math.max(1, (next - Date.now()) / 60000);
  chrome.alarms.create('ac-active-boundary', { delayInMinutes: delayMin });
}

// 边界闹钟触发：进入/退出运行时段，自动启用/关闭 PWM
async function onActiveBoundaryCrossed() {
  // 重新调度下一次边界（先调度，避免后续 await 抛出时漏掉）
  rescheduleActiveBoundary();

  // 提取（Fowler Extract Function）：退出运行时段停用路径——B1 顺序：先 persist 已停用状态再执行长流程关机。
  async function shutdownAfterActiveHoursLeave() {
    await resetDisabledPwmRuntime();
    // B1（active-hours 离开）：先 persist 已停用状态再执行长流程关机 — 与
    // updateSchedule、applySyncedPhase 同步停用路径保持顺序一致，避免 SW 在
    // verifyPageTimerPersistence 长流程中被杀导致闹钟自愈"复活" PWM。
    await persistSchedule('active-hours-leave-pre-shutdown', { syncFromLiveAlarm: false });
    const shutdownResult = await requestTimerBasedShutdown('active-hours-leave');
    if (!shutdownResult?.success) {
      schedule.pageTimerError = `退出运行时段后页面关机定时器未确认：${shutdownResult?.error || '未知错误'}`;
    }
  }

  const inside = isWithinActiveHours();
  if (inside && !schedule.enabled) {
    // 进入运行时段 → 自动启用 PWM
    console.log('[ac-ust] active hours: entering, auto-enable PWM');
    schedule.enabled = true;
    schedule.pwmState = 'on';
    await persistSchedule('active-hours-enter');
    await setupAlarms(true);
    await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    // [v0.5.6] 跨设备同步：activeHours 跨边界是低频事件（每日 ≤ 2 次），同步推送
    await syncScheduleToSync('active-hours-enter');
  } else if (!inside && schedule.enabled) {
    // 退出运行时段 → 关闭 PWM 并停机（避免噪音）
    console.log('[ac-ust] active hours: leaving, auto-disable PWM');
    schedule.enabled = false;
    await shutdownAfterActiveHoursLeave();
    await persistSchedule('active-hours-leave');
    // [v0.5.6] 同步推送离开时段状态
    await syncScheduleToSync('active-hours-leave');
  }
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

// ===== 智能模式：天气取数（天文台开放数据 rhrread）+ 动态时长 =====
// 按需求使用香港天文台开放数据 API（weather.php?dataType=rhrread，Current Weather Report）。
// 实测其提供：气温（多站）、湿度（仅天文台一站）、分区雨量；不含露点与风速。故由
// smart-mode.js 的 parseRhrreadWeather 解析：气温取将军澳站（Tseung Kwan O / JKB），
// 露点由气温 + 湿度 Magnus 逆推，风速取 0（静风）为保守默认（风项在算法中保留）。天气仅作为
// 本机运行态缓存，不进入 sync。
const SMART_WEATHER_KEY = 'ac_smart_weather';
const SMART_WEATHER_URL = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';
const SMART_WEATHER_TTL_MS = 60 * 60 * 1000;  // 天气缓存 1 小时（整点刷新一次）
let smartWeatherInFlight = null;

function clampSmartSensitivity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.round(Math.min(100, Math.max(0, n)));
}

async function fetchSmartWeather() {
  const res = await fetch(SMART_WEATHER_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`天气接口 HTTP ${res.status}`);
  const data = await res.json();
  const parsed = parseRhrreadWeather(data);
  if (!parsed) throw new Error('天气数据缺失或格式异常');
  return { fetchedAt: Date.now(), ...parsed };
}

// 读取天气观测：缓存未过期直接返回，否则单飞拉取。
// 拉取失败回退旧缓存并标记 stale；无缓存则返回错误占位（调用方退化为手动时长）。
async function getSmartWeather({ force = false } = {}) {
  if (!force) {
    const cached = (await chrome.storage.local.get(SMART_WEATHER_KEY))[SMART_WEATHER_KEY];
    if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < SMART_WEATHER_TTL_MS) {
      return { ...cached, stale: false, error: '' };
    }
  }
  if (smartWeatherInFlight) return smartWeatherInFlight;

  smartWeatherInFlight = (async () => {
    try {
      const weather = await fetchSmartWeather();
      await chrome.storage.local.set({ [SMART_WEATHER_KEY]: weather });
      return { ...weather, stale: false, error: '' };
    } catch (e) {
      console.warn('[AC扩展] 智能模式天气拉取失败:', e?.message);
      void appendDiagnosticLog('warn', 'smart-weather', e);
      const cached = (await chrome.storage.local.get(SMART_WEATHER_KEY))[SMART_WEATHER_KEY];
      if (cached && cached.fetchedAt) {
        return { ...cached, stale: true, error: e?.message || String(e) };
      }
      return {
        fetchedAt: 0,
        temperature: null,
        dewPoint: null,
        windSpeedMs: null,
        rainMm: null,
        relativeHumidity: null,
        stale: true,
        error: e?.message || String(e)
      };
    } finally {
      smartWeatherInFlight = null;
    }
  })();
  return smartWeatherInFlight;
}

// 智能模式启用时，重算本周期 on/off 时长并注入 schedule（在 runPwmStep 顶部调用）。
// 天气不可用 → 沿用手动时长（优雅降级，不点击、不推进）。
async function applySmartModeDurations() {
  if (!schedule.enabled || !schedule.smartMode?.enabled) return;

  const weather = await getSmartWeather();  // 用整点刷新的缓存（1 小时 TTL），周期内不重复拉取
  const suggested = computeSmartOnMinutes({
    sensitivity: schedule.smartMode.sensitivity,
    temperature: weather.temperature,
    dewPoint: weather.dewPoint,
    windSpeedMs: weather.windSpeedMs,
    rainMm: weather.rainMm
  });

  if (!suggested.valid) {
    console.warn('[AC扩展] 智能模式：天气不可用，本周期沿用手动时长');
    return;
  }

  if (suggested.onMinutes === 0) {
    // 建议 0 分钟（过冷/过湿/大风）→ 本周期保持关闭，60 分钟后重估。
    // 置 pwmState='off' 让 OFF 相位确保关闭（零点击）；onMinutes 仅占位，不进入 ON 相位。
    schedule.pwmState = 'off';
    schedule.onMinutes = 60;
    schedule.offMinutes = 60;
  } else {
    schedule.onMinutes = suggested.onMinutes;
    schedule.offMinutes = Math.max(1, suggested.offMinutes);
  }

  console.log(
    `[AC扩展] 智能模式: K=${suggested.k.toFixed(3)} Teq=${suggested.teq.toFixed(1)}°C`
    + ` t_raw=${suggested.tRaw.toFixed(1)} → on=${suggested.onMinutes}min / off=${schedule.offMinutes}min`
  );
}

function clearPageTimerProofState() {
  schedule.pageTimerMinutes = null;
  schedule.pageTimerTargetAt = 0;
  schedule.pageTimerError = '';
  schedule.pageTimerRetryAt = 0;
  schedule.pageTimerRetryMinutes = 0;
}

function applyPwmPlanState(plan) {
  if (plan?.proofAction === 'clear') clearPageTimerProofState();
  if (plan?.phasePatch) Object.assign(schedule, plan.phasePatch);
}

async function resetDisabledPwmRuntime() {
  schedule.pwmState = 'off';
  setNextTriggerAt(0);
  schedule.alarmCreatedAt = 0;
  schedule.alarmDelayMinutes = 0;
  await chrome.alarms.clear('ac-pwm');
  await chrome.alarms.clear('ac-page-timer-retry');
  await chrome.alarms.clear('ac-badge-tick');
  await chrome.alarms.clear('ac-watchdog');
  await updateBadge();
}

async function persistReconciledPwmTrigger(alarm, reason, options) {
  const plan = reconcilePwmTrigger(schedule, alarm, options);
  if (plan.kind !== 'sync-live') return null;

  applyPwmPlanState(plan);
  await persistSchedule(reason, { syncFromLiveAlarm: false });
  return plan;
}

async function syncStoredTriggerFromAlarm(alarm, reason = '从现有 PWM 闹钟同步绝对触发时间') {
  const plan = await persistReconciledPwmTrigger(alarm, reason, PWM_TRIGGER_STRICT_OPTIONS);
  if (!plan) return false;

  console.log(`[AC扩展] ${reason}: ${new Date(plan.liveScheduledTime).toLocaleTimeString()}`);
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
  if (schedule.enabled) {
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    const plan = reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS);
    if (plan.kind === 'sync-live') {
      applyPwmPlanState(plan);
      if (persist) {
        await persistSchedule('backfillNextTriggerAt-fromLiveAlarm', { syncFromLiveAlarm: false });
      }
      console.log(`[AC扩展] backfillNextTriggerAt: 从 live alarm 恢复 nextTriggerAt=${new Date(plan.liveScheduledTime).toLocaleTimeString()}`);
      return plan.liveScheduledTime;
    }
  }

  return 0;
}

// 从已过期的闹钟时间推进到下一个未来周期边界。
// 不会点击 AC 开关；但若恢复后理论上正处于 ON 阶段，必须先重新武装并
// 通过新鲜页面确认 Power-off after，不能直接造出无关机证明的 OFF 相位。
async function advanceExpiredAlarmToNextBoundary(expiredScheduledTime) {
  const recoverySchedule = { ...schedule };
  let observations = {};
  let plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);
  if (plan.kind === 'noop' || plan.kind === 'refuse') {
    if (plan.kind === 'refuse') {
      console.warn(`[AC扩展] 过期闹钟恢复被拒绝: ${plan.reason}`);
    }
    return false;
  }

  if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
    const status = await getCurrentACStatus();
    observations = { acIsOn: status?.isOn };
    plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);

    if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
      applyPwmPlanState(plan);
      const timerResult = await setPageTimer(plan.timerMinutes, { retryOnFailure: false });
      observations = {
        ...observations,
        pageTimerSucceeded: !!timerResult?.success,
        pageTimerTargetAt: schedule.pageTimerTargetAt
      };
      plan = planPwmRecovery(recoverySchedule, expiredScheduledTime, observations);
    }
  }

  if (plan.kind === 'retry') {
    applyPwmPlanState(plan);
    schedule.pageTimerError = `过期闹钟恢复时页面关机定时器未确认：${schedule.pageTimerError || '未知错误'}；1 分钟后重试`;
    await chrome.alarms.clear('ac-pwm');
    await createPwmAlarmFromPlan(plan, 'advance-pageTimer-failed');
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule('advanceExpiredAlarmToNextBoundary-pageTimer-failed', { syncFromLiveAlarm: false });
    await updateBadge();
    return true;
  }

  if (plan.kind !== 'commit') return false;

  applyPwmPlanState(plan);
  if (plan.proofAction === 'clear') {
    await chrome.alarms.clear('ac-page-timer-retry');
  }
  await chrome.alarms.clear('ac-pwm');
  await createPwmAlarmFromPlan(plan, 'advance-recovery');
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule('advanceExpiredAlarmToNextBoundary', { syncFromLiveAlarm: false });
  await updateBadge();

  console.log(`[AC扩展] 从过期闹钟推进: 原=${new Date(expiredScheduledTime).toLocaleTimeString()} 新=${new Date(schedule.nextTriggerAt).toLocaleTimeString()} 下一动作=${schedule.pwmState}`);
  return true;
}

async function restoreIntervalAlarmFromStorage(reason = '按 storage 剩余时间恢复 PWM 闹钟') {
  if (!schedule.enabled) return false;

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
    void appendDiagnosticLog('error', 'create-alarm', e);
  }
}

async function createPwmAlarmWithVerify(delay, logTag = 'PWM') {
  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = delay;
  await createAlarm('ac-pwm', { delayInMinutes: delay });
  const verify = await chrome.alarms.get('ac-pwm');
  setNextTriggerAt(verify?.scheduledTime || (schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000));
  if (!verify) {
    console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
    await createAlarm('ac-pwm', { delayInMinutes: delay });
  }
}

async function createPwmAlarmFromPlan(plan, logTag = 'PWM') {
  const nextTriggerAt = Number(plan?.nextTriggerAt);
  if (!Number.isFinite(nextTriggerAt) || nextTriggerAt <= Date.now()) {
    throw new Error(`${logTag}: PWM plan 缺少未来触发时间`);
  }

  schedule.alarmCreatedAt = Date.now();
  schedule.alarmDelayMinutes = Math.max(
    1,
    (nextTriggerAt - schedule.alarmCreatedAt) / 60000
  );
  await createAlarm('ac-pwm', { when: nextTriggerAt });
  let verify = await chrome.alarms.get('ac-pwm');
  if (!verify) {
    console.error(`[AC扩展] ${logTag}: PWM 闹钟创建失败，重试...`);
    await createAlarm('ac-pwm', { when: nextTriggerAt });
    verify = await chrome.alarms.get('ac-pwm');
  }
  setNextTriggerAt(verify?.scheduledTime || nextTriggerAt);
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

  if (syncFromLiveAlarm && schedule.enabled) {
    const liveAlarm = await chrome.alarms.get('ac-pwm');
    const plan = reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS);
    if (plan.kind === 'sync-live') {
      applyPwmPlanState(plan);
      if (reason) {
        console.log(`[AC扩展] ${reason}: 写入前按 live alarm 修正 nextTriggerAt`);
      }
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: { ...schedule } });
}

// ============================================================
// 跨设备同步 — chrome.storage.sync 集成层
// ============================================================
//
// 触发同步写入的时机（节流策略，远低于 sync 配额 100 写/小时、1200 写/天）：
//   • runPwmStep 每次成功的阶段翻转 (toggleOk=true) — 60min 周期 ≈ 24 写/天
//   • updateSchedule handler（用户改设置/toggle）— 用户发起，低频
//   • onActiveBoundaryCrossed enter/leave — 每日 ≤ 2 次
//   • onInstalled install—— push 默认配置到 sync（若 sync 为空）
//   • init() 启动时—— 不写入，只读采纳
//
// 不同步：__heartbeat（20s 一次会打爆配额）、pageTimer*（本机页面态）、
//        alarmCreatedAt/alarmDelayMinutes（旧版字段）、watchdogCheck 的微调（噪音）。
// 失败重试时不同步（pwmState 没变，避免 PWM 死循环反复打 sync）。
//
// 同步对象结构（瘦化）：见 sync-helpers.js 的 composeSyncPayload。
// 自回环抑制：自己写入的 sync 会触发本地 onChanged，通过 syncedAt 对比识别为自写
// 并静默跳过——computePhaseAdoption 内部 lastSyncedAt 守卫已覆盖。
//
// 优雅降级：用户未登录浏览器同步 / sync 配额超限 / 企业策略禁用 → 异常被静默吞掉，
// 行为退化为现有本地 storage 模式（无回归）。

const _syncOpLock = { busy: false };

// 把当前内存 schedule 瘦化后写入 chrome.storage.sync。
// reason 用于日志。失败静默降级。
async function syncScheduleToSync(reason = '') {
  if (!chrome.storage?.sync) return;  // 受限上下文（incognito / 策略禁用）
  try {
    const now = Date.now();
    const slim = composeSyncPayload(schedule, now);
    await chrome.storage.sync.set({ [SYNC_KEY]: slim });
    lastSyncedAt = now;  // 标记本次写入的时间，避免 onChanged 自回环误采纳
    if (reason) {
      console.log(`[AC扩展] sync ↑ ${reason}: nextTriggerAt=${slim.nextTriggerAt ? new Date(slim.nextTriggerAt).toLocaleString() : '无'}, enabled=${slim.enabled}`);
    }
  } catch (e) {
    console.warn('[AC扩展] sync 写入失败（未登录浏览器同步 / 配额超限？）:', e?.message);
    void appendDiagnosticLog('warn', 'sync-write', e);
  }
}

// 把远端 sync 对象合并到本地 schedule + 重排闹钟。返回 true=已变更并持久化。
// 注意：调用方需要保证不并发（_syncOpLock 守卫）。
async function applySyncedPhase(remote, reason = '') {
  if (!remote || typeof remote !== 'object') return false;

  // 提取（Fowler Extract Function）：同步停用路径——B1 顺序：先 persist 停用状态，再走页面定时器关机。
  async function shutdownAfterSyncDisable() {
    await resetDisabledPwmRuntime();
    // B1（同步停用）：先 persist 停用状态再执行长流程关机 — 防止 SW 在
    // verifyPageTimerPersistence 的 2 分钟+等待中被杀后，storage 仍是 enabled=true
    // 导致重启后闹钟自愈"复活" PWM。末尾 `if (changed)` persist 仍处理相位/activeHours。
    await persistSchedule('sync-disabled-pre-shutdown', { syncFromLiveAlarm: false });
    // 自动关机只依赖 UST 页面定时器，不再点击 AC 开关。
    const shutdownResult = await requestTimerBasedShutdown('sync-disabled');
    if (!shutdownResult?.success) {
      schedule.pageTimerError = `同步停用后页面关机定时器未确认：${shutdownResult?.error || '未知错误'}`;
    }
  }

  // 先记录 enabled 旧值——config 采纳后判断是否需要重建闹钟基础设施
  const wasEnabled = schedule.enabled;

  // 1) config 字段无相位守卫——直接 last-writer-wins 采纳
  const cfg = computeConfigDiff(schedule, remote);
  let configChanged = false;
  let activeHoursChanged = false;
  if (cfg.changed) {
    for (const [k, v] of Object.entries(cfg.fields)) {
      schedule[k] = v;
      if (k === 'activeHours') activeHoursChanged = true;
    }
    configChanged = true;
  }
  const enabledChanged = cfg.fields.enabled !== undefined;
  const nowEnabled = schedule.enabled;

  // 2) 相位字段需通过严格守卫（陈旧/容忍/自回环），computePhaseAdoption 决策
  // 提取（Fowler Extract Function）：相位采纳 + ac-pwm 重排；远端时戳过期则推进到下一未来边界。
  async function adoptPhaseAndRearm(remote, nowEnabled) {
    const adopt = computePhaseAdoption(schedule, remote, { lastSyncedAt });
    if (!adopt) return false;

    const oldPwmState = schedule.pwmState;
    const oldTrigger = schedule.nextTriggerAt;
    schedule.pwmState = adopt.pwmState;
    setNextTriggerAt(adopt.nextTriggerAt);
    schedule.alarmCreatedAt = Date.now();
    schedule.alarmDelayMinutes = Math.max(1, (adopt.nextTriggerAt - Date.now()) / 60000);
    const phaseChanged = (oldPwmState !== schedule.pwmState || oldTrigger !== schedule.nextTriggerAt);

    if (phaseChanged && nowEnabled) {
      try {
        await chrome.alarms.clear('ac-pwm');
        const delayMs = adopt.nextTriggerAt - Date.now();
        if (delayMs > 0) {
          // 用绝对时间调度，让多设备对齐到同一时刻（非 delayInMinutes 各自倒计时）
          chrome.alarms.create('ac-pwm', { when: adopt.nextTriggerAt });
        } else {
          // 远端时戳已过期（在 staleMs 60s 窗口内）——推进到下一未来周期边界
          await advanceExpiredAlarmToNextBoundary(adopt.nextTriggerAt);
        }
      } catch (e) {
        console.warn('[AC扩展] sync 合并：重排 ac-pwm 闹钟失败:', e?.message);
      }
    }
    return phaseChanged;
  }

  const phaseChanged = await adoptPhaseAndRearm(remote, nowEnabled);

  // 3) 闹钟基础设施重建——只由 config 变更驱动（相位路径只管 ac-pwm）
  //    关键修复：若 enabled 在 sync 中翻为 true 但无相位（远端刚 enable 还没跑完第一步），
  //    只持久化 enabled=true 却不建闹钟，设备 B 永远不会真正执行 PWM。
  //    反之 enabled 翻为 false 也必须主动清理闹钟 + 停机，否则设备 B 继续跑本地 PWM。
  let didAlarmInfra = false;
  if (enabledChanged) {
    if (nowEnabled) {
      // false → true：按是否已采纳相位决定是否立即新起 PWM cycle
      if (phaseChanged) {
        // 相位路径已建 ac-pwm；只补看门狗 + badge-tick（相位路径不管这两个）
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
        await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      } else {
        // 无相位 → 本地全新起一轮 PWM（与 updateSchedule enabled→true 路径一致）
        schedule.pwmState = 'on';
        // 先 persist 内存新状态（enabled=true、pwmState='on'），避免 setupAlarms(true)
        // → runPwmStep() 顶部 loadScheduleFromStorage() 用 storage 旧值（enabled=false）
        // 覆盖内存导致 runPwmStep 提前返回、闹钟基础设施丢失。
        await persistSchedule('sync-enabled-pre-setup', { syncFromLiveAlarm: false });
        await setupAlarms(true);  // startImmediately → runPwmStep，内部建 ac-pwm + badge-tick
        await createAlarm('ac-watchdog', { periodInMinutes: 5 });
      }
    } else {
      // true → false：清所有 PWM 相关闹钟 + 停机（B1 顺序：先 persist 再关）
      await shutdownAfterSyncDisable();
    }
    didAlarmInfra = true;
  }

  // 4) active hours 边界闹钟：activeHours 变更或相位重排后都应重调度
  if (activeHoursChanged || phaseChanged) {
    rescheduleActiveBoundary();
  }

  // 标记最新已知的 remote.syncedAt——即便没采纳相位，也防止稍后 onChanged 自回环再次触发
  if (remote.syncedAt) lastSyncedAt = Math.max(lastSyncedAt, remote.syncedAt);

  const changed = configChanged || phaseChanged;
  if (changed) {
    await persistSchedule(reason || 'sync-采纳', { syncFromLiveAlarm: false });
    if (phaseChanged) {
      console.log(`[AC扩展] sync ↓ ${reason}: 已采纳远端相位 pwmState=${schedule.pwmState}, nextTriggerAt=${new Date(schedule.nextTriggerAt).toLocaleString()}`);
    }
    if (configChanged) {
      console.log(`[AC扩展] sync ↓ ${reason}: 已采纳远端 config:`, cfg.fields);
    }
    if (didAlarmInfra) {
      console.log(`[AC扩展] sync ↓ ${reason}: enabled=${wasEnabled}→${nowEnabled}，已重建闹钟基础设施`);
    }
  }
  return changed;
}

// 从 chrome.storage.sync 拉取并尝试合并。reason 用于日志。
// 传 explicitRemote 可跳过读取（onChanged 已传入 newValue）；否则从 sync store 读。
async function tryAdoptSyncedState(reason = '', explicitRemote = null) {
  if (_syncOpLock.busy) {
    console.log(`[AC扩展] sync 合并跳过（上次仍在处理）: ${reason}`);
    return false;
  }
  _syncOpLock.busy = true;
  try {
    let remote = explicitRemote;
    if (!remote && chrome.storage?.sync) {
      try {
        const got = await chrome.storage.sync.get(SYNC_KEY);
        remote = got?.[SYNC_KEY] || null;
      } catch (e) {
        console.warn('[AC扩展] sync 读取失败:', e?.message);
        return false;
      }
    }
    if (!remote) return false;
    return await applySyncedPhase(remote, reason);
  } finally {
    _syncOpLock.busy = false;
  }
}

// ----- v0.5.10: 页面定时器作为跨设备主同步通道 -----
// UST 服务器已确认："Power-off after" 定时器值会同步到同一账号的所有会话。
// chrome.storage.sync 在 Chrome/Edge 跨浏览器时互不互通——只有 page timer
// 能跨浏览器账号同步（只要登录同一 UST 账号）。
//
// v0.5.10 修正了 v0.5.7 的 pwmState 条件 bug（之前仅 pwmState='on' 才采纳，
// 但 pwmState='off' (AC 正开) 才是页面定时器有值的时刻）。现在两个相位都会
// 对齐：pwmState='off' 直接采纳 page timer 值；pwmState='on' 从 page timer
// 掉算下一轮"开"边界 (pageOffAt + offMinutes)。
//
// 本函数：找到打开的 AC 页面 → 发 getPageTimer 消息 → content.js 读 picker →
// computePageTimerAdoption 决策 → 若采纳则更新 nextTriggerAt + 重排 ac-pwm 闹钟 +
// 把修正后的相位推回 chrome.storage.sync。
//
// 优雅降级：page timer 并非服务器同步时，读回的是本机刚写的值——偏差 <
// toleranceMs(60s)，computePageTimerAdoption 返回 null，不干预，功能等于关闭。
async function tryAdoptPageTimer(reason = '') {
  if (!schedule.enabled) return false;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    const tab = tabs.find(isACHomePageTab);
    if (!tab?.id) return false;

    const result = await sendReadMessageToExactACHome(tab.id, { action: 'getPageTimer' });
    if (!result || !result.found) return false;

    const adopt = computePageTimerAdoption(schedule, result, { now: Date.now() });
    if (!adopt) return false;

    // 采纳 page timer 值作为权威"关"时刻
    const oldTrigger = schedule.nextTriggerAt;
    setNextTriggerAt(adopt.nextTriggerAt);
    schedule.alarmCreatedAt = Date.now();
    schedule.alarmDelayMinutes = Math.max(1, (adopt.nextTriggerAt - Date.now()) / 60000);

    // 重排 ac-pwm 闹钟到新时刻
    await chrome.alarms.clear('ac-pwm');
    const delayMs = adopt.nextTriggerAt - Date.now();
    if (delayMs > 0) {
      chrome.alarms.create('ac-pwm', { when: adopt.nextTriggerAt });
    } else {
      await advanceExpiredAlarmToNextBoundary(adopt.nextTriggerAt);
    }

    await rescheduleActiveBoundary();
    await persistSchedule(`page-timer-adopt (${reason})`, { syncFromLiveAlarm: false });
    // 把修正后的相位推回 sync——让仅靠 sync 的设备也间接对齐到 page timer 的时刻
    await syncScheduleToSync(`page-timer-adopt (${reason})`);

    const oldStr = oldTrigger ? new Date(oldTrigger).toLocaleTimeString() : '无';
    console.log(`[AC扩展] page-timer ↓ ${reason}: 采纳 picker=${result.value} → nextTriggerAt=${new Date(adopt.nextTriggerAt).toLocaleTimeString()} (旧 ${oldStr}), 因=${adopt.reason}, pwmState=${schedule.pwmState}`);
    return true;
  } catch (e) {
    // AC 页面可能尚未完全加载 / content script 未就绪——静默降级
    console.warn(`[AC扩展] page-timer ${reason} 读取失败（可能页面未就绪）:`, e?.message);
    void appendDiagnosticLog('warn', 'page-timer-adopt', e);
    return false;
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

  // 提取（Fowler Extract Function）：看门狗缺失闹钟恢复——按剩余时间补恢复，失败则补执行当前阶段动作。
  async function recoverMissingPwmAlarm() {
    const restored = await restoreIntervalAlarmFromStorage('看门狗：PWM 闹钟缺失，已按剩余时间补恢复');
    if (restored) return;
    console.warn('[AC扩展] 看门狗：PWM 闹钟缺失，补执行当前阶段动作');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }

  // 提取（Fowler Extract Function）：看门狗过期闹钟恢复——补恢复 → 推进下一周期边界 → 补执行。
  async function recoverExpiredPwmAlarm(alarm) {
    const restored = await restoreIntervalAlarmFromStorage('看门狗：PWM 闹钟过期，已按剩余时间补恢复');
    if (restored) return;
    // 尝试从已过期闹钟推进到下一周期边界，避免重置为整段 60 分钟
    const advanced = await advanceExpiredAlarmToNextBoundary(alarm.scheduledTime);
    if (advanced) return;
    console.warn('[AC扩展] 看门狗：PWM 闹钟已过期，触发执行...');
    try { await runPwmStep(); } catch (e) { /* 已在 onAlarm 中有恢复逻辑 */ }
  }

  const alarm = await chrome.alarms.get('ac-pwm');

  // 活闹钟存在 → 确保 storage 的 nextTriggerAt 与 alarm 同步（防止 SW 被 kill 后丢失）
  const triggerPlan = await persistReconciledPwmTrigger(alarm, 'watchdogCheck', PWM_TRIGGER_NEXT_ONLY_OPTIONS);
  if (triggerPlan) {
    console.log('[AC扩展] 看门狗：已同步 nextTriggerAt ← live alarm');
  }

  if (!alarm) {
    await recoverMissingPwmAlarm();
  } else if (alarm.scheduledTime <= Date.now() - 60000) {
    await recoverExpiredPwmAlarm(alarm);
  }
}

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  // 提取（Fowler Extract Function）：启动时恢复页面定时器重试（不依赖 schedule.enabled）。
  async function recoverPageTimerRetryOnStartup() {
    // 关闭 PWM / 离开运行时段后也可能仍需补设 1 分钟关机定时器，
    // 因此不以 schedule.enabled 为前提恢复该重试闹钟。浏览器关闭期间错过的
    // retry 也必须重新排程，不能因原时间已经过去而静默放弃关机安全网。
    const retryMinutes = Number(schedule.pageTimerRetryMinutes) || 0;
    const retryAt = Number(schedule.pageTimerRetryAt) || 0;
    if (retryMinutes > 0) {
      if (retryAt > Date.now()) {
        await createAlarm('ac-page-timer-retry', { when: retryAt });
      } else {
        await schedulePageTimerRetry(retryMinutes, '启动恢复错过的页面定时器重试');
        await persistSchedule('init-recover-overdue-page-timer-retry', { syncFromLiveAlarm: false });
      }
    }
  }

  try {
    // 提取（Fowler Extract Function）：init 终极防线——间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
    async function syncFinalLiveAlarmOnInit() {
      // 终极防线：init 完成时，间隔模式下强制从 live ac-pwm 同步 nextTriggerAt 到 storage。
      // 防止 SW 跑早期版本代码、setupAlarms 走重建路径、或某条 persist 漏 sync 时出现
      // "活闹钟在但 storage 缺绝对触发时间" 的红灯。init 末尾是端到端最后一道闭环。
      if (schedule.enabled) {
        const finalLiveAlarm = await chrome.alarms.get('ac-pwm');
        const triggerPlan = await persistReconciledPwmTrigger(finalLiveAlarm, 'init-finalSync', PWM_TRIGGER_NEXT_ONLY_OPTIONS);
        if (triggerPlan) {
          console.log(`[AC扩展] init 末尾: 已从 live alarm 强制同步 nextTriggerAt=${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()}`);
        }
      }
    }

    // 加载 i18n 翻译（SW 上下文也需用 t() 做角标/标题）
    await I18n.load();
    // 最先确保 badge-tick alarm 存在（PWM 补检 + 角标 + SW 保活）
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await loadScheduleFromStorage();
    await backfillNextTriggerAt(true);
    // [v0.5.6] 跨设备同步：在 setupAlarms 之前尝试从 chrome.storage.sync 采用远端相位。
    // 如有 sync 数据则合并到本地 schedule，再 setupAlarms，保证本机闹钟从对齐相位出发。
    // 新装在另一台设备的扩展启动时会先采用主机的 nextTriggerAt，避免本地从默认值跑偏。
    await tryAdoptSyncedState('init');
    // v0.5.10：page timer 已升为跨设备主同步通道（无论 pwmState 都会尝试对齐）
    await tryAdoptPageTimer('init');
    await ensureOffscreen();
    startHeartbeat();
    await setupAlarms();
    await updateBadge();
    if (schedule.enabled) {
      await createAlarm('ac-watchdog', { periodInMinutes: 5 });
    }
    await recoverPageTimerRetryOnStartup();
    await syncFinalLiveAlarmOnInit();
    // init 完成:打开 SW 启动时间跟踪
    swStartupTime = Date.now();
    initCompletedAt = swStartupTime;
    // active hours 边界闹钟：每次 init 都重新调度
    rescheduleActiveBoundary();
    console.log('[AC扩展] 初始化完成', schedule);
  } catch (e) {
    console.error('[AC扩展] 初始化失败，但仍允许消息处理:', e);
    void appendDiagnosticLog('error', 'init', e);
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

  if (startImmediately) {
    await chrome.alarms.clear('ac-pwm');
    schedule.pwmState = 'on';
    // 不在这里写 storage——runPwmStep() 执行完毕后会写入完整的正确状态
    await runPwmStep();
    return;
  }

  // ----- 间隔模式 -----
  // 提取（Fowler Extract Function）：间隔模式下的闹钟恢复链——live 沿用 → storage 恢复 → 过期推进 → 立即补执行 → 重建。
  async function recoverIntervalAlarm() {
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

  await recoverIntervalAlarm();
}

function sanitizeMinutes(value, fallback) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes < 1) return fallback;
  return minutes;
}

async function updateBadge() {
  if (!schedule.enabled) {
    await clearBadge();
    return;
  }

  // 间隔模式
  const liveAlarm = await chrome.alarms.get('ac-pwm');
  const liveAlarmEnd = getLiveAlarmEndMs(liveAlarm);
  const storedAlarmEnd = getStoredAlarmEndMs();
  const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);
  if (!nextBoundary) {
    await clearBadge();
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

// 提取（Fowler Extract Function）：清空角标文案与标题（禁用/无边界两条路径共用）。
async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: t('badgeDefault') });
}

async function runPwmStep() {
  if (!schedule.enabled) return;
  if (pwmStepRunning) {
    console.warn('[AC扩展] PWM 步骤已在执行，跳过重复触发');
    return;
  }
  // A4: 看门狗 5s cooldown — 防止看门狗与闹钟竞态导致重复触发
  if (Date.now() - lastPwmStepAt < 5000) {
    console.warn('[AC扩展] PWM 步骤距上次执行不足 5s，跳过（看门狗 cooldown）');
    return;
  }
  pwmStepRunning = true;

  // 提取（Fowler Extract Function）：PWM 开机 hold 分支——单次点击 + 只读复核，不在外围重试。
  // 观察结果写回 observations，最终返回重新规划后的 plan。
  async function resolveToggleOnHold(plan, observations) {
    try {
      const toggleResult = await toggleAC('on');
      observations.toggleSucceeded = !!toggleResult?.success;
      observations.toggleError = toggleResult?.error || '';
      if (!observations.toggleSucceeded) {
        schedule.pageTimerError = `自动开启未确认：${toggleResult?.error || '未知错误'}`;
      }
    } catch (e) {
      observations.toggleSucceeded = false;
      observations.toggleError = e?.message || String(e);
      schedule.pageTimerError = `自动开启异常：${observations.toggleError}`;
    }

    if (!observations.toggleSucceeded) {
      const actual = await getCurrentACStatus();
      observations.acIsOn = actual?.isOn;
      if (actual?.isOn === true) {
        schedule.pageTimerError = '';
        console.log('[AC扩展] PWM 开机只读复核通过：AC=ON');
      } else {
        console.warn(`[AC扩展] PWM 本轮未开机：实际=${actual?.isOn}；外围不重复点击，1分钟后重试`);
      }
    }
    return planPwmStep(schedule, observations);
  }

  // 提取（Fowler Extract Function）：PWM 关机补时 hold 分支——页面定时器证明缺失时补设 1 分钟定时器。
  async function resolveShortTimerHold(plan, observations) {
    applyPwmPlanState(plan);
    const timerResult = await setPageTimer(plan.timerMinutes, { retryOnFailure: false });
    observations.shortTimerAttempted = true;
    observations.shortTimerSucceeded = !!timerResult?.success;
    schedule.pageTimerError = timerResult?.success
      ? '原页面关机定时器缺失，已补设 1 分钟定时器；本轮不推进且不点击开关'
      : `页面关机定时器未正确设置：${timerResult?.error || '未知错误'}`;
    console.warn('[AC扩展] PWM 关机边界：页面定时器证明缺失，已尝试补设 1 分钟定时器；不点击开关');
    return planPwmStep(schedule, observations);
  }

  // 提取（Fowler Extract Function）：PWM 失败重试分支——写失败诊断、排 1 分钟重试，调用点随后提前返回。
  async function resolveRetryPlan(plan, observations, targetAction) {
    const failureDetail = plan.reason === 'page-timer-failed'
      ? observations.pageTimerError
      : observations.toggleError;
    applyPwmPlanState(plan);
    if (plan.reason === 'page-timer-failed' && targetAction === 'on') {
      schedule.pageTimerError = `开机已成功，但页面关机定时器未确认：${failureDetail || '未知错误'}；保持 on 相位，1 分钟后重试 setPageTimer`;
    } else {
      schedule.pageTimerError = failureDetail || schedule.pageTimerError
        || `自动${targetAction === 'on' ? '开启' : '关闭'}验证失败，1分钟后重试`;
    }
    await createPwmAlarmFromPlan(
      plan,
      plan.reason === 'page-timer-failed' ? 'PWM-pageTimer-failed' : 'PWM失败重试'
    );
    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule(
      plan.reason === 'page-timer-failed'
        ? 'runPwmStep-on-pageTimer-failed'
        : 'runPwmStep-interval'
    );
    await updateBadge();
    console.warn(`[AC扩展] PWM 未提交，保持 pwmState=${schedule.pwmState}，1分钟后重试`);
  }

  return waitUntil((async () => {
  try {
    await loadScheduleFromStorage();
    if (!schedule.enabled) return;

    // 智能模式：启用时按天气重算本周期 on/off 时长（X=0 → 保持关闭 60 分钟）。
    await applySmartModeDurations();

    const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
    const currentDuration = Number(
      targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes
    );
    let observations = {};
    let plan = planPwmStep(schedule, observations);
    if (plan.kind === 'refuse') {
      schedule.pageTimerError = `PWM 阶段拒绝执行：${plan.reason}`;
      console.warn(`[AC扩展] ${schedule.pageTimerError}`);
      await persistSchedule('runPwmStep-refused', { syncFromLiveAlarm: false });
      return;
    }

    applyPwmPlanState(plan);

    console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);

    const preCheckStatus = await getCurrentACStatus();
    observations.acIsOn = preCheckStatus?.isOn;
    if (targetAction === 'off') {
      observations.proofFresh = isPageTimerProofFresh(schedule);
    }
    plan = planPwmStep(schedule, observations);

    if (preCheckStatus?.isOn === (targetAction === 'on')) {
      console.log(`[AC扩展] 预检：AC 已在目标状态 (${targetAction})，跳过切换，直接推进周期`);
    }

    if (targetAction === 'off' && observations.proofFresh === true) {
      console.log(`[AC扩展] PWM 关机边界：页面定时器已正确设置 (${schedule.pageTimerMinutes} 分钟)，不点击开关`);
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'toggle-on') {
      plan = await resolveToggleOnHold(plan, observations);
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'set-page-timer') {
      applyPwmPlanState(plan);
      const pageTimerResult = await setPageTimer(plan.timerMinutes, { retryOnFailure: false });
      observations.pageTimerSucceeded = !!pageTimerResult?.success;
      observations.pageTimerError = pageTimerResult?.error || schedule.pageTimerError || '';
      plan = planPwmStep(schedule, observations);
    }

    if (plan.kind === 'hold' && plan.prerequisite === 'set-short-page-timer') {
      plan = await resolveShortTimerHold(plan, observations);
    }

    if (plan.kind === 'retry') {
      await resolveRetryPlan(plan, observations, targetAction);
      return;
    }

    if (plan.kind !== 'commit') {
      throw new Error(`未处理的 PWM plan: ${plan.kind}/${plan.reason}`);
    }

    // 智能模式：把下一 ON 触发对齐到整点，60 分钟周期锚定整点。
    if (schedule.smartMode?.enabled) {
      alignSmartModeNextTrigger(plan);
    }

    applyPwmPlanState(plan);
    await createPwmAlarmFromPlan(plan, 'PWM');
    console.log(`[AC扩展] PWM 下一阶段:${schedule.pwmState}，${currentDuration}分钟后触发`);

    await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
    await persistSchedule('runPwmStep-interval');
    await updateBadge();

    await syncScheduleToSync('runPwmStep');
  } finally {
    lastPwmStepAt = Date.now();  // A4: 记录最后执行时间
    pwmStepRunning = false;
  }
  })());
}

// 通过新鲜页面确认 Power-off after 已离开当前 React 状态并真正持久化。
// 写入来源页无论是用户页还是扩展自建隐藏页都不能刷新：过早导航可能中断 UST
// 的异步提交。每次读回都新建临时隐藏页，按退避窗口等待服务器落盘后再验证。
async function verifyPageTimerPersistence(expectedValue) {
  let lastActualValue = '';
  let lastFailure = '';

  // 提取（Fowler Extract Function）：单次新鲜页读回尝试——建临时隐藏页、读回、比对、回收。
  async function attemptPersistenceRead(expectedValue, attempt) {
    let verifierTabId = null;
    try {
      await sleep(PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS[attempt]);

      const verifierTab = await chrome.tabs.create({ url: AC_PAGE, active: false });
      verifierTabId = verifierTab?.id || null;
      if (!verifierTabId) throw new Error('无法创建页面定时器验证标签页');
      // 兜底回收闹钟：每轮验证页若 SW 在 sleep(30000) 窗口被杀导致 finally 不执行，
      // 1 分钟后该闹钟兜底关闭隐藏标签，避免泄漏。与 setPageTimer / _toggleOnNewTab 同模式。
      chrome.alarms.create(`ac-close-tab-${verifierTabId}`, { delayInMinutes: 1 });

      const pageReady = await waitForTabReady(verifierTabId, 30000);
      if (!pageReady) throw new Error('页面定时器验证页等待就绪超时');
      const verifierTarget = await getExactACHomeTab(verifierTabId);
      if (!verifierTarget) throw new Error('页面定时器验证页未停留在精确 home URL');
      const readback = await sendReadMessageToExactACHome(
        verifierTabId,
        { action: 'getPageTimer' }
      );
      const actualValue = String(readback?.value || readback?.title || '').trim();
      if (readback?.found && actualValue === expectedValue) {
        return { success: true, value: actualValue };
      }

      lastFailure = `第 ${attempt + 1} 次新鲜页读回不匹配（期望 ${expectedValue}，实际 ${actualValue || '空'}）`;
      return { success: false, actualValue };
    } catch (e) {
      lastFailure = `第 ${attempt + 1} 次新鲜页验证异常：${e?.message || String(e)}`;
      return { success: false };
    } finally {
      // 每个临时验证页只负责一次全新导航读回，立即回收；写入来源页仍由
      // setPageTimer finally 中已有的 ac-close-tab-* 延迟回收逻辑统一处理。
      if (verifierTabId) {
        try { await chrome.tabs.remove(verifierTabId); } catch (_) { /* tab may already be closed */ }
        // 标签已正常回收，清掉上面登记的兜底闹钟，避免误关后续重用同 id 的标签。
        try { await chrome.alarms.clear(`ac-close-tab-${verifierTabId}`); } catch (_) { /* alarm may already fire or absent */ }
      }
    }
  }

  for (let attempt = 0; attempt < PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length; attempt++) {
    const attemptResult = await attemptPersistenceRead(expectedValue, attempt);
    if (attemptResult.success) {
      return { success: true, value: attemptResult.value, attempts: attempt + 1 };
    }
    if (attemptResult.actualValue !== undefined) {
      lastActualValue = attemptResult.actualValue;
    }
  }

  return {
    success: false,
    error: `页面定时器经 ${PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length} 次新鲜页验证后仍未持久化：${lastFailure || '未知错误'}`,
    actualValue: lastActualValue,
    attempts: PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length
  };
}

// 关机定时器设置失败时，记录明确的目标分钟数并用独立闹钟持续重试。
// 该路径服务于“关闭 PWM / 退出运行时段 / sync 停用”等已清除 ac-pwm 的场景；
// 正常 PWM 步骤另有 ac-pwm 1 分钟重试，调用 setPageTimer 时会关闭本重试。
async function schedulePageTimerRetry(minutes, reason = '') {
  const retryMinutes = Math.max(1, sanitizeMinutes(minutes, 1));
  schedule.pageTimerRetryMinutes = retryMinutes;
  schedule.pageTimerRetryAt = Date.now() + 60 * 1000;
  await chrome.alarms.clear('ac-page-timer-retry');
  await createAlarm('ac-page-timer-retry', { when: schedule.pageTimerRetryAt });
  console.warn(`[AC扩展] 页面定时器将于 1 分钟后重试（${retryMinutes} 分钟，${reason || '未说明原因'}）`);
}

// ----- 设置页面自带定时器（安全网，自动关不用手动开）-----
async function setPageTimer(minutes, { retryOnFailure = true } = {}) {
  let autoCreatedTabId = null;

  const finishFailure = async (failure, reason) => {
    schedule.pageTimerMinutes = null;
    schedule.pageTimerTargetAt = 0;
    schedule.pageTimerError = failure.error || t('bgPageTimerFailed');

    if (retryOnFailure) {
      await schedulePageTimerRetry(minutes, reason);
    } else {
      schedule.pageTimerRetryAt = 0;
      schedule.pageTimerRetryMinutes = 0;
      await chrome.alarms.clear('ac-page-timer-retry');
    }

    await persistSchedule(`setPageTimer-${reason}`);
    console.warn('[AC扩展] 页面定时器设置失败:', schedule.pageTimerError);
    return failure;
  };

  // 提取（Fowler Extract Function）：页面定时器成功后的证明记录——解析目标时刻、清重试态、持久化并回传验证结果。
  const recordPageTimerProof = async (result, minutes, verification) => {
    const parsedTarget = parsePageTimerValue(result.value, Date.now());
    schedule.pageTimerTargetAt = parsedTarget?.valid
      ? parsedTarget.targetMs
      : Date.now() + Math.max(1, Number(schedule.pageTimerMinutes) || 1) * 60000;
    schedule.pageTimerError = '';
    schedule.pageTimerRetryAt = 0;
    schedule.pageTimerRetryMinutes = 0;
    await chrome.alarms.clear('ac-page-timer-retry');
    await persistSchedule('setPageTimer-success');
    console.log(`[AC扩展] 页面定时器已由新鲜页面确认: ${verification.value} (安全网)`);
    return { ...result, verified: true, verification };
  };

  try {
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    let tab = tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded) || null;

    if (!tab?.id) {
      tab = await chrome.tabs.create({ url: AC_PAGE, active: false });
      autoCreatedTabId = tab?.id || null;
      if (!autoCreatedTabId) throw new Error(t('bgPageTimerNoTab'));
      console.log('[AC扩展] 页面定时器：无现有 AC 页面，已创建隐藏标签页');
    }

    const pageReady = await waitForTabReady(tab.id, 30000);
    if (!pageReady) throw new Error('AC 页面等待就绪超时');
    tab = await chrome.tabs.get(tab.id);
    if (!isACHomePageTab(tab)) throw new Error('页面定时器目标标签已离开精确 home URL');
    const contentReady = await ensureContentScriptLoaded(tab.id);
    if (!contentReady) throw new Error('AC 页面 content script 未就绪');

    const result = await sendMessageToExactACHome(tab.id, {
      action: 'setTimer',
      minutes
    });
    if (!result?.success) {
      return await finishFailure(result || { success: false, error: t('bgPageTimerFailed') }, 'failed');
    }

    const expectedValue = String(result.value || '').trim();
    if (!expectedValue) {
      return await finishFailure({ success: false, error: '页面定时器未返回可验证的目标时间' }, 'empty-value');
    }

    const verification = await verifyPageTimerPersistence(expectedValue);
    if (!verification.success) {
      return await finishFailure({
        success: false,
        error: verification.error || '页面定时器新鲜页面验证后未确认'
      }, 'persistence-check-failed');
    }

    schedule.pageTimerMinutes = result.actualDelayMinutes || minutes;
    return await recordPageTimerProof(result, minutes, verification);
  } catch (e) {
    return await finishFailure({ success: false, error: e?.message || String(e) }, 'exception');
  } finally {
    if (autoCreatedTabId) {
      chrome.alarms.create(`ac-close-tab-${autoCreatedTabId}`, { delayInMinutes: 1 });
    }
  }
}

async function requestTimerBasedShutdown(reason = '', minutes = 1) {
  if (isPageTimerProofFresh(schedule)) {
    console.log(`[AC扩展] ${reason}: 页面关机定时器已正确设置 (${schedule.pageTimerMinutes} 分钟)，无需点击或重设`);
    return {
      success: true,
      alreadyArmed: true,
      timerBased: true,
      minutes: schedule.pageTimerMinutes,
      reason
    };
  }

  const hadStaleProof = Number(schedule.pageTimerMinutes) > 0
    || Number(schedule.pageTimerTargetAt) > 0
    || Number(schedule.pageTimerRetryAt) > 0
    || Number(schedule.pageTimerRetryMinutes) > 0;
  if (hadStaleProof) {
    clearPageTimerProofState();
    await chrome.alarms.clear('ac-page-timer-retry');
  }

  const status = await getCurrentACStatus();
  if (status?.isOn === false) {
    if (hadStaleProof) {
      await persistSchedule(`${reason}-clear-stale-page-timer-proof`);
    }
    return { success: true, alreadyDone: true, timerBased: true, reason };
  }

  const result = await setPageTimer(minutes);
  if (result?.success) {
    console.log(`[AC扩展] ${reason}: 已请求页面定时器在 ${minutes} 分钟后关机（不点击开关）`);
    return { success: true, timerBased: true, minutes, result, reason };
  }

  return {
    success: false,
    timerBased: true,
    error: result?.error || '页面关机定时器设置失败',
    result,
    reason
  };
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
    // L2 长连接保活不变量:每分钟顺带确保 offscreen 文档仍在,
    // 防止 Chrome/Edge 在长时间无活跃后回收 offscreen 文档导致端口失活。
    await ensureOffscreen();
    // 智能模式：整点刷新天气一次（每小时 HH:00 左右强制拉取，其余分钟命中缓存）。
    if (schedule.smartMode?.enabled && new Date().getMinutes() === 0) {
      getSmartWeather({ force: true }).catch(() => {});
    }
    // 间隔模式下的 storage 一致性校准:PWM 步骤漏写 storage 时,1 分钟内会被这里纠正。
    // 这样诊断面板看到的 storage.nextTriggerAt 永远不会落后 live ac-pwm 超过 1 分钟。
    if (schedule.enabled) {
      try {
        const liveAlarm = await chrome.alarms.get('ac-pwm');
        const triggerPlan = await persistReconciledPwmTrigger(liveAlarm, 'badge-tick-sync', PWM_TRIGGER_NEXT_ONLY_OPTIONS);
        if (triggerPlan) {
          console.log(`[AC扩展] badge-tick: 已同步 nextTriggerAt ← live alarm (${new Date(triggerPlan.liveScheduledTime).toLocaleTimeString()})`);
        }
      } catch (e) {
        console.warn('[AC扩展] badge-tick 同步失败:', e?.message);
        void appendDiagnosticLog('warn', 'alarm-badge-tick', e);
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
      void appendDiagnosticLog('error', 'alarm-ac-pwm', e);
      if (schedule.enabled) {
        const delay = Math.max(1, schedule.pwmState === 'on' ? schedule.onMinutes : schedule.offMinutes);
        await createAlarm('ac-pwm', { delayInMinutes: delay });
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = delay;
        setNextTriggerAt(schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000);
        await persistSchedule('onAlarm-error-recovery');
      }
    }
  }

  if (alarm.name === 'ac-watchdog') {
    try {
      await watchdogCheck();
      // v0.5.10：看门狗每 5 分钟尝试从打开的 AC 页面读取 page timer。
      //         page timer 现为跨设备主同步通道——不再限制 pwmState='on'。
      //         无 AC 页面则静默跳过；5 分钟间隔避免频繁读 DOM。
      if (schedule.enabled) {
        tryAdoptPageTimer('watchdog').catch(e => /* 不阻塞闹钟流程 */ {});
      }
    } catch (e) {
      console.error('[AC扩展] 看门狗执行失败:', e);
      void appendDiagnosticLog('error', 'alarm-watchdog', e);
    }
  }

  if (alarm.name === 'ac-active-boundary') {
    try {
      await onActiveBoundaryCrossed();
    } catch (e) {
      console.warn('[AC扩展] active hours boundary 处理失败:', e?.message);
      void appendDiagnosticLog('warn', 'alarm-active-boundary', e);
      rescheduleActiveBoundary();  // 出错也重新调度，避免漏掉下次
    }
  }

  if (alarm.name === 'ac-page-timer-retry') {
    if (schedule.pageTimerRetryAt) {
      const retryMinutes = schedule.pageTimerRetryMinutes
        || schedule.pageTimerMinutes
        || (schedule.enabled ? schedule.onMinutes : 1);
      await setPageTimer(retryMinutes);
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
const CONTENT_SCRIPT_PROBE_TIMEOUT_MS = 1000;
const CONTENT_SCRIPT_READ_TIMEOUT_MS = 1000;

async function ensureContentScriptLoaded(tabId) {
  if (!await getExactACHomeTab(tabId)) return false;
  try {
    // 健康路径只探测一次；扩展 reload 后旧标签没有接收端时立即注入，
    // 不再先空等多轮。注入不刷新、不导航用户页面。
    const probe = await sendMessageToExactACHome(
      tabId,
      { action: 'ping' },
      { timeoutMs: CONTENT_SCRIPT_PROBE_TIMEOUT_MS }
    );
    if (probe?.success !== true) throw new Error('content script 健康探测返回异常');
    return true;
  } catch (error) {
    console.log('[AC扩展] content script 接收端缺失，尝试原页重新注入:', error?.message);
  }

  return injectContentScriptsIntoExactHome(tabId);
}

async function injectContentScriptsIntoExactHome(tabId) {
  try {
    if (!await getExactACHomeTab(tabId)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['billing-helpers.js', 'content.js'],
      injectImmediately: true
    });
    if (!await getExactACHomeTab(tabId)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-confirm.js'],
      world: 'MAIN',
      injectImmediately: true
    });
    if (!await getExactACHomeTab(tabId)) return false;
    const probe = await sendMessageToExactACHome(
      tabId,
      { action: 'ping' },
      { timeoutMs: CONTENT_SCRIPT_PROBE_TIMEOUT_MS }
    );
    if (probe?.success !== true) throw new Error('重注入后的 content script 健康探测返回异常');
    console.log('[AC扩展] scripting.executeScript 兜底注入并复核完成 (ISOLATED + MAIN)');
    return true;
  } catch (error) {
    console.error('[AC扩展] scripting.executeScript 兜底注入失败:', error?.message);
    void appendDiagnosticLog('error', 'content-script-injection', error);
    return false;
  }
}

async function sendReadMessageToExactACHome(tabId, message) {
  const contentReady = await ensureContentScriptLoaded(tabId);
  if (!contentReady) throw new Error('AC 页面 content script 未就绪');

  try {
    return await sendMessageToExactACHome(
      tabId,
      message,
      { timeoutMs: CONTENT_SCRIPT_READ_TIMEOUT_MS }
    );
  } catch (error) {
    console.warn('[AC扩展] content script 只读消息无响应，强制原页重新注入:', error?.message);
    const recovered = await injectContentScriptsIntoExactHome(tabId);
    if (!recovered) throw error;
    return sendMessageToExactACHome(
      tabId,
      message,
      { timeoutMs: CONTENT_SCRIPT_READ_TIMEOUT_MS }
    );
  }
}

async function getExactACHomeTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return isACHomePageTab(tab) ? tab : null;
  } catch (_) {
    return null;
  }
}

async function sendMessageToExactACHome(tabId, message, { timeoutMs = 0 } = {}) {
  const tab = await getExactACHomeTab(tabId);
  if (!tab) throw new Error('拒绝向非精确 AC home 标签发送消息');

  const responsePromise = chrome.tabs.sendMessage(tabId, message);
  if (!(timeoutMs > 0)) return responsePromise;

  let timeoutId;
  try {
    return await Promise.race([
      responsePromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`content script ${message?.action || 'unknown'} 探测超时`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ----- 切换 AC 状态 -----
async function toggleAC(action) {
  if (acToggleInFlight) {
    if (acToggleInFlightAction === action) {
      console.log(`[AC扩展] 合并重复的 toggleAC(${action}) 请求`);
      return acToggleInFlight;
    }
    return {
      success: false,
      busy: true,
      error: `toggleAC(${acToggleInFlightAction}) 仍在执行，本次 ${action} 不重复点击`
    };
  }

  acToggleInFlightAction = action;
  acToggleInFlight = toggleACOnce(action);
  try {
    return await acToggleInFlight;
  } finally {
    acToggleInFlight = null;
    acToggleInFlightAction = null;
  }
}

async function toggleACOnce(action) {
  // A1: 顶层幂等预检 — 先查当前 AC 真实状态，已是目标则跳过，避免多余开关噪音
  const needOn = action === 'on';
  try {
    const preStatus = await getCurrentACStatus();
    if (typeof preStatus?.isOn === 'boolean' && preStatus.isOn === needOn) {
      console.log(`[AC扩展] 幂等预检：AC 已在目标状态 (${action})，跳过切换`);
      return { success: true, alreadyDone: true, action };
    }
  } catch (_) { /* 预检失败不影响主流程 */ }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const homeTab = tabs.find(tab => isACHomePageTab(tab) && !tab.discarded);

  if (homeTab?.id) {
    return waitUntil(_toggleOnExistingTab(homeTab, action));
  }

  console.log('[AC扩展] 没有精确 AC home 页面，创建隐藏标签...');
  const created = await chrome.tabs.create({ url: AC_PAGE, active: false });
  return waitUntil(_toggleOnNewTab(created?.id, action));
}

async function _toggleOnExistingTab(tab, action) {
  // 操作目标必须从始至终精确等于 AC_PAGE。billing-cycle、warning、登录回调、
  // query/hash 变体和相似路径都属于用户页面，禁止导航、注入或发送空调消息。
  if (!isACHomePageTab(tab)) {
    return {
      success: false,
      invalidTarget: true,
      error: '拒绝在非精确 AC home 标签执行空调操作'
    };
  }

  return attemptACToggleWithRecovery(tab.id, action, 1);
}

async function attemptACToggleOnExactHome(tabId, action) {
  if (!await getExactACHomeTab(tabId)) {
    return {
      success: false,
      invalidTarget: true,
      tabId,
      error: '拒绝在非精确 AC home 标签执行空调操作'
    };
  }

  const ready = await ensureContentScriptLoaded(tabId);
  if (!ready) {
    return { success: false, tabId, error: 'content script 注入失败' };
  }

  try {
    return await sendACToggleMessage(tabId, action);
  } catch (error) {
    console.error('[AC扩展] 发送消息失败:', error?.message);
    void appendDiagnosticLog('error', 'toggle-message', error);
    return { success: false, tabId, error: error?.message || String(error) };
  }
}

async function refreshACControlPage(tabId) {
  try {
    const currentTab = await chrome.tabs.get(tabId);
    if (isACHomePageTab(currentTab)) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url: AC_PAGE });
    }

    const pageReady = await waitForTabReady(tabId, 30000);
    if (!pageReady) throw new Error('刷新后的 AC home 未在 30 秒内就绪');
    const readyTab = await getExactACHomeTab(tabId);
    if (!readyTab) {
      throw new Error('刷新后目标标签未停留在精确 AC home');
    }
    return readyTab;
  } catch (error) {
    console.error('[AC扩展] 恢复 AC 控制页面失败:', error?.message);
    void appendDiagnosticLog('error', 'toggle-refresh-recovery', error);
    return null;
  }
}

async function attemptACToggleWithRecovery(tabId, action, refreshesRemaining = 1, initialError = '') {
  const result = await attemptACToggleOnExactHome(tabId, action);
  if (result.success || result.invalidTarget || refreshesRemaining <= 0) {
    if (!result.success && initialError) {
      void appendDiagnosticLog('error', 'toggle-refresh-recovery', new Error(result.error));
    }
    return initialError
      ? { ...result, recoveredByPageRefresh: true, initialError }
      : result;
  }

  const firstError = initialError || result.error || `${action} 首次操作未确认`;
  console.warn('[AC扩展] 空调操作未成功，恢复 AC 控制页面后重试:', firstError);
  const refreshedTab = await refreshACControlPage(tabId);
  if (!refreshedTab) {
    return {
      success: false,
      tabId,
      recoveredByPageRefresh: true,
      initialError: firstError,
      error: 'AC 控制页面恢复失败'
    };
  }

  return attemptACToggleWithRecovery(
    tabId,
    action,
    refreshesRemaining - 1,
    firstError
  );
}

async function sendACToggleMessage(tabId, action) {
  const result = await sendMessageToExactACHome(tabId, { action });
  console.log(`[AC扩展] ${action} 命令返回:`, result);
  if (!result?.success) {
    console.warn('[AC扩展] 页面返回未确认:', result);
    return {
      success: false,
      tabId,
      result,
      error: result?.error || `${action} 命令未确认`
    };
  }
  return { success: true, tabId, result };
}

async function _toggleOnNewTab(tabId, action) {
  try {
    const tab = await getReadyACTab(tabId, 30000);
    if (!tab?.id) {
      return { success: false, error: '新建的 AC 页面未就绪' };
    }

    return await _toggleOnExistingTab(tab, action);
  } finally {
    // 只关闭扩展自动创建的标签，不能关闭用户原本打开的 HKUST 页面。
    if (Number.isInteger(tabId)) {
      chrome.alarms.create(`ac-close-tab-${tabId}`, { delayInMinutes: 1 });
    }
  }
}

async function getReadyACTab(preferredTabId = null, timeoutMs = 30000) {
  if (preferredTabId) {
    try {
      let tab = await chrome.tabs.get(preferredTabId);
      if (isACHomePageTab(tab)) {
        await waitForTabReady(tab.id, timeoutMs);
        tab = await chrome.tabs.get(tab.id);
        if (isACHomePageTab(tab)) return tab;
      }
    } catch (_) {
      // preferred tab 已关闭，回退到查询现有页面
    }
  }

  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  let tab = tabs.find(isACHomePageTab);
  if (!tab?.id) return null;
  await waitForTabReady(tab.id, timeoutMs);
  tab = await chrome.tabs.get(tab.id);
  return isACHomePageTab(tab) ? tab : null;
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

// 与 isACTab 的宽匹配事实有别：所有 AC 读写只接受完整 URL 精确等于 AC_PAGE。
// slash、query、hash、相似路径、业务子页与登录回调都不能被当作操作目标。
function isACHomePageTab(tab) {
  return tab?.url === AC_PAGE;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getCurrentACStatus() {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const tab = tabs.find(isACHomePageTab);
  if (!tab?.id) {
    return { isOn: null, error: '精确 AC home 页面未打开' };
  }
  try {
    return await sendReadMessageToExactACHome(tab.id, { action: 'status' });
  } catch (e) {
    return { isOn: null, error: 'AC 页面未就绪' };
  }
}

async function getCurrentPageTimer() {
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  const tab = tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded);
  if (!tab?.id) {
    return { found: false, value: null, error: '精确 AC home 页面未打开' };
  }
  try {
    return await sendReadMessageToExactACHome(tab.id, { action: 'getPageTimer' });
  } catch (error) {
    return { found: false, value: null, error: error?.message || 'AC 页面未就绪' };
  }
}

async function ensureScheduleClock() {
  await loadScheduleFromStorage();
  await backfillNextTriggerAt(false);
  if (!schedule.enabled) return;
  // 间隔模式
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
  // 提取（Fowler Extract Function）：当前为 ON 时的关机过渡——先保留 ON 安全检查点，新鲜页确认定时器后才恢复 OFF。
  async function tryArmOffTransition(status) {
    // 先保留“下一步 ON”的安全检查点；只有新鲜页面确认关机定时器后，
    // 才允许恢复为下一步 OFF。
    schedule.pwmState = 'on';
    const timerResult = await setPageTimer(schedule.onMinutes, { retryOnFailure: false });
    if (!timerResult?.success) {
      schedule.pageTimerError = `时钟修复时页面关机定时器未确认：${timerResult?.error || '未知错误'}；保持 on 相位，1 分钟后重试`;
      await createPwmAlarmWithVerify(1, 'repair-pageTimer-failed');
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      await persistSchedule('repairScheduleClock-pageTimer-failed');
      await updateBadge();
      return { success: false, reason: schedule.pageTimerError, schedule: { ...schedule, actualStatus: status } };
    }
    return null;
  }

  if (!schedule.enabled) {
    return { success: false, reason: '定时未启用', schedule };
  }

  // 间隔模式
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

  if (currentOn) {
    const failedResult = await tryArmOffTransition(status);
    if (failedResult) return failedResult;
  }

  schedule.pwmState = currentOn ? 'off' : 'on';
  await createPwmAlarmWithVerify(delay, 'repair');
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule('repairScheduleClock-interval');
  await updateBadge();

  return { success: true, schedule: { ...schedule, actualStatus: status } };
}

// 弹窗 est（Est. until）依赖 full 轮询带回的页面余额。页面重渲染、home
// 暂不可读等瞬态只允许沿用最近有效值；明确离开 Charge Mode 才清除缓存。
// storage.local 让缓存跨完整浏览器重启保留，storage.session 作为同会话热缓存
// 和旧版本迁移源；popup 另有同语义内存缓存，覆盖 lite 轮询和单次消息异常。
const BALANCE_CACHE_KEY = 'ac_balance_cache';
let lastKnownBalanceMinutes = null;
let persistedLocalBalanceMinutes = null;
let persistedSessionBalanceMinutes = null;
let balanceCacheLoaded = false;
let localBalanceCacheStored = false;
let sessionBalanceCacheStored = false;
let balanceCacheLoadPromise = null;

async function loadBalanceCache() {
  if (balanceCacheLoaded) return lastKnownBalanceMinutes;
  if (balanceCacheLoadPromise) return balanceCacheLoadPromise;

  balanceCacheLoadPromise = (async () => {
    const localStorage = chrome.storage?.local;
    const sessionStorage = chrome.storage?.session;
    let localStored = {};
    let sessionStored = {};

    if (localStorage) {
      try {
        localStored = await localStorage.get(BALANCE_CACHE_KEY);
      } catch (error) {
        console.warn('[AC扩展] 读取余额 local 缓存失败:', error?.message);
      }
    }
    if (sessionStorage) {
      try {
        sessionStored = await sessionStorage.get(BALANCE_CACHE_KEY);
      } catch (error) {
        console.warn('[AC扩展] 读取余额 session 缓存失败:', error?.message);
      }
    }

    localBalanceCacheStored = Object.prototype.hasOwnProperty.call(
      localStored || {}, BALANCE_CACHE_KEY
    );
    sessionBalanceCacheStored = Object.prototype.hasOwnProperty.call(
      sessionStored || {}, BALANCE_CACHE_KEY
    );
    const localBalance = localStored?.[BALANCE_CACHE_KEY];
    const sessionBalance = sessionStored?.[BALANCE_CACHE_KEY];
    persistedLocalBalanceMinutes = Number.isFinite(localBalance) ? localBalance : null;
    persistedSessionBalanceMinutes = Number.isFinite(sessionBalance) ? sessionBalance : null;
    lastKnownBalanceMinutes = Number.isFinite(persistedLocalBalanceMinutes)
      ? persistedLocalBalanceMinutes
      : persistedSessionBalanceMinutes;
    balanceCacheLoaded = true;

    if (Number.isFinite(lastKnownBalanceMinutes)) {
      if (localStorage && persistedLocalBalanceMinutes !== lastKnownBalanceMinutes) {
        try {
          await localStorage.set({ [BALANCE_CACHE_KEY]: lastKnownBalanceMinutes });
          persistedLocalBalanceMinutes = lastKnownBalanceMinutes;
          localBalanceCacheStored = true;
        } catch (error) {
          console.warn('[AC扩展] 迁移余额到 local 缓存失败:', error?.message);
        }
      }
      if (sessionStorage && persistedSessionBalanceMinutes !== lastKnownBalanceMinutes) {
        try {
          await sessionStorage.set({ [BALANCE_CACHE_KEY]: lastKnownBalanceMinutes });
          persistedSessionBalanceMinutes = lastKnownBalanceMinutes;
          sessionBalanceCacheStored = true;
        } catch (error) {
          console.warn('[AC扩展] 回填余额 session 缓存失败:', error?.message);
        }
      }
    }
    return lastKnownBalanceMinutes;
  })();

  try {
    return await balanceCacheLoadPromise;
  } finally {
    balanceCacheLoadPromise = null;
  }
}

async function rememberBalanceMinutes(balanceMinutes) {
  lastKnownBalanceMinutes = balanceMinutes;
  balanceCacheLoaded = true;

  const localStorage = chrome.storage?.local;
  const sessionStorage = chrome.storage?.session;
  if (localStorage && (!localBalanceCacheStored || persistedLocalBalanceMinutes !== balanceMinutes)) {
    try {
      await localStorage.set({ [BALANCE_CACHE_KEY]: balanceMinutes });
      persistedLocalBalanceMinutes = balanceMinutes;
      localBalanceCacheStored = true;
    } catch (error) {
      console.warn('[AC扩展] 写入余额 local 缓存失败:', error?.message);
    }
  }
  if (sessionStorage && (!sessionBalanceCacheStored || persistedSessionBalanceMinutes !== balanceMinutes)) {
    try {
      await sessionStorage.set({ [BALANCE_CACHE_KEY]: balanceMinutes });
      persistedSessionBalanceMinutes = balanceMinutes;
      sessionBalanceCacheStored = true;
    } catch (error) {
      console.warn('[AC扩展] 写入余额 session 缓存失败:', error?.message);
    }
  }
}

async function clearBalanceCache() {
  lastKnownBalanceMinutes = null;
  balanceCacheLoaded = true;

  const localStorage = chrome.storage?.local;
  const sessionStorage = chrome.storage?.session;
  if (localStorage) {
    try {
      await localStorage.remove(BALANCE_CACHE_KEY);
      persistedLocalBalanceMinutes = null;
      localBalanceCacheStored = false;
    } catch (error) {
      console.warn('[AC扩展] 清除余额 local 缓存失败:', error?.message);
    }
  }
  if (sessionStorage) {
    try {
      await sessionStorage.remove(BALANCE_CACHE_KEY);
      persistedSessionBalanceMinutes = null;
      sessionBalanceCacheStored = false;
    } catch (error) {
      console.warn('[AC扩展] 清除余额 session 缓存失败:', error?.message);
    }
  }
}

async function mergeBalanceReading(status) {
  if (!status || typeof status !== 'object') return status;

  await loadBalanceCache();
  const merged = { ...status };
  if (typeof merged.balanceMinutes === 'number' && Number.isFinite(merged.balanceMinutes)) {
    await rememberBalanceMinutes(merged.balanceMinutes);
  } else if (merged.balanceState === 'not-charge-mode') {
    await clearBalanceCache();
    delete merged.balanceMinutes;
  } else if (Number.isFinite(lastKnownBalanceMinutes)) {
    merged.balanceMinutes = lastKnownBalanceMinutes;
  }
  return merged;
}

async function getScheduleSnapshot(lite = false) {
  await loadScheduleFromStorage();

  // 提取（Fowler Extract Function）：快照富化——legacy 回填 → live 对齐 → 边界与剩余分钟补丁（保持只读，不落盘）。
  function enrichScheduleSnapshot(snapshot, alarm, liveAlarmEnd) {
    // getSchedule/getScheduleLite 是 popup 的普通轮询入口，必须保持只读。
    // live alarm 或旧相对字段只能补充本次返回快照；持久化自愈留给 init、
    // watchdog 和用户主动触发的诊断，避免打开 popup 改变下一次 PWM 调度。
    if (!snapshot.nextTriggerAt) {
      const legacyEnd = getLegacyAlarmEndMs();
      if (legacyEnd) snapshot.nextTriggerAt = legacyEnd;
    }

    const triggerPlan = reconcilePwmTrigger(snapshot, alarm, PWM_TRIGGER_SNAPSHOT_OPTIONS);
    if (triggerPlan.kind === 'sync-live') {
      Object.assign(snapshot, triggerPlan.phasePatch);
    }

    const storedAlarmEnd = snapshot.nextTriggerAt || (
      snapshot.alarmCreatedAt && snapshot.alarmDelayMinutes
        ? snapshot.alarmCreatedAt + snapshot.alarmDelayMinutes * 60000
        : 0
    );
    const nextBoundary = liveAlarmEnd || (storedAlarmEnd > Date.now() ? storedAlarmEnd : 0);

    if (snapshot.enabled && nextBoundary) {
      const remainingMs = nextBoundary - Date.now();
      if (remainingMs > 0) {
        snapshot._nextBoundary = nextBoundary;
        snapshot.alarmCreatedAt = Date.now();
        snapshot.alarmDelayMinutes = remainingMs / 60000;
      }
    }
  }

  const alarm = await chrome.alarms.get('ac-pwm');
  const liveAlarmEnd = getLiveAlarmEndMs(alarm);
  const snapshot = { ...schedule };

  enrichScheduleSnapshot(snapshot, alarm, liveAlarmEnd);

  if (lite) {
    // Lite 模式：跳过 getCurrentACStatus（tabs.query + sendMessage），仅返回调度快照
    return { ...snapshot, actualStatus: null };
  }

  const status = await mergeBalanceReading(await getCurrentACStatus());
  // 弹窗轮询只读展示，不在这里改写 storage 或重建闹钟，避免重新打开弹窗时漂移触发时间。
  if (typeof status?.isOn === 'boolean' && snapshot.enabled) {
    snapshot._effectivePwmState = status.isOn ? 'off' : 'on';
  }
  return { ...snapshot, actualStatus: status };
}

async function toggleNowAndSync(action) {
  // 提取（Fowler Extract Function）：手动开机后的 ON 相位布防——清旧 alarm、新鲜页确认关机定时器，失败保持 on 相位 1 分钟重试。
  async function armOnPhaseTimerAndAlarms() {
    // 手动开机同样是一个新的 PWM ON 阶段。先清旧 alarm 以免验证期间旧的
    // OFF 边界抢跑；新鲜页确认失败则保持 pwmState='on'，下一次不会再点击。
    schedule.pwmState = 'on';
    setNextTriggerAt(0);
    schedule.alarmCreatedAt = 0;
    schedule.alarmDelayMinutes = 0;
    await chrome.alarms.clear('ac-pwm');

    const timerResult = await setPageTimer(schedule.onMinutes, { retryOnFailure: false });
    if (!timerResult?.success) {
      schedule.pageTimerError = `手动开机后页面关机定时器未确认：${timerResult?.error || '未知错误'}；保持 on 相位，1 分钟后重试`;
      await createPwmAlarmWithVerify(1, 'toggle-pageTimer-failed');
      await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
      await persistSchedule('toggleNowAndSync-pageTimer-failed');
      await updateBadge();
      const status = await getCurrentACStatus();
      return {
        success: false,
        error: schedule.pageTimerError,
        result: timerResult,
        schedule: { ...schedule, actualStatus: status }
      };
    }
    return null;
  }

  if (action === 'off') {
    const timerResult = await requestTimerBasedShutdown('toggle-now-off');
    const status = await getCurrentACStatus();
    return {
      success: !!timerResult?.success,
      error: timerResult?.error,
      schedule: { ...schedule, actualStatus: status },
      result: timerResult
    };
  }

  const toggleResult = await toggleAC('on');

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

  // 间隔模式
  const currentOn = action === 'on';
  const delay = Math.max(1, currentOn ? schedule.onMinutes : schedule.offMinutes);
  clearPageTimerProofState();
  await chrome.alarms.clear('ac-page-timer-retry');

  if (currentOn) {
    const failedResult = await armOnPhaseTimerAndAlarms();
    if (failedResult) return failedResult;
  }

  schedule.pwmState = currentOn ? 'off' : 'on';

  await createPwmAlarmWithVerify(delay, 'toggle');
  await createAlarm('ac-badge-tick', { delayInMinutes: 1 });
  await persistSchedule('toggleNowAndSync-interval');
  await updateBadge();

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
  const triggerPlan = await persistReconciledPwmTrigger(pwmAlarm, 'ensureDiagnosticAlarms', PWM_TRIGGER_NEXT_ONLY_OPTIONS);
  if (triggerPlan) {
    repaired = true;
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

const BACKGROUND_MESSAGE_TYPES = new Set([
  'getSwStatus',
  'updateSchedule',
  'getSchedule',
  'getScheduleLite',
  'getPageTimer',
  'refreshSmartWeather',
  'repairSchedule',
  'toggleNow',
  'ensureDiagnostics'
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!BACKGROUND_MESSAGE_TYPES.has(msg?.type)) return false;

  // getSwStatus 是纯只读诊断接口(swStartupTime / initCompletedAt / schedule / live alarm),
  // 不依赖 init 完成。放在 await initReady 之前响应,防止 init 卡住时诊断面板拿不到 SW 状态。
  if (msg.type === 'getSwStatus') {
    const now = Date.now();
    // L2 offscreen 长连接保活页(阶段58)存活状态:Chrome 110+ 支持 chrome.offscreen API,
    // 早期 Edge 可能抛异常,catch 后 false 兼容老版本。
    Promise.all([
      chrome.alarms.get('ac-pwm'),
      chrome.offscreen.hasDocument().catch(() => false)
    ]).then(([liveAlarm, offscreenAlive]) => {
      sendResponse({
        success: true,
        swStartupTime,
        initCompletedAt,
        swAgeMs: now - swStartupTime,
        initCompleted: !!initCompletedAt,
        initAgeMs: initCompletedAt ? (now - initCompletedAt) : -1,
        memorySchedule: { ...schedule },
        liveAlarmScheduledTime: liveAlarm?.scheduledTime || 0,
        offscreenAlive: !!offscreenAlive
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
      // 提取（Fowler Extract Function）：用户停用路径——B1 顺序：先持久化"已关闭"状态再执行关机。
      const shutdownAfterScheduleDisable = async () => {
        await resetDisabledPwmRuntime();
        // B1: 先持久化"已关闭"状态，再执行关机 — 确保即便 toggleAC 因 SW 终止而丢失，状态已写入 storage
        await persistSchedule('updateSchedule');
        const offResult = await requestTimerBasedShutdown('schedule-disabled');
        if (!offResult?.success) {
          schedule.pageTimerError = `定时已关闭，但页面关机定时器未确认：${offResult?.error || '未知错误'}`;
        }
        return offResult;
      };

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
      // activeHours 单独 merge（嵌套对象）
      if (data.activeHours && typeof data.activeHours === 'object') {
        schedule.activeHours = {
          enabled: !!data.activeHours.enabled,
          start: typeof data.activeHours.start === 'string' ? data.activeHours.start : (schedule.activeHours?.start || '08:00'),
          end: typeof data.activeHours.end === 'string' ? data.activeHours.end : (schedule.activeHours?.end || '23:00')
        };
      }
      // smartMode 单独 merge（嵌套对象，v0.8.0）
      if (data.smartMode && typeof data.smartMode === 'object') {
        schedule.smartMode = {
          enabled: !!data.smartMode.enabled,
          sensitivity: clampSmartSensitivity(data.smartMode.sensitivity)
        };
      }
      // 智能模式开启时立即拉取天气（fire-and-forget），让 popup 读数即时可用；
      // getSmartWeather 内部有 1 小时 TTL 节流，缓存新鲜时不会重复请求。
      if (schedule.smartMode?.enabled) {
        getSmartWeather().catch(() => {});
      }

      let offResult = null;
      if (!schedule.enabled) {
        offResult = await shutdownAfterScheduleDisable();
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
      // active hours 边界闹钟：每次 schedule 改变都重新调度
      rescheduleActiveBoundary();
      // [v0.5.6] 跨设备同步：用户改设置 / toggle 是低频事件，立即推送
      // 在 sendResponse 之前完成推送，让 popup 拿到已推送的状态（虽然异步到达对端有时延）。
      await syncScheduleToSync('updateSchedule');
      sendResponse({ success: true, schedule, offResult });
      return;
    }
    if (msg.type === 'getSchedule') {
      const snapshot = await getScheduleSnapshot();
      sendResponse(snapshot);
      return;
    }
    if (msg.type === 'getScheduleLite') {
      // 轻量轮询：跳过 getCurrentACStatus，降低 90% chrome.* I/O
      const snapshot = await getScheduleSnapshot(true);
      sendResponse(snapshot);
      return;
    }
    if (msg.type === 'getPageTimer') {
      const pageTimer = await getCurrentPageTimer();
      sendResponse(pageTimer);
      return;
    }
    if (msg.type === 'refreshSmartWeather') {
      // popup 主动触发天气拉取（天气缓存缺失/过期时）；getSmartWeather 内部有 TTL 节流。
      const weather = await getSmartWeather();
      sendResponse({ success: true, weather });
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
  })().catch((e) => {
    console.error('[AC扩展] 消息处理失败:', msg?.type, e);
    void appendDiagnosticLog('error', `message-${msg?.type || 'unknown'}`, e);
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

// ----- 启动/恢复兜底 -----
chrome.runtime.onStartup.addListener(() => {
  console.log('[AC扩展] 浏览器启动，恢复 PWM 闹钟');
  initReady.then(() => setupAlarms()).catch((e) => {
    console.error('[AC扩展] onStartup 恢复失败:', e);
    void appendDiagnosticLog('error', 'on-startup', e);
  });
});

// ----- 官方推荐：首次安装/更新时初始化 -----
chrome.runtime.onInstalled.addListener(async (details) => {
  await initReady;
  if (details.reason === 'install') {
    // [v0.5.6] init() 已先尝试从 chrome.storage.sync 采用远端状态。
    // 这里仅当本地仍无 schedule 时才写默认值——避免在另一台设备已运行 PWM 时
    // 用本地默认值覆盖刚被 sync 同步过来的相位。
    const existing = await chrome.storage.local.get(STORAGE_KEY);
    if (!existing[STORAGE_KEY]) {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          enabled: false,
          mode: 'pwm',
          clockMode: false,
          onMinutes: 60,
          offMinutes: 60,
          pwmState: 'off',
          nextTriggerAt: 0,
          alarmCreatedAt: 0,
          alarmDelayMinutes: 0,
          pageTimerTargetAt: 0,
          pageTimerRetryMinutes: 0,
          activeHours: { enabled: false, start: '08:00', end: '23:00' },
          smartMode: { enabled: false, sensitivity: 50 }
        }
      });
      console.log('[AC扩展] 首次安装，已设置默认值（间隔模式）');
      // 若 sync 区也空，则把默认配置 seed 给 sync——让后续在其他设备安装的扩展
      // 自动拿到默认值；若 sync 已有（其他设备先装过），不覆盖。
      if (chrome.storage?.sync) {
        try {
          const syncExisting = await chrome.storage.sync.get(SYNC_KEY);
          if (!syncExisting[SYNC_KEY]) {
            await syncScheduleToSync('install-seed');
          }
        } catch (e) {
          console.warn('[AC扩展] install-seed sync 推送失败:', e?.message);
        }
      }
    } else {
      console.log('[AC扩展] 首次安装：检测到 schedule 已存在（init 采用 sync 或迁移）跳过默认写入');
    }
  } else if (details.reason === 'update') {
    console.log(`[AC扩展] 已更新（${details.previousVersion} → ${chrome.runtime.getManifest().version}）`);
    // [v0.5.6] 更新时把当前 schedule seed 给 sync（若 sync 空），方便新设备加入
    if (chrome.storage?.sync) {
      try {
        const syncExisting = await chrome.storage.sync.get(SYNC_KEY);
        if (!syncExisting[SYNC_KEY] && schedule?.enabled) {
          await syncScheduleToSync('update-seed');
        }
      } catch (_) { /* ignore */ }
    }
  }
});

// ----- 官方推荐：检测到新版本自动热更新 -----
chrome.runtime.onUpdateAvailable.addListener(() => {
  console.log('[AC扩展] 检测到新版本，自动重新加载...');
  chrome.runtime.reload();
});

// ----- storage 变动监听：local 只同步内存状态，sync 触发跨设备合并 -----
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]?.newValue) {
    // 只同步内存状态。不要在每次 storage 写入后 setupAlarms，
    // 否则 runPwmStep 写入下一阶段倒计时时会反复重建闹钟，影响无弹窗后台执行。
    schedule = { ...schedule, ...changes[STORAGE_KEY].newValue };
    return;
  }

  if (areaName === 'sync' && changes[SYNC_KEY]?.newValue) {
    // [v0.5.6] 收到远端 sync 变更 → 异步合并到本地培训 + 重排闹钟。
    // 不在此 await（onChanged 是同步事件回调，不能阻塞）——tryAdoptSyncedState 自带 _syncOpLock
    // 互斥保证并发安全。applySyncedPhase 内部会触发 persistSchedule 触发一次 local 变更 →
    // 上面 local 分支自动同步内存（不会无限循环，因 sync 写采用 lastSyncedAt 守卫）。
    console.log('[AC扩展] sync ↓ onChanged：收到远端变更，启动异步合并');
    tryAdoptSyncedState('onChanged-sync', changes[SYNC_KEY].newValue)
      .catch(e => console.warn('[AC扩展] onChanged sync 合并失败:', e?.message));
  }
});

// ----- 启动 -----
init();
