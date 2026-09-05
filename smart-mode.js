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
//   5) 限幅到 [0, 25] 并四舍五入取整（30 分钟周期至少保留 5 分钟关闭窗口）
//   6) 压缩机保护：结果落在 1~4 分钟时强制设为 0（避免频繁启停）
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
    WEATHER_PLAN_MAX_AGE_MS: 60 * 60 * 1000,
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

  // 原始开启分钟数 t_raw = K * Teq。
  // t_raw 按 60 分钟参考周期标定；实际周期为 CYCLE_MINUTES 时按比例缩放，
  // 保持相同占空比（on/(on+off)），仅缩短单次开/关时长以减小温度摆幅。
  function rawOnMinutes(k, teq) {
    return k * teq * (SMART_MODE.CYCLE_MINUTES / SMART_MODE.REFERENCE_CYCLE_MINUTES);
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

  // ---- 将军澳 JKB 独立实时数据源解析 ----
  // 香港天文台分别提供气温、相对湿度与 10 分钟平均风；
  // 三个源都按站名精确选 Tseung Kwan O，避免把天文台湿度或静风混入。
  const HKO_SMART_STATION = 'Tseung Kwan O';

  function parseSimpleCsv(csvText) {
    if (typeof csvText !== 'string') return [];
    return csvText
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.split(',').map((cell) => {
        const trimmed = cell.trim();
        return trimmed.startsWith('"') && trimmed.endsWith('"')
          ? trimmed.slice(1, -1).replace(/""/g, '"')
          : trimmed;
      }));
  }

  function findStationCsvRow(csvText) {
    return parseSimpleCsv(csvText)
      .slice(1)
      .find(row => row[1] === HKO_SMART_STATION) || null;
  }

  // 返回 { temperature, relativeHumidity, dewPoint, windSpeedMs }；
  // 气温或同站湿度缺失时返回 null，调用方沿用旧缓存或退化为手动时长。
  function parseTseungKwanOWeather({
    temperatureCsv,
    humidityCsv,
    windCsv
  } = {}) {
    const temperature = finiteNumber(findStationCsvRow(temperatureCsv)?.[2]);
    const relativeHumidity = finiteNumber(findStationCsvRow(humidityCsv)?.[2]);
    if (temperature === null || relativeHumidity === null) return null;

    const windSpeedKmh = finiteNumber(findStationCsvRow(windCsv)?.[3]);
    const dewPoint = deriveDewPoint(temperature, relativeHumidity);
    if (dewPoint === null) return null;

    return {
      temperature,
      relativeHumidity,
      dewPoint,
      windSpeedMs: windSpeedKmh === null ? 0 : windSpeedKmh / 3.6
    };
  }

  // 主入口：由天气观测 + 灵敏度计算建议开启分钟数。
  // weather: { temperature, dewPoint, windSpeedMs }（气温/露点 °C，风速 m/s）
  // 返回 { valid, onMinutes, offMinutes, k, teq, tRaw, reason }。
  //   valid=false 表示天气数据非法，调用方应退化为手动时长。
  function computeSmartOnMinutes({ sensitivity, temperature, dewPoint, windSpeedMs } = {}) {
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
    const tRaw = rawOnMinutes(k, teq);
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

  function isExactHalfHourBoundary(timestamp) {
    const value = Number(timestamp);
    if (!Number.isSafeInteger(value)) return false;
    const date = new Date(value);
    return (date.getMinutes() === 0 || date.getMinutes() === 30)
      && date.getSeconds() === 0
      && date.getMilliseconds() === 0;
  }

  function prepareSmartWeatherDecision({
    boundaryAt,
    preparedAt = Date.now(),
    sensitivity,
    weather
  } = {}) {
    const boundary = Number(boundaryAt);
    const prepared = Number(preparedAt);
    const fetchedAt = Number(weather?.fetchedAt);
    if (!isExactHalfHourBoundary(boundary)
        || !Number.isSafeInteger(prepared)
        || !Number.isSafeInteger(fetchedAt)
        || fetchedAt <= 0
        || fetchedAt > prepared
        || prepared >= boundary
        || boundary - fetchedAt > SMART_MODE.WEATHER_PLAN_MAX_AGE_MS
        || weather?.stale === true
        || !!weather?.error) {
      return null;
    }

    const normalizedSensitivity = normalizeSmartSensitivity(sensitivity);
    const observation = {
      temperature: finiteNumber(weather?.temperature),
      relativeHumidity: finiteNumber(weather?.relativeHumidity),
      dewPoint: finiteNumber(weather?.dewPoint),
      windSpeedMs: finiteNumber(weather?.windSpeedMs)
    };
    const decision = computeSmartOnMinutes({
      sensitivity: normalizedSensitivity,
      ...observation
    });
    if (!decision.valid) return null;

    return {
      schemaVersion: 1,
      boundaryAt: boundary,
      preparedAt: prepared,
      fetchedAt,
      sensitivity: normalizedSensitivity,
      weather: observation,
      onMinutes: decision.onMinutes,
      offMinutes: decision.offMinutes,
      k: decision.k,
      teq: decision.teq,
      tRaw: decision.tRaw
    };
  }

  function consumeSmartWeatherDecision(plan, { boundaryAt, sensitivity } = {}) {
    const boundary = Number(boundaryAt);
    const preparedAt = Number(plan?.preparedAt);
    const fetchedAt = Number(plan?.fetchedAt);
    if (plan?.schemaVersion !== 1
        || !isExactHalfHourBoundary(boundary)
        || Number(plan?.boundaryAt) !== boundary
        || !Number.isSafeInteger(preparedAt)
        || !Number.isSafeInteger(fetchedAt)
        || fetchedAt <= 0
        || fetchedAt > preparedAt
        || preparedAt >= boundary
        || boundary - fetchedAt > SMART_MODE.WEATHER_PLAN_MAX_AGE_MS
        || !plan.weather
        || typeof plan.weather !== 'object') {
      return null;
    }

    const normalizedSensitivity = normalizeSmartSensitivity(sensitivity);
    const decision = computeSmartOnMinutes({
      sensitivity: normalizedSensitivity,
      temperature: plan.weather.temperature,
      dewPoint: plan.weather.dewPoint,
      windSpeedMs: plan.weather.windSpeedMs
    });
    if (!decision.valid) return null;
    return {
      ...decision,
      boundaryAt: boundary,
      preparedAt,
      fetchedAt,
      preparedSensitivity: normalizeSmartSensitivity(plan.sensitivity),
      usedPreparedSensitivity: normalizedSensitivity
        === normalizeSmartSensitivity(plan.sensitivity)
    };
  }

  // 目标绑定的预计算快照可能因 SW 重启或 storage 写入竞态而缺失。边界执行仍可
  // 使用边界前、未过期的同一份本地天气纯计算；绝不在 :00/:30 临界路径联网。
  function consumeStoredSmartWeatherDecision(weather, { boundaryAt, sensitivity } = {}) {
    const boundary = Number(boundaryAt);
    const fetchedAt = Number(weather?.fetchedAt);
    if (!isExactHalfHourBoundary(boundary)
        || !Number.isSafeInteger(fetchedAt)
        || fetchedAt <= 0
        || fetchedAt > boundary
        || boundary - fetchedAt > SMART_MODE.WEATHER_PLAN_MAX_AGE_MS
        || weather?.stale === true
        || !!weather?.error) {
      return null;
    }

    const decision = computeSmartOnMinutes({
      sensitivity: normalizeSmartSensitivity(sensitivity),
      temperature: weather.temperature,
      dewPoint: weather.dewPoint,
      windSpeedMs: weather.windSpeedMs
    });
    if (!decision.valid) return null;
    return {
      ...decision,
      boundaryAt: boundary,
      fetchedAt,
      source: 'stored-weather'
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
    prepareSmartWeatherDecision,
    consumeSmartWeatherDecision,
    consumeStoredSmartWeatherDecision,
    parseTseungKwanOWeather
  };
});
