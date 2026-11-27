# @magpie-community/tools-council

Several of your [magpie](https://usemagpie.ai) models on one question, as tools magpie offers every agent it connects: ask them all at once, let them vote anonymously, or have another model review your work.

There is nothing to set up. Install it from magpie's **Plugins › Discover**, or with:

```sh
magpie plugin add @magpie-community/tools-council
```

The tools are on magpie's MCP server, `/mcp/magpie/tools`, and in **Library › MCP** as the server `council`: tick the agents that should have it there, or turn on the MCP router, which gives it to every agent at once.

## Tools

| Tool | What it does |
|---|---|
| `council_ask` `{question, context?, web?, files?, models?, count?, effort?, fast?}` | The same question to several models at once, every answer back. |
| `council_vote` `{question, context?, web?, files?, models?, count?, effort?, fast?}` | Each model writes a proposal on its own; the proposals go round without authors, shuffled; each model votes for the best. You get the tally, the winner in full and who wrote what. |
| `council_review` `{content, goal?, files?, models?, count?, effort?, fast?}` | Another model lists the real problems in a diff, code, a plan or a conclusion, with severity, where, why and how to fix. |
| `council_result` `{id}` | The rest of an ask, vote or review still going (see below). |
| `council_models` `{refresh?, lang?}` | A check-up first (ready, not checked yet, slow, and what to fix and how), then every model in magpie: its API, what it can do, whether it has been answering, and which one council picks for each provider. |

`models` takes full ids (`kimi/k3.1-pro`), short names (`sonnet`, `opus`, `argon`: the newest of that kind), providers (`claude`: its strongest model, or quickest with `fast`) or `all`. Add `auto` to have council pick the usual ones as well: `["auto", "sonnet"]` is the usual five plus Sonnet. To let the user choose first, pass `choose: true` (or set the option `confirm`): the reply is then the models that can be used now, ★ on the recommended ones, and the agent asks the user and calls again with `models`. `effort` is `auto`, `low`, `medium`, `high` or `max`. `web: true` runs magpie's own web search first and gives every model the results. `files` are images (paths, URLs or data URLs) for the models that see them.

## How it picks

**In magpie itself.** Make a routing group named `council` on magpie's **Routing** page, with magpie's own model picker: when no models are named, council asks its members, each on its own, at the reasoning level fixed on a member (`claude/claude-sonnet-5-5:high`). Change the group in magpie and council follows. Any other group can be named too (`models: ["my group"]`), and is asked member by member, not routed. magpie keeps its groups in `providers.json` beside the providers' keys: council takes only `groups` from it, and keeps or sends nothing else of the file.

**By itself.** With no `models`, one per provider: its strongest kind of model (by price: Fable before Opus before Sonnet), at its newest version (Opus 5.5 before Opus 5). The providers answering lately go first. Five for `ask`, four for `vote`, and for `review` the strongest model of a provider other than the calling agent's, for an independent look. With fewer than three providers, other kinds of model from the same ones fill up to three. A key paid by the token gets no model over $15 per million input tokens (`maxPrice`); a subscription's strongest model is fine.

## How each model is used

- **Its own API.** Each model is called on the API magpie passes straight through for it (`native_endpoints`: Chat Completions, Messages or Responses), so nothing is lost in translation. One every request to which is translated anyway goes as Messages if it is Claude's, as Chat otherwise.
- **Its reasoning levels.** `effort` becomes each model's nearest level in that API's own field (`reasoning_effort`, `output_config.effort` with adaptive thinking, `reasoning.effort`); `max` is each model's top level (`max`, `xhigh` or `ultra`). A vendor that turns the field away is asked again without it.
- **Its eyes and window.** Images go only to models that see them, in each API's own form. A model whose context window is too small for the input isn't asked.
- **Its own output limit.** No `max_tokens` is sent: magpie gives each model its own.

## How it avoids failures

Nothing is probed. Before asking, council reads what magpie already knows: the accounts' cards (signed out, plan gone, allowance used up) and magpie's recent requests from every agent (a dead key, a server that isn't running, a model that is slow). It also remembers its own calls, in `council-health.json` in magpie's config folder. What fails is left out for a while, as long as it takes to mend by itself:

| Failure | Left out | Applies to |
|---|---|---|
| signed out, key invalid, sign-in retired | 6 hours | the provider |
| the plan doesn't include the model ("requires usage credits") | 6 hours | that kind of model (Fable 5.1 and Fable 5) |
| out of allowance, rate limit | 10 minutes | that kind of model |
| unreachable (a local server not running) | 30 minutes | the provider |
| no answer at all | 15 minutes | the provider |
| model not found | 30 minutes | the model |
| vendor busy (503, overloaded) | 3 minutes, doubling while it lasts, up to an hour | the model |
| refused by a content filter, input too long | nothing: it was the question | — |

Fixed something? `council_models` with `refresh: true` forgets all of it and tries again at once.

While asking:

- A model that fails is replaced by a stand-in, from its own provider first when only that model failed.
- A model far slower than the others gets a stand-in beside it after a while (2.5 times the others' middle time, at least 15 seconds), and whichever answers counts. Once enough answers are in, the rest are let go: a server that only keeps the line open can't hold the answer.
- magpie gives a tool 55 seconds. A strong model thinking hard takes longer, so after about 45 seconds the reply has the answers so far, the models still thinking and an id; the work goes on, and `council_result` gets the rest.

What couldn't be used is one line under the answers, never an error.

## Troubleshooting

`council_models` starts with a check-up: the providers ready, those not checked yet, the slow ones, and for each one that can't be used, why and how to fix it, with the command the vendor's own message names (`grok login`). Every case council knows:

| You see | Why | What to do |
|---|---|---|
| The tools aren't in your agent | The agent isn't given council | Tick the agent for `council` in magpie's **Library › MCP**, or turn on the MCP router; or add `http://127.0.0.1:3425/mcp/magpie/tools` to the agent as an HTTP MCP server |
| No council tools at all in magpie | The plugin, or the built-in Plugin tools, is off | Turn on `council` in **Plugins › Installed** and **Plugin tools** in **Plugins › Built-in** |
| "can't read magpie's models" | magpie isn't running, or is restarting | Open magpie; council already tried twice |
| "magpie has no models yet" | No provider in magpie | Add a subscription, a key or a provider plugin in magpie |
| "No model can be used right now", with a list | Every provider is down | Fix any one in the list; each line says how |
| A provider "signed out or key invalid" | Sign-in expired, key revoked | Sign in again or paste a new key on magpie's Providers page, then `refresh: true` |
| "the vendor has retired this way of signing in" | e.g. Gemini CLI's personal sign-in | Remove that provider in magpie, or use the vendor's new sign-in |
| "not in the plan" | The plan doesn't include that model | Upgrade or add credits; or leave it, it's skipped |
| "unreachable" | A local model's server isn't running, or the network or proxy | Start the app (oMLX, Ollama, LM Studio…), check the proxy |
| "Still thinking … id" | Strong models thinking past 45 seconds | Call `council_result` with the id; it keeps going meanwhile |
| "No such task" | Over an hour old, or magpie restarted its plugins | Ask again |
| "too slow" under the answers | A model far slower than the others | Nothing: a stand-in answered; it is used less until it is quick again |
| "refused by a content filter" | That vendor's filter | Nothing: a stand-in answered; rephrase if every one refuses |
| "too long … for every model" | Larger than every context window | Shorten it, or give only what matters |
| "can't see images" / no model that sees images | No vision model can be used | Add or fix a model that sees images, or ask without them |
| "is a PDF" | Documents aren't sent (some routes drop them) | Put the text in `context` |
| "makes images" | An image model was named | Use magpie's `generate_image` |
| "Web search didn't work" | No search set up in magpie | Pick one in magpie's **Settings › Web search** |
| A provider you never want, broken or not | — | `magpie plugin options council '{"exclude": ["grok", "gemini"]}'`, or remove it from magpie |
| A paid key's top model isn't picked | Over `maxPrice` ($15 per million input) | Name it, or raise `maxPrice` |

## What it reads and sends

It reads `/v1/models`, `/v1/magpie/quotas` and `/v1/magpie/usage/requests` from the magpie it runs in, the routing groups from magpie's `providers.json` (the `groups` list alone), and magpie's language from `settings.json`; nothing else of yours. Your question goes only through your own gateway, to the models it asks. `web: true` uses magpie's web search, as set up in Settings.

## Not covered

PDFs: put their text in `context` (some routes drop documents). Making images or video: use magpie's own `generate_image` and `generate_video`. Video input.

## Options

All optional, with `magpie plugin options council '<json>'`: `confirm` (`true`: every call that names no models shows the menu to choose from first), `exclude` (providers, models or words in a model's id never to use, e.g. `["grok", "gemini", "fable"]`: they are left out of the picks and the check-up), `models` and `count` (the defaults for picking), `effort`, `tier` (`fast` for quick models), `maxPrice` ($ per million input tokens, 15), `wait` (seconds a call waits before handing back an id, 45 at most 50).

---

## 中文

让 magpie 里的多个模型一起回答同一个问题，作为工具提供给 magpie 接入的每个 Agent：

- `council_ask`：同一个问题同时问几个模型，每个模型的回答都带回来；
- `council_vote`：几个模型先各自写方案，去掉作者、打乱顺序后互相投票；
- `council_review`：请另一个模型挑错，默认选和调用者不是同一家的模型；
- `council_models`：体检，写明哪些能用、哪些要修、怎么修。

不需要任何设置。插件每次都从 magpie 读取全部模型（内置供应商、自加的 key、各种供应商插件都算），按每个模型自己的原生接口调用，并用上它的推理档位和看图能力。账号未登录、额度用完或连不上时自动跳过，判断依据是 magpie 已有的账号卡片和请求记录，不额外发请求试探。慢的模型会先派替补同时去答；超过 45 秒还没答完，先返回已有的回答和一个编号，用 `council_result` 取剩下的。

### 遇到问题怎么办

先调用 `council_models`，它开头就是体检结果，每个用不了的供应商都写了原因和修法。常见情况：

| 看到什么 | 怎么办 |
|---|---|
| Agent 里没有 council 的工具 | 在 magpie「资料库 → MCP」里给这个 Agent 勾上 council，或打开 MCP 路由 |
| magpie 里根本没有 council 工具 | 在「插件 → 已安装」打开 council，在「插件 → 内置」打开「插件工具」 |
| 某家「未登录或 key 失效」 | 在 magpie「供应商」页重新登录或换 key，然后调用 `council_models` 并设 `refresh: true` |
| 「厂商已经停用了这种登录方式」 | 在 magpie 里删掉这个供应商，或换成厂商的新登录方式 |
| 「套餐不含这个模型」 | 升级套餐或买额度；不处理也行，会自动跳过 |
| 「连不上」 | 本地模型先打开对应软件（oMLX、Ollama 等），或检查网络和代理 |
| 「还在想……id」 | 用 `council_result` 加这个编号取剩下的，期间它会继续跑 |
| 「没有这个任务」 | 超过一小时或 magpie 重启过插件，重新问一次 |
| 「太慢」「被内容审核拒绝」 | 不用管，已经有替补答了 |
| 「内容太长」 | 缩短，或只给关键部分 |
| 「是 PDF」 | 先把文字提取出来放进 `context` |
| 「联网搜索没成功」 | 在 magpie「设置 → 联网搜索」里选好搜索方式 |
| 某几家根本不想用 | `magpie plugin options council '{"exclude": ["grok", "gemini"]}'`，或者直接在 magpie 里删掉 |
| 想在 magpie 里原生地选模型 | 在 magpie「路由」页建一个叫 `council` 的路由组，用 magpie 自带的选择器把模型加进去；不点名时就问组里的模型，改组就跟着变。别的组也能点名：`models: ["组名"]` |
| 每次想自己先选模型 | 调用时加 `choose: true`，或执行 `magpie plugin options council '{"confirm": true}'` 让每次没点名时都先列清单 |
| 想让某个模型也参加（比如 Sonnet） | `models` 写 `["auto", "sonnet"]`：照常自动挑的几家再加上 Sonnet；只写 `["sonnet", "opus"]` 就只问这两个 |
