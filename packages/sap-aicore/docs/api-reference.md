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

GPT requests are transparently forwarded to the selected AI Core deployment: every top-level field, including `client_metadata`, `text`, `parallel_tool_calls`, `truncation`, and unknown protocol extensions, is retained. Generation controls, tool definitions, nested history/content, image detail, and model-specific combinations are validated by AI Core rather than local allowlists. The plugin does not strip telemetry, convert Chat fields, or execute tools; only the Codex tool surface (`namespace` flattening, `custom`/non-function tool drop, `tool_choice` adaptation, and orphaned custom-tool history removal) is translated before dispatch. Forwarding a shape does not advertise backend support or guarantee that the client/gateway can execute its complete tool loop. Model discovery still advertises image capability only when the catalog reports it; GPT image requests are not rejected locally based on that advertisement.

Earlier live probes accepted reasoning `effort:low|medium|high` with optional `summary:auto`, cache keys, and output budgets of 1024 and 128000. These are observations, not local restrictions or a maximum-generation guarantee. Other values reach backend validation unchanged; cache-key acceptance does not guarantee cache hits.

Local guards still require a JSON-object body, a non-empty routing `model`, and boolean `stream` when supplied. `store:false` is supplied when omitted; any other explicit `store` value is rejected. Explicit `background:false` is accepted; other values, `previous_response_id`, and `conversation` are rejected. Lifecycle routes, separate compaction routes, and WebSocket transport remain unsupported. Chat Completions routes remain unsupported at the plugin; fields received on `/responses` are forwarded without conversion, including `prompt` references and unknown fields. Native backend failures retain their status and error details with existing credential redaction, without inference retries.

## Function tools and history

Native function tools and their call/output history are forwarded unchanged. For richer client harnesses such as Codex, each `namespace` container is flattened to qualified native functions: `collaboration.spawn_agent` is sent as `collaboration__spawn_agent`. Functions with the same bare name in different namespaces remain distinct; native names are reserved unchanged. Identical repeated declarations of the same namespaced function emit one tool; conflicting definitions or malformed namespaces are rejected before dispatch. Ambiguous or overly long qualified names use deterministic bounded aliases. A per-request reverse map restores the original `name` and `namespace` in JSON output, SSE output items and terminal responses, including incomplete and failed output. Argument-completion events also restore their name/namespace when their item ID and alias match a restored call in that stream. Restored calls receive an empty `encrypted_function_args` list when absent so Codex treats arguments as plaintext. Replayed namespaced calls and forced function choices use the same mapping; replay removes namespace fields and empty plaintext markers before SAP dispatch. Call IDs, arguments and opaque reasoning remain unchanged.

`custom`/freeform and other non-function tools are dropped, along with orphaned `custom_tool_call`/`custom_tool_call_output` history. Native `tool_choice` restrictions, unknown shapes and undeclared targets remain unchanged for backend validation. Choices referencing translated functions are qualified. For `allowed_tools`, only entries referencing declared dropped tools are removed; surviving entries, `mode` and extension fields are preserved. A choice left with no supported target becomes `"auto"` when function tools remain, otherwise it is omitted. When all declared tools are dropped, `tools` and a `"required"` choice are removed; unrelated choices remain intact. This translation is stateless and does not execute tools. The agent executes surviving functions and must preserve `call_id` separately from the output item's `id`.

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

The discovered Opus 4.8 version `1` rejects explicit `temperature`, `top_p`, and enabled/fixed-budget thinking locally. Sonnet 4.6 version `1` rejects combined `temperature` plus `top_p`, and enabled thinking with forced tool use; either sampling setting individually and fixed-budget thinking are retained. Both baseline versions advertise and enforce `max_tokens <= 128000`; this is not a maximum-length generation guarantee. Newer releases or active versions do not inherit these restrictions or limits: structurally valid recognized controls reach upstream validation. No sampling defaults are injected. Unknown body/tool fields, non-image multimodal content, and hosted tools are rejected; base64 image blocks are accepted only when the matched catalog version advertises image input. Client-only `metadata` (including `metadata.user_id` session tracking) is accepted and silently removed before both whole-reply and streaming Bedrock dispatch; it is not forwarded upstream. Two explicit boolean client-only tool hints, `eager_input_streaming` and `defer_loading`, are accepted and removed before Bedrock dispatch; they are not native tool capabilities.

