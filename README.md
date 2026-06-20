# AC-UST ❄️

Chrome 扩展 — 自动控制 HKUST Smart Power Meter 冷气开关，支持 PWM 循环定时。

## 功能

- **手动开关**：弹窗内一键开启/关闭冷气
- **PWM 循环定时**：自定义"开 X 分钟 / 关 Y 分钟"持续循环
- **自动确认弹窗**：自动处理浏览器原生 `confirm` 和 Ant Design 确认框
- **后台运行**：即使关闭弹窗，定时任务仍在 Service Worker 中执行

## 安装

1. 克隆仓库：
   ```bash
   git clone https://github.com/BelugaRex/ac-extension.git
   ```
2. 打开 Chrome/Edge，进入 `chrome://extensions` 或 `edge://extensions`
3. 开启 **开发者模式**
4. 点击 **加载已解压的扩展**，选择项目文件夹
5. 登录 [HKUST Power Meter](https://w5.ab.ust.hk/njggt/app/home) 即可使用

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
ac-extension/
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

## License

MIT
