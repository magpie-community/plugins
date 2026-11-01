# @magpie-community/opencode-kiro-auth

Signs in to a [Kiro](https://kiro.dev) subscription (Free, Pro, Pro+,
Power) and makes its requests, in OpenCode and in magpie. Provider id:
`kiro`.

## Signing in

Choose a sign-in method before opening the browser:

- **AWS Builder ID** opens AWS directly for a personal account.
- **IAM Identity Center (organization Start URL)** asks for the organization's
  HTTPS Start URL and AWS region (blank defaults to `us-east-1`), then opens
  that organization's AWS sign-in directly. Use the region of the directory.
- **Kiro sign-in page** retains the portal for Google, GitHub and other Kiro
  sign-in methods. Callers without prompt inputs retain this behavior.

The two direct AWS options skip the portal's first loopback callback. When
Magpie runs remotely or in Docker, sign in and authorize, then paste the
complete final `http://127.0.0.1:<port>/oauth/callback?...` address into Magpie's
Callback URL field. The page need not load on the browser's computer. Local
browsers that can reach the plugin's listener finish automatically. Direct
AWS sign-in still uses authorization code + PKCE, not device authorization.


- **Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)**: the Kiro
  IDE's own sign-in.
  - Kiro's page (`app.kiro.dev/signin`) sends the browser back to one of
    the ports the IDE listens on (3128, 4649, 6588, 8008, 9091, 49153,
    50153–53153) on `127.0.0.1`. While the IDE is signing in, those ports
    may be busy.
  - Google and GitHub come back with a code. Kiro's auth service trades it
    for tokens.
  - Builder ID and Identity Center come back with an AWS sign-in URL and
    region. The plugin registers a client with AWS's OIDC service, sends
    the browser to AWS, and trades the code AWS returns.
  - The account is named by the email Kiro has for it (`Get-Usage-Limits`)
    and the way it was signed in to: `email (Google)`, `email (GitHub)`,
    `email (Builder ID)`, `email (IAM Identity Center)`, `email
    (Internal)`. Its plan is read from the same call, and its usage names
    it the same way.
  - Kiro keeps a Google, a GitHub, a Builder ID and an Identity Center
    sign-in of one email as different accounts. The sign-in carries a `uid`
    (`google`, `github`, `builderid`, `enterprise`), so magpie keeps each one
    beside the others, and a sign-in again the same way replaces only its
    own account. An account signed in before 0.1.13 is given its `uid`,
    and one named by its bare email before 0.1.14 its name, on its first
    request, model listing, usage read or renewal. Until then, a sign-in
    again the same way goes beside it rather than replacing it: magpie
    matches a sign-in by its name, and the plugin can't see the other
    accounts to match it by `uid`.
  - A company's own identity provider (`external_idp`) is not supported
    here. Sign in with `kiro-cli login` and use the next method instead.
- **Kiro CLI's or Kiro IDE's sign-in**: uses the account kiro-cli is signed
  in to, or else the Kiro IDE's. Nothing is copied. It is read each time
  from where they keep it:
  - kiro-cli: its SQLite database's `auth_kv` table.
    - macOS: `~/Library/Application Support/kiro-cli/data.sqlite3`
    - Linux: `~/.local/share/kiro-cli/data.sqlite3`
    - Windows: `%APPDATA%\kiro-cli\data.sqlite3`
  - The IDE: `~/.aws/sso/cache/kiro-auth-token.json`.

  kiro-cli refreshes its own token first (`kiro-cli debug refresh-auth-token`).
  A token the plugin refreshes itself is written back, so kiro-cli and the
  IDE go on with it.
- **Kiro API key (`ksk_…`)**: sent with `tokentype: API_KEY`, as kiro-cli
  sends it. `GetProfile` is asked in us-east-1, then eu-central-1, for the
  region the key's profile is in; a key it finds none for is used in
  us-east-1, as kiro-cli uses it. Its models are listed with the control
  plane's `ListAvailableModels` and its credits with `GetUsageLimits`, and
  no profile is named in its calls, as kiro-cli names none.

A browser sign-in is kept where OpenCode keeps sign-ins (`auth.json`; in
magpie, `plugin-auth.json`) as an `oauth` entry. The entry holds the
tokens, the profile ARN, the region and, for AWS, the registered client.
Refreshing such a sign-in:

