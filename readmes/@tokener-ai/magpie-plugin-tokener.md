# Tokener.ai for magpie

A Tokener.ai provider plugin for OpenCode and magpie: API key sign-in, model discovery, Chat and Messages. Tested with magpie v0.1.1161. The entry is plain ESM: no build step or runtime dependencies.

## Links

- [GitHub](https://github.com/tokener-ai/magpie-plugin-tokener)
- [npm](https://www.npmjs.com/package/@tokener-ai/magpie-plugin-tokener)
- [Tokener.ai](https://tokener.ai)
- [Console](https://console.tokener.ai) — create a model API key.

## Install and sign in

```sh
magpie plugin add github:tokener-ai/magpie-plugin-tokener
magpie plugin login tokener api
magpie provider refresh tokener
magpie models
```

The GitHub repository is public. Create a model API key at [console.tokener.ai](https://console.tokener.ai), then enter it at the login prompt. magpie stores the key and supplies the protocol-specific authentication headers. A management PAT is not needed. No usage or balance hook is provided.

For a local checkout:

```sh
magpie plugin add /absolute/path/to/magpie-plugin-tokener
```

From npm:

```sh
magpie plugin add @tokener-ai/magpie-plugin-tokener
```

In the magpie GUI, open **Plugins** → **Discover** and clear the search field. In **Have one in mind?**, enter `@tokener-ai/magpie-plugin-tokener` or `github:tokener-ai/magpie-plugin-tokener`, then click **Install**.

## Models and protocols

The plugin joins the API key's authorized model IDs from `GET https://api.tokener.ai/v1/models` with the public catalog at `https://console.tokener.ai/api/public/v1/models`. Only IDs present in both lists appear. Authorized-only IDs such as the decision model `jev-latest` are silently excluded; they cannot use Chat or Messages. Text embedding models are excluded. Public metadata supplies names, capabilities and USD prices per million tokens. Authorized `max_input_tokens` and `max_output_tokens` take precedence over public context/output limits; missing output limits use the public value or zero.

Anthropic catalog entries use magpie's native Messages path (`/v1/messages`); other entries use its native Chat path (`/v1/chat/completions`). Each entry declares its upstream model ID explicitly. magpie handles streaming, tool calls, cancellation and API-key injection. Request statuses are preserved: magpie marks a 401 account lapsed and handles 402 as a credit error.

If only public metadata fails, the plugin intersects the current authorized IDs with the embedded public snapshot. If authorized discovery fails for reasons other than 401, the plugin returns an explicitly marked public-catalog fallback, or the embedded snapshot if both endpoints fail. magpie can retain its last successful authorized list; without one, fallback models are provisional and may not be authorized for the key. Discovery 401 uses magpie's expired-sign-in contract. Snapshot metadata and prices can become stale; refresh discovery to obtain current values.

## Option

`baseUrl` is the only option. Its default is `https://api.tokener.ai/v1`; it must be an HTTP(S) API base without credentials, query or fragment. The API key is sent to this URL. For a trusted alternative endpoint, configure the installed plugin spec:

```sh
magpie plugin options github:tokener-ai/magpie-plugin-tokener '{"baseUrl":"https://api.tokener.ai/v1"}'
```

For a local installation, replace the GitHub spec with the same absolute directory used for `plugin add`. The public catalog URL stays fixed.

## Development and verification

Use Bun 1.3.14 or later:

```sh
bun test
bun run check
bun scripts/verify-host.mjs /absolute/path/to/magpie-v0.1.1161/internal/plugin/host.js
bun scripts/verify-magpie.mjs /absolute/path/to/magpie
```

Tests use a local mock service and reject external fetches. The host probe also redirects public discovery to that service. The binary probe creates its own temporary HOME and XDG directories, seeds a local models.dev cache, installs this checkout, uses an obvious fake API key, and exercises magpie's local gateway. It refuses portable storage beside the executable. These probes do not change real magpie accounts or settings. The repository's `docs/verification.md` records commands, versions, observed results and remaining gaps.

Live verification is separate and requires explicit authorization through a key file:

```sh
TOKENER_SMOKE_KEY_FILE=/absolute/path/to/temporary-smoke-key bun scripts/verify-live.mjs /absolute/path/to/magpie
```

The file must have mode 600. The probe reads the key only from that file, uses an isolated HOME, caps each model request at 64 output tokens and each run at 15 model calls, and writes only sanitized evidence. It waits at least 2.2 seconds between authenticated requests. It uses `gpt-5.6-luna` for Chat and `claude-sonnet-5` for Messages, and tests tool round trips, cancellation and invalid-key discovery. The live probe is excluded from default tests and CI.
