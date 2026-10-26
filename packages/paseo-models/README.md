# Paseo models

Lists magpie's models in [Paseo](https://paseo.sh)'s Claude provider. Paseo reads `~/.paseo/config.json`; this agent writes `agents.providers.claude.additionalModels`, which Paseo merges into the provider's own catalog by id.

```sh
magpie plugin add @magpie-community/agent-paseo-models
magpie paseo-models provider magpie    # on; `default` puts the file back
paseo daemon reload                    # if the Paseo daemon is already running
```

- The list is what magpie offers this agent, so `magpie visible paseo-models <family>` narrows it, and adding or removing a model in magpie rewrites it.
- A model with a 1M context or more is listed as `<id>[1m]`, as Claude Code's `/model` does. Reasoning levels are the ones Claude Code supports: low, medium, high, xhigh, max.
- Nothing else in `config.json` changes: Paseo's `claude` provider keeps its credentials, `models` and settings, and other providers are untouched. Paseo's Codex and Grok providers read their models from magpie's own config, so they need nothing from this.
- Sessions still run on Claude Code with whatever endpoint the `claude` provider uses. To route them through magpie, use `magpie-paseo`, which adds a separate provider.
