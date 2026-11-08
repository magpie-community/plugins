# Rhino 9 · Magpie

Use Magpie models, custom groups and routing strategies in a native dockable
**Magpie** panel inside Rhino 9. The companion Rhino plugin runs its own agent loop
and calls Rhino's built-in MCP tools to inspect and create native geometry.

## Install

1. Install Rhino 9 on Windows and run Magpie.
2. Download `RhinoMagpie-panel-win-x64.zip` from the companion repository releases.
   Extract it and run `install-panel.ps1`. Restart Rhino after installation.
3. Install this Magpie plugin with `magpie plugin add /path/to/plugin`.
4. Connect **Rhino 9 · Magpie** in Magpie's Agents page and select a model or group.
5. Open Rhino normally and run the `Magpie` command.

The panel follows Magpie's configured selection on each new turn. Refresh its
catalog to optionally select a different model or routing group for that panel.
Leave **跟随 Magpie 当前模型 / 自定义组** selected to follow Magpie.

The Magpie plugin manages `model`, `baseUrl` and `apiKey` in
`~/.config/rhino9-magpie/settings.json`. Disconnect restores the previous keys.
The panel checks that file at the start of every turn. Credentials already sent
with an in-flight request remain effective for that request.

The two installations provide the Magpie connection and Rhino UI respectively.
This descriptor has no install hook or background runtime. Requests are attributed
to the distinct `rhino9-ai` gateway identity. Keep the local connection file private.

## 中文

配套 Rhino 插件提供独立的 **Magpie** 面板，支持自然语言建模、Rhino MCP、
视口图片反馈、工具确认、停止和按文档分别保留对话。

先安装 Release 内的 `.yak` 配套包，再在 Magpie 安装此插件并连接。
在 Rhino 输入 `Magpie` 即可打开面板。每次发送都会读取 Magpie 当前的模型、
自定义组和策略，组 ID 会原样传给 Magpie，由 Magpie 负责路由。

初次使用请保留默认的逐次修改确认，也可主动勾选会话内自动执行修改。
支持 Windows x64、Rhino 9 和本机 HTTP Magpie 网关。模型需要支持工具调用。
建模结果仍需检查，复杂建筑任务和所有模型的兼容性尚需进一步验证。

Source and releases are maintained at https://github.com/mikidaren/rhino9-magpie.
MIT. Unofficial community integration.
