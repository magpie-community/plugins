# yce-magpie-agy

把本机的 Antigravity CLI（`agy`）接成 Magpie 里的一个模型 provider。装好以后，
OpenCode、Claude Code 等客户端经由 Magpie 调用你订阅里的 Gemini、Claude 和
GPT-OSS 模型，请求实际由 `agy` 进程完成。

**[English → README.en.md](README.en.md)** ｜ 来源、版权与迁移说明见 [NOTICE.md](NOTICE.md)

## 这是什么

插件以 Magpie provider 的形式运行。客户端发来 Anthropic Messages 格式的请求，插件把它
翻译成 ACP（Agent Client Protocol）消息，交给本机的 `agy acp` 进程处理，再把输出翻译回
流式响应。

- 底层是真正的 agy CLI，走它自带的 ACP 通道。插件不伪造 IDE 身份，也不直接请求 Google
  的内部接口。
- 客户端自己的工具（读写文件、执行命令等）通过 MCP 暴露给模型。工具由客户端执行，结果
  回传到同一轮 agy 对话里，模型看到的是原生工具调用。
- 账号风险不由插件决定。Google 的使用政策变化时，插件无法替你保证账号不受限制。

## 功能

- **订阅内的模型都能用**：Gemini、Claude、GPT-OSS 等模型在会话中切换，历史保留；思考
  等级也可以在会话中切换。
- **流式输出与思考摘要**：思考摘要以 `thinking` 块返回，设置 `AGY_BRIDGE_THINKING=0` 可关闭。
- **图片输入**：支持内联 base64 的 PNG、JPEG、GIF、WebP。需要 agy 1.5.0 或更新版本，
  因为图片能力要由 ACP 服务端声明。
- **工具调用**：支持并行和连续调用。运行超过 150 秒的工具会先收到 "still running" 的
  占位响应，真正的结果送达后继续同一轮对话，每个调用只在客户端执行一次。
- **会话续接**：每轮结束后记录会话。重启 Magpie 或插件后，只要历史和指令的哈希一致，
  就用 `session/resume` 接上上下文。状态文件只存会话 ID 与哈希，不存消息原文。
- **隔离运行**：不读取你的全局 MCP 配置。每个 agy 进程使用临时 agent。agy 发起的权限
  请求（shell、写文件、浏览器等）一律拒绝，真正的操作都在客户端侧完成。
- **额度查看**：在 Magpie 里查看 agy 订阅的用量窗口，仅作展示，额度耗尽时不会自动拦截请求。

## 环境要求

- Antigravity CLI（`agy`），带 `acp` 子命令，并且在终端里交互登录过一次 Google 账号。
  文本与工具调用已在 1.4.12 和 1.5.0 上验证；图片输入需要 1.5.0。
- 支持 OpenCode 风格 provider 插件的 Magpie。额度查询已在 Magpie 0.1.1599 上验证。
- agy 版本低于 1.1.11 时，额度查询会被拒绝，以免旧版本把 `/usage` 当成模型提示词。

## 安装

从 Magpie 社区插件市场安装（推荐）：在 Magpie 的 Plugins 页找到「YCE Magpie AGY」点安装，或在终端运行：

```sh
magpie plugin add @magpie-community/yce-magpie-agy
```

装好后 provider id 是 `yce-magpie-agy`，模型写成 `yce-magpie-agy/<模型>`。默认并发 16，可在 Magpie 的 Providers 页 Concurrency 里改（0 表示不限）。

直接从 GitHub 源仓安装：

```sh
magpie plugin add github:gitxm/yce-magpie-agy
```

从本地源码安装：

```sh
git clone https://github.com/gitxm/yce-magpie-agy
magpie plugin add ./yce-magpie-agy
```

安装完成后，先在终端运行一次 `agy` 完成 Google 登录。

## 使用

1. 在 Magpie 的 Providers 页找到 `yce-magpie-agy` 并点击 Sign in。插件会用 `agy models`
   确认 CLI 可用。Google 凭据始终由 agy 自己保管，插件不读取、不保存。
2. 模型名写成 `yce-magpie-agy/<模型>`。agy 对同一模型不同思考等级给出的多个模型 ID，
   在这里会合并成一个模型的多个变体，请求时再映射回对应的 agy ID。
3. 在客户端里选用这个模型即可。

## 并发

