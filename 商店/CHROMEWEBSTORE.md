# AC-UST — Chrome Web Store Listing Metadata

> 用于 Chrome Web Store 开发者信息中心。上架入口：https://chrome.google.com/webstore/devconsole

## 基本信息

| 字段 | 值 |
| --- | --- |
| 名称 | AC-UST |
| 版本 | 0.9.8 |
| 清单 | Manifest V3 |
| 类别 | 工作效率（Productivity） |
| 语言 | 中文（简体）、English |
| 交易者状态 | 由作者按开发者帐号的实际法律身份填写；仓库不预设 |

## 简短说明

### 中文

为 HKUST Smart Power Meter 提供 PWM 冷气定时、智能天气控制、可选限时运行和跨设备相位对齐。

### English

PWM AC scheduling, weather-based smart control, optional operating-hour limits, and cross-device phase alignment for HKUST Smart Power Meter.

## 0.9.8 更新说明

### 中文

实测热夜开得不够：室内估计温度达到 28°C（天文台热夜标准）时，每 30 分钟周期的开启时长不再低于灵敏度对应下限（K×25 分钟，约 8 档起整周期连转）。滑块语义不变，温和夜间不受影响。

### English

Field feedback showed hot nights were under-cooled: once the indoor estimate reaches 28°C (the Observatory hot-night line), each 30-minute cycle guarantees a minimum run time proportional to the sensitivity slider (K × 25 minutes; from about level 8 the AC runs the full cycle). Slider semantics are unchanged and mild nights are unaffected.

## Previous release notes

### 中文

修复重载间隙：扩展重载/安装后的首个智能边界不再沿用旧时长——边界处无条件应用新鲜天气决策，重载后连转计划立即落地。

### English

Fixed a reload gap: the first smart boundary after an extension reload now applies the fresh weather decision unconditionally instead of reusing stale durations, so the run-through plan lands immediately after a reload.

### 中文

决策公式采纳用户提案精简为「开 = K × 2 × (体感 − 23)」：斜率 2、体感零点 23；热夜直开线移除（满档自然连转门槛 ≈ 室内 27°C，与原热夜线重合）；湿度经体感仍影响时长。热夜中档出力较上一版温和（干夜约 21/9），满档热夜仍连转。

### English

The decision formula is simplified per user proposal: run minutes = K × 2 × (apparent temp − 23), removing the hot-night override line (the natural full-sensitivity run-through threshold lands at ≈27°C indoor, matching the old line). Humidity still shapes durations through the apparent temperature. Hot-night mid-slider output is milder than the previous release (~21/9 on dry nights); full slider still runs continuously on hot nights.

### 中文

实测热夜开得不够：室内估计温度达到 28°C（天文台热夜标准）时，每 30 分钟周期的开启时长不再低于灵敏度对应下限（K×25 分钟，约 8 档起整周期连转）。滑块语义不变，温和夜间不受影响。

### English

