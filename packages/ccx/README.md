# @magpie-community/tools-ccx

Claude Code and Codex, as tools [magpie](https://usemagpie.ai) offers every agent it connects. With it, any of your agents can see how much of Claude Code's and Codex's usage window is left, and list and read their sessions. So when Claude Code runs out mid-task, the agent you switch to (OpenCode, Gemini CLI, Aider, or Codex itself) can read where the task stands instead of starting over.

It runs [ccx](https://github.com/aaronwong1999/ccx), the macOS app that keeps Claude Code sessions and Codex threads linked, through its `ccx` command. It only reads, and needs no key.

Install it from magpie's **Plugins › Discover**, or with:

```sh
magpie plugin add @magpie-community/tools-ccx
magpie plugin            # lists its tools
```

It needs ccx 0.0.34 or later on the same Mac (`curl -fsSL https://raw.githubusercontent.com/aaronwong1999/ccx/main/install.sh | sh`). Without ccx, every tool answers with how to get it. To run a ccx somewhere other than `~/.local/bin/ccx`, set `CCX_BIN`.

## Tools

The tools are served as `ccx_usage`, `ccx_sessions` and `ccx_read`.

**`usage`** `{}`: Claude Code's and Codex's current window for each app:
- `level`: `ok`, `near` (90% or more), `limit` or `unknown`
- `used_percent`
- `resets_at`
- `window`: `5-hour` or `weekly`
- `from`: where ccx read it. That is Codex's own app-server, Claude Code's limit replies, or a usage tool you already run (CodexBar, abtop, claude-hud, magpie, and others).

**`sessions`** `{app, cwd, query?}`: lists `claude` (Claude Code) sessions or `codex` threads, newest first, with title, last update, whether ccx has them linked, and id. You get the ones in the folder `cwd`, or with `query`, those whose title matches in every project.

```
Claude sessions, newest first:
1. “Fix the parser” 10-23 17:29 · not linked · id=0df7bf5a-…
```

**`read`** `{app, session_id, offset?}`: one page (about 6000 characters) of a session's condensed history: the messages, the task list and short tool results. Call it again with `next_offset` until that is `null`. The session itself is left as it is.

## Privacy

ccx works on this Mac only, and sends nothing. What `read` returns goes to the agent that called it, and from there to the model that agent uses, as anything an agent reads does. Turn the plugin off in magpie if an agent shouldn't see your Claude Code or Codex history.

## Test

```sh
HOME=$(mktemp -d) bun test packages/ccx
bun scripts/check.mjs ccx
```

The tests run a fake `ccx`, so they need neither ccx nor Claude Code nor Codex.
