# ChatCut Desktop

Adds **ChatCut** to Magpie's Agents page. Choose a model or routing group there,
then choose **Magpie** in ChatCut Desktop and start a new chat. New chats follow
that default. ChatCut's model menu can also start a new chat with a specific model
or routing group from Magpie, without changing Magpie's default or existing chats.

Requires the ChatCut Desktop release containing the Magpie agent entry. Earlier versions do
not read this configuration. This plugin does not install or upgrade ChatCut.
ChatCut creates `~/.config/chatcut` when it starts, which makes the agent visible.

```sh
magpie plugin add @magpie-community/agent-chatcut
```

The plugin writes only `~/.config/chatcut/magpie.json`: the selected `model`,
`version: 1`, the gateway's `/v1` `baseUrl`, ChatCut's gateway `apiKey`, and the
model's `contextWindow` when known. A gateway key is not a vendor subscription
credential. No credentials are read by this plugin and no request is sent by it.

ChatCut runs its bundled Codex harness with a separate private configuration and
conversation history. This connection does not change terminal Codex settings,
logins or other clients. The harness is fixed to Codex in this first version;
the selected model can come from any compatible Magpie provider. ChatCut supplies
its own project tools and skills. Media-generation tools retain their own service
requirements and billing.

ChatCut stores explicit model choices in its own per-chat settings; this plugin
continues to own only the shared connection and default model. Model changes
apply to new chats. Existing chats retain their accepted connection
when ChatCut restarts their agent process, refreshes MCP tools or retries a failed
refresh. After restarting ChatCut, a changed connection requires a new chat rather
than silently resuming against a different connection. Disconnect in Magpie to
restore the fields the plugin changed. New Magpie sessions require a valid
connection; there is no automatic fallback to another model service.

## 中文

在 Magpie 的 Agent 页增加独立的 **ChatCut** 条目。选择模型或路由组后，在
ChatCut 桌面端选择 **Magpie** 并开始新对话。需要支持此入口的 ChatCut 版本；
插件本身不安装或升级 ChatCut。

配置仅写入 `~/.config/chatcut/magpie.json`。首版固定使用 ChatCut 自带的 Codex
harness，默认模型由 Magpie 管理；不修改终端 Codex 的设置或登录。ChatCut 的模型菜单
默认“跟随 Magpie”，也可以从 Magpie 目录选择模型或路由组并开始新对话，不改变
Magpie 默认值或已有对话。显式选择保存在 ChatCut 的逐对话设置中，插件仍只维护
共享连接及默认模型。修改模型后开始新对话。
已经启动的对话在刷新 MCP 工具或重试进程启动时继续使用原连接；重启 ChatCut 后，
如果连接已变化，需要开始新对话。
生图、视频生成等工具仍按各自服务的要求和计费方式运行。
