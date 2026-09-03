const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const manifest = require('../manifest.json');

const EXT_PATH = path.resolve(__dirname, '..', 'dist');
const PROFILE_ROOT = path.resolve(__dirname, '..', '.test-profile');
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

async function waitForServiceWorker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  const serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10000 })
    .catch(() => null);
  if (!serviceWorker) throw new Error('未找到扩展 Service Worker');
  return serviceWorker;
}

async function launchExtension(profileDir) {
  let lastError = null;
  for (const launchOptions of LAUNCH_OPTIONS) {
    let context = null;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        ...launchOptions,
        args: LAUNCH_ARGS
      });
      const serviceWorker = await waitForServiceWorker(context);
      return { context, serviceWorker, launchOptions };
    } catch (error) {
      lastError = error;
      if (context) await context.close().catch(() => {});
    }
  }
  const error = new Error('所有浏览器启动方式都失败');
  error.cause = lastError;
  throw error;
}

async function waitForWorkerInit(serviceWorker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await serviceWorker.evaluate(() => (
      typeof initCompletedAt === 'number' && initCompletedAt > 0
    )).catch(() => false);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Service Worker 初始化未在 15 秒内完成');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function run() {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, 'e2e-background-repair-'));
  let context = null;
  const results = [];
  const assert = (condition, name) => {
    const pass = !!condition;
    results.push({ name, pass });
    console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
  };

  try {
    const launched = await launchExtension(profileDir);
    context = launched.context;
    const serviceWorker = launched.serviceWorker;
    await waitForWorkerInit(serviceWorker);

    const workerConsole = [];
    serviceWorker.on('console', message => {
      workerConsole.push({ type: message.type(), text: message.text() });
    });
    await serviceWorker.evaluate(() => {
      globalThis.__AC_E2E_WORKER_ERRORS__ = [];
      addEventListener('error', event => {
        globalThis.__AC_E2E_WORKER_ERRORS__.push({
          type: 'error',
          message: event?.message || ''
        });
      });
      addEventListener('unhandledrejection', event => {
        globalThis.__AC_E2E_WORKER_ERRORS__.push({
          type: 'unhandledrejection',
          message: event?.reason?.message || String(event?.reason || '')
        });
      });
    });

    const extensionId = serviceWorker.url().split('/')[2];
    const expectedBackgroundHash = sha256(path.join(EXT_PATH, 'background.js'));
    const workerIdentity = await serviceWorker.evaluate(async () => {
      const source = await fetch(chrome.runtime.getURL('background.js')).then(response => response.text());
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return {
        version: chrome.runtime.getManifest().version,
        backgroundHash: [...new Uint8Array(digest)]
          .map(value => value.toString(16).padStart(2, '0'))
          .join('')
      };
    });

    await context.route('https://w5.ab.ust.hk/njggt/app/home', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><div><small>Air Conditioning Status</small><button class="ant-switch" role="switch" aria-checked="false">OFF</button></div><div><small>Power-off after</small><div class="ant-picker"><input readonly value="" title=""></div></div></body></html>'
    }));
    const acPage = await context.newPage();
    await acPage.goto('https://w5.ab.ust.hk/njggt/app/home', {
      timeout: 10000,
      waitUntil: 'load'
    });

    let homeStatus = null;
    const homeDeadline = Date.now() + 8000;
    while (Date.now() < homeDeadline) {
      homeStatus = await serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://w5.ab.ust.hk/njggt/app/home' });
        const tab = tabs.find(candidate => !candidate.discarded);
        if (!tab?.id) return null;
        try {
          return await chrome.tabs.sendMessage(tab.id, { action: 'status' });
        } catch (_) {
          return null;
        }
      });
      if (homeStatus?.isOn === false) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const fixture = await serviceWorker.evaluate(async () => {
      const now = Date.now();
      const plannedAt = now - 2 * 60_000;
      const candidateDate = new Date(now + 8 * 60_000);
      candidateDate.setSeconds(15, 0);
      if (candidateDate.getMinutes() === 0 || candidateDate.getMinutes() === 30) {
        candidateDate.setMinutes(candidateDate.getMinutes() + 2);
      }
      const candidateAt = candidateDate.getTime();
      const testSchedule = {
        enabled: true,
        mode: 'pwm',
        clockMode: false,
        onMinutes: 20,
        offMinutes: 10,
        pwmState: 'on',
        smartState: 'on',
        nextTriggerAt: candidateAt,
        smartClockPlannedAt: plannedAt,
        alarmCreatedAt: plannedAt,
        alarmDelayMinutes: (candidateAt - plannedAt) / 60_000,
        pageTimerMinutes: null,
        pageTimerTargetAt: 0,
        pageTimerError: '',
        pageTimerRetryAt: 0,
        pageTimerRetryMinutes: 0,
        pwmRetryKind: '',
        pwmRetryBoundaryAt: 0,
        pwmRetryScheduledAt: 0,
        activeHours: { enabled: false, start: '08:00', end: '23:00' },
        smartMode: { enabled: true, sensitivity: 10 }
      };
      await Promise.all([
        chrome.alarms.clear('ac-pwm'),
        chrome.alarms.clear('ac-badge-tick'),
        chrome.alarms.clear('ac-watchdog'),
        chrome.alarms.clear('ac-smart-weather'),
        chrome.storage.local.remove('ac_diagnostic_log')
      ]);
      await chrome.storage.local.set({ ac_schedule: testSchedule });
      await loadScheduleFromStorage();
      await chrome.alarms.create('ac-pwm', { when: candidateAt });
      const recoveryPlan = planPwmLifecycleRecovery(schedule, {
        now,
        smartClockPlannedAt: plannedAt,
        plannedActionAt: candidateAt,
        liveAlarmAt: candidateAt,
        storedAlarmAt: candidateAt,
        smartBoundaryToleranceMs: 1500,
        requireSmartClockPlannedAt: true,
        missingClockAction: 'repair-clock',
        maxOnMinutes: 0
      });
      return { now, plannedAt, candidateAt, recoveryPlan };
    });

    const senderPage = await context.newPage();
    await senderPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: 10000,
      waitUntil: 'load'
    });
    const consoleStart = workerConsole.length;
    const response = await senderPage.evaluate(() => (
      chrome.runtime.sendMessage({ type: 'ensureDiagnostics' })
    ));
    await new Promise(resolve => setTimeout(resolve, 500));

    const finalState = await serviceWorker.evaluate(async () => {
      const local = await chrome.storage.local.get(['ac_schedule', 'ac_diagnostic_log']);
      const pwmAlarm = await chrome.alarms.get('ac-pwm');
      return {
        schedule: local.ac_schedule,
        diagnosticLog: Array.isArray(local.ac_diagnostic_log)
          ? local.ac_diagnostic_log
          : [],
        pwmAlarm: pwmAlarm ? { scheduledTime: pwmAlarm.scheduledTime } : null,
        workerErrors: Array.isArray(globalThis.__AC_E2E_WORKER_ERRORS__)
          ? globalThis.__AC_E2E_WORKER_ERRORS__
          : []
      };
    });
    const targetConsole = workerConsole.slice(consoleStart);
    const assignmentEvidence = JSON.stringify({
      responseError: response?.error || '',
      workerConsole: targetConsole,
      workerErrors: finalState.workerErrors,
      diagnosticLog: finalState.diagnosticLog
        .filter(entry => entry?.source === 'message-ensureDiagnostics')
    });

    console.log('浏览器启动参数:', JSON.stringify(launched.launchOptions));
    console.log('Worker 身份:', JSON.stringify(workerIdentity));
    console.log('修复前 recovery plan:', JSON.stringify(fixture.recoveryPlan));
    console.log('ensureDiagnostics 响应:', JSON.stringify({
      success: response?.success,
      repaired: response?.repaired,
      repairs: response?.repairs,
      error: response?.error || ''
    }));
    console.log('修复后 PWM:', JSON.stringify({
      pwmState: finalState.schedule?.pwmState,
      nextTriggerAt: finalState.schedule?.nextTriggerAt,
      alarmScheduledTime: finalState.pwmAlarm?.scheduledTime || 0
    }));
    console.log('异常证据:', assignmentEvidence);

    assert(workerIdentity.version === manifest.version
        && workerIdentity.backgroundHash === expectedBackgroundHash,
      '实际运行的 Service Worker 与 dist/background.js 版本及字节哈希一致');
    assert(homeStatus?.isOn === false,
      '真实 content script 从精确 AC home fixture 确认冷气为 OFF');
    assert(fixture.recoveryPlan?.kind === 'repair-clock',
      '夹具稳定进入智能 ON 不可信时钟 repair-clock 分支');
    assert(response?.success === true
        && response?.repaired === true
        && response?.repairs?.includes('smart-clock')
        && !response?.error,
      '扩展页面发送 ensureDiagnostics 后 Worker 完成智能 ON 时钟修复');
    assert(finalState.pwmAlarm?.scheduledTime > Date.now()
        && Math.abs(finalState.pwmAlarm.scheduledTime - finalState.schedule?.nextTriggerAt) <= 1500
        && finalState.schedule?.pwmState === 'on',
      '修复后 live ac-pwm、storage nextTriggerAt 与 ON 相位重新对齐');
    assert(!assignmentEvidence.includes('Assignment to constant variable')
        && !finalState.diagnosticLog.some(entry => (
          entry?.source === 'message-ensureDiagnostics' && entry?.level === 'error'
        )),
      'Worker console、error、response 与诊断日志均无常量重赋值异常');

    const passCount = results.filter(result => result.pass).length;
    console.log(`测试汇总: ${passCount}/${results.length} 通过`);
    if (passCount !== results.length) process.exitCode = 1;

    await senderPage.close();
    await acPage.close();
  } finally {
    if (context) await context.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error('聚焦扩展 E2E 执行异常:', error);
  process.exit(2);
});