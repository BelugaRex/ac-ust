# AC-UST ❄️

Chrome 扩展 — 自动控制 HKUST Smart Power Meter 冷气开关，支持 PWM 循环定时。

## 功能

- **手动开关**：弹窗内一键开启/关闭冷气
- **PWM 循环定时**：自定义"开 X 分钟 / 关 Y 分钟"持续循环
- **自动确认弹窗**：自动处理浏览器原生 `confirm` 和 Ant Design 确认框
- **后台运行**：即使关闭弹窗，定时任务仍在 Service Worker 中执行

## 📦 计划

目前仅通过开发者模式安装。如果觉得好用，欢迎 **⭐ Star** 这个项目 — 等星星够多了我就去注册 Chrome Web Store / Edge Add-ons，打包成正式扩展方便大家一键安装 😄

## 安装

> 💡 **推荐：先用脚本打包到 `dist/`，再加载 dist 文件夹**，这样开发修改不会影响正在使用的扩展。

```bash
# 1. 克隆仓库
git clone https://github.com/BelugaRex/ac-ust.git
cd ac-ust

# 2. 打包到 dist/ 目录（PowerShell）
.\build.ps1

# 3. 打开 Chrome/Edge
#    地址栏输入 chrome://extensions 或 edge://extensions
#    开启「开发者模式」→「加载已解压的扩展」→ 选择 dist 文件夹
```

> 登录 [HKUST Power Meter](https://w5.ab.ust.hk/njggt/app/home) 即可使用。更新代码后重新运行 `.\build.ps1`，再到扩展管理页点刷新图标即可。

## 使用说明

| 操作 | 说明 |
|------|------|
| 启用定时 | 打开开关即开始 PWM 循环（先开冷气） |
| 开启分钟 | 每次开启冷气持续多少分钟 |
| 关闭分钟 | 每次关闭冷气持续多少分钟 |
| 立即开启/关闭 | 手动覆盖，不受定时影响 |
| 保存设置 | 修改分钟后需保存以重启循环 |

## 项目结构

```
ac-ust/
├── build.ps1          # 打包脚本 — 生成稳定版到 dist/
├── manifest.json      # 扩展配置
├── background.js      # Service Worker — 定时调度
├── content.js         # Content Script — 页面开关交互
├── page-confirm.js    # 主环境注入 — 接管原生弹窗
├── popup.html         # 弹窗界面
├── popup.js           # 弹窗逻辑
└── icons/             # 扩展图标
```

## 技术栈

- Chrome Extension Manifest V3
- Vanilla JavaScript (无框架依赖)
- Chrome Alarms API
- Ant Design 开关兼容

## 故障排查

- `onMinutes` / `offMinutes` 是**静态配置**，会像表单值一样持久化保存。
- `nextTriggerAt` 是**运行时派生值**，表示当前 PWM 阶段的未来切换时刻；它会随着每一轮开/关切换而变化。
- 如果诊断里出现“`ac-pwm` 闹钟存在，但 storage 绝对触发时间缺失”，通常表示后台在创建/恢复闹钟后，`nextTriggerAt` 没有及时回写到 storage。
- 当前实现会优先以 live `ac-pwm` 的 `scheduledTime` 纠偏 `nextTriggerAt`，并在读取 AC 状态时优先询问主世界脚本，避免隔离世界把 `ON` 误读成 `OFF`。
- 如果后续仍复现“alarm 还在但时间丢失”，下一步应把阶段检查点（例如 `alarmCreatedAt`、`alarmDelayMinutes`、`pwmState`）进一步提升为正式真相源，由它们重算 `nextTriggerAt`。

## License

MIT
