# agy-tui

用 agy 自己的交互界面（TUI）跑 Antigravity 的模型。每个请求都会在 magpie 提供的终端里（`magpie tui-helper`）启动真正的 `agy`，像人一样把对话粘贴进它的输入框，再从 agy 自己写的对话记录里读出回答。插件本身不调用 Google 的任何接口，全部由 agy 完成，和人在 agy 的提示符前打字一样。

**[English → README.en.md](README.en.md)**

## 用法

1. 安装 [Antigravity CLI](https://antigravity.google/docs/cli)（`agy`）。
2. 在 magpie 的插件页安装本插件，然后在 Providers 里添加 **Antigravity (agy TUI)**，选「使用 Google 登录」：magpie 打开 agy 的登录链接，把页面上显示的代码粘贴回来即可。
3. 模型列表来自 `agy models`。

每个账号都有自己的 home（`~/.local/state/magpie-agy-tui/accounts/<id>`），agy 的登录信息以文件形式存在那里。你自己的 `~/.gemini`、skills 和 MCP 服务器都不会被用到，也不会被改动。

## 限制（v0.1）

- 只有文本：调用方的工具不会交给模型，图片和工具结果会被拒绝（400）。
- 每个请求都是一次新的 agy 会话，之前的对话会整理成文字一起粘贴进去。
- 回答在一轮结束后一次性返回（流式请求会先收到心跳，再收到完整回答）。
- 需要 magpie v0.1.5027 或更新（带 `tui-helper`）。Windows 尚未测试。

## 选项（环境变量）

- `AGY_PATH`：agy 的路径。
- `AGY_TUI_TURN_TIMEOUT_MS`：一轮的最长时间，默认 15 分钟。
- `AGY_TUI_KEEP=1`：保留每轮的临时目录和 agy 的对话记录，方便排查。
