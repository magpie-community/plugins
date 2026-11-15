<div align="center">

# magpie-teleagent-login

**把 TeleAgent（天翼 AI 星辰超级智能体）的 5 个模型接进 magpie / OpenCode。**
插件自己完成登录，**不装桌面客户端**，**不申请 API Key**。

`MIT` · `Node ≥ 20` · `macOS / Windows / Linux`

</div>

---

## 这是什么

一个 magpie（OpenCode v1 provider）插件。装上之后，`teleagent/*` 这组模型直接出现在模型列表里，
登录、签名、限速、续期、积分签到都在插件内部完成。

- **登录**：拉起一个临时 profile 的浏览器完成天翼账号登录，自动取回 token；也可以用「手动粘贴 token」零依赖兜底。
- **签名**：上游聊天网关要求两步 HMAC-SHA256 签名（`X-Superagent-Signature`），插件按协议现签。
- **设备身份**：`deviceId` / `installId` 由账号 id 确定性派生，同账号每次登录保持一致。
- **积分**：门户的余额、到期时间、套餐名直接显示在 magpie 里；每日签到可选开启。
- **工具**：给 agent 挂了一个只读工具 `points`，问「我还有多少积分」不用花积分。

## 这不是什么

- 不是官方 SDK。上游没有公开 API 文档，协议来自逆向，变了就会 `40104`。
- 不是「手机号 + 短信 → 直接换 token」的纯 API 方案。上游没有这样的公开端点（详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）。
- 不伪装成官方客户端：`messages[0]`、工具集合、TLS 指纹、请求节奏都和桌面端不同。

## 模型

| modelID | 显示名 | 上下文 | 输出上限 | 图片 | 积分倍率 |
|---|---|---|---|---|---|
| `teleagent/chat-pro` | 智能 · x0.6 | 400K | 65536 | ✅ | x0.6 |
| `teleagent/chat-flagship` | 旗舰 · x1.0 | 400K | 65536 | ❌ | x1.0 |
| `teleagent/chat-flash` | 极速 · x0.2 | 400K | 65536 | ✅ | x0.2 |
| `teleagent/chat-lite` | 轻量 · x0.5 | 100K | 16384 | ❌ | x0.5 |
| `teleagent/chat-nano` | 轻速 · x0.1 | 100K | 16384 | ❌ | x0.1 |

倍率是**积分消耗倍率**，不是折扣。图片能力是实测结论，不是上游目录的声明：
`chat-nano` 直接报 `is not a multimodal model`，`chat-flagship` 报 `1210`，`chat-lite` 给 200 但答非所问。
要发图请用 `chat-pro` / `chat-flash`。

思考档位：上游只认 `low` / `high` / `max`，并且**拒绝任何「关闭思考」的写法**。插件会在转发前削档
（`minimal→low`，`medium`/`xhigh→high`，`off`/`none`/`thinking` 之类直接删字段），不改其它字段。

## 安装

> 只想装上就用：看 [`docs/QUICKSTART.md`](docs/QUICKSTART.md)（5 分钟版，含截图位、常见报错对照）。
> 下面是完整清单和开发调试方式。

```bash
# 从 GitHub
magpie plugin add github:goodtome/magpie-teleagent-login

# 从本地目录（开发调试）
magpie plugin add /path/to/magpie-teleagent-login
```

装完**完全退出 magpie 再启动**，别等热更新。多 profile 环境注意 `--profile`，别装错地方。

想先在不污染真实配置的环境里试：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
          MAGPIE_DATA_HOME=$sb/data MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }

m plugin add /path/to/magpie-teleagent-login
m plugin --json          # 只读清单，零网络请求
```

## 登录

```bash
magpie plugin login teleagent
```

会给出三个选项，任选其一即可，都不需要桌面客户端。

### 1. 浏览器登录（推荐）

插件起一个**临时 profile** 的 Chrome / Edge / Brave（用完即删，不碰你日常浏览器配置），
打开天翼账号登录页，在里面扫码 / 密码 / 短信都行；登录完成后通过 CDP 每秒读一次 cookie，
拿到 `operationToken` 就自动关掉浏览器。

`operationToken` 同时是门户（积分 / 签到）的 cookie，所以**积分开箱可用**。

找不到浏览器时指定路径：

```bash
export TELEAGENT_CHROME_PATH=/path/to/chrome
```

### 2. 手动粘贴 token（零依赖兜底）

1. 浏览器登录 <https://agent.teleai.com.cn>
2. F12 → Application → Cookies → `agent.teleai.com.cn`
3. 复制 `operationToken`（或 `x-token`）的值
4. `magpie plugin login teleagent` → 选「手动粘贴 token」→ 粘贴

> **聊天要的是 SSO token，不是门户 token。** 两者都是 JWT，长得一样但不是一个东西：
> 把 JWT 中间那段 base64 解开，带 `"tokenType":"uc_auth_token_ty"` 的才是聊天网关认的那份；
> 只有 `exp` / `userInfo` 的是门户 token。粘错的表现是聊天 `40108 invalid token`，而积分正常。

重新粘贴 token 不会清掉已有的积分凭据——插件会继承上一份门户 cookie。

### 3. 补门户 cookie（只修积分）

已有可用 token、只是积分读不到时选这个：它只补门户凭据，不动聊天 token。

### 怎么确认登录成功

```bash
magpie quota          # 能读到积分余额 = 凭据链路通了（只读、免费）
magpie plugin --json  # 插件在不在（零请求）
```

`magpie provider test teleagent` 会发**真实请求、消耗积分**，还可能是风控眼里的异常流量，
装完不用立刻跑它。

## 网关 apiKey（必须配一次）

上游要求 `Authorization: Bearer <网关 apiKey>`，缺失回 `40105 您的请求疑似攻击请求`。
这个 key 是桌面端内置常量，**免客户端版读不到它**，需要自己填一次：

```bash
# 二选一
magpie plugin options teleagent '{"apiKey":"<你的网关 apiKey>"}'

