# Factory Droid CLI

在 Magpie 或 OpenCode 中用本机 Droid 运行模型。插件启动 `droid exec --output-format acp`，通过标准输入输出发送 ACP 请求。已有的 [factory](../factory) 插件通过设备登录或 API key 直连 Factory API。两个 provider 使用同一 Factory 账号时共用额度。

## Using Factory models from Codex

Install Droid on the machine running Magpie, add this plugin and select **Factory Droid (local CLI)**. Use an existing Droid login or enter the same Factory API key you use with the direct provider. If the model is enabled for your account, select `factory-droid/deepseek-v4.1-flash-1017` in Codex. Both providers draw from the same account quota.

The `factory` provider builds model HTTP requests itself. It adapts the client's conversation, tool definitions and history to Factory's model routes. An adapter update can fix a known incompatibility. Factory still evaluates each request, so a different conversation or a change upstream can produce a refusal on the same plugin version. With `factory-droid`, Magpie sends prompts over ACP and the installed Droid CLI builds the upstream model request. Factory's account permissions and usage policies apply on both paths. See [the report against the direct provider in 0.1.58](https://github.com/magpie-community/plugins/issues/1603).

## 安装和登录

1. 在运行 Magpie 或 OpenCode 的机器上安装 Factory Droid，确认 `droid exec --help` 的输出格式包含 `acp`。已在 macOS 的 Droid 1.21.1 上验证。如果宿主进程的 PATH 找不到 `droid`，可将 `FACTORY_DROID_BIN` 设为可执行文件的绝对路径。
2. 在本仓库根目录运行 `magpie plugin add ./packages/factory-droid`。
3. 在 Providers 中选择 **Factory Droid (local CLI)**。已用同一系统用户运行 `droid` 登录时，选 **Use local Droid login**。也可以选 **Factory API key** 输入密钥，或在宿主环境设置 `FACTORY_API_KEY` 后选用本机登录。账号列表和模型请求都交给 Droid 处理。
4. 选择 `factory-droid/default` 使用 Droid 的默认模型，或用 `factory-droid/<模型 ID>` 指定模型。模型列表取自当前账号的 Droid ACP 目录。支持推理强度的模型会列出可用档位，插件通过 ACP 会话配置应用所选档位。

`magpie plugin list` 显示插件发现的完整目录数量。Magpie 网关的 `/v1/models` 显示当前配置选中并对客户端开放的模型。

使用 API key 时，插件按账号和 Droid 可执行文件保存模型名称、图片支持和推理档位。新进程可直接读取一分钟内的目录。一分钟后读取会触发后台刷新，临时故障时可使用最近 24 小时内的结果。Droid 拒绝身份验证时，插件清除该账号的目录缓存。首次查询最多等待六秒，超过时先返回标记为临时的默认项，后台继续获取完整列表。

仅使用本机登录时，模型目录留在当前进程中。插件根据本机凭据文件的变更识别登录切换，并重新获取目录。无法识别本机凭据版本时，每次直接查询 Droid，工具续接使用客户端历史重放。

## 请求和工具

插件接收 Anthropic Messages 请求，可返回 JSON 或 SSE。它按顺序读取顶层系统指令和消息里的 `system`、`developer`、`user`、`assistant` 角色。支持内联 base64 图片、文本文件、搜索结果和工具引用。文档 URL 以链接文本传给模型。工具定义以当前请求的 `tools` 为准。`thinking.type: disabled` 会隐藏输出中的思考块。

客户端声明的工具通过临时 stdio MCP 服务提供给 Droid。同一批并发调用会在一条助手回复中返回多个 `tool_use`。客户端执行工具，追加助手回复，再按调用 ID 回传这一批的全部 `tool_result`。结果可以分布在多条用户消息里，允许调整顺序或附带指令。缺少、重复或未知的调用 ID 会返回 400，客户端可以补齐后重试。历史和配置匹配时，结果直接送回原来的工具调用。Droid 可以读取结果、继续调用工具或给出答案。

带有稳定 `x-magpie-session` 的普通对话也能复用会话，下一轮只发送新增的用户消息。插件核对账号、会话、工作目录、子代理、请求配置和历史。Droid 支持在运行中接收提示时，工具结果旁的用户指令、随后追加的系统消息也能送进同一轮。调整工具顺序、缓存标记或切换到另一个指定模型时可以沿用普通会话。推理强度优先取 `x-magpie-effort`，其次取 `output_config.effort` 或 `reasoning_effort`。切回默认模型、撤销显式推理档位、修改工具定义或历史时会重建上下文。以纯文本助手消息结尾时，插件将末尾文本交给模型续写。

