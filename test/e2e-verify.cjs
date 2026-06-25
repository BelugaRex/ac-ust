// 端到端测试:加载真实 dist/ 扩展,模拟用户场景,验证红灯转绿灯
// 这是 evaluator 要求的"在实际运行的扩展中看到红灯被解决"
//
// 流程:
// 1. 用 Playwright 启动 Chromium,加载 dist/ 扩展
// 2. 通过 service worker 设置 storage 模拟用户报告的场景:
//    - enabled=true, clockMode=false(间隔模式), nextTriggerAt=0(缺失,红灯根因)
//    - 创建未来的 ac-pwm 闹钟(模拟"活闹钟在")
// 3. 打开 chrome-extension://<id>/popup.html
// 4. 点击 #btnDiagnose 按钮
// 5. 读取 #diagnoseResult 的实际文本输出
// 6. 断言两个红灯都已消除并显示"(popup 已自愈)"

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'dist');
const PROFILE_DIR = path.resolve(__dirname, '..', '.test-profile');

async function run() {
  console.log('=== 端到端测试: 真实扩展中验证红灯转绿灯 ===\n');
  console.log('扩展路径:', EXT_PATH, '\n');

  let context;
  let launchError = null;
  const launchArgs = [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate'
  ];

  // 尝试系统已装的 Edge / Chrome,fallback 到 Playwright Chromium
  for (const launchOpts of [
    { channel: 'msedge', headless: false },
    { channel: 'chrome', headless: false },
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
    { headless: false },
    { headless: true }
  ]) {
    try {
      console.log('尝试启动浏览器:', JSON.stringify(launchOpts));
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...launchOpts,
        args: launchArgs
      });
      console.log('启动成功:', JSON.stringify(launchOpts), '\n');
      launchError = null;
      break;
    } catch (e) {
      console.log('  失败:', e.message.split('\n')[0]);
      launchError = e;
    }
  }
  if (!context) {
    console.error('❌ 所有浏览器启动方式都失败');
    if (launchError) console.error('最后一次错误:', launchError.message);
    process.exit(3);
  }

  try {
    // 等待 service worker 注册(扩展加载完成的信号)
    let serviceWorker;
    try {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    } catch (e) {
      // 已有 service worker 时从已存在列表中取
      serviceWorker = context.serviceWorkers()[0];
    }
    if (!serviceWorker) {
      throw new Error('未找到扩展 service worker,扩展可能未加载');
    }

    // 等待扩展完成 init(给 SW 时间跑 init 流程,用 evaluate 轮询而非 waitForFunction)
    const initDeadline = Date.now() + 8000;
    while (Date.now() < initDeadline) {
      const ready = await serviceWorker.evaluate(async () => {
        try {
          const { ac_schedule } = await chrome.storage.local.get('ac_schedule');
          return !!ac_schedule;
        } catch (_) { return false; }
      }).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 300));
    }

    // 提取扩展 ID
    const swUrl = serviceWorker.url();
    const extensionId = swUrl.split('/')[2];
    console.log('扩展已加载,ID:', extensionId, '\n');

    // === 模拟用户报告的场景 ===
    console.log('--- 步骤 1: 设置用户场景 ---');
    const pwmScheduledTime = Date.now() + 5 * 60 * 1000;
    await serviceWorker.evaluate(async (schedTime) => {
      // 写入 storage:nextTriggerAt=0(红灯根因)
      await chrome.storage.local.set({
        ac_schedule: {
          enabled: true,
          mode: 'pwm',
          clockMode: false,
          onMinutes: 60,
          offMinutes: 60,
          pwmState: 'off',
          nextTriggerAt: 0,
          alarmCreatedAt: 0,
          alarmDelayMinutes: 0,
          pageTimerMinutes: null,
          pageTimerError: '',
          pageTimerRetryAt: 0
        }
      });
      // 创建未来的 ac-pwm 闹钟(模拟"活闹钟在")
      await chrome.alarms.clear('ac-pwm');
      await chrome.alarms.create('ac-pwm', { when: schedTime });
    }, pwmScheduledTime);

    // 等一下让 storage/alarms 写入完成
    await new Promise(r => setTimeout(r, 500));

    // 验证场景已设置
    const sceneCheck = await serviceWorker.evaluate(async () => {
      const { ac_schedule } = await chrome.storage.local.get('ac_schedule');
      const alarm = await chrome.alarms.get('ac-pwm');
      return {
        nextTriggerAt: ac_schedule.nextTriggerAt,
        enabled: ac_schedule.enabled,
        clockMode: ac_schedule.clockMode,
        acPwmScheduledTime: alarm?.scheduledTime || 0
      };
    });
    console.log('场景设置完成:');
    console.log('  storage.nextTriggerAt =', sceneCheck.nextTriggerAt, '(应为 0)');
    console.log('  storage.enabled =', sceneCheck.enabled);
    console.log('  storage.clockMode =', sceneCheck.clockMode, '(false=间隔)');
    console.log('  ac-pwm.scheduledTime =', new Date(sceneCheck.acPwmScheduledTime).toLocaleTimeString(),
                '(' + sceneCheck.acPwmScheduledTime + ')');
    console.log('');

    // === 打开 popup.html,点击诊断按钮 ===
    console.log('--- 步骤 2: 打开 popup.html,点击诊断按钮 ---\n');
    const popupPage = await context.newPage();
    popupPage.on('console', msg => {
      const t = msg.type();
      if (t === 'log' || t === 'warn' || t === 'error' || t === 'info') {
        console.log('  [popup console]', t + ':', msg.text().slice(0, 250));
      }
    });
    popupPage.on('pageerror', err => console.log('  [popup error]', err.message.slice(0, 250)));

    console.log('  打开 popup.html...');
    try {
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: 10000, waitUntil: 'load' });
    } catch (e) {
      console.log('  goto 等待 load 失败,继续:', e.message.split('\n')[0]);
    }
    await new Promise(r => setTimeout(r, 1500));

    // 检查 popup 是否正常加载
    const popupState = await popupPage.evaluate(() => ({
      hasVersion: !!document.getElementById('versionInfo'),
      versionText: document.getElementById('versionInfo')?.textContent || '',
      hasBtn: !!document.getElementById('btnDiagnose'),
      hasResult: !!document.getElementById('diagnoseResult')
    })).catch(e => ({ error: e.message }));
    console.log('  popup 状态:', JSON.stringify(popupState));

    if (!popupState.hasBtn) {
      throw new Error('popup 未加载诊断按钮,popup.js 可能未执行');
    }

    console.log('  点击 #btnDiagnose...');
    await popupPage.click('#btnDiagnose', { timeout: 5000 });

    // 等待诊断完成(轮询 #diagnoseResult 内容长度)
    const diagDeadline = Date.now() + 20000;
    let diagnoseText = '';
    while (Date.now() < diagDeadline) {
      diagnoseText = await popupPage.$eval('#diagnoseResult', el => el.innerText).catch(() => '');
      if (diagnoseText.length > 100 && !diagnoseText.includes('诊断中')) break;
      await new Promise(r => setTimeout(r, 300));
    }

    // 给自愈逻辑 1.5 秒跑完
    await new Promise(r => setTimeout(r, 1500));
    diagnoseText = await popupPage.$eval('#diagnoseResult', el => el.innerText).catch(() => '<读取失败>');
    console.log('--- 真实扩展中的诊断输出 ---');
    console.log(diagnoseText);
    console.log('');

    // 读取 popup 标题行(BUILD_TIME)
    const versionLine = await popupPage.$eval('#versionInfo', el => el.textContent);
    console.log('Popup 版本行:', versionLine);
    console.log('');

    // === 读取修复后的真实 storage ===
    const finalStorage = await serviceWorker.evaluate(async () => {
      return (await chrome.storage.local.get('ac_schedule')).ac_schedule;
    });
    console.log('--- 修复后真实 storage ---');
    console.log('  nextTriggerAt =', finalStorage.nextTriggerAt,
                finalStorage.nextTriggerAt ? '(' + new Date(finalStorage.nextTriggerAt).toLocaleTimeString() + ')' : '');
    console.log('  alarmCreatedAt =', finalStorage.alarmCreatedAt);
    console.log('  alarmDelayMinutes =', finalStorage.alarmDelayMinutes?.toFixed(2));
    console.log('');

    // === 断言 ===
    const results = [];
    const assert = (cond, name) => {
      const tag = cond ? '✅ PASS' : '❌ FAIL';
      console.log(`${tag}  ${name}`);
      results.push({ name, pass: !!cond });
    };

    console.log('--- 断言 ---');
    // 关键断言:两个红灯都消除
    assert(!diagnoseText.includes('❌ storage 绝对触发时间缺失'),
      '红灯 #1 已消除:诊断输出不再包含 "❌ storage 绝对触发时间缺失"');
    assert(!diagnoseText.includes('❌ ac-pwm 与 storage 触发时间同步'),
      '红灯 #2 已消除:诊断输出不再包含 "❌ ac-pwm 与 storage 触发时间同步"');
    // 关键断言:出现绿灯带"已自愈"标签
    assert(diagnoseText.includes('✅ storage 绝对触发时间') && diagnoseText.includes('(popup 已自愈)'),
      '绿灯出现:✅ storage 绝对触发时间 ... (popup 已自愈)');
    assert(diagnoseText.includes('✅ ac-pwm 与 storage 触发时间同步') && diagnoseText.includes('(popup 已自愈)'),
      '绿灯出现:✅ ac-pwm 与 storage 触发时间同步 ... (popup 已自愈)');
    // storage 实际被写入
    assert(finalStorage.nextTriggerAt === pwmScheduledTime,
      '真实 storage.nextTriggerAt 已修复为 ac-pwm.scheduledTime');
    // BUILD_TIME 显示(证明扩展加载的是新代码)
    assert(versionLine.includes('0.4.31'),
      'Popup 版本行显示 v0.4.31');
    assert(versionLine.includes('2026-06-26'),
      'Popup 显示 BUILD_TIME(扩展加载的是最新 build)');

    // 汇总
    const passCount = results.filter(r => r.pass).length;
    console.log(`\n=== 测试汇总: ${passCount}/${results.length} 通过 ===`);
    if (passCount !== results.length) {
      console.log('\n失败项:');
      results.filter(r => !r.pass).forEach(r => console.log('  - ' + r.name));
      process.exitCode = 1;
    } else {
      console.log('\n✅ 所有断言通过 — v0.4.31 在真实扩展中把两个红灯转成绿灯,storage 已修复。');
    }
  } finally {
    await context.close();
  }
}

run().catch(e => {
  console.error('端到端测试执行异常:', e);
  process.exit(2);
});
