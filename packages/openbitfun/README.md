# OpenBitFun

[OpenBitFun](https://openbitfun.com) as a magpie agent: pick magpie's models
once, and they are in OpenBitFun's own model settings, ready to choose.

OpenBitFun already knows magpie. Its provider catalog ships a `magpie` preset
and its model settings can probe a gateway and import its catalog, one manual
step in another app's window. This package removes that step. Switch the agent
on in magpie, and every model magpie offers appears in OpenBitFun's model list;
switch it off, and OpenBitFun's config is back exactly as it was.

## Install

```sh
magpie plugin add @magpie-community/agent-openbitfun
```

Then open **Agents** in magpie, find OpenBitFun, and switch it on. No key to
paste: magpie gives the agent a key of its own and OpenBitFun is pointed at
magpie's gateway with it.

In OpenBitFun, the models are listed under the **Magpie** connection in
Settings › Models. Choose one there (OpenBitFun picks the model itself, so the
row in magpie is a switch with no model picker).

Turning the agent off, or removing it, takes magpie's models back out of
OpenBitFun and leaves everything else in the file alone.

## What it writes

OpenBitFun keeps every model in one array, `ai.models`, in its config:

| | |
|---|---|
| Windows | `%APPDATA%\openbitfun\config\app.json` |
| macOS | `~/Library/Application Support/openbitfun/config/app.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/openbitfun/config/app.json` |

The entries are the ones OpenBitFun's own Magpie connection writes: `provider:
"openai"` on magpie's `/v1` address, the agent's key, `metadata.model_source:
"magpie"` and a fixed `provider_instance_id` of `magpie-openbitfun`.

Nothing else in the file is touched, and the file is never created: an
OpenBitFun that has never run has nothing to keep up. A model whose context
window is under 32,000 is not imported, and an output limit above 40% of the
context is cut to it, as OpenBitFun's own importer does.

Magpie's own file for this agent is `~/.config/magpie-openbitfun/bridge.json`,
and only while the agent is on.

## What it does not touch

- your own models in OpenBitFun, and any entries its own Magpie connection
  made (it mints a random instance id, this package uses a fixed one);
- the rest of `app.json`, key order included;
- OpenBitFun's binary and settings elsewhere.

## How it connects, and why it takes two parts

magpie edits a config one key path at a time. OpenBitFun keeps its models in an
array, so a key holding the whole array would replace the user's own entries.
The agent therefore writes magpie's own file, and a small host part merges the
entries into `ai.models` and takes them out again when the agent is off. The
merge follows OpenBitFun's `magpieModels.ts`, and what a model can do (images,
tool calls) comes from magpie's `/v1/models`, the list OpenBitFun's own probe
reads, not from the agent catalog's `images` flag, which is true for every
model.

Restart OpenBitFun only if it was closed while you connected. It reads
`app.json` while it runs, so the models appear without one.

## The Library

magpie's Library can give this agent its MCP servers and skills. Tick them for
OpenBitFun on the Library page, or with `magpie library …`.

**Skills** reach `%APPDATA%\openbitfun\skills`, the folder OpenBitFun itself
reads (`path_manager.rs`), as `<name>/SKILL.md` folders, linked where Windows
allows it. That path is the Windows one, because an agent's `library` block is
the same on every platform. On macOS the folder is `~/Library/Application
Support/openbitfun/skills`, on Linux `~/.local/share/openbitfun/skills`, and
magpie's Library page names the key to change when it is not yours.

**MCP servers** need a hop. OpenBitFun keeps them inside `app.json`
(`mcp_servers.mcpServers`, in the shape it calls Cursor's), and magpie can only
hand an agent a file. So magpie writes this agent's own
`~/.config/magpie-openbitfun/library/mcp.json`, and the host part merges the
servers into `app.json` beside yours. A name the two share goes back to yours
when the agent is switched off.

**Instructions** are not declared, and that is deliberate. OpenBitFun reads
instructions per workspace (`AGENTS.md`, `CLAUDE.md`, `.claude/rules`) and has
no user-level instructions file, so magpie's shared instructions have nowhere to
land. It is better to say so than to pretend to write a file nothing reads.

## Known limits

OpenBitFun and this package both write `app.json`, and this one writes it whole
(atomically, through a temporary file). A setting OpenBitFun saves in the same
instant can be lost, so quitting OpenBitFun before the first connect is
safest. Entries are keyed by model, so a model magpie stops offering leaves the
list; an empty catalog from magpie changes nothing. Edits you make in
OpenBitFun while connected are kept, but a wholesale restore is only byte for
byte when nothing was edited in between.

A `bridge.json` or `library/mcp.json` that is not valid JSON — hand-edited or
half-written — is read as "not connected": the bridge keeps OpenBitFun's file
as it is instead of stopping. The bridge reads and writes regular files only; a
symbolic link in place of any of them is refused, not followed.

Tested against OpenBitFun 1.0.9 on Windows and magpie 0.1.4332.

## Package layout

| File | |
|---|---|
| `openbitfun.agent.js` | the agent: where magpie keeps its file, and `connect` |
| `bridge.mjs` | the merge into `app.json`, as pure functions |
| `index.mjs` | the Bun host part magpie runs the bridge from |
| `agent.md` | the engineering notes: sources, decisions, constraints |

## Development

```sh
bun test packages/openbitfun/openbitfun.test.mjs   # no network, no real config
MAGPIE=/path/to/magpie scripts/try.sh openbitfun   # a sandbox magpie of its own
```

MIT.
