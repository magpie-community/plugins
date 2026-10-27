# Compatibility record

## Kimi 3.2.18 isolated compatibility check

On 2026-10-24, Windows Kimi desktop 3.2.18.13 shipped Daimon 0.6.8. An independent source copy of that installed bundle was used to exercise its unchanged model schema, thinking resolver, request builder and streamed/non-streamed response parser. Test-only exports exposed those internal functions; no installed application file was changed.

The catalog regression failed before the fix for mandatory-thinking models and passed afterward. The fix writes `always_thinking` only when the advertised thinking levels are complete, recognized and omit `none`; native entries, unknown metadata and switchable models retain their behavior. The actual 0.6.8 resolver maps a mandatory model's stale `off` to `high` with the existing default policy, while a switchable model keeps `off`.

The two packages passed 65 tests. Another 80 synthetic cases used the installed core's request builder across mandatory, switchable, unknown and non-thinking models, five requested effort choices, both response modes and Library instructions on/off. Ten additional cases checked raw thinking controls and approximately 2 MiB histories. The desktop adapter and Work provider preserved original system/developer messages, image parts, assistant progress and reasoning, tool declarations, IDs and results. The Work provider retains its existing intentional tool-schema normalization; it does not modify history or thinking fields. Synthetic tool responses were parsed, never executed.

The real Work `/models` endpoint discovered `k3-agent` and `k2d8-preview` with low/high/max efforts. Both models then completed real streamed and non-streamed requests with matching synthetic markers and nonempty reasoning. A real model also returned a declared read-fixture tool call and accepted its synthetic result together with the assistant's reasoning. Six direct inference calls succeeded. Two additional constraint probes received the upstream HTTP 400 `tool_choice 'specified' is incompatible with thinking enabled`; using normal automatic tool selection completed the loop without a provider-code change.

Four further requests exercised the candidate desktop adapter and unchanged Work provider through a task-created loopback gateway: both models at high/max, with the actual upstream model ID checked in every case. An initial test-client mistake omitted the menu alias and exercised the selected-model fallback; those four earlier calls are excluded from this two-model coverage claim. The client was corrected before the four verified requests.

The unchanged official Kimi executable was also launched with a separate temporary profile and workspace. Its real authenticated control API accepted the candidate's catalog through `conversations.updateKimiModelList`; both runtime/menu aliases declared `always_thinking`. The profile used a synthetic local Web identity and an isolated offline model cache. Only the existing Work service API key was temporarily borrowed; no real Web sign-in token or refresh token was copied, no login/refresh operation was requested, and temporary service-key copies were removed afterward. This did not verify a real account's online menu refresh.

Four user turns were submitted through that desktop instance's background control API with `activate:false` on conversation creation. Both models executed the native `Read` tool against the same task-owned fixture, returned its exact marker, and replayed matching tool IDs, results and assistant reasoning. The entire preceding request history prefix was unchanged across each tool continuation. A later low-effort turn recalled markers from earlier turns without another tool call. A stale `off` request on a mandatory model remained enabled in the actual runtime (`max` in this profile); the adapter did not rewrite those thinking fields. Six main-conversation inference requests completed with HTTP 200 and full SSE termination. These are real desktop-runtime turns, not mouse/keyboard submissions from the UI.

After disconnecting, only the task-created desktop and gateway were stopped. All 25 protected original files matched their before-test hashes: the two installed plugins, original Kimi login/configuration, Magpie prompt/binding and sync settings, and official application files. No installed package or official program was patched or upgraded.

Limits of that background run: desktop input was paused, and the observed UI model menu used the isolated offline cache. The live route used a task-created gateway, not an official Magpie `serve` host. No current macOS runtime, sleep/wake, natural token rotation, search/fetch or non-read tool execution was tested. These results do not supersede the separate real macOS record below.

### Signed-in Windows desktop UI follow-up

The synthetic profile could display models and run background control turns, but the UI's send entry required a real Web sign-in. Both saved Web access tokens available locally had expired; no model request was emitted by those rejected UI attempts. The user then completed the official sign-in flow in the temporary profile. The original profile and its login files were not refreshed or changed.

Three actual UI submissions completed against real models. The first two each executed native `Read` against the task-owned fixture and returned its exact marker; the isolated adapter selected `k3-agent` and then `k2d8-preview`, and the recorded upstream IDs matched. Thinking stayed enabled at high effort. All four streamed requests in those two tool loops completed with HTTP 200; tool IDs, results and assistant reasoning matched, and each entire request history prefix survived its continuation. A third UI-submitted turn on `k2d8-preview` recalled both prior UI markers and the file marker without a tool call. Its streamed request also completed with HTTP 200, and retained the initial UI request's entire history prefix. All original conversation message parts were unchanged.

The signed-in UI retained Kimi's native model labels, while the isolated adapter's selection determined the actual upstream model. This UI check therefore verifies real sending through the bridge; it does not claim that the online native menu displays Magpie's custom aliases. No UI code, application resources or installed plugin was patched to obtain this result.

The adapter was disconnected and only the test-created processes were stopped. The whole temporary signed-in profile, including its cookies and tokens, was removed. All 25 protected original files still matched the independent before-UI hashes, including original login/configuration, the installed plugins, prompt/binding and sync settings, and official program files. A credential-free verification summary was retained outside the repository; no credentials, private prompts or local execution artifacts are included in this change.

