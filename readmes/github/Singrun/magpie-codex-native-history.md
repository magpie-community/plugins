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

Requests must still pass through Magpie. Native checkpoints are preserved for an upstream that can read them, while incompatible surrounding history is normalized. The hook does not decrypt checkpoints or recover unreadable server-side context; see “Boundaries and diagnostics” below.

## Why a request hook

Magpie's native ChatGPT sign-in passthrough runs `gatewayHooks` while skipping the synchronous `magpie.middleware` chain. Filtering inside that middleware therefore does not cover this native route.

This package declares **`magpie.hooks`**, the entry called by the native route. Magpie also sends each incoming WebSocket turn through its HTTP handler after rebuilding any conversation continuation. The hook consequently sees the reconstructed history on that route.

See Magpie's [request-hook contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md) and [plugin author guide (Chinese)](https://usemagpie.ai/docs/zh/plugins).

## Install

Use a Magpie version that supports `magpie.hooks`. The original implementation was verified against **0.1.4226**, package loading against **0.1.4280**, and **1.0.1**'s mixed-compaction fix against **0.1.4363**. **1.0.2** was checked on **0.1.4379**, and **1.0.3** on **0.1.4402**. These are tested versions, not a claim about the earliest compatible version.

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
- `/v1/responses` and `/responses` with those models when Magpie identifies the client as `codex`.

Requests for other provider-prefixed models pass through. Shared Responses endpoints also pass through requests from other or unidentified clients. Scope is determined from the model name at hook time; the hook cannot see the provider subsequently chosen by a group or fallback.

On an applicable request, the hook:

1. Removes old `reasoning` items.
2. Removes top-level `encrypted_content` replay copies from supported output items with complete plaintext, retaining the plaintext and other fields.
3. Converts historical `web_search_call` items into clearly labeled assistant text containing only the data present in the original item.
4. Removes optional server `id` fields from portable history items.

Step 2 covers assistant `message` items with complete text, function/custom calls with plaintext arguments, and their nonempty text results. Codex's `output.encrypted_content` can make these outputs carry both plaintext and an encrypted replay copy; that copy must not disable the whole filter. This handling does not remove `encrypted_function_args`. Ciphertext-only or partially sealed records and top-level replay seals that do not meet the conditions above still require opaque-context handling. Dedicated checkpoints remain unchanged.

Portable tool items include function/custom/tool-search calls and results, computer results, shell/apply-patch calls and results, and MCP approval responses. Their `call_id`, `approval_request_id`, and identifiers inside tool data remain intact. Server tools requiring an ID and unknown item types pass through; they are not all converted into text.

With a native checkpoint present, these steps still apply to other history items. The checkpoint's ID, encrypted content, and internal metadata are preserved unchanged.

Visible messages, assistant `phase` values, images, tool arguments/results, `call_id` pairing, nested application identifiers, and tool declarations remain available. Model, tool choice, streaming configuration, and the request for new encrypted reasoning are preserved. The hook does not rewrite conversation files or responses.

Previous internal reasoning is removed even when it is otherwise readable, so filtered turns do not replay that persisted reasoning. This trades hidden reasoning continuity for readable conversation portability.

## Boundaries and diagnostics

Native checkpoints (`compaction`, `context_compaction`, `compaction_summary`) remain intact while other history items are filtered. This supports a conversation that was compacted natively, continued on a third-party model, and then returned to native, provided the native upstream can read the retained checkpoint. The hook does not decrypt a checkpoint or make it readable by an incompatible upstream; an unreadable checkpoint can still be rejected.

Requests containing genuinely opaque content (ciphertext-only or partially sealed records, or unsupported sealed types), `item_reference`, `previous_response_id`, or a server-side `conversation` reference are left intact and report `unavailable`; the upstream decides whether they can be accepted. **This remains a filtering gap: third-party reasoning in that same request is also passed through.** Supported replay copies with complete plaintext no longer trigger this bypass as of 1.0.3. References may target original item IDs, and sealed tasks may be readable only by their original upstream. Deleting references or ciphertext is not a context-preserving repair.

For normal Magpie WebSocket continuations, the gateway reconstructs full input and removes `previous_response_id` before invoking the request hook. A raw HTTP request containing a server-only reference is a different case.

Dedicated `/responses/compact` calls and Magpie's internal requests are outside this hook's scope. Magpie's request-hook contract also rolls back a hook on failure or timeout, which can allow the original request to reach the upstream.

Diagnostics use the fixed codes accepted by Magpie's host:

