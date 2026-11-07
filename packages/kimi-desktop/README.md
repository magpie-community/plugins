# Kimi desktop Work agent

Use the ordinary **Kimi desktop application's local Work agent** with a model selected in Magpie. This is not Kimi Code CLI, a Kimi subscription provider, or a way to spend Kimi Work subscription credits in other agents.

```sh
magpie plugin add @magpie-community/agent-kimi-desktop
```

Open and sign in to Kimi desktop. On Magpie's Agents page select **Kimi**, pick a model, and connect. The adapter waits for the local Work runtime to be ready and idle, then applies the connection without restarting either application. Use Kimi's **Work** page. Chat and cloud Claw are outside its scope. Kimi's native model menu keeps its entries and labels; Magpie's primary selection controls ordinary parent requests. This package does not modify Kimi's application resources or install a custom model-menu patch.

Disconnect Kimi in Magpie to restore its original model service address. Existing conversations, login credentials, unrelated settings, and native model entries are preserved.

## Primary and secondary models

Open the plugin's embedded **Kimi Work models / Kimi Work 模型** page to choose both the **primary model** and a **secondary model**, or leave the secondary set to inherit the primary. The page uses this Kimi agent's available model catalog and shows saved preferences separately from their application status. Apply changes while Kimi is idle. Magpie's **Agents → Kimi** picker remains available and uses the same primary selection. This setup works with the standard Magpie host.

The bridge adds an optional `model` selector to the `Agent` tool declaration sent to the model:

- `primary`: create an ordinary Work worker profile bound to the configured primary model.
- `secondary`: create an ordinary Work worker profile bound to the configured secondary model. This is the default when `model` is omitted; an empty secondary preference inherits the primary.
- `native`: keep the requested native `subagent_type` and its specialized behavior.

For example:

```text
请新建一个子代理处理资料整理，使用已配置的副模型，由主代理综合结果。
```

```text
请让这个新建子代理使用已配置的主模型。
```

The actual tool argument selects the role; a prompt alone does not bind an arbitrary model ID. For new `primary` or `secondary` tasks, the bridge removes only its `model` argument and replaces `subagent_type` with the selected ordinary worker profile. It preserves the prompt, paths and other arguments. `native` removes only the selector and preserves the original type. Resumed or forked agents keep their existing profile and model binding for every selection, including after the configured preferences change.

Authenticated opaque call IDs retain the original selector for history auditing: the bridge restores explicit role choices only in its own verified assistant `Agent` history and leaves an omitted default omitted. The ID preserves native tool-result linkage and never selects the route; the role profile remains the model binding.

These ordinary workers declare general native tools (`tools: ["*"]`), disable `Agent` and `AgentSwarm`, and declare no subagents. They inherit the parent's native permission mode, and user-registered tools remain gated by their availability to the parent. Kimi's native permission guards still apply. These are new general Work worker profiles, without the specialized tool restrictions of `coder`, `explore` or `plan`; use `model="native"` to keep the requested native profile.

The model binding is an authenticated local HMAC section in the role's system prompt. The bridge verifies and removes that section before forwarding the request. The secret stays in `adapter-state.json` and is never sent to the model. User messages and history labels cannot choose a binding. The role prompt, rather than the initial task prompt, retains the target when native compaction discards task history. Every inference still checks the target against Magpie's current allowed models; disabling or removing it returns `model_not_enabled_for_kimi` instead of falling back to the primary.

The secondary preference is the optional `secondaryModel` field in `~/.config/magpie-kimi/connection.json`. The primary model and gateway fields remain owned by Magpie's normal agent connection. Saving a changed primary runs the current host's official `magpie kimi-desktop model magpie/<provider/model>` command, preserving the host's selected model and disconnect bookkeeping. The command inherits the host environment; a plugin-private flag prevents that command's extra plugin host from starting another Kimi adapter. Automatic discovery checks the parent executable (`ps` on macOS, `/proc` on Linux, PowerShell CIM on Windows), then PATH. Discovered paths and their resolved targets must have the case-insensitive basename `magpie` (`magpie.exe` is also accepted on Windows); a shell or `magpie-bun` is not used. If discovery fails, including on Windows, set plugin option `magpiePath` to the current Magpie executable. An explicitly configured path permits a custom executable name. Connect Kimi in Magpie before using the model page.

