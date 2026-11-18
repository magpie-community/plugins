# Verification

## Initial release — 2026-11-18

The adapter's 15 offline tests pass on Node (`node --test test/*.test.mjs`).
They cover the request mapping (state forms, the `choices` shorthand, blank
criteria fallbacks, instruction defaults), answer validation (probability
distributions, score ranges, refusals, malformed answers), endpoint and
header hygiene (fixed upstream URL, fresh header set, no forwarded gateway
headers or cookies), upstream error passthrough, credential loss, the
network retry, and cancellation.

Live end-to-end checks ran on magpie 0.1.4462 with a real OpenRouter key:

- `POST /v1/systemone` with `choice`, `score` and `noul` questions returned
  calibrated probabilities, the score legend and usage (`provider: "Azure"`).
- As an intent classifier (`magpie group rule add … intent=…` with
  `classifier=openrouter-decisions/microsoft-decision-1.1`), the decision
  reached the gateway in ~1.1–3.0 s and the recorded `classified` entry
  carried the matched intent and `sure` values of 0.94 and 0.99.
- As an effort classifier (`magpie group set <id> … effort=auto`), the
  group saved and the provider registered with `decides: true`; the model
  stays out of `/v1/models` and refuses conversation requests.
- `magpie quota` showed the OpenRouter credit window and balance through
  the usage hook.

A transient network failure against the proxy was observed in production
use (`Could not reach OpenRouter` after ~3 s); the next call succeeded. The
single quick retry was added for that case and is covered by a test.

Not verified: OpenCode 2.x decision workflows end to end, other OpenRouter
decision models, image (`box`) inputs — the model does not declare them and
the adapter does not accept `box` questions.
