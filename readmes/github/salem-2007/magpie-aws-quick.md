# magpie-aws-quick

Unofficial Magpie plugin that connects your personal AWS Quick account through the **official browser authorization flow**. It exposes Quick's Fast, Balanced, and Smart routing modes as an OpenAI-compatible provider. The Quick desktop app is not required.

> **Personal use only.** This plugin uses an undocumented AWS Quick WebSocket protocol, not a public AWS API. This may violate AWS terms or change without notice, and could result in account restrictions. Use it only with an account you control and at your own risk. This project is not affiliated with or endorsed by AWS.

## How it works

Magpie sends OpenAI Chat Completions requests to the plugin. The plugin translates messages to Quick's bidirectional Gateway protocol and converts responses back to OpenAI-compatible completions:

```text
Agent -> Magpie -> aws-quick plugin -> AWS Quick Gateway WebSocket
```

Sign-in is browser OAuth with PKCE and a loopback callback. The authorization URL starts at `https://quick.aws.com/sn`; AWS handles the account login and MFA. The plugin exchanges the authorization code and refreshes tokens through the OAuth flow. It does not automate passwords, read browser cookies, or start the Quick desktop client.

## Features

- One sign-in method: personal AWS Quick authorization in the official browser.
- Three routing presets: `fast`, `balanced`, and `smart`. They are not fixed underlying model IDs; Quick chooses the actual model.
- Thinking effort mapping for Balanced and Smart. Fast always disables Thinking.
- OpenAI-compatible text completions and streaming responses.
- Client tool-call compatibility through a text convention. Quick does not expose native OpenAI function calling; the plugin parses declared `<tool_call>` blocks into OpenAI `tool_calls` for the client to execute.
- Image inputs: small inline images are attached to the message; larger inline images can use Quick's cloud upload and DLP flow, within per-image and per-turn limits.
- Thread reuse for append-only conversations, with separation by account, chat session, route, system prompt, and tool schemas.
- Quick entitlement usage on Magpie's account and Usage screens.
- Reused threads carry a short tool reminder instead of repeating schemas. Multi-step token usage reports the latest prompt size (including cache reads/writes) and accumulates generated tokens.
- Compact adapter instructions leave more room for your conversation. Frame fitting reduces older history before dropping the latest question; user instructions are not paraphrased (oversized system prompts still have the documented frame limits).
- A system prompt longer than 24 KB is compressed to fit; that adapter limit is not reported as conversation truncation.
- Optional loopback-only OpenAI-compatible HTTP server for clients outside Magpie.

## Install and authorize

Install the GitHub plugin in Magpie:

```sh
magpie plugin add github:salem-2007/magpie-aws-quick
```

Or download the `.tgz` from [GitHub Releases](https://github.com/salem-2007/magpie-aws-quick/releases) and install it locally. If upgrading, disable older copies of `aws-quick` first so Magpie does not load duplicate providers.

In Magpie, select **打开 AWS Quick 官方网页授权**, or run:

```sh
magpie plugin login aws-quick 1
```

Complete sign-in and MFA on the AWS Quick page, then return to Magpie. This is the only supported login flow. The plugin stores OAuth material in Magpie's protected auth store so refresh-token rotation can persist. If authorization expires or is revoked, sign in again through the same browser entry.

## Models

The provider exposes `aws-quick/fast`, `aws-quick/balanced`, and `aws-quick/smart`. `aws-quick/quick` remains as a compatibility entry and does not force a route. Use `reasoning_effort` with Balanced or Smart; Fast always sends Thinking off. Quick can change the underlying model it routes to.

If the models appear but Gateway connections fail, check the plugin proxy configuration in Magpie. Configure a proxy only if one is actually listening locally, for example:

```sh
magpie settings set pluginProxy http://127.0.0.1:7890
```

## Standalone OpenAI-compatible server

The optional server uses the same browser OAuth flow and does not read Magpie's auth store. Keep its OAuth file and local API key private. Run from the plugin directory:

```sh
node scripts/oauth-login.mjs --auth-file /absolute/path/private-quick-oauth.json
node scripts/gateway-server.mjs \
  --oauth-file /absolute/path/private-quick-oauth.json \
  --api-key-file /absolute/path/local-proxy-key.txt
```

It listens on `http://127.0.0.1:8787/v1` by default and provides `GET /models` and `POST /chat/completions`. Use the local API key, not an AWS token, and choose `fast`, `balanced`, or `smart`. `stream: true` returns SSE after the upstream turn completes; it is not a live token stream.

## Limitations and security

- Quick's protocol is private and can change at any time. No compatibility with a specific AWS model ID is promised.
- OpenAI tool calls are simulated as text instructions and depend on the model following the format. Quick's built-in server-side tools are separate and are not returned as client tool calls.
- Remote image URLs and non-image file attachments are not fetched. Larger images are limited to 3 MiB each, four uploads per turn, and 5 MiB total; Quick's DLP policy must explicitly allow each upload.
- Sampling parameters such as `temperature` are ignored because Quick's protocol does not expose them.
- Thread reuse requires a stable `x-magpie-session` header and matching conversation history. The cache is in memory, expires after 24 hours, and holds at most 200 entries. Without the header or after a reload, the plugin starts a fresh thread with the submitted transcript. Only images after the last assistant message are sent; resend an earlier image if it is needed in a fresh thread.
- The standalone server currently limits each HTTP request to 2 MiB, including base64 images. Magpie's plugin fetch supports the larger upload limits described above.
- OAuth refresh credentials are stored by Magpie. Protect the local account and do not share auth exports, OAuth files, API keys, or callback URLs.
- Gateway diagnostics avoid logging tokens and request headers. Network, account, and service limits remain controlled by AWS.

## Development

```sh
npm test
```

Tests use synthetic accounts and local fake services. They do not replace acceptance testing with an AWS account.

## Credits

This **0.5.8** build integrates message rendering, tool parsing, image upload, thread-cache helpers, entitlement usage and the 0.1.4 context/usage fixes from [httpdone/magpie-aws-quick](https://github.com/httpdone/magpie-aws-quick) through commit `adf163c`. It retains this repository's browser-only OAuth and Gateway implementation. The [npm package](https://www.npmjs.com/package/magpie-aws-quick) is a separate distribution; use this repository or its Release asset to install this build. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the retained MIT license notice.
