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
  smartMode: { enabled: false, sensitivity: 50 },
  pwmState: 'off',
  actualStatus: { isOn: true },
  balanceMinutes: 60,
  nextTriggerAt: Date.now() + 30 * 60 * 1000
};

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
const smartSensitivity = document.getElementById('smartSensitivity');
const smartModeBody = document.getElementById('smartModeBody');
const smartSuggested = document.getElementById('smartSuggested');
const smartTeq = document.getElementById('smartTeq');
const smartUpdated = document.getElementById('smartUpdated');

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
let currentActiveHours = { enabled: false, start: '08:00', end: '23:00' };
let currentSmartMode = { enabled: false, sensitivity: 50 };
let lastAnnouncedState = '';

function clampSmartSensitivityLocal(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.round(Math.min(100, Math.max(0, n)));
}

async function loadSettings() {
  const schedule = IS_STATIC_PREVIEW
    ? staticPreviewSchedule
    : (await chrome.storage.local.get('ac_schedule')).ac_schedule || {};
  currentScheduleEnabled = !!schedule.enabled;
  onMinutesInput.value = schedule.onMinutes ?? 60;
  offMinutesInput.value = schedule.offMinutes ?? 60;
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
    sensitivity: clampSmartSensitivityLocal(sm.sensitivity ?? 50)
  };
  syncSmartModeUI();
}

function syncActiveHoursUI() {
  activeHoursToggle.checked = currentActiveHours.enabled;
  activeHoursStart.value = currentActiveHours.start;
  activeHoursEnd.value = currentActiveHours.end;
  activeHoursStart.disabled = !currentActiveHours.enabled;
  activeHoursEnd.disabled = !currentActiveHours.enabled;
}

function syncSmartModeUI() {
  smartModeToggle.checked = currentSmartMode.enabled;
  smartSensitivity.value = String(currentSmartMode.sensitivity);
  smartSensitivity.disabled = !currentSmartMode.enabled;
  smartModeBody.classList.toggle('is-disabled', !currentSmartMode.enabled);
  // 智能模式覆盖手动时长：开启时禁用 on/off 输入，关闭时恢复
  onMinutesInput.disabled = currentSmartMode.enabled;
  offMinutesInput.disabled = currentSmartMode.enabled;
}

