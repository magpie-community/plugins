# OpenKodo plugin

Provider plugin that puts [OpenKodo](https://openkodo.dev) into Magpie and
OpenCode: plans, credits, usage windows, and the live model catalog.
Provider id: `openkodo`.

## What it shows

- Plan name and the OpenKodo mark
- Three rolling spend windows, shortest first: **5 hours**, **7 days**, and the
  **monthly** pool — each with the amount used, the cap, and when it frees up
- The per-model 5-hour request guardrail
- The live catalog from [`/api/public/models`](https://api.openkodo.dev/api/public/models)

The 5-hour and 7-day windows are enforced by the gateway, not decoration:
Go is $25 / 5h and $50 / 7d, Pro is $50 / 5h and $100 / 7d. Reset times are
rolling — the cap frees up when the oldest spend in the window ages out — so
they move as new requests arrive.

## Install

From the magpie plugin store, search for **OpenKodo**.

From a checkout:

```bash
pnpm add openkodo
```

## Sign in

Paste an OpenKodo API key from **Console → API keys**. Keys start with
`ok_live_`. The plugin validates the key against
`https://api.openkodo.dev/api/plugin/usage`; it never stores anything except
the key itself, and it never creates keys, changes plans, or spends credits.

## Provider

- Base URL: `https://api.openkodo.dev/v1`
- SDK: `@ai-sdk/openai-compatible`
- Models: fetched live, with a bundled fallback for offline starts

## Development

```bash
npm test           # unit tests, no network
npm run pack:check # what would be published
```

The tests stub `fetch`, so they never use a real API key.

## License

[MIT](./LICENSE)
