# opencode-xfyun-auth

A [magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) provider plugin for
**讯飞星辰 MaaS** (iFlytek Spark), the inference service at
`https://maas-api.cn-huabei-1.xf-yun.com`.

Headline model: **Spark-X2.6** — 293B-A30B MoE, 1M-token context, three reasoning levels —
plus the rest of the 星辰 model square (Spark-X2.5 family, GLM-5.2/5.3,
DeepSeek-V4-Pro/Flash, Kimi-K2.7-Code).

```
magpie plugin add opencode-xfyun-auth
magpie plugin login xfyun            # paste an ak-… key
magpie provider test xfyun spark-x2.6
```

Then pick `xfyun/spark-x2.6` in any agent magpie drives (Claude Code, Codex, OpenCode,
Gemini CLI, Crush, Pi, …). Get a key at <https://maas.xfyun.cn/apikey>.

From GitHub instead of npm:

```sh
magpie plugin add github:itgo067/magpie-plugin-xfyun
```

<details>
<summary>中文说明</summary>

把**讯飞星辰 MaaS**（`maas-api.cn-huabei-1.xf-yun.com`）接到 magpie / OpenCode，主模型
**Spark-X2.6**（293B-A30B MoE，1M 上下文，三档推理），同时带出星辰模型广场上的
Spark-X2.5 系列、GLM-5.2/5.3、DeepSeek-V4-Pro/Flash、Kimi-K2.7-Code。

1. 在 <https://maas.xfyun.cn/apikey> 建一个 `ak-…` key（并在模型广场为要用的模型开通订单）。
2. 安装并登录：

   ```sh
   magpie plugin add opencode-xfyun-auth
   magpie plugin login xfyun      # 粘贴 ak-… key
   magpie provider test xfyun spark-x2.6
   ```

3. 在任意 agent 里选 `xfyun/spark-x2.6`。模型带 `low`/`medium`/`high` 三档推理。

网关同时提供三种 API，用插件选项切换：

```sh
magpie plugin options opencode-xfyun-auth '{"protocol":"anthropic"}'   # chat | anthropic | responses
```

> `magpie plugin options` takes the plugin's **name as installed**, which is the npm package
> name (`opencode-xfyun-auth`) — not the GitHub repo name. Check with `magpie plugin list`
> if unsure.

- `chat`（默认）：`/v2/chat/completions`，模型广场全部模型都支持。
- `anthropic`：`/anthropic/v1/messages`，Claude Code 类 agent 走这个，网关会翻译
  `thinking` 与 `tool_use`。
- `responses`：`/v1/responses`，只有 `spark-x2.6` 与 `spark-x2.6-4b`。

切换 `protocol` 后第一次 `magpie provider test` 可能仍走旧路由报
`404 · no Route matched with those values`，再跑一次或重启 magpie 即可。

注意：key 只对已开通订单的模型有效，未开通会返回
`403 · the account lacks an active order`；本服务没有查询余额的接口，用量请看星辰控制台。

</details>

## Why a plugin

models.dev does not list 讯飞星辰, so nothing knows the provider exists. This plugin
declares it — name, base URL, model list, limits, prices, reasoning levels — and signs
every request with the `ak-…` key, which is all the gateway needs.

## Wire API

The gateway serves three APIs on one host, and the plugin can speak any of them. Pick one
with the plugin's `options`:

```sh
magpie plugin options opencode-xfyun-auth '{"protocol":"anthropic"}'
```

The name here is the npm package name, not the repo name.

| `protocol`        | npm                        | base URL                                               | endpoint            |
| ----------------- | -------------------------- | ------------------------------------------------------ | ------------------- |
| `chat` (default)  | `@ai-sdk/openai-compatible` | `https://maas-api.cn-huabei-1.xf-yun.com/v2`           | `/chat/completions` |
| `anthropic`       | `@ai-sdk/anthropic`        | `https://maas-api.cn-huabei-1.xf-yun.com/anthropic/v1` | `/messages`         |
| `responses`       | `@ai-sdk/openai`           | `https://maas-api.cn-huabei-1.xf-yun.com/v1`           | `/responses`        |

`chat` is the default: every model on the square supports it and the vendor documents it
in the most depth. `anthropic` is the interesting one for Claude-Code-style agents — the
gateway accepts a plain bearer `ak-…` token there and translates Anthropic Messages bodies
(including `thinking` and `tool_use`) for the non-Claude models behind it. `responses`
carries `spark-x2.6` and `spark-x2.6-4b`.

