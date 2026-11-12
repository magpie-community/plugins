# Freebuff for Magpie

A [Magpie](https://usemagpie.ai) provider for the [Freebuff](https://freebuff.com) **Developer API**.
Sign in with a Developer API key and use Freebuff's OpenAI-compatible models from any Magpie agent.

## Install

```sh
magpie plugin add github:chengyixu/magpie-freebuff
magpie plugin login freebuff
```

Create the key at [freebuff.com/account/api](https://freebuff.com/account/api). The Developer API
spends a prepaid USD balance, and Freebuff only offers key creation after your first credits arrive.

## What it does

- **Models come from Freebuff's live catalog** (`GET /api/v1/paid/models`, public). Nothing is copied
  into the plugin, so the list cannot go stale. If the catalog cannot be read, Magpie keeps the list it
  had.
- **Capabilities are what the catalog states**: tool-call support per model. The catalog publishes no
  context limits, image input or reasoning support, so the plugin claims none. Set them for a model in
  your provider config; your values win.
- **Models that do not stream still work in streaming agents.** For a model the catalog marks
  `streaming: false`, the plugin asks for one JSON reply and replays it as a stream. Models that stream
  are untouched.
- **A rejected key is reported as Freebuff reports it** (`401 Invalid API key`), with `X-Magpie-Sign-In: expired` set on the reply. Magpie 0.1.3295 logs the failed call but still shows the account as signed in, so check `magpie plugin login freebuff` if every request returns 401.
- **A Freebuff CLI/Desktop session token is refused on the spot**, with a message that says what it is.

## What it does not do: the free tier

The free tier belongs to Freebuff's own CLI and Desktop apps. Freebuff has no supported way for another
program to use it. Headless and SDK support is an open feature request
([CodebuffAI/freebuff#947](https://github.com/CodebuffAI/freebuff/issues/947)). Every free-mode request
from the official CLI carries environment descriptors (`freebuff_client_env`, `freebuff_input_profile`)
that the server uses to tell its own client from other programs. This plugin does not imitate them, the
CLI's system prompt, or its ad flow.

## Develop

```sh
npm test                              # offline, against the recorded catalog
FREEBUFF_API_KEY=fb_... npm run smoke   # live: one real chat on a streaming and a non-streaming model
```

`fixtures/paid-models.json` is a recorded slice of the real catalog. Re-record it with `curl` when the
catalog's shape changes; do not hand-write rows.

## Notes

- The real key never rides on `loader.apiKey` (a placeholder goes there, because the host shares loader
  options with other plugins' `chat.headers`); it is injected per request in `fetch`.
- `fetch` refuses any origin other than `freebuff.com`, so a host that hands the loader to another
  plugin cannot leak the key elsewhere. The public catalog is read without the key.
- The module exports exactly one function. Magpie calls every exported function as a plugin, so a second
  export would initialize the provider twice.

MIT.
