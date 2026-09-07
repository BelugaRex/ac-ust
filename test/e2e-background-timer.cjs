// Isolated MV3 regression. All HTTP traffic is fulfilled locally; no UST account or AC.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const extensionPath = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const home = 'https://w5.ab.ust.hk/njggt/app/home';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-background-timer-'));
let context;
let browser;
let browserProcess;
let storedValue = '';
let rejectOk = false;
let pageNumber = 0;
const submissions = [];
let passed = 0;
let skipped = 0;

function homeFixture() {
  const id = ++pageNumber;
  return `<!doctype html><html><body>
    <div><small>Air Conditioning Status</small><button class="ant-switch" role="switch" aria-checked="true">ON</button></div>
    <div><small>Power-off after</small><div class="ant-picker"><input readonly placeholder="Select time" value="${storedValue}" title="${storedValue}" aria-expanded="false"></div></div>
    <div class="ant-picker-dropdown" hidden><div class="ant-picker-ok"><button disabled>OK</button></div></div>
    <script>
      const input = document.querySelector('input');
      const dropdown = document.querySelector('.ant-picker-dropdown');
      const ok = document.querySelector('.ant-picker-ok button');
      const open = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
      input.addEventListener('mousedown', open);
      input.addEventListener('click', open);
      input.addEventListener('change', () => setTimeout(() => { ok.disabled = ${rejectOk}; }, 250));
      ok.addEventListener('click', async () => {
        const value = input.value;
        await fetch('/__fixture_save', { method: 'POST', body: JSON.stringify({
          id: ${id}, value, hidden: document.hidden, focused: document.hasFocus()
        }) });
        input.setAttribute('title', value);
        dropdown.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      });
    </script></body></html>`;
}

async function snapshot(worker) {
  return worker.evaluate(async () => ({
    windows: (await chrome.windows.getAll()).map(({ id, focused, state }) => ({ id, focused, state })),
    active: (await chrome.tabs.query({ active: true })).map(tab => tab.id)
  }));
}

