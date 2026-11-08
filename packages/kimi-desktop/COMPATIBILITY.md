# Compatibility record

## Review follow-up after `6e3257e`, 2026-11-08 (SGT)

The package remains **0.1.6**. This section describes the quoted-marker, catalog-absence, dotfile and equivalent-directory fixes. The dated records below describe earlier revisions and do not extend these results. No Magpie core or Kimi application resources were patched.

### Changes and assertion-red guard checks

| Issue | Change | Representative regression | Guards / assertion-red test observations |
| --- | --- | --- | --- |
| 1: quoted route markers | Without a routing key, retain 0.1.5 request-body behavior and existing alias cleanup. With a key, authenticate/strip system and developer identity only; invalid identity still returns 409. Neutralize reserved opening/closing tag prefixes in other fields and shared instructions without binding. Keep the final serialized residue check. | `R2-1 no routing key preserves route quotations in user`; `a copied secondary section in user and tool content never selects a route and neutralizes` | 7 / 20 |
| 2: temporary catalog absence | Persist the first-missing time and count. Retire only after three consecutive successful missing catalog synchronizations and ten minutes, with idle, verifiable profile synchronization. Failed fetches and cached ticks do not count; returning targets retain the old token before retirement. | `R2-2 successful absence count and start time survive failure, cached ticks, and restart`; `R2-2 a selected missing secondary recovers before grace and is pruned after sustained absence` | 31 / 74 |
| 3: dotfiles | Skip dot-prefixed entries before stat/read/hash/pruning in both agents directories. Preserve them; ordinary unknown files still conflict. | `dot-prefixed entries are skipped before stat/read/hash/delete and never conflict`; `R2-3 source and managed dot files stay unchanged through stable readiness and retirement` | 2 / 2 |
| 4: equivalent directories | Compare canonical real paths for existing source/managed directories, including parent symlinks or junctions. Retain provenance, exact manifest, whole-root, direct-root/managed-parent/registry symlink and byte-comparison guards, plus deleted-source cleanup. | `a sibling directory under the same managed parent is never owned even with a matching manifest`; parent-directory alias lifecycle regressions | 7 / 20 |

Each issue first had a failing synthetic reproduction. **47/47** single-point guard mutations then produced genuine assertion failures in isolated copies; non-assertion/environment errors were not counted. The **116** test-failure observations are summed per mutation, so the same test can count for multiple mutations. The eight helper mutations were rerun after removing twenty full-line `// MUTATION` comments; all remained assertion-red. That cleanup retained every newline and all executable text. Previous B1–B3 and S1–S3 regressions remain in the passing package suite.

Five additional catalog-retirement regressions cover temporary unknown source/managed files, edits to owned profiles and registry-provenance conflicts. A detected conflict defers binding deletion until owned profiles can safely synchronize. The preflight is not a cross-process filesystem transaction against a later I/O failure or another writer.

### Automated validation

The final executable/test source, including the comment cleanup, was copied unchanged into fresh temporary trees. Each step used a temporary HOME below TMPDIR, synthetic credentials, and an OS policy denying the real HOME and real application/browser paths. Registry-generated AtomCode state stayed in the temporary checkout. No unrelated package source was changed.

| Command | Actual final result |
| --- | --- |
| `HOME=<temporary HOME> bun test packages/kimi-desktop` | **450 pass, 0 fail, 3069 assertions** |
| `bun scripts/check.mjs kimi-desktop` | **Exit 0** |
| `bun scripts/check.mjs` | **Exit 0** |
| `HOME=<temporary HOME> bun test` | **7271 pass, 20 skip, 0 fail, 238450 assertions; 516 files** |

The commands ran in the listed order on Bun 1.4.4 through `sandbox-exec -f <owned policy> <bun> ...`, with `AGNES_BROWSER_TEST=0` and an explicit `BUN_OPTIONS` preload. No command-line test exclusions were added; the repository's two default agent-console exclusions remain. Real browser/native-app availability follows the OS deny policy. Synthetic VM, fake-browser and fake-CDP cases remain included. This is an **unfiltered command with repository defaults, real-ps bootstrap and passive observer**, not a pristine bare-process run or native browser acceptance.