- 插件自己的进程池上限由 `AGY_BRIDGE_MAX_PROCS` 决定，默认 16 个 agy 进程。
- Magpie 的 Providers 页有单独的 Concurrency 设置，可填 0–1000，0 表示不限制。
  你在页面里改的值会覆盖 `package.json` 里 `magpie.maxConcurrency` 的默认声明（16）。
- 进程池已满、又找不到可以淘汰的进程时，插件返回 HTTP 503。建议两处数值保持一致：
  Providers 页的并发数超过进程池上限，多出来的请求就会得到 503。

## 平台

- **macOS、Linux**：支持。
- **原生 Windows**：支持 `.exe`、`.cmd`、`.bat` 的查找与启动，后台更新检查不弹控制台窗口，
  并支持 `magpie quota`。目前只有命令构造的单元测试，尚未在 Windows 实机完成端到端验证。

## 额度

```sh
magpie quota yce-magpie-agy --json
magpie quota refresh yce-magpie-agy --json
```

额度数据来自 agy 自己的 `/usage` 报告，显示的是当前 agy 登录账号的订阅窗口，按模型组
分别列出。插件不读写 Google 令牌，也不会替你伪装成其他账号。没有可测量数据的窗口会显示
"Limits not available"，而不是 0% 或 100%。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGY_PATH` | 按 PATH 查找 | 指定 agy 可执行文件 |
| `AGY_BRIDGE_MAX_PROCS` | 16 | agy 进程池上限 |
| `AGY_BRIDGE_THINKING` | 开启 | 设为 `0` 关闭思考摘要 |
| `AGY_BRIDGE_EFFORT` | 未设置 | 强制思考等级：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | 开启 | 设为 `0` 保留 agy 默认提示组件，每次模型调用多约 2,600 个输入 token |
| `AGY_BRIDGE_IDLE_MS` | 600000 | 进程空闲多久后回收（会话仍可续接） |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | 回收后的会话可续接的时长（6 小时） |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | 会话状态文件路径 |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | 工具运行超过该时间仍未结束时，先返回 "still running" |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 秒 / 5 分钟 / 30 分钟 | 进程启动、agy 无输出、等待客户端工具结果的超时 |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | 客户端已断开的挂起工具回合，最多占用进程池槽位这么久 |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688（112 KiB） | 重放历史提示词的字节预算 |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | 额度查询的总时间预算，最高 18000 |
| `AGY_BRIDGE_MCP_TRACE` | 未设置 | 把 MCP 通道流量写入指定文件，仅用于排查 |

## 常见排查

- **找不到 agy**：设置 `AGY_PATH` 指向可执行文件，或确认 `agy` 在 PATH 里。
- **Sign in 失败或 agy 报登录相关错误**：在终端运行一次 `agy`，重新完成 Google 登录。
- **HTTP 503**：进程池满。提高 `AGY_BRIDGE_MAX_PROCS` 和 Providers 页的 Concurrency，
  或者减少同时进行的会话。
- **额度显示 "Limits not available" 或报版本错误**：该窗口没有可测量的数据；版本错误则
  把 agy 升级到 1.1.11 以上。
- **图片请求返回 HTTP 400**：当前 agy 没有声明图片能力（需要 1.5.0 以上）。另外只接受
  内联 base64，URL 图片和 PDF 等二进制文档都会被拒绝。
- **回复里出现 "Agent execution terminated due to error."**：这是 agy 的错误标记。插件会
  从 agy 的日志中取出真实原因，并以错误结束本轮，不会当作正常回复输出。
- **HTTP 409，提示工具结果与历史对不上**：通常是客户端在对话中途改写了历史或工具 ID。
  能确定对应关系时插件会重建会话；无法确定时直接拒绝，不做猜测。
- **想关掉思考摘要**：设置 `AGY_BRIDGE_THINKING=0`，或者在请求里带上
  `thinking: { "type": "disabled" }`。

## 开发

```sh
node --check index.mjs
node --check mcp-server.mjs
node --check usage.mjs
npm test
npm pack --dry-run
```

`npm test` 用假的 agy 进程跑完整的 ACP 与 MCP 链路，不消耗额度。真实 CLI 的集成检查需要
显式开启，并会消耗少量订阅额度：

```sh
AGY_BRIDGE_INTEGRATION=1 npm run test:integration
```

## License

MIT。版权声明见 [LICENSE](LICENSE)，上游来源与逐项变更见 [NOTICE.md](NOTICE.md)。
