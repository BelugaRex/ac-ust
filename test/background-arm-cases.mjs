import fs from 'node:fs';
import assert from 'node:assert/strict';

export async function runBackgroundArmCases(assertPass) {
  const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const section = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `missing source: ${start}`);
    return source.slice(first, last);
  };
  const armSource = section('async function armPowerOffTimerEnsuringOn(', '// ----- 闹钟触发时执行 -----');
  const fixedTargetAt = Math.ceil((Date.now() + 600000) / 60000) * 60000;
  const makeHarness = ({ supplement = false, failOn = false, throwOn = false, missingId = false } = {}) => {
    const calls = [];
    let on = false;
    const proof = { success: true, value: '12:10', acIsOn: true };
    const toggle = async (action, options) => {
      calls.push(['on', action, options]);
      assert.equal(options.controlTabId, 42);
      assert.equal(options.notAfterAt, fixedTargetAt);
      assert.equal(calls.some(c => c[0] === 'cleanup'), false, 'must retain tab while ON is pending');
      if (throwOn) throw new Error('transport failed');
      on = !failOn;
      return { success: on, error: on ? '' : 'Execution succeeded not observed' };
    };
    const arm = new Function('setPageTimer', 'getCurrentACStatus', 'toggleAC',
      'verifyPageTimerPersistence', 'sleep', 'chrome', `${armSource}; return armPowerOffTimerEnsuringOn;`
    )(
      async (minutes, options) => {
        calls.push(['write', options]);
        if (!options.deferVerification) {
          assert.equal(options.targetAt, fixedTargetAt, 'supplement must not recompute default target');
          return { success: true, value: '12:10', targetAt: fixedTargetAt, verification: proof };
        }
        return { success: true, value: '12:10', targetAt: fixedTargetAt,
          ...(missingId ? {} : { controlTabId: 42 }) };
      },
      async tabId => { assert.equal(tabId, 42); calls.push(['status', tabId]); return { isOn: on }; },
      toggle,
      async (_value, options) => {
        assert.equal(options.notAfterAt, fixedTargetAt);
        assert.equal(calls.some(c => c[0] === 'cleanup'), false, 'must retain tab during verification');
        calls.push(['verify']);
        return supplement ? { success: false, acIsOn: true } : proof;
      },
      async () => {},
      { alarms: { create: async (name, options) => { calls.push(['cleanup', name, options]); } } }
    );
    return { arm, calls, toggle, proof };
  };

  for (const useHook of [false, true]) {
    const h = makeHarness();
    const result = await h.arm(10, useHook ? {
      ensureOn: (notAfterAt, controlTabId) => h.toggle('on', { notAfterAt, controlTabId })
    } : {});
    assertPass(result.success && h.calls.at(-1)[0] === 'cleanup'
      && h.calls.at(-1)[1] === 'ac-close-tab-42'
      && h.calls.at(-1)[2].delayInMinutes === 1,
    `background arm: ${useHook ? 'PWM hook' : 'Smart'} uses owned tab until verification completes`);
  }
  const supplemented = makeHarness({ supplement: true });
  const supplementedResult = await supplemented.arm(10);
  assertPass(supplementedResult.success && supplementedResult.supplemented
    && supplementedResult.targetAt === fixedTargetAt
    && supplementedResult.verification === supplemented.proof,
  'background arm: default target remains fixed across supplement and returns the successful proof');

  const failed = makeHarness({ failOn: true });
  const failedResult = await failed.arm(10);
  assertPass(!failedResult.success && failedResult.failureStage === 'ensure-on'
    && failed.calls.filter(c => c[0] === 'on').length === 1
    && !failed.calls.some(c => c[0] === 'verify') && failed.calls.at(-1)[0] === 'cleanup',
  'background arm: unconfirmed ON does not verify, retry a click, or leak its tab');

  const thrown = makeHarness({ throwOn: true });
  await assert.rejects(() => thrown.arm(10), /transport failed/);
  assertPass(thrown.calls.at(-1)[0] === 'cleanup', 'background arm: exception still releases owned tab');
  const missing = makeHarness({ missingId: true });
  const missingResult = await missing.arm(10);
  assertPass(!missingResult.success && missing.calls.length === 1,
    'background arm: missing control tab cannot fall back to a user tab');

  const toggleSource = section('async function toggleACOnce(', 'async function _toggleOnExistingTab(');
  for (const tab of [null, { id: 42, discarded: true }, { id: 42, discarded: false }]) {
    let dispatched = null;
    const toggleOnce = new Function('getExactACHomeTab', 'waitUntil', '_toggleOnExistingTab',
      `${toggleSource}; return toggleACOnce;`)(
      async id => { assert.equal(id, 42); return tab; }, p => p,
      async target => { dispatched = target.id; return { success: true }; }
    );
    const result = await toggleOnce('on', { controlTabId: 42 });
    assertPass(result.success === !!(tab && !tab.discarded)
      && dispatched === (result.success ? 42 : null),
    `background arm: owned tab ${tab ? (tab.discarded ? 'discarded' : 'ready') : 'closed/drifted'} never queries or creates a replacement`);
  }

  const statusSource = section('async function getCurrentACStatus(', 'async function getCurrentPageTimer(');
  const home = 'https://w5.ab.ust.hk/njggt/app/home';
  for (const tab of [null, { id: 42, url: home, discarded: true }, { id: 42, url: home }]) {
    const reads = [];
    const status = new Function('getExactACHomeTab', 'isACHomePageTab', 'sendReadMessageToExactACHome',
      `${statusSource}; return getCurrentACStatus;`)(
      async id => { assert.equal(id, 42); return tab; }, candidate => candidate?.url === home,
      async id => { reads.push(id); return { isOn: true }; }
    );
    const result = await status(42);
    assertPass(reads.length === (tab && !tab.discarded ? 1 : 0)
      && result.isOn === (reads.length ? true : null),
    'background arm: owned status reads only its valid page, never a stale user page');
  }
}