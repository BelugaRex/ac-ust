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

**用途**:用 mock chrome API 模拟用户场景,验证 popup.js「召唤医生」面板的自动修复尝试逻辑。

**前置条件**:
- Node.js 20（在仓库根目录运行 `nvm install && nvm use`）
- 不需要任何 npm install,纯 Node 内置模块
- 已运行 `bash ./build.sh` 生成 `dist/` 与商店 ZIP

**运行**:
```bash
node test/verify-fix.mjs
```

**验证内容**:
- 用例 1–4：popup「召唤医生」的 `nextTriggerAt` 自动修复尝试与 Service Worker 降级行为
- 用例 5–8：i18n 包体、冷气余额解析与 PWM 可用时间估算、跨设备相位同步、页面定时器解析与采纳、popup 布局防回归（CSS 禁 vw/vh，popup 固定为 250px 并保留固定 gutter，静态网页预览在窄窗口整体等比缩放）
- popup 的界面字号限制在 8–16px：主界面为 16px，固定标签页提醒为 12px，版本元信息为 10px；元素间距统一收敛为可见边界之间的 8px 或 16px；1px 边框组件使用 7px/15px CSS padding 补偿，输入框外边距为 0，运行时段时钟指示器为 16px 且自身内边距为 0，运行时段和间隔时长输入框为 32px 标准高度，同一行文字与输入框垂直居中
- 状态文字与倒计时、状态卡片与设置卡片、设置卡片与页脚边界均使用 8px 间距；页脚 8px 外间距叠加 8px 顶部内边距，使卡片边界到页脚内容保持 16px
- 拨杆与「召唤医生」按钮的扩大命中区采用绝对定位伪元素，不参与布局；设置头、拨杆区域和运行时段标签不使用透明 `min-height` 撑开可见线框距离
- “循环定时”标题及同栏拨杆到设置卡上方外框线、下方分隔线的可见距离均为 16px
- 运行时段行的输入框到上方标题分隔线、下方运行时段分隔线均为 16px；文字、拨杆和输入框保持同一中心线，因此各自上下距离对称
- “开启时长（分钟）”一行到上方运行时段分隔线、“关闭时长（分钟）”一行到下方提示分隔线均为 16px；每行标签和 32px 输入框的水平中轴线一致
- 运行时段拨杆、标签、`#activeHoursStart`、破折号和 `#activeHoursEnd` 保持同一行，不再显示独立的“运行中/休眠中”徽标；PWM 与运行时段共用 `36×20px` 拨杆，内部圆形滑块直径统一为 16px；普通 HTTP 静态预览默认展示可交互的 PWM 开启状态，窗口窄于插件自然宽度时缩放完整界面而不重排
- 运行时段标签到开始时间、开始时间到破折号、破折号到结束时间的三段水平间距均为 16px
- 开启/关闭间隔时长上下排布：上行是开启时长，下行是关闭时长，每行标签与 32px 输入框同行
- 开启/关闭时长每行的文字对齐运行时段文字（跳过拨杆占位），三个输入框统一为 5rem 并复用共享 Grid 列，时长输入框与结束时间框左对齐
- 用例 9–10：单一 ON 点击链路、每次点击后等待 10 秒、所有读写只选择完整 URL 精确等于 AC home 的标签、其他 UST 页面不作为初始操作目标、首次开机未确认时由统一函数刷新或回到 home 并有限递归一次、OFF 零点击以及 ON→OFF 前的定时器证明
- 用例 11：`Power-off after` 写入时才把浮点持续时长向上对齐到整分钟绝对截止时间；写入后按 `10/15/20` 秒间隔在新鲜页面确认同一 `HH:MM`，页面证明、PWM alarm 与 popup 倒计时共用该截止时间，失败重试、过期闹钟恢复、时钟修复与手动开机都不得绕过确认
- 用例 14：医生检查报告始终分开显示智能自动 ON 的页面安全定时器重试和独立 OFF 页面定时器重试；两条通道分别覆盖 active、inactive、missing alarm 与 mismatch，typed marker 错位必须判红，`pageTimerRetryMinutes` 仅表示 OFF 通道的目标关机分钟数
- 用例 15：Service Worker 后台异常按串行写链保存到本机环形日志，并发追加不丢失且只保留最新 50 条；URL/邮箱脱敏、消息截断、写入失败隔离，popup 仅按新到旧并入当前构建以来最新 5 条，并拒绝构建前、未来与非法时间戳记录
- 用例 16：运行时段作为循环定时与智能控制共用的独立门禁，覆盖 `[start,end)` 真值表、模式选择保留、循环立即恢复、智能半点延后、自动 ON/运行闹钟最终竞态复检、退出时页面定时器安全停机、停用状态下独立编辑无关机副作用，以及启动、同步、看门狗、医生修复尝试和 popup 暂停态旁路；popup 不得直接创建运行闹钟，自动修复只委派后台
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

