# Magpie WorkBuddy Search

[简体中文](README.zh-CN.md)

A search-only provider for Magpie. It calls WorkBuddy AI's search service
directly and returns the actual result snippets as text, together with
structured source titles and URLs. It does not generate a model summary.

## Requirements

- Magpie (tested with 0.1.1285) and `@magpie-community/opencode-workbuddy-auth`
  0.1.24 or later.
- An existing `workbuddy-ai` login in Magpie.
- Node.js 22 or later for running the tests. Magpie runs the plugin under Bun.

## Install from GitHub

If the WorkBuddy auth plugin is not installed yet:

```sh
magpie plugin add @magpie-community/opencode-workbuddy-auth@latest
```

If `workbuddy-ai` is already signed in, keep that login and skip the next
command. Otherwise, sign in using the browser or existing desktop login:

```sh
magpie plugin login workbuddy-ai
```

Install this search provider and link the existing login:

```sh
magpie plugin add github:wanglz111/magpie-workbuddy-search
magpie plugin login workbuddy-search
```

The login method links the existing WorkBuddy AI login without opening a
browser or asking for a key. Select `WorkBuddy Search` in Magpie's Web search
settings to use it for other providers' models. Its virtual model is
`web-search` (`workbuddy-search/web-search`). Selecting it changes the global
search backend; installing the package alone does not select it.

In Magpie's Plugins page, search the GitHub/community discovery list for
`magpie-workbuddy-search`. The repository is tagged `magpie-plugin`, the topic
Magpie uses for discovery. GitHub indexing and Magpie's ten-minute cache can
delay a new entry. The direct GitHub install command works independently of
the discovery list. This is a third-party plugin, not an official reviewed
Magpie provider.

If switching from a local development installation, remove only that local
plugin registration before adding the GitHub version. Both versions expose
the same provider ID and should not be enabled together. Keep the
`workbuddy-ai` auth plugin installed and do not log out of either provider;
Magpie preserves the existing login when a plugin registration is removed.

## Authentication

The provider stores only `linked:workbuddy-ai` as its own login marker.
It reads the current primary `workbuddy-ai` account for each request and
delegates signing and token renewal to the installed WorkBuddy auth plugin.
Refreshed tokens are written back through Magpie's normal auth client.
No access or refresh token is copied into this package or a separate login.

This plugin uses Magpie's local plugin-auth layout and the installed WorkBuddy
plugin's loader API. It targets Magpie, rather than a standalone OpenCode setup.
It uses the primary WorkBuddy AI login; it does not rotate between accounts.
The China-build `workbuddy` login and generic OpenAI-compatible gateways are
not supported as authentication sources.

## Behavior

Provider ID: `workbuddy-search`. Virtual model: `web-search`.
The model is an adapter identity; no language model is called.

Only hosted Anthropic-style `web_search` requests to `/v1/messages` are
accepted. Both JSON and SSE replies are supported. Each request makes one
search and returns up to five results. `max_uses` is an upper bound, not a
request to run more than one search.

Domain allow/block lists filter the results locally. WorkBuddy is asked for
five results, so strict filters may leave no matches. Empty results, quota
refusals, malformed replies and upstream failures are reported as errors.
The provider does not silently fall back to CommandCode.

Search uses the existing WorkBuddy account's service and quota. Token usage
is reported as zero because the adapter does not call a language model;
WorkBuddy search quota use is separate.

## Troubleshooting

- A missing dependency at startup: install the WorkBuddy auth plugin first.
- A missing or expired login: sign in to `workbuddy-ai` again, then retry.
  Do not copy tokens into the search provider.
- WorkBuddy refusal code `15001`: the search service quota is exhausted.
- No results matching the requested domains: the local filter removed all
  five upstream results. Broaden the query or filter.

## Development

Clone this repository and run its tests (no live account is needed):

```sh
npm test
```
