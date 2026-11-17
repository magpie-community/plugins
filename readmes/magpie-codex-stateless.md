# magpie-codex-stateless

A [magpie](https://usemagpie.ai) gateway middleware that fixes the Azure-relay **400s GPT models** hit on the Responses API: before routing, it makes Codex requests **stateless** — stripping the server-bound state (`previous_response_id`, per-item `id`s (`msg_…`, `rs_…`, `fc_…`) and `encrypted*` fields (encrypted reasoning content)) — so relays that pool multiple Azure OpenAI resources without session stickiness accept **every** request, not just the lucky ones.

By default it only acts on **GPT/Codex-family models** speaking the Responses protocol (`ctx.protocol === "responses"`), e.g. Codex CLI / VS Code extension / desktop app routed through magpie; everything else passes untouched, including response streams.

## The problem it fixes

Azure OpenAI's Responses API is stateful: returned items and encrypted reasoning (`encrypted_content`) are stored/encrypted by the Azure resource that created them. One-API-style relays rotate across a resource pool, so when Codex replays its history (ids + encrypted blobs + `previous_response_id`), requests landing on a different resource fail:

```
Previous response with id 'resp_…' not found.
The requested item was created under a different Azure OpenAI resource.
The encrypted content for item rs_… could not be verified.
```

Measured on a real relay (agentrouter, Responses-native passthrough): a 1:1 Codex replay with real state → **400 after ~19 s**; the same request with the state stripped → **200, `response.completed`**. (This middleware strips *before* routing — there is no retry, no wasted round trip.)

## Install

```sh
magpie plugin add github:aqiu817/magpie-codex-stateless   # from GitHub (recommended)
magpie plugin add ./magpie-codex-stateless                # or from a local folder
```

> Note: this is a middleware-only package (no provider entry point). Current magpie builds reject middleware-only **npm** packages at the host check when installed by name (`magpie plugin add magpie-codex-stateless`), so install from GitHub or a folder. The npm package exists for registry/search metadata.

Then just leave it on. It is silent by default.

## Options

Set via the plugin's options button (JSON) or `magpie plugin options magpie-codex-stateless '<json>'`:

| Option | Default | Meaning |
| --- | --- | --- |
| `models` | `""` → built-in `["gpt", "codex"]` | Scope: only strip matching models — a string or array, `/regex/` style (same convention as the community `model-map`) or plain substring. Unset/empty = GPT/Codex-family models only; `"*"` = strip on every Responses model. |
| `debug` | `false` | Log one line per stripped request (`codex-stateless: model=… stripped=4 (prevId=1 ids=2 encrypted=1)`) into magpie's log. Rate-capped by magpie at 60 lines/min. |
| `stripPreviousResponseId` | `true` | Set `false` to keep the conversation pointer — only for incremental clients that rely on server-side state **and** an upstream with session stickiness. On a sticky-less relay keeping it means 400 `Previous response not found` on every replay. |
| `stripEncrypted` | `true` | Set `false` to keep `encrypted_content` so the model can continue its previous-turn reasoning on upstreams that decrypt it. On verification-enforcing Azure backends keeping it triggers `The encrypted content … could not be verified`; on lenient relays it just costs extra replayed tokens per turn. |

## What is stripped / kept

| Stripped (server-bound state) | Kept (everything else) |
| --- | --- |
| top-level `previous_response_id` | message contents, `instructions` |
| `id` on every `input` item | `call_id` on tool calls and outputs, tool `arguments` |
| any `encrypted*` field (`encrypted_content`, …) | `store`, `include`, `reasoning`, `tools`, headers |

Other agent protocols (`anthropic`, `chat`, `gemini`) carry no such state and pass through untouched. magpie's own requests (session titles, routing classifier, web search) never reach middleware.

## The cost

The model no longer continues its hidden reasoning across turns; it re-reasons each turn. Conversation content and tool calling are unaffected. On a relay without stickiness this is not really a cost — the state was going to be rejected anyway.

## Consequences of stripping on every request

Measured on a real relay (agentrouter, Responses-native), per field:

| Stripped field | Functional impact | Measured |
| --- | --- | --- |
| `previous_response_id` | None for full-history-replay clients (Codex always replays the whole conversation in `input` — confirmed by packet capture in the upstream project and by our live tests). Only an *incremental* client that relies on the server to hold context would lose it — keep the pointer for those via `stripPreviousResponseId: false`. | Without strip: 400 in ~19 s; with strip: 200 |
| item `id` | None — `call_id` pairing is untouched, so tool loops keep working | 200 |
| `encrypted*` | None functionally: the relay neither verifies the blobs (real ones replay fine, 200) nor can continue from them without stickiness. Stripping saves the re-uploaded blob tokens every turn; keeping them (via `stripEncrypted: false`) only helps on upstreams that decrypt and continue | kept-real-blob: 200; stripped: 200 |

Prompt caching is unaffected (stripping is applied consistently, so the request shape stays stable across turns). magpie's failover and retry mechanics see an identical request every attempt — stripping is idempotent.

## Relation to `aggregate-repair`

[xwyjh3612/aggregate-repair](https://github.com/xwyjh3612/aggregate-repair) is a sibling middleware with conservative defaults (keeps the conversation pointer and encrypted blobs by default, adds a settings page, and derives per-provider session ids to dodge 409 bindings). Its defaults suit unknown clients and possibly-sticky upstreams; ours suit the measured case where the relay discards server state within ~20 s and every replay must be self-contained. With `stripPreviousResponseId: false` + `stripEncrypted: false` this plugin behaves like its default mode.

## Development

```sh
bun test test/strip.test.mjs    # 32 tests, incl. moejs-sandbox static checks
```

`lib/strip.js` is the port of [codex-strip-proxy](https://github.com/AnnaofArendelle/codex-strip-proxy)'s `sanitize()`, deliberately written in a conservative JS subset (verified in magpie's moejs sandbox).

## License

MIT
