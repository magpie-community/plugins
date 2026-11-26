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

`uebox.agent.js` points `agent.library` at a cross-platform staging folder
inside magpie's config directory (`~/.config/magpie/uebox-library/`), and the
plugin host (`index.mjs` + `lib/library.mjs`) merges it into UEBox's real data
folder (`uebox_dir()` on Windows, macOS, and Linux):

- **Instructions** (`instructions.md`): merges only the
  `<!-- magpie:begin … -->` / `<!-- magpie:end -->` block while preserving the
  user's own text. UEBox injects this file as `<user_instructions>` in its
  system prompt (capped at 4000 characters by UEBox).
- **Memory**: works through both the Memory digest written into `instructions.md`
  (when UEBox is ticked under Library → Instructions) and the `magpie-memory` MCP
  server (when ticked for UEBox under Library → MCP servers).
- **MCP servers** (`mcp.json`, format `claude`): merges managed `stdio` and
  `http` servers into `mcpServers`, preserves existing user servers as well as
  per-server fields you set inside UEBox (`trusted`, `allowedTools`,
  `readOnlyTools`, `disabled`), and removes only magpie-managed entries when
  unticked. Server names longer than 32 characters (UEBox's limit) are skipped
  and logged.
- **Skills** (`skills/`): UEBox's `SkillsService` uses
  `readdir(..., { withFileTypes: true })` with `entry.isDirectory()`, which
  skips symlinks and Windows directory junctions. The plugin host dereferences
  staged skills and copies them as real directories into UEBox's `skills/`
  folder, leaving user-owned skills untouched, so skills work with magpie's
  default link mode without manual configuration. If you edit a copied skill
  inside UEBox, the plugin detects the content change and leaves your edited
  copy alone on both updates and unticks.

**Cleanup & sync state**: Before uninstalling this plugin, untick UEBox under
Library → Instructions / MCP servers / Skills so the host removes its managed
entries cleanly; otherwise remove the `<!-- magpie:begin … -->` block from
`instructions.md`, managed entries from `mcp.json`, and copied folders from
`skills/` manually. The host tracks which entries it owns in
`~/.config/magpie/uebox-library/.uebox-sync-state.json`; if that state file is
deleted, previously managed entries are treated as user-owned and will not be
removed automatically.

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
