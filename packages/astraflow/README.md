# @magpie-community/opencode-astraflow-auth

[AstraFlow](https://astraflow.ucloud.cn/) (UCloud ModelVerse) with your own
ModelVerse API key or UCloud OAuth2, regional endpoints and dynamic
conversational models. Provider id: `astraflow`. Supports native Chat
Completions, OpenAI Responses, Anthropic Messages and Google Gemini; magpie can also
translate its clients' protocols to the selected upstream API.

## Use in magpie

After the first npm release, install the package and sign in:

```sh
magpie plugin add @magpie-community/opencode-astraflow-auth
magpie plugin login astraflow
```

The package has not been published yet. Until the first release, use the
local development installation below. `astraflow` is the provider ID used
for sign-in, not an installation URL.

Choose **AstraFlow / ModelVerse API key**, select an endpoint and protocol, and paste a
key created in the [ModelVerse console](https://console.ucloud.cn/modelverse/experience/api-keys).
This is a ModelVerse API key, not a UCloud access key / secret key pair.
The endpoint is saved per account; separate accounts may choose different
regions. To change one, sign in to that account again and choose its endpoint.

Choose **AstraFlow CLI configuration (read-only import)** to reuse the
inference key from the official CLI. It supports named configurations,
`ASTRAFLOW_CONFIG`, the CLI default, legacy `credentials.json`, an explicit
absolute file, and `ASTRAFLOW_API_KEY` / `MODELVERSE_API_KEY`. Explicit named
configuration takes precedence over environment keys; environment keys take
precedence over the default and legacy configuration. `ASTRAFLOW_HOME` and
the CLI's platform-specific configuration directory are supported.

This copies a snapshot of the inference key and its allowlisted regional
endpoint. It never scans the workspace, changes CLI files, repairs permissions,
or imports CLI OAuth access/refresh tokens. Private file permissions and
regular-file checks apply; unsafe files fail with a diagnostic. CLI `all`
protocol defaults to Chat; protocol-specific CLI configurations retain their
protocol. Sign in directly instead when ongoing OAuth renewal is needed.

Alternatively choose **UCloud OAuth2 (browser, select project and key)**:

1. Select the inference endpoint, upstream protocol and account registration
   (**UCloud China** or **UCloud Global**). Registration and inference region
   are separate: a China account can use an overseas inference endpoint.
2. Sign in on UCloud's authorization page. The plugin listens only on
   `127.0.0.1`, on a random port, with a five-minute deadline. UCloud returns
   to `http://localhost:<port>/authorization`.
3. Choose one of your accessible projects and an enabled ModelVerse key in
   the callback page. Disabled, expired and sandbox-only keys are excluded;
   an existing key is checked again before sign-in. Secret
   key values and OAuth tokens are never rendered into that page. The local
   Chinese page shows both steps, offers project search for large accounts,
   and lets you return to project selection before connecting a key.
4. If you want a new key, expand **创建新的 API Key** and press **创建并登录**.
   As in the official CLI, this requests access to all ModelVerse models and
   sends `SandBoxDisabled=1`. UCloud's SDK marks the Sandbox switch as
   currently ineffective, so check actual Sandbox permissions in the console;
   this plugin cannot guarantee they are disabled. Choosing an existing key creates no resources.
   A failed creation is not retried automatically; check the console before
   trying again if the request's outcome was uncertain.

For a remote/headless Magpie, choose **UCloud OAuth2 (manual callback /
remote host)**. Enter a project ID (blank uses the default project) and an
existing key ID, or explicitly select creation and name the new key. After
authorizing, paste the **complete localhost callback URL** into Magpie,
including `code` and `state`; a bare code is rejected. The callback page
may not load when your browser runs on another machine, but its URL is
still usable. A blank existing-key ID only succeeds when exactly one
enabled key is available; multiple keys require a selection.

OAuth uses the desktop client ID and application secret embedded publicly
in the official AstraFlow CLI. It requests the CLI's
`openid email offline_access full_access` scopes, authorization-code grant
and refresh-token grant. The upstream CLI does not use PKCE; this plugin
matches that verified flow and checks the random state and callback URL.
These are application credentials, not your ModelVerse inference secret.

OAuth access tokens authorize UCloud's control plane (projects, keys and
balance); inference always uses the selected ModelVerse key. Magpie stores
both in its existing auth store. Tokens renew five minutes before expiry,
with concurrent renewal requests coalesced and rotated refresh tokens
persisted. Loader and usage renewal re-read live credentials before saving,
so a sign-out or changed sign-in observed during renewal takes precedence.
The models hook receives a snapshot and leaves renewal to Magpie's host.
Transient renewal errors may use a still-valid token; revoked
grants or expired tokens report failure. A direct API key needs no OAuth.

| Selection | Region id | API host |
| --- | --- | --- |
| China, unified (default) | `china` | `api.modelverse.cn` |
| Overseas, unified | `global` | `api.umodelverse.ai` |
| Wulanchabu | `wulanchabu` | `api-cn-wlcb.modelverse.cn` |
| Shanghai 2 | `shanghai` | `api-cn-sh2.modelverse.cn` |
| Singapore | `singapore` | `api-sg.umodelverse.ai` |
| Los Angeles | `los-angeles` | `api-us-ca.umodelverse.ai` |
| Frankfurt | `frankfurt` | `api-ge-fra.umodelverse.ai` |

The unified hosts are recommended by UCloud and can switch to a backup
region via DNS. The fixed regional hosts stay in their region. The plugin
does not switch hosts or retry paid requests itself.

## Models and requests

The models hook reads the selected endpoint's `GET /v1/models` with
`Authorization: Bearer <key>`; Gemini uses `GET /v1beta/models` and includes
only models advertising `generateContent` via `supportedActions` or
`supportedGenerationMethods`. Gemini `nextPageToken` pages are followed;
invalid or repeated tokens fail the refresh rather than return a partial list.
OAuth accounts optionally read
`ListUFSquareModel` to enrich existing models and `ListUMInferAPIKey` to apply
an explicitly restricted selected key's model grants. The square catalog
never adds models absent from inference discovery. Optional control-plane
permission failures keep inference discovery available. A successful refresh replaces the model
list, so additions and removals follow AstraFlow. There is no shared
cross-account model cache. Failed requests, invalid JSON and empty chat
lists throw an error: magpie can retain its previous list and show the
refresh failure. HTTP 401 marks the sign-in expired; permission and quota
errors keep their upstream reason.

The provider has one bootstrap model (`deepseek-v4.1-flash`) so hosts that
require a configured model can show it before sign-in. It is replaced on
the first successful discovery and does not promise that your key has
permission to use that model. The public catalog itself also does not
prove permission: keys can have model, spending and IP restrictions.

The current listing includes non-chat products without protocol or
modality fields. The plugin follows the official AstraFlow CLI's name
filter to omit image/video/audio generation, embeddings, rerankers,
document processing, batch jobs, and dedicated search/translation models.
The [Nano Banana image-generation family](https://ai.google.dev/gemini-api/docs/image-generation)
is also excluded when its model ID has no `image` suffix.
Live capability fields and positive limits are used when returned; otherwise
limits remain unknown. The documented exact Claude Sonnet 4.5 Messages and
Gemini 3 Flash examples supply known multimodal inputs (including inline PDF
for the exact Gemini example), without extending
those claims to other model names. Gemini input/output limits remain distinct
from total context. This name filter may need updating for new product families.

Discovered models use the protocol selected for that account:

| Protocol id | AI SDK | Upstream path |
| --- | --- | --- |
| `chat` (default) | `@ai-sdk/openai-compatible` | `/v1/chat/completions` |
| `responses` | `@ai-sdk/openai` | `/v1/responses` |
| `anthropic` | `@ai-sdk/anthropic` | `/v1/messages` |
| `gemini` | `@ai-sdk/google` | `/v1beta/models/<model>:generateContent` or `:streamGenerateContent` |

Chat model IDs stay as listed by AstraFlow. Native Responses and Messages
and Gemini use public IDs `<upstream-id>@responses`, `<upstream-id>@anthropic`
and `<upstream-id>@gemini`;
requests still send the original upstream ID. Magpie merges models across
accounts before choosing an account, so distinct public IDs keep accounts
using different protocols from being routed with another account's wire
format. For example, select `astraflow/<model>@responses` for Responses.

The public catalog does not identify a model's supported protocols. Select
the protocol supported by the models you use; the plugin does not infer
support from a vendor name or fall back/retry on another protocol. Explicit
protocol exclusions from the control-plane catalog are honored when supplied.

The five exact model IDs documented by AstraFlow for DeepSeek V3.1/V3.2 and
Doubao thinking expose `none` and `high` variants for Chat. Portable
`reasoning_effort` / `reasoningEffort` is converted to their documented
`thinking.type` or `chat_template_kwargs.thinking` parameter. Explicit native
thinking parameters take precedence; unknown model IDs are not rewritten.
Requests preserve tools, successful streaming replies and cancellation. The plugin replaces incoming
authentication with the account's key and refuses other hosts, other API
paths and redirects. Messages also supplies `x-api-key` and the standard
Anthropic version header. A request is allowed only on the account's
selected protocol path or the model-list path. Gemini receives a fresh
`x-goog-api-key` and stale query-string keys are removed.

JSON errors distinguish authentication, model access, IP allowlists, rate
limits and the documented `api key quota exceeded` refusal. Only that precise
quota 403 is exposed as 429 for Magpie account scheduling. Other statuses and
error structures remain intact; credential strings in JSON error values and
field names are redacted. This applies to complete JSON errors up to 64 KiB
that arrive within one second; malformed, oversized or incomplete errors
pass through unchanged to preserve the response stream.
Successful responses and SSE are never read or cloned by error handling.

AstraFlow's native pricing includes currency, conditions, cache write TTLs,
storage and SKUs. These are preserved in the plugin model's `astraflow`
metadata, outside request options. Only an unambiguous single-tier USD token
price is mapped to Magpie's USD-per-million cost fields. CNY and conditional
prices are not converted; zero remains the host's unknown-cost sentinel and
no `free` mark is supplied. The current Magpie host does not display arbitrary
`astraflow` model metadata, so original-currency/tier pricing is not a new GUI
price panel. This would require a separate host-side change.

The usage hook reads **UCloud account balance** via `GetBalance` for OAuth
accounts, preferring `AccountInfo.AmountAvailable`, then `Amount`; it also
accepts the top-level shape shown in UCloud's documented example. It labels
the amount in the account's currency and performs no currency conversion.
This is the UCloud account balance. A separate optional selected-key query
shows actual daily/monthly settled spend against positive monetary limits,
plus model restrictions, IP allowlist count, disabled state and expiry when
returned. Missing used amounts never become a fabricated 0% window; no reset
time or currency conversion is guessed. Settled amounts may lag billing.
Permission errors and missing balance are shown as errors rather than zero;
optional key-control failures leave balance and inference available. Direct-key accounts expose
their key label without a fabricated balance or quota. Balance access with
a real OAuth account has not yet been verified; account permissions may
restrict this financial API. No vendor daily check-in API has been verified
and no check-in hook is declared.

## Credentials and OpenCode configuration

Magpie keeps the key as an `api` entry in its `plugin-auth.json`, with
`metadata.region` holding the endpoint and `metadata.protocol` the upstream
protocol. OAuth entries keep `access`, `refresh`, `expires` (milliseconds),
`issuer`, `inferenceKey`, project/key IDs and names, account display identity
and the same metadata. The plugin writes no separate
credential file. Inference keys and access/refresh tokens stay out of request
URLs and model-list diagnostics; the OAuth callback URL necessarily contains
the authorization code and state, so do not share it.

In an OpenCode v1 host that does not persist API-key prompt metadata,
configure the region and protocol explicitly under `provider.astraflow.options`
(the package name below becomes installable after its first npm release):

```json
{
  "plugin": ["@magpie-community/opencode-astraflow-auth"],
  "provider": {
    "astraflow": {
      "options": { "region": "singapore", "protocol": "chat" }
    }
  }
}
```

Account metadata takes precedence over this option. With neither set,
the plugin uses `china` and `chat`. Magpie's plugin host is the locally tested host;
no acceptance against an installed OpenCode version is claimed here.

## Local development

Install from a local checkout while developing the unpublished plugin:

```sh
magpie plugin add "/absolute/path/to/magpie-community-plugins/packages/astraflow"
magpie plugin login astraflow
```

## Local checks

From the repository root:

```sh
bun test packages/astraflow
bun scripts/check.mjs astraflow
bun tests/integration/astraflow/acceptance.mjs --magpie "/absolute/path/to/magpie"
```

These checks use fixture keys and make no paid requests. Run the whole
repository suite in a temporary HOME, as the root development instructions
require: other packages' tests create fixture credentials.

The integration script installs the real package in a temporary HOME and
uses Magpie's real sign-in endpoints, credential storage, Bun host and HTTP
gateway. A test-only Bun preload redirects every AstraFlow/UCloud request to a
local fixture, verifying browser and manual OAuth, project/key selection,
explicit creation, persisted token rotation, streaming, tools, permission
errors, native Responses / Messages / Gemini (including paginated discovery
and namespaced model IDs), CLI import without source
mutation, real settled Key budget fields, protocol conversion and model
additions/removals after restart. It removes
the sandbox on success and retains diagnostics on failure.

Optionally read the live Chat and Gemini public catalogs without authentication
or paid inference and feed those responses through the discovery hook:

```sh
bun tests/integration/astraflow/public-catalog.mjs
```

Neither check establishes real UCloud authorization, balance permission,
key creation, a real key's model permissions or actual model generation.
The public catalog check requires internet access and may fail
if AstraFlow later requires authentication for the listing.

## Sources

- [Authentication, keys and regional endpoints](https://astraflow.ucloud.cn/docs/modelverse/api_doc/common/certificate)
- [Model listing](https://astraflow.ucloud.cn/docs/modelverse/api_doc/text_api/models)
- [Official AstraFlow CLI model filtering](https://github.com/ucloud/astraflow-cli/blob/ca0b0fe9396121829c6860850dc6aafa4cfc1640/src/modelverse.rs)
- [Official OAuth flow](https://github.com/ucloud/astraflow-cli/blob/ca0b0fe9396121829c6860850dc6aafa4cfc1640/src/oauth.rs)
- [Official project/key control plane](https://github.com/ucloud/astraflow-cli/blob/ca0b0fe9396121829c6860850dc6aafa4cfc1640/src/ucloud.rs)
- [Official CLI configuration format](https://github.com/ucloud/astraflow-cli/blob/ca0b0fe9396121829c6860850dc6aafa4cfc1640/src/config.rs)
- [Control-plane model and key schemas](https://github.com/ucloud/ucloud-sdk-go/blob/master/services/uai_modelverse/models.go)
- [DeepSeek thinking switches](https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/thinking/deepseek.md)
- [Doubao thinking switches](https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/thinking/doubao.md)
- [Gemini-compatible API](https://github.com/UCloudDoc-Team/modelverse/blob/master/api_doc/text_api/gemini_compatible.md)
- [Gemini REST model listing and pagination](https://ai.google.dev/api/models)
- [UCloud account balance API](https://docs.ucloud.cn/api/ubill-api/get_balance)