Agent-executed continuation resends the original messages, the complete returned assistant `content` array in order (text, `tool_use`, signed `thinking` including empty text, `redacted_thinking`), and a user message of `tool_result` blocks paired by the original `tool_use.id`. The agent executes tools; the plugin neither executes them nor repairs reasoning. Each `tool_result.content` may be a string or an array of text/base64-image blocks, with images subject to the same model-capability gate and source validation as user attachments. Other nested content types remain unsupported. Image tool results are covered by mocked transport tests, not a live SAP round-trip. A rejected signature or mismatched result surfaces as an upstream error.

Streaming is accepted only when the matched catalog version explicitly reports support. SAP's data-only Anthropic SSE (`message_start`, `content_block_*`, `message_delta`, `message_stop`, `error`; no `event:` or `[DONE]` required) is relayed one bounded frame at a time. Text and `input_json_delta` tool arguments arrive incrementally. Successful completion requires a valid `message_start`, a `message_delta` carrying a non-empty `stop_reason`, and `message_stop`; a bare stop frame, malformed terminal state, or missing terminal is a failure.

## Gemini (native Vertex AI)

Gemini models are projected as `@ai-sdk/google`. Native clients put the model in the URL, not the request body:

```sh
curl "$MAGPIE_GATEWAY/v1beta/models/sap-aicore/gemini-3.8-flash:generateContent" \
  -H "Authorization: Bearer $MAGPIE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role":"user","parts":[{"text":"Reply with GEMINI_OK."}]}],
    "systemInstruction": {"parts":[{"text":"Be concise."}]},
    "generationConfig": {"maxOutputTokens":1024}
  }'
```

For SSE, use `:streamGenerateContent?alt=sse` and `curl -N`. The plugin receives `/models/<model>:generateContent` or `/models/<model>:streamGenerateContent?alt=sse` on the account root and appends the same model/action to the validated SAP deployment URL. Only the streaming action accepts the exact `alt=sse` query. Conflicting body `model`/`stream` selectors fail locally; both routing fields are removed before SAP dispatch. No Vertex project/location path or API-version query is added. Omit body `model`/`stream` fields for verbatim native request forwarding: validated model-in-path JSON is retained without re-encoding signed numeric arguments. Duplicate object keys, including escaped-equivalent keys and nested duplicates, are rejected before raw forwarding. Successful whole replies and SSE frames are likewise relayed without re-encoding their signed parts; explicit routing envelopes are serialized after their routing fields are stripped.

Supported native camelCase fields: `contents` (user/model roles with parts), text-only `systemInstruction`, `generationConfig`, function `tools`, `toolConfig.functionCallingConfig`, and `safetySettings`. Parts may carry text, opaque `thoughtSignature`, model-only boolean `thought`, `functionCall`, user `functionResponse`, or base64 image `inlineData` when the matched catalog version advertises image input. Function response text belongs in its JSON `response` object; optional image `parts` use the same eligibility gate. PNG, JPEG, WebP, HEIC and HEIF MIME types are recognized; audio/video and remote `fileData` references are rejected. The plugin never treats a thought summary as final answer text.

Generation configuration supports positive integer `maxOutputTokens`, `topK` and `candidateCount`, integer `seed`, finite `temperature`/`topP`/penalties, string `stopSequences`, `responseMimeType` (`text/plain` or `application/json`), one of `responseSchema`/`responseJsonSchema`, and `thinkingConfig`. Schemas and user-defined argument/result keys are preserved, not normalized. Thinking accepts `includeThoughts`, either integer `thinkingBudget >= -1` or `thinkingLevel: MINIMAL|LOW|MEDIUM|HIGH` (SDK lowercase forms are accepted and preserved too). These are structural checks, not promises that every model/version accepts each setting. SAP's native rejection is preserved; no inference fallback or retry is added.

