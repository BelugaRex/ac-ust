import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const storeDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(storeDir, '素材');
const baseUrl = process.env.AC_UST_STORE_PREVIEW_URL || 'http://127.0.0.1:8765';
const assets = [
  { name: 'screenshot-pwm', file: 'screenshot-1.png', width: 1280, height: 800 },
  { name: 'screenshot-smart', file: 'screenshot-2.png', width: 1280, height: 800 },
  { name: 'promo-small', file: 'promo-small.png', width: 440, height: 280 },
  { name: 'promo-marquee', file: 'promo-marquee.png', width: 1400, height: 560 }
];

const browser = await chromium.launch({ headless: true });
try {
  for (const asset of assets) {
    const context = await browser.newContext({
      viewport: { width: asset.width, height: asset.height },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'zh-CN'
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/%E5%95%86%E5%BA%97/%E7%B4%A0%E6%9D%90%E6%A8%A1%E6%9D%BF.html?asset=${asset.name}`, {
      waitUntil: 'networkidle'
    });
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.screenshot({
      path: path.join(outputDir, asset.file),
      type: 'png'
    });
    await context.close();
    console.log(`generated ${asset.file} (${asset.width}x${asset.height})`);
  }
} finally {
  await browser.close();
}