# 或环境变量（启动 magpie 的那个 shell 里）
export TELEAGENT_API_KEY=<你的网关 apiKey>
```

它不是账号凭据——真正的鉴权是 `X-Token` + 两步 HMAC 签名，这个 key 只负责让上游认出
「请求来自官方客户端形态」。没配的表现是任意模型都 `40105`。

## 积分与签到

- `magpie quota` / 供应商页卡片：余额、最早过期时间、套餐名
- 积分是**预付钱包式余额**，没有「已用 / 上限」，不参与额度耗尽判断
- 每日签到默认关闭：设置 → 用量 → 插件 tab → TeleAgent → 「每日签到」
- 签到幂等：先查 `claimed_today`，已领就短路返回，不碰领取接口；领完再复查一次
- 积分和聊天是**两个服务**：积分读不到不影响模型，反之亦然

## 只读工具 `points`

插件给 agent 挂了一个工具，全名是 `<插件目录名>_points`——从 GitHub 安装时实际为
`magpie-teleagent-login_points`，从本地目录安装时取目录名。
无参数、无副作用、不消耗积分、不触发领取，返回余额、到期时间、套餐名、今日是否已领、
可领积分、累计签到天数。

## 工作原理

```text
magpie ──(OpenAI 兼容请求)──▶ 插件
                                ├─ 取本账号 token（accounts.json）
                                ├─ 派生 deviceId / installId
                                ├─ 两步 HMAC-SHA256 签名
                                └─▶ https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions
```

签名两步，分隔符不一样，弄反就是 `40104`：

```text
第 1 步  key = JWT 第三段；msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
第 2 步  key = 上一步结果（当 64 字符十六进制文本）；msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256(body)}"
```

`pathname` 必须带 `/superCowork/sapi` 前缀。完整协议（含登录闭环、门户接口、错误码）见
[docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 安全与隐私

| 数据 | 存放位置 | 是否离开本机 |
|---|---|---|
| JWT、设备指纹、门户 token | `<数据目录>/teleagent-login/accounts.json`（明文 JSON，权限归你） | 否，只用于加签 |
| 网关 apiKey | magpie 插件选项 / 环境变量 | 否 |
| 对话内容 | 由 magpie 传给插件 | 是，只发给 `agent.teleai.com.cn` |

出站只有一个域名：

```text
https://agent.teleai.com.cn
├── /superCowork/sapi/api/v1/chat/completions   聊天（两步 HMAC 签名）
├── /superCowork/sapi/cowork/auth/token-refresh 续期
└── /meter/super-agent/user/portal/...          积分与签到
```

签名请求**只会**发给这个 origin：magpie 的 `api` 是用户可改配置，被改成别的域名时插件拒绝发送
（比较的是 origin，`agent.teleai.com.cn.evil.test` 和 `http://` 降级都会被挡）。
不写请求日志、不落盘请求 / 响应体、不打印 token。**仓库本身不含任何凭据。**

## 故障排查

排查顺序从只读往花钱走：

```bash
magpie plugin --json            # 1. 插件在不在（零请求）
magpie quota                    # 2. 凭据能不能读（只读、免费）
magpie provider test teleagent  # 3. 链路通不通（一次真实请求，花积分）
```