The bootstrap redirects only calls actually resolving to system `/bin/ps` to a private, ad-hoc-signed non-setuid copy of Apple's binary, with real argv and output. All three architectures and 25 file-backed instruction/constant sections were compared unchanged; the original `/bin/ps` bytes and mode were untouched. Fixture-provided fake ps commands remain unchanged. The corrected bootstrap preserves execFile/promisify metadata. A passive observer records only owned fake-Antigravity smoke argv/runtime/exit and synthetic output; it changes no timeout, fixture or result. The bootstrap SHA-256 is `040b912e38b49104b71b8cdc89a79f31b801d3301a65c8e1453f505f774cc37d`.

Earlier unsuccessful runs are retained separately, not counted as passes: the first OS-policy/HOME setup yielded 7016 pass / 43 fail / 9 skip; the corrected HOME/availability setup without the ps bootstrap yielded 7255 / 11 / 20; an initial bootstrap lacking promisify metadata yielded 7198 / 63 / 20. A later run yielded **7270 / 1 / 20**, with one synthetic Antigravity usage smoke failure. Its cause remains unknown: focused replay and two unchanged observed whole-repository reruns passed. These passes do not claim to have fixed that one-off failure. DSH's nested OS-sandbox launch was rejected before project tests; the supervised Sol executor ran the same isolation policy without broadening DSH permissions.

### Native Kimi 3.2.25 acceptance

The fixed runtime candidate was installed with the official Magpie CLI and its **20 installed package files** matched the checked archive (package.json compared semantically). Kimi was **3.2.25 / build 3.2.25.22**, Daimon **1.0.6**, on macOS arm64. Magpie was **0.1.3240** for cases 1–4 and **0.1.3285** after an earlier exit/restart attempt. The later user-operated case 5 started with **0.1.3329** and observed **0.1.3335** after the user reopened Magpie. No Chrome or Playwright was started for these checks.

Kimi's application-support directory is a parent symlink to relocated storage. Its registered managed root uses the physical path while the adapter also encounters the logical path. Installation, clear and disconnect now succeed across those equivalent directory forms without a drive-specific exception. An earlier native attempt stopped at that conflict and was not accepted.

| Case | What was actually observed |
| --- | --- |
| 1. No secondary selected | After retiring a pre-existing owned registration, native `getPluginInfo` returned fixed not-found. A new UI-submitted Work turn performed one real Read and returned the fixture text. The native Agent schema had no `model` field or generated role, and still required only prompt/description. |
| 2. Three child routes | A UI-submitted parent created three children and each performed a real Read. The requested default-secondary child used DeepSeek V4.1 Flash through the configured group; `model="primary"` used Sol; `model="native"` retained native `explore` and used the primary Sol bridge. Ten gateway requests were 200: eight primary and two group requests. |
| 3. Clear secondary | Observed the registration enabled=false before its removal; final phase was disabled and native `getPluginInfo` returned fixed not-found. The installed await chain requires checked reload acknowledgement between disable and remove. This is state/order evidence, not an RPC packet trace. |
| 4. Disconnect and reconnect | Disconnect restored the original official provider URL in native JSON and both runtime TOMLs and removed the companion registration. Reconnection restored the original Sol primary selection with secondary opt-in ready. Native current choice and all four native model definitions were preserved. |
| 5. Quit Magpie and restart Kimi | **Passed in the later user-operated run.** At 22:47:38 SGT on 2026-11-08, the old plugin host had exited, no current owner was alive, the official service URL was restored and the owned disk registration was disabled. At 22:47:55, after Kimi's runtime PID and startup generation changed, native `getPluginInfo` returned the expected ID with `enabled=false` while Magpie was still offline. Native owner/control identity stayed stable across that RPC. At 22:50:10, the user-reopened host was ready and the temporarily selected companion was enabled again. |

For case 2, the native history contains arguments **after bridge translation**. The recorded role intent, authenticated child bindings, completed Read calls and gateway model attribution support the observed routes; they are not a capture of raw supplier arguments. Literal simultaneous omission of `model` and `subagent_type` is covered by isolated protocol tests; the native prompt requested it, but its raw pre-translation arguments were not captured.

