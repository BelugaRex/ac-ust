// ============================================================
// Popup 脚本 - 设置界面逻辑 + 实时倒计时
// ============================================================

// 普通 HTTP 预览没有 chrome.runtime.id；使用独立演示状态，方便调整开启态界面。
// 真实扩展环境仍只读取 chrome.storage / background 的权威数据。
const IS_STATIC_PREVIEW = !globalThis.chrome?.runtime?.id;
const staticPreviewSchedule = {
  enabled: true,
  mode: 'pwm',
  clockMode: false,
  onMinutes: 15,
  offMinutes: 45,
  activeHours: { enabled: true, start: '08:00', end: '23:00' },
  smartMode: { enabled: false, sensitivity: 5 },
  pwmState: 'off',
  actualStatus: { isOn: true },
  balanceMinutes: 60,
  nextTriggerAt: Date.now() + 30 * 60 * 1000
};

function isPwmPageTimerRetryActive(pageTimerError, scheduledTime, now = Date.now()) {
  const retryAt = Number(scheduledTime);
  const nowMs = Number(now);
  const remainingMs = retryAt - nowMs;
  return !!pageTimerError
    && Number.isFinite(retryAt)
    && Number.isFinite(nowMs)
    && remainingMs > 0
    && remainingMs <= 90 * 1000;
}

function isDiagnosticPageTimerRequired(schedule, actualIsOn, pausedByActiveHours) {
  if (schedule?.enabled !== true || pausedByActiveHours === true) return false;
  if (typeof actualIsOn === 'boolean') return actualIsOn;
  return schedule?.pwmState === 'off';
}

if (IS_STATIC_PREVIEW) {
  document.documentElement.classList.add('static-preview');
}

const appShell = document.getElementById('appShell');

function fitStaticPreviewToViewport() {
  if (!IS_STATIC_PREVIEW || !appShell) return;
  const currentScale = Number(document.documentElement.dataset.previewScale) || 1;
  const renderedRect = appShell.getBoundingClientRect();
  const naturalWidth = renderedRect.width / currentScale;
  const naturalHeight = renderedRect.height / currentScale;
  const availableWidth = document.documentElement.clientWidth || window.innerWidth;
  if (!naturalWidth || !availableWidth) return;

  const scale = Math.min(1, availableWidth / naturalWidth);
  appShell.style.transform = `scale(${scale})`;
  document.body.style.width = `${naturalWidth * scale}px`;
  document.body.style.height = `${naturalHeight * scale}px`;
  document.documentElement.dataset.previewScale = String(scale);
}

function setupStaticPreviewFit() {
  if (!IS_STATIC_PREVIEW || !appShell) return;
  fitStaticPreviewToViewport();
  new ResizeObserver(fitStaticPreviewToViewport).observe(appShell);
  window.addEventListener('resize', fitStaticPreviewToViewport);
}

// i18n 辅助函数 — 委托给 I18n 模块（fetch-based，绕过 chrome.i18n 不可靠性）
const t = (key, ...subs) => I18n.t(key, ...subs);

const onMinutesInput = document.getElementById('onMinutes');
const offMinutesInput = document.getElementById('offMinutes');
const automationToggle = document.getElementById('automationToggle');
const activeHoursToggle = document.getElementById('activeHoursToggle');
const activeHoursStart = document.getElementById('activeHoursStart');
const activeHoursEnd = document.getElementById('activeHoursEnd');
const timerToggle = document.getElementById('timerToggle');
const timerToggleState = document.getElementById('timerToggleState');
const statusDiv = document.getElementById('status');
const statusAnnouncement = document.getElementById('statusAnnouncement');
const acDot = document.getElementById('acDot');
const acStateText = document.getElementById('acStateText');
const countdownDisplay = document.getElementById('countdownDisplay');
const idleDisplay = document.getElementById('idleDisplay');
const countdownNumber = document.getElementById('countdownNumber');
const countdownText = document.getElementById('countdownText');
const safetynetWarning = document.getElementById('safetynetWarning');
const balanceEstimate = document.getElementById('balanceEstimate');
const smartModeToggle = document.getElementById('smartModeToggle');
const smartModeToggleState = document.getElementById('smartModeToggleState');
const smartSensitivity = document.getElementById('smartSensitivity');
const smartSensitivityValue = document.getElementById('smartSensitivityValue');
const timerBody = document.getElementById('timerBody');
const smartBody = document.getElementById('smartBody');
const activeHoursSection = document.getElementById('activeHoursSection');
const activeHoursBody = document.getElementById('activeHoursBody')
  || document.querySelector('#activeHoursSection .field-grid');
const smartSuggested = document.getElementById('smartSuggested');
const smartTeq = document.getElementById('smartTeq');
const smartUpdated = document.getElementById('smartUpdated');

if (activeHoursSection?.parentElement === timerBody) {
  timerBody.before(activeHoursSection);
}

// popup 打开期间保持与 Service Worker 的长连接。
// 这样用户盯着弹窗时，后台不会只靠一次性 sendMessage 存活。
let keepalivePort = null;
try {
  keepalivePort = chrome.runtime.connect({ name: 'popup-keepalive' });
  keepalivePort.onDisconnect.addListener(() => {
    keepalivePort = null;
  });
} catch (_) {
  // 忽略：不影响 alarm 兜底逻辑
}

// ----- 加载已保存的设置 -----
let currentScheduleEnabled = false;
let currentManualMinutes = { onMinutes: 60, offMinutes: 60 };
let currentActiveHours = { enabled: false, start: '08:00', end: '23:00' };
let currentSmartMode = { enabled: false, sensitivity: 5 };
let lastAnnouncedState = '';
let scheduleUpdateChain = Promise.resolve();
let scheduleUpdateRevision = 0;
let pendingScheduleUpdates = 0;
let modeSwitchInFlight = false;

function hasPendingScheduleUpdate() {
  return pendingScheduleUpdates > 0;
}

function updateSmartSensitivityBubble() {
  const value = Number(smartSensitivity.value);
  const min = Number(smartSensitivity.min) || 0;
  const max = Number(smartSensitivity.max) || 10;
  smartSensitivityValue.textContent = String(value);
  const thumbSize = 24;  // 与 CSS thumb 尺寸一致
  const width = smartSensitivity.clientWidth;
  if (width > thumbSize && max > min) {
    const percent = (value - min) / (max - min);
    smartSensitivityValue.style.left = `${percent * (width - thumbSize) + thumbSize / 2}px`;
  }
}

async function loadSettings() {
  const schedule = IS_STATIC_PREVIEW
    ? staticPreviewSchedule
    : (await chrome.storage.local.get('ac_schedule')).ac_schedule || {};
  currentScheduleEnabled = !!schedule.enabled;
  currentManualMinutes = {
    onMinutes: parsePositiveMinutes(schedule.onMinutes) ?? 60,
    offMinutes: parsePositiveMinutes(schedule.offMinutes) ?? 60
  };
  onMinutesInput.value = String(currentManualMinutes.onMinutes);
  offMinutesInput.value = String(currentManualMinutes.offMinutes);
  // activeHours
  const ah = schedule.activeHours || {};
  currentActiveHours = {
    enabled: !!ah.enabled,
    start: typeof ah.start === 'string' ? ah.start : '08:00',
    end: typeof ah.end === 'string' ? ah.end : '23:00'
  };
  syncActiveHoursUI();
  // smartMode
  const sm = schedule.smartMode || {};
  currentSmartMode = {
    enabled: !!sm.enabled,
    sensitivity: normalizeSmartSensitivity(sm.sensitivity ?? 5)
  };
  syncModeUI();
}

function syncActiveHoursUI() {
  activeHoursToggle.checked = currentActiveHours.enabled;
  activeHoursStart.value = currentActiveHours.start;
  activeHoursEnd.value = currentActiveHours.end;
  activeHoursBody.hidden = !currentActiveHours.enabled;
  activeHoursStart.disabled = !currentActiveHours.enabled;
  activeHoursEnd.disabled = !currentActiveHours.enabled;
}

function syncModeUI() {
  const smartSelected = currentSmartMode.enabled;
  const timerSelected = !smartSelected;
  automationToggle.checked = currentScheduleEnabled;

  timerToggle.setAttribute('aria-pressed', String(timerSelected));
  timerToggleState.textContent = timerSelected ? t('modeSelected') : t('modeNotSelected');

  smartModeToggle.setAttribute('aria-pressed', String(smartSelected));
  smartModeToggleState.textContent = smartSelected ? t('modeSelected') : t('modeNotSelected');

  // 灵敏度滑块始终可调，便于在开启智能控制前预设偏好
  smartSensitivity.value = String(currentSmartMode.sensitivity);
  requestAnimationFrame(updateSmartSensitivityBubble);

  // 总开关只控制运行；分段控件始终保留一个模式，关闭时仍可预设参数。
  timerBody.hidden = !timerSelected;
  smartBody.hidden = !smartSelected;
}

function normalize24HourTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})(?::?(\d{2}))$/);
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)
      || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function commitActiveHours() {
  // 读取 UI 值并提交到 background
  const startVal = normalize24HourTime(activeHoursStart.value);
  const endVal = normalize24HourTime(activeHoursEnd.value);
  const startInvalid = activeHoursToggle.checked && !startVal;
  const endInvalid = activeHoursToggle.checked && !endVal;
  const invalidRange = activeHoursToggle.checked
    && !startInvalid && !endInvalid && startVal >= endVal;
  activeHoursStart.setCustomValidity(startInvalid
    ? t('time24Invalid')
    : invalidRange ? t('activeHoursInvalid') : '');
  activeHoursEnd.setCustomValidity(endInvalid
    ? t('time24Invalid')
    : invalidRange ? t('activeHoursInvalid') : '');
  if (startInvalid || endInvalid || invalidRange) {
    (startInvalid ? activeHoursStart : activeHoursEnd).reportValidity();
    return;
  }
  activeHoursStart.value = startVal;
  activeHoursEnd.value = endVal;
  currentActiveHours = {
    enabled: activeHoursToggle.checked,
    start: startVal,
    end: endVal
  };
  syncActiveHoursUI();
  updateSchedule(currentScheduleEnabled, true);
}

activeHoursToggle.addEventListener('change', commitActiveHours);
activeHoursStart.addEventListener('change', commitActiveHours);
activeHoursEnd.addEventListener('change', commitActiveHours);

automationToggle.addEventListener('change', async () => {
  if (modeSwitchInFlight) return;
  const previousEnabled = currentScheduleEnabled;
  const enabled = automationToggle.checked;
  currentScheduleEnabled = enabled;
  syncModeUI();
  const pendingMessage = t(enabled ? 'timerEnabling' : 'timerDisabling');
  setModeSwitchBusy(true, pendingMessage);
  try {
    const result = await updateSchedule(enabled, true);
    if (!result?.success) currentScheduleEnabled = previousEnabled;
  } finally {
    syncModeUI();
    setModeSwitchBusy(false);
  }
});

