# magpie-venice-web

在 [Magpie](https://usemagpie.ai/) 中通过 Venice 网页会话使用全部 **网页免费模型**（`usesCredits: false`，共 20 款）：

```text
venice-web/deepseek-v4-1-flash-free
venice-web/qwen-3-8-27b
venice-web/kimi-k2-5
venice-web/zai-org-glm-5.2
venice-web/venice-uncensored-1-2
...
```

默认使用 **Cookie 直连**，登录后不需要浏览器保持开启。支持流式/非流式回答、系统提示词、完整历史和模拟工具调用。已在 macOS、Magpie 0.1.1247 上真实验证。

## 安装与登录

Cookie 模式需要 **Node.js 22+**。Magpie 插件由 Bun 运行，HTTP 请求交给 Node；实测 Bun 原生 fetch 的请求环境会触发 Cloudflare，而 Node 配合匹配的浏览器 User-Agent 可以正常访问。无需安装 Playwright 浏览器或 Python。

```sh
magpie plugin add /absolute/path/to/magpie-venice-web
magpie plugin login venice-web
magpie provider test venice-web deepseek-v4-1-flash-free
magpie provider test venice-web qwen-3-8-27b
```

登录时提供两种方式：

### 无痕窗口 Cookie 导入

1. 在 Chrome 无痕窗口打开 <https://venice.ai/chat/agent>，登录 Venice。
2. 开发者工具 → Network，找到 `clerk.venice.ai` 的请求。必要时刷新页面。
3. 复制该请求的 **User-Agent**，按 Magpie 提示填写。必须匹配登录浏览器，通用值可能触发验证。
4. 复制该请求的 **Cookie** 请求头，确认包含 `__client=...`，粘贴到登录的 Code 输入框。也支持浏览器 Cookie 导出 JSON 数组；导出需包含 `clerk.venice.ai`，可以同时包含 `venice.ai`。
5. 显示登录成功后，直接关闭无痕窗口，**不要点击退出登录**。退出会撤销会话。

`venice.ai` 页面自己的 Cookie 通常只有短期 `__session`，不能替代 Clerk 域的长期 `__client`。不要把 Cookie 放进聊天、日志或 Git。

### Chrome 自动提取

选择第二种登录方式，插件打开独立的正常 Chrome 窗口。登录 Venice 后，插件自动提取 Cookie 和 User-Agent 并验证续签。成功后可以关闭 Chrome；日常聊天、读取模型、续期均使用 Cookie，不会自动开浏览器。

Chrome / Chromium 路径提供 macOS、Windows、Linux 查找逻辑；macOS 也查找 Edge/Brave，Windows 也查找 Edge。当前真实浏览器登录测试仅在 macOS 进行。Linux 自动登录需要桌面环境，手动 Cookie 导入不需要。

## 保存与自动续期

- Cookie、短期 token 和 Cookie 轮换结果保存在本机 `cookie-accounts/<随机ID>.json`。文件权限 600，目录 700，Windows 权限依赖系统账户和 ACL。
- Magpie 的 `plugin-auth.json` 只保存账号文件的随机 ID、邮箱、用户 ID 和 `cookie-managed` 标记，不保存原始 Cookie。
- 每次请求检查短期 token，临近过期时用长期 Cookie 续签；也支持 Magpie `auth.refresh`。遇到 401 时强制刷新并重试一次。
- 每个账号的刷新与 Cookie 更新使用跨进程文件锁，写入通过临时文件原子替换，处理服务端 `Set-Cookie` 及 Cookie 删除/过期。
- 账号撤销、无有效会话或服务器要求浏览器交互验证时，标记需要重新导入；不会自动打开浏览器，也不绕过验证。

| 系统 | 默认数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/venice-web` |
| Windows | `%LOCALAPPDATA%\venice-web` |
| Linux | `$XDG_DATA_HOME/venice-web`，默认 `~/.local/share/venice-web` |

`chrome-profile/` 仅用于可选 Chrome 登录；不参与 Cookie 日常请求。卸载不删除账号文件或浏览器配置。`dataDir` / `VENICE_WEB_HOME` 可以更改目录。

### 保活验证的实际范围

已验证：Chrome 关闭后续签和真实聊天；旧 JWT 自然过期后换取新 token；移除所有 Cloudflare Cookie、仅保留 `__client`；本地 Cookie jar 忽略已过期的 `cf_clearance`；模拟服务器的 Cookie 轮换、撤销和交互验证；Magpie 宿主下真实聊天。

这些测试不等于多天自然保活完成，也不能保证服务器永远不要求重新认证。当前机器运行一个 **72 小时观察**：每 6 小时强制续签并读取模型目录，不发送聊天。脚本在到期后停止网络检查。结果在数据目录 `observation/results.jsonl`；已验证首次检查 200。Cloudflare 以后因 IP、请求环境或策略变化主动要求交互验证时，仍可能需要重新导入。

可手动执行一次观察：

```sh
node scripts/observe-cookies.mjs --start  # 启动/重置72小时观察窗口
node scripts/observe-cookies.mjs          # 检查一次；满72小时后后续调用不再发请求
```

当前 macOS 定时配置：`~/Library/LaunchAgents/ai.magpie.venice-cookie-observation.plist`。提前停止：

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.magpie.venice-cookie-observation.plist
```

## 模型与工具

插件会自动拉取 Venice Agent 模式和 Classic Chat 经典目录中所有标记为 `usesCredits: false` 的免费模型，共 20 款：

| 模型分类 | 模型 ID | 模型名称 | 上下文 | 推理支持 |
| --- | --- | --- | --- | --- |
| **DeepSeek** | `deepseek-v4-1-flash-free` | DeepSeek V4.1 Flash Uncensored | 524K | ✓ |
| | `deepseek-ai-DeepSeek-V3.2` | DeepSeek V3.2 | 160K | ✓ |
| **Qwen** | `qwen-3-8-27b` | Qwen 3.8 27B | 262K | ✓ |
| | `qwen3-6-27b` | Qwen 3.6 27B | 256K | ✓ |
| | `qwen3-5-35b-a3b` | Qwen 3.5 35B A3B | 256K | ✓ |
| **GLM** | `zai-org-glm-5.2` | GLM 5.2 | 1000K | ✓ |
| | `zai-org-glm-4.6` | GLM 4.6 | 198K | ✗ |
| **Kimi** | `kimi-k2-5` | Kimi K2.5 | 524K | ✓ |
| **Venice** | `venice-uncensored-1-2` | Venice Uncensored 1.2 | 128K | ✗ |
| **Gemma** | `google-gemma-4-31b-it` | Google Gemma 4 31B Instruct | 256K | ✓ |
| | `google-gemma-4-26b-a4b-it` | Google Gemma 4 26B A4B Instruct | 256K | ✓ |
| | `gemma4-uncensored` | Gemma 4 Uncensored | 256K | ✗ |
| **Aion** | `aion-labs-aion-3-0` | Aion 3.0 | 128K | ✓ |
| | `aion-labs-aion-3-0-mini` | Aion 3.0 Mini | 128K | ✓ |
| **E2EE / TEE** | `e2ee-gpt-oss-120b-p` | GPT OSS 120B (TEE) | 128K | ✓ |
| | `e2ee-qwen3-8-27b` | Qwen 3.8 27B (TEE) | 262K | ✓ |
| | `e2ee-qwen3-6-35b-a3b` | Qwen 3.6 35B A3B FP8 (TEE) | 32K | ✓ |
| | `e2ee-gemma-4-26b-a4b-uncensored-p` | Gemma 4 26B A4B Uncensored (TEE) | 64K | ✗ |
| | `e2ee-qwen-2-5-7b-p` | Qwen 2.5 7B (TEE) | 32K | ✗ |
| | `e2ee-qwen3-vl-30b-a3b-p` | Qwen3 VL 30B A3B (TEE) | 128K | ✗ |

支持常见的官方别名映射（例如 `qwen-3.8-27b`、`deepseek-v3-2`、`venice-uncensored` 等）。

插件使用 `/api/inference/chat/agents/ad-hoc` 发送推理请求，不会往浏览器聊天历史写入消息。图片/文件和结构化输出明确拒绝；精确的 temperature/top_p/max_tokens 不受网页接口支持。

### 用量统计

网页接口不返回标准用量字段，插件在本地按文本估算 `prompt_tokens`、`completion_tokens`、`total_tokens`，并在流式响应的结束块和非流式响应里都给出 `usage`。Magpie 的请求日志因此能显示正确的输入/输出 token，而不是 0。这是估算值，不是 Venice 计费口径；网页模型本身 `usesCredits:false`，所以没有费用数字。

模型产生思考内容时，思考单独计入 `completion_tokens_details.reasoning_tokens`。

### 推理档位

Venice 网页的推理是一个开关，不是 OpenAI 那样的数值梯度。插件把 `reasoning_effort` 映射到网页真正支持的三种模式，并作为模型 variant 暴露：

| Magpie 选择 | 网页 `reasoningMode` | 说明 |
| --- | --- | --- |
| `disabled` | `disabled` | 关闭推理 |
| `adaptive` | `adaptive` | 由模型决定是否推理 |
| `enabled` | `enabled` | 强制开启推理 |

`none`、`minimal`、`disabled` 都映射为关闭；`medium`、`auto` 映射为 `adaptive`；其余（如 `high`）映射为 `enabled`。这是能力映射，不是精确一致：网页没有 low/medium/high 的数值档，插件不伪造不存在的档位。

思考内容以 `reasoning_content` 返回，和正式回答分开，不会混进正文。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `nodePath` | `node` | Node.js 22+ 可执行文件；桌面 PATH 不含 Node 时填绝对路径 |
| `toolMode` | `"prompt"` | `"off"` 拒绝工具请求 |
| `timeoutMs` | `240000` | 请求总时限，1,000–900,000 毫秒 |
| `dataDir` | 上表 | 私有数据目录 |
| `chromePath` | 自动查找 | 仅自动提取方式使用 |
| `cdpEndpoint` | 未设置 | 自动提取时连接你准备好的回环 CDP 浏览器 |

```sh
magpie plugin options magpie-venice-web '{"nodePath":"/opt/homebrew/bin/node"}'
```

Node 子进程继承环境；与浏览器的系统代理出口可能不同。需要代理时应保持登录与请求出口一致，并在实际宿主里验证。当前未实现独立的逐账号代理设置。

## 开发与排查

```sh
npm test
bun test
magpie provider test venice-web deepseek-v4-1-flash-free
magpie provider test venice-web qwen-3-8-27b
```

- 缺少 `__client`：复制 Clerk 域请求，不要只复制 Venice 域 Cookie。
- 需要浏览器验证：从新的无痕登录重新导入，并匹配 User-Agent/网络出口。
- Node 找不到：设置 `nodePath`，不要依赖桌面应用继承终端 PATH。
- 旧版 Chrome 登录：升级后重新登录一次即可迁移为 Cookie 连接。
- 原有重复开页问题已加跨进程锁；Cookie 模式在日常供应商检查时完全不创建页面。

修改本地代码后，CLI 自动读新文件；桌面应用中关闭再打开插件以加载更新。

协议与调查见 [docs/investigation.md](docs/investigation.md)。参考 [magpie-gemini-web](https://github.com/BUKOWSKIREAL/magpie-gemini-web) 和 [magpie-muse-web](https://github.com/JohnWangggg/magpie-muse-web) 的设计，未复制源码。非官方插件，网页协议改动可能需要更新。MIT。
