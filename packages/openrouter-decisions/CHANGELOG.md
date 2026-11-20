# Changelog

## 0.1.0 — 2026-11-18

First release. Exposes OpenRouter's Decisions API
(`POST https://openrouter.ai/api/alpha/decisions`) through Magpie's System
One interface, with `microsoft/microsoft-decision-1.1` as the model.

- `choice`, `score` and `noul` questions with probabilities, confidence and
  a score legend restored from the upstream answer.
- `choices: [...]` shorthand expanded to a criteria map; blank criteria text
  falls back to the option name so the upstream's non-empty constraint holds.
- Object, numeric and boolean System One state becomes JSON text evidence;
  text passes through; multimodal state parts keep their array form.
- Per-question refusals stay refusals; other answers and usage are retained.
- OpenRouter credit usage shown through `auth.usage` (`/api/v1/auth/key`,
  `/api/v1/credits`).
- Fixed upstream endpoint, fresh header set, no redirects; cancellation
  propagates; one quick network-level retry absorbs momentary proxy or DNS
  failures while HTTP error answers are never retried.
