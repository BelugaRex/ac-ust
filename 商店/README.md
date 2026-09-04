# AC-UST Chrome Web Store 提交包

本目录集中保存 Chrome Web Store 商品页需要复制或上传的资料。运行代码、构建产物和真实审核凭据不放在这里。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `CHROMEWEBSTORE.md` | 基本信息、双语短/长说明、`0.8.7` 更新说明、数据使用、权限理由、审核步骤与发布设置 |
| `PRIVACY.md` | Chrome Web Store 隐私政策 URL 指向的正式原文 |
| `素材/icon-128.png` | 128×128 商店图标；内容必须与 `../icons/ac-ust_128.png` 一致 |
| `素材/screenshot-1.png`、`素材/screenshot-2.png` | 1280×800 商品页截图 |
| `素材/promo-small.png` | 440×280 小宣传图块 |
| `素材/promo-marquee.png` | 1400×560 滚动宣传图块 |
| `素材模板.html`、`生成素材.mjs` | 从当前 `dist/popup.html` 可复现生成上述两张截图与两张宣传图，不上传到商店 |

## 提交前清单

1. 运行完整构建与测试，确认 `manifest.json`、文案版本和 ZIP 文件名一致。
2. 上传 `../releases/ac-ust-v0.8.7.zip`；ZIP 由 `../build.sh` 生成，不在本目录保存第二份。
3. 从 `CHROMEWEBSTORE.md` 复制对应语言的短说明、详细说明与 `0.8.7` 更新说明。
4. 上传 `素材/` 内的图标、两张截图和宣传图。
5. 隐私政策填写 `CHROMEWEBSTORE.md` 所列 GitHub URL，并按表格如实声明 UST 页面内容的本地处理、浏览器同步及香港天文台天气请求；合并到公开 `main` 后先确认该 URL 可匿名访问且返回政策正文，再提交审核。
6. 在开发者信息中心单独填写审核测试帐号与允许操作范围；**不得把帐号、密码、Cookie 或 token 写入本仓库**。
7. 选择私享（Private）、香港地区与推迟发布；审核通过后再由作者手动发布。

## 维护规则

- `manifest.json` 是版本真相源；PATCH bump 后同步本目录内所有版本号与 ZIP 文件名。
- 商店图标是运行图标的提交副本；自动测试会校验两者字节一致。
- 更新 popup 或商品卖点后，先构建 `dist/`，再运行 `生成素材.mjs` 重制图片；脚本需要本机已有 Playwright，并通过 `AC_UST_STORE_PREVIEW_URL` 读取本地静态服务器。
- `PRIVACY.md` 必须描述真实网络行为：仅与用户登录的 UST 门户、香港天文台开放数据接口及用户启用的浏览器同步服务通信，不得使用“完全不访问外部服务”之类绝对表述。
- 截图或宣传图更新时保持现有尺寸和 PNG 格式。

## 重制商品图

1. 在仓库根目录运行 `bash ./build.sh`，确保 `dist/` 是当前版本。
2. 在仓库根目录启动静态服务器，例如 `python3 -m http.server 8765 --bind 127.0.0.1`。
3. 在另一个终端运行 `node 商店/生成素材.mjs`；如使用其他端口，通过 `AC_UST_STORE_PREVIEW_URL` 指定根 URL。
4. 运行完整测试，确认图片尺寸、商店图标字节一致性和商品页版本守门全部通过。