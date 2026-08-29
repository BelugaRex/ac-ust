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

  const smartOn = getPwmRetryDescriptor(PWM_RETRY_KINDS.SMART_ON);
  const safeDelay = getPwmRetryDescriptor(PWM_RETRY_KINDS.SMART_ON_SAFE_DELAY);
  const safetySkip = getPwmRetryDescriptor(PWM_RETRY_KINDS.SMART_ON_SAFETY_SKIP);
  const safetyTimer = getPwmRetryDescriptor(PWM_RETRY_KINDS.SMART_ON_SAFETY_TIMER);
  assertPass(
    smartOn?.storedSmartOnRetry === true
      && smartOn.ownsTypedSmartOn === true
      && smartOn.boundaryRequired === true
      && smartOn.reevaluatesAtNextBoundary === false
      && smartOn.syncProjection === 'safety-sentinel'
      && safeDelay?.ownsTypedSmartOn === true
      && safeDelay.presentation === 'smart-safe-delay'
      && safeDelay.presentationAlways === false,
    '普通与 safe-delay retry 共享 typed ON ownership，并保留不同展示语义'
  );
  assertPass(
    safetySkip?.storedSmartOnRetry === false
      && safetySkip.ownsTypedSmartOn === false
      && safetySkip.boundaryRequired === true
      && safetySkip.reevaluatesAtNextBoundary === true
      && safetySkip.syncProjection === 'safety-sentinel'
      && safetySkip.diagnosticStatus === 'deferred',
    'safety-skip 只交接下一半点评估，不拥有 typed ON'
  );
  assertPass(
    safetyTimer?.storedSmartOnRetry === true
      && safetyTimer.ownsTypedSmartOn === false
      && safetyTimer.repairsSafetyTimer === true
      && safetyTimer.boundaryRequired === false
      && safetyTimer.syncProjection === 'safety-timer-off'
      && safetyTimer.presentation === 'safety-retry'
      && safetyTimer.presentationAlways === true,
    'safety-timer 只修复关机保险，允许无原半点并投影为近期 OFF'
  );
  assertPass(
    getPwmRetryDescriptor('') === null
      && getPwmRetryDescriptor('unknown') === null
      && getPwmRetryDescriptor('constructor') === null
      && getPwmRetryDescriptor('toString') === null
      && getPwmRetryDescriptor('__proto__') === null
      && normalizePwmRetryKind(PWM_RETRY_KINDS.SMART_ON_SAFETY_SKIP)
        === PWM_RETRY_KINDS.SMART_ON_SAFETY_SKIP
      && normalizePwmRetryKind('unknown') === PWM_RETRY_KINDS.SMART_ON
      && normalizePwmRetryKind('unknown', PWM_RETRY_KINDS.SMART_ON_SAFE_DELAY)
        === PWM_RETRY_KINDS.SMART_ON_SAFE_DELAY,
    '未知 retry kind 不被识别；写入归一化保留兼容 fallback'
  );
  assertPass(
    [smartOn, safeDelay, safetySkip, safetyTimer].every(Object.isFrozen),
    '所有 retry descriptor 都是不可变值'
  );
}
