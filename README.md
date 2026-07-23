# AC-UST ❄️

Chrome 扩展 — 自动控制 HKUST Smart Power Meter 冷气开关，支持 PWM 循环定时。

## 功能

- **PWM 循环定时**：自定义"开 X 分钟 / 关 Y 分钟"持续循环，自动控制冷气开关
- **运行时段**：设置每天运行时段（如 08:00-23:00），时段外自动停机省电
- **跨设备同步**：多台设备运行扩展时自动对齐 PWM 循环，不会同时反复开关同一台空调
- **自动确认弹窗**：自动处理浏览器原生 `confirm` 和 Ant Design 确认框
- **后台运行**：即使关闭弹窗，定时任务仍在 Service Worker 中执行
- **关机确认**：设置 `Power-off after` 后保留写入页，改由独立新鲜页按 `3/5/10` 秒退避回读同一时间；未确认时自动重试，不把本页刚显示的值当作成功
- **诊断面板**：一键查看闹钟、storage、content script 状态，自动修复常见问题
- **易读与低干扰**：默认提供更清晰的文字、状态反馈和减弱动态效果适配；可按需开启易读模式，放大文字并放宽排版
- **中英双语**：支持中文/English，通过 Crowdin 社区翻译更多语言

## 📦 获取

| 方式 | 说明 |
|------|------|
| **[Chrome Web Store](https://chromewebstore.google.com)** | 即将上架，一键安装自动更新 |
| **开发者模式** | `git clone` → `./build.ps1` → Load Unpacked `dist/` |
| **GitHub Releases** | 下载源码 ZIP，解压后运行 `./build.ps1`，再 Load Unpacked `dist/` |

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
| 定时开关 | 拨动开关开启/关闭 PWM 定时循环（开启时先开冷气） |
| 开启分钟 | 每次开启冷气持续多少分钟（修改后自动重启循环） |
| 关闭分钟 | 每次关闭冷气持续多少分钟（修改后自动重启循环） |
| 运行时段 | 设置每天运行时段（如 08:00-23:00），时段外自动停机 |
| 显示与舒适度 | 按需开启易读模式；文字会更大、行距与字距更宽，非必要动态效果更少 |

> 💡 **重要**：请将 UST AC 页面在浏览器中**固定标签页**并保持开启，否则定时开关无法控制空调。

> ⚠️ **不要同时在 Chrome 和 Edge 上使用 AC-UST**
>
> Chrome 与 Edge 的浏览器账号同步互不互通，`chrome.storage.sync` 只在同浏览器生态内有效。虽然 UST 页面定时器能跨浏览器同步「关」相位，但 **运行时段**、**开/关分钟数** 等配置无法跨浏览器同步。同时使用会导致两台设备各自跑独立 PWM 循环（配置不同步），同一台空调被反复开关。
>
> **建议**：选择一个浏览器生态（全 Chrome 或全 Edge），不要混用。同生态内多设备会自动对齐 PWM 循环。

## 项目结构

```
ac-ust/
├── build.ps1          # 打包脚本 — 生成稳定版到 dist/
├── manifest.json      # 扩展配置（版本真相源）
├── background.js      # Service Worker — 定时调度 + 看门狗 + 自愈
├── content.js         # Content Script — 页面状态读取与回退验证
├── page-confirm.js    # 主世界注入 — 接管弹窗 + AntD 开关点击
├── popup.html         # 弹窗界面（Apple Design System CSS）
├── popup.js           # 弹窗逻辑 + 诊断 + 保活连接
├── i18n.js            # fetch-based 国际化加载器
├── sync-helpers.js    # 跨设备同步纯函数（chrome.storage.sync + page timer 对齐）
├── offscreen.js       # 冗余保活心跳
├── offscreen.html     # offscreen 入口
├── _locales/          # 翻译文件（zh_CN + en，Crowdin 同步）
├── icons/             # 扩展图标
└── test/              # 单元测试 + e2e + 图标验证
```

## 🌐 本地化 / Localization

想让 AC-UST 支持你的语言？**不需要懂代码**，只需两步：

### 方式一：通过 Crowdin（推荐）

1. 访问 [Crowdin 项目页面](https://crowdin.com/project/ac-ust) — 已连接 GitHub，修改会自动开 PR
2. 选择你的语言，在网页上对照源文本填写翻译
3. 提交后 Crowdin 会自动向 GitHub 开 PR，合并即生效

### 方式二：直接编辑 JSON 文件

1. 复制 `_locales/en/messages.json` → 改名为你的语言代码（如 `ja/`、`ko/`、`fr/`）
2. 把每个 `"message"` 的值翻译成你的语言
3. 注意：`$1`、`$2` 等是占位符，**保留不动**
4. 提交 PR 到本仓库

语言代码参见 [Chrome 支持的语言](https://developer.chrome.com/docs/webstore/i18n?hl=zh-cn#localeTable)。

## 贡献指南

> ⚠️ **不要直接向 `main` 分支提交代码。** `main` 是稳定发布分支，只接受经过充分测试的变更。

### 分支策略

| 分支 | 用途 | 说明 |
|------|------|------|
| `main` | 稳定发布版 | ❌ 禁止直接推送，仅接受来自 `beta-rex` 的合并 |
| `beta-rex` | 项目作者的开发主线 | ❌ 请勿推送，这是作者的个人开发分支 |

> 外部贡献者请 **Fork 仓库** → 在自己的 Fork 上创建分支 → 向 `beta-rex` 提 PR。

### 提交流程

```bash
# 1. Fork 本仓库（在 GitHub 页面点右上角 Fork）

# 2. Clone 你的 Fork
git clone https://github.com/你的用户名/ac-ust.git
cd ac-ust

# 3. 创建你自己的开发分支（不要用 beta-rex）
git checkout -b my-cool-feature

# 4. 开发、测试
#    （修完代码必须跑 node test/verify-fix.mjs）

# 5. 提交并推送
git add .
git commit -m "feat: 描述你的改动"
git push origin my-cool-feature

# 6. 在 GitHub 上创建 PR → 目标仓库选 BelugaRex/ac-ust，目标分支选 beta-rex
```

### 规则

- **不要直接推送到 `beta-rex` 或 `main`** — 这是作者的分支，请通过 PR 贡献
- **一个 PR 做一件事**，方便 review
- **先跑测试再 commit**：`node test/verify-fix.mjs`
- **翻译贡献**：通过 [Crowdin](https://crowdin.com/project/ac-ust) 或直接编辑 `_locales/` 下的 JSON 文件
- **Crowdin 自动 PR**：如果内容全是源语言（未翻译），直接关闭即可；有真正翻译时再合并

## 技术栈

- Chrome Extension Manifest V3 · Vanilla JavaScript（零框架依赖）
- Chrome Alarms API + Storage API + Scripting API
- Apple Design System CSS（SF Pro / Inter 字体，毛玻璃 UI）
- fetch-based i18n（Crowdin 社区翻译）
- 跨设备同步（chrome.storage.sync + UST 页面定时器服务器同步）
- Service Worker 保活（heartbeat + offscreen + waitUntil）

## 故障排查

- `onMinutes` / `offMinutes` 是**静态配置**，会像表单值一样持久化保存。
- `nextTriggerAt` 是**运行时派生值**，表示当前 PWM 阶段的未来切换时刻；它会随着每一轮开/关切换而变化。
- 如果诊断里出现“`ac-pwm` 闹钟存在，但 storage 绝对触发时间缺失”，通常表示后台在创建/恢复闹钟后，`nextTriggerAt` 没有及时回写到 storage。
- 当前实现会优先以 live `ac-pwm` 的 `scheduledTime` 纠偏 `nextTriggerAt`，并在读取 AC 状态时优先询问主世界脚本，避免隔离世界把 `ON` 误读成 `OFF`。
- `Power-off after` 的本页输入值不是最终凭据：扩展会保留写入页，以隐藏的新鲜页面按 `3/5/10` 秒退避读回相同的 `HH:MM` 后才推进到下一关机阶段。验证失败会保留安全相位并重试；浏览器重启后错过的 retry 也会重新排程，且不会刷新你正在看的 AC 页面。
- 如果后续仍复现“alarm 还在但时间丢失”，下一步应把阶段检查点（例如 `alarmCreatedAt`、`alarmDelayMinutes`、`pwmState`）进一步提升为正式真相源，由它们重算 `nextTriggerAt`。

## License

MIT