- magpie renews the token 10 minutes before it expires, through the
  plugin's `auth.refresh`, once for the account and before its requests,
  models and usage need it. magpie saves the new token. A failed renewal,
  even one Kiro refused, doesn't mark the account: it is tried again.
  The usage read does: a sign-in Kiro refused there marks the account
  signed out (`signIn: "expired"`), so magpie passes over it and offers
  Sign in again on its row, and a clean read takes the mark off.
- OpenCode doesn't call that hook: there the token is refreshed 2 minutes
  before it expires, before a request, and saved.
- Either way, a token Kiro turns down (a 403) is refreshed and the request
  tried once more.
- Only one refresh runs at a time, magpie's renewal included, and a token
  refreshed but not yet saved is used rather than spending the old refresh
  token again.
- kiro-cli's and the IDE's sign-ins aren't renewed by magpie: they are
  refreshed before a request, as above, and written back.

Tokens are refreshed through:

- Google/GitHub: through `prod.<region>.auth.desktop.kiro.dev/refreshToken`.
- Builder ID/Identity Center: through AWS's `oidc.<region>.amazonaws.com/token`.

## Requests

Kiro has no API OpenCode speaks. The models are declared on Anthropic's
Messages (`@ai-sdk/anthropic`), and the plugin's `fetch` handles each
request:

- It sends the request to `runtime.<region>.kiro.dev/generateAssistantResponse`,
  the API kiro-cli uses, with kiro-cli's headers. The region is the one the
  profile ARN names.
