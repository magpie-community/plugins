# @magpie-community/agent-pine

[Pine](https://github.com/pmndrs/pine) as a magpie agent. Pine runs on pi's SDK, so it keeps its
model servers in pi's file, `~/.pine/models.json`, and the model a new conversation starts on in
`~/.pine/pine.json` as `defaults.model`. The plugin puts magpie's gateway there as the provider
`magpie`, with magpie's whole catalog, and writes the model picked on magpie's Agents page into
`pine.json`.

```sh
magpie plugin add @magpie-community/agent-pine
```

Then pick one of magpie's models in **Pine**'s row (or `magpie pine model magpie/<provider>/<model>`)
and start a conversation: a new one starts on that model. `/model` in Pine still lists every
magpie model and switches among them; a magpie model saved there keeps the row on magpie, and
another provider's is yours and stays.

Switching Pine off, or `magpie pine default`, puts `defaults.model` back as it was (or takes it out
where there was none) and takes the `magpie` provider out of `models.json`.

This needs a magpie with the Agent contract's `startup` field (v0.1.3008 or later); an older one
reads this package as connect-only, and the model is picked with `/model` in Pine.

Pine is a project by pmndrs. This is an unofficial integration, not affiliated with or endorsed by
pmndrs; PiG and Pi users are served by their own packages.

## What it owns

Two places, each stashed before magpie's first write and put back on disconnect:

| File | Key |
| --- | --- |
| `~/.pine/models.json` | the provider object `providers.magpie` |
| `~/.pine/pine.json` | `defaults.model` |

| `providers.magpie` field | Value |
| --- | --- |
| `name` | `Magpie` |
| `baseUrl` | the gateway's `/v1` address |
| `api` | `openai-responses` |
| `apiKey` | the key magpie keeps for Pine (`magpie-pine` on loopback) |
| `compat` | `supportsStrictMode: true` |
| `models` | magpie's catalog, each as a `models.json` entry |

Every other provider in `models.json` and every other key in `pine.json` stays as it is, including
edits made while connected. The provider is written as one whole object, so stepping out removes
it rather than leaving an empty provider Pine can't read; a `models.json` magpie makes from nothing
keeps an empty `providers` map, which Pine still needs filled with its own or another server.

### Model ids

Pine reads a model reference at the first `/`, so the id is prefixed once: the model written into
`pine.json` is `magpie/deepseek/deepseek-chat` — provider `magpie`, holding magpie's model
`deepseek/deepseek-chat`, which goes to the gateway as it is and is routed there.

Each entry keeps magpie's id (slashes and all), name, image input, the context window and output
limit where magpie knows them, and the model's thinking levels: a model with `efforts` is marked as
thinking, with `thinkingLevelMap` naming each of pi's levels and hiding the ones it doesn't take
(`off` is sent as `none` where the model has it). Limits magpie doesn't know are left out rather
than written as `0`, so pi applies its own defaults. Requests go on the Responses API, which magpie
relays where the provider speaks it and translates for the rest.

## Things to know

- **Agents with a model of their own.** `~/.pine/agents/<id>/agent.json` overrides `defaults.model`,
  so an agent that names a model there doesn't follow magpie's row. Clear it (or set it to one of
  magpie's models) for that agent.
- **Restart Pine** after changing the model in magpie: Pine's daemon reads `models.json` and
  `pine.json` when it starts.
- **Default folder only.** The package targets `~/.pine`; Pine's `$PINE_HOME` and `--home` are not
  followed. For another folder, copy `pine.agent.js`, change `config`, `startup.config`, `dir` and
  `library.skills`, and install that file (`magpie plugin add /abs/path/pine.agent.js`).
- **Thinking** stays Pine's: `defaults.thinking`, `thinking` in `agent.json`, or `/reasoning`.
  Magpie's Effort field is not shown for this agent.
- **Library** gets Pine's home `skills/` folder, so skills ticked for Pine land there and every
  Pine agent sees them. Instructions and MCP servers are not wired: Pine keeps instructions per
  agent under `agents/<id>/`, and its MCP entries are its own shape.
- **No sign-in**: requests carry the key magpie keeps for Pine, so usage is counted under `pine`.
  The package reads no credentials, runs nothing, and sets nothing else.
- **Disconnect before uninstalling**; removing the plugin does not run Pine's disconnect.

## 中文

Pine 跑在 pi 的 SDK 上：provider 在 `~/.pine/models.json`，新对话的起始模型在 `~/.pine/pine.json`
的 `defaults.model`。装上后经 magpie 的网关用它，在 Agents 页 **Pine** 一行选 magpie 的模型即可，
`/model` 仍可在 Pine 里切换。

magpie 只写两处：`providers.magpie`（网关地址、`magpie-pine` 钥匙、模型目录）和
`defaults.model`；断开时各自还原，其余 provider 和键不动。模型写成 `magpie/<provider>/<model>`：
Pine 只在第一个 `/` 处切分，provider 是 `magpie`，模型 id 就是 magpie 原来的
`<provider>/<model>`，原样送到网关。

注意：`agents/<id>/agent.json` 里自己写的 `model` 优先，那个 agent 不跟着 magpie 走；换完模型要
重启 Pine；只认默认的 `~/.pine`（用 `$PINE_HOME` 请复制描述文件改路径）；思考等级由 Pine 自己管；
`~/.pine/skills` 已接进 Library，指令与 MCP 未接；先断开再卸载。需要 magpie v0.1.3008 及以后，
更早的版本当作 connect-only。非官方适配，与 pmndrs 无关。
