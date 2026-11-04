# SenseNova (商汤日日新) Token Plan

SenseNova（商汤日日新）**Token Plan** 的积分额度与模型，接进 OpenCode 和
[magpie](https://usemagpie.ai)：一次登录同时拿到**额度**（积分池、5 小时 /
7 天窗口、返赠余额与到期）和**模型**（控制台计划内的模型，OpenAI 兼容推理）。

> 非官方插件，风险自负。本包与商汤无隶属或背书关系。它读取控制台未公开的
> `pool-usage` 接口，浏览器登录会在本机起一个一次性 Chromium，并会在你自己的
> 账号里创建（开启清理时也会删除）名为 `magpie-*` 的 API Key。平台没有公开
> 这些接口，随时可能变化或失效。本插件不绕过验证码、限流或任何平台限制。

## 登录

三条路，产出的都是同一个 `sensenova-token-plan` 账号。

| 方式 | 做什么 | 需要 |
|---|---|---|
| **浏览器登录（会创建 API Key），首选** | 起一个一次性 Chromium 窗口，在窗口里登录控制台（密码、短信码或扫码均可）。插件在 OAuth 回调落地时截住 `code`，随后复用或创建本账号的 Token Plan API Key | 有 Edge 或 Chrome 的桌面环境 |
| **账号密码** | 控制台自己的 OIDC 授权码流，密码在本机封成 JWE 后才离开，明文不上网、不落盘。可同时粘贴一个已有的 API Key | 无（无头可用） |
| **仅 API Key** | 只用粘贴的 key 服务模型；额度不可见 | 一个 API Key |

浏览器登录创建的 Key 名为 `magpie-<host>-<账号哈希>-…`：**另一台机器的、
或另一个 SenseNova 账号的 Key 都不会被复用或删除。** 同一个账号保存了两次时，
两条记录共用这组 Key。provider 设置里有两个开关：

- **Create an API key on browser sign-in**（默认开）：浏览器登录后，若本机没有
  可复用的 Key，就在账号上创建一个。
- **Prune old magpie API keys**（默认关）：只保留**本账号**最新的两个
  `magpie-*` Key，删除更旧的。手动创建的 Key、以及名字属于别的 SenseNova
  账号的 Key 永不删除；创建时间读不出的 Key 也永不删除。

## 额度

读 `GET /lite/console/v1/tokenplan/pool-usage`，把每个积分池的
`window_5h` / `window_7d` 显示成额度窗口，把 `grant_balance` 显示成卡片的
**余额**——数字（magpie 自己的千分位格式）加「积分」，到期时间紧凑地跟在
旁边（`· 11-04 到期`，跨年带年份）。到期是**积分的到期**，不是套餐的，所以
不放进卡片头部的套餐到期位（`until`）。多个积分池的赠款相加，到期取最早的
一个。

窗口的 `used` 是已用份额；控制台没给 `used` 时用 `limit - remaining` 兜底；
两者都没有的窗口跳过，而不是显示成 0%（那会读成「一点没用」）。超支不截断。

通用池的窗口带 `notModels`（专属池的模型），Flash-Lite 池的窗口带 `models`：
商汤先从 Flash-Lite 自己的池扣费，所以通用池用满时不应连带卡住仍有余额的
Flash-Lite。

## 模型

模型列表是**账号目录 ∩ 计划覆盖**：计划不覆盖的模型（平台会回 403）不会列出。
DeepSeek 系列的输出上限用实测值（393,216 / 384,000，2026-10-29 在真实账号上
测到），而不是目录里偏保守的 `max_output_length`。没有 API Key 的账号不列
模型；被平台拒绝的 key 也不列。会推理的模型给出 `none` / `low` / `high` 三档
reasoning effort——这是一套**刻意收窄的通用值**，不是「每个模型都核实过支持」：
多给一档会在任务中途冒出 400，少给一档只是少一个选项。

## OpenCode 2.x

2.x 的桥没有 magpie 的 `auth.usage`、`auth.refresh` 和 provider options 的位置：
在 OpenCode 2.x 下没有额度卡片、也不会自动续期（对话仍走 API Key）。密码输入
在那里显示为普通文本框。

## 凭证

Windows 上用 DPAPI 密封后再保存（`dpapi:…`），只有你自己的 Windows 用户能读。
Windows 上 DPAPI 不可用时（漫游配置、损坏的 profile、没有用户凭据的会话）回退
明文并记录原因，账号不会因此刷新失败。其他平台没有 DPAPI，按 0.1.x 的做法存明文
（magpie 把它放在你自己的数据目录里）。

## 开发

    bun test packages/sensenova
    bun scripts/check.mjs sensenova

`testdata/` 里有一次真实的 `/v1/models` 回复和一次真实的 `pool-usage` 回复
（只替换了账号自己的 pool id），解析器由平台的原始字节驱动。

## English

Unofficial. Three sign-in methods produce the same `sensenova-token-plan` account:
browser sign-in (one-off Chromium, CDP capture of the OAuth redirect, then reuse or
create a Token Plan API key), the console password walk (headless fallback; the
password is sealed to a JWE before it leaves the machine), and API key only
(models, no credit pools).

Browser-created keys are named `magpie-<host>-<account-hash>-…`. Another machine's
or another SenseNova account's keys are never reused or pruned; two saved sign-ins of
the same account share the prefix. Two provider options:
create a key on browser sign-in (default on), prune old magpie keys (default off,
keeps this account's newest two).

The credit-pool windows carry `notModels` for the dedicated pool's models so a full
general pool does not gate Flash-Lite. The model listing is the catalogue
intersected with the plan's coverage. On Windows credentials are DPAPI-sealed; when
DPAPI refuses (roaming profile, damaged profile, a session without the user's
credentials) the value is stored in plaintext with a logged reason, and the other
platforms store plaintext too (the 0.1.x behaviour).

## 许可证

MIT