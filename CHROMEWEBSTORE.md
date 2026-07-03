# AC-UST — Chrome Web Store Listing Metadata

> 这些内容用于 Chrome Web Store 开发者信息中心的上架填写。
> 上架入口：https://chrome.google.com/webstore/devconsole

## 基本信息

| 字段 | 值 |
|------|-----|
| 名称 | AC-UST |
| 版本 | 0.4.43 |
| 类别 | 工作效率 (Productivity) |
| 语言 | 中文（简体）、English |
| 非交易者账号 | ✅ |

## 详细说明（中文 / zh-CN）

```
AC-UST 是一款为香港科技大学智能电表系统（Smart Power Meter）设计的自动冷气控制扩展。

主要功能：
• 一键开关冷气：无需手动在页面上点击 Ant Design 开关
• PWM 循环定时：可独立设置"开启分钟数"和"关闭分钟数"，自动循环运行
• 时钟模式：单数整点开、双数整点关，简单省心
• 看门狗自愈：定时闹钟异常时自动恢复，确保定时任务稳定运行
• 余额保护：冷气余额不足时自动避免开启，防止浪费
• 中英双语：支持中文和英文界面自动切换

支持香港科技大学 w5.ab.ust.hk 智能电表系统。
开源地址：https://github.com/BelugaRex/ac-ust
```

## Detailed Description (English / en)

```
AC-UST is an automatic air-conditioning controller for the HKUST Smart Power Meter system.

Features:
• One-click AC toggle - no manual Ant Design switch clicking
• PWM cycle timer - independently set "on minutes" and "off minutes" for automatic cycling
• Clock mode - on at odd hours, off at even hours, simple and reliable
• Watchdog self-healing - auto-recovery from alarm anomalies
• Balance protection - prevents turning on when balance is low
• Bilingual UI - Chinese & English auto-switching

Supports HKUST Smart Power Meter at w5.ab.ust.hk.
Open source: https://github.com/BelugaRex/ac-ust
```

## 隐私信息

| 字段 | 值 |
|------|-----|
| 单一用途说明 | 自动控制 HKUST Smart Power Meter 冷气开关，提供 PWM 循环定时、时钟模式、余额保护等功能 |
| 远程代码 | 否，不使用远程代码 |
| 隐私政策 URL | https://github.com/BelugaRex/ac-ust/blob/beta-rex/PRIVACY.md |
| 数据收集 | 不收集任何用户数据（所有配置仅存储在 chrome.storage.local） |

## 权限理由

| 权限 | 理由 |
|------|------|
| `alarms` | 定时开关冷气（PWM 循环定时 + 时钟模式） |
| `storage` | 存储用户的定时设置（开关分钟数、时钟模式、PWM 状态） |
| `tabs` | 自动打开/刷新冷气控制页面以执行开关操作 |
| `offscreen` | Service Worker 冗余保活，防止后台调度被浏览器终止 |
| `scripting` | 在冷气页面未加载扩展脚本时兜底注入 content script |
| `host_permissions: w5.ab.ust.hk` | 仅用于读取冷气状态、执行开关操作 |

## 图片资源

| 资源 | 尺寸 | 说明 |
|------|------|------|
| 商店图标 | 128×128 | 使用 `icons/icon128.png` |
| 屏幕截图 | 1280×800 | 至少 1 张（popup 界面 + AC 控制效果） |
| 小宣传图块 | 440×280 | 可选 |
| 滚动宣传图块 | 1400×560 | 可选 |

## 分发设置

| 字段 | 值 |
|------|-----|
| 应用内购买 | 否 |
| 公开范围 | 公开 |
| 地理分布 | 所有地区 |

## ZIP 上传

```powershell
# 生成 dist/ 并打包 ZIP
.\build.ps1
Compress-Archive -Path dist\* -DestinationPath ac-ust-v0.4.43.zip
```

## 发布流程

1. 上传 ZIP → 填写商品详情 → 填写隐私 → 设置分发 → 提交审核
2. 审核时间：通常 1-3 个工作日
3. 建议勾选"推迟发布"，审核通过后手动发布

## Extension Overview
- **Name**: AC-UST
- **Version**: 0.4.3
- **Manifest**: MV3
- **Category**: Productivity / Utilities

## Short Description (132 chars max)
Auto-control HKUST Smart Power Meter air conditioning with clock-synced PWM scheduling. Odd hours ON, even hours OFF. Save balance effortlessly.

## Detailed Description
AC-UST automatically controls the air conditioning switch on the HKUST Smart Power Meter web portal (w5.ab.ust.hk). It uses a clock-synchronized PWM (Pulse Width Modulation) schedule to toggle the AC on and off at precise hour boundaries:

- **Clock Mode (default)**: AC turns ON at odd-numbered hours (1:00, 3:00, 5:00...23:00) and OFF at even-numbered hours (0:00, 2:00, 4:00...22:00).
- **Interval Mode**: Custom ON/OFF minute intervals with manual override.

Key features:
- One-click "Timer ON" / "Timer OFF" from the popup
- Real-time countdown to next toggle with clock-time display
- Badge shows minutes remaining until next action
- Auto-confirms page dialogs (no manual clicking needed)
- Reliable background execution with heartbeat keepalive
- Stabilization verification prevents UI rollback false-positives
- Pinned AC page support for faster toggling

## Permissions Justification
| Permission | Why Needed |
|-----------|------------|
| `alarms` | Schedule PWM toggles at precise wall-clock times |
| `storage` | Save user settings (clock mode, intervals, schedule state) |
| `tabs` | Find and interact with the HKUST Power Meter page |
| `offscreen` | Keep Service Worker alive for reliable background timing |
| `scripting` | Fallback injection if content script is not loaded |

## Host Permissions
- `https://w5.ab.ust.hk/njggt/app/*` — Required to read AC status, click the switch, and read balance on the HKUST Smart Power Meter portal.

## Screenshots
<!-- Add paths to screenshots after capturing -->
- `screenshots/popup-clock-mode.png` — Popup showing clock mode with countdown
- `screenshots/popup-interval-mode.png` — Popup showing interval mode
- `screenshots/ac-page.png` — AC control page with extension badge

## Privacy
- No data collection
- No analytics
- No external network requests beyond the HKUST portal
- All settings stored locally via chrome.storage.local

## Support
- GitHub: https://github.com/BelugaRex/ac-ust
- Issues: https://github.com/BelugaRex/ac-ust/issues
