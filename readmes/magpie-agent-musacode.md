# magpie-agent-musacode

A [magpie](https://usemagpie.ai/) **agent plugin** for **MUSACode** (摩尔线程 MUSACode): pick MUSACode's model in magpie's Agents page, the same way magpie manages Claude Code, Codex, OpenCode and other agents.

MUSACode reads the OpenCode config shape, so this plugin writes a `provider.magpie` block into `~/.config/musacode/musacode.jsonc` and points its `model` at `magpie/<provider>/<model>`. On disconnect, every key magpie wrote is restored.

## Requirements

- MUSACode installed, with its config at `~/.config/musacode/musacode.jsonc`
- magpie 0.1.3098 or newer (agent plugins)
- At least one provider/model configured in magpie

## Install

From npm:

```sh
magpie plugin add magpie-agent-musacode
```

From this repository:

```sh
git clone https://github.com/muzixiaoyao/magpie-agent-musacode.git
magpie plugin add ./magpie-agent-musacode
```

`magpie ls` then shows a `MUSACode` row.

## Use

Pick a model in magpie → **Agents** → **MUSACode**, or from the terminal:

```sh
magpie musacode qoder-cn/gfmodel
```

MUSACode reads its settings at startup, so **restart MUSACode** after changing the model. New sessions then send requests through magpie's gateway (`http://127.0.0.1:3425/v1`).

To disconnect and put back exactly what MUSACode had before:

```sh
magpie musacode default
```

## What it writes

`~/.config/musacode/musacode.jsonc`:

```jsonc
{
  "model": "magpie/<provider>/<model>",
  "provider": {
    "magpie": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "magpie",
      "options": {
        "baseURL": "http://127.0.0.1:3425/v1",
        "apiKey": "<magpie per-agent key>"
      },
      "models": {
        "<provider>/<model>": {
          "name": "...",
          "limit": { "context": 1000000, "output": 0 },
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "variants": { "high": { "reasoningEffort": "high" } }
        }
      }
    }
  }
}
```

Existing providers in the file (for example `agnes1`) are left untouched. Comments and the rest of the file are preserved.

## Notes

- Only `~/.config/musacode/musacode.jsonc` is written. If MUSACode is started with `MUSACODE_CONFIG_DIR` or a project-level `.musacode/`, this plugin does not follow it.
- The plugin id is `musacode`; it does not override any built-in magpie agent.
- `reasoning: true` is set only when a model has all of `low`, `medium` and `high`, so OpenCode 1 does not invent reasoning levels the model does not offer.
- magpie's per-token pricing is converted to OpenCode's USD-per-million-token `cost`.
- Tested with magpie 0.1.3098 and MUSACode 1.1.0 (OpenCode 1.18.31 core) on Windows.

## 简介

把 MUSACode 作为 magpie 的普通 Agent 纳管：在 magpie 里选模型，插件负责写 `provider.magpie` 和 `model`，断开时完整回滚。插件不做登录；请求走 magpie 的本地网关和 per-agent key。

## License

MIT
