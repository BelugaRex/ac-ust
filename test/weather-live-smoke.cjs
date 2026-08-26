// 可选在线 smoke：访问 background.js 当前使用的四个 HKO URL，并复用生产解析器。
// 该脚本验证外部服务当前可达与协议形状，不进入确定性发布门禁。

const fs = require('fs');
const path = require('path');
const { parseTseungKwanOWeather } = require('../smart-mode.js');

const BACKGROUND_PATH = path.resolve(__dirname, '..', 'background.js');
const RESOURCE_NAMES = ['temperature', 'humidity', 'wind', 'rainfall'];

function readProductionWeatherUrls() {
  const source = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  const block = source.match(/const SMART_WEATHER_URLS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || '';
  const urls = {};
  for (const name of RESOURCE_NAMES) {
    const match = block.match(new RegExp(`${name}:\\s*'([^']+)'`));
    if (!match) throw new Error(`background.js 缺少 SMART_WEATHER_URLS.${name}`);
    urls[name] = match[1];
  }
  return urls;
}

async function fetchResource(name, url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: name === 'rainfall' ? 'application/json' : 'text/csv,*/*' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
  return name === 'rainfall' ? response.json() : response.text();
}

async function run() {
  const urls = readProductionWeatherUrls();
  const [temperatureCsv, humidityCsv, windCsv, rainfallData] = await Promise.all(
    RESOURCE_NAMES.map(name => fetchResource(name, urls[name]))
  );
  const weather = parseTseungKwanOWeather({
    temperatureCsv,
    humidityCsv,
    windCsv,
    rainfallData
  });
  if (!weather) throw new Error('四个在线响应无法解析为 Tseung Kwan O 同站天气');
  if (![weather.temperature, weather.relativeHumidity, weather.dewPoint,
    weather.windSpeedMs, weather.rainMm].every(Number.isFinite)) {
    throw new Error(`在线天气包含非有限值: ${JSON.stringify(weather)}`);
  }

  console.log('✅ HKO 四源在线 smoke 通过');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), urls, weather }, null, 2));
}

run().catch(error => {
  console.error('❌ HKO 四源在线 smoke 失败:', error?.message || String(error));
  process.exitCode = 1;
});
