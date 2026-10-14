# Cursor bridge differences from cursor-agent

This package translates Chat Completions to Cursor's agent protocol. It is a
caller-MCP bridge, not full CLI parity. The boundaries below describe the
implementation and synthetic offline evidence. They do not certify live model
behavior or the installed Magpie/Pi host; those gates require separate checks.

| Area | Implemented behavior | Boundary / difference |
| --- | --- | --- |
| Initial history | Imports Chat messages into AI SDK transcript blobs with ordered instructions, reasoning, attachments and historical results. Assistant strings, text/reasoning arrays and split pieces share one display projection; fragments concatenate without added separators. | Display reasoning is not authentic native thinking state. No thinking signatures are invented. |
| External tool loop | Retains one native Run across matching external tool/result roundtrips, sends native McpResult to the original numeric exec ID, then exec close. HTTP/1 appends are serialized and numbered. | Local at-most-once submission while retained, without a server result ACK. No guarantee of exactly-once execution by the external client. |
| Native state | The background reader stays active while parked, stores incoming blobs before ACK, and retains latest checkpoint bytes and known reference closure. | Unknown/reference-bearing checkpoint forms disable closure claims. No disk recovery, cross-process resume or restart from checkpoints. |
| New user turn | Starts a fresh Run with imported completed Chat history, preserving conversation routing when a cache/session key is available. | Native UserMessageAction/checkpoint reuse across completed Runs is not implemented. |
| Continuation boundary | Credential fingerprint, model, controls, tool definitions, selector, accepted history, assistant call set and complete result batch must match. | Pending account changes, branches, compaction, lost owners and expired results return errors; no silent fresh-Run fallback. Completed history followed by a new user may be imported across accounts. |
| Parallel tools | Validates the full declared batch before publishing any tool calls; all results must return together. | No partial result submission. Field-27 counts use observed per-step semantics; cumulative or changed protocol semantics are not guessed. |
| Streaming | Ordinary text/thinking is progressive. Complete tool batches validate before publication. Errors known at prefetch return their HTTP status before response creation, with diagnostics. | Required/named choices and `parallel_tool_calls:false` buffer all step output. Later failures use SSE errors after visible display text. Buffering can add latency. |
| Cancellation | Request abort and response cancellation close the owned transport, unblock the reader and clean up heartbeat/deadline resources. Already-aborted openers do no transport work; a late transport bound after cancellation closes immediately. Cancelling cached replay leaves the active owner and its handles intact. | External tools already handed to the Chat client cannot be stopped by this bridge. Their late results are rejected. |
| Outbound transport | A shared FIFO bounds queued and in-flight frames on HTTP/1 and HTTP/2, including KV replies and Run/exec heartbeats. Writes wait for callback and drain; HTTP/1 callbacks wait for append completion. | Admission overflow fails the owner with 503. Result outcome uncertainty never authorizes another submission or an exec close after a failed append. |
| Tool scope | Caller-defined MCP function tools, with safe names/IDs and valid JSON object arguments. All MCP argument envelopes validate before exec processing; identical decoded envelopes produce one call. Native Value/Struct/List decoding validates complete tails and typed fields recursively, with byte/field/depth bounds and protobuf defaults. Text/image ordering and supplied tool error flags are preserved in native results. | Repeated MCP envelopes with differing decoded identity or arguments return 502; selection/merge semantics are unsupported. Native shell, filesystem, web search, approvals and foreign interaction paths fail explicitly. Supplied schemas are forwarded; strict schema enforcement is unsupported. |
| Instructions | System/developer messages retain relative position; tool catalog is a separate leading message. | Developer uses system-role equivalence, disclosed through `developer_as_system`. Separate developer/system precedence is unavailable in this path. |
| Images | Base64 PNG/JPEG/GIF/WebP in user/tool messages, 10 MiB each and 20 MiB per request, also subject to retention bounds. Encoding and declared MIME signatures are checked. The exact Pi `Attached image(s) from tool result:` user suffix joins one complete tool result and preserves image order. | Parallel Pi image aggregation loses call attribution and returns a field-specific 400; put each image in its tool message. Extra/new user text and incomplete batches remain blocked while native results are pending. Remote images, file/audio/video input and unknown parts are rejected. Signature checks are not full decoding; offline bytes do not prove live image understanding. |
| Generation controls | Tool selection/cardinality are validated, reasoning uses picker parameters, and effective model/parameters/mode are disclosed. | Sampling and token caps are accepted as ignored advisories. Token caps are **NOT enforced**. Nonempty stop, JSON output, deterministic seeds, positive logprob requests, nonempty token bias, nonzero penalties, multiple completions and strict tool schemas are rejected. |
| Thinking off | `none`/`off` selects an actual served off variant at the requested context/tier or returns `unsupported_reasoning_effort`. Catalog `none` exists only for a served off variant. | The observed Opus/Sonnet 5.5 picker has no off variant; Haiku 5.5 has `thinking=false`. No blanket Claude override. Account/catalog changes can change availability; client catalog refresh is required. |
| Token accounting | Handoffs report zero pending usage. Final native input/output/cache/reasoning totals, including explicit zero, count once. Completed retry replay bills zero. | Missing native input/output fields may be estimated with `usage.magpie_native.accounting: "estimated"`. Failed/cancelled usage may remain unknown. No production dashboard debt collection. |
| Legacy helpers | The old stateless decoder/dashboard ledger remains a compatibility/testing seam, with claims, carry, debt and collections scoped by credential fingerprint and conversation. | Its `magpie_deferred` tests describe legacy behavior, not production same-Run accounting. |
| Diagnostics | JSON / first SSE assistant chunk contains `magpie_cursor` policy version, effective model, advisories and continuity. Response headers expose model resolution and continuity. Contract input errors include code/param. Thinking-only `true` maps exactly to `high`, and `false` to `none`; only actual effort differences get a fitted advisory. | Advisories identify ignored/fitted behavior; they are not enforcement guarantees. |

