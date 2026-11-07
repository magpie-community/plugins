# Compatibility record

## Current role-profile candidate: native Agent routing, 2026-11-07

The signed-history candidate was installed into official Magpie **0.1.3208** and exercised in ordinary signed-in Kimi **3.2.25, build 3.2.25.22 / Daimon 1.0.6**, on macOS with Bun **1.4.4**. All **19 installed files** matched its tarball: 16 runtime/UI files plus documentation and package metadata. The native companion-plugin path loaded the ordinary worker profiles, the embedded page confirmed application, and real Work turns verified default-secondary, explicit-primary, resume and inherit-primary routing with native Read tools. Primary-page saving and idle disconnect/restoration/reconnect also passed. Older native pool-based turns are separate historical evidence.

### Why the native pool was replaced

The earlier candidate could write a valid two-model pool and acknowledge an idle-session reload, but ordinary queue dispatch rebuilt the native configuration before the next turn. In `native-runtime-resume-events.jsonl`, the 2026-11-07 **09:58:39Z** events show desktop model definitions dropping from **58 to 4**, and the converted home pool dropping from **2 entries to 0**. The following turn then started against the regenerated configuration. This observed lifecycle supersedes assumptions based on an idle file, a prior reload acknowledgement or an earlier successful pool-based turn.

The current path therefore adds neither native model definitions nor `secondary_model` pool entries and performs no background reassertion of them. Native TOML handling remains only to migrate and restore earlier `state.secondary` / `state.secondaryPool` ownership, using their narrow original snapshots and acknowledged cached, idle-session reloads. Primary/menu recovery and explicit-stop restoration are retained. Those restoration writes still serialize parsed TOML; they do not preserve comments or original numeric representations, and never back up model/provider credentials.

### Current routing and profile contract

The bridge augments only the native `Agent` declaration sent upstream, adding optional `model` values `primary`, `secondary` and `native`. Omission selects secondary, or the primary when the secondary preference is empty. It aggregates complete JSON/SSE tool calls before translating the response. For a new primary/secondary task it removes that selector and replaces `subagent_type` with a stable ordinary worker profile for the selected model ID. It preserves prompts, paths and other arguments. `native` removes only the selector, retaining the requested specialized type; resume/fork keep the existing profile and binding.

Each generated profile declares general native tools (`tools: ["*"]`), disables `Agent` / `AgentSwarm` and declares no subagents. The parent's native permission mode is inherited; user-registered tools remain gated by availability to the parent. Kimi's native permission guards remain in force. The profiles are general Work workers, not transparent copies of the original `coder`, `explore` or `plan` restrictions. Selecting `native` preserves that original profile.

A signed local HMAC section in the role's system prompt binds its model. The bridge verifies and strips it before forwarding; the secret exists only in adapter state. User/history labels and initial task prompts do not establish identity. Keeping identity in the role prompt supports the same target after native compaction discards the task history. The target is checked against the current gateway allow-list on every inference, including resumed work; a disabled model fails with `model_not_enabled_for_kimi` instead of silently using the primary.

Authenticated opaque call IDs retain the original selection for audit. Only the bridge's own verified assistant Agent history regains an explicit role selector; an omitted default stays omitted. These IDs preserve native tool-result linkage and never establish the request's route.

### Native companion-plugin lifecycle

The Magpie package generates only a manifest and agent Markdown files in `~/.config/magpie-kimi/native-model-roles`, with neutral plugin ID `local-work-model-roles-<hash>` and stable model-ID-based profile names. It uses Kimi's existing `installPlugin` / `updatePlugin` APIs with `{source}`, then `getPluginInfo` and `setPluginEnabled`. Kimi's installer copies and registers the source under `<KIMI_HOME>/plugins/managed/<id>`; the adapter does not edit the native plugin registry itself. The manifest stays at `1.0.0`, and a local same-version update still copies changed files. Kimi's plugin agent loader refreshes during reload, followed by a checked `reloadActiveSessions` acknowledgement for cached, idle sessions. This path requires no application restart.

Old generated profiles remain for resume. A same-name source or installed-file edit produces `agent_profile_conflict` rather than an overwrite. Native profiles, application resources, Magpie core and SQLite remain untouched. Disconnect restores the native gateway and earlier owned TOML/menu state, while leaving the declarative companion profiles available for existing tasks and manageable through Kimi's native plugin UI.

