// ============================================================
// sync-helpers.js — 跨设备 Smart/PWM phase envelope 纯函数（无 chrome.* 副作用）
// ============================================================
//
// 设计目的：
//   Chrome/Edge 扩展同步只会把"已安装的扩展"分发到其他设备，但
//   `chrome.storage.local` 是各设备本地的、不会被浏览器自动同步，
//   结果是同一账号的多台设备跑各自的 PWM 循环——同一台 AC 被反复开关。
//
//   把"瘦化版"schedule（config + 当前模式 phase envelope）推到
//   `chrome.storage.sync`，让多台设备对齐到相同的 wall-clock 边界，依赖 background.js 中
//   toggleAC() 的 A1 幂等预检让先触发的那台完成 toggle、后到的看到
//   目标状态已达成直接跳过。
//
// 本文件只放无副作用的决策逻辑，方便在 Node 单元测试里直接 import
// 验证。background.js 负责真正的读写 / 闹钟重排 / storage.onChanged 监听。
//
// 双上下文加载：
//   - SW：background.js 通过 `importScripts('sync-helpers.js')` 加载，
//     `function` 声明自动暴露为全局变量。
//   - Node ESM：`import syncHelpers from './sync-helpers.js'`，
//     下方 `module.exports` 守卫仅在有 `module` 对象时（Node CommonJS）才运行，
//     ESM interop 仍能拿到具名导出。

// 只这些字段会被跨设备同步。其余字段（__heartbeat / pageTimer* /
// alarmCreatedAt / alarmDelayMinutes / pwmRetry*）属于本机运行态，不应同步——
// 特别是 __heartbeat 每 20s 写一次，会瞬间打爆 sync 写入配额
// （8 写/分钟、100 写/小时、1200 写/天）。
const SYNC_PHASE_SCHEMA_VERSION = 1;
const SYNC_FIELDS = [
  'enabled',
  'onMinutes',
  'offMinutes',
  'activeHours',
  'smartMode',
  'phase',
  'pwmState',
  'nextTriggerAt',
  'smartClockPlannedAt',
  'smartState',
  'smartNextTriggerAt',
  'pwmClockPlannedAt',
  'syncedAt'
];

function normalizeSyncMode(value) {
  return value === 'smart' || value === 'pwm' ? value : null;
}

function getSyncMode(schedule, opts = {}) {
  return normalizeSyncMode(opts.mode)
    || (schedule?.smartMode?.enabled === true ? 'smart' : 'pwm');
}

function normalizePhaseState(value) {
  return value === 'on' ? 'on' : 'off';
}

function normalizePositiveTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function normalizeFutureTimestamp(value, now) {
  const timestamp = normalizePositiveTimestamp(value);
  return timestamp > now ? timestamp : 0;
}

function getLocalPhaseNamespace(schedule, mode) {
  if (mode === 'smart') {
    return {
      state: normalizePhaseState(schedule?.smartState),
      nextTriggerAt: normalizePositiveTimestamp(schedule?.smartNextTriggerAt),
      clockPlannedAt: normalizePositiveTimestamp(schedule?.smartClockPlannedAt)
    };
  }

  return {
    state: normalizePhaseState(schedule?.pwmState),
    nextTriggerAt: normalizePositiveTimestamp(schedule?.nextTriggerAt),
    clockPlannedAt: normalizePositiveTimestamp(schedule?.pwmClockPlannedAt)
      || normalizePositiveTimestamp(schedule?.alarmCreatedAt)
  };
}

function createPhaseAdoption(mode, state, nextTriggerAt, clockPlannedAt, metadataOnly = false) {
  return {
    mode,
    state,
    clockPlannedAt,
    // 这些字段是现有 background.js 调用方的兼容返回字段；它们不代表
    // Smart/PWM 内部状态的来源。
    pwmState: state,
    nextTriggerAt,
    smartClockPlannedAt: clockPlannedAt,
    ...(mode === 'smart'
      ? {
        smartState: state,
        smartNextTriggerAt: nextTriggerAt
      }
      : { pwmClockPlannedAt: clockPlannedAt }),
    ...(metadataOnly ? { metadataOnly: true } : {})
  };
}

