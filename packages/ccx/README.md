# @magpie-community/tools-ccx

Claude Code and Codex conversations, as tools [magpie](https://usemagpie.ai) offers every agent it connects. When a task was started in Claude Code or Codex and you want to carry it on with another agent or model in magpie, the agent can find that conversation and read it, instead of you explaining the task again.

Install it from magpie's **Plugins › Discover**, or with:

```sh
magpie plugin add @magpie-community/tools-ccx
magpie plugin            # lists its tools
```

magpie serves the tools on its MCP server, `/mcp/magpie/tools`, as `ccx_sessions`, `ccx_read`, `ccx_allow` and `ccx_state`.

## What leaves your Mac

**A conversation that these tools return is sent to the model that asked for it**, through magpie's MCP server. The tools do not write to a conversation and do not open an app, but what they read is not private to your Mac: it goes to whichever provider serves the model on the other end, and it does not pass through magpie's redaction.

So the package asks first. **Nothing is listed and nothing is read until you allow it.** You allow a project folder or a single conversation, and the choice is kept in this package's own state file (`~/.config/magpie/tools-ccx.json`):

```sh
magpie plugin allow-ccx project /Users/me/app
magpie plugin allow-ccx conversation 01a1e3b1-7071-7731-ae71-c5b64dfbd374
```

`ccx_allow` does the same thing from inside a conversation, once you have asked for it. `ccx_state` shows what is allowed right now.

## How it reads

**Claude Code** transcripts are read from the plain JSONL the app writes under `~/.claude/projects/<project>/`. That code is in this package, so it is reviewed here, and it needs nothing installed.

**Codex** threads are read through Codex's own app-server: the same JSON-RPC interface the Codex desktop app talks to, over the `codex` CLI the app bundles. No thread format is parsed here and no code of ours sits in the read path. It needs the Codex app (or `codex` on the `PATH`); set `CCX_CODEX_BIN` to point at a different binary.

## Tools

**`sessions`** `{app, query?, cwd?}` lists `claude` (Claude Code) or `codex` (Codex) conversations you have allowed, newest first: each one's id, title and folder. `query` searches titles. `cwd` narrows to one folder.

```
Claude sessions, newest first:
1. “Fix the login bug” · /Users/me/app · id=bd299fd9-…
```

**`read`** `{app, session_id, offset?}` reads one conversation as condensed text: the messages, each tool call and its result in short, and the plan. It answers `{title, cwd, text, offset, next_offset, total_chars}` in pages of about 6000 characters. When `next_offset` is below `total_chars`, read again with `offset` set to it.

```
{"title":"Fix the login bug","cwd":"/Users/me/app","text":"[user] the login form 500s …","offset":0,"next_offset":6000,"total_chars":52138}
```

**`allow`** `{scope, target}` allows a `project` (a folder) or a `conversation` (an id).

**`state`** `{}` answers the projects and conversations allowed right now.

## Test

```sh
bun test packages/ccx
```

The test runs against a fake home and recorded answers from both sides, so it needs neither Claude Code nor Codex.

中文：让 magpie 连接的每个 agent 都能读 Claude Code 和 Codex 的对话：`sessions` 列出对话，`read` 分页读取一段对话的精简内容（消息、工具调用摘要、计划），换一个 agent 或模型也能接着干，不用重新解释任务。**读到的对话会发给提问的模型**，所以默认什么都不读——需要你手动允许某个项目目录或某一条对话（`magpie plugin allow-ccx project <folder>`），选择记在 `~/.config/magpie/tools-ccx.json`。Claude Code 的记录由本包直接读 `~/.claude/projects` 下的 JSONL；Codex 走它自带的 app-server API。只读不写，不打开任何 App。
