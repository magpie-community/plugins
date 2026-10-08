# @magpie-community/opencode-qoder-auth

Your [Qoder](https://qoder.com) subscription in OpenCode and
[magpie](https://usemagpie.ai). The package serves Qoder's two sites, whose
accounts exist only on their own:

| Provider id | Site | Accounts | Plugin export |
|---|---|---|---|
| `qoder` | qoder.com (international) | Google, GitHub or email | `QoderAuthPlugin` |
| `qoder-cn` | qoder.cn ([Qoder CN](#qoder-cn)) | Alibaba Cloud or phone number | `QoderCNAuthPlugin` |

What follows is about `qoder`. Qoder CN works the same way on its own
hosts; [its section](#qoder-cn) says what differs.

## Sign-in

**Sign in with Qoder** is the sign-in Qoder's desktop client uses:

1. A PKCE device flow opens qoder.com's account page.
2. openapi.qoder.sh is polled every 2 s until you authorize, for at most
   15 minutes.
3. The device token is traded for a job token, and the account's email and
   name are read.

What is kept: the job token, its refresh token and expiry, the uid, the
device token and a machine id made for this sign-in. OpenCode keeps them in
`auth.json`; magpie keeps them in `plugin-auth.json`.

Refreshing:
- Qoder spends a refresh token once, so the plugin never sends one twice.
- magpie renews the job token 10 minutes before it runs out, through the
  plugin's `auth.refresh`, once for the account and before its requests,
  models and usage need it; magpie saves the new pair. OpenCode doesn't
  call that hook: there the job token is refreshed 5 minutes before it runs
  out, before a request, and the new pair is saved straight away.
- Only one refresh runs at a time. A request that reads the sign-in before
  magpie saved a renewal uses the renewed pair, and a renewal handed a pair
  a request already spent gives what that request got.
- The device token, which reads usage, has no end on record: it is rotated
  when Qoder refuses it. On a [Qoder CN](#qoder-cn) device-token account it
  is the chat token too, and is renewed as above.
- When Qoder refuses a refresh (401 or 403), the account needs signing in
  again. Any other failure is tried again later.

## Requests

Qoder serves its models on the API its client talks to:
`api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`. The
plugin's `fetch` takes the chat completion OpenCode sends and does the rest
itself.

**Writing the request**

- It writes the chat completion as Qoder's request:
  - Qoder's own system line comes before yours.
  - Messages become text and image blocks.
  - Tool calls and results become OpenAI tool turns. Images a tool returned
    follow in a user turn.
  - Your tools become Qoder's native function tools.
  - The model's own configuration from Qoder's list goes with it.
- It picks the reasoning effort from the model's own levels:
  - The nearest level to the one asked, the higher one on a tie.
  - The model's default when none is asked.
  - The lowest level for "none", when the model can't turn thinking off.
- It picks the context window (`context_length`) from the model's own
  windows (Qoder's Context setting: 200K, 400K, 1M): the default while the
  request fits it, else the smallest that holds it, else the largest. A
  larger window may cost more, so it is asked for only when needed.
- It encodes the body with the client's codec and signs the call with the
  client's COSY envelope. The envelope carries:
  - the account, AES-encrypted, with the key wrapped by Qoder's RSA key;
  - an MD5 signature;
  - the machine id and the client's headers.

**Reading the reply**

- Qoder's SSE comes back as a chat completion, streamed or not, with
  reasoning and usage.
- Tool calls Qoder writes as XML or JSON in its text become tool calls.
  Tool calls it sends the OpenAI way keep Qoder's id.

**Errors**

| What Qoder says | What the request returns |
|---|---|
| A refused sign-in | 401 |
| A quota | 429 |
| A failure before the answer starts | Qoder's status |
| A failure after the answer has started | The stream ends with an error |

## Models

The `provider.models` hook reads the account's own list, as Qoder's client
asks for it (`/algo/api/v2/model/list`). It keeps the enabled chat models
and leaves out "auto" and "default", which route inside Qoder. It takes
each model's reasoning levels from its `thinking_config`, and its context
from its `context_config`: the largest window it offers (Qoder's docs
give Qwen3.8-Flash 200K, 400K and 1M), not `max_input_tokens` (180K
there), which is only what a request naming no window gets. A model listed
with no windows keeps `max_input_tokens`.

The `config` hook declares the list as it was on 2026-09-30:

- Ultimate, Performance, Efficient
- Sonus, Cantus
- Qwen3.8-Max, Qwen3.8-Flash, Qwen3.7-Max, Qwen3.7-Plus
- Kimi-K3, Kimi-K2.8-Preview
- GLM-5.3, GLM-5.3-Flash
- DeepSeek-V4-Pro, DeepSeek-Flash
- MiniMax-M3

Every model speaks chat completions (`@ai-sdk/openai-compatible`).

## Qoder CN

`qoder-cn` is for accounts on [qoder.cn](https://qoder.cn), the China site.
Those accounts sign in with Alibaba Cloud or a phone number and can't sign
in through `qoder`. Qoder CN speaks the same protocol as qoder.com:

- the same device flow, poll, job token and refresh paths;
- the same COSY envelope and body codec;
- the same model list, chat and usage paths.

Only the hosts and the sign-in's client id differ. The plugin uses the ones
Qoder CN's own CLI builds in for its `cn` build (`@qodercn-ai/qoderclicn`
1.1.65):

| | `qoder` | `qoder-cn` |
|---|---|---|
| Sign-in page | qoder.com | qoder.cn |
| Accounts: poll, tokens, user info, usage | openapi.qoder.sh | openapi.qoder.com.cn |
| Models and chat | api3.qoder.sh | gateway.qoder.com.cn |
| Device-flow client id | Qoder's desktop client's | Qoder CN's CLI's (production) |
| `redirect_uri` on the sign-in page | `qoder-app://` | none, as the CLI sends |

Qoder CN's CLI chats with the device token itself and never makes a job
token. The plugin asks qoder.cn for a job token first, as it does on
qoder.com. If qoder.cn refuses it (a 4xx), the account works the way the
CLI does:

- the device token signs the model calls;
- it is renewed with `/api/v1/deviceToken/refresh`, the chat and account
  tokens being one pair;
- a refused renewal (401 or 403) means signing in again.

Until you sign in, the `config` hook declares the tiers Qoder CN's CLI names
(Ultimate, Performance, Efficient, Lite). Once you are signed in, the
account's own list from gateway.qoder.com.cn replaces them.

Neither magpie's built-in Qoder CN nor this plugin has been checked against
every kind of qoder.cn account. If a sign-in or a chat fails, please open
an issue with the error.

### Enterprise VPC

A Qoder CN enterprise on its own VPC instance signs in with **Sign in with
Qoder CN Enterprise (VPC)** (since 0.2.8). It asks for the instance: its
name (`acme`) or one of its addresses (`acme.vpc.qoder.com.cn`,
`https://acme.vpc.qoder.com.cn`). Only https and hosts under
`vpc.qoder.com.cn` are taken.

The account then uses the instance's own hosts, as Qoder CN's CLI
(`@qodercn-ai/qoderclicn` 1.1.64) does once a VPC instance is set. The
paths, client id and protocol are the public ones:

| | Public Qoder CN | VPC instance `acme` |
|---|---|---|
| Sign-in page | qoder.cn | acme.vpc.qoder.com.cn |
| Accounts: poll, tokens, user info, usage | openapi.qoder.com.cn | acme-openapi.vpc.qoder.com.cn |
| Models and chat | gateway.qoder.com.cn | acme-gateway.vpc.qoder.com.cn |

- The instance is kept with the account, so its refreshes, models, usage
  and check-in go to the instance too. An account kept with an instance
  that isn't one is asked to sign in again; it is never sent to the public
  hosts.
- The account is named `<email> (<instance>)`, so it is listed apart from
  the same person's public account.
- An enterprise's usage shows as the Enterprise plan.
- **Sign in with Qoder CN** is unchanged and still the first way. An
  account signed in without an instance works as before.

The hosts and reply shapes come from a real VPC account's report
(yetone/magpie#312). This plugin has not been tried with a VPC account.

## Daily check-in

Qoder gives credits for a daily claim (the Qoder client's campaign
`CLAIM_BENEFIT`, 100 Credits a day as reported), on both sites. magpie can
claim it for each account when its Qoder check-in switch is on
(Settings). It asks these pages through this plugin's fetch (since 0.2.7),
which sends them as the account, on the device token (`Bearer`,
`Cosy-ClientType: 10`) as usage is read; a refused device token is
rotated once and the page asked again.

International campaigns also need Qoder's native device identity:
`Cosy-MachineToken` and `Cosy-MachineType`. Without them, the server can
return HTTP 200 but omit the daily claim. The plugin reads them from
Qoder's own `runtime-info` helper for the signed-in uid, sharing an
in-flight read and caching it in memory for an hour. The same identity
goes on the list, the claim and a device-token retry; it is not saved in
the account's credentials.

- Install Qoder desktop or run Qoder CLI to make its native runtime
  available. The plugin finds the desktop's standard Windows/macOS
  location or the CLI's matching `~/.qoder/.bin/umid-*` cache.
- For another installation location, set `QODER_RUNTIME_INFO` to the
  absolute path of Qoder's installed `runtime-info` executable
  (`runtime-info.exe` on Windows), with its accompanying SDK files.
- A missing helper or invalid identity is an error, rather than a false
  "no activity" result. Qoder CN keeps its existing requests and does
  not need this local helper.

- **List:** `GET <openapi>/sash/api/v1/me/campaigns`: `campaigns[]` with
  `campaignId`, `actionType`, `claimStatus` (`CLAIMABLE`, `CLAIMED`),
  `startAt`, `endAt`, `benefit.amount`.
- **Claim:** `POST <openapi>/sash/api/v1/me/campaigns/{id}/claim`, body
  `{}`: `status` `CLAIMED` (or under `data`).
- `<openapi>` is `openapi.qoder.sh` (Qoder) or `openapi.qoder.com.cn`
  (Qoder CN). Other pages on those hosts are still refused.

Taken from [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin),
which a user reports works, and Qoder desktop 0.4.3's campaign requests.
International campaign discovery was checked with a real account on
2026-10-08: the native identity exposed the claimable 100 credits, and
omitting either header hid them. This verification only queried the
activity; a live claim was not performed.

## Not here

- Qoder's usage and quota display.
- Several accounts at once.
- magpie's web-search stand-in.

## Credits

The protocol (endpoints, COSY envelope, body codec and device flow) comes
from [CLIProxyAPI](https://github.com/ufec/CLIProxyAPI)'s Qoder support, by
way of magpie. Its MIT license is in `LICENSE-CLIProxyAPI`.
