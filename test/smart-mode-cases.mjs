import smartMode from '../smart-mode.js';

export function runSmartModeCases(assertPass) {
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

  // 室内温度估计（EWMA + 太阳得热）
  const rtNight = new Date(2026, 8, 9, 22, 30, 0, 0).getTime();
  const rtNoon = new Date(2026, 8, 9, 13, 0, 0, 0).getTime();
  assertPass(Math.abs(smartMode.solarBumpC(rtNoon) - 2.5) < 1e-9
      && smartMode.solarBumpC(rtNight) === 0,
    'smart: 太阳得热余弦窗峰值 13:00 = 2.5°C，夜间归零');
  const rtEstimate = smartMode.estimateIndoorTemperature([
    { t: rtNight - 10 * 60000, c: 30.4 },
    { t: rtNight - 70 * 60000, c: 30.8 },
    { t: rtNight - 130 * 60000, c: 31.2 },
    { t: rtNight - 190 * 60000, c: 31.9 }
  ], rtNight);
  assertPass(rtEstimate.valid && Math.abs(rtEstimate.tIn - 30.88) < 0.05,
    'smart: EWMA τ=3h 序列估计 T_in ≈ 30.88（夜间无太阳项）');

  // 主入口：默认场景
  const smartDefault = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 30,
    observations: [{ t: rtNight, c: 30 }], nowMs: rtNight
  });
  assertPass(smartDefault.valid === true && smartDefault.runThrough !== true
      && smartDefault.onMinutes === 24 && smartDefault.offMinutes === 6,
    'smart: 默认场景 T_in=30 → 体感 35.8 → 需求 23.6 → 24/6（未过连转阈值）');

  const smartPrecise = smartMode.computeSmartOnMinutes({
    sensitivity: 10,
    temperature: 26.5,
    observations: [{ t: rtNight, c: 26.5 }],
    nowMs: rtNight
  });
  assertPass(smartPrecise.valid === true
      && Math.abs(smartPrecise.tRaw - 24.74) < 0.02
      && !Number.isInteger(smartPrecise.tRaw)
      && smartPrecise.onMinutes === 25
      && smartPrecise.offMinutes === 5,
    'smart: K/T_in/tRaw 保留浮点，仅最终 onMinutes 量化供显示与控制');

  // 湿度进入决策：同温不同露点给出不同时长（Steadman 水汽压项）
  const humidNight = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 28,
    observations: [{ t: rtNight, c: 28 }], nowMs: rtNight, dewPointC: 26
  });
  assertPass(humidNight.valid === true && humidNight.runThrough !== true
      && humidNight.onMinutes === 22 && humidNight.offMinutes === 8,
    'smart: 湿热夜（露点 26）28°C 中档 → 22/8');

  const dryNight = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 28,
    observations: [{ t: rtNight, c: 28 }], nowMs: rtNight, dewPointC: 18
  });
  assertPass(dryNight.onMinutes === 12 && dryNight.offMinutes === 18
      && dryNight.onMinutes < humidNight.onMinutes,
    'smart: 干热夜（露点 18）同温 → 12/18，湿度抬升湿热需求');

  const lowSliderNight = smartMode.computeSmartOnMinutes({
    sensitivity: 0, temperature: 28,
    observations: [{ t: rtNight, c: 28 }], nowMs: rtNight
  });
  assertPass(lowSliderNight.onMinutes === 7 && lowSliderNight.offMinutes === 23,
    'smart: 低档热夜按比例少开（0.3×3×7.8 → 7/23）');

  const midBandNight = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 27.6,
    observations: [{ t: rtNight, c: 27.6 }], nowMs: rtNight
  });
  assertPass(midBandNight.onMinutes === 18 && midBandNight.offMinutes === 12,
    'smart: 27.6°C 中档 → 18/12');

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
    observations: [{ t: rtNight, c: 30 }],
    nowMs: rtNight,
    ...override
  }));
  assertPass(legacyRainDecisions.every(decision => (
    ['valid', 'onMinutes', 'offMinutes', 'k', 'tIn', 'tRaw', 'reason']
      .every(key => Object.is(decision[key], smartDefault[key]))
  )), 'smart: 旧对象携带任意 rain/rainfall/precipitation 字段也不改变决策与 reason');
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
    observations: [{ t: rtNight, c: 33 }],
    nowMs: rtNight,
    rainMm: Number.MAX_VALUE
  });
  assertPass(smartHotLegacyRain.runThrough === true
      && smartHotLegacyRain.onMinutes === 30 && smartHotLegacyRain.offMinutes === 0,
    'smart: 极端旧雨量字段也不能改变高温连轴转决策（30/0）');

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

  // 冷天 → T_in 低于舒适目标 → 需求为负，不开启
  const smartCold = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 18,
    observations: [{ t: rtNight, c: 18 }], nowMs: rtNight
  });
  assertPass(smartCold.valid === true && smartCold.onMinutes === 0,
    'smart: 冷天 T_in < 舒适目标 → 需求为负，不开启');

  // 极热 + 满灵敏度 → 连轴转 30/0（30 分钟周期）
  const smartHot = smartMode.computeSmartOnMinutes({
    sensitivity: 10, temperature: 33,
    observations: [{ t: rtNight, c: 33 }], nowMs: rtNight
  });
  assertPass(smartHot.runThrough === true
      && smartHot.onMinutes === 30 && smartHot.offMinutes === 0,
    'smart: 极热满灵敏度 → 连轴转 30/0，顺延到下一半点重估');

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
    temperature: 27.5,
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
    'smart-plan: :20 预取生成目标 :30 快照，并在同一边界按原灵敏度直接消费');

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

  const consumeStoredWeather = typeof smartMode.consumeStoredSmartWeatherDecision === 'function'
    ? smartMode.consumeStoredSmartWeatherDecision
    : null;
  const cachedWeatherDecision = consumeStoredWeather
    ? consumeStoredWeather({
      fetchedAt: preparedBoundary - 10 * 60_000,
      temperature: 32.3,
      dewPoint: 20,
      windSpeedMs: 0,
      stale: false,
      error: ''
    }, { boundaryAt: preparedBoundary, sensitivity: 10 })
    : null;
  assertPass(consumeStoredWeather !== null
      && cachedWeatherDecision?.valid === true
      && cachedWeatherDecision.runThrough === true
      && cachedWeatherDecision.onMinutes === 30
      && cachedWeatherDecision.offMinutes === 0
      && cachedWeatherDecision.boundaryAt === preparedBoundary,
    'smart-plan: 目标 plan 丢失时可用边界前的新鲜本地天气重算（32.3°C 夜外单点 → 连轴转 30/0）');

  const cachedLegacyRainDecision = consumeStoredWeather
    ? consumeStoredWeather({
      fetchedAt: preparedBoundary - 10 * 60_000,
      temperature: 32.3,
      dewPoint: 20,
      windSpeedMs: 0,
      rainMm: 999,
      rainfall: 999,
      precipitation: 999,
      stale: false,
      error: ''
    }, { boundaryAt: preparedBoundary, sensitivity: 10 })
    : null;
  assertPass(cachedLegacyRainDecision?.onMinutes === cachedWeatherDecision?.onMinutes
      && cachedLegacyRainDecision?.offMinutes === cachedWeatherDecision?.offMinutes
      && !('rainFactor' in cachedLegacyRainDecision),
    'smart-plan: 旧天气缓存的 rainMm 多余字段不影响本地回退重算');

  assertPass(consumeStoredWeather !== null
      && consumeStoredWeather({
        ...preparedWeather,
        fetchedAt: preparedBoundary + 1
      }, { boundaryAt: preparedBoundary, sensitivity: 5 }) === null
      && consumeStoredWeather({
        ...preparedWeather,
        fetchedAt: preparedBoundary - smartMode.SMART_MODE.WEATHER_PLAN_MAX_AGE_MS - 1
      }, { boundaryAt: preparedBoundary, sensitivity: 5 }) === null
      && consumeStoredWeather({
        ...preparedWeather,
        stale: true
      }, { boundaryAt: preparedBoundary, sensitivity: 5 }) === null,
    'smart-plan: 本地天气回退拒绝边界后、过期或 stale 观测');

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
}
