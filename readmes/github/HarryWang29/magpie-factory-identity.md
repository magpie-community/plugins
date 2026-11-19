# Magpie Factory Identity

A Magpie gateway middleware that rewrites OMP's identity sentence and maps twelve OMP tool names for the `factory` provider, restoring the original names in JSON and streamed replies.

0.1.0 仅替换身份句，已有实际请求仍被 Factory 拒绝。0.2.0 增加工具名双向映射，0.2.1 补充抓包中的自定义工具 `web_search`；本地协议转换测试不代表 Factory 会接受完整 OMP 会话。

这个中间件在 Magpie 选定 Factory 上游后，将 OMP 默认的开头身份声明替换为：

```text
You are droid's trusted coding assistant.
```

Engineering、Personality、Tone、工具策略和工作流程等其余内容保持原样。同时，插件把指定的 12 个 OMP 工具名转换成 `omp_` 前缀，收到工具调用后再还原为客户端注册的名称。

插件在使用者自己的 Magpie 网关内运行，没有运行时依赖，也不发起网络请求。使用者需要自行配置 Factory 提供商和账号。

## 安装

需要支持 `onProvider`、`onResponse` 和 `onEvent` 中间件钩子的 Magpie；本项目依据 `v0.1.4402` 的钩子契约实现。该版本曾有身份句替换的使用反馈，新增工具映射仍需在实际网关中验收。

在 Magpie Web 或桌面应用的插件页，手动添加：

```text
github:HarryWang29/magpie-factory-identity
```

也可以使用命令行：

```sh
magpie plugin add github:HarryWang29/magpie-factory-identity
```

已有本地单文件版本时，先停用旧条目，再安装仓库版本，避免同时维护两个副本。

## 处理范围

- 仅匹配实际选中的 provider ID `factory`，也适用于最终选择 Factory 的路由组请求。
- 保留原有身份句替换：处理 Anthropic `system`、Chat Completions 的 `system`/`developer` 消息、Responses `instructions` 及系统消息、Gemini 系统指令。只替换完整的原身份句，所有命中位置都会替换。
- 工具名转换覆盖 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 和 Gemini 的工具声明、指定工具的选择字段及历史调用；Gemini 历史工具响应中的结构化名称也会同步处理。
- `onResponse` 还原非流式响应中的工具调用名；`onEvent` 还原 SSE 事件中的调用名，包括 Chat Completions 分片发送的名称，以及 Responses 的新增条目、完成条目和最终响应。
- 描述、schema、参数、调用 ID、工具结果正文、普通用户/助手文本、缓存标记、推理签名及其他元数据保持原样。不会全文替换提示词里的 `read` 等工具引用。

`onProvider` 接收到的仍是客户端协议格式。Magpie 为每次上游尝试提供独立的请求；插件每次重建本次映射状态，对 Factory 的改写不会传播到其他 provider。输入对象不会被原地修改。

### 工具名映射

仅精确匹配下列 12 个名称，不自动匹配无下划线的 `read`、`websearch` 等其他拼写，也不处理表外工具或 MCP 工具。

| 客户端原名／返回客户端的名称 | 发给 Factory 的名称 |
| --- | --- |
| `_read` | `omp_read` |
| `_bash` | `omp_bash` |
| `_edit` | `omp_edit` |
| `_ask` | `omp_ask` |
| `_eval` | `omp_eval` |
| `_glob` | `omp_glob` |
| `_grep` | `omp_grep` |
| `_task` | `omp_task` |
| `_wait` | `omp_wait` |
| `_todo` | `omp_todo` |
| `_write` | `omp_write` |
| `web_search` | `omp_web_search` |

响应只还原本次请求实际映射的别名。例如客户端原本就声明 `omp_read`，且未触发 `_read` 映射时，响应中的 `omp_read` 保持原样。

如果待映射名称与既有独立工具重名（例如同时存在 `_read` 和 `omp_read`），插件会报错，不产生部分改写。Magpie 对中间件错误采用 fail-open：记录错误，并继续发送原始请求；这不是请求拦截机制。

## 验证与限制

在仓库目录使用 Node.js 20 或更新版本执行本地回归测试：

```sh
npm test
npm pack --dry-run
```

测试通过公开的三个钩子验证协议转换、两轮调用、名称分片、并行调用、provider 切换、名称冲突和内容保留。测试不调用 Factory、不执行模型返回的工具，也不需要 API key。

0.2.0 曾使用 Magpie `v0.1.4402` 对应的 `moejs v0.1.0` 做过离线运行验证：插件成功加载，真实 OMP 的 52,181 字节抓包完成了当时全部 11 项名称映射，除身份句与工具名外的请求字段逐项保持一致；11 项完整响应还原和 Chat SSE 名称分片也已通过。该验证没有向 Factory 发出请求，未覆盖 0.2.1 新增的 `web_search`。

0.2.1 已通过 32 项 Node.js 回归测试，并用最新失败请求抓包做了离线转换验证：全部 12 个工具完成映射，包括 `web_search → omp_web_search`；除原有身份句和工具名称外的字段保持一致，响应还原保留调用 ID 与查询参数。此验证同样没有向 Factory 发出请求。

在实际网关验收时，使用 OMP 默认提示词和全新会话，先发送普通消息，再完成一次只读工具调用。OMP 发给 Magpie 的名称仍为 `_read`，Magpie 发给 Factory 的名称应为 `omp_read`；返回 OMP 的调用名应恢复为 `_read`，调用 ID 和参数应保持一致。继续下一轮时，历史调用也应再次转换为 `omp_read`。

此前独立 HTTP 脚本已验证：保留 OMP 原始 `read` 工具描述和 schema，仅改名为 `omp_read`，可完成两轮非流式 Chat Completions 读取。该结果没有覆盖本插件在真实 OMP 会话中的流式链路，也不代表其他工具均已通过 Factory 验证。

本插件不清理用户消息、助手回复或工具输出历史里的引用，也不处理其他客户端的身份声明。旧请求日志或源码中的触发文本进入这些历史内容后，仍可能被上游拒绝。

背景讨论：[oh-my-pi #19553](https://github.com/can1357/oh-my-pi/issues/19553)。本项目独立维护，与 Factory、Magpie 官方及 OMP 官方无隶属关系。

## 发布这个仓库

将 `package.json`、`factory-identity.middleware.mjs`、`README.md` 和 `LICENSE` 放在公开仓库根目录。纯中间件通过 `magpie.middleware` 声明入口，无需添加 `main`、`exports` 或构建步骤。

在 GitHub 仓库的 About 中添加 topic `magpie-plugin`，Magpie 的“发现 → 非官方插件 · GitHub”即可按其发现规则检索这个仓库。首次检索有缓存延迟。

若使用不同的 GitHub 用户名或仓库名，请同步修改 `package.json` 的 `repository.url` 及本文件的安装地址。

参考：[Magpie 发布与上架文档](https://usemagpie.ai/docs/zh/plugins#publish)。

## 许可证

[MIT](LICENSE)
