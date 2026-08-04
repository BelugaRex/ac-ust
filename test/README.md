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
- Node.js 20（在仓库根目录运行 `nvm install && nvm use`）
- 不需要任何 npm install,纯 Node 内置模块
- 已运行 `bash ./build.sh` 生成 `dist/` 与商店 ZIP

**运行**:
```bash
node test/verify-fix.mjs
```

**验证内容**:
- 用例 1–4：popup 诊断的 `nextTriggerAt` 自愈与 Service Worker 降级行为
- 用例 5–8：i18n 包体、冷气余额解析与 PWM 可用时间估算、跨设备相位同步、页面定时器解析与采纳、popup 布局防回归（CSS 禁 vw/vh，popup 固定为 250px 并保留固定 gutter，静态网页预览在窄窗口整体等比缩放）
- popup 的界面字号限制在 8–16px：主界面为 16px，固定标签页提醒为 12px，版本元信息为 10px；元素间距统一收敛为可见边界之间的 8px 或 16px；1px 边框组件使用 7px/15px CSS padding 补偿，输入框外边距为 0，运行时段时钟指示器为 16px 且自身内边距为 0，运行时段和间隔时长输入框为 32px 标准高度，同一行文字与输入框垂直居中
- 状态文字与倒计时、状态卡片与设置卡片、设置卡片与页脚边界均使用 8px 间距；页脚 8px 外间距叠加 8px 顶部内边距，使卡片边界到页脚内容保持 16px
- 拨杆与诊断按钮的扩大命中区采用绝对定位伪元素，不参与布局；设置头、拨杆区域和运行时段标签不使用透明 `min-height` 撑开可见线框距离
- “循环定时”标题及同栏拨杆到设置卡上方外框线、下方分隔线的可见距离均为 16px
- 运行时段行的输入框到上方标题分隔线、下方运行时段分隔线均为 16px；文字、拨杆和输入框保持同一中心线，因此各自上下距离对称
- “开启时长（分钟）”一行到上方运行时段分隔线、“关闭时长（分钟）”一行到下方提示分隔线均为 16px；每行标签和 32px 输入框的水平中轴线一致
- 运行时段拨杆、标签、`#activeHoursStart`、破折号和 `#activeHoursEnd` 保持同一行，不再显示独立的“运行中/休眠中”徽标；PWM 与运行时段共用 `36×20px` 拨杆，内部圆形滑块直径统一为 16px；普通 HTTP 静态预览默认展示可交互的 PWM 开启状态，窗口窄于插件自然宽度时缩放完整界面而不重排
- 运行时段标签到开始时间、开始时间到破折号、破折号到结束时间的三段水平间距均为 16px
- 开启/关闭间隔时长上下排布：上行是开启时长，下行是关闭时长，每行标签与 32px 输入框同行
- 开启/关闭时长每行的文字对齐运行时段文字（跳过拨杆占位），三个输入框统一为 5rem 并复用共享 Grid 列，时长输入框与结束时间框左对齐
- 用例 9–10：单一 ON 点击链路、消息端口提前关闭时刷新后仅重试一次、其他发送错误不重试、OFF 零点击以及 ON→OFF 前的定时器证明
- 用例 11：`Power-off after` 按 `3/10/30` 秒退避后必须在新鲜页面保留同一 `HH:MM`；失败重试、过期闹钟恢复、时钟修复与手动开机都不得绕过该确认
- 余额链路：`billing-helpers.js` 先于 `content.js` 注入；内容脚本只从 `Air Conditioning Balance` 区块的 `.ant-progress-text` 读取当前分钟数，拒绝把周期总额当成余额，并随现有状态响应返回；预计标签与日期时间分两行，今明两日显示“今天／明天”和“Today／Tomorrow”，之后显示月日；预计墙钟可用时间不超过 24 小时时同时使用警示符号、颜色和无障碍文案提醒

`test/fixtures/power-off-after-states.json` 是从真实页面 DOM 样本提取的脱敏 fixture：已设定时 `.ant-picker input` 的 `value/title` 都是 `HH:MM` 且 AC 为 ON；页面关机后两者清空且 AC 为 OFF。它锁定 content script 的读取依据，不含账号、房间或余额信息。

每次修改 popup.js 诊断逻辑或 background.js 自愈路径后,都应先跑这个测试再 commit。

### `verify-icon.py`(图标契约,涉及图标时跑)

**用途**:校验五个扩展图标的契约,纯 Python 标准库,无需 Node。

**验证内容**:
- 16/24/32/48/128 均为原生尺寸的 8-bit RGBA PNG,签名与 CRC 有效
- 16px 母版调色板硬边、满画布、雪花+循环箭头可辨识
- 48/128 与 24/32 母版精确最近邻一致(即 `tools/scale-pixil-logo.py` 的产物)
- `popup.html` 只引用 `icons/` 下真实存在的图标文件

**运行**:
```bash
python3 test/verify-icon.py
```

修改或重画任何 `icons/` 文件后,先重跑 `python3 tools/scale-pixil-logo.py` 再跑本测试。

### `e2e-verify.cjs`(浏览器层,**手动触发**)

**用途**:用 Playwright 启动系统 Chrome/Edge + 加载 dist/ 扩展,模拟用户点击诊断按钮,读取真实诊断输出。这是 evaluator 友好的"实际扩展中验证"路径,但**需要桌面图形环境**,CI 中无法跑。

**前置条件**:
- `npm install playwright`(临时安装,不入 package.json)
- 桌面环境(headed Chrome/Edge 可启动,headless 模式 MV3 行为异常)
- 系统已装 Chrome 或 Edge

**运行**:
```bash
npm install playwright --no-save
node test/e2e-verify.cjs
```

**注意**:
- 会启动真实浏览器窗口
- 测试 profile 在 `.test-profile/`(自动清理)
- 测试结束自动关闭 Edge

## 用户手动验证清单

每次代码改动后,用户在 Edge 中:

1. `edge://extensions/` → 找到 AC-UST → 点"重新加载"按钮
2. 打开 popup → 看标题行中的版本号与构建时间,确认当前加载的是最新构建
3. 点诊断按钮 → 检查所有 ✅/❌
4. 如果有红灯,先看头栏构建时间是否最新;最新则报 bug,不是最新则重新 reload 扩展