Function declarations preserve `name`, optional `description`, one of `parameters`/`parametersJsonSchema` and one of `response`/`responseJsonSchema`. Calling modes are `AUTO`, `ANY`, `NONE`, or `VALIDATED`, with optional `allowedFunctionNames`.

### Gemini tool history

The agent executes the declared function locally. Send the original returned model content back unchanged, including every signed part and original function-call ID; append native function responses. Do not reconstruct signed parts, concatenate them, move signatures or discard opaque thought parts:

```js
const modelContent = reply.candidates[0].content
const results = modelContent.parts.filter(part => part.functionCall).map(part => {
  const call = part.functionCall
  return {
    functionResponse: {
      ...(call.id === undefined ? {} : { id: call.id }),
      name: call.name,
      response: executeFunction(call.name, call.args ?? {}), // JSON object
    },
  }
})
const continuation = {
  ...request,
  contents: [...request.contents, modelContent, { role: "user", parts: results }],
  toolConfig: { functionCallingConfig: { mode: "NONE" } },
}
```

For SSE, retain native signed parts in order while gathering the model turn. Native `candidates`, `finishReason`, `promptFeedback`, `usageMetadata`, `modelVersion`, signatures and other response metadata pass through at plugin fetch. Gemini finishes at a framed EOF after each observed candidate has a finish reason (or a native prompt block); it has no `[DONE]` marker. Usage-only frames after `finishReason` are retained. Missing finish reasons, partial trailing frames, invalid UTF-8/JSON, network failures and oversized frames yield a native Gemini error frame, never fabricated successful completion. Consumer cancellation cancels the owned upstream reader.

### Gemini host fidelity requirement

Signed Gemini tool loops require a host that forwards signed text parts and signed thought history to the plugin unchanged. A host that rewrites or drops signed parts breaks the native tool loop. The plugin never reconstructs signed parts or repairs host-modified history; it dispatches the validated model-in-path JSON without re-encoding signed numeric arguments. Thinking controls/UI and exact schemas or usage metadata can still be adapted by a host, so native plugin fidelity is not a byte-for-byte gateway guarantee.

Built-in `codeExecution`, `urlContext`, `googleSearch`, token counting, caching, audio/video and remote file input are outside this coding-agent milestone. They are rejected locally, not advertised as available. Native SAP HTTP errors for supported requests preserve status and message with credential echoes redacted. The direct-SAP observations in issue #38 (including model-specific Search/countTokens rejections) are not plugin/gateway acceptance or universal model capability claims.

References: [SAP native Vertex AI](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/vertex-ai-8bb3519.md), [Google inference](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference), [Google function calling](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/function-calling).

## Discovery and versions

