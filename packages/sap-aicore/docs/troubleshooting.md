# Troubleshooting

## Sign-in fails

Check the absolute credential-file path, readable valid JSON, required fields, and current client-secret service-key values. Service bindings and certificate keys are not accepted. Use service roots without endpoint paths. See [credentials](credentials.md).

Only supported SAP `*.hana.ondemand.com` service hosts are accepted. Other landscapes, embedded URL credentials, nondefault ports, or query/fragment components are rejected. Do not disable TLS verification to work around a trust failure.

## No models appear or a model becomes unavailable

Check the credential file's resource group, RUNNING deployment status, scenario/executable, and [model eligibility](../README.md#supported-models). GPT requires major version 6 or higher, not a fixed name or backend date. The active backend version must match the catalog and any configured version pin. For both GPT and Claude, `latest` is only a configuration selector: backend details must report a concrete version, even when the catalog includes a `latest` entry. Catalog availability alone does not mean a deployment exists. Unresolved, deprecated, or retired versions remain unavailable.

Discovery refreshes after its five-minute cache expires, including time spent in system sleep. Restart the gateway to rebuild immediately and wait for startup discovery to finish before sending requests. A retained visible host catalog is not proof that the deployment is still usable; dispatch checks the current registry.

## Unsupported request parameters

Use the [API request fields](api-reference.md#request-fields). Responses does not accept Chat fields directly. Supported reasoning effort is low/medium/high with optional automatic summary; none is unsupported. Use stateless history rather than a previous response ID. Preserve complete tool history and original call IDs.

For Claude, use `/v1/messages` and the [native Messages fields](api-reference.md#claude-native-anthropic-messages), not Responses `input`. Enabled thinking requires a positive integer `budget_tokens`; adaptive/disabled thinking must omit it. Opus 4.8 active version `1` rejects `temperature`, `top_p`, and enabled thinking. Sonnet 4.6 active version `1` accepts either sampling setting individually, not both, and rejects enabled thinking with forced tool use. Both baseline versions enforce `max_tokens <= 128000`. Newer versions do not inherit these limits or model-specific restrictions. Unknown request/tool fields fail explicitly; only the documented boolean pi tool hints are consumed during adaptation.

Claude streaming requires explicit support on the matched catalog version; omitted support does not authorize streaming. A stream must include a valid message start and stop-reason delta before its stop frame. An identity-resolution error means non-empty catalog identity metadata was unrecognized or conflicted; an explicit non-Anthropic provider cannot qualify through a Claude name substring.

## Credential updates and multiple accounts

Sign in again after changing credentials and restart other running gateways. Reauthorization in another process cannot revoke an already-running host's in-memory account generation at an identical file path. Deleting/recreating a file at that path is not an automatic rotation signal.

Use the displayed account label to pin requests; see [account selection](credentials.md#accounts-and-credential-updates). Do not guess a selector from a hash or send SAP credentials as the gateway key.

## First request after overnight sleep returns discovery 401

`discovery-response` with HTTP 401 means an AI Core discovery endpoint rejected the request before inference; it does not establish an OAuth client-secret refusal. Older plugin versions used only a monotonic expiry clock, which pauses during system sleep in Bun on macOS and could retain yesterday's expired token. Token reuse now checks wall-clock deadlines as well.

Fully quit and reopen the Magpie app, or restart the gateway process, to load the fixed plugin and discard the old in-memory token. Restarting pi alone does not reset the gateway's token. Do not rotate credentials based on this error alone. If discovery still returns 401 with a fresh token, check the service-key/API landscape pairing and account access.

## Error handling

- Verified OAuth client refusal expires the affected sign-in.
- Discovery/inference 401 keeps sign-in; verified invalid/expired Bearer rejection discards the token for a subsequent independent operation, without replaying the failed generation in the plugin.
- 404 can mean the selected model/deployment is unavailable.
- 429 may mean tenant/resource-group quota or backend capacity. Numeric-seconds Retry-After is preserved when supplied; the status alone does not identify the cause.
- Temporary upstream failures, timeouts, and cancellation remain errors rather than successful empty replies.
- An HTTP 200 stream may still fail or end incomplete. Native failure events and missing/malformed terminals must not be interpreted as completion.
- Long active streams no longer hit the former two-minute total cutoff: defaults are 120 seconds idle and 900 seconds total. `inference-idle-timeout` means no stream chunk was relayed within the idle window; `inference-timeout` means the total cap or pre-stream deadline expired. See [timeout options](api-reference.md#upstream-transport-and-streaming). Magpie may wrap either stream-read failure as "connection lost mid-reply"; that wording alone does not establish an AI Core network outage.

Error descriptions are credential-redacted; native identities, output history, status, and error categories are retained. Magpie may retry or fail over independently. Do not assume one client request means exactly one billed generation.

## Cancellation and host constraints

Local abort stops owned HTTP/body delivery but does not prove SAP backend termination or billing cessation. Independent requests can continue after another request is cancelled.

Host initialization hooks do not supply a caller abort signal; they have internal deadlines. On cold fetch, the host may initialize credentials/discovery before the plugin sees and rejects an unsafe request URL. Cancelling sign-in after authorization does not necessarily prevent the host saving the successful account. These constraints do not authorize unsafe inference routing or stale-registry dispatch.

[Back to setup](../README.md)