// 把内存 schedule 组装成 push 到 chrome.storage.sync 的瘦化对象。
// nextTriggerAt 若已是过去时戳则推 0——让接收方识别为"相位未定"，
// 而不是用陈旧值误导对端把闹钟调度到过去时刻。
function composeSyncPayload(schedule, now = Date.now()) {
  const syncNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const mode = getSyncMode(schedule);
  const smartEnabled = mode === 'smart';
  const state = normalizePhaseState(
    smartEnabled ? schedule?.smartState : schedule?.pwmState
  );
  const nextTriggerAt = normalizeFutureTimestamp(
    smartEnabled ? schedule?.smartNextTriggerAt : schedule?.nextTriggerAt,
    syncNow
  );
  const clockPlannedAt = smartEnabled
    ? normalizePositiveTimestamp(schedule?.smartClockPlannedAt)
    : normalizePositiveTimestamp(schedule?.pwmClockPlannedAt)
      || normalizePositiveTimestamp(schedule?.alarmCreatedAt);
  const phase = {
    schemaVersion: SYNC_PHASE_SCHEMA_VERSION,
    mode,
    state,
    nextTriggerAt,
    clockPlannedAt
  };
  const payload = {
    enabled: !!schedule.enabled,
    onMinutes: schedule.onMinutes,
    offMinutes: schedule.offMinutes,
    activeHours: schedule.activeHours
      ? { ...schedule.activeHours }
      : { enabled: false, start: '08:00', end: '23:00' },
    smartMode: schedule.smartMode
      ? { enabled: !!schedule.smartMode.enabled, sensitivity: schedule.smartMode.sensitivity }
      : { enabled: false, sensitivity: 5 },
    phase,
    // 旧协议字段只投影当前真实模式；Smart 不从这些字段读取内部真值。
    pwmState: state,
    nextTriggerAt,
    smartClockPlannedAt: clockPlannedAt,
    syncedAt: syncNow
  };

  if (smartEnabled) {
    payload.smartState = state;
    payload.smartNextTriggerAt = nextTriggerAt;
  } else {
    payload.pwmClockPlannedAt = clockPlannedAt;
  }

  return payload;
}

