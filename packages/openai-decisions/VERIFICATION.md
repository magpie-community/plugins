# Verification

## Maintainer-requested revision — 2026-11-11

The revision addresses the six requests in
[the maintainer's review](https://github.com/magpie-community/plugins/pull/762#issuecomment-6662604576).

- Authentication uses only the host's selected-account `getAuth` callback.
  The saved-key reader, keyless method and disk credential fixtures are removed.
- Per-question refusals are omitted, while ordinary answers and usage are retained.
  Duplicate, missing and unrequested answers still fail validation.
- Omitted, null and blank System One instructions receive a non-empty default.
- The package is `@magpie-community/opencode-openai-decisions-auth`, with an
  HTTPS icon, a single-line registry entry and English code comments.
- README, registry summaries, changelog and notice reflect the API-key-only
  behavior. Third-party provider repository references are removed.

### Regression evidence

The revised tests first ran against the previous implementation:
**16 passed, 7 failed**. Failures included blank upstream instructions,
per-question refusals turning a successful response into HTTP 502, the extra
keyless sign-in, and the old package metadata. They then passed after the fix:
**23 passed, 0 failed** on Node and Bun.

The package tests are offline. Credentials and responses are synthetic and
in-memory; no test creates a credential file or a `.data/` directory.
They cover all three question types, partial/all refusals, missing or invalid
ordinary answers, structured evidence, defaults, account changes, sign-out,
errors, cancellation and loader compatibility.

Full community checks and current-main integration are recorded in the revision
commit body and PR description. A package-only test run does not establish a
full-repository pass. Live OpenCode decision workflows and Windows/Linux
execution have not been verified.

## Earlier local gateway checks — 2026-11-05

The earlier revision used Magpie 0.1.3039, Node 26.3.0 and Bun 1.4.4.

| Request model | Result | Actual model |
| --- | --- | --- |
| `typesafe/jev-latest` | HTTP 200; choice/noul/score answers present | `jev-1.14.0` |
| `openai-decisions/gpt-6-luna` | HTTP 200; choice/noul/score answers present | `gpt-6-luna` |
| `group/decisions` | HTTP 200; all three answers present | `jev-1.14.0`, first in group order |

A temporary chat group used `classifier=openai-decisions/gpt-6-luna` and
`effort=auto`. Magpie recorded a real `kind=routing`, HTTP 200 classifier
call before its downstream `openai/gpt-5.6-luna` chat returned `OK`.
The temporary group was removed.

Those calls predate removal of the saved-key method and are historical protocol
and gateway evidence. They do not establish a live standard-key sign-in check
for the current revision. Live upstream quota failures and safety refusals were
not forced; their status and per-question handling are verified with fixtures.
Images and box decisions are outside the adapter's declared capabilities.
Confidence values retain their vendor's original calibration.
