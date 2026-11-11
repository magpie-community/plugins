# 书生 TokenPlan — Magpie 供应商插件

零依赖 ESM 插件，版本 `0.1.1`，供应商 ID 固定为 `tokenplan`。使用 TokenPlan API Key，把 Magpie 已转换的 OpenAI Chat Completions 请求转发到固定官方地址 `https://discovery-api.intern-ai.org.cn/v1`。`@ai-sdk/openai-compatible` 是宿主选择的协议适配器，不是本包需要安装的依赖。

支持文本、多轮消息、图片消息、工具消息及 SSE 透传。工具能力默认关闭，可通过全局默认或逐模型覆盖显式开启并实测。不实现浏览器登录、SystemOne、余额查询、美元价格估算、独立代理服务或客户端协议转换。

## 安装与登录

源码仓库：[kasisama/magpie-intern-tokenplan](https://github.com/kasisama/magpie-intern-tokenplan)。先安装可用的 Magpie，再克隆本插件；无须 `npm install` 或构建。

```sh
git clone https://github.com/kasisama/magpie-intern-tokenplan.git
cd magpie-intern-tokenplan
```

以下命令在克隆后的项目目录执行：

```sh
magpie plugin add .
magpie plugin login tokenplan
magpie plugin --json
```

也可直接使用绝对路径（Windows 示例）：

```sh
magpie plugin add "E:/MyFile/MyProject/AI/intern"
magpie plugin login tokenplan
```

在 Magpie 提示的 `TokenPlan API Key` 输入框输入密钥。也可在 Magpie 的插件界面添加这个目录，然后在「书生 TokenPlan」供应商上登录。不要把 Key 写入插件 options、代码、聊天记录或命令参数。登录时可填写可选的 Account label（例如 Personal / Work，留空也可）。通过 Magpie 的 prompts 契约保存为 `metadata.email`，仅用作账号显示名称，不要求真实邮箱，不发送给上游。Magpie 保存 `{type:"api",key,metadata?}`；本插件不另存密钥。简单 API 登录本身仅保存输入，随后账号模型发现请求 `GET /v1/models` 才验证 Key。

`magpie` 未加入 PATH 时，用本机 Magpie 可执行文件路径替换命令中的 `magpie`。例如 PowerShell 中使用 `& 'E:/SoftWare/Magpie-ai/magpie-windows-amd64.exe' plugin --json`。

修改源码后，在应用中把插件关掉再开启；终端命令每次会加载当前源码。卸载或退出登录：

```sh
magpie plugin logout tokenplan
magpie plugin rm 'E:\MyFile\MyProject\AI\intern'
```

插件标识必须逐字使用 `magpie plugin --json` 中的 `spec`（本地目录安装通常是完整路径），不要把 provider ID 当作所有插件管理命令的插件名。Windows 下 add 接受正斜杠，但保存的 spec 可能转换成反斜杠；options/rm 按保存的 spec 匹配。上述 rm 和下方 options 示例使用本次隔离安装实际返回的反斜杠路径。

## Claude Desktop 使用路径

使用路径是 Claude Desktop → Magpie → TokenPlan。先在 Magpie 中完成插件添加和登录，确认账号模型列表，再使用当前 Magpie 版本提供的 Claude Desktop 接入功能或网关连接配置，选择 `tokenplan/<精确模型 ID>`。例如 `tokenplan/intern-s2`、`tokenplan/Atria-Dawn`。大小写必须一致。

本插件只实现 Magpie 供应商契约，不给 Claude Desktop 增加新的设置接口。已核对的 Magpie CLI 帮助中的 `claude` 指 Claude Code，不能据此推断它是 Desktop 命令。本项目没有修改 Desktop/Claude Code/Codex 配置，也不要求设置它们的官方直连环境变量；实际 Desktop 接入步骤以所用 Magpie 版本的界面和文档为准。本版尚未完成真实 Desktop 端到端联调。

## 模型发现与本地预算

登录前显示下表的文档快照；账号登录后，仅使用官方 `/models` 返回的 `data[].id` 作为账号可见集合，保持大小写并去重。并列的 `models[]` 决策列表不参与合并，`SystemOne`、`jev-*` 和 `intern-decision-*` 不接入聊天。成功返回空 `data` 时，账号模型列表就是空列表，不恢复无权限模型。

| 模型 ID | 文档上下文 | 图像输入 |
| --- | ---: | :---: |
| intern-s2 | 256K | 是 |
| Atria-Dawn | 512K | 否 |
| Agents-A1 | 256K | 是 |
| Sage-A1.5 | 256K | 是 |
| deepseek-v4.1-flash-1017 | 1M | 否 |
| deepseek-v4-pro-0813 | 1M | 是 |
| glm-5.3 | 1M | 否 |
| kimi-k2.6 | 256K | 是 |
| minimax-m3 | 1M | 否 |
| qwen3.8-27b | 256K | 是 |

本地将 K/M 按 1024/1048576 换算。这是配置约定，不代表已测出平台精确边界。官方参考未给出逐模型最大输出和 Tool Call 保证。为满足宿主 normalized model 的数值 `limit`，默认输出预算为 8192 token，为代码和较长回答预留更多空间，仍可按需调低；未知模型上下文预算为 32768 token。两者都是**本地兼容预算，不是官方限制**，也不会在 fetch 中截断内容或擅自重写用户的 `max_tokens`。

未知模型默认仅文本，不声明工具、推理能力。config 使用 `tool_call/modalities`，账号 hook 使用 `api/limit/capabilities.toolcall`，二者由同一个解析器生成；账号 hook 保留宿主 `provider.models` 的名称、上下文/输出预算、能力、variants、headers、options、cost 等元数据。插件本身不推算美元 cost、倍率、余额或永久 free 标记。宿主可能把缺失的 cost 展示为 0，这不表示平台免费。

## Options 与工具启用

只接受四个顶层字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `defaultOutputTokens` | `8192` | 没有显式模型预算时的默认输出兼容预算 |
| `defaultToolCall` | `false` | 没有显式模型配置时，默认是否声明工具支持 |
| `unknownContextTokens` | `32768` | 未知模型的上下文兼容预算 |
| `modelOverrides` | `{}` | 精确模型 ID 到覆盖项的映射 |

每个覆盖项只允许 `contextTokens`、`outputTokens`、`toolCall`、`image`。token 数必须为安全正整数，输出不能大于上下文；后两个字段必须是布尔值。未知字段、字符串数字、null 等会导致加载报错，错误不回显配置值。不接受 apiKey、baseURL、重试参数或任意请求头。覆盖项不会把不在账号 `data[]` 中的模型增加到账号列表。

合并优先级：`modelOverrides` > 宿主 normalized `provider.models` > 已核对的官方上下文/图像快照及本地默认。账号 `/models` 只决定可见 ID，不采信任意远端能力字段。模型 ID、API URL 和 SDK 固定使用发现 ID 与官方 Chat 路径，避免元数据把请求导向其他目标。显式输出预算大于上下文时报错；只有默认输出预算会收缩到模型上下文以内。缓存保存账号 ID 集合，临时回退时仍应用当前配置。

常用本地输出预算：`4096` 用于短回答、`8192` 为默认、`16384` 用于长代码输出；这些不是官方能力档位或保证。更大预算可能增加实际消耗，客户端显式传入的 `max_tokens` 不会被插件重写。

批量启用工具的 options 示例：`{"defaultToolCall":true,"modelOverrides":{"intern-s2":{"toolCall":false}}}`。全局值是默认值，已有逐模型设置优先；设为 `false` 可恢复保守默认，显式开启的模型需同时改为 false。

例如，对 `intern-s2` 显式开启工具并设置本地输出预算（这是待验证配置示例，不是已验证工具能力的声明）：

```sh
magpie plugin options 'E:\MyFile\MyProject\AI\intern' '{"defaultOutputTokens":8192,"unknownContextTokens":32768,"modelOverrides":{"intern-s2":{"outputTokens":8192,"toolCall":true,"image":true}}}'
magpie plugin options 'E:\MyFile\MyProject\AI\intern'
```

上述单引号 JSON 可用于 Bash 或 PowerShell 7 的现代参数传递；旧版 Windows PowerShell 若破坏原生程序参数内的引号，可使用 Magpie options 界面或编辑其隔离配置中的插件 `options` 对象。恢复默认：

```sh
magpie plugin options 'E:\MyFile\MyProject\AI\intern' off
```

底层透传支持工具定义、`tool_choice`、`tool_calls`、`tool_call_id` 和工具结果。只有显式开启模型工具广告后，宿主才应向它分配工具任务。开启不代表上游必然支持，需用无副作用工具做一次完整往返验证。

## 请求、安全与失败语义

- 只允许官方 origin 的 `GET /v1/models` 与 `POST /v1/chat/completions`，拒绝其他路径、URL 凭据、query、fragment；不跟随重定向。每次 fetch 最多发一次上游请求。
- 认证总是由当前账号 Bearer Key 覆盖；删除来路 API Key、代理认证和 Cookie 等冲突头。每个 loader 闭包独立持有账号 Key。
- 仅删除顶层 `reasoning`、`reasoning_effort`、`thinking` 和 `output_config.effort`；保留 `output_config` 其他字段以及消息历史、用户文本、工具 schema 的同名数据。
- 仅给消息 content 中缺少 `detail` 的 `image_url` 对象补 `auto`，保留 URL、Base64、显式 low/high/auto。图片格式与尺寸由上游校验，不额外下载图片。
- 成功响应直接返回，绝不读取或缓存成功 SSE，不拼接文本、不吞工具 delta、不补写 DONE。AbortSignal 传给上游，消费者可取消响应流。
- 错误保留 HTTP 状态、body、`Retry-After`、`X-Request-Id`。JSON 错误 clone 检查最多 64 KiB、250 ms，不等待单独 tee 分支的 cancel 完成。非 JSON、未知错误、过大或慢正文退回状态判断。
- 401 标记 `expired`；403 的 `api_key_disabled` / `user_disabled` 标记 `expired`；`whitelist_required` 和其他 403 标记 `kept`。429 限速/额度错误原样保留，其他 HTTP 错误也不伪装成成功。
- 模型发现异常只报告安全的状态、已知错误码和 `signIn`，不回显原始上游错误文本、Key 或账户数据。排错时从原始响应的 `X-Request-Id` 提供请求编号给官方支持。

模型发现限制：请求超时 15 秒、正文读取 5 秒、正文最多 1 MiB。仅缓存成功结果，缓存只在当前插件进程内，按 Key 的 SHA-256 隔离，最多 64 个账号，成功结果 15 分钟后失效。网络/超时/408/限速 429/5xx 临时失败才可退回当前账号的最近成功结果，并设置 `Symbol.for("magpie.fellBack")`；明确的 `quota_exceeded` / `insufficient_balance` 不退回。认证、权限、格式等非临时错误使本地缓存失效。无成功缓存时明确抛错。

Magpie 的公开契约规定 hook 抛错时宿主可能保留自己的旧模型列表；本插件无法清除宿主内部持久缓存。上面的缓存规则描述的是插件自身行为。

## 限额与价格快照

官方文档说明生成 RPM 默认为每用户 50，TPM 为 2,000,000；5 小时/7 天墨点限额和余额由同一用户全部 Key 共享。多个 Key 不增加额度。本包 `magpie.maxConcurrency: 4` 仅为每账号并发建议，用户可在宿主覆盖，**不是平台 RPM 限制器**。

插件不重试、不轮换 Key。Magpie 宿主按自己的故障切换规则处理 429 和 5xx，可能切换账号或模型；插件公开契约不能保证整个宿主请求只调用一次。不要用多 Key 绕额度，也不要把 HTTP 错误改成成功来避免宿主处理。开始输出后的流不由插件重放。

以下为用户提供的官方文档快照（2026-10-24），单位均为**墨点 / 百万 token**，不是美元。限时免费和价格随平台调整：

| 模型 | 缓存命中输入 | 未命中输入 | 输出 |
| --- | ---: | ---: | ---: |
| intern-s2（限时免费） | 0 | 0 | 0 |
| Atria-Dawn（限时免费） | 0 | 0 | 0 |
| Agents-A1（限时免费） | 0 | 0 | 0 |
| Sage-A1.5（限时免费） | 0 | 0 | 0 |
| deepseek-v4.1-flash-1017 | 20 | 1000 | 4000 |
| deepseek-v4-pro-0813 | 150 | 4500 | 13500 |
| glm-5.3 | 2000 | 8000 | 28000 |
| kimi-k2.6 | 1100 | 6500 | 27000 |
| minimax-m3 | 420 | 2100 | 8400 |
| qwen3.8-27b | 100 | 800 | 2700 |

参考：[TokenPlan 官方模型与定价](https://discovery.intern-ai.org.cn/token-plan/home?tabIndex=3&dockey=04-model-limits-and-pricing.md)。已知文档矛盾：价格公式写 `/1000`，但单位和示例按每百万；决策输入有 `0.2` 与 `200` 两种写法；Anthropic version 有 `1.0` 与 `2023-06-01`。当前 Chat 路径不依赖后两项，插件不实现估算账单。余额与额度请在官方平台查看，`magpie quota` 不会从本插件得到 usage 数据。

## 验证与后续实测

```sh
node --test test/*.test.mjs
# 或
npm test
# 已有 Bun 时
bun test test
```

GitHub Actions 在 main 更新、版本标签及 PR 时运行 Node 24 / Bun 1.4.3 测试、语法检查和 npm pack 检查；不发布 npm 包。

测试使用假 Key 与模拟响应，涵盖模型契约、账号隔离/缓存、严格 options、固定目标、工具/图片请求保真、SSE 分片和取消、错误状态与有限正文检查。依赖列表为空。

开发时使用单独 HOME/XDG，避免影响现有配置（Bash 示例）：

```sh
sb=$(mktemp -d)
m() { env HOME="$sb" USERPROFILE="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" XDG_DATA_HOME="$sb/.data" MAGPIE_NO_ACCOUNTS=1 MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m --help
m plugin --help
m plugin add "$PWD" </dev/null
m plugin --json
```

隔离缓存没有 Bun 时，Magpie 可能下载它；可先把已缓存的运行时复制到隔离缓存对应的 `magpie/bun/<版本>/magpie-bun.exe`，不要把整个真实配置或认证文件复制进来。未登录时 `provider.models` 报缺少 API Key 是预期行为；配置快照不代表已获取账号权限。

本版已验证 Node v24.9.0、Bun 1.4.3 的测试和隔离 Magpie 的本地插件加载、认证方法及模型声明。2026-10-24，用户反馈已完成两次聊天测试、多个模型可正常使用；未记录具体模型 ID，不据此声明所有模型或特定能力均已验证。自动化测试使用假 Key，工具调用和视觉能力仍需真实端到端实测。

取得用户授权后，可在隔离环境登录并逐项实测：

1. `m plugin login tokenplan`，检查 `m plugin --json` 中的账号模型。
2. 确认当前价格与可能消费后，运行 `m provider test tokenplan intern-s2` 做最小 Chat 请求。
3. 通过实际客户端做短文本流式和两轮对话；为待测模型显式开启 `toolCall` 后做一个无副作用工具往返。
4. 视觉模型可追加一张普通测试图，检查识别和取消行为。
5. 记录具体模型 ID、日期和能力结果；完成后 `m plugin logout tokenplan`。

本项目的自动化验证不发送真实付费请求。用户手动聊天反馈不等同于完整 Claude Desktop 联调或全模型工具支持验证。
