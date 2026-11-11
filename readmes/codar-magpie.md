# codar-magpie

把 **Codar 科搭（SpeedAI）** 接进 magpie / OpenCode：微信扫码登录一次，50+ 个模型就能被所有 agent 用，
附带点数余额、每日签到和新用户免费模型领取。

> 非官方插件。登录用的是 Codar 自己的扫码接口，Token 存在 magpie 的 `plugin-auth.json`（权限 600）。

## 安装

```bash
# 本地文件夹（开发时最方便：改完重开插件即生效）
magpie plugin add ~/codar-ai-client/magpie-plugin

# 或 npm / git（发布之后）
magpie plugin add codar-magpie
magpie plugin add github:<owner>/<repo>
```

应用里：打开「插件」→「添加插件」→ 填文件夹路径 → 在 Codar 那一行登录。

## 登录

```bash
magpie plugin login codar
```

两种方式：

| 方式 | 说明 |
|---|---|
| **微信扫码登录（含手机验证）** | 打开一个本地登录页，微信扫码；需要手机验证时在同一个页面完成 |
| **粘贴 Codar Token** | 已经有 `eyJ…` 开头的 JWT（比如从网页控制台复制的），直接粘贴，插件会先调 `/api/user/self` 校验 |

### 手机验证是怎么做的

Codar 在「新 IP 登录」或「微信账号未绑手机」时会拦下来要短信验证，而发短信前必须先过
**阿里云验证码 v4**。那是纯浏览器组件（语义点选 / 滑块），插件宿主里没有 DOM，magpie 的插件页面
又跑在 `connect-src 'none'` 的沙箱里，所以两种环境都做不了。

做法和社区里同样需要浏览器登录的插件一致：**插件在本地起一个临时页面**，
magpie 用系统浏览器打开它，用户在里面扫码、填手机号、过验证码。

```
magpie ──打开──▶ http://127.0.0.1:<随机端口>/?k=<48位随机key>
                   ├ 第一步 微信扫码          （二维码图片由本机代理，不跨域）
                   ├ 第二步 手机验证          （手机号 + 阿里云 captcha4 + 短信码）
                   └ 完成                      → 插件拿到 JWT，交给 magpie 保存
```

**安全边界**：默认只 bind `127.0.0.1`（公网不可达）；每个登录流程一个 48 位随机 key，
不对就 403（定长比较，无时序侧信道）；不写任何日志、不打印 Token；
拿到 Token 或 10 分钟超时后立即关闭服务。

### magpie 跑在 VPS 上怎么办

`127.0.0.1` 只有服务器自己能访问，你的 Windows / Mac 浏览器是打不开的。三种解法：

#### 方式 A · 让插件监听所有网卡（最简单）

```bash
export CODAR_LOGIN_BIND=0.0.0.0
magpie plugin login codar
```

或者写进 magpie 的插件选项（应用里「插件 → 已安装 → Codar → 选项」，或命令行）：

```bash
magpie plugin options /path/to/codar-magpie '{"loginBind":"0.0.0.0"}'
```

这样 magpie 会打印两个地址：

```
Sign in in your browser. If it didn't open, go to:
http://127.0.0.1:41234/?k=...

这个地址打不开时（例如 magpie 跑在 VPS 上），改用下面任意一个：
http://<服务器地址>:41234/?k=...
```

把 `<服务器地址>` 换成你的公网 IP 或域名即可。**记得在防火墙 / 安全组放行那个端口**，
而且它只在登录的这 10 分钟里开着。

> ⚠️ 这时候页面是走**明文 HTTP** 的，链路上能看到 Token。只在可信网络里用，
> 或者用下面的方式 B。

#### 方式 B · 反向代理（走 HTTPS）

插件端口每次登录都会变，所以反代要能「转发到当前端口」。两种做法：

**B1 · 用固定端口的转发器**（最简单）：在服务器上跑一个小转发器把固定端口映射到插件端口。
但插件端口不固定，不如直接用 SSH 隧道（方式 C）。

**B2 · 让 magpie 自己暴露**：把 magpie 的 web 界面通过已有的域名反代出来，
在浏览器里用它的「插件」页登录 —— 前提是那次登录的 URL 你能点开。
这条路在 VPS 上通常仍然需要方式 A 或 C。

> 实践下来，VPS 上**最省事的是方式 C（SSH 隧道）**，不用改防火墙、不用证书、
> 也不用担心明文传输。

#### 方式 C · SSH 隧道（推荐，最安全，无需改防火墙）

服务器上用默认的 `127.0.0.1` 监听，然后在**你自己的电脑**上执行：

