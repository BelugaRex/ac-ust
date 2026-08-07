// 单元测试:验证 popup.js 诊断面板的"storage 自愈"修复逻辑
// 模拟用户报告的场景:storage.nextTriggerAt=0 + live ac-pwm 存在(间隔模式 + enabled)
// 预期:popup 侧主动写 storage,把 nextTriggerAt 修复为 ac-pwm.scheduledTime

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import syncHelpers from '../sync-helpers.js';
import billingHelpers from '../billing-helpers.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ----- Mock chrome.* API -----
function createMockChrome(initialSchedule, liveAcPwmScheduledTime) {
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
      getManifest: () => ({ version: '0.6.4' }),
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

  // ===== 用例 5: i18n fetch-based 加载器 — 验证用户报告的三个坏键 =====
  console.log('\n\n=== 用例 5:i18n 翻译加载 (用户报告 acStopped/countdownInterval 显示为 key name) ===\n');

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
  console.log('  zh_CN acStopped →', JSON.stringify(acStopped_zh));
  assertPass(acStopped_zh !== 'acStopped',
    'acStopped 不再返回 key name (zh_CN)');
  assertPass(acStopped_zh.includes('冷气') || acStopped_zh.includes('关闭'),
    `acStopped 返回中文翻译: "${acStopped_zh}"`);

  // 5c: countdownCaption 带占位符替换
  const cd_zh = t(zhCN, 'countdownCaption', '关闭');
  console.log('  zh_CN countdownCaption(关闭) →', JSON.stringify(cd_zh));
  assertPass(cd_zh !== 'countdownCaption',
    'countdownCaption 不再返回 key name (zh_CN)');
  assertPass(cd_zh.includes('关闭'),
    `countdownCaption 占位符替换正确: "${cd_zh}"`);
  assertPass(!cd_zh.includes('$1'),
    'countdownCaption 无残留 $1 占位符');

  // 5d: 英文翻译也覆盖同样的 key（Crowdin 双向对齐）
  const acStopped_en = t(en, 'acStopped');
  console.log('  en acStopped →', JSON.stringify(acStopped_en));
  assertPass(acStopped_en !== 'acStopped',
    'acStopped 英文翻译存在 (非 key name)');
  assertPass(acStopped_en !== acStopped_zh,
    '中英翻译确实不同 (zh ≠ en)');

  // 5e: popup.html 中 data-i18n 属性与 messages.json key 完全对齐
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const dataI18nKeys = [...popupHtml.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
  console.log('  popup.html data-i18n keys:', dataI18nKeys.join(', '));
  for (const key of dataI18nKeys) {
    assertPass(!!zhCN[key] && !!en[key],
      `popup.html data-i18n="${key}" 在中英文 messages.json 中存在`);
  }

  const dataI18nAriaLabelKeys = [...popupHtml.matchAll(/data-i18n-aria-label="([^"]+)"/g)].map(m => m[1]);
  console.log('  popup.html data-i18n-aria-label keys:', dataI18nAriaLabelKeys.join(', '));
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
  assertPass(popupHtml.includes(`<script src="popup.js?v=${manifest.version}"></script>`),
    'popup 脚本资源版本参数与 manifest 同步，静态预览不会复用旧脚本缓存');
  assertPass(popupHtml.indexOf('<script src="billing-helpers.js"></script>')
      < popupHtml.indexOf(`<script src="popup.js?v=${manifest.version}"></script>`),
    'popup 在主脚本前加载余额纯函数，避免初始化时缺少估算器');

  // 5h: popup 布局防回归 —— 固定桌面面板宽度，避免 intrinsic/vw 初始布局竞态。
  const popupCss = fs.readFileSync(path.join(ROOT, 'popup.css'), 'utf8');
  const popupCssNoComments = popupCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assertPass(popupHtml.includes('<style media="not all">')
      && popupHtml.includes(`<link rel="stylesheet" href="popup.css?v=${manifest.version}">`),
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
      && !popupHtml.includes('class="toggle-state" id="timerToggleState"'),
    '主开关状态保留给辅助技术，但不再与拨杆重复显示');
  assertPass(/id="activeHoursRow"[\s\S]*?for="activeHoursToggle"[\s\S]*?class="toggle-switch"/.test(popupHtml)
      && /for="activeHoursStart"[\s\S]*?id="activeHoursStart"[\s\S]*?for="activeHoursEnd"[\s\S]*?id="activeHoursEnd"/.test(popupHtml)
      && !popupHtml.includes('id="activeHoursStatus"'),
    '运行时段主行含标签与拨杆，开始/结束字段保留完整无障碍名称');
  assertPass((popupHtml.match(/class="field-grid"/g) || []).length === 2
      && (popupHtml.match(/class="field"/g) || []).length === 4
      && /\.field-grid\s*\{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*?gap:\s*10px/.test(popupCssNoComments),
    '运行时段与循环时长各使用一组等宽双列字段');
  assertPass(/\.field input\[type="time"\]\s*,\s*\.field input\[type="number"\]\s*\{[^}]*?width:\s*100%[^}]*?height:\s*32px[^}]*?font-size:\s*13px/.test(popupCssNoComments),
    '四个字段统一填满列宽，使用 32px 控件高度和 13px 数字');
  assertPass(/\.toggle-switch\s*\{[^}]*?width:\s*36px[^}]*?height:\s*20px/.test(popupCssNoComments)
      && /\.toggle-switch::after\s*\{[^}]*?inset:\s*-11px\s+-4px/.test(popupCssNoComments)
      && (popupHtml.match(/class="toggle-switch"/g) || []).length === 2,
    '两个拨杆统一为 36×20px，并通过绝对命中区达到桌面指针目标要求');
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
      && popupJs.includes('return `${Number(month)}/${Number(day)} ${hour}:${minute}`;')
      && popupJs.includes('versionInfo.textContent = `v${displayVersion} · ${formatBuildTimeShort(BUILD_TIME)}`')
      && popupJs.includes("versionInfo.setAttribute('aria-label', buildInfo)")
      && popupJs.includes('versionInfo.title = buildInfo;'),
    '头栏显示版本号与分钟级短构建时间，完整秒级时间保留在 tooltip 和无障碍名称');
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
  assertPass(manifest.host_permissions?.length === 1
      && manifest.host_permissions[0] === 'https://w5.ab.ust.hk/*',
    'manifest 仅请求自动调度所需的 UST 单一来源 host permission');

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
    'popup.html', 'popup.js', 'i18n.js', 'sync-helpers.js', 'billing-helpers.js',
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

  const verbatimDistFiles = distRequiredFiles.filter(file => file !== 'popup.js');
  const mismatchedDistFiles = verbatimDistFiles.filter(file => {
    const source = fs.readFileSync(path.join(ROOT, file));
    const built = fs.readFileSync(path.join(ROOT, 'dist', file));
    return !source.equals(built);
  });
  assertPass(mismatchedDistFiles.length === 0,
    `dist 非注入文件与源码逐字一致${mismatchedDistFiles.length ? `（不一致 ${mismatchedDistFiles.join(', ')}）` : ''}`);

  const distPopupSource = fs.readFileSync(path.join(ROOT, 'dist', 'popup.js'), 'utf8');
  const distBuildTime = distPopupSource.match(/const BUILD_TIME = '([^']+)'/)?.[1];
  assertPass(distPopupSource.includes(`const APP_VERSION = '${manifest.version}'`)
      && !!distBuildTime && distBuildTime !== 'dev',
    'dist/popup.js 已注入版本号和非 dev 构建时间');
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
  console.log('\n\n=== 用例 6: sync-helpers 跨设备同步纯函数 (v0.5.6) ===\n');

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
    nextTriggerAt: futureTime
  };

  // 6A: composeSyncPayload 未来 nextTriggerAt 原样保留 + 含 syncedAt
  const payload1 = composeSyncPayload(baseSchedule, /* now */ 1700000000000);
  assertPass(payload1.enabled === true, '6A: composeSyncPayload enabled 转译');
  assertPass(payload1.nextTriggerAt === futureTime, '6A: composeSyncPayload 未来 nextTriggerAt 原样保留');
  assertPass(payload1.syncedAt === 1700000000000, '6A: composeSyncPayload syncedAt 戳记正确');
  assertPass(payload1.pwmState === 'off' && payload1.onMinutes === 30, '6A: composeSyncPayload 其他字段转译');

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
  console.log('\n\n=== 用例 7: applySyncedPhase 编排路径 (enabled 翻转核心修复) ===\n');

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
  console.log('  7A (false→true, 有相位) calls:', r7A.calls.join(','));
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
  console.log('  7B (false→true, 无相位) calls:', r7B.calls.join(','));
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
  console.log('  7C (true→false) calls:', r7C.calls.join(','));
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
  console.log('  7D (activeHours 变更) calls:', r7D.calls.join(','));
  assertPass(r7D.calls.includes('rescheduleActiveBoundary'),
    '7D: activeHours 变更 → 重排 ac-active-boundary');
  assertPass(r7D.schedule.activeHours.enabled === true && r7D.schedule.activeHours.start === '09:00',
    '7D: activeHours 字段被采纳');

  // ===== 用例 8: page timer 跨设备 phase 校验纯函数 (v0.5.10) =====
  // v0.5.10: page timer 升为跨设备主同步通道（UST 服务器已确认跨设备同步），
  // chrome.storage.sync 降为同浏览器生态补充（Chrome/Edge 账号同步互不互通）。
  // 同时修正了 v0.5.7 的 pwmState 条件 bug（之前仅 pwmState='on' 才采纳，已改双向）。
  console.log('\n\n=== 用例 8: page timer 跨设备 phase 校验纯函数 (v0.5.10) ===\n');

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
  console.log('\n\n=== 用例 9: AC 开关单一递归收敛链路 (v0.5.12) ===\n');

  const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const pageConfirmSource = fs.readFileSync(path.join(ROOT, 'page-confirm.js'), 'utf8');
  const countOccurrences = (source, needle) => source.split(needle).length - 1;

  const ensureStart = pageConfirmSource.indexOf('async function ensureACState(targetState, clickCount = 0)');
  const ensureEnd = pageConfirmSource.indexOf('\n  function findACSwitchInPageWorld', ensureStart);
  const ensureBody = ensureStart >= 0 && ensureEnd > ensureStart
    ? pageConfirmSource.slice(ensureStart, ensureEnd)
    : '';

  const pwmStart = backgroundSource.indexOf('async function runPwmStep()');
  const pwmEnd = backgroundSource.indexOf('\n// ----- 设置页面自带定时器', pwmStart);
  const pwmBody = pwmStart >= 0 && pwmEnd > pwmStart
    ? backgroundSource.slice(pwmStart, pwmEnd)
    : '';

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

  const setTimerStart = backgroundSource.indexOf('async function setPageTimer(minutes,');
  const setTimerEnd = backgroundSource.indexOf('\nasync function requestTimerBasedShutdown', setTimerStart);
  const setTimerBody = setTimerStart >= 0 && setTimerEnd > setTimerStart
    ? backgroundSource.slice(setTimerStart, setTimerEnd)
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
  assertPass(countOccurrences(pageConfirmSource, 'element.click();') === 1,
    '9E: 主世界统一点击 helper 只执行一次 element.click()');
  assertPass(!pageConfirmSource.includes('new PointerEvent')
      && !pageConfirmSource.includes('new MouseEvent')
      && !pageConfirmSource.includes('new KeyboardEvent'),
    '9F: AC 主世界不再叠发 pointer/mouse/keyboard 激活事件');
  assertPass(pageConfirmSource.includes('acStateRequestInFlight')
      && pageConfirmSource.includes('合并重复的'),
    '9G: 主世界同目标并发请求复用 single-flight Promise');
  assertPass(countOccurrences(pwmBody, "toggleAC('on')") === 1
      && !pwmBody.includes('for (let retry'),
    '9H: 每个 PWM 开机步骤只调用一次 toggleAC(on)，无外围点击重试循环');
  assertPass(!backgroundSource.includes('retryExistingTabToggle')
      && !backgroundSource.includes('async function retryToggle'),
    '9I: background 已删除四次即时消息重试路径');
  assertPass(existingTabBody.includes('isClosedMessagePortError(e)')
      && existingTabBody.includes('await chrome.tabs.update(tab.id, { url: AC_PAGE })')
      && existingTabBody.includes('await waitForTabReady(tab.id, 30000)')
      && existingTabBody.includes('recoveredByNavigate: true'),
    '9J: 仅消息端口提前关闭时导航到 AC 入口页 home，并标记单次恢复结果');
  assertPass(!contentSource.includes('function dispatchUserClick(')
      && !contentSource.includes('async function clickConfirmDialog('),
    '9K: content 隔离世界不存在第二套开关/确认点击器');
  assertPass(contentSource.includes("=== 'Air Conditioning Balance'")
      && contentSource.includes("container.querySelector('.ant-progress-text')")
      && contentSource.includes("parseBalanceMinutes(value.textContent, value.getAttribute('title'))")
      && contentSource.includes('return withBalance({ ...mainWorldStatus'),
    '9K-1: content 只从余额标题区块读取当前进度值，并随状态响应返回');
  assertPass(!backgroundSource.includes("toggleAC('off')")
      && pwmBody.includes('const timerArmed = isPageTimerProofFresh(schedule)'),
    '9L: 自动关机只检查页面定时器证明，生产代码不存在 toggleAC(off)');
  assertPass(!contentSource.includes("error: t('contentCrossDayLimit')")
      && contentSource.includes('crossesMidnight,'),
    '9M: Power-off after 跨午夜时间直接输入，不再被代码拒绝');
  const verificationStartForReload = backgroundSource.indexOf('async function verifyPageTimerPersistence(');
  const verificationEndForReload = backgroundSource.indexOf('\n// 关机定时器设置失败时', verificationStartForReload);
  const verifySectionForReload = verificationStartForReload >= 0 && verificationEndForReload > verificationStartForReload
    ? backgroundSource.slice(verificationStartForReload, verificationEndForReload)
    : '';
  assertPass(countOccurrences(backgroundSource, 'chrome.tabs.reload(') === 0
      && countOccurrences(backgroundSource, 'chrome.tabs.update(') === 3
      && backgroundSource.includes('async function restoreDiscardedACTab(tab)')
      && !verifySectionForReload.includes('chrome.tabs.reload(')
      && !verifySectionForReload.includes('chrome.tabs.update(')
      && !verifySectionForReload.includes('sourceWasAutoCreated'),
    '9N: discarded 恢复与端口提前关闭均导航到 AC 入口页 home 而非刷新当前 URL；页面定时器验证绝不刷新/导航写入来源页');
  assertPass(setTimerBody.includes('chrome.tabs.create({ url: AC_PAGE, active: false })')
      && setTimerBody.includes('restoreDiscardedACTab(tab)'),
    '9O: 页面定时器缺少可用标签时只创建隐藏 AC 页恢复，不刷新正常页面');
  assertPass(manifest.content_scripts?.[1]?.js?.join(',') === 'billing-helpers.js,content.js'
      && backgroundSource.includes("files: ['billing-helpers.js', 'content.js']"),
    '9O-1: manifest 与兜底注入均保证余额 helper 先于 content script 执行');
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
    'console',
    'AC_PAGE',
    `${toggleRecoverySource}; return { _toggleOnExistingTab, isClosedMessagePortError };`
  );
  const quietConsole = { log() {}, warn() {}, error() {} };
  const recoveryCalls = { send: 0, update: 0, get: 0, ready: 0, ensure: 0 };
  const recoveryChrome = {
    tabs: {
      async sendMessage() {
        recoveryCalls.send += 1;
        if (recoveryCalls.send === 1) {
          throw new Error('The message port closed before a response was received.');
        }
        return { success: true, state: 'on' };
      },
      async update(tabId, info) {
        recoveryCalls.update += 1;
        assertPass(tabId === 41 && info?.url === 'https://w5.ab.ust.hk/njggt/app/home',
          '9J-1: 恢复导航沿用原 AC 标签页且目标为 AC 入口页 home');
      },
      async get(tabId) {
        recoveryCalls.get += 1;
        return { id: tabId, url: 'https://w5.ab.ust.hk/njggt/app/home' };
      }
    }
  };
  const recoveryHarness = loadToggleRecovery(
    recoveryChrome,
    async () => { recoveryCalls.ready += 1; return true; },
    tab => tab?.url?.startsWith('https://w5.ab.ust.hk/njggt/app/'),
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => { recoveryCalls.ensure += 1; return true; },
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const recoveredToggle = await recoveryHarness._toggleOnExistingTab(
    { id: 41, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  assertPass(recoveredToggle.success === true && recoveredToggle.recoveredByNavigate === true,
    '9J-2: 端口提前关闭后导航到 AC 入口页 home 并单次重试成功');
  assertPass(recoveryCalls.send === 2 && recoveryCalls.update === 1
      && recoveryCalls.ready === 1 && recoveryCalls.get === 1 && recoveryCalls.ensure === 2,
    '9J-3: 恢复链路恰好发送两次、导航一次，并重新等待与注入');

  const ordinaryCalls = { send: 0, update: 0 };
  const ordinaryChrome = {
    tabs: {
      async sendMessage() {
        ordinaryCalls.send += 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async update() { ordinaryCalls.update += 1; },
      async get() { return { id: 42, url: 'https://w5.ab.ust.hk/njggt/app/home' }; }
    }
  };
  const ordinaryHarness = loadToggleRecovery(
    ordinaryChrome,
    async () => true,
    () => true,
    tab => tab?.url === 'https://w5.ab.ust.hk/njggt/app/home',
    async () => true,
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const ordinaryFailure = await ordinaryHarness._toggleOnExistingTab(
    { id: 42, url: 'https://w5.ab.ust.hk/njggt/app/home' }, 'on');
  assertPass(ordinaryFailure.success === false
      && ordinaryCalls.send === 1 && ordinaryCalls.update === 0,
    '9J-4: 非端口提前关闭错误不导航、不重复发送');

  // 9T: prioritively-navivgate-to-home: 初始 tab URL 偏离 home 时（典型为风控/警告态 app/warning）
  //     proactively 先 navigate 到 AC_PAGE，再走正常发送流程；不靠“刷新式”重试。
  const proactiveCalls = { send: 0, update: 0, get: 0, ready: 0, ensure: 0 };
  const proactiveChrome = {
    tabs: {
      async sendMessage() {
        proactiveCalls.send += 1;
        return { success: true, state: 'on' };
      },
      async update(tabId, info) {
        proactiveCalls.update += 1;
        assertPass(tabId === 43
            && info?.url === 'https://w5.ab.ust.hk/njggt/app/home',
          '9T-1: proactive navigate 沿用原 AC 标签页且目标为 AC 入口页 home');
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
    quietConsole,
    'https://w5.ab.ust.hk/njggt/app/home'
  );
  const proactiveResult = await proactiveHarness._toggleOnExistingTab(
    { id: 43, url: 'https://w5.ab.ust.hk/njggt/app/warning' }, 'on');
  assertPass(proactiveResult.success === true
      && proactiveCalls.update === 1 && proactiveCalls.send === 1
      && proactiveCalls.ready === 1 && proactiveCalls.get === 1
      && proactiveCalls.ensure === 1,
    '9T-2: 初始 URL 偏离 home 时主动 navigate 回 home 再发送 toggle，调用次数不泄灗');
  assertPass(!proactiveResult.recoveredByNavigate,
    '9T-3: proactive 路径不附加 recoveredByNavigate（这是端口破裂恢复路径的专用标记）');

  // 9U: 源码契约——isACHomePageTab 与 proactive-home-check 必须同时存在
  assertPass(backgroundSource.includes('function isACHomePageTab(tab)')
      && backgroundSource.includes(`const base = tab.url.split('#')[0].split('?')[0];`)
      && existingTabBody.includes('if (!isACHomePageTab(tab))')
      && existingTabBody.includes(`'从非 home 子页导航回 home 超时'`)
      && existingTabBody.includes(`'导航后仍未到达 home'`),
    '9U: _toggleOnExistingTab 进入时主动用 isACHomePageTab 探测偏离 home 的 tab，走 navigate 而非刷新');

  const i18nSource = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');
  assertPass(i18nSource.includes("querySelectorAll('[data-i18n-title]')"),
    '9R: i18n 加载器会翻译 data-i18n-title 属性');
  assertPass(i18nSource.includes("if (/^en(?:_|$)/i.test(normalized)) return 'en';"),
    '9S: en-US/en-GB 浏览器语言会映射到作者维护的 _locales/en');

  // ===== 用例 10: v0.5.13 关机不可漏契约 =====
  // 防止 v0.5.12 "OFF 零点击" 策略下的「忘记关机」回归：ON 路径推进 pwmState
  // 前 MUST 确认 setPageTimer 成功；失败时保持 pwmState='on' + 提前 return，
  // 不允许把未推进的相位 sync 给对端。pwmBody 在用例 9 中已读出。
  console.log('\n\n=== 用例 10: 关机不可漏契约 (v0.5.13) ===\n');

  // 10A: ON 路径在 runPwmStep 之内显式 await setPageTimer(schedule.onMinutes)
  const setPageTimerCallIdx = pwmBody.indexOf('await setPageTimer(schedule.onMinutes');
  assertPass(setPageTimerCallIdx > 0,
    '10A: ON 路径在 runPwmStep 之内显式 await setPageTimer(schedule.onMinutes)');

  // 10B: 推进 schedule.pwmState = nextState 必须出现在 setPageTimer 调用之后
  // 限字符距离 < 2000 是宽松上限——足够容纳现有失败分支的 if 块，又能在
  // 旧代码回退（setPageTimer 在 pwmState 推进之后的尾部调用）时失败。
  const pwmStateAssignIdx = pwmBody.indexOf('schedule.pwmState = nextState');
  assertPass(pwmStateAssignIdx > 0
      && setPageTimerCallIdx > 0
      && setPageTimerCallIdx < pwmStateAssignIdx
      && pwmStateAssignIdx - setPageTimerCallIdx < 2000,
    '10B: ON 路径 setPageTimer 必须先于 schedule.pwmState = nextState（避免推进后 setPageTimer 静默失败的「忘记关机」）');

  // 10C: ON 路径显式用 pageTimerResult 检查 setPageTimer 成功
  assertPass(pwmBody.includes('const pageTimerResult = await setPageTimer(schedule.onMinutes')
      && pwmBody.includes('if (!pageTimerResult?.success)'),
    '10C: ON 路径用 pageTimerResult 显式校验 setPageTimer 成功后才推进 pwmState');

  // 10D: 失败分支用 PWM-pageTimer-failed 标签 + 1 分钟后整轮重试
  assertPass(pwmBody.includes("createPwmAlarmWithVerify(1, 'PWM-pageTimer-failed')"),
    '10D: setPageTimer 失败后用 PWM-pageTimer-failed 1 分钟后重试整轮 runPwmStep（下次 A1 预检跳过点击，只重试 setPageTimer）');

  // 10E: 失败分支在 syncScheduleToSync('runPwmStep') 前提前 return
  const setTimerFailIdx = pwmBody.indexOf('!pageTimerResult?.success');
  const setTimerReturnIdx = pwmBody.indexOf('return;', setTimerFailIdx);
  const syncRunAfterIdx = pwmBody.indexOf("syncScheduleToSync('runPwmStep')", setTimerFailIdx);
  assertPass(setTimerFailIdx > 0
      && setTimerReturnIdx > 0
      && syncRunAfterIdx > 0
      && setTimerReturnIdx < syncRunAfterIdx,
    '10E: setPageTimer 失败分支在 sync 前提前 return，避免把未推进的 pwmState 推给对端让对端帮自己推进相位');

  // 10F: 失败时 pageTimerError 写入明确的失败原因，便于诊断面板排障
  assertPass(pwmBody.includes("pageTimerError = `开机已成功，但页面关机定时器未确认"),
    '10F: setPageTimer 失败时诊断 pageTimerError 写明确文案，便于排障');

  // ===== 用例 11: v0.5.13 新鲜页面定时器确认与旁路保护 =====
  // DOM 实测：已设置时 .ant-picker input 的 value/title 均为 HH:MM，关机后均为空。
  // 不能把当前 React 页面刚写入的 value 当作服务器持久化成功；必须从全新页面再读一次。
  console.log('\n\n=== 用例 11: 新鲜页面定时器确认与旁路保护 (v0.5.13) ===\n');

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
  assertPass(backgroundSource.includes('const PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS = [3000, 10000, 30000];')
      && verifyBody.includes('await sleep(PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS[attempt]);')
      && verifyBody.includes('attempts: attempt + 1')
      && verifyBody.includes('attempts: PAGE_TIMER_PERSISTENCE_VERIFY_DELAYS_MS.length')
      && verifyBody.includes('次新鲜页验证后仍未持久化'),
    '11B-1: 写入后按 3 秒、10 秒、30 秒退避，三次失败仍明确报告未持久化');
  assertPass(verifyBody.includes('let verifierTabId = null;')
      && verifyBody.includes('finally')
      && verifyBody.includes('await chrome.tabs.remove(verifierTabId);'),
    '11B-2: 每次验证尝试都会在 finally 中回收临时隐藏页');
  const verificationCallIdx = setTimerBody.indexOf('verifyPageTimerPersistence(expectedValue)');
  const proofWriteIdx = setTimerBody.indexOf('schedule.pageTimerMinutes = result.actualDelayMinutes || minutes');
  assertPass(verificationCallIdx > 0
      && proofWriteIdx > verificationCallIdx
      && setTimerBody.includes('verified: true'),
    '11C: setPageTimer 仅在新鲜页确认后才写入页面关机证明');
  assertPass(retryBody.includes('schedule.pageTimerRetryMinutes = retryMinutes')
      && retryBody.includes("createAlarm('ac-page-timer-retry'")
      && backgroundSource.includes('const retryMinutes = schedule.pageTimerRetryMinutes'),
    '11D: 非 PWM 的关机请求失败会保存分钟数并由 ac-page-timer-retry 持续重试');
  const repairTimerIdx = repairBody.indexOf('await setPageTimer(schedule.onMinutes');
  const repairOffIdx = repairBody.indexOf("schedule.pwmState = currentOn ? 'off' : 'on';");
  assertPass(repairTimerIdx > 0
      && repairOffIdx > repairTimerIdx
      && repairBody.includes("'repair-pageTimer-failed'"),
    '11E: 时钟修复仅在新鲜确认页面定时器后才恢复 OFF 相位');
  const toggleTimerIdx = toggleBody.indexOf('await setPageTimer(schedule.onMinutes');
  const toggleOffIdx = toggleBody.indexOf("schedule.pwmState = currentOn ? 'off' : 'on';");
  assertPass(toggleTimerIdx > 0
      && toggleOffIdx > toggleTimerIdx
      && toggleBody.includes("'toggle-pageTimer-failed'"),
    '11F: 手动开机仅在新鲜确认页面定时器后才进入 OFF 相位');
  assertPass(advanceBody.includes("if (nextAction === 'off')")
      && advanceBody.includes('await setPageTimer(Math.ceil(remainingMinutes)')
      && advanceBody.includes("'advance-pageTimer-failed'"),
    '11G: 过期闹钟恢复到 ON 阶段时先重新武装页面关机定时器');
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

  // ===== 用例 12: 审计修复回归（只读轮询、HIG、发布与安装） =====
  console.log('\n\n=== 用例 12: 审计修复回归（只读轮询、HIG、发布与安装） ===\n');

  const snapshotStart = backgroundSource.indexOf('async function getScheduleSnapshot(lite = false) {');
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

  const createScheduleSnapshotHarness = new Function('initialSchedule', 'liveAlarm', 'actualStatus', `
    let schedule = { ...initialSchedule };
    let storageWriteCount = 0;
    const chrome = {
      storage: {
        local: {
          async get() { return { ac_schedule: { ...schedule } }; },
          async set() { storageWriteCount += 1; }
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
    async function getCurrentACStatus() { return actualStatus; }
    async function persistSchedule() { storageWriteCount += 1; }
    async function backfillNextTriggerAt() { storageWriteCount += 1; }
    ${snapshotBody}
    return {
      getScheduleSnapshot,
      getStorageWriteCount: () => storageWriteCount,
      getMemorySchedule: () => ({ ...schedule })
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

  assertPass(popupHtml.includes('data-i18n-aria-label="helpTooltip"')
      && popupHtml.includes('aria-labelledby="pwmSettingsTitle"')
      && popupHtml.includes('aria-describedby="timerToggleState"')
      && popupHtml.includes('for="onMinutes"')
      && popupHtml.includes('for="offMinutes"'),
    '12F: 帮助、开关和分钟输入均有程序化可访问名称');
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
  const webStoreMetadata = fs.readFileSync(path.join(ROOT, 'CHROMEWEBSTORE.md'), 'utf8');
  assertPass(webStoreMetadata.includes(`| 版本 | ${manifest.version} |`)
      && webStoreMetadata.includes(`releases/ac-ust-v${manifest.version}.zip`),
    '12J: Chrome Web Store 元数据版本和 ZIP 文件名与 manifest 同步');

  // ===== 用例 13: PWM 持久化恢复独立于 popup 轮询 =====
  console.log('\n\n=== 用例 13: PWM 持久化恢复独立于 popup 轮询 ===\n');

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
      && initBody13.includes("await persistSchedule('init-finalSync'"),
    '13A: Service Worker 初始化会从 legacy/live alarm 回填并持久化 nextTriggerAt');
  assertPass(setupBody13.includes('await syncStoredTriggerFromAlarm(existingAlarm')
      && setupBody13.includes('await repairScheduleClock();'),
    '13B: 启动恢复会同步 live alarm；双重缺失时会安全重建 PWM');
  assertPass(watchdogBody13.includes("await persistSchedule('watchdogCheck'")
      && watchdogBody13.includes('restoreIntervalAlarmFromStorage'),
    '13C: 5 分钟看门狗会校准 storage，并恢复缺失的 PWM alarm');
  assertPass(alarmListenerBody13.includes("await persistSchedule('badge-tick-sync'")
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

  // ===== 用例 14: 清晰与低干扰弹窗回归 =====
  console.log('\n\n=== 用例 14: 清晰与低干扰弹窗回归 ===\n');

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

  // 汇总
  const passCount = results.filter(r => r.pass).length;
  const totalCount = results.length;
  console.log(`\n\n=== 测试汇总: ${passCount}/${totalCount} 通过 ===`);
  if (passCount !== totalCount) {
    console.log('失败项:');
    results.filter(r => !r.pass).forEach(r => console.log('  - ' + r.name));
    process.exit(1);
  } else {
    console.log('✅ 所有断言通过。popup 自愈 + 跨设备同步 + page timer 新鲜页面确认 + 关机重试 + 单一递归点击链路全部 OK。');
  }
}

runTests().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(2);
});
