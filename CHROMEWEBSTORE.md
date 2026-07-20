# AC-UST — Chrome Web Store Listing Metadata

> 这些内容用于 Chrome Web Store 开发者信息中心的上架填写。
> 上架入口：https://chrome.google.com/webstore/devconsole

## 基本信息

| 字段 | 值 |
|------|-----|
| 名称 | AC-UST |
| 版本 | 0.5.13 |
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
• 页面定时关机：使用 UST 页面自带的 Power-off after 定时器执行关机；写入后从新鲜页面回读确认，失败自动重试且避免重复点击开关
• 跨设备相位对齐：同浏览器生态通过浏览器同步补充对齐，UST 页面定时器负责跨浏览器关机相位校验
• 看门狗与自愈：自动恢复缺失的后台闹钟，并提供一键诊断
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
• Timer-based shutdown through the portal's Power-off after control, verified from a fresh page after writing and retried on failure without repeated OFF clicks
• Cross-device phase alignment using browser sync plus the UST page timer
• Watchdog recovery and a built-in diagnostics panel
• Chinese and English UI with Crowdin-based community localization

Do not run independently configured copies in both Chrome and Edge at the same time.

Supports HKUST Smart Power Meter at w5.ab.ust.hk.
Open source: https://github.com/BelugaRex/ac-ust
```

## 隐私信息

| 字段 | 值 |
|------|-----|
| 单一用途说明 | 自动控制 HKUST Smart Power Meter 冷气，提供 PWM 循环、运行时段、页面定时关机和状态诊断 |
| 远程代码 | 否，不加载或执行远程代码 |
| 隐私政策 URL | https://github.com/BelugaRex/ac-ust/blob/main/PRIVACY.md |
| 数据收集 | 不收集、出售或传输个人数据；设置仅保存在浏览器 `storage.local` / `storage.sync` |
| 外部网络 | 仅访问用户主动登录的 HKUST Smart Power Meter 页面 |

## 权限理由

| 权限 | 理由 |
|------|------|
| `alarms` | 调度 PWM 周期、运行时段边界、看门狗和页面定时器重试 |
| `storage` | 保存本地设置与运行状态，并在同一浏览器生态内同步精简后的 PWM 配置和相位 |
| `tabs` | 查找或按需打开 HKUST 冷气页面，以读取状态、开机和设置页面关机定时器 |
| `offscreen` | 提供 Service Worker 冗余保活，提升后台调度可靠性 |
| `scripting` | 页面脚本未就绪时兜底注入隔离世界与主世界脚本 |
| `host_permissions: https://w5.ab.ust.hk/*` | 仅在 HKUST Smart Power Meter 页面读取冷气状态、执行开机和设置关机定时器 |

## 图片资源

| 资源 | 尺寸 | 路径 |
|------|------|------|
| 商店图标 | 128×128 | `icons/icon128.png` |
| 屏幕截图 | 1280×800 | `store-assets/` |
| 小宣传图块 | 440×280 | `store-assets/` |
| 滚动宣传图块 | 1400×560 | `store-assets/` |

## 分发设置

| 字段 | 值 |
|------|-----|
| 应用内购买 | 否 |
| 公开范围 | 公开 |
| 地理分布 | 所有地区 |

## ZIP 上传

运行 `./build.ps1` 后，上传 `releases/ac-ust-v0.5.13.zip`。ZIP 内直接包含 `manifest.json`，没有额外的 `dist/` 外层目录。

## 发布流程

1. 运行构建与自动化测试，确认版本、ZIP 内容和图标均通过验证。
2. 在开发者信息中心上传 `releases/ac-ust-v0.5.13.zip`。
3. 检查商品详情、隐私声明和权限理由后提交审核。
4. 建议选择推迟发布，审核通过后手动发布。

## 支持

- GitHub：https://github.com/BelugaRex/ac-ust
- Issues：https://github.com/BelugaRex/ac-ust/issues
