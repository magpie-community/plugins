# volcengine-apigw

Magpie 供应商插件：**火山引擎 APIG 网关（BlueRegion 架构）**。

把你的网关注册为 magpie 供应商，agent 即可通过 `volcengine-apigw/<model>` 访问网关上的模型；同时在 magpie 的额度面板展示个人 Token 用量（今日 / 本月）。

## 它做什么

- **推理转发**：模型走 OpenAI 兼容的 `/chat/completions`，agent 发来的 Anthropic / Responses / Gemini 请求由 magpie 网关自动转换。
- **模型列表**：`provider.models` 查询网关 `/v1/models`，按账号列出可用模型及 `credit` 计量倍率（映射到 magpie `rate` 字段）。静态元数据（context 窗口 / USD 价格 / 推理 / 多模态）由内置 `MODEL_META` 表补充。
- **用量展示**：`auth.usage` 并发查询 `/v1/usage/summary` + `/v1/usage/by-model` + `/v1/models`，在 magpie quota 面板显示今日 / 本月的 Credit 用量（估算）+ 输入 / 输出 / 缓存命中 / 请求数明细。配置 Credit 限额后展示真实百分比，未配置时半环占位并展示明细文本。

## 前提

网关上已部署 [BlueRegionUsage](https://gitcode.com/solcao/BlueRegionUsage) 的 `/v1/usage/*` 函数路由。未部署时不影响推理，仅用量展示降级为错误提示。

## 安装

```bash
# 从 GitHub 直接安装（推荐）
magpie plugin add github:CrazyTomatoOo/volcengine-apigw-usage

# 或克隆后本地加载
git clone https://github.com/CrazyTomatoOo/volcengine-apigw-usage.git
magpie plugin add ./volcengine-apigw-usage
```

## 登录

```bash
magpie plugin login volcengine-apigw
```

会依次询问：

1. **API Key** — 网关签发的个人推理 Key（UUID 形式 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
2. **网关基础地址** — 如 `https://xxxxxxxxxx.apigateway-cn-beijing.volceapi.com`（只填到域名即可；带不带 `/v1` 都会规范化）

> 路径约定：推理请求发往 `<网关地址>/v1/chat/completions`。openai-compatible SDK 只会在 baseURL 后拼 `/chat/completions`，不会补 `/v1`；网关对裸 `/chat/completions` 一律返回 `404 model_not_found`，所以插件内部把 baseURL 固定成带 `/v1` 的形式。

> 设计说明：插件**不**在登录阶段调 `client.auth.set` 回写 consumer ID（那会覆盖 auth 对象，导致 loader 拿不到 baseURL/apiKey）。consumer ID 由 `auth.usage` 钩子直接从用量响应中读取，仅用于 quota 面板显示，不参与鉴权。

## 验证

```bash
magpie plugin              # volcengine-apigw (火山引擎 APIG 网关, N models)  signed in
magpie provider test volcengine-apigw
magpie quota               # 今日 / 本月 token 用量
```

之后 agent 可用 `volcengine-apigw/deepseek-v4-pro` 等模型 ID。

## Anthropic 协议提供者

插件同时导出 `volcengine-apigw-anthropic` 提供者，用于需要 Anthropic Messages 协议的场景。

```bash
magpie plugin login volcengine-apigw-anthropic
```

登录信息要求与 OpenAI 协议提供者完全相同：同一个网关、同一个 API Key、`gatewayBaseUrl` 也填同一个地址。

差异：

- 推理请求发往 `/v1/messages`（Anthropic Messages 格式），而不是 `/v1/chat/completions`
- 底层 SDK 为 `@ai-sdk/anthropic`
- 由于 magpie 按提供者隔离认证，必须分别登录 `volcengine-apigw` 和 `volcengine-apigw-anthropic`，各输入一次相同 Key 和网关地址
- `auth.usage` 用量窗口在两个提供者上独立显示

## 支持的模型

16 个，包括 DeepSeek V4 Flash/Pro、GLM 5.2/5.3/5.3-Flash、Doubao Seed 2.1 Pro、Kimi K3、Qwen3.7/3.8 系列等。完整列表见 `index.mjs` 的 `MODEL_META`。

## 安全模型

与 BlueRegionUsage 一致：

- 用户 API Key 在网关 key-auth 层校验后注入 consumer ID，**凭证止于网关**
- 用量函数只以 consumer ID 作 PromQL 过滤，用户天然只能查到自己的数据
- 本插件只做客户端转发，凭证不离开用户机器
- `plugin-auth.json` 权限 600，与 OpenCode / magpie 其他插件相同

## 配置文件

| 文件 | 内容 |
|------|------|
| `~/.config/magpie/plugin-auth.json` | 登录信息（Key + gatewayBaseUrl，权限 600） |
| `~/.config/magpie/plugin-providers.json` | 插件列出的供应商和模型缓存 |

## 选项

无。网关地址和 API Key 在登录时提供。

### Credit 限额（可选）

magpie quota 面板按百分比渲染进度环。BlueRegionUsage 是按量计费、无内置额度上限，所以插件以 **Credit**（网关服务端按各模型计量系数算出的估算用量）作为面板指标：

- **未配置限额**：面板显示半环占位 + `Credit X · 输入… · 输出… · 缓存命中… · N 请求` 明细文本，不显示 "还没用过"，不触发红色告警。
- **配置限额后**：面板按 `Credit / 限额 × 100%` 显示真实百分比与进度条，超 90% 触发红色告警。

限额读取优先级（与 [BlueRegionUsage opencode 插件](https://gitcode.com/solcao/BlueRegionUsage) 共用同一份配置）：

1. `~/.config/bru-usage/config.json`（JSON，字段 `dailyCreditLimit` / `monthlyCreditLimit`，数值或 `null`）
2. 环境变量 `BRU_DAILY_CREDIT_LIMIT` / `BRU_MONTHLY_CREDIT_LIMIT`

示例 `~/.config/bru-usage/config.json`：

```json
{
  "dailyCreditLimit": 50,
  "monthlyCreditLimit": 500
}
```

留空某维度（`null` 或不设）则该窗口走半环占位。Credit 系数与分段历史由网关 `/v1/models` 返回，`/v1/usage/by-model` 每行携带服务端算好的窗口 Credit；旧后端无行级 Credit 时回退到目录系数 × 逐日 token 反算。

## License

MIT
