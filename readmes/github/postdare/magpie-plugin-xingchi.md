# magpie-plugin-xingchi

星驰 API 网关（<https://api.xingchiapi.com>）的 magpie / OpenCode 供应商插件。

网关是 OpenAI Responses 兼容的编程客户端网关，只放行已知的编程客户端；插件负责
两件网关特有的事：**User-Agent 白名单**和**Responses 协议改写**。

## 安装

```sh
magpie plugin add postdare/magpie-plugin-xingchi   # 从 GitHub 装
magpie plugin login xingchi                        # 输入 sk-… key
magpie provider test xingchi                       # 冒烟
magpie quota                                       # 看额度
```

也可以把仓库克隆下来就地加载：

```sh
magpie plugin add ./magpie-plugin-xingchi
```

之后模型以 `xingchi/gpt-5.6` 这样的 id 出现。

## 选 UA

网关按 UA 第一段放行客户端，UA 就是「用哪个客户端身份访问网关」：

```sh
magpie plugin options magpie-plugin-xingchi '{"userAgent":"claude"}'
```

可用预设：`opencode`（默认）、`claude`、`cline`、`cursor`、`omp`、`pi`、`kilo`、`roo`，
也可以直接给完整的 UA 字符串。不选时保留上游 agent 自带的 UA（若在白名单里）。
详见下面的「User-Agent 白名单」。

## 网关限制与本插件的处理

### 1. User-Agent 白名单

网关按 UA 的**第一段**（`/` 之前）判定客户端。实测规则：

- 只看第一段，版本号不参与校验（`opencode/任意版本` 都放行，`zzz/1.0` 被拒）；
- 大小写不敏感（`OPENCODE/1.0` 与 `opencode/1.0` 都放行）；
- 必须是 `<token>/…` 的形式，单独的 `opencode` 被拒。

实测放行的 token：

`claude-cli`、`claude-code`、`opencode`、`omp`、`pi`、`cline`、`cursor`、`trae`、
`qoder`、`minis`、`zcode`、`hermes`、`hermes-agent`、`workbuddy`、
`deepseek-harness`、`kilo-code`、`roo-code`

其余（例如 Bun 默认的 `Bun/1.4.2`）返回 403：

```json
{"error":{"code":"client_not_allowed","message":"本站仅支持编程客户端使用：…"}}
```

网关自报的支持列表（Codex、Kilo、Roo、Copilot、Grok）与实际放行集**不一致**：
`codex_cli_rs`、`kilo`、`roo`、`copilot`、`grok-cli` 实测都被 403 拒绝。

#### 选 UA

UA 就是「用哪个客户端身份访问网关」，所以插件把它做成可选项：

```sh
# 预设名（客户端名 + 该客户端的真实版本格式）
magpie plugin options magpie-plugin-xingchi '{"userAgent":"claude"}'

# 或完整的 UA 字符串
magpie plugin options magpie-plugin-xingchi '{"userAgent":"claude-cli/2.1.327 (external, cli)"}'
```

可用预设：

| 预设 | 实际发送的 UA |
| --- | --- |
| `opencode`（默认） | `opencode/1.19.6` |
| `claude` | `claude-cli/2.1.327 (external, cli)` |
| `cline` | `Cline/3.0.74` |
| `cursor` | `Cursor/1.0.3` |
| `omp` | `omp/18.22.2` |
| `pi` | `pi/1.5.2 (darwin; node; arm64)` |
| `kilo` | `kilo-code/7.8.27` |
| `roo` | `Roo-Code/3.0.0` |

每个预设的客户端名和版本号都取自该客户端自己（npm 上的当前版本 /
客户端自己的 UA 构造代码），不是随手编的。

不选时的行为：

- 上游 agent 自带的 UA 若在白名单里就**原样保留**（例如 Claude Code 的
  `claude-cli/2.1.327 (external, cli)`），网关看到的仍是真实客户端；
- 否则替换成默认的 `opencode/1.19.6`；
- 若选中的 UA 被网关 403 拒绝（`client_not_allowed`），插件自动用默认 UA 重试一次。

### 2. Responses 协议

网关实测行为：

| 网关行为 | 插件的改写 |
| --- | --- |
| `previous_response_id` → `previous_response_id is not available for this user` | 删除该字段 |
| `store: true` 无链可用 | 强制 `store: false`，每轮全量回放上下文 |
| `input` 数组里的 `system` / `developer` 角色被丢弃；只发这些角色时上游报 `One of "input" or "previous_response_id" … must be provided` | 提升为 `instructions`；若 input 里只剩 system，则降级成一条 user 消息 |

`chat/completions` 形态的请求体（含 `messages`）原样放行。

### 3. 按模型的上游通道

网关按模型分上游通道，各通道的能力和健康度不同：

- **部分模型不支持工具调用**：`gpt-6.1-sol`、`gpt-6.1-terra` 在 `/v1/responses` 和
  `/v1/chat/completions` 上带 `tools` 都会被拒（与推理无关）：

  ```
  gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions
  ```

  插件给这两个模型标 `tool_call: false`，让 agent 别选它们跑工具活。
  `gpt-5.6`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-sol`、`gpt-6-astra` 实测工具调用正常。
  （`gpt-6-luna` 的拒绝信息带 "with reasoning" 限定，疑似只是推理+工具的组合受限，
  未能单独确认，故不标 `tool_call: false`。）
- **限流很重**：`Upstream rate limit exceeded`、`Service temporarily unavailable`
  是上游账号的配额与抖动，与协议无关；换个模型或过一会儿就好。

### 4. 其他已验证事实

- 工具调用：Responses 的 `function_call` / `function_call_output` 与 chat 的
  `tool_calls` / `tool` 角色都正常；`strict: true` 也被接受。
- 推理：`reasoning.effort`（Responses）与 `reasoning_effort`（chat）接受
  `minimal / low / medium / high / xhigh / max`。
- 流式：Responses 返回标准 `response.*` SSE 事件；chat 返回标准 `chat.completion.chunk`。
- 上下文：实测 gpt-5.6 接受 600k+ token 的输入（网关不截断）。
- 图片模型（`gpt-image-*`）在本账号未开通（`Image generation is not enabled for this
  group`），插件不暴露它们。

## 模型

`xingchi` 供应商默认暴露 16 个文本模型：`gpt-5.6[-sol|-terra|-luna]`、`gpt-6[-sol|-luna|-astra]`、
`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-5.5`、`gpt-5.4[-mini]`、`gpt-5.3-codex-spark`、
`gpt-5.2`、`codex-auto-review`。

其中 `gpt-6.1-sol`、`gpt-6.1-terra` 标为不支持工具调用（见上）。

上下文/输出上限取 omp 内置目录里同名 id 的值（`gpt-5.6-*`、`gpt-6-*` 为 272000/128000，
`gpt-6.1-*` 为 500000/128000），目录里没有的用通用默认 128000/32768。

登录后插件会再打一次 `/v1/models`，把网关上新出现的文本模型补进列表（用保守的
上下文/输出上限），图片模型过滤掉。

## 用量

`/v1/usage` 返回 `{ quota: { limit, used, remaining, unit }, usage: { today, total } }`，
插件把它映射成 magpie 的额度窗口与余额。

## 自行测试

```sh
bun test                              # 单元：UA 选择 + 请求体改写
XINGCHI_API_KEY=sk-… bun run scripts/smoke.mjs   # 打真实网关
```
