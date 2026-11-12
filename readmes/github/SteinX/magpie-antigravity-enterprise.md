# Antigravity Enterprise for Magpie

A local Magpie provider for the enterprise account already signed in to Antigravity App on macOS. Models are exposed as `antigravity-enterprise/<catalog-model-id>`.

## Requirements

- Magpie with provider-plugin support.
- Antigravity App installed and signed in to a Google Cloud or Workforce Identity Federation enterprise account.
- [Official agy CLI](https://antigravity.google/docs/getting-started.md?tab=cli), normally installed at `~/.local/bin/agy`. Set the package option `cliPath` for a custom installation.
- macOS login Keychain access. The plugin uses Antigravity's existing `gemini / antigravity` item.
- Xcode Command Line Tools (`xcrun swiftc`) for the first credential access. A dedicated Security-framework helper is compiled, ad-hoc signed, and cached. Credentials cross private process pipes only, never compiler arguments or source files.

## Install and configure

Clone the repository, then register its local folder with Magpie:

```sh
gh repo clone SteinX/magpie-antigravity-enterprise
cd magpie-antigravity-enterprise
magpie plugin add .
magpie plugin login antigravity-enterprise
```

The sign-in asks for each account's configuration:

| Field | How to choose it |
| --- | --- |
| Google Cloud Project ID | The project assigned to the enterprise license you want to use. Required. |
| Location | The license location: `global`, `us`, or `eu`. Required; in-country locations such as `us-central1` are not supported by this enterprise-seat API. |
| Authentication | Detect the existing local sign-in, or explicitly require Google Cloud SSO / WIF. |
| WIF Provider | When explicitly selecting WIF, enter the provider supplied by your administrator. It must match the account already signed in to the App. |

Current App values appear as suggestions, not as hidden routing defaults. The license API must confirm the selected project and location before the account is saved. The license tier comes from that response. No personal project, location, provider, or email is embedded in the source.

Changing authentication method or WIF provider requires first signing in with that identity in Antigravity App, then signing in to this Magpie provider again. These fields cannot turn an existing token into another provider's token.

After sign-in, select `antigravity-enterprise/<catalog-model-id>` in Magpie's model picker and send a request from your agent. Some Magpie releases, including the tested 0.1.3673 CLI, reject `provider test` for Google-protocol plugins before sending a request. Use an actual gateway or agent request to verify this provider on those releases.

Run `magpie plugin login antigravity-enterprise` again to configure another permitted project/location or explicitly bind a replacement App sign-in. Configuration is stored per Magpie account. Native license changes do not overwrite an existing account's request target.

## Credentials and renewal

Magpie stores a reference to the bound native account and the user-selected license configuration. It does not receive a copy of the access token or refresh token in `plugin-auth.json`.

Reads and renewal writes use the same dedicated helper executable. Its immutable, content-addressed path is reused across plugin-host restarts; concurrent first builds cannot replace an already published binary. The helper has a fixed signing identifier and a verified ad-hoc signature. This is a local executable identity, not an Apple Developer certificate.

Only explicit provider sign-in may display macOS Keychain authorization. Run `magpie plugin login antigravity-enterprise` and, for the dedicated helper requesting the existing `gemini` item, choose **Always Allow** to retain access. Ordinary model, catalog, quota, and background renewal operations disable Keychain interaction. If access is missing or the Keychain is locked, they return an access error without marking the account's Google sign-in expired. Unlock the Keychain or reconnect explicitly. Do not allow every application access to the credential. A helper source update changes its executable identity and can require authorization again.

The plugin reads the current Keychain credential for requests, renews within five minutes of expiry, and coordinates renewal between requests and plugin-host processes. A nonempty native WIF provider selects the STS OAuth endpoint, including when the stored authentication label is `gcp`; otherwise enterprise Google Cloud OAuth uses its own installed-app client. WIF renewal matches the captured CLI request: HTTP Basic with the public WIF client ID and an empty secret, a form containing only `grant_type` and `refresh_token`, `Go-http-client/2.0`, and gzip. Cloud OAuth retains form authentication; a non-WIF native session has not been captured. Explicit authentication choices validate the effective refresh mechanism. Request identity metadata retains the native label. Public client metadata is checked against the installed Antigravity binary. Revoked authorization prompts a new sign-in; transient network/server failures remain retryable. A generation rejected with HTTP 401 gets one renewal and one resend; successful generations are never replayed, and HTTP 403 is not retried as an expired credential.

Renewed tokens are written to the original Keychain item while preserving its other fields and ACL. A helper holds an OS file lock and checks that the original credential still matches immediately before updating it. The native App does not participate in that lock, and Apple's Keychain API has no atomic value-data compare-and-swap: a native-App write can still race the final comparison and update.

Once a token renewal is dispatched, cancellation stops the caller waiting but allows the bounded renewal and guarded writeback to finish, so a received rotating refresh token is not abandoned. Resource HTTP 401 responses trigger one native renewal and one retry before being reported as expired; HTTP 403 remains an authorization error. If Google rejects the refresh token itself (for example, `invalid_grant`), sign in again in Antigravity App, then reconnect this provider; no plugin can renew a revoked refresh token.

After native access and renewal succeed, `magpie quota refresh antigravity-enterprise` can clear Magpie's persisted expired-account mark when the quota response succeeds. A Keychain access error reported as `kept` does not clear an older expiry mark. Explicit sign-in with a changed native binding may add a separate account; retain the intended account's project and location when reconnecting.

Binding uses an authenticated principal when available, otherwise a successfully renewed refresh-token lineage. Rotations made by this plugin retain that lineage. An unknown externally replaced or rotated token requires explicit rebinding rather than assuming it belongs to the same account. The plugin never selects another native identity merely because its project or provider matches.

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

The observed response reports the limit closest to being reached for each model, without reset timestamps, absolute limits, or monetary balances. The plugin does not invent these values. Models absent from the response retain unknown quota. The live account returned 25 buckets matching 25 of its 31 catalog models, each with 100% remaining, and the plan `Gemini Enterprise Plus`; those figures describe that reading and can change. Authentication expiry requires sign-in; permission, network, and malformed-response errors preserve the sign-in and remain visible.

Catalog capability flags also recognize explicit video input and adaptive thinking support when MIME types or the older thinking flag are absent. This corrects picker metadata; it does not establish entitlement to a model.

## Checks

```sh
npm test
```

For the opt-in macOS integration check, run `MAGPIE_NATIVE_KEYCHAIN_TESTS=1 node --test keychain.test.mjs`. It creates an explicit private temporary Keychain, checks reads, guarded rotation, unauthorized and locked access, helper identity reuse, and altered-cache rejection, then deletes the fixture. It never changes the user's Keychain search list or uses production credentials.

The deterministic suite covers effective authentication selection, renewal ownership and cancellation, token replacement races, rotation lineage, per-account configuration preservation, Fetch input semantics, regional routing, complex tool schemas, fragmented SSE, signatures, tool calls, upstream errors, and cancellation. Error-event fixtures exercise the generic Google RPC/SSE contract; they are not captured App responses. Live model checks consume the selected enterprise account's allowance.

Version 1.0.6 accepts native credentials that omit the optional `tier_display_name` field, without adding a default to the Keychain item; invalid supplied types remain rejected. All 248 behavior tests passed (the separate opt-in native integration check is skipped by the default command). After a fresh enterprise sign-in, two consecutive real OAuth renewals returned HTTP 200 with `expires_in: 3599`. Both returned access tokens matched Keychain writeback; the server returned the same refresh token. A fresh process reused the persisted token and expiry with interaction disabled and zero network calls. Explicit provider sign-in re-established the changed native binding; quota refresh returned 25 windows, and the running gateway completed a Gemini Flash Lite request with HTTP 200 and the exact expected response. These checks forced renewal; they did not wait for natural expiry. The earlier 1.0.5 native Keychain integration check passed.

Validated with Magpie 0.1.3673 and its Bun 1.4.4 runtime, Antigravity App 2.31.0, and official CLI 1.5.5. All 220 Node deterministic checks passed, including quota fractions, exact model scopes, unknown values, error handling, cancellation, and deadlines. The live Magpie quota refresh returned 25 windows with zero percent used and the expected plan; the scoped gateway history endpoint returned HTTP 200. Earlier integration exercised native renewal, Gemini SSE generation, signed tool-call/result continuation, complex JSON Schema, OpenAI Chat SSE/tools, and Responses translation. The installed daily gateway completed a complex-schema tool call and its result continuation. The same schema containing `$defs`, `$ref`, union types, and `additionalProperties` was rejected by the enterprise API in `parameters` with HTTP 400 and accepted unchanged in `parametersJsonSchema` with HTTP 200. US/EU routing has deterministic coverage; the live license used global.

### Decrypted CLI reference

The official arm64 CLI 1.5.5 artifact was verified against the release-manifest SHA-512; its executable SHA-256 is `42b591f206a868dd0b924d5b6b396638a108539367695a5dbe2f7dcfdbf4d6f3`. Mitmproxy 12.3.1 decrypted its authentication, catalog, generation, tool-result, and resumed-conversation requests. The CLI used the same native Keychain bearer credential as the provider. Child-process CA overrides supplied trust; no system or login Keychain CA trust was changed. Response chunks were observed and forwarded unchanged.

| Area | Captured official CLI | Provider behavior |
| --- | --- | --- |
| WIF renewal | STS, Basic client authentication with an empty secret; only `grant_type` and `refresh_token` in the form | Matched; real renewal returned HTTP 200 and preserved account binding |
| Generation | Flat `businessaicode` JSON with `aicode`, contents, system instruction, tools, labels, generation config, and entitlement | Replayed through the real loader; decoded JSON was equal after privacy normalization and returned HTTP 200 / `OK` |
| Request IDs | Trajectory UUID plus a counter; native tool requests used 0 and 1, then resumed at 2 in another CLI process | Per-trajectory numbering, with a lower bound from supplied history |
| Tool continuation | Model-role function call and function response; real call ID and thought signature retained | Native-schema replay returned HTTP 200 twice; captured signature and call ID matched the follow-up request |
| Agent context | CLI prompts, cascade labels, experiment/ACL calls, and telemetry | Caller prompts and labels are preserved; CLI agent activity is not synthesized |
| Client identity | `antigravity/cli/1.5.5`, build 1017970541 | Matched; version and build are read from the installed CLI, including after executable replacement |
| HTTP transport | Go HTTP/2 | HTTP/2 in Magpie's Bun 1.4.4 runtime; generation header names and normalized values match, with no extra Accept, connection, host, or content-length headers |

The latest header capture compared the official CLI and the real provider under Magpie's bundled Bun runtime. Catalog discovery returned 31 models and generation returned HTTP 200 / `OK`; the generation User-Agent matched exactly. After normalizing dynamic bearer credentials and UUIDs, all six generation headers and their values matched. Tokens were separately checked against the current native credential. Header order, HTTP/2 SETTINGS/HPACK behavior, connection reuse, and TLS fingerprints are outside this equality check.

The capture covered a WIF-backed native profile whose stored authentication label was `gcp`. Non-WIF cloud OAuth, live regional licenses, and all-model authorization remain unverified. Raw credential values were excluded before evidence was written; detailed redacted captures remain local.

## Protocol references

- [Google Antigravity enterprise authentication, licenses, models and endpoints](https://antigravity.google/docs/enterprise)
- [Google Antigravity unified local authentication](https://antigravity.google/docs/install)
- [Magpie provider-plugin contract](https://usemagpie.ai/docs/plugins)
- [Enterprise request-format reference](https://github.com/aeroxy/claude-proxy/blob/b7dd5a943a1f70c7c6a030592757c70a977f666b/src/gemini/aicode.rs)
- [WIF OAuth protocol reference](https://github.com/Mag1cFall/Antigravity2API/blob/6aa1a0a35906abad793f0cef6bebb30c69920ead/docs/protocol.md)
- [Native Google Schema fields](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html)
- [FunctionDeclaration and JSON Schema parameters](https://googleapis.github.io/js-genai/release_docs/interfaces/types.FunctionDeclaration.html)
- [Official arm64 CLI release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)
