# @magpie-community/agent-qwen-mcp

[Qwen Code](https://github.com/QwenLM/qwen-code) as a magpie Library target.
magpie's built-in Qwen Code adapter manages models and instructions but has no
user-wide place for MCP servers or skills, so Library resources cannot be ticked
for it. This package adds a second agent, `qwen-mcp`, whose Library MCP file is
Qwen Code's own `~/.qwen/settings.json` and whose skills folder is
`~/.qwen/skills`.

```sh
magpie plugin add @magpie-community/agent-qwen-mcp
```

Then, in the Library page, tick the MCP servers and skills you want on the
**Qwen Code (MCP)** row (or `magpie library mcp agents <name> …,qwen-mcp` /
`magpie library skill agents <name> …,qwen-mcp`). magpie writes servers into
`~/.qwen/settings.json` in the `claude` shape (`{type, url, headers}` for HTTP,
`{type, command, args, env}` for stdio — both accepted by Qwen Code) and skills
into `~/.qwen/skills`. Restart Qwen Code to load new MCP servers; skills
hot-reload.

Models stay on the built-in **Qwen Code** row — this package writes no model
settings (`connect` returns `{}`).

A removable bridge: once magpie supports Qwen Code MCP and skills natively,
untick `qwen-mcp` from every server and skill **while the package is still
installed** (so magpie can take the entries back out), then
`magpie plugin rm @magpie-community/agent-qwen-mcp` and re-tick them on the
built-in row.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).