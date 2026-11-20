# Token 羊毛 · magpie 页面插件

在 [magpie](https://usemagpie.ai) 窗口里，把 [AIHOT · Token 羊毛](https://aihot.news/free-tokens) 的免费额度按**你本机的情况**分三档：
**已配置可用** / **有插件待配置** / **暂无插件**，并对每条给出该装的 magpie 插件或该走的登录路径。

> 状态：可用（页面 + host 取数）。发布到官方社区仓库需 AIHOT 书面授权（见下「合规」）。

## 能力
- 三档速览：已配置可用 / 有插件待配置 / 暂无插件；一次只看一档的紧凑列表。
- 「安装插件」给出**可粘贴到「插件 → 发现 → 已有想装的?」的完整 npm 包名**（并附终端命令）。
- 「去登录」给出「插件 → 已安装 → 该行登录」路径 + `magpie plugin login <provider>`。
- 厂商图标用 magpie 自带品牌图标（`page/brand/`），其余用首字母/首字色块；亮/暗适配。
- 只展示**官方厂商**的额度（`src/allowlist.js` 白名单），不展示第三方中转站。

## 结构
```
index.js            # host：页面打开时拉一次 AIHOT → 分类 → 写 page/data.js（后台不轮询）
src/turbo.js        # free-tokens.data 零依赖解码
src/aihot.js        # 取数（诚实 UA / gzip）
src/inventory.js    # 读 ~/.config/magpie（providers / checkin；读失败=未知）
src/classify.js     # 白名单过滤 + 脱敏（kind 白名单 / url 限 https）+ 三档状态
src/allowlist.js    # 官方厂商白名单
src/mapping.js      # 羊毛→插件（provider → 完整 npm 包名）
page/               # index.html / app.js / style.css / brand/（图标）/ icon.svg（原生 <dialog> 弹层 / tablist 语义 / 亮暗自适应）
NOTICE              # 品牌图标（lobe-icons, MIT）与数据来源署名
test/               # 离线测试（host 分类 + 页面静态校验 + happy-dom 交互测试）
```

## 数据与合规
- 数据来自 AIHOT `free-tokens.data`，**每台机器在插件宿主启动时（通常是你打开该页面时）直连拉一次**，不随包分发、不缓存成可导出数据集、不做镜像。
- 只读本机 `~/.config/magpie` 的插件/供应商/签到状态，不读取任何密钥。
- AIHOT 条款：个人非商业小工具可读；**面向公众的插件需书面授权**。发布到 magpie 社区前需取得 AIHOT 授权并按其要求署名。

## 测试
```bash
bun test
```

## 发布（CI 自动，免令牌）
- **日常推送 / PR**：`.github/workflows/ci.yml` 自动 `bun install` + `bun test`。
- **发布**：推送 `vX.Y.Z` tag 并在 GitHub 创建 Release 后，`.github/workflows/release.yml` 自动「装依赖 → 测试 → 校验 tag 与 package.json 版本一致 → `npm publish`」。
- **认证：npm Trusted Publishing（OIDC），不需要任何令牌。** 一次性在 npm 配置：
  1. npmjs.com → 包 `magpie-free-tokens` → **Settings → Trusted publishing** → 添加 GitHub Actions：
     - Repository owner：`sljdxde`
     - Repository name：`magpie-free-tokens`
     - Workflow filename：`release.yml`
     - Environment：留空
  2. 保存即可，无需生成或保存令牌。
- 之后每次发版只需建 Release，npm 自动出包（带 provenance 来源证明）。

> 旧做法（`NPM_TOKEN` secret + 经典 Automation 令牌）已被 npm 淘汰：经典令牌自 2025-11 起全面撤销，绕过 2FA 的令牌 2027-01 起不能直接发布。本项目已改用 OIDC。

## 安装（本地）
```bash
magpie plugin add "/path/to/this/folder"
```

MIT License（品牌图标版权见 `NOTICE`）。
