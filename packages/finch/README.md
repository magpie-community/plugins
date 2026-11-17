# agent-finch

![Finch](./icon.svg)

`@magpie-community/agent-finch` adds [Finch](https://finchwork.app/) to Magpie's Agents page. Pick one of Magpie's models in Finch's row and Magpie writes it into Finch's supported external-model integration file, `~/.finch/config/integrations/magpie.json`. Finch watches that file and imports it through its own model-settings transaction, so the model catalog and the default model update without a restart; switching the agent off puts the file back. The Agents row and the plugin listing use Finch's own icon, shipped in this package as `icon.svg`; `agent.icon` and `package.json#magpie.icon` embed the same SVG as a data URI, so both render offline.

The plugin writes that one file and nothing else: it does not touch Finch's internal model storage, its stable-ID registry or its encrypted credentials. The runtime is a single import-free file for Magpie's moejs sandbox, with no dependencies, no `main` and no install hooks.

## Model names

A Magpie model's display name may carry an inner provider suffix, for example `Claude Haiku 5.5 · Claude Code`. Finch shows the base name (`Claude Haiku 5.5`) and keeps the suffix only when two models would otherwise share it (`Claude Opus 5.5 (Claude Code)` vs `Claude Opus 5.5 (Relay)`). `requestModel` and `defaultModel` always keep the exact gateway `provider/model` ID, so routing is unchanged.

## Context windows

Finch requires a known positive integer context window for every model, so `connect()` skips models whose window is unknown. If nothing eligible is left, or the selected model is not in the eligible catalog, it throws a clear error instead of writing a document Finch would reject.

## Known limits

- Distributed from a local path for now, so it stays out of Magpie's automatic update of community packages.
- Finch's MCP format is not among Magpie's `MCPFormats`, so the Library MCP section does not apply to this agent.

## Development

```sh
bun test packages/finch
bun scripts/check.mjs finch
MAGPIE=<magpie> scripts/try.sh finch
```

The tests are synthetic inputs; they are not a real Magpie moejs load or a Finch desktop acceptance run.

## License

MIT.
