# @magpie-community/opencode-trae-auth

Two providers, one package: **Trae CN** (trae.cn, ByteDance's AI IDE, provider
id `trae-cn`) and **Trae Global** (trae.ai, the international deployment,
provider id `trae-global`). Each signs in with its own Trae account, the way
the IDE does, and makes its model requests. The free tier works as well.

The two are separate services — different domains, a different client's
catalog, barely overlapping model lists — so they are two providers rather
than a setting. They share one implementation: the request, stream and
tool-call machinery is the same code, and each realm is a table (hosts,
client, versions, usage page, fallback models, error codes) in `index.mjs`.
A fix to that machinery reaches both.

| Provider id | Signs in to | Endpoints |
|---|---|---|
| `trae-cn` | Trae CN (trae.cn) | `api.trae.cn`, `trae-api-cn.mchost.guru` |
| `trae-global` | Trae international (trae.ai) | `growsg-normal.trae.ai`, `coresg-normal.trae.ai` (SG) / `coreva-normal.trae.ai` (US) |

> **Experimental (both).** The CN protocol was worked out from two
> open-source relays, [wangqi233/trae2api](https://github.com/wangqi233/trae2api)
> and [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn),
> and the international one from the same relays' realm table. Neither has
> been run against a real account here: Trae CN has not been tried at all, and
> Trae Global has been tried on one Free account in the SG region only — no
> Pro and no US account. Paid-account behaviour (which models a plan lists,
> what its allowance shows) is implemented from the interface's shape, not
> confirmed on a live one. If something fails, open an issue and include the
> error magpie shows.

## Sign-in

One way per provider, **Trae CN account (browser)** or **Trae Global account
(browser)**. The plugin opens that realm's authorization page
(`www.trae.cn/authorization` or `www.trae.ai/authorization`, the IDE's client
`ono9krqynydwx5`). Sign in there and allow the sign-in; the page then sends the
browser back to a callback on `http://127.0.0.1:<port>/authorize` — it accepts
no other kind of callback. The callback carries the account's Cloud-IDE-JWT,
refresh token and account. Nothing needs pasting back.

An account of one realm does not sign in to the other: trae.cn's accounts are
not trae.ai's.

At sign-in the plugin creates the account's device and names it to the
authorization page: `device_id` (19 digits) and `machine_id` (32 hex). Every
request then sends that same device. The relays saw requests dropped when the
device was new each time.

### The international realm's region

Trae Global has two deployments. The sign-in's `AIRegion` (or a US auth host
such as `api-us-east.trae.ai`) selects the US one; anything else uses the SG
one. The US account's model requests go to `coreva-normal.trae.ai` and its
usage page to `api-us-east.trae.ai`; the SG account uses
`coresg-normal.trae.ai` and `api-sg-central.trae.ai`. Nothing has to be
configured: the region rides in the saved sign-in.

## Requests

Chat completions (`@ai-sdk/openai-compatible`) are translated for the IDE
agent's `POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`:

- **Request:**
  - The messages go as `{role, content: [{type: "text", text}]}`.
  - The model goes as `config_name` and `model`, and as `model_name` the
    `__dev` model the function's list names for it, when it names one.
  - The function is the one whose model list has the model, the first that
    names a `__dev` model for it (in the order `chat_v3`, the classic IDE's;
    `solo_work_lite`, SOLO's Work mode; `solo_agent`, the TRAE agent's;
    `solo_agent_lite`). If Trae answers 4001, 4023 or 1005, the plugin tries
    the others once and remembers which one worked.
- **Headers:** TRAE SOLO CN 0.1.69's (`x-ide-version`/`x-app-version`
  0.1.69, version code 20260917; Trae offers a model only to clients new
  enough for it): `Authorization: Cloud-IDE-JWT …`, `X-Cloudide-Token`,
  `x-app-id`, the device headers and `x-uid`.
