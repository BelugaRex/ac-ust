# AC-UST Releases

## 安装方式

### 方式一：Chrome Web Store / Edge Add-ons（推荐）

待上架后，直接在商店搜索 AC-UST 一键安装，支持自动更新。

### 方式二：Load Unpacked（开发者）

1. 克隆或[下载 ZIP](https://github.com/BelugaRex/ac-ust/archive/refs/heads/main.zip) 解压
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 开启右上角 **开发者模式**（Developer mode）
4. 点击 **加载已解压的扩展程序**（Load unpacked）
5. 选择 `dist/` 文件夹（不是源码根目录）

> 如果仓库没有预构建的 `dist/`，先运行 `bash ./build.sh`（WSL/Linux，需 Python 3）生成。

## ZIP 包

`bash ./build.sh` 生成的 `.zip` 文件用于上传 Chrome Web Store / Edge Add-ons，
不是给终端用户直接安装的。

## 反馈

如有问题请提交 [GitHub Issue](https://github.com/BelugaRex/ac-ust/issues)。
