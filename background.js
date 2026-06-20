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
  pwmState: 'off'  // 下一次闹钟触发后要切换到的目标状态
};

// ----- 启动时加载设置并创建闹钟 -----
async function init() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (saved[STORAGE_KEY]) {
    schedule = { ...schedule, ...saved[STORAGE_KEY] };
  }
  await setupAlarms();
  console.log('[AC扩展] 初始化完成', schedule);
}

// ----- 设置/更新 PWM 循环闹钟 -----
async function setupAlarms(startImmediately = false) {
  // 清除所有现有闹钟
  await chrome.alarms.clearAll();
  
  if (!schedule.enabled) {
    console.log('[AC扩展] PWM 定时未启用');
    return;
  }

  schedule.onMinutes = sanitizeMinutes(schedule.onMinutes, 30);
  schedule.offMinutes = sanitizeMinutes(schedule.offMinutes, 30);
  schedule.mode = 'pwm';

  if (startImmediately) {
    schedule.pwmState = 'on';
    await chrome.storage.local.set({ [STORAGE_KEY]: schedule });
    await runPwmStep();
    return;
  }

  const nextDelay = schedule.pwmState === 'off' ? schedule.offMinutes : schedule.onMinutes;
  chrome.alarms.create('ac-pwm', {
    delayInMinutes: Math.max(1, nextDelay)
  });

  console.log(`[AC扩展] PWM 闹钟已设置 - 当前阶段:${schedule.pwmState} 下一次:${nextDelay}分钟后`);
}

function sanitizeMinutes(value, fallback) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes < 1) return fallback;
  return minutes;
}

async function runPwmStep() {
  if (!schedule.enabled) return;

  const targetAction = schedule.pwmState === 'on' ? 'on' : 'off';
  const currentDuration = targetAction === 'on' ? schedule.onMinutes : schedule.offMinutes;
  const nextState = targetAction === 'on' ? 'off' : 'on';

  console.log(`[AC扩展] PWM 执行: ${targetAction}，持续 ${currentDuration} 分钟`);
  await toggleAC(targetAction);

  schedule.pwmState = nextState;
  await chrome.storage.local.set({ [STORAGE_KEY]: schedule });

  chrome.alarms.create('ac-pwm', {
    delayInMinutes: Math.max(1, currentDuration)
  });

  console.log(`[AC扩展] PWM 下一阶段:${nextState}，${currentDuration}分钟后触发`);
}

// ----- 闹钟触发时执行 -----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`[AC扩展] 闹钟触发: ${alarm.name}`);
  
  if (alarm.name === 'ac-pwm') {
    await runPwmStep();
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

// ----- 监听来自 popup 的消息 -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    sendResponse(schedule);
  }
  if (msg.type === 'toggleNow') {
    toggleAC(msg.action).then(() => sendResponse({ success: true }));
    return true; // 异步响应
  }
});

// ----- 启动 -----
init();
