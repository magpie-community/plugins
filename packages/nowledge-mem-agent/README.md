# Nowledge Mem / AI Now Agent

Select a model in **Magpie → Agents → Nowledge Mem / AI Now** for Nowledge's **Default, AI Now and Background** assignments. Magpie owns upstream accounts and routing; Nowledge connects to one dedicated native Magpie provider instance.

[中文说明](README.zh-CN.md)

This differs from [`@magpie-community/gateway-nowledge-mem`](../nowledge-mem): that package recalls memories/Context Bundles for other harnesses and optionally imports conversations. This Agent controls the models **Nowledge itself uses**, performs no recall/capture, and needs no gateway memory plugin. Its directory is `nowledge-mem-agent` because `packages/nowledge-mem` already contains that separate package.

## Connect

```sh
magpie plugin add @magpie-community/agent-nowledge-mem
magpie nowledge-mem <provider/model>
```

Or add this complete folder through Plugins → Add plugin. Install the whole package: `nowledge-mem.agent.js` runs in moejs and `main: index.mjs` runs the bridge in Magpie's Bun host. No runtime dependencies or installation scripts.

Keep both applications running. Local changes settle within two polls, normally 2–4 seconds. Start a new AI Now conversation; existing conversations or AI Identities with explicit overrides can keep their own models. Choose a tool-capable chat model.

The provider instance is `magpie:nowledge-agent`, displayed as **Magpie · Nowledge Agent**. Existing providers and credentials are preserved. The gateway URL and Agent key come from `connect`; full `provider/model` or `group/name` identifiers are sent unchanged, without a LiteLLM prefix.

Default, AI Now and Background share the selected model. Connection enables Remote mode; disconnection restores the original mode when still owned. Explicit embedding, OCR/vision and decision assignments are untouched; inherited vision follows Default.

The icon is Nowledge's official [favicon](https://mem.nowledge.co/favicon.png), used for identification. This is a third-party adapter.

## Backend and credentials

Default backend: `http://127.0.0.1:14242`. Save custom connection settings in `~/.config/magpie-nowledge-mem/adapter.json`:

```json
{
  "apiUrl": "https://your-mem.example.com",
  "apiKeyFile": "~/.config/magpie-nowledge-mem/nowledge.key",
  "pollMs": 2000
}
```

The key file contains the **Nowledge backend access key**, separate from Magpie's gateway key; restrict it to your user. `NMEM_API_URL` and `NMEM_API_KEY` also work. Explicit connection fields override environment values; Magpie plugin options override the file. GUI applications may not inherit shell environment variables. The standalone CLI does not read Magpie's saved plugin options, so use the shared adapter file for recovery.

Authenticated non-loopback backends require HTTPS. Redirects are rejected, and diagnostics omit server response bodies. Use the actual backend address shown by Nowledge. Across machines, Magpie's gateway address must be reachable from the Nowledge server; loopback always refers to that server's own machine. Hosted Nowledge Cloud workspaces manage their models and are outside scope.

Local configuration is checked every two seconds. For remote backends, unchanged successful checks back off to at most one every 30 seconds. The local selection file is still polled at the configured interval, so a new selection promptly restarts the quiet-period check.

## Disconnect, uninstall and recover

Disconnect the **Agent row** before disabling/removing the plugin or quitting Magpie. Keep the plugin and Nowledge running until restoration finishes:

```sh
magpie nowledge-mem default
```

If the package or host is removed first, asynchronous restoration is not guaranteed. When the selection file disappears while the host is alive, the loop treats it as a disconnect. If already removed, obtain a checkout/extracted copy of this package and run:

```sh
node cli.mjs status
node cli.mjs restore
node cli.mjs sync
```

Bun can run these commands too. `restore` restores still-owned settings and pauses the current selection; another model selection or explicit `sync` resumes management. Use the original backend URL and authentication.

