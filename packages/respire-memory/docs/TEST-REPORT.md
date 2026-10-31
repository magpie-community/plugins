# respire-memory v0.2.1 test report

Date: **2026-10-31**. Tested runtime code: [`0ac7162`](https://github.com/risense-ai/respire-magpie/commit/0ac7162), released as [v0.2.1](https://github.com/risense-ai/respire-magpie/releases/tag/v0.2.1). This report was written after the release; it does not claim the original release tarball includes these documentation files.

**Result:** the core recall → explicit pending receipt → detached archival → stored-record readback → fresh-request recall flow passed on the local installation. This does not mean all Codex host features are available, all protocol/client combinations were exercised live, or all failure paths were tested. See the [feature matrix](FEATURES.md).

## 1. Automated verification

Public evidence:

- [CI for the tested source](https://github.com/risense-ai/respire-magpie/actions/runs/41183065419): passed.
- [Release verification and publication](https://github.com/risense-ai/respire-magpie/actions/runs/41183068079): passed; npm job intentionally skipped.
- [Existing check script at v0.2.1](https://github.com/risense-ai/respire-magpie/blob/v0.2.1/scripts/check.mjs).
- [CI matrix at v0.2.1](https://github.com/risense-ai/respire-magpie/blob/v0.2.1/.github/workflows/ci.yml): Ubuntu, Windows and macOS; Node 24 and Bun 1.3.6; package dry-run.

The checks use isolated state directories and simulated HTTP Runtime/generation services, while starting a real detached child worker. They do not use a production account or production generation model.

| Check | What the existing assertions establish |
| --- | --- |
| Four protocol shapes | Chat, Responses, Anthropic and Gemini request fixtures receive expected recall content without mutating the input object |
| Cache and caller boundary | Repeated request behavior is checked; gateway-key origin is skipped |
| Configuration / assets | Non-loopback or credential-bearing Runtime URLs are rejected; referenced files exist; embedded icon bytes match the SVG asset |
| Sensitive fields | Selected secret-shaped content/fields are rejected; this is not exhaustive detection of every secret format |
| Archival and readback | HTTP model tool loop stores a record, includes the real source digest, reads it back and completes the job |
| Encryption | Persisted job ciphertext does not contain the selected plaintext test fact |
| Unknown-write failure | Destroyed connection after a simulated write produces unconfirmed; processing that job again does not write again |
| Read-only and tool restrictions | Read-only worker does not write; ungrounded/force writes and policy-changing commands are rejected |
| Segmentation and sources | A 270,000-character user message splits; evidence reads are bounded; invented source references are rejected; segmented processing completes after evidence reads |
| Real child process | onResponse queues encrypted work; detached worker processes it through model tools and readback |
| Pending regression | `ok:false`, `exit:2`, envelope `status:pending` is returned as pending rather than rejected as invalid |

Reproduce from the complete plugin source directory:

```sh
npm run check
bun scripts/check.mjs
npm pack --dry-run
```

## 2. Live local acceptance

Environment: Windows; **Magpie 0.1.1908**, Magpie-hosted **Bun 1.4.4**; an existing unlocked loopback Respire Runtime. Actual generation model: **workbuddy-ai/deepseek-v4.1-flash**, through the user's existing local Magpie gateway. No host or Runtime upgrade and no account change was performed.

| Scenario | Procedure and observed result | Status |
| --- | --- | --- |
| Existing-memory recall | Sent an actual local Chat Completions gateway request; model returned information and IDs from injected records | PASS |
| Explicit storage receipt | Submitted a non-sensitive test fact using the 记住： prefix; engine returned pending | PASS after fix below |
| Background resolution | Completed the reply; onResponse queued the pending turn; detached worker used the real configured model and completed archival in 7 tool calls | PASS |
| Actual persistence | Worker reported stored and checkedRecords with the same test record; a separate `rsrs show` confirmed the fact and parent | PASS |
| Fresh-request recall | Asked for the test color and check number without putting their expected values in the question; response returned 湖蓝色, 8426 and the stored record ID | PASS |
| Installed package | Installed the 0.2.1 package under the respire-memory directory, repeated the gateway recall successfully, then replaced the installed contents with the checksum-verified GitHub Release artifact | PASS; no additional live request claimed after the final identical-version artifact replacement |
| Names and introduction | Actual Magpie web sidebar, installed list, page heading and introduction showed respire-memory and the agent-experience description | PASS |
| Icon display | Inspected rendered light and dark Magpie web pages; both page images loaded, the active variant switched, and sidebar icon displayed | PASS |

Synthetic fact used: test code **MGV-20261031-B**, color **湖蓝色**, number **8426**. Record and turn IDs are omitted from this public report. Exact receipts, IDs, response files and the worker result remain in the local ignored `.verification/magpie-live/` directory, summarized in `result.json`; raw account data, private memory bodies, credentials and model reasoning are not published.

The public CI links are independently inspectable. The local acceptance observations are a maintainer's report, not publicly replayable proof of the private installation. A different installation must run its own live acceptance.

## 3. Bug found and fixed during acceptance

Respire legitimately represents a pending write as RPC `ok:false`, process exit **2**, and an envelope with `status:pending`. The old RPC adapter required success/exit 0 and misclassified this as an unknown write.

v0.2.1 accepts exactly that pending combination. The front end now reports pending, and enabled background archival can resolve it under engine policy. Pending is not reported as saved; unknown writes remain non-retryable. The existing check script includes the regression assertion. The first uncertain test was not automatically retried.

## 4. Release validation

The release workflow passed all three operating systems, published the tarball and SHA256SUMS, and skipped npm as configured. The downloaded tarball matched SHA256SUMS:

```text
rsrsai-magpie-0.2.1.tgz
sha256 c15bcc10e4a0c4d5e499390f1cdfebf884ecbc7e82b720ce9b86e70d60007331
```

Release delivery is separate from marketplace review. [Magpie community PR #553](https://github.com/magpie-community/plugins/pull/553) is the proposed registry/package integration; submission does not prove merge or listing availability.

## 5. Not verified / not provided

- Native desktop window rendering; a forced Magpie theme that differs from the system theme.
- Live Responses, Anthropic and Gemini client sessions; exhaustive streaming, reconnect, malformed response and provider combinations.
- Live raw diary capture, every update/merge branch, real process-crash recovery, queue saturation, power loss, account-switch races or long-duration/concurrent stress.
- A production long-turn segmentation run through the real generation service. Automated segmentation coverage uses fixtures.
- Automatic client plan-mode detection, genuine SessionStart/resume/compaction callbacks and guaranteed native status lines: these are host capability gaps, not completed features.
- Exactly-once delivery before enqueue, reconstruction of unseen Responses history, image/audio/private-reasoning archival, or benchmarked agent-quality gains.
- npm publication and approved community marketplace delivery. Both require their separate publishing/review steps.
