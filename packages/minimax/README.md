# @magpie-community/opencode-minimax-auth

Signs in to MiniMax Code (mcode) accounts so their credits and M Plan can be
used. That covers the free credits and the daily check-in's credits. There is
one provider for each of MiniMax's two sites:

| Provider id | Site | API |
|---|---|---|
| `minimax-code` | MiniMax Code, China (minimax.cn / minimaxi.com) | `https://agent.minimax.cn/mavis/api/v1/llm/v1` |
| `minimax-code-global` | MiniMax Code, international (minimax.io) | `https://agent.minimax.io/mavis/api/v1/llm/v1` |

The package exports `MiniMaxCodeAuthPlugin` (`minimax-code`) and
`MiniMaxCodeGlobalAuthPlugin` (`minimax-code-global`).

## Risk

Read this before you use the package:
- **The credits are for MiniMax's services.** MiniMax gives them for use in
  MiniMax Code, and its terms decide where else they may be used. This
  package uses them from other agents. MiniMax hasn't approved that.
- **The risk to the account is yours.** MiniMax may limit, suspend or close
  an account that uses them this way.
- **This is a community package.** It has nothing to do with MiniMax.

## Signing in

You sign in with MiniMax Code's own device sign-in: the same OAuth device
flow, PKCE S256 and client `mcode-public` that `mcode /login` uses.
- magpie opens MiniMax's page and shows the code to confirm there.
- The plugin then waits for the sign-in and finishes by itself.

MiniMax Code's own sign-in is never read or changed. That is
`~/.minimax/auth/…`, so signing in here doesn't sign `mcode` out.

The sign-in is kept as an OpenCode `oauth` auth:
- what it holds: the access and refresh tokens, their expiry, and the
  MiniMax user id and email;
- OpenCode keeps it in `auth.json`;
- magpie keeps it in `plugin-auth.json`.

Each account signs in on its own, so magpie can hold several and switch
between them.

Refreshing:
- MiniMax spends a refresh token once. Sent a second time it is
  `invalid_grant`, which signs the account out, so the plugin never sends
  one twice.
- magpie renews the token ten minutes before it ends, through the plugin's
  `auth.refresh`, once for the account and before its requests, models and
  usage need it. OpenCode doesn't call that hook: there the access token is
  refreshed two minutes before it ends, before a request. Either way the
  new token is saved.
- When MiniMax turns the token away (HTTP 401), the request goes again with
  a newer token if one was saved meanwhile, else after a refresh.
- Only one refresh runs at a time for an account. Requests that arrive
  meanwhile wait for it and use its token. When saving the new token
  fails, the plugin keeps it in memory and goes on with it, rather than
  with the spent one on disk.
- A refresh token someone else spent first (another magpie process) isn't a
  sign-out when the new one they saved is there: that one is used.
- The account counts as signed out only when MiniMax answers the refresh
  with `invalid_grant` (HTTP 400). Any other failure keeps the sign-in, and
  the current token is used while it lasts.

## Generation and media tools in Magpie

The same plugin also exports `MiniMaxCodeToolsPlugin`. Magpie serves its tools
through the Library's MiniMax MCP server and `/mcp/magpie/tools`. Connect
that server to your agent to use the tools with any of its chat models.

| Tools | What they do |
|---|---|
| `web_search` | Native web/news/video/place/shopping search |
| `generate_image` | Text-to-image and image editing from reference URLs |
| `submit_video_generation`, `query_video_generation` | Submit H3, H3 Max or Hailuo video tasks, then check their progress |
| `synthesize_speech`, `batch_text_to_audio`, `get_voice_list` | Speech synthesis and voice selection |
| `batch_text_to_music` | Music and song generation |
| `describe_images`, `videos_understand`, `audios_understand`, `listen_audio` | Image, video and audio understanding, and transcription |
| `search_images`, `reverse_image_search` | Find image references |
| `enhance_image`, `remove_image_background` | Upscale images and remove backgrounds |
| `get_asset_url` | Get a fresh download URL for a generated asset's `node_id` |
| `list_tools`, `tool_schema`, `call_tool` | Discover and call the account's current Matrix tools and read their live schemas |

On the combined MCP server these are named `minimax_generate_image`,
`minimax_submit_video_generation`, and so on. In the Library's routed server,
the separator is `minimax__generate_image`.

Webpage reading is available through Magpie's search MCP server, whose
`web_fetch` protects loopback and private network addresses.

Account-backed tools accept `site`: `minimax-code` (China, the default) or
`minimax-code-global`. These tools read the chosen site's default account
from Magpie's `plugin-auth.json` on each call: the one stored under the bare
site id, else the first `site#…` key by name, as Magpie picks for a request
that names no account. To choose a particular account,
set `account` to its full stored key, such as `minimax-code#xxxxxx`. The
selected account's tokens are renewed by the same refresh logic as chat.
A missing account asks you to sign in; the selected account stays fixed
during a call and its authentication retry.

Tool requests use the same redirect handling as chat: redirects within
the same host are followed, while a redirect to another host returns a
site/proxy hint and preserves the account's refresh token.

The gateway status (`base_resp.status_code`) and the tool payload status
(`code`) are checked independently. A successful gateway response can
still carry a plan-limit error from the tool, even when the account has
credits available; that error is returned to the caller.

Inputs use HTTPS media URLs. Upload local reference files to a reachable
URL before passing them. Generated results include `node_id` and
`file_name`; pass the node id to `get_asset_url` and download the returned
URL. A URL can expire while its asset is still available: ask for a fresh
URL with the same node id.