async function run() {
  try {
    // launchPersistentContext forces focus emulation even without throttling flags.
    // A raw isolated browser + noDefaults CDP connection keeps native visibility.
    browserProcess = spawn(chromium.executablePath(), [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      'about:blank'
    ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let launchError = '';
    browserProcess.stderr.on('data', data => { launchError = (launchError + data).slice(-2000); });
    browserProcess.on('error', error => { launchError = error.message; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    const launchDeadline = Date.now() + 15000;
    while (!fs.existsSync(portFile) && Date.now() < launchDeadline
        && browserProcess.exitCode === null) await delay(100);
    assert.ok(fs.existsSync(portFile), `browser did not start: ${launchError}`);
    const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { noDefaults: true });
    context = browser.contexts()[0];
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.url() === home) {
        return route.fulfill({ contentType: 'text/html', body: homeFixture() });
      }
      if (request.url() === 'https://w5.ab.ust.hk/__fixture_save') {
        const data = JSON.parse(request.postData());
        submissions.push(data);
        storedValue = data.value;
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<input id="work" value="keep my draft">' });
    });
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent('serviceworker', { timeout: 15000 });
    await worker.evaluate(async () => { await initReady; });
    const identity = await worker.evaluate(async () => {
      const source = await fetch(chrome.runtime.getURL('background.js')).then(r => r.text());
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    });
    assert.equal(identity, crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(extensionPath, 'background.js'))).digest('hex'));

    await worker.evaluate(() => {
      const create = chrome.tabs.create.bind(chrome.tabs);
      const update = chrome.tabs.update.bind(chrome.tabs);
      // Playwright cannot route a new extension-created target's first navigation.
      // Attach on a local resource first, then route home; never activate the target.
      chrome.tabs.create = async options => {
        if (options.url !== 'https://w5.ab.ust.hk/njggt/app/home' || options.active !== false) {
          throw new Error('unexpected production tab creation');
        }
        const seed = chrome.runtime.getURL('manifest.json');
        const tab = await create({ ...options, url: seed });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const current = await chrome.tabs.get(tab.id);
          if (current.status === 'complete' && current.url === seed) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        return update(tab.id, { url: options.url, active: false });
      };
    });

    const userHome = await context.newPage();
    await userHome.goto(home);
    const userValue = await userHome.locator('input').inputValue();
    const work = await context.newPage();
    await work.goto('https://example.test/');
    await work.locator('#work').focus();
    await work.evaluate(() => document.querySelector('#work').setSelectionRange(5, 9));
    await work.bringToFront();

    for (const scenario of ['other-tab', 'minimized', 'rejected-ok']) {
      rejectOk = scenario === 'rejected-ok';
      storedValue = '';
      const firstNewPage = pageNumber + 1;
      const submitStart = submissions.length;
      // Test setup only; not production behavior. Never touches the user's browser profile.
      await worker.evaluate(async minimized => {
        const [window] = await chrome.windows.getAll();
        await chrome.windows.update(window.id, { state: minimized ? 'minimized' : 'normal' });
        globalThis.__focusCalls = [];
        if (!globalThis.__originalWindowUpdate) {
          globalThis.__originalWindowUpdate = chrome.windows.update.bind(chrome.windows);
          globalThis.__originalTabUpdate = chrome.tabs.update.bind(chrome.tabs);
          chrome.windows.update = (...args) => {
            __focusCalls.push(['window', ...args]);
            return __originalWindowUpdate(...args);
          };
          chrome.tabs.update = (...args) => {
            __focusCalls.push(['tab', ...args]);
            return __originalTabUpdate(...args);
          };
        }
      }, scenario === 'minimized');
      const before = await snapshot(worker);
      if (scenario === 'minimized' && before.windows[0].state !== 'minimized') {
        skipped += 1;
        console.log('SKIP minimized: display server did not minimize the window (window manager required)');
        continue;
      }
      const targetAt = Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000;
      const result = await worker.evaluate(targetAt => setPageTimer(10, {
        targetAt, retryOnFailure: false
      }), targetAt);
      const after = await snapshot(worker);
      const calls = await worker.evaluate(() => __focusCalls);
      assert.deepEqual(calls, [], 'production must not activate or restore tabs/windows');
      assert.deepEqual(after, before, 'active tabs and window state/focus must not change');
      assert.equal(await userHome.locator('input').inputValue(), userValue, 'user home must not be typed into');
      const draft = await work.evaluate(() => {
        const input = document.querySelector('#work');
        return [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input];
      });
      assert.deepEqual(draft, ['keep my draft', 5, 9, true]);
      if (rejectOk) {
        assert.equal(result.success, false);
        assert.equal(result.failureStage, 'select-ok');
        assert.equal(submissions.length, submitStart);
      } else {
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.verified, true, JSON.stringify(result));
        assert.equal(result.targetAt, targetAt);
        assert.equal(storedValue, result.value);
        assert.ok(pageNumber > firstNewPage, 'must verify in a separately loaded page');
        assert.equal(submissions.length, submitStart + 1);
        assert.ok(submissions.slice(submitStart).every(s => s.id === firstNewPage && s.hidden && !s.focused));
      }
      passed += 1;
      console.log(`PASS ${scenario}: success=${result.success}, hidden submissions=${submissions.length - submitStart}, focus calls=${calls.length}`);
    }
    console.log(`Background timer E2E: ${passed}/${3 - skipped}; skipped=${skipped}; real extension hash verified; local fixtures only`);
  } finally {
    if (context) await context.unrouteAll({ behavior: 'ignoreErrors' });
    if (browser) await browser.close();
    if (browserProcess?.pid && browserProcess.exitCode === null) {
      const exited = new Promise(resolve => browserProcess.once('exit', resolve));
      try { process.kill(-browserProcess.pid, 'SIGTERM'); } catch (_) { /* already exited */ }
      await exited;
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });