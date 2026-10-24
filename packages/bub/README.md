# @magpie-community/agent-bub

(中文说明在下面。)

[Bub](https://bub.build) as a magpie agent. magpie has no setup of its own for
Bub; with this plugin it is on magpie's Agents page like the agents magpie
ships with.

```sh
magpie plugin add @magpie-community/agent-bub
```

Then pick one of magpie's models in Bub's row. magpie writes into
`~/.bub/config.yml`:

```yaml
model: magpie:deepseek/deepseek-flash   # magpie's model, through the provider below
providers:
  magpie:
    type: openai
    api_base: http://127.0.0.1:3425/v1
    api_key: magpie-bub                 # Bub's own key, so Usage names it
```

Your comments, `fallback_models` and your own providers stay. Picking one of
Bub's own models again, `magpie bub default`, or switching it off puts every
key back as it was (a file that had no `providers:` is left with
`providers: {}`, which Bub reads). Restart `bub gateway` and open `bub chat`
sessions after a change: Bub reads its settings when it starts.

## The Bub it needs

Bub 0.5.1 or later: from 0.5.1 Bub takes named providers under `providers:`
([bubbuild/bub#343](https://github.com/bubbuild/bub/pull/343)). 0.5.0 and
older don't. To update:

```sh
uv tool install --reinstall bub    # installed with pip: pip install -U bub
```

An older Bub fails every turn on a `magpie:` model, before any request
goes out: `'magpie' is not a supported provider`. If you see that, update Bub,
or pick one of Bub's own models in the row (or run `magpie bub default`) to put
the file back.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).

---

## 中文

[Bub](https://bub.build) 作为 magpie 的 Agent。magpie 没有内置 Bub 的接入；装上这个插件后，Bub 就和 magpie 自带的 Agent 一样出现在 Agent 页。

```sh
magpie plugin add @magpie-community/agent-bub
```

然后在 Bub 那一行选一个 magpie 的模型。magpie 会改写 `~/.bub/config.yml`：

```yaml
model: magpie:deepseek/deepseek-flash   # magpie 的模型，经下面这个 provider 访问
providers:
  magpie:
    type: openai
    api_base: http://127.0.0.1:3425/v1
    api_key: magpie-bub                 # Bub 自己的 key，用量里能认出它
```

你的注释、`fallback_models` 和自己的 provider 都会保留。再选回 Bub 自己的模型、运行 `magpie bub default`，或者关掉开关，每个键都恢复原样（原来没有 `providers:` 的文件会留下 `providers: {}`，Bub 能正常读）。改完要重启 `bub gateway`，并重新打开 `bub chat` 会话：Bub 在启动时才读设置。

## 需要的 Bub 版本

需要 Bub 0.5.1 或更新版本：从 0.5.1 起，Bub 支持在 `providers:` 下写具名 provider
（[bubbuild/bub#343](https://github.com/bubbuild/bub/pull/343)）。0.5.0 及更早的版本没有。更新：

```sh
uv tool install --reinstall bub    # 用 pip 装的：pip install -U bub
```

更早的 Bub 遇到 `magpie:` 模型，每一轮都会在请求发出之前失败：
`'magpie' is not a supported provider`。看到这个报错，就更新 Bub；或者在这一行选回 Bub 自己的模型（或运行 `magpie bub default`），把文件恢复。

Agent 插件怎么工作：[usemagpie.ai/docs/zh/plugins#agents](https://usemagpie.ai/docs/zh/plugins#agents)。