Video generation is asynchronous: keep the returned task id and model,
then pass both to `query_video_generation`. Generation uses the selected
account's plan or credits according to MiniMax's billing. Choose the model
and parameters before submitting. Transport failures are reported so the
caller can check the outcome before deciding whether to submit again.

The tool definitions ship with the package; each execution also resolves
the tool against the selected account's live catalog. Availability and
provider failures come from that catalog. Use `tool_schema` and
`call_tool` when a newly added Matrix capability needs its current
parameters. Connector calls honor the host's cancellation signal. Magpie
currently limits an MCP tool call to 55 seconds, so a long synchronous
image or audio request may outlast that limit; video uses separate
submission and query calls.

Magpie loads `magpie.mjs` through `exports["./server"]` to expose these
tools with its account store. OpenCode 1.x loads `opencode.mjs`, and
OpenCode 2.x loads the shared adapter. Both OpenCode entry points expose
the two chat providers.

## Requests

Chats are Anthropic messages (`@ai-sdk/anthropic`) sent to
`<API>/messages`. Each one carries MiniMax Code's headers:
- `Authorization: Bearer <access token>`;
- `x-api-key: sk-xxx`, the placeholder key MiniMax Code gives its SDK;
- `User-Agent: MiniMaxAgent`;
- `X-Mavis-Agent-Id: main`;
- `X-Mavis-Timezone-Offset`;
- `X-Mavis-Session-Id`. This is the conversation's id when magpie or
  OpenCode passes one, and a fixed id for the plugin's run otherwise.

A refusal that says the credits or quota ran out goes on as a 429. The 402,
403 or 429 statuses count, when the body says so. That way magpie can move
the conversation to another account.

## The international site from mainland China

`minimax-code-global` needs a network outside mainland China. From a
mainland-China network, MiniMax's edge answers `agent.minimax.io` with a
307 to `agent.minimaxi.com`, the China site, which doesn't take the
international site's sign-in (the two sites' tokens don't work on each
other's hosts). The plugin doesn't follow a redirect to another host: the
usage card, the check-in, the chats (a 502) and the sign-in say where the
request was sent and to set a proxy outside mainland China for the
provider. No refresh token is spent on it, and the sign-in is kept. The
China site (`minimax-code`) is unaffected.

## The China site's account host

The China site's account API (the usage card, the check-in, the account
and its membership) is on `agent.minimaxi.com`, and `agent.minimax.cn`
serves the same API with the same sign-in. A call `agent.minimaxi.com`
gives no HTTP answer to (a TLS error such as "unable to get issuer
certificate", a refused or reset connection) is sent once to
`agent.minimax.cn`. Any answer from `agent.minimaxi.com` — a 401, another
status, an error in the body, a redirect — and a timeout are kept as they
are, never sent again. When both hosts can't be reached, the error names
both and why.

## Models

When you are signed in, the models come from MiniMax Code's live model
config (`GET /mavis/api/v1/models`). The list includes each model's context,
image input and thinking options. If the live list doesn't answer, this
built-in list is used instead:

| Model | Context | Output | Images | Reasoning levels (variants) |
|---|---|---|---|---|
| MiniMax-M3.1-Flash-Preview | 1M | 512K | yes | low, medium, high, xhigh, max |
| MiniMax-M3 | 1M | 512K | yes | none, high |
| MiniMax-M2.7 | 200K | 128K | no | — (always thinks) |
| MiniMax-M2.7-highspeed | 200K | 128K | no | — (always thinks) |

MiniMax Code's own list reports 512K/128K for the M3 family, but the
endpoint accepts 1,048,576 input tokens and 524,288 output tokens for
every one of them, so those are the limits given here. An agent that
believed the advertised ones would compact its history about half way too
early.

Variants map to what MiniMax Code sends:
- a level is adaptive thinking at that effort, which becomes
  `output_config.effort`;
- `none` turns thinking off.

## Usage

The usage card shows:
- the credits left;
- a Credits window: how much of the credits not yet expired is used, and
  when the soonest of them runs out, from the credit details MiniMax's own
  client lists (`/minimax-cloud/api/v1/credit/details`); beside an M Plan
  it is aside, since the plan's windows come first;
- the plan: Free, or the subscription's name as the console says it (else
  its tier) and when it ends; none when the
  site has no membership API (the international site answers both of its
  calls with 404), and the card goes on with the credits;
- for a plan, its windows (5 hours, 7 days, and any model's own) from the
  console's `token_plan/remains_percent`, so what MiniMax granted the account
  is what shows: `126 / 150 %` left for its `总额度 150% · 已用 24%`, and
  Unlimited for a window it doesn't limit. `coding_plan/remains` is the
  fallback.

These are read the way MiniMax Code reads them, with its signed account API.

## Check-in

The account's daily check-in (每日签到) is claimed through the same sign-in:
the plugin reads the panel (`/minimax-cloud/api/v1/signin/status`) and
claims the day's credits (`/minimax-cloud/api/v1/signin/claim`) with the
same signed account API, asked as MiniMax Code's own `/checkin` asks them:
as the account (its MiniMax user id, looked up first when the sign-in
didn't keep it), from the desktop client, on MiniMax Code's own hosts
(agent.minimax.io, agent.minimaxi.com). A check-in turned away with 401 is
renewed and asked once more, with the user id read again, as MiniMax Code
does. magpie can run it once a day per account, when its
MiniMax check-in switch is on; Settings → Usage → Plugins has that switch
and a *Check in now* button, and the outcome — claimed, done, inactive,
ineligible, with the streak — lands on the account's Usage card.
OpenCode doesn't call this hook: there, check in from MiniMax Code or
MiniMax's site.

## Not here

- **No sign-out.** Signing out doesn't revoke the token on MiniMax's side.