Secondary support is gated by the native V2 kernel family, not a hard-coded application version. The legacy primary bridge remains available; an explicit secondary on a legacy or unknown family reports `secondary_model_unsupported_runtime`. The embedded model page still saves both preferences in one place, using the official host CLI for primary changes and retaining the documented helper-discovery, partial-save and platform limits.

### Verified native Agent turns and history

In a new native Work conversation, the first ordinary Agent omitted `model` and used the Astra-bound profile; the second explicitly selected primary and used the Sol-bound profile. Each executed one native Read, with the fixture marker present in the matching tool result. Eight gateway requests completed with HTTP 200: six Sol and two Astra. Requested and served targets matched after normalizing the provider prefix. Native Agent arguments contained no shim `model`; their authenticated call IDs retained the omitted-default and explicit-primary intentions, and native results referenced the corresponding IDs. The parent's final audit explicitly confirmed both selections. Earlier unsigned-history presentation failures are not used as evidence for this fix.

After the embedded page cleared secondary to inherit-primary and confirmed application, resuming the existing Astra Agent with an explicit primary selector kept its original profile and model. It was not recreated, executed Read again and emitted two new Astra requests. A subsequent new ordinary Agent omitted the selector, used the Sol profile and completed Read with two Sol requests. The parent audited both calls successfully. This turn had seven gateway requests, five Sol and two Astra, all HTTP 200. Across the two turns there were **15 requests, three new subagents, one resume and four successful Reads**; request totals include parent and continuation calls.

### Current test results and limits

The final source passed **234 package tests, 0 failures and 1,975 assertions across 18 files**. Repository validation passed **6,714 tests with 8 skips, 0 failures and 224,592 assertions across 485 files**. It excluded the two default-excluded agent-console directories and the window-warmup browser test; no Chrome or Playwright was launched. Registry validation exited 0, with GoAnyAPI's remote resolution unavailable and its cached record retained.

Four temporary-source mutations produced assertion failures: skipping primary restoration RPCs on stop, removing typed Agent-alias history migration, disabling staged JSON/TOML byte comparisons, and removing authenticated selection-history restoration. Production source remained unchanged. Independent review found no confirmed blocking bug.

Full child-compaction binding is supported by current native-source analysis, which retains the role's system prompt, and empty-history consumer tests. The public `conversations.compact` API targets only the main agent, so **forced native child compaction was not tested**. Fork has isolated coverage only. Windows/Linux, paid tools and billing have no new native acceptance in this revision.

The same embedded page saved primary Astra, confirmed application, then restored Sol and confirmed again. At both stages the host's applied-model record, stash reference and current connection agreed, including the credential comparison performed only in memory. Secondary remained inherit-primary. With Work idle, the native Magpie Agent card disconnected Kimi: both desktop JSON and converted runtime TOML returned to the official service, recovery ownership cleared, and the four native model entries and `k3-agent` selection remained. Selecting Sol on that card reconnected both addresses to the bridge, with secondary still empty and no model pool. These operations sent no additional inference and required no application restart.

Native model entries and unrelated settings matched the before-run comparisons. The credential aggregate changed during this acceptance interval; its cause was not isolated, so credential bytes are not claimed unchanged. No credential values or complete configuration copies were retained. The final documentation-only repack retained the tested runtime bytes and its 19 installed files were checked against the final tarball.

## Historical legacy primary and secondary native Agent turn, 2026-11-07

The following dated records describe earlier revisions. Their implementation details and native results are retained as evidence; they are not the current role-profile support contract.

The local 0.1.6 candidate ran on macOS 27.2 arm64 with ordinary signed-in Kimi desktop **3.2.17, build 3.2.17.4**, official Magpie **0.1.3077**, and Bun **1.4.4**. No Kimi or Magpie application resources were changed. The embedded Magpie plugin page rendered the current primary model and the gateway catalog; its save and refresh controls confirmed the secondary preference was applied. The same settings form was also exercised in a temporary browser tab.

With primary `codex/gpt-6.1-sol` and secondary `codex/gpt-6-astra`, a new Work conversation in a task-owned test project requested two new native `Agent` subagents: one with `model="secondary"`, then one with `model="primary"`. Both completed, each used zero tools, and the parent reproduced their distinct requested markers. This was submitted through Kimi's native UI. Magpie's routing metadata recorded six Sol requests and two Astra requests, all HTTP 200 and each with its requested model equal to its served model. These eight requests include the runtime's auxiliary/continuation calls; they are not eight subagent creations.

