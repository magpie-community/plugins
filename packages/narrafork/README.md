# @magpie-community/agent-narrafork

(中文说明在下面。)

[NarraFork](https://github.com/NarraFork/NarraFork) as a magpie agent. magpie
has no setup of its own for NarraFork; with this plugin it is on magpie's Agents
page like the agents magpie ships with.

```sh
magpie plugin add @magpie-community/agent-narrafork
```

Then pick one of magpie's models in NarraFork's row. magpie writes into
`~/.narrafork/settings.json`:

```json
{
  "agent": { "defaultModel": "magpie:group/daily" },
  "customApiProviders": [
    {
      "id": "magpie01",
      "name": "magpie",
      "prefix": "magpie",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "apiKey": "magpie",
      "defaultModel": "group/daily",
      "protocol": "completions-compatible",
      "disabled": false
    }
  ]
}
```

Every narrator NarraFork starts then runs on magpie's gateway, and the
narrators already running keep the model they started on. Your own providers
stay as they are; picking one of them in the row, or switching NarraFork off,
puts `agent.defaultModel` back.

## A routing group keeps its name

Pick a routing group's id (`group/daily`) rather than a model, and the model
NarraFork is on never has to change: magpie decides what serves each request,
so changing which models the group holds in magpie needs nothing here. A
group's members are read by the gateway on every request; NarraFork only reads
the gateway's model list once, when you add it, so only a **new or removed
group** is worth fetching that list again for.

## What the host half writes

NarraFork keeps providers in an array, and magpie's config writer edits object
keys only, so the agent file alone cannot add the `magpie` provider. The
package's `index.mjs` is a Bun host module that keeps that one entry in place:

- it adds or updates the `magpie` entry and changes no other provider, nor
  anything else in the file;
- it copies the file to `settings.json.magpie.bak` once, before its first write;
- it watches `~/.narrafork` the way NarraFork does, so the entry comes back
  after NarraFork rewrites the file, and its `defaultModel` follows the model
  NarraFork is on;
- a `settings.json` that has no `customApiProviders` array yet is left alone:
  NarraFork derives that list from the older per-protocol arrays on its next
  load, and converting it here would drop providers. Open NarraFork's provider
  settings once if the log says so.

`NARRAFORK_HOME` moves the folder, as it does for NarraFork itself. The gateway
address and key are the plugin's options (`magpie plugin options`), default
`http://127.0.0.1:3425/v1` and `magpie`.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).

---

## 中文

[NarraFork](https://github.com/NarraFork/NarraFork) 作为 magpie 的 Agent。magpie 没有内置 NarraFork 的接入；装上这个插件后，NarraFork 就和 magpie 自带的 Agent 一样出现在 Agent 页。

```sh
magpie plugin add @magpie-community/agent-narrafork
```

然后在 NarraFork 那一行选一个 magpie 的模型。magpie 会改写 `~/.narrafork/settings.json`：`agent.defaultModel` 写成 `magpie:<模型>`，宿主模块 `index.mjs` 在 `customApiProviders` 里补上 `magpie` 供应商（指向网关、OpenAI 兼容）。之后 NarraFork 开出的每个叙述者都经 magpie 网关，已经在跑的叙述者保持它启动时的模型；你自己的供应商原样不动，在那一行改选它们、或把插件关掉，`agent.defaultModel` 就回到原样。

**用路由组，名字不变。** 选 `group/daily` 这类路由组而不是具体模型，NarraFork 绑定的模型就永远不用改：每个请求由 magpie 决定落到哪个上游，所以在 magpie 里改组里有哪些模型，这边什么都不用动。网关每次请求都读组的成员；NarraFork 只在添加时读一次网关的模型列表，所以只有**新建或删掉一个组**才值得再「获取模型列表」一次。

**宿主模块写什么。** NarraFork 把供应商放在数组里，而 magpie 的配置写入只改对象键，所以光靠 agent 文件加不了 `magpie` 供应商。包的 `index.mjs` 是 Bun 宿主模块，只维护这一条：

- 添加或更新 `magpie` 条目，其它供应商、文件里别的内容一概不动；
- 第一次写入前把文件备份成 `settings.json.magpie.bak`，只备份一次；
- 像 NarraFork 一样监听 `~/.narrafork`，NarraFork 重写文件后条目会自动补回，`defaultModel` 跟着 NarraFork 当前的模型走；
- `settings.json` 里还没有 `customApiProviders` 数组时它不写：NarraFork 会在下次加载时从旧的按协议数组派生这个列表，在这里自己转换会丢掉供应商。日志这么提示时，打开一次 NarraFork 的供应商设置即可。

`NARRAFORK_HOME` 可以改这个目录，和 NarraFork 本身一致。网关地址和 key 是插件选项（`magpie plugin options`），默认 `http://127.0.0.1:3425/v1` 和 `magpie`。

Agent 插件的工作方式：[usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents)。
