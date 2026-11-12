# Antigravity Enterprise for Magpie

A local Magpie provider with browser sign-in for Google Cloud and Workforce Identity Federation enterprise accounts on macOS. Models are exposed as `antigravity-enterprise/<catalog-model-id>`.

## Requirements

- Magpie with provider-plugin support.
- Antigravity App installed for its validated enterprise OAuth client configuration. A pre-existing App sign-in is not required for browser login.
- [Official agy CLI](https://antigravity.google/docs/getting-started.md?tab=cli), normally installed at `~/.local/bin/agy`. Set the package option `cliPath` for a custom installation.
- macOS login Keychain access. Browser login creates or updates the shared `gemini / antigravity` credential only after authorization and license validation succeed.
- Xcode Command Line Tools (`xcrun swiftc`) for the first credential access. A dedicated Security-framework helper is compiled, ad-hoc signed, and cached. Credentials cross private process pipes only, never compiler arguments or source files.

## Install and configure

Clone the repository, then register its local folder with Magpie:

```sh
gh repo clone SteinX/magpie-antigravity-enterprise
cd magpie-antigravity-enterprise
magpie plugin add .
magpie plugin login antigravity-enterprise
```

Choose **Sign in with enterprise account** to start browser SSO directly from Magpie. **Use existing local Antigravity sign-in** remains available to explicitly import an existing native session. The browser flow asks for:

| Field | How to choose it |
| --- | --- |
| Google Cloud Project ID | The project assigned to the enterprise license you want to use. Required. |
| Location | The license location: `global`, `us`, or `eu`. Required; in-country locations such as `us-central1` are not supported by this enterprise-seat API. |
| Authentication | Google Cloud SSO or Workforce Identity Federation. |
| WIF Provider | For WIF, the provider supplied by your administrator: `locations/global/workforcePools/POOL/providers/PROVIDER`. |

The browser opens Google's authorization page, uses S256 PKCE and a random state, and returns through a loopback-only localhost callback. Complete enterprise SSO in that browser. The plugin then confirms the selected project and location through the license API before installing the native credential and binding the Magpie account. The license tier comes from that response. No personal project, location, provider, or email is embedded in the source.

Browser login does not require an existing Keychain item and does not sign out the current native session at the start. A successful login changes the shared native account on this Mac; a failed authorization or license check preserves it. If another client changes the native credential while login is in progress, the plugin refuses to overwrite that newer credential. Explicit import uses current App values as suggestions and never turns a token into another authentication method.

After sign-in, select `antigravity-enterprise/<catalog-model-id>` in Magpie's model picker and send a request from your agent. Some Magpie releases, including the tested 0.1.3673 CLI, reject `provider test` for Google-protocol plugins before sending a request. Use an actual gateway or agent request to verify this provider on those releases.

Run `magpie plugin login antigravity-enterprise` again to configure another permitted project/location or explicitly bind a replacement App sign-in. Configuration is stored per Magpie account. Native license changes do not overwrite an existing account's request target.

## Credentials and renewal

Magpie stores a reference to the bound native account and the user-selected license configuration. It does not receive a copy of the access token or refresh token in `plugin-auth.json`.

Reads and renewal writes use the same dedicated helper executable. Its immutable, content-addressed path is reused across plugin-host restarts; concurrent first builds cannot replace an already published binary. The helper has a fixed signing identifier and a verified ad-hoc signature. This is a local executable identity, not an Apple Developer certificate.

Only explicit provider sign-in may display macOS Keychain authorization. Run `magpie plugin login antigravity-enterprise` and, for the dedicated helper requesting the existing `gemini` item, choose **Always Allow** to retain access. Ordinary model, catalog, quota, and background renewal operations disable Keychain interaction. If access is missing or the Keychain is locked, they return an access error without marking the account's Google sign-in expired. Unlock the Keychain or reconnect explicitly. Do not allow every application access to the credential. A helper source update changes its executable identity and can require authorization again.

The plugin reads the current Keychain credential for requests, renews within five minutes of expiry, and coordinates renewal between requests and plugin-host processes. A nonempty native WIF provider selects the STS OAuth endpoint, including when the stored authentication label is `gcp`; otherwise enterprise Google Cloud OAuth uses its own installed-app client. WIF renewal matches the captured CLI request: HTTP Basic with the public WIF client ID and an empty secret, a form containing only `grant_type` and `refresh_token`, `Go-http-client/2.0`, and gzip. Cloud OAuth retains form authentication; a non-WIF native session has not been captured. Explicit authentication choices validate the effective refresh mechanism. Request identity metadata retains the native label. Public client metadata is checked against the installed Antigravity binary. Revoked authorization prompts a new sign-in; transient network/server failures remain retryable. A generation rejected with HTTP 401 gets one renewal and one resend; successful generations are never replayed, and HTTP 403 is not retried as an expired credential.

Renewed tokens are written to the original Keychain item while preserving its other fields and ACL. A helper holds an OS file lock and checks that the original credential still matches immediately before updating it. The native App does not participate in that lock, and Apple's Keychain API has no atomic value-data compare-and-swap: a native-App write can still race the final comparison and update.

Once a token renewal is dispatched, cancellation stops the caller waiting but allows the bounded renewal and guarded writeback to finish, so a received rotating refresh token is not abandoned. Resource HTTP 401 responses trigger one native renewal and one retry before being reported as expired; HTTP 403 remains an authorization error. If Google rejects the refresh token itself (for example, `invalid_grant`), run the plugin's browser sign-in again; no plugin can renew a revoked refresh token.

After native access and renewal succeed, `magpie quota refresh antigravity-enterprise` can clear Magpie's persisted expired-account mark when the quota response succeeds. A Keychain access error reported as `kept` does not clear an older expiry mark. Explicit sign-in with a changed native binding may add a separate account; retain the intended account's project and location when reconnecting.

Binding uses an authenticated principal when available, otherwise a successfully renewed refresh-token lineage. Rotations made by this plugin retain that lineage. An unknown externally replaced or rotated token requires explicit rebinding rather than assuming it belongs to the same account. The plugin never selects another native identity merely because its project or provider matches.

Each saved native account binding owns a separate in-memory session in a long-running plugin host. Browser sign-in completed by another host can therefore introduce a new valid binding without reusing the previous account's pinned session; old bindings still reject replacement native credentials.

Nonsecret principal fingerprints, the compiled helper, and its lock are stored under `~/.config/magpie/antigravity-enterprise`. Package options `appPath`, `cliPath`, and `stateDir` may change the App, CLI executable, and state paths. All plugin hosts sharing the same native Keychain item must use the same `stateDir` to share its renewal lock.

## Request compatibility

- Reads the installed CLI's version and runtime build from its thin Darwin Mach-O executable and sends `antigravity/cli/...` identity with the native authentication label. The observed build-stamp layout is validated against captured CLI traffic; missing, ambiguous, changed, or unsupported binaries fail explicitly. Metadata is cached by file identity and re-read after a CLI update. Installed App client configuration is still used for OAuth checks.
- Discovers the selected account's enabled model IDs and capabilities instead of keeping a consumer-model fallback list.
- Routes enterprise inference to the matching global, US, or EU `businessaicode` deployment.
- Uses the flat enterprise Gemini payload, license entitlement, and trajectory/request ID headers.
- Uses request-owned HTTP/2 connections for native API traffic, with verified TLS, proxy CONNECT, `NO_PROXY`, streaming gzip, cancellation, and response backpressure. Generation omits Content-Length; catalog and refresh POSTs declare their actual encoded byte length. The transport does not add Fetch's default Accept or HTTP/1 connection headers.
- Numbers requests independently within each trajectory as `<trajectory-id>-<counter>`. Prior model-generation messages establish a history lower bound; tool-result-only messages do not consume generation numbers. Counters are scoped to the bound account, project, and location. Failed attempts are retained in memory; history cannot reconstruct unseen failures after eviction or restart.
- Accepts standard Fetch `Request`, `URL`, and string inputs, including request-body overrides, headers, and cancellation.
- Preserves `parametersJsonSchema`. Legacy `parameters` containing JSON Schema-only syntax use that field without dropping references, unions, or `additionalProperties`; native Google Schema stays in `parameters`.
- Passes native SSE through and aggregates it for nonstreaming clients. Preserves real tool-call IDs, thinking parts, and thought signatures. Nonstreaming Google RPC errors and named SSE error events return errors instead of partial successful completions; cancellation stops aggregation.
- Does not generate telemetry, alter the user's system prompt, insert fabricated signatures, or change the organization's model permissions.

License availability is checked during sign-in; administrator restrictions and upstream authorization errors remain visible. Upstream pricing is not included in this catalog, so the plugin does not claim that a model is free or that an enterprise quota is unused.

## Quota

The plugin implements Magpie's `auth.usage` hook using the native `retrieveUserQuotaSummary` endpoint and the bound account's selected project. The saved license supplies the plan name. Read the provider's quota card or use:

```sh
magpie quota antigravity-enterprise --json
magpie quota refresh antigravity-enterprise --json
magpie quota history antigravity-enterprise --days 7 --json
```

Magpie also exposes these readings through `GET /v1/magpie/quotas` and records history at `GET /v1/magpie/quotas/history?provider=antigravity-enterprise&days=7`. Its refresh command may reuse a reading less than 30 seconds old.

Each reported bucket becomes a separate percentage window. Its exact bucket ID scopes the window to the matching model; equal percentages and the `All Models` heading do not establish a shared pool. Magpie's CLI JSON omits this internal routing matcher. Invalid IDs produce display-only windows. Positive remaining fractions stay below complete exhaustion, including very small fractions; missing or invalid fractions remain unknown.

The observed response reports the limit closest to being reached for each model, without reset timestamps, absolute limits, or monetary balances. The plugin does not invent these values. Models absent from the response retain unknown quota. Authentication expiry requires sign-in; permission, network, and malformed-response errors preserve the sign-in and remain visible.

The vendor describes separate Gemini Pro, Gemini Flash, and Claude/GPT pools, each with weekly and five-hour caps; each returned percentage reflects the cap closest to exhaustion. It does not provide a complete model-to-pool mapping or identify which cap supplied a particular reading. Model rows must not be interpreted as independent pools or summed across models.

The quota endpoint can report 100% remaining even when generation requests return `Quota pool exhausted`. For the affected request, the generation error is the current enforcement result; the quota card is an independent upstream reading and is not evidence that a rejected model can still generate.

Catalog capability flags also recognize explicit video input and adaptive thinking support when MIME types or the older thinking flag are absent. This corrects picker metadata; it does not establish entitlement to a model.

### Quota exhaustion errors

The plugin recognizes the observed `Quota pool exhausted` response only when its effective HTTP status is 429. It presents an actionable message with the expected reset time, when supplied, and the options to wait or contact the enterprise administrator about overages. Signing in again does not replenish an exhausted pool. The response retains HTTP 429 and Google RPC error code/status; ordinary rate limits and other errors keep their original behavior.

Reset timing comes from a valid upstream `google.rpc.RetryInfo.retryDelay`, falling back to the observed `Resets in ...` message. The displayed time includes a timezone; unavailable or invalid delays do not produce a fabricated reset time. This handling covers HTTP error bodies for both streaming and nonstreaming requests and quota errors found while aggregating SSE for nonstreaming clients. Successful streaming responses remain native passthrough. It does not add a retry policy, change account authentication state, infer a shared pool across models, or rewrite other models' quota cards.

The provider response adds `error.type: "quota_exhausted"` and, when known, UTC `reset_at`. Magpie 0.1.3858's OpenAI gateway normalizes the type to `rate_limit_error` and does not forward these custom fields; its visible `message` retains the full quota explanation and reset time. Consumers of that gateway should use the message rather than assume the provider-only fields survive translation. The quota card still reads the independent upstream quota endpoint.

## Checks

```sh
npm test
```

For the opt-in macOS integration check, run `MAGPIE_NATIVE_KEYCHAIN_TESTS=1 node --test keychain.test.mjs`. It creates an explicit private temporary Keychain, checks reads, guarded rotation, unauthorized and locked access, helper identity reuse, and altered-cache rejection, then deletes the fixture. It never changes the user's Keychain search list or uses production credentials.

The deterministic suite covers effective authentication selection, renewal ownership and cancellation, token replacement races, rotation lineage, per-account configuration preservation, Fetch input semantics, regional routing, complex tool schemas, fragmented SSE, signatures, tool calls, upstream errors, and cancellation. Error-event fixtures exercise the generic Google RPC/SSE contract; they are not captured App responses. Live model checks consume the selected enterprise account's allowance.

See [CHANGELOG.md](CHANGELOG.md) for release history, verification results, and CLI capture evidence.

## Protocol references

- [Google Antigravity enterprise authentication, licenses, models and endpoints](https://antigravity.google/docs/enterprise)
- [Google Antigravity unified local authentication](https://antigravity.google/docs/install)
- [Magpie provider-plugin contract](https://usemagpie.ai/docs/plugins)
- [Google installed-application OAuth and loopback PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Workforce Identity Federation browser login configuration](https://docs.cloud.google.com/iam/docs/workforce-log-in-gcloud)
- [Enterprise request-format reference](https://github.com/aeroxy/claude-proxy/blob/b7dd5a943a1f70c7c6a030592757c70a977f666b/src/gemini/aicode.rs)
- [WIF OAuth protocol reference](https://github.com/Mag1cFall/Antigravity2API/blob/6aa1a0a35906abad793f0cef6bebb30c69920ead/docs/protocol.md)
- [Native Google Schema fields](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html)
- [FunctionDeclaration and JSON Schema parameters](https://googleapis.github.io/js-genai/release_docs/interfaces/types.FunctionDeclaration.html)
- [Official arm64 CLI release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)