Reasoning levels follow the wire API: `reasoning_effort` (`low`/`medium`/`high`, or
`high`/`max` for GLM-5.2 / DeepSeek-V4) on `chat` and `responses`; `thinking.budgetTokens`
on `anthropic`. They show up as the model's variants, so `low`/`medium`/`high` appear in
the agent's model picker.

All three, verified against the live gateway with `magpie provider test`:

```
chat       ✓  894 ms · spark-x2.6     tool_calls + reasoning_content, streaming
anthropic  ✓  985 ms · spark-x2.6     thinking + tool_use, streaming
responses  ✓ 1706 ms · spark-x2.6
```

After changing `protocol`, magpie keeps the previously resolved provider (each model's
`npm`/`url` included) until it re-resolves, so the first `magpie provider test` right after
the switch can hit the old route and report
`404 · no Route matched with those values`. Run it again (or restart magpie) and the new
protocol is used — the endpoint itself is fine.

## Models

| id                       | name                | context | in / out / cache (¥ per M) |
| ------------------------ | ------------------- | ------- | -------------------------- |
| `spark-x2.6`             | Spark-X2.6          | 1M      | 0.9 / 3.6 / 0.08           |
| `spark-x2.6-4b`          | Spark-X2.6-4B       | 1M      | free                       |
| `spark-x2.5`             | Spark-X2.5          | 256k    | 0.96 / 3.6 / 0.14          |
| `spark-x2.5-4b`          | Spark-X2.5-4B       | 1M      | free                       |
| `spark-x2.5-1.7b`        | Spark-X2.5-1.7B     | 1M      | free                       |
| `xopglm53`               | GLM-5.3             | 1M      | 8 / 28 / 2                 |
| `xopglm52`               | GLM-5.2             | 1M      | 8 / 28 / 2                 |
| `xopdeepseekv4pro0813`   | DeepSeek-V4-Pro-0813| 1M      | 9 / 27 / 0.3               |
| `xopdeepseekv4flash0731` | DeepSeek-V4-Flash-0731 | 1M   | 3 / 9 / 0.1                |
| `xopkimik27code`         | Kimi-K2.7-Code      | 256k    | 6.5 / 27 / – (text + image) |

Prices are the model square's CNY-per-million figures, converted to USD at 7.1 for magpie's
cost display only; billing happens on the 星辰 side. A model needs its own order on the
星辰 account — a key entitled to `spark-x2.6` alone answers
`403 · no valid authorization: the account lacks an active order` for the others.

When the key can list models (`GET <base>/models`), the `provider.models` hook merges
whatever the gateway reports with this table, so new 星辰 models appear without a plugin
release. If the endpoint does not answer, the static table stands. The list endpoint only
returns what the key is entitled to, which is why the table stays the primary source.

## Per-model wire API

A model can be pinned to a different API than the provider — keep everything on `chat`
but drive `spark-x2.6` through Anthropic Messages, for instance:

```json
{
  "provider": {
    "xfyun": {
      "models": {
        "spark-x2.6": {
          "provider": {
            "npm": "@ai-sdk/anthropic",
            "api": "https://maas-api.cn-huabei-1.xf-yun.com/anthropic/v1"
          }
        }
      }
    }
  }
}
```

## Config

Everything the plugin writes into `config.provider.xfyun` is merged per field, so an
override of one model's name or limit keeps its limits, variants and prices:

```json
{
  "provider": {
    "xfyun": {
      "models": {
        "spark-x2.6": { "name": "Spark-X2.6 (fast)" }
      }
    }
  }
}
```

## Notes

- No usage or balance endpoint is known for this service (`/v1/balance`, `/v1/usage`,
  `/v1/user/info` all 404), so `magpie quota xfyun` shows nothing; spend is on the 星辰
  console.
- `reasoning_content` is emitted by default, so a very small `max_tokens` can be spent
  entirely on thinking and return empty `content`. The gateway does accept large
  `max_tokens` (up to the context window), despite the documented 2048 default.
- The 星辰 Coding Plan (`maas-coding-api…`, model `astron-code-latest`) and the Token Plan
  (`maas-token-api…`) are different products on different hosts, not covered here.
- The gateway requires `prompt + max_tokens <= context - 1`.

## Development

```sh
bun test                      # 12 unit tests, no network
magpie plugin add .           # install the local folder
```

The plugin exports `XfyunAuthPlugin` (the plugin function) and `_internal` (plain data and
helpers, not a function, so magpie ignores it and `bun test` can reach it).

## License

MIT
