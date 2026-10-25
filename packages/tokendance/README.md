# TokenDance

API-key provider plugin for [magpie](https://usemagpie.ai), using the same OpenCode v1 provider hooks as the community plugins. Replaces the proposed built-in preset from yetone/magpie#762 without changing magpie itself.

## Install the local package

This package has not been published yet. From this repository's root:

```sh
magpie plugin add ./packages/tokendance
magpie plugin login tokendance
magpie plugin list
magpie provider test tokendance
```

In the GUI, open **Plugins → Add a plugin**, select this package's folder, then sign in with a key from [TokenDance](https://tokendance.space/keys). The final `provider test` command makes real, potentially billed requests; use it when you intend to verify your key. No key is bundled.

magpie stores the key in its `plugin-auth.json` in its own configuration directory. The plugin writes no credentials itself and does not import another application's sign-in. If you already have a custom provider with this id, magpie exposes the plugin provider as `tokendance-plugin`; use the id printed by `magpie plugin list` for provider commands.

Once signed in, agents can use `tokendance/<model-id>`. magpie accepts the agent's protocol and translates it into the protocol declared for that model; the plugin preserves request bodies, streaming responses, status codes, cancellation and tool calls.

## Models and options

Models come from `https://tokendance.space/gateway/v1/models`, read with the current account's key. Each model uses the first recognized API in `supported_protocols`; unknown protocols and models serving only media, embeddings, search or other non-chat APIs are left out. `bootstrap.json` holds three entries captured from that public endpoint on 2026-10-25. A failed/malformed list is reported so magpie retains its last good list; a successful empty list is empty. Only HTTP 401 on the model list marks the key expired.

Optional plugin options:

```sh
magpie plugin options tokendance '{"protocol":"responses","appURL":"app://my-magpie"}'
```

`protocol` is `auto` (default), `chat`, `responses` or `anthropic`. The preference applies only where the model advertises that protocol; otherwise its first supported protocol is used. `appURL` sets the optional `X-App-URL` attribution header (HTTP URLs and desktop `app://` identifiers are accepted). It is absent by default. `baseURL` defaults to `https://tokendance.space/gateway/v1`; a trusted proxy/test server can replace it. Do not put a key in these options.

The public catalog does not supply prices or reliable tool/vision/reasoning limits. This plugin does not invent pricing, claim models are free, or implement balance/quota reporting; check billing in TokenDance. Standard text/tool requests are passed through unchanged. It does not implement API-key OAuth, image generation or media APIs.


For local OpenCode, add the absolute path to `index.mjs` to `plugin` in `opencode.json`, then use `opencode auth login`. The hook shape is compatible; an OpenCode runtime has not been tested here.

## Verification

```sh
bun test ./packages/tokendance
bun scripts/check.mjs tokendance
MAGPIE_SOURCE=/path/to/magpie bun test scripts/relay-host.test.mjs
MAGPIE_BINARY=/path/to/magpie-binary bun test scripts/relay-gateway.test.mjs
```

The host integration test uses magpie's real, unmodified `internal/plugin/host.js`, temporary credentials and a local upstream. It loads both packages, signs in through `apiKey`, discovers all three protocols and forwards six streamed requests, preserving the existing ZenMux OAuth record. Unit tests also cover bad catalogs, empty lists, cross-account isolation, key changes and destination checks. The gateway test installs both folders through the CLI, signs in with test keys and sends six Chat requests through the HTTP gateway, including translation to Responses and Anthropic Messages. It uses a copied binary and a temporary HOME. No real-key inference was run.

## References

- [magpie plugin reference](https://usemagpie.ai/docs/plugins)
- [Community Zen Free plugin](https://github.com/magpie-community/plugins/tree/main/packages/zen-free)
- [TokenDance documentation](https://tokendance.space/docs/ai-integration.md)
- [Original PR](https://github.com/yetone/magpie/pull/762)

[中文安装说明](README.zh-CN.md)
