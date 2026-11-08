# Rhino 9 AI agent for Magpie

Adds **Rhino 9 AI** to Magpie's Agents page. Selecting a model writes a dedicated
JSON connection file read by the Windows
[RhinoMagpie launcher](https://github.com/mikidaren/rhino9-magpie).

## Requirements and use

- Windows x64, Rhino 9 with its built-in AI panel, native Claude Code, and Magpie.
- Download the launcher from the project's GitHub Releases and run `install.ps1`
  first. It creates the directory Magpie uses to detect this integration.
- Install this folder with `magpie plugin add /path/to/plugin`.
- Pick a model in Magpie's **Rhino 9 AI** row.
- Open Rhino with `RhinoMagpie.exe`, then select **Claude / Opus (latest)** in
  Rhino's AI settings.

This is a process-environment bridge through Rhino's existing Claude agent,
not a new Rhino agent implementation. Model changes require closing the launched
Rhino and opening it again with the launcher. A normal Rhino launch does not
receive this plugin's gateway environment. Use the latest Opus, Sonnet or Haiku
alias in Rhino; pinned version names bypass those alias mappings.

## Configuration ownership

Magpie owns `model`, `baseUrl`, and `apiKey` in
`~/.config/rhino9-magpie/settings.json`, restoring their previous values when
disconnected. Other keys remain untouched. The key belongs to the `rhino9-ai`
agent so its requests can be attributed separately. No provider accounts are
read by this plugin, and it has no runtime, timers, dependencies or install hooks.

The companion launcher is required. It accepts only a local HTTP Magpie gateway
in this release and uses a separate Claude configuration directory. The plugin
alone does not alter Rhino's settings or launch Rhino. Disconnect before removing
the plugin; close any launched Rhino process to stop using its inherited config.
Local config holds a gateway credential and must not be shared.

## 中文

在 Magpie 的 Agent 页添加 **Rhino 9 AI**。选好模型后，用配套的 Windows
启动器打开 Rhino，在原生 AI 面板选择 **Claude / Opus (latest)** 即可。
Claude Code 负责代理与工具调用，请求经 Magpie 使用所选模型。

需要安装 Rhino 9、原生 Claude Code、Magpie，以及本项目 Release 中的启动器。
先运行 Release 里的 `install.ps1` 创建检测目录，再安装插件和选择模型。
切换模型后需要重新通过启动器打开 Rhino。当前仅支持本机 HTTP 网关。
插件只管理专用 JSON 中的三个连接字段，断开会恢复原值；卸载前先断开，
已打开的 Rhino 则需要关闭才能清除继承的连接环境。

## Development

The standalone repository tests the descriptor with Node's built-in test runner
and the launcher with .NET checks. See the repository for CI and validation.

MIT. Unofficial integration, not affiliated with McNeel or Anthropic.
