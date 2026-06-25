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
const countdownText = document.getElementById('countdownText');
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
  onMinutesInput.value = schedule.onMinutes ?? 60;
  offMinutesInput.value = schedule.offMinutes ?? 60;
  updateClockModeUI();
}

function updateClockModeUI() {
  clockModeToggle.checked = currentClockMode;
  if (currentClockMode) {
    intervalInputs.style.display = 'none';
    scheduleHint.textContent = '单数整点(1/3/5...23)开 · 双数整点(0/2/4...22)关。点"定时开"立即开始。';
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


    updateCountdownDisplay(schedule, alarm);
  } catch (e) {
    const stored = await chrome.storage.local.get("ac_schedule");
    if (stored.ac_schedule) {
      const alarm = await chrome.alarms.get("ac-pwm");
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

  const nextAction = schedule._effectivePwmState || schedule._nextAction || schedule.pwmState;
  // pwmState 是下一次闹钟要执行的动作；优先使用页面读取到的真实状态。
  const inferredACOn = nextAction !== 'on';
  const currentACOn = typeof schedule.actualStatus?.isOn === 'boolean'
    ? schedule.actualStatus.isOn
    : inferredACOn;

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
  const isClock = schedule.clockMode !== false;

  let remainingMs = 0;
  let nextBoundary = 0;
  if (isClock) {
    nextBoundary = schedule._nextBoundary || alarm?.scheduledTime || 0;
    if (!nextBoundary) {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      now.setHours(now.getHours() + 1);
      nextBoundary = now.getTime();
    }
    remainingMs = nextBoundary - Date.now();
  } else if (schedule._nextBoundary) {
    remainingMs = schedule._nextBoundary - Date.now();
  } else if (alarm?.scheduledTime) {
    remainingMs = alarm.scheduledTime - Date.now();
  } else if (schedule.alarmCreatedAt && schedule.alarmDelayMinutes) {
    remainingMs = schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000 - Date.now();
  }

  if (remainingMs > 0) {
    if (isClock && nextBoundary) {
      const hh = String(new Date(nextBoundary).getHours()).padStart(2, '0');
      const actionText = nextAction === 'on' ? '开启' : '关闭';
      countdownText.innerHTML = `下次 <strong>${hh}:00</strong> → ${actionText}`;
    } else {
      const minutes = Math.ceil(remainingMs / 60000);
      countdownText.innerHTML = `距离自动<span style="color:#64748b">${nextAction === 'on' ? '开启' : '关闭'}</span>还有&nbsp;<strong>${minutes}</strong>&nbsp;分钟`;
    }
  } else {
    countdownText.innerHTML = `即将自动${nextAction === 'on' ? '开启' : '关闭'}...`;
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

async function startup() {
  await loadSettings();
  await refreshStatus();
}

startup();
setInterval(refreshStatus, 1000);

// 从 manifest 读取版本号（硬编码兜底：版本号同时维护于 manifest.json 和此处）
const APP_VERSION = '0.4.32';
// BUILD_TIME 由 build.ps1 注入,用于诊断扩展实际加载的是哪次 build
// (同名版本号 0.4.28 可能对应多次代码改动,构建时间戳可区分)
const BUILD_TIME = 'dev';
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
  versionInfo.textContent = `AC-UST v${displayVersion} · ${BUILD_TIME}`;
  document.title = `AC-UST v${displayVersion}`;
}

// ----- 自诊断：检查 PWM 链路各环节状态 -----
const btnDiagnose = document.getElementById('btnDiagnose');
const diagnoseResult = document.getElementById('diagnoseResult');

btnDiagnose.addEventListener('click', async () => {
  diagnoseResult.style.display = 'block';
  diagnoseResult.innerHTML = '🔍 诊断中...';
  
  const lines = [];
  function add(ok, msg) { lines.push((ok ? '✅' : '❌') + ' ' + msg); }
  
  try {
    const ensured = await chrome.runtime.sendMessage({ type: 'ensureDiagnostics' });
    const bg = await chrome.runtime.sendMessage({ type: 'getSchedule' });

    // 1. 检查 storage / 后台权威快照
    const stored = await chrome.storage.local.get('ac_schedule');
    const storedSchedule = stored.ac_schedule || {};
    const bgSchedule = bg?.success === false && bg?.schedule
      ? bg.schedule
      : (bg || {});
    let s = { ...storedSchedule, ...(ensured?.schedule || {}), ...bgSchedule };
    let effectiveNextTriggerAt = s.nextTriggerAt || 0;

    // 1.5 自愈:如果 storage.nextTriggerAt=0 但 live ac-pwm 存在(间隔模式 + enabled),
    // 直接在 popup 侧补写 storage。不依赖 background 是否跑最新代码——这是 popup 主动
    // 修复路径,确保诊断面板能从根上消除"ac-pwm 在但 storage 缺绝对触发时间"的红灯。
    let pwmAlarmEarly = await chrome.alarms.get('ac-pwm');
    let selfHealed = false;
    if (s.enabled === true
        && s.clockMode === false
        && !effectiveNextTriggerAt
        && pwmAlarmEarly?.scheduledTime
        && pwmAlarmEarly.scheduledTime > Date.now()) {
      try {
        const repairedSchedule = {
          ...storedSchedule,
          ...s,
          nextTriggerAt: pwmAlarmEarly.scheduledTime,
          alarmCreatedAt: Date.now(),
          alarmDelayMinutes: Math.max(1, (pwmAlarmEarly.scheduledTime - Date.now()) / 60000)
        };
        await chrome.storage.local.set({ ac_schedule: repairedSchedule });
        // 等待 storage 写入完成
        await new Promise(r => setTimeout(r, 200));
        // 自愈成功后,直接使用 repairedSchedule 作为 s。
        // 不能再合并旧的 ensured/bgSchedule——它们携带诊断开始时的快照(nextTriggerAt=0),
        // 在合并时会把刚修复的值覆盖回 0(合并顺序 bug,Node 测试 verify-fix.mjs 发现)。
        s = { ...repairedSchedule };
        effectiveNextTriggerAt = s.nextTriggerAt || 0;
        selfHealed = true;
      } catch (e) {
        add(false, 'popup 侧 storage 自愈失败: ' + (e.message||'').slice(0,60));
      }
    }

    add(!!storedSchedule, 'storage 可读写');
    add(s.enabled === true, 'schedule.enabled=true (定时已启用)');
    add(!!s.mode, 'mode=' + (s.mode || '?'));
    add(s.clockMode !== undefined, 'clockMode=' + (s.clockMode ? '时钟' : '间隔'));
    if (s.clockMode === false && s.enabled && !effectiveNextTriggerAt) {
      add(false, 'storage 绝对触发时间缺失');
    } else if (effectiveNextTriggerAt) {
      const repairedLabel = selfHealed
        ? ' (popup 已自愈)'
        : (storedSchedule.nextTriggerAt === effectiveNextTriggerAt ? '' : ' (后台已回写)');
      add(true, 'storage 绝对触发时间: ' + new Date(effectiveNextTriggerAt).toLocaleTimeString() + repairedLabel);
    }

    // 2. 检查闹钟 — 优先用后台自愈结果，若仍缺失则弹窗直接补建
    let alarms = await chrome.alarms.getAll();
    const pwmAlarm = ensured?.alarms?.pwm || alarms.find(a => a.name === 'ac-pwm');
    add(!!pwmAlarm, 'ac-pwm 闹钟存在' + (pwmAlarm ? ' (触发: ' + new Date(pwmAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));
    if (pwmAlarm && s.clockMode === false && !effectiveNextTriggerAt) {
      add(false, 'ac-pwm 与 storage 触发时间同步');
    } else if (pwmAlarm && effectiveNextTriggerAt) {
      add(Math.abs(pwmAlarm.scheduledTime - effectiveNextTriggerAt) < 1500, 'ac-pwm 与 storage 触发时间同步' + (selfHealed ? ' (popup 已自愈)' : ''));
    }

    let badgeAlarm = ensured?.alarms?.badge || alarms.find(a => a.name === 'ac-badge-tick') || await chrome.alarms.get('ac-badge-tick');
    // 兜底：弹窗直接补建（不依赖后台往返）
    if (!badgeAlarm && s.enabled) {
      try { await chrome.alarms.clear('ac-badge-tick'); } catch (_) {}
      await chrome.alarms.create('ac-badge-tick', { delayInMinutes: 1 });
      await new Promise(r => setTimeout(r, 150)); // 等待 alarm 写入
      badgeAlarm = await chrome.alarms.get('ac-badge-tick');
    }
    add(!!badgeAlarm, 'ac-badge-tick 角标刷新（每分钟）' + (badgeAlarm ? ' (已补建: ' + new Date(badgeAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));

    let watchdogAlarm = ensured?.alarms?.watchdog || alarms.find(a => a.name === 'ac-watchdog');
    if (!watchdogAlarm && s.enabled) {
      try { await chrome.alarms.clear('ac-watchdog'); } catch (_) {}
      await chrome.alarms.create('ac-watchdog', { periodInMinutes: 5 });
      await new Promise(r => setTimeout(r, 150));
      watchdogAlarm = await chrome.alarms.get('ac-watchdog');
    }
    add(!!watchdogAlarm, 'ac-watchdog 看门狗（每5分钟）' + (watchdogAlarm ? ' ✅' : ''));

    add(true, 'setInterval heartbeat（storage 每 20s）');

    if (pwmAlarm && s.alarmCreatedAt && s.alarmDelayMinutes) {
      const dueAt = s.alarmCreatedAt + s.alarmDelayMinutes * 60000;
      const overdue = dueAt <= Date.now();
      add(!overdue, '闹钟未过期 (到期: ' + new Date(dueAt).toLocaleTimeString() + ')');
    }

    // 3. 检查 AC 页面
    const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/*' });
    add(tabs.length > 0, 'AC页面已打开 (' + tabs.length + '个标签页)');
    if (tabs.length > 0) {
      add(!tabs[0].discarded, '标签页未被浏览器丢弃');
      try {
        const status = await chrome.tabs.sendMessage(tabs[0].id, { action: 'status' });
        add(!!status, 'content script 响应正常');
        add(typeof status.isOn === 'boolean', 'AC状态可读: ' + (status.isOn ? 'ON' : 'OFF'));
      } catch (e) {
        add(false, 'content script 无响应: ' + (e.message||'').slice(0,60));
      }
    }

    // 4. 后台状态
    try {
      add(!!bg, '后台 SW 响应正常');
      add(bg.clockMode !== undefined, 'clockMode 同步: ' + (bg.clockMode ? '时钟' : '间隔'));
      // PWM 失败提示:runPwmStep 验证失败时会写 pageTimerError。
      // 主动展示在诊断面板,方便定位"到时间没关/没开"的根因。
      if (s.pageTimerError) {
        add(false, 'PWM 上次失败: ' + String(s.pageTimerError).slice(0, 120));
      } else {
        add(true, 'PWM 无错误状态(pageTimerError 空)');
      }
    } catch (e) {
      add(false, '后台 SW 无响应');
    }

    // 5. SW 状态可观测性:启动时间 / init 完成时间 / 内存 schedule 与 storage 是否一致
    // 用于下次出现"ac-pwm 在但 storage 缺 nextTriggerAt"时直接定位是瞬态还是持久状态。
    // 注意:getSwStatus 失败、未响应、或 SW 跑旧代码时 sw 可能为 undefined/success:false,
    // 必须在所有分支都显示信息,避免静默盲区。
    let sw = null;
    try {
      sw = await chrome.runtime.sendMessage({ type: 'getSwStatus' });
    } catch (e) {
      add(false, 'getSwStatus sendMessage 异常: ' + (e.message||'').slice(0,60));
    }
    if (!sw) {
      add(false, 'getSwStatus 返回空（SW 可能跑旧代码，无此消息处理器）');
    } else if (sw.success === false) {
      add(false, 'getSwStatus 后台失败: ' + (sw.error||'?').slice(0,80));
    } else if (sw.success === true) {
      const swAgeSec = Math.round((sw.swAgeMs || 0) / 1000);
      const initAgeSec = sw.initAgeMs >= 0 ? Math.round(sw.initAgeMs / 1000) : -1;
      add(sw.initCompleted, `SW init 已完成 (启动 ${swAgeSec}s 前，init ${initAgeSec}s 前)`);
      const memNext = sw.memorySchedule?.nextTriggerAt || 0;
      const storedNext = storedSchedule.nextTriggerAt || 0;
      const memLive = sw.liveAlarmScheduledTime || 0;
      const fmt = (t) => t ? new Date(t).toLocaleTimeString() : '∅';
      if (memLive && memNext === memLive && storedNext === memLive) {
        add(true, '三方一致: live ac-pwm = 内存 = storage = ' + fmt(memLive));
      } else {
        add(false, `三方校验: live=${fmt(memLive)} 内存=${fmt(memNext)} storage=${fmt(storedNext)}`);
      }
    } else {
      add(false, 'getSwStatus 异常响应: ' + JSON.stringify(sw).slice(0,80));
    }

    // 6. 构建时间戳:让用户/诊断能直接判断扩展实际加载的是哪次 build
    //    (同名版本号 0.4.28 可能对应多次代码改动,构建时间戳可区分)
    add(true, `BUILD_TIME: ${BUILD_TIME}`);
  } catch (e) {
    lines.push('❌ 诊断异常: ' + (e.message||'').slice(0,80));
  }
  
  diagnoseResult.innerHTML = lines.join('<br>');
});

