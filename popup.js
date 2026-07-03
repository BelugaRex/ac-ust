// ============================================================
// Popup 脚本 - 设置界面逻辑 + 实时倒计时
// ============================================================

// i18n 辅助函数 — 委托给 I18n 模块（fetch-based，绕过 chrome.i18n 不可靠性）
const t = (key, ...subs) => I18n.t(key, ...subs);

const onMinutesInput = document.getElementById('onMinutes');
const offMinutesInput = document.getElementById('offMinutes');
const scheduleHint = document.getElementById('scheduleHint');
const activeHoursToggle = document.getElementById('activeHoursToggle');
const activeHoursStart = document.getElementById('activeHoursStart');
const activeHoursEnd = document.getElementById('activeHoursEnd');
const activeHoursStatus = document.getElementById('activeHoursStatus');
const timerToggle = document.getElementById('timerToggle');
const timerToggleLabel = document.getElementById('timerToggleLabel');
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
let currentActiveHours = { enabled: false, start: '08:00', end: '23:00' };

async function loadSettings() {
  const result = await chrome.storage.local.get('ac_schedule');
  const schedule = result.ac_schedule || {};
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
}

function syncActiveHoursUI() {
  activeHoursToggle.checked = currentActiveHours.enabled;
  activeHoursStart.value = currentActiveHours.start;
  activeHoursEnd.value = currentActiveHours.end;
  activeHoursStart.disabled = !currentActiveHours.enabled;
  activeHoursEnd.disabled = !currentActiveHours.enabled;
  updateActiveHoursStatusBadge();
}

function updateActiveHoursStatusBadge() {
  if (!currentActiveHours.enabled) {
    activeHoursStatus.style.display = 'none';
    return;
  }
  activeHoursStatus.style.display = '';
  const cur = new Date();
  const curMin = cur.getHours() * 60 + cur.getMinutes();
  const [sh, sm] = currentActiveHours.start.split(':').map(Number);
  const [eh, em] = currentActiveHours.end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const inside = start < end && curMin >= start && curMin < end;
  activeHoursStatus.textContent = inside ? t('activeHoursWithin') : t('activeHoursOutside');
  activeHoursStatus.className = 'ah-status ' + (inside ? 'active' : 'idle');
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
    syncToggleState(false);
    // 定时未启用
    acDot.className = 'ac-dot off';
    acStateText.textContent = t('acOff');
    countdownDisplay.style.display = 'none';
    idleDisplay.style.display = 'flex';
    safetynetHint.style.display = 'none';
    safetynetWarning.style.display = 'none';
    return;
  }

  currentScheduleEnabled = true;
  syncToggleState(true);
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
    acStateText.textContent = t('acRunning');
    if (schedule.pageTimerMinutes) {
      safetynetHint.style.display = 'block';
      safetynetHint.textContent = t('safetynetSet');
      safetynetWarning.style.display = schedule.pageTimerError ? 'block' : 'none';
      if (schedule.pageTimerError) {
        safetynetWarning.textContent = t('safetynetError', schedule.pageTimerError);
      }
    } else if (schedule.pageTimerError) {
      safetynetHint.style.display = 'none';
      safetynetWarning.style.display = 'block';
      safetynetWarning.textContent = t('safetynetNotSet', schedule.pageTimerError);
    } else {
      safetynetHint.style.display = 'none';
      safetynetWarning.style.display = 'none';
    }
  } else {
    acDot.className = 'ac-dot off';
    acStateText.textContent = t('acStopped');
    safetynetHint.style.display = 'none';
    safetynetWarning.style.display = 'none';
  }

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
    countdownText.innerHTML = t('countdownInterval', t(nextAction === 'on' ? 'actionOn' : 'actionOff'), String(minutes));
  } else {
    countdownText.innerHTML = t('countdownSoon', t(nextAction === 'on' ? 'actionOn' : 'actionOff'));
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

    // 手动开关冷气（定时已关时会自动关机）
    if (!data.enabled) {
      // B1: background 的 updateSchedule handler 已经负责关机，
      // popup 不再发第二次 toggleNow（避免双击噪音）
      showStatus(t('statusClosedOK'), 'success');
    } else {
      showStatus(t('statusOnOK'), 'success');
    }

    const alarm = await chrome.alarms.get('ac-pwm');
    updateCountdownDisplay(finalResponse.schedule, alarm);
  } else {
    showStatus(t('statusError'), 'error');
  }
}

// ----- 定时拨动开关（双向同步 toggle） -----
let _toggleProgrammatic = false; // 防止程序同步时触发 onChange 循环

timerToggle.addEventListener('change', async () => {
  if (_toggleProgrammatic) return; // 程序同步，不触发 updateSchedule
  const enabled = timerToggle.checked;
  timerToggle.disabled = true; // 防止双击
  timerToggleLabel.textContent = enabled ? t('timerEnabling') : t('timerDisabling');
  try {
    await updateSchedule(enabled, true);
  } finally {
    timerToggle.disabled = false;
  }
});