Saving **inherit primary** afterward removed the adapter-owned secondary and experimental tables from the runtime TOML, returning to their absent baseline. The main Sol connection remained enabled and connected, with no active turns or tools. All four native model entries and unrelated desktop settings matched their before-test comparisons. The credential aggregate differed during the live-turn phase; its cause was not isolated, so this phase does not claim credential bytes were unchanged. No credential values or full configuration copies were retained.

That live candidate's **76 tests passed with 682 assertions**. An offline tarball install matched all eleven runtime/UI files to that candidate's source before installation into the real host. Busy-session retry, partial reload failure, regeneration and shutdown restoration were covered by isolated synthetic tests, not additional real disconnect/reconnect cycles in this phase. Official paid search/fetch, allowance accounting, sleep/wake and other operating systems were not newly tested. The original primary-only bridge has the separate record below.

The inheritance revision came after this live check: when the original native secondary setting was already enabled for another registered alias, clearing the plugin preference must keep new subagents on the current primary model while connected, and preserve the original baseline for disconnect or shutdown. Isolated regression tests cover the actual mock-bridge route, applied status, following a changed primary without repeated reloads, and disconnect restoration. That revision passed **77 tests with 704 assertions**. The signed-in UI check above used the earlier adapter revision.

### Revised model page and recovery tests

The first review revision, `b5f46210`, passed **113 tests with 795 assertions across 10 files** under a temporary HOME on Bun 1.4.4. The primary picker uses Magpie's official CLI, with a private child-process flag preventing another Kimi adapter from starting. Its command arguments, inherited environment and profile directory are covered with a fake executable. Primary-only saves retain the secondary preference; partial saves are reported without rolling the primary back.

Isolated regressions reproduce and fix a failed targeted session reload blocking disconnect restoration, and missing or unsupported secondary TOML blocking the primary connection. The latter tests send an actual HTTP request through the mock bridge and confirm the primary route remains usable. Shutdown closes the settings service without another secondary RPC; a changed service port is rebound when options reload.

The page has 22 pure VM interaction tests covering host-language forwarding, English and Chinese copy, neutral radio lists, primary and secondary saves, partial failure, applied-state confirmation, and clearing a secondary preference while disconnected. These tests do not use a browser engine. Real loopback WebSocket tests exercise both reload names through the production RPC allow-list. Removing either allow-list entry, or disabling the native byte-comparison guard in temporary source copies, makes the added guard tests fail.

### Native primary-model page save, 2026-11-07

The first review revision was installed into official Magpie 0.1.3077; all 15 installed package files matched its checked tarball. In Magpie's native window, the Chinese model page selected and saved primary `codex/gpt-6-astra`, then restored `codex/gpt-6.1-sol`. At both stages the host's applied-model record, stash reference and connection model agreed, and the stash credential matched the current connection in memory. The page distinguished saving from confirmed application; refreshing confirmed the applied state. The normal Agents → Kimi card also showed the restored Sol selection. The secondary preference remained inherit-primary.

Kimi remained **3.2.17 / build 3.2.17.4**, with Daimon **0.6.7**, running and idle throughout; it was not exited or restarted. No Work conversation or inference was submitted for this check, and no Chrome or Playwright was started. All four native model entries and unrelated Kimi settings matched their before-install comparisons. The credential aggregate changed during the installation/UI-save interval; its cause was not isolated, and no credential values or full configuration copies were retained. This check verifies the real page, official CLI and host synchronization; the failed-reload and unsupported-TOML cases remain isolated-test coverage.

### Subsequent review guards

The subsequent revision passed **128 tests with 886 assertions across 10 files** under a temporary HOME on Bun 1.4.4, including 24 pure VM page tests. The helper now validates the basename of both automatically discovered paths and resolved targets. A shell parent, a non-Magpie PATH result and `magpie-bun` are rejected without executing a model command. Explicit `magpiePath` remains available for custom executable names. Windows parent discovery uses PowerShell CIM with a numeric process ID, argument-array invocation and a bounded timeout; failures fall back to PATH or the configured option. Fake-exec tests cover this lookup and fallback, not a real Windows installation.

