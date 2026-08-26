// 端到端测试:加载真实 dist/ 扩展,模拟用户场景,验证诊断恢复与智能控制
// 这是 evaluator 要求的"在实际运行的扩展中看到问题被解决"
//
// 流程:
// 1. 用 Playwright 启动 Chromium,加载 dist/ 扩展
// 2. 通过 service worker 设置 storage 模拟用户报告的场景:
//    - enabled=true, clockMode=false(间隔模式), nextTriggerAt=0(缺失,红灯根因)
//    - 创建未来的 ac-pwm 闹钟(模拟"活闹钟在")
// 3. 打开 chrome-extension://<id>/popup.html
// 4. 点击 #btnDiagnose 按钮
// 5. 读取 #diagnoseResult 的实际文本输出
// 6. 断言摘要能定位首要问题并给出下一步，同时两个旧红灯都已消除；
//    修复可由后台诊断或 popup 兜底完成
// 7. 完整重启后写入智能模式旧 12/18、目标 plan 缺失与新鲜天气夹具
// 8. 在 loaded Service Worker 中执行生产天气消费链，断言持久化为 21/9
// 9. 重新打开真实 Popup，断言智能控制选中并显示 21/30

const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const manifest = require('../manifest.json');
const zhCN = require('../_locales/zh_CN/messages.json');
const en = require('../_locales/en/messages.json');

