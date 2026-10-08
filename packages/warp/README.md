# opencode-warp-auth

Warp (the terminal, warp.dev) AI credits as an OpenCode/magpie provider,
through the Warp app's own sign-in. Provider id: `warp`.

Warp's agent mode speaks its own protocol — a protobuf `Request` POSTed to
`https://app.warp.dev/ai/multi-agent` over **HTTP/2**, answered as SSE whose
`data:` lines are base64 protobuf `ResponseEvent`s — and this plugin answers
OpenAI-style chat completions on it, in OpenCode and in magpie.

## Sign in

- **Use the Warp app's sign-in** reads the account the Warp terminal is
  signed in to, using the stable GUI app's native credential store:
  - **Windows:** DPAPI CurrentUser, from
    `%LOCALAPPDATA%\warp\Warp\data\dev.warp.Warp-User` (with the standard
    home-directory fallback when `LOCALAPPDATA` is unset). PowerShell
    decrypts encrypted bytes supplied on stdin; file contents are hashed
    to cache decryption safely across file replacements and clock changes.
  - **macOS:** the default Keychain's generic password with service
    `dev.warp.Warp-Stable` and account `User`, read using `/usr/bin/security`.
    macOS may ask you to allow access to this item or unlock the keychain.
  - **Linux:** Secret Service attributes `service=dev.warp.Warp`, `key=User`,
    read using `secret-tool` (usually provided by `libsecret-tools`). When
    unavailable, the plugin reads Warp's AES-256-GCM disk fallback at
    `$XDG_STATE_HOME/warp-terminal/dev.warp.Warp-User`, or
    `~/.local/state/warp-terminal/dev.warp.Warp-User` when unset.
  The plugin only reads these stores; it never changes Warp's credentials.
- **Warp refresh token** takes a refresh token pasted by hand, for machines
  without the app or an accessible system credential store. The field in
  Warp's stored account is `id_token.refresh_token`. This method works on
  Windows, macOS and Linux and never follows the local app's account.

The sign-in is Firebase Auth: the id token lasts an hour, and the plugin
refreshes it itself at `securetoken.googleapis.com` (magpie's `auth.refresh`
renews it ahead of expiry too). Google rotates the refresh token on every
exchange; the plugin keeps the rotated one in magpie's store and never
writes back to Warp's store. Chat, usage, models and the refresh hook share
one refresh operation. App sign-in only adopts newer credentials belonging
to the original account, and re-reads the app once after a refused refresh
to recover a concurrent rotation. Switching the app to another account
does not switch this plugin's account. Sign-ins created by older plugin
versions keep using their saved refresh token; sign in again to opt into
following the app. Preview, development and TUI credential namespaces are
not auto-selected.

## Requests

- Chat completions are turned into one multi-agent conversation whose user
  query carries the whole transcript so far as JSON records (system prompt,
  prior turns, tool call IDs/arguments and their results), since Warp's conversation state lives in
  tasks the client is meant to round-trip whole. Every request therefore
  starts a fresh conversation. There is no server-side prompt cache between
  turns; the trade for not rebuilding Warp's client conversation model.
  JSON preserves record boundaries when content contains role markers.
  This remains a text transcript, so native model role isolation is not
  available and untrusted content still requires normal agent safeguards.
- The agent's tools are declared as one MCP server's tools
  (`mcp_context.servers[].tools`, JSON schema as a protobuf Struct) and
  `supported_tools` is pinned to `CALL_MCP_TOOL`, so the only tool calls
  that come back are calls to those tools — Warp's own shell/file tools are
  never run and never asked for.
- Replies stream as SSE `chat.completion.chunk`s: `AppendToMessageContent`
  with mask `agent_output.text` becomes content deltas,
  `AgentReasoning` becomes `reasoning_content`, tool calls arrive whole
  (`CallMCPTool` args as a Struct → JSON).
- A data-URL image in the last user message rides as one of
  `InputContext.images` (the base64 text itself in the bytes field, as
  Warp's own client sends it); images of earlier turns are gone with the
  text.
- The turn's end maps by reason: `done` → `stop` (or `tool_calls`),
  `max_token_limit` → `length`, `quota_limit` → an error with status 429,
  `context_window_exceeded` → 400, `llm_unavailable` → 503, internal errors
  or missing completion events → 502. Errors before any output use HTTP
  status codes; errors after streamed output use an SSE error. Non-streamed
  partial output never hides an error. Usage reports `total_input_tokens`
  when present; overlapping deprecated per-model totals are not added or
  misreported as input tokens.
- OS headers and request context follow the current platform and shell.

## Models

The `config` hook declares a handful of ids (`auto`, `auto-efficient`,
`auto-genius`, …) for the pre-sign-in list. Signed in, `provider.models`
lists the account's own (~120: the `auto` routers plus every
family-and-effort variant) from the `GetWorkspacesMetadataForUser` GraphQL,
with each model's context window and vision support; cached 10 minutes. A
`reasoning_effort` on a family id picks that effort's variant when the
account has it.

## Usage

magpie's card shows the request allowance
(`GetRequestLimitInfo`: used/limit of the period, when it resets —
monthly on the free plan), and any bonus credits left beside it.

## Not included

- Server-side conversation continuation (`Task.messages` round-trip): the
  transcript carries the history instead.
- Warp's own tools (shell, file edits, computer use): never exposed.
- Web search; images in tool results (only the last user message's
  images ride).
- Several accounts. OpenCode keeps one sign-in per provider.

## Install

Once the package is published to npm:

```sh
magpie plugin add @magpie-community/opencode-warp-auth
magpie plugin login warp
```

For OpenCode, add `@magpie-community/opencode-warp-auth` to the `plugin`
array in `opencode.json`, then run `opencode auth login`.

To try a checkout before publication: `magpie plugin add <this folder>`.
Edits on disk are picked up by toggling the plugin off/on (or restarting
the host).
