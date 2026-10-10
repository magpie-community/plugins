# magpie-community plugins

[OpenCode](https://opencode.ai) provider plugins for coding-plan
subscriptions, and [gateway middleware](#gateway-middleware) and [agents](#agents) for magpie,
maintained by the community. Each package signs in to one
subscription and makes its requests. The packages work in OpenCode and in
[magpie](https://usemagpie.ai), which runs OpenCode's provider plugins.

| Package | Signs in to | Provider id |
|---|---|---|
| [cline](packages/cline) | Cline (cline.bot): usage-billed models, ClinePass's and Cline's free ones, with Cline's device sign-in or an API key | `cline` |
| [commandcode](packages/commandcode) | Command Code plans (Pro, GOAT, Max, Ultra, Go, Teams Pro) | `commandcode-plan` |
| [cursor](packages/cursor) | Cursor subscriptions (Pro, Pro+, Ultra, Teams), on the API cursor-agent talks to | `cursor` |
| [devin](packages/devin) | Devin subscription (the devin CLI's account) | `devin` |
| [factory](packages/factory) | Factory (Droid) subscription | `factory` |
| [grok](packages/grok) | Grok (SuperGrok / X Premium+), through the Grok Build CLI's sign-in | `grok` |
| [kiro](packages/kiro) | Kiro (Free, Pro, Pro+, Power), with Kiro's sign-in, kiro-cli's or the IDE's, or an API key | `kiro` |
| [minimax](packages/minimax) | MiniMax Code (China): account credits and M Plan, with MiniMax Code's device sign-in | `minimax-code` |
| [minimax](packages/minimax) | MiniMax Code (international): account credits and M Plan, with MiniMax Code's device sign-in | `minimax-code-global` |
| [mimo](packages/mimo) | Xiaomi MiMo, with a Xiaomi account | `mimo-app` |
| [qoder](packages/qoder) | Qoder subscription (qoder.com), with Qoder's device sign-in | `qoder` |
| [qoder](packages/qoder) | Qoder CN subscription (qoder.cn), with Qoder CN's device sign-in | `qoder-cn` |
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

```sh
magpie plugin add @magpie-community/middleware-<name>
magpie plugin options <name> '<json>'
```

In the app, they're under Plugins › Discover › Gateway middleware, and each one's **Options** button edits its options in its row.

A middleware package is a folder under `packages/<name>/` with:

- **`package.json`**: name `@magpie-community/middleware-<name>`, `"magpie": {"middleware": "./<name>.middleware.js", "options": {…}}`, no `main`. `options` is the example magpie offers when none are set.
- **`<name>.middleware.js`**: exports `onRequest`, `onEvent` and/or `onResponse` ([the hooks](https://usemagpie.ai/docs/plugins#middleware)). It runs in magpie's gateway on moejs, so it is one file and imports nothing.
- **`cases.json`** and a test that runs them with `check()` from `scripts/middleware.mjs`, which calls the hooks the way the gateway does.

## Agents

These add an agent magpie has no setup of its own for. Once added, the agent is
on magpie's Agents page like the ones magpie ships with: pick one of magpie's
models in its row and magpie writes it into the agent's config, and switching
it off puts the config back.

| Package | Agent |
|---|---|
| [aider](packages/aider) | [Aider](https://aider.chat): `~/.aider.conf.yml`, through litellm's `openai/` prefix |

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
| [magpie-quota](skills/magpie-quota) | Lets an agent check what is left of every subscription, coding plan and key balance magpie has (`magpie quota --json`), and wait for allowance to come back |

In magpie, it is first under Library › Market › Skills. Elsewhere:

```sh
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
    returns `{ outcome, credit?, streak?, message? }`, `outcome` being
    `claimed` (checked in now), `done` (already today), `ineligible`,
    `inactive` (no check-in event now), `captcha` or `failed`; a throw is
    `failed` with its message, and only `failed` is tried again that day.
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
here. A middleware's entry has `"kind": "middleware"` and no `providers`. magpie
fetches it every few hours and keeps a copy built into the app for when
it can't. To list a plugin, add an entry with its npm `package`, a
`name`, `providers` (the provider ids it signs in to), an `icon` and a
`summary` in English and Chinese (`{"en": …, "zh": …}`), and open a pull
request.

A new package's first version is published by hand before its pull request
is merged: npm's trusted publishing, which publishes every later version
from `main`, can't create a package. A magpie-community npm owner runs
`scripts/publish.sh <otp>` on the pull request's branch and sets
`.github/workflows/publish.yml` as the package's Trusted Publisher on
npmjs.com. The pull request's `on-npm` check fails until then.
