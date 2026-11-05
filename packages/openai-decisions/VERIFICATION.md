# Verification — 2026-11-05

Validated locally with Magpie 0.1.3039, Node 26.3.0 and Magpie's Bun 1.4.4.
The community package harness was read from magpie-community/plugins
commit `808f7a184d3a88db69691f4838deee46f64560b1`, then rechecked for
submission against `41e90a18d3affc7487460d032b0cdc5e09b20ebb`.

## Automated checks

- `npm test`: 18 pass, 0 fail.
- Community `bun scripts/check.mjs openai-decisions`: registry and provider checks pass.
- Community `bun test packages/openai-decisions`: 18 pass, 0 fail.
- OpenCode compatibility bridge matches the community's canonical file byte for byte.

## Documentation and source installation

- Root README provider table, package README, bilingual registry summary
  and changelog describe the same provider and authentication methods.
- Package Markdown links and the JSON request example were checked against
  the checked-in files and adapter.
- Community `scripts/try.sh openai-decisions` installed and listed the
  provider under `.sandbox/openai-decisions`, with one decision model
  and no sign-in. No OpenAI request or real account was used.
- This follow-up changes documentation and registry descriptions only;
  the runtime, package version and dependencies are unchanged.

The full community repository test suite was not run locally. It remains
a separate upstream CI requirement; focused package tests and sandbox
installation do not establish a full-suite pass. Live OpenCode decision
workflows and Windows/Linux execution were not tested.

## Real local gateway

The same synthetic text/JSON case exercised choice, noul and score:

| Request model | Result | Actual model |
| --- | --- | --- |
| `typesafe/jev-latest` | HTTP 200; all three answers and distributions present | `jev-1.14.0` |
| `openai-decisions/gpt-6-luna` | HTTP 200; all three answers and distributions present | `gpt-6-luna` |
| `group/decisions` | HTTP 200; all three answers and distributions present | `jev-1.14.0`, first in the group's order |

A temporary chat group with `classifier=openai-decisions/gpt-6-luna` and
`effort=auto` returned HTTP 200 with `OK`. Magpie's usage record separately
confirmed a real `kind=routing`, provider `openai-decisions`, HTTP 200
classification call. Its downstream chat model was the catalog's
`openai/gpt-5.6-luna`; the temporary group was then removed.

The optional saved-key sign-in was exercised against the real gateway.
Ordinary API-key sign-in is covered by the auth hook tests; it does not
require an existing built-in OpenAI provider.

Live rate-limit/quota failures were not forced. Their status/body/header
handling is covered by fixtures, while cross-provider failover remains
Magpie's native responsibility. Image and box decisions are outside this
adapter's declared capabilities. Different vendors' confidence fields
retain their original calibration.

These local checks do not represent community review or acceptance.