Two short retirement observers expired before final state save or before the native disconnect confirmation was clicked. Their failed observation windows remain recorded; subsequent snapshots and native fixed-not-found results establish the final clear/disconnect states. Earlier case-5 attempts stopped at the quit dialog, missed intentional saved recovery debt with an active=false predicate, or lacked a controllable window; none is counted as a pass. The later manual run used an independently running, read-only observer with 11 synthetic checks and 42 assertions. Its restart check required a new live native PID/generation, the old PID gone, stable owner/control identity across `getPluginInfo`, and a second host-offline snapshot. A changed control token alone could not satisfy it. The observer exited 0 after offline native disablement and the user-operated host return were both confirmed. No new Kimi Work inference was submitted for this manual run.

After the manual run, the saved selections were restored to **Sol / no secondary**, with the companion phase disabled, registration removed and native fixed-not-found confirmed. The default-port settings API refused the DSH restoration attempt before any save; the temporary secondary value alone was then restored by original-byte comparison and private temp/rename, preserving all other connection bytes. The connected primary bridge matched native JSON and both TOMLs. Other 23 native plugin records, other Magpie plugin entries, native choice/definitions and the workspace AtomCode-state digest matched the before-manual-run snapshot. No full real configuration or credential backup was retained. The tested runtime remains `e0ac41f`; all 20 installed files matched its archive before and after the run. This documentation-only follow-up was not reinstalled. Magpie exit/start/restart operations in the accepted run were performed by the user; the observer changed no application resources or native settings.

### Remaining native boundaries

Windows/Linux native behavior, native child compaction/fork, resume after disable or removal, paid tools/billing, sleep/wake and natural credential rotation remain untested in this follow-up. An optional native read of a fixture containing a valid signed route section was stopped by automatic approval review before sending, because the fixture carried a valid token/MAC. The unused fixture was byte-compared and removed; valid-token quotation behavior is isolated-test evidence only.


## Historical `6e3257e` isolated checkpoint, 2026-11-07–08 (SGT)

At this historical isolated checkpoint, `6e3257e` had not been accepted in the native Kimi UI. The later live results and limitations for the current follow-up are recorded above. The changes after `cc9a023` were developed with temporary HOME directories, synthetic credentials, synthetic control peers and protocol/VM tests, plus read-only native-source inspection. Kimi-specific validation did not read a real Kimi HOME, install the candidate, launch or control Kimi, send a real model request, or use a browser or Playwright. The native turns and desktop operations recorded for `cc9a023` below belong to the previous revision.

### Baseline opt-in routing contract

An empty or absent `secondaryModel` keeps native Agent declarations, audit history and response calls unchanged, apart from the existing neutral alias cleanup. It does not install or enable a role plugin or reload sessions for role routing. Explicitly selecting secondary enables optional `model="primary|secondary|native"` roles only after the profiles are ready. A new call defaults to secondary only when both `model` and `subagent_type` are absent; a native type without `model` retains its original restrictions. Clearing secondary during a busy turn preserves the current schema until idle retirement completes, then turns new role translation off.

Generated ordinary workers use general native tools (`tools: ["*"]`), disable `Agent` / `AgentSwarm` and declare no subagents. They inherit the parent's permission mode and available user tools; they do not reproduce the specialized restrictions of native `coder`, `explore` or `plan` profiles. Resume or fork keeps an existing authenticated binding while that target remains allowed and the runtime already has the profile. Clearing secondary schedules registration removal; neither disable nor removal is evidence that a native profile remains resumable.

Profiles carry a random opaque route token and MAC, with token-to-model mapping only in `adapter-state.json`. Their text contains no target ID or reversible target encoding. Binding state must persist before profile publication or plugin-control calls; a failed save must not let the next retry publish unbound token text. Profile names have a key-specific namespace. All reserved route sections are consumed locally: unknown or invalid identity, or a section in another message/tool context, fails with HTTP 409 `agent_profile_unbound` rather than selecting primary or reaching upstream. Authenticated opaque call IDs preserve explicit role choices for audit without establishing the route. Every inference, including an existing worker, checks the bound target against the current gateway catalog; a removed target is refused without falling back to primary.