```bash
# 先在 VPS 上启动登录，记下 magpie 打印的端口（例如 41234）
ssh -L 41234:127.0.0.1:41234 user@your-vps
```

然后在本地浏览器打开：

```
http://127.0.0.1:41234/?k=<原样的key>
```

页面只经过 SSH 加密隧道，不用开防火墙、不用证书，也不怕中间人。
每次登录端口会变，所以每次重新 `ssh -L` 一次即可。

#### 方式 E · 通过 Codar 网页控制台中转（可选，最低优先级）

如果你自己跑着这个项目的网页控制台（`web/`），可以让它当一次性的浏览器代理：
在面板页面里完成扫码 / 手机验证，Token 由插件取走，**面板不留存**。

**面板侧**（`.env`）：

```bash
RELAY_ENABLE=1
# 面板的公网地址，插件会用它拼出可点的链接
RELAY_PUBLIC_URL=https://your-panel.example.com
```

重启 `codar-web` 后，`/api/relay/*` 才会存在；没开这个开关时一律 404。

**插件侧**：

```bash
magpie plugin options codar-magpie '{"relayUrl":"https://your-panel.example.com"}'
```

然后 `magpie plugin login codar` 会多出第三种方式：

```
  3. 通过 Codar 网页控制台中转（需先配置 relayUrl）
```

选它，magpie 会打印一个 `https://your-panel.example.com/relay?id=…` 的链接，
在任何机器上打开都能完成登录。

**它做了什么，以及边界**：

| 项 | 做法 |
|---|---|
| 会话 | 插件向面板要一个 id + 64 位随机 secret，10 分钟失效 |
| 密钥 | 放在 URL 的 `#` 片段里——不发到服务器、不进 nginx 日志、不进 Referer，页面读完立刻从地址栏清掉 |
| Token | 只在面板内存里活到被插件取走的那一刻，**取走即删** |
| 账号 | **不建账号**，不写 `accounts.json`，账号列表里看不到 |
| 日志 | 不写 `logRing`，连用户名都不记 |
| 上限 | 同时最多 32 个会话；创建也受面板登录限速保护 |

> ⚠️ 这条路意味着**你的登录过程经过那台面板服务器**。它和你自己的面板是同一个东西，
> 但如果这个面板是别人提供的服务，那就是把凭据交给第三方 —— 请自行判断是否接受。
> 不需要的话完全不配置 `relayUrl`，插件里点了会直接告诉你差什么，不会偷偷连别处。

#### 方式 D · 粘贴 Token（完全绕开网络）

不想折腾，就在**任意能开浏览器的机器**上跑项目根目录的扫码脚本：

```bash
node login.mjs --out .env
```

拿到 `eyJ...` 后，在 magpie 里选第 2 种方式「粘贴 Codar Token」。
服务器只需要能访问上游 `api.claw.speedai.com`，不需要能被你访问。

页面里的两种验证流程与网页控制台 `web/server.mjs` 完全一致（同一套上游接口、同样的
`name`/`type` 组合、同样在失败时重轮询换临时令牌）：

| 场景 | 判定 | 发短信 | 提交 |
|---|---|---|---|
| 新 IP | `IP_VERIFY_REQUIRED` / `mode=IP_VERIFY` | `POST /v1/verification-code` `{name: <username>, type: "ip_verify"}` | `POST /v1/user/verify_ip`（需临时令牌） |
| 未绑手机 | `BIND_PHONE_REQUIRED` / `mode=BIND_PHONE` | `POST /v1/verification-code` `{name: "user", type: "bind_phone"}` | `POST /v1/bind-phone`（无需 Bearer） |

Token 是上游签发的 HS256 JWT，**7 天有效**。到期后上游返回 401，magpie 会把账号标成需要重新登录，
点一下重新扫码即可。

## 用起来

```bash
magpie plugin                    # codar (Codar 科搭, 50+ models)  signed in
magpie provider test codar auto  # 发一个最小请求验证链路
magpie quota                     # 点数余额 + 免费期
magpie models                    # agent 能选的模型
```

agent 里用 `<供应商>/<模型>` 指代，例如 `codar/auto`、`codar/claude-sonnet-5-kiro`。

### 模型与协议

模型列表来自两份上游目录（登录后每次刷新，取不到就用内置快照）：

- `GET /v1/codar/models`：官方精选目录（16 个），带协议、定价和请求 schema，优先使用
- `GET /v1/models`：上游全量清单（61 个），用来补齐精选目录没列的对话模型；
  画图 / 向量 / 音频类（`*-image*`、`nano-banana`、`embedding` 等）会被排除

