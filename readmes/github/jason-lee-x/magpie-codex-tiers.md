# Magpie Codex Tiers

English | [简体中文](README.zh-CN.md)

Per-model Codex `service_tier` controls for [Magpie](https://github.com/yetone/magpie), with optional temporary Fast or Ultrafast mode when a quota-reset forecast arrives.

## Features

- Global defaults and per-model rules, with fuzzy model search.
- Four modes: Keep (preserve the client's value), Remove (delete `service_tier`), Fast (`priority`), and Ultrafast (`ultrafast`). Tier availability depends on the upstream provider.
- Reset forecasts from [didcodexreset.com](https://didcodexreset.com), displayed in your system timezone with a countdown.
- Optional temporary acceleration that overrides this plugin's normal rules and restores them after a detected quota reset or forecast expiry.
- Active status and a quiet, persistent restoration message.
- Chinese, English, and Japanese UI; follows Magpie's light/dark theme.

Only `gpt-*` models on the `chat` and `responses` protocols are handled. Provider-prefixed model names are supported. Other requests pass through unchanged. The plugin does not call the Codex quota API.

## Installation

Requires a Magpie version supporting middleware, Bun hooks, and plugin pages, with Bun available to Magpie.

Install the tagged release:

```bash
magpie plugin add "github:jason-lee-x/magpie-codex-tiers#v1.0.0"
```

```bash
magpie plugin on magpie-codex-tiers
```

Restart or reopen the plugin page after upgrading. To upgrade a pinned installation, install the desired new tag explicitly. Magpie installs packages with lifecycle scripts disabled; all plugin assets are included directly in this repository.

GitHub discovery uses the repository's `magpie-plugin` topic. See [Magpie's plugin publishing documentation](https://github.com/yetone/magpie/blob/main/site/public/docs/plugins.html) for the host's installation and discovery rules.

## Usage

Open **Codex Tiers** in Magpie's plugin pages:

1. Choose a global default for models without an explicit rule. The default is **Keep**.
2. Add model-specific `service_tier` rules.
3. Under **When a forecast arrives**, choose Off, Fast, or Ultrafast. Automatic acceleration is off by default.
4. Set **Forecast refresh** to 1–120 minutes; the default is 5 minutes.

The source buttons copy URLs for you to paste into a browser. Magpie's iframe sandbox restricts navigation and clipboard access; if copying fails, the URL remains visible for manual copying.

## Forecasts and quota detection

Forecasts come from the third-party endpoint `https://didcodexreset.com/api/status.json`; they are not guarantees from OpenAI. Automatic mode activates when a valid forecast is received. Local quota changes provide a restoration signal, with the forecast deadline as a fallback.

Forecast refresh and quota detection are independent:

- Forecast refresh controls requests to the forecast endpoint, including during automatic acceleration. Forecasts are still fetched when automatic acceleration is off.
- A successful response remains usable for the selected refresh interval plus 30 minutes of failure grace. Failed requests never extend that validity. The middleware independently enforces both forecast and data-validity deadlines.
- Public forecast data is cached locally in `codex-tiers-status.json` so host restarts preserve refresh timing; this cache contains no local quota readings.
- While automatic mode is enabled, the hook checks Magpie's local `quotas.json` every minute and on incoming requests. Detection depends on when Magpie refreshes that file.
- The page reads plugin state every five seconds.

Quota detection is heuristic: normal quota-window resets can also trigger restoration. Missing or stale account data requires a later observation or the deadline fallback. A qualifying change in any account with an existing baseline can trigger restoration; all accounts do not need to reset together. It cannot prove that a change was a global reset.

## Configuration

Options live in Magpie's `plugins.json`; using the plugin page is recommended. Defaults:

```json
{
  "models": [],
  "defaultTier": "keep",
  "reset": {
    "enabled": false,
    "tier": "ultrafast",
    "refreshMin": 5,
    "phase": "idle"
  }
}
```

A model rule looks like `{ "model": "gpt-5.1-codex", "tier": "priority" }`. Valid tiers are `keep`, `none`, `priority`, and `ultrafast`.

`reset.enabled`, `reset.tier`, and `reset.refreshMin` are user settings; other reset fields are maintained by the hook and should not be edited manually. Magpie replaces the entire options object when saving it, so CLI edits must preserve the full configuration.

The hook rechecks the reset snapshot before writing and atomically replaces the configuration file. Magpie does not expose a shared transaction or compare-and-swap API: simultaneous host and hook writes can still race between the final read and rename. The reproduced asynchronous overwrite bugs are covered by regression tests, but cross-process writes are not fully transactional.

Magpie's built-in group Fast rules run after `onProvider` and can override the plugin's tier. Avoid relying on plugin precedence when combining both mechanisms.

## Privacy and permissions

- Declares `usage:summary` solely for model-search suggestions.
- The Bun hook reads local `plugins.json` and `quotas.json`, and updates its own `options.reset`. Bun hooks have host filesystem and network access; review the source before installing.
- Configuration discovery validates the current plugin's installation against the host working directory, then the standard XDG/home location. This supports portable installs under the current Magpie host behavior; it is not a stable public configuration-path API.
- Account identifiers and quota readings are used locally and are not sent to the forecast service. That service receives ordinary HTTPS requests and connection metadata.
- No prompt, response, API key, or quota upload; no telemetry.
- The repository excludes local configuration, real account data, logs, screenshots, and debugging artifacts.

## Development

ES modules with no third-party runtime dependencies. Regression tests use synthetic data and isolated temporary configuration, never real account settings.

```bash
npm test
```

Inspect the package contents before distribution:

```bash
npm pack --dry-run
```

## License

[MIT](LICENSE). An independent community plugin, not affiliated with OpenAI or the forecast data provider.