## Library upgrade 0.1.1

On Windows 11, Kimi 3.2.17.10, 2026-10-17: a disabled synthetic server placed in the ordinary desktop runtime's `runtime/kimi-code/home/mcp.json` appeared in the real authenticated `mcp.list` result. A synthetic skill placed in the ordinary desktop runtime's `skills` appeared in the real `skills.list` result. Both fixtures were removed and the original MCP bytes restored after the probe. No server command or skill was executed.

An isolated synthetic Kimi configuration and upgraded adapter forwarded a shared instruction through the upgraded Work provider to the actual Work service using the existing desktop sign-in. The streamed response was HTTP 200, completed with `[DONE]`, and returned the exact marker present only in the shared instruction. This was a bridge request, not a desktop UI-submitted turn. Neither running Magpie nor Kimi was switched during the test. Fourteen agent tests passed, covering hot instruction changes/removal, unreadable instruction refusal, native directory links, preservation and existing bridge behavior.

The same disabled MCP/skill discovery probe passed on macOS 26.6.2 arm64, ordinary Kimi 3.2.17 build 3.2.17.4, at 2026-10-17 04:37 UTC. Real `mcp.list` and `skills.list` both found their synthetic fixtures, then the original MCP bytes were restored and both fixtures removed. The 0.1.1 package created both directory symlinks in a temporary fixture; the 0.1.4 provider read the real desktop sign-in, returned `k3-agent` and `k2d8-preview`, and read one shared-allowance window. These calls did not execute an MCP command, invoke a skill or submit a desktop conversation. The earlier macOS inference record below remains the separate 0.1.0 record.

Observed at **2026-10-16 20:09 UTC** (2026-10-17 04:09 UTC+8): macOS 26.6.2 arm64; ordinary Kimi desktop **3.2.17, build 3.2.17.4** (`com.moonshot.kimichat`); official Magpie **0.1.1276**; Bun **1.4.3**. Agent runtime files were pinned to `dd3a8b889507f4c810e074acbb0dbf8a167ac99c` and checked against their Git blob SHA-256 values.

The user signed in to ordinary Kimi desktop and opened Work. Its real configuration was found at:

```text
~/Library/Application Support/kimi-desktop/daimon-share/daimon/config.json
```

The real runner was at `agents/main/runner.state.json` relative to that directory, reported `running`, and had no active turns. The fields `credentials.kimiCode.apiKey`, `credentials.kimiCode.baseUrl`, `credentials.kimiWeb.accessToken` and `credentials.kimiWeb.userId` were present and nonempty. All credential values and the local control token remained on the Mac and are omitted here.

## What ran

1. Started official Magpie in a separate temporary `XDG_CONFIG_HOME` on an unused loopback port, with the Kimi Work provider from PR #171. The real desktop sign-in was read using the normal macOS home. The existing Magpie process/profile was not restarted or replaced.
2. Instantiated the submitted `KimiAdapter` with a temporary `stateDir`, its default macOS Kimi path, and the submitted `rpc` implementation. Calls went to Kimi's real authenticated local WebSocket endpoint, not a fixture. The actual methods `models.current`, `conversations.setModel`, `conversations.getKimiModelList` and `conversations.updateKimiModelList` all succeeded.
3. Connected with selected model `kimi-work/k3-agent`. The adapter reported `connected` with no catalog error, wrote its owned loopback address, and added the gateway's catalog to the real runtime. There were initially two native Kimi models.
4. Sent a synthetic authenticated HTTP request to the adapter's `/v1/chat/completions`, using the real Kimi credential only on that loopback hop. The adapter used Magpie's credential for the gateway hop. Official Magpie then invoked the real Kimi Work provider and service. The response was HTTP 200 with a complete SSE stream and exactly `KIMI_WORK_MAC_OK`. Magpie's route record named agent `kimi-desktop`, provider `kimi-work`, requested model `kimi-work/k3-agent` and served model `k3-agent`.
5. Stopped the adapter, verified the restoration results below, and stopped only the temporary gateway.

## Restoration observed

```json
{
  "baseRestored": true,
  "currentRestored": true,
  "nativeCatalogRestored": true,
  "credentialsUnchanged": true,
  "unrelatedSettingsPreserved": true,
  "noSyntheticModels": true,
  "modelSnapshotRemoved": true,
  "sandboxGatewayStopped": true
}
```

Configuration preservation here is a semantic comparison, not a claim about JSON whitespace. The credential-bearing document was held in memory for comparison only; it was never copied to a backup or uploaded. No app resources or model-menu injection patch were installed.

## Limits

The inference originated from a synthetic HTTP client at the bridge, **not a desktop UI-submitted Work conversation**. This proves the actual macOS control methods, configuration lifecycle and streamed adapter → official Magpie → real provider route; it does not prove desktop UI selection behavior. This run did not exercise Kimi search/fetch, SIGKILL, sleep/wake, natural token rotation or a future Kimi release. The Windows desktop UI observation is separate.

The private API failure/rollback behavior and manual recovery are documented in README. The disclosed split routing of inference to Magpie and search/fetch to Kimi remains a separate maintainer review point; the subscription-provider decision in #171 is not presented as a desktop UI or search/fetch test.
