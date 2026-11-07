# @magpie-community/tools-ccx

Claude Code and Codex conversations, as tools [magpie](https://usemagpie.ai) offers every agent it connects. When a task was started in Claude Code or Codex and you want to carry it on with another agent or model in magpie, the agent can find that conversation and read it, instead of you explaining the task again.

It reads through [ccx](https://github.com/aaronwong1999/ccx), an open-source macOS tool that syncs Claude Code and Codex conversations. The tools only read: they never write to a conversation or open an app. Nothing leaves your Mac.

Install it from magpie's **Plugins › Discover**, or with:

```sh
magpie plugin add @magpie-community/tools-ccx
magpie plugin            # lists its tools
```

It needs ccx (macOS, with the Claude and/or Codex desktop app):

```sh
curl -fsSL https://raw.githubusercontent.com/aaronwong1999/ccx/main/install.sh | sh
```

Without it, the tools answer with that install line. The package looks for `ccx` in `$CCX_BIN`, then `~/.local/bin/ccx`, then the `PATH`.

magpie serves the tools on its MCP server, `/mcp/magpie/tools`, as `ccx_sessions` and `ccx_read`.

## Tools

**`sessions`** `{app, query?, cwd?}` lists `claude` (Claude Code) or `codex` (Codex) conversations, newest first: each one's id, title, date, folder, and whether it is linked to the other app. `query` searches titles in every project. `cwd` marks the ones in that folder.

```
Claude sessions, newest first:
1. “Fix the login bug” 10-23 17:29 · not linked · id=bd299fd9-…
```

**`read`** `{app, session_id, offset?}` reads one conversation as condensed text: the messages, each tool call and its result in short, and the plan. It answers `{title, cwd, text, offset, next_offset, total_chars}` in pages of about 6000 characters. When `next_offset` is below `total_chars`, read again with `offset` set to it.

```
{"title":"Fix the login bug","cwd":"/Users/me/app","text":"[user] the login form 500s …","offset":0,"next_offset":6000,"total_chars":52138}
```

## Test

```sh
bun test packages/ccx
```

The test runs a stand-in `ccx` script, so it needs neither ccx nor a Mac.

中文：让 magpie 连接的每个 agent 都能读 Claude Code 和 Codex 的对话：`sessions` 列出对话，`read` 分页读取一段对话的精简内容（消息、工具调用摘要、计划），换一个 agent 或模型也能接着干，不用重新解释任务。通过开源工具 [ccx](https://github.com/aaronwong1999/ccx) 读取，只读不写，不出本机。需要 macOS 和 Claude 或 Codex 桌面版。