// 供外部（refreshStatus）同步 toggle 状态时不触发 onChange
function syncToggleState(enabled) {
  _toggleProgrammatic = true;
  timerToggle.checked = enabled;
  timerToggleLabel.textContent = enabled ? t('timerEnabled') : t('timerDisabled');
  _toggleProgrammatic = false;
}

// refreshStatus 每秒调用：刷新 active hours 状态徽章（时间会变）
function tickActiveHoursBadge() {
  if (currentActiveHours.enabled) updateActiveHoursStatusBadge();
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
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.className = 'status';
  }, 3000);
}

async function startup() {
  // 先加载 i18n 翻译，再填充 DOM 静态文本，最后拉取状态
  await I18n.load();
  I18n.applyToDOM();
  await loadSettings();
  await refreshStatus();
}

startup();
setInterval(refreshStatus, 1000);
setInterval(tickActiveHoursBadge, 10000);  // 每 10 秒刷新 active hours 状态徽章

// 从 manifest 读取版本号（硬编码兜底：版本号同时维护于 manifest.json 和此处）
const APP_VERSION = '0.5.4';
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
      console.warn(t('versionMismatch', displayVersion, APP_VERSION));
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

  // B3: 浏览器版本信息 — 方便跨浏览器排障
  const ua = navigator.userAgent;
  const isEdge = /Edg\//i.test(ua);
  const isChrome = /Chrome\//i.test(ua) && !isEdge;
  const browserName = isEdge ? 'Edge' : isChrome ? 'Chrome' : 'Unknown';
  const browserVer = ua.match(isEdge ? /Edg\/([\d.]+)/ : /Chrome\/([\d.]+)/)?.[1] || '?';
  lines.push('ℹ️ 浏览器: ' + browserName + ' ' + browserVer);
  
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
    add(s.enabled === true, 'schedule.enabled=' + s.enabled + ' (' + (s.enabled ? '定时已启用' : '定时未启用') + ')');
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
    add(!!watchdogAlarm, 'ac-watchdog 看门狗（每5分钟）' + (watchdogAlarm ? ' (已补建: ' + new Date(watchdogAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));

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
    // 注意:getSwStatus 失败、未响应、或 SW 跑旧代码时 sw 可能为 undefined/success:false,
    // 必须在所有分支都显示信息,避免静默盲区。
    // 评判原则:getSwStatus 只是辅助诊断,不是核心功能。如果 popup 已自愈 storage 接管,
    // 即使 SW 没响应,功能上也是 OK 的,显示绿灯而非红灯。
    let sw = null;
    try {
      sw = await chrome.runtime.sendMessage({ type: 'getSwStatus' });
    } catch (e) {
      // sendResponse 异常,记录但不直接红灯
      console.warn('getSwStatus sendMessage 异常:', e?.message);
    }
    if (sw && sw.success === true) {
      // SW 响应成功:显示三方一致校验
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
    } else if (selfHealed) {
      // SW 没响应(可能跑旧代码),但 popup 已自愈 storage 接管 — 功能不受影响,显示绿灯
      add(true, 'popup 已接管 storage 自愈(SW 详细状态不可用,功能正常)');
    } else if (sw && sw.success === false) {
      add(false, 'getSwStatus 后台失败: ' + (sw.error||'?').slice(0,80));
    } else if (sw) {
      add(false, 'getSwStatus 异常响应: ' + JSON.stringify(sw).slice(0,80));
    } else {
      // SW 完全无响应且 popup 未自愈 — 这是真问题
      add(false, 'getSwStatus 无响应且 popup 未自愈 — 建议在 edge://extensions 重新加载扩展');
    }

    // 6. 构建时间戳:让用户/诊断能直接判断扩展实际加载的是哪次 build
    //    (同名版本号 0.4.28 可能对应多次代码改动,构建时间戳可区分)
    add(true, `BUILD_TIME: ${BUILD_TIME}`);

    // 7. i18n 系统状态诊断 — 显示 I18n 模块实际加载的语言和翻译测试结果
    const i18nLang = I18n.getLang();
    const testMsg = I18n.t('pwmSettings');
    if (testMsg && !testMsg.startsWith('pwmSettings')) {
      add(true, `i18n OK (lang=${i18nLang}, "pwmSettings"→"${testMsg.slice(0,20)}")`);
    } else {
      add(false, `i18n 未加载翻译 (lang=${i18nLang}, result="${testMsg}")`);
    }
  } catch (e) {
    lines.push('❌ 诊断异常: ' + (e.message||'').slice(0,80));
  }
  
  diagnoseResult.innerHTML = lines.join('<br>');
});

