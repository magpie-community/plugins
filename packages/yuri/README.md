# Yuri as a Magpie Agent

Adds **Yuri** to Magpie's Agents page. Connecting installs
[`@magpie-community/opencode-magpie-provider`](../magpie-provider)
in Yuri's OpenCode V2 service configuration, rather than generating a second,
static provider catalog or changing Yuri's app bundle.

This is a **Magpie agent package**, not an OpenCode GUI plugin. Install this
package in Magpie; the package it injects runs in OpenCode. Yuri's existing
plugin settings show the latter as `magpie.providers`.

The Agent row and installed-plugin card both embed Yuri's original 32px app
icon for offline display. See [artwork provenance](ASSET_NOTICE.md).

## Install

Install in Magpie, not in OpenCode's plugin list:

```sh
magpie plugin add @magpie-community/agent-yuri
```

Installation alone does not connect Yuri or change OpenCode's plugins. Turn
**Yuri** on in Magpie's **Agents** page, then choose a model in Yuri. Keep Magpie
running while changing the switch; its Bun host applies the change within about
three seconds. OpenCode watches its configuration; no service restart is requested.

Before this contribution is merged, test the local directory:

```sh
magpie plugin add "$(pwd)/packages/yuri"
```

The same integration is also available as the standalone
[yee94/magpie-agent-yuri](https://github.com/yee94/magpie-agent-yuri) Git package.
Install one variant only: both declare the same `yuri` Agent id. This community
package bundles its parser and follows the repository's dist/npm publishing
workflow; it requires no runtime dependency installation or build scripts.

## What is written

- `~/.config/magpie/agents/yuri/connection.json` is the connection sidecar Magpie itself
  stashes and restores. It contains only the gateway API URL and assigned key.
- The companion Bun module merges **one entry** into the global OpenCode
  `plugins` array, pinning `@magpie-community/opencode-magpie-provider@0.1.0`.
  Its source and runtime are reviewed and published in this repository. It needs
  its first community **npm** publication before OpenCode can resolve the pin;
  Magpie's dist fallback alone is not enough for OpenCode. A new entry passes
  `options.remote.baseURL` and `options.remote.token` from that connection,
  so it does not guess a port or copy any upstream subscription credentials.
  It also sets `options.agentID: "yuri"` for model discovery, inference and image
  request attribution. Existing original/community provider entries are retained
  unchanged, so a user-owned original plugin may still attribute calls to OpenCode.
- OpenCode's directory is `OPENCODE_CONFIG_DIR`, otherwise
  `$XDG_CONFIG_HOME/opencode`, otherwise `~/.config/opencode`. The bridge checks
  both `opencode.json` and `opencode.jsonc`, plus `OPENCODE_CONFIG` when set.
  It writes the explicit `OPENCODE_CONFIG` if set, otherwise the highest existing
  global file, otherwise a new `opencode.jsonc`.
- Existing npm string/object entries, including pinned versions and options,
  and readable local package references are **left untouched**. They are never
  taken over, downgraded or duplicated. Their own gateway configuration wins.
- JSONC comments, trailing commas, BOM, unrelated settings and plugins are kept.
  The bundled `jsonc-parser` handles token-level edits rather than rewriting
  the user's config as JSON; its version and license are in `THIRD_PARTY.md`.
- `~/.config/magpie/agents/yuri/state.json` records ownership. A private
  `.pending` journal makes interrupted edits recoverable without overwriting
  a concurrent edit. These files can contain configuration credentials;
  they are mode 0600 and must not be shared.

The OpenCode environment variables above must be set on the **Magpie host** as
well as the OpenCode service if it uses non-default paths. Bridge-owned files
belong to Magpie and stay under `~/.config/magpie/agents/yuri/`; nothing is
written into Yuri's own data directory. The Agent's `dir: ~/.config/yuri` is
only an installation-detection hint.

The Agent descriptor API does not expose Magpie's resolved data directory.
This adapter therefore uses its default `~/.config/magpie` location, not an
automatically relocated XDG or portable data directory. A custom `YURI_DATA_DIR`
or Windows installation is not automatically detected either.

## Disconnect and ownership

Turn Yuri off on Magpie's Agents page. Only an unchanged entry this adapter
inserted is removed. If the whole config is unchanged since insertion, its
original bytes are restored (or the newly created file is removed). Otherwise
only the adapter's item is removed, keeping subsequent user edits.

An entry you upgrade, edit or remove yourself becomes user-managed: the bridge
does not keep reinstalling it, and Disconnect leaves it alone. An entry that
predated this adapter is also kept, so turning the Yuri switch off **does not
disable an independently installed Magpie plugin**.

Disable/remove the Magpie package through Magpie's plugin management so it can
unwire the sidecar first. Do not delete recovery files while connected. For a
forced process termination during an edit, leave them in place and run Magpie
with this package again to recover. Invalid JSONC, duplicate top-level keys,
missing local plugin paths, symlinked config files and conflicting recovery
edits stop the bridge without rewriting the configuration. Errors logged by
the timer intentionally omit source text and credentials.

## Scope and limits

Yuri is an OpenCode client. When Yuri and the OpenCode CLI share a service,
this global plugin change affects **both**, not an isolated Yuri instance.
For a remote/SSH service, install/configure the provider plugin on that service's
machine; this local adapter cannot install extensions on a remote host.

Models, native protocols, pricing and the 30-second catalog refresh belong to
the community provider. This adapter neither sets the default model nor
enforces Magpie's per-agent model checkboxes. Choose models in Yuri; the
directory exposed by the provider plugin remains authoritative. It does not
add a Yuri-specific request hook, GUI extension or Library/MCP integration.

Do not use Magpie's built-in OpenCode adapter to maintain another static
`magpie` provider alongside this dynamic integration unless you intend to have
both catalogs.

The shared provider's `agentID` is not UI detection: a CLI calling through the
same provider also reports `yuri`. The built-in OpenCode Agent remains a separate
static catalog; its own calls report OpenCode. Connecting/disconnecting it must
leave Yuri's `plugins` entry intact. Yuri disconnect must preserve that adapter's
`provider.magpie` and model settings if they were edited after Yuri connected.

## Tests

```sh
node --test packages/yuri/yuri.test.mjs
node packages/yuri/mutation.mjs
bun scripts/check.mjs yuri
```

The tests use temporary homes and fake gateway keys. They do not install
anything into a running Yuri or contact a model provider.

PR revision tests also cover cross-process lock exclusion, crashed-lock recovery,
edits between read and commit, duplicate managed entries on disconnect, invalid
URLs/keys and exit-time restoration. See `VERIFICATION.md` for manual runs.