Only Agent tool fragments require translation buffering; non-Agent tools are released as their identity becomes known. Invalid Agent JSON or role values pass through for native validation. A missing `finish_reason` flushes pending calls at `[DONE]`; missing indexes use the native pass-through path rather than destroying the stream. These are isolated protocol results, not a native UI acceptance claim.

### Baseline companion lifecycle and bounded files

The companion is a declarative `kimi.plugin.json` plus generated Markdown agents, with neutral `local-work-model-roles-<hash>` ID. The manifest is exactly `{name:<id>,version:"1.0.0",description:"Local Work model roles",agents:["./agents"]}`; it grants no other plugin capability. Previously bound profiles are retained only while their targets remain in the current allowed gateway catalog, bounding retained generated profiles by that catalog. Pruning requires matching ownership; edited or unknown files are preserved and report `agent_profile_conflict`.

Local registry discovery uses `<KIMI_HOME>/plugins/installed.json`. An ID prefix alone is not ownership: the record must have local-path provenance, the expected original source and managed root, and the exact declarative managed manifest. Before enabling roles, another key's role-plugin ID or a foreign prefix-matching registration reports `agent_profile_conflict` with no plugin RPC or registry change, preventing silent coexistence. Symlinks, malformed registry state and changed source content are not claimed or replaced. Existing native profiles and application resources remain outside ownership.

Normal clearing, disconnect and `stop()` verify the saved plugin's ownership, call `kimiPlugin.setPluginEnabled(false)`, obtain explicit session-reload acknowledgement, recheck provenance, then use `kimiPlugin.removePlugin` to remove its installed registration. Busy sessions, transport failures, incomplete reload results and incomplete removal retain pending recovery for the next idle tick or start. A removal reply lost before its effect is retried; after-effect absence requires a fixed native-not-found reply and checked reload before pending work clears. Reconnecting with secondary selected installs the source when its registration is missing, even if the managed cache still contains matching files. Stable `getPluginInfo` probes are at least 30 seconds apart and skipped while busy; a transient or ambiguous failure does not change the last confirmed tool schema. Readiness changes require an idle confirmation of disabled or missing state.

Disk absence is not native acknowledgement. If the registry record is missing but `getPluginInfo` still finds the plugin, recovery verifies nonsymlink source/cache directories and saved file hashes before disabling it. For plugin RPCs only, the public envelope's fixed `code:-32003` together with `data.reasonCode:"KIMI_PLUGIN_NOT_FOUND"` is mapped locally to `kimi_plugin_not_found`; other remote message/data content is discarded. Generic rejection, null, wrong IDs or missing `enabled` keep the obligation and report reload failure. Confirmed absence still needs checked reload, so a removed plugin can finish recovery without treating every rejection as success.

The inspected native `removePlugin` path removes the installed record, reloads plugin contributions and refreshes active sessions. Its core removal chain does not delete the managed cache or the adapter's generated source and binding state. This is registration removal; it is not a claim that every generated file or the Magpie package was uninstalled. Ownership-checked catalog pruning remains separate.

Synchronous exit performs no RPC and does not remove the registration. It changes only the saved, verified companion registration's `enabled` field to `false`, with original-byte comparison and a private mode-0600 exclusive temporary file followed by rename. The saved plugin ID and pending phase retain the runtime/removal obligation even when the helper fails or disk is already false. Missing registries are not created; foreign entries and unknown fields survive. Observed concurrent byte changes abort publication and staging files are cleaned. This is a compare/rename pattern, not a cross-process lock or an uninstall.

Read-only inspection of the Kimi 3.2.25.22 / Daimon 1.0.6 bundle found no installed-registry watcher: the manager caches records and the profile loader listens to explicit plugin reload events. Disk `false` therefore does not immediately remove profiles in Kimi's memory or remove the installed record. If native presence remains, the next idle recovery must call `setPluginEnabled(false)` even if disk already says false, obtain checked `reloadActiveSessions` / targeted retry acknowledgement, then finish registration removal. Fixed native absence plus checked reload can finish an already-removed obligation. A setter reply alone can omit failed reload rows. These static findings and synthetic recovery tests do not establish live native memory refresh, removal or resume after either operation.

