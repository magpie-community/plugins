<div align="center">

# magpie-agentcompass-router

**Pick the model and effort of each Magpie request by what its task needs and what your subscriptions have left.**

[English](#english) · [简体中文](#简体中文) · [Reference](docs/reference.md) · [Release notes](docs/RELEASE_NOTES.md) · [AgentCompass](https://github.com/akiiwa-games/AgentCompass)

</div>

---

## English

### What it is

A [Magpie](https://github.com/yetone/magpie) gateway plugin that runs the routing engine of [AgentCompass](https://github.com/akiiwa-games/AgentCompass) v0.6.0. For a request it chooses `<model>:<effort>` from the models you list, scoring each model at each effort on four capability categories (`divergence`, `coding`, `aesthetics`, `tool_operation`), its time and price, and what the account's quota windows have left. It also orders the seats of a Magpie account pool by quota headroom.

Magpie's own rules see a model name and pool state, not the task. This plugin reads a structured **task profile**, so a routine edit does not spend a flagship's weekly quota and a hard design task is not handed to a light model. How the engine scores is AgentCompass's, written once in its [technical reference](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/docs/technical-reference.md#1-how-scoring--allocation-work); this plugin does not repeat it.

### Rules and controls

- **It routes on a profile, never on the words of a task.** The profile comes from the caller (`body.profile`) or from a classifier, a small model you configure. **With neither, a request is not routed**: it goes on with the model the client named, and the reply and Magpie's log say so.
- **Two modes.** Mode A is gateway middleware, on by default: synchronous, no network, so it routes a request that carries its own `body.profile`. Mode B is a decision provider for Magpie's Routing Groups, opt-in: it can call your classifier.
- **You choose the candidates.** Routing picks only from `candidateModels`. Naming a model (a pin) is honored or refused with a code; no other model is substituted.
- **Quota needs a plan.** An account whose `plan` is not reported has unknown capacity and is left out of automatic routing until it is.
- **Sessions are held.** A tool loop, or a warm prompt cache, keeps the model it started on, so caches and reasoning signatures are not thrown away (`affinityMode`).

### Quickstart

Install (any of the three sources):

```sh
magpie plugin add @magpie-community/gateway-agentcompass
# or: magpie plugin add github:akiiwa-games/magpie-agentcompass-router
# or: magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin list
```

**Mode A.** (`<spec>` is the plugin's name in `magpie plugin list`.) List the models, then send requests to the model `agentcompass` (or `agentcompass/auto`, or set `routeAllModels: true`) with a `profile` in the body:

```sh
magpie plugin options <spec> '{"candidateModels":["claude-opus-5-5","claude-sonnet-5-5","gpt-6.1-sol","gemini-3.8-flash-high"]}'
```

The middleware rewrites `body.model` to `<model>:<effort>` and sets the protocol's effort field. Without `candidateModels` or `defaultModel`, a request to a virtual model is refused with HTTP 400. A valid profile and the quota snapshot (`quotas`, with each account's `plan`) are in the [reference](docs/reference.md#task-profile).

**Mode B.** Let Magpie's Routing Groups use the plugin as their classifier, with a classifier model of your own (without one it answers `none of these` every turn):

```sh
magpie plugin options <spec> '{"enableDecisionProvider": true, "allowExternalScorer": true, "scorer": {"kind": "openai_compatible", "baseUrl": "http://127.0.0.1:4096/v1", "apiKey": "<key>", "model": "gemini-3.8-flash-high"}}'
magpie plugin login agentcompass
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

**Seats.** Select the plugin's pool strategy on an account pool (`agentcompass` or `agentcompass-pure`; the name depends on the install source: [names](docs/reference.md#names-by-install-source)).

### When there is no profile

| Entry | What the request does |
|---|---|
| Middleware (Mode A) | Goes on with `body.model` as sent, no effort added. A virtual name becomes `defaultModel` if you set one; otherwise Magpie has no such model and the client gets Magpie's error |
| `/v1/systemone` (Mode B) | Answers `none of these`, so the group's fallback rule applies |

The plugin raises no error of its own and records no session. If you come from a version before 0.1.6, which guessed a profile from the text, set `defaultModel`, or configure Mode B with a scorer, or have your client send `body.profile`. Limits that follow from Mode A having no network or file system are in the reference's [limits](docs/reference.md#limits-inside-magpie).

### Where it fits

- **[AgentCompass](https://github.com/akiiwa-games/AgentCompass)** dispatches sub-agent tasks from a coding session (`agentcompass roll`) and supports Claude Code, Codex CLI, Paseo and other hosts. This plugin is the same engine at Magpie's gateway, one request at a time.
- **[Magpie](https://github.com/yetone/magpie)** is the local gateway and multi-subscription proxy it runs in.
- **[cindy-agentcompass-plugin](https://github.com/akiiwa-games/cindy-agentcompass-plugin)** is the plugin for the Cindy host.

Options, names by install source, limits, the repository layout and the tests: [`docs/reference.md`](docs/reference.md).

---

## 简体中文

### 它是什么

运行 [AgentCompass](https://github.com/akiiwa-games/AgentCompass) v0.6.0 路由引擎的 [Magpie](https://github.com/yetone/magpie) 网关插件。对每个请求，它从你列出的模型里选出 `<model>:<effort>`：对每个模型的每个档位，按四类能力（`divergence`、`coding`、`aesthetics`、`tool_operation`）、耗时与价格、以及账号配额窗口的剩余量打分。它也按配额余量给 Magpie 账号池的席位排序。

Magpie 自带的规则只看到模型名和号池状态，看不到任务。本插件读取结构化的**任务画像**：日常小改动不会消耗旗舰的周额度，高难度设计任务也不会交给轻量模型。引擎如何打分由 AgentCompass 负责，只在它的[技术参考](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/docs/technical-reference.md#1-how-scoring--allocation-work)里写一次，本插件不重复。

### 规则与控制

- **只依据画像路由，绝不根据任务文字。** 画像来自调用方（`body.profile`）或分类模型（你自己配置的小模型）。**两者都没有时请求不会被路由**：按客户端指定的模型原样转发，响应和 Magpie 日志会写明。
- **两种模式。** 模式 A 是网关中间件，默认开启：同步运行、没有网络，所以只路由自带 `body.profile` 的请求。模式 B 是供 Magpie 路由组使用的决策 Provider，按需开启：它可以调用你的分类模型。
- **候选由你决定。** 路由只在 `candidateModels` 中选择。点名模型（pin）要么照办，要么带错误码拒绝，不会换成别的模型。
- **配额需要 plan。** 没有上报 `plan` 的账号容量未知，在上报之前不进入自动路由。
- **会话会被保持。** 工具循环或提示缓存温热时沿用会话起初的模型，不白白丢掉缓存和推理签名（`affinityMode`）。

### 快速开始

安装（三种来源任选其一）：

```sh
magpie plugin add @magpie-community/gateway-agentcompass
# 或：magpie plugin add github:akiiwa-games/magpie-agentcompass-router
# 或：magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin list
```

**模式 A。**（`<spec>` 是 `magpie plugin list` 里显示的插件名。）列出模型，然后向模型 `agentcompass`（或 `agentcompass/auto`，或设置 `routeAllModels: true`）发请求，请求体带 `profile`：

```sh
magpie plugin options <spec> '{"candidateModels":["claude-opus-5-5","claude-sonnet-5-5","gpt-6.1-sol","gemini-3.8-flash-high"]}'
```

中间件把 `body.model` 改写为 `<model>:<effort>`，并写入协议对应的档位字段。没有 `candidateModels` 也没有 `defaultModel` 时，请求虚拟模型会返回 HTTP 400。合法的画像和配额快照（`quotas`，每个账号写明 `plan`）见[参考](docs/reference.md#task-profile)。

**模式 B。** 让 Magpie 路由组把本插件用作分类器，并配置你自己的分类模型（没有则每一轮都回答 `none of these`）：

```sh
magpie plugin options <spec> '{"enableDecisionProvider": true, "allowExternalScorer": true, "scorer": {"kind": "openai_compatible", "baseUrl": "http://127.0.0.1:4096/v1", "apiKey": "<key>", "model": "gemini-3.8-flash-high"}}'
magpie plugin login agentcompass
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

**席位。** 在账号池上选用本插件的号池策略（`agentcompass` 或 `agentcompass-pure`；名称取决于安装来源：[名称](docs/reference.md#names-by-install-source)）。

### 没有画像时

| 入口 | 请求的处理 |
|---|---|
| 中间件（模式 A） | `body.model` 原样转发，不附加档位。虚拟模型名在设置了 `defaultModel` 时改用它；否则 Magpie 没有这个模型，客户端收到 Magpie 的错误 |
| `/v1/systemone`（模式 B） | 回答 `none of these`，由路由组的兜底规则处理 |

插件自己不报错，也不记录会话。如果你用过 0.1.6 之前、会从文字猜画像的版本：设置 `defaultModel`，或配置带分类模型的模式 B，或让客户端发送 `body.profile`。模式 A 没有网络和文件系统带来的限制见参考中的[限制](docs/reference.md#limits-inside-magpie)。

### 在生态中的位置

- **[AgentCompass](https://github.com/akiiwa-games/AgentCompass)** 在编码会话里派发子 Agent 任务（`agentcompass roll`），支持 Claude Code、Codex CLI、Paseo 等宿主。本插件是同一套引擎在 Magpie 网关上的版本，一次处理一个请求。
- **[Magpie](https://github.com/yetone/magpie)** 是它运行其中的本地网关与多订阅代理。
- **[cindy-agentcompass-plugin](https://github.com/akiiwa-games/cindy-agentcompass-plugin)** 是 Cindy 宿主的插件。

选项、各安装来源下的名称、限制、仓库结构与测试：[`docs/reference.md`](docs/reference.md)（英文）。

## License

MIT
