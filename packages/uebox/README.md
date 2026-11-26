# @magpie-community/agent-uebox

[UEBox](https://github.com/ueboxai/uebox) (虚幻盒子, Unreal Box), the open-source
AI agent that operates Unreal Editor, as a magpie agent. magpie has no setup of
its own for UEBox; with this plugin it is on magpie's Agents page like the
agents magpie ships with. Unofficial.

```sh
magpie plugin add @magpie-community/agent-uebox
```

Then switch UEBox on in its row on the Agents page. magpie's models, its
accounts, failover and usage then serve UEBox.

## How it works

UEBox keeps its model providers in `models.json` in its data folder
(`%APPDATA%\unreal-box\` on Windows, `~/Library/Application Support/unreal-box/`
on macOS, `~/.config/unreal-box/` on Linux). `providers` there is an array, and
magpie's own writer replaces an array it cannot index, which would drop the
user's other providers. So the work is split:

- `uebox.agent.js` runs in magpie. `connect` hands the gateway address, UEBox's
  own gateway key and the model list to a small link file,
  `~/.config/magpie/uebox-link.json`.
- `index.mjs` and `lib/sync.mjs` run in the plugin host. They watch that file and
  UEBox's folder, and merge one provider, `magpie`, into `providers`. Every other
  provider and every role is left as it was. The first file found is kept once as
  `models.json.magpie-backup`, and each write is a temporary file renamed over
  it. Switching UEBox off removes only that one entry.

The provider speaks the OpenAI Responses API at `<gateway>/v1`. It is Responses
on purpose: UEBox's Chat completions client sends no session id, and magpie then
lists every call under "no session id"; its Responses client sends `session-id`,
which magpie reads. The key is the per-agent gateway key magpie gives UEBox
(`magpie-uebox`), written as a command UEBox runs because UEBox encrypts any key
it is given and cannot be handed one from outside. Usage is counted as `uebox`.

## Library support

`uebox.agent.js` declares UEBox's `library` places so magpie's Library can sync:

- **Instructions** (`$APPDATA/unreal-box/instructions.md`): UEBox reads this file
  as `<user_instructions>` in its system prompt (capped at 4000 characters by
  UEBox).
- **Memory**: works through both the Memory digest written into `instructions.md`
  (when UEBox is ticked under Library → Instructions) and the `magpie-memory` MCP
  server (when ticked for UEBox under Library → MCP servers).
- **MCP servers** (`$APPDATA/unreal-box/mcp.json`, format `claude`): supports
  both `stdio` and `http` servers under `mcpServers`. Note that UEBox only accepts
  server IDs matching `/^[a-zA-Z0-9_-]{1,32}$/`.
- **Skills** (`$APPDATA/unreal-box/skills`): **set UEBox to Copy mode**
  (`magpie library skill how copy uebox`, or switch UEBox to Copy in Library →
  Skills). UEBox's skill scanner uses `Dirent.isDirectory()`, which skips
  symlinks and Windows directory junctions.

Hooks, Environment variables, Subagents, Slash commands, and Rules are not
applicable: magpie currently exposes only `instructions`, `mcp`, and `skills` to
plugin-added agents, and UEBox itself does not load external files for those five
categories.

## Limits

- UEBox reads `models.json` when it starts, and again when Settings → Models is
  opened. Restart UEBox, or reopen that page, after connecting.
- Only the provider is added. Pick the model for UEBox's roles (chat, agent,
  vision, summary) in UEBox's own Settings → Models; a role left on another
  provider does not go through magpie.
- The folder it looks in is UEBox's default one. Set `UEBOX_USER_DATA` to point
  it elsewhere. Tested on Windows.
- UEBox runs its own checks on `models.json` as it loads it, and drops a role that
  names a provider it does not have, so the provider is written before any role
  can use it.

## Tests

```sh
bun test
```

They read and write only a folder of their own.

MIT. UEBox is Apache-2.0; its icon is `build/icon.svg` of
[ueboxai/uebox](https://github.com/ueboxai/uebox).
