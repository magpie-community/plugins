# @magpie-community/opencode-zcode-auth

Signs in to Z.ai's GLM Coding Plan, or BigModel's (智谱). It does this the
way [ZCode](https://zcode.z.ai) does, and serves the plan's GLM models
over Anthropic's Messages API. Provider id: `zcode`.

## Signing in

- **ZCode: Z.ai GLM Coding Plan** and **ZCode: BigModel (智谱) GLM Coding Plan**
  - zcode.z.ai opens a sign-in flow, and the browser signs in to Z.ai or to
    BigModel. The plugin polls the flow until it is done, so there is
    nothing to paste.
  - With that sign-in it takes the key named `zcode-api-key` from the
    account's default project, or makes it if it isn't there, as ZCode does.
    Requests go to `api.z.ai/api/anthropic` or
    `open.bigmodel.cn/api/anthropic`.
  - If the account has no plan of its own, it looks for a seat on a team's
    plan and uses that team project's `zcode-team-api-key`.
  - Failing both, it uses ZCode's free **Start Plan**, served by zcode.z.ai
    with ZCode's session token.
  - zcode.z.ai serves the Start Plan only to requests that look like the
    ZCode client's own, and refuses others with HTTP 405 "request has been
    blocked due to unusual activity". So a Start Plan request goes as
    ZCode's does: ZCode's headers, ZCode's system prompt ahead of the
    agent's, the day in a `<system-reminder>` turn before the agent's
    turns, and the sign-in's device id in `metadata.user_id`. GLM Coding
    Plan and team requests go as the agent sent them.
  - The Start Plan's token can't be refreshed. When it runs out, sign in
    again.
- **ZCode app's sign-in**
  - Uses the account the ZCode app on this computer is signed in to. For
    every request it reads ZCode's own credentials (`~/.zcode/v2`), so it
    follows ZCode as it signs in again, renews its session or switches to a
    team's plan.
- **GLM Coding Plan API key**
  - Paste a key (`<id>.<secret>`) and say which site it is from.

## Where the sign-in is kept

In OpenCode's `auth.json` (magpie: `plugin-auth.json`), under `zcode`:

- **The browser sign-ins** are kept as an `oauth` entry:
  - `access` is the key.
  - `refresh` is JSON holding the site, the endpoint, the key, ZCode's
    token, the team project, the plan and a device id of this plugin's own.
- **A pasted key** is kept as an `api` entry, with the site in `metadata`.

The plugin never writes ZCode's own credential store. It reads it only for
the ZCode app's sign-in (`refresh` then holds `"source": "zcode"`).

## How requests are routed

Before each request, the plugin checks which plan the account is on, and
asks again every 10 minutes:

- If the key's account has a GLM Coding Plan
  (`/api/biz/subscription/list`), requests go to that plan.
- Otherwise they go to the Start Plan.

Every request carries the key as both `x-api-key` and
`Authorization: Bearer`.

## Models

The models are the ones ZCode offers for the account's plan. They come
from ZCode's provider config: the release zcode.z.ai names, or an
installed ZCode's copy if that one is newer. The list is kept for 10
minutes. When the config can't be read, the plugin falls back to this list:

| Model | Context | Output | Efforts |
|---|---|---|---|
| GLM-5.3 | 1M | 128K | low, high, max |
| GLM-5.3-Flash | 1M | 128K | low, high, max |
| GLM-5.2 | 1M | 128K | none, high, max |
| GLM-5-Turbo | 200K | 64K | none, high |

The Start Plan has all of these except GLM-5.3.
