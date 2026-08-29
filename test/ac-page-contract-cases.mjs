import acPageContract from '../ac-page-contract.js';
import fs from 'node:fs';

const {
  AC_SWITCH_SELECTOR,
  isACStatusLabel,
  findUniqueACControl,
  isACSwitchDisabled
} = acPageContract;

function makeDocument(labels) {
  return {
    querySelectorAll(selector) {
      return selector === 'small, label, span, div' ? labels : [];
    }
  };
}

function makeLabel({
  text = 'Air Conditioning Status',
  children = [],
  controls = [],
  parent = null
} = {}) {
  const container = {
    parentElement: parent,
    querySelectorAll(selector) {
      return selector === AC_SWITCH_SELECTOR ? controls : [];
    }
  };
  return { children, textContent: text, parentElement: container };
}

export function runAcPageContractCases(assertPass) {
  assertPass(
    Object.keys(acPageContract).join(',')
      === 'AC_SWITCH_SELECTOR,isACStatusLabel,findUniqueACControl,isACSwitchDisabled'
      && Object.isFrozen(acPageContract),
    'AC page contract 只导出冻结的页面语义接口'
  );
  assertPass(
    AC_SWITCH_SELECTOR
      === 'button.ant-switch[role="switch"], .ui.toggle.checkbox input[type="checkbox"]',
    'AC page contract 固定 AntD 与 legacy 开关选择器'
  );

  const contractSource = fs.readFileSync(
    new URL('../ac-page-contract.js', import.meta.url),
    'utf8'
  );
  const pageRoot = {};
  const hostModule = { exports: { hostOwned: true } };
  const loadInBrowserWorld = new Function(
    'self',
    'globalThis',
    'module',
    contractSource
  );
  loadInBrowserWorld(pageRoot, pageRoot, hostModule);
  const firstBrowserApi = pageRoot.__AC_EXTENSION_PAGE_CONTRACT__;
  loadInBrowserWorld(pageRoot, pageRoot, hostModule);
  const browserDescriptor = Object.getOwnPropertyDescriptor(
    pageRoot,
    '__AC_EXTENSION_PAGE_CONTRACT__'
  );
  assertPass(
    Object.isFrozen(firstBrowserApi)
      && Object.isFrozen(pageRoot.__AC_EXTENSION_PAGE_CONTRACT__)
      && firstBrowserApi !== pageRoot.__AC_EXTENSION_PAGE_CONTRACT__
      && hostModule.exports.hostOwned === true
      && browserDescriptor?.writable === false
      && browserDescriptor?.configurable === true,
    '浏览器世界使用可重注入的只读扩展命名空间，不污染或服从站点 module.exports'
  );

  assertPass(
    isACStatusLabel('Air Conditioning Status')
      && isACStatusLabel('  air   conditioning status  ')
      && !isACStatusLabel('Air Conditioning Status:')
      && !isACStatusLabel('Air Conditioning')
      && !isACStatusLabel(null),
    'AC 状态标签只接受大小写与空白差异，不接受相似文案'
  );

  const acSwitch = { id: 'ac' };
  const otherSwitch = { id: 'other' };
  const uniqueDocument = makeDocument([makeLabel({ controls: [acSwitch] })]);
  const ambiguousDocument = makeDocument([
    makeLabel({ controls: [acSwitch, otherSwitch] })
  ]);
  const duplicateDocument = makeDocument([
    makeLabel({ controls: [acSwitch] }),
    makeLabel({ controls: [otherSwitch] })
  ]);
  const repeatedLabelDocument = makeDocument([
    makeLabel({ controls: [acSwitch] }),
    makeLabel({ controls: [acSwitch] })
  ]);
  const nonLeafLabelDocument = makeDocument([
    makeLabel({ controls: [acSwitch], children: [{}] })
  ]);
  assertPass(
    findUniqueACControl(uniqueDocument) === acSwitch
      && findUniqueACControl(ambiguousDocument) === null
      && findUniqueACControl(duplicateDocument) === null
      && findUniqueACControl(repeatedLabelDocument) === acSwitch
      && findUniqueACControl(nonLeafLabelDocument) === null
      && findUniqueACControl(makeDocument([])) === null,
    '唯一定位接受同一控件的重复标签，并对多控件、非叶标签或无标签失败关闭'
  );

  const ancestor = {
    parentElement: null,
    querySelectorAll: () => [acSwitch]
  };
  const nestedLabel = makeLabel({ controls: [], parent: ancestor });
  const ambiguousChild = {
    parentElement: ancestor,
    querySelectorAll: () => [acSwitch, otherSwitch]
  };
  const stoppedLabel = {
    children: [],
    textContent: 'Air Conditioning Status',
    parentElement: ambiguousChild
  };
  assertPass(
    findUniqueACControl(makeDocument([nestedLabel])) === acSwitch
      && findUniqueACControl(makeDocument([stoppedLabel])) === null,
    '唯一定位向上寻找最近单一候选；遇到多候选立即停止而不向更宽范围猜测'
  );

  const enabled = {
    disabled: false,
    className: 'ant-switch',
    hasAttribute: () => false,
    getAttribute: () => null
  };
  assertPass(
    isACSwitchDisabled(null) === false
      && isACSwitchDisabled(enabled) === false
      && isACSwitchDisabled({ ...enabled, disabled: true }) === true
      && isACSwitchDisabled({
        ...enabled,
        hasAttribute: name => name === 'disabled'
      }) === true
      && isACSwitchDisabled({
        ...enabled,
        getAttribute: name => name === 'aria-disabled' ? 'true' : null
      }) === true
      && isACSwitchDisabled({
        ...enabled,
        className: 'ant-switch ant-switch-disabled'
      }) === true,
    'disabled 判定覆盖属性、ARIA 与 AntD class，并保留 free mode 启用语义'
  );
}
