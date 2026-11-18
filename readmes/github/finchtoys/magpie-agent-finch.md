# agent-finch

![Finch](./icon.svg)

`@magpie-community/agent-finch` adds [Finch](https://finchwork.app/) to Magpie's Agents page. Pick one of Magpie's models in Finch's row and Magpie writes it into Finch's supported external-model integration file, `~/.finch/config/integrations/magpie.json`. Finch watches that file and imports it through its own model-settings transaction, so the model catalog and the default model update without a restart; switching the agent off puts the file back. The Agents row and the plugin listing use Finch's own icon, shipped in this package as `icon.svg`; `agent.icon` and `package.json#magpie.icon` embed the same SVG as a data URI, so both render offline.

The plugin writes that one file and nothing else: it does not touch Finch's internal model storage, its stable-ID registry or its encrypted credentials. The runtime is a single import-free file for Magpie's moejs sandbox, with no dependencies, no `main` and no install hooks.

## How Magpie finds this repository

Magpie lists repositories carrying the `magpie-plugin` GitHub topic under **插件 → 发现 → 非官方插件 · GitHub**, and that path requires `package.json` at the repository root — which is why the package lives here rather than in a `packages/<name>/` folder.

This repository is not published to npm, so Magpie installs it from the repository's current code. Everything the runtime loads is committed: there is no build step and no `dist`, and `finch.agent.js` at the root is the file Magpie loads.

## The file contract

- [`docs/external-model-integration.md`](docs/external-model-integration.md) — the contract itself, for any outside tool that wants Finch to use its models.

## Status

Finch reads `config/integrations/` since **v1.8.1**, released 2026-11-16. A released Finch older than that has no integration file support, so the Agents row would connect to a Finch that ignores it.

## Model names

A Magpie model's display name may carry an inner provider suffix, for example `Claude Haiku 5.5 · Claude Code`. Finch shows the base name (`Claude Haiku 5.5`) and keeps the suffix only when two models would otherwise share it (`Claude Opus 5.5 (Claude Code)` vs `Claude Opus 5.5 (Relay)`). `requestModel` and `defaultModel` always keep the exact gateway `provider/model` ID, so routing is unchanged.

## Context windows

Finch requires a known positive integer context window for every model, so `connect()` skips models whose window is unknown. If nothing eligible is left, or the selected model is not in the eligible catalog, it throws a clear error instead of writing a document Finch would reject.

## Known limits

- Finch's MCP format is not among Magpie's `MCPFormats`, so the Library MCP section does not apply to this agent.
- Not published to npm, so Magpie installs the repository's current code rather than a versioned package.
- The copy in [magpie-community/plugins](https://github.com/magpie-community/plugins) is the community package Magpie publishes and auto-updates from. Changes are made here first, then submitted there.

## Development

The package has no dependency install step; it needs [Bun](https://bun.sh/) for its tests, and TypeScript 5.x on `PATH` for the optional type check:

```sh
bun run test      # descriptor and connect() unit tests
bun run typecheck # strict JS type check of the runtime agent
```

The tests use synthetic inputs. They are not a Magpie moejs load or a Finch desktop acceptance run.

## License

MIT. See [LICENSE](LICENSE).
