// 单元测试:验证 popup.js 诊断面板的"storage 自愈"修复逻辑
// 模拟用户报告的场景:storage.nextTriggerAt=0 + live ac-pwm 存在(间隔模式 + enabled)
// 预期:popup 侧主动写 storage,把 nextTriggerAt 修复为 ac-pwm.scheduledTime

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import syncHelpers from '../sync-helpers.js';
import billingHelpers from '../billing-helpers.js';
import pwmPhase from '../pwm-phase.js';
import smartMode from '../smart-mode.js';
import recoveryCoordinator from '../recovery-coordinator.js';
import { runPwmPhaseCases } from './pwm-phase-cases.mjs';
import { runSmartModeCases } from './smart-mode-cases.mjs';
import { runRecoveryPolicyCases } from './recovery-policy-cases.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function extractSourceSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`${label}: 找不到起始标记 ${JSON.stringify(startMarker)}`);
  }
  const end = source.indexOf(endMarker, start);
  if (end <= start) {
    throw new Error(`${label}: 找不到结束标记 ${JSON.stringify(endMarker)}`);
  }
  const section = source.slice(start, end);
  if (!section.trim()) {
    throw new Error(`${label}: 提取到空源码区段`);
  }
  return section;
}

// ----- Mock chrome.* API -----
function createMockChrome(initialSchedule, liveAcPwmScheduledTime, scheduleSnapshotPatch = {}) {
  let storage = {
    ac_schedule: { ...initialSchedule }
  };
  let storageSync = {};  // [v0.5.6] sync 区的 mock 存储
  const alarms = {
    'ac-pwm': liveAcPwmScheduledTime
      ? { name: 'ac-pwm', scheduledTime: liveAcPwmScheduledTime }
      : undefined
  };
  const messageHandlers = {};

  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === 'ac_schedule') return { ac_schedule: { ...storage.ac_schedule } };
          if (key === '__heartbeat') return { __heartbeat: Date.now() };
          return { ...storage };
        },
        async set(obj) {
          if (obj.ac_schedule) storage.ac_schedule = { ...obj.ac_schedule };
          if (obj.__heartbeat) storage.__heartbeat = obj.__heartbeat;
        }
      },
      // [v0.5.6] sync area（跨设备同步测试模拟）
      sync: {
        async get(key) {
          if (key === 'ac_schedule_sync') return storageSync.ac_schedule_sync
            ? { ac_schedule_sync: { ...storageSync.ac_schedule_sync } }
            : {};
          return { ...storageSync };
        },
        async set(obj) {
          if (obj.ac_schedule_sync) storageSync.ac_schedule_sync = { ...obj.ac_schedule_sync };
        }
      },
      onChanged: { addListener() {} }
    },
    alarms: {
      async get(name) { return alarms[name] ? { ...alarms[name] } : undefined; },
      async getAll() {
        return Object.values(alarms).filter(Boolean).map(a => ({ ...a }));
      },
      async create() {},
      async clear() {},
      onAlarm: { addListener() {} }
    },
    runtime: {
      async sendMessage(msg) {
        const handler = messageHandlers[msg.type];
        if (!handler) return undefined;
        return handler(msg);
      },
      getManifest: () => ({ version: manifest.version }),
      getPlatformInfo: async () => ({ os: 'win' }),
      onConnect: { addListener() {} },
      onUpdateAvailable: { addListener() {} }
    },
    tabs: {
      async query() { return [{ id: 1, discarded: false }]; },
      async sendMessage() { return { isOn: true }; }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} }
  };

  // 注册后台消息处理器(模拟 v0.4.30 background.js 的关键路径)
  messageHandlers['ensureDiagnostics'] = () => ({
    success: true, enabled: true, repaired: false,
    schedule: { ...storage.ac_schedule },
    alarms: {
      badge: { scheduledTime: Date.now() + 60000 },
      watchdog: { scheduledTime: Date.now() + 300000, periodInMinutes: 5 },
      pwm: alarms['ac-pwm'] ? { scheduledTime: alarms['ac-pwm'].scheduledTime } : null
    }
  });
  messageHandlers['getSchedule'] = () => ({ ...storage.ac_schedule, ...scheduleSnapshotPatch });
  messageHandlers['getSwStatus'] = () => ({
    success: true,
    swStartupTime: Date.now() - 10000,
    initCompletedAt: Date.now() - 9000,
    swAgeMs: 10000,
    initAgeMs: 9000,
    initCompleted: true,
    memorySchedule: { ...storage.ac_schedule },
    liveAlarmScheduledTime: alarms['ac-pwm']?.scheduledTime || 0,
    offscreenAlive: true
  });

  return { chrome, _storage: storage, _alarms: alarms };
}

// ----- 提取 popup.js 中诊断函数的修复逻辑(逐行复制核心代码) -----
// 这段代码是 popup.js 中 btnDiagnose.addEventListener 的核心自愈逻辑,
// 完整对应用刚才提交的 v0.4.30 修复。
async function runDiagnosticSelfHeal(chrome, opts = {}) {
  const lines = [];
  const add = (ok, msg) => lines.push((ok ? '✅' : '❌') + ' ' + msg);
  const setTimeout_mock = (fn) => new Promise(resolve => {
    fn();
    resolve();
  });
  const projectPersistentSchedule = scheduleSnapshot => Object.fromEntries(
    Object.entries(scheduleSnapshot || {}).filter(([key]) => (
      key !== 'actualStatus'
      && key !== 'balanceMinutes'
      && !key.startsWith('_')
    ))
  );

  // 模拟 popup.js 中诊断函数开头读取的数据
  const ensured = await chrome.runtime.sendMessage({ type: 'ensureDiagnostics' });
  const bg = await chrome.runtime.sendMessage({ type: 'getSchedule' });

  const stored = await chrome.storage.local.get('ac_schedule');
  const storedSchedule = stored.ac_schedule || {};
  const bgSchedule = bg?.success === false && bg?.schedule
    ? bg.schedule
    : (bg || {});
  let s = { ...storedSchedule, ...(ensured?.schedule || {}), ...bgSchedule };
  let effectiveNextTriggerAt = s.nextTriggerAt || 0;

  // 1.5 自愈逻辑(v0.4.34: 过期也触发) - 直接从 popup.js 复制
  const nowMs = Date.now();
  const storedIsStale = !effectiveNextTriggerAt || effectiveNextTriggerAt < nowMs;
  let pwmAlarmEarly = await chrome.alarms.get('ac-pwm');
  let selfHealed = false;
  if (s.enabled === true
      && s._automationPausedByActiveHours !== true
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
      await new Promise(r => setTimeout(r, 200));
      // 自愈成功后直接用 repairedSchedule,不合并旧 ensured/bgSchedule(它们携带 nextTriggerAt=0/过期 会覆盖)
      s = { ...s, ...repairedSchedule };
      effectiveNextTriggerAt = s.nextTriggerAt || 0;
      selfHealed = true;
    } catch (e) {
      add(false, 'popup 侧 storage 自愈失败: ' + (e.message||'').slice(0,60));
    }
  }

  // 红灯判断(直接复制 popup.js 逻辑)
  add(!!storedSchedule, 'storage 可读写');
  add(s.enabled === true, 'schedule.enabled=true (自动控制已启用)');
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

  let alarms = await chrome.alarms.getAll();
  const pwmAlarm = ensured?.alarms?.pwm || alarms.find(a => a.name === 'ac-pwm');
  add(!!pwmAlarm, 'ac-pwm 闹钟存在' + (pwmAlarm ? ' (触发: ' + new Date(pwmAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));
  if (pwmAlarm && s.clockMode === false && !effectiveNextTriggerAt) {
    add(false, 'ac-pwm 与 storage 触发时间同步');
  } else if (pwmAlarm && effectiveNextTriggerAt) {
    add(Math.abs(pwmAlarm.scheduledTime - effectiveNextTriggerAt) < 1500, 'ac-pwm 与 storage 触发时间同步' + (selfHealed ? ' (popup 已自愈)' : ''));
  }

  // 正式构建即使完成 popup storage 自愈，也不能把无法核验身份的旧 SW 判绿。
  let sw = null;
  try {
    sw = await chrome.runtime.sendMessage({ type: 'getSwStatus' });
  } catch (_) {}
  if (sw && sw.success === true) {
    add(true, 'SW init 已完成 (getSwStatus 响应正常)');
  } else if (selfHealed) {
    add(false, '[SW-BUILD-UNVERIFIED] storage 已修复，但 Service Worker 构建身份无法验证');
  } else if (!sw) {
    add(false, 'getSwStatus 无响应且 popup 未自愈');
  } else {
    add(false, 'getSwStatus 后台失败');
  }

  return { lines, selfHealed, storage_after: (await chrome.storage.local.get('ac_schedule')).ac_schedule };
}

// ----- 跑测试用例 -----
async function runTests() {
  const results = [];
  const verbose = process.argv.includes('--verbose') || process.env.TEST_VERBOSE === '1';
  const suiteOrder = [];
  let currentSuite = '';

  const verboseLog = (...args) => {
    if (verbose) console.log(...args);
  };
  const testConsole = verbose ? console : { log() {}, warn() {}, error() {} };
  const setSuite = (name) => {
    currentSuite = name;
    if (!suiteOrder.includes(name)) suiteOrder.push(name);
  };
  const beginSuite = (name, heading) => {
    setSuite(name);
    verboseLog(heading);
  };
  const assertPass = (cond, name) => {
    const pass = !!cond;
    if (verbose) {
      verboseLog(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
    } else if (!pass) {
      console.log(`❌ FAIL  [${currentSuite}] ${name}`);
    }
    results.push({ suite: currentSuite, name, pass });
  };

  // 用例 1:用户实际报告的场景(storage.nextTriggerAt 过期 + ac-pwm 在未来 + 间隔 + enabled)
  // 这模拟 SW 跑旧代码、storage 没跟上闹钟推进的情况(v0.4.34 新触发条件:不只 0,过期也触发)
  const pwmTime = Date.now() + 5 * 60 * 1000; // 5 分钟后,模拟 01:57:55
  const staleTime = Date.now() - 24 * 60 * 1000; // 24 分钟前已过期,模拟 01:29:41
  const initialSchedule = {
    enabled: true,
    mode: 'pwm',
    clockMode: false,           // 间隔模式
    onMinutes: 60,
    offMinutes: 60,
    pwmState: 'off',
    nextTriggerAt: staleTime,   // ← 已过期(v0.4.34 新触发条件),这是红灯根因
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0
  };
  const { chrome, _storage } = createMockChrome(initialSchedule, pwmTime);

  beginSuite('用例 1：诊断自愈',
    '\n=== 用例 1:用户报告场景(storage.nextTriggerAt 已过期 + ac-pwm 在未来 + 间隔模式) ===\n');
  verboseLog('初始 storage.nextTriggerAt =', initialSchedule.nextTriggerAt, '(已过期 24 分钟)');
  verboseLog('live ac-pwm.scheduledTime =', new Date(pwmTime).toLocaleTimeString(), '(timestamp:', pwmTime + ')');
  verboseLog('');

  const before = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
  verboseLog('修复前 storage:', { nextTriggerAt: before.nextTriggerAt, alarmCreatedAt: before.alarmCreatedAt });

  const result = await runDiagnosticSelfHeal(chrome);

  verboseLog('\n--- 诊断输出 ---');
  for (const line of result.lines) verboseLog(line);

  const after = result.storage_after;
  verboseLog('\n修复后 storage:', {
    nextTriggerAt: after.nextTriggerAt,
    nextTriggerAt_time: new Date(after.nextTriggerAt).toLocaleTimeString(),
    alarmCreatedAt: after.alarmCreatedAt ? new Date(after.alarmCreatedAt).toLocaleTimeString() : 0,
    alarmDelayMinutes: after.alarmDelayMinutes?.toFixed(2)
  });

  beginSuite('PWM 纯决策', '\n\n=== PWM phase 纯决策接口 ===\n');
  runPwmPhaseCases(assertPass);

  beginSuite('智能控制纯决策', '\n\n=== 智能控制纯决策接口 (v0.8.0) ===\n');
  runSmartModeCases(assertPass);

  beginSuite('恢复策略纯决策', '\n\n=== 恢复策略模块化纯决策接口 ===\n');
  runRecoveryPolicyCases(assertPass);

  setSuite('用例 1：诊断自愈');
  verboseLog('\n--- 断言 ---');
  assertPass(result.selfHealed === true, 'selfHealed 标志为 true(自愈触发)');
  assertPass(after.nextTriggerAt === pwmTime, 'storage.nextTriggerAt 被修复为 ac-pwm.scheduledTime');
  assertPass(after.alarmCreatedAt > 0, 'alarmCreatedAt 已写入');
  assertPass(after.alarmDelayMinutes > 0, 'alarmDelayMinutes 已写入');
  assertPass(!result.lines.some(l => l.includes('storage 绝对触发时间缺失')),
    '红灯"storage 绝对触发时间缺失"已消除');
  assertPass(!result.lines.some(l => l.startsWith('❌') && l.includes('ac-pwm 与 storage 触发时间同步')),
    '红灯"ac-pwm 与 storage 触发时间同步"已消除');
  assertPass(result.lines.some(l => l.includes('(popup 已自愈)')),
    '修复后显示"(popup 已自愈)"标签');

  const runtimeSnapshotPatch = {
    actualStatus: { isOn: true, balanceState: 'available', balanceMinutes: 156 },
    balanceMinutes: 156,
    _nextBoundary: pwmTime,
    _effectivePwmState: 'off'
  };
  const pollutedSnapshotMock = createMockChrome(
    initialSchedule,
    pwmTime,
    runtimeSnapshotPatch
  );
  const pollutionResult = await runDiagnosticSelfHeal(pollutedSnapshotMock.chrome);
  const pollutionKeys = Object.keys(pollutionResult.storage_after);
  assertPass(!pollutionKeys.includes('actualStatus')
      && !pollutionKeys.includes('balanceMinutes')
      && !pollutionKeys.some(key => key.startsWith('_')),
    '诊断自愈只持久化 schedule 字段，不把 full snapshot 运行时字段写入 ac_schedule');
  const popupProjectionSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const projectPersistentScheduleSource = extractSourceSection(
    popupProjectionSource,
    'function projectPersistentSchedule(scheduleSnapshot) {',
    'btnDiagnose.addEventListener',
    'projectPersistentSchedule'
  );
  const projectPersistentSchedule = new Function(
    `${projectPersistentScheduleSource}; return projectPersistentSchedule;`
  )();
  const projectedSchedule = projectPersistentSchedule({
    ...initialSchedule,
    ...runtimeSnapshotPatch
  });
  assertPass(projectedSchedule.enabled === true
      && projectedSchedule.nextTriggerAt === staleTime
      && !Object.hasOwn(projectedSchedule, 'actualStatus')
      && !Object.hasOwn(projectedSchedule, 'balanceMinutes')
      && !Object.keys(projectedSchedule).some(key => key.startsWith('_')),
    'popup 真实持久化投影保留 schedule 数据并剥离余额与所有下划线运行态字段');

  // 用例 2:storage 已有正确 nextTriggerAt,不应触发自愈
  beginSuite('用例 2：已有正确状态', '\n\n=== 用例 2:storage 已有正确值(不该触发自愈) ===\n');
  const initialSchedule2 = { ...initialSchedule, nextTriggerAt: pwmTime };
  const mock2 = createMockChrome(initialSchedule2, pwmTime);
  const result2 = await runDiagnosticSelfHeal(mock2.chrome);
  for (const line of result2.lines) verboseLog(line);
  verboseLog('');
  assertPass(result2.selfHealed === false, '已有正确值时不触发自愈(selfHealed=false)');
  assertPass(!result2.lines.some(l => l.startsWith('❌')),
    '用例 2 无任何红灯');

  // 用例 3:非间隔模式(时钟模式),不该触发自愈
  beginSuite('用例 3：时钟模式', '\n\n=== 用例 3:时钟模式(不该触发自愈) ===\n');
  const initialSchedule3 = { ...initialSchedule, clockMode: true };
  const mock3 = createMockChrome(initialSchedule3, pwmTime);
  const result3 = await runDiagnosticSelfHeal(mock3.chrome);
  for (const line of result3.lines) verboseLog(line);
  verboseLog('');
  assertPass(result3.selfHealed === false, '时钟模式不触发自愈');

  // 用例 4:SW 不响应 getSwStatus(模拟跑旧代码)+ popup 自愈成功 → 正式构建仍须红灯
  beginSuite('用例 4：Service Worker 降级', '\n\n=== 用例 4:SW 不响应 getSwStatus + popup 自愈成功 ===\n');
  const initialSchedule4 = { ...initialSchedule, nextTriggerAt: staleTime };
  const mock4 = createMockChrome(initialSchedule4, pwmTime);
  // 让 SW 不响应 getSwStatus(模拟旧代码无此 handler)
  mock4.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'getSwStatus') return undefined;
    if (msg.type === 'ensureDiagnostics') {
      return mock4.chrome.runtime['_ensureDiagnosticsResult']?.() || {
        success: true, enabled: true, repaired: false,
        schedule: { ...mock4._storage.ac_schedule },
        alarms: { badge: null, watchdog: null, pwm: { scheduledTime: pwmTime } }
      };
    }
    if (msg.type === 'getSchedule') return { ...mock4._storage.ac_schedule };
    return undefined;
  };
  const result4 = await runDiagnosticSelfHeal(mock4.chrome);
  for (const line of result4.lines) verboseLog(line);
  verboseLog('');
  assertPass(result4.selfHealed === true, '用例 4 自愈触发');
  assertPass(result4.lines.some(l => l.startsWith('❌')
      && l.includes('SW-BUILD-UNVERIFIED')
      && l.includes('构建身份无法验证')),
    '用例 4 正式构建无法核验旧 SW 时保持红灯，storage 自愈不再制造假绿');
  assertPass(result4.lines.some(l => l.includes('storage 绝对触发时间')
      && l.includes('popup 已自愈')),
    '用例 4 仍明确报告 popup 已修复 storage 时钟，但不据此放行旧 SW');

  // ===== 用例 5: i18n fetch-based 加载器 — 验证用户报告的三个坏键 =====
  beginSuite('用例 5：i18n、页面逻辑与产物契约',
    '\n\n=== 用例 5:i18n 翻译加载 (用户报告 acStopped/countdownInterval 显示为 key name) ===\n');

  // 加载真实的 messages.json
  const zhCN = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'zh_CN', 'messages.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));

  // 复刻 i18n.js 的 substitute() 逻辑
  function substitute(msg, subs) {
    if (!subs || !subs.length) return msg;
    let out = msg;
    subs.forEach((s, i) => { out = out.split(`$${i + 1}`).join(String(s)); });
    return out;
  }
  // 复刻 i18n.js 的 t() 逻辑
  function t(messages, key, ...subs) {
    const entry = messages[key];
    if (!entry || typeof entry.message !== 'string') return key; // fallback
    return substitute(entry.message, subs);
  }

  // 5a: acStopped 必须返回中文，不能是 "acStopped"
  const acStopped_zh = t(zhCN, 'acStopped');
  verboseLog('  zh_CN acStopped →', JSON.stringify(acStopped_zh));
  assertPass(acStopped_zh !== 'acStopped',
    'acStopped 不再返回 key name (zh_CN)');
  assertPass(acStopped_zh.includes('冷气') || acStopped_zh.includes('关闭'),
    `acStopped 返回中文翻译: "${acStopped_zh}"`);

  // 5c: countdownCaption 带占位符替换
  const cd_zh = t(zhCN, 'countdownCaption', '关闭');
  verboseLog('  zh_CN countdownCaption(关闭) →', JSON.stringify(cd_zh));
  assertPass(cd_zh !== 'countdownCaption',
    'countdownCaption 不再返回 key name (zh_CN)');
  assertPass(cd_zh.includes('关闭'),
    `countdownCaption 占位符替换正确: "${cd_zh}"`);
  assertPass(!cd_zh.includes('$1'),
    'countdownCaption 无残留 $1 占位符');

  // 5d: 英文翻译也覆盖同样的 key（Crowdin 双向对齐）
  const acStopped_en = t(en, 'acStopped');
  verboseLog('  en acStopped →', JSON.stringify(acStopped_en));
  assertPass(acStopped_en !== 'acStopped',
    'acStopped 英文翻译存在 (非 key name)');
  assertPass(acStopped_en !== acStopped_zh,
    '中英翻译确实不同 (zh ≠ en)');

  // 5e: popup.html 中 data-i18n 属性与 messages.json key 完全对齐
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const distPopupHtml = fs.readFileSync(path.join(ROOT, 'dist', 'popup.html'), 'utf8');
  const popupFallbackPath = path.join(ROOT, 'popup-diagnostic-fallback.js');
  const popupFallbackSource = fs.existsSync(popupFallbackPath)
    ? fs.readFileSync(popupFallbackPath, 'utf8')
    : '';
  const dataI18nKeys = [...popupHtml.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
  verboseLog('  popup.html data-i18n keys:', dataI18nKeys.join(', '));
  for (const key of dataI18nKeys) {
    assertPass(!!zhCN[key] && !!en[key],
      `popup.html data-i18n="${key}" 在中英文 messages.json 中存在`);
  }

  const dataI18nAriaLabelKeys = [...popupHtml.matchAll(/data-i18n-aria-label="([^"]+)"/g)].map(m => m[1]);
  verboseLog('  popup.html data-i18n-aria-label keys:', dataI18nAriaLabelKeys.join(', '));
  for (const key of dataI18nAriaLabelKeys) {
    assertPass(!!zhCN[key] && !!en[key],
      `popup.html data-i18n-aria-label="${key}" 在中英文 messages.json 中存在`);
  }

  // 5f: popup.html 不应残留 __MSG_*__ 占位符
  assertPass(!popupHtml.includes('__MSG_'),
    'popup.html 不残留 __MSG_*__ 占位符 (改用 data-i18n)');

  // 5g: manifest 必须声明 default_locale,以满足 /_locales 目录的清单要求
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const distManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'manifest.json'), 'utf8'));
  assertPass(manifest.default_locale === 'zh_CN',
    'manifest.json 声明 default_locale=zh_CN');
  assertPass(distManifest.default_locale === 'zh_CN',
    'dist/manifest.json 也同步 default_locale=zh_CN');
  assertPass(distManifest.version === manifest.version,
    `dist/manifest.json 版本与源码一致 (${manifest.version})`);
  assertPass(distPopupHtml.includes(`<script src="popup.js?v=${manifest.version}"></script>`),
    'dist popup 脚本资源版本参数由构建注入并与 manifest 同步');
  assertPass(popupHtml.indexOf('<script src="popup-diagnostic-fallback.js"></script>') > 0
      && popupHtml.indexOf('<script src="popup-diagnostic-fallback.js"></script>')
        < popupHtml.search(/<script src="popup\.js\?v=[^"]+"><\/script>/),
    'Popup 独立兜底诊断先于主脚本加载，主脚本失效时仍可接管诊断按钮');
  assertPass(popupHtml.indexOf('<script src="billing-helpers.js"></script>')
      < popupHtml.search(/<script src="popup\.js\?v=[^"]+"><\/script>/),
    'popup 在主脚本前加载余额纯函数，避免初始化时缺少估算器');

  const fallbackLocaleKeys = [
    'diagnoseFallbackSummary',
    'diagnoseFallbackCapturedError',
    'diagnoseFallbackNoCapturedError',
    'diagnoseFallbackDocument',
    'diagnoseFallbackSchedule',
    'diagnoseFallbackAlarms',
    'diagnoseFallbackHeartbeat',
    'diagnoseFallbackSw',
    'diagnoseFallbackSectionFailed',
    'diagnoseFallbackPartial'
  ];
  assertPass(fallbackLocaleKeys.every(key => zhCN[key]?.message && en[key]?.message),
    'Popup 兜底诊断的现场、分区失败与部分报告文案保持中英双语');
  assertPass(popupFallbackSource.includes("addEventListener('error'")
      && popupFallbackSource.includes("addEventListener('unhandledrejection'")
      && popupFallbackSource.includes("chrome.storage.local.get(['ac_schedule', '__heartbeat'])")
      && popupFallbackSource.includes('chrome.alarms.getAll()')
      && popupFallbackSource.includes("type: 'getSwStatus'")
      && popupFallbackSource.includes('event.stopImmediatePropagation()')
      && !popupFallbackSource.includes('location.href')
      && !popupFallbackSource.includes('innerText'),
    'Popup 兜底诊断独立采集 error/storage/alarms/SW，接管失败路径且不读取 URL/DOM 原文');

  const fallbackPureStart = popupFallbackSource.indexOf('  function sanitizeFallbackError(');
  const fallbackPureEnd = popupFallbackSource.indexOf('\n\n  async function loadFallbackTranslations', fallbackPureStart);
  const fallbackPureSource = fallbackPureStart >= 0 && fallbackPureEnd > fallbackPureStart
    ? popupFallbackSource.slice(fallbackPureStart, fallbackPureEnd)
    : '';
  const fallbackPureHelpers = fallbackPureSource
    ? new Function(`${fallbackPureSource}; return { sanitizeFallbackError, formatFallbackBrowser, formatFallbackSchedule };`)()
    : null;
  assertPass(!!fallbackPureHelpers,
    'Popup 兜底诊断提供可独立验证的脱敏错误与安全 schedule 投影 helper');
  if (fallbackPureHelpers) {
    const sanitizedFallbackError = fallbackPureHelpers.sanitizeFallbackError(
      'failed https://w5.ab.ust.hk/njggt/app/home and chrome-extension://secret/popup.js for student@connect.ust.hk'
    );
    const fallbackScheduleText = fallbackPureHelpers.formatFallbackSchedule({
      enabled: true,
      mode: 'pwm',
      clockMode: false,
      pwmState: 'off',
      nextTriggerAt: 1_787_714_629_522,
      activeHours: { enabled: true, start: '08:00', end: '23:00' },
      smartMode: { enabled: false, sensitivity: 5 },
      pageTimerError: 'private DOM failure',
      actualStatus: { balanceMinutes: 156, account: 'student@connect.ust.hk' }
    });
    assertPass(sanitizedFallbackError.includes('[url]')
        && sanitizedFallbackError.includes('[email]')
        && !sanitizedFallbackError.includes('w5.ab.ust.hk')
        && !sanitizedFallbackError.includes('chrome-extension://')
        && !sanitizedFallbackError.includes('student@connect.ust.hk')
        && fallbackScheduleText.includes('enabled=true')
        && fallbackScheduleText.includes('pageTimerError=true')
        && !fallbackScheduleText.includes('private DOM failure')
        && !fallbackScheduleText.includes('balanceMinutes')
        && !fallbackScheduleText.includes('student@connect.ust.hk'),
      'Popup 兜底报告脱敏 URL/邮箱，只投影调度字段且不泄露错误原文、余额或账号');
    assertPass(fallbackPureHelpers.formatFallbackSchedule({ mode: 'pwm.v2' }).includes('mode=pwm.v2'),
      'Popup 兜底安全 token 保留版本与模式中的点号，报告不损坏可定位信息');
    assertPass(fallbackPureHelpers.formatFallbackBrowser(
      'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36 Edg/151.0.1.0'
    ) === 'Edge 151.0.1.0',
    'Popup 兜底浏览器识别优先 Edge，不把同时存在的 Chrome token 误报为 Chrome');
  }

  // 5h: popup 布局防回归 —— 固定桌面面板宽度，避免 intrinsic/vw 初始布局竞态。
  const popupCss = fs.readFileSync(path.join(ROOT, 'popup.css'), 'utf8');
  const popupCssNoComments = popupCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assertPass(popupHtml.includes('<style media="not all">')
      && /<link rel="stylesheet" href="popup\.css\?v=[^"]+">/.test(popupHtml),
    'popup 停用遗留内联样式，并只加载新的实体 macOS 风格样式表');
  assertPass(!/\d\s*vw\b|\d\s*vh\b/.test(popupCssNoComments),
    'popup.html 的 CSS 不使用 vw/vh 视口单位（防窗口塌陷回归）');
  assertPass(!/\d+\.\d+px\b/.test(popupCssNoComments),
    'popup.css 的显式像素尺寸均使用整数，避免主动引入子像素几何');
  assertPass(/--popup-width:\s*280px/.test(popupCssNoComments)
      && /body\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.app-shell\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.static-preview body\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.static-preview \.app-shell\s*\{[^}]*?transform-origin:\s*top left/.test(popupCssNoComments),
    'popup、shell 与静态预览共用 280px 宽度令牌；窄预览仍从左上角整体缩放');
  assertPass(/--font:\s*-apple-system,\s*BlinkMacSystemFont,\s*"SF Pro Text",\s*"Helvetica Neue",\s*"Segoe UI Variable Text",\s*"Segoe UI Variable",\s*"Segoe UI"/.test(popupCssNoComments)
      && popupCssNoComments.includes('"PingFang SC"')
      && popupCssNoComments.includes('"Microsoft YaHei UI"')
      && popupCssNoComments.includes('"Noto Sans CJK SC"')
      && !popupCssNoComments.includes('"Inter Variable"')
      && !popupCssNoComments.includes('"Inter"'),
    'popup 优先使用平台 UI 字体并保留 CJK 回退，不因用户偶然安装 Inter 而改变外观');
  assertPass(/body\s*\{[^}]*?font-family:\s*var\(--font\)[^}]*?font-optical-sizing:\s*auto/.test(popupCssNoComments),
    'popup 显式允许可变系统字体按实际字号使用 optical sizing');
  assertPass(/\.content\s*\{[^}]*?width:\s*auto[^}]*?min-width:\s*0[^}]*?padding:\s*8px 12px/.test(popupCssNoComments),
    '内容区使用水平12px、垂直8px的紧凑 gutter，不再由标签或版本元数据决定面板宽度');
  assertPass(/\.status-card,\s*\.settings-card\s*\{[^}]*?background:\s*var\(--surface\)[^}]*?border:\s*1px solid var\(--border\)/.test(popupCssNoComments)
      && popupHtml.includes('class="hero-number" id="countdownNumber"')
      && /\.hero-countdown\s*\{[^}]*?align-items:\s*baseline/.test(popupCssNoComments),
    '状态卡保持中性表面，状态由语义圆点表达；倒计时数字和说明按基线连续阅读');
  assertPass(popupHtml.includes('class="visually-hidden" id="timerToggleState"')
      && popupHtml.includes('class="visually-hidden" id="smartModeToggleState"'),
    '两种自动模式的状态变化保留给辅助技术，但不与可见选中态重复显示');
  assertPass(/id="automationSettingsLabel"[\s\S]*?for="automationToggle"[\s\S]*?id="automationToggle"/.test(popupHtml)
      && /id="activeHoursRow"[\s\S]*?for="activeHoursToggle"[\s\S]*?class="toggle-switch"/.test(popupHtml)
      && /for="activeHoursStart"[\s\S]*?id="activeHoursStart"[\s\S]*?for="activeHoursEnd"[\s\S]*?id="activeHoursEnd"/.test(popupHtml)
      && !popupHtml.includes('id="activeHoursStatus"'),
    '自动控制与运行时段各有独立二元拨杆；开始/结束字段保留完整无障碍名称');
  assertPass(popupHtml.includes('data-i18n="automationSettingsLabel"')
      && popupHtml.includes('id="automationScopeHint" data-i18n="automationScopeHint"')
      && /class="active-hours-section"[^>]*aria-describedby="automationScopeHint"/.test(popupHtml),
    '自动控制组显式说明运行时段同时约束两种自动模式，并把该说明关联到运行时段区段');
  assertPass((popupHtml.match(/class="field-grid"/g) || []).length === 2
      && (popupHtml.match(/class="field"/g) || []).length === 4
      && /\.field-grid\s*\{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*?gap:\s*10px/.test(popupCssNoComments),
    '运行时段与循环时长各使用一组等宽双列字段');
  assertPass(/\.field input\[type="text"\]\s*,\s*\.field input\[type="number"\]\s*\{[^}]*?width:\s*100%[^}]*?height:\s*32px[^}]*?font-size:\s*13px/.test(popupCssNoComments)
      && (popupHtml.match(/type="text"[^>]*inputmode="numeric"[^>]*placeholder="HH:mm"/g) || []).length === 2
      && !/<input[^>]*type="time"/.test(popupHtml),
    '运行时段固定为单字段 24 小时 HH:mm；四个字段统一使用 32px 控件高度和 13px 数字');
  assertPass(en.acRunning?.message === 'AC is on'
      && en.pwmSettings?.message === 'Cycle timer'
      && en.smartModeLabel?.message === 'Smart control'
      && en.automationScopeHint?.message === 'Active hours limit both automatic modes'
      && en.scheduleHintPinTab?.message === 'Keep the UST AC tab pinned and open for timer control.',
    '英文 280px Popup 使用完整清晰标签，核心状态与模式名不换行');
  assertPass(/\.toggle-switch\s*\{[^}]*?width:\s*36px[^}]*?height:\s*20px/.test(popupCssNoComments)
      && /\.toggle-switch::after\s*\{[^}]*?inset:\s*-11px\s+-4px/.test(popupCssNoComments)
      && (popupHtml.match(/class="toggle-switch"/g) || []).length === 2,
    '自动控制与运行时段使用 36×20px 二元拨杆，并通过绝对命中区达到桌面指针目标要求');
  assertPass((popupHtml.match(/class="mode-choice"/g) || []).length === 2
      && /<fieldset class="mode-section">\s*<legend class="visually-hidden"[^>]*>[\s\S]*?class="mode-segment"[\s\S]*?<button[^>]*id="timerToggle"[^>]*aria-pressed="false"[\s\S]*?<button[^>]*id="smartModeToggle"[^>]*aria-pressed="false"/.test(popupHtml)
      && !/<input[^>]*id="(?:timerToggle|smartModeToggle)"/.test(popupHtml)
      && /\.mode-segment\s*\{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(popupCssNoComments)
      && /\.mode-choice\s*\{[^}]*?white-space:\s*nowrap/.test(popupCssNoComments)
      && /\.mode-choice\[aria-pressed="true"\]\s*\{[^}]*?background:\s*var\(--surface\)/.test(popupCssNoComments)
      && !popupHtml.includes('mode-choice-mark'),
    '循环定时与智能控制使用紧凑等宽二选一分段控件，标签不换行且选中态由表面与描边表达');
  assertPass((popupHtml.match(/class="number-field"/g) || []).length === 2
      && (popupHtml.match(/class="field-unit" data-i18n="unitMinutes"/g) || []).length === 2
      && /\.field-unit\s*\{[^}]*?position:\s*absolute[^}]*?pointer-events:\s*none/.test(popupCssNoComments),
    '两个时长输入框内嵌「分钟」单位（不响应指针），标签保持精简');
  assertPass(/body\s*\{[^}]*?font-size:\s*13px/.test(popupCssNoComments)
      && /\.header-name\s*\{[^}]*?font-size:\s*14px/.test(popupCssNoComments)
      && /\.field-label\s*\{[^}]*?font-size:\s*11px/.test(popupCssNoComments)
      && /\.hero-number\s*\{[^}]*?font-size:\s*26px/.test(popupCssNoComments)
      && /\.header-version\s*\{[^}]*?font-size:\s*11px/.test(popupCssNoComments),
    '排版层级固定为 11/12/13/14/15px，26px 仅用于倒计时主数字');
  assertPass(/html:lang\(zh\)\s+:is\([^)]*#activeHoursSectionHeader h3[^)]*\.section-title[^)]*\)\s*\{[^}]*font-size:\s*14px/.test(popupCssNoComments)
      && /html:lang\(zh\)\s+:is\([^)]*\.ac-indicator[^)]*\.mode-choice[^)]*\.btn-diagnose[^)]*\)\s*\{[^}]*font-size:\s*13px/.test(popupCssNoComments)
      && /html:lang\(zh\)\s+:is\([^)]*\.automation-heading p[^)]*\.field-label[^)]*\.settings-hint[^)]*\.smart-readout-label[^)]*\)\s*\{[^}]*font-size:\s*12px/.test(popupCssNoComments)
      && /html:lang\(zh\)\s+\.field-unit\s*\{[^}]*font-size:\s*11px/.test(popupCssNoComments)
      && !popupCssNoComments.includes('html:lang(en)'),
    '中文 locale 独立补偿小号文字各 1px，英文默认字级与 280px 几何不受影响');
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  assertPass(popupJs.includes('const smartSelected = currentSmartMode.enabled;')
      && popupJs.includes('const timerSelected = !smartSelected;')
      && popupJs.includes('automationToggle.checked = currentScheduleEnabled;')
      && popupJs.includes("'statusSmartOnOK'")
      && popupJs.includes("'statusOnOK'")
      && popupJs.includes("add(true, t('diagnoseSmartModeOn'))")
      && zhCN.statusSmartOnOK?.message === '智能控制已开启'
      && zhCN.diagnoseOn?.message === '自动控制已启用'
      && zhCN.diagnoseSmartModeOn?.message.includes('循环定时按互斥规则关闭')
      && en.statusSmartOnOK?.message === 'Smart control is on'
      && en.diagnoseOn?.message === 'automatic control active',
    '智能控制与循环定时互斥展示，成功提示和诊断区分全局自动控制与当前模式');
  assertPass(popupJs.includes('const IS_STATIC_PREVIEW = !globalThis.chrome?.runtime?.id;')
      && /const staticPreviewSchedule = \{[\s\S]{0,400}enabled:\s*true,[\s\S]{0,400}actualStatus:\s*\{\s*isOn:\s*true\s*\}/.test(popupJs)
      && /async function refreshStatus\(\) \{[\s\S]{0,160}if \(IS_STATIC_PREVIEW\)/.test(popupJs)
      && /async function updateSchedule\(enabled, restart = false\) \{[\s\S]{0,1200}if \(IS_STATIC_PREVIEW\)/.test(popupJs)
      && /if \(IS_STATIC_PREVIEW\)[\s\S]{0,1000}data\.smartMode\.enabled \? 'statusSmartOnOK' : 'statusOnOK'/.test(popupJs),
    '静态网页预览可交互且按当前模式反馈开启状态，不依赖扩展 API');
  assertPass(popupHtml.includes('class="app-shell" id="appShell"')
      && popupJs.includes('function fitStaticPreviewToViewport()')
      && popupJs.includes('const currentScale = Number(document.documentElement.dataset.previewScale) || 1;')
      && popupJs.includes('const naturalWidth = renderedRect.width / currentScale;')
      && popupJs.includes('const scale = Math.min(1, availableWidth / naturalWidth);')
      && popupJs.includes('new ResizeObserver(fitStaticPreviewToViewport).observe(appShell);')
      && popupJs.includes('startup().then(setupStaticPreviewFit);'),
    '窄窗口按插件自然宽度整体缩放，宽窗口保持 1:1 且内容变化后自动重算');
  assertPass(popupJs.includes("t('countdownCaption'")
      && !popupJs.includes("t('countdownInterval'")
      && popupJs.includes('countdownNumber.textContent = String(minutes);'),
    'popup.js 倒计时写入 hero 大数字与 countdownCaption，不再使用 countdownInterval');
  const countdownClassifierStart = popupJs.indexOf('function classifyCountdownPresentation(');
  const countdownClassifierEnd = popupJs.indexOf('\nfunction updateCountdownDisplay(', countdownClassifierStart);
  const countdownClassifierSource = countdownClassifierStart >= 0
      && countdownClassifierEnd > countdownClassifierStart
    ? popupJs.slice(countdownClassifierStart, countdownClassifierEnd)
    : '';
  const classifyCountdownPresentation = countdownClassifierSource
    ? new Function(`${countdownClassifierSource}; return classifyCountdownPresentation;`)()
    : null;
  const normalOnCountdown = classifyCountdownPresentation?.({
    pwmState: 'on',
    actualStatus: { isOn: false }
  });
  const pageTimerSafetyRetryCountdown = classifyCountdownPresentation?.({
    pwmState: 'on',
    pageTimerError: '页面定时器未确认；1 分钟后重试',
    actualStatus: { isOn: true }
  });
  const manualOffReconcileCountdown = classifyCountdownPresentation?.({
    pwmState: 'off',
    pageTimerError: '',
    actualStatus: { isOn: false }
  });
  const unexpectedOnDuringSafeDelay = classifyCountdownPresentation?.({
    pwmState: 'on',
    pwmRetryKind: 'smart-on-safe-delay',
    actualStatus: { isOn: true }
  });
  const unexpectedOnDuringSafetySkip = classifyCountdownPresentation?.({
    pwmState: 'on',
    pwmRetryKind: 'smart-on-safety-skip',
    actualStatus: { isOn: true }
  });
  assertPass(typeof classifyCountdownPresentation === 'function'
      && normalOnCountdown?.kind === 'normal-action'
      && normalOnCountdown.action === 'on'
      && pageTimerSafetyRetryCountdown?.kind === 'safety-retry'
      && manualOffReconcileCountdown?.kind === 'phase-reconcile'
      && manualOffReconcileCountdown.action === 'off'
      && unexpectedOnDuringSafeDelay?.kind === 'phase-reconcile'
      && unexpectedOnDuringSafetySkip?.kind === 'phase-reconcile'
      && popupJs.includes("case 'phase-reconcile':")
      && popupJs.includes("case 'safety-retry':"),
    'popup.js 显式区分正常动作、安全 timer 重试与实际状态/计划相位失配；19:23 目标 OFF 不会因人工 OFF 被误标为自动 ON');
  assertPass(popupJs.includes('function formatBuildTimeShort(buildTime)')
      && popupJs.includes('return `${month}/${day} ${hour}:${minute}`;')
      && popupJs.includes('versionInfo.textContent = `v${displayVersion} · ${formatBuildTimeShort(BUILD_TIME)}`')
      && popupJs.includes("versionInfo.setAttribute('aria-label', buildInfo)")
      && popupJs.includes('versionInfo.title = buildInfo;'),
    '头栏显示版本号与 MM/DD 分钟级短构建时间，完整秒级时间保留在 tooltip 和无障碍名称');
  const buildMatchStart = popupJs.indexOf('function isMatchingServiceWorkerBuild(sw)');
  const buildMatchEnd = popupJs.indexOf('\nfunction formatBuildTimeShort', buildMatchStart);
  const buildMatchSource = buildMatchStart >= 0 && buildMatchEnd > buildMatchStart
    ? popupJs.slice(buildMatchStart, buildMatchEnd)
    : '';
  const loadBuildMatcher = (buildTime, buildEpoch) => new Function(
    `const BUILD_TIME = ${JSON.stringify(buildTime)};
    const BUILD_TIME_EPOCH_MS = ${buildEpoch};
    ${buildMatchSource};
    return isMatchingServiceWorkerBuild;`
  )();
  const packagedBuildMatcher = loadBuildMatcher('2026-08-27 22:40:00', 123456);
  const devBuildMatcher = loadBuildMatcher('dev', 0);
  assertPass(packagedBuildMatcher({
    buildTime: '2026-08-27 22:40:00',
    buildTimeEpochMs: 123456
  }) === true
      && packagedBuildMatcher({
        buildTime: '2026-08-27 22:39:59',
        buildTimeEpochMs: 123455
      }) === false
      && packagedBuildMatcher({}) === false
      && devBuildMatcher({}) === null
      && popupJs.includes("code: 'SW-BUILD-MISMATCH'")
      && popupJs.includes("code: 'SW-BUILD-UNVERIFIED'")
      && popupJs.includes('Number(BUILD_TIME_EPOCH_MS) > 0')
      && popupJs.includes("action: t('diagnoseActionReloadExtension')")
      && zhCN.diagnoseSWBuildMismatch?.message.includes('构建不一致')
      && zhCN.diagnoseSwBuildUnverified?.message.includes('构建身份无法验证')
      && en.diagnoseSWBuildMismatch?.message.includes('builds differ'),
    '诊断：打包版 Popup/SW 构建一致才绿；旧 SW 缺字段、无响应或身份不同均提示重新加载扩展');
  const formatBuildTimeStart = popupJs.indexOf('function formatBuildTimeShort(buildTime)');
  const formatBuildTimeEnd = popupJs.indexOf('\nconst versionInfo =', formatBuildTimeStart);
  const formatBuildTimeShort = new Function(
    `${popupJs.slice(formatBuildTimeStart, formatBuildTimeEnd)}; return formatBuildTimeShort;`
  )();
  assertPass(formatBuildTimeShort('2026-08-09 22:45:12') === '08/09 22:45'
      && formatBuildTimeShort('dev') === 'dev',
    '头栏短构建时间语义验证保留月日两位数，并原样返回非构建时间占位');
  assertPass(popupHtml.includes('class="balance-estimate" id="balanceEstimate"')
      && !popupHtml.includes('id="balanceSummary"')
      && !popupHtml.includes('id="balanceMinutesValue"')
      && popupJs.includes('schedule?.actualStatus?.balanceMinutes')
      && popupJs.includes('estimateBalanceExhaustion({')
      && popupJs.includes("estimatePrefix.textContent = t('balanceEstimatePrefix')")
      && popupJs.includes('estimateTime.textContent = shortAt')
      && popupJs.includes('balanceEstimate.replaceChildren(estimatePrefix, estimateTime)')
      && popupJs.includes("urgent ? 'balanceEstimateUrgentTitle' : 'balanceEstimateTitle'")
      && popupJs.includes("? t('balanceEstimateToday')")
      && popupJs.includes("? t('balanceEstimateTomorrow')")
      && popupJs.includes('tomorrow.setDate(today.getDate() + 1)')
      && popupJs.includes("String(target.getMonth() + 1).padStart(2, '0')")
      && popupJs.includes("String(target.getDate()).padStart(2, '0')")
      && popupJs.includes('const monthDay = `${String(target.getMonth() + 1).padStart(2, \'0\')}-${String(target.getDate()).padStart(2, \'0\')}`;')
      && !popupJs.includes("month: 'numeric', day: 'numeric'")
      && popupJs.includes('isBalanceEstimateUrgent(estimate?.usableWallMinutes)')
      && popupJs.includes("balanceEstimate.classList.toggle('is-urgent', urgent)")
      && popupJs.includes("balanceEstimate.setAttribute('aria-label', estimateTitle)")
      && popupJs.includes("balanceEstimate.classList.remove('is-urgent')")
      && popupJs.includes("padStart(2, '0')")
      && zhCN.balanceEstimatePrefix?.message === '预计可用至'
      && zhCN.balanceEstimateToday?.message === '今天'
      && zhCN.balanceEstimateTomorrow?.message === '明天'
      && zhCN.balanceEstimateUrgentTitle?.message.includes('24 小时内用完')
      && en.balanceEstimatePrefix?.message === 'Est. until'
      && en.balanceEstimateToday?.message === 'Today'
      && en.balanceEstimateTomorrow?.message === 'Tomorrow'
      && en.balanceEstimateUrgentTitle?.message.includes('run out within 24 hours')
      && /\.balance-estimate\s*\{[^}]*?margin-left:\s*auto[^}]*?font-size:\s*11px/.test(popupCssNoComments)
      && /--warning-accent:\s*#b45309/.test(popupCssNoComments)
      && /\.balance-estimate\.is-urgent::before\s*\{[^}]*?position:\s*absolute[^}]*?bottom:\s*3px[^}]*?background:\s*var\(--warning-accent\)[^}]*?content:\s*"!"/.test(popupCssNoComments)
      && /\.balance-estimate-prefix\s*\{[^}]*?color:\s*var\(--text-tertiary\)[^}]*?font-size:\s*12px[^}]*?font-weight:\s*500[^}]*?line-height:\s*14px/.test(popupCssNoComments)
      && /\.balance-estimate-time\s*\{[^}]*?color:\s*var\(--text-secondary\)[^}]*?font-weight:\s*600/.test(popupCssNoComments)
      && /\.balance-estimate\.is-urgent \.balance-estimate-time\s*\{[^}]*?padding-left:\s*11px[^}]*?color:\s*var\(--warning-accent\)/.test(popupCssNoComments)
      && /\.balance-estimate-prefix,[\s\S]*?\.balance-estimate-time\s*\{[^}]*?text-overflow:\s*ellipsis/.test(popupCssNoComments),
    '预计时刻分为两行，以轻量符号和日期强调配合无障碍文案提醒24小时内余额耗尽');

  const sourceLocaleResources = manifest.web_accessible_resources || [];
  const distLocaleResources = distManifest.web_accessible_resources || [];
  const hasUstLocaleResourceRule = (resources) => resources.some(rule =>
    rule.resources?.includes('_locales/*/messages.json')
      && rule.matches?.includes('https://w5.ab.ust.hk/*')
  );
  assertPass(hasUstLocaleResourceRule(sourceLocaleResources),
    'manifest 为 UST 页面内容脚本公开 locale JSON（fetch i18n）');
  assertPass(hasUstLocaleResourceRule(distLocaleResources),
    'dist/manifest.json 保留 locale JSON 的 web_accessible_resources 规则');
  assertPass(Array.isArray(manifest.host_permissions)
      && manifest.host_permissions.length === 2
      && manifest.host_permissions.includes('https://w5.ab.ust.hk/*')
      && manifest.host_permissions.includes('https://data.weather.gov.hk/*'),
    'manifest 仅请求自动调度所需的两个最小来源 host permission（UST 页面 + 天文台开放数据天气源）');

  const expectedToolbarIcon = 'icons/ac-ust_16.png';
  assertPass(manifest.action?.default_icon === expectedToolbarIcon,
    'manifest 工具栏在所有 DPI 复用 popup 的 16px 图标');
  assertPass(distManifest.action?.default_icon === expectedToolbarIcon,
    'dist/manifest.json 保留统一的 16px 工具栏图标');
  const expectedExtensionIcons = {
    16: 'icons/ac-ust_16.png',
    48: 'icons/ac-ust_48.png',
    128: 'icons/ac-ust_128.png'
  };
  assertPass(Object.entries(expectedExtensionIcons).every(([size, iconPath]) =>
      manifest.icons?.[size] === iconPath),
    'manifest 的扩展图标入口为管理页/商店提供 16/48/128px logo');
  assertPass(Object.entries(expectedExtensionIcons).every(([size, iconPath]) =>
      distManifest.icons?.[size] === iconPath),
    'dist/manifest.json 保留扩展图标映射');

  const distRequiredFiles = [
    'manifest.json', 'background.js', 'content.js', 'page-confirm.js',
    'popup.html', 'popup.js', 'popup-diagnostic-fallback.js', 'i18n.js',
    'sync-helpers.js', 'pwm-phase.js', 'smart-recovery.js',
    'interval-recovery.js', 'recovery-coordinator.js', 'smart-mode.js',
    'billing-helpers.js',
    'offscreen.html', 'offscreen.js',
    'popup.css',
    '_locales/zh_CN/messages.json', '_locales/en/messages.json',
    ...new Set([
      expectedToolbarIcon,
      ...Object.values(expectedExtensionIcons)
    ])
  ];
  const missingDistFiles = distRequiredFiles.filter(file => !fs.existsSync(path.join(ROOT, 'dist', file)));
  assertPass(missingDistFiles.length === 0,
    `dist 包含全部运行时文件${missingDistFiles.length ? `（缺少 ${missingDistFiles.join(', ')}）` : ''}`);

  const verbatimDistFiles = distRequiredFiles.filter(file =>
    ![
      'background.js',
      'content.js',
      'page-confirm.js',
      'popup.html',
      'popup.js'
    ].includes(file));
  const mismatchedDistFiles = verbatimDistFiles.filter(file => {
    const sourcePath = path.join(ROOT, file);
    const builtPath = path.join(ROOT, 'dist', file);
    if (!fs.existsSync(sourcePath) || !fs.existsSync(builtPath)) return false;
    const source = fs.readFileSync(sourcePath);
    const built = fs.readFileSync(builtPath);
    return !source.equals(built);
  });
  assertPass(mismatchedDistFiles.length === 0,
    `dist 非注入文件与源码逐字一致${mismatchedDistFiles.length ? `（不一致 ${mismatchedDistFiles.join(', ')}）` : ''}`);

  const distPopupSource = fs.readFileSync(path.join(ROOT, 'dist', 'popup.js'), 'utf8');
  const distBackgroundSource = fs.readFileSync(path.join(ROOT, 'dist', 'background.js'), 'utf8');
  const distContentSource = fs.readFileSync(path.join(ROOT, 'dist', 'content.js'), 'utf8');
  const distPageConfirmSource = fs.readFileSync(path.join(ROOT, 'dist', 'page-confirm.js'), 'utf8');
  const sourceBackgroundForBuild = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const sourceContentForBuild = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const sourcePageConfirmForBuild = fs.readFileSync(path.join(ROOT, 'page-confirm.js'), 'utf8');
  const distBuildTime = distPopupSource.match(/const BUILD_TIME = '([^']+)'/)?.[1];
  const distBuildEpoch = Number(
    distPopupSource.match(/const BUILD_TIME_EPOCH_MS = (\d+);/)?.[1]
  );
  const distBackgroundBuildTime = distBackgroundSource
    .match(/const BUILD_TIME = '([^']+)'/)?.[1];
  const distBackgroundBuildEpoch = Number(
    distBackgroundSource.match(/const BUILD_TIME_EPOCH_MS = (\d+);/)?.[1]
  );
  const distContentBuildTime = distContentSource
    .match(/const CONTENT_BUILD_TIME = '([^']+)'/)?.[1];
  const distContentBuildEpoch = Number(
    distContentSource.match(/const CONTENT_BUILD_TIME_EPOCH_MS = (\d+);/)?.[1]
  );
  const distPageBuildTime = distPageConfirmSource
    .match(/const PAGE_BUILD_TIME = '([^']+)'/)?.[1];
  const distPageBuildEpoch = Number(
    distPageConfirmSource.match(/const PAGE_BUILD_TIME_EPOCH_MS = (\d+);/)?.[1]
  );
  const normalizedDistBackgroundSource = distBackgroundSource
    .replace(/const BUILD_TIME = '[^']*'/, "const BUILD_TIME = 'dev'")
    .replace(/const BUILD_TIME_EPOCH_MS = \d+;/, 'const BUILD_TIME_EPOCH_MS = 0;');
  const normalizedDistContentSource = distContentSource
    .replace(/const CONTENT_BUILD_TIME = '[^']*';/, "const CONTENT_BUILD_TIME = 'dev';")
    .replace(/const CONTENT_BUILD_TIME_EPOCH_MS = \d+;/, 'const CONTENT_BUILD_TIME_EPOCH_MS = 0;');
  const normalizedDistPageConfirmSource = distPageConfirmSource
    .replace(/const PAGE_BUILD_TIME = '[^']*';/, "const PAGE_BUILD_TIME = 'dev';")
    .replace(/const PAGE_BUILD_TIME_EPOCH_MS = \d+;/, 'const PAGE_BUILD_TIME_EPOCH_MS = 0;');
  const buildEpochDate = new Date(distBuildEpoch);
  const expectedDistBuildTime = Number.isSafeInteger(distBuildEpoch)
    ? `${buildEpochDate.getFullYear()}-${String(buildEpochDate.getMonth() + 1).padStart(2, '0')}-${String(buildEpochDate.getDate()).padStart(2, '0')}`
      + ` ${String(buildEpochDate.getHours()).padStart(2, '0')}:${String(buildEpochDate.getMinutes()).padStart(2, '0')}:${String(buildEpochDate.getSeconds()).padStart(2, '0')}`
    : '';
  assertPass(distPopupSource.includes(`const APP_VERSION = '${manifest.version}'`)
      && !!distBuildTime && distBuildTime !== 'dev',
    'dist/popup.js 已注入版本号和非 dev 构建时间');
  assertPass(Number.isSafeInteger(distBuildEpoch)
      && distBuildEpoch > 0
      && distBuildTime === expectedDistBuildTime
      && distBackgroundBuildTime === distBuildTime
      && distBackgroundBuildEpoch === distBuildEpoch
      && distContentBuildTime === distBuildTime
      && distContentBuildEpoch === distBuildEpoch
      && distPageBuildTime === distBuildTime
      && distPageBuildEpoch === distBuildEpoch
      && normalizedDistBackgroundSource === sourceBackgroundForBuild
      && normalizedDistContentSource === sourceContentForBuild
      && normalizedDistPageConfirmSource === sourcePageConfirmForBuild
      && popupJs.includes('const BUILD_TIME_EPOCH_MS = 0;')
      && sourceBackgroundForBuild.includes('const BUILD_TIME_EPOCH_MS = 0;')
      && sourceContentForBuild.includes('const CONTENT_BUILD_TIME_EPOCH_MS = 0;')
      && sourcePageConfirmForBuild.includes('const PAGE_BUILD_TIME_EPOCH_MS = 0;'),
    'build: Popup/SW/content/main 注入同一身份；四份运行时代码除占位外与源码逐字一致');
  const buildScriptSource = fs.readFileSync(path.join(ROOT, 'build.sh'), 'utf8');
  assertPass(sourceContentForBuild.includes("const CONTENT_BUILD_TIME = 'dev';")
      && sourceContentForBuild.includes('const CONTENT_BUILD_TIME_EPOCH_MS = 0;')
      && sourcePageConfirmForBuild.includes("const PAGE_BUILD_TIME = 'dev';")
      && sourcePageConfirmForBuild.includes('const PAGE_BUILD_TIME_EPOCH_MS = 0;')
      && buildScriptSource.includes('"$DIST/content.js"')
      && buildScriptSource.includes('"$DIST/page-confirm.js"')
      && buildScriptSource.includes('Could not inject the shared runtime build identity'),
    'build: 同一构建身份同时注入 Popup/SW/content/main，避免长寿命页面混版假绿');
  assertPass(sourceContentForBuild.includes('function attachContentRuntimeIdentity(')
      && sourceContentForBuild.includes('function requestMainWorldRuntimeIdentity(')
      && sourceContentForBuild.includes('runtimeIdentity: {')
      && sourcePageConfirmForBuild.includes('window.__AC_EXTENSION_MAIN_BRIDGE__')
      && sourcePageConfirmForBuild.includes('legacyBridgeIsolated')
      && sourcePageConfirmForBuild.includes('function getMainRuntimeIdentity()')
      && sourcePageConfirmForBuild.includes('MAIN_BRIDGE_CHANNEL')
      && sourceContentForBuild.includes('MAIN_BRIDGE_CHANNEL'),
    'runtime: content/main 使用同 build 的版本化桥和可替换监听器；旧主世界 handler 被频道隔离');
  assertPass(fs.existsSync(path.join(ROOT, 'releases', `ac-ust-v${manifest.version}.zip`)),
    `商店 ZIP 已生成: ac-ust-v${manifest.version}.zip`);

  // ===== 用例 5i: 页面冷气余额解析与 PWM 可用时间估算 =====
  const { parseBalanceMinutes, estimateBalanceExhaustion, isBalanceEstimateUrgent } = billingHelpers;
  assertPass(parseBalanceMinutes('242 min') === 242
      && parseBalanceMinutes('', '241 min') === 241
      && parseBalanceMinutes('12.5 minutes') === 12.5,
    '5i: 余额解析支持页面文本、title 回退与小数分钟');
  assertPass(parseBalanceMinutes('left of 16100 min balance') === null
      && parseBalanceMinutes('unknown') === null,
    '5i: 余额解析拒绝周期总额和无关文本，避免误报当前余额');
  const estimateNow = new Date(2026, 7, 2, 10, 30, 0, 0).getTime();
  const balanceEstimate = estimateBalanceExhaustion({
    balanceMinutes: 60,
    onMinutes: 15,
    offMinutes: 45,
    now: estimateNow
  });
  assertPass(balanceEstimate?.dutyCycle === 0.25
      && balanceEstimate?.usableWallMinutes === 240
      && balanceEstimate?.estimatedAt === estimateNow + 240 * 60000,
    '5i: 余额按 PWM 占空比折算为墙钟可用时间');
  assertPass(balanceEstimate?.displayAt === new Date(2026, 7, 2, 14, 30, 0, 0).getTime()
      && estimateBalanceExhaustion({ balanceMinutes: 60, onMinutes: 0, offMinutes: 45 }) === null,
    '5i: 估算展示到分钟，并拒绝无效 PWM 配置');
  assertPass(isBalanceEstimateUrgent(0)
      && isBalanceEstimateUrgent(1440)
      && !isBalanceEstimateUrgent(1440.01)
      && !isBalanceEstimateUrgent(-1)
      && !isBalanceEstimateUrgent('unknown'),
    '5i: 预计墙钟可用时间不超过24小时才触发余额提醒');

  // ===== 用例 6: v0.5.6 sync-helpers 跨设备同步纯函数 =====
  beginSuite('用例 6：跨设备同步纯函数',
    '\n\n=== 用例 6: sync-helpers 跨设备同步纯函数 (v0.5.6) ===\n');

  const {
    composeSyncPayload,
    computePhaseAdoption,
    computeConfigDiff,
    protectSmartOnRetryConfigDiff,
    parsePageTimerValue,
    isPageTimerProofFresh,
    computePageTimerAdoption
  } = syncHelpers;

  const futureTime = Date.now() + 30 * 60 * 1000;  // 30 分钟后
  const pastTime = Date.now() - 5 * 60 * 1000;       // 5 分钟前
  const baseSchedule = {
    enabled: true,
    onMinutes: 30,
    offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'off',
    nextTriggerAt: futureTime,
    smartClockPlannedAt: futureTime - 20 * 60_000,
    smartOnBoundaryAt: futureTime - 30 * 60_000
  };

  // 6A: composeSyncPayload 未来 nextTriggerAt 原样保留 + 含 syncedAt
  const payload1 = composeSyncPayload(baseSchedule, /* now */ 1700000000000);
  assertPass(payload1.enabled === true, '6A: composeSyncPayload enabled 转译');
  assertPass(payload1.nextTriggerAt === futureTime, '6A: composeSyncPayload 未来 nextTriggerAt 原样保留');
  assertPass(payload1.syncedAt === 1700000000000, '6A: composeSyncPayload syncedAt 戳记正确');
  assertPass(payload1.pwmState === 'off' && payload1.onMinutes === 30
      && payload1.smartClockPlannedAt === baseSchedule.smartClockPlannedAt
      && !Object.hasOwn(payload1, 'smartOnBoundaryAt'),
    '6A: composeSyncPayload 共享字段与 immutable clock origin 转译，排除本机智能 ON 锚点');

  // 6B: activeHours 必须是深拷贝（修改 payload 不能污染源 schedule）
  payload1.activeHours.enabled = true;
  payload1.activeHours.start = '00:00';
  assertPass(baseSchedule.activeHours.enabled === false && baseSchedule.activeHours.start === '08:00',
    '6B: composeSyncPayload activeHours 深拷贝（改 payload 不污染源）');

  // 6C: 过去 nextTriggerAt 推 0（让对端识别相位未定，避免错误对齐到过去）
  const schedulePast = { ...baseSchedule, nextTriggerAt: pastTime };
  const payload2 = composeSyncPayload(schedulePast, Date.now());
  assertPass(payload2.nextTriggerAt === 0, '6C: composeSyncPayload 过去 nextTriggerAt 推 0');

  // 6D: computePhaseAdoption 自回环抑制——相同 syncedAt 不采纳
  const remoteT1 = { syncedAt: 1000, nextTriggerAt: futureTime, pwmState: 'off' };
  const localNoTrigger = { ...baseSchedule, nextTriggerAt: 0 };
  assertPass(computePhaseAdoption(localNoTrigger, remoteT1, { now: Date.now(), lastSyncedAt: 1000 }) === null,
    '6D: computePhaseAdoption 相同 syncedAt 自回环 → null');
  assertPass(computePhaseAdoption(localNoTrigger, remoteT1, { now: Date.now(), lastSyncedAt: 2000 }) === null,
    '6D: computePhaseAdoption lastSyncedAt > remote.syncedAt 自回环 → null');

  // 6E: 本地无未来触发 → 采纳远端
  const adoptResultE = computePhaseAdoption(localNoTrigger, remoteT1, { now: Date.now(), lastSyncedAt: 0 });
  assertPass(adoptResultE !== null, '6E: 本地无未来触发 → 采纳远端');
  assertPass(adoptResultE && adoptResultE.pwmState === 'off' && adoptResultE.nextTriggerAt === futureTime,
    '6E: 采纳的相位字段正确');

  // 6F: 陈旧远端触发（在 now - staleMs 之前）→ 跳过相位
  const staleRemote = { syncedAt: 1000, nextTriggerAt: Date.now() - 90 * 1000, pwmState: 'off' };  // 90s 前
  assertPass(computePhaseAdoption(localNoTrigger, staleRemote, { now: Date.now(), lastSyncedAt: 0 }) === null,
    '6F: computePhaseAdoption 陈旧远端触发 → null（不把闹钟调度到过去）');

  // 6G: 容忍窗内偏差 (< 10s) → 跳过（A1 幂等预检兜底）
  const localWithin = { ...baseSchedule, nextTriggerAt: futureTime + 5_000 };  // 5s 偏差
  const remoteWithin = { syncedAt: 1000, nextTriggerAt: futureTime, pwmState: 'off' };
  assertPass(computePhaseAdoption(localWithin, remoteWithin, { now: Date.now(), lastSyncedAt: 0, toleranceMs: 10_000, staleMs: 60_000 }) === null,
    '6G: 5s 偏差在容忍窗内 → 跳过（避免时钟微抖动反复重调闹钟）');
  const oppositeActionSameClock = computePhaseAdoption(
    { ...localWithin, pwmState: 'on', nextTriggerAt: futureTime },
    { ...remoteWithin, pwmState: 'off' },
    { now: Date.now(), lastSyncedAt: 0, toleranceMs: 10_000, staleMs: 60_000 }
  );
  const metadataOnlyOrigin = computePhaseAdoption(
    {
      ...localWithin,
      pwmState: 'on',
      nextTriggerAt: futureTime,
      smartClockPlannedAt: 0,
      alarmCreatedAt: 0
    },
    {
      syncedAt: 1001,
      pwmState: 'on',
      nextTriggerAt: futureTime,
      smartClockPlannedAt: futureTime - 10 * 60_000
    },
    { now: Date.now(), lastSyncedAt: 0, toleranceMs: 10_000, staleMs: 60_000 }
  );
  assertPass(oppositeActionSameClock?.pwmState === 'off'
      && oppositeActionSameClock.nextTriggerAt === futureTime
      && metadataOnlyOrigin?.metadataOnly === true
      && metadataOnlyOrigin.smartClockPlannedAt === futureTime - 10 * 60_000,
    '6G-1: 同时戳不同动作必须采纳 OFF 安全哨兵；同时戳同动作仍补全 immutable origin');

  // 6H: 偏差超出容忍窗 (> 10s) → 采纳
  const localDistant = { ...baseSchedule, nextTriggerAt: futureTime + 90 * 1000 };  // 90s 偏差
  const remoteFuture = { syncedAt: 1000, nextTriggerAt: futureTime, pwmState: 'off' };
  const adoptH = computePhaseAdoption(localDistant, remoteFuture, { now: Date.now(), lastSyncedAt: 0, toleranceMs: 10_000, staleMs: 60_000 });
  assertPass(adoptH !== null && adoptH.nextTriggerAt === futureTime,
    '6H: 90s 偏差超容忍窗 → 采纳远端');

  const offSafetyNow6 = Date.now();
  const localEarlierOff6 = {
    ...baseSchedule,
    pwmState: 'off',
    nextTriggerAt: offSafetyNow6 + 30_000
  };
  const remoteLaterOff6 = {
    syncedAt: offSafetyNow6 + 1,
    pwmState: 'off',
    nextTriggerAt: offSafetyNow6 + 60_000
  };
  const remoteEarlierOff6 = {
    ...remoteLaterOff6,
    nextTriggerAt: offSafetyNow6 + 10_000
  };
  assertPass(computePhaseAdoption(
    localEarlierOff6,
    remoteLaterOff6,
    { now: offSafetyNow6, lastSyncedAt: 0 }
  ) === null
      && computePhaseAdoption(
        localEarlierOff6,
        remoteEarlierOff6,
        { now: offSafetyNow6, lastSyncedAt: 0 }
      )?.nextTriggerAt === remoteEarlierOff6.nextTriggerAt,
    '6H-1: 同为 OFF 时只采纳更早截止，远端较晚 OFF 绝不延后本机安全钟');

  // 6I: 远端 nextTriggerAt=0 → 无相位信息 → null
  const remoteNoTrigger = { syncedAt: 1000, nextTriggerAt: 0, pwmState: 'off' };
  assertPass(computePhaseAdoption(localDistant, remoteNoTrigger, { now: Date.now(), lastSyncedAt: 0 }) === null,
    '6I: 远端 nextTriggerAt=0 → null（同步无相位）');

  const currentBackgroundSource6 = fs.readFileSync(
    path.join(ROOT, 'background.js'),
    'utf8'
  );
  const syncWatermarkSource6 = extractSourceSection(
    currentBackgroundSource6,
    'async function loadSyncWatermark() {',
    '\n// 把当前内存 schedule 瘦化后写入 chrome.storage.sync。',
    'durable sync watermark helpers'
  );
  const syncPendingSource6 = extractSourceSection(
    currentBackgroundSource6,
    'async function setSyncPublishPending(pending) {',
    '\nasync function loadSyncWatermark() {',
    'durable sync pending/retry helpers'
  );
  const syncScheduleSource6 = extractSourceSection(
    currentBackgroundSource6,
    "async function syncScheduleToSync(reason = '') {",
    '\n\n// 把远端 sync 对象合并到本地 schedule',
    'outbound smart exception sentinel'
  );
  const tryAdoptSource6 = extractSourceSection(
    currentBackgroundSource6,
    "async function tryAdoptSyncedState(reason = '', explicitRemote = null) {",
    '\n\n// ----- v0.5.10: 页面定时器作为跨设备主同步通道 -----',
    'inbound/outbound sync coordinator'
  );
  const explicitDisableClaimSource6 = extractSourceSection(
    currentBackgroundSource6,
    'function preemptAutomaticOnForExplicitDisable() {',
    '\n\nasync function finishExplicitDisablePreemption() {',
    'explicit disable synchronous admission claim'
  );
  const runOutboundSync6 = async syncSchedule => {
    const writes = [];
    const sync = new Function(
      'schedule', 'chrome', 'composeSyncPayload', 'nextHalfHourBoundary',
      'appendDiagnosticLog', 'Date', 'console',
      `const SYNC_KEY = 'ac_schedule_sync_test';
      let lastSyncedAt = 0;
      let syncWriteChain = Promise.resolve();
      let syncPublishGeneration = 0;
      let syncWriteOperationsInFlight = 0;
      const _syncOpLock = {
        busy: false,
        pending: false,
        pendingReason: '',
        pendingRemote: null,
        pendingOutbound: false,
        pendingOutboundReason: ''
      };
      async function loadSyncWatermark() { return lastSyncedAt; }
      async function persistSyncWatermark(value) {
        lastSyncedAt = Math.max(lastSyncedAt, Number(value) || 0);
        return true;
      }
      async function setSyncPublishPending() { return true; }
      async function scheduleSyncRetry() { return true; }
      ${syncScheduleSource6}; return syncScheduleToSync;`
    )(
      syncSchedule,
      {
        storage: { sync: { async set(value) { writes.push(value); } } },
        alarms: { async clear() { return true; } }
      },
      composeSyncPayload,
      pwmPhase.nextHalfHourBoundary,
      () => {},
      Date,
      testConsole
    );
    await sync('sentinel-test');
    return writes[0]?.ac_schedule_sync_test;
  };
  const exceptionSyncAt6 = pwmPhase.nextHalfHourBoundary(Date.now()) + 60_000;
  const exceptionSentinelAt6 = pwmPhase.nextHalfHourBoundary(exceptionSyncAt6);
  const exceptionPayload6 = await runOutboundSync6({
    ...baseSchedule,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmState: 'on',
    nextTriggerAt: exceptionSyncAt6,
    pwmRetryKind: 'smart-on-safe-delay'
  });
  const safetyTimerPayload6 = await runOutboundSync6({
    ...baseSchedule,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmState: 'on',
    nextTriggerAt: Date.now() + 60_000,
    pwmRetryKind: 'smart-on-safety-timer'
  });
  const normalSyncAt6 = Date.now() + 20 * 60_000;
  const normalPayload6 = await runOutboundSync6({
    ...baseSchedule,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmState: 'on',
    nextTriggerAt: normalSyncAt6,
    pwmRetryKind: ''
  });
  assertPass(exceptionPayload6.enabled === true
      && exceptionPayload6.pwmState === 'off'
      && exceptionPayload6.nextTriggerAt === exceptionSentinelAt6
      && !Object.hasOwn(exceptionPayload6, 'phaseWithheld')
      && safetyTimerPayload6.enabled === true
      && safetyTimerPayload6.pwmState === 'off'
      && safetyTimerPayload6.nextTriggerAt > Date.now()
      && normalPayload6.pwmState === 'on'
      && normalPayload6.nextTriggerAt === normalSyncAt6,
    '6I-1: actual outbound sync 把未开机 exception 投影为 OFF 哨兵；timer-only repair 发明确近期 OFF；普通 phase 原样同步');

  const loadActualSyncProtocol6 = (options = {}) => {
    const scheduleState = options.schedule || {
      ...baseSchedule,
      enabled: false,
      smartMode: { enabled: false, sensitivity: 5 },
      nextTriggerAt: 0
    };
    const state = {
      durableWatermark: Number(options.initialWatermark) || 0,
      wallNow: Number(options.wallNow) || 1000,
      incrementWall: options.incrementWall === true,
      watermarkGetsRemaining: Number(options.watermarkGetFailures) || 0,
      localWrites: [],
      syncAttempts: [],
      syncWrites: [],
      activeSyncSets: 0,
      maxActiveSyncSets: 0,
      pendingPublish: options.initialPendingPublish === true,
      alarms: new Map(),
      syncStore: null,
      localSchedule: null,
      disableIntentWrites: []
    };
    const chrome = {
      storage: {
        local: {
          async get(key) {
            if (key === 'ac_schedule_sync_publish_pending') {
              return { [key]: state.pendingPublish };
            }
            if (state.watermarkGetsRemaining > 0) {
              state.watermarkGetsRemaining -= 1;
              throw new Error('transient watermark read');
            }
            return { [key]: state.durableWatermark };
          },
          async set(value) {
            if (Object.hasOwn(value, 'ac_schedule_sync_publish_pending')) {
              state.pendingPublish = value.ac_schedule_sync_publish_pending === true;
              if (value.ac_schedule_test) {
                state.localSchedule = structuredClone(value.ac_schedule_test);
                state.disableIntentWrites.push({
                  enabled: value.ac_schedule_test.enabled,
                  pending: value.ac_schedule_sync_publish_pending === true
                });
              }
              return;
            }
            const next = Number(value.ac_schedule_sync_watermark) || 0;
            state.localWrites.push(next);
            state.durableWatermark = next;
          },
          async remove(key) {
            if (key === 'ac_schedule_sync_publish_pending') {
              state.pendingPublish = false;
            }
          }
        },
        sync: {
          async get(key) {
            const physical = options.syncReadOverride
              ? structuredClone(options.syncReadOverride)
              : state.syncStore;
            if (physical) state.syncStore = physical;
            return physical ? { [key]: physical } : {};
          },
          async set(value) {
            const payload = structuredClone(value.ac_schedule_sync_test);
            state.syncAttempts.push(payload);
            state.activeSyncSets += 1;
            state.maxActiveSyncSets = Math.max(
              state.maxActiveSyncSets,
              state.activeSyncSets
            );
            try {
              if (options.firstSyncGate && state.syncAttempts.length === 1) {
                await options.firstSyncGate;
              }
              if (options.failSyncSet === true) {
                throw new Error('synthetic sync.set failure');
              }
              state.syncWrites.push(payload);
              state.syncStore = payload;
            } finally {
              state.activeSyncSets -= 1;
            }
          }
        }
      },
      alarms: {
        async create(name, info) { state.alarms.set(name, { name, ...info }); },
        async clear(name) { return state.alarms.delete(name); },
        async get(name) { return state.alarms.get(name); }
      }
    };
    class SyncHarnessDate extends Date {
      static now() {
        const value = state.wallNow;
        if (state.incrementWall) state.wallNow += 1;
        return value;
      }
    }
    const actual = new Function(
      'schedule', 'chrome', 'composeSyncPayload', 'nextHalfHourBoundary',
      'appendDiagnosticLog', 'Date', 'console', 'applySyncedPhase',
      `const SYNC_KEY = 'ac_schedule_sync_test';
      const SYNC_WATERMARK_KEY = 'ac_schedule_sync_watermark';
      const SYNC_PENDING_PUBLISH_KEY = 'ac_schedule_sync_publish_pending';
      let lastSyncedAt = 0;
      let syncWatermarkLoaded = false;
      let syncWriteChain = Promise.resolve();
      let syncWatermarkWriteChain = Promise.resolve();
      let syncPublishGeneration = 0;
      let syncWriteOperationsInFlight = 0;
      let automaticDisableAdmissionEpoch = 0;
      let automaticOnAdmissionBlocked = false;
      let pwmRuntimeRevision = 1;
      const _syncOpLock = {
        busy: false,
        pending: false,
        pendingReason: '',
        pendingRemote: null,
        pendingOutbound: false,
        pendingOutboundReason: ''
      };
      async function createAlarm(name, info) {
        await chrome.alarms.create(name, info);
        return true;
      }
      function invalidateTimerBasedShutdown() {}
      function drainDeferredScheduleRepair() { return false; }
      ${explicitDisableClaimSource6}
      async function commitExplicitDisableIntentForTest() {
        const admissionEpoch = preemptAutomaticOnForExplicitDisable();
        schedule.enabled = false;
        await chrome.storage.local.set({
          ac_schedule_test: { ...schedule },
          [SYNC_PENDING_PUBLISH_KEY]: true
        });
        await scheduleSyncRetry('publish');
        return admissionEpoch;
      }
      function runSerializedScheduleUpdate(operation) { return operation(); }
      ${syncPendingSource6}
      ${syncWatermarkSource6}
      ${syncScheduleSource6}
      ${tryAdoptSource6}
      return {
        sync: syncScheduleToSync,
        adopt: tryAdoptSyncedState,
        disable: commitExplicitDisableIntentForTest,
        load: loadSyncWatermark,
        persist: persistSyncWatermark,
        last: () => lastSyncedAt,
        loaded: () => syncWatermarkLoaded
      };`
    )(
      scheduleState,
      chrome,
      composeSyncPayload,
      pwmPhase.nextHalfHourBoundary,
      () => {},
      SyncHarnessDate,
      testConsole,
      options.applySyncedPhase || (async () => false)
    );
    return { ...actual, state, schedule: scheduleState };
  };

  // sync.set 失败不得声称新版本已发布；原 remote disable 仍可在重启后采纳。
  const failedPublish6 = loadActualSyncProtocol6({
    initialWatermark: 500,
    wallNow: 1000,
    failSyncSet: true
  });
  await failedPublish6.sync();
  // 快时钟对端的已知水位高于本机墙钟时，本地停用仍必须更新。
  const skewedDisable6 = loadActualSyncProtocol6({
    initialWatermark: 5000,
    wallNow: 1000,
    schedule: {
      ...baseSchedule,
      enabled: false,
      smartMode: { enabled: false, sensitivity: 5 },
      nextTriggerAt: 0
    }
  });
  await skewedDisable6.sync();
  // 两个并发外发请求必须 FIFO，watermark 也必须单调。
  let releaseFirstSync6;
  const firstSyncGate6 = new Promise(resolve => { releaseFirstSync6 = resolve; });
  const serializedPublish6 = loadActualSyncProtocol6({
    wallNow: 2000,
    incrementWall: true,
    firstSyncGate: firstSyncGate6
  });
  const firstPublish6 = serializedPublish6.sync();
  while (serializedPublish6.state.syncAttempts.length === 0) {
    await Promise.resolve();
  }
  const secondPublish6 = serializedPublish6.sync();
  await new Promise(resolve => setTimeout(resolve, 0));
  const secondQueuedBehindFirst6 = serializedPublish6.state.syncAttempts.length === 1;
  releaseFirstSync6();
  await Promise.all([firstPublish6, secondPublish6]);
  const monotonicWatermark6 = loadActualSyncProtocol6();
  await Promise.all([
    monotonicWatermark6.persist(20),
    monotonicWatermark6.persist(10)
  ]);
  assertPass(failedPublish6.state.syncAttempts.length === 1
      && failedPublish6.state.syncWrites.length === 0
      && failedPublish6.state.localWrites.length === 0
      && failedPublish6.last() === 500
      && skewedDisable6.state.syncWrites[0]?.enabled === false
      && skewedDisable6.state.syncWrites[0]?.syncedAt === 5001
      && skewedDisable6.state.durableWatermark === 5001
      && secondQueuedBehindFirst6
      && serializedPublish6.state.maxActiveSyncSets === 1
      && serializedPublish6.state.syncWrites.map(item => item.syncedAt).join(',')
        === '2000,2001'
      && serializedPublish6.state.localWrites.join(',') === '2000,2001'
      && monotonicWatermark6.state.localWrites.join(',') === '20,20'
      && monotonicWatermark6.last() === 20,
    '6I-2: actual sync 失败不越水位；Lamport 版本跨快时钟；并发外发与 durable watermark 均单调串行');

  // 两次 watermark read 都失败时，单次用户停用也必须留下 durable
  // publish intent；一分钟 alarm 直接重放当前状态，不要求用户再点一次。
  const durablePublishRetry6 = loadActualSyncProtocol6({
    wallNow: 3000,
    watermarkGetFailures: 2,
    schedule: {
      ...baseSchedule,
      enabled: false,
      smartMode: { enabled: false, sensitivity: 5 },
      nextTriggerAt: 0
    }
  });
  const firstDurablePublish6 = await durablePublishRetry6.sync(
    'explicit-disable-watermark-failure'
  );
  const durableIntentAfterFailure6 = durablePublishRetry6.state.pendingPublish === true
    && durablePublishRetry6.state.alarms.has('ac-sync-publish-retry')
    && durablePublishRetry6.state.syncWrites.length === 0;
  const retriedDurablePublish6 = await durablePublishRetry6.sync(
    'alarm-sync-publish-retry'
  );
  assertPass(firstDurablePublish6 === false
      && durableIntentAfterFailure6
      && retriedDurablePublish6 === true
      && durablePublishRetry6.state.syncWrites.length === 1
      && durablePublishRetry6.state.syncWrites[0].enabled === false
      && durablePublishRetry6.state.pendingPublish === false
      && !durablePublishRetry6.state.alarms.has('ac-sync-publish-retry')
      && durablePublishRetry6.state.durableWatermark
        === durablePublishRetry6.state.syncWrites[0].syncedAt,
    '6I-3: outbound 连续 watermark 读取失败留下 durable pending + retry alarm；alarm 重放显式停用并清凭证');

  // 旧 outbound 已登记后收到 explicit disable：入站先等旧物理写完成，
  // 再停用并重发当前 schedule，最终 sync store 不能停在旧 enabled=true。
  let releaseOldOutbound6;
  const oldOutboundGate6 = new Promise(resolve => { releaseOldOutbound6 = resolve; });
  const overlapSchedule6 = {
    ...baseSchedule,
    enabled: true,
    smartMode: { enabled: false, sensitivity: 5 },
    pwmState: 'on',
    nextTriggerAt: Date.now() + 5 * 60_000
  };
  const overlapApplyCalls6 = [];
  const physicalRemoteDisable6 = {
    ...baseSchedule,
    enabled: false,
    smartMode: { enabled: false, sensitivity: 5 },
    pwmState: 'off',
    nextTriggerAt: 0,
    syncedAt: 5000
  };
  const syncOverlap6 = loadActualSyncProtocol6({
    wallNow: 10_000,
    incrementWall: true,
    firstSyncGate: oldOutboundGate6,
    syncReadOverride: physicalRemoteDisable6,
    schedule: overlapSchedule6,
    applySyncedPhase: async remote => {
      overlapApplyCalls6.push(remote.enabled);
      overlapSchedule6.enabled = remote.enabled;
      overlapSchedule6.pwmState = remote.pwmState;
      overlapSchedule6.nextTriggerAt = remote.nextTriggerAt;
      return true;
    }
  });
  const oldOutbound6 = syncOverlap6.sync('old-local-enable');
  while (syncOverlap6.state.syncAttempts.length === 0) {
    await Promise.resolve();
  }
  const overlappingDisable6 = syncOverlap6.adopt(
    'explicit-remote-disable-during-outbound',
    physicalRemoteDisable6
  );
  await Promise.resolve();
  const disableWaitedForOldOutbound6 = overlapApplyCalls6.length === 0
    && syncOverlap6.state.syncWrites.length === 0;
  releaseOldOutbound6();
  const [oldOutboundResult6, overlappingDisableResult6] = await Promise.all([
    oldOutbound6,
    overlappingDisable6
  ]);
  assertPass(disableWaitedForOldOutbound6
      && oldOutboundResult6 === true
      && overlappingDisableResult6 === true
      && overlapApplyCalls6.join(',') === 'false'
      && syncOverlap6.state.syncWrites.map(item => item.enabled).join(',')
        === 'true'
      && syncOverlap6.state.syncStore.enabled === overlapSchedule6.enabled
      && syncOverlap6.state.syncStore.pwmState === overlapSchedule6.pwmState
      && syncOverlap6.state.syncStore.nextTriggerAt
        === overlapSchedule6.nextTriggerAt
      && syncOverlap6.state.maxActiveSyncSets === 1,
    '6I-4: actual outbound/inbound overlap 先落旧写，barrier 后重读物理终态并采纳 disable；sync store 与当前 schedule 一致');

  // outbound 已经捕获 enabled=true payload 后，明确停用的同步 claim 必须
  // 让旧 generation 失去清理 marker/alarm 的资格；alarm 重试再发布 false。
  let releaseCapturedEnable6;
  const capturedEnableGate6 = new Promise(resolve => {
    releaseCapturedEnable6 = resolve;
  });
  const capturedEnableSchedule6 = {
    ...baseSchedule,
    enabled: true,
    smartMode: { enabled: false, sensitivity: 5 },
    pwmState: 'on',
    nextTriggerAt: Date.now() + 5 * 60_000
  };
  const capturedEnableRace6 = loadActualSyncProtocol6({
    wallNow: 20_000,
    incrementWall: true,
    firstSyncGate: capturedEnableGate6,
    schedule: capturedEnableSchedule6
  });
  const capturedOldPublish6 = capturedEnableRace6.sync('captured-old-enable');
  while (capturedEnableRace6.state.syncAttempts.length === 0) {
    await Promise.resolve();
  }
  const disableClaimEpoch6 = await capturedEnableRace6.disable();
  const durableDisableBeforeOldRelease6 = capturedEnableRace6.state.pendingPublish === true
    && capturedEnableRace6.state.alarms.has('ac-sync-publish-retry')
    && capturedEnableRace6.state.disableIntentWrites.at(-1)?.enabled === false
    && capturedEnableRace6.state.disableIntentWrites.at(-1)?.pending === true;
  releaseCapturedEnable6();
  const capturedOldPublishResult6 = await capturedOldPublish6;
  const oldCompletionPreservedDisableIntent6 = capturedEnableRace6.state.pendingPublish === true
    && capturedEnableRace6.state.alarms.has('ac-sync-publish-retry');
  const disableRetryPublishResult6 = await capturedEnableRace6.sync(
    'alarm-sync-publish-retry-after-old-enable'
  );
  assertPass(disableClaimEpoch6 === 1
      && durableDisableBeforeOldRelease6
      && capturedOldPublishResult6 === true
      && oldCompletionPreservedDisableIntent6
      && disableRetryPublishResult6 === true
      && capturedEnableRace6.state.syncWrites.map(item => item.enabled).join(',')
        === 'true,false'
      && capturedEnableRace6.state.syncStore.enabled === false
      && capturedEnableRace6.state.pendingPublish === false
      && !capturedEnableRace6.state.alarms.has('ac-sync-publish-retry'),
    '6I-5: 旧 enabled payload 完成不能清除后到 disable intent；generation 抢占后 alarm 最终发布 false');

  // 6J: computeConfigDiff 检测 onMinutes 变更
  const diffOn = computeConfigDiff(baseSchedule, { onMinutes: 45, offMinutes: 30, activeHours: baseSchedule.activeHours, enabled: true });
  assertPass(diffOn.changed === true && diffOn.fields.onMinutes === 45,
    '6J: computeConfigDiff onMinutes 30→45 被检测');
  const protectedRetryDiff = protectSmartOnRetryConfigDiff(computeConfigDiff(
    { ...baseSchedule, onMinutes: 21, offMinutes: 9 },
    {
      ...baseSchedule,
      onMinutes: 30,
      offMinutes: 30,
      smartMode: { enabled: true, sensitivity: 8 }
    }
  ), true);
  assertPass(protectedRetryDiff.changed === true
      && protectedRetryDiff.fields.onMinutes === undefined
      && protectedRetryDiff.fields.offMinutes === undefined
      && protectedRetryDiff.fields.smartMode?.sensitivity === 8,
    '6J-1: typed smart-on 重试冻结本地 21/9，但仍采纳远端灵敏度等非事务配置');
  const cancelledRetryDiffs = [
    protectSmartOnRetryConfigDiff(computeConfigDiff(
      { ...baseSchedule, onMinutes: 21, offMinutes: 9 },
      { ...baseSchedule, enabled: false, onMinutes: 30, offMinutes: 30 }
    ), false),
    protectSmartOnRetryConfigDiff(computeConfigDiff(
      { ...baseSchedule, onMinutes: 21, offMinutes: 9 },
      {
        ...baseSchedule,
        onMinutes: 30,
        offMinutes: 30,
        smartMode: { enabled: false, sensitivity: 8 }
      }
    ), false),
    protectSmartOnRetryConfigDiff(computeConfigDiff(
      { ...baseSchedule, onMinutes: 21, offMinutes: 9 },
      {
        ...baseSchedule,
        onMinutes: 30,
        offMinutes: 30,
        activeHours: { enabled: true, start: '00:00', end: '00:01' }
      }
    ), false)
  ];
  assertPass(cancelledRetryDiffs.every(diff => (
    diff.fields.onMinutes === 30 && diff.fields.offMinutes === 30
  )), '6J-2: 同快照停用、退出智能或进入暂停时段会取消事务，远端 30/30 不被误丢弃');

  // 6K: computeConfigDiff 检测 activeHours 深度变更
  const remoteActive = { ...baseSchedule, activeHours: { enabled: true, start: '09:00', end: '21:00' } };
  const diffAh = computeConfigDiff(baseSchedule, remoteActive);
  assertPass(diffAh.changed === true, '6K: computeConfigDiff activeHours 深度变更被检测');
  assertPass(diffAh.fields.activeHours && diffAh.fields.activeHours.start === '09:00' && diffAh.fields.activeHours.enabled === true,
    '6K: computeConfigDiff activeHours 字段值正确');

  // 6L: computeConfigDiff 字段全部一致 → changed=false
  const diffSame = computeConfigDiff(baseSchedule, { onMinutes: 30, offMinutes: 30, activeHours: baseSchedule.activeHours, enabled: true });
  assertPass(diffSame.changed === false, '6L: computeConfigDiff 字段一致 → changed=false');

  // 6M: chrome.storage.sync mock 自身可读写（同步链路 mock 完整性回归）
  const syncMock = createMockChrome(baseSchedule, futureTime);
  await syncMock.chrome.storage.sync.set({ ac_schedule_sync: composeSyncPayload(baseSchedule, Date.now()) });
  const syncRead = await syncMock.chrome.storage.sync.get('ac_schedule_sync');
  assertPass(!!syncRead.ac_schedule_sync && syncRead.ac_schedule_sync.enabled === true,
    '6M: mock chrome.storage.sync 可写入并回读（sync 区 mock 完整）');

  const proofNow = Date.now();
  assertPass(isPageTimerProofFresh({
    pageTimerMinutes: 30,
    pageTimerTargetAt: proofNow + 30 * 60 * 1000,
    pageTimerRetryAt: 0
  }, { now: proofNow }), '6N: 未来页面定时器证明有效');
  assertPass(isPageTimerProofFresh({
    pageTimerMinutes: 30,
    pageTimerTargetAt: proofNow - 60 * 1000,
    pageTimerRetryAt: 0
  }, { now: proofNow }), '6N: 90 秒宽限内的刚到期证明仍有效');
  assertPass(!isPageTimerProofFresh({
    pageTimerMinutes: 30,
    pageTimerTargetAt: proofNow - 5 * 60 * 1000,
    pageTimerRetryAt: 0
  }, { now: proofNow }), '6N: 数分钟前到期的页面定时器证明失效');
  assertPass(!isPageTimerProofFresh({
    pageTimerMinutes: 30,
    pageTimerTargetAt: 0,
    pageTimerRetryAt: 0
  }, { now: proofNow }), '6N: 旧版本缺少绝对到期时间的证明失效');
  assertPass(!isPageTimerProofFresh({
    pageTimerMinutes: 30,
    pageTimerTargetAt: proofNow + 30 * 60 * 1000,
    pageTimerRetryAt: proofNow + 60 * 1000
  }, { now: proofNow }), '6N: 等待跨日重试的证明不视为有效');

  // ===== 用例 7: v0.5.6 applySyncedPhase 编排路径（enabled 翻转核心修复） =====
  // 这个用例直接验证我修过的 bug：enabled 经 sync 翻转但无 nextTriggerAt 时，
  //   必须重建闹钟基础设施（ac-pwm/ac-watchdog/ac-badge-tick），否则设备 B 永远
  //   不会真正执行 PWM（伪 enabled=true 但无闹钟）。
  //   测试策略：复刻 background.js applySyncedPhase 的核心决策（与现有 case 1-4
  //   复刻 popup.js 诊断函数同模式），把对 setupAlarms/createAlarm/clear/page timer
  //   等编排调用记录到一个 calls 数组，断言三个场景的调用序列正确。
  beginSuite('用例 7：跨设备相位编排',
    '\n\n=== 用例 7: applySyncedPhase 编排路径 (enabled 翻转核心修复) ===\n');

  // 复刻 applySyncedPhase 决策核心——只保留决策 + 编排调用记录，省略 chrome.* 真实副作用
  function applySyncedPhase_testHarness(localSchedule, remote, mockCtx) {
    const schedule = { ...localSchedule, activeHours: { ...localSchedule.activeHours } };
    const calls = mockCtx.calls;
    const wasEnabled = schedule.enabled;

    // 1) config 采纳
    const cfg = computeConfigDiff(schedule, remote);
    let cfgChanged = false, activeHoursChanged = false;
    if (cfg.changed) {
      for (const [k, v] of Object.entries(cfg.fields)) {
        schedule[k] = v;
        if (k === 'activeHours') { activeHoursChanged = true; schedule.activeHours = { ...v }; }
      }
      cfgChanged = true;
    }
    const enabledChanged = cfg.fields.enabled !== undefined;
    const nowEnabled = schedule.enabled;

    // 2) 相位采纳
    const adopt = computePhaseAdoption(schedule, remote, { lastSyncedAt: mockCtx.lastSyncedAt, now: mockCtx.now });
    let phaseChanged = false;
    if (adopt) {
      const oldPwmState = schedule.pwmState;
      const oldTrigger = schedule.nextTriggerAt;
      schedule.pwmState = adopt.pwmState;
      schedule.nextTriggerAt = adopt.nextTriggerAt;
      phaseChanged = (oldPwmState !== schedule.pwmState || oldTrigger !== schedule.nextTriggerAt);
      if (phaseChanged && nowEnabled) {
        calls.push('clear-ac-pwm');
        const delayMs = adopt.nextTriggerAt - mockCtx.now;
        if (delayMs > 0) calls.push('create-ac-pwm-when');
        else calls.push('advanceExpiredAlarmToNextBoundary');
      }
    }

    // 3) 闹钟基础设施重建——只由 config 变更驱动（相位路径不管 watchdog/badge-tick）
    let didAlarmInfra = false;
    if (enabledChanged) {
      didAlarmInfra = true;
      if (nowEnabled) {
        if (phaseChanged) {
          calls.push('create-ac-watchdog');
          calls.push('create-ac-badge-tick');
        } else {
          calls.push('setupAlarms-startImmediately');
          calls.push('create-ac-watchdog');
        }
      } else {
        // true → false（与 background.js applySyncedPhase 实际编排一致）
        schedule.pwmState = 'off';
        schedule.nextTriggerAt = 0;
        schedule.alarmCreatedAt = 0;
        schedule.alarmDelayMinutes = 0;
        schedule.pageTimerMinutes = null;
        calls.push('clear-ac-pwm');
        calls.push('clear-ac-page-timer-retry');
        calls.push('clear-ac-badge-tick');
        calls.push('clear-ac-watchdog');
        calls.push('requestTimerBasedShutdown');
      }
    }
    if (activeHoursChanged || phaseChanged) calls.push('rescheduleActiveBoundary');
    if (cfgChanged || phaseChanged) calls.push('persistSchedule');

    return { schedule, calls, didAlarmInfra };
  }

  // 7A: false → true，远端带未来 nextTriggerAt → 相位路径建 ac-pwm + 闹钟基础设施补 watchdog/badge-tick
  const local7A = {
    enabled: false, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'off', nextTriggerAt: 0
  };
  const futureT7 = Date.now() + 30 * 60 * 1000;
  const remote7A = { enabled: true, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'on', nextTriggerAt: futureT7, syncedAt: 1000 };
  const r7A = applySyncedPhase_testHarness(local7A, remote7A, { now: Date.now(), calls: [], lastSyncedAt: 0 });
  verboseLog('  7A (false→true, 有相位) calls:', r7A.calls.join(','));
  assertPass(r7A.schedule.enabled === true, '7A: schedule.enabled 被采纳为 true');
  assertPass(r7A.schedule.nextTriggerAt === futureT7, '7A: nextTriggerAt 被采纳为远端相位');
  assertPass(r7A.calls.includes('create-ac-pwm-when'), '7A: 用绝对时间创建 ac-pwm (when)');
  assertPass(r7A.calls.includes('create-ac-watchdog'), '7A: 补建 ac-watchdog');
  assertPass(r7A.calls.includes('create-ac-badge-tick'), '7A: 补建 ac-badge-tick');
  assertPass(!r7A.calls.includes('setupAlarms-startImmediately'),
    '7A: 已有相位时不触发 setupAlarms(startImmediately)（避免覆盖已采纳的 ac-pwm）');

  // 7B: false → true，远端 enabled=true 但 nextTriggerAt=0（PWM 刚 enable 还没跑完第一步）
  //     → 必须本地 setupAlarms(true) 新起一轮（这就是修复的 bug）
  const remote7B = { enabled: true, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'on', nextTriggerAt: 0, syncedAt: 1000 };
  const r7B = applySyncedPhase_testHarness(local7A, remote7B, { now: Date.now(), calls: [], lastSyncedAt: 0 });
  verboseLog('  7B (false→true, 无相位) calls:', r7B.calls.join(','));
  assertPass(r7B.schedule.enabled === true, '7B: schedule.enabled 被采纳为 true');
  assertPass(r7B.calls.includes('setupAlarms-startImmediately'),
    '7B: 无相位的 enabled 翻为 true 必须调用 setupAlarms(true) 本地起新轮（核心修复）');
  assertPass(r7B.calls.includes('create-ac-watchdog'), '7B: 补建 ac-watchdog');
  assertPass(!r7B.calls.includes('create-ac-pwm-when'),
    '7B: 无相位不应预置 ac-pwm（由 setupAlarms→runPwmStep 完成）');

  // 7C: true → false → 必须清所有 PWM 闹钟 + 依靠页面定时器关机（不点击开关）
  const local7C = {
    enabled: true, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'on', nextTriggerAt: futureT7
  };
  const remote7C = { enabled: false, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'off', nextTriggerAt: futureT7, syncedAt: 1000 };
  const r7C = applySyncedPhase_testHarness(local7C, remote7C, { now: Date.now(), calls: [], lastSyncedAt: 0 });
  verboseLog('  7C (true→false) calls:', r7C.calls.join(','));
  assertPass(r7C.schedule.enabled === false, '7C: schedule.enabled 被采纳为 false');
  assertPass(r7C.calls.includes('clear-ac-pwm'), '7C: 清 ac-pwm');
  assertPass(r7C.calls.includes('clear-ac-watchdog'), '7C: 清 ac-watchdog');
  assertPass(r7C.calls.includes('clear-ac-badge-tick'), '7C: 清 ac-badge-tick');
  assertPass(r7C.calls.includes('requestTimerBasedShutdown'),
    '7C: 调用 requestTimerBasedShutdown（页面定时器关机，不点击开关）');
  assertPass(!r7C.calls.includes('toggleAC-off'), '7C: 不调用 toggleAC(off)');
  assertPass(r7C.schedule.pwmState === 'off' && r7C.schedule.nextTriggerAt === 0,
    '7C: schedule.pwmState/nextTriggerAt 被清零');

  // 7D: activeHours 变更（enabled 不变）→ 必须重排 ac-active-boundary
  const local7D = {
    enabled: true, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    pwmState: 'off', nextTriggerAt: futureT7
  };
  const remote7D = { enabled: true, onMinutes: 30, offMinutes: 30,
    activeHours: { enabled: true, start: '09:00', end: '21:00' },
    pwmState: 'off', nextTriggerAt: futureT7, syncedAt: 1000 };
  const r7D = applySyncedPhase_testHarness(local7D, remote7D, { now: Date.now(), calls: [], lastSyncedAt: 0 });
  verboseLog('  7D (activeHours 变更) calls:', r7D.calls.join(','));
  assertPass(r7D.calls.includes('rescheduleActiveBoundary'),
    '7D: activeHours 变更 → 重排 ac-active-boundary');
  assertPass(r7D.schedule.activeHours.enabled === true && r7D.schedule.activeHours.start === '09:00',
    '7D: activeHours 字段被采纳');

  // ===== 用例 8: page timer 跨设备 phase 校验纯函数 (v0.5.10) =====
  // v0.5.10: page timer 升为跨设备主同步通道（UST 服务器已确认跨设备同步），
  // chrome.storage.sync 降为同浏览器生态补充（Chrome/Edge 账号同步互不互通）。
  // 同时修正了 v0.5.7 的 pwmState 条件 bug（之前仅 pwmState='on' 才采纳，已改双向）。
  beginSuite('用例 8：页面定时器相位校验',
    '\n\n=== 用例 8: page timer 跨设备 phase 校验纯函数 (v0.5.10) ===\n');

  // 固定时戳基线：now = 2024-01-15 14:00:00
  const now8 = new Date(2024, 0, 15, 14, 0, 0, 0).getTime();
  const futureMs8 = now8 + 60 * 60 * 1000;  // 15:00
  const ts16 = new Date(2024, 0, 15, 16, 0, 0, 0).getTime();  // 16:00

  // ---- 8A-8C: parsePageTimerValue 不变 ----
  const pA = parsePageTimerValue('15:00', now8);
  assertPass(pA !== null && pA.valid === true, '8A: parsePageTimerValue "15:00" → valid=true');
  assertPass(pA && pA.targetMs === futureMs8, '8A: targetMs 对应 15:00:00');
  assertPass(parsePageTimerValue('10:00', now8)?.valid === false, '8B: 过期 → valid=false');
  assertPass(parsePageTimerValue('25:00', now8) === null, '8C: 小时越界 → null');
  assertPass(parsePageTimerValue(null, now8) === null, '8C: null → null');

  // 8C-cross: 页面允许直接输入跨午夜时间（23:50 输入 00:10）
  const nowCross8 = new Date(2024, 0, 15, 23, 50, 0, 0).getTime();
  const expectedCross8 = new Date(2024, 0, 16, 0, 10, 0, 0).getTime();
  const parsedCross8 = parsePageTimerValue('00:10', nowCross8);
  assertPass(parsedCross8?.valid === true && parsedCross8.targetMs === expectedCross8,
    '8C-cross: 23:50 读取 00:10 → 识别为次日 00:10');

  // ---- 8D: 未找到 → null ----
  const schedOff = { enabled: true, pwmState: 'off', onMinutes: 60, offMinutes: 60, nextTriggerAt: futureMs8 };
  assertPass(computePageTimerAdoption(schedOff, { found: false, value: null }, { now: now8 }) === null,
    '8D: page timer 未找到 → null');

  // ---- 8E: 值为空 → null ----
  assertPass(computePageTimerAdoption(schedOff, { found: true, value: null }, { now: now8 }) === null,
    '8E: value 空 → null');

  // ---- 8F: 值已过期 → null ----
  assertPass(computePageTimerAdoption(schedOff, { found: true, value: '10:00' }, { now: now8 }) === null,
    '8F: 过期值 → null');

  // ---- 8G: pwmState='off'（AC 正开）偏差 1 小时 → 采纳 page timer ----
  // 本地 nextTriggerAt = 15:00，page timer = 16:00（差 1 小时）
  const adoptG = computePageTimerAdoption(schedOff, { found: true, value: '16:00' }, { now: now8 });
  assertPass(adoptG !== null && adoptG.adopt === true, '8G (主场景): pwmState=off, 1h 偏差 → 采纳');
  assertPass(adoptG && adoptG.nextTriggerAt === ts16, '8G: 采纳的 nextTriggerAt = 16:00');
  assertPass(adoptG && adoptG.source === 'page-timer', '8G: source=page-timer');
  assertPass(adoptG && adoptG.reason === 'deviation', '8G: reason=deviation');

  // ---- 8H: enabled=false → null ----
  const schedDisabled = { enabled: false, pwmState: 'off', onMinutes: 60, offMinutes: 60, nextTriggerAt: futureMs8 };
  assertPass(computePageTimerAdoption(schedDisabled, { found: true, value: '16:00' }, { now: now8 }) === null,
    '8H: enabled=false → null');

  // ---- 8I: pwmState='off' 偏差 ≤ 60s → null（已对齐）----
  const schedI = { enabled: true, pwmState: 'off', onMinutes: 60, offMinutes: 60, nextTriggerAt: futureMs8 + 30_000 };
  assertPass(computePageTimerAdoption(schedI, { found: true, value: '15:00' }, { now: now8 }) === null,
    '8I: 30s 偏差在窗内 → null');

  // ---- 8J: pwmState='off' 本地无触发 → 直接采纳 ----
  const schedJ = { enabled: true, pwmState: 'off', onMinutes: 60, offMinutes: 60, nextTriggerAt: 0 };
  const adoptJ = computePageTimerAdoption(schedJ, { found: true, value: '16:00' }, { now: now8 });
  assertPass(adoptJ !== null && adoptJ.adopt === true, '8J: 本地无触发 → 采纳');
  assertPass(adoptJ && adoptJ.nextTriggerAt === ts16, '8J: 采纳的 nextTriggerAt = 16:00');
  assertPass(adoptJ && adoptJ.reason === 'local-no-trigger', '8J: reason=local-no-trigger');

  // ---- 8K: 自定义 toleranceMs ——
  // 本地 nextTriggerAt = 15:00，page timer = 15:02（差 120s）
  const adoptK = computePageTimerAdoption(schedOff, { found: true, value: '15:02' }, { now: now8, toleranceMs: 180_000 });
  assertPass(adoptK === null, '8K: 120s 偏差 < toleranceMs(180s) → null');

  // ---- 8L: 边界——偏差恰好 60s → null ----
  const schedL = { enabled: true, pwmState: 'off', onMinutes: 60, offMinutes: 60, nextTriggerAt: futureMs8 + 60_000 };
  assertPass(computePageTimerAdoption(schedL, { found: true, value: '15:00' }, { now: now8 }) === null,
    '8L: 60s 偏差恰好 = toleranceMs → null');

  // ---- 8M: pwmState='on'（AC 正关，下一步开）：page timer 掉算下一轮"开" ----
  // now=14:00, page timer='15:00', offMinutes=60 → 下一轮开在 15:00+60min=16:00
  const schedOn = { enabled: true, pwmState: 'on', onMinutes: 60, offMinutes: 60, nextTriggerAt: futureMs8 };
  // 本地认为 15:00 开，page timer 参考 15:00 关 → 下一轮开在 16:00
  // k = round((15:00 - 16:00) / 120min) = round(-0.5) = 0 → expectedTrigger = 16:00
  // diff = |16:00 - 15:00| = 1h > 60s → 采纳 16:00
  const adoptM = computePageTimerAdoption(schedOn, { found: true, value: '15:00' }, { now: now8 });
  assertPass(adoptM !== null && adoptM.adopt === true, '8M: pwmState=on, 偏差 1h → 采纳');
  assertPass(adoptM && adoptM.nextTriggerAt === ts16, '8M: 采纳的 nextTriggerAt = 16:00（15:00 关 + 60min OFF = 16:00 开）');

  // ---- 8N: pwmState='on' 本地无触发 → 直接采纳推导的"开"时刻 ----
  const schedN = { enabled: true, pwmState: 'on', onMinutes: 60, offMinutes: 60, nextTriggerAt: 0 };
  const adoptN = computePageTimerAdoption(schedN, { found: true, value: '15:00' }, { now: now8 });
  assertPass(adoptN !== null && adoptN.adopt === true, '8N: pwmState=on 无触发 → 采纳');
  assertPass(adoptN && adoptN.nextTriggerAt === ts16, '8N: 采纳的 nextTriggerAt = 16:00');
  assertPass(adoptN && adoptN.reason === 'local-no-trigger', '8N: reason=local-no-trigger');

  // ---- 8O: pwmState='on' 偏差 ≤ 60s → null ----
  // 本地 nextTriggerAt = 16:00:30, page timer = 15:00（个轮开在 16:00）
  const schedO = { enabled: true, pwmState: 'on', onMinutes: 60, offMinutes: 60, nextTriggerAt: ts16 + 30_000 };
  assertPass(computePageTimerAdoption(schedO, { found: true, value: '15:00' }, { now: now8 }) === null,
    '8O: 30s 偏差在窗内 → null');

  // ===== 用例 9: v0.5.12 AC 开关单一递归收敛链路 =====
  // 真实 AntD 点击仍需 Edge 手动验证；这里锁定会导致重复提示音的源码结构不变量：
  // 主世界每轮只 click 一次、10 秒后递归复查，background/content 不再叠加第二套点击重试。
  beginSuite('用例 9：AC 开关递归收敛',
    '\n\n=== 用例 9: AC 开关单一递归收敛链路 (v0.5.12) ===\n');

  const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const pageConfirmSource = fs.readFileSync(path.join(ROOT, 'page-confirm.js'), 'utf8');
  const smartRecoverySource = fs.readFileSync(path.join(ROOT, 'smart-recovery.js'), 'utf8');
  const intervalRecoverySource = fs.readFileSync(path.join(ROOT, 'interval-recovery.js'), 'utf8');
  const recoveryCoordinatorSource = fs.readFileSync(path.join(ROOT, 'recovery-coordinator.js'), 'utf8');
  const countOccurrences = (source, needle) => source.split(needle).length - 1;
  assertPass(backgroundSource.includes('function assessContentRuntimeIdentity(')
      && backgroundSource.includes('async function inspectContentRuntime(')
      && backgroundSource.includes("'inspectContentRuntime'")
      && backgroundSource.includes('CONTENT-RUNTIME-MISMATCH')
      && backgroundSource.includes('runtimeIdentityAssessment.valid')
      && backgroundSource.includes('await injectContentScriptsIntoExactHome(tabId)')
      && backgroundSource.includes('重注入后的 content/main 构建身份仍不一致'),
    '9A-0: SW 以自身 build 校验 content/main，旧 ping 不再假绿；不一致先原页重注入，仍失败则阻断动作');
  const runtimeIdentityStart9A = backgroundSource.indexOf(
    'function isMatchingRuntimeComponentBuild(component)'
  );
  const runtimeIdentityEnd9A = backgroundSource.indexOf(
    '\n\nconst AC_PAGE',
    runtimeIdentityStart9A
  );
  const runtimeIdentitySource9A = backgroundSource.slice(
    runtimeIdentityStart9A,
    runtimeIdentityEnd9A
  );
  const loadRuntimeIdentityAssessment9A = (buildTime, buildEpoch) => new Function(
    `const BUILD_TIME = ${JSON.stringify(buildTime)};
    const BUILD_TIME_EPOCH_MS = ${buildEpoch};
    ${runtimeIdentitySource9A};
    return assessContentRuntimeIdentity;`
  )();
  const assessPackagedRuntime9A = loadRuntimeIdentityAssessment9A(
    '2026-08-29 02:00:00',
    1787930400000
  );
  const matchingRuntime9A = assessPackagedRuntime9A({
    success: true,
    runtimeIdentity: {
      content: {
        buildTime: '2026-08-29 02:00:00',
        buildTimeEpochMs: 1787930400000
      },
      main: {
        buildTime: '2026-08-29 02:00:00',
        buildTimeEpochMs: 1787930400000
      }
    }
  });
  const oldPingRuntime9A = assessPackagedRuntime9A({ success: true });
  const mixedRuntime9A = assessPackagedRuntime9A({
    success: true,
    runtimeIdentity: {
      content: {
        buildTime: '2026-08-29 02:00:00',
        buildTimeEpochMs: 1787930400000
      },
      main: {
        buildTime: '2026-08-29 01:00:00',
        buildTimeEpochMs: 1787926800000
      }
    }
  });
  const devRuntime9A = loadRuntimeIdentityAssessment9A('dev', 0)({ success: true });
  assertPass(matchingRuntime9A.valid === true
      && matchingRuntime9A.contentMatches === true
      && matchingRuntime9A.mainMatches === true
      && oldPingRuntime9A.valid === false
      && oldPingRuntime9A.code === 'CONTENT-RUNTIME-MISMATCH'
      && mixedRuntime9A.valid === false
      && mixedRuntime9A.contentMatches === true
      && mixedRuntime9A.mainMatches === false
      && devRuntime9A.valid === true
      && devRuntime9A.contentMatches === null,
    '9A-0A: 正式 build 缺字段或 content/main 任一混版均失败关闭；dev 仅保留 unknown 兼容');

  const recoveryDecisionSources = [
    smartRecoverySource,
    intervalRecoverySource,
    recoveryCoordinatorSource
  ];
  assertPass(recoveryDecisionSources.every(source => (
    !/\bchrome\s*\./.test(source)
    && !/\bdocument\s*\./.test(source)
    && !/\bwindow\s*\./.test(source)
    && !/\bimportScripts\s*\(/.test(source)
    && !/\bfetch\s*\(/.test(source)
  )), 'recovery: 三个模式恢复模块保持浏览器无关的纯决策边界');
  assertPass(backgroundSource.includes("importScripts('smart-recovery.js');")
      && backgroundSource.includes("importScripts('interval-recovery.js');")
      && backgroundSource.includes("importScripts('recovery-coordinator.js');"),
    'recovery: Service Worker 显式加载智能策略、循环策略与恢复协调器');

  assertPass(!popupJs.includes('function clampSmartSensitivityLocal(')
      && !backgroundSource.includes('function clampSmartSensitivity(')
      && countOccurrences(popupJs, 'normalizeSmartSensitivity(') >= 3
      && countOccurrences(backgroundSource, 'normalizeSmartSensitivity(') >= 1,
    'smart: popup/background 复用共享灵敏度归一化，不保留重复本地实现');

  assertPass([
    'latest_1min_temperature.csv',
    'latest_1min_humidity.csv',
    'latest_10min_wind.csv',
    'hourlyRainfall.php?lang=en'
  ].every(resource => backgroundSource.includes(resource))
      && backgroundSource.includes('parseTseungKwanOWeather({'),
    'smart: background 并行接入 JKB 温度/湿度/风/站点雨量四个官方源');

  const mainWorldBridgeStart = contentSource.indexOf('function requestMainWorldResult({');
  const mainWorldBridgeEnd = contentSource.indexOf('\n// ----- 等待开关元素出现', mainWorldBridgeStart);
  const mainWorldBridgeSource = mainWorldBridgeStart >= 0 && mainWorldBridgeEnd > mainWorldBridgeStart
    ? contentSource.slice(mainWorldBridgeStart, mainWorldBridgeEnd)
    : '';
  const testMainBridgeEvents = {
    toggle: '__AC_EXTENSION_123_TOGGLE_AC__',
    toggleResult: '__AC_EXTENSION_123_TOGGLE_AC_RESULT__',
    status: '__AC_EXTENSION_123_GET_STATUS__',
    statusResult: '__AC_EXTENSION_123_GET_STATUS_RESULT__'
  };
  const loadMainWorldBridge = new Function(
    'MAIN_BRIDGE_EVENTS',
    'window',
    'CustomEvent',
    'setTimeout',
    `${mainWorldBridgeSource}; return { requestMainWorldToggle, requestMainWorldStatus };`
  );
  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  function createMainWorldBridge(responses = {}) {
    const listeners = new Map();
    const sentEvents = [];
    const fakeWindow = {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
      dispatchEvent(event) {
        sentEvents.push(event);
        const response = responses[event.type];
        if (!response) return;
        const resultEvent = event.type === testMainBridgeEvents.toggle
          ? testMainBridgeEvents.toggleResult
          : testMainBridgeEvents.statusResult;
        const responseDetail = typeof response === 'function'
          ? response(event.detail)
          : response;
        listeners.get(resultEvent)?.({
          detail: { requestId: event.detail.requestId, ...responseDetail }
        });
      }
    };
    const bridge = loadMainWorldBridge(
      testMainBridgeEvents,
      fakeWindow,
      TestCustomEvent,
      callback => { callback(); return 1; }
    );
    return { ...bridge, listeners, sentEvents };
  }

  const toggleBridge = createMainWorldBridge({
    [testMainBridgeEvents.toggle]: { success: true, action: 'on' }
  });
  const toggleBridgeDeadline = Date.now() + 60000;
  const toggleBridgeResult = await toggleBridge.requestMainWorldToggle(
    'on',
    65000,
    toggleBridgeDeadline
  );
  assertPass(toggleBridgeResult?.success === true
      && toggleBridgeResult.action === 'on'
      && !Object.hasOwn(toggleBridgeResult, 'requestId')
      && toggleBridge.sentEvents[0]?.type === testMainBridgeEvents.toggle
      && toggleBridge.sentEvents[0]?.detail?.action === 'on'
      && toggleBridge.sentEvents[0]?.detail?.notAfterAt === toggleBridgeDeadline
      && /^ac-\d+-/.test(toggleBridge.sentEvents[0]?.detail?.requestId || '')
      && toggleBridge.listeners.size === 0,
    '9Bridge-1: 主世界 toggle 握手保留事件、action、requestId 前缀与完成后监听器清理');

  const statusBridge = createMainWorldBridge({
    [testMainBridgeEvents.status]: { isOn: false, source: 'main-world' }
  });
  const statusBridgeResult = await statusBridge.requestMainWorldStatus(3000);
  assertPass(statusBridgeResult?.isOn === false
      && statusBridgeResult.source === 'main-world'
      && !Object.hasOwn(statusBridgeResult, 'requestId')
      && statusBridge.sentEvents[0]?.type === testMainBridgeEvents.status
      && /^ac-status-\d+-/.test(statusBridge.sentEvents[0]?.detail?.requestId || '')
      && statusBridge.listeners.size === 0,
    '9Bridge-2: 主世界 status 握手保留独立事件、requestId 前缀与结果解包');

  const timeoutBridge = createMainWorldBridge();
  const toggleTimeoutResult = await timeoutBridge.requestMainWorldToggle('on', 65000);
  const statusTimeoutResult = await timeoutBridge.requestMainWorldStatus(3000);
  assertPass(toggleTimeoutResult === null
      && statusTimeoutResult?.isOn === null
      && statusTimeoutResult.error === '主世界状态读取超时'
      && timeoutBridge.listeners.size === 0,
    '9Bridge-3: 两条主世界通道保留各自的超时返回值并清理监听器');

  const ensureStart = pageConfirmSource.indexOf('async function ensureACState(attempt, clickCount = 0)');
  const ensureEnd = pageConfirmSource.indexOf(
    '\n  function findACToggleExecutionSuccessMessagesInPageWorld',
    ensureStart
  );
  const ensureBody = ensureStart >= 0 && ensureEnd > ensureStart
    ? pageConfirmSource.slice(ensureStart, ensureEnd)
    : '';

  const pwmBody = extractSourceSection(
    backgroundSource,
    'async function runPwmStep({',
    '\n// ----- 设置页面自带定时器',
    'runPwmStep'
  );

  const existingTabStart = backgroundSource.indexOf('async function _toggleOnExistingTab');
  const existingTabEnd = backgroundSource.indexOf('\nasync function _toggleOnNewTab', existingTabStart);
  const existingTabBody = existingTabStart >= 0 && existingTabEnd > existingTabStart
    ? backgroundSource.slice(existingTabStart, existingTabEnd)
    : '';

  const newTabStart = backgroundSource.indexOf('async function _toggleOnNewTab');
  const newTabEnd = backgroundSource.indexOf('\nasync function getReadyACTab', newTabStart);
  const newTabBody = newTabStart >= 0 && newTabEnd > newTabStart
    ? backgroundSource.slice(newTabStart, newTabEnd)
    : '';

  const getReadyTabStart = backgroundSource.indexOf('async function getReadyACTab(');
  const getReadyTabEnd = backgroundSource.indexOf('\nasync function waitForTabReady', getReadyTabStart);
  const getReadyTabBody = getReadyTabStart >= 0 && getReadyTabEnd > getReadyTabStart
    ? backgroundSource.slice(getReadyTabStart, getReadyTabEnd)
    : '';

  const setTimerStart = backgroundSource.indexOf('async function setPageTimer(');
  const setTimerEnd = backgroundSource.indexOf('\nasync function requestTimerBasedShutdown', setTimerStart);
  const setTimerBody = setTimerStart >= 0 && setTimerEnd > setTimerStart
    ? backgroundSource.slice(setTimerStart, setTimerEnd)
    : '';

  const toggleOnceStart = backgroundSource.indexOf('async function toggleACOnce(action, options = {})');
  const toggleOnceEnd = backgroundSource.indexOf('\nasync function _toggleOnExistingTab', toggleOnceStart);
  const toggleOnceBody = toggleOnceStart >= 0 && toggleOnceEnd > toggleOnceStart
    ? backgroundSource.slice(toggleOnceStart, toggleOnceEnd)
    : '';

  const adoptTimerStart = backgroundSource.indexOf('async function tryAdoptPageTimer(reason =');
  const adoptTimerEnd = backgroundSource.indexOf('\n// ----- 官方推荐：setInterval heartbeat', adoptTimerStart);
  const adoptTimerBody = adoptTimerStart >= 0 && adoptTimerEnd > adoptTimerStart
    ? backgroundSource.slice(adoptTimerStart, adoptTimerEnd)
    : '';

  const getStatusStart = backgroundSource.indexOf('async function getCurrentACStatus()');
  const getStatusEnd = backgroundSource.indexOf('\nasync function ensureScheduleClock(options = {})', getStatusStart);
  const getStatusBody = getStatusStart >= 0 && getStatusEnd > getStatusStart
    ? backgroundSource.slice(getStatusStart, getStatusEnd)
    : '';

  assertPass(ensureStart >= 0,
    '9A: 主世界存在 ensureACState(attempt, clickCount) 递归收敛函数');
  assertPass(ensureBody.includes('return ensureACState(attempt, clickCount + 1);'),
    '9B: 每轮等待后携带同一不可变 attempt 递归调用 ensureACState 自身');
  assertPass(ensureBody.includes('await waitForTargetACStateInPageWorld(')
      && !ensureBody.includes('await sleepInPageWorld(AC_STATE_SETTLE_MS);')
      && pageConfirmSource.includes('const AC_STATE_SETTLE_MS = 10000;')
      && pageConfirmSource.includes('async function waitForTargetACStateInPageWorld('),
    '9C: 成功提示出现后按目标 ON 状态推进，不再盲等 10 秒才复查');
  const executionBaselineIndex9C = ensureBody.indexOf('const executionSuccessBaseline = new Set(');
  const executionClickIndex9C = ensureBody.indexOf('clickElementOnceInPageWorld(sw)');
  const executionWaitStartIndex9C = ensureBody.indexOf(
    'const executionSuccessPromise = waitForNewACToggleExecutionSuccessInPageWorld('
  );
  const executionDialogIndex9C = ensureBody.indexOf(
    'const dialogPromise = clickConfirmDialogInPageWorld('
  );
  const executionWaitEndIndex9C = ensureBody.indexOf('await executionSuccessPromise');
  const executionDialogStopIndex9C = ensureBody.indexOf('dialogWait.stopped = true;');
  const executionDialogEndIndex9C = ensureBody.indexOf('await dialogPromise');
  assertPass(pageConfirmSource.includes("const AC_ON_SUCCESS_TEXT = 'Execution succeeded';")
      && pageConfirmSource.includes('function findACToggleExecutionSuccessMessagesInPageWorld()')
      && pageConfirmSource.includes('async function waitForNewACToggleExecutionSuccessInPageWorld(')
      && executionBaselineIndex9C >= 0
      && executionBaselineIndex9C < executionClickIndex9C
      && executionWaitStartIndex9C > executionClickIndex9C
      && executionWaitStartIndex9C < executionDialogIndex9C
      && executionWaitEndIndex9C > executionDialogIndex9C
      && executionDialogStopIndex9C > executionWaitEndIndex9C
      && executionDialogEndIndex9C > executionDialogStopIndex9C
      && ensureBody.includes('executionSuccess.executionConfirmationMissing === true')
      && pageConfirmSource.includes('executionConfirmationMissing: true'),
    '9C-1: 新 Execution succeeded 与确认框并行；toast 完成后停止无关确认框等待，缺失时显式失败');
  assertPass(countOccurrences(ensureBody, 'clickElementOnceInPageWorld(sw)') === 1,
    '9D: ensureACState 每轮只有一个 AC 开关点击调用点');
  assertPass(countOccurrences(pageConfirmSource, 'element.click()') === 1,
    '9E: 主世界统一点击 helper 只执行一次 element.click()');
  assertPass(!pageConfirmSource.includes('new PointerEvent')
      && !pageConfirmSource.includes('new MouseEvent')
      && !pageConfirmSource.includes('new KeyboardEvent'),
    '9F: AC 主世界不再叠发 pointer/mouse/keyboard 激活事件');
  assertPass(pageConfirmSource.includes('activeAcStateRequest')
      && pageConfirmSource.includes('合并重复的'),
    '9G: 主世界同目标并发请求复用 single-flight Promise');

  const toggleCoordinatorSource9G = extractSourceSection(
    backgroundSource,
    '// ----- 切换 AC 状态 -----',
    '\nasync function toggleACOnce(action, options = {})',
    'background toggle coordinator'
  );
  const createToggleCoordinator9G = implementations => {
    const calls = [];
    const queue = [...implementations];
    const { toggleAC } = new Function(
      'sanitizeMinutes', 'isAutomationAllowed', 'isAutomationOperationCurrent',
      'toggleACOnce', 'console',
      `let acToggleInFlight = null;
       let acToggleInFlightAction = null;
       let acToggleInFlightNotAfterAt = 0;
       let acToggleInFlightRequiresAutomation = false;
       let acToggleInFlightAutomationRevision = null;
       let acToggleInFlightPageTimerMinutes = 0;
       let acToggleInFlightPageTimerTargetAt = 0;
       let activeAcToggleAttempt = null;
       ${toggleCoordinatorSource9G}
       return { toggleAC };`
    )(
      (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      },
      () => true,
      () => true,
      (...args) => {
        calls.push(args);
        const implementation = queue.shift();
        if (!implementation) throw new Error('unexpected toggleACOnce call');
        return implementation(...args);
      },
      testConsole
    );
    return { toggleAC, calls };
  };
  const makeDeferred9G = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const toggleDeadline9G = Date.now() + 120000;
  const toggleOptions9G = {
    notAfterAt: toggleDeadline9G,
    requireAutomationAllowed: true,
    automationRevision: 7,
    pageTimerMinutes: 23,
    pageTimerTargetAt: toggleDeadline9G + 60000
  };
  const sameToggleDeferred9G = makeDeferred9G();
  const sameToggleHarness9G = createToggleCoordinator9G([
    () => sameToggleDeferred9G.promise,
    async () => ({ success: true, generation: 2 })
  ]);
  const sameToggleFirst9G = sameToggleHarness9G.toggleAC('on', toggleOptions9G);
  const sameToggleSecond9G = sameToggleHarness9G.toggleAC('on', toggleOptions9G);
  await Promise.resolve();
  assertPass(sameToggleHarness9G.calls.length === 1,
    '9G-0A: 后台完全相同的 toggle 请求共享一次执行，single-flight 不重复点击');
  sameToggleDeferred9G.resolve({ success: true, generation: 1 });
  const [sameToggleResultA9G, sameToggleResultB9G] = await Promise.all([
    sameToggleFirst9G,
    sameToggleSecond9G
  ]);
  const afterResolvedToggle9G = await sameToggleHarness9G.toggleAC('on', toggleOptions9G);
  assertPass(sameToggleResultA9G.generation === 1
      && sameToggleResultB9G.generation === 1
      && afterResolvedToggle9G.generation === 2
      && sameToggleHarness9G.calls.length === 2,
    '9G-0B: 后台 toggle 成功结算后释放 single-flight，后续同请求可重新执行');

  const busyToggleDeferred9G = makeDeferred9G();
  const busyToggleHarness9G = createToggleCoordinator9G([
    () => busyToggleDeferred9G.promise
  ]);
  const busyToggleFirst9G = busyToggleHarness9G.toggleAC('on', toggleOptions9G);
  const busyToggleResults9G = await Promise.all([
    busyToggleHarness9G.toggleAC('off'),
    busyToggleHarness9G.toggleAC('on', { ...toggleOptions9G, notAfterAt: toggleDeadline9G + 1 }),
    busyToggleHarness9G.toggleAC('on', { ...toggleOptions9G, requireAutomationAllowed: false }),
    busyToggleHarness9G.toggleAC('on', { ...toggleOptions9G, automationRevision: 8 }),
    busyToggleHarness9G.toggleAC('on', { ...toggleOptions9G, pageTimerMinutes: 24 }),
    busyToggleHarness9G.toggleAC('on', { ...toggleOptions9G, pageTimerTargetAt: toggleDeadline9G + 60001 })
  ]);
  assertPass(busyToggleHarness9G.calls.length === 1
      && busyToggleResults9G.every(result => result?.success === false && result.busy === true),
    '9G-0C: action、截止、自动控制版本与页面 timer 任一不同都返回 busy，不合并为同一物理动作');
  busyToggleDeferred9G.resolve({ success: true });
  await busyToggleFirst9G;

  const rejectedToggleHarness9G = createToggleCoordinator9G([
    async () => { throw new Error('synthetic toggle rejection'); },
    async () => ({ success: true, recovered: true })
  ]);
  let rejectedToggleError9G = '';
  try {
    await rejectedToggleHarness9G.toggleAC('on', toggleOptions9G);
  } catch (error) {
    rejectedToggleError9G = error?.message || String(error);
  }
  const afterRejectedToggle9G = await rejectedToggleHarness9G.toggleAC('on', toggleOptions9G);
  assertPass(rejectedToggleError9G === 'synthetic toggle rejection'
      && afterRejectedToggle9G.recovered === true
      && rejectedToggleHarness9G.calls.length === 2,
    '9G-0D: 后台 toggle executor 抛错后也释放 single-flight，不遗留永久 busy');

  const invalidToggleHarness9G = createToggleCoordinator9G([
    async () => ({ success: true })
  ]);
  const invalidToggleResults9G = await Promise.all([
    invalidToggleHarness9G.toggleAC('on', { ...toggleOptions9G, notAfterAt: Number.NaN }),
    invalidToggleHarness9G.toggleAC('on', { ...toggleOptions9G, pageTimerMinutes: -1 }),
    invalidToggleHarness9G.toggleAC('on', { ...toggleOptions9G, pageTimerTargetAt: Date.now() - 1 })
  ]);
  const afterInvalidToggle9G = await invalidToggleHarness9G.toggleAC('on', toggleOptions9G);
  assertPass(invalidToggleResults9G.every(result => result?.success === false && !result.busy)
      && afterInvalidToggle9G.success === true
      && invalidToggleHarness9G.calls.length === 1,
    '9G-0E: 无效 toggle 参数在认领 single-flight 前失败，不会阻塞下一次合法动作');

  const pageRequestCoordinatorSource9G = extractSourceSection(
    pageConfirmSource,
    'async function requestACState(targetState, notAfterAt = 0)',
    '\n\n  // 递归状态收敛',
    'page request coordinator'
  );
  const createPageRequestCoordinator9G = implementations => {
    const calls = [];
    const queue = [...implementations];
    const lease = {
      inFlight: null,
      target: null,
      notAfterAt: 0,
      ownerGeneration: 5
    };
    const ensureACState = (...args) => {
      calls.push({
        args,
        attempt: args[0]
      });
      const implementation = queue.shift();
      if (!implementation) throw new Error('unexpected ensureACState call');
      return implementation(...args);
    };
    const { requestACState } = new Function(
      'ensureACState', 'mainBridgeLease', 'automaticOnCancellationRevision',
      'mainBridgeOwnerGeneration', 'PAGE_MAIN_LISTENER_ID', 'console',
      `let acStateRequestInFlight = null;
       let acStateRequestTarget = null;
       let acStateRequestNotAfterAt = 0;
       let activeAcStateRequest = null;
       ${pageRequestCoordinatorSource9G}
       return { requestACState };`
    )(
      ensureACState,
      lease,
      11,
      5,
      'main-listener-test',
      testConsole
    );
    return { requestACState, calls, lease };
  };
  const pageRequestDeadline9G = Date.now() + 120000;
  const samePageRequestDeferred9G = makeDeferred9G();
  const samePageRequestHarness9G = createPageRequestCoordinator9G([
    () => samePageRequestDeferred9G.promise,
    async () => ({ success: true, generation: 2 })
  ]);
  const samePageRequestFirst9G = samePageRequestHarness9G.requestACState(true, pageRequestDeadline9G);
  const samePageRequestSecond9G = samePageRequestHarness9G.requestACState(true, pageRequestDeadline9G);
  await Promise.resolve();
  const firstPageAttempt9G = samePageRequestHarness9G.calls[0]?.attempt;
  assertPass(samePageRequestHarness9G.calls.length === 1
      && Object.isFrozen(firstPageAttempt9G)
      && firstPageAttempt9G.targetState === true
      && firstPageAttempt9G.notAfterAt === pageRequestDeadline9G
      && firstPageAttempt9G.cancellationRevision === 11
      && firstPageAttempt9G.ownerGeneration === 5
      && typeof firstPageAttempt9G.requestId === 'string'
      && firstPageAttempt9G.requestId.startsWith('main-listener-test-'),
    '9G-0F: 主世界完全相同的 target/deadline 请求共享一个冻结 attempt 与一次 ensure 执行');
  samePageRequestDeferred9G.resolve({ success: true, generation: 1 });
  const [samePageRequestResultA9G, samePageRequestResultB9G] = await Promise.all([
    samePageRequestFirst9G,
    samePageRequestSecond9G
  ]);
  const afterResolvedPageRequest9G = await samePageRequestHarness9G.requestACState(
    true,
    pageRequestDeadline9G
  );
  assertPass(samePageRequestResultA9G.generation === 1
      && samePageRequestResultB9G.generation === 1
      && afterResolvedPageRequest9G.generation === 2
      && samePageRequestHarness9G.calls.length === 2,
    '9G-0G: 主世界 request 成功结算后清理本地与共享 lease，后续请求可重新执行');

  const busyPageRequestDeferred9G = makeDeferred9G();
  const busyPageRequestHarness9G = createPageRequestCoordinator9G([
    () => busyPageRequestDeferred9G.promise
  ]);
  const busyPageRequestFirst9G = busyPageRequestHarness9G.requestACState(true, pageRequestDeadline9G);
  const busyPageRequestResults9G = await Promise.all([
    busyPageRequestHarness9G.requestACState(false, pageRequestDeadline9G),
    busyPageRequestHarness9G.requestACState(true, pageRequestDeadline9G + 1)
  ]);
  assertPass(busyPageRequestHarness9G.calls.length === 1
      && busyPageRequestResults9G.every(result => result?.success === false && result.busy === true),
    '9G-0H: 主世界 target 或 deadline 任一不同都返回 busy，不合并为同一点击事务');
  busyPageRequestDeferred9G.resolve({ success: true });
  await busyPageRequestFirst9G;

  const rejectedPageRequestHarness9G = createPageRequestCoordinator9G([
    async () => { throw new Error('synthetic page request rejection'); },
    async () => ({ success: true, recovered: true })
  ]);
  let rejectedPageRequestError9G = '';
  try {
    await rejectedPageRequestHarness9G.requestACState(true, pageRequestDeadline9G);
  } catch (error) {
    rejectedPageRequestError9G = error?.message || String(error);
  }
  const afterRejectedPageRequest9G = await rejectedPageRequestHarness9G.requestACState(
    true,
    pageRequestDeadline9G
  );
  assertPass(rejectedPageRequestError9G === 'synthetic page request rejection'
      && afterRejectedPageRequest9G.recovered === true
      && rejectedPageRequestHarness9G.calls.length === 2
      && rejectedPageRequestHarness9G.lease.inFlight === null,
    '9G-0I: 主世界 ensure 抛错后也清理 request/lease，不遗留永久 busy');

  const invalidPageRequestHarness9G = createPageRequestCoordinator9G([
    async () => ({ success: true })
  ]);
  const invalidPageRequestResult9G = await invalidPageRequestHarness9G.requestACState(
    true,
    Number.NaN
  );
  const afterInvalidPageRequest9G = await invalidPageRequestHarness9G.requestACState(
    true,
    pageRequestDeadline9G
  );
  assertPass(invalidPageRequestResult9G.success === false
      && !invalidPageRequestResult9G.busy
      && afterInvalidPageRequest9G.success === true
      && invalidPageRequestHarness9G.calls.length === 1,
    '9G-0J: 主世界无效 deadline 在认领 request/lease 前失败，不阻塞下一次合法动作');

  const scopedClickStart = pageConfirmSource.indexOf('function clickElementOnceInPageWorld(element)');
  const scopedClickEnd = pageConfirmSource.indexOf('\n  async function clickConfirmDialogInPageWorld(', scopedClickStart);
  const scopedClickSource = scopedClickStart >= 0 && scopedClickEnd > scopedClickStart
    ? pageConfirmSource.slice(scopedClickStart, scopedClickEnd)
    : '';
  const originalConfirm9G = () => false;
  const originalAlert9G = () => 'original-alert';
  const originalPrompt9G = () => 'original-prompt';
  const scopedWindow9G = {
    confirm: originalConfirm9G,
    alert: originalAlert9G,
    prompt: originalPrompt9G
  };
  const scopedDialogs9G = new Function(
    'window', 'console',
    `${scopedClickSource}; return { clickElementOnceInPageWorld };`
  )(scopedWindow9G, testConsole);
  let scopedValues9G = null;
  const scopedClickResult9G = scopedDialogs9G.clickElementOnceInPageWorld({
    click() {
      scopedValues9G = [
        scopedWindow9G.confirm('AC ON'),
        scopedWindow9G.alert('AC ON'),
        scopedWindow9G.prompt('AC ON', 'kept')
      ];
    }
  });
  const throwingClickResult9G = scopedDialogs9G.clickElementOnceInPageWorld({
    click() { throw new Error('synthetic click failure'); }
  });
  assertPass(scopedClickResult9G === true
      && scopedValues9G?.[0] === true
      && scopedValues9G?.[1] === undefined
      && scopedValues9G?.[2] === 'kept'
      && throwingClickResult9G === false
      && scopedWindow9G.confirm === originalConfirm9G
      && scopedWindow9G.alert === originalAlert9G
      && scopedWindow9G.prompt === originalPrompt9G
      && !pageConfirmSource.includes('__AC_EXTENSION_DIALOG_PATCHED__'),
    '9G-1: 原生对话框只在单次 AC click 调用栈内接管，成功或异常后均恢复页面函数');
  const pageSwitchLocatorSource9G = extractSourceSection(
    pageConfirmSource,
    'function findACSwitchInPageWorld() {',
    '\n\n  function clickElementOnceInPageWorld(element) {',
    'main-world unique AC switch locator'
  );
  const contentSwitchLocatorSource9G = extractSourceSection(
    contentSource,
    'function findACSwitch() {',
    '\n\n// ----- 设置页面自带的定时关闭（作为保险）-----',
    'isolated-world unique AC switch locator'
  );
  const makeSemanticSwitchDocument9G = (groups = []) => {
    const labels = groups.map(({ text = 'Air Conditioning Status', controls }) => {
      const container = {
        parentElement: null,
        querySelectorAll() { return controls; }
      };
      return { children: [], textContent: text, parentElement: container };
    });
    return {
      querySelectorAll() { return labels; }
    };
  };
  const loadPageSwitchLocator9G = document => new Function(
    'document',
    `${pageSwitchLocatorSource9G}; return findACSwitchInPageWorld;`
  )(document);
  const loadContentSwitchLocator9G = document => new Function(
    'document',
    `${contentSwitchLocatorSource9G}; return findACSwitch;`
  )(document);
  const semanticSwitch9G = { id: 'semantic-ac-switch' };
  const otherSwitch9G = { id: 'other-switch' };
  const uniqueSwitchDocument9G = makeSemanticSwitchDocument9G([
    { controls: [semanticSwitch9G] }
  ]);
  const ambiguousSwitchDocument9G = makeSemanticSwitchDocument9G([
    { controls: [semanticSwitch9G, otherSwitch9G] }
  ]);
  const duplicateSwitchDocument9G = makeSemanticSwitchDocument9G([
    { controls: [semanticSwitch9G] },
    { controls: [otherSwitch9G] }
  ]);
  const unlabeledSwitchDocument9G = makeSemanticSwitchDocument9G([]);
  assertPass(loadPageSwitchLocator9G(uniqueSwitchDocument9G)() === semanticSwitch9G
      && loadContentSwitchLocator9G(uniqueSwitchDocument9G)() === semanticSwitch9G
      && loadPageSwitchLocator9G(ambiguousSwitchDocument9G)() === null
      && loadContentSwitchLocator9G(ambiguousSwitchDocument9G)() === null
      && loadPageSwitchLocator9G(duplicateSwitchDocument9G)() === null
      && loadContentSwitchLocator9G(duplicateSwitchDocument9G)() === null
      && loadPageSwitchLocator9G(unlabeledSwitchDocument9G)() === null
      && loadContentSwitchLocator9G(unlabeledSwitchDocument9G)() === null,
    '9G-1A: 主世界与隔离世界只接受 Air Conditioning Status 语义区内唯一开关，歧义或无标签均失败关闭');
  // 主世界 toggle 握手异常也必须回包：否则隔离世界静默等满超时拿到 null，
  // 误触发后台刷新恢复。隔离世界超时也放宽到 90s 容纳慢异步 confirm + 最多 3 次点击。
  assertPass(pageConfirmSource.includes('result = await requestACState(true, notAfterAt);')
      && pageConfirmSource.includes('主世界切换抛异常')
      && pageConfirmSource.includes('detail: { requestId, action, ...result, ...getMainRuntimeIdentity() }'),
    '9G-1A: 主世界 toggle 握手异常时仍回显失败结果，避免隔离世界拿到 null');
  assertPass(contentSource.includes('requestMainWorldToggle(targetAction, 90000, notAfterAt)')
      && contentSource.includes('toggleACSwitch(action, msg.notAfterAt)')
      && contentSource.includes('notAfterAt !== 0 && !Number.isSafeInteger(notAfterAt)')
      && contentSource.includes('...(notAfterAt !== 0 ? { notAfterAt } : {})'),
    '9G-1B: 隔离世界 toggle 保留 90s 握手，并把智能 ON 首分钟截止透传到主世界');
  // 9G-2/3/4: 识别禁用开关——真实页面 onSwitchChange 的 disabled 门控
  // disabled=(remaining_balance_in_percentage<=0 || loading || balance<=0) && !free_mode。
  // 禁用时 button 不触发 click，主世界若继续点 3 次只会徒劳失败，须在点击前拦截并给出明确错误。
  assertPass(pageConfirmSource.includes('isACSwitchDisabledInPageWorld')
      && ensureBody.includes('current.disabled')
      && ensureBody.includes('beforeClick.disabled')
      && pageConfirmSource.includes('ant-switch-disabled'),
    '9G-2: 主世界识别禁用开关（disabled 属性 / ant-switch-disabled 类），点击前拦截而非徒劳点击');
  assertPass(contentSource.includes('isAntACSwitchDisabled')
      && contentSource.includes("disabled, source: 'ant-switch'")
      && contentSource.includes('ant-switch-disabled'),
    '9G-3: 隔离世界同样上报 disabled 标记，供诊断面板提示余额不足/加载中');
  const disabledHelperStart = pageConfirmSource.indexOf('function isACSwitchDisabledInPageWorld(');
  const disabledHelperEnd = pageConfirmSource.indexOf('\n  async function requestACState', disabledHelperStart);
  const disabledHelperSource = disabledHelperStart >= 0 && disabledHelperEnd > disabledHelperStart
    ? pageConfirmSource.slice(disabledHelperStart, disabledHelperEnd)
    : '';
  const loadDisabledHelper = new Function(`${disabledHelperSource}; return { isACSwitchDisabledInPageWorld };`);
  const { isACSwitchDisabledInPageWorld } = loadDisabledHelper();
  const enabledSwitchMock = { disabled: false, className: 'ant-switch', hasAttribute: () => false, getAttribute: () => null };
  const disabledPropMock = { disabled: true, className: 'ant-switch', hasAttribute: () => false, getAttribute: () => null };
  const disabledClassMock = { disabled: false, className: 'ant-switch ant-switch-disabled', hasAttribute: () => false, getAttribute: () => null };
  const disabledAttrMock = { disabled: false, className: 'ant-switch', hasAttribute: (a) => a === 'disabled', getAttribute: () => null };
  assertPass(isACSwitchDisabledInPageWorld(null) === false
      && isACSwitchDisabledInPageWorld(enabledSwitchMock) === false
      && isACSwitchDisabledInPageWorld(disabledPropMock) === true
      && isACSwitchDisabledInPageWorld(disabledClassMock) === true
      && isACSwitchDisabledInPageWorld(disabledAttrMock) === true,
    '9G-4: isACSwitchDisabledInPageWorld 实测：disabled 属性 / ant-switch-disabled 类 / aria-disabled 均判禁用');
  // 9G-5: 行为级证明——禁用开关时 ensureACState 直接返回失败，绝不调用点击。
  const ensureFnStart = pageConfirmSource.indexOf('async function ensureACState(attempt, clickCount = 0)');
  const ensureFnEnd = pageConfirmSource.indexOf(
    '\n  async function waitForTargetACStateInPageWorld',
    ensureFnStart
  );
  const ensureFnSource = ensureFnStart >= 0 && ensureFnEnd > ensureFnStart
    ? pageConfirmSource.slice(ensureFnStart, ensureFnEnd)
    : '';
  let disabledEnsureClickCalls = 0;
  const loadEnsure = new Function(
    'getACStatusInPageWorld', 'waitForACSwitchInPageWorld', 'clickElementOnceInPageWorld',
    'clickConfirmDialogInPageWorld', 'waitForTargetACStateInPageWorld', 'sleepInPageWorld',
    'MAX_AC_SWITCH_CLICKS', 'AC_STATE_SETTLE_MS',
    'automaticOnCancellationRevision', 'mainBridgeLease', 'document', 'AC_ON_SUCCESS_TEXT',
    'AC_EXECUTION_SUCCESS_TIMEOUT_MS', 'HOT_TAKEOVER_CLICK_QUIET_MS', 'console',
    `${ensureFnSource}; return { ensureACState };`
  );
  const createEnsureLease9G = () => ({
    ownerGeneration: 1,
    uncertainClickOwner: '',
    uncertainClickUntil: 0,
    blockedUntil: 0
  });
  const createEnsureAttempt9G = ({
    targetState = true,
    notAfterAt = 0,
    cancellationRevision = 0,
    ownerGeneration = 1,
    requestId = 'ensure-test'
  } = {}) => Object.freeze({
    targetState,
    notAfterAt,
    cancellationRevision,
    ownerGeneration,
    requestId
  });
  const ensureLease9G = createEnsureLease9G();
  const { ensureACState } = loadEnsure(
    () => ({ isOn: false, disabled: true, source: 'main-world-ant-switch' }),
    async () => null,
    () => { disabledEnsureClickCalls += 1; return true; },
    async () => false,
    async () => ({ reached: false, status: { isOn: false } }),
    async () => {},
    3,
    10000,
    0,
    ensureLease9G,
    { querySelectorAll: () => [] },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const disabledEnsureResult = await ensureACState(Object.freeze({
    targetState: true,
    notAfterAt: 0,
    cancellationRevision: 0,
    ownerGeneration: 1,
    requestId: 'disabled-test'
  }));
  let expiredWindowClickCalls = 0;
  const { ensureACState: ensureExpiredWindow } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { expiredWindowClickCalls += 1; return true; },
    async () => false,
    async () => ({ reached: false, status: { isOn: false } }),
    async () => {},
    3,
    10000,
    0,
    ensureLease9G,
    { querySelectorAll: () => [] },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const expiredWindowResult = await ensureExpiredWindow(Object.freeze({
    targetState: true,
    notAfterAt: Date.now() - 1,
    cancellationRevision: 0,
    ownerGeneration: 1,
    requestId: 'expired-test'
  }));
  const confirmFnStart = pageConfirmSource.indexOf('async function clickConfirmDialogInPageWorld(');
  const confirmFnEnd = pageConfirmSource.indexOf('\n  async function waitForACSwitchInPageWorld', confirmFnStart);
  const confirmFnSource = confirmFnStart >= 0 && confirmFnEnd > confirmFnStart
    ? pageConfirmSource.slice(confirmFnStart, confirmFnEnd)
    : '';
  let expiredConfirmClickCalls = 0;
  const confirmDeadlineAt = Date.now();
  const { clickConfirmDialogInPageWorld } = new Function(
    'document', 'Date', 'clickElementOnceInPageWorld', 'sleepInPageWorld',
    'automaticOnCancellationRevision', 'console',
    `${confirmFnSource}; return { clickConfirmDialogInPageWorld };`
  )(
    { querySelectorAll: () => [{ textContent: 'Confirm', className: '' }] },
    { now: () => confirmDeadlineAt },
    () => { expiredConfirmClickCalls += 1; return true; },
    async () => {},
    0,
    testConsole
  );
  const expiredConfirmResult = await clickConfirmDialogInPageWorld(5000, confirmDeadlineAt, 0);
  let stoppedConfirmClickCalls = 0;
  const stoppedConfirmButton = {
    textContent: 'Confirm',
    className: 'ant-btn-primary',
    disabled: false,
    hasAttribute: () => false,
    getAttribute: () => null
  };
  const stoppedConfirmDialog = {
    textContent: 'Turn on Air Conditioning?',
    className: 'ant-modal-confirm',
    hidden: false,
    parentElement: null,
    getAttribute: () => null,
    contains: () => false,
    querySelectorAll: selector => selector === 'button' ? [stoppedConfirmButton] : []
  };
  const { clickConfirmDialogInPageWorld: clickStoppedConfirm } = new Function(
    'document', 'Date', 'clickElementOnceInPageWorld', 'sleepInPageWorld',
    'automaticOnCancellationRevision', 'console',
    `${confirmFnSource}; return { clickConfirmDialogInPageWorld };`
  )(
    { querySelectorAll: () => [stoppedConfirmDialog] },
    Date,
    () => { stoppedConfirmClickCalls += 1; return true; },
    async () => {},
    0,
    testConsole
  );
  const stoppedConfirmResult = await clickStoppedConfirm(5000, 0, 0, () => true);
  assertPass(disabledEnsureResult.success === false
      && disabledEnsureResult.error.includes('被禁用')
      && disabledEnsureClickCalls === 0
      && expiredWindowResult.success === false
      && expiredWindowResult.error.includes('窗口已结束')
      && expiredWindowClickCalls === 0
      && expiredConfirmResult === false
      && expiredConfirmClickCalls === 0
      && stoppedConfirmResult === false
      && stoppedConfirmClickCalls === 0,
    '9G-5: 禁用／截止／toast 已完成时，开关或确认按钮均不会产生迟到点击');
  const makeConfirmButton9G = ({ text = 'Confirm', disabled = false } = {}) => ({
    textContent: text,
    className: 'ant-btn-primary',
    disabled,
    hasAttribute: attribute => attribute === 'disabled' && disabled,
    getAttribute: () => null
  });
  const makeConfirmDialog9G = (text, buttons) => ({
    textContent: text,
    className: 'ant-modal-confirm',
    hidden: false,
    getAttribute: () => null,
    contains: () => false,
    querySelectorAll: selector => selector === 'button' ? buttons : []
  });
  const runConfirmDialogCase9G = async dialogs => {
    let nowCalls = 0;
    let clickCalls = 0;
    const { clickConfirmDialogInPageWorld: clickConfirm9G } = new Function(
      'document', 'Date', 'clickElementOnceInPageWorld', 'sleepInPageWorld',
      'automaticOnCancellationRevision', 'console',
      `${confirmFnSource}; return { clickConfirmDialogInPageWorld };`
    )(
      { querySelectorAll: () => dialogs },
      { now: () => nowCalls++ < 2 ? 0 : 1 },
      () => { clickCalls += 1; return true; },
      async () => {},
      0,
      testConsole
    );
    const result = await clickConfirm9G(0, 0, 0);
    return { result, clickCalls };
  };
  const runDelayedConfirmDialogCase9G = async dialog => {
    let nowCalls = 0;
    let queryCalls = 0;
    let clickCalls = 0;
    const { clickConfirmDialogInPageWorld: clickConfirm9G } = new Function(
      'document', 'Date', 'clickElementOnceInPageWorld', 'sleepInPageWorld',
      'automaticOnCancellationRevision', 'console',
      `${confirmFnSource}; return { clickConfirmDialogInPageWorld };`
    )(
      { querySelectorAll: () => (++queryCalls === 1 ? [] : [dialog]) },
      { now: () => nowCalls++ < 2 ? 0 : 100 },
      () => { clickCalls += 1; return true; },
      async () => {},
      0,
      testConsole
    );
    const result = await clickConfirm9G(500, 0, 0);
    return { result, clickCalls, queryCalls };
  };
  const uniqueACDialog9G = await runConfirmDialogCase9G([
    makeConfirmDialog9G('Turn on Air Conditioning?', [makeConfirmButton9G()])
  ]);
  const unrelatedDialog9G = await runConfirmDialogCase9G([
    makeConfirmDialog9G('Delete this saved item?', [makeConfirmButton9G()])
  ]);
  const multipleACDialogs9G = await runConfirmDialogCase9G([
    makeConfirmDialog9G('Air Conditioning A', [makeConfirmButton9G()]),
    makeConfirmDialog9G('Air Conditioning B', [makeConfirmButton9G()])
  ]);
  const multipleConfirmButtons9G = await runConfirmDialogCase9G([
    makeConfirmDialog9G('Air Conditioning', [makeConfirmButton9G(), makeConfirmButton9G()])
  ]);
  const disabledConfirmButton9G = await runConfirmDialogCase9G([
    makeConfirmDialog9G('Air Conditioning', [makeConfirmButton9G({ disabled: true })])
  ]);
  const hiddenPopoverDialog9G = makeConfirmDialog9G(
    'Air Conditioning',
    [makeConfirmButton9G()]
  );
  hiddenPopoverDialog9G.className += ' ant-popover-hidden';
  const hiddenPopover9G = await runConfirmDialogCase9G([hiddenPopoverDialog9G]);
  const hiddenAncestorDialog9G = makeConfirmDialog9G(
    'Air Conditioning',
    [makeConfirmButton9G()]
  );
  hiddenAncestorDialog9G.parentElement = {
    className: 'ant-popover ant-popover-hidden',
    hidden: false,
    parentElement: null,
    getAttribute: () => null
  };
  const hiddenAncestor9G = await runConfirmDialogCase9G([hiddenAncestorDialog9G]);
  const delayedACDialog9G = await runDelayedConfirmDialogCase9G(
    makeConfirmDialog9G('Turn on Air Conditioning?', [makeConfirmButton9G()])
  );
  assertPass(uniqueACDialog9G.result === true && uniqueACDialog9G.clickCalls === 1
      && unrelatedDialog9G.result === false && unrelatedDialog9G.clickCalls === 0
      && multipleACDialogs9G.result === false && multipleACDialogs9G.clickCalls === 0
      && multipleConfirmButtons9G.result === false && multipleConfirmButtons9G.clickCalls === 0
      && disabledConfirmButton9G.result === false && disabledConfirmButton9G.clickCalls === 0
      && hiddenPopover9G.result === false && hiddenPopover9G.clickCalls === 0
      && hiddenAncestor9G.result === false && hiddenAncestor9G.clickCalls === 0
      && delayedACDialog9G.result === true && delayedACDialog9G.clickCalls === 1
      && delayedACDialog9G.queryCalls === 2,
    '9G-5A: 只点击轮询期内唯一可见 AC 确认框；隐藏、无关、重复或禁用候选均零点击');
  let cancelledEnsureClickCalls = 0;
  const { ensureACState: ensureCancelled } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { cancelledEnsureClickCalls += 1; return true; },
    async () => false,
    async () => ({ reached: false, status: { isOn: false } }),
    async () => {},
    3,
    10000,
    1,
    createEnsureLease9G(),
    { querySelectorAll: () => [] },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const cancelledEnsureResult = await ensureCancelled(createEnsureAttempt9G({
    requestId: 'cancelled-test'
  }));
  assertPass(cancelledEnsureResult.success === false
      && cancelledEnsureResult.error.includes('请求已被后台取消')
      && cancelledEnsureClickCalls === 0,
    '9G-5B: 后台取消旧自动 ON 后，主世界递归在下一次点击前立即停止');
  // 9G-6: 反证——启用开关（free mode 下余额为 0 也不禁用）不被误判禁用，仍走完整点击链路。
  let enabledEnsureClickCalls = 0;
  let enabledSuccessQueryCalls = 0;
  const makeExecutionSuccessMessage9G = (text = 'Execution succeeded', success = true) => ({
    textContent: text,
    hidden: false,
    className: success ? 'ant-message-custom-content ant-message-success' : 'ant-message-custom-content',
    parentElement: null,
    getAttribute: () => null,
    querySelector: () => null
  });
  const { ensureACState: ensureEnabled } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { enabledEnsureClickCalls += 1; return true; },
    async () => false,
    async () => ({ reached: false, status: { isOn: false } }),
    async () => {},
    3,
    10000,
    0,
    createEnsureLease9G(),
    {
      querySelectorAll: () => (++enabledSuccessQueryCalls % 2 === 1
        ? []
        : [makeExecutionSuccessMessage9G()])
    },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const enabledEnsureResult = await ensureEnabled(createEnsureAttempt9G({
    requestId: 'enabled-test'
  }));
  assertPass(enabledEnsureResult.success === false
      && enabledEnsureResult.clicks === 3
      && enabledEnsureClickCalls === 3,
    '9G-6: 启用开关（free mode）不判禁用，仍走 3 次点击链路后才失败');
  const successHelperStart9G = pageConfirmSource.indexOf(
    'function findACToggleExecutionSuccessMessagesInPageWorld()'
  );
  const successHelperEnd9G = pageConfirmSource.indexOf(
    '\n  function findACSwitchInPageWorld()', successHelperStart9G
  );
  const successHelperSource9G = successHelperStart9G >= 0 && successHelperEnd9G > successHelperStart9G
    ? pageConfirmSource.slice(successHelperStart9G, successHelperEnd9G)
    : '';
  let successHelperBehavior9G = null;
  if (successHelperSource9G) {
    const staleMessage9G = makeExecutionSuccessMessage9G();
    const freshMessage9G = makeExecutionSuccessMessage9G();
    const wrongTextMessage9G = makeExecutionSuccessMessage9G('Operation queued');
    const wrongSemanticMessage9G = makeExecutionSuccessMessage9G('Execution succeeded', false);
    const loadSuccessHelpers9G = (document, getACStatusInPageWorld = () => ({ isOn: null })) => new Function(
      'document', 'getACStatusInPageWorld', 'sleepInPageWorld', 'automaticOnCancellationRevision',
      'AC_ON_SUCCESS_TEXT', 'console',
      `${successHelperSource9G}; return {
        findACToggleExecutionSuccessMessagesInPageWorld,
        waitForNewACToggleExecutionSuccessInPageWorld,
        waitForTargetACStateInPageWorld:
          typeof waitForTargetACStateInPageWorld === 'function'
            ? waitForTargetACStateInPageWorld
            : null
      };`
    )(document, getACStatusInPageWorld, async () => {}, 0, 'Execution succeeded', testConsole);
    const staleHelpers9G = loadSuccessHelpers9G({ querySelectorAll: () => [staleMessage9G] });
    const staleResult9G = await staleHelpers9G.waitForNewACToggleExecutionSuccessInPageWorld(
      new Set([staleMessage9G]), 0, 0, 0
    );
    const freshHelpers9G = loadSuccessHelpers9G({ querySelectorAll: () => [staleMessage9G, freshMessage9G] });
    const freshResult9G = await freshHelpers9G.waitForNewACToggleExecutionSuccessInPageWorld(
      new Set([staleMessage9G]), 0, 0, 0
    );
    const rejectedHelpers9G = loadSuccessHelpers9G({
      querySelectorAll: () => [wrongTextMessage9G, wrongSemanticMessage9G]
    });
    let delayedTargetStatusCalls9G = 0;
    const delayedTargetHelpers9G = loadSuccessHelpers9G(
      { querySelectorAll: () => [] },
      () => ({
        isOn: ++delayedTargetStatusCalls9G >= 3,
        disabled: false,
        source: 'main-world-ant-switch'
      })
    );
    const delayedTargetResult9G = delayedTargetHelpers9G.waitForTargetACStateInPageWorld
      ? await delayedTargetHelpers9G.waitForTargetACStateInPageWorld(true, 25, 0, 0)
      : null;
    successHelperBehavior9G = {
      staleResult9G,
      freshResult9G,
      rejectedCount: rejectedHelpers9G.findACToggleExecutionSuccessMessagesInPageWorld().length,
      delayedTargetResult9G,
      delayedTargetStatusCalls9G
    };
  }
  let clickedSuccessStatusCalls9G = 0;
  let clickedSuccessQueryCalls9G = 0;
  let clickedSuccessClickCalls9G = 0;
  const { ensureACState: ensureClickedSuccess9G } = loadEnsure(
    () => ({
      isOn: (++clickedSuccessStatusCalls9G, false),
      disabled: false,
      source: 'main-world-ant-switch'
    }),
    async () => ({}),
    () => { clickedSuccessClickCalls9G += 1; return true; },
    async () => false,
    async () => ({
      reached: true,
      status: { isOn: true, disabled: false, source: 'main-world-ant-switch' }
    }),
    async () => {},
    3,
    10000,
    0,
    createEnsureLease9G(),
    {
      querySelectorAll: () => (++clickedSuccessQueryCalls9G === 1
        ? []
        : [makeExecutionSuccessMessage9G()])
    },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const clickedSuccessResult9G = await ensureClickedSuccess9G(createEnsureAttempt9G({
    requestId: 'clicked-success-test'
  }));
  let missingSuccessStatusCalls9G = 0;
  const { ensureACState: ensureMissingSuccess9G } = loadEnsure(
    () => ({
      isOn: ++missingSuccessStatusCalls9G >= 3,
      disabled: false,
      source: 'main-world-ant-switch'
    }),
    async () => ({}),
    () => true,
    async () => false,
    async () => ({ reached: true, status: { isOn: true } }),
    async () => {},
    3,
    10000,
    0,
    createEnsureLease9G(),
    { querySelectorAll: () => [] },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const missingSuccessResult9G = await ensureMissingSuccess9G(createEnsureAttempt9G({
    requestId: 'missing-success-test'
  }));
  let alreadyOnSuccessQueries9G = 0;
  const { ensureACState: ensureAlreadyOn9G } = loadEnsure(
    () => ({ isOn: true, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => true,
    async () => false,
    async () => ({ reached: true, status: { isOn: true } }),
    async () => {},
    3,
    10000,
    0,
    createEnsureLease9G(),
    { querySelectorAll: () => { alreadyOnSuccessQueries9G += 1; return []; } },
    'Execution succeeded',
    0,
    60000,
    testConsole
  );
  const alreadyOnResult9G = await ensureAlreadyOn9G(createEnsureAttempt9G({
    requestId: 'already-on-test'
  }));
  assertPass(successHelperBehavior9G?.staleResult9G?.success === false
      && successHelperBehavior9G?.freshResult9G?.success === true
      && successHelperBehavior9G?.rejectedCount === 0
      && successHelperBehavior9G?.delayedTargetResult9G?.reached === true
      && successHelperBehavior9G?.delayedTargetStatusCalls9G === 3
      && clickedSuccessResult9G.success === true
      && clickedSuccessResult9G.executionSucceeded === true
      && clickedSuccessClickCalls9G === 1
      && missingSuccessResult9G.success === false
      && missingSuccessResult9G.executionConfirmationMissing === true
      && alreadyOnResult9G.success === true
      && alreadyOnResult9G.alreadyDone === true
      && alreadyOnResult9G.executionSucceeded === false
      && alreadyOnSuccessQueries9G === 0,
    '9G-6A: 旧/伪提示不采信；新提示后等待迟到 ON 且只点一次；缺提示失败；原本已 ON 幂等');
  assertPass(/executionConfirmationMissing:\s*mainWorldResult\?\.executionConfirmationMissing === true/
        .test(contentSource)
      && backgroundSource.includes(
        'executionConfirmationMissing: result?.executionConfirmationMissing === true'
      )
      && backgroundSource.includes('result?.executionConfirmationMissing === true')
      && !pwmBody.includes('observations.acIsOn = actual?.isOn;'),
    '9G-6B: 缺少 Execution succeeded 标记贯穿主世界→content→后台，终止刷新且 PWM 同轮 ON 复核不绕过');
  assertPass(countOccurrences(pwmBody, "toggleAC('on', {") === 1
      && !pwmBody.includes('for (let retry'),
    '9H: 每个 PWM 开机步骤只调用一次 toggleAC(on)，无外围点击重试循环');
  const smartWindowGuardIndex = pwmBody.indexOf('planSmartModeOnWindow(schedule');
  const smartWindowPlanIndex = pwmBody.indexOf(
    'const smartOnWindow = planSmartAutomaticOn(targetAction, observations.acIsOn);'
  );
  const smartToggleBranchIndex = pwmBody.indexOf(
    "if (plan.kind === 'hold' && plan.prerequisite === 'toggle-on')"
  );
  const smartBoundaryPersistIndex = pwmBody.indexOf(
    "persistSchedule('runPwmStep-smart-on-boundary'"
  );
  const toggleOnIndex = pwmBody.indexOf("toggleAC('on', {");
  assertPass(smartWindowGuardIndex >= 0
      && smartWindowGuardIndex < toggleOnIndex
      && smartWindowPlanIndex > toggleOnIndex
      && smartWindowPlanIndex < smartToggleBranchIndex
      && smartBoundaryPersistIndex > smartWindowPlanIndex
      && smartBoundaryPersistIndex < smartToggleBranchIndex
      && countOccurrences(
        pwmBody,
        'planSmartAutomaticOn(targetAction, observations.acIsOn)'
      ) === 1
      && pwmBody.includes("schedule.smartMode?.enabled && targetAction === 'on'")
      && pwmBody.includes('maxOnMinutes: SMART_MODE.ON_MAX')
      && pwmBody.includes('acIsOn')
      && pwmBody.includes('boundaryAt: retryingSmartOn')
      && pwmBody.includes(': schedule.smartOnBoundaryAt')
      && pwmBody.includes('schedule.smartOnBoundaryAt = Number(smartOnWindow.boundaryAt) || 0;')
      && pwmBody.includes("persistSchedule('runPwmStep-smart-on-boundary', { syncFromLiveAlarm: false })")
      && pwmBody.includes('observations.smartOnWindowEndsAt = Number(smartOnWindow.windowEndsAt) || 0;')
      && pwmBody.includes('notAfterAt: getAutomaticOnDeadline(observations.smartOnWindowEndsAt || 0)')
      && pwmBody.includes('observations.smartPageTimerTargetAt = Number(smartOnWindow.pageTimerTargetAt);'),
    '9H-1: production 仅在智能自动 ON 分支统一规划；物理开机前持久化锚点并透传首分钟截止');
  assertPass(setTimerBody.includes('targetAt = 0')
      && setTimerBody.includes('writePageTimerOnExactHomeTab(tab.id, minutes')
      && backgroundSource.includes("action: 'setTimer'")
      && setTimerBody.includes('targetAt')
      && contentSource.includes('setPagePowerOffTimer(msg.minutes, msg.targetAt)'),
    '9H-2: 智能半点绝对关机截止时间由 background 透传到 content，不退化为相对分钟');
  assertPass(pwmBody.includes('SMART_MODE.MIN_OFF_MINUTES')
      && pwmBody.includes('const observedCommitAt = Date.now();')
      && pwmBody.includes('Math.max(')
      && pwmBody.includes('alignSmartModeNextTrigger(plan, smartAlignNow, { notBeforeAt })'),
    '9H-3: 智能 OFF 提交从不早于实际观察时刻保留至少 5 分钟，再对齐下一半点 ON');
  assertPass(!backgroundSource.includes('retryExistingTabToggle')
      && !backgroundSource.includes('async function retryToggle'),
    '9I: background 已删除四次即时消息重试路径');
  assertPass(existingTabBody.includes("attemptACToggleWithRecovery(tab.id, action, 1, '', options)")
      && existingTabBody.includes('async function refreshACControlPage(tabId)')
      && existingTabBody.includes('return attemptACToggleWithRecovery(')
      && existingTabBody.includes('refreshesRemaining - 1')
      && existingTabBody.includes('await chrome.tabs.reload(tabId)')
      && existingTabBody.includes('await chrome.tabs.update(tabId, { url: AC_PAGE })')
      && existingTabBody.includes('await waitForTabReady(tabId, 30000, isACHomePageTab)')
      && existingTabBody.includes('recoveredByPageRefresh: true'),
    '9J: 开机恢复收束为有限递归函数，等待控制页精确回到 home 后最多重试一次');
  assertPass(!contentSource.includes('function dispatchUserClick(')
      && !contentSource.includes('async function clickConfirmDialog('),
    '9K: content 隔离世界不存在第二套开关/确认点击器');
  assertPass(contentSource.includes("=== 'Air Conditioning Balance'")
      && contentSource.includes("container.querySelector('.ant-progress-text')")
      && contentSource.includes("container.querySelectorAll('small')")
      && contentSource.includes('hasChargeModeLabel')
      && contentSource.includes('classifyACBalanceReading')
      && contentSource.includes("'not-charge-mode'")
      && contentSource.includes('value.getAttribute(\'title\')')
      && contentSource.includes('return withBalance({ ...mainWorldStatus'),
    '9K-1: content 在余额标题区块读取当前进度值，并区分有效、暂不可读与明确非 Charge Mode');
  const chargeModeLabelStart = contentSource.indexOf('function hasChargeModeLabel(elements)');
  const chargeModeLabelEnd = contentSource.indexOf('\nfunction getACBalanceSnapshot()', chargeModeLabelStart);
  const balanceClassifierSource = contentSource.slice(chargeModeLabelStart, chargeModeLabelEnd);
  const { hasChargeModeLabel, classifyACBalanceReading } = new Function(
    'parseBalanceMinutes',
    `${balanceClassifierSource}; return { hasChargeModeLabel, classifyACBalanceReading };`
  )(parseBalanceMinutes);
  assertPass(hasChargeModeLabel([{ textContent: 'Charge Mode' }])
      && hasChargeModeLabel([{ textContent: '  Charge Mode  ' }])
      && !hasChargeModeLabel([{ textContent: 'Normal Mode' }])
      && !hasChargeModeLabel([{ textContent: 'Charge Mode Active' }])
      && !hasChargeModeLabel([]),
    '9K-2: Charge Mode 标签判定接受精确文本与空白，拒绝其他模式和相似文本');
  const availableBalance9K = classifyACBalanceReading(
    [{ textContent: 'Charge Mode' }],
    '156 min',
    ''
  );
  const transientBalance9K = classifyACBalanceReading([], '156 min', '');
  const partialRenderBalance9K = classifyACBalanceReading(
    [
      { textContent: 'No notices' },
      { textContent: 'left of 22100 min balance' },
      { textContent: 'Power-off after' }
    ],
    '156 min',
    ''
  );
  const otherModeBalance9K = classifyACBalanceReading(
    [{ textContent: 'Normal Mode' }],
    '156 min',
    ''
  );
  assertPass(availableBalance9K.state === 'available'
      && availableBalance9K.balanceMinutes === 156
      && transientBalance9K.state === 'unavailable'
      && transientBalance9K.balanceMinutes === null
      && partialRenderBalance9K.state === 'unavailable'
      && partialRenderBalance9K.balanceMinutes === null
      && otherModeBalance9K.state === 'not-charge-mode'
      && otherModeBalance9K.balanceMinutes === null,
    '9K-3: 余额读取把真实邻近说明文本视为半渲染态，仅明确其他 Mode 才清除 Est 缓存');
  const offProofPlan9L = pwmPhase.planPwmStep({
    enabled: true,
    pwmState: 'off',
    onMinutes: 10,
    offMinutes: 20
  }, {
    acIsOn: true,
    proofFresh: true
  }, { now: 1_700_000_000_000 });
  assertPass(!backgroundSource.includes("toggleAC('off')")
      && pwmBody.includes('observations.proofFresh = isPageTimerProofFresh(schedule)')
      && offProofPlan9L.kind === 'commit'
      && offProofPlan9L.nextAction === 'on'
      && !offProofPlan9L.prerequisite,
    '9L: 自动关机只提交页面定时器证明，planner 与 adapter 均不存在 OFF 点击');
  assertPass(!contentSource.includes("error: t('contentCrossDayLimit')")
      && contentSource.includes('crossesMidnight,'),
    '9M: Power-off after 跨午夜时间直接输入，不再被代码拒绝');
  const readableStatusWaitStart9M = contentSource.indexOf(
    'async function waitForReadableACStatus('
  );
  const readableStatusWaitEnd9M = contentSource.indexOf(
    '\n\nasync function getAuthoritativeACStatus(',
    readableStatusWaitStart9M
  );
  const readableStatusWaitSource9M = readableStatusWaitStart9M >= 0
      && readableStatusWaitEnd9M > readableStatusWaitStart9M
    ? contentSource.slice(readableStatusWaitStart9M, readableStatusWaitEnd9M)
    : '';
  let transientStatusRecovered9M = false;
  let persistentStatusAmbiguityRefused9M = false;
  if (readableStatusWaitSource9M) {
    const transientStatuses9M = [
      { isOn: null, error: 'React 双树' },
      { isOn: true, source: 'isolated-retry' }
    ];
    let transientStatusIndex9M = 0;
    const waitForTransientStatus9M = new Function(
      'getACStatus', 'sleep',
      `${readableStatusWaitSource9M}; return waitForReadableACStatus;`
    )(
      () => transientStatuses9M[Math.min(
        transientStatusIndex9M++,
        transientStatuses9M.length - 1
      )],
      ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1)))
    );
    transientStatusRecovered9M = (await waitForTransientStatus9M(25, 1))?.isOn === true;

    const waitForAmbiguousStatus9M = new Function(
      'getACStatus', 'sleep',
      `${readableStatusWaitSource9M}; return waitForReadableACStatus;`
    )(
      () => ({ isOn: null, error: '持续歧义' }),
      ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1)))
    );
    persistentStatusAmbiguityRefused9M = typeof (
      await waitForAmbiguousStatus9M(4, 1)
    )?.isOn !== 'boolean';
  }
  assertPass(transientStatusRecovered9M && persistentStatusAmbiguityRefused9M,
    '9M-0: AC 状态瞬时不可读时等待唯一可读值；持续歧义仍返回未知且零点击');
  const pageTimerTargetStart = contentSource.indexOf('function computePageTimerTarget(');
  const pageTimerTargetEnd = contentSource.indexOf('\n// 找到 "Power-off after"', pageTimerTargetStart);
  const pageTimerTargetSource = pageTimerTargetStart >= 0 && pageTimerTargetEnd > pageTimerTargetStart
    ? contentSource.slice(pageTimerTargetStart, pageTimerTargetEnd)
    : '';
  const computePageTimerTarget = pageTimerTargetSource
    ? new Function(`${pageTimerTargetSource}; return computePageTimerTarget;`)()
    : null;
  assertPass(typeof computePageTimerTarget === 'function',
    '9M-1: content 暴露可独立验证的页面关机目标纯计算');
  if (typeof computePageTimerTarget === 'function') {
    const targetNow = new Date(2026, 0, 15, 10, 0, 30, 500).getTime();
    const targetExpected = Math.ceil((targetNow + 5 * 60000) / 60000) * 60000;
    const targetResult = computePageTimerTarget(5, targetNow);
    const targetDate = new Date(targetExpected);
    const targetValue = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;
    const midnightNow = new Date(2026, 0, 15, 23, 59, 30, 0).getTime();
    const midnightExpected = Math.ceil((midnightNow + 60000) / 60000) * 60000;
    const midnightResult = computePageTimerTarget(1, midnightNow);
    const smartBoundary = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();
    const smartTargetAt = smartBoundary + 25 * 60000;
    const smartTargetResult = computePageTimerTarget(25, targetNow, smartTargetAt);
    const explicitZeroTargetResult = computePageTimerTarget(5, targetNow, 0);
    const invalidExplicitTargets = [
      smartBoundary - 60000,
      targetNow,
      smartTargetAt + 1,
      smartTargetAt + 0.5,
      String(smartTargetAt)
    ];
    const invalidExplicitTargetsRejected = invalidExplicitTargets.every((invalidTargetAt) => {
      try {
        computePageTimerTarget(25, targetNow, invalidTargetAt);
        return false;
      } catch (error) {
        return /绝对|目标/.test(error?.message || '');
      }
    });
    assertPass(targetResult.targetAt === targetExpected
        && targetResult.value === targetValue
        && targetResult.actualDelayMinutes === (targetExpected - targetNow) / 60000
        && targetResult.actualDelayMinutes > targetResult.requestedMinutes
        && explicitZeroTargetResult.targetAt === targetExpected,
      '9M-2: 非整分请求向上对齐 UST 分钟接口，并保留实际浮点延迟');
    assertPass(midnightResult.targetAt === midnightExpected
        && midnightResult.crossesMidnight === true
        && midnightResult.value === '00:01',
      '9M-3: 23:59:30 的 1 分钟请求安全上取整到次日 00:01');
    assertPass(smartTargetResult.targetAt === smartTargetAt
        && smartTargetResult.value === '10:25'
        && smartTargetResult.actualDelayMinutes < 25,
      '9M-3A: 智能 ON 使用“半点 + 开启分钟数”绝对截止时间，不被相对时长上取整压缩关机窗口');
    assertPass(invalidExplicitTargetsRejected,
      '9M-3B: 显式智能绝对截止时间过期、非整分、非整数或类型错误时拒绝设置，不回退相对 25 分钟');
    assertPass(contentSource.includes('targetAt,')
        && contentSource.includes('actualDelayMinutes,'),
      '9M-4: content setTimer 响应回传 targetAt 与实际延迟给后台');
  }
  const powerOffLocatorSource9M = extractSourceSection(
    contentSource,
    'function findPowerOffTimerInput() {',
    '\n\n// ----- v0.5.10: 读取页面已设置的 "Power-off after" 定时器值',
    'Power-off after unique picker locator'
  );
  const makePickerGroup9M = (pickerCount = 1, text = 'Power-off after') => {
    const inputs = Array.from({ length: pickerCount }, (_, index) => ({
      id: `picker-input-${index}`,
      type: 'text',
      getAttribute: () => null
    }));
    const pickers = inputs.map((input, index) => ({
      id: `picker-${index}`,
      getAttribute: () => null,
      querySelectorAll: selector => selector === 'input' ? [input] : []
    }));
    const container = {
      parentElement: null,
      querySelectorAll: selector => selector === '.ant-picker' ? pickers : []
    };
    return {
      label: { children: [], textContent: text, parentElement: container },
      inputs,
      pickers
    };
  };
  const makePickerDocument9M = (groups, dropdowns = [], activeElement = null) => ({
    activeElement,
    querySelectorAll(selector) {
      if (selector === 'small, label, div, span') return groups.map(group => group.label);
      if (selector === '.ant-picker-dropdown') return dropdowns;
      return [];
    },
    getElementById: () => null
  });
  const loadPickerLocator9M = document => new Function(
    'document', 'console',
    `${powerOffLocatorSource9M}; return {
      findPowerOffTimerInput,
      findPowerOffTimerControl,
      clickUniquePowerOffPickerOk
    };`
  )(document, testConsole);
  const uniquePickerGroup9M = makePickerGroup9M(1);
  const uniquePickerLocator9M = loadPickerLocator9M(
    makePickerDocument9M([uniquePickerGroup9M])
  );
  const ambiguousPickerGroup9M = makePickerGroup9M(2);
  const duplicatePickerGroupA9M = makePickerGroup9M(1);
  const duplicatePickerGroupB9M = makePickerGroup9M(1);
  assertPass(uniquePickerLocator9M.findPowerOffTimerInput() === uniquePickerGroup9M.inputs[0]
      && loadPickerLocator9M(makePickerDocument9M([])).findPowerOffTimerInput() === null
      && loadPickerLocator9M(
        makePickerDocument9M([ambiguousPickerGroup9M])
      ).findPowerOffTimerInput() === null
      && loadPickerLocator9M(
        makePickerDocument9M([duplicatePickerGroupA9M, duplicatePickerGroupB9M])
      ).findPowerOffTimerInput() === null,
    '9M-5: Power-off after 只接受唯一语义区内唯一 picker；无标签、同区多个或重复语义区均失败关闭');

  const makeVisiblePickerDropdown9M = (buttons) => ({
    className: 'ant-picker-dropdown',
    hidden: false,
    getAttribute: () => null,
    matches: selector => selector === '.ant-picker-dropdown',
    querySelectorAll: () => buttons
  });
  let uniquePickerOkClicks9M = 0;
  const uniquePickerOkButton9M = { click: () => { uniquePickerOkClicks9M += 1; } };
  const uniqueDropdown9M = makeVisiblePickerDropdown9M([uniquePickerOkButton9M]);
  const linkedPickerDocument9M = makePickerDocument9M(
    [uniquePickerGroup9M],
    [uniqueDropdown9M],
    uniquePickerGroup9M.inputs[0]
  );
  const linkedPickerLocator9M = loadPickerLocator9M(linkedPickerDocument9M);
  const linkedPickerControl9M = linkedPickerLocator9M.findPowerOffTimerControl();
  const uniqueOkResult9M = linkedPickerLocator9M.clickUniquePowerOffPickerOk(
    linkedPickerControl9M,
    new Set()
  );
  let explicitlyLinkedPickerOkClicks9M = 0;
  const explicitlyLinkedGroup9M = makePickerGroup9M(1);
  const explicitlyLinkedDropdown9M = makeVisiblePickerDropdown9M([{
    click: () => { explicitlyLinkedPickerOkClicks9M += 1; }
  }]);
  explicitlyLinkedDropdown9M.id = 'power-off-dropdown';
  explicitlyLinkedGroup9M.inputs[0].getAttribute = attribute => (
    attribute === 'aria-controls' ? explicitlyLinkedDropdown9M.id : null
  );
  explicitlyLinkedGroup9M.pickers[0].getAttribute = attribute => (
    attribute === 'aria-owns' ? explicitlyLinkedDropdown9M.id : null
  );
  const explicitlyLinkedDocument9M = makePickerDocument9M(
    [explicitlyLinkedGroup9M],
    [explicitlyLinkedDropdown9M]
  );
  explicitlyLinkedDocument9M.getElementById = id => (
    id === explicitlyLinkedDropdown9M.id ? explicitlyLinkedDropdown9M : null
  );
  const explicitlyLinkedLocator9M = loadPickerLocator9M(explicitlyLinkedDocument9M);
  const explicitlyLinkedOkResult9M = explicitlyLinkedLocator9M.clickUniquePowerOffPickerOk(
    explicitlyLinkedLocator9M.findPowerOffTimerControl(),
    new Set([explicitlyLinkedDropdown9M])
  );
  let preExistingUnrelatedOkClicks9M = 0;
  const preExistingUnrelatedDropdown9M = makeVisiblePickerDropdown9M([{
    click: () => { preExistingUnrelatedOkClicks9M += 1; }
  }]);
  const preExistingUnrelatedLocator9M = loadPickerLocator9M(makePickerDocument9M(
    [uniquePickerGroup9M],
    [preExistingUnrelatedDropdown9M],
    uniquePickerGroup9M.inputs[0]
  ));
  const preExistingUnrelatedResult9M = preExistingUnrelatedLocator9M.clickUniquePowerOffPickerOk(
    preExistingUnrelatedLocator9M.findPowerOffTimerControl(),
    new Set([preExistingUnrelatedDropdown9M])
  );
  let ambiguousPickerOkClicks9M = 0;
  const ambiguousDropdowns9M = [
    makeVisiblePickerDropdown9M([{ click: () => { ambiguousPickerOkClicks9M += 1; } }]),
    makeVisiblePickerDropdown9M([{ click: () => { ambiguousPickerOkClicks9M += 1; } }])
  ];
  const ambiguousDropdownLocator9M = loadPickerLocator9M(makePickerDocument9M(
    [uniquePickerGroup9M],
    ambiguousDropdowns9M,
    uniquePickerGroup9M.inputs[0]
  ));
  const ambiguousOkResult9M = ambiguousDropdownLocator9M.clickUniquePowerOffPickerOk(
    ambiguousDropdownLocator9M.findPowerOffTimerControl(),
    new Set()
  );
  assertPass(uniqueOkResult9M.accepted === true
      && uniqueOkResult9M.clicked === true
      && uniquePickerOkClicks9M === 1
      && explicitlyLinkedOkResult9M.accepted === true
      && explicitlyLinkedOkResult9M.clicked === true
      && explicitlyLinkedPickerOkClicks9M === 1
      && preExistingUnrelatedResult9M.accepted === false
      && preExistingUnrelatedResult9M.clicked === false
      && preExistingUnrelatedOkClicks9M === 0
      && ambiguousOkResult9M.accepted === false
      && ambiguousOkResult9M.clicked === false
      && ambiguousPickerOkClicks9M === 0,
    '9M-6: picker portal 仅点击显式关联或唯一新 dropdown；既有无关层与多个新层均零点击');
  const confirmedTimerWaitStart9M = contentSource.indexOf(
    'function isPowerOffTimerConfirmationAccepted('
  );
  const confirmedTimerWaitEnd9M = contentSource.indexOf(
    '\n\nfunction setNativeInputValue(',
    confirmedTimerWaitStart9M
  );
  const confirmedTimerWaitSource9M = confirmedTimerWaitStart9M >= 0
      && confirmedTimerWaitEnd9M > confirmedTimerWaitStart9M
    ? contentSource.slice(confirmedTimerWaitStart9M, confirmedTimerWaitEnd9M)
    : '';
  let transientTimerRecovered9M = false;
  let persistentAmbiguityRefused9M = false;
  let transientRollbackRefused9M = false;
  let persistentDropdownRefused9M = false;
  let confirmationPredicatePreserved9M = false;
  if (confirmedTimerWaitSource9M) {
    const confirmedInput9M = {
      value: '00:21',
      getAttribute: () => null
    };
    const { isPowerOffTimerConfirmationAccepted } = new Function(
      `${confirmedTimerWaitSource9M}; return { isPowerOffTimerConfirmationAccepted };`
    )();
    const existingDropdown9M = {};
    const openedDropdown9M = {};
    const acceptedConfirmation9M = {
      input: confirmedInput9M,
      rawValue: '',
      rawTitle: '00:21',
      expectedValue: '00:21',
      ariaExpanded: 'false',
      visibleDropdowns: [existingDropdown9M],
      visibleBefore: new Set([existingDropdown9M]),
      openedDropdown: null
    };
    confirmationPredicatePreserved9M = isPowerOffTimerConfirmationAccepted(
      acceptedConfirmation9M
    ) === true
      && isPowerOffTimerConfirmationAccepted({
        ...acceptedConfirmation9M,
        rawValue: '00:20'
      }) === false
      && isPowerOffTimerConfirmationAccepted({
        ...acceptedConfirmation9M,
        ariaExpanded: 'true'
      }) === false
      && isPowerOffTimerConfirmationAccepted({
        ...acceptedConfirmation9M,
        visibleDropdowns: [openedDropdown9M],
        visibleBefore: new Set(),
        openedDropdown: openedDropdown9M
      }) === false;
    const transientSequence9M = [null, confirmedInput9M, confirmedInput9M];
    let transientIndex9M = 0;
    const waitForTransientTimer9M = new Function(
      'findPowerOffTimerInput', 'sleep', 'findVisiblePickerDropdowns',
      `${confirmedTimerWaitSource9M}; return waitForConfirmedPowerOffTimerInput;`
    )(
      () => transientSequence9M[Math.min(
        transientIndex9M++,
        transientSequence9M.length - 1
      )],
      ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
      () => []
    );
    // Windows Node through WSL interop can overshoot a nominal 1ms timer by
    // tens of milliseconds. Keep this behavior test about transient DOM
    // ambiguity, not host timer granularity.
    transientTimerRecovered9M = await waitForTransientTimer9M('00:21', {
      timeoutMs: 250,
      pollIntervalMs: 1,
      stableWindowMs: 5
    })
      === confirmedInput9M;

    const waitForAmbiguousTimer9M = new Function(
      'findPowerOffTimerInput', 'sleep', 'findVisiblePickerDropdowns',
      `${confirmedTimerWaitSource9M}; return waitForConfirmedPowerOffTimerInput;`
    )(
      () => null,
      ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
      () => []
    );
    persistentAmbiguityRefused9M = await waitForAmbiguousTimer9M('00:21', {
      timeoutMs: 4,
      pollIntervalMs: 1,
      stableWindowMs: 2
    })
      === null;

    const rolledBackInput9M = {
      value: '',
      getAttribute: () => null
    };
    const rollbackSequence9M = [confirmedInput9M, confirmedInput9M, rolledBackInput9M];
    let rollbackIndex9M = 0;
    const waitForRollbackTimer9M = new Function(
      'findPowerOffTimerInput', 'sleep', 'findVisiblePickerDropdowns',
      `${confirmedTimerWaitSource9M}; return waitForConfirmedPowerOffTimerInput;`
    )(
      () => rollbackSequence9M[Math.min(
        rollbackIndex9M++,
        rollbackSequence9M.length - 1
      )],
      ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
      () => []
    );
    transientRollbackRefused9M = await waitForRollbackTimer9M('00:21', {
      timeoutMs: 20,
      pollIntervalMs: 1,
      stableWindowMs: 1000
    })
      === null;

    const stillOpenDropdown9M = makeVisiblePickerDropdown9M([]);
    const waitForClosedDropdown9M = new Function(
      'findPowerOffTimerInput', 'sleep', 'findVisiblePickerDropdowns',
      `${confirmedTimerWaitSource9M}; return waitForConfirmedPowerOffTimerInput;`
    )(
      () => confirmedInput9M,
      ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
      () => [stillOpenDropdown9M]
    );
    persistentDropdownRefused9M = await waitForClosedDropdown9M(
      '00:21',
      {
        timeoutMs: 8,
        pollIntervalMs: 1,
        stableWindowMs: 2,
        visibleBefore: new Set(),
        openedDropdown: stillOpenDropdown9M
      }
    ) === null;
  }
  assertPass(transientTimerRecovered9M
      && persistentAmbiguityRefused9M
      && transientRollbackRefused9M
      && persistentDropdownRefused9M
      && confirmationPredicatePreserved9M,
    '9M-7: picker 必须跨稳定窗口保持目标值且 dropdown 已关闭；短暂双树可恢复，回滚/歧义/持续展开均失败关闭');
  const verificationStartForReload = backgroundSource.indexOf('async function verifyPageTimerPersistence(');
  const verificationEndForReload = backgroundSource.indexOf('\n// 关机定时器设置失败时', verificationStartForReload);
  const verifySectionForReload = verificationStartForReload >= 0 && verificationEndForReload > verificationStartForReload
    ? backgroundSource.slice(verificationStartForReload, verificationEndForReload)
    : '';
  assertPass(countOccurrences(backgroundSource, 'chrome.tabs.reload(') === 1
      && countOccurrences(backgroundSource, 'chrome.tabs.update(') === 1
      && !backgroundSource.includes('async function restoreDiscardedACTab(tab)')
      && !verifySectionForReload.includes('chrome.tabs.reload(')
      && !verifySectionForReload.includes('chrome.tabs.update(')
      && !verifySectionForReload.includes('sourceWasAutoCreated'),
    '9N: background 仅在开机恢复函数内 reload 或回到精确 home；页面定时器验证仍不刷新来源页');
  assertPass(setTimerBody.includes('chrome.tabs.create({ url: AC_PAGE, active: false })')
      && setTimerBody.includes('!candidate.discarded'),
    '9O: 页面定时器缺少未丢弃的精确 home 时只创建隐藏 AC 页，不恢复或刷新用户页面');
  assertPass(setTimerBody.includes('tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded)')
      && !setTimerBody.includes('tabs[0]')
      && !setTimerBody.includes('chrome.tabs.update(')
      && backgroundSource.includes('waitForTabReady(tabId, 30000, isACHomePageTab)')
      && backgroundSource.includes('const tab = await getExactACHomeTab(tabId);')
      && backgroundSource.includes("error: '页面定时器目标标签已离开精确 home URL'")
      && setTimerBody.includes('getExactACHomeTab(preferredTabId)'),
    '9O-1: 页面定时器只等待／复用精确 home；隐藏页过渡业务子页不得抢跑，也不改写其他标签');
  assertPass(contentSource.includes('function normalizeContentLocale(raw)')
      && contentSource.includes("if (/^en(?:_|$)/i.test(normalized)) return 'en';")
      && contentSource.includes('const ui = normalizeContentLocale(chrome.i18n?.getUILanguage?.());'),
    '9O-2: content 内联 i18n 与共享加载器一致，将 en-US/en-GB 映射到 _locales/en');
  const normalizeLocaleStart = contentSource.indexOf('function normalizeContentLocale(raw)');
  const normalizeLocaleEnd = contentSource.indexOf('\nasync function _i18nLoad()', normalizeLocaleStart);
  const normalizeContentLocale = new Function(
    `${contentSource.slice(normalizeLocaleStart, normalizeLocaleEnd)}; return normalizeContentLocale;`
  )();
  assertPass(normalizeContentLocale('en-US') === 'en'
      && normalizeContentLocale('en-GB') === 'en'
      && normalizeContentLocale('zh-CN') === 'zh_CN'
      && normalizeContentLocale() === 'zh_CN',
    '9O-3: content locale 语义验证覆盖 en-US/en-GB、zh-CN 与空语言兜底');
  assertPass(manifest.content_scripts?.[1]?.js?.join(',') === 'billing-helpers.js,content.js'
      && manifest.content_scripts?.every(script => script.matches?.[0] === 'https://w5.ab.ust.hk/njggt/app/home')
      && manifest.content_scripts?.every(script => script.all_frames === false)
      && backgroundSource.includes("files: ['billing-helpers.js', 'content.js']"),
    '9O-4: manifest 只向顶层精确 home 注入，且兜底注入保证余额 helper 先于 content script');
  assertPass(contentSource.includes("const AC_HOME_URL = 'https://w5.ab.ust.hk/njggt/app/home';")
      && contentSource.includes('return window.top === window && window.location.href === AC_HOME_URL;')
      && contentSource.includes('if (isACOperation && !isExactACHomeContext())')
      && contentSource.includes('invalidTarget: true'),
    '9O-5: content 接收端仅在顶层完整 URL 精确 home 处理 AC 消息，形成第二道拒绝防线');
  assertPass(pwmBody.includes('isPageTimerProofFresh(schedule)')
      && backgroundSource.includes('pageTimerTargetAt'),
    '9P: OFF 只接受带绝对到期时间且仍新鲜的页面定时器证明');
  assertPass(newTabBody.includes('finally')
      && newTabBody.includes('ac-close-tab-${tabId}')
      && !newTabBody.includes('if (result?.success)'),
    '9Q: 自动创建的开机标签无论成功失败都会安排回收');
  assertPass(getReadyTabBody.includes(
      'preferredTabId,\n        timeoutMs,\n        isACHomePageTab'
    )
      && getReadyTabBody.includes(
        'await waitForTabReady(tab.id, timeoutMs, isACHomePageTab);'
      ),
    '9Q-1: 新建／候选开机页两条等待都只接受 complete 的精确 home，业务子页不得抢跑');

  const toggleRecoveryStart = backgroundSource.indexOf('async function _toggleOnExistingTab');
  const toggleRecoveryEnd = backgroundSource.indexOf('\nasync function _toggleOnNewTab', toggleRecoveryStart);
  const toggleRecoverySource = toggleRecoveryStart >= 0 && toggleRecoveryEnd > toggleRecoveryStart
    ? backgroundSource.slice(toggleRecoveryStart, toggleRecoveryEnd)
    : '';
  const loadToggleRecovery = new Function(
    'chrome',
    'waitForTabReady',
    'isACTab',
    'isACHomePageTab',
    'ensureContentScriptLoaded',
    'getExactACHomeTab',
    'getReadyACTab',
    'sendMessageToExactACHome',
    'appendDiagnosticLog',
    'console',
    'AC_PAGE',
    'isAutomationAllowed',
    'isAutomationOperationCurrent',
    `${toggleRecoverySource}; return { _toggleOnExistingTab };`
  );
  const quietConsole = { log() {}, warn() {}, error() {} };
  const ignoreDiagnosticLog = async () => {};
  const recoveryCalls = { send: 0, reload: 0, wait: 0, get: 0, ensure: 0 };
  const recoveryChrome = {
    tabs: {
      async sendMessage() {
        recoveryCalls.send += 1;
        if (recoveryCalls.send === 1) {
          throw new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
        }
        return { success: true, state: 'on' };
      },
      async reload(tabId) {
        recoveryCalls.reload += 1;
        assertPass(tabId === 41,
          '9J-1: 首次失败只刷新原精确 home 标签');
      },
      async get(tabId) {
        recoveryCalls.get += 1;
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' };
      }
    }
  };
  const recoveryHarness = loadToggleRecovery(
    recoveryChrome,
    async () => { recoveryCalls.wait += 1; return true; },
    tab => tab?.url?.startsWith('https://w5.ab.ust.hk/njggt/app/'),
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => { recoveryCalls.ensure += 1; return true; },
    async tabId => {
      const tab = await recoveryChrome.tabs.get(tabId);
      return tab?.url === 'https://w5.ab.ust.hk/njggt/app/home' ? tab : null;
    },
    async () => null,
    async (tabId, message) => recoveryChrome.tabs.sendMessage(tabId, message),
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const recoveredToggle = await recoveryHarness._toggleOnExistingTab(
    { id: 41, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  assertPass(recoveredToggle.success === true && recoveredToggle.recoveredByPageRefresh === true,
    '9J-2: bfcache 关闭消息通道后刷新精确 home 并单次重试成功');
  assertPass(recoveryCalls.send === 2 && recoveryCalls.reload === 1
      && recoveryCalls.wait === 1 && recoveryCalls.ensure === 2 && recoveryCalls.get >= 4,
    '9J-3: 恢复链路恰好发送两次、刷新和等待各一次，并在两轮操作前后复核精确 home');

  const ordinaryCalls = { send: 0, reload: 0, diagnostic: [] };
  const ordinaryChrome = {
    tabs: {
      async sendMessage() {
        ordinaryCalls.send += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async reload() { ordinaryCalls.reload += 1; },
      async get() { return { id: 42, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' }; }
    }
  };
  const ordinaryHarness = loadToggleRecovery(
    ordinaryChrome,
    async () => true,
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    async tabId => ordinaryChrome.tabs.get(tabId),
    async () => null,
    async (tabId, message) => ordinaryChrome.tabs.sendMessage(tabId, message),
    (...args) => { ordinaryCalls.diagnostic.push(args); },
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const ordinaryFailure = await ordinaryHarness._toggleOnExistingTab(
    { id: 42, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  const ordinaryRecoveryDiagnostics = ordinaryCalls.diagnostic.filter(
    entry => entry?.[1] === 'toggle-refresh-recovery'
  );
  assertPass(ordinaryFailure.success === false
      && ordinaryFailure.recoveredByPageRefresh === true
      && ordinaryCalls.send === 2 && ordinaryCalls.reload === 1
      && ordinaryRecoveryDiagnostics.length === 1
      && ordinaryRecoveryDiagnostics[0]?.[0] === 'error',
    '9J-4: 普通连接持续失败时恰好刷新一次、发送两次，并保留一次恢复 ERROR');

  const rejectedCalls = { send: 0, reload: 0 };
  const rejectedChrome = {
    tabs: {
      async sendMessage() {
        rejectedCalls.send += 1;
        if (rejectedCalls.send === 1) return { success: false, error: '3 次点击后仍未达到 ON' };
        return { success: true, state: 'on' };
      },
      async reload() { rejectedCalls.reload += 1; },
      async get(tabId) {
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' };
      }
    }
  };
  const rejectedHarness = loadToggleRecovery(
    rejectedChrome,
    async () => true,
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    async tabId => rejectedChrome.tabs.get(tabId),
    async () => null,
    async (tabId, message) => rejectedChrome.tabs.sendMessage(tabId, message),
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const rejectedRecovery = await rejectedHarness._toggleOnExistingTab(
    { id: 44, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  assertPass(rejectedRecovery.success === true && rejectedRecovery.recoveredByPageRefresh === true
      && rejectedCalls.send === 2 && rejectedCalls.reload === 1,
    '9J-5: 主世界明确返回未开启时也刷新 home，等待页面就绪后仅重试一次');

  const missingExecutionCalls = { send: 0, reload: 0, wait: 0, diagnostic: [] };
  const missingExecutionChrome = {
    tabs: {
      async sendMessage() {
        missingExecutionCalls.send += 1;
        return {
          success: false,
          executionConfirmationMissing: true,
          error: '页面未出现新的 Execution succeeded 成功提示'
        };
      },
      async reload() { missingExecutionCalls.reload += 1; },
      async get(tabId) {
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' };
      }
    }
  };
  const missingExecutionHarness = loadToggleRecovery(
    missingExecutionChrome,
    async () => { missingExecutionCalls.wait += 1; return true; },
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    async tabId => missingExecutionChrome.tabs.get(tabId),
    async () => null,
    async (tabId, message) => missingExecutionChrome.tabs.sendMessage(tabId, message),
    (...args) => { missingExecutionCalls.diagnostic.push(args); },
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const missingExecutionRecovery = await missingExecutionHarness._toggleOnExistingTab(
    { id: 46, url: 'https://w5.ab.ust.hk/njggt/app/home' },
    'on'
  );
  assertPass(missingExecutionRecovery.success === false
      && missingExecutionRecovery.executionConfirmationMissing === true
      && missingExecutionCalls.send === 1
      && missingExecutionCalls.reload === 0
      && missingExecutionCalls.wait === 0
      && missingExecutionCalls.diagnostic.length === 0,
    '9J-5A: 缺少本次 Execution succeeded 属于终止结果，后台不刷新绕过提示证据');

  const expiredRecoveryCalls = { send: 0, reload: 0, wait: 0, diagnostic: [] };
  const expiredRecoveryChrome = {
    tabs: {
      async sendMessage() {
        expiredRecoveryCalls.send += 1;
        return { success: false, error: '自动开启窗口已结束' };
      },
      async reload() { expiredRecoveryCalls.reload += 1; },
      async get(tabId) {
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' };
      }
    }
  };
  const expiredRecoveryHarness = loadToggleRecovery(
    expiredRecoveryChrome,
    async () => { expiredRecoveryCalls.wait += 1; return true; },
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    async tabId => expiredRecoveryChrome.tabs.get(tabId),
    async () => null,
    async (tabId, message) => expiredRecoveryChrome.tabs.sendMessage(tabId, message),
    (...args) => { expiredRecoveryCalls.diagnostic.push(args); },
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home',
    () => true,
    () => true
  );
  const expiredRecovery = await expiredRecoveryHarness._toggleOnExistingTab(
    { id: 47, url: 'https://w5.ab.ust.hk/njggt/app/home' },
    'on',
    {
      notAfterAt: Date.now() - 1,
      requireAutomationAllowed: true,
      automationRevision: 9
    }
  );
  assertPass(expiredRecovery.success === false
      && expiredRecovery.error === '自动开启窗口已结束'
      && expiredRecoveryCalls.send === 1
      && expiredRecoveryCalls.reload === 0
      && expiredRecoveryCalls.wait === 0
      && expiredRecoveryCalls.diagnostic.length === 0,
    '9J-5B: 智能 ON 截止已过属于终止结果，后台零刷新、零导航且不写恢复 ERROR');

  const pausedRecoveryCalls = { send: 0, reload: 0, diagnostic: [] };
  const pausedRecoveryChrome = {
    tabs: {
      async sendMessage() { pausedRecoveryCalls.send += 1; return { success: true }; },
      async reload() { pausedRecoveryCalls.reload += 1; },
      async get(tabId) {
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' };
      }
    }
  };
  const pausedRecoveryHarness = loadToggleRecovery(
    pausedRecoveryChrome,
    async () => true,
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    async tabId => pausedRecoveryChrome.tabs.get(tabId),
    async () => null,
    async (tabId, message) => pausedRecoveryChrome.tabs.sendMessage(tabId, message),
    (...args) => { pausedRecoveryCalls.diagnostic.push(args); },
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home',
    () => true,
    () => false
  );
  const pausedRecovery = await pausedRecoveryHarness._toggleOnExistingTab(
    { id: 48, url: 'https://w5.ab.ust.hk/njggt/app/home' },
    'on',
    {
      notAfterAt: Date.now() + 60000,
      requireAutomationAllowed: true,
      automationRevision: 10
    }
  );
  assertPass(pausedRecovery.success === false
      && pausedRecovery.automationPausedByActiveHours === true
      && pausedRecoveryCalls.send === 0
      && pausedRecoveryCalls.reload === 0
      && pausedRecoveryCalls.diagnostic.length === 0,
    '9J-5C: 自动控制 revision 已失效属于终止结果，后台不发送、不刷新且不写恢复 ERROR');

  const driftCalls = { send: 0, reload: 0, update: 0, wait: 0 };
  let driftUrl = 'https://w5.ab.ust.hk/njggt/app/home';
  let driftPendingUrl = '';
  let driftReadyPredicate = null;
  const driftSendUrls = [];
  const driftChrome = {
    tabs: {
      async sendMessage() {
        driftCalls.send += 1;
        driftSendUrls.push(driftUrl);
        if (driftCalls.send === 1) {
          driftUrl = 'https://w5.ab.ust.hk/njggt/app/billing-cycle';
          throw new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
        }
        return { success: true, state: 'on' };
      },
      async reload() { driftCalls.reload += 1; },
      async update(tabId, info) {
        driftCalls.update += 1;
        assertPass(tabId === 45 && info?.url === 'https://w5.ab.ust.hk/njggt/app/home',
          '9J-6: 控制标签偏离时由统一恢复函数输入精确 home URL');
        driftPendingUrl = info.url;
      },
      async get(tabId) {
        return { id: tabId, url: driftUrl, status: 'complete' };
      }
    }
  };
  const driftHarness = loadToggleRecovery(
    driftChrome,
    async (_tabId, _timeoutMs, isReadyTab) => {
      driftCalls.wait += 1;
      driftReadyPredicate = isReadyTab;
      if (typeof isReadyTab !== 'function') return false;
      driftUrl = driftPendingUrl;
      return isReadyTab({ id: 45, url: driftUrl, status: 'complete' });
    },
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    async tabId => {
      const tab = await driftChrome.tabs.get(tabId);
      return tab?.url === 'https://w5.ab.ust.hk/njggt/app/home' ? tab : null;
    },
    async () => null,
    async (tabId, message) => driftChrome.tabs.sendMessage(tabId, message),
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const driftResult = await driftHarness._toggleOnExistingTab(
    { id: 45, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  assertPass(driftResult.success === true && driftResult.recoveredByPageRefresh === true
      && driftCalls.send === 2 && driftCalls.reload === 0
      && driftCalls.update === 1 && driftCalls.wait === 1
      && typeof driftReadyPredicate === 'function'
      && driftReadyPredicate({ url: 'https://w5.ab.ust.hk/njggt/app/billing-cycle' }) === false
      && driftReadyPredicate({ url: 'https://w5.ab.ust.hk/njggt/app/home' }) === true
      && driftSendUrls.length === 2
      && driftSendUrls.every(url => url === 'https://w5.ab.ust.hk/njggt/app/home'),
    '9J-7: BFCache 断口且旧业务页仍 complete 时，等待精确 home 导航完成后才递归重试一次');

  const waitForTabReadyStart = backgroundSource.indexOf('async function waitForTabReady(');
  const waitForTabReadyEnd = backgroundSource.indexOf('\nfunction isACTab(tab)', waitForTabReadyStart);
  const waitForTabReadySource = waitForTabReadyStart >= 0 && waitForTabReadyEnd > waitForTabReadyStart
    ? backgroundSource.slice(waitForTabReadyStart, waitForTabReadyEnd)
    : '';
  let exactReadyGetCalls = 0;
  let exactReadyListenerAdds = 0;
  let exactReadyListenerRemoves = 0;
  const exactReadyEvents = [];
  const exactReadyChrome = {
    tabs: {
      async get(tabId) {
        exactReadyGetCalls += 1;
        const tab = exactReadyGetCalls === 1
          ? { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/billing-cycle', status: 'complete' }
          : { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home', status: 'complete' };
        exactReadyEvents.push(`get:${tab.url}`);
        return tab;
      },
      onUpdated: {
        addListener() {
          exactReadyListenerAdds += 1;
          exactReadyEvents.push('add-listener');
        },
        removeListener() {
          exactReadyListenerRemoves += 1;
          exactReadyEvents.push('remove-listener');
        }
      }
    }
  };
  const waitForTabReady = new Function(
    'chrome', 'isACTab', 'setTimeout', 'clearTimeout',
    `${waitForTabReadySource}; return waitForTabReady;`
  )(
    exactReadyChrome,
    tab => tab?.url?.startsWith('https://w5.ab.ust.hk/njggt/app/'),
    () => 1,
    () => {}
  );
  const exactReadyResult = await waitForTabReady(
    46,
    30000,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home'
  );
  assertPass(exactReadyResult === true
      && exactReadyGetCalls === 2
      && exactReadyListenerAdds === 1
      && exactReadyListenerRemoves === 1
      && exactReadyEvents.join(',') === [
        'get:https://w5.ab.ust.hk/njggt/app/billing-cycle',
        'add-listener',
        'get:https://w5.ab.ust.hk/njggt/app/home',
        'remove-listener'
      ].join(','),
    '9J-8: 精确等待拒绝旧业务页 complete，并在监听后复读捕获已完成的 home 导航');

  const loadGetReadyACTab = new Function(
    'chrome', 'waitForTabReady', 'isACHomePageTab',
    `${getReadyTabBody}; return getReadyACTab;`
  );
  const runGetReadyTransitionCase = async (eventuallyHome, initialTab = null) => {
    let currentTab = initialTab || {
      id: 47,
      url: 'https://w5.ab.ust.hk/njggt/app/home',
      status: 'loading'
    };
    let capturedPredicate = null;
    const calls = [];
    const chromeForReady = {
      tabs: {
        async get(tabId) {
          calls.push(`get:${currentTab.url}:${currentTab.status}`);
          return { ...currentTab, id: tabId };
        },
        async query() {
          calls.push('query');
          return [];
        }
      }
    };
    const getReadyACTab = loadGetReadyACTab(
      chromeForReady,
      async (_tabId, _timeoutMs, isReadyTab) => {
        capturedPredicate = isReadyTab;
        await chromeForReady.tabs.get(_tabId);
        currentTab = {
          id: 47,
          url: 'https://w5.ab.ust.hk/njggt/app/billing-cycle',
          status: 'complete'
        };
        if (typeof isReadyTab !== 'function' || isReadyTab(currentTab)) return true;
        if (!eventuallyHome) return false;
        currentTab = {
          id: 47,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete'
        };
        return isReadyTab(currentTab);
      },
      tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home'
    );
    const result = await getReadyACTab(47, 30000);
    return { result, capturedPredicate, calls };
  };
  const transientReadyCase = await runGetReadyTransitionCase(true);
  const blankNavigationReadyCase = await runGetReadyTransitionCase(true, {
    id: 47,
    url: 'about:blank',
    pendingUrl: 'https://w5.ab.ust.hk/njggt/app/home',
    status: 'loading'
  });
  const permanentNonHomeCase = await runGetReadyTransitionCase(false);
  const loadingHomeChrome = {
    tabs: {
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'loading'
        };
      },
      async query() { return []; }
    }
  };
  const loadingHomeGetReady = loadGetReadyACTab(
    loadingHomeChrome,
    async () => false,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home'
  );
  const permanentLoadingHomeCase = await loadingHomeGetReady(48, 30000);
  assertPass(transientReadyCase.result?.url === 'https://w5.ab.ust.hk/njggt/app/home'
      && blankNavigationReadyCase.result?.url === 'https://w5.ab.ust.hk/njggt/app/home'
      && blankNavigationReadyCase.calls[0] === 'get:about:blank:loading'
      && blankNavigationReadyCase.calls.includes('get:https://w5.ab.ust.hk/njggt/app/home:complete')
      && typeof transientReadyCase.capturedPredicate === 'function'
      && transientReadyCase.capturedPredicate({
        url: 'https://w5.ab.ust.hk/njggt/app/billing-cycle'
      }) === false
      && permanentNonHomeCase.result === null
      && permanentLoadingHomeCase === null,
    '9J-9: 隐藏开机页即使初态 about:blank 也等待 complete 的精确 home；永久非 home 或永久 loading 均保持拒绝');

  // 9T: 初始 tab URL 偏离精确 home 时，必须立即拒绝，不能导航、注入或发送消息。
  const proactiveCalls = { send: 0, update: 0, get: 0, ready: 0, ensure: 0 };
  const proactiveChrome = {
    alarms: { create() {} },
    tabs: {
      async sendMessage() {
        proactiveCalls.send += 1;
        return { success: true, state: 'on' };
      },
      async update(tabId, info) {
        proactiveCalls.update += 1;
        throw new Error(`不应改写非 home 标签 ${tabId}: ${info?.url}`);
      },
      async get(tabId) {
        proactiveCalls.get += 1;
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home' };
      }
    }
  };
  const proactiveHarness = loadToggleRecovery(
    proactiveChrome,
    async () => { proactiveCalls.ready += 1; return true; },
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => { proactiveCalls.ensure += 1; return true; },
    async tabId => proactiveChrome.tabs.get(tabId),
    async () => null,
    async (tabId, message) => proactiveChrome.tabs.sendMessage(tabId, message),
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const proactiveResult = await proactiveHarness._toggleOnExistingTab(
    { id: 43, url: 'https://w5.ab.ust.hk/njggt/app/billing-cycle' }, 'on');
  assertPass(proactiveResult.success === false
      && proactiveResult.invalidTarget === true
      && proactiveCalls.update === 0 && proactiveCalls.send === 0
      && proactiveCalls.ready === 0 && proactiveCalls.get === 0
      && proactiveCalls.ensure === 0,
    '9T-1: billing-cycle 等非精确 home 标签不导航、不注入、不发送空调操作');
  assertPass(!proactiveResult.recoveredByPageRefresh,
    '9T-2: 非精确 home 拒绝路径不冒充端口隐藏页恢复');

  // 9U: 精确 home 判定必须是完整 URL 全等，不接受 slash/query/hash/相似路径。
  assertPass(backgroundSource.includes('function isACHomePageTab(tab)')
      && backgroundSource.includes('return tab?.url === AC_PAGE;')
      && !backgroundSource.includes(`const base = tab.url.split('#')[0].split('?')[0];`)
      && existingTabBody.includes('if (!isACHomePageTab(tab))')
      && existingTabBody.includes('invalidTarget: true'),
    '9U: isACHomePageTab 使用完整 URL 全等，_toggleOnExistingTab 对非 home 目标立即拒绝');

  const homeMatcherStart = backgroundSource.indexOf('function isACHomePageTab(tab)');
  const homeMatcherEnd = backgroundSource.indexOf('\nfunction sleep(ms)', homeMatcherStart);
  const isACHomePageTab = new Function(
    'AC_PAGE',
    `${backgroundSource.slice(homeMatcherStart, homeMatcherEnd)}; return isACHomePageTab;`
  )('https://w5.ab.ust.hk/njggt/app/home');
  assertPass(isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/home' })
      && !isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/home/' })
      && !isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/home?tab=ac' })
      && !isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/home#status' })
      && !isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/home2' })
      && !isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/billing-cycle' })
      && !isACHomePageTab({ url: 'https://w5.ab.ust.hk/njggt/app/login/home' }),
    '9V: 精确 home 真值表拒绝 slash、query、hash、相似路径、billing-cycle 与登录后缀');

  assertPass(toggleOnceBody.includes('tabs.find(tab => isACHomePageTab(tab) && !tab.discarded)')
      && !toggleOnceBody.includes('tabs[0]')
      && toggleOnceBody.includes('chrome.tabs.create({ url: AC_PAGE, active: false })')
      && getStatusBody.includes('tabs.find(isACHomePageTab)')
      && !getStatusBody.includes('tabs[0]')
      && adoptTimerBody.includes('tabs.find(isACHomePageTab)')
      && !adoptTimerBody.includes('tabs[0]'),
    '9W: toggle/status/page-timer adoption 只选择精确 home；写路径缺失时创建隐藏 home');
    assertPass(backgroundSource.includes('async function sendMessageToExactACHome(')
      && backgroundSource.includes('timeoutMs = 0')
      && backgroundSource.includes('requireAutomationAllowed = false')
      && backgroundSource.includes('automationRevision = null')
      && backgroundSource.includes("throw new Error('拒绝向非精确 AC home 标签发送消息')")
      && backgroundSource.includes('if (!await getExactACHomeTab(tabId)) return false;')
      && countOccurrences(backgroundSource, 'sendMessageToExactACHome(') >= 7,
    '9X: 所有 AC 消息发送与兜底注入前重新读取并精确复核 home URL，封堵 await 期间漂移');
    const popupSourceForExactHome = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
    assertPass(!popupSourceForExactHome.includes('tabs[0]')
      && popupSourceForExactHome.includes("tabs.filter(tab => tab.url === 'https://w5.ab.ust.hk/njggt/app/home')")
      && popupSourceForExactHome.includes('const status = bgSchedule.actualStatus;')
      && popupSourceForExactHome.includes("sendDiagnosticRuntimeMessage({ type: 'getPageTimer' })")
      && !popupSourceForExactHome.includes('chrome.tabs.sendMessage(')
      && popupSourceForExactHome.includes('status.invalidTarget !== true')
      && popupSourceForExactHome.includes('pt.invalidTarget !== true'),
    '9Y: popup 诊断只识别精确 home，并复用后台接收端恢复链路读取 status/page timer');

  const contentRuntimeListeners = new Set();
  let contentListenerRemoveCount = 0;
  const contentRuntimeChrome = {
    i18n: { getUILanguage: () => 'zh_CN' },
    runtime: {
      getURL: resource => resource,
      onMessage: {
        addListener(listener) { contentRuntimeListeners.add(listener); },
        removeListener(listener) {
          contentListenerRemoveCount += 1;
          contentRuntimeListeners.delete(listener);
        }
      }
    }
  };
  const contentWindowListeners = new Map();
  const contentWindow = {
    location: { href: 'https://w5.ab.ust.hk/njggt/app/home' },
    addEventListener(type, listener) {
      if (!contentWindowListeners.has(type)) contentWindowListeners.set(type, new Set());
      contentWindowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      contentWindowListeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      if (event.type.endsWith('_GET_RUNTIME__')) {
        const resultType = event.type.replace('_GET_RUNTIME__', '_GET_RUNTIME_RESULT__');
        for (const listener of contentWindowListeners.get(resultType) || []) {
          listener({
            detail: {
              requestId: event.detail.requestId,
              success: true,
              runtimeIdentity: {
                main: {
                  buildTime: 'dev',
                  buildTimeEpochMs: 0,
                  listenerId: 'main-test'
                }
              }
            }
          });
        }
      }
      return true;
    }
  };
  contentWindow.top = contentWindow;
  const contentWorld = {};
  const executeContentScript = new Function(
    'self',
    'window',
    'chrome',
    'fetch',
    'console',
    'document',
    'CustomEvent',
    contentSource
  );
  const runContentScript = () => executeContentScript(
    contentWorld,
    contentWindow,
    contentRuntimeChrome,
    async () => ({ ok: true, json: async () => ({}) }),
    quietConsole,
    {},
    TestCustomEvent
  );
  runContentScript();
  const firstContentListenerCount = contentRuntimeListeners.size;
  // 模拟扩展 reload：页面 JS 全局和旧哨兵仍在，但旧 extension runtime 的
  // onMessage 接收端已经失效。新版本兜底注入必须重新登记监听器。
  contentRuntimeListeners.clear();
  runContentScript();
  assertPass(firstContentListenerCount === 1
      && contentRuntimeListeners.size === 1
      && contentListenerRemoveCount === 1,
    '9Z-1: content.js 重注入会替换旧监听器；扩展 reload 后旧哨兵不会阻止接收端恢复');

  const mainRuntimeListeners9Z = new Map();
  let mainRuntimeListenerRemoveCount9Z = 0;
  const mainRuntimeWindow9Z = {
    addEventListener(type, listener) {
      if (!mainRuntimeListeners9Z.has(type)) mainRuntimeListeners9Z.set(type, new Set());
      mainRuntimeListeners9Z.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      mainRuntimeListenerRemoveCount9Z += 1;
      mainRuntimeListeners9Z.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of mainRuntimeListeners9Z.get(event.type) || []) {
        listener(event);
      }
      return true;
    }
  };
  const executePageConfirm9Z = new Function(
    'window', 'document', 'CustomEvent', 'console',
    pageConfirmSource
  );
  const runPageConfirm9Z = () => executePageConfirm9Z(
    mainRuntimeWindow9Z,
    { querySelectorAll: () => [] },
    TestCustomEvent,
    quietConsole
  );
  runPageConfirm9Z();
  const firstMainBridge9Z = mainRuntimeWindow9Z.__AC_EXTENSION_MAIN_BRIDGE__;
  runPageConfirm9Z();
  const secondMainBridge9Z = mainRuntimeWindow9Z.__AC_EXTENSION_MAIN_BRIDGE__;
  const activeMainBridgeListenerCount9Z = [...mainRuntimeListeners9Z.values()]
    .reduce((total, listeners) => total + listeners.size, 0);
  let mainRuntimeIdentityResponse9Z = null;
  mainRuntimeWindow9Z.addEventListener(
    `${secondMainBridge9Z.channel}_GET_RUNTIME_RESULT__`,
    event => { mainRuntimeIdentityResponse9Z = event.detail; }
  );
  mainRuntimeWindow9Z.dispatchEvent(new TestCustomEvent(
    `${secondMainBridge9Z.channel}_GET_RUNTIME__`,
    { detail: { requestId: 'runtime-test' } }
  ));
  assertPass(firstMainBridge9Z !== secondMainBridge9Z
      && mainRuntimeListenerRemoveCount9Z === 4
      && activeMainBridgeListenerCount9Z === 6
      && typeof firstMainBridge9Z.cancelAndDrain === 'function'
      && pageConfirmSource.includes('await predecessorMainBridgeDrain')
      && pageConfirmSource.includes("'__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'")
      && pageConfirmSource.includes('mainBridgeLease.ownerGeneration')
      && pageConfirmSource.includes('mainBridgeLease.blockedUntil = Math.max(')
      && pageConfirmSource.includes('mainBridgeLease.uncertainClickUntil')
      && mainRuntimeIdentityResponse9Z?.requestId === 'runtime-test'
      && mainRuntimeIdentityResponse9Z?.runtimeIdentity?.main?.listenerId
        === secondMainBridge9Z.listenerId,
    '9Z-1B: page-confirm 热接管先取消并排空旧 ON，再释放旧四类监听器且仅由新 registry 回包');

  const createTakeoverRuntime9Z = ({
    legacy = false,
    switchInitiallyReady = true,
    clickTurnsOn = false
  } = {}) => {
    const listeners = new Map();
    const results = new Map();
    let clickCount = 0;
    let switchReady = switchInitiallyReady;
    let isOn = false;
    let successMessage = null;
    const acSwitch = {
      disabled: false,
      className: 'ant-switch',
      get textContent() { return isOn ? 'ON' : 'OFF'; },
      getAttribute(name) {
        if (name === 'aria-checked') return isOn ? 'true' : 'false';
        return null;
      },
      hasAttribute: () => false,
      matches: () => false,
      querySelector: () => null,
      scrollIntoView() {},
      focus() {},
      click() {
        clickCount += 1;
        if (clickTurnsOn) {
          isOn = true;
          successMessage = {
            textContent: 'Execution succeeded',
            hidden: false,
            className: 'ant-message-custom-content ant-message-success',
            parentElement: null,
            getAttribute: () => null,
            querySelector: () => null
          };
        }
      }
    };
    const switchContainer = {
      parentElement: null,
      querySelectorAll(selector) {
        return selector.includes('ant-switch') ? [acSwitch] : [];
      }
    };
    const statusLabel = {
      children: [],
      textContent: 'Air Conditioning Status',
      parentElement: switchContainer
    };
    const document = {
      querySelectorAll(selector) {
        if (selector === 'small, label, span, div') {
          return switchReady ? [statusLabel] : [];
        }
        if (selector.includes('ant-message')) {
          return successMessage ? [successMessage] : [];
        }
        return [];
      }
    };
    const window = {
      confirm: () => false,
      alert() {},
      prompt: (_message, defaultValue = '') => defaultValue,
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(event) {
        if (event.type.endsWith('_TOGGLE_AC_RESULT__') && event.detail?.requestId) {
          results.set(event.detail.requestId, event.detail);
        }
        for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
        return true;
      }
    };
    if (legacy) window.__AC_EXTENSION_TOGGLE_PATCHED__ = true;
    const inject = () => {
      executePageConfirm9Z(window, document, TestCustomEvent, quietConsole);
      return window.__AC_EXTENSION_MAIN_BRIDGE__;
    };
    const requestOn = (bridge, requestId) => window.dispatchEvent(new TestCustomEvent(
      `${bridge.channel}_TOGGLE_AC__`,
      { detail: { requestId, action: 'on', notAfterAt: Date.now() + 10_000 } }
    ));
    return {
      window,
      inject,
      requestOn,
      results,
      releaseSwitch() { switchReady = true; },
      getClickCount: () => clickCount
    };
  };
  const waitUntil9Z = async (predicate, timeoutMs = 500) => {
    const startedAt = Date.now();
    while (!predicate() && Date.now() - startedAt < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return predicate();
  };

  // A 在物理 click 前等待 switch；B、C 依次接管后再释放 A。B 必须在 drain
  // 之后被 generation 淘汰，C 才能成为唯一可点击 owner。该路径不依赖
  // uncertainClick，专门证明 await predecessor 后的代际复核有效。
  const preClickTakeoverRuntime9Z = createTakeoverRuntime9Z({
    switchInitiallyReady: false,
    clickTurnsOn: true
  });
  const preClickBridgeA9Z = preClickTakeoverRuntime9Z.inject();
  preClickTakeoverRuntime9Z.requestOn(preClickBridgeA9Z, 'pre-click-a');
  const preClickAInFlight9Z = await waitUntil9Z(
    () => !!preClickTakeoverRuntime9Z.window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__?.inFlight
  );
  const preClickBridgeB9Z = preClickTakeoverRuntime9Z.inject();
  preClickTakeoverRuntime9Z.requestOn(preClickBridgeB9Z, 'pre-click-b');
  const preClickBridgeC9Z = preClickTakeoverRuntime9Z.inject();
  preClickTakeoverRuntime9Z.requestOn(preClickBridgeC9Z, 'pre-click-c');
  preClickTakeoverRuntime9Z.releaseSwitch();
  const preClickResultsSettled9Z = await waitUntil9Z(
    () => preClickTakeoverRuntime9Z.results.has('pre-click-a')
      && preClickTakeoverRuntime9Z.results.has('pre-click-b')
      && preClickTakeoverRuntime9Z.results.has('pre-click-c'),
    1500
  );
  const preClickResultB9Z = preClickTakeoverRuntime9Z.results.get('pre-click-b');
  const preClickResultC9Z = preClickTakeoverRuntime9Z.results.get('pre-click-c');
  assertPass(preClickAInFlight9Z
      && preClickResultsSettled9Z
      && preClickResultB9Z?.success === false
      && preClickResultB9Z?.takeoverPending === true
      && preClickResultC9Z?.success === true
      && preClickResultC9Z?.verified === true
      && preClickTakeoverRuntime9Z.getClickCount() === 1,
    '9Z-1B-1: A click 前挂起时，B 在 drain 后被 generation 淘汰，只有最终 owner C 产生唯一 ON click');

  // 行为级接管：A 已经物理 click 后，B、C 连续热注入。新实例必须等 A 收口，
  // 且共享“点击结果未知”租约，不能因为 closure 被替换而再点第二次。
  const takeoverRuntime9Z = createTakeoverRuntime9Z();
  const takeoverBridgeA9Z = takeoverRuntime9Z.inject();
  takeoverRuntime9Z.requestOn(takeoverBridgeA9Z, 'takeover-a');
  const firstTakeoverClickObserved9Z = await waitUntil9Z(
    () => takeoverRuntime9Z.getClickCount() === 1
  );
  const takeoverBridgeB9Z = takeoverRuntime9Z.inject();
  takeoverRuntime9Z.requestOn(takeoverBridgeB9Z, 'takeover-b');
  const takeoverBridgeC9Z = takeoverRuntime9Z.inject();
  takeoverRuntime9Z.requestOn(takeoverBridgeC9Z, 'takeover-c');
  await new Promise(resolve => setTimeout(resolve, 350));
  assertPass(firstTakeoverClickObserved9Z
      && takeoverRuntime9Z.getClickCount() === 1
      && takeoverRuntime9Z.window.__AC_EXTENSION_MAIN_BRIDGE__ === takeoverBridgeC9Z
      && takeoverRuntime9Z.window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__?.ownerGeneration === 3
      && takeoverRuntime9Z.window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__?.uncertainClickUntil > Date.now(),
    '9Z-1C: A→B→C 连续热接管最多产生一次物理 ON click，未知结果租约跨三次注入保留');

  // 无 registry 的旧 build 无法证明是否仍有迟到 click；首次接管建立 60s 共享静默窗，
  // 后续 B/C 注入不得因替换 closure 而把静默窗丢掉。
  const legacyTakeoverRuntime9Z = createTakeoverRuntime9Z({ legacy: true });
  legacyTakeoverRuntime9Z.inject();
  legacyTakeoverRuntime9Z.inject();
  const legacyTakeoverBridgeC9Z = legacyTakeoverRuntime9Z.inject();
  legacyTakeoverRuntime9Z.requestOn(legacyTakeoverBridgeC9Z, 'legacy-c');
  await new Promise(resolve => setTimeout(resolve, 20));
  assertPass(legacyTakeoverRuntime9Z.getClickCount() === 0
      && legacyTakeoverRuntime9Z.window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__?.ownerGeneration === 3
      && legacyTakeoverRuntime9Z.window.__AC_EXTENSION_MAIN_BRIDGE_LEASE__?.blockedUntil > Date.now(),
    '9Z-1D: legacy→A→B→C 连续接管共享 60s 静默窗，重注入不会提前恢复物理点击');

  const currentContentListener = [...contentRuntimeListeners][0];
  let pingResponse = null;
  let unknownResponseCalled = false;
  const pingListenerResult = currentContentListener(
    { action: 'ping' },
    {},
    response => { pingResponse = response; }
  );
  const unknownListenerResult = currentContentListener(
    { action: 'future-unknown-action' },
    {},
    () => { unknownResponseCalled = true; }
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  verboseLog('  content ping identity:', JSON.stringify({
    pingListenerResult,
    pingResponse,
    unknownListenerResult,
    unknownResponseCalled
  }));
  assertPass(pingListenerResult === true
      && pingResponse?.success === true
      && pingResponse?.runtimeIdentity?.content?.buildTime === 'dev'
      && pingResponse?.runtimeIdentity?.main?.buildTime === 'dev'
      && unknownListenerResult === false
      && unknownResponseCalled === false,
    '9Z-1A: content 健康探测异步回传 content/main 身份；未知 action 不吞住消息通道');

  const contentRecoverySource = extractSourceSection(
    backgroundSource,
    'const CONTENT_SCRIPT_PROBE_TIMEOUT_MS = 1000;',
    '\n// ----- 切换 AC 状态 -----',
    'content script recovery helpers'
  );
  const statusRecoverySource = extractSourceSection(
    backgroundSource,
    'async function getCurrentACStatus()',
    '\nasync function ensureScheduleClock(options = {})',
    'getCurrentACStatus recovery'
  );
  const loadStatusRecovery = new Function(
    'chrome',
    'isACHomePageTab',
    'sleep',
    'appendDiagnosticLog',
    'console',
    'AC_PAGE',
    'assessContentRuntimeIdentity',
    `${contentRecoverySource}\n${statusRecoverySource}; return { getCurrentACStatus };`
  );
  const acceptTestRuntimeIdentity = probe => ({
    valid: probe != null,
    code: probe == null ? 'CONTENT-RUNTIME-MISMATCH' : ''
  });
  let staleReceiverReady = false;
  let staleReceiverSendCount = 0;
  const staleReceiverInjections = [];
  const staleReceiverChrome = {
    tabs: {
      async query() {
        return [{
          id: 51,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        }];
      },
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        };
      },
      async sendMessage(tabId, message) {
        staleReceiverSendCount += 1;
        if (!staleReceiverReady) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        if (message.action === 'ping') return { success: true };
        return {
          isOn: true,
          balanceState: 'available',
          balanceMinutes: 156,
          action: message.action,
          tabId
        };
      },
      async reload() { throw new Error('只读状态恢复不得刷新用户页面'); },
      async update() { throw new Error('只读状态恢复不得导航用户页面'); }
    },
    scripting: {
      async executeScript(details) {
        staleReceiverInjections.push(details);
        if (details.files?.includes('content.js')) staleReceiverReady = true;
      }
    }
  };
  const statusRecoveryHarness = loadStatusRecovery(
    staleReceiverChrome,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => {},
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home',
    acceptTestRuntimeIdentity
  );
  const recoveredReadStatus = await statusRecoveryHarness.getCurrentACStatus();
  assertPass(recoveredReadStatus?.isOn === true
      && recoveredReadStatus.balanceMinutes === 156
      && staleReceiverSendCount >= 2
      && staleReceiverInjections.length === 2
      && staleReceiverInjections[0]?.files?.join(',') === 'billing-helpers.js,content.js'
      && staleReceiverInjections[1]?.files?.join(',') === 'page-confirm.js'
      && staleReceiverInjections[1]?.world === 'MAIN',
    '9Z-2: full 状态读取遇到 Receiving end 不存在时原页注入接收端并重试，且不刷新或导航');

  let swallowedReceiverReady = false;
  const swallowedReceiverActions = [];
  const swallowedReceiverInjections = [];
  const swallowedReceiverChrome = {
    tabs: {
      async query() {
        return [{
          id: 52,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        }];
      },
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        };
      },
      async sendMessage(tabId, message) {
        swallowedReceiverActions.push(message.action);
        if (!swallowedReceiverReady) {
          return new Promise(() => {});
        }
        if (message.action === 'ping') return { success: true };
        return {
          isOn: true,
          balanceState: 'available',
          balanceMinutes: 156,
          action: message.action,
          tabId
        };
      },
      async reload() { throw new Error('吞包恢复不得刷新用户页面'); },
      async update() { throw new Error('吞包恢复不得导航用户页面'); }
    },
    scripting: {
      async executeScript(details) {
        swallowedReceiverInjections.push(details);
        if (details.files?.includes('content.js')) swallowedReceiverReady = true;
      }
    }
  };
  const swallowedReceiverHarness = loadStatusRecovery(
    swallowedReceiverChrome,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => {},
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home',
    acceptTestRuntimeIdentity
  );
  const swallowedReceiverOutcome = await Promise.race([
    swallowedReceiverHarness.getCurrentACStatus().then(status => ({ settled: true, status })),
    new Promise(resolve => setTimeout(() => resolve({ settled: false }), 2500))
  ]);
  assertPass(swallowedReceiverOutcome.settled === true
      && swallowedReceiverOutcome.status?.balanceMinutes === 156
      && swallowedReceiverActions.join(',') === 'ping,ping,status'
      && swallowedReceiverInjections.length === 2,
    '9Z-3: 旧 listener 宣称异步却不响应时，健康探测有界超时并在原页重注入后恢复');

  let selectiveReceiverReady = false;
  const selectiveReceiverActions = [];
  const selectiveReceiverInjections = [];
  const selectiveReceiverChrome = {
    tabs: {
      async query() {
        return [{
          id: 53,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        }];
      },
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        };
      },
      async sendMessage(tabId, message) {
        selectiveReceiverActions.push(message.action);
        if (message.action === 'ping') return { success: true };
        if (!selectiveReceiverReady) return new Promise(() => {});
        return {
          isOn: true,
          balanceState: 'available',
          balanceMinutes: 156,
          action: message.action,
          tabId
        };
      },
      async reload() { throw new Error('选择性吞包恢复不得刷新用户页面'); },
      async update() { throw new Error('选择性吞包恢复不得导航用户页面'); }
    },
    scripting: {
      async executeScript(details) {
        selectiveReceiverInjections.push(details);
        if (details.files?.includes('content.js')) selectiveReceiverReady = true;
      }
    }
  };
  const selectiveReceiverHarness = loadStatusRecovery(
    selectiveReceiverChrome,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => {},
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home',
    acceptTestRuntimeIdentity
  );
  const selectiveReceiverOutcome = await Promise.race([
    selectiveReceiverHarness.getCurrentACStatus().then(status => ({ settled: true, status })),
    new Promise(resolve => setTimeout(() => resolve({ settled: false }), 3500))
  ]);
  assertPass(selectiveReceiverOutcome.settled === true
      && selectiveReceiverOutcome.status?.balanceMinutes === 156
      && selectiveReceiverActions.join(',') === 'ping,status,ping,status'
      && selectiveReceiverInjections.length === 2,
    '9Z-3A: ping 正常但 status 被吞时，业务读取超时后强制替换 listener 并只重试一次');

  // 错误页（chrome-error://）兜底注入：executeScript 抛 "showing error page" 时，
  // 读路径不得刷新页面，只降级为 warn 并失败返回，交给看门狗 / PWM 重试自然恢复。
  let errorPageReloadCalls = 0;
  const errorPageDiagnosticLogs = [];
  const errorPageChrome = {
    tabs: {
      async query() {
        return [{
          id: 54,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        }];
      },
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://w5.ab.ust.hk/njggt/app/home',
          status: 'complete',
          discarded: false
        };
      },
      async sendMessage() {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async reload() { errorPageReloadCalls += 1; },
      async update() { throw new Error('读路径错误页恢复不得导航用户页面'); }
    },
    scripting: {
      async executeScript() {
        throw new Error('Frame with ID 0 is showing error page');
      }
    }
  };
  const errorPageHarness = loadStatusRecovery(
    errorPageChrome,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => {},
    async (level, source) => { errorPageDiagnosticLogs.push({ level, source }); },
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home',
    acceptTestRuntimeIdentity
  );
  const errorPageStatus = await errorPageHarness.getCurrentACStatus();
  assertPass(errorPageStatus?.isOn === null
      && errorPageStatus?.error === 'AC 页面未就绪'
      && errorPageReloadCalls === 0
      && errorPageDiagnosticLogs.length === 1
      && errorPageDiagnosticLogs[0]?.level === 'warn'
      && errorPageDiagnosticLogs[0]?.source === 'content-script-injection',
    '9Z-5: 错误页兜底注入不刷新页面，降级为 warn 并失败返回，交给重试恢复');

  assertPass(contentSource.includes('reportContentError')
      && contentSource.includes("window.addEventListener('error'")
      && contentSource.includes("window.addEventListener('unhandledrejection'")
      && contentSource.includes('__AC_EXTENSION_PAGE_ERROR__')
      && contentSource.includes('self.__AC_CONTENT_ERROR_REPORTED__'),
    '9Z-6: 隔离世界采集未捕获异常并桥接主世界错误回传');
  assertPass(pageConfirmSource.includes('__AC_EXTENSION_ERROR_PATCHED__')
      && pageConfirmSource.includes('__AC_EXTENSION_PAGE_ERROR__')
      && pageConfirmSource.includes("window.addEventListener('error'")
      && pageConfirmSource.includes("window.addEventListener('unhandledrejection'")
      && pageConfirmSource.includes('chrome-extension://'),
    '9Z-7: 主世界只回传扩展自身脚本异常，经 CustomEvent 桥接');

  assertPass(countOccurrences(backgroundSource, 'sendReadMessageToExactACHome(') >= 5
      && !backgroundSource.includes("sendMessageToExactACHome(tab.id, { action: 'status' })")
      && !backgroundSource.includes("sendMessageToExactACHome(tab.id, { action: 'getPageTimer' })")
      && !backgroundSource.includes("sendMessageToExactACHome(verifierTabId, { action: 'getPageTimer' })"),
    '9Z-3B: status、page timer、跨设备采纳与新鲜页验证统一走有界只读恢复入口');

  assertPass(backgroundSource.includes('const BACKGROUND_MESSAGE_TYPES = new Set([')
      && backgroundSource.includes('if (!BACKGROUND_MESSAGE_TYPES.has(msg?.type)) return false;'),
    '9Z-4: background 对未知 runtime message 同步放行，不留下永不应答的消息通道');

  const i18nSource = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');
  assertPass(i18nSource.includes("querySelectorAll('[data-i18n-title]')"),
    '9R: i18n 加载器会翻译 data-i18n-title 属性');
  assertPass(i18nSource.includes("if (/^en(?:_|$)/i.test(normalized)) return 'en';"),
    '9S: en-US/en-GB 浏览器语言会映射到作者维护的 _locales/en');

  // ===== 用例 10: v0.7.0 关机不可漏接口契约 =====
  // 防止 v0.5.12 "OFF 零点击" 策略下的「忘记关机」回归：ON 路径推进 pwmState
  // 前 MUST 确认 setPageTimer 成功；失败时保持 pwmState='on' + 提前 return，
  // 不允许把未推进的相位 sync 给对端。pwmBody 在用例 9 中已读出。
  beginSuite('用例 10：关机安全契约',
    '\n\n=== 用例 10: 关机不可漏接口契约 (v0.7.0) ===\n');

  const plannerNow10 = 1_700_000_000_000;
  const plannerOnSchedule10 = {
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 8
  };
  const timerRequiredPlan10 = pwmPhase.planPwmStep(
    plannerOnSchedule10,
    { acIsOn: true },
    { now: plannerNow10 }
  );
  const timerFailedPlan10 = pwmPhase.planPwmStep(
    plannerOnSchedule10,
    { acIsOn: true, pageTimerSucceeded: false },
    { now: plannerNow10 }
  );
  const timerCommittedPlan10 = pwmPhase.planPwmStep(
    plannerOnSchedule10,
    { acIsOn: true, pageTimerSucceeded: true },
    { now: plannerNow10 }
  );
  const plannerPageTarget10 = plannerNow10 + 13 * 60_000;
  const timerTargetCommittedPlan10 = pwmPhase.planPwmStep(
    plannerOnSchedule10,
    {
      acIsOn: true,
      pageTimerSucceeded: true,
      pageTimerTargetAt: plannerPageTarget10
    },
    { now: plannerNow10 }
  );
  const setPageTimerCallIdx = pwmBody.indexOf('const pageTimerResult = await setPageTimer(plan.timerMinutes');
  assertPass(timerRequiredPlan10.kind === 'hold'
      && timerRequiredPlan10.prerequisite === 'set-page-timer'
      && timerRequiredPlan10.timerMinutes === plannerOnSchedule10.onMinutes
      && pwmBody.includes("plan.prerequisite === 'set-page-timer'")
      && setPageTimerCallIdx > 0,
    '10A: ON planner 要求 adapter 先按配置分钟确认页面定时器');

  assertPass(timerFailedPlan10.kind === 'retry'
      && timerFailedPlan10.phasePatch.pwmState === 'on'
      && timerCommittedPlan10.kind === 'commit'
      && timerCommittedPlan10.phasePatch.pwmState === 'off'
      && timerTargetCommittedPlan10.nextTriggerAt === plannerPageTarget10
      && timerTargetCommittedPlan10.phasePatch.nextTriggerAt === plannerPageTarget10,
    '10B: 页面定时器失败保持 ON；成功后推进为 OFF 并采纳页面绝对目标');

  const pageTimerObservationIdx = pwmBody.indexOf('observations.pageTimerSucceeded = !!pageTimerResult?.success', setPageTimerCallIdx);
  const pageTimerTargetObservationIdx = pwmBody.indexOf('observations.pageTimerTargetAt = Number(pageTimerResult?.targetAt)', pageTimerObservationIdx);
  const pageTimerReplanIdx = pwmBody.indexOf('plan = planPwmStep(schedule, observations);', pageTimerObservationIdx);
  const finalPlanApplyIdx = pwmBody.lastIndexOf('applyPwmPlanState(plan);');
  assertPass(setPageTimerCallIdx > 0
      && pageTimerObservationIdx > setPageTimerCallIdx
      && pageTimerTargetObservationIdx > pageTimerObservationIdx
      && pageTimerReplanIdx > pageTimerTargetObservationIdx
      && finalPlanApplyIdx > pageTimerReplanIdx,
    '10C: adapter 将页面成功与 targetAt 回传 planner，重新规划后才应用最终相位');

  assertPass(timerFailedPlan10.reason === 'page-timer-failed'
      && timerFailedPlan10.retryMinutes === 1
      && timerFailedPlan10.nextTriggerAt === plannerNow10 + 60_000
      && pwmBody.includes("plan.reason === 'page-timer-failed' ? 'PWM-pageTimer-failed'"),
    '10D: 页面定时器失败由 planner 统一给出 1 分钟重试计划');

  const retryBranchStart10 = pwmBody.indexOf("if (plan.kind === 'retry')");
  const retryBranchEnd10 = pwmBody.indexOf("\n    if (plan.kind !== 'commit')", retryBranchStart10);
  const retryBranch10 = retryBranchStart10 >= 0 && retryBranchEnd10 > retryBranchStart10
    ? pwmBody.slice(retryBranchStart10, retryBranchEnd10)
    : '';
  const syncRunAfterIdx = pwmBody.indexOf("syncScheduleToSync('runPwmStep')", retryBranchEnd10);
  assertPass(retryBranch10.includes('return;')
      && !retryBranch10.includes("syncScheduleToSync('runPwmStep')")
      && syncRunAfterIdx > retryBranchEnd10,
    '10E: setPageTimer 失败分支在 sync 前提前 return，避免把未推进的 pwmState 推给对端让对端帮自己推进相位');

  // 10F: 失败时 pageTimerError 写入明确的失败原因，便于诊断面板排障
  assertPass(pwmBody.includes('observations.pageTimerError = pageTimerResult?.error')
      && pwmBody.includes("pageTimerError = `开机已成功，但页面关机定时器未确认"),
    '10F: setPageTimer 失败时诊断 pageTimerError 写明确文案，便于排障');

  // ===== 用例 11: v0.5.13 新鲜页面定时器确认与旁路保护 =====
  // DOM 实测：已设置时 .ant-picker input 的 value/title 均为 HH:MM，关机后均为空。
  // 不能把当前 React 页面刚写入的 value 当作服务器持久化成功；必须从全新页面再读一次。
  beginSuite('用例 11：页面定时器确认',
    '\n\n=== 用例 11: 新鲜页面定时器确认与旁路保护 (v0.5.13) ===\n');

  const verifyStart = backgroundSource.indexOf('async function verifyPageTimerPersistence(');
  const verifyEnd = backgroundSource.indexOf('\n// 关机定时器设置失败时', verifyStart);
  const verifyBody = verifyStart >= 0 && verifyEnd > verifyStart
    ? backgroundSource.slice(verifyStart, verifyEnd)
    : '';
  const retryStart = backgroundSource.indexOf('async function schedulePageTimerRetry(');
  const retryEnd = backgroundSource.indexOf('\n// ----- 设置页面自带定时器', retryStart);
  const retryBody = retryStart >= 0 && retryEnd > retryStart
    ? backgroundSource.slice(retryStart, retryEnd)
    : '';
  const repairStart = backgroundSource.indexOf('async function repairScheduleClock(options = {})');
  const repairEnd = backgroundSource.indexOf('\nasync function getScheduleSnapshot', repairStart);
  const repairBody = repairStart >= 0 && repairEnd > repairStart
    ? backgroundSource.slice(repairStart, repairEnd)
    : '';
  const toggleStart = backgroundSource.indexOf('async function toggleNowAndSync(action)');
  const toggleEnd = backgroundSource.indexOf('\nasync function ensureDiagnosticAlarms', toggleStart);
  const toggleBody = toggleStart >= 0 && toggleEnd > toggleStart
    ? backgroundSource.slice(toggleStart, toggleEnd)
    : '';
  const advanceStart = backgroundSource.indexOf('async function advanceExpiredAlarmToNextBoundary(');
  const advanceEnd = backgroundSource.indexOf('\nasync function restoreIntervalAlarmFromStorage', advanceStart);
  const advanceBody = advanceStart >= 0 && advanceEnd > advanceStart
    ? backgroundSource.slice(advanceStart, advanceEnd)
    : '';

  assertPass(!verifyBody.includes('chrome.tabs.reload(')
      && !verifyBody.includes('chrome.tabs.update(')
      && !verifyBody.includes('sourceWasAutoCreated')
      && verifyBody.includes('for (let attempt = 0; attempt < PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length; attempt++)')
      && verifyBody.includes("chrome.tabs.create({ url: AC_PAGE, active: false })")
      && /waitForTabReady\(\s*verifierTabId,\s*30000,\s*isACHomePageTab\s*\)/.test(verifyBody),
    '11A: 写入来源页绝不刷新/导航；每次独立验证页均等待 complete 的精确 home');
  assertPass(verifyBody.includes("{ action: 'getPageTimer' }")
      && verifyBody.includes('actualValue === expectedValue')
      && verifyBody.includes('lastFailure = `第 ${attempt + 1} 次新鲜页读回不匹配')
      && verifyBody.includes('await chrome.tabs.remove(verifierTabId)'),
    '11B: 新鲜页必须读回同一 HH:MM，未匹配会记录失败并回收临时验证页');
  assertPass(backgroundSource.includes('const PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS = [10000, 15000, 20000];')
      && verifyBody.includes('await sleep(PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS[attempt]);')
      && verifyBody.includes('attempts: attempt + 1')
      && verifyBody.includes('attempts: PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length')
      && verifyBody.includes('次新鲜页验证后仍未持久化'),
    '11B-1: 写入后按 10 秒、15 秒、20 秒间隔验证，避免首轮过早加载新页面，同时三次失败仍明确报告未持久化');
  assertPass(verifyBody.includes('let verifierTabId = null;')
      && verifyBody.includes('finally')
      && verifyBody.includes('await chrome.tabs.remove(verifierTabId);'),
    '11B-2: 每次验证尝试都会在 finally 中回收临时隐藏页');
  const verificationCallIdx = setTimerBody.indexOf('verifyPageTimerPersistence(expectedValue');
  const proofWriteIdx = setTimerBody.indexOf('schedule.pageTimerMinutes = result.actualDelayMinutes || minutes');
  assertPass(verificationCallIdx > 0
      && proofWriteIdx > verificationCallIdx
      && setTimerBody.includes('verified: true')
      && setTimerBody.includes('const targetAt = Number(result.targetAt);')
      && setTimerBody.includes('schedule.pageTimerTargetAt = targetAt;')
      && !setTimerBody.includes('parsePageTimerValue(result.value, Date.now())'),
    '11C: setPageTimer 仅在新鲜页确认后写证明，并直接采纳写入方绝对 targetAt');
  assertPass(retryBody.includes('schedule.pageTimerRetryMinutes = retryMinutes')
      && retryBody.includes("createAlarm('ac-page-timer-retry'")
      && backgroundSource.includes('schedule.pageTimerRetryMinutes')
      && backgroundSource.includes("if (alarm.name === 'ac-page-timer-retry')"),
    '11D: 非 PWM 的关机请求失败会保存分钟数并由 ac-page-timer-retry 持续重试');
  const repairTimerIdx = repairBody.indexOf('await setPageTimer(timerMinutes');
  const repairOffIdx = repairBody.indexOf("schedule.pwmState = currentOn ? 'off' : 'on';");
  assertPass(repairTimerIdx > 0
      && repairOffIdx > repairTimerIdx
      && repairBody.includes('planSmartModeOnWindow(schedule')
      && repairBody.includes('await applyPreparedSmartModeDurations({')
      && repairBody.includes('targetAt: smartTargetAt')
      && repairBody.includes("'repair-pageTimer-failed'"),
    '11E: 时钟修复先刷新当前智能周期时长、沿用绝对截止，并仅在新鲜确认后恢复 OFF 相位');
  const toggleTimerIdx = toggleBody.indexOf('await setPageTimer(schedule.onMinutes');
  const toggleOffIdx = toggleBody.indexOf("schedule.pwmState = currentOn ? 'off' : 'on';");
  assertPass(toggleTimerIdx > 0
      && toggleOffIdx > toggleTimerIdx
      && toggleBody.includes("'toggle-pageTimer-failed'"),
    '11F: 手动开机仅在新鲜确认页面定时器后才进入 OFF 相位');
  const reapplyStart = backgroundSource.indexOf('async function reapplySmartSensitivityNow()');
  const reapplyEnd = backgroundSource.indexOf('\nfunction clearPageTimerProofState()', reapplyStart);
  const reapplyBody = reapplyStart >= 0 && reapplyEnd > reapplyStart
    ? backgroundSource.slice(reapplyStart, reapplyEnd)
    : '';
  const smartWeatherSchedulerBody = extractSourceSection(
    backgroundSource,
    'async function rescheduleSmartWeatherAlarm() {',
    '\n// 边界闹钟触发：进入/退出运行时段',
    'rescheduleSmartWeatherAlarm'
  );
  const smartWeatherPreparationBody = extractSourceSection(
    backgroundSource,
    'async function prepareSmartWeatherForBoundary(boundaryAt) {',
    '\nfunction currentSmartControlBoundary(',
    'prepareSmartWeatherForBoundary'
  );
  const preparedDurationBody = extractSourceSection(
    backgroundSource,
    'async function applyPreparedSmartModeDurations(options = {}) {',
    '\n// 智能模式：滑块松开后立即按新灵敏度重设当前 ON 相位',
    'applyPreparedSmartModeDurations'
  );
  const smartWeatherAlarmBody = extractSourceSection(
    backgroundSource,
    "if (alarm.name === 'ac-smart-weather') {",
    "\n\n  if (alarm.name === 'ac-page-timer-retry')",
    'ac-smart-weather alarm branch'
  );
  const refreshSmartWeatherBody = extractSourceSection(
    backgroundSource,
    "if (msg.type === 'refreshSmartWeather') {",
    "\n    if (msg.type === 'repairSchedule')",
    'refreshSmartWeather message branch'
  );
  const setupAlarmsForWeatherBody = extractSourceSection(
    backgroundSource,
    'async function setupAlarms(startImmediately = false, options = {}) {',
    '\nfunction sanitizeMinutes',
    'setupAlarms weather recovery'
  );
  const diagnosticWeatherRecoveryBody = extractSourceSection(
    backgroundSource,
    'async function ensureDiagnosticAlarms() {',
    '\nchrome.runtime.onMessage.addListener',
    'ensureDiagnosticAlarms weather recovery'
  );
  assertPass(smartWeatherSchedulerBody.includes('planNextSmartWeatherPrefetch(Date.now())')
      && smartWeatherSchedulerBody.includes("createAlarm('ac-smart-weather', { when: plan.prefetchAt })")
      && !smartWeatherSchedulerBody.includes('periodInMinutes')
      && smartWeatherAlarmBody.includes('smartWeatherTargetBoundaryAt(alarm.scheduledTime)')
      && smartWeatherAlarmBody.indexOf('await rescheduleSmartWeatherAlarm();')
        < smartWeatherAlarmBody.indexOf('await prepareSmartWeatherForBoundary(boundaryAt)')
      && setupAlarmsForWeatherBody.includes('await rescheduleSmartWeatherAlarm();')
      && diagnosticWeatherRecoveryBody.includes('await rescheduleSmartWeatherAlarm();'),
    '11F-0: 天气任务使用严格未来的 :20/:50 one-shot，触发后先推进且启动/诊断可恢复');
  assertPass(smartWeatherPreparationBody.includes('getSmartWeather({ force: true })')
      && countOccurrences(backgroundSource, 'getSmartWeather(') === 2
      && countOccurrences(backgroundSource, 'fetchSmartWeather(') === 2
      && smartWeatherPreparationBody.includes('prepareSmartWeatherDecision({')
      && smartWeatherPreparationBody.includes('[SMART_WEATHER_PLAN_KEY]: plan')
      && preparedDurationBody.includes('chrome.storage.local.get(SMART_WEATHER_PLAN_KEY)')
      && preparedDurationBody.includes('consumeSmartWeatherDecision(')
      && preparedDurationBody.includes('await readStoredSmartWeather()')
      && preparedDurationBody.includes('consumeStoredSmartWeatherDecision(')
      && preparedDurationBody.includes("appendDiagnosticLog('warn', 'smart-duration-prepare', error)")
      && preparedDurationBody.includes('applySmartDurationFallback();')
      && preparedDurationBody.includes('catch (error)')
      && !preparedDurationBody.includes('getSmartWeather(')
      && !preparedDurationBody.includes('fetchSmartWeather')
      && pwmBody.includes('boundaryAt: smartPreparedBoundaryAt')
      && pwmBody.includes('allowActiveOnPhase: recoveringSmartCurrentCycle')
      && !pwmBody.includes('getSmartWeather(')
      && !pwmBody.includes('fetchSmartWeather')
      && !pwmBody.includes('prepareSmartWeatherForBoundary('),
    '11F-0A: 只有预取路径强制联网；边界/重启只读本地数据，storage 瞬断降级安全时长而不退出 setup/watchdog');
  let preparedFallbackCount11 = 0;
  const preparedWarnings11 = [];
  const applyPreparedWithStorageFailure11 = new Function(
    'schedule', 'SMART_MODE', 'SMART_WEATHER_PLAN_KEY', 'chrome', 'consumeSmartWeatherDecision',
    'readStoredSmartWeather', 'consumeStoredSmartWeatherDecision',
    'applySmartDurationFallback', 'applySmartDurationDecision',
    'appendDiagnosticLog', 'snapshotSmartPreparationOwner',
    'isSmartPreparationOwnerCurrent',
    `${preparedDurationBody}; return applyPreparedSmartModeDurations;`
  )(
    {
      enabled: true,
      pwmState: 'on',
      onMinutes: 12,
      offMinutes: 18,
      smartMode: { enabled: true, sensitivity: 5 }
    },
    { CYCLE_MINUTES: 30 },
    'ac_smart_weather_plan',
    { storage: { local: { get: async () => { throw new Error('storage transient'); } } } },
    () => null,
    async () => null,
    () => null,
    () => { preparedFallbackCount11 += 1; },
    () => {},
    (level, source, error) => { preparedWarnings11.push({ level, source, error }); },
    () => ({ owner: 'stable' }),
    () => true
  );
  const preparedStorageFailureResult11 = await applyPreparedWithStorageFailure11({
    allowActiveOnPhase: true,
    boundaryAt: new Date(2026, 7, 18, 10, 30, 0, 0).getTime()
  });
  assertPass(preparedStorageFailureResult11 === false
      && preparedFallbackCount11 === 1
      && preparedWarnings11[0]?.level === 'warn'
      && preparedWarnings11[0]?.source === 'smart-duration-prepare'
      && preparedWarnings11[0]?.error?.message === 'storage transient',
    '11F-0A-1: 启动/边界读取天气 plan 瞬断时动态降级安全时长并返回 planner，不让 init 在建 watchdog 前退出');
  const preparedConfigRaceSchedule11 = {
    enabled: true,
    mode: 'pwm',
    clockMode: false,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    smartMode: { enabled: true, sensitivity: 5 }
  };
  const snapshotPreparedOwner11 = () => ({
    enabled: preparedConfigRaceSchedule11.enabled === true,
    mode: preparedConfigRaceSchedule11.mode,
    clockMode: !!preparedConfigRaceSchedule11.clockMode,
    smartEnabled: preparedConfigRaceSchedule11.smartMode?.enabled === true,
    smartSensitivity: preparedConfigRaceSchedule11.smartMode?.sensitivity,
    activeHoursEnabled: preparedConfigRaceSchedule11.activeHours?.enabled === true,
    activeHoursStart: preparedConfigRaceSchedule11.activeHours?.start,
    activeHoursEnd: preparedConfigRaceSchedule11.activeHours?.end
  });
  const isPreparedOwnerCurrent11 = owner => {
    const current = snapshotPreparedOwner11();
    return Object.keys(current).every(key => current[key] === owner[key]);
  };
  let releasePreparedRead11;
  const delayedPreparedRead11 = new Promise(resolve => { releasePreparedRead11 = resolve; });
  let preparedRaceConsumes11 = 0;
  let preparedRaceFallbacks11 = 0;
  let preparedRaceApplies11 = 0;
  const applyPreparedConfigRace11 = new Function(
    'schedule', 'SMART_MODE', 'SMART_WEATHER_PLAN_KEY', 'chrome', 'consumeSmartWeatherDecision',
    'readStoredSmartWeather', 'consumeStoredSmartWeatherDecision',
    'applySmartDurationFallback', 'applySmartDurationDecision',
    'appendDiagnosticLog', 'snapshotSmartPreparationOwner',
    'isSmartPreparationOwnerCurrent',
    `${preparedDurationBody}; return applyPreparedSmartModeDurations;`
  )(
    preparedConfigRaceSchedule11,
    { CYCLE_MINUTES: 30 },
    'ac_smart_weather_plan',
    { storage: { local: { get: () => delayedPreparedRead11 } } },
    () => { preparedRaceConsumes11 += 1; return { valid: true, onMinutes: 22, offMinutes: 8 }; },
    async () => null,
    () => null,
    () => { preparedRaceFallbacks11 += 1; },
    () => { preparedRaceApplies11 += 1; },
    () => {},
    snapshotPreparedOwner11,
    isPreparedOwnerCurrent11
  );
  const preparedConfigRacePromise11 = applyPreparedConfigRace11({
    allowActiveOnPhase: true,
    boundaryAt: new Date(2026, 7, 18, 10, 30, 0, 0).getTime()
  });
  preparedConfigRaceSchedule11.smartMode = { enabled: false, sensitivity: 5 };
  preparedConfigRaceSchedule11.onMinutes = 60;
  preparedConfigRaceSchedule11.offMinutes = 45;
  releasePreparedRead11({ ac_smart_weather_plan: { schemaVersion: 1 } });
  const preparedConfigRaceResult11 = await preparedConfigRacePromise11;
  assertPass(preparedConfigRaceResult11 === false
      && preparedRaceConsumes11 === 0
      && preparedRaceFallbacks11 === 0
      && preparedRaceApplies11 === 0
      && preparedConfigRaceSchedule11.smartMode.enabled === false
      && preparedConfigRaceSchedule11.onMinutes === 60
      && preparedConfigRaceSchedule11.offMinutes === 45,
    '11F-0A-2: 天气 storage await 中切回手动 60/45 会失效旧智能 owner，不消费、不 fallback、也不覆盖新配置');
  assertPass(reapplyBody.includes('const weather = await readStoredSmartWeather();')
      && !reapplyBody.includes('getSmartWeather(')
      && !reapplyBody.includes('fetchSmartWeather')
      && refreshSmartWeatherBody.includes('readStoredSmartWeather()')
      && !refreshSmartWeatherBody.includes('getSmartWeather(')
      && popupJs.includes("chrome.storage.local.get('ac_smart_weather')")
      && !popupJs.includes('refreshSmartWeather'),
    '11F-0B: 灵敏度即时重设、兼容消息与 popup 全部只读本地天气，不直接或间接联网');
  assertPass(repairBody.includes("nextTriggerAt: schedule.pageTimerTargetAt")
      && repairBody.includes("createPwmAlarmFromPlan(")
      && toggleBody.includes("nextTriggerAt: schedule.pageTimerTargetAt")
      && toggleBody.includes("createPwmAlarmFromPlan(")
      && reapplyBody.indexOf('await setPageTimer(minutes') >= 0
      && reapplyBody.indexOf('createPwmAlarmFromPlan(') > reapplyBody.indexOf('await setPageTimer(minutes')
      && reapplyBody.includes('const reapplyTargetAt = Number(schedule.pageTimerTargetAt)')
      && reapplyBody.includes('const reapplyPlan = { nextTriggerAt: reapplyTargetAt }')
      && !reapplyBody.includes('nowMs + minutes * 60000'),
    '11F-1: repair、手动 ON 与智能重设均以页面证明 targetAt 创建同一绝对 ac-pwm');
  assertPass(reapplyBody.includes('const previousSmartBoundaryAt = oldTriggerAt - oldOnMinutes * 60000;')
      && reapplyBody.includes('const storedSmartBoundaryAt = Number(schedule.smartOnBoundaryAt);')
      && reapplyBody.includes('storedSmartBoundaryAt <= nowMs')
      && reapplyBody.includes('storedSmartBoundaryAt === 0')
      && reapplyBody.includes('previousSmartBoundaryAt <= nowMs')
      && reapplyBody.includes('activeSmartBoundaryAt')
      && reapplyBody.includes('smartModePageTimerTargetAt(')
      && reapplyBody.includes('previousSmartBoundaryAt')
      && reapplyBody.includes('pwmStepRunning')
      && reapplyBody.indexOf('getActiveSmartOnPwmRetryContext(schedule)')
        < reapplyBody.indexOf('const weather = await readStoredSmartWeather();')
      && reapplyBody.includes('pwmRuntimeRevision !== oldPwmRuntimeRevision')
      && reapplyBody.includes('schedule.pwmState !== oldPwmState')
      && reapplyBody.includes('(Number(schedule.nextTriggerAt) || 0) !== oldTriggerAt')
      && reapplyBody.includes('(Number(schedule.smartOnBoundaryAt) || 0) !== oldSmartBoundaryAt')
      && reapplyBody.includes('targetAt: smartDeadlineAt')
      && reapplyBody.includes('nextMinuteTargetAt')
      && !reapplyBody.includes('targetAt: 0'),
    '11F-2: 智能灵敏度即时重设沿用原周期半点锚点；截止已过只尽快关机，不重给相对 25 分钟');
  const reapplyRaceSchedule = {
    enabled: true,
    pwmState: 'off',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: new Date(2026, 7, 17, 13, 55, 0, 0).getTime(),
    smartOnBoundaryAt: new Date(2026, 7, 17, 13, 30, 0, 0).getTime(),
    smartMode: { enabled: true, sensitivity: 5 }
  };
  let releaseReapplyWeather;
  let reapplyWeatherReadStarted = false;
  const deferredReapplyWeather = new Promise(resolve => {
    releaseReapplyWeather = resolve;
  });
  let reapplyComputeCalls = 0;
  const reapplyRaceHarness = new Function(
    'schedule', 'readStoredSmartWeather', 'computeSmartOnMinutes', 'SMART_MODE', 'persistSchedule',
    'getActiveSmartOnPwmRetryContext',
    `let pwmStepRunning = false;
let pwmRuntimeRevision = 0;
function isComfortStartActive() { return false; }
${reapplyBody}
return {
  reapplySmartSensitivityNow,
  completePwmStep() {
    pwmStepRunning = true;
    pwmRuntimeRevision += 1;
    pwmStepRunning = false;
  }
};`
  )(
    reapplyRaceSchedule,
    () => {
      reapplyWeatherReadStarted = true;
      return deferredReapplyWeather;
    },
    () => { reapplyComputeCalls += 1; return { valid: true }; },
    smartMode.SMART_MODE,
    async () => {},
    () => ({ hasTypedSmartOnRetry: false })
  );
  const reapplyRacePromise = reapplyRaceHarness.reapplySmartSensitivityNow();
  reapplyRaceHarness.completePwmStep();
  releaseReapplyWeather({});
  await reapplyRacePromise;
    assertPass(reapplyWeatherReadStarted
      && reapplyComputeCalls === 0
      && reapplyRaceSchedule.onMinutes === 25
      && reapplyRaceSchedule.offMinutes === 5
      && reapplyRaceSchedule.nextTriggerAt
        === new Date(2026, 7, 17, 13, 55, 0, 0).getTime(),
    '11F-2A: 等待天气期间 PWM 即使已完成推进，旧灵敏度重设仍放弃且不覆盖新相位');
  const stableReapplySchedule = {
    ...reapplyRaceSchedule,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5
  };
  const stableReapplyPersistReasons = [];
  const stableReapplyHarness = new Function(
    'schedule', 'readStoredSmartWeather', 'computeSmartOnMinutes', 'SMART_MODE', 'persistSchedule',
    'getActiveSmartOnPwmRetryContext',
    `let pwmStepRunning = false;
let pwmRuntimeRevision = 0;
function isComfortStartActive() { return false; }
${reapplyBody}
return { reapplySmartSensitivityNow };`
  )(
    stableReapplySchedule,
    async () => ({}),
    () => ({ valid: true, onMinutes: 10, offMinutes: 20 }),
    smartMode.SMART_MODE,
    async reason => { stableReapplyPersistReasons.push(reason); },
    () => ({ hasTypedSmartOnRetry: false })
  );
  await stableReapplyHarness.reapplySmartSensitivityNow();
  assertPass(stableReapplySchedule.onMinutes === 10
      && stableReapplySchedule.offMinutes === 20
      && stableReapplyPersistReasons.join(',') === 'reapply-smart-sensitivity-off-phase',
    '11F-2B: 天气等待期间相位快照稳定时，灵敏度重设仍正常更新下一 ON 周期');
  const protectedRetrySchedule = {
    ...stableReapplySchedule,
    onMinutes: 21,
    offMinutes: 9,
    pwmRetryKind: 'smart-on',
    pwmRetryBoundaryAt: new Date(2026, 7, 27, 22, 30, 0, 0).getTime(),
    pwmRetryScheduledAt: new Date(2026, 7, 27, 22, 31, 0, 0).getTime(),
    nextTriggerAt: new Date(2026, 7, 27, 22, 31, 0, 0).getTime()
  };
  let protectedRetryWeatherReads = 0;
  let protectedRetryComputes = 0;
  let protectedRetryPersists = 0;
  const protectedRetryHarness = new Function(
    'schedule', 'readStoredSmartWeather', 'computeSmartOnMinutes', 'SMART_MODE', 'persistSchedule',
    'getActiveSmartOnPwmRetryContext',
    `let pwmStepRunning = false;
let pwmRuntimeRevision = 0;
function isComfortStartActive() { return false; }
${reapplyBody}
return { reapplySmartSensitivityNow };`
  )(
    protectedRetrySchedule,
    async () => { protectedRetryWeatherReads += 1; return {}; },
    () => {
      protectedRetryComputes += 1;
      return { valid: true, onMinutes: 0, offMinutes: 30 };
    },
    smartMode.SMART_MODE,
    async () => { protectedRetryPersists += 1; },
    () => ({ hasTypedSmartOnRetry: true })
  );
  const protectedRetryOutcome = await protectedRetryHarness.reapplySmartSensitivityNow();
  assertPass(protectedRetryOutcome?.retryProtected === true
      && protectedRetryWeatherReads === 0
      && protectedRetryComputes === 0
      && protectedRetryPersists === 0
      && protectedRetrySchedule.onMinutes === 21
      && protectedRetrySchedule.offMinutes === 9,
    '11F-2C: smart-on 重试期间灵敏度即时应用不消费 on=0 建议，原 21/9 与绝对事务保持不变');
  let lateRetryGuardChecks = 0;
  let releaseLateRetryWeather;
  const lateRetryWeather = new Promise(resolve => { releaseLateRetryWeather = resolve; });
  let lateRetryComputes = 0;
  let lateRetryPersists = 0;
  const lateRetryHarness = new Function(
    'schedule', 'readStoredSmartWeather', 'computeSmartOnMinutes', 'SMART_MODE', 'persistSchedule',
    'getActiveSmartOnPwmRetryContext',
    `let pwmStepRunning = false;
let pwmRuntimeRevision = 0;
function isComfortStartActive() { return false; }
${reapplyBody}
return { reapplySmartSensitivityNow };`
  )(
    { ...stableReapplySchedule, onMinutes: 21, offMinutes: 9 },
    () => lateRetryWeather,
    () => { lateRetryComputes += 1; return { valid: true, onMinutes: 0, offMinutes: 30 }; },
    smartMode.SMART_MODE,
    async () => { lateRetryPersists += 1; },
    () => ({ hasTypedSmartOnRetry: ++lateRetryGuardChecks >= 2 })
  );
  const lateRetryPromise = lateRetryHarness.reapplySmartSensitivityNow();
  releaseLateRetryWeather({});
  const lateRetryOutcome = await lateRetryPromise;
  assertPass(lateRetryOutcome?.retryProtected === true
      && lateRetryGuardChecks === 2
      && lateRetryComputes === 0
      && lateRetryPersists === 0,
    '11F-2D: 天气等待期间新出现 typed retry 时，第二道门禁阻止旧灵敏度覆盖事务');
  const runReapplyAlarmFailure11 = async timerSucceeds => {
    const nowMs = new Date(2026, 7, 17, 22, 10, 0, 0).getTime();
    const boundaryAt = new Date(2026, 7, 17, 22, 0, 0, 0).getTime();
    const timerTargetAt = new Date(2026, 7, 17, 22, 22, 0, 0).getTime();
    const failureSchedule = {
      enabled: true,
      pwmState: 'off',
      onMinutes: 20,
      offMinutes: 10,
      nextTriggerAt: boundaryAt + 20 * 60000,
      alarmCreatedAt: boundaryAt,
      alarmDelayMinutes: 20,
      smartOnBoundaryAt: boundaryAt,
      pageTimerTargetAt: boundaryAt + 20 * 60000,
      pageTimerError: '',
      smartMode: { enabled: true, sensitivity: 5 }
    };
    const persisted = [];
    const alarms = [];
    class ReapplyDate11 extends Date {
      static now() { return nowMs; }
    }
    const reapply = new Function(
      'schedule', 'readStoredSmartWeather', 'computeSmartOnMinutes', 'SMART_MODE',
      'persistSchedule', 'getActiveSmartOnPwmRetryContext',
      'smartModePageTimerTargetAt', 'nextSafePageTimerTargetAt', 'clearPwmAlarm',
      'setNextTriggerAt', 'setPageTimer', 'abortStaleAutomation',
      'createPwmAlarmFromPlan', 'createAlarm', 'updateBadge', 'Date',
      `let pwmStepRunning = false;
      let pwmRuntimeRevision = 71;
      function isComfortStartActive() { return false; }
      function isAutomationAllowed() { return schedule.enabled; }
      ${reapplyBody}
      return reapplySmartSensitivityNow;`
    )(
      failureSchedule,
      async () => ({ temperature: 30 }),
      () => ({ valid: true, onMinutes: 22, offMinutes: 8 }),
      smartMode.SMART_MODE,
      async (reason, options = {}) => {
        persisted.push({
          reason,
          options: { ...options },
          snapshot: JSON.parse(JSON.stringify(failureSchedule))
        });
      },
      () => ({ hasTypedSmartOnRetry: false }),
      pwmPhase.smartModePageTimerTargetAt,
      pwmPhase.nextSafePageTimerTargetAt,
      async () => true,
      value => { failureSchedule.nextTriggerAt = value > 0 ? value : 0; },
      async () => {
        if (!timerSucceeds) return { success: false, error: 'synthetic timer failure' };
        failureSchedule.pageTimerTargetAt = timerTargetAt;
        return { success: true, targetAt: timerTargetAt };
      },
      async () => false,
      async () => false,
      async name => { alarms.push(name); return true; },
      async () => {},
      ReapplyDate11
    );
    const result = await reapply();
    return { result, schedule: failureSchedule, persisted, alarms, timerTargetAt, nowMs };
  };
  const reapplyTimerAlarmFailure11 = await runReapplyAlarmFailure11(false);
  const reapplyCommitAlarmFailure11 = await runReapplyAlarmFailure11(true);
  assertPass(reapplyTimerAlarmFailure11.result?.success === false
      && reapplyTimerAlarmFailure11.persisted[0]?.reason
        === 'reapply-smart-sensitivity-pageTimer-retry-intent'
      && reapplyTimerAlarmFailure11.persisted[0]?.snapshot.nextTriggerAt
        === reapplyTimerAlarmFailure11.nowMs + 60000
      && reapplyTimerAlarmFailure11.persisted.at(-1)?.snapshot.pageTimerError.includes('闹钟创建失败')
      && reapplyTimerAlarmFailure11.alarms.includes('ac-watchdog')
      && reapplyCommitAlarmFailure11.result?.success === false
      && reapplyCommitAlarmFailure11.persisted[0]?.reason
        === 'reapply-smart-sensitivity-commit-intent'
      && reapplyCommitAlarmFailure11.persisted[0]?.snapshot.nextTriggerAt
        === reapplyCommitAlarmFailure11.timerTargetAt
      && reapplyCommitAlarmFailure11.persisted.at(-1)?.snapshot.pageTimerError.includes('闹钟创建失败')
      && reapplyCommitAlarmFailure11.alarms.includes('ac-watchdog'),
    '11F-2E: 灵敏度重设 retry/commit 建钟 false 都先持久化新绝对 intent，再保留红灯与 watchdog，不会重载旧钟假绿');
  const repairFunctionSource = extractSourceSection(
    backgroundSource,
    'async function repairScheduleClock(options = {}) {',
    '\n// 弹窗 est（Est. until）',
    'repairScheduleClock behavior'
  );
  const deferredRepairCoordinatorSource11 = extractSourceSection(
    backgroundSource,
    'function mergeScheduleRepairOptions(previous = {}, options = {}) {',
    '\n\nfunction releasePwmStepOwnership(automationRevision) {',
    'deferred schedule repair coordinator'
  );
  const loadRepairScheduleClock = new Function(
    'schedule',
    'restoreIntervalAlarmFromStorage',
    'updateBadge',
    'getCurrentACStatus',
    'setPageTimer',
    'createPwmAlarmWithVerify',
    'createAlarm',
    'persistSchedule',
    'createPwmAlarmFromPlan',
    'SMART_MODE',
    'planSmartModeOnWindow',
    'planSmartOnAfterConfirmedOff',
    'nextSafePageTimerTargetAt',
    'nextHalfHourBoundary',
    'applyPreparedSmartModeDurations',
    'setNextTriggerAt',
    'clearPwmRetryState',
    'setSmartOnPwmRetryState',
    'clearPageTimerProofState',
    'halfHourBoundaryAtOrBefore',
    'syncScheduleToSync',
    'clearPwmAlarm',
    'classifySmartOnClock',
    'Date',
    `let pwmRuntimeRevision = 0;
    let pwmExecutionWithRecoveryCount = 0;
    let deferredRepairAfterPwmOptions = null;
    let scheduleRepairEpoch = 0;
    let pwmStepRunning = false;
    let pwmStepRunningRevision = null;
    function isCurrentPwmStepRunning() {
      return pwmStepRunning && pwmStepRunningRevision === pwmRuntimeRevision;
    }
    function isSyncPhaseAdoptionAdmissionBlocked() { return false; }
    function getActiveSmartOnPwmRetryContext(snapshot) {
      return { boundaryAt: Number(snapshot?.pwmRetryBoundaryAt) || 0 };
    }
    const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    function waitUntil(promise) { return Promise.resolve(promise); }
    function appendDiagnosticLog() {}
    function isComfortStartActive() { return false; }
    function isAutomationAllowed() { return schedule.enabled; }
    async function abortStaleAutomation(revision) {
      return revision !== pwmRuntimeRevision;
    }
    function isAutomationOperationCurrent(revision) {
      return revision === pwmRuntimeRevision && schedule.enabled === true;
    }
    async function hasDurableLivePwmOwner() { return false; }
    ${deferredRepairCoordinatorSource11}
    ${repairFunctionSource}
    repairScheduleClock.__setRuntimeRevision = value => {
      pwmRuntimeRevision = Number(value) || 0;
    };
    return repairScheduleClock;`
  );
  const runRepairCase = async (
    initialSchedule,
    nowMs,
    refreshedSmartDuration = null,
    actualIsOn = true,
    repairOptions = {},
    harnessOptions = {}
  ) => {
    const repairSchedule = {
      ...initialSchedule,
      smartMode: { ...initialSchedule.smartMode }
    };
    const timerCalls = [];
    const alarmPlans = [];
    const smartDurationCalls = [];
    const syncCalls = [];
    const retryAlarmCalls = [];
    const persistedReasons = [];
    let statusCalls = 0;
    let phaseGateRepairResult = null;
    let phaseGateRepairEffectsWhileHeld = null;
    const repairScheduleClock = loadRepairScheduleClock(
      repairSchedule,
      async () => false,
      async () => {},
      async () => {
        statusCalls += 1;
        if (statusCalls === 1 && harnessOptions.statusGate) {
          if (typeof harnessOptions.onStatusStart === 'function') {
            harnessOptions.onStatusStart();
          }
          await harnessOptions.statusGate;
        }
        if (Array.isArray(harnessOptions.statusResults)
            && harnessOptions.statusResults.length > 0) {
          return harnessOptions.statusResults[
            Math.min(statusCalls - 1, harnessOptions.statusResults.length - 1)
          ];
        }
        return { isOn: actualIsOn };
      },
      async (minutes, options = {}) => {
        const targetAt = Number(options.targetAt) || nowMs + minutes * 60000;
        timerCalls.push({ minutes, options: { ...options }, targetAt });
        if (harnessOptions.timerSucceeds === false) {
          return { success: false, error: 'synthetic fresh-page proof failure' };
        }
        repairSchedule.pageTimerTargetAt = targetAt;
        return { success: true, targetAt };
      },
      async (...args) => {
        if (harnessOptions.allowRetryAlarm !== true) {
          throw new Error('成功恢复不应进入失败重试');
        }
        retryAlarmCalls.push(args);
        return true;
      },
      async () => {},
      async reason => { persistedReasons.push(reason); },
      async plan => { alarmPlans.push({ ...plan }); },
      smartMode.SMART_MODE,
      pwmPhase.planSmartModeOnWindow,
      pwmPhase.planSmartOnAfterConfirmedOff,
      pwmPhase.nextSafePageTimerTargetAt,
      pwmPhase.nextHalfHourBoundary,
      async options => {
        smartDurationCalls.push({ ...options });
        if (refreshedSmartDuration) {
          repairSchedule.onMinutes = refreshedSmartDuration.onMinutes;
          repairSchedule.offMinutes = refreshedSmartDuration.offMinutes;
          return true;
        }
        return false;
      },
      value => { repairSchedule.nextTriggerAt = value > 0 ? value : 0; },
      () => {
        repairSchedule.pwmRetryKind = '';
        repairSchedule.pwmRetryBoundaryAt = 0;
        repairSchedule.pwmRetryScheduledAt = 0;
      },
      (_targetAction, scheduledAt, options = {}) => {
        repairSchedule.pwmRetryKind = options.kind || 'smart-on';
        repairSchedule.pwmRetryBoundaryAt = Number(options.boundaryAt)
          || Number(repairSchedule.smartOnBoundaryAt)
          || 0;
        repairSchedule.pwmRetryScheduledAt = Number(scheduledAt) || 0;
      },
      () => {
        repairSchedule.pageTimerMinutes = null;
        repairSchedule.pageTimerTargetAt = 0;
        repairSchedule.pageTimerError = '';
        repairSchedule.pageTimerRetryAt = 0;
        repairSchedule.pageTimerRetryMinutes = 0;
      },
      pwmPhase.halfHourBoundaryAtOrBefore,
      async reason => { syncCalls.push(reason); },
      async () => true,
      pwmPhase.classifySmartOnClock,
      { now: () => nowMs }
    );
    if (Number.isSafeInteger(harnessOptions.runtimeRevision)) {
      repairScheduleClock.__setRuntimeRevision(harnessOptions.runtimeRevision);
    }
    if (harnessOptions.returnController === true) {
      return {
        repairScheduleClock,
        schedule: repairSchedule,
        timerCalls,
        alarmPlans,
        smartDurationCalls,
        syncCalls,
        retryAlarmCalls,
        persistedReasons,
        statusCalls: () => statusCalls
      };
    }
    const result = await repairScheduleClock(repairOptions);
    return {
      result,
      schedule: repairSchedule,
      timerCalls,
      alarmPlans,
      smartDurationCalls,
      syncCalls,
      retryAlarmCalls,
      persistedReasons,
      statusCalls
    };
  };
  const smartRepairBoundary = new Date(2026, 7, 17, 13, 30, 0, 0).getTime();
  const activeSmartRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartOnBoundaryAt: smartRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 45, 0, 0).getTime());
  const overrunSmartRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartOnBoundaryAt: smartRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 56, 0, 0).getTime());
  const midMinuteOverrunSmartRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartOnBoundaryAt: smartRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 56, 1, 0).getTime());
  const restartedSmartRepairBoundary = new Date(2026, 7, 17, 2, 0, 0, 0).getTime();
  const restartedSmartRepair = await runRepairCase({
    enabled: true,
    pwmState: 'off',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: 0,
    smartOnBoundaryAt: restartedSmartRepairBoundary,
    smartMode: { enabled: true, sensitivity: 10 }
  }, new Date(2026, 7, 17, 2, 11, 1, 0).getTime(), {
    onMinutes: 21,
    offMinutes: 9
  });
  const ordinaryRepairNow = new Date(2026, 7, 17, 13, 17, 0, 0).getTime();
  const ordinaryRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 8,
    nextTriggerAt: 0,
    smartOnBoundaryAt: 0,
    smartMode: { enabled: false, sensitivity: 5 }
  }, ordinaryRepairNow);
  const smartMissingClockRepairNow = new Date(2026, 7, 17, 22, 20, 0, 0).getTime();
  const smartMissingClockRepair = await runRepairCase({
    enabled: true,
    pwmState: 'off',
    onMinutes: 0,
    offMinutes: 30,
    nextTriggerAt: 0,
    smartOnBoundaryAt: new Date(2026, 7, 17, 22, 0, 0, 0).getTime(),
    smartMode: { enabled: true, sensitivity: 5 }
  }, smartMissingClockRepairNow, null, false);
  const acceptanceRepairBoundary = new Date(2026, 7, 17, 19, 0, 0, 0).getTime();
  const acceptanceRepairNow = new Date(2026, 7, 17, 19, 3, 0, 17).getTime();
  const acceptanceSkippedClockRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    nextTriggerAt: 0,
    smartOnBoundaryAt: acceptanceRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, acceptanceRepairNow, null, false, {
    smartOnExpectedBoundaryAt: acceptanceRepairBoundary
  });
  const encodedZeroRepairBoundary = new Date(2026, 7, 17, 22, 0, 0, 0).getTime();
  const encodedZeroRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 30,
    offMinutes: 30,
    nextTriggerAt: 0,
    smartOnBoundaryAt: encodedZeroRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 22, 28, 0, 0).getTime(), null, false);
  const timerOnlyRepairNow = new Date(2026, 7, 17, 18, 51, 8, 0).getTime();
  const timerOnlyRepair = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    nextTriggerAt: 0,
    smartOnBoundaryAt: new Date(2026, 7, 17, 18, 30, 0, 0).getTime(),
    smartMode: { enabled: true, sensitivity: 5 }
  }, timerOnlyRepairNow, null, true, {}, {
    timerSucceeds: false,
    allowRetryAlarm: true
  });
  let releaseCoalescedRepair11;
  let markCoalescedRepairStarted11;
  const coalescedRepairGate11 = new Promise(resolve => {
    releaseCoalescedRepair11 = resolve;
  });
  const coalescedRepairStarted11 = new Promise(resolve => {
    markCoalescedRepairStarted11 = resolve;
  });
  const coalescedRepairNow11 = new Date(2026, 7, 17, 19, 3, 0, 17).getTime();
  const coalescedRepairBoundary11 = new Date(2026, 7, 17, 19, 0, 0, 0).getTime();
  const coalescedRepairHarness11 = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    nextTriggerAt: 0,
    smartOnBoundaryAt: coalescedRepairBoundary11,
    smartMode: { enabled: true, sensitivity: 5 }
  }, coalescedRepairNow11, null, false, {}, {
    returnController: true,
    statusGate: coalescedRepairGate11,
    onStatusStart: markCoalescedRepairStarted11
  });
  const firstCoalescedRepair11 = coalescedRepairHarness11.repairScheduleClock();
  await coalescedRepairStarted11;
  const sameContextRepair11 = coalescedRepairHarness11.repairScheduleClock();
  coalescedRepairHarness11.repairScheduleClock.__setRuntimeRevision(1);
  const supersededBoundaryRepair11 = coalescedRepairHarness11.repairScheduleClock({
    smartOnExpectedBoundaryAt: coalescedRepairBoundary11 - 30 * 60_000
  });
  const latestBoundaryRepair11 = coalescedRepairHarness11.repairScheduleClock({
    smartOnExpectedBoundaryAt: coalescedRepairBoundary11
  });
  await Promise.resolve();
  const coalescedBeforeRelease11 = coalescedRepairHarness11.statusCalls() === 1
    && coalescedRepairHarness11.alarmPlans.length === 0;
  releaseCoalescedRepair11();
  const [firstRepairResult11, sameRepairResult11,
    supersededBoundaryResult11, latestBoundaryResult11] = await Promise.all([
    firstCoalescedRepair11,
    sameContextRepair11,
    supersededBoundaryRepair11,
    latestBoundaryRepair11
  ]);
  assertPass(coalescedBeforeRelease11
      && firstRepairResult11?.success === false
      && sameRepairResult11?.success === false
      && supersededBoundaryResult11?.success === true
      && latestBoundaryResult11?.success === true
      && supersededBoundaryResult11 === latestBoundaryResult11
      && coalescedRepairHarness11.statusCalls() === 2
      && coalescedRepairHarness11.alarmPlans.length === 1
      && coalescedRepairHarness11.schedule.pwmRetryKind
        === 'smart-on-safe-delay'
      && coalescedRepairHarness11.schedule.pwmRetryBoundaryAt
        === coalescedRepairBoundary11
      && coalescedRepairHarness11.schedule.nextTriggerAt
      === coalescedRepairNow11 + 5 * 60_000,
    '11F-3B: repair 同 revision/边界共享单次页面 I/O；revision/边界换主只合并一次 trailing，并采用最后 context');
  const typedTrailingBoundary11 = new Date(2026, 7, 17, 19, 0, 0, 0).getTime();
  const typedTrailingNow11 = typedTrailingBoundary11;
  const invalidTypedClock11 = typedTrailingBoundary11 + 30 * 60_000;
  let releaseTypedTrailingStatus11;
  let markTypedTrailingStatusStarted11;
  const typedTrailingStatusGate11 = new Promise(resolve => {
    releaseTypedTrailingStatus11 = resolve;
  });
  const typedTrailingStatusStarted11 = new Promise(resolve => {
    markTypedTrailingStatusStarted11 = resolve;
  });
  const typedTrailingHarness11 = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    nextTriggerAt: invalidTypedClock11,
    smartOnBoundaryAt: typedTrailingBoundary11,
    smartClockPlannedAt: typedTrailingBoundary11 - 4 * 60_000,
    alarmCreatedAt: typedTrailingBoundary11 - 4 * 60_000,
    alarmDelayMinutes: 34,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, typedTrailingNow11, null, false, {}, {
    returnController: true,
    statusGate: typedTrailingStatusGate11,
    onStatusStart: markTypedTrailingStatusStarted11,
    statusResults: [
      { isOn: null, error: 'synthetic first read unavailable' },
      { isOn: false }
    ]
  });
  const typedActiveRepair11 = typedTrailingHarness11.repairScheduleClock({
    smartOnExpectedBoundaryAt: typedTrailingBoundary11
  });
  await typedTrailingStatusStarted11;
  const genericTrailingRepair11 = typedTrailingHarness11.repairScheduleClock({});
  releaseTypedTrailingStatus11();
  const [typedActiveResult11, genericTrailingResult11] = await Promise.all([
    typedActiveRepair11,
    genericTrailingRepair11
  ]);
  assertPass(typedActiveResult11?.success === false
      && genericTrailingResult11?.success === true
      && typedTrailingHarness11.statusCalls() === 2
      && typedTrailingHarness11.timerCalls.length === 0
      && typedTrailingHarness11.alarmPlans.length === 1
      && typedTrailingHarness11.alarmPlans[0].nextTriggerAt
        === typedTrailingBoundary11 + 5 * 60_000
      && typedTrailingHarness11.alarmPlans[0].nextTriggerAt !== invalidTypedClock11
      && typedTrailingHarness11.schedule.pwmRetryKind === 'smart-on-safe-delay'
      && typedTrailingHarness11.schedule.pwmRetryBoundaryAt
        === typedTrailingBoundary11
      && typedTrailingHarness11.schedule.nextTriggerAt
        === typedTrailingBoundary11 + 5 * 60_000,
    '11F-3C: typed 19:00 repair 首次状态未知时，后到 generic trailing 不擦边界；第二次 OFF 只排 19:05 safe-delay，绝不回 19:30');
  assertPass(activeSmartRepair.timerCalls[0]?.minutes === 10
      && activeSmartRepair.timerCalls[0]?.options.targetAt
        === smartRepairBoundary + 25 * 60000
      && activeSmartRepair.alarmPlans[0]?.nextTriggerAt
        === smartRepairBoundary + 25 * 60000
      && activeSmartRepair.schedule.pwmState === 'off'
      && overrunSmartRepair.timerCalls[0]?.minutes === 1
      && overrunSmartRepair.timerCalls[0]?.options.targetAt
        === new Date(2026, 7, 17, 13, 57, 0, 0).getTime()
      && midMinuteOverrunSmartRepair.timerCalls[0]?.minutes === 2
      && midMinuteOverrunSmartRepair.timerCalls[0]?.options.targetAt
        === new Date(2026, 7, 17, 13, 58, 0, 0).getTime()
      && restartedSmartRepair.smartDurationCalls[0]?.allowActiveOnPhase === true
      && restartedSmartRepair.smartDurationCalls[0]?.boundaryAt
        === restartedSmartRepairBoundary
      && restartedSmartRepair.schedule.onMinutes === 21
      && restartedSmartRepair.timerCalls[0]?.minutes === 10
      && restartedSmartRepair.timerCalls[0]?.options.targetAt
        === new Date(2026, 7, 17, 2, 21, 0, 0).getTime()
      && restartedSmartRepair.alarmPlans[0]?.nextTriggerAt
        === new Date(2026, 7, 17, 2, 21, 0, 0).getTime()
      && ordinaryRepair.timerCalls[0]?.minutes === 12
      && !Object.hasOwn(ordinaryRepair.timerCalls[0]?.options || {}, 'targetAt')
      && ordinaryRepair.alarmPlans[0]?.nextTriggerAt
        === ordinaryRepairNow + 12 * 60000
      && smartMissingClockRepair.timerCalls.length === 0
      && smartMissingClockRepair.schedule.pwmState === 'on'
      && smartMissingClockRepair.alarmPlans[0]?.nextTriggerAt
        === new Date(2026, 7, 17, 22, 30, 0, 0).getTime()
      && acceptanceSkippedClockRepair.alarmPlans[0]?.nextTriggerAt
        === acceptanceRepairNow + 5 * 60000
      && acceptanceSkippedClockRepair.schedule.pwmRetryKind
        === 'smart-on-safe-delay'
      && acceptanceSkippedClockRepair.schedule.pwmRetryBoundaryAt
        === acceptanceRepairBoundary
      && encodedZeroRepair.alarmPlans[0]?.nextTriggerAt
        === new Date(2026, 7, 17, 23, 0, 0, 0).getTime()
      && encodedZeroRepair.schedule.pwmRetryKind === 'smart-on-safety-skip'
      && timerOnlyRepair.result?.success === false
      && timerOnlyRepair.schedule.pwmState === 'on'
      && timerOnlyRepair.schedule.pwmRetryKind === 'smart-on-safety-timer'
      && timerOnlyRepair.schedule.pwmRetryScheduledAt
        === timerOnlyRepairNow + 60_000
      && timerOnlyRepair.retryAlarmCalls.length === 1
      && timerOnlyRepair.alarmPlans.length === 0
      && timerOnlyRepair.persistedReasons[0]
        === 'repairScheduleClock-pageTimer-retry-intent'
      && timerOnlyRepair.syncCalls.includes('repairScheduleClock-pageTimer-retry-hold')
      && !repairFunctionSource.includes('toggleAC('),
    '11F-3: 智能 OFF 缺钟按最近 owner 半点安全补开或重新对齐，02:11 重启刷新时长，普通 PWM 不变');
  const restoreIntervalSource11 = extractSourceSection(
    backgroundSource,
    'function isTrustedHalfHourAlarmBoundary(timestamp) {',
    '\nasync function createAlarm(name, info)',
    'trusted smart stored alarm restore'
  );
  const runStoredDriftRestore11 = async (targetAt, { withOrigin = true } = {}) => {
    const boundaryAt = new Date(2026, 7, 17, 22, 30, 0, 0).getTime();
    const nowMs = boundaryAt + 200.25;
    const restoreSchedule = {
      enabled: true,
      pwmState: 'on',
      nextTriggerAt: targetAt,
      alarmCreatedAt: withOrigin ? boundaryAt - 10 * 60_000 : 0,
      smartMode: { enabled: true }
    };
    const createdPlans = [];
    class RestoreDate11 extends Date {
      static now() { return nowMs; }
    }
    const restore = new Function(
      'schedule', 'chrome', 'isAutomationAllowed', 'isAutomationOperationCurrent',
      'getLiveAlarmEndMs', 'getStoredAlarmEndMs', 'getActiveSmartOnPwmRetryContext',
      'halfHourBoundaryAtOrBefore', 'nextHalfHourBoundary', 'clearPwmAlarm',
      'createPwmAlarmFromPlan', 'createAlarm', 'persistSchedule', 'updateBadge',
      'classifySmartOnClock', 'Date', 'console',
      `let pwmRuntimeRevision = 81;
      const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
      ${restoreIntervalSource11}
      return restoreIntervalAlarmFromStorage;`
    )(
      restoreSchedule,
      { alarms: { get: async () => null } },
      () => true,
      () => true,
      () => 0,
      () => restoreSchedule.nextTriggerAt,
      () => ({ hasTypedSmartOnRetry: false }),
      pwmPhase.halfHourBoundaryAtOrBefore,
      pwmPhase.nextHalfHourBoundary,
      async () => true,
      async plan => { createdPlans.push({ ...plan }); return true; },
      async () => true,
      async () => {},
      async () => {},
      pwmPhase.classifySmartOnClock,
      RestoreDate11,
      testConsole
    );
    const result = await restore('dynamic drift restore');
    return { result, createdPlans };
  };
  const fractionalStoredRestore11 = await runStoredDriftRestore11(
    new Date(2026, 7, 17, 22, 30, 0, 0).getTime() + 500.5
  );
  const nonBoundaryStoredRestore11 = await runStoredDriftRestore11(
    new Date(2026, 7, 17, 22, 50, 0, 0).getTime()
  );
  const originlessStoredRestore11 = await runStoredDriftRestore11(
    new Date(2026, 7, 17, 22, 30, 0, 0).getTime() + 500.5,
    { withOrigin: false }
  );
  assertPass(fractionalStoredRestore11.result === true
      && fractionalStoredRestore11.createdPlans[0]?.nextTriggerAt
        === new Date(2026, 7, 17, 22, 30, 0, 0).getTime() + 500.5
      && nonBoundaryStoredRestore11.result === false
      && nonBoundaryStoredRestore11.createdPlans.length === 0
      && originlessStoredRestore11.result === false
      && originlessStoredRestore11.createdPlans.length === 0,
    '11F-3B: 缺 live 时仅有 durable origin 的 storage 半点+500.5ms 可恢复；22:50 与无来源半点均拒绝');
  const midMinuteTarget11F = typeof pwmPhase.nextSafePageTimerTargetAt === 'function'
    ? pwmPhase.nextSafePageTimerTargetAt(new Date(2026, 7, 17, 2, 11, 1, 0).getTime())
    : 0;
  assertPass(typeof pwmPhase.nextSafePageTimerTargetAt === 'function'
      && midMinuteTarget11F === new Date(2026, 7, 17, 2, 13, 0, 0).getTime()
      && midMinuteTarget11F - new Date(2026, 7, 17, 2, 11, 1, 0).getTime() >= 60_000,
    '11F-3A: 紧急页面关机目标从 02:11:01 取 02:13，不再请求不足一分钟的 02:12');
  const recoveryNow11G = 1_700_000_000_000;
  const recoveryPlan11G = pwmPhase.planPwmRecovery({
    enabled: true,
    pwmState: 'off',
    onMinutes: 10,
    offMinutes: 20
  }, recoveryNow11G - 25 * 60_000, {}, { now: recoveryNow11G });
  assertPass(recoveryPlan11G.kind === 'hold'
      && recoveryPlan11G.prerequisite === 'set-page-timer'
      && advanceBody.includes("plan.prerequisite === 'set-page-timer'")
      && advanceBody.includes('await setPageTimer(plan.timerMinutes')
      && advanceBody.includes('pageTimerSucceeded: !!timerResult?.success')
      && advanceBody.includes("'advance-pageTimer-failed'"),
    '11G: 过期闹钟恢复由 planner 要求先重新武装页面关机定时器');
  const powerOffAfterFixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'power-off-after-states.json'),
    'utf8'
  ));
  const armedDom = powerOffAfterFixture.armed;
  const clearedDom = powerOffAfterFixture.cleared;
  assertPass(armedDom.timerInput.selector === '.ant-picker input'
      && armedDom.timerInput.readonly === true
      && /^\d{2}:\d{2}$/.test(armedDom.timerInput.value)
      && armedDom.timerInput.value === armedDom.timerInput.title
      && armedDom.acSwitch.ariaChecked === 'true',
    '11H: 用户实测的已设定状态为 readonly .ant-picker input，value/title 同为 HH:MM，AC=ON');
  assertPass(clearedDom.timerInput.selector === '.ant-picker input'
      && clearedDom.timerInput.readonly === true
      && clearedDom.timerInput.value === ''
      && clearedDom.timerInput.title === ''
      && clearedDom.acSwitch.ariaChecked === 'false',
    '11I: 用户实测的关机状态会清空 value/title，AC=OFF');
  assertPass(contentSource.includes("pickerInput.getAttribute('title')")
      && contentSource.includes('const effectiveValue = value || title'),
    '11J: 内容脚本以用户实测的 title=HH:MM 作为 value 的刷新后兼容回退');
  assertPass(contentSource.includes('async function typeTimeIntoPickerInput(input, value)')
      && contentSource.includes('const MAX_TYPING_ATTEMPTS = 3')
      && contentSource.includes('async function typeOnceIntoPickerInput(picker, input, value)')
      && contentSource.includes('return !!(await waitForConfirmedPowerOffTimerInput(')
      && contentSource.includes('stableWindowMs = 500'),
    '11J-1: 页面定时器写入有限重试，并用重新定位后的稳定 value/title 确认目标 HH:MM');
  const typeTimeStart11J = contentSource.indexOf(
    'async function typeTimeIntoPickerInput(input, value)'
  );
  const typeTimeEnd11J = contentSource.indexOf(
    '\n\n// 单次模拟手动输入',
    typeTimeStart11J
  );
  const typeTimeSource11J = typeTimeStart11J >= 0 && typeTimeEnd11J > typeTimeStart11J
    ? contentSource.slice(typeTimeStart11J, typeTimeEnd11J)
    : '';
  let pickerRetryRebound11J = false;
  if (typeTimeSource11J) {
    const makeRetryInput11J = id => ({
      id,
      readonlyRestored: false,
      hasAttribute: attribute => attribute === 'readonly',
      setAttribute(attribute) {
        if (attribute === 'readonly') this.readonlyRestored = true;
      }
    });
    const oldInput11J = makeRetryInput11J('old');
    const newInput11J = makeRetryInput11J('new');
    const oldControl11J = { input: oldInput11J, picker: { id: 'old-picker' } };
    const newControl11J = { input: newInput11J, picker: { id: 'new-picker' } };
    let stableControlCalls11J = 0;
    let typeOnceCalls11J = 0;
    const typeTimeIntoPickerInput11J = new Function(
      'findPowerOffTimerControl', 'waitForStablePowerOffTimerControl',
      'typeOnceIntoPickerInput', 'console',
      `${typeTimeSource11J}; return typeTimeIntoPickerInput;`
    )(
      () => oldControl11J,
      async () => (++stableControlCalls11J === 1 ? oldControl11J : newControl11J),
      async (picker) => {
        typeOnceCalls11J += 1;
        return picker === newControl11J.picker;
      },
      testConsole
    );
    pickerRetryRebound11J = await typeTimeIntoPickerInput11J(oldInput11J, '00:21')
      && stableControlCalls11J === 2
      && typeOnceCalls11J === 2
      && oldInput11J.readonlyRestored
      && newInput11J.readonlyRestored;
  }
  assertPass(pickerRetryRebound11J,
    '11J-2: picker 首次输入后 React 换节点时，下一次重试重新绑定唯一新控件而非继续操作旧节点');

  const typeOnceStart11J = contentSource.indexOf(
    'async function typeOnceIntoPickerInput(picker, input, value)'
  );
  const typeOnceEnd11J = contentSource.indexOf(
    '\n\n// ----- 查找 AC 开关 DOM 元素 -----',
    typeOnceStart11J
  );
  const typeOnceSource11J = typeOnceStart11J >= 0 && typeOnceEnd11J > typeOnceStart11J
    ? contentSource.slice(typeOnceStart11J, typeOnceEnd11J)
    : '';
  let delayedControlledCommitAccepted11J = false;
  let ambiguousPortalStayedFailClosed11J = false;
  if (typeOnceSource11J) {
    class PickerEvent11J {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    }
    const oldInput11J = {
      value: '',
      removeAttribute() {},
      focus() {},
      click() {},
      getAttribute() { return ''; },
      dispatchEvent(event) {
        // Simulate a controlled React input rolling every synthetic write back
        // on the old node before its delayed commit replaces that node.
        if (event?.type === 'input') this.value = '';
        return true;
      }
    };
    const newInput11J = {
      value: '01:23',
      getAttribute(attribute) {
        return attribute === 'title' ? '01:23' : '';
      }
    };
    const picker11J = {
      dispatchEvent() {},
      click() {}
    };
    const control11J = { picker: picker11J, input: oldInput11J };
    let okClicks11J = 0;
    let stableConfirmationCalls11J = 0;
    const loadTypeOnce11J = (okResult) => new Function(
      'findPowerOffTimerControl', 'findVisiblePickerDropdowns',
      'MouseEvent', 'KeyboardEvent', 'InputEvent', 'Event', 'window',
      'sleep', 'setNativeInputValue', 'clickUniquePowerOffPickerOk',
      'waitForConfirmedPowerOffTimerInput',
      `${typeOnceSource11J}; return typeOnceIntoPickerInput;`
    )(
      () => control11J,
      () => [],
      PickerEvent11J,
      PickerEvent11J,
      PickerEvent11J,
      PickerEvent11J,
      {},
      async () => {},
      (input, value) => { input.value = value; },
      () => {
        if (okResult.clicked) okClicks11J += 1;
        return okResult;
      },
      async () => {
        stableConfirmationCalls11J += 1;
        return newInput11J;
      }
    );
    delayedControlledCommitAccepted11J = await loadTypeOnce11J({
      accepted: true,
      clicked: true
    })(picker11J, oldInput11J, '01:23');
    const callsBeforeAmbiguous11J = stableConfirmationCalls11J;
    ambiguousPortalStayedFailClosed11J = (await loadTypeOnce11J({
      accepted: false,
      clicked: false
    })(picker11J, oldInput11J, '01:23')) === false
      && stableConfirmationCalls11J === callsBeforeAmbiguous11J;
    delayedControlledCommitAccepted11J = delayedControlledCommitAccepted11J === true
      && okClicks11J === 1
      && stableConfirmationCalls11J === 1;
  }
  assertPass(delayedControlledCommitAccepted11J && ambiguousPortalStayedFailClosed11J,
    '11J-3: picker 接受后用重新定位的稳定新节点判定；portal 歧义仍零确认、失败关闭');

  const clearPageTimerProofStart = backgroundSource.indexOf('function clearPageTimerProofState()');
  const clearPageTimerProofEnd = backgroundSource.indexOf('\nasync function syncStoredTriggerFromAlarm', clearPageTimerProofStart);
  const clearPageTimerProofSource = clearPageTimerProofStart >= 0
      && clearPageTimerProofEnd > clearPageTimerProofStart
    ? backgroundSource.slice(clearPageTimerProofStart, clearPageTimerProofEnd)
    : '';
  const proofState = {
    pageTimerMinutes: 30,
    pageTimerTargetAt: Date.now() + 30 * 60 * 1000,
    pageTimerError: 'old error',
    pageTimerRetryAt: Date.now() + 60 * 1000,
    pageTimerRetryMinutes: 1,
    pwmState: 'off'
  };
  const clearPageTimerProofState = new Function(
    'schedule',
    `${clearPageTimerProofSource}; return clearPageTimerProofState;`
  )(proofState);
  clearPageTimerProofState();
  assertPass(proofState.pageTimerMinutes === null
      && proofState.pageTimerTargetAt === 0
      && proofState.pageTimerError === ''
      && proofState.pageTimerRetryAt === 0
      && proofState.pageTimerRetryMinutes === 0
      && proofState.pwmState === 'off',
    '11K: 页面定时器证明 helper 只清五个证明字段，不污染 PWM 相位');
  const applyPwmPlanStart = backgroundSource.indexOf('function applyPwmPlanState(plan)');
  const applyPwmPlanEnd = backgroundSource.indexOf('\nasync function syncStoredTriggerFromAlarm', applyPwmPlanStart);
  const applyPwmPlanBody = applyPwmPlanStart >= 0 && applyPwmPlanEnd > applyPwmPlanStart
    ? backgroundSource.slice(applyPwmPlanStart, applyPwmPlanEnd)
    : '';
  assertPass(applyPwmPlanBody.includes("if (plan?.proofAction === 'clear') clearPageTimerProofState();")
      && countOccurrences(backgroundSource, 'clearPageTimerProofState();') === 4,
    '11L: planner proofAction 与三条直接失效/新鲜 OFF 路径统一委派给 clearPageTimerProofState');

  const reconciliationSites = [
    ['persistSchedule', 'async function persistSchedule(', '\nconst _syncOpLock'],
    ['watchdogCheck', 'async function watchdogCheck()', '\n// ----- 启动时加载设置并创建闹钟'],
    ['init', 'async function init()', '\n// ----- 设置/更新 PWM 循环闹钟'],
    ['badge-tick', "if (alarm.name === 'ac-badge-tick')", "\n  if (alarm.name === 'ac-pwm')"],
    ['getScheduleSnapshot', 'async function getScheduleSnapshot(', '\nasync function toggleNowAndSync'],
    ['ensureDiagnosticAlarms', 'async function ensureDiagnosticAlarms()', '\nchrome.runtime.onMessage.addListener']
  ].map(([name, startMarker, endMarker]) => {
    const start = backgroundSource.indexOf(startMarker);
    const end = backgroundSource.indexOf(endMarker, start);
    return [name, start >= 0 && end > start ? backgroundSource.slice(start, end) : ''];
  });
  assertPass(backgroundSource.includes('const PWM_TRIGGER_STRICT_OPTIONS = Object.freeze({')
      && backgroundSource.includes('const PWM_TRIGGER_NEXT_ONLY_OPTIONS = Object.freeze({')
      && backgroundSource.includes('const PWM_TRIGGER_SNAPSHOT_OPTIONS = Object.freeze({')
      && /persistReconciledPwmTrigger\([\s\S]{0,160}PWM_TRIGGER_STRICT_OPTIONS,[\s\S]{0,40}automationRevision/.test(backgroundSource)
      && reconciliationSites.every(([name, source]) => name === 'watchdogCheck'
        ? source.includes('recoverPwmLifecycle({')
          && source.includes("preserveLiveStrategy: 'next-only'")
        : source.includes('reconcilePwmTrigger(')
          || source.includes('persistReconciledPwmTrigger('))
      && backgroundSource.includes("context.preserveLiveStrategy === 'next-only'")
      && backgroundSource.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,'),
    '11M: strict、next-only 与只读 snapshot profile 显式委派给 PWM trigger planner');
  assertPass(reconciliationSites.every(([, source]) => !/Math\.abs\([^\n]*(?:scheduledTime|liveDueAt)/.test(source))
      && !backgroundSource.includes('schedule.nextTriggerAt = liveDueAt;'),
    '11N: 后台 live-alarm 校准点不再保留手写漂移判断或字段修正副本');

  // ===== 用例 12: 审计修复回归（只读轮询、HIG、发布与安装） =====
  beginSuite('用例 12：审计回归',
    '\n\n=== 用例 12: 审计修复回归（只读轮询、HIG、发布与安装） ===\n');

  const snapshotStart = backgroundSource.indexOf('// 弹窗 est（Est. until）依赖 full 轮询带回的页面余额。');
  const snapshotEnd = backgroundSource.indexOf('\nasync function toggleNowAndSync', snapshotStart);
  const snapshotBody = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? backgroundSource.slice(snapshotStart, snapshotEnd)
    : '';
  assertPass(snapshotStart >= 0 && !snapshotBody.includes('persistSchedule(')
      && !snapshotBody.includes('backfillNextTriggerAt('),
    '12A: getScheduleSnapshot 普通轮询不触发持久化或自愈写入');
  assertPass(/msg\.type === 'getSchedule'[\s\S]{0,180}getScheduleSnapshot\(\)/.test(backgroundSource)
      && /msg\.type === 'getScheduleLite'[\s\S]{0,220}getScheduleSnapshot\(true\)/.test(backgroundSource),
    '12B: getSchedule 与 getScheduleLite 都只委派给快照读取器');

  const createScheduleSnapshotHarness = new Function(
    'reconcilePwmTrigger',
    'initialSchedule',
    'liveAlarm',
    'actualStatus',
    'initialSessionBalance',
    'initialLocalBalance',
    'insideActiveHours',
    'phaseAdoptionInFlight',
    `
    let schedule = { ...initialSchedule };
    let scheduleWriteCount = 0;
    let localBalanceWriteCount = 0;
    let sessionWriteCount = 0;
    const localStorage = {
      ac_schedule: { ...initialSchedule },
      ...(Number.isFinite(initialLocalBalance)
        ? { ac_balance_cache: initialLocalBalance }
        : {})
    };
    const sessionStorage = Number.isFinite(initialSessionBalance)
      ? { ac_balance_cache: initialSessionBalance }
      : {};
    const PWM_TRIGGER_SNAPSHOT_OPTIONS = Object.freeze({
      nextTriggerToleranceMs: 1500,
      requireLegacyAlignment: false,
      allowDisabled: true
    });
    const chrome = {
      storage: {
        local: {
          async get(key) {
            if (key === 'ac_schedule') return { ac_schedule: { ...localStorage.ac_schedule } };
            if (key === 'ac_balance_cache') {
              return Object.hasOwn(localStorage, key)
                ? { [key]: localStorage[key] }
                : {};
            }
            return { ...localStorage };
          },
          async set(value) {
            if (value.ac_schedule) {
              scheduleWriteCount += 1;
              localStorage.ac_schedule = { ...value.ac_schedule };
            }
            if (Object.hasOwn(value, 'ac_balance_cache')) {
              localBalanceWriteCount += 1;
              localStorage.ac_balance_cache = value.ac_balance_cache;
            }
          },
          async remove(key) {
            if (key === 'ac_balance_cache') {
              localBalanceWriteCount += 1;
              delete localStorage.ac_balance_cache;
            }
          }
        },
        session: {
          async get(key) {
            return Object.hasOwn(sessionStorage, key)
              ? { [key]: sessionStorage[key] }
              : {};
          },
          async set(value) {
            sessionWriteCount += 1;
            Object.assign(sessionStorage, value);
          },
          async remove(key) {
            sessionWriteCount += 1;
            delete sessionStorage[key];
          }
        }
      },
      alarms: {
        async get(name) { return name === 'ac-pwm' && liveAlarm ? { ...liveAlarm } : undefined; }
      }
    };
    async function loadScheduleFromStorage() {
      const saved = await chrome.storage.local.get('ac_schedule');
      if (saved.ac_schedule) schedule = { ...schedule, ...saved.ac_schedule };
    }
    function getLiveAlarmEndMs(alarm) {
      return alarm?.scheduledTime > Date.now() ? alarm.scheduledTime : 0;
    }
    function getLegacyAlarmEndMs() {
      return schedule.alarmCreatedAt && schedule.alarmDelayMinutes
        ? schedule.alarmCreatedAt + schedule.alarmDelayMinutes * 60000
        : 0;
    }
    function isWithinActiveHours() { return insideActiveHours !== false; }
    function isComfortStartActive() {
      return schedule.enabled === true
        && Number(schedule.comfortStartUntil) > Date.now();
    }
    function isCurrentPwmStepRunning() { return false; }
    function isSyncPhaseAdoptionAdmissionBlocked() {
      return phaseAdoptionInFlight === true;
    }
    let currentActualStatus = actualStatus;
    async function getCurrentACStatus() { return currentActualStatus; }
    async function persistSchedule() { scheduleWriteCount += 1; }
    async function backfillNextTriggerAt() { scheduleWriteCount += 1; }
    ${snapshotBody}
    return {
      getScheduleSnapshot,
      getStorageWriteCount: () => scheduleWriteCount,
      getLocalBalanceWriteCount: () => localBalanceWriteCount,
      getSessionWriteCount: () => sessionWriteCount,
      getLocalBalance: () => localStorage.ac_balance_cache,
      getSessionBalance: () => sessionStorage.ac_balance_cache,
      getMemorySchedule: () => ({ ...schedule }),
      setActualStatus: (nextStatus) => { currentActualStatus = nextStatus; }
    };
  `);
  const liveDueAt12 = Date.now() + 5 * 60 * 1000;
  const durableClockOrigin12 = Date.now() - 10 * 60 * 1000;
  const initialSchedule12 = {
    enabled: true,
    pwmState: 'off',
    nextTriggerAt: 0,
    smartClockPlannedAt: durableClockOrigin12,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0
  };
  const snapshotHarness = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    initialSchedule12,
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true }
  );
  const fullSnapshot12 = await snapshotHarness.getScheduleSnapshot();
  const liteSnapshot12 = await snapshotHarness.getScheduleSnapshot(true);
  assertPass(snapshotHarness.getStorageWriteCount() === 0,
    '12C: full/lite 普通读取都不写 chrome.storage.local');
  assertPass(snapshotHarness.getMemorySchedule().nextTriggerAt === 0,
    '12D: 普通读取不修改内存 schedule 的 nextTriggerAt');
  assertPass(fullSnapshot12.nextTriggerAt === liveDueAt12
      && fullSnapshot12.actualStatus?.isOn === true
      && liteSnapshot12.nextTriggerAt === liveDueAt12
      && liteSnapshot12.actualStatus === null
      && fullSnapshot12._clockPlannedAt === durableClockOrigin12
      && liteSnapshot12._clockPlannedAt === durableClockOrigin12
      && fullSnapshot12.alarmCreatedAt !== durableClockOrigin12,
    '12E: full/lite 快照投影 live alarm 时保留 immutable clock origin；UI 剩余时间改写不污染语义来源');

  const phaseAdoptionClock12 = Date.now() + 4 * 60 * 1000;
  const supersededLiveClock12 = Date.now() + 20 * 60 * 1000;
  const phaseAdoptionSnapshotHarness12 = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    {
      ...initialSchedule12,
      pwmState: 'off',
      nextTriggerAt: phaseAdoptionClock12,
      alarmCreatedAt: Date.now(),
      alarmDelayMinutes: 4
    },
    { name: 'ac-pwm', scheduledTime: supersededLiveClock12 },
    { isOn: false },
    undefined,
    undefined,
    true,
    true
  );
  const phaseAdoptionSnapshot12 = await phaseAdoptionSnapshotHarness12
    .getScheduleSnapshot(true);
  assertPass(phaseAdoptionSnapshot12._phaseAdoptionInFlight === true
      && phaseAdoptionSnapshot12.nextTriggerAt === phaseAdoptionClock12
      && phaseAdoptionSnapshot12._nextBoundary === phaseAdoptionClock12
      && phaseAdoptionSnapshot12.nextTriggerAt !== supersededLiveClock12
      && phaseAdoptionSnapshotHarness12.getStorageWriteCount() === 0,
    '12E-2: phase adoption reservation 内 getScheduleLite 暴露门禁并只展示新内存 phase，不投影旧 live alarm 或写 storage');

  const pausedSnapshotHarness12 = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    {
      ...initialSchedule12,
      activeHours: { enabled: true, start: '08:00', end: '23:00' }
    },
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true },
    undefined,
    undefined,
    false
  );
  const pausedSnapshot12 = await pausedSnapshotHarness12.getScheduleSnapshot(true);
  assertPass(pausedSnapshot12._automationPausedByActiveHours === true
      && pausedSnapshot12.nextTriggerAt === 0
      && pausedSnapshot12._nextBoundary === undefined
      && pausedSnapshotHarness12.getMemorySchedule().nextTriggerAt === 0,
    '12E-1: 时段外快照忽略泄漏的 live ac-pwm，不投影或回灌暂停前时钟');

  const stickyHarness = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    initialSchedule12,
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true, balanceState: 'available', balanceMinutes: 156 }
  );
  const stickyFirst = await stickyHarness.getScheduleSnapshot();
  stickyHarness.setActualStatus({ isOn: true, balanceState: 'unavailable' });
  const stickyDegraded = await stickyHarness.getScheduleSnapshot();
  stickyHarness.setActualStatus({ isOn: true, balanceState: 'not-charge-mode' });
  const stickyCleared = await stickyHarness.getScheduleSnapshot();
  stickyHarness.setActualStatus({ isOn: true, balanceState: 'available', balanceMinutes: 200 });
  const stickyRefreshed = await stickyHarness.getScheduleSnapshot();
  assertPass(stickyFirst.actualStatus?.balanceMinutes === 156
      && stickyDegraded.actualStatus?.balanceMinutes === 156
      && stickyCleared.actualStatus?.balanceMinutes === undefined
      && stickyRefreshed.actualStatus?.balanceMinutes === 200,
    '12F: full 快照仅对暂不可读粘住余额，明确非 Charge Mode 会清除，恢复读取后继续更新');

  const persistedBalanceHarness = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    initialSchedule12,
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true, balanceState: 'available', balanceMinutes: 156 }
  );
  await persistedBalanceHarness.getScheduleSnapshot();
  const restartedBalanceHarness = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    initialSchedule12,
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true, balanceState: 'unavailable' },
    undefined,
    persistedBalanceHarness.getLocalBalance()
  );
  const restartedBalanceSnapshot = await restartedBalanceHarness.getScheduleSnapshot();
  restartedBalanceHarness.setActualStatus({ isOn: true, balanceState: 'not-charge-mode' });
  const clearedRestartedBalance = await restartedBalanceHarness.getScheduleSnapshot();
  assertPass(persistedBalanceHarness.getLocalBalance() === 156
      && persistedBalanceHarness.getSessionBalance() === 156
      && persistedBalanceHarness.getLocalBalanceWriteCount() === 1
      && persistedBalanceHarness.getSessionWriteCount() === 1
      && restartedBalanceSnapshot.actualStatus?.balanceMinutes === 156
      && clearedRestartedBalance.actualStatus?.balanceMinutes === undefined
      && restartedBalanceHarness.getLocalBalance() === undefined
      && restartedBalanceHarness.getSessionBalance() === undefined,
    '12F-3: 最近有效余额写入 local/session，完整浏览器重启从 local 恢复，明确非 Charge Mode 同步清除');

  const migratedBalanceHarness = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    initialSchedule12,
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true, balanceState: 'unavailable' },
    156
  );
  const migratedBalanceSnapshot = await migratedBalanceHarness.getScheduleSnapshot();
  assertPass(migratedBalanceSnapshot.actualStatus?.balanceMinutes === 156
      && migratedBalanceHarness.getLocalBalance() === 156
      && migratedBalanceHarness.getLocalBalanceWriteCount() === 1,
    '12F-4: 旧版本 session 余额在首次 full 快照时迁移到 local durable cache');

  const popupBalanceMergeSource = extractSourceSection(
    popupJs,
    'function mergeActualStatusCache(cachedStatus, incomingStatus) {',
    '\nasync function refreshStatus()',
    'mergeActualStatusCache'
  );
  const mergeActualStatusCache = new Function(
    `${popupBalanceMergeSource}; return mergeActualStatusCache;`
  )();
  const cachedBalance12 = { isOn: true, balanceState: 'available', balanceMinutes: 156 };
  const mergedUnavailable12 = mergeActualStatusCache(
    cachedBalance12,
    { isOn: false, balanceState: 'unavailable' }
  );
  const mergedMissing12 = mergeActualStatusCache(cachedBalance12, null);
  const mergedOtherMode12 = mergeActualStatusCache(
    cachedBalance12,
    { isOn: true, balanceState: 'not-charge-mode' }
  );
  const mergedFresh12 = mergeActualStatusCache(
    cachedBalance12,
    { isOn: true, balanceState: 'available', balanceMinutes: 200 }
  );
  assertPass(mergedUnavailable12.isOn === false
      && mergedUnavailable12.balanceMinutes === 156
      && mergedMissing12.balanceMinutes === 156
      && mergedOtherMode12.balanceMinutes === undefined
      && mergedFresh12.balanceMinutes === 200,
    '12F-1: popup 缓存跨坏 full/lite 响应保留 Est，明确非 Charge Mode 清除且新余额可更新');
  const refreshStatusStart12 = popupJs.indexOf('async function refreshStatus()');
  const refreshStatusEnd12 = popupJs.indexOf('\nfunction announceState(', refreshStatusStart12);
  const refreshStatusBody12 = popupJs.slice(refreshStatusStart12, refreshStatusEnd12);
  assertPass(refreshStatusBody12.includes('attachCachedActualStatus(schedule);')
      && refreshStatusBody12.includes("throw new Error('后台未返回有效 schedule')")
      && refreshStatusBody12.includes('attachCachedActualStatus({ ...stored.ac_schedule })'),
    '12F-2: popup 对 full、lite 与后台异常回退统一合并缓存，不再让单次响应隐藏 Est');

  assertPass(popupHtml.includes('data-i18n-aria-label="helpTooltip"')
      && /id="timerToggle"[^>]*aria-pressed="false"[^>]*aria-describedby="timerToggleState"/.test(popupHtml)
      && /id="smartModeToggle"[^>]*aria-pressed="false"[^>]*aria-describedby="smartModeToggleState"/.test(popupHtml)
      && popupHtml.includes('for="onMinutes"')
      && popupHtml.includes('for="offMinutes"'),
    '12F: 帮助、两个分段选择按钮和分钟输入均有程序化可访问名称与状态');
  assertPass(/id="helpLink"[^>]*href="https:\/\/github\.com\/BelugaRex\/ac-ust\/issues\/new\/choose"[^>]*target="_blank"[^>]*rel="noopener"/.test(popupHtml),
    '12F-1: 顶部问号打开 GitHub Issue 模板选择页，并保留安全的新标签页行为');
  const bugIssueForm = fs.readFileSync(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8');
  const featureIssueForm = fs.readFileSync(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'feature_request.yml'), 'utf8');
  assertPass(bugIssueForm.includes('name: Bug 报告')
      && bugIssueForm.includes('title: "[Bug] "')
      && bugIssueForm.includes('id: reproduction')
      && bugIssueForm.includes('id: browser-version')
      && bugIssueForm.includes('id: extension-version')
      && bugIssueForm.includes('id: diagnostics')
      && bugIssueForm.includes('id: duplicate-check'),
    '12F-2: Bug Issue Form 收集复现、环境、诊断信息并要求重复检查');
  assertPass(featureIssueForm.includes('name: 功能建议')
      && featureIssueForm.includes('title: "[Feature] "')
      && featureIssueForm.includes('id: motivation')
      && featureIssueForm.includes('id: proposal')
      && featureIssueForm.includes('id: expected-behavior')
      && featureIssueForm.includes('id: contribution')
      && featureIssueForm.includes('id: duplicate-check'),
    '12F-3: 功能建议 Issue Form 收集场景、方案、期望行为和贡献意愿');
  // 桌面 popup 以鼠标为主：帮助按钮和拨杆均超过 WCAG 24px 最低目标；
  // 拨杆再通过绝对定位伪元素扩大命中区，不参与可见布局。
    assertPass(/\.header-help\s*\{[^}]*?width:\s*26px;[^}]*?height:\s*26px;/.test(popupCssNoComments)
      && /\.toggle-switch::after\s*\{[^}]*?inset:\s*-11px\s+-4px/.test(popupCssNoComments)
      && /\.btn-diagnose\s*\{[^}]*?width:\s*100%[^}]*?height:\s*30px/.test(popupCssNoComments)
      && popupCss.includes('.header-help:focus-visible')
      && popupCss.includes('.toggle-switch input:focus-visible + .toggle-slider'),
    '12G: 帮助、拨杆和诊断按钮满足桌面目标尺寸，且键盘焦点环均可见');

  const releaseWorkflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assertPass(/fetch-depth:\s*0/.test(releaseWorkflow)
      && releaseWorkflow.includes('git fetch origin main:refs/remotes/origin/main')
      && releaseWorkflow.includes('git merge-base --is-ancestor "$tag_commit" origin/main'),
    '12H: Release 工作流以完整 Git 历史验证 tag commit 属于 main');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assertPass(readme.includes('下载源码 ZIP，解压后运行 `bash ./build.sh`，再 Load Unpacked `dist/`'),
    '12I: GitHub Releases 安装说明先构建，再加载 dist');
  const storeDir = path.join(ROOT, '商店');
  const webStoreMetadata = fs.readFileSync(path.join(storeDir, 'CHROMEWEBSTORE.md'), 'utf8');
  const storeAssetNames = [
    'icon-128.png',
    'screenshot-1.png',
    'screenshot-2.png',
    'promo-small.png',
    'promo-marquee.png'
  ];
  const expectedStoreAssetDimensions = {
    'icon-128.png': [128, 128],
    'screenshot-1.png': [1280, 800],
    'screenshot-2.png': [1280, 800],
    'promo-small.png': [440, 280],
    'promo-marquee.png': [1400, 560]
  };
  const hasExpectedPngDimensions = (name, expectedDimensions) => {
    const png = fs.readFileSync(path.join(storeDir, '素材', name));
    return png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && png.subarray(12, 16).toString('ascii') === 'IHDR'
      && png.readUInt32BE(16) === expectedDimensions[0]
      && png.readUInt32BE(20) === expectedDimensions[1];
  };
  assertPass(webStoreMetadata.includes(`| 版本 | ${manifest.version} |`)
      && webStoreMetadata.includes(`releases/ac-ust-v${manifest.version}.zip`)
      && fs.existsSync(path.join(storeDir, 'README.md'))
      && fs.existsSync(path.join(storeDir, 'PRIVACY.md'))
      && fs.existsSync(path.join(storeDir, '素材模板.html'))
      && fs.existsSync(path.join(storeDir, '生成素材.mjs'))
      && storeAssetNames.every(name => fs.existsSync(path.join(storeDir, '素材', name)))
      && Object.entries(expectedStoreAssetDimensions)
        .every(([name, dimensions]) => hasExpectedPngDimensions(name, dimensions))
      && fs.readFileSync(path.join(storeDir, '素材', 'icon-128.png'))
        .equals(fs.readFileSync(path.join(ROOT, 'icons', 'ac-ust_128.png'))),
    '12J: Chrome Web Store 提交目录齐全，版本/ZIP 与 manifest 同步，图片尺寸正确且商店图标等同运行图标');

  // ===== 用例 13: PWM 持久化恢复独立于 popup 轮询 =====
  beginSuite('用例 13：PWM 持久化恢复',
    '\n\n=== 用例 13: PWM 持久化恢复独立于 popup 轮询 ===\n');

  const initStart13 = backgroundSource.indexOf('async function init() {');
  const initEnd13 = backgroundSource.indexOf('\n// ----- 设置/更新 PWM 循环闹钟 -----', initStart13);
  const initBody13 = initStart13 >= 0 && initEnd13 > initStart13
    ? backgroundSource.slice(initStart13, initEnd13)
    : '';
  const setupStart13 = backgroundSource.indexOf(
    'async function setupAlarms(startImmediately = false, options = {}) {'
  );
  const setupEnd13 = backgroundSource.indexOf('\nfunction sanitizeMinutes', setupStart13);
  const setupBody13 = setupStart13 >= 0 && setupEnd13 > setupStart13
    ? backgroundSource.slice(setupStart13, setupEnd13)
    : '';
  const watchdogStart13 = backgroundSource.indexOf('async function watchdogCheck() {');
  const watchdogEnd13 = backgroundSource.indexOf('\n// ----- 启动时加载设置并创建闹钟 -----', watchdogStart13);
  const watchdogBody13 = watchdogStart13 >= 0 && watchdogEnd13 > watchdogStart13
    ? backgroundSource.slice(watchdogStart13, watchdogEnd13)
    : '';
  const alarmListenerStart13 = backgroundSource.indexOf('chrome.alarms.onAlarm.addListener(async (alarm) => {');
  const alarmListenerEnd13 = backgroundSource.indexOf('\n// ----- 官方推荐：长时间操作保活', alarmListenerStart13);
  const alarmListenerBody13 = alarmListenerStart13 >= 0 && alarmListenerEnd13 > alarmListenerStart13
    ? backgroundSource.slice(alarmListenerStart13, alarmListenerEnd13)
    : '';

  assertPass(initBody13.includes('await backfillNextTriggerAt(true);')
      && initBody13.includes("'init-finalSync'")
      && initBody13.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,')
      && initBody13.includes('automationRevision'),
    '13A: Service Worker 初始化会从 legacy/live alarm 回填并持久化 nextTriggerAt');
  assertPass(setupBody13.includes("source: 'setupAlarms'")
      && setupBody13.includes("missingClockAction: 'repair-clock'")
      && setupBody13.includes('await recoverPwmLifecycle({'),
    '13B: 启动恢复统一委托生命周期协调器；双重缺失时会安全重建 PWM');
    assertPass(watchdogBody13.includes("source: 'watchdogCheck'")
      && watchdogBody13.includes("preserveLiveStrategy: 'next-only'")
      && watchdogBody13.includes('automationRevision')
      && watchdogBody13.includes('await recoverPwmLifecycle({'),
    '13C: 5 分钟看门狗经统一协调器校准 storage 并恢复缺失的 PWM alarm');
    assertPass(alarmListenerBody13.includes("'badge-tick-sync'")
      && alarmListenerBody13.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,')
      && alarmListenerBody13.includes('automationRevision')
      && alarmListenerBody13.includes("if (alarm.name === 'ac-badge-tick')"),
    '13D: 每分钟 badge tick 会把 live alarm 的相位写回 storage');
  assertPass(alarmListenerBody13.includes("if (alarm.name === 'ac-badge-tick')")
      && alarmListenerBody13.includes('await updateBadge();')
      && alarmListenerBody13.includes('await ensureOffscreen();'),
    '13F: 每分钟 badge-tick 顺带 ensureOffscreen()，守住 L2 长连接保活层');
  assertPass(backgroundSource.includes('offscreenAlive: !!offscreenAlive')
      && backgroundSource.includes('buildTime: BUILD_TIME')
      && backgroundSource.includes('buildTimeEpochMs: BUILD_TIME_EPOCH_MS'),
    '13G: getSwStatus 返回 offscreenAlive 真值与 SW 构建身份');
  assertPass(initBody13.includes('const retryMinutes = Number(schedule.pageTimerRetryMinutes) || 0;')
      && initBody13.includes("createAlarm('ac-page-timer-retry', { when: retryAt })")
      && initBody13.includes("await schedulePageTimerRetry(retryMinutes, '启动恢复错过的页面定时器重试');")
      && initBody13.includes("persistSchedule('init-recover-overdue-page-timer-retry'"),
    '13E: 启动会重新排程浏览器关闭期间错过的页面定时器重试');

  let extractionGuardMessage = '';
  try {
    extractSourceSection('const value = 1;', 'missing-start', 'missing-end', 'guard-sample');
  } catch (error) {
    extractionGuardMessage = error?.message || '';
  }
  assertPass(extractionGuardMessage.includes('guard-sample')
      && extractionGuardMessage.includes('missing-start'),
    '13H: 源码区段提取在标记漂移时 fail fast，并报告具体区段与标记');

  const setNextTriggerSource13 = extractSourceSection(
    backgroundSource,
    'function setNextTriggerAt(nextTriggerAt, options = {}) {',
    '\nasync function executePwmLifecycleRecoveryFallback',
    'durable smart clock origin'
  );
  const originNow13 = new Date(2026, 7, 27, 18, 56, 0, 17).getTime();
  const originTarget13 = new Date(2026, 7, 27, 19, 0, 0, 0).getTime();
  const originSchedule13 = {
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    alarmCreatedAt: 0
  };
  const setNextTriggerAt13 = new Function(
    'schedule', 'Date',
    `const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    ${setNextTriggerSource13}; return setNextTriggerAt;`
  )(
    originSchedule13,
    { now: () => originNow13 }
  );
  setNextTriggerAt13(originTarget13);
  const firstOrigin13 = originSchedule13.smartClockPlannedAt;
  setNextTriggerAt13(originTarget13 + 500.5);
  const verifiedOrigin13 = originSchedule13.smartClockPlannedAt;
  const remoteOrigin13 = originNow13 - 10 * 60_000;
  setNextTriggerAt13(originTarget13 + 500.5, { plannedAt: remoteOrigin13 });
  const adoptedOrigin13 = originSchedule13.smartClockPlannedAt;
  setNextTriggerAt13(0);
  assertPass(firstOrigin13 === originNow13
      && verifiedOrigin13 === originNow13
      && adoptedOrigin13 === remoteOrigin13
      && originSchedule13.nextTriggerAt === 0
      && originSchedule13.smartClockPlannedAt === 0,
    '13H-1: 新时钟认领 immutable origin；同钟 verify 漂移不刷新；远端来源显式继承；清钟同步清来源');

  const resetDisabledPwmRuntimeSource = extractSourceSection(
    backgroundSource,
    'async function resetDisabledPwmRuntime() {',
    '\nasync function persistReconciledPwmTrigger(',
    'resetDisabledPwmRuntime'
  );
  const loadResetDisabledPwmRuntime = new Function(
    'schedule',
    'setNextTriggerAt',
    'chrome',
    'clearPwmAlarm',
    'cancelAutomaticOnRequests',
    'updateBadge',
    `let pwmRuntimeRevision = 0;
    let lastPwmStepAt = 123456;
    ${resetDisabledPwmRuntimeSource};
    return {
      resetDisabledPwmRuntime,
      getLastPwmStepAt: () => lastPwmStepAt
    };`
  );
  const resetRuntimeCalls = [];
  const resetRuntimeSchedule = {
    enabled: true,
    pwmState: 'on',
    nextTriggerAt: Date.now() + 60_000,
    smartClockPlannedAt: Date.now() - 60_000,
    alarmCreatedAt: Date.now(),
    alarmDelayMinutes: 30,
    pageTimerMinutes: 30,
    pageTimerTargetAt: Date.now() + 30 * 60_000,
    pageTimerError: 'keep',
    pageTimerRetryAt: Date.now() + 60_000,
    pageTimerRetryMinutes: 1,
    comfortStartUntil: Date.now() + 5 * 60_000,
    comfortStartOnConfirmedAt: Date.now(),
    smartOnBoundaryAt: Date.now() - 30 * 60_000,
    pwmRetryKind: 'smart-on',
    pwmRetryBoundaryAt: Date.now() - 30 * 60_000,
    pwmRetryScheduledAt: Date.now() + 60_000
  };
  const resetDisabledPwmRuntimeHarness = loadResetDisabledPwmRuntime(
    resetRuntimeSchedule,
    value => {
      resetRuntimeCalls.push(`next:${value}`);
      resetRuntimeSchedule.nextTriggerAt = value;
      if (!(value > 0)) resetRuntimeSchedule.smartClockPlannedAt = 0;
    },
    {
      alarms: {
        async clear(name) { resetRuntimeCalls.push(`clear:${name}`); }
      }
    },
    async () => { resetRuntimeCalls.push('clear:ac-pwm'); },
    async () => { resetRuntimeCalls.push('cancel-on'); },
    async () => { resetRuntimeCalls.push('updateBadge'); }
  );
  await resetDisabledPwmRuntimeHarness.resetDisabledPwmRuntime();
  assertPass(resetRuntimeSchedule.enabled === true
      && resetRuntimeSchedule.pwmState === 'off'
      && resetRuntimeSchedule.nextTriggerAt === 0
      && resetRuntimeSchedule.smartClockPlannedAt === 0
      && resetRuntimeSchedule.alarmCreatedAt === 0
      && resetRuntimeSchedule.alarmDelayMinutes === 0
      && resetRuntimeSchedule.comfortStartUntil === 0
      && resetRuntimeSchedule.comfortStartOnConfirmedAt === 0
      && resetRuntimeSchedule.smartOnBoundaryAt === 0
      && resetRuntimeSchedule.pwmRetryKind === ''
      && resetRuntimeSchedule.pwmRetryBoundaryAt === 0
      && resetRuntimeSchedule.pwmRetryScheduledAt === 0
      && resetRuntimeSchedule.pageTimerMinutes === 30
      && resetRuntimeSchedule.pageTimerError === 'keep'
      && resetRuntimeSchedule.pageTimerRetryMinutes === 1
      && resetDisabledPwmRuntimeHarness.getLastPwmStepAt() === 0,
    '13I: 停用运行态 helper 重置 PWM 时钟与旧冷却，不改 enabled 或页面定时器证明');
  assertPass(resetRuntimeCalls.join(',') === [
    'cancel-on',
    'next:0',
    'clear:ac-pwm',
    'clear:ac-badge-tick',
    'clear:ac-watchdog',
    'clear:ac-comfort-end',
    'updateBadge'
  ].join(','),
  '13J: 停用运行态 helper 清空 PWM、badge、watchdog 与舒适截止闹钟并刷新 badge，保留页面关机重试');

  const activeBoundaryBody = extractSourceSection(
    backgroundSource,
    'async function onActiveBoundaryCrossed() {',
    '\nfunction getLegacyAlarmEndMs()',
    'onActiveBoundaryCrossed'
  );
  const applySyncedPhaseBody = extractSourceSection(
    backgroundSource,
    'async function applySyncedPhase(remote, reason = \'\') {',
    '\n// 从 chrome.storage.sync 拉取并尝试合并。',
    'applySyncedPhase'
  );
  const updateScheduleBody = extractSourceSection(
    backgroundSource,
    "if (msg.type === 'updateSchedule') {",
    "\n    if (msg.type === 'getSchedule') {",
    'updateSchedule message branch'
  );
  const activeResetIndex = activeBoundaryBody.indexOf('await resetDisabledPwmRuntime();');
  const activePersistIndex = activeBoundaryBody.indexOf("persistSchedule('active-hours-leave-pre-shutdown'");
  const activeShutdownIndex = activeBoundaryBody.indexOf("requestTimerBasedShutdown('active-hours-leave')");
  const syncResetIndex = applySyncedPhaseBody.indexOf('await resetDisabledPwmRuntime();');
  const syncPersistIndex = applySyncedPhaseBody.indexOf("persistSchedule('sync-disabled-pre-shutdown'");
  const syncShutdownIndex = applySyncedPhaseBody.indexOf("requestTimerBasedShutdown('sync-disabled')");
  const updateResetIndex = updateScheduleBody.indexOf('await resetDisabledPwmRuntime();');
  const updateIntentIndex = updateScheduleBody.indexOf(
    "'updateSchedule-disable-admission-intent'"
  );
  const updateShutdownIndex = updateScheduleBody.indexOf("requestTimerBasedShutdown('schedule-disabled')");
  assertPass(countOccurrences(backgroundSource, 'await resetDisabledPwmRuntime();') === 4
      && activeResetIndex >= 0 && activePersistIndex > activeResetIndex && activeShutdownIndex > activePersistIndex
      && syncResetIndex >= 0 && syncPersistIndex > syncResetIndex && syncShutdownIndex > syncPersistIndex
      && updateIntentIndex >= 0 && updateResetIndex > updateIntentIndex
      && updateShutdownIndex > updateResetIndex
      && updateScheduleBody.includes('markSyncPublishPending: true'),
    '13K: 停用路径统一委派 helper；用户停用先原子落 schedule+publish intent，再清闹钟与设置页面关机');

  const persistReconciledPwmTriggerSource = extractSourceSection(
    backgroundSource,
    'async function persistReconciledPwmTrigger(',
    '\nasync function syncStoredTriggerFromAlarm(',
    'persistReconciledPwmTrigger'
  );
  const loadPersistReconciledPwmTrigger = new Function(
    'schedule',
    'reconcilePwmTrigger',
    'applyPwmPlanState',
    'persistSchedule',
    `${persistReconciledPwmTriggerSource}; return persistReconciledPwmTrigger;`
  );
  const reconcileSchedule13L = { enabled: true, nextTriggerAt: 0 };
  const reconcileAlarm13L = { name: 'ac-pwm', scheduledTime: Date.now() + 60_000 };
  const reconcileOptions13L = { nextTriggerToleranceMs: 1500, requireLegacyAlignment: false };
  const reconcilePlan13L = {
    kind: 'sync-live',
    liveScheduledTime: reconcileAlarm13L.scheduledTime,
    phasePatch: { nextTriggerAt: reconcileAlarm13L.scheduledTime }
  };
  const reconcileCalls13L = [];
  const persistReconciledPwmTrigger = loadPersistReconciledPwmTrigger(
    reconcileSchedule13L,
    (receivedSchedule, receivedAlarm, receivedOptions) => {
      reconcileCalls13L.push('reconcile');
      assertPass(receivedSchedule === reconcileSchedule13L
          && receivedAlarm === reconcileAlarm13L
          && receivedOptions === reconcileOptions13L,
        '13L-1: live alarm helper 原样传递 schedule、alarm 与调用点 profile');
      return reconcilePlan13L;
    },
    plan => {
      reconcileCalls13L.push('apply');
      Object.assign(reconcileSchedule13L, plan.phasePatch);
    },
    async (reason, options) => {
      reconcileCalls13L.push(`persist:${reason}:${options?.syncFromLiveAlarm}`);
    }
  );
  const reconciledPlan13L = await persistReconciledPwmTrigger(
    reconcileAlarm13L,
    'unit-reconcile',
    reconcileOptions13L
  );
  assertPass(reconciledPlan13L === reconcilePlan13L
      && reconcileSchedule13L.nextTriggerAt === reconcileAlarm13L.scheduledTime
      && reconcileCalls13L.join(',') === 'reconcile,apply,persist:unit-reconcile:false',
    '13L-2: sync-live 计划严格按 planner→apply→非递归持久化顺序执行并返回 plan');

  let noopApplyCount13L = 0;
  let noopPersistCount13L = 0;
  const noopReconcile = loadPersistReconciledPwmTrigger(
    { enabled: true },
    () => ({ kind: 'noop', reason: 'aligned' }),
    () => { noopApplyCount13L += 1; },
    async () => { noopPersistCount13L += 1; }
  );
  const noopPlan13L = await noopReconcile(reconcileAlarm13L, 'noop', reconcileOptions13L);
  assertPass(noopPlan13L === null && noopApplyCount13L === 0 && noopPersistCount13L === 0,
    '13L-3: 非 sync-live 计划不应用状态、不写 storage，并返回 null');

  const syncStoredTriggerBody = extractSourceSection(
    backgroundSource,
    'async function syncStoredTriggerFromAlarm(',
    '\nfunction getLiveAlarmEndMs(',
    'syncStoredTriggerFromAlarm'
  );
  const ensureDiagnosticAlarmsBody = extractSourceSection(
    backgroundSource,
    'async function ensureDiagnosticAlarms() {',
    '\nchrome.runtime.onMessage.addListener',
    'ensureDiagnosticAlarms'
  );
  const persistScheduleBody = extractSourceSection(
    backgroundSource,
    'async function persistSchedule(',
    '\n// 跨设备同步 — chrome.storage.sync 集成层',
    'persistSchedule'
  );
    assertPass(syncStoredTriggerBody.includes('PWM_TRIGGER_STRICT_OPTIONS,')
      && syncStoredTriggerBody.includes('automationRevision')
        && watchdogBody13.includes("'watchdogCheck'")
        && initBody13.includes("'init-finalSync'")
        && alarmListenerBody13.includes("'badge-tick-sync'")
        && ensureDiagnosticAlarmsBody.includes("'ensureDiagnosticAlarms'")
        && [initBody13, alarmListenerBody13, ensureDiagnosticAlarmsBody]
          .every(source => source.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,')
            && /(?:automationRevision|diagnosticRevision)/.test(source))
        && watchdogBody13.includes("preserveLiveStrategy: 'next-only'")
        && backgroundSource.includes('context.preserveLiveStrategy === \'next-only\'')
        && backgroundSource.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,'),
    '13M: strict wrapper 与四条副作用校准路径统一委派持久化 helper，并显式保留各自 profile');
  assertPass(ensureDiagnosticAlarmsBody.includes('schedule.smartMode?.enabled && !smartWeatherAlarm')
      && ensureDiagnosticAlarmsBody.includes('await rescheduleSmartWeatherAlarm();')
      && ensureDiagnosticAlarmsBody.includes('smartWeather: smartWeatherAlarm ? { scheduledTime: smartWeatherAlarm.scheduledTime } : null'),
    '13M-2: 诊断自愈补建 ac-smart-weather（智能模式天气闹钟）并回传 alarm 状态');
  assertPass(ensureDiagnosticAlarmsBody.includes('const repairs = [];')
      && ensureDiagnosticAlarmsBody.includes("repairs.push('badge-alarm')")
      && ensureDiagnosticAlarmsBody.includes("repairs.push('watchdog-alarm')")
      && ensureDiagnosticAlarmsBody.includes("repairs.push('pwm-alarm')")
      && ensureDiagnosticAlarmsBody.includes("repairs.push('pwm-trigger')")
      && ensureDiagnosticAlarmsBody.includes("repairs.push('smart-weather-alarm')")
      && ensureDiagnosticAlarmsBody.includes("'pwm-alarm-cleared'")
      && ensureDiagnosticAlarmsBody.includes("'badge-alarm-cleared'")
      && ensureDiagnosticAlarmsBody.includes("'watchdog-alarm-cleared'")
      && ensureDiagnosticAlarmsBody.includes("'smart-weather-alarm-cleared'")
      && ensureDiagnosticAlarmsBody.includes('before: beforeAlarms')
      && ensureDiagnosticAlarmsBody.includes('repairs,'),
    '13M-3: 诊断自愈返回修复前闹钟快照与逐项 repairs，不再用总布尔值掩盖根因');
  assertPass(ensureDiagnosticAlarmsBody.indexOf('const diagnosticRequestAt = Date.now();')
        < ensureDiagnosticAlarmsBody.indexOf('await loadScheduleFromStorage();')
      && ensureDiagnosticAlarmsBody.includes('schemaVersion: 2')
      && ensureDiagnosticAlarmsBody.includes('evidence: {')
      && ensureDiagnosticAlarmsBody.includes('before: diagnosticBefore')
      && ensureDiagnosticAlarmsBody.includes('after: diagnosticAfter')
      && ensureDiagnosticAlarmsBody.includes('memorySchedule,')
      && ensureDiagnosticAlarmsBody.includes('storedSchedule:')
      && ensureDiagnosticAlarmsBody.includes('currentAttempt:')
      && ensureDiagnosticAlarmsBody.includes('lastOutcome:'),
    '13M-3A: ensureDiagnostics 在任何修复前冻结版本化首现场，并分别返回 repair/after');
  assertPass(backgroundSource.includes('let currentPwmAttempt = null;')
      && backgroundSource.includes('let activePwmAttempts = new Map();')
      && backgroundSource.includes('let lastPwmOutcome = null;')
      && backgroundSource.includes('function beginPwmDiagnosticAttempt(')
      && backgroundSource.includes('function finishPwmDiagnosticAttempt(')
      && backgroundSource.includes('currentPwmAttempt:')
      && backgroundSource.includes('lastPwmOutcome:'),
    '13M-3B: 共享 PWM executor 暴露当前尝试和最近结局，单份到期诊断可区分 pending/in-flight/result');
  assertPass(backgroundSource.includes("const PWM_LAST_OUTCOME_KEY = 'ac_pwm_last_outcome';")
      && backgroundSource.includes('function normalizePwmDiagnosticOutcome(')
      && backgroundSource.includes('async function persistPwmDiagnosticOutcomeBestEffort(')
      && backgroundSource.includes('async function readPersistedPwmDiagnosticOutcome(')
      && backgroundSource.includes('selectLatestPwmDiagnosticOutcome(')
      && backgroundSource.includes('async function waitForPwmDiagnosticOutcomePersistence(')
      && backgroundSource.includes('Promise.race(['),
    '13M-3B1: 最近 PWM 结果以单对象、脱敏有界的 local 记录跨 MV3 Worker 重启保留');
  const pwmOutcomePersistenceSource13 = extractSourceSection(
    backgroundSource,
    'async function persistPwmDiagnosticOutcomeBestEffort(',
    '\n\nfunction finishPwmDiagnosticAttempt(',
    'bounded PWM diagnostic outcome persistence'
  );
  const loadPwmOutcomePersistence13 = storageSet => new Function(
    'chrome', 'PWM_LAST_OUTCOME_KEY', 'normalizePwmDiagnosticOutcome',
    'lastPwmOutcome', 'console',
    `let pwmOutcomeWriteGeneration = 0;
    ${pwmOutcomePersistenceSource13}
    return waitForPwmDiagnosticOutcomePersistence;`
  )(
    { storage: { local: { set: storageSet } } },
    'ac_pwm_last_outcome',
    value => value,
    { attemptId: 99, finishedAt: 99 },
    quietConsole
  );
  const neverSettlingPwmPersistence13 = loadPwmOutcomePersistence13(
    () => new Promise(() => {})
  );
  const neverSettlingPersistenceStarted13 = Date.now();
  const neverSettlingPersistenceResult13 = await neverSettlingPwmPersistence13(
    { attemptId: 1, finishedAt: 1 },
    20
  );
  const neverSettlingPersistenceElapsed13 = Date.now()
    - neverSettlingPersistenceStarted13;
  const rejectingPwmPersistence13 = loadPwmOutcomePersistence13(
    async () => { throw new Error('storage reject'); }
  );
  const rejectingPersistenceResult13 = await rejectingPwmPersistence13(
    { attemptId: 2, finishedAt: 2 },
    20
  );
  assertPass(neverSettlingPersistenceResult13 === false
      && neverSettlingPersistenceElapsed13 >= 10
      && neverSettlingPersistenceElapsed13 < 200
      && rejectingPersistenceResult13 === false,
    '13M-3B1A: outcome storage 永不 settle 或 reject 都在有界期限内返回 false，不阻塞业务 executor');
  const controlledOutcomeWrites13 = [];
  let durableOutcome13 = null;
  const outcomeRaceHarness13 = new Function(
    'chrome', 'PWM_LAST_OUTCOME_KEY', 'normalizePwmDiagnosticOutcome', 'console',
    `let pwmOutcomeWriteGeneration = 0;
    let lastPwmOutcome = null;
    ${pwmOutcomePersistenceSource13}
    return {
      persist: persistPwmDiagnosticOutcomeBestEffort,
      setLast(value) { lastPwmOutcome = value; }
    };`
  )(
    {
      storage: {
        local: {
          set(envelope) {
            const value = envelope.ac_pwm_last_outcome;
            return new Promise(resolve => {
              controlledOutcomeWrites13.push({
                attemptId: value.attemptId,
                release() {
                  durableOutcome13 = value;
                  resolve();
                }
              });
            });
          }
        }
      }
    },
    'ac_pwm_last_outcome',
    value => value,
    quietConsole
  );
  const waitForOutcomeWrites13 = async expectedCount => {
    const startedAt = Date.now();
    while (controlledOutcomeWrites13.length < expectedCount
        && Date.now() - startedAt < 200) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return controlledOutcomeWrites13.length >= expectedCount;
  };
  const outcomeA13 = { attemptId: 1, finishedAt: 1 };
  const outcomeB13 = { attemptId: 2, finishedAt: 2 };
  const outcomeC13 = { attemptId: 3, finishedAt: 3 };
  outcomeRaceHarness13.setLast(outcomeA13);
  const outcomeWriteA13 = outcomeRaceHarness13.persist(outcomeA13);
  outcomeRaceHarness13.setLast(outcomeB13);
  const outcomeWriteB13 = outcomeRaceHarness13.persist(outcomeB13);
  controlledOutcomeWrites13[0].release();
  const sawCorrectionB13 = await waitForOutcomeWrites13(3);
  outcomeRaceHarness13.setLast(outcomeC13);
  const outcomeWriteC13 = outcomeRaceHarness13.persist(outcomeC13);
  controlledOutcomeWrites13[3]?.release();
  const outcomeWriteCResult13 = await outcomeWriteC13;
  controlledOutcomeWrites13[2]?.release();
  const sawSecondCorrectionC13 = await waitForOutcomeWrites13(5);
  controlledOutcomeWrites13[4]?.release();
  const outcomeWriteAResult13 = await outcomeWriteA13;
  void outcomeWriteB13;
  assertPass(sawCorrectionB13
      && sawSecondCorrectionC13
      && outcomeWriteAResult13 === true
      && outcomeWriteCResult13 === true
      && controlledOutcomeWrites13.map(write => write.attemptId).join(',')
        === '1,2,2,3,3'
      && durableOutcome13 === outcomeC13,
    '13M-3B1B: A 补写 B 期间 C 已落盘时，A 再重检并补回 C，三代乱序不会回滚持久诊断');
  assertPass(ensureDiagnosticAlarmsBody.includes('function readDiagnosticRuntimeState(')
      && ensureDiagnosticAlarmsBody.includes('function diagnosticSnapshotFingerprint(')
      && ensureDiagnosticAlarmsBody.includes('captureAttempts')
      && ensureDiagnosticAlarmsBody.includes("'runtime-changed-during-capture'")
      && ensureDiagnosticAlarmsBody.includes('first.coherent && first.complete')
      && ensureDiagnosticAlarmsBody.includes("'external-read-incomplete-after-retry'"),
    '13M-3B2: 诊断快照用 owner/attempt/runtime 指纹复检并最多重采一次，不把同 revision 混合现场标成 coherent');
  const pwmDiagnosticAttemptSource13 = extractSourceSection(
    backgroundSource,
    'function beginPwmDiagnosticAttempt(',
    '\n\nfunction claimPwmStepOwnership()',
    'PWM diagnostic attempt instrumentation'
  );
  const pwmDiagnosticAttemptHarness13 = new Function(
    `let pwmDiagnosticAttemptSequence = 0;
    let activePwmAttempts = new Map();
    let currentPwmAttempt = null;
    let lastPwmOutcome = null;
    const schedule = {
      pwmState: 'on',
      smartOnBoundaryAt: 1787936400000,
      pwmRetryKind: 'smart-on-safety-timer',
      pwmRetryBoundaryAt: 1787936400000,
      pwmRetryScheduledAt: 1787936760000,
      nextTriggerAt: 1787936760000,
      pageTimerTargetAt: 1787937780000,
      pageTimerError: ''
    };
    ${pwmDiagnosticAttemptSource13};
    return {
      schedule,
      beginPwmDiagnosticAttempt,
      finishPwmDiagnosticAttempt,
      inferPwmDiagnosticOutcomeStatus,
      getCurrent: () => currentPwmAttempt,
      getActive: () => getActivePwmDiagnosticAttempts(),
      getLast: () => lastPwmOutcome
    };`
  )();
  const pwmAttemptId13 = pwmDiagnosticAttemptHarness13.beginPwmDiagnosticAttempt({
    source: 'alarm-ac-pwm',
    scheduledTime: 1787936760000,
    automationRevision: 41
  });
  const currentPwmAttempt13 = pwmDiagnosticAttemptHarness13.getCurrent();
  const duplicatePwmAttemptId13 = pwmDiagnosticAttemptHarness13.beginPwmDiagnosticAttempt({
    source: 'watchdog-duplicate',
    scheduledTime: 1787936760000,
    automationRevision: 41
  });
  const currentAfterDuplicate13 = pwmDiagnosticAttemptHarness13.getCurrent();
  pwmDiagnosticAttemptHarness13.schedule.pageTimerError = '输入框未接受时间 01:23';
  pwmDiagnosticAttemptHarness13.schedule.nextTriggerAt = Date.now() + 60000;
  const inferredPwmOutcome13 = pwmDiagnosticAttemptHarness13
    .inferPwmDiagnosticOutcomeStatus();
  const pwmAttemptFinished13 = pwmDiagnosticAttemptHarness13.finishPwmDiagnosticAttempt(
    pwmAttemptId13,
    inferredPwmOutcome13,
    'schedule-retains-page-timer-error'
  );
  const lastPwmOutcome13 = pwmDiagnosticAttemptHarness13.getLast();
  const currentAfterFirstFinish13 = pwmDiagnosticAttemptHarness13.getCurrent();
  const duplicatePwmOutcome13 = pwmDiagnosticAttemptHarness13.finishPwmDiagnosticAttempt(
    duplicatePwmAttemptId13,
    'skipped',
    'duplicate-physical-owner'
  );
  assertPass(currentPwmAttempt13?.attemptId === 1
      && duplicatePwmAttemptId13 === 2
      && currentAfterDuplicate13?.attemptId === pwmAttemptId13
      && currentAfterDuplicate13?.source === 'alarm-ac-pwm'
      && pwmDiagnosticAttemptHarness13.getActive().length === 0
      && currentPwmAttempt13.action === 'on'
      && currentPwmAttempt13.boundaryAt === 1787936400000
      && inferredPwmOutcome13 === 'retry-scheduled'
      && pwmAttemptFinished13?.status === 'retry-scheduled'
      && currentAfterFirstFinish13?.attemptId === duplicatePwmAttemptId13
      && lastPwmOutcome13?.status === 'retry-scheduled'
      && lastPwmOutcome13?.pageTimerError.includes('01:23')
      && lastPwmOutcome13?.retryBoundaryAt === 1787936400000
      && duplicatePwmOutcome13?.attemptId === duplicatePwmAttemptId13
      && pwmDiagnosticAttemptHarness13.getCurrent() === null,
    '13M-3C: 并发 executor 各有 attempt；任一结算不清除另一项，结果字段不串线');
  const ensureScheduleClockBody13 = extractSourceSection(
    backgroundSource,
    'async function ensureScheduleClock(options = {}) {',
    '\n\nasync function repairScheduleClock(options = {})',
    'diagnostic lifecycle clock delegation'
  );
  const diagnosticSmartGateStart13 = ensureDiagnosticAlarmsBody.indexOf(
    'const comfortStartInFlight = isComfortStartActive() && !pwmAlarm;'
  );
  const diagnosticSmartGateEnd13 = ensureDiagnosticAlarmsBody.indexOf(
    '// 活闹钟存在但 storage 可能缺失 nextTriggerAt',
    diagnosticSmartGateStart13
  );
  const diagnosticSmartGateSource13 = diagnosticSmartGateStart13 >= 0
      && diagnosticSmartGateEnd13 > diagnosticSmartGateStart13
    ? ensureDiagnosticAlarmsBody.slice(diagnosticSmartGateStart13, diagnosticSmartGateEnd13)
    : '';
  const runDiagnosticSmartCycleCase13 = async ({ recoveryKind, mutateState, started = false }) => {
    const now = new Date(2026, 7, 27, 22, 31, 0, 0).getTime();
    const oldAlarmAt = new Date(2026, 7, 27, 23, 0, 0, 0).getTime();
    const newAlarmAt = new Date(2026, 7, 27, 22, 52, 0, 0).getTime();
    const testSchedule = {
      enabled: true,
      pwmState: 'on',
      onMinutes: recoveryKind === 'recover-smart-current-cycle' ? 22 : 0,
      offMinutes: recoveryKind === 'recover-smart-current-cycle' ? 8 : 30,
      smartMode: { enabled: true }
    };
    let ensureCalls = 0;
    let ensureOptions = null;
    const run = new Function(
      'schedule', 'chrome', 'isComfortStartActive', 'ensureScheduleClock', 'Date',
      `return (async () => {
      let pwmAlarm = { scheduledTime: ${oldAlarmAt} };
      let smartWeatherAlarm = { scheduledTime: ${oldAlarmAt} };
      let badgeAlarm = { scheduledTime: ${oldAlarmAt} };
      let watchdogAlarm = { scheduledTime: ${oldAlarmAt} };
      let pwmRuntimeRevision = 4;
      const repairs = [];
      ${diagnosticSmartGateSource13}
      return { repairs, pwmAlarm, schedule };
      })();`
    );
    const result = await run(
      testSchedule,
      {
        alarms: {
          async get(name) {
            if (name === 'ac-pwm') return {
              scheduledTime: recoveryKind === 'recover-smart-current-cycle' && !started
                ? newAlarmAt
                : oldAlarmAt
            };
            return { scheduledTime: oldAlarmAt };
          }
        }
      },
      () => false,
      async options => {
        ensureCalls += 1;
        ensureOptions = options;
        if (mutateState) testSchedule.pwmState = mutateState;
        return { handled: true, started, plan: { kind: recoveryKind } };
      },
      { now: () => now }
    );
    return { ...result, ensureCalls, ensureOptions };
  };
  const recoveredDiagnosticSmartCycle13 = await runDiagnosticSmartCycleCase13({
    recoveryKind: 'recover-smart-current-cycle',
    mutateState: 'off'
  });
  const zeroOnDiagnosticSmartCycle13 = await runDiagnosticSmartCycleCase13({
    recoveryKind: 'preserve-live-alarm',
    mutateState: 'on'
  });
  const startedDiagnosticSmartCycle13 = await runDiagnosticSmartCycleCase13({
    recoveryKind: 'recover-smart-current-cycle',
    mutateState: null,
    started: true
  });
  assertPass(ensureScheduleClockBody13.includes('return recoverPwmLifecycle({')
      && ensureScheduleClockBody13.includes('deferSmartCurrentCycleExecution: options.deferSmartCurrentCycleExecution === true')
      && recoveredDiagnosticSmartCycle13.ensureCalls === 1
      && recoveredDiagnosticSmartCycle13.ensureOptions?.deferSmartCurrentCycleExecution === true
      && recoveredDiagnosticSmartCycle13.repairs.includes('smart-current-cycle')
      && recoveredDiagnosticSmartCycle13.repairs.includes('pwm-alarm')
      && zeroOnDiagnosticSmartCycle13.ensureCalls === 1
      && zeroOnDiagnosticSmartCycle13.repairs.length === 0
      && startedDiagnosticSmartCycle13.repairs.includes('smart-current-cycle-started')
      && !startedDiagnosticSmartCycle13.repairs.includes('smart-current-cycle')
      && ensureDiagnosticAlarmsBody.includes('const triggerPlan = smartCurrentCycleStarted')
      && ensureDiagnosticAlarmsBody.includes('? null')
      && ensureDiagnosticAlarmsBody.indexOf('const triggerPlan = smartCurrentCycleStarted')
        < ensureDiagnosticAlarmsBody.indexOf(': await persistReconciledPwmTrigger('),
    '13M-4: 22:31 即使三方未来钟为 23:00，诊断也启动当前周期恢复；in-flight 明示 started 且不把旧 23:00 闹钟回写，on=0 保留未来钟');
  assertPass(persistScheduleBody.includes('reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS)')
      && persistScheduleBody.includes('if (!schedule.smartMode?.enabled) {')
      && persistScheduleBody.includes('schedule.smartOnBoundaryAt = 0;')
      && persistScheduleBody.includes("schedule.pwmRetryKind = '';")
      && persistScheduleBody.includes('schedule.pwmRetryBoundaryAt = 0;')
      && persistScheduleBody.includes('schedule.pwmRetryScheduledAt = 0;')
      && !persistScheduleBody.includes('persistReconciledPwmTrigger(')
      && snapshotBody.includes('reconcilePwmTrigger(')
      && snapshotBody.includes('PWM_TRIGGER_SNAPSHOT_OPTIONS')
      && snapshotBody.includes('if (!snapshot._phaseAdoptionInFlight)')
      && !snapshotBody.includes('persistReconciledPwmTrigger('),
    '13N: persistSchedule 防递归与 getScheduleSnapshot 只读路径继续直接调用 planner');

  // ===== 用例 14: 清晰与低干扰弹窗回归 =====
  beginSuite('用例 14：低干扰弹窗', '\n\n=== 用例 14: 清晰与低干扰弹窗回归 ===\n');

  const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const diagnosticRuntimeSelectorStart14 = popupSource.indexOf(
    'function selectDiagnosticRuntimeValue('
  );
  const diagnosticRuntimeSelectorEnd14 = popupSource.indexOf(
    '\n}\n',
    diagnosticRuntimeSelectorStart14
  );
  const diagnosticRuntimeSelectorSource14 = diagnosticRuntimeSelectorStart14 >= 0
      && diagnosticRuntimeSelectorEnd14 > diagnosticRuntimeSelectorStart14
    ? popupSource.slice(
        diagnosticRuntimeSelectorStart14,
        diagnosticRuntimeSelectorEnd14 + 3
      )
    : '';
  const selectDiagnosticRuntimeValue14 = diagnosticRuntimeSelectorSource14
    ? new Function(
        `${diagnosticRuntimeSelectorSource14}; return selectDiagnosticRuntimeValue;`
      )()
    : null;
  const attemptBefore14 = { attemptId: 1, source: 'before' };
  const attemptAfter14 = { attemptId: 2, source: 'after' };
  assertPass(typeof selectDiagnosticRuntimeValue14 === 'function'
      && selectDiagnosticRuntimeValue14(
        { runtime: { currentAttempt: null } },
        { runtime: { currentAttempt: attemptBefore14 } },
        'currentAttempt'
      ) === null
      && selectDiagnosticRuntimeValue14(
        { runtime: { currentAttempt: attemptAfter14 } },
        { runtime: { currentAttempt: attemptBefore14 } },
        'currentAttempt'
      ) === attemptAfter14
      && selectDiagnosticRuntimeValue14(
        null,
        { runtime: { currentAttempt: attemptBefore14 } },
        'currentAttempt'
      ) === attemptBefore14
      && popupSource.includes('pwmStepRunning: after.runtime?.pwmStepRunning === true')
      && !popupSource.includes('diagnosticAfter?.runtime?.currentAttempt\n      || diagnosticBefore'),
    '14A-0: schema v2 的 after=null 是已结算真相，不回退 before-in-flight 或把当前安全错误降级');
  const diagnosticEvidenceReaderSource14 = extractSourceSection(
    popupSource,
    'function classifyDiagnosticEvidence(',
    '\n\nfunction formatBuildTimeShort(',
    'Popup diagnostic evidence reader'
  );
  const diagnosticEvidenceReaders14 = new Function(
    `${diagnosticRuntimeSelectorSource14}
    ${diagnosticEvidenceReaderSource14}
    return { classifyDiagnosticEvidence, readDiagnosticEvidence };`
  )();
  const completeSnapshotShape14 = {
    memorySchedule: {},
    storedSchedule: {},
    alarms: {},
    readErrors: []
  };
  const evidenceBefore14 = {
    ...completeSnapshotShape14,
    coherent: true,
    complete: true,
    owner: { action: 'on' },
    runtime: {
      currentAttempt: attemptBefore14,
      lastOutcome: { attemptId: 0 },
      pwmStepRunning: true
    }
  };
  const oneSidedEvidence14 = diagnosticEvidenceReaders14.readDiagnosticEvidence({
    schemaVersion: 2,
    evidence: { before: evidenceBefore14, after: null }
  });
  const settledEvidence14 = diagnosticEvidenceReaders14.readDiagnosticEvidence({
    schemaVersion: 2,
    evidence: {
      before: evidenceBefore14,
      after: {
        ...completeSnapshotShape14,
        coherent: true,
        complete: true,
        owner: { action: 'off' },
        runtime: {
          currentAttempt: null,
          lastOutcome: { attemptId: 2 },
          pwmStepRunning: false
        }
      }
    }
  });
  const incompleteEvidence14 = diagnosticEvidenceReaders14.readDiagnosticEvidence({
    schemaVersion: 2,
    evidence: {
      before: evidenceBefore14,
      after: {
        ...completeSnapshotShape14,
        coherent: true,
        complete: false,
        owner: { action: 'off' },
        runtime: {}
      }
    }
  });
  const missingStructureEvidence14 = diagnosticEvidenceReaders14.readDiagnosticEvidence({
    schemaVersion: 2,
    evidence: { before: {}, after: {} }
  });
  const incoherentEvidence14 = diagnosticEvidenceReaders14.readDiagnosticEvidence({
    schemaVersion: 2,
    evidence: {
      before: evidenceBefore14,
      after: {
        ...completeSnapshotShape14,
        coherent: false,
        complete: true,
        owner: { action: 'off' },
        runtime: {}
      }
    }
  });
  const concurrentEvidence14 = diagnosticEvidenceReaders14.readDiagnosticEvidence({
    schemaVersion: 2,
    evidence: {
      before: evidenceBefore14,
      after: {
        ...completeSnapshotShape14,
        coherent: true,
        complete: true,
        owner: { action: 'off' },
        runtime: {
          currentAttempt: attemptBefore14,
          currentAttempts: [attemptBefore14, attemptAfter14],
          lastOutcome: null,
          pwmStepRunning: true
        }
      }
    }
  });
  assertPass(oneSidedEvidence14.status === 'incomplete'
      && oneSidedEvidence14.usable === false
      && oneSidedEvidence14.owner === null
      && oneSidedEvidence14.currentAttempt === null
      && oneSidedEvidence14.currentAttempts.length === 0
      && oneSidedEvidence14.lastOutcome === null
      && oneSidedEvidence14.pwmStepRunning === null
      && settledEvidence14.status === 'usable'
      && settledEvidence14.currentAttempt === null
      && settledEvidence14.lastOutcome?.attemptId === 2
      && settledEvidence14.pwmStepRunning === false
      && incompleteEvidence14.status === 'incomplete'
      && incompleteEvidence14.currentAttempt === null
      && missingStructureEvidence14.status === 'incomplete'
      && missingStructureEvidence14.usable === false
      && incoherentEvidence14.status === 'incoherent'
      && concurrentEvidence14.currentAttempts.length === 2
      && concurrentEvidence14.currentAttempts[1] === attemptAfter14
      && concurrentEvidence14.pwmStepRunning === true
      && popupSource.includes('diagnosticCurrentAttempts.map(attempt => (')
      && diagnosticEvidenceReaders14.classifyDiagnosticEvidence(null) === 'absent',
    '14A-0A: 证据缺失/不完整/不一致统一失效；完整 after 的 null 才结算，并发 attempt 全量进入复制报告');
  assertPass(popupHtml.includes('id="statusAnnouncement" role="status" aria-live="polite"')
      && popupHtml.includes('role="region" aria-labelledby="acStateText"')
      && popupHtml.includes('id="diagnoseResult" role="region"'),
    '14A: 状态、提示与诊断结果提供语义区域和受控实时反馈');
  assertPass(!popupHtml.includes('body.reading-mode')
      && !popupHtml.includes('id="readingModeToggle"')
      && !popupHtml.includes('class="comfort-card"')
      && !popupSource.includes('ac_accessibility_preferences'),
    '14B: 弹窗已移除易读模式、专属卡片和本地偏好分支');
    assertPass(!popupCss.includes('@keyframes pulse')
      && !popupCss.includes('animation: pulse')
      && popupCss.includes('@media (prefers-reduced-motion: reduce)')
        && /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none !important;[\s\S]*?transition:\s*none !important;/.test(popupCss)
      && popupCss.includes('@media (prefers-contrast: more)')
      && /color-scheme:\s*light;/.test(popupCssNoComments)
      && !popupCss.includes('prefers-color-scheme'),
      '14C: 弹窗固定使用浅色外观，同时保留减弱动态效果与高对比度适配');
  // 紧凑桌面面板使用 14px 正文，通过浏览器文字缩放保留可读性。
  assertPass(/html\s*\{[^}]*?-webkit-text-size-adjust:\s*100%/.test(popupCssNoComments)
      && /body\s*\{[^}]*?font-size:\s*13px;[^}]*?line-height:\s*1\.45/.test(popupCssNoComments),
    '14D: 默认排版为 13px/1.45 的紧凑桌面层级，并允许浏览器文字缩放');
  assertPass(popupSource.includes('function announceState(message)')
      && popupSource.includes('if (!message || message === lastAnnouncedState) return;')
      && !popupSource.includes("statusDiv.textContent = '';"),
    '14E: 状态宣告按语义变化去重，用户操作反馈不会在 3 秒后自动消失');
  assertPass(popupSource.includes('document.documentElement.lang = I18n.getLang().replace')
      && popupSource.includes('function renderDiagnoseResult(lines)')
      && !popupSource.includes("diagnoseResult.innerHTML = lines.join('<br>')"),
    '14F: popup 语言随界面语言更新，诊断结果以安全、可导航的文本节点呈现');
  assertPass(popupSource.includes("diagnoseActiveBoundary")
      && popupSource.includes("diagnoseOffscreenPresent")
      && popupSource.includes("diagnosePageTimerRetryNone")
      && popupSource.includes("diagnosePageTimerPwmRetry")
      && popupSource.includes("code: 'SAFETY-PWM-RETRYING'")
      && popupSource.includes('isPwmPageTimerRetryActive(s.pageTimerError, pwmRetryAt)')
      && popupSource.includes('pwmAlarm?.scheduledTime')
      && popupSource.includes("diagnoseHeartbeatStale"),
    '14G: 诊断区分独立 page-timer retry 与任意当前相位的 live ac-pwm 重试，并保留 L2 真状态读取');
  const popupPwmPhaseScriptAt14G = popupHtml.indexOf('<script src="pwm-phase.js"></script>');
  const popupMainScriptAt14G = popupHtml.indexOf('<script src="popup.js?v=0.8.2"></script>');
  const popupDiagnoseStart14G = popupSource.indexOf("btnDiagnose.addEventListener('click'");
  const popupDiagnoseEnd14G = popupSource.indexOf(
    "btnCopyDiag?.addEventListener('click'",
    popupDiagnoseStart14G
  );
  const popupDiagnoseSource14G = popupSource.slice(
    popupDiagnoseStart14G,
    popupDiagnoseEnd14G
  );
  assertPass(popupPwmPhaseScriptAt14G > 0
      && popupMainScriptAt14G > popupPwmPhaseScriptAt14G
      && popupSource.includes('classifySmartOnClock(')
      && popupSource.includes("code: 'SCHED-SMART-ON-CLOCK-SKIPPED'")
      && popupSource.includes("code: 'SCHED-SMART-ON-CLOCK-REPAIRED'")
      && popupSource.includes("code: 'SCHED-PHASE-STATUS-DESYNC'")
      && popupSource.includes('const diagnosticEvidence = readDiagnosticEvidence(ensured);')
      && popupSource.includes('const diagnosticBefore = diagnosticEvidence.before;')
      && popupSource.includes('const diagnosticAfter = diagnosticEvidence.after;')
      && !popupDiagnoseSource14G.includes('chrome.storage.local.set('),
    '14G-0: Popup 继续报告智能时钟语义错误，但只消费后台 before/after，不在诊断中直接改 storage');
  const pwmRetryHelperStart14G = popupSource.indexOf(
    'function isPwmPageTimerRetryActive('
  );
  const pwmRetryHelperEnd14G = popupSource.indexOf(
    '\n\nif (IS_STATIC_PREVIEW)',
    pwmRetryHelperStart14G
  );
  const pwmRetryHelperSource14G = pwmRetryHelperStart14G >= 0
      && pwmRetryHelperEnd14G > pwmRetryHelperStart14G
    ? popupSource.slice(pwmRetryHelperStart14G, pwmRetryHelperEnd14G)
    : '';
  const isPwmPageTimerRetryActive14G = pwmRetryHelperSource14G
    ? new Function(`${pwmRetryHelperSource14G}; return isPwmPageTimerRetryActive;`)()
    : null;
  const isDiagnosticPageTimerRequired14G = pwmRetryHelperSource14G.includes(
    'function isDiagnosticPageTimerRequired('
  )
    ? new Function(`${pwmRetryHelperSource14G}; return isDiagnosticPageTimerRequired;`)()
    : null;
  const pwmRetryNow14G = 1_700_000_000_000;
  assertPass(typeof isPwmPageTimerRetryActive14G === 'function'
      && isPwmPageTimerRetryActive14G('写入失败；1 分钟后重试', pwmRetryNow14G + 57_000, pwmRetryNow14G)
      && !isPwmPageTimerRetryActive14G('', pwmRetryNow14G + 57_000, pwmRetryNow14G)
      && !isPwmPageTimerRetryActive14G('旧错误', pwmRetryNow14G - 1, pwmRetryNow14G)
      && !isPwmPageTimerRetryActive14G('旧错误', pwmRetryNow14G + 5 * 60_000, pwmRetryNow14G),
    '14G-1: 一分钟 PWM retry 不依赖 pwmState，且无错误、已过期或普通远期闹钟不误报');
  assertPass(typeof isDiagnosticPageTimerRequired14G === 'function'
      && !isDiagnosticPageTimerRequired14G({
        enabled: true,
        pwmState: 'off'
      }, false, false)
      && isDiagnosticPageTimerRequired14G({
        enabled: true,
        pwmState: 'on'
      }, true, false)
      && isDiagnosticPageTimerRequired14G({
        enabled: true,
        pwmState: 'off'
      }, null, false),
    '14G-1A: 权威 AC=OFF 否决陈旧 ON 相位的缺 timer 报警；状态未知才回退 PWM 相位');
  assertPass(backgroundSource.includes('_pwmStepRunning: isCurrentPwmStepRunning()')
      && backgroundSource.includes('pwmStepRunning: isCurrentPwmStepRunning()')
      && popupSource.includes('const pwmStepInFlight =')
      && popupSource.includes("code: 'SCHED-PWM-IN-FLIGHT'")
      && popupSource.includes('if (pwmStepInFlight && !memLive)')
      && /if \(s\.clockMode === false && s\.enabled[\s\S]{0,160}!pwmStepInFlight[\s\S]{0,80}!effectiveNextTriggerAt/.test(popupSource)
      && countOccurrences(popupSource, "t('diagnosePwmInFlight')") === 1,
    '14G-1B: ac-pwm 已触发且步骤仍在执行时，只标记一次处理中，不误报触发时间／闹钟缺失或三方失步');
  assertPass(popupSource.includes("diagnoseSmartWeatherAlarm")
      && popupSource.includes("diagnoseSmartWeatherAlarmMissing")
      && popupSource.includes("diagnoseSmartWeatherFresh")
      && popupSource.includes("diagnoseSmartWeatherStale")
      && popupSource.includes("diagnoseSmartWeatherNoCache")
      && popupSource.includes("const smartWeatherAlarm = alarms.find(a => a.name === 'ac-smart-weather')")
      && !popupSource.includes("ensured?.alarms?.smartWeather"),
    '14G-2: 诊断面板从同一份新鲜 alarm 快照检查智能天气闹钟与缓存新鲜度');
  assertPass(!popupSource.includes('const fmt2 =')
      && popupSource.includes("const fmt = (t) => t ? new Date(t).toLocaleTimeString() : '∅';")
      && /diagnoseTriMatch', fmt\(/.test(popupSource)
      && /diagnoseTriMismatch', fmt\(/.test(popupSource),
    '14H: 诊断 fmt 提升到顶层一次,不再重现 fmt2 typo 致 SW success 分支 ReferenceError (“fmt is not defined” v0.6.7 实测浮現)');
  assertPass(popupSource.includes("sw.offscreenAlive === true")
      && popupSource.includes("sw.offscreenAlive === false")
      && popupSource.includes('diagnoseOffscreenUnknown')
      && popupSource.includes('diagnoseVersion'),
    '14I: offscreen 诊断行三态兼容(旧 SW undefined 不误红)+ 诊断面板末行显示扩展版本+build');
  assertPass(/const APP_VERSION = '\d+\.\d+\.\d+';/.test(popupSource)
      && distPopupSource.includes(`const APP_VERSION = '${manifest.version}'`),
    `14J: popup 源码保留合法兜底版本，dist 由构建注入 manifest version (${manifest.version})`);

  // 14K: dist/popup.html 两处 ?v= 由 build.sh 注入 manifest.version。
  const popupHtmlV = [...distPopupHtml.matchAll(/\?v=([\d.]+)/g)].map(m => m[1]);
  assertPass(popupHtmlV.length >= 2 && popupHtmlV.every(v => v === manifest.version),
    `14K: dist/popup.html ?v= 缓存参数 (${popupHtmlV.join(', ') || 'none'}) 全部等于 manifest.json version (${manifest.version})`);

  // 14L: 商店/CHROMEWEBSTORE.md 所有版本字符串与 manifest.version 同步(发布资产一致性守门)
  //  使用 \d+\.\d+\.\d+ 而非 \b0\.\d+\.\d+\b，避免匹配 ac-ust-vX.Y.Z 时 vX 之间无词边界被 \b 截掉
  const chwsVers = [...webStoreMetadata.matchAll(/\d+\.\d+\.\d+/g)].map(m => m[0]);
  assertPass(chwsVers.length >= 2 && chwsVers.every(v => v === manifest.version),
    `14L: CHROMEWEBSTORE.md 所有版本字段与 ZIP 文件名 (${chwsVers.join(', ') || 'none'}) 全部等于 manifest.json version (${manifest.version}) — 产线文档不会拖后腿`);

  // 14M: 诊断末行优先读 chrome.runtime.getManifest().version 而非 APP_VERSION 硬编码 — 彻底消除硬编码版本号在诊断上的暴露面
  assertPass(!popupSource.includes("t('diagnoseVersion', APP_VERSION,")
      && popupSource.includes("t('diagnoseVersion',")
      && /chrome\.runtime\.getManifest\(\)\.version/.test(popupSource),
    `14M: 诊断末行 diagnoseVersion 不再直接传 APP_VERSION 硬编码,改为优先读 chrome.runtime.getManifest().version (治本 — 即便作者漏同步源码 APP_VERSION,诊断仍显示真实 manifest 版本)`);

  const diagnoseHandlerSource = popupSource.slice(
    popupSource.indexOf("btnDiagnose.addEventListener('click', async () => {")
  );
  assertPass(popupSource.includes('const DIAGNOSTIC_MESSAGE_TIMEOUT_MS = 10000;')
      && popupSource.includes('async function sendDiagnosticRuntimeMessage(message)')
      && countOccurrences(diagnoseHandlerSource, 'sendDiagnosticRuntimeMessage(') >= 4
      && /finally\s*\{[\s\S]*btnDiagnose\.disabled = false;/.test(diagnoseHandlerSource),
    '14N: 诊断后台往返有 10 秒边界，所有退出路径都恢复按钮并结束“诊断中”状态');

  const diagnosticAlignmentStart = popupSource.indexOf('const DIAGNOSTIC_TRIGGER_TOLERANCE_MS = 1500;');
  const diagnosticAlignmentEnd = popupSource.indexOf('\nasync function sendDiagnosticRuntimeMessage', diagnosticAlignmentStart);
  const areDiagnosticTriggersAligned = new Function(`
    ${popupSource.slice(diagnosticAlignmentStart, diagnosticAlignmentEnd)}
    return areDiagnosticTriggersAligned;
  `)();
  assertPass(areDiagnosticTriggersAligned(10000, 10001.5, 9999)
      && areDiagnosticTriggersAligned(10000, 11500)
      && !areDiagnosticTriggersAligned(10000, 11501)
      && !areDiagnosticTriggersAligned(10000, 0)
      && countOccurrences(diagnoseHandlerSource, 'areDiagnosticTriggersAligned(') >= 2
      && !diagnoseHandlerSource.includes('memNext === memLive'),
    '14O: 两方与三方触发时间共用 1500ms 容差，浏览器毫秒小数不再误报时钟失步');

  const timestampAgeStart = popupSource.indexOf('function getTimestampAgeMs(');
  const timestampAgeEnd = popupSource.indexOf('\nfunction areDiagnosticTriggersAligned', timestampAgeStart);
  const timestampAgeSource = timestampAgeStart >= 0 && timestampAgeEnd > timestampAgeStart
    ? popupSource.slice(timestampAgeStart, timestampAgeEnd)
    : '';
  const getTimestampAgeMs = timestampAgeSource
    ? new Function(`${timestampAgeSource}; return getTimestampAgeMs;`)()
    : null;
  assertPass(typeof getTimestampAgeMs === 'function',
    '14P: 诊断新鲜度使用共享原始毫秒年龄 helper');
  if (typeof getTimestampAgeMs === 'function') {
    const ageNow = 10_000_000;
    const weatherAge = getTimestampAgeMs(ageNow - 60 * 60_000 - 1, ageNow);
    const heartbeatAge = getTimestampAgeMs(ageNow - 59_500, ageNow);
    assertPass(weatherAge === 60 * 60_000 + 1
        && Math.round(weatherAge / 60000) === 60
        && weatherAge > 60 * 60_000
        && heartbeatAge === 59_500
        && Math.round(heartbeatAge / 1000) === 60
        && heartbeatAge < 60_000
        && getTimestampAgeMs(ageNow + 1, ageNow) === null,
      '14P-1: 阈值比较保留原始毫秒；四舍五入只用于天气/heartbeat 文案');
    assertPass(popupSource.includes('ageMs <= 60 * 60000')
        && popupSource.includes('hbAgeMs < 60 * 1000'),
      '14P-2: 天气与 heartbeat 判定比较原始毫秒，不比较已取整显示值');
  }

  const popupPageStateStart = popupSource.indexOf('function evaluatePopupPageState(');
  const popupPageStateEnd = popupSource.indexOf('\nfunction readPopupPageSnapshot', popupPageStateStart);
  const popupPageStateSource = popupPageStateStart >= 0 && popupPageStateEnd > popupPageStateStart
    ? popupSource.slice(popupPageStateStart, popupPageStateEnd)
    : '';
  const evaluatePopupPageState = popupPageStateSource
    ? new Function(`${popupPageStateSource}; return evaluatePopupPageState;`)()
    : null;
  assertPass(typeof evaluatePopupPageState === 'function',
    '14Q-P0: popup 页面诊断使用纯判定 helper，可独立验证加载、布局与控件同步');
  if (typeof evaluatePopupPageState === 'function') {
    const healthyPopupSnapshot = {
      readyState: 'complete',
      visibilityState: 'visible',
      viewportWidth: 250,
      viewportHeight: 600,
      contentWidth: 250,
      contentHeight: 720,
      updatePending: false,
      controls: {
        automationChecked: true,
        timerPressed: true,
        smartPressed: false,
        activeHoursChecked: true,
        activeHoursStart: '08:00',
        activeHoursEnd: '23:00',
        activeHoursBodyHidden: false,
        activeHoursStartDisabled: false,
        activeHoursEndDisabled: false,
        timerBodyHidden: false,
        smartBodyHidden: true
      }
    };
    const healthyPopupSchedule = {
      enabled: true,
      activeHours: { enabled: true, start: '08:00', end: '23:00' },
      smartMode: { enabled: false }
    };
    const healthyPopupState = evaluatePopupPageState(healthyPopupSnapshot, healthyPopupSchedule);
    assertPass(healthyPopupState.documentReady
        && healthyPopupState.documentVisible
        && healthyPopupState.dimensionsValid
        && !healthyPopupState.horizontalOverflow
        && healthyPopupState.controlSync === true,
      '14Q-P1: Popup 就绪、可见、尺寸有效、仅纵向滚动且控件匹配时全部通过');

    const disabledTimerPopupState = evaluatePopupPageState({
      ...healthyPopupSnapshot,
      controls: { ...healthyPopupSnapshot.controls, automationChecked: false }
    }, {
      ...healthyPopupSchedule,
      enabled: false
    });
    const dormantSmartPopupState = evaluatePopupPageState({
      ...healthyPopupSnapshot,
      controls: {
        ...healthyPopupSnapshot.controls,
        automationChecked: false,
        timerPressed: false,
        smartPressed: true,
        timerBodyHidden: true,
        smartBodyHidden: false
      }
    }, {
      ...healthyPopupSchedule,
      enabled: false,
      smartMode: { enabled: true }
    });
    assertPass(disabledTimerPopupState.controlSync === true
        && disabledTimerPopupState.expected.automation === false
        && disabledTimerPopupState.expected.timer === true
        && dormantSmartPopupState.controlSync === true
        && dormantSmartPopupState.expected.automation === false
        && dormantSmartPopupState.expected.smart === true,
      '14Q-P1a: 总开关关闭时仍以持久模式选择校验 Popup，不把“已选择”误判为“已运行”');

    const overflowPopupState = evaluatePopupPageState({
      ...healthyPopupSnapshot,
      contentWidth: 252
    }, healthyPopupSchedule);
    const desyncedPopupState = evaluatePopupPageState({
      ...healthyPopupSnapshot,
      controls: { ...healthyPopupSnapshot.controls, timerPressed: false }
    }, healthyPopupSchedule);
    const pendingPopupState = evaluatePopupPageState({
      ...healthyPopupSnapshot,
      updatePending: true,
      controls: { ...healthyPopupSnapshot.controls, timerPressed: false }
    }, healthyPopupSchedule);
    assertPass(overflowPopupState.horizontalOverflow
        && desyncedPopupState.controlSync === false
        && desyncedPopupState.controlMismatches.includes('timerPressed(expected=true, actual=false)')
        && pendingPopupState.controlSync === null,
      '14Q-P2: 横向溢出与控件失步分别定位到 expected/actual 字段；设置提交中跳过同步判定，避免瞬态误报');
  }

  const diagnosticReportStart = popupSource.indexOf('const DIAGNOSTIC_LEVEL_SYMBOLS =');
  const diagnosticReportEnd = popupSource.indexOf('\nfunction projectPersistentSchedule', diagnosticReportStart);
  const diagnosticReportSource = diagnosticReportStart >= 0 && diagnosticReportEnd > diagnosticReportStart
    ? popupSource.slice(diagnosticReportStart, diagnosticReportEnd)
    : '';
  const createDiagnosticReport = diagnosticReportSource
    ? new Function(`${diagnosticReportSource}; return createDiagnosticReport;`)()
    : null;
  assertPass(typeof createDiagnosticReport === 'function',
    '14Q-0: popup 提供纯 finding reporter，统一严重度、稳定代码、摘要与完成状态');
  if (typeof createDiagnosticReport === 'function') {
    const translateDiagnostic14Q = (key, ...subs) => ({
      diagnoseSummary: `SUMMARY ${subs.join('/')}`,
      diagnoseSummaryHealthy: 'HEALTHY',
      diagnosePrimaryIssue: `PRIMARY ${subs.join('|')}`,
      diagnosePrimaryRepair: `REPAIR ${subs.join('|')}`,
      diagnoseNextStep: `NEXT ${subs[0]}`,
      diagnoseDetails: 'DETAILS'
    })[key] || key;
    const report14Q = createDiagnosticReport(translateDiagnostic14Q);
    report14Q.add(true, 'automatic control inactive', {
      level: 'info', code: 'CFG-AUTOMATION-OFF', domain: 'config'
    });
    report14Q.add(false, 'ac-pwm missing', {
      level: 'error', code: 'SCHED-PWM-MISSING', domain: 'scheduler',
      action: 'reload extension', priority: 10
    });
    report14Q.add(false, 'weather stale', {
      level: 'warning', code: 'WEATHER-CACHE-STALE', domain: 'weather',
      action: 'wait for prefetch', priority: 30
    });
    report14Q.add(true, 'badge rebuilt', {
      level: 'repaired', code: 'SCHED-BADGE-REPAIRED', domain: 'scheduler', priority: 20
    });
    report14Q.add(false, 'ac-pwm still missing', {
      level: 'error', code: 'SCHED-PWM-MISSING', domain: 'scheduler',
      action: 'reload extension', priority: 10
    });
    report14Q.add(true, 'scheduler healthy', {
      code: 'SCHED-HEALTH-CHECK-FAILED', domain: 'scheduler'
    });
    const summary14Q = report14Q.getSummaryLines();
    assertPass(report14Q.detailLines[0].startsWith('ℹ️ [CFG-AUTOMATION-OFF]')
        && report14Q.detailLines[1].startsWith('❌ [SCHED-PWM-MISSING]')
        && report14Q.detailLines[2].startsWith('⚠️ [WEATHER-CACHE-STALE]')
        && report14Q.detailLines[3].startsWith('🛠️ [SCHED-BADGE-REPAIRED]')
        && report14Q.detailLines[5] === '✅ scheduler healthy'
        && summary14Q[0] === 'SUMMARY 1/1/1'
        && summary14Q[1].includes('SCHED-PWM-MISSING')
        && summary14Q[2] === 'NEXT reload extension'
        && report14Q.findings.filter(item => item.code === 'SCHED-PWM-MISSING').length === 1
        && report14Q.getCompletionLevel() === 'error',
      '14Q-1: 当前 error/warning/repaired 分开计数，同码症状不重复计数，首要根因按优先级显示证据与唯一下一步');

    const healthyReport14Q = createDiagnosticReport(translateDiagnostic14Q);
    healthyReport14Q.add(true, 'automatic control inactive', {
      level: 'info', code: 'CFG-AUTOMATION-OFF', domain: 'config'
    });
    assertPass(healthyReport14Q.getSummaryLines().includes('HEALTHY')
        && healthyReport14Q.getCompletionLevel() === 'success'
        && healthyReport14Q.findings.length === 0,
      '14Q-2: 预期停用只显示 info，不制造当前问题或修复建议');

    const repairedReport14Q = createDiagnosticReport(translateDiagnostic14Q);
    repairedReport14Q.add(true, 'watchdog rebuilt', {
      level: 'repaired', code: 'SCHED-WATCHDOG-REPAIRED', domain: 'scheduler', priority: 10
    });
    assertPass(repairedReport14Q.getSummaryLines().some(line => line.includes('SCHED-WATCHDOG-REPAIRED'))
        && repairedReport14Q.getCompletionLevel() === 'success',
      '14Q-2b: 仅有自动修复时摘要显示修复项，但当前完成状态仍为健康');
  }

  const diagnosticFindingLocaleKeys = [
    'diagnoseSummary',
    'diagnoseSummaryHealthy',
    'diagnosePrimaryIssue',
    'diagnosePrimaryRepair',
    'diagnoseNextStep',
    'diagnoseDetails',
    'diagnoseCompleteIssues',
    'diagnoseCompleteWarnings',
    'diagnoseDomainGeneral',
    'diagnoseDomainConfig',
    'diagnoseDomainScheduler',
    'diagnoseDomainBackground',
    'diagnoseDomainWeather',
    'diagnoseDomainPage',
    'diagnoseDomainPopup',
    'diagnoseDomainSafety',
    'diagnoseActionCopyReport',
    'diagnoseActionReloadExtension',
    'diagnoseActionOpenACPage',
    'diagnoseActionReloadACPage',
    'diagnoseActionCheckTimer',
    'diagnoseActionRecheckRecovery',
    'diagnoseActionWaitWeather',
    'diagnoseActionReopenPopup',
    'diagnosePopupDocumentReady',
    'diagnosePopupDocumentState',
    'diagnosePopupLayoutOK',
    'diagnosePopupLayoutOverflow',
    'diagnosePopupLayoutUnmeasurable',
    'diagnosePopupControlsSync',
    'diagnosePopupControlsPending',
    'diagnosePopupControlsDesync',
    'diagnosePopupKeepaliveOK',
    'diagnosePopupKeepaliveDisconnected',
    'diagnosePopupRuntimeErrors',
    'diagnosePopupRuntimeErrorsEmpty',
    'diagnoseEnsureFailed',
    'diagnoseScheduleReadFailed',
    'diagnoseStorageReadFailed',
    'diagnoseScheduleMissing',
    'diagnoseRuntimeAlarmsInactive',
    'diagnoseAlarmRebuilt',
    'diagnoseAlarmScheduled',
    'diagnoseSmartWeatherSlotMismatch',
    'diagnoseTabDiscarded',
    'diagnoseSmartModeDormant',
    'diagnoseSmartCurrentCycleRecoveryStarted',
    'diagnosePwmMissing',
    'diagnosePwmDesync',
    'diagnoseAlarmMissing',
    'diagnoseAlarmExpired',
    'diagnoseSWInitPending',
    'diagnosePageTimerPwmRetry',
    'diagnosePageTimerRetryAlarmMissing',
    'diagnosePageTimerMissing',
    'diagnoseRuntimeAlarmsCleared',
    'diagnoseRuntimeAlarmsLeaked'
  ];
  assertPass(diagnosticFindingLocaleKeys.every(key => zhCN[key]?.message && en[key]?.message)
      && diagnoseHandlerSource.includes("code: 'CFG-AUTOMATION-OFF'")
      && diagnoseHandlerSource.includes("code: 'SCHED-PWM-MISSING'")
      && diagnoseHandlerSource.includes("code: 'PAGE-HOME-MISSING'")
      && diagnoseHandlerSource.includes("code: 'SW-STATUS-FAILED'")
      && diagnoseHandlerSource.includes("'SAFETY-TIMER-FAILED'")
      && diagnoseHandlerSource.includes("code: 'SAFETY-TIMER-MISSING'")
      && diagnoseHandlerSource.includes("code: 'SMART-CURRENT-CYCLE-RECOVERY-STARTED'")
      && diagnoseHandlerSource.includes("repairedItems.has('smart-current-cycle-started')")
      && diagnoseHandlerSource.includes("action: t('diagnoseActionRecheckRecovery')")
      && diagnoseHandlerSource.includes("code: 'SCHED-RUNTIME-ALARMS-LEAKED'")
      && diagnoseHandlerSource.includes("code: 'POPUP-CONTROLS-DESYNC'")
      && diagnoseHandlerSource.includes("code: 'POPUP-HORIZONTAL-OVERFLOW'")
      && diagnoseHandlerSource.includes("code: 'POPUP-KEEPALIVE-DISCONNECTED'")
      && diagnoseHandlerSource.includes('readPopupPageSnapshot()')
      && diagnoseHandlerSource.includes('ACPopupDiagnosticFallback?.getCapturedErrors?.()')
      && popupSource.includes('globalThis.__AC_POPUP_DIAGNOSTICS_READY__ = true;')
      && diagnoseHandlerSource.includes('isDiagnosticPageTimerRequired(')
      && diagnoseHandlerSource.includes("code: 'WEATHER-SLOT-MISMATCH'")
      && diagnoseHandlerSource.includes('ensured?.success === false && ensured.error')
      && diagnoseHandlerSource.includes('if (!bgProbeFailed)')
      && diagnoseHandlerSource.includes('if (!automationEnabled)')
      && diagnoseHandlerSource.includes('if (!automationEnabled && smartOnDiag)')
      && diagnoseHandlerSource.includes('if (automationEnabled)')
      && diagnoseHandlerSource.includes('if (!automationEnabled || automationPausedByActiveHours)')
      && diagnoseHandlerSource.includes("level: automationEnabled ? 'warning' : 'info'")
      && diagnoseHandlerSource.includes('report.getSummaryLines()'),
    '14Q-3: 关键故障域使用稳定 code/action，停用态跳过运行闹钟并由双语摘要定位首要问题');

  // ===== 用例 15: 持久化脱敏诊断日志 =====
  beginSuite('用例 15：脱敏诊断日志', '\n\n=== 用例 15: 持久化脱敏诊断日志 ===\n');

  const diagnosticLogStart = backgroundSource.indexOf("const DIAGNOSTIC_LOG_KEY = 'ac_diagnostic_log';");
  const diagnosticLogEnd = backgroundSource.indexOf('\n// 跨设备同步：', diagnosticLogStart);
  const diagnosticLogBody = diagnosticLogStart >= 0 && diagnosticLogEnd > diagnosticLogStart
    ? backgroundSource.slice(diagnosticLogStart, diagnosticLogEnd)
    : '';
  const createDiagnosticLogHarness = new Function('chrome', 'self', `
    ${diagnosticLogBody}
    return {
      appendDiagnosticLog,
      normalizeDiagnosticMessage,
      flush: () => diagnosticLogWriteChain
    };
  `);

  function createDiagnosticStorage(options = {}) {
    let storedEntries = [];
    let setCount = 0;
    const listeners = {};
    return {
      chrome: {
        storage: {
          local: {
            async get(key) {
              return key === 'ac_diagnostic_log'
                ? { ac_diagnostic_log: storedEntries.map(entry => ({ ...entry })) }
                : {};
            },
            async set(value) {
              setCount += 1;
              if (options.failSet) throw new Error('diagnostic storage unavailable');
              storedEntries = value.ac_diagnostic_log.map(entry => ({ ...entry }));
            }
          }
        }
      },
      self: {
        addEventListener(type, listener) { listeners[type] = listener; }
      },
      listeners,
      getEntries: () => storedEntries.map(entry => ({ ...entry })),
      getSetCount: () => setCount
    };
  }

  const diagnosticMock = createDiagnosticStorage();
  const diagnosticHarness = createDiagnosticLogHarness(diagnosticMock.chrome, diagnosticMock.self);
  await Promise.all(Array.from({ length: 60 }, (_, index) =>
    diagnosticHarness.appendDiagnosticLog('error', `source-${index}`, `failure-${index}`)
  ));
  await diagnosticHarness.flush();
  const diagnosticEntries = diagnosticMock.getEntries();
  assertPass(diagnosticEntries.length === 50
      && diagnosticEntries[0].source === 'source-10'
      && diagnosticEntries[49].source === 'source-59'
      && diagnosticMock.getSetCount() === 60,
    '15A: 并发追加经串行写链不丢失，并将环形日志裁剪为最新 50 条');

  const privateMessage = `request https://w5.ab.ust.hk/njggt/app/home?token=secret from user@example.com ${'x'.repeat(400)}`;
  await diagnosticHarness.appendDiagnosticLog('warn', 'privacy-check', privateMessage);
  const privateEntry = diagnosticMock.getEntries().at(-1);
  assertPass(privateEntry.level === 'warn'
      && privateEntry.message.length <= 300
      && privateEntry.message.includes('[url]')
      && privateEntry.message.includes('[email]')
      && !privateEntry.message.includes('token=secret')
      && !privateEntry.message.includes('user@example.com')
      && Object.keys(privateEntry).sort().join(',') === 'level,message,source,timestamp',
    '15B: 日志仅保留白名单字段，URL/邮箱被脱敏且消息限制为 300 字符');

  const failingDiagnosticMock = createDiagnosticStorage({ failSet: true });
  const failingDiagnosticHarness = createDiagnosticLogHarness(failingDiagnosticMock.chrome, failingDiagnosticMock.self);
  await failingDiagnosticHarness.appendDiagnosticLog('error', 'storage-failure', new Error('write failed'));
  await failingDiagnosticHarness.flush();
  assertPass(failingDiagnosticMock.getSetCount() === 1 && failingDiagnosticMock.getEntries().length === 0,
    '15C: 日志 storage 写入失败被内部吞掉，不递归记录或制造未处理 rejection');

  const listenerDiagnosticMock = createDiagnosticStorage();
  const listenerDiagnosticHarness = createDiagnosticLogHarness(listenerDiagnosticMock.chrome, listenerDiagnosticMock.self);
  listenerDiagnosticMock.listeners.error({ message: 'global worker error' });
  listenerDiagnosticMock.listeners.unhandledrejection({ reason: new Error('global rejected promise') });
  await listenerDiagnosticHarness.flush();
  const listenerEntries = listenerDiagnosticMock.getEntries();
  assertPass(listenerEntries.length === 2
      && listenerEntries[0].source === 'service-worker-error'
      && listenerEntries[1].source === 'service-worker-unhandledrejection',
    '15D: Service Worker error 与 unhandledrejection 会写入持久诊断日志');

  assertPass(!diagnosticLogBody.includes('chrome.storage.sync')
      && backgroundSource.includes("appendDiagnosticLog('error', 'init', e)")
      && backgroundSource.includes("appendDiagnosticLog('error', source, error)")
      && backgroundSource.includes("source: 'alarm-ac-pwm'")
      && backgroundSource.includes("appendDiagnosticLog('error', `message-${msg?.type || 'unknown'}`, e)")
      && backgroundSource.includes("appendDiagnosticLog('error', 'toggle-refresh-recovery'"),
    '15E: 日志只进 local，并覆盖 init、PWM、消息汇聚与刷新恢复关键错误链');

  const recentLogStart = popupSource.indexOf('function selectRecentDiagnosticEntries(');
  const recentLogEnd = popupSource.indexOf('\nbtnDiagnose.addEventListener', recentLogStart);
  const recentLogBody = recentLogStart >= 0 && recentLogEnd > recentLogStart
    ? popupSource.slice(recentLogStart, recentLogEnd)
    : '';
  const createRecentLogHarness = recentLogBody ? new Function('t', 'BUILD_TIME_EPOCH_MS', `
    ${recentLogBody}
    return { selectRecentDiagnosticEntries, appendRecentDiagnosticLogLines };
  `) : null;
  assertPass(typeof createRecentLogHarness === 'function',
    '15F-0: popup 提供当前构建诊断记录的纯选择器');
  const recentLogHarness = createRecentLogHarness?.((key, ...subs) => {
    if (key === 'diagnoseRecentErrorsEmpty') return 'NO RECENT ERRORS';
    if (key === 'diagnoseRecentErrors') return `RECENT ERRORS ${subs[0]}/${subs[1]}`;
    return key;
  }, 10_000);
  if (recentLogHarness) {
    const now15F = 20_000;
    const input15F = [
      null,
      { timestamp: 9_999, level: 'error', source: 'before-build', message: 'old' },
      { timestamp: 10_000, level: 'error', source: 'build-boundary', message: 'equal' },
      { timestamp: '15000', level: 'error', source: 'string-time', message: 'invalid' },
      { timestamp: Number.NaN, level: 'error', source: 'nan-time', message: 'invalid' },
      { timestamp: Number.MAX_SAFE_INTEGER + 1, level: 'error', source: 'unsafe-time', message: 'invalid' },
      { timestamp: 20_001, level: 'error', source: 'future', message: 'invalid' },
      { timestamp: 15_000, level: 'warn', source: 'source-15', message: '15' },
      { timestamp: 18_000, level: 'error', source: 'source-18', message: '18' },
      { timestamp: 20_000, level: 'error', source: 'equal-old', message: 'old tie' },
      { timestamp: 17_000, level: 'error', source: 'source-17', message: '17' },
      { timestamp: 19_000, level: 'warn', source: 'source-19', message: '19' },
      { timestamp: 16_000, level: 'error', source: 'source-16', message: '16' },
      { timestamp: 20_000, level: 'warn', source: 'equal-new', message: 'new tie' }
    ];
    const selection15F = recentLogHarness.selectRecentDiagnosticEntries(input15F, now15F);
    const recentLines = [];
    recentLogHarness.appendRecentDiagnosticLogLines(recentLines, input15F, now15F);
    const emptyRecentLines = [];
    recentLogHarness.appendRecentDiagnosticLogLines(emptyRecentLines, [
      { timestamp: 9_999, source: 'before-build' },
      { timestamp: 20_001, source: 'future' },
      { timestamp: '15000', source: 'string-time' }
    ], now15F);
    assertPass(selection15F.total === 8
        && selection15F.entries.length === 5
        && selection15F.entries.map(entry => entry.source).join(',')
          === 'equal-new,equal-old,source-19,source-18,source-17',
      '15F-1: 当前构建边界含等号、拒绝未来/非法时间戳，并按时间与后写顺序取最新五条');
    assertPass(recentLines.length === 6
        && recentLines[0] === 'RECENT ERRORS 8/5'
        && recentLines[1].includes('equal-new')
        && recentLines[1].includes('[HISTORY WARN/equal-new]')
        && recentLines[2].includes('equal-old')
        && recentLines[5].includes('source-17')
        && emptyRecentLines[0] === '✅ NO RECENT ERRORS'
        && popupSource.includes("chrome.storage.local.get('ac_diagnostic_log')"),
      '15F-2: popup 仅渲染当前构建最新五条（新→旧），无合格记录显示空状态');
  }

  const diagnosticLocaleKeys = [
    'diagnoseRecentErrors',
    'diagnoseRecentErrorsEmpty',
    'diagnoseRecentErrorsReadFailed'
  ];
  assertPass(diagnosticLocaleKeys.every(key => zhCN[key]?.message && en[key]?.message),
    '15G: 持久诊断日志的摘要、空状态与读取失败文案均有中英文');

  // 15H: 诊断日志按扩展版本自动重置——版本变化清空旧日志，同版本保留。
  const reconcileStart = backgroundSource.indexOf("const DIAGNOSTIC_LOG_VERSION_KEY = 'ac_diagnostic_log_version';");
  const reconcileEnd = backgroundSource.indexOf('\n// ----- 启动时加载设置并创建闹钟', reconcileStart);
  const reconcileBody = reconcileStart >= 0 && reconcileEnd > reconcileStart
    ? backgroundSource.slice(reconcileStart, reconcileEnd)
    : '';
  const loadReconcile = new Function('chrome', 'DIAGNOSTIC_LOG_KEY', `
    ${reconcileBody}
    return { reconcileDiagnosticLogVersion };
  `);
  function createReconcileStorage(initialLog, storedVersion) {
    const state = {};
    if (storedVersion !== undefined) state.ac_diagnostic_log_version = storedVersion;
    if (initialLog !== undefined) state.ac_diagnostic_log = initialLog;
    const calls = [];
    return {
      chrome: {
        runtime: { getManifest: () => ({ version: manifest.version }) },
        storage: {
          local: {
            async get(key) { return { [key]: state[key] }; },
            async set(obj) { calls.push(['set', obj]); Object.assign(state, obj); },
            async remove(key) { calls.push(['remove', key]); delete state[key]; }
          }
        }
      },
      state,
      calls
    };
  }
  const staleReconcileStorage = createReconcileStorage(
    [{ timestamp: 1, level: 'error', source: 'old', message: 'legacy' }],
    '0.7.9'
  );
  const staleReconcile = loadReconcile(staleReconcileStorage.chrome, 'ac_diagnostic_log');
  await staleReconcile.reconcileDiagnosticLogVersion();
  assertPass(staleReconcileStorage.state.ac_diagnostic_log === undefined
      && staleReconcileStorage.state.ac_diagnostic_log_version === manifest.version
      && staleReconcileStorage.calls.some(c => c[0] === 'remove' && c[1] === 'ac_diagnostic_log'),
    '15H-1: 版本变化时自动清空遗留诊断日志并记录新版本');

  const sameReconcileStorage = createReconcileStorage(
    [{ timestamp: 1, level: 'error', source: 'current', message: 'keep' }],
    manifest.version
  );
  const sameReconcile = loadReconcile(sameReconcileStorage.chrome, 'ac_diagnostic_log');
  await sameReconcile.reconcileDiagnosticLogVersion();
  assertPass(sameReconcileStorage.state.ac_diagnostic_log?.length === 1
      && sameReconcileStorage.state.ac_diagnostic_log[0].source === 'current'
      && !sameReconcileStorage.calls.some(c => c[0] === 'remove'),
    '15H-2: 同版本保留现有诊断日志，不重复清理');

  assertPass(backgroundSource.includes('async function reconcileDiagnosticLogVersion()')
      && backgroundSource.includes('await reconcileDiagnosticLogVersion();'),
    '15H-3: init 早期调用 reconcileDiagnosticLogVersion 清理遗留日志');

  assertPass(backgroundSource.includes("'reportContentError'")
      && backgroundSource.includes("msg.type === 'reportContentError'")
      && backgroundSource.includes("String(msg.source || 'content-script')"),
    '15I: 后台接收内容脚本错误回传并写入本机诊断日志');

  // ===== 用例 16: 运行时段作为两种自动控制的全局门禁 =====
  beginSuite('用例 16：运行时段全局门禁',
    '\n\n=== 用例 16: 运行时段全局门禁与竞态收口 ===\n');

  const activeHoursPolicySource = extractSourceSection(
    backgroundSource,
    'function parseHHMM(s) {',
    '\n// 返回下一次状态切换的时间戳',
    'active-hours policy'
  );
  const createActiveHoursPolicy = new Function(
    'schedule',
    `let automaticOnAdmissionBlocked = false;
    ${activeHoursPolicySource}; return {
      isWithinActiveHours,
      isWithinActiveHoursForSchedule,
      isAutomationAllowed,
      isAutomationAllowedForSchedule
    };`
  );
  const activeHoursSchedule = {
    enabled: true,
    activeHours: { enabled: true, start: '08:00', end: '23:00' }
  };
  const activeHoursPolicy = createActiveHoursPolicy(activeHoursSchedule);
  assertPass(!activeHoursPolicy.isWithinActiveHours(new Date(2026, 7, 18, 7, 59))
      && activeHoursPolicy.isWithinActiveHours(new Date(2026, 7, 18, 8, 0))
      && activeHoursPolicy.isWithinActiveHours(new Date(2026, 7, 18, 22, 59))
      && !activeHoursPolicy.isWithinActiveHours(new Date(2026, 7, 18, 23, 0))
      && !activeHoursPolicy.isAutomationAllowed(new Date(2026, 7, 18, 7, 59))
      && activeHoursPolicy.isAutomationAllowed(new Date(2026, 7, 18, 8, 0))
      && activeHoursPolicy.isAutomationAllowed(new Date(2026, 7, 18, 12, 0))
      && !activeHoursPolicy.isAutomationAllowed(new Date(2026, 7, 18, 23, 0)),
    '16A: 运行时段与自动门禁共同采用同日半开区间 [start,end)');
  assertPass(activeHoursPolicy.isAutomationAllowedForSchedule({
    enabled: true,
    activeHours: { enabled: false }
  }, new Date(2026, 7, 18, 12, 0))
      && !activeHoursPolicy.isAutomationAllowedForSchedule({
        enabled: false,
        activeHours: { enabled: false }
      }, new Date(2026, 7, 18, 12, 0))
      && !activeHoursPolicy.isAutomationAllowedForSchedule({
        enabled: true,
        activeHours: { enabled: true, start: '00:00', end: '00:01' }
      }, new Date(2026, 7, 18, 12, 0)),
    '16A-1: 候选配置门禁可在写入全局 schedule 前判断 retry 是否被同快照取消');
  activeHoursSchedule.activeHours.enabled = false;
  assertPass(activeHoursPolicy.isWithinActiveHours(new Date(2026, 7, 18, 3, 0))
      && activeHoursPolicy.isAutomationAllowed(),
    '16B: 未启用运行时段时，两种自动控制全天可运行');
  activeHoursSchedule.enabled = false;
  assertPass(!activeHoursPolicy.isAutomationAllowed(),
    '16C: 用户关闭自动控制时，即使在运行时段内也不允许执行');
  activeHoursSchedule.enabled = true;
  activeHoursSchedule.activeHours = { enabled: true, start: '23:00', end: '07:00' };
  assertPass(!activeHoursPolicy.isWithinActiveHours(new Date(2026, 7, 18, 23, 30))
      && !activeHoursPolicy.isAutomationAllowed(),
    '16C-1: 跨午夜或 start>=end 的非法运行时段必须 fail-closed，不能意外放开自动控制');

  const automationHeadingIndex = popupHtml.indexOf('class="automation-heading"');
  const automationToggleIndex = popupHtml.indexOf('id="automationToggle"');
  const activeHoursSectionIndex = popupHtml.indexOf('class="active-hours-section"');
  const activeHoursHeaderIndex = popupHtml.indexOf('id="activeHoursSectionHeader"');
  const activeHoursBodyIndex = popupHtml.indexOf('id="activeHoursBody"');
  const modeSectionIndex = popupHtml.indexOf('class="mode-section"');
  const timerChoiceIndex = popupHtml.indexOf('id="timerToggle"');
  const smartChoiceIndex = popupHtml.indexOf('id="smartModeToggle"');
  const syncActiveHoursUiSource = extractSourceSection(
    popupSource,
    'function syncActiveHoursUI() {',
    '\nfunction syncModeUI() {',
    'syncActiveHoursUI'
  );
  const syncModeUiSource = extractSourceSection(
    popupSource,
    'function syncModeUI() {',
    '\nfunction commitActiveHours() {',
    'syncModeUI'
  );
  assertPass(automationHeadingIndex >= 0
      && automationToggleIndex > automationHeadingIndex
      && activeHoursSectionIndex > automationHeadingIndex
      && activeHoursSectionIndex > automationToggleIndex
      && activeHoursHeaderIndex > activeHoursSectionIndex
      && activeHoursBodyIndex > activeHoursHeaderIndex
      && modeSectionIndex > activeHoursBodyIndex
      && timerChoiceIndex > modeSectionIndex
      && smartChoiceIndex > timerChoiceIndex
      && /<section class="active-hours-section"[\s\S]*?id="activeHoursSectionHeader"[\s\S]*?id="activeHoursBody"[\s\S]*?<\/section>\s*<fieldset class="mode-section"/.test(popupHtml)
      && /<fieldset class="mode-section">\s*<legend class="visually-hidden" id="automationModeLabel" data-i18n="automationModeLabel"><\/legend>[\s\S]*?class="mode-segment"/.test(popupHtml)
      && !popupHtml.includes('role="group" aria-labelledby="automationModeLabel"')
      && !popupHtml.includes('automationModeExclusive')
      && !popupHtml.includes('automationModeHint'),
    '16D: 自动控制先提供独立总开关并声明共同作用域；分段控件保留无障碍分组名');
  const timerModeHandlerSource16 = extractSourceSection(
    popupSource,
    "timerToggle.addEventListener('click', async () => {",
    '\n});\n\n// ----- 修改分钟数自动保存；运行中则重启当前周期 -----',
    'timer mode selection'
  );
  const smartModeHandlerSource16 = extractSourceSection(
    popupSource,
    "smartModeToggle.addEventListener('click', async () => {",
    "\nsmartSensitivity.addEventListener('input'",
    'smart mode selection'
  );
  assertPass(syncModeUiSource.includes('automationToggle.checked = currentScheduleEnabled;')
      && syncModeUiSource.includes('const smartSelected = currentSmartMode.enabled;')
      && syncModeUiSource.includes('const timerSelected = !smartSelected;')
      && syncModeUiSource.includes("timerToggle.setAttribute('aria-pressed', String(timerSelected));")
      && syncModeUiSource.includes("smartModeToggle.setAttribute('aria-pressed', String(smartSelected));")
      && syncModeUiSource.includes('timerBody.hidden = !timerSelected;')
      && syncModeUiSource.includes('smartBody.hidden = !smartSelected;')
      && popupSource.includes("timerToggle.addEventListener('click', async () => {")
      && popupSource.includes("smartModeToggle.addEventListener('click', async () => {")
      && popupSource.includes("automationToggle.addEventListener('change', async () => {")
      && timerModeHandlerSource16.includes('if (!currentSmartMode.enabled) return;')
      && smartModeHandlerSource16.includes('if (currentSmartMode.enabled) return;')
      && !timerModeHandlerSource16.includes('currentScheduleEnabled = enabled;')
      && !smartModeHandlerSource16.includes('currentScheduleEnabled = enabled;'),
    '16D-1: 总开关只管启停；分段控件始终单选且再次点击当前模式不会关闭自动控制');
  assertPass(syncActiveHoursUiSource.includes('activeHoursBody.hidden = !currentActiveHours.enabled;')
      && !syncModeUiSource.includes('activeHoursBody')
      && !syncModeUiSource.includes('activeHoursToggle'),
    '16E: 模式切换只折叠各自设置，不隐藏或改写运行时段');
  const commitActiveHoursSource16 = extractSourceSection(
    popupSource,
    'function commitActiveHours() {',
    '\nactiveHoursToggle.addEventListener',
    'commitActiveHours validation'
  );
  const activeHoursStartControl16 = {
    value: '23:00',
    validationMessage: '',
    reportCount: 0,
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { this.reportCount += 1; return !this.validationMessage; }
  };
  const activeHoursEndControl16 = {
    value: '07:00',
    validationMessage: '',
    reportCount: 0,
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { this.reportCount += 1; return !this.validationMessage; }
  };
  const activeHoursCommitHarness16 = new Function(
    'activeHoursToggle', 'activeHoursStart', 'activeHoursEnd', 'normalize24HourTime', 't',
    `let currentScheduleEnabled = true;
    let currentActiveHours = { enabled: false, start: '08:00', end: '23:00' };
    let updateCount = 0;
    function syncActiveHoursUI() {}
    function updateSchedule() { updateCount += 1; }
    ${commitActiveHoursSource16}
    return {
      commitActiveHours,
      getState: () => ({ currentActiveHours: { ...currentActiveHours }, updateCount })
    };`
  )(
    { checked: true },
    activeHoursStartControl16,
    activeHoursEndControl16,
    value => {
      const match = String(value || '').trim().match(/^(\d{1,2})(?::?(\d{2}))$/);
      if (!match) return '';
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (!Number.isInteger(hours) || !Number.isInteger(minutes)
          || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    },
    key => key === 'activeHoursInvalid'
      ? 'invalid active hours'
      : key === 'time24Invalid' ? 'invalid 24-hour time' : key
  );
  activeHoursCommitHarness16.commitActiveHours();
  const invalidCommitState16 = activeHoursCommitHarness16.getState();
  activeHoursStartControl16.value = '25:00';
  activeHoursEndControl16.value = '23:00';
  activeHoursCommitHarness16.commitActiveHours();
  const invalidFormatState16 = activeHoursCommitHarness16.getState();
  activeHoursStartControl16.value = '800';
  activeHoursEndControl16.value = '2300';
  activeHoursCommitHarness16.commitActiveHours();
  const validCommitState16 = activeHoursCommitHarness16.getState();
  assertPass(invalidCommitState16.updateCount === 0
      && invalidCommitState16.currentActiveHours.enabled === false
      && activeHoursEndControl16.reportCount === 1
      && invalidFormatState16.updateCount === 0
      && activeHoursStartControl16.reportCount === 1
      && validCommitState16.updateCount === 1
      && validCommitState16.currentActiveHours.enabled === true
      && validCommitState16.currentActiveHours.start === '08:00'
      && validCommitState16.currentActiveHours.end === '23:00'
      && activeHoursStartControl16.validationMessage === ''
      && activeHoursEndControl16.validationMessage === ''
      && zhCN.activeHoursInvalid?.message
      && en.activeHoursInvalid?.message
      && zhCN.time24Invalid?.message
      && en.time24Invalid?.message,
    '16E-1: popup 拒绝非法范围和非法时间，接受简写并归一为 24 小时 HH:mm');

  const normalize24HourTimeStart16 = popupSource.indexOf('function normalize24HourTime(value) {');
  assertPass(normalize24HourTimeStart16 >= 0,
    '16E-2: popup 提供可独立验证的 24 小时时间归一函数');
  if (normalize24HourTimeStart16 >= 0) {
    const normalize24HourTimeSource16 = extractSourceSection(
      popupSource,
      'function normalize24HourTime(value) {',
      '\nfunction commitActiveHours() {',
      'normalize24HourTime'
    );
    const normalize24HourTime16 = new Function(
      `${normalize24HourTimeSource16}; return normalize24HourTime;`
    )();
    assertPass(normalize24HourTime16('0800') === '08:00'
        && normalize24HourTime16('8:00') === '08:00'
        && normalize24HourTime16('23:59') === '23:59'
        && normalize24HourTime16('24:00') === ''
        && normalize24HourTime16('12:60') === ''
        && normalize24HourTime16('8 PM') === '',
      '16E-3: 24 小时归一接受 HHmm/H:mm，拒绝 AM/PM 与越界值');
  }

  const minuteValidationStart16 = popupSource.indexOf('function validateManualMinutes(');
  assertPass(minuteValidationStart16 >= 0
      && !popupSource.includes('readPositiveMinutes(input, fallback)')
      && !popupSource.includes('onMinutesInput.value = data.onMinutes;')
      && popupSource.includes('validateManualMinutes({ report: enabled && !currentSmartMode.enabled })')
      && popupSource.includes('if (!manualMinutes && enabled && !currentSmartMode.enabled)')
      && popupSource.indexOf('const updateRevision = ++scheduleUpdateRevision;', popupSource.indexOf('async function updateSchedule('))
        > popupSource.indexOf('if (!manualMinutes && enabled && !currentSmartMode.enabled)', popupSource.indexOf('async function updateSchedule('))
      && zhCN.minutesInvalid?.message
      && en.minutesInvalid?.message,
    '16E-4: 非法分钟保留原文且只阻止启用循环定时；关闭路径不被表单错误阻断');
  if (minuteValidationStart16 >= 0) {
    const manualMinutesValidationSource16 = extractSourceSection(
      popupSource,
      'function parsePositiveMinutes(value) {',
      '\n// ----- 更新定时设置 -----',
      'manual minutes validation'
    );
    const makeMinuteControl16 = value => ({
      value,
      validationMessage: '',
      reportCount: 0,
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { this.reportCount += 1; return !this.validationMessage; }
    });
    const onMinuteControl16 = makeMinuteControl16('15');
    const offMinuteControl16 = makeMinuteControl16('45');
    const manualMinutesHarness16 = new Function(
      'onMinutesInput', 'offMinutesInput', 't',
      `let currentManualMinutes = { onMinutes: 15, offMinutes: 45 };
      ${manualMinutesValidationSource16}
      return { parsePositiveMinutes, validateManualMinutes };`
    )(onMinuteControl16, offMinuteControl16, () => 'invalid minutes');
    const validMinutes16 = manualMinutesHarness16.validateManualMinutes({ report: true });
    onMinuteControl16.value = '1.5';
    const decimalMinutes16 = manualMinutesHarness16.validateManualMinutes({ report: true });
    onMinuteControl16.value = '0';
    const zeroMinutes16 = manualMinutesHarness16.validateManualMinutes({ report: false });
    assertPass(validMinutes16.onMinutes === 15 && validMinutes16.offMinutes === 45
        && decimalMinutes16 === null && zeroMinutes16 === null
        && onMinuteControl16.value === '0'
        && onMinuteControl16.validationMessage === 'invalid minutes'
        && onMinuteControl16.reportCount === 1
        && manualMinutesHarness16.parsePositiveMinutes('01') === 1
        && manualMinutesHarness16.parsePositiveMinutes('abc') === null,
      '16E-5: 分钟校验接受正整数，拒绝小数／零／非数字，报告错误且不改写输入原文');
  }

  const setupAlarmsBody16 = extractSourceSection(
    backgroundSource,
    'async function setupAlarms(startImmediately = false, options = {}) {',
    '\nfunction sanitizeMinutes',
    'setupAlarms active-hours behavior'
  );
  const activeBoundaryBody16 = extractSourceSection(
    backgroundSource,
    'async function onActiveBoundaryCrossed() {',
    '\nfunction getLegacyAlarmEndMs()',
    'active boundary behavior'
  );
  const smartEntryNow16 = new Date(2026, 7, 18, 10, 5, 0, 0).getTime();
  const smartEntryPlan16 = pwmPhase.planSmartModeOnWindow(
    { onMinutes: 10 },
    { now: smartEntryNow16, maxOnMinutes: 25, acIsOn: false }
  );
  assertPass(activeBoundaryBody16.includes(
      'await setupAlarms(true, { phaseAdmissionEpoch })')
      && setupAlarmsBody16.includes('await executePwmStepWithRecovery({')
      && setupAlarmsBody16.includes("persistSchedule('setupAlarms-start-intent', { syncFromLiveAlarm: false })")
      && setupAlarmsBody16.indexOf("persistSchedule('setupAlarms-start-intent'")
        < setupAlarmsBody16.indexOf('await executePwmStepWithRecovery({')
      && smartEntryPlan16.kind === 'defer'
      && new Date(smartEntryPlan16.nextTriggerAt).getMinutes() === 30,
    '16F: 进入时段时循环模式可立即执行，智能模式仍等待下一个 :00/:30 窗口');
  const delayedSmartBoundary16 = new Date(2026, 7, 18, 10, 30, 0, 0).getTime();
  const delayedSmartNow16 = delayedSmartBoundary16 + 65_000;
  const delayedSmartTarget16 = delayedSmartBoundary16 + 21 * 60_000;
  const delayedAlarmPlan16 = pwmPhase.planSmartModeOnWindow(
    { onMinutes: 21 },
    {
      now: delayedSmartNow16,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: delayedSmartBoundary16
    }
  );
  const delayedWithoutAlarmPlan16 = pwmPhase.planSmartModeOnWindow(
    { onMinutes: 21 },
    { now: delayedSmartNow16, maxOnMinutes: 25, acIsOn: false }
  );
  const delayedCurrentCycleRecovery16 = pwmPhase.planSmartModeOnWindow(
    { onMinutes: 21 },
    {
      now: delayedSmartNow16,
      maxOnMinutes: 25,
      acIsOn: false,
      recoverCurrentCycle: true
    }
  );
  const tooLateForSafeTimerPlan16 = pwmPhase.planSmartModeOnWindow(
    { onMinutes: 21 },
    {
      now: delayedSmartTarget16 - 30_000,
      maxOnMinutes: 25,
      acIsOn: false,
      triggeredBoundaryAt: delayedSmartBoundary16
    }
  );
  const alreadyOnAtDelayedAlarm16 = pwmPhase.planPwmStep({
    enabled: true,
    onMinutes: 21,
    offMinutes: 9,
    pwmState: 'on'
  }, { acIsOn: true }, { now: delayedSmartNow16 });
  assertPass(delayedAlarmPlan16.kind === 'allow'
      && delayedAlarmPlan16.reason === 'smart-on-scheduled-boundary'
      && delayedAlarmPlan16.boundaryAt === delayedSmartBoundary16
      && delayedAlarmPlan16.pageTimerTargetAt === delayedSmartTarget16
      && delayedAlarmPlan16.windowEndsAt === delayedSmartTarget16
      && delayedWithoutAlarmPlan16.kind === 'defer'
      && tooLateForSafeTimerPlan16.kind === 'defer'
      && alreadyOnAtDelayedAlarm16.kind === 'hold'
      && alreadyOnAtDelayedAlarm16.prerequisite === 'set-page-timer',
    '16F-0A: 可信半点 alarm 可补执行剩余 ON 相位且保持原绝对关机点；普通迟到调用仍等待，已 ON 直接进入页面 timer');
  const tooLateCurrentCycleRecovery16 = pwmPhase.planSmartModeOnWindow(
    { onMinutes: 21 },
    {
      now: delayedSmartTarget16 - 30_000,
      maxOnMinutes: 25,
      acIsOn: false,
      recoverCurrentCycle: true
    }
  );
  assertPass(delayedCurrentCycleRecovery16.kind === 'allow'
      && delayedCurrentCycleRecovery16.reason === 'smart-on-current-cycle-recovery'
      && delayedCurrentCycleRecovery16.boundaryAt === delayedSmartBoundary16
      && delayedCurrentCycleRecovery16.pageTimerTargetAt === delayedSmartTarget16
      && delayedCurrentCycleRecovery16.windowEndsAt === delayedSmartTarget16
      && tooLateCurrentCycleRecovery16.kind === 'defer'
      && tooLateCurrentCycleRecovery16.nextTriggerAt
        === new Date(2026, 7, 18, 11, 0, 0, 0).getTime(),
    '16F-0D: 明确生命周期恢复可补当前剩余 ON 窗口；不足一分钟安全余量时仍等待下个半点');
  const alarmPwmBranch16 = extractSourceSection(
    backgroundSource,
    "if (alarm.name === 'ac-pwm') {",
    "\n  if (alarm.name === 'ac-watchdog') {",
    'ac-pwm alarm scheduled boundary forwarding'
  );
  assertPass(alarmPwmBranch16.includes(
      'await executePwmStepWithRecovery({'
    )
      && alarmPwmBranch16.includes('scheduledTime: alarm.scheduledTime')
      && alarmPwmBranch16.includes("source: 'alarm-ac-pwm'")
      && setupAlarmsBody16.includes(
        'storedAlarmAt: storedDueAt'
      )
      && backgroundSource.includes(
        'scheduledTime: plan.scheduledTime,'
      )
      && backgroundSource.includes(': pwmTriggerScheduledTime,'),
    '16F-0B: alarm 与启动期 storage 补执行都经共享异常边界传递原计划时刻，不丢失 :00/:30 身份');
  const retryStateHelpers16 = extractSourceSection(
    backgroundSource,
    'function clearPwmRetryState() {',
    '\nfunction applyPwmPlanState(',
    'smart-on retry state helpers'
  );
  const loadRetryStateHarness16 = initialSchedule => new Function(
    'initialSchedule',
    `let schedule = initialSchedule;
    const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    const setNextTriggerAt = value => { schedule.nextTriggerAt = value; };
    ${retryStateHelpers16}
    return {
      set: setSmartOnPwmRetryState,
      get: getSmartOnPwmRetryContext,
      getActive: getActiveSmartOnPwmRetryContext,
      clear: clearPwmRetryState,
      prepareFreshStart: prepareFreshPwmStartState,
      snapshot: () => schedule
    };`
  )(initialSchedule);
  const retryBoundary16 = new Date(2026, 7, 18, 22, 30, 0, 0).getTime();
  const retryScheduled16 = retryBoundary16 + 60_000;
  const initialRetryHarness16 = loadRetryStateHarness16({
    enabled: true,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmState: 'on',
    smartOnBoundaryAt: retryBoundary16,
    nextTriggerAt: retryScheduled16,
    pageTimerError: '新建的 AC 页面未就绪',
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  });
  initialRetryHarness16.set('on', retryScheduled16);
  const serializedRetry16 = JSON.parse(JSON.stringify(initialRetryHarness16.snapshot()));
  const reloadedRetrySchedule16 = JSON.parse(JSON.stringify(serializedRetry16));
  const reloadedRetryHarness16 = loadRetryStateHarness16(reloadedRetrySchedule16);
  const exactRetryContext16 = reloadedRetryHarness16.get(
    serializedRetry16,
    retryScheduled16
  );
  const maxDriftRetryContext16 = reloadedRetryHarness16.getActive(
    serializedRetry16,
    retryScheduled16 + 1500
  );
  const staleLiveRetryContext16 = reloadedRetryHarness16.getActive(
    serializedRetry16,
    retryScheduled16 + 1501
  );
  const storedFallbackRetryContext16 = reloadedRetryHarness16.getActive(
    serializedRetry16,
    0
  );
  const fractionalRetryAt16 = retryScheduled16 + 0.5;
  const fractionalRetryHarness16 = loadRetryStateHarness16({
    ...serializedRetry16,
    nextTriggerAt: fractionalRetryAt16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartOnBoundaryAt: retryBoundary16
  });
  fractionalRetryHarness16.set('on', fractionalRetryAt16);
  const fractionalRetryContext16 = fractionalRetryHarness16.getActive(
    fractionalRetryHarness16.snapshot(),
    fractionalRetryAt16
  );
  const pwmTriggerNormalizationStart16 = pwmBody.indexOf(
    'const requestedScheduledTime = Number(scheduledTime);'
  );
  const pwmTriggerNormalizationEnd16 = pwmBody.indexOf(
    'const recoveringSmartCurrentCycle',
    pwmTriggerNormalizationStart16
  );
  const pwmTriggerNormalizationSource16 = pwmTriggerNormalizationStart16 >= 0
      && pwmTriggerNormalizationEnd16 > pwmTriggerNormalizationStart16
    ? pwmBody.slice(pwmTriggerNormalizationStart16, pwmTriggerNormalizationEnd16)
    : '';
  const normalizeRunPwmTrigger16 = new Function(
    'scheduledTime',
    `${pwmTriggerNormalizationSource16}; return pwmTriggerScheduledTime;`
  );
  const normalizedFractionalRunPwmTrigger16 = normalizeRunPwmTrigger16(fractionalRetryAt16);
  const runPwmFractionalRetryContext16 = fractionalRetryHarness16.getActive(
    fractionalRetryHarness16.snapshot(),
    normalizedFractionalRunPwmTrigger16
  );
  const safeDelayBoundary16 = retryBoundary16 + 30 * 60_000;
  const safeDelayScheduled16 = safeDelayBoundary16 + 60_000;
  const safeDelayHarness16 = loadRetryStateHarness16({
    enabled: true,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmState: 'on',
    onMinutes: 22,
    smartOnBoundaryAt: retryBoundary16,
    pageTimerError: '',
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  });
  safeDelayHarness16.set('on', safeDelayScheduled16, {
    kind: 'smart-on-safe-delay',
    boundaryAt: safeDelayBoundary16
  });
  const safeDelayContext16 = safeDelayHarness16.getActive(
    safeDelayHarness16.snapshot(),
    safeDelayScheduled16
  );
  reloadedRetryHarness16.clear();
  const clearedRetry16 = reloadedRetryHarness16.snapshot();
  const ignoredRetryHarness16 = loadRetryStateHarness16({
    smartMode: { enabled: false },
    pwmState: 'on',
    smartOnBoundaryAt: retryBoundary16
  });
  ignoredRetryHarness16.set('on', retryScheduled16);
  const resurrectedStartHarness16 = loadRetryStateHarness16({
    ...serializedRetry16,
    nextTriggerAt: retryScheduled16,
    alarmCreatedAt: retryBoundary16,
    alarmDelayMinutes: 1
  });
  resurrectedStartHarness16.prepareFreshStart();
  const durableFreshStart16 = JSON.parse(JSON.stringify(
    resurrectedStartHarness16.snapshot()
  ));
  assertPass(serializedRetry16.pwmRetryKind === 'smart-on'
      && serializedRetry16.pwmRetryBoundaryAt === retryBoundary16
      && serializedRetry16.pwmRetryScheduledAt === retryScheduled16
      && exactRetryContext16.hasTypedSmartOnRetry === true
      && exactRetryContext16.boundaryAt === retryBoundary16
      && exactRetryContext16.priorError === '新建的 AC 页面未就绪'
      && maxDriftRetryContext16.hasTypedSmartOnRetry === true
      && staleLiveRetryContext16.hasStoredSmartOnRetry === true
      && staleLiveRetryContext16.hasTypedSmartOnRetry === false
      && storedFallbackRetryContext16.hasTypedSmartOnRetry === true
      && fractionalRetryHarness16.snapshot().pwmRetryScheduledAt === fractionalRetryAt16
      && fractionalRetryContext16.hasTypedSmartOnRetry === true
      && normalizedFractionalRunPwmTrigger16 === fractionalRetryAt16
      && runPwmFractionalRetryContext16.hasTypedSmartOnRetry === true
      && safeDelayHarness16.snapshot().pwmRetryKind === 'smart-on-safe-delay'
      && safeDelayHarness16.snapshot().pwmRetryBoundaryAt === safeDelayBoundary16
      && safeDelayHarness16.snapshot().pwmRetryScheduledAt === safeDelayScheduled16
      && safeDelayContext16.hasTypedSmartOnRetry === true
      && safeDelayContext16.kind === 'smart-on-safe-delay'
      && safeDelayContext16.boundaryAt === safeDelayBoundary16
      && clearedRetry16.pwmRetryKind === ''
      && clearedRetry16.pwmRetryBoundaryAt === 0
      && clearedRetry16.pwmRetryScheduledAt === 0
      && ignoredRetryHarness16.snapshot().pwmRetryKind === ''
      && durableFreshStart16.pwmState === 'on'
      && durableFreshStart16.nextTriggerAt === 0
      && durableFreshStart16.alarmCreatedAt === 0
      && durableFreshStart16.alarmDelayMinutes === 0
      && durableFreshStart16.pwmRetryKind === ''
      && durableFreshStart16.pwmRetryBoundaryAt === 0
      && durableFreshStart16.pwmRetryScheduledAt === 0,
    '16F-0B-1: 普通／安全延迟 smart-on retry 经 JSON/小数毫秒 alarm 穿过 runPwmStep 入场仍绑定显式原半点；live 优先，失配/停用拒绝，fresh-start 清空三字段');
  const setNextTriggerAtSource16 = extractSourceSection(
    backgroundSource,
    'function setNextTriggerAt(nextTriggerAt, options = {}) {',
    '\nasync function executePwmLifecycleRecoveryFallback',
    'setNextTriggerAt durable origin helper'
  );
  const phaseSensitiveAlarmGateStart16 = alarmListenerBody13.indexOf(
    '  const phaseSensitiveAlarm ='
  );
  const phaseSensitiveAlarmGateEnd16 = alarmListenerBody13.indexOf(
    '\n  console.log(`[AC扩展] 闹钟触发:',
    phaseSensitiveAlarmGateStart16
  );
  const phaseSensitiveAlarmGateBody16 = phaseSensitiveAlarmGateStart16 >= 0
      && phaseSensitiveAlarmGateEnd16 > phaseSensitiveAlarmGateStart16
    ? alarmListenerBody13.slice(
      phaseSensitiveAlarmGateStart16,
      phaseSensitiveAlarmGateEnd16
    )
    : '';
  const scheduleOnlyActiveBoundaryStart16 = alarmListenerBody13.indexOf(
    '  if (alarm.name === ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM)'
  );
  const scheduleOnlyActiveBoundaryBody16 =
      scheduleOnlyActiveBoundaryStart16 >= 0
      && phaseSensitiveAlarmGateStart16 > scheduleOnlyActiveBoundaryStart16
    ? alarmListenerBody13.slice(
      scheduleOnlyActiveBoundaryStart16,
      phaseSensitiveAlarmGateStart16
    )
    : '';
  const activeBoundaryPhaseCoordinatorSource16 = extractSourceSection(
    backgroundSource,
    'function normalizeActiveBoundaryRetryMode(mode, retryAt = 0) {',
    '\n\n// 调度下一次 :20/:50 天气预取',
    'active boundary phase-adoption defer coordinator'
  );
  const activeBoundaryHeartbeatSource16 = extractSourceSection(
    backgroundSource,
    'async function runHeartbeat() {',
    '\n\nfunction startHeartbeat()',
    'active boundary heartbeat recovery'
  );
  const createActiveBoundaryPhaseGateHarness16 = (
    storageGate = null,
    onStorageStart = null
  ) => new Function(
    'storageGate', 'onStorageStart', 'console',
    `let phaseBlocked = false;
    let activeBoundaryDeferredForPhaseAdoption = false;
    let activeBoundaryOwnerReadDeferred = false;
    let activeBoundaryMutationChain = Promise.resolve();
    let activeBoundaryCompletionGeneration = 0;
    let pwmRuntimeRevision = 19;
    const ACTIVE_BOUNDARY_RETRY_KEY = 'ac_active_boundary_retry_at';
    const ACTIVE_BOUNDARY_RETRY_MODE_KEY = 'ac_active_boundary_retry_mode';
    const ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY =
      'ac_active_boundary_retry_boundary_at';
    const ACTIVE_BOUNDARY_RETRY_MODE_ACTION = 'action';
    const ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE = 'schedule';
    const ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM =
      'ac-active-boundary-schedule-retry';
    const ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM =
      'ac-active-boundary-owner-read-retry';
    const ACTIVE_BOUNDARY_RETRY_MS = 60_000;
    const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    const schedule = { activeHours: { enabled: true } };
    const durable = {
      [ACTIVE_BOUNDARY_RETRY_KEY]: 0,
      [ACTIVE_BOUNDARY_RETRY_MODE_KEY]: '',
      [ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]: 0
    };
    const alarms = new Map();
    const calls = [];
    const initReady = Promise.resolve();
    function isSyncPhaseAdoptionAdmissionBlocked() { return phaseBlocked; }
    async function createAlarm(name, info = {}) {
      calls.push({ type: 'create', name, info: { ...info } });
      const scheduledTime = Number(info.when)
        || Date.now() + Math.max(1, Number(info.delayInMinutes) || 1) * 60_000;
      alarms.set(name, { name, scheduledTime });
      return true;
    }
    const chrome = {
      storage: { local: {
        async get(key) {
          calls.push({ type: 'durable-get', key });
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map(item => [item, durable[item]]));
        },
        async set(value) {
          calls.push({ type: 'durable-set', value: { ...value } });
          Object.assign(durable, value);
        }
      } },
      alarms: {
        async get(name) { return alarms.get(name); },
        async clear(name) {
          calls.push({ type: 'alarm-clear', name });
          return alarms.delete(name);
        }
      }
    };
    function getNextActiveBoundary() { return Date.now() + 30 * 60_000; }
    ${activeBoundaryPhaseCoordinatorSource16}
    async function loadScheduleFromStorage() {
      calls.push({ type: 'storage-load' });
      if (storageGate) {
        if (typeof onStorageStart === 'function') onStorageStart();
        await storageGate;
      }
    }
    async function onActiveBoundaryCrossed() {
      calls.push({ type: 'active-boundary-run' });
      pwmRuntimeRevision += 1;
      calls.push({ type: 'runtime-clear' });
    }
    function appendDiagnosticLog() {}
    async function deliverActiveBoundary() {
      const alarm = { name: 'ac-active-boundary', scheduledTime: Date.now() };
      await initReady;
      ${scheduleOnlyActiveBoundaryBody16}
      ${phaseSensitiveAlarmGateBody16}
      calls.push({ type: 'gate-passed' });
      await onActiveBoundaryCrossed();
    }
    return {
      claim: () => { phaseBlocked = true; },
      release: () => { phaseBlocked = false; },
      deliver: deliverActiveBoundary,
      reschedule: rescheduleActiveBoundary,
      revision: () => pwmRuntimeRevision,
      deferred: () => activeBoundaryDeferredForPhaseAdoption,
      retryAt: () => Number(durable[ACTIVE_BOUNDARY_RETRY_KEY]) || 0,
      alarmAt: () => Number(alarms.get('ac-active-boundary')?.scheduledTime) || 0,
      calls
    };`
  )(storageGate, onStorageStart, testConsole);

  const activeBoundaryPreGate16 = createActiveBoundaryPhaseGateHarness16();
  activeBoundaryPreGate16.claim();
  await activeBoundaryPreGate16.deliver();
  activeBoundaryPreGate16.release();
  await activeBoundaryPreGate16.reschedule();
  const activeBoundaryPreGateCreates16 = activeBoundaryPreGate16.calls.filter(
    call => call.type === 'create' && call.name === 'ac-active-boundary'
  );
  assertPass(phaseSensitiveAlarmGateBody16.includes(
      'activeBoundaryActionDelivery')
      && phaseSensitiveAlarmGateBody16.includes(
        'await deferActiveBoundaryForPhaseAdoption();')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'const retryPending = !consumePending')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'activeBoundaryDeferredForPhaseAdoption\n      || effectiveRetryAt > 0')
      && !activeBoundaryPhaseCoordinatorSource16.includes(
        'activeBoundaryDeferredForPhaseAdoption\n      && isSyncPhaseAdoptionAdmissionBlocked()')
      && activeBoundaryPreGate16.revision() === 19
      && activeBoundaryPreGate16.deferred() === true
      && activeBoundaryPreGate16.retryAt() > Date.now()
      && activeBoundaryPreGate16.alarmAt()
        === activeBoundaryPreGate16.retryAt()
      && !activeBoundaryPreGate16.calls.some(call =>
        call.type === 'storage-load'
          || call.type === 'active-boundary-run'
          || call.type === 'runtime-clear')
      && activeBoundaryPreGateCreates16.length === 1
      && activeBoundaryPreGateCreates16.every(call =>
        call.info.when === activeBoundaryPreGate16.retryAt()),
    '16F-0B-1E-0D-1: ac-active-boundary 在 reservation 前置门禁零 reload/bump/runtime-clear；释放后普通 reschedule 仍只保留一分钟 retry');

  let releaseActiveBoundaryStorage16;
  let markActiveBoundaryStorageStarted16;
  const activeBoundaryStorageGate16 = new Promise(resolve => {
    releaseActiveBoundaryStorage16 = resolve;
  });
  const activeBoundaryStorageStarted16 = new Promise(resolve => {
    markActiveBoundaryStorageStarted16 = resolve;
  });
  const activeBoundaryPostGate16 = createActiveBoundaryPhaseGateHarness16(
    activeBoundaryStorageGate16,
    markActiveBoundaryStorageStarted16
  );
  const activeBoundaryPostDelivery16 = activeBoundaryPostGate16.deliver();
  await activeBoundaryStorageStarted16;
  activeBoundaryPostGate16.claim();
  releaseActiveBoundaryStorage16();
  await activeBoundaryPostDelivery16;
  activeBoundaryPostGate16.release();
  await activeBoundaryPostGate16.reschedule();
  const activeBoundaryPostGateCreates16 = activeBoundaryPostGate16.calls.filter(
    call => call.type === 'create' && call.name === 'ac-active-boundary'
  );
  assertPass(activeBoundaryPostGate16.revision() === 19
      && activeBoundaryPostGate16.deferred() === true
      && activeBoundaryPostGate16.retryAt() > Date.now()
      && activeBoundaryPostGate16.alarmAt()
        === activeBoundaryPostGate16.retryAt()
      && activeBoundaryPostGate16.calls.filter(call =>
        call.type === 'storage-load').length === 1
      && !activeBoundaryPostGate16.calls.some(call =>
        call.type === 'gate-passed'
          || call.type === 'active-boundary-run'
          || call.type === 'runtime-clear')
      && activeBoundaryPostGateCreates16.length === 1
      && activeBoundaryPostGateCreates16.every(call =>
        call.info.when === activeBoundaryPostGate16.retryAt()),
    '16F-0B-1E-0D-2: ac-active-boundary storage reload 后 reservation 抢入时再次 fail closed；释放后 deferred flag 防止正常边界覆盖一分钟 retry');

  const activeBoundaryHandlerSource16 = extractSourceSection(
    backgroundSource,
    'async function onActiveBoundaryCrossed() {',
    '\n\nfunction getLegacyAlarmEndMs()',
    'active boundary owned transaction'
  );
  const activeBoundaryAdmissionSource16 = extractSourceSection(
    backgroundSource,
    'function claimSyncPhaseAdoptionAdmission() {',
    '\n\nfunction releasePwmStepOwnership(automationRevision) {',
    'active boundary shared phase admission'
  );
  const createOwnedActiveBoundaryHarness16 = (
    nowMs,
    harnessOptions = {},
    sharedState = null
  ) => new Function(
    'nowMs', 'harnessOptions', 'sharedState', 'console', 'NativeDate',
    'setTimeout',
    `const ACTIVE_BOUNDARY_RETRY_KEY = 'ac_active_boundary_retry_at';
    const ACTIVE_BOUNDARY_RETRY_MODE_KEY = 'ac_active_boundary_retry_mode';
    const ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY =
      'ac_active_boundary_retry_boundary_at';
    const ACTIVE_BOUNDARY_RETRY_MODE_ACTION = 'action';
    const ACTIVE_BOUNDARY_RETRY_MODE_SCHEDULE = 'schedule';
    const ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM =
      'ac-active-boundary-schedule-retry';
    const ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM =
      'ac-active-boundary-owner-read-retry';
    const ACTIVE_BOUNDARY_RETRY_MS = 60_000;
    const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    const STORAGE_KEY = 'ac_schedule';
    const durable = sharedState?.durable || {
      [ACTIVE_BOUNDARY_RETRY_KEY]: 0,
      [ACTIVE_BOUNDARY_RETRY_MODE_KEY]: '',
      [ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]: 0,
      [STORAGE_KEY]: null
    };
    const alarms = sharedState?.alarms || new Map();
    let activeBoundaryDeferredForPhaseAdoption = false;
    let activeBoundaryOwnerReadDeferred = false;
    let activeBoundaryMutationChain = Promise.resolve();
    let activeBoundaryCompletionGeneration = 0;
    let syncPhaseAdoptionAdmissionEpoch = 0;
    let syncPhaseAdoptionAdmissionOwner = 0;
    let pwmExecutionWithRecoveryCount = 0;
    let deferredRepairAfterPwmOptions = null;
    let scheduleRepairEpoch = 0;
    let pwmRuntimeRevision = 51;
    let schedule = structuredClone(harnessOptions.schedule || {
      enabled: true,
      pwmState: 'off',
      nextTriggerAt: 0,
      smartMode: { enabled: true, sensitivity: 5 },
      activeHours: { enabled: true, start: '08:00', end: '23:00' }
    });
    let markerClearFailureUsed = false;
    let markerClearGateUsed = false;
    let markerWriteGateUsed = false;
    let activeBoundaryClearGateUsed = false;
    let activeBoundaryDurableReadGateUsed = false;
    let durableReadFailuresRemaining = Math.max(
      0,
      Number(harnessOptions.activeBoundaryDurableReadFailures) || 0
    );
    let markerWriteFailuresRemaining = Math.max(
      0,
      Number(harnessOptions.markerWriteFailures) || 0
    );
    const markerWriteFailuresByMode = new Map(Object.entries(
      harnessOptions.markerWriteFailuresByMode || {}
    ).map(([mode, count]) => [mode, Math.max(0, Number(count) || 0)]));
    const alarmClearFailuresRemaining = new Map(Object.entries(
      harnessOptions.alarmClearFailures || {}
    ).map(([name, count]) => [name, Math.max(0, Number(count) || 0)]));
    let currentNowMs = nowMs;
    const activeBoundaryCreateResults = Array.isArray(
      harnessOptions.activeBoundaryCreateResults
    ) ? [...harnessOptions.activeBoundaryCreateResults] : [];
    const activeBoundaryCreatedTimes = Array.isArray(
      harnessOptions.activeBoundaryCreatedTimes
    ) ? [...harnessOptions.activeBoundaryCreatedTimes] : [];
    const calls = [];
    const initReady = Promise.resolve();
    class HarnessDate extends NativeDate {
      static now() { return currentNowMs; }
    }
    const Date = HarnessDate;
    ${activeBoundaryAdmissionSource16}
    function isAutomationAllowed() { return schedule.enabled === true; }
    function isComfortStartActive() {
      return harnessOptions.comfortStartActive === true;
    }
    function isWithinActiveHours() {
      return harnessOptions.insideActiveHours !== false;
    }
    function getNextActiveBoundary(reference = new Date(currentNowMs)) {
      const referenceAt = Number(reference?.getTime?.()) || currentNowMs;
      calls.push({ type: 'natural-boundary-read', at: currentNowMs,
        referenceAt });
      if (typeof harnessOptions.getNextActiveBoundary === 'function') {
        return Number(harnessOptions.getNextActiveBoundary(
          referenceAt,
          currentNowMs
        )) || 0;
      }
      return Number(harnessOptions.naturalBoundaryAt)
        || currentNowMs + 30 * 60_000;
    }
    async function createAlarm(name, info = {}) {
      const scheduledTime = Number(info.when)
        || currentNowMs
          + Math.max(1, Number(info.delayInMinutes) || 1) * 60_000;
      const activeBoundaryAlarm = name === 'ac-active-boundary'
        || name === ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM
        || name === ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM;
      const verified = !activeBoundaryAlarm
        || activeBoundaryCreateResults.length === 0
        || activeBoundaryCreateResults.shift() !== false;
      const storedScheduledTime = activeBoundaryAlarm
          && activeBoundaryCreatedTimes.length > 0
        ? Number(activeBoundaryCreatedTimes.shift()) || scheduledTime
        : scheduledTime;
      calls.push({ type: 'create', name, info: { ...info }, scheduledTime,
        storedScheduledTime, verified });
      if (!verified) return false;
      alarms.set(name, { name, scheduledTime: storedScheduledTime,
        ...(Number(info.periodInMinutes) > 0
          ? { periodInMinutes: Number(info.periodInMinutes) }
          : {}) });
      return true;
    }
    const chrome = {
      storage: { local: {
        async get(key) {
          calls.push({ type: 'durable-get', key });
          const keys = Array.isArray(key) ? key : [key];
          if (keys.includes(ACTIVE_BOUNDARY_RETRY_KEY)
              && durableReadFailuresRemaining > 0) {
            durableReadFailuresRemaining -= 1;
            calls.push({ type: 'durable-get-failure', keys: [...keys] });
            throw new Error('synthetic active-boundary durable read failure');
          }
          const captured = Object.fromEntries(
            keys.map(item => [item, structuredClone(durable[item])])
          );
          if (keys.includes(ACTIVE_BOUNDARY_RETRY_KEY)
              && harnessOptions.activeBoundaryDurableReadGate
              && !activeBoundaryDurableReadGateUsed) {
            activeBoundaryDurableReadGateUsed = true;
            if (typeof harnessOptions.onActiveBoundaryDurableReadStart
                === 'function') {
              harnessOptions.onActiveBoundaryDurableReadStart();
            }
            await harnessOptions.activeBoundaryDurableReadGate;
          }
          if (keys.includes(ACTIVE_BOUNDARY_RETRY_KEY)
              && typeof harnessOptions.onActiveBoundaryDurableReadReturn
                === 'function') {
            harnessOptions.onActiveBoundaryDurableReadReturn(
              structuredClone(captured)
            );
          }
          return captured;
        },
        async set(value) {
          const markerWriteMode = String(
            value[ACTIVE_BOUNDARY_RETRY_MODE_KEY] || ''
          );
          const modeFailures = markerWriteFailuresByMode.get(
            markerWriteMode
          ) || 0;
          if (Number(value[ACTIVE_BOUNDARY_RETRY_KEY]) > 0
              && modeFailures > 0) {
            markerWriteFailuresByMode.set(
              markerWriteMode,
              modeFailures - 1
            );
            calls.push({ type: 'marker-write-failure', mode: markerWriteMode,
              value: structuredClone(value) });
            throw new Error('synthetic typed marker write failure');
          }
          if (Number(value[ACTIVE_BOUNDARY_RETRY_KEY]) > 0
              && markerWriteFailuresRemaining > 0) {
            markerWriteFailuresRemaining -= 1;
            calls.push({ type: 'marker-write-failure',
              value: structuredClone(value) });
            throw new Error('synthetic marker write failure');
          }
          if (!markerWriteGateUsed
              && harnessOptions.markerWriteGate
              && Number(value[ACTIVE_BOUNDARY_RETRY_KEY]) > 0) {
            markerWriteGateUsed = true;
            if (typeof harnessOptions.onMarkerWriteStart === 'function') {
              harnessOptions.onMarkerWriteStart();
            }
            await harnessOptions.markerWriteGate;
          }
          if (harnessOptions.failMarkerClear === true
              && !markerClearFailureUsed
              && value[ACTIVE_BOUNDARY_RETRY_KEY] === 0) {
            markerClearFailureUsed = true;
            calls.push({ type: 'marker-clear-failure' });
            throw new Error('synthetic marker clear failure');
          }
          if (!markerClearGateUsed
              && harnessOptions.markerClearGate
              && value[ACTIVE_BOUNDARY_RETRY_KEY] === 0) {
            markerClearGateUsed = true;
            if (typeof harnessOptions.onMarkerClearStart === 'function') {
              harnessOptions.onMarkerClearStart();
            }
            await harnessOptions.markerClearGate;
          }
          Object.assign(durable, structuredClone(value));
          calls.push({ type: 'durable-set', value: structuredClone(value) });
        }
      } },
      alarms: {
        async get(name) {
          const alarm = alarms.get(name);
          calls.push({ type: 'alarm-get', name,
            at: Number(alarm?.scheduledTime) || 0 });
          return alarm;
        },
        async clear(name) {
          calls.push({ type: 'alarm-clear', name });
          const clearFailures = alarmClearFailuresRemaining.get(name) || 0;
          if (clearFailures > 0) {
            alarmClearFailuresRemaining.set(name, clearFailures - 1);
            calls.push({ type: 'alarm-clear-failure', name });
            throw new Error('synthetic alarm clear failure: ' + name);
          }
          if (name === 'ac-active-boundary'
              && harnessOptions.activeBoundaryClearGate
              && !activeBoundaryClearGateUsed) {
            activeBoundaryClearGateUsed = true;
            if (typeof harnessOptions.onActiveBoundaryClearStart === 'function') {
              harnessOptions.onActiveBoundaryClearStart();
            }
            await harnessOptions.activeBoundaryClearGate;
          }
          return alarms.delete(name);
        }
      }
    };
    ${activeBoundaryPhaseCoordinatorSource16}
    async function persistSchedule(reason) {
      calls.push({ type: 'persist', reason, snapshot: structuredClone(schedule) });
      if (reason === 'active-hours-enter-pre-setup'
          && harnessOptions.persistGate) {
        if (typeof harnessOptions.onPersistStart === 'function') {
          harnessOptions.onPersistStart();
        }
        await harnessOptions.persistGate;
      }
      durable[STORAGE_KEY] = structuredClone(schedule);
    }
    async function setupAlarms(startImmediately, options = {}) {
      calls.push({ type: 'setup', startImmediately,
        options: { ...options } });
      if (harnessOptions.setupFails === true) return false;
      const setupAt = Number(harnessOptions.setupClockAt) || nowMs + 5 * 60_000;
      schedule.pwmState = 'off';
      schedule.nextTriggerAt = setupAt;
      schedule.alarmCreatedAt = nowMs;
      schedule.alarmDelayMinutes = (setupAt - nowMs) / 60_000;
      durable[STORAGE_KEY] = structuredClone(schedule);
      alarms.set('ac-pwm', { name: 'ac-pwm', scheduledTime: setupAt });
      calls.push({ type: 'setup-proof', at: setupAt,
        phaseAdmissionEpoch: options.phaseAdmissionEpoch });
      return true;
    }
    async function resetDisabledPwmRuntime() {
      calls.push({ type: 'runtime-reset' });
      pwmRuntimeRevision += 1;
    }
    async function requestTimerBasedShutdown() {
      calls.push({ type: 'shutdown' });
      return { success: true };
    }
    async function rescheduleSmartWeatherAlarm() {
      calls.push({ type: 'smart-weather' });
    }
    function appendDiagnosticLog() {}
    ${activeBoundaryHandlerSource16}
    ${activeBoundaryHeartbeatSource16}
    async function loadScheduleFromStorage() {
      calls.push({ type: 'storage-load' });
    }
    async function deliverActiveBoundary(
      scheduledTime = currentNowMs,
      alarmName = 'ac-active-boundary'
    ) {
      const alarm = { name: alarmName, scheduledTime };
      await initReady;
      ${scheduleOnlyActiveBoundaryBody16}
      ${phaseSensitiveAlarmGateBody16}
      calls.push({ type: 'gate-passed' });
      return onActiveBoundaryCrossed();
    }
    return {
      deliver: deliverActiveBoundary,
      deliverScheduleRetry: scheduledTime => deliverActiveBoundary(
        scheduledTime,
        ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM
      ),
      deliverOwnerReadRetry: scheduledTime => deliverActiveBoundary(
        scheduledTime,
        ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM
      ),
      run: onActiveBoundaryCrossed,
      arm: armActiveBoundaryRetry,
      heartbeat: runHeartbeat,
      reschedule: rescheduleActiveBoundary,
      complete: completeActiveBoundaryProcessing,
      tryClaim: claimSyncPhaseAdoptionAdmission,
      release: releaseSyncPhaseAdoptionAdmission,
      blocked: isSyncPhaseAdoptionAdmissionBlocked,
      setNow: value => { currentNowMs = Number(value) || currentNowMs; },
      setDeferred: value => {
        activeBoundaryDeferredForPhaseAdoption = value === true;
      },
      setOwnerReadDeferred: value => {
        activeBoundaryOwnerReadDeferred = value === true;
      },
      failNextDurableReads: count => {
        durableReadFailuresRemaining += Math.max(0, Number(count) || 0);
      },
      setActiveHoursEnabled: value => {
        schedule.activeHours = {
          ...(schedule.activeHours || {}),
          enabled: value === true
        };
      },
      holdMutation: (gate, onStart = null) =>
        runSerializedActiveBoundaryMutation(async () => {
          calls.push({ type: 'mutation-hold-start' });
          if (typeof onStart === 'function') onStart();
          await gate;
          calls.push({ type: 'mutation-hold-end' });
          return true;
        }),
      replaceRetryOwner: ({ retryAt, mode, boundaryAt = 0 }) => {
        durable[ACTIVE_BOUNDARY_RETRY_KEY] = Number(retryAt) || 0;
        durable[ACTIVE_BOUNDARY_RETRY_MODE_KEY] = String(mode || '');
        durable[ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY] =
          Number(boundaryAt) || 0;
        calls.push({ type: 'owner-replaced', retryAt: Number(retryAt) || 0,
          mode: String(mode || ''), boundaryAt: Number(boundaryAt) || 0 });
      },
      setActiveBoundaryAlarm: scheduledTime => {
        alarms.set('ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: Number(scheduledTime) || 0
        });
      },
      setScheduleRetryAlarm: scheduledTime => {
        alarms.set(ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM, {
          name: ACTIVE_BOUNDARY_SCHEDULE_RETRY_ALARM,
          scheduledTime: Number(scheduledTime) || 0
        });
      },
      setOwnerReadRetryAlarm: scheduledTime => {
        alarms.set(ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM, {
          name: ACTIVE_BOUNDARY_OWNER_READ_RETRY_ALARM,
          scheduledTime: Number(scheduledTime) || 0
        });
      },
      revision: () => pwmRuntimeRevision,
      completionGeneration: () => activeBoundaryCompletionGeneration,
      deferred: () => activeBoundaryDeferredForPhaseAdoption,
      ownerReadDeferred: () => activeBoundaryOwnerReadDeferred,
      retryAt: () => Number(durable[ACTIVE_BOUNDARY_RETRY_KEY]) || 0,
      retryMode: () => String(
        durable[ACTIVE_BOUNDARY_RETRY_MODE_KEY] || ''
      ),
      retryBoundaryAt: () => Number(
        durable[ACTIVE_BOUNDARY_RETRY_BOUNDARY_KEY]
      ) || 0,
      alarmAt: name => Number(alarms.get(name)?.scheduledTime) || 0,
      snapshot: () => structuredClone(schedule),
      durable,
      alarms,
      calls
    };`
  )(
    nowMs,
    harnessOptions,
    sharedState,
    testConsole,
    Date,
    callback => { callback(); return 0; }
  );

  const ownedBoundaryNow16 = new Date(2026, 7, 28, 20, 0, 0, 0).getTime();
  const ownedBoundaryNaturalAt16 = ownedBoundaryNow16 + 30 * 60_000;
  const ownedBoundarySetupAt16 = ownedBoundaryNow16 + 5 * 60_000;
  let releaseOwnedBoundaryPersist16;
  let markOwnedBoundaryPersistStarted16;
  const ownedBoundaryPersistGate16 = new Promise(resolve => {
    releaseOwnedBoundaryPersist16 = resolve;
  });
  const ownedBoundaryPersistStarted16 = new Promise(resolve => {
    markOwnedBoundaryPersistStarted16 = resolve;
  });
  const ownedBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      setupClockAt: ownedBoundarySetupAt16,
      persistGate: ownedBoundaryPersistGate16,
      onPersistStart: markOwnedBoundaryPersistStarted16
    }
  );
  const ownedBoundaryDelivery16 = ownedBoundaryHarness16.deliver();
  await ownedBoundaryPersistStarted16;
  const concurrentSyncClaim16 = ownedBoundaryHarness16.tryClaim();
  const concurrentPageClaim16 = ownedBoundaryHarness16.tryClaim();
  const ownedBoundaryHeldClock16 = ownedBoundaryHarness16.alarmAt(
    'ac-active-boundary'
  );
  const ownedBoundaryCallsWhileHeld16 = ownedBoundaryHarness16.calls.slice();
  releaseOwnedBoundaryPersist16();
  const ownedBoundaryResult16 = await ownedBoundaryDelivery16;
  const ownedBoundarySetupCall16 = ownedBoundaryHarness16.calls.find(call =>
    call.type === 'setup');
  assertPass(activeBoundaryHandlerSource16.includes(
      'const phaseAdmissionEpoch = claimSyncPhaseAdoptionAdmission();')
      && activeBoundaryHandlerSource16.includes(
        "await armActiveBoundaryRetry('active-boundary 处理')")
      && activeBoundaryHandlerSource16.includes(
        'setupAlarms(true, { phaseAdmissionEpoch })')
      && setupAlarmsBody16.includes('phaseAdmissionEpoch = Number(options.phaseAdmissionEpoch) || 0')
      && setupAlarmsBody16.includes('phaseAdmissionEpoch,')
      && setupAlarmsBody16.includes(
        'return hasDurableLivePwmOwner(pwmRuntimeRevision);')
      && ownedBoundaryHeldClock16 === ownedBoundaryNow16 + 60_000
      && concurrentSyncClaim16 === 0
      && concurrentPageClaim16 === 0
      && !ownedBoundaryCallsWhileHeld16.some(call =>
        call.type === 'setup'
          || (call.type === 'alarm-clear'
            && call.name === 'ac-active-boundary'))
      && ownedBoundaryResult16 === true
      && ownedBoundarySetupCall16?.startImmediately === true
      && ownedBoundarySetupCall16?.options.phaseAdmissionEpoch === 1
      && ownedBoundaryHarness16.blocked() === false
      && ownedBoundaryHarness16.retryAt() === 0
      && ownedBoundaryHarness16.alarmAt('ac-pwm') === ownedBoundarySetupAt16
      && ownedBoundaryHarness16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16
      && !ownedBoundaryHarness16.calls.some(call =>
        call.type === 'runtime-reset'),
    '16F-0B-1E-0D-3: active-boundary second gate 后自持 phase reservation；durable retry 先布防，persist await 中 sync/page 均无法 claim，setup token 收口后才消费 marker');

  const restartRetryAt16 = ownedBoundaryNow16 + 60_000;
  const restartActiveBoundaryState16 = {
    durable: {
      ac_active_boundary_retry_at: restartRetryAt16,
      ac_schedule: null
    },
    alarms: new Map([
      ['ac-active-boundary', {
        name: 'ac-active-boundary',
        scheduledTime: restartRetryAt16
      }]
    ])
  };
  const restartedBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { naturalBoundaryAt: ownedBoundaryNaturalAt16 },
    restartActiveBoundaryState16
  );
  const restartedBoundaryAt16 = await restartedBoundaryHarness16.reschedule();
  assertPass(initBody13.includes('rescheduleActiveBoundary();')
      && restartedBoundaryHarness16.deferred() === true
      && restartedBoundaryAt16 === restartRetryAt16
      && restartedBoundaryHarness16.retryAt() === restartRetryAt16
      && restartedBoundaryHarness16.alarmAt('ac-active-boundary')
        === restartRetryAt16
      && !restartedBoundaryHarness16.calls.some(call =>
        call.type === 'alarm-clear'
          || (call.type === 'create'
            && call.info.when === ownedBoundaryNaturalAt16)),
    '16F-0B-1E-0D-4: SW 重启后内存 flag 清零，但 durable key + live 1min 使 init/reschedule 原样保留 retry，不覆盖自然边界');

  const successfulRetryState16 = {
    durable: {
      ac_active_boundary_retry_at: restartRetryAt16,
      ac_schedule: null
    },
    alarms: new Map([
      ['ac-active-boundary', {
        name: 'ac-active-boundary',
        scheduledTime: restartRetryAt16
      }]
    ])
  };
  const successfulBoundaryRetry16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      comfortStartActive: true
    },
    successfulRetryState16
  );
  const successfulBoundaryRetryResult16 = await successfulBoundaryRetry16.run();
  assertPass(successfulBoundaryRetryResult16 === true
      && successfulBoundaryRetry16.retryAt() === 0
      && successfulBoundaryRetry16.deferred() === false
      && successfulBoundaryRetry16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16,
    '16F-0B-1E-0D-5: active-boundary retry 处理完整成功后才清 durable marker，并切回下一自然边界');

  const failedBoundaryRetry16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      setupFails: true
    }
  );
  let failedBoundaryRetryRejected16 = false;
  try {
    await failedBoundaryRetry16.run();
  } catch (_) {
    failedBoundaryRetryRejected16 = true;
  }
  await failedBoundaryRetry16.reschedule();
  const markerClearFailureRetry16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      comfortStartActive: true,
      failMarkerClear: true
    }
  );
  let markerClearFailureRejected16 = false;
  try {
    await markerClearFailureRetry16.run();
  } catch (_) {
    markerClearFailureRejected16 = true;
  }
  await markerClearFailureRetry16.reschedule();
  assertPass(failedBoundaryRetryRejected16
      && failedBoundaryRetry16.retryAt() > ownedBoundaryNow16
      && failedBoundaryRetry16.retryAt() <= ownedBoundaryNow16 + 60_000
      && failedBoundaryRetry16.alarmAt('ac-active-boundary')
        === failedBoundaryRetry16.retryAt()
      && markerClearFailureRejected16
      && markerClearFailureRetry16.calls.filter(call =>
        call.type === 'marker-clear-failure').length === 1
      && markerClearFailureRetry16.retryAt() > ownedBoundaryNow16
      && markerClearFailureRetry16.retryMode() === 'schedule'
      && markerClearFailureRetry16.alarmAt(
        'ac-active-boundary-schedule-retry'
      )
        === markerClearFailureRetry16.retryAt()
      && ![failedBoundaryRetry16, markerClearFailureRetry16].some(harness =>
        harness.calls.some(call =>
          call.type === 'create'
            && call.info.when === ownedBoundaryNaturalAt16)),
    '16F-0B-1E-0D-6: active-boundary 动作失败或 marker clear 失败均保留 durable/live 1min retry，不误排自然边界');

  const nearNaturalAt16 = ownedBoundaryNow16 + 45_000;
  const nearNaturalState16 = {
    durable: {
      ac_active_boundary_retry_at: 0,
      ac_schedule: null
    },
    alarms: new Map([
      ['ac-active-boundary', {
        name: 'ac-active-boundary',
        scheduledTime: nearNaturalAt16
      }]
    ])
  };
  const nearNaturalBoundary16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { naturalBoundaryAt: nearNaturalAt16 },
    nearNaturalState16
  );
  const nearNaturalResult16 = await nearNaturalBoundary16.reschedule();
  assertPass(nearNaturalResult16 === nearNaturalAt16
      && nearNaturalBoundary16.deferred() === false
      && nearNaturalBoundary16.retryAt() === 0
      && nearNaturalBoundary16.alarmAt('ac-active-boundary')
        === nearNaturalAt16
      && !nearNaturalBoundary16.calls.some(call =>
        call.type === 'alarm-clear' || call.type === 'create')
      && nearNaturalBoundary16.calls.filter(call =>
        call.type === 'durable-set'
          && Number(call.value.ac_active_boundary_retry_at) > 0).length === 0,
    '16F-0B-1E-0D-7: 距今不足一分钟但与自然 active-hours 边界对齐的 live alarm 不会被误判为 retry marker');

  const crossingBoundaryStart16 = new Date(
    2026, 7, 29, 7, 59, 59, 999
  ).getTime();
  const crossingBoundaryAt16 = new Date(
    2026, 7, 29, 8, 0, 0, 0
  ).getTime();
  let releaseActiveBoundaryClear16;
  let markActiveBoundaryClearStarted16;
  const activeBoundaryClearGate16 = new Promise(resolve => {
    releaseActiveBoundaryClear16 = resolve;
  });
  const activeBoundaryClearStarted16 = new Promise(resolve => {
    markActiveBoundaryClearStarted16 = resolve;
  });
  const crossingBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    crossingBoundaryStart16,
    {
      naturalBoundaryAt: crossingBoundaryAt16,
      activeBoundaryClearGate: activeBoundaryClearGate16,
      onActiveBoundaryClearStart: markActiveBoundaryClearStarted16
    }
  );
  const crossingBoundarySchedule16 = crossingBoundaryHarness16.reschedule();
  await activeBoundaryClearStarted16;
  crossingBoundaryHarness16.setNow(crossingBoundaryAt16 + 1);
  releaseActiveBoundaryClear16();
  const crossingBoundaryResult16 = await crossingBoundarySchedule16;
  assertPass(activeBoundaryPhaseCoordinatorSource16.includes(
      'const naturalBoundaryAt = getNextActiveBoundary(new Date(now));')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'if (naturalBoundaryAt <= Date.now() + PWM_RETRY_ALARM_TOLERANCE_MS)')
      && crossingBoundaryHarness16.calls.filter(call =>
        call.type === 'natural-boundary-read').length === 1
      && crossingBoundaryResult16 === crossingBoundaryAt16 + 60_001
      && crossingBoundaryHarness16.retryAt()
        === crossingBoundaryAt16 + 60_001
      && crossingBoundaryHarness16.alarmAt('ac-active-boundary')
        === crossingBoundaryAt16 + 60_001
      && !crossingBoundaryHarness16.calls.some(call =>
        call.type === 'create' && call.info.when === crossingBoundaryAt16),
    '16F-0B-1E-0D-8: 07:59:59.999 捕获 08:00 边界后，clear await 跨界不重算到下个 start/end；转 durable/live +1min 幂等重放');

  const rejectedActiveBoundaryCreate16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { activeBoundaryCreateResults: [false, false] }
  );
  let rejectedActiveBoundaryCreateError16 = '';
  try {
    await rejectedActiveBoundaryCreate16.arm('two failed creates');
  } catch (error) {
    rejectedActiveBoundaryCreateError16 = error?.message || String(error);
  }
  const rejectedActiveBoundaryCreates16 =
    rejectedActiveBoundaryCreate16.calls.filter(call =>
      call.type === 'create' && call.name === 'ac-active-boundary');
  assertPass(activeBoundaryPhaseCoordinatorSource16.includes(
      'for (let attempt = 0; attempt < 2; attempt += 1)')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        "throw new Error('ac-active-boundary 重试闹钟创建后验证失败')")
      && rejectedActiveBoundaryCreateError16.includes('创建后验证失败')
      && rejectedActiveBoundaryCreates16.length === 2
      && rejectedActiveBoundaryCreates16.every(call =>
        call.verified === false)
      && rejectedActiveBoundaryCreate16.deferred() === true
      && rejectedActiveBoundaryCreate16.retryAt()
        === ownedBoundaryNow16 + 60_000
      && rejectedActiveBoundaryCreate16.alarmAt('ac-active-boundary') === 0,
    '16F-0B-1E-0D-9: active-boundary create 连续两次验证失败时 arm 明确抛错；durable marker/flag 保留且绝不假报 live 已收口');

  const naturalCreateFallback16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      comfortStartActive: true,
      activeBoundaryCreateResults: [true, false, false, true]
    }
  );
  const naturalCreateFallbackResult16 = await naturalCreateFallback16.run();
  const naturalCreateFallbackCalls16 = naturalCreateFallback16.calls.filter(
    call => call.type === 'create'
      && (call.name === 'ac-active-boundary'
        || call.name === 'ac-active-boundary-schedule-retry')
  );
  assertPass(naturalCreateFallbackResult16 === true
      && naturalCreateFallbackCalls16.map(call => call.verified).join(',')
        === 'true,false,false,true'
      && naturalCreateFallbackCalls16.filter(call =>
        call.info.when === ownedBoundaryNaturalAt16).length === 2
      && naturalCreateFallback16.deferred() === true
      && naturalCreateFallback16.retryAt()
        === ownedBoundaryNow16 + 60_000
      && naturalCreateFallback16.retryMode() === 'schedule'
      && naturalCreateFallback16.retryBoundaryAt()
        === ownedBoundaryNaturalAt16
      && naturalCreateFallback16.alarmAt(
        'ac-active-boundary-schedule-retry'
      )
        === ownedBoundaryNow16 + 60_000,
    '16F-0B-1E-0D-10: handler 成功消费旧 marker 后，自然边界 create false/false 会重新落 durable marker 并建立验证通过的 +1min retry');

  const heartbeatRetryAt16 = ownedBoundaryNow16 + 60_000;
  const heartbeatRecovery16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { naturalBoundaryAt: ownedBoundaryNaturalAt16 },
    {
      durable: {
        ac_active_boundary_retry_at: heartbeatRetryAt16,
        ac_schedule: null
      },
      alarms: new Map()
    }
  );
  heartbeatRecovery16.setDeferred(true);
  await heartbeatRecovery16.heartbeat();
  assertPass(activeBoundaryHeartbeatSource16.includes(
      'if (activeBoundaryDeferredForPhaseAdoption)')
      && activeBoundaryHeartbeatSource16.includes(
        "chrome.alarms.get('ac-active-boundary'),")
      && activeBoundaryHeartbeatSource16.includes(
        'Math.abs(liveAt - durableRetryAt)')
      && activeBoundaryHeartbeatSource16.includes(
        'await rescheduleActiveBoundary();')
      && heartbeatRecovery16.deferred() === true
      && heartbeatRecovery16.retryAt() === heartbeatRetryAt16
      && heartbeatRecovery16.alarmAt('ac-active-boundary')
        === heartbeatRetryAt16
      && heartbeatRecovery16.calls.some(call =>
        call.type === 'create'
          && call.name === 'ac-active-boundary'
          && call.verified === true),
    '16F-0B-1E-0D-11: deferred flag=true 且 live retry 缺失时，20s heartbeat 从 durable marker 恢复经验证的 ac-active-boundary');

  let releaseSerializedNaturalRead16;
  let markSerializedNaturalReadStarted16;
  const serializedNaturalReadGate16 = new Promise(resolve => {
    releaseSerializedNaturalRead16 = resolve;
  });
  const serializedNaturalReadStarted16 = new Promise(resolve => {
    markSerializedNaturalReadStarted16 = resolve;
  });
  const serializedNaturalAt16 = ownedBoundaryNow16 + 30 * 60_000;
  const serializedRetryAt16 = ownedBoundaryNow16 + 60_000;
  const serializedBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: serializedNaturalAt16,
      activeBoundaryDurableReadGate: serializedNaturalReadGate16,
      onActiveBoundaryDurableReadStart: markSerializedNaturalReadStarted16
    }
  );
  const serializedNaturalSchedule16 = serializedBoundaryHarness16.reschedule();
  await serializedNaturalReadStarted16;
  const serializedFailureRetry16 = serializedBoundaryHarness16.arm(
    'serialized failure path'
  );
  await Promise.resolve();
  const serializedFailureStayedQueued16 =
    serializedBoundaryHarness16.retryAt() === 0
    && !serializedBoundaryHarness16.calls.some(call =>
      call.type === 'create' && call.name === 'ac-active-boundary');
  releaseSerializedNaturalRead16();
  const [serializedNaturalResult16, serializedRetryResult16]
    = await Promise.all([
      serializedNaturalSchedule16,
      serializedFailureRetry16
    ]);
  const serializedBoundaryCreates16 = serializedBoundaryHarness16.calls.filter(
    call => call.type === 'create' && call.name === 'ac-active-boundary'
  );
  assertPass(activeBoundaryPhaseCoordinatorSource16.includes(
      'function runSerializedActiveBoundaryMutation(operation)')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'activeBoundaryMutationChain = queued.catch(() => {});')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'function rescheduleActiveBoundary(options = {})')
      && serializedFailureStayedQueued16
      && serializedNaturalResult16 === serializedNaturalAt16
      && serializedRetryResult16 === serializedRetryAt16
      && serializedBoundaryCreates16.map(call => call.info.when).join(',')
        === `${serializedNaturalAt16},${serializedRetryAt16}`
      && serializedBoundaryHarness16.retryAt() === serializedRetryAt16
      && serializedBoundaryHarness16.alarmAt('ac-active-boundary')
        === serializedRetryAt16,
    '16F-0B-1E-0D-12: 同名 active-boundary mutation 串行；旧自然调度读 marker=0 暂停时 failure B 只能排队，最终 durable/live 均为 B，不会把自然 A 误验为成功终态');

  const wrongSameNameAt16 = ownedBoundaryNow16 + 30 * 60_000;
  const wrongSameNameHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      activeBoundaryCreatedTimes: [wrongSameNameAt16, wrongSameNameAt16]
    }
  );
  let wrongSameNameError16 = '';
  try {
    await wrongSameNameHarness16.arm('wrong same-name timestamp');
  } catch (error) {
    wrongSameNameError16 = error?.message || String(error);
  }
  const wrongSameNameCreates16 = wrongSameNameHarness16.calls.filter(call =>
    call.type === 'create' && call.name === 'ac-active-boundary');
  assertPass(activeBoundaryPhaseCoordinatorSource16.includes(
      'const verified = await chrome.alarms.get(alarmName);')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'Math.abs(Number(verified?.scheduledTime) - Number(when))')
      && wrongSameNameError16.includes('创建后验证失败')
      && wrongSameNameCreates16.length === 2
      && wrongSameNameCreates16.every(call =>
        call.scheduledTime === serializedRetryAt16
          && call.storedScheduledTime === wrongSameNameAt16)
      && wrongSameNameHarness16.retryAt() === serializedRetryAt16
      && wrongSameNameHarness16.alarmAt('ac-active-boundary')
        === wrongSameNameAt16,
    '16F-0B-1E-0D-13: createActiveBoundaryAlarmWithRetry 精确核验 scheduledTime；同名 alarm 若仍是 A，连续两次也不得冒充目标 B 成功');

  const mismatchedHeartbeatNaturalAt16 = ownedBoundaryNow16 + 30 * 60_000;
  const mismatchedHeartbeatHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { naturalBoundaryAt: mismatchedHeartbeatNaturalAt16 },
    {
      durable: {
        ac_active_boundary_retry_at: heartbeatRetryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: mismatchedHeartbeatNaturalAt16
        }]
      ])
    }
  );
  mismatchedHeartbeatHarness16.setDeferred(true);
  await mismatchedHeartbeatHarness16.heartbeat();
  assertPass(mismatchedHeartbeatHarness16.retryAt() === heartbeatRetryAt16
      && mismatchedHeartbeatHarness16.alarmAt('ac-active-boundary')
        === heartbeatRetryAt16
      && mismatchedHeartbeatHarness16.calls.some(call =>
        call.type === 'alarm-clear'
          && call.name === 'ac-active-boundary')
      && mismatchedHeartbeatHarness16.calls.some(call =>
        call.type === 'create'
          && call.name === 'ac-active-boundary'
          && call.info.when === heartbeatRetryAt16),
    '16F-0B-1E-0D-14: heartbeat 不只检查同名钟存在；liveAt 与 durable marker 不符时会清理 A 并精确恢复 B');

  const overdueBoundaryNow16 = new Date(
    2026, 7, 29, 8, 0, 5, 0
  ).getTime();
  const overdueBoundaryEvent16 = new Date(
    2026, 7, 29, 8, 0, 0, 0
  ).getTime();
  const overdueBoundaryNaturalAt16 = new Date(
    2026, 7, 29, 23, 0, 0, 0
  ).getTime();
  const overdueBoundaryRetryAt16 = overdueBoundaryNow16 + 60_000;
  const overdueBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    overdueBoundaryNow16,
    { naturalBoundaryAt: overdueBoundaryNaturalAt16 },
    {
      durable: {
        ac_active_boundary_retry_at: 0,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: overdueBoundaryEvent16
        }]
      ])
    }
  );
  const overdueBoundaryResult16 = await overdueBoundaryHarness16.reschedule();
  assertPass(activeBoundaryPhaseCoordinatorSource16.includes(
      'const overdueBoundaryPending = !consumePending')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        '|| overdueBoundaryPending')
      && overdueBoundaryResult16 === overdueBoundaryRetryAt16
      && overdueBoundaryHarness16.deferred() === true
      && overdueBoundaryHarness16.retryAt() === overdueBoundaryRetryAt16
      && overdueBoundaryHarness16.alarmAt('ac-active-boundary')
        === overdueBoundaryRetryAt16
      && !overdueBoundaryHarness16.calls.some(call =>
        call.type === 'create'
          && call.info.when === overdueBoundaryNaturalAt16),
    '16F-0B-1E-0D-15: 08:00:05 看到刚过期 08:00/live 且 marker=0 时转 durable +1min replay，不清掉事件后跳到 23:00');

  const completeBoundaryState16 = {
    durable: {
      ac_active_boundary_retry_at: heartbeatRetryAt16,
      ac_schedule: null
    },
    alarms: new Map([
      ['ac-active-boundary', {
        name: 'ac-active-boundary',
        scheduledTime: heartbeatRetryAt16
      }]
    ])
  };
  const completeBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { naturalBoundaryAt: ownedBoundaryNaturalAt16 },
    completeBoundaryState16
  );
  completeBoundaryHarness16.setDeferred(true);
  const completeBoundaryResult16 = await completeBoundaryHarness16.complete();
  assertPass(activeBoundaryPhaseCoordinatorSource16.includes(
      'function completeActiveBoundaryProcessing(options = {})')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'if (!await clearActiveBoundaryRetryMarkerUnsafe())')
      && activeBoundaryPhaseCoordinatorSource16.includes(
        'return await rescheduleActiveBoundaryUnsafe({ consumePending: true });')
      && completeBoundaryResult16 === ownedBoundaryNaturalAt16
      && completeBoundaryHarness16.deferred() === false
      && completeBoundaryHarness16.retryAt() === 0
      && completeBoundaryHarness16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16
      && completeBoundaryHarness16.calls.filter(call =>
        call.type === 'create'
          && call.info.when === ownedBoundaryNaturalAt16).length === 1,
    '16F-0B-1E-0D-16: completeActiveBoundaryProcessing 在同一 mutation transaction 内清 marker 并恢复经核验的自然边界');

  const scheduleOnlyFallbackHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      setupClockAt: ownedBoundarySetupAt16,
      activeBoundaryCreateResults: [true, false, false, true]
    }
  );
  const scheduleOnlyFallbackRun16 = await scheduleOnlyFallbackHarness16.run();
  const scheduleOnlyFallbackRetryAt16 =
    scheduleOnlyFallbackHarness16.retryAt();
  const scheduleOnlyFallbackSetupAt16 =
    scheduleOnlyFallbackHarness16.alarmAt('ac-pwm');
  const scheduleOnlyFallbackResult16 =
    await scheduleOnlyFallbackHarness16.deliverScheduleRetry(
      scheduleOnlyFallbackRetryAt16
    );
  assertPass(scheduleOnlyFallbackRun16 === true
      && scheduleOnlyFallbackResult16 === undefined
      && scheduleOnlyFallbackHarness16.calls.filter(call =>
        call.type === 'setup').length === 1
      && scheduleOnlyFallbackHarness16.alarmAt('ac-pwm')
        === scheduleOnlyFallbackSetupAt16
      && scheduleOnlyFallbackSetupAt16 === ownedBoundarySetupAt16
      && scheduleOnlyFallbackHarness16.retryAt() === 0
      && scheduleOnlyFallbackHarness16.retryMode() === ''
      && scheduleOnlyFallbackHarness16.retryBoundaryAt() === 0
      && scheduleOnlyFallbackHarness16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0
      && scheduleOnlyFallbackHarness16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16,
    '16F-0B-1E-0D-17: setup 已成功但自然钟两次失败时落 schedule-only retry；精确 +1min delivery 只补自然钟，setup 总数与 PWM owner 均不后移');

  let releaseCompletionRescheduleClear16;
  let markCompletionRescheduleClearStarted16;
  const completionRescheduleClearGate16 = new Promise(resolve => {
    releaseCompletionRescheduleClear16 = resolve;
  });
  const completionRescheduleClearStarted16 = new Promise(resolve => {
    markCompletionRescheduleClearStarted16 = resolve;
  });
  const completionQueuedDeferRetryAt16 = ownedBoundaryNow16 + 60_000;
  const completionQueuedDeferHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      activeBoundaryClearGate: completionRescheduleClearGate16,
      onActiveBoundaryClearStart: markCompletionRescheduleClearStarted16
    },
    {
      durable: {
        ac_active_boundary_retry_at: completionQueuedDeferRetryAt16,
        ac_active_boundary_retry_mode: 'action',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: completionQueuedDeferRetryAt16
        }]
      ])
    }
  );
  completionQueuedDeferHarness16.setDeferred(true);
  const completionWhileDeferred16 = completionQueuedDeferHarness16.complete();
  await completionRescheduleClearStarted16;
  const completionGenerationBeforeSettle16 =
    completionQueuedDeferHarness16.completionGeneration();
  const completionPhaseClaim16 = completionQueuedDeferHarness16.tryClaim();
  const queuedOldBoundaryDelivery16 = completionQueuedDeferHarness16.deliver(
    completionQueuedDeferRetryAt16
  );
  await Promise.resolve();
  await Promise.resolve();
  releaseCompletionRescheduleClear16();
  const [completionWhileDeferredResult16] = await Promise.all([
    completionWhileDeferred16,
    queuedOldBoundaryDelivery16
  ]);
  completionQueuedDeferHarness16.release(completionPhaseClaim16);
  const completionMarkerWritesAfterClear16 =
    completionQueuedDeferHarness16.calls.filter((call, index, calls) => {
      if (call.type !== 'durable-set'
          || Number(call.value.ac_active_boundary_retry_at) <= 0) return false;
      const clearIndex = calls.findIndex(item =>
        item.type === 'durable-set'
          && item.value.ac_active_boundary_retry_at === 0);
      return clearIndex >= 0 && index > clearIndex;
    });
  assertPass(completionGenerationBeforeSettle16 === 0
      && completionWhileDeferredResult16 === ownedBoundaryNaturalAt16
      && completionQueuedDeferHarness16.completionGeneration() === 1
      && completionMarkerWritesAfterClear16.length === 0
      && completionQueuedDeferHarness16.retryAt() === 0
      && completionQueuedDeferHarness16.retryMode() === ''
      && completionQueuedDeferHarness16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16
      && completionQueuedDeferHarness16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0,
    '16F-0B-1E-0D-18: complete 卡在 reschedule clear await 时 delivery 才排入 defer；generation 在全部 await settle 后提交，旧 defer 排到链尾只能 no-op');

  const markerClearScheduleOnlyHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      setupClockAt: ownedBoundarySetupAt16,
      failMarkerClear: true
    }
  );
  let markerClearScheduleOnlyRejected16 = false;
  try {
    await markerClearScheduleOnlyHarness16.run();
  } catch (_) {
    markerClearScheduleOnlyRejected16 = true;
  }
  const markerClearScheduleRetryAt16 =
    markerClearScheduleOnlyHarness16.retryAt();
  const markerClearStablePwmAt16 =
    markerClearScheduleOnlyHarness16.alarmAt('ac-pwm');
  await markerClearScheduleOnlyHarness16.deliverScheduleRetry(
    markerClearScheduleRetryAt16
  );
  assertPass(markerClearScheduleOnlyRejected16
      && markerClearScheduleOnlyHarness16.calls.filter(call =>
        call.type === 'setup').length === 1
      && markerClearScheduleOnlyHarness16.alarmAt('ac-pwm')
        === markerClearStablePwmAt16
      && markerClearStablePwmAt16 === ownedBoundarySetupAt16
      && markerClearScheduleOnlyHarness16.retryAt() === 0
      && markerClearScheduleOnlyHarness16.retryMode() === ''
      && markerClearScheduleOnlyHarness16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16
      && markerClearScheduleOnlyHarness16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0,
    '16F-0B-1E-0D-19: 动作完成后的 marker clear 首次失败转 schedule mode；下次 retry 仅补自然钟，不重跑 setupAlarms');

  const disabledBoundaryEvent16 = ownedBoundaryNow16 - 5_000;
  const disabledPwmOwnerAt16 = ownedBoundaryNow16 + 17 * 60_000;
  const disabledBoundarySchedule16 = {
    enabled: true,
    pwmState: 'off',
    nextTriggerAt: disabledPwmOwnerAt16,
    smartOnBoundaryAt: ownedBoundaryNow16 - 30 * 60_000,
    smartMode: { enabled: true, sensitivity: 5 },
    activeHours: { enabled: false, start: '08:00', end: '23:00' }
  };
  const disabledBoundaryHarness16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      schedule: disabledBoundarySchedule16
    },
    {
      durable: {
        ac_active_boundary_retry_at: disabledBoundaryEvent16,
        ac_active_boundary_retry_mode: 'action',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: structuredClone(disabledBoundarySchedule16)
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: disabledBoundaryEvent16
        }],
        ['ac-pwm', {
          name: 'ac-pwm',
          scheduledTime: disabledPwmOwnerAt16
        }]
      ])
    }
  );
  const disabledSnapshotBefore16 = disabledBoundaryHarness16.snapshot();
  const disabledRescheduleResult16 = await disabledBoundaryHarness16.reschedule();
  disabledBoundaryHarness16.replaceRetryOwner({
    retryAt: disabledBoundaryEvent16,
    mode: 'action'
  });
  disabledBoundaryHarness16.setActiveBoundaryAlarm(disabledBoundaryEvent16);
  await disabledBoundaryHarness16.deliver(disabledBoundaryEvent16);
  assertPass(disabledRescheduleResult16 === true
      && JSON.stringify(disabledBoundaryHarness16.snapshot())
        === JSON.stringify(disabledSnapshotBefore16)
      && disabledBoundaryHarness16.alarmAt('ac-pwm')
        === disabledPwmOwnerAt16
      && disabledBoundaryHarness16.retryAt() === 0
      && disabledBoundaryHarness16.alarmAt('ac-active-boundary') === 0
      && disabledBoundaryHarness16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0
      && !disabledBoundaryHarness16.calls.some(call =>
        call.type === 'setup'
          || call.type === 'runtime-reset'
          || call.type === 'shutdown'),
    '16F-0B-1E-0D-20: activeHours=false 时 overdue boundary 的 reschedule 与 handler 均只清 retry 基础设施；不 setup/reset/shutdown，也不改 smart/PWM owner');

  const exactScheduleRetryAt16 = ownedBoundaryNow16 + 60_000;
  const exactScheduleBoundaryAt16 = ownedBoundaryNow16 + 30 * 60_000;
  const mismatchedScheduleDelivery16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { naturalBoundaryAt: exactScheduleBoundaryAt16 },
    {
      durable: {
        ac_active_boundary_retry_at: exactScheduleRetryAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: exactScheduleBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: exactScheduleRetryAt16
        }]
      ])
    }
  );
  await mismatchedScheduleDelivery16.deliverScheduleRetry(
    exactScheduleRetryAt16 + 5 * 60_000
  );
  assertPass(mismatchedScheduleDelivery16.retryAt()
      === exactScheduleRetryAt16
      && mismatchedScheduleDelivery16.retryMode() === 'schedule'
      && mismatchedScheduleDelivery16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === exactScheduleRetryAt16
      && !mismatchedScheduleDelivery16.calls.some(call =>
        call.type === 'setup'
          || (call.type === 'durable-set'
            && call.value.ac_active_boundary_retry_at === 0)),
    '16F-0B-1E-0D-21: schedule-only delivery 仅在 scheduledTime 精确拥有 durable retryAt 时分流；较晚同名 stale event 不得清当前 owner');

  const crossedScheduleRetryAt16 = ownedBoundaryNow16 + 60_000;
  const crossedCapturedBoundaryAt16 = ownedBoundaryNow16 + 90_000;
  const crossedScheduleRetry16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      setupClockAt: ownedBoundarySetupAt16
    },
    {
      durable: {
        ac_active_boundary_retry_at: crossedScheduleRetryAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: crossedCapturedBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: crossedScheduleRetryAt16
        }]
      ])
    }
  );
  crossedScheduleRetry16.setNow(ownedBoundaryNow16 + 2 * 60_000);
  await crossedScheduleRetry16.deliverScheduleRetry(crossedScheduleRetryAt16);
  assertPass(crossedScheduleRetry16.calls.filter(call =>
      call.type === 'setup').length === 1
      && crossedScheduleRetry16.alarmAt('ac-pwm') === ownedBoundarySetupAt16
      && crossedScheduleRetry16.retryAt() === 0
      && crossedScheduleRetry16.retryMode() === ''
      && crossedScheduleRetry16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16
      && crossedScheduleRetry16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0,
    '16F-0B-1E-0D-22: schedule retry 若跨过 captured natural boundary 才升级为 action delivery；迟到后会执行一次边界动作而非只补钟');

  const unreadableActionRetryAt16 = ownedBoundaryNow16 + 20_000;
  const unreadableScheduleRetryAt16 = ownedBoundaryNow16 + 25_000;
  const unreadableActionDelivery16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    { activeBoundaryDurableReadFailures: 1 },
    {
      durable: {
        ac_active_boundary_retry_at: unreadableActionRetryAt16,
        ac_active_boundary_retry_mode: 'action',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: unreadableActionRetryAt16
        }]
      ])
    }
  );
  const unreadableScheduleDelivery16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      activeBoundaryDurableReadFailures: 1,
      naturalBoundaryAt: exactScheduleBoundaryAt16
    },
    {
      durable: {
        ac_active_boundary_retry_at: unreadableScheduleRetryAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: exactScheduleBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: unreadableScheduleRetryAt16
        }]
      ])
    }
  );
  await unreadableActionDelivery16.deliver(unreadableActionRetryAt16);
  await unreadableScheduleDelivery16.deliverScheduleRetry(
    unreadableScheduleRetryAt16
  );
  assertPass(unreadableActionDelivery16.retryMode() === 'action'
      && unreadableActionDelivery16.alarmAt('ac-active-boundary')
        === ownedBoundaryNow16 + 60_000
      && unreadableActionDelivery16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0
      && unreadableScheduleDelivery16.retryMode() === 'schedule'
      && unreadableScheduleDelivery16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === ownedBoundaryNow16 + 60_000
      && unreadableScheduleDelivery16.alarmAt('ac-active-boundary') === 0
      && ![unreadableActionDelivery16, unreadableScheduleDelivery16].some(
        harness => harness.calls.some(call => call.type === 'setup')
      ),
    '16F-0B-1E-0D-23: durable mode read 瞬断时不猜 action/schedule；独立 alarm 名保持原类型，各自只延后一分钟且零边界动作');

  const failedScheduleMarkerWrite16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      markerWriteFailures: 1,
      naturalBoundaryAt: exactScheduleBoundaryAt16
    }
  );
  const failedScheduleMarkerRetryAt16 = await failedScheduleMarkerWrite16.arm(
    'schedule marker transient',
    {
      mode: 'schedule',
      boundaryAt: exactScheduleBoundaryAt16
    }
  );
  await failedScheduleMarkerWrite16.deliverScheduleRetry(
    failedScheduleMarkerRetryAt16
  );
  assertPass(failedScheduleMarkerWrite16.calls.filter(call =>
      call.type === 'marker-write-failure').length === 1
      && failedScheduleMarkerWrite16.calls.filter(call =>
        call.type === 'create'
          && call.name === 'ac-active-boundary-schedule-retry').length >= 1
      && !failedScheduleMarkerWrite16.calls.some(call =>
        call.type === 'create' && call.name === 'ac-active-boundary'
          && call.info.when === failedScheduleMarkerRetryAt16)
      && !failedScheduleMarkerWrite16.calls.some(call =>
        call.type === 'setup')
      && failedScheduleMarkerWrite16.retryAt() === 0
      && failedScheduleMarkerWrite16.alarmAt('ac-active-boundary')
        === exactScheduleBoundaryAt16,
    '16F-0B-1E-0D-24: schedule marker 写入瞬断仍只建立独立 schedule typed alarm；markerless delivery 只补自然钟，不降级重跑 action');

  const oldOppositeRetryAt16 = ownedBoundaryNow16 + 20_000;
  const oldActionSurvivesSchedule16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: exactScheduleBoundaryAt16,
      alarmClearFailures: { 'ac-active-boundary': 1 }
    },
    {
      durable: {
        ac_active_boundary_retry_at: oldOppositeRetryAt16,
        ac_active_boundary_retry_mode: 'action',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: oldOppositeRetryAt16
        }]
      ])
    }
  );
  const newScheduleOwnerAt16 = await oldActionSurvivesSchedule16.arm(
    'new schedule owner',
    { mode: 'schedule', boundaryAt: exactScheduleBoundaryAt16 }
  );
  await oldActionSurvivesSchedule16.deliver(oldOppositeRetryAt16);
  const oldScheduleSurvivesAction16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      alarmClearFailures: { 'ac-active-boundary-schedule-retry': 1 }
    },
    {
      durable: {
        ac_active_boundary_retry_at: oldOppositeRetryAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: exactScheduleBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: oldOppositeRetryAt16
        }]
      ])
    }
  );
  const newActionOwnerAt16 = await oldScheduleSurvivesAction16.arm(
    'new action owner',
    { mode: 'action' }
  );
  await oldScheduleSurvivesAction16.deliverScheduleRetry(
    oldOppositeRetryAt16
  );
  assertPass(oldActionSurvivesSchedule16.retryAt() === newScheduleOwnerAt16
      && oldActionSurvivesSchedule16.retryMode() === 'schedule'
      && oldActionSurvivesSchedule16.alarmAt('ac-active-boundary')
        === oldOppositeRetryAt16
      && oldActionSurvivesSchedule16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === newScheduleOwnerAt16
      && oldScheduleSurvivesAction16.retryAt() === newActionOwnerAt16
      && oldScheduleSurvivesAction16.retryMode() === 'action'
      && oldScheduleSurvivesAction16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === oldOppositeRetryAt16
      && oldScheduleSurvivesAction16.alarmAt('ac-active-boundary')
        === newActionOwnerAt16
      && ![oldActionSurvivesSchedule16, oldScheduleSurvivesAction16].some(
        harness => harness.calls.some(call => call.type === 'setup')
      ),
    '16F-0B-1E-0D-25: opposite typed clear 两向失败时，旧 action<新 schedule 与旧 schedule<新 action 的迟到 delivery 均失权且零 mutation');

  const scheduleTakeoverAfterWriteFailure16 =
    createOwnedActiveBoundaryHarness16(
      ownedBoundaryNow16,
      {
        markerWriteFailures: 1,
        naturalBoundaryAt: exactScheduleBoundaryAt16
      },
      {
        durable: {
          ac_active_boundary_retry_at: oldOppositeRetryAt16,
          ac_active_boundary_retry_mode: 'action',
          ac_active_boundary_retry_boundary_at: 0,
          ac_schedule: null
        },
        alarms: new Map([
          ['ac-active-boundary', {
            name: 'ac-active-boundary',
            scheduledTime: oldOppositeRetryAt16
          }]
        ])
      }
    );
  const newerScheduleTypedAt16 =
    await scheduleTakeoverAfterWriteFailure16.arm(
      'new schedule typed owner without marker',
      { mode: 'schedule', boundaryAt: exactScheduleBoundaryAt16 }
    );
  await scheduleTakeoverAfterWriteFailure16.deliverScheduleRetry(
    newerScheduleTypedAt16
  );
  const actionTakeoverAfterWriteFailure16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      markerWriteFailures: 1,
      naturalBoundaryAt: exactScheduleBoundaryAt16,
      setupClockAt: ownedBoundarySetupAt16
    },
    {
      durable: {
        ac_active_boundary_retry_at: oldOppositeRetryAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: exactScheduleBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: oldOppositeRetryAt16
        }]
      ])
    }
  );
  const newerActionTypedAt16 = await actionTakeoverAfterWriteFailure16.arm(
    'new action typed owner without marker',
    { mode: 'action' }
  );
  await actionTakeoverAfterWriteFailure16.deliver(newerActionTypedAt16);
  assertPass(scheduleTakeoverAfterWriteFailure16.calls.filter(call =>
      call.type === 'setup').length === 0
      && scheduleTakeoverAfterWriteFailure16.retryAt() === 0
      && scheduleTakeoverAfterWriteFailure16.alarmAt('ac-active-boundary')
        === exactScheduleBoundaryAt16
      && actionTakeoverAfterWriteFailure16.calls.filter(call =>
        call.type === 'setup').length === 1
      && actionTakeoverAfterWriteFailure16.retryAt() === 0
      && actionTakeoverAfterWriteFailure16.alarmAt('ac-pwm')
        === ownedBoundarySetupAt16,
    '16F-0B-1E-0D-26: marker 写失败时，较旧 durable owner 不压住更晚的新 opposite typed alarm；schedule/action 两向均由新 alarm 类型安全接管');

  let releaseExpectedOwnerQueue16;
  let markExpectedOwnerQueueStarted16;
  let markExpectedOwnerRead16;
  const expectedOwnerQueueGate16 = new Promise(resolve => {
    releaseExpectedOwnerQueue16 = resolve;
  });
  const expectedOwnerQueueStarted16 = new Promise(resolve => {
    markExpectedOwnerQueueStarted16 = resolve;
  });
  const expectedOwnerRead16 = new Promise(resolve => {
    markExpectedOwnerRead16 = resolve;
  });
  const expectedOwnerOldAt16 = ownedBoundaryNow16 + 60_000;
  const expectedOwnerNewAt16 = ownedBoundaryNow16 + 2 * 60_000;
  let expectedOwnerReadNotified16 = false;
  const expectedOwnerRace16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: exactScheduleBoundaryAt16,
      onActiveBoundaryDurableReadReturn: snapshot => {
        if (expectedOwnerReadNotified16) return;
        expectedOwnerReadNotified16 = true;
        markExpectedOwnerRead16(snapshot);
      }
    },
    {
      durable: {
        ac_active_boundary_retry_at: expectedOwnerOldAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: exactScheduleBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: expectedOwnerOldAt16
        }]
      ])
    }
  );
  const expectedOwnerHold16 = expectedOwnerRace16.holdMutation(
    expectedOwnerQueueGate16,
    markExpectedOwnerQueueStarted16
  );
  await expectedOwnerQueueStarted16;
  const expectedOwnerDelivery16 = expectedOwnerRace16.deliverScheduleRetry(
    expectedOwnerOldAt16
  );
  await expectedOwnerRead16;
  expectedOwnerRace16.replaceRetryOwner({
    retryAt: expectedOwnerNewAt16,
    mode: 'schedule',
    boundaryAt: exactScheduleBoundaryAt16
  });
  expectedOwnerRace16.setScheduleRetryAlarm(expectedOwnerNewAt16);
  releaseExpectedOwnerQueue16();
  await Promise.all([expectedOwnerHold16, expectedOwnerDelivery16]);
  assertPass(expectedOwnerRace16.retryAt() === expectedOwnerNewAt16
      && expectedOwnerRace16.retryMode() === 'schedule'
      && expectedOwnerRace16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === expectedOwnerNewAt16
      && !expectedOwnerRace16.calls.some(call =>
        call.type === 'setup'
          || (call.type === 'durable-set'
            && call.value.ac_active_boundary_retry_at === 0)),
    '16F-0B-1E-0D-27: delivery 读到 owner 后、serialized complete 入场前 owner 被替换；expected-owner 二次复检返回 false，绝不清新 marker/alarm');

  let releaseArmActiveHoursFlip16;
  let markArmActiveHoursFlipStarted16;
  const armActiveHoursFlipGate16 = new Promise(resolve => {
    releaseArmActiveHoursFlip16 = resolve;
  });
  const armActiveHoursFlipStarted16 = new Promise(resolve => {
    markArmActiveHoursFlipStarted16 = resolve;
  });
  const armActiveHoursFlip16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      markerWriteGate: armActiveHoursFlipGate16,
      onMarkerWriteStart: markArmActiveHoursFlipStarted16
    }
  );
  const armActiveHoursFlipRun16 = armActiveHoursFlip16.run();
  await armActiveHoursFlipStarted16;
  armActiveHoursFlip16.setActiveHoursEnabled(false);
  releaseArmActiveHoursFlip16();
  const armActiveHoursFlipResult16 = await armActiveHoursFlipRun16;
  let releasePersistActiveHoursFlip16;
  let markPersistActiveHoursFlipStarted16;
  const persistActiveHoursFlipGate16 = new Promise(resolve => {
    releasePersistActiveHoursFlip16 = resolve;
  });
  const persistActiveHoursFlipStarted16 = new Promise(resolve => {
    markPersistActiveHoursFlipStarted16 = resolve;
  });
  const persistActiveHoursFlip16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      persistGate: persistActiveHoursFlipGate16,
      onPersistStart: markPersistActiveHoursFlipStarted16
    }
  );
  const persistActiveHoursFlipRun16 = persistActiveHoursFlip16.run();
  await persistActiveHoursFlipStarted16;
  persistActiveHoursFlip16.setActiveHoursEnabled(false);
  releasePersistActiveHoursFlip16();
  const persistActiveHoursFlipResult16 = await persistActiveHoursFlipRun16;
  assertPass(armActiveHoursFlipResult16 === true
      && persistActiveHoursFlipResult16 === true
      && ![armActiveHoursFlip16, persistActiveHoursFlip16].some(harness =>
        harness.calls.some(call => call.type === 'setup'
          || call.type === 'runtime-reset'
          || call.type === 'shutdown'))
      && [armActiveHoursFlip16, persistActiveHoursFlip16].every(harness =>
        harness.retryAt() === 0
          && harness.alarmAt('ac-active-boundary') === 0
          && harness.alarmAt('ac-active-boundary-schedule-retry') === 0),
    '16F-0B-1E-0D-28: activeHours 在 initial guard 后的 arm persist await 或 enter persist await 中变 false，二次门禁均消费 owner 且零 setup/reset/shutdown');

  const unreadScheduleStart16 = new Date(
    2026, 7, 29, 18, 59, 0, 0
  ).getTime();
  const unreadScheduleBoundary16 = unreadScheduleStart16 + 90_000;
  const unreadScheduleNextNatural16 = unreadScheduleStart16 + 30 * 60_000;
  const unreadScheduleSetupAt16 = unreadScheduleStart16 + 5 * 60_000;
  const unreadScheduleCrossing16 = createOwnedActiveBoundaryHarness16(
    unreadScheduleStart16,
    {
      setupClockAt: unreadScheduleSetupAt16,
      markerWriteFailuresByMode: { schedule: 1 },
      activeBoundaryCreateResults: [true, false, false, true],
      getNextActiveBoundary: (referenceAt, currentAt) =>
        referenceAt <= unreadScheduleStart16
          ? unreadScheduleBoundary16
          : unreadScheduleNextNatural16
    }
  );
  const unreadScheduleInitialResult16 = await unreadScheduleCrossing16.run();
  const unreadScheduleR1At16 = unreadScheduleCrossing16.alarmAt(
    'ac-active-boundary-schedule-retry'
  );
  const unreadScheduleSetupCountBeforeR116 =
    unreadScheduleCrossing16.calls.filter(call => call.type === 'setup').length;
  unreadScheduleCrossing16.failNextDurableReads(1);
  unreadScheduleCrossing16.setNow(unreadScheduleR1At16);
  await unreadScheduleCrossing16.deliverScheduleRetry(
    unreadScheduleR1At16
  );
  const unreadScheduleR2At16 = unreadScheduleCrossing16.alarmAt(
    'ac-active-boundary'
  );
  const unreadScheduleSetupCountAfterR116 =
    unreadScheduleCrossing16.calls.filter(call => call.type === 'setup').length;
  unreadScheduleCrossing16.setNow(unreadScheduleR2At16);
  await unreadScheduleCrossing16.deliver(unreadScheduleR2At16);
  assertPass(unreadScheduleInitialResult16 === true
      && unreadScheduleSetupCountBeforeR116 === 1
      && unreadScheduleR1At16 === unreadScheduleStart16 + 60_000
      && unreadScheduleR1At16 < unreadScheduleBoundary16
      && unreadScheduleR2At16 === unreadScheduleR1At16 + 60_000
      && unreadScheduleR2At16 > unreadScheduleBoundary16
      && unreadScheduleSetupCountAfterR116 === 1
      && unreadScheduleCrossing16.calls.filter(call =>
        call.type === 'setup').length === 2
      && unreadScheduleCrossing16.retryAt() === 0
      && unreadScheduleCrossing16.alarmAt('ac-pwm')
        === unreadScheduleSetupAt16
      && unreadScheduleCrossing16.alarmAt('ac-active-boundary')
        === unreadScheduleNextNatural16
      && unreadScheduleCrossing16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0,
    '16F-0B-1E-0D-29: schedule marker 写失败且 R1 owner read 也失败时，从 scheduledTime 反推 B；若下一分钟跨 B 则 R2 升级 typed action 并执行新边界，不 schedule-only 跳过');

  const markerlessActionBoundaryAt16 = new Date(
    2026, 7, 29, 19, 0, 0, 0
  ).getTime();
  const markerlessOldScheduleAt16 = markerlessActionBoundaryAt16 + 30_000;
  const markerlessNewActionAt16 = markerlessActionBoundaryAt16 + 60_000;
  const markerlessNextNaturalAt16 = markerlessActionBoundaryAt16
    + 30 * 60_000;
  const markerlessActionTakeover16 = createOwnedActiveBoundaryHarness16(
    markerlessActionBoundaryAt16,
    {
      naturalBoundaryAt: markerlessNextNaturalAt16,
      setupClockAt: markerlessNewActionAt16,
      markerWriteFailuresByMode: { action: 1 }
    },
    {
      durable: {
        ac_active_boundary_retry_at: markerlessOldScheduleAt16,
        ac_active_boundary_retry_mode: 'schedule',
        ac_active_boundary_retry_boundary_at: markerlessActionBoundaryAt16,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: markerlessOldScheduleAt16
        }]
      ])
    }
  );
  const markerlessActionTakeoverResult16 =
    await markerlessActionTakeover16.run();
  const markerlessSetupCountBeforeLate16 =
    markerlessActionTakeover16.calls.filter(call => call.type === 'setup').length;
  markerlessActionTakeover16.setNow(markerlessNewActionAt16);
  await markerlessActionTakeover16.deliver(markerlessNewActionAt16);
  assertPass(markerlessActionTakeoverResult16 === true
      && markerlessSetupCountBeforeLate16 === 1
      && markerlessActionTakeover16.calls.filter(call =>
        call.type === 'setup').length === 1
      && markerlessActionTakeover16.calls.filter(call =>
        call.type === 'marker-write-failure'
          && call.mode === 'action').length === 1
      && markerlessActionTakeover16.retryAt() === 0
      && markerlessActionTakeover16.alarmAt('ac-pwm')
        === markerlessNewActionAt16
      && markerlessActionTakeover16.alarmAt('ac-active-boundary')
        === markerlessNextNaturalAt16
      && markerlessActionTakeover16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0,
    '16F-0B-1E-0D-30: 旧 durable schedule 存在但新 action marker 写失败时，complete 以更晚精确 live action 接管；清旧 owner、保留 safe PWM，迟到第二 action 零 setup');

  const restartUnreadMarkerAt16 = ownedBoundaryNow16 + 15_000;
  const restartUnreadEnabled16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      activeBoundaryDurableReadFailures: 1,
      naturalBoundaryAt: ownedBoundaryNaturalAt16
    },
    {
      durable: {
        ac_active_boundary_retry_at: restartUnreadMarkerAt16,
        ac_active_boundary_retry_mode: 'action',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      alarms: new Map()
    }
  );
  const restartUnreadEnabledResult16 =
    await restartUnreadEnabled16.reschedule();
  const restartUnreadNeutralR1At16 = restartUnreadEnabled16.alarmAt(
    'ac-active-boundary-owner-read-retry'
  );
  restartUnreadEnabled16.failNextDurableReads(1);
  restartUnreadEnabled16.setNow(restartUnreadNeutralR1At16);
  await restartUnreadEnabled16.deliverOwnerReadRetry(
    restartUnreadNeutralR1At16
  );
  const restartUnreadNeutralR2At16 = restartUnreadEnabled16.alarmAt(
    'ac-active-boundary-owner-read-retry'
  );
  restartUnreadEnabled16.setNow(restartUnreadNeutralR2At16);
  await restartUnreadEnabled16.deliverOwnerReadRetry(
    restartUnreadNeutralR2At16
  );
  const restartUnreadRecoveredActionAt16 = restartUnreadEnabled16.alarmAt(
    'ac-active-boundary'
  );
  const restartUnreadDisabled16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      activeBoundaryDurableReadFailures: 1,
      naturalBoundaryAt: ownedBoundaryNaturalAt16,
      schedule: {
        enabled: true,
        pwmState: 'off',
        nextTriggerAt: disabledPwmOwnerAt16,
        smartMode: { enabled: true, sensitivity: 5 },
        activeHours: { enabled: false, start: '08:00', end: '23:00' }
      }
    },
    {
      durable: {
        ac_active_boundary_retry_at: restartUnreadMarkerAt16,
        ac_active_boundary_retry_mode: 'action',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: ownedBoundaryNow16 + 20_000
        }],
        ['ac-active-boundary-schedule-retry', {
          name: 'ac-active-boundary-schedule-retry',
          scheduledTime: ownedBoundaryNow16 + 25_000
        }],
        ['ac-active-boundary-owner-read-retry', {
          name: 'ac-active-boundary-owner-read-retry',
          scheduledTime: ownedBoundaryNow16 + 30_000
        }]
      ])
    }
  );
  const restartUnreadDisabledResult16 =
    await restartUnreadDisabled16.reschedule();
  assertPass(restartUnreadEnabledResult16 === ownedBoundaryNow16 + 60_000
      && restartUnreadEnabled16.deferred() === true
      && restartUnreadNeutralR1At16 === ownedBoundaryNow16 + 60_000
      && restartUnreadNeutralR2At16 === ownedBoundaryNow16 + 120_000
      && restartUnreadEnabled16.retryAt()
        === restartUnreadRecoveredActionAt16
      && restartUnreadEnabled16.retryMode() === 'action'
      && restartUnreadRecoveredActionAt16
        === ownedBoundaryNow16 + 180_000
      && restartUnreadEnabled16.alarmAt(
        'ac-active-boundary-owner-read-retry'
      ) === 0
      && !restartUnreadEnabled16.calls.some(call =>
        call.type === 'setup' || call.type === 'gate-passed')
      && !restartUnreadEnabled16.calls.some(call =>
        call.type === 'create'
          && call.info.when === ownedBoundaryNaturalAt16)
      && restartUnreadDisabledResult16 === true
      && restartUnreadDisabled16.retryAt() === 0
      && restartUnreadDisabled16.alarmAt('ac-active-boundary') === 0
      && restartUnreadDisabled16.alarmAt(
        'ac-active-boundary-schedule-retry'
      ) === 0
      && restartUnreadDisabled16.alarmAt(
        'ac-active-boundary-owner-read-retry'
      ) === 0
      && !restartUnreadDisabled16.calls.some(call =>
        call.type === 'create'),
    '16F-0B-1E-0D-31: SW restart 后 durable marker read 瞬断且两 typed live 空时先建 neutral owner-read +1min；连续失败只续 neutral，恢复后按原 durable action 建钟；disabled 只清三类 alarm/marker');

  const markerlessOwnerRead16 = createOwnedActiveBoundaryHarness16(
    ownedBoundaryNow16,
    {
      activeBoundaryDurableReadFailures: 1,
      naturalBoundaryAt: ownedBoundaryNaturalAt16
    }
  );
  const markerlessOwnerReadResult16 = await markerlessOwnerRead16.reschedule();
  const markerlessNeutralAt16 = markerlessOwnerRead16.alarmAt(
    'ac-active-boundary-owner-read-retry'
  );
  const markerlessActionDeferredBeforeHeartbeat16 =
    markerlessOwnerRead16.deferred();
  const markerlessOwnerDeferredBeforeHeartbeat16 =
    markerlessOwnerRead16.ownerReadDeferred();
  await markerlessOwnerRead16.heartbeat();
  assertPass(markerlessOwnerReadResult16 === ownedBoundaryNow16 + 60_000
      && markerlessNeutralAt16 === ownedBoundaryNow16 + 60_000
      && markerlessActionDeferredBeforeHeartbeat16 === false
      && markerlessOwnerDeferredBeforeHeartbeat16 === true
      && markerlessOwnerRead16.ownerReadDeferred() === false
      && markerlessOwnerRead16.deferred() === false
      && markerlessOwnerRead16.retryAt() === 0
      && markerlessOwnerRead16.retryMode() === ''
      && markerlessOwnerRead16.alarmAt(
        'ac-active-boundary-owner-read-retry'
      ) === 0
      && markerlessOwnerRead16.alarmAt('ac-active-boundary')
        === ownedBoundaryNaturalAt16
      && markerlessOwnerRead16.calls.filter(call =>
        call.type === 'create'
          && call.name === 'ac-active-boundary'
          && call.info.when === ownedBoundaryNaturalAt16).length === 1
      && !markerlessOwnerRead16.calls.some(call => call.type === 'setup'),
    '16F-0B-1E-0D-32: marker=0 的正常 init read 瞬断只置 owner-read flag；heartbeat 重读恢复后清 neutral 并排自然边界，不被旧 action-deferred 误 arm');

  const neutralNaturalBoundaryAt16 = new Date(
    2026, 7, 29, 19, 0, 0, 0
  ).getTime();
  const neutralNaturalNextAt16 = neutralNaturalBoundaryAt16 + 30 * 60_000;
  const neutralNaturalSetupAt16 = neutralNaturalBoundaryAt16 + 5 * 60_000;
  const neutralBeforeNatural16 = createOwnedActiveBoundaryHarness16(
    neutralNaturalBoundaryAt16,
    {
      setupClockAt: neutralNaturalSetupAt16,
      getNextActiveBoundary: referenceAt =>
        referenceAt < neutralNaturalBoundaryAt16
          ? neutralNaturalBoundaryAt16
          : neutralNaturalNextAt16
    },
    {
      durable: {
        ac_active_boundary_retry_at: 0,
        ac_active_boundary_retry_mode: '',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      // Chrome 已把同刻自然 A dequeue；N 处理时 get(A) 看不到它。
      alarms: new Map([
        ['ac-active-boundary-owner-read-retry', {
          name: 'ac-active-boundary-owner-read-retry',
          scheduledTime: neutralNaturalBoundaryAt16
        }]
      ])
    }
  );
  neutralBeforeNatural16.setOwnerReadDeferred(true);
  await neutralBeforeNatural16.deliverOwnerReadRetry(
    neutralNaturalBoundaryAt16
  );
  const neutralRearmedNaturalAt16 = neutralBeforeNatural16.alarmAt(
    'ac-active-boundary'
  );
  const setupCountAfterNeutral16 = neutralBeforeNatural16.calls.filter(call =>
    call.type === 'setup').length;
  await neutralBeforeNatural16.deliver(neutralNaturalBoundaryAt16);

  const nonNaturalLateAt16 = neutralNaturalBoundaryAt16 + 60_000;
  const nonNaturalSuppressed16 = createOwnedActiveBoundaryHarness16(
    nonNaturalLateAt16,
    {
      naturalBoundaryAt: neutralNaturalNextAt16,
      setupClockAt: nonNaturalLateAt16 + 5 * 60_000
    },
    {
      durable: {
        ac_active_boundary_retry_at: 0,
        ac_active_boundary_retry_mode: '',
        ac_active_boundary_retry_boundary_at: 0,
        ac_schedule: null
      },
      alarms: new Map([
        ['ac-active-boundary', {
          name: 'ac-active-boundary',
          scheduledTime: neutralNaturalNextAt16
        }]
      ])
    }
  );
  await nonNaturalSuppressed16.deliver(nonNaturalLateAt16);
  assertPass(scheduleOnlyActiveBoundaryBody16.includes(
      'const configuredNaturalBoundaryAt =')
      && scheduleOnlyActiveBoundaryBody16.includes(
        '&& !deliveryIsConfiguredNaturalBoundary')
      && neutralRearmedNaturalAt16 === neutralNaturalNextAt16
      && setupCountAfterNeutral16 === 0
      && neutralBeforeNatural16.calls.filter(call =>
        call.type === 'setup').length === 1
      && neutralBeforeNatural16.alarmAt('ac-pwm')
        === neutralNaturalSetupAt16
      && neutralBeforeNatural16.alarmAt('ac-active-boundary')
        === neutralNaturalNextAt16
      && neutralBeforeNatural16.alarmAt(
        'ac-active-boundary-owner-read-retry'
      ) === 0
      && nonNaturalSuppressed16.calls.filter(call =>
        call.type === 'setup').length === 0
      && !nonNaturalSuppressed16.calls.some(call =>
        call.type === 'storage-load' || call.type === 'gate-passed')
      && nonNaturalSuppressed16.alarmAt('ac-active-boundary')
        === neutralNaturalNextAt16,
    '16F-0B-1E-0D-33: 同刻 neutral N 先重读并排 A2 后，已 dequeue 的真实自然 A 仍凭配置边界证明执行一次 setup；非自然 19:01 迟到 action 仍被 19:30 live 压制');
  const alarmPwmCatchStart16 = backgroundSource.indexOf(
    "if (alarm.name === 'ac-pwm') {"
  );
  const alarmPwmCatchEnd16 = backgroundSource.indexOf(
    "\n    return;\n  }\n\n  if (alarm.name === 'ac-watchdog')",
    alarmPwmCatchStart16
  );
  const alarmPwmCatchBody16 = alarmPwmCatchStart16 >= 0
      && alarmPwmCatchEnd16 > alarmPwmCatchStart16
    ? backgroundSource.slice(alarmPwmCatchStart16, alarmPwmCatchEnd16)
    : '';
  const syncPhaseAdmissionSource16 = extractSourceSection(
    backgroundSource,
    'function claimSyncPhaseAdoptionAdmission() {',
    '\n\nfunction releasePwmStepOwnership(automationRevision) {',
    'sync phase admission reservation helpers'
  );
  const sharedPwmExecutorSource16 = extractSourceSection(
    backgroundSource,
    'async function executePwmStepWithRecovery({',
    '\n\n// 通过新鲜页面确认 Power-off after 已离开当前 React 状态并真正持久化。',
    'shared PWM executor admission gate'
  );
  const finishComfortStartSource16 = extractSourceSection(
    backgroundSource,
    "async function finishComfortStart(reason = '') {",
    '\n\n// 舒适 retry 可能在页面确认的长 await 中跨过截止点。',
    'comfort finish revision provenance'
  );
  const advanceExpiredAlarmSource16 = extractSourceSection(
    backgroundSource,
    'async function advanceExpiredAlarmToNextBoundary(',
    '\n\n// 普通循环模式的过期相位执行器。',
    'expired phase adoption continuation'
  );
  const durableLivePwmOwnerSource16 = extractSourceSection(
    backgroundSource,
    'async function hasDurableLivePwmOwner(',
    '\n// replacement owner 的证明本身含 storage/alarm await。',
    'replacement PWM owner durable/live proof'
  );
  const stableDurableLivePwmOwnerSource16 = extractSourceSection(
    backgroundSource,
    'async function proveStableDurableLivePwmOwner(',
    '\n\nfunction prepareFreshPwmStartState()',
    'stable replacement PWM owner proof'
  );
  const syncOwnerAlarmAdmissionSource16 = extractSourceSection(
    backgroundSource,
    'function assessPwmAlarmDelivery(',
    '\nfunction prepareFreshPwmStartState()',
    'replacement PWM owner alarm admission'
  );
  const loadActualSyncApply16 = (
    initialSchedule,
    initialLiveAt = 0,
    initialWatermark = 0,
    harnessOptions = {}
  ) => new Function(
    'initialSchedule', 'initialLiveAt', 'initialWatermark', 'harnessOptions',
    'classifySmartOnClock',
    'computeConfigDiff', 'protectSmartOnRetryConfigDiff',
    'computePhaseAdoption', 'PWM_RETRY_ALARM_TOLERANCE_MS', 'console', 'Date',
    `let schedule = structuredClone(initialSchedule);
    let durableSchedule = structuredClone(initialSchedule);
    let liveAt = Number(initialLiveAt) || 0;
    let lastSyncedAt = Number(initialWatermark) || 0;
    let durableWatermark = Number(initialWatermark) || 0;
    let watermarkGetFailures = Number(harnessOptions.watermarkGetFailures) || 0;
    let schedulePersistFailures = Number(harnessOptions.schedulePersistFailures) || 0;
    let syncWatermarkLoaded = false;
    let syncWatermarkWriteChain = Promise.resolve();
    let pwmRuntimeRevision = 1;
    let automaticDisableAdmissionEpoch = 0;
    let automaticOnAdmissionBlocked = false;
    let syncPublishGeneration = 0;
    let syncPhaseAdoptionAdmissionEpoch = 0;
    let syncPhaseAdoptionAdmissionOwner = 0;
    let pwmExecutionWithRecoveryCount = 0;
    let deferredRepairAfterPwmOptions = null;
    let scheduleRepairEpoch = 0;
    let pwmStepRunning = false;
    let pwmStepRunningRevision = null;
    let pendingPublish = false;
    let pwmAlarmGateUsed = false;
    let cancelGateUsed = false;
    let comfortFinishPersistGateUsed = false;
    let postRecoveryOwnerCommitted = false;
    let expiredRecoveryPersistFailureUsed = false;
    let replacementProofGateUsed = false;
    const calls = [];
    ${setNextTriggerAtSource16}
    function isAutomationAllowedForSchedule(s) { return s?.enabled === true; }
    function isAutomationAllowed() { return isAutomationAllowedForSchedule(schedule); }
    function isAutomationOperationCurrent(r) {
      return r === pwmRuntimeRevision && isAutomationAllowed();
    }
    function isComfortStartActive() {
      return Number(schedule.comfortStartUntil) > Date.now();
    }
    function isWithinActiveHours() { return true; }
    function isCurrentPwmStepRunning() {
      return pwmStepRunning && pwmStepRunningRevision === pwmRuntimeRevision;
    }
    function waitUntil(promise) { return Promise.resolve(promise); }
    function drainDeferredScheduleRepair() { return false; }
    async function repairScheduleClock(options = {}) {
      calls.push({ type: 'repair-clock', options: { ...options } });
      const repairFutureAt = Number(harnessOptions.repairFutureAt) || 0;
      if (repairFutureAt > Date.now()) {
        calls.push({ type: 'fresh-status-repair', isOn: false });
        schedule.pwmState = 'on';
        setNextTriggerAt(repairFutureAt);
        const repairBoundaryAt = Number(options.smartOnExpectedBoundaryAt) || 0;
        if (repairBoundaryAt > 0) {
          schedule.smartOnBoundaryAt = repairBoundaryAt;
          schedule.pwmRetryKind = 'smart-on-safe-delay';
          schedule.pwmRetryBoundaryAt = repairBoundaryAt;
          schedule.pwmRetryScheduledAt = repairFutureAt;
        }
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = Math.max(
          1,
          (repairFutureAt - Date.now()) / 60000
        );
        liveAt = repairFutureAt;
        durableSchedule = structuredClone(schedule);
        calls.push({ type: 'repair-clock-created', at: repairFutureAt });
      }
      return { success: true };
    }
    async function loadScheduleFromStorage() {
      calls.push({ type: 'storage-reload' });
    }
    async function recoverPwmLifecycle(context = {}) {
      calls.push({ type: 'watchdog-recovery', context: { ...context } });
      if (context.source === 'expired-alarm'
          && Number(harnessOptions.lastPwmStepAt) > 0
          && Date.now() - Number(harnessOptions.lastPwmStepAt) < 5000) {
        calls.push({ type: 'cooldown-no-clock', revision: context.automationRevision,
          phaseAdmissionEpoch: context.phaseAdmissionEpoch });
        return { handled: true };
      }
      if (context.source === 'expired-alarm'
          && Number(harnessOptions.expiredRecoveryAt) > Date.now()) {
        const phaseOwnerAccepted = !isSyncPhaseAdoptionAdmissionBlockedFor(
          context.phaseAdmissionEpoch
        );
        calls.push({ type: 'expired-recovery-admission', phaseOwnerAccepted,
          phaseAdmissionEpoch: context.phaseAdmissionEpoch,
          revision: context.automationRevision });
        if (!phaseOwnerAccepted
            || !isAutomationOperationCurrent(context.automationRevision)) {
          return { handled: false };
        }
        const recoveryRevision = harnessOptions.expiredRecoveryClaimsNewRevision
          ? pwmRuntimeRevision += 1
          : context.automationRevision;
        schedule.pwmState = harnessOptions.expiredRecoveryAction || 'off';
        setNextTriggerAt(Number(harnessOptions.expiredRecoveryAt));
        const recoveryBoundaryAt = Number(
          harnessOptions.expiredRecoveryBoundaryAt
        ) || 0;
        if (recoveryBoundaryAt > 0) {
          schedule.smartOnBoundaryAt = recoveryBoundaryAt;
          schedule.pwmRetryKind = 'smart-on-safe-delay';
          schedule.pwmRetryBoundaryAt = recoveryBoundaryAt;
          schedule.pwmRetryScheduledAt = schedule.nextTriggerAt;
        }
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = Math.max(
          1,
          (schedule.nextTriggerAt - Date.now()) / 60000
        );
        await persistSchedule('expired-phase-recovery-intent');
        const created = await createPwmAlarmFromPlan(
          { nextTriggerAt: schedule.nextTriggerAt },
          'expired-phase-recovery',
          recoveryRevision
        );
        postRecoveryOwnerCommitted = created === true;
        if (harnessOptions.expiredRecoveryClaimsNewRevision) {
          calls.push({ type: 'expired-recovery-new-owner',
            revision: recoveryRevision, at: schedule.nextTriggerAt });
        }
        return { handled: created === true };
      }
      return { handled: true };
    }
    ${syncPhaseAdmissionSource16}
    ${syncOwnerAlarmAdmissionSource16}
    ${durableLivePwmOwnerSource16}
    ${stableDurableLivePwmOwnerSource16}
    const STORAGE_KEY = 'ac_schedule_test';
    const SYNC_WATERMARK_KEY = 'ac_schedule_sync_watermark';
    const SYNC_PENDING_PUBLISH_KEY = 'ac_schedule_sync_publish_pending';
    const chrome = {
      storage: { local: {
        async get(key) {
          if (key === STORAGE_KEY) {
            const captured = structuredClone(durableSchedule);
            if (harnessOptions.replacementProofGate
                && !replacementProofGateUsed) {
              replacementProofGateUsed = true;
              calls.push({ type: 'replacement-proof-start' });
              if (typeof harnessOptions.onReplacementProofStart === 'function') {
                harnessOptions.onReplacementProofStart();
              }
              await harnessOptions.replacementProofGate;
            }
            return { [key]: captured };
          }
          if (key === SYNC_PENDING_PUBLISH_KEY) {
            return { [key]: pendingPublish };
          }
          if (watermarkGetFailures > 0) {
            watermarkGetFailures -= 1;
            throw new Error('transient watermark read');
          }
          return { [key]: durableWatermark };
        },
        async set(value) {
          if (Object.hasOwn(value, SYNC_PENDING_PUBLISH_KEY)) {
            pendingPublish = value[SYNC_PENDING_PUBLISH_KEY] === true;
            calls.push({
              type: 'disable-intent',
              enabled: value.ac_schedule_test?.enabled,
              pending: pendingPublish
            });
            return;
          }
          durableWatermark = Number(value[SYNC_WATERMARK_KEY]) || 0;
          calls.push({ type: 'watermark', at: durableWatermark });
        }
      } },
      alarms: {
        async get(name) {
          if (name === 'ac-pwm'
              && postRecoveryOwnerCommitted
              && harnessOptions.postRecoveryAlarmGetFailure) {
            postRecoveryOwnerCommitted = false;
            calls.push({ type: 'post-recovery-get-failure' });
            throw new Error('synthetic post-recovery alarm get failure');
          }
          if (name === 'ac-pwm'
              && harnessOptions.pwmAlarmGate
              && !pwmAlarmGateUsed) {
            pwmAlarmGateUsed = true;
            if (typeof harnessOptions.onPwmAlarmGet === 'function') {
              harnessOptions.onPwmAlarmGet();
            }
            await harnessOptions.pwmAlarmGate;
          }
          return name === 'ac-pwm' && liveAt
            ? { name, scheduledTime: liveAt }
            : undefined;
        },
        async clear(name) {
          calls.push({ type: 'chrome-clear', name });
          if (name === 'ac-pwm') liveAt = 0;
        }
      },
    };
    ${syncWatermarkSource6}
    async function persistSchedule(reason) {
      calls.push({ type: 'persist', reason, enabled: schedule.enabled,
        pwmState: schedule.pwmState, nextTriggerAt: schedule.nextTriggerAt });
      if (String(reason).startsWith('comfort-start-ended-')
          && harnessOptions.comfortFinishPersistGate
          && !comfortFinishPersistGateUsed) {
        comfortFinishPersistGateUsed = true;
        if (typeof harnessOptions.onComfortFinishPersist === 'function') {
          harnessOptions.onComfortFinishPersist();
        }
        await harnessOptions.comfortFinishPersistGate;
      }
      if (schedulePersistFailures > 0) {
        schedulePersistFailures -= 1;
        throw new Error('synthetic schedule persist failure');
      }
      if (harnessOptions.expiredRecoveryPersistFailure === true
          && !expiredRecoveryPersistFailureUsed
          && reason === 'expired-phase-recovery-intent') {
        expiredRecoveryPersistFailureUsed = true;
        calls.push({ type: 'expired-recovery-persist-failure' });
        throw new Error('synthetic replacement recovery intent persist failure');
      }
      durableSchedule = structuredClone(schedule);
    }
    async function clearPwmAlarm(revision) {
      calls.push({ type: 'clear-pwm', revision });
      liveAt = 0;
    }
    async function createPwmAlarmFromPlan(plan, tag, revision) {
      calls.push({ type: 'create-pwm', tag, at: plan.nextTriggerAt, revision });
      liveAt = plan.nextTriggerAt;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (liveAt - Date.now()) / 60000);
      setNextTriggerAt(liveAt);
      return true;
    }
    async function createAlarm(name) { calls.push({ type: 'infra', name }); return true; }
    async function scheduleSyncRetry(kind = 'publish') {
      return createAlarm(kind === 'adopt'
        ? 'ac-sync-adopt-retry'
        : 'ac-sync-publish-retry');
    }
    ${advanceExpiredAlarmSource16}
    async function resetDisabledPwmRuntime() { calls.push({ type: 'reset-disabled' }); }
    async function requestTimerBasedShutdown(reason) {
      calls.push({ type: 'shutdown', reason });
      return { success: true };
    }
    async function rescheduleSmartWeatherAlarm() { calls.push({ type: 'smart-weather' }); }
    async function setupAlarms(start) { calls.push({ type: 'setup', start }); }
    function rescheduleActiveBoundary() { calls.push({ type: 'active-boundary' }); }
    async function scheduleComfortStartEndAlarm() {
      calls.push({ type: 'comfort-end-alarm' });
      return true;
    }
    async function deferComfortFinish(error, revision) {
      calls.push({ type: 'comfort-finish-defer', error: String(error), revision });
      return { handled: false, automationAllowed: false, deferred: true,
        automationRevision: revision };
    }
    function runSerializedScheduleUpdate(operation) { return operation(); }
    async function retryComfortStartAndFinishIfExpired() {
      throw new Error('expired comfort finish path should not retry comfort start');
    }
    async function deferComfortStart() {
      throw new Error('expired comfort finish path should not defer comfort start');
    }
    function tagPwmAutomationError(error) { return error; }
    function invalidateTimerBasedShutdown() {
      calls.push({ type: 'invalidate-shutdown', revision: pwmRuntimeRevision });
    }
    async function cancelAutomaticOnRequests() {
      calls.push({ type: 'cancel-automatic-on', revision: pwmRuntimeRevision });
      if (harnessOptions.cancelAutomaticOnGate && !cancelGateUsed) {
        cancelGateUsed = true;
        if (typeof harnessOptions.onCancelAutomaticOn === 'function') {
          harnessOptions.onCancelAutomaticOn();
        }
        await harnessOptions.cancelAutomaticOnGate;
      }
    }
    ${explicitDisableClaimSource6}
    async function commitExplicitDisableIntentForTest() {
      const admissionEpoch = preemptAutomaticOnForExplicitDisable();
      schedule.enabled = false;
      await chrome.storage.local.set({
        ac_schedule_test: { ...schedule },
        [SYNC_PENDING_PUBLISH_KEY]: true
      });
      await scheduleSyncRetry('publish');
      return admissionEpoch;
    }
    async function runPausedAutomaticOnForTest(gate) {
      const automationRevision = pwmRuntimeRevision;
      calls.push({ type: 'old-auto-start', revision: automationRevision });
      await gate;
      if (!isAutomationOperationCurrent(automationRevision)) {
        calls.push({ type: 'old-auto-stale', revision: automationRevision });
        return false;
      }
      schedule.pwmState = 'off';
      calls.push({ type: 'old-auto-on', revision: automationRevision });
      await persistSchedule('old-auto-on');
      return true;
    }
    function supersedeReplacementOwnerForTest(nextTriggerAt) {
      pwmRuntimeRevision += 1;
      schedule.pwmState = 'on';
      setNextTriggerAt(nextTriggerAt);
      schedule.smartOnBoundaryAt = Number(harnessOptions.supersedingBoundaryAt) || 0;
      schedule.pwmRetryKind = schedule.smartOnBoundaryAt > 0
        ? 'smart-on-safe-delay'
        : '';
      schedule.pwmRetryBoundaryAt = schedule.smartOnBoundaryAt;
      schedule.pwmRetryScheduledAt = nextTriggerAt;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - Date.now()) / 60000
      );
      liveAt = nextTriggerAt;
      durableSchedule = structuredClone(schedule);
      calls.push({ type: 'replacement-owner-superseded',
        revision: pwmRuntimeRevision, at: nextTriggerAt });
      return pwmRuntimeRevision;
    }
    function supersedeIncompleteReplacementOwnerForTest(nextTriggerAt) {
      pwmRuntimeRevision += 1;
      schedule.pwmState = 'on';
      setNextTriggerAt(nextTriggerAt);
      schedule.smartOnBoundaryAt = Number(harnessOptions.supersedingBoundaryAt) || 0;
      schedule.pwmRetryKind = schedule.smartOnBoundaryAt > 0
        ? 'smart-on-safe-delay'
        : '';
      schedule.pwmRetryBoundaryAt = schedule.smartOnBoundaryAt;
      schedule.pwmRetryScheduledAt = nextTriggerAt;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - Date.now()) / 60000
      );
      liveAt = 0;
      calls.push({ type: 'replacement-owner-incomplete',
        revision: pwmRuntimeRevision, at: nextTriggerAt });
      return pwmRuntimeRevision;
    }
    function getSmartOnPwmRetryContext() {
      return { hasTypedSmartOnRetry: false, hasSafetyTimerRetry: false };
    }
    const SMART_MODE = { ON_MAX: 30 };
    function planSmartModeOnWindow() { return null; }
    async function runPwmStep() {
      const claimedRevision = pwmRuntimeRevision += 1;
      calls.push({ type: 'old-ac-pwm-claim', revision: claimedRevision });
      calls.push({ type: 'old-ac-pwm-click', revision: claimedRevision });
    }
    async function recoverTypedSmartOnAlarmException() { return false; }
    async function recoverGenericPwmAlarmException() { return false; }
    function appendDiagnosticLog() {}
    ${finishComfortStartSource16}
    ${sharedPwmExecutorSource16}
    const initReady = Promise.resolve();
    async function deliverRejectedOldAlarmForTest(scheduledTime) {
      const alarm = { name: 'ac-pwm', scheduledTime };
      const activeBoundaryActionDelivery = false;
      await initReady;
      ${phaseSensitiveAlarmGateBody16}
      ${alarmPwmCatchBody16}
        return;
      }
    }
    ${watchdogBody13}
    async function deliverOldAcPwmForTest(scheduledTime) {
      const deliveredRevision = pwmRuntimeRevision;
      const result = await executePwmStepWithRecovery({
        scheduledTime,
        automationRevision: deliveredRevision,
        source: 'alarm-ac-pwm-test'
      });
      return { result, deliveredRevision };
    }
    ${retryStateHelpers16}
    ${applySyncedPhaseBody}
    return {
      apply: applySyncedPhase,
      disable: commitExplicitDisableIntentForTest,
      runPausedAutomaticOn: runPausedAutomaticOnForTest,
      deliverOldAcPwm: deliverOldAcPwmForTest,
      deliverPwmAlarm: deliverRejectedOldAlarmForTest,
      deliverRejectedOldAlarm: deliverRejectedOldAlarmForTest,
      runWatchdog: watchdogCheck,
      drainRepair: drainDeferredScheduleRepair,
      supersedeReplacementOwner: supersedeReplacementOwnerForTest,
      supersedeIncompleteReplacementOwner:
        supersedeIncompleteReplacementOwnerForTest,
      snapshot: () => structuredClone(schedule),
      durable: () => structuredClone(durableSchedule),
      live: () => liveAt,
      calls,
      revision: () => pwmRuntimeRevision,
      phaseAdmissionBlocked: () => isSyncPhaseAdoptionAdmissionBlocked(),
      pending: () => pendingPublish,
      lastSyncedAt: () => lastSyncedAt,
      durableWatermark: () => durableWatermark
    };`
  )(
    initialSchedule,
    initialLiveAt,
    initialWatermark,
    harnessOptions,
    pwmPhase.classifySmartOnClock,
    syncHelpers.computeConfigDiff,
    syncHelpers.protectSmartOnRetryConfigDiff,
    (localSchedule, remote, options = {}) => syncHelpers.computePhaseAdoption(
      localSchedule,
      remote,
      {
        ...options,
        ...(harnessOptions.Date ? { now: harnessOptions.Date.now() } : {})
      }
    ),
    1500,
    testConsole,
    harnessOptions.Date || Date
  );

  const syncApplyNow16 = Date.now();
  const localRetryAt16 = syncApplyNow16 + 60_000;
  const sentinelAt16 = pwmPhase.nextHalfHourBoundary(
    Math.max(syncApplyNow16, localRetryAt16)
  );
  const syncCfg16 = {
    enabled: true,
    onMinutes: 23,
    offMinutes: 7,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    smartMode: { enabled: true, sensitivity: 5 },
    comfortStartUntil: 0
  };
  const sentinelRemote16 = {
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: sentinelAt16,
    smartClockPlannedAt: syncApplyNow16,
    syncedAt: syncApplyNow16 + 1
  };

  // 已验权的旧 ac-pwm 在 beforeRun 内结束 comfort marker 时可能横跨一次长
  // storage persist。sync OFF phase 在这段 await 中换主后，continuation 必须
  // 沿用 finishComfortStart 入场捕获的旧 revision，绝不能读取新的全局 revision
  // 后误把旧 alarm 重新授权给 runPwmStep。
  let releaseComfortFinishPersist16;
  let markComfortFinishPersistStarted16;
  const comfortFinishPersistGate16 = new Promise(resolve => {
    releaseComfortFinishPersist16 = resolve;
  });
  const comfortFinishPersistStarted16 = new Promise(resolve => {
    markComfortFinishPersistStarted16 = resolve;
  });
  const comfortFinishOldAlarmAt16 = syncApplyNow16 - 1000;
  const comfortFinishProvenance16 = loadActualSyncApply16({
    ...syncCfg16,
    comfortStartUntil: comfortFinishOldAlarmAt16,
    comfortStartOnConfirmedAt: syncApplyNow16 - 6 * 60_000,
    pwmState: 'on',
    nextTriggerAt: comfortFinishOldAlarmAt16,
    smartClockPlannedAt: syncApplyNow16 - 2 * 60_000,
    alarmCreatedAt: syncApplyNow16 - 2 * 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, comfortFinishOldAlarmAt16, 0, {
    comfortFinishPersistGate: comfortFinishPersistGate16,
    onComfortFinishPersist: markComfortFinishPersistStarted16
  });
  const oldComfortBoundaryDelivery16 = comfortFinishProvenance16
    .deliverPwmAlarm(comfortFinishOldAlarmAt16);
  await comfortFinishPersistStarted16;
  const comfortFinishCapturedRevision16 = comfortFinishProvenance16.revision();
  const comfortFinishRemoteOffApplied16 = await comfortFinishProvenance16.apply(
    sentinelRemote16,
    'test-sync-off-preempts-gated-comfort-finish'
  );
  const comfortFinishRemoteOwnerRevision16 = comfortFinishProvenance16.revision();
  releaseComfortFinishPersist16();
  await oldComfortBoundaryDelivery16;
  const comfortFinishAfter16 = comfortFinishProvenance16.snapshot();
  const comfortFinishCreateCalls16 = comfortFinishProvenance16.calls.filter(c =>
    c.type === 'create-pwm');
  assertPass(finishComfortStartSource16.includes(
      'let automationRevision = pwmRuntimeRevision;')
      && finishComfortStartSource16.includes(
        'return { handled: true, automationAllowed: true, automationRevision };')
      && alarmPwmCatchBody16.includes(
        'const alarmAutomationRevision = pwmRuntimeRevision;')
      && alarmPwmCatchBody16.includes(
        'return { automationRevision: comfortEnd.automationRevision };')
      && alarmPwmCatchBody16.includes(
        'return { automationRevision: alarmAutomationRevision };')
      && !alarmPwmCatchBody16.includes(
        'return { automationRevision: pwmRuntimeRevision };')
      && comfortFinishCapturedRevision16 === 1
      && comfortFinishRemoteOffApplied16 === true
      && comfortFinishRemoteOwnerRevision16 === 2
      && !comfortFinishProvenance16.calls.some(c =>
        c.type === 'old-ac-pwm-claim' || c.type === 'old-ac-pwm-click')
      && comfortFinishProvenance16.calls.some(c =>
        c.type === 'persist'
          && c.reason === 'comfort-start-ended-pwm-boundary')
      && comfortFinishProvenance16.calls.some(c =>
        c.type === 'persist'
          && c.reason === 'sync-phase-adopt-intent'
          && c.pwmState === 'off'
          && c.nextTriggerAt === sentinelAt16)
      && comfortFinishCreateCalls16.length === 1
      && comfortFinishCreateCalls16[0].revision
        === comfortFinishRemoteOwnerRevision16
      && comfortFinishCreateCalls16[0].at === sentinelAt16
      && comfortFinishAfter16.comfortStartUntil === 0
      && comfortFinishAfter16.pwmState === 'off'
      && comfortFinishAfter16.nextTriggerAt === sentinelAt16
      && comfortFinishProvenance16.live() === sentinelAt16,
    '16F-0B-2A-0: real comfort finish persist 卡住时 sync OFF 换主；旧 alarm continuation 沿用 captured revision，零 claim/click，最终只留远端 OFF alarm');

  const expiredRemotePhaseAt16 = Date.now() - 10_000;
  const expiredRemoteRecoveryAt16 = Date.now() + 6 * 60_000;
  const expiredRemotePhase16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: sentinelAt16,
    smartClockPlannedAt: syncApplyNow16,
    alarmCreatedAt: syncApplyNow16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, sentinelAt16, 0, {
    expiredRecoveryAt: expiredRemoteRecoveryAt16,
    expiredRecoveryAction: 'off'
  });
  const expiredRemoteApplied16 = await expiredRemotePhase16.apply({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: expiredRemotePhaseAt16,
    smartClockPlannedAt: Date.now() - 20_000,
    syncedAt: Date.now() + 10
  }, 'test-stale-within-window-phase-adopt');
  const expiredRemoteAfter16 = expiredRemotePhase16.snapshot();
  const expiredRemoteAdmission16 = expiredRemotePhase16.calls.find(call =>
    call.type === 'expired-recovery-admission');
  assertPass(advanceExpiredAlarmSource16.includes('phaseAdmissionEpoch = 0')
      && advanceExpiredAlarmSource16.includes('phaseAdmissionEpoch,')
      && applySyncedPhaseBody.includes(
        'adopt.nextTriggerAt,\n              automationRevision,\n              phaseAdmissionEpoch')
      && applySyncedPhaseBody.includes(
        "throw new Error('同步过期相位未建立未来恢复时钟')")
      && expiredRemoteApplied16 === true
      && expiredRemoteAdmission16?.phaseAdmissionEpoch > 0
      && expiredRemoteAdmission16?.phaseOwnerAccepted === true
      && expiredRemoteAdmission16?.revision === 2
      && expiredRemotePhase16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'sync-phase-adopt-intent'
          && call.nextTriggerAt === expiredRemotePhaseAt16)
      && expiredRemotePhase16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'expired-phase-recovery-intent'
          && call.nextTriggerAt === expiredRemoteRecoveryAt16)
      && expiredRemotePhase16.calls.filter(call =>
        call.type === 'create-pwm'
          && call.tag === 'expired-phase-recovery'
          && call.at === expiredRemoteRecoveryAt16).length === 1
      && expiredRemoteAfter16.nextTriggerAt === expiredRemoteRecoveryAt16
      && expiredRemoteAfter16.nextTriggerAt > Date.now()
      && expiredRemotePhase16.live() === expiredRemoteRecoveryAt16
      && !expiredRemotePhase16.calls.some(call =>
        call.type === 'infra' && call.name === 'ac-sync-adopt-retry'),
    '16F-0B-2A-1: sync 采纳 60s 内过期 phase 时把 reservation epoch 传入恢复；不会 self-noop，最终 durable/live 均为未来钟');

  const cooldownNow16 = new Date(2026, 7, 28, 19, 0, 3, 0).getTime();
  const cooldownBoundary16 = cooldownNow16 - 3_000;
  const cooldownRepairAt16 = cooldownNow16 + 5 * 60_000;
  class CooldownAdoptionDate16 extends Date {
    static now() { return cooldownNow16; }
  }
  const cooldownExpiredPhase16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16 + 30 * 60_000,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    alarmCreatedAt: cooldownBoundary16 - 4 * 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, cooldownBoundary16 + 30 * 60_000, 0, {
    Date: CooldownAdoptionDate16,
    lastPwmStepAt: cooldownNow16 - 1000,
    repairFutureAt: cooldownRepairAt16
  });
  const cooldownExpiredApplied16 = await cooldownExpiredPhase16.apply({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    syncedAt: cooldownNow16 + 1
  }, 'test-expired-smart-on-during-cooldown');
  const cooldownRepairDrained16 = cooldownExpiredPhase16.drainRepair(
    'test-expired-smart-on-cooldown'
  );
  await Promise.resolve();
  const cooldownExpiredAfter16 = cooldownExpiredPhase16.snapshot();
  const cooldownRepairCall16 = cooldownExpiredPhase16.calls.find(call =>
    call.type === 'repair-clock');
  assertPass(pwmBody.includes('Date.now() - lastPwmStepAt < 5000')
      && advanceExpiredAlarmSource16.includes('if (recovery.handled !== true) return false;')
      && advanceExpiredAlarmSource16.includes('const durableAt = Number(schedule.nextTriggerAt) || 0;')
      && advanceExpiredAlarmSource16.includes("await chrome.alarms.get('ac-pwm')")
      && advanceExpiredAlarmSource16.includes('durableAt > now')
      && advanceExpiredAlarmSource16.includes('liveAt > now')
      && cooldownExpiredApplied16 === true
      && cooldownRepairDrained16 === true
      && cooldownExpiredPhase16.calls.filter(call =>
        call.type === 'cooldown-no-clock').length === 1
      && cooldownRepairCall16?.options.smartOnExpectedBoundaryAt
        === cooldownBoundary16
      && cooldownRepairCall16?.options.revokeInvalidSmartOnClock === true
      && cooldownRepairCall16?.options.preserveRevokeAcrossSupersededRepair
        === true
      && cooldownExpiredPhase16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'sync-phase-adopt-error'
          && call.nextTriggerAt === 0)
      && cooldownExpiredPhase16.calls.filter(call =>
        call.type === 'fresh-status-repair' && call.isOn === false).length === 1
      && cooldownExpiredPhase16.calls.filter(call =>
        call.type === 'repair-clock-created'
          && call.at === cooldownRepairAt16).length === 1
      && !cooldownExpiredPhase16.calls.some(call =>
        call.type === 'old-ac-pwm-claim'
          || call.type === 'old-ac-pwm-click')
      && cooldownExpiredAfter16.nextTriggerAt === cooldownRepairAt16
      && cooldownExpiredAfter16.nextTriggerAt
        !== cooldownBoundary16 + 30 * 60_000
      && cooldownExpiredAfter16.pwmRetryKind === 'smart-on-safe-delay'
      && cooldownExpiredAfter16.pwmRetryBoundaryAt === cooldownBoundary16
      && cooldownExpiredAfter16.pwmRetryScheduledAt === cooldownRepairAt16
      && cooldownExpiredPhase16.live() === cooldownRepairAt16,
    '16F-0B-2A-2: stale smart ON 遇 1s cooldown 的 handled 假成功仍被 durable/live 后置证明拒绝；接管转 fresh-status repair，零双击');

  const postRecoveryOwnerAt16 = cooldownNow16 + 5 * 60_000;
  const postRecoveryGetFailure16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16 + 30 * 60_000,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    alarmCreatedAt: cooldownBoundary16 - 4 * 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, cooldownBoundary16 + 30 * 60_000, 0, {
    Date: CooldownAdoptionDate16,
    expiredRecoveryAt: postRecoveryOwnerAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: cooldownBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    postRecoveryAlarmGetFailure: true
  });
  const postRecoveryGetApplied16 = await postRecoveryGetFailure16.apply({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    syncedAt: cooldownNow16 + 2
  }, 'test-post-recovery-get-failure');
  const postRecoveryGetAfter16 = postRecoveryGetFailure16.snapshot();
  assertPass(applySyncedPhaseBody.includes(
      'if (!isAutomationOperationCurrent(automationRevision)) {')
      && applySyncedPhaseBody.includes(
        "appendDiagnosticLog('warn', 'sync-phase-adopt-post-owner', e)")
      && postRecoveryGetApplied16 === true
      && postRecoveryGetFailure16.revision() === 3
      && postRecoveryGetFailure16.calls.filter(call =>
        call.type === 'post-recovery-get-failure').length === 1
      && postRecoveryGetFailure16.calls.filter(call =>
        call.type === 'expired-recovery-new-owner'
          && call.revision === 3
          && call.at === postRecoveryOwnerAt16).length === 1
      && !postRecoveryGetFailure16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'sync-phase-adopt-error')
      && postRecoveryGetAfter16.pwmState === 'on'
      && postRecoveryGetAfter16.nextTriggerAt === postRecoveryOwnerAt16
      && postRecoveryGetAfter16.pwmRetryKind === 'smart-on-safe-delay'
      && postRecoveryGetAfter16.pwmRetryBoundaryAt === cooldownBoundary16
      && postRecoveryGetAfter16.pwmRetryScheduledAt === postRecoveryOwnerAt16
      && postRecoveryGetFailure16.live() === postRecoveryOwnerAt16,
    '16F-0B-2A-3: expired recovery 换到 revision 3 并提交 future phase 后，即使 advance postcondition 读取异常，旧 sync catch 也不能清新 owner 的 durable/live 钟');

  const incompleteSyncReplacement16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16 + 30 * 60_000,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    alarmCreatedAt: cooldownBoundary16 - 4 * 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, cooldownBoundary16 + 30 * 60_000, 0, {
    Date: CooldownAdoptionDate16,
    expiredRecoveryAt: postRecoveryOwnerAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: cooldownBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    expiredRecoveryPersistFailure: true,
    repairFutureAt: postRecoveryOwnerAt16
  });
  const incompleteSyncApplied16 = await incompleteSyncReplacement16.apply({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    syncedAt: cooldownNow16 + 3
  }, 'test-incomplete-replacement-owner');
  const incompleteSyncRepairQueued16 = incompleteSyncReplacement16
    .drainRepair('test-incomplete-replacement-owner');
  await Promise.resolve();
  const incompleteSyncAfter16 = incompleteSyncReplacement16.snapshot();
  const incompleteSyncDurable16 = incompleteSyncReplacement16.durable();
  const incompleteSyncRepairCall16 = incompleteSyncReplacement16.calls.find(
    call => call.type === 'repair-clock'
  );
  assertPass(durableLivePwmOwnerSource16.includes(
      'chrome.storage.local.get(STORAGE_KEY)')
      && durableLivePwmOwnerSource16.includes("chrome.alarms.get('ac-pwm')")
      && durableLivePwmOwnerSource16.includes(
        'durableSchedule.pwmState !== schedule.pwmState')
      && durableLivePwmOwnerSource16.includes('assessPwmAlarmDelivery(')
      && incompleteSyncApplied16 === true
      && incompleteSyncReplacement16.revision() === 3
      && incompleteSyncReplacement16.calls.filter(call =>
        call.type === 'expired-recovery-persist-failure').length === 1
      && incompleteSyncReplacement16.calls.filter(call =>
        call.type === 'infra'
          && call.name === 'ac-watchdog').length === 1
      && incompleteSyncRepairQueued16 === true
      && incompleteSyncRepairCall16?.options.smartOnExpectedBoundaryAt
        === cooldownBoundary16
      && incompleteSyncRepairCall16?.options.revokeInvalidSmartOnClock === true
      && incompleteSyncRepairCall16?.options.revokeOwnerRevision === 3
      && incompleteSyncRepairCall16?.options
        .preserveRevokeAcrossSupersededRepair === true
      && incompleteSyncAfter16.nextTriggerAt === postRecoveryOwnerAt16
      && incompleteSyncAfter16.nextTriggerAt
        !== cooldownBoundary16 + 30 * 60_000
      && incompleteSyncAfter16.pwmRetryKind === 'smart-on-safe-delay'
      && incompleteSyncAfter16.pwmRetryBoundaryAt === cooldownBoundary16
      && incompleteSyncAfter16.pwmRetryScheduledAt === postRecoveryOwnerAt16
      && incompleteSyncDurable16.nextTriggerAt === postRecoveryOwnerAt16
      && incompleteSyncDurable16.pwmRetryKind === 'smart-on-safe-delay'
      && incompleteSyncReplacement16.live() === postRecoveryOwnerAt16,
    '16F-0B-2A-4: sync expired recovery 仅 claim revision 3、intent persist 失败且无 live 时不假保护；沿原 19:00 立即修到 durable/live 19:05 typed safe-delay');

  let releaseSyncReplacementProof16;
  let markSyncReplacementProofStarted16;
  const syncReplacementProofGate16 = new Promise(resolve => {
    releaseSyncReplacementProof16 = resolve;
  });
  const syncReplacementProofStarted16 = new Promise(resolve => {
    markSyncReplacementProofStarted16 = resolve;
  });
  const supersedingSyncOwnerAt16 = cooldownNow16 + 6 * 60_000;
  const replacementProofRace16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16 + 30 * 60_000,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    alarmCreatedAt: cooldownBoundary16 - 4 * 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, cooldownBoundary16 + 30 * 60_000, 0, {
    Date: CooldownAdoptionDate16,
    expiredRecoveryAt: postRecoveryOwnerAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: cooldownBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    expiredRecoveryPersistFailure: true,
    replacementProofGate: syncReplacementProofGate16,
    onReplacementProofStart: markSyncReplacementProofStarted16,
    supersedingBoundaryAt: cooldownBoundary16
  });
  const replacementProofRaceApply16 = replacementProofRace16.apply({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    syncedAt: cooldownNow16 + 4
  }, 'test-replacement-proof-owner-race');
  await syncReplacementProofStarted16;
  const supersedingSyncRevision16 = replacementProofRace16
    .supersedeReplacementOwner(supersedingSyncOwnerAt16);
  releaseSyncReplacementProof16();
  const replacementProofRaceApplied16 = await replacementProofRaceApply16;
  const replacementProofRaceDrained16 = replacementProofRace16.drainRepair(
    'test-replacement-proof-owner-race'
  );
  const replacementProofRaceAfter16 = replacementProofRace16.snapshot();
  const replacementProofRaceDurable16 = replacementProofRace16.durable();
  assertPass(stableDurableLivePwmOwnerSource16.includes(
      'for (let attempt = 0; attempt < 4; attempt += 1)')
      && stableDurableLivePwmOwnerSource16.includes(
        'committed = await hasDurableLivePwmOwner(candidateRevision)')
      && stableDurableLivePwmOwnerSource16.includes(
        'candidateRevision = pwmRuntimeRevision;')
      && applySyncedPhaseBody.includes(
        'const replacementProof = await proveStableDurableLivePwmOwner(')
      && replacementProofRaceApplied16 === true
      && supersedingSyncRevision16 === 4
      && replacementProofRace16.revision() === 4
      && replacementProofRaceDrained16 === false
      && !replacementProofRace16.calls.some(call =>
        call.type === 'repair-clock'
          || (call.type === 'infra' && call.name === 'ac-watchdog'))
      && replacementProofRaceAfter16.nextTriggerAt
        === supersedingSyncOwnerAt16
      && replacementProofRaceDurable16.nextTriggerAt
        === supersedingSyncOwnerAt16
      && replacementProofRace16.live() === supersedingSyncOwnerAt16,
    '16F-0B-2A-5: replacement proof await 期间换成三方完整 revision 4 后重证成功；旧 sync catch 零 mutation/queue/watchdog');

  let releaseIncompleteSyncReplacementProof16;
  let markIncompleteSyncReplacementProofStarted16;
  const incompleteSyncReplacementProofGate16 = new Promise(resolve => {
    releaseIncompleteSyncReplacementProof16 = resolve;
  });
  const incompleteSyncReplacementProofStarted16 = new Promise(resolve => {
    markIncompleteSyncReplacementProofStarted16 = resolve;
  });
  const incompleteSyncProofOwnerAt16 = cooldownNow16 + 6 * 60_000;
  const incompleteSyncProofRace16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16 + 30 * 60_000,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    alarmCreatedAt: cooldownBoundary16 - 4 * 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, cooldownBoundary16 + 30 * 60_000, 0, {
    Date: CooldownAdoptionDate16,
    expiredRecoveryAt: postRecoveryOwnerAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: cooldownBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    expiredRecoveryPersistFailure: true,
    replacementProofGate: incompleteSyncReplacementProofGate16,
    onReplacementProofStart: markIncompleteSyncReplacementProofStarted16,
    supersedingBoundaryAt: cooldownBoundary16,
    repairFutureAt: postRecoveryOwnerAt16
  });
  const incompleteSyncProofApply16 = incompleteSyncProofRace16.apply({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: cooldownBoundary16,
    smartClockPlannedAt: cooldownBoundary16 - 4 * 60_000,
    syncedAt: cooldownNow16 + 5
  }, 'test-incomplete-replacement-proof-owner-race');
  await incompleteSyncReplacementProofStarted16;
  const incompleteSyncProofRevision16 = incompleteSyncProofRace16
    .supersedeIncompleteReplacementOwner(incompleteSyncProofOwnerAt16);
  releaseIncompleteSyncReplacementProof16();
  const incompleteSyncProofApplied16 = await incompleteSyncProofApply16;
  const incompleteSyncProofDrained16 = incompleteSyncProofRace16.drainRepair(
    'test-incomplete-replacement-proof-owner-race'
  );
  await Promise.resolve();
  const incompleteSyncProofAfter16 = incompleteSyncProofRace16.snapshot();
  const incompleteSyncProofDurable16 = incompleteSyncProofRace16.durable();
  const incompleteSyncProofRepairCall16 = incompleteSyncProofRace16.calls.find(
    call => call.type === 'repair-clock'
  );
  assertPass(incompleteSyncProofApplied16 === true
      && incompleteSyncProofRevision16 === 4
      && incompleteSyncProofRace16.revision() === 4
      && incompleteSyncProofDrained16 === true
      && incompleteSyncProofRace16.calls.filter(call =>
        call.type === 'infra' && call.name === 'ac-watchdog').length === 1
      && incompleteSyncProofRepairCall16?.options.smartOnExpectedBoundaryAt
        === cooldownBoundary16
      && incompleteSyncProofRepairCall16?.options.revokeOwnerRevision === 4
      && incompleteSyncProofRepairCall16?.options
        .preserveRevokeAcrossSupersededRepair === true
      && incompleteSyncProofAfter16.nextTriggerAt === postRecoveryOwnerAt16
      && incompleteSyncProofAfter16.nextTriggerAt
        !== incompleteSyncProofOwnerAt16
      && incompleteSyncProofAfter16.pwmRetryKind === 'smart-on-safe-delay'
      && incompleteSyncProofAfter16.pwmRetryBoundaryAt === cooldownBoundary16
      && incompleteSyncProofAfter16.pwmRetryScheduledAt
        === postRecoveryOwnerAt16
      && incompleteSyncProofDurable16.nextTriggerAt === postRecoveryOwnerAt16
      && incompleteSyncProofRace16.live() === postRecoveryOwnerAt16,
    '16F-0B-2A-6: replacement proof await 期间换成不完整 revision 4 后重证失败；sync catch 沿原 19:00 收口 durable/live 19:05 typed safe-delay');

  // 源端重启：自己同步回来的 OFF 哨兵不能覆盖仍由本机持有的安全事务。
  const ownedSync16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: localRetryAt16,
    smartClockPlannedAt: syncApplyNow16,
    alarmCreatedAt: syncApplyNow16,
    pwmRetryKind: 'smart-on-safety-timer',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: localRetryAt16
  }, localRetryAt16);
  const ownedApplied16 = await ownedSync16.apply(sentinelRemote16, 'test-owned');
  const ownedAfter16 = ownedSync16.snapshot();

  // 旧端：同时戳的旧 ON actuator 必须被 OFF 哨兵替换，且 enabled 保持 true。
  const peerSync16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: sentinelAt16,
    smartClockPlannedAt: syncApplyNow16,
    alarmCreatedAt: syncApplyNow16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, sentinelAt16);
  const sentinelApplied16 = await peerSync16.apply(sentinelRemote16, 'test-peer');
  const peerAfterSentinel16 = peerSync16.snapshot();

  // 源端随后提交正常 OFF deadline：应替换哨兵，而不走 setup/toggle 路径。
  const normalAt16 = syncApplyNow16
    + Math.max(1_000, Math.floor((sentinelAt16 - syncApplyNow16) / 2));
  const normalApplied16 = await peerSync16.apply({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: normalAt16,
    smartClockPlannedAt: syncApplyNow16 + 1000,
    syncedAt: syncApplyNow16 + 2
  }, 'test-normal');
  const createCalls16 = peerSync16.calls.filter(c => c.type === 'create-pwm');

  // 本机旧 runPwmStep 已进入页面长事务时，远端 OFF safety sentinel
  // 必须先抢 revision、取消自动 ON，再持久化并重排 OFF；旧事务解锁后失效。
  let releasePausedAutomaticOn16;
  const pausedAutomaticOnGate16 = new Promise(resolve => {
    releasePausedAutomaticOn16 = resolve;
  });
  const remoteOffPreemption16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: sentinelAt16,
    smartClockPlannedAt: syncApplyNow16,
    alarmCreatedAt: syncApplyNow16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, sentinelAt16);
  const pausedOldAutomaticOn16 = remoteOffPreemption16
    .runPausedAutomaticOn(pausedAutomaticOnGate16);
  await Promise.resolve();
  const remoteOffPreemptionApplied16 = await remoteOffPreemption16.apply(
    sentinelRemote16,
    'test-remote-off-preempts-paused-auto-on'
  );
  releasePausedAutomaticOn16();
  const pausedOldAutomaticOnResult16 = await pausedOldAutomaticOn16;
  const remoteOffPreemptionAfter16 = remoteOffPreemption16.snapshot();
  assertPass(remoteOffPreemptionApplied16 === true
      && pausedOldAutomaticOnResult16 === false
      && remoteOffPreemption16.revision() === 2
      && remoteOffPreemption16.calls.some(c => c.type === 'invalidate-shutdown'
        && c.revision === 2)
      && remoteOffPreemption16.calls.some(c => c.type === 'cancel-automatic-on'
        && c.revision === 2)
      && remoteOffPreemption16.calls.some(c => c.type === 'old-auto-stale'
        && c.revision === 1)
      && !remoteOffPreemption16.calls.some(c => c.type === 'old-auto-on'
        || c.reason === 'old-auto-on')
      && remoteOffPreemption16.calls.some(c => c.type === 'persist'
        && c.reason === 'sync-phase-adopt-intent'
        && c.pwmState === 'off'
        && c.nextTriggerAt === sentinelAt16)
      && remoteOffPreemption16.calls.some(c => c.type === 'create-pwm'
        && c.revision === 2
        && c.at === sentinelAt16)
      && remoteOffPreemptionAfter16.pwmState === 'off'
      && remoteOffPreemptionAfter16.nextTriggerAt === sentinelAt16
      && remoteOffPreemption16.live() === sentinelAt16,
    '16F-0B-2B: remote OFF sentinel 抢占暂停中的旧自动 ON；取消已发送，旧 revision 解锁后不再开机或回写');

  // phase adoption 已抢 revision、但 cancelAutomaticOnRequests 尚未完成的
  // await 窗口内，旧 ac-pwm 仍可能送达。独立 admission reservation 必须让
  // production shared executor 在 claim/click 前返回；释放后只落一个远端 OFF alarm。
  let releaseSyncPhaseCancel16;
  let markSyncPhaseCancelStarted16;
  const syncPhaseCancelGate16 = new Promise(resolve => {
    releaseSyncPhaseCancel16 = resolve;
  });
  const syncPhaseCancelStarted16 = new Promise(resolve => {
    markSyncPhaseCancelStarted16 = resolve;
  });
  const gatedSyncPhaseAdoption16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'on',
    nextTriggerAt: sentinelAt16,
    smartClockPlannedAt: syncApplyNow16,
    alarmCreatedAt: syncApplyNow16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, sentinelAt16, 0, {
    cancelAutomaticOnGate: syncPhaseCancelGate16,
    onCancelAutomaticOn: markSyncPhaseCancelStarted16
  });
  const gatedRemoteOffApply16 = gatedSyncPhaseAdoption16.apply(
    sentinelRemote16,
    'test-admission-blocks-old-ac-pwm-during-cancel'
  );
  await syncPhaseCancelStarted16;
  const revisionDuringSyncPhaseCancel16 = gatedSyncPhaseAdoption16.revision();
  const admissionHeldDuringCancel16 = gatedSyncPhaseAdoption16
    .phaseAdmissionBlocked();
  const phaseGateScheduleBeforeIngress16 = JSON.stringify(
    gatedSyncPhaseAdoption16.snapshot()
  );
  await gatedSyncPhaseAdoption16.deliverRejectedOldAlarm(sentinelAt16);
  await gatedSyncPhaseAdoption16.runWatchdog();
  const phaseGateScheduleAfterIngress16 = JSON.stringify(
    gatedSyncPhaseAdoption16.snapshot()
  );
  const phaseGateIngressSideEffects16 = gatedSyncPhaseAdoption16.calls.filter(c =>
    c.type === 'storage-reload'
      || c.type === 'repair-clock'
      || c.type === 'watchdog-recovery');
  const deliveredOldAcPwm16 = await gatedSyncPhaseAdoption16
    .deliverOldAcPwm(sentinelAt16);
  const oldDeliveryBlockedBeforeClaim16 = deliveredOldAcPwm16.result === false
    && deliveredOldAcPwm16.deliveredRevision === revisionDuringSyncPhaseCancel16
    && gatedSyncPhaseAdoption16.revision() === revisionDuringSyncPhaseCancel16
    && !gatedSyncPhaseAdoption16.calls.some(c =>
      c.type === 'old-ac-pwm-claim' || c.type === 'old-ac-pwm-click');
  releaseSyncPhaseCancel16();
  const gatedRemoteOffApplied16 = await gatedRemoteOffApply16;
  const gatedRemoteOffAfter16 = gatedSyncPhaseAdoption16.snapshot();
  const gatedRemoteOffCreates16 = gatedSyncPhaseAdoption16.calls.filter(c =>
    c.type === 'create-pwm');
  assertPass(revisionDuringSyncPhaseCancel16 === 2
      && admissionHeldDuringCancel16
      && oldDeliveryBlockedBeforeClaim16
      && gatedRemoteOffApplied16 === true
      && gatedSyncPhaseAdoption16.phaseAdmissionBlocked() === false
      && gatedSyncPhaseAdoption16.calls.filter(c =>
        c.type === 'persist' && c.reason === 'sync-phase-adopt-intent').length === 1
      && gatedSyncPhaseAdoption16.calls.some(c =>
        c.type === 'persist'
          && c.reason === 'sync-phase-adopt-intent'
          && c.pwmState === 'off'
          && c.nextTriggerAt === sentinelAt16)
      && gatedRemoteOffCreates16.length === 1
      && gatedRemoteOffCreates16[0].revision === revisionDuringSyncPhaseCancel16
      && gatedRemoteOffCreates16[0].at === sentinelAt16
      && gatedRemoteOffAfter16.pwmState === 'off'
      && gatedRemoteOffAfter16.nextTriggerAt === sentinelAt16
      && gatedSyncPhaseAdoption16.live() === sentinelAt16,
    '16F-0B-2D: sync phase cancel await 持有 admission；旧 ac-pwm/shared executor 无法 claim/click，释放后只 durable/rearm 一个 OFF');
  assertPass(phaseSensitiveAlarmGateBody16.indexOf(
      'if (phaseSensitiveAlarm && isSyncPhaseAdoptionAdmissionBlocked())'
    ) < phaseSensitiveAlarmGateBody16.indexOf('await loadScheduleFromStorage();')
      && watchdogBody13.indexOf('if (isSyncPhaseAdoptionAdmissionBlocked()) return;')
        < watchdogBody13.indexOf('await loadScheduleFromStorage();')
      && phaseGateIngressSideEffects16.length === 0
      && phaseGateScheduleAfterIngress16 === phaseGateScheduleBeforeIngress16
      && gatedSyncPhaseAdoption16.calls.filter(c =>
        c.type === 'persist' && c.reason === 'sync-phase-adopt-intent').length === 1
      && gatedRemoteOffCreates16.length === 1
      && gatedRemoteOffCreates16[0].at === sentinelAt16
      && gatedRemoteOffAfter16.pwmState === 'off'
      && gatedRemoteOffAfter16.nextTriggerAt === sentinelAt16,
    '16F-0B-2E: phase reservation 在 storage reload 前拒绝旧失配 ac-pwm/watchdog，零 repair/零 mutation；释放后远端 OFF 唯一 durable/rearm');

  // timer-only repair 携带明确近期 OFF；对端已有更早 OFF deadline
  // 必须原样保留。
  const peerEarlyOffAt16 = syncApplyNow16 + 30_000;
  const peerSafetyTimer16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000,
    alarmCreatedAt: syncApplyNow16 - 60_000,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, peerEarlyOffAt16);
  await peerSafetyTimer16.apply({
    ...safetyTimerPayload6,
    syncedAt: syncApplyNow16 + 3
  }, 'test-safety-timer-explicit-off');

  // disabled/new peer 收到 safety-timer 时必须采纳明确 OFF phase，
  // 不得走 enabled false→true 的无相位立即启动分支。
  const disabledSafetyPeer16 = loadActualSyncApply16({
    ...syncCfg16,
    enabled: false,
    pwmState: 'off',
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    alarmCreatedAt: 0,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  });
  const disabledSafetyApplied16 = await disabledSafetyPeer16.apply({
    ...safetyTimerPayload6,
    syncedAt: syncApplyNow16 + 4
  }, 'test-disabled-peer-safety-off');
  // 冻结 v0.8.2 接收端的关键分支：enabled 新开且无 phase 才会
  // setupAlarms(true)。明确 OFF phase 使旧端也只建 OFF alarm。
  const legacy082SafetyReception16 = (() => {
    const local = { enabled: false, nextTriggerAt: 0 };
    const remote = safetyTimerPayload6;
    const phaseAccepted = Number(remote.nextTriggerAt) > syncApplyNow16;
    return {
      immediateStart: local.enabled !== remote.enabled
        && remote.enabled === true
        && !phaseAccepted,
      scheduledAction: phaseAccepted ? remote.pwmState : ''
    };
  })();

  // 慢时钟旧端后发的显式 disable 即使 syncedAt 小于本机 watermark，
  // 也必须停止自动控制。
  const fastWatermark16 = syncApplyNow16 + 50_000;
  const slowDisablePeer16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000
  }, peerEarlyOffAt16, fastWatermark16);
  const slowDisableApplied16 = await slowDisablePeer16.apply({
    ...syncCfg16,
    enabled: false,
    pwmState: 'off',
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    syncedAt: 2000
  }, 'test-old-peer-slow-clock-disable');

  // 本机正常 phase 已在旧哨兵之后 durable commit；SW 重启后仍须用本地
  // watermark 拒绝自己的旧哨兵，不能把正常 OFF deadline 回滚。
  const localNormalAfterSentinelAt16 = syncApplyNow16 + 12 * 60_000;
  const restartedAfterNormal16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: localNormalAfterSentinelAt16,
    smartClockPlannedAt: syncApplyNow16 + 2,
    alarmCreatedAt: syncApplyNow16 + 2,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  }, localNormalAfterSentinelAt16, sentinelRemote16.syncedAt);
  const staleSelfApplied16 = await restartedAfterNormal16.apply(
    sentinelRemote16,
    'test-restart-old-self-sentinel'
  );
  // watermark 首读暂时失败时，同一次 init-style 采纳会有界重读；
  // 连续两次失败则 fail closed，且不抛出中断后续本地 init。
  const watermarkReadRetry16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000
  }, peerEarlyOffAt16, 0, { watermarkGetFailures: 1 });
  const configOnlyRemote16 = {
    ...syncCfg16,
    onMinutes: 24,
    pwmState: 'off',
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    syncedAt: syncApplyNow16 + 10
  };
  const appliedAfterBoundedWatermarkRetry16 = await watermarkReadRetry16.apply(
    configOnlyRemote16,
    'test-watermark-read-failure'
  );
  const watermarkReadClosed16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000
  }, peerEarlyOffAt16, 0, { watermarkGetFailures: 2 });
  const blockedAfterTwoWatermarkFailures16 = await watermarkReadClosed16.apply(
    configOnlyRemote16,
    'test-watermark-read-fail-closed'
  );

  // 连续 watermark 读取失败会留下 adopt retry；同一 production apply
  // 在 alarm 重试时应采纳远端 disable，无需第二次用户操作。
  const inboundDisableRetry16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000
  }, peerEarlyOffAt16, 0, { watermarkGetFailures: 2 });
  const inboundDisableRemote16 = {
    ...syncCfg16,
    enabled: false,
    pwmState: 'off',
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    syncedAt: syncApplyNow16 + 11
  };
  const blockedInboundDisable16 = await inboundDisableRetry16.apply(
    inboundDisableRemote16,
    'test-inbound-disable-watermark-failure'
  );
  const appliedInboundDisableAfterRetry16 = await inboundDisableRetry16.apply(
    inboundDisableRemote16,
    'alarm-sync-adopt-retry'
  );

  // inbound enabled=true 在 config 前的 alarm read 被挂起时，本机明确停用
  // 必须通过 admission epoch 抢占；恢复后不能持久化 true，publish retry 发 false。
  let releaseInboundEnableBeforeConfig16;
  let markInboundEnableBeforeConfig16;
  const inboundEnableBeforeConfigGate16 = new Promise(resolve => {
    releaseInboundEnableBeforeConfig16 = resolve;
  });
  const inboundEnableBeforeConfigStarted16 = new Promise(resolve => {
    markInboundEnableBeforeConfig16 = resolve;
  });
  const inboundEnablePreempted16 = loadActualSyncApply16({
    ...syncCfg16,
    smartMode: { enabled: false, sensitivity: 5 },
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000
  }, peerEarlyOffAt16, 0, {
    pwmAlarmGate: inboundEnableBeforeConfigGate16,
    onPwmAlarmGet: markInboundEnableBeforeConfig16
  });
  const inboundEnableApply16 = inboundEnablePreempted16.apply({
    ...syncCfg16,
    smartMode: { enabled: false, sensitivity: 5 },
    onMinutes: 29,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000,
    syncedAt: syncApplyNow16 + 12
  }, 'test-inbound-enable-preempted-before-config');
  await inboundEnableBeforeConfigStarted16;
  const inboundDisableClaimEpoch16 = await inboundEnablePreempted16.disable();
  releaseInboundEnableBeforeConfig16();
  const inboundEnablePreemptedResult16 = await inboundEnableApply16;
  const inboundEnablePreemptedAfter16 = inboundEnablePreempted16.snapshot();
  const inboundEnableRetryPublisher16 = loadActualSyncProtocol6({
    wallNow: 30_000,
    initialPendingPublish: true,
    schedule: inboundEnablePreemptedAfter16
  });
  const inboundEnableRetryPublishResult16 = await inboundEnableRetryPublisher16
    .sync('alarm-sync-publish-retry-after-inbound-preempt');
  assertPass(inboundDisableClaimEpoch16 === 1
      && inboundEnablePreemptedResult16 === false
      && inboundEnablePreemptedAfter16.enabled === false
      && inboundEnablePreemptedAfter16.onMinutes === syncCfg16.onMinutes
      && inboundEnablePreempted16.pending() === true
      && inboundEnablePreempted16.calls.some(c => c.type === 'disable-intent'
        && c.enabled === false
        && c.pending === true)
      && !inboundEnablePreempted16.calls.some(c => c.type === 'persist'
        && c.enabled === true)
      && inboundEnableRetryPublishResult16 === true
      && inboundEnableRetryPublisher16.state.syncWrites.length === 1
      && inboundEnableRetryPublisher16.state.syncWrites[0].enabled === false,
    '16F-0B-2C: config 前挂起的 inbound enable 被原子 disable intent 抢占；不落 true，publish retry 只发 false');

  // schedule persist 失败时不得先推进 watermark；内存 diff 已变空的
  // 第二次尝试仍要重落 schedule，成功后才标记已处理。
  const schedulePersistRetry16 = loadActualSyncApply16({
    ...syncCfg16,
    pwmState: 'off',
    nextTriggerAt: peerEarlyOffAt16,
    smartClockPlannedAt: syncApplyNow16 - 60_000
  }, peerEarlyOffAt16, 0, { schedulePersistFailures: 1 });
  let firstSchedulePersistThrew16 = false;
  try {
    await schedulePersistRetry16.apply(
      configOnlyRemote16,
      'test-schedule-persist-failure'
    );
  } catch (_) {
    firstSchedulePersistThrew16 = true;
  }
  const watermarkAfterFailedPersist16 = schedulePersistRetry16.lastSyncedAt();
  const durableAfterFailedPersist16 = schedulePersistRetry16.durableWatermark();
  const appliedAfterSchedulePersistRetry16 = await schedulePersistRetry16.apply(
    configOnlyRemote16,
    'test-schedule-persist-retry'
  );
  assertPass(ownedApplied16 === false
      && ownedAfter16.pwmRetryKind === 'smart-on-safety-timer'
      && ownedSync16.live() === localRetryAt16
      && ownedSync16.calls.some(c => c.type === 'persist')
      && !ownedSync16.calls.some(c => c.type === 'create-pwm'
        || c.type === 'setup'
        || c.type === 'reset-disabled'
        || c.type === 'shutdown')
      && sentinelApplied16 === true
      && peerAfterSentinel16.enabled === true
      && peerAfterSentinel16.pwmState === 'off'
      && createCalls16[0]?.at === sentinelAt16
      && normalApplied16 === true
      && peerSync16.live() === normalAt16
      && createCalls16[1]?.at === normalAt16
      && peerSync16.snapshot().smartClockPlannedAt === syncApplyNow16 + 1000
      && peerSafetyTimer16.live() === peerEarlyOffAt16
      && peerSafetyTimer16.snapshot().pwmState === 'off'
      && !peerSafetyTimer16.calls.some(c => c.type === 'create-pwm')
      && disabledSafetyApplied16 === true
      && disabledSafetyPeer16.snapshot().enabled === true
      && disabledSafetyPeer16.snapshot().pwmState === 'off'
      && disabledSafetyPeer16.live() === safetyTimerPayload6.nextTriggerAt
      && !disabledSafetyPeer16.calls.some(c => c.type === 'setup'
        || c.type === 'shutdown')
      && legacy082SafetyReception16.immediateStart === false
      && legacy082SafetyReception16.scheduledAction === 'off'
      && slowDisableApplied16 === true
      && slowDisablePeer16.snapshot().enabled === false
      && slowDisablePeer16.calls.some(c => c.type === 'reset-disabled')
      && slowDisablePeer16.calls.some(c => c.type === 'shutdown')
      && slowDisablePeer16.lastSyncedAt() === fastWatermark16
      && slowDisablePeer16.durableWatermark() === fastWatermark16
      && staleSelfApplied16 === false
      && restartedAfterNormal16.live() === localNormalAfterSentinelAt16
      && restartedAfterNormal16.calls.length === 0
      && !peerSync16.calls.some(c => c.type === 'setup'
        || c.type === 'reset-disabled'
        || c.type === 'shutdown'),
    '16F-0B-2: actual sync 保留较早 OFF，timer-only 对新／旧 peer 只排 OFF，慢时钟 disable 仍抢占，自有旧哨兵不回滚');
  assertPass(appliedAfterBoundedWatermarkRetry16 === true
      && watermarkReadRetry16.snapshot().onMinutes === 24
      && watermarkReadRetry16.lastSyncedAt() === configOnlyRemote16.syncedAt
      && blockedAfterTwoWatermarkFailures16 === false
      && watermarkReadClosed16.snapshot().onMinutes === syncCfg16.onMinutes
      && watermarkReadClosed16.calls.some(c => c.type === 'infra'
        && c.name === 'ac-sync-adopt-retry')
      && blockedInboundDisable16 === false
      && appliedInboundDisableAfterRetry16 === true
      && inboundDisableRetry16.snapshot().enabled === false
      && inboundDisableRetry16.calls.some(c => c.type === 'infra'
        && c.name === 'ac-sync-adopt-retry')
      && inboundDisableRetry16.calls.some(c => c.type === 'reset-disabled')
      && inboundDisableRetry16.calls.some(c => c.type === 'shutdown')
      && firstSchedulePersistThrew16
      && watermarkAfterFailedPersist16 === 0
      && durableAfterFailedPersist16 === 0
      && appliedAfterSchedulePersistRetry16 === false
      && schedulePersistRetry16.snapshot().onMinutes === 24
      && schedulePersistRetry16.calls.filter(c => c.type === 'persist').length === 2
      && schedulePersistRetry16.lastSyncedAt() === configOnlyRemote16.syncedAt
      && schedulePersistRetry16.durableWatermark() === configOnlyRemote16.syncedAt
      && applySyncedPhaseBody.includes("await scheduleSyncRetry('adopt');"),
    '16F-0B-2A: actual inbound watermark 首读失败同调用重试，连失败留 durable retry；alarm 后采纳 disable；schedule 先 durable 后标记 remote');
  const firstAttemptAt16 = retryBoundary16 + 202;
  const failedTransactionSchedule16 = {
    enabled: true,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmState: 'on',
    onMinutes: 22,
    offMinutes: 8,
    smartOnBoundaryAt: retryBoundary16,
    nextTriggerAt: 0,
    pageTimerError: '',
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  };
  const firstFailurePlan16 = pwmPhase.planPwmStep(
    failedTransactionSchedule16,
    {
      acIsOn: false,
      toggleSucceeded: false,
      toggleError: '新建的 AC 页面未就绪'
    },
    { now: firstAttemptAt16 }
  );
  Object.assign(failedTransactionSchedule16, firstFailurePlan16.phasePatch);
  failedTransactionSchedule16.pageTimerError = '新建的 AC 页面未就绪';
  const failedTransactionHarness16 = loadRetryStateHarness16(
    failedTransactionSchedule16
  );
  failedTransactionHarness16.set('on', firstFailurePlan16.nextTriggerAt);
  const reloadedFailedTransaction16 = JSON.parse(JSON.stringify(
    failedTransactionHarness16.snapshot()
  ));
  const retryTransactionHarness16 = loadRetryStateHarness16(
    reloadedFailedTransaction16
  );
  const consumedRetryContext16 = retryTransactionHarness16.get(
    reloadedFailedTransaction16,
    firstFailurePlan16.nextTriggerAt
  );
  const retryWindow16 = pwmPhase.planSmartModeOnWindow(
    reloadedFailedTransaction16,
    {
      now: firstFailurePlan16.nextTriggerAt,
      maxOnMinutes: 25,
      acIsOn: false,
      boundaryAt: consumedRetryContext16.boundaryAt,
      triggeredBoundaryAt: consumedRetryContext16.boundaryAt,
      recoverCurrentCycle: true
    }
  );
  const retryTogglePlan16 = pwmPhase.planPwmStep(
    reloadedFailedTransaction16,
    { acIsOn: false },
    { now: firstFailurePlan16.nextTriggerAt }
  );
  const retryTimerPlan16 = pwmPhase.planPwmStep(
    reloadedFailedTransaction16,
    { acIsOn: false, toggleSucceeded: true },
    { now: firstFailurePlan16.nextTriggerAt }
  );
  const retryCommitPlan16 = pwmPhase.planPwmStep(
    reloadedFailedTransaction16,
    {
      acIsOn: true,
      pageTimerSucceeded: true,
      pageTimerTargetAt: retryWindow16.pageTimerTargetAt
    },
    { now: firstFailurePlan16.nextTriggerAt }
  );
  const overdueRetryNow16 = retryBoundary16 + 23 * 60_000;
  const overdueRetryWindow16 = pwmPhase.planSmartModeOnWindow(
    reloadedFailedTransaction16,
    {
      now: overdueRetryNow16,
      maxOnMinutes: 25,
      acIsOn: false,
      boundaryAt: consumedRetryContext16.boundaryAt,
      triggeredBoundaryAt: firstFailurePlan16.nextTriggerAt,
      recoverCurrentCycle: false
    }
  );
  Object.assign(reloadedFailedTransaction16, retryCommitPlan16.phasePatch);
  retryTransactionHarness16.clear();
  assertPass(firstFailurePlan16.kind === 'retry'
      && firstFailurePlan16.reason === 'toggle-on-failed'
      && firstFailurePlan16.nextTriggerAt === firstAttemptAt16 + 60_000
      && consumedRetryContext16.hasTypedSmartOnRetry === true
      && retryWindow16.kind === 'allow'
      && retryWindow16.boundaryAt === retryBoundary16
      && retryWindow16.pageTimerTargetAt === retryBoundary16 + 22 * 60_000
      && retryTogglePlan16.kind === 'hold'
      && retryTogglePlan16.prerequisite === 'toggle-on'
      && retryTimerPlan16.kind === 'hold'
      && retryTimerPlan16.prerequisite === 'set-page-timer'
      && retryCommitPlan16.kind === 'commit'
      && retryCommitPlan16.nextTriggerAt === retryBoundary16 + 22 * 60_000
      && overdueRetryWindow16.kind === 'defer'
      && overdueRetryWindow16.nextTriggerAt === retryBoundary16 + 30 * 60_000
      && reloadedFailedTransaction16.pwmState === 'off'
      && reloadedFailedTransaction16.pwmRetryKind === ''
      && reloadedFailedTransaction16.pwmRetryBoundaryAt === 0
      && reloadedFailedTransaction16.pwmRetryScheduledAt === 0,
    '16F-0B-1C: 动态执行 首轮 toggle 失败→JSON 重载→22:31 typed retry→原 22:30 截止 commit，并在终态清 marker');
  const retryPlanStart16 = pwmBody.indexOf('async function resolveRetryPlan(');
  const retryPlanEnd16 = pwmBody.indexOf('\n\n  return waitUntil(', retryPlanStart16);
  const retryPlanSource16 = retryPlanStart16 >= 0 && retryPlanEnd16 > retryPlanStart16
    ? pwmBody.slice(retryPlanStart16, retryPlanEnd16)
    : '';
  assertPass(retryPlanSource16.includes("kind: 'smart-on-safety-timer'")
      && retryPlanSource16.includes('const retryMarkerOptions = timerRepairOnly')
      && retryPlanSource16.indexOf('setSmartOnPwmRetryState(\n      targetAction,\n      plan.nextTriggerAt,') >= 0
      && retryPlanSource16.indexOf("persistSchedule('runPwmStep-retry-intent'")
        > retryPlanSource16.indexOf('setSmartOnPwmRetryState(\n      targetAction,\n      plan.nextTriggerAt,')
      && retryPlanSource16.indexOf('createPwmAlarmFromPlan(')
        > retryPlanSource16.indexOf("persistSchedule('runPwmStep-retry-intent'")
      && retryPlanSource16.indexOf('setSmartOnPwmRetryState(\n      targetAction,\n      schedule.nextTriggerAt,')
        > retryPlanSource16.indexOf('createPwmAlarmFromPlan(')
      && pwmBody.includes('getSmartOnPwmRetryContext(')
      && pwmBody.includes('recoverCurrentCycle: retryingSmartOn')
      && pwmBody.includes('triggeredBoundaryAt: retryingSmartOn')
      && pwmBody.includes('clearPwmRetryState()')
      && pwmBody.includes('rejectedSmartOnRetryError')
      && pwmBody.includes('智能开机重试身份不匹配')
      && pwmBody.includes('本周期智能开机重试已超过安全关机余量'),
    '16F-0B-1A: retry intent 先持久化再建 alarm、再写 canonical 时刻；失配和超窗都保留红灯而非静默延期');
  const timerOnlyRetrySchedule16 = {
    enabled: true,
    pwmState: 'on',
    nextTriggerAt: 0,
    pageTimerError: '',
    smartOnBoundaryAt: retryBoundary16,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  };
  const timerOnlyRetryOrder16 = [];
  const resolveTimerOnlyRetry16 = new Function(
    'schedule', 'applyPwmPlanState', 'setSmartOnPwmRetryState',
    'persistSchedule', 'createPwmAlarmFromPlan', 'automationRevision',
    'isAutomationOperationCurrent', 'createAlarm', 'abortStaleAutomation',
    'updateBadge', 'syncScheduleToSync',
    `${retryPlanSource16}; return resolveRetryPlan;`
  )(
    timerOnlyRetrySchedule16,
    plan => Object.assign(timerOnlyRetrySchedule16, plan.phasePatch),
    (_action, scheduledAt, options = {}) => {
      timerOnlyRetrySchedule16.pwmRetryKind = options.kind || 'smart-on';
      timerOnlyRetrySchedule16.pwmRetryBoundaryAt = Number(options.boundaryAt) || 0;
      timerOnlyRetrySchedule16.pwmRetryScheduledAt = Number(scheduledAt) || 0;
      timerOnlyRetryOrder16.push(`marker:${timerOnlyRetrySchedule16.pwmRetryKind}`);
    },
    async reason => { timerOnlyRetryOrder16.push(`persist:${reason}`); },
    async plan => {
      timerOnlyRetryOrder16.push('create-pwm');
      timerOnlyRetrySchedule16.nextTriggerAt = plan.nextTriggerAt;
      return true;
    },
    18,
    () => true,
    async name => { timerOnlyRetryOrder16.push(`alarm:${name}`); },
    async () => false,
    async () => { timerOnlyRetryOrder16.push('badge'); },
    async reason => { timerOnlyRetryOrder16.push(`sync:${reason}`); }
  );
  await resolveTimerOnlyRetry16({
    kind: 'retry',
    reason: 'page-timer-failed',
    nextTriggerAt: retryScheduled16,
    phasePatch: { pwmState: 'on', nextTriggerAt: retryScheduled16 }
  }, {
    acIsOn: true,
    pageTimerError: 'fresh-page proof empty'
  }, 'on');
  assertPass(timerOnlyRetrySchedule16.pwmRetryKind === 'smart-on-safety-timer'
      && timerOnlyRetrySchedule16.pwmRetryBoundaryAt === retryBoundary16
      && timerOnlyRetrySchedule16.pwmRetryScheduledAt === retryScheduled16
      && timerOnlyRetrySchedule16.pageTimerError.includes('保持 on 相位')
      && timerOnlyRetryOrder16[0] === 'marker:smart-on-safety-timer'
      && timerOnlyRetryOrder16[1] === 'persist:runPwmStep-retry-intent'
      && timerOnlyRetryOrder16.includes('create-pwm')
      && timerOnlyRetryOrder16.at(-1)
        === 'sync:runPwmStep-smart-on-retry-hold',
    '16F-0B-1A-0: 开机已成功但 timer proof 失败会持久化 safety-timer；到期只修保险，sync 不携带延后 OFF 的 phase');
  let retryCreateRaceCurrent16 = true;
  const retryCreateRaceSchedule16 = {
    enabled: true,
    pwmState: 'on',
    nextTriggerAt: retryScheduled16,
    pageTimerError: '',
    smartOnBoundaryAt: retryBoundary16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  };
  const retryCreateRaceOrder16 = [];
  const resolveRetryPlanRace16 = new Function(
    'schedule', 'applyPwmPlanState', 'setSmartOnPwmRetryState',
    'persistSchedule', 'createPwmAlarmFromPlan', 'automationRevision',
    'isAutomationOperationCurrent', 'createAlarm', 'abortStaleAutomation',
    'updateBadge',
    `${retryPlanSource16}; return resolveRetryPlan;`
  )(
    retryCreateRaceSchedule16,
    plan => Object.assign(retryCreateRaceSchedule16, plan.phasePatch),
    (_action, scheduledAt) => {
      retryCreateRaceSchedule16.pwmRetryKind = 'smart-on';
      retryCreateRaceSchedule16.pwmRetryBoundaryAt = retryBoundary16;
      retryCreateRaceSchedule16.pwmRetryScheduledAt = scheduledAt;
    },
    async reason => { retryCreateRaceOrder16.push(`persist:${reason}`); },
    async () => {
      retryCreateRaceOrder16.push('create-alarm:false');
      retryCreateRaceCurrent16 = false;
      Object.assign(retryCreateRaceSchedule16, {
        enabled: false,
        pwmState: 'off',
        nextTriggerAt: 0,
        pageTimerError: 'NEW-RETRY-LIFECYCLE',
        pwmRetryKind: '',
        pwmRetryBoundaryAt: 0,
        pwmRetryScheduledAt: 0
      });
      return false;
    },
    17,
    () => retryCreateRaceCurrent16,
    async () => { retryCreateRaceOrder16.push('badge'); },
    async () => false,
    async () => { retryCreateRaceOrder16.push('update-badge'); }
  );
  await resolveRetryPlanRace16({
    kind: 'retry',
    reason: 'toggle-on-failed',
    nextTriggerAt: retryScheduled16 + 60_000,
    phasePatch: { pwmState: 'on', nextTriggerAt: retryScheduled16 + 60_000 }
  }, { toggleError: 'synthetic retry failure' }, 'on');
  assertPass(retryCreateRaceOrder16.join(',')
        === 'persist:runPwmStep-retry-intent,create-alarm:false'
      && retryCreateRaceSchedule16.pageTimerError === 'NEW-RETRY-LIFECYCLE'
      && retryCreateRaceSchedule16.enabled === false
      && retryCreateRaceSchedule16.nextTriggerAt === 0,
    '16F-0B-1A-1: retry 建钟期间 revision 失效后不追加旧错误或 persist，不覆盖新 lifecycle');
  const pageTimerAdoptionBody16 = extractSourceSection(
    backgroundSource,
    'async function tryAdoptPageTimer(reason = \'\') {',
    '\n// ----- 官方推荐：setInterval heartbeat',
    'page timer adoption retry guard'
  );
  const syncedPhaseBody16 = extractSourceSection(
    backgroundSource,
    'async function applySyncedPhase(remote, reason = \'\') {',
    '\n// 从 chrome.storage.sync 拉取并尝试合并。',
    'sync phase retry guard'
  );
  assertPass(pageTimerAdoptionBody16.includes('getActiveSmartOnPwmRetryContext(')
      && pageTimerAdoptionBody16.includes('retryContext.hasTypedSmartOnRetry')
      && pageTimerAdoptionBody16.indexOf('retryContext.hasTypedSmartOnRetry')
        < pageTimerAdoptionBody16.indexOf('computePageTimerAdoption(')
      && syncedPhaseBody16.includes('protectLocalSmartOnRetry')
      && syncedPhaseBody16.includes('getActiveSmartOnPwmRetryContext(')
      && syncedPhaseBody16.includes('protectSmartOnRetryConfigDiff(')
      && syncedPhaseBody16.indexOf('localRetryBeforeConfig')
        < syncedPhaseBody16.indexOf('computeConfigDiff(schedule, remote)')
      && syncedPhaseBody16.includes('const prospectiveSchedule =')
      && syncedPhaseBody16.includes('isAutomationAllowedForSchedule(prospectiveSchedule)')
      && syncedPhaseBody16.includes('? false')
      && syncedPhaseBody16.includes(': await adoptPhaseAndRearm('),
    '16F-0B-1B: 22:31 durable retry 优先于预置的 22:52 page timer 与远端相位；只有 live/storage 所有权失配后才允许采纳');
  const recoverLifecycleBody16 = extractSourceSection(
    backgroundSource,
    'async function recoverPwmLifecycle(context = {}) {',
    '\n// ===== 智能模式：将军澳 JKB 天气取数',
    'typed retry lifecycle recovery'
  );
  assertPass(recoverLifecycleBody16.includes("kind: 'execute-smart-on-retry'")
      && recoverLifecycleBody16.includes("reason: 'typed-smart-on-retry-due'")
      && recoverLifecycleBody16.includes('getActiveSmartOnPwmRetryContext(')
      && recoverLifecycleBody16.includes('scheduledTime: retryAlarmAt,')
      && recoverLifecycleBody16.includes('await executePwmStepWithRecovery({')
      && !recoverLifecycleBody16.includes('await runPwmStep(')
      && recoverLifecycleBody16.indexOf("kind: 'execute-smart-on-retry'")
        < recoverLifecycleBody16.indexOf('await applyPreparedSmartModeDurations({')
      && recoverLifecycleBody16.indexOf("kind: 'execute-smart-on-retry'")
        < recoverLifecycleBody16.indexOf('const plan = planPwmLifecycleRecovery(')
      && recoverLifecycleBody16.includes('const lifecycleClockAssessment = classifySmartOnClock(')
      && recoverLifecycleBody16.includes('const hasOwnedSmartBoundaryWait =')
      && recoverLifecycleBody16.includes('if (!lifecycleRetryContext.hasTypedSmartOnRetry\n      && !hasOwnedSmartBoundaryWait)')
      && recoverLifecycleBody16.indexOf('const lifecycleClockAssessment = classifySmartOnClock(')
        < recoverLifecycleBody16.indexOf('await applyPreparedSmartModeDurations({')
      && pwmBody.includes('if (!hasTypedSmartOnRetry) {')
      && pwmBody.indexOf('if (!hasTypedSmartOnRetry) {')
        < pwmBody.indexOf('await applyPreparedSmartModeDurations({')
      && pwmBody.includes("refreshedRecoveryPlan.kind === 'recover-smart-current-cycle'")
      && recoverLifecycleBody16.includes('smartNextAction: preparedRuntimeSnapshot?.pwmState || schedule.pwmState')
      && !pwmBody.includes("if (refreshedRecoveryPlan.kind !== 'recover-smart-current-cycle') return")
      && pwmBody.indexOf('await clearPwmAlarm(automationRevision);')
        > pwmBody.indexOf("refreshedRecoveryPlan.kind === 'recover-smart-current-cycle'"),
    '16F-0B-1D: typed retry 所有权先于新半点天气与通用协调器；过期 R 回原事务，不从 22:31 漂成 23:01');
  const lifecycleRepairBranchStart16 = recoverLifecycleBody16.indexOf(
    "  if (plan.kind === 'repair-clock') {"
  );
  const lifecycleRepairBranchEnd16 = recoverLifecycleBody16.indexOf(
    '\n\n  return { handled: false, plan };',
    lifecycleRepairBranchStart16
  );
  const lifecycleRepairBranch16 = lifecycleRepairBranchStart16 >= 0
      && lifecycleRepairBranchEnd16 > lifecycleRepairBranchStart16
    ? recoverLifecycleBody16.slice(
      lifecycleRepairBranchStart16,
      lifecycleRepairBranchEnd16
    )
    : '';
  const runLifecycleRepairBranch16 = new Function(
    'plan', 'repairScheduleClock', 'automationRevision',
    `return (async () => { ${lifecycleRepairBranch16} })();`
  );
  const lifecycleRepairBoundary16 = new Date(2026, 7, 27, 19, 0, 0, 0).getTime();
  const lifecycleInvalidClock16 = lifecycleRepairBoundary16 + 30 * 60_000;
  let releaseGenericLifecycleStatus16;
  let markGenericLifecycleStatusStarted16;
  const genericLifecycleStatusGate16 = new Promise(resolve => {
    releaseGenericLifecycleStatus16 = resolve;
  });
  const genericLifecycleStatusStarted16 = new Promise(resolve => {
    markGenericLifecycleStatusStarted16 = resolve;
  });
  const genericVsLifecycleHarness16 = await runRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    nextTriggerAt: lifecycleInvalidClock16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: lifecycleRepairBoundary16 - 4 * 60_000,
    alarmCreatedAt: lifecycleRepairBoundary16 - 4 * 60_000,
    alarmDelayMinutes: 34,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, lifecycleRepairBoundary16, null, false, {}, {
    returnController: true,
    statusGate: genericLifecycleStatusGate16,
    onStatusStart: markGenericLifecycleStatusStarted16,
    statusResults: [{ isOn: false }, { isOn: false }]
  });
  const genericRepairFirst16 = genericVsLifecycleHarness16.repairScheduleClock({});
  await genericLifecycleStatusStarted16;
  const invalidLifecycleRepair16 = runLifecycleRepairBranch16({
    kind: 'repair-clock',
    strategy: 'smart',
    reason: 'skipped-nearest-smart-on-boundary',
    expectedAt: lifecycleRepairBoundary16
  }, genericVsLifecycleHarness16.repairScheduleClock, 0);
  await Promise.resolve();
  const genericLifecycleNoPrematureClock16 =
    genericVsLifecycleHarness16.alarmPlans.length === 0;
  releaseGenericLifecycleStatus16();
  const [genericRepairFirstResult16, invalidLifecycleRepairResult16]
    = await Promise.all([genericRepairFirst16, invalidLifecycleRepair16]);
  assertPass(genericLifecycleNoPrematureClock16
      && genericRepairFirstResult16?.success === false
      && invalidLifecycleRepairResult16?.handled === true
      && invalidLifecycleRepairResult16?.repair?.success === true
      && genericVsLifecycleHarness16.statusCalls() === 2
      && genericVsLifecycleHarness16.timerCalls.length === 0
      && genericVsLifecycleHarness16.alarmPlans.length === 1
      && genericVsLifecycleHarness16.alarmPlans[0].nextTriggerAt
        === lifecycleRepairBoundary16 + 5 * 60_000
      && genericVsLifecycleHarness16.alarmPlans[0].nextTriggerAt
        !== lifecycleInvalidClock16
      && genericVsLifecycleHarness16.schedule.pwmRetryKind
        === 'smart-on-safe-delay'
      && genericVsLifecycleHarness16.schedule.pwmRetryBoundaryAt
        === lifecycleRepairBoundary16,
    '16F-0B-1D-0: generic repair 长状态读取中遇 invalid-clock lifecycle revoke 即按 epoch 失权；trailing 保留 19:00 并唯一排 19:05');
  const deferredCurrentCycleStart16 = recoverLifecycleBody16.indexOf(
    "if (plan.kind === 'recover-smart-current-cycle') {"
  );
  const deferredCurrentCycleEnd16 = recoverLifecycleBody16.indexOf(
    "\n  if (plan.kind === 'preserve-live-alarm') {",
    deferredCurrentCycleStart16
  );
  const deferredCurrentCycleBody16 = deferredCurrentCycleStart16 >= 0
      && deferredCurrentCycleEnd16 > deferredCurrentCycleStart16
    ? recoverLifecycleBody16.slice(deferredCurrentCycleStart16, deferredCurrentCycleEnd16)
    : '';
  let deferredExecutionCalls16 = 0;
  let deferredWaitUntilCalls16 = 0;
  const neverCompletes16 = new Promise(() => {});
  const runDeferredCurrentCycle16 = new Function(
    'plan', 'context', 'automationRevision', 'executePwmStepWithRecovery',
    'waitUntil', 'appendDiagnosticLog', 'console',
    `return (async () => { ${deferredCurrentCycleBody16} })();`
  );
  const deferredCurrentCycleResult16 = await Promise.race([
    runDeferredCurrentCycle16(
      {
        kind: 'recover-smart-current-cycle',
        scheduledTime: new Date(2026, 7, 27, 22, 30, 0, 0).getTime(),
        pageTimerTargetAt: new Date(2026, 7, 27, 22, 52, 0, 0).getTime()
      },
      { source: 'diagnostic', deferSmartCurrentCycleExecution: true },
      31,
      () => {
        deferredExecutionCalls16 += 1;
        return neverCompletes16;
      },
      execution => {
        deferredWaitUntilCalls16 += 1;
        return execution;
      },
      () => {},
      { warn() {}, error() {} }
    ),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 50))
  ]);
  assertPass(deferredCurrentCycleResult16?.started === true
      && deferredCurrentCycleResult16?.handled === true
      && deferredCurrentCycleResult16?.plan?.kind === 'recover-smart-current-cycle'
      && deferredCurrentCycleResult16?.timedOut !== true
      && deferredExecutionCalls16 === 1
      && deferredWaitUntilCalls16 === 1
      && deferredCurrentCycleBody16.includes('void waitUntil(execution).catch('),
    '16F-0B-1D-0: 诊断启动漏开恢复后立即返回 in-flight marker，不再等待页面 timer 验证撞上 10 秒 RPC 超时');
  const preparedRuntimeHelpers16 = extractSourceSection(
    backgroundSource,
    'function snapshotSmartPreparationOwner() {',
    '\nfunction applySmartDurationDecision(',
    'prepared smart runtime rollback helpers'
  );
  const preparedRuntimeHarness16 = new Function(
    'initialSchedule',
    `let schedule = initialSchedule;
    let pwmRuntimeRevision = 7;
    ${preparedRuntimeHelpers16}
    return {
      snapshot: snapshotPreparedSmartRuntime,
      restore: restorePreparedSmartRuntime,
      get: () => schedule,
      claim: () => { pwmRuntimeRevision += 1; return pwmRuntimeRevision; }
    };`
  )({
    enabled: true,
    smartMode: { enabled: true },
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    smartOnBoundaryAt: 0,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  });
  const beforeFutureClockPreparation16 = preparedRuntimeHarness16.snapshot();
  Object.assign(preparedRuntimeHarness16.get(), {
    pwmState: 'off',
    onMinutes: 30,
    offMinutes: 30
  });
  const futureClockNow16 = new Date(2026, 7, 27, 22, 20, 0, 0).getTime();
  const futureHalfHour16 = new Date(2026, 7, 27, 22, 30, 0, 0).getTime();
  const futureClockPlan16 = recoveryCoordinator.planPwmLifecycleRecovery(
    preparedRuntimeHarness16.get(),
    {
      now: futureClockNow16,
      plannedActionAt: futureHalfHour16,
      liveAlarmAt: futureHalfHour16,
      storedAlarmAt: futureHalfHour16,
      maxOnMinutes: 25
    }
  );
  if (futureClockPlan16.kind === 'preserve-live-alarm') {
    preparedRuntimeHarness16.restore(beforeFutureClockPreparation16);
  }
  assertPass(futureClockPlan16.kind === 'preserve-live-alarm'
      && futureClockPlan16.smartDecisionReason === 'next-action-not-on'
      && preparedRuntimeHarness16.get().pwmState === 'on'
      && preparedRuntimeHarness16.get().onMinutes === 12
      && preparedRuntimeHarness16.get().offMinutes === 18
      && recoverLifecycleBody16.indexOf('restorePreparedSmartRuntime(preparedRuntimeSnapshot)')
        > recoverLifecycleBody16.indexOf('const plan = planPwmLifecycleRecovery('),
    '16F-0B-1D-1: 22:20 恢复读取 22:00 on=0 只作规划；保留 22:30 future ON 时回滚旧边界相位/时长，触发时再消费 22:30 计划');
  const beforeManualSwitch16 = preparedRuntimeHarness16.snapshot();
  Object.assign(preparedRuntimeHarness16.get(), {
    pwmState: 'off',
    onMinutes: 60,
    offMinutes: 45,
    smartMode: { enabled: false, sensitivity: 5 }
  });
  const stalePreparedRestore16 = preparedRuntimeHarness16.restore(beforeManualSwitch16);
  assertPass(stalePreparedRestore16 === false
      && preparedRuntimeHarness16.get().smartMode.enabled === false
      && preparedRuntimeHarness16.get().onMinutes === 60
      && preparedRuntimeHarness16.get().offMinutes === 45
      && preparedRuntimeHelpers16.includes('isSmartPreparationOwnerCurrent(snapshot.owner)'),
    '16F-0B-1D-2: future-clock rollback 有配置 owner；天气等待中切回手动 60/45 后旧 12/18 快照拒绝恢复');

  const revisionOwnerSchedule16 = {
    enabled: true,
    mode: 'pwm',
    clockMode: false,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: futureHalfHour16,
    alarmCreatedAt: futureClockNow16,
    alarmDelayMinutes: 10,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    smartMode: { enabled: true, sensitivity: 5 },
    smartOnBoundaryAt: 0,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  };
  let releaseRevisionOwnerRead16;
  const revisionOwnerRead16 = new Promise(resolve => { releaseRevisionOwnerRead16 = resolve; });
  let revisionOwnerConsumeCalls16 = 0;
  let revisionOwnerApplyCalls16 = 0;
  const revisionOwnerHarness16 = new Function(
    'schedule', 'SMART_MODE', 'SMART_WEATHER_PLAN_KEY', 'chrome',
    'consumeSmartWeatherDecision', 'readStoredSmartWeather',
    'consumeStoredSmartWeatherDecision', 'applySmartDurationFallback',
    'applySmartDurationDecision', 'appendDiagnosticLog',
    `let pwmRuntimeRevision = 10;
    ${preparedRuntimeHelpers16}
    ${preparedDurationBody}
    return {
      apply: applyPreparedSmartModeDurations,
      claim: () => { pwmRuntimeRevision += 1; return pwmRuntimeRevision; }
    };`
  )(
    revisionOwnerSchedule16,
    { CYCLE_MINUTES: 30 },
    'ac_smart_weather_plan',
    { storage: { local: { get: () => revisionOwnerRead16 } } },
    () => {
      revisionOwnerConsumeCalls16 += 1;
      return { valid: true, onMinutes: 0, offMinutes: 30 };
    },
    async () => null,
    () => null,
    () => {},
    decision => {
      revisionOwnerApplyCalls16 += 1;
      revisionOwnerSchedule16.pwmState = decision.onMinutes === 0 ? 'off' : 'on';
    },
    () => {}
  );
  const staleRevisionWeather16 = revisionOwnerHarness16.apply({
    allowActiveOnPhase: true,
    boundaryAt: futureHalfHour16
  });
  revisionOwnerHarness16.claim();
  Object.assign(revisionOwnerSchedule16, {
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7
  });
  releaseRevisionOwnerRead16({ ac_smart_weather_plan: { schemaVersion: 1 } });
  const staleRevisionWeatherResult16 = await staleRevisionWeather16;
  assertPass(staleRevisionWeatherResult16 === false
      && revisionOwnerConsumeCalls16 === 0
      && revisionOwnerApplyCalls16 === 0
      && revisionOwnerSchedule16.pwmState === 'on'
      && revisionOwnerSchedule16.onMinutes === 23
      && revisionOwnerSchedule16.offMinutes === 7
      && preparedRuntimeHelpers16.includes('pwmRuntimeRevision,'),
    '16F-0B-1D-2A: 天气 await 中新 PWM revision 认领相位后，旧 on=0 计划零消费且不能覆盖新 23/7 lifecycle');
  const phaseOwnerSchedule16 = {
    enabled: true,
    mode: 'pwm',
    clockMode: false,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: futureHalfHour16,
    alarmCreatedAt: futureClockNow16 - 1000,
    alarmDelayMinutes: 10,
    smartOnBoundaryAt: 0,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    activeHours: { enabled: false, start: '08:00', end: '23:00' },
    smartMode: { enabled: true, sensitivity: 5 }
  };
  const phaseOwnerToken16 = () => ({
    enabled: phaseOwnerSchedule16.enabled,
    mode: phaseOwnerSchedule16.mode,
    clockMode: phaseOwnerSchedule16.clockMode,
    smartEnabled: phaseOwnerSchedule16.smartMode.enabled,
    smartSensitivity: phaseOwnerSchedule16.smartMode.sensitivity,
    activeHoursEnabled: phaseOwnerSchedule16.activeHours.enabled,
    activeHoursStart: phaseOwnerSchedule16.activeHours.start,
    activeHoursEnd: phaseOwnerSchedule16.activeHours.end,
    nextTriggerAt: phaseOwnerSchedule16.nextTriggerAt,
    alarmCreatedAt: phaseOwnerSchedule16.alarmCreatedAt,
    alarmDelayMinutes: phaseOwnerSchedule16.alarmDelayMinutes
  });
  const phaseOwnerCurrent16 = owner => {
    const current = phaseOwnerToken16();
    return Object.keys(current).every(key => current[key] === owner[key]);
  };
  let releasePhasePreparation16;
  const phasePreparationWait16 = new Promise(resolve => {
    releasePhasePreparation16 = resolve;
  });
  let staleContextPlannerCalls16 = 0;
  const recoverWithPhaseOwner16 = new Function(
    'schedule', 'isSyncPhaseAdoptionAdmissionBlocked',
    'isSyncPhaseAdoptionAdmissionBlockedFor',
    'getActiveSmartOnPwmRetryContext', 'snapshotPreparedSmartRuntime',
    'halfHourBoundaryAtOrBefore', 'applyPreparedSmartModeDurations',
    'isAutomationOperationCurrent', 'isSmartPreparationOwnerCurrent',
    'planPwmLifecycleRecovery', 'classifySmartOnClock',
    'PWM_RETRY_ALARM_TOLERANCE_MS',
    `let pwmRuntimeRevision = 61;
    ${recoverLifecycleBody16}
    return recoverPwmLifecycle;`
  )(
    phaseOwnerSchedule16,
    () => false,
    () => false,
    () => ({ hasTypedSmartOnRetry: false }),
    () => ({
      owner: phaseOwnerToken16(),
      pwmState: phaseOwnerSchedule16.pwmState,
      onMinutes: phaseOwnerSchedule16.onMinutes,
      offMinutes: phaseOwnerSchedule16.offMinutes
    }),
    () => futureClockNow16,
    async () => { await phasePreparationWait16; return false; },
    () => true,
    phaseOwnerCurrent16,
    () => { staleContextPlannerCalls16 += 1; return { kind: 'preserve-live-alarm' }; },
    pwmPhase.classifySmartOnClock,
    1500
  );
  const staleContextRecoveryPromise16 = recoverWithPhaseOwner16({
    now: futureClockNow16,
    existingAlarm: { scheduledTime: futureHalfHour16 },
    liveAlarmAt: futureHalfHour16,
    storedAlarmAt: futureHalfHour16,
    plannedActionAt: futureHalfHour16,
    missingClockAction: 'repair-clock'
  });
  phaseOwnerSchedule16.pwmState = 'off';
  phaseOwnerSchedule16.nextTriggerAt = futureHalfHour16 + 30 * 60000;
  phaseOwnerSchedule16.alarmCreatedAt += 5000;
  releasePhasePreparation16();
  const staleContextRecovery16 = await staleContextRecoveryPromise16;
  assertPass(staleContextRecovery16.handled === false
      && staleContextRecovery16.plan?.reason === 'schedule-owner-changed'
      && staleContextPlannerCalls16 === 0
      && phaseOwnerSchedule16.pwmState === 'off'
      && phaseOwnerSchedule16.nextTriggerAt === futureHalfHour16 + 30 * 60000,
    '16F-0B-1D-3: 天气 await 中 sync 认领新 phase/clock 后旧 lifecycle 立即退出，零 planner/rollback/旧钟回写');
  const typedAlarmExceptionRecoveryBody16 = extractSourceSection(
    backgroundSource,
    'async function recoverTypedSmartOnAlarmException(',
    '\nasync function recoverGenericPwmAlarmException(',
    'typed smart-on alarm exception recovery'
  );
  const genericAlarmExceptionRecoveryBody16 = extractSourceSection(
    backgroundSource,
    'async function recoverGenericPwmAlarmException(',
    '\n// 所有 PWM 入口共享同一异常边界',
    'generic pwm alarm exception recovery'
  );
  const pwmStepWithRecoveryBody16 = extractSourceSection(
    backgroundSource,
    'async function executePwmStepWithRecovery({',
    '\n// 通过新鲜页面确认 Power-off after',
    'shared pwm exception executor'
  );
  assertPass(typedAlarmExceptionRecoveryBody16.includes("persistSchedule('onAlarm-smart-on-error-intent'")
      && typedAlarmExceptionRecoveryBody16.indexOf("persistSchedule('onAlarm-smart-on-error-intent'")
        < typedAlarmExceptionRecoveryBody16.indexOf('createPwmAlarmFromPlan(')
      && typedAlarmExceptionRecoveryBody16.includes("setSmartOnPwmRetryState('on', schedule.nextTriggerAt)")
      && typedAlarmExceptionRecoveryBody16.includes("recoveryPlan.kind === 'defer'")
      && pwmStepWithRecoveryBody16.indexOf('const incomingSmartOnRetryContext =')
        < pwmStepWithRecoveryBody16.indexOf('await runPwmStep({')
      && pwmStepWithRecoveryBody16.indexOf('const incomingPwmSnapshot =')
        < pwmStepWithRecoveryBody16.indexOf('await runPwmStep({')
      && pwmStepWithRecoveryBody16.indexOf('const incomingSmartOnWindow =')
        < pwmStepWithRecoveryBody16.indexOf('await runPwmStep({')
      && pwmStepWithRecoveryBody16.includes('Number.isSafeInteger(error?.pwmAutomationRevision)')
      && pwmStepWithRecoveryBody16.indexOf('if (!isAutomationOperationCurrent(failedRevision)) return false;')
        < pwmStepWithRecoveryBody16.indexOf('recoverTypedSmartOnAlarmException(')
      && pwmStepWithRecoveryBody16.indexOf('recoverTypedSmartOnAlarmException(')
        < pwmStepWithRecoveryBody16.indexOf('recoverGenericPwmAlarmException(')
      && alarmPwmCatchBody16.includes('await executePwmStepWithRecovery({')
      && alarmPwmCatchBody16.includes("source: 'alarm-ac-pwm'")
      && !alarmPwmCatchBody16.includes('recoverGenericPwmAlarmException(')
      && !pwmStepWithRecoveryBody16.includes('createPwmAlarmWithVerify(')
      && !pwmStepWithRecoveryBody16.includes('const delay = Math.max(')
      && backgroundSource.includes('function tagPwmAutomationError(')
      && backgroundSource.includes('Object.defineProperties(taggedError, {')
      && backgroundSource.includes('wrappedError.pwmRecoveryContext = recoveryContext')
      && pwmBody.includes('capturePwmExceptionRecoveryContext();')
      && pwmBody.indexOf('await applyPreparedSmartModeDurations({')
        < pwmBody.indexOf('capturePwmExceptionRecoveryContext();')
      && pwmBody.includes('throw tagPwmAutomationError(')
      && pwmStepWithRecoveryBody16.includes('const postPrepareContext = error?.pwmRecoveryContext;')
      && pwmStepWithRecoveryBody16.includes('postPrepareContext?.snapshot')
      && pwmStepWithRecoveryBody16.includes("Object.hasOwn(\n      postPrepareContext || {},\n      'smartOnWindow'"),
    '16F-0B-1E: alarm/启动/看门狗共用异常执行器；入场冻结事务，throw 绑定失败 revision，typed 优先且禁止长周期跳钟');

  const loadDiagnosticFinallyExecutor16 = ({ runPwmStep, recoverTyped }) => {
    const diagnosticSchedule = {
      enabled: true,
      pwmState: 'on',
      onMinutes: 20,
      offMinutes: 10,
      smartMode: { enabled: false },
      smartOnBoundaryAt: 0,
      pwmRetryKind: '',
      pwmRetryBoundaryAt: 0,
      pwmRetryScheduledAt: 0,
      nextTriggerAt: Date.now() + 60_000,
      pageTimerError: ''
    };
    let finishedCount = 0;
    const execute = new Function(
      'schedule', 'pwmRuntimeRevision', 'isAutomationOperationCurrent',
      'isSyncPhaseAdoptionAdmissionBlocked',
      'getSmartOnPwmRetryContext', 'planSmartModeOnWindow', 'SMART_MODE',
      'runPwmStep', 'appendDiagnosticLog',
      'recoverTypedSmartOnAlarmException', 'recoverGenericPwmAlarmException',
      'beginPwmDiagnosticAttempt', 'finishPwmDiagnosticAttempt',
      'waitForPwmDiagnosticOutcomePersistence',
      `let pwmExecutionWithRecoveryCount = 0;
      let deferredRepairAfterPwmOptions = null;
      function isSyncPhaseAdoptionAdmissionBlockedFor() { return false; }
      function drainDeferredScheduleRepair() { return false; }
      async function repairScheduleClock() { return { success: true }; }
      ${pwmStepWithRecoveryBody16}; return executePwmStepWithRecovery;`
    )(
      diagnosticSchedule,
      51,
      revision => revision === 51,
      () => false,
      () => ({ hasTypedSmartOnRetry: false, boundaryAt: 0, priorError: '' }),
      () => null,
      { ON_MAX: 25 },
      runPwmStep,
      () => {},
      recoverTyped,
      async () => true,
      () => 1,
      () => {
        finishedCount += 1;
        return { attemptId: 1, finishedAt: Date.now() };
      },
      outcome => neverSettlingPwmPersistence13(outcome, 20)
    );
    return { execute, getFinishedCount: () => finishedCount };
  };
  const persistenceReturnExecutor16 = loadDiagnosticFinallyExecutor16({
    runPwmStep: async () => {},
    recoverTyped: async () => false
  });
  const persistenceReturnStarted16 = Date.now();
  const persistenceReturnValue16 = await persistenceReturnExecutor16.execute({
    scheduledTime: Date.now(),
    automationRevision: 51,
    source: 'diagnostic-persistence-return'
  });
  const persistenceReturnElapsed16 = Date.now() - persistenceReturnStarted16;
  const recoverySentinel16 = new Error('recovery sentinel');
  const persistenceThrowExecutor16 = loadDiagnosticFinallyExecutor16({
    runPwmStep: async () => { throw new Error('initial pwm failure'); },
    recoverTyped: async () => { throw recoverySentinel16; }
  });
  let persistedThrow16 = null;
  const persistenceThrowStarted16 = Date.now();
  try {
    await persistenceThrowExecutor16.execute({
      scheduledTime: Date.now(),
      automationRevision: 51,
      source: 'diagnostic-persistence-throw'
    });
  } catch (error) {
    persistedThrow16 = error;
  }
  const persistenceThrowElapsed16 = Date.now() - persistenceThrowStarted16;
  assertPass(persistenceReturnValue16 === true
      && persistenceReturnExecutor16.getFinishedCount() === 1
      && persistenceReturnElapsed16 < 200
      && persistedThrow16 === recoverySentinel16
      && persistenceThrowExecutor16.getFinishedCount() === 1
      && persistenceThrowElapsed16 < 200,
    '16F-0B-1E-0: outcome storage 永不 settle 时 shared executor 仍及时返回原值，并以同一对象传播原 recovery 异常');

  const alarmAdmissionSource16 = extractSourceSection(
    backgroundSource,
    'function assessPwmAlarmDelivery(',
    '\nfunction prepareFreshPwmStartState()',
    'ac-pwm delivery admission'
  );
  const assessPwmAlarmDelivery16 = new Function(
    'classifySmartOnClock',
    `const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    ${alarmAdmissionSource16}; return assessPwmAlarmDelivery;`
  )(pwmPhase.classifySmartOnClock);
  const ingressBoundary16 = new Date(2026, 7, 27, 19, 0, 0, 0).getTime();
  const staleIngressSchedule16 = {
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    nextTriggerAt: ingressBoundary16 + 8 * 60_000,
    smartClockPlannedAt: ingressBoundary16 - 4 * 60_000,
    smartMode: { enabled: true },
    pwmRetryKind: 'smart-on-safe-delay',
    pwmRetryBoundaryAt: ingressBoundary16,
    pwmRetryScheduledAt: ingressBoundary16 + 8 * 60_000
  };
  const staleIngressAssessment16 = assessPwmAlarmDelivery16(
    staleIngressSchedule16,
    ingressBoundary16,
    ingressBoundary16
  );
  const comfortRetryAt16 = ingressBoundary16 + 60_000;
  const comfortUntil16 = ingressBoundary16 + 5 * 60_000;
  const comfortIngressSchedule16 = {
    enabled: true,
    pwmState: 'on',
    nextTriggerAt: comfortRetryAt16,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0,
    smartClockPlannedAt: 0,
    comfortStartUntil: comfortUntil16,
    smartMode: { enabled: true }
  };
  const comfortRetryAssessment16 = assessPwmAlarmDelivery16(
    comfortIngressSchedule16,
    comfortRetryAt16,
    comfortRetryAt16 + 5_000
  );
  const comfortFinishAssessment16 = assessPwmAlarmDelivery16(
    { ...comfortIngressSchedule16, nextTriggerAt: comfortUntil16 },
    comfortUntil16,
    comfortUntil16 + 60_000
  );
  assertPass(staleIngressAssessment16.accepted === false
      && staleIngressAssessment16.reason === 'alarm-owner-mismatch'
      && comfortRetryAssessment16.accepted === true
      && comfortRetryAssessment16.reason === 'comfort-start-durable-clock'
      && comfortFinishAssessment16.accepted === true
      && comfortFinishAssessment16.reason === 'comfort-start-durable-clock',
    '16F-0B-1E-0: stale ac-pwm 所有权失配拒绝；舒适启动的一分钟 retry 与迟到 finish 均由 durable clock 放行');

  const runAlarmIngressRoute16 = async (routeSchedule, alarmAt, retryContext = {}) => {
    const calls = [];
    const route = new Function(
      'schedule', 'assessPwmAlarmDelivery', 'repairScheduleClock',
      'getSmartOnPwmRetryContext', 'executePwmStepWithRecovery',
      'pwmRuntimeRevision', 'Date', 'console',
      `return async function routeAlarm(alarm) {
${alarmPwmCatchBody16}
    return;
  }
};`
    )(
      routeSchedule,
      assessPwmAlarmDelivery16,
      async options => { calls.push({ type: 'repair', options }); },
      () => ({ hasSafetyTimerRetry: false, ...retryContext }),
      async options => { calls.push({ type: 'execute', options }); },
      71,
      { now: () => alarmAt + 5_000 },
      testConsole
    );
    await route({ name: 'ac-pwm', scheduledTime: alarmAt });
    return calls;
  };
  const staleIngressCalls16 = await runAlarmIngressRoute16(
    staleIngressSchedule16,
    ingressBoundary16
  );
  const comfortIngressCalls16 = await runAlarmIngressRoute16(
    comfortIngressSchedule16,
    comfortRetryAt16
  );
  const safetyTimerIngressSchedule16 = {
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    nextTriggerAt: ingressBoundary16 + 60_000,
    smartClockPlannedAt: ingressBoundary16,
    smartMode: { enabled: true },
    pwmRetryKind: 'smart-on-safety-timer',
    pwmRetryBoundaryAt: ingressBoundary16,
    pwmRetryScheduledAt: ingressBoundary16 + 60_000
  };
  const safetyTimerIngressAssessment16 = assessPwmAlarmDelivery16(
    safetyTimerIngressSchedule16,
    safetyTimerIngressSchedule16.nextTriggerAt,
    safetyTimerIngressSchedule16.nextTriggerAt + 5_000
  );
  const safetyTimerIngressCalls16 = await runAlarmIngressRoute16(
    safetyTimerIngressSchedule16,
    safetyTimerIngressSchedule16.nextTriggerAt,
    {
      hasSafetyTimerRetry: true,
      boundaryAt: ingressBoundary16
    }
  );
  assertPass(staleIngressCalls16.length === 1
      && staleIngressCalls16[0].type === 'repair'
      && comfortIngressCalls16.length === 1
      && comfortIngressCalls16[0].type === 'execute'
      && comfortIngressCalls16[0].options.source === 'alarm-ac-pwm'
      && comfortIngressCalls16[0].options.scheduledTime === comfortRetryAt16
      && safetyTimerIngressAssessment16.accepted === true
      && safetyTimerIngressCalls16.length === 1
      && safetyTimerIngressCalls16[0].type === 'repair'
      && safetyTimerIngressCalls16[0].options.smartOnExpectedBoundaryAt
        === ingressBoundary16
      && !safetyTimerIngressCalls16.some(call => call.type === 'execute'),
    '16F-0B-1E-0A: actual ac-pwm ingress 对拒绝事件与 safety-timer 到期都只走 no-toggle repair；合法舒适 retry 才进共享执行器');
  const invalidOwnerClockAt16 = ingressBoundary16 + 30 * 60_000;
  const invalidOwnerClockSchedule16 = {
    enabled: true,
    pwmState: 'on',
    onMinutes: 23,
    offMinutes: 7,
    nextTriggerAt: invalidOwnerClockAt16,
    smartClockPlannedAt: ingressBoundary16 - 4 * 60_000,
    alarmCreatedAt: ingressBoundary16 - 4 * 60_000,
    alarmDelayMinutes: 34,
    smartOnBoundaryAt: 0,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  };
  const invalidOwnerClockAssessment16 = assessPwmAlarmDelivery16(
    invalidOwnerClockSchedule16,
    ingressBoundary16,
    ingressBoundary16 + 5_000
  );
  const invalidOwnerClockCalls16 = await runAlarmIngressRoute16(
    invalidOwnerClockSchedule16,
    ingressBoundary16
  );
  const invalidOwnerClockRepair16 = await runRepairCase(
    invalidOwnerClockSchedule16,
    ingressBoundary16,
    null,
    false,
    invalidOwnerClockCalls16[0]?.options || {},
    { runtimeRevision: 71 }
  );
  assertPass(invalidOwnerClockAssessment16.accepted === false
      && invalidOwnerClockAssessment16.reason === 'alarm-owner-mismatch'
      && invalidOwnerClockAssessment16.smartClockAssessment?.valid === false
      && invalidOwnerClockAssessment16.smartClockAssessment?.expectedAt
        === ingressBoundary16
      && invalidOwnerClockCalls16.length === 1
      && invalidOwnerClockCalls16[0].type === 'repair'
      && invalidOwnerClockCalls16[0].options.smartOnExpectedBoundaryAt
        === ingressBoundary16
      && invalidOwnerClockRepair16.alarmPlans.length === 1
      && invalidOwnerClockRepair16.alarmPlans[0].nextTriggerAt
        === ingressBoundary16 + 5 * 60_000
      && invalidOwnerClockRepair16.alarmPlans[0].nextTriggerAt
        !== invalidOwnerClockAt16
      && invalidOwnerClockRepair16.schedule.pwmRetryKind
        === 'smart-on-safe-delay'
      && invalidOwnerClockRepair16.schedule.pwmRetryBoundaryAt
        === ingressBoundary16,
    '16F-0B-1E-0B: 19:00 旧事件先审计非法 durable 19:30/planned18:56，repair 保留 expected19:00 并只排 19:05');

  const loadPwmRepairInterlock16 = (
    initialSchedule,
    initialLiveAt,
    nowMs,
    harnessOptions = {}
  ) => new Function(
    'initialSchedule', 'initialLiveAt', 'harnessOptions',
    'classifySmartOnClock', 'planSmartModeOnWindow',
    'planSmartOnAfterConfirmedOff', 'nextSafePageTimerTargetAt',
    'nextHalfHourBoundary', 'halfHourBoundaryAtOrBefore',
    'computePageTimerAdoption', 'smartModePageTimerTargetAt',
    'SMART_MODE', 'Date', 'console',
    `let schedule = structuredClone(initialSchedule);
    let durableSchedule = structuredClone(initialSchedule);
    let liveAt = Number(initialLiveAt) || 0;
    let physicalOn = harnessOptions.physicalOn === true;
    let pwmRuntimeRevision = 41;
    let pwmExecutionWithRecoveryCount = 0;
    let deferredRepairAfterPwmOptions = null;
    let scheduleRepairEpoch = 0;
    let pwmStepRunning = false;
    let pwmStepRunningRevision = null;
    let syncPhaseAdoptionAdmissionEpoch = 0;
    let syncPhaseAdoptionAdmissionOwner = 0;
    let statusCalls = 0;
    let phaseGateRepairResult = null;
    let phaseGateRepairEffectsWhileHeld = null;
    let persistGateUsed = false;
    let pageAdoptPersistFailureUsed = false;
    let pageAdoptClearFailureUsed = false;
    let pageAdoptCreateFailureUsed = false;
    let expiredPageRecoveryPersistFailureUsed = false;
    let replacementProofGateUsed = false;
    const calls = [];
    const waitUntilPromises = [];
    const PWM_RETRY_ALARM_TOLERANCE_MS = 1500;
    function isCurrentPwmStepRunning() {
      return pwmStepRunning && pwmStepRunningRevision === pwmRuntimeRevision;
    }
    function isAutomationAllowed() { return schedule.enabled === true; }
    function isAutomationOperationCurrent(revision) {
      return revision === pwmRuntimeRevision && isAutomationAllowed();
    }
    function isComfortStartActive() { return false; }
    async function abortStaleAutomation(revision) {
      return !isAutomationOperationCurrent(revision);
    }
    function waitUntil(promise) {
      const tracked = Promise.resolve(promise);
      waitUntilPromises.push(tracked);
      return tracked;
    }
    function appendDiagnosticLog() {}
    function getActiveSmartOnPwmRetryContext(snapshot, scheduledTime) {
      const markerAt = Number(snapshot?.pwmRetryScheduledAt) || 0;
      const candidateAt = Number(scheduledTime) || 0;
      const owned = markerAt > 0
        && Math.abs(markerAt - candidateAt) <= PWM_RETRY_ALARM_TOLERANCE_MS;
      return {
        hasTypedSmartOnRetry: owned,
        hasSafetyTimerRetry: owned
          && snapshot?.pwmRetryKind === 'smart-on-safety-timer',
        boundaryAt: owned ? Number(snapshot?.pwmRetryBoundaryAt) || 0 : 0,
        priorError: snapshot?.pageTimerError || ''
      };
    }
    function getSmartOnPwmRetryContext(snapshot, scheduledTime) {
      return getActiveSmartOnPwmRetryContext(snapshot, scheduledTime);
    }
    async function restoreIntervalAlarmFromStorage() {
      calls.push({ type: 'restore', liveAt, storedAt: schedule.nextTriggerAt });
      return harnessOptions.restoreFromLive !== false
        && liveAt > Date.now()
        && Math.abs(liveAt - Number(schedule.nextTriggerAt))
          <= PWM_RETRY_ALARM_TOLERANCE_MS;
    }
    async function updateBadge() { calls.push({ type: 'badge' }); }
    async function getCurrentACStatus() {
      statusCalls += 1;
      calls.push({ type: 'status', call: statusCalls, physicalOn });
      if (statusCalls === 1 && harnessOptions.statusGate) {
        if (typeof harnessOptions.onStatusStart === 'function') {
          harnessOptions.onStatusStart();
        }
        await harnessOptions.statusGate;
      }
      const results = harnessOptions.statusResults;
      if (Array.isArray(results) && results.length > 0) {
        return results[Math.min(statusCalls - 1, results.length - 1)];
      }
      return { isOn: physicalOn };
    }
    async function setPageTimer(minutes, options = {}) {
      calls.push({ type: 'page-timer', minutes, options: { ...options } });
      const targetAt = Number(options.targetAt) || Date.now() + minutes * 60_000;
      schedule.pageTimerTargetAt = targetAt;
      return { success: true, targetAt };
    }
    async function createPwmAlarmWithVerify(minutes, tag) {
      calls.push({ type: 'one-minute-alarm', minutes, tag });
      liveAt = Date.now() + minutes * 60_000;
      return true;
    }
    async function createAlarm(name, info = {}) {
      calls.push({ type: 'infra-alarm', name, info: { ...info } });
      return true;
    }
    async function persistSchedule(reason) {
      calls.push({ type: 'persist', reason, snapshot: structuredClone(schedule) });
      if (!persistGateUsed
          && harnessOptions.persistGate
          && String(reason).startsWith('page-timer-adopt-intent')) {
        persistGateUsed = true;
        if (typeof harnessOptions.onPersistStart === 'function') {
          harnessOptions.onPersistStart();
        }
        await harnessOptions.persistGate;
      }
      if (harnessOptions.pageAdoptPersistFailure === true
          && !pageAdoptPersistFailureUsed
          && String(reason).startsWith('page-timer-adopt-intent')) {
        pageAdoptPersistFailureUsed = true;
        throw new Error('synthetic page adoption persist failure');
      }
      if (harnessOptions.expiredPageRecoveryPersistFailure === true
          && !expiredPageRecoveryPersistFailureUsed
          && reason === 'page-expired-phase-recovery-intent') {
        expiredPageRecoveryPersistFailureUsed = true;
        calls.push({ type: 'expired-page-recovery-persist-failure' });
        throw new Error('synthetic page replacement recovery intent persist failure');
      }
      durableSchedule = structuredClone(schedule);
    }
    async function createPwmAlarmFromPlan(plan, tag, revision) {
      if (harnessOptions.pageAdoptCreateFailure === true
          && !pageAdoptCreateFailureUsed
          && tag === 'page-timer-adopt') {
        pageAdoptCreateFailureUsed = true;
        throw new Error('synthetic page adoption create failure');
      }
      liveAt = Number(plan?.nextTriggerAt) || 0;
      calls.push({ type: 'repair-alarm', tag, revision, at: liveAt });
      return true;
    }
    async function applyPreparedSmartModeDurations() { return false; }
    function setNextTriggerAt(value) {
      schedule.nextTriggerAt = Number(value) > 0 ? Number(value) : 0;
    }
    function clearPwmRetryState() {
      schedule.pwmRetryKind = '';
      schedule.pwmRetryBoundaryAt = 0;
      schedule.pwmRetryScheduledAt = 0;
    }
    function setSmartOnPwmRetryState(_action, scheduledAt, options = {}) {
      schedule.pwmRetryKind = options.kind || 'smart-on';
      schedule.pwmRetryBoundaryAt = Number(options.boundaryAt)
        || Number(schedule.smartOnBoundaryAt)
        || 0;
      schedule.pwmRetryScheduledAt = Number(scheduledAt) || 0;
    }
    function clearPageTimerProofState() {
      schedule.pageTimerMinutes = null;
      schedule.pageTimerTargetAt = 0;
      schedule.pageTimerError = '';
      schedule.pageTimerRetryAt = 0;
      schedule.pageTimerRetryMinutes = 0;
    }
    async function syncScheduleToSync(reason) {
      calls.push({ type: 'sync', reason });
      return true;
    }
    async function loadScheduleFromStorage() {
      calls.push({ type: 'storage-reload' });
      return schedule;
    }
    const STORAGE_KEY = 'ac_schedule';
    const chrome = {
      storage: {
        local: {
          async get(key) {
            const captured = structuredClone(durableSchedule);
            if (harnessOptions.replacementProofGate
                && !replacementProofGateUsed) {
              replacementProofGateUsed = true;
              calls.push({ type: 'replacement-proof-start' });
              if (typeof harnessOptions.onReplacementProofStart === 'function') {
                harnessOptions.onReplacementProofStart();
              }
              await harnessOptions.replacementProofGate;
            }
            return { [key]: captured };
          }
        },
        sync: { async get() { return {}; } }
      },
      tabs: {
        async query() {
          calls.push({ type: 'tab-query' });
          return [{ id: 7, url: 'https://w5.ab.ust.hk/njggt/app/' }];
        }
      },
      alarms: {
        async get(name) {
          calls.push({ type: 'alarm-read', name, at: liveAt });
          return name === 'ac-pwm' && liveAt > 0
            ? { name, scheduledTime: liveAt }
            : undefined;
        }
      }
    };
    async function runPwmStep(options = {}) {
      calls.push({ type: 'run-pwm', options: { ...options } });
      if (!harnessOptions.toggleGate) {
        calls.push({ type: 'unexpected-click' });
        return;
      }
      physicalOn = true;
      calls.push({ type: 'physical-on' });
      if (typeof harnessOptions.onToggleStart === 'function') {
        harnessOptions.onToggleStart();
      }
      await harnessOptions.toggleGate;
      const cutoffAt = Number(harnessOptions.intendedCutoffAt) || 0;
      schedule.pwmState = 'off';
      schedule.pageTimerTargetAt = cutoffAt;
      setNextTriggerAt(cutoffAt);
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(1, (cutoffAt - Date.now()) / 60_000);
      liveAt = cutoffAt;
      calls.push({ type: 'intended-off-alarm', at: cutoffAt });
    }
    async function recoverTypedSmartOnAlarmException() { return false; }
    async function recoverGenericPwmAlarmException() { return false; }
    function getOwnedSmartOnClockException() {
      return { hasOwnedException: false };
    }
    function isACHomePageTab(tab) {
      return tab?.url === 'https://w5.ab.ust.hk/njggt/app/';
    }
    async function sendReadMessageToExactACHome() {
      calls.push({ type: 'page-timer-read' });
      return harnessOptions.pageTimerResult || { found: false, value: null };
    }
    function invalidateTimerBasedShutdown() {
      calls.push({ type: 'invalidate-shutdown', revision: pwmRuntimeRevision });
    }
    async function clearPwmAlarm(revision) {
      calls.push({ type: 'clear-pwm', revision, at: liveAt });
      if (harnessOptions.pageAdoptClearFailure === true
          && !pageAdoptClearFailureUsed) {
        pageAdoptClearFailureUsed = true;
        throw new Error('synthetic page adoption clear failure');
      }
      liveAt = 0;
      return true;
    }
    async function advanceExpiredAlarmToNextBoundary(
      _expiredAt,
      revision,
      phaseAdmissionEpoch = 0
    ) {
      const phaseOwnerAccepted = !isSyncPhaseAdoptionAdmissionBlockedFor(
        phaseAdmissionEpoch
      );
      calls.push({ type: 'advance-expired', revision, phaseAdmissionEpoch,
        phaseOwnerAccepted });
      const recoveryAt = Number(harnessOptions.expiredRecoveryAt) || 0;
      if (recoveryAt > Date.now()
          && phaseOwnerAccepted
          && isAutomationOperationCurrent(revision)) {
        const recoveryRevision = harnessOptions.expiredRecoveryClaimsNewRevision
          ? pwmRuntimeRevision += 1
          : revision;
        schedule.pwmState = harnessOptions.expiredRecoveryAction || 'off';
        setNextTriggerAt(recoveryAt);
        const recoveryBoundaryAt = Number(
          harnessOptions.expiredRecoveryBoundaryAt
        ) || 0;
        if (recoveryBoundaryAt > 0) {
          schedule.smartOnBoundaryAt = recoveryBoundaryAt;
          schedule.pwmRetryKind = 'smart-on-safe-delay';
          schedule.pwmRetryBoundaryAt = recoveryBoundaryAt;
          schedule.pwmRetryScheduledAt = recoveryAt;
        }
        schedule.alarmCreatedAt = Date.now();
        schedule.alarmDelayMinutes = Math.max(1, (recoveryAt - Date.now()) / 60000);
        await persistSchedule('page-expired-phase-recovery-intent');
        await createPwmAlarmFromPlan(
          { nextTriggerAt: recoveryAt },
          'page-expired-phase-recovery',
          recoveryRevision
        );
        if (harnessOptions.expiredRecoveryClaimsNewRevision) {
          calls.push({ type: 'expired-page-recovery-new-owner',
            revision: recoveryRevision, at: recoveryAt });
        }
      }
      return true;
    }
    async function rescheduleActiveBoundary() {
      calls.push({ type: 'active-boundary' });
    }
    ${syncPhaseAdmissionSource16}
    ${deferredRepairCoordinatorSource11}
    ${alarmAdmissionSource16}
    ${durableLivePwmOwnerSource16}
    ${stableDurableLivePwmOwnerSource16}
    ${repairFunctionSource}
    ${sharedPwmExecutorSource16}
    ${pageTimerAdoptionBody16}
    const _syncOpLock = {
      busy: false,
      pending: false,
      pendingReason: '',
      pendingRemote: null,
      pendingOutbound: false,
      pendingOutboundReason: ''
    };
    let syncWriteChain = Promise.resolve();
    let syncWriteOperationsInFlight = 0;
    async function getSyncPublishPending() { return false; }
    async function scheduleSyncRetry(kind = 'publish') {
      calls.push({ type: 'sync-retry', kind });
      return true;
    }
    function runSerializedScheduleUpdate(operation) { return operation(); }
    async function applySyncedPhase(remote) {
      if (harnessOptions.phaseGateRepairDuringApply !== true) return false;
      const admissionEpoch = claimSyncPhaseAdoptionAdmission();
      if (admissionEpoch <= 0) return false;
      pwmRuntimeRevision += 1;
      try {
        phaseGateRepairResult = await repairScheduleClock(
          remote?.repairOptions || {}
        );
        phaseGateRepairEffectsWhileHeld = calls.filter(call =>
          call.type === 'status'
            || call.type === 'page-timer'
            || call.type === 'repair-alarm'
            || call.type === 'one-minute-alarm').length;
        return true;
      } finally {
        releaseSyncPhaseAdoptionAdmission(admissionEpoch);
      }
    }
    ${tryAdoptSource6}
    async function deliverAlarmForTest(scheduledTime) {
      const alarm = { name: 'ac-pwm', scheduledTime };
      const activeBoundaryActionDelivery = false;
      ${phaseSensitiveAlarmGateBody16}
      ${alarmPwmCatchBody16}
        return;
      }
    }
    function supersedeReplacementOwnerForTest(nextTriggerAt) {
      pwmRuntimeRevision += 1;
      schedule.pwmState = 'on';
      setNextTriggerAt(nextTriggerAt);
      schedule.smartOnBoundaryAt = Number(harnessOptions.supersedingBoundaryAt) || 0;
      schedule.pwmRetryKind = schedule.smartOnBoundaryAt > 0
        ? 'smart-on-safe-delay'
        : '';
      schedule.pwmRetryBoundaryAt = schedule.smartOnBoundaryAt;
      schedule.pwmRetryScheduledAt = nextTriggerAt;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - Date.now()) / 60000
      );
      liveAt = nextTriggerAt;
      durableSchedule = structuredClone(schedule);
      calls.push({ type: 'replacement-owner-superseded',
        revision: pwmRuntimeRevision, at: nextTriggerAt });
      return pwmRuntimeRevision;
    }
    function supersedeIncompleteReplacementOwnerForTest(nextTriggerAt) {
      pwmRuntimeRevision += 1;
      schedule.pwmState = 'on';
      setNextTriggerAt(nextTriggerAt);
      schedule.smartOnBoundaryAt = Number(harnessOptions.supersedingBoundaryAt) || 0;
      schedule.pwmRetryKind = schedule.smartOnBoundaryAt > 0
        ? 'smart-on-safe-delay'
        : '';
      schedule.pwmRetryBoundaryAt = schedule.smartOnBoundaryAt;
      schedule.pwmRetryScheduledAt = nextTriggerAt;
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - Date.now()) / 60000
      );
      liveAt = 0;
      calls.push({ type: 'replacement-owner-incomplete',
        revision: pwmRuntimeRevision, at: nextTriggerAt });
      return pwmRuntimeRevision;
    }
    function beginSameRevisionExecutorForTest() {
      pwmExecutionWithRecoveryCount += 1;
      calls.push({ type: 'same-revision-executor-start',
        revision: pwmRuntimeRevision });
      return pwmRuntimeRevision;
    }
    function commitSameRevisionOwnerForTest(owner = {}) {
      const nextTriggerAt = Number(owner.nextTriggerAt) || 0;
      const boundaryAt = Number(owner.boundaryAt) || 0;
      schedule.pwmState = owner.pwmState === 'off' ? 'off' : 'on';
      setNextTriggerAt(nextTriggerAt);
      schedule.smartOnBoundaryAt = boundaryAt;
      schedule.pwmRetryKind = String(owner.pwmRetryKind || '');
      schedule.pwmRetryBoundaryAt = Number(owner.pwmRetryBoundaryAt) || 0;
      schedule.pwmRetryScheduledAt = Number(owner.pwmRetryScheduledAt) || 0;
      schedule.smartClockPlannedAt = Number(owner.smartClockPlannedAt)
        || Date.now();
      schedule.alarmCreatedAt = Date.now();
      schedule.alarmDelayMinutes = Math.max(
        1,
        (nextTriggerAt - Date.now()) / 60000
      );
      durableSchedule = structuredClone(schedule);
      liveAt = nextTriggerAt;
      calls.push({ type: 'same-revision-owner-commit',
        revision: pwmRuntimeRevision, at: nextTriggerAt,
        pwmState: schedule.pwmState });
      return pwmRuntimeRevision;
    }
    function finishSameRevisionExecutorForTest() {
      pwmExecutionWithRecoveryCount = Math.max(
        0,
        pwmExecutionWithRecoveryCount - 1
      );
      calls.push({ type: 'same-revision-executor-finish',
        revision: pwmRuntimeRevision });
      return drainDeferredScheduleRepair('same-revision-executor-test');
    }
    return {
      execute: executePwmStepWithRecovery,
      repair: repairScheduleClock,
      pageAdopt: tryAdoptPageTimer,
      adopt: tryAdoptSyncedState,
      deliverAlarm: deliverAlarmForTest,
      queue: queueDeferredScheduleRepair,
      claimPhase: claimSyncPhaseAdoptionAdmission,
      releasePhase: releaseSyncPhaseAdoptionAdmission,
      drain: drainDeferredScheduleRepair,
      supersedeReplacementOwner: supersedeReplacementOwnerForTest,
      supersedeIncompleteReplacementOwner:
        supersedeIncompleteReplacementOwnerForTest,
      proveOwner: hasDurableLivePwmOwner,
      beginSameRevisionExecutor: beginSameRevisionExecutorForTest,
      commitSameRevisionOwner: commitSameRevisionOwnerForTest,
      finishSameRevisionExecutor: finishSameRevisionExecutorForTest,
      drainWaits: async () => {
        let observed = 0;
        while (observed < waitUntilPromises.length) {
          const pending = waitUntilPromises.slice(observed);
          observed = waitUntilPromises.length;
          await Promise.allSettled(pending);
        }
      },
      deferred: () => deferredRepairAfterPwmOptions
        ? { ...deferredRepairAfterPwmOptions }
        : null,
      snapshot: () => structuredClone(schedule),
      durable: () => structuredClone(durableSchedule),
      live: () => liveAt,
      physicalOn: () => physicalOn,
      statusCalls: () => statusCalls,
      revision: () => pwmRuntimeRevision,
      phaseGateRepairResult: () => phaseGateRepairResult,
      phaseGateRepairEffectsWhileHeld: () => phaseGateRepairEffectsWhileHeld,
      calls
    };`
  )(
    initialSchedule,
    initialLiveAt,
    harnessOptions,
    pwmPhase.classifySmartOnClock,
    pwmPhase.planSmartModeOnWindow,
    pwmPhase.planSmartOnAfterConfirmedOff,
    pwmPhase.nextSafePageTimerTargetAt,
    pwmPhase.nextHalfHourBoundary,
    pwmPhase.halfHourBoundaryAtOrBefore,
    harnessOptions.computePageTimerAdoption
      || syncHelpers.computePageTimerAdoption,
    pwmPhase.smartModePageTimerTargetAt,
    smartMode.SMART_MODE,
    class PwmRepairInterlockDate16 extends Date {
      static now() { return nowMs; }
    },
    testConsole
  );

  const preserveRevokeOptions16 = {
    revokeInvalidSmartOnClock: true,
    revokeOwnerRevision: 41,
    smartOnExpectedBoundaryAt: ingressBoundary16,
    preserveRevokeAcrossSupersededRepair: true
  };
  const staleBoundaryClock16 = {
    ...invalidOwnerClockSchedule16,
    smartOnBoundaryAt: ingressBoundary16
  };
  const staleBoundaryNow16 = ingressBoundary16 + 3_000;
  const bareStaleBoundaryHarness16 = loadPwmRepairInterlock16(
    staleBoundaryClock16,
    invalidOwnerClockAt16,
    staleBoundaryNow16,
    { physicalOn: false }
  );
  const bareStaleBoundaryProof16 = await bareStaleBoundaryHarness16.proveOwner(
    41,
    { expectedSmartOnBoundaryAt: ingressBoundary16 }
  );
  const bareStaleBoundaryRepair16 = await bareStaleBoundaryHarness16.repair(
    preserveRevokeOptions16
  );
  assertPass(durableLivePwmOwnerSource16.includes(
      'expectedSmartOnBoundaryAt')
      && durableLivePwmOwnerSource16.includes('retryOwnsBoundary')
      && durableLivePwmOwnerSource16.includes('completedOnOwner')
      && bareStaleBoundaryProof16 === false
      && bareStaleBoundaryRepair16?.preservedReplacementOwner !== true
      && bareStaleBoundaryHarness16.calls.some(call =>
        call.type === 'clear-pwm' && call.at === invalidOwnerClockAt16)
      && bareStaleBoundaryHarness16.snapshot().nextTriggerAt
        === staleBoundaryNow16 + 5 * 60_000
      && bareStaleBoundaryHarness16.snapshot().pwmRetryKind
        === 'smart-on-safe-delay'
      && bareStaleBoundaryHarness16.snapshot().pwmRetryBoundaryAt
        === ingressBoundary16,
    '16F-0B-1E-0C-1: bare 19:30 即使残留 smartOnBoundaryAt=19:00 也不构成 replacement proof；preserve revoke 仍清钟并收口 19:05:03 typed safe-delay');

  const runSameRevisionReplacementCommit16 = async owner => {
    const harness = loadPwmRepairInterlock16(
      staleBoundaryClock16,
      invalidOwnerClockAt16,
      staleBoundaryNow16,
      { physicalOn: false }
    );
    const proofBeforeCommit = await harness.proveOwner(41, {
      expectedSmartOnBoundaryAt: ingressBoundary16
    });
    const executorRevision = harness.beginSameRevisionExecutor();
    const deferredRepair = await harness.repair(preserveRevokeOptions16);
    harness.commitSameRevisionOwner(owner);
    const drainStarted = harness.finishSameRevisionExecutor();
    await harness.drainWaits();
    const proofAfterCommit = await harness.proveOwner(41, {
      expectedSmartOnBoundaryAt: ingressBoundary16
    });
    return {
      harness,
      proofBeforeCommit,
      proofAfterCommit,
      executorRevision,
      deferredRepair,
      drainStarted
    };
  };
  const typedReplacementAt16 = staleBoundaryNow16 + 5 * 60_000;
  const typedSameRevisionReplacement16 = await runSameRevisionReplacementCommit16({
    pwmState: 'on',
    nextTriggerAt: typedReplacementAt16,
    boundaryAt: ingressBoundary16,
    pwmRetryKind: 'smart-on-safe-delay',
    pwmRetryBoundaryAt: ingressBoundary16,
    pwmRetryScheduledAt: typedReplacementAt16,
    smartClockPlannedAt: staleBoundaryNow16
  });
  assertPass(typedSameRevisionReplacement16.proofBeforeCommit === false
      && typedSameRevisionReplacement16.executorRevision === 41
      && typedSameRevisionReplacement16.deferredRepair?.deferred === true
      && typedSameRevisionReplacement16.drainStarted === true
      && typedSameRevisionReplacement16.proofAfterCommit === true
      && typedSameRevisionReplacement16.harness.deferred() === null
      && typedSameRevisionReplacement16.harness.revision() === 41
      && typedSameRevisionReplacement16.harness.snapshot().nextTriggerAt
        === typedReplacementAt16
      && typedSameRevisionReplacement16.harness.durable().nextTriggerAt
        === typedReplacementAt16
      && typedSameRevisionReplacement16.harness.live()
        === typedReplacementAt16
      && !typedSameRevisionReplacement16.harness.calls.some(call =>
        call.type === 'clear-pwm'),
    '16F-0B-1E-0C-2: preserve revoke 初始 proof=false 时同 revision executor 可先提交 19:05 typed 三方；finally drain 重证后保护 replacement，零清钟');

  const completedOffReplacementAt16 = ingressBoundary16 + 23 * 60_000;
  const offSameRevisionReplacement16 = await runSameRevisionReplacementCommit16({
    pwmState: 'off',
    nextTriggerAt: completedOffReplacementAt16,
    boundaryAt: ingressBoundary16,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartClockPlannedAt: ingressBoundary16
  });
  assertPass(offSameRevisionReplacement16.proofBeforeCommit === false
      && offSameRevisionReplacement16.executorRevision === 41
      && offSameRevisionReplacement16.deferredRepair?.deferred === true
      && offSameRevisionReplacement16.drainStarted === true
      && offSameRevisionReplacement16.proofAfterCommit === true
      && offSameRevisionReplacement16.harness.deferred() === null
      && offSameRevisionReplacement16.harness.revision() === 41
      && offSameRevisionReplacement16.harness.snapshot().pwmState === 'off'
      && offSameRevisionReplacement16.harness.snapshot().nextTriggerAt
        === completedOffReplacementAt16
      && offSameRevisionReplacement16.harness.durable().nextTriggerAt
        === completedOffReplacementAt16
      && offSameRevisionReplacement16.harness.live()
        === completedOffReplacementAt16
      && !offSameRevisionReplacement16.harness.calls.some(call =>
        call.type === 'clear-pwm'),
    '16F-0B-1E-0C-3: 同 revision executor 已完成 19:00→19:23 OFF 三方后，preserve revoke drain 识别原边界 ownership 并零清钟');

  let releasePhysicalToggle16;
  let markPhysicalToggleStarted16;
  const physicalToggleGate16 = new Promise(resolve => {
    releasePhysicalToggle16 = resolve;
  });
  const physicalToggleStarted16 = new Promise(resolve => {
    markPhysicalToggleStarted16 = resolve;
  });
  const intendedCutoffAt16 = ingressBoundary16 + 23 * 60_000;
  const executorFirstInterlock16 = loadPwmRepairInterlock16({
    ...invalidOwnerClockSchedule16,
    smartOnBoundaryAt: ingressBoundary16
  }, invalidOwnerClockAt16, ingressBoundary16, {
    physicalOn: false,
    toggleGate: physicalToggleGate16,
    onToggleStart: markPhysicalToggleStarted16,
    intendedCutoffAt: intendedCutoffAt16
  });
  const executorFirstRun16 = executorFirstInterlock16.execute({
    scheduledTime: ingressBoundary16,
    automationRevision: 41,
    source: 'test-physical-on-toggle-pending'
  });
  await physicalToggleStarted16;
  const executorFirstRepair16 = await executorFirstInterlock16.deliverAlarm(
    ingressBoundary16
  );
  const executorFirstGenericRepair16 = await executorFirstInterlock16.repair({});
  const executorFirstQueuedRepair16 = executorFirstInterlock16.deferred();
  const executorFirstPreReleaseSafe16 = executorFirstInterlock16.physicalOn()
    && executorFirstRepair16 === undefined
    && executorFirstGenericRepair16?.deferred === true
    && executorFirstQueuedRepair16?.smartOnExpectedBoundaryAt
      === ingressBoundary16
    && !executorFirstInterlock16.calls.some(call =>
      call.type === 'page-timer'
        || call.type === 'one-minute-alarm'
        || call.type === 'repair-alarm');
  releasePhysicalToggle16();
  const executorFirstHandled16 = await executorFirstRun16;
  await executorFirstInterlock16.drainWaits();
  const executorFirstAfter16 = executorFirstInterlock16.snapshot();
  assertPass(executorFirstPreReleaseSafe16
      && executorFirstHandled16 === true
      && executorFirstInterlock16.deferred() === null
      && executorFirstInterlock16.calls.filter(call =>
        call.type === 'intended-off-alarm').length === 1
      && executorFirstInterlock16.calls.filter(call =>
        call.type === 'repair-alarm').length === 0
      && executorFirstInterlock16.calls.filter(call =>
        call.type === 'one-minute-alarm').length === 0
      && executorFirstInterlock16.calls.filter(call =>
        call.type === 'page-timer').length === 0
      && executorFirstAfter16.pwmState === 'off'
      && executorFirstAfter16.nextTriggerAt === intendedCutoffAt16
      && executorFirstInterlock16.live() === intendedCutoffAt16,
    '16F-0B-1E-0C: 物理 ON/toggle promise 未返回时失配 alarm repair 只合并 trailing；无一分钟钟，最终仅保留 intended OFF cutoff');

  let releaseRepairFirstStatus16;
  let markRepairFirstStatusStarted16;
  const repairFirstStatusGate16 = new Promise(resolve => {
    releaseRepairFirstStatus16 = resolve;
  });
  const repairFirstStatusStarted16 = new Promise(resolve => {
    markRepairFirstStatusStarted16 = resolve;
  });
  const repairFirstInterlock16 = loadPwmRepairInterlock16({
    ...invalidOwnerClockSchedule16,
    nextTriggerAt: ingressBoundary16,
    smartClockPlannedAt: ingressBoundary16,
    alarmCreatedAt: ingressBoundary16,
    alarmDelayMinutes: 0,
    smartOnBoundaryAt: ingressBoundary16
  }, ingressBoundary16, ingressBoundary16, {
    physicalOn: false,
    restoreFromLive: false,
    statusGate: repairFirstStatusGate16,
    onStatusStart: markRepairFirstStatusStarted16,
    statusResults: [{ isOn: false }]
  });
  const repairFirstRepair16 = repairFirstInterlock16.repair({
    smartOnExpectedBoundaryAt: ingressBoundary16
  });
  await repairFirstStatusStarted16;
  const repairFirstOldExecution16 = repairFirstInterlock16.execute({
    scheduledTime: ingressBoundary16,
    automationRevision: 41,
    source: 'test-old-event-waits-for-repair'
  });
  await Promise.resolve();
  const repairFirstWaited16 = !repairFirstInterlock16.calls.some(call =>
    call.type === 'run-pwm' || call.type === 'unexpected-click');
  releaseRepairFirstStatus16();
  const [repairFirstResult16, repairFirstExecutionResult16] = await Promise.all([
    repairFirstRepair16,
    repairFirstOldExecution16
  ]);
  const repairFirstAfter16 = repairFirstInterlock16.snapshot();
  assertPass(repairFirstWaited16
      && repairFirstResult16?.success === true
      && repairFirstExecutionResult16 === false
      && repairFirstInterlock16.calls.filter(call =>
        call.type === 'storage-reload').length === 1
      && repairFirstInterlock16.calls.filter(call =>
        call.type === 'repair-alarm').length === 1
      && repairFirstInterlock16.calls.filter(call =>
        call.type === 'run-pwm' || call.type === 'unexpected-click').length === 0
      && repairFirstInterlock16.calls.filter(call =>
        call.type === 'one-minute-alarm' || call.type === 'page-timer').length === 0
      && repairFirstAfter16.pwmState === 'on'
      && repairFirstAfter16.nextTriggerAt === ingressBoundary16 + 5 * 60_000
      && repairFirstInterlock16.live() === ingressBoundary16 + 5 * 60_000,
    '16F-0B-1E-0D: repair 先入场时旧 executor 等收口后重读 durable/live；所有权已变即零 click/零一分钟钟');

  const phaseDrainCutoffAt16 = ingressBoundary16 + 12 * 60_000;
  const phaseDrainInterlock16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: 0,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    pageTimerMinutes: null,
    pageTimerTargetAt: 0,
    pageTimerError: '',
    smartMode: { enabled: false, sensitivity: 5 }
  }, 0, ingressBoundary16, {
    physicalOn: true,
    restoreFromLive: false,
    phaseGateRepairDuringApply: true
  });
  const phaseDrainAdopted16 = await phaseDrainInterlock16.adopt(
    'test-phase-gate-retains-repair',
    { syncedAt: ingressBoundary16 + 1, enabled: true, repairOptions: {} }
  );
  await phaseDrainInterlock16.drainWaits();
  const phaseDrainAfter16 = phaseDrainInterlock16.snapshot();
  assertPass(phaseDrainAdopted16 === true
      && phaseDrainInterlock16.phaseGateRepairResult()?.deferred === true
      && phaseDrainInterlock16.phaseGateRepairEffectsWhileHeld() === 0
      && phaseDrainInterlock16.deferred() === null
      && phaseDrainInterlock16.calls.filter(call =>
        call.type === 'status').length === 1
      && phaseDrainInterlock16.calls.filter(call =>
        call.type === 'page-timer').length === 1
      && phaseDrainInterlock16.calls.filter(call =>
        call.type === 'repair-alarm').length === 1
      && phaseDrainInterlock16.calls.filter(call =>
        call.type === 'one-minute-alarm').length === 0
      && phaseDrainAfter16.pwmState === 'off'
      && phaseDrainAfter16.pageTimerTargetAt === phaseDrainCutoffAt16
      && phaseDrainAfter16.nextTriggerAt === phaseDrainCutoffAt16
      && phaseDrainInterlock16.live() === phaseDrainCutoffAt16,
    '16F-0B-1E-0E: phase gate 中 physical ON/缺 timer proof 的 repair 持久排队；tryAdopt finally 释放后 drain 并唯一补齐 cutoff');

  const pageAdoptOldAlarmAt16 = ingressBoundary16 + 10 * 60_000;
  const pageAdoptNewAlarmAt16 = ingressBoundary16 + 23 * 60_000;
  let releasePageAdoptPersist16;
  let markPageAdoptPersistStarted16;
  const pageAdoptPersistGate16 = new Promise(resolve => {
    releasePageAdoptPersist16 = resolve;
  });
  const pageAdoptPersistStarted16 = new Promise(resolve => {
    markPageAdoptPersistStarted16 = resolve;
  });
  const adoptionFirstInterlock16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'off',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: pageAdoptOldAlarmAt16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: ingressBoundary16,
    alarmCreatedAt: ingressBoundary16,
    alarmDelayMinutes: 10,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: false, sensitivity: 5 }
  }, pageAdoptOldAlarmAt16, ingressBoundary16, {
    physicalOn: true,
    pageTimerResult: { found: true, value: '19:23' },
    persistGate: pageAdoptPersistGate16,
    onPersistStart: markPageAdoptPersistStarted16
  });
  const adoptionFirstPromise16 = adoptionFirstInterlock16.pageAdopt(
    'test-page-adoption-first'
  );
  await pageAdoptPersistStarted16;
  const adoptionFirstClaimedRevision16 = adoptionFirstInterlock16.revision();
  const adoptionFirstOldExecution16 = await adoptionFirstInterlock16.execute({
    scheduledTime: pageAdoptOldAlarmAt16,
    automationRevision: 41,
    source: 'test-prevalidated-old-alarm-during-page-adopt'
  });
  const adoptionFirstBlockedBeforeRelease16 = adoptionFirstOldExecution16 === false
    && adoptionFirstClaimedRevision16 === 42
    && !adoptionFirstInterlock16.calls.some(call =>
      call.type === 'run-pwm' || call.type === 'unexpected-click');
  releasePageAdoptPersist16();
  const adoptionFirstApplied16 = await adoptionFirstPromise16;
  const adoptionFirstAfter16 = adoptionFirstInterlock16.snapshot();
  const adoptionFirstNewAlarms16 = adoptionFirstInterlock16.calls.filter(call =>
    call.type === 'repair-alarm' && call.tag === 'page-timer-adopt');
  assertPass(adoptionFirstBlockedBeforeRelease16
      && adoptionFirstApplied16 === true
      && adoptionFirstInterlock16.revision() === 42
      && adoptionFirstNewAlarms16.length === 1
      && adoptionFirstNewAlarms16[0].at === pageAdoptNewAlarmAt16
      && adoptionFirstInterlock16.calls.filter(call =>
        call.type === 'run-pwm' || call.type === 'unexpected-click').length === 0
      && adoptionFirstAfter16.pwmState === 'off'
      && adoptionFirstAfter16.nextTriggerAt === pageAdoptNewAlarmAt16
      && adoptionFirstInterlock16.live() === pageAdoptNewAlarmAt16,
    '16F-0B-1E-0F: page adoption 先 claim reservation 再卡在 durable persist；已验权旧 alarm 零 click，释放后新 clock 唯一');

  const staleRevokeBeforePageAdopt16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'off',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: pageAdoptOldAlarmAt16,
    smartOnBoundaryAt: ingressBoundary16,
    smartClockPlannedAt: ingressBoundary16 - 4 * 60_000,
    alarmCreatedAt: ingressBoundary16 - 4 * 60_000,
    alarmDelayMinutes: 14,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: false, sensitivity: 5 }
  }, pageAdoptOldAlarmAt16, ingressBoundary16, {
    physicalOn: true,
    pageTimerResult: { found: true, value: '19:23' }
  });
  staleRevokeBeforePageAdopt16.queue({
    smartOnExpectedBoundaryAt: ingressBoundary16,
    revokeInvalidSmartOnClock: true,
    revokeOwnerRevision: 41
  });
  const staleRevokePageApplied16 = await staleRevokeBeforePageAdopt16.pageAdopt(
    'test-page-phase-supersedes-old-revoke'
  );
  await staleRevokeBeforePageAdopt16.drainWaits();
  const staleRevokePageAfter16 = staleRevokeBeforePageAdopt16.snapshot();
  const staleRevokePageAlarms16 = staleRevokeBeforePageAdopt16.calls.filter(call =>
    call.type === 'repair-alarm');
  assertPass(deferredRepairCoordinatorSource11.includes(
      'revokeOwnerRevision !== pwmRuntimeRevision')
      && repairFunctionSource.includes(
        "reason: 'invalid-clock revoke owner changed'")
      && repairFunctionSource.includes(
        'preserveRevokeAcrossSupersededRepair: true')
      && staleRevokePageApplied16 === true
      && staleRevokeBeforePageAdopt16.revision() === 42
      && staleRevokeBeforePageAdopt16.deferred() === null
      && staleRevokePageAlarms16.length === 1
      && staleRevokePageAlarms16[0].tag === 'page-timer-adopt'
      && staleRevokePageAlarms16[0].at === pageAdoptNewAlarmAt16
      && !staleRevokeBeforePageAdopt16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'smart-on-clock-repair-ownership')
      && staleRevokePageAfter16.pwmState === 'off'
      && staleRevokePageAfter16.nextTriggerAt === pageAdoptNewAlarmAt16
      && staleRevokeBeforePageAdopt16.live() === pageAdoptNewAlarmAt16,
    '16F-0B-1E-0F-1: queued invalid-clock revoke 绑定旧 revision；page phase 换主后 revoke 作废，不能清掉新 clock；同 revision 抢占 generic 仍保留 revoke 语义');

  const expiredPagePhaseAt16 = ingressBoundary16 - 10_000;
  const expiredPageRecoveryAt16 = ingressBoundary16 + 6 * 60_000;
  const expiredPageAdoption16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'off',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: pageAdoptOldAlarmAt16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: 0,
    alarmCreatedAt: ingressBoundary16,
    alarmDelayMinutes: 10,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: false, sensitivity: 5 }
  }, pageAdoptOldAlarmAt16, ingressBoundary16, {
    physicalOn: false,
    pageTimerResult: { found: true, value: '18:59' },
    computePageTimerAdoption: () => ({
      adopt: true,
      nextTriggerAt: expiredPagePhaseAt16,
      source: 'page-timer',
      reason: 'test-stale-within-window'
    }),
    expiredRecoveryAt: expiredPageRecoveryAt16,
    expiredRecoveryAction: 'off'
  });
  const expiredPageApplied16 = await expiredPageAdoption16.pageAdopt(
    'test-expired-page-phase-adoption'
  );
  const expiredPageAfter16 = expiredPageAdoption16.snapshot();
  const expiredPageAdvance16 = expiredPageAdoption16.calls.find(call =>
    call.type === 'advance-expired');
  assertPass(pageTimerAdoptionBody16.includes(
      'adopt.nextTriggerAt,\n        automationRevision,\n        phaseAdmissionEpoch')
      && pageTimerAdoptionBody16.includes(
        "throw new Error('页面过期相位未建立未来恢复时钟')")
      && expiredPageApplied16 === true
      && expiredPageAdvance16?.phaseAdmissionEpoch > 0
      && expiredPageAdvance16?.phaseOwnerAccepted === true
      && expiredPageAdvance16?.revision === 42
      && expiredPageAdoption16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'page-expired-phase-recovery-intent'
          && call.snapshot.nextTriggerAt === expiredPageRecoveryAt16)
      && expiredPageAdoption16.calls.filter(call =>
        call.type === 'repair-alarm'
          && call.tag === 'page-expired-phase-recovery'
          && call.at === expiredPageRecoveryAt16).length === 1
      && expiredPageAfter16.nextTriggerAt === expiredPageRecoveryAt16
      && expiredPageAfter16.nextTriggerAt > ingressBoundary16
      && expiredPageAdoption16.live() === expiredPageRecoveryAt16,
    '16F-0B-1E-0F-2: page 采纳 60s 内过期 phase 时沿 reservation epoch 推进；不会 self-noop，最终 durable/live 均为未来钟');

  const incompletePageNow16 = ingressBoundary16 + 3_000;
  const incompletePageRepairAt16 = incompletePageNow16 + 5 * 60_000;
  const incompletePageReplacement16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: invalidOwnerClockAt16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: ingressBoundary16 - 4 * 60_000,
    alarmCreatedAt: ingressBoundary16 - 4 * 60_000,
    alarmDelayMinutes: 34,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, invalidOwnerClockAt16, incompletePageNow16, {
    physicalOn: false,
    restoreFromLive: false,
    pageTimerResult: { found: true, value: '19:00' },
    computePageTimerAdoption: () => ({
      adopt: true,
      nextTriggerAt: ingressBoundary16,
      source: 'page-timer',
      reason: 'test-due-smart-on'
    }),
    expiredRecoveryAt: incompletePageRepairAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: ingressBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    expiredPageRecoveryPersistFailure: true
  });
  const incompletePageApplied16 = await incompletePageReplacement16.pageAdopt(
    'test-incomplete-page-replacement-owner'
  );
  await incompletePageReplacement16.drainWaits();
  const incompletePageAfter16 = incompletePageReplacement16.snapshot();
  const incompletePageDurable16 = incompletePageReplacement16.durable();
  assertPass(pageTimerAdoptionBody16.includes(
      'const replacementProof = await proveStableDurableLivePwmOwner(')
      && pageTimerAdoptionBody16.includes(
        'const replacementRevision = replacementProof.automationRevision;')
      && pageTimerAdoptionBody16.includes(
        'revokeOwnerRevision: replacementRevision')
      && incompletePageApplied16 === false
      && incompletePageReplacement16.revision() === 43
      && incompletePageReplacement16.calls.filter(call =>
        call.type === 'expired-page-recovery-persist-failure').length === 1
      && incompletePageReplacement16.calls.filter(call =>
        call.type === 'infra-alarm'
          && call.name === 'ac-watchdog'
          && call.info.delayInMinutes === 1
          && call.info.periodInMinutes === 5).length === 1
      && incompletePageReplacement16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'smart-on-clock-repair-ownership'
          && call.snapshot.smartOnBoundaryAt === ingressBoundary16)
      && incompletePageReplacement16.calls.filter(call =>
        call.type === 'repair-alarm'
          && call.at === incompletePageRepairAt16).length === 1
      && !incompletePageReplacement16.calls.some(call =>
        call.type === 'run-pwm' || call.type === 'unexpected-click')
      && incompletePageReplacement16.deferred() === null
      && incompletePageAfter16.nextTriggerAt === incompletePageRepairAt16
      && incompletePageAfter16.nextTriggerAt !== invalidOwnerClockAt16
      && incompletePageAfter16.pwmRetryKind === 'smart-on-safe-delay'
      && incompletePageAfter16.pwmRetryBoundaryAt === ingressBoundary16
      && incompletePageAfter16.pwmRetryScheduledAt === incompletePageRepairAt16
      && incompletePageDurable16.nextTriggerAt === incompletePageRepairAt16
      && incompletePageDurable16.pwmRetryKind === 'smart-on-safe-delay'
      && incompletePageReplacement16.live() === incompletePageRepairAt16,
    '16F-0B-1E-0F-2A: page expired recovery 仅 claim revision 43、intent persist 失败且无 live 时不假保护；沿原 19:00 立即修到 durable/live 19:05 typed safe-delay');

  let releasePageReplacementProof16;
  let markPageReplacementProofStarted16;
  const pageReplacementProofGate16 = new Promise(resolve => {
    releasePageReplacementProof16 = resolve;
  });
  const pageReplacementProofStarted16 = new Promise(resolve => {
    markPageReplacementProofStarted16 = resolve;
  });
  const supersedingPageOwnerAt16 = incompletePageNow16 + 6 * 60_000;
  const pageReplacementProofRace16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: invalidOwnerClockAt16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: ingressBoundary16 - 4 * 60_000,
    alarmCreatedAt: ingressBoundary16 - 4 * 60_000,
    alarmDelayMinutes: 34,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, invalidOwnerClockAt16, incompletePageNow16, {
    physicalOn: false,
    restoreFromLive: false,
    pageTimerResult: { found: true, value: '19:00' },
    computePageTimerAdoption: () => ({
      adopt: true,
      nextTriggerAt: ingressBoundary16,
      source: 'page-timer',
      reason: 'test-due-smart-on-proof-race'
    }),
    expiredRecoveryAt: incompletePageRepairAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: ingressBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    expiredPageRecoveryPersistFailure: true,
    replacementProofGate: pageReplacementProofGate16,
    onReplacementProofStart: markPageReplacementProofStarted16,
    supersedingBoundaryAt: ingressBoundary16
  });
  const pageReplacementProofApply16 = pageReplacementProofRace16.pageAdopt(
    'test-page-replacement-proof-owner-race'
  );
  await pageReplacementProofStarted16;
  const supersedingPageRevision16 = pageReplacementProofRace16
    .supersedeReplacementOwner(supersedingPageOwnerAt16);
  releasePageReplacementProof16();
  const pageReplacementProofApplied16 = await pageReplacementProofApply16;
  await pageReplacementProofRace16.drainWaits();
  const pageReplacementProofAfter16 = pageReplacementProofRace16.snapshot();
  const pageReplacementProofDurable16 = pageReplacementProofRace16.durable();
  assertPass(pageReplacementProofApplied16 === false
      && supersedingPageRevision16 === 44
      && pageReplacementProofRace16.revision() === 44
      && pageReplacementProofRace16.deferred() === null
      && !pageReplacementProofRace16.calls.some(call =>
        (call.type === 'persist'
          && call.reason === 'smart-on-clock-repair-ownership')
          || (call.type === 'infra-alarm' && call.name === 'ac-watchdog'))
      && pageReplacementProofAfter16.nextTriggerAt
        === supersedingPageOwnerAt16
      && pageReplacementProofDurable16.nextTriggerAt
        === supersedingPageOwnerAt16
      && pageReplacementProofRace16.live() === supersedingPageOwnerAt16,
    '16F-0B-1E-0F-2B: page replacement proof await 期间换成三方完整 revision 44 后重证成功；旧 catch 零 mutation/queue/watchdog');

  let releaseIncompletePageReplacementProof16;
  let markIncompletePageReplacementProofStarted16;
  const incompletePageReplacementProofGate16 = new Promise(resolve => {
    releaseIncompletePageReplacementProof16 = resolve;
  });
  const incompletePageReplacementProofStarted16 = new Promise(resolve => {
    markIncompletePageReplacementProofStarted16 = resolve;
  });
  const incompletePageProofOwnerAt16 = incompletePageNow16 + 6 * 60_000;
  const incompletePageProofRace16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: invalidOwnerClockAt16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: ingressBoundary16 - 4 * 60_000,
    alarmCreatedAt: ingressBoundary16 - 4 * 60_000,
    alarmDelayMinutes: 34,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, invalidOwnerClockAt16, incompletePageNow16, {
    physicalOn: false,
    restoreFromLive: false,
    pageTimerResult: { found: true, value: '19:00' },
    computePageTimerAdoption: () => ({
      adopt: true,
      nextTriggerAt: ingressBoundary16,
      source: 'page-timer',
      reason: 'test-due-smart-on-incomplete-proof-race'
    }),
    expiredRecoveryAt: incompletePageRepairAt16,
    expiredRecoveryAction: 'on',
    expiredRecoveryBoundaryAt: ingressBoundary16,
    expiredRecoveryClaimsNewRevision: true,
    expiredPageRecoveryPersistFailure: true,
    replacementProofGate: incompletePageReplacementProofGate16,
    onReplacementProofStart: markIncompletePageReplacementProofStarted16,
    supersedingBoundaryAt: ingressBoundary16
  });
  const incompletePageProofApply16 = incompletePageProofRace16.pageAdopt(
    'test-incomplete-page-replacement-proof-owner-race'
  );
  await incompletePageReplacementProofStarted16;
  const incompletePageProofRevision16 = incompletePageProofRace16
    .supersedeIncompleteReplacementOwner(incompletePageProofOwnerAt16);
  releaseIncompletePageReplacementProof16();
  const incompletePageProofApplied16 = await incompletePageProofApply16;
  await incompletePageProofRace16.drainWaits();
  const incompletePageProofAfter16 = incompletePageProofRace16.snapshot();
  const incompletePageProofDurable16 = incompletePageProofRace16.durable();
  assertPass(incompletePageProofApplied16 === false
      && incompletePageProofRevision16 === 44
      && incompletePageProofRace16.revision() === 44
      && incompletePageProofRace16.deferred() === null
      && incompletePageProofRace16.calls.filter(call =>
        call.type === 'infra-alarm'
          && call.name === 'ac-watchdog'
          && call.info.delayInMinutes === 1).length === 1
      && incompletePageProofRace16.calls.some(call =>
        call.type === 'persist'
          && call.reason === 'smart-on-clock-repair-ownership'
          && call.snapshot.smartOnBoundaryAt === ingressBoundary16)
      && incompletePageProofRace16.calls.filter(call =>
        call.type === 'repair-alarm'
          && call.at === incompletePageRepairAt16).length === 1
      && !incompletePageProofRace16.calls.some(call =>
        call.type === 'run-pwm' || call.type === 'unexpected-click')
      && incompletePageProofAfter16.nextTriggerAt
        === incompletePageRepairAt16
      && incompletePageProofAfter16.nextTriggerAt
        !== incompletePageProofOwnerAt16
      && incompletePageProofAfter16.pwmRetryKind === 'smart-on-safe-delay'
      && incompletePageProofAfter16.pwmRetryBoundaryAt === ingressBoundary16
      && incompletePageProofAfter16.pwmRetryScheduledAt
        === incompletePageRepairAt16
      && incompletePageProofDurable16.nextTriggerAt
        === incompletePageRepairAt16
      && incompletePageProofRace16.live() === incompletePageRepairAt16,
    '16F-0B-1E-0F-2C: page replacement proof await 期间换成不完整 revision 44 后重证失败；沿原 19:00 收口 durable/live 19:05 typed safe-delay');

  const runPageAdoptionFailureInterlock16 = async failureKind => {
    let releaseIntentPersist;
    let markIntentPersistStarted;
    const intentPersistGate = new Promise(resolve => {
      releaseIntentPersist = resolve;
    });
    const intentPersistStarted = new Promise(resolve => {
      markIntentPersistStarted = resolve;
    });
    const harness = loadPwmRepairInterlock16({
      enabled: true,
      pwmState: 'off',
      onMinutes: 12,
      offMinutes: 18,
      nextTriggerAt: pageAdoptOldAlarmAt16,
      smartOnBoundaryAt: 0,
      smartClockPlannedAt: 0,
      alarmCreatedAt: ingressBoundary16,
      alarmDelayMinutes: 10,
      pwmRetryKind: '',
      pwmRetryBoundaryAt: 0,
      pwmRetryScheduledAt: 0,
      pageTimerError: '',
      smartMode: { enabled: false, sensitivity: 5 }
    }, pageAdoptOldAlarmAt16, ingressBoundary16, {
      physicalOn: false,
      restoreFromLive: false,
      pageTimerResult: { found: true, value: '19:23' },
      persistGate: intentPersistGate,
      onPersistStart: markIntentPersistStarted,
      pageAdoptPersistFailure: failureKind === 'persist',
      pageAdoptClearFailure: failureKind === 'clear',
      pageAdoptCreateFailure: failureKind === 'create'
    });
    const adoption = harness.pageAdopt(`test-post-claim-${failureKind}-failure`);
    await intentPersistStarted;
    const oldAlarmDuringReservation = await harness.deliverAlarm(
      pageAdoptOldAlarmAt16
    );
    const zeroActionWhileHeld = oldAlarmDuringReservation === undefined
      && !harness.calls.some(call =>
        call.type === 'run-pwm'
          || call.type === 'unexpected-click'
          || call.type === 'repair-clock');
    releaseIntentPersist();
    const applied = await adoption;
    await harness.drainWaits();
    return {
      failureKind,
      applied,
      zeroActionWhileHeld,
      schedule: harness.snapshot(),
      liveAt: harness.live(),
      calls: harness.calls
    };
  };
  const pageAdoptionFailureResults16 = [];
  for (const failureKind of ['persist', 'clear', 'create']) {
    pageAdoptionFailureResults16.push(
      await runPageAdoptionFailureInterlock16(failureKind)
    );
  }
  assertPass(pageTimerAdoptionBody16.includes(
      'queueDeferredScheduleRepair({')
      && pageTimerAdoptionBody16.includes(
        'smartOnExpectedBoundaryAt: pageAdoptionExpectedBoundaryAt')
      && pageTimerAdoptionBody16.includes(
        'revokeInvalidSmartOnClock: pageAdoptionExpectedBoundaryAt > 0')
      && pageTimerAdoptionBody16.includes(
        'revokeOwnerRevision: automationRevision')
      && pageTimerAdoptionBody16.includes(
        'preserveRevokeAcrossSupersededRepair:')
      && pageTimerAdoptionBody16.includes(
        'pageAdoptionExpectedBoundaryAt > 0')
      && pageTimerAdoptionBody16.includes(
        "delayInMinutes: 1,\n          periodInMinutes: 5")
      && pageTimerAdoptionBody16.includes(
        "drainDeferredScheduleRepair('page-timer-adopt-complete')")
      && pageAdoptionFailureResults16.every(result =>
        result.applied === false
          && result.zeroActionWhileHeld
          && result.schedule.nextTriggerAt > ingressBoundary16
          && result.liveAt === result.schedule.nextTriggerAt
          && result.calls.some(call =>
            call.type === 'persist'
              && String(call.reason).startsWith('page-timer-adopt-error'))
          && result.calls.some(call =>
            call.type === 'infra-alarm'
              && call.name === 'ac-watchdog'
              && call.info.delayInMinutes === 1
              && call.info.periodInMinutes === 5)
          && result.calls.filter(call =>
            call.type === 'repair-alarm').length === 1
          && !result.calls.some(call =>
            call.type === 'run-pwm' || call.type === 'unexpected-click')),
    '16F-0B-1E-0F-3: page adoption claim 后 persist/clear/create 任一异常时旧 alarm 在 reservation 内零 click；释放后立即 repair，durable watchdog 与唯一未来钟收口');

  let releasePageAdoptExecutor16;
  let markPageAdoptExecutorStarted16;
  const pageAdoptExecutorGate16 = new Promise(resolve => {
    releasePageAdoptExecutor16 = resolve;
  });
  const pageAdoptExecutorStarted16 = new Promise(resolve => {
    markPageAdoptExecutorStarted16 = resolve;
  });
  const executorFirstPageAdoptCutoff16 = ingressBoundary16 + 12 * 60_000;
  const executorFirstPageAdopt16 = loadPwmRepairInterlock16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 12,
    offMinutes: 18,
    nextTriggerAt: pageAdoptOldAlarmAt16,
    smartOnBoundaryAt: 0,
    smartClockPlannedAt: ingressBoundary16,
    alarmCreatedAt: ingressBoundary16,
    alarmDelayMinutes: 10,
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0,
    smartMode: { enabled: false, sensitivity: 5 }
  }, pageAdoptOldAlarmAt16, ingressBoundary16, {
    physicalOn: false,
    toggleGate: pageAdoptExecutorGate16,
    onToggleStart: markPageAdoptExecutorStarted16,
    intendedCutoffAt: executorFirstPageAdoptCutoff16,
    pageTimerResult: { found: true, value: '19:23' }
  });
  const executorFirstPageRun16 = executorFirstPageAdopt16.execute({
    scheduledTime: pageAdoptOldAlarmAt16,
    automationRevision: 41,
    source: 'test-executor-first-blocks-page-adopt'
  });
  await pageAdoptExecutorStarted16;
  const pageAdoptDuringExecutor16 = await executorFirstPageAdopt16.pageAdopt(
    'test-executor-first'
  );
  const pageAdoptExitedBeforeRead16 = pageAdoptDuringExecutor16 === false
    && executorFirstPageAdopt16.revision() === 41
    && !executorFirstPageAdopt16.calls.some(call =>
      call.type === 'page-timer-read'
        || (call.type === 'persist'
          && String(call.reason).startsWith('page-timer-adopt'))
        || (call.type === 'repair-alarm' && call.tag === 'page-timer-adopt'));
  releasePageAdoptExecutor16();
  const executorFirstPageHandled16 = await executorFirstPageRun16;
  const executorFirstPageAfter16 = executorFirstPageAdopt16.snapshot();
  assertPass(pageAdoptExitedBeforeRead16
      && executorFirstPageHandled16 === true
      && executorFirstPageAdopt16.calls.filter(call =>
        call.type === 'intended-off-alarm').length === 1
      && executorFirstPageAdopt16.calls.filter(call =>
        call.type === 'repair-alarm' && call.tag === 'page-timer-adopt').length === 0
      && executorFirstPageAfter16.pwmState === 'off'
      && executorFirstPageAfter16.nextTriggerAt === executorFirstPageAdoptCutoff16
      && executorFirstPageAdopt16.live() === executorFirstPageAdoptCutoff16,
    '16F-0B-1E-0G: shared executor 先持有完整执行计数时 page adoption 入场即退出；旧事务唯一提交 intended cutoff');
  const sharedExecutorBoundary16 = new Date(2026, 7, 27, 22, 30, 0, 0).getTime();
  const sharedExecutorRetryAt16 = sharedExecutorBoundary16 + 60_000;
  const sharedExecutorSchedule16 = {
    enabled: true,
    pwmState: 'on',
    onMinutes: 22,
    offMinutes: 8,
    smartMode: { enabled: true },
    smartOnBoundaryAt: sharedExecutorBoundary16,
    pwmRetryKind: 'smart-on',
    pwmRetryBoundaryAt: sharedExecutorBoundary16,
    pwmRetryScheduledAt: sharedExecutorRetryAt16
  };
  const sharedExecutorCalls16 = [];
  const executeSharedPwmStep16 = new Function(
    'schedule', 'pwmRuntimeRevision', 'isAutomationOperationCurrent',
    'isSyncPhaseAdoptionAdmissionBlocked',
    'getSmartOnPwmRetryContext', 'planSmartModeOnWindow', 'SMART_MODE',
    'runPwmStep', 'appendDiagnosticLog',
    'recoverTypedSmartOnAlarmException', 'recoverGenericPwmAlarmException',
    `let pwmExecutionWithRecoveryCount = 0;
    let deferredRepairAfterPwmOptions = null;
    function isSyncPhaseAdoptionAdmissionBlockedFor() {
      return isSyncPhaseAdoptionAdmissionBlocked();
    }
    function isCurrentPwmStepRunning() { return false; }
    function waitUntil(promise) { return Promise.resolve(promise); }
    function drainDeferredScheduleRepair() { return false; }
    async function repairScheduleClock() { return { success: true }; }
    ${pwmStepWithRecoveryBody16}; return executePwmStepWithRecovery;`
  )(
    sharedExecutorSchedule16,
    19,
    revision => revision === 19,
    () => false,
    (snapshot, scheduledTime) => ({
      hasTypedSmartOnRetry: snapshot.pwmRetryKind === 'smart-on'
        && snapshot.pwmRetryScheduledAt === scheduledTime,
      boundaryAt: snapshot.pwmRetryBoundaryAt,
      priorError: snapshot.pageTimerError || ''
    }),
    () => ({
      kind: 'allow',
      reason: 'smart-on-scheduled-boundary',
      boundaryAt: sharedExecutorBoundary16
    }),
    { ON_MAX: 25 },
    async options => {
      sharedExecutorCalls16.push({ type: 'run', options });
      const error = new Error('startup storage reload failed');
      error.pwmAutomationRevision = 19;
      throw error;
    },
    (_level, source) => { sharedExecutorCalls16.push({ type: 'log', source }); },
    async (_alarm, _error, revision, _now, retryContext) => {
      sharedExecutorCalls16.push({ type: 'typed', revision, retryContext });
      return true;
    },
    async () => {
      sharedExecutorCalls16.push({ type: 'generic' });
      return true;
    }
  );
  const sharedExecutorHandled16 = await executeSharedPwmStep16({
    scheduledTime: sharedExecutorRetryAt16,
    automationRevision: 19,
    source: 'setupAlarms-typed-retry'
  });
  assertPass(sharedExecutorHandled16 === true
      && sharedExecutorCalls16.find(call => call.type === 'run')?.options?.scheduledTime
        === sharedExecutorRetryAt16
      && sharedExecutorCalls16.find(call => call.type === 'typed')?.revision === 19
      && sharedExecutorCalls16.find(call => call.type === 'typed')?.retryContext?.boundaryAt
        === sharedExecutorBoundary16
      && !sharedExecutorCalls16.some(call => call.type === 'generic')
      && (backgroundSource.match(/await runPwmStep\(/g) || []).length === 1,
    '16F-0B-1E-1: storage-only 到期 R 在启动恢复抛错时由共享执行器接住并续原 typed 事务；所有入口无裸 runPwmStep');
  const runPostWeatherRecoveryCase16 = async recoveryContext => {
    const captured = { typed: null, generic: null };
    const execute = new Function(
      'schedule', 'pwmRuntimeRevision', 'isAutomationOperationCurrent',
      'isSyncPhaseAdoptionAdmissionBlocked',
      'getSmartOnPwmRetryContext', 'planSmartModeOnWindow', 'SMART_MODE',
      'runPwmStep', 'appendDiagnosticLog',
      'recoverTypedSmartOnAlarmException', 'recoverGenericPwmAlarmException',
      `let pwmExecutionWithRecoveryCount = 0;
      let deferredRepairAfterPwmOptions = null;
      function isSyncPhaseAdoptionAdmissionBlockedFor() {
        return isSyncPhaseAdoptionAdmissionBlocked();
      }
      function isCurrentPwmStepRunning() { return false; }
      function waitUntil(promise) { return Promise.resolve(promise); }
      function drainDeferredScheduleRepair() { return false; }
      async function repairScheduleClock() { return { success: true }; }
      ${pwmStepWithRecoveryBody16}; return executePwmStepWithRecovery;`
    )(
      {
        enabled: true,
        pwmState: 'on',
        onMinutes: 12,
        offMinutes: 18,
        smartMode: { enabled: true },
        smartOnBoundaryAt: sharedExecutorBoundary16,
        pwmRetryKind: '',
        pwmRetryBoundaryAt: 0,
        pwmRetryScheduledAt: 0
      },
      20,
      revision => revision === 20,
      () => false,
      () => ({ hasTypedSmartOnRetry: false, boundaryAt: 0, priorError: '' }),
      () => ({
        kind: 'allow',
        reason: 'smart-on-scheduled-boundary',
        boundaryAt: sharedExecutorBoundary16
      }),
      { ON_MAX: 25 },
      async () => {
        const error = new Error('post-weather throw');
        error.pwmAutomationRevision = 20;
        error.pwmRecoveryContext = recoveryContext;
        throw error;
      },
      () => {},
      async (...args) => {
        captured.typed = args;
        return false;
      },
      async (...args) => {
        captured.generic = args;
        return true;
      }
    );
    const handled = await execute({
      scheduledTime: sharedExecutorBoundary16,
      automationRevision: 20,
      source: 'post-weather-test'
    });
    return { handled, captured };
  };
  const updatedDurationRecovery16 = await runPostWeatherRecoveryCase16({
    retryContext: { hasTypedSmartOnRetry: false, boundaryAt: 0, priorError: '' },
    snapshot: {
      pwmState: 'on',
      onMinutes: 22,
      offMinutes: 8,
      smartOnBoundaryAt: sharedExecutorBoundary16
    },
    smartOnWindow: {
      kind: 'allow',
      reason: 'smart-on-scheduled-boundary',
      boundaryAt: sharedExecutorBoundary16
    }
  });
  const zeroDurationRecovery16 = await runPostWeatherRecoveryCase16({
    retryContext: { hasTypedSmartOnRetry: false, boundaryAt: 0, priorError: '' },
    snapshot: {
      pwmState: 'off',
      onMinutes: 30,
      offMinutes: 30,
      smartOnBoundaryAt: 0
    },
    smartOnWindow: null
  });
  assertPass(updatedDurationRecovery16.handled === true
      && updatedDurationRecovery16.captured.generic?.[3]?.onMinutes === 22
      && updatedDurationRecovery16.captured.generic?.[3]?.offMinutes === 8
      && updatedDurationRecovery16.captured.generic?.[4]?.reason
        === 'smart-on-scheduled-boundary'
      && zeroDurationRecovery16.handled === true
      && zeroDurationRecovery16.captured.generic?.[3]?.pwmState === 'off'
      && zeroDurationRecovery16.captured.generic?.[4] === null,
    '16F-0B-1E-2: 异常恢复优先消费 post-weather 快照；旧 12→新 22 保留 22，on=0 决策保持 OFF 且绝不重造 ON');
  const loadTypedAlarmExceptionRecovery16 = (
    initialSchedule,
    { revisionCurrent = () => true, createResult = true, onCreate = null } = {}
  ) => {
    const testSchedule = { ...initialSchedule };
    const order = [];
    const persisted = [];
    const alarmPlans = [];
    const recover = new Function(
      'schedule', 'getSmartOnPwmRetryContext', 'planSmartOnRetryExceptionRecovery',
      'setNextTriggerAt', 'setSmartOnPwmRetryState', 'clearPwmRetryState',
      'persistSchedule', 'createPwmAlarmFromPlan', 'isAutomationOperationCurrent',
      'createAlarm',
      `${typedAlarmExceptionRecoveryBody16}; return recoverTypedSmartOnAlarmException;`
    )(
      testSchedule,
      (snapshot, scheduledTime) => ({
        hasTypedSmartOnRetry: snapshot.pwmRetryKind === 'smart-on'
          && scheduledTime === snapshot.pwmRetryScheduledAt,
        boundaryAt: snapshot.pwmRetryBoundaryAt,
        priorError: snapshot.pageTimerError
      }),
      pwmPhase.planSmartOnRetryExceptionRecovery,
      value => { testSchedule.nextTriggerAt = value; },
      (_action, scheduledAt) => {
        testSchedule.pwmRetryKind = 'smart-on';
        testSchedule.pwmRetryBoundaryAt = testSchedule.smartOnBoundaryAt;
        testSchedule.pwmRetryScheduledAt = scheduledAt;
      },
      () => {
        testSchedule.pwmRetryKind = '';
        testSchedule.pwmRetryBoundaryAt = 0;
        testSchedule.pwmRetryScheduledAt = 0;
      },
      async reason => {
        order.push(`persist:${reason}`);
        persisted.push(JSON.parse(JSON.stringify(testSchedule)));
      },
      async plan => {
        order.push('create-alarm');
        alarmPlans.push({ ...plan });
        if (typeof onCreate === 'function') onCreate(testSchedule);
        if (!createResult) return false;
        testSchedule.nextTriggerAt = plan.nextTriggerAt + 200;
        return true;
      },
      revisionCurrent,
      async name => { order.push(`alarm:${name}`); }
    );
    return { recover, schedule: testSchedule, order, persisted, alarmPlans };
  };
  const exceptionBoundary16 = new Date(2026, 7, 27, 22, 30, 0, 0).getTime();
  const exceptionRetryAt16 = new Date(2026, 7, 27, 22, 31, 0, 0).getTime();
  const safeExceptionHarness16 = loadTypedAlarmExceptionRecovery16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 21,
    offMinutes: 9,
    pageTimerError: '首轮 ON 未确认',
    smartMode: { enabled: true },
    smartOnBoundaryAt: exceptionBoundary16,
    pwmRetryKind: 'smart-on',
    pwmRetryBoundaryAt: exceptionBoundary16,
    pwmRetryScheduledAt: exceptionRetryAt16,
    nextTriggerAt: exceptionRetryAt16
  });
  const frozenExceptionContext16 = {
    hasTypedSmartOnRetry: true,
    boundaryAt: exceptionBoundary16,
    priorError: '首轮 ON 未确认'
  };
  // 模拟 runPwmStep 已 clear marker/清错误，随后创建 commit alarm 才抛错。
  safeExceptionHarness16.schedule.pwmRetryKind = '';
  safeExceptionHarness16.schedule.pwmRetryBoundaryAt = 0;
  safeExceptionHarness16.schedule.pwmRetryScheduledAt = 0;
  safeExceptionHarness16.schedule.pageTimerError = '';
  const safeExceptionHandled16 = await safeExceptionHarness16.recover(
    { scheduledTime: exceptionRetryAt16 },
    new Error('synthetic retry throw'),
    7,
    exceptionRetryAt16,
    frozenExceptionContext16
  );
  assertPass(safeExceptionHandled16 === true
      && safeExceptionHarness16.order[0] === 'persist:onAlarm-smart-on-error-intent'
      && safeExceptionHarness16.order[1] === 'create-alarm'
      && safeExceptionHarness16.alarmPlans[0]?.kind === 'retry-smart-on-exception'
      && safeExceptionHarness16.schedule.pwmRetryScheduledAt
        === safeExceptionHarness16.schedule.nextTriggerAt
      && safeExceptionHarness16.schedule.pageTimerError.includes('synthetic retry throw'),
    '16F-0B-1F: 动态 throw 在安全窗内只续一分钟，intent 先持久化并把 marker 改绑 canonical alarm');
  const unsafeExceptionHarness16 = loadTypedAlarmExceptionRecovery16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 21,
    offMinutes: 9,
    pageTimerError: '首轮 ON 未确认',
    smartMode: { enabled: true },
    smartOnBoundaryAt: exceptionBoundary16,
    pwmRetryKind: 'smart-on',
    pwmRetryBoundaryAt: exceptionBoundary16,
    pwmRetryScheduledAt: exceptionRetryAt16,
    nextTriggerAt: exceptionRetryAt16
  });
  await unsafeExceptionHarness16.recover(
    { scheduledTime: exceptionRetryAt16 },
    new Error('late retry throw'),
    8,
    new Date(2026, 7, 27, 22, 50, 0, 0).getTime()
  );
  assertPass(unsafeExceptionHarness16.alarmPlans[0]?.kind === 'defer'
      && unsafeExceptionHarness16.alarmPlans[0]?.nextTriggerAt
        === new Date(2026, 7, 27, 23, 0, 0, 0).getTime()
      && unsafeExceptionHarness16.schedule.pwmRetryKind === ''
      && unsafeExceptionHarness16.schedule.pageTimerError.includes('等待下一个半点'),
    '16F-0B-1G: 动态 throw 已超安全余量时清 marker、保留红灯并建立下一半点时钟');
  let typedCreateRaceCurrent16 = true;
  const typedCreateRaceHarness16 = loadTypedAlarmExceptionRecovery16({
    enabled: true,
    pwmState: 'on',
    onMinutes: 21,
    offMinutes: 9,
    pageTimerError: '首轮 ON 未确认',
    smartMode: { enabled: true },
    smartOnBoundaryAt: exceptionBoundary16,
    pwmRetryKind: 'smart-on',
    pwmRetryBoundaryAt: exceptionBoundary16,
    pwmRetryScheduledAt: exceptionRetryAt16,
    nextTriggerAt: exceptionRetryAt16
  }, {
    revisionCurrent: () => typedCreateRaceCurrent16,
    createResult: false,
    onCreate: currentSchedule => {
      typedCreateRaceCurrent16 = false;
      Object.assign(currentSchedule, {
        enabled: false,
        pwmState: 'off',
        nextTriggerAt: 0,
        pageTimerError: 'NEW-LIFECYCLE',
        pwmRetryKind: '',
        pwmRetryBoundaryAt: 0,
        pwmRetryScheduledAt: 0
      });
    }
  });
  await typedCreateRaceHarness16.recover(
    { scheduledTime: exceptionRetryAt16 },
    new Error('typed create race'),
    18,
    exceptionRetryAt16
  );
  assertPass(typedCreateRaceHarness16.order.join(',')
        === 'persist:onAlarm-smart-on-error-intent,create-alarm'
      && typedCreateRaceHarness16.schedule.pageTimerError === 'NEW-LIFECYCLE'
      && typedCreateRaceHarness16.schedule.enabled === false
      && typedCreateRaceHarness16.schedule.nextTriggerAt === 0,
    '16F-0B-1G-0: typed 恢复建钟期间 revision 失效后不追加旧错误、不二次 persist、不污染新 lifecycle');
  const loadGenericAlarmExceptionRecovery16 = ({
    initialSchedule,
    revisionCurrent = () => true,
    createResult = true,
    onCreate = null
  }) => {
    const testSchedule = { ...initialSchedule };
    const order = [];
    const persisted = [];
    const alarmPlans = [];
    const recover = new Function(
      'schedule', 'isAutomationOperationCurrent',
      'planSmartOnRetryExceptionRecovery', 'setNextTriggerAt',
      'setSmartOnPwmRetryState', 'clearPwmRetryState',
      'persistSchedule', 'createPwmAlarmFromPlan', 'createAlarm',
      `${genericAlarmExceptionRecoveryBody16}; return recoverGenericPwmAlarmException;`
    )(
      testSchedule,
      typeof revisionCurrent === 'function' ? revisionCurrent : () => revisionCurrent,
      pwmPhase.planSmartOnRetryExceptionRecovery,
      value => { testSchedule.nextTriggerAt = value; },
      (_action, scheduledAt) => {
        testSchedule.pwmRetryKind = 'smart-on';
        testSchedule.pwmRetryBoundaryAt = testSchedule.smartOnBoundaryAt;
        testSchedule.pwmRetryScheduledAt = scheduledAt;
      },
      () => {
        testSchedule.pwmRetryKind = '';
        testSchedule.pwmRetryBoundaryAt = 0;
        testSchedule.pwmRetryScheduledAt = 0;
      },
      async reason => {
        order.push(`persist:${reason}`);
        persisted.push(JSON.parse(JSON.stringify(testSchedule)));
      },
      async plan => {
        order.push('create-alarm');
        alarmPlans.push({ ...plan });
        if (typeof onCreate === 'function') onCreate(testSchedule);
        if (!createResult) return false;
        testSchedule.nextTriggerAt = plan.nextTriggerAt + 200;
        return true;
      },
      async name => { order.push(`alarm:${name}`); }
    );
    return { recover, schedule: testSchedule, order, persisted, alarmPlans };
  };
  const genericSmartHarness16 = loadGenericAlarmExceptionRecovery16({
    initialSchedule: {
      enabled: true,
      pwmState: 'off',
      onMinutes: 5,
      offMinutes: 25,
      pageTimerError: '',
      smartMode: { enabled: true },
      smartOnBoundaryAt: 0,
      pwmRetryKind: '',
      pwmRetryBoundaryAt: 0,
      pwmRetryScheduledAt: 0,
      nextTriggerAt: 0
    }
  });
  const genericSmartNow16 = exceptionBoundary16 + 202;
  await genericSmartHarness16.recover(
    { scheduledTime: genericSmartNow16 },
    new Error('initial smart throw'),
    10,
    { pwmState: 'on', onMinutes: 22, offMinutes: 8 },
    {
      kind: 'allow',
      reason: 'smart-on-scheduled-boundary',
      boundaryAt: exceptionBoundary16
    },
    genericSmartNow16
  );
  assertPass(genericSmartHarness16.order[0] === 'persist:onAlarm-error-recovery-intent'
      && genericSmartHarness16.order[1] === 'create-alarm'
      && genericSmartHarness16.order[2] === 'alarm:ac-badge-tick'
      && genericSmartHarness16.order[3] === 'persist:onAlarm-error-recovery-retry'
      && genericSmartHarness16.persisted.length === 2
      && genericSmartHarness16.alarmPlans[0]?.kind === 'retry-smart-on-exception'
      && genericSmartHarness16.alarmPlans[0]?.nextTriggerAt === genericSmartNow16 + 60_000
      && genericSmartHarness16.schedule.pwmState === 'on'
      && genericSmartHarness16.schedule.onMinutes === 22
      && genericSmartHarness16.schedule.offMinutes === 8
      && genericSmartHarness16.schedule.pwmRetryBoundaryAt === exceptionBoundary16
      && genericSmartHarness16.schedule.pwmRetryScheduledAt
        === genericSmartHarness16.schedule.nextTriggerAt
      && genericSmartHarness16.persisted[1]?.pwmRetryScheduledAt
        === genericSmartHarness16.schedule.nextTriggerAt
      && genericSmartHarness16.schedule.pageTimerError.includes('initial smart throw'),
    '16F-0B-1G-1: 首次半点智能 ON 抛错也冻结入场时长/边界，intent-first 且只延后 1 分钟');
  const genericIntervalHarness16 = loadGenericAlarmExceptionRecovery16({
    initialSchedule: {
      enabled: true,
      pwmState: 'on',
      onMinutes: 21,
      offMinutes: 9,
      pageTimerError: '',
      smartMode: { enabled: false },
      pwmRetryKind: '',
      pwmRetryBoundaryAt: 0,
      pwmRetryScheduledAt: 0,
      nextTriggerAt: 0
    }
  });
  const genericIntervalNow16 = exceptionBoundary16 + 5 * 60_000;
  await genericIntervalHarness16.recover(
    { scheduledTime: genericIntervalNow16 },
    new Error('interval throw'),
    11,
    { pwmState: 'off', onMinutes: 21, offMinutes: 9 },
    null,
    genericIntervalNow16
  );
  assertPass(genericIntervalHarness16.alarmPlans[0]?.kind === 'retry-pwm-exception'
      && genericIntervalHarness16.alarmPlans[0]?.nextTriggerAt
        === genericIntervalNow16 + 60_000
      && genericIntervalHarness16.schedule.pwmState === 'off'
      && genericIntervalHarness16.schedule.pwmRetryKind === ''
      && genericIntervalHarness16.persisted.length === 2
      && genericIntervalHarness16.persisted[1]?.nextTriggerAt
        === genericIntervalHarness16.schedule.nextTriggerAt
      && genericIntervalHarness16.persisted[1]?.pwmRetryKind === ''
      && genericIntervalHarness16.schedule.pageTimerError.includes('interval throw'),
    '16F-0B-1G-2: 普通 PWM throw 恢复入场 action 且固定 1 分钟重试，不按 on/off 长周期跳钟');
  const staleGenericHarness16 = loadGenericAlarmExceptionRecovery16({
    initialSchedule: {
      enabled: false,
      pwmState: 'off',
      onMinutes: 21,
      offMinutes: 9,
      pageTimerError: '',
      smartMode: { enabled: false },
      nextTriggerAt: 0
    },
    revisionCurrent: false
  });
  const staleGenericBefore16 = JSON.stringify(staleGenericHarness16.schedule);
  const staleGenericHandled16 = await staleGenericHarness16.recover(
    { scheduledTime: genericIntervalNow16 },
    new Error('stale throw'),
    12,
    { pwmState: 'on', onMinutes: 22, offMinutes: 8 },
    null,
    genericIntervalNow16
  );
  assertPass(staleGenericHandled16 === true
      && staleGenericHarness16.order.length === 0
      && staleGenericHarness16.alarmPlans.length === 0
      && JSON.stringify(staleGenericHarness16.schedule) === staleGenericBefore16,
    '16F-0B-1G-3: 用户停用/新周期后旧异常为零写入，不能复活旧 phase 或 PWM alarm');
  let genericCreateRaceCurrent16 = true;
  const genericCreateRaceHarness16 = loadGenericAlarmExceptionRecovery16({
    initialSchedule: {
      enabled: true,
      pwmState: 'on',
      onMinutes: 21,
      offMinutes: 9,
      pageTimerError: '',
      smartMode: { enabled: false },
      nextTriggerAt: genericIntervalNow16
    },
    revisionCurrent: () => genericCreateRaceCurrent16,
    createResult: false,
    onCreate: currentSchedule => {
      genericCreateRaceCurrent16 = false;
      Object.assign(currentSchedule, {
        enabled: false,
        pwmState: 'off',
        nextTriggerAt: 0,
        pageTimerError: 'NEW-GENERIC-LIFECYCLE'
      });
    }
  });
  await genericCreateRaceHarness16.recover(
    { scheduledTime: genericIntervalNow16 },
    new Error('generic create race'),
    13,
    { pwmState: 'on', onMinutes: 21, offMinutes: 9 },
    null,
    genericIntervalNow16
  );
  assertPass(genericCreateRaceHarness16.order.join(',')
        === 'persist:onAlarm-error-recovery-intent,create-alarm'
      && genericCreateRaceHarness16.schedule.pageTimerError
        === 'NEW-GENERIC-LIFECYCLE'
      && genericCreateRaceHarness16.schedule.enabled === false
      && genericCreateRaceHarness16.schedule.nextTriggerAt === 0,
    '16F-0B-1G-4: generic 建钟期间 revision 失效后不追加失败错误或 persist，不覆盖新 lifecycle sentinel');
  const deferIntentIndex16 = pwmBody.indexOf("persistSchedule('runPwmStep-smart-on-deferred-intent'");
  const deferAlarmIndex16 = pwmBody.indexOf("'PWM-smart-on-deferred'", deferIntentIndex16);
  const commitIntentIndex16 = pwmBody.indexOf("persistSchedule('runPwmStep-commit-intent'");
  const commitAlarmIndex16 = pwmBody.indexOf("createPwmAlarmFromPlan(plan, 'PWM'", commitIntentIndex16);
  assertPass(deferIntentIndex16 > 0
      && deferAlarmIndex16 > deferIntentIndex16
      && pwmBody.includes("persistSchedule('runPwmStep-smart-on-deferred-alarm-failed'")
      && pwmBody.indexOf('if (!isAutomationOperationCurrent(automationRevision)) return;', deferAlarmIndex16)
        < pwmBody.indexOf("persistSchedule('runPwmStep-smart-on-deferred-alarm-failed'", deferAlarmIndex16)
      && commitIntentIndex16 > 0
      && commitAlarmIndex16 > commitIntentIndex16
      && pwmBody.includes("persistSchedule('runPwmStep-commit-alarm-failed'")
      && pwmBody.indexOf('if (!isAutomationOperationCurrent(automationRevision)) return;', commitAlarmIndex16)
        < pwmBody.indexOf("persistSchedule('runPwmStep-commit-alarm-failed'", commitAlarmIndex16),
    '16F-0B-1H: defer/commit intent-first；建钟 false 只允许当前 revision 写红灯，旧 run 不得覆盖停用/新周期');
  const deferDurableStart16 = pwmBody.indexOf("    if (plan.kind === 'defer') {");
  const deferDurableEnd16 = pwmBody.indexOf(
    "\n    if (plan.kind === 'refuse') {",
    deferDurableStart16
  );
  const deferDurableSource16 = deferDurableStart16 >= 0
      && deferDurableEnd16 > deferDurableStart16
    ? pwmBody.slice(deferDurableStart16, deferDurableEnd16)
    : '';
  const loadDeferAlarmFailure16 = ({ staleDuringCreate = false } = {}) => {
    const testSchedule = {
      enabled: true,
      pwmState: 'on',
      nextTriggerAt: exceptionRetryAt16,
      pageTimerError: '原半点 ON 未确认',
      pwmRetryKind: 'smart-on',
      pwmRetryBoundaryAt: exceptionBoundary16,
      pwmRetryScheduledAt: exceptionRetryAt16
    };
    let current = true;
    const order = [];
    const persisted = [];
    const run = new Function(
      'schedule', 'hasTypedSmartOnRetry', 'priorPwmRetryError',
      'rejectedSmartOnRetryError', 'applyPwmPlanState', 'clearPwmRetryState',
      'setSmartOnPwmRetryState', 'halfHourBoundaryAtOrBefore',
      'persistSchedule', 'clearPwmAlarm', 'createPwmAlarmFromPlan',
      'isAutomationOperationCurrent', 'createAlarm', 'abortStaleAutomation',
      'updateBadge', 'syncScheduleToSync',
      `return async function runDeferFailure(plan, automationRevision) {
${deferDurableSource16}
};`
    )(
      testSchedule,
      true,
      '原半点 ON 未确认',
      '',
      plan => Object.assign(testSchedule, plan.phasePatch),
      () => {
        testSchedule.pwmRetryKind = '';
        testSchedule.pwmRetryBoundaryAt = 0;
        testSchedule.pwmRetryScheduledAt = 0;
      },
      (_action, scheduledAt, options = {}) => {
        testSchedule.pwmRetryKind = options.kind || 'smart-on';
        testSchedule.pwmRetryBoundaryAt = Number(options.boundaryAt) || 0;
        testSchedule.pwmRetryScheduledAt = Number(scheduledAt) || 0;
      },
      pwmPhase.halfHourBoundaryAtOrBefore,
      async reason => {
        order.push(`persist:${reason}`);
        persisted.push(JSON.parse(JSON.stringify(testSchedule)));
      },
      async () => { order.push('clear-pwm'); return true; },
      async () => {
        order.push('create-alarm:false');
        if (staleDuringCreate) {
          current = false;
          Object.assign(testSchedule, {
            enabled: false,
            pwmState: 'off',
            nextTriggerAt: 0,
            pageTimerError: 'NEW-DEFER-LIFECYCLE'
          });
        }
        return false;
      },
      () => current,
      async name => { order.push(`alarm:${name}`); return true; },
      async () => false,
      async () => { order.push('update-badge'); },
      async () => { order.push('sync'); }
    );
    return { run, schedule: testSchedule, order, persisted };
  };
  const deferredFailure16 = loadDeferAlarmFailure16();
  const deferredTarget16 = new Date(2026, 7, 27, 23, 0, 0, 0).getTime();
  await deferredFailure16.run({
    kind: 'defer',
    phasePatch: { pwmState: 'on', nextTriggerAt: deferredTarget16 },
    nextTriggerAt: deferredTarget16
  }, 22);
  assertPass(deferredFailure16.order.join(',')
        === 'persist:runPwmStep-smart-on-deferred-intent,clear-pwm,create-alarm:false,persist:runPwmStep-smart-on-deferred-alarm-failed'
      && deferredFailure16.persisted[0]?.pwmState === 'on'
      && deferredFailure16.persisted[0]?.nextTriggerAt === deferredTarget16
      && deferredFailure16.persisted[0]?.pwmRetryKind === 'smart-on-safety-skip'
      && deferredFailure16.persisted[0]?.pwmRetryBoundaryAt
        === pwmPhase.halfHourBoundaryAtOrBefore(deferredTarget16 - 1)
      && deferredFailure16.persisted[0]?.pwmRetryScheduledAt === deferredTarget16
      && deferredFailure16.persisted[1]?.pwmRetryKind === 'smart-on-safety-skip'
      && deferredFailure16.persisted[1]?.pageTimerError.includes('等待看门狗恢复')
      && !deferredFailure16.order.some(item => item === 'update-badge' || item === 'sync'),
    '16F-0B-1H-1: smart defer 建钟 false 保留下一半点 durable safety-skip marker 并写红灯，不执行 badge/sync 成功尾段');
  const staleDeferredFailure16 = loadDeferAlarmFailure16({ staleDuringCreate: true });
  await staleDeferredFailure16.run({
    kind: 'defer',
    phasePatch: { pwmState: 'on', nextTriggerAt: deferredTarget16 },
    nextTriggerAt: deferredTarget16
  }, 23);
  assertPass(staleDeferredFailure16.order.join(',')
        === 'persist:runPwmStep-smart-on-deferred-intent,clear-pwm,create-alarm:false'
      && staleDeferredFailure16.schedule.pageTimerError === 'NEW-DEFER-LIFECYCLE'
      && staleDeferredFailure16.schedule.enabled === false
      && staleDeferredFailure16.schedule.nextTriggerAt === 0,
    '16F-0B-1H-2: smart defer 建钟期间 revision 失效后零失败写回，不覆盖新 lifecycle sentinel');
  const commitDurableStart16 = pwmBody.lastIndexOf('    applyPwmPlanState(plan);');
  const commitDurableEnd16 = pwmBody.indexOf(
    '    console.log(`[AC扩展] PWM 下一阶段:',
    commitDurableStart16
  );
  const commitDurableSource16 = commitDurableStart16 >= 0
      && commitDurableEnd16 > commitDurableStart16
    ? pwmBody.slice(commitDurableStart16, commitDurableEnd16)
    : '';
  const commitFailureSchedule16 = {
    pwmState: 'on',
    nextTriggerAt: exceptionRetryAt16,
    pageTimerError: '',
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  };
  const commitFailureOrder16 = [];
  const commitFailureSnapshots16 = [];
  const runCommitAlarmFailure16 = new Function(
    'schedule', 'applyPwmPlanState', 'abortStaleAutomation',
    'persistSchedule', 'createPwmAlarmFromPlan', 'isAutomationOperationCurrent',
    `return async function runCommitFailure(plan, automationRevision) {
${commitDurableSource16}
};`
  )(
    commitFailureSchedule16,
    plan => Object.assign(commitFailureSchedule16, plan.phasePatch),
    async () => false,
    async reason => {
      commitFailureOrder16.push(`persist:${reason}`);
      commitFailureSnapshots16.push(JSON.parse(JSON.stringify(commitFailureSchedule16)));
    },
    async () => { commitFailureOrder16.push('create-alarm:false'); return false; },
    () => true
  );
  const commitFailureTarget16 = exceptionBoundary16 + 21 * 60_000;
  await runCommitAlarmFailure16({
    kind: 'commit',
    phasePatch: { pwmState: 'off', nextTriggerAt: commitFailureTarget16 }
  }, 9);
  assertPass(commitFailureOrder16.join(',')
        === 'persist:runPwmStep-commit-intent,create-alarm:false,persist:runPwmStep-commit-alarm-failed'
      && commitFailureSnapshots16[0]?.pwmState === 'off'
      && commitFailureSnapshots16[0]?.nextTriggerAt === commitFailureTarget16
      && commitFailureSnapshots16[1]?.pageTimerError.includes('等待看门狗恢复'),
    '16F-0B-1I: 动态 commit 建钟 false 时 durable phase/截止已落盘，并追加红灯而非留下无钟绿态');
  let staleCommitCurrent16 = true;
  const staleCommitSchedule16 = {
    pwmState: 'on',
    nextTriggerAt: exceptionRetryAt16,
    pageTimerError: ''
  };
  const staleCommitOrder16 = [];
  const runStaleCommitFailure16 = new Function(
    'schedule', 'applyPwmPlanState', 'abortStaleAutomation',
    'persistSchedule', 'createPwmAlarmFromPlan', 'isAutomationOperationCurrent',
    `return async function runCommitFailure(plan, automationRevision) {
${commitDurableSource16}
};`
  )(
    staleCommitSchedule16,
    plan => Object.assign(staleCommitSchedule16, plan.phasePatch),
    async () => false,
    async reason => { staleCommitOrder16.push(`persist:${reason}`); },
    async () => {
      staleCommitOrder16.push('create-alarm:false');
      staleCommitCurrent16 = false;
      Object.assign(staleCommitSchedule16, {
        enabled: false,
        pwmState: 'on',
        nextTriggerAt: 0,
        pageTimerError: 'NEW-COMMIT-LIFECYCLE'
      });
      return false;
    },
    () => staleCommitCurrent16
  );
  await runStaleCommitFailure16({
    kind: 'commit',
    phasePatch: { pwmState: 'off', nextTriggerAt: commitFailureTarget16 }
  }, 21);
  assertPass(staleCommitOrder16.join(',')
        === 'persist:runPwmStep-commit-intent,create-alarm:false'
      && staleCommitSchedule16.pageTimerError === 'NEW-COMMIT-LIFECYCLE'
      && staleCommitSchedule16.enabled === false
      && staleCommitSchedule16.nextTriggerAt === 0,
    '16F-0B-1I-1: commit 建钟期间 revision 失效后仅保留已发生的 intent，不写旧失败状态覆盖新 lifecycle');
  const smartAutomaticOnStart16 = pwmBody.indexOf(
    'function planSmartAutomaticOn(targetAction, acIsOn) {'
  );
  const smartAutomaticOnEnd16 = pwmBody.indexOf(
    '\n  // 提取（Fowler Extract Function）：PWM 开机 hold 分支',
    smartAutomaticOnStart16
  );
  const smartAutomaticOnSource16 = smartAutomaticOnStart16 >= 0
      && smartAutomaticOnEnd16 > smartAutomaticOnStart16
    ? pwmBody.slice(smartAutomaticOnStart16, smartAutomaticOnEnd16)
    : '';
  const runSmartAutomaticOnContext16 = ({
    retryingSmartOn,
    smartOnRetryBoundaryAt,
    pwmTriggerScheduledTime,
    recoveringSmartCurrentCycle = false
  }) => {
    let captured = null;
    const schedule = {
      smartMode: { enabled: true },
      smartOnBoundaryAt: delayedSmartBoundary16,
      onMinutes: 21
    };
    const planSmartAutomaticOn = new Function(
      'schedule', 'retryingSmartOn', 'smartOnRetryBoundaryAt',
      'pwmTriggerScheduledTime', 'recoveringSmartCurrentCycle',
      'SMART_MODE', 'planSmartModeOnWindow',
      `${smartAutomaticOnSource16}; return planSmartAutomaticOn;`
    )(
      schedule,
      retryingSmartOn,
      smartOnRetryBoundaryAt,
      pwmTriggerScheduledTime,
      recoveringSmartCurrentCycle,
      { ON_MAX: 25 },
      (_schedule, options) => {
        captured = options;
        return { kind: 'allow' };
      }
    );
    planSmartAutomaticOn('on', false);
    return captured;
  };
  const typedRetryContext16 = runSmartAutomaticOnContext16({
    retryingSmartOn: true,
    smartOnRetryBoundaryAt: delayedSmartBoundary16,
    pwmTriggerScheduledTime: delayedSmartBoundary16 + 60_000
  });
  const ordinaryLateContext16 = runSmartAutomaticOnContext16({
    retryingSmartOn: false,
    smartOnRetryBoundaryAt: 0,
    pwmTriggerScheduledTime: delayedSmartBoundary16 + 60_000
  });
  assertPass(typedRetryContext16?.boundaryAt === delayedSmartBoundary16
      && typedRetryContext16?.triggeredBoundaryAt === delayedSmartBoundary16
      && typedRetryContext16?.recoverCurrentCycle === true
      && ordinaryLateContext16?.triggeredBoundaryAt
        === delayedSmartBoundary16 + 60_000
      && ordinaryLateContext16?.recoverCurrentCycle === false,
    '16F-0B-2: typed retry 消费原半点；无 provenance 的普通 22:31 仍保留原调用时间并受窗口门禁');
  assertPass(backgroundSource.includes(
      'alreadyDone: result?.alreadyDone === true'
    )
      && backgroundSource.includes(
        'observations.toggleAlreadyDone = toggleResult?.alreadyDone === true;'
      )
      && backgroundSource.includes(
        '页面已 ON，零点击，已直接确认 Power-off after'
      ),
    '16F-0C: 主世界已 ON 的幂等结果显式回传，PWM 零点击后直接进入页面关机定时器');
  assertPass(!backgroundSource.includes('async function recoverSmartCurrentCycleIfNeeded(')
      && !backgroundSource.includes('function planSmartCurrentCycleRecovery(')
      && smartRecoverySource.includes('function planSmartRecovery(')
      && smartRecoverySource.includes('recoverCurrentCycle: true')
      && recoveryCoordinatorSource.includes('function planPwmLifecycleRecovery(')
      && advanceBody.includes("source: 'expired-alarm'")
      && setupAlarmsBody16.includes("source: 'setupAlarms'")
      && watchdogBody13.includes("source: 'watchdogCheck'"),
    '16F-0E: 过期闹钟、启动恢复与看门狗共享协调器，智能与普通循环策略各自独立');
  const rescheduleActiveBoundaryBody16 = extractSourceSection(
    backgroundSource,
    'async function rescheduleActiveBoundaryUnsafe(options = {}) {',
    '\n// 调度下一次 :20/:50 天气预取',
    'rescheduleActiveBoundary exact deadline'
  );
  assertPass(rescheduleActiveBoundaryBody16.includes(
      'const naturalBoundaryAt = getNextActiveBoundary(new Date(now));'
    )
      && rescheduleActiveBoundaryBody16.includes(
        'await createActiveBoundaryAlarmWithRetry(naturalBoundaryAt)')
      && !rescheduleActiveBoundaryBody16.includes(
        "createAlarm('ac-active-boundary', { delayInMinutes"),
    '16F-1: 运行时段边界使用绝对 when，不因临近边界的 1 分钟下限延迟暂停或恢复');
  assertPass(activeBoundaryBody16.includes("requestTimerBasedShutdown('active-hours-leave')")
      && !activeBoundaryBody16.includes('schedule.enabled = false')
      && !activeBoundaryBody16.includes("toggleAC('off')"),
    '16G: 离开时段保留模式启用意图，并只用 Power-off after 安全停机');

  const createAlarmSource16 = extractSourceSection(
    backgroundSource,
    'async function createAlarm(name, info) {',
    '\nasync function createPwmAlarmWithVerify',
    'createAlarm runtime gate'
  );
  const createAlarmHarness16 = new Function(
    'chrome', 'isAutomationAllowed', 'appendDiagnosticLog', 'AUTOMATION_RUNTIME_ALARMS',
    `${createAlarmSource16}; return createAlarm;`
  );
  const runtimeAlarmCreates16 = [];
  const runtimeAlarmClears16 = [];
  let automationAllowed16 = false;
  let closeGateDuringCreate16 = false;
  const runtimeAlarmChrome16 = {
    alarms: {
      async create(name) {
        runtimeAlarmCreates16.push(name);
        if (closeGateDuringCreate16) automationAllowed16 = false;
      },
      async get(name) { return { name, scheduledTime: Date.now() + 60_000 }; },
      async clear(name) { runtimeAlarmClears16.push(name); return true; }
    }
  };
  const createRuntimeAlarm16 = createAlarmHarness16(
    runtimeAlarmChrome16,
    () => automationAllowed16,
    () => {},
    new Set(['ac-pwm', 'ac-badge-tick', 'ac-watchdog'])
  );
  const blockedPwmCreated16 = await createRuntimeAlarm16('ac-pwm', { delayInMinutes: 1 });
  const blockedBadgeCreated16 = await createRuntimeAlarm16('ac-badge-tick', { delayInMinutes: 1 });
  const weatherCreated16 = await createRuntimeAlarm16('ac-smart-weather', { delayInMinutes: 1 });
  automationAllowed16 = true;
  closeGateDuringCreate16 = true;
  const crossedBoundaryCreated16 = await createRuntimeAlarm16('ac-pwm', { delayInMinutes: 1 });
  assertPass(blockedPwmCreated16 === false
      && blockedBadgeCreated16 === false
      && weatherCreated16 === true
      && crossedBoundaryCreated16 === false
      && runtimeAlarmCreates16.join(',') === 'ac-smart-weather,ac-pwm'
      && runtimeAlarmClears16.includes('ac-pwm'),
    '16H: 最终闹钟创建器在创建前后复查门禁，只阻止 PWM/badge/watchdog，不阻止天气预取');

  const pageTimerMessageQueueStart16 = backgroundSource.indexOf(
    'let pageTimerMessageWriteChain = Promise.resolve();'
  );
  const pageTimerMessageQueueEnd16 = backgroundSource.indexOf(
    '\n// ----- 设置页面自带定时器',
    pageTimerMessageQueueStart16
  );
  const pageTimerMessageQueueSource16 = pageTimerMessageQueueStart16 >= 0
      && pageTimerMessageQueueEnd16 > pageTimerMessageQueueStart16
    ? backgroundSource.slice(pageTimerMessageQueueStart16, pageTimerMessageQueueEnd16)
    : '';
  let pageTimerMessageQueuePass16 = false;
  if (pageTimerMessageQueueSource16) {
    let activeRevision16 = 1;
    let automationAllowedForTimer16 = true;
    let releaseAutomaticTimer16 = null;
    const sentTimerMinutes16 = [];
    const pageTimerMessageHarness16 = new Function(
      'isAutomationOperationCurrent', 'sendMessageToExactACHome',
      `${pageTimerMessageQueueSource16}; return { sendSerializedPageTimerMessage };`
    )(
      revision => automationAllowedForTimer16 && revision === activeRevision16,
      async (_tabId, message) => {
        sentTimerMinutes16.push(message.minutes);
        if (message.minutes === 30) {
          return new Promise(resolve => {
            releaseAutomaticTimer16 = () => resolve({ success: true, minutes: 30 });
          });
        }
        return { success: true, minutes: message.minutes };
      }
    );
    const automaticTimer16 = pageTimerMessageHarness16.sendSerializedPageTimerMessage(
      1,
      { action: 'setTimer', minutes: 30 },
      1
    );
    while (!releaseAutomaticTimer16) await Promise.resolve();
    const safetyTimer16 = pageTimerMessageHarness16.sendSerializedPageTimerMessage(
      1,
      { action: 'setTimer', minutes: 1 }
    );
    automationAllowedForTimer16 = false;
    activeRevision16 = 2;
    releaseAutomaticTimer16();
    const [automaticTimerResult16, safetyTimerResult16] = await Promise.all([
      automaticTimer16,
      safetyTimer16
    ]);
    const staleAutomaticTimerResult16 = await pageTimerMessageHarness16
      .sendSerializedPageTimerMessage(
        1,
        { action: 'setTimer', minutes: 20 },
        1
      );
    pageTimerMessageQueuePass16 = automaticTimerResult16?.automationStale === true
      && safetyTimerResult16?.success === true
      && staleAutomaticTimerResult16?.automationStale === true
      && sentTimerMinutes16.join(',') === '30,1';
  }
  assertPass(pageTimerMessageQueuePass16,
    '16I: 页面定时器消息串行，边界安全写最后落地且失效自动 revision 不再发送');
  assertPass(countOccurrences(backgroundSource, "chrome.alarms.create('ac-pwm'") === 0,
    '16J: 所有 ac-pwm 写入统一经过带最终门禁的创建器');
  assertPass(contentSource.includes("if (action === 'off')")
      && contentSource.includes("if (action === 'on')")
      && !contentSource.includes("if (action === 'on' || action === 'off') {")
      && pageConfirmSource.includes("if (!requestId || action !== 'on')")
      && pageConfirmSource.includes('requestACState(true, notAfterAt)')
      && !pageConfirmSource.includes('requestACState(needOn, notAfterAt)'),
    '16J-1: 隔离世界与主世界都硬拒绝 OFF 操作，生产点击器只接受 ON');

  const toggleBody16 = extractSourceSection(
    backgroundSource,
    'async function toggleNowAndSync(action)',
    '\nasync function ensureDiagnosticAlarms',
    'toggleNowAndSync active-hours behavior'
  );
  const automaticOnBody16 = extractSourceSection(
    backgroundSource,
    'async function resolveToggleOnHold(plan, observations) {',
    '\n  // 提取（Fowler Extract Function）：PWM 关机补时 hold 分支',
    'automatic ON gate'
  );
  const sendToggleBody16 = extractSourceSection(
    backgroundSource,
    'async function sendACToggleMessage(tabId, action, options = {}) {',
    '\nasync function _toggleOnNewTab',
    'sendACToggleMessage final gate'
  );
  const manualOnIndex16 = toggleBody16.indexOf("toggleAC('on', {");
  const manualStartGateIndex16 = toggleBody16.indexOf(
    'const automationWasAllowed = isAutomationAllowed();'
  );
  const manualRearmGateIndex16 = toggleBody16.indexOf(
    'if (!automationWasAllowed || !isAutomationAllowed())',
    manualOnIndex16
  );
  assertPass(manualStartGateIndex16 >= 0
      && manualOnIndex16 > manualStartGateIndex16
      && manualRearmGateIndex16 > manualOnIndex16
      && automaticOnBody16.includes('requireAutomationAllowed: true')
      && automaticOnBody16.includes('automationRevision')
      && sendToggleBody16.includes('options?.requireAutomationAllowed')
      && sendToggleBody16.includes('isAutomationOperationCurrent'),
    '16K: 手动 ON 仍可执行，但时段外不续跑；自动 ON 在最终页面消息前再次验 revision');

  let manualRaceAutomationAllowed16 = false;
  const manualRaceCalls16 = [];
  const manualRaceSchedule16 = {
    enabled: true,
    onMinutes: 30,
    offMinutes: 30,
    pwmState: 'on',
    pageTimerTargetAt: 0
  };
  const manualRaceToggle16 = new Function(
    'schedule', 'toggleAC', 'isAutomationAllowed', 'isAutomationOperationCurrent',
    'getCurrentACStatus', 'requestTimerBasedShutdown', 'clearPageTimerProofState',
    'setNextTriggerAt', 'chrome', 'clearPwmAlarm', 'setPageTimer', 'abortStaleAutomation',
    'createPwmAlarmWithVerify', 'createAlarm', 'persistSchedule', 'updateBadge',
    'createPwmAlarmFromPlan',
    `let pwmRuntimeRevision = 31;
    ${toggleBody16}; return toggleNowAndSync;`
  )(
    manualRaceSchedule16,
    async () => {
      manualRaceCalls16.push('toggle-on');
      manualRaceAutomationAllowed16 = true;
      return { success: true };
    },
    () => manualRaceAutomationAllowed16,
    revision => manualRaceAutomationAllowed16 && revision === 31,
    async () => {
      manualRaceCalls16.push('status');
      return { isOn: true };
    },
    async () => { throw new Error('ON 竞态不应请求关机'); },
    () => { manualRaceCalls16.push('clear-proof'); },
    value => {
      manualRaceCalls16.push(`next:${value}`);
      manualRaceSchedule16.nextTriggerAt = value;
    },
    { alarms: { async clear(name) { manualRaceCalls16.push(`clear:${name}`); } } },
    async () => { manualRaceCalls16.push('clear-pwm'); },
    async () => {
      manualRaceCalls16.push('set-page-timer');
      manualRaceSchedule16.pageTimerTargetAt = Date.now() + 30 * 60_000;
      return { success: true };
    },
    async () => false,
    async () => { manualRaceCalls16.push('create-pwm-retry'); return true; },
    async name => { manualRaceCalls16.push(`create:${name}`); return true; },
    async () => { manualRaceCalls16.push('persist'); },
    async () => { manualRaceCalls16.push('badge'); },
    async () => { manualRaceCalls16.push('create-pwm'); return true; }
  );
  const manualRaceResult16 = await manualRaceToggle16('on');
  assertPass(manualRaceResult16.success === true
      && manualRaceCalls16.join(',') === 'toggle-on,status',
    '16K-2: 时段外开始的手动 ON 即使等待期间进入时段，也只执行手动动作而不续跑自动 lifecycle');

  const manualTimerFailureCalls16 = [];
  const manualTimerFailureSchedule16 = {
    enabled: true,
    onMinutes: 23,
    offMinutes: 7,
    pwmState: 'on',
    nextTriggerAt: 0,
    smartClockPlannedAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0,
    pageTimerTargetAt: 0,
    pageTimerError: '',
    smartOnBoundaryAt: ingressBoundary16,
    smartMode: { enabled: true, sensitivity: 5 },
    pwmRetryKind: '',
    pwmRetryBoundaryAt: 0,
    pwmRetryScheduledAt: 0
  };
  const manualTimerFailureToggle16 = new Function(
    'schedule', 'toggleAC', 'isAutomationAllowed', 'isAutomationOperationCurrent',
    'getCurrentACStatus', 'requestTimerBasedShutdown', 'clearPageTimerProofState',
    'clearPwmRetryState', 'prepareFreshPwmStartState',
    'setSmartOnPwmRetryState', 'setNextTriggerAt', 'chrome', 'clearPwmAlarm',
    'setPageTimer', 'abortStaleAutomation', 'createPwmAlarmWithVerify',
    'createAlarm', 'persistSchedule', 'syncScheduleToSync', 'updateBadge',
    'createPwmAlarmFromPlan',
    `let pwmRuntimeRevision = 41;
    ${toggleBody16}; return toggleNowAndSync;`
  )(
    manualTimerFailureSchedule16,
    async () => {
      manualTimerFailureCalls16.push('toggle-on');
      return { success: true };
    },
    () => true,
    revision => revision === 41,
    async () => {
      manualTimerFailureCalls16.push('status');
      return { isOn: true };
    },
    async () => { throw new Error('ON 失败路径不应请求关机'); },
    () => { manualTimerFailureCalls16.push('clear-proof'); },
    () => {
      manualTimerFailureSchedule16.pwmRetryKind = '';
      manualTimerFailureSchedule16.pwmRetryBoundaryAt = 0;
      manualTimerFailureSchedule16.pwmRetryScheduledAt = 0;
      manualTimerFailureCalls16.push('clear-retry');
    },
    () => {
      manualTimerFailureSchedule16.pwmState = 'on';
      manualTimerFailureSchedule16.nextTriggerAt = 0;
      manualTimerFailureSchedule16.alarmCreatedAt = 0;
      manualTimerFailureSchedule16.alarmDelayMinutes = 0;
      manualTimerFailureSchedule16.pwmRetryKind = '';
      manualTimerFailureSchedule16.pwmRetryBoundaryAt = 0;
      manualTimerFailureSchedule16.pwmRetryScheduledAt = 0;
      manualTimerFailureCalls16.push('fresh-start');
    },
    (_action, scheduledAt, marker = {}) => {
      manualTimerFailureSchedule16.pwmRetryKind = marker.kind || 'smart-on';
      manualTimerFailureSchedule16.pwmRetryBoundaryAt = Number(marker.boundaryAt) || 0;
      manualTimerFailureSchedule16.pwmRetryScheduledAt = Number(scheduledAt) || 0;
      manualTimerFailureCalls16.push(`marker:${marker.kind || 'smart-on'}`);
    },
    value => {
      manualTimerFailureSchedule16.nextTriggerAt = value;
      if (!(manualTimerFailureSchedule16.smartClockPlannedAt > 0)) {
        manualTimerFailureSchedule16.smartClockPlannedAt = Date.now();
      }
      manualTimerFailureCalls16.push('next');
    },
    { alarms: { async clear(name) { manualTimerFailureCalls16.push(`clear:${name}`); } } },
    async () => { manualTimerFailureCalls16.push('clear-pwm'); },
    async () => {
      manualTimerFailureCalls16.push('set-page-timer');
      return { success: false, error: 'fresh page timer empty' };
    },
    async () => false,
    async () => { manualTimerFailureCalls16.push('create-pwm-retry'); return true; },
    async name => { manualTimerFailureCalls16.push(`create:${name}`); return true; },
    async reason => { manualTimerFailureCalls16.push(`persist:${reason}`); },
    async reason => { manualTimerFailureCalls16.push(`sync:${reason}`); },
    async () => { manualTimerFailureCalls16.push('badge'); },
    async () => { manualTimerFailureCalls16.push('unexpected-normal-pwm'); return true; }
  );
  const manualTimerFailureResult16 = await manualTimerFailureToggle16('on');
  assertPass(manualTimerFailureResult16.success === false
      && manualTimerFailureCalls16.filter(call => call === 'toggle-on').length === 1
      && manualTimerFailureCalls16.filter(call => call === 'set-page-timer').length === 1
      && manualTimerFailureCalls16.filter(call => call === 'marker:smart-on-safety-timer').length === 2
      && manualTimerFailureCalls16.includes('persist:toggleNowAndSync-pageTimer-retry-intent')
      && manualTimerFailureCalls16.includes('sync:toggleNowAndSync-pageTimer-retry-hold')
      && manualTimerFailureCalls16.includes('sync:toggleNowAndSync-pageTimer-failed')
      && !manualTimerFailureCalls16.includes('unexpected-normal-pwm')
      && manualTimerFailureSchedule16.pwmState === 'on'
      && manualTimerFailureSchedule16.pwmRetryKind === 'smart-on-safety-timer'
      && manualTimerFailureSchedule16.pwmRetryBoundaryAt === ingressBoundary16
      && manualTimerFailureSchedule16.pwmRetryScheduledAt
        === manualTimerFailureSchedule16.nextTriggerAt,
    '16K-2A: actual 手动 ON 的 timer proof 失败只建 safety-timer durable 维修事务，并以明确 OFF sync 公告');

  const automaticOnDeadlineStart16 = backgroundSource.indexOf(
    'function getAutomaticOnDeadline('
  );
  const automaticOnDeadlineEnd16 = backgroundSource.indexOf(
    '\n// 调度下一次 active hours 边界闹钟',
    automaticOnDeadlineStart16
  );
  const automaticOnDeadlineSource16 = automaticOnDeadlineStart16 >= 0
      && automaticOnDeadlineEnd16 > automaticOnDeadlineStart16
    ? backgroundSource.slice(automaticOnDeadlineStart16, automaticOnDeadlineEnd16)
    : '';
  let automaticOnDeadlinePass16 = false;
  if (automaticOnDeadlineSource16) {
    const deadlineSchedule16 = {
      activeHours: { enabled: true, start: '08:00', end: '23:00' }
    };
    const activeBoundaryAt16 = new Date(2026, 7, 18, 23, 0, 0, 0).getTime();
    const nowAt16 = new Date(2026, 7, 18, 22, 59, 0, 0);
    let comfortActive16 = false;
    const getAutomaticOnDeadline16 = new Function(
      'schedule', 'isWithinActiveHours', 'getNextActiveBoundary', 'isComfortStartActive',
      `${automaticOnDeadlineSource16}; return getAutomaticOnDeadline;`
    )(
      deadlineSchedule16,
      () => true,
      () => activeBoundaryAt16,
      () => comfortActive16
    );
    const earlierSmartDeadline16 = activeBoundaryAt16 - 30_000;
    const laterSmartDeadline16 = activeBoundaryAt16 + 30_000;
    const expiredSmartDeadline16 = nowAt16.getTime() - 1;
    const activeOnlyDeadline16 = getAutomaticOnDeadline16(0, nowAt16);
    const earlierDeadline16 = getAutomaticOnDeadline16(earlierSmartDeadline16, nowAt16);
    const cappedDeadline16 = getAutomaticOnDeadline16(laterSmartDeadline16, nowAt16);
    const expiredDeadline16 = getAutomaticOnDeadline16(expiredSmartDeadline16, nowAt16);
    comfortActive16 = true;
    const comfortDeadline16 = getAutomaticOnDeadline16(laterSmartDeadline16, nowAt16);
    comfortActive16 = false;
    deadlineSchedule16.activeHours.enabled = false;
    const smartOnlyDeadline16 = getAutomaticOnDeadline16(laterSmartDeadline16, nowAt16);
    automaticOnDeadlinePass16 = activeOnlyDeadline16 === activeBoundaryAt16
      && earlierDeadline16 === earlierSmartDeadline16
      && cappedDeadline16 === activeBoundaryAt16
      && expiredDeadline16 === expiredSmartDeadline16
      && comfortDeadline16 === laterSmartDeadline16
      && smartOnlyDeadline16 === laterSmartDeadline16;
  }
  assertPass(automaticOnDeadlinePass16
      && automaticOnBody16.includes('getAutomaticOnDeadline('),
    '16K-1: 普通自动 ON 截止于智能窗口/运行时段较早者；舒适启动不被五分钟内的时段边界提前截断');

  const ensureDiagnosticPausedSchedule16 = {
    enabled: true,
    smartMode: { enabled: true },
    activeHours: { enabled: true, start: '08:00', end: '23:00' }
  };
  const ensureDiagnosticClears16 = [];
  const ensureDiagnosticPausedAlarmNames16 = new Set([
    'ac-pwm', 'ac-badge-tick', 'ac-watchdog'
  ]);
  let ensureDiagnosticSmartWeatherExists16 = false;
  let ensureDiagnosticSmartWeatherRepairs16 = 0;
  const ensureDiagnosticPaused16 = new Function(
    'schedule', 'loadScheduleFromStorage', 'isAutomationAllowed', 'chrome',
    'rescheduleSmartWeatherAlarm', 'clearAutomationRuntimeAlarmsWhileBlocked',
    `function isSyncPhaseAdoptionAdmissionBlocked() { return false; }
    function isCurrentPwmStepRunning() { return false; }
    ${ensureDiagnosticAlarmsBody}; return ensureDiagnosticAlarms;`
  )(
    ensureDiagnosticPausedSchedule16,
    async () => {},
    () => false,
    {
      alarms: {
        async clear(name) {
          ensureDiagnosticClears16.push(name);
          ensureDiagnosticPausedAlarmNames16.delete(name);
          return true;
        },
        async get(name) {
          if (name === 'ac-smart-weather') {
            return ensureDiagnosticSmartWeatherExists16
              ? { name, scheduledTime: Date.now() + 60_000 }
              : undefined;
          }
          return ensureDiagnosticPausedAlarmNames16.has(name)
            ? { name, scheduledTime: Date.now() + 60_000 }
            : undefined;
        }
      }
    },
    async () => {
      ensureDiagnosticSmartWeatherRepairs16 += 1;
      ensureDiagnosticSmartWeatherExists16 = true;
    },
    async () => {
      ensureDiagnosticClears16.push('ac-pwm', 'ac-badge-tick', 'ac-watchdog');
      ['ac-pwm', 'ac-badge-tick', 'ac-watchdog']
        .forEach(name => ensureDiagnosticPausedAlarmNames16.delete(name));
      return true;
    }
  );
  const ensureDiagnosticPausedResult16 = await ensureDiagnosticPaused16();
  assertPass(ensureDiagnosticPausedResult16.automationPausedByActiveHours === true
      && ['ac-pwm', 'ac-badge-tick', 'ac-watchdog'].every(name => ensureDiagnosticClears16.includes(name))
      && !ensureDiagnosticClears16.includes('ac-smart-weather')
      && !ensureDiagnosticClears16.includes('ac-page-timer-retry')
      && ensureDiagnosticSmartWeatherRepairs16 === 1
      && ['pwm-alarm-cleared', 'badge-alarm-cleared', 'watchdog-alarm-cleared', 'smart-weather-alarm']
        .every(repair => ensureDiagnosticPausedResult16.repairs.includes(repair))
      && ensureDiagnosticPausedResult16.repaired === true
      && ensureDiagnosticPausedResult16.alarms.smartWeather?.scheduledTime > Date.now(),
    '16L: 后台诊断在时段外逐项记录清理的泄漏闹钟，同时恢复天气预取并保留关机重试');

  const ensureDiagnosticDisabledClears16 = [];
  const ensureDiagnosticDisabledAlarmNames16 = new Set([
    'ac-pwm', 'ac-badge-tick', 'ac-watchdog', 'ac-smart-weather'
  ]);
  const ensureDiagnosticDisabledSchedule16 = {
    enabled: false,
    smartMode: { enabled: false },
    activeHours: { enabled: true, start: '08:00', end: '23:00' }
  };
  const ensureDiagnosticDisabled16 = new Function(
    'schedule', 'loadScheduleFromStorage', 'isAutomationAllowed', 'chrome',
    'clearAutomationRuntimeAlarmsWhileBlocked',
    `function isSyncPhaseAdoptionAdmissionBlocked() { return false; }
    function isCurrentPwmStepRunning() { return false; }
    ${ensureDiagnosticAlarmsBody}; return ensureDiagnosticAlarms;`
  )(
    ensureDiagnosticDisabledSchedule16,
    async () => {},
    () => false,
    {
      alarms: {
        async clear(name) {
          ensureDiagnosticDisabledClears16.push(name);
          ensureDiagnosticDisabledAlarmNames16.delete(name);
          return true;
        },
        async get(name) {
          return ensureDiagnosticDisabledAlarmNames16.has(name)
            ? { name, scheduledTime: Date.now() + 60_000 }
            : undefined;
        }
      }
    },
    async () => {
      ensureDiagnosticDisabledClears16.push('ac-pwm', 'ac-badge-tick', 'ac-watchdog');
      ['ac-pwm', 'ac-badge-tick', 'ac-watchdog']
        .forEach(name => ensureDiagnosticDisabledAlarmNames16.delete(name));
      return true;
    }
  );
  const ensureDiagnosticDisabledResult16 = await ensureDiagnosticDisabled16();
  ensureDiagnosticDisabledSchedule16.enabled = true;
  ensureDiagnosticDisabledSchedule16.smartMode.enabled = true;
  assertPass(ensureDiagnosticDisabledResult16.enabled === false
      && ['ac-pwm', 'ac-badge-tick', 'ac-watchdog', 'ac-smart-weather']
        .every(name => ensureDiagnosticDisabledClears16.includes(name))
      && !ensureDiagnosticDisabledClears16.includes('ac-page-timer-retry')
      && ['pwm-alarm-cleared', 'badge-alarm-cleared', 'watchdog-alarm-cleared', 'smart-weather-alarm-cleared']
        .every(repair => ensureDiagnosticDisabledResult16.repairs.includes(repair))
      && ensureDiagnosticDisabledResult16.repaired === true
      && Object.values(ensureDiagnosticDisabledResult16.before).every(Boolean)
      && Object.values(ensureDiagnosticDisabledResult16.alarms).every(value => value === null)
      && ensureDiagnosticDisabledResult16.schemaVersion === 2
      && ensureDiagnosticDisabledResult16.evidence.before.memorySchedule.enabled === false
      && ensureDiagnosticDisabledResult16.evidence.before.memorySchedule.smartMode.enabled === false
      && ensureDiagnosticDisabledResult16.evidence.after.memorySchedule.enabled === false
      && ensureDiagnosticDisabledResult16.evidence.before.memorySchedule
        !== ensureDiagnosticDisabledResult16.evidence.after.memorySchedule
      && ensureDiagnosticDisabledResult16.evidence.repair.items.includes('pwm-alarm-cleared'),
    '16L-1: 后台诊断在用户停用时逐项记录已清理闹钟并返回前后证据，同时保留页面关机重试');

  const blockedRuntimeCleanupBody16 = extractSourceSection(
    backgroundSource,
    'async function clearAutomationRuntimeAlarmsWhileBlocked(',
    '\nasync function createPwmAlarmWithVerify',
    'blocked runtime alarm cleanup'
  );
  let cleanupAutomationAllowed16 = false;
  const cleanupEvents16 = [];
  const clearBlockedRuntimeAlarms16 = new Function(
    'chrome', 'clearPwmAlarm', 'isAutomationAllowed',
    `let pwmRuntimeRevision = 23;
    ${blockedRuntimeCleanupBody16}; return clearAutomationRuntimeAlarmsWhileBlocked;`
  )(
    {
      alarms: {
        async clear(name) { cleanupEvents16.push(name); return true; }
      }
    },
    async () => {
      cleanupEvents16.push('ac-pwm');
      cleanupAutomationAllowed16 = true;
      return true;
    },
    () => cleanupAutomationAllowed16
  );
  const blockedCleanupResult16 = await clearBlockedRuntimeAlarms16(23);
  const disabledUpdateBranchStart16 = updateScheduleBody.indexOf('if (!schedule.enabled) {');
  const disabledUpdateBranchEnd16 = updateScheduleBody.indexOf(
    '} else if (!comfortRequested && !automationAllowed',
    disabledUpdateBranchStart16
  );
  const disabledUpdateBranch16 = disabledUpdateBranchStart16 >= 0
      && disabledUpdateBranchEnd16 > disabledUpdateBranchStart16
    ? updateScheduleBody.slice(disabledUpdateBranchStart16, disabledUpdateBranchEnd16)
    : '';
  assertPass(blockedCleanupResult16 === false
      && cleanupEvents16.join(',') === 'ac-pwm'
      && setupAlarmsBody16.includes('await clearAutomationRuntimeAlarmsWhileBlocked();')
      && watchdogBody13.includes('await clearAutomationRuntimeAlarmsWhileBlocked();')
      && ensureDiagnosticAlarmsBody.includes('if (isAutomationAllowed()) return ensureDiagnosticAlarms();')
      && disabledUpdateBranch16.includes('if (wasEnabled)')
      && disabledUpdateBranch16.includes('shutdownAfterScheduleDisable()'),
    '16L-2: setup/看门狗在暂停时清泄漏运行闹钟，遇到恢复立即交还恢复链；停用编辑不误关机');
  assertPass(diagnoseHandlerSource.includes('const automationPausedByActiveHours = s._automationPausedByActiveHours === true')
      && diagnoseHandlerSource.includes('&& !automationPausedByActiveHours')
      && diagnoseHandlerSource.includes('if (automationPausedByActiveHours)')
      && diagnoseHandlerSource.includes("t('diagnoseAutomationPaused')")
      && zhCN.diagnoseAutomationPaused?.message
      && en.diagnoseAutomationPaused?.message,
    '16M: popup 诊断把时段外识别为预期暂停，不回填时钟或补建运行闹钟');
  assertPass(diagnoseHandlerSource.includes(
      '|| isAutomationPausedByActiveHours(s);'
    ),
    '16M-0: popup 诊断在旧或降级后台缺少瞬态字段时，也从持久化运行时段重建暂停态');
  assertPass(diagnoseHandlerSource.includes("sendDiagnosticRuntimeMessage({ type: 'ensureDiagnostics' })")
      && !diagnoseHandlerSource.includes("chrome.alarms.create('ac-badge-tick'")
      && !diagnoseHandlerSource.includes("chrome.alarms.create('ac-watchdog'"),
    '16M-1: popup 诊断只委派后台自愈，不绕过最终门禁直接创建运行闹钟');
  const diagnosticSwProbeIndex16 = diagnoseHandlerSource.indexOf(
    "sendDiagnosticRuntimeMessage({ type: 'getSwStatus' })"
  );
  const diagnosticEnsureIndex16 = diagnoseHandlerSource.indexOf(
    "sendDiagnosticRuntimeMessage({ type: 'ensureDiagnostics' })"
  );
  assertPass(diagnosticSwProbeIndex16 >= 0
      && diagnosticSwProbeIndex16 < diagnosticEnsureIndex16
      && diagnoseHandlerSource.includes("type: 'inspectContentRuntime'")
      && diagnoseHandlerSource.includes('runtimeBuildCompatible')
      && diagnoseHandlerSource.includes('readDiagnosticEvidence(ensured)')
      && popupSource.includes('envelope?.evidence?.before')
      && popupSource.includes('envelope?.evidence?.after')
      && !diagnoseHandlerSource.includes('chrome.storage.local.set('),
    '16M-1A: Popup 先只读核对四方构建与首现场，再委派修复；诊断自身不直接写 storage');

  const serializedScheduleUpdateSourceF90 = extractSourceSection(
    backgroundSource,
    'function runSerializedScheduleUpdate(operation) {',
    '\n\nasync function runSmartReapplyLoop()',
    'serialized schedule mutation coordinator'
  );
  const runSerializedScheduleUpdateF90 = new Function(
    `let scheduleUpdateChain = Promise.resolve();
    ${serializedScheduleUpdateSourceF90}; return runSerializedScheduleUpdate;`
  )();
  const tryAdoptSyncedStateSourceF90 = extractSourceSection(
    backgroundSource,
    "async function tryAdoptSyncedState(reason = '', explicitRemote = null) {",
    '\n\n// ----- v0.5.10: 页面定时器作为跨设备主同步通道 -----',
    'sync latest mailbox'
  );
  const loadTryAdoptSyncedStateF90 = ({ chrome, applySyncedPhase }) => new Function(
    'chrome', 'SYNC_KEY', 'applySyncedPhase', 'runSerializedScheduleUpdate',
    'appendDiagnosticLog', 'console',
    `const _syncOpLock = {
      busy: false,
      pending: false,
      pendingReason: '',
      pendingRemote: null,
      pendingOutbound: false,
      pendingOutboundReason: ''
    };
    let syncWriteChain = Promise.resolve();
    let syncWriteOperationsInFlight = 0;
    async function getSyncPublishPending() { return false; }
    async function scheduleSyncRetry() { return true; }
    async function syncScheduleToSync() { return true; }
    function drainDeferredScheduleRepair() { return false; }
    ${tryAdoptSyncedStateSourceF90}; return tryAdoptSyncedState;`
  )(
    {
      ...chrome,
      alarms: {
        async get() { return undefined; },
        ...(chrome.alarms || {})
      }
    },
    'ac_schedule_sync_test',
    applySyncedPhase,
    runSerializedScheduleUpdateF90,
    () => {},
    testConsole
  );

  let releaseActualUpdateF90;
  let markActualUpdateStartedF90;
  const actualUpdateGateF90 = new Promise(resolve => { releaseActualUpdateF90 = resolve; });
  const actualUpdateStartedF90 = new Promise(resolve => { markActualUpdateStartedF90 = resolve; });
  const actualUpdatePersistReasonsF90 = [];
  const actualUpdateResponsesF90 = [];
  const actualUpdateRuntimeAlarmsF90 = [];
  const makeActualUpdateHarnessF90 = new Function(
    'runSerializedScheduleUpdate', 'persistScheduleHook', 'setupAlarms',
    'publishSchedule', 'resetDisabledPwmRuntime', 'requestTimerBasedShutdown',
    'createAlarm', 'rescheduleActiveBoundary',
    'finishDisablePreemptionHook', 'comfortStartHook',
    `let schedule = {
      enabled: false,
      mode: 'pwm',
      clockMode: false,
      onMinutes: 15,
      offMinutes: 45,
      pwmState: 'on',
      activeHours: { enabled: false, start: '08:00', end: '23:00' },
      smartMode: { enabled: false, sensitivity: 5 }
    };
    let smartReapplyInFlight = false;
    let smartReapplyPending = false;
    let automaticDisableAdmissionEpoch = 0;
    let automaticOnAdmissionBlocked = false;
    let syncPublishGeneration = 0;
    let pwmRuntimeRevision = 1;
    let comfortStartRuns = 0;
    async function persistSchedule(reason, options = {}) {
      return persistScheduleHook(reason, options, { ...schedule });
    }
    async function syncScheduleToSync(reason) {
      return publishSchedule(reason, { ...schedule });
    }
    function isAutomationAllowed() {
      return !automaticOnAdmissionBlocked && schedule.enabled;
    }
    function isComfortStartActive() {
      return schedule.enabled && Number(schedule.comfortStartUntil) > Date.now();
    }
    async function scheduleSyncRetry() { return true; }
    async function runComfortStart() {
      if (!isAutomationAllowed()) {
        return { success: false, cancelled: true, error: 'admission blocked' };
      }
      comfortStartRuns += 1;
      if (typeof comfortStartHook === 'function') {
        await comfortStartHook({ ...schedule });
      }
      schedule.comfortStartUntil = Date.now() + 5 * 60_000;
      schedule.pwmState = 'off';
      return { success: true, minimumMinutes: 5 };
    }
    function invalidateTimerBasedShutdown() {}
    ${explicitDisableClaimSource6}
    async function finishExplicitDisablePreemption() {
      if (typeof finishDisablePreemptionHook === 'function') {
        return finishDisablePreemptionHook({ ...schedule });
      }
      return true;
    }
    function releaseExplicitDisableAdmission(admissionEpoch) {
      if (admissionEpoch === automaticDisableAdmissionEpoch) {
        automaticOnAdmissionBlocked = false;
      }
    }
    async function rescheduleSmartWeatherAlarm() {}
    function sanitizeMinutes(value, fallback) {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
    }
    function normalizeSmartSensitivity(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.min(10, parsed)) : 5;
    }
    async function dispatch(msg, sendResponse) {
      ${updateScheduleBody}
    }
    return {
      dispatch,
      state: () => ({ ...schedule }),
      admissionBlocked: () => automaticOnAdmissionBlocked,
      admissionEpoch: () => automaticDisableAdmissionEpoch,
      automationAllowed: () => isAutomationAllowed(),
      comfortStartRuns: () => comfortStartRuns
    };`
  );
  const actualUpdateHarnessF90 = makeActualUpdateHarnessF90(
    runSerializedScheduleUpdateF90,
    async reason => {
      actualUpdatePersistReasonsF90.push(reason);
      if (actualUpdatePersistReasonsF90.length === 1) {
        markActualUpdateStartedF90();
        await actualUpdateGateF90;
      }
    },
    async () => {},
    async () => {},
    async () => {},
    async () => ({ success: true }),
    async name => { actualUpdateRuntimeAlarmsF90.push(name); },
    () => {}
  );
  let latestRemoteF90 = { syncedAt: 2, enabled: false };
  let syncReadsF90 = 0;
  const adoptedStatesF90 = [];
  const tryAdoptSyncedStateF90 = loadTryAdoptSyncedStateF90({
    chrome: {
      storage: {
        sync: {
          async get(key) {
            syncReadsF90 += 1;
            return { [key]: latestRemoteF90 };
          }
        }
      }
    },
    applySyncedPhase: async (remote) => {
      adoptedStatesF90.push(remote.enabled);
      return true;
    }
  });
  const firstActualUpdateF90 = actualUpdateHarnessF90.dispatch({
    type: 'updateSchedule',
    data: {
      enabled: true,
      restart: true,
      onMinutes: 15,
      offMinutes: 45,
      activeHours: { enabled: false, start: '08:00', end: '23:00' },
      smartMode: { enabled: false, sensitivity: 5 }
    }
  }, response => { actualUpdateResponsesF90.push(response); });
  await actualUpdateStartedF90;
  const secondActualUpdateF90 = actualUpdateHarnessF90.dispatch({
    type: 'updateSchedule',
    data: {
      enabled: false,
      restart: true,
      onMinutes: 15,
      offMinutes: 45,
      activeHours: { enabled: false, start: '08:00', end: '23:00' },
      smartMode: { enabled: false, sensitivity: 5 }
    }
  }, response => { actualUpdateResponsesF90.push(response); });
  const syncOwnerF90 = tryAdoptSyncedStateF90(
    'remote-enable',
    { syncedAt: 1, enabled: true }
  );
  const queuedSyncF90 = tryAdoptSyncedStateF90(
    'remote-disable-event',
    { syncedAt: 2, enabled: false }
  );
  await Promise.resolve();
  const queuesBlockedBehindActualUpdateF90 = actualUpdatePersistReasonsF90.length === 2
    && actualUpdatePersistReasonsF90[1]
      === 'updateSchedule-disable-admission-intent'
    && actualUpdateHarnessF90.state().enabled === false
    && actualUpdateHarnessF90.admissionBlocked() === true
    && actualUpdateResponsesF90.length === 0
    && adoptedStatesF90.length === 0;
  releaseActualUpdateF90();
  const [firstActualUpdateOutcomeF90, secondActualUpdateOutcomeF90,
    syncOwnerOutcomeF90, queuedSyncOutcomeF90] = await Promise.allSettled([
    firstActualUpdateF90,
    secondActualUpdateF90,
    syncOwnerF90,
    queuedSyncF90
  ]);
  assertPass(queuesBlockedBehindActualUpdateF90
      && firstActualUpdateOutcomeF90.status === 'rejected'
      && firstActualUpdateOutcomeF90.reason?.message
        === '设置请求已被更晚的明确停用取消'
      && secondActualUpdateOutcomeF90.status === 'fulfilled'
      && syncOwnerOutcomeF90.status === 'fulfilled'
      && syncOwnerOutcomeF90.value === true
      && queuedSyncOutcomeF90.status === 'fulfilled'
      && queuedSyncOutcomeF90.value === false
      && actualUpdateResponsesF90.length === 1
      && actualUpdateHarnessF90.state().enabled === false
      && actualUpdateHarnessF90.admissionBlocked() === false
      && !actualUpdateRuntimeAlarmsF90.includes('ac-watchdog')
      && syncReadsF90 === 0
      && adoptedStatesF90.join(',') === 'false'
      && applySyncedPhaseBody.includes('remoteSyncedAt <= lastSyncedAt'),
    '16M-2: 明确停用先原子落 intent 并锁准入；旧 enable 失败，后续停用事务与 sync 串行且仅采纳 mailbox disable');

  const explicitDisableAdmissionSourceF90 = extractSourceSection(
    backgroundSource,
    'function preemptAutomaticOnForExplicitDisable() {',
    '\n\n// ===== Active Hours',
    'explicit disable admission claim'
  );
  const isAutomationAllowedSourceF90 = extractSourceSection(
    backgroundSource,
    'function isAutomationAllowed(now = new Date()) {',
    '\n\nfunction isAutomationOperationCurrent',
    'automation admission gate'
  );
  let releaseDisableClearF90;
  const disableClearGateF90 = new Promise(resolve => { releaseDisableClearF90 = resolve; });
  const explicitDisableAdmissionHarnessF90 = new Function(
    'chrome', 'cancelAutomaticOnRequests', 'invalidateTimerBasedShutdown',
    'appendDiagnosticLog', 'console',
    `let automaticDisableAdmissionEpoch = 0;
    let automaticOnAdmissionBlocked = false;
    let syncPublishGeneration = 0;
    let pwmRuntimeRevision = 31;
    let schedule = { enabled: true, comfortStartUntil: 1, comfortStartOnConfirmedAt: 1 };
    function isAutomationAllowedForSchedule(snapshot) { return snapshot.enabled === true; }
    ${explicitDisableAdmissionSourceF90}
    ${isAutomationAllowedSourceF90}
    return {
      preemptAutomaticOnForExplicitDisable,
      finishExplicitDisablePreemption,
      releaseExplicitDisableAdmission,
      isAutomationAllowed,
      blocked: () => automaticOnAdmissionBlocked,
      epoch: () => automaticDisableAdmissionEpoch,
      revision: () => pwmRuntimeRevision
    };`
  )(
    { alarms: { clear: async () => disableClearGateF90 } },
    async () => {},
    () => {},
    () => {},
    testConsole
  );
  const claimedExplicitDisableEpochF90 = explicitDisableAdmissionHarnessF90
    .preemptAutomaticOnForExplicitDisable();
  const pendingExplicitDisableF90 = explicitDisableAdmissionHarnessF90
    .finishExplicitDisablePreemption();
  const blocksBeforeQueuedMutationF90 = explicitDisableAdmissionHarnessF90.blocked() === true
    && explicitDisableAdmissionHarnessF90.epoch() === 1
    && explicitDisableAdmissionHarnessF90.revision() === 32
    && explicitDisableAdmissionHarnessF90.isAutomationAllowed() === false;
  releaseDisableClearF90();
  await pendingExplicitDisableF90;
  const blocksUntilTransactionFinishesF90 = explicitDisableAdmissionHarnessF90.blocked() === true
    && explicitDisableAdmissionHarnessF90.isAutomationAllowed() === false;
  explicitDisableAdmissionHarnessF90.releaseExplicitDisableAdmission(1);
  assertPass(blocksBeforeQueuedMutationF90
      && claimedExplicitDisableEpochF90 === 1
      && blocksUntilTransactionFinishesF90
      && explicitDisableAdmissionHarnessF90.blocked() === false
      && explicitDisableAdmissionHarnessF90.isAutomationAllowed() === true
      && updateScheduleBody.includes('finally {')
      && updateScheduleBody.includes('explicitDisableDurablyPersisted')
      && updateScheduleBody.includes('releaseExplicitDisableAdmission(explicitDisableAdmissionEpoch);'),
    '16M-3: 明确停用从抢占开始即锁住自动 ON 准入，跨过串行等待并在事务 finally 释放');

  const preemptFailureLogsF90 = [];
  const preemptFailureHarnessF90 = new Function(
    'chrome', 'cancelAutomaticOnRequests', 'invalidateTimerBasedShutdown',
    'appendDiagnosticLog', 'console',
    `let automaticDisableAdmissionEpoch = 0;
    let automaticOnAdmissionBlocked = false;
    let syncPublishGeneration = 0;
    let pwmRuntimeRevision = 5;
    let schedule = { enabled: true, comfortStartUntil: 1, comfortStartOnConfirmedAt: 1 };
    function isAutomationAllowedForSchedule(snapshot) { return snapshot.enabled === true; }
    ${explicitDisableAdmissionSourceF90}
    ${isAutomationAllowedSourceF90}
    return {
      preemptAutomaticOnForExplicitDisable,
      finishExplicitDisablePreemption,
      isAutomationAllowed,
      blocked: () => automaticOnAdmissionBlocked,
      epoch: () => automaticDisableAdmissionEpoch
    };`
  )(
    { alarms: { clear: async () => { throw new Error('clear rejected'); } } },
    async () => { throw new Error('cancel rejected'); },
    () => {},
    (level, source) => { preemptFailureLogsF90.push(`${level}:${source}`); },
    testConsole
  );
  const rejectedPreemptEpochF90 = preemptFailureHarnessF90
    .preemptAutomaticOnForExplicitDisable();
  await preemptFailureHarnessF90.finishExplicitDisablePreemption();
  assertPass(rejectedPreemptEpochF90 === 1
      && preemptFailureHarnessF90.blocked() === true
      && preemptFailureHarnessF90.epoch() === 1
      && preemptFailureHarnessF90.isAutomationAllowed() === false
      && preemptFailureLogsF90.length === 2,
    '16M-4: 停用预清理的 clear/cancel 即使同时失败也保持 fail-closed，并继续交给持久化事务');

  let failClosedPersistCallF90 = 0;
  const failClosedHarnessF90 = makeActualUpdateHarnessF90(
    runSerializedScheduleUpdateF90,
    async () => {
      failClosedPersistCallF90 += 1;
      if (failClosedPersistCallF90 === 2) throw new Error('storage rejected');
    },
    async () => {},
    async () => {},
    async () => {},
    async () => ({ success: true }),
    async () => {},
    () => {}
  );
  const explicitEnableMessageF90 = {
    type: 'updateSchedule',
    data: {
      enabled: true,
      restart: true,
      onMinutes: 15,
      offMinutes: 45,
      activeHours: { enabled: false, start: '08:00', end: '23:00' },
      smartMode: { enabled: false, sensitivity: 5 }
    }
  };
  await failClosedHarnessF90.dispatch(explicitEnableMessageF90, () => {});
  let failedDisableErrorF90 = '';
  try {
    await failClosedHarnessF90.dispatch({
      ...explicitEnableMessageF90,
      data: { ...explicitEnableMessageF90.data, enabled: false }
    }, () => {});
  } catch (error) {
    failedDisableErrorF90 = error?.message || String(error);
  }
  const remainsFailClosedAfterPersistFailureF90 = failedDisableErrorF90 === 'storage rejected'
    && failClosedHarnessF90.state().enabled === false
    && failClosedHarnessF90.admissionBlocked() === true
    && failClosedHarnessF90.automationAllowed() === false;
  let recoveredEnableResponseF90 = null;
  await failClosedHarnessF90.dispatch(
    explicitEnableMessageF90,
    response => { recoveredEnableResponseF90 = response; }
  );
  const persistBeforeComfortStartF90 = updateScheduleBody.indexOf(
    "await persistSchedule('updateSchedule');"
  ) < updateScheduleBody.indexOf("comfortStart = await runComfortStart('user-enable');");
  const releaseBeforeComfortStartF90 = updateScheduleBody.indexOf(
    'releaseExplicitDisableAdmission(updateAdmissionEpoch);'
  ) < updateScheduleBody.indexOf("comfortStart = await runComfortStart('user-enable');");
  assertPass(remainsFailClosedAfterPersistFailureF90
      && failClosedHarnessF90.state().enabled === true
      && failClosedHarnessF90.admissionBlocked() === false
      && failClosedHarnessF90.automationAllowed() === true
      && failClosedHarnessF90.comfortStartRuns() === 2
      && recoveredEnableResponseF90?.comfortStart?.success === true
      && persistBeforeComfortStartF90
      && releaseBeforeComfortStartF90,
    '16M-5: 停用落盘失败保持 fail-closed；后续明确 enable 先成功落盘解锁，再真正执行五分钟舒适启动');

  // 旧 enable 已排在 schedule queue 后、本机随后明确 disable：disable intent
  // 先原子落地并 bump epoch；旧 enable 取得队列时必须在 mutation/publish 前拒绝。
  const runSerializedStaleEnableF90 = new Function(
    `let scheduleUpdateChain = Promise.resolve();
    ${serializedScheduleUpdateSourceF90}; return runSerializedScheduleUpdate;`
  )();
  let releaseStaleEnableQueueF90;
  let markStaleEnableQueueStartedF90;
  const staleEnableQueueGateF90 = new Promise(resolve => {
    releaseStaleEnableQueueF90 = resolve;
  });
  const staleEnableQueueStartedF90 = new Promise(resolve => {
    markStaleEnableQueueStartedF90 = resolve;
  });
  const staleEnableQueueOwnerF90 = runSerializedStaleEnableF90(async () => {
    markStaleEnableQueueStartedF90();
    await staleEnableQueueGateF90;
  });
  await staleEnableQueueStartedF90;
  const staleEnablePersistF90 = [];
  const staleEnablePublishesF90 = [];
  const staleEnableResponsesF90 = [];
  let staleEnablePublishMarkerF90 = false;
  const staleEnableHarnessF90 = makeActualUpdateHarnessF90(
    runSerializedStaleEnableF90,
    async (reason, options, snapshot) => {
      staleEnablePersistF90.push({ reason, options, snapshot });
      if (options?.markSyncPublishPending === true) {
        staleEnablePublishMarkerF90 = true;
      }
    },
    async () => {},
    async (reason, snapshot) => {
      staleEnablePublishesF90.push({ reason, snapshot, hadMarker: staleEnablePublishMarkerF90 });
      staleEnablePublishMarkerF90 = false;
    },
    async () => {},
    async () => ({ success: true }),
    async () => {},
    () => {}
  );
  const queuedStaleEnableF90 = staleEnableHarnessF90.dispatch(
    explicitEnableMessageF90,
    response => { staleEnableResponsesF90.push(response); }
  );
  const winningQueuedDisableF90 = staleEnableHarnessF90.dispatch({
    ...explicitEnableMessageF90,
    data: { ...explicitEnableMessageF90.data, enabled: false }
  }, response => { staleEnableResponsesF90.push(response); });
  while (!staleEnablePersistF90.some(item =>
    item.reason === 'updateSchedule-disable-admission-intent')) {
    await Promise.resolve();
  }
  const staleEnableDisableIntentBeforeReleaseF90 = staleEnablePublishMarkerF90 === true
    && staleEnableHarnessF90.state().enabled === false
    && staleEnablePublishesF90.length === 0;
  releaseStaleEnableQueueF90();
  const [staleQueueOwnerOutcomeF90, staleEnableOutcomeF90,
    winningDisableOutcomeF90] = await Promise.allSettled([
    staleEnableQueueOwnerF90,
    queuedStaleEnableF90,
    winningQueuedDisableF90
  ]);
  assertPass(staleEnableDisableIntentBeforeReleaseF90
      && staleQueueOwnerOutcomeF90.status === 'fulfilled'
      && staleEnableOutcomeF90.status === 'rejected'
      && staleEnableOutcomeF90.reason?.message
        === '设置请求已被更晚的明确停用取消'
      && winningDisableOutcomeF90.status === 'fulfilled'
      && staleEnablePersistF90.some(item =>
        item.reason === 'updateSchedule-disable-admission-intent'
          && item.options?.markSyncPublishPending === true
          && item.snapshot.enabled === false)
      && !staleEnablePersistF90.some(item => item.snapshot.enabled === true)
      && staleEnablePublishesF90.length === 1
      && staleEnablePublishesF90[0].hadMarker === true
      && staleEnablePublishesF90[0].snapshot.enabled === false
      && staleEnablePublishMarkerF90 === false
      && staleEnableResponsesF90.length === 1
      && staleEnableResponsesF90[0]?.schedule?.enabled === false,
    '16M-6: 队列中的旧 enable 被后到 disable epoch 在 mutation/publish 前拒绝；原子 marker 最终只发布 false');

  // last action：disable 已同步预留 queue 并在取消阶段挂起时，后到 enable
  // 必须排在完整 disable 之后；最终 enable 获胜，旧取消不能追到 comfort/ON 后面。
  const runSerializedLastActionF90 = new Function(
    `let scheduleUpdateChain = Promise.resolve();
    ${serializedScheduleUpdateSourceF90}; return runSerializedScheduleUpdate;`
  )();
  let releaseDisableCancellationF90;
  let markDisableCancellationStartedF90;
  const disableCancellationGateF90 = new Promise(resolve => {
    releaseDisableCancellationF90 = resolve;
  });
  const disableCancellationStartedF90 = new Promise(resolve => {
    markDisableCancellationStartedF90 = resolve;
  });
  const lastActionEventsF90 = [];
  const lastActionResponsesF90 = [];
  let lastActionPublishMarkerF90 = false;
  const lastActionHarnessF90 = makeActualUpdateHarnessF90(
    runSerializedLastActionF90,
    async (reason, options, snapshot) => {
      lastActionEventsF90.push(`persist:${reason}:${snapshot.enabled}`);
      if (options?.markSyncPublishPending === true) {
        lastActionPublishMarkerF90 = true;
      }
    },
    async () => {},
    async (_reason, snapshot) => {
      lastActionEventsF90.push(`publish:${snapshot.enabled}`);
      lastActionPublishMarkerF90 = false;
    },
    async () => {},
    async () => ({ success: true }),
    async () => {},
    () => {},
    async () => {
      lastActionEventsF90.push('disable-cancel:start');
      markDisableCancellationStartedF90();
      await disableCancellationGateF90;
      lastActionEventsF90.push('disable-cancel:end');
    },
    async () => { lastActionEventsF90.push('comfort:start'); }
  );
  const disablingLastActionF90 = lastActionHarnessF90.dispatch({
    ...explicitEnableMessageF90,
    data: { ...explicitEnableMessageF90.data, enabled: false }
  }, response => { lastActionResponsesF90.push(response); });
  await disableCancellationStartedF90;
  const enablingLastActionF90 = lastActionHarnessF90.dispatch(
    explicitEnableMessageF90,
    response => { lastActionResponsesF90.push(response); }
  );
  await Promise.resolve();
  const enableStayedQueuedBehindDisableF90 = lastActionEventsF90.includes(
    'disable-cancel:start'
  )
    && !lastActionEventsF90.includes('disable-cancel:end')
    && !lastActionEventsF90.includes('comfort:start')
    && !lastActionEventsF90.includes('publish:true');
  releaseDisableCancellationF90();
  const [disableLastActionOutcomeF90, enableLastActionOutcomeF90]
    = await Promise.allSettled([
      disablingLastActionF90,
      enablingLastActionF90
    ]);
  const disableCancelEndIndexF90 = lastActionEventsF90.indexOf('disable-cancel:end');
  const comfortStartIndexF90 = lastActionEventsF90.indexOf('comfort:start');
  assertPass(enableStayedQueuedBehindDisableF90
      && disableLastActionOutcomeF90.status === 'fulfilled'
      && enableLastActionOutcomeF90.status === 'fulfilled'
      && disableCancelEndIndexF90 >= 0
      && comfortStartIndexF90 > disableCancelEndIndexF90
      && lastActionEventsF90.filter(event => event === 'disable-cancel:start').length === 1
      && lastActionEventsF90.filter(event => event === 'disable-cancel:end').length === 1
      && lastActionEventsF90.filter(event => event.startsWith('publish:')).join(',')
        === 'publish:false,publish:true'
      && lastActionHarnessF90.state().enabled === true
      && lastActionHarnessF90.comfortStartRuns() === 1
      && lastActionPublishMarkerF90 === false
      && lastActionResponsesF90.length === 2
      && lastActionResponsesF90.at(-1)?.schedule?.enabled === true,
    '16M-7: disable 同步预留队列覆盖完整取消；期间后到 enable 继续排队并最后获胜，取消不追到 comfort/ON 之后');

  let releaseFailingSyncApplyF90;
  let markFailingSyncApplyStartedF90;
  const failingSyncApplyGateF90 = new Promise(resolve => { releaseFailingSyncApplyF90 = resolve; });
  const failingSyncApplyStartedF90 = new Promise(resolve => { markFailingSyncApplyStartedF90 = resolve; });
  const syncApplyOrderF90 = [];
  const tryAdoptFailingSyncedStateF90 = loadTryAdoptSyncedStateF90({
    chrome: { storage: { sync: { async get() { return {}; } } } },
    applySyncedPhase: async remote => {
      if (remote.enabled) {
        syncApplyOrderF90.push('enable:start');
        markFailingSyncApplyStartedF90();
        await failingSyncApplyGateF90;
        syncApplyOrderF90.push('enable:end');
        throw new Error('stale enable failed');
      }
      syncApplyOrderF90.push('disable:start');
      return true;
    }
  });
  const failingSyncOwnerF90 = tryAdoptFailingSyncedStateF90(
    'remote-enable-in-flight',
    { syncedAt: 3, enabled: true }
  );
  await failingSyncApplyStartedF90;
  const afterFailureSyncF90 = tryAdoptFailingSyncedStateF90(
    'remote-disable-after-failure',
    { syncedAt: 4, enabled: false }
  );
  await Promise.resolve();
  const syncApplyStayedSerialF90 = syncApplyOrderF90.join(',') === 'enable:start';
  releaseFailingSyncApplyF90();
  const [failingSyncResultF90, afterFailureSyncResultF90] = await Promise.all([
    failingSyncOwnerF90,
    afterFailureSyncF90
  ]);
  assertPass(syncApplyStayedSerialF90
      && failingSyncResultF90 === true
      && afterFailureSyncResultF90 === false
      && syncApplyOrderF90.join(',') === 'enable:start,enable:end,disable:start',
    '16M-2A: sync busy 期间绝不并发 apply；首轮异常后仍串行消费最新 pending 快照');

  let retrySyncReadsF90 = 0;
  const retrySyncAppliedF90 = [];
  const tryAdoptWithReadRetryF90 = loadTryAdoptSyncedStateF90({
    chrome: {
      storage: {
        sync: {
          async get(key) {
            retrySyncReadsF90 += 1;
            if (retrySyncReadsF90 === 1) throw new Error('transient sync read');
            return { [key]: { syncedAt: 5, enabled: false } };
          }
        }
      }
    },
    applySyncedPhase: async remote => {
      retrySyncAppliedF90.push(remote.enabled);
      return true;
    }
  });
  const retrySyncResultF90 = await tryAdoptWithReadRetryF90('init-read-retry');
  assertPass(retrySyncResultF90 === true
      && retrySyncReadsF90 === 2
      && retrySyncAppliedF90.join(',') === 'false',
    '16M-2B: sync 读取瞬时失败会有界重试一次，不静默丢失最后快照');

  let releaseNewerFailingSyncF90;
  let markNewerFailingSyncStartedF90;
  const newerFailingSyncGateF90 = new Promise(resolve => { releaseNewerFailingSyncF90 = resolve; });
  const newerFailingSyncStartedF90 = new Promise(resolve => { markNewerFailingSyncStartedF90 = resolve; });
  const outOfOrderSyncAppliesF90 = [];
  const tryAdoptOutOfOrderSyncF90 = loadTryAdoptSyncedStateF90({
    chrome: { storage: { sync: { async get() { return {}; } } } },
    applySyncedPhase: async remote => {
      outOfOrderSyncAppliesF90.push(remote.syncedAt);
      if (remote.syncedAt === 7) {
        markNewerFailingSyncStartedF90();
        await newerFailingSyncGateF90;
        throw new Error('newer snapshot failed');
      }
      return true;
    }
  });
  const newerFailingSyncF90 = tryAdoptOutOfOrderSyncF90(
    'newer-in-flight',
    { syncedAt: 7, enabled: true }
  );
  await newerFailingSyncStartedF90;
  const olderPendingSyncF90 = tryAdoptOutOfOrderSyncF90(
    'older-arrived-late',
    { syncedAt: 6, enabled: false }
  );
  releaseNewerFailingSyncF90();
  const [newerFailureOutcomeF90, olderPendingOutcomeF90] = await Promise.allSettled([
    newerFailingSyncF90,
    olderPendingSyncF90
  ]);
  assertPass(newerFailureOutcomeF90.status === 'fulfilled'
      && newerFailureOutcomeF90.value === true
      && olderPendingOutcomeF90.status === 'fulfilled'
      && olderPendingOutcomeF90.value === false
      && outOfOrderSyncAppliesF90.join(',') === '7,6',
    '16M-2C: 较慢时钟的显式 disable 安全淘汰失败中的 enable，异常后仍串行执行停用');

  const releasePwmOwnershipSourceF90 = extractSourceSection(
    backgroundSource,
    'function releasePwmStepOwnership(automationRevision) {',
    '\n\nconst AUTOMATION_RUNTIME_ALARMS',
    'PWM ownership release smart trailing hook'
  );
  const smartReapplyLoopSourceF90 = extractSourceSection(
    backgroundSource,
    'async function runSmartReapplyLoop() {',
    '\n\nasync function fetchSmartWeatherResource',
    'smart reapply trailing loop'
  );
  const loadSmartReapplyHarnessF90 = (
    reapplySmartSensitivityNow,
    initialPwmStepRunning,
    waitUntil
  ) => new Function(
    'reapplySmartSensitivityNow', 'initialPwmStepRunning', 'waitUntil',
    'appendDiagnosticLog', 'console', 'Date',
    `let smartReapplyInFlight = false;
    let smartReapplyPending = false;
    let pwmStepRunning = initialPwmStepRunning;
    let pwmStepRunningRevision = initialPwmStepRunning ? 7 : null;
    let pwmRuntimeRevision = 7;
    let lastPwmStepAt = 0;
    ${releasePwmOwnershipSourceF90}
    ${smartReapplyLoopSourceF90}
    async function dispatch(msg, sendResponse) {
      ${updateScheduleBody}
    }
    return {
      run: runSmartReapplyLoop,
      dispatch,
      release: () => releasePwmStepOwnership(7),
      state: () => ({ smartReapplyInFlight, smartReapplyPending, pwmStepRunning })
    };`
  )(
    reapplySmartSensitivityNow,
    initialPwmStepRunning,
    waitUntil,
    () => {},
    testConsole,
    Date
  );
  let releaseTrailingReapplyF90;
  let markTrailingReapplyStartedF90;
  const trailingReapplyGateF90 = new Promise(resolve => { releaseTrailingReapplyF90 = resolve; });
  const trailingReapplyStartedF90 = new Promise(resolve => { markTrailingReapplyStartedF90 = resolve; });
  let trailingReapplyCallsF90 = 0;
  let trailingWaitPromiseF90 = null;
  const trailingHarnessF90 = loadSmartReapplyHarnessF90(
    async () => {
      trailingReapplyCallsF90 += 1;
      if (trailingReapplyCallsF90 === 1) {
        markTrailingReapplyStartedF90();
        await trailingReapplyGateF90;
      }
    },
    false,
    promise => {
      trailingWaitPromiseF90 = Promise.resolve(promise);
      return trailingWaitPromiseF90;
    }
  );
  const firstTrailingResponsesF90 = [];
  const secondTrailingResponsesF90 = [];
  await trailingHarnessF90.dispatch(
    { type: 'reapplySmartNow' },
    response => { firstTrailingResponsesF90.push(response); }
  );
  await trailingReapplyStartedF90;
  await trailingHarnessF90.dispatch(
    { type: 'reapplySmartNow' },
    response => { secondTrailingResponsesF90.push(response); }
  );
  releaseTrailingReapplyF90();
  await trailingWaitPromiseF90;

  let pwmDeferredRunF90 = null;
  let pwmDeferredCallsF90 = 0;
  const pwmDeferredHarnessF90 = loadSmartReapplyHarnessF90(
    async () => {
      pwmDeferredCallsF90 += 1;
      return pwmDeferredCallsF90 === 1 ? { deferred: true } : undefined;
    },
    true,
    promise => {
      pwmDeferredRunF90 = Promise.resolve(promise);
      return pwmDeferredRunF90;
    }
  );
  await pwmDeferredHarnessF90.run();
  const deferredStateF90 = pwmDeferredHarnessF90.state();
  const releasedPwmF90 = pwmDeferredHarnessF90.release();
  await pwmDeferredRunF90;
  assertPass(trailingReapplyCallsF90 === 2
      && firstTrailingResponsesF90[0]?.accepted === true
      && firstTrailingResponsesF90[0]?.queued === false
      && secondTrailingResponsesF90[0]?.accepted === true
      && secondTrailingResponsesF90[0]?.queued === true
      && trailingHarnessF90.state().smartReapplyInFlight === false
      && trailingHarnessF90.state().smartReapplyPending === false
      && deferredStateF90.smartReapplyPending === true
      && releasedPwmF90 === true
      && pwmDeferredCallsF90 === 2
      && pwmDeferredHarnessF90.state().smartReapplyPending === false,
    '16M-3: 真实 reapplySmartNow 分支在 single-flight 与 PWM 占用期间均保留尾随重算');

  const requestTimerBasedShutdownSource16 = extractSourceSection(
    backgroundSource,
    'function canReusePageTimerProof(state, requestedMinutes, now) {',
    '\n// ----- 闹钟触发时执行 -----',
    'requestTimerBasedShutdown deadline'
  );
  const shutdownNow16 = 1_700_000_000_000;
  const runShutdownProofCase16 = async (
    targetAt,
    { invalidateDuringStatus = false } = {}
  ) => {
    const shutdownSchedule16 = {
      pageTimerMinutes: 30,
      pageTimerTargetAt: targetAt,
      pageTimerRetryAt: 0,
      pageTimerRetryMinutes: 0
    };
    const timerCalls16 = [];
    const freshnessNowCalls16 = [];
    let currentShutdownRevision16 = 0;
    const requestTimerBasedShutdown16 = new Function(
      'schedule', 'isPageTimerProofFresh', 'getCurrentACStatus',
      'clearPageTimerProofState', 'chrome', 'persistSchedule', 'setPageTimer',
      'claimTimerBasedShutdown', 'isTimerBasedShutdownCurrent',
      'sanitizeMinutes', 'Date', 'console',
      `${requestTimerBasedShutdownSource16}; return requestTimerBasedShutdown;`
    )(
      shutdownSchedule16,
      (state, options) => {
        freshnessNowCalls16.push(options?.now);
        return syncHelpers.isPageTimerProofFresh(state, options);
      },
      async () => {
        if (invalidateDuringStatus) currentShutdownRevision16 += 1;
        return { isOn: true };
      },
      () => {
        shutdownSchedule16.pageTimerMinutes = null;
        shutdownSchedule16.pageTimerTargetAt = 0;
        shutdownSchedule16.pageTimerRetryAt = 0;
        shutdownSchedule16.pageTimerRetryMinutes = 0;
      },
      { alarms: { async clear() { return true; } } },
      async () => {},
      async minutes => {
        timerCalls16.push(minutes);
        return { success: true, targetAt: shutdownNow16 + minutes * 60_000 };
      },
      () => { currentShutdownRevision16 += 1; return currentShutdownRevision16; },
      revision => revision === currentShutdownRevision16,
      (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
      },
      { now: () => shutdownNow16 },
      testConsole
    );
    const result16 = await requestTimerBasedShutdown16('active-hours-test', 1);
    return { result16, timerCalls16, freshnessNowCalls16 };
  };
  const lateProofShutdown16 = await runShutdownProofCase16(shutdownNow16 + 20 * 60_000);
  const nearProofShutdown16 = await runShutdownProofCase16(shutdownNow16 + 60_000);
  const expiredProofShutdown16 = await runShutdownProofCase16(shutdownNow16 - 60_000);
  const staleShutdown16 = await runShutdownProofCase16(
    shutdownNow16 + 20 * 60_000,
    { invalidateDuringStatus: true }
  );
  assertPass(lateProofShutdown16.timerCalls16.join(',') === '1'
      && lateProofShutdown16.result16.alreadyArmed !== true
      && nearProofShutdown16.timerCalls16.length === 0
      && nearProofShutdown16.result16.alreadyArmed === true
      && expiredProofShutdown16.timerCalls16.join(',') === '1'
      && expiredProofShutdown16.result16.alreadyArmed !== true
      && nearProofShutdown16.freshnessNowCalls16.length === 1
      && nearProofShutdown16.freshnessNowCalls16[0] === shutdownNow16,
    '16N: 退出时段只复用足够早的页面关机证明，不把 20 分钟后的旧定时器当作 1 分钟安全停机');
  assertPass(staleShutdown16.result16.shutdownStale === true
      && staleShutdown16.timerCalls16.length === 0,
    '16N-1: 恢复 lifecycle 使关机 revision 失效后，不再发送页面定时器写入');

  const pausedDiagnosticTime16 = Date.now() + 5 * 60_000;
  const pausedDiagnosticSchedule16 = {
    enabled: true,
    mode: 'pwm',
    clockMode: false,
    nextTriggerAt: 0,
    _automationPausedByActiveHours: true
  };
  const pausedDiagnosticMock16 = createMockChrome(
    pausedDiagnosticSchedule16,
    pausedDiagnosticTime16,
    { _automationPausedByActiveHours: true }
  );
  const pausedDiagnosticResult16 = await runDiagnosticSelfHeal(pausedDiagnosticMock16.chrome);
  assertPass(pausedDiagnosticResult16.selfHealed === false
      && pausedDiagnosticResult16.storage_after.nextTriggerAt === 0,
    '16O: popup 暂停态不会从泄漏的 live ac-pwm 回填 storage 时钟');

  const popupUpdateScheduleSourceF90 = extractSourceSection(
    popupJs,
    'async function updateSchedule(enabled, restart = false) {',
    '\n\nfunction setModeSwitchBusy(busy, message = \'\') {',
    'popup serialized updateSchedule'
  );
  let releaseFirstPopupUpdateF90;
  let markFirstPopupUpdateStartedF90;
  const firstPopupUpdateGateF90 = new Promise(resolve => { releaseFirstPopupUpdateF90 = resolve; });
  const firstPopupUpdateStartedF90 = new Promise(resolve => { markFirstPopupUpdateStartedF90 = resolve; });
  const popupUpdateMessagesF90 = [];
  const popupRenderedSchedulesF90 = [];
  const popupStatusesF90 = [];
  const popupUpdateHarnessF90 = new Function(
    'validateManualMinutes', 'currentManualMinutes',
    'currentActiveHours', 'currentSmartMode', 'IS_STATIC_PREVIEW',
    'staticPreviewSchedule', 'updateCountdownDisplay', 'showStatus', 't',
    'chrome', 'attachCachedActualStatus',
    `let scheduleUpdateChain = Promise.resolve();
    let scheduleUpdateRevision = 0;
    let pendingScheduleUpdates = 0;
    let currentScheduleEnabled = false;
    ${popupUpdateScheduleSourceF90}
    return {
      updateSchedule,
      state: () => ({ pendingScheduleUpdates, currentScheduleEnabled })
    };`
  )(
    () => ({ onMinutes: 15, offMinutes: 45 }),
    { onMinutes: 15, offMinutes: 45 },
    { enabled: true, start: '08:00', end: '23:00' },
    { enabled: false, sensitivity: 5 },
    false,
    {},
    schedule => { popupRenderedSchedulesF90.push(schedule); },
    (message, type) => { popupStatusesF90.push({ message, type }); },
    key => key,
    {
      runtime: {
        async sendMessage(message) {
          popupUpdateMessagesF90.push(message);
          if (popupUpdateMessagesF90.length === 1) {
            markFirstPopupUpdateStartedF90();
            return firstPopupUpdateGateF90;
          }
          return { success: true, schedule: { enabled: message.data.enabled, id: 'latest' } };
        }
      },
      alarms: { async get() { return { name: 'ac-pwm', scheduledTime: 123 }; } }
    },
    schedule => schedule
  );
  const firstPopupUpdateF90 = popupUpdateHarnessF90.updateSchedule(false, true);
  await firstPopupUpdateStartedF90;
  const secondPopupUpdateF90 = popupUpdateHarnessF90.updateSchedule(true, true);
  await Promise.resolve();
  const popupSendsBeforeReleaseF90 = popupUpdateMessagesF90.length;
  releaseFirstPopupUpdateF90({ success: true, schedule: { enabled: false, id: 'stale' } });
  const [firstPopupResultF90, secondPopupResultF90] = await Promise.all([
    firstPopupUpdateF90,
    secondPopupUpdateF90
  ]);
  assertPass(popupSendsBeforeReleaseF90 === 1
      && popupUpdateMessagesF90.map(message => message.data.enabled).join(',') === 'false,true'
      && firstPopupResultF90.superseded === true
      && secondPopupResultF90.success === true
      && secondPopupResultF90.superseded === false
      && popupRenderedSchedulesF90.length === 1
      && popupRenderedSchedulesF90[0]?.id === 'latest'
      && popupStatusesF90.length === 1
      && popupUpdateHarnessF90.state().pendingScheduleUpdates === 0
      && popupUpdateHarnessF90.state().currentScheduleEnabled === true,
    '16O-1: popup updateSchedule 严格串行，旧响应不回写 UI，最终状态属于最后一次命令');

  const waitForLatestUpdateSourceF90 = extractSourceSection(
    popupJs,
    'async function waitForLatestScheduleUpdateResult() {',
    '\n\nfunction setModeSwitchBusy',
    'popup latest update result waiter'
  );
  let releaseObservedUpdateF90;
  const observedUpdateGateF90 = new Promise(resolve => { releaseObservedUpdateF90 = resolve; });
  const latestUpdateFailureF90 = { success: false, superseded: false, error: 'latest failed' };
  const waitForLatestUpdateHarnessF90 = new Function(
    'initialOperation',
    `let scheduleUpdateRevision = 1;
    let scheduleUpdateChain = initialOperation;
    ${waitForLatestUpdateSourceF90}
    return {
      wait: waitForLatestScheduleUpdateResult,
      replaceWithFailure() {
        scheduleUpdateRevision += 1;
        scheduleUpdateChain = Promise.resolve({
          success: false,
          superseded: false,
          error: 'latest failed'
        });
      }
    };`
  )(observedUpdateGateF90);
  const latestUpdateResultPromiseF90 = waitForLatestUpdateHarnessF90.wait();
  waitForLatestUpdateHarnessF90.replaceWithFailure();
  releaseObservedUpdateF90({ success: true, superseded: true });
  const latestUpdateResultF90 = await latestUpdateResultPromiseF90;
  assertPass(JSON.stringify(latestUpdateResultF90) === JSON.stringify(latestUpdateFailureF90)
      && popupJs.includes('updateResult = await waitForLatestScheduleUpdateResult();')
      && popupJs.includes('if (!updateResult?.success || updateResult.superseded) return;'),
    '16O-1A: superseded 灵敏度提交等待稳定 revision；最终写失败时不发送 reapplySmartNow');

  let releasePopupPollF90;
  let markPopupPollStartedF90;
  const popupPollGateF90 = new Promise(resolve => { releasePopupPollF90 = resolve; });
  const popupPollStartedF90 = new Promise(resolve => { markPopupPollStartedF90 = resolve; });
  let popupPollRenderCallsF90 = 0;
  let popupPollStorageReadsF90 = 0;
  const popupPollHarnessF90 = new Function(
    'IS_STATIC_PREVIEW', 'staticPreviewSchedule', 'updateCountdownDisplay',
    'updateSmartReadout', 'chrome', 'attachCachedActualStatus',
    'isAutomationPausedByActiveHours',
    `let pollCount = 0;
    let scheduleUpdateRevision = 0;
    let pendingScheduleUpdates = 0;
    function hasPendingScheduleUpdate() { return pendingScheduleUpdates > 0; }
    ${refreshStatusBody12}
    return {
      refreshStatus,
      beginUpdate() { scheduleUpdateRevision += 1; pendingScheduleUpdates += 1; }
    };`
  )(
    false,
    {},
    () => { popupPollRenderCallsF90 += 1; },
    () => {},
    {
      runtime: {
        async sendMessage() {
          markPopupPollStartedF90();
          return popupPollGateF90;
        }
      },
      alarms: { async get() { return null; } },
      storage: {
        local: {
          async get() {
            popupPollStorageReadsF90 += 1;
            return {};
          }
        }
      }
    },
    schedule => schedule,
    () => false
  );
  const popupPollF90 = popupPollHarnessF90.refreshStatus();
  await popupPollStartedF90;
  popupPollHarnessF90.beginUpdate();
  releasePopupPollF90({ enabled: false });
  await popupPollF90;
  assertPass(popupPollRenderCallsF90 === 0 && popupPollStorageReadsF90 === 0,
    '16O-2: 已在途的轮询若遇到本地提交 revision 变化，必须丢弃旧快照且不走 storage 回退');

  const balanceEstimateSourceF90 = extractSourceSection(
    popupJs,
    'function renderBalanceEstimate(schedule) {',
    '\n\n// 提取（Fowler Extract Function）：余额预计 DOM 应用',
    'paused balance estimate rendering'
  );
  let hiddenBalanceEstimatesF90 = 0;
  let shownBalanceEstimatesF90 = 0;
  const renderBalanceEstimateF90 = new Function(
    'estimateBalanceExhaustion', 'hideBalanceEstimate',
    'isAutomationPausedByActiveHours', 'I18n', 'formatBalanceExhaustionAt',
    'isBalanceEstimateUrgent', 'showBalanceEstimate',
    `${balanceEstimateSourceF90}; return renderBalanceEstimate;`
  )(
    () => ({ displayAt: 123, usableWallMinutes: 60 }),
    () => { hiddenBalanceEstimatesF90 += 1; },
    schedule => schedule.activeHours?.enabled === true,
    { getLang: () => 'en' },
    () => ({ shortAt: 'Today 12:00', fullAt: 'Today 12:00' }),
    () => false,
    () => { shownBalanceEstimatesF90 += 1; }
  );
  renderBalanceEstimateF90({
    enabled: true,
    balanceMinutes: 60,
    onMinutes: 15,
    offMinutes: 45,
    _automationPausedByActiveHours: true
  });
  renderBalanceEstimateF90({
    enabled: true,
    balanceMinutes: 60,
    onMinutes: 15,
    offMinutes: 45,
    activeHours: { enabled: true, start: '08:00', end: '23:00' }
  });
  assertPass(hiddenBalanceEstimatesF90 === 2 && shownBalanceEstimatesF90 === 0,
    '16O-3: 运行时段暂停（后台瞬态字段或本地回退推导）时隐藏 Est. until');

  const modeSwitchBusySourceF90 = extractSourceSection(
    popupJs,
    "function setModeSwitchBusy(busy, message = '') {",
    '\n\n// ----- 自动模式分段选择',
    'mode switch busy feedback'
  );
  const makeBusyControlF90 = () => {
    const attributes = new Map();
    return {
      disabled: false,
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      hasAttribute(name) { return attributes.has(name); }
    };
  };
  const timerBusyControlF90 = makeBusyControlF90();
  const smartBusyControlF90 = makeBusyControlF90();
  const automationBusyControlF90 = makeBusyControlF90();
  const statusBusyControlF90 = makeBusyControlF90();
  const modeBusyMessagesF90 = [];
  const modeBusyHarnessF90 = new Function(
    'automationToggle', 'timerToggle', 'smartModeToggle', 'statusDiv', 'showStatus',
    `let modeSwitchInFlight = false;
    ${modeSwitchBusySourceF90}
    return {
      setModeSwitchBusy,
      state: () => modeSwitchInFlight
    };`
  )(
    automationBusyControlF90,
    timerBusyControlF90,
    smartBusyControlF90,
    statusBusyControlF90,
    (message, type) => { modeBusyMessagesF90.push({ message, type }); }
  );
  modeBusyHarnessF90.setModeSwitchBusy(true, 'Enabling');
  const busyAppliedF90 = modeBusyHarnessF90.state() === true
    && automationBusyControlF90.disabled && timerBusyControlF90.disabled && smartBusyControlF90.disabled
    && automationBusyControlF90.hasAttribute('aria-busy')
    && timerBusyControlF90.hasAttribute('aria-busy')
    && smartBusyControlF90.hasAttribute('aria-busy')
    && statusBusyControlF90.hasAttribute('aria-busy');
  modeBusyHarnessF90.setModeSwitchBusy(false);
  assertPass(busyAppliedF90
      && modeBusyHarnessF90.state() === false
      && !automationBusyControlF90.disabled && !timerBusyControlF90.disabled && !smartBusyControlF90.disabled
      && !automationBusyControlF90.hasAttribute('aria-busy')
      && !timerBusyControlF90.hasAttribute('aria-busy')
      && !smartBusyControlF90.hasAttribute('aria-busy')
      && !statusBusyControlF90.hasAttribute('aria-busy')
      && modeBusyMessagesF90[0]?.message === 'Enabling',
    '16O-4: 自动控制或模式提交期间总开关与两个模式同时锁定并暴露 busy，完成后一起恢复');

  const smartReapplyRequestSourceF90 = extractSourceSection(
    popupJs,
    'async function requestSmartReapplyNow() {',
    "\n\nsmartSensitivity.addEventListener('change'",
    'popup smart reapply response handling'
  );
  const runSmartReapplyRequestF90 = async responseOrError => {
    const statuses = [];
    const request = new Function(
      'chrome', 'showStatus', 't',
      `${smartReapplyRequestSourceF90}; return requestSmartReapplyNow;`
    )(
      {
        runtime: {
          async sendMessage(message) {
            if (responseOrError instanceof Error) throw responseOrError;
            return { ...responseOrError, messageType: message.type };
          }
        }
      },
      (message, type) => { statuses.push({ message, type }); },
      key => key
    );
    return { result: await request(), statuses };
  };
  const rejectedReapplyF90 = await runSmartReapplyRequestF90({ success: true, accepted: false });
  const failedReapplyF90 = await runSmartReapplyRequestF90(new Error('worker unavailable'));
  const acceptedReapplyF90 = await runSmartReapplyRequestF90({ success: true, accepted: true });
  assertPass(rejectedReapplyF90.statuses.length === 1
      && failedReapplyF90.statuses.length === 1
      && failedReapplyF90.result.success === false
      && acceptedReapplyF90.statuses.length === 0
      && acceptedReapplyF90.result.accepted === true
      && acceptedReapplyF90.result.messageType === 'reapplySmartNow',
    '16O-5: popup 等待并检查 reapplySmartNow 响应，拒绝或异常时显示错误而非静默丢弃');

  let pausedFallbackRendered16 = null;
  const refreshPausedFallback16 = new Function(
    'IS_STATIC_PREVIEW', 'staticPreviewSchedule', 'updateCountdownDisplay',
    'updateSmartReadout', 'chrome', 'attachCachedActualStatus',
    'isAutomationPausedByActiveHours',
    `let pollCount = 0;
    let scheduleUpdateRevision = 0;
    function hasPendingScheduleUpdate() { return false; }
    ${refreshStatusBody12}; return refreshStatus;`
  )(
    false,
    {},
    schedule => { pausedFallbackRendered16 = { ...schedule }; },
    () => {},
    {
      runtime: {
        async sendMessage() { throw new Error('service worker unavailable'); }
      },
      alarms: {
        async get() { return { name: 'ac-pwm', scheduledTime: Date.now() + 60_000 }; }
      },
      storage: {
        local: {
          async get() {
            return {
              ac_schedule: {
                enabled: true,
                smartMode: { enabled: true },
                activeHours: { enabled: true, start: '08:00', end: '23:00' }
              }
            };
          }
        }
      }
    },
    schedule => schedule,
    () => true
  );
  await refreshPausedFallback16();
  assertPass(pausedFallbackRendered16?._automationPausedByActiveHours === true
      && pausedFallbackRendered16?._insideActiveHours === false
      && pausedFallbackRendered16?.enabled === true
      && pausedFallbackRendered16?.smartMode?.enabled === true,
    '16O-6: 后台消息失败时 popup 从 storage 回退也重建暂停态，并保留智能模式启用意图');

  const automationGateSites16 = [
    ['init', initBody13],
    ['setupAlarms', setupAlarmsBody16],
    ['watchdogCheck', watchdogBody13],
    ['applySyncedPhase', applySyncedPhaseBody],
    ['tryAdoptPageTimer', adoptTimerBody],
    ['reapplySmartSensitivityNow', reapplyBody],
    ['repairScheduleClock', repairBody],
    ['ensureDiagnosticAlarms', ensureDiagnosticAlarmsBody]
  ];
  assertPass(automationGateSites16.every(([, source]) => source.includes('isAutomationAllowed()')),
    '16P: 启动、同步、看门狗、页面采纳、灵敏度重设、时钟修复与诊断统一遵守运行时段门禁');
  assertPass(resetDisabledPwmRuntimeSource.includes('pwmRuntimeRevision += 1;')
      && setTimerBody.includes('automationRevision = null')
      && setTimerBody.includes('writePageTimerOnExactHomeTab(tab.id, minutes')
      && backgroundSource.includes('sendSerializedPageTimerMessage(tabId, {')
      && setTimerBody.includes('isAutomationOperationCurrent(automationRevision)')
      && verifyBody.includes('automationRevision = null')
      && verifyBody.includes('isAutomationOperationCurrent(automationRevision)')
      && [pwmBody, reapplyBody, advanceBody, repairBody]
        .every(source => source.includes('automationRevision')),
    '16Q: 退出先失效旧 runtime，所有自动页面定时器路径在最终消息与证明提交前复核 revision');

  const loadScheduleFromStorageSource16 = extractSourceSection(
    backgroundSource,
    'async function loadScheduleFromStorage() {',
    '\nasync function persistSchedule(',
    'loadScheduleFromStorage stale-read guard'
  );
  let releaseStaleScheduleRead16;
  let staleStorageReadCount16 = 0;
  const staleScheduleRead16 = new Promise(resolve => {
    releaseStaleScheduleRead16 = resolve;
  });
  const staleLoadHarness16 = new Function(
    'chrome', 'STORAGE_KEY', 'staleScheduleRead',
    `let pwmRuntimeRevision = 7;
    let scheduleLoadBlockedRevision = null;
    function isSyncPhaseAdoptionAdmissionBlocked() { return false; }
    let schedule = {
      enabled: true,
      pwmState: 'off',
      nextTriggerAt: 123456,
      alarmCreatedAt: 123000,
      alarmDelayMinutes: 1
    };
    ${loadScheduleFromStorageSource16}
    return {
      loadScheduleFromStorage,
      resetRuntime() {
        pwmRuntimeRevision += 1;
        scheduleLoadBlockedRevision = pwmRuntimeRevision;
        schedule = {
          ...schedule,
          pwmState: 'off',
          nextTriggerAt: 0,
          alarmCreatedAt: 0,
          alarmDelayMinutes: 0
        };
      },
      getSchedule: () => ({ ...schedule })
    };`
  )(
    {
      storage: {
        local: {
          async get() {
            staleStorageReadCount16 += 1;
            await staleScheduleRead16;
            return {
              ac_schedule: {
                enabled: true,
                pwmState: 'on',
                nextTriggerAt: 999999,
                alarmCreatedAt: 999000,
                alarmDelayMinutes: 30
              }
            };
          }
        }
      }
    },
    'ac_schedule',
    staleScheduleRead16
  );
  const staleLoadPromise16 = staleLoadHarness16.loadScheduleFromStorage();
  staleLoadHarness16.resetRuntime();
  releaseStaleScheduleRead16();
  await staleLoadPromise16;
  await staleLoadHarness16.loadScheduleFromStorage();
  const scheduleAfterStaleLoad16 = staleLoadHarness16.getSchedule();
  assertPass(scheduleAfterStaleLoad16.pwmState === 'off'
      && scheduleAfterStaleLoad16.nextTriggerAt === 0
      && scheduleAfterStaleLoad16.alarmCreatedAt === 0
      && scheduleAfterStaleLoad16.alarmDelayMinutes === 0
      && staleStorageReadCount16 === 1,
    '16R: 退出重置前后的 storage 读取都不能在首轮 persist 前覆盖已清空时钟');

  let releasePhaseStorageRead16;
  let markPhaseStorageReadStarted16;
  let phaseStorageReadCount16 = 0;
  const phaseStorageReadGate16 = new Promise(resolve => {
    releasePhaseStorageRead16 = resolve;
  });
  const phaseStorageReadStarted16 = new Promise(resolve => {
    markPhaseStorageReadStarted16 = resolve;
  });
  const phaseLoadHarness16 = new Function(
    'chrome', 'STORAGE_KEY',
    `let pwmRuntimeRevision = 31;
    let scheduleLoadBlockedRevision = null;
    let phaseAdoptionBlocked = false;
    let schedule = {
      enabled: true,
      pwmState: 'on',
      nextTriggerAt: 111111,
      alarmCreatedAt: 111000,
      alarmDelayMinutes: 1
    };
    function isSyncPhaseAdoptionAdmissionBlocked() {
      return phaseAdoptionBlocked;
    }
    ${loadScheduleFromStorageSource16}
    return {
      loadScheduleFromStorage,
      claimPhase(nextTriggerAt) {
        phaseAdoptionBlocked = true;
        pwmRuntimeRevision += 1;
        schedule = {
          ...schedule,
          pwmState: 'off',
          nextTriggerAt,
          alarmCreatedAt: nextTriggerAt - 60000,
          alarmDelayMinutes: 1
        };
      },
      releasePhase() { phaseAdoptionBlocked = false; },
      getSchedule: () => ({ ...schedule })
    };`
  )(
    {
      storage: {
        local: {
          async get() {
            phaseStorageReadCount16 += 1;
            markPhaseStorageReadStarted16();
            await phaseStorageReadGate16;
            return {
              ac_schedule: {
                enabled: true,
                pwmState: 'on',
                nextTriggerAt: 999999,
                alarmCreatedAt: 999000,
                alarmDelayMinutes: 30
              }
            };
          }
        }
      }
    },
    'ac_schedule'
  );
  const phaseLoadStartedPromise16 = phaseLoadHarness16.loadScheduleFromStorage();
  await phaseStorageReadStarted16;
  const reservedPhaseClock16 = Date.now() + 7 * 60_000;
  phaseLoadHarness16.claimPhase(reservedPhaseClock16);
  await phaseLoadHarness16.loadScheduleFromStorage();
  releasePhaseStorageRead16();
  await phaseLoadStartedPromise16;
  const phaseLoadAfter16 = phaseLoadHarness16.getSchedule();
  phaseLoadHarness16.releasePhase();
  assertPass(loadScheduleFromStorageSource16.includes(
      'if (isSyncPhaseAdoptionAdmissionBlocked()) return schedule;')
      && loadScheduleFromStorageSource16.includes(
        'if (isSyncPhaseAdoptionAdmissionBlocked()')
      && phaseStorageReadCount16 === 1
      && phaseLoadAfter16.pwmState === 'off'
      && phaseLoadAfter16.nextTriggerAt === reservedPhaseClock16
      && phaseLoadAfter16.nextTriggerAt !== 999999,
    '16R-1: storage reload 在 phase reservation 前后都 fail closed；已发出的旧读取与门内新读取均不能覆盖新内存 phase');

  const diagnosticPhaseClock16 = Date.now() + 8 * 60_000;
  const diagnosticSupersededClock16 = Date.now() + 25 * 60_000;
  const diagnosticPhaseCalls16 = [];
  const ensureDiagnosticDuringPhase16 = new Function(
    'schedule', 'chrome', 'calls',
    `async function loadScheduleFromStorage() { calls.push('load'); }
    function isSyncPhaseAdoptionAdmissionBlocked() { return true; }
    function isCurrentPwmStepRunning() { return false; }
    ${ensureDiagnosticAlarmsBody};
    return ensureDiagnosticAlarms;`
  )(
    {
      enabled: true,
      pwmState: 'off',
      nextTriggerAt: diagnosticPhaseClock16,
      alarmCreatedAt: diagnosticPhaseClock16 - 60_000,
      alarmDelayMinutes: 1,
      smartMode: { enabled: true, sensitivity: 5 }
    },
    {
      alarms: {
        async get(name) {
          diagnosticPhaseCalls16.push(`get:${name}`);
          return name === 'ac-pwm'
            ? { name, scheduledTime: diagnosticSupersededClock16 }
            : undefined;
        },
        async clear(name) {
          diagnosticPhaseCalls16.push(`clear:${name}`);
          return true;
        },
        async create(name) {
          diagnosticPhaseCalls16.push(`create:${name}`);
        }
      }
    },
    diagnosticPhaseCalls16
  );
  const diagnosticDuringPhase16 = await ensureDiagnosticDuringPhase16();
  assertPass(diagnosticDuringPhase16.deferred === true
      && diagnosticDuringPhase16.success === false
      && diagnosticDuringPhase16.repaired === false
      && diagnosticDuringPhase16.repairs.length === 0
      && diagnosticDuringPhase16.schedule._phaseAdoptionInFlight === true
      && diagnosticDuringPhase16.schedule.nextTriggerAt
        === diagnosticPhaseClock16
      && diagnosticDuringPhase16.alarms.pwm?.scheduledTime
        === diagnosticSupersededClock16
      && !diagnosticPhaseCalls16.some(call =>
        call.startsWith('clear:') || call.startsWith('create:'))
      && ensureDiagnosticAlarmsBody.includes(
        'return snapshotDeferredPhaseAdoption();')
      && ensureDiagnosticAlarmsBody.includes(
        '|| isSyncPhaseAdoptionAdmissionBlocked()')
      && ensureDiagnosticAlarmsBody.includes('? null'),
    '16R-2: ensureDiagnostics 在 phase reservation 内只返回 deferred 证据；不清建闹钟，后续 trigger reconciliation 也跳过');

  assertPass(!diagnoseHandlerSource.includes('chrome.storage.local.set(')
      && ensureDiagnosticAlarmsBody.includes('phaseAdoptionInFlight:')
      && ensureDiagnosticAlarmsBody.includes('diagnosticSnapshotFingerprint(startState)')
      && ensureDiagnosticAlarmsBody.includes('captureDiagnosticSnapshotAttempt(2, firstObservedAt)')
      && popupSource.includes('function selectDiagnosticRuntimeValue(')
      && popupSource.includes('function readDiagnosticEvidence(')
      && diagnoseHandlerSource.includes('diagnosticEvidenceUsable')
      && diagnoseHandlerSource.includes("code: 'SCHED-EVIDENCE-INCOMPLETE'")
      && !diagnoseHandlerSource.includes('ensured?.alarms?.')
      && popupSource.includes("'currentAttempt'")
      && popupSource.includes('currentAttempts:'),
    '16R-3: Popup 不再写回旧快照；后台首现场标出 phase/in-flight 与跨 await 一致性');

  let reconciledApplyCalls16 = 0;
  let reconciledPersistCalls16 = 0;
  const pausedReconcileSchedule16 = { enabled: true, nextTriggerAt: 0 };
  const pausedPersistReconciled16 = new Function(
    'schedule', 'reconcilePwmTrigger', 'applyPwmPlanState', 'persistSchedule',
    'isAutomationAllowed', 'isAutomationOperationCurrent',
    `let pwmRuntimeRevision = 11;
    ${persistReconciledPwmTriggerSource}; return persistReconciledPwmTrigger;`
  )(
    pausedReconcileSchedule16,
    () => ({
      kind: 'sync-live',
      liveScheduledTime: 888888,
      phasePatch: { nextTriggerAt: 888888 }
    }),
    plan => {
      reconciledApplyCalls16 += 1;
      Object.assign(pausedReconcileSchedule16, plan.phasePatch);
    },
    async () => { reconciledPersistCalls16 += 1; },
    () => false,
    () => false
  );
  const pausedReconcileResult16 = await pausedPersistReconciled16(
    { name: 'ac-pwm', scheduledTime: 888888 },
    'active-hours-stale-live',
    { nextTriggerToleranceMs: 1500, requireLegacyAlignment: false }
  );
  assertPass(pausedReconcileResult16 === null
      && reconciledApplyCalls16 === 0
      && reconciledPersistCalls16 === 0
      && pausedReconcileSchedule16.nextTriggerAt === 0,
    '16S: 时段外拒绝旧 live alarm 的相位应用与持久化，不能反向恢复 reset 后时钟');

  let releasePersistAlarmRead16;
  let persistAlarmReadStarted16 = false;
  const deferredPersistAlarmRead16 = new Promise(resolve => {
    releasePersistAlarmRead16 = resolve;
  });
  const persistedSnapshots16 = [];
  const persistRaceSchedule16 = {
    enabled: true,
    pwmState: 'off',
    nextTriggerAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0,
    smartMode: { enabled: false }
  };
  const persistRaceHarness16 = new Function(
    'schedule', 'chrome', 'reconcilePwmTrigger', 'deferredAlarmRead',
    `let pwmRuntimeRevision = 19;
    let scheduleLoadBlockedRevision = null;
    let automationAllowed = true;
    const STORAGE_KEY = 'ac_schedule';
    const PWM_TRIGGER_NEXT_ONLY_OPTIONS = Object.freeze({
      nextTriggerToleranceMs: 1500,
      requireLegacyAlignment: false
    });
    function isAutomationAllowed() { return automationAllowed; }
    function isAutomationOperationCurrent(revision) {
      return automationAllowed && revision === pwmRuntimeRevision;
    }
    function applyPwmPlanState(plan) {
      if (plan?.phasePatch) Object.assign(schedule, plan.phasePatch);
    }
    ${persistScheduleBody}
    return {
      persistSchedule,
      pauseAutomation() {
        automationAllowed = false;
        pwmRuntimeRevision += 1;
        schedule.pwmState = 'off';
        schedule.nextTriggerAt = 0;
        schedule.alarmCreatedAt = 0;
        schedule.alarmDelayMinutes = 0;
      }
    };`
  )(
    persistRaceSchedule16,
    {
      alarms: {
        async get() {
          persistAlarmReadStarted16 = true;
          await deferredPersistAlarmRead16;
          return { name: 'ac-pwm', scheduledTime: Date.now() + 10 * 60_000 };
        }
      },
      storage: {
        local: {
          async set(value) { persistedSnapshots16.push({ ...value.ac_schedule }); }
        }
      }
    },
    pwmPhase.reconcilePwmTrigger,
    deferredPersistAlarmRead16
  );
  const stalePersistPromise16 = persistRaceHarness16.persistSchedule('stale-live-race');
  while (!persistAlarmReadStarted16) await Promise.resolve();
  persistRaceHarness16.pauseAutomation();
  releasePersistAlarmRead16();
  await stalePersistPromise16;
  assertPass(persistRaceSchedule16.nextTriggerAt === 0
      && persistRaceSchedule16.alarmCreatedAt === 0
      && persistRaceSchedule16.alarmDelayMinutes === 0
      && persistedSnapshots16.length === 1
      && persistedSnapshots16[0].nextTriggerAt === 0,
    '16S-1: persistSchedule 等待 live alarm 跨过退出边界后复核 revision，不恢复已清空 PWM 时钟');

  const adoptPhaseStart16 = applySyncedPhaseBody.indexOf(
    'async function adoptPhaseAndRearm(remote, automationAllowed) {'
  );
  const adoptPhaseEnd16 = applySyncedPhaseBody.indexOf(
    '\n\n  const localPwmAlarm =',
    adoptPhaseStart16
  );
  const adoptPhaseSource16 = adoptPhaseStart16 >= 0 && adoptPhaseEnd16 > adoptPhaseStart16
    ? applySyncedPhaseBody.slice(adoptPhaseStart16, adoptPhaseEnd16)
    : '';
  const adoptPausedGateIndex16 = adoptPhaseSource16.indexOf(
    'if (!automationAllowed || !isAutomationOperationCurrent(automationRevision)) return false;'
  );
  const adoptMutationIndex16 = adoptPhaseSource16.indexOf('schedule.pwmState = adopt.pwmState;');
  assertPass(adoptPausedGateIndex16 >= 0
      && adoptMutationIndex16 > adoptPausedGateIndex16,
    '16T: sync 相位采纳在修改全局运行态前复核当前门禁，暂停态不接纳远端时钟');

  const pwmAlarmCreationBody16 = extractSourceSection(
    backgroundSource,
    'let pwmAlarmWriteChain = Promise.resolve();',
    '\nasync function loadScheduleFromStorage()',
    'revision-owned PWM alarm creation'
  );
  assertPass(pwmAlarmCreationBody16.includes('automationRevision = null')
      && pwmAlarmCreationBody16.includes('isAutomationOperationCurrent(automationRevision)')
      && pwmAlarmCreationBody16.includes('pwmAlarmWriteChain')
      && countOccurrences(backgroundSource, "chrome.alarms.clear('ac-pwm')") >= 2
      && countOccurrences(backgroundSource, 'clearPwmAlarm(') >= 11
      && [reapplyBody, advanceBody, applySyncedPhaseBody, adoptTimerBody, pwmBody, repairBody]
        .every(source => source.includes('automationRevision')),
    '16U: PWM alarm 创建串行并绑定调用方 revision，快速暂停后恢复时旧流程不能重建旧时钟');

  let pwmAlarmRevision16 = 1;
  let releaseOldPwmAlarmCreate16 = null;
  let pwmAlarmCreateCalls16 = 0;
  let pwmAlarmClearCalls16 = 0;
  let livePwmAlarm16 = null;
  const revisionOwnedSchedule16 = {
    enabled: true,
    nextTriggerAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0
  };
  const revisionOwnedChrome16 = {
    alarms: {
      async get(name) {
        return name === 'ac-pwm' && livePwmAlarm16
          ? { name, ...livePwmAlarm16 }
          : undefined;
      },
      async clear(name) {
        if (name === 'ac-pwm') {
          pwmAlarmClearCalls16 += 1;
          livePwmAlarm16 = null;
        }
        return true;
      }
    }
  };
  const revisionOwnedCreateAlarm16 = async (_name, info) => {
    pwmAlarmCreateCalls16 += 1;
    if (pwmAlarmCreateCalls16 === 1) {
      await new Promise(resolve => { releaseOldPwmAlarmCreate16 = resolve; });
    }
    livePwmAlarm16 = {
      scheduledTime: Number(info?.when) || Date.now() + Number(info?.delayInMinutes) * 60000
    };
    return true;
  };
  const revisionOwnedPwmAlarm16 = new Function(
    'schedule', 'createAlarm', 'chrome', 'isAutomationAllowed',
    'isAutomationOperationCurrent', 'setNextTriggerAt',
    `${pwmAlarmCreationBody16}; return { createPwmAlarmFromPlan };`
  )(
    revisionOwnedSchedule16,
    revisionOwnedCreateAlarm16,
    revisionOwnedChrome16,
    () => true,
    revision => revision === pwmAlarmRevision16,
    value => { revisionOwnedSchedule16.nextTriggerAt = value; }
  );
  const oldPwmTarget16 = Date.now() + 10 * 60_000;
  const newPwmTarget16 = Date.now() + 20 * 60_000;
  const oldPwmCreate16 = revisionOwnedPwmAlarm16.createPwmAlarmFromPlan(
    { nextTriggerAt: oldPwmTarget16 },
    'old-revision',
    1
  );
  while (!releaseOldPwmAlarmCreate16) await Promise.resolve();
  pwmAlarmRevision16 = 2;
  const newPwmCreate16 = revisionOwnedPwmAlarm16.createPwmAlarmFromPlan(
    { nextTriggerAt: newPwmTarget16 },
    'new-revision',
    2
  );
  releaseOldPwmAlarmCreate16();
  const [oldPwmCreated16, newPwmCreated16] = await Promise.all([
    oldPwmCreate16,
    newPwmCreate16
  ]);
  assertPass(oldPwmCreated16 === false
      && newPwmCreated16 === true
      && pwmAlarmCreateCalls16 === 2
      && pwmAlarmClearCalls16 === 1
      && livePwmAlarm16?.scheduledTime === newPwmTarget16
      && revisionOwnedSchedule16.nextTriggerAt === newPwmTarget16,
    '16U-1: 旧 PWM 创建失效并清理后，新 revision 才串行建 alarm，最终时钟只属于新 lifecycle');

  let rejectedVerifyCreateCalls16 = 0;
  let rejectedVerifyClearCalls16 = 0;
  const rejectedVerifySchedule16 = {
    enabled: true,
    nextTriggerAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0
  };
  const rejectedVerifyPwmAlarm16 = new Function(
    'schedule', 'createAlarm', 'chrome', 'isAutomationAllowed',
    'isAutomationOperationCurrent', 'setNextTriggerAt',
    `${pwmAlarmCreationBody16}; return {
      createPwmAlarmWithVerify,
      createPwmAlarmFromPlan
    };`
  )(
    rejectedVerifySchedule16,
    async () => { rejectedVerifyCreateCalls16 += 1; return true; },
    {
      alarms: {
        async get() { throw new Error('verify rejected'); },
        async clear() { rejectedVerifyClearCalls16 += 1; return true; }
      }
    },
    () => true,
    () => true,
    value => { rejectedVerifySchedule16.nextTriggerAt = value; }
  );
  const rejectedPlanVerify16 = await rejectedVerifyPwmAlarm16.createPwmAlarmFromPlan(
    { nextTriggerAt: Date.now() + 120_000 },
    'verify-reject-plan',
    1
  );
  const rejectedDelayVerify16 = await rejectedVerifyPwmAlarm16.createPwmAlarmWithVerify(
    2,
    'verify-reject-delay',
    1
  );
  const createCallsBeforeExpiredPlan16 = rejectedVerifyCreateCalls16;
  const rejectedExpiredPlan16 = await rejectedVerifyPwmAlarm16.createPwmAlarmFromPlan(
    { nextTriggerAt: Date.now() - 1 },
    'expired-plan',
    1
  );
  assertPass(rejectedPlanVerify16 === false
      && rejectedDelayVerify16 === false
      && rejectedExpiredPlan16 === false
      && rejectedVerifyCreateCalls16 === 2
      && rejectedVerifyCreateCalls16 === createCallsBeforeExpiredPlan16
      && rejectedVerifyClearCalls16 === 2
      && rejectedVerifySchedule16.nextTriggerAt === 0,
    '16U-2: 绝对/延迟建钟的 verify reject 与排队后过期都归一为 false，调用方红灯/watchdog 分支不会被 throw 绕过');

  const pwmStepOwnershipSource16 = extractSourceSection(
    backgroundSource,
    'function isCurrentPwmStepRunning() {',
    '\nconst AUTOMATION_RUNTIME_ALARMS',
    'PWM step revision ownership'
  );
  const pwmStepOwnership16 = new Function(`
    let pwmStepRunning = false;
    let pwmStepRunningRevision = null;
    let pwmRuntimeRevision = 0;
    let lastPwmStepAt = 0;
    let smartReapplyPending = false;
    let smartReapplyInFlight = false;
    function waitUntil() {}
    async function runSmartReapplyLoop() {}
    ${pwmStepOwnershipSource16}
    return {
      isCurrentPwmStepRunning,
      claimPwmStepOwnership,
      releasePwmStepOwnership,
      invalidateRuntime() { pwmRuntimeRevision += 1; },
      getState() {
        return {
          pwmStepRunning,
          pwmStepRunningRevision,
          pwmRuntimeRevision,
          lastPwmStepAt
        };
      }
    };
  `)();
  const oldPwmStepRevision16 = pwmStepOwnership16.claimPwmStepOwnership();
  pwmStepOwnership16.invalidateRuntime();
  const staleStepStillCurrent16 = pwmStepOwnership16.isCurrentPwmStepRunning();
  const newPwmStepRevision16 = pwmStepOwnership16.claimPwmStepOwnership();
  const oldPwmStepReleased16 = pwmStepOwnership16.releasePwmStepOwnership(
    oldPwmStepRevision16
  );
  const stateAfterOldRelease16 = pwmStepOwnership16.getState();
  const newPwmStepReleased16 = pwmStepOwnership16.releasePwmStepOwnership(
    newPwmStepRevision16
  );
  const stateAfterNewRelease16 = pwmStepOwnership16.getState();
  assertPass(staleStepStillCurrent16 === false
      && oldPwmStepReleased16 === false
      && stateAfterOldRelease16.pwmStepRunning === true
      && stateAfterOldRelease16.pwmStepRunningRevision === newPwmStepRevision16
      && stateAfterOldRelease16.pwmRuntimeRevision === newPwmStepRevision16
      && newPwmStepReleased16 === true
      && stateAfterNewRelease16.pwmStepRunning === false
      && stateAfterNewRelease16.pwmStepRunningRevision === null
      && stateAfterNewRelease16.lastPwmStepAt > 0
      && pwmBody.includes('isCurrentPwmStepRunning()')
      && pwmBody.includes('claimPwmStepOwnership()')
      && pwmBody.includes('releasePwmStepOwnership(automationRevision)'),
    '16V: PWM 运行锁由 revision 所有，旧长步骤不阻塞新 lifecycle 且不能清除新步骤锁');

  assertPass(adoptTimerBody.includes('isCurrentPwmStepRunning()'),
    '16W: 页面定时器相位采纳在 PWM step 已持有当前 revision 时直接跳过，避免并发覆盖相位');

  const setupImmediateStart16 = setupAlarmsBody16.indexOf('if (startImmediately) {');
  const setupImmediateEnd16 = setupAlarmsBody16.indexOf('\n  // 恢复入口', setupImmediateStart16);
  const setupImmediateBody16 = setupImmediateStart16 >= 0 && setupImmediateEnd16 > setupImmediateStart16
    ? setupAlarmsBody16.slice(setupImmediateStart16, setupImmediateEnd16)
    : '';
  const restartRevisionIndex16 = setupImmediateBody16.indexOf('pwmRuntimeRevision += 1');
  const restartCooldownIndex16 = setupImmediateBody16.indexOf('lastPwmStepAt = 0');
  const restartClearIndex16 = setupImmediateBody16.indexOf('await clearPwmAlarm(');
  const restartRunIndex16 = setupImmediateBody16.indexOf('await executePwmStepWithRecovery({');
  assertPass(restartRevisionIndex16 >= 0
      && restartCooldownIndex16 > restartRevisionIndex16
      && restartClearIndex16 > restartCooldownIndex16
      && restartRunIndex16 > restartClearIndex16,
    '16X: 显式 restart 先失效旧 PWM owner 并清 cooldown，再替换主闹钟并立即启动新 lifecycle');

  const pageTimerRetryAlarmBody16 = extractSourceSection(
    backgroundSource,
    "if (alarm.name === 'ac-page-timer-retry') {",
    "\n\n  if (alarm.name.startsWith('ac-close-tab-'))",
    'ac-page-timer-retry active-hours resume behavior'
  );
  assertPass(backgroundSource.includes('let timerBasedShutdownRevision = 0;')
      && backgroundSource.includes('function isTimerBasedShutdownCurrent(')
      && requestTimerBasedShutdownSource16.includes('claimTimerBasedShutdown()')
      && requestTimerBasedShutdownSource16.includes('shutdownRevision')
      && setTimerBody.includes('shutdownRevision = null')
      && setTimerBody.includes('isTimerBasedShutdownCurrent(shutdownRevision)')
      && verifyBody.includes('shutdownRevision = null')
      && verifyBody.includes('isTimerBasedShutdownCurrent(shutdownRevision)'),
    '16Y: 暂停/停用关机拥有独立可失效 revision，恢复后旧验证与证明提交不能覆盖新 ON 周期');
  assertPass(pageTimerRetryAlarmBody16.includes('if (isAutomationAllowed())')
      && pageTimerRetryAlarmBody16.includes('clearSupersededTimerBasedShutdownRetry')
      && pageTimerRetryAlarmBody16.includes("requestTimerBasedShutdown('page-timer-retry', 1)")
      && pageTimerRetryAlarmBody16.indexOf('clearSupersededTimerBasedShutdownRetry')
        < pageTimerRetryAlarmBody16.indexOf('requestTimerBasedShutdown('),
    '16Y-1: 恢复自动控制后触发的旧关机 retry 只清理不重授权，时段外才继续安全停机');

  assertPass(backgroundSource.includes('async function cancelAutomaticOnRequests()')
      && resetDisabledPwmRuntimeSource.includes('await cancelAutomaticOnRequests();')
      && setupImmediateBody16.includes('await cancelAutomaticOnRequests();')
      && contentSource.includes("action === 'cancelAutomaticOn'")
      && contentSource.includes("'__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'")
      && pageConfirmSource.includes('MAIN_BRIDGE_EVENTS.cancel')
      && pageConfirmSource.includes('handleAutomaticOnCancel')
      && pageConfirmSource.includes('automaticOnCancellationRevision')
      && pageConfirmSource.includes('请求已被后台取消'),
    '16Z: 停用、离开时段或显式 restart 会取消主世界递归自动 ON，每次后续点击与确认都可被撤销');

  // ===== 用例 17: 自动控制启用后的五分钟舒适启动 =====
  beginSuite('用例 17：五分钟舒适启动',
    '\n\n=== 用例 17: 自动控制启用后的五分钟舒适启动 ===\n');

  const planComfortStart = syncHelpers.planComfortStart;
  assertPass(typeof planComfortStart === 'function',
    '17A: sync helper 导出纯函数 planComfortStart，启动目标可脱离浏览器副作用验证');

  if (typeof planComfortStart === 'function') {
    const comfortNow17 = new Date(2026, 7, 27, 12, 0, 1, 0).getTime();
    const minimumTarget17 = new Date(2026, 7, 27, 12, 6, 0, 0).getTime();
    const laterTarget17 = new Date(2026, 7, 27, 12, 20, 0, 0).getTime();
    const minimumPlan17 = planComfortStart({}, { found: true, value: '12:03' }, {
      now: comfortNow17,
      minutes: 5
    });
    assertPass(minimumPlan17.minimumTargetAt === minimumTarget17
        && minimumPlan17.targetAt === minimumTarget17
        && minimumPlan17.timerMinutes === 6
        && minimumPlan17.reuseFreshProof === false,
      '17B: HH:mm 精度向上取整，12:00:01 启用至少运行到 12:06，较早页面定时器不能截短五分钟');

    const liveLaterPlan17 = planComfortStart({}, { found: true, value: '12:20' }, {
      now: comfortNow17,
      minutes: 5
    });
    assertPass(liveLaterPlan17.minimumTargetAt === minimumTarget17
        && liveLaterPlan17.targetAt === laterTarget17
        && liveLaterPlan17.timerMinutes === 20
        && liveLaterPlan17.reuseFreshProof === false,
      '17C: 页面已有更晚关机时间时保留更晚目标，并要求重新取得本机新鲜证明');

    const freshLaterPlan17 = planComfortStart({
      pageTimerMinutes: 20,
      pageTimerTargetAt: laterTarget17,
      pageTimerRetryAt: 0
    }, { found: true, value: '12:20' }, {
      now: comfortNow17,
      minutes: 5
    });
    assertPass(freshLaterPlan17.targetAt === laterTarget17
        && freshLaterPlan17.reuseFreshProof === true,
      '17D: storage 与页面一致的更晚新鲜证明直接复用，不重复写 Power-off after');

    const contradictedFreshPlan17 = planComfortStart({
      pageTimerMinutes: 20,
      pageTimerTargetAt: laterTarget17,
      pageTimerRetryAt: 0
    }, { found: true, value: '12:10' }, {
      now: comfortNow17,
      minutes: 5
    });
    assertPass(contradictedFreshPlan17.targetAt === laterTarget17
        && contradictedFreshPlan17.reuseFreshProof === false,
      '17D-1: 页面当前读数与 storage 新鲜证明矛盾时保留较晚目标，但必须重新写入并验证');

    const restoredFloorPlan17 = planComfortStart({}, { found: true, value: '12:04' }, {
      now: comfortNow17,
      minutes: 5,
      minimumTargetAt: laterTarget17
    });
    assertPass(restoredFloorPlan17.minimumTargetAt === laterTarget17
        && restoredFloorPlan17.targetAt === laterTarget17,
      '17E: SW 恢复或一分钟重试沿用既有舒适截止点，不因重入反复延长五分钟');
  }

  const comfortSource17 = extractSourceSection(
    backgroundSource,
    '// ===== 五分钟舒适启动',
    '\n// ===== Active Hours',
    'five-minute comfort lifecycle'
  );
  assertPass(backgroundSource.includes('comfortStartUntil: 0')
      && comfortSource17.includes('function isComfortStartActive(')
      && comfortSource17.includes('async function runComfortStart(')
      && comfortSource17.includes("toggleAC('on', {")
      && comfortSource17.includes('requireAutomationAllowed: true')
      && comfortSource17.includes('await getCurrentPageTimer()')
      && comfortSource17.includes('await setPageTimer(')
      && comfortSource17.includes('await createPwmAlarmFromPlan('),
    '17F: 舒适启动复用唯一 ON 事务，预置并新鲜验证页面定时器后以绝对目标建立 PWM 闹钟');
  const deferComfortStartSource17 = extractSourceSection(
    backgroundSource,
    'async function deferComfortStart(error, automationRevision) {',
    '\nasync function runComfortStart(',
    'comfort start retry transaction'
  );
  const loadDeferComfortStart17 = ({ staleDuringCreate = false } = {}) => {
    const now = Date.now();
    const testSchedule = {
      enabled: true,
      pwmState: 'on',
      comfortStartUntil: now + 5 * 60_000,
      nextTriggerAt: 0,
      pageTimerError: ''
    };
    let current = true;
    const order = [];
    const persisted = [];
    const defer = new Function(
      'schedule', 'COMFORT_START_RETRY_MS', 'COMFORT_START_MINUTES', 'isAutomationOperationCurrent',
      'setNextTriggerAt', 'persistSchedule', 'createPwmAlarmFromPlan',
      'scheduleComfortStartEndAlarm', 'scheduleComfortRetryFallback',
      'createAlarm', 'updateBadge', 'appendDiagnosticLog',
      `${deferComfortStartSource17}; return deferComfortStart;`
    )(
      testSchedule,
      60_000,
      5,
      () => current,
      value => { testSchedule.nextTriggerAt = value; },
      async reason => {
        order.push(`persist:${reason}`);
        persisted.push(JSON.parse(JSON.stringify(testSchedule)));
      },
      async () => {
        order.push('create-pwm:false');
        if (staleDuringCreate) {
          current = false;
          Object.assign(testSchedule, {
            enabled: false,
            pwmState: 'off',
            comfortStartUntil: 0,
            nextTriggerAt: 0,
            pageTimerError: 'NEW-COMFORT-LIFECYCLE'
          });
        }
        return false;
      },
      async () => { order.push('end-alarm'); return true; },
      async () => { order.push('fallback-alarm'); return true; },
      async name => { order.push(`alarm:${name}`); return true; },
      async () => { order.push('update-badge'); },
      () => { order.push('diagnostic'); }
    );
    return { defer, schedule: testSchedule, order, persisted };
  };
  const comfortRetryFailure17 = loadDeferComfortStart17();
  const comfortRetryFailureResult17 = await comfortRetryFailure17.defer(
    'synthetic comfort failure',
    31
  );
  assertPass(comfortRetryFailure17.order.join(',')
        === 'persist:comfort-start-retry-intent,create-pwm:false,fallback-alarm,persist:comfort-start-retry,update-badge,diagnostic'
      && comfortRetryFailure17.persisted.length === 2
      && comfortRetryFailure17.persisted[0]?.nextTriggerAt > Date.now()
      && comfortRetryFailure17.schedule.nextTriggerAt
        === comfortRetryFailure17.persisted[0]?.nextTriggerAt
      && comfortRetryFailure17.schedule.pageTimerError.includes('已改用舒适恢复闹钟')
      && comfortRetryFailureResult17.fallbackCreated === true
      && comfortRetryFailureResult17.retryAt === comfortRetryFailure17.schedule.nextTriggerAt,
    '17F-1: 舒适 ON 失败先持久化一分钟 retry intent；PWM 建钟 false 时 fallback alarm 接力且错误保持可见');
  const staleComfortRetry17 = loadDeferComfortStart17({ staleDuringCreate: true });
  const staleComfortRetryResult17 = await staleComfortRetry17.defer(
    'stale comfort failure',
    32
  );
  assertPass(staleComfortRetryResult17.cancelled === true
      && staleComfortRetry17.order.join(',')
        === 'persist:comfort-start-retry-intent,create-pwm:false'
      && staleComfortRetry17.schedule.pageTimerError === 'NEW-COMFORT-LIFECYCLE'
      && staleComfortRetry17.schedule.enabled === false
      && staleComfortRetry17.schedule.nextTriggerAt === 0,
    '17F-2: 舒适 retry 建钟期间 revision 失效后不创建 fallback、不追加旧错误或 persist');

  const deferComfortFinishSource17 = extractSourceSection(
    backgroundSource,
    'async function deferComfortFinish(',
    '\nasync function finishComfortStart(',
    'comfort finish retry transaction'
  );
  const loadDeferComfortFinish17 = ({
    staleDuringCreate = false,
    failAllPersists = false
  } = {}) => {
    const testSchedule = {
      enabled: true,
      pwmState: 'off',
      comfortStartUntil: 0,
      comfortStartOnConfirmedAt: 123,
      nextTriggerAt: 0,
      pageTimerError: ''
    };
    let current = true;
    const order = [];
    const persisted = [];
    const defer = new Function(
      'schedule', 'pwmRuntimeRevision', 'COMFORT_START_RETRY_MS',
      'isAutomationOperationCurrent', 'setNextTriggerAt', 'persistSchedule',
      'createPwmAlarmFromPlan', 'scheduleComfortRetryFallback', 'createAlarm',
      'updateBadge', 'appendDiagnosticLog',
      `${deferComfortFinishSource17}; return deferComfortFinish;`
    )(
      testSchedule,
      41,
      60_000,
      () => current,
      value => { testSchedule.nextTriggerAt = value; },
      async reason => {
        order.push(`persist:${reason}`);
        if (failAllPersists) throw new Error('synthetic storage unavailable');
        persisted.push(JSON.parse(JSON.stringify(testSchedule)));
      },
      async () => {
        order.push('create-pwm:false');
        if (staleDuringCreate) {
          current = false;
          Object.assign(testSchedule, {
            enabled: false,
            comfortStartUntil: 0,
            nextTriggerAt: 0,
            pageTimerError: 'NEW-FINISH-LIFECYCLE'
          });
        }
        return false;
      },
      async () => { order.push('fallback-alarm'); return true; },
      async name => { order.push(`alarm:${name}`); return true; },
      async () => { order.push('update-badge'); },
      () => { order.push('diagnostic'); }
    );
    return { defer, schedule: testSchedule, order, persisted };
  };
  const comfortFinishFailure17 = loadDeferComfortFinish17();
  const comfortFinishFailureResult17 = await comfortFinishFailure17.defer(
    new Error('finish transition failed'),
    41,
    123
  );
  assertPass(comfortFinishFailure17.order.join(',')
        === 'persist:comfort-finish-retry-intent,create-pwm:false,fallback-alarm,alarm:ac-badge-tick,alarm:ac-watchdog,persist:comfort-finish-retry-alarm-failed,update-badge,diagnostic'
      && comfortFinishFailure17.persisted.length === 2
      && comfortFinishFailure17.schedule.comfortStartUntil > Date.now()
      && comfortFinishFailure17.schedule.nextTriggerAt
        === comfortFinishFailure17.persisted[0]?.nextTriggerAt
      && comfortFinishFailure17.schedule.pageTimerError.includes('已改用舒适恢复闹钟')
      && comfortFinishFailureResult17.deferred === true
      && comfortFinishFailureResult17.fallbackCreated === true,
    '17F-3: 舒适结束事务抛错恢复 marker/截止，intent-first 并以一分钟 fallback alarm 重试，不留下 ON 无钟态');
  const staleComfortFinish17 = loadDeferComfortFinish17({ staleDuringCreate: true });
  const staleComfortFinishResult17 = await staleComfortFinish17.defer(
    new Error('stale finish transition'),
    41,
    123
  );
  assertPass(staleComfortFinishResult17.cancelled === true
      && staleComfortFinish17.order.join(',')
        === 'persist:comfort-finish-retry-intent,create-pwm:false'
      && staleComfortFinish17.schedule.pageTimerError === 'NEW-FINISH-LIFECYCLE'
      && staleComfortFinish17.schedule.enabled === false
      && staleComfortFinish17.schedule.nextTriggerAt === 0,
    '17F-4: 舒适结束恢复建钟期间 revision 失效后不触碰新 lifecycle sentinel');
  const storageFailedComfortFinish17 = loadDeferComfortFinish17({
    failAllPersists: true
  });
  const storageFailedComfortFinishResult17 = await storageFailedComfortFinish17.defer(
    new Error('finish and storage failed'),
    41,
    123
  );
  assertPass(storageFailedComfortFinishResult17.deferred === true
      && storageFailedComfortFinishResult17.intentPersisted === false
      && storageFailedComfortFinishResult17.fallbackCreated === true
      && storageFailedComfortFinishResult17.watchdogCreated === true
      && storageFailedComfortFinish17.schedule.comfortStartUntil > Date.now()
      && storageFailedComfortFinish17.order.includes('fallback-alarm')
      && storageFailedComfortFinish17.order.includes('alarm:ac-watchdog'),
    '17F-4A: reset 后 storage 持续失败仍先建 comfort fallback/watchdog，不靠旧 revision 静默丢掉所有恢复钟');
  const finishComfortStartSource17 = extractSourceSection(
    backgroundSource,
    "async function finishComfortStart(reason = '') {",
    '\nasync function deferComfortStart(',
    'comfort finish transition'
  );
  const finishOwnerResult17 = await new Function(
    'testNow',
    `const schedule = {
      enabled: true,
      comfortStartUntil: testNow - 1,
      comfortStartOnConfirmedAt: 456,
      pageTimerError: ''
    };
    let pwmRuntimeRevision = 51;
    const chrome = { alarms: { clear: async () => true } };
    const Date = { now: () => testNow };
    function isAutomationAllowed() { return schedule.enabled; }
    function isWithinActiveHours() { return false; }
    async function scheduleComfortStartEndAlarm() { return true; }
    async function resetDisabledPwmRuntime() { pwmRuntimeRevision += 1; }
    async function persistSchedule(reason) {
      if (reason === 'comfort-start-ended-outside-hours-pre-shutdown') {
        throw new Error('synthetic post-reset failure');
      }
    }
    async function requestTimerBasedShutdown() { return { success: true }; }
    async function rescheduleSmartWeatherAlarm() {}
    function appendDiagnosticLog() {}
    async function deferComfortFinish(error, automationRevision, priorConfirmedAt) {
      return { deferred: true, automationRevision, priorConfirmedAt, error: error.message };
    }
    ${finishComfortStartSource17}
    return finishComfortStart('owner-test');`
  )(Date.now());
  assertPass(finishOwnerResult17.deferred === true
      && finishOwnerResult17.automationRevision === 52
      && finishOwnerResult17.priorConfirmedAt === 456,
    '17F-5: 舒适结束在时段外 reset claim 新 revision 后再失败，恢复沿用新 owner 而非 stale 静默丢钟');
  const retryComfortDeadlineSource17 = extractSourceSection(
    backgroundSource,
    "async function retryComfortStartAndFinishIfExpired(reason = 'retry') {",
    '\nasync function deferComfortStart(',
    'comfort retry deadline bridge'
  );
  const runComfortDeadlineCase17 = async throwDuringRetry => new Function(
    'throwDuringRetry',
    `let testNow = 1_000_000;
    const deadline = testNow + 1000;
    const Date = { now: () => testNow };
    const schedule = {
      enabled: true,
      pwmState: 'on',
      comfortStartUntil: deadline,
      nextTriggerAt: 0,
      pageTimerError: ''
    };
    let pwmRuntimeRevision = 61;
    const COMFORT_START_RETRY_MS = 60_000;
    const COMFORT_START_MINUTES = 5;
    let pwmCreateCalls = 0;
    let fallbackCalls = 0;
    let finishCalls = 0;
    function isAutomationOperationCurrent() { return true; }
    function isComfortStartActive() {
      return schedule.enabled && schedule.comfortStartUntil > testNow;
    }
    function setNextTriggerAt(value) { schedule.nextTriggerAt = value > 0 ? value : 0; }
    async function persistSchedule() {}
    async function createPwmAlarmFromPlan() { pwmCreateCalls += 1; return false; }
    async function scheduleComfortStartEndAlarm() { return true; }
    async function scheduleComfortRetryFallback() { fallbackCalls += 1; return false; }
    async function createAlarm() { return true; }
    async function updateBadge() {}
    function appendDiagnosticLog() {}
    ${deferComfortStartSource17}
    async function runComfortStart() {
      testNow = deadline + 1;
      if (throwDuringRetry) throw new Error('synthetic retry crossed deadline');
      return deferComfortStart('crossed deadline', pwmRuntimeRevision);
    }
    async function finishComfortStart() {
      finishCalls += 1;
      schedule.comfortStartUntil = 0;
      return { handled: true, automationAllowed: true };
    }
    ${retryComfortDeadlineSource17}
    return retryComfortStartAndFinishIfExpired('retry').then(result => ({
      result,
      pwmCreateCalls,
      fallbackCalls,
      finishCalls,
      nextTriggerAt: schedule.nextTriggerAt
    }));`
  )(throwDuringRetry);
  const resolvedComfortDeadline17 = await runComfortDeadlineCase17(false);
  const thrownComfortDeadline17 = await runComfortDeadlineCase17(true);
  assertPass(resolvedComfortDeadline17.finishCalls === 1
      && resolvedComfortDeadline17.result.continuePwm === true
      && resolvedComfortDeadline17.pwmCreateCalls === 0
      && resolvedComfortDeadline17.fallbackCalls === 1
      && resolvedComfortDeadline17.nextTriggerAt === 0
      && thrownComfortDeadline17.finishCalls === 1
      && thrownComfortDeadline17.result.continuePwm === true
      && thrownComfortDeadline17.result.retryError?.message
        === 'synthetic retry crossed deadline',
    '17F-6: comfort retry 的真实 defer/throw 跨截止且无未来钟时都立即 finish，不把已消费 alarm 当成功');
  const comfortResumeDecisionSource17 = extractSourceSection(
    backgroundSource,
    'function shouldResumePwmAfterComfortFinish(',
    '\nasync function deferComfortStart(',
    'comfort finish resume decision'
  );
  const shouldResumeComfort17 = new Function(
    `${comfortResumeDecisionSource17}; return shouldResumePwmAfterComfortFinish;`
  )();
  const allowedComfortFinish17 = { handled: true, automationAllowed: true };
  assertPass(shouldResumeComfort17(allowedComfortFinish17, 0) === true
      && shouldResumeComfort17(allowedComfortFinish17, Date.now() + 15 * 60000) === false
      && shouldResumeComfort17({ ...allowedComfortFinish17, deferred: true }, 0) === false,
    '17F-7: comfort fallback 无主钟时恢复 PWM；保留的更晚 main clock 或已 defer finish 均不提前消费');
  const comfortTimerBeforeOn17 = comfortSource17.indexOf(
    'const pageTimerBeforeOn = await getCurrentPageTimer()'
  );
  const comfortToggle17 = comfortSource17.indexOf("toggleAC('on', {");
  const comfortConfirmedFloor17 = comfortSource17.indexOf(
    'schedule.comfortStartUntil = confirmedFloorPlan.minimumTargetAt'
  );
  const comfortTimerAfterOn17 = comfortSource17.indexOf(
    'const pageTimerInput = await getCurrentPageTimer()',
    comfortToggle17
  );
  const comfortCalibration17 = comfortSource17.indexOf(
    'await setPageTimer(',
    comfortTimerAfterOn17
  );
  assertPass(comfortTimerBeforeOn17 >= 0
      && comfortTimerBeforeOn17 < comfortToggle17
      && comfortSource17.indexOf('pageTimerMinutes: provisionalPlan.timerMinutes', comfortToggle17)
        > comfortToggle17
      && comfortConfirmedFloor17 > comfortToggle17
      && comfortTimerAfterOn17 > comfortConfirmedFloor17
      && comfortCalibration17 > comfortTimerAfterOn17,
    '17G: 舒适启动先保留既有更晚 timer 并同页预置；ON/Execution succeeded 后再校准五分钟 floor');
  assertPass((comfortSource17.includes("createAlarm('ac-comfort-end'")
        || comfortSource17.includes('createAlarm(COMFORT_START_END_ALARM'))
      && comfortSource17.includes("chrome.alarms.clear('ac-comfort-end')")
      && comfortSource17.includes('isWithinActiveHours()')
      && comfortSource17.includes("requestTimerBasedShutdown('comfort-start-ended-outside-hours')")
      && comfortSource17.includes('return deferComfortFinish(error, automationRevision, priorConfirmedAt);')
      && comfortSource17.includes("persistSchedule('comfort-finish-retry-intent'"),
    '17H: 独立舒适截止闹钟跨时段；结束事务异常恢复 marker 并 intent-first 一分钟重试，不因先清 marker 失联');

  const updateComfortRequested17 = updateScheduleBody.indexOf(
    'const comfortRequested = !wasEnabled && schedule.enabled;'
  );
  assertPass(updateComfortRequested17 >= 0
      && updateScheduleBody.includes("await runComfortStart('user-enable')")
      && updateScheduleBody.includes('!isComfortStartActive()')
      && !updateScheduleBody.includes("runComfortStart('popup-open')"),
    '17I: 仅本机 enabled false→true 请求舒适启动；普通 restart/Popup 打开不重新开机或延长保护');

  const installedBody17 = extractSourceSection(
    backgroundSource,
    'chrome.runtime.onInstalled.addListener(async (details) => {',
    '\n\n// ----- 官方推荐：检测到新版本自动热更新',
    'onInstalled comfort trigger'
  );
  const installBranch17 = installedBody17.slice(
    installedBody17.indexOf("if (details.reason === 'install')"),
    installedBody17.indexOf("} else if (details.reason === 'update')")
  );
  const updateBranch17 = installedBody17.slice(
    installedBody17.indexOf("} else if (details.reason === 'update')")
  );
  assertPass(installBranch17.includes("runComfortStart('install')")
      && installBranch17.includes('if (schedule.enabled)')
      && installBranch17.includes('existing[INSTALL_BOOTSTRAP_KEY] !== true')
      && installBranch17.includes('firstInstallBootstrap')
      && installBranch17.includes("chrome.storage.local.set({ [INSTALL_BOOTSTRAP_KEY]: true })")
      && installBranch17.includes('&& existing[STORAGE_KEY]?.enabled === true')
      && !updateBranch17.includes('runComfortStart('),
    '17J: 首次安装以本机 marker 只认领一次已有启用配置，重启/安装尾声不抢用户操作；更新绝不触发');

  const alarmComfortBody17 = extractSourceSection(
    backgroundSource,
    "if (alarm.name === 'ac-pwm') {",
    "\n\n  if (alarm.name === 'ac-watchdog')",
    'comfort-aware ac-pwm alarm'
  );
  assertPass(alarmComfortBody17.includes('isComfortStartActive(')
      && alarmComfortBody17.includes("retryComfortStartAndFinishIfExpired('retry')")
      && alarmComfortBody17.includes('finishComfortStart(')
      && backgroundSource.includes("if (alarm.name === 'ac-comfort-end')")
      && backgroundSource.includes("retryComfortStartAndFinishIfExpired('retry')")
      && backgroundSource.includes("schedule.pwmState === 'on'")
      && alarmComfortBody17.includes('comfortEnd?.deferred'),
    '17K: ac-pwm/comfort fallback 在 marker 内只重试布防；结束事务已 defer 时不继续误跑普通 PWM');
  assertPass(resetDisabledPwmRuntimeSource.includes('schedule.comfortStartUntil = 0;')
      && resetDisabledPwmRuntimeSource.includes("chrome.alarms.clear('ac-comfort-end')")
      && backgroundSource.includes('preemptAutomaticOnForExplicitDisable')
      && backgroundSource.includes("msg.data?.enabled === false"),
    '17L: 用户主动关闭立即失效长开机流程并清除舒适标记/闹钟，停用优先于五分钟保护');

  const snapshotSource17 = extractSourceSection(
    backgroundSource,
    'async function getScheduleSnapshot(lite = false) {',
    '\nasync function toggleNowAndSync(action)',
    'comfort-aware schedule snapshot'
  );
  assertPass(snapshotSource17.includes('snapshot._comfortStartActive = isComfortStartActive()')
      && snapshotSource17.includes('&& !snapshot._comfortStartActive'),
    '17M: Popup 快照明确暴露舒适启动，跨时段的五分钟不被误显示为暂停');
  const popupActiveHoursSource17 = extractSourceSection(
    popupSource,
    'function isAutomationPausedByActiveHours(schedule, now = new Date()) {',
    '\n\nasync function refreshStatus()',
    'comfort-aware popup active-hours fallback'
  );
  const popupPausedByActiveHours17 = new Function(
    `${popupActiveHoursSource17}; return isAutomationPausedByActiveHours;`
  )();
  const outsideHours17 = new Date(2026, 7, 27, 12, 0, 0, 0);
  const popupComfortSchedule17 = {
    enabled: true,
    activeHours: { enabled: true, start: '13:00', end: '14:00' },
    comfortStartUntil: outsideHours17.getTime() + 5 * 60_000
  };
  assertPass(popupPausedByActiveHours17(popupComfortSchedule17, outsideHours17) === false
      && popupPausedByActiveHours17({
        ...popupComfortSchedule17,
        comfortStartUntil: 0,
        _comfortStartActive: false
      }, outsideHours17) === true,
    '17M-1: Popup storage 降级与诊断也把有效舒适阶段视为运行中，截止后才恢复时段外暂停');
  assertPass(popupSource.includes("response.comfortStart?.success === true")
      && popupSource.includes("t('statusComfortStartOK'")
      && popupSource.includes("t('statusComfortStartRetry'")
      && zhCN.statusComfortStartOK?.message.includes('5 分钟')
      && en.statusComfortStartOK?.message.includes('5 minutes'),
    '17N: Popup 在原有状态区内反馈五分钟启动成功/重试，不使用启动弹窗');

  // ===== 用例 18: 同页预置关机保险后开机 =====
  beginSuite('用例 18：同页预置关机保险后开机',
    '\n\n=== 用例 18: 同页预置关机保险后开机 ===\n');

  const preparedOnStart18 = backgroundSource.indexOf(
    'async function turnOnWithPreparedPageTimer('
  );
  const preparedOnEnd18 = backgroundSource.indexOf(
    '\n// ----- 切换 AC 状态',
    preparedOnStart18
  );
  const preparedOnBody18 = preparedOnStart18 >= 0 && preparedOnEnd18 > preparedOnStart18
    ? backgroundSource.slice(preparedOnStart18, preparedOnEnd18)
    : '';
  const rawTimerStart18 = backgroundSource.indexOf(
    'async function writePageTimerOnExactHomeTab('
  );
  const rawTimerEnd18 = backgroundSource.indexOf(
    '\n// ----- 设置页面自带定时器',
    rawTimerStart18
  );
  const rawTimerBody18 = rawTimerStart18 >= 0 && rawTimerEnd18 > rawTimerStart18
    ? backgroundSource.slice(rawTimerStart18, rawTimerEnd18)
    : '';

  const prearmIndex18 = preparedOnBody18.indexOf('writePageTimerOnExactHomeTab(');
  const exactTabRecheckIndex18 = preparedOnBody18.indexOf(
    'getExactACHomeTab(tab.id)',
    prearmIndex18
  );
  const toggleIndex18 = preparedOnBody18.indexOf(
    'attemptACToggleWithRecovery(',
    exactTabRecheckIndex18
  );
  const verifiedTimerIndex18 = preparedOnBody18.indexOf(
    'await setPageTimer(',
    toggleIndex18
  );
  assertPass(preparedOnBody18.length > 0
      && rawTimerBody18.includes("action: 'setTimer'")
      && prearmIndex18 >= 0
      && exactTabRecheckIndex18 > prearmIndex18
      && toggleIndex18 > exactTabRecheckIndex18
      && verifiedTimerIndex18 > toggleIndex18
      && countOccurrences(preparedOnBody18, 'attemptACToggleWithRecovery(') === 1
      && /attemptACToggleWithRecovery\([\s\S]*?0,/.test(preparedOnBody18)
      && !preparedOnBody18.includes('refreshACControlPage('),
    '18A: 同一精确 tab 先预置 timer、再以零刷新预算开机，成功后才走正式新鲜页证明');

  assertPass(setTimerBody.includes('preferredTabId = null')
      && setTimerBody.includes('getExactACHomeTab(preferredTabId)')
      && toggleOnceBody.includes('options?.pageTimerMinutes')
      && existingTabBody.includes('turnOnWithPreparedPageTimer('),
    '18B: setPageTimer 可锁定指定 tab，toggleAC 单飞范围覆盖整笔预置开机事务');

  const comfortPrearmIndex18 = comfortSource17.indexOf('pageTimerMinutes: provisionalPlan.timerMinutes');
  const comfortToggleIndex18 = comfortSource17.indexOf("toggleAC('on', {");
  assertPass(automaticOnBody16.includes('pageTimerMinutes: schedule.onMinutes')
      && automaticOnBody16.includes('pageTimerTargetAt: observations.smartPageTimerTargetAt || 0')
      && comfortPrearmIndex18 > comfortToggleIndex18
      && comfortSource17.includes('pageTimerTargetAt: provisionalPlan.targetAt')
      && toggleBody16.includes('pageTimerMinutes: schedule.onMinutes'),
    '18C: PWM、五分钟舒适启动与手动 ON 三入口复用同一个先保险后开机事务');

  let preparedOnBehaviorPass18 = false;
  if (preparedOnBody18) {
    const makePreparedOnHarness18 = ({
      statuses = [],
      preparedResult = { success: true, value: '12:21', targetAt: 1_800_000 },
      exactTab = { id: 7, url: 'https://w5.ab.ust.hk/njggt/app/home' },
      toggleResult = { success: true },
      timerResult = { success: true, verified: true, targetAt: 1_800_000 }
    } = {}) => {
      const calls = [];
      const queue = [...statuses];
      const fn = new Function(
        'sanitizeMinutes', 'getACStatusFromExactHomeTab', 'writePageTimerOnExactHomeTab',
        'getExactACHomeTab', 'attemptACToggleWithRecovery', 'setPageTimer',
        `${preparedOnBody18}; return turnOnWithPreparedPageTimer;`
      )(
        (value, fallback) => {
          const minutes = Number.parseInt(value, 10);
          return Number.isFinite(minutes) && minutes >= 1 ? minutes : fallback;
        },
        async tabId => {
          calls.push(`status:${tabId}`);
          return queue.shift() || { isOn: null };
        },
        async (tabId, minutes, options) => {
          calls.push(`prepare:${tabId}:${minutes}:${options.targetAt}`);
          return preparedResult;
        },
        async tabId => {
          calls.push(`exact:${tabId}`);
          return exactTab;
        },
        async (tabId, action, refreshesRemaining) => {
          calls.push(`toggle:${tabId}:${action}:${refreshesRemaining}`);
          return toggleResult;
        },
        async (minutes, options) => {
          calls.push(`verify:${options.preferredTabId}:${minutes}:${options.targetAt}`);
          return timerResult;
        }
      );
      return { fn, calls };
    };
    const options18 = {
      pageTimerMinutes: 21,
      pageTimerTargetAt: 1_800_000,
      notAfterAt: 1_900_000,
      requireAutomationAllowed: true,
      automationRevision: 9
    };

    const prearmFailure18 = makePreparedOnHarness18({
      statuses: [{ isOn: false }],
      preparedResult: { success: false, error: 'picker ambiguous' }
    });
    const prearmFailureResult18 = await prearmFailure18.fn({ id: 7 }, options18);

    const driftFailure18 = makePreparedOnHarness18({
      statuses: [{ isOn: false }],
      exactTab: null
    });
    const driftFailureResult18 = await driftFailure18.fn({ id: 7 }, options18);

    const ambiguousOn18 = makePreparedOnHarness18({
      statuses: [{ isOn: false }, { isOn: true }],
      toggleResult: { success: false, error: 'missing toast' }
    });
    const ambiguousOnResult18 = await ambiguousOn18.fn({ id: 7 }, options18);

    const alreadyOn18 = makePreparedOnHarness18({ statuses: [{ isOn: true }] });
    const alreadyOnResult18 = await alreadyOn18.fn({ id: 7 }, options18);

    preparedOnBehaviorPass18 = prearmFailureResult18?.success === false
      && prearmFailureResult18?.pageTimerPrepared === false
      && prearmFailure18.calls.join(',') === 'status:7,prepare:7:21:1800000'
      && driftFailureResult18?.success === false
      && driftFailureResult18?.invalidTarget === true
      && driftFailure18.calls.join(',') === 'status:7,prepare:7:21:1800000,exact:7'
      && ambiguousOnResult18?.success === true
      && ambiguousOnResult18?.toggleAmbiguous === true
      && ambiguousOnResult18?.actualOn === true
      && ambiguousOn18.calls.join(',')
        === 'status:7,prepare:7:21:1800000,exact:7,toggle:7:on:0,status:7,verify:7:21:1800000'
      && alreadyOnResult18?.success === true
      && alreadyOnResult18?.alreadyDone === true
      && alreadyOn18.calls.join(',') === 'status:7,verify:7:21:1800000';
  }
  assertPass(preparedOnBehaviorPass18,
    '18D: 预置失败/URL 漂移均零点击；含糊但实际 ON 只验证保险；已 ON 零点击直设 timer');

  // 汇总
  const passCount = results.filter(r => r.pass).length;
  const totalCount = results.length;
  console.log('\n=== 套件汇总 ===');
  for (const suite of suiteOrder) {
    const suiteResults = results.filter(result => result.suite === suite);
    if (suiteResults.length === 0) continue;
    const suitePassCount = suiteResults.filter(result => result.pass).length;
    const status = suitePassCount === suiteResults.length ? '✅' : '❌';
    console.log(`${status} ${suite}: ${suitePassCount}/${suiteResults.length}`);
  }
  console.log(`=== 测试汇总: ${passCount}/${totalCount} 通过 ===`);
  if (passCount !== totalCount) {
    console.log('失败项:');
    for (const suite of suiteOrder) {
      const failures = results.filter(result => result.suite === suite && !result.pass);
      if (failures.length === 0) continue;
      console.log(`  ${suite}:`);
      failures.forEach(result => console.log(`    - ${result.name}`));
    }
    process.exit(1);
  } else {
    console.log('✅ 所有套件通过。');
  }
}

runTests().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(2);
});