The earlier review revisions were unreleased but had been run locally. Existing `state.secondary` and `state.secondaryPool` records therefore carry restore obligations that must finish rather than leave old aliases or owned fields behind. Only that recorded-ownership path is retained. The adapter does not acquire ownership of an untouched native `[secondary_model]` or model pool and does not reload it on connection. Foreign snapshots exist only around the adapter's own primary/menu RPCs; a restoration CAS conflict preserves concurrent bytes, reports fixed `kimi_config_changed` and allows other primary recovery to finish. Later ticks retain that warning instead of reporting connected. Earlier owned TOML restoration still serializes parsed TOML: comments and original numeric representations are not preserved. No model/provider definitions or credential-bearing configuration backup is added.

### Baseline evidence and untested boundaries

Repository validation deviation: an earlier repository-wide attempt accidentally included `packages/gcp-ai/test/browser.test.mjs`, which launched real Chrome with temporary test profiles. That attempt failed and is not acceptance evidence. A subsequent process check found no remaining Chrome process using those test profiles. The final repository command explicitly excludes real-browser and native-application-probe tests; it retains synthetic VM and fake-CDP tests. This deviation is separate from the untested native Kimi UI boundary.

| Boundary | Evidence for this review revision |
| --- | --- |
| Package, repository, registry checks and mutation counts | Package: 384 pass, 0 fail, 2749 assertions. Repository with the documented exclusions: 7185 pass, 6 skip, 0 fail, 226769 assertions. Both registry commands exit 0. 129/129 mutants trigger assertion failures (217 test observations). |
| Registry ownership, atomic disable, registration removal and recovery state | Synthetic temporary-file/controller tests; no real native profile |
| Routing, fail-closed markers and SSE continuity | Synthetic JSON/SSE protocol tests; no real model request |
| English/Chinese settings and opt-in state | Pure VM interaction tests and static fallback assertions; no browser |
| Native plugin registry and reload behavior | Read-only Kimi 3.2.25.22 / Daimon 1.0.6 source inspection |
| macOS native UI, install, reconnect and current child turns | Not tested in this review revision |
| Windows and Linux native behavior | Not tested in this review revision |
| Full native child compaction and fork | Not tested in native Kimi; source/synthetic evidence only |
| Synchronous-exit in-memory residue and subsequent native refresh | Not tested in native Kimi; disk mutation synthetic, no-watcher boundary static |
| Resume after native plugin disable or registration removal | Not tested in native Kimi |
| Paid tools, billing, sleep/wake and natural credential rotation | Not tested in this review revision |

### Baseline final commands and guard results

```text
AGNES_BROWSER_TEST=0 HOME=<temporary HOME> bun test packages/kimi-desktop
bun scripts/check.mjs kimi-desktop
bun scripts/check.mjs
AGNES_BROWSER_TEST=0 HOME=<temporary HOME> bun test \
  --path-ignore-patterns=packages/agent-console/test/** \
  --path-ignore-patterns=packages/agent-console/web/** \
  --path-ignore-patterns=packages/window-warmup/tests/browser.test.ts \
  --path-ignore-patterns=packages/gcp-ai/test/browser.test.mjs \
  --path-ignore-patterns=packages/chat/epub-reader.test.mjs \
  --path-ignore-patterns=packages/nowledge-mem/page-layout.test.mjs \
  --path-ignore-patterns=packages/agent-office/cli.test.mjs \
  --path-ignore-patterns=packages/agent-office/jump.test.mjs
```

The final run used Bun 1.4.4 and a separate temporary checkout with the exact candidate executable/test bytes. The two default agent-console exclusions remain. Four real-browser files and two conditional native-terminal-probe files are also excluded; `AGNES_BROWSER_TEST=0` keeps the opt-in Agnes browser case off. Synthetic VM/fake-CDP tests remain included. The earlier DSH repository attempt failed; the final successful repository run used the Codex executor. No unrelated package source was changed for those environment failures.

