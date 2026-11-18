# Responses 跨资源修复

Magpie 插件，用于缓解 OpenAI Responses API 的跨资源错误。`0.3.0` 在供应商编辑页增加 Codex 请求头开关，覆盖模型查询、普通对话和 Magpie 压缩摘要。供应商模式复用 Magpie 的多账号与路由机制，每个 API Key 保存为一个独立账号。

```text
The requested item was created under a different Azure OpenAI resource.
Use the same resource that created the item to access it.
```

| 用法 | 接入方式 | 覆盖范围 |
| --- | --- | --- |
| 供应商模式 | 登录「AgentRouter 修复」，选择 `agentrouter-shim/模型名` | 该供应商实际收到的 Responses 请求，包括 Magpie 内部的压缩摘要请求 |
| 中间件模式 | 使用原有 `agentrouter/模型名` | 经过 `onProvider` 的客户端请求，适合继续使用原有配置 |

需要修复上下文压缩时，使用供应商模式。清理发生在供应商发送上游请求的 `fetch` 中。

```text
普通对话 / Magpie 压缩摘要 → AgentRouter 修复供应商 → 清理 → AgentRouter
```

## 安装

在 Magpie 的「插件 → 添加插件」中填写仓库地址，或运行以下命令。

```sh
magpie plugin add github:JinPen-G/magpie-responses-shim
```

已安装旧版时，在 Magpie 的插件页面更新本插件。然后完成以下设置。

1. 在「AgentRouter 修复」供应商中填写自己的 AgentRouter API Key，或执行 `magpie plugin login agentrouter-shim`。登录信息由 Magpie 保存在配置目录的 `plugin-auth.json`。
2. 打开「供应商 → AgentRouter 修复 → 插件选项」。上游检查 Codex 客户端信息时，开启「对话请求带 Codex 头」。「查询模型时带 Codex 头」默认开启。首次使用的身份头准备方法见下节。
3. 选择该供应商列出的 `agentrouter-shim/模型名`。模型 ID 来自上游 `/models`，上下文长度等元数据以已有明确配置为准。
4. 使用 Magpie 的摘要压缩模式，默认即为此模式。需要明确设置时，执行 `magpie provider set agentrouter-shim compaction=magpie`。压缩路由规则也应选用此供应商。
5. 在原报错聊天验证普通回复、上下文压缩，以及压缩后的继续对话。

供应商模式由 Magpie 的 Bun 插件宿主运行。首次需要时由 Magpie 准备 Bun。Magpie 的「设置 → 隐私 → 订阅账号」控制账号型插件的可用性，使用此模式需要该设置允许读取插件登录。

### Codex 请求头

在「供应商 → AgentRouter 修复」的编辑页中，插件声明以下两个开关。保存后，后续请求读取当前开关值。

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 对话请求带 Codex 头 | 关闭 | 为 Responses、压缩、输入 Token 计数及 Chat Completions 请求设置实际 Codex 身份头，并补齐当前会话头。关闭时按 Magpie 传入的客户端头发送。 |
| 查询模型时带 Codex 头 | 开启 | 查询上游 `/models` 时发送实际 Codex 身份头。关闭时使用宿主客户端头，上游可能返回 401。 |

也可以通过 CLI 设置。

```sh
magpie plugin options magpie-responses-shim '{"codex-headers":true,"models-codex-headers":true}'
```

