// 使用用户提供的真实 picker DOM，测试实际 content.js 的键入与 OK 提交。
// 页面服务与 Chrome 消息桥使用本地 fixture；不连接 UST、不操作真实空调。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.resolve(process.argv[2] || path.join(root, 'content.js'));
const dropdownHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures/power-off-after-dropdown.html'), 'utf8'
);
const homeUrl = 'https://w5.ab.ust.hk/njggt/app/home';
const cases = [
  { name: '已展开且无 id 的真实下拉层复用后点击 OK', alreadyOpen: true },
  { name: '键入完成后等待 OK 启用', enableDelay: 250 },
  { name: '短暂重叠的下拉层消失后只点击当前 OK', overlap: true },
  { name: '等待 OK 时输入框替换，重新绑定 live input', enableDelay: 250, replaceInput: true },
  { name: '多个无法关联的下拉层拒绝提交', overlap: true, persistentOverlap: true, failure: 'select-ok' },
  { name: 'OK 一直禁用时明确失败', neverEnable: true, failure: 'select-ok' },
  { name: 'OK 未关闭选择器时不能伪报保存成功', stayOpen: true, failure: 'confirm-stable' }
];

async function runCase(browser, options) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>'
    }));
    await page.goto(homeUrl);
    await page.evaluate(({ dropdownHtml, options }) => {
      document.body.innerHTML = `<div class="timer-row"><small>Power-off after</small>
        <div class="ant-picker"><input readonly placeholder="Select time" value="00:51" title="00:51"></div></div>` + dropdownHtml;
      const dropdown = document.querySelector('.ant-picker-dropdown');
      dropdown.removeAttribute('style');
      const button = dropdown.querySelector('.ant-picker-ok button');
      const inputSelector = '.timer-row .ant-picker input';
      const state = { clicks: 0, cells: 0, enter: 0, drafts: [], submitted: '', changedAt: 0, clickedAt: 0 };
      globalThis.__pickerTestState = state;
      globalThis.chrome = {
        i18n: { getUILanguage: () => 'zh_CN' },
        runtime: {
          getURL: value => value,
          sendMessage: async () => ({}),
          onMessage: {
            addListener: listener => { globalThis.__pickerTestListener = listener; },
            removeListener() {}
          }
        }
      };
      globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
      const open = () => {
        dropdown.hidden = false;
        dropdown.classList.remove('ant-picker-dropdown-hidden');
        document.querySelector(inputSelector).setAttribute('aria-expanded', 'true');
      };
      const installInput = input => {
        input.addEventListener('mousedown', open);
        input.addEventListener('click', open);
        input.addEventListener('input', () => state.drafts.push(input.value));
        input.addEventListener('keydown', event => {
          // 本次现场的 Escape 并未可靠关闭已展开的无 id dropdown。
          if (event.key === 'Enter') {
            state.enter += 1;
            input.value = '00:51';
          }
        });
        input.addEventListener('change', () => {
          state.changedAt = Date.now();
          if (options.replaceInput) setTimeout(() => {
            const live = document.querySelector(inputSelector);
            const replacement = live.cloneNode(true);
            replacement.value = live.value;
            installInput(replacement);
            live.replaceWith(replacement);
          }, 80);
          if (options.enableDelay) setTimeout(() => { button.disabled = false; }, options.enableDelay);
          if (options.overlap && !document.getElementById('overlap-layer')) {
            const overlap = dropdown.cloneNode(true);
            overlap.id = 'overlap-layer';
            document.body.appendChild(overlap);
            if (!options.persistentOverlap) setTimeout(() => overlap.remove(), 250);
          }
        });
      };
      const input = document.querySelector(inputSelector);
      installInput(input);
      dropdown.hidden = !options.alreadyOpen;
      input.setAttribute('aria-expanded', options.alreadyOpen ? 'true' : 'false');
      button.disabled = !!(options.enableDelay || options.neverEnable);
      dropdown.querySelectorAll('.ant-picker-time-panel-cell').forEach(cell => {
        cell.addEventListener('click', () => {
          state.cells += 1;
          document.querySelector(inputSelector).value = '00:51';
        });
      });
      button.addEventListener('click', () => {
        state.clicks += 1;
        state.clickedAt = Date.now();
        const live = document.querySelector(inputSelector);
        state.submitted = live.value;
        live.setAttribute('title', live.value);
        live.setAttribute('readonly', '');
        if (!options.stayOpen) {
          dropdown.hidden = true;
          dropdown.classList.add('ant-picker-dropdown-hidden');
          live.setAttribute('aria-expanded', 'false');
        }
      });
    }, { dropdownHtml, options });
    await page.addScriptTag({ path: sourcePath });
    const targetAt = Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000;
    const result = await page.evaluate(targetAt => new Promise(resolve => {
      globalThis.__pickerTestListener({ action: 'setTimer', minutes: 10, targetAt }, {}, resolve);
    }), targetAt);
    const state = await page.evaluate(() => ({
      ...globalThis.__pickerTestState,
      expanded: document.querySelector('.timer-row input').getAttribute('aria-expanded')
    }));
    assert.equal(state.enter, 0, '保存时不能派发 Enter');
    assert.equal(state.cells, 0, '键入后不能再点时间格覆盖输入');
    if (options.failure) {
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.failureStage, options.failure, JSON.stringify(result));
      if (!options.stayOpen) assert.equal(state.clicks, 0, '未唯一确认按钮不能点击');
    } else {
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(state.clicks, 1, '必须实际点击一次 OK');
      assert.equal(state.submitted, result.value, 'OK 保存的必须是刚键入的时刻');
      assert.equal(state.expanded, 'false', '保存后选择器必须关闭');
      if (options.enableDelay) assert.ok(state.clickedAt - state.changedAt >= options.enableDelay);
    }
    console.log(`PASS ${options.name}`);
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  try {
    for (const options of cases) {
      try {
        await runCase(browser, options);
        passed += 1;
      } catch (error) {
        console.error(`FAIL ${options.name}: ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Picker OK: ${passed}/${cases.length}`);
  if (passed !== cases.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
