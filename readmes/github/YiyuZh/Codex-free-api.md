# Codex-free-api

通过中转请求让Codex使用Openai赠送api额度

将 [tdragon6/Codex-free-api-quota](https://github.com/tdragon6/Codex-free-api-quota) 的请求清理逻辑接入 Magpie 原生服务商插件。插件二次开发与维护由 [YiyuZh](https://github.com/YiyuZh) 完成，原项目作者 [tdragon6](https://github.com/tdragon6) 列入贡献者。

## 安装

安装到已有的 Magpie：

```sh
magpie plugin add github:YiyuZh/Codex-free-api
```

1. 在 Magpie 的 **插件 → 已安装** 中找到 **Codex-free-api**，点击登录。
2. 填写自己的 **OpenAI 官方 API Key**。账号名称、Organization ID、Project ID 均可留空。
3. 在服务商页面选择该账号与模型，需要代理时使用 Magpie 原有的账号代理设置。
4. 在 Magpie 的 Codex 设置中选择本插件的模型，再由 Codex 发起请求。

Key 由 Magpie 的原生账号存储管理。插件不另存 Key，也不启动独立中转服务；请求经 Magpie 直接发往 `https://api.openai.com/v1`。多个 Key、账号切换和代理沿用 Magpie 的设置。

供应商 ID 保留为 `codex-free-api-quota`，使早期本地版本已有的账号与模型引用继续可用。例如模型标识为 `codex-free-api-quota/gpt-4o-mini`。独立仓库版与社区版使用同一 ID，请只安装其中一个。

## 请求行为

- 使用 OpenAI Responses 协议，保留流式输出、工具调用和推理字段。
- 沿用原项目的顶层字段清理规则，移除 `metadata`、`client_metadata`、`prompt_cache_key`、`safety_identifier`、`user` 及匹配 Codex / ChatGPT / session 等标识的顶层字段；消息正文与工具定义保持原样。
- 重建上游请求头，仅发送当前账号的 Key、可选 Organization / Project 和协议必需头。只允许官方 OpenAI 域名与已支持路由，拒绝跳转。
- 模型列表取当前账号 `/v1/models` 与随包公开能力快照的交集，也接受已知模型的日期版本。新模型需要更新快照。
- 上游错误按原样返回。插件没有赠送额度查询接口，不把模型标记为免费，不创建或增加额度；是否使用赠送额度、余额与计费结果由 OpenAI 账号及适用规则决定。

与直接使用普通 OpenAI 服务商相比，本插件增加原项目的请求清理步骤。它与社区的 `openai-decisions` 使用同一类 OpenAI API Key，但提供 Codex 所需的 Responses 对话与工具调用；`openai-decisions` 面向 Decisions / System One 分类，两者不是额外的独立额度池。

## 选项

在 Magpie 的插件选项中配置 JSON，默认值为：

```json
{ "timeoutMs": 600000, "maxBodyMB": 32 }
```

`timeoutMs` 为请求超时（1,000–3,600,000 毫秒）；`maxBodyMB` 为 JSON 请求体上限（1–512 MiB）。模型发现最多等待 20 秒。

## Development

```sh
npm test
```

No runtime dependencies or build step. Magpie / OpenCode 1.x use `main` (`opencode.mjs`); OpenCode 2.x uses the canonical community adapter in `exports["."]` (`opencode2.mjs`). Tests use synthetic credentials and mocked transport.

## English

Relay requests so Codex can use API credits granted by OpenAI.

Install with `magpie plugin add github:YiyuZh/Codex-free-api`, then sign in through **Plugins → Installed → Codex-free-api** using your own official OpenAI API key. The account label, Organization ID and Project ID are optional. Pick this provider's model for Codex in Magpie. Account storage, multiple keys and proxy settings remain managed by Magpie.

This plugin adapts the original request sanitizer into a native provider using OpenAI Responses. It forwards directly to the official OpenAI API, removes top-level client attribution, and preserves prompts, tools and streaming responses. It shares the OpenAI account's billing and credit pool; it does not grant credits, guarantee free usage, or report remaining promotional balance. Unlike the community `openai-decisions` provider for Decisions / System One classification, this provider serves Responses conversations and tool calls. Only account-visible models with bundled capability metadata are listed.

## 贡献者与许可证

- **YiyuZh**：Magpie 插件二次开发与维护。
- **tdragon6**：原项目作者、请求清理逻辑贡献者。

详见 [CONTRIBUTORS.md](CONTRIBUTORS.md)、[NOTICE](NOTICE) 和 [PROVENANCE.json](PROVENANCE.json)。插件采用 MIT 许可证；原项目代码和社区兼容入口保留各自的版权声明与许可证。