**Keep `~/.config/magpie-nowledge-mem/state.json` until recovery completes.** It records original assignments and intended/applied writes, not existing provider secrets. Writes are atomic and `0600`, with a pid lock; the adapter directory and selection file permissions are tightened.

Manual purpose edits are retained and reported as conflicts. Changed providers and providers referenced by a manually selected purpose are retained. If the original default was empty, Nowledge can clear it only by removing this provider; new references can prevent that. An actionable error retains the journal until the conflict is resolved. Do not delete it to hide an incomplete restore.

The API exposes only `has_api_key`, so replacement of an existing instance's key is not detectable. Disconnect before editing that credential. There is no conditional-write API; a small external read/write race remains possible.

## Compatibility and the REST contract

Last actual create/remove contract check: **Nowledge Mem 0.10.115**, official desktop Rust service, **2026-11-07**. A temporary instance was removed, Remote mode was preserved, and original assignments were restored. The installed `nmem` CLI also reports `0.10.115`.

`magpie` is a native type shipped by that Nowledge version. This package does not register it. Its bundled Providers UI contains `providerType: magpie`; its bundled client declares:

| Endpoint | Purpose |
| --- | --- |
| `GET /remote-llm/config` | Masked providers and explicit/effective purposes |
| `POST /remote-llm/config` | Save the independent instance with `provider_type: magpie` |
| `POST /remote-llm/purpose` | Assign `default`, `ai_now`, `background` |
| `POST /remote-llm/enabled` | Change Remote mode |
| `POST /remote-llm/provider/remove` | Remove an unchanged, unreferenced owned instance |

The evidence is the official installed assets `remote-routes-DB7HdQZR.js`, `client-yS6RTdNt.js`, `settings-view-D0HsZ7_I.js`, plus live API tests. These routes are **absent from the served OpenAPI document**. The public [embedding provider guide](https://mem.nowledge.co/docs/embedding-providers) also lists Magpie; the general [provider](https://mem.nowledge.co/docs/llm-providers) and [CLI](https://mem.nowledge.co/docs/cli) guides do not describe this full private routing contract.

A missing route, incompatible config schema, or failure to retain the native `magpie` type stops the adapter visibly before purpose assignments, preserving recovery data. It does not silently substitute another provider type. Later Nowledge versions remain unverified.

Actual host smoke: **Magpie 0.1.3212 on macOS**. Desktop-only install detection on the tested Mac uses `~/Library/Application Support/co.nowledge.mem.desktop`, the installed bundle's data directory; `nmem` on PATH is another signal. Other OS-specific desktop paths are not asserted. Linux/server installs can expose `nmem` on PATH; Windows desktop-only detection remains unverified.

## Development

```sh
bun test ./*.test.mjs
MAGPIE_BIN=/path/to/magpie node tests/magpie-smoke.mjs
node tests/nowledge-contract.mjs --read-only
```

Tests use `bun:test` next to source. The optional smoke test gives **child processes their own HOME/USERPROFILE, XDG config/cache/data and AppData directories**, disables account discovery, clears known agent path overrides, and refuses the caller's real home or escaped directories. It uses fake Nowledge/vendor endpoints, sends no paid inference, and leaves the caller's environment unchanged.

The contract script's default mode temporarily creates/removes a provider and refuses an enabled backend or configured providers. Read-only mode checks version, schema and an existing native Magpie instance with no writes. Do not use mutating mode on a live configured workspace.

The repository-root command `bun scripts/check.mjs nowledge-mem-agent` checks registry syntax/classification; its upstream checker skips Agent hook loading. Package tests and the optional host smoke cover behavior. See [VALIDATION.md](VALIDATION.md) for limits and mutation checks.

References: [Magpie plugins](https://usemagpie.ai/docs/zh/plugins), [gateway integration](https://usemagpie.ai/docs/integrate), [community publishing](https://github.com/magpie-community/plugins#publishing).

MIT license.