`User-Agent`、`Originator`、`Version` 依次取自插件选项 `codexHeaders`、本次已经传入的 Codex 请求头，以及 Magpie 配置目录 `client-shapes.json` 的 `codex` 记录。记录缺少 `Version` 时，从实际 `User-Agent` 中的版本补齐。此记录由 Magpie 在转发真实 Codex 请求时保存。[Magpie 客户端记录实现](https://github.com/yetone/magpie/blob/v0.1.3078/internal/provider/test_as.go#L138)

首次使用时，如果出现 `codex_headers_unavailable`，先让自己的 Codex 通过 Magpie 原有的 API Key 供应商发送一条普通请求，再回到「AgentRouter 修复」重新获取模型。也可在插件 JSON 选项的 `codexHeaders` 中填写自己实际使用的 `User-Agent`、`Originator` 和可选 `Version`。身份头读取失败会显示具体错误，模型查询开关关闭后可按宿主方式重新查询。

对话开启后，`Session-Id`、`Session_id` 和 `Thread-Id` 的缺失值使用本次会话 ID 补齐，优先使用本次已传入的会话信息，其次使用 Magpie 的 `chat.headers` 会话 ID。`X-Codex-Turn-Metadata` 等逐请求元数据沿用实际收到的值。账号鉴权使用 Magpie 为本次请求选中的 Key。

`0.2.0` 文档把普通 API Key 供应商的「Request headers to pass／透传请求头」输入框误写成了账号型插件供应商的选项。此前验证直接写入 `providers.json` 的 `passHeaders`，验证的是后端转发能力。`0.3.0` 使用 `auth.options` 声明编辑页开关，已在 Magpie `0.1.3078` 实际界面确认。[账号供应商编辑页](https://github.com/yetone/magpie/blob/v0.1.3078/internal/gui/assets/app.js#L9489) · [插件开关接口](https://github.com/yetone/magpie/blob/v0.1.3078/internal/plugin/host.js#L2123)

### 多 Key 与路由

1. 在「AgentRouter 修复 → 账号」中点「添加另一个 AgentRouter 修复 账号」，每次填写一个 Key。重复执行 `magpie plugin login agentrouter-shim` 也会添加新账号。
2. 勾选参与请求的账号，并设置首选账号与顺序。
3. 在同一编辑页的「路由」中选择「智能」「按顺序」「轮流」等策略，按需要设置「会话保持」。例如 `magpie provider set agentrouter-shim routing=smart`，轮流策略为 `routing=rotate`。

Magpie 选择账号，插件在账号作用域中读取它的 Key 并清理每次请求。已用两个独立测试 Key 验证轮流路由，以及压缩时第一个账号返回 429 后改用第二个账号。每次账号尝试都执行清理。

本插件目前提供模型列表和上游原始 HTTP 结果。AgentRouter 余额、套餐余量及重置时间尚待接入 `auth.usage` 用量接口，按这些数据排序需要对应的上游数据。其余路由、休息和会话保持沿用 Magpie 的当前规则。[Magpie 插件多账号实现](https://github.com/yetone/magpie/blob/v0.1.3078/internal/provider/plugin_accounts.go#L17)

### 本地开发

直接加载仓库目录。

```sh
git clone https://github.com/JinPen-G/magpie-responses-shim.git
magpie plugin add ./magpie-responses-shim
```

客户端连接 Magpie 的网关地址。默认 OpenAI Base URL 为 `http://127.0.0.1:3425/v1`，实际端口以 Magpie 设置为准。插件随 Magpie 运行，对每次符合条件的请求执行清理。

从独立修复代理迁移时，先完成上述供应商设置，再把客户端 Base URL 指向 Magpie，重新加载客户端配置。在原报错聊天验证恢复后，停止旧的独立代理。

## 为什么初版覆盖不到压缩

在已验证的 Magpie `0.1.3078` 中，普通对话经过 `serveAgent`，它创建中间件上下文，再在供应商尝试前执行 `onProvider`。默认的 Codex 上下文压缩由 `compaction_trigger` 触发，进入 `codexCompact` 后直接调用 `serve`，该内部请求没有中间件上下文。`0.1.0` 只提供 `onProvider`，因此这条压缩链路会遗漏清理。2026-11-13 核对的 Magpie 主分支 `0fda3a1c` 也采用这条调用路径。[普通请求入口](https://github.com/yetone/magpie/blob/v0.1.3078/internal/gateway/middleware.go#L30) · [压缩请求入口](https://github.com/yetone/magpie/blob/0fda3a1c122dda67046a3f99baaf4f06395c0c81/internal/gateway/codex_backend.go#L3802)

`0.2.0` 的供应商模式在实际传输层执行清理。Magpie 生成摘要、路由组尝试和普通对话，只要最终交给 `agentrouter-shim`，都会进入同一 `fetch`。旧的 `agentrouter` 配置仍采用中间件模式，升级后的压缩修复需要完成供应商切换。

## 处理规则

- 移除历史 `reasoning` 项及其中的密文和资源 ID。
- 对内容完整的 `message`、`function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output`，移除可省略的顶层 `id`。
- 对包含完整 `tools` 定义的 `additional_tools`，移除顶层 `id`。
- 保留消息正文、图片、消息 `phase`、工具定义、调用参数、结果及 `call_id` 配对。
- 保留纯 ID 引用、加密压缩历史、托管工具和未知类型，交由原协议继续处理。

中间件模式使用 `onProvider`，按 `ctx.provider.id` 匹配实际供应商。供应商模式使用账号作用域中的 `auth.loader().fetch`。两种入口复用同一清理器。

## 选项

在「插件 → 已安装 → 选项」中编辑以下 JSON。

```json
{
  "providers": ["agentrouter"],
  "log": false,
  "upstream": "https://agentrouter.org/v1"
}
```

| 选项 | 含义 |
| --- | --- |
| `providers` | 中间件模式要处理的供应商 ID，默认 `agentrouter`。可填写多个准确 ID，空数组暂停中间件处理。 |
| `log` | 为 `true` 时记录移除项数量和未解决的资源状态数量，默认关闭。日志内容仅含计数。 |
| `upstream` | 供应商模式实际访问的上游 Base URL，默认 `https://agentrouter.org/v1`。应填写承接此 API Key 的真实服务地址。 |
| `codexHeaders` | 可选对象，填写当前实际 Codex 的 `User-Agent`、`Originator` 和可选 `Version`。省略时读取收到的 Codex 身份头或 Magpie 已记录的身份。 |

`magpie.options` 给出编辑器示例，代码也实现了相同默认值。中间件的供应商匹配使用 Magpie 中当前的实际 ID。已有 OpenCode 配置在 `config.provider["agentrouter-shim"].api` 明确指定地址时，该地址用于模型发现及请求传输。

## 使用限制

移除 `reasoning` 会失去隐藏推理续接状态，可能影响表现和缓存命中。

`previous_response_id`、`conversation`、`item_reference`、上游原生加密 `compaction` 等状态仍可能绑定原资源。依赖这些状态的聊天，需要回到原资源，或先恢复完整可重放历史。更换插件入口只能保证清理器收到请求，加密压缩内容本身仍需由原资源读取。文件引用和托管工具也可能存在单独的资源限制。

本次验证使用 Magpie 的摘要压缩模式，其 `magpie1:` 摘要由 Magpie 在后续请求中展开。上游原生压缩涉及另一套资源绑定，切换到同一 AgentRouter 账号也可能被中转服务路由到不同 Azure 资源，这需要上游保证会话绑定。

已验证的客户端压缩入口是 `/v1/responses` 中的 `compaction_trigger`。供应商 `fetch` 也能处理交给它的 `/responses/compact` 和 `/responses/input_tokens`。Magpie 0.1.3078 的部分入口会在供应商调用前拒绝 Magpie 模型的直接 `/responses/compact` 请求，这类客户端需要使用宿主支持的压缩路径。

中间件接收客户端的原始协议。本插件处理 `responses` 输入，作用范围还取决于请求是否经过 Magpie 的 `onProvider`。Magpie 自身的会话标题、路由分类器、代搜和图片描述采用各自的内部请求路径。

Magpie 为一次 `onProvider` 调用设置 250 毫秒限时。加载失败、异常或超时会记录在插件状态中，该次请求按宿主规则继续发送。供应商模式运行在 Bun 中，请求清理失败会返回错误。可在插件页面查看加载错误、调用数和失败数。

真实 AgentRouter 对客户端和请求形状的兼容性仍需在用户环境验证。Magpie 对供应商插件有自己的协议转换规则，上游若还拒绝请求形状，需要结合具体错误核对该路径。

## 验证

开发验证使用 Node.js 22.15 或更新版本。

```sh
npm test
```

本机宿主验证脚本目前适用于 Windows。

```powershell
npm run test:magpie -- "C:\path\to\magpie.exe" "C:\path\to\bun.exe"
```

`npm test` 的 20 项定向测试检查清理边界、供应商范围、多账号鉴权隔离、取消、请求头开关、身份读取和历史内容保留。`test:magpie` 使用已有 Bun，在独立配置目录启动本机 Magpie，覆盖以下路径。

- 普通请求及 Codex 原样转发的中间件处理。
- 默认摘要压缩跳过中间件的回归复现。
- 供应商模式清理摘要请求，模拟上游拒绝未清理 ID。
- 模型查询与对话开关，使用已记录的 Codex 身份和当前会话，生成 `magpie1:` 摘要后继续对话。
- 两个独立 Key 的轮流路由，以及第一个 Key 被 429 限流时的压缩失败切换。

已在 Windows、Node.js 24.13.0、Bun 1.4.4 和 Magpie 0.1.3078 验证，测试上游为本机模拟服务。2026-11-15 另在 Magpie 实际供应商编辑界面确认两个请求头开关、两个 Key 账号以及路由选项。真实 AgentRouter 和反馈者的原聊天仍待复测。

临时环境统一位于本仓库 `output/.tmp/magpie-verification`。测试成功和失败均执行退出清理。

## GitHub 分发

`package.json` 位于仓库根目录，`magpie.middleware` 指向中间件入口，`main` 指向供应商入口。两个入口及公共清理器均提交在仓库，源码可直接加载。中间件只使用标准 JavaScript 和插件内的相对导入，供应商使用 Bun 提供的 `Request`、`Response`、`fetch` 和取消信号。

为仓库添加 `magpie-plugin` topic 后，Magpie 可以在「发现 → 非官方插件 · GitHub」中检索它，出现时间取决于 GitHub 索引和 Magpie 缓存。

入口和选项按 Magpie 插件手册实现。[官方插件手册](https://usemagpie.ai/docs/zh/plugins#middleware)

## 来源与许可证

清理器基于 `agentrouter-responses-shim` 2.0.1 的 MIT 实现，包含完整 `additional_tools` 项的 ID 清理补丁。来源与原许可证见 [第三方声明](THIRD_PARTY_NOTICES.md)，本项目采用 [MIT License](LICENSE)。
