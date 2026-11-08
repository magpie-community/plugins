# Magpie Antigravity ACP provider

This package exposes every model advertised by the installed Google Antigravity
CLI to Magpie. Requests are sent to the official `agy acp` executable over its
documented JSONL protocol. The package does not use T3 Code, call
Antigravity's private HTTP endpoints, copy OAuth tokens into Magpie, or emulate
the Antigravity web client.

## Local setup

The plugin needs the official `agy` CLI and its existing sign-in. It discovers
the complete model list by running `agy models` and uses the same installed CLI
for `agy acp` requests.

Set these environment variables for the Magpie process when the defaults do not
match the installation:

- `MAGPIE_ANTIGRAVITY_ACP_BIN`: optional absolute path to `agy` or another official ACP executable.
- `MAGPIE_ANTIGRAVITY_HOME`: optional `GEMINI_HOME` directory used by `agy`.
- `MAGPIE_ANTIGRAVITY_MODEL`: an ACP model slug, for example `gemini-4-argon-medium`.

Install from the public repository:

```sh
magpie plugin add https://github.com/yulong-ge/magpie-antigravity-acp
magpie plugin login antigravity-official-acp
magpie models
```

The Magpie plugin market entry is submitted to `magpie-community/plugins`.
Until that registry change is merged, install the GitHub repository directly.

The login command only creates a Magpie account marker. Google authentication
still belongs to the official `agy` CLI and must already be present there.

## Risk boundary

Using the official ACP runtime avoids the specific reverse-proxy behavior that
motivated this adapter. It cannot guarantee that Google will never restrict an
account: Google controls eligibility, quotas, client policy, and abuse review.
The adapter does not spoof a client, rotate accounts, bypass quotas, or hide
traffic from Google.

## Validation

`test/transport.mjs` validates the ACP framing and request sequence against a
fake ACP process. A live acceptance test must run on a machine where the official
ACP runtime is authenticated and network access is available.
