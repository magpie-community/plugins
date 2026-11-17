# agent-varin

Adds [Varin](https://github.com/Astrmira/Varin) to magpie's Agents page, so the
model its conversations run on is picked next to every other agent's.

Varin keeps its conversation default in one plain JSON file:

```json
// ~/.config/varin/agent-settings.json
{ "defaultProvider": "<channel uuid>", "defaultModel": "group/…",
  "defaultThinkingLevel": "high" }
```

`defaultModel` is the model id exactly as Varin's own channel lists it, so magpie
writes that one key and nothing else. Switching off puts the file back as it was,
key by key; magpie never rewrites it whole.

```sh
magpie plugin add @magpie-community/agent-varin
magpie varin                                  # which model it is on
magpie models varin                           # what it can pick
magpie varin group/deepseek-v4.1-flash-smart  # set it
magpie varin default                          # back to what Varin had
```

Varin reads its default when a Run starts: open a new conversation (or restart
Varin) to use the new model.

## Before it can pick anything

This plugin picks a model **Varin already carries**. It cannot add the channel
that carries magpie's models, so on a Varin that has never been pointed at
magpie's gateway, the row appears and the model list is empty.

Add the gateway once, by hand, under **Agent → model services**: an
**OpenAI compatible** service at `http://127.0.0.1:3425/v1`, then **fetch
models**. That is the same one-time step Ollama and LM Studio users do. magpie's
models then appear in this plugin's row.

Why the plugin cannot do it: Varin keeps its channels in a top-level JSON
**array** (`models.json` → `channels`), and magpie's agent contract sets
individual key paths and merges object members only — no key path appends to an
array, and `connect()` cannot read files, so it never sees the channels already
there. PiG can write its whole model list because its `models` array sits inside
one object (`providers.magpie`); MeowCode can because the file is its own. Varin
has neither shape.

## Usage attribution

`ua: ['varin']` is declared, which is magpie's field for naming an agent's
requests in **Usage**. It does **not** cover Varin's inference traffic, which is
worth knowing before looking at the Usage page and wondering why Varin is missing.

Requests reach magpie through the user's own model channel and its caller key,
not through this plugin, and magpie files each request under the agent its
**User-Agent** names — the values in its usage log are UA names (`curl`, `node`,
`Bun`, `Go-http-client`), with `other` for an unrecognised one. Varin sends no UA
that names itself, so its requests land under `other`.

Measured, sending the same request with different UA:

| User-Agent sent | recorded as |
| --- | --- |
| `varin` | `agent: "varin"` |
| `Varin` | `agent: "varin"` |
| `curl/8.23.0` | `agent: "curl"` |
| none | `agent: "curl"` |

To have them counted under Varin, add the header to the channel itself — Varin
keeps per-channel request headers in `connection.headers`:

```json
// ~/.config/varin/models.json, inside the magpie channel
"connection": { "headers": { "User-Agent": "varin" } }
```

Verified end to end: with that header, a request through the channel is logged as
`agent: "varin"` under the channel's own caller key. Requests logged before the
change keep `other`; magpie does not relabel history.

## The Library

The `library` block is what puts Varin in magpie's Library, so instructions, MCP
servers and skills can be ticked for it there. Without it magpie leaves the agent
out: it is given nothing, and ticking an item for it is refused.

These are Varin's own paths, taken from its resource resolution
(`web/server/lib/agent-resources/`), not guessed:

- `instructions` — Varin reads a context file beside its `user` resource root,
  which is `~/.config/varin/resources`.
- `mcp` — Varin's agent-level MCP file sits beside `agent-settings.json`.
- `mcpFormat: 'claude'` — Varin reads `{"mcpServers": {…}}`, the shape magpie calls
  `claude`.
- `skills` — a `skills` folder inside that same resource root.

That `resources` folder does not exist until something writes there: magpie creates
it the first time it writes an instruction or a skill for Varin.

## The icon

The row wears Varin's own application icon, taken from the official AppImage
(`usr/share/icons/hicolor/1024x1024/apps/varin.png`), downscaled to 256×256 and
carried inline as a `data:` URL. An agent module runs on moejs — one file, no
imports, no file reads — so the icon cannot be a path on disk.

magpie caches it under `~/.config/magpie/icons/<sha256-of-png>.png` and records it
in `plugin-icons.json`, so the picture survives without re-reading the plugin.

## `defaultProvider` is left alone (by design)

`defaultProvider` is a per-install UUID, and this module cannot read `models.json`
to discover it. So `connect()` returns nothing and magpie writes only
`defaultModel`; Varin keeps the channel it already had. That is correct whenever
Varin's default channel already carries the model — the normal case, since a Magpie
channel is what lets Varin reach magpie's models at all.

If your Varin has several channels and the default is another vendor's, fill the two
constants at the top of `varin.agent.js` (`PROVIDER_ID`, `KNOWN_MODELS`), both from
`~/.config/varin/models.json`. `connect()` then also keeps `defaultProvider`
correct. It still writes nothing for a model that set does not contain, because
magpie also calls `connect()` while previewing a pick — writing the channel id there
would pair a provider with a model it does not serve.

## Known limits

- **It picks among what Varin already carries.** No key path can append to Varin's
  top-level `channels` array, so pointing Varin at the gateway is a one-time manual
  step (see above).
- **Usage attribution needs the channel header.** The `ua` declaration alone does
  not name this traffic; see *Usage attribution*.
- A single conversation's own model choice is not touched.

## Tested

magpie 0.1.4093 on linux/x64, Varin 0.9.49. Switching models writes only
`defaultModel`, leaving the rest of `agent-settings.json` (including
`harness.permissions`) byte-identical. The User-Agent table above was measured
against magpie's usage log, and the channel header was confirmed end to end
through Varin's own text-generation route. Windows and macOS were not tried.