// 判断是否应当采纳远端当前模式的相位。
// 返回 null（无需变更）或带 mode/state 的相位结果；pwmState/nextTriggerAt/
// smartClockPlannedAt 保留给现有调用方作为兼容返回字段。
//
// 决策口径（全部基于自身的本地 schedule，反复推演过两种边界场景）：
//   1. 自回环抑制：remote.syncedAt <= lastSyncedAt → 自己刚写入的回流，跳过。
//   2. 陈旧相位：remote.nextTriggerAt 在过去 > 60s → 跳相位（避免把闹钟调度到过去）；config 仍可采纳。
//   3. 时钟微抖动容忍：local.nextTriggerAt 在未来 + |local - remote| <= 10s → 跳相位（A1 幂等预检兜底）。
//   4. 否则（本地无未来触发时间，或偏差 > 10s）→ 采纳 remote 相位。
//
// opts.lastSyncedAt 是 background.js 模块变量的本地参照，调用方维护；
// opts.mode 可明确指定本地 namespace。没有 phase 的旧 payload 只允许 PWM
// 读取顶层 generic 字段；Smart 必须由调用方显式传 legacyMigration=true 才读取。
function computePhaseAdoption(localSchedule, remote, opts = {}) {
  const {
    now = Date.now(),
    toleranceMs = 10_000,   // 相位偏差 ≤ 10s 视为已对齐，不再 re-reschedule
    staleMs = 60_000,        // 远端触发时间在过去 > 60s 视为陈旧
    lastSyncedAt = 0,
    legacyMigration = false
  } = opts;

  if (!remote || typeof remote !== 'object') return null;
  const remoteSyncedAt = normalizePositiveTimestamp(remote.syncedAt);
  if (!remoteSyncedAt) return null;

  // 自回环：远端 syncedAt 不比本地新 → 跳过相位采纳
  if (remoteSyncedAt <= normalizePositiveTimestamp(lastSyncedAt)) return null;

  const mode = getSyncMode(localSchedule, opts);
  const hasPhase = Object.prototype.hasOwnProperty.call(remote, 'phase');
  let remoteState;
  let remoteTrigger;
  let remotePlannedAt;

  if (hasPhase) {
    const phase = remote.phase;
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return null;
    if (phase.schemaVersion !== SYNC_PHASE_SCHEMA_VERSION
        || normalizeSyncMode(phase.mode) !== mode) {
      return null;
    }
    if (phase.state !== 'on' && phase.state !== 'off') return null;
    remoteState = phase.state;
    remoteTrigger = normalizePositiveTimestamp(phase.nextTriggerAt);
    remotePlannedAt = normalizePositiveTimestamp(phase.clockPlannedAt);
  } else {
    // 旧 payload 没有 mode，generic 字段对 Smart/PWM 有歧义；默认只兼容
    // PWM。Smart 迁移必须由调用方明确打开，避免 PWM 状态反向覆盖 Smart。
    if (mode === 'smart' && legacyMigration !== true) return null;
    if (remote.pwmState !== 'on' && remote.pwmState !== 'off') return null;
    remoteState = remote.pwmState;
    remoteTrigger = normalizePositiveTimestamp(remote.nextTriggerAt);
    remotePlannedAt = normalizePositiveTimestamp(remote.smartClockPlannedAt);
  }

  if (!remoteTrigger) return null;  // 远端无相位信息

  // 陈旧：远端时戳在过去过远 → 即便 sync 传到也对端已错过，跳相位以免把闹钟调度到过去
  const referenceNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const staleWindow = Number.isFinite(Number(staleMs))
    ? Math.max(0, Number(staleMs))
    : 60_000;
  if (remoteTrigger < referenceNow - staleWindow) return null;

  const localPhase = getLocalPhaseNamespace(localSchedule, mode);
  const localTrigger = localPhase.nextTriggerAt;
  const localPlannedAt = localPhase.clockPlannedAt;
  const tolerance = Number.isFinite(Number(toleranceMs))
    ? Math.max(0, Number(toleranceMs))
    : 10_000;
  // OFF 是安全动作：两端都计划 OFF 时，远端较晚的截止绝不能
  // 延后本机已有的较早 OFF。这也让 timer-only 修复投影在新版对端
  // 只会收紧、不会放宽关机保险。
  if (localTrigger > referenceNow
      && localPhase.state === 'off'
      && remoteState === 'off'
      && localTrigger <= remoteTrigger) {
    return null;
  }
  // 容忍窗口内：偏差 ≤ 10s 且本地未来触发 → 视为已对齐
  if (localTrigger > referenceNow
      && localPhase.state === remoteState
      && Math.abs(localTrigger - remoteTrigger) <= tolerance) {
    if (remotePlannedAt > 0 && remotePlannedAt !== localPlannedAt) {
      return createPhaseAdoption(
        mode,
        remoteState,
        remoteTrigger,
        remotePlannedAt,
        true
      );
    }
    return null;
  }

  return createPhaseAdoption(mode, remoteState, remoteTrigger, remotePlannedAt);
}