- `ready`: the hook modified the request. This confirms filtering ran; upstream acceptance must be checked separately.
- `unavailable`: opaque context required preserving the entire request without filtering.

The byte count is `0`: this hook adds no external recall content. It avoids serializing an image-heavy request again just for diagnostics. The custom `native-history-*` codes used in 1.0.0/1.0.1 are outside the host's allowlist and were ignored; 1.0.2 fixes that reporting issue. Host-generated `timeout` and `error` outcomes indicate hook failure.

The plugin does not log, read from disk, store, or export request content, account identifiers, or credentials. It processes only the body and context Magpie supplies.

## Other failure cases

| Situation | What can happen and how to handle it |
| --- | --- |
| Mixed-provider groups, smart routing, or fallback into Codex | A `group/…` name does not trigger native filtering. An unprefixed name on a shared endpoint also does not prove which provider will answer. Select a native model or `codex/…` explicitly when coverage is needed. Complete mixed-group support needs an entry after provider selection. |
| Account/API-key changes or a relay distributing requests across upstreams | A checkpoint, sealed task, or encrypted function argument may require its original service. Magpie tracks writers of checkpoints it has observed, but an unknown or unavailable writer can still cause failure. Keep readable context and use a route able to read the seal; this hook does not decrypt it. |
| Server references or genuinely sealed messages mixed into history | `unavailable` means the whole request was retained. Supported replay copies beside complete plaintext are normalized; raw HTTP server references and sealed multi-agent tasks need separate investigation. |
| New tool types or server tools depending on earlier reasoning/approval records | Required IDs are preserved, which does not establish portability. Investigate the actual type and dependency on item-not-found, missing-pair, or encrypted-function-args errors. Do not discard tool results in bulk. |
| Hook timeout, host startup failure, or another plugin rewriting the request | Hooks run in order and failure retains the last accepted body. Check `timeout`/`error` and the final request result; enable one copy of this hook. Later hooks or synchronous middleware may rewrite history again. |
| Compaction, title, summary, or other internal request failures | Dedicated `/responses/compact` and Magpie's own requests do not run this hook. Identify the failed operation before deciding whether to fix the client, gateway, or plugin. |
| Source updated but an older installation still runs | Verify the enabled entry's path and version and reload with an on/off cycle. GitHub source, release assets, and the active installation are updated separately. |

Start diagnosis with the actual model/provider, failed endpoint, error code, and hook outcome. Treat `invalid_encrypted_content`, `previous_response_not_found`, context overflow, and 401/429/5xx failures separately; successful history filtering does not resolve account, quota, or service availability issues.

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

**1.0.1 fixes filtering skipped for mixed compacted history.** Version 1.0.0 bypassed the entire request when it found a checkpoint, also passing through later third-party reasoning. A new live replay used 200 input items containing a native checkpoint and subsequent third-party history: the previous version reproduced the encrypted-content error and the fix passed the native request. A single WebSocket carrying that same mixed history also completed four alternating turns while retaining the verification marker. Synthetic tests verify exact checkpoint preservation and continued filtering of the surrounding history.

**1.0.2 fixes the reporting contract and covers known path/history variants.** It adds `/responses`, preserves `compaction_summary`, normalizes six further tool types with optional server IDs, and reports host-supported `ready`/`unavailable` outcomes. Synthetic regressions cover these formats and preservation checks; the real mixed conversation is also rechecked through native HTTP and WebSocket switching.

**1.0.3 fixes a whole-request bypass caused by output replay copies.** A real history contained a complete plaintext assistant answer with its top-level encrypted copy, followed by third-party reasoning. Version 1.0.2 treated that answer as opaque and reproduced the same `invalid_encrypted_content` error on native replay. Version 1.0.3 retains the plaintext, removes the supported replay copy, and filters old reasoning; the same approximately 4.56 MB request succeeds. That history also passes six alternating third-party/native turns on one WebSocket, with native turns requesting new `output.encrypted_content` and preserving the continuity marker. The upstream returned no new encrypted message copies in this run; all continuations retained history carrying the original copy. Regressions verify continued protection of genuinely sealed records and that encrypted parts inside discarded reasoning do not disable filtering.

Those live results describe the tested environment, rather than every gateway, account, model, or history format. Real conversation logs, account data, authentication readers, local backups, and the original live replay scripts are excluded from this repository.

## Remove

```sh
magpie plugin off github:Singrun/magpie-codex-native-history
# Or uninstall:
magpie plugin rm github:Singrun/magpie-codex-native-history
```

## License and attribution

[MIT](LICENSE). Earlier history-filtering work is credited in [NOTICE](NOTICE). This is an independent community plugin.
