# @magpie-community/opencode-grok-auth

Grok with a SuperGrok or X Premium+ subscription, through the sign-in of
xAI's [Grok Build CLI](https://x.ai/cli). Provider id: `grok`.

It needs Grok Build installed:

```sh
curl -fsSL https://x.ai/cli/install.sh | bash          # macOS, Linux
irm https://x.ai/cli/install.ps1 | iex                 # Windows
```

## Sign in

- **Sign in with Grok Build (device code)** runs `grok login --device-auth`
  and opens the page it prints. Approve the sign-in there, and the CLI
  finishes it.
  - If the CLI isn't signed in yet, the sign-in goes to the CLI's own home
    (`GROK_HOME`, else `~/.grok`), as if you had run `grok login`.
  - If it is signed in, the sign-in goes to a home of this plugin's,
    `$XDG_CONFIG_HOME/opencode-grok-auth/<random>` (else under
    `~/.config`). Grok Build's own sign-in stays as it is.
- **Use Grok Build's current sign-in** takes the account the CLI is
  signed in to, with nothing to approve.

## Where the sign-in is kept

The CLI keeps the sign-in in its home, as `auth.json`. OpenCode (or
magpie) keeps where that home is, the token and its expiry.

The plugin only reads `auth.json`: the CLI's refresh gives a new token
each time. The plugin runs `grok models` in that home, so the CLI renews
it, then reads it again:

- magpie renews the token 5 minutes before it ends, through the plugin's
  `auth.refresh`, once for the account and before its requests, models
  and usage need it. magpie saves what the CLI gave.
- OpenCode doesn't call that hook: there the token is renewed when it is
  5 minutes from expiring, before a request.
- The CLI runs once for a home at a time: a request or renewal that
  comes while it runs waits for it and reads what it gave. A token the
  CLI already renewed is taken as it is.
- When the CLI no longer holds a sign-in in that home (`grok logout`),
  the account has to be signed in again. When it couldn't renew a token
  that has ended, magpie tries again later.

## Requests

Requests go to `https://cli-chat-proxy.grok.com/v1`, OpenAI's Responses
API (`@ai-sdk/openai`), signed as the CLI signs them:

- `Authorization: Bearer <token>`
- `x-xai-token-auth: xai-grok-cli`
- `x-grok-client-identifier: grok-shell`
- `x-grok-client-mode: headless`
- `x-grok-client-version` and `User-Agent: grok-shell/<version> (<os>; <arch>)`.
  The version is 1.0.41, or the installed CLI's if it is newer.
- `x-grok-model-override`: the request's model.
- `x-grok-conv-id`: the request's `prompt_cache_key`.

The backend turns away some of what a request may carry, so the plugin
leaves these out:

- tools of types it doesn't take (a freeform `apply_patch`, namespaces)
- `external_web_access` on web search
- a `tool_choice` naming a dropped type
- a reasoning item's `"content": null`

Plain Codex collaboration items (`agent_message`) reach Grok as user
messages, with their sender, recipient and content preserved. Sealed or
unrecognized content stays unchanged; the plugin does not decrypt tasks.

## Models

Grok 4.7 until signed in. Signed in, the models are the ones the account
lists at `/v1/models` (Responses models only), each with its context
window and its reasoning efforts as variants.

## Usage

magpie's card shows the credits of the current period
(`/v1/billing?format=credits`): weekly for SuperGrok, with on-demand
spending beside it when it has a cap.

Grok's billing says nothing of a plan's rate limit, so a free account can
read 0% used while its requests come back 429. After a 429 the card shows
a spent "Rate limit" window until the reset it named (`Retry-After`, or a
`*ratelimit*reset*` header). When it named none, the window stays until a
request goes through, or for 5 minutes.