// 计算哪些 config 字段需要采纳（last-writer-wins，无相位守卫）。
// 返回 { changed: bool, fields: {...} }——background.js 拿到后会合并并写 local storage。
// Smart 的 on/off 是天气派生运行态；明确 Smart 时不从远端 config 覆盖。
function computeConfigDiff(localSchedule, remote, opts = {}) {
  if (!remote || typeof remote !== 'object') return { changed: false, fields: {} };
  const out = {};
  let changed = false;
  const explicitMode = normalizeSyncMode(opts.mode);
  const remotePhaseMode = remote.phase && typeof remote.phase === 'object'
    ? normalizeSyncMode(remote.phase.mode)
    : null;
  const remoteSmartMode = typeof remote.smartMode?.enabled === 'boolean'
    ? (remote.smartMode.enabled ? 'smart' : 'pwm')
    : null;
  const mode = explicitMode
    || remotePhaseMode
    || remoteSmartMode
    || getSyncMode(localSchedule);
  const protectSmartDurations = opts.protectSmartDurations === true || mode === 'smart';

  if (!protectSmartDurations
      && typeof remote.onMinutes === 'number'
      && Number.isFinite(remote.onMinutes)
      && remote.onMinutes !== localSchedule?.onMinutes) {
    out.onMinutes = remote.onMinutes;
    changed = true;
  }
  if (!protectSmartDurations
      && typeof remote.offMinutes === 'number'
      && Number.isFinite(remote.offMinutes)
      && remote.offMinutes !== localSchedule?.offMinutes) {
    out.offMinutes = remote.offMinutes;
    changed = true;
  }
  if (typeof remote.enabled === 'boolean' && remote.enabled !== localSchedule?.enabled) {
    out.enabled = remote.enabled;
    changed = true;
  }
  if (remote.activeHours && typeof remote.activeHours === 'object'
      && JSON.stringify(remote.activeHours) !== JSON.stringify(localSchedule?.activeHours)) {
    out.activeHours = { ...remote.activeHours };
    changed = true;
  }
  if (remote.smartMode && typeof remote.smartMode === 'object'
      && JSON.stringify(remote.smartMode) !== JSON.stringify(localSchedule?.smartMode)) {
    out.smartMode = { ...remote.smartMode };
    changed = true;
  }

  return { changed, fields: out };
}

// 有效 smart-on 重试已经把本周期绝对边界写入本机事务。跨设备 config 仍可
// 更新总开关、时段和灵敏度，但不能在重试完成前篡改本周期 on/off 时长。
function protectSmartOnRetryConfigDiff(configDiff, protectDurations = false) {
  if (!configDiff || typeof configDiff !== 'object') {
    return { changed: false, fields: {} };
  }
  const fields = { ...(configDiff.fields || {}) };
  if (protectDurations) {
    delete fields.onMinutes;
    delete fields.offMinutes;
  }
  return {
    changed: Object.keys(fields).length > 0,
    fields
  };
}

// ---- v0.5.10: 页面定时器作为跨设备主同步通道 ----
//
// UST 服务器已确认："Power-off after" 定时器值会同步到同一账号的所有会话。
// chrome.storage.sync 在 Chrome/Edge 跨浏览器时互不互通——只有 page timer
// 能跨浏览器账号同步（只要登录同一 UST 账号）。因此 v0.5.10 起将 page timer
// 从"补充通道"升为"跨设备主同步通道"。
//
// 这组纯函数负责决策"是否应该采纳页面提交的定时器值"。v0.5.10 同时修正了
// v0.5.7 的 pwmState 条件 bug（之前仅 pwmState='on' 才采纳，但 AC 正开时才
// 有 page timer 值）。现在两个相位都会对齐：
//   - pwmState='off'（AC 正开）：page timer 直接映射"关"时刻，采纳 T
//   - pwmState='on'（AC 正关）：page timer 说"T 关" → 下一轮"开"在 T + offMinutes
//
// 优雅降级：如果 page timer 并非服务器端同步（只是浏览器本地 React
// 状态），read 出来的值就是本机自己刚写的——偏差 < toleranceMs，computePageTimerAdoption
// 返回 null，不干预，功能等于关闭。所以本机制对"未验证同步"的场景是安全的。

// 解析页面 "Power-off after" picker 的 HH:MM 值为绝对时戳。
// 页面允许直接输入跨午夜时间（例如 23:50 输入 00:10）。同日时刻已过时，
// 若把它解释为次日后距离当前不超过 12 小时，则按次日处理；否则视为陈旧值。
// 返回 { targetMs, valid } 或 null（格式非法）。
function parsePageTimerValue(value, now = Date.now()) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return null;

  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
  let targetMs = target.getTime();
  if (targetMs <= now) {
    const nextDayTarget = new Date(target);
    nextDayTarget.setDate(nextDayTarget.getDate() + 1);
    const nextDayTargetMs = nextDayTarget.getTime();
    if (nextDayTargetMs - now <= 12 * 60 * 60 * 1000) {
      targetMs = nextDayTargetMs;
    }
  }
  return { targetMs, valid: targetMs > now };
}

