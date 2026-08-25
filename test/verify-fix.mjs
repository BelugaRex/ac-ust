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
import { runPwmPhaseCases } from './pwm-phase-cases.mjs';
import { runSmartModeCases } from './smart-mode-cases.mjs';

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

  // SW 状态查询(与 popup.js 同步:SW 不响应 + selfHealed 时显示绿灯)
  let sw = null;
  try {
    sw = await chrome.runtime.sendMessage({ type: 'getSwStatus' });
  } catch (_) {}
  if (sw && sw.success === true) {
    add(true, 'SW init 已完成 (getSwStatus 响应正常)');
  } else if (selfHealed) {
    add(true, 'popup 已接管 storage 自愈(SW 详细状态不可用,功能正常)');
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

  // 用例 4:SW 不响应 getSwStatus(模拟跑旧代码)+ popup 自愈成功 → getSwStatus 那行应显示绿灯
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
  // 自愈应触发,getSwStatus 那行应该是绿灯(popup 已接管)
  assertPass(result4.selfHealed === true, '用例 4 自愈触发');
  assertPass(!result4.lines.some(l => l.startsWith('❌')),
    '用例 4 无任何红灯(SW 不响应但 popup 自愈,功能不受影响)');
  assertPass(result4.lines.some(l => l.includes('popup 已接管 storage 自愈')),
    '用例 4 显示 "popup 已接管 storage 自愈" 绿灯');

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
  assertPass(popupHtml.indexOf('<script src="billing-helpers.js"></script>')
      < popupHtml.search(/<script src="popup\.js\?v=[^"]+"><\/script>/),
    'popup 在主脚本前加载余额纯函数，避免初始化时缺少估算器');

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
  assertPass(/--popup-width:\s*250px/.test(popupCssNoComments)
      && /body\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.app-shell\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.static-preview body\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.static-preview \.app-shell\s*\{[^}]*?transform-origin:\s*top left/.test(popupCssNoComments),
    'popup、shell 与静态预览共用 250px 宽度令牌；窄预览仍从左上角整体缩放');
  assertPass(/--font:\s*"Inter Variable",\s*"Inter",\s*-apple-system/.test(popupCssNoComments)
      && popupCssNoComments.includes('"PingFang SC"')
      && popupCssNoComments.includes('"Microsoft YaHei UI"')
      && popupCssNoComments.includes('"Noto Sans CJK SC"'),
    'popup 优先使用 Inter，并保留 macOS、Windows 与 Linux 中文字体回退');
  assertPass(/\.content\s*\{[^}]*?width:\s*auto[^}]*?min-width:\s*0[^}]*?padding:\s*8px 12px/.test(popupCssNoComments),
    '内容区使用水平12px、垂直8px的紧凑 gutter，不再由标签或版本元数据决定面板宽度');
  assertPass(/\.status-card,\s*\.settings-card\s*\{[^}]*?background:\s*var\(--surface\)[^}]*?border:\s*1px solid var\(--border\)/.test(popupCssNoComments)
      && popupHtml.includes('class="hero-number" id="countdownNumber"')
      && /\.hero-countdown\s*\{[^}]*?align-items:\s*baseline/.test(popupCssNoComments),
    '状态卡保持中性表面，状态由语义圆点表达；倒计时数字和说明按基线连续阅读');
  assertPass(popupHtml.includes('class="visually-hidden" id="timerToggleState"')
      && popupHtml.includes('class="visually-hidden" id="smartModeToggleState"'),
    '两种自动模式的状态变化保留给辅助技术，但不与可见选中态重复显示');
  assertPass(/id="activeHoursRow"[\s\S]*?for="activeHoursToggle"[\s\S]*?class="toggle-switch"/.test(popupHtml)
      && /for="activeHoursStart"[\s\S]*?id="activeHoursStart"[\s\S]*?for="activeHoursEnd"[\s\S]*?id="activeHoursEnd"/.test(popupHtml)
      && !popupHtml.includes('id="activeHoursStatus"'),
    '运行时段主行含标签与拨杆，开始/结束字段保留完整无障碍名称');
  assertPass(popupHtml.includes('data-i18n="automationSettingsLabel"')
      && popupHtml.includes('id="automationScopeHint" data-i18n="automationScopeHint"')
      && /class="active-hours-section"[^>]*aria-describedby="automationScopeHint"/.test(popupHtml),
    '自动控制组显式说明运行时段同时约束两种自动模式，并把该说明关联到运行时段区段');
  assertPass((popupHtml.match(/class="field-grid"/g) || []).length === 2
      && (popupHtml.match(/class="field"/g) || []).length === 4
      && /\.field-grid\s*\{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*?gap:\s*10px/.test(popupCssNoComments),
    '运行时段与循环时长各使用一组等宽双列字段');
  assertPass(/\.field input\[type="time"\]\s*,\s*\.field input\[type="number"\]\s*\{[^}]*?width:\s*100%[^}]*?height:\s*32px[^}]*?font-size:\s*13px/.test(popupCssNoComments),
    '四个字段统一填满列宽，使用 32px 控件高度和 13px 数字');
  assertPass(/\.toggle-switch\s*\{[^}]*?width:\s*36px[^}]*?height:\s*20px/.test(popupCssNoComments)
      && /\.toggle-switch::after\s*\{[^}]*?inset:\s*-11px\s+-4px/.test(popupCssNoComments)
      && (popupHtml.match(/class="toggle-switch"/g) || []).length === 1,
    '仅运行时段保留 36×20px 二元拨杆，并通过绝对命中区达到桌面指针目标要求');
  assertPass((popupHtml.match(/class="mode-choice"/g) || []).length === 2
      && /<fieldset class="mode-section">\s*<legend class="visually-hidden"[^>]*>[\s\S]*?class="mode-segment"[\s\S]*?<button[^>]*id="timerToggle"[^>]*aria-pressed="false"[\s\S]*?<button[^>]*id="smartModeToggle"[^>]*aria-pressed="false"/.test(popupHtml)
      && !/<input[^>]*id="(?:timerToggle|smartModeToggle)"/.test(popupHtml)
      && /\.mode-segment\s*\{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(popupCssNoComments)
      && /\.mode-choice\[aria-pressed="true"\]\s*\{[^}]*?background:\s*var\(--surface\)/.test(popupCssNoComments)
      && popupHtml.includes('class="mode-choice-mark" aria-hidden="true">✓</span>'),
    '循环定时与智能控制使用等宽二选一分段控件，持续选中态同时包含表面、边框与勾选标记');
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
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  assertPass(popupJs.includes('const timerOn = currentScheduleEnabled && !smartOn;')
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
      && /async function updateSchedule\(enabled, restart = false\) \{[\s\S]{0,900}if \(IS_STATIC_PREVIEW\)/.test(popupJs),
    '静态网页预览使用可交互的 PWM 开启演示状态，不依赖扩展 API');
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
  assertPass(popupJs.includes("const nextAction = schedule._effectivePwmState")
      && popupJs.includes("schedule._nextAction")
      && popupJs.includes("typeof schedule.actualStatus?.isOn === 'boolean'")
      && popupJs.includes("schedule.actualStatus.isOn ? 'off' : 'on'")
      && popupJs.includes(": schedule.pwmState)"),
    'popup.js nextAction fallback 链含 cached actualStatus 反推档——锁住 ON setPageTimer 失败 故障态 pwmState=on 时 popup 不再误显示"分钟后自动开启"（与状态行"冷气运行中"冲突的根因修复）');
  assertPass(popupJs.includes('function formatBuildTimeShort(buildTime)')
      && popupJs.includes('return `${month}/${day} ${hour}:${minute}`;')
      && popupJs.includes('versionInfo.textContent = `v${displayVersion} · ${formatBuildTimeShort(BUILD_TIME)}`')
      && popupJs.includes("versionInfo.setAttribute('aria-label', buildInfo)")
      && popupJs.includes('versionInfo.title = buildInfo;'),
    '头栏显示版本号与 MM/DD 分钟级短构建时间，完整秒级时间保留在 tooltip 和无障碍名称');
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
    'popup.html', 'popup.js', 'i18n.js', 'sync-helpers.js', 'pwm-phase.js', 'billing-helpers.js',
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

  const verbatimDistFiles = distRequiredFiles.filter(file => !['popup.html', 'popup.js'].includes(file));
  const mismatchedDistFiles = verbatimDistFiles.filter(file => {
    const source = fs.readFileSync(path.join(ROOT, file));
    const built = fs.readFileSync(path.join(ROOT, 'dist', file));
    return !source.equals(built);
  });
  assertPass(mismatchedDistFiles.length === 0,
    `dist 非注入文件与源码逐字一致${mismatchedDistFiles.length ? `（不一致 ${mismatchedDistFiles.join(', ')}）` : ''}`);

  const distPopupSource = fs.readFileSync(path.join(ROOT, 'dist', 'popup.js'), 'utf8');
  const distBuildTime = distPopupSource.match(/const BUILD_TIME = '([^']+)'/)?.[1];
  const distBuildEpoch = Number(
    distPopupSource.match(/const BUILD_TIME_EPOCH_MS = (\d+);/)?.[1]
  );
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
      && popupJs.includes('const BUILD_TIME_EPOCH_MS = 0;'),
    'build: 文本构建时间与数值 epoch 由同一秒注入，源码保留数值占位');
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
    smartOnBoundaryAt: futureTime - 30 * 60_000
  };

  // 6A: composeSyncPayload 未来 nextTriggerAt 原样保留 + 含 syncedAt
  const payload1 = composeSyncPayload(baseSchedule, /* now */ 1700000000000);
  assertPass(payload1.enabled === true, '6A: composeSyncPayload enabled 转译');
  assertPass(payload1.nextTriggerAt === futureTime, '6A: composeSyncPayload 未来 nextTriggerAt 原样保留');
  assertPass(payload1.syncedAt === 1700000000000, '6A: composeSyncPayload syncedAt 戳记正确');
  assertPass(payload1.pwmState === 'off' && payload1.onMinutes === 30
      && !Object.hasOwn(payload1, 'smartOnBoundaryAt'),
    '6A: composeSyncPayload 共享字段转译且排除本机智能 ON 锚点');

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

  // 6H: 偏差超出容忍窗 (> 10s) → 采纳
  const localDistant = { ...baseSchedule, nextTriggerAt: futureTime + 90 * 1000 };  // 90s 偏差
  const remoteFuture = { syncedAt: 1000, nextTriggerAt: futureTime, pwmState: 'off' };
  const adoptH = computePhaseAdoption(localDistant, remoteFuture, { now: Date.now(), lastSyncedAt: 0, toleranceMs: 10_000, staleMs: 60_000 });
  assertPass(adoptH !== null && adoptH.nextTriggerAt === futureTime,
    '6H: 90s 偏差超容忍窗 → 采纳远端');

  // 6I: 远端 nextTriggerAt=0 → 无相位信息 → null
  const remoteNoTrigger = { syncedAt: 1000, nextTriggerAt: 0, pwmState: 'off' };
  assertPass(computePhaseAdoption(localDistant, remoteNoTrigger, { now: Date.now(), lastSyncedAt: 0 }) === null,
    '6I: 远端 nextTriggerAt=0 → null（同步无相位）');

  // 6J: computeConfigDiff 检测 onMinutes 变更
  const diffOn = computeConfigDiff(baseSchedule, { onMinutes: 45, offMinutes: 30, activeHours: baseSchedule.activeHours, enabled: true });
  assertPass(diffOn.changed === true && diffOn.fields.onMinutes === 45,
    '6J: computeConfigDiff onMinutes 30→45 被检测');

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
  const countOccurrences = (source, needle) => source.split(needle).length - 1;

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
  const loadMainWorldBridge = new Function(
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
        const resultEvent = event.type === '__AC_EXTENSION_TOGGLE_AC__'
          ? '__AC_EXTENSION_TOGGLE_AC_RESULT__'
          : '__AC_EXTENSION_GET_STATUS_RESULT__';
        const responseDetail = typeof response === 'function'
          ? response(event.detail)
          : response;
        listeners.get(resultEvent)?.({
          detail: { requestId: event.detail.requestId, ...responseDetail }
        });
      }
    };
    const bridge = loadMainWorldBridge(
      fakeWindow,
      TestCustomEvent,
      callback => { callback(); return 1; }
    );
    return { ...bridge, listeners, sentEvents };
  }

  const toggleBridge = createMainWorldBridge({
    __AC_EXTENSION_TOGGLE_AC__: { success: true, action: 'on' }
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
      && toggleBridge.sentEvents[0]?.type === '__AC_EXTENSION_TOGGLE_AC__'
      && toggleBridge.sentEvents[0]?.detail?.action === 'on'
      && toggleBridge.sentEvents[0]?.detail?.notAfterAt === toggleBridgeDeadline
      && /^ac-\d+-/.test(toggleBridge.sentEvents[0]?.detail?.requestId || '')
      && toggleBridge.listeners.size === 0,
    '9Bridge-1: 主世界 toggle 握手保留事件、action、requestId 前缀与完成后监听器清理');

  const statusBridge = createMainWorldBridge({
    __AC_EXTENSION_GET_STATUS__: { isOn: false, source: 'main-world' }
  });
  const statusBridgeResult = await statusBridge.requestMainWorldStatus(3000);
  assertPass(statusBridgeResult?.isOn === false
      && statusBridgeResult.source === 'main-world'
      && !Object.hasOwn(statusBridgeResult, 'requestId')
      && statusBridge.sentEvents[0]?.type === '__AC_EXTENSION_GET_STATUS__'
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

  const ensureStart = pageConfirmSource.indexOf('async function ensureACState(targetState, clickCount = 0)');
  const ensureEnd = pageConfirmSource.indexOf('\n  function findACSwitchInPageWorld', ensureStart);
  const ensureBody = ensureStart >= 0 && ensureEnd > ensureStart
    ? pageConfirmSource.slice(ensureStart, ensureEnd)
    : '';

  const pwmBody = extractSourceSection(
    backgroundSource,
    'async function runPwmStep()',
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
  const getStatusEnd = backgroundSource.indexOf('\nasync function ensureScheduleClock()', getStatusStart);
  const getStatusBody = getStatusStart >= 0 && getStatusEnd > getStatusStart
    ? backgroundSource.slice(getStatusStart, getStatusEnd)
    : '';

  assertPass(ensureStart >= 0,
    '9A: 主世界存在 ensureACState(targetState, clickCount) 递归收敛函数');
  assertPass(ensureBody.includes('return ensureACState(targetState, clickCount + 1);'),
    '9B: 每轮等待后只递归调用 ensureACState 自身');
  assertPass(ensureBody.includes('await sleepInPageWorld(AC_STATE_SETTLE_MS);')
      && pageConfirmSource.includes('const AC_STATE_SETTLE_MS = 10000;'),
    '9C: 每次 click 后等待 10 秒再递归复查');
  assertPass(countOccurrences(ensureBody, 'clickElementOnceInPageWorld(sw)') === 1,
    '9D: ensureACState 每轮只有一个 AC 开关点击调用点');
  assertPass(countOccurrences(pageConfirmSource, 'element.click()') === 1,
    '9E: 主世界统一点击 helper 只执行一次 element.click()');
  assertPass(!pageConfirmSource.includes('new PointerEvent')
      && !pageConfirmSource.includes('new MouseEvent')
      && !pageConfirmSource.includes('new KeyboardEvent'),
    '9F: AC 主世界不再叠发 pointer/mouse/keyboard 激活事件');
  assertPass(pageConfirmSource.includes('acStateRequestInFlight')
      && pageConfirmSource.includes('合并重复的'),
    '9G: 主世界同目标并发请求复用 single-flight Promise');
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
      && pageConfirmSource.includes('detail: { requestId, action, ...result }'),
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
  const ensureFnStart = pageConfirmSource.indexOf('async function ensureACState(targetState, clickCount = 0)');
  const ensureFnEnd = pageConfirmSource.indexOf('\n  function findACSwitchInPageWorld', ensureFnStart);
  const ensureFnSource = ensureFnStart >= 0 && ensureFnEnd > ensureFnStart
    ? pageConfirmSource.slice(ensureFnStart, ensureFnEnd)
    : '';
  let disabledEnsureClickCalls = 0;
  const loadEnsure = new Function(
    'getACStatusInPageWorld', 'waitForACSwitchInPageWorld', 'clickElementOnceInPageWorld',
    'clickConfirmDialogInPageWorld', 'sleepInPageWorld', 'MAX_AC_SWITCH_CLICKS', 'AC_STATE_SETTLE_MS',
    'automaticOnCancellationRevision', 'console',
    `${ensureFnSource}; return { ensureACState };`
  );
  const { ensureACState } = loadEnsure(
    () => ({ isOn: false, disabled: true, source: 'main-world-ant-switch' }),
    async () => null,
    () => { disabledEnsureClickCalls += 1; return true; },
    async () => false,
    async () => {},
    3,
    10000,
    0,
    testConsole
  );
  ensureACState.cancellationRevision = 0;
  const disabledEnsureResult = await ensureACState(true);
  let expiredWindowClickCalls = 0;
  const { ensureACState: ensureExpiredWindow } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { expiredWindowClickCalls += 1; return true; },
    async () => false,
    async () => {},
    3,
    10000,
    0,
    testConsole
  );
  ensureExpiredWindow.notAfterAt = Date.now() - 1;
  ensureExpiredWindow.cancellationRevision = 0;
  const expiredWindowResult = await ensureExpiredWindow(true);
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
  assertPass(disabledEnsureResult.success === false
      && disabledEnsureResult.error.includes('被禁用')
      && disabledEnsureClickCalls === 0
      && expiredWindowResult.success === false
      && expiredWindowResult.error.includes('窗口已结束')
      && expiredWindowClickCalls === 0
      && expiredConfirmResult === false
      && expiredConfirmClickCalls === 0,
    '9G-5: 禁用开关或智能 ON 窗口已结束时，开关与确认按钮均零点击');
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
    async () => {},
    3,
    10000,
    1,
    testConsole
  );
  ensureCancelled.cancellationRevision = 0;
  const cancelledEnsureResult = await ensureCancelled(true);
  assertPass(cancelledEnsureResult.success === false
      && cancelledEnsureResult.error.includes('请求已被后台取消')
      && cancelledEnsureClickCalls === 0,
    '9G-5B: 后台取消旧自动 ON 后，主世界递归在下一次点击前立即停止');
  // 9G-6: 反证——启用开关（free mode 下余额为 0 也不禁用）不被误判禁用，仍走完整点击链路。
  let enabledEnsureClickCalls = 0;
  const { ensureACState: ensureEnabled } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { enabledEnsureClickCalls += 1; return true; },
    async () => false,
    async () => {},
    3,
    10000,
    0,
    testConsole
  );
  ensureEnabled.cancellationRevision = 0;
  const enabledEnsureResult = await ensureEnabled(true);
  assertPass(enabledEnsureResult.success === false
      && enabledEnsureResult.clicks === 3
      && enabledEnsureClickCalls === 3,
    '9G-6: 启用开关（free mode）不判禁用，仍走 3 次点击链路后才失败');
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
      && pwmBody.includes('boundaryAt: schedule.smartOnBoundaryAt')
      && pwmBody.includes('schedule.smartOnBoundaryAt = Number(smartOnWindow.boundaryAt) || 0;')
      && pwmBody.includes("persistSchedule('runPwmStep-smart-on-boundary', { syncFromLiveAlarm: false })")
      && pwmBody.includes('observations.smartOnWindowEndsAt = Number(smartOnWindow.windowEndsAt) || 0;')
      && pwmBody.includes('notAfterAt: getAutomaticOnDeadline(observations.smartOnWindowEndsAt || 0)')
      && pwmBody.includes('observations.smartPageTimerTargetAt = Number(smartOnWindow.pageTimerTargetAt);'),
    '9H-1: production 仅在智能自动 ON 分支统一规划；物理开机前持久化锚点并透传首分钟截止');
  assertPass(setTimerBody.includes('targetAt = 0')
      && setTimerBody.includes("action: 'setTimer'")
      && setTimerBody.includes('targetAt')
      && contentSource.includes('setPagePowerOffTimer(msg.minutes, msg.targetAt)'),
    '9H-2: 智能半点绝对关机截止时间由 background 透传到 content，不退化为相对分钟');
  assertPass(pwmBody.includes('SMART_MODE.MIN_OFF_MINUTES')
      && pwmBody.includes('alignSmartModeNextTrigger(plan, smartAlignNow, { notBeforeAt })'),
    '9H-3: 智能 OFF 提交按已确认关机时刻保留至少 5 分钟，再对齐下一半点 ON');
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
      && setTimerBody.includes('if (!isACHomePageTab(tab)) throw new Error'),
    '9O-1: 页面定时器只复用精确 home；不存在时新建隐藏 home，绝不降级改写其他 HKUST 标签');
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

  const ordinaryCalls = { send: 0, reload: 0 };
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
    ignoreDiagnosticLog,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const ordinaryFailure = await ordinaryHarness._toggleOnExistingTab(
    { id: 42, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  assertPass(ordinaryFailure.success === false
      && ordinaryFailure.recoveredByPageRefresh === true
      && ordinaryCalls.send === 2 && ordinaryCalls.reload === 1,
    '9J-4: 普通连接持续失败时有限递归恰好刷新一次、发送两次后停止');

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
  const contentWindow = {
    location: { href: 'https://w5.ab.ust.hk/njggt/app/home' },
    addEventListener() {},
    removeEventListener() {}
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
    contentSource
  );
  const runContentScript = () => executeContentScript(
    contentWorld,
    contentWindow,
    contentRuntimeChrome,
    async () => ({ ok: true, json: async () => ({}) }),
    quietConsole,
    {}
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
  assertPass(pingListenerResult === false
      && pingResponse?.success === true
      && unknownListenerResult === false
      && unknownResponseCalled === false,
    '9Z-1A: content 健康探测同步应答；未知 action 不冒充异步响应并吞住消息通道');

  const contentRecoverySource = extractSourceSection(
    backgroundSource,
    'const CONTENT_SCRIPT_PROBE_TIMEOUT_MS = 1000;',
    '\n// ----- 切换 AC 状态 -----',
    'content script recovery helpers'
  );
  const statusRecoverySource = extractSourceSection(
    backgroundSource,
    'async function getCurrentACStatus()',
    '\nasync function ensureScheduleClock()',
    'getCurrentACStatus recovery'
  );
  const loadStatusRecovery = new Function(
    'chrome',
    'isACHomePageTab',
    'sleep',
    'appendDiagnosticLog',
    'console',
    'AC_PAGE',
    `${contentRecoverySource}\n${statusRecoverySource}; return { getCurrentACStatus };`
  );
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
    'https://w5.ab.ust.hk/njggt/app/home'
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
    'https://w5.ab.ust.hk/njggt/app/home'
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
    'https://w5.ab.ust.hk/njggt/app/home'
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
    'https://w5.ab.ust.hk/njggt/app/home'
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
  const repairStart = backgroundSource.indexOf('async function repairScheduleClock()');
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
      && verifyBody.includes("chrome.tabs.create({ url: AC_PAGE, active: false })"),
    '11A: 写入来源页绝不刷新/导航；每次验证均使用独立临时隐藏页');
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
      && repairBody.includes('targetAt: smartTargetAt')
      && repairBody.includes("'repair-pageTimer-failed'"),
    '11E: 时钟修复沿用智能绝对截止，并仅在新鲜确认后恢复 OFF 相位');
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
    'async function applyPreparedSmartModeDurations() {',
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
    'async function setupAlarms(startImmediately = false) {',
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
    '11F-0: 天气任务使用严格未来的 :10/:50 one-shot，触发后先推进且启动/诊断可恢复');
  assertPass(smartWeatherPreparationBody.includes('getSmartWeather({ force: true })')
      && countOccurrences(backgroundSource, 'getSmartWeather(') === 2
      && countOccurrences(backgroundSource, 'fetchSmartWeather(') === 2
      && smartWeatherPreparationBody.includes('prepareSmartWeatherDecision({')
      && smartWeatherPreparationBody.includes('[SMART_WEATHER_PLAN_KEY]: plan')
      && preparedDurationBody.includes('chrome.storage.local.get(SMART_WEATHER_PLAN_KEY)')
      && preparedDurationBody.includes('consumeSmartWeatherDecision(')
      && !preparedDurationBody.includes('getSmartWeather(')
      && !preparedDurationBody.includes('fetchSmartWeather')
      && pwmBody.includes('await applyPreparedSmartModeDurations();')
      && !pwmBody.includes('getSmartWeather(')
      && !pwmBody.includes('fetchSmartWeather')
      && !pwmBody.includes('prepareSmartWeatherForBoundary('),
    '11F-0A: 只有预取路径强制联网；:00/:30 runPwmStep 仅消费目标绑定 storage 快照');
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
      && reapplyBody.includes('nextTriggerAt: schedule.pageTimerTargetAt')
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
    `let pwmStepRunning = false;
let pwmRuntimeRevision = 0;
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
    async () => {}
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
    `let pwmStepRunning = false;
