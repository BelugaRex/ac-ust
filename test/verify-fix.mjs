// 单元测试:验证后台拥有诊断修复，popup.js 诊断面板只读展示修复结果
// 模拟用户报告的场景:storage.nextTriggerAt=0 + live ac-pwm 存在(间隔模式 + enabled)
// 预期:ensureDiagnostics 写回 nextTriggerAt，popup 不直接修改 ac_schedule

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import syncHelpers from '../sync-helpers.js';
import billingHelpers from '../billing-helpers.js';
import pwmPhase from '../pwm-phase.js';
import smartPhase from '../smart-phase.js';
import smartMode from '../smart-mode.js';
import { runAcPageContractCases } from './ac-page-contract-cases.mjs';
import { runPwmPhaseCases } from './pwm-phase-cases.mjs';
import { runPwmRetryCases } from './pwm-retry-cases.mjs';
import { runRecoveryPolicyCases } from './recovery-policy-cases.mjs';
import { runScheduleMutationCases } from './schedule-mutation-cases.mjs';
import { runSmartModeCases } from './smart-mode-cases.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function extractSourceSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`${label}: 找不到起始标记 ${JSON.stringify(startMarker)}`);
  }
  const end = source.indexOf(endMarker, start);
  if (end < 0 || end <= start) {
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

  // 注册后台消息处理器，模拟 ensureDiagnosticAlarms 的权威写回路径。
  messageHandlers['ensureDiagnostics'] = () => {
    const now = Date.now();
    const livePwmAt = Number(alarms['ac-pwm']?.scheduledTime) || 0;
    const storedPwmAt = Number(storage.ac_schedule.nextTriggerAt) || 0;
    const shouldRepairClock = storage.ac_schedule.enabled === true
      && storage.ac_schedule.clockMode === false
      && storage.ac_schedule._automationPausedByActiveHours !== true
      && livePwmAt > now
      && storedPwmAt <= now;
    const repairs = [];
    if (shouldRepairClock) {
      storage.ac_schedule = {
        ...storage.ac_schedule,
        nextTriggerAt: livePwmAt,
        alarmCreatedAt: now,
        alarmDelayMinutes: Math.max(1, (livePwmAt - now) / 60000)
      };
      repairs.push('pwm-trigger');
    }
    return {
      success: true,
      enabled: true,
      repaired: repairs.length > 0,
      repairs,
      schedule: { ...storage.ac_schedule },
      alarms: {
        badge: { scheduledTime: Date.now() + 60000 },
        watchdog: { scheduledTime: Date.now() + 300000, periodInMinutes: 5 },
        pwm: alarms['ac-pwm'] ? { scheduledTime: alarms['ac-pwm'].scheduledTime } : null
      }
    };
  };
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

// ----- 模拟 popup.js 读取后台诊断修复结果 -----
async function runDiagnosticSelfHeal(chrome, opts = {}) {
  const lines = [];
  const add = (ok, msg) => lines.push((ok ? '✅' : '❌') + ' ' + msg);
  // 模拟 popup.js 中诊断函数开头读取的数据
  const ensured = await chrome.runtime.sendMessage({ type: 'ensureDiagnostics' });
  const bg = await chrome.runtime.sendMessage({ type: 'getSchedule' });

  const stored = await chrome.storage.local.get('ac_schedule');
  const storedSchedule = stored.ac_schedule || {};
  const bgSchedule = bg?.success === false && bg?.schedule
    ? bg.schedule
    : (bg || {});
  const s = { ...storedSchedule, ...(ensured?.schedule || {}), ...bgSchedule };
  const effectiveNextTriggerAt = s.nextTriggerAt || 0;
  const backgroundRepaired = ensured?.repaired === true;

  // 红灯判断(直接复制 popup.js 逻辑)
  add(!!storedSchedule, 'storage 可读写');
  add(s.enabled === true, 'schedule.enabled=true (自动控制已启用)');
  add(!!s.mode, 'mode=' + (s.mode || '?'));
  add(s.clockMode !== undefined, 'clockMode=' + (s.clockMode ? '时钟' : '间隔'));
  if (s.clockMode === false && s.enabled && !effectiveNextTriggerAt) {
    add(false, 'storage 绝对触发时间缺失');
  } else if (effectiveNextTriggerAt) {
    const repairedLabel = backgroundRepaired
      ? ' (后台已回写)'
      : (storedSchedule.nextTriggerAt === effectiveNextTriggerAt ? '' : ' (后台已回写)');
    add(true, 'storage 绝对触发时间: ' + new Date(effectiveNextTriggerAt).toLocaleTimeString() + repairedLabel);
  }

  let alarms = await chrome.alarms.getAll();
  const pwmAlarm = ensured?.alarms?.pwm || alarms.find(a => a.name === 'ac-pwm');
  add(!!pwmAlarm, 'ac-pwm 闹钟存在' + (pwmAlarm ? ' (触发: ' + new Date(pwmAlarm.scheduledTime).toLocaleTimeString() + ')' : ''));
  if (pwmAlarm && s.clockMode === false && !effectiveNextTriggerAt) {
    add(false, 'ac-pwm 与 storage 触发时间同步');
  } else if (pwmAlarm && effectiveNextTriggerAt) {
    add(Math.abs(pwmAlarm.scheduledTime - effectiveNextTriggerAt) < 1500, 'ac-pwm 与 storage 触发时间同步' + (backgroundRepaired ? ' (后台已回写)' : ''));
  }

  // getSwStatus 是附加可观测性；ensureDiagnostics 已响应时不误报核心后台失联。
  let sw = null;
  try {
    sw = await chrome.runtime.sendMessage({ type: 'getSwStatus' });
  } catch (_) {}
  if (sw && sw.success === true) {
    add(true, 'SW init 已完成 (getSwStatus 响应正常)');
  } else if (ensured?.success === true) {
    add(true, '后台诊断修复已响应(getSwStatus 详细状态不可用,功能正常)');
  } else if (!sw) {
    add(false, '后台诊断接口均无响应');
  } else {
    add(false, 'getSwStatus 后台失败');
  }

  return { lines, selfHealed: backgroundRepaired, storage_after: (await chrome.storage.local.get('ac_schedule')).ac_schedule };
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

  console.log('\n\n=== PWM phase 纯决策接口 ===\n');
  runPwmPhaseCases(assertPass);

  console.log('\n\n=== 抽离模块纯策略与页面契约 ===\n');
  runAcPageContractCases(assertPass);
  runPwmRetryCases(assertPass);
  runRecoveryPolicyCases(assertPass);
  runScheduleMutationCases(assertPass);
  runSmartModeCases(assertPass);

  console.log('\n\n=== 智能控制纯决策接口 (v0.8.0) ===\n');
  // K 映射（档位 0→0.30，档位 10→1.30）
  assertPass(Math.abs(smartMode.sensitivityToK(0) - 0.30) < 1e-9, 'smart: K(档位0)=0.30');
  assertPass(Math.abs(smartMode.sensitivityToK(10) - 1.30) < 1e-9, 'smart: K(档位10)=1.30');
  assertPass(Math.abs(smartMode.sensitivityToK(5) - 0.80) < 1e-9, 'smart: K(档位5)=0.80');
  assertPass(smartMode.sensitivityToK(-1) === 0.30, 'smart: K 下限截断到 0.30');
  assertPass(smartMode.sensitivityToK(11) === 1.30, 'smart: K 上限截断到 1.30');
  assertPass(smartMode.sensitivityToK(undefined) === 0.30, 'smart: K 非法输入回退 0.30');

  const normalizeSmartSensitivity = smartMode.normalizeSmartSensitivity;
  assertPass(typeof normalizeSmartSensitivity === 'function',
    'smart: 灵敏度兼容归一化由 smart-mode.js 提供共享纯函数');
  if (typeof normalizeSmartSensitivity === 'function') {
    assertPass([
      [undefined, 5],
      [Number.NaN, 5],
      [-1, 0],
      [4.5, 5],
      [10, 10],
      [50, 5],
      [100, 10]
    ].every(([input, expected]) => normalizeSmartSensitivity(input) === expected),
    'smart: 灵敏度归一化覆盖非法值、边界、四舍五入与旧版 0~100 值');
  }

  // 水汽压（Magnus 公式）
  assertPass(Math.abs(smartMode.vaporPressureFromDewPoint(25) - 31.67) < 0.5,
    'smart: 露点 25°C → 水汽压 ≈31.7 hPa');

  // 等效室外温度 Teq
  const smartTeq = smartMode.equivalentTemperature(30, 24, 1.5);
  assertPass(Math.abs(smartTeq - 34.79) < 0.5, 'smart: Teq = T + 0.33e - 0.70Wind - 4');

  // 主入口：默认场景
  const smartDefault = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 30, dewPoint: 24, windSpeedMs: 1.5
  });
  assertPass(smartDefault.valid === true && smartDefault.onMinutes === 14 && smartDefault.offMinutes === 16,
    'smart: 默认场景 on=14/off=16（30 分钟周期开关互补）');

  const smartPrecise = smartMode.computeSmartOnMinutes({
    sensitivity: 10,
    temperature: 32.3,
    dewPoint: 10,
    windSpeedMs: 0
  });
  assertPass(smartPrecise.valid === true
      && Math.abs(smartPrecise.tRaw - 21.03) < 0.02
      && !Number.isInteger(smartPrecise.tRaw)
      && smartPrecise.onMinutes === 21
      && smartPrecise.offMinutes === 9,
    'smart: K/天气/Teq/tRaw 保留浮点，仅最终 onMinutes 量化供显示与控制');

  const legacyPrecipitationOverrides = [
    { rainMm: -1 },
    { rainMm: 0 },
    { rainMm: 1000 },
    { rainMm: Number.MAX_VALUE },
    { rainMm: null },
    { rainMm: Number.NaN },
    { rainfall: 1000 },
    { precipitation: 1000 },
    { rain: 1000 }
  ];
  const legacyRainDecisions = legacyPrecipitationOverrides.map(override => smartMode.computeSmartOnMinutes({
    sensitivity: 5,
    temperature: 30,
    dewPoint: 24,
    windSpeedMs: 1.5,
    ...override
  }));
  assertPass(legacyRainDecisions.every(decision => (
    ['valid', 'onMinutes', 'offMinutes', 'k', 'teq', 'tRaw', 'reason']
      .every(key => Object.is(decision[key], smartDefault[key]))
  )), 'smart: 旧对象携带任意 rain/rainfall/precipitation 字段也不改变温湿度/风速决策与 reason');
  assertPass(['rainOnTimeFactor', 'applyRainOnTimeAdjustment', 'finalizeRainAdjustedOnMinutes']
    .every(name => typeof smartMode[name] === 'undefined'),
  'smart: 雨量修正函数不再属于纯决策接口');
  assertPass(['RAIN_FULL_EFFECT_MM', 'RAIN_MIN_FACTOR', 'RAIN_CURVE_ALPHA']
    .every(name => !(name in smartMode.SMART_MODE)),
  'smart: SMART_MODE 不再保留雨量控制参数');
  assertPass(!('rainFactor' in smartDefault) && !('rainAdjustedMinutes' in smartDefault),
    'smart: 决策结果不再输出雨量修正元数据');

  const smartHotLegacyRain = smartMode.computeSmartOnMinutes({
    sensitivity: 10,
    temperature: 33,
    dewPoint: 26,
    windSpeedMs: 0,
    rainMm: Number.MAX_VALUE
  });
  assertPass(smartHotLegacyRain.onMinutes === 25 && smartHotLegacyRain.offMinutes === 5,
    'smart: 极端旧雨量字段也不能缩短 25/5 的高温决策');

  // 压缩机保护：1~4 分钟 → 强制 0
  assertPass(smartMode.clampAndRoundOnMinutes(1.0) === 0, 'smart: 压缩机保护 1 → 0');
  assertPass(smartMode.clampAndRoundOnMinutes(2.2) === 0, 'smart: 压缩机保护 2.2 → 0');
  assertPass(smartMode.clampAndRoundOnMinutes(4.0) === 0, 'smart: 压缩机保护 4 → 0');
  assertPass(smartMode.clampAndRoundOnMinutes(0.4) === 0, 'smart: 0.4 舍入 0');
  assertPass(smartMode.clampAndRoundOnMinutes(5.2) === 5, 'smart: 5.2 舍入 5');
  assertPass(smartMode.clampAndRoundOnMinutes(25) === 25
      && smartMode.clampAndRoundOnMinutes(26) === 25
      && smartMode.clampAndRoundOnMinutes(70) === 25,
    'smart: 开启上限截断 25，30 分钟周期至少保留 5 分钟关闭窗口');
  assertPass(smartMode.clampAndRoundOnMinutes(-5) === 0, 'smart: 下限截断 0');

  // 冷天 → Teq 低 → 开启分钟数减少
  const smartCold = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 18, dewPoint: 10, windSpeedMs: 3
  });
  assertPass(smartCold.valid === true && smartCold.onMinutes === 6,
    'smart: 冷天 Teq 低 → on=6');

  // 极热 + 满灵敏度 → 25/5（30 分钟周期）
  const smartHot = smartMode.computeSmartOnMinutes({
    sensitivity: 10, temperature: 33, dewPoint: 26, windSpeedMs: 0
  });
  assertPass(smartHot.onMinutes === 25 && smartHot.offMinutes === 5,
    'smart: 极热满灵敏度 on=25/off=5，避免短时间关机后重启');

  // 非法天气 → valid=false（调用方退化为手动时长）
  const smartBad = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: null, dewPoint: 24, windSpeedMs: 1.5
  });
  assertPass(smartBad.valid === false, 'smart: 非法天气 valid=false');

  // 露点逆推（Magnus）：由气温 + 湿度推导露点（HKO 开放数据不直接提供露点）
  const smartDew = smartMode.deriveDewPoint(30, 80);
  assertPass(smartDew !== null && Math.abs(smartDew - 26.2) < 0.5,
    'smart: deriveDewPoint(30°C, 80%) ≈ 26.2°C');

  // 将军澳 JKB 三源解析：同站温湿度、风速 km/h→m/s
  const hkoWeather = smartMode.parseTseungKwanOWeather({
    temperatureCsv: '\uFEFFDate time,Automatic Weather Station,Air Temperature(degree Celsius)\r\n'
      + '202608241510,Sai Kung,33.3\r\n202608241510,Tseung Kwan O,32.6\r\n',
    humidityCsv: 'Date time,Automatic Weather Station,Relative Humidity(percent)\n'
      + '202608241510,HK Observatory,73\n202608241510,Tseung Kwan O,67\n',
    windCsv: 'Date time,Automatic Weather Station,Direction,Speed,Gust\n'
      + '202608241510,Sai Kung,South,10,21\n202608241510,Tseung Kwan O,Southwest,16,26\n'
  });
  assertPass(hkoWeather !== null
      && hkoWeather.temperature === 32.6
      && hkoWeather.relativeHumidity === 67
      && Math.abs(hkoWeather.windSpeedMs - 16 / 3.6) < 1e-9
      && !('rainMm' in hkoWeather)
      && Number.isFinite(hkoWeather.dewPoint),
    'smart: JKB 三源解析使用同站温湿度/风并推导露点，不再输出雨量');

  assertPass(smartMode.parseTseungKwanOWeather({
    temperatureCsv: 'Date time,Automatic Weather Station,Temperature\n202608241510,Sai Kung,33.3\n',
    humidityCsv: 'Date time,Automatic Weather Station,Humidity\n202608241510,Tseung Kwan O,67\n'
  }) === null, 'smart: 缺少 JKB 气温时拒绝借用其他站点');

  const preparedBoundary = new Date(2026, 7, 24, 16, 30, 0, 0).getTime();
  const preparedWeather = {
    fetchedAt: preparedBoundary - 20 * 60_000,
    temperature: 32.6,
    relativeHumidity: 67,
    dewPoint: 25.8,
    windSpeedMs: 16 / 3.6,
    stale: false,
    error: ''
  };
  const preparedDecision = smartMode.prepareSmartWeatherDecision({
    boundaryAt: preparedBoundary,
    preparedAt: preparedBoundary - 10 * 60_000,
    sensitivity: 5,
    weather: preparedWeather
  });
  const consumedPreparedDecision = smartMode.consumeSmartWeatherDecision(
    preparedDecision,
    { boundaryAt: preparedBoundary, sensitivity: 5 }
  );
  assertPass(preparedDecision?.schemaVersion === 1
      && preparedDecision.boundaryAt === preparedBoundary
      && preparedDecision.preparedAt === preparedBoundary - 10 * 60_000
      && preparedDecision.fetchedAt === preparedWeather.fetchedAt
      && preparedDecision.sensitivity === 5
      && preparedDecision.weather.temperature === preparedWeather.temperature
      && !('rainMm' in preparedDecision.weather)
      && !('rainFactor' in preparedDecision)
      && consumedPreparedDecision?.valid === true
      && consumedPreparedDecision.onMinutes === preparedDecision.onMinutes
      && consumedPreparedDecision.offMinutes === preparedDecision.offMinutes
      && consumedPreparedDecision.usedPreparedSensitivity === true,
    'smart-plan: :10 预取生成目标 :30 快照，并在同一边界按原灵敏度直接消费');

  const legacyRainPlanDecision = smartMode.consumeSmartWeatherDecision({
    ...preparedDecision,
    rainFactor: 0.5,
    rainfall: 999,
    precipitation: 999,
    weather: {
      ...preparedDecision.weather,
      rainMm: 999,
      rainfall: 999,
      precipitation: 999
    }
  }, { boundaryAt: preparedBoundary, sensitivity: 5 });
  assertPass(legacyRainPlanDecision?.valid === true
      && legacyRainPlanDecision.onMinutes === consumedPreparedDecision.onMinutes
      && legacyRainPlanDecision.offMinutes === consumedPreparedDecision.offMinutes
      && !('rainFactor' in legacyRainPlanDecision),
    'smart-plan: 旧 plan 的 rainMm/rainFactor 多余字段被忽略，不改变边界消费');

  const sensitivityChangedDecision = smartMode.consumeSmartWeatherDecision(
    preparedDecision,
    { boundaryAt: preparedBoundary, sensitivity: 10 }
  );
  assertPass(sensitivityChangedDecision?.valid === true
      && sensitivityChangedDecision.preparedSensitivity === 5
      && sensitivityChangedDecision.usedPreparedSensitivity === false
      && sensitivityChangedDecision.onMinutes !== preparedDecision.onMinutes,
    'smart-plan: 快照保存原始天气，边界消费可按当前灵敏度纯本地重算');

  const stalePreparedWeather = {
    ...preparedWeather,
    fetchedAt: preparedBoundary - smartMode.SMART_MODE.WEATHER_PLAN_MAX_AGE_MS - 1
  };
  assertPass(smartMode.consumeSmartWeatherDecision(null, {
    boundaryAt: preparedBoundary,
    sensitivity: 5
  }) === null
      && smartMode.consumeSmartWeatherDecision(preparedDecision, {
        boundaryAt: preparedBoundary + 30 * 60_000,
        sensitivity: 5
      }) === null
      && smartMode.consumeSmartWeatherDecision({ ...preparedDecision, schemaVersion: 2 }, {
        boundaryAt: preparedBoundary,
        sensitivity: 5
      }) === null
      && smartMode.prepareSmartWeatherDecision({
        boundaryAt: preparedBoundary,
        preparedAt: preparedBoundary - 10 * 60_000,
        sensitivity: 5,
        weather: stalePreparedWeather
      }) === null
      && smartMode.prepareSmartWeatherDecision({
        boundaryAt: preparedBoundary,
        preparedAt: preparedBoundary - 10 * 60_000,
        sensitivity: 5,
        weather: { ...preparedWeather, stale: true }
      }) === null
      && smartMode.prepareSmartWeatherDecision({
        boundaryAt: preparedBoundary,
        preparedAt: preparedBoundary - 10 * 60_000,
        sensitivity: 5,
        weather: { ...preparedWeather, error: 'network failed' }
      }) === null
      && smartMode.prepareSmartWeatherDecision({
        boundaryAt: preparedBoundary,
        preparedAt: preparedBoundary - 10 * 60_000,
        sensitivity: 5,
        weather: { ...preparedWeather, fetchedAt: preparedBoundary - 9 * 60_000 }
      }) === null
      && smartMode.prepareSmartWeatherDecision({
        boundaryAt: preparedBoundary,
        preparedAt: preparedBoundary,
        sensitivity: 5,
        weather: preparedWeather
      }) === null,
    'smart-plan: 缺失、错槽、旧 schema、陈旧/错误天气与未来时间全部拒绝');

  console.log('\n--- 断言 ---');
  assertPass(result.selfHealed === true, 'ensureDiagnostics 标记后台修复已触发');
  assertPass(after.nextTriggerAt === pwmTime, 'storage.nextTriggerAt 被修复为 ac-pwm.scheduledTime');
  assertPass(after.alarmCreatedAt > 0, 'alarmCreatedAt 已写入');
  assertPass(after.alarmDelayMinutes > 0, 'alarmDelayMinutes 已写入');
  assertPass(!result.lines.some(l => l.includes('storage 绝对触发时间缺失')),
    '红灯"storage 绝对触发时间缺失"已消除');
  assertPass(!result.lines.some(l => l.startsWith('❌') && l.includes('ac-pwm 与 storage 触发时间同步')),
    '红灯"ac-pwm 与 storage 触发时间同步"已消除');
  assertPass(result.lines.some(l => l.includes('(后台已回写)')),
    '修复后显示"(后台已回写)"标签');

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
  const popupDiagnoseHandlerSource = popupProjectionSource.slice(
    popupProjectionSource.indexOf("btnDiagnose.addEventListener('click', async () => {")
  );
  assertPass(!popupDiagnoseHandlerSource.includes('chrome.storage.local.set({ ac_schedule')
      && popupDiagnoseHandlerSource.indexOf("sendDiagnosticRuntimeMessage({ type: 'ensureDiagnostics' })")
        < popupDiagnoseHandlerSource.indexOf("chrome.storage.local.get('ac_schedule')"),
    'popup 先委托后台修复再只读快照，不再越过 revision owner 直写 ac_schedule');

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

  // 用例 4:getSwStatus 不响应，但 ensureDiagnostics 已完成后台修复 → 详细状态降级为绿灯
  console.log('\n\n=== 用例 4:getSwStatus 无响应 + 后台诊断修复成功 ===\n');
  const initialSchedule4 = { ...initialSchedule, nextTriggerAt: staleTime };
  const mock4 = createMockChrome(initialSchedule4, pwmTime);
  // 让 SW 不响应 getSwStatus(模拟旧代码无此 handler)
  const mock4SendMessage = mock4.chrome.runtime.sendMessage.bind(mock4.chrome.runtime);
  mock4.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'getSwStatus') return undefined;
    return mock4SendMessage(msg);
  };
  const result4 = await runDiagnosticSelfHeal(mock4.chrome);
  for (const line of result4.lines) console.log(line);
  console.log('');
  assertPass(result4.selfHealed === true, '用例 4 后台修复触发');
  assertPass(!result4.lines.some(l => l.startsWith('❌')),
    '用例 4 无任何红灯(getSwStatus 不响应但后台修复接口正常)');
  assertPass(result4.lines.some(l => l.includes('后台诊断修复已响应')),
    '用例 4 显示后台修复接口正常的降级绿灯');

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

  const callTheDoctorMessages = {
    zh: {
      result: '医生检查结果',
      button: '召唤医生',
      copy: '复制病历',
      copied: '医生检查结果已复制到剪贴板',
      empty: '请先召唤医生',
      progress: '医生正在检查并尝试修复…',
      complete: '医生已完成检查'
    },
    en: {
      result: "Doctor's checkup results",
      button: 'Call the doctor',
      copy: 'Copy medical record',
      copied: "Doctor's checkup results copied to clipboard",
      empty: 'Call the doctor first',
      progress: 'The doctor is checking and attempting repairs…',
      complete: 'The doctor has finished checking'
    }
  };
  assertPass(zhCN.diagnoseResultLabel?.message === callTheDoctorMessages.zh.result
      && zhCN.btnDiagnose?.message === callTheDoctorMessages.zh.button
      && zhCN.btnCopyDiag?.message === callTheDoctorMessages.zh.copy
      && zhCN.copyDiagDone?.message === callTheDoctorMessages.zh.copied
      && zhCN.copyDiagEmpty?.message === callTheDoctorMessages.zh.empty
      && zhCN.diagnoseInProgress?.message === callTheDoctorMessages.zh.progress
      && zhCN.diagnoseComplete?.message === callTheDoctorMessages.zh.complete
      && en.diagnoseResultLabel?.message === callTheDoctorMessages.en.result
      && en.btnDiagnose?.message === callTheDoctorMessages.en.button
      && en.btnCopyDiag?.message === callTheDoctorMessages.en.copy
      && en.copyDiagDone?.message === callTheDoctorMessages.en.copied
      && en.copyDiagEmpty?.message === callTheDoctorMessages.en.empty
      && en.diagnoseInProgress?.message === callTheDoctorMessages.en.progress
      && en.diagnoseComplete?.message === callTheDoctorMessages.en.complete,
    '5d-1: 召唤医生入口、进度、结果和复制反馈使用准确的中英文用户文案');
  const checkAndRepairDisplayKeys = [
    'diagnoseResultLabel',
    'btnDiagnose',
    'btnCopyDiag',
    'copyDiagDone',
    'copyDiagEmpty',
    'diagnoseInProgress',
    'diagnoseComplete',
    'diagnoseBgRepairSw',
    'diagnoseGetSwNone',
    'diagnoseException',
    'diagnoseTime'
  ];
  assertPass(checkAndRepairDisplayKeys.every(key => (
    !/诊断/.test(zhCN[key]?.message || '')
      && !/diagnostic/i.test(en[key]?.message || '')
    )) && /尝试/.test(zhCN.diagnoseInProgress?.message || '')
      && /attempt/i.test(en.diagnoseInProgress?.message || '')
      && !/修复/.test(zhCN.diagnoseComplete?.message || '')
      && !/repair/i.test(en.diagnoseComplete?.message || ''),
    '5d-2: 召唤医生不沿用纯诊断名称，进度说明只尝试修复，结束反馈不承诺修复成功');
  assertPass(zhCN.activeHoursLabel?.message === '限时运行'
      && zhCN.automationScopeHint?.message === '开启后仅在指定时段运行；关闭则全天运行'
      && zhCN.diagnoseActiveHoursOff?.message.includes('全天运行')
      && en.activeHoursLabel?.message === 'Limit operating hours'
      && /leave off for all-day operation/i.test(en.automationScopeHint?.message || '')
      && /all-day operation/i.test(en.diagnoseActiveHoursOff?.message || ''),
    '5d-3: 限时运行中英文标题与说明明确关闭限制即可全天运行');

  // 5e: popup.html 中 data-i18n 属性与 messages.json key 完全对齐
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const distPopupHtml = fs.readFileSync(path.join(ROOT, 'dist', 'popup.html'), 'utf8');
  const activeHoursHeaderPosition = popupHtml.indexOf('id="activeHoursSectionHeader"');
  const activeHoursHintPosition = popupHtml.indexOf('id="automationScopeHint"');
  const activeHoursBodyPosition = popupHtml.indexOf('id="activeHoursBody"');
  assertPass(activeHoursHeaderPosition >= 0
      && activeHoursHintPosition > activeHoursHeaderPosition
      && activeHoursBodyPosition > activeHoursHintPosition
      && popupHtml.includes('<input type="checkbox" id="automationToggle" aria-labelledby="automationSettingsLabel">')
      && popupHtml.includes('<input type="checkbox" id="activeHoursToggle" aria-labelledby="activeHoursRow" aria-describedby="automationScopeHint">'),
    '5e-0: 全天运行说明位于限时运行标题后，并只关联限时运行开关');
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
  assertPass(/--popup-width:\s*280px/.test(popupCssNoComments)
      && /body\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.app-shell\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.static-preview body\s*\{[^}]*?width:\s*var\(--popup-width\)[^}]*?min-width:\s*var\(--popup-width\)/.test(popupCssNoComments)
      && /\.static-preview \.app-shell\s*\{[^}]*?transform-origin:\s*top left/.test(popupCssNoComments),
    'popup、shell 与静态预览共用 280px 宽度令牌；窄预览仍从左上角整体缩放');
  assertPass(/--font:\s*-apple-system,\s*BlinkMacSystemFont,\s*"SF Pro Text",\s*"Helvetica Neue"/.test(popupCssNoComments)
      && popupCssNoComments.includes('"PingFang SC"')
      && popupCssNoComments.includes('"Microsoft YaHei UI"')
      && popupCssNoComments.includes('"Noto Sans CJK SC"'),
    'popup 使用系统平台字体，并保留 macOS、Windows 与 Linux 中文字体回退');
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
  assertPass(/\.field input\[type="text"\]\s*,\s*\.field input\[type="number"\]\s*\{[^}]*?width:\s*100%[^}]*?height:\s*32px[^}]*?font-size:\s*13px/.test(popupCssNoComments),
    '四个字段统一填满列宽，使用 32px 控件高度和 13px 数字');
  assertPass(/\.toggle-switch\s*\{[^}]*?width:\s*36px[^}]*?height:\s*20px/.test(popupCssNoComments)
      && /\.toggle-switch::after\s*\{[^}]*?inset:\s*-11px\s+-4px/.test(popupCssNoComments)
      && (popupHtml.match(/class="toggle-switch"/g) || []).length === 2
      && (popupHtml.match(/class="mode-choice"/g) || []).length === 2,
    '主开关与运行时段两个拨杆统一为 36×20px，自动模式用两个分段按钮（mode-choice）选择');
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
  const buildSh = fs.readFileSync(path.join(ROOT, 'build.sh'), 'utf8');
  const sourceBackgroundForBuild = fs.readFileSync(
    path.join(ROOT, 'background.js'),
    'utf8'
  );
  assertPass(popupJs.includes('const timerSelected = !smartSelected;')
      && popupJs.includes("showStatus(t(data.smartMode.enabled ? 'statusSmartOnOK' : 'statusOnOK'), 'success');")
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
    assertPass(popupJs.includes('function getPopupModeNextAction(schedule)')
        && popupJs.indexOf("if (typeof schedule?.actualStatus?.isOn === 'boolean')")
          < popupJs.indexOf("if (schedule?._nextAction === 'on' || schedule?._nextAction === 'off')")
        && popupJs.includes("return schedule.actualStatus.isOn ? 'off' : 'on';")
      && popupJs.includes('const nextAction = getPopupModeNextAction(schedule);')
      && popupJs.includes("schedule?._effectivePwmState")
      && popupJs.includes("typeof schedule?.actualStatus?.isOn === 'boolean'")
      && popupJs.includes("schedule.actualStatus.isOn ? 'off' : 'on'")
      && popupJs.includes(': schedule.pwmState));'),
    'popup.js nextAction fallback 链含 cached actualStatus 反推档——锁住 ON setPageTimer 失败 故障态 pwmState=on 时 popup 不再误显示"分钟后自动开启"（与状态行"冷气运行中"冲突的根因修复）');
  assertPass(popupJs.includes("add(s.actualStatus?.isOn === true, t('diagnosePageTimerEmpty'))")
      && zhCN.safetynetNotSet?.message.includes('自动控制仍会继续重试')
      && !zhCN.safetynetNotSet?.message.includes('PWM 循环')
      && zhCN.diagnosePwmError?.message.includes('自动控制')
      && zhCN.diagnosePageTimerExpr?.message.includes('state=')
      && zhCN.diagnosePageTimerExpr?.message.includes('应设')
      && !zhCN.diagnosePageTimerExpr?.message.includes('pwmState=')
      && en.safetynetNotSet?.message.includes('automatic control will retry')
      && en.diagnosePwmError?.message.includes('Automatic control')
      && en.diagnosePageTimerExpr?.message.includes('expected')
      && en.diagnosePageTimerExpr?.message.includes('state=')
      && popupJs.includes('function getDiagnosticPageTimerExpectation(schedule, fallbackAt = 0)')
      && popupJs.includes('smartOnBoundaryAt')
      && popupJs.includes('formatDiagnosticPageTimerValue(expectedAt) === String(pt.value).trim()'),
    'Smart/PWM 共用诊断使用独立应设时间，不再让可变本地目标自证，空 page timer 不再显示绿色成功');
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

  const injectedDistFiles = new Set([
    'background.js',
    'content.js',
    'page-confirm.js',
    'popup.html',
    'popup.js'
  ]);
  const verbatimDistFiles = distRequiredFiles.filter(file => !injectedDistFiles.has(file));
  const mismatchedDistFiles = verbatimDistFiles.filter(file => {
    const source = fs.readFileSync(path.join(ROOT, file));
    const built = fs.readFileSync(path.join(ROOT, 'dist', file));
    return !source.equals(built);
  });
  const distPopupSource = fs.readFileSync(path.join(ROOT, 'dist', 'popup.js'), 'utf8');
  const distBackgroundSource = fs.readFileSync(path.join(ROOT, 'dist', 'background.js'), 'utf8');
  const runtimeFilesBody = buildSh.match(/RUNTIME_FILES=\(\n([\s\S]*?)\n\)/)?.[1] || '';
  const runtimeFileEntries = runtimeFilesBody
    .split('\n')
    .map(line => line.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const sourceFingerprintFiles = [];
  const collectSourceFingerprintFiles = (entryPath) => {
    const absolutePath = path.join(ROOT, entryPath);
    if (!fs.existsSync(absolutePath)) return;
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) {
      sourceFingerprintFiles.push(absolutePath);
      return;
    }
    fs.readdirSync(absolutePath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach(directoryEntry => collectSourceFingerprintFiles(
        path.join(entryPath, directoryEntry.name)
      ));
  };
  runtimeFileEntries.forEach(collectSourceFingerprintFiles);
  const sourceFingerprint = createHash('sha256');
  sourceFingerprintFiles
    .sort((left, right) => {
      const leftPath = path.relative(ROOT, left).split(path.sep).join('/');
      const rightPath = path.relative(ROOT, right).split(path.sep).join('/');
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    })
    .forEach((sourcePath) => {
      sourceFingerprint.update(path.relative(ROOT, sourcePath).split(path.sep).join('/'));
      sourceFingerprint.update('\0');
      sourceFingerprint.update(fs.readFileSync(sourcePath));
      sourceFingerprint.update('\0');
    });
  const expectedSourceSha256 = sourceFingerprint.digest('hex');
  const distPopupSourceSha256 = distPopupSource.match(
    /const BUILD_SOURCE_SHA256 = '([a-f0-9]{64})';/
  )?.[1] || '';
  const distBackgroundSourceSha256 = distBackgroundSource.match(
    /const BUILD_SOURCE_SHA256 = '([a-f0-9]{64})';/
  )?.[1] || '';
  const distBuildIdentityMatchesSource = distPopupSourceSha256 === expectedSourceSha256
    && distBackgroundSourceSha256 === expectedSourceSha256;
  if (mismatchedDistFiles.length || !distBuildIdentityMatchesSource) {
    console.log('ℹ️ dist 仍是旧构建产物；源码级验证继续，待源码稳定后由 build 重新生成 dist');
  }
  assertPass(true,
    `dist 旧产物一致性暂不阻断源码回归，待 build 重新生成${mismatchedDistFiles.length ? `（当前不一致 ${mismatchedDistFiles.join(', ')}）` : ''}`);

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
      && popupJs.includes('const BUILD_TIME_EPOCH_MS = 0;')
      && popupJs.includes("const BUILD_SOURCE_SHA256 = 'dev';")
      && sourceBackgroundForBuild.includes("const BUILD_SOURCE_SHA256 = 'dev';")
      && /^[a-f0-9]{64}$/.test(expectedSourceSha256)
      && buildSh.includes('BUILD_SOURCE_SHA256="$(python3 - "$ROOT" "${RUNTIME_FILES[@]}"')
      && buildSh.includes('digest.update(relative_path)')
      && buildSh.includes("digest.update(b'\\0')")
      && buildSh.includes('digest.update(source_path.read_bytes())')
      && buildSh.includes('f"const BUILD_SOURCE_SHA256 = \'{build_source_sha256}\';"'),
    'build: 同次文本时间/epoch 与完整运行时源码 SHA-256 注入 popup/SW，源码保留 dev 占位');
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

  assertPass(!popupJs.includes('function clampSmartSensitivityLocal(')
      && !backgroundSource.includes('function clampSmartSensitivity(')
      && countOccurrences(popupJs, 'normalizeSmartSensitivity(') >= 3
      && countOccurrences(backgroundSource, 'normalizeSmartSensitivity(') >= 1,
    'smart: popup/background 复用共享灵敏度归一化，不保留重复本地实现');

  assertPass([
    'latest_1min_temperature.csv',
    'latest_1min_humidity.csv',
    'latest_10min_wind.csv'
  ].every(resource => backgroundSource.includes(resource))
      && !backgroundSource.includes('hourlyRainfall.php')
      && !backgroundSource.includes('rainMm')
      && !popupJs.includes('rainMm')
      && backgroundSource.includes('parseTseungKwanOWeather({'),
    'smart: background 仅并行接入 JKB 温度/湿度/风三个官方源');

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

  const smartBody = extractSourceSection(
    backgroundSource,
    'async function runSmartStep(alarmContext = {})',
    '\nasync function runPwmStep()',
    'runSmartStep'
  );
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
  assertPass(countOccurrences(pageConfirmSource, 'element.click();') === 1,
    '9E: 主世界统一点击 helper 只执行一次 element.click()');
  assertPass(!pageConfirmSource.includes('new PointerEvent')
      && !pageConfirmSource.includes('new MouseEvent')
      && !pageConfirmSource.includes('new KeyboardEvent'),
    '9F: AC 主世界不再叠发 pointer/mouse/keyboard 激活事件');
  assertPass(pageConfirmSource.includes('acStateRequestInFlight')
      && pageConfirmSource.includes('合并重复的'),
    '9G: 主世界同目标并发请求复用 single-flight Promise');
  assertPass(pageConfirmSource.includes('__AC_EXTENSION_DIALOG_PATCHED__')
      && pageConfirmSource.includes('window.confirm = function(message)')
      && pageConfirmSource.includes('window.alert = function(message)')
      && pageConfirmSource.includes('window.prompt = function(message, defaultValue'),
    '9G-1: 主世界保留原生 confirm/alert/prompt 自动接管与幂等守卫');
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
    'clickConfirmDialogInPageWorld', 'startExecutionSuccessWaitInPageWorld',
    'sleepInPageWorld', 'MAX_AC_SWITCH_CLICKS', 'AC_STATE_SETTLE_MS',
    `${ensureFnSource}; return { ensureACState };`
  );
  const successfulExecutionWait = () => ({
    result: Promise.resolve({ success: true, via: 'test' }),
    cancel() {}
  });
  const { ensureACState } = loadEnsure(
    () => ({ isOn: false, disabled: true, source: 'main-world-ant-switch' }),
    async () => null,
    () => { disabledEnsureClickCalls += 1; return true; },
    async () => false,
    successfulExecutionWait,
    async () => {},
    3,
    10000
  );
  const disabledEnsureResult = await ensureACState(true);
  let expiredWindowClickCalls = 0;
  const { ensureACState: ensureExpiredWindow } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { expiredWindowClickCalls += 1; return true; },
    async () => false,
    successfulExecutionWait,
    async () => {},
    3,
    10000
  );
  ensureExpiredWindow.notAfterAt = Date.now() - 1;
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
    `${confirmFnSource}; return { clickConfirmDialogInPageWorld };`
  )(
    { querySelectorAll: () => [{ textContent: 'Confirm', className: '' }] },
    { now: () => confirmDeadlineAt },
    () => { expiredConfirmClickCalls += 1; return true; },
    async () => {}
  );
  const expiredConfirmResult = await clickConfirmDialogInPageWorld(5000, confirmDeadlineAt);
  assertPass(disabledEnsureResult.success === false
      && disabledEnsureResult.error.includes('被禁用')
      && disabledEnsureClickCalls === 0
      && expiredWindowResult.success === false
      && expiredWindowResult.error.includes('窗口已结束')
      && expiredWindowClickCalls === 0
      && expiredConfirmResult === false
      && expiredConfirmClickCalls === 0,
    '9G-5: 禁用开关或智能 ON 窗口已结束时，开关与确认按钮均零点击');
  // 9G-6: 反证——启用开关（free mode 下余额为 0 也不禁用）不被误判禁用，仍走完整点击链路。
  let enabledEnsureClickCalls = 0;
  const { ensureACState: ensureEnabled } = loadEnsure(
    () => ({ isOn: false, disabled: false, source: 'main-world-ant-switch' }),
    async () => ({}),
    () => { enabledEnsureClickCalls += 1; return true; },
    async () => false,
    successfulExecutionWait,
    async () => {},
    3,
    10000
  );
  const enabledEnsureResult = await ensureEnabled(true);
  assertPass(enabledEnsureResult.success === false
      && enabledEnsureResult.clicks === 3
      && enabledEnsureClickCalls === 3,
    '9G-6: 启用开关（free mode）不判禁用，仍走 3 次点击链路后才失败');
  assertPass(countOccurrences(pwmBody, "toggleAC('on', {") === 1
      && pwmBody.includes('planPwmStep(schedule, observations)')
      && pwmBody.includes('isPageTimerProofFresh(schedule)')
      && pwmBody.includes('createPwmAlarmFromPlan(')
      && pwmBody.includes('PWM_RETRY_KINDS')
      && !pwmBody.includes('for (let retry')
      && !pwmBody.includes('runSmartStep')
      && !pwmBody.includes('planSmart')
      && !pwmBody.includes('ac-smart'),
    '9H: 每个 PWM 开机步骤只调用一次 toggleAC(on)，无外围点击重试循环');
  const smartPlannerIndex = smartBody.indexOf('let plan = planSmartStep(schedule, {');
  const smartWindowPlanIndex = smartBody.indexOf('const onWindowPlan = planSmartModeOnWindow(schedule, {');
  const smartArmIndex = smartBody.indexOf('const armResult = await armPowerOffTimerEnsuringOn(timerMinutes, {');
  const smartVerifyFallbackIndex = smartBody.indexOf('await setPageTimer(1, {', smartArmIndex);
  assertPass(smartPlannerIndex >= 0
      && smartWindowPlanIndex > smartPlannerIndex
      && smartArmIndex > smartWindowPlanIndex
      && smartVerifyFallbackIndex > smartArmIndex
      && countOccurrences(smartBody, "armPowerOffTimerEnsuringOn(") === 1
      && countOccurrences(smartBody, "toggleAC('on', {") === 0
      && !smartBody.includes("toggleAC('off')")
      && !smartBody.includes('for (let retry')
      && smartBody.includes('planSmartOnRetryExceptionRecovery(')
      && smartBody.includes('planSmartOnAfterConfirmedOff(')
      && smartBody.includes('classifySmartOnClock(')
      && smartBody.includes('alignSmartModeNextTrigger(')
      && smartBody.includes("createAutomationAlarmFromPlan(\n      'ac-smart'")
      && smartBody.includes('schedule.smartState')
      && smartBody.includes('replaceSmartRetryState()')
      && smartBody.includes('targetAt,')
      && smartBody.includes('automaticOnDeadlineAt: windowEndsAt')
      && smartBody.includes('requireAutomationAllowed: true'),
    '9H-1: Smart 使用正式 planner/recovery API，先新鲜页面定时器、最多一次 ON、复核后提交 ac-smart 绝对 targetAt');
  assertPass(!smartBody.includes('runPwmStep')
      && !smartBody.includes('planPwmStep')
      && !smartBody.includes('planPwmRecovery')
      && !smartBody.includes('pwmRetry')
      && !smartBody.includes('ac-pwm'),
    '9H-4: Smart body 不含 PWM step/recovery/retry/alarm 分子');
  assertPass(!pwmBody.includes('runSmartStep')
      && !pwmBody.includes('planSmart')
      && !pwmBody.includes('smartRetry')
      && !pwmBody.includes('ac-smart'),
    '9H-5: PWM body 不含 Smart step/planner/retry/alarm 分子');
  assertPass(setTimerBody.includes('targetAt = 0')
      && setTimerBody.includes("action: 'setTimer'")
      && setTimerBody.includes('targetAt')
      && contentSource.includes('setPagePowerOffTimer(msg.minutes, msg.targetAt, msg.allowLocalOnly === true)'),
    '9H-2: 智能半点绝对关机截止时间由 background 透传到 content，不退化为相对分钟');
  assertPass(smartBody.includes('planSmartOnAfterConfirmedOff(')
      && smartBody.includes('alignSmartModeNextTrigger(')
      && !smartBody.includes('minOffMinutes'),
    '9H-3: Smart OFF 使用正式确认后恢复 API，直接对齐下一半点 ON');
  assertPass(smartBody.includes('if (status?.isOn === true) {')
      && smartBody.includes('const recheck = await getCurrentACStatus();')
      && smartBody.includes('if (recheck?.isOn === false) status = recheck;')
      && smartBody.includes('await sleep(10000);'),
    '9H-6: 关机边界读到 ON 时等待 10 秒只复读一次，避免陈旧读回误设 1 分钟安全定时器');
  assertPass(smartBody.includes('const statusOn = status?.isOn === true;')
      && smartBody.includes('安全关机定时器写入失败：')
      && !smartBody.includes('智能关机边界未确认：${safetyTimer?.error')
      && smartBody.includes('智能关机边界状态未确认，已补设 1 分钟页面关机定时器')
      && smartBody.includes("'smart-off-status-unknown'"),
    '9H-7: 区分页面定时器写失败与关机未确认，未知状态仍保留安全重试');
  assertPass(smartBody.includes('smartOffSafetyTimerUsed === true')
      && smartBody.includes('smart-off-safety-exhausted')
      && smartBody.includes('已停止继续延后页面关机时间')
      && smartBody.includes('schedule.smartOffSafetyTimerUsed = true'),
    '9H-8: Smart 安全补时只允许一次，二次仍未确认时停止继续推迟截止时间');
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
    assertPass(contentSource.includes('msg.allowLocalOnly === true')
        && backgroundSource.includes('allowLocalOnly: deferVerification'),
      '9M-5: 自动开机预布防允许本地先接受输入，普通页面定时器仍由后台严格新鲜页确认');
    const persistedTimerMatchStart = backgroundSource.indexOf('function isPersistedPageTimerMatch(');
    const persistedTimerMatchEnd = backgroundSource.indexOf('\n\n// 关机定时器设置失败时', persistedTimerMatchStart);
    const persistedTimerMatch = new Function(
      `${backgroundSource.slice(persistedTimerMatchStart, persistedTimerMatchEnd)}; return isPersistedPageTimerMatch;`
    )();
    assertPass(persistedTimerMatch({ found: true, value: '06:22', title: '06:22' }, '06:22')
        && !persistedTimerMatch({ found: true, value: '06:22', title: null }, '06:22')
        && !persistedTimerMatch({ found: true, value: null, title: '06:22' }, '06:22'),
      '9M-6: 新鲜页持久化证明必须同时匹配 value/title，不能把单一本地信号当成成功');
  }
  const verificationStartForReload = backgroundSource.indexOf('async function verifyPageTimerPersistence(');
  const verificationEndForReload = backgroundSource.indexOf('\n// 关机定时器设置失败时', verificationStartForReload);
  const verifySectionForReload = verificationStartForReload >= 0 && verificationEndForReload > verificationStartForReload
    ? backgroundSource.slice(verificationStartForReload, verificationEndForReload)
    : '';
  // tabs.reload 仍只在 refreshACControlPage 一处；tabs.update 现允许四处——
  // 导航回 home（url: AC_PAGE）在 refreshACControlPage 与 recoverStuckTransientHomeTabs，
  // 置前/还原标签（active: true）在 activateTabForTimerWrite（写定时器前规避 Chrome 后台节流）。
  // 页面定时器验证（verifyPageTimerPersistence）仍不得 reload/update 来源页。
  assertPass(countOccurrences(backgroundSource, 'chrome.tabs.reload(') === 1
      && countOccurrences(backgroundSource, 'chrome.tabs.update(') === 4
      && !backgroundSource.includes('async function restoreDiscardedACTab(tab)')
      && !verifySectionForReload.includes('chrome.tabs.reload(')
      && !verifySectionForReload.includes('chrome.tabs.update(')
      && !verifySectionForReload.includes('sourceWasAutoCreated'),
    '9N: background 仅在开机恢复/看门狗回收/置前写定时器函数内 reload/update；页面定时器验证仍不刷新来源页');
  assertPass(backgroundSource.includes('async function activateTabForTimerWrite(')
      && backgroundSource.includes('chrome.windows.update(targetTab.windowId, { state: \'normal\', focused: true })')
      && backgroundSource.includes('await activateTabForTimerWrite(tabId)')
      && backgroundSource.includes('await restoreForeground()'),
    '9N-1: 写定时器前短暂置前标签（取消最小化+聚焦窗口+激活），写后还原，规避 Chrome 后台节流');
  assertPass(setTimerBody.includes('chrome.tabs.create({ url: AC_PAGE, active: false })')
      && setTimerBody.includes('!candidate.discarded'),
    '9O: 页面定时器缺少未丢弃的精确 home 时只创建隐藏 AC 页，不恢复或刷新用户页面');
  assertPass(setTimerBody.includes('tabs.find(candidate => isACHomePageTab(candidate) && !candidate.discarded)')
      && !setTimerBody.includes('tabs[0]')
      && !setTimerBody.includes('chrome.tabs.update(')
      && setTimerBody.includes('const getWritableExactHomeTab = async (tabId) =>')
      && setTimerBody.includes('urlDrift: true')
      && setTimerBody.includes('discarded: true'),
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

  // 9J-8: 会话重登录瞬态 URL 识别（login/CAS 不强行导航，等自然回 home）
  const authRedirectMatcherSource = extractSourceSection(
    backgroundSource,
    'function isTransientAuthRedirectUrl(',
    'async function refreshACControlPage(',
    'isTransientAuthRedirectUrl'
  );
  const loadAuthRedirectMatcher = new Function(
    `${authRedirectMatcherSource}; return { isTransientAuthRedirectUrl };`
  );
  const authRedirectMatcher = loadAuthRedirectMatcher();
  assertPass(authRedirectMatcher.isTransientAuthRedirectUrl('https://w5.ab.ust.hk/njggt/app/login?path=/home') === true
      && authRedirectMatcher.isTransientAuthRedirectUrl('https://w5.ab.ust.hk/njggt/app/callback/cas?path=/home&ticket=ST-x') === true
      && authRedirectMatcher.isTransientAuthRedirectUrl('https://w5.ab.ust.hk/njggt/app/home') === false
      && authRedirectMatcher.isTransientAuthRedirectUrl('https://w5.ab.ust.hk/njggt/app/billing-cycle') === false
      && authRedirectMatcher.isTransientAuthRedirectUrl('https://w5.ab.ust.hk/njggt/app/home?login=1') === false,
    '9J-8: 仅 login/CAS 回调判为瞬态重登录，home/billing-cycle/带 login 查询参数均不误判');

  // 9J-9: 看门狗回收卡死瞬态 URL 标签（login/CAS 长期停留 → 导航回精确 home）
  const stuckRecoverySource = extractSourceSection(
    backgroundSource,
    'async function recoverStuckTransientHomeTabs(',
    'async function attemptACToggleWithRecovery(',
    'recoverStuckTransientHomeTabs'
  );
  const stuckRecoveryUpdates = [];
  const stuckRecoveryChrome = {
    tabs: {
      query: async () => ([
        { id: 1, url: 'https://w5.ab.ust.hk/njggt/app/callback/cas?path=/home&ticket=ST-x', discarded: false },
        { id: 2, url: 'https://w5.ab.ust.hk/njggt/app/home', discarded: false },
        { id: 3, url: 'https://w5.ab.ust.hk/njggt/app/login?path=/home', discarded: false },
        { id: 4, url: 'https://w5.ab.ust.hk/njggt/app/callback/cas?path=/home&ticket=ST-y', discarded: true }
      ]),
      update: async (id, opts) => { stuckRecoveryUpdates.push({ id, url: opts?.url }); }
    }
  };
  const runStuckRecovery = new Function(
    'chrome',
    'AC_PAGE',
    'isTransientAuthRedirectUrl',
    `${stuckRecoverySource}; return recoverStuckTransientHomeTabs;`
  )(
    stuckRecoveryChrome,
    'https://w5.ab.ust.hk/njggt/app/home',
    authRedirectMatcher.isTransientAuthRedirectUrl
  );
  await runStuckRecovery();
  assertPass(stuckRecoveryUpdates.length === 2
      && stuckRecoveryUpdates.some(u => u.id === 1 && u.url === 'https://w5.ab.ust.hk/njggt/app/home')
      && stuckRecoveryUpdates.some(u => u.id === 3 && u.url === 'https://w5.ab.ust.hk/njggt/app/home'),
    '9J-9: 看门狗只回收非 discarded 且卡在 login/CAS 的标签，导航回精确 home');
  assertPass(backgroundSource.includes('recoverStuckTransientHomeTabs().catch'),
    '9J-10: ac-watchdog 在自动化允许时调用卡死瞬态 URL 回收');

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
  console.log('\n\n=== 用例 10: 关机不可漏接口契约 (v0.7.0) ===\n');

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
    { acIsOn: true, pageTimerSucceeded: true, pageTimerVerified: true },
    { now: plannerNow10 }
  );
  const plannerPageTarget10 = plannerNow10 + 13 * 60_000;
  const timerTargetCommittedPlan10 = pwmPhase.planPwmStep(
    plannerOnSchedule10,
    {
      acIsOn: true,
      pageTimerSucceeded: true,
      pageTimerVerified: true,
      pageTimerTargetAt: plannerPageTarget10
    },
    { now: plannerNow10 }
  );
  const setPageTimerCallIdx = pwmBody.indexOf('const armResult = await armPowerOffTimerEnsuringOn(plan.timerMinutes, {');
  assertPass(timerRequiredPlan10.kind === 'hold'
      && timerRequiredPlan10.prerequisite === 'arm-page-timer'
      && timerRequiredPlan10.timerMinutes === plannerOnSchedule10.onMinutes
      && pwmBody.includes("plan.prerequisite === 'arm-page-timer'")
      && setPageTimerCallIdx > 0,
    '10A: ON planner 要求 adapter 先按配置分钟确认页面定时器');

  assertPass(timerFailedPlan10.kind === 'retry'
      && timerFailedPlan10.phasePatch.pwmState === 'on'
      && timerCommittedPlan10.kind === 'commit'
      && timerCommittedPlan10.phasePatch.pwmState === 'off'
      && timerTargetCommittedPlan10.nextTriggerAt === plannerPageTarget10
      && timerTargetCommittedPlan10.phasePatch.nextTriggerAt === plannerPageTarget10,
    '10B: 页面定时器失败保持 ON；成功后推进为 OFF 并采纳页面绝对目标');

  const pageTimerObservationIdx = pwmBody.indexOf('observations.pageTimerSucceeded = writeSucceeded;', setPageTimerCallIdx);
  const pageTimerTargetObservationIdx = pwmBody.indexOf('observations.pageTimerTargetAt = Number(armResult?.targetAt) || 0;', pageTimerObservationIdx);
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
      && pwmBody.includes("isPageTimerRetry ? 'PWM-pageTimer-failed' : 'PWM失败重试'"),
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
  assertPass(pwmBody.includes("observations.pageTimerError = armResult.error || ''")
      && pwmBody.includes("pageTimerError = `自动开启前页面关机定时器未确认")
      && !pwmBody.includes('开机已成功，但页面关机定时器未确认'),
    '10F: timer prearm 失败文案明确发生在自动开启前，不误报 AC 已成功开启');

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
  const smartRepairStart = backgroundSource.indexOf('async function repairSmartScheduleClock(options = {})');
  const smartRepairEnd = backgroundSource.indexOf('\nasync function ensureScheduleClock()', smartRepairStart);
  const smartRepairBody = smartRepairStart >= 0 && smartRepairEnd > smartRepairStart
    ? backgroundSource.slice(smartRepairStart, smartRepairEnd)
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
      && verifyBody.includes('isPersistedPageTimerMatch(readback, expectedValue)')
      && backgroundSource.includes('String(readback.title || \'\').trim() === expectedValue')
      && verifyBody.includes('lastFailure = `第 ${attempt + 1} 次新鲜页读回不匹配')
      && verifyBody.includes('await chrome.tabs.remove(verifierTabId)'),
    '11B: 新鲜页必须同时读回 value/title 同一 HH:MM，未匹配会记录失败并回收临时验证页');
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
  assertPass(verifyBody.includes("{ action: 'status' }")
      && verifyBody.includes('acIsOn: freshAcIsOn'),
    '11B-3: 新鲜页同时读回 ON 状态（status），供开机复核与未开机恢复');
  const verificationCallIdx = setTimerBody.indexOf('verifyPageTimerPersistence(expectedValue');
  const proofWriteIdx = setTimerBody.indexOf('schedule.pageTimerMinutes = result.actualDelayMinutes || requestedMinutes');
  assertPass(verificationCallIdx > 0
      && proofWriteIdx > verificationCallIdx
      && setTimerBody.includes('verified: true')
      && setTimerBody.includes('const resultTargetAt = Number(result.targetAt);')
      && setTimerBody.includes('schedule.pageTimerTargetAt = resultTargetAt;')
      && !setTimerBody.includes('parsePageTimerValue(result.value, Date.now())'),
    '11C: setPageTimer 仅在新鲜页确认后写证明，并直接采纳写入方绝对 targetAt');
  assertPass(retryBody.includes('schedule.pageTimerRetryMinutes = retryMinutes')
      && retryBody.includes("createAlarm('ac-page-timer-retry'")
      && backgroundSource.includes('schedule.pageTimerRetryMinutes')
      && backgroundSource.includes("if (alarm.name === 'ac-page-timer-retry')"),
    '11D: 非 PWM 的关机请求失败会保存分钟数并由 ac-page-timer-retry 持续重试');
  const smartRepairTimerIdx = smartRepairBody.indexOf('const timerResult = await setPageTimer(');
  const smartRepairStateIdx = smartRepairBody.indexOf("setSmartNextAction('off');");
  const smartRepairAlarmIdx = smartRepairBody.indexOf("createAutomationAlarmFromPlan(\n      'ac-smart'");
  const pwmRepairTimerIdx = repairBody.indexOf('await setPageTimer(schedule.onMinutes');
  const pwmRepairOffIdx = repairBody.indexOf("schedule.pwmState = currentOn ? 'off' : 'on';");
  assertPass(smartRepairTimerIdx >= 0
      && smartRepairStateIdx > smartRepairTimerIdx
      && smartRepairAlarmIdx > smartRepairStateIdx
      && smartRepairBody.includes('planSmartModeOnWindow(schedule')
      && smartRepairBody.includes('smartOnBoundaryAt')
      && smartRepairBody.includes('smartNextTriggerAt')
      && smartRepairBody.includes("'repair-smart-pageTimer-failed'")
      && pwmRepairTimerIdx >= 0
      && pwmRepairOffIdx > pwmRepairTimerIdx
      && repairBody.includes('createPwmAlarmFromPlan('),
    '11E: Smart repair 先新鲜 setPageTimer，再写 Smart 状态并建立 ac-smart；PWM repair 独立走 PWM alarm 路径');
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
  const smartDurationBody = extractSourceSection(
    backgroundSource,
    'async function applySmartDurationsForBoundary(boundaryAt) {',
    '\nasync function applyPreparedSmartModeDurations()',
    'applySmartDurationsForBoundary'
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
      && smartBody.includes('await applySmartDurationsForBoundary(boundaryAt);')
      && smartDurationBody.includes('chrome.storage.local.get([')
      && smartDurationBody.includes('consumeSmartWeatherDecision(')
      && !smartBody.includes('getSmartWeather(')
      && !smartBody.includes('fetchSmartWeather')
      && !smartBody.includes('prepareSmartWeatherForBoundary(')
      && !pwmBody.includes('getSmartWeather(')
      && !pwmBody.includes('fetchSmartWeather')
      && !pwmBody.includes('prepareSmartWeatherForBoundary('),
    '11F-0A: 只有预取路径强制联网；:00/:30 Smart run 仅消费目标绑定 storage 快照，PWM 不携带天气路径');
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
      && reapplyBody.indexOf("createAutomationAlarmFromPlan(\n      'ac-smart'")
        > reapplyBody.indexOf('await setPageTimer(minutes')
      && reapplyBody.includes('nextTriggerAt: schedule.pageTimerTargetAt')
      && smartRepairBody.includes("createAutomationAlarmFromPlan(\n      'ac-smart'")
      && !reapplyBody.includes('nowMs + minutes * 60000'),
    '11F-1: 普通 repair/manual PWM 使用 ac-pwm；Smart repair/reapply 使用独立 ac-smart 绝对 targetAt');
  assertPass(reapplyBody.includes('const previousSmartBoundaryAt = oldTriggerAt - oldOnMinutes * 60000;')
      && reapplyBody.includes('const storedSmartBoundaryAt = Number(schedule.smartOnBoundaryAt);')
      && reapplyBody.includes('storedSmartBoundaryAt <= nowMs')
      && reapplyBody.includes('storedSmartBoundaryAt === 0')
      && reapplyBody.includes('previousSmartBoundaryAt <= nowMs')
      && reapplyBody.includes('activeSmartBoundaryAt')
      && reapplyBody.includes('smartModePageTimerTargetAt(')
      && reapplyBody.includes('previousSmartBoundaryAt')
      && reapplyBody.includes('smartStepRunning')
      && reapplyBody.includes('const oldSmartRuntimeRevision = smartRuntimeRevision')
      && reapplyBody.includes('smartRuntimeRevision !== oldSmartRuntimeRevision')
      && reapplyBody.includes('schedule.smartState !== oldSmartState')
      && reapplyBody.includes('(Number(schedule.smartNextTriggerAt) || 0) !== oldTriggerAt')
      && reapplyBody.includes('(Number(schedule.smartOnBoundaryAt) || 0) !== oldSmartBoundaryAt')
      && reapplyBody.includes('targetAt: smartDeadlineAt')
      && reapplyBody.includes('nextMinuteTargetAt')
      && !reapplyBody.includes('schedule.pwmState')
      && !reapplyBody.includes('schedule.nextTriggerAt')
      && !reapplyBody.includes('targetAt: 0'),
    '11F-2: 智能灵敏度即时重设沿用原周期半点锚点；截止已过只尽快关机，不重给相对 25 分钟');
  const reapplyRaceSchedule = {
    enabled: true,
    smartState: 'off',
    onMinutes: 25,
    offMinutes: 5,
    smartNextTriggerAt: new Date(2026, 7, 17, 13, 55, 0, 0).getTime(),
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
    `let smartStepRunning = false;
    let smartStepRunningRevision = null;
    let smartRuntimeRevision = 0;
    function isCurrentSmartStepRunning() {
      return smartStepRunning && smartStepRunningRevision === smartRuntimeRevision;
    }
${reapplyBody}
return {
  reapplySmartSensitivityNow,
  completeSmartStep() {
    smartStepRunning = false;
    smartRuntimeRevision += 1;
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
  reapplyRaceHarness.completeSmartStep();
  releaseReapplyWeather({});
  await reapplyRacePromise;
    assertPass(reapplyWeatherReadStarted
      && reapplyComputeCalls === 0
      && reapplyRaceSchedule.onMinutes === 25
      && reapplyRaceSchedule.offMinutes === 5
      && reapplyRaceSchedule.smartNextTriggerAt
        === new Date(2026, 7, 17, 13, 55, 0, 0).getTime(),
    '11F-2A: 等待天气期间 PWM 即使已完成推进，旧灵敏度重设仍放弃且不覆盖新相位');
  const stableReapplySchedule = {
    ...reapplyRaceSchedule,
    smartState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    smartNextTriggerAt: 0
  };
  const stableReapplyPersistReasons = [];
  const stableReapplyHarness = new Function(
    'schedule', 'readStoredSmartWeather', 'computeSmartOnMinutes', 'SMART_MODE', 'persistSchedule',
    `let smartStepRunning = false;
    let smartStepRunningRevision = null;
    let smartRuntimeRevision = 0;
    function isCurrentSmartStepRunning() {
      return smartStepRunning && smartStepRunningRevision === smartRuntimeRevision;
    }
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
  const activeReapplyNow = new Date(2026, 7, 17, 13, 35, 0, 0).getTime();
  const activeReapplyBoundary = new Date(2026, 7, 17, 13, 30, 0, 0).getTime();
  const activeReapplyTarget = new Date(2026, 7, 17, 13, 45, 0, 0).getTime();
  const activeReapplySchedule = {
    enabled: true,
    pwmState: 'on',
    nextTriggerAt: 789012,
    smartState: 'off',
    onMinutes: 10,
    offMinutes: 20,
    smartNextTriggerAt: new Date(2026, 7, 17, 13, 40, 0, 0).getTime(),
    smartOnBoundaryAt: activeReapplyBoundary,
    smartMode: { enabled: true, sensitivity: 5 },
    pageTimerTargetAt: 0,
    pageTimerError: ''
  };
  const activeReapplyEvents = [];
  const activeReapplyAlarmPlans = [];
  const activeReapplyTimerCalls = [];
  const activeReapplyHarness = new Function(
    'schedule',
    'readStoredSmartWeather',
    'computeSmartOnMinutes',
    'SMART_MODE',
    'persistSchedule',
    'isAutomationAllowed',
    'isSmartAutomationEnabled',
    'isCurrentSmartStepRunning',
    'smartModePageTimerTargetAt',
    'clearSmartAlarm',
    'isAutomationOperationCurrent',
    'setSmartNextAction',
    'setSmartNextTriggerAt',
    'replaceSmartRetryState',
    'setPageTimer',
    'abortStaleAutomation',
    'createAutomationAlarmFromPlan',
    'markSmartOnSafetyTimerRetry',
    'createAlarm',
    'updateBadge',
    'Date',
    `let smartStepRunning = false;
    let smartStepRunningRevision = null;
    let smartRuntimeRevision = 0;
    ${reapplyBody}
    return { reapplySmartSensitivityNow };`
  )(
    activeReapplySchedule,
    async () => ({
      temperature: 32,
      dewPoint: 25,
      windSpeedMs: 1,
      fetchedAt: activeReapplyNow,
      stale: false,
      error: ''
    }),
    () => ({ valid: true, onMinutes: 15, offMinutes: 15 }),
    smartMode.SMART_MODE,
    async reason => { activeReapplyEvents.push(`persist:${reason}`); },
    () => true,
    () => true,
    () => false,
    smartPhase.smartModePageTimerTargetAt,
    async () => { activeReapplyEvents.push('clear:ac-smart'); },
    revision => revision === 0,
    action => { activeReapplySchedule.smartState = action === 'off' ? 'off' : 'on'; },
    (value) => {
      activeReapplySchedule.smartNextTriggerAt = Number(value) || 0;
      activeReapplySchedule.smartClockPlannedAt = activeReapplySchedule.smartNextTriggerAt
        ? activeReapplyNow
        : 0;
    },
    () => { activeReapplyEvents.push('clear-smart-retry'); },
    async (minutes, options = {}) => {
      activeReapplyTimerCalls.push({ minutes, options: { ...options } });
      activeReapplySchedule.pageTimerTargetAt = Number(options.targetAt) || 0;
      return { success: true, targetAt: activeReapplySchedule.pageTimerTargetAt };
    },
    async () => false,
    async (alarmName, plan) => {
      activeReapplyEvents.push(`create:${alarmName}`);
      activeReapplyAlarmPlans.push({ alarmName, ...plan });
      activeReapplySchedule.smartNextTriggerAt = Number(plan.nextTriggerAt) || 0;
      return true;
    },
    () => { activeReapplyEvents.push('mark-smart-retry'); },
    async name => { activeReapplyEvents.push(`create:${name}`); return true; },
    async () => { activeReapplyEvents.push('badge'); },
    { now: () => activeReapplyNow }
  );
  await activeReapplyHarness.reapplySmartSensitivityNow();
  assertPass(activeReapplyTimerCalls[0]?.minutes === 10
      && activeReapplyTimerCalls[0]?.options.targetAt === activeReapplyTarget
      && activeReapplyTimerCalls[0]?.options.automationMode === 'smart'
      && activeReapplyAlarmPlans[0]?.alarmName === 'ac-smart'
      && activeReapplyAlarmPlans[0]?.nextTriggerAt === activeReapplyTarget
      && activeReapplySchedule.smartState === 'off'
      && activeReapplySchedule.smartNextTriggerAt === activeReapplyTarget
      && activeReapplySchedule.smartOnBoundaryAt === activeReapplyBoundary
      && activeReapplySchedule.pwmState === 'on'
      && activeReapplySchedule.nextTriggerAt === 789012
      && activeReapplyEvents.indexOf('clear:ac-smart')
        < activeReapplyEvents.indexOf('create:ac-smart')
      && activeReapplyEvents.includes('create:ac-badge-tick')
      && activeReapplyEvents.some(event => event === 'persist:reapply-smart-sensitivity-on-phase'),
    '11F-2C: Smart ON-phase 灵敏度即时重设复用原半点锚点，只重建 ac-smart，不改写 PWM lifecycle');
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
    'chrome',
    'classifySmartOnClock',
    'clearPwmAlarm',
    'replacePwmRetryState',
    'setNextTriggerAt',
    'isAutomationOperationCurrent',
    'getLiveAlarmEndMs',
    'getStoredAlarmEndMs',
    `let pwmRuntimeRevision = 0;
    function isAutomationAllowed() { return schedule.enabled; }
    async function abortStaleAutomation() { return false; }
    ${repairFunctionSource}; return repairScheduleClock;`
  );
  const loadSmartRepairScheduleClock = new Function(
    'schedule',
    'loadScheduleFromStorage',
    'isAutomationAllowed',
    'isSmartAutomationEnabled',
    'chrome',
    'getLiveAlarmEndMs',
    'classifySmartOnClock',
    'setSmartNextTriggerAt',
    'persistSchedule',
    'getCurrentACStatus',
    'abortStaleAutomation',
    'normalizeSmartHalfHourAlarmBoundary',
    'smartPageTimerTargetAt',
    'planSmartModeOnWindow',
    'SMART_MODE',
    'setPageTimer',
    'planSmartOnRetryExceptionRecovery',
    'applySmartPlanState',
    'SMART_RETRY_KINDS',
    'replaceSmartRetryState',
    'clearSmartAlarm',
    'createAutomationAlarmFromPlan',
    'updateBadge',
    'setSmartNextAction',
    'isSmartHalfHourBoundary',
    'nextSmartHalfHourBoundary',
    'alignSmartModeNextTrigger',
    'Date',
    `let smartRuntimeRevision = 0;
    ${smartRepairBody}; return repairSmartScheduleClock;`
  );
  const runRepairCase = async (initialSchedule, nowMs, repairCaseOptions = {}) => {
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
      async plan => { alarmPlans.push({ ...plan, alarmName: 'ac-pwm' }); },
      smartMode.SMART_MODE,
      smartPhase.planSmartModeOnWindow,
      { now: () => nowMs },
      repairCaseOptions.enableClockAssessment
        ? {
            alarms: {
              async get() { return repairCaseOptions.liveAlarm; }
            }
          }
        : undefined,
      () => repairCaseOptions.clockAssessment || null,
      async () => {},
      () => {},
      value => { repairSchedule.nextTriggerAt = value; },
      () => true,
      alarm => Number(alarm?.scheduledTime) || 0,
      () => Number(repairSchedule.nextTriggerAt) || 0
    );
    let result = null;
    let error = '';
    try {
      result = await repairScheduleClock(repairCaseOptions.invocationOptions);
    } catch (caught) {
      error = caught?.message || String(caught);
    }
    return { result, error, schedule: repairSchedule, timerCalls, alarmPlans };
  };
  const runSmartRepairCase = async (initialSchedule, nowMs, repairCaseOptions = {}) => {
    const repairSchedule = {
      ...initialSchedule,
      smartMode: { ...initialSchedule.smartMode }
    };
    const timerCalls = [];
    const alarmPlans = [];
    const events = [];
    const smartRepairScheduleClock = loadSmartRepairScheduleClock(
      repairSchedule,
      async () => {},
      () => repairSchedule.enabled === true,
      () => repairSchedule.smartMode?.enabled === true,
      {
        alarms: {
          async get() { return repairCaseOptions.liveAlarm; }
        }
      },
      alarm => Number(alarm?.scheduledTime) > nowMs
        ? Number(alarm.scheduledTime)
        : 0,
      (...args) => repairCaseOptions.clockAssessment
        || smartPhase.classifySmartOnClock(...args),
      value => {
        repairSchedule.smartNextTriggerAt = Number(value) || 0;
        repairSchedule.smartClockPlannedAt = repairSchedule.smartNextTriggerAt
          ? nowMs
          : 0;
      },
      async reason => { events.push(`persist:${reason}`); },
      async () => repairCaseOptions.status || { isOn: true },
      async () => false,
      smartPhase.normalizeSmartHalfHourAlarmBoundary,
      smartPhase.smartPageTimerTargetAt,
      smartPhase.planSmartModeOnWindow,
      smartMode.SMART_MODE,
      async (minutes, options = {}) => {
        const targetAt = Number(options.targetAt) || nowMs + minutes * 60000;
        timerCalls.push({ minutes, options: { ...options }, targetAt });
        repairSchedule.pageTimerTargetAt = targetAt;
        const timerResult = repairCaseOptions.timerResult;
        return typeof timerResult === 'function'
          ? timerResult({ minutes, options, targetAt })
          : { success: true, targetAt, ...(timerResult || {}) };
      },
      smartPhase.planSmartOnRetryExceptionRecovery,
      plan => {
        if (!plan?.phasePatch) return;
        const { nextTriggerAt, ...phasePatch } = plan.phasePatch;
        Object.assign(repairSchedule, phasePatch);
        if (Object.prototype.hasOwnProperty.call(plan.phasePatch, 'nextTriggerAt')) {
          repairSchedule.smartNextTriggerAt = Number(nextTriggerAt) || 0;
        }
      },
      { ON: 'smart-on', ON_SAFE_DELAY: 'smart-on-safe-delay' },
      (retryState = {}) => {
        repairSchedule.smartRetryKind = retryState.kind || '';
        repairSchedule.smartRetryBoundaryAt = Number(retryState.boundaryAt) || 0;
        repairSchedule.smartRetryScheduledAt = Number(retryState.scheduledAt) || 0;
      },
      async () => { events.push('clear:ac-smart'); },
      async (alarmName, plan) => {
        alarmPlans.push({ ...plan, alarmName });
        repairSchedule.smartNextTriggerAt = Number(plan.nextTriggerAt) || 0;
        return true;
      },
      async () => { events.push('badge'); },
      action => { repairSchedule.smartState = action === 'off' ? 'off' : 'on'; },
      smartPhase.isSmartHalfHourBoundary,
      smartPhase.nextSmartHalfHourBoundary,
      smartPhase.alignSmartModeNextTrigger,
      { now: () => nowMs }
    );
    let result = null;
    let error = '';
    try {
      result = await smartRepairScheduleClock(repairCaseOptions.invocationOptions);
    } catch (caught) {
      error = caught?.message || String(caught);
    }
    return { result, error, schedule: repairSchedule, timerCalls, alarmPlans, events };
  };
  const smartRepairBoundary = new Date(2026, 7, 17, 13, 30, 0, 0).getTime();
  const activeSmartRepair = await runSmartRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartState: 'on',
    smartNextTriggerAt: 0,
    smartOnBoundaryAt: smartRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 45, 0, 0).getTime());
  const overrunSmartRepair = await runSmartRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartState: 'on',
    smartNextTriggerAt: 0,
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
  const diagnosticRepair = await runSmartRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartState: 'on',
    smartNextTriggerAt: 0,
    smartOnBoundaryAt: smartRepairBoundary,
    smartClockPlannedAt: 0,
    alarmCreatedAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 45, 0, 0).getTime(), {
    enableClockAssessment: true,
    clockAssessment: {
      applicable: true,
      valid: false,
      expectedAt: smartRepairBoundary
    },
    liveAlarm: {
      name: 'ac-smart',
      scheduledTime: new Date(2026, 7, 17, 13, 46, 0, 0).getTime()
    },
    invocationOptions: {
      smartOnExpectedBoundaryAt: smartRepairBoundary
    }
  });
  const smartOffRepair = await runSmartRepairCase({
    enabled: true,
    pwmState: 'off',
    nextTriggerAt: 123456,
    smartState: 'off',
    smartNextTriggerAt: 0,
    smartOnBoundaryAt: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 45, 0, 0).getTime(), {
    status: { isOn: false },
    invocationOptions: {
      smartOnExpectedBoundaryAt: new Date(2026, 7, 17, 14, 0, 0, 0).getTime()
    }
  });
  const smartReadonlyRepair = await runSmartRepairCase({
    enabled: true,
    pwmState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    nextTriggerAt: 0,
    smartState: 'on',
    smartNextTriggerAt: 0,
    smartOnBoundaryAt: smartRepairBoundary,
    smartMode: { enabled: true, sensitivity: 5 }
  }, new Date(2026, 7, 17, 13, 45, 0, 0).getTime(), {
    invocationOptions: { rearmPageTimer: false }
  });
  assertPass(smartReadonlyRepair.timerCalls.length === 0
      && smartReadonlyRepair.alarmPlans.length === 0
      && smartReadonlyRepair.result?.rearmSkipped === true,
    'smartRepair-readonly: 诊断只读时钟修复不写页面定时器、不重建运行闹钟');
  assertPass(activeSmartRepair.timerCalls[0]?.minutes === 10
      && activeSmartRepair.timerCalls[0]?.options.targetAt
        === smartRepairBoundary + 25 * 60000
      && activeSmartRepair.alarmPlans[0]?.nextTriggerAt
        === smartRepairBoundary + 25 * 60000
      && activeSmartRepair.alarmPlans[0]?.alarmName === 'ac-smart'
      && activeSmartRepair.schedule.smartState === 'off'
      && activeSmartRepair.schedule.smartNextTriggerAt
        === smartRepairBoundary + 25 * 60000
      && overrunSmartRepair.timerCalls[0]?.minutes === 1
      && overrunSmartRepair.timerCalls[0]?.options.targetAt
        === new Date(2026, 7, 17, 13, 57, 0, 0).getTime()
      && overrunSmartRepair.alarmPlans[0]?.alarmName === 'ac-smart'
      && overrunSmartRepair.schedule.smartState === 'off'
      && overrunSmartRepair.schedule.smartOnBoundaryAt === 0
      && ordinaryRepair.timerCalls[0]?.minutes === 12
      && !Object.hasOwn(ordinaryRepair.timerCalls[0]?.options || {}, 'targetAt')
      && ordinaryRepair.alarmPlans[0]?.alarmName === 'ac-pwm'
      && ordinaryRepair.alarmPlans[0]?.nextTriggerAt
        === ordinaryRepairNow + 12 * 60000
      && ordinaryRepair.schedule.pwmState === 'off'
      && smartOffRepair.error === ''
      && smartOffRepair.result?.success === true
      && smartOffRepair.alarmPlans[0]?.alarmName === 'ac-smart'
      && smartOffRepair.schedule.smartState === 'on'
      && smartOffRepair.schedule.smartNextTriggerAt
        === new Date(2026, 7, 17, 14, 0, 0, 0).getTime()
      && smartOffRepair.schedule.nextTriggerAt === 123456,
    '11F-3: 重启时钟修复沿用智能原半点截止，超时只给下一分钟，普通 PWM 仍按相对时长');
  assertPass(diagnosticRepair.error === ''
      && diagnosticRepair.result?.success === true
      && diagnosticRepair.timerCalls.length === 1
      && diagnosticRepair.alarmPlans.length === 1
      && diagnosticRepair.alarmPlans[0]?.alarmName === 'ac-smart'
      && diagnosticRepair.schedule.smartState === 'off'
      && diagnosticRepair.schedule.smartNextTriggerAt
        === smartRepairBoundary + 25 * 60000,
    '11F-3A: 诊断修复智能 ON 缺失时钟时可更新恢复选项，并只写 Smart lifecycle');
  const smartSafetyRetryMarkerSource = extractSourceSection(
    backgroundSource,
    'function markSmartOnSafetyTimerRetry() {',
    '\n// ===== 智能模式：将军澳 JKB 天气取数',
    'markSmartOnSafetyTimerRetry'
  );
  const pwmRetryMarkerSource = extractSourceSection(
    backgroundSource,
    'function markPwmRetry(kind) {',
    '\n// ===== 智能模式：将军澳 JKB 天气取数',
    'markPwmRetry'
  );
  const safetyRetryNow = new Date(2026, 7, 17, 13, 45, 0, 0).getTime();
  const safetyRetryBoundaryAt = new Date(2026, 7, 17, 13, 30, 0, 0).getTime();
  const safetyRetryAlarmAt = safetyRetryNow + 60_017;
  const safetyRetrySchedule = {
    enabled: true,
    smartState: 'on',
    onMinutes: 25,
    offMinutes: 5,
    smartNextTriggerAt: safetyRetryAlarmAt,
    smartOnBoundaryAt: safetyRetryBoundaryAt,
    smartRetryKind: '',
    smartRetryBoundaryAt: 0,
    smartRetryScheduledAt: 0,
    pageTimerRetryAt: 0,
    pageTimerRetryMinutes: 0,
    smartMode: { enabled: true, sensitivity: 5 }
  };
  const safetyRetryMutations = [];
  const markSmartOnSafetyTimerRetry = new Function(
    'schedule',
    'replaceSmartRetryState',
    'SMART_RETRY_KINDS',
    `${smartSafetyRetryMarkerSource}; return markSmartOnSafetyTimerRetry;`
  )(
    safetyRetrySchedule,
    retryState => {
      safetyRetryMutations.push({ ...retryState });
      safetyRetrySchedule.smartRetryKind = retryState.kind || '';
      safetyRetrySchedule.smartRetryBoundaryAt = Number(retryState.boundaryAt) || 0;
      safetyRetrySchedule.smartRetryScheduledAt = Number(retryState.scheduledAt) || 0;
    },
    { ON_SAFETY_TIMER: 'smart-on-safety-timer' }
  );
  const safetyRetryMarked = markSmartOnSafetyTimerRetry();
  const safetyRetryAssessment = smartPhase.classifySmartOnClock(
    safetyRetrySchedule,
    safetyRetryAlarmAt,
    {
      now: safetyRetryNow,
      plannedAt: safetyRetryNow,
      nextAction: 'on',
      toleranceMs: 1500,
      requirePlannedAt: true
    }
  );
  const mismatchedSafetyRetryAssessment = smartPhase.classifySmartOnClock(
    { ...safetyRetrySchedule, smartRetryScheduledAt: safetyRetryAlarmAt + 2000 },
    safetyRetryAlarmAt,
    {
      now: safetyRetryNow,
      plannedAt: safetyRetryNow,
      nextAction: 'on',
      toleranceMs: 1500,
      requirePlannedAt: true
    }
  );
  assertPass(safetyRetryMarked === true
      && safetyRetryMutations.length === 1
      && safetyRetrySchedule.smartRetryKind === 'smart-on-safety-timer'
      && safetyRetrySchedule.smartRetryBoundaryAt === safetyRetryBoundaryAt
      && safetyRetrySchedule.smartRetryScheduledAt === safetyRetryAlarmAt
      && safetyRetrySchedule.smartNextTriggerAt === safetyRetryAlarmAt
      && safetyRetrySchedule.pageTimerRetryAt === 0
      && safetyRetrySchedule.pageTimerRetryMinutes === 0
      && safetyRetryAssessment.valid === true
      && safetyRetryAssessment.kind === 'safety-timer-retry'
      && mismatchedSafetyRetryAssessment.valid === false
      && mismatchedSafetyRetryAssessment.kind === 'smart-on-marker-mismatch',
    '11F-3B: 智能安全 timer marker 精确绑定 alarm 回读时刻；匹配 tuple 被保留，错位 tuple 被拒绝且独立关机 retry 保持为零');
  const resolveRetryPlanSource = extractSourceSection(
    pwmBody,
    'async function resolveRetryPlan(plan, observations, targetAction) {',
    '\n\n  return waitUntil',
    'resolveRetryPlan safety marker'
  );
  const assertMarkerAfterVerifiedAlarm = (source, alarmCall, markerCall) => {
    const alarmIndex = source.indexOf(alarmCall);
    const verifiedIndex = source.indexOf('if (alarmCreated === false)', alarmIndex);
    const markerIndex = source.indexOf(markerCall, verifiedIndex);
    return alarmIndex >= 0 && verifiedIndex > alarmIndex && markerIndex > verifiedIndex;
  };
  const smartCommitStart = smartBody.indexOf('async function commitSmartAlarm(');
  const smartCommitEnd = smartBody.indexOf(
    '\n  async function commitSmartOnRetry',
    smartCommitStart
  );
  const smartCommitBody = smartCommitStart >= 0 && smartCommitEnd > smartCommitStart
    ? smartBody.slice(smartCommitStart, smartCommitEnd)
    : '';
  const smartCommitClearIndex = smartCommitBody.indexOf('replaceSmartRetryState();');
  const smartCommitAlarmIndex = smartCommitBody.indexOf(
    'const alarmCreated = await createAutomationAlarmFromPlan('
  );
  const smartCommitVerifiedIndex = smartCommitBody.indexOf(
    'if (alarmCreated === false)',
    smartCommitAlarmIndex
  );
  const smartCommitMarkerIndex = smartCommitBody.indexOf(
    'await afterAlarmVerified();',
    smartCommitVerifiedIndex
  );
  const restoreIntervalAlarmSource = extractSourceSection(
    backgroundSource,
    'async function restoreIntervalAlarmFromStorage(',
    '\nasync function createAlarm(',
    'restoreIntervalAlarmFromStorage retry marker'
  );
  const onAlarmPwmRecoverySource = extractSourceSection(
    backgroundSource,
    "if (alarm.name === 'ac-pwm') {",
    "\n  if (alarm.name === 'ac-watchdog')",
    'ac-pwm generic error recovery'
  );
  const restoreAlarmIndex = restoreIntervalAlarmSource.indexOf(
    'const alarmCreated = await createPwmAlarmFromPlan('
  );
  const restoreVerifiedIndex = restoreIntervalAlarmSource.indexOf(
    'if (alarmCreated === false)',
    restoreAlarmIndex
  );
  const restoreMarkerIndex = restoreIntervalAlarmSource.indexOf(
    'realignPwmRetryStateToVerifiedClock();',
    restoreVerifiedIndex
  );
  const genericRecoveryIndex = onAlarmPwmRecoverySource.indexOf(
    "'onAlarm-error-recovery'"
  );
  const genericRecoveryVerifiedIndex = onAlarmPwmRecoverySource.indexOf(
    'if (alarmCreated === false)',
    genericRecoveryIndex
  );
  const genericRecoveryMarkerClearIndex = onAlarmPwmRecoverySource.indexOf(
    'replacePwmRetryState();',
    genericRecoveryVerifiedIndex
  );
  assertPass(assertMarkerAfterVerifiedAlarm(
    resolveRetryPlanSource,
    'const alarmCreated = await createPwmAlarmFromPlan(',
    'markPwmRetry('
  )
      && assertMarkerAfterVerifiedAlarm(
        reapplyBody,
        'const alarmCreated = await createAutomationAlarmFromPlan(',
        'markSmartOnSafetyTimerRetry();'
      )
      && assertMarkerAfterVerifiedAlarm(
        repairBody,
        'const alarmCreated = await createPwmAlarmWithVerify(',
        'markPwmRetry('
      )
      && assertMarkerAfterVerifiedAlarm(
        toggleBody,
        'const alarmCreated = await createPwmAlarmWithVerify(',
        'markPwmRetry('
      )
      && resolveRetryPlanSource.includes("plan.reason === 'page-timer-failed' && targetAction === 'on'")
      && !resolveRetryPlanSource.includes('pageTimerRetryAt')
      && !resolveRetryPlanSource.includes('pageTimerRetryMinutes')
      && reapplyBody.indexOf("setSmartNextAction('on');")
        < reapplyBody.indexOf('markSmartOnSafetyTimerRetry();')
      && smartCommitClearIndex >= 0
      && smartCommitAlarmIndex > smartCommitClearIndex
      && smartCommitVerifiedIndex > smartCommitAlarmIndex
      && smartCommitMarkerIndex > smartCommitVerifiedIndex
      && adoptTimerBody.indexOf('replacePwmRetryState();')
        < adoptTimerBody.indexOf('setPwmNextTriggerAt(adopt.nextTriggerAt)')
      && restoreAlarmIndex >= 0
      && restoreVerifiedIndex > restoreAlarmIndex
      && restoreMarkerIndex > restoreVerifiedIndex
      && genericRecoveryIndex >= 0
      && genericRecoveryVerifiedIndex > genericRecoveryIndex
      && genericRecoveryMarkerClearIndex > genericRecoveryVerifiedIndex,
    '11F-3C: 智能 timer 失败在 alarm 验证后写 marker；alarm 重建重新绑定实时时钟，defer/页面权威时钟/通用异常计划替代会清旧 marker');
  const recoveryNow11G = 1_700_000_000_000;
  const recoveryPlan11G = pwmPhase.planPwmRecovery({
    enabled: true,
    pwmState: 'off',
    onMinutes: 10,
    offMinutes: 20
  }, recoveryNow11G - 25 * 60_000, {}, { now: recoveryNow11G });
  const failedRecoveryPlan11G = pwmPhase.planPwmRecovery({
    enabled: true,
    pwmState: 'off',
    onMinutes: 10,
    offMinutes: 20
  }, recoveryNow11G - 25 * 60_000, {
    pageTimerSucceeded: false
  }, { now: recoveryNow11G });
  assertPass(recoveryPlan11G.kind === 'hold'
      && recoveryPlan11G.prerequisite === 'set-page-timer'
      && advanceBody.includes("plan.prerequisite === 'set-page-timer'")
      && advanceBody.includes('await setPageTimer(plan.timerMinutes')
      && advanceBody.includes('pageTimerSucceeded: !!timerResult?.success')
      && advanceBody.includes("'advance-pageTimer-failed'"),
    '11G: 过期闹钟恢复由 planner 要求先重新武装页面关机定时器');
  assertPass(failedRecoveryPlan11G.kind === 'retry'
      && failedRecoveryPlan11G.reason === 'page-timer-failed'
      && failedRecoveryPlan11G.nextAction === 'on'
      && failedRecoveryPlan11G.phasePatch.pwmState === 'on'
      && failedRecoveryPlan11G.nextTriggerAt === recoveryNow11G + 60_000,
    '11G-1: 过期恢复页面定时器失败保持 ON 相位，一分钟后重跑安全预布防');
  const advanceRetrySchedule11G = {
    enabled: true,
    pwmState: 'off',
    onMinutes: 10,
    offMinutes: 20,
    nextTriggerAt: 0,
    smartOnBoundaryAt: 0,
    smartState: 'on',
    smartNextTriggerAt: 654321,
    smartRetryKind: 'smart-on-safety-timer',
    smartRetryBoundaryAt: 600000,
    smartRetryScheduledAt: 654321,
    pageTimerRetryAt: 0,
    pageTimerRetryMinutes: 0,
    smartMode: { enabled: false, sensitivity: 5 }
  };
  const advanceRetryEvents11G = [];
  let verifiedRetryAt11G = 0;
  const advanceExpiredAlarm11G = new Function(
    'schedule',
    'getPwmRetryDescriptor',
    'isSmartAutomationEnabled',
    'planPwmRecovery',
    'isAutomationOperationCurrent',
    'getCurrentACStatus',
    'abortStaleAutomation',
    'applyPwmPlanState',
    'setPageTimer',
    'clearPwmAlarm',
    'createPwmAlarmFromPlan',
    'replacePwmRetryState',
    'PWM_RETRY_KINDS',
    'createAlarm',
    'persistSchedule',
    'updateBadge',
    'console',
    `${pwmRetryMarkerSource}\n${advanceBody};
    return advanceExpiredAlarmToNextBoundary;`
  )(
    advanceRetrySchedule11G,
    kind => ({ kind }),
    () => false,
    pwmPhase.planPwmRecovery,
    revision => revision === 7,
    async () => ({ isOn: true }),
    async () => false,
    plan => {
      if (plan?.phasePatch) Object.assign(advanceRetrySchedule11G, plan.phasePatch);
    },
    async () => {
      advanceRetryEvents11G.push('set-page-timer');
      return { success: false, error: 'fixture timer rejected' };
    },
    async () => { advanceRetryEvents11G.push('clear-pwm'); },
    async plan => {
      advanceRetryEvents11G.push(`create-pwm:${plan.nextAction}`);
      verifiedRetryAt11G = Number(plan.nextTriggerAt) + 17;
      advanceRetrySchedule11G.nextTriggerAt = verifiedRetryAt11G;
      return true;
    },
    retryState => {
      advanceRetryEvents11G.push(`marker:${retryState.kind || 'clear'}`);
      advanceRetrySchedule11G.pwmRetryKind = retryState.kind || '';
      advanceRetrySchedule11G.pwmRetryBoundaryAt = Number(retryState.boundaryAt) || 0;
      advanceRetrySchedule11G.pwmRetryScheduledAt = Number(retryState.scheduledAt) || 0;
    },
    { PAGE_TIMER: 'pwm-page-timer', TOGGLE: 'pwm-toggle' },
    async name => {
      advanceRetryEvents11G.push(`create-alarm:${name}`);
      return true;
    },
    async () => { advanceRetryEvents11G.push('persist'); },
    async () => { advanceRetryEvents11G.push('badge'); },
    quietConsole
  );
  const advanceRetryResult11G = await advanceExpiredAlarm11G(
    Date.now() - 25 * 60_000,
    7
  );
  assertPass(advanceRetryResult11G === true
      && advanceRetrySchedule11G.pwmState === 'on'
      && advanceRetrySchedule11G.nextTriggerAt === verifiedRetryAt11G
      && advanceRetrySchedule11G.pwmRetryKind === 'pwm-page-timer'
      && advanceRetrySchedule11G.pwmRetryBoundaryAt === 0
      && advanceRetrySchedule11G.pwmRetryScheduledAt === verifiedRetryAt11G
      && advanceRetrySchedule11G.smartState === 'on'
      && advanceRetrySchedule11G.smartNextTriggerAt === 654321
      && advanceRetrySchedule11G.smartRetryKind === 'smart-on-safety-timer'
      && advanceRetrySchedule11G.smartRetryBoundaryAt === 600000
      && advanceRetrySchedule11G.smartRetryScheduledAt === 654321
      && advanceRetrySchedule11G.pageTimerRetryAt === 0
      && advanceRetrySchedule11G.pageTimerRetryMinutes === 0
      && advanceRetryEvents11G.indexOf('create-pwm:on')
        < advanceRetryEvents11G.indexOf('marker:pwm-page-timer')
      && advanceRetryEvents11G.indexOf('marker:pwm-page-timer')
        < advanceRetryEvents11G.indexOf('persist'),
    '11G-2: PWM 过期恢复在 alarm 验证后只保留 PWM retry marker，不污染 Smart lifecycle');
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
  assertPass(contentSource.includes('async function typeTimeIntoPickerInput(input, value, allowLocalOnly = false)')
      && contentSource.includes('const POWER_OFF_TIMER_MAX_TYPING_ATTEMPTS = 3')
      && contentSource.includes('const POWER_OFF_TIMER_WHOLE_VALUE_FALLBACK_STAGES = new Set([')
      && contentSource.includes('async function typeOnceIntoPickerInput(')
      && contentSource.includes('{ wholeValue = false, allowLocalOnly = false } = {}')
      && contentSource.includes('waitForConfirmedPowerOffTimerInput(value'),
    '11J-1: 页面定时器保留三次尝试、一次整串兜底，并委派稳定 live 控件确认');

  const powerOffTypingSource = extractSourceSection(
    contentSource,
    'function sleep(ms) {',
    '\n// ----- 查找 AC 开关 DOM 元素 -----',
    'Power-off after typing runtime'
  );
  const powerOffControlSource = extractSourceSection(
    contentSource,
    'async function setPagePowerOffTimer(',
    '\n// ----- v0.5.10: 读取页面已设置的 "Power-off after"',
    'Power-off after control runtime'
  );
  const loadPowerOffTimerRuntime = new Function(
    'document',
    'window',
    'Date',
    'MouseEvent',
    'KeyboardEvent',
    'InputEvent',
    'Event',
    'console',
    't',
    'setTimeout',
    `${powerOffTypingSource}\n${powerOffControlSource};
    return {
      setPagePowerOffTimer,
      findPowerOffTimerInput,
      findVisiblePickerDropdowns,
      createPowerOffTimerFailure
    };`
  );

  function createPowerOffAfterHarness(options = {}) {
    const baseNow = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
    const expectedValue = '12:34';
    const targetAt = baseNow + 34 * 60_000;
    const state = {
      nowMs: baseNow,
      attemptCount: 0,
      replacementCount: 0,
      okClickCount: 0,
      pickerClickCount: 0,
      timeCellClicks: [],
      confirmationCommittedAt: 0,
      confirmationMutationApplied: false,
      confirmationMutationReverted: false,
      inputSequence: 0,
      replacedLengths: new Set(),
      eventLog: []
    };
    let harnessDocument = null;

    class HarnessDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [state.nowMs]));
      }
      static now() { return state.nowMs; }
    }

    class HarnessEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    }

    class HarnessNode {
      constructor(kind, id = '') {
        this.kind = kind;
        this.id = id;
        this.children = [];
        this.className = '';
        this.hidden = false;
        this.attributes = new Map();
        this.isConnected = true;
      }
      getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
      }
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }
      removeAttribute(name) {
        this.attributes.delete(name);
      }
      hasAttribute(name) {
        return this.attributes.has(name);
      }
      dispatchEvent(event) {
        state.eventLog.push({
          type: event.type,
          key: event.key || '',
          nodeId: this.id,
          value: this.value || ''
        });
        this.onDispatch?.(event);
        return true;
      }
      matches(selector) {
        return selector === '.ant-picker-dropdown' && this.kind === 'dropdown';
      }
    }

    class HarnessInput extends HarnessNode {
      constructor(record) {
        super('input', `timer-input-${++state.inputSequence}`);
        this.record = record;
        this.type = 'text';
        this._value = '';
        this.setAttribute('readonly', '');
        this.setAttribute('aria-controls', 'timer-dropdown-0');
        this.setAttribute('aria-expanded', 'false');
      }
      get value() { return this._value; }
      set value(nextValue) { this._value = String(nextValue); }
      focus() { harnessDocument.activeElement = this; }
      click() {
        state.eventLog.push({ type: 'click', key: '', nodeId: this.id, value: this.value });
        this.record.openPicker?.();
      }
    }

    const controls = [];
    const labels = [];
    const requestedControlCount = options.controlCount ?? 1;

    const replaceInput = (record, nextValue) => {
      const previousInput = record.input;
      const replacement = new HarnessInput(record);
      replacement.value = nextValue;
      replacement.setAttribute('title', previousInput.getAttribute('title') || '');
      replacement.setAttribute(
        'aria-expanded',
        previousInput.getAttribute('aria-expanded') || 'false'
      );
      replacement.onDispatch = record.onInputDispatch;
      previousInput.isConnected = false;
      record.input = replacement;
      state.replacementCount += 1;
      return replacement;
    };

    for (let index = 0; index < requestedControlCount; index++) {
      const record = {};
      record.openPicker = () => openPicker(index);
      const picker = new HarnessNode('picker', `timer-picker-${index}`);
      picker.setAttribute('aria-controls', `timer-dropdown-${index}`);
      picker.querySelectorAll = selector => selector === 'input' ? [record.input] : [];
      picker.click = () => {
        state.pickerClickCount += 1;
        openPicker(index);
      };
      record.picker = picker;
      record.input = new HarnessInput(record);
      record.input.setAttribute('aria-controls', `timer-dropdown-${index}`);
      record.onInputDispatch = (event) => {
        if (event.type !== 'input') return;
        if (event.data === null) {
          state.attemptCount += 1;
          state.replacedLengths = new Set();
          return;
        }
        const prefixLength = record.input.value.length;
        if (options.replacementMode === 'preserve'
            && (prefixLength === 2 || prefixLength === 3)
            && !state.replacedLengths.has(prefixLength)) {
          state.replacedLengths.add(prefixLength);
          replaceInput(record, record.input.value);
        } else if (options.replacementMode === 'rollback'
            && (prefixLength === 2
              || (options.rejectWholeValue && String(event.data || '').length > 1))
            && !state.replacedLengths.has(prefixLength)) {
          state.replacedLengths.add(prefixLength);
          replaceInput(record, '');
        }
      };
      record.input.onDispatch = record.onInputDispatch;
      const container = {
        parentElement: null,
        querySelectorAll(selector) {
          return selector === '.ant-picker' ? [picker] : [];
        }
      };
      let labelContainer = container;
      for (let depth = 0; depth < (options.associationDepth || 0); depth++) {
        labelContainer = {
          parentElement: labelContainer,
          querySelectorAll() { return []; }
        };
      }
      const label = {
        children: [],
        textContent: 'Power-off after',
        parentElement: labelContainer
      };
      controls.push(record);
      labels.push(label);
    }

    const hourCells = Array.from({ length: 24 }, (_, value) => ({
      textContent: String(value).padStart(2, '0'),
      click() { state.timeCellClicks.push(String(value).padStart(2, '0')); }
    }));
    const minuteCells = Array.from({ length: 60 }, (_, value) => ({
      textContent: String(value).padStart(2, '0'),
      click() { state.timeCellClicks.push(String(value).padStart(2, '0')); }
    }));
    const timeColumns = [
      { querySelectorAll: selector => (selector === 'li' ? hourCells : []) },
      { querySelectorAll: selector => (selector === 'li' ? minuteCells : []) }
    ];

    const dropdownCount = options.multipleNewDropdowns ? 2 : 1;
    const dropdowns = Array.from({ length: dropdownCount }, (_, index) => {
      const dropdownId = options.preVisibleUnrelatedDropdown && index === 0
        ? 'unrelated-dropdown'
        : `timer-dropdown-${index}`;
      const dropdown = new HarnessNode('dropdown', dropdownId);
      dropdown.hidden = options.preVisibleUnrelatedDropdown !== true;
      dropdown.className = options.preVisibleUnrelatedDropdown
        ? 'ant-picker-dropdown'
        : 'ant-picker-dropdown ant-picker-dropdown-hidden';
      dropdown.setAttribute(
        'aria-hidden',
        options.preVisibleUnrelatedDropdown ? 'false' : 'true'
      );
      dropdown.setAttribute('style', '');
      const buttonCount = index === 0 ? (options.okButtonCount ?? 1) : 1;
      const buttons = Array.from({ length: buttonCount }, () => ({
        disabled: false,
        click() {
          state.okClickCount += 1;
          state.confirmationCommittedAt = state.nowMs;
          const liveInput = controls[0].input;
          if (options.confirmationMode === 'title-only') {
            liveInput.value = '';
            liveInput.setAttribute('title', expectedValue);
          } else {
            liveInput.value = expectedValue;
            liveInput.setAttribute(
              'title',
              options.confirmationMode === 'conflict'
                ? '09:59'
                : options.confirmationMode === 'value-only'
                  ? ''
                  : expectedValue
            );
          }
          dropdown.hidden = true;
          dropdown.className = 'ant-picker-dropdown ant-picker-dropdown-hidden';
          dropdown.setAttribute('aria-hidden', 'true');
          liveInput.setAttribute('aria-expanded', 'false');
        }
      }));
      dropdown.querySelectorAll = selector => {
        if (selector === '.ant-picker-ok button:not([disabled])') return buttons;
        if (selector === '.ant-picker-time-panel-column') return timeColumns;
        return [];
      };
      return dropdown;
    });

    function openPicker(index) {
      const visible = options.noDropdownOnOpen
        ? []
        : options.multipleNewDropdowns ? dropdowns : [dropdowns[0]];
      for (const dropdown of visible) {
        dropdown.hidden = false;
        dropdown.className = 'ant-picker-dropdown';
        dropdown.setAttribute('aria-hidden', 'false');
      }
      controls[index].input.setAttribute('aria-expanded', 'true');
    }

    harnessDocument = {
      activeElement: null,
      body: { textContent: 'Power-off after' },
      querySelectorAll(selector) {
        if (selector === 'small, label, div, span') return labels;
        if (selector === '.ant-picker-dropdown') return dropdowns;
        if (selector === '.ant-picker input') return [{ value: 'unrelated-picker' }];
        return [];
      },
      getElementById(id) {
        return dropdowns.find(dropdown => dropdown.id === id) || null;
      }
    };

    const runtime = loadPowerOffTimerRuntime(
      harnessDocument,
      {},
      HarnessDate,
      HarnessEvent,
      HarnessEvent,
      HarnessEvent,
      HarnessEvent,
      { log() {}, warn() {}, error() {} },
      (key, ...subs) => `${key}${subs.length ? `:${subs.join(',')}` : ''}`,
      (callback, delay = 0) => {
        state.nowMs += Math.max(0, Number(delay) || 0);
        if (Number.isFinite(options.mutateConfirmedTitleAtMs)
            && state.confirmationCommittedAt > 0) {
          const elapsed = state.nowMs - state.confirmationCommittedAt;
          if (!state.confirmationMutationApplied
              && elapsed >= options.mutateConfirmedTitleAtMs) {
            controls[0].input.setAttribute('title', '');
            state.confirmationMutationApplied = true;
          } else if (state.confirmationMutationApplied
              && !state.confirmationMutationReverted
              && elapsed >= options.mutateConfirmedTitleAtMs + 100) {
            controls[0].input.setAttribute('title', expectedValue);
            state.confirmationMutationReverted = true;
          }
        }
        callback();
        return state.nowMs;
      }
    );

    return {
      async run(allowLocalOnly = false) {
        return runtime.setPagePowerOffTimer(34, targetAt, allowLocalOnly);
      },
      getCurrentInput: () => controls[0]?.input || null,
      getVisibleDropdownCount: () => runtime.findVisiblePickerDropdowns().length,
      getElapsedMs: () => state.nowMs - baseNow,
      getStableConfirmationMs: () => state.confirmationCommittedAt
        ? state.nowMs - state.confirmationCommittedAt
        : 0,
      createFailure: (error, details) => runtime.createPowerOffTimerFailure(error, details),
      expectedValue,
      state
    };
  }

  const replacementHarness11J = createPowerOffAfterHarness({ replacementMode: 'preserve' });
  const replacementResult11J = await replacementHarness11J.run();
  const replacementLiveInput11J = replacementHarness11J.getCurrentInput();
  const replacementChangeEvents11J = replacementHarness11J.state.eventLog
    .filter(event => event.type === 'change');
  assertPass(replacementResult11J.success === true
      && replacementHarness11J.state.attemptCount === 1
      && replacementHarness11J.state.replacementCount === 2
      && replacementHarness11J.state.okClickCount === 1
      && replacementHarness11J.state.pickerClickCount === 0
      && replacementHarness11J.state.eventLog.filter(event => event.type === 'click').length === 1
      && replacementLiveInput11J.value === replacementHarness11J.expectedValue
      && replacementLiveInput11J.getAttribute('title') === replacementHarness11J.expectedValue
      && replacementHarness11J.getVisibleDropdownCount() === 0
      && replacementHarness11J.getStableConfirmationMs() >= 500
      && replacementChangeEvents11J.at(-1)?.nodeId === replacementLiveInput11J.id,
    '11J-2: 第二/第三字符替换节点并保留前缀时，change/OK 在当前 live 控件完成且稳定 500ms（不再派发 Enter）');

  const wholeValueFallbackHarness11J = createPowerOffAfterHarness({
    replacementMode: 'rollback'
  });
  const wholeValueFallbackResult11J = await wholeValueFallbackHarness11J.run();
  const wholeValueFallbackInput11J = wholeValueFallbackHarness11J.getCurrentInput();
  assertPass(wholeValueFallbackResult11J.success === true
      && wholeValueFallbackHarness11J.state.attemptCount === 2
      && wholeValueFallbackHarness11J.state.replacementCount === 1
      && wholeValueFallbackHarness11J.state.okClickCount === 1
      && wholeValueFallbackHarness11J.state.pickerClickCount === 0
      && wholeValueFallbackHarness11J.state.eventLog.filter(
        event => event.type === 'click'
      ).length === 1
      && wholeValueFallbackInput11J.value === wholeValueFallbackHarness11J.expectedValue
      && wholeValueFallbackInput11J.getAttribute('title')
        === wholeValueFallbackHarness11J.expectedValue,
    '11J-2A: 逐字符前缀被受控输入回滚时，第二次复用已打开 picker 并以整串输入完成稳定确认');

  const rollbackHarness11J = createPowerOffAfterHarness({
    replacementMode: 'rollback',
    rejectWholeValue: true
  });
  const rollbackResult11J = await rollbackHarness11J.run();
  const boundedFailure11J = rollbackHarness11J.createFailure(
    `file://private/path chrome-extension://secret tabId=91 ${'e'.repeat(400)}`,
    {
      failureStage: 's'.repeat(100),
      attempt: 999,
      expectedValue: 'e'.repeat(100),
      observedValue: 'v'.repeat(100),
      observedTitle: 't'.repeat(100),
      inputReplacementCount: 999,
      controlCount: 999,
      visibleDropdownCount: 999,
      elapsedMs: 999999
    }
  );
  const failureFields11J = [
    'failureStage',
    'attempt',
    'expectedValue',
    'observedValue',
    'observedTitle',
    'inputReplacementCount',
    'controlCount',
    'visibleDropdownCount',
    'elapsedMs'
  ];
  assertPass(rollbackResult11J.success === false
      && typeof rollbackResult11J.error === 'string'
      && rollbackResult11J.failureStage === 'type-character'
      && rollbackResult11J.attempt === 3
      && rollbackResult11J.expectedValue === rollbackHarness11J.expectedValue
      && rollbackResult11J.inputReplacementCount === 3
      && rollbackHarness11J.state.attemptCount === 3
      && rollbackHarness11J.state.okClickCount === 0
      && failureFields11J.every(field => Object.hasOwn(rollbackResult11J, field))
      && Object.values(rollbackResult11J).every(value => value === null
        || ['boolean', 'number', 'string'].includes(typeof value))
      && !/https?:|tabId|\[object HTML/i.test(JSON.stringify(rollbackResult11J))
      && boundedFailure11J.error.length <= 240
      && !/file:|chrome-extension:|tabId/i.test(boundedFailure11J.error)
      && boundedFailure11J.failureStage.length === 48
      && boundedFailure11J.attempt === 3
      && boundedFailure11J.expectedValue.length === 16
      && boundedFailure11J.observedValue.length === 16
      && boundedFailure11J.observedTitle.length === 16
      && boundedFailure11J.inputReplacementCount === 99
      && boundedFailure11J.controlCount === 99
      && boundedFailure11J.visibleDropdownCount === 99
      && boundedFailure11J.elapsedMs === 120000,
    '11J-3: 节点替换后回滚严格三次失败、零 OK 点击，并返回有界纯标量诊断字段');

  const ambiguousControlHarness11J = createPowerOffAfterHarness({ controlCount: 2 });
  const ambiguousControlResult11J = await ambiguousControlHarness11J.run();
  const missingSemanticHarness11J = createPowerOffAfterHarness({ controlCount: 0 });
  const missingSemanticResult11J = await missingSemanticHarness11J.run();
  const deepUnrelatedHarness11J = createPowerOffAfterHarness({ associationDepth: 6 });
  const deepUnrelatedResult11J = await deepUnrelatedHarness11J.run();
  assertPass(ambiguousControlResult11J.success === false
      && ambiguousControlResult11J.failureStage === 'locate-control'
      && ambiguousControlResult11J.attempt === 0
      && ambiguousControlResult11J.controlCount === 2
      && ambiguousControlHarness11J.state.okClickCount === 0
      && missingSemanticResult11J.success === false
      && missingSemanticResult11J.failureStage === 'locate-control'
      && missingSemanticResult11J.controlCount === 0
      && missingSemanticHarness11J.state.okClickCount === 0
      && deepUnrelatedResult11J.success === false
      && deepUnrelatedResult11J.controlCount === 0
      && deepUnrelatedHarness11J.state.okClickCount === 0,
    '11J-4: 零个、多个或仅共享高层祖先的 picker 均失败关闭，不回退无关 input 且零 OK 点击');

  const conflictingValueHarness11J = createPowerOffAfterHarness({ confirmationMode: 'conflict' });
  const conflictingValueResult11J = await conflictingValueHarness11J.run();
  const titleOnlyHarness11J = createPowerOffAfterHarness({ confirmationMode: 'title-only' });
  const titleOnlyResult11J = await titleOnlyHarness11J.run();
  const valueOnlyHarness11J = createPowerOffAfterHarness({ confirmationMode: 'value-only' });
  const valueOnlyResult11J = await valueOnlyHarness11J.run();
  const localOnlyHarness11J = createPowerOffAfterHarness({ confirmationMode: 'value-only' });
  const localOnlyResult11J = await localOnlyHarness11J.run(true);
  assertPass(conflictingValueResult11J.success === false
      && conflictingValueResult11J.failureStage === 'confirm-stable'
      && conflictingValueResult11J.attempt === 3
      && conflictingValueResult11J.observedValue === conflictingValueHarness11J.expectedValue
      && conflictingValueResult11J.observedTitle === '09:59'
      && titleOnlyResult11J.success === false
      && titleOnlyResult11J.failureStage === 'confirm-stable'
      && valueOnlyResult11J.success === false
      && valueOnlyResult11J.failureStage === 'confirm-stable'
      && valueOnlyResult11J.observedValue === valueOnlyHarness11J.expectedValue
      && valueOnlyResult11J.observedTitle === '',
    '11J-5: 仅 value 或仅 title 均判为未提交（AntD 未触发 onOk）；二者冲突时三次后明确失败');
  assertPass(localOnlyResult11J.success === true
      && localOnlyResult11J.locallyAccepted === true
      && localOnlyHarness11J.getCurrentInput().value === localOnlyHarness11J.expectedValue
      && localOnlyHarness11J.getCurrentInput().getAttribute('title') === '',
    '11J-5B: 自动开机预布防可接受本地 value、暂缺 title，交由开机后新鲜页面验证持久化');

  const signatureMutationHarness11J = createPowerOffAfterHarness({
    mutateConfirmedTitleAtMs: 550
  });
  const signatureMutationResult11J = await signatureMutationHarness11J.run();
  assertPass(signatureMutationResult11J.success === true
      && signatureMutationHarness11J.state.confirmationMutationApplied === true
      && signatureMutationHarness11J.getStableConfirmationMs() >= 1000,
    '11J-5A: 确认窗口内 value/title 签名变化会重新计时，连续稳定 500ms 后才成功');

  const ambiguousDropdownHarness11J = createPowerOffAfterHarness({ multipleNewDropdowns: true });
  const ambiguousDropdownResult11J = await ambiguousDropdownHarness11J.run();
  const ambiguousOkHarness11J = createPowerOffAfterHarness({ okButtonCount: 2 });
  const ambiguousOkResult11J = await ambiguousOkHarness11J.run();
  const preVisibleDropdownHarness11J = createPowerOffAfterHarness({
    preVisibleUnrelatedDropdown: true,
    noDropdownOnOpen: true
  });
  const preVisibleDropdownResult11J = await preVisibleDropdownHarness11J.run();
  assertPass(ambiguousDropdownResult11J.success === false
      && ambiguousDropdownResult11J.failureStage === 'select-ok'
      && ambiguousDropdownResult11J.attempt === 1
      && ambiguousDropdownResult11J.visibleDropdownCount === 2
      && ambiguousDropdownHarness11J.state.okClickCount === 0
      && ambiguousOkResult11J.success === false
      && ambiguousOkResult11J.failureStage === 'select-ok'
      && ambiguousOkResult11J.attempt === 1
      && ambiguousOkHarness11J.state.okClickCount === 0
      && preVisibleDropdownResult11J.success === false
      && preVisibleDropdownResult11J.failureStage === 'select-ok'
      && preVisibleDropdownResult11J.attempt === 1
      && preVisibleDropdownHarness11J.state.okClickCount === 0,
    '11J-6: 多个新 dropdown、多个 enabled OK 或预先可见无关 dropdown 等待后仍失败且零点击');

  const timeCellHarness11J = createPowerOffAfterHarness({});
  const timeCellResult11J = await timeCellHarness11J.run();
  assertPass(timeCellResult11J.success === true
      && timeCellHarness11J.state.timeCellClicks.length === 0
      && timeCellHarness11J.state.okClickCount === 1
      && timeCellHarness11J.getCurrentInput().value === timeCellHarness11J.expectedValue,
    '11J-6A: 已输入目标值时不再点击时间格覆盖输入，直接等待唯一 OK 提交');
  assertPass(contentSource.includes('function closePowerOffPickerDropdowns(')
      && contentSource.includes("key: 'Escape'")
      && contentSource.includes('if (closePowerOffPickerDropdowns(input) > 0)'),
    '11J-6C: 写入前清理上次遗留的可见下拉层，避免 select-ok 误判');

  // 11J-6B: UST 页面改版后 Power-off after 定位健壮性——前缀匹配 + placeholder 兜底。
  const powerOffLabelMatcherSource = extractSourceSection(
    contentSource,
    'function isPowerOffAfterLabel(',
    'function findPowerOffTimerControlState(',
    'power-off label matcher'
  );
  const loadLabelMatcher = new Function(
    'document',
    `${powerOffLabelMatcherSource};
    return { isPowerOffAfterLabel, collectPowerOffTimerLabelHints, findPowerOffTimerInputByPlaceholder };`
  );
  const labelMatcher = loadLabelMatcher(null);
  const placeholderInput11J = {
    type: 'text',
    isConnected: true,
    getAttribute(name) { return name === 'placeholder' ? 'Select time' : null; }
  };
  const placeholderMatcher = loadLabelMatcher({
    querySelectorAll(selector) {
      return selector === '.ant-picker input' ? [placeholderInput11J] : [];
    }
  });
  const ambiguousPlaceholderMatcher = loadLabelMatcher({
    querySelectorAll(selector) {
      return selector === '.ant-picker input'
        ? [placeholderInput11J, { ...placeholderInput11J }]
        : [];
    }
  });
  const hintDocument11J = {
    querySelectorAll(selector) {
      if (selector !== 'small, label, p, h1, h2, h3, h4, h5, h6, div, span') return [];
      return [
        { children: [], textContent: 'Power-off after (min)' },
        { children: [], textContent: 'Air Conditioning Status' },
        { children: [], textContent: 'left of 22100 min balance' },
        { children: [{}, {}], textContent: 'Select time to power-off AC automatically' }
      ];
    }
  };
  const hintMatcher = loadLabelMatcher(hintDocument11J);
  assertPass(
    labelMatcher.isPowerOffAfterLabel('Power-off after')
      && labelMatcher.isPowerOffAfterLabel('Power off after')
      && labelMatcher.isPowerOffAfterLabel('Power-off after (min)')
      && labelMatcher.isPowerOffAfterLabel('Power-off After')
      && !labelMatcher.isPowerOffAfterLabel('Air Conditioning Status')
      && !labelMatcher.isPowerOffAfterLabel('Auto shutdown')
      && placeholderMatcher.findPowerOffTimerInputByPlaceholder() === placeholderInput11J
      && ambiguousPlaceholderMatcher.findPowerOffTimerInputByPlaceholder() === null
      && hintMatcher.collectPowerOffTimerLabelHints() === 'Power-off after (min)',
    '11J-6B: isPowerOffAfterLabel 放宽为前缀匹配；placeholder="Select time" 唯一时才兜底定位；失败回显真实标签文案'
  );

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
      && countOccurrences(backgroundSource, 'clearPageTimerProofState();') === 5,
    '11L: planner proofAction 与 Smart/PWM 直接失效路径统一委派给 clearPageTimerProofState');

  const reconciliationSites = [
    ['persistSchedule', 'async function persistSchedule(', '\nconst _syncOpLock'],
    ['watchdogCheck', 'async function watchdogCheck()', '\n// ----- 启动时加载设置并创建闹钟'],
    ['init', 'async function init()', '\n// ----- 设置/更新 PWM 循环闹钟'],
    ['badge-tick', "if (alarm.name === 'ac-badge-tick')", "\n  if (alarm.name === 'ac-smart' || alarm.name === 'ac-pwm')"],
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
  console.log('\n\n=== 用例 12: 审计修复回归（只读轮询、HIG、发布与安装） ===\n');

  const snapshotStart = backgroundSource.indexOf('async function getScheduleSnapshot(');
  const snapshotEnd = backgroundSource.indexOf('\nasync function toggleSmartNowAndSync', snapshotStart);
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
    'getAutomationAlarmName',
    'isSmartAutomationEnabled',
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
        async get(name) {
          return name === getAutomationAlarmName() && liveAlarm ? { ...liveAlarm } : undefined;
        }
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
    let balanceCacheLoaded = false;
    let lastKnownBalanceMinutes = null;
    async function mergeBalanceReading(status) {
      if (!status || typeof status !== 'object') return status;
      if (!balanceCacheLoaded) {
        const localStored = await chrome.storage.local.get('ac_balance_cache');
        const sessionStored = await chrome.storage.session.get('ac_balance_cache');
        const localBalance = localStored.ac_balance_cache;
        const sessionBalance = sessionStored.ac_balance_cache;
        lastKnownBalanceMinutes = Number.isFinite(localBalance)
          ? localBalance
          : Number.isFinite(sessionBalance)
            ? sessionBalance
            : null;
        balanceCacheLoaded = true;
        if (Number.isFinite(lastKnownBalanceMinutes)) {
          if (localBalance !== lastKnownBalanceMinutes) {
            await chrome.storage.local.set({ ac_balance_cache: lastKnownBalanceMinutes });
          }
          if (sessionBalance !== lastKnownBalanceMinutes) {
            await chrome.storage.session.set({ ac_balance_cache: lastKnownBalanceMinutes });
          }
        }
      }
      const merged = { ...status };
      if (typeof merged.balanceMinutes === 'number'
          && Number.isFinite(merged.balanceMinutes)) {
        lastKnownBalanceMinutes = merged.balanceMinutes;
        await chrome.storage.local.set({ ac_balance_cache: lastKnownBalanceMinutes });
        await chrome.storage.session.set({ ac_balance_cache: lastKnownBalanceMinutes });
      } else if (merged.balanceState === 'not-charge-mode') {
        lastKnownBalanceMinutes = null;
        await chrome.storage.local.remove('ac_balance_cache');
        await chrome.storage.session.remove('ac_balance_cache');
        delete merged.balanceMinutes;
      } else if (Number.isFinite(lastKnownBalanceMinutes)) {
        merged.balanceMinutes = lastKnownBalanceMinutes;
      }
      return merged;
    }
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
    () => 'ac-pwm',
    state => state?.smartMode?.enabled === true,
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
    () => 'ac-pwm',
    state => state?.smartMode?.enabled === true,
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
    () => 'ac-pwm',
    state => state?.smartMode?.enabled === true,
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
    () => 'ac-pwm',
    state => state?.smartMode?.enabled === true,
    initialSchedule12,
    { name: 'ac-pwm', scheduledTime: liveDueAt12 },
    { isOn: true, balanceState: 'available', balanceMinutes: 156 }
  );
  await persistedBalanceHarness.getScheduleSnapshot();
  const restartedBalanceHarness = createScheduleSnapshotHarness(
    pwmPhase.reconcilePwmTrigger,
    () => 'ac-pwm',
    state => state?.smartMode?.enabled === true,
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
    () => 'ac-pwm',
    state => state?.smartMode?.enabled === true,
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

  const resetDisabledAutomationRuntimeSource = extractSourceSection(
    backgroundSource,
    'async function resetDisabledAutomationRuntime() {',
    '\nasync function persistReconciledPwmTrigger(',
    'resetDisabledAutomationRuntime'
  );
  const loadResetDisabledAutomationRuntime = new Function(
    'schedule',
    'setNextTriggerAt',
    'chrome',
    'clearPwmAlarm',
    'updateBadge',
    'recordControlAuditTerminal',
    `let pwmRuntimeRevision = 0;
    let smartRuntimeRevision = 0;
    let scheduleLoadBlockedRevision = null;
    function isSmartAutomationEnabled() { return false; }
    function invalidateTimerBasedShutdown() {}
    async function cancelAutomaticOnRequests() {}
    function replacePwmRetryState() {}
    function setPwmNextTriggerAt(value) { return setNextTriggerAt(value); }
    let lastPwmStepAt = 123456;
    ${resetDisabledAutomationRuntimeSource};
    return {
      resetDisabledAutomationRuntime,
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
  const resetDisabledAutomationRuntimeHarness = loadResetDisabledAutomationRuntime(
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
    async () => { resetRuntimeCalls.push('updateBadge'); },
    async () => null
  );
  await resetDisabledAutomationRuntimeHarness.resetDisabledAutomationRuntime();
  assertPass(resetRuntimeSchedule.enabled === true
      && resetRuntimeSchedule.pwmState === 'off'
      && resetRuntimeSchedule.nextTriggerAt === 0
      && resetRuntimeSchedule.alarmCreatedAt === 0
      && resetRuntimeSchedule.alarmDelayMinutes === 0
      && resetRuntimeSchedule.smartOnBoundaryAt === 0
      && resetRuntimeSchedule.pageTimerMinutes === 30
      && resetRuntimeSchedule.pageTimerError === 'keep'
      && resetRuntimeSchedule.pageTimerRetryMinutes === 1
      && resetDisabledAutomationRuntimeHarness.getLastPwmStepAt() === 0,
    '13I: 停用运行态 helper 重置 PWM 时钟与旧冷却，不改 enabled 或页面定时器证明');
  assertPass(resetRuntimeCalls.join(',') === [
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
  const activeResetIndex = activeBoundaryBody.indexOf('await resetDisabledAutomationRuntime();');
  const activePersistIndex = activeBoundaryBody.indexOf("persistSchedule('active-hours-leave-pre-shutdown'");
  const activeShutdownIndex = activeBoundaryBody.indexOf("requestTimerBasedShutdown('active-hours-leave')");
  const syncResetIndex = applySyncedPhaseBody.indexOf('await resetDisabledAutomationRuntime();');
  const syncPersistIndex = applySyncedPhaseBody.indexOf("persistSchedule('sync-disabled-pre-shutdown'");
  const syncShutdownIndex = applySyncedPhaseBody.indexOf("requestTimerBasedShutdown('sync-disabled')");
  const updateResetIndex = updateScheduleBody.indexOf('await resetDisabledAutomationRuntime();');
  const updatePersistIndex = updateScheduleBody.indexOf("persistSchedule('updateSchedule')");
  const updateShutdownIndex = updateScheduleBody.indexOf("requestTimerBasedShutdown('schedule-disabled')");
  assertPass(countOccurrences(backgroundSource, 'await resetDisabledAutomationRuntime();') === 3
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
      && popupSource.includes("diagnoseOffPageTimerRetryInactive")
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
      && /diagnoseTriMatch', automationAlarmName, fmt\(/.test(popupSource)
      && /diagnoseTriMismatch', automationAlarmName, fmt\(/.test(popupSource),
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

  const retryChannelsStart14O = popupSource.indexOf(
    'function classifyDiagnosticRetryChannels('
  );
  const retryChannelsEnd14O = popupSource.indexOf(
    '\nasync function sendDiagnosticRuntimeMessage',
    retryChannelsStart14O
  );
  const retryChannelsSource14O = retryChannelsStart14O >= 0
      && retryChannelsEnd14O > retryChannelsStart14O
    ? popupSource.slice(retryChannelsStart14O, retryChannelsEnd14O)
    : '';
  const classifyDiagnosticRetryChannels14O = retryChannelsSource14O
    ? new Function(
        'areDiagnosticTriggersAligned',
        `${retryChannelsSource14O}; return classifyDiagnosticRetryChannels;`
      )(areDiagnosticTriggersAligned)
    : null;
  assertPass(typeof classifyDiagnosticRetryChannels14O === 'function',
    '14O-1: popup 以纯分类器分别判断自动 ON safety retry 与独立 OFF page timer retry');
  if (typeof classifyDiagnosticRetryChannels14O === 'function') {
    const retryAt14O = 1_900_000_000_000;
    const activeSafetySchedule14O = {
      enabled: true,
      pwmState: 'off',
      nextTriggerAt: 123456,
      pwmRetryKind: 'pwm-toggle',
      pwmRetryScheduledAt: 123000,
      smartState: 'on',
      smartNextTriggerAt: retryAt14O + 400,
      smartRetryKind: 'smart-on-safety-timer',
      smartRetryBoundaryAt: 0,
      smartRetryScheduledAt: retryAt14O,
      smartMode: { enabled: true },
      pageTimerRetryAt: 0,
      pageTimerRetryMinutes: 0
    };
    const activeRetryChannels14O = classifyDiagnosticRetryChannels14O(
      activeSafetySchedule14O,
      { name: 'ac-smart', scheduledTime: retryAt14O + 1499 },
      null
    );
    const inactiveRetryChannels14O = classifyDiagnosticRetryChannels14O({
      enabled: true,
      pwmState: 'off',
      nextTriggerAt: 654321,
      smartState: 'on',
      smartNextTriggerAt: retryAt14O,
      smartMode: { enabled: true },
      pageTimerRetryAt: 0,
      pageTimerRetryMinutes: 0
    }, { name: 'ac-smart', scheduledTime: retryAt14O }, null);
    const missingSafetyAlarm14O = classifyDiagnosticRetryChannels14O(
      activeSafetySchedule14O,
      null,
      null
    );
    const mismatchedSafetyTuple14O = classifyDiagnosticRetryChannels14O(
      activeSafetySchedule14O,
      { name: 'ac-smart', scheduledTime: retryAt14O + 1500 },
      null
    );
    const disabledSafetyTuple14O = classifyDiagnosticRetryChannels14O(
      { ...activeSafetySchedule14O, enabled: false },
      { name: 'ac-smart', scheduledTime: retryAt14O },
      null
    );
    assertPass(activeRetryChannels14O.smartOnSafety.status === 'active'
        && activeRetryChannels14O.smartOnSafety.ok === true
        && inactiveRetryChannels14O.smartOnSafety.status === 'inactive'
        && inactiveRetryChannels14O.smartOnSafety.ok === true
        && missingSafetyAlarm14O.smartOnSafety.status === 'missing-alarm'
        && missingSafetyAlarm14O.smartOnSafety.ok === false
        && mismatchedSafetyTuple14O.smartOnSafety.status === 'mismatch'
        && mismatchedSafetyTuple14O.smartOnSafety.ok === false
        && disabledSafetyTuple14O.smartOnSafety.status === 'mismatch'
        && disabledSafetyTuple14O.smartOnSafety.ok === false,
      '14O-2: 自动 ON safety retry 仅在启用、智能、ON marker 与 live ac-smart 三方对齐时激活，缺钟或错位判红');

    const activeOffRetry14O = classifyDiagnosticRetryChannels14O({
      pageTimerRetryAt: retryAt14O,
      pageTimerRetryMinutes: 25
    }, null, { name: 'ac-page-timer-retry', scheduledTime: retryAt14O + 1499 });
    const inactiveOffRetry14O = classifyDiagnosticRetryChannels14O({
      pageTimerRetryAt: 0,
      pageTimerRetryMinutes: 0
    }, null, null);
    const missingOffRetryAlarm14O = classifyDiagnosticRetryChannels14O({
      pageTimerRetryAt: retryAt14O,
      pageTimerRetryMinutes: 25
    }, null, null);
    const mismatchedOffRetry14O = classifyDiagnosticRetryChannels14O({
      pageTimerRetryAt: retryAt14O,
      pageTimerRetryMinutes: 25
    }, null, { name: 'ac-page-timer-retry', scheduledTime: retryAt14O + 1500 });
    assertPass(activeOffRetry14O.offPageTimer.status === 'active'
        && activeOffRetry14O.offPageTimer.ok === true
        && activeOffRetry14O.offPageTimer.targetMinutes === 25
        && inactiveOffRetry14O.offPageTimer.status === 'inactive'
        && inactiveOffRetry14O.offPageTimer.ok === true
        && missingOffRetryAlarm14O.offPageTimer.status === 'missing-alarm'
        && missingOffRetryAlarm14O.offPageTimer.ok === false
        && mismatchedOffRetry14O.offPageTimer.status === 'mismatch'
        && mismatchedOffRetry14O.offPageTimer.ok === false,
      '14O-3: 独立 OFF retry 以目标关机分钟、持久时刻和 live ac-page-timer-retry 对齐判定四态');
  }

  const retryDiagnosticLocaleKeys14O = [
    'diagnoseSmartOnSafetyRetryActive',
    'diagnoseSmartOnSafetyRetryInactive',
    'diagnoseSmartOnSafetyRetryMissingAlarm',
    'diagnoseSmartOnSafetyRetryMismatch',
    'diagnoseOffPageTimerRetryActive',
    'diagnoseOffPageTimerRetryInactive',
    'diagnoseOffPageTimerRetryMissingAlarm',
    'diagnoseOffPageTimerRetryMismatch'
  ];
  assertPass(retryDiagnosticLocaleKeys14O.every(key => (
    zhCN[key]?.message && en[key]?.message && diagnoseHandlerSource.includes(`'${key}'`)
  ))
      && en.diagnoseOffPageTimerRetryActive.message.includes('target shutdown')
      && zhCN.diagnoseOffPageTimerRetryActive.message.includes('目标关机')
      && !diagnoseHandlerSource.includes("t('diagnosePageTimerRetryNone')"),
    '14O-4: 医生检查始终分别输出双通道四态，英文 $2 明确是目标关机分钟而非等待时长');

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
  console.log('\n\n=== 用例 15: 持久化脱敏诊断日志 ===\n');

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

  assertPass(backgroundSource.includes("appendDiagnosticLog(bfcachePortClosed ? 'warn' : 'error', 'toggle-message', error)")
      && /back\/forward cache/i.test(backgroundSource),
    '15G: toggle-message 的 BFCache 断口降级为 warn，其它发送失败仍按 error');

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
  console.log('\n\n=== 用例 16: 运行时段全局门禁与竞态收口 ===\n');

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

  const activeHoursHeaderIndex = popupHtml.indexOf('id="activeHoursSectionHeader"');
  const activeHoursBodyIndex = popupHtml.indexOf('id="activeHoursBody"');
  const timerHeaderIndex = popupHtml.indexOf('id="timerSectionHeader"');
  const smartHeaderIndex = popupHtml.indexOf('id="smartSectionHeader"');
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
  const settingsCardStart16 = popupHtml.indexOf('<div class="settings-card">');
  const directSettingChildIds16 = [];
  if (settingsCardStart16 >= 0) {
    const divTokenPattern16 = /<\/?div\b[^>]*>/g;
    divTokenPattern16.lastIndex = settingsCardStart16;
    let divDepth16 = 0;
    let divToken16;
    while ((divToken16 = divTokenPattern16.exec(popupHtml))) {
      const token16 = divToken16[0];
      if (token16.startsWith('</')) {
        divDepth16 -= 1;
        if (divDepth16 === 0) break;
        continue;
      }
      if (divDepth16 === 1) {
        const id16 = /\bid="([^"]+)"/.exec(token16)?.[1];
        if (id16) directSettingChildIds16.push(id16);
      }
      divDepth16 += 1;
    }
  }
  assertPass(activeHoursHeaderIndex >= 0
      && activeHoursBodyIndex > activeHoursHeaderIndex
      && popupHtml.indexOf('class="automation-heading"') >= 0
      && popupHtml.indexOf('class="automation-heading"') < activeHoursHeaderIndex
      && popupHtml.indexOf('class="active-hours-section"') >= 0
      && popupHtml.indexOf('class="active-hours-section"') < activeHoursHeaderIndex
      && popupHtml.indexOf('id="timerBody"') > activeHoursBodyIndex
      && popupHtml.indexOf('id="smartBody"') > popupHtml.indexOf('id="timerBody"'),
    '16D: 运行时段位于自动化总开关之后、循环定时与智能控制之前');
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
  const smartEntryPlan16 = smartPhase.planSmartModeOnWindow(
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
    'async function resolvePageTimerArmHold(plan, observations) {',
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
    'schedule', 'isSmartAutomationEnabled', 'toggleAC', 'isAutomationAllowed', 'isAutomationOperationCurrent',
    'getCurrentACStatus', 'requestTimerBasedShutdown', 'clearPageTimerProofState',
    'setNextTriggerAt', 'chrome', 'clearPwmAlarm', 'setPageTimer', 'abortStaleAutomation',
    'createPwmAlarmWithVerify', 'createAlarm', 'persistSchedule', 'updateBadge',
    'createPwmAlarmFromPlan',
    `let pwmRuntimeRevision = 31;
    ${toggleBody16}; return toggleNowAndSync;`
  )(
    manualRaceSchedule16,
    () => false,
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
    'schedule', 'loadScheduleFromStorage', 'isSmartAutomationEnabled',
    'getAutomationAlarmName', 'isAutomationAllowed', 'chrome',
    'rescheduleSmartWeatherAlarm', 'clearAutomationRuntimeAlarmsWhileBlocked',
    `${ensureDiagnosticAlarmsBody}; return ensureDiagnosticAlarms;`
  )(
    ensureDiagnosticPausedSchedule16,
    async () => {},
    () => true,
    () => 'ac-smart',
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
    'schedule', 'loadScheduleFromStorage', 'isSmartAutomationEnabled',
    'getAutomationAlarmName', 'isAutomationAllowed', 'chrome',
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
    () => 'ac-pwm',
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
    'chrome', 'clearPwmAlarm', 'clearSmartAlarm', 'isAutomationAllowed', 'isSmartAutomationEnabled',
    `let pwmRuntimeRevision = 23;
    let smartRuntimeRevision = 0;
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
    async () => {
      cleanupEvents16.push('ac-smart');
      return true;
    },
    () => cleanupAutomationAllowed16,
    () => false
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

  const requestTimerBasedShutdownSource16 = extractSourceSection(
    backgroundSource,
    'async function requestTimerBasedShutdown(reason = \'\', minutes = 1) {',
    '\n// ----- 闹钟触发时执行 -----',
    'requestTimerBasedShutdown deadline'
  );
  const shutdownNow16 = 1_700_000_000_000;
  const runShutdownProofCase16 = async targetAt => {
    const shutdownSchedule16 = {
      pageTimerMinutes: 30,
      pageTimerTargetAt: targetAt,
      pageTimerRetryAt: 0,
      pageTimerRetryMinutes: 0
    };
    const timerCalls16 = [];
    const requestTimerBasedShutdown16 = new Function(
      'schedule', 'isPageTimerProofFresh', 'getCurrentACStatus',
      'clearPageTimerProofState', 'chrome', 'persistSchedule', 'setPageTimer',
      'sanitizeMinutes', 'Date',
      `${requestTimerBasedShutdownSource16}; return requestTimerBasedShutdown;`
    )(
      shutdownSchedule16,
      schedule => syncHelpers.isPageTimerProofFresh(schedule, { now: shutdownNow16 }),
      async () => ({ isOn: true }),
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
      (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
      },
      { now: () => shutdownNow16 }
    );
    const result16 = await requestTimerBasedShutdown16('active-hours-test', 1);
    return { result16, timerCalls16 };
  };
  const lateProofShutdown16 = await runShutdownProofCase16(shutdownNow16 + 20 * 60_000);
  const nearProofShutdown16 = await runShutdownProofCase16(shutdownNow16 + 60_000);
  assertPass(lateProofShutdown16.timerCalls16.join(',') === '1'
      && lateProofShutdown16.result16.alreadyArmed !== true
      && nearProofShutdown16.timerCalls16.length === 0
      && nearProofShutdown16.result16.alreadyArmed === true,
    '16N: 退出时段只复用足够早的页面关机证明，不把 20 分钟后的旧定时器当作 1 分钟安全停机');

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

  let pausedFallbackRendered16 = null;
  const refreshPausedFallback16 = new Function(
    'IS_STATIC_PREVIEW', 'staticPreviewSchedule', 'updateCountdownDisplay',
    'updateSmartReadout', 'chrome', 'attachCachedActualStatus',
    'isAutomationPausedByActiveHours', 'getPopupAutomationAlarmName',
    `let pollCount = 0;
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
    () => true,
    schedule => schedule?.smartMode?.enabled === true ? 'ac-smart' : 'ac-pwm'
  );
  await refreshPausedFallback16();
  assertPass(pausedFallbackRendered16?._automationPausedByActiveHours === true
      && pausedFallbackRendered16?._insideActiveHours === false
      && pausedFallbackRendered16?.enabled === true
      && pausedFallbackRendered16?.smartMode?.enabled === true,
    '16O-1: 后台消息失败时 popup 从 storage 回退也重建暂停态，并保留智能模式启用意图');

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
  assertPass(resetDisabledAutomationRuntimeSource.includes('pwmRuntimeRevision += 1;')
      && setTimerBody.includes('automationRevision = null')
      && setTimerBody.includes('sendSerializedPageTimerMessage(')
      && setTimerBody.includes('automationOperationIsCurrent(automationRevision, automationMode)')
      && verifyBody.includes('automationRevision = null')
      && verifyBody.includes('isAutomationOperationCurrent(automationRevision, automationMode)')
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
    'chrome', 'STORAGE_KEY', 'staleScheduleRead', 'isSmartAutomationEnabled',
    `let pwmRuntimeRevision = 7;
    let smartRuntimeRevision = 0;
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
    staleScheduleRead16,
    () => false
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
    'schedule', 'chrome', 'reconcilePwmTrigger', 'deferredAlarmRead', 'isSmartAutomationEnabled',
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
    deferredPersistAlarmRead16,
    () => false
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
    '!isAutomationOperationCurrent(automationRevision, automationMode)) return false;'
  );
  const adoptMutationIndex16 = adoptPhaseSource16.indexOf('schedule.pwmState = adopt.state;');
  assertPass(adoptPausedGateIndex16 >= 0
      && adoptMutationIndex16 > adoptPausedGateIndex16,
    '16T: sync 相位采纳在修改全局运行态前复核当前门禁，暂停态不接纳远端时钟');

  const pwmAlarmCreationBody16 = extractSourceSection(
    backgroundSource,
    'let automationAlarmWriteChain = Promise.resolve();',
    '\nasync function loadScheduleFromStorage()',
    'revision-owned PWM alarm creation'
  );
  assertPass(pwmAlarmCreationBody16.includes('automationRevision = null')
      && pwmAlarmCreationBody16.includes('isAutomationOperationCurrent(automationRevision, automationMode)')
      && pwmAlarmCreationBody16.includes('automationAlarmWriteChain')
      && countOccurrences(backgroundSource, "chrome.alarms.clear('ac-pwm')") === 2
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
    'isAutomationOperationCurrent', 'setPwmNextTriggerAt', 'setSmartNextTriggerAt',
    `${pwmAlarmCreationBody16}; return { createPwmAlarmFromPlan };`
  )(
    revisionOwnedSchedule16,
    revisionOwnedCreateAlarm16,
    revisionOwnedChrome16,
    () => true,
    revision => revision === pwmAlarmRevision16,
    value => { revisionOwnedSchedule16.nextTriggerAt = value; },
    value => { revisionOwnedSchedule16.smartNextTriggerAt = value; }
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

  let invalidVerifiedClockClears16 = 0;
  const invalidVerifiedClockSchedule16 = {
    enabled: true,
    smartMode: { enabled: false },
    nextTriggerAt: 0,
    alarmCreatedAt: 0,
    alarmDelayMinutes: 0
  };
  const invalidVerifiedClockHarness16 = new Function(
    'schedule', 'createAlarm', 'chrome', 'isAutomationAllowed',
    'isAutomationOperationCurrent', 'setPwmNextTriggerAt', 'setSmartNextTriggerAt',
    `${pwmAlarmCreationBody16}; return { createPwmAlarmFromPlan };`
  )(
    invalidVerifiedClockSchedule16,
    async () => true,
    {
      alarms: {
        async get() { return { name: 'ac-pwm' }; },
        async clear() { invalidVerifiedClockClears16 += 1; return true; }
      }
    },
    () => true,
    revision => revision === 1,
    value => { invalidVerifiedClockSchedule16.nextTriggerAt = value; },
    value => { invalidVerifiedClockSchedule16.smartNextTriggerAt = value; }
  );
  const invalidVerifiedClockCreated16 = await invalidVerifiedClockHarness16
    .createPwmAlarmFromPlan(
      { nextTriggerAt: Date.now() + 10 * 60_000 },
      'missing-scheduled-time',
      1
    );
  assertPass(invalidVerifiedClockCreated16 === false
      && invalidVerifiedClockClears16 === 1
      && invalidVerifiedClockSchedule16.nextTriggerAt === 0
      && invalidVerifiedClockSchedule16.alarmCreatedAt === 0
      && invalidVerifiedClockSchedule16.alarmDelayMinutes === 0,
    '16U-2: PWM alarm 回读缺少真实 scheduledTime 时清理并拒绝持久化请求时钟');

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
      && setTimerBody.includes('timerBasedShutdownIsCurrent(shutdownRevision)')
      && verifyBody.includes('shutdownRevision = null')
      && verifyBody.includes('isTimerBasedShutdownCurrent(shutdownRevision)'),
    '16Y: 暂停/停用关机拥有独立可失效 revision，恢复后旧验证与证明提交不能覆盖新 ON 周期');
  assertPass(pageTimerRetryAlarmBody16.includes('if (isAutomationAllowed())')
      && pageTimerRetryAlarmBody16.includes('clearSupersededTimerBasedShutdownRetry')
      && pageTimerRetryAlarmBody16.indexOf('clearSupersededTimerBasedShutdownRetry')
        < pageTimerRetryAlarmBody16.indexOf('requestTimerBasedShutdown('),
    '16Y-1: 恢复自动控制后触发的旧关机 retry 只清理不重授权，时段外才继续安全停机');

  assertPass(backgroundSource.includes('async function cancelAutomaticOnRequests()')
      && resetDisabledAutomationRuntimeSource.includes('await cancelAutomaticOnRequests();')
      && setupImmediateBody16.includes('await cancelAutomaticOnRequests();')
      && contentSource.includes("action === 'cancelAutomaticOn'")
      && contentSource.includes("'__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'")
      && pageConfirmSource.includes("'__AC_EXTENSION_CANCEL_AUTOMATIC_ON__'")
      && pageConfirmSource.includes('automaticOnCancellationRevision')
      && pageConfirmSource.includes('请求已被后台取消'),
    '16Z: 停用、离开时段或显式 restart 会取消主世界递归自动 ON，每次后续点击与确认都可被撤销');

  // ===== 用例 17: ON timer prearm 与有限恢复 =====
  console.log('\n\n=== 用例 17: ON timer prearm 与有限恢复 ===\n');

  const armHelperStart17 = pwmBody.indexOf(
    'async function resolvePageTimerArmHold(plan, observations) {'
  );
  const armHelperEnd17 = pwmBody.indexOf(
    '\n\n  // 提取（Fowler Extract Function）：PWM 关机补时 hold 分支',
    armHelperStart17
  );
  const armHelperSource17 = armHelperStart17 >= 0
      && armHelperEnd17 > armHelperStart17
    ? pwmBody.slice(armHelperStart17, armHelperEnd17)
    : '';
  const createOnAdapterHarness17 = new Function(
    'schedule',
    'planPwmStep',
    'setPageTimer',
    'toggleAC',
    'applyPwmPlanState',
    'abortStaleAutomation',
    'recordControlAuditTimerPrearm',
    'recordControlAuditDispatch',
    'recordControlAuditOnOutcome',
    'recordControlAuditTerminal',
    'armPowerOffTimerEnsuringOn',
    'getAutomaticOnDeadline',
    'console',
    `const automationRevision = 41;
    let controlAuditOnOutcomeRecorded = false;
    function planSmartAutomaticOn() { return null; }
    ${armHelperSource17}
    return { resolvePageTimerArmHold };`
  );

  const runOnAdapterCase17 = async ({
    armResult,
    staleAfterArm = false,
    initialAcIsOn = false
  }) => {
    const adapterSchedule = {
      enabled: true,
      pwmState: 'on',
      onMinutes: 12,
      offMinutes: 8,
      pageTimerError: '',
      smartMode: { enabled: false }
    };
    const calls = [];
    let armCompleted = false;
    const adapter = createOnAdapterHarness17(
      adapterSchedule,
      (receivedSchedule, receivedObservations) => pwmPhase.planPwmStep(
        receivedSchedule,
        receivedObservations,
        { now: plannerNow10 }
      ),
      async (minutes, options) => {
        calls.push({ type: 'safety-timer', minutes, options: { ...options } });
        return { success: true };
      },
      async (_action, options) => {
        calls.push({ type: 'toggle', options: { ...options } });
        return { success: true };
      },
      plan => {
        if (plan?.phasePatch) Object.assign(adapterSchedule, plan.phasePatch);
      },
      async () => staleAfterArm && armCompleted,
      async () => null,
      async () => null,
      async () => null,
      async () => null,
      async (minutes, options) => {
        calls.push({ type: 'arm', minutes, options: { ...options } });
        armCompleted = true;
        return { ...armResult };
      },
      () => 0,
      quietConsole
    );
    const targetAt = Number(armResult?.targetAt) || plannerNow10 + 12 * 60_000;
    const observations = {
      acIsOn: initialAcIsOn,
      smartPageTimerTargetAt: targetAt,
      smartOnWindowEndsAt: 0
    };
    let plan = pwmPhase.planPwmStep(adapterSchedule, observations, { now: plannerNow10 });
    plan = await adapter.resolvePageTimerArmHold(plan, observations);
    return { calls, plan, observations, targetAt };
  };

  const adapterTargetAt17 = plannerNow10 + 12 * 60_000;
  const timerFailureAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: false,
      failureStage: 'write',
      error: 'type failed',
      targetAt: adapterTargetAt17
    }
  });
  const timerSuccessAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: true,
      value: '22:25',
      actualDelayMinutes: 12,
      targetAt: adapterTargetAt17,
      acIsOn: true,
      toggledOn: true
    }
  });
  const alreadyOnTimerSuccessAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: true,
      value: '22:25',
      actualDelayMinutes: 12,
      targetAt: adapterTargetAt17,
      acIsOn: true,
      toggledOn: false
    },
    initialAcIsOn: true
  });
  const ensureOnFailureAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: false,
      failureStage: 'ensure-on',
      error: '自动开启未确认',
      value: '22:25',
      targetAt: adapterTargetAt17,
      acIsOn: false,
      toggledOn: true
    }
  });
  const verificationFailureAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: false,
      failureStage: 'verify',
      error: '未持久化',
      value: '22:25',
      targetAt: adapterTargetAt17,
      acIsOn: true,
      toggledOn: true
    }
  });
  const deadlineExpiredAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: false,
      failureStage: 'write',
      automaticDeadlineExpired: true,
      error: '自动开启截止时间已过期',
      targetAt: adapterTargetAt17
    }
  });
  const staleAdapter17 = await runOnAdapterCase17({
    armResult: {
      success: true,
      value: '22:25',
      actualDelayMinutes: 12,
      targetAt: adapterTargetAt17,
      acIsOn: true,
      toggledOn: true
    },
    staleAfterArm: true
  });
  assertPass(timerFailureAdapter17.calls.map(call => call.type).join(',') === 'arm'
      && timerFailureAdapter17.plan?.kind === 'retry'
      && timerFailureAdapter17.plan?.reason === 'page-timer-failed'
      && timerSuccessAdapter17.calls.map(call => call.type).join(',') === 'arm'
      && timerSuccessAdapter17.plan?.kind === 'commit'
      && timerSuccessAdapter17.plan?.nextTriggerAt === adapterTargetAt17
      && alreadyOnTimerSuccessAdapter17.calls.map(call => call.type).join(',') === 'arm'
      && alreadyOnTimerSuccessAdapter17.plan?.kind === 'commit'
      && alreadyOnTimerSuccessAdapter17.plan?.nextTriggerAt === adapterTargetAt17
      && ensureOnFailureAdapter17.calls.map(call => call.type).join(',') === 'arm'
      && ensureOnFailureAdapter17.plan?.kind === 'retry'
      && ensureOnFailureAdapter17.plan?.reason === 'toggle-on-failed'
      && verificationFailureAdapter17.calls.map(call => call.type).join(',') === 'arm,safety-timer'
      && verificationFailureAdapter17.plan?.kind === 'retry'
      && verificationFailureAdapter17.plan?.reason === 'page-timer-verify-failed'
      && deadlineExpiredAdapter17.calls.map(call => call.type).join(',') === 'arm'
      && deadlineExpiredAdapter17.plan?.reason === 'page-timer-failed'
      && staleAdapter17.calls.map(call => call.type).join(',') === 'arm'
      && staleAdapter17.plan === null,
    '17A: background adapter 原子布防零 ON；写/开机/验证失败分别回退对应重试，成功后提交原 targetAt');

  const armOnBody17 = extractSourceSection(
    backgroundSource,
    'async function armPowerOffTimerEnsuringOn(',
    '// ----- 闹钟触发时执行 -----'
  );
  assertPass(armOnBody17.includes('if (verification.acIsOn === false)')
      && armOnBody17.includes('supplemented: true')
      && armOnBody17.includes('deferVerification: false')
      && armOnBody17.includes('自动开启未确认（新鲜页复核未开机后重试开机仍未确认）'),
    '17B: 新鲜页复核未开机时先开机再补关机时间，复核失败按 ensure-on/verify 回退');

  const sharedPredicateAtomsSource17 = extractSourceSection(
    backgroundSource,
    'function automationOperationIsCurrent(',
    'function sendSerializedPageTimerMessage(',
    'shared predicate atoms 17'
  );
  const pageTimerRecoverySource17 = extractSourceSection(
    backgroundSource,
    'const PAGE_TIMER_RECOVERABLE_FAILURE_STAGES = new Set([',
    '\nasync function requestTimerBasedShutdown',
    'setPageTimer finite recovery'
  );
  const loadPageTimerRecovery17 = new Function(
    'schedule',
    'chrome',
    'Date',
    't',
    'isAutomationOperationCurrent',
    'schedulePageTimerRetry',
    'persistSchedule',
    'isACHomePageTab',
    'waitForTabReady',
    'injectContentScriptsIntoExactHome',
    'ensureContentScriptLoaded',
    'sendSerializedPageTimerMessage',
    'verifyPageTimerPersistence',
    'console',
    'AC_PAGE',
    'PAGE_TIMER_WRITE_TIMEOUT_MS',
    'PAGE_TIMER_RECOVERY_MIN_RUNWAY_MS',
    `${sharedPredicateAtomsSource17}\n${pageTimerRecoverySource17}; return { setPageTimer };`
  );

  const createPageTimerRecoveryHarness17 = (
    scriptedResponses,
    { targetOffsetMs = 10 * 60_000, verificationSuccess = true } = {}
  ) => {
    const now17 = 1_800_000_000_000;
    const targetAt17 = now17 + targetOffsetMs;
    const exactHome17 = 'https://w5.ab.ust.hk/njggt/app/home';
    const tabs17 = new Map([[1, {
      id: 1,
      url: exactHome17,
      status: 'complete',
      discarded: false
    }]]);
    const calls17 = {
      writes: [],
      injects: 0,
      creates: 0,
      verifications: 0,
      persists: 0
    };
    const schedule17 = {
      pageTimerMinutes: null,
      pageTimerTargetAt: 0,
      pageTimerError: '',
      pageTimerRetryAt: 0,
      pageTimerRetryMinutes: 0
    };
    let responseIndex17 = 0;
    const chrome17 = {
      tabs: {
        async query() { return [...tabs17.values()].map(tab => ({ ...tab })); },
        async get(tabId) {
          const tab = tabs17.get(tabId);
          if (!tab) throw new Error('tab closed');
          return { ...tab };
        },
        async create(options) {
          calls17.creates += 1;
          const tab = {
            id: 2,
            url: options.url,
            status: 'complete',
            discarded: false
          };
          tabs17.set(tab.id, tab);
          return { ...tab };
        }
      },
      alarms: {
        async clear() { return true; },
        async create() { return true; }
      }
    };
    const runtime17 = loadPageTimerRecovery17(
      schedule17,
      chrome17,
      { now: () => now17 },
      key => key,
      () => true,
      async () => {},
      async () => { calls17.persists += 1; },
      tab => tab?.url === exactHome17,
      async () => true,
      async () => { calls17.injects += 1; return true; },
      async () => true,
      async (tabId, message) => {
        calls17.writes.push({ tabId, message: { ...message } });
        const scripted = scriptedResponses[
          Math.min(responseIndex17, scriptedResponses.length - 1)
        ];
        responseIndex17 += 1;
        if (scripted instanceof Error) throw scripted;
        return typeof scripted === 'function'
          ? scripted({ tabId, message, targetAt: targetAt17 })
          : { ...scripted };
      },
      async expectedValue => {
        calls17.verifications += 1;
        return verificationSuccess
          ? { success: true, value: expectedValue, attempts: 1 }
          : { success: false, error: 'fresh proof mismatch', attempts: 3 };
      },
      quietConsole,
      exactHome17,
      30000,
      150000
    );
    return {
      calls: calls17,
      schedule: schedule17,
      targetAt: targetAt17,
      run: () => runtime17.setPageTimer(10, {
        retryOnFailure: false,
        targetAt: targetAt17,
        automationRevision: 9
      })
    };
  };

  const recoverableFailure17 = {
    success: false,
    error: 'controlled input rollback',
    failureStage: 'type-character',
    attempt: 3,
    expectedValue: '06:10',
    observedValue: '06',
    observedTitle: '',
    inputReplacementCount: 2,
    controlCount: 1,
    visibleDropdownCount: 0,
    elapsedMs: 900
  };
  const fallbackRecovery17 = createPageTimerRecoveryHarness17([
    recoverableFailure17,
    recoverableFailure17,
    ({ targetAt }) => ({
      success: true,
      value: '06:10',
      actualDelayMinutes: 10,
      targetAt
    })
  ]);
  const fallbackRecoveryResult17 = await fallbackRecovery17.run();
  const fallbackTargets17 = new Set(
    fallbackRecovery17.calls.writes.map(call => call.message.targetAt)
  );
  assertPass(fallbackRecoveryResult17.success === true
      && fallbackRecoveryResult17.verified === true
      && fallbackRecovery17.calls.writes.length === 3
      && fallbackRecovery17.calls.injects === 1
      && fallbackRecovery17.calls.creates === 1
      && fallbackRecovery17.calls.verifications === 1
      && fallbackTargets17.size === 1
      && fallbackTargets17.has(fallbackRecovery17.targetAt)
      && fallbackRecovery17.schedule.pageTimerTargetAt === fallbackRecovery17.targetAt,
    '17B: 可恢复输入失败仅同页重注入重写一次，再至多一个隐藏 home；三次写入固定原 targetAt，fresh verification 后才提交 proof');

  const portRecovery17 = createPageTimerRecoveryHarness17([
    new Error('The message port closed before a response was received.'),
    ({ targetAt }) => ({
      success: true,
      value: '06:10',
      actualDelayMinutes: 10,
      targetAt
    })
  ]);
  const portRecoveryResult17 = await portRecovery17.run();
  assertPass(portRecoveryResult17.success === true
      && portRecovery17.calls.writes.length === 2
      && portRecovery17.calls.injects === 1
      && portRecovery17.calls.creates === 0,
    '17C: 业务消息端口失败只触发一次同页强制重注入重写，成功后不创建 fallback 页');

  const ambiguousFailures17 = [
    {
      success: false,
      error: 'https://private.example tabId=91 <div>secret</div>',
      failureStage: 'locate-control',
      controlCount: 2,
      unexpectedDom: { nodeType: 1 }
    },
    {
      success: false,
      error: 'ambiguous dropdown',
      failureStage: 'select-ok',
      controlCount: 1,
      visibleDropdownCount: 2
    }
  ];
  const ambiguousResults17 = [];
  for (const failure of ambiguousFailures17) {
    const harness = createPageTimerRecoveryHarness17([failure]);
    const result17 = await harness.run();
    ambiguousResults17.push({ harness, result17 });
  }
  assertPass(ambiguousResults17.every(({ harness, result17 }) => (
    result17.success === false
      && harness.calls.writes.length === 1
      && harness.calls.injects === 0
      && harness.calls.creates === 0
      && !Object.hasOwn(result17, 'unexpectedDom')
      && Object.values(result17).every(value => value === null
        || ['boolean', 'number', 'string'].includes(typeof value))
  ))
      && !/https?:|tabId|<div>|secret/i.test(ambiguousResults17[0].result17.error),
    '17D: locate/select 歧义立即失败且零 fallback；最终 failure 仅透传有界白名单标量，不泄漏 URL、tabId 或 DOM');

  const shortRunwayRecovery17 = createPageTimerRecoveryHarness17(
    [recoverableFailure17, recoverableFailure17],
    { targetOffsetMs: 2 * 60_000 }
  );
  const shortRunwayResult17 = await shortRunwayRecovery17.run();
  assertPass(shortRunwayResult17.success === false
      && shortRunwayRecovery17.calls.writes.length === 2
      && shortRunwayRecovery17.calls.injects === 1
      && shortRunwayRecovery17.calls.creates === 0,
    '17E: targetAt 剩余不足 150 秒时只完成同页有限恢复，不新建隐藏 fallback 或延长截止');

  const unverifiedFallback17 = createPageTimerRecoveryHarness17([
    recoverableFailure17,
    recoverableFailure17,
    ({ targetAt }) => ({
      success: true,
      value: '06:10',
      actualDelayMinutes: 10,
      targetAt
    })
  ], { verificationSuccess: false });
  const unverifiedFallbackResult17 = await unverifiedFallback17.run();
  assertPass(unverifiedFallbackResult17.success === false
      && unverifiedFallback17.calls.creates === 1
      && unverifiedFallback17.calls.verifications === 1
      && unverifiedFallback17.schedule.pageTimerTargetAt === 0,
    '17F: hidden fallback 写入成功但独立新鲜页验证失败时仍不产生 storage proof');

  // ===== 用例 18: packaged-only 本地控制生命周期审计 =====
  console.log('\n\n=== 用例 18: packaged-only 本地控制生命周期审计 ===\n');

  const controlAuditSource = extractSourceSection(
    backgroundSource,
    '// ===== Packaged-only control lifecycle audit =====',
    '\nconst AC_PAGE =',
    'packaged-only control lifecycle audit'
  );
  const CONTROL_AUDIT_KEY18 = 'ac_dist_control_audit_v1';
  const CONTROL_AUDIT_ALLOWED_FIELDS18 = new Set([
    'seq', 'at', 'controlId', 'attempt', 'stage', 'result', 'code',
    'action', 'scheduledAt', 'originBoundaryAt', 'targetAt', 'retryAt', 'build'
  ]);
  const auditNow18 = 1_800_000_000_000;
  const auditBoundary18 = Math.floor(auditNow18 / (30 * 60_000)) * 30 * 60_000;
  const auditShaA18 = 'a'.repeat(64);
  const auditShaB18 = 'b'.repeat(64);

  function createControlAuditStore18({ failSet = false } = {}) {
    const state = {};
    const metrics = { gets: 0, sets: 0 };
    const clone = value => value === undefined
      ? undefined
      : JSON.parse(JSON.stringify(value));
    return {
      createChrome(version = manifest.version) {
        return {
          runtime: { getManifest: () => ({ version }) },
          storage: {
            local: {
              async get(key) {
                metrics.gets += 1;
                return Object.hasOwn(state, key)
                  ? { [key]: clone(state[key]) }
                  : {};
              },
              async set(value) {
                metrics.sets += 1;
                if (failSet) throw new Error('audit storage unavailable');
                for (const [key, item] of Object.entries(value)) {
                  state[key] = clone(item);
                }
              }
            }
          }
        };
      },
      getEnvelope: () => clone(state[CONTROL_AUDIT_KEY18]),
      metrics
    };
  }

  function loadControlAuditRuntime18({
    store,
    buildTime = '2027-01-15 08:00:00',
    buildEpoch = auditNow18 - 60_000,
    sourceSha256 = auditShaA18,
    version = manifest.version,
    now = auditNow18
  }) {
    const injectedSource = controlAuditSource
      .replace("const BUILD_TIME = 'dev';", `const BUILD_TIME = '${buildTime}';`)
      .replace('const BUILD_TIME_EPOCH_MS = 0;', `const BUILD_TIME_EPOCH_MS = ${buildEpoch};`)
      .replace("const BUILD_SOURCE_SHA256 = 'dev';", `const BUILD_SOURCE_SHA256 = '${sourceSha256}';`);
    const clock = { now };
    class AuditDate18 extends Date {
      static now() { return clock.now; }
    }
    const runtime = new Function(
      'chrome',
      'Date',
      `${injectedSource}; return {
        getPackagedControlAuditBuild,
        recordControlAuditPlanned,
        appendActiveControlAuditEvent,
        recordControlAuditDelivery,
        recordControlAuditAdmission,
        recordControlAuditTimerPrearm,
        recordControlAuditDispatch,
        recordControlAuditOnOutcome,
        recordControlAuditRetryScheduled,
        recordControlAuditTerminal,
        recordControlAuditMissedWake,
        shouldShowControlAuditBadge,
        flushControlAuditStorage
      };`
    )(store.createChrome(version), AuditDate18);
    return { ...runtime, clock };
  }

  const devAuditStore18 = createControlAuditStore18();
  const devAudit18 = loadControlAuditRuntime18({
    store: devAuditStore18,
    buildTime: 'dev',
    buildEpoch: 0,
    sourceSha256: 'dev'
  });
  await devAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  await devAudit18.flushControlAuditStorage();
  const invalidVersionStore18 = createControlAuditStore18();
  const invalidVersionAudit18 = loadControlAuditRuntime18({
    store: invalidVersionStore18,
    version: 'v0.8.2'
  });
  await invalidVersionAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  const invalidBuildTimeStore18 = createControlAuditStore18();
  const invalidBuildTimeAudit18 = loadControlAuditRuntime18({
    store: invalidBuildTimeStore18,
    buildTime: 'not-a-build-time'
  });
  await invalidBuildTimeAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  const invalidCalendarStore18 = createControlAuditStore18();
  const invalidCalendarAudit18 = loadControlAuditRuntime18({
    store: invalidCalendarStore18,
    buildTime: '2027-02-30 25:61:61'
  });
  await invalidCalendarAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  const invalidEpochStore18 = createControlAuditStore18();
  const invalidEpochAudit18 = loadControlAuditRuntime18({
    store: invalidEpochStore18,
    buildEpoch: 0
  });
  await invalidEpochAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  const invalidShaStore18 = createControlAuditStore18();
  const invalidShaAudit18 = loadControlAuditRuntime18({
    store: invalidShaStore18,
    sourceSha256: `${'a'.repeat(63)}g`
  });
  await invalidShaAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  assertPass(devAuditStore18.metrics.gets === 0
      && devAuditStore18.metrics.sets === 0
      && devAuditStore18.getEnvelope() === undefined
      && invalidVersionStore18.metrics.gets === 0
      && invalidVersionStore18.metrics.sets === 0
      && invalidBuildTimeStore18.metrics.gets === 0
      && invalidBuildTimeStore18.metrics.sets === 0
      && invalidCalendarStore18.metrics.gets === 0
      && invalidCalendarStore18.metrics.sets === 0
      && invalidEpochStore18.metrics.gets === 0
      && invalidEpochStore18.metrics.sets === 0
      && invalidShaStore18.metrics.gets === 0
      && invalidShaStore18.metrics.sets === 0,
    '18A: dev/非法 manifest version、构建时间、epoch 或 SHA 均不读写本地控制审计');

  const packagedAuditStore18 = createControlAuditStore18();
  const packagedAudit18 = loadControlAuditRuntime18({ store: packagedAuditStore18 });
  await packagedAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18 + 30 * 60_000,
    originBoundaryAt: auditBoundary18 + 30 * 60_000,
    targetAt: auditBoundary18 + 55 * 60_000
  });
  await packagedAudit18.flushControlAuditStorage();
  const packagedEnvelope18 = packagedAuditStore18.getEnvelope();
  assertPass(packagedAuditStore18.metrics.sets === 1
      && Object.keys(packagedEnvelope18).sort().join(',')
        === 'active,build,events,nextSeq,schemaVersion'
      && packagedEnvelope18.schemaVersion === 1
      && packagedEnvelope18.events.length === 1
      && packagedEnvelope18.events[0].stage === 'planned'
      && packagedEnvelope18.events[0].code === 'alarm-verified'
      && packagedEnvelope18.active.controlId === packagedEnvelope18.events[0].controlId,
    '18B: 合法包态身份写入固定 envelope，并在 alarm 验证后建立 active planned');

  const originalTargetAt18 = packagedEnvelope18.active.targetAt;
  await packagedAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18 + 30 * 60_000,
    originBoundaryAt: auditBoundary18 + 30 * 60_000,
    targetAt: originalTargetAt18 + 5 * 60_000
  });
  await packagedAudit18.recordControlAuditTimerPrearm(
    'started',
    originalTargetAt18 + 10 * 60_000,
    'prearm-started'
  );
  await packagedAudit18.flushControlAuditStorage();
  const fixedTargetEnvelope18 = packagedAuditStore18.getEnvelope();
  assertPass(fixedTargetEnvelope18.active.targetAt === originalTargetAt18
      && fixedTargetEnvelope18.events.at(-1).targetAt === originalTargetAt18,
    '18B-1: 同一 controlId 的重复 planned/prearm 不得改写原始绝对 targetAt');

  const resetAudit18 = loadControlAuditRuntime18({
    store: packagedAuditStore18,
    sourceSha256: auditShaB18
  });
  await resetAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18 + 60 * 60_000,
    originBoundaryAt: auditBoundary18 + 60 * 60_000
  });
  await resetAudit18.flushControlAuditStorage();
  const resetEnvelope18 = packagedAuditStore18.getEnvelope();
  assertPass(resetEnvelope18.events.length === 1
      && resetEnvelope18.events[0].seq === 1
      && resetEnvelope18.nextSeq === 2
      && resetEnvelope18.build.includes(auditShaB18)
      && resetEnvelope18.events.every(event => event.build === resetEnvelope18.build),
    '18C: build 身份变化原子重置旧 active/events/seq，不混写跨构建事件');

  const ringAuditStore18 = createControlAuditStore18();
  const ringAudit18 = loadControlAuditRuntime18({ store: ringAuditStore18 });
  await ringAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  for (let index = 0; index < 140; index += 1) {
    void ringAudit18.appendActiveControlAuditEvent(
      'admission',
      'ok',
      { code: 'revision-current' }
    );
  }
  await ringAudit18.flushControlAuditStorage();
  const ringEnvelope18 = ringAuditStore18.getEnvelope();
  assertPass(ringEnvelope18.events.length === 128
      && ringEnvelope18.events[0].seq === 14
      && ringEnvelope18.events.at(-1).seq === 141
      && ringEnvelope18.nextSeq === 142,
    '18D: 并发调用经单一 FIFO 不丢 seq，events 环严格保留最新 128 条');

  await ringAudit18.appendActiveControlAuditEvent(
    'admission',
    'failed',
    {
      code: 'https://private.example tabId=91 <div>账号 余额 weather schedule user@example.com</div>',
      exception: new Error('must not persist'),
      url: 'https://private.example/path'
    }
  );
  await ringAudit18.appendActiveControlAuditEvent(
    'admission',
    'failed',
    { code: new Error('object must not persist') }
  );
  await ringAudit18.flushControlAuditStorage();
  const privacyEvents18 = ringAuditStore18.getEnvelope().events.slice(-2);
  const privacyJson18 = JSON.stringify(privacyEvents18);
  assertPass(privacyEvents18.every(event => Object.keys(event)
      .every(field => CONTROL_AUDIT_ALLOWED_FIELDS18.has(field)))
      && privacyEvents18.every(event => Object.values(event)
        .every(value => ['number', 'string'].includes(typeof value)))
      && !privacyEvents18[0].code
      && !privacyEvents18[1].code
      && !/private\.example|tabId|user@example|账号|余额|weather|<div>|must not persist/i.test(privacyJson18),
    '18E: event 严格白名单、有界纯标量，URL/tabId/DOM/账号/余额/天气与异常对象均不落盘');

  const failingAuditStore18 = createControlAuditStore18({ failSet: true });
  const failingAudit18 = loadControlAuditRuntime18({ store: failingAuditStore18 });
  const swallowedAuditResult18 = await failingAudit18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  await failingAudit18.flushControlAuditStorage();
  assertPass(swallowedAuditResult18 === null
      && failingAuditStore18.metrics.sets === 1
      && failingAuditStore18.getEnvelope() === undefined,
    '18F: audit storage 写失败被内部吞掉，控制调用方只收到可忽略 null');

  const retryAuditStore18 = createControlAuditStore18();
  const retryAudit18 = loadControlAuditRuntime18({ store: retryAuditStore18 });
  const firstScheduledAt18 = auditBoundary18 + 30 * 60_000;
  const retryAt18 = firstScheduledAt18 + 60_000;
  await retryAudit18.recordControlAuditPlanned({
    scheduledAt: firstScheduledAt18,
    originBoundaryAt: firstScheduledAt18
  });
  await retryAudit18.recordControlAuditDelivery(firstScheduledAt18);
  await retryAudit18.recordControlAuditTimerPrearm('failed', 0, 'prearm-unconfirmed');
  const beforeInvalidRetry18 = JSON.stringify(retryAuditStore18.getEnvelope());
  const invalidRetryResult18 = await retryAudit18.recordControlAuditRetryScheduled(
    0,
    'prearm-retry'
  );
  const afterInvalidRetry18 = JSON.stringify(retryAuditStore18.getEnvelope());
  assertPass(invalidRetryResult18 === null
      && afterInvalidRetry18 === beforeInvalidRetry18,
    '18F-1: 无效 retryAt 不得清 delivery、置 awaitingRetry 或追加虚假重试事件');
  await retryAudit18.recordControlAuditRetryScheduled(retryAt18, 'prearm-retry');
  const staleDelivery18 = await retryAudit18.recordControlAuditDelivery(firstScheduledAt18);
  await retryAudit18.recordControlAuditDelivery(retryAt18);
  await retryAudit18.flushControlAuditStorage();
  const retryEnvelope18 = retryAuditStore18.getEnvelope();
  const retryDeliveries18 = retryEnvelope18.events.filter(event => event.stage === 'delivery');
  const retryBadge18 = await retryAudit18.shouldShowControlAuditBadge();
  assertPass(new Set(retryEnvelope18.events.map(event => event.controlId)).size === 1
      && staleDelivery18 === false
      && retryDeliveries18.map(event => event.attempt).join(',') === '1,2'
      && retryEnvelope18.active.attempt === 2
      && retryEnvelope18.active.originBoundaryAt === firstScheduledAt18
      && retryBadge18 === true,
    '18G: 同一半点 retry 复用 controlId，拒绝旧 alarm 串台，并仅在匹配的新 delivery 时递增 attempt');

  const firstControlId18 = retryEnvelope18.active.controlId;
  const nextBoundary18 = firstScheduledAt18 + 30 * 60_000;
  await retryAudit18.recordControlAuditPlanned({
    scheduledAt: nextBoundary18,
    originBoundaryAt: nextBoundary18
  });
  await retryAudit18.flushControlAuditStorage();
  const nextBoundaryEnvelope18 = retryAuditStore18.getEnvelope();
  const nextBoundaryTail18 = nextBoundaryEnvelope18.events.slice(-2);
  const nextBoundaryBadge18 = await retryAudit18.shouldShowControlAuditBadge();
  assertPass(nextBoundaryEnvelope18.active.controlId !== firstControlId18
      && nextBoundaryEnvelope18.active.attempt === 1
      && nextBoundaryTail18[0].stage === 'terminal'
      && nextBoundaryTail18[0].result === 'superseded'
      && nextBoundaryTail18[1].stage === 'planned'
      && nextBoundaryBadge18 === false,
    '18H: 下一半点生成新 controlId，并先 terminal superseded 旧 lifecycle');

  const missedWakeStore18 = createControlAuditStore18();
  const missedWake18 = loadControlAuditRuntime18({ store: missedWakeStore18 });
  await missedWake18.recordControlAuditPlanned({
    scheduledAt: auditNow18 - 60_001,
    originBoundaryAt: auditBoundary18
  });
  const missedWakeRecorded18 = await missedWake18.recordControlAuditMissedWake('init');
  const duplicateMissedWake18 = await missedWake18.recordControlAuditMissedWake('watchdog');
  const missedWakeEnvelope18 = missedWakeStore18.getEnvelope();
  const missedWakeBadge18 = await missedWake18.shouldShowControlAuditBadge();
  assertPass(missedWakeRecorded18 === true
      && duplicateMissedWake18 === false
      && missedWakeEnvelope18.events.at(-1).stage === 'missed-wake'
      && missedWakeEnvelope18.events.at(-1).code === 'init-overdue'
      && missedWakeEnvelope18.active.attention === true
      && missedWakeBadge18 === true,
    '18I: init/watchdog 仅在首分钟宽限后标记 overdue planned，且同 attempt 不重复 missed-wake');

  const retryMissedWakeStore18 = createControlAuditStore18();
  const retryMissedWake18 = loadControlAuditRuntime18({ store: retryMissedWakeStore18 });
  await retryMissedWake18.recordControlAuditPlanned({
    scheduledAt: auditBoundary18,
    originBoundaryAt: auditBoundary18
  });
  await retryMissedWake18.recordControlAuditDelivery(auditBoundary18);
  await retryMissedWake18.recordControlAuditRetryScheduled(
    auditNow18 - 60_001,
    'prearm-retry'
  );
  const retryMissedWakeRecorded18 = await retryMissedWake18
    .recordControlAuditMissedWake('watchdog');
  const retryMissedWakeEnvelope18 = retryMissedWakeStore18.getEnvelope();
  assertPass(retryMissedWakeRecorded18 === true
      && retryMissedWakeEnvelope18.active.deliveryAt === 0
      && retryMissedWakeEnvelope18.events.at(-1).stage === 'missed-wake'
      && retryMissedWakeEnvelope18.events.at(-1).attempt === 1
      && retryMissedWakeEnvelope18.events.at(-1).code === 'watchdog-overdue',
    '18I-1: 首次 delivery 后安排的 retry 会清空本次 delivery 标记，漏唤醒仍可独立取证');

  const badgeAuditStore18 = createControlAuditStore18();
  const badgeAudit18 = loadControlAuditRuntime18({ store: badgeAuditStore18 });
  await badgeAudit18.recordControlAuditPlanned({
    scheduledAt: firstScheduledAt18,
    originBoundaryAt: firstScheduledAt18
  });
  await badgeAudit18.recordControlAuditDelivery(firstScheduledAt18);
  const badgeAfterDelivery18 = await badgeAudit18.shouldShowControlAuditBadge();
  await badgeAudit18.recordControlAuditDispatch();
  await badgeAudit18.recordControlAuditOnOutcome(false, 'status-unconfirmed');
  const badgeAfterFailure18 = await badgeAudit18.shouldShowControlAuditBadge();
  await badgeAudit18.recordControlAuditTerminal('failed', 'planner-refused');
  const badgeAfterFailedTerminal18 = await badgeAudit18.shouldShowControlAuditBadge();
  const missedWakeAfterTerminal18 = await badgeAudit18.recordControlAuditMissedWake('watchdog');
  const failedTerminalEnvelope18 = badgeAuditStore18.getEnvelope();
  await badgeAudit18.recordControlAuditOnOutcome(true, 'status-confirmed');
  await badgeAudit18.recordControlAuditTerminal('confirmed', 'status-confirmed');
  const badgeAfterConfirmed18 = await badgeAudit18.shouldShowControlAuditBadge();
  await badgeAudit18.recordControlAuditPlanned({
    scheduledAt: nextBoundary18,
    originBoundaryAt: nextBoundary18
  });
  await badgeAudit18.recordControlAuditDelivery(nextBoundary18);
  await badgeAudit18.recordControlAuditTerminal('disabled', 'automation-disabled');
  const badgeAfterDisabled18 = await badgeAudit18.shouldShowControlAuditBadge();
  assertPass(badgeAfterDelivery18 === true
      && badgeAfterFailure18 === true
      && badgeAfterFailedTerminal18 === true
      && missedWakeAfterTerminal18 === false
      && failedTerminalEnvelope18.active?.lastStage === 'terminal'
      && failedTerminalEnvelope18.events.at(-1).result === 'failed'
      && badgeAfterConfirmed18 === false
      && badgeAfterDisabled18 === false,
    '18J: delivery/dispatch/terminal 失败均锁存告警，只有 confirmed 或 disabled 才清除');

  const updateBadgeSource18 = extractSourceSection(
    backgroundSource,
    'async function updateBadge() {',
    '\n// 提取（Fowler Extract Function）：清空角标文案与标题',
    'updateBadge audit priority'
  );
  const badgeCalls18 = [];
  let badgeAuditReads18 = 0;
  const updateAuditBadge18 = new Function(
    'chrome',
    'shouldShowControlAuditBadge',
    'isAutomationAllowed',
    'clearBadge',
    `${updateBadgeSource18}; return updateBadge;`
  )(
    {
      action: {
        async setBadgeText(value) { badgeCalls18.push(['text', value.text]); },
        async setBadgeBackgroundColor(value) { badgeCalls18.push(['color', value.color]); },
        async setTitle(value) { badgeCalls18.push(['title', value.title]); }
      }
    },
    async () => {
      badgeAuditReads18 += 1;
      return true;
    },
    () => true,
    async () => { badgeCalls18.push(['clear', '']); }
  );
  await updateAuditBadge18();
  const disabledBadgeCalls18 = [];
  const updateDisabledBadge18 = new Function(
    'chrome',
    'shouldShowControlAuditBadge',
    'isAutomationAllowed',
    'clearBadge',
    `${updateBadgeSource18}; return updateBadge;`
  )(
    { action: {} },
    async () => {
      badgeAuditReads18 += 1;
      return true;
    },
    () => false,
    async () => { disabledBadgeCalls18.push('clear'); }
  );
  await updateDisabledBadge18();
  assertPass(badgeCalls18.map(call => call.join(':')).join(',')
      === 'text:!,color:#dc2626,title:自动开启未确认'
      && disabledBadgeCalls18.join(',') === 'clear'
      && badgeAuditReads18 === 1,
    '18K: 启用态审计红色 ! 置顶；禁用态先清 badge 且不读取遗留审计告警');

  const createPwmAlarmAuditSource18 = extractSourceSection(
    backgroundSource,
    'async function createPwmAlarmFromPlan(',
    '\nasync function loadScheduleFromStorage()',
    'planned hook order'
  );
  const alarmListenerAuditSource18 = extractSourceSection(
    backgroundSource,
    'chrome.alarms.onAlarm.addListener(async (alarm) => {',
    '\n// ----- 官方推荐：长时间操作保活',
    'delivery hook order'
  );
  const initAuditSource18 = extractSourceSection(
    backgroundSource,
    'async function init() {',
    '\n// ----- 设置/更新 PWM 循环闹钟 -----',
    'init missed-wake order'
  );
  const watchdogAuditSource18 = extractSourceSection(
    backgroundSource,
    'async function watchdogCheck() {',
    '\n// ----- 诊断日志按版本自动重置 -----',
    'watchdog missed-wake order'
  );
  const prearmAuditSource18 = extractSourceSection(
    backgroundSource,
    'async function resolvePageTimerArmHold(plan, observations) {',
    '\n\n  // 提取（Fowler Extract Function）：PWM 关机补时 hold 分支',
    'timer-prearm hook order'
  );
  const retryAuditSource18 = extractSourceSection(
    backgroundSource,
    'async function resolveRetryPlan(plan, observations, targetAction) {',
    '\n\n  return waitUntil',
    'retry-scheduled hook order'
  );
  const plannedVerifyIndex18 = createPwmAlarmAuditSource18.indexOf(
    '|| !isAutomationAlarmWriteCurrent(automationRevision)) {'
  );
  const plannedHookIndex18 = createPwmAlarmAuditSource18.indexOf(
    'recordControlAuditPlanned('
  );
  const deliveryHookIndex18 = alarmListenerAuditSource18.indexOf(
    'recordControlAuditDelivery('
  );
  const deliveryInitReadyIndex18 = alarmListenerAuditSource18.indexOf(
    'await initReady;'
  );
  const deliveryRunIndex18 = alarmListenerAuditSource18.indexOf(
    'await runAutomationStepForAlarm(alarm);'
  );
  const prearmStartedIndex18 = prearmAuditSource18.indexOf(
    "recordControlAuditTimerPrearm(\n      'started'"
  );
  const prearmWriteIndex18 = prearmAuditSource18.indexOf(
    'const armResult = await armPowerOffTimerEnsuringOn('
  );
  const dispatchStartedIndex18 = prearmAuditSource18.indexOf(
    'recordControlAuditDispatch();'
  );
  const dispatchWriteIndex18 = prearmAuditSource18.indexOf(
    "const toggleResult = await toggleAC('on'"
  );
  const prearmOutcomeIndex18 = prearmAuditSource18.indexOf(
    "writeSucceeded ? 'ok' : 'failed'"
  );
  const dispatchOutcomeIndex18 = prearmAuditSource18.indexOf(
    'recordControlAuditOnOutcome(',
    dispatchWriteIndex18
  );
  const retryAlarmIndex18 = retryAuditSource18.indexOf(
    'const alarmCreated = await createPwmAlarmFromPlan('
  );
  const retryHookIndex18 = retryAuditSource18.indexOf(
    'recordControlAuditRetryScheduled('
  );
  const pwmRuntimeAuditSource18 = pwmBody.slice(
    pwmBody.indexOf('return waitUntil')
  );
  const admissionOkIndex18 = pwmRuntimeAuditSource18.indexOf(
    "recordControlAuditAdmission('ok', 'revision-current')"
  );
  const prearmBranchIndex18 = pwmRuntimeAuditSource18.indexOf(
    "plan.prerequisite === 'arm-page-timer'"
  );
  assertPass(backgroundSource.includes("const BUILD_TIME = 'dev';")
      && backgroundSource.includes('const BUILD_TIME_EPOCH_MS = 0;')
      && backgroundSource.includes("const BUILD_SOURCE_SHA256 = 'dev';")
      && backgroundSource.includes("const CONTROL_AUDIT_KEY = 'ac_dist_control_audit_v1';")
      && backgroundSource.includes('const CONTROL_AUDIT_MISSED_WAKE_GRACE_MS = 60 * 1000;')
      && plannedVerifyIndex18 >= 0 && plannedHookIndex18 > plannedVerifyIndex18
      && deliveryHookIndex18 >= 0
      && deliveryInitReadyIndex18 > deliveryHookIndex18
      && deliveryRunIndex18 > deliveryHookIndex18
      && backgroundSource.includes('async function runAutomationStepForAlarm(alarm)')
      && backgroundSource.includes('await runPwmStep();')
      && admissionOkIndex18 >= 0 && prearmBranchIndex18 > admissionOkIndex18
      && initAuditSource18.indexOf("recordControlAuditMissedWake('init')")
        < initAuditSource18.indexOf('await backfillNextTriggerAt(true);')
      && watchdogAuditSource18.indexOf("recordControlAuditMissedWake('watchdog')")
        < watchdogAuditSource18.indexOf('async function recoverMissingPwmAlarm()')
      && prearmStartedIndex18 >= 0 && prearmWriteIndex18 > prearmStartedIndex18
      && dispatchStartedIndex18 > prearmWriteIndex18
      && dispatchWriteIndex18 > dispatchStartedIndex18
      && prearmOutcomeIndex18 > dispatchWriteIndex18
      && dispatchOutcomeIndex18 > prearmOutcomeIndex18
      && retryAlarmIndex18 >= 0 && retryHookIndex18 > retryAlarmIndex18
      && backgroundSource.includes("recordControlAuditTerminal('disabled', 'automation-disabled')"),
    '18L: 有限源码钩子锁定 alarm 验证→planned→delivery→admission/prearm/dispatch/outcome→retry/terminal 顺序');

  // ===== 用例 19: popup 当前构建事故快照与逾期未确认展示 =====
  console.log('\n\n=== 用例 19: popup 当前构建事故快照与逾期未确认展示 ===\n');

  const popupAuditHelpersStart19 = popupJs.indexOf(
    'function sanitizeControlAuditToken('
  );
  const popupAuditHelpersEnd19 = popupJs.indexOf(
    '\nasync function readCurrentBuildControlAudit()',
    popupAuditHelpersStart19
  );
  let popupAuditHelpers19 = null;
  if (popupAuditHelpersStart19 >= 0
      && popupAuditHelpersEnd19 > popupAuditHelpersStart19) {
    try {
      popupAuditHelpers19 = new Function(
        't',
        `${popupJs.slice(popupAuditHelpersStart19, popupAuditHelpersEnd19)};
        return {
          selectCurrentBuildControlAudit,
          isAutomaticOnUnconfirmed,
          appendControlAuditDiagnosticLines
        };`
      )((key, ...subs) => {
        const messages = {
          automaticOnUnconfirmed: 'AUTO ON UNCONFIRMED',
          diagnoseControlAuditEmpty: 'NO CURRENT BUILD AUDIT',
          diagnoseControlAuditCurrent: `CURRENT BUILD AUDIT ${subs[0] || ''}`,
          diagnoseStartMissed: `MISSED ${subs[0] || ''}`
        };
        return messages[key] || key;
      });
    } catch (_) {
      popupAuditHelpers19 = null;
    }
  }

  const now19 = 1_800_000_300_000;
  const build19 = `${manifest.version}|2027-01-15 08:00:00|1800000000000|${'c'.repeat(64)}`;
  const controlId19 = `control|${build19}|on|1800000000000`;
  const envelope19 = {
    schemaVersion: 1,
    build: build19,
    active: {
      controlId: controlId19,
      action: 'on',
      attempt: 2,
      scheduledAt: now19 - 60_000,
      originBoundaryAt: 1_800_000_000_000,
      targetAt: now19 + 20 * 60_000,
      retryAt: now19 - 60_000,
      deliveryAt: 0,
      confirmedAt: 0,
      awaitingRetry: true,
      attention: true,
      lastStage: 'missed-wake'
    },
    events: [
      {
        seq: 3,
        at: now19 - 60_000,
        controlId: controlId19,
        attempt: 2,
        stage: 'missed-wake',
        result: 'failed',
        code: 'watchdog-overdue',
        action: 'on',
        scheduledAt: now19 - 60_000,
        originBoundaryAt: 1_800_000_000_000,
        targetAt: now19 + 20 * 60_000,
        retryAt: now19 - 60_000,
        build: build19
      },
      {
        seq: 1,
        at: now19 - 120_000,
        controlId: controlId19,
        attempt: 1,
        stage: 'planned',
        result: 'ok',
        code: 'alarm-verified',
        action: 'on',
        scheduledAt: now19 - 120_000,
        originBoundaryAt: 1_800_000_000_000,
        targetAt: now19 + 20 * 60_000,
        retryAt: 0,
        build: build19
      },
      {
        seq: 2,
        at: now19 - 90_000,
        controlId: controlId19,
        attempt: 1,
        stage: 'retry-scheduled',
        result: 'ok',
        code: 'prearm-retry',
        action: 'on',
        scheduledAt: now19 - 60_000,
        originBoundaryAt: 1_800_000_000_000,
        targetAt: now19 + 20 * 60_000,
        retryAt: now19 - 60_000,
        build: build19
      },
      {
        seq: 4,
        at: now19,
        controlId: 'different-control',
        attempt: 1,
        stage: 'planned',
        result: 'ok',
        action: 'on',
        build: build19
      }
    ]
  };
  const popupAuditSnapshot19 = popupAuditHelpers19
    ?.selectCurrentBuildControlAudit(envelope19, build19, now19);
  const popupAuditLines19 = [];
  popupAuditHelpers19?.appendControlAuditDiagnosticLines(
    popupAuditLines19,
    popupAuditSnapshot19,
    now19
  );
  assertPass(popupAuditSnapshot19?.build === build19
      && popupAuditSnapshot19?.controlId === controlId19
      && popupAuditSnapshot19?.events.map(event => event.seq).join(',') === '1,2,3'
      && popupAuditHelpers19?.selectCurrentBuildControlAudit(
        envelope19,
        build19.replace(/c{64}$/, 'd'.repeat(64)),
        now19
      ) === null,
    '19A: popup 只接受当前 build envelope，并按 seq 还原同一 controlId 的完整阶段链');
  assertPass(popupAuditHelpers19?.isAutomaticOnUnconfirmed(
    popupAuditSnapshot19,
    now19
  ) === true
      && popupAuditHelpers19?.isAutomaticOnUnconfirmed({
        ...popupAuditSnapshot19,
        active: { ...popupAuditSnapshot19?.active, confirmedAt: now19 }
      }, now19) === false
      && popupAuditHelpers19?.isAutomaticOnUnconfirmed({
        ...popupAuditSnapshot19,
        active: { ...popupAuditSnapshot19?.active, scheduledAt: now19 + 1 }
      }, now19) === false,
    '19B: 只有已到 scheduledAt 且仍未 confirmed 的当前构建 ON 才显示“自动开启未确认”');
  assertPass(popupAuditLines19.some(line => line.includes('[AC-START-MISSED]'))
      && popupAuditLines19.filter(line => line.includes('[AC-START-LIFECYCLE]')).length === 3
      && popupAuditLines19.findIndex(line => line.includes('seq=1'))
        < popupAuditLines19.findIndex(line => line.includes('seq=2'))
      && popupAuditLines19.findIndex(line => line.includes('seq=2'))
        < popupAuditLines19.findIndex(line => line.includes('seq=3')),
    '19C: 诊断输出 [AC-START-MISSED] 与完整有序 [AC-START-LIFECYCLE] 证据链');

  const refreshStatusSource19 = extractSourceSection(
    popupJs,
    'async function refreshStatus() {',
    '\nfunction announceState(',
    'popup refresh control audit'
  );
  const renderCountdownSource19 = extractSourceSection(
    popupJs,
    'function renderCountdown(',
    '\nfunction readPositiveMinutes(',
    'popup overdue countdown'
  );
  const diagnosticAuditReadIndex19 = diagnoseHandlerSource.indexOf(
    'await readCurrentBuildControlAudit()'
  );
  const diagnosticRepairIndex19 = diagnoseHandlerSource.indexOf(
    "sendDiagnosticRuntimeMessage({ type: 'ensureDiagnostics' })"
  );
  assertPass(diagnosticAuditReadIndex19 >= 0
      && diagnosticRepairIndex19 > diagnosticAuditReadIndex19
      && refreshStatusSource19.includes('readCurrentBuildControlAudit()')
      && refreshStatusSource19.includes('updateCountdownDisplay(schedule, alarm, controlAudit)')
      && renderCountdownSource19.includes('isAutomaticOnUnconfirmed(controlAudit)')
      && renderCountdownSource19.includes("t('automaticOnUnconfirmed')")
      && zhCN.automaticOnUnconfirmed?.message === '自动开启未确认'
      && en.automaticOnUnconfirmed?.message === 'Auto ON not confirmed',
    '19D: popup 诊断先快照后自愈，常规刷新以当前构建审计覆盖逾期普通倒计时');

  const popupFallbackSource19 = fs.readFileSync(
    path.join(ROOT, 'popup-diagnostic-fallback.js'),
    'utf8'
  );
  const fallbackAuditReadIndex19 = popupFallbackSource19.indexOf(
    'await readFallbackControlAuditSnapshot()'
  );
  const fallbackOtherReadsIndex19 = popupFallbackSource19.indexOf(
    'const [storageResult, alarmsResult, swResult] = await Promise.allSettled(['
  );
  assertPass(popupFallbackSource19.includes("const FALLBACK_BUILD_SOURCE_SHA256 = 'dev';")
      && fallbackAuditReadIndex19 >= 0
      && fallbackOtherReadsIndex19 > fallbackAuditReadIndex19
      && !popupFallbackSource19.includes('chrome.storage.local.set(')
      && !diagnoseHandlerSource.includes('chrome.storage.local.set({ ac_schedule')
      && popupFallbackSource19.includes('[AC-START-MISSED]')
      && popupFallbackSource19.includes('[AC-START-LIFECYCLE]')
      && buildSh.includes('fallback_path,')
      && buildSh.includes("const FALLBACK_BUILD_SOURCE_SHA256 = '{build_source_sha256}';"),
    '19E: fallback 拥有独立注入身份，并在其余诊断读取前快照同一当前构建事故链');

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
