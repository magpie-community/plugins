# agent-qwen-mcp

A [Magpie](https://usemagpie.ai) agent plugin that lets the Magpie Library sync
MCP servers **and skills** into **Qwen Code**, with the Qwen icon.

Magpie's built-in Qwen Code adapter manages models and instructions but has no
user-wide MCP or skills target, so Library resources cannot be ticked for it.
Qwen Code reads MCP servers from `mcpServers` in `~/.qwen/settings.json` and
skills from `~/.qwen/skills`. This plugin registers an extra agent, `qwen-mcp`,
whose Library MCP file is that same `settings.json` (written in the `claude`
shape: `{type, url, headers}` for HTTP, `{type, command, args, env}` for stdio —
both accepted by Qwen Code) and whose skills folder is `~/.qwen/skills`.

## Install

```sh
magpie plugin add github:Andykpa/agent-qwen-mcp
```

## Use

In Magpie's Library page, tick the MCP servers and skills you want on the
**Qwen Code (MCP)** row (or `magpie library mcp agents <name> …,qwen-mcp` /
`magpie library skill agents <name> …,qwen-mcp`). Magpie writes servers into
`~/.qwen/settings.json` and skills into `~/.qwen/skills`; restart Qwen Code to
load them.

Models stay on the built-in **Qwen Code** row — this plugin writes no model
settings.

## Remove

Once Magpie supports Qwen Code natively, first untick this agent from every
server **and skill** while the plugin is still installed (so Magpie can take
the entries back out of `settings.json` and `~/.qwen/skills`), then remove the
plugin:

```sh
# for each server/skill ticked for qwen-mcp, drop qwen-mcp from its agents, e.g.
magpie library mcp agents anysearch opencode,qoder-cn
magpie library skill agents find-skills opencode
magpie plugin rm agent-qwen-mcp
```

Then re-tick them on the built-in Qwen Code row. (Unticking after the plugin is
already removed cannot locate the file, so untick first.)