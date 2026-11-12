# SAP AI Core plugin for Magpie

Connect your coding agent through Magpie to existing SAP AI Core deployments. The plugin handles SAP sign-in and token renewal without giving SAP credentials to your agent.

## Supported models

GPT discovery accepts model names with major version **6 or higher**, including minor versions and variants (for example, `gpt-6-mini`, `gpt-6.2`, or `gpt-7-mini`). No fixed model-name or backend-version allowlist is required. Deployments must still be `RUNNING` under `foundation-models` / `azure-openai`, with matching configuration, active backend, and non-deprecated/non-retired catalog version evidence.
Claude discovery is contract-based, not a fixed name list: any running `foundation-models` / `aws-bedrock` Claude deployment that satisfies SAP's documented Bedrock Messages contract is exposed under a conventional ID derived from its model metadata, so a newer compatible model/version needs no plugin release. The live-verified Claude baselines are `claude-opus-4-8` and `claude-sonnet-4-6`. Additional GPT models pass the version-floor policy; additional Claude models are supported by contract. Their live inference, optional capabilities, and limits remain unverified until exercised against a real deployment. SAP's [Responses API documentation](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/responses-api-a40ffca.md) notes that not all models support Responses; discovery eligibility alone does not prove compatibility.


Gemini discovery accepts generation model names such as `gemini-3.8-flash` and newer numbered releases, under `foundation-models` / `gcp-vertexai`. Configuration, backend active version and catalog evidence must agree; the matched version must explicitly support streaming. Embedding models are excluded. There is no tested-model or deployment allowlist.

When several eligible deployments share one discovered model ID, the highest active backend version wins for every vendor. Versions compare numerically, so `10` outranks `2` and leading-zero padding like `01` ties with `1`. A tie on version falls back to the lowest deployment ID. Metadata and capabilities come from that selected version. Several backend versions of the same Claude model are eligible together and resolve the same way. Distinct raw SAP identities that map to one ID merge only with matching authoritative metadata and compatible version and contract facts, and otherwise fail discovery with a conflict.

All three families use the same `sap-aicore` provider, account and token lifecycle: GPT uses OpenAI Responses, Claude uses native Anthropic Messages on Bedrock, and Gemini uses native Vertex AI `generateContent` / `streamGenerateContent`. Gemini's first milestone targets Magpie coding agents: text, streaming, local function tools with signed history, inline images, and structured JSON. Thinking controls/UI are best-effort at the gateway; the plugin preserves native thought parts separately from answer text.

**Gemini host prerequisite:** Signed Gemini tool loops require a host that forwards signed text parts and signed thought history to the plugin unchanged. A host that rewrites or drops signed parts breaks the native tool loop. The plugin never reconstructs signed parts or repairs host-modified history.

A GPT-5.x or lower-major deployment you already run stays in SAP AI Core but is not discovered or selectable through this plugin; the plugin never upgrades, migrates, or deletes it. Newer eligible GPT (major version 6 or higher) and compatible Claude deployments appear automatically, with no plugin release.

GPT forwards native Responses fields to AI Core without generation/content allowlists, including Codex `client_metadata` and unknown extensions, and translates the Codex tool surface (`namespace` qualification and `custom`/freeform tool translation, including paired `custom_tool_call` / `custom_tool_call_output` history) to the native function tools SAP accepts, restoring original identities in JSON and SSE replies. Unsupported hosted tools (such as `web_search`), malformed or unpaired custom-call history, and unsatisfiable required/forced `tool_choice` values fail locally with HTTP 400 rather than being silently omitted or relaxed. AI Core validates model-specific support; forwarding does not guarantee tool execution or backend acceptance. Discovery still advertises image capability from catalog `inputTypes`, but GPT does not locally reject image requests based on that flag. Claude and Gemini retain their model-capability gates: base64 image blocks (`Messages`) and `inlineData` parts (Gemini) require catalog image support. All current GPT-6 and Claude deployments tested advertise image.


## Before you start

You need:

- Magpie installed, with Bun available for its plugin host.
- SAP AI Core on the **extended** service plan and a **client-secret** service key.
- An existing **RUNNING** supported deployment in your selected resource group, under `foundation-models` / `azure-openai` (GPT), `foundation-models` / `aws-bedrock` (Claude), or `foundation-models` / `gcp-vertexai` (Gemini).

Installation does not create service keys, resource groups, or deployments. See SAP's [service plans](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/service-plans-c7244c6.md) and [deployment guide](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/create-a-deployment-b32e7a8.md).

## Quick start

### 1. Create your credential file

Save a JSON file outside this repository, for example `~/aicore-credentials.json`:

```json
{
  "authUrl": "https://your-tenant.authentication.eu10.hana.ondemand.com",
  "baseUrl": "https://api.ai.prod.eu10.hana.ondemand.com",
  "clientId": "sb-your-client-id",
  "clientSecret": "your-client-secret",
  "resourceGroup": "your-resource-group"
}
```

Use your service key's values, not the example URLs. `authUrl` excludes `/oauth/token`; `baseUrl` excludes `/v2`. Choose the resource group containing your supported deployments. [Credential field mapping](docs/credentials.md#service-key-mapping) explains where to find each value.

Protect the file:

```sh
chmod 600 ~/aicore-credentials.json
```

### 2. Install and sign in

```sh
magpie plugin add /absolute/path/to/magpie_aicore
magpie plugin login sap-aicore
```

When prompted, enter the **absolute path** to your credential file. Sign-in checks the credentials with SAP before saving the account.

For a released community version, install `@magpie-community/opencode-sap-aicore-auth` instead of the local folder. New packages are available through the community repository's `dist` channel after merge, even before their first npm publication (requires Magpie 0.1.1243 or newer).

This package uses the OpenCode plugin shape, but its credential-file sign-in and account-scoped mixed-protocol catalog are verified in **Magpie only**. Standalone OpenCode compatibility is not claimed.


### 3. Start the gateway

```sh
magpie serve
```

## Use with your coding agent

Configure your agent to use the gateway address and caller authentication configured in Magpie. Select a discovered `sap-aicore/<model-id>`, such as one of the baselines above.

