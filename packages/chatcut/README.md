# ChatCut Desktop

Adds **ChatCut** to Magpie's Agents page. Choose a model or routing group there,
then choose **Magpie Use** in ChatCut Desktop and start a new chat.

Requires the ChatCut Desktop release containing Magpie Use. Earlier versions do
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

Model changes apply to new chats. Existing chats remain bound to their running
configuration; after a restart a changed connection requires a new chat rather
than silently resuming against a different connection. Disconnect in Magpie to
restore the fields the plugin changed. New Magpie Use sessions require a valid
connection; there is no automatic fallback to another model service.

## 中文

在 Magpie 的 Agent 页增加独立的 **ChatCut** 条目。选择模型或路由组后，在
ChatCut 桌面端选择 **Magpie Use** 并开始新对话。需要支持此入口的 ChatCut 版本；
插件本身不安装或升级 ChatCut。

配置仅写入 `~/.config/chatcut/magpie.json`。首版固定使用 ChatCut 自带的 Codex
harness，模型由 Magpie 管理；不修改终端 Codex 的设置或登录。修改模型后开始新对话。
生图、视频生成等工具仍按各自服务的要求和计费方式运行。
