<p align="center">
  <img src="assets/super-xiaoai.png" alt="超级小爱" width="128">
</p>

# opencode-super-xiaoai-auth

给 magpie / OpenCode 的 **小米超级小爱（Xiaomi Super XiaoAI / MiMo）** 供应商插件。
用小米账号密码 + 短信/邮箱验证码登录，直接和 `api.miclaw.xiaomi.net` 通信，
**不需要**另外跑 Rust 桥。

A magpie / OpenCode provider plugin for **Xiaomi Super XiaoAI (MiMo)**. Signs in
with a Xiaomi account (password + SMS/email 2FA) and talks to
`api.miclaw.xiaomi.net` directly — **no Rust bridge required**.

```
agent ──► magpie gateway ──► this plugin ──► api.miclaw.xiaomi.net
          (协议翻译)          (登录 / 续期 / 点数)   /osbot/pc/llm/v2/...
```

---

## 安装 · Install

```bash
magpie plugin add ./magpie-super-xiaoai
magpie plugin login super-xiaoai
```

登录要**跑两次** —— 小米的两步验证是「先发验证码，再交验证码」，而 magpie
只支持 `提问 → authorize → 失败可重试`。第一次留空验证码即发送，第二次填上。

Signing in takes **two runs**: Xiaomi always sends the ticket first and verifies
it second, while magpie only supports `prompts → authorize → retry`. Leave the
code empty on the first run to send it, then fill it in on the second.

```
$ magpie plugin login super-xiaoai
小米账号        › 138xxxxxxxx
密码            › ******
短信 / 邮箱验证码 › (留空)
小米账号密码登录  › (无需填写，直接回车)
✗ 验证码已发送至你的短信，请再运行一次登录并填入验证码

$ magpie plugin login super-xiaoai
小米账号        › (留空，沿用上一次)
密码            › (留空，沿用上一次)
短信 / 邮箱验证码 › 482913
小米账号密码登录  › (无需填写，直接回车)
✓ super-xiaoai 已登录
```

最后一项是 magpie 给**所有** `api` 型登录方式的通用「密钥」输入框，不是插件
的提问：留空回车即可，填任何内容都会被忽略 —— 插件自己铸造会话 key。

The last box is magpie's generic API-key step for every `api` sign-in. Leave it
empty: the plugin mints its own session key and discards whatever is typed.

如果小米要求图形验证码，会**额外**出现一项「图形验证码」（只在需要时才有）——
先打开给出的图片地址看完图再填。

---

## 模型 · Models

`<供应商>/<模型>`，例如 `super-xiaoai/mimo-v2.6-pro`。

| key | 上游 id | 上下文 | 输出 | 输入 |
|---|---|---|---|---|
| `mimo` | `xiaomi/mimo` | 1M | 128K | text, image |
| `mimo-pro` | `xiaomi/mimo-pro` | 1M | 128K | text |
| `mimo-v2.5` | `xiaomi/mimo-v2.5` | 1M | 128K | text, image, video, audio |
| `mimo-v2.5-pro` | `xiaomi/mimo-v2.5-pro` | 1M | 128K | text |
| `mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` | 1M | 128K | text, image, video, audio |
| `mimo-v2.6-pro` | `xiaomi/mimo-v2.6-pro` | 1M | 128K | text, image, video, audio |
| `mimo-v2.6-pro-ultraspeed` | `xiaomi/mimo-v2.6-pro-ultraspeed` | 1M | 128K | text, image, video, audio |
| `mimo-claw-0301` | `xiaomi/mimo-claw-0301` | 256K | 128K | text |
| `minimax-m2.5` | `xiaomi/MiniMax-M2.5` | 200K | 128K | text |
| `kimi-k2.5` | `xiaomi/kimi-k2.5` | 256K | 256K | text, image, video |
| `glm-5` | `xiaomi/glm-5` | 200K | 128K | text |
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | 1M | 384K | text, image |
| `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | 1M | 384K | text |

上游要求 `xiaomi/` / `deepseek/` 前缀，所以 key 和 API id 是分开的。上游不做
白名单，表里没有的 id 也可能能调用 —— 手工加进 `plugins.json` 即可。
点数是按账号算的，不按 token 计费，所以 `cost` 全是 0。

---

## 登录信息存在哪 · Where the sign-in is kept

`plugin-auth.json`（magpie 自己管，权限 600），`type: "api"` 的 `key` 里是一段
JSON：

```jsonc
{ "userId": "…", "cUserId": "…", "passToken": "…", "ssecurity": "…",
  "serviceToken": "…", "deviceId": "pc_…", "refreshedAt": 1712345678901 }
```

- `passToken` 长期有效，用来重铸 `serviceToken`
- `serviceToken` 是 `sid=miclaw` 的业务会话，20 小时后提前重铸
- 每个小米账号是一条 magpie 账号，`accountId` 用 `userId`，所以多账号可用

---

## 续期 · Renewal

`serviceToken` 过期不是问题，`passToken` 才是。插件在三种时机重铸，同一账号只
跑一次：

1. `loader` 判断 `refreshedAt` 超过 20 小时，发请求前重铸；
2. 上游回 401，重铸一次后重放原请求；
3. 还回 401 → 返回 `X-Magpie-Sign-In: expired`，magpie 把账号标为需要重新登录。

---

## 已知限制 · Known limits

- **不支持硬件 2FA**（小米安全密钥），`identity/list` 会直接报错。
- **只支持账号密码登录**。扫码登录（`longPolling/loginUrl`）实测可用，但没做
  到插件里。
- **验证码不要连着重试**：小米对同一账号发码有频率限制，输错时插件会保留
  待验证状态让你重填，而不是再发一条。
- 非流式请求会在插件内部转成流式再折回 JSON —— 上游对长时间不返回的非流式
  请求会静默放弃。副作用是 `usage` 一定拿得到，因为流式带 `stream_options`。
- `/v1/messages`（Anthropic）和 Gemini 由 magpie 网关翻译，插件只看得到
  Chat Completions / Responses。
- 提示词、工具调用会原样发给小米的服务器，这是这个供应商的本质。

---

## 开发 · Development

```bash
bun test                 # 单元 + mock 上游的集成测试，不碰真实小米接口
bun tools/login.mjs      # 独立跑完整个登录 + 铸 token，写 .session.local.json
bun tools/probe.mjs      # 用那个 session 打一次真实的 chat / stream / responses / quota
```

`tools/` 只在本地调试用，不随包发布。

沙箱里验证插件本身（不碰你自己的 magpie）：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./magpie-super-xiaoai
m plugin --json
m plugin login super-xiaoai
m provider test super-xiaoai
m quota
```

---

## 出处 · Provenance

登录、铸造 `serviceToken`、请求头和点数解析全部移植并对照验证自
[`miclaw_api_bridge`](https://github.com/NEORUAA/miclaw_api_bridge)（Rust）。上游模型能力和上下文
长度取自各家官方文档，不是超级小爱渠道的保证值。
