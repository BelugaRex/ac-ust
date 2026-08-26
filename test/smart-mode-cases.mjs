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

  // 等效室外温度 Teq
  const smartTeq = smartMode.equivalentTemperature(30, 24, 1.5);
  assertPass(Math.abs(smartTeq - 34.79) < 0.5, 'smart: Teq = T + 0.33e - 0.70Wind - 4');

  // 主入口：默认场景
  const smartDefault = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 30, dewPoint: 24, windSpeedMs: 1.5, rainMm: 0
  });
  assertPass(smartDefault.valid === true && smartDefault.onMinutes === 14 && smartDefault.offMinutes === 16,
    'smart: 默认场景 on=14/off=16（30 分钟周期开关互补）');

  const smartPrecise = smartMode.computeSmartOnMinutes({
    sensitivity: 10,
    temperature: 32.3,
    dewPoint: 10,
    windSpeedMs: 0,
    rainMm: 0
  });
  assertPass(smartPrecise.valid === true
      && Math.abs(smartPrecise.tRaw - 21.03) < 0.02
      && !Number.isInteger(smartPrecise.tRaw)
      && smartPrecise.onMinutes === 21
      && smartPrecise.offMinutes === 9,
    'smart: K/天气/Teq/tRaw 保留浮点，仅最终 onMinutes 量化供显示与控制');

  // 降雨修正：0~30 mm/h 后段更陡的归一化指数曲线，黄雨阈值及以上最多减半
  const expectedRainFactor = (rainMm) => {
    const normalizedRain = Math.min(1, Math.max(0, rainMm / 30));
    const normalizedImpact = (Math.exp(2 * normalizedRain) - 1) / (Math.exp(2) - 1);
    return 1 - 0.5 * normalizedImpact;
  };
  const expectedRainFactors = [
    [0, 1],
    [5, expectedRainFactor(5)],
    [10, expectedRainFactor(10)],
    [15, expectedRainFactor(15)],
    [20, expectedRainFactor(20)],
    [25, expectedRainFactor(25)],
    [30, 0.5],
    [60, 0.5]
  ];
  assertPass(expectedRainFactors.every(([rainMm, expected]) => (
    Math.abs(smartMode.rainOnTimeFactor(rainMm) - expected) < 1e-9
  )), 'smart: 雨量 0~30mm/h 按 α=2 归一化指数曲线降到 50%');

  const rainFactorSamples = Array.from({ length: 301 }, (_, index) => (
    smartMode.rainOnTimeFactor(index / 10)
  ));
  assertPass(rainFactorSamples.every((factor, index) => (
    factor >= 0.5 && factor <= 1
      && (index === 0 || factor < rainFactorSamples[index - 1])
  )), 'smart: 0~30mm/h 全区间连续单调递减且倍率始终为 0.5~1');
  const fiveMillimeterDrops = [0, 5, 10, 15, 20, 25, 30]
    .map(rainMm => smartMode.rainOnTimeFactor(rainMm))
    .slice(1)
    .map((factor, index, factors) => (
      (index === 0 ? 1 : factors[index - 1]) - factor
    ));
  assertPass(fiveMillimeterDrops.every((drop, index) => (
    index === 0 || drop > fiveMillimeterDrops[index - 1]
  )), 'smart: 每增加 5mm 的开启时间折减随雨势增强而严格增大');
  assertPass(Math.abs(
    smartMode.rainOnTimeFactor(5.0001) - smartMode.rainOnTimeFactor(5)
  ) < 1e-5
      && smartMode.rainOnTimeFactor(5.0001) > 0.5,
    'smart: 旧 5mm 阈值附近无阶跃，不会刚超过 5mm 就直接减半');
  assertPass([
    -1,
    null,
    undefined,
    '',
    Number.NaN
  ].every(rainMm => smartMode.rainOnTimeFactor(rainMm) === 1),
  'smart: 负数或缺失/非法雨量按无雨处理，不意外缩短开启时间');

  const hotRawOnMinutes = smartMode.rawOnMinutes(1.30, 40.5);
  const hotRainMinutes = [0, 5, 10, 15, 20, 25, 30].map(rainMm => (
    smartMode.finalizeRainAdjustedOnMinutes(hotRawOnMinutes, rainMm)
  ));
  assertPass(Math.abs(hotRawOnMinutes - 26.325) < 1e-9
      && hotRainMinutes.join(',') === '25,24,23,22,20,17,13',
    'smart: Teq=40.5/档位10 小雨温和、暴雨加速折减，黄雨为 13/30');

  const rainFinalizationCases = [4.4, 4.6, 5, 6, 7, 8, 9, 10, 14, 25, 26.325];
  assertPass(rainFinalizationCases.every((tRaw) => {
    const dry = smartMode.finalizeRainAdjustedOnMinutes(tRaw, 0);
    const yellowRain = smartMode.finalizeRainAdjustedOnMinutes(tRaw, 30);
    return yellowRain <= dry
      && yellowRain >= Math.ceil(dry * 0.5)
      && (yellowRain === 0 || yellowRain >= 5);
  }), 'smart: 最终分钟数叠加压缩机死区后仍最多减半，非零开启至少 5 分钟');

  const smartRain = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: 30, dewPoint: 24, windSpeedMs: 1.5, rainMm: 10
  });
  assertPass(smartRain.onMinutes === 13
      && Math.abs(smartRain.rainFactor - expectedRainFactor(10)) < 1e-9,
    'smart: 10mm/h 仅温和折减，较大雨量才加速接近减半');

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
    sensitivity: 5, temperature: 18, dewPoint: 10, windSpeedMs: 3, rainMm: 0
  });
  assertPass(smartCold.valid === true && smartCold.onMinutes === 6,
    'smart: 冷天 Teq 低 → on=6');

  // 极热 + 满灵敏度 → 25/5（30 分钟周期）
  const smartHot = smartMode.computeSmartOnMinutes({
    sensitivity: 10, temperature: 33, dewPoint: 26, windSpeedMs: 0, rainMm: 0
  });
  assertPass(smartHot.onMinutes === 25 && smartHot.offMinutes === 5,
    'smart: 极热满灵敏度 on=25/off=5，避免短时间关机后重启');

  // 非法天气 → valid=false（调用方退化为手动时长）
  const smartBad = smartMode.computeSmartOnMinutes({
    sensitivity: 5, temperature: null, dewPoint: 24, windSpeedMs: 1.5, rainMm: 0
  });
  assertPass(smartBad.valid === false, 'smart: 非法天气 valid=false');

  // 露点逆推（Magnus）：由气温 + 湿度推导露点（HKO 开放数据不直接提供露点）
  const smartDew = smartMode.deriveDewPoint(30, 80);
  assertPass(smartDew !== null && Math.abs(smartDew - 26.2) < 0.5,
    'smart: deriveDewPoint(30°C, 80%) ≈ 26.2°C');

  // 将军澳 JKB 多源解析：同站温湿度、风速 km/h→m/s、站点雨量，不混用西贡区值
  const hkoWeather = smartMode.parseTseungKwanOWeather({
    temperatureCsv: '\uFEFFDate time,Automatic Weather Station,Air Temperature(degree Celsius)\r\n'
      + '202608241510,Sai Kung,33.3\r\n202608241510,Tseung Kwan O,32.6\r\n',
    humidityCsv: 'Date time,Automatic Weather Station,Relative Humidity(percent)\n'
      + '202608241510,HK Observatory,73\n202608241510,Tseung Kwan O,67\n',
    windCsv: 'Date time,Automatic Weather Station,Direction,Speed,Gust\n'
      + '202608241510,Sai Kung,South,10,21\n202608241510,Tseung Kwan O,Southwest,16,26\n',
    rainfallData: {
      hourlyRainfall: [
        { automaticWeatherStation: 'Sai Kung', value: '40', unit: 'mm' },
        { automaticWeatherStation: 'Tseung Kwan O', value: '6', unit: 'mm' }
      ]
    }
  });
  assertPass(hkoWeather !== null
      && hkoWeather.temperature === 32.6
      && hkoWeather.relativeHumidity === 67
      && Math.abs(hkoWeather.windSpeedMs - 16 / 3.6) < 1e-9
      && hkoWeather.rainMm === 6
      && Number.isFinite(hkoWeather.dewPoint),
    'smart: JKB 四源解析使用同站温湿度/风/雨量并推导露点');

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
    rainMm: 6,
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
      && consumedPreparedDecision?.valid === true
      && consumedPreparedDecision.onMinutes === preparedDecision.onMinutes
      && consumedPreparedDecision.offMinutes === preparedDecision.offMinutes
      && consumedPreparedDecision.usedPreparedSensitivity === true,
    'smart-plan: :20 预取生成目标 :30 快照，并在同一边界按原灵敏度直接消费');

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
      dewPoint: 10,
      windSpeedMs: 0,
      rainMm: 0,
      stale: false,
      error: ''
    }, { boundaryAt: preparedBoundary, sensitivity: 10 })
    : null;
  assertPass(consumeStoredWeather !== null
      && cachedWeatherDecision?.valid === true
      && cachedWeatherDecision.onMinutes === 21
      && cachedWeatherDecision.offMinutes === 9
      && cachedWeatherDecision.boundaryAt === preparedBoundary,
    'smart-plan: 目标 plan 丢失时可用边界前的新鲜本地天气重算 21/30，不沿用旧 12 分钟');

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
