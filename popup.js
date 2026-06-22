// ============================================================
// Popup 脚本 - 设置界面逻辑 + 实时倒计时
// ============================================================

const onMinutesInput = document.getElementById('onMinutes');
const offMinutesInput = document.getElementById('offMinutes');
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

async function loadSettings() {
  const result = await chrome.storage.local.get('ac_schedule');
  const schedule = result.ac_schedule || {};
  currentScheduleEnabled = !!schedule.enabled;
  onMinutesInput.value = schedule.onMinutes || 30;
  offMinutesInput.value = schedule.offMinutes || 30;
}

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

  // 计算倒计时 —— 优先用浏览器真实 alarm 的 scheduledTime
  let remainingMs = 0;
  if (alarm?.scheduledTime) {
    remainingMs = alarm.scheduledTime - Date.now();
  } else if (schedule.alarmCreatedAt && schedule.alarmDelayMinutes) {
    remainingMs = schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000 - Date.now();
  }

  if (remainingMs > 0) {
    const minutes = Math.ceil(remainingMs / 60000);
    countdownTime.textContent = minutes;
    countdownLabel.textContent = nextAction === 'on' ? '开启' : '关闭';
  } else if (alarm?.scheduledTime || (schedule.alarmCreatedAt && schedule.alarmDelayMinutes)) {
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
    onMinutes: readPositiveMinutes(onMinutesInput, 30),
    offMinutes: readPositiveMinutes(offMinutesInput, 30),
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
    if (!data.enabled && response.offResult && !response.offResult.success) {
      showStatus('⚠️ 定时已关闭，但关机命令未确认', 'error');
    } else {
      showStatus(data.enabled ? '✅ 定时已开启' : '✅ 定时已关闭，已发送关机', 'success');
    }
    const alarm = await chrome.alarms.get('ac-pwm');
    updateCountdownDisplay(response.schedule, alarm);
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