The [supported model/version table](../README.md#supported-models) defines eligibility. Discovery reads the selected account's resource group, follows offset pagination, and reconciles configuration identity, backend active version, and catalog metadata. Only running supported deployments are exposed. A `latest` selector without a resolved supported backend version is insufficient. Deprecated or retired versions are excluded; the plugin never upgrades deployments. When several deployments resolve to one model ID, the highest active backend version wins for every vendor, compared numerically, with the lowest deployment ID breaking a tie. The chosen version supplies the entry's metadata, capabilities, and request policy. Several backend versions of the same Claude model resolve this way.

Successful discovery is cached for five minutes, including an empty list. Either monotonic elapsed time or wall-clock age can expire the cache, so system sleep does not extend its lifetime. Expiry, retirement, and account replacement invalidate it. Failed refresh does not authorize stale dispatch. Restart rebuilds the registry without requiring a prior client model-list request.

The two GPT baseline versions report catalog context length 1050000; the two Claude baseline versions report 1000000. These are catalog-derived, not stress-tested limits. Only the Claude baseline active versions `1` advertise the directly established output ceiling 128000. Missing version-specific limits remain unknown; the plugin does not derive prices. Distinct raw SAP identities can deduplicate only with matching authoritative Claude identity metadata and compatible version/contract facts; ambiguous collisions fail discovery. That alias check is stricter than same-model version selection, which merges backend versions of one raw identity without it.

## Upstream transport and streaming

Each model is accepted only on its own protocol's account-root route (GPT `/responses`, Claude `/messages`, Gemini `/models/<model>:generateContent` or `:streamGenerateContent?alt=sse`), POST only, with no fragment and no query except Gemini's exact streaming `alt=sse`; a model addressed through the wrong route fails before any inference credential is sent. Dispatch uses the validated returned deployment URL — plus `/responses` for GPT, `/invoke`/`/invoke-with-response-stream` for Claude, or `/models/<model>:generateContent`/`:streamGenerateContent?alt=sse` for Gemini — without an API-version query. Accepted deployment URLs must have the selected AI Core origin and `/v2/inference/deployments/<id>` path. SAP Bearer authentication and the selected resource group replace incoming SDK credentials; Magpie-only headers are stripped.

Native output items, identity, usage, status, error, and incomplete details remain distinct. SSE carries output text, function-argument, output-item, and completed/incomplete/failed events; no `[DONE]` marker is required. Individual bounded frames are decoded incrementally across UTF-8/network boundaries, not accumulated as a whole reply.

Magpie may request upstream streaming for whole clients and gather the result. It can adapt request fields, add a final-answer phase, and turn a failed terminal into a gateway HTTP error. Exact native fidelity applies at plugin fetch, not byte-for-byte across the gateway.

Observed with Magpie `0.1.2630` at the actual gateway: whole Claude clients use upstream SSE; cache breakpoints are added; `tools[].strict` is removed. Opus `temperature`/`top_p` and unsupported `top_logprobs` disappear before plugin validation. Enabled thinking on Opus and Sonnet becomes adaptive, without `budget_tokens`; Sonnet combined sampling loses `top_p`. A synthetic newer model loses both sampling fields but retains its larger output budget. Sonnet individual `temperature` is preserved, and baseline `max_tokens:128001` is rejected before SAP inference. These host adaptations conflict with end-to-end explicit-intent preservation: the plugin validates only what it receives, and does not repair or hide the host behavior. Exact native controls and strict-tool fidelity are verified separately through Bun IPC.

For `stop_sequence`, the plugin preserves both `stop_reason:"stop_sequence"` and `stop_sequence:"STOP"` through whole Bun IPC and raw native SSE. The installed gateway streamed client preserves them, but its whole-client gathering normalizes the reason to `end_turn`. The primary acceptance test records that host adaptation instead of treating it as native fidelity. Native failures may also become gateway HTTP errors and trigger account cooldown; another pinned account remains usable.

The gateway also rewrites Claude response `model` from the backend's canonical ID (for example `claude-opus-4-8`) to the provider-qualified request ID (`sap-aicore/claude-opus-4-8`) for both whole and streamed clients. Bun IPC whole/streamed replies preserve the backend ID. Gateway identity assertions record the prefixing while rejecting unrelated model IDs; this remains a response-identity fidelity gap against the spec.

Active operations default to a 120-second idle timeout and a separate 900-second total cap. The idle timer starts at request entry and resets when the plugin relays a stream chunk; active streams can therefore exceed two minutes, but stalls and the total cap still abort the owned request. Configure `idleTimeoutMs` and `totalTimeoutMs` on the plugin input or `config.provider["sap-aicore"].options`; positive numeric values are rounded down and bounded to 1–3600000 ms. A stalled streamed body reports `inference-idle-timeout`; the total cap and pre-stream timeout report `inference-timeout`. Request/whole bodies and individual frames remain bounded to 16 MiB; OAuth/discovery retain separate 15-second bounds. Cancellation aborts owned HTTP/body delivery, not necessarily SAP compute or billing.

The plugin sends one generation per fetch and adds no inference retries. Magpie's retries and routing failover remain independent; exactly-once generation is not guaranteed. See [troubleshooting](troubleshooting.md).

References: [SAP Responses API](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/responses-api-a40ffca.md), [SAP AWS Bedrock](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/aws-bedrock-6a81f85.md), [supported models](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/supported-models-509e588.md).
