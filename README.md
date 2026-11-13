# magpie-community plugins

[OpenCode](https://opencode.ai) provider plugins for coding-plan
subscriptions and decision APIs, and [gateway middleware](#gateway-middleware),
[gateway hooks](#gateway-hooks), [routing strategies](#routing-strategies), [tools for every
agent](#tools-for-every-agent), [pages](#pages) and [agents](#agents) for
magpie, maintained by the community. To make one, see
[Write your own](#write-your-own). Each provider package signs in to its
vendor service and makes its requests. The packages work in OpenCode and in
[magpie](https://usemagpie.ai), which runs OpenCode's provider plugins.

| Package | Signs in to | Provider id |
|---|---|---|
| [agnes](packages/agnes) | Agnes AI international (agnes-ai.com), with Chrome browser sign-in, live text models, plan usage and USD balance | `agnes` |
| [agnes-code](packages/agnes-code) | Agnes AI's Agnes Code desktop, with the desktop's saved session (Windows) or a pasted access token: live models, daily credit check-in and points balance (unofficial) | `agnes-code` |
| [agy-cli](packages/agy-cli) | Antigravity on your installed agy CLI through ACP (`agy acp`), with agy's own Google sign-in: only the models agy offers this client, a process pool, MCP tool bridge and session resume (unofficial) | `agy-cli` |
| [antigravity](packages/antigravity) | Antigravity with a Google account (AI Pro, Ultra, free): Gemini, and the Claude and GPT-OSS models Google hosts for it, with Google sign-in or an imported refresh token | `antigravity` |
| [astudio](packages/astudio) | iFlytek's AStudio (科大讯飞 Astron Studio desktop), with the desktop's saved credentials or a pasted model token: live model catalog, daily login-points check-in and points balance (unofficial) | `astudio` |
| [atomcode](packages/atomcode) | AtomGit CodingPlan, with browser OAuth or the local AtomCode CLI's sign-in, signed requests, live models, quota windows and a read-only diagnostics page (unofficial) | `atomcode` |
| [catpaw](packages/catpaw) | Meituan's 妙手 CatPaw (ai.catpaw.meituan.com), with a browser web sign-in or the desktop client's saved credentials | `catpaw` |
| [cline](packages/cline) | Cline (cline.bot): usage-billed models, ClinePass's and Cline's free ones, with Cline's device sign-in or an API key | `cline` |
| [codearts](packages/codearts) | Huawei Cloud CodeArts (码道) coding plans (Trial, personal and enterprise credits), with Huawei Cloud OAuth sign-in (unofficial) | `codearts` |
| [commandcode](packages/commandcode) | Command Code plans (Pro, GOAT, Max, Ultra, Go, Teams Pro) | `commandcode-plan` |
| [copilot](packages/copilot) | GitHub Copilot on GitHub.com or GitHub Enterprise, with premium request or credit quotas | `github-copilot` |
| [cursor](packages/cursor) | Cursor subscriptions (Pro, Pro+, Ultra, Teams), on the API cursor-agent talks to | `cursor` |
| [devin](packages/devin) | Devin subscription (the devin CLI's account) | `devin` |
| [factory](packages/factory) | Factory (Droid) subscription | `factory` |
| [gcp-ai](packages/gcp-ai) | Google Cloud Vertex AI with your own gcloud / ADC login (needs `gcloud` and Chrome), plus the project's promotional credits | `gcp-ai` |
| [grok](packages/grok) | Grok (SuperGrok / X Premium+), through the Grok Build CLI's sign-in | `grok` |
| [gumloop](packages/gumloop) | Gumloop API key and user ID, with account models and a local credit estimate | `gumloop` |
| [inkstone](packages/inkstone) | (Unofficial) 书生·端砚 Token Plan: browser sign-in gives the ink-credit balance, the 5-hour and 7-day windows and the credit packs, and creates an `ink-*` API key to serve the plan's models for chat | `intern-inkstone` |
| [joycode](packages/joycode) | JoyCode IDE credits with JD account browser sign-in, live models and credit multipliers (unofficial) | `joycode` |
| [doubao-work](packages/doubao-work) | Doubao Work (豆包工作), whose agent runs in the cloud with no API, through the Doubao desktop app driven the way a person uses it (macOS, Windows) | `doubao-work` |
| [kimi-work](packages/kimi-work) | Ordinary Kimi desktop Work subscription, through the desktop app's local sign-in; separate from Kimi Code | `kimi-work` |
| [kiro](packages/kiro) | Kiro (Free, Pro, Pro+, Power), with Kiro's sign-in, kiro-cli's or the IDE's, or an API key | `kiro` |
| [loomy](packages/loomy) | iFlytek's Loomy (loomyad.xunfei.cn), with SMS sign-in | `loomy` |
| [mclaw](packages/mclaw) | China Mobile Cloud's MClaw agent (ai.yun.139.com), with a browser sign-in that harvests the ticket and auto-fetches the llm key: live models with token multipliers, aitokens pool usage, auto renewal (unofficial) | `mclaw` |
| [minimax](packages/minimax) | MiniMax Code (China): account credits and M Plan, with MiniMax Code's device sign-in | `minimax-code` |
| [minimax](packages/minimax) | MiniMax Code (international): account credits and M Plan, with MiniMax Code's device sign-in | `minimax-code-global` |
| [mimo](packages/mimo) | Xiaomi MiMo, with a Xiaomi account | `mimo-app` |
| [nous](packages/nous) | Nous Portal models, with Nous Portal's device sign-in | `nous-portal` |
| [openai-decisions](packages/openai-decisions) | OpenAI's native Decisions API as System One for magpie's classifiers and decision groups, with standard API-key sign-in and per-question refusal handling | `openai-decisions` |
| [opendesign](packages/opendesign) | Open Design Cloud (open-design.ai), with the Open Design CLI's device sign-in | `opendesign` |
| [qoder](packages/qoder) | Qoder subscription (qoder.com), with Qoder's device sign-in | `qoder` |
| [qoder](packages/qoder) | Qoder CN subscription (qoder.cn), with Qoder CN's device sign-in | `qoder-cn` |
| [raccoon](packages/raccoon) | SenseTime Raccoon (商汤小浣熊, xiaohuanxiong.com): account credits and daily check-in, with browser sign-in or Raccoon desktop's sign-in | `raccoon` |
| [river](packages/river) | River (river.ai) pay-as-you-go inference, with your API key: per-account models, documented reasoning efforts and live prices | `river` |
| [sap-aicore](packages/sap-aicore) | SAP AI Core deployments for account-scoped GPT Responses and Claude Messages models | `sap-aicore` |
| [sensenova](packages/sensenova) | SenseNova (商汤日日新) Token Plan: browser or password sign-in gives the credit pools, windows and grants, and the plan's models — the browser sign-in reuses or creates a Token Plan API key for you | `sensenova-token-plan` |
| [trae](packages/trae) | Trae CN (trae.cn) and Trae international (trae.ai), free tier included, with Trae's browser sign-in (experimental) | `trae-cn`, `trae-global` |
| [workbuddy](packages/workbuddy) | WorkBuddy (China build, CodeBuddy plan) | `workbuddy` |
| [workbuddy](packages/workbuddy) | WorkBuddy (international build) | `workbuddy-ai` |
| [zcode](packages/zcode) | ZCode: Z.ai / BigModel (智谱) GLM Coding Plan, team seats, Start Plan, daily claim of its gift plans | `zcode` |
| [zed](packages/zed) | Zed (Pro, Pro Trial, Student, Business): Anthropic, OpenAI, Google and xAI models hosted by Zed | `zed` |
| [zen-free](packages/zen-free) | OpenCode Zen free models with the public credential | `opencode-zen-free` |

Decision providers are used through magpie's classifiers and `/v1/systemone`;
see their package READMEs for client compatibility.

## Gateway middleware

These packages aren't OpenCode plugins. magpie runs them in its gateway, on the requests every agent sends and the replies it gets back, whichever provider serves them. Each one is a port of something [New API](https://github.com/QuantumNous/new-api) does for its channels, or something agents commonly need.

| Package | What it does |
|---|---|
| [param-override](packages/param-override) | New API's 参数覆盖 (`param_override`): set, delete, move, copy or rewrite request fields, for some models or under conditions, or turn a request away |
| [model-map](packages/model-map) | New API's 模型重定向 (`model_mapping`): send a model under another name, by name or `/pattern/`; replies name the model asked for |
| [system-prompt](packages/system-prompt) | Your own system prompt on every request, or on some agents' or models', in each API's own place |
| [output-strategy](packages/output-strategy) | Seven composable output styles with a selection panel; off by default, cache-stable, and Codex `instructions` stay untouched |
| [word-guard](packages/word-guard) | New API's 敏感词过滤: turn away or mask words and patterns in what users send, and in replies |
| [think-tags](packages/think-tags) | Take a leading `<think>`, `<thinking>` or `<thought>` block out of a reply's text, or put a Chat reply's `reasoning_content` into it (`thinking_to_content`) |
| [empty-reply](packages/empty-reply) | Drop the end of a reply that has reasoning but no text, so Claude Code and Codex retry instead of stopping |
| [antigravity-cloak](packages/antigravity-cloak) | Claude Code and Claude Desktop on Antigravity: break the words Antigravity turns their system prompt away for, in what Antigravity alone is sent |
| [codex-history](packages/codex-history) | Opt-in Responses history compatibility after switching providers: remove historical ciphertext and optional item IDs while preserving readable content and tool-call pairing |
| [history-trim](packages/history-trim) | Send a request's history smaller: fold a run of blank lines, drop a system prompt written twice and a message repeated right after itself, and cut a past tool result longer than `maxToolLength` at a word boundary |
| [agentcompass](packages/agentcompass) | [AgentCompass](https://github.com/akiiwa-games/AgentCompass) multi-dimensional task profiling, capability floor, Model DNA (`divergence`, `global_rigor`, `module_precision`), subscription quota opportunity-cost, and session-affinity routing (`magpie.middleware` + opt-in `/v1/systemone`) |

```sh
magpie plugin add @magpie-community/middleware-<name>
magpie plugin options <name> '<json>'
```

In the app, they're under Plugins › Discover › Gateway middleware, and each one's **Options** button edits its options in its row.

A middleware package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/middleware-<name>`, `"magpie": {"middleware": "./<name>.middleware.js", "options": {…}}`, no `main`. `options` is the example magpie offers when none are set.
- **`<name>.middleware.js`**: exports `onRequest`, `onEvent` and/or `onResponse` ([the hooks](https://usemagpie.ai/docs/plugins#middleware)). It runs in magpie's gateway on moejs, so it is one file and imports nothing.
- **`cases.json`** and a test that runs them with `check()` from `scripts/middleware.mjs`, which calls the hooks the way the gateway does.

### Routing strategies

A gateway plugin can also add routings: how one pool is ordered for a request, where the pool is a provider's accounts or keys, or a group's members. Each shows in every routing picker as `<plugin>/<name>`, beside magpie's own (smart, order, rotate, usage, pace, weight).

| Package | Routings |
|---|---|
| [reserve](packages/reserve) | `reserve/ceiling`: fill accounts in order up to a share of their allowance (80% by default), then the next; `reserve/accounts-first`: subscriptions before API keys, keys by weight |

```sh
magpie plugin add @magpie-community/middleware-<name>
magpie group set <id> routing=<name>/<routing>
```

A routing package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/middleware-<name>`, `"magpie": {"gateway": "./<name>.gateway.js", "options": {…}}`, no `main`.
- **`<name>.gateway.js`**: exports `strategies`, `{<routing>: (pool, seats, options) => [indexes]}` ([the reference](https://usemagpie.ai/docs/plugins#gateway-points)). Each seat has `key`, `account`, `known`, `used`, `soon`, `pace`, `weight`, `resting` and `tokens`. A strategy has 20 ms. One that throws, or answers anything but a permutation of the seats, leaves them in their listed order. It runs on moejs, so it is one file and imports nothing.
- **`strategies.json`** and a test that runs them with `checkStrategies()` from `scripts/middleware.mjs`: seats in, the order of their keys wanted out.

## Tools for every agent

These give tools to every agent magpie connects. magpie serves them on its MCP server, `/mcp/magpie/tools`, named `<plugin>_<tool>`.

| Package | Tools |
|---|---|
| [search1api](packages/search1api) | Web search, news, agentic search, page retrieval, sitemaps and trends, with Search1API OAuth or an API key |
| [specstream](packages/specstream) | `web_search` (live web answers with the source page of each value) and `extract` (page text from up to 20 URLs a call), with a SpecStream API key; also listed under Web search |
| [calc](packages/calc) | `eval` exact arithmetic in fractions, `convert` units (data, time, length, mass, angle, temperature), `date` calendar date math across time zones and DST. No network, no key |

```sh
magpie plugin add @magpie-community/tools-<name>
magpie plugin            # lists each plugin's tools
```

A tools package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/tools-<name>`, `"type": "module"`, `"main": "./index.mjs"`.
- **`index.mjs`**: exports one async plugin function that returns a `tool` hook, `{tool: {<name>: {description, args, execute(args)}}}` ([the reference](https://usemagpie.ai/docs/plugins#tools)). `args` is JSON Schema, and magpie passes the arguments on as they came, so `execute` checks them itself. A string it returns is sent as text, anything else as its JSON. Every function the module exports is taken as a plugin, so helpers go in another file.
- a test of each tool's `execute`. `bun scripts/check.mjs` loads the plugin and checks each tool's name, description and `args`.

## Web search APIs

A tools package can also give magpie a web search API. It is listed in Settings › Models › Web search under its own name, after Tavily, Brave and the rest, and is added, keyed, switched off and ordered like them. magpie keeps the keys (several are tried in turn; a refused one rests), masks the query, and logs the call. magpie's own `search` hook; OpenCode ignores it.

| Package | Search APIs |
|---|---|
| [magpie-websearch](https://github.com/guotree/magpie-websearch) | AnySearch, Bocha, Jina, Kagi, Keenable, Linkup, Metaso, Moonshot, Moonshot CN, Ollama, Parallel, Perplexity, Querit, SerpApi, Serper, StepFun, TinyFish, Z.ai and Zhipu; published as `@guotree/magpie-websearch` and maintained in its own repository |
| [magpie-search-mix](https://github.com/mdwsk88/magpie-search-mix) | magpie-search-mix, which asks two (or more) of Tavily, Brave, Exa, Firecrawl, You.com, DeepSeek, Doubao Search, Yuanbao Search and SearXNG at once, the ones you name in its key field, and gives their pages in turn, deduplicated; published as `magpie-search-mix` and maintained in its own repository |

Install magpie-websearch:

```sh
magpie plugin add @guotree/magpie-websearch
```

Install magpie-search-mix:

```sh
magpie plugin add magpie-search-mix
```

### Writing a web search plugin

The following template shows how to implement the `search` hook:

```js
// index.mjs of @magpie-community/tools-<name>
export const MySearch = async () => ({
  search: {
    myvendor: {                    // [a-z0-9-], at most 32; listed as `<name>:myvendor`
      name: "My vendor",
      keysURL: "https://example.com/keys",   // optional "Get a key" link
      keyOptional: false,                    // true: it answers with no key
      url: false,                            // true: the user gives its address, as for SearXNG
      async execute({ query, count, key, url }, ctx) {
        const r = await fetch(`https://example.com/search?q=${encodeURIComponent(query)}&n=${count}`, {
          headers: { authorization: `Bearer ${key}` },
          signal: ctx.abort,
        })
        // a throw with a numeric `status` is the vendor refusing the key (401, 402, 403, 429 rest it)
        if (!r.ok) throw Object.assign(new Error(await r.text()), { status: r.status })
        return (await r.json()).results.map((x) => ({ title: x.title, url: x.url, text: x.snippet }))
      },
    },
  },
})
```

`execute` returns `[{title, url, text?, age?}]` or `{results: [...]}`; pages with no url are dropped, and magpie strips tags and cuts the text. Any other throw is a failure and the next search API is asked. It has a quarter of a search's limit, and `ctx.abort` fires then. magpie reads the list a plugin gives from the last time the plugin loaded, so a plugin just added is listed once it has loaded. [The reference](https://usemagpie.ai/docs/plugins) does not have this yet.

## Pages

These add a page to magpie's window, in the app and in `magpie web`, under Plugins in the sidebar.

| Package | Page | Reads |
|---|---|---|
| [usage](packages/usage) | Usage glance: calls, errors, tokens and cost for today, 7 or 30 days, and the models behind them | `usage:summary` |
| [free-tokens](packages/free-tokens) | AIHOT's Token freebies in three tiers (already configured and usable / needs one more plugin / no plugin yet), with the plugin to install or the exact login step for each | none; its host part reads magpie's folder (providers/checkin) and fetches aihot.news/free-tokens.data once each time the plugin host starts |
| [amp-usage](packages/amp-usage) | Amp usage: requests, input/output tokens, cache reads and writes and cache hit rate from Amp's cloud exports and legacy local threads, synced in the background into Magpie's usage ledger for its usage pages and Day card | none; its host part runs the Amp CLI, reads Amp's local thread files and reports usage to the local Magpie |
| [day-card](packages/day-card) | Day card: a day of your usage drawn as a card (tokens, cost, each agent and its models, streak, average day), copied as a picture or saved as a PNG | `usage:day` |
| [powercontext](packages/powercontext) | Connection settings for an independently deployed PowerContext service | None |
| [nowledge-mem](packages/nowledge-mem) | Connection settings, recall and capture switches, a real connection test, and the scope of what is sent | None |
| [agent-office](packages/agent-office) | What are my agents doing: a real WebGL 3D office with six scenes, an isometric/2D office, grouped workbench, Today usage and recent conversations | no `magpie.read`; its host part reads local session files of Claude Code, Codex, Copilot CLI, Kimi Code, dsh, Gemini CLI, Qwen Code, Pi, omp, Qoder, WorkBuddy, CodeBuddy and Grok Build, including prompts, replies and tool commands (`text:false` keeps statuses and tool names only) |
| [page-usage-tree](packages/page-usage-tree) | Account usage: usage as provider -> account -> model, each level expandable, with per-account calls, errors and cost; adds the account layer Usage glance's `usage:summary` does not contain | none (its local service calls Magpie's local usage API) |
| [page-usage-board](packages/page-usage-board) | Full usage board: quota cards with expiry tiers, daily/per-provider charts, 24h cache-hit and token curves, optional remote attribution and account detail | none (the page reads nothing through the bridge; its local service reads your usage.jsonl, magpie's usage/quota API, and — for optional remote attribution — your magpie config's provider key to query the configured remote magpie) |
| [page-model-quota](packages/page-model-quota) | Model quota: how many tokens each model has left, merged across every account and provider; each quota window is turned into tokens from your usage history and split by the model's share in it | none (its local service reads `usage.jsonl` and `quota-history.json`, and calls magpie's local quota API) |
| [fingerprint](packages/fingerprint) | Numeric response fingerprints to investigate suspected model substitution across providers, with shared challenges, candidate rankings, local evidence and JSON export | none (its local service calls magpie’s gateway; sampling uses provider quota) |
| [chat](packages/chat) | Chat with magpie's models, your MCP servers, instructions and skills, by Magic_zero ([Magiczerowxy](https://github.com/Magiczerowxy)). Has a host part: a local service the page goes to | none (its service calls magpie's gateway) |
| [window-warmup](packages/window-warmup) | Window warmup: send one fixed short message ("hi", max_tokens 16) to a provider, account and model you pick, right after its quota window resets, daily at set times or every few hours, so the next subscription window opens early, by [YangHonghang](https://github.com/YangHonghang). Has a host part: a local service on 127.0.0.1 the page goes to | none; its service calls magpie's gateway and reads magpie's providers.json (keys only as sha256 fingerprints, plus key names and account models) and model cache. Each send uses the chosen account's quota |
| [agent-console](packages/agent-console) | Drive the Agent CLIs on this computer (Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Devin, dsh) with a timeline, Git changes, files and a terminal, by [qingnian108](https://github.com/qingnian108). Has a host part: a gate and a daemon on 127.0.0.1, started when the page opens | none (its daemon runs the Agent CLIs you pick, in the projects you open) |
| [page-harnessweight](packages/page-harnessweight) | Compare the agent harnesses behind the gateway: tokens, cache, failures, latency and estimated tool-definition size. Has a local service and a read-only gateway hook, by [webkubor](https://github.com/webkubor) | none (the service reads the local usage ledger and the local gateway's agent names and icon keys; the hook records tool names and numerical usage metadata locally) |

```sh
magpie plugin add @magpie-community/page-<name>
```

A page package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/page-<name>`, no `main`, and `"magpie": {"page": {"title", "file", "icon"}, "permissions": [...], "options": {…}}` ([the reference](https://usemagpie.ai/docs/plugins#pages)). `permissions` lists the reads the page makes, and magpie refuses any other. Declare only what it reads.
- **the page**: HTML, CSS and scripts in files. It runs in a sandboxed frame with no network (`connect-src 'none'`) and no inline scripts. It talks to magpie only through `_magpie/bridge.js`: `magpie.ready`, `magpie.read(name, params)`, `magpie.options.get/set` (at most once a second), and `magpie.theme` with `onTheme`, whose `--magpie-*` variables it styles itself by.
- a test that the page's scripts read only what `permissions` declares and reach no network, and of what it draws from a read.
- optionally a host part: `main` with the OpenCode v1 form `export default {id, server}`, where `server(input, options)` starts a service on 127.0.0.1 that the page navigates its frame to. Such a service guards every route with a token only its own page gets, and checks `Host` ([chat](packages/chat) is the example).

## Gateway hooks

Like middleware, these run on the requests agents send, but in magpie's Bun host rather than on moejs, so one can wait on a service, keep state and import Node's built-ins. They require Magpie 0.1.1273 or newer and declare `magpie.hooks`.

| Package | What it does |
|---|---|
| [powercontext](packages/powercontext) | [PowerContext](https://github.com/oceanbase/powercontext) recall and opt-in completed-conversation capture; no client MCP or skill required |
| [nowledge-mem](packages/nowledge-mem) | [Nowledge Mem](https://mem.nowledge.co) recall, Context Bundle or Working Memory, per-harness provenance and opt-in conversation import as Mem Threads, automatic for every harness behind Magpie |
| [aelios](packages/aelios) | [Aelios](https://github.com/Aelios-project/Aelios) recall before each turn from your own Aelios on Cloudflare, and opt-in recording of each turn so Aelios can remember it |
| [respire-memory](packages/respire-memory) | [Respire](https://github.com/risense-ai/respire-magpie): per-turn recall and complete policy reads, automatic process diaries, and grounded experience archival with readback; storage runs after reply completion |
| [OpenViking](https://github.com/volcengine/OpenViking/tree/main/examples/magpie-memory-plugin) | OpenViking context recall and opt-in completed-conversation capture using existing OpenViking configuration; published as `@openviking/magpie-plugin` and maintained in the OpenViking repository |
| [@vshulcz/magpie-deja](https://github.com/vshulcz/deja-vu/tree/main/extensions/magpie) | [deja-vu](https://github.com/vshulcz/deja-vu) local cross-agent session memory: recalls project-scoped (`ctx.cwd`) history from the transcripts Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Cursor and DSH write on disk, scrubs secret patterns, and attaches the recalled excerpt to the request sent to your model provider; when recalled history helped, the model is asked to end its reply with a one-line `déjà vu: … — reusing it.` note |
| [notify](packages/notify) | A push to ntfy, Bark, Gotify, Server酱, Feishu, DingTalk, WeCom, Telegram or a webhook when an agent's turn is done or fails, after it ran `minMinutes` or longer, and when a subscription account needs signing in again |
| [page-harnessweight](packages/page-harnessweight) | Tracks in-flight request counts in memory and records tool-definition sizes and usage metadata after responses; never modifies requests |

Use the same plugin management commands as middleware:

```sh
magpie plugin add @magpie-community/gateway-powercontext
magpie plugin add @magpie-community/gateway-nowledge-mem
magpie plugin add @magpie-community/gateway-aelios
magpie plugin add @magpie-community/gateway-notify
```

Installed plugins use **Plugins › Installed › Options** and the normal on/off
switch. Deploy PowerContext yourself using its
[official installation walkthrough](https://powercontext.oceanbase.io/en/docs/get-started/quickstart/),
then configure the Server URL and service key in the plugin's connection page
or Options. The Scope ID is optional: without one, the service resolves the
session/workspace binding or its default Scope. Use Magpie **0.1.1531 or newer**
for page saves to reach hooks on the next request; earlier hook-capable versions
need a Magpie restart after saving page options.
No Server URL is assumed and capture defaults to off;
remote/shared-key recall and capture each need a separate opt-in. The package calls an existing
Server; it does not provision services or manage processes. See the
[plugin README](packages/powercontext).

Nowledge Mem needs no deployment of its own: the hook takes the endpoint and
key from the plugin page, or from `NMEM_API_URL` and `NMEM_API_KEY` in Magpie's
environment, and falls back to a local Mem at `http://127.0.0.1:14242`. Recall
and the Context Bundle are on; importing conversations is off until enabled.
Tools are Mem's own MCP server, added once in Library › MCP; the package adds
no Library entry. Recall and saving include direct local requests and the
sharing key Magpie writes into your own agents on this computer (`magpie-key`,
Magpie 0.1.2210+); other gateway keys and remote requests stay out. **Test
connection** checks the saved connection from a loopback helper; save changes
first. Harness prompts and commands stay with the harnesses. See the
[plugin README](packages/nowledge-mem).

The asynchronous hook API shipped in Magpie 0.1.1273; see the
[released host contract](https://github.com/yetone/magpie/blob/v0.1.1273/docs/subsystems/gateway-request-hooks.md).

A gateway hook package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/gateway-<name>`, `"magpie": {"hooks": "./<name>.hooks.mjs", "options": {…}}`, no `main`.
- **`<name>.hooks.mjs`**: exports async `onRequest(body, ctx)` to add context. Optional `onResponse(reply, ctx)` observes a completed reply through a bounded, best-effort notification. The hooks share request-local `ctx.state`. Client tool declarations and execution loops remain client-owned.
- tests that call the hooks the way the gateway does, with any service they talk to faked.

## Agents

These add an agent magpie has no setup of its own for. Once added, the agent is
on magpie's Agents page like the ones magpie ships with: pick one of magpie's
models in its row and magpie writes it into the agent's config, and switching
it off puts the config back.

| Package | Agent |
|---|---|
| [aider](packages/aider) | [Aider](https://aider.chat): `~/.aider.conf.yml`, through litellm's `openai/` prefix |
| [nanobot](packages/nanobot) | [nanobot](https://github.com/HKUDS/nanobot): Magpie's model becomes nanobot's default preset, and Library gives it MCP servers and default-workspace skills; restart nanobot after MCP changes |
| [reasonix-desktop](packages/reasonix-desktop) | [Reasonix 1.x](https://github.com/esengine/DeepSeek-Reasonix/tree/main-v2) Desktop and CLI: reversible global TOML/dotenv bridge; restart Reasonix after choosing a model. Separate from the built-in Studio 2.x adapter |
| [deepzora](packages/deepzora) | [Deepzora](https://github.com/SivanCola/deepzora) Desktop, CLI and ACP: reversible global TOML/dotenv bridge; restart Deepzora after choosing a model |
| [bub](packages/bub) | [Bub](https://bub.build): `~/.bub/config.yml`, as the `magpie:` provider (needs Bub 0.5.1 or later) |
| [kilo](packages/kilo) | [Kilo Code](https://kilo.ai): `~/.config/kilo/kilo.jsonc`, through an OpenAI-compatible provider |
| [junie](packages/junie) | [Junie CLI](https://junie.jetbrains.com/): an explicit `/v1/models` seed for its full picker and Magpie's selected model as the launch default; no LiteLLM |
| [kimi-desktop](packages/kimi-desktop) | Ordinary [Kimi desktop](https://www.kimi.com/) Work, through its authenticated local runtime; not Kimi Code CLI |
| [pig](packages/pig) | [PiG](https://github.com/MichaelKinsy/PiG): Magpie's endpoint and model catalog in `~/.pig/agent/models.json`, and the model PiG starts on (`defaultProvider`/`defaultModel` in `settings.json`) picked on the Agents page |
| [type4me](packages/type4me) | [Type4Me](https://github.com/joewongjc/type4me), macOS voice input: `~/Library/Application Support/Type4Me/magpie-agent.json`, for its LLM post-processing |
| [opencodereview](packages/opencodereview) | [Open Code Review](https://github.com/alibaba/open-code-review) (`ocr`): `~/.opencodereview/config.json` as a custom Anthropic provider, so `ocr review` / `ocr scan` run on magpie's models |
| [nowledge-mem-agent](packages/nowledge-mem-agent) | [Nowledge Mem / AI Now](https://mem.nowledge.co/): choose Default, AI Now and Background models through Magpie, with recovery journaling; separate from the Nowledge memory recall/capture gateway plugin |
| [minimax-design](packages/minimax-design) | [MiniMax Design](https://design.minimax.io), the local multimodal creation studio: one custom-model entry in `%APPDATA%\@hilo\desktop\hub-config.json` whose model menu follows magpie's list; Windows only |
| [eta](packages/eta) | [Eta](https://github.com/Lingwcy/eta): connect-only local gateway integration; choose models and routing groups in Eta’s own picker after restarting. Requires Eta 0.1.164 or later |
| [rhino9-ai](packages/rhino9-ai) | [Magpie-Rhino](https://github.com/mikidaren/Magpie-Rhino) for Rhino 9 on Windows, with Magpie models, custom groups and routing strategies through Rhino MCP. Install the companion `.yak`, restart Rhino once, then open its AI panel and choose **Magpie**; no command required |

```sh
magpie plugin add @magpie-community/agent-<name>
```

An agent package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/agent-<name>`, `"magpie": {"agent": "./<name>.agent.js"}`, and no `main` unless the agent needs a runtime (below).
- **`<name>.agent.js`**: exports `agent` (where the agent keeps its model) and, if it needs more than the model, `connect` (the other keys to write) ([the reference](https://usemagpie.ai/docs/plugins#agents)). It runs in magpie on moejs, so it is one file and imports nothing.
- a test of what `connect` returns.

An agent that needs more than moejs gives it (a timer, a file watched, a
value carried into the app's own config while it runs) keeps its
`<name>.agent.js` as above and adds a Bun module as the package's `main`,
run in the plugin host as a provider plugin's is (kimi-desktop and
reasonix-desktop do). It is still an agent: magpie lists a package that
declares `magpie.agent` under Agents, on GitHub too, `main` or not, and its
Installed row wears Provider only when that module serves a provider.

## Skills

Agent skills for magpie users, in `skills/<name>/SKILL.md`.

| Skill | What it does |
|---|---|
| [magpie-setup](skills/magpie-setup) | Lets an agent set magpie up as the user asks, through its own `magpie` commands: keys and subscriptions, an agent's model, routing groups with fallbacks and time-of-day rules, gateway keys with budgets, and MCP servers and instructions shared with every agent |
| [magpie-quota](skills/magpie-quota) | Lets an agent check what is left of every subscription, coding plan and key balance magpie has (`magpie quota --json`), and wait for allowance to come back |

In magpie, they are first under Library › Market › Skills. Elsewhere:

```sh
npx skills add magpie-community/plugins --skill magpie-setup
npx skills add magpie-community/plugins --skill magpie-quota
```

## Use

magpie:

```sh
magpie plugin add @magpie-community/opencode-<name>-auth
magpie plugin login <provider id>
```

In the app, the Plugins tab lists these packages: install one there, then
sign in.

OpenCode, in `opencode.json`:

```json
{ "plugin": ["@magpie-community/opencode-<name>-auth"] }
```

then `opencode auth login`.

## Writing a package

Each package is a folder under `packages/<name>/`:

- **`package.json`**
  - name: `@magpie-community/opencode-<name>-auth`
  - `"type": "module"`, `"main": "./index.mjs"`
  - version, `"license": "MIT"`
  - no runtime dependencies unless one is really needed. Bun's and Node's
    `fetch`, `crypto` and `fs` usually cover it.
- **`index.mjs`**
  - Exports one async plugin function, as OpenCode's `Plugin` type
    describes.
  - Returns an `auth` hook: `{ provider, loader, methods }`.
    - A browser sign-in is `{ type: "oauth", label, prompts?, authorize }`.
      `authorize` returns `{ url, instructions, method: "auto" | "code", callback }`.
    - A key is `{ type: "api", label }`.
    - `loader(getAuth, provider)` returns what the AI SDK is given:
      `baseURL`, `apiKey`, `headers` and a `fetch` that signs each request
      and refreshes the token (saving it with `client.auth.set`).
    - Keep Magpie's provider credentials owned by the host: use `getAuth`
      for the selected account.
  - A provider that models.dev doesn't list is declared in a `config` hook
    that sets `config.provider[<id>] = { name, npm, api, models }`. The npm
    field names the AI SDK package the models speak:
    `@ai-sdk/openai-compatible` (chat completions), `@ai-sdk/openai`
    (Responses) or `@ai-sdk/anthropic` (Messages).
  - A list the account decides goes in the `provider: { id, models(provider, { auth }) }`
    hook.
  - A daily check-in (签到) the vendor rewards goes in the `auth` hook as
    `checkin(getAuth, provider)`. magpie calls it once a day for each
    signed-in account while the user has it on (Settings → Usage →
    Plugins), and shows what came of it on the account's Usage card. It
    returns `{ outcome, credit?, streak?, message?, until? }`, `outcome` being
    `claimed` (checked in now), `done` (already today), `ineligible`,
    `inactive` (no check-in event now), `captcha` or `failed`; a throw is
    `failed` with its message, and only `failed` is tried again that day.
    `until` (RFC 3339) is when the vendor's own day turns, if not at
    Beijing midnight: magpie asks again then (Qoder's opens at 10:00 UTC+8).
    Never solve a captcha: return `captcha` and the user checks in in the
    vendor's app. Needs magpie with the hook (after v0.1.1083);
    [the contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md#a-plugins-daily-check-in).
- **`README.md`**: what the package signs in to, how, where the sign-in is
  kept, and the models.

The provider id is the one magpie's built-in subscription has (`grok`,
`zcode`, `workbuddy`, `commandcode-plan`, …). While magpie still has the
built-in, the plugin's provider shows as `<id>-plugin`. Once the built-in
is gone, it takes over the same id, so an agent set to `<id>/<model>` keeps
working.

## Write your own

The reference is [usemagpie.ai/docs/plugins](https://usemagpie.ai/docs/plugins): [tools](https://usemagpie.ai/docs/plugins#tools), [pages](https://usemagpie.ai/docs/plugins#pages), [gateway points](https://usemagpie.ai/docs/plugins#gateway-points) (routing strategies among them), [middleware](https://usemagpie.ai/docs/plugins#middleware) and [agents](https://usemagpie.ai/docs/plugins#agents). [Quick start](https://usemagpie.ai/docs/plugins#quick) is the shortest way in.

Start from the package of the same kind here and rename it:

- a tool: [calc](packages/calc);
- a page: [usage](packages/usage);
- a routing: [reserve](packages/reserve);
- middleware: [think-tags](packages/think-tags);
- an agent: [aider](packages/aider);
- a subscription: [zen-free](packages/zen-free).

Try it from its folder before publishing, in a sandbox HOME:

```sh
magpie plugin add ./packages/<name>
magpie plugin
```

## Checking a package

```sh
bun scripts/check.mjs [<name>]        # loads each plugin and checks its hooks; signs in to nothing
MAGPIE=/path/to/magpie scripts/try.sh <name> [login <id> | provider test <id>-plugin]
```

`try.sh` runs magpie in a sandbox HOME (`.sandbox/<name>`), so your own
magpie, agents and sign-ins are left alone.

## License

MIT

## The market

`registry.json` is the list magpie's Plugins tab shows: the packages
here. An entry that signs in to nothing has a `"kind"` and no `providers`:
`"middleware"` for gateway middleware and routing strategies, `"tools"`,
`"page"` or `"agent"`. A package that declares `magpie.agent` is
`"agent"`, with a `main` or without. magpie
fetches it every few hours and keeps a copy built into the app for when
it can't. To list a plugin, add an entry with its npm `package`, a
`name`, `providers` (the provider ids it signs in to), an `icon` (one
magpie has, or none) and a `summary` in English and Chinese (`{"en": …, "zh": …}`), and open a pull
request.

### One channel already listed

Duplicates are judged by channel, not by the shape of the package. A
channel is the vendor service a provider id signs in to, so `astudio` and
`hub-astudio` are one channel. A channel counts as listed when any entry
has it, including an aggregate package that names it in its `providers`
array.

A new standalone package for a listed channel says how it differs from
the entry already there: how it signs in, which endpoint it calls, what it
supports, and what it can do that the existing entry can't. That goes in
three places: the pull request, the package's README and its registry
`summary` (en and zh), so a user can tell which one to install. A package
that can't name a difference is not merged. Two entries for one channel
that are both kept say in their READMEs and summaries what they share,
such as one account's credit pool
([#614](https://github.com/magpie-community/plugins/issues/614)).

## Publishing

A version bump pushed to `main` ships itself, two ways
(`.github/workflows/publish.yml`):

- **dist**: every package's version is packed onto the `dist` branch
  (`scripts/dist.mjs`): `tgz/<file>` and `index.json`, which names each
  version's tarball and its sha512. magpie (0.1.1243 and later) installs a
  `@magpie-community` package from there whenever npm doesn't have the
  version: a new package, or one npm refused. It installs a tarball only
  when the sha512 matches. This needs nobody, so **a new plugin is merged
  as soon as its review is done**; it never waits for npm.
- **npm**: every version npm doesn't have yet is published. npm tries
  trusted publishing (OIDC) first, which needs the package to name
  `publish.yml` as its Trusted Publisher on npmjs.com with `npm publish`
  allowed. A trust made since 2026-09-03 allows only `npm stage publish`
  unless told otherwise, so make it with `--allow-publish`:

  ```sh
  npx npm@latest trust github <package> --file publish.yml \
    --repo magpie-community/plugins --allow-publish \
    --registry=https://registry.npmjs.org/ -y
  ```

A package's first version can't go through trusted publishing: a Trusted
Publisher is set on a package that exists, and setting one takes an
owner's 2FA. Until an owner of the magpie-community npm org
publishes it and sets its Trusted Publisher as above, magpie serves it
from `dist`, and the publish run notes it without failing.

An owner does all of it with one command, from any checkout:

```sh
sh scripts/owner.sh            # --dry-run says what it would do
```

It first-publishes every package npm doesn't have and makes its Trusted
Publisher, makes again (with npm publish allowed) the Trusted Publisher of
every package whose version npm lacks, and runs `publish.yml` for those.
It works from origin/main, skips what is up to date, and asks for 2FA in
the browser. The repository's `NPM_TOKEN` secret, a granular token with 2FA
bypassed, still publishes a first version while npm lets such tokens
publish (npm plans to end that in January 2027).

A pull request's `on-npm` check notes any package not on npm yet. It is
not a reason to hold the merge.
