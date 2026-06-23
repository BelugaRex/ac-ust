// ============================================================
// Popup 脚本 - 设置界面逻辑 + 实时倒计时
// ============================================================

const onMinutesInput = document.getElementById('onMinutes');
const offMinutesInput = document.getElementById('offMinutes');
const clockModeToggle = document.getElementById('clockModeToggle');
const intervalInputs = document.getElementById('intervalInputs');
const scheduleHint = document.getElementById('scheduleHint');
const btnOn = document.getElementById('btnOn');
const btnOff = document.getElementById('btnOff');
const statusDiv = document.getElementById('status');
const acDot = document.getElementById('acDot');
const acStateText = document.getElementById('acStateText');
const countdownDisplay = document.getElementById('countdownDisplay');
const idleDisplay = document.getElementById('idleDisplay');
const countdownTime = document.getElementById('countdownTime');
const countdownLabel = document.getElementById('countdownLabel');
const safetynetHint = document.getElementById('safetynetHint');
const safetynetWarning = document.getElementById('safetynetWarning');

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
let currentClockMode = true;

async function loadSettings() {
  const result = await chrome.storage.local.get('ac_schedule');
  const schedule = result.ac_schedule || {};
  currentScheduleEnabled = !!schedule.enabled;
  currentClockMode = schedule.clockMode !== false; // 默认 true（时钟模式）
  onMinutesInput.value = schedule.onMinutes || 60;
  offMinutesInput.value = schedule.offMinutes || 60;
  updateClockModeUI();
}

function updateClockModeUI() {
  clockModeToggle.checked = currentClockMode;
  if (currentClockMode) {
    intervalInputs.style.display = 'none';
    onMinutesInput.value = 60;
    offMinutesInput.value = 60;
    scheduleHint.textContent = '🕐 时钟模式：单数整点(1/3/5...23)开冷气，双数整点(0/2/4...22)关冷气。点“定时开”立即开始循环。';
  } else {
    intervalInputs.style.display = '';
    scheduleHint.textContent = '点“定时开”会先开启冷气，然后按“开启分钟 / 关闭分钟”持续循环；点“定时关”会停止循环并默认关闭冷气。';
  }
}

clockModeToggle.addEventListener('change', () => {
  currentClockMode = clockModeToggle.checked;
  updateClockModeUI();
  if (currentScheduleEnabled) {
    // 模式切换后如果定时已启用，立即重启
    updateSchedule(true, true);
  }
});

// ----- 从后台拉取当前状态 + 直接读真实 PWM 闹钟 -----
async function refreshStatus() {
  try {
    const [response, alarm, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'getSchedule' }),
      chrome.alarms.get('ac-pwm'),
      chrome.storage.local.get('ac_schedule')
    ]);

    // getSchedule 正常返回 snapshot；异常时后台可能返回 { success:false, schedule }。
    const schedule = response?.success === false && response?.schedule
      ? response.schedule
      : response;

    // storage 是定时开关的最终真相源：只要已保存 enabled=true，就不要显示“定时已关闭”。
    if (!schedule?.enabled && stored.ac_schedule?.enabled) {
      updateCountdownDisplay(stored.ac_schedule, alarm);
      const repaired = await chrome.runtime.sendMessage({ type: 'repairSchedule' });
      if (repaired?.success) {
        const fixedAlarm = await chrome.alarms.get('ac-pwm');
        updateCountdownDisplay(repaired.schedule, fixedAlarm);
      }
      return;
    }

    updateCountdownDisplay(schedule, alarm);
  } catch (e) {
    // background 可能未就绪：优先用 storage 显示已启用状态；固定 1 秒轮询会继续同步。
    const stored = await chrome.storage.local.get('ac_schedule');
    if (stored.ac_schedule?.enabled) {
      const alarm = await chrome.alarms.get('ac-pwm');
      updateCountdownDisplay(stored.ac_schedule, alarm);
    }
  }
}

