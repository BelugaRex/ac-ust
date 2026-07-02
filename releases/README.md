# AC-UST 公测版本

## ⚠️ CRX 安装限制

从 v0.4.42 起，Chrome/Edge **不再允许**通过拖拽/双击安装非 Chrome Web Store 来源的 CRX 文件。
下载 `.crx` 后直接拖入 `chrome://extensions` 会报错：

> 包无效：`crx_required_proof_missing`

这是因为浏览器要求 CRX 必须带有 **Chrome Web Store 的数字签名**（`required_proof`），
本地 `--pack-extension` 打包的 CRX 没有此签名，会被浏览器拒绝。

## 推荐安装方式

### 方式一：Load Unpacked（推荐，所有平台通用）

1. 克隆或[下载 ZIP](https://github.com/RexYip/ac-ust/archive/refs/heads/beta-rex.zip) 解压
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 开启右上角 **开发者模式**（Developer mode）
4. 点击 **加载已解压的扩展程序**（Load unpacked）
5. 选择解压后的 `dist/` 文件夹（不是源码根目录）

> 如果仓库没有预构建的 `dist/`，先运行 `./build.ps1`（Windows PowerShell）生成。

### 方式二：Chrome Web Store（即将上架）

待上架后，直接在 Chrome Web Store 一键安装，自动更新。

### 方式三：企业策略部署（IT 管理员）

CRX 文件可用于企业策略强制安装（`ExtensionInstallForcelist`），
需配合 `update.xml` 清单托管在 HTTPS 服务器上。适合组织批量部署。

此目录存放打包好的 CRX 文件，供公测用户下载安装。

## 安装方法

1. 下载 `.crx` 文件
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 开启 **开发者模式**（Developer mode）
4. 将 `.crx` 文件拖入浏览器窗口
5. 确认安装

## 版本说明

文件名格式：`ac-ust-vX.Y.Z.crx`

- **v0.x** — 公测版本，功能可能不稳定
- 每个版本均用同一私钥签名，更新时会保留数据

## 反馈

如有问题请提交 [GitHub Issue](https://github.com/Rex-C/w5-ab-ust-hk-ac/issues)。