Field feedback showed hot nights were under-cooled: once the indoor estimate reaches 28°C (the Observatory's hot-night line), each 30-minute cycle guarantees a minimum run time proportional to the sensitivity slider (K × 25 minutes; from about level 8 the AC runs the full cycle). Slider semantics are unchanged and mild nights are unaffected.

### 中文

实测满档仍偏热：负载增益由 3 提高到 4.5 分钟/°C，舒适目标由 24°C 降至 23°C。满档下室温约 27.4°C 即触发整周期连转，30°C 的夜间中档约占空比 25/5；中低灵敏度档位同比例加强制冷力度。

### English

Field testing showed full-power cooling was still too warm: the load gain is raised from 3 to 4.5 minutes per °C and the comfort target lowered from 24°C to 23°C. At full sensitivity the full-cycle run-through now triggers near 27.4°C indoor, giving roughly a 25/5 duty cycle on 30°C nights at mid sensitivity; lower sensitivity levels get a proportionally stronger cooling push.

### 中文

智能控制模型升级为「室内温度估计」：以室外气温的慢速加权平均加白日太阳得热推算室内温度，再换算开启时长；建议超过 25 分钟时整周期连转，下一半点自动重估。湿热傍晚不再过早停机，舒适度与连续运转的压缩机保护兼得。

### English

The smart control model now estimates indoor temperature from a slow weighted average of outdoor readings plus daytime solar gain, and converts it into run minutes. When the suggestion exceeds 25 minutes, the AC runs the full cycle and re-evaluates at the next half-hour boundary. The page-refresh readiness window is also extended (30s → 45s) to reduce false failures when the school server responds slowly.

## 详细说明（中文 / zh-CN）

```text
AC-UST 是一款为香港科技大学 Smart Power Meter 系统设计的自动冷气控制扩展。

主要功能：
• PWM 循环定时：分别设置冷气开启与关闭分钟数，自动持续循环
• 智能控制：读取香港天文台公开天气数据，在本机计算每个 30 分钟周期的开启时长，并以 0–10 共 11 档灵敏度调节；每周期最多开启 25 分钟，不额外等待关机后五分钟
• 限时运行：默认关闭即全天运行；开启后只在每天指定时段运行，范围外自动暂停并请求页面定时关机
• 可用时刻预计：仅在页面显示 Charge Mode 时读取冷气余额并计算分钟级预计时刻；其他计费模式不显示估算，避免误导
• 页面定时关机：通过 UST 页面自带的 Power-off after 控件执行关机；截止时间向上对齐到整分钟，页面值、新鲜页证明、扩展闹钟和倒计时使用同一个绝对时间。写入后由独立新鲜页按 10/15/20 秒退避回读，失败自动重试，绝不重复点击 OFF 开关
• 精确页面隔离：状态读取、开机和页面定时器读写只允许发生在 URL 完整等于 /njggt/app/home 的页面；尾斜杠、查询串、哈希、相似路径和其他业务页均被拒绝
• 跨设备相位对齐：同一浏览器生态通过浏览器同步补充对齐，UST 页面定时器负责关机相位校验
• 看门狗与召唤医生：检查后台状态并尝试恢复缺失的闹钟，但不保证所有问题都能自动修复；医生检查报告只附带当前构建以来最新 5 条本机脱敏异常，不上传、不跨设备同步
• 清晰低干扰：提供明确文字、语义状态反馈、减弱动态效果与高对比度适配
• 中英双语：支持中文和英文界面，并接入 Crowdin 社区本地化

请勿同时在 Chrome 与 Edge 两个浏览器生态中运行不同配置的 AC-UST。

支持香港科技大学 w5.ab.ust.hk Smart Power Meter 系统。
开源地址：https://github.com/BelugaRex/ac-ust
```

## Detailed Description (English / en)

```text
AC-UST is an automatic air-conditioning controller for the HKUST Smart Power Meter system.

Features:
• PWM cycle scheduling with independently configurable ON and OFF durations
• Smart control that reads public Hong Kong Observatory weather data and locally calculates ON time for each 30-minute cycle, adjustable across 11 sensitivity levels from 0 to 10; each cycle is capped at 25 minutes ON without an extra five-minute post-shutdown wait
• Optional operating-hour limits: leave off for all-day operation, or turn on to use only a daily time window
• Estimated availability calculated only when the portal displays Charge Mode; estimates remain hidden in other billing modes to avoid misleading results
• Timer-based shutdown through the portal's Power-off after control. The portal value, fresh-page proof, extension alarm, and countdown share one absolute deadline rounded up to a whole minute. Persistence is independently verified after 10/15/20-second backoff windows; failures retry without repeatedly clicking OFF
• Exact page isolation: status reads, startup, and timer access require the full /njggt/app/home URL; trailing slashes, queries, hashes, lookalike paths, and other business pages are rejected
• Cross-device phase alignment using browser sync plus the UST page timer
• Watchdog recovery plus Call the doctor reports that include only the five newest redacted local errors from the current build, without uploading or syncing them; repair attempts may not resolve every problem
• Clear, low-distraction UI with semantic feedback and reduced-motion and high-contrast support
• Chinese and English UI with Crowdin-based community localization

Do not run independently configured copies in both Chrome and Edge at the same time.

Supports HKUST Smart Power Meter at w5.ab.ust.hk.
Open source: https://github.com/BelugaRex/ac-ust
```

## 隐私与数据使用

| 字段 | 值 |
| --- | --- |
| 单一用途说明 | 自动控制 HKUST Smart Power Meter 冷气，提供 PWM 循环、智能天气控制、可选限时运行、余额可用时刻预计、页面定时关机和本机状态检查与修复尝试 |
| 远程代码 | 否；不下载或执行远程 JavaScript、Wasm 或其他代码 |
| 隐私政策 URL | https://github.com/BelugaRex/ac-ust/blob/main/%E5%95%86%E5%BA%97/PRIVACY.md |
| 开发者数据收集 | 不向开发者、分析平台或广告服务收集、出售、共享或传输个人数据 |
| 网站内容处理 | 仅在用户登录的 UST Smart Power Meter 页面本地读取冷气状态、Charge Mode、余额和 Power-off after，并把用户请求或计划中的控制操作提交给该 UST 页面；不保存原始 DOM |
| 本地与会话存储 | 设置、运行状态、最近余额、最近成功天气观测及最多 50 条脱敏异常保存在浏览器 `storage.local`；最近余额也会写入 `storage.session` 作为同一浏览器会话的热缓存。超过 1 小时的天气观测在后台控制路径中会视为过期并触发刷新；刷新失败时可继续作为回退，弹窗也可能在刷新前显示最近缓存。诊断消息会脱敏 URL 与邮箱，不记录原始 DOM、余额或帐号信息 |
| 浏览器同步 | 用户启用同步时，仅通过 Chrome/Edge 自身的 `storage.sync` 同步精简配置和 PWM 相位；不经过 AC-UST 或开发者服务器 |
| 扩展直接网络请求 | 扩展直接发起的 HTTPS 请求仅访问用户主动登录的 `w5.ab.ust.hk` 门户和香港天文台 `data.weather.gov.hk` 公开天气 API；天气请求不附带 UST 帐号、页面内容、设置或诊断日志。可选浏览器同步由 Chrome/Edge 自身服务处理，见上一行 |

## 权限理由

| 权限 | 理由 |
| --- | --- |
| `alarms` | 调度 PWM 周期、运行时段边界、看门狗、天气整点刷新和页面定时器重试 |
| `storage` | 保存本地设置、运行状态、天气/余额缓存与脱敏诊断，并在用户启用时通过浏览器帐号同步精简配置和相位 |
| `tabs` | 查找或按需打开 HKUST 冷气页面以读取状态、开机和设置页面关机定时器；不读取、记录或传输其他标签页信息 |
| `offscreen` | 创建无界面文档并维持 runtime Port/heartbeat，帮助 Manifest V3 Service Worker 被回收后恢复后台调度；不读取网站内容、不加载远程代码，也不创建或传输用户 Blob 数据 |
| `scripting` | HKUST 页面脚本未就绪时兜底注入仓库随扩展打包的隔离世界与主世界脚本 |
| `host_permissions: https://w5.ab.ust.hk/*` | 仅在 HKUST Smart Power Meter 页面读取冷气状态、Charge Mode、余额和页面定时器，并执行用户配置的开机/定时关机操作 |
| `host_permissions: https://data.weather.gov.hk/*` | 只读获取香港天文台公开当前天气，在本机计算智能控制开启时长；请求不携带 UST 或用户数据 |

> **审核风险**：当前 `chrome.offscreen.createDocument()` 使用 `reasons: ['BLOBS']`，实际仅建立保活 Port/heartbeat，并不操作 Blob。若审核要求 reason 与实际操作严格一致，应先调整或移除该保活层再重新构建提交；不得为通过审核虚构 Blob 用途。

## 图片资源

| 资源 | 尺寸 | 路径 |
| --- | --- | --- |
| 商店图标 | 128×128 | `商店/素材/icon-128.png` |
| 屏幕截图 1 | 1280×800 | `商店/素材/screenshot-1.png` |
| 屏幕截图 2 | 1280×800 | `商店/素材/screenshot-2.png` |
| 小宣传图块 | 440×280 | `商店/素材/promo-small.png` |
| 滚动宣传图块 | 1400×560 | `商店/素材/promo-marquee.png` |

## 分发设置

| 字段 | 值 |
| --- | --- |
| 应用内购买 | 否 |
| 公开范围 | 私享（Private，仅受信任的测试人员 / 指定 Google 群组） |
| 地理分布 | 香港 |

> “不公开列出（Unlisted）”允许任何拿到链接的人安装；“私享（Private）”才限制为已配置的测试人员。两者都不会跳过 Chrome Web Store 审核。

### 测试人员配置

1. 在开发者信息中心帐号设置中添加受信任测试人员；人数较多时可添加自己管理的 Google 群组。
2. 在商品“分发”页选择“私享（Private）”，并选择允许安装的测试人员或群组。
3. 审核并发布后，只把商店链接发给已授权帐号。

### 审核测试说明

完整功能需要登录 HKUST Smart Power Meter。测试帐号和密码只填写在开发者信息中心的审核专用字段，绝不写入本仓库。建议提供以下步骤：

1. 登录 `https://w5.ab.ust.hk/njggt/app/home`，保持冷气控制页可访问。
2. 打开扩展弹窗，设置开启/关闭分钟数并启用循环定时；确认扩展读取开关状态、写入 `Power-off after` 并显示同一下一次切换时间。
3. 关闭循环定时并启用智能控制；确认出现建议开启分钟数、等效温度和更新时间。移动灵敏度滑块后确认建议值更新；若当前处于 ON 相位，确认页面关机截止时间随之重设，若处于 OFF 相位，新值会在下一次 ON 相位生效。
4. 点击「召唤医生」；确认 `ac-smart-weather`、PWM/看门狗等状态可见，常见问题会尝试自动修复但不保证一定成功，且报告最多附带当前构建最新 5 条脱敏异常。
5. 说明测试帐号是否连接真实冷气设备，以及审核时允许执行的操作范围。

若无法提供 HKUST 审核帐号，提交前应先向审核团队确认替代验证方式；设为私享不会免除审核。

提交审核前还必须确认隐私政策 URL 已随本版本合并到公开 `main`，可在未登录 GitHub 的窗口中直接打开；本地分支或未 push 的路径不能用于正式提交。

## ZIP 上传

运行 `bash ./build.sh` 后，上传 `releases/ac-ust-v0.9.8.zip`。ZIP 内直接包含 `manifest.json`，没有额外的 `dist/` 外层目录。

## 发布流程

1. 运行构建与自动化测试，确认版本、ZIP、图标和本目录资料通过验证。
2. 上传 `releases/ac-ust-v0.9.8.zip`。
3. 填写商品详情、隐私声明、权限理由与审核测试说明。
4. 选择私享（Private）、受信任测试人员和香港地区。
5. 提交审核时选择推迟发布；审核通过后在允许期限内由作者手动发布。

## 支持

- GitHub：https://github.com/BelugaRex/ac-ust
- Issues：https://github.com/BelugaRex/ac-ust/issues