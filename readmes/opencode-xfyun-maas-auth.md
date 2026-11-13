# opencode-xfyun-maas-auth

[中文说明](./README.zh-CN.md)

A [magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) provider plugin for
**iFlytek Xfyun MaaS (讯飞星辰 MaaS 平台)** — one package, three providers:

| Provider id | Product | Sign-in | Models |
|---|---|---|---|
| `xfyun-maas` | Pay-as-you-go API ([maas.xfyun.cn](https://maas.xfyun.cn)) | API Key `ak-…` | Spark X2.6/X2.5 family + open-source GLM, DeepSeek, Kimi, Qwen, MiniMax models |
| `xfyun-coding` | Astron **Coding Plan** | Plan API Key | `xsparkx2agent`, `xsparkx2`, `xsparkx2flash`, `auto` + plan open-source models, with per-model credit multipliers |
| `xfyun-token` | Astron **Token Plan** | Plan API Key | Plan models billed per token in credits |

All providers speak OpenAI Chat Completions (`/v2/chat/completions`) through
`@ai-sdk/openai-compatible`; magpie's gateway converts whatever your agent
speaks (Anthropic Messages, Responses, …) on the way in, so Claude Code, Codex,
OpenCode, Gemini CLI and every other magpie-supported agent can use these
models as `xfyun-maas/spark-x2.6`, `xfyun-coding/xsparkx2agent`, etc.

## Install

```sh
magpie plugin add opencode-xfyun-maas-auth   # from npm
magpie plugin login xfyun-maas               # paste your ak-… key
magpie plugin login xfyun-coding             # Coding Plan key
magpie plugin login xfyun-token              # Token Plan key
```

Or add it from a folder / git ref: `magpie plugin add ./opencode-xfyun-maas-auth`.

## Where to get keys

- **`xfyun-maas`** — console → *API 调用 / APIKEY 管理* on
  [maas.xfyun.cn](https://maas.xfyun.cn). Keys look like `ak-…`. Model ids come
  from the *API 调用* page.
- **`xfyun-coding`** — buy a Coding Plan (高效版/速通版) on the
  [套餐订阅](https://maas.xfyun.cn/packageSubscription) page; the plan key is
  shown there. Requests go to `maas-coding-api.cn-huabei-1.xf-yun.com`.
- **`xfyun-token`** — buy a Token Plan member seat on the
  [Token Plan](https://maas.xfyun.cn/tokenPlan/subscription) page; the plan key
  is shown there. Requests go to `maas-token-api.cn-huabei-1.xf-yun.com`.

Credentials are stored by magpie in its own `plugin-auth.json` (mode 600) and
are never visible to your agents.

## What the plugin does per request

- Adds `Authorization: Bearer <your key>`.
- Renames the deprecated `max_tokens` to `max_completion_tokens`.
- For Spark models (`spark*`, `xspark*`, `auto`): maps OpenAI-style
  `reasoning_effort` to Xfyun's `thinking: {type: "enabled"|"disabled"}` and
  strips parameters the Spark endpoint rejects.
- For open-source models (`xop*`, …): strips the Spark-only `thinking` object
  and passes `reasoning_effort` through.
- Reports 401 answers to magpie as an expired sign-in
  (`X-Magpie-Sign-In: expired`) so the account is marked for re-login instead
  of silently failing; 429/503 flow through so magpie can back off and fail
  over to your next account or model.

Per account, the plugin also asks the gateway which models the key may use
(`GET /v2/models`) and lists exactly those — Xfyun authorizes models per key,
so an account only ever sees what it can actually call (unknown-but-authorized
ids get a generic entry; if the list can't be fetched, the full static table
applies). Spark models think by default; ask for `thinking: disabled` (or
`reasoning_effort: none`) to turn it off.

## Coding Plan credit multipliers

magpie shows these as the model's `rate` (a request to a ×5 model counts as
five plan requests):

| Model | rate | | Model | rate |
|---|---|---|---|---|
| xsparkx2agent | 2 | | xopdeepseekv4pro | 5 |
| xsparkx2 | 2 | | xopdeepseekv4flash | 2 |
| xsparkx2flash | 1 | | xopdeepseekv32 | 2 |
| auto | 2 | | xopkimi27code | 5 |
| xopglm52 | 5 | | xopkimik26 | 4 |
| xopglm51 | 4 | | xopkimik25 | 3 |
| xopglm5 | 3 | | xminimaxm25 | 2 |
| xopqwen35397b | 2 | | xopqwen36v35b / xopqwen35v35b | 1 |
| xop3qwencodernext | 1 | | xopglmv47flash | 1 |

Multipliers apply to 高效版/速通版 plans purchased from 2026-07-23 (official
table). Coding Plan quota windows (5h / weekly / monthly) and Token Plan credit
balances are visible in the MaaS console; Xfyun publishes no public usage API,
so this plugin does not implement magpie's `usage` hook — check the console.

## Notes & limits

- Model tables are transcribed from the official docs (2.1/2.1.1/2.2/5.1/5.2)
  and updated per release; offline (已下线), embedding, rerank and OCR-only
  models are excluded. Output limits are not published — the plugin ships
  sensible defaults and adjusts them as Xfyun documents limits.
- Chat Completions content parts are text-only today, so models are listed as
  text-input even where the console mentions image input.
- Works in OpenCode too: the package follows the OpenCode 1.x plugin form and
  ships the community OpenCode 2.x adapter. magpie is the tested host; direct
  OpenCode use is best-effort.
- Unofficial: not affiliated with or endorsed by iFlytek. Spark/讯飞/星辰
  trademarks belong to iFLYTEK.

## Development

```sh
bun test              # unit + integration (mock gateway)
bun scripts/check.mjs # loads the package the way magpie does
bash scripts/e2e-magpie.sh  # sandbox E2E with a real magpie CLI (needs tools/magpie.exe)
```

MIT license. PRs welcome.
