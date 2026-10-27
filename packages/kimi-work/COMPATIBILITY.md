# macOS compatibility record

## Upgrade 0.1.4

On Windows 11, 2026-10-17, the upgraded provider read the existing ordinary desktop Work sign-in and live model catalog/usage. An isolated adapter inserted a shared instruction and passed its messages through this provider unchanged to the real Work service. The streamed response was HTTP 200 with `[DONE]` and the exact marker present only in that instruction. The live desktop applications and their configurations were not switched for this request. Synthetic regression tests cover credential rotation, account binding, Request bodies, prompt/tool/stream preservation, expired sign-in, unchanged concurrency/quota/5xx responses, network diagnostics, cancellation and read-only desktop import.

On macOS 26.6.2 arm64, Kimi 3.2.17 build 3.2.17.4, at 2026-10-17 04:37 UTC, version 0.1.4 again read the existing Work sign-in, discovered `k3-agent` and `k2d8-preview`, and returned one shared membership window. This upgrade probe did not submit a Mac desktop conversation; the earlier streamed macOS inference evidence below remains a separate record.

At **2026-10-17 05:31 UTC**, the corrected 0.1.4 provider was also tested through the user's active Mac profile: ordinary Kimi's authenticated loopback adapter → official Magpie 0.1.1276 → Kimi Work `k3-agent`. The Agent was the community-published 0.1.1; the provider was a persistent local source pending this PR. One synthetic streamed request returned HTTP 200, `[DONE]` and exactly `KIMI_MAC_ROUTED_OK`, with a newly appended Magpie usage record identifying `agent: kimi-desktop`, `provider: kimi-work`, `model: k3-agent`, `status: 200`. Desktop credentials, provider settings, general settings and plugin auth were verified unchanged. This request was sent by an HTTP probe, not submitted through the desktop UI. The 429/5xx/network failure cases were tested with synthetic responses, not forced against Kimi's live service.

Observed at **2026-10-16 20:09 UTC** (2026-10-17 04:09 UTC+8).

| Component | Observed version |
|---|---|
| macOS | 26.6.2, Apple silicon / arm64 |
| Ordinary Kimi desktop | 3.2.17, build 3.2.17.4, `com.moonshot.kimichat` |
| Official Magpie | 0.1.1276 |
| Bun | 1.4.3, temporary test runtime |
| Provider code | `d5f84153116a28dcffb89f61a0f4435093d0483e`, package 0.1.3 |

The official Apple-silicon Kimi desktop application was installed; the user signed in personally and opened Work. The provider was installed and signed in using `magpie plugin add <temporary-provider-folder>` and `magpie plugin login kimi-work` in an isolated `XDG_CONFIG_HOME`, while retaining the real macOS home for read-only desktop-session discovery. `MAGPIE_BUN` selected the temporary runtime. The user's everyday Magpie profile was not replaced or restarted.

## File and fields actually observed

The file exists at:

```text
~/Library/Application Support/kimi-desktop/daimon-share/daimon/config.json
```

All four credential values were present and nonempty. This fragment shows field names only; **every value is redacted**:

```json
{
  "credentials": {
    "kimiCode": {
      "apiKey": "<redacted>",
      "baseUrl": "<redacted>"
    },
    "kimiWeb": {
      "accessToken": "<redacted>",
      "userId": "<redacted>"
    }
  }
}
```

The Work credential's origin matched the exact Work origin required by `readDesktop`. No actual value, account identifier, raw config or auth file was exported.

## Executed checks

- Desktop sign-in succeeded, saving only the provider's account reference in the isolated Magpie profile.
- Live model discovery returned `k3-agent` and `k2d8-preview`, each with `low`, `high` and `max` reasoning variants.
- Membership usage was read successfully. The result had one shared-allowance window and no `resetsAt`.
- Calling the provider's sign-in, model and usage hooks left Kimi's configuration byte-for-byte unchanged.
- One real, synthetic streamed inference was sent through the Kimi Agent adapter, the isolated official Magpie gateway and this provider to the real Work service. It returned HTTP 200, `[DONE]`, and exactly `KIMI_WORK_MAC_OK`.

Magpie's resulting route record, projected to non-sensitive fields:

```json
{
  "agent": "kimi-desktop",
  "provider": "kimi-work",
  "model": "k3-agent",
  "requested": "kimi-work/k3-agent",
  "served": "k3-agent",
  "status": 200
}
```

The inference was initiated by a synthetic HTTP client at the adapter's authenticated loopback endpoint. It was **not** a message submitted through Kimi's desktop UI. The control API/runtime, Magpie gateway, provider and Work service were real, not mock servers. No response was substituted. This run did not measure Kimi's billing classification or reset schedule.

After the adapter test, its original service address, current model, native catalog, credentials and unrelated settings were verified restored. The temporary model snapshot was removed, and the separate test gateway was stopped. The user's Kimi login remained in place.

This record covers this Apple-silicon/macOS/Kimi build. Intel macOS, Linux, desktop UI turns, sleep/wake, natural token expiry and future Kimi releases remain outside this run. Synthetic rotation/account-change/error cases remain in the package's unit tests.
