// ============================================================
// sync-helpers.js — 跨设备 PWM 同步的纯函数（无 chrome.* 副作用）
// ============================================================
//
// 设计目的：
//   Chrome/Edge 扩展同步只会把"已安装的扩展"分发到其他设备，但
//   `chrome.storage.local` 是各设备本地的、不会被浏览器自动同步，
//   结果是同一账号的多台设备跑各自的 PWM 循环——同一台 AC 被反复开关。
//
//   把"瘦化版"schedule（config + PWM 相位）推到 `chrome.storage.sync`，
//   让多台设备对齐到相同的 wall-clock 边界，依赖 background.js 中
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
// alarmCreatedAt / alarmDelayMinutes）属于本机运行态，不应同步——
// 特别是 __heartbeat 每 20s 写一次，会瞬间打爆 sync 写入配额
// （8 写/分钟、100 写/小时、1200 写/天）。
const SYNC_FIELDS = ['enabled', 'onMinutes', 'offMinutes', 'activeHours', 'pwmState', 'nextTriggerAt'];

// 把内存 schedule 组装成 push 到 chrome.storage.sync 的瘦化对象。
// nextTriggerAt 若已是过去时戳则推 0——让接收方识别为"相位未定"，
// 而不是用陈旧值误导对端把闹钟调度到过去时刻。
function composeSyncPayload(schedule, now = Date.now()) {
  return {
    enabled: !!schedule.enabled,
    onMinutes: schedule.onMinutes,
    offMinutes: schedule.offMinutes,
    activeHours: schedule.activeHours
      ? { ...schedule.activeHours }
      : { enabled: false, start: '08:00', end: '23:00' },
    pwmState: schedule.pwmState === 'on' ? 'on' : 'off',
    // 远端若拿到过去时戳：本端刚 toggle 完到-下一周期绝对时间，
    // 但 sync 传输有延迟，1 分钟内仍可采纳用于边界对齐；超过 1 分钟
    // 视为陈旧，标记 0 让对端忽略相位字段。
    nextTriggerAt: (schedule.nextTriggerAt && schedule.nextTriggerAt > now)
      ? schedule.nextTriggerAt
      : 0,
    syncedAt: now
  };
}

// 判断是否应当采纳远端的 PWM 相位。
// 返回 null（无需变更）或 { pwmState, nextTriggerAt }（采纳此相位）。
//
// 决策口径（全部基于自身的本地 schedule，反复推演过两种边界场景）：
//   1. 自回环抑制：remote.syncedAt <= lastSyncedAt → 自己刚写入的回流，跳过。
//   2. 陈旧相位：remote.nextTriggerAt 在过去 > 60s → 跳相位（避免把闹钟调度到过去）；config 仍可采纳。
//   3. 时钟微抖动容忍：local.nextTriggerAt 在未来 + |local - remote| <= 10s → 跳相位（A1 幂等预检兜底）。
//   4. 否则（本地无未来触发时间，或偏差 > 10s）→ 采纳 remote 相位。
//
// opts.lastSyncedAt 是 background.js 模块变量的本地参照，调用方维护；
// 测试时可直接传入，便于验证自回环场景。
function computePhaseAdoption(localSchedule, remote, opts = {}) {
  const {
    now = Date.now(),
    toleranceMs = 10_000,   // 相位偏差 ≤ 10s 视为已对齐，不再 re-reschedule
    staleMs = 60_000,        // 远端触发时间在过去 > 60s 视为陈旧
    lastSyncedAt = 0
  } = opts;

  if (!remote || typeof remote !== 'object') return null;
  if (!remote.syncedAt) return null;

  // 自回环：远端 syncedAt 不比本地新 → 跳过相位采纳
  if (remote.syncedAt <= lastSyncedAt) return null;

  const remoteTrigger = Number(remote.nextTriggerAt) || 0;
  if (!remoteTrigger) return null;  // 远端无相位信息

  // 陈旧：远端时戳在过去过远 → 即便 sync 传到也对端已错过，跳相位以免把闹钟调度到过去
  if (remoteTrigger < now - staleMs) return null;

  const localTrigger = Number(localSchedule?.nextTriggerAt) || 0;
  // 容忍窗口内：偏差 ≤ 10s 且本地未来触发 → 视为已对齐
  if (localTrigger > now && Math.abs(localTrigger - remoteTrigger) <= toleranceMs) {
    return null;
  }

  return {
    pwmState: remote.pwmState === 'on' ? 'on' : 'off',
    nextTriggerAt: remoteTrigger
  };
}

