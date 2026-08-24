// ============================================================
// smart-mode.js — 智能模式纯决策（无 chrome.* / DOM / 隐式浏览器状态）
// ============================================================
//
// 依据 HKUST 宿舍定频空调智能控制算法（严格实现）：
//   1) 灵敏度系数 K = K_MIN + (档位 / 10) * (K_MAX - K_MIN)
//      → 档位 0 对应 K=0.30，档位 10 对应 K=1.30（共 11 档线性映射）
//   2) 水汽压 e (hPa) = 6.112 * exp((17.67 * Td) / (Td + 243.5))
//   3) 等效室外温度 Teq = T + 0.33*e - 0.70*Wind - 4.00
//   4) 原始开启分钟数 t_raw = K * Teq
//   5) 降雨修正：若 Rain > 5.0 则 t_raw *= 0.5
//   6) 限幅到 [0, 25] 并四舍五入取整（30 分钟周期至少保留 5 分钟关闭窗口）
//   7) 压缩机保护：结果落在 1~4 分钟时强制设为 0（避免频繁启停）
//
// 所有中间计算均使用浮点数，仅在最终输出时取整。
// 关键参数定义为常量，方便日后调整。
//
// 本文件只放无副作用的决策逻辑，方便在 Node 单元测试里直接 import 验证；
// 天气取数与 chrome.storage 读写由 background.js 负责。加载方式与
// billing-helpers.js 相同（SW importScripts / popup <script> / Node require 三兼容）。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  // ---- 可调常量（后续可在此集中调整） ----
  const SMART_MODE = Object.freeze({
    K_MIN: 0.30,                 // 灵敏度档位 0 对应的 K
    K_MAX: 1.30,                 // 灵敏度档位 10 对应的 K
    CYCLE_MINUTES: 30,           // 控制周期 30 分钟（比 60 分钟切换更频繁，减小过冷/过热摆幅）
    REFERENCE_CYCLE_MINUTES: 60, // t_raw = K*Teq 的标定参考周期（保持占空比不变）
    ON_MIN: 0,                   // 开启分钟数下限
    ON_MAX: 25,                  // 开启分钟数上限（30 分钟周期至少关闭 5 分钟）
    MIN_OFF_MINUTES: 5,          // 相邻智能 ON 周期之间的最短关闭窗口
    RAIN_THRESHOLD_MM: 5.0,      // 降雨修正触发阈值 (mm)
    RAIN_REDUCTION_FACTOR: 0.5,  // 降雨修正倍率
    COMPRESSOR_DEADBAND_MIN: 1,  // 压缩机保护死区下界
    COMPRESSOR_DEADBAND_MAX: 4,  // 压缩机保护死区上界
    // Teq = T + VAPOR_COEF*e - WIND_COEF*Wind + TEQ_OFFSET
    VAPOR_COEF: 0.33,
    WIND_COEF: 0.70,
    TEQ_OFFSET: -4.00
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // 严格数字转换：null / undefined / '' 视为非法，避免 Number(null)=0 把缺失温度当 0°C。
  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // 设置兼容归一化：当前使用 0~10 整数档；旧版 0~100 值按 /10 迁移。
  function normalizeSmartSensitivity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 5;
    const normalized = n > 10 ? n / 10 : n;
    return Math.round(clamp(normalized, 0, 10));
  }

  // 灵敏度档位 (0~10，共 11 档) → 灵敏度系数 K (0.30~1.30)。
  function sensitivityToK(sensitivity) {
    const s = Number(sensitivity);
    if (!Number.isFinite(s)) return SMART_MODE.K_MIN;
    const normalized = clamp(s, 0, 10);
    return SMART_MODE.K_MIN + (normalized / 10) * (SMART_MODE.K_MAX - SMART_MODE.K_MIN);
  }

  // Magnus 公式：由露点温度 Td (°C) 计算水汽压 e (hPa)。
  // 返回 null 表示输入非法。
  function vaporPressureFromDewPoint(dewPointC) {
    const td = finiteNumber(dewPointC);
    if (td === null) return null;
    return 6.112 * Math.exp((17.67 * td) / (td + 243.5));
  }

  // Magnus 逆推：由气温 T (°C) + 相对湿度 RH (%) 推导露点 Td (°C)。
  // 天文台开放数据（rhrread）不直接提供露点，故用气温 + 湿度按 Magnus 公式推导，
  // 再交回 forward Magnus（vaporPressureFromDewPoint）计算水汽压，保证算法结构不变。
  function deriveDewPoint(temperatureC, relativeHumidityPercent) {
    const t = finiteNumber(temperatureC);
    const rhRaw = finiteNumber(relativeHumidityPercent);
    if (t === null || rhRaw === null || rhRaw <= 0) return null;
    const rh = clamp(rhRaw, 0, 100);
    const es = 6.112 * Math.exp((17.67 * t) / (t + 243.5));  // 饱和水汽压
    const e = es * rh / 100;                                  // 实际水汽压
    const ln = Math.log(e / 6.112);
    return (243.5 * ln) / (17.67 - ln);
  }

  // 等效室外温度 Teq = T + 0.33*e - 0.70*Wind - 4.00。
  // windSpeedMs 为 m/s；返回 null 表示温度或露点非法。
  function equivalentTemperature(temperatureC, dewPointC, windSpeedMs) {
    const t = finiteNumber(temperatureC);
    if (t === null) return null;
    const wind = finiteNumber(windSpeedMs);
    const windSafe = wind === null ? 0 : wind;
    const e = vaporPressureFromDewPoint(dewPointC);
    if (e === null) return null;
    return t + SMART_MODE.VAPOR_COEF * e - SMART_MODE.WIND_COEF * windSafe + SMART_MODE.TEQ_OFFSET;
  }

  // 原始开启分钟数 t_raw = K * Teq，叠加降雨修正。
  // t_raw 按 60 分钟参考周期标定；实际周期为 CYCLE_MINUTES 时按比例缩放，
  // 保持相同占空比（on/(on+off)），仅缩短单次开/关时长以减小温度摆幅。
  function rawOnMinutes(k, teq, rainMm) {
    let tRaw = k * teq;
    const rain = finiteNumber(rainMm);
    if (rain !== null && rain > SMART_MODE.RAIN_THRESHOLD_MM) {
      tRaw *= SMART_MODE.RAIN_REDUCTION_FACTOR;
    }
    return tRaw * (SMART_MODE.CYCLE_MINUTES / SMART_MODE.REFERENCE_CYCLE_MINUTES);
  }

  // 限幅到 [0, 25] → 四舍五入 → 压缩机保护（1~4 → 0）。
  function clampAndRoundOnMinutes(tRaw) {
    const clamped = clamp(Number(tRaw), SMART_MODE.ON_MIN, SMART_MODE.ON_MAX);
    let rounded = Math.round(clamped);
    if (rounded >= SMART_MODE.COMPRESSOR_DEADBAND_MIN
        && rounded <= SMART_MODE.COMPRESSOR_DEADBAND_MAX) {
      rounded = 0;
    }
    return rounded;
  }

  // ---- 天文台开放数据（rhrread）解析 ----
  // 数据源：香港天文台开放数据 API `weather.php?dataType=rhrread`（Current Weather Report）。
  // 实测其提供：气温（多站）、湿度（仅天文台一站）、分区雨量；**不提供露点与风速**。故：
  //   - 气温：优先取将军澳站（Tseung Kwan O，站号 JKB），回退到西贡/清水湾/天文台
  //   - 露点：由气温 + 湿度用 Magnus 逆推（deriveDewPoint，天文台开放数据不提供露点）
  //   - 风速：天文台开放数据不提供，取 0（静风）为保守默认（风项在算法中保留）
  //   - 雨量：取西贡区（HKUST 所在分区）过去 1 小时雨量
  const HKO_TEMP_STATIONS = ['Tseung Kwan O', 'Sai Kung', 'Clear Water Bay', 'Hong Kong Observatory'];
  const HKO_HUMIDITY_STATION = 'Hong Kong Observatory';
  const HKO_RAIN_DISTRICT = 'Sai Kung';
  const HKO_DEFAULT_WIND_MS = 0;

  // 解析 rhrread JSON → { temperature, relativeHumidity, dewPoint, windSpeedMs, rainMm }。
  // 任一关键字段（气温）缺失时返回 null，调用方应退化为手动时长。
  function parseRhrreadWeather(data) {
    if (!data || typeof data !== 'object') return null;

    const tempList = Array.isArray(data.temperature?.data) ? data.temperature.data : [];
    let temperature = null;
    for (const name of HKO_TEMP_STATIONS) {
      const hit = tempList.find((s) => s?.place === name && finiteNumber(s?.value) !== null);
      if (hit) { temperature = finiteNumber(hit.value); break; }
    }
    if (temperature === null) {
      const first = tempList.find((s) => finiteNumber(s?.value) !== null);
      if (first) temperature = finiteNumber(first.value);
    }
    if (temperature === null) return null;

    const humList = Array.isArray(data.humidity?.data) ? data.humidity.data : [];
    const humidity = finiteNumber(humList.find((s) => s?.place === HKO_HUMIDITY_STATION)?.value)
      ?? finiteNumber(humList[0]?.value) ?? 0;

    const rainList = Array.isArray(data.rainfall?.data) ? data.rainfall.data : [];
    const rainEntry = rainList.find((r) => r?.place === HKO_RAIN_DISTRICT)
      || rainList.find((r) => String(r?.main).toUpperCase() === 'TRUE');
    const rainValue = rainEntry
      ? (finiteNumber(rainEntry.max) ?? finiteNumber(rainEntry.max1))
      : null;

    return {
      temperature,
      relativeHumidity: humidity,
      dewPoint: deriveDewPoint(temperature, humidity),
      windSpeedMs: HKO_DEFAULT_WIND_MS,
      rainMm: rainValue ?? 0
    };
  }

  // 主入口：由天气观测 + 灵敏度计算建议开启分钟数。
  // weather: { temperature, dewPoint, windSpeedMs, rainMm }（气温/露点 °C，风速 m/s，雨量 mm）
  // 返回 { valid, onMinutes, offMinutes, k, teq, tRaw, reason }。
  //   valid=false 表示天气数据非法，调用方应退化为手动时长。
  function computeSmartOnMinutes({ sensitivity, temperature, dewPoint, windSpeedMs, rainMm } = {}) {
    const k = sensitivityToK(sensitivity);
    const teq = equivalentTemperature(temperature, dewPoint, windSpeedMs);
    if (teq === null) {
      return {
        valid: false,
        reason: 'invalid-weather',
        k,
        onMinutes: 0,
        offMinutes: SMART_MODE.CYCLE_MINUTES
      };
    }
    const tRaw = rawOnMinutes(k, teq, rainMm);
    const onMinutes = clampAndRoundOnMinutes(tRaw);
    return {
      valid: true,
      k,
      teq,
      tRaw,
      onMinutes,
      offMinutes: SMART_MODE.CYCLE_MINUTES - onMinutes
    };
  }

  return {
    SMART_MODE,
    normalizeSmartSensitivity,
    sensitivityToK,
    vaporPressureFromDewPoint,
    deriveDewPoint,
    equivalentTemperature,
    rawOnMinutes,
    clampAndRoundOnMinutes,
    computeSmartOnMinutes,
    parseRhrreadWeather
  };
});