| 现象 | 原因 | 动作 |
|---|---|---|
| 任意模型都 `40105` | 网关 apiKey 没配 | 见上文「网关 apiKey」 |
| 任意模型都 `40104` | 签名无效（协议变了 / pathname 少前缀） | 更新插件，别反复换参数重试 |
| `40108 invalid token` | 存的不是 SSO token（多半是门户 token） | 重新登录，选「浏览器登录」 |
| `40108` 且登录很久了 | token 到期 | 插件会走 refresh；失败就重登 |
| `40109` 账号封禁 | 模型通道被封（积分仍可读） | 停手 |
| `402` / `4029` | 积分不足 | 签到领积分，或换低倍率模型 |
| `429` / `4290` | 限流 | 等一会儿；持续出现就别循环发 |
| `1210` | 给不支持的模型发了图片 | 换 `chat-pro` / `chat-flash` |
| `413` | 请求体过大 | 减工具 / 附件，不是账号问题 |
| `400`「不支持关闭思考」 | 宿主写了 `reasoning_effort: off` 之类 | 0.1.0 起插件自动削档，升级即可 |
| `404`「没有模型 X」 | agent 传了目录外的 id | 只有 5 个合法 id，插件本地拦下 |
| 积分「不可用」但模型正常 | 没有门户 cookie | 用「浏览器登录」重登一次 |
| 「未找到 Chrome/Edge/Brave」 | 本机没有 Chromium 系浏览器 | 设 `TELEAGENT_CHROME_PATH` 或改手动 token |
| 「浏览器登录超时」 | 5 分钟内没检测到登录 cookie | 重试，确认最终停在 `agent.teleai.com.cn` |

`40104` = 签名不对（token 是好的）；`40108` = 身份不对（token 坏了）。处置完全不同。

## 账号存活参数（不要为了「跑得快」调大）

| 机制 | 默认值 | 位置 |
|---|---|---|
| 并发上限 | 2 | `lib/guard.mjs` |
| 每分钟上限 | 20 | `lib/guard.mjs` |
| 连续 401/403 熔断 | 3 次 → 停 10 分钟 | `lib/guard.mjs` |
| 启动自检聊天请求 | **不发** | 全项目无此代码路径 |

上游风控对「合成探测」很敏感：批量试模型、超大填充体、批量合成工具名、反复试签名变体
（`40104` 刷屏本身就是异常流量）都可能直接换来 `40109`。这些数字不是性能参数。

## DeepSeek Harness 里报「context compaction failed」

`chat-nano`（100K）和 `chat-lite`（100K）在 DSH 里可能切不过去：

```
Cannot switch to magpie/teleagent/chat-nano: context compaction failed:
compaction still above threshold after 2 compaction attempts
(36623 estimated tokens >= threshold 18080)
```

这不是插件的错，也不是 token 的问题。DSH 的 `compaction-basic` 默认给每个模型留
65536 个 token 的压缩余量，阈值算法是：

```
threshold = min(contextWindow * 0.8, contextWindow - 本次请求 maxTokens - headroomTokens)
```

100000 − 16384 − 65536 = **18080**。只有 100K 窗口的模型被这个默认值挤到几乎没有可用空间，
换模型时的自检压缩必然失败。400K 的那三个模型不会（400000 − 65536 − 65536 = 268928）。

在 DSH 的个人补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）末尾加一段，给小窗口模型
单独放宽：

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  config:
    modelPolicies:
      - provider: magpie
        model: teleagent/chat-nano
        headroomTokens: 4096
        maxTokens: 2048
        compactionRetries: 3
      - provider: magpie
        model: teleagent/chat-lite
        headroomTokens: 4096
        maxTokens: 2048
        compactionRetries: 3
```

改完 → 阈值变成 `min(80000, 100000 − 16384 − 4096) = 79520`，`36623 < 79520` 通过。
这一段要**重启 DSH** 才生效：补丁层是启动时 compose 的，运行中手改文件不会被读，
而且运行中的进程会用内存里的配置覆盖文件。重启前先确认文件里还留着这段。

`provider` 必须是 DSH 里的 provider id（网关接入时是 `magpie`），`model` 是 DSH 里的
模型 id（带渠道前缀，如 `teleagent/chat-nano`），两者都对不上就不会匹配。

## 已知限制

- 上游无公开协议文档，靠逆向，变了要适配
- **登录必须过一次浏览器**：不存在纯 API 的手机号 + 短信换 JWT 的公开端点
- 网关 apiKey 要自己填一次（桌面端内置常量）
- 设备指纹是派生的，与官方客户端真实设备标识不同，风控可能更敏感
- 只有 `chat-pro` / `chat-flash` 支持图片
- 积分依赖门户 cookie；手动 token 方式可能没有

## 开发

```bash
bun test test/     # 79 个用例，全离线
```

测试红线：不发真实网络请求、不启动真实浏览器、不读真实凭据、不打印 token。
网络调用均可注入（`fetchImpl`），凭据库用临时目录，token 全是运行时合成的假 JWT。

改代码后的最小自检：签名 → 单测；模型元数据 → 单测对齐 `limit` / `modalities` / `rate`；
portal → 单测（注入 `fetchImpl`）；入口 hooks → `magpie plugin --json`。

## 致谢

签名算法与模型目录来自 [opencode-teleagent-auth](https://github.com/anbulang/opencode-teleagent-auth)
（MIT, anbulang）对上游协议的逆向工作。本插件把「凭据来源」从读桌面端磁盘换成了插件自己登录。

非官方项目，与 TeleAgent / 天翼无关。

## License

MIT
