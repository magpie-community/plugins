# respire-memory: capabilities and boundaries

Applies to upstream **v0.2.1** (`0ac7162`) and the proposed Magpie community distribution. See the [test report](TEST-REPORT.md) for the scope of verification. Implemented does not mean every path has been tested against a production service.

## Purpose: agent self-evolution through experience

respire-memory connects an agent's request/reply cycle to an existing Respire memory library. The agent can recall earlier experience before answering. Explicit remember requests can save facts; optional background archival extracts decisions, methods and lessons from completed turns, checks existing records, and reads back writes. Later turns can reuse those records.

This is a memory-based feedback loop, not model-weight training. Records remain historical evidence, not instructions. Readback confirms storage, not the truth of a model's conclusions. No benchmark establishes a general improvement in agent quality.

## What this offers Magpie users

- **One gateway integration:** clients using Chat Completions, Responses, Anthropic or Gemini request shapes can receive memory context without installing a separate memory plugin in each client. Only trusted local origins qualify; supported protocol shapes are not a claim that every client has been tested.
- **Reusable experience, beyond a transcript:** optional archival can extract and organize facts, decisions and lessons, rather than only retaining raw conversation text. Raw diary capture and archival are separate, opt-in controls.
- **Independent background work:** a detached worker uses a separately configured Chat Completions model. The foreground request does not wait for that model's full archival loop. Extra model calls still consume provider quota.
- **Inspectable writes:** pending, completed and unconfirmed outcomes are distinct. The worker records returned IDs, verifies writes by reading them back, and preserves source evidence for inspection.
- **Conservative recovery:** encrypted durable state supports deduplication and queued work. A write with an unknown result is not blindly retried. Source tools are bounded; they do not expose a shell or client tools to the archival model.
- **Existing-library reuse:** the plugin uses the user's existing local Respire Runtime and engine policy. It does not require a new account, install an engine, manage a service, or import a provider's private credentials.

These are design properties and tested behaviors within the report's scope. They are not comparative performance or security claims about PowerContext or other memory systems.

## Feature matrix

| Capability | Implementation in v0.2.1 | Verification / boundary |
| --- | --- | --- |
| Recall before a request | Retrieves candidates, reads complete selected records and injects bounded context with IDs | Four protocol shapes checked with fixtures; real local Chat gateway and fresh-session recall passed |
| Explicit remember prefixes | Handles 记 / 存 / 记录 / 记住 / remember prefixes; reports engine receipt | Real pending receipt and subsequent worker resolution passed; simulated successful writes also checked |
| Pending / unknown outcomes | Accepts pending envelopes with exit code 2; unknown writes remain uncertain | Regression assertion and live pending path passed; uncertain-write no-retry checked with a simulated connection failure |
| Library / account identity | Associates durable state and queued work with the current Runtime identity | Implemented; exhaustive account-switch race testing has not been performed |
| Session rules and engine checks | Runs when the plugin first observes a session | An approximation at the gateway, not native SessionStart, resume or compaction hooks |
| Raw diary capture | Optional trivial diary storage for completed visible turns | Implemented; production raw-capture acceptance was not performed; default off |
| Background archival | Detached worker plus independently configured generation service | Real WorkBuddy model completed archival and record readback; fixture HTTP tool loop and detached worker also passed |
| Deduplicate / update / attach | Restricted memory tools require policy and candidate reads; can update or attach under a parent | Policy guards checked; live parent attachment passed; every update/merge branch has not been independently accepted |
| Write verification and source evidence | Reads actual records and retains turn source references | Automated checks and real record readback passed; stored conclusions are not thereby proven true |
| Large-turn handling | Bounded context, segmentation, extraction, and source evidence tools | 270,000-character user input exercised in automated checks; no equivalent production long-turn model acceptance |
| Durable queue and deduplication | AES-256-GCM records, atomic replacement, locks, persistent turn/job state | Persistence and detached-worker path checked; not a power-loss, concurrent-load or long-duration qualification |
| Recovery commands | setup / status / run / recover / evidence | Implemented; no real crash-and-recovery acceptance claimed. Writes already attempted are not replayed |
| Read-only mode | Blocks this plugin's explicit writes, capture and archival | Worker read-only case checked; cannot restrict unrelated client tools or revoke already accepted writes |
| Memory / Used / prior-save hints | Supplies instructions and display preferences to the answering model | Implemented; Used is the model's report, not independent attribution measurement or a native UI status line |
| Automatic plan-mode prohibition | No trusted client permission_mode is available | **Not implemented automatically**; use readOnly explicitly |
| Caller boundary | Local / magpie-key only; shared, remote and unknown callers excluded | Shared-key rejection checked; installed Magpie 0.1.1908 does not reliably identify magpie-key; upgrade recommended for that path |
| Configuration page and icons | Sandboxed settings, adaptive inline/sidebar SVG, light/dark page assets | Names, settings introduction and icons inspected in real Magpie web; native desktop window not directly inspected |
| Safe bypass / failure handling | /nomem and #nomem skip recall only; connection failure preserves the original conversation | Implemented; skipping recall does not disable opted-in capture or archival |
| Packaging and delivery | GitHub Release tarball and SHA256; three-OS Node/Bun CI; npm workflow gated | v0.2.1 released and checksum verified; npm deferred; community listing requires PR merge |

## Important operational limits

- A persistent queue cannot recover a completion notification lost before the host enqueues it. No exactly-once end-to-end delivery guarantee is made.
- Responses requests that depend on unseen `previous_response_id` history are skipped for capture/archival. Missing client history is not reconstructed.
- Images, audio and private reasoning are not archived. Only the visible, supported conversation content is processed.
- Project filtering narrows retrieval/update targets; it is not an authorization boundary.
- Enabling archival sends turn content, relevant memory and tool evidence to the configured generation service. Capture and archival default to off.
- The local state encryption key is stored beside its ciphertext. Protect the whole directory; this is not an OS keychain or a substitute for Respire library encryption.
- Changes to readOnly/capture/archive reach the worker on a subsequent request. Inspect existing jobs when changing model, endpoint or project settings.

Installation, configuration and recovery commands are in the [README](../README.md).
