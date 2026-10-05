# magpie-community plugins

[OpenCode](https://opencode.ai) provider plugins for coding-plan
subscriptions, maintained by the community. Each package signs in to one
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

`registry.json` is the list magpie's Plugins tab shows. The packages here
come first, then other OpenCode provider plugins worth knowing. magpie
fetches it every few hours and keeps a copy built into the app for when
it can't. To list a plugin, add an entry with its npm `package`, a
`name`, `providers` (the provider ids it signs in to), an `icon` and a
`summary` in English and Chinese (`{"en": …, "zh": …}`), and open a pull
request.
