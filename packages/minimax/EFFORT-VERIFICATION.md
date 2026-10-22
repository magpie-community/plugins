# M3.1-Flash effort verification

## Environment and cause

Verified on 2026-10-22 with Magpie 0.1.1318 and 0.1.1319.
The live five-level retest used 0.1.1319 and a local plugin based on
0.1.3 (effortfix.3). This PR ports that bridge to upstream 0.1.4.

The plugin selects `@ai-sdk/anthropic` for the MiniMax Code subscription
route. Magpie's OpenAI-to-Anthropic conversion replaces the selected
level with a thinking token budget and does not send `output_config.effort`.
The plugin's fetch forwards that converted body. This is a host conversion
problem addressed here with a plugin workaround, not a missing variant list.

Upstream 0.1.4 (`4d73d22010d331751763ca3aeb40ad2afe226b39`)
changes check-in identity/client parameters only. Replaying the previously
captured 0.1.1319 payloads through its unmodified auth-loader fetch with
network interception confirmed all five bodies pass through unchanged.
No real token or network was used for that 0.1.4 replay.

| Input effort | Original thinking budget at output cap 8192 | Original native effort |
|---|---:|---|
| low | 4096 | absent |
| medium | 7168 | absent |
| high | 7168 | absent |
| xhigh | 7168 | absent |
| max | 7168 | absent |

At output cap 65536, the budgets were 4096/10000/24000/32000/32000:
raising the cap does not restore five native levels. The subscription
backend's default when effort is absent was not established; these results
do **not** prove every request ran at max.

## Reproduction

1. Use stock Magpie 0.1.1319 with the unmodified MiniMax Code plugin and a
   signed-in subscription account. Select the direct model ID below.
2. Submit this request five times, replacing `low` with each supported level:

```json
{
  "model": "minimax-code/MiniMax-M3.1-Flash",
  "input": "Reply exactly OK.",
  "reasoning": { "effort": "low" },
  "max_output_tokens": 8192,
  "stream": false
}
```

POST to the local Magpie `/v1/responses` endpoint (default local port in
this test: 3425), authenticating with your own gateway key if required.
For Chat Completions use `/v1/chat/completions`, `messages`, `max_tokens`,
and `reasoning_effort` instead. `MiniMax-M3.1-Flash-Preview` is also covered.

3. Inspect only the serialized request immediately before the plugin's
   network fetch: `model`, `thinking`, and `output_config.effort`. Do not
   log Authorization, credentials, full prompts or account information.
4. Observe the table above. Install this branch with its `magpie.hooks`
   metadata loaded, restart/reload the plugin, and repeat. The native
   effort should equal the input; `thinking` should be absent.

## Why the bridge is needed

The inspected 0.1.1319 plugin host passes converted body text to fetch.
`chat.headers` gets model/provider/session information but not the selected
original effort; `chat.params` is not called on this gateway route.
The early gateway `onRequest` hook still sees the OpenAI effort. Adding an
OpenAI-side `output_config` or metadata does not survive conversion.

The bridge retains effort by a per-request UUID, carries the UUID through
system text, and removes it before authenticated fetch. Entries survive
retries for 15 minutes. See README for the direct-model/no-cross-provider-
fallback restriction. A proper host field outside prompt text is preferable.
The host can fail open on gateway-hook exceptions, so the 4096-entry
capacity guard is not a guarantee that overloaded requests preserve effort.

## Official client comparison

The locally inspected MiniMax Code 3.1.4 model catalog marks M3.1-Flash
as `forced_on` with low/medium/high/xhigh/max. Its v2 managed-login
`patchManagedThinkingPayload` path deletes `thinking` and sets
`output_config.effort`. This is the path matched here, rather than the
older adaptive shape. Bundled proprietary client sources are not included.

The real CN subscription `/messages` route accepted the patched requests.
Probes of `/chat/completions` and `/responses` on that subscription host
returned HTTP 503, errorCode 50115 (`direct_route_not_configured`), so
switching the plugin to an OpenAI SDK did not resolve this route.
This says nothing about separate API-key products or other hosts.

## Real subscription retest (sanitized)

Target: `https://agent.minimax.cn/mavis/api/v1/llm/v1/messages`.
Input: Responses, `minimax-code/MiniMax-M3.1-Flash`, cap 8192, non-streaming.
Each prompt requested exactly OK and contained a disposable test identifier.
Instrumentation captured selected fields immediately before the real fetch;
no credentials, identifiers, raw prompts or response bodies are published.

| Requested | Sent output_config.effort | thinking | Marker in body / headers / response | HTTP | Status / text | Output tokens |
|---|---|---|---|---:|---|---:|
| low | low | absent | no / no / no | 200 | completed / OK | 3 |
| medium | medium | absent | no / no / no | 200 | completed / OK | 3 |
| high | high | absent | no / no / no | 200 | completed / OK | 3 |
| xhigh | xhigh | absent | no / no / no | 200 | completed / OK | 10 |
| max | max | absent | no / no / no | 200 | completed / OK | 15 |

All five requests contained the carrier before restoration and none after.
Total generated output: 34 tokens. This verifies wire parameters and
successful acceptance, not reasoning quality or server-internal effort.
Global subscription, aliases, cross-provider fallback and streaming were
not live-tested. Global model IDs are covered by offline bridge tests.

An initial development attempt missed Go's HTML escaping of `<` in JSON
and leaked an opaque UUID carrier. The final implementation searches for
the unescaped interior prefix before parsing JSON. The table is from the
successful retest after that correction; escaped JSON has a regression test.
Temporary live instrumentation was removed after verification.

## Automated checks on the 0.1.4 port

- `bun test packages/minimax`: 56 pass, 0 fail (277 Bun assertions plus
  Node assertions for the bridge cases).
- Includes 20 interleaved contexts, 40 restore/retry checks, both provider
  IDs, both OpenAI input forms, escaped/unescaped JSON, native Messages,
  model scope, invalid context, and actual auth-loader fetch interception.
- `bun scripts/check.mjs minimax`: pass.
- `git diff --check`: pass.

Tests use fake credentials and block external network. The live retest
predates the port and ran the same bridge with 0.1.3; it must not be confused
with a fresh real-account test of upstream 0.1.4.
