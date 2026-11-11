# magpie-aicodemirror-auth

一个 Magpie 供应商，同时提供 **AICodeMirror 模型调用和账户余额**。零运行时依赖，无需构建。

## 安装

```powershell
magpie plugin add magpie-aicodemirror-auth
magpie plugin login aicodemirror
```

显示名为 **AICodeMirror**，供应商 ID 为 `aicodemirror`。已有同名供应商配置会保留，模型和余额使用同一个 ID。已验证 Magpie 0.1.824 的动态登录接口。原生 OpenCode 不支持此流程所需的 Magpie `ask` / `auth.usage` 扩展。

账户按真实网站账户和所选 Key 区分，支持多个 Key。

## 添加账户

1. 登录 https://www.aicodemirror.ai ，打开开发者工具 → Network，刷新钱包页面，复制 `/api/wallet` 请求的 **Cookie 请求头值**。
2. 在 Magpie 选择 **Cookie 登录并选择 API Key**，粘贴 Cookie。
3. 验证会话后选择 Key 名称。禁用或过期的 Key 不参与选择，选项仅包含名称、ID 和提示，不含完整密钥。
4. 选择全球线路、国内优化线路或自定义 HTTPS 根地址。
5. 选择总余额、订阅或按量。插件验证所选线路的模型列表后完成添加。

**Magpie 的普通提问框目前为明文输入，Cookie 不会自动遮蔽。** 不要在共享屏幕时输入，不要把 Cookie 或 Key 发到聊天、日志或仓库。输入错误导致步骤失败时，可取消后重试。

API Key 从网站接口获取，无需手动复制。凭据保存在宿主 `plugin-auth.json`：`access` 为 Cookie，`apiKey` 为所选模型密钥。模型接口只发送 API Key，网站接口只发送 Cookie。Cookie 过期后模型调用仍可使用已保存 Key；重新登录可更新 Cookie 或切换 Key。

账号显示如 `真实账号名 · cli · 按量`；优先使用网站用户名、名称、邮箱，再回退到手机号。余额字段仍为纯金额。

用户名、钱包和 Key 列表接口使用 `node:http2`，发送完整 Chrome User-Agent，不添加 Referer 或 Client Hints；不跟随重定向，也不回退到 HTTP/1.1。已验证 Magpie 0.1.1247 会为 HTTP/2 连接继承全局、供应商和账户代理；旧宿主需要升级以支持 HTTP/2 代理。每次查询单独建立并关闭连接，避免跨账户或代理复用。模型请求和模型目录继续使用宿主 `fetch`。

若提示 **Cloudflare 安全验证拦截**，网站返回的是验证页面，插件尚未拿到账号数据，不能据此判断 Cookie 已过期。请先确认 Magpie 版本和网络/代理设置，再在浏览器检查网站登录状态、必要时复制最新 Cookie。HTTP/2 与完整 UA 已在本机恢复访问，但不保证网站后续风控始终放行；持续失败需联系网站支持。插件会保留已有 API Key，验证拦截也不会将网站会话标记为过期。

## 线路和模型

| 线路 | 根地址 |
| --- | --- |
| 全球 | `https://api.aicodemirror.ai` |
| 国内优化 | `https://api.claudecode.net.cn` |
| 自定义 | 明确填写的 HTTPS 根地址，不含 `/v1` 等路径 |

代理沿用 Magpie 设置，不自动切换线路或重试生成请求。网站 API 固定为 `https://www.aicodemirror.ai`，不随模型线路改变。

模型列表直接读取所选线路的 `/v1/models`。列表可能包含当前 Key 无权限调用的模型。协议按模型 ID 前缀匹配（区分大小写）：

| 模型前缀 | 协议 | 生成接口 |
| --- | --- | --- |
| `claude-` | Anthropic Messages | `/v1/messages` |
| `gpt-` | OpenAI Responses | `/v1/responses` |
| `gemini-` | Gemini | `/v1beta/models/{model}:generateContent` 或 `streamGenerateContent` |
| `grok-` | OpenAI Chat Completions | `/v1/chat/completions` |

未匹配的模型（包括 `o1`、`o3`）不设置 `api.npm`，仅保留所选线路的 `/v1` 地址。当前 Magpie 对这类插件模型回落到 Chat Completions，并非自动探测协议。

