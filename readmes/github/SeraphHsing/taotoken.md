# TaoToken CodingPlan for magpie / OpenCode

`@magpie-community/opencode-taotoken-auth` — 把 [taotoken.net](https://taotoken.net) 的 CodingPlan 作为一个供应商接入 magpie（兼容 OpenCode）：

- **模型调用**：用你的 TaoToken API key（`sk-…`）访问 CodingPlan 网关 `https://api.taotoken.net/coding/v1`（OpenAI 兼容）。
- **用量卡片**：在你 magpie 的账号卡片上显示 CodingPlan 三档计次限额——**5 小时 / 本周 / 本月**（已用 / 上限 / 刷新时间），数据来自 `GET /v1/plan/overview`，需登录令牌。用量随 magpie 自身的概览/用量页刷新时机读取，每次最新数据。
- **令牌自动续期**：登录令牌约 30 天有效；到期前 7 天 magpie 会自动从本机已登录浏览器捕获新令牌续期，全程通过 magpie 通知（toast/日志）告知你。

## 安装

```bash
magpie plugin add ./           # 在本仓库目录下
# 或发布后: magpie plugin add @magpie-community/opencode-taotoken-auth
```

然后在 magpie 中对 `taotoken` 供应商登录（`magpie plugin login taotoken` 或应用界面）。

## 登录需要两个凭证

一个账号同时要两个凭证，填在同一个登录表单里：

| 输入框 | 用途 | 怎么拿 |
|---|---|---|
| **API key**（必填） | 模型调用 | taotoken 控制台 → [API Keys](https://taotoken.net/console/api-keys) → 创建 key（`sk-…`） |
| **用量令牌**（选填） | CodingPlan 用量卡片 | 浏览器登录 taotoken.net → `F12` → 应用(Application) → Cookie → `taotoken.net` → 复制 **`token`** 字段的值（一长串 JWT，以 `eyJ…` 开头） |

> 两个都是账号主人的秘密，magpie 只存在本机 `plugin-auth.json`（权限 600）里。

## 令牌有效期与自动续期

**为什么需要续期**：taotoken 的登录令牌（用量读取使用的 JWT）有效期固定 **30 天**（无刷新令牌接口、不滑动续期），到期后用量接口返回 401。

**怎么自动续期**：插件在每次读取用量时，把令牌到期时间同步到 magpie 账号的 `expires` 字段；到期前 **7 天** magpie 会自动调用插件的 `auth.refresh`，从本机已登录的浏览器（调试端口）抓取最新令牌写回账号。续期前提是你本机浏览器开着 taotoken 的登录态，且以调试端口运行。

- 到期前 7 天：用量卡片套餐行提示「登录令牌 X 天后到期（YYYY-MM-DD）」，同时 magpie 弹出一条通知（toast）并写入日志，每天最多一次。
- 自动续期成功：magpie 通知「令牌已自动续期，有效期至 <日期>」。
- 自动续期失败（浏览器没开调试端口 / 未登录）：magpie 通知告警，插件继续使用原令牌直到过期（不会误标账号登出）。

### 让浏览器常驻调试端口（Windows）

```powershell
# Edge（默认）
.\scripts\start-browser-debug.ps1

# 其他 Chromium 系浏览器
.\scripts\start-browser-debug.ps1 -Browser chrome   # 支持 msedge/chrome/brave/arc/opera/vivaldi
.\scripts\start-browser-debug.ps1 -Browser msedge -Port 9223
```

脚本会探测目标端口：已在监听则直接完成；未监听则先关闭该浏览器窗口、再以 `--remote-debugging-port` 和默认 profile 重新启动并打开 taotoken 控制台（登录态不丢）。亦可手动启动：浏览器以 `--remote-debugging-port=9222` 启动并登录 taotoken.net 即可。

> Firefox：以 `firefox --remote-debugging-port=9222` 启动也可被探测，但 Firefox 对 CDP 的 cookie 接口支持有限，失败时建议改用 Chromium 系浏览器。

### 手动续期与计划任务（备选）

```bash
# 先看新旧令牌到期时间（不改文件）
node scripts/refresh-token.mjs --dry-run

# 从浏览器捕获最新令牌并写回 plugin-auth.json（自动备份，其他账号不受影响）
node scripts/refresh-token.mjs
```

写完请重启 magpie 应用让新令牌生效。定期自动续期可用 Windows 计划任务：

```bash
node scripts/refresh-token.mjs --task   # 打印可直接复制的 schtasks 命令
```

## 模型

登录前默认列出（CodingPlan 网关实测）：

- `glm-5.3-flash` — GLM-5.3-Flash（context 1M）
- `deepseek-flash` — deepseek-flash（context 1M）

登录后会按你的账号从 `GET /coding/v1/models` 拉取实际模型列表覆盖；拉取失败时保留上一份。

## 常见问题

- **用量显示 "HTTP 401"**：用量令牌已过期或无效。在浏览器登录 taotoken 后运行 `node scripts/refresh-token.mjs`（或重新登录插件复制新令牌）；日常应靠自动续期避免。
- **用量显示 "当前账号没有生效的 CodingPlan 用量"**：该账号没订阅 CodingPlan，或处于生效期之外。
- **模型请求 401**：API key 无效或被吊销，重新在控制台创建。
- **模型请求 403/404**：该模型不在你的套餐内（用 `.coding/v1/models` 列出的模型）。
- **续期通知提示"自动续期未完成"**：本机浏览器未以调试端口运行或未登录 taotoken，运行 `start-browser-debug.ps1` 后手动执行一次续期即可。

## 开发

零运行时依赖（Node ≥ 18 / Bun）。入口 `index.mjs`。

```bash
npm test                              # node --test test/（本地与 UTC 时区均通过）
```

续期相关脚本：

- `scripts/capture-token.mjs` — 跨浏览器（CDP）捕获 taotoken 登录令牌，供自动续期与手动脚本复用。
- `scripts/refresh-token.mjs` — 手动续期 / 写回 / dry-run / 计划任务示例。
- `scripts/start-browser-debug.ps1` — 以调试端口启动本机浏览器。
- `scripts/probe.mjs`、`scripts/cdp-eval.mjs`、`scripts/cdp-cookies.mjs` — 接口鉴权探测与调试工具。

## License

MIT