合并后约 52 个。精选目录里的模型按 `protocol` 字段分流；补充进来的 `claude-*` 走
Anthropic Messages，其余走 OpenAI 兼容的 Chat Completions。

上游目录偶尔会慢到 10s 以上；插件成功读到后会缓存 5 分钟，超时则沿用上次结果，
最坏退回内置的 52 模型快照。**列表不会因为一次读失败而缩水**（否则 magpie 会把
「消失」的模型取消勾选）。常用模型：

| 模型 | API | 备注 |
|---|---|---|
| `auto` / `deepseek-v4.1-flash` | Chat Completions | **免费档**（实测 `billing.quota = 0`） |
| `deepseek-v4-flash` / `deepseek-v4-pro` | Chat Completions | 回传思维链 |
| `glm-5.2` / `glm-5.3` / `glm-5.3-flash` | Chat Completions | 回传思维链 |
| `gpt-5.6-sol` / `gpt-6-sol` / `gpt-6-astra` | Chat Completions | — |
| `claude-sonnet-5` / `claude-opus-5` / `claude-opus-5-5`（及各自的 `-kiro` 档） | Anthropic Messages | 原生协议，带 `anthropic-version` |

**上下文窗口统一报 1M。** 目录里 `gpt-5.6-sol` / `gpt-6-sol` / `gpt-6-astra` 写的是
`context_window: 128000`，但插件不拿它去限制客户端：agent 侧看到的一律是 1,000,000，
免得客户端提前截断上下文。**真超了上游会直接报错**，让用户看到厂商原话，比这里猜一个
更小的数字更可靠。

所有模型都声明 `tool_call`，实际工具调用由上游完成。**图片输入不要用**：目录写着支持，
但实测返回 400，插件里已经统一声明成纯文本。

### 客户端身份句替换（403 client_not_supported）

Codar 网关会扫描请求体里的 system prompt，命中某些 agent 客户端的身份句时拒绝登录凭证：

```
403 {"detail":{"code":"client_not_supported",
     "message":"This login credential is restricted to Codar. Use an API key for other clients."}}
```

实测是**整句精确匹配**——请求里出现 "Claude Code"、"Anthropic"、`claude-cli` UA 都不触发，
只有完整那一句会。插件在 `loader` 的 fetch 钩子里发请求前做一次字符串替换，
只动命中的句子，其余字节（含 SSE 流式）原样透传。非 UTF-8 的 body（压缩、二进制）不碰。
所以 Claude Code / Codex / OpenCode 等 agent 直连 Codar 也能用了，无需再单独跑一个本地修复代理。

> Codar 没有自助 API Key（`/api/keys` 需要管理员），所以上游错误提示里的
> "Use an API key" 对普通用户是条死路——替换句子是让登录凭证继续可用的唯一办法。

### 用量（`auth.usage`）

账号卡片、`magpie quota`、`magpie accounts` 和 `GET /v1/magpie/quotas` 都会显示：

```
codar · 新用户免费 · until Nov 3 · API key …g1us  subscription
  每日签到：已签 0% (下次可签 12 小时 20 分后) ↻12h20m tomorrow 04:54
  免费模型：已领取 0% (deepseek-v4.1-flash / auto · 还剩 156 小时 20 分) ↻6d12h Nov 3 04:53
  点数 2,500 · Agent 1,563 left
```

| 字段 / 窗口 | 内容 |
|---|---|
| `plan` | 领了免费模型 → 「新用户免费」；否则「按量计费」 |
| `until` | 免费期结束时间（`free_until`） |
| `balance` | `/v1/gettoken` 的三个桶（通用点数 / Agent / 改写） |
| **每日签到：已签 / 未签** | 已签带下次可签倒计时（服务端 `retry_after`）；未签提示怎么补签 |
| **免费模型：已领取** | 适用模型 id + 剩余时长 |
| **免费模型：已到期** | 免费期已过（上游重领幂等，不会再给 7 天），之后按目录价 |
| **免费模型：可领取** | 还没领，下次读取额度时自动领 |
| **免费模型：不可用** | 该账号不在新用户活动范围 |

> 签到窗口的 `used` 恒为 `0`：签到不是额度，显示成 100% 会让人以为「已经用尽」。
> 进度条无意义的地方一律用 `display` 文本承载，状态写在窗口**名字**里，一眼能看到。

### 为什么额度不更新（已修）

以前 `usage` 用 `Promise.all` 等三个上游接口，超时设到 30–40 秒。只要有一个卡住，
整次读取就算失败，magpie 会保留旧值 —— 表现是「额度一直显示几小时前的数字，
重启 magpie 才恢复」。

现在：