HTTP regressions reject a valid-looking primary ID absent from the gateway catalog without calling the host setter, and detect a gateway-key change during primary saving in both primary-only and combined saves. A disconnect test first lets an external writer restore the baseline and a normal tick clear the application marker; disconnect must still request the final baseline batch reload. Removing each corresponding guard in a temporary module copy makes its behavioral test fail. The discovered-executable basename guard was also checked this way. The V2-layout checks are described below.

These changes to the helper, adapter and page follow the native check above. This revision's isolated tests and package checks do not extend that earlier live result to a different Kimi runtime. No real Windows/Linux test, application restart, browser or model request was used for this review round.

### Historical runtime TOML representation

The patch targets the two secondary-model scalars, but writes serialize the whole parsed document with `Bun.TOML.stringify`. Comments are dropped and numeric representations can change: `1.0` is emitted as `1`, changing a TOML float to an integer. Integers above 2^53 are rejected by `Bun.TOML.parse` and report `secondary_config_unsupported`. These cases were confirmed with synthetic input on Bun 1.4.4. Daimon regenerates this runtime file; the adapter does not preserve its comments or original numeric representations.

### Historical Kimi 3.2.25 / Daimon 1.0.6 static boundary

A separate read-only inspection of a staged Kimi **3.2.25.22 / Daimon 1.0.6** bundle found both reload RPC names and the runner/control layout still present. Its V2 core, however, uses a model pool for the standard `Agent` tool rather than the old built-in `primary|secondary` roles. It retains legacy `secondary_model.model` parsing but no longer uses the `secondary-model` experimental key. Daimon also converts the legacy TOML into `runtime/kimi-code/home/config.toml`, which V2 actually reads. The staged application was not started during that inspection.

Revision `536617a` detected the converted file and reported `secondary_model_unsupported_runtime` rather than applying an ineffective legacy patch. Its isolated tests covered initial V2 detection and conversion after a legacy secondary was applied. That guard revision did not claim V2 support.

### Superseded V2 model-pool implementation

This section describes the removed pool-based candidate. Its writes, alias registration, retry/reassertion and empty-session confirmation policy are historical; the current role-profile path above does not use them.

The V2 path uses the selected models' existing catalog aliases as keys in `secondary_model.models`, with descriptions identifying the primary and secondary roles. New aliases are neutral `local-model-<hash>` names. The old branded prefix remains recognized for routing, migration and cleanup. `secondary_model.default_model` selects the secondary alias for new Agent subtasks. Global model/provider definitions are not copied into ownership state. If both selections name the same model, the pool has one entry and Kimi hides the redundant model-choice parameter. Clearing the secondary preference after use fixes new subtasks to the current primary; this explicit pool follows Kimi's pool thinking defaults. Resume and fork retain their native model-binding rules.

The ordinary Agent tool does not translate literal `primary` or `secondary` strings into these pool entries. Its generated tool description lists the actual aliases and their role descriptions. A prompt can request a role, and the agent chooses its corresponding entry. Unsupported converted layouts remain guarded instead of being written as though they had this contract.

A pure-function probe extracted the installed 3.2.25.22 core's real TOML parser/stringifier, secondary schema, pool resolver/validator, Agent schema/getters, tool registry and request projection. All **24 checks passed**, including the omitted-model secondary default, explicit primary selection, one-model pool behavior and the existing hash alias reaching the wire model. External catalog dependencies used synthetic stubs. The installed bundle SHA-256 was `ea1c5125c7af0825c3e5105f2753f8d1f2bccfa1bf1360e1f72c525d3a3f4f09`. The probe did not import the whole bundle, launch an application or issue an inference.

The superseded pool candidate passed **211 tests with 1,636 assertions across 16 files** under a temporary HOME on Bun 1.4.4, including 28 pure VM page tests. V2 cases covered two-model HTTP routing, the secondary default, same-model selections, clearing and following the primary, home-only regeneration, busy sessions, empty batches, targeted retries, external edits, disconnect/stop restoration, restart and legacy-to-V2 transitions. Settings reads invalidated confirmation when definitions, effective capabilities/effort or daemon generation changed. Pool ownership snapshots contained only aliases, descriptions, defaults and narrow ownership metadata, including the previous written binding while a new atomic write was pending. They did not copy model/provider definitions or their authentication fields.