function isPageTimerProofFresh(schedule, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const graceMs = Number.isFinite(opts.graceMs) ? Math.max(0, opts.graceMs) : 90_000;
  const minutes = Number(schedule?.pageTimerMinutes);
  const targetAt = Number(schedule?.pageTimerTargetAt);

  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  if (!Number.isFinite(targetAt) || targetAt <= 0) return false;
  if (schedule?.pageTimerRetryAt) return false;

  return targetAt >= now - graceMs
    && targetAt <= now + minutes * 60000 + graceMs;
}

// 规划自动控制启用后的舒适启动关机目标。页面控件只有 HH:MM 精度，因此
// 最短目标向上取整到整分钟，保证实际运行时间不会少于 requested minutes。
// 已有更晚页面目标一律保留；只有本机 storage 的新鲜证明与最终目标完全
// 一致，且当前可读页面不与证明矛盾时，才可跳过重写；否则 background
// 仍需走一次新鲜页持久化验证。
function planComfortStart(localSchedule, pageTimerInput, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const requestedMinutes = Math.max(1, Math.ceil(Number(opts.minutes) || 5));
  const minuteMs = 60_000;
  const normalizeFutureTarget = value => {
    const targetAt = Number(value);
    return Number.isSafeInteger(targetAt) && targetAt > now
      ? Math.ceil(targetAt / minuteMs) * minuteMs
      : 0;
  };
  const computedMinimumTargetAt = Math.ceil(
    (now + requestedMinutes * minuteMs) / minuteMs
  ) * minuteMs;
  const minimumTargetAt = normalizeFutureTarget(opts.minimumTargetAt)
    || computedMinimumTargetAt;
  const preferredTargetAt = normalizeFutureTarget(opts.preferredTargetAt);
  const temporaryTargetAt = normalizeFutureTarget(opts.temporaryTargetAt);
  const preservedTargetAt = normalizeFutureTarget(opts.preservedTargetAt);

  const storedTargetAt = Number(localSchedule?.pageTimerTargetAt);
  const freshStoredTargetAt = isPageTimerProofFresh(localSchedule, { now })
      && Number.isSafeInteger(storedTargetAt)
      && storedTargetAt > now
      && storedTargetAt !== temporaryTargetAt
    ? storedTargetAt
    : 0;
  const parsedPageTimer = pageTimerInput?.found === true
    ? parsePageTimerValue(pageTimerInput.value, now)
    : null;
  const liveTargetAt = parsedPageTimer?.valid === true
      && parsedPageTimer.targetMs !== temporaryTargetAt
    ? parsedPageTimer.targetMs
    : 0;
  const targetAt = Math.max(
    minimumTargetAt,
    preferredTargetAt,
    preservedTargetAt,
    freshStoredTargetAt,
    liveTargetAt
  );

  return {
    minimumTargetAt,
    preferredTargetAt,
    targetAt,
    timerMinutes: Math.max(1, Math.ceil((targetAt - now) / minuteMs)),
    reuseFreshProof: freshStoredTargetAt === targetAt
      && (pageTimerInput?.found !== true || liveTargetAt === targetAt)
  };
}

