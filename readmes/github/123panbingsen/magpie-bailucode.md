# magpie-bailucode

把 **白鹿（BAILU AI）Open Platform** 接进 [magpie](https://github.com/yetone/magpie)：粘贴一枚 API key，白鹿的模型就出现在 magpie 的模型选择器里，Claude Code / Codex / OpenCode 等 agent 都能直接选。

> BAILU AI (白鹿) provider for magpie — one API key, models discovered from `GET /models`, OpenAI Chat Completions / Anthropic Messages / OpenAI Responses faces on the same gateway.

- key 页面：<https://bailucode.com/api_platform/#api-keys>
- 网关：`https://bailucode.com/openapi/v1`（一个 base，一个 `Authorization: Bearer sk-…`）

## 装法（两种）

| 路径 | 命令 | 何时可用 |
| --- | --- | --- |
| 直接装 GitHub | `magpie plugin add github:123panbingsen/magpie-bailucode` | **现在** |
| magpie 社区索引 | Plugins 页搜「白鹿」或「bailucode」，或 `magpie plugin add @magpie-community/opencode-bailucode-auth` | 索引来自 `magpie-community/plugins` 的 `main/registry.json`，本包的 [PR #1586](https://github.com/magpie-community/plugins/pull/1586) 合并后才出现 |

## 安装

```bash
# 从 GitHub 安装（推荐）
magpie plugin add github:123panbingsen/magpie-bailucode

# 确认装上了
magpie plugin list
```

改代码时直接装本地目录，magpie 会照原样加载：

```bash
magpie plugin add C:/path/to/magpie-bailucode
```

装完后 magpie 的 Providers 里会多出 **BAILU（白鹿）**。

## 添加 key

只要一把 key，没有第二步：

1. GUI：magpie → Providers → **BAILU（白鹿）** → 添加账号 → 粘贴 `sk-…` → 完成。
2. CLI：`magpie plugin login bailucode` → 粘 key。

网关固定为 `https://bailucode.com/openapi/v1`，所以登录时不问地址。要走镜像或自建网关，用插件选项：

```bash
magpie plugin options magpie-bailucode '{"baseURL":"https://your-mirror.example.com/openapi/v1"}'
```

卡片会显示网关是否收下这枚 key；不接受时会直接给出重新生成 key 的链接。

## 协议

网关同一个 base 下同时说三种协议（见下表的实测结果）。默认走 OpenAI Chat Completions，白鹿的 Anthropic 风格（thinking / 工具调用）请切到 `anthropic`：

```bash
magpie plugin options magpie-bailucode '{"protocol":"anthropic"}'
```

可选值：`openai`（默认，`@ai-sdk/openai-compatible`）、`anthropic`（`@ai-sdk/anthropic`）。

其它可注入的选项：`baseURL`（自建/镜像网关）、`models`（追加模型 id）、`headers`（附加请求头）。

## 模型列表从哪来

1. 有 key：`GET {base}/models`，白鹿返回什么就用什么（`{data:[…]}`、`{models:[…]}`、裸数组都认）。
2. 拉不到（key 没配、网关 5xx、被 Cloudflare 拦）：回落到内置清单（`bailu-2.9-preview`、`bailu-2.8`、`bailu-2.7`、`bailu-apex-2.7`、`yuyu-air`），保证 provider 至少可用，不会把模型选择器清空。
3. 你在 magpie 配置里自己写的 `models` 永远最优先，不会被覆盖。

> 内置清单是白鹿公开的模型家族；确切 id、上下文长度一律以 `GET /models` 为准。

## 网关实测（写这个插件时的取证）

用无效 key 直连 `https://bailucode.com`，把「路由存在」和「路由不存在」区分开：

| 路由 | 结果 | 结论 |
| --- | --- | --- |
| `GET /openapi/v1/models` | `401 Missing Authorization header` / `401 {"error":{"code":"invalid_api_key"}}` | 存在，认 Bearer |
| `POST /openapi/v1/chat/completions` | `401 {"error":{"message":"Invalid API key",…}}` | OpenAI Chat 面存在 |
| `POST /openapi/v1/messages` | `401` | Anthropic Messages 面存在 |
| `POST /openapi/v1/responses` | `401` | OpenAI Responses 面存在 |
| `POST /openapi/v1/embeddings` | `401` | Embeddings 面存在 |
| `GET /openapi/v1/{usage,balance,key,credits,…}` | `404` | 网关没有按 key 查额度/余额的路由 |
| `api.bailucode.com/*` | `410 service_retired` | 旧域名已下线，别再填它 |

因此「只要 key」能证明的只有 **key 是否被接受**。额度不在这条链路上，见下一节。

## 浏览器登录（可选，自动取 key）

不想手动复制 key，就走这条路：`magpie plugin login bailucode` 选「浏览器登录白鹿通行证」。

- **已经有一份能用的通行证会话**（就是下面那个 `session.txt`）：不弹浏览器，1~3 秒内直接向门户 `POST /api/api_keys {"action":"get_keys"}` 取回你账号下的 key，顺手把额度读一遍。
- **没有会话或已过期**：开一个独立 profile 的 Chrome（不动你日常浏览器），等你用邮箱验证码登录；它每 2 秒从 CDP 取一次 cookie，页面一变成已登录就收工，然后同样去取 key。
- 账号下一个可用 key 都没有时，会用 `{"action":"create_key","key_name":"magpie"}` 建一枚再交给你。

这条路径只读网关、只读门户的 `get_keys`；唯一的写操作是「你没有 key 时建一枚」，有 key 就绝不重复建。
## 签到（今日可领）

门户的「今日可领」有白鹿编码签到、Anthropic 协议定向、白鹿 API 总额度补充。插件把它接成 magpie 的签到钩子（`auth.checkin`），magpie 按北京时间每天自动问一次：

```bash
magpie accounts checkin            # 立刻跑一次
```

| 情况 | 返回给 magpie | 表现 |
| --- | --- | --- |
| 三项都领了 | `outcome: "done"`, `until: 次日 00:00 (Asia/Shanghai)` | `✓ … checked in today · already` |
| 有未领项但没有 Cap ticket | `outcome: "captcha"` + 去哪点的提示 | magpie 不会假装成功；去门户点一次领取 |
| 带 ticket（`{"captchaTicket":"…"}` 或 `BAILUCODE_CAPTCHA`） | `outcome: "claimed"`, `credit: 合计奖励` | 真发 `claim_daily_checkin` / `claim_anthropic_promo` / `claim_openclaw_promo` |

为什么不能全自动：门户对三项都要求 Cap 人机验证（页面里 `needsCaptcha(c)` 对 `purpose === 'checkin'` 恒真，promo 在当天未过人机验证时同理），实测无 ticket 直接回 `400 请先完成人机验证`。脚本不去解滑块；过一次验证后把 ticket 交给插件，或者干脆在门户点一下，magpie 这边会读到 `done`。
## 额度（白鹿通行证）

截图里那三行额度（白鹿编码 Credits / API 平台 Tokens / 定向额度）是**账号会话**维度，藏在登录后的 <https://bailucode.com/auth/> 页面里：页面把钱包整个塞在 `var S = {...}` 里。插件读这个页面，用它生成 magpie 卡片上的三条：

| 卡片行 | 取自 | 显示 |
| --- | --- | --- |
| 白鹿编码 | `code.planRemain` + `code.addonTokens/1000` | `21,500 Credits` |
| API 平台 | `api.usedEff` / `api.quotaEff`，重置日取页面「用量重置」 | `657 / 3.18 亿 Tokens` |
| 定向额度 | `packs[]`（Anthropic 等） | `剩 500 万 / 共 500 万 Tokens` |

`magpie accounts` 实录（本机，通行证会话在位）：

```json
{ "agent": "bailucode", "plan": "白鹿通行证", "active": true,
  "windows": [
    { "name": "白鹿编码", "used": 0, "remaining": 100, "display": "21,500 Credits", "unit": "credits" },
    { "name": "API 平台", "used": 0.0002, "remaining": 99.9998,
      "resetsAt": "2026-12-02T16:00:00Z", "display": "657 / 3.18 亿 Tokens", "unit": "tokens" },
    { "name": "Anthropic 协议 定向", "used": 0, "remaining": 100,
      "display": "剩 500 万 / 共 500 万 Tokens", "unit": "tokens" }
  ] }
```

会话放一次就行，登录流程里一个点击都不多：

```bash
# Windows
notepad %LOCALAPPDATA%\magpie-bailucode\session.txt   # 粘 Cookie 整行，保存
```

其它放法（优先级从高到低）：插件选项 `{"session":"…"}`、环境变量 `BAILUCODE_SESSION`、`~/.config/magpie-bailucode/session`、`~/.magpie-bailucode/session`。

拿 Cookie：在已登录的 bailucode 页面 F12 → Network → 刷新 → 第一条 `auth/` 请求 → Request Headers 的 `Cookie:` 整行。

- **只读**：插件对门户只发 `GET /auth/`，不碰任何写接口（`/api/logout` 这种尤其不碰 — 它会直接登出账号）。
- 会话过期会明确报「通行证会话已过期」，并在提示里给出文件路径；重新贴一次即可。
- Cookie 等同账号登录凭证，别提交到仓库。文件放在 `%LOCALAPPDATA%`，不进 git。

## 已知限制

- 没有通行证会话时，卡片只显示 key 是否被接受；额度那三行要按上面的方式放一次 Cookie。
- 没有实现 OAuth/邮箱登录——白鹿的门户登录要邮箱验证码，插件不做这一步。
- 模型清单里的上下文/输出长度：白鹿 `GET /models` 不返回时用内置估值（只影响客户端预算，不影响可用性）。

## 请求身份（重要，实测）

同一个请求，只有「客户端身份」不同，Cloudflare 的判定就不同：

| 客户端 | 结果 |
| --- | --- |
| `user-agent: magpie-bailucode/<version>`（本插件） | `401 {"code":"invalid_api_key"}` — 网关正常应答 |
| `user-agent: undici` / Bun 默认 | `403` Cloudflare 「Just a moment…」HTML |
| 伪装的 `Chrome/131` UA，但 TLS 不是 Chrome | `403` — **声称是浏览器但指纹不符，必被拦** |
| `node:https` 原始请求 | `401` — 裸 TLS 也放行 |

结论：别伪装浏览器。插件在 `auth.loader` 的 headers 和 `chat.headers` 两处都把 UA 钉成 `magpie-bailucode/<version>`，所以推理请求不会被 Cloudflare 拦。上面三条协议（chat / messages / responses）已用这个 UA 穿过 `HTTP(S)_PROXY=127.0.0.1:7890` 验证，全部返回 `401 invalid_api_key` 而不是 403。

## 排障

```bash
magpie plugin list --json          # 有没有装上、provides 里有没有 bailucode
magpie plugin on bailucode         # 被关掉了就打开
tail -f "$LOCALAPPDATA/Magpie/logs/app.log"   # 插件日志：service=bailucode
```

- 模型列表空着：key 没配或网关拒绝，看卡片上的错误。
- `403` + HTML：Cloudflare 拦截出口，见上。
- `401 invalid_api_key`：key 失效/删除了，去 key 页面重新生成。
- 额度显示「会话已过期」：`%LOCALAPPDATA%\magpie-bailucode\session.txt` 里的 Cookie 过期了，重新登录门户覆盖一次。
- 登录时报 `json: cannot unmarshal bool into Go struct field .error of type string`：0.1.0 的地址校验返回了 `true`，magpie 要的是字符串。0.1.1 已修；`magpie plugin update` 即可。

## 卸载

```bash
magpie plugin rm magpie-bailucode
```

插件是插卡式的：删掉它，magpie 的其它 provider 和配置一概不动。

## 开发

```bash
node --test test/plugin.test.mjs      # 23 个用例，全部 mock fetch
node ../tools/smoke.mjs               # 对真网关做一次冒烟（无效 key，直连）
```

## License

MIT