Primary/menu restore retains recovery ownership and the model backup until both the menu and final runtime reload are acknowledged. This includes failed calls, lost replies after side effects, an address already restored by synchronous exit, and a first apply whose reply was lost. A subsequent disabled start can finish recovery. Explicit stop skips only extra secondary-session reloads. The real loopback WebSocket tests cover these failures; an independent frozen-source matrix passed **52 checks** across primary failures (8), stop/restart failures (16), apply reply loss (2), the production entry's registered exit callback (8), and external-pool resolution through the extracted real core (18). These are isolated checks, not a claim that the actual desktop process was quit and reopened.

Real permission-denied writes reproduce secondary-selection and baseline-restoration failures. The previous written binding remains owned until a new write is confirmed, and baseline reload intent is set before restoring files. Retries, stop, synchronous exit and crash recovery can therefore finish the operation. Independent pool edits retain valid native entries; bindings that depend on plugin aliases being removed are cleaned before restoration, avoiding unresolved model references. An explicit new selection supersedes an intermediate external edit and later restores the original baseline. Unowned incompatible bindings are reported instead of silently changed.

Runtime dispatch uses `kernel.agentKernel`, not application version strings or optional LoopControl fields. Known legacy kernels ignore residual converted files. Known V2 kernels wait for their home file; unknown or ambiguous families cannot report a secondary as applied. Equivalent native `provider`/`provider_id` and `model`/`name` forms and effective model overrides are supported. The model context and provider/wire binding must resolve, and effective effort must be compatible. Missing definitions or another provider are rejected before any pool write or reload. Deleting the alias or effort guards makes the corresponding regressions fail.

The checked-in synthetic Agent schema/description and history fixture was generated through the installed core's actual Agent getter, message lowering and request projection. Real bridge tests send it with both old and neutral aliases and assert no added branding reaches upstream. Normalization is confined to Agent model identities: user messages, literal filenames, other tools, results, arbitrary keys and the rest of an Agent prompt remain unchanged. Migration retains the selected old definition, acknowledges the neutral selection, then prunes old entries. Its independent **12-case** failure matrix covers each step before/after side effects and across plugin restart. Removing historical-alias normalization, synchronous pool restoration, restored-baseline reapplication or post-staging byte comparisons makes targeted tests fail in temporary source copies.

Daimon can regenerate the converted file even when the legacy TOML is unchanged. Reconciliation therefore checks the converted file after the primary/catalog control calls. Writes wait for idle and use the native byte-comparison guard. V2 confirmation requires an actual cached-session reload acknowledgement; an empty batch remains `secondary_model_waiting_session`. New sessions reuse the core's initialization promise, so neither creating a session nor waiting for the 150 ms file watcher proves the configuration was read. After a confirmed reload, Kimi's dynamic Agent getters and per-request tool reconciliation expose the changed pool.

The installed Daimon generator uses direct `fs/promises.writeFile` for both TOML files; its JSON writer uses temp+rename. The adapter compares expected bytes after staging, immediately before publishing, and rejects a detected competing edit. This is best-effort comparison, not an atomic cross-process compare-and-swap: an uncoordinated Daimon write can still race the final rename, and a well-formed partial read can be indistinguishable from an intentional document. No full credential-bearing file is backed up. Serial idle-time updates remain the tested operating boundary.

### Historical macOS V2 native UI acceptance, 2026-11-07

The following Work turns preceded the neutral-alias, recovery/contract and role-profile changes above. They establish the earlier pool-based V2 route behavior; they are not acceptance of the current candidate.

The candidate was installed into official Magpie **0.1.3208**, with ordinary signed-in Kimi **3.2.25 / build 3.2.25.22**, Daimon **1.0.6** and Bun **1.4.4**. All **16 installed package files** matched its checked tarball. No Kimi or Magpie application resources were patched, and neither application was restarted for this acceptance.

The native embedded Chinese page saved secondary `codex/gpt-6-astra`, changed primary **Sol → Astra → Sol**, and retained the secondary preference. The host's applied model, stash reference and connection agreed at each primary selection. The converted pool correctly had one entry when both choices were Astra, then two entries after the primary returned to `codex/gpt-6.1-sol`. With no loaded kernel session, the page remained waiting instead of reporting application. Merely opening a conversation did not load that session; the waiting hint was subsequently clarified to request a short Work message and an idle session. That was a wording-only change verified by the page's VM tests; adapter logic stayed unchanged.

