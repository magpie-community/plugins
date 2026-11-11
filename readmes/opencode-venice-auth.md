# opencode-venice-auth

Use your own [Venice.ai](https://venice.ai) API key to run Venice text models in OpenCode and magpie. The plugin talks to the OpenAI-compatible endpoint `https://api.venice.ai/api/v1`, fetches the model list live after sign-in, and adds key balances and rate-limit caps to `magpie quota`.

Provider id: `venice`. Models are referenced as `venice/<model-id>`.

Repository: <https://github.com/Tomahawkd/opencode-venice-auth>

## Sign-in

Generate an API key in your Venice account, then run:

```sh
magpie plugin login venice
```

magpie asks for the key once in a single text prompt. The value is used as-is apart from trimming surrounding whitespace; the plugin does not check a prefix or a key format before contacting Venice.

The key is validated with `GET /api_keys/rate_limits`. An invalid key fails with `Venice rejected this API key (HTTP 401)`; the sign-in stops there and nothing is saved. A key that cannot use inference endpoints fails with `This key cannot use Venice inference APIs (accessPermitted=false)`. On success, magpie stores the sign-in state in its local plugin credential store. If a saved key is later rejected with HTTP 401 — for example after it is revoked in Venice — magpie then marks the account as needing to sign in again.

### HTTP 402 is not an expired sign-in

Venice answers HTTP 402 both when the account balance is insufficient and when a per-key spending cap has been reached. The plugin presents this as a balance or cap condition; the usage view reports `Venice reports insufficient balance or a spending cap was reached (HTTP 402)`. It does not mark the account as expired, because signing in again cannot fix it. Check the balance in Venice or raise the key's spending cap instead. Only HTTP 401 marks the account as expired.

## Models

After sign-in, `provider.models` fetches `GET /models?type=text` with the saved key on every load and replaces the account's model list as a whole. If the fetch fails, the existing list is kept (falling back to the built-in catalog); an HTTP 401 marks the account as expired.

Models are skipped when they are offline, in beta, deprecated, end-to-end encrypted (by id prefix, the E2EE capability, or TEE attestation), or do not support function calling. The rest are mapped onto OpenCode's nested model shape:

- `availableContextTokens` and `maxCompletionTokens` become the context and output limits.
- Reasoning, tool-call, vision (as both image input and attachments), and audio-input support become capability flags.
- Venice's input and output prices and the cache read/write prices, in USD per million tokens, become the model costs; a cache read or write price Venice does not report is mapped to 0.

The list changes as Venice changes it, so this README intentionally contains no static model table or model count.

### Venice's default system prompt

The plugin does not send `venice_parameters` in requests. Venice therefore applies its default `include_venice_system_prompt: true`, which means Venice includes its own default system prompt with requests. See the [Venice API reference](https://docs.venice.ai/api-reference) for details and how to override this behavior.

## Usage

`magpie quota`, and the Providers usage card, show what Venice reports for the key:

- All balances that are present, joined in the order USD, DIEM, BUNDLED_CREDITS, for example `$50.23 · 100.023 DIEM · 25 BUNDLED_CREDITS`.
- The key expiration time, when there is one.
- Rate-limit caps summarized per limit type as a range (for example `50-100 across 119 models`), with account-wide caps listed first. Only caps are shown: Venice does not report consumption, so the plugin does not invent a used amount. Per-model caps remain available from Venice at `GET /api_keys/rate_limits`.

An HTTP 402 from a usage request is displayed as the balance or spending-cap condition described in [Sign-in](#http-402-is-not-an-expired-sign-in).

## Install

```sh
git clone https://github.com/Tomahawkd/opencode-venice-auth
cd opencode-venice-auth
magpie plugin add ./
magpie plugin login venice
magpie provider test venice
```

Without cloning, install straight from the repository: `magpie plugin add https://github.com/Tomahawkd/opencode-venice-auth`.

From npm, install the published package: `magpie plugin add opencode-venice-auth`.

The package is also an OpenCode v1 plugin and can be used as an OpenCode plugin.

## Development

Development requires [bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/).

```sh
bun install
bun test
bun run typecheck
uvx pluvy --all
```

Exit codes and results follow the project's rules:

- `bun test` fails on any non-zero exit. Tests must be fixed, not removed, skipped, or weakened.
- `bun run typecheck` must report no errors.
- `uvx pluvy --all` passes only with exit 0 and a reported file count greater than 0. Exit 1 means a code problem that must be fixed in the code; exit 2 means an environment or configuration problem and is not a pass.

Released under the [MIT License](LICENSE). This project is not affiliated with Venice.ai. Bugs and feature requests belong in the [issue tracker](https://github.com/Tomahawkd/opencode-venice-auth/issues).