When both selections change, the primary is saved first, then the secondary preference is merged into the fresh connection. A secondary save failure after a successful primary change is reported as a partial save; refresh the page to check the applied state and retry. The settings service listens on `127.0.0.1:3491`; plugin option `settingsPort` can change that port. It uses a separate page-session credential and never sends the gateway or Kimi credential to the page.

The package generates a small native companion plugin containing only `kimi.plugin.json` and agent Markdown files under `~/.config/magpie-kimi/native-model-roles`. Its neutral ID is `local-work-model-roles-<hash>`; profile names are stable hashes of the target model IDs. Kimi's existing local `installPlugin` / `updatePlugin` API receives `{source}`, copies the plugin to `<KIMI_HOME>/plugins/managed/<id>` and registers it. The adapter checks `getPluginInfo`, enables it through `setPluginEnabled` when needed, and confirms the cached, idle-session reload acknowledgement. Kimi's plugin agent loader refreshes the profiles during that reload. The manifest uses version `1.0.0`; a local update still copies changed files at the same version. No app restart is required by this path.

Old generated profiles remain available for already-created tasks. A same-name source or installed file edited by the user reports `agent_profile_conflict` and is not overwritten. The adapter leaves native profiles, application resources, Magpie core and SQLite untouched. Disconnect restores the gateway and any old owned TOML/menu state, while retaining the declarative companion profiles for resume; they can be managed in Kimi's native plugin UI.

The adapter no longer adds native model definitions or `secondary_model` pools, and does not rewrite them in the background. Queue dispatch in Kimi 3.2.25 was observed rebuilding those definitions and dropping an added pool. Earlier `state.secondary` and `state.secondaryPool` snapshots are retained only for migration and restoration of their narrow owned fields. These writes use the original baseline and preserve independent edits; they do not save model/provider definitions or credentials. Legacy alias recognition and scoped historical Agent metadata cleanup remain for migration. User text, filenames, unrelated tool arguments and results remain unchanged.

Secondary profiles require a recognized native V2 kernel family; support is not pinned to a Kimi application version. A legacy or unknown family keeps the primary bridge available but reports `secondary_model_unsupported_runtime` for an explicit secondary preference. The current role-profile implementation has isolated protocol/profile coverage; its Kimi 3.2.25 native UI acceptance is still pending. Earlier pool-based and older-runtime results in the [compatibility record](COMPATIBILITY.md) are historical evidence, not acceptance of this implementation.

## Library: instructions, MCP and skills

Version 0.1.1 registers ordinary **Kimi** as a target on all three Library pages. This is separate from **Kimi Code**. Existing assignments stay unchanged; select Kimi on the resources you want to share.

- Shared instructions are written by Magpie to `~/.config/magpie-kimi/AGENTS.md`. While connected, the adapter reads this file before each inference and inserts one separate system message, preserving Kimi's original prompts, tool calls and history. Changes also apply to existing Work conversations on their next request. Removing the assignment removes Magpie's managed block; other text in that file remains the user's own instructions. An unreadable/invalid file fails with `instructions_unavailable` rather than silently omitting active rules. These instructions do not apply when disconnected, to Chat, or to cloud Claw.
- MCP points through `~/.config/magpie-kimi/library-native/mcp.json` to ordinary Kimi's `daimon-share/daimon/runtime/kimi-code/home/mcp.json`. The format is Kimi's `mcpServers` object. Existing server entries are retained by Magpie's normal Library merge; new conversations load changed MCP settings. Existing conversations can use Kimi's own reconnect controls.
- Skills point through `~/.config/magpie-kimi/library-skills` to ordinary Kimi's `daimon-share/daimon/skills`. This exposes existing native skills as well as Library assignments. Bundled/user skills are not deleted or replaced by the adapter. Conflicts use Magpie's normal keep-own/use-library choice. Start a new Work conversation to load changed skills.