- **Answer:** Trae always answers in its own SSE events:
  - `output` gives `response`/`content` and `reasoning_content`/`reasoning`.
    Text under `message`, `delta` or an event with no name is the answer's
    too.
  - `token_usage`, `done` and `error` mark usage, the end and failures.
    `done`'s `finish_reason` `length`/`max_tokens` is OpenAI's `length`.
  - Queue events are ignored.
  - A `{"reasoning_content": …}` object written into the text is reasoning,
    and reasoning Trae sends again is sent once.

  The plugin turns these into an OpenAI stream or a single body. A reply
  that fails (an `error` event, or Trae's stream breaking off) ends with the
  error and `[DONE]`, with no finish.
- **Tools:**
  - Trae's chat has no turn for a tool call or its result, so the tools are
    named twice:
    - natively in `tools`, with `parameters` as a JSON string;
    - in a system prompt that asks for each call as a
      `<tool_call>{"name", "arguments"}</tool_call>` block.
  - GLM also writes its own template, `<tool_call>name<arg_key>k</arg_key>
    <arg_value>v</arg_value></tool_call>` (a string kept as written, other
    types read as JSON), and sometimes a whole call into a native call's
    name; both are read as the call.
  - Calls from either source become OpenAI `tool_calls`. A name matching a
    requested tool but for case or punctuation (`Read`) goes on as the
    request's (`read`); any other goes on as written, so the agent can say
    the tool doesn't exist.
  - Earlier calls and their results go back in as text.
  - Images aren't sent.

The model list is the account's own, from
`/api/ide/v1/batch_get_detail_param`, every function's list in one ask, as
TRAE SOLO CN asks it (`/api/ide/v1/get_detail_param`, one function at a
time, when the batch gives none). The lists are put together: SOLO and the
TRAE agent list models `chat_v3` doesn't (deepseek-v4.1-flash is the TRAE
agent's, `solo_agent`). Left out are the IDE's helpers (`usage` other than
`chat_completion`: summary, fast_apply…), configs switched off and the
custom-model slots. Context is the list's `context_window_tokens.dev`,
output the `__dev` model's `max_tokens`. A model with a `__max` model and
a bigger `context_window_tokens.max` is listed again as its Max,
`<id>-max` ("… (Max)"), with that window and the `__max` model's
`max_tokens`; the two can come from different functions' lists (chat_v3
can name the `__max` model, a SOLO list the windows). It asks the
`__max` model through the function that names it, with `max_tokens` set
and `user_message_context.model_info.prompt_max_tokens` the window less
it, as Max mode does.

Reasoning: the models reason, but Trae's request takes no effort or
thinking level, so the plugin lists no variants and a level an agent
picks does nothing. Every model it lists says so in its `capabilities`
(`reasoning: true`, with `toolcall`, `temperature`, `attachment`, the
input and output modalities and an empty `variants`), the fallback
list's own capabilities kept where it has an entry: magpie reads
`capabilities.reasoning` alone for a model a plugin lists, and a model
without it is shown as one that doesn't reason (0.2.4).

When no
list can be read, the plugin uses the realm's own fallback list. Trae CN's
`chat_v3` is known to serve GLM-5.2, GLM-5, Kimi K2.6, Qwen 3.7 Plus,
DeepSeek V4 Pro and DeepSeek V4 Flash; Trae Global's serves GPT-5.4,
Gemini 3 Flash, Kimi K2.5, MiniMax M2 and DeepSeek V3.2. The live list
replaces either.

## Renewal

Trae CN (since 0.2.3) renews the JWT as its clients do, bound to the
account's device:

- **Where:** `POST api.trae.cn/trae/api/v3/oauth/ExchangeToken`, with the
  refresh token, the device (`DeviceInfo`: its id, machine id and public
  key) and a `DeviceProof`.
- **The device key:** an ECDSA P-256 key pair made for each account at
  sign-in (or at the first renewal of one signed in before 0.2.3), kept
  with the sign-in.
- **The proof:** the key's ECDSA-SHA256 signature (base64) of
  `POST\n/trae/api/v3/oauth/ExchangeToken\n{ClientID}\n{RefreshToken}\n{Timestamp}\n{Nonce}`.
