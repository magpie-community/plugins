# agentrouter

给 magpie / OpenCode 接入 [agentrouter.org](https://agentrouter.org/)：模型调用、余额与用量、每日签到、可自定义请求头。单文件 `index.mjs`，零依赖 ESM。

## 安装

```bash
# Docker：克隆到 magpie 配置卷的本地插件目录
VOL=/path/to/magpie/config
mkdir -p "$VOL/magpie/local-plugins"
git clone https://github.com/22952497/agentrouter-magpie.git "$VOL/magpie/local-plugins/agentrouter"
docker exec magpie magpie plugin add /config/magpie/local-plugins/agentrouter

# 本地
git clone https://github.com/22952497/agentrouter-magpie.git
magpie plugin add /path/to/agentrouter-magpie
```

## 登录

```bash
docker exec -it magpie magpie plugin login agentrouter
```

| 方式 | 需要 | 能读什么 |
|---|---|---|
| GitHub 登录（推荐） | 系统访问令牌 → 浏览器授权 → 粘贴回调整条 URL | API key、session、用户 ID、余额 |
| API 密钥 | `sk-…` | 对话、模型列表、累计消耗（余额未知） |

- **系统访问令牌**在官网「个人设置 → 访问令牌」，不是 `sk-…`，也不是 GitHub Token。
- 授权后浏览器显示「页面未找到」是**正常的**，直接从地址栏复制整条 URL（含 `code=…`）粘贴回终端。
- API 密钥登录时，「请求端点」一问**只填地址或留空**，不要把 `sk-…` 填进去。

## 验证

```bash
docker exec magpie magpie provider test agentrouter
docker exec magpie magpie provider models agentrouter
docker exec magpie magpie quota agentrouter
```

## 客户端配置

- Base URL：`https://你的-magpie-域名/v1`（本地 `http://localhost:3425/v1`）
- API Key：magpie 的 Caller Key
- 模型：`agentrouter/gpt-5.6-sol`、`agentrouter/gpt-6-astra`、`agentrouter/gpt-6.1-sol`（或你配置的全局名）

> 网关强制校验客户端标识，插件默认自动附带官方兼容请求头，日常无需额外配置。

## 行为要点

- **请求头**：网关只认自家客户端标识，浏览器 UA / `curl` 会 401。插件默认发 `codex_cli_rs`，可在 provider 或账号级 `headers` 覆盖（一行一个 `Name: value`）。
- **余额缓存**：按站点、用户 ID 和凭据分别保存上次完整读数，重启后仍可使用。网站加载时返回的 `quota: 0 / used_quota: 0`、验证码或查询失败不会覆盖缓存；卡片会注明「缓存」及读取时间。正常读数立即更新，`quota: 0` 且有历史消耗仍会显示真实的零余额。没有缓存时显示「余额仍在加载」或「累计消耗 $…；剩余额度未知」。
- **登录后查余额**：登录响应的两个额度字段都为零时，用刚登录得到的 session 再读正式余额接口；返回的用户 ID 必须与账号配置一致。
- **签到 = 登录一次**：站点在登录时发额度；需要站点用户名 + 密码，GitHub 登录的账号可能没有密码。
- **协议**：只有 `/v1/responses`，不支持 `/v1/chat/completions`（由 magpie 网关翻译）。
- **内容过滤的 400 ≠ 限流**：`code:"content-blocked"` 是某些词 / 自指句式被拦，改写那句话才过；插件会改写说明，避免被误当 429 重试或转移。
- **真正的 429** 是每分钟 token 上限（Azure 口径），等约一分钟并降低并发；`maxConcurrency` 已设为 2。
- **请求体清理**：上游多节点，请求方向剥离节点绑定字段（`previous_response_id`、item/message `id`、`encrypted*` 与 reasoning、失败 assistant 消息、`tools` 的 `$schema` / `required` / `items:null`、DeepSeek 的 `thinking`）。不改状态码与正常响应，解析失败原样透传。

> 代价：剥离后模型不再跨轮接续隐藏思维链，每轮重新推理；对话内容与工具调用不受影响。

## 配置文件

也可手动编辑 `<magpie 配置目录>/magpie/plugin-auth.json`：

```json
{
  "agentrouter": {
    "type": "api",
    "key": "sk-…",
    "metadata": {
      "endpoint": "https://agentrouter.org",
      "site": "org",
      "username": "（密码签到时填）",
      "password": "（只存本机）",
      "cookie": "session=…",
      "userId": "…",
      "headers": "User-Agent: codex_cli_rs/0.101.0"
    }
  }
}
```

改完重启 magpie。改请求头可用 `./set-ar-headers.sh 'User-Agent: codex_cli_rs/0.101.0'`（传 `''` 清空）。

magpie 的余额缓存保存在 `<magpie 配置目录>/agentrouter-balance-cache/`；OpenCode 使用 `${XDG_CACHE_HOME:-~/.cache}/magpie/agentrouter-balance-cache/`。文件只保存额度、账号显示名和读取时间，不保存 API key、访问令牌、Cookie 或密码。缓存表示上次读数，实际余额以网站完成加载后的结果为准。

## 文件

- `index.mjs` — 插件本体
- `package.json` — 包描述
- `usage.test.mjs` — 单元测试（`npm test`）
- `set-ar-headers.sh` — 改请求头小工具

## 排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `/v1` 一律 401 unauthorized client detected | 自定义头里放了浏览器 UA | 清掉该头，用默认 |
| 某模型 503 无可用渠道 | 面板列的是已下架模型 | 用站点真实模型列表或关掉该模型 |
| 刷新后短暂出现零余额 | 网站的两个额度字段尚未加载 | 自动保留上次完整读数，稍后刷新 |
| 余额显示旧值 | 网站未就绪、验证码或读取失败时保留缓存 | 看卡片中「缓存」后的读取时间 |
| 用户 ID 不一致 | 备用登录用户名对应了另一个账号 | 核对该账号的用户 ID 和登录用户名 |
| 所有模型无响应且无报错 | 旧版把 `sk-…` 存进了 endpoint | 本版已修，重新保存即可 |

## License

MIT