Pick the protocol that matches the model: GPT models speak OpenAI Responses (call the gateway directly, or use Magpie's Chat Completions conversion), Claude models speak native Anthropic Messages, and Gemini models speak native Gemini on `/v1beta/models/sap-aicore/<model>:generateContent` or `:streamGenerateContent?alt=sse`. The plugin implements no cross-protocol converter — use a matching native client. See the [API reference](docs/api-reference.md) for curl examples and tool-history requirements per protocol.

## Credentials and accounts

Magpie remembers the credential-file reference; SAP tokens stay in memory and renew automatically. Keep the file available at the same path.

For multiple credential files or resource groups, sign in each absolute path separately. After rotating credentials, sign in again; restart any other running gateways that need the updated credentials. See [accounts and credential updates](docs/credentials.md#accounts-and-credential-updates).

## Multiple accounts and routing

Sign in each credential file as a separate account. Magpie then routes and fails over across them automatically.

```sh
magpie plugin login sap-aicore   # enter ~/aicore-a.json
magpie plugin login sap-aicore   # enter ~/aicore-b.json
magpie accounts sap-aicore       # confirm both are listed
```

### Choosing a routing mode

The plugin does not report SAP quota windows to Magpie, so quota-aware modes (`smart`, `pace`) have no SAP data to weigh and behave like `order`. Use one of the two recommended modes:

| Situation | Recommended setup | Command |
|---|---|---|
| One primary account, others as backup | `routing=order` + `stays=session` | `magpie provider set sap-aicore routing=order` |
| Several concurrent coding sessions | `routing=usage` + `stays=session` | `magpie provider set sap-aicore routing=usage` |

`stays=session` keeps each conversation on the account that answered its first turn, so tool loops and follow-up turns stay together and do not jump accounts mid-session. New sessions are spread across accounts by recent load.

Enable sink so a rate-limited account moves to the back immediately instead of being retried:

```sh
magpie provider set sap-aicore sink=on
```

### What multiple accounts protect against

| Setup | Benefit | Limit |
|---|---|---|
| Different credential files, same resource group | Separate credential identities; one credential failure leaves others working | Same SAP deployments and quota |
| Different resource groups, same tenant | Separate deployments and workloads | Tenant-level model rate limits are shared by default |
| Different tenants | Quota and credential isolation | Shared hyperscaler capacity or regional outages can still affect both |

SAP rate limits are tenant-wide and reset per minute. A 429 response can mean the tenant quota is exhausted, a resource-group limit is hit, or the backend is temporarily saturated — account rotation does not help when the limit is tenant-wide. See SAP's [rate limit documentation](https://github.com/SAP-docs/sap-artificial-intelligence/blob/main/docs/sap-ai-core/generativeAI/rate-limit-management-6cbc230.md) for quota management and increase requests.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Sign-in fails | Absolute file path, JSON fields, service-key values, and service URLs. |
| No models appear | Resource group, deployment status, model eligibility, and matching active-version evidence. |
| A selected model is unavailable | Deployment status or version may have changed; refresh discovery or restart the gateway. |
| Unsupported parameter | Check the [supported request fields](docs/api-reference.md#request-fields). |

See [troubleshooting](docs/troubleshooting.md) for account selection, errors, and gateway constraints.

## Live run record

Authorized, credential-redacted live verification on 2026-11-03 (plugin `0.2.3`, Node `v26.13.0`), dispatched through the plugin's own `auth.loader().fetch` to real SAP AI Core in an existing resource group with isolated temporary stores. This exercises the plugin-to-SAP dispatch path, not the installed Magpie gateway process; the gateway journey is recorded separately in the [source project](https://github.com/caikn/magpie-plugin-aicore/issues/14). No tokens, client secrets, resource-group names, or deployment URLs are shown; eight synthetic generations were used.

| Scenario | `gpt-6-astra` (Responses) | `claude-opus-4-8` (Messages) |
|---|---|---|
| Plain text | HTTP 200, `completed`, usage 14→8 | HTTP 200, `end_turn`, usage 29→17 |
| Streamed | HTTP 200, incremental `output_text` deltas, `response.completed` | HTTP 200, incremental deltas, `stop_reason: end_turn`, `message_stop` |
| Forced tool call | `function_call verify_value {"value":7}` | `tool_use verify_value {"value":7}` |
| Tool-result continuation | HTTP 200, `completed`, "The result is 14." | HTTP 200, `end_turn`, "…returned **14** (7 doubled)." |

Each request carried the account's SAP Bearer and resource-group header injected by the loader; the caller's gateway key was never forwarded. This single dated run is not a quota, latency, or billing guarantee, and does not cover token expiry/renewal, 429/quota exhaustion, reauthorization races, or reasoning-signature replay.


## Limitations and security

- Only running deployments are exposed. GPT requires major version 6 or higher, not a fixed model/version list; Claude is accepted by the documented SAP Bedrock Messages contract (`foundation-models` / `aws-bedrock`); Gemini requires the generation-family native Vertex contract (`foundation-models` / `gcp-vertexai`) with matching active-version evidence and explicit streaming support. Existing GPT-5.x and lower-major deployments remain in SAP but are never listed, upgraded, or deleted.
- GPT delegates generation-control and content validation to AI Core, preserving every request field except retained stateless defaults/guards, and translates Codex's tool surface (reversible namespace qualification and custom/freeform tool translation) to native function tools SAP accepts while rejecting unsupported hosted tools and untranslatable custom history locally. Claude and Gemini remain limited to their documented native text/function/image contracts (Claude also: signed thinking and `cache_control`; Gemini: signed model parts, structured JSON and thinking configuration). Their image input is catalog-gated, and unsupported audio/video/hosted-tool shapes are rejected locally. Gemini signed tool loops require a host that forwards signed parts and thought history unchanged; thinking controls/UI remain best-effort.
- No deployment management, server-side conversation storage, or automatic model substitution. Gemini built-in code execution, URL context, Google Search, `countTokens`, explicit caching, audio/video and remote file references are outside this milestone; unsupported requests are rejected rather than converted or retried by the plugin.
- Capability status differs by evidence: the GPT pair and the two Claude baselines are directly verified; other eligible models' live inference, optional reasoning controls, and context/output limits are **not** verified until exercised against a real deployment. Being listed never asserts completed live acceptance.
- Keep credentials outside the repository. Never use a SAP client secret or access token as the agent's gateway key.
- Local cancellation does not guarantee SAP computation or billing stops. Magpie may retry failed requests; do not assume exactly-once generation.
- MIT licensed; not affiliated with or endorsed by SAP. The license does not grant SAP productive-use approval.

## Changelog

### 0.4.1

Breaking changes:

- GPT generation and content validation moved to AI Core. The plugin applies no local generation or content allowlists, and no longer rejects image requests locally based on the catalog image flag.
- `namespace` and `custom`/freeform tools (along with paired `custom_tool_call` and `custom_tool_call_output` history) are translated to native function tools before dispatch and restored in JSON and SSE replies.
- Unsupported hosted tools such as `web_search`, malformed or unpaired custom-tool history, and unsatisfiable required/forced `tool_choice` targets are rejected locally with HTTP 400 instead of being silently omitted or relaxed.
- Discovery selects the highest active backend version for every vendor when several deployments share one model ID, with the lowest deployment ID breaking a tie. Several backend versions of one Claude model are now eligible together.

## More information

- [Credentials and accounts](docs/credentials.md)
- [API reference](docs/api-reference.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](https://github.com/caikn/magpie-plugin-aicore/blob/main/docs/development.md)
- [Community publication](https://github.com/caikn/magpie-plugin-aicore/blob/main/docs/publication.md)
