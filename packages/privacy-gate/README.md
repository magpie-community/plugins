# privacy-gate — structural egress gate for Magpie

A Magpie **gateway middleware**. It is the Magpie half of
[ShyPie](https://github.com/siml1169/ShyPie)'s privacy-first workflow for
[DeepSeek Harness](https://github.com/deepseek-ai): DSH masks and extracts at ingestion, and this
gate enforces the structural half of the egress path.

It **does not mask text**. Text masking stays Magpie's Privacy setting; this plugin only checks the
request's structure. Image, file and audio parts get a **403 by default**. They pass only when **both** agree: the model
is in `localModels` (so `onRequest` allows it) **and** the provider id is in `localProviders` (so
`onProvider` keeps it). With `localModels` alone the request is not rejected, but `onProvider`
blanks the content — the request is changed silently, not sent. Encoded blobs smuggled through text
and models outside the allowlist are rejected too.

## Install

```sh
magpie plugin add @magpie-community/middleware-privacy-gate
magpie plugin options privacy-gate '{}'     # no options = strictest (all binary parts blocked)
magpie plugin                                # listed as gateway middleware
```

The options object is `ctx.options`; defaults are shown by `magpie plugin options privacy-gate`.

| Option | Default | Meaning |
|---|---|---|
| `allowModels` | `[]` | Globs against the model id as the agent asked. `[]` allows every model; if the option is present but is not an array of non-empty short strings, every request is refused instead of falling back to no allowlist. |
| `localModels` | `[]` | Model globs that may receive binary parts on `onRequest`. Pair with `localProviders`, or `onProvider` blanks the content. |
| `localProviders` | `[]` | Provider-id globs that may receive binary parts; checked in `onProvider`. |
| `blobBase64Chars` / `blobHexChars` | `400` / `400` | An encoded run at or above this is a blob (403). |
| `scanChars` | `200000` | Total text-inspection budget; each field may use at most an eighth (min 1k), so one huge field cannot starve the rest of the newest turn. |
| `allowUnknownProtocol` | `false` | Reject bodies whose `ctx.protocol` is not one of chat/responses/anthropic/gemini. |
| `binaryPolicy` | `fail` | `fail` returns 403 for a non-local binary part; `guide` withholds every binary part and injects a metadata + local-tool prompt instead. |
| `guideTools` | `[]` | Tool names advertised to the model in guide mode. Leave empty unless the local MCP server is installed. |
| `maxNodes` / `maxDepth` | `40000` / `40` | Every visited value counts, including primitives and array elements; an array wider than the remaining budget is refused without iterating. Overflow blocks (fail closed). |
| `logMaxLines` / `logEveryRows` | `40` / `50` | Self-cap on `console.log` / one usage line every N rows. |

## What it does not inspect

- Text content is Magpie's Privacy masking. Secrets in message text and tool arguments pass through
  this layer unchanged unless Magpie's masking catches them.
- The scan is **bounded**: newest conversation content is walked first; each text field may use at
  most `max(1024, scanChars/8)` characters (only the edges of a longer field), and after the total
  `scanChars` budget the rest is skipped. `system`/`instructions` are visited after the conversation,
  so a blob there behind a long history can pass. Structural checks (binary parts, model allowlist,
  value/depth limits) still fail closed; a request above `maxNodes` values is refused rather than
  passed uninspected. In moejs, the default bound costs ~76 ms for 2,000 tool turns (~3.5 MB; 403 at
  the value cap) and ~38 ms for a 200-turn (~350 KB) body that passes.
- A long encoded-looking token (a hash, a minified line) can be a false positive at 400 chars.
  Raise `blobBase64Chars`/`blobHexChars` deliberately if you need that.
- `binaryPolicy: guide` never forwards binary bytes. It replaces every binary part with text containing only `type`, `mime` and `bytes`, plus a neutral prompt to select a local extraction tool. It cannot execute the tool; the agent must have the local MCP server configured.
- In guide mode, the walk is bounded by `maxNodes` and uses the same protocol sites as the inspector, so `tool_use.input`, `tool_result.content` and other model/tool data are never rewritten as if they were content parts. The same walk scans every text field for encoded blobs, including older turns and `system`/`instructions`, so the rewritten body cannot carry an unscanned blob through.
- Vendor-sealed replay fields are exempt **only inside their vendor block**: Anthropic thinking
  `signature`, Responses reasoning `encrypted_content`, Gemini **model-role** part `thoughtSignature`,
  and vendor item `id`/`call_id`. A same-named key in tool arguments or message text is still scanned.
- No network, timers, Node APIs or imports; one file, moejs-compatible.

## Companion DSH bundle

The ingestion half lives in ShyPie:
[`@shypie_privacy/dsh-privacy-gate`](https://github.com/siml1169/ShyPie/tree/main/plugins/dsh-privacy-gate).
It redacts tool results and document text before they enter the session log and provides local
`privacy_extract` / `privacy_ocr` / `privacy_scan` / `privacy_rehydrate` tools.

## Test

```sh
bun test
bun scripts/check.mjs     # from the repository root
```

`cases.json` is run through `scripts/middleware.mjs`, the same way Magpie's gateway calls the hooks.

## License

MIT
