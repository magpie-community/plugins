# Perplexity Pro for magpie / OpenCode

Signs in to your own **Perplexity Pro or Max** plan and serves every model it
offers as a provider, to every agent magpie connects. Perplexity's built-in web
search stays on, so answers carry real-time results and citations.

No API key, no proxy, no Python: the plugin talks to Perplexity's web endpoints
with plain `fetch`.

## Sign-in

**Paste a cookie.** Log in at [perplexity.ai](https://www.perplexity.ai), then
F12 → Application → Cookies → `www.perplexity.ai` → copy the value of
`__Secure-next-auth.session-token`. The plugin validates it against
`/api/auth/session` before saving, so a bad paste fails immediately.

**Or sign in with the browser.** The plugin starts a throwaway Chrome (its own
profile, your normal browser is untouched), you log in there, and the session
cookie is read over the DevTools protocol — page JavaScript cannot read it, it is
`Secure` + `HttpOnly`. You may need to set `chromePath` if Chrome is not in the
usual place.

The cookie is kept in magpie's `plugin-auth.json` (mode 600) next to the other
subscription sign-ins. Add the plugin again for a second account: magpie fails
over between them when one runs out of quota or its sign-in expires.

## Models

23 model ids in the catalog: 1 on the free tier (`auto`), 19 on Pro, 23 on
Max. The plugin serves exactly the ids your `tier` allows.

| id | Perplexity preference | tier |
| --- | --- | --- |
| `auto` | Perplexity Best | free — does not spend Pro Search |
| `sonar` | Sonar 2 | pro |
| `gpt`, `gpt-5.5`, `gpt-mini`, `gpt-nano` | GPT-5.x | pro |
| `gemini`, `gemini-flash` | Gemini 3.x | pro |
| `sonnet`, `sonnet-4.6` | Claude Sonnet | pro |
| `grok`, `grok-4.5`, `grok-4`, `grok-reasoning` | Grok 4.x | pro |
| `nemotron`, `nemotron-3-super`, `glm-5.2`, `kimi-k2.6`, `kimi-k3` | others | pro |
| `opus`, `opus-4.7`, `opus-4.6`, `gpt-5.6-sol` | flagship | max |

Models with reasoning variants switch to the matching `*_thinking` preference
when a request carries `reasoning_effort` / `thinking`; the reasoning stream is
returned as `reasoning_content`.

Each model carries the context/output window of the model Perplexity runs
underneath, so a host sizes its prompts against the real model instead of one
blanket number:

| family | context | output |
| --- | --- | --- |
| Gemini 3.1 Pro / 3.5 Flash | 1,000,000 | 65,536 |
| GPT-5.6 Terra / Sol, GPT-5.5 / Mini / Nano | 400,000 | 128,000 |
| Grok 4.6 / 4.5 / 4.20 Reasoning / 4, Kimi K3 / K2.6 | 256,000 | 64,000 / 32,000 |
| Claude Sonnet 5 / 4.6 | 200,000 | 64,000 |
| Claude Opus 4.8 / 4.7 / 4.6, GLM-5.2 | 200,000 | 32,000 / 128,000 |
| Nemotron 3 Ultra / Super, Sonar 2, Perplexity Best | 128,000 | 32,000 / 16,000 |

Those are the upstream models' published windows; Perplexity's web endpoint
publishes none of its own and may truncate earlier, so every model also carries
`limitEstimated: true` — a hint, not a promise.

Set `tier` to `max` if your plan is Max — otherwise the flagship models are
hidden.

## Options

| option | default | meaning |
| --- | --- | --- |
| `tier` | `pro` | `free` / `pro` / `max`; which models are offered |
| `keepSystem` | `false` | forward system/developer prompts into the query. Off by default: Perplexity searches every word of the query, and a coding agent's system prompt poisons its results |
| `chromePath` | auto | Chrome/Chromium/Edge executable for browser sign-in |
| `apiVersion` | `2.18` | the `version` Perplexity's web client sends; raise it if the endpoint starts refusing |
| `tools` | `reject` | what to do with a request that carries `tools`: `reject` answers 400 (fail loudly); `ignore` answers as text and marks the response `x-magpie-tools-ignored: 1` |
| `locale` | `auto` | `auto` / `zh` / `en`: language of the sign-in flow, the account card and `magpie quota`, and of every error this provider returns |

## Quota

`auth.usage` reads `/rest/rate-limit/all` and reports only counters that
endpoint actually returned — remaining Pro Searches, Deep Research, Labs and
Agentic Research, plus whether free quick searches are available. It publishes
no reset time, so the plugin shows no span rather than inventing a 30-day one.

Those counters drive `magpie quota`, the Usage page and
`GET /v1/magpie/quotas`, and `routing=smart` weighs them when picking an
account. `auto` is marked `free`, so it never spends Pro Search quota — a good
last resort inside a routing group.

## Errors

Upstream statuses keep their own number and Perplexity's own text: a 403 is
reported as a 403 with the reason it gave (it is not always an expired cookie),
a 429 with the limit it names. A failure before the first token is a non-200
response, not a 200 carrying an error event; an error after tokens have already
been sent is labelled `midstream_error` inside the stream, because the HTTP
status is no longer changeable at that point.

**Usage numbers are estimates**, flagged `estimated: true` with
`source: "perplexity_chars_div_4"` in `prompt_tokens_details` /
`completion_tokens_details`: Perplexity reports no usage, and a made-up count
that looks measured is worse than a labelled guess. Streaming sends usage only
when the request sets `stream_options.include_usage`.

## Limitations

- **No function calling.** The web endpoint has none; the models are declared
  with `toolcall: false`. By default a request that carries `tools` / `functions`
  is **rejected with a 400** naming the reason, rather than having its tools
  silently dropped. Set `tools: "ignore"` to answer as text instead — the
  response then carries `x-magpie-tools-ignored: 1`, so the substitution is
  visible rather than silent. A host like Claude Code, which always sends its
  tool list, needs `ignore`. These models suit chat, research, writing,
  translation and summarising — not tool-driven coding agents.
- **No images, files, structured output, multiple choices or sampling
  parameters.**
- Perplexity sometimes substitutes the model it actually ran; the answer still
  arrives.
- Citation markers (`[1]`) are stripped by shape, since the stream carries no
  citation metadata: fenced blocks, inline code, `arr[0]` and `a[1]` are left
  alone; a bare `foo[3]` outside backticks is indistinguishable from a citation
  and loses its marker.
- This uses Perplexity's internal web API, which can change without notice. The
  model table and the request body are the two places to fix when it does.

## Use

```sh
magpie plugin add @magpie-community/opencode-perplexity-auth
magpie plugin login perplexity
magpie provider test perplexity
magpie group add pplx models=perplexity/sonnet,perplexity/gpt,perplexity/auto routing=smart
```

OpenCode:

```json
{ "plugin": ["@magpie-community/opencode-perplexity-auth"] }
```

then `opencode auth login`.

## Tests

```sh
bun test ./packages/perplexity
```

Covers `buildQuery`, `sseEvents` replayed from captured SSE bytes (including
bytes split mid-line and CRLF), `answerDelta` reassembly and reasoning blocks,
citation stripping, the streaming and non-streaming translation, every error
path (401/403/429/500, mid-stream, empty answer, network), tool rejection,
quota windows, the locale tables and both sign-in methods' surfaces.

## License

MIT. Not affiliated with Perplexity.
