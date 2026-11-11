# 执算者AI Magpie 插件

在 [Magpie](https://usemagpie.ai) 里用 [执算者AI（zszapi.com）](https://zszapi.com) 的 API Key：粘贴 Key，自动获取这个 Key 能用的对话模型，按各家原生协议调用，余额以人民币显示。不用手填地址、模型列表或协议。

插件无运行时依赖，无需构建。Magpie 用 Bun 运行插件；本地测试需要 Node.js 20 或更高版本。

## 安装

在 Magpie 的 **Plugins → Discover → Unofficial** 搜索「执算者」，或用命令行：

```sh
magpie plugin add github:teczt/magpie-zszapi
magpie plugin login zszapi
```

登录时只需粘贴 API Key（在 zszapi.com 的「API 密钥」页复制）。登录后在 Providers 页展开「执算者AI」，点「获取模型」，勾选需要的模型后保存。之后各个 Agent 就能选用 `zszapi/<模型 ID>`，例如：

```sh
magpie claude zszapi/claude-opus-5-5
magpie codex zszapi/gpt-6.1-sol
```

更新插件：`magpie plugin update`。

## 一个分组一个 Key

执算者AI 的每个 API Key 属于一个分组（如【GPT】旗舰、【Claude】旗舰、【国模】特惠 · DeepSeek），只能调用该分组的模型。想同时用多家模型，就在站点为每个分组各建一个 Key，然后重复执行 `magpie plugin login zszapi` 逐个添加。Magpie 会把它们显示为同一个提供商下的多个账号：

```
执算者AI · GPT · 尾号 8bfa
执算者AI · Claude · 尾号 c1c1
执算者AI · DeepSeek · 尾号 be7c
```

每个账号只服务自己分组的模型；同一模型有多个账号时，限流或故障会自动切换到下一个。

如果在站点给 Key 勾选了「同时使用其他分组」，一个 Key 就能拿到多个分组的模型，账号名会列出全部系列，例如 `执算者AI · GPT/Claude/DeepSeek/生图 · 尾号 3b78`。

## 生图

Key 能用的生图模型（`gpt-image-*`）也会出现在模型列表里，标记为只出图的模型。勾选并保存后，在 Magpie 的 **Settings → Models → Images → Image generation** 里选择 `执算者AI` 的生图模型，Codex 自带的生图工具、`magpie tool generate_image` 和 Magpie Image MCP 就会通过本插件调用站点的 `/v1/images/generations`（文生图）和 `/v1/images/edits`（改图），按生图分组计费。

## 模型与协议

插件读取 `GET /v1/models`，过滤掉视频、语音、向量等 Magpie 用不上的模型，再按模型系列选择网关原生支持的接口：

| 模型系列 | 请求接口 | Magpie 使用的 SDK |
| --- | --- | --- |
| Claude | `/v1/messages` | `@ai-sdk/anthropic` |
| GPT / Codex / o 系列 | `/v1/responses` | `@ai-sdk/openai` |
| Gemini | `/v1beta/models/{id}:streamGenerateContent` | `@ai-sdk/google` |
| DeepSeek、Grok 及其他 | `/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| 生图（gpt-image、dall-e） | `/v1/images/generations`、`/v1/images/edits` | `@ai-sdk/openai-compatible`（只出图） |

站点的模型列表只有模型 ID，不带能力信息，所以插件为已知模型补上思考等级、图片输入和上下文长度：

| 模型 | 思考等级 | 图片输入 | 上下文 / 最大输出 |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash` | none / low / medium / high / xhigh / max | 支持 | 1,000,000 / 128,000 |
| `deepseek-v4-pro`、`deepseek-v4-flash` | high / max | 不支持 | 1,000,000 / 128,000 |

选 none 即关闭思考（实际发送 `reasoning_effort: "off"`，这是站点接受的写法）。服务端以后返回这些属性时，以服务端为准。

服务端以后返回 `protocols` 字段时，以服务端为准。名称识别不了的自定义别名，可以按完整模型 ID 指定协议：

```sh
magpie plugin options magpie-zszapi '{"modelProtocols":{"my-alias":"anthropic_messages"}}'
```

可用值：`anthropic_messages`、`openai_responses`、`openai_chat_completions`、`gemini_generate_content`。

## 切换线路

站点有两个接入点，账号、Key、余额和模型完全一样，只是网络路径不同：

| 线路 | 地址 | 适合 |
| --- | --- | --- |
| 直连（默认） | `https://zszapi.com` | 海外，以及直连本来就快的网络 |
| 国内优化线路 | `https://kr.zszapi.com` | 国内部分网络（如移动），晚高峰更稳 |

在 Magpie 的 **供应商 → 执算者AI** 里，账号下方有一个「国内优化线路（kr.zszapi.com）」开关，打开后点「保存」即可。切换后下一个请求就走新线路，正在用的 Agent 不用重启，**不用重新登录**，所有账号一起切换。

开关关闭时使用 `baseURL` 选项的地址（默认 `https://zszapi.com`）。早期版本里用 `baseURL` 切到 `kr.zszapi.com` 的，升级后请清除这个选项（`magpie plugin options magpie-zszapi off`），改用开关。

## 余额和额度

插件读取 `GET /v1/usage`，在 Magpie 的用量卡片显示：

- 钱包余额：站点按「付 ¥1 得 1 额度」计价，卡片显示 `余额 ¥88.50`，与站点钱包一致。余额用完时提示充值地址，保留登录状态。
- 密钥总额度，以及密钥的 5 小时、24 小时、7 天消费限额（在站点给 Key 设置后才会出现）。
- 订阅分组的每日、每周、每月额度和到期时间。

只有 HTTP 401（Key 无效或已删除）才要求重新添加 Key；网络失败、余额不足、到期都保留现有登录。

想按后台原始单位显示，可切换为美元：

```sh
magpie plugin options magpie-zszapi '{"currency":"USD"}'
```

## 选项

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `currency` | 余额显示单位：`CNY` 或 `USD` | `CNY` |
| `modelProtocols` | 按模型 ID 指定协议 | 无 |
| `baseURL` | 站点地址，仅用于测试或自建环境；切换官方线路请用上面的「国内优化线路」开关 | `https://zszapi.com` |
| `name` | 提供商显示名 | `执算者AI` |

多个选项写在同一个 JSON 里：`magpie plugin options magpie-zszapi '{"currency":"USD","name":"ZSZ"}'`。清除选项：`magpie plugin options magpie-zszapi off`。

## 凭据与安全

- Key 由 Magpie 保存在它的 `plugin-auth.json`，插件不另建凭据文件。
- 模型和用量查询只访问 Key 所属站点；发送请求时替换调用方的认证头，只允许发往当前账号的对话和生图接口，禁止跟随重定向。切换线路时，请求只会发往 `zszapi.com` 或 `kr.zszapi.com` 中当前选中的那个。
- 查询错误不回显服务端响应正文；账号名只显示 Key 尾号四位，过短的 Key 不显示尾号。
- 模型列表缓存 30 秒、用量缓存 5 秒；返回 401 时立即清除该账号的缓存。

## 开发

```sh
npm run check        # 语法检查
npm test             # 本地 HTTP 夹具测试，不调用收费接口
ZSZAPI_KEY=sk-… npm run smoke   # 用真实 Key 读取模型和余额（不产生费用）
```

本地调试已安装的插件时，可以直接加载工作目录：`magpie plugin add ./`。

## 致谢与许可

基于 [magpie-moonup](https://github.com/ferguson089347/magpie-moonup)（LGPL-3.0）改写，查询缓存与请求转发沿用其实现。本项目同样以 LGPL-3.0-or-later 发布，见 [LICENSE](LICENSE)。
