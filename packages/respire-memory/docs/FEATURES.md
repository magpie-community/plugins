# respire-memory capabilities and boundaries

Applies to **v0.3.0**. See the [policy-correction report](TEST-REPORT-0.3.0.md) and [historical v0.2.1 acceptance report](TEST-REPORT.md). A working memory round trip is not proof of full engine-policy compliance.

## Agent self-evolution through experience

Each newly observed user turn recalls memory, reads the complete Runtime policy, then reads selected records and relevant causal chains. The answering agent receives the full policy separately from untrusted historical memory. A host-execution receipt identifies the initial steps already performed; the agent must not fabricate unavailable tools or repeat host actions mechanically.

Every successfully archived writable turn must write and read back a process diary, even when there is no new long-term conclusion. New reusable facts, decisions and lessons are separately updated or attached to existing records. Explicit remember emphasizes the user's intent; it is not the sole storage trigger. Archival defaults to on and requires a configured generation model. Raw transcript capture remains separate and off by default.

This feedback loop changes reusable memory, not model weights. Readback confirms storage, not the truth of a conclusion. No general agent-quality or comparative performance benchmark is claimed.

## Current feature matrix

| Capability | Implementation | Evidence / limitation |
| --- | --- | --- |
| Per-turn read | Recall, complete policy from summary.instructions, selected full records; causal chain for decision/lesson/agreement/error-like hits | Four protocol fixtures; real Runtime complete-policy injection inspected. Same-turn retries reuse durable results |
| Policy presence | Full policy is supplied every new turn, independently of the obsolete injectRules flag | Legacy small recall budgets do not clip policy; separate 128 KiB allowance plus fixed adapter; increases context cost |
| Explicit remember | Front end reads policy/candidates, reports pending and defers classification and writes | No direct foreground remember that bypasses classification; pending is not saved |
| Automatic archival | Default on; detached worker uses a separately configured Chat Completions model | Requires generation setup. Disabled/unconfigured archival is disclosed as incomplete, not successful |
| Mandatory process diary | Writable success requires a new trivial write in this archival and readback of its returned ID | No-write nothing-to-store is rejected. Existing long-term facts still must not be duplicated |
| Long-term organization | Restricted recall/show/chain/tree/taxonomy plus remember/update; shown parent required for new important records | Main-loop and fixture checks pass; destructive merges/configuration changes remain unavailable |
| Source evidence and long turns | Bounded evidence tools, segmentation and user-source reads before writing | 270,000-character automated case; no real-provider long-turn qualification |
| Persistence and failures | Encrypted queue, turn deduplication, progress, record IDs and unknown-write no-retry | Unknown writes stop archival; no exactly-once/power-loss guarantee |
| Read-only and caller control | Local/magpie-key only; explicit readOnly and engine restrictions remain authoritative | Shared-key fixture rejection checked; old host magpie-key classification remains limited |
| Optional raw capture | Trivial raw turn diary when explicitly enabled | Default off; distinct from model-produced process diary; no live raw-capture acceptance claimed |
| Settings and status | Settings page, Memory/Used/prior-save hints, adaptive local light/dark icon | v0.2.1 actual Magpie web rendering inspected; hints depend on the answering model |
| Delivery | Three-OS Node/Bun checks and tagged GitHub Release tarball/SHA256 | npm deferred; community registry delivery requires maintainer merge |

## Strict requirements that remain unmet

**Magpie's completion notification arrives after the reply has completed.** This plugin therefore cannot guarantee the engine's strict requirement to store before the reply is sent. A verified process diary after completion does not satisfy that timing requirement. The implementation must not be described as complete engine-policy parity.

The gateway also lacks native client SessionStart/resume/compaction events, trustworthy automatic client plan-mode detection, guaranteed native status lines, and visibility into the client's filesystem/tool actions outside gateway traffic. Use readOnly explicitly for plan/no-write workflows.

## Operational limits

- Only completed, visible, supported turns qualify. Lost notifications before enqueue, truncated replies, unresolved tools, sensitive content and unseen Responses previous_response_id history can prevent archival. These are incomplete rounds, not saved rounds.
- Raw images, audio and private reasoning are not archived. Missing history is not reconstructed.
- Project filtering is not authorization. Other client tools are outside this plugin's control.
- Archival sends turn/tool evidence and relevant memory to the configured provider and consumes model quota. Missing setup and disabled controls must be disclosed.
- State encryption keys live beside ciphertext; protect the whole directory. This is not an OS keychain.
- Changed controls reach workers on a subsequent request and cannot revoke an accepted write. Unknown writes must be checked against the actual library before any manual decision to retry.
- No exhaustive crash recovery, account-switch race, concurrent-load, power-loss, live all-protocol or native desktop rendering acceptance is claimed.

Installation and recovery commands: [README](../README.md).