The two directory links are Windows junctions or macOS directory symlinks; no administrator authorization or app modification is needed. An existing different object at either link path is left intact and reports `library_path_conflict`. Resource files remain in Kimi when the model bridge disconnects. The adapter does not enable all resources or change another agent's assignments.

The Work provider carries an agent's messages unchanged; a provider is not a separate instruction target. Give shared instructions to the agent making the request. Using Kimi Work in Codex therefore uses Codex's instructions, while ordinary Kimi uses the Kimi assignment above.

## How it works

The import-free `kimi-desktop.agent.js` registers the agent using Magpie's agent interface. The Bun entry `index.mjs` is also necessary: Kimi's actual configuration belongs to its running local runtime, so changing a file alone does not reliably apply a model. It runs a loopback adapter and uses Kimi's authenticated local control API to reload the selected model.

Inference goes to Magpie using Magpie's agent credential. Kimi's web search/fetch tools continue through Kimi's original `agent-gw.kimi.com` service with Kimi's own credential. Kimi login credentials are never forwarded to Magpie or a third-party model provider. Requests to unknown paths and requests without Kimi authentication are rejected; no system proxy, certificate or firewall settings are changed.

Rate-limit and temporary-service responses retain the upstream status, body and `Retry-After` header, including both delay-seconds and HTTP-date values. Other upstream headers are not copied wholesale.

The adapter does not reload a busy Work runtime. If Kimi independently changes its service configuration while connected, adaptation pauses instead of repeatedly overwriting it; disconnect and reconnect in Magpie to retry.

## Local files and compatibility

- `~/.config/magpie-kimi/connection.json`: Magpie's selected model and connection.
- `~/.config/magpie-kimi/status.json`: fixed status categories, without credentials.
- `~/.config/magpie-kimi/adapter-state.json`: original service address, recovery ownership, local role-signing secret and companion-plugin state; no Kimi login credentials.
- `~/.config/magpie-kimi/native-model-roles`: generated companion-plugin source; Kimi owns its installed managed copy.
- `~/.config/magpie-kimi/before-menu-models.json`: an earlier adapter's original model-list/current-choice snapshot, retained until acknowledged menu/runtime restoration. No full configuration or credential backup is written.
- Kimi configuration: `daimon/config.json` in Kimi's `daimon-share` folder: where `kimi-desktop/daimon-storage.json` points (`shareDir`; Kimi 3.2.21 on Windows writes it when installed on another drive, e.g. `D:\KimiData\daimon-share`, and on any system when its storage is moved), else `kimi-desktop/daimon-share`, under the platform's application-support directory (`%APPDATA%`, `~/Library/Application Support`, `~/.config`).