function commitActiveHours() {
  // 读取 UI 值并提交到 background
  const startVal = activeHoursStart.value || '08:00';
  const endVal = activeHoursEnd.value || '23:00';
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

// ----- 智能模式：开关 + 灵敏度滑块 + 实时读数 -----
let _smartProgrammatic = false;

function renderSmartReadout(suggested, weather) {
  const hasData = !!(suggested && suggested.valid);
  // 建议开启分钟数
  if (hasData) {
    smartSuggested.textContent = `${suggested.onMinutes} ${t('unitMinutes')}`;
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

smartModeToggle.addEventListener('change', async () => {
  if (_smartProgrammatic) return;
  currentSmartMode.enabled = smartModeToggle.checked;
  syncSmartModeUI();
  // 主定时开启时重启周期以立即重算；关闭时仅持久化 smartMode（关机路径幂等）
  await updateSchedule(currentScheduleEnabled, currentScheduleEnabled);
  await updateSmartReadout();
});

smartSensitivity.addEventListener('input', () => {
  // 平滑预览：滑动过程中即时更新建议分钟数，不触发后台写入
  currentSmartMode.sensitivity = clampSmartSensitivityLocal(smartSensitivity.value);
  void updateSmartReadout();
});

smartSensitivity.addEventListener('change', async () => {
  // 释放滑块：仅持久化灵敏度，不重启当前 30 分钟周期（实际执行周期固定 30 分钟）
  currentSmartMode.sensitivity = clampSmartSensitivityLocal(smartSensitivity.value);
  syncSmartModeUI();
  await updateSchedule(currentScheduleEnabled, false);
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

async function refreshStatus() {
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
    const stored = await chrome.storage.local.get("ac_schedule");
    if (stored.ac_schedule) {
      const alarm = await chrome.alarms.get("ac-pwm");
      const fallbackSchedule = attachCachedActualStatus({ ...stored.ac_schedule });
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
  if (!schedule?.enabled || !Number.isFinite(balance) || balance < 0
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
  if (!schedule || !schedule.enabled) {
    currentScheduleEnabled = false;
    syncToggleState(false);
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
  syncToggleState(true);
  idleDisplay.style.display = 'none';
  countdownDisplay.style.display = 'flex';

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

function readPositiveMinutes(input, fallback) {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

// ----- 更新定时设置 -----
async function updateSchedule(enabled, restart = false) {
  const data = {
    enabled,
    mode: 'pwm',
    clockMode: false,  // v0.5.x 起固定间隔模式
    onMinutes: readPositiveMinutes(onMinutesInput, 30),
    offMinutes: readPositiveMinutes(offMinutesInput, 30),
    activeHours: { ...currentActiveHours },  // v0.5.x: PWM 运行时段
    smartMode: { ...currentSmartMode },      // v0.8.0: 智能模式（灵敏度 + 开关）
    restart
  };

  onMinutesInput.value = data.onMinutes;
  offMinutesInput.value = data.offMinutes;

  if (IS_STATIC_PREVIEW) {
    Object.assign(staticPreviewSchedule, data, {
      actualStatus: { isOn: enabled },
      pwmState: enabled ? 'off' : 'on',
      nextTriggerAt: enabled ? Date.now() + data.onMinutes * 60 * 1000 : 0
    });
    currentScheduleEnabled = enabled;
    updateCountdownDisplay(staticPreviewSchedule, {
      scheduledTime: staticPreviewSchedule.nextTriggerAt
    });
    showStatus(enabled ? t('statusOnOK') : t('statusClosedOK'), 'success');
    return;
  }

  // 提取（Fowler Extract Function）：后台 updateSchedule 响应的本地应用——状态文案与倒计时刷新。
  async function applyScheduleUpdateResponse(response) {
    if (!response?.success) {
      showStatus(t('statusError'), 'error');
      return;
    }

    currentScheduleEnabled = data.enabled;

    // 手动开关冷气（定时已关时会自动关机）
    if (!data.enabled) {
      // B1: background 的 updateSchedule handler 已经负责关机，
      // popup 不再发第二次 toggleNow（避免双击噪音）
      showStatus(t('statusClosedOK'), 'success');
    } else {
      showStatus(t('statusOnOK'), 'success');
    }

    const alarm = await chrome.alarms.get('ac-pwm');
    updateCountdownDisplay(attachCachedActualStatus(response.schedule), alarm);
  }

  const response = await chrome.runtime.sendMessage({
    type: 'updateSchedule',
    data: data
  });
  await applyScheduleUpdateResponse(response);
}

// ----- 定时拨动开关（双向同步 toggle） -----
let _toggleProgrammatic = false; // 防止程序同步时触发 onChange 循环

timerToggle.addEventListener('change', async () => {
  if (_toggleProgrammatic) return; // 程序同步，不触发 updateSchedule
  const enabled = timerToggle.checked;
  timerToggle.disabled = true; // 防止双击
  timerToggleState.textContent = enabled ? t('timerEnabling') : t('timerDisabling');
  timerToggle.setAttribute('aria-busy', 'true');
  try {
    await updateSchedule(enabled, true);
  } finally {
    timerToggle.disabled = false;
    timerToggle.removeAttribute('aria-busy');
  }
});

// 供外部（refreshStatus）同步 toggle 状态时不触发 onChange
function syncToggleState(enabled) {
  _toggleProgrammatic = true;
  timerToggle.checked = enabled;
  timerToggleState.textContent = enabled ? t('timerEnabled') : t('timerDisabled');
  _toggleProgrammatic = false;
}

// ----- 已启用时修改分钟数自动重启 -----
for (const input of [onMinutesInput, offMinutesInput]) {
  input.addEventListener('change', () => {
    if (currentScheduleEnabled) updateSchedule(true, true);
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
const APP_VERSION = '0.6.15';
// BUILD_TIME 由 build.sh 注入,用于诊断扩展实际加载的是哪次 build
// (同名版本号 0.4.28 可能对应多次代码改动,构建时间戳可区分)
const BUILD_TIME = 'dev';

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

function appendRecentDiagnosticLogLines(lines, entries) {
  const validEntries = Array.isArray(entries)
    ? entries.filter(entry => entry && typeof entry === 'object')
    : [];
  if (!validEntries.length) {
    lines.push('✅ ' + t('diagnoseRecentErrorsEmpty'));
    return;
  }

  const recentEntries = validEntries.slice(-10);
  lines.push(t('diagnoseRecentErrors', validEntries.length, recentEntries.length));
  recentEntries.forEach((entry) => {
    const timestamp = Number(entry.timestamp);
    const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '?';
    const level = entry.level === 'warn' ? 'WARN' : 'ERROR';
    const source = String(entry.source || 'unknown').slice(0, 80);
    const message = String(entry.message || '').slice(0, 300);
    lines.push(`⚠️ ${time} [${level}/${source}] ${message}`);
  });
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
  
  const lines = [];
  function add(ok, msg) { lines.push((ok ? '✅' : '❌') + ' ' + msg); }
  // fmt 提升到顶层:此前 4.5 段局部 const fmt (if 块作用域) + 5 段 const fmt2 typo (调用写 fmt) 双声明
  // 引致 SW success 分支 ReferenceError。手里 mock 没跑该分支,潜伏至 v0.6.7 实测。
  const fmt = (t) => t ? new Date(t).toLocaleTimeString() : '∅';

  // B3: 浏览器版本信息 — 方便跨浏览器排障
  const ua = navigator.userAgent;
  const isEdge = /Edg\//i.test(ua);
  const isChrome = /Chrome\//i.test(ua) && !isEdge;
  const browserName = isEdge ? 'Edge' : isChrome ? 'Chrome' : 'Unknown';
  const browserVer = ua.match(isEdge ? /Edg\/([\d.]+)/ : /Chrome\/([\d.]+)/)?.[1] || '?';
  lines.push(t('diagnoseBrowser') + browserName + ' ' + browserVer);
  
  try {
    const ensured = await sendDiagnosticRuntimeMessage({ type: 'ensureDiagnostics' });
    const bg = await sendDiagnosticRuntimeMessage({ type: 'getSchedule' });

    // 1. 检查 storage / 后台权威快照
    const stored = await chrome.storage.local.get('ac_schedule');
    const storedSchedule = stored.ac_schedule || {};
    const bgSchedule = bg?.success === false && bg?.schedule
      ? bg.schedule
      : (bg || {});
    let s = { ...storedSchedule, ...(ensured?.schedule || {}), ...bgSchedule };
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
        add(false, t('diagnoseSelfHealFail') + (e.message||'').slice(0,60));
      }
    }

    add(!!storedSchedule, t('diagnoseStorageRW'));
    add(s.enabled === true, t('diagnoseEnabledPrefix') + s.enabled + ' (' + (s.enabled ? t('diagnoseOn') : t('diagnoseOff')) + ')');
    add(!!s.mode, t('diagnoseMode') + (s.mode || '?'));
    add(s.clockMode !== undefined, t('diagnoseClockMode') + (s.clockMode ? t('diagnoseClock') : t('diagnoseInterval')));
    if (s.clockMode === false && s.enabled && !effectiveNextTriggerAt) {
      add(false, t('diagnoseMissingTrigger'));
    } else if (effectiveNextTriggerAt) {
      const repairedLabel = selfHealed
        ? t('diagnosePopHealed')
        : (storedSchedule.nextTriggerAt === effectiveNextTriggerAt ? '' : t('diagnoseBgWriteback'));
      add(true, t('diagnoseTriggerTime') + new Date(effectiveNextTriggerAt).toLocaleTimeString() + repairedLabel);
    }

    // 2. 检查闹钟 — 优先用后台自愈结果，若仍缺失则弹窗直接补建
    let alarms = await chrome.alarms.getAll();
    const pwmAlarm = ensured?.alarms?.pwm || alarms.find(a => a.name === 'ac-pwm');
    add(!!pwmAlarm, t('diagnosePwmExists') + (pwmAlarm ? t('diagnosePwmTrigger') + new Date(pwmAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));
    if (pwmAlarm && s.clockMode === false && !effectiveNextTriggerAt) {
      add(false, t('diagnosePwmSync'));
    } else if (pwmAlarm && effectiveNextTriggerAt) {
      add(areDiagnosticTriggersAligned(pwmAlarm.scheduledTime, effectiveNextTriggerAt), t('diagnosePwmSync') + (selfHealed ? t('diagnosePopHealed') : ''));
    }

    let badgeAlarm = ensured?.alarms?.badge || alarms.find(a => a.name === 'ac-badge-tick') || await chrome.alarms.get('ac-badge-tick');
    // 兜底：弹窗直接补建（不依赖后台往返）
    if (!badgeAlarm && s.enabled) {
      try { await chrome.alarms.clear('ac-badge-tick'); } catch (_) {}
      await chrome.alarms.create('ac-badge-tick', { delayInMinutes: 1 });
      await new Promise(r => setTimeout(r, 150)); // 等待 alarm 写入
      badgeAlarm = await chrome.alarms.get('ac-badge-tick');
    }
    add(!!badgeAlarm, t('diagnoseBadgeAlarm') + (badgeAlarm ? t('diagnoseBadgeRebuilt') + new Date(badgeAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));

    let watchdogAlarm = ensured?.alarms?.watchdog || alarms.find(a => a.name === 'ac-watchdog');
    if (!watchdogAlarm && s.enabled) {
      try { await chrome.alarms.clear('ac-watchdog'); } catch (_) {}
      await chrome.alarms.create('ac-watchdog', { periodInMinutes: 5 });
      await new Promise(r => setTimeout(r, 150));
      watchdogAlarm = await chrome.alarms.get('ac-watchdog');
    }
    add(!!watchdogAlarm, t('diagnoseWatchdog') + (watchdogAlarm ? t('diagnoseBadgeRebuilt') + new Date(watchdogAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));

    // 2.1 PWM 运行时段(同日 white-list)与 ac-active-boundary 闹钟(指北固定 5 闹钟之一)。
    // activeHours.enabled=false 表示全天运行,无边界闹钟是预期,显示透明绿。
    if (s.activeHours?.enabled === true) {
      add(true, t('diagnoseActiveHoursOn', s.activeHours.start || '?', s.activeHours.end || '?'));
      const boundaryAlarm = alarms.find(a => a.name === 'ac-active-boundary') || await chrome.alarms.get('ac-active-boundary');
      add(!!boundaryAlarm, t('diagnoseActiveBoundary') + (boundaryAlarm ? t('diagnoseBadgeRebuilt') + new Date(boundaryAlarm.scheduledTime).toLocaleTimeString() + ')' : ' ' + t('diagnoseActiveBoundaryMissing')));
    } else {
      add(true, t('diagnoseActiveHoursOff'));
    }

    // 2.2 heartbeat: storage __heartbeat 每 20s 写一次(background.js runHeartbeat)。
    // 用真实新鲜度取代之前的硬绿。阈值 60s = 给 30s 周期 2x 宽容;
    // -1 表示从未写入(SW 跑旧代码或刚装定未触发 first pulse),按 stale 红处理。
    {
      const hbRes = await chrome.storage.local.get('__heartbeat');
      const hbAt = hbRes?.__heartbeat || 0;
      const hbAge = hbAt ? Math.round((Date.now() - hbAt) / 1000) : -1;
      if (hbAge >= 0 && hbAge < 60) {
        add(true, t('diagnoseHeartbeat', hbAge));
      } else {
        add(false, t('diagnoseHeartbeatStale', hbAge));
      }
    }

    if (pwmAlarm && s.alarmCreatedAt && s.alarmDelayMinutes) {
      const dueAt = s.alarmCreatedAt + s.alarmDelayMinutes * 60000;
      const overdue = dueAt <= Date.now();
      add(!overdue, t('diagnoseAlarmNotExpired') + new Date(dueAt).toLocaleTimeString() + ')');
    }

    // 3. 检查 AC 页面
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    const exactHomeTabs = tabs.filter(tab => tab.url === 'https://w5.ab.ust.hk/njggt/app/home');
    const exactHomeTab = exactHomeTabs.find(tab => !tab.discarded) || null;
    add(exactHomeTabs.length > 0, t('diagnoseTabOpen') + exactHomeTabs.length + t('diagnoseTabCount'));
    if (exactHomeTab) {
      add(true, t('diagnoseTabNotDiscarded'));
      try {
        const status = bgSchedule.actualStatus;
        const statusAccepted = !!status && status.success !== false && status.invalidTarget !== true;
        add(statusAccepted, t('diagnoseContentOK'));
        add(statusAccepted && typeof status.isOn === 'boolean', t('diagnoseAcReadable') + (status?.isOn ? 'ON' : 'OFF'));
      } catch (e) {
        add(false, t('diagnoseContentNoResponse') + (e.message||'').slice(0,60));
      }
    }

    // 4. 后台状态
    try {
      add(!!bg, t('diagnoseSWOK'));
      add(bg.clockMode !== undefined, t('diagnoseClockSync') + (bg.clockMode ? t('diagnoseClock') : t('diagnoseInterval')));
      // PWM 失败提示:runPwmStep 验证失败时会写 pageTimerError。
      // 主动展示在诊断面板,方便定位"到时间没关/没开"的根因。
      if (s.pageTimerError) {
        add(false, t('diagnosePwmError') + String(s.pageTimerError).slice(0, 120));
      } else {
        add(true, t('diagnosePwmErrorEmpty'));
      }
    } catch (e) {
      add(false, t('diagnoseSWNoResponse'));
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
          add(false, t('diagnosePageTimerFail') + String(pt.error || '').slice(0,60));
        } else {
          add(true, t('diagnosePageTimerEmpty'));
        }
      } catch (e) {
        add(false, t('diagnosePageTimerFail') + (e.message||'').slice(0,60));
      }
    } else if (s.enabled) {
      add(true, t('diagnosePageTimerPending'));
    }

    // 4.6 ac-page-timer-retry 闹钟(指北固定 5 闹钟之一,此前诊断漏检)。
    // PWM 验证 runPwmStep 失败或新鲜页 page timer 读不回时,持久化 pageTimerRetryMinutes 与
    // ac-page-timer-retry 闹钟,1 分钟内自动重试 OFF 关机。诊断应显示这两者是否激活。
    const retryMin = Number(s.pageTimerRetryMinutes) || 0;
    if (retryMin > 0) {
      const retryAlarm = alarms.find(a => a.name === 'ac-page-timer-retry') || await chrome.alarms.get('ac-page-timer-retry');
      const retryAt = retryAlarm?.scheduledTime || 0;
      const retryStr = retryAt ? new Date(retryAt).toLocaleTimeString() : '?';
      add(!!retryAlarm, t('diagnosePageTimerRetry', retryStr, retryMin));
    } else {
      add(true, t('diagnosePageTimerRetryNone'));
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
      add(sw.initCompleted, t('diagnoseSWInitDone', swAgeSec, initAgeSec));
      // L2 offscreen 长连接保活页(阶段58):每分钟 badge-tick 顺带 ensureOffscreen 重建。
      // 三态兼容:v0.6.7+ SW 返回 offscreenAlive 真值(true/false);旧 SW 不返回该字段(undefined),
      // 视为 SW 跑旧代码,不打红灯避免误导用户以为 offscreen 失效。
      add(sw.offscreenAlive !== false, sw.offscreenAlive === true
        ? t('diagnoseOffscreenPresent')
        : (sw.offscreenAlive === false ? t('diagnoseOffscreenMissing') : t('diagnoseOffscreenUnknown')));
      const memNext = sw.memorySchedule?.nextTriggerAt || 0;
      const storedNext = storedSchedule.nextTriggerAt || 0;
      const memLive = sw.liveAlarmScheduledTime || 0;
      if (areDiagnosticTriggersAligned(memLive, memNext, storedNext)) {
        add(true, t('diagnoseTriMatch', fmt(memLive)));
      } else {
        add(false, t('diagnoseTriMismatch', fmt(memLive), fmt(memNext), fmt(storedNext)));
      }
    } else if (selfHealed) {
      // SW 没响应(可能跑旧代码),但 popup 已自愈 storage 接管 — 功能不受影响,显示绿灯
      add(true, t('diagnosePopHealedSw'));
    } else if (sw && sw.success === false) {
      add(false, t('diagnoseGetSwFailed') + (sw.error||'?').slice(0,80));
    } else if (sw) {
      add(false, t('diagnoseGetSwAbnormal') + JSON.stringify(sw).slice(0,80));
    } else {
      // SW 完全无响应且 popup 未自愈 — 这是真问题
      add(false, t('diagnoseGetSwNone'));
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
      add(false, t('diagnoseI18nNoTrans', i18nLang, testMsg));
    }

    // 8. 最近后台异常：只读本机有界环形日志，并入现有复制诊断报告。
    // 日志不含 URL、tabId、DOM、余额或账号信息，也不会进入 chrome.storage.sync。
    try {
      const diagnosticStorage = await chrome.storage.local.get('ac_diagnostic_log');
      appendRecentDiagnosticLogLines(lines, diagnosticStorage?.ac_diagnostic_log);
    } catch (e) {
      add(false, t('diagnoseRecentErrorsReadFailed') + (e.message || '').slice(0, 80));
    }
  } catch (e) {
    lines.push('❌ ' + t('diagnoseException') + (e.message||'').slice(0,80));
  } finally {
    renderDiagnoseResult(lines);
    lastDiagLines = lines.slice();
    if (btnCopyDiag) btnCopyDiag.hidden = false;
    btnDiagnose.disabled = false;
    showStatus(t('diagnoseComplete'), 'success');
  }
});