const EXT_PATH = path.resolve(__dirname, '..', 'dist');
const PROFILE_ROOT = path.resolve(__dirname, '..', '.test-profile');
fs.mkdirSync(PROFILE_ROOT, { recursive: true });
const PROFILE_DIR = fs.mkdtempSync(path.join(PROFILE_ROOT, 'e2e-runtime-'));
const LAUNCH_ARGS = [
  `--disable-extensions-except=${EXT_PATH}`,
  `--load-extension=${EXT_PATH}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate'
];
const LAUNCH_OPTIONS = [
  { channel: 'msedge', headless: false },
  { channel: 'chrome', headless: false },
  { channel: 'msedge', headless: true },
  { channel: 'chrome', headless: true },
  { headless: false },
  { headless: true }
];

async function launchExtensionContext(preferredOptions = null) {
  let launchError = null;
  const candidates = preferredOptions ? [preferredOptions] : LAUNCH_OPTIONS;
  for (const launchOptions of candidates) {
    try {
      console.log('尝试启动浏览器:', JSON.stringify(launchOptions));
      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...launchOptions,
        args: LAUNCH_ARGS
      });
      console.log('启动成功:', JSON.stringify(launchOptions), '\n');
      return { context, launchOptions };
    } catch (error) {
      console.log('  失败:', error.message.split('\n')[0]);
      launchError = error;
    }
  }

  const error = new Error('所有浏览器启动方式都失败');
  error.cause = launchError;
  throw error;
}

async function waitForExtensionServiceWorker(context, extensionId = '') {
  let serviceWorker = context.serviceWorkers()[0];
  if (serviceWorker) return serviceWorker;

  const workerPromise = context.waitForEvent('serviceworker', { timeout: 10000 })
    .catch(() => null);
  let wakePage = null;
  if (extensionId) {
    wakePage = await context.newPage();
    await wakePage.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: 10000,
      waitUntil: 'load'
    }).catch(() => {});
  }

  serviceWorker = context.serviceWorkers()[0] || await workerPromise;
  if (wakePage) await wakePage.close().catch(() => {});
  if (!serviceWorker) {
    throw new Error('未找到扩展 service worker,扩展可能未加载');
  }
  return serviceWorker;
}

async function readWorkerIdentity(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const source = await fetch(chrome.runtime.getURL('background.js')).then(response => response.text());
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return {
      version: chrome.runtime.getManifest().version,
      backgroundHash: [...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, '0'))
        .join('')
    };
  });
}

async function run() {
  console.log('=== 端到端测试: 真实扩展中验证诊断恢复与智能控制 ===\n');
  console.log('扩展路径:', EXT_PATH, '\n');

  let context;
  let restartedContext;
  const launched = await launchExtensionContext();
  context = launched.context;
  const successfulLaunchOptions = launched.launchOptions;

  try {
    // 等待 service worker 注册(扩展加载完成的信号)
    const serviceWorker = await waitForExtensionServiceWorker(context);

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
    const expectedBackgroundHash = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(EXT_PATH, 'background.js')))
      .digest('hex');
    const initialWorkerIdentity = await readWorkerIdentity(serviceWorker);
    console.log('Worker 身份:', JSON.stringify(initialWorkerIdentity), '\n');

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
      await chrome.storage.local.remove('ac_balance_cache');
      await chrome.storage.sync.remove('ac_schedule_sync');
      // 模拟上一个 Service Worker 保存的最近有效余额。当前 Worker 尚未在
      // 模块内存中读取过余额，popup 首次 full 轮询必须从 session 恢复 Est.
      // 并迁移到 local，才能跨越完整浏览器重启。
      await chrome.storage.session.set({ ac_balance_cache: 156 });
      // 创建未来的 ac-pwm 闹钟(模拟"活闹钟在")
      await chrome.alarms.clear('ac-pwm');
      await chrome.alarms.create('ac-pwm', { when: schedTime });
    }, pwmScheduledTime);

    // 每次测试使用全新 profile，当前 Worker 尚未执行过生产余额读取；因此
    // popup 首次 full 轮询只能从 storage.session 恢复，而非沿用模块内存。
    await new Promise(r => setTimeout(r, 500));

    // 验证场景已设置
    const sceneCheck = await serviceWorker.evaluate(async () => {
      const { ac_schedule } = await chrome.storage.local.get('ac_schedule');
      const { ac_balance_cache: localBalance } = await chrome.storage.local.get('ac_balance_cache');
      const { ac_balance_cache } = await chrome.storage.session.get('ac_balance_cache');
      const alarm = await chrome.alarms.get('ac-pwm');
      return {
        nextTriggerAt: ac_schedule.nextTriggerAt,
        enabled: ac_schedule.enabled,
        clockMode: ac_schedule.clockMode,
        localBalance,
        sessionBalance: ac_balance_cache,
        acPwmScheduledTime: alarm?.scheduledTime || 0
      };
    });
    console.log('场景设置完成:');
    console.log('  storage.nextTriggerAt =', sceneCheck.nextTriggerAt, '(应为 0)');
    console.log('  storage.enabled =', sceneCheck.enabled);
    console.log('  storage.clockMode =', sceneCheck.clockMode, '(false=间隔)');
    console.log('  local.ac_balance_cache =', sceneCheck.localBalance);
    console.log('  session.ac_balance_cache =', sceneCheck.sessionBalance);
    console.log('  ac-pwm.scheduledTime =', new Date(sceneCheck.acPwmScheduledTime).toLocaleTimeString(),
                '(' + sceneCheck.acPwmScheduledTime + ')');
    console.log('');

    // === 打开 popup.html,点击诊断按钮 ===
    console.log('--- 步骤 2: 打开 popup.html,点击诊断按钮 ---\n');
    const popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      const nativeSetInterval = globalThis.setInterval.bind(globalThis);
      globalThis.__AC_E2E_INTERVAL_IDS__ = [];
      globalThis.setInterval = (...args) => {
        const intervalId = nativeSetInterval(...args);
        globalThis.__AC_E2E_INTERVAL_IDS__.push(intervalId);
        return intervalId;
      };
    });
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
    const popupState = await popupPage.evaluate(async () => ({
      hasVersion: !!document.getElementById('versionInfo'),
      versionText: document.getElementById('versionInfo')?.textContent || '',
      hasBtn: !!document.getElementById('btnDiagnose'),
      hasResult: !!document.getElementById('diagnoseResult'),
      balanceEstimateVisible: document.getElementById('balanceEstimate')?.hidden === false,
      balanceEstimateText: document.getElementById('balanceEstimate')?.textContent || '',
      fullSnapshot: await chrome.runtime.sendMessage({ type: 'getSchedule' }),
      localBalance: (await chrome.storage.local.get('ac_balance_cache')).ac_balance_cache
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
    const hasDiagnosticLineIn = (text, marker, key) => [zhCN, en].some(messages => {
      const message = messages[key]?.message;
      return message && text.includes(`${marker} ${message}`);
    });
    const hasDiagnosticLine = (marker, key) => hasDiagnosticLineIn(diagnoseText, marker, key);
    const hasDiagnosticLinePrefix = (text, marker, key) => [zhCN, en].some(messages => {
      const message = messages[key]?.message;
      const prefix = message?.split(/\$\d+/)[0];
      return prefix && text.includes(`${marker} ${prefix}`);
    });
    const hasLocalizedPrefix = (text, key) => [zhCN, en].some(messages => {
      const message = messages[key]?.message;
      const prefix = message?.split(/\$\d+/)[0];
      return prefix && text.includes(prefix);
    });
    assert(hasLocalizedPrefix(diagnoseText, 'diagnoseSummary'),
      '诊断顶部显示 error/warning/repaired 汇总');
    assert(['diagnosePopupDocumentReady', 'diagnosePopupLayoutOK',
      'diagnosePopupControlsSync', 'diagnosePopupKeepaliveOK']
      .every(key => hasDiagnosticLinePrefix(diagnoseText, '✅', key)),
    '真实 Popup 诊断显示文档、布局、控件同步与保活连接现场信息');
    assert(!diagnoseText.includes('[POPUP-CONTROLS-DESYNC]')
        && !diagnoseText.includes('[POPUP-HORIZONTAL-OVERFLOW]')
        && !diagnoseText.includes('[POPUP-KEEPALIVE-DISCONNECTED]'),
      '健康 Popup 不产生控件失步、横向溢出或保活断开警告');
    assert(diagnoseText.includes('[PAGE-HOME-MISSING]'),
      '未打开冷气主页时显示稳定故障码 PAGE-HOME-MISSING');
    assert(hasLocalizedPrefix(diagnoseText, 'diagnoseNextStep'),
      '首要问题后显示唯一下一步建议');
    // 关键断言:两个红灯都消除
    assert(!hasDiagnosticLine('❌', 'diagnoseMissingTrigger'),
      '红灯 #1 已消除:诊断输出不再报告 storage 绝对触发时间缺失');
    assert(!hasDiagnosticLine('❌', 'diagnosePwmSync'),
      '红灯 #2 已消除:诊断输出不再报告 ac-pwm 与 storage 不同步');
    // 修复可能由 ensureDiagnostics 后台先行完成，也可能由 popup 兜底完成；
    // 责任方不影响用户可见契约，关键是两条诊断均转绿且 storage 已真实写回。
    assert(hasDiagnosticLine('✅', 'diagnoseTriggerTime')
        || diagnoseText.includes('[SCHED-TRIGGER-REPAIRED]'),
      'storage 绝对触发时间已恢复，并在本次发生修复时明确标记 repaired');
    assert(hasDiagnosticLine('✅', 'diagnosePwmSync'),
      '绿灯出现:ac-pwm 与 storage 触发时间已同步');
    // storage 实际被写入
    assert(finalStorage.nextTriggerAt === pwmScheduledTime,
      '真实 storage.nextTriggerAt 已修复为 ac-pwm.scheduledTime');
    assert(!Object.hasOwn(finalStorage, 'actualStatus')
        && !Object.hasOwn(finalStorage, 'balanceMinutes')
        && !Object.keys(finalStorage).some(key => key.startsWith('_')),
      '诊断自愈后的 ac_schedule 不包含余额或运行时快照字段');
    assert(sceneCheck.localBalance === undefined
        && sceneCheck.sessionBalance === 156
        && popupState.fullSnapshot?.actualStatus?.balanceMinutes === 156
        && popupState.balanceEstimateVisible
        && popupState.balanceEstimateText.trim().length > 0,
      '冷启动 Worker 从 storage.session 恢复余额，popup 的 Est. 保持显示');
    assert(popupState.localBalance === 156,
      '首次 full 快照把旧 session 余额迁移到 storage.local');
    assert(initialWorkerIdentity.version === manifest.version
        && initialWorkerIdentity.backgroundHash === expectedBackgroundHash,
      '首次启动的 Service Worker 与 dist/background.js 版本及字节哈希一致');
    // BUILD_TIME 显示(证明扩展加载的是新代码)
    assert(versionLine.includes(manifest.version),
      `Popup 版本行显示 v${manifest.version}`);

    // === 主脚本诊断未就绪时，独立兜底仍可输出部分现场 ===
    console.log('\n--- 步骤 2.1: 模拟 Popup 主诊断未就绪 ---\n');
    const fallbackPage = await context.newPage();
    await fallbackPage.addInitScript(() => {
      globalThis.__AC_FALLBACK_COPIED__ = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => { globalThis.__AC_FALLBACK_COPIED__ = text; }
        }
      });
    });
    await fallbackPage.route('**/popup.js*', route => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'throw new Error("synthetic popup bootstrap failure");'
    }));
    await fallbackPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: 10000,
      waitUntil: 'load'
    });
    await new Promise(r => setTimeout(r, 500));
    const fallbackMainReady = await fallbackPage.evaluate(() => (
      globalThis.__AC_POPUP_DIAGNOSTICS_READY__ === true
    ));
    await fallbackPage.click('#btnDiagnose', { timeout: 5000 });
    await fallbackPage.waitForFunction(() => (
      document.getElementById('diagContent')?.textContent.includes('[POPUP-MAIN-FAILED]')
    ), { timeout: 10000 });
    const fallbackState = await fallbackPage.evaluate(() => ({
      text: document.getElementById('diagnoseResult')?.innerText || '',
      copyVisible: document.getElementById('btnCopyDiag')?.hidden === false,
      buttonEnabled: document.getElementById('btnDiagnose')?.disabled === false
    }));
    console.log(fallbackState.text);
    assert(!fallbackMainReady
        && fallbackState.text.includes('[POPUP-MAIN-FAILED]')
        && fallbackState.text.includes('synthetic popup bootstrap failure'),
      'popup.js 未执行时独立兜底捕获并显示 Popup 启动异常');
    assert(hasLocalizedPrefix(fallbackState.text, 'diagnoseFallbackSchedule')
        && hasLocalizedPrefix(fallbackState.text, 'diagnoseFallbackAlarms')
        && hasLocalizedPrefix(fallbackState.text, 'diagnoseFallbackSw'),
      '兜底报告仍包含 schedule、alarms 与 Service Worker 独立现场');
    await fallbackPage.click('#btnCopyDiag', { timeout: 5000 });
    await fallbackPage.waitForFunction(() => (
      globalThis.__AC_FALLBACK_COPIED__?.includes('[POPUP-MAIN-FAILED]')
    ), { timeout: 5000 });
    const fallbackCopied = await fallbackPage.evaluate(() => globalThis.__AC_FALLBACK_COPIED__);
    assert(fallbackState.copyVisible
        && fallbackState.buttonEnabled
        && fallbackCopied.startsWith('```')
        && fallbackCopied.includes('[POPUP-RUNTIME-ERROR]'),
      '兜底诊断完成后恢复按钮并可一键复制完整 Markdown 报告');
    await fallbackPage.close();

    // === 真实旧接收端吞包：listener 仍注册且返回 true，但永不 sendResponse ===
    // 这确定性复现浏览器重启后旧 listener 冒充异步响应、诊断永久等待的现场。
    // 先停掉 popup 的常规 1 秒轮询，确保旧 listener 安装后的第一次恢复动作
    // 就是用户点击诊断，而不是测试预先调用 getSchedule/getPageTimer 把现场治好。
    console.log('\n--- 步骤 2.5: 模拟旧 AC 标签 listener 吞消息 ---\n');
    const popupPollingState = await popupPage.evaluate(() => {
      const intervalIds = Array.isArray(globalThis.__AC_E2E_INTERVAL_IDS__)
        ? globalThis.__AC_E2E_INTERVAL_IDS__
        : [];
      intervalIds.forEach(intervalId => clearInterval(intervalId));
      return { stoppedIntervalCount: intervalIds.length };
    });
    const mockHomeHtml = `<!doctype html>
      <html><head><meta charset="utf-8"><title>AC mock</title></head>
      <body>
        <section id="balance-card">
          <h2>Air Conditioning Balance</h2>
          <small>Charge Mode</small>
          <span class="ant-progress-text" title="156 min">156 min</span>
        </section>
        <div class="status-row">
          <small>Air Conditioning Status</small>
          <button class="ant-switch" role="switch" aria-checked="true">ON</button>
        </div>
        <div class="timer-row">
          <small>Power-off after</small>
          <div class="ant-picker"><input readonly value="" title=""></div>
        </div>
        <script>globalThis.__acMockLoadToken = Math.random().toString(36).slice(2);</script>
      </body></html>`;
    await context.route('https://w5.ab.ust.hk/njggt/app/home', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: mockHomeHtml
    }));
    const acPage = await context.newPage();
    await acPage.goto('https://w5.ab.ust.hk/njggt/app/home', {
      timeout: 10000,
      waitUntil: 'load'
    });
    const acLoadTokenBefore = await acPage.evaluate(() => globalThis.__acMockLoadToken);

    const initialContentDeadline = Date.now() + 8000;
    let initialContentStatus = null;
    while (Date.now() < initialContentDeadline) {
      initialContentStatus = await serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
        const tab = tabs.find(candidate => !candidate.discarded);
        if (!tab?.id) return null;
        try {
          return await chrome.tabs.sendMessage(tab.id, { action: 'status' });
        } catch (_) {
          return null;
        }
      });
      if (initialContentStatus?.balanceMinutes === 156) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    await acPage.evaluate(() => {
      const switchElement = document.querySelector('button.ant-switch[role="switch"]');
      switchElement.setAttribute('aria-checked', 'false');
      switchElement.textContent = 'OFF';
      globalThis.__acMockSwitchClickCount = 0;
      switchElement.addEventListener('click', () => {
        globalThis.__acMockSwitchClickCount += 1;
        if (globalThis.__acMockSwitchClickCount > 1) return;
        setTimeout(() => {
          const notice = document.createElement('div');
          notice.className = 'ant-message-notice-content';
          const success = document.createElement('div');
          success.className = 'ant-message-custom-content ant-message-success';
          success.textContent = 'Execution succeeded';
          notice.appendChild(success);
          document.body.appendChild(notice);
          setTimeout(() => notice.remove(), 250);
        }, 20);
        // 模拟真实页：服务端成功 toast 先到，React 的 aria-checked 稍后才收敛。
        setTimeout(() => {
          switchElement.setAttribute('aria-checked', 'true');
          switchElement.textContent = 'ON';
        }, 450);
      });
    });
    const executionSuccessStartedAt = Date.now();
    const executionSuccessToggle = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
      const tab = tabs.find(candidate => !candidate.discarded);
      if (!tab?.id) return { success: false, error: 'mock home tab missing' };
      return chrome.tabs.sendMessage(tab.id, { action: 'on' });
    });
    const executionSuccessElapsedMs = Date.now() - executionSuccessStartedAt;
    const executionSuccessSwitchClicks = await acPage.evaluate(
      () => globalThis.__acMockSwitchClickCount
    );

    const staleReceiverInstall = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
      const tab = tabs.find(candidate => !candidate.discarded);
      if (!tab?.id) return { installed: false, error: 'mock home tab missing' };
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const listener = self.__AC_CONTENT_MESSAGE_LISTENER__;
          const hadListener = typeof listener === 'function';
          if (hadListener) chrome.runtime.onMessage.removeListener(listener);
          self.__AC_E2E_STALE_MESSAGE_COUNT__ = 0;
          const staleListener = (message, sender, sendResponse) => {
            self.__AC_E2E_STALE_MESSAGE_COUNT__ += 1;
            if (message?.action === 'ping') {
              sendResponse({ success: true });
              return false;
            }
            return true;
          };
          chrome.runtime.onMessage.addListener(staleListener);
          self.__AC_CONTENT_MESSAGE_LISTENER__ = staleListener;
          self.__AC_E2E_STALE_LISTENER__ = staleListener;
          self.__AC_CONTENT_LOADED__ = true;
          return {
            loadedSentinel: self.__AC_CONTENT_LOADED__ === true,
            hadListener,
            staleListenerInstalled: self.__AC_CONTENT_MESSAGE_LISTENER__ === staleListener,
            staleMessageCount: self.__AC_E2E_STALE_MESSAGE_COUNT__
          };
        }
      });
      return { installed: true, tabId: tab.id, ...execution?.result };
    });
    console.log('  popup 轮询已停止:', JSON.stringify(popupPollingState));
    console.log('  旧 listener 安装结果:', JSON.stringify(staleReceiverInstall));

    const recoveryStartedAt = Date.now();
    await popupPage.click('#btnDiagnose', { timeout: 5000 });
    const recoveryDiagDeadline = Date.now() + 20000;
    let recoveryDiagnoseText = '';
    while (Date.now() < recoveryDiagDeadline) {
      recoveryDiagnoseText = await popupPage.$eval('#diagnoseResult', el => el.innerText).catch(() => '');
      if (recoveryDiagnoseText.length > 100 && !recoveryDiagnoseText.includes('诊断中')) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const recoveryDiagnosticState = await popupPage.evaluate(() => ({
      buttonDisabled: document.getElementById('btnDiagnose')?.disabled === true,
      text: document.getElementById('diagnoseResult')?.innerText || ''
    }));
    const recoveryElapsedMs = Date.now() - recoveryStartedAt;
    const recoveredReceiverState = await popupPage.evaluate(async () => ({
      fullSnapshot: await chrome.runtime.sendMessage({ type: 'getSchedule' }),
      pageTimer: await chrome.runtime.sendMessage({ type: 'getPageTimer' }),
      localBalance: (await chrome.storage.local.get('ac_balance_cache')).ac_balance_cache
    }));
    const directProbeAfterRecovery = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
      const tab = tabs.find(candidate => !candidate.discarded);
      if (!tab?.id) return { ok: false, error: 'mock home tab missing' };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            staleMessageCount: self.__AC_E2E_STALE_MESSAGE_COUNT__ || 0,
            listenerReplaced: self.__AC_CONTENT_MESSAGE_LISTENER__ !== self.__AC_E2E_STALE_LISTENER__
          })
        });
        return {
          ok: true,
          status: await chrome.tabs.sendMessage(tab.id, { action: 'status' }),
          ...execution?.result
        };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    });
    const acLoadTokenAfter = await acPage.evaluate(() => globalThis.__acMockLoadToken);
    console.log('  恢复后 full/pageTimer:', JSON.stringify(recoveredReceiverState));
    console.log('  恢复后直接探测:', JSON.stringify(directProbeAfterRecovery));
    console.log('  首次诊断恢复耗时:', recoveryElapsedMs, 'ms');

    assert(initialContentStatus?.balanceMinutes === 156,
      '真实精确 home 初始 content script 可读取 Charge Mode 余额');
    assert(executionSuccessToggle?.success === true
        && executionSuccessToggle.executionSucceeded === true
        && executionSuccessToggle.clicks === 1
        && executionSuccessSwitchClicks === 1
        && executionSuccessElapsedMs < 3000,
      '真实主世界先见短暂 Execution succeeded、再等迟到 ON；仅点击一次且不盲等 10 秒');
    assert(staleReceiverInstall.loadedSentinel === true
        && staleReceiverInstall.hadListener === true
        && staleReceiverInstall.staleListenerInstalled === true
        && staleReceiverInstall.staleMessageCount === 0,
      '模拟保留旧 content global，并登记只对 ping 响应、对业务读取吞包的旧 listener');
    assert(directProbeAfterRecovery.staleMessageCount >= 2
        && directProbeAfterRecovery.listenerReplaced === true,
      '首次点击诊断先通过旧 ping、再撞上业务吞包，并在原页替换为新接收端');
    assert(recoveredReceiverState.fullSnapshot?.actualStatus?.balanceMinutes === 156
        && recoveredReceiverState.fullSnapshot?.actualStatus?.isOn === true
        && recoveredReceiverState.localBalance === 156,
      'full snapshot 在原页重注入接收端并恢复余额/状态');
    assert(recoveredReceiverState.pageTimer?.found === true
        && recoveredReceiverState.pageTimer?.value === null,
      'page timer 诊断复用同一后台恢复入口并读取空定时器状态');
    assert(recoveryDiagnoseText.includes('[SAFETY-TIMER-MISSING]'),
      'AC 已开启但页面定时器为空时定位为 SAFETY-TIMER-MISSING 安全故障');
    assert(directProbeAfterRecovery.ok === true
        && directProbeAfterRecovery.status?.balanceMinutes === 156,
      '恢复后真实 content script 接收端持续响应');
    assert(acPage.url() === 'https://w5.ab.ust.hk/njggt/app/home'
        && acLoadTokenAfter === acLoadTokenBefore,
      '接收端恢复不刷新、不导航用户 AC 页面');
    assert(hasDiagnosticLine('✅', 'diagnoseContentOK')
        || [zhCN, en].some(messages => recoveryDiagnoseText.includes(`✅ ${messages.diagnoseContentOK?.message}`)),
      '恢复后的 popup 诊断将 content script 标记为正常');
    assert(!recoveryDiagnoseText.includes('[PAGE-HOME-MISSING]'),
      '精确 home 已恢复后不再保留 PAGE-HOME-MISSING 当前问题');
    assert(recoveryDiagnosticState.buttonDisabled === false
        && recoveryDiagnosticState.text.length > 100
        && ![zhCN, en].some(messages => recoveryDiagnosticState.text.includes(messages.diagnoseInProgress?.message || ''))
        && recoveryElapsedMs < 20000,
      '旧 listener 吞包恢复后诊断在 20 秒内完成并重新启用按钮');

    await acPage.close();

    // === 完整关闭并重启浏览器：storage.session 会清空，local 必须承担常驻边界 ===
    console.log('\n--- 步骤 3: 完整关闭并重启同一浏览器 profile ---\n');
    await popupPage.close();
    await context.close();
    context = null;

    const restarted = await launchExtensionContext(successfulLaunchOptions);
    restartedContext = restarted.context;
    const restartedWorker = await waitForExtensionServiceWorker(restartedContext, extensionId);
    const restartedWorkerIdentity = await readWorkerIdentity(restartedWorker);
    const restartedColdStorage = await restartedWorker.evaluate(async () => {
      const local = await chrome.storage.local.get('ac_balance_cache');
      const session = await chrome.storage.session.get('ac_balance_cache');
      return {
        localBalance: local.ac_balance_cache,
        sessionBalance: session.ac_balance_cache
      };
    });
    const restartedPopup = await restartedContext.newPage();
    await restartedPopup.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: 10000,
      waitUntil: 'load'
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const restartedState = await restartedPopup.evaluate(async () => {
      const local = await chrome.storage.local.get(['ac_schedule', 'ac_balance_cache']);
      const session = await chrome.storage.session.get('ac_balance_cache');
      return {
        localBalance: local.ac_balance_cache,
        sessionBalance: session.ac_balance_cache,
        fullSnapshot: await chrome.runtime.sendMessage({ type: 'getSchedule' }),
        balanceEstimateVisible: document.getElementById('balanceEstimate')?.hidden === false,
        balanceEstimateText: document.getElementById('balanceEstimate')?.textContent || ''
      };
    });
    console.log('  重启后状态:', JSON.stringify(restartedState));
    console.log('  重启后、popup 启动前缓存:', JSON.stringify(restartedColdStorage));
    console.log('  重启后 Worker 身份:', JSON.stringify(restartedWorkerIdentity));

    await restartedPopup.click('#btnDiagnose', { timeout: 5000 });
    const restartedDiagDeadline = Date.now() + 20000;
    let restartedDiagnosticState = { buttonDisabled: true, text: '' };
    while (Date.now() < restartedDiagDeadline) {
      restartedDiagnosticState = await restartedPopup.evaluate(() => ({
        buttonDisabled: document.getElementById('btnDiagnose')?.disabled === true,
        text: document.getElementById('diagnoseResult')?.innerText || ''
      }));
      if (!restartedDiagnosticState.buttonDisabled && restartedDiagnosticState.text.length > 100) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    console.log('  重启后诊断状态:', JSON.stringify(restartedDiagnosticState));

    assert(restartedColdStorage.sessionBalance === undefined,
      '完整浏览器重启会清空 storage.session（测试确实跨越了目标生命周期边界）');
    assert(restartedColdStorage.localBalance === 156 && restartedState.localBalance === 156,
      '完整浏览器重启后 storage.local 仍保留最近有效余额');
    assert(restartedState.sessionBalance === 156,
      '重启后首次 full 快照从 storage.local 回填 storage.session 热缓存');
    assert(restartedWorkerIdentity.version === manifest.version
        && restartedWorkerIdentity.backgroundHash === expectedBackgroundHash,
      '重启后的 Service Worker 与 dist/background.js 版本及字节哈希一致');
    assert(restartedState.fullSnapshot?.actualStatus?.balanceMinutes === 156
        && restartedState.balanceEstimateVisible
        && restartedState.balanceEstimateText.trim().length > 0,
      '完整浏览器重启且尚无新页面读数时，popup 的 Est. 仍常驻显示');
    assert(restartedDiagnosticState.buttonDisabled === false
        && restartedDiagnosticState.text.length > 100
        && ![zhCN, en].some(messages => restartedDiagnosticState.text.includes(messages.diagnoseInProgress?.message || '')),
      '完整浏览器重启后诊断在 20 秒内完成，不再永久停在“诊断中”');
    assert(hasDiagnosticLinePrefix(restartedDiagnosticState.text, '✅', 'diagnoseTriMatch')
        && !hasDiagnosticLinePrefix(restartedDiagnosticState.text, '❌', 'diagnoseTriMismatch'),
      '浏览器重建 alarm 引入毫秒小数时，三方时钟仍按 1500ms 容差显示绿灯');

    // === 智能控制：真实 Worker 消费本地天气，真实 Popup 展示同一 21/30 ===
    console.log('\n--- 步骤 4: 验证真实扩展智能控制 21/30 ---\n');
    const smartBoundary = new Date();
    smartBoundary.setMinutes(smartBoundary.getMinutes() < 30 ? 0 : 30, 0, 0);
    const smartBoundaryAt = smartBoundary.getTime();
    const smartWeather = {
      fetchedAt: smartBoundaryAt - 10 * 60 * 1000,
      temperature: 32.3,
      dewPoint: 10,
      windSpeedMs: 0,
      rainMm: 0,
      relativeHumidity: 45
    };
    const smartWorkerState = await restartedWorker.evaluate(async ({ boundaryAt, weather }) => {
      const stored = (await chrome.storage.local.get('ac_schedule')).ac_schedule || {};
      const smartSchedule = {
        ...stored,
        enabled: true,
        mode: 'pwm',
        clockMode: false,
        onMinutes: 12,
        offMinutes: 18,
        pwmState: 'off',
        smartOnBoundaryAt: boundaryAt,
        activeHours: { enabled: false, start: '08:00', end: '23:00' },
        smartMode: { enabled: true, sensitivity: 10 }
      };
      await chrome.storage.local.set({
        ac_schedule: smartSchedule,
        ac_smart_weather: weather
      });
      await chrome.storage.local.remove('ac_smart_weather_plan');

      const productionFunctionsAvailable = typeof loadScheduleFromStorage === 'function'
        && typeof applyPreparedSmartModeDurations === 'function'
        && typeof persistSchedule === 'function';
      const planMissing = (await chrome.storage.local.get('ac_smart_weather_plan'))
        .ac_smart_weather_plan === undefined;
      if (!productionFunctionsAvailable) {
        return {
          productionFunctionsAvailable,
          planMissing,
          before: smartSchedule,
          applied: false,
          persisted: (await chrome.storage.local.get('ac_schedule')).ac_schedule
        };
      }

      await loadScheduleFromStorage();
      const before = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
      const applied = await applyPreparedSmartModeDurations({
        allowActiveOnPhase: true,
        boundaryAt
      });
      await persistSchedule('e2e-smart-duration', { syncFromLiveAlarm: false });
      const persisted = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
      return {
        productionFunctionsAvailable,
        planMissing,
        before,
        applied,
        persisted
      };
    }, { boundaryAt: smartBoundaryAt, weather: smartWeather });
    console.log('  智能 Worker 状态:', JSON.stringify(smartWorkerState));

    await restartedPopup.reload({ timeout: 10000, waitUntil: 'load' });
    const smartPopupReady = await restartedPopup.waitForFunction(() => (
      document.getElementById('smartModeToggle')?.getAttribute('aria-pressed') === 'true'
      && document.getElementById('smartBody')?.hidden === false
      && document.getElementById('smartSuggested')?.textContent?.trim() === '21/30'
    ), null, { timeout: 10000 }).then(() => true).catch(() => false);
    const smartPopupState = await restartedPopup.evaluate(async () => ({
      smartPressed: document.getElementById('smartModeToggle')?.getAttribute('aria-pressed') === 'true',
      smartBodyVisible: document.getElementById('smartBody')?.hidden === false,
      sensitivity: document.getElementById('smartSensitivity')?.value || '',
      suggested: document.getElementById('smartSuggested')?.textContent?.trim() || '',
      updated: document.getElementById('smartUpdated')?.textContent?.trim() || '',
      snapshot: await chrome.runtime.sendMessage({ type: 'getScheduleLite' })
    }));
    console.log('  智能 Popup 状态:', JSON.stringify(smartPopupState));

    assert(smartWorkerState.productionFunctionsAvailable
        && smartWorkerState.planMissing
        && smartWorkerState.before?.onMinutes === 12
        && smartWorkerState.before?.offMinutes === 18,
      '真实 Worker 以智能模式旧 12/18、目标 plan 缺失作为恢复夹具');
    assert(smartWorkerState.applied === true
        && smartWorkerState.persisted?.smartMode?.enabled === true
        && smartWorkerState.persisted?.onMinutes === 21
        && smartWorkerState.persisted?.offMinutes === 9,
      '真实 Worker 只读新鲜本地天气，把旧 12/18 刷新并持久化为 21/9');
    assert(smartPopupReady
        && smartPopupState.smartPressed
        && smartPopupState.smartBodyVisible
        && smartPopupState.sensitivity === '10'
        && smartPopupState.suggested === '21/30'
        && smartPopupState.updated !== '--',
      '真实 Popup 选中智能控制并显示 sensitivity=10 的建议 21/30');
    assert(smartPopupState.snapshot?.smartMode?.enabled === true
        && smartPopupState.snapshot?.onMinutes === 21
        && smartPopupState.snapshot?.offMinutes === 9,
      '真实 Popup 与 Service Worker 对智能模式及 21/9 派生时长一致');

    // 汇总
    const passCount = results.filter(r => r.pass).length;
    console.log(`\n=== 测试汇总: ${passCount}/${results.length} 通过 ===`);
    if (passCount !== results.length) {
      console.log('\n失败项:');
      results.filter(r => !r.pass).forEach(r => console.log('  - ' + r.name));
      process.exitCode = 1;
    } else {
      console.log(`\n✅ 所有断言通过 — v${manifest.version} 在真实扩展中完成诊断恢复，并验证智能控制 21/30。`);
    }
  } finally {
    if (context) await context.close();
    if (restartedContext) await restartedContext.close();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
}

run().catch(e => {
  console.error('端到端测试执行异常:', e);
  process.exit(2);
});