let pwmRuntimeRevision = 0;
${reapplyBody}
return { reapplySmartSensitivityNow };`
  )(
    stableReapplySchedule,
    async () => ({}),
    () => ({ valid: true, onMinutes: 10, offMinutes: 20 }),
    smartMode.SMART_MODE,
    async reason => { stableReapplyPersistReasons.push(reason); }
  );
  await stableReapplyHarness.reapplySmartSensitivityNow();
  assertPass(stableReapplySchedule.onMinutes === 10
      && stableReapplySchedule.offMinutes === 20
      && stableReapplyPersistReasons.join(',') === 'reapply-smart-sensitivity-off-phase',
    '11F-2B: 天气等待期间相位快照稳定时，灵敏度重设仍正常更新下一 ON 周期');
  const repairFunctionSource = extractSourceSection(
    backgroundSource,
    'async function repairScheduleClock() {',
    '\n// 弹窗 est（Est. until）',
    'repairScheduleClock behavior'
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
    'Date',
    `let pwmRuntimeRevision = 0;
    function isAutomationAllowed() { return schedule.enabled; }
    async function abortStaleAutomation() { return false; }
    ${repairFunctionSource}; return repairScheduleClock;`
  );
  const runRepairCase = async (initialSchedule, nowMs) => {
    const repairSchedule = {
      ...initialSchedule,
      smartMode: { ...initialSchedule.smartMode }
    };
    const timerCalls = [];
    const alarmPlans = [];
    const repairScheduleClock = loadRepairScheduleClock(
      repairSchedule,
      async () => false,
      async () => {},
      async () => ({ isOn: true }),
      async (minutes, options = {}) => {
        const targetAt = Number(options.targetAt) || nowMs + minutes * 60000;
        timerCalls.push({ minutes, options: { ...options }, targetAt });
        repairSchedule.pageTimerTargetAt = targetAt;
        return { success: true, targetAt };
      },
      async () => { throw new Error('成功恢复不应进入失败重试'); },
      async () => {},
      async () => {},
      async plan => { alarmPlans.push({ ...plan }); },
      smartMode.SMART_MODE,
      pwmPhase.planSmartModeOnWindow,
      { now: () => nowMs }
    );
    const result = await repairScheduleClock();
    return { result, schedule: repairSchedule, timerCalls, alarmPlans };
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
  assertPass(activeSmartRepair.timerCalls[0]?.minutes === 10
      && activeSmartRepair.timerCalls[0]?.options.targetAt
        === smartRepairBoundary + 25 * 60000
      && activeSmartRepair.alarmPlans[0]?.nextTriggerAt
        === smartRepairBoundary + 25 * 60000
      && activeSmartRepair.schedule.pwmState === 'off'
      && overrunSmartRepair.timerCalls[0]?.minutes === 1
      && overrunSmartRepair.timerCalls[0]?.options.targetAt
        === new Date(2026, 7, 17, 13, 57, 0, 0).getTime()
      && ordinaryRepair.timerCalls[0]?.minutes === 12
      && !Object.hasOwn(ordinaryRepair.timerCalls[0]?.options || {}, 'targetAt')
      && ordinaryRepair.alarmPlans[0]?.nextTriggerAt
        === ordinaryRepairNow + 12 * 60000,
    '11F-3: 重启时钟修复沿用智能原半点截止，超时只给下一分钟，普通 PWM 仍按相对时长');
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
      && contentSource.includes('return inputValue === value || inputTitle === value;'),
    '11J-1: 页面定时器写入有限重试，并同时接受 value 或 title 命中目标 HH:MM');

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
      && countOccurrences(backgroundSource, 'clearPageTimerProofState();') === 3,
    '11L: planner proofAction 与两条直接失效路径统一委派给 clearPageTimerProofState');

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
      && reconciliationSites.every(([, source]) => source.includes('reconcilePwmTrigger(')
        || source.includes('persistReconciledPwmTrigger(')),
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
  const initialSchedule12 = {
    enabled: true,
    pwmState: 'off',
    nextTriggerAt: 0,
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
      && liteSnapshot12.actualStatus === null,
    '12E: full/lite 快照均投影 live alarm，lite 仍跳过 AC 状态查询');

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
  const setupStart13 = backgroundSource.indexOf('async function setupAlarms(startImmediately = false) {');
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
  assertPass(setupBody13.includes('await syncStoredTriggerFromAlarm(existingAlarm')
      && setupBody13.includes('await repairScheduleClock();'),
    '13B: 启动恢复会同步 live alarm；双重缺失时会安全重建 PWM');
    assertPass(watchdogBody13.includes("'watchdogCheck'")
      && watchdogBody13.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,')
      && watchdogBody13.includes('automationRevision')
      && watchdogBody13.includes('restoreIntervalAlarmFromStorage'),
    '13C: 5 分钟看门狗会校准 storage，并恢复缺失的 PWM alarm');
    assertPass(alarmListenerBody13.includes("'badge-tick-sync'")
      && alarmListenerBody13.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,')
      && alarmListenerBody13.includes('automationRevision')
      && alarmListenerBody13.includes("if (alarm.name === 'ac-badge-tick')"),
    '13D: 每分钟 badge tick 会把 live alarm 的相位写回 storage');
  assertPass(alarmListenerBody13.includes("if (alarm.name === 'ac-badge-tick')")
      && alarmListenerBody13.includes('await updateBadge();')
      && alarmListenerBody13.includes('await ensureOffscreen();'),
    '13F: 每分钟 badge-tick 顺带 ensureOffscreen()，守住 L2 长连接保活层');
  assertPass(backgroundSource.includes('offscreenAlive: !!offscreenAlive'),
    '13G: getSwStatus 返回 offscreenAlive 真值(L2 长连接保活层状态经 chrome.offscreen.hasDocument 真检)');
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
    alarmCreatedAt: Date.now(),
    alarmDelayMinutes: 30,
    pageTimerMinutes: 30,
    pageTimerTargetAt: Date.now() + 30 * 60_000,
    pageTimerError: 'keep',
    pageTimerRetryAt: Date.now() + 60_000,
    pageTimerRetryMinutes: 1,
    smartOnBoundaryAt: Date.now() - 30 * 60_000
  };
  const resetDisabledPwmRuntimeHarness = loadResetDisabledPwmRuntime(
    resetRuntimeSchedule,
    value => {
      resetRuntimeCalls.push(`next:${value}`);
      resetRuntimeSchedule.nextTriggerAt = value;
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
      && resetRuntimeSchedule.alarmCreatedAt === 0
      && resetRuntimeSchedule.alarmDelayMinutes === 0
      && resetRuntimeSchedule.smartOnBoundaryAt === 0
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
    'updateBadge'
  ].join(','),
  '13J: 停用运行态 helper 只清三种自动运行闹钟并刷新 badge，保留页面关机重试');

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
  const updatePersistIndex = updateScheduleBody.indexOf("persistSchedule('updateSchedule')");
  const updateShutdownIndex = updateScheduleBody.indexOf("requestTimerBasedShutdown('schedule-disabled')");
  assertPass(countOccurrences(backgroundSource, 'await resetDisabledPwmRuntime();') === 3
      && activeResetIndex >= 0 && activePersistIndex > activeResetIndex && activeShutdownIndex > activePersistIndex
      && syncResetIndex >= 0 && syncPersistIndex > syncResetIndex && syncShutdownIndex > syncPersistIndex
      && updateResetIndex >= 0 && updatePersistIndex > updateResetIndex && updateShutdownIndex > updatePersistIndex,
    '13K: 三条停用路径统一委派 helper，且均保持 B1 先持久化再页面定时器关机');

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
        && [watchdogBody13, initBody13, alarmListenerBody13, ensureDiagnosticAlarmsBody]
          .every(source => source.includes('PWM_TRIGGER_NEXT_ONLY_OPTIONS,')
            && /(?:automationRevision|diagnosticRevision)/.test(source)),
    '13M: strict wrapper 与四条副作用校准路径统一委派持久化 helper，并显式保留各自 profile');
  assertPass(ensureDiagnosticAlarmsBody.includes('schedule.smartMode?.enabled && !smartWeatherAlarm')
      && ensureDiagnosticAlarmsBody.includes('await rescheduleSmartWeatherAlarm();')
      && ensureDiagnosticAlarmsBody.includes('smartWeather: smartWeatherAlarm ? { scheduledTime: smartWeatherAlarm.scheduledTime } : null'),
    '13M-2: 诊断自愈补建 ac-smart-weather（智能模式天气闹钟）并回传 alarm 状态');
  assertPass(persistScheduleBody.includes('reconcilePwmTrigger(schedule, liveAlarm, PWM_TRIGGER_NEXT_ONLY_OPTIONS)')
      && persistScheduleBody.includes('if (!schedule.smartMode?.enabled) schedule.smartOnBoundaryAt = 0;')
      && !persistScheduleBody.includes('persistReconciledPwmTrigger(')
      && snapshotBody.includes('reconcilePwmTrigger(snapshot, alarm, PWM_TRIGGER_SNAPSHOT_OPTIONS)')
      && !snapshotBody.includes('persistReconciledPwmTrigger('),
    '13N: persistSchedule 防递归与 getScheduleSnapshot 只读路径继续直接调用 planner');

  // ===== 用例 14: 清晰与低干扰弹窗回归 =====
  beginSuite('用例 14：低干扰弹窗', '\n\n=== 用例 14: 清晰与低干扰弹窗回归 ===\n');

  const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
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
      && popupSource.includes("diagnoseHeartbeatStale"),
    '14G: 诊断面板新增 5 闹钟中的 ac-active-boundary/ac-page-timer-retry 与 L2 offscreen 与 heartbeat 真状态读取');
  assertPass(popupSource.includes("diagnoseSmartWeatherAlarm")
      && popupSource.includes("diagnoseSmartWeatherAlarmMissing")
      && popupSource.includes("diagnoseSmartWeatherFresh")
      && popupSource.includes("diagnoseSmartWeatherStale")
      && popupSource.includes("diagnoseSmartWeatherNoCache")
      && popupSource.includes("ensured?.alarms?.smartWeather"),
    '14G-2: 诊断面板新增智能模式天气闹钟与缓存新鲜度检查');
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
      && !areDiagnosticTriggersAligned(10000, 11500)
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
      && backgroundSource.includes("appendDiagnosticLog('error', 'alarm-ac-pwm', e)")
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
    `${activeHoursPolicySource}; return { isWithinActiveHours, isAutomationAllowed };`
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
      && activeHoursSectionIndex > automationHeadingIndex
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
    '16D: 自动控制先声明共同作用域；分段控件保留无障碍分组名，不重复显示二选一说明');
  assertPass(syncModeUiSource.includes("timerToggle.setAttribute('aria-pressed', String(timerOn));")
      && syncModeUiSource.includes("smartModeToggle.setAttribute('aria-pressed', String(smartOn));")
      && syncModeUiSource.includes('timerBody.hidden = !timerOn;')
      && syncModeUiSource.includes('smartBody.hidden = !smartOn;')
      && popupSource.includes("timerToggle.addEventListener('click', async () => {")
      && popupSource.includes("smartModeToggle.addEventListener('click', async () => {")
      && popupSource.includes('currentSmartMode.enabled = false;  // 模式互斥：选循环定时 → 关智能控制'),
    '16D-1: 两个分段按钮同步持久选中态并保持原有互斥、折叠与再次点击关闭语义');
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
    setCustomValidity(message) { this.validationMessage = message; }
  };
  const activeHoursEndControl16 = {
    value: '07:00',
    validationMessage: '',
    reportCount: 0,
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { this.reportCount += 1; return !this.validationMessage; }
  };
  const activeHoursCommitHarness16 = new Function(
    'activeHoursToggle', 'activeHoursStart', 'activeHoursEnd', 't',
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
    key => key === 'activeHoursInvalid' ? 'invalid active hours' : key
  );
  activeHoursCommitHarness16.commitActiveHours();
  const invalidCommitState16 = activeHoursCommitHarness16.getState();
  activeHoursStartControl16.value = '08:00';
  activeHoursEndControl16.value = '23:00';
  activeHoursCommitHarness16.commitActiveHours();
  const validCommitState16 = activeHoursCommitHarness16.getState();
  assertPass(invalidCommitState16.updateCount === 0
      && invalidCommitState16.currentActiveHours.enabled === false
      && activeHoursEndControl16.reportCount === 1
      && validCommitState16.updateCount === 1
      && validCommitState16.currentActiveHours.enabled === true
      && validCommitState16.currentActiveHours.start === '08:00'
      && validCommitState16.currentActiveHours.end === '23:00'
      && activeHoursStartControl16.validationMessage === ''
      && activeHoursEndControl16.validationMessage === ''
      && zhCN.activeHoursInvalid?.message
      && en.activeHoursInvalid?.message,
    '16E-1: popup 拒绝提交 start>=end，并在修正后清除校验错误再保留原模式启用状态');

  const setupAlarmsBody16 = extractSourceSection(
    backgroundSource,
    'async function setupAlarms(startImmediately = false) {',
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
  assertPass(activeBoundaryBody16.includes('await setupAlarms(true);')
      && setupAlarmsBody16.includes('await runPwmStep();')
      && smartEntryPlan16.kind === 'defer'
      && new Date(smartEntryPlan16.nextTriggerAt).getMinutes() === 30,
    '16F: 进入时段时循环模式可立即执行，智能模式仍等待下一个 :00/:30 窗口');
  const rescheduleActiveBoundaryBody16 = extractSourceSection(
    backgroundSource,
    'async function rescheduleActiveBoundary() {',
    '\n// 调度下一次 :10/:50 天气预取',
    'rescheduleActiveBoundary exact deadline'
  );
  assertPass(rescheduleActiveBoundaryBody16.includes(
      "await createAlarm('ac-active-boundary', { when: next });"
    )
      && !rescheduleActiveBoundaryBody16.includes('Math.max(1,'),
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
  const manualOnIndex16 = toggleBody16.indexOf("toggleAC('on')");
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
    const getAutomaticOnDeadline16 = new Function(
      'schedule', 'isWithinActiveHours', 'getNextActiveBoundary',
      `${automaticOnDeadlineSource16}; return getAutomaticOnDeadline;`
    )(
      deadlineSchedule16,
      () => true,
      () => activeBoundaryAt16
    );
    const earlierSmartDeadline16 = activeBoundaryAt16 - 30_000;
    const laterSmartDeadline16 = activeBoundaryAt16 + 30_000;
    const expiredSmartDeadline16 = nowAt16.getTime() - 1;
    const activeOnlyDeadline16 = getAutomaticOnDeadline16(0, nowAt16);
    const earlierDeadline16 = getAutomaticOnDeadline16(earlierSmartDeadline16, nowAt16);
    const cappedDeadline16 = getAutomaticOnDeadline16(laterSmartDeadline16, nowAt16);
    const expiredDeadline16 = getAutomaticOnDeadline16(expiredSmartDeadline16, nowAt16);
    deadlineSchedule16.activeHours.enabled = false;
    const smartOnlyDeadline16 = getAutomaticOnDeadline16(laterSmartDeadline16, nowAt16);
    automaticOnDeadlinePass16 = activeOnlyDeadline16 === activeBoundaryAt16
      && earlierDeadline16 === earlierSmartDeadline16
      && cappedDeadline16 === activeBoundaryAt16
      && expiredDeadline16 === expiredSmartDeadline16
      && smartOnlyDeadline16 === laterSmartDeadline16;
  }
  assertPass(automaticOnDeadlinePass16
      && automaticOnBody16.includes('getAutomaticOnDeadline('),
    '16K-1: 自动 ON 页面递归截止于智能首分钟与运行时段结束的更早者');

  const ensureDiagnosticPausedSchedule16 = {
    enabled: true,
    smartMode: { enabled: true },
    activeHours: { enabled: true, start: '08:00', end: '23:00' }
  };
  const ensureDiagnosticClears16 = [];
  let ensureDiagnosticSmartWeatherExists16 = false;
  let ensureDiagnosticSmartWeatherRepairs16 = 0;
  const ensureDiagnosticPaused16 = new Function(
    'schedule', 'loadScheduleFromStorage', 'isAutomationAllowed', 'chrome',
    'rescheduleSmartWeatherAlarm', 'clearAutomationRuntimeAlarmsWhileBlocked',
    `${ensureDiagnosticAlarmsBody}; return ensureDiagnosticAlarms;`
  )(
    ensureDiagnosticPausedSchedule16,
    async () => {},
    () => false,
    {
      alarms: {
        async clear(name) { ensureDiagnosticClears16.push(name); return true; },
        async get(name) {
          if (name === 'ac-smart-weather') {
            return ensureDiagnosticSmartWeatherExists16
              ? { name, scheduledTime: Date.now() + 60_000 }
              : undefined;
          }
          return { name, scheduledTime: Date.now() + 60_000 };
        }
      }
    },
    async () => {
      ensureDiagnosticSmartWeatherRepairs16 += 1;
      ensureDiagnosticSmartWeatherExists16 = true;
    },
    async () => {
      ensureDiagnosticClears16.push('ac-pwm', 'ac-badge-tick', 'ac-watchdog');
      return true;
    }
  );
  const ensureDiagnosticPausedResult16 = await ensureDiagnosticPaused16();
  assertPass(ensureDiagnosticPausedResult16.automationPausedByActiveHours === true
      && ['ac-pwm', 'ac-badge-tick', 'ac-watchdog'].every(name => ensureDiagnosticClears16.includes(name))
      && !ensureDiagnosticClears16.includes('ac-smart-weather')
      && !ensureDiagnosticClears16.includes('ac-page-timer-retry')
      && ensureDiagnosticSmartWeatherRepairs16 === 1
      && ensureDiagnosticPausedResult16.alarms.smartWeather?.scheduledTime > Date.now(),
    '16L: 后台诊断在时段外清除泄漏的运行闹钟，同时恢复天气预取并保留关机重试');

  const ensureDiagnosticDisabledClears16 = [];
  const ensureDiagnosticDisabled16 = new Function(
    'schedule', 'loadScheduleFromStorage', 'isAutomationAllowed', 'chrome',
    'clearAutomationRuntimeAlarmsWhileBlocked',
    `${ensureDiagnosticAlarmsBody}; return ensureDiagnosticAlarms;`
  )(
    {
      enabled: false,
      smartMode: { enabled: false },
      activeHours: { enabled: true, start: '08:00', end: '23:00' }
    },
    async () => {},
    () => false,
    {
      alarms: {
        async clear(name) { ensureDiagnosticDisabledClears16.push(name); return true; }
      }
    },
    async () => {
      ensureDiagnosticDisabledClears16.push('ac-pwm', 'ac-badge-tick', 'ac-watchdog');
      return true;
    }
  );
  const ensureDiagnosticDisabledResult16 = await ensureDiagnosticDisabled16();
  assertPass(ensureDiagnosticDisabledResult16.enabled === false
      && ['ac-pwm', 'ac-badge-tick', 'ac-watchdog', 'ac-smart-weather']
        .every(name => ensureDiagnosticDisabledClears16.includes(name))
      && !ensureDiagnosticDisabledClears16.includes('ac-page-timer-retry'),
    '16L-1: 后台诊断在用户停用时也清除泄漏运行闹钟，但保留页面关机重试');

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
    '} else if (!automationAllowed',
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
      pendingRemote: null
    };
    ${tryAdoptSyncedStateSourceF90}; return tryAdoptSyncedState;`
  )(
    chrome,
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
  const actualUpdateHarnessF90 = new Function(
    'runSerializedScheduleUpdate', 'persistSchedule', 'setupAlarms',
    'syncScheduleToSync', 'resetDisabledPwmRuntime', 'requestTimerBasedShutdown',
    'createAlarm', 'rescheduleActiveBoundary',
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
    function isAutomationAllowed() { return schedule.enabled; }
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
      state: () => ({ ...schedule })
    };`
  )(
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
    async () => {},
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
  const queuesBlockedBehindActualUpdateF90 = actualUpdatePersistReasonsF90.length === 1
    && actualUpdateHarnessF90.state().enabled === true
    && actualUpdateResponsesF90.length === 0
    && adoptedStatesF90.length === 0;
  releaseActualUpdateF90();
  const [, , syncOwnerResultF90, queuedSyncResultF90] = await Promise.all([
    firstActualUpdateF90,
    secondActualUpdateF90,
    syncOwnerF90,
    queuedSyncF90
  ]);
  assertPass(queuesBlockedBehindActualUpdateF90
      && syncOwnerResultF90 === true
      && queuedSyncResultF90 === false
      && actualUpdateResponsesF90.length === 2
      && actualUpdateHarnessF90.state().enabled === false
      && syncReadsF90 === 0
      && adoptedStatesF90.join(',') === 'false'
      && applySyncedPhaseBody.includes('remoteSyncedAt <= lastSyncedAt'),
    '16M-2: 真实 updateSchedule 分支与 sync 共用事务队列；等待期淘汰旧 enable，仅采纳 mailbox 最新 disable');

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
  assertPass(newerFailureOutcomeF90.status === 'rejected'
      && olderPendingOutcomeF90.status === 'fulfilled'
      && olderPendingOutcomeF90.value === false
      && outOfOrderSyncAppliesF90.join(',') === '7',
    '16M-2C: 乱序到达的旧 pending 不会掩盖较新 sync 失败或触发旧 config 副作用');

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
    'readPositiveMinutes', 'onMinutesInput', 'offMinutesInput',
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
    (input, fallback) => {
      const value = Number.parseInt(input.value, 10);
      return Number.isFinite(value) && value >= 1 ? value : fallback;
    },
    { value: '15' },
    { value: '45' },
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
  const statusBusyControlF90 = makeBusyControlF90();
  const modeBusyMessagesF90 = [];
  const modeBusyHarnessF90 = new Function(
    'timerToggle', 'smartModeToggle', 'statusDiv', 'showStatus',
    `let modeSwitchInFlight = false;
    ${modeSwitchBusySourceF90}
    return {
      setModeSwitchBusy,
      state: () => modeSwitchInFlight
    };`
  )(
    timerBusyControlF90,
    smartBusyControlF90,
    statusBusyControlF90,
    (message, type) => { modeBusyMessagesF90.push({ message, type }); }
  );
  modeBusyHarnessF90.setModeSwitchBusy(true, 'Enabling');
  const busyAppliedF90 = modeBusyHarnessF90.state() === true
    && timerBusyControlF90.disabled && smartBusyControlF90.disabled
    && timerBusyControlF90.hasAttribute('aria-busy')
    && smartBusyControlF90.hasAttribute('aria-busy')
    && statusBusyControlF90.hasAttribute('aria-busy');
  modeBusyHarnessF90.setModeSwitchBusy(false);
  assertPass(busyAppliedF90
      && modeBusyHarnessF90.state() === false
      && !timerBusyControlF90.disabled && !smartBusyControlF90.disabled
      && !timerBusyControlF90.hasAttribute('aria-busy')
      && !smartBusyControlF90.hasAttribute('aria-busy')
      && !statusBusyControlF90.hasAttribute('aria-busy')
      && modeBusyMessagesF90[0]?.message === 'Enabling',
    '16O-4: 模式提交期间循环定时与智能控制同时锁定并暴露短暂 busy 状态，完成后一起恢复');

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
      && setTimerBody.includes('sendSerializedPageTimerMessage(')
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
    '\n\n  const phaseChanged = await adoptPhaseAndRearm',
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
      && countOccurrences(backgroundSource, "chrome.alarms.clear('ac-pwm')") === 3
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
  const setupImmediateEnd16 = setupAlarmsBody16.indexOf('\n  // ----- 间隔模式 -----', setupImmediateStart16);
  const setupImmediateBody16 = setupImmediateStart16 >= 0 && setupImmediateEnd16 > setupImmediateStart16
    ? setupAlarmsBody16.slice(setupImmediateStart16, setupImmediateEnd16)
    : '';
  const restartRevisionIndex16 = setupImmediateBody16.indexOf('pwmRuntimeRevision += 1');
  const restartCooldownIndex16 = setupImmediateBody16.indexOf('lastPwmStepAt = 0');
  const restartClearIndex16 = setupImmediateBody16.indexOf('await clearPwmAlarm(');
  const restartRunIndex16 = setupImmediateBody16.indexOf('await runPwmStep();');
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
      && pageConfirmSource.includes("'__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'")
      && pageConfirmSource.includes('automaticOnCancellationRevision')
      && pageConfirmSource.includes('请求已被后台取消'),
    '16Z: 停用、离开时段或显式 restart 会取消主世界递归自动 ON，每次后续点击与确认都可被撤销');

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
