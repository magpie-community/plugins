# Grok X Search Bridge

让通过 Magpie 使用的 Grok 模型可以搜索 X（Twitter）。支持 Responses、Chat Completions、Anthropic Messages 和 Gemini 接口，客户端无需单独声明搜索工具，也无需另外填写密钥。

适用于 Magpie 的 Grok（SuperGrok / Grok Build）供应商，不限定单个模型版本。插件复用已有 Grok 登录、账号额度和模型列表。

## 安装

在 Magpie「插件 → 添加」中输入：

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

安装后，让本插件承载 `grok` 供应商：

```bash
magpie plugin use @magpie-community/middleware-grok-x-search-bridge grok
```

Docker 用户在这条命令前加 `docker exec magpie`。也可以在 Magpie 插件页面选择由本插件承载 Grok。已有账号无需重新登录；没有账号时，在 Grok 供应商中登录。

安装在实际提供 Grok 模型的 Magpie 实例上。如果本机 Magpie 连接的是远程 Magpie，请安装在远程实例。

## 使用

1. 在 Magpie 配置并启用 Grok 供应商，供应商 ID 使用 `grok`。
2. 在客户端中选择 Grok 模型，或选择包含 Grok 的路由。
3. 直接提出需要查询 X 的问题，例如：

   > 搜索 X 上 @OpenAI 最近发布的帖子，给我原帖链接、发布时间和摘要。

符合自动工具选择条件的请求都会附带搜索工具，是否调用由 Grok 根据问题决定。普通问答不一定搜索；实际搜索可能增加耗时和额度消耗。

## 支持范围

| 使用方式 | 自动启用 X 搜索 |
| --- | --- |
| Grok 供应商，Responses 接口 | 支持 |
| Grok 供应商，Chat Completions 接口 | 支持 |
| Grok 供应商，Anthropic Messages 接口 | 支持 |
| Grok 供应商，Gemini 接口 | 支持 |
| Cursor 中的 Grok 模型 | 暂不支持 |
| 第三方聚合平台中的 Grok 模型 | 未验证 |

四种接口均支持流式和非流式。客户端继续使用原接口，由 Magpie 完成转换。

已验证 Grok 4.7、Grok 4.7 Fast、Grok 4.6、Grok 4.5，以及各自的 500k 上下文版本可以搜索 X。模型是否可用仍取决于账号和上游服务。

## 工具控制

- 保留客户端已有的函数工具、网页搜索工具及推理设置。
- 已配置 X 搜索工具时，保留原有账号筛选、日期范围等参数，不重复添加。
- 未指定工具选择或使用 `auto` 时，允许自动补上 X 搜索。
- 明确禁用工具、要求调用指定工具或限制工具范围时，保持客户端设置。
- 明确禁用工具时，即使问题要求搜索，也不会自动添加 X 搜索。

## 常见问题

**安装后没有搜索结果？**

确认插件已启用，并已选择由本插件承载 `grok` 供应商。普通问题不一定触发搜索，可以明确要求搜索 X；客户端不能同时禁用工具或指定其他工具。

**为什么 Cursor 中的 Grok 不能使用？**

Cursor 的工具接口与原生 Grok 接口不同。目前插件适用于直接连接的 Grok 供应商。

**从 0.1.0 升级后需要做什么？**

在 Magpie 插件页面更新本插件，再选择由本插件承载 `grok` 供应商。0.2.0 增加了供应商插件，不能只替换旧版的中间件文件。

**本机和服务器都要安装吗？**

安装在最终连接 Grok 的实例上即可。本机只作为远程连接入口时，无需重复安装。

## 停用与卸载

```bash
magpie plugin off @magpie-community/middleware-grok-x-search-bridge
magpie plugin on @magpie-community/middleware-grok-x-search-bridge
magpie plugin rm @magpie-community/middleware-grok-x-search-bridge
```

Docker 用户在命令前加 `docker exec magpie`。

如果希望停用搜索后继续使用普通 Grok 聊天，请保持原来的 Grok 登录插件已安装并启用。停用本插件后，原插件会继续承载 Grok。

[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) · [问题反馈](https://github.com/vectorisvector/magpie-grok-x-search-bridge/issues)

MIT 许可证。
