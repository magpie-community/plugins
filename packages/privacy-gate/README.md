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
| `allowModels` | `[]` | Globs against the model id as the agent asked. `[]` allows every model. |
| `localModels` | `[]` | Model globs that may receive binary parts on `onRequest`. Pair with `localProviders`, or `onProvider` blanks the content. |
| `localProviders` | `[]` | Provider-id globs that may receive binary parts; checked in `onProvider`. |
| `blobBase64Chars` / `blobHexChars` | `400` / `400` | An encoded run at or above this is a blob (403). |
| `scanChars` | `200000` | Text-inspection budget; the middle of very long fields is not blob-scanned. |
| `allowUnknownProtocol` | `false` | Reject bodies whose `ctx.protocol` is not one of chat/responses/anthropic/gemini. |
| `maxNodes` / `maxDepth` | `40000` / `40` | Structural walk limits; overflow blocks (fail closed). |
| `logMaxLines` / `logEveryRows` | `40` / `50` | Self-cap on `console.log` / one usage line every N rows. |

## What it does not inspect

- Text content is Magpie's Privacy masking. Secrets in message text and tool arguments pass through
  this layer unchanged unless Magpie's masking catches them.
- The scan is **bounded**: newest conversation content is walked first, and above `scanChars` per
  field only its edges are scanned. An encoded blob in the unscanned middle of an enormous text
  field, or in older history after the budget is spent, can pass; DSH's Gate 1 scans each tool
  result separately. Structural checks (binary parts, model allowlist, node/depth limits) still fail
  closed.
- A long encoded-looking token (a hash, a minified line) can be a false positive at 400 chars.
  Raise `blobBase64Chars`/`blobHexChars` deliberately if you need that.
- Vendor-sealed replay fields are exempt **only inside their vendor block**: Anthropic thinking
  `signature`, Responses reasoning `encrypted_content`, Gemini part `thoughtSignature`, and vendor
  item `id`/`call_id`. A same-named key in tool arguments or message text is still scanned.
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