## Retention limits

The process-local owner in `native-session.mjs` enforces these current defaults:

| Resource / deadline | Bound |
| --- | --- |
| External result wait | 120 seconds |
| Absolute Run lifetime | 15 minutes |
| Declared tool batch completion | 30 seconds |
| Final TurnEnded drain without an end frame | 6 seconds |
| Completed/failed replay retention | 120 seconds, subject to admission pressure |
| Blob/checkpoint bytes per Run | 64 MiB |
| Retained request/output bytes per Run | 16 MiB |
| Native MCP argument message | 1 MiB, 100,000 protobuf fields across the recursive tree, 64 Value nesting levels |
| Outbound queued/in-flight Connect frames per Run | 16 MiB / 256 messages |
| Contract step buffer | 16 MiB |
| Retained owners per credential / process | 8 / 32 |

Admission may forget completed replay entries; it preserves unrelated active
Runs. A host reload loses pending owners. A failure after native result submission
can have an uncertain outcome, so retrying it never submits the result again.
The outbound budget counts encoded Connect frames through write completion and
drain. HTTP/1 hex/envelope encoding adds transient memory for its single active
append; it cannot accumulate one envelope per queued message. Error flags must
be present in the caller's Chat tool messages; omitted flags cannot be restored.

## Offline evidence

- `native-e2e.test.mjs`: loader.fetch, one Run through two external roundtrips,
  omitted protobuf zero exec IDs, complete parallel batches, parked blob/checkpoint
  handling, limits, cancellation, branch/account/history rejection, completed
  history import with text-part arrays, canonical assistant display, saved actual
  Pi `convertMessages` payload completing one screenshot Run, parallel image
  ambiguity, strict nested protobuf values,
  outbound queue/backpressure limits, diagnostics and progressive streaming.
- `native-http1.test.mjs`: one RunSSE, serialized BidiAppend result-before-close,
  stalled parked KV queue bounds, and uncertain result failure in JSON/streaming
  requests with HTTP status preservation and no close/retry submission.
- `native-session.test.mjs`: storage/ACK errors, checkpoint closure, malformed
  protocol, owner admission/finalization, late cancellation bind, shared KV/heartbeat
  queue admission and independent MCP result decoding.
- `chat-contract.test.mjs`: ordered instructions/reasoning, multimodal/error
  results, input/option validation, complete-step guard and invalidation.
- `context.test.mjs`: account/context/tier off capability, catalog `none` and
  exact served off parameter selection, with non-off/legacy model compatibility.
- `latency.test.mjs`: one Run across two or six tool steps; no dashboard waiting,
  no estimated pending prompt at handoffs, final cache totals and zero replay
  billing. Its scheduling bounds are offline regressions, not live performance
  improvement measurements.
- `stepusage.test.mjs` / `deferred-usage.test.mjs`: legacy compatibility and
  account isolation; these helpers are not the production usage path.

All Cursor fixtures block external network traffic and use synthetic data.
Independent review and direct/native plus real Magpie/Pi host live continuation
and catalog gates remain required before installation or release. Local enterprise
allowance policy is separately owned and is not changed by this integration.
