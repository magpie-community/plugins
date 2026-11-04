# API reference

## Gateway request

Use the address and caller-key policy configured in Magpie. This is a gateway key, never a SAP credential.

```sh
MAGPIE_GATEWAY=http://127.0.0.1:3425 # replace with the address printed by Magpie
MAGPIE_KEY=magpie                 # replace if your caller-key policy differs
curl "$MAGPIE_GATEWAY/v1/responses" \
  -H "Authorization: Bearer $MAGPIE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sap-aicore/gpt-6-astra",
    "input": "Reply with RESPONSES_OK.",
    "store": false,
    "stream": false,
    "max_output_tokens": 1024
  }'
```

`stream:false` returns whole JSON; `stream:true` returns SSE. Chat clients can use Magpie's existing `/v1/chat/completions` conversion to Responses. The plugin implements no Chat transport or converter.

## Request fields

Supported fields include `model`, native text/history `input`, `instructions`, positive integer `max_output_tokens`, string `prompt_cache_key`, function `tools`, `tool_choice`, `stream`, and `include:["reasoning.encrypted_content"]`. When the selected model's catalog version advertises image input (`inputTypes` contains `image`), user-message `input_image` parts carrying a `data:` or `https:` `image_url` (optional `detail:auto|low|high`) are accepted and forwarded verbatim; text-only versions reject them. Live-verified: `gpt-6-astra` read a base64 PNG through `/responses`.

Reasoning accepts `effort:low`, `medium`, or `high`, optionally with `summary:auto`. Cache-key acceptance does not guarantee cache hits. Output budgets of 1024 and 128000 were accepted; this is not a maximum-length generation guarantee.

`store:false` is supplied when omitted. Explicit `background:false` is accepted. Stateful storage, `previous_response_id`, conversation references, background jobs, lifecycle requests, compaction, hosted tools, non-image multimodal input (audio, video, file references), and Chat request fields are unsupported. Unsupported fields fail rather than being silently removed.

## Function tools and history

Tools use native Responses function definitions with `name`, `parameters`, and supported `strict:true`. The agent executes tools; the plugin does not.

Continuation must preserve original input and every returned output item in order, including reasoning items and exact argument strings. Pair results using `call_id`, not the output item's `id`:

```js
const results = reply.output.filter(item => item.type === "function_call").map(item => ({
  type: "function_call_output",
  call_id: item.call_id,
  output: JSON.stringify(executeFunction(item.name, JSON.parse(item.arguments))),
}))
const continuation = {
  ...request,
  input: [...request.input, ...reply.output, ...results],
  store: false,
  tool_choice: "none",
}
```

Keep tools declared. Wrap string input as a user message before assembling history. When include is omitted for tools, reasoning, or reasoning history, the plugin supplies encrypted-reasoning inclusion; explicit supported arrays, including an empty array, remain unchanged. Live GPT probes returned no reasoning items, so genuine encrypted reasoning replay is not established.

## Claude (native Anthropic Messages)

Claude models use native Anthropic Messages, not Responses. Send to `/v1/messages`; Magpie rewrites it to the account root and the plugin dispatches to the deployment's Bedrock `/invoke` (whole) or `/invoke-with-response-stream` (streaming).

```sh
curl "$MAGPIE_GATEWAY/v1/messages" \
  -H "Authorization: Bearer $MAGPIE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sap-aicore/claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "Reply with MESSAGES_OK." }]
  }'
```

Supported fields: `model`, `messages`, string or text-block `system`, required non-negative integer `max_tokens`, `stop_sequences`, custom-function `tools` (`name`, `input_schema`, optional `description`, `type:"custom"`, `strict`, and `cache_control`), `tool_choice` (`auto`/`any`/`tool`/`none`), `temperature`/`top_p`/`top_k`, `stream`, and `thinking`. Enabled thinking requires a positive integer `budget_tokens`; disabled/adaptive thinking does not accept a budget. Recognized `thinking.display`, `thinking.block_binding`, and `output_config.effort` controls are structurally validated and preserved for upstream contract validation. Text-block `cache_control:{"type":"ephemeral"}` is accepted. When the selected model's catalog version advertises image input, user-message `image` blocks with a base64 `source` (`{"type":"base64","media_type":...,"data":...}`) are accepted and forwarded to Bedrock; non-base64 sources (such as `url`) and image blocks for text-only versions are rejected. Live-verified: `claude-opus-4-8` read a base64 PNG through `/invoke`. The routing `model` and `stream` selector are removed from the upstream body and `anthropic_version:"bedrock-2023-05-31"` is supplied; a conflicting body version is rejected.

The discovered Opus 4.8 version `1` rejects explicit `temperature`, `top_p`, and enabled/fixed-budget thinking locally. Sonnet 4.6 version `1` rejects combined `temperature` plus `top_p`, and enabled thinking with forced tool use; either sampling setting individually and fixed-budget thinking are retained. Both baseline versions advertise and enforce `max_tokens <= 128000`; this is not a maximum-length generation guarantee. Newer releases or active versions do not inherit these restrictions or limits: structurally valid recognized controls reach upstream validation. No sampling defaults are injected. Unknown body/tool fields, metadata, non-image multimodal content, and hosted tools are rejected; base64 image blocks are accepted only when the matched catalog version advertises image input. Two explicit boolean client-only tool hints, `eager_input_streaming` and `defer_loading`, are accepted and removed before Bedrock dispatch; they are not native tool capabilities.

