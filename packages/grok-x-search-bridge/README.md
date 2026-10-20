# Grok X Search Bridge

让通过 Magpie 使用的 Grok 模型可以搜索 X（Twitter）。插件会自动补上原生 X 搜索工具，客户端无需单独声明，也无需另外填写密钥。

适用于 Grok 供应商下支持原生 X 搜索的模型，不限定 Grok 4.7。

## 安装

在 Magpie「插件 → 发现 → 网关中间件」中搜索 Grok X Search Bridge，或在「插件 → 添加」中输入：

```text
@magpie-community/middleware-grok-x-search-bridge
```

也可以通过命令行安装：

```bash
magpie plugin add @magpie-community/middleware-grok-x-search-bridge
```

Docker 用户：

```bash
docker exec magpie magpie plugin add @magpie-community/middleware-grok-x-search-bridge
```

安装在实际提供 Grok 模型的 Magpie 实例上。如果本机 Magpie 连接的是远程 Magpie，请安装在远程实例。

## 使用

1. 在 Magpie 配置并启用 Grok 供应商，供应商 ID 使用 `grok`。
2. 在 Codex 等使用 Responses 接口的客户端中选择 Grok 模型，或选择包含 Grok 的路由。
3. 直接提出需要查询 X 的问题，例如：

   > 搜索 X 上 @OpenAI 最近发布的帖子，给我原帖链接、发布时间和摘要。

插件提供搜索工具，是否调用由 Grok 根据问题决定。搜索仍使用已有 Grok 账号的额度或 API 用量。

## 支持范围

| 使用方式 | 自动启用 X 搜索 |
| --- | --- |
| Grok 供应商，Responses 接口 | 支持 |
| Grok 供应商，Chat Completions 接口 | 暂不支持 |
| Grok 供应商，Anthropic 接口 | 暂不支持 |
| Grok 供应商，Gemini 接口 | 暂不支持 |
| Cursor 中的 Grok 模型 | 暂不支持 |

“暂不支持”仅表示本插件不会自动补上 X 搜索工具，原有聊天与客户端工具仍按 Magpie 的方式运行。

## 工具控制

- 保留客户端已有的函数工具、网页搜索工具及推理设置。
- 已配置 X 搜索工具时，保留原有账号筛选、日期范围等参数，不重复添加。
- 未指定工具选择或使用 `auto` 时，允许自动补上 X 搜索。
- 明确禁用工具、要求调用指定工具或限制工具范围时，保持客户端设置。
- 支持流式和非流式 Responses 请求。

## 常见问题

**安装后没有搜索结果？**

确认插件已启用、所选模型属于 Grok 供应商、供应商 ID 为 `grok`，且客户端使用 Responses 接口。上游模型需要支持原生 X 搜索；普通问题不一定触发搜索，可以在提问中明确要求搜索 X。

**为什么 Cursor 中的 Grok 不能使用？**

Cursor 的工具接口与原生 Grok 接口不同。目前插件适用于直接连接的 Grok 供应商。

**本机和服务器都要安装吗？**

安装在最终连接 Grok 的实例上即可。本机只作为远程连接入口时，无需重复安装。

## 停用与卸载

```bash
magpie plugin off grok-x-search-bridge
magpie plugin on grok-x-search-bridge
magpie plugin rm grok-x-search-bridge
```

Docker 用户在命令前加 `docker exec magpie`。

[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) · [问题反馈](https://github.com/vectorisvector/magpie-grok-x-search-bridge/issues)

MIT 许可证。