- **As whom:** TRAE SOLO CN (`en1oxy7wnw8j9n`, `SOLO_PC`) first, then
  Trae CN's IDE (`ono9krqynydwx5`, `IDE_PC`).
- **The refresh token:** kept; this renewal doesn't spend it.

A token the sign-in page gives is renewed this way at once. When Trae
turns the device-bound renewal away, the plugin renews as before 0.2.3.

Trae Global, and Trae CN as a fallback, renew at the realm's auth host's
`/cloudide/api/v3/trae/oauth/ExchangeToken` (`api.trae.cn`,
`growsg-normal.trae.ai`). There Trae issues a new refresh token each time
and spends the old one, so only one renewal runs at a time.

magpie renews the JWT ten minutes before it ends (`refreshLead`) through
`auth.refresh`. Each request also checks it, two minutes before the end, for
OpenCode.

The account is marked for a new sign-in in these cases:

- the refresh token is turned away;
- a request is answered 401, or with a code that means the sign-in lapsed:
  1001 for both realms, and 20101 for Trae Global.

Trae signs other clients out of an account when its token is renewed. The
IDE may therefore ask you to sign in again after magpie renews.

## Errors

| Trae's answer | What the agent gets |
| --- | --- |
| 401 / code 1001 (both), 20101 (Global) | 401, and the account is marked for a new sign-in |
| code 4008 / 1005 (quota, plan; both), 4011 (Global) | 429 |
| Anything else | Trae's message and code, as a 502 or Trae's own status |

## Usage

magpie's usage card shows the account's plan and allowance, from whichever
page the realm bills on:

**Trae CN** — the credits page:

- **Source:** `api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`.
- **What it adds up:** each entitlement pack's `credits_limit` (-1 means
  unlimited) and what the pack has used.
- **What it shows:** one Credits window: the credits used of the packs'
  total, with the share, which magpie shows as used or left like
  WorkBuddy's.

**Trae Global** — the dollar billing's entitlements:

- **Source:** `POST api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list`
  (a US account asks `api-us-east.trae.ai`).
- **What it adds up:** the pack's allowance in dollars
  (`basic_usage_limit` plus `bonus_usage_limit`) and what was used of each
  (`basic_usage_amount`, `bonus_usage_amount`).
- **What it shows:** one Dollar Usage window, the dollars used of the
  allowance, resetting when the pack ends.

A 200 carrying an error code is shown as Trae's own message rather than as
an empty answer.

## Daily check-in

Trae CN gives credits for a daily check-in (每日签到); Trae Global has no
such page, so this is CN only. magpie can press it
once a day for each account (Settings, or the switch on the usage card).
It asks Trae CN's own pages through
this plugin's fetch, which sends them as the account, as Trae CN's IDE
(3.3.104) sends them: its Cloud-IDE-JWT (renewed first when near its
end), its device (`x-device-id`, `x-device-brand`, `x-device-type`,
`x-os-version`, `x-app-version`) and a client's User-Agent (TRAE SOLO
CN's Electron shell). Since 0.2.1: Bun's own User-Agent and the chat's
headers got 9074 「当前参与用户太多，请稍后再试」 every time
(yetone/magpie#808). Since 0.2.3 the JWT is also bound to the device (see
Renewal): a JWT renewed at `/cloudide/…` carries no device, and the claim
answered it 9074 even with the client's headers.

- **Status:** `POST api.trae.cn/trae/api/v2/ug/checkin_credits/status`,
  body `{"req_source":1}` (magpie's `{}` is sent as that): `enable`,
  `checked_in`, `credits`.
- **Claim:** `POST api.trae.cn/trae/api/v2/ug/checkin_credits/claim`,
  the same, only while it is on and today's isn't in.
- **What comes back:** Trae's answer as it is. A 401 or code 1001 marks
  the account for a new sign-in. Code 9095 means this device has checked
  in today; nothing sends another device id to get round it, nor to get
  round a 9074.

Only `api.trae.cn`'s `/trae/api/` pages are sent this way; any other URL
that isn't a chat request is still refused (400). Needs 0.1.4 or later.