// 计算哪些 config 字段需要采纳（last-writer-wins，无相位守卫）。
// 返回 { changed: bool, fields: {...} }——background.js 拿到后会合并并写 local storage。
function computeConfigDiff(localSchedule, remote) {
  if (!remote || typeof remote !== 'object') return { changed: false, fields: {} };
  const out = {};
  let changed = false;

  if (typeof remote.onMinutes === 'number' && remote.onMinutes !== localSchedule?.onMinutes) {
    out.onMinutes = remote.onMinutes;
    changed = true;
  }
  if (typeof remote.offMinutes === 'number' && remote.offMinutes !== localSchedule?.offMinutes) {
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

  return { changed, fields: out };
}

// ---- v0.5.7: 页面定时器作为跨设备验证源 ----
//
// UST 空调页面的 "Power-off after" 输入的是绝对时刻 HH:MM（Ant Design
// 时间选择器），不是相对偏移。绝对时刻是服务器端持久化的可能候选——
// 如果 UST 服务器确实把定时器同步到同一账号的所有会话，那么打开 AC
// 页面读取 picker 的当前值就能得到一个跨设备真相源。
//
// 这组纯函数负责决策"是否应该采纳页面提交的定时器值"，background.js
// 调用 content.js 读取 picker 值后传入此处判断。它们故意**只管"关"相位**：
// page timer 只能设"到点关空调"，没有"到点开"，所以 PWM "开"相位仍由
// chrome.storage.sync 对齐——两条通道互补。
//
// 优雅降级：如果 page timer 并非服务器端同步（只是浏览器本地 React
// 状态），read 出来的值就是本机自己刚写的——偏差 < toleranceMs，computePageTimerAdoption
// 返回 null，不干预，功能等于关闭。所以本机制对"未验证同步"的场景是安全的。

// 解析页面 "Power-off after" picker 的 HH:MM 值为绝对时戳。
// 返回 { targetMs, valid } 或 null（格式非法）。
// valid=false 表示目标时刻已过——定时器可能已触发或被清空。
function parsePageTimerValue(value, now = Date.now()) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return null;

  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
  const targetMs = target.getTime();
  return { targetMs, valid: targetMs > now };
}

// 决策是否采纳页面 page timer 值作为 PWM "关"相位的权威源。
// pageTimerInput 是 content.js getPagePowerOffTimer() 的返回值
//   { found: bool, value: 'HH:MM'|null }
//
// 返回 null（无需变更）或 { adopt: true, nextTriggerAt, source: 'page-timer', reason }。
//
// 决策口径：
//   1. page timer 未找到/无值 → null（不干预）
//   2. page timer 值格式非法或已过期（valid=false）→ null
//   3. PWM 不在"开"阶段（pwmState !== 'on'）→ null（page timer 只映射"关"事件）
//   4. enabled=false → null（关闭态无 PWM 循环，page timer 是独立手动定时，不干预）
//   5. 本地无未来触发时间（nextTriggerAt=0）→ 直接采纳 page timer
//   6. 偏差 ≤ toleranceMs → null（已对齐，避免时钟微抖动反复重调闹钟）
//   7. 偏差 > toleranceMs → 采纳 page timer（可能另一台设备刚手工设了页面定时器）
function computePageTimerAdoption(localSchedule, pageTimerInput, opts = {}) {
  const {
    now = Date.now(),
    toleranceMs = 60_000   // 偏差 ≤ 60s 视为已对齐——比 sync 的 10s 宽松，因为 page timer 是手工/异步设置
  } = opts;

  if (!pageTimerInput || !pageTimerInput.found || !pageTimerInput.value) return null;

  const parsed = parsePageTimerValue(pageTimerInput.value, now);
  if (!parsed || !parsed.valid) return null;

  // 只在 PWM enabled 且处于"开"阶段（下一步是"关"）才采纳 page timer
  if (!localSchedule?.enabled) return null;
  if (localSchedule.pwmState !== 'on') return null;

  const localTrigger = Number(localSchedule.nextTriggerAt) || 0;
  if (!localTrigger) {
    // 本地无未来触发但 PWM 在"开"阶段——page timer 是唯一信号
    return { adopt: true, nextTriggerAt: parsed.targetMs, source: 'page-timer', reason: 'local-no-trigger' };
  }

  const diff = Math.abs(parsed.targetMs - localTrigger);
  if (diff <= toleranceMs) {
    // 在容忍窗内——已对齐，不干预
    return null;
  }

  // 偏差超容忍窗——采纳 page timer 作为权威"关"时刻
  return { adopt: true, nextTriggerAt: parsed.targetMs, source: 'page-timer', reason: 'deviation' };
}

// ---- CommonJS/Node 兼容（SW 上下文没有 module） ----
// ESM interop：`import syncHelpers from './sync-helpers.js'` 会拿到 module.exports；
// 也可 `import { composeSyncPayload } from './sync-helpers.js'` 直接具名导入（Node 18+）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SYNC_FIELDS,
    composeSyncPayload,
    computePhaseAdoption,
    computeConfigDiff,
    parsePageTimerValue,
    computePageTimerAdoption
  };
}
