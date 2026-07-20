# 测试目录

AC-UST 是无依赖的纯 JS Chrome/Edge 扩展,测试分两层,各自职责清晰:

## 分层策略

| 层级 | 谁负责 | 工具 | 用途 |
|------|--------|------|------|
| 代码层(单元/逻辑) | 开发者(自动化) | Node + mock chrome API | 验证 popup.js / background.js 的逻辑分支正确性 |
| 浏览器层(端到端) | **用户手动** | Edge + 真实 AC 页面 | 验证扩展在真实环境的行为(灯转色、闹钟、PWM 循环) |

**浏览器层验证由用户在 Edge 中手动进行**,因为:
- 需要真实 HKUST 账号登录 AC 页面(`https://w5.ab.ust.hk/njggt/app/*`)
- MV3 service worker 在自动化 headed 浏览器中行为不稳定
- 实际 PWM 切换涉及主世界点击 + AntD 弹窗,自动化模拟脆弱

## 测试脚本

### `verify-fix.mjs`(代码层,日常 CI 用)

**用途**:用 mock chrome API 模拟用户场景,验证 popup.js 诊断面板的自愈逻辑。

**前置条件**:
- Node.js(>=18,支持原生 ESM)
- 不需要任何 npm install,纯 Node 内置模块

**运行**:
```pwsh
node test/verify-fix.mjs
```

**验证内容**:
- 用例 1–4：popup 诊断的 `nextTriggerAt` 自愈与 Service Worker 降级行为
- 用例 5–8：i18n 包体、跨设备相位同步、页面定时器解析与采纳
- 用例 9–10：单一 ON 点击链路、OFF 零点击以及 ON→OFF 前的定时器证明
- 用例 11：`Power-off after` 必须在新鲜页面保留同一 `HH:MM`；失败重试、过期闹钟恢复、时钟修复与手动开机都不得绕过该确认

每次修改 popup.js 诊断逻辑或 background.js 自愈路径后,都应先跑这个测试再 commit。

### `e2e-verify.cjs`(浏览器层,**手动触发**)

**用途**:用 Playwright 启动系统 Edge + 加载 dist/ 扩展,模拟用户点击诊断按钮,读取真实诊断输出。这是 evaluator 友好的"实际扩展中验证"路径,但**需要桌面图形环境**,CI 中无法跑。

**前置条件**:
- `npm install playwright`(临时安装,不入 package.json)
- 桌面环境(headed Edge 可启动,headless 模式 MV3 行为异常)
- 系统已装 Microsoft Edge

**运行**:
```pwsh
npm install playwright --no-save
node test/e2e-verify.cjs
```

**注意**:
- 会启动真实 Edge 窗口
- 测试 profile 在 `.test-profile/`(自动清理)
- 测试结束自动关闭 Edge

## 用户手动验证清单

每次代码改动后,用户在 Edge 中:

1. `edge://extensions/` → 找到 AC-UST → 点"重新加载"按钮
2. 打开 popup → 看标题行,确认 BUILD_TIME 是最新的(同名版本号下唯一可区分标志)
3. 点诊断按钮 → 检查所有 ✅/❌
4. 如果有红灯,先看 BUILD_TIME 是否最新;最新则报 bug,不是最新则重新 reload 扩展