**用途**:用 Playwright 启动系统 Chrome/Edge + 加载 dist/ 扩展,模拟用户点击「召唤医生」按钮,读取真实报告。这是 evaluator 友好的"实际扩展中验证"路径,但**需要桌面图形环境**,CI 中无法跑。

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

### `e2e-background-repair.cjs`（构建后 Worker 聚焦回归）

**用途**：真实加载 `dist/`，从扩展页面发送 `ensureDiagnostics`，稳定触发智能 ON
不可信时钟的 `repairScheduleClock()` 重绑定路径；同时校验运行中的 Service Worker
与 `dist/background.js` 字节哈希一致，并确认 response、Worker console/error 与
`ac_diagnostic_log` 均不再出现 `Assignment to constant variable.`。

前置条件与 WSL2 `LD_LIBRARY_PATH` 要求同 `e2e-verify.cjs`。该脚本不需要真实账号，
使用精确 AC home URL 的本地 fixture 确认 OFF 状态，完成后自动关闭浏览器并删除临时 profile。

### 后台无打扰回归（本地夹具，不连接真实空调）

- `node test/e2e-picker-ok.cjs`：执行实际 `content.js`，覆盖 OK 启用/歧义/节点替换，以及每秒调度和动画帧暂停的确定性模拟；未关闭下拉层仍必须失败。
- `xvfb-run -a node test/e2e-background-timer.cjs`：在独立虚拟显示和临时 profile 中加载源码扩展；也可传 `dist` 验证最终构建。保留 Chrome 默认后台节流，覆盖其他活动标签、最小化和 OK 拒绝；同时核对真实 Worker 哈希、后台提交、独立页面读回、窗口/标签状态及用户输入不变。
- Playwright 不拦截扩展新 target 的首次导航，因此测试先加载本地扩展资源再非活动导航到 home 夹具；所有 HTTP 请求在本地响应，生产代码的每次 create 必须明确 `active:false`。导航接管仅存在于测试，不能以此证明学校服务器或真实 React 实现的全部行为。
- `verify-fix.mjs` 的 9N/9O 与 17B–17I 另外覆盖生产写入函数的焦点 API 记录、创建失败、URL 漂移、丢弃/关闭、revision/截止失效、有限重试和提前登记回收。
- `background-arm-cases.mjs` 随主回归执行，动态验证同页 ON/状态、补设固定截止、失败与异常回收；17J 验证预布防不提前一分钟回收。后台 E2E 另含 OFF→同页 ON→服务器清空定时器→补设的完整本地模拟链。
- Xvfb 没有窗口管理器时最小化场景会明确 SKIP，不能把其余通过项写成最小化已实测。
- 可在扩展路径后再传 Openbox 可执行路径（如 `.test-profile/window-manager/extracted/usr/bin/openbox`），并把相邻 `usr/lib/x86_64-linux-gnu` 加入 `LD_LIBRARY_PATH`。脚本负责启动/回收这个隔离窗口管理器；指定后最小化不成功会失败而非跳过。只在独立 Xvfb 显示中使用该参数。
- 上述结果不等于真实 Windows 遮挡策略、浏览器冻结或下一次半点空调运行已验收；真实环境仍按下列清单核对。

## 用户手动验证清单

每次代码改动后,用户在 Edge 中:

1. `edge://extensions/` → 找到 AC-UST → 点"重新加载"按钮
2. 打开 popup → 看标题行中的版本号与构建时间,确认当前加载的是最新构建
3. 点「召唤医生」按钮 → 检查所有 ✅/❌
4. 如果有红灯,先看头栏构建时间是否最新;最新则报 bug,不是最新则重新 reload 扩展
5. 在其他应用工作或将浏览器最小化，观察下一次自动任务：不弹出浏览器、不切标签；返回后核对冷气状态与页面关机时间，不能只看焦点未变就认为操作成功。
