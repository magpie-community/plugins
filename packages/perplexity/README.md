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

Set `tier` to `max` if your plan is Max — otherwise the flagship models are
hidden.

## Options

| option | default | meaning |
| --- | --- | --- |
| `tier` | `pro` | `free` / `pro` / `max`; which models are offered |
| `keepSystem` | `false` | forward system/developer prompts into the query. Off by default: Perplexity searches every word of the query, and a coding agent's system prompt poisons its results |
| `chromePath` | auto | Chrome/Chromium/Edge executable for browser sign-in |
| `apiVersion` | `2.18` | the `version` Perplexity's web client sends; raise it if the endpoint starts refusing |

## Quota

`auth.usage` reads `/rest/rate-limit/all`, so the remaining Pro Search count
shows in `magpie quota`, the Usage page and `GET /v1/magpie/quotas`, and
`routing=smart` weighs it when picking an account. `auto` is marked `free`, so it
never spends that quota — a good last resort inside a routing group.

## Limitations

- **No function calling.** The web endpoint has none; the models are declared
  with `toolcall: false`. Tools sent by an agent are dropped and the answer
  comes back as text, so these models suit chat, research, writing, translation
  and summarising — not tool-driven coding agents.
- **No images, files, structured output, multiple choices or sampling
  parameters.**
- Perplexity sometimes substitutes the model it actually ran; the answer still
  arrives.
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

## License

MIT. Not affiliated with Perplexity.
