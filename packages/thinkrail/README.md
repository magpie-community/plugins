# ThinkRail for Magpie

Choose the default model for new ThinkRail chats on Magpie’s Agents page. Magpie keeps its gateway model catalog in sync and lets you assign MCP servers from Library.

## Install and use

From a checkout of this repository, run `magpie plugin add ./packages/thinkrail` and keep that directory in place. In **Agents → ThinkRail**, select a model, reopen ThinkRail, and start a new chat. Existing chats keep their own model.

Both this plugin and crafthei’s connect-only plugin register the agent ID `thinkrail`. The connect-only plugin supplies a catalog and leaves model selection to ThinkRail’s picker. Use this package to set the new-chat default in Magpie and assign Library MCP servers. Disconnect and disable the active plugin before switching between them. [crafthei’s plugin](https://github.com/crafthei/magpie-agent-thinkrail)

## Files and restoration

| File in the default desktop setup | What Magpie manages |
|---|---|
| `~/.pi/agent/models.json` | The whole `providers.magpie-thinkrail` entry, with the gateway URL, agent key and model catalog |
| `~/.thinkrail/config.json` | The `defaultModel` ID, provider, name and thinking levels used for new chats |
| `~/.pi/agent/mcp.json` | MCP servers assigned to ThinkRail in Library |

Other pi clients sharing `~/.pi/agent` can see the provider and MCP servers. Custom data directories require different paths in `thinkrail.agent.js`.

Before removing the plugin, turn off the ThinkRail connection on the Agents page or run `magpie thinkrail default` to restore the previous provider entry and default-model fields. Unassign MCP servers separately in Library. Give each assignment a name distinct from any manually configured server. Magpie 0.1.4408 overwrites a manual entry with the same name and deletes it on unassignment. Back up an existing entry before reusing its name.
