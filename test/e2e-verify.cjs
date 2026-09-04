// 端到端测试:加载真实 dist/ 扩展,覆盖用户旅程、页面控制、诊断恢复与天气数据链
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
// 7. 真实写入页面关机定时器，并由独立新鲜页确认持久化；验证失败关闭与 OFF 零点击
// 8. 完整重启后验证智能缓存消费，再以三个生产 URL 获取确定性 HKO 响应
// 9. 验证 fetch→解析→缓存→边界计划→Popup，以及失败时保留上次成功数据
// 10. 从真实 Popup 操作总开关、运行时段、两种模式、分钟数与灵敏度；
//     false→true 还要经过一次 ON 成功确认与至少五分钟页面关机保险
// 11. 以确定性中／英文 locale 验证布局、24h 字段、键盘顺序、帮助及完整诊断复制

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
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
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
const E2E_SYNC_AUTHORITY_LOCAL_KEYS = [
  'ac_schedule_sync_publish_pending',
  'ac_schedule_sync_watermark',
  'ac_schedule_sync_payload_receipt',
  'ac_deferred_sync_disable',
  'ac_manual_off_admission',
  'ac_local_schedule_mutation_cutoff',
  'ac_local_terminal_authority'
];
const E2E_SYNC_AUTHORITY_ALARM_PREFIXES = [
  'ac-sync-publish-retry',
  'ac-sync-adopt-retry',
  'ac-deferred-sync-disable-retry',
  'ac-deferred-sync-successor-retry',
  'ac-schedule-read-retry',
  'ac-manual-off-admission-retry'
];

