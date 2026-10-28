# magpie-community plugins

[OpenCode](https://opencode.ai) provider plugins for coding-plan
subscriptions, and [gateway middleware](#gateway-middleware),
[routing strategies](#routing-strategies), [tools for every
agent](#tools-for-every-agent), [pages](#pages) and [agents](#agents) for
magpie, maintained by the community. To make one, see
[Write your own](#write-your-own). Each package signs in to one
subscription and makes its requests. The packages work in OpenCode and in
[magpie](https://usemagpie.ai), which runs OpenCode's provider plugins.

| Package | Signs in to | Provider id |
|---|---|---|
| [cline](packages/cline) | Cline (cline.bot): usage-billed models, ClinePass's and Cline's free ones, with Cline's device sign-in or an API key | `cline` |
| [codearts](packages/codearts) | Huawei Cloud CodeArts (码道) coding plans (Trial, personal and enterprise credits), with Huawei Cloud OAuth sign-in (unofficial) | `codearts` |
| [commandcode](packages/commandcode) | Command Code plans (Pro, GOAT, Max, Ultra, Go, Teams Pro) | `commandcode-plan` |
| [copilot](packages/copilot) | GitHub Copilot on GitHub.com or GitHub Enterprise, with premium request or credit quotas | `github-copilot` |
| [cursor](packages/cursor) | Cursor subscriptions (Pro, Pro+, Ultra, Teams), on the API cursor-agent talks to | `cursor` |
| [devin](packages/devin) | Devin subscription (the devin CLI's account) | `devin` |
| [factory](packages/factory) | Factory (Droid) subscription | `factory` |
| [gcp-ai](packages/gcp-ai) | Google Cloud Vertex AI with your own gcloud / ADC login (needs `gcloud` and Chrome), plus the project's promotional credits | `gcp-ai` |
| [grok](packages/grok) | Grok (SuperGrok / X Premium+), through the Grok Build CLI's sign-in | `grok` |
| [joycode](packages/joycode) | JoyCode IDE credits with JD account browser sign-in, live models and credit multipliers (unofficial) | `joycode` |
| [kimi-work](packages/kimi-work) | Ordinary Kimi desktop Work subscription, through the desktop app's local sign-in; separate from Kimi Code | `kimi-work` |
| [kiro](packages/kiro) | Kiro (Free, Pro, Pro+, Power), with Kiro's sign-in, kiro-cli's or the IDE's, or an API key | `kiro` |
| [minimax](packages/minimax) | MiniMax Code (China): account credits and M Plan, with MiniMax Code's device sign-in | `minimax-code` |
| [minimax](packages/minimax) | MiniMax Code (international): account credits and M Plan, with MiniMax Code's device sign-in | `minimax-code-global` |
| [mimo](packages/mimo) | Xiaomi MiMo, with a Xiaomi account | `mimo-app` |
| [nous](packages/nous) | Nous Portal models, with Nous Portal's device sign-in | `nous-portal` |
| [opendesign](packages/opendesign) | Open Design Cloud (open-design.ai), with the Open Design CLI's device sign-in | `opendesign` |
| [qoder](packages/qoder) | Qoder subscription (qoder.com), with Qoder's device sign-in | `qoder` |
| [qoder](packages/qoder) | Qoder CN subscription (qoder.cn), with Qoder CN's device sign-in | `qoder-cn` |
| [raccoon](packages/raccoon) | SenseTime Raccoon (商汤小浣熊, xiaohuanxiong.com): account credits and daily check-in, with browser sign-in or Raccoon desktop's sign-in | `raccoon` |
| [river](packages/river) | River (river.ai) pay-as-you-go inference, with your API key: per-account models, documented reasoning efforts and live prices | `river` |
| [trae](packages/trae) | Trae CN (trae.cn) and Trae international (trae.ai), free tier included, with Trae's browser sign-in (experimental) | `trae-cn`, `trae-global` |
| [workbuddy](packages/workbuddy) | WorkBuddy (China build, CodeBuddy plan) | `workbuddy` |
| [workbuddy](packages/workbuddy) | WorkBuddy (international build) | `workbuddy-ai` |
| [zcode](packages/zcode) | ZCode: Z.ai / BigModel (智谱) GLM Coding Plan, team seats, Start Plan | `zcode` |
| [zed](packages/zed) | Zed (Pro, Pro Trial, Student, Business): Anthropic, OpenAI, Google and xAI models hosted by Zed | `zed` |
| [zen-free](packages/zen-free) | OpenCode Zen free models with the public credential | `opencode-zen-free` |

## Gateway middleware

These packages aren't OpenCode plugins. magpie runs them in its gateway, on the requests every agent sends and the replies it gets back, whichever provider serves them. Each one is a port of something [New API](https://github.com/QuantumNous/new-api) does for its channels, or something agents commonly need.

| Package | What it does |
|---|---|
| [param-override](packages/param-override) | New API's 参数覆盖 (`param_override`): set, delete, move, copy or rewrite request fields, for some models or under conditions, or turn a request away |
| [model-map](packages/model-map) | New API's 模型重定向 (`model_mapping`): send a model under another name, by name or `/pattern/`; replies name the model asked for |
| [system-prompt](packages/system-prompt) | Your own system prompt on every request, or on some agents' or models', in each API's own place |
| [word-guard](packages/word-guard) | New API's 敏感词过滤: turn away or mask words and patterns in what users send, and in replies |
| [think-tags](packages/think-tags) | Take `<think>…</think>` out of a reply's text, or put a Chat reply's `reasoning_content` into it (`thinking_to_content`) |
| [antigravity-cloak](packages/antigravity-cloak) | Claude Code and Claude Desktop on Antigravity: break the words Antigravity turns their system prompt away for, in what Antigravity alone is sent |
| [codex-history](packages/codex-history) | Opt-in Responses history compatibility after switching providers: remove historical ciphertext and optional item IDs while preserving readable content and tool-call pairing |
| [history-trim](packages/history-trim) | Send a request's history smaller: fold a run of blank lines, drop a system prompt written twice and a message repeated right after itself, and cut a past tool result longer than `maxToolLength` at a word boundary |

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
| [calc](packages/calc) | `eval` exact arithmetic in fractions, `convert` units (data, time, length, mass, angle, temperature), `date` calendar date math across time zones and DST. No network, no key |

```sh
magpie plugin add @magpie-community/tools-<name>
magpie plugin            # lists each plugin's tools
```

A tools package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/tools-<name>`, `"type": "module"`, `"main": "./index.mjs"`.
- **`index.mjs`**: exports one async plugin function that returns a `tool` hook, `{tool: {<name>: {description, args, execute(args)}}}` ([the reference](https://usemagpie.ai/docs/plugins#tools)). `args` is JSON Schema, and magpie passes the arguments on as they came, so `execute` checks them itself. A string it returns is sent as text, anything else as its JSON. Every function the module exports is taken as a plugin, so helpers go in another file.
- a test of each tool's `execute`. `bun scripts/check.mjs` loads the plugin and checks each tool's name, description and `args`.

## Pages

These add a page to magpie's window, in the app and in `magpie web`, under Plugins in the sidebar.

| Package | Page | Reads |
|---|---|---|
| [usage](packages/usage) | Usage glance: calls, errors, tokens and cost for today, 7 or 30 days, and the models behind them | `usage:summary` |

```sh
magpie plugin add @magpie-community/page-<name>
```

A page package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/page-<name>`, no `main`, and `"magpie": {"page": {"title", "file", "icon"}, "permissions": [...], "options": {…}}` ([the reference](https://usemagpie.ai/docs/plugins#pages)). `permissions` lists the reads the page makes, and magpie refuses any other. Declare only what it reads.
- **the page**: HTML, CSS and scripts in files. It runs in a sandboxed frame with no network (`connect-src 'none'`) and no inline scripts. It talks to magpie only through `_magpie/bridge.js`: `magpie.ready`, `magpie.read(name, params)`, `magpie.options.get/set` (at most once a second), and `magpie.theme` with `onTheme`, whose `--magpie-*` variables it styles itself by.
- a test that the page's scripts read only what `permissions` declares and reach no network, and of what it draws from a read.

## Agents

These add an agent magpie has no setup of its own for. Once added, the agent is
on magpie's Agents page like the ones magpie ships with: pick one of magpie's
models in its row and magpie writes it into the agent's config, and switching
it off puts the config back.

| Package | Agent |
|---|---|
| [aider](packages/aider) | [Aider](https://aider.chat): `~/.aider.conf.yml`, through litellm's `openai/` prefix |
| [bub](packages/bub) | [Bub](https://bub.build): `~/.bub/config.yml`, as the `magpie:` provider (needs Bub 0.5.1 or later) |
| [kilo](packages/kilo) | [Kilo Code](https://kilo.ai): `~/.config/kilo/kilo.jsonc`, through an OpenAI-compatible provider |
| [kimi-desktop](packages/kimi-desktop) | Ordinary [Kimi desktop](https://www.kimi.com/) Work, through its authenticated local runtime; not Kimi Code CLI |
| [pig](packages/pig) | [PiG](https://github.com/MichaelKinsy/PiG): injects Magpie's endpoint and model catalog into `~/.pig/agent/models.json`; choose the model in PiG, startup settings stay unchanged |
| [type4me](packages/type4me) | [Type4Me](https://github.com/joewongjc/type4me), macOS voice input: `~/Library/Application Support/Type4Me/magpie-agent.json`, for its LLM post-processing |
| [opencodereview](packages/opencodereview) | [Open Code Review](https://github.com/alibaba/open-code-review) (`ocr`): `~/.opencodereview/config.json` as a custom Anthropic provider, so `ocr review` / `ocr scan` run on magpie's models |

```sh
magpie plugin add @magpie-community/agent-<name>
```

An agent package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/agent-<name>`, `"magpie": {"agent": "./<name>.agent.js"}`, no `main`.
- **`<name>.agent.js`**: exports `agent` (where the agent keeps its model) and, if it needs more than the model, `connect` (the other keys to write) ([the reference](https://usemagpie.ai/docs/plugins#agents)). It runs in magpie on moejs, so it is one file and imports nothing.
- a test of what `connect` returns.

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
`"page"` or `"agent"`. magpie
fetches it every few hours and keeps a copy built into the app for when
it can't. To list a plugin, add an entry with its npm `package`, a
`name`, `providers` (the provider ids it signs in to), an `icon` (one
magpie has, or none) and a `summary` in English and Chinese (`{"en": …, "zh": …}`), and open a pull
request.

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
