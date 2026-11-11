# magpie-agent-minimax-design

[MiniMax Design](https://design.minimax.io)（本地多模态创作工作室，Electron 应用，内部代号 `@hilo`）作为 [Magpie](https://usemagpie.ai) 的 Agent。MiniMax Design 支持以 OpenAI 兼容 / OpenAI Responses / Anthropic 三种协议接入自定义文本模型，而 Magpie 网关三种协议都能翻译——所以在 Magpie 的 Agents 页打开一个开关，就能把 Design 指到 Magpie。

```sh
magpie plugin add github:Purfeather/magpie-agent-minimax-design
```

使用前先**退出 MiniMax Design**，在 Magpie 的 Agents 页打开 MiniMax Design 行的开关，再启动 Design，在其模型菜单的 **Magpie** 条目下选模型。在 Magpie 断开后会移除写入的条目，Design 配置的其他内容不受影响。

## 工作原理

Design 的自定义模型落盘在 `%APPDATA%\@hilo\desktop\hub-config.json`（Windows）的 `config.customModels.<id>`：

```json
{
  "protocol": "openai-compatible",
  "providerName": "Magpie",
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKey": "magpie-minimax-design",
  "models": [{ "id": "...", "contextWindow": 1000000, "maxOutputTokens": 65536, "reasoningLevels": ["low", "high"] }]
}
```

本插件是开关型 Agent 插件（无模型选择器：Design 在自己的 UI 里选模型）。接通时只写入一个条目 `config.customModels.user-custom-magpie`——baseUrl 与 Design 专属 key（Usage 按此归属请求），以及由 Magpie 当前模型列表映射出的 `models`（id / contextWindow / maxOutputTokens / reasoningLevels）。Magpie 模型变化时会重调 connect，该列表自动刷新。断开时逐键还原，文件中其他条目与设置不会被触碰。

## 注意

- 切换前退出 Design：运行中的 Design 会把内存配置回写覆盖文件；切换后重启 Design 生效
- Design 接受非 UUID 的条目 id `user-custom-magpie`（3.0.17 已验证）
- 验证记录见 [COMPATIBILITY.md](COMPATIBILITY.md)

Agent 插件开发文档：[usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents)。
