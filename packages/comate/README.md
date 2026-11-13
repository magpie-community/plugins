# @magpie-community/opencode-comate-auth

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider 插件：**文心快码（Baidu Comate，`comate.baidu.com`）**——登录、模型清单、聊天转发。

请求形态按文心快码 VS Code 扩展 `BaiduComate.comate` 4.14.1 内置的 Comate CLI（`@comate/zulu` 1.7.16）源码移植，插件以该 CLI 的身份（`zulucli` 1.7.16）发请求。

> ⚠️ **尚未用真实账号验证。** 登录、模型清单与聊天三条链路都是读官方客户端代码写成的，测试打的是本地假上游。遇到问题请把报错发到 magpie 的 Discord。

## 安装

```
magpie plugin add @magpie-community/opencode-comate-auth
magpie plugin login comate     # 选「网页登录」或「粘贴 License」
```

## 能力

- **登录**：
  - `网页登录`：与 Comate CLI 相同。插件生成一个 clientId，打开 `comate.baidu.com/zh/login?track=COMATE_CLI&clientId=…`，在浏览器里登录并授权后，插件每 2 秒轮询 `/api/client/generate/token`（3 分钟内），拿到 token 再换出账号的 **License**（`/api/client/key`）。无监听端口。
  - `粘贴 License`：comate.baidu.com/user 页面上的 License，插件先用 `/api/key/valid/<license>` 校验一次。
  - License 就是凭据，没有续期；失效后请求返回 401，重新登录即可。
- **模型**：按 CLI 的做法读账号的模型清单（`POST /api/v2/api/models/available`，缓存 5 分钟），模型 id 即清单里的 `modelId`。取不到清单时只有 `auto`（文心快码的默认模式）。支持思考的模型打开 `thinkingEnabled`，支持思考档的模型透传 `reasoning_effort`。
- **聊天**：每个请求是一次 Comate 智能体回合：`conversation → task → execute(SSE)`。插件用 CLI 自带的「自定义智能体」形态（`isProjectAgent: true`、`agentPrompt`、`tools: []`）：请求的 system 提示作为智能体提示词，不带文心快码的服务端工具。整段对话写进本回合的 query，不复用跨请求会话。`ANSWER` 帧的 `delta` / `reasoningDelta` 转成 OpenAI 的 `content` / `reasoning_content`，`TOKEN_USAGE` 转成 `usage`。流式与非流式都支持。
- **工具与图片**：工具以 JSON 文本协议适配（与 catpaw 插件相同）：工具定义写进提示词，模型按 `{"tool_calls":[…]}` 回复，插件解析回 OpenAI `tool_calls`；`tool_choice=required` / 指定工具时，未拿到调用会带上下文重试一次。图片无法经文本送达，带图片的请求以 **400 明确拒绝**。
- **错误**：`code 401` → 401（License 失效）；`code 429`、`QUOTA_EXCEED`、`DOWNGRADE` → 429（用量超限，原文透出，不编造重置时间）；`EXCEPTION` → 错误。
- **用量（usage）**：文心快码对外没有可按 License 读取的额度接口（客户端自己的额度查询在百度内网域名上），卡片只显示 License 是否有效。

## 协议细节

- 请求头（CLI 原样）：`login-name` / `Uuap-login-name: encodeURIComponent(license)`、`X-Source: COMATE`、`plugin-version: zulucli-1.7.16`、`x-skip-fcnap: yes`、`Accept-Language: zh-CN,zh`、`X-Trace-Id`（execute 另带 `x-query-id`）。
- 请求体都带 `{username: license, ide: "zulucli", ideVersion, pluginVersion}`；execute 带 `agentVersion: 12`、`modelKey`、`modelProvider`。
- 智能体接口前缀：`/api/aidevops/autocomate/rest/autowork/v2`。

未经真实账号确认的部分：服务端是否对顶层自定义智能体采用 `agentPrompt` 且不附加内置工具与提示；conversation / task 需要的字段是否齐全；`thinkingEnabled` / `effort` / `contextWindow` 是否被接受；真实模型 id；限额帧的确切形态。

## 环境变量（测试 / 镜像用）

| 变量 | 默认 |
|---|---|
| `COMATE_ORIGIN` | `https://comate.baidu.com` |

## 测试

```
bun test packages/comate
```

测试打到进程内的假上游（替换 `fetch`），不触网、不使用真实 License。

## 许可

MIT。