Agent-executed continuation resends the original messages, the complete returned assistant `content` array in order (text, `tool_use`, signed `thinking` including empty text, `redacted_thinking`), and a user message of `tool_result` blocks paired by the original `tool_use.id`. The agent executes tools; the plugin neither executes them nor repairs reasoning. A rejected signature or mismatched result surfaces as an upstream error.

Streaming is accepted only when the matched catalog version explicitly reports support. SAP's data-only Anthropic SSE (`message_start`, `content_block_*`, `message_delta`, `message_stop`, `error`; no `event:` or `[DONE]` required) is relayed one bounded frame at a time. Text and `input_json_delta` tool arguments arrive incrementally. Successful completion requires a valid `message_start`, a `message_delta` carrying a non-empty `stop_reason`, and `message_stop`; a bare stop frame, malformed terminal state, or missing terminal is a failure.

## Discovery and versions

The [supported model/version table](../README.md#supported-models) defines eligibility. Discovery reads the selected account's resource group, follows offset pagination, and reconciles configuration identity, backend active version, and catalog metadata. Only running supported deployments are exposed. A `latest` selector without a resolved supported backend version is insufficient. Deprecated or retired versions are excluded; the plugin never upgrades deployments.

Successful discovery is cached for five minutes, including an empty list. Either monotonic elapsed time or wall-clock age can expire the cache, so system sleep does not extend its lifetime. Expiry, retirement, and account replacement invalidate it. Failed refresh does not authorize stale dispatch. Restart rebuilds the registry without requiring a prior client model-list request.

The two GPT baseline versions report catalog context length 1050000; the two Claude baseline versions report 1000000. These are catalog-derived, not stress-tested limits. Only the Claude baseline active versions `1` advertise the directly established output ceiling 128000. Missing version-specific limits remain unknown; the plugin does not derive prices. Distinct raw SAP identities can deduplicate only with matching authoritative Claude identity metadata and compatible version/contract facts; ambiguous collisions fail discovery.

## Upstream transport and streaming

Each model is accepted only on its own protocol's account-root route (GPT `/responses`, Claude `/messages`), POST only, with no query or fragment; a model addressed through the wrong route fails before any inference credential is sent. Dispatch uses the validated returned deployment URL — plus `/responses` for GPT, or `/invoke`/`/invoke-with-response-stream` for Claude — without an API-version query. Accepted deployment URLs must have the selected AI Core origin and `/v2/inference/deployments/<id>` path. SAP Bearer authentication and the selected resource group replace incoming SDK credentials; Magpie-only headers are stripped.

Native output items, identity, usage, status, error, and incomplete details remain distinct. SSE carries output text, function-argument, output-item, and completed/incomplete/failed events; no `[DONE]` marker is required. Individual bounded frames are decoded incrementally across UTF-8/network boundaries, not accumulated as a whole reply.

Magpie may request upstream streaming for whole clients and gather the result. It can adapt request fields, add a final-answer phase, and turn a failed terminal into a gateway HTTP error. Exact native fidelity applies at plugin fetch, not byte-for-byte across the gateway.

Observed with Magpie `0.1.2630` at the actual gateway: whole Claude clients use upstream SSE; cache breakpoints are added; `tools[].strict` is removed. Opus `temperature`/`top_p` and unsupported `top_logprobs` disappear before plugin validation. Enabled thinking on Opus and Sonnet becomes adaptive, without `budget_tokens`; Sonnet combined sampling loses `top_p`. A synthetic newer model loses both sampling fields but retains its larger output budget. Sonnet individual `temperature` is preserved, and baseline `max_tokens:128001` is rejected before SAP inference. These host adaptations conflict with end-to-end explicit-intent preservation: the plugin validates only what it receives, and does not repair or hide the host behavior. Exact native controls and strict-tool fidelity are verified separately through Bun IPC.

For `stop_sequence`, the plugin preserves both `stop_reason:"stop_sequence"` and `stop_sequence:"STOP"` through whole Bun IPC and raw native SSE. The installed gateway streamed client preserves them, but its whole-client gathering normalizes the reason to `end_turn`. The primary acceptance test records that host adaptation instead of treating it as native fidelity. Native failures may also become gateway HTTP errors and trigger account cooldown; another pinned account remains usable.

The gateway also rewrites Claude response `model` from the backend's canonical ID (for example `claude-opus-4-8`) to the provider-qualified request ID (`sap-aicore/claude-opus-4-8`) for both whole and streamed clients. Bun IPC whole/streamed replies preserve the backend ID. Gateway identity assertions record the prefixing while rejecting unrelated model IDs; this remains a response-identity fidelity gap against the spec.

Active operations default to a 120-second idle timeout and a separate 900-second total cap. The idle timer starts at request entry and resets when the plugin relays a stream chunk; active streams can therefore exceed two minutes, but stalls and the total cap still abort the owned request. Configure `idleTimeoutMs` and `totalTimeoutMs` on the plugin input or `config.provider["sap-aicore"].options`; positive numeric values are rounded down and bounded to 1–3600000 ms. A stalled streamed body reports `inference-idle-timeout`; the total cap and pre-stream timeout report `inference-timeout`. Request/whole bodies and individual frames remain bounded to 16 MiB; OAuth/discovery retain separate 15-second bounds. Cancellation aborts owned HTTP/body delivery, not necessarily SAP compute or billing.

The plugin sends one generation per fetch and adds no inference retries. Magpie's retries and routing failover remain independent; exactly-once generation is not guaranteed. See [troubleshooting](troubleshooting.md).

References: [SAP Responses API](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/responses-api-a40ffca.md), [SAP AWS Bedrock](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/aws-bedrock-6a81f85.md), [supported models](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/supported-models-509e588.md).
