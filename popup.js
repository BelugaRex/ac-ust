// ============================================================
// Popup 脚本 - 设置界面逻辑
// ============================================================

const enableToggle = document.getElementById('enableToggle');
const onMinutesInput = document.getElementById('onMinutes');
const offMinutesInput = document.getElementById('offMinutes');
const btnOn = document.getElementById('btnOn');
const btnOff = document.getElementById('btnOff');
const btnSave = document.getElementById('btnSave');
const statusDiv = document.getElementById('status');

// ----- 加载已保存的设置 -----
async function loadSettings() {
  const result = await chrome.storage.local.get('ac_schedule');
  const schedule = result.ac_schedule || {};
  enableToggle.checked = schedule.enabled || false;
  onMinutesInput.value = schedule.onMinutes || 30;
  offMinutesInput.value = schedule.offMinutes || 30;
}

function readPositiveMinutes(input, fallback) {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

// ----- 保存设置 -----
async function saveSettings(restart = false) {
  const data = {
    enabled: enableToggle.checked,
    mode: 'pwm',
    onMinutes: readPositiveMinutes(onMinutesInput, 30),
    offMinutes: readPositiveMinutes(offMinutesInput, 30),
    restart
  };

  onMinutesInput.value = data.onMinutes;
  offMinutesInput.value = data.offMinutes;
  
  // 发送给 background 更新 PWM 循环
  const response = await chrome.runtime.sendMessage({
    type: 'updateSchedule',
    data: data
  });
  
  if (response && response.success) {
    showStatus(data.enabled ? '✅ PWM 循环已保存并启动' : '✅ PWM 循环已关闭', 'success');
  } else {
    showStatus('❌ 保存失败', 'error');
  }
}

// ----- 切换启用状态 -----
enableToggle.addEventListener('change', () => {
  saveSettings(true);
});

// ----- 立即操作 -----
async function toggleNow(action) {
  showStatus('⏳ 正在操作...', '');
  
  // 查找所有打开的页面（不限于 active）
  const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
  
  if (tabs.length > 0) {
    // 在已有页面执行
    chrome.tabs.sendMessage(tabs[0].id, { action: action }, (resp) => {
      if (chrome.runtime.lastError) {
        showStatus('❌ 页面未就绪，请刷新后再试', 'error');
        return;
      }
      if (resp && resp.alreadyDone) {
        showStatus(`✅ 冷气已处于${action === 'on' ? '开启' : '关闭'}状态`, 'success');
      } else if (resp && resp.success) {
        showStatus(`✅ 冷气已${action === 'on' ? '开启' : '关闭'}`, 'success');
      } else {
        showStatus('❌ 操作失败: ' + (resp?.error || '未知错误'), 'error');
      }
    });
  } else {
    // 没有打开的页面，让 background 处理
    chrome.runtime.sendMessage({ type: 'toggleNow', action: action }, (response) => {
      if (response && response.success) {
        showStatus(`✅ 已发送${action === 'on' ? '开启' : '关闭'}指令`, 'success');
      } else {
        showStatus('❌ 请先打开 HKUST Power Meter 页面', 'error');
      }
    });
  }
}

btnOn.addEventListener('click', () => toggleNow('on'));
btnOff.addEventListener('click', () => toggleNow('off'));

// ----- 保存按钮 -----
btnSave.addEventListener('click', () => saveSettings(true));

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