// 决策是否采纳页面 page timer 值作为跨设备 PWM 相位对齐的权威源。
// pageTimerInput 是 content.js getPagePowerOffTimer() 的返回值
//   { found: bool, value: 'HH:MM'|null }
//
// 返回 null（无需变更）或 { adopt: true, nextTriggerAt, source: 'page-timer', reason }。
//
// v0.5.10 起为本：page timer 成为**跨设备主同步通道**（UST 服务器确认跨设备同步），
// chrome.storage.sync 降为同浏览器生态内的补充通道（Chrome/Edge 账号同步互不互通）。
//
// 决策口径：
//   1. page timer 未找到/无值 → null（不干预）
//   2. page timer 值格式非法或已过期 → null
//   3. enabled=false → null
//   4. pwmState='off'（AC 正开，下一步关）：page timer 直接映射 nextTriggerAt
//      - 本地无未来触发 → 直接采纳 page timer
//      - 偏差 > toleranceMs → 采纳 page timer
//      - 偏差 ≤ toleranceMs → null（已对齐）
//   5. pwmState='on'（AC 正关，下一步开）：page timer 说"T关" → 下一轮"开"在 T + offMinutes
//      - 按周期 (onMinutes+offMinutes) 找最接近本地 nextTriggerAt 的"开"边界
//      - 偏差 > toleranceMs → 采纳推导的"开"时刻
//      - 偏差 ≤ toleranceMs → null（已对齐）
function computePageTimerAdoption(localSchedule, pageTimerInput, opts = {}) {
  const {
    now = Date.now(),
    toleranceMs = 60_000   // 偏差 ≤ 60s 视为已对齐
  } = opts;

  if (!pageTimerInput || !pageTimerInput.found || !pageTimerInput.value) return null;
  if (!localSchedule?.enabled) return null;

  const parsed = parsePageTimerValue(pageTimerInput.value, now);
  if (!parsed || !parsed.valid) return null;

  const pageOffAt = parsed.targetMs;     // 页面定时器说"这个时刻关空调"

  const { localTrigger, expectedTrigger } = computeExpectedTriggerFromPageTimer(localSchedule, pageOffAt, now);

  // 无本地触发 → 直接采纳
  if (!localTrigger) {
    return { adopt: true, nextTriggerAt: expectedTrigger, source: 'page-timer', reason: 'local-no-trigger' };
  }

  // 偏差检查
  const diff = Math.abs(expectedTrigger - localTrigger);
  if (diff <= toleranceMs) return null;   // 已对齐

  return { adopt: true, nextTriggerAt: expectedTrigger, source: 'page-timer', reason: 'deviation' };
}

// 提取（Fowler Extract Function）：由页面关机时刻推导期望的 PWM 触发边界（按 pwmState 映射到最近周期的关/开边界）。
function computeExpectedTriggerFromPageTimer(localSchedule, pageOffAt, now) {
  const onMinutes = Math.max(1, localSchedule.onMinutes || 60);
  const offMinutes = Math.max(1, localSchedule.offMinutes || 60);
  const cycleMs = (onMinutes + offMinutes) * 60000;
  const localTrigger = Number(localSchedule.nextTriggerAt) || 0;

  // 根据 pwmState 决定 page timer 映射到什么
  if (localSchedule.pwmState === 'off') {
    // AC 正开（下一步关）→ page timer 直接给"关"时刻
    // 按周期找最接近本地 nextTriggerAt 的"关"边界，避免 page timer 太远时跳到不合理的周期
    if (!localTrigger) {
      return { localTrigger, expectedTrigger: pageOffAt };
    }
    let expectedTrigger = pageOffAt + Math.round((localTrigger - pageOffAt) / cycleMs) * cycleMs;
    if (expectedTrigger < now) expectedTrigger += cycleMs;
    return { localTrigger, expectedTrigger };
  }

  // pwmState='on'：AC 正关（下一步开）
  // page timer "T关" → 之后的"OFF"持续 offMinutes → 下一轮"开"在 T + offMinutes
  // 按周期找最接近本地 nextTriggerAt 的"开"边界（确保在未来）
  const baseOnAt = pageOffAt + offMinutes * 60000;
  if (!localTrigger) {
    let expectedTrigger = baseOnAt;
    while (expectedTrigger < now) expectedTrigger += cycleMs;
    return { localTrigger, expectedTrigger };
  }
  let expectedTrigger = baseOnAt + Math.round((localTrigger - baseOnAt) / cycleMs) * cycleMs;
  if (expectedTrigger < now) expectedTrigger += cycleMs;
  return { localTrigger, expectedTrigger };
}

// ---- CommonJS/Node 兼容（SW 上下文没有 module） ----
// ESM interop：`import syncHelpers from './sync-helpers.js'` 会拿到 module.exports；
// 也可 `import { composeSyncPayload } from './sync-helpers.js'` 直接具名导入（Node 18+）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SYNC_PHASE_SCHEMA_VERSION,
    SYNC_FIELDS,
    composeSyncPayload,
    computePhaseAdoption,
    computeConfigDiff,
    protectSmartOnRetryConfigDiff,
    parsePageTimerValue,
    isPageTimerProofFresh,
    planComfortStart,
    computePageTimerAdoption
  };
}