// ----- 智能模式：开关 + 灵敏度滑块 + 实时读数 -----
function renderSmartReadout(suggested, weather) {
  const hasData = !!(suggested && suggested.valid);
  // 建议开启分钟数（相对 30 分钟周期，如 17/30）
  if (hasData) {
    smartSuggested.textContent = `${suggested.onMinutes}/${SMART_MODE.CYCLE_MINUTES}`;
    smartSuggested.classList.remove('is-empty');
  } else {
    smartSuggested.textContent = '--';
    smartSuggested.classList.add('is-empty');
  }
  // 等效室外温度
  if (hasData) {
    smartTeq.textContent = `${suggested.teq.toFixed(1)} °C`;
    smartTeq.classList.remove('is-empty');
  } else {
    smartTeq.textContent = '--';
    smartTeq.classList.add('is-empty');
  }
  // 天气数据更新时间
  const fetchedAt = Number(weather?.fetchedAt) || 0;
  if (fetchedAt > 0) {
    const d = new Date(fetchedAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    let text = `${hh}:${mm}`;
    if (weather?.stale) text += ` (${t('smartModeWeatherStale')})`;
    smartUpdated.textContent = text;
    smartUpdated.classList.remove('is-empty');
  } else {
    smartUpdated.textContent = weather?.error ? t('smartModeWeatherUnavailable') : '--';
    smartUpdated.classList.add('is-empty');
  }
}

async function updateSmartReadout() {
  if (!currentSmartMode.enabled) {
    renderSmartReadout(null, null);
    return;
  }

  if (IS_STATIC_PREVIEW) {
    renderSmartReadout(computeSmartOnMinutes({
      sensitivity: currentSmartMode.sensitivity,
      temperature: 30,
      dewPoint: 24,
      windSpeedMs: 1.5,
      rainMm: 0
    }), { fetchedAt: Date.now(), stale: false });
    return;
  }

  try {
    const stored = await chrome.storage.local.get('ac_smart_weather');
    const weather = stored.ac_smart_weather;

    // 天气只由后台 :20/:50 one-shot 预取，popup 仅读缓存展示。
    if (!weather || !Number.isFinite(Number(weather.temperature))) {
      renderSmartReadout(null, weather || null);
      return;
    }
    const suggested = computeSmartOnMinutes({
      sensitivity: currentSmartMode.sensitivity,
      temperature: weather.temperature,
      dewPoint: weather.dewPoint,
      windSpeedMs: weather.windSpeedMs,
      rainMm: weather.rainMm
    });
    renderSmartReadout(suggested, weather);
  } catch (e) {
    renderSmartReadout(null, null);
  }
}

smartModeToggle.addEventListener('click', async () => {
  if (modeSwitchInFlight) return;
  if (currentSmartMode.enabled) return;
  currentSmartMode.enabled = true;
  syncModeUI();
  const pendingMessage = t('modeChanging');
  smartModeToggleState.textContent = pendingMessage;
  setModeSwitchBusy(true, pendingMessage);
  try {
    const result = await updateSchedule(currentScheduleEnabled, currentScheduleEnabled);
    if (result?.success) {
      showStatus(t('statusModeSaved'), 'success');
      await updateSmartReadout();
    } else {
      currentSmartMode.enabled = false;
    }
  } finally {
    syncModeUI();
    setModeSwitchBusy(false);
  }
});

smartSensitivity.addEventListener('input', () => {
  // 平滑预览：滑动过程中即时更新建议分钟数，不触发后台写入
  currentSmartMode.sensitivity = normalizeSmartSensitivity(smartSensitivity.value);
  updateSmartSensitivityBubble();
  void updateSmartReadout();
});

async function requestSmartReapplyNow() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'reapplySmartNow' });
    if (!result?.success || result.accepted !== true) {
      showStatus(t('statusError'), 'error');
    }
    return result;
  } catch (error) {
    showStatus(t('statusError'), 'error');
    return { success: false, accepted: false, error: error?.message || String(error) };
  }
}

smartSensitivity.addEventListener('change', async () => {
  // 释放滑块：先持久化灵敏度，再通知后台立即重设当前 ON 相位的 Power-off after。
  currentSmartMode.sensitivity = normalizeSmartSensitivity(smartSensitivity.value);
  syncModeUI();
  let updateResult = await updateSchedule(currentScheduleEnabled, false);
  if (!updateResult?.success) return;
  if (updateResult.superseded) {
    updateResult = await waitForLatestScheduleUpdateResult();
  }
  if (!updateResult?.success || updateResult.superseded) return;
  if (!IS_STATIC_PREVIEW && currentSmartMode.enabled && currentScheduleEnabled) {
    await requestSmartReapplyNow();
  }
});

// ----- 从后台拉取当前状态 + 直接读真实 PWM 闹钟 -----
// 性能优化：每 10 次轮询用 1 次完整 getSchedule（含 AC 真实状态），
// 其余 9 次用 getScheduleLite（省去 tabs.query + sendMessage，降低 ~90% I/O）
let pollCount = 0;
let cachedActualStatus = null;

function mergeActualStatusCache(cachedStatus, incomingStatus) {
  const cached = cachedStatus && typeof cachedStatus === 'object'
    ? cachedStatus
    : null;
  if (!incomingStatus || typeof incomingStatus !== 'object') {
    return cached ? { ...cached } : null;
  }

  const merged = { ...incomingStatus };
  if (merged.balanceState === 'not-charge-mode') {
    delete merged.balanceMinutes;
    return merged;
  }

  const hasIncomingBalance = typeof merged.balanceMinutes === 'number'
    && Number.isFinite(merged.balanceMinutes);
  if (!hasIncomingBalance
      && typeof cached?.balanceMinutes === 'number'
      && Number.isFinite(cached.balanceMinutes)) {
    merged.balanceMinutes = cached.balanceMinutes;
  }
  return merged;
}

function attachCachedActualStatus(schedule) {
  if (!schedule || typeof schedule !== 'object') return schedule;
  cachedActualStatus = mergeActualStatusCache(cachedActualStatus, schedule.actualStatus);
  if (cachedActualStatus) schedule.actualStatus = cachedActualStatus;
  return schedule;
}

