# atlascloud

Atlas Cloud ([atlascloud.ai](https://www.atlascloud.ai)) with your API key, in
[OpenCode](https://opencode.ai) and [magpie](https://usemagpie.ai). Atlas Cloud serves an
OpenAI-compatible inference API at `https://api.atlascloud.ai/v1`; this plugin signs every
request with your key, so agents reach its models like any other provider —
multi-account, fallback, quotas and all.

**Provider id:** `atlascloud`

## Sign-in

An Atlas Cloud API key, created on the [API Keys](https://console.atlascloud.ai/api-keys)
page of the Atlas Cloud Console. The key is stored as `{ "type": "api", "key": "…" }` in
OpenCode's `auth.json` and magpie's `plugin-auth.json` (permissions 600); a key Atlas Cloud
refuses marks the account for sign-in again.

## Models

The models your key can use, listed per account from `GET /v1/models`. Each row takes what
the listing states: context window and output limit, prices per million tokens, image input
when `image` is an input modality, and reasoning when the entry lists a `reasoning`
parameter. A limit the listing doesn't state stays unknown (0). Reasoning models offer the
`high` and `xhigh` efforts (`reasoning_effort`), the two levels the gateway takes on every
model. Chat completions only; image and video generation models are not served here.

## Usage

No balance endpoint is read, so the usage card shows the sign-in state and "Pay as you go"
rather than invented numbers; spend and balance live in the
[Atlas Cloud Console](https://console.atlascloud.ai/).

## Install

```sh
magpie plugin add @magpie-community/opencode-atlascloud-auth
magpie plugin login atlascloud
magpie provider test atlascloud
```

In OpenCode, add the same package under `plugin` and sign in with `opencode auth login`.

## Development

```sh
bun test
bun scripts/check.mjs atlascloud
```

MIT. Not affiliated with Atlas Cloud.