- It turns the request into a Kiro conversation:
  - The system prompt goes at the head of the first message.
  - System messages that end the conversation (Claude Code's environment
    context) are sent as a turn before the question, answered by Kiro IDE's
    "Understood.", so the question is the message answered (#538). After
    tool results they stay with them.
  - Tool calls and results are paired: an unanswered call gets an error
    result, and a result longer than 250,000 characters is cut.
  - Tool ids Kiro wouldn't take are rewritten. A tool name over 64
    characters (an MCP plugin's, in Claude Code) is sent shortened with a
    hash and its calls come back under the full name.
  - A tool's images (a screenshot, Codex's view_image) go with the
    message that answers the call, as Kiro's tool results hold text alone.
  - Only the latest images are sent.
  - An image Kiro would turn away for size (over 5 MiB as Base64, which is
    3.75 MiB of file) is made smaller on the request being sent: its long
    edge brought to 2000 pixels, then WebP or JPEG, smaller each try. One
    that can't be read or brought under is replaced by a short note, so the
    conversation goes on (#428). Smaller images are sent as they are.
  - Tools the history used but the request doesn't offer are declared.
  - A tool's input schema says `type: "object"` at its root, as Kiro
    wants: one that says no type (or object-or-null) is sent saying so, and
    an empty one as an object with no properties. Kiro answers 400
    `REQUEST_BODY_INVALID` to either. Everything under the root (a union
    there, properties, `$ref`s, `nullable`) is sent as given, and a root
    that names another type is left alone.
- It turns the AWS event stream Kiro answers with back into Messages'
  events (streamed) or one message. The reply includes text, thinking,
  tool calls and usage. When Kiro reports only how full the context is,
  input tokens are estimated from that.
- Thinking (Claude models and Auto) is asked for the way kiro-cli asks, in
  the prompt, with a budget: low 10k, medium 20k, high 30k, xhigh and max
  50k (as magpie's built-in Kiro: #120). The
  `<thinking>` block of the reply comes back as thinking.
  A model whose Kiro catalog lists effort levels with adaptive thinking
  (`additionalModelRequestFieldsSchema`) is sent the level instead, as Kiro
  IDE sends it: `additionalModelRequestFields` with `thinking.type:
  "adaptive"` and `output_config.effort` (or `reasoning.effort`), and no
  budget. So xhigh and max stay apart there (#538).
  Thinking is asked for only when the request's `thinking` is `enabled` or
  `adaptive`. An effort with no `thinking`, or with it `disabled` (Claude
  Code's title requests, or a turn with thinking off), is sent with no
  thinking at any level.
- Anthropic's hosted web search is answered with Kiro's own web search
  (see [Web search](#web-search)).
- Kiro's failures keep their meaning:
  - input too long → 400 "input is too long for the model's context", whether
    Kiro says it as an HTTP answer, as an exception in the stream, or by
    stopping with `MODEL_CONTEXT_WINDOW_EXCEEDED` before a word (after some
    of the reply, it ends with stop reason `model_context_window_exceeded`)
  - no capacity → 503
  - usage limit → 429
  - throttling → "rate limited"

## Web search

A request offering Anthropic's hosted web search,
`{"type": "web_search_20250305", "name": "web_search", "max_uses": n}`, is
searched with Kiro's own web search, sent as kiro-cli (2.35) sends it:

- The model is offered kiro-cli's `web_search` tool as kiro-cli's agent
  offers it: its description, a `query` (200 characters at most) and the
  `__tool_use_purpose` kiro-cli adds to each tool. A call the model makes to
  it is searched here, never passed to the caller as a `tool_use`. Its
  `__tool_use_purpose` is kiro-cli's alone: it isn't searched for, and the
  caller's `server_tool_use` has the `query` only.
- The search is Kiro's runtime's `InvokeMCP` operation:
  `POST runtime.<region>.kiro.dev/`, `Content-Type:
  application/x-amz-json-1.0`, `x-amz-target:
  AmazonCodeWhispererStreamingService.InvokeMCP`, in the account's region
  with its token. Its body is a JSON-RPC `tools/call` of `web_search` with
  `{query}` and nothing else, and the profile as `profileArn` beside it:
  over AWS JSON 1.0 that member is sent in the body, and without it there
  Kiro answers 400 `profileArn is required for this request`. It goes in
  `x-amzn-kiro-profile-arn` too, as kiro-cli 2.35 sends it. An API key,
  sent as `tokentype: API_KEY`, names no profile in either, as kiro-cli
  names none for one. The answer is
  `{jsonrpc, id, result, error}`, the result being the `tools/call`'s.
- The pages found go back to the model as the call's result (title, URL,
  date, snippet), and it is asked again. The caller is answered as
  Anthropic answers: `server_tool_use` and `web_search_tool_result` blocks
  (streamed or not), then the answer, and `usage.server_tool_use.web_search_requests`.
- Each result has the page's `title`, `url` and `page_age`. `encrypted_content`
  is `""`: Kiro has no sealed copy of the page, and none is made up (as
  magpie's own search answers). The answer cites its pages by URL in its
  text; it has no `citations`, which need Anthropic's encrypted index.
- `max_uses` is kept, and no request searches more than 10 times. A search
  past it is a `max_uses_exceeded` error; a model still searching after
  `max_uses` + 2 turns is stopped with `pause_turn`. A `max_uses` that isn't
  a whole number of at least 1 is a 400.
- `allowed_domains` or `blocked_domains` filter the pages Kiro's search
  returns; the search itself isn't told them, so fewer pages may come back.
  A domain takes in its subdomains; with a path (`example.com/Docs`), only
  pages under it, the host matched in any case and the path as written.
  Both at once, or `user_location`, which Kiro's search has no place for,
  is a 400.
- A search that fails (Kiro unreachable, an error, an answer it can't
  read, a query over 200 characters) is a `web_search_tool_result_error`,
  and the model is told why. A token Kiro's search turns down (403) is
  refreshed once, as a request's is. A cancelled request stops searching.
- Kiro failing on a turn after a search is an error: streamed, an `error`
  event after the blocks said; not streamed, the failure's status, not a
  200 holding only the searches.
- A turn that also calls the caller's own tools ends there (`tool_use`),
  with its searches. The conversation sent back, with its
  `server_tool_use` and `web_search_tool_result` blocks, gives the model
  each search's call and result again. A tool of the caller's named
  `web_search` (no hosted `type`) stays the caller's.
- Other hosted tools are not sent, as before.

### Supported scope

Only `web_search_20250305` named `web_search` is searched (Claude Code sends
it). Any other tool whose type begins `web_search` (a newer version such as
`web_search_20260209`, another name, the same tool twice) is a 400 before
Kiro is asked: with `searches: true` magpie hands every such tool to the
plugin rather than searching for it, so dropping it would leave the search
asked for undone. A client that sends a newer version needs
`provider.kiro.searches: false`, so magpie's own search serves it as it did
before; the 400 says so.

The `config` hook says `searches: true` on the provider, so magpie passes a
client's web search (Claude Code's WebSearch) on to Kiro as sent rather than
searching for it. Set `provider.kiro.searches` to `false` to have magpie's
own search used instead.

## Models

The `config` hook declares `auto` (Kiro picks the model). Once signed in,
the `provider.models` hook replaces it with the account's own list from
`List-Available-Models`, with the default first. Each model carries its
context window, output limit and whether it takes images. Claude models
and Auto have the thinking variants.

## Not included

- Usage and quota (credits, the monthly window).
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- Signing in with a company's own identity provider in the browser (use
  kiro-cli's sign-in).
