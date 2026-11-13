# magpie-llm-detector

English | [简体中文](README.zh-CN.md)

A [magpie](https://usemagpie.ai) tool plugin that verifies which LLM actually serves an endpoint: it asks the endpoint's model to write a few hundred integers "from first instinct", compares the value distribution against a 70-model reference bank, and reports the closest candidates with confidence.

Model fingerprint detection is powered by [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector) (the `lmfpd` npm package, MIT). This plugin only packages it as magpie MCP tools — every detection request goes directly from your machine to the endpoint you specify, and credentials never leave it.

## Tools

Exposed to every agent through magpie's tools MCP server (`/mcp/magpie/tools`):

| Tool | Purpose |
| --- | --- |
| `magpie-llm-detector_check` | Run a detection round against `baseUrl` + `apiKey` + `model` (`protocol`: `chat` / `anthropic` / `responses`, default `chat`; `rounds` 1–3, default 1). Returns a ranked report and stores it in history. |
| `magpie-llm-detector_history` | Read past reports (no secrets stored, base URLs reduced to hostnames) to aggregate multi-round checks. |

## Install

```sh
magpie plugin add magpie-llm-detector        # npm package
magpie plugin add /path/to/magpie-llm-detector   # or a local folder
```

The plugin shells out to the bundled `lmfpd` CLI, which runs on Bun (magpie's plugin host provides it) or Node.js ≥ 22.

## How to use

Ask your agent: *"检测一下 https://api.example.com/v1 的 gpt-6-astra，key 是 sk-…"* — or call the tool directly.

- **Third-party relay / API**: pass the relay's `baseUrl`, `apiKey` and the claimed `model`.
- **A provider inside magpie itself**: create a gateway key, then use `baseUrl: http://127.0.0.1:<port>/v1`, your gateway key as `apiKey`, and `model: <provider>/<model>` — the detection then covers magpie's whole chain.

The apiKey is passed to the detection subprocess through an environment variable; it never appears in reports, history, or logs.

## Cost and limits

- One round = 3 generation requests (each asks for ~300 integers; roughly 1–3k output tokens in total). The tool enforces a 50-second budget; on slow models you may get a partial ranking without a confidence score.
- 1–2 valid samples still produce a ranking; a calibrated confidence requires 3.
- Results are a **closed-set ranking inside the reference bank** — never an identity proof. Fix the request parameters, repeat over several rounds (`history` aggregates them), and cross-check other evidence before judging a channel.

## Development

```sh
bun add lmfpd
npm test        # node --test; 21 tests, hermetic (real lmfpd + local mock endpoint, zero external requests)
bun test        # same suite under Bun
```

## Attribution

- Detection algorithm, reference bank and CLI: [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector) (MIT), which credits [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) for original ideas and data.
- This integration: MIT, © aqiu817. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## License

MIT