| Item | Status | Changes | Representative test | Mutants killed / assertion-red test observations |
| --- | --- | --- | --- | --- |
| B1 | Fixed | `adapter.mjs`, `agent-routing.mjs` | `B1 no secondary: supplier responses pass through unchanged` | 8/8 / 12 |
| B2 | Fixed | `adapter.mjs`, `agent-profiles.mjs`, `agent-routing.mjs`, `role-plugin-state.mjs`, `rpc.mjs` | `B2 an idle stop disables the owned role plugin` | 91/91 / 151 |
| B3 | Fixed | `adapter.mjs` | `B3 a busy runtime performs no getPluginInfo polling` | 7/7 / 13 |
| S1 | Fixed | `agent-routing.mjs` | `S1: an Agent fragment without index does not destroy the stream` | 9/9 / 15 |
| S2 | Fixed | `adapter.mjs` | `S2 a stable-tick external deletion is not repaired by the foreign snapshot` | 12/12 / 22 |
| S3 | Fixed | `settings.html` | `en: primary-only confirmation survives saves and refreshes without confirming a secondary` | 2/2 / 4 |

Mutation test observations are summed per mutation, so a test repeated across mutants is counted repeatedly. Non-assertion errors are excluded. Two equivalent next-text checks were removed instead of counting a compound mutation.

## Historical signed-history role-profile candidate `cc9a023`, 2026-11-07

Everything in this section describes the previous `cc9a023` revision, before the current review fixes. Its native results and test totals do not accept the current implementation.

That signed-history candidate was installed into official Magpie **0.1.3208** and exercised in ordinary signed-in Kimi **3.2.25, build 3.2.25.22 / Daimon 1.0.6**, on macOS with Bun **1.4.4**. All **19 installed files** matched its tarball: 16 runtime/UI files plus documentation and package metadata. The companion loaded ordinary worker profiles and the embedded page confirmed application. That candidate still used inherit-primary behavior when secondary was empty, so those observations do not prove the new opt-out contract.

In the first native Work turn, an ordinary Agent omitted `model` and used the Astra-bound profile; another explicitly selected primary and used the Sol-bound profile. Both executed native Read with the fixture marker in their tool results. Eight requests completed with HTTP 200: six Sol and two Astra, with requested and served targets matching after normalizing the provider prefix. Native Agent arguments contained no shim `model`; authenticated call IDs preserved omitted-default and explicit-primary intentions and the corresponding native result links.

After that page cleared secondary to inherit-primary, resuming the existing Astra Agent with an explicit primary selector retained its prior profile and target and executed Read again, producing two Astra requests. A new ordinary Agent omitted the selector, used the Sol profile and completed Read with two Sol requests. The second turn had seven requests: five Sol and two Astra, all HTTP 200. Across both historical turns there were **15 requests, three new subagents, one resume and four successful Reads**; request totals include parent and continuation calls.

The same historical page saved primary Astra, confirmed application, then restored Sol and confirmed again. Host applied-model state, stash reference and connection agreed; the credential comparison was performed only in memory. With Work idle, the native Magpie Agent card disconnected Kimi: JSON and converted runtime TOML returned to the official service, recovery ownership cleared, and four native model entries and the `k3-agent` selection remained. Reconnecting Sol returned both addresses to the bridge with secondary empty and no pool. These operations sent no additional inference and required no application restart. Native model entries and unrelated settings matched before-run comparisons. The credential aggregate changed during that acceptance interval; its cause was not isolated, so unchanged credential bytes were not claimed. No credential values or full configuration copies were retained.

That source passed **234 package tests, 0 failures and 1,975 assertions across 18 files**. Its repository run passed **6,714 tests with 8 skips, 0 failures and 224,592 assertions across 485 files**, excluding the two default-excluded agent-console directories and the window-warmup browser test. Its registry check exited 0 with a cached GoAnyAPI record when remote resolution was unavailable. Four temporary-source mutations failed assertions: skipping primary restoration RPCs on stop, removing typed Agent-alias history migration, disabling staged JSON/TOML byte comparisons, and removing authenticated selection-history restoration. These are historical counts, not current review results.

The previous pool-based candidate's native runtime events at **2026-11-07 09:58:39Z** showed desktop model definitions falling from **58 to 4** and a converted home pool falling from **2 entries to 0** before queue dispatch. That observation motivated replacing the pool, but does not validate the current review changes. Full native child compaction was not forced; the public `conversations.compact` targets the main agent. Fork had isolated coverage only, and Windows/Linux and paid tools had no new native acceptance in that revision.

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
