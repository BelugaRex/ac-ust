# AC-UST — Chrome Web Store Listing Metadata

> 这些内容用于 Chrome Web Store 开发者信息中心的上架填写。
> 上架入口：https://chrome.google.com/webstore/devconsole

## 基本信息

| 字段 | 值 |
|------|-----|
| 名称 | AC-UST |
| 版本 | 0.6.11 |
| 清单 | Manifest V3 |
| 类别 | 工作效率 (Productivity) |
| 语言 | 中文（简体）、English |
| 非交易者账号 | ✅ |

## 简短说明

### 中文

为 HKUST Smart Power Meter 提供可靠的 PWM 冷气循环定时、运行时段和跨设备相位对齐。

### English

Reliable PWM AC scheduling, active hours, and cross-device phase alignment for HKUST Smart Power Meter.

## 详细说明（中文 / zh-CN）

```text
AC-UST 是一款为香港科技大学 Smart Power Meter 系统设计的自动冷气控制扩展。

主要功能：
• PWM 循环定时：分别设置冷气开启与关闭分钟数，自动持续循环
• PWM 运行时段：只在每天指定时段运行，时段外自动停用并请求页面定时关机
• 可用时刻预计：仅在页面显示 Charge Mode 时只读读取冷气余额并计算精确到分钟的预计时刻；其他计费模式不显示估算，避免误导。今明两日显示“今天／明天”，之后显示月日，预计 24 小时内用完时以轻量警示突出
• 页面定时关机：使用 UST 页面自带的 Power-off after 定时器执行关机；扩展优先复用 home 页，必要时从 warning 等子页导航回入口，写入后以独立新鲜页按 3/10/30 秒退避回读确认，失败自动重试且绝不重复点击 OFF 开关
• 跨设备相位对齐：同浏览器生态通过浏览器同步补充对齐，UST 页面定时器负责跨浏览器关机相位校验
• 看门狗与自愈：自动恢复缺失的后台闹钟，并提供一键诊断
• 清晰与低干扰：固定使用与 UST 页面一致的浅色外观，提供清晰文字与语义状态反馈，并适配系统减弱动态效果和高对比度
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
• Active hours that limit PWM operation to a daily time window
• A compact two-line estimated availability label and time beside the AC status, calculated only when the portal displays Charge Mode; estimates stay hidden in other billing modes to avoid misleading results, with Today/Tomorrow labels, month/day for later dates, and a subtle highlight when less than 24 hours remain
• Timer-based shutdown through the portal's Power-off after control, preserving the write page while independently verifying persistence after 3/10/30-second backoff windows and retrying failures without repeated OFF clicks
• Cross-device phase alignment using browser sync plus the UST page timer
• Watchdog recovery and a built-in diagnostics panel
• Clear, low-distraction light appearance matching the UST page, with semantic status feedback and support for system reduced-motion and high-contrast preferences
• Chinese and English UI with Crowdin-based community localization

Do not run independently configured copies in both Chrome and Edge at the same time.

Supports HKUST Smart Power Meter at w5.ab.ust.hk.
Open source: https://github.com/BelugaRex/ac-ust
```

## 隐私信息

| 字段 | 值 |
|------|-----|
| 单一用途说明 | 自动控制 HKUST Smart Power Meter 冷气，提供 PWM 循环、运行时段、余额可用时刻预计、页面定时关机和状态诊断 |
| 远程代码 | 否，不加载或执行远程代码 |
| 隐私政策 URL | https://github.com/BelugaRex/ac-ust/blob/main/PRIVACY.md |
| 数据收集 | 不收集、出售或传输个人数据；设置仅保存在浏览器 `storage.local` / `storage.sync` |
| 外部网络 | 仅访问用户主动登录的 HKUST Smart Power Meter 页面 |

## 权限理由

| 权限 | 理由 |
|------|------|
| `alarms` | 调度 PWM 周期、运行时段边界、看门狗和页面定时器重试 |
| `storage` | 保存本地设置与运行状态，并在同一浏览器生态内同步精简后的 PWM 配置和相位 |
| `tabs` | 查找或按需打开 HKUST 冷气页面，以读取状态、开机和设置页面关机定时器；代码只查询 `https://w5.ab.ust.hk/njggt/app/*`，不读取、记录或传输其他标签页信息 |
| `offscreen` | 提供 Service Worker 冗余保活，提升后台调度可靠性 |
| `scripting` | 页面脚本未就绪时兜底注入隔离世界与主世界脚本 |
| `host_permissions: https://w5.ab.ust.hk/*` | 仅在 HKUST Smart Power Meter 页面读取冷气状态与余额、执行开机和设置关机定时器 |

## 图片资源

| 资源 | 尺寸 | 路径 |
|------|------|------|
| 商店图标 | 128×128 | `icons/ac-ust_128.png` |
| 屏幕截图 | 1280×800 | `store-assets/` |
| 小宣传图块 | 440×280 | `store-assets/` |
| 滚动宣传图块 | 1400×560 | `store-assets/` |

## 分发设置

| 字段 | 值 |
|------|-----|
| 应用内购买 | 否 |
| 公开范围 | 私享（Private，仅受信任的测试人员 / 指定 Google 群组） |
| 地理分布 | 香港 |

> 小范围测试不要选“公开”。“不公开列出（Unlisted）”允许任何拿到商店链接的人安装；“私享（Private）”才会把安装权限限制在开发者帐号中配置的受信任测试人员和指定 Google 群组。所有公开范围都需要经过 Chrome Web Store 的相同审核流程。

### 测试人员配置

1. 在开发者信息中心的帐号设置中添加受信任的测试人员，确认每个邮箱都关联 Google 帐号；人数较多时可添加自己拥有或管理的 Google 群组。
2. 在该商品的“分发”页选择“私享（Private）”，并选择允许安装的测试人员或群组。
3. 审核并发布后，只把商店链接发给已授权测试人员；未授权帐号即使拿到链接也无法安装。

### 审核测试说明

AC-UST 的完整功能需要登录 HKUST Smart Power Meter。提交审核前，在“测试说明”页提供审核员可使用的测试帐号和以下步骤；不要填写开发者本人的日常帐号：

1. 登录 `https://w5.ab.ust.hk/njggt/app/home`，保持冷气控制页可访问。
2. 打开扩展弹窗，设置开启/关闭分钟数并启用 PWM。
3. 检查扩展能够读取开关状态、设置 `Power-off after` 并显示下一次切换时间。
4. 说明测试帐号是否连接真实冷气设备，以及审核时允许执行的操作范围。

如果无法提供可供审核员使用的 HKUST 测试帐号，应在提交前先确认审核团队接受的替代验证方式；仅设置为私享不会跳过审核。

## ZIP 上传

运行 `bash ./build.sh` 后，上传 `releases/ac-ust-v0.6.11.zip`。ZIP 内直接包含 `manifest.json`，没有额外的 `dist/` 外层目录。

## 发布流程

1. 运行构建与自动化测试，确认版本、ZIP 内容和图标均通过验证。
2. 在开发者信息中心上传 `releases/ac-ust-v0.6.11.zip`。
3. 填写商品详情、隐私声明、权限理由和 HKUST 登录所需的审核测试说明。
4. 在“分发”页选择“私享（Private）”，配置受信任测试人员或 Google 群组，并将地区限制为香港。
5. 提交审核时选择推迟发布；审核通过后在 30 天内手动发布并把商店链接发给测试人员。

## 支持

- GitHub：https://github.com/BelugaRex/ac-ust
- Issues：https://github.com/BelugaRex/ac-ust/issues
