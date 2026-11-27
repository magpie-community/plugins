# Hindsight

Recall from your own Hindsight before each request, and capture a completed turn back on demand — as Magpie gateway middleware, with no tool for the agent to call.

Magpie runs one recall as a request arrives, wraps what came back in a delimited block, appends it to that turn's **user message**, and lets the request continue untouched if anything goes wrong. Capture is off by default.

```sh
magpie plugin add @magpie-community/gateway-hindsight
```

Open **Hindsight Memory** in Magpie's Plugins tab to set the API URL, the bank and the credential, and to run a connection test.

## Why a gateway hook and not a tool

A tool costs the agent a round trip and the user a visible tool call, and every harness has to be taught to use it. A gateway hook sees the requests from every harness already. Two things follow, and both are load-bearing:

- Memories are appended to the **user turn**, never the system prompt. The conversation prefix stays byte-identical from one request to the next, so the provider's prompt cache keeps working.
- A turn keeps the block it was given for the rest of its tool loop, and later turns re-attach the earlier blocks instead of calling recall again. Same reason: a stable prefix.

## How it differs from the other memory middleware here

`gateway-powercontext`, `gateway-nowledge-mem` and `gateway-respire-memory` each talk to their own service. This one talks to **Hindsight** — a bank of memories you host, with its own recall and retain endpoints — so the channel is Hindsight itself, not PowerContext, Nowledge Mem or Respire. Beyond that:

- recall and capture are the whole plugin: no archive queue, no background worker, no second model call;
- replayed history is capped (`max_replay_blocks`), and crossing the cap drops the older tail in one batch instead of sliding one block per request, which would invalidate the prompt cache on every request;
- the recall budget is a real token budget (CJK at ~1 token per character, Latin at ~4 characters per token), not a character count pretending to be one.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `hindsight_api` | `http://127.0.0.1:8888` | Hindsight HTTP API base URL. Do not append `/v1`; the plugin builds the full path. |
| `bank` | `hermes` | Existing Hindsight bank ID, used for both recall and capture. |
| `recall_max_tokens` | `1024` | Token budget sent to recall as `max_tokens` (1–16384). |
| `capture` | `false` | Opt in to retaining the completed turn. |
| `agents` | `[]` | Exact, case-insensitive agent names to process. Empty = all agents **except** `hermes` and `dsh`, which inject Hindsight themselves; naming them forces the plugin on for them too. |
| `gatewayTimeoutMs` | `5000` | Magpie's timeout for this hook (100–10000 ms). The plugin reserves a slice, so a slow recall fails open instead of being killed mid-flight. |
| `api_key` | `""` | Credential sent to Hindsight. Empty sends no auth header. Never logged. |
| `api_key_header` | `Authorization` | Header that carries it. Request-structure headers (`Host`, `Content-Type`, `Cookie`, …) are rejected. |
| `api_key_prefix` | `Bearer ` | Prepended to the key. Not trimmed: the trailing space is part of the value. |
| `authorizationEnv` | `""` | Name of an environment variable to read the credential from instead, so the secret stays out of the options file. `api_key` wins when both are set. |
| `max_replay_blocks` | `8` | How many historical memory blocks may stay attached to the resent conversation. `0` = unlimited. |
| `allowRemote` | `false` | Required when `hindsight_api` is not loopback: recall sends the latest user message (up to 8 KB) to that host. |
| `allowInsecureHttp` | `false` | Additionally required for plain `http://` to a non-loopback host. |

## Behavior

- Protocols: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses and Gemini.
- Only host-classified local requests (`ctx.origin === "local"`) are processed.
- One recall per user turn, with `budget: "low"`; tool-loop requests of the same turn reuse the block they already got.
- Memories are wrapped as **untrusted historical evidence**, and anything inside them that looks like the wrapper is escaped, so a memory cannot close the block and speak as the host.
- Capture runs only for a finished answer (`stop` / `end_turn` / `completed`), never for a truncated or failed one, and is sent asynchronously with a deterministic `document_id`.

## Cost, latency and privacy

Recall is a network call on the critical path of every new turn; against a remote Hindsight over TLS it is typically one to two seconds, and it happens once per turn, not once per tool step. Lower `recall_max_tokens`, or put Hindsight next to the gateway, if that is too much.

What leaves the machine is the latest user message plus `max_tokens` worth of recall budget, and only to the host you configured. There is no telemetry and no vendor of ours in the path. Capture additionally sends the finished exchange, and only when you turn it on.

## Known limits

- One static credential header. No OAuth, no mTLS, no rotation — put a reverse proxy in front for that.
- Replayed blocks are not deduplicated: a memory recalled in ten turns is carried ten times, until `max_replay_blocks` drops the tail.
- Exactly one recall per turn, with no in-flight de-duplication, so two concurrent requests for the same new turn can both recall.
- Hindsight does not guarantee that a repeated `document_id` is idempotent; a retried capture can therefore be stored twice.

## Development

```sh
bun test                     # 46 tests, no network, no server
node scripts/check.mjs       # syntax and published defaults
```

The settings page is served by a loopback service (`page/service.mjs`, port `3482` or the `port` option), which also answers the connection test at `/test` with a flat `{ok, code, ms, bank}` envelope and real status codes.

## License and attribution

MIT for the changes in this package, Apache-2.0 for the portions inherited from [Sam-dancing-nu1/magpie-hindsight](https://github.com/Sam-dancing-nu1/magpie-hindsight) (`0c5327f`), which does not maintain this package and has not endorsed it. Both license texts ship: [LICENSE](LICENSE), [LICENSE-APACHE](LICENSE-APACHE); attribution in [NOTICE](NOTICE).

## 中文

每次请求前从你自己的 **Hindsight** 召回记忆，按需把已完成的回合存回；作为 Magpie 网关中间件运行，不给 Agent 增加任何工具。

- 记忆追加到**本轮用户消息**尾部，不动 system prompt，前缀稳定，provider 的 prompt cache 不失效；工具循环内复用同一块，后续回合重放历史块。
- 只处理本地请求（`ctx.origin === "local"`）；非 loopback 的 API 必须显式开启 `allowRemote`，明文 HTTP 还要再开 `allowInsecureHttp`。
- 召回失败、超时、未授权一律放行请求，只记录诊断码。
- 存回默认关闭，且只存正常结束的答案。
- 密钥可写 `api_key`，也可用 `authorizationEnv` 指向环境变量；`max_replay_blocks` 限制重放的历史块数量（默认 8，超出时整段丢弃，避免每轮滑动窗口击穿缓存）。

与本仓库其它记忆类中间件的区别：这里对接的是 **Hindsight** 这个自有渠道（自己的 bank 与 recall/retain 接口），不是 PowerContext、Nowledge Mem 或 Respire；召回即全部功能，没有归档队列与后台 worker。
