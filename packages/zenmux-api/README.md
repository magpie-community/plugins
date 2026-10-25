# ZenMux API Key

API-key provider plugin for [magpie](https://usemagpie.ai), using the same OpenCode v1 provider hooks as the community plugins. Replaces the proposed built-in preset from yetone/magpie#1009 without changing magpie itself.

## Install the local package

This package has not been published yet. From this repository's root:

```sh
magpie plugin add ./packages/zenmux-api
magpie plugin login zenmux-api
magpie plugin list
magpie provider test zenmux-api
```

In the GUI, open **Plugins → Add a plugin**, select this package's folder, then sign in with a key from [ZenMux API Key](https://zenmux.ai/platform/pay-as-you-go). The final `provider test` command makes real, potentially billed requests; use it when you intend to verify your key. No key is bundled.

magpie stores the key in its `plugin-auth.json` in its own configuration directory. The plugin writes no credentials itself and does not import another application's sign-in. If you already have a custom provider with this id, magpie exposes the plugin provider as `zenmux-api-plugin`; use the id printed by `magpie plugin list` for provider commands.

Once signed in, agents can use `zenmux-api/<model-id>`. magpie accepts the agent's protocol and translates it into the protocol declared for that model; the plugin preserves request bodies, streaming responses, status codes, cancellation and tool calls.

## Models and options

The provider id is `zenmux-api`. Existing `zenmux` OAuth accounts and custom providers are not renamed or migrated.

Models come from the public `zenmux` section of models.dev, cached for five minutes across accounts. The catalog's per-model SDK chooses Chat Completions, Responses or Anthropic Messages. Vendor-prefixed model ids stay intact. The API key is never sent to models.dev; catalog-provided hosts are not trusted as key destinations. `bootstrap.json` holds three models captured from models.dev on 2026-10-25 for startup/offline display. A catalog failure is reported to magpie so it retains the last good list.

Options: `baseURL` (Chat/Responses), `anthropicBaseURL` (must end in `/v1`), and `catalogURL` are optional HTTP(S) URLs for a trusted proxy or local test. The defaults are `https://zenmux.ai/api/v1`, `https://zenmux.ai/api/anthropic/v1`, and `https://models.dev/api.json`.


For local OpenCode, add the absolute path to `index.mjs` to `plugin` in `opencode.json`, then use `opencode auth login`. The hook shape is compatible; an OpenCode runtime has not been tested here.

## Verification

```sh
bun test ./packages/zenmux-api
bun scripts/check.mjs zenmux-api
MAGPIE_SOURCE=/path/to/magpie bun test scripts/relay-host.test.mjs
MAGPIE_BINARY=/path/to/magpie-binary bun test scripts/relay-gateway.test.mjs
```

The host integration test uses magpie's real, unmodified `internal/plugin/host.js`, temporary credentials and a local upstream. It loads both packages, signs in through `apiKey`, discovers all three protocols and forwards six streamed requests, preserving the existing ZenMux OAuth record. Unit tests also cover bad catalogs, empty lists, cross-account isolation, key changes and destination checks. The gateway test installs both folders through the CLI, signs in with test keys and sends six Chat requests through the HTTP gateway, including translation to Responses and Anthropic Messages. It uses a copied binary and a temporary HOME. No real-key inference was run.

## References

- [magpie plugin reference](https://usemagpie.ai/docs/plugins)
- [Community Zen Free plugin](https://github.com/magpie-community/plugins/tree/main/packages/zen-free)
- [ZenMux API Key documentation](https://docs.zenmux.ai/guide/quickstart)
- [Original PR](https://github.com/yetone/magpie/pull/1009)

[中文安装说明](README.zh-CN.md)