function updateCountdownDisplay(schedule, alarm) {
  if (!schedule || !schedule.enabled) {
    currentScheduleEnabled = false;
    // 定时未启用
    acDot.className = 'ac-dot off';
    acStateText.textContent = '定时已关闭';
    countdownDisplay.style.display = 'none';
    idleDisplay.style.display = 'flex';
    safetynetHint.style.display = 'none';
    safetynetWarning.style.display = 'none';
    return;
  }

  currentScheduleEnabled = true;
  idleDisplay.style.display = 'none';
  countdownDisplay.style.display = 'flex';

  // pwmState 是下一次闹钟要执行的动作；优先使用页面读取到的真实状态。
  const inferredACOn = schedule.pwmState !== 'on';
  const currentACOn = typeof schedule.actualStatus?.isOn === 'boolean'
    ? schedule.actualStatus.isOn
    : inferredACOn;
  const nextAction = schedule.pwmState;             // 'on' 或 'off'

  // 更新 AC 状态指示灯
  if (currentACOn) {
    acDot.className = 'ac-dot on';
    acStateText.textContent = '冷气运行中';
    if (schedule.pageTimerMinutes) {
      safetynetHint.style.display = 'block';
      safetynetHint.textContent = '🔒 页面关机保险已设置；核心 PWM 仍由扩展控制';
      safetynetWarning.style.display = schedule.pageTimerError ? 'block' : 'none';
      if (schedule.pageTimerError) {
        safetynetWarning.textContent = `ℹ️ ${schedule.pageTimerError}`;
      }
    } else if (schedule.pageTimerError) {
      safetynetHint.style.display = 'none';
      safetynetWarning.style.display = 'block';
      safetynetWarning.textContent = `ℹ️ 页面关机保险暂未设置：${schedule.pageTimerError}；PWM 循环仍会继续`;
    } else {
      safetynetHint.style.display = 'none';
      safetynetWarning.style.display = 'none';
    }
  } else {
    acDot.className = 'ac-dot off';
    acStateText.textContent = '冷气已关闭';
    safetynetHint.style.display = 'none';
    safetynetWarning.style.display = 'none';
  }

  // 计算倒计时
  let remainingMs = 0;
  if (alarm?.scheduledTime) {
    remainingMs = alarm.scheduledTime - Date.now();
  } else if (schedule._nextBoundary) {
    // 时钟模式
    remainingMs = schedule._nextBoundary - Date.now();
  } else if (schedule.alarmCreatedAt && schedule.alarmDelayMinutes) {
    remainingMs = schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000 - Date.now();
  }

  if (remainingMs > 0) {
    const minutes = Math.ceil(remainingMs / 60000);

    // 时钟模式：显示下次整点时间
    if (schedule._nextBoundary) {
      const nextTime = new Date(schedule._nextBoundary);
      const hh = String(nextTime.getHours()).padStart(2, '0');
      countdownTime.textContent = `${hh}:00`;
      countdownLabel.textContent = nextAction === 'on' ? '开启' : '关闭';
    } else {
      countdownTime.textContent = minutes;
      countdownLabel.textContent = nextAction === 'on' ? '开启' : '关闭';
    }
  } else if (alarm?.scheduledTime || schedule._nextBoundary || (schedule.alarmCreatedAt && schedule.alarmDelayMinutes)) {
    countdownTime.textContent = '不到 1';
    countdownLabel.textContent = nextAction === 'on' ? '开启' : '关闭';
  } else {
    countdownTime.textContent = '--';
    countdownLabel.textContent = nextAction === 'on' ? '开启' : '关闭';
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
    clockMode: currentClockMode,
    onMinutes: currentClockMode ? 60 : readPositiveMinutes(onMinutesInput, 30),
    offMinutes: currentClockMode ? 60 : readPositiveMinutes(offMinutesInput, 30),
    restart
  };

  onMinutesInput.value = data.onMinutes;
  offMinutesInput.value = data.offMinutes;
  
  const response = await chrome.runtime.sendMessage({
    type: 'updateSchedule',
    data: data
  });
  
  if (response && response.success) {
    currentScheduleEnabled = data.enabled;
    let finalResponse = response;

    if (!data.enabled) {
      // 定时关：无论 updateSchedule 返回的 offResult 如何，都独立再发一次即时关机。
      // 防止主世界 toggle 返回虚假成功（alreadyDone 或验证误判）。
      showStatus('⏳ 正在关闭 AC...', 'error');
      const toggleOff = await chrome.runtime.sendMessage({ type: 'toggleNow', action: 'off' });
      finalResponse = toggleOff?.schedule ? { ...response, schedule: toggleOff.schedule, offResult: toggleOff } : response;
      if (toggleOff?.success) {
        showStatus('✅ 定时已关闭，AC 已关机', 'success');
      } else if (response.offResult?.success) {
        // 首次关机声称成功但二次确认失败 → 以二次确认为准
        showStatus('⚠️ 定时已关闭，但关机未确认 — 请手动关闭', 'error');
      } else {
        showStatus('⚠️ 定时已关闭，但关机命令未确认', 'error');
      }
    } else {
      showStatus('✅ 定时已开启', 'success');
    }

    const alarm = await chrome.alarms.get('ac-pwm');
    updateCountdownDisplay(finalResponse.schedule, alarm);
  } else {
    showStatus('❌ 更新失败', 'error');
  }
}

// ----- 定时开 / 定时关 -----
btnOn.addEventListener('click', () => updateSchedule(true, true));
btnOff.addEventListener('click', () => updateSchedule(false, true));

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
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.className = 'status';
  }, 3000);
}

// ----- 启动 -----
loadSettings();
refreshStatus();
setInterval(refreshStatus, 1000);

// 从 manifest 读取版本号（硬编码兜底：版本号同时维护于 manifest.json 和此处）
const APP_VERSION = '0.4.2';
const versionInfo = document.getElementById('versionInfo');
if (versionInfo) {
  let displayVersion;
  try {
    const manifest = chrome.runtime.getManifest();
    displayVersion = manifest.version;
    // 交叉校验：如果 manifest 版本与硬编码不一致，说明浏览器加载了旧版扩展
    if (displayVersion !== APP_VERSION) {
      console.warn(`[AC-UST] 版本不一致：manifest=${displayVersion}, 源码=${APP_VERSION}。请重载扩展。`);
      displayVersion = APP_VERSION;
    }
  } catch (_) {
    displayVersion = APP_VERSION;
  }
  versionInfo.textContent = `AC-UST v${displayVersion}`;
  document.title = `AC-UST v${displayVersion}`;
}
