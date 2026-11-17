# magpie-workspace-sync

A [magpie](https://github.com/yetone/magpie) plugin that keeps the **workspace (project) lists of your AI agents in step**: add a project in Codex and it shows up in Antigravity and DeepSeek Harness too, one click or automatically.

[简体中文](README.zh-CN.md)

You choose which agents take part, which one is the **template** (whose workspaces get copied), and which ones **get** them. Sync only ever **adds**. It never edits, renames or removes a workspace.

## Install

```sh
magpie plugin add github:luoqi1024/magpie-workspace-sync
```

or in magpie: **Plugins → Add a plugin**, and give it that address (or a local folder). Then open **Workspace Sync** in the sidebar's Plugins group.

## Agents

| Agent | Read | Write | How it writes |
| --- | :-: | :-: | --- |
| Codex | yes | yes | Codex's own app-server (`project/create`), never its database |
| Antigravity | yes | yes | its language server (`CreateProject`); needs Antigravity running |
| DeepSeek Harness | yes | yes | `workspace.json`, backed up first, written atomically |
| Cursor, VS Code | yes | – | recently opened folders; template only |
| Claude Code | yes | – | folders in `~/.claude.json`; template only |

An agent with a project list can be a template and a target. Editors that only remember folders can be a template. Adding another agent is one adapter file (`src/agents/`).

## Using it

1. **Pick the agents.** Per agent, tick *Template* and/or *Sync into*. *Mirror all* makes every agent both. Or pick one agent and press *Use as the only template*. Nothing is set until you choose, so a first run never writes anywhere.
2. **Sync now.** *Check differences* lists what would be added to which agent. Untick what you don't want, or press *Never sync* on a folder. *Sync selected* adds the rest.
3. **Undo.** The history lists each run with an *Undo* that removes exactly what that run added.
4. **Automatic sync** (optional). Switch it on and it watches the agents. When you add a workspace in one, it's added to the others within seconds, with the page closed.

### The rules

- A workspace is its **folder**. Two agents that spell the same folder differently (`D:\Dev\x`, `d:/dev/x/`, `file:///d%3A/dev/x`) count as one.
- A project is "there" in a target when its first folder is already in it. A target that takes several folders per project (Codex, Antigravity) gets the project whole. One that takes a single folder (DeepSeek Harness) gets one workspace per folder it lacks.
- Folders that no longer exist are skipped.
- **Automatic sync only adds what appeared after you turned it on.** What already existed is left to a manual sync, so switching it on never copies your whole history around. A workspace you delete in a target is **not** added back.
- If a target isn't available (Antigravity not running), it's tried again until it is.

## Tools for your agents

The same sync is offered to every agent through magpie's MCP server (`/mcp/magpie/tools`) as `magpie-workspace-sync_status`, `_plan`, `_run` and `_undo`. `run` only previews unless called with `confirm: true`, and does nothing until the template and targets are chosen in the page.

## Options

Plugins → this plugin → Options (or `magpie plugin options magpie-workspace-sync '{"port":3490}'`):

| Option | Default | |
| --- | --- | --- |
| `port` | `3481` | the page's service, on 127.0.0.1 only |
| `dataDir` | `<magpie config>/workspace-sync` | settings, history and backups |

Environment: `CODEX_HOME`, `CODEX_BIN`, `DSH_HOME` are honoured.

## Safety

- Writes are additive and go through each agent's own door where it has one (Codex, Antigravity). DeepSeek Harness has none, so its file is copied away first (the last 10 are kept in `dataDir/backups/dsh`), the change is written to a temporary file and renamed, and a file in a layout the plugin doesn't know (`unit.version` ≠ 2) is never touched.
- The page's service listens on 127.0.0.1 and checks the `Host` header; every API call needs a token that only the page's own HTML holds, and that HTML is never given to a script's `fetch`, so another website can't read it.
- A plugin runs in magpie's host with your rights. This one reads the agents' project lists and writes only the additions above. It sends nothing over the network.

## Without magpie

```sh
node scripts/cli.mjs status
node scripts/cli.mjs plan --from codex --to dsh,antigravity
node scripts/cli.mjs apply --yes --from codex --to dsh,antigravity
node scripts/cli.mjs undo
```

## Development

```sh
npm test      # Node 22+; no dependencies
```

The Codex test runs Codex's real app-server against a throwaway `CODEX_HOME` and is skipped when Codex isn't installed.

```
index.js        plugin entry (magpie host): service, auto-sync, tools
src/plan.js     what to add where (pure, the rules above)
src/sync.js     look, plan, apply, journal, undo, auto tick
src/agents/     one adapter per agent
src/server.js   the page's local service
ui/             the page (plain HTML/JS, no build)
page/           the small file magpie opens, which sends the frame to the service
```

## License

MIT
