# magpie-kt-agent

A [magpie](https://usemagpie.ai) **agent plugin** for
[KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium) (`kt`).

kt is not one of magpie's built-in agents, so without this plugin its model has
to be maintained by hand in `~/.kohakuterrarium/llm_profiles.yaml`. With it, kt
gets a row on magpie's Agents page: pick a model there — in the app or with
`magpie kt …` — and magpie writes the gateway address, the model and its
reasoning level into kt's own config. Switching magpie out puts every key back
the way it was.

```powershell
magpie plugin add github:FHfanshu/magpie-kt-agent
magpie kt auto/deepseek-v4.1-flash     # or pick it in the app's Agents tab
magpie kt default                      # magpie out again
```

- [Requirements](#requirements)
- [Install](#install)
- [Use](#use)
- [What magpie writes](#what-magpie-writes)
- [How the mapping works](#how-the-mapping-works)
- [Caveats](#caveats)
- [Uninstall](#uninstall)
- [中文说明](#中文说明)

## Requirements

| | |
|---|---|
| magpie | v0.1.3008 or newer (agent plugins) — checked on 0.1.1416 |
| kt | KohakuTerrarium 2.x, on `PATH` as `kt` |
| Gateway | magpie running locally, `http://127.0.0.1:3425` |

kt's CLI goes through magpie's gateway, so the magpie app (or `magpie serve`)
has to be running: without it every kt request is a connection refused.

## Install

From GitHub — magpie fetches the repository with Bun and reads `magpie.agent`
from `package.json`:

```powershell
magpie plugin add github:FHfanshu/magpie-kt-agent
```

A single file, if you keep your own copy (no `package.json` needed):

```powershell
magpie plugin add C:\Users\you\.config\magpie\agents\kt.agent.js
```

The row appears when either `kt` resolves on `PATH` or `~/.kohakuterrarium`
exists. A magpie that is already running keeps the plugin list it loaded: turn
the plugin off and on in **Plugins**, or restart the app.

## Use

```powershell
magpie ls                 # kt among the agents, with its config path
magpie kt                 # what kt is set to
magpie models kt          # every model kt can be given
magpie kt auto/gpt-6.1-sol
magpie kt default         # back to what kt had before this plugin
```

In the app it is one row on **Agents**: click the model, choose one, and the
reasoning slider where the model has levels. `magpie kt default` is the same as
switching the row off.

**kt reads its config when a session starts.** Open a new kt session after a
switch; a running one keeps the model it began with.

## What magpie writes

`~/.kohakuterrarium/llm_profiles.yaml`:

| key | value |
|---|---|
| `default_model` | `magpie/kt` |
| `backends.magpie.backend_type` | `openai` |
| `backends.magpie.base_url` | `gateway.v1`, i.e. `http://127.0.0.1:3425/v1` |
| `backends.magpie.api_key_env` | `MAGPIE_API_KEY` |
| `backends.magpie.provider_name` | `magpie` |
| `presets.magpie.kt.model` | the picked gateway model id, e.g. `auto/deepseek-v4.1-flash` |
| `presets.magpie.kt.max_context` | the model's context window |
| `presets.magpie.kt.max_output` | the model's output limit |
| `presets.magpie.kt.extra_body` | `{reasoning_effort: high}` for a `flash` model, `{reasoning_effort: medium}` for any other, `{}` when it offers neither |

Nothing else in the file is touched: comments, ordering and every other
`presets.magpie.*` entry survive, so `kt run --llm magpie/glm-flash` keeps
working.

## How the mapping works

**Two names, one model.** kt's model reference is `<backend>/<preset>`, split on
the **first** `/` only — so `magpie/kt` is backend `magpie`, preset `kt`. The
preset is deliberately a plain short name, and the gateway model id is only ever
a YAML *value*.

That is what `model: "presets.magpie.kt.model"` and
`connect() → default_model: "magpie/kt"` are for. magpie writes the picked id at
the preset's `model` field; the fixed `default_model` points at that preset.
Naming the preset after the model id instead would break: magpie writes **dotted
key paths**, and model ids carry dots of their own (`gpt-6.1-sol`,
`deepseek-v4.1-flash`), so a path segment taken from an id would split in the
wrong place.

**Reasoning goes in `extra_body`.** kt's OpenAI-shaped backend ignores a
top-level `reasoning_effort`; only `extra_body` is merged into the request body
unchanged and reaches the provider through the gateway. The map is written whole
rather than as `extra_body.reasoning_effort`, so a model that offers neither
level clears the previous one instead of leaving it set, and so switching the
plugin off removes the key with it.

**Effort follows one rule: `flash` → `high`, everything else → `medium`.** The
level is only written when the model lists it; a model with no reasoning levels
gets an empty map rather than a parameter it would reject.

**The request key is kt's own.** kt never takes a literal key from this file,
only the env var a backend names, so `MAGPIE_API_KEY` in
`~/.kohakuterrarium/api_keys.yaml` stays what kt sends. magpie's per-agent
gateway key therefore cannot be written here, and the local gateway accepts any
token — the cost is that `magpie usage` does not attribute kt's requests to `kt`.

## Caveats

- **Defaults move.** kt starts on `magpie/kt` (whatever magpie gave the row), not
  on whatever it used before. `magpie kt default` restores the old
  `default_model`.
- **Switching off leaves `presets.magpie.kt: {}`.** magpie restores every key it
  wrote but does not prune the now-empty outer map. It is inert — the preset has
  no model and `default_model` is back on its old value — delete the two lines
  by hand if they annoy you.
- **Only one preset is managed.** The plugin does not mirror magpie's whole
  catalog into kt; it keeps the single preset the row points at.
- **`magpie kt` prints `magpie/auto/…`, kt stores `magpie/kt`.** magpie renders
  an agent's model as `provider/model`; kt's reference is the preset. Both name
  the same thing.
- Not affiliated with magpie or KohakuTerrarium; just a plugin both accept.

## Uninstall

```powershell
magpie kt default                            # restore kt's config first
magpie plugin rm github:FHfanshu/magpie-kt-agent
```

Check the result with `kt doctor` — it prints `✓ llm resolves (…)` for whatever
`default_model` currently is.

---

## 中文说明

给 [magpie](https://usemagpie.ai) 的 **agent 插件**：把
[KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium)（kt）加进
magpie 的 Agents 页。

kt 不是 magpie 的内置 agent，没有这个插件就只能手工维护
`~/.kohakuterrarium/llm_profiles.yaml`。装上之后，模型在 magpie 里选（界面或
`magpie kt …`），magpie 负责把网关地址、模型和思考档位写进 kt 自己的配置；把
magpie 摘掉时每个 key 都还原成原来的值。

```powershell
magpie plugin add github:FHfanshu/magpie-kt-agent
magpie kt auto/deepseek-v4.1-flash     # 或直接在 App 的 Agents 页点 kt 那一行
magpie kt default                      # 把 magpie 摘掉，恢复原配置
```

**写入的 key**（`~/.kohakuterrarium/llm_profiles.yaml`）：`default_model:
magpie/kt`、`backends.magpie.*`（`openai` / `gateway.v1` / `MAGPIE_API_KEY` /
`magpie`）、`presets.magpie.kt.{model,max_context,max_output,extra_body}`。
其余 `presets.magpie.*` 与注释、顺序都不动。

**为什么预设名是 `kt` 而不是模型 id**：magpie 的写入器按点分路径定位 key，而
网关模型 id 自己带点（`gpt-6.1-sol`、`auto/deepseek-v4.1-flash`），拿 id 当路径段
会被拆错位。所以 `model` 指向 `presets.magpie.kt.model`（值可以是任意 id），
`connect()` 再把 `default_model` 固定写成 `magpie/kt`。kt 的引用是
`<backend>/<preset>`，只按第一个 `/` 切，所以一定能解析到。

**思考档位必须走 `extra_body`**：kt 的 openai 型 backend 不读顶层
`reasoning_effort`，只有 `extra_body` 会原样进请求体。整块 map 写入，换模型时
不会留下上一档的残留。档位规则：**`flash` 模型用 `high`，其余用 `medium`**；模型
本身没列这一档时不写，避免发它不认识的参数。

**注意**：① kt 只在**新会话**读配置；② 摘除后 magpie 会留下惰性的
`presets.magpie.kt: {}`（写入器不剪空 map），删两行即可；③ kt 只认
`api_key_env` 指定的环境变量，magpie 的 per-agent gateway key 写不进来，所以
`magpie usage` 不会把请求记在 `kt` 名下；④ magpie 必须处于运行状态，否则 kt 全部
请求都是 connection refused。