function isAutomationPausedByActiveHours(schedule, now = new Date()) {
  if (!schedule?.enabled || schedule.activeHours?.enabled !== true) return false;
  const start = String(schedule.activeHours.start || '').match(/^(\d{2}):(\d{2})$/);
  const end = String(schedule.activeHours.end || '').match(/^(\d{2}):(\d{2})$/);
  if (!start || !end) return true;
  const startMinutes = Number(start[1]) * 60 + Number(start[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  if (startMinutes >= endMinutes || endMinutes > 24 * 60 - 1) return true;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes < startMinutes || currentMinutes >= endMinutes;
}

async function refreshStatus() {
  if (hasPendingScheduleUpdate()) return;
  const refreshRevision = scheduleUpdateRevision;

  if (IS_STATIC_PREVIEW) {
    updateCountdownDisplay(staticPreviewSchedule, {
      scheduledTime: staticPreviewSchedule.nextTriggerAt
    });
    void updateSmartReadout();
    return;
  }

  try {
    const useLite = pollCount++ % 10 !== 0;
    const msgType = useLite ? 'getScheduleLite' : 'getSchedule';

    const [response, alarm] = await Promise.all([
      chrome.runtime.sendMessage({ type: msgType }),
      chrome.alarms.get('ac-pwm')
    ]);
    if (hasPendingScheduleUpdate() || refreshRevision !== scheduleUpdateRevision) return;

    // getSchedule 正常返回 snapshot；异常时后台可能返回 { success:false, schedule }。
    const schedule = response?.success === false && response?.schedule
      ? response.schedule
      : response;
    if (!schedule || typeof schedule !== 'object') {
      throw new Error('后台未返回有效 schedule');
    }

    // full、lite 都走同一合并规则：暂不可读沿用最近有效余额，明确非
    // Charge Mode 才清除。这样 SW 重启或单次消息异常不会让 Est 闪退。
    attachCachedActualStatus(schedule);

    updateCountdownDisplay(schedule, alarm);
  } catch (e) {
    if (hasPendingScheduleUpdate() || refreshRevision !== scheduleUpdateRevision) return;
    const stored = await chrome.storage.local.get("ac_schedule");
    if (hasPendingScheduleUpdate() || refreshRevision !== scheduleUpdateRevision) return;
    if (stored.ac_schedule) {
      const alarm = await chrome.alarms.get("ac-pwm");
      if (hasPendingScheduleUpdate() || refreshRevision !== scheduleUpdateRevision) return;
      const fallbackSchedule = attachCachedActualStatus({ ...stored.ac_schedule });
      const pausedByActiveHours = isAutomationPausedByActiveHours(fallbackSchedule);
      fallbackSchedule._insideActiveHours = !pausedByActiveHours;
      fallbackSchedule._automationPausedByActiveHours = pausedByActiveHours;
      updateCountdownDisplay(fallbackSchedule, alarm);
    }
  }

  void updateSmartReadout();
}

function announceState(message) {
  if (!message || message === lastAnnouncedState) return;
  lastAnnouncedState = message;
  statusAnnouncement.textContent = message;
}

function updateSafetynetWarning(message) {
  const changed = safetynetWarning.textContent !== message;
  safetynetWarning.style.display = message ? 'block' : 'none';
  safetynetWarning.textContent = message;
  if (changed && message) announceState(message);
}

function renderBalanceEstimate(schedule) {
  const rawBalance = schedule?.balanceMinutes ?? schedule?.actualStatus?.balanceMinutes;
  const balance = rawBalance === null || rawBalance === '' ? NaN : Number(rawBalance);
  const estimate = estimateBalanceExhaustion({
    balanceMinutes: balance,
    onMinutes: schedule?.onMinutes,
    offMinutes: schedule?.offMinutes
  });
  const displayAt = Number(estimate?.displayAt);
  const pausedByActiveHours = schedule?._automationPausedByActiveHours === true
    || isAutomationPausedByActiveHours(schedule);
  if (!schedule?.enabled || pausedByActiveHours
      || !Number.isFinite(balance) || balance < 0
      || !Number.isFinite(displayAt)) {
    hideBalanceEstimate();
    return;
  }

  const locale = I18n.getLang().replace('_', '-');
  const { shortAt, fullAt } = formatBalanceExhaustionAt(displayAt, locale);
  const urgent = isBalanceEstimateUrgent(estimate?.usableWallMinutes);

  showBalanceEstimate(shortAt, fullAt, urgent);
}

// 提取（Fowler Extract Function）：余额预计 DOM 应用——前缀/时刻两段内容、警示态与无障碍标签。
function showBalanceEstimate(shortAt, fullAt, urgent) {
  const estimateTitle = t(urgent ? 'balanceEstimateUrgentTitle' : 'balanceEstimateTitle', fullAt);
  const estimatePrefix = document.createElement('span');
  estimatePrefix.className = 'balance-estimate-prefix';
  estimatePrefix.textContent = t('balanceEstimatePrefix');
  const estimateTime = document.createElement('span');
  estimateTime.className = 'balance-estimate-time';
  estimateTime.textContent = shortAt;
  balanceEstimate.replaceChildren(estimatePrefix, estimateTime);
  balanceEstimate.classList.toggle('is-urgent', urgent);
  balanceEstimate.title = estimateTitle;
  if (urgent) {
    balanceEstimate.setAttribute('aria-label', estimateTitle);
  } else {
    balanceEstimate.removeAttribute('aria-label');
  }
  balanceEstimate.hidden = false;
}

// 提取（Fowler Extract Function）：余额预计隐藏路径——不可用时清警示态与无障碍标签。
function hideBalanceEstimate() {
  balanceEstimate.classList.remove('is-urgent');
  balanceEstimate.removeAttribute('aria-label');
  balanceEstimate.hidden = true;
}

// 提取（Fowler Extract Function）：余额耗尽时刻的本地化格式化（同日/次日/具体日期 + 时:分）。
function formatBalanceExhaustionAt(displayAt, locale) {
  const target = new Date(displayAt);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = target.toDateString() === today.toDateString();
  const nextDay = target.toDateString() === tomorrow.toDateString();
  const clockAt = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const monthDay = `${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  const shortDate = sameDay
    ? t('balanceEstimateToday')
    : nextDay
      ? t('balanceEstimateTomorrow')
      : monthDay;
  return {
    shortAt: `${shortDate} ${clockAt}`,
    fullAt: new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hourCycle: 'h23'
    }).format(target)
  };
}

function updateCountdownDisplay(schedule, alarm) {
  renderBalanceEstimate(schedule);
  idleDisplay.textContent = t('acIdle');
  // 同步智能模式启用状态（跨设备 sync / 后台变更后保持 UI 一致；不覆盖灵敏度，避免拖动滑块时跳回）
  if (schedule && typeof schedule.smartMode === 'object') {
    currentSmartMode.enabled = !!schedule.smartMode.enabled;
  }
  const pausedByActiveHours = schedule?._automationPausedByActiveHours === true;
  if (!schedule || (!schedule.enabled && !pausedByActiveHours)) {
    currentScheduleEnabled = false;
    syncModeUI();
    // 定时未启用
    acDot.className = 'ac-dot off';
    acStateText.textContent = t('acOff');
    countdownDisplay.style.display = 'none';
    idleDisplay.style.display = 'flex';
    updateSafetynetWarning('');
    announceState(t('acOff'));
    return;
  }

  currentScheduleEnabled = true;
  syncModeUI();
  idleDisplay.style.display = pausedByActiveHours ? 'flex' : 'none';
  countdownDisplay.style.display = pausedByActiveHours ? 'none' : 'flex';
  if (pausedByActiveHours) {
    idleDisplay.textContent = t('activeHoursOutside');
  }

  // 优先级：full 路径 _effectivePwmState（页面真实状态反推）> lite 路径合并的
  // cached actualStatus 反推 > 兜底 pwmState。fallback 加 cached 反推是为了
  // ON 路径 setPageTimer 失败的故障态：background.js 故意保持 pwmState='on' 让
  // 1 分钟后整轮幂等 ON + 重试 setPageTimer（见 background.js runPwmStep 顶部
  // "PWM ON 失败重试" 注释），此时 pwmState='on' 既不代表"AC 当前 OFF"也不代表
  // "用户应看到分钟后自动开启"。状态行已通过 refreshStatus() 合并的 cached
  // actualStatus 显示"冷气运行中"，hero caption 必须同源取 cached actualStatus
  // 反推，否则会出现"运行中、分钟后自动开启"这种自相矛盾文案。
  const nextAction = schedule._effectivePwmState
    || schedule._nextAction
    || (typeof schedule.actualStatus?.isOn === 'boolean'
      ? (schedule.actualStatus.isOn ? 'off' : 'on')
      : schedule.pwmState);
  const inferredACOn = nextAction !== 'on';
  const currentACOn = typeof schedule.actualStatus?.isOn === 'boolean'
    ? schedule.actualStatus.isOn
    : inferredACOn;

  // 更新 AC 状态指示灯
  if (currentACOn) {
    acDot.className = 'ac-dot on';
    acStateText.textContent = t('acRunning');
    announceState(t('acRunning'));
    if (schedule.pageTimerError) {
      const warning = schedule.pageTimerMinutes
        ? t('safetynetError', schedule.pageTimerError)
        : t('safetynetNotSet', schedule.pageTimerError);
      updateSafetynetWarning(warning);
    } else {
      updateSafetynetWarning('');
    }
  } else {
    acDot.className = 'ac-dot off';
    acStateText.textContent = t('acStopped');
    updateSafetynetWarning('');
    announceState(t('acStopped'));
  }

  if (pausedByActiveHours) {
    updateSafetynetWarning('');
    announceState(t('activeHoursOutside'));
    return;
  }

  // 计算并渲染 hero 倒计时（提取自 updateCountdownDisplay，Fowler Extract Function）
  renderCountdown(schedule, alarm, nextAction);
}

// 提取（Fowler Extract Function）：倒计时来源链（_nextBoundary → live alarm → alarmCreatedAt 推算）与 hero 渲染。
function renderCountdown(schedule, alarm, nextAction) {
  // 计算倒计时（v0.5.x 起只保留间隔模式）
  let remainingMs = 0;
  if (schedule._nextBoundary) {
    remainingMs = schedule._nextBoundary - Date.now();
  } else if (alarm?.scheduledTime) {
    remainingMs = alarm.scheduledTime - Date.now();
  } else if (schedule.alarmCreatedAt && schedule.alarmDelayMinutes) {
    remainingMs = schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000 - Date.now();
  }

  if (remainingMs > 0) {
    const minutes = Math.ceil(remainingMs / 60000);
    // hero 结构：大数字独立元素，下方 caption 说明动作；文本节点写入不带 HTML
    countdownNumber.textContent = String(minutes);
    countdownNumber.style.display = '';
    countdownText.textContent = t('countdownCaption', t(nextAction === 'on' ? 'actionOn' : 'actionOff'));
  } else {
    countdownNumber.style.display = 'none';
    countdownText.textContent = t('countdownSoon', t(nextAction === 'on' ? 'actionOn' : 'actionOff'));
  }
}

function parsePositiveMinutes(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function validateManualMinutes({ report = false } = {}) {
  const onMinutes = parsePositiveMinutes(onMinutesInput.value);
  const offMinutes = parsePositiveMinutes(offMinutesInput.value);
  const message = t('minutesInvalid');
  onMinutesInput.setCustomValidity(onMinutes === null ? message : '');
  offMinutesInput.setCustomValidity(offMinutes === null ? message : '');
  const invalidInput = onMinutes === null ? onMinutesInput : offMinutes === null ? offMinutesInput : null;
  if (invalidInput) {
    if (report) invalidInput.reportValidity();
    return null;
  }
  currentManualMinutes = { onMinutes, offMinutes };
  return currentManualMinutes;
}

// ----- 更新定时设置 -----
async function updateSchedule(enabled, restart = false) {
  const manualMinutes = validateManualMinutes({ report: enabled && !currentSmartMode.enabled });
  if (!manualMinutes && enabled && !currentSmartMode.enabled) {
    showStatus(t('minutesInvalid'), 'error');
    return { success: false, validationError: true, superseded: false };
  }
  const updateRevision = ++scheduleUpdateRevision;
  const data = {
    enabled,
    mode: 'pwm',
    clockMode: false,  // v0.5.x 起固定间隔模式
    onMinutes: manualMinutes?.onMinutes ?? currentManualMinutes.onMinutes,
    offMinutes: manualMinutes?.offMinutes ?? currentManualMinutes.offMinutes,
    activeHours: { ...currentActiveHours },  // 两种自动控制共用的运行时段
    smartMode: { ...currentSmartMode },      // v0.8.0: 智能模式（灵敏度 + 开关）
    restart
  };

  pendingScheduleUpdates += 1;

  const operation = scheduleUpdateChain
    .catch(() => {})
    .then(async () => {
      try {
        if (IS_STATIC_PREVIEW) {
          Object.assign(staticPreviewSchedule, data, {
            actualStatus: { isOn: data.enabled },
            pwmState: data.enabled ? 'off' : 'on',
            nextTriggerAt: data.enabled ? Date.now() + data.onMinutes * 60 * 1000 : 0
          });
          const superseded = updateRevision !== scheduleUpdateRevision;
          if (!superseded) {
            currentScheduleEnabled = data.enabled;
            updateCountdownDisplay(staticPreviewSchedule, {
              scheduledTime: staticPreviewSchedule.nextTriggerAt
            });
            showStatus(
              t(data.enabled
                ? (data.smartMode.enabled ? 'statusSmartOnOK' : 'statusOnOK')
                : 'statusClosedOK'),
              'success'
            );
          }
          return { success: true, superseded };
        }

        const response = await chrome.runtime.sendMessage({
          type: 'updateSchedule',
          data
        });
        const superseded = updateRevision !== scheduleUpdateRevision;
        if (superseded) return { ...response, superseded: true };
        if (!response?.success) {
          showStatus(t('statusError'), 'error');
          return { ...response, success: false, superseded: false };
        }

        currentScheduleEnabled = data.enabled;
        // background 已负责关闭路径；popup 不再发送第二次 toggleNow。
        showStatus(
          t(data.enabled
            ? (data.smartMode.enabled ? 'statusSmartOnOK' : 'statusOnOK')
            : 'statusClosedOK'),
          'success'
        );

        const alarm = await chrome.alarms.get('ac-pwm');
        if (updateRevision === scheduleUpdateRevision) {
          updateCountdownDisplay(attachCachedActualStatus(response.schedule), alarm);
        }
        return { ...response, superseded: updateRevision !== scheduleUpdateRevision };
      } catch (error) {
        const superseded = updateRevision !== scheduleUpdateRevision;
        if (!superseded) showStatus(t('statusError'), 'error');
        return {
          success: false,
          superseded,
          error: error?.message || String(error)
        };
      }
    });

  scheduleUpdateChain = operation.catch(() => {});
  try {
    return await operation;
  } finally {
    pendingScheduleUpdates -= 1;
  }
}

async function waitForLatestScheduleUpdateResult() {
  while (true) {
    const observedRevision = scheduleUpdateRevision;
    const observedOperation = scheduleUpdateChain;
    const result = await observedOperation;
    if (observedRevision === scheduleUpdateRevision
        && observedOperation === scheduleUpdateChain) {
      return result;
    }
  }
}

function setModeSwitchBusy(busy, message = '') {
  modeSwitchInFlight = busy;
  for (const toggle of [automationToggle, timerToggle, smartModeToggle]) {
    toggle.disabled = busy;
    if (busy) toggle.setAttribute('aria-busy', 'true');
    else toggle.removeAttribute('aria-busy');
  }
  if (busy) {
    statusDiv.setAttribute('aria-busy', 'true');
    showStatus(message, '');
  } else {
    statusDiv.removeAttribute('aria-busy');
  }
}

// ----- 自动模式分段选择（循环定时与智能控制互斥） -----
timerToggle.addEventListener('click', async () => {
  if (modeSwitchInFlight) return;
  if (!currentSmartMode.enabled) return;
  currentSmartMode.enabled = false;
  syncModeUI();
  const pendingMessage = t('modeChanging');
  timerToggleState.textContent = pendingMessage;
  setModeSwitchBusy(true, pendingMessage);
  try {
    const result = await updateSchedule(currentScheduleEnabled, currentScheduleEnabled);
    if (result?.success) showStatus(t('statusModeSaved'), 'success');
    else currentSmartMode.enabled = true;
  } finally {
    syncModeUI();
    setModeSwitchBusy(false);
  }
});

// ----- 修改分钟数自动保存；运行中则重启当前周期 -----
for (const input of [onMinutesInput, offMinutesInput]) {
  input.addEventListener('change', async () => {
    if (!validateManualMinutes({ report: true })) return;
    const result = await updateSchedule(currentScheduleEnabled, currentScheduleEnabled);
    if (result?.success && !currentScheduleEnabled) {
      showStatus(t('statusSettingsSaved'), 'success');
    }
  });
}

// ----- 状态显示 -----
function showStatus(msg, type) {
  statusDiv.textContent = msg;
  statusDiv.className = 'status ' + type;
}

async function startup() {
  // 先加载 i18n 翻译，再填充 DOM 静态文本，最后拉取状态
  await I18n.load();
  I18n.applyToDOM();
  document.documentElement.lang = I18n.getLang().replace('_', '-');
  await loadSettings();
  await refreshStatus();
}

startup().then(setupStaticPreviewFit);
setInterval(refreshStatus, 1000);

// 从 manifest 读取版本号（硬编码兜底：硬编码须与 manifest.json 版本同步，build.sh 会在 dist/ 中再次核对并注入）
const APP_VERSION = '0.8.2';
// BUILD_TIME 由 build.sh 注入,用于诊断扩展实际加载的是哪次 build
// (同名版本号 0.4.28 可能对应多次代码改动,构建时间戳可区分)
const BUILD_TIME = 'dev';
const BUILD_TIME_EPOCH_MS = 0;

function formatBuildTimeShort(buildTime) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):\d{2}$/.exec(buildTime);
  if (!match) return buildTime;
  const [, , month, day, hour, minute] = match;
  return `${month}/${day} ${hour}:${minute}`;
}

const versionInfo = document.getElementById('versionInfo');
if (versionInfo) {
  let displayVersion;
  try {
    const manifest = chrome.runtime.getManifest();
    displayVersion = manifest.version;
    // 交叉校验：硬编码与 manifest 不同步时提示作者 (manifest 是指北明令的单一版本真相源,此处胜出,硬编码仅作 chrome.runtime 不可用时的兜底)
    if (displayVersion !== APP_VERSION) {
      console.warn(t('versionMismatch', displayVersion, APP_VERSION));
    }
  } catch (_) {
    displayVersion = APP_VERSION;
  }
  // 同一版本可能有多次构建：头栏显示分钟级短时间，tooltip 保留完整秒级时间。
  const buildInfo = `AC-UST v${displayVersion} · ${BUILD_TIME}`;
  versionInfo.textContent = `v${displayVersion} · ${formatBuildTimeShort(BUILD_TIME)}`;
  versionInfo.title = buildInfo;
  versionInfo.setAttribute('aria-label', buildInfo);
  document.title = `AC-UST v${displayVersion}`;
}

// ----- 自诊断：检查 PWM 链路各环节状态 -----
const btnDiagnose = document.getElementById('btnDiagnose');
const diagnoseResult = document.getElementById('diagnoseResult');
const btnCopyDiag = document.getElementById('btnCopyDiag');
const DIAGNOSTIC_MESSAGE_TIMEOUT_MS = 10000;
const DIAGNOSTIC_TRIGGER_TOLERANCE_MS = 1500;
let lastDiagLines = [];

function getTimestampAgeMs(timestamp, nowMs = Date.now()) {
  const value = Number(timestamp);
  const now = Number(nowMs);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(now)) return null;
  const ageMs = now - value;
  return ageMs >= 0 ? ageMs : null;
}

function areDiagnosticTriggersAligned(...triggerTimes) {
  const times = triggerTimes.map(Number);
  if (times.length < 2 || times.some(time => !Number.isFinite(time) || time <= 0)) {
    return false;
  }
  return Math.max(...times) - Math.min(...times) < DIAGNOSTIC_TRIGGER_TOLERANCE_MS;
}

async function sendDiagnosticRuntimeMessage(message) {
  let timeoutId;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${message?.type || 'unknown'} timeout`));
        }, DIAGNOSTIC_MESSAGE_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// 复制诊断结果到剪贴板：Markdown 代码块格式，方便用户一键粘贴进 GitHub issue。
