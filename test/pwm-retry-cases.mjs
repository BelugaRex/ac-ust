import pwmRetry from '../pwm-retry.js';

const {
  PWM_RETRY_KINDS,
  getPwmRetryDescriptor,
  normalizePwmRetryKind
} = pwmRetry;

export function runPwmRetryCases(assertPass) {
  assertPass(
    Object.keys(pwmRetry).sort().join(',')
      === 'PWM_RETRY_KINDS,getPwmRetryDescriptor,normalizePwmRetryKind'
      && Object.isFrozen(pwmRetry)
      && Object.isFrozen(PWM_RETRY_KINDS),
    'PWM retry module 只导出冻结的 kind、descriptor lookup 与 normalize 接口'
  );

  const pageTimer = getPwmRetryDescriptor(PWM_RETRY_KINDS.PAGE_TIMER);
  const toggle = getPwmRetryDescriptor(PWM_RETRY_KINDS.TOGGLE);
  assertPass(
    pageTimer?.kind === PWM_RETRY_KINDS.PAGE_TIMER
      && pageTimer.requiresPageTimer === true
      && pageTimer.presentation === 'page-timer-retry'
      && toggle?.kind === PWM_RETRY_KINDS.TOGGLE
      && toggle.requiresPageTimer === false
      && toggle.presentation === 'toggle-retry',
    'PWM retry 只描述页面定时器与普通切换失败，不携带 Smart 语义'
  );
  assertPass(
    getPwmRetryDescriptor('') === null
      && getPwmRetryDescriptor('unknown') === null
      && getPwmRetryDescriptor('constructor') === null
      && getPwmRetryDescriptor('toString') === null
      && getPwmRetryDescriptor('__proto__') === null
      && normalizePwmRetryKind(PWM_RETRY_KINDS.PAGE_TIMER)
        === PWM_RETRY_KINDS.PAGE_TIMER
      && normalizePwmRetryKind('unknown') === PWM_RETRY_KINDS.PAGE_TIMER
      && normalizePwmRetryKind('unknown', PWM_RETRY_KINDS.TOGGLE)
        === PWM_RETRY_KINDS.TOGGLE,
    '未知 retry kind 不被识别；写入归一化保留兼容 fallback'
  );
  assertPass(
    [pageTimer, toggle].every(Object.isFrozen),
    '所有 retry descriptor 都是不可变值'
  );
}
