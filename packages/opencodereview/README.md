# @magpie-community/agent-opencodereview

[Open Code Review](https://github.com/alibaba/open-code-review) (`ocr`),
Alibaba's AI code review CLI, as a magpie agent. With this plugin it is on
magpie's Agents page like the agents magpie ships with: pick one of magpie's
models for it and `ocr review` / `ocr scan` run on that model.

This is an unofficial integration: Open Code Review is Alibaba's, and this
plugin is not affiliated with or endorsed by Alibaba. The icon is Open Code
Review's own logo, which magpie references by URL.

```sh
magpie plugin add @magpie-community/agent-opencodereview
```

Then pick one of magpie's models in Open Code Review's row. magpie writes into
`~/.opencodereview/config.json`:

```json
{
  "model": "zai/glm-5.3",
  "provider": "magpie",
  "custom_providers": {
    "magpie": {
      "url": "http://127.0.0.1:3425",
      "protocol": "anthropic",
      "api_key": "magpie-…"
    }
  }
}
```

## What it owns

| Key | Value |
|---|---|
| `provider` | `magpie` |
| `model` | the magpie model picked |
| `custom_providers.magpie.url` | the gateway's base address, with no `/v1` |
| `custom_providers.magpie.protocol` | `anthropic` |
| `custom_providers.magpie.api_key` | the key magpie keeps for ocr |

`provider` and `model` are ocr's own selection; `protocol: "anthropic"` makes
ocr speak the Anthropic Messages API. The url has no `/v1` suffix because ocr
appends `/v1/messages` itself. These are the keys `ocr config set` writes for a
custom provider (`provider`, `custom_providers.<name>.url`, `.protocol`,
`.api_key`).

Everything else stays yours: other `custom_providers` entries, `providers`,
`llm`, `max_tokens`, `effort`, `language`, `mcp_servers`, `rule.json` and
sessions. magpie edits keys in place and stashes what it replaces.

A `custom_providers.magpie` you had before is replaced whole while connected —
the three fields above, and nothing else — and restored on disconnect. Its
values come back; its formatting and comments do not. Keep a manual service you
need beside magpie under another provider name.

The plugin gives ocr no Library instructions, MCP servers or skills: ocr keeps
its own `rule.json` and `mcp_servers`.

## Disconnecting

ocr reads the file on every run, so the next `ocr review` / `ocr scan` uses the
new model: no restart. Disconnecting — picking ocr's own model again or
switching it off — puts back the `provider`, `model` and
`custom_providers.magpie` values magpie replaced, and removes the keys it
added. A machine with no config file at all is left an empty
`custom_providers` object; ocr ignores it.

Disconnect before disabling or uninstalling the plugin: removing a plugin does
not run the agent's disconnect, and ocr would keep pointing at a gateway that
is no longer configured for it. If that happens, set `provider` back to the
provider you used before, or remove `provider` and `custom_providers.magpie`
by hand.

## Other ways ocr finds an endpoint

ocr resolves its endpoint from the config file first, then `OCR_LLM_URL`,
`OCR_LLM_TOKEN` and `OCR_LLM_MODEL`, then `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL`, then shell rc files. A complete
config file wins, so the saved `magpie` provider takes precedence over those
variables (checked with ocr v1.13.2). `ocr llm test` sends a test conversation
to the configured model and is the quickest way to verify the setup.

## Configuration path

ocr keeps its config at `~/.opencodereview/config.json`, its home taken from
the OS. It has no flag or environment variable that moves it (v1.13.2), so a
different `HOME` (or `USERPROFILE` on Windows) is the only way it moves; the
descriptor uses the same `~` magpie expands.

## Requirements and verified versions

magpie installed and signed in; `ocr` installed with
`npm install -g @alibaba-group/open-code-review`.

Tried on macOS 26.6.2 arm64 with magpie 0.1.1326 and ocr 1.13.2, including
`ocr llm test`'s tool round trip and disconnect restoring a pre-existing
config. The descriptor has no platform-specific code; the same path and keys
apply on macOS, Linux and Windows, though only macOS was tried.

## Development

```sh
bun test packages/opencodereview
magpie plugin add ./packages/opencodereview   # try it on your own magpie
```

The module is one file with no imports, run by magpie's engine. The
repository's `scripts/check.mjs` skips agent packages; this package's test
checks the descriptor and what `connect` returns.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