// 兼容回退 execCommand，万一 clipboard API 在某些环境不可用（MV3 popup 在 secure context 通常正常）。
if (btnCopyDiag) {
  btnCopyDiag.addEventListener('click', async () => {
    if (!lastDiagLines.length) {
      showStatus(t('copyDiagEmpty'), 'error');
      return;
    }
    const NL = String.fromCharCode(10);
    const text = '```' + NL + lastDiagLines.join(NL) + NL + '```';
    let ok;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    showStatus(ok ? t('copyDiagDone') : t('copyFailed'), ok ? 'success' : 'error');
  });
}

function renderDiagnoseResult(lines) {
  const fragment = document.createDocumentFragment();
  lines.forEach((line, index) => {
    if (index > 0) fragment.append(document.createElement('br'));
    fragment.append(document.createTextNode(line));
  });
  document.getElementById('diagContent').replaceChildren(fragment);
}

function selectRecentDiagnosticEntries(entries, nowMs = Date.now()) {
  const now = Number(nowMs);
  const buildEpoch = Number(BUILD_TIME_EPOCH_MS);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(buildEpoch) || buildEpoch < 0) {
    return { total: 0, entries: [] };
  }

  const eligible = Array.isArray(entries)
    ? entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry
        && typeof entry === 'object'
        && Number.isSafeInteger(entry.timestamp)
        && entry.timestamp >= buildEpoch
        && entry.timestamp <= now)
      .sort((left, right) => (
        right.entry.timestamp - left.entry.timestamp || right.index - left.index
      ))
    : [];

  return {
    total: eligible.length,
    entries: eligible.slice(0, 5).map(({ entry }) => entry)
  };
}

function appendRecentDiagnosticLogLines(lines, entries, nowMs = Date.now()) {
  const selection = selectRecentDiagnosticEntries(entries, nowMs);
  if (!selection.total) {
    lines.push('✅ ' + t('diagnoseRecentErrorsEmpty'));
    return;
  }

  lines.push(t('diagnoseRecentErrors', selection.total, selection.entries.length));
  selection.entries.forEach((entry) => {
    const time = new Date(entry.timestamp).toLocaleString();
    const level = entry.level === 'warn' ? 'WARN' : 'ERROR';
    const source = String(entry.source || 'unknown').slice(0, 80);
    const message = String(entry.message || '').slice(0, 300);
    lines.push(`🕘 ${time} [HISTORY ${level}/${source}] ${message}`);
  });
}

function evaluatePopupPageState(snapshot, schedule) {
  const page = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const config = schedule && typeof schedule === 'object' ? schedule : {};
  const controls = page.controls && typeof page.controls === 'object'
    ? page.controls
    : {};
  const expected = {
    automation: config.enabled === true,
    activeHours: config.activeHours?.enabled === true,
    timer: config.smartMode?.enabled !== true,
    smart: config.smartMode?.enabled === true,
    activeHoursStart: typeof config.activeHours?.start === 'string'
      ? config.activeHours.start
      : '08:00',
    activeHoursEnd: typeof config.activeHours?.end === 'string'
      ? config.activeHours.end
      : '23:00'
  };
  const dimensionsValid = Number(page.viewportWidth) > 0
    && Number(page.viewportHeight) > 0
    && Number(page.contentWidth) > 0
    && Number(page.contentHeight) > 0;
  const controlMismatches = [
    ['automationChecked', expected.automation],
    ['activeHoursChecked', expected.activeHours],
    ['activeHoursStart', expected.activeHoursStart],
    ['activeHoursEnd', expected.activeHoursEnd],
    ['activeHoursBodyHidden', !expected.activeHours],
    ['activeHoursStartDisabled', !expected.activeHours],
    ['activeHoursEndDisabled', !expected.activeHours],
    ['timerPressed', expected.timer],
    ['timerBodyHidden', !expected.timer],
    ['smartPressed', expected.smart],
    ['smartBodyHidden', !expected.smart]
  ]
    .filter(([field, expectedValue]) => controls[field] !== expectedValue)
    .map(([field, expectedValue]) => (
      `${field}(expected=${expectedValue}, actual=${String(controls[field])})`
    ));
  const controlSync = page.updatePending === true
    ? null
    : controlMismatches.length === 0;

  return {
    documentReady: page.readyState === 'interactive' || page.readyState === 'complete',
    documentVisible: page.visibilityState === 'visible',
    dimensionsValid,
    horizontalOverflow: dimensionsValid
      && Number(page.contentWidth) > Number(page.viewportWidth) + 1,
    controlSync,
    controlMismatches,
    expected
  };
}

function readPopupPageSnapshot() {
  const root = document.documentElement;
  const body = document.body;
  const shellRect = appShell?.getBoundingClientRect();
  const viewportWidth = Math.round(root?.clientWidth || window.innerWidth || 0);
  const viewportHeight = Math.round(root?.clientHeight || window.innerHeight || 0);
  const contentWidth = Math.round(Math.max(
    root?.scrollWidth || 0,
    body?.scrollWidth || 0,
    appShell?.scrollWidth || 0,
    shellRect?.width || 0
  ));
  const contentHeight = Math.round(Math.max(
    root?.scrollHeight || 0,
    body?.scrollHeight || 0,
    appShell?.scrollHeight || 0,
    shellRect?.height || 0
  ));

  return {
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    language: root?.lang || '?',
    viewportWidth,
    viewportHeight,
    contentWidth,
    contentHeight,
    keepaliveConnected: keepalivePort !== null,
    updatePending: hasPendingScheduleUpdate() || modeSwitchInFlight,
    controls: {
      automationChecked: automationToggle?.checked === true,
      timerPressed: timerToggle?.getAttribute('aria-pressed') === 'true',
      smartPressed: smartModeToggle?.getAttribute('aria-pressed') === 'true',
      activeHoursChecked: activeHoursToggle?.checked === true,
      activeHoursStart: activeHoursStart?.value,
      activeHoursEnd: activeHoursEnd?.value,
      activeHoursBodyHidden: activeHoursBody?.hidden === true,
      activeHoursStartDisabled: activeHoursStart?.disabled === true,
      activeHoursEndDisabled: activeHoursEnd?.disabled === true,
      timerBodyHidden: timerBody?.hidden === true,
      smartBodyHidden: smartBody?.hidden === true
    }
  };
}

const DIAGNOSTIC_LEVEL_SYMBOLS = Object.freeze({
  ok: '✅',
  info: 'ℹ️',
  warning: '⚠️',
  repaired: '🛠️',
  error: '❌'
});

