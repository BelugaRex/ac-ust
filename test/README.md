# 测试目录

AC-UST 是无依赖的纯 JS Chrome/Edge 扩展，测试分三层，各自职责清晰：

## 分层策略

| 层级 | 谁负责 | 工具 | 用途 |
|------|--------|------|------|
| 架构契约 | 开发者(自动化) | Node | 验证依赖方向、运行入口、动态注入和打包清单 |
| 代码层(单元/逻辑) | 开发者(自动化) | Node + mock chrome API | 验证 popup.js / background.js 的逻辑分支正确性 |
| 浏览器层(端到端) | **用户手动** | Edge + 真实 AC 页面 | 验证扩展在真实环境的行为(灯转色、闹钟、PWM 循环) |

**浏览器层验证由用户在 Edge 中手动进行**,因为:
- 需要真实 HKUST 账号登录 AC 页面(`https://w5.ab.ust.hk/njggt/app/*`)
- MV3 service worker 在自动化 headed 浏览器中行为不稳定
- 实际 PWM 切换涉及主世界点击 + AntD 弹窗,自动化模拟脆弱

## 测试脚本

### `verify-architecture.mjs`（架构契约）

**用途**：以根目录 `architecture.config.json` 为唯一契约，验证上下文边界、接口方向、脚本加载顺序和运行时打包文件。

```bash
node tools/verify-architecture.mjs
```

### `verify-fix.mjs`(代码层 + 产物契约,日常 CI 用)

**用途**：统一运行纯决策、mock 编排、源码安全契约、popup/i18n 和构建产物回归。主入口保留完整断言总数与退出码，内部纯决策套件按领域拆分：

- `pwm-phase-cases.mjs`：PWM、天气预取槽与智能半点规划。
- `smart-mode-cases.mjs`：智能分钟数、天气解析、精度和降雨边界。

**前置条件**:
- Node.js 20（在仓库根目录运行 `nvm install && nvm use`）
- 不需要任何 npm install,纯 Node 内置模块
- 已运行 `bash ./build.sh` 生成 `dist/` 与商店 ZIP

**运行**:
```bash
node test/verify-fix.mjs
```

默认只输出各套件摘要、失败项和总计；需要完整场景快照及逐条 PASS/FAIL 时运行：

```bash
node test/verify-fix.mjs --verbose
```

**验证内容**:
- 用例 1–4：popup 诊断的 `nextTriggerAt` 自愈与 Service Worker 降级行为
- 用例 14：诊断将当前检查统一为 `ok/info/warning/repaired/error`，以稳定错误码、问题域、证据和唯一下一步生成摘要；自动控制关闭或运行时段暂停属于预期状态，不计入当前问题；后台自愈同时返回修复前快照和逐项修复记录；Popup 自检覆盖文档就绪/可见状态、视口与内容尺寸、横向溢出、运行期异常、控件与权威 `schedule` 同步以及 Popup→Service Worker 保活连接；独立兜底先于主脚本加载，故障注入后仍可只读导出 schedule/alarms/heartbeat/SW 部分现场并复制，正常纵向滚动不报错且不采集 URL、DOM 文本、账号或余额
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
- 用例 9–10：单一 ON 点击链路；本次点击前建立消息基线，并行等待确认框与新出现的精确 `Execution succeeded`，再结合 ON 状态确认完成。旧／隐藏／伪成功消息均不采信；已是 ON 保持幂等。原生对话框仅在单次点击栈内代理，AC 开关与 AntD 确认框按唯一语义定位；隐藏、无关、重复、禁用或歧义候选零点击。所有读写只选择完整 URL 精确等于 AC home 的标签；提示缺失、智能 ON 截止或自动控制失效不通过刷新／同轮 ON 复核绕过，真正的持续连接失败仍只有限恢复，OFF 零点击
- 用例 11：`Power-off after` 写入时才把浮点持续时长向上对齐到整分钟绝对截止时间；picker portal 只接受显式 `aria-controls`／`aria-owns` 关联或操作后唯一新出现的 dropdown，既有无关层与多个新层零点击。写入后按 `10/15/20` 秒间隔在新鲜页面确认同一 `HH:MM`，页面证明、PWM alarm 与 popup 倒计时共用该截止时间
- 用例 15：Service Worker 后台异常按串行写链保存到本机环形日志，并发追加不丢失且只保留最新 50 条；URL/邮箱脱敏、消息截断、写入失败隔离，popup 仅按新到旧并入当前构建以来最新 5 条，并拒绝构建前、未来与非法时间戳记录
- 用例 16：运行时段作为循环定时与智能控制共用的独立门禁，覆盖 `[start,end)` 真值表、模式选择保留、循环立即恢复、智能半点延后、自动 ON/运行闹钟最终竞态复检、退出时页面定时器安全停机、独立关机 revision、主世界递归取消、停用状态下独立编辑无关机副作用，以及启动、同步、看门狗、诊断和 popup 暂停态旁路；另以确定性交错直接执行真实消息分支，验证本地设置／远端 sync 串行、陈旧快照淘汰、sync 异常续跑与读取重试、智能灵敏度尾随、popup 最终提交失败／旧响应／旧轮询抑制、双模式 busy 反馈和时段外隐藏 Est.；popup 不得直接创建运行闹钟，自愈只委派后台
- 余额链路：`billing-helpers.js` 先于 `content.js` 注入；内容脚本只从 `Air Conditioning Balance` 区块的 `.ant-progress-text` 读取当前分钟数，拒绝把周期总额当成余额，并随现有状态响应返回；预计标签与日期时间分两行，今明两日显示“今天／明天”和“Today／Tomorrow”，之后显示月日；预计墙钟可用时间不超过 24 小时时同时使用警示符号、颜色和无障碍文案提醒

`test/fixtures/power-off-after-states.json` 是从真实页面 DOM 样本提取的脱敏 fixture：已设定时 `.ant-picker input` 的 `value/title` 都是 `HH:MM` 且 AC 为 ON；页面关机后两者清空且 AC 为 OFF。它锁定 content script 的读取依据，不含账号、房间或余额信息。

每次修改扩展逻辑、UI 契约或构建产物后，都应先跑这个测试再 commit。

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

**用途**:用 Playwright 启动系统 Chrome/Edge + 加载 dist/ 扩展,模拟用户点击诊断按钮,读取真实诊断输出；完整重启后还会启用智能控制，验证目标 plan 缺失时真实 Service Worker 由新鲜本地天气把旧 `12/18` 更新为 `21/9`，且真实 Popup 同步显示 `21/30`。这是 evaluator 友好的"实际扩展中验证"路径,但**需要桌面图形环境**,CI 中无法跑。

**前置条件**:
- `npm install playwright`(临时安装,不入 package.json)
- 桌面环境(headed Chrome/Edge 可启动,headless 模式 MV3 行为异常)
- 系统已装 Chrome 或 Edge
- **WSL2 额外依赖**(2026-08-16 实证):系统缺 `libnspr4/libnss3/libasound` 时,
把 noble 版 deb 提取出的库放 `.test-profile/libs/extracted/`(已忽略),运行时先
`export LD_LIBRARY_PATH="$PWD/.test-profile/libs/extracted/usr/lib/x86_64-linux-
gnu:$LD_LIBRARY_PATH"`;不装 questing 等更新版本包(报 `GLIBC_2.43 not found`)。
缺库时运行可能无任何输出直接退出,先查库路径再怀疑脚本。

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