async function launchExtensionContext(preferredOptions = null) {
  let launchError = null;
  const candidates = preferredOptions ? [preferredOptions] : LAUNCH_OPTIONS;
  for (const launchOptions of candidates) {
    let candidateContext = null;
    try {
      console.log('尝试启动浏览器:', JSON.stringify(launchOptions));
      candidateContext = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...launchOptions,
        args: LAUNCH_ARGS
      });
      const serviceWorker = await waitForExtensionServiceWorker(candidateContext);
      console.log('启动成功且扩展已加载:', JSON.stringify(launchOptions), '\n');
      return { context: candidateContext, launchOptions, serviceWorker };
    } catch (error) {
      console.log('  失败:', error.message.split('\n')[0]);
      launchError = error;
      if (candidateContext) {
        await candidateContext.close().catch(() => {});
      }
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
    const serviceWorker = launched.serviceWorker
      || await waitForExtensionServiceWorker(context);

    // ac_schedule 首次出现只是 onInstalled 写默认值的中间点；必须继续等
    // init 与 sync seed 收口。若本机 false seed 被误判为 remote F，这里明确
    // 失败，不能先改夹具把生产回归藏掉。
    const initDeadline = Date.now() + 15000;
    const bootstrapIsQuiescent = state => (
      state?.initCompleted === true
      && state.scheduleReady === true
      && state.syncSeeded === true
      && state.publishPending === false
      && state.deferredRecordPresent === false
      && state.authorityAlarmNames?.length === 0
    );
    let bootstrapState = null;
    let stableBootstrapObservations = 0;
    while (Date.now() < initDeadline) {
      bootstrapState = await serviceWorker.evaluate(async ({
        authorityAlarmPrefixes
      }) => {
        try {
          const initCompleted = typeof initCompletedAt === 'number'
            && initCompletedAt > 0;
          const [local, sync, alarms] = await Promise.all([
            chrome.storage.local.get([
              'ac_schedule',
              'ac_schedule_sync_publish_pending',
              'ac_deferred_sync_disable'
            ]),
            chrome.storage.sync.get('ac_schedule_sync'),
            chrome.alarms.getAll()
          ]);
          const authorityAlarmNames = alarms
            .map(alarm => alarm.name)
            .filter(name => authorityAlarmPrefixes.some(prefix => (
              name === prefix || name.startsWith(`${prefix}:`)
            )));
          return {
            initCompleted,
            scheduleReady: !!local.ac_schedule,
            syncSeeded: sync.ac_schedule_sync?.enabled === false,
            publishPending:
              local.ac_schedule_sync_publish_pending === true,
            deferredRecordPresent: Object.prototype.hasOwnProperty.call(
              local,
              'ac_deferred_sync_disable'
            ),
            authorityAlarmNames
          };
        } catch (error) {
          return { error: error?.message || String(error) };
        }
      }, {
        authorityAlarmPrefixes: E2E_SYNC_AUTHORITY_ALARM_PREFIXES
      }).catch(error => ({ error: error.message }));
      stableBootstrapObservations = bootstrapIsQuiescent(bootstrapState)
        ? stableBootstrapObservations + 1
        : 0;
      if (stableBootstrapObservations >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const bootstrapReady = bootstrapIsQuiescent(bootstrapState)
      && stableBootstrapObservations >= 2;
    if (!bootstrapReady) {
      throw new Error(
        `fresh 初始化未稳定收口或产生了 deferred authority: ${JSON.stringify(bootstrapState)}`
      );
    }
    console.log('Fresh 初始化已稳定收口:', JSON.stringify(bootstrapState), '\n');

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
    const fixtureSetup = await serviceWorker.evaluate(async ({
      schedTime,
      authorityLocalKeys,
      authorityAlarmPrefixes
    }) => {
      const authorityAlarmNames = (await chrome.alarms.getAll())
        .map(alarm => alarm.name)
        .filter(name => authorityAlarmPrefixes.some(prefix => (
          name === prefix || name.startsWith(`${prefix}:`)
        )));
      await Promise.all([
        chrome.storage.sync.remove('ac_schedule_sync'),
        chrome.storage.local.remove(authorityLocalKeys),
        ...authorityAlarmNames.map(name => chrome.alarms.clear(name))
      ]);
      // durable watermark 已清理后同步重置本 Worker 的缓存；否则后续夹具
      // 仍会继承 install seed 的 Lamport 水位，不再是独立测试场景。
      lastSyncedAt = 0;
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
          pageTimerRetryAt: 0,
          comfortStartUntil: 0,
          comfortStartOnConfirmedAt: 0
        }
      });
      const loadedFixture = await loadScheduleFromStorage();
      if (loadedFixture?.enabled !== true
          || Number(loadedFixture.nextTriggerAt) !== 0) {
        throw new Error('raw local fixture 未进入 Service Worker 内存');
      }
      await chrome.storage.local.remove('ac_balance_cache');
      // 模拟上一个 Service Worker 保存的最近有效余额。当前 Worker 尚未在
      // 模块内存中读取过余额，popup 首次 full 轮询必须从 session 恢复 Est.
      // 并迁移到 local，才能跨越完整浏览器重启。
      await chrome.storage.session.set({ ac_balance_cache: 156 });
      // 创建未来的 ac-pwm 闹钟(模拟"活闹钟在")
      await chrome.alarms.clear('ac-pwm');
      await chrome.alarms.create('ac-pwm', { when: schedTime });
      return {
        enabled: loadedFixture.enabled,
        nextTriggerAt: loadedFixture.nextTriggerAt,
        clearedAuthorityAlarmNames: authorityAlarmNames
      };
    }, {
      schedTime: pwmScheduledTime,
      authorityLocalKeys: E2E_SYNC_AUTHORITY_LOCAL_KEYS,
      authorityAlarmPrefixes: E2E_SYNC_AUTHORITY_ALARM_PREFIXES
    });
    console.log('  测试夹具已载入 Worker:', JSON.stringify(fixtureSetup));

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
      try {
        Object.defineProperty(chrome.i18n, 'getUILanguage', {
          configurable: true,
          value: () => 'zh-CN'
        });
      } catch (_) {
        try { chrome.i18n.getUILanguage = () => 'zh-CN'; } catch (_) { /* ignored */ }
      }
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
      lang: document.documentElement.lang,
      shellWidth: document.getElementById('appShell')?.getBoundingClientRect().width || 0,
      shellClientWidth: document.getElementById('appShell')?.clientWidth || 0,
      shellScrollWidth: document.getElementById('appShell')?.scrollWidth || 0,
      timerLabel: document.getElementById('pwmSettingsTitle')?.textContent?.trim() || '',
      smartLabel: document.getElementById('smartModeTitle')?.textContent?.trim() || '',
      activeHoursStartType: document.getElementById('activeHoursStart')?.type || '',
      activeHoursStartValue: document.getElementById('activeHoursStart')?.value || '',
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
    assert(hasLocalizedPrefix(diagnoseText, 'diagnoseStorageRW'),
      '诊断顶部显示 storage 可读写现场信息');
    assert(popupState.lang === 'zh-CN'
        && popupState.shellWidth === 280
        && popupState.shellScrollWidth <= popupState.shellClientWidth + 1
        && popupState.timerLabel === zhCN.pwmSettings.message
        && popupState.smartLabel === zhCN.smartModeLabel.message
        && popupState.activeHoursStartType === 'text'
        && /^\d{2}:\d{2}$/.test(popupState.activeHoursStartValue),
      '中文 Popup 使用 280px 无横向溢出，并保持单焦点 24h HH:mm 字段');
    assert(!diagnoseText.includes('[POPUP-CONTROLS-DESYNC]')
        && !diagnoseText.includes('[POPUP-HORIZONTAL-OVERFLOW]')
        && !diagnoseText.includes('[POPUP-KEEPALIVE-DISCONNECTED]'),
      '健康 Popup 不产生控件失步、横向溢出或保活断开警告');
    assert(hasDiagnosticLinePrefix(diagnoseText, '❌', 'diagnoseTabOpen'),
      '未打开冷气主页时显示冷气页面未打开的故障现场');
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
    assert(hasDiagnosticLinePrefix(diagnoseText, '✅', 'diagnoseTriMatch'),
      '绿灯出现:live ac-pwm 与内存、storage 三方一致');
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
    assert(fallbackState.text.includes('Safe schedule snapshot')
        && fallbackState.text.includes('ac-* alarms')
        && fallbackState.text.includes('Service Worker snapshot'),
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
          <button class="ant-switch" role="switch" aria-checked="false">OFF</button>
        </div>
        <div class="timer-row">
          <small>Power-off after</small>
          <div class="ant-picker"><input readonly value="" title=""></div>
        </div>
        <script>
          globalThis.__acMockLoadToken = Math.random().toString(36).slice(2);
          const persistedTimer = localStorage.getItem('ac-e2e-page-timer') || '';
          globalThis.__acControlledTimerCommits = 0;
          globalThis.__acControlledTimerReplacements = 0;
          globalThis.__acControlledTimerLastDelayMs = 0;
          const installControlledTimerInput = (input, committedValue) => {
            input.value = committedValue;
            input.setAttribute('title', committedValue);
            input.setAttribute('readonly', '');
            input.addEventListener('change', () => {
              const submittedValue = String(input.value || '').trim();
              const submittedAt = Date.now();
              const previousValue = localStorage.getItem('ac-e2e-page-timer') || '';
              // 模拟真实 React 受控 picker：先回退未提交值，稍后才用新节点提交。
              input.value = previousValue;
              input.setAttribute('title', previousValue);
              setTimeout(() => {
                const liveInput = document.querySelector('.timer-row .ant-picker input');
                if (!liveInput) return;
                const replacement = liveInput.cloneNode(true);
                localStorage.setItem('ac-e2e-page-timer', submittedValue);
                installControlledTimerInput(replacement, submittedValue);
                liveInput.replaceWith(replacement);
                globalThis.__acControlledTimerCommits += 1;
                globalThis.__acControlledTimerReplacements += 1;
                globalThis.__acControlledTimerLastDelayMs = Date.now() - submittedAt;
              }, 550);
            });
          };
          installControlledTimerInput(
            document.querySelector('.timer-row .ant-picker input'),
            persistedTimer
          );
        </script>
      </body></html>`;
    let mockHomeRequestCount = 0;
    await context.route('https://w5.ab.ust.hk/njggt/app/home', (route) => {
      mockHomeRequestCount += 1;
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: mockHomeHtml
      });
    });
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
    const alreadyOnToggle = await serviceWorker.evaluate(async () => {
      if (typeof toggleAC !== 'function') {
        return { success: false, productionFunctionMissing: true };
      }
      return toggleAC('on');
    });
    const alreadyOnSwitchClicks = await acPage.evaluate(
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
        && executionSuccessToggle.clicks === 1
        && executionSuccessSwitchClicks === 1
        && executionSuccessElapsedMs < 20000,
      '真实主世界点击一次并等待迟到 ON 收敛，不盲等 10 秒');
    assert(alreadyOnToggle?.success === true
        && alreadyOnToggle.alreadyDone === true
        && alreadyOnSwitchClicks === executionSuccessSwitchClicks,
      '真实后台发现 AC 已 ON 时零额外点击，显式返回 alreadyDone 供 PWM 直接设置 Power-off after');
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
    assert(hasDiagnosticLine('✅', 'diagnosePageTimerPending')
        || hasDiagnosticLine('✅', 'diagnosePageTimerEmpty'),
      'AC 已开启但页面定时器为空时显示 page timer 空/未设或待 AC 页面校验');
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

    // === 页面控制失败关闭：缺成功提示不得推进，OFF 永远零点击 ===
    console.log('\n--- 步骤 2.6: 验证开机失败关闭与 OFF 零点击 ---\n');
    const negativeOnFixture = await acPage.evaluate(() => {
      const switchElement = document.querySelector('button.ant-switch[role="switch"]');
      switchElement.setAttribute('aria-checked', 'false');
      switchElement.textContent = 'OFF';
      return { clicksBefore: globalThis.__acMockSwitchClickCount };
    });
    const missingToastStartedAt = Date.now();
    const missingToastResult = await serviceWorker.evaluate(async (notAfterAt) => {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
      const tab = tabs.find(candidate => !candidate.discarded);
      if (!tab?.id) return { success: false, error: 'mock home tab missing' };
      return chrome.tabs.sendMessage(tab.id, { action: 'on', notAfterAt });
    }, Date.now() + 1200);
    const missingToastElapsedMs = Date.now() - missingToastStartedAt;
    const afterMissingToastClicks = await acPage.evaluate(
      () => globalThis.__acMockSwitchClickCount
    );
    const offRejectedResult = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
      const tab = tabs.find(candidate => !candidate.discarded);
      if (!tab?.id) return { success: false, error: 'mock home tab missing' };
      return chrome.tabs.sendMessage(tab.id, { action: 'off' });
    });
    const afterOffRequestClicks = await acPage.evaluate(
      () => globalThis.__acMockSwitchClickCount
    );

    assert(negativeOnFixture.clicksBefore === 1
        && missingToastResult?.success === false
        && missingToastResult?.mainWorldResult?.success === false
        && missingToastResult?.mainWorldResult?.clicks === 1
        && afterMissingToastClicks === 2
        && missingToastElapsedMs < 20000,
      '本次 ON 没有新 Execution succeeded 时只点击一次并在截止前失败关闭');
    assert(offRejectedResult?.success === false
        && /OFF/.test(offRejectedResult?.error || '')
        && afterOffRequestClicks === afterMissingToastClicks,
      '真实 content OFF 请求被拒绝且页面开关保持零额外点击');

    // === 页面关机保险：真实输入，并由独立新鲜页读回同一 HH:MM ===
    console.log('\n--- 步骤 2.7: 验证页面关机定时器新鲜页证明 ---\n');
    const pageTimerTargetAt = Math.ceil((Date.now() + 2 * 60 * 1000) / 60000) * 60000;
    const homeRequestsBeforeTimerProof = mockHomeRequestCount;
    const pageTimerHarness = await serviceWorker.evaluate(async (targetAt) => {
      const freshTabs = [];
      const redirectTasks = [];
      const homeUrl = 'https://w5.ab.ust.hk/njggt/app/home';
      const seedUrl = chrome.runtime.getURL('manifest.json');
      const activateFreshTab = (tab) => {
        const targetUrl = tab?.pendingUrl || tab?.url || '';
        if (targetUrl !== homeUrl) return;
        const entry = { id: tab.id, wasActive: tab.active, targetUrl };
        freshTabs.push(entry);
        // Playwright 不拦截 chrome.tabs.create 新 target 的首次导航。先让 target
        // 附着到本地扩展页，再导航到 home fixture；生产代码仍请求 active:false。
        redirectTasks.push((async () => {
          try {
            await chrome.tabs.update(tab.id, { url: seedUrl, active: true });
            for (let index = 0; index < 40; index += 1) {
              const current = await chrome.tabs.get(tab.id);
              if (current.status === 'complete' && current.url === seedUrl) {
                entry.seedReady = true;
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            await chrome.tabs.update(tab.id, { url: homeUrl, active: true });
            entry.rerouted = true;
          } catch (error) {
            entry.error = error?.message || String(error);
          }
        })());
      };
      chrome.tabs.onCreated.addListener(activateFreshTab);
      try {
        if (typeof setPageTimer !== 'function') {
          return {
            result: { success: false, productionFunctionMissing: true },
            freshTabs
          };
        }
        const result = await setPageTimer(2, { targetAt });
        await Promise.allSettled(redirectTasks);
        return { result, freshTabs };
      } finally {
        chrome.tabs.onCreated.removeListener(activateFreshTab);
      }
    }, pageTimerTargetAt);
    const pageTimerResult = pageTimerHarness.result;
    const homeRequestsDuringTimerProof = mockHomeRequestCount - homeRequestsBeforeTimerProof;
    console.log('  新鲜页验证状态:', JSON.stringify(pageTimerHarness));
    const pageTimerState = await serviceWorker.evaluate(async () => {
      const stored = (await chrome.storage.local.get('ac_schedule')).ac_schedule || {};
      return {
        pageTimerMinutes: stored.pageTimerMinutes,
        pageTimerTargetAt: stored.pageTimerTargetAt,
        pageTimerError: stored.pageTimerError,
        retryAt: stored.pageTimerRetryAt,
        retryMinutes: stored.pageTimerRetryMinutes
      };
    });
    const sourceTimerValue = await acPage.evaluate(() => ({
      value: document.querySelector('.timer-row .ant-picker input')?.value || '',
      title: document.querySelector('.timer-row .ant-picker input')?.getAttribute('title') || '',
      persisted: localStorage.getItem('ac-e2e-page-timer') || '',
      switchClicks: globalThis.__acMockSwitchClickCount,
      controlledCommits: globalThis.__acControlledTimerCommits,
      controlledReplacements: globalThis.__acControlledTimerReplacements,
      controlledLastDelayMs: globalThis.__acControlledTimerLastDelayMs
    }));

    await acPage.evaluate(() => {
      const duplicate = document.querySelector('.timer-row').cloneNode(true);
      duplicate.id = 'ambiguous-power-off-after';
      document.body.appendChild(duplicate);
    });
    const ambiguousTimerTargetAt = Math.ceil((Date.now() + 3 * 60 * 1000) / 60000) * 60000;
    const ambiguousTimerResult = await serviceWorker.evaluate(async (targetAt) => {
      const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
      const tab = tabs.find(candidate => !candidate.discarded);
      if (!tab?.id) return { success: false, error: 'mock home tab missing' };
      return chrome.tabs.sendMessage(tab.id, { action: 'setTimer', minutes: 3, targetAt });
    }, ambiguousTimerTargetAt);
    const ambiguousTimerFixture = await acPage.evaluate(() => {
      document.getElementById('ambiguous-power-off-after')?.remove();
      return {
        persisted: localStorage.getItem('ac-e2e-page-timer') || '',
        switchClicks: globalThis.__acMockSwitchClickCount
      };
    });

    assert(pageTimerResult?.success === true
        && pageTimerResult?.verified === true
        && pageTimerResult?.verification?.attempts === 1
        && pageTimerHarness.freshTabs?.length === 1
        && pageTimerHarness.freshTabs[0]?.wasActive === false
        && pageTimerHarness.freshTabs[0]?.seedReady === true
        && pageTimerHarness.freshTabs[0]?.rerouted === true
        && homeRequestsDuringTimerProof === 1
        && pageTimerResult?.targetAt === pageTimerTargetAt
        && pageTimerResult?.value === sourceTimerValue.persisted
        && sourceTimerValue.value === sourceTimerValue.title
        && sourceTimerValue.controlledCommits >= 1
        && sourceTimerValue.controlledReplacements >= 1
        && sourceTimerValue.controlledLastDelayMs >= 500,
      '真实受控 picker 延迟提交并替换节点后，由第一张独立新鲜页精确读回');
    assert(pageTimerState.pageTimerTargetAt === pageTimerTargetAt
        && Number(pageTimerState.pageTimerMinutes) > 0
        && pageTimerState.pageTimerError === ''
        && pageTimerState.retryAt === 0
        && pageTimerState.retryMinutes === 0,
      '新鲜页确认后 storage 写入绝对关机证明并清空失败重试');
    assert(ambiguousTimerResult?.success === false
        && ambiguousTimerFixture.persisted === sourceTimerValue.persisted
        && ambiguousTimerFixture.switchClicks === sourceTimerValue.switchClicks,
      'Power-off after 控件歧义时拒绝写入，不改变已确认值且不点击 AC 开关');

    // === 先保险后开机：同一 tab 预置，歧义零点击，含糊 ON 零重复点击 ===
    console.log('\n--- 步骤 2.8: 验证同页预置关机保险后开机 ---\n');
    // 2.6 故意留下“物理 click 已发出、结果未知”的 60s 页面租约；那项安全
    // 静默窗正是被测行为，不能让紧邻的独立正向用例绕过它。这里在任何 timer
    // 预置之前加载一张新页面隔离用例；下方 loadToken 仍会证明预置→ON→proof
    // 事务自身没有刷新或导航来源页。
    await acPage.reload({ timeout: 10000, waitUntil: 'load' });
    await acPage.waitForFunction(() => (
      !!document.querySelector('button.ant-switch[role="switch"]')
      && !!document.querySelector('.timer-row .ant-picker input')
    ), null, { timeout: 5000 });
    const preparedOnTargetAt = Math.ceil((Date.now() + 4 * 60 * 1000) / 60000) * 60000;
    const preparedOnFixture = await acPage.evaluate(() => {
      const oldSwitch = document.querySelector('button.ant-switch[role="switch"]');
      const switchElement = oldSwitch.cloneNode(true);
      oldSwitch.replaceWith(switchElement);
      switchElement.setAttribute('aria-checked', 'false');
      switchElement.textContent = 'OFF';
      globalThis.__acPreparedOnClickCount = 0;
      globalThis.__acPreparedTimerAtClick = '';
      globalThis.__acPreparedLoadTokenAtClick = '';
      switchElement.addEventListener('click', () => {
        globalThis.__acPreparedOnClickCount += 1;
        globalThis.__acPreparedTimerAtClick = String(
          document.querySelector('.timer-row .ant-picker input')?.value || ''
        ).trim();
        globalThis.__acPreparedLoadTokenAtClick = globalThis.__acMockLoadToken;
        if (globalThis.__acPreparedOnClickCount > 1) return;
        // 故意不生成 Execution succeeded：模拟页面响应快于 toast 捕获，
        // background 必须只读看见 ON 后验证 timer，不能再点第二次。
        setTimeout(() => {
          switchElement.setAttribute('aria-checked', 'true');
          switchElement.textContent = 'ON';
        }, 250);
      });
      const duplicate = document.querySelector('.timer-row').cloneNode(true);
      duplicate.id = 'prepared-on-ambiguous-timer';
      document.body.appendChild(duplicate);
      return { loadToken: globalThis.__acMockLoadToken };
    });
    const preparedOnRejected = await serviceWorker.evaluate(async (targetAt) => {
      if (typeof armPowerOffTimerEnsuringOn !== 'function') {
        return { success: false, productionFunctionMissing: true };
      }
      return armPowerOffTimerEnsuringOn(4, {
        targetAt,
        automaticOnDeadlineAt: Date.now() + 60000,
        requireAutomationAllowed: false
      });
    }, preparedOnTargetAt);
    const rejectedPreparedOnState = await acPage.evaluate(() => {
      document.getElementById('prepared-on-ambiguous-timer')?.remove();
      return {
        clicks: globalThis.__acPreparedOnClickCount,
        isOn: document.querySelector('button.ant-switch[role="switch"]')
          ?.getAttribute('aria-checked') === 'true'
      };
    });

    const preparedOnFreshTabs = await serviceWorker.evaluate(async (targetAt) => {
      const freshTabs = [];
      const redirectTasks = [];
      const homeUrl = 'https://w5.ab.ust.hk/njggt/app/home';
      const seedUrl = chrome.runtime.getURL('manifest.json');
      const activateFreshTab = (tab) => {
        const targetUrl = tab?.pendingUrl || tab?.url || '';
        if (targetUrl !== homeUrl) return;
        const entry = { id: tab.id, wasActive: tab.active, targetUrl };
        freshTabs.push(entry);
        redirectTasks.push((async () => {
          try {
            await chrome.tabs.update(tab.id, { url: seedUrl, active: true });
            for (let index = 0; index < 40; index += 1) {
              const current = await chrome.tabs.get(tab.id);
              if (current.status === 'complete' && current.url === seedUrl) {
                entry.seedReady = true;
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            await chrome.tabs.update(tab.id, { url: homeUrl, active: true });
            entry.rerouted = true;
          } catch (error) {
            entry.error = error?.message || String(error);
          }
        })());
      };
      chrome.tabs.onCreated.addListener(activateFreshTab);
      try {
        const result = await armPowerOffTimerEnsuringOn(4, {
          targetAt,
          automaticOnDeadlineAt: Date.now() + 60000,
          requireAutomationAllowed: false
        });
        await Promise.allSettled(redirectTasks);
        return { result, freshTabs };
      } finally {
        chrome.tabs.onCreated.removeListener(activateFreshTab);
      }
    }, preparedOnTargetAt);
    const preparedOnResult = preparedOnFreshTabs.result;
    const preparedOnSourceState = await acPage.evaluate(() => ({
      clicks: globalThis.__acPreparedOnClickCount,
      timerAtClick: globalThis.__acPreparedTimerAtClick,
      loadTokenAtClick: globalThis.__acPreparedLoadTokenAtClick,
      loadTokenNow: globalThis.__acMockLoadToken,
      isOn: document.querySelector('button.ant-switch[role="switch"]')
        ?.getAttribute('aria-checked') === 'true',
      timerNow: String(document.querySelector('.timer-row .ant-picker input')?.value || '').trim()
    }));

    assert(preparedOnRejected?.success === false
        && preparedOnRejected?.failureStage === 'write'
        && rejectedPreparedOnState.clicks === 0
        && rejectedPreparedOnState.isOn === false,
      '真实 picker 歧义时预置失败并零开机点击');
    assert(preparedOnResult?.success === true
        && preparedOnResult?.toggledOn === true
        && preparedOnResult?.acIsOn === true
        && preparedOnResult?.verification?.success === true
        && preparedOnResult?.targetAt === preparedOnTargetAt
        && preparedOnSourceState.clicks === 1
        && preparedOnSourceState.isOn === true,
      '缺少新 Execution succeeded 但同页已 ON 时只点击一次，并完成页面关机保险新鲜页证明');
    assert(preparedOnSourceState.timerAtClick === preparedOnSourceState.timerNow
        && preparedOnSourceState.timerAtClick === preparedOnResult?.value
        && preparedOnSourceState.loadTokenAtClick === preparedOnFixture.loadToken
        && preparedOnSourceState.loadTokenNow === preparedOnFixture.loadToken
        && preparedOnFreshTabs.freshTabs?.length === 1
        && preparedOnFreshTabs.freshTabs[0]?.seedReady === true
        && preparedOnFreshTabs.freshTabs[0]?.rerouted === true,
      '物理 ON 点击前同一未刷新 home tab 已持有目标 timer；验证页独立创建且不刷新来源页');

    await acPage.close();

    // === 完整关闭并重启浏览器：storage.session 会清空，local 必须承担常驻边界 ===
    console.log('\n--- 步骤 3: 完整关闭并重启同一浏览器 profile ---\n');
    await popupPage.close();
    await context.close();
    context = null;

    const restarted = await launchExtensionContext(successfulLaunchOptions);
    restartedContext = restarted.context;
    const restartedWorker = restarted.serviceWorker
      || await waitForExtensionServiceWorker(restartedContext, extensionId);
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
        && typeof applySmartDurationsForBoundary === 'function'
        && typeof persistSchedule === 'function'
        && typeof planSmartRecovery === 'function'
        && typeof planPwmLifecycleRecovery === 'function';
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
      const applied = await applySmartDurationsForBoundary(boundaryAt);
      const delayedAlarmPlan = typeof planSmartModeOnWindow === 'function'
        ? planSmartModeOnWindow(
          { onMinutes: 21 },
          {
            now: boundaryAt + 65_000,
            maxOnMinutes: 25,
            acIsOn: false,
            triggeredBoundaryAt: boundaryAt
          }
        )
        : null;
      const delayedWithoutAlarmPlan = typeof planSmartModeOnWindow === 'function'
        ? planSmartModeOnWindow(
          { onMinutes: 21 },
          { now: boundaryAt + 65_000, maxOnMinutes: 25, acIsOn: false }
        )
        : null;
      const delayedRecoveryPlan = typeof planSmartModeOnWindow === 'function'
        ? planSmartModeOnWindow(
          { onMinutes: 21 },
          {
            now: boundaryAt + 7 * 60_000,
            maxOnMinutes: 25,
            acIsOn: false,
            recoverCurrentCycle: true
          }
        )
        : null;
      const tooLateRecoveryPlan = typeof planSmartModeOnWindow === 'function'
        ? planSmartModeOnWindow(
          { onMinutes: 21 },
          {
            now: boundaryAt + 20 * 60_000 + 30_000,
            maxOnMinutes: 25,
            acIsOn: false,
            recoverCurrentCycle: true
          }
        )
        : null;
      const recoveredSchedule = {
        ...smartSchedule,
        pwmState: 'on',
        onMinutes: 21,
        offMinutes: 9
      };
      const lifecycleRecoveryPlan = typeof planPwmLifecycleRecovery === 'function'
        ? planPwmLifecycleRecovery(recoveredSchedule, {
          now: boundaryAt + 7 * 60_000,
          plannedActionAt: boundaryAt + 30 * 60_000,
          liveAlarmAt: boundaryAt + 30 * 60_000,
          maxOnMinutes: 25,
          missingClockAction: 'repair-clock'
        })
        : null;
      const shortRetryAt = boundaryAt + 8 * 60_000;
      const preservedShortRetryPlan = typeof planPwmLifecycleRecovery === 'function'
        ? planPwmLifecycleRecovery({
          ...recoveredSchedule,
          smartRetryKind: 'smart-on-safe-delay',
          smartRetryBoundaryAt: boundaryAt,
          smartRetryScheduledAt: shortRetryAt
        }, {
          now: boundaryAt + 7 * 60_000,
          smartClockPlannedAt: boundaryAt + 7 * 60_000,
          plannedActionAt: shortRetryAt,
          liveAlarmAt: shortRetryAt,
          maxOnMinutes: 25,
          missingClockAction: 'repair-clock'
        })
        : undefined;
      const acceptanceBoundaryAt = boundaryAt + 30 * 60_000;
      const skippedNearestClockPlan = typeof planPwmLifecycleRecovery === 'function'
        ? planPwmLifecycleRecovery(recoveredSchedule, {
          now: acceptanceBoundaryAt - 63_000,
          smartClockPlannedAt: acceptanceBoundaryAt - 4 * 60_000,
          plannedActionAt: acceptanceBoundaryAt + 30 * 60_000,
          liveAlarmAt: acceptanceBoundaryAt + 30 * 60_000,
          storedAlarmAt: acceptanceBoundaryAt + 30 * 60_000,
          maxOnMinutes: 25,
          missingClockAction: 'repair-clock'
        })
        : undefined;
      const rejectedLateLifecyclePlan = typeof planPwmLifecycleRecovery === 'function'
        ? planPwmLifecycleRecovery(recoveredSchedule, {
          now: boundaryAt + 20 * 60_000 + 30_000,
          plannedActionAt: boundaryAt + 30 * 60_000,
          liveAlarmAt: boundaryAt + 30 * 60_000,
          maxOnMinutes: 25,
          missingClockAction: 'repair-clock'
        })
        : undefined;
      await persistSchedule('e2e-smart-duration', { syncFromLiveAlarm: false });
      const persisted = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
      return {
        productionFunctionsAvailable,
        planMissing,
        before,
        applied,
        delayedAlarmPlan,
        delayedWithoutAlarmPlan,
        delayedRecoveryPlan,
        tooLateRecoveryPlan,
        lifecycleRecoveryPlan,
        preservedShortRetryPlan,
        skippedNearestClockPlan,
        rejectedLateLifecyclePlan,
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
    assert(smartWorkerState.applied?.valid === true
        && smartWorkerState.applied?.onMinutes === 21
        && smartWorkerState.persisted?.smartMode?.enabled === true
        && smartWorkerState.persisted?.onMinutes === 21
        && smartWorkerState.persisted?.offMinutes === 9,
      '真实 Worker 只读新鲜本地天气，把旧 12/18 刷新并持久化为 21/9');
    assert(smartWorkerState.delayedAlarmPlan?.kind === 'allow'
        && smartWorkerState.delayedAlarmPlan?.reason === 'smart-on-scheduled-boundary'
        && smartWorkerState.delayedAlarmPlan?.pageTimerTargetAt
          === smartBoundaryAt + 21 * 60 * 1000
        && smartWorkerState.delayedWithoutAlarmPlan?.kind === 'defer',
      '真实 Worker 只让可信半点 alarm 补执行迟到 ON，并保持原半点绝对关机点');
    assert(smartWorkerState.delayedRecoveryPlan?.kind === 'allow'
        && smartWorkerState.delayedRecoveryPlan?.reason
          === 'smart-on-current-cycle-recovery'
        && smartWorkerState.delayedRecoveryPlan?.pageTimerTargetAt
          === smartBoundaryAt + 21 * 60 * 1000
        && smartWorkerState.tooLateRecoveryPlan?.kind === 'defer',
      '真实 Worker 在明确恢复路径补当前剩余 ON 窗口，安全余量不足时仍等待下个半点');
    assert(smartWorkerState.lifecycleRecoveryPlan?.kind === 'recover-smart-current-cycle'
        && smartWorkerState.lifecycleRecoveryPlan?.reason
          === 'smart-on-current-cycle-recovery'
        && smartWorkerState.lifecycleRecoveryPlan?.pageTimerTargetAt
          === smartBoundaryAt + 21 * 60 * 1000
        && smartWorkerState.preservedShortRetryPlan?.kind === 'preserve-live-alarm'
        && smartWorkerState.preservedShortRetryPlan?.smartDecisionReason
          === 'current-smart-alarm-preserved'
        && smartWorkerState.skippedNearestClockPlan?.kind === 'repair-clock'
        && smartWorkerState.skippedNearestClockPlan?.reason
          === 'skipped-nearest-smart-on-boundary'
        && smartWorkerState.skippedNearestClockPlan?.expectedAt
          === smartBoundaryAt + 30 * 60 * 1000
        && smartWorkerState.rejectedLateLifecyclePlan?.kind === 'preserve-live-alarm'
        && smartWorkerState.rejectedLateLifecyclePlan?.smartDecisionReason
          === 'current-smart-alarm-preserved',
      '真实 Worker 生命周期门禁修复跨周期未来闹钟，同时保留本周期短重试并拒绝过迟开机');
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

    // === HKO 三源数据：生产 URL → fetch → 解析 → 缓存 → 边界计划 → Popup ===
    console.log('\n--- 步骤 5: 验证 HKO 三源数据获取全链路 ---\n');
    const weatherBoundary = new Date();
    weatherBoundary.setSeconds(0, 0);
    if (weatherBoundary.getMinutes() < 30) {
      weatherBoundary.setMinutes(30);
    } else {
      weatherBoundary.setHours(weatherBoundary.getHours() + 1, 0, 0, 0);
    }
    const weatherBoundaryAt = weatherBoundary.getTime();
    const hkoFixtures = {
      temperature: '\uFEFFDate time,Automatic Weather Station,Air Temperature(degree Celsius)\r\n'
        + '202608241510,Sai Kung,33.3\r\n202608241510,Tseung Kwan O,32.6\r\n',
      humidity: 'Date time,Automatic Weather Station,Relative Humidity(percent)\n'
        + '202608241510,HK Observatory,73\n202608241510,Tseung Kwan O,67\n',
      wind: 'Date time,Automatic Weather Station,Direction,Speed,Gust\n'
        + '202608241510,Sai Kung,South,10,21\n'
        + '202608241510,Tseung Kwan O,Southwest,16,26\n'
    };
    const weatherFetchState = await restartedWorker.evaluate(async ({ boundaryAt, fixtures }) => {
      const originalFetch = globalThis.fetch;
      const requests = [];
      const expectedUrls = { ...SMART_WEATHER_URLS };
      const bodies = new Map([
        [expectedUrls.temperature, { type: 'text', body: fixtures.temperature }],
        [expectedUrls.humidity, { type: 'text', body: fixtures.humidity }],
        [expectedUrls.wind, { type: 'text', body: fixtures.wind }]
      ]);
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, cache: init.cache || '' });
        const fixture = bodies.get(url);
        if (!fixture) {
          return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          text: async () => String(fixture.body),
          json: async () => fixture.body
        };
      };
      try {
        await chrome.storage.local.remove(['ac_smart_weather', 'ac_smart_weather_plan']);
        await loadScheduleFromStorage();
        const prepared = await prepareSmartWeatherForBoundary(boundaryAt);
        const stored = await chrome.storage.local.get([
          'ac_smart_weather',
          'ac_smart_weather_plan'
        ]);
        return {
          requests,
          expectedUrls,
          prepared,
          weather: stored.ac_smart_weather,
          plan: stored.ac_smart_weather_plan
        };
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, { boundaryAt: weatherBoundaryAt, fixtures: hkoFixtures });
    console.log('  HKO 成功链:', JSON.stringify(weatherFetchState));

    assert(Object.values(weatherFetchState.expectedUrls || {}).length === 3
        && weatherFetchState.requests?.length === 3
        && new Set(weatherFetchState.requests.map(request => request.url)).size === 3
        && Object.values(weatherFetchState.expectedUrls).every(url => (
          weatherFetchState.requests.some(request => request.url === url)
        ))
        && weatherFetchState.requests.every(request => request.cache === 'no-store'),
      '真实 Worker 只向温度、湿度、风速三个生产 HKO URL 各请求一次，并全部禁用 HTTP 缓存');
    assert(weatherFetchState.weather?.temperature === 32.6
        && weatherFetchState.weather?.relativeHumidity === 67
        && Math.abs(weatherFetchState.weather?.windSpeedMs - 16 / 3.6) < 1e-9
        && !Object.hasOwn(weatherFetchState.weather || {}, 'rainMm')
        && Number.isFinite(weatherFetchState.weather?.dewPoint),
      '三源响应按 Tseung Kwan O 同站合并，推导露点并把风速换算为 m/s');
    assert(weatherFetchState.prepared?.boundaryAt === weatherBoundaryAt
        && weatherFetchState.plan?.boundaryAt === weatherBoundaryAt
        && weatherFetchState.plan?.onMinutes === 24
        && weatherFetchState.plan?.offMinutes === 6
        && weatherFetchState.plan?.weather?.temperature === 32.6
        && !Object.hasOwn(weatherFetchState.plan?.weather || {}, 'rainMm'),
      '获取结果缓存后为目标半点预计算并持久化无雨量字段的 24/6 边界计划');

    await restartedPopup.reload({ timeout: 10000, waitUntil: 'load' });
    const fetchedWeatherPopupReady = await restartedPopup.waitForFunction(() => (
      document.getElementById('smartSuggested')?.textContent?.trim() === '24/30'
      && !document.getElementById('smartUpdated')?.textContent?.includes('--')
    ), null, { timeout: 10000 }).then(() => true).catch(() => false);
    const fetchedWeatherPopup = await restartedPopup.evaluate(() => ({
      suggested: document.getElementById('smartSuggested')?.textContent?.trim() || '',
      teq: document.getElementById('smartTeq')?.textContent?.trim() || '',
      updated: document.getElementById('smartUpdated')?.textContent?.trim() || ''
    }));
    assert(fetchedWeatherPopupReady
        && fetchedWeatherPopup.suggested === '24/30'
        && /°C/.test(fetchedWeatherPopup.teq)
        && fetchedWeatherPopup.updated !== '--',
      '真实 Popup 消费刚获取的三源缓存并显示同一 24/30、Teq 与更新时间');

    const weatherFailureState = await restartedWorker.evaluate(async ({ boundaryAt, fixtures }) => {
      const before = await chrome.storage.local.get([
        'ac_smart_weather',
        'ac_smart_weather_plan'
      ]);
      const beforeWeather = JSON.stringify(before.ac_smart_weather);
      const beforePlan = JSON.stringify(before.ac_smart_weather_plan);
      const originalFetch = globalThis.fetch;
      const requests = [];
      const responseFor = (url) => {
        if (url === SMART_WEATHER_URLS.temperature) {
          return { ok: false, status: 503, text: async () => '' };
        }
        if (url === SMART_WEATHER_URLS.humidity) {
          return { ok: true, status: 200, text: async () => fixtures.humidity };
        }
        if (url === SMART_WEATHER_URLS.wind) {
          return { ok: true, status: 200, text: async () => fixtures.wind };
        }
        return { ok: false, status: 404, text: async () => '' };
      };
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, cache: init.cache || '' });
        return responseFor(url);
      };
      try {
        const prepared = await prepareSmartWeatherForBoundary(boundaryAt);
        const after = await chrome.storage.local.get([
          'ac_smart_weather',
          'ac_smart_weather_plan'
        ]);
        return {
          prepared,
          requests,
          weatherPreserved: JSON.stringify(after.ac_smart_weather) === beforeWeather,
          planPreserved: JSON.stringify(after.ac_smart_weather_plan) === beforePlan
        };
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, { boundaryAt: weatherBoundaryAt, fixtures: hkoFixtures });
    console.log('  HKO 失败回退:', JSON.stringify(weatherFailureState));
    assert(weatherFailureState.prepared === null
      && weatherFailureState.requests?.length === 3
        && weatherFailureState.requests.every(request => request.cache === 'no-store')
        && weatherFailureState.weatherPreserved
        && weatherFailureState.planPreserved,
      '任一 HKO 源失败时不生成伪计划，并保留最近成功缓存与边界计划');

    // === Popup 用户旅程：设置、校验、暂停运行与安全停用 ===
    console.log('\n--- 步骤 6: 验证 Popup 全部设置交互 ---\n');
    await restartedContext.route('https://w5.ab.ust.hk/njggt/app/home', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: mockHomeHtml
    }));
    const settingsHome = await restartedContext.newPage();
    await settingsHome.goto('https://w5.ab.ust.hk/njggt/app/home', {
      timeout: 10000,
      waitUntil: 'load'
    });
    await settingsHome.evaluate(() => {
      localStorage.removeItem('ac-e2e-page-timer');
      const timerInput = document.querySelector('.timer-row .ant-picker input');
      if (timerInput) {
        timerInput.value = '';
        timerInput.setAttribute('title', '');
      }
      globalThis.__acSettingsSwitchClicks = 0;
      const switchElement = document.querySelector('button.ant-switch[role="switch"]');
      switchElement?.addEventListener('click', () => {
        globalThis.__acSettingsSwitchClicks += 1;
        if (switchElement.getAttribute('aria-checked') === 'true') return;
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
        setTimeout(() => {
          switchElement.setAttribute('aria-checked', 'true');
          switchElement.textContent = 'ON';
        }, 450);
      });
    });
    let settingsHomeStatus = null;
    const settingsHomeDeadline = Date.now() + 8000;
    while (Date.now() < settingsHomeDeadline) {
      settingsHomeStatus = await restartedWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
        const tab = tabs.find(candidate => !candidate.discarded);
        if (!tab?.id) return null;
        try { return await chrome.tabs.sendMessage(tab.id, { action: 'status' }); }
        catch (_) { return null; }
      });
      if (settingsHomeStatus?.isOn === false) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    const settingsFixture = await restartedWorker.evaluate(async () => {
      const current = (await chrome.storage.local.get('ac_schedule')).ac_schedule || {};
      const disabled = {
        ...current,
        enabled: false,
        mode: 'pwm',
        clockMode: false,
        onMinutes: 17,
        offMinutes: 13,
        pwmState: 'on',
        nextTriggerAt: 0,
        alarmCreatedAt: 0,
        alarmDelayMinutes: 0,
        pageTimerMinutes: null,
        pageTimerTargetAt: 0,
        pageTimerError: '',
        pageTimerRetryAt: 0,
        pageTimerRetryMinutes: 0,
        comfortStartUntil: 0,
        comfortStartOnConfirmedAt: 0,
        activeHours: { enabled: false, start: '08:00', end: '23:00' },
        smartMode: { enabled: false, sensitivity: 5 }
      };
      await chrome.storage.sync.remove('ac_schedule_sync');
      await chrome.storage.local.remove([
        'ac_schedule_sync_publish_pending',
        'ac_schedule_sync_watermark',
        'ac_schedule_sync_payload_receipt'
      ]);
      lastSyncedAt = 0;
      await Promise.all([
        'ac-pwm',
        'ac-badge-tick',
        'ac-watchdog',
        'ac-active-boundary',
        'ac-comfort-end',
        'ac-page-timer-retry',
        'ac-sync-publish-retry',
        'ac-sync-adopt-retry'
      ].map(name => chrome.alarms.clear(name)));
      await chrome.storage.local.set({ ac_schedule: disabled });
      await loadScheduleFromStorage();
      return (await chrome.storage.local.get('ac_schedule')).ac_schedule;
    });
    await restartedPopup.reload({ timeout: 10000, waitUntil: 'load' });
    await restartedPopup.waitForFunction(() => (
      document.getElementById('automationToggle')?.checked === false
      && document.getElementById('timerToggle')?.getAttribute('aria-pressed') === 'true'
      && document.getElementById('onMinutes')?.value === '17'
      && document.getElementById('offMinutes')?.value === '13'
    ), null, { timeout: 10000 });

    await restartedPopup.click('#smartModeToggle');
    await restartedPopup.waitForFunction(async () => {
      const schedule = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
      return schedule?.smartMode?.enabled === true
        && document.getElementById('smartModeToggle')?.disabled === false;
    }, null, { timeout: 10000 });
    await restartedPopup.evaluate(() => {
      const input = document.getElementById('smartSensitivity');
      input.value = '8';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await restartedPopup.waitForFunction(async () => (
      (await chrome.storage.local.get('ac_schedule')).ac_schedule?.smartMode?.sensitivity === 8
      && document.getElementById('smartModeToggle')?.disabled === false
      && document.getElementById('smartSensitivityValue')?.textContent === '8'
    ), null, { timeout: 10000 });
    const sensitivityUpdateResult = await restartedPopup.evaluate(async () => ({
      success: (await chrome.storage.local.get('ac_schedule')).ac_schedule?.smartMode?.sensitivity === 8
    }));
    const smartInteractionState = await restartedPopup.evaluate(async () => ({
      smartPressed: document.getElementById('smartModeToggle')?.getAttribute('aria-pressed'),
      timerPressed: document.getElementById('timerToggle')?.getAttribute('aria-pressed'),
      sensitivity: document.getElementById('smartSensitivity')?.value,
      bubble: document.getElementById('smartSensitivityValue')?.textContent,
      schedule: (await chrome.storage.local.get('ac_schedule')).ac_schedule,
      smartWeatherAlarm: await chrome.alarms.get('ac-smart-weather'),
      observedAt: Date.now()
    }));

    await restartedPopup.locator('label:has(#activeHoursToggle)').click();
    await restartedPopup.waitForFunction(() => (
      document.getElementById('activeHoursToggle')?.checked === true
      && document.getElementById('activeHoursBody')?.hidden === false
    ), null, { timeout: 10000 });
    const activeHoursBeforeInvalid = await restartedPopup.evaluate(async () => (
      (await chrome.storage.local.get('ac_schedule')).ac_schedule?.activeHours
    ));
    await restartedPopup.evaluate(() => {
      document.getElementById('activeHoursStart').value = '23:00';
      const end = document.getElementById('activeHoursEnd');
      end.value = '08:00';
      end.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const invalidHoursState = await restartedPopup.evaluate(async () => ({
      validationMessage: document.getElementById('activeHoursEnd')?.validationMessage || '',
      activeHours: (await chrome.storage.local.get('ac_schedule')).ac_schedule?.activeHours
    }));

    const nowForExcludedHours = new Date();
    const excludedHours = nowForExcludedHours.getHours() === 0
        && nowForExcludedHours.getMinutes() === 0
      ? { start: '23:58', end: '23:59' }
      : { start: '00:00', end: '00:01' };
    await restartedPopup.evaluate(({ start, end }) => {
      document.getElementById('activeHoursStart').value = start;
      const endInput = document.getElementById('activeHoursEnd');
      endInput.value = end;
      endInput.dispatchEvent(new Event('change', { bubbles: true }));
    }, excludedHours);
    await restartedPopup.waitForFunction(async ({ start, end }) => {
      const activeHours = (await chrome.storage.local.get('ac_schedule')).ac_schedule?.activeHours;
      return activeHours?.enabled === true
        && activeHours?.start === start
        && activeHours?.end === end;
    }, excludedHours, { timeout: 10000 });

    // 与步骤 2.7 相同：Playwright 不拦截 chrome.tabs.create 新 target 的首次导航。
    // 把舒适启动的新鲜验证页先附着到扩展页，再导回 home fixture；生产代码仍然
    // 创建 active:false 的独立页并执行完整持久化读回。
    await restartedWorker.evaluate(() => {
      const homeUrl = 'https://w5.ab.ust.hk/njggt/app/home';
      const seedUrl = chrome.runtime.getURL('manifest.json');
      globalThis.__AC_E2E_COMFORT_FRESH_TABS__ = [];
      globalThis.__AC_E2E_COMFORT_ON_CREATED__ = (tab) => {
        const targetUrl = tab?.pendingUrl || tab?.url || '';
        if (targetUrl !== homeUrl) return;
        const entry = { id: tab.id, wasActive: tab.active, targetUrl };
        globalThis.__AC_E2E_COMFORT_FRESH_TABS__.push(entry);
        void (async () => {
          try {
            await chrome.tabs.update(tab.id, { url: seedUrl, active: true });
            for (let index = 0; index < 40; index += 1) {
              const current = await chrome.tabs.get(tab.id);
              if (current.status === 'complete' && current.url === seedUrl) {
                entry.seedReady = true;
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            await chrome.tabs.update(tab.id, { url: homeUrl, active: true });
            entry.rerouted = true;
          } catch (error) {
            entry.error = error?.message || String(error);
          }
        })();
      };
      chrome.tabs.onCreated.addListener(globalThis.__AC_E2E_COMFORT_ON_CREATED__);
    });

    await restartedPopup.locator('label:has(#automationToggle)').click();
    // ON 确认、页面定时器新鲜页验证和 Popup 解锁是三个异步阶段。
    // 连续观察到两个完全稳定的快照才继续，避免刚解锁又被安装尾声旧事务抢回。
    let comfortWaitState = null;
    let comfortStableReads = 0;
    let comfortStableSignature = '';
    const comfortReadyDeadline = Date.now() + 60000;
    while (Date.now() < comfortReadyDeadline && comfortStableReads < 2) {
      comfortWaitState = await restartedPopup.evaluate(async () => {
        const schedule = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
        return {
          schedule,
          modeSwitchInFlight: typeof modeSwitchInFlight === 'boolean' ? modeSwitchInFlight : null,
          automationDisabled: document.getElementById('automationToggle')?.disabled,
          timerDisabled: document.getElementById('timerToggle')?.disabled,
          smartDisabled: document.getElementById('smartModeToggle')?.disabled
        };
      });
      const ready = comfortWaitState.schedule?.enabled === true
        && comfortWaitState.schedule?.activeHours?.enabled === true
        && comfortWaitState.modeSwitchInFlight === false
        && comfortWaitState.automationDisabled === false
        && comfortWaitState.timerDisabled === false
        && comfortWaitState.smartDisabled === false;
      const signature = ready
        ? JSON.stringify({
          enabled: comfortWaitState.schedule.enabled,
          activeHours: comfortWaitState.schedule.activeHours
        })
        : '';
      comfortStableReads = ready && signature === comfortStableSignature
        ? comfortStableReads + 1
        : (ready ? 1 : 0);
      comfortStableSignature = signature;
      if (comfortStableReads < 2) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (comfortStableReads < 2) {
      throw new Error(`舒适启动未在 60 秒内稳定完成：${JSON.stringify(comfortWaitState)}`);
    }
    const pausedAutomationState = await restartedPopup.evaluate(async () => ({
      schedule: (await chrome.storage.local.get('ac_schedule')).ac_schedule,
      snapshot: await chrome.runtime.sendMessage({ type: 'getScheduleLite' }),
      activeBoundaryAlarm: await chrome.alarms.get('ac-active-boundary'),
      pwmAlarm: await chrome.alarms.get('ac-pwm'),
      comfortEndAlarm: await chrome.alarms.get('ac-comfort-end'),
      pageTimer: await chrome.runtime.sendMessage({ type: 'getPageTimer' }),
      status: document.getElementById('status')?.textContent || '',
      observedAt: Date.now()
    }));
    const settingsSwitchClicksAfterComfort = await settingsHome.evaluate(
      () => globalThis.__acSettingsSwitchClicks
    );
    const comfortFreshTabs = await restartedWorker.evaluate(() => (
      Array.isArray(globalThis.__AC_E2E_COMFORT_FRESH_TABS__)
        ? globalThis.__AC_E2E_COMFORT_FRESH_TABS__.map(entry => ({ ...entry }))
        : []
    ));
    console.log('  舒适启动 Popup 状态:', JSON.stringify(pausedAutomationState));

    await restartedPopup.waitForFunction(() => (
      document.getElementById('automationToggle')?.disabled === false
      && document.getElementById('timerToggle')?.disabled === false
      && document.getElementById('smartModeToggle')?.disabled === false
    ), null, { timeout: 60000 });
    await restartedPopup.click('#timerToggle');
    await restartedPopup.waitForFunction(async () => (
      (await chrome.storage.local.get('ac_schedule')).ac_schedule?.smartMode?.enabled === false
      && document.getElementById('timerToggle')?.disabled === false
    ), null, { timeout: 10000 });
    await restartedPopup.evaluate(() => {
      document.getElementById('onMinutes').value = '21';
      const off = document.getElementById('offMinutes');
      off.value = '9';
      off.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await restartedPopup.waitForFunction(async () => (
      (await chrome.storage.local.get('ac_schedule')).ac_schedule?.onMinutes === 21
      && (await chrome.storage.local.get('ac_schedule')).ac_schedule?.offMinutes === 9
    ), null, { timeout: 10000 });
    const minutesSavedState = await restartedPopup.evaluate(async () => {
      const schedule = (await chrome.storage.local.get('ac_schedule')).ac_schedule;
      return {
        result: { success: schedule?.onMinutes === 21 && schedule?.offMinutes === 9 },
        onMinutes: schedule?.onMinutes,
        offMinutes: schedule?.offMinutes
      };
    });
    await restartedPopup.evaluate(() => {
      const on = document.getElementById('onMinutes');
      on.value = '0';
      on.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const invalidMinutesState = await restartedPopup.evaluate(async () => ({
      validationMessage: document.getElementById('onMinutes')?.validationMessage || '',
      rawValue: document.getElementById('onMinutes')?.value || '',
      schedule: (await chrome.storage.local.get('ac_schedule')).ac_schedule
    }));
    console.log('  非法分钟状态:', JSON.stringify({
      saved: minutesSavedState,
      after: invalidMinutesState
    }));

    // 非法分钟数不能阻止安全停用；后台应识别页面已 OFF，绝不点击开关。
    await restartedPopup.locator('label:has(#automationToggle)').click();
    await restartedPopup.waitForFunction(async () => (
      (await chrome.storage.local.get('ac_schedule')).ac_schedule?.enabled === false
      && modeSwitchInFlight === false
      && document.getElementById('automationToggle')?.disabled === false
    ), null, { timeout: 60000 });
    const disableAutomationResult = await restartedPopup.evaluate(async () => ({
      success: (await chrome.storage.local.get('ac_schedule')).ac_schedule?.enabled === false
    }));
    await restartedPopup.evaluate(() => {
      const on = document.getElementById('onMinutes');
      on.value = '21';
      on.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await restartedPopup.locator('label:has(#activeHoursToggle)').click();
    await restartedPopup.waitForFunction(async () => (
      (await chrome.storage.local.get('ac_schedule')).ac_schedule?.activeHours?.enabled === false
    ), null, { timeout: 10000 });
    const disableActiveHoursResult = await restartedPopup.evaluate(async () => ({
      success: (await chrome.storage.local.get('ac_schedule')).ac_schedule?.activeHours?.enabled === false
    }));
    const settingsFreshTabs = await restartedWorker.evaluate(() => {
      const listener = globalThis.__AC_E2E_COMFORT_ON_CREATED__;
      if (typeof listener === 'function') chrome.tabs.onCreated.removeListener(listener);
      globalThis.__AC_E2E_COMFORT_ON_CREATED__ = null;
      return Array.isArray(globalThis.__AC_E2E_COMFORT_FRESH_TABS__)
        ? globalThis.__AC_E2E_COMFORT_FRESH_TABS__.map(entry => ({ ...entry }))
        : [];
    });
    const finalSettingsState = await restartedPopup.evaluate(async () => ({
      schedule: (await chrome.storage.local.get('ac_schedule')).ac_schedule,
      automationChecked: document.getElementById('automationToggle')?.checked,
      activeHoursChecked: document.getElementById('activeHoursToggle')?.checked,
      timerPressed: document.getElementById('timerToggle')?.getAttribute('aria-pressed'),
      onValue: document.getElementById('onMinutes')?.value,
      offValue: document.getElementById('offMinutes')?.value,
      status: document.getElementById('status')?.textContent || '',
      pwmAlarm: await chrome.alarms.get('ac-pwm'),
      comfortEndAlarm: await chrome.alarms.get('ac-comfort-end')
    }));
    const settingsSwitchClicks = await settingsHome.evaluate(
      () => globalThis.__acSettingsSwitchClicks
    );
    console.log('  舒适启动新鲜页:', JSON.stringify(comfortFreshTabs));
    console.log('  设置旅程最终状态:', JSON.stringify({
      finalSettingsState,
      settingsFreshTabs,
      settingsSwitchClicks
    }));

    assert(settingsHomeStatus?.isOn === false
        && settingsFixture.enabled === false
        && settingsFixture.onMinutes === 17
        && settingsFixture.offMinutes === 13,
      '设置旅程从真实 OFF 页面与停用的 17/13 循环配置开始');
    assert(smartInteractionState.smartPressed === 'true'
        && smartInteractionState.timerPressed === 'false'
        && sensitivityUpdateResult?.success === true
        && smartInteractionState.sensitivity === '8'
        && smartInteractionState.bubble === '8'
        && smartInteractionState.schedule?.smartMode?.enabled === true
        && smartInteractionState.schedule?.smartMode?.sensitivity === 8,
      'Popup 点击智能控制并释放灵敏度滑块后，DOM 与 storage 同步为 sensitivity=8');
    const smartWeatherAlarmMinute = new Date(
      smartInteractionState.smartWeatherAlarm?.scheduledTime || 0
    ).getMinutes();
    assert(smartInteractionState.smartWeatherAlarm?.scheduledTime > smartInteractionState.observedAt
        && smartInteractionState.smartWeatherAlarm.scheduledTime
          <= smartInteractionState.observedAt + 30 * 60 * 1000 + 1000
        && [20, 50].includes(smartWeatherAlarmMinute),
      '智能控制启用后安排下一个 :20/:50 天气预取闹钟');
    assert(invalidHoursState.validationMessage.length > 0
        && JSON.stringify(invalidHoursState.activeHours) === JSON.stringify(activeHoursBeforeInvalid),
      '运行时段 23:00–08:00 原位报错，非法范围不写入 storage');
    assert(pausedAutomationState.schedule?.enabled === true
        && pausedAutomationState.schedule?.activeHours?.start === excludedHours.start
        && pausedAutomationState.schedule?.activeHours?.end === excludedHours.end
        && pausedAutomationState.snapshot?._insideActiveHours === false
        && pausedAutomationState.snapshot?._automationPausedByActiveHours === true
        && pausedAutomationState.schedule?.comfortStartOnConfirmedAt === 0
        && pausedAutomationState.schedule?.comfortStartUntil === 0
        && !pausedAutomationState.pwmAlarm
        && settingsSwitchClicksAfterComfort === 0
        && comfortFreshTabs.length === 0,
      'Popup 在规范化 24h 时段外启用自动控制：保留 enabled 并暂停运行，不触发舒适启动也不点击 AC');
    assert(pausedAutomationState.activeBoundaryAlarm?.scheduledTime
          > pausedAutomationState.observedAt
        && pausedAutomationState.activeBoundaryAlarm.scheduledTime
          <= pausedAutomationState.observedAt + 24 * 60 * 60 * 1000 + 1000,
      '运行时段启用后安排未来 24 小时内的下一边界闹钟');
    assert(minutesSavedState.result?.success === true
        && minutesSavedState.onMinutes === 21
        && minutesSavedState.offMinutes === 9
        && invalidMinutesState.rawValue === '30'
        && invalidMinutesState.schedule?.onMinutes === 30
        && invalidMinutesState.schedule?.offMinutes === 9,
      '循环分钟数 0 被安全回退为 30 分钟，已保存 21/9 之后输入非法值不崩溃');
    console.log('  停用断言输入:', JSON.stringify({
      disableAutomationResult,
      disableActiveHoursResult,
      finalSettingsState,
      settingsFreshTabs
    }));
    assert(finalSettingsState.schedule?.enabled === false
        && disableAutomationResult?.success === true
        && disableActiveHoursResult?.success === true
        && finalSettingsState.schedule?.activeHours?.enabled === false
        && finalSettingsState.schedule?.smartMode?.enabled === false
        && finalSettingsState.schedule?.comfortStartUntil === 0
        && finalSettingsState.schedule?.comfortStartOnConfirmedAt === 0
        && finalSettingsState.schedule?.onMinutes === 21
        && finalSettingsState.schedule?.offMinutes === 9
        && finalSettingsState.automationChecked === false
        && finalSettingsState.activeHoursChecked === false
        && finalSettingsState.timerPressed === 'true'
        && finalSettingsState.onValue === '21'
        && finalSettingsState.offValue === '9'
        // 停用全程 AC 保持 OFF，不产生页面关机定时器新鲜证明页。
        && settingsFreshTabs.length === 0
        && !finalSettingsState.pwmAlarm
        && !finalSettingsState.comfortEndAlarm
        && finalSettingsState.status.trim().length > 0,
      '非法分钟数不阻止总开关安全停用，最终 Popup 与 storage 回到停用循环 21/9');
    assert(settingsSwitchClicks === 0,
      '全旅程在时段外启用/停用均零真实 AC ON 点击；模式、时段、分钟和停用均零额外点击');

    // === 英文 locale：真实渲染、键盘顺序、帮助与完整诊断复制 ===
    console.log('\n--- 步骤 7: 验证英文 Popup 与键盘/复制旅程 ---\n');
    const englishPopup = await restartedContext.newPage();
    await englishPopup.addInitScript(() => {
      try {
        Object.defineProperty(chrome.i18n, 'getUILanguage', {
          configurable: true,
          value: () => 'en-US'
        });
      } catch (_) {
        try { chrome.i18n.getUILanguage = () => 'en-US'; } catch (_) { /* ignored */ }
      }
      globalThis.__AC_E2E_FULL_DIAGNOSTIC_COPY__ = '';
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => {
              globalThis.__AC_E2E_FULL_DIAGNOSTIC_COPY__ = text;
            }
          }
        });
      } catch (_) { /* clipboard assertion will expose an unsupported override */ }
    });
    await englishPopup.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: 10000,
      waitUntil: 'load'
    });
    const englishReady = await englishPopup.waitForFunction(({ expectedTimer, expectedSmart }) => (
      document.documentElement.lang === 'en'
      && document.getElementById('pwmSettingsTitle')?.textContent?.trim() === expectedTimer
      && document.getElementById('smartModeTitle')?.textContent?.trim() === expectedSmart
    ), {
      expectedTimer: en.pwmSettings.message,
      expectedSmart: en.smartModeLabel.message
    }, { timeout: 10000 })
      .then(() => true).catch(() => false);
    const englishLayout = await englishPopup.evaluate(() => ({
      lang: document.documentElement.lang,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      shellWidth: document.getElementById('appShell')?.getBoundingClientRect().width || 0,
      shellClientWidth: document.getElementById('appShell')?.clientWidth || 0,
      shellScrollWidth: document.getElementById('appShell')?.scrollWidth || 0,
      timerLabel: document.getElementById('pwmSettingsTitle')?.textContent?.trim() || '',
      smartLabel: document.getElementById('smartModeTitle')?.textContent?.trim() || '',
      startType: document.getElementById('activeHoursStart')?.type || '',
      startValue: document.getElementById('activeHoursStart')?.value || '',
      helpHref: document.getElementById('helpLink')?.href || ''
    }));
    await englishPopup.evaluate(() => document.activeElement?.blur?.());
    const englishTabOrder = [];
    for (let index = 0; index < 12; index++) {
      await englishPopup.keyboard.press('Tab');
      englishTabOrder.push(await englishPopup.evaluate(() => document.activeElement?.id || ''));
    }
    await englishPopup.click('#btnDiagnose', { timeout: 5000 });
    await englishPopup.waitForFunction(() => (
      document.getElementById('btnDiagnose')?.disabled === false
      && (document.getElementById('diagnoseResult')?.innerText || '').length > 100
    ), null, { timeout: 20000 });
    await englishPopup.click('#btnCopyDiag', { timeout: 5000 });
    await englishPopup.waitForFunction(() => (
      globalThis.__AC_E2E_FULL_DIAGNOSTIC_COPY__?.startsWith('```')
    ), null, { timeout: 5000 }).catch(() => {});
    const englishDiagnostic = await englishPopup.evaluate(() => ({
      text: document.getElementById('diagnoseResult')?.innerText || '',
      copied: globalThis.__AC_E2E_FULL_DIAGNOSTIC_COPY__ || '',
      copyVisible: document.getElementById('btnCopyDiag')?.hidden === false
    }));

    console.log('  英文布局状态:', JSON.stringify({ englishReady, englishLayout }));
    assert(englishReady
        && englishLayout.lang === 'en'
        && englishLayout.shellWidth === 280
        && englishLayout.shellScrollWidth <= englishLayout.shellClientWidth + 1
        && englishLayout.timerLabel === en.pwmSettings.message
        && englishLayout.smartLabel === en.smartModeLabel.message
        && englishLayout.startType === 'text'
        && /^\d{2}:\d{2}$/.test(englishLayout.startValue),
      '英文 Popup 使用 280px 无横向溢出，并保持单焦点 24h HH:mm 字段');
    assert(['helpLink', 'automationToggle', 'activeHoursToggle', 'timerToggle',
      'smartModeToggle', 'onMinutes', 'offMinutes', 'btnDiagnose']
      .every(id => englishTabOrder.includes(id))
        && englishTabOrder.indexOf('timerToggle') < englishTabOrder.indexOf('smartModeToggle'),
      '英文 Popup 键盘顺序可到达帮助、总开关、时段、两种模式、分钟数与诊断');
    const englishSummaryPrefix = en.diagnoseTime.message;
    assert(englishLayout.helpHref === 'https://github.com/BelugaRex/ac-ust/issues/new/choose'
        && englishDiagnostic.copyVisible
        && englishDiagnostic.text.includes(englishSummaryPrefix)
        && englishDiagnostic.copied.startsWith('```')
        && englishDiagnostic.copied.includes(englishSummaryPrefix),
      '英文帮助链接准确，完整诊断可一键复制为 Markdown');

    await englishPopup.close();
    await settingsHome.close();

    // 汇总
    const passCount = results.filter(r => r.pass).length;
    console.log(`\n=== 测试汇总: ${passCount}/${results.length} 通过 ===`);
    if (passCount !== results.length) {
      console.log('\n失败项:');
      results.filter(r => !r.pass).forEach(r => console.log('  - ' + r.name));
      process.exitCode = 1;
    } else {
      console.log(`\n✅ 所有断言通过 — v${manifest.version} 已覆盖设置、页面控制、诊断恢复、智能控制与天气数据链。`);
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
