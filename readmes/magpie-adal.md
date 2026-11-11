# Adal

[简体中文](./README.zh-CN.md) · [npm](https://www.npmjs.com/package/magpie-adal) · [GitHub](https://github.com/raythunder/magpie_adal)

A [Magpie](https://usemagpie.ai) provider plugin that uses your locally installed, signed-in [AdaL CLI](https://adal.sylph.ai). Package: `magpie-adal`. Provider id: `adal`.

It uses Magpie's supported OpenCode v1 plugin format, with no runtime dependencies and no additional HTTP server to manage. AdaL keeps its own credentials; Magpie stores only a local connection marker. Model requests go directly through AdaL's cloud proxy using each provider's native protocol, without AdaL's Agent prompt or tool loop.

## Install

Install AdaL CLI **1.10.3 or newer**, run `adal` in a terminal, and complete its sign-in first. This implementation was checked against AdaL 1.10.3 and Magpie 0.1.1318. Re-run live checks after upgrading AdaL.

After upgrading from 0.2.x, turn the plugin off and on to refresh native model APIs. Existing `adal/default`, `adal/<model-key>`, and local sign-in markers remain valid.

In Magpie, open **Plugins → Add plugin** and enter:

```text
magpie-adal
```

Or use Magpie's CLI:

```sh
magpie plugin add magpie-adal
magpie plugin login adal
magpie provider test adal default
```

You can also install from GitHub:

```sh
magpie plugin add github:raythunder/magpie_adal
```

For local development, clone into a folder named `Adal` and add that folder:

```sh
git clone https://github.com/raythunder/magpie_adal.git Adal
magpie plugin add "$PWD/Adal"
```

For folder installs, the first line in Magpie's plugin list is the folder name; the second line is the provider name, **Adal**. An npm install may show the package name. Friendly names in Magpie's official market come from its market registry; this project is distributed separately.

On macOS, if `magpie` is not in PATH, replace it with `/Applications/magpie.app/Contents/MacOS/magpie`. After changing local plugin files or refreshing the model catalog, turn the plugin off and back on in the app.

## Sign in

Select **Use local AdaL CLI sign-in** for the **Adal** provider. This checks the existing CLI sign-in without sending a model query. It does not ask for an API key.

Magpie saves only a `local-cli` marker in `plugin-auth.json`. Each model request authenticates through the original SDK, then reads `~/.adal/adal_oauth_creds.json` (or the original `ADAL_AUTH_TOKEN`) into memory to call AdaL's own proxy. Tokens are not written to Magpie configuration or logs. If the SDK or proxy refuses authentication, sign in again with `adal`; the plugin does not implement a separate login or renewal mechanism. Signing out of this provider does not sign out of AdaL.

All accounts added through this plugin share the same local AdaL sign-in; independent multiple accounts are not supported.

## Models

Select `adal/default` for the catalog's default model, or `adal/<model-key>` for a specific model. Names, API ids, limits, default parameters, and reasoning variants come from `~/.adal/model_catalog.json`. Run `adal` to refresh it, then reload the plugin.

| Native API | Providers | Magpie AI SDK |
| --- | --- | --- |
| Anthropic Messages | Anthropic, MiniMax | `@ai-sdk/anthropic` |
| OpenAI Responses | OpenAI, xAI, DeepSeek, Meta | `@ai-sdk/openai` |
| Chat Completions | Kimi, Z.ai, Qwen | `@ai-sdk/openai-compatible` |
| Gemini generateContent | Google | `@ai-sdk/google` |

Local models and connected ChatGPT subscriptions are excluded. Requests also verify the SDK's actual model and `connection_mode`; BYOAK and third-party credential paths are refused explicitly, so their billing source never silently changes. Use the AdaL CLI for those paths. Catalog entries do not guarantee account access or remaining allowance.

## Requests and tools

Magpie converts client requests into the selected model's native API. A short-lived `adal --sdk-runtime` session authenticates and checks the model and configuration; the plugin **never sends an SDK `query`**. Model requests go directly to the original AdaL `/proxy` endpoints, using its JWT, provider target, session/client headers and Base64 body encoding. The configured loopback API URL is an identifier, not a listening service.

- Native instructions, message history, images, tool schemas, and tool results are preserved. Image support follows the catalog.
- The calling Agent executes native tool calls. There is no prompted JSON tool bridge, AdaL tool execution, or repair query.
- Defaults come from the original catalog and the SDK's effective reasoning setting. Explicit native caller parameters take precedence. `max_input_tokens` is local context metadata, not an upstream API parameter.
- Like AdaL, upstream requests always stream. Streaming callers receive native events; non-streaming callers receive an assembled native reply, preserving tool arguments, reasoning signatures, and real usage. Assembly reuses the community Zed plugin; see [third-party notices](./THIRD_PARTY_NOTICES.md).
- Request/body cancellation, timeouts, process cleanup, and truncated-stream detection are supported. Upstream HTTP errors and `Retry-After` are preserved. Token usage and costs are not invented.

Provider parameter rules still apply: for example, Anthropic adaptive thinking cannot force a specific tool. The plugin does not silently disable reasoning to work around this. Audio, video, and image generation are outside this chat integration.

Live checks cover Anthropic streaming text, non-streaming native tools and tool results, plus OpenAI, Google, and Kimi streaming text. Other routes follow local AdaL 1.10.3 source but have not each received a live query. Magpie 0.1.1318's `provider test` incorrectly probes Google over Chat; use the native live check below for Gemini.

## Usage

Magpie's provider quota panel shows the plan, weekly usage percentage, weekly reset time, and wallet balance. You can also query:

```sh
magpie quota adal
magpie quota adal --json
```

Quota lookup starts a short-lived authenticated SDK process, locates only its process group's local backend, reads `/auth/usage`, and closes the process. It sends no model query and does not read or copy login tokens. Authentication, model connections, and quota lookup require `lsof`: included with macOS, separately installed on Linux. Windows is currently unsupported.

Wallet balance uses the same `$` unit as AdaL's `/usage` dialog. A `$0.00` wallet does not mean the included weekly allowance is exhausted. Usage covers the entire AdaL account, including direct CLI use; monthly totals are not estimated.

The weekly window is informational, so it does not disable every model when exhausted: BYOAK or connected subscriptions may still work. Failed lookups show an error instead of zero usage, and only authentication rejection marks the sign-in expired.

## Options

Usually no options are needed. Magpie's plugin options accept:

```json
{
  "cliPath": "/absolute/path/to/adal",
  "timeoutMs": 300000
}
```

CLI resolution: `cliPath` → `ADAL_RUNTIME_PATH` → `~/.adal/bin/adal` → `adal` on PATH. `cliPath` is an executable path, not a shell command. `timeoutMs` must be an integer of at least 1000; the default is five minutes. Default account concurrency is one, requests are capped at 4 MiB, initialization output at 1 MiB, and model responses at 16 MiB.

Cloud requests use the Magpie plugin host's `fetch` and its provider/account proxy settings. CLI authentication and catalog refresh use AdaL's own network environment. `ADAL_PROXY_URL`, `ADAL_APP_URL` (legacy `BACKEND_API_URL`) select the platform endpoint as in AdaL; HTTPS is required, except HTTP loopback for testing. Temporary workspaces are removed; SDK startup may still create AdaL session metadata.

## Development

Node.js **22+** is required for the development scripts. No `npm install` is necessary; Magpie loads the plugin using Bun.

```sh
npm test
npm run test:magpie
npm run test:quota
npm pack --dry-run
```

`test:magpie` uses a fake SDK and local cloud proxy in isolated HOME/XDG directories, checking Magpie loading, login, quota, Anthropic, Responses and Chat, plus Gemini translation and native tool round-trip through a real isolated gateway. It leaves your existing configuration alone. Set `MAGPIE_BIN` for a different installation. Unit tests also cover Gemini, credential rereads, billing-path checks, cancellation, timeouts and truncated streams. `test:quota` uses the real account without a model query.

Live model checks send three small queries and consume your AdaL allowance:

```sh
npm run test:live
ADAL_TEST_MODEL=<Anthropic-model-key> npm run test:live
ADAL_TEST_MODEL=<other-model-key> npm run test:live -- --text-only
```

The full check covers sign-in, SSE, non-streaming native tools and tool results without executing tools. `--text-only` sends one text query and supports the other protocols. Re-run checks after upgrading AdaL; the SDK and cloud proxy remain internal integration points.

Based on the [Magpie plugin documentation](https://usemagpie.ai/docs/zh/plugins), [community plugin examples](https://github.com/magpie-community/plugins), and AdaL's [SDK reference](https://docs.sylph.ai/integration/sdk/api-reference), [models](https://docs.sylph.ai/getting-started/models), and [pricing and usage](https://docs.sylph.ai/getting-started/pricing-and-usage). Protocol and quota fields were also checked against the locally installed CLI source.

## License

[MIT](./LICENSE).
