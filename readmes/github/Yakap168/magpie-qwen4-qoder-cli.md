# Qwen4-Max via Qwen Code (Qoder) for magpie

[![magpie plugin](https://img.shields.io/badge/magpie-plugin-2a78d6)](https://usemagpie.ai/docs/plugins)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Yakap168%2Fmagpie--qwen4--qoder--cli-181717?logo=github)](https://github.com/Yakap168/magpie-qwen4-qoder-cli)

**把 Qwen Code 的限时免费额度直接接进 Magpie——像直连官方 API 一样：原生工具调用、逐 token 流式、真实用量。**

3.x 是一次架构重写：不再为每条请求启动 `qwen` CLI 进程，而是复用 Qwen Code 的 Qoder 登录凭证，把请求**直接转发**到 Qwen Code 背后的 Qoder 网关。设计思路与 DSH 的 [dsh-qwencode](https://github.com/Yakap168/dsh-qwencode) 插件一致：插件只做协议与鉴权适配，不实现任何 agent 逻辑。

---

## 3.0 变了什么

| | 0.x（CLI 包装） | 3.x（直接转发） |
|---|---|---|
| 请求路径 | 每条请求 spawn 一个 `qwen -p` 进程 | 一条 HTTPS 请求直达 Qoder 网关 |
| 首字延迟 | 短提示也要 2–15 秒（进程启动） | 通常 1 秒内开始出字 |
| 工具调用 | prompt 注入 schema，解析模型返回的 JSON | **原生 function tools**，上游直接返回 `tool_calls` |
| 流式 | 心跳保活，CLI 结束后一次性吐正文 | **逐 token 流**：正文 / 思考 / 工具参数都是增量 |
| 思考内容 | 拿不到 | `reasoning_content` 增量，Magpie 可显示思考过程 |
| usage | 按字符数估算 | 上游真实 input/output tokens（含缓存/思考明细） |
| 模型 | 只有 qwen4-max | 实时模型目录：Qwen4-Max / Preview / Qwen3.8-Max / Qwen3.8-Flash |
| 并发 | 默认 2 条 CLI | 默认 4 条 HTTP（无进程开销） |
| 凭证 | 只读 | 过期前自动刷新并原子写回，与 qwen CLI 共用同一份登录 |

旧模型 id `qwen4-qoder/qwen4-max` **保留为别名**（等价于 `qmodel_latest`），已有 Magpie 配置不用迁移。

---

## Qoder 和 Qwen Code CLI 的区别

**Qoder** 是阿里的一套 AI 编程产品（桌面端、JetBrains 插件、Qoder CLI 等），有自己的账号体系和 **Qoder Credits**。Magpie 里 `qoder-cn/qmodel_latest`（社区 qoder-auth 插件）扣的是 Qoder 套餐 Credits。

**Qwen Code CLI** 是另一个开源命令行工具（`QwenLM/qwen-code`）。它支持用 **Qoder 账号登录**，但领取的是 **Qwen Code 自己的 Qwen4 限时免费体验额度**，不是 Qoder 的 Credits。两者可以用同一个 Qoder 账号登录，但计费池不同。

本插件走的是 **Qwen Code CLI 的额度路径**：请求带着 Qwen Code 的凭证、以 Qwen Code 客户端的身份（`Cosy-ClientType: 13`、`metadata.session_type: qcode`）发给网关，和你在终端里用 Qwen Code 是同一条路。实测不扣 Qoder 套餐 Credits。

所以：

- Magpie 里的 `qoder-cn/qmodel_latest` = Qoder 套餐额度。
- 本插件的 `qwen4-qoder/*` = Qwen Code CLI 的免费额度。

同一个 Qoder 账号可以同时登录两边，但额度不互通，不要混为一谈。

---

## 🚀 保姆级上手：从零开始接入免费额度

把整件事想成三样东西：**Magpie 是车**（你的 Agent 运行环境），**Qwen Code 的免费额度是油**，**本插件是油管**——把油直接引进车里。你需要做的只有：领油卡 → 接油管 → 踩油门。

### 第 1 步：安装 Qwen Code CLI（领油卡的工具）

Windows（PowerShell 一行）：

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

Linux / macOS：

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
```

也可以用 npm（需要 Node 22+）：`npm install -g @qwen-code/qwen-code`。

装完**重开一个终端**，运行 `qwen --version` 能看到版本号就成功了。

> 🧯 装不上？先确认网络能访问阿里云 OSS；公司代理环境下可换 npm 方式。安装脚本地址来自 [Qwen Code 官方文档](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)，若官方改地址以官方为准。

### 第 2 步：用 Qoder 账号登录（领油卡）

```bash
qwen
```

进入交互界面后输入 `/auth`，选择 **Qoder** 登录，浏览器会弹出授权页，确认即可。回到终端随便问它一句话（比如"只回复 OK"），能回答就说明油卡到账了。输入 `/exit` 退出。

登录态保存在 `~/.qwen/qoder_oauth_creds.json`。**这是你的凭证，不要发给任何人、不要贴到网上。** 本插件只在本机读取它，token 过期前会自动刷新并写回，与 qwen CLI 共用，不需要你手动维护。

> 🧯 没有 Qoder 账号？先在 [qoder.cn](https://qoder.cn) 注册一个，再回来 `/auth`。

### 第 3 步：把插件装进 Magpie（接油管）

```bash
magpie plugin add github:Yakap168/magpie-qwen4-qoder-cli
```

国内网络拉 GitHub tarball 失败时，改用 clone：

```bash
git clone https://github.com/Yakap168/magpie-qwen4-qoder-cli
magpie plugin add ./magpie-qwen4-qoder-cli
```

然后给 provider 添加一个账号标记：

```bash
magpie plugin login qwen4-qoder
```

API Key 一栏随便填（例如 `local`）——插件不使用这个值，只把它当作"已启用"标记，真正的鉴权走第 2 步的 Qwen Code 登录。

### 第 4 步：开始用（踩油门）

```bash
magpie claude qwen4-qoder/qwen4-max
```

或在 Magpie UI 里选 **Qwen4-Max via Qwen Code → Qwen4-Max**。想省额度/更快，选 **Qwen3.8-Flash（qfmodel，免费）**。

试一个真实任务：

> 创建 hello.py，打印 hello world，然后运行它。

模型会原生返回 `tool_calls`，由 Magpie/外层 Agent（如 DSH）执行写文件、跑命令——和用官方 API 的体验一致。思考档位可在模型选择器里切换（none / low / high / xhigh 等，随模型而变）。

### 第 5 步：30 秒自检

```bash
magpie models | grep qwen4      # 应看到 qwen4-max 与目录模型
magpie accounts | grep qwen4    # 应看到已登录标记
```

在本仓库目录运行 `node scripts/selftest.mjs` 可以做一次完整体检（目录/流式/思考/工具回环/图片/免费模型）。

---

## 功能

- **直接转发** —— Chat Completions → OpenAI Responses 翻译后直达 Qoder 网关；无 CLI 进程、无本地监听端口。
- **原生工具调用** —— 请求里的 `tools`/`tool_choice` 原样变成上游 function tools；上游 `function_call` 增量翻译回标准 `tool_calls`，支持多工具与两轮回环。
- **逐 token 流式** —— 正文（`content`）、思考（`reasoning_content`）、工具参数（`tool_calls[].function.arguments`）都是真增量；首字节前用心跳保活。
- **思考强度** —— `reasoning_effort` / `reasoningEffort` / `reasoning.effort` / `thinking.effort` 都认；按模型实际档位就近钳制（见下）。
- **图片输入** —— `image_url` / `input_image` 内容块，data URL 直接内联，http(s) URL 自动下载转 data URL；最多 4 张、单张 20 MB。
- **真实 usage** —— 上游 input/output/total tokens，含缓存命中与思考 token 明细。
- **实时模型目录** —— 登录后拉取 qcode 目录，上下文上限、视觉能力、思考档位、免费标记都以目录为准；拉取失败退回内置表。
- **凭证自动维护** —— 过期前 5 分钟刷新；上游 401 强制刷新重试一次；single-flight 防并发重复刷新；原子写回 + 冲突检测，不会覆盖 qwen CLI 刚轮换的凭证。
- **安全卫生** —— 错误消息脱敏（dt-/drt-/Bearer/sk- 片段不回传，含错误 code 字段与目录拉取日志）；上游错误体限长截断；不记录 prompt；图片外链仅允许公网 http(s)（回环/内网/云元数据地址与解析到内网的域名一律拒绝，重定向逐跳校验，响应必须是 image/*）；付费模型默认拒绝（402），需显式开启自动确认。

## 思考强度

模型选择器里的档位来自模型目录（`thinking_config`）。请求档位与模型支持档位不一致时**就近钳制**（平手取更高）：

- `qmodel_latest`（Qwen4-Max）：none / low / high / xhigh。请求 medium → high。
- `qfmodel` / `qmodel_38max`：none / low / medium / xhigh。
- 模型关不掉思考时，none → 最低可用档。
- 未指定档位时默认 `high`（可用 `MAGPIE_QWEN_DEFAULT_EFFORT` 改）；但 `max_tokens ≤ 1024` 的小预算请求（会话标题/分类等）未指定档位时自动关思考，避免思考吃光预算导致正文为空。显式指定的档位不受此规则影响。

## 模型

| 模型 | ID | 上下文 | 说明 |
|---|---|---:|---|
| Qwen4-Max | `qmodel_latest` | 1,000,000 | 限时免费体验额度；文本+图片+工具 |
| Qwen4-Max（别名） | `qwen4-max` | 1,000,000 | 兼容 0.x 配置，等价于 qmodel_latest |
| Qwen4-Max-Preview | `qmodel_latest_preview` | 1,000,000 | 预览版 |
| Qwen3.8-Max | `qmodel_38max` | 180,000 | 目录真实输入上限 |
| Qwen3.8-Flash | `qfmodel` | 180,000 | **免费额度模型**，日常首选 |

实际列表以登录后拉取的目录为准；输出上限默认 128K。

## 工作原理

```text
Magpie / 外层 Agent（DSH 等）
  → OpenAI Chat Completions 请求
  → 插件 fetch 拦截：
      messages → instructions + input（message / function_call / function_call_output）
      tools → Responses function tools；reasoning_effort → reasoning.effort（按模型钳制）
      图片 → 内联 data URL
  → POST https://gateway.qoder.com.cn/qsvr/api/v1/responses?AgentId=agent_common
      Authorization: Bearer <Qwen Code 的 dt-token，自动刷新>
      Cosy-ClientType: 13 / metadata.session_type: qcode
  → 上游 Responses SSE
  → 翻译回 chat.completion.chunk：content / reasoning_content / tool_calls 增量 + 真实 usage
```

会话 id（Magpie `chat.headers` 钩子告知的 DSH/OpenCode 会话）哈希后作为 `X-Session-Id`，同一对话稳定，利于上游前缀缓存；客户端原始 key 不外发。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAGPIE_QWEN_REGION` | `cn` | `cn` 或 `global`（Qoder 国际区） |
| `MAGPIE_QWEN_CREDS` | `~/.qwen/qoder_oauth_creds.json` | 凭证文件路径覆盖 |
| `MAGPIE_QWEN_GATEWAY` | 按 region | 网关地址覆盖（调试用） |
| `MAGPIE_QWEN_DEFAULT_EFFORT` | `high` | 未指定档位时的默认思考强度 |
| `MAGPIE_QWEN_CONCURRENCY` | `4` | Magpie 账号级并发上限 |
| `MAGPIE_QWEN_KEEPALIVE_MS` | `15000` | 首字节前的心跳间隔 |
| `MAGPIE_QWEN_UPSTREAM_IDLE_MS` | `600000` | 上游流空闲超时（低于常见客户端 600s idle 限制时请调小） |
| `MAGPIE_QWEN_AUTO_CONFIRM_PAID` | 关 | 设为 `1` 时自动确认付费模型（**会扣付费额度，慎用**） |
| `MAGPIE_QWEN_CATALOG_TIMEOUT_MS` | `5000` | 模型目录拉取超时 |
| `MAGPIE_QWEN_DEBUG` | 关 | 设为 `1` 时把思考档位元数据写到临时日志（不记 prompt） |

0.x 的 `QWEN_CODE_BIN`、`MAGPIE_QWEN_CLI_TIMEOUT_MS` 已移除（不再有 CLI 进程）。

## 排障

- **401 / 提示重新登录** —— Qwen Code 登录失效。运行 `qwen` → `/auth` 重新登录；插件会自动刷新写回，一般无需重启 Magpie。
- **402 model_paid_confirm_required** —— 该模型消耗付费额度，插件默认拒绝。换 `qfmodel`，或确认愿意付费后设 `MAGPIE_QWEN_AUTO_CONFIRM_PAID=1`。
- **模型列表只有内置几个 / 拉目录失败** —— 多为凭证过期或网络问题；先看 `qwen` 能否正常对话，再看日志里的目录告警。
- **模型回话但不动手（不调工具）** —— 确认外层 Agent 真的把 `tools` 传进来了；本插件原生转发工具，不再做 prompt 注入。
- **思考档位不生效** —— 模型不支持的档位会被就近钳制（如 Qwen4-Max 的 medium→high），看 `MAGPIE_QWEN_DEBUG=1` 的档位日志。
- **图片报错** —— 仅支持 data: 与 http(s): 来源，最多 4 张、单张 20 MB；模型需支持视觉（目录 `is_vl`）。
- **长任务中断** —— 上游空闲超过 10 分钟会被主动断开；xhigh 长思考通常仍有增量输出，不会触发。

## 限制

- **非官方**：不是阿里/Qwen 官方插件；走的是 Qwen Code 客户端同款网关接口，接口变更可能随时需要跟进。
- **额度在 Qwen Code 侧**：精确余额请在 Qwen Code 终端里 `/usage` 查看；免费额度是限时活动，以官方为准。
- **思考历史不回传**：上游 Responses 协议需要加密 reasoning 项才能跨轮 replay，本插件不保存也不伪造，历史轮次的思考内容会被丢弃（正文与工具调用完整保留）；assistant 历史里的图片块同样不转发。
- **文件由外层 Agent 写**：插件只返回 `tool_calls`，DSH/Magpie 执行 `write`/`edit`；插件本身不直接改磁盘文件（凭证写回除外）。
- **音视频/PDF 输入暂不支持**。

## 测试

```bash
node --test "tests/*.test.mjs"   # 58 条单元测试（翻译/转发/鉴权/目录/模型表/安全回归）
node scripts/selftest.mjs        # 真实凭证端到端：目录/流式/思考/工具回环/非流式/图片/免费模型
```

## 参考源

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [dsh-qwencode](https://github.com/Yakap168/dsh-qwencode) —— DSH 侧同款直接转发设计
- [Qwen Code CLI 文档](https://qwenlm.github.io/qwen-code-docs/)
- 社区插件 [`@magpie-community/opencode-qoder-auth`](https://github.com/magpie-community/plugins)（Qoder 套餐路径，与本插件额度池不同）

## 许可

MIT。见 [LICENSE](LICENSE)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)