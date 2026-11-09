# Magpie-Rhino

Use Magpie models, custom groups and routing strategies in a native dockable
**Magpie** panel inside Rhino 9. The companion Rhino plugin runs its own agent loop
and calls Rhino's built-in MCP tools to inspect and create native geometry.

## Install

1. Install Rhino 9 on Windows and run Magpie.
2. Install the companion Rhino `.yak` package, or extract the companion ZIP and
   run `install-panel.ps1`. Restart Rhino once. The plugin creates its detection
   directory on startup without writing connection credentials.
3. Install from Magpie's Plugins page or run
   `magpie plugin add @magpie-community/agent-rhino9-ai`.
4. Connect **Magpie-Rhino** in Magpie's Agents page and select a model or group.
5. Open Rhino's AI panel normally and choose **Magpie** from its agent menu.
   No command is required.

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

配套 Rhino 插件在原生 AI 面板中提供 **Magpie** 入口，支持自然语言建模、Rhino MCP、
视口图片反馈、工具确认、停止和按文档分别保留对话。

先安装配套 `.yak` 包，或运行 ZIP 内的 `install-panel.ps1`，然后重启 Rhino。
Rhino 插件会自动创建检测目录，无需先选择模型。再从 Magpie 的插件页安装，
或运行 `magpie plugin add @magpie-community/agent-rhino9-ai` 并连接。
正常打开 Rhino 的 AI 面板即可选择 **Magpie**，无需输入命令。每次发送都会读取 Magpie 当前的模型、
自定义组和策略，组 ID 会原样传给 Magpie，由 Magpie 负责路由。

初次使用默认为逐次修改确认。也可开启 YOLO 自动执行，选择会跨新对话、文档和 Rhino 重启保留。
执行偏好单独存放在 `~/.config/rhino9-magpie/panel-preferences.json`，不包含连接密钥。
支持 Windows x64、Rhino 9 和本机 HTTP Magpie 网关。模型需要支持工具调用。
建模结果仍需检查，复杂建筑任务和所有模型的兼容性尚需进一步验证。

The MCP listener started when needed remains available until its Rhino document
or session closes. Other processes on the same computer can use that local
interface to invoke Rhino tools and scripts. Listener discovery uses an internal
RhinoAI API with a public `MCPStart` fallback, so Rhino updates need a compatibility
check.

## Checks

Run `bun test packages/rhino9-ai` and `bun scripts/check.mjs rhino9-ai`
from the community repository root.

Source and releases are maintained at https://github.com/mikidaren/Magpie-Rhino.
MIT. Unofficial community integration.