保留流式响应、工具调用请求内容和取消信号；上游状态交由 Magpie 处理。模型列表查询不依赖网站 Cookie；模型目录暂不可用时回退到登录时保存的模型 ID。API Key 被上游拒绝时提示重新登录。

模型列出不保证网站渠道允许所有客户端。Claude SDK 文档要求适用于 Claude Code 之外场景的渠道；如渠道仅允许官方客户端，需要用户在网站选择兼容渠道。插件不会改动网站渠道或冒充官方客户端。

插件返回模型 ID、名称及调用协议和地址，不设置固定长度。上下文、最大输出长度和图片输入由 Magpie 按模型 ID 参考 models.dev 补全。需要调整长度时使用 Magpie 自带设置。

推理等级由插件读取 `https://models.dev/api.json` 补齐：按模型 ID 精确匹配 Anthropic、OpenAI、Google、xAI 原厂条目，只使用 `reasoning_options` 中明确列出的 `effort` 等级，并生成相应协议的 `variants`。仅支持思考开关或 token 预算的模型不会被人为添加等级。未匹配到的模型仍可使用。目录请求不携带 Cookie 或 API Key，超时为 5 秒；在插件实例内存中缓存 6 小时，并合并并发刷新。更新失败保留旧目录、5 分钟后允许重试；首次读取失败时模型列表仍正常返回，但暂不补全等级。重启插件会清空此缓存。

接口来源：[Claude](https://www.aicodemirror.ai/dashboard/sdk-docs)、[OpenAI](https://www.aicodemirror.ai/dashboard/openai-sdk-docs)、[Gemini](https://www.aicodemirror.ai/dashboard/gemini-sdk-docs)、[Grok](https://www.aicodemirror.ai/dashboard/grok-api)、[Magpie 插件文档](https://usemagpie.ai/docs/plugins)。

## 余额显示

| `balanceDisplay` | 金额 | 账号后缀 |
| --- | --- | --- |
| `all`（默认） | 订阅 + 按量余额 | 无后缀 |
| `subscription` | 订阅余额 | 订阅 |
| `paygo` | 按量余额 | 按量 |

选项随账户保存，也可编辑 `~/.config/magpie/plugins.json`（遵循 `XDG_CONFIG_HOME`），在已有插件条目添加 `options.balanceDisplay`，覆盖所有账户的展示：

```json
{
  "spec": "magpie-aicodemirror-auth",
  "options": { "balanceDisplay": "paygo" }
}
```

这只是 `plugins` 数组中的一个条目，不要覆盖整个文件。修改后重载 GUI 插件，终端下次运行即加载。余额选项只影响展示，不决定扣费来源。

`/api/wallet` 的 `balance` 为订阅余额，`bonusBalance` 为按量余额，单位整数厘。总额先精确相加再转为元，最多显示三位小数；缺少所选字段时报错，不推算用量比例和重置日期。

## 验证

Magpie 0.1.970 的 `provider test aicodemirror <Gemini模型>` 会错误地使用 Chat Completions，导致请求被插件拦截。这不代表模型不可用；可通过本地网关或实际对话验证。已通过本地网关对 `gemini-3.8-flash` 完成真实生成请求（HTTP 200，返回 `OK`）。

```powershell
npm test
npm run check
npm pack --dry-run
magpie quota aicodemirror
```

测试覆盖动态登录、分页和失效 Key、模型列表、推理等级、各协议认证、流式转发、取消、余额与模型认证隔离。网站请求通过本地 HTTPS/HTTP2 服务验证协议、证书校验、取消、响应大小限制及重定向。若本机有 Magpie 缓存的 Bun 和插件宿主，还会在临时目录以合成凭据运行完整宿主测试，网站请求经过本地 CONNECT 代理，不修改真实配置。其他机器可指定 `MAGPIE_TEST_HOST` 和 `MAGPIE_TEST_BUN`。测试证书和私钥仅用于本地模拟服务，不是生产凭据。

网站会话、Key 列表与 `/v1/models` 已完成真实只读验证。各协议的认证、流式和取消通过模拟接口与实际 Magpie 宿主验证，真实生成仍取决于所选渠道权限和上游服务。