function createDiagnosticReport(translate) {
  const detailLines = [];
  const findings = [];

  function add(ok, message, metadata = {}) {
    const requestedLevel = String(metadata.level || '');
    const level = Object.hasOwn(DIAGNOSTIC_LEVEL_SYMBOLS, requestedLevel)
      ? requestedLevel
      : (ok ? 'ok' : 'error');
    const isFinding = level === 'error' || level === 'warning' || level === 'repaired';
    const code = String(metadata.code || (isFinding ? 'DIAG-UNCLASSIFIED' : '')).slice(0, 80);
    const codeLabel = code && level !== 'ok' ? ` [${code}]` : '';
    detailLines.push(`${DIAGNOSTIC_LEVEL_SYMBOLS[level]}${codeLabel} ${message}`);

    if (isFinding && !findings.some(item => item.code === code)) {
      findings.push({
        code,
        level,
        domain: String(metadata.domain || translate('diagnoseDomainGeneral')),
        message: String(message),
        action: String(metadata.action || ''),
        priority: Number.isFinite(Number(metadata.priority)) ? Number(metadata.priority) : 100
      });
    }
  }

  function getSummaryLines() {
    const errorCount = findings.filter(item => item.level === 'error').length;
    const warningCount = findings.filter(item => item.level === 'warning').length;
    const repairedCount = findings.filter(item => item.level === 'repaired').length;
    const summaryLines = [translate('diagnoseSummary', errorCount, warningCount, repairedCount)];
    const activeIssues = findings
      .filter(item => item.level === 'error' || item.level === 'warning')
      .sort((left, right) => (
        (left.level === right.level ? 0 : (left.level === 'error' ? -1 : 1))
        || left.priority - right.priority
      ));
    const primary = activeIssues[0];
    if (primary) {
      summaryLines.push(translate(
        'diagnosePrimaryIssue',
        primary.code,
        primary.domain,
        primary.message
      ));
      if (primary.action) summaryLines.push(translate('diagnoseNextStep', primary.action));
    } else if (repairedCount > 0) {
      const repaired = findings
        .filter(item => item.level === 'repaired')
        .sort((left, right) => left.priority - right.priority)[0];
      summaryLines.push(translate(
        'diagnosePrimaryRepair',
        repaired.code,
        repaired.domain,
        repaired.message
      ));
    } else {
      summaryLines.push(translate('diagnoseSummaryHealthy'));
    }
    summaryLines.push(translate('diagnoseDetails'));
    return summaryLines;
  }

  function getCompletionLevel() {
    if (findings.some(item => item.level === 'error')) return 'error';
    if (findings.some(item => item.level === 'warning')) return 'warning';
    return 'success';
  }

  return { detailLines, findings, add, getSummaryLines, getCompletionLevel };
}

function projectPersistentSchedule(scheduleSnapshot) {
  return Object.fromEntries(
    Object.entries(scheduleSnapshot || {}).filter(([key]) => (
      key !== 'actualStatus'
      && key !== 'balanceMinutes'
      && !key.startsWith('_')
    ))
  );
}

