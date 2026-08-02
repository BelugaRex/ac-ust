// Pure helpers for reading AC balance minutes and estimating when they run out.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  function parseBalanceMinutes(...values) {
    for (const value of values) {
      const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*min(?:ute)?s?$/i);
      if (!match) continue;
      const minutes = Number(match[1]);
      if (Number.isFinite(minutes) && minutes >= 0) return minutes;
    }
    return null;
  }

  function estimateBalanceExhaustion({ balanceMinutes, onMinutes, offMinutes, now = Date.now() } = {}) {
    const balance = Number(balanceMinutes);
    const on = Number(onMinutes);
    const off = Number(offMinutes);
    const nowMs = Number(now);

    if (!Number.isFinite(balance) || balance < 0
        || !Number.isFinite(on) || on <= 0
        || !Number.isFinite(off) || off <= 0
        || !Number.isFinite(nowMs) || nowMs < 0) {
      return null;
    }

    const dutyCycle = on / (on + off);
    const usableWallMinutes = balance / dutyCycle;
    const estimatedAt = nowMs + usableWallMinutes * 60000;
    const displayDate = new Date(estimatedAt);
    displayDate.setMinutes(0, 0, 0);

    return {
      estimated: true,
      dutyCycle,
      usableWallMinutes,
      estimatedAt,
      displayAt: displayDate.getTime()
    };
  }

  return { parseBalanceMinutes, estimateBalanceExhaustion };
});