Earlier primary-bridge revisions were verified with Windows 11, Kimi 3.2.17.10 and official Magpie 0.1.1275, including an actual Work request through Magpie. The historical [macOS record](COMPATIBILITY.md) covers real control methods, connect/disconnect restoration and a real streamed bridge request on macOS 26.6.2 arm64, Kimi 3.2.17 build 3.2.17.4 and official Magpie 0.1.1276. That request was initiated by an HTTP test client. A later macOS desktop UI-submitted Work turn was verified on 2026-11-06 with a non-Kimi model selected in Magpie; see the [macOS desktop UI turn record](COMPATIBILITY.md#macos-desktop-ui-turn-2026-11-06). These older results do not validate the current role-profile candidate. The required runtime has provider `daimon-kimi-code` with original service `https://agent-gw.kimi.com/coding/v1`; other layouts stop with `unsupported_kimi_config`.

The private control API is undocumented. Before connecting, the adapter probes `models.current`; a refused/missing method stops connection without changing the service address. A failed `conversations.setModel` rolls back that address. Failures of `conversations.getKimiModelList` or `conversations.updateKimiModelList` report `catalog_sync_failed` and preserve the existing catalog rather than inventing a different protocol. In that case the selected-model bridge may remain connected; disconnect it to return to Kimi's service. No vendor app files are patched, and no automatic upgrade to an unknown protocol is attempted.

No Kimi binaries, personal configuration, prompts, account identifiers or credentials are included. There are no runtime dependencies. Tests use isolated temporary directories and synthetic credentials.

```sh
bun test packages/kimi-desktop
```

The model catalog is fetched from Magpie's `/v1/models` with this agent's credential and registered User-Agent. Magpie owns its visibility, picked/hidden models, disables and ordering. The adapter never opens Magpie's `providers.json` or `settings.json`. It rechecks the gateway catalog before every inference; removed selections are refused even during a running turn, and an unavailable catalog returns a fixed error instead of falling back to an unrestricted list. This package includes no Electron injection hook or model-menu patch. The icon is Kimi's desktop application icon.

The adapter does not rewrite inference thinking fields. The historical [3.2.18 compatibility check](COMPATIBILITY.md#kimi-3218-isolated-compatibility-check) covers the earlier runtime/menu registration path's `always_thinking` handling, real model requests, background-control turns and signed-in UI submissions in a separate official desktop profile. It does not establish thinking behavior or native acceptance for the current role-profile implementation.

## Shutdown and manual recovery

The shared plugin host owns process shutdown. This plugin installs no SIGTERM/SIGINT handler and never calls `process.exit`. On the host's normal exit event it synchronously restores the original address if the current address is still its own; restart Kimi to reload its runtime. An explicit disconnect while both apps are running additionally restores model selection/list through the control API.

The adapter's explicit `stop()` closes its settings service, restores any owned native primary/menu state through the normal control API, and restores earlier owned secondary fields without starting another secondary-session reload. Cached Kimi sessions read those restored secondary values when their runtime reloads. Companion profiles remain installed for resume. Changing `settingsPort` recreates the page service when plugin options are loaded again.

If a primary/menu control call fails or loses its reply, recovery ownership and the model backup remain until the menu and final runtime reload are acknowledged. A subsequent start can finish restoration even when the address is already official and the connection is disabled. A failed secondary write retains its previous owned binding so retries, stopping and crash recovery do not mistake it for another writer's configuration.

Owner records are fully written to a temporary file and published with an exclusive hard link, so interruption during the write cannot publish an empty/partial `adapter-owner.json`. An existing live owner is left alone. A malformed legacy owner record reports `adapter_lock_invalid` in `status.json` and the plugin log; a file access/publication failure reports `adapter_lock_unavailable`. The plugin does not guess who owns a malformed record or automatically remove it. To recover from `adapter_lock_invalid`, close all Magpie instances first, remove only `~/.config/magpie-kimi/adapter-owner.json`, then reopen Magpie. Leave `connection.json`, the other state files and Kimi's credentials intact.

A forced kill, power loss or a broken private API can leave Kimi pointing at an inactive loopback bridge. To recover without starting Magpie:

1. Close Kimi normally. In `~/.config/magpie-kimi/connection.json`, set `enabled` to `false` so the adapter does not reconnect when Magpie next starts.
2. Open Kimi's `config.json` at the application-support path above. Only if `model.providers["daimon-kimi-code"].baseUrl` equals `bridgeURL` in `adapter-state.json`, change that one field to the same state's `originalBase` (normally `https://agent-gw.kimi.com/coding/v1`). Leave `credentials` and all unrelated fields untouched; do not replace the whole document from an old backup.
3. If an earlier adapter left `model.current` starting with `magpie-local-` or `local-model-`, set it to `current` from `before-menu-models.json` if that alias still exists in `model.models`; otherwise choose an existing native `daimon-kimi-code` alias, such as `k3-agent` or `k2d8-preview`. Remove only those adapter alias keys from `model.models` if present. Reopen Kimi; it refreshes its native model catalog. Leave companion profiles installed if existing tasks still need them for resume.

Older experimental packages created full `backups/before-connect-*.json` copies, which can contain Kimi credentials. This package creates no such files and does not silently delete existing user backups. After recovery, users can remove those older copies locally. Do not upload them in an issue or PR.
