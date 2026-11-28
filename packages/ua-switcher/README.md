# UA Switcher

Switch the **User-Agent (and companion identity headers) that [magpie](https://github.com/yetone/magpie) sends upstream**: present yourself as Codex CLI, Claude Code, pi, ZCode, opencode, Antigravity, or your own custom client — one click on a local web page, effective immediately, no magpie restart.

This is the community-plugins port of [magpie-ua-switcher](https://github.com/x1051445024/magpie-ua-switcher) (v1.9.3, MIT), maintained upstream by its author. The full manual, including every config field and the version-resolution rules, lives in the [upstream README](https://github.com/x1051445024/magpie-ua-switcher#readme).

```sh
magpie plugin add @magpie-community/middleware-ua-switcher
```

## What it is made of

- **A plugin page** (Plugins › UA Switcher, zh: 身份伪装) served by the plugin's own local service — `http://127.0.0.1:3426` standalone, or the port set in the plugin's `port` option for managed installs. Clicking a profile card switches; everything else is edited inline and saved hot into the same config file.
- **A plugin host part** (`index.mjs`) that does the switching, in two ways because magpie has two upstream paths:
  1. **Native providers** (API-key entries in `providers.json`, fetched by magpie's Go side): on every switch the plugin writes the resolved headers into each provider's `headers` field in `providers.json`, and tells the running host to drop its cache through the host's own invalidation event — no sign-in is touched and magpie is not restarted. Switching to `off` restores the values it overwrote; later manual edits are preserved. While the effective profile is `claude-code` (or pi's anthropic form), it also writes Claude Code's `metadata.user_id` into each Messages-wire provider's `extraBody`, and can optionally forward Anthropic requests through its loopback listener to add a Claude Code billing block (off by default, `claudeBilling`).
  2. **Plugin-host providers** (declared by other plugins): rewritten per request through the OpenCode `chat.headers` hook, which wins over every other header source.
- **A gateway middleware** (`schema.middleware.mjs`, declared as `magpie.middleware`, runs in magpie's own moejs process): on Anthropic-protocol requests it cleans the **top level** of every tool's `input_schema` — merges top-level `oneOf` / `allOf` / `anyOf` into `properties`, adds a missing top-level `type: "object"`, and drops `required` names that have no property — because Anthropic's Messages API rejects those shapes while some upstreams tolerate them. Nested unions are legal and stay untouched. Set the plugin's options to `{"diagnose": true}` to have the schemas Anthropic would reject named in magpie's log (read-only), or `{"disable": true}` to turn the cleanup off.

## Side effects, plainly

- It **writes to magpie's `providers.json`** (headers, and `extraBody.metadata` as described above) and keeps its own small config/state files beside it. It never modifies sign-ins.
- It **opens a local web listener** (default port 3426, configurable through the plugin's `port` option) that serves the switcher page on loopback.
- Version strings for codex / claude-code profiles can refresh from npm in the background (configurable; pinned or built-in values win) — see the upstream README for the exact rules.

## Tests

```sh
bun test packages/ua-switcher        # middleware cases + a host load test
bun scripts/check.mjs ua-switcher    # registry + package shape
```

The upstream repository carries the full self-test suite for the switching machinery.
