# magic-tomorrow (v0.1.0)

Maintained by **magic-tomorrow**.

## How it works

```
magpie agent request (OpenAI format)
  -> plugin fetch: model name mapping + message flattening
  -> PUT /v1/pricing/model-option   (switch model when needed)
  -> POST /v1/messages              (obtain threadId)
  -> poll GET /v1/conversations/messages until the assistant message is completed
  -> return in OpenAI format (non-streaming JSON; streaming slices the full reply into SSE chunks)
```

Authentication has two layers: SMS sign-in yields a long-lived **session token**
(stored in your magpie account); before each request it is exchanged for a
short-lived **JWT** (115 seconds), which is refreshed automatically.

## Installation

### Install from GitHub (recommended)

magpie plugins page -> Add plugin -> enter:

```
github:John138168/magic-tomorrow
```

(The short form `John138168/magic-tomorrow` works too. The
repository must be public, otherwise magpie cannot clone it.)

To have it appear in the unverified section of the magpie plugin marketplace,
tag the repository with the `magpie-plugin` topic.

### Install from a local folder

magpie plugins page -> Add plugin -> enter the path to this folder.

## Sign-in & usage

1. Once **Today** appears in the provider list, click sign-in;
2. Enter an 11-digit phone number -> receive the SMS -> enter the verification code -> done;
3. Select the `deepseek` or `glm-5.3` model and start using it.

## Known limitations (imposed by the upstream API, not bugs)

- **No tool calling**: `tool_call: false`, this provider is plain-chat only;
  agentic tasks that depend on tool calls will be limited.
- **No token-level streaming**: the plugin waits for the full reply, then
  slices it into SSE chunks, so the first token appears only after the whole
  response is generated.
- **Usage counted in characters**: the upstream returns no token usage,
  so usage is measured by reply character count.
- **Model names**: the provider exposes two short names, `deepseek` and
  `glm-5.3`; they are not merged into the `deepseek-v4.1-flash` /
  `GLM-5.3-Flash` failover group automatically — create a group manually
  if you want failover.

## Files

- `index.mjs`: all plugin logic (sign-in, quota lookup, request translation).
- `package.json`: package name and entry point.