A native UI-submitted Work turn created two new ordinary Agent subtasks in the task-owned test project. The prompt asked the first to omit `model` to exercise the configured secondary default, and the second to select the primary role from the tool's model descriptions. Both completed with zero tools and their distinct expected markers, which the parent reproduced. The expanded native Agent panels showed each result. Routing metadata recorded **six requests: five Sol and one Astra**, all HTTP 200. Magpie 0.1.3208 records provider-qualified requested IDs; the served model matched each exact requested provider/model target after accounting for that prefix. The six requests include parent and auxiliary/continuation calls, not six subagent creations. After the runtime became idle, the adapter obtained confirmation and the refreshed page showed both selections applied.

Clearing the secondary preference on the same page produced a single pool entry for the current Sol primary. A second native UI turn created one new default Agent, which returned the expected inherit-primary marker with zero tools. All **three routed requests** in that turn used Sol and returned HTTP 200 with matching served targets.

With Work idle, an authorized temporary disconnect through the official CLI restored the original service in both desktop JSON and converted TOML, removed the owned pool/default, and cleared ownership. All four native model entries and the original `k3-agent` selection remained. Reconnecting through the same CLI to Sol returned both service addresses to the active bridge; the secondary preference stayed empty and no pool ownership was recreated. No additional inference was sent for disconnect/reconnect. Native model entries and unrelated desktop settings matched their pre-install comparisons throughout. Credential aggregates changed during the primary-selection interval; the cause was not isolated, and no credential values or full configuration copies were retained. The adapter's explicit field writes and narrow snapshots were checked; native token refresh was not instrumented or ruled out, so the aggregate comparison cannot attribute the change.

This round did not launch a test browser, Chrome or Playwright. It did not verify Windows/Linux V2 operation, paid search/fetch, allowance accounting, sleep/wake or natural credential renewal.

## macOS desktop UI turn, 2026-11-06

On 2026-11-06 a real signed-in Kimi desktop **Work** conversation submitted a turn from the native UI while the adapter was connected: macOS 27.2 arm64, ordinary Kimi desktop **3.2.17, build 3.2.17.4**, official Magpie **0.1.3077**, agent package **0.1.5**, Bun **1.4.4**. The model was selected in Magpie and served by an external, non-Kimi provider: provider `codex`, requested and served model `gpt-6.1-sol`.

The UI prompt named the fixture's relative path and did not include its contents. The task-owned fixture contained a single marker line.

1. The agent's native `Read` tool call requested that fixture path. In the expanded conversation, the tool response's first line and the turn's final reply contained the same marker.
2. A later UI turn in the same conversation did not call a tool. It recalled the earlier marker from the conversation history, reproduced it accurately, and issued no new tool call.

Both turns used the ordinary signed-in Work conversation; no UI code, application resource or model-menu patch was installed. Magpie's request log recorded three routed requests for the tool round and one for the recall round, each HTTP 200 with `requestedModel` equal to `servedModel` (`gpt-6.1-sol`). Those are routed requests, not a count of tool calls; the tool-call evidence is the expanded conversation described above.

In this run, the first turn without the project selected refused the outside-workspace fixture; selecting its project made the retry succeed.

The generated runtime TOML carried the bridge address during the successful turns. The package's 36 tests passed, and SHA-256 comparisons confirmed that all six installed runtime files matched the tested repository files byte for byte.

With Work idle, disconnecting through the official Magpie CLI restored `https://agent-gw.kimi.com/coding/v1` in both the desktop JSON configuration and generated runtime TOML. Bridge aliases were removed, and all four native models and the current native selection were preserved. A local in-memory comparison found credentials and unrelated settings unchanged; no credential values or full configuration backup were persisted.

Reconnecting through the same CLI to `codex/gpt-6.1-sol` succeeded. The adapter was left enabled and connected with 52 catalog models, matching loopback addresses in JSON and TOML, and no active turns or tools. No additional inference was sent during the disconnect/reconnect check.

Kimi's own model menu still showed its native label (**K3**) while the actual model came from Magpie's selection; custom aliases in that menu remain unverified. Kimi's search/fetch and other paid tools, their billing and allowance accounting, sleep/wake, natural credential rotation and non-`Read` tools were not exercised.

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