| 项 | 改法 |
|---|---|
| 并发 | `Promise.allSettled`，三个请求互不牵连 |
| 超时 | 余额 8s、签到 5s、免费模型 5s（原来 30–40s） |
| 必答项 | 只有余额失败才算整次读取失败 |
| 降级 | 签到/免费模型读不到时，显示「这次没读到（上游慢）」或用上一次的值 |
| 缓存 | 签到状态、免费模型状态各缓存 60 秒；热路径约 250ms 返回 |
| 失效 | `checkin` 成功后主动清掉签到缓存，下一次读立即反映 |

### 每日签到（`auth.checkin`）

插件的 `auth.checkin` 钩子存在，magpie 会在每个北京日替账号按一次：

```
POST /v1/daily-sign/status {username}   # 已签 → done
POST /v1/daily-sign        {username}   # 未签 → claimed
```

手动立即签一次（不需要等定时任务）：

```bash
magpie accounts checkin          # 全部账号
magpie accounts checkin --json   # {"outcome":"done","msg":"今天已签到，12 小时 25 分后可再签","by":"plugin:codar",…}
```

24 小时冷却由服务端控制，重复调用只会得到 `done`。

### 新用户免费模型

登录成功后自动执行一次：

```
GET  /api/codar/activities/free-model          # 看状态
POST /api/codar/activities/free-model/claim    # 没领就领
```

领取是幂等的，重复调用不会延期，也不会报错。之后每次读用量时会再补一次（同一个账号 10 分钟内只试一次）；
登录时则强制跳过节流，保证刚绑定就领。所以哪怕注册时活动还没开，下次打开面板也能补上。
领取状态和到期时间会显示在上面那个「新用户免费模型」窗口里。

### 为什么没有「领取」按钮

（登录页不受这个限制——它是插件自己起的回环页面，不是 magpie 的插件页面。）

magpie 的插件页面跑在 `sandbox="allow-scripts"` + `connect-src 'none'` 的 iframe 里：
**发不出任何网络请求**，也拿不到账号 Token（`magpie.read` 只开放 `usage:summary` 和 `providers:list`，
文档明确写着「没有任何读取会给出密钥、账号、登录信息」）。

所以在界面上做一个「点一下领取」的按钮是不可能的。领取是**自动**的：

1. 登录成功（扫码或粘贴 Token）时立刻领一次，不受节流影响；
2. 之后每次 magpie 读额度（打开供应商页、`magpie quota`、`GET /v1/magpie/quotas`）时补领，
   同一账号 10 分钟内最多真正打一次领取接口；
3. 读状态每次都真读 —— 节流只挡「领取」这个动作，不挡「显示状态」，
   否则被节流的窗口里会误报成「可领取」。

领取状态通过上面的 `免费模型：…` 窗口显示，四种状态一目了然。

## 上游地址

写死在代码里，没有配置项：

| 用途 | 地址 |
|---|---|
| 推理 / 模型目录 / 免费模型活动 | `https://api.claw.speedai.com`（请求发往 `/v1`） |
| 扫码登录 / 每日签到 / 点数余额 | `https://api.kuaipaper.com` |

## 凭据

- Token 由 magpie 保管在 `~/.config/magpie/plugin-auth.json`（0600），插件本身不落盘、不打印。
- 插件不在日志里输出 Token；`usage` 出错只回显上游的 `message`。
- 想清掉登录：`magpie plugin logout codar`。

## 排障

| 现象 | 处理 |
|---|---|
| `401` / 账号被标「需要重新登录」 | JWT 过期（7 天）→ `magpie plugin login codar` 重扫 |
| `403 client_not_supported` | 请求里的身份句变了、上游加了新匹配句 → 把新句子加进 `index.mjs` 的 `PROMPT_SUBSTITUTIONS`（0.5.1 起内置一句，覆盖 Claude Code） |
| 扫码页打开是二维码图片 | 正常，直接用微信扫 |
| 登录时提示要手机号验证 | 新 IP 或未绑手机，去网页控制台完成一次，再用「粘贴 Token」 |
| `No available channel for model 'X'` | 模型名大小写敏感，用 `magpie models` 里的精确 id |
| 免费额度突然开始扣点 | 免费期过了（`magpie quota` 看 until），换 `-kiro` 档或 `glm-5.3-flash` |
| 插件没出现 | `magpie plugin` 看加载错误；文件夹插件改完要在应用里关掉再打开 |

## 开发

```bash
node test.mjs              # 纯函数自检，不联网
node --check index.mjs     # 语法
```

入口只导出 `default { id, server }` 和 `_internal`（测试用），避免宿主把辅助函数当插件调用。

## License

MIT