每个插件进程最多保留 8 个会话，普通空闲会话保留两分钟，等待客户端工具结果的会话最多保留十分钟。等待工具结果期间暂停插件的 ACP 提示超时。工具结果的相同请求在重试缓存中命中时返回原消息和调用 ID。工具结果已送达后客户端断线，插件最多等待两分钟。此时重试可以取回同一次生成的答案。原连接仍在处理同一请求，或同一工具收到冲突结果时，返回 HTTP 409。缓存最多保留最近 32 个响应，每个响应的内容上限为 512,000 字节。

Droid 声明支持 `session/resume` 时，插件为带稳定会话 ID 的已完成轮次以及等待工具结果的步骤记录恢复位置。重启或空闲会话被回收后，插件尝试在原临时目录恢复，只发送本轮新增内容。恢复记录按账号、请求配置和历史摘要匹配，保留 24 小时，最多 128 条，含计量基线，不保存消息原文。进程退出时仍在等待工具结果，新进程恢复原生会话，并把对应的工具调用和客户端结果作为新增提示发送。原目录仍被占用或 Droid 拒绝恢复时，插件按客户端历史重放。默认给重放的旧对话分配 4 MiB，可用 `FACTORY_DROID_REPLAY_BYTES` 调整。插件保留当前轮及系统指令，并在省略较早的整轮对话时告知模型。

插件在临时目录中工作。会话的 `PreToolUse` hook 只放行工具发现和当前会话的 MCP 转发服务。只有当前会话已声明的客户端工具可以获得一次性 ACP 授权。部署环境需允许 Droid 运行这个 hook。组织策略可以关闭用户和项目 hooks，临时目录本身不提供操作系统级隔离。详见 [Factory hooks](https://docs.factory.com/harness/hooks)。

采样参数、输出 token 上限和 stop sequences 由 Droid 控制。`/v1/messages/count_tokens` 在本地估算输入量，按文本 UTF-8 字节数、工具定义和图片数量计算。会话结束、取消或过期后，插件关闭子进程并清除临时目录。Droid 自身的会话记录按 Factory 配置保留。

## Magpie 用量

每次返回工具调用或最终答案时，插件读取当前 Droid 会话的 `tokenUsage`，将本次新增的输入、输出、缓存读取和缓存写入 token 发给 Magpie。JSON 和 SSE 都带有这些计数。会话文件写入稍晚时，插件最多等候 150 毫秒。ACP 已报告的本轮用量可以补上旧文件缺失的增量；文件随后追平时不会再计一次。两处都缺失的字段显示为 0。重试取回已交付的答案时，本次新增用量为 0。

使用 Factory API key 时，`magpie quota factory-droid` 显示同一 Factory 账号的 Standard 和 Droid Core 额度窗口，以及账号有余额时的额外用量。两个 provider 的窗口反映同一笔额度。仅使用 Droid 本机登录时，可在 Droid 中运行 `/status` 查看额度。

额度窗口按已核对的模型 ID 区分 Standard 和 Droid Core。未知模型、自定义模型和 `default` 不参与按池路由。账号启用 Extra usage 且有可用余额时，窗口继续展示，耗尽订阅窗口的账号仍可参与路由。

## 网页搜索与图片

在 Magpie 运行 `magpie search add factory-droid` 可启用 Droid 的原生 WebSearch。搜索读取工具返回的网页标题、URL 和摘要。

安装的 Droid 提供 GenerateImage 工具时，模型目录会显示 `factory-droid/droid-image`。它使用账号在 Droid 中配置的图片模型，支持 OpenAI 兼容的 `/v1/images/generations` 和 `/v1/images/edits`，返回 `b64_json`。改图接受 multipart 文件或 JSON data URL，每次 1 至 4 张 PNG 或 JPEG，每张最多 5 MiB。可以请求 1 至 4 张输出，`size` 作为期望尺寸交给模型。Droid 将原图保存到本机生成图片目录。组织的图片模型限制仍由 Droid 执行。参见 [Factory 图片生成说明](https://docs.factory.com/droid-cli/image-generation)。
