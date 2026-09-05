# AC-UST 端到端覆盖矩阵

本矩阵把“全部覆盖”定义为：每个用户可见功能、关键生命周期和安全失败路径，都有明确的自动化验收层或必要的外部人工验收。私有纯函数的排列组合由逻辑回归负责，不重复塞进浏览器 E2E。

## 验收层

- **E2E**：`e2e-verify.cjs`，真实加载 `dist/` 扩展；网络与 UST 页面使用确定性 fixture。
- **Logic**：`verify-fix.mjs`、`pwm-phase-cases.mjs`、`smart-mode-cases.mjs`；可控时钟与 mock Chrome API。
- **Live**：`weather-live-smoke.cjs`；访问当前生产 HKO URL，可选且不进入必过门禁。
- **Manual**：需要 HKUST 登录、真实服务器写入或商店渠道的外部验收，不能由 fixture 冒充。

## 功能与场景

| 领域 | 用户功能／场景 | 自动化证据 | 外部边界 |
|---|---|---|---|
| 安装 | dist 可加载、版本／字节匹配；首次舒适启动以本机 marker 只认领一次，重启／更新不重复 | E2E 首启＋完整重启；Logic 生命周期反例／打包清单 | 商店安装/升级：Manual |
| Popup | 中文启动、文档 ready、280px 布局、无横向溢出 | E2E 诊断现场 | 不同 OS 字形：Manual |
| Popup | 英文文案、24h 字段、键盘顺序、帮助链接 | E2E 英文 locale | 读屏器语音质量：Manual |
| 状态 | AC ON/OFF、下一动作、倒计时与 Est. | E2E 状态/余额/重启；Logic 显示矩阵 | 真实余额：Manual |
| 自动控制 | Smart 每个半小时周期最多开启 25 分钟；停用可抢占且只走页面 timer | E2E 一次 ON 点击＋两张新鲜页＋稳定 revision；Logic 目标／重试矩阵 | 真实设备启停：Manual |
| 运行时段 | 开关、24h 归一、非法范围、时段外暂停 | E2E 用户输入；Logic 边界/竞态矩阵 | 实时时段跨界：Manual smoke |
| 模式 | 循环／智能互斥且始终单选 | E2E 双向点击；Logic 并发/回写 | — |
| 循环定时 | 1+ 整数保存、0 非法原文保留、21/9 控制值 | E2E 用户输入；Logic 全分支 | 真实整周期：Manual |
| 智能控制 | 灵敏度预览/持久化、缓存建议与 21/9 恢复 | E2E Popup＋Worker；Logic 算法矩阵 | 当前体感：Manual |
| 天气获取 | 温度／湿度／风速三个生产 URL、`no-store`、同站解析、缓存、24/6 计划 | E2E 确定性三源链 | 当前端点：Live |
| 天气失败 | 单源 HTTP 失败不生成伪计划，保留上次成功缓存/计划 | E2E 503；Logic stale/invalid | 长时网络中断：Manual smoke |
| 天气调度 | `:20/:50` one-shot、目标 `:30/:00`、先续排后预取 | Logic 可控时钟/编排；E2E 观察 alarm | 真实钟点唤醒：Manual smoke |
| 页面发现 | 只操作完整等于 AC home 的未丢弃标签 | E2E 精确 home；Logic URL 反例 | 登录重定向：Manual |
| 页面读取 | status、Charge Mode 余额、空/已设 page timer | E2E content；Logic DOM fixtures | 线上 DOM 漂移：Manual |
| 自动 ON | 同一精确 tab 先预置 timer 再执行唯一 ON；正常路径等新 `Execution succeeded`＋迟到 ON，含糊但实际 ON 时零追加点击 | E2E 预置歧义／点击瞬间 timer／缺 toast 实际 ON／独立新鲜页；Logic 事务轨迹、确认框与取消 | 真实设备响应：Manual |
| 智能半点 | 可信 alarm 迟醒，或生命周期发现下一 ON 已越过当前安全窗口时，执行原 ON 相位剩余部分且不延长绝对关机点；普通迟到、既有短重试与余量不足仍 defer／保留 | E2E 真实 Worker 计划；Logic 过期 alarm、启动、watchdog 接线及安全余量 | 真实钟点唤醒：Manual smoke |
| ON 幂等 | 页面已 ON 时零额外点击、显式 `alreadyDone`，直接进入页面 timer | E2E 真实 Worker＋页面点击计数；Logic PWM 分支 | 真实 UST timer 写入：Manual |
| ON 失败 | 预置失败或 URL 漂移零点击；缺成功提示且仍非 ON、或截止到期时整笔失败，不刷新接力 | E2E picker 歧义／短截止；Logic 事务轨迹与重试矩阵 | — |
| 自动 OFF | content 拒绝 OFF，所有自动关机只走页面 timer | E2E 零点击计数；Logic 全调用链 | 真实关机生效：Manual |
| 页面 timer | 输入 HH:MM、新鲜页读回、绝对证明、重试清理 | E2E 同源持久 fixture；Logic 三轮退避 | UST 服务端持久化：Manual |
| timer 安全 | picker 歧义拒绝且不覆盖已确认值；初始 OFF 必须先在同页预置，ON 后才由新鲜页写正式 proof | E2E 双控件／同页 load token／新鲜页；Logic portal、React 竞态与组合事务 | — |
| receiver | 旧 listener 吞包后原页重注入，不刷新/导航 | E2E 选择性吞包 | BFCache 真机：Manual smoke |
| 诊断 | 健康/故障码、唯一下一步、alarm 修复、历史隔离 | E2E＋Logic | `chrome://extensions` 注册错误：Manual |
| 诊断兜底 | `popup.js` 同步崩溃仍可采集并复制 Markdown | E2E 故障注入 | — |
| 生命周期 | storage.session→local 迁移、完整重启恢复、offscreen 心跳 | E2E 重启/诊断；Logic 启动恢复 | 长时间休眠：Manual smoke |
| 同步 | sync 投影、陈旧版本拒绝、页面 timer 相位采纳 | Logic 确定性交错 | Chrome↔Edge 生态不互通：Manual |
| 错误记录 | content/SW 异常脱敏、串行、最多 50 条/当前构建 5 条 | Logic | 浏览器注册前错误：Manual |

## 命令

确定性完整门禁（构建后运行）：

```bash
node tools/verify-architecture.mjs
bash ./build.sh
node test/verify-fix.mjs
python3 test/verify-icon.py
node test/e2e-verify.cjs
```

可选在线数据 smoke：

```bash
node test/weather-live-smoke.cjs
```

WSL 的 Playwright/动态库准备与最终人工清单见 [`README.md`](README.md)。
