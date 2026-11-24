# magpie-yakit-free

把 [Yakit AIBalance](https://aibalance.yaklang.com/v1) 的**免费模型**（`memfit-*-free`）接进 Magpie / OpenCode，做成一个供应商 `yakit`：不用登录、不用 API Key。

## 为什么需要插件

AIBalance 的 `/v1` 认证分两层（实测 + 源码）：

1. 模型名以 `-free` 结尾 → **跳过 API Key 校验**；`free-user` 只是占位符。
2. 模型名以 `memfit-` 开头 → 在 Key 校验**之前**强制要求 TOTP：

   ```
   X-Memfit-OTP-Auth: base64(6 位 TOTP)
   ```

   TOTP secret 是全局唯一的，由 `GET /v1/memfit-totp-uuid` 公开下发
   （`MEMFIT-AI<uuid>MEMFIT-AI`），30 秒窗口、HMAC-SHA1、6 位数字。

普通 OpenAI 供应商配置没法按请求算动态头，所以用这个 provider 插件：`auth.loader`
返回一个自定义 `fetch`，每次请求前取 secret、算 TOTP、注入头。

## 安装

```bash
magpie plugin add github:FHKKMD637/magpie-yakit-free
```

然后在 Magpie 的供应商里选 **Yakit 免费模型**，点「免费使用（无需 API Key）」登录一次即可
（不弹任何输入框，只是给宿主建一个账号记录）。

## 模型

| id | 说明 |
| --- | --- |
| `memfit-standard-free` | 标准 |
| `memfit-standard-thinking-free` | 标准（思考） |
| `memfit-blade-free` | Blade |
| `memfit-light-free` | 轻量 |
| `memfit-basic-free` | 基础 |
| `memfit-vision-free` | 视觉 |
| `memfit-deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash |
| `memfit-glm-5.3-flash-free` | GLM-5.3 Flash |
| `memfit-qwen3.8-flash-free` | Qwen3.8 Flash |

`qwen3.5-27b-free`、`embedding-free` 在 `/v1/chat/completions` 上返回 404，未收录。

## 实现要点

- TOTP 算法与服务端 `totp.go` + `twofa` 一致：
  `HMAC-SHA1(key = uuid 的 UTF-8 字节, counter = floor(unix/30))`，
  动态截断取 6 位，再标准 base64。
- secret 缓存 10 分钟；返回 401 且响应里带 `memfit_totp_auth` 时强制刷新重试一次。
- `fetch` 只允许发往 `https://aibalance.yaklang.com`（宿主可能把它交给别的插件用）。
- 用户也可以填自己的 yaklang API Key（付费模型），留空就是免费池。
- 免费池按 IP 共享限流，插件把 `maxConcurrency` 压到 2，避免触发 429。

## 注意

- 这是**共享免费额度**，随时可能被限流或熔断（会返回
  `providers_circuit_open` / `rate_limit`），不是插件的问题。
- TOTP secret 公开是服务端的设计，插件只是按官方客户端的做法取用。

## 出口 IP 池（多节点轮换）

插件会读 `~/.config/magpie/proxy-pool.json`（由 [代理池](https://github.com/FHKKMD637/magpie-proxy-pool) 生成）：

- 每个请求轮换一个出口（Clash 节点的 `username@127.0.0.1:7892`，或自定义 http/socks 代理）；
- 优先低延迟节点，round-robin；
- 429 / 403 / 407 / 连接失败 → 该节点冷却 2 分钟，换下一个重试（最多 4 个）；
- 没有池子文件时直连。

```bash
cd ~/.config/magpie/plugins/node_modules/magpie-proxy-pool
bun cli.mjs sync && bun cli.mjs test
bun cli.mjs add my-proxy 'socks5://user:pass@1.2.3.4:1080'
bun cli.mjs list
```

`maxConcurrency` 默认 **16**（可用环境变量 `YAKIT_MAX_CONCURRENCY` 调）；429/断连会自动换出口重试。

## 并发与稳定性

`bench.mjs` 直接走插件真实的 loader/fetch（TOTP + 出口轮换都会经过），所以测到的就是线上路径：

```bash
cd ~/.config/magpie/plugins/node_modules/magpie-yakit-free
bun bench.mjs --per-model 6 --concurrency 16
bun bench.mjs --per-model 5 --concurrency 24 --rounds 2 --gap 15
```

2026-11-18 实测（9 个模型，出口池 35 个可用 IP）：

| 并发 | 请求数 | 成功率 |
|---|---|---|
| 12 | 54 | 100% |
| 16（两轮） | 108 | 100% |
| 24（两轮） | 90 | 100% |
| 40 | 36 | 100% |

- 默认 16 是保守值；24 也稳定，40 仍全部成功但 p50 明显变长（`memfit-standard-free` 会到 8–10s）。
- 慢模型：`memfit-basic-free`、`memfit-standard-free`、`memfit-deepseek-v4.1-flash-free`；快模型：`memfit-qwen3.8-flash-free`、`memfit-vision-free`、`memfit-blade-free`。
- 唯一见过的瞬时错误是并发首请求重复拉 TOTP 导致的 socket 断开，已用 in-flight 去重修掉。


## 免责声明

本项目仅供个人研究与学习使用。它依赖上游服务当前公开的认证方式；请遵守上游服务条款，
不要用于批量滥用或对外分发。上游随时可能更换认证方式，届时插件可能失效。


## 429 的两种终态（不重试）

- `daily_token_quota`：免费池**全局日额度**用光，`Retry-After` / `next_release_at` 给出恢复时间（通常次日 08:00）。换出口没用，插件立即返回，不冷却节点。
- `memfit_client`：免费模型只允许受支持的 Memfit 客户端，实测加 UA / X-Yak-Version 也绕不过。这类模型直接跳过。
