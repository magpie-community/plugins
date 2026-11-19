# Magpie Paseo Bridge

[简体中文](README.zh-CN.md)

This Magpie request hook publishes the route that produced a Codex final reply. The Paseo Magpie plugin reads the local index to display the winning provider, served model, and fallback attempts next to that reply.

## Installation

Use Magpie and the Paseo daemon under the same OS user, with the same absolute `XDG_CONFIG_HOME` or the same home directory. Codex must already send Responses requests through that Magpie gateway. The hook uses Magpie's Bun plugin host and requires no npm dependencies.

Run these commands on the Magpie host:

```sh
magpie plugin add @magpie-community/gateway-paseo-bridge
magpie plugin list
```

The [standalone repository](https://github.com/kogekiplay/magpie-paseo-bridge#installation) gives a pinned GitHub installation command.

For development from a local checkout:

```sh
magpie plugin add "$PWD/paseo-bridge.hooks.mjs"
magpie plugin list
```

Once the hook is listed, send a new Codex turn through Magpie with the Paseo Magpie reader enabled. The hook only indexes new completions. Use the name shown by `magpie plugin list` with `magpie plugin off` to disable it or `magpie plugin rm` to remove it. Existing index files remain subject to the reader's expiry check.

The integration suite verified Magpie `0.1.4504`, Bun `1.4.4`, and Codex CLI `0.170.0` on macOS. The writer requires POSIX permissions and hard links. Linux has yet to be tested end to end. Native Windows is currently unsupported.

## Matching and data

The hook accepts successful local Codex Responses completions for the main conversation. It finds one final assistant output item, then performs a bounded, credential-free `GET /v1/magpie/trace` at the loopback `MAGPIE_ADDR` supplied by Magpie. It joins the exact session and response IDs to one successful trace row. The output item's ID is the key Paseo can observe on its timeline. Tool use can cause several Responses requests within a single turn, so tool continuations and commentary produce no index entries.

The index lives in `magpie/paseo-bridge/v1/` under an absolute `XDG_CONFIG_HOME` or under `~/.config`. Each file name is the lowercase SHA-256 of the UTF-8 session ID, a NUL byte, and the UTF-8 assistant output item ID, followed by `.json`. A record looks like this:

```json
{
  "version": 1,
  "provider": "fixture-native",
  "model": "fixture-wire-v2",
  "attempts": [
    { "route": "fixture-fail/fixture-model", "status": 429, "failed": true },
    { "route": "fixture-native/fixture-model", "status": 200, "failed": false }
  ]
}
```

The provider is the Magpie provider ID of the winning attempt. The model uses the trace's served model when available and the winning attempt's model otherwise. Each attempt identifies the Magpie provider and model that were tried. It includes an HTTP status when available. The projection excludes raw IDs, bodies, credentials, account labels, and error strings.

The POSIX writer creates user-owned `0700` index directories and publishes `0600` files atomically. Identical writes keep the original modification time. Conflicting projections suppress the key until it expires. The reader uses the file modification time for a seven-day expiry. On a subsequent eligible write, the hook cleans up to 32 expired entries and stops admitting new keys when the index reaches 4,096 entries.

## Missing labels

- Verify the hook appears in `magpie plugin list` and that the Paseo daemon reads the same config directory. Parent directories for the index must be owned by the current user and protected from other users' writes. Symlinks at the config directory, Magpie directory, or index directories prevent writes.
- Check that Codex is routed through the local gateway and that the gateway serves its trace over plain HTTP on loopback. The completion hook runs asynchronously. A restart, timeout, oversized capture, or trace eviction can leave a reply without a label.
- Check the route type. The native ChatGPT sign-in passthrough can omit `responseId` from its trace row in Magpie `0.1.4504`. The bridge skips any route without an exact match. Routed Responses passthrough and Chat Completions translation were verified.

## Verification

Run with Node.js 24 or newer from this package's directory:

```sh
node --test test/bridge.test.mjs
```

The [standalone integration suite](https://github.com/kogekiplay/magpie-paseo-bridge/tree/v0.1.0#verification) installs the hook into a temporary Magpie configuration and exercises real Codex turns through a loopback fixture.
