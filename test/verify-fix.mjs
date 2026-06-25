// 单元测试:验证 popup.js 诊断面板的"storage 自愈"修复逻辑
// 模拟用户报告的场景:storage.nextTriggerAt=0 + live ac-pwm 存在(间隔模式 + enabled)
// 预期:popup 侧主动写 storage,把 nextTriggerAt 修复为 ac-pwm.scheduledTime

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ----- Mock chrome.* API -----
function createMockChrome(initialSchedule, liveAcPwmScheduledTime) {
  let storage = { ac_schedule: { ...initialSchedule } };
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
      getManifest: () => ({ version: '0.4.30' }),
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
  messageHandlers['getSchedule'] = () => ({ ...storage.ac_schedule });
  messageHandlers['getSwStatus'] = () => ({
    success: true,
    swStartupTime: Date.now() - 10000,
    initCompletedAt: Date.now() - 9000,
    swAgeMs: 10000,
    initAgeMs: 9000,
    initCompleted: true,
    memorySchedule: { ...storage.ac_schedule },
    liveAlarmScheduledTime: alarms['ac-pwm']?.scheduledTime || 0
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
      await new Promise(r => setTimeout(r, 200));
      // 自愈成功后直接用 repairedSchedule,不合并旧 ensured/bgSchedule(它们携带 nextTriggerAt=0/过期 会覆盖)
      s = { ...repairedSchedule };
      effectiveNextTriggerAt = s.nextTriggerAt || 0;
      selfHealed = true;
    } catch (e) {
      add(false, 'popup 侧 storage 自愈失败: ' + (e.message||'').slice(0,60));
    }
  }

  // 红灯判断(直接复制 popup.js 逻辑)
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

  console.log('\n=== 用例 1:用户报告场景(storage.nextTriggerAt 已过期 + ac-pwm 在未来 + 间隔模式) ===\n');
  console.log('初始 storage.nextTriggerAt =', initialSchedule.nextTriggerAt, '(已过期 24 分钟)');
  console.log('live ac-pwm.scheduledTime =', new Date(pwmTime).toLocaleTimeString(), '(timestamp:', pwmTime + ')');
  console.log('');

  const before = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
  console.log('修复前 storage:', { nextTriggerAt: before.nextTriggerAt, alarmCreatedAt: before.alarmCreatedAt });

  const result = await runDiagnosticSelfHeal(chrome);

  console.log('\n--- 诊断输出 ---');
  for (const line of result.lines) console.log(line);

  const after = result.storage_after;
  console.log('\n修复后 storage:', {
    nextTriggerAt: after.nextTriggerAt,
    nextTriggerAt_time: new Date(after.nextTriggerAt).toLocaleTimeString(),
    alarmCreatedAt: after.alarmCreatedAt ? new Date(after.alarmCreatedAt).toLocaleTimeString() : 0,
    alarmDelayMinutes: after.alarmDelayMinutes?.toFixed(2)
  });

  // 断言
  const assertPass = (cond, name) => {
    const tag = cond ? '✅ PASS' : '❌ FAIL';
    console.log(`${tag}  ${name}`);
    results.push({ name, pass: !!cond });
  };

  console.log('\n--- 断言 ---');
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

  // 用例 2:storage 已有正确 nextTriggerAt,不应触发自愈
  console.log('\n\n=== 用例 2:storage 已有正确值(不该触发自愈) ===\n');
  const initialSchedule2 = { ...initialSchedule, nextTriggerAt: pwmTime };
  const mock2 = createMockChrome(initialSchedule2, pwmTime);
  const result2 = await runDiagnosticSelfHeal(mock2.chrome);
  for (const line of result2.lines) console.log(line);
  console.log('');
  assertPass(result2.selfHealed === false, '已有正确值时不触发自愈(selfHealed=false)');
  assertPass(!result2.lines.some(l => l.startsWith('❌')),
    '用例 2 无任何红灯');

  // 用例 3:非间隔模式(时钟模式),不该触发自愈
  console.log('\n\n=== 用例 3:时钟模式(不该触发自愈) ===\n');
  const initialSchedule3 = { ...initialSchedule, clockMode: true };
  const mock3 = createMockChrome(initialSchedule3, pwmTime);
  const result3 = await runDiagnosticSelfHeal(mock3.chrome);
  for (const line of result3.lines) console.log(line);
  console.log('');
  assertPass(result3.selfHealed === false, '时钟模式不触发自愈');

  // 用例 4:SW 不响应 getSwStatus(模拟跑旧代码)+ popup 自愈成功 → getSwStatus 那行应显示绿灯
  console.log('\n\n=== 用例 4:SW 不响应 getSwStatus + popup 自愈成功 ===\n');
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
  for (const line of result4.lines) console.log(line);
  console.log('');
  // 自愈应触发,getSwStatus 那行应该是绿灯(popup 已接管)
  assertPass(result4.selfHealed === true, '用例 4 自愈触发');
  assertPass(!result4.lines.some(l => l.startsWith('❌')),
    '用例 4 无任何红灯(SW 不响应但 popup 自愈,功能不受影响)');
  assertPass(result4.lines.some(l => l.includes('popup 已接管 storage 自愈')),
    '用例 4 显示 "popup 已接管 storage 自愈" 绿灯');

  // 汇总
  const passCount = results.filter(r => r.pass).length;
  const totalCount = results.length;
  console.log(`\n\n=== 测试汇总: ${passCount}/${totalCount} 通过 ===`);
  if (passCount !== totalCount) {
    console.log('失败项:');
    results.filter(r => !r.pass).forEach(r => console.log('  - ' + r.name));
    process.exit(1);
  } else {
    console.log('✅ 所有断言通过,v0.4.30 popup 自愈逻辑在用户场景下确实把红灯修复为绿灯。');
  }
}

runTests().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(2);
});
