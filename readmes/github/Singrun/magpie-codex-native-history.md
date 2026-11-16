# Magpie Codex Native History

[简体中文](README.zh-CN.md)

This plugin fixes **an existing Codex chat failing with an encrypted-history error after switching back to a native model through [Magpie](https://github.com/yetone/magpie)**. It normalizes incompatible history sent to the native service while preserving readable messages, images, and tool records, so that conversation can continue.

## The problem it solves

A typical workflow is:

1. You use a third-party model through Magpie in a Codex chat, accumulating messages, file analysis, and tool calls.
2. You keep the same chat and select a native Codex model to continue the work.
3. The next request fails with an encrypted-content verification error. Switching back to a third-party model may let the same chat continue.

The error can look like this:

```text
invalid_encrypted_content
The encrypted content for item rs_… could not be verified.
Reason: Encrypted content could not be decrypted or parsed.
```

Replayed history contains more than the readable messages shown in the chat. It can also contain encrypted reasoning state returned by an earlier model. After an upstream switch, the native service may be unable to verify some of that old encrypted state and reject the entire request.

**The goal is to keep working in the original chat with the context you have already built.** Before a native request is sent, this hook removes incompatible old reasoning items and normalizes related search history and server item IDs. Readable messages, images, tool arguments/results, and tool-call pairing are retained.

Requests must still pass through Magpie and carry readable history. Context available only as encrypted compaction or server-side references cannot be recovered by this hook; see “Boundaries and diagnostics” below.

## Why a request hook

Magpie's native ChatGPT sign-in passthrough runs `gatewayHooks` while skipping the synchronous `magpie.middleware` chain. Filtering inside that middleware therefore does not cover this native route.

This package declares **`magpie.hooks`**, the entry called by the native route. Magpie also sends each incoming WebSocket turn through its HTTP handler after rebuilding any conversation continuation. The hook consequently sees the reconstructed history on that route.

See Magpie's [request-hook contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md) and [plugin author guide (Chinese)](https://usemagpie.ai/docs/zh/plugins).

## Install

Use a Magpie version that supports `magpie.hooks`. The original implementation was verified against **0.1.4226**; package loading is also checked against **0.1.4280**. These are tested versions, not a claim about the earliest compatible version.

```sh
magpie plugin add github:Singrun/magpie-codex-native-history
```

Optional: explicitly allow two seconds for the hook:

```sh
magpie plugin options github:Singrun/magpie-codex-native-history '{"gatewayTimeoutMs":2000}'
```

The options example in `package.json` is an editor starting point; explicitly saved plugin options determine the configured timeout.

Confirm that Plugins shows an **async gateway hook / `onRequest`**. A synchronous middleware entry alone does not validate this installation.

If a previous local copy of this hook is installed, disable that entry before enabling this package. Keep one native-history hook enabled.

The package has no build step, dependencies, provider credentials, extra proxy port, or client configuration rewrite. Magpie supplies the Bun runtime.

## Behavior

The hook applies to:

- `/backend-api/codex/responses` with an unprefixed model or a `codex/` model.
- `/v1/responses` with those models when Magpie identifies the client as `codex`.

Requests for other provider-prefixed models pass through. The shared `/v1/responses` endpoint also passes through requests from other or unidentified clients.

On an applicable request, the hook:

1. Removes old `reasoning` items.
2. Converts historical `web_search_call` items into clearly labeled assistant text containing only the data present in the original item.
3. Removes optional server `id` fields from portable history items.

Visible messages, assistant `phase` values, images, tool arguments/results, `call_id` pairing, nested application identifiers, and tool declarations remain available. Model, tool choice, streaming configuration, and the request for new encrypted reasoning are preserved. The hook does not rewrite conversation files or responses.

Previous internal reasoning is removed even when it is otherwise readable, so filtered turns do not replay that persisted reasoning. This trades hidden reasoning continuity for readable conversation portability.

## Boundaries and diagnostics

The hook cannot recover context available only through encrypted compaction, sealed message content, `item_reference`, `previous_response_id`, or a server-side `conversation` reference. It leaves such a request intact and reports `native-history-opaque-context`; the upstream can still reject it. It never silently discards these contexts.

For normal Magpie WebSocket continuations, the gateway reconstructs full input and removes `previous_response_id` before invoking the request hook. A raw HTTP request containing a server-only reference is a different case.

Dedicated `/responses/compact` calls and Magpie's internal requests are outside this hook's scope. Magpie's request-hook contract also rolls back a hook on failure or timeout, which can allow the original request to reach the upstream.

Diagnostics are fixed codes and a byte count:

- `native-history-filtered`
- `native-history-opaque-context`

The plugin does not log, read from disk, store, or export request content, account identifiers, or credentials. It processes only the body and context Magpie supplies.

## Test and develop

Node.js 22 or newer is used for development tests. All checked-in fixtures are synthetic and require no model API or account.

```sh
git clone https://github.com/Singrun/magpie-codex-native-history.git
cd magpie-codex-native-history
npm run check
npm run pack:check
```

To load the checkout in Magpie:

```sh
magpie plugin add .
```

Source-only changes need a plugin configuration reload; an on/off cycle reloads the host. Disable another copy of the hook before testing the checkout.

The original live regression used a complete history of 149 items and approximately 17.98 MB of input, including images and tool records. Disabling the hook reproduced the same encrypted-content error; enabling it passed HTTP and WebSocket checks. A single WebSocket completed third-party → native → third-party → native switching while retaining a synthetic context marker.

Those live results describe the tested environment, rather than every gateway, account, model, or history format. Real conversation logs, account data, authentication readers, local backups, and the original live replay scripts are excluded from this repository.

## Remove

```sh
magpie plugin off github:Singrun/magpie-codex-native-history
# Or uninstall:
magpie plugin rm github:Singrun/magpie-codex-native-history
```

## License and attribution

[MIT](LICENSE). Earlier history-filtering work is credited in [NOTICE](NOTICE). This is an independent community plugin.
