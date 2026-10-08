# opencode-warp-auth

Warp (the terminal, warp.dev) AI credits as an OpenCode/magpie provider,
through the Warp app's own sign-in. Provider id: `warp`.

Warp's agent mode speaks its own protocol — a protobuf `Request` POSTed to
`https://app.warp.dev/ai/multi-agent` over **HTTP/2**, answered as SSE whose
`data:` lines are base64 protobuf `ResponseEvent`s — and this plugin answers
OpenAI-style chat completions on it, in OpenCode and in magpie.

## Sign in

- **Use the Warp app's sign-in** reads the account the Warp terminal is
  signed in to. On Windows, Warp keeps it DPAPI-encrypted in
  `%LOCALAPPDATA%\warp\Warp\data\dev.warp.Warp-User`; the plugin only ever
  reads that file (the decrypt is cached by the file's mtime, so the
  PowerShell it shells out to runs about once an hour, not per request).
- **Warp refresh token** takes a refresh token pasted by hand, for machines
  without the app. Get it from the file above (field
  `id_token.refresh_token`) or from any place Warp's sign-in is kept.

The sign-in is Firebase Auth: the id token lasts an hour, and the plugin
refreshes it itself at `securetoken.googleapis.com` (magpie's `auth.refresh`
renews it ahead of expiry too). Google rotates the refresh token on every
exchange; the plugin keeps the rotated one in magpie's store and never
writes back to Warp's file. When the Warp app runs beside this, whichever
refreshed last wins on the next read.

## Requests

- Chat completions are turned into one multi-agent conversation whose user
  query carries the whole transcript so far (system prompt, prior turns,
  tool calls and their results), since Warp's conversation state lives in
  tasks the client is meant to round-trip whole. Every request therefore
  starts a fresh conversation. There is no server-side prompt cache between
  turns; the trade for not rebuilding Warp's client conversation model.
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
  `context_window_exceeded` → 400, `llm_unavailable` → 503. Usage carries
  the conversation's input tokens, from the per-model totals Warp puts
  them in.

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

## Local install

This is a local, unpublished plugin: `magpie plugin add <this folder>`.
Edits on disk are picked up by toggling the plugin off/on (or restarting
the host).
