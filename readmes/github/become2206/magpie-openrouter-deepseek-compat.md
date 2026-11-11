# Magpie · OpenRouter DeepSeek 兼容插件

这个插件用于 **Magpie 经 OpenRouter 调用 DeepSeek** 时的消息格式兼容，适用于 Claude Code、Claude 桌面版 Code 等发送 Anthropic Messages 请求的客户端。

在多轮工具调用中，部分消息的思考块可能缺少 `signature` 字段，导致 OpenRouter 返回 `400 Invalid Anthropic Messages API request`。插件会在请求转发前补齐这个字段；需要占位思考块时，加入带空签名字段的占位块，让后续工具调用和回复能够继续。

插件主要做三件事：

- 为缺少签名字段的思考块补上 `signature: ""`。
- 为符合条件的工具调用及后续消息补入格式兼容所需的空白思考块。
- 保留已有的思考内容、签名、工具调用和工具结果，不生成新的推理内容。

它只处理 **OpenRouter → DeepSeek 的 Anthropic Messages 请求**，匹配 `deepseek/` 开头的模型 ID，以及插件中明确列出的自定义预设。其他供应商、模型和协议的请求保持原样。

本插件针对的是上述字段缺失场景，不处理其他原因造成的 400 错误。
