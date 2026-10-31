# respire-memory 0.3.0 policy-correction report

Date: 2026-10-31. This supersedes **policy-compliance claims**, not the historical observations in the [0.2.1 report](TEST-REPORT.md). The earlier successful memory round trip did not prove mandatory per-turn read/store behavior.

## Result and remaining gap

Local automated checks passed. Real local Runtime policy injection, ordinary-turn diary archival, explicit-intent fact plus diary archival, independent readback and fresh-session recall passed with the corrected code. Original failed draft probes were retained and not replayed.

**Strict engine-policy parity remains incomplete:** Magpie calls onResponse after completion, so this plugin cannot guarantee storage before the reply is sent. Missing completion notifications, missing history, unsupported client events and unavailable write permission remain explicit limitations. Successful background archival is not proof of the before-send requirement.

## Corrections

| Former gap | 0.3.0 behavior |
| --- | --- |
| Simplified rules only once per session | Each new observed user turn recalls, reads complete Runtime policy, then reads selected records; legacy injectRules=false cannot suppress policy |
| Simulation put policy in the wrong envelope field | Reads the actual summary.instructions contract; fixtures now match the live Runtime |
| Small recall budgets cannot hold full policy | Complete policy has its own bounded allowance, up to 128 KiB plus fixed host adapter; no policy clipping |
| Policy mixed with untrusted history | Full policy is supplied in a separate policy block; historical memories retain the untrusted-reference boundary |
| Agent may repeat unavailable CLI tools | Host receipt identifies completed reads and prohibits fabricated tools; corrected live replies did not emit fake tool calls |
| Front-end explicit remember bypassed classification | Prefix is intent only; foreground recalls/reads policy and reports pending, worker classifies and writes |
| Optional/no-op successful archival | Archive defaults to on; successful writable archival requires this archival's trivial diary write and returned-ID readback, even without a new long-term fact |
| Model must initialize mandatory read gates itself | Host performs recall, complete policy and mode reads before the first model generation, and supplies real tool receipts |
| No causal-chain tool | Chain is available to the restricted worker and used for relevant foreground records; device metadata is retained |
| Same project argument rejected as an override | An explicit identical project is normalized; a different project remains rejected |
| Poor failure diagnostics | Safe tool command/round/error progress is retained; an unknown write aborts immediately and is not replayed |

Disabled/unconfigured archival and read-only mode are disclosed as incomplete/no-write workflows. Raw conversation capture remains off by default and separate from the mandatory model-produced process diary.

## Existing automated checks

Run npm run check, bun scripts/check.mjs and npm pack --dry-run from the source directory. No new test file was added; the existing checks were extended.

New assertions cover:

- Per-turn recall → complete policy ordering, including explicit remember intent.
- Policy still present with a 1024-byte recall budget and injectRules=false.
- Missing policy produces an incomplete-workflow diagnostic rather than a success claim.
- Actual policy-envelope shape and default archive=true in runtime and manifest.
- Worker host startup ordering before model work.
- No-write nothing-to-store is rejected; successful segmented and detached-worker cases include a verified process diary.
- Identical explicit project accepted; different project rejected.

Existing four-protocol, URL/caller/selected-secret guards, encryption, unknown-write no-retry, read-only, source validation and real detached child-process checks remain in place. These are isolated fixtures, not live all-provider/all-client acceptance. Tagged three-OS CI results are linked from the release/PR; the old 0.2.1 CI is not evidence for this revision.

## Real local acceptance

Environment: Windows, Magpie 0.1.1908, host Bun 1.4.4, existing unlocked local Respire Runtime (CLI reported 1.0.19-dev.3). Actual generation service: the user's existing local Magpie gateway with workbuddy-ai/deepseek-v4.1-flash. Raw capture disabled. A separate encrypted verification state directory isolated these probes.

| Probe | Observed evidence | Result |
| --- | --- | --- |
| Complete policy | Direct real-Runtime hook inspection returned the complete policy including its final anchor; injected block was about 59 KB | PASS |
| Ordinary turn E | No remember prefix and no new long-term fact; response was 收到。; detached worker wrote/read a trivial process diary, stored result, completed with 6 restricted calls | PASS |
| Explicit intent F | Foreground returned 待处理; worker wrote a new test fact under the requested existing parent, plus the process diary; both IDs were read back, completed with 12 restricted calls | PASS |
| Independent verification | Separate rsrs show confirmed F content and exact requested parent | PASS |
| Fresh recall F | Question contained only test code MGV-20261031-F, without expected answers; actual gateway returned 银灰色, 1648 and the same stored record ID | PASS |

Exact record IDs, response files and job receipts remain private in the ignored .verification/magpie-live directory; no credentials, full private memories or model reasoning are published here. Public CI is inspectable independently; these live observations are a maintainer report of a private installation.

The plugin was found disabled before live testing. It was temporarily enabled for the authorized acceptance, and its original disabled state and prior options are restored afterward. No Runtime/account lifecycle change or Magpie upgrade was performed.

## Failed draft probes retained

- C: an earlier draft emitted a textual nonexistent tool call and wrote a diary, but archival ended unconfirmed. Complete-policy placement and host-execution instructions were corrected. It was not retried because a write had occurred.
- D: an earlier draft returned the requested short reply, but archival ended unconfirmed before any actual write. It was not replayed. Mandatory read-gate initialization was moved into host execution; subsequent independent E and F probes passed.
- The earlier drafts did not preserve a complete per-tool trace, so this report does not claim to have proven every cause of those failures. Their states and evidence remain available locally.

## Not established

Before-send persistence; native desktop rendering; live Responses/Anthropic/Gemini sessions; production long-turn model processing; exhaustive crash/power-loss/account-switch/concurrent-load recovery; every update/merge branch; comparative agent-quality gains; npm publication or approved marketplace availability. See the [capability matrix](FEATURES.md).
