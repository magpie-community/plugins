# Trae Global (trae.ai) for OpenCode / magpie

Trae 国际版（trae.ai，ByteDance 的 AI IDE 国际部署）作为 OpenCode provider 插件：
用 Trae 国际版 IDE 自己的浏览器登录流程签入你的账号，免费额度可用，
模型走国际版的 `llm_utils_chat` 网关。

与 `@magpie-community/opencode-trae-auth`（Trae CN）的关系：**同一套插件契约与
同一套请求/应答机制，另一套部署**。国际版与国内版是完全独立的服务（不同域名、
不同 client 生态、模型目录几乎不重叠），所以是一个独立插件，不是配置项。机制
部分（工具调用解析、流收尾、max 档位、reply limit）跟随 CN 0.1.14。

## 端点（与 CN 版的差异）

| 项 | Trae CN | Trae Global (本插件) |
| --- | --- | --- |
| 授权页 | `https://www.trae.cn` | `https://www.trae.ai` |
| token/账号/积分 | `https://api.trae.cn` | `https://growsg-normal.trae.ai` |
| 模型网关（SG） | `https://trae-api-cn.mchost.guru` | `https://coresg-normal.trae.ai` |
| 模型网关（US） | — | `https://coreva-normal.trae.ai`（按账号 region 自动路由） |
| OAuth ClientID | SOLO: `en1oxy7wnw8j9n` / IDE: `ono9krqynydwx5` | 两者同: `ono9krqynydwx5` |
| IDE 版本 | 3.3.x | 3.5.x |

依据：wangqi233/trae2api 的 realm 表（cn/sg 双区域实测），本插件按 SG realm 配置。

## 登录

`auth.login` 选 **Trae Global account (browser)**：本插件起一个 127.0.0.1 回调，
打开 trae.ai 的授权页，你在浏览器里登录国际版 Trae 账号并允许，页面会把
token 送回本机，签入自动完成。token 过期前插件自动续期（ExchangeToken）。

前提：你的账号是 **trae.ai（国际版）** 的账号。trae.cn 的账号签不进 trae.ai。

美区账号：回调的 `AIRegion` 为 US（或 Host 是 `api-us-east.trae.ai` 这类认证
主机）时，模型请求自动走 `coreva-normal.trae.ai`；SG 账号不受影响。

## 模型

签入后模型列表从国际版网关实时拉取（`get_detail_param` / `batch_get_detail_param`，
跨 `chat_v3`、`solo_work_lite`、`solo_agent`、`solo_agent_lite` 四个 function 合并）。
国际版常见模型是 GPT / Gemini / Kimi / MiniMax / DeepSeek-V3 系列（与 CN 版的
GLM/Qwen/Doubao/Kimi-K2.7 几乎不重叠）。未签入时显示内置的静态表。

一个模型在清单里带 `__max` 条目和更大的 `context_window_tokens.max` 时，会作为
第二个模型列出（`<id>-max`，名字加 "(Max)"，窗口与输出上限取 max 档的）：
请求它时改发该模型的 `__max`，并按 IDE 的 Max 模式带上
`user_message_context.model_info.prompt_max_tokens`（max 窗口 − max_tokens）。

模型的回复上限取清单给的 `__dev` 条目的 `max_tokens`；清单没给的就是没有（0），
magpie 会从 models.dev 补，插件不编一个数。

## 工具调用

Trae 的 chat 没有原生 tool-call 轮次：工具原生带给它、也写进系统提示词，模型
可能以 `<tool_call>{...}</tool_call>` 文本块（含 GLM 的 `arg_key/arg_value`
模板、DeepSeek 的 DSML 标签收尾）或原生分片事件回复，两种都解析成 OpenAI 的
tool calls；写在正文里的 `{"reasoning_content":...}` JSON 是思维链不是回答；
未命名/错名事件里的正文不丢；失败的回复以错误和 `[DONE]` 收尾，不谎报 stop。

## 思考强度（reasoning effort）

Trae 的请求不接收思考强度：本插件不给模型声明任何档位，客户端的思考档选择
对 Trae 无效（选了也照常回答）。dev/max 是上下文档位，不是思考档。

## 用量

用法卡片显示账号的 **Dollar Usage**（美元额度，2026-02 起国际版的计费方式）：
各 entitlement pack 的额度（`basic_usage_limit` + `bonus_usage_limit`）与已用
（`basic_usage_amount` + `bonus_usage_amount`），在 Credits 式的窗口行里按
百分比展示。免费计划是 $1/月的额度池（另有 10 次快速 + 50 次慢速 + 1000 次
高级模型的请求次数限制，插件暂不展示次数）。

接口走 `api-sg-central.trae.ai`（美区账号走 `api-us-east.trae.ai`）的
`/trae/api/v1/pay/user_current_entitlement_list`——认证主机自己的
`/cloudide/api/v2/pay/*` 对插件 scope 返回 403 Api Scope Forbidden。

## 图标

`package.json` 的 `magpie.icon` 是 Trae 官网的 favicon（`lf16-web-neutral.traecdn.ai`
的 48×48 PNG）以 data URI 内嵌——与 MiMo 插件同一做法，magpie 直接取用，不联网抓图。

## 本地开发

```sh
bun test          # 全部测试（fake 掉所有 Trae 主机，不出网）
```

改完源码接入本机 magpie 验证时（`file:` 依赖是 copyfile 安装，必须重跑）：

```sh
bun install --cwd ~/.config/magpie/plugins --backend=copyfile --force
```

然后完全重启 magpie（插件模块被进程缓存）。