btnDiagnose.addEventListener('click', async () => {
  diagnoseResult.style.display = 'block';
  document.getElementById('diagContent').textContent = t('diagnoseInProgress');
  if (btnCopyDiag) btnCopyDiag.hidden = true;
  lastDiagLines = [];
  showStatus(t('diagnoseInProgress'), '');
  btnDiagnose.disabled = true;
  
  const report = createDiagnosticReport(t);
  const lines = report.detailLines;
  const add = report.add;
  // fmt 提升到顶层:此前 4.5 段局部 const fmt (if 块作用域) + 5 段 const fmt2 typo (调用写 fmt) 双声明
  // 引致 SW success 分支 ReferenceError。手里 mock 没跑该分支,潜伏至 v0.6.7 实测。
  const fmt = (t) => t ? new Date(t).toLocaleTimeString() : '∅';

  // B3: 浏览器版本信息 — 方便跨浏览器排障
  const ua = navigator.userAgent;
  const isEdge = /Edg\//i.test(ua);
  const isChrome = /Chrome\//i.test(ua) && !isEdge;
  const browserName = isEdge ? 'Edge' : isChrome ? 'Chrome' : 'Unknown';
  const browserVer = ua.match(isEdge ? /Edg\/([\d.]+)/ : /Chrome\/([\d.]+)/)?.[1] || '?';
  lines.push(t('diagnoseTime') + new Date().toLocaleString());
  lines.push(t('diagnoseBrowser') + browserName + ' ' + browserVer);
  
  try {
    let ensured = null;
    try {
      ensured = await sendDiagnosticRuntimeMessage({ type: 'ensureDiagnostics' });
      if (ensured?.success === false && ensured.error) {
        add(false, t('diagnoseEnsureFailed') + String(ensured.error).slice(0, 80), {
          code: 'SCHED-REPAIR-FAILED',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 10
        });
      }
    } catch (e) {
      add(false, t('diagnoseEnsureFailed') + (e.message || '').slice(0, 80), {
        code: 'SCHED-REPAIR-FAILED',
        domain: t('diagnoseDomainScheduler'),
        action: t('diagnoseActionReloadExtension'),
        priority: 10
      });
    }

    let bg = null;
    let bgProbeFailed = false;
    try {
      bg = await sendDiagnosticRuntimeMessage({ type: 'getSchedule' });
      if (bg?.success === false) {
        bgProbeFailed = true;
        add(false, t('diagnoseScheduleReadFailed') + String(bg.error || '?').slice(0, 80), {
          code: 'SW-SNAPSHOT-FAILED',
          domain: t('diagnoseDomainBackground'),
          action: t('diagnoseActionReloadExtension'),
          priority: 5
        });
      }
    } catch (e) {
      bgProbeFailed = true;
      add(false, t('diagnoseScheduleReadFailed') + (e.message || '').slice(0, 80), {
        code: 'SW-SNAPSHOT-FAILED',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 5
      });
    }

    // 1. 检查 storage / 后台权威快照
    let stored = {};
    let storageReadOk = false;
    try {
      stored = await chrome.storage.local.get('ac_schedule');
      storageReadOk = true;
      add(true, t('diagnoseStorageRW'));
    } catch (e) {
      add(false, t('diagnoseStorageReadFailed') + (e.message || '').slice(0, 80), {
        code: 'CFG-STORAGE-READ-FAILED',
        domain: t('diagnoseDomainConfig'),
        action: t('diagnoseActionReloadExtension'),
        priority: 0
      });
    }
    const storedScheduleExists = storageReadOk
      && stored?.ac_schedule
      && typeof stored.ac_schedule === 'object';
    const storedSchedule = storedScheduleExists ? stored.ac_schedule : {};
    if (storageReadOk && !storedScheduleExists) {
      add(false, t('diagnoseScheduleMissing'), {
        level: 'warning',
        code: 'CFG-SCHEDULE-MISSING',
        domain: t('diagnoseDomainConfig'),
        action: t('diagnoseActionReloadExtension'),
        priority: 20
      });
    }
    const bgSchedule = bg?.success === false && bg?.schedule
      ? bg.schedule
      : (bg || {});
    let s = { ...storedSchedule, ...(ensured?.schedule || {}), ...bgSchedule };
    const automationPausedByActiveHours = s._automationPausedByActiveHours === true
      || isAutomationPausedByActiveHours(s);
    const automationEnabled = s.enabled === true;
    const pwmStepInFlight = ensured?.pwmStepRunning === true
      || s._pwmStepRunning === true;
    const repairedItems = new Set(Array.isArray(ensured?.repairs) ? ensured.repairs : []);
    const clearedAlarmCount = [...repairedItems]
      .filter(item => item.endsWith('-alarm-cleared')).length;
    const leakedRuntimeAlarmCount = [
      ensured?.alarms?.pwm,
      ensured?.alarms?.badge,
      ensured?.alarms?.watchdog,
      ...(!automationEnabled ? [ensured?.alarms?.smartWeather] : [])
    ].filter(Boolean).length;
    let effectiveNextTriggerAt = s.nextTriggerAt || 0;

    // 1.5 自愈:storage.nextTriggerAt 缺失或已过期,但 live ac-pwm 在未来(间隔模式 + enabled),
    // 直接在 popup 侧补写 storage。不依赖 background 是否跑最新代码——这是 popup 主动
    // 修复路径,确保诊断面板能从根上消除"ac-pwm 在但 storage 缺/过期"的红灯。
    // 触发条件扩展:不只 nextTriggerAt=0,nextTriggerAt < now(已过期)也触发。
    // 这覆盖"SW 跑旧代码,storage 没跟上闹钟推进"的场景。
    const nowMs = Date.now();
    const storedIsStale = !effectiveNextTriggerAt || effectiveNextTriggerAt < nowMs;
    let pwmAlarmEarly = await chrome.alarms.get('ac-pwm');
    let selfHealed = false;
    if (s.enabled === true
      && !automationPausedByActiveHours
        && s.clockMode === false
        && storedIsStale
        && pwmAlarmEarly?.scheduledTime
        && pwmAlarmEarly.scheduledTime > nowMs) {
      try {
        const repairedSchedule = projectPersistentSchedule({
          ...storedSchedule,
          ...s,
          nextTriggerAt: pwmAlarmEarly.scheduledTime,
          alarmCreatedAt: Date.now(),
          alarmDelayMinutes: Math.max(1, (pwmAlarmEarly.scheduledTime - Date.now()) / 60000)
        });
        await chrome.storage.local.set({ ac_schedule: repairedSchedule });
        // 等待 storage 写入完成
        await new Promise(r => setTimeout(r, 200));
        // 自愈成功后,直接使用 repairedSchedule 作为 s。
        // 不能再合并旧的 ensured/bgSchedule——它们携带诊断开始时的快照(nextTriggerAt=0),
        // 在合并时会把刚修复的值覆盖回 0(合并顺序 bug,Node 测试 verify-fix.mjs 发现)。
        s = { ...s, ...repairedSchedule };
        effectiveNextTriggerAt = s.nextTriggerAt || 0;
        selfHealed = true;
      } catch (e) {
        add(false, t('diagnoseSelfHealFail') + (e.message||'').slice(0,60), {
          code: 'SCHED-TRIGGER-REPAIR-FAILED',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 10
        });
      }
    }

    // Popup 自身也属于诊断链路：报告当前文档、布局、控件投影和保活连接。
    // 只记录结构化状态与尺寸，不读取 URL、DOM 文本、账号或冷气页面内容。
    const popupPage = readPopupPageSnapshot();
    const popupState = evaluatePopupPageState(popupPage, s);
    const popupDocumentMessage = popupState.documentReady && popupState.documentVisible
      ? t('diagnosePopupDocumentReady', popupPage.readyState, popupPage.visibilityState, popupPage.language)
      : t('diagnosePopupDocumentState', popupPage.readyState, popupPage.visibilityState, popupPage.language);
    add(popupState.documentReady && popupState.documentVisible, popupDocumentMessage,
      popupState.documentReady && popupState.documentVisible ? {} : {
        level: 'warning',
        code: popupState.documentReady ? 'POPUP-DOCUMENT-HIDDEN' : 'POPUP-DOCUMENT-NOT-READY',
        domain: t('diagnoseDomainPopup'),
        action: t('diagnoseActionReopenPopup'),
        priority: 60
      });

    const popupSizeArgs = [
      popupPage.viewportWidth,
      popupPage.viewportHeight,
      popupPage.contentWidth,
      popupPage.contentHeight
    ];
    if (!popupState.dimensionsValid) {
      add(false, t('diagnosePopupLayoutUnmeasurable', ...popupSizeArgs), {
        level: 'warning',
        code: 'POPUP-LAYOUT-UNMEASURABLE',
        domain: t('diagnoseDomainPopup'),
        action: t('diagnoseActionReopenPopup'),
        priority: 65
      });
    } else if (popupState.horizontalOverflow) {
      add(false, t('diagnosePopupLayoutOverflow', ...popupSizeArgs), {
        level: 'warning',
        code: 'POPUP-HORIZONTAL-OVERFLOW',
        domain: t('diagnoseDomainPopup'),
        action: t('diagnoseActionReopenPopup'),
        priority: 65
      });
    } else {
      add(true, t('diagnosePopupLayoutOK', ...popupSizeArgs));
    }

    if (popupState.controlSync === null) {
      add(true, t('diagnosePopupControlsPending'), {
        level: 'info',
        code: 'POPUP-UPDATE-IN-FLIGHT',
        domain: t('diagnoseDomainPopup')
      });
    } else if (popupState.controlSync) {
      add(true, t(
        'diagnosePopupControlsSync',
        popupState.expected.automation,
        popupState.expected.activeHours,
        popupState.expected.timer,
        popupState.expected.smart
      ));
    } else {
      add(false, t(
        'diagnosePopupControlsDesync',
        popupState.controlMismatches.join(' | ')
      ), {
        level: 'warning',
        code: 'POPUP-CONTROLS-DESYNC',
        domain: t('diagnoseDomainPopup'),
        action: t('diagnoseActionReopenPopup'),
        priority: 55
      });
    }

    add(popupPage.keepaliveConnected, popupPage.keepaliveConnected
      ? t('diagnosePopupKeepaliveOK')
      : t('diagnosePopupKeepaliveDisconnected'), popupPage.keepaliveConnected ? {} : {
      level: 'warning',
      code: 'POPUP-KEEPALIVE-DISCONNECTED',
      domain: t('diagnoseDomainPopup'),
      action: t('diagnoseActionReopenPopup'),
      priority: 50
    });

    const capturedPopupErrors = globalThis.ACPopupDiagnosticFallback?.getCapturedErrors?.() || [];
    if (capturedPopupErrors.length) {
      const latestPopupError = capturedPopupErrors[capturedPopupErrors.length - 1];
      add(false, t('diagnosePopupRuntimeErrors', capturedPopupErrors.length, latestPopupError.message), {
        level: 'warning',
        code: 'POPUP-RUNTIME-ERROR',
        domain: t('diagnoseDomainPopup'),
        action: t('diagnoseActionReopenPopup'),
        priority: 45
      });
    } else {
      add(true, t('diagnosePopupRuntimeErrorsEmpty'));
    }

    add(true, t('diagnoseEnabledPrefix') + s.enabled + ' (' + (s.enabled ? t('diagnoseOn') : t('diagnoseOff')) + ')',
      automationEnabled ? {} : {
        level: 'info',
        code: 'CFG-AUTOMATION-OFF',
        domain: t('diagnoseDomainConfig')
      });
    add(!!s.mode, t('diagnoseMode') + (s.mode || '?'), {
      code: 'CFG-MODE-MISSING',
      domain: t('diagnoseDomainConfig'),
      action: t('diagnoseActionReloadExtension'),
      priority: 15
    });
    add(s.clockMode !== undefined, t('diagnoseClockMode') + (s.clockMode === undefined
      ? '?'
      : (s.clockMode ? t('diagnoseClock') : t('diagnoseInterval'))), {
      code: 'CFG-CLOCK-MISSING',
      domain: t('diagnoseDomainConfig'),
      action: t('diagnoseActionReloadExtension'),
      priority: 15
    });
    if (s.clockMode === false && s.enabled
      && !automationPausedByActiveHours
      && !pwmStepInFlight
      && !effectiveNextTriggerAt) {
      add(false, t('diagnoseMissingTrigger'), {
        code: 'SCHED-TRIGGER-MISSING',
        domain: t('diagnoseDomainScheduler'),
        action: t('diagnoseActionReloadExtension'),
        priority: 10
      });
    } else if (effectiveNextTriggerAt) {
      const repairedLabel = selfHealed
        ? t('diagnosePopHealed')
        : (storedSchedule.nextTriggerAt === effectiveNextTriggerAt ? '' : t('diagnoseBgWriteback'));
      const triggerWasRepaired = selfHealed || repairedItems.has('pwm-trigger');
      add(true, t('diagnoseTriggerTime') + new Date(effectiveNextTriggerAt).toLocaleTimeString() + repairedLabel,
        triggerWasRepaired ? {
          level: 'repaired',
          code: 'SCHED-TRIGGER-REPAIRED',
          domain: t('diagnoseDomainScheduler'),
          priority: 20
        } : {});
    }

    // 2. 检查闹钟 — 运行闹钟只允许后台自愈，确保创建前后都复核运行时段门禁。
    let alarms = await chrome.alarms.getAll();
    const pwmAlarm = ensured?.alarms?.pwm || alarms.find(a => a.name === 'ac-pwm');
    if (!automationEnabled) {
      if (leakedRuntimeAlarmCount) {
        add(false, t('diagnoseRuntimeAlarmsLeaked', leakedRuntimeAlarmCount), {
          code: 'SCHED-RUNTIME-ALARMS-LEAKED',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 0
        });
      } else {
        add(true, clearedAlarmCount
          ? t('diagnoseRuntimeAlarmsCleared', clearedAlarmCount)
          : t('diagnoseRuntimeAlarmsInactive'), {
          level: clearedAlarmCount ? 'repaired' : 'info',
          code: clearedAlarmCount ? 'SCHED-RUNTIME-ALARMS-CLEARED' : 'SCHED-RUNTIME-INACTIVE',
          domain: t('diagnoseDomainScheduler')
        });
      }
    } else if (automationPausedByActiveHours) {
      if (leakedRuntimeAlarmCount) {
        add(false, t('diagnoseRuntimeAlarmsLeaked', leakedRuntimeAlarmCount), {
          code: 'SCHED-RUNTIME-ALARMS-LEAKED',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 0
        });
      } else {
        add(true, clearedAlarmCount
          ? t('diagnoseRuntimeAlarmsCleared', clearedAlarmCount)
          : t('diagnoseAutomationPaused'), {
          level: clearedAlarmCount ? 'repaired' : 'info',
          code: clearedAlarmCount ? 'SCHED-RUNTIME-ALARMS-CLEARED' : 'SCHED-ACTIVE-HOURS-PAUSED',
          domain: t('diagnoseDomainScheduler')
        });
      }
    } else {
      const pwmWasRepaired = repairedItems.has('pwm-alarm');
      if (pwmAlarm) {
        add(true, t('diagnosePwmExists') + t('diagnosePwmTrigger')
          + new Date(pwmAlarm.scheduledTime).toLocaleTimeString() + ')', pwmWasRepaired ? {
          level: 'repaired',
          code: 'SCHED-PWM-REPAIRED',
          domain: t('diagnoseDomainScheduler'),
          priority: 10
        } : {});
      } else if (pwmStepInFlight) {
        add(true, t('diagnosePwmInFlight'), {
          level: 'info',
          code: 'SCHED-PWM-IN-FLIGHT',
          domain: t('diagnoseDomainScheduler')
        });
      } else {
        add(false, t('diagnosePwmMissing'), {
          code: 'SCHED-PWM-MISSING',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 5
        });
      }
      if (pwmAlarm && s.clockMode === false && !effectiveNextTriggerAt) {
        add(false, t('diagnosePwmDesync'), {
          code: 'SCHED-PWM-DESYNC',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 5
        });
      } else if (pwmAlarm && effectiveNextTriggerAt) {
        const pwmAligned = areDiagnosticTriggersAligned(pwmAlarm.scheduledTime, effectiveNextTriggerAt);
        add(pwmAligned, t(pwmAligned ? 'diagnosePwmSync' : 'diagnosePwmDesync') + (selfHealed ? t('diagnosePopHealed') : ''), {
          code: 'SCHED-PWM-DESYNC',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 5
        });
      }

      const badgeAlarm = ensured?.alarms?.badge
        || alarms.find(a => a.name === 'ac-badge-tick');
      const badgeWasRepaired = repairedItems.has('badge-alarm');
      add(!!badgeAlarm, t('diagnoseBadgeAlarm') + (badgeAlarm
        ? t(badgeWasRepaired ? 'diagnoseAlarmRebuilt' : 'diagnoseAlarmScheduled')
          + new Date(badgeAlarm.scheduledTime).toLocaleTimeString() + ')'
        : t('diagnoseAlarmMissing')), badgeAlarm ? (badgeWasRepaired ? {
          level: 'repaired',
          code: 'SCHED-BADGE-REPAIRED',
          domain: t('diagnoseDomainScheduler'),
          priority: 30
        } : {}) : {
          level: 'warning',
          code: 'SCHED-BADGE-MISSING',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 40
        });

      const watchdogAlarm = ensured?.alarms?.watchdog
        || alarms.find(a => a.name === 'ac-watchdog');
      const watchdogWasRepaired = repairedItems.has('watchdog-alarm');
      add(!!watchdogAlarm, t('diagnoseWatchdog') + (watchdogAlarm
        ? t(watchdogWasRepaired ? 'diagnoseAlarmRebuilt' : 'diagnoseAlarmScheduled')
          + new Date(watchdogAlarm.scheduledTime).toLocaleTimeString() + ')'
        : t('diagnoseAlarmMissing')), watchdogAlarm ? (watchdogWasRepaired ? {
          level: 'repaired',
          code: 'SCHED-WATCHDOG-REPAIRED',
          domain: t('diagnoseDomainScheduler'),
          priority: 30
        } : {}) : {
          level: 'warning',
          code: 'SCHED-WATCHDOG-MISSING',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 40
        });
    }

    // 2.0c 智能模式天气预取链路：ac-smart-weather one-shot 闹钟 + ac_smart_weather 缓存新鲜度。
    // v0.8.0 智能模式新增，此前诊断漏检——闹钟丢失后天气冻结、等效温度/建议分钟数不再更新却无红灯。
    // 后台 ensureDiagnostics 已在上方补建；此处仅展示状态与缓存新鲜度，不重复补建。
    const smartOnDiag = !!s.smartMode?.enabled;
    if (!automationEnabled && smartOnDiag) {
      add(true, t('diagnoseSmartModeDormant'), {
        level: 'info',
        code: 'WEATHER-SMART-MODE-DORMANT',
        domain: t('diagnoseDomainWeather')
      });
    } else if (!smartOnDiag) {
      add(true, t('diagnoseSmartModeOff'), {
        level: 'info',
        code: 'WEATHER-SMART-MODE-OFF',
        domain: t('diagnoseDomainWeather')
      });
    } else {
      add(true, t('diagnoseSmartModeOn'));
      const smartWeatherAlarm = ensured?.alarms?.smartWeather || alarms.find(a => a.name === 'ac-smart-weather');
      const smartWeatherWasRepaired = repairedItems.has('smart-weather-alarm');
      const smartWeatherAt = Number(smartWeatherAlarm?.scheduledTime) || 0;
      const smartWeatherDate = smartWeatherAt ? new Date(smartWeatherAt) : null;
      const smartWeatherSlotValid = !!smartWeatherDate
        && smartWeatherDate.getSeconds() === 0
        && smartWeatherDate.getMilliseconds() === 0
        && (smartWeatherDate.getMinutes() === 20 || smartWeatherDate.getMinutes() === 50);
      if (!smartWeatherAlarm) {
        add(false, t('diagnoseSmartWeatherAlarm') + ' ' + t('diagnoseSmartWeatherAlarmMissing'), {
          code: 'WEATHER-ALARM-MISSING',
          domain: t('diagnoseDomainWeather'),
          action: t('diagnoseActionReloadExtension'),
          priority: 20
        });
      } else if (!smartWeatherSlotValid) {
        add(false, t('diagnoseSmartWeatherSlotMismatch', smartWeatherDate.toLocaleTimeString()), {
          level: 'warning',
          code: 'WEATHER-SLOT-MISMATCH',
          domain: t('diagnoseDomainWeather'),
          action: t('diagnoseActionReloadExtension'),
          priority: 30
        });
      } else {
        add(true, t('diagnoseSmartWeatherAlarm')
          + t(smartWeatherWasRepaired ? 'diagnoseAlarmRebuilt' : 'diagnoseAlarmScheduled')
          + smartWeatherDate.toLocaleTimeString() + ')', smartWeatherWasRepaired ? {
          level: 'repaired',
          code: 'WEATHER-ALARM-REPAIRED',
          domain: t('diagnoseDomainWeather'),
          priority: 30
        } : {});
      }

      const weatherRes = await chrome.storage.local.get('ac_smart_weather');
      const weatherCache = weatherRes.ac_smart_weather;
      const fetchedAt = Number(weatherCache?.fetchedAt) || 0;
      const ageMs = getTimestampAgeMs(fetchedAt);
      if (ageMs !== null) {
        const ageMin = Math.round(ageMs / 60000);
        if (ageMs <= 60 * 60000) {
          add(true, t('diagnoseSmartWeatherFresh', ageMin));
        } else {
          add(false, t('diagnoseSmartWeatherStale', ageMin), {
            level: 'warning',
            code: 'WEATHER-CACHE-STALE',
            domain: t('diagnoseDomainWeather'),
            action: t('diagnoseActionWaitWeather'),
            priority: 50
          });
        }
      } else {
        add(false, t('diagnoseSmartWeatherNoCache'), {
          level: 'warning',
          code: 'WEATHER-CACHE-MISSING',
          domain: t('diagnoseDomainWeather'),
          action: t('diagnoseActionWaitWeather'),
          priority: 50
        });
      }
    }

    // 2.1 全局运行时段(同日 white-list)与 ac-active-boundary 闹钟(指北固定 5 闹钟之一)。
    // activeHours.enabled=false 表示全天运行,无边界闹钟是预期,显示透明绿。
    if (s.activeHours?.enabled === true) {
      add(true, t('diagnoseActiveHoursOn', s.activeHours.start || '?', s.activeHours.end || '?'));
      if (automationEnabled) {
        const boundaryAlarm = alarms.find(a => a.name === 'ac-active-boundary') || await chrome.alarms.get('ac-active-boundary');
        add(!!boundaryAlarm, boundaryAlarm
          ? t('diagnoseActiveBoundary') + t('diagnoseAlarmScheduled') + new Date(boundaryAlarm.scheduledTime).toLocaleTimeString() + ')'
          : t('diagnoseActiveBoundaryMissing'), {
          code: 'SCHED-ACTIVE-BOUNDARY-MISSING',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 15
        });
      }
    } else {
      add(true, t('diagnoseActiveHoursOff'), {
        level: 'info',
        code: 'CFG-ACTIVE-HOURS-OFF',
        domain: t('diagnoseDomainConfig')
      });
    }

    // 2.2 heartbeat: storage __heartbeat 每 20s 写一次(background.js runHeartbeat)。
    // 用真实新鲜度取代之前的硬绿。阈值 60s = 给 30s 周期 2x 宽容;
    // -1 表示从未写入(SW 跑旧代码或刚装定未触发 first pulse),按 stale 红处理。
    {
      const hbRes = await chrome.storage.local.get('__heartbeat');
      const hbAt = hbRes?.__heartbeat || 0;
      const hbAgeMs = getTimestampAgeMs(hbAt);
      const hbAge = hbAgeMs === null ? -1 : Math.round(hbAgeMs / 1000);
      if (hbAgeMs !== null && hbAgeMs < 60 * 1000) {
        add(true, t('diagnoseHeartbeat', hbAge));
      } else {
        add(false, t('diagnoseHeartbeatStale', hbAge), {
          level: 'warning',
          code: 'SW-HEARTBEAT-STALE',
          domain: t('diagnoseDomainBackground'),
          action: t('diagnoseActionReloadExtension'),
          priority: 60
        });
      }
    }

    if (pwmAlarm && s.alarmCreatedAt && s.alarmDelayMinutes) {
      const dueAt = s.alarmCreatedAt + s.alarmDelayMinutes * 60000;
      const overdue = dueAt <= Date.now();
      add(!overdue, t(overdue ? 'diagnoseAlarmExpired' : 'diagnoseAlarmNotExpired') + new Date(dueAt).toLocaleTimeString() + ')', {
        code: 'SCHED-DEADLINE-EXPIRED',
        domain: t('diagnoseDomainScheduler'),
        action: t('diagnoseActionReloadExtension'),
        priority: 10
      });
    }

    // 3. 检查 AC 页面
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    const exactHomeTabs = tabs.filter(tab => tab.url === 'https://w5.ab.ust.hk/njggt/app/home');
    const exactHomeTab = exactHomeTabs.find(tab => !tab.discarded) || null;
    add(exactHomeTabs.length > 0, t('diagnoseTabOpen') + exactHomeTabs.length + t('diagnoseTabCount'),
      exactHomeTabs.length > 0 ? {} : {
        level: automationEnabled ? 'warning' : 'info',
        code: 'PAGE-HOME-MISSING',
        domain: t('diagnoseDomainPage'),
        action: t('diagnoseActionOpenACPage'),
        priority: 40
      });
    if (exactHomeTabs.length > 0 && !exactHomeTab) {
      add(false, t('diagnoseTabDiscarded'), {
        level: automationEnabled ? 'warning' : 'info',
        code: 'PAGE-HOME-DISCARDED',
        domain: t('diagnoseDomainPage'),
        action: t('diagnoseActionOpenACPage'),
        priority: 40
      });
    }
    if (exactHomeTab) {
      add(true, t('diagnoseTabNotDiscarded'));
      try {
        const status = bgSchedule.actualStatus;
        const statusAccepted = !!status && status.success !== false && status.invalidTarget !== true;
        add(statusAccepted, statusAccepted
          ? t('diagnoseContentOK')
          : t('diagnoseContentNoResponse') + String(status?.error || '?').slice(0, 60), {
          code: 'PAGE-CONTENT-UNREACHABLE',
          domain: t('diagnoseDomainPage'),
          action: t('diagnoseActionReloadACPage'),
          priority: 10
        });
        if (statusAccepted) {
          add(typeof status.isOn === 'boolean', t('diagnoseAcReadable') + (typeof status.isOn === 'boolean'
            ? (status.isOn ? 'ON' : 'OFF')
            : '?'), {
            code: 'PAGE-AC-UNREADABLE',
            domain: t('diagnoseDomainPage'),
            action: t('diagnoseActionReloadACPage'),
            priority: 15
          });
        }
        if (statusAccepted && status?.disabled) {
          add(false, t('diagnoseAcDisabled'), {
            level: automationEnabled ? 'error' : 'warning',
            code: 'PAGE-AC-DISABLED',
            domain: t('diagnoseDomainPage'),
            action: t('diagnoseActionOpenACPage'),
            priority: 10
          });
        }
      } catch (e) {
        add(false, t('diagnoseContentNoResponse') + (e.message||'').slice(0,60), {
          code: 'PAGE-CONTENT-UNREACHABLE',
          domain: t('diagnoseDomainPage'),
          action: t('diagnoseActionReloadACPage'),
          priority: 10
        });
      }
    }

    // 4. 后台状态
    try {
      const bgAccepted = !!bg && bg.success !== false;
      if (!bgProbeFailed) {
        add(bgAccepted, t(bgAccepted ? 'diagnoseSWOK' : 'diagnoseSWNoResponse'), {
          code: 'SW-SNAPSHOT-FAILED',
          domain: t('diagnoseDomainBackground'),
          action: t('diagnoseActionReloadExtension'),
          priority: 5
        });
      }
      if (bgAccepted) {
        add(bg.clockMode !== undefined, t('diagnoseClockSync') + (bg.clockMode === undefined
          ? '?'
          : (bg.clockMode ? t('diagnoseClock') : t('diagnoseInterval'))), {
          code: 'SW-CLOCK-SNAPSHOT-MISSING',
          domain: t('diagnoseDomainBackground'),
          action: t('diagnoseActionReloadExtension'),
          priority: 15
        });
      }
      // PWM 失败提示:runPwmStep 验证失败时会写 pageTimerError。
      // 主动展示在诊断面板,方便定位"到时间没关/没开"的根因。
      if (s.pageTimerError) {
        add(false, t('diagnosePwmError') + String(s.pageTimerError).slice(0, 120), {
          code: 'SAFETY-TIMER-FAILED',
          domain: t('diagnoseDomainSafety'),
          action: t('diagnoseActionCheckTimer'),
          priority: 0
        });
      } else {
        add(true, t('diagnosePwmErrorEmpty'));
      }
    } catch (e) {
      add(false, t('diagnoseSWNoResponse'), {
        code: 'SW-SNAPSHOT-FAILED',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 5
      });
    }

    // 4.5. v0.5.10 page timer 跨设备主同步通道诊断
    // page timer 两相位都对齐：pwmState='off'(AC 正开) 直接采纳；pwmState='on'(AC 正关) 掉算下一“开”。
    if (exactHomeTab && s.enabled) {
      try {
        const pt = await sendDiagnosticRuntimeMessage({ type: 'getPageTimer' });
        if (pt && pt.success !== false && pt.invalidTarget !== true && pt.found && pt.value) {
          const localNext = effectiveNextTriggerAt || s.nextTriggerAt || 0;
          add(true, t('diagnosePageTimerExpr', pt.value, fmt(localNext), s.pwmState));
        } else if (pt?.success === false || pt?.invalidTarget === true) {
          add(false, t('diagnosePageTimerFail') + String(pt.error || '').slice(0,60), {
            code: 'SAFETY-TIMER-READ-FAILED',
            domain: t('diagnoseDomainSafety'),
            action: t('diagnoseActionCheckTimer'),
            priority: 10
          });
        } else {
          const pageTimerRequired = isDiagnosticPageTimerRequired(
            s,
            bgSchedule.actualStatus?.isOn,
            automationPausedByActiveHours
          );
          add(!pageTimerRequired, t(pageTimerRequired ? 'diagnosePageTimerMissing' : 'diagnosePageTimerEmpty'),
            pageTimerRequired ? {
              code: 'SAFETY-TIMER-MISSING',
              domain: t('diagnoseDomainSafety'),
              action: t('diagnoseActionCheckTimer'),
              priority: 0
            } : {
              level: 'info',
              code: 'SAFETY-TIMER-EMPTY',
              domain: t('diagnoseDomainSafety')
            });
        }
      } catch (e) {
        add(false, t('diagnosePageTimerFail') + (e.message||'').slice(0,60), {
          code: 'SAFETY-TIMER-READ-FAILED',
          domain: t('diagnoseDomainSafety'),
          action: t('diagnoseActionCheckTimer'),
          priority: 10
        });
      }
    } else if (s.enabled) {
      add(true, t('diagnosePageTimerPending'), {
        level: 'info',
        code: 'SAFETY-TIMER-NOT-CHECKED',
        domain: t('diagnoseDomainSafety')
      });
    }

    // 4.6 页面定时器重试有两条互斥路径：正常 PWM 失败保持当前相位并由 live ac-pwm
    // 在 1 分钟后重跑；停用／运行时段退出等非 PWM 安全关机才使用独立
    // ac-page-timer-retry。两者不能因 pageTimerRetryMinutes=0 被混报为“无重试”。
    const retryMin = Number(s.pageTimerRetryMinutes) || 0;
    const pwmRetryAt = Number(pwmAlarm?.scheduledTime) || 0;
    const pwmRetryActive = isPwmPageTimerRetryActive(s.pageTimerError, pwmRetryAt);
    if (retryMin > 0) {
      const retryAlarm = alarms.find(a => a.name === 'ac-page-timer-retry') || await chrome.alarms.get('ac-page-timer-retry');
      const retryAt = retryAlarm?.scheduledTime || 0;
      const retryStr = retryAt ? new Date(retryAt).toLocaleTimeString() : '?';
      add(!!retryAlarm, retryAlarm
        ? t('diagnosePageTimerRetry', retryStr, retryMin)
        : t('diagnosePageTimerRetryAlarmMissing', retryMin), retryAlarm ? {
        level: 'warning',
        code: 'SAFETY-TIMER-RETRYING',
        domain: t('diagnoseDomainSafety'),
        action: t('diagnoseActionCheckTimer'),
        priority: 20
      } : {
        code: 'SAFETY-RETRY-ALARM-MISSING',
        domain: t('diagnoseDomainSafety'),
        action: t('diagnoseActionCheckTimer'),
        priority: 5
      });
    } else if (pwmRetryActive) {
      add(true, t('diagnosePageTimerPwmRetry', new Date(pwmRetryAt).toLocaleTimeString()), {
        level: 'info',
        code: 'SAFETY-PWM-RETRYING',
        domain: t('diagnoseDomainSafety')
      });
    } else {
      add(true, t('diagnosePageTimerRetryNone'), {
        level: 'info',
        code: 'SAFETY-NO-RETRY',
        domain: t('diagnoseDomainSafety')
      });
    }

    // 5. SW 状态可观测性:启动时间 / init 完成时间 / 内存 schedule 与 storage 是否一致
    // 注意:getSwStatus 失败、未响应、或 SW 跑旧代码时 sw 可能为 undefined/success:false,
    // 必须在所有分支都显示信息,避免静默盲区。
    // 评判原则:getSwStatus 只是辅助诊断,不是核心功能。如果 popup 已自愈 storage 接管,
    // 即使 SW 没响应,功能上也是 OK 的,显示绿灯而非红灯。
    let sw = null;
    try {
      sw = await sendDiagnosticRuntimeMessage({ type: 'getSwStatus' });
    } catch (e) {
      // sendResponse 异常,记录但不直接红灯
      console.warn('getSwStatus sendMessage 异常:', e?.message);
    }
    if (sw && sw.success === true) {
      // SW 响应成功:显示三方一致校验
      const swAgeSec = Math.round((sw.swAgeMs || 0) / 1000);
      const initAgeSec = sw.initAgeMs >= 0 ? Math.round(sw.initAgeMs / 1000) : -1;
      add(sw.initCompleted, t(sw.initCompleted ? 'diagnoseSWInitDone' : 'diagnoseSWInitPending', swAgeSec, initAgeSec), {
        code: 'SW-INIT-INCOMPLETE',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 5
      });
      // L2 offscreen 长连接保活页(阶段58):每分钟 badge-tick 顺带 ensureOffscreen 重建。
      // 三态兼容:v0.6.7+ SW 返回 offscreenAlive 真值(true/false);旧 SW 不返回该字段(undefined),
      // 视为 SW 跑旧代码,不打红灯避免误导用户以为 offscreen 失效。
      if (sw.offscreenAlive === true) {
        add(true, t('diagnoseOffscreenPresent'));
      } else if (sw.offscreenAlive === false) {
        add(false, t('diagnoseOffscreenMissing'), {
          level: 'warning',
          code: 'SW-OFFSCREEN-MISSING',
          domain: t('diagnoseDomainBackground'),
          action: t('diagnoseActionReloadExtension'),
          priority: 70
        });
      } else {
        add(true, t('diagnoseOffscreenUnknown'), {
          level: 'info',
          code: 'SW-OFFSCREEN-UNKNOWN',
          domain: t('diagnoseDomainBackground')
        });
      }
      const memNext = sw.memorySchedule?.nextTriggerAt || 0;
      const storedNext = storedSchedule.nextTriggerAt || 0;
      const memLive = sw.liveAlarmScheduledTime || 0;
      if (!automationEnabled || automationPausedByActiveHours) {
        // 停用／暂停态预期没有 PWM 时钟，不把三方全空误报为失步。
      } else if (pwmStepInFlight && !memLive) {
        // 前面的 alarm 检查已经显示一次“边界处理中”；此处只跳过瞬态三方校验。
      } else if (areDiagnosticTriggersAligned(memLive, memNext, storedNext)) {
        add(true, t('diagnoseTriMatch', fmt(memLive)));
      } else {
        add(false, t('diagnoseTriMismatch', fmt(memLive), fmt(memNext), fmt(storedNext)), {
          code: 'SCHED-THREE-WAY-DESYNC',
          domain: t('diagnoseDomainScheduler'),
          action: t('diagnoseActionReloadExtension'),
          priority: 5
        });
      }
    } else if (selfHealed) {
      // SW 没响应(可能跑旧代码),但 popup 已自愈 storage 接管 — 功能不受影响,显示绿灯
      add(false, t('diagnosePopHealedSw'), {
        level: 'warning',
        code: 'SW-STATUS-DEGRADED',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 50
      });
    } else if (sw && sw.success === false) {
      add(false, t('diagnoseGetSwFailed') + (sw.error||'?').slice(0,80), {
        code: 'SW-STATUS-FAILED',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 0
      });
    } else if (sw) {
      add(false, t('diagnoseGetSwAbnormal') + JSON.stringify(sw).slice(0,80), {
        code: 'SW-STATUS-FAILED',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 0
      });
    } else {
      // SW 完全无响应且 popup 未自愈 — 这是真问题
      add(false, t('diagnoseGetSwNone'), {
        code: 'SW-STATUS-FAILED',
        domain: t('diagnoseDomainBackground'),
        action: t('diagnoseActionReloadExtension'),
        priority: 0
      });
    }

    // 6. 构建时间戳:让用户/诊断能直接判断扩展实际加载的是哪次 build
    //    (同名版本号 0.4.28 可能对应多次代码改动,构建时间戳可区分)
    //    [v0.6.9] 治本:诊断末行优先读 manifest 真实版本号,APP_VERSION 仅在
    //    chrome.runtime 不可用时兜底 — 彻底消除阶段 60/61/62 反复出现的"硬编码
    //    APP_VERSION 过期 → 诊断末行误显示旧版本号"暴露面。即便作者手动同步
    //    popup.js 第 436 行 APP_VERSION 失手漏一次,诊断仍永远显示真实版本。
    let diagVersion;
    try { diagVersion = chrome.runtime.getManifest().version; } catch (_) { diagVersion = APP_VERSION; }
    add(true, t('diagnoseVersion', diagVersion, BUILD_TIME));

    // 7. i18n 系统状态诊断 — 显示 I18n 模块实际加载的语言和翻译测试结果
    const i18nLang = I18n.getLang();
    const testMsg = I18n.t('pwmSettings');
    if (testMsg && !testMsg.startsWith('pwmSettings')) {
      add(true, t('diagnoseI18nOK', i18nLang, testMsg.slice(0,20)));
    } else {
      add(false, t('diagnoseI18nNoTrans', i18nLang, testMsg), {
        level: 'warning',
        code: 'I18N-TRANSLATION-MISSING',
        domain: t('diagnoseDomainGeneral'),
        action: t('diagnoseActionReloadExtension'),
        priority: 90
      });
    }

    // 8. 最近后台异常：只读本机有界环形日志，并入现有复制诊断报告。
    // 日志会脱敏 URL 与邮箱，不记录原始 DOM、余额或账号信息，也不会进入 chrome.storage.sync。
    try {
      const diagnosticStorage = await chrome.storage.local.get('ac_diagnostic_log');
      appendRecentDiagnosticLogLines(lines, diagnosticStorage?.ac_diagnostic_log);
    } catch (e) {
      add(false, t('diagnoseRecentErrorsReadFailed') + (e.message || '').slice(0, 80), {
        level: 'warning',
        code: 'DIAG-HISTORY-READ-FAILED',
        domain: t('diagnoseDomainGeneral'),
        action: t('diagnoseActionCopyReport'),
        priority: 95
      });
    }
  } catch (e) {
    add(false, t('diagnoseException') + (e.message||'').slice(0,80), {
      code: 'DIAG-UNEXPECTED',
      domain: t('diagnoseDomainGeneral'),
      action: t('diagnoseActionCopyReport'),
      priority: 0
    });
  } finally {
    const reportLines = [...report.getSummaryLines(), '', ...lines];
    renderDiagnoseResult(reportLines);
    lastDiagLines = reportLines.slice();
    if (btnCopyDiag) btnCopyDiag.hidden = false;
    btnDiagnose.disabled = false;
    const completionLevel = report.getCompletionLevel();
    showStatus(
      t(completionLevel === 'error'
        ? 'diagnoseCompleteIssues'
        : (completionLevel === 'warning' ? 'diagnoseCompleteWarnings' : 'diagnoseComplete')),
      completionLevel === 'warning' ? '' : completionLevel
    );
  }
});

// 独立兜底脚本只在该标记缺失时接管诊断按钮。必须放在完整处理器注册之后。
globalThis.__AC_POPUP_DIAGNOSTICS_READY__ = true;
