# @magpie-community/opencode-2-free-auth

OpenCode 2.0.31's free models in [magpie](https://usemagpie.ai) and any host
that loads OpenCode plugins. Provider id: `opencode-2-free`.

OpenCode 2's free tier only answers requests that look like they come from
OpenCode 2; anything else gets `403 FreeTierError`. The plugin sends exactly
OpenCode 2.0.31's identity: client version, `User-Agent`, session id shape,
request id shape, plus the streaming and tool declarations the free tier
requires. No sign-in and no personal API key are needed.

## Install

```sh
magpie plugin add @magpie-community/opencode-2-free-auth
magpie plugin login opencode-2-free
```

In magpie's UI it is under **Plugins › Discover**; pick **OpenCode 2 Free**
under providers.

## Sign in

Enter `public`, or leave the field blank. Whatever is typed is ignored: the
free tier uses the shared `public` credential, and a key made under your own
OpenCode account does nothing here. The credential is kept in magpie's
`plugin-auth.json` or OpenCode's `auth.json`.

## Models

The plugin ships the ten free models OpenCode 2.0.31 offers today, and
refreshes them from the gateway and the `models.opencode.ai` catalog, so a
newly free model joins and a retired one leaves:

| Model id | Name | Context | Inputs |
| --- | --- | --- | --- |
| `glm-5.3-flash-free` | GLM-5.3-Flash Free | 200K | text / image / video / PDF |
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | 200K | text / image |
| `big-pickle` | Big Pickle | 200K | text |
| `beam-free` | Beam Free | 1M | text |
| `nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | 1M | text / image |
| `space-bunny-free` | Space Bunny Free | 1M | text / image / video |
| `mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | 200K | text / image / audio / video |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 256K | text |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 1M | text |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview Free | 1M | text / image |

Use `opencode-2-free/<model id>`, for example `opencode-2-free/big-pickle`.

Every model streams `reasoning_content`, calls tools, and accepts its declared
image, audio, video or PDF inputs. Reasoning-effort variants are generated for
the levels each model supports.

The list is refreshed from the gateway at most once a minute. A request for a
model that is not free now gets a 404 naming the free models available at that
moment.

## Requests

Requests go to `https://opencode.ai/inference/openai/v1/chat/completions`
(Chat Completions). The free tier's three gates are filled in at the plugin's
boundary, invisible to the host and the user:

1. **Streaming is mandatory**: the body always has `stream: true`. A host that
   asked for a non-streaming reply gets the SSE collapsed back to JSON locally.
2. **Core tools are mandatory**: a request must declare at least `read`. The
   plugin adds `bash`, `edit`, `glob`, `grep` and `read` with full parameter
   schemas, without duplicating tools the agent already declared.
3. **The identity must be OpenCode 2's**:
   - `User-Agent: opencode/2.0.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
   - `x-opencode-client: cli`
   - session ids in `opencodeID("ses", true)` (descending) form, request ids in
     `opencodeID("msg", false)` form
   - `authorization: Bearer public`

A real session id from the host is passed through. Without one, the plugin
derives a stable made-up session from the first user message, so the turns of
one conversation share one session.

## Tool names

Models often call OpenCode's native tool names while the agent declares
different ones (`bash` vs `Bash`). The plugin renames a call when exactly one
declared tool differs only in case, or only in case and `_`/`-`
(`todowrite` → `todo_write`). A call with no such tool is left out of the reply,
and the reply's text says which name was left out; a turn whose every call was
left out ends as an ordinary answer.

## Stream cuts and errors

- Upstream sometimes closes a stream before `[DONE]`. With text and no
  unfinished tool call, the turn ends as an ordinary answer marked as cut
  short, and asking again continues. With an unfinished tool call, no text, or
  a reply collapsed for a non-streaming client, the request fails with an error
  naming the reply id and how much arrived.
- Upstream errors, 403 included, are passed through unchanged.

## Limits

Quota, rate limits and availability are set by OpenCode 2; the plugin holds no
remaining-quota data. The free tier follows OpenCode 2's release policy, and
the plugin tracks it through runtime discovery.

## Uninstall

```sh
magpie plugin remove opencode-2-free
```
