<p align="center"><img src="assets/icon.svg" width="88" height="88" alt="Client guard"></p>

# @magpie-community/middleware-guard

**简体中文** · [English](README.en.md)

只给名单里的客户端用的 [magpie](https://usemagpie.ai) 网关中间件。每个请求都会按 magpie 识别出的 agent（客户端）、请求的模型、以及模型名里的供应商/分组，去匹配一组 glob；没通过的直接 403，返回文案会说清是哪个 agent、命中哪条规则、去哪改。通过的请求原样转发。

适合「一个中转站只服务某个客户端」或「某个客户端被禁止使用」的场景：名单外的人在供应商看到请求之前就被挡掉。它不是签名校验，只读 magpie 打在请求上的名字。

装法有两种，区别就在页面：

```sh
magpie plugin add ./packages/guard       # 整个文件夹：中间件 + 配置页面
magpie plugin add ./guard.gateway.js     # 单个文件：只有中间件，没有页面
magpie plugin                            # guard  on  gateway middleware  onRequest, onProvider · onUsage
                                         #              page  Client guard (reads providers:list)
```

文件夹安装时名字是 `guard`，单文件是 `guard.gateway.js`。两种跑的是同一个中间件；只有文件夹带页面，因为页面是中间件旁边的 HTML、CSS 和脚本，单个 `.js` 文件里放不下。

在页面上改名单：**Plugins › guard**，然后侧栏里的 **Client guard**（客户端白名单）；也可以在 **Plugins › Installed › Options** 里手写：

```sh
magpie plugin options guard '{"allow":["claude-code","codex"]}'
```

名字以 `plugins.json` 里的为准：文件夹装是 `guard`，单文件是 `guard.gateway.js`。403 文案里写的是 `guard.gateway.js`（包里的文件名），改的是同一行配置。

页面是选择器；下面那段 JSON 就是页面写出来的东西，也是 `magpie plugin options` 接受的格式。多选就是一个数组。

## 页面

页面上有客户端两份名单、供应商两份名单、两类规则，最上面是各自的条数：

- **允许的客户端 / 拒绝的客户端** — 都是芯片列表：输入名字（或点建议）添加，点 × 删除。建议里会标出 magpie 实际用的名字：`claude-code` 到 magpie 是 `claude`，`cursor` 是 `cursor-local`。
- **允许的供应商 / 拒绝的供应商** — 请求可以去哪些供应商，各带一个 **选择供应商** 和手动输入框。「允许的供应商」非空时，模型必须点名其中之一；没有写供应商前缀的模型也会被拒。
- **按模型区分** — 每条 `byModel` 一张卡：模型 glob、允许的客户端、拒绝的客户端，配 ↑ ↓ × 调整顺序和删除。顺序有意义：第一条 glob 命中的生效，先看它的拒绝名单，再看允许名单。
- **按供应商区分** — 每条 `byProvider` 一张卡：覆盖哪些供应商/分组、允许的客户端、拒绝的客户端。**选择供应商** 打开的是 `providers:list` 读到的 id 菜单：输入即过滤，多时滚动，浮在页面上不把卡片撑长；列表里没有的 id 直接输在下面的输入框。卡片里的允许名单会代替上面的「允许的客户端」；留空则沿用上面那份。
- **保存**（或 ⌘S / Ctrl-S）写入配置；底部的 **当前 options（JSON）** 显示到底会写什么。

页面只申请一项权限 —— `providers:list`（读供应商 id），读不到请求：看不到谁在调用，也看不到 body、prompt 或用量行。进出的只有本插件自己的 options，通过 `magpie.options.get/set`。保存后从下一个请求开始生效。页面不认识的键（它不管的配置）会原样保留。在 magpie 之外当文件打开时，它会显示 `package.json` 里的示例，只读，并标明自己是预览。

单文件安装没有页面。名单长到需要页面时，改装整个文件夹；两种装法 options 一样。

## 选项

```json
{ "allow": ["claude-code", "codex"],
  "block": ["cursor", "other"],
  "providerAllow": ["relay-a", "relay-b"],
  "providerBlock": ["relay-c"],
  "byModel": [{ "match": ["claude-*", "gpt-5*"], "allow": ["claude-code", "codex"], "block": ["cursor"] }],
  "byProvider": [{ "match": ["relay-a"], "allow": ["claude-code"], "block": ["other"] }],
  "maxLog": 6 }
```

- **`block`。** 要拒绝的客户端。最先判断，优先于一切。
- **`providerAllow` / `providerBlock`。** 供应商 id、分组 id 或 glob，按模型名匹配（`relay-a/claude-sonnet-4-5` 里的 `relay-a`）。`providerBlock` 命中的供应商直接拒；`providerAllow` 非空时，模型点名的供应商不在名单里就拒，模型没写供应商前缀也拒。留空不起作用。这是按「请求要去哪」过滤，与客户端无关。
- **`byModel`。** 每条有 `match`（一个 glob 或一组）、`allow`、`block`。第一条 `match` 命中的生效：先按 `block` 拒，再由 `allow` 决定其余。`allow` 留空表示不限；`block` 留空表示不拦。模型规则比供应商规则更具体，两者都命中时先看模型规则。
- **`byProvider`。** 每条有 `match`（供应商 id、分组 id 或 glob）、`allow`、`block`。第一条 `match` 命中模型的供应商/分组名时生效：先按 `block` 拒；`allow` 非空时代替顶层那份允许名单，留空则沿用顶层 —— 想让该供应商不限，写 `["*"]`。这里的名字是客户端请求里写的，不是路由最终落到的 provider。`group/<id>` 可以写分组 id（`translate`）、`group`（所有分组）或整串 `group/<id>`；写 `zifeiyu` 只覆盖直连 `zifeiyu/…` 的请求，因为分组里有哪些供应商在这里看不到。没有 `/` 的模型不匹配任何供应商规则。
- **`allow`。** 没有命中 `byModel`、也没有命中 `byProvider` 的请求用它。留空表示不限。
- **`maxLog`。** 用量摘要最多打印几行，1 到 40，默认 6。页面上没有这个控件，用 `magpie plugin options` 设。

判定顺序：`block` → `providerBlock` → `providerAllow` → 模型规则的 `block` → 供应商规则的 `block` → 模型规则的 `allow` → 供应商规则的 `allow` → 顶层 `allow`。**没有「默认拒绝」**：只有名单里明确写了东西才会拦，空名单永远不拦。字段类型写错就当没配（`allow` 写成字符串不会把所有人都挡掉），magpie 日志里会有一行说明；options 不是 JSON 对象也什么都不拦。

## agent 的名字

`ctx.agent` 是 magpie 给请求推断的名字，主要看 User-Agent。在 0.1.1433 上实测：

| 客户端发送的 | `ctx.agent` |
|---|---|
| `claude-cli/1.0.0 (external, cli)`、`claude-code/2.0.1` | `claude` |
| `codex_cli_rs/0.50.0`、`codex/1.2` | `codex` |
| `cursor/0.48.0` | `cursor-local` |
| `Cline/3.1.0` | `cline` |
| `opencode/0.3.1` | `opencode` |
| `Go-http-client/1.1` | `Go-http-client` |
| `Mozilla/5.0` | `Mozilla` |
| 完全没有 User-Agent | `other` |

所以按人话写的 `claude-code`、`codex` 直接匹配不到 `claude`。规则和 agent 都会转小写，并先做常见写法归一：`claude-code`、`claude-cli`、`claude-desktop` → `claude`；`codex-cli`、`codex_cli_rs` → `codex`；`cursor-local` → `cursor`。`*` 是通配符，匹配整个名字，所以 `cursor*` 能盖住 `cursor-local`，`other` 盖住没有 User-Agent 的请求。

模型按客户端请求的原名和最后一个 `/` 后的部分各匹配一次，所以 `claude-*` 既命中 `relay/claude-sonnet-4-5`，也命中 `claude-sonnet-4-5`。

## 被拒的请求会收到什么

`ctx.reject(403, …)`，按客户端自己的协议成形 —— Anthropic 请求收到 Anthropic 错误体，Chat 请求收到 Chat 错误。文案是一句话，例如：

```
magpie's guard turned this request away: agent "Mozilla" is not on the allow list of
byModel[0] (match "claude-*", "gpt-5*") for model "relay/claude-sonnet-4-5"
— change the lists in Plugins › guard.gateway.js › Options.
```

## 记录了什么

被 guard 拒掉的请求不会进 magpie 的请求列表，所以这里自己计数，并往 magpie 日志打一行 —— 每个客户端 15 秒最多一行，第一次被拒的客户端会立刻出现：

```
guard: turned away cursor-local for model relay-a/claude-sonnet-4-5 — provider "relay-a" block "cursor"
```

某个客户端第一次在某个供应商上出现，也会打一行，所以日志能看出谁来了：

```
guard: first request from claude on relay-a
```

配了 `byProvider` 规则、但模型的供应商/分组名一个都没命中时（通常是分组），会按名字打一次说明，免得规则看起来像坏了：

```
guard: no byProvider rule matches "translate" — the model is named group/translate,
and those rules read that name, not the provider it routes to
```

`onUsage` 能看到每个结束的请求 —— agent、provider、状态、`rejected` —— 并按 agent × provider 累计调用数、最后一次时间和状态，每分钟或每 25 行打印一次摘要，最多 `maxLog` 行：

```
guard: 12 requests seen here, 3 turned away here
  claude → relay: 9, last 200 at 02:37:03
  codex → relay: 3, last 200 at 02:36:51
```

不会读也不会打印 body、prompt、工具参数或错误文本；一行里只有上面这些模型和供应商名字。

**计数是分片的，不是总量。** moejs 只编译一次这个中间件，但每个请求一个运行时，magpie 又保留多个，所以每个运行时的计数都从零开始，摘要只覆盖那个运行时看到的。用它看「谁在过、打到哪」；每次调用和失败看 magpie 的 **Plugins** 页，完整记录看请求列表。两者不能互相替代。

## 做不到什么

- **在页面里显示请求的客户端。** 页面只能读 `usage:summary` 和 `providers:list`，两者都不带请求的 agent，页面容器也没有网络去问。客户端只能在 magpie 的 Requests 页和日志的 `guard:` 行里看。
- **按「路由最终落到的供应商」精确拦截。** `onRequest` 在路由前跑，不知道请求会落到哪个 provider 或分组；`onProvider` 在路由后跑，那时 `ctx.reject` 已经拦不住。`byProvider` 匹配的是模型里写的名字 —— 客户端请求的路由名。分组有它自己的名字（`group/…`），可能通向多个供应商，也可能再套一层分组；裸模型没有名字。分组成员在路由前看不到，所以 `zifeiyu`（或内层 `tral`）的规则只覆盖 `zifeiyu/…`，盖不到请求外层分组的客户端 —— 要么写外层分组的 id，要么在顶层把客户端整体拦掉。
- **被拒时出现在请求列表里。** 记录在中间件之后写，guard 挡掉的请求根本到不了那里。
- **看到 Test / Detect 协议按钮的请求。** 那个检查发 `content: "hi"`、`User-Agent: Go-http-client/1.1`，不走 `serveAgent`，任何中间件都看不到。要管它，得用 provider 插件（Bun，自己带 `fetch`）包住中转，决定发不发、带什么 User-Agent。

## 限制

一个 hook 有 250 ms。它抛错或返回不对，请求就按原样发出去：这是 fail open，绝不 fail closed。App 里改 options 从下一个请求生效；`magpie serve` 只在启动时读 options，所以要重启，或者在 App 里把插件关掉再打开。

## 自测

装文件夹，打开 **Plugins › guard**，再点 **Client guard**，页面应该显示包里示例的名单。把 `claude-code`、`codex` 加进 **允许的客户端**，`cursor`、`other` 加进 **拒绝的客户端**，在 **按模型区分** 里加一条 `claude-*`、`gpt-5*`，允许那两个客户端；想给某个中转站单独策略，就在 **按供应商区分** 里给它加一张卡。按 **保存**：`已保存` 会替掉 `有未保存的修改`，底部的 **当前 options（JSON）** 就是写进去的内容。

然后在中转站运行时，按 User-Agent 发三个请求：

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3425/v1/messages \
  -H 'content-type: application/json' -H 'User-Agent: claude-code/2.0.1' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
# 200，或中转站自己的错误 —— 不是 403

curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3425/v1/messages \
  -H 'content-type: application/json' -H 'User-Agent: codex_cli_rs/0.50.0' \
  -d '{"model":"gpt-5-codex","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
# 200，或中转站自己的错误 —— 不是 403

curl -sS http://127.0.0.1:3425/v1/messages \
  -H 'content-type: application/json' -H 'User-Agent: Mozilla/5.0' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
# 403，文案里会点名 Mozilla 和命中的规则
```

之后 **Plugins › Installed** 里会显示这行的钩子（`onRequest, onProvider · onUsage`），请求跑过之后还有调用数、平均耗时和失败数。`onProvider` 在这里是空操作：那时路由已定，拦不住，而且这个插件从不改 body。
