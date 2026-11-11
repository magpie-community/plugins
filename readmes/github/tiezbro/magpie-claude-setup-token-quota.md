# magpie-claude-setup-token-quota

Quota-only Magpie plugin for Claude Pro setup-token accounts

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)](./package.json)
[![Magpie plugin](https://img.shields.io/badge/Magpie-plugin-6E56CF?style=flat-square)](https://github.com/yetone/magpie)
[![Claude setup-token](https://img.shields.io/badge/Claude-setup--token-D97757?style=flat-square)](https://code.claude.com/docs/en/authentication)

[English](./README.md) | [中文](./README.zh-CN.md) | [Releases](https://github.com/tiezbro/magpie-claude-setup-token-quota/releases)

This repository is a **Magpie plugin**. It is not a fork of Magpie and does
not modify Magpie's core. It adds an independent, quota-only provider card for
Claude Pro setup-token accounts.

![Claude Setup Token card in Magpie's Usage page](./docs/usage-card.png)

Magpie's built-in Claude card already serves official Claude model requests.
This plugin does not replace it. It adds a second card that answers one
question: **how much of the setup-token account's 5-hour and 7-day allowance is
left?**

| | Built-in Claude card | This Magpie plugin |
| --- | --- | --- |
| Purpose | Official Claude model requests | Quota display only |
| Data source | Claude Code `/usage` or a `rate_limit_event` | `anthropic-ratelimit-unified-*` response headers |
| setup-token support | Usually unknown, or only a partial 5h reading | 5h and 7d |
| Login | Magpie's saved Claude account | `magpie plugin login claude-setup-token` (paste token) |
| Models | The official Claude models | **0 models** |
| Routing | Serves Claude requests | Never receives model requests |
| Magpie core changes | — | None |
| Can hide the built-in card | — | No; this is a separate card |

<!-- readme:positioning -->
## What this product is

`magpie-claude-setup-token-quota` is a small **Magpie provider plugin** written
for Magpie's plugin host. It does not implement Claude inference and does not
proxy model requests.

It:

- adds a provider named **Claude Setup Token**;
- signs in with a `claude setup-token` token through Magpie's plugin auth;
- calls Claude Code's shape of a minimal Anthropic request only for quota;
- exposes no models, so Magpie never routes agent traffic to it;
- leaves Magpie's built-in Claude account, `logins.json`, and `quotas.json`
  untouched.

It is **not** an official Magpie plugin and **not** an official Anthropic
product. It is a community-maintained plugin that uses Anthropic's
undocumented `anthropic-ratelimit-unified-*` response headers.

> Community maintained. Not official Magpie support and not official Anthropic
> support.

<!-- readme:value -->
## Why this plugin exists

A Claude Pro subscription can be used through a long-lived token made by:

```bash
claude setup-token
```

That token has only the inference scope:

```text
user:inference
```

Anthropic's dedicated usage endpoint therefore rejects it:

```text
GET /api/oauth/usage
403 permission_error: OAuth token does not meet scope requirement user:profile
```

Magpie's built-in Claude card uses Claude Code's own `/usage` (or a
`rate_limit_event`) for its numbers. With a setup-token account that leaves the
card at `unknown`, or at a partial 5h reading, even though a normal model
response contains the full unified limits in its headers:

```text
anthropic-ratelimit-unified-5h-utilization
anthropic-ratelimit-unified-5h-reset
anthropic-ratelimit-unified-5h-status
anthropic-ratelimit-unified-7d-utilization
anthropic-ratelimit-unified-7d-reset
anthropic-ratelimit-unified-7d-status
anthropic-ratelimit-unified-overage-status
```

This plugin reads those headers and turns them into a Magpie quota card.

<!-- readme:architecture -->
## How it works

```text
Magpie
  -> provider plugin claude-setup-token
       auth:   type "api", a setup-token in plugin-auth.json (0600)
       usage:  one minimal Anthropic request
                 model: claude-haiku-5-5
                 max_tokens: 1
                 Authorization: Bearer <setup-token>
                 anthropic-beta: oauth-2025-04-20
               read anthropic-ratelimit-unified-* response headers
               return 5h / 7d windows + status / overage
  -> Magpie Usage page
       one card: Claude Setup Token
```

The probe is cached for 5 minutes. The card is not a model provider: it
registers no models, is not in any routing group, and cannot receive Claude
Code or agent requests. The only request that reaches its setup-token account
is the small quota probe.

The plugin does not:

- use Claude Code OAuth login;
- read or write `~/.claude/.credentials.json`;
- refresh a token;
- write `quotas.json`;
- modify Magpie's built-in Claude card.

<!-- readme:requirements -->
## Requirements

- Magpie with provider-plugin support (tested with Magpie **0.1.2798** on
  Linux)
- A Claude subscription that can run `claude setup-token`
- Network access from the Magpie host to `api.anthropic.com`
- The setup-token itself; no browser login is needed after installation

## Quickstart

### 1. Install the plugin

```bash
magpie plugin add github:tiezbro/magpie-claude-setup-token-quota
```

Or install a local checkout:

```bash
magpie plugin add /path/to/magpie-claude-setup-token-quota
```

### 2. Sign the plugin in with the setup-token

```bash
claude setup-token
magpie plugin login claude-setup-token
# Paste the token printed by claude setup-token
```

The token is stored by Magpie in `plugin-auth.json` with mode `0600`.

### 3. Open the Usage page

```bash
magpie plugin list
magpie quota
magpie accounts
```

Open Magpie's **Usage** page. A separate **Claude Setup Token** card appears
with 5h / 7d remaining, reset times, status, and overage state.

<!-- readme:screenshots -->
## Screenshots

### Usage card

![Usage card showing 5h and 7d allowance](./docs/usage-card.png)

The card is drawn by Magpie like any other subscription card, including the
Claude icon, reset times, pace, cycle, and the plugin's status/overage rows.

### Provider row

![Claude Setup Token provider row with zero models](./docs/provider-row.png)

The provider is signed in but exposes **0 models**, so it cannot receive model
requests or participate in routing.

## Limitations

- It shows the unified 5h and 7d windows only.
- It does not show per-model weekly Opus / Sonnet buckets.
- It does not show extra-usage or credits details.
- It cannot read the account email or plan from the setup-token; this build
  labels the plan `Pro`.
- It cannot replace or hide Magpie's built-in Claude card. The built-in card
  remains the official model path; a core patch would be required to make that
  card show 7d for setup-token accounts.
- Each uncached read costs one tiny Haiku request (about 1 output token).
  The cache is 5 minutes.
- If the token is revoked or rotated, both the built-in account (if used) and
  this plugin's auth need the new token.

## Security

- `plugin-auth.json` is mode `0600`; the token is not part of this repository,
  the npm tarball, or the screenshots.
- The screenshots show only Magpie's masked key label (`API key …xxxx`).
- Do not expose `plugin-auth.json`, `logins.json`, or a setup-token in a public
  repository or chat.
- Rotate the setup-token if it leaks.

## Development

- Runtime: Magpie's Bun plugin host.
- Source: `index.mjs`.
- No build step.
- Icon: embedded Claude SVG in `package.json` (`magpie.icon`).
- The plugin is a normal OpenCode-style provider plugin with Magpie's
  `auth.usage` hook.

## Compatibility

- Tested with Magpie 0.1.2798 / Claude Code 2.1.317 on Linux.
- Magpie updates do not remove a plugin installed from a local path or GitHub.
- If Magpie changes the provider plugin API or the `auth.usage` contract, this
  plugin may need an update.

## License

MIT
