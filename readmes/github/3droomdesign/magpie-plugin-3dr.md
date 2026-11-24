# 3DR Media Design for Magpie

[简体中文](README.zh-CN.md)

Give your agent image and video generation, with specialized tools for architectural renders, interior design and floor plans. Connect a room photo to an interior redesign workflow, render a concept sketch, or turn a still into a short design video. Magpie offers the tools you authorize to your MCP-compatible agent.

## Install and connect

If your agent can run commands on this computer, send it this instruction:

> Install the 3D Room Design plugin for Magpie from https://github.com/3droomdesign/magpie-plugin-3dr using its README. Open the website for me to authorize if needed, connect the plugin tools to this agent, and check the connection by quoting one interior image. Stop after the quote.

On the computer that runs Magpie, use Node.js 22 or newer, npm and Git to install the 3dr CLI. Run these commands in your terminal. The login opens the 3D Room Design website, where you choose which tools to allow and how credits may be spent. If the same CLI profile is already connected, skip the login.

```sh
npm install --global git+https://github.com/3droomdesign/3droomdesign-mcp.git
3dr login
magpie plugin add github:3droomdesign/magpie-plugin-3dr
magpie tools
```

In Magpie, **Settings → Plugins** shows the installed plugin and its tool names. Copy the **Plugin tools** MCP address into your agent’s Streamable HTTP MCP settings. On a default local installation the address is `http://127.0.0.1:3425/mcp/magpie/tools`. Restart or reconnect the agent if it caches its tool list.

Ask your agent to try this first:

> Show me the 3DR presets for an interior redesign. Quote one image of a daylit reading room and tell me the maximum credits before generating it.

A quote is free. To generate, submit the chosen parameters with a unique `request_id` and keep the returned `run_id`. An approval request includes a link to the site. Poll `get_run` for the result, then use `get_result` to inspect the asset. After an interruption, retry the same generation with its original parameters and `request_id`. To save an original to disk, run `3dr download <asset_ref> <destination>` on the computer with the authorization.

## Profiles and troubleshooting

To start from a local photo or sketch, run `3dr upload ./room.jpg` and give the returned asset reference to your agent. With a named profile, use the same profile for uploads and downloads, for example `3dr --profile design upload ./room.jpg`.

* **Only connection status is listed.** Run the plugin’s `connection_status` tool for the reason. Confirm `3dr tools` lists the tools under the same profile and site. After login, a permission change or a resolved connectivity issue, switch the plugin off and on in Magpie, then refresh the agent’s tools.
* **Separate account or environment.** Production is the default. To select an existing device grant, run `3dr login --profile=design` and `magpie plugin options magpie-plugin-3dr '{"profile":"design"}'`. For a different site, set `THREEDR_SITE_ORIGIN` for login and for the Magpie process, or set the plugin’s `siteOrigin` option to that same origin. Options are edited together as a JSON object.
* **Magpie can't find a working CLI.** This can happen when the desktop app and terminal use different paths. Run `3dr config` in your terminal. In the plugin options set `nodePath` to the absolute `command` value and `cliPath` to the absolute first entry in `args`. Keep any profile and site options you use. On Windows these are the Node executable and the 3dr JavaScript entry point.
* **Update.** Run `3dr update` for the CLI. Magpie’s plugin update action refreshes installed plugins.

## Authorization

The plugin uses the 3dr CLI’s local credential store. Manage the grant and its budget in **Account → MCP connections** on the site. Everyone allowed to call these tools on a shared Magpie gateway uses the configured 3dr grant, so keep this gateway local or restrict its clients to people you trust with that grant. The adapter adds no telemetry.

[3dr CLI](https://github.com/3droomdesign/3droomdesign-mcp) · [Magpie plugin guide](https://usemagpie.ai/docs/plugins) · [License](LICENSE)
