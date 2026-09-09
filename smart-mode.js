// ============================================================
// smart-mode.js — 智能模式纯决策（无 chrome.* / DOM / 隐式浏览器状态）
// ============================================================
//
// 依据 HKUST 宿舍定频空调智能控制算法（0.9.0 室内估计版）：
//   1) 灵敏度系数 K = K_MIN + (档位 / 10) * (K_MAX - K_MIN)
//      → 档位 0 对应 K=0.30，档位 10 对应 K=1.30（共 11 档线性映射）
//   2) 室内温度估计 T_in = EWMA_τ(T_out 序列) + Δ_solar(t)，τ = 3h
//      （建筑热惯性滤波 + 白日太阳得热；人员/设备热折入舒适目标常数）
//   3) 原始开启分钟数 t_raw = K · 3 min/°C · (T_in − 24°C)
//   4) 需求 > 25 分钟 → 整周期连转（30/0），下一半点边界重新评估
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
    // 室内体感估计（0.9.3 恢复 Steadman 湿度/风修正）：
    //   T_in = EWMA_τ(T_out 观测序列) + Δ_solar(时刻)
    //   AT_in = T_in + 0.33·e − 0.70·w − 4（当前露点/风，缺露点回退 24°C）
    //   on = clamp(K · LOAD_GAIN_MIN_PER_C · (AT_in − T_COMFORT_C), 0, ON_MAX)
    // 需求 > ON_MAX 时整周期连转（30/0，见 computeSmartOnMinutes 的 runThrough）；
    // 满档（K=1.3）自然连转门槛 ≈ 室内 27°C（露点 24 时），热夜语义由公式自然涌现。
    EWMA_TAU_MS: 3 * 60 * 60 * 1000,      // 建筑热惯性时间常数 τ = 3h
    EWMA_MAX_AGE_MS: 12 * 60 * 60 * 1000, // 超龄观测直接出局
    SOLAR_PEAK_C: 2.5,                    // 白日太阳得热峰值（等效室温抬升）
    SOLAR_PEAK_HOUR: 13,                  // 峰值时刻 13:00（窗口直射 + 传导合成）
    SOLAR_HALF_WIDTH_H: 7.5,              // 半幅宽 7.5h → 5:30 前与 20:30 后归零
    LOAD_GAIN_MIN_PER_C: 2,               // 负载增益：每 °C 体感温差对应的开启分钟数（0.9.6 采纳作者提案）
    T_COMFORT_C: 23,                      // 体感零点：体感 23°C 需求为 0（0.9.6 回归作者原始标定）
    VAPOR_COEF: 0.33,                     // Steadman 水汽压系数（e 为 hPa）
    WIND_COEF: 0.7,                       // Steadman 风速系数（w 为 m/s）
    TEQ_OFFSET: -4,                       // Steadman 常数项
    DEW_POINT_FALLBACK_C: 24              // 露点缺失时的夏季典型回退值（fail-open）
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

  // 白日太阳得热近似（无需辐射数据）：以当地时间 13:00 为峰值的余弦窗，
  // 5:30 前与 20:30 后为 0。h = 当地小时（含分钟小数）。
  function solarBumpC(nowMs) {
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return 0;
    const date = new Date(now);
    const h = date.getHours() + date.getMinutes() / 60;
    const wave = Math.cos(
      (Math.PI * (h - SMART_MODE.SOLAR_PEAK_HOUR)) / SMART_MODE.SOLAR_HALF_WIDTH_H
    );
    return SMART_MODE.SOLAR_PEAK_C * Math.max(0, wave);
  }

  // 室内温度估计：室外观测序列的指数衰减加权平均（τ = EWMA_TAU_MS）+ 白日太阳得热。
  // observations: [{t: ms, c: °C}]；非法或超龄（> EWMA_MAX_AGE_MS）观测出局，
  // 无有效观测则 valid=false（调用方退化为当前单点，不加太阳项）。
  function estimateIndoorTemperature(observations, nowMs) {
    const now = Number(nowMs);
    if (!Number.isFinite(now)) {
      return { valid: false, tOutEwma: null, tIn: null };
    }
    const list = Array.isArray(observations) ? observations : [];
    let weightSum = 0;
    let weightedSum = 0;
    for (const obs of list) {
      const t = Number(obs?.t);
      const c = Number(obs?.c);
      if (!Number.isFinite(t) || !Number.isFinite(c) || t > now
          || now - t > SMART_MODE.EWMA_MAX_AGE_MS) {
        continue;
      }
      const weight = Math.exp(-(now - t) / SMART_MODE.EWMA_TAU_MS);
      weightSum += weight;
      weightedSum += weight * c;
    }
    if (weightSum <= 0) {
      return { valid: false, tOutEwma: null, tIn: null };
    }
    const tOutEwma = weightedSum / weightSum;
    const bump = solarBumpC(now);
    return { valid: true, tOutEwma, solarBumpC: bump, tIn: tOutEwma + bump };
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

  // 主入口：由室内体感估计 + 灵敏度系数计算建议开启分钟数。
  // observations: [{t: ms, c: °C}] 室外观测历史（顺序不限，按衰减权重处理）。
  // nowMs: 决策时刻（太阳项与衰减基准）；缺省时不加太阳项（等效深夜）。
  // dewPointC/windSpeedMs: 当前时刻湿度与风的 Steadman 修正输入；露点缺失
  // 回退 DEW_POINT_FALLBACK_C，风缺失按静风处理（fail-open）。
  // 无有效历史时退化为当前单点气温估计（冷启动可用）。
  // 返回 { valid, k, tIn, atIn, tRaw, runThrough?, onMinutes, offMinutes, reason }。
  //   valid=false 表示天气数据非法，调用方应退化为手动时长。
  function computeSmartOnMinutes({
    sensitivity,
    temperature,
    observations,
    nowMs,
    dewPointC,
    windSpeedMs
  } = {}) {
    const k = sensitivityToK(sensitivity);
    const estimate = estimateIndoorTemperature(observations, nowMs);
    let tIn;
    if (estimate.valid) {
      tIn = estimate.tIn;
    } else {
      // 冷启动/历史缺失：退化为当前观测单点，不加太阳项。
      const t = finiteNumber(temperature);
      if (t === null) {
        return {
          valid: false,
          reason: 'invalid-weather',
          k,
          onMinutes: 0,
          offMinutes: SMART_MODE.CYCLE_MINUTES
        };
      }
      tIn = t;
    }
    // Steadman 体感修正：湿度（水汽压）抬升、风折减，直接作用在室内估计上；
    // 湿热夜自动多开、干热夜按比例少开，热夜不再需要专门下限。
    const dew = finiteNumber(dewPointC);
    const dewSafe = dew === null ? SMART_MODE.DEW_POINT_FALLBACK_C : dew;
    const vaporPressure = vaporPressureFromDewPoint(dewSafe);
    const wind = finiteNumber(windSpeedMs);
    const atIn = vaporPressure === null
      ? tIn
      : tIn
        + SMART_MODE.VAPOR_COEF * vaporPressure
        - SMART_MODE.WIND_COEF * (wind === null ? 0 : wind)
        + SMART_MODE.TEQ_OFFSET;
    const tRaw = k
      * SMART_MODE.LOAD_GAIN_MIN_PER_C
      * (atIn - SMART_MODE.T_COMFORT_C);
    const rounded = Math.round(tRaw);
    if (rounded > SMART_MODE.ON_MAX) {
      // 连轴转：需求超过 25 分钟时整周期开启（30/0），下一半点边界再重新评估。
      // 退出连转时的关闭窗 = 30 − on* ≥ 5 分钟，天然满足压缩机最短停机时间；
      // 频繁启停（short cycling）才是压缩机磨损主因，连续运转无需强制休息。
      return {
        valid: true,
        k,
        tIn,
        atIn,
        tRaw,
        runThrough: true,
        onMinutes: SMART_MODE.CYCLE_MINUTES,
        offMinutes: 0
      };
    }
    const onMinutes = clampAndRoundOnMinutes(tRaw);
    return {
      valid: true,
      k,
      tIn,
      atIn,
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
    const observations = Array.isArray(weather?.history) ? weather.history : [];
    const decision = computeSmartOnMinutes({
      sensitivity: normalizedSensitivity,
      temperature: observation.temperature,
      observations,
      nowMs: boundary,
      dewPointC: observation.dewPoint,
      windSpeedMs: observation.windSpeedMs
    });
    if (!decision.valid) return null;

    return {
      schemaVersion: 1,
      boundaryAt: boundary,
      preparedAt: prepared,
      fetchedAt,
      sensitivity: normalizedSensitivity,
      weather: observation,
      observations,
      onMinutes: decision.onMinutes,
      offMinutes: decision.offMinutes,
      k: decision.k,
      tIn: decision.tIn,
      atIn: decision.atIn,
      tRaw: decision.tRaw,
      runThrough: decision.runThrough === true
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
      observations: Array.isArray(plan.observations) ? plan.observations : [],
      nowMs: boundaryAt,
      dewPointC: plan.weather.dewPoint,
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
      observations: Array.isArray(weather.history) ? weather.history : [],
      nowMs: boundaryAt,
      dewPointC: weather.dewPoint,
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
    solarBumpC,
    estimateIndoorTemperature,
    clampAndRoundOnMinutes,
    computeSmartOnMinutes,
    prepareSmartWeatherDecision,
    consumeSmartWeatherDecision,
    consumeStoredSmartWeatherDecision,
    parseTseungKwanOWeather
  };
});
