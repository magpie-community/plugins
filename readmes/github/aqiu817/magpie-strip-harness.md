# magpie-strip-harness

English | [简体中文](README.zh-CN.md)

A [magpie](https://usemagpie.ai) gateway middleware that strips harness-injected identity prompts — such as DeepSeek Harness's opener **"You are an AI agent powered by DeepSeek Harness."** — from the `system` role of agent requests before they are routed to any provider.

It edits requests only; replies and stream events pass through untouched. It applies to every provider behind the magpie gateway.

## Why

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) composes its system prompt from ordered blocks and prepends a fixed first-party opener (`includeHarnessIdentity`, order −1000), plus harness mentions like the Web-GUI prompt ("You are interacting with the user through the DeepSeek Harness Web GUI …"). If you route DSH through magpie and would rather the upstream model never see that harness framing, this middleware removes those paragraphs at the gateway.

> Tip: DSH itself has a native `includeHarnessIdentity: false` profile option. Use this middleware instead when you cannot (or do not want to) touch client config, when several clients connect to the same gateway, or when you also want other harness mentions (Web-GUI prompt, dev-context prompt) removed.

## Install

```sh
git clone https://github.com/aqiu817/magpie-strip-harness.git
magpie plugin add ./magpie-strip-harness
```

(or add the cloned folder path in the app: Plugins → Add plugin). The package has no `main`/`exports`, so magpie treats it as pure middleware.

## How it strips

Granularity is conservative and aims to remove as little as possible:

1. **Paragraph pass** — the system text is split on blank lines; paragraphs matching a pattern are dropped. This handles multi-line harness paragraphs (e.g. the Web-GUI opener).
2. **Line fallback** — if the text has no blank-line structure, or the paragraph pass would wipe the whole text, matching *lines* are dropped instead, so unrelated content always survives.

A message/field that ends up empty is removed entirely (`body.system` deleted, empty chat `system` message dropped). Anthropic `cache_control` and other block fields are preserved on surviving blocks.

Works across protocols — the body is read in the agent's own API format:

| Protocol | Fields handled |
| --- | --- |
| `chat` | `messages[]` with `role: system` / `developer` (string or content parts) |
| `anthropic` | `system` (string or blocks array) |
| `responses` | `instructions` + `input[]` system/developer items |
| `gemini` | `systemInstruction` / `system_instruction` (string or `{parts}`) |
| unknown | tries all of the above shapes defensively |

## Options

Edit in the app (Plugins → installed → options) or:

```sh
magpie plugin options magpie-strip-harness '{"debug": true}'
```

| Option | Default | Meaning |
| --- | --- | --- |
| `patterns` | `["/deepseek[\\s_-]*harness/i"]` | Matchers applied per paragraph/line. An item like `"/regex/i"` is compiled as a regex; any other string is a case-insensitive substring. Providing this **replaces** the defaults; if every provided pattern is invalid (e.g. a regex typo), the defaults are used instead so stripping never silently turns off. |
| `stripAll` | `false` | When any pattern matches a system text, remove the whole system content instead of surgical paragraphs. |
| `debug` | `false` | Log one line to the magpie log (`plugin: [strip-harness] …`) per modified request. |

## Verify

```sh
magpie plugin options magpie-strip-harness '{"debug": true}'
# then send a request through the gateway with a harness opener in the system role, e.g.
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "Authorization: Bearer <gateway-key>" -H "content-type: application/json" \
  -d '{"model":"<provider>/<model>","messages":[{"role":"system","content":"You are an AI agent powered by DeepSeek Harness.\n\nBe concise."},{"role":"user","content":"hi"}]}'
```

The magpie log shows `[strip-harness] chat <model>: removed harness prompt from system role`, and the upstream request goes out without the opener. Settings → Plugins also shows the middleware's call count and failures.

## Limits

- Removal granularity is blank-line paragraphs / lines. A system prompt squeezed into a single line with no newlines cannot be partially stripped — use `stripAll` or a tighter pattern in that case.
- Editing the system prompt naturally invalidates provider-side prompt caching for that request.
- magpie's own internal requests (session titles, router classification) never pass through middleware.
