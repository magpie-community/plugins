<p align="center"><img src="icon.svg" width="72" height="72" alt=""></p>

<h1 align="center">magpie-hark-web</h1>

<p align="center">
  把 <a href="https://hark.com">hark.com</a> 的网页账号接进 <a href="https://github.com/yetone/magpie">Magpie</a>：<br>
  在浏览器里登录或复用日常 Chrome 会话，通过 OpenAI 兼容接口进行问答与代码生成，<br>
  并在额度卡片上查看每日 Token 与周期额度池用量。
</p>

<p align="center">
  Provider id：<code>hark-web</code> · 模型：<code>hark-web/hark</code>、<code>hark-web/hark-chat</code> · macOS / Windows / Linux · MIT
</p>

> [!WARNING]
> **重要限制说明：Hark 官方策略不支持当作其他应用背后的模型来用**
>
> - **✅ 可正常使用**：纯问答、代码生成、常规 OpenAI Chat Completions 对话（如 Python/JS SDK 调用、普通对话窗口、总结翻译等）。
> - **⚠️ 受 Hark 官方限制（Agent / 工具调用不可靠）**：Hark 模型内置了官方政策限制——当请求携带完整的外部 IDE / Agent 系统提示词（如 Codex、OpenCode、Zed Agent 模式）或大量工具调用定义（Tool Definitions）时，Hark 往往会主动拒答并提示：<br>
>   *“Hark 不支持当作其他应用背后的模型来用，你直接在这里说想完成什么，我就帮你做。”*
> - 插件本身虽实现了超长文本自动转附件（`prompt-context.txt`）与 `tool_call` 协议映射，但无法绕过 Hark 模型层面的策略拦截，因此**不建议用于重度 Agent / 工具调用工作流**。

---

hark.com 没有公开 API，且受 Cloudflare 保护。本插件自带本机轻量引擎，通过 Chrome DevTools Protocol (CDP) 驱动真实浏览器页面：
- 将 Magpie 发来的 OpenAI 兼容 Chat Completions 请求自动转换为网页会话；
- 实时捕获流式输出并回传给客户端；
- 自动读取 Hark 的 Billing Summary 额度数据并生成 Magpie 额度卡片。

## 环境要求

- [Magpie](https://github.com/yetone/magpie)
- 本机装有 Chrome、Edge、Chromium 或 Brave 中的任意一个。
- 能够正常访问 hark.com 的网络（支持通过代理设置）。

## 安装

```sh
# 本地加载插件
magpie plugin add ./magpie-hark-web

# 登录账号
magpie plugin login hark-web
```

想登录多个账号，可以多登录几次；Magpie 会自动进行多账号管理与轮换调度。

## 使用方式与适用场景

```sh
# 测试连通性（发送普通问答，检查调用链路）
magpie provider test hark-web

# 在支持纯对话模式的客户端中使用（纯问答 / 代码生成可正常使用）
# 例如直接使用 OpenAI SDK：base_url="http://127.0.0.1:18622/v1"
```

也可以在任何兼容 OpenAI 格式的客户端中使用 `http://127.0.0.1:18622/v1` 作为接口基地址（认证头 `Authorization: Bearer <engine.key>`，账号头 `X-Hark-Account: <handle>`）。

- **纯问答 / 代码生成**：通过 OpenAI SDK、普通 Chat 客户端发送对话请求，可稳定正常返回（支持多气泡代码卡片合并、超 36,000 字自动转为 `prompt-context.txt` 附件绕过输入框 40,000 字限制）。
- **Agent / 工具调用模式（如 `magpie codex hark-web/hark`、`magpie opencode hark-web/hark`、Zed Agent 等）**：受 Hark 官方策略限制，模型遇到外部 Agent 的系统规则或工具注入提示时，通常会直接拒绝执行（提示“Hark 不支持当作其他应用背后的模型来用”）。因此不建议将 Hark 用作代码 Agent 背后的驱动模型。

## 登录方式

插件提供了多种灵活的登录方式：

### 方式 1：浏览器弹窗登录（默认）
在 Magpie 账号页面选择 `hark-web` 登录，引擎会自动打开一个浏览器窗口加载 `https://hark.com/chat`。在窗口中完成登录后，引擎会自动提取 Session Cookie、验证连通性并保存账号，随后自动关闭登录窗口。

### 方式 2：直接导入已有 Chrome 会话（推荐）
如果你日常的 Chrome 已经登录了 hark.com，可以使用内置的导入工具一键导入：
```sh
# 1. 启动 Chrome 时开启调试端口（如已开启，直接跳过此步）：
# Windows: chrome.exe --remote-debugging-port=9222
# macOS: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# 2. 运行导入脚本：
node engine/import-chrome.mjs 9222
```

### 方式 3：直接粘贴 Cookie / Session Token
在 Magpie 添加账号选择 `账号 ID 或 Cookie（高级/导入）` 时，可以直接粘贴你在已登录 Chrome 控制台中复制的 Cookie 字符串（包含 `__Secure-hark.session_token`），插件会自动解析并完成登录绑定。

## 数据目录与安全

账号凭证仅保存在本机当前用户数据目录下，文件权限为当前用户私有：

| 系统 | 数据目录 |
|---|---|
| Windows | `%APPDATA%\hark-web` |
| macOS | `~/Library/Application Support/hark-web` |
| Linux | `~/.local/share/hark-web` |

目录结构：
- `accounts.json`：保存账号凭证与有效期限
- `engine.key`：Magpie 与本机引擎通信的密钥
- `engine.log`：请求与运行日志（自动轮转）

## 工具调用（Tool Calling · 受 Hark 官方策略限制）

Hark 网页本身没有开放函数调用接口，插件层虽然提供了提示词映射机制：
1. 请求包含 `tools` 时，插件将工具签名注入到提示词中；
2. 引导模型使用 `tool_call` 代码块返回调用意图；
3. 引擎在输出中捕获并解析为 OpenAI `tool_calls` 结构化响应；
4. 工具执行结果以标记上下文形式回传给后续轮次。

> **注意**：由于 Hark 官方模型自身策略限制，检测到外部应用的系统提示词或工具指令时，模型可能会拒绝合作并返回 *“Hark 不支持当作其他应用背后的模型来用”*。该限制来自 Hark 服务端模型策略，纯问答 / 代码生成不受影响，但**无法保证 Agent / 工具调用模式可用**。

## 额度卡片（Usage Card）

插件会自动调用 Hark 的 `/api/billing/summary` 接口，展示实时额度信息：
- **每日 Token**：当日已消耗量、总限额与次日刷新时间。
- **周期额度池**：当前订阅周期内的 Token 用量与周期重置时间。
- **方案类型**：显示当前账号对应的会员方案（如 Hark Pro）。

## 复用日常 Chrome（推荐，不新开第二个 Chrome 进程）

本插件默认会在每次发送请求时自动探测并复用你**平时正在使用的 Chrome / Edge / Chromium / Brave**（后台静默标签页，不会弹窗、也不会关闭你的浏览器）。

### 如何让平时用的 Chrome 支持自动复用（仅需一次设置）

1. 在你平时使用的 Chrome 地址栏打开：`chrome://inspect/#remote-debugging`
2. 勾选 / 开启 **“允许远程调试”（Allow remote debugging）**
3. 首次有请求连接时，Chrome 会在浏览器窗口弹出 **“允许远程调试？（Allow remote debugging?）”** 安全确认框，点击 **允许（Allow）** 即可（超时约 15 秒；点击后插件会保持连接复用，不需要每次请求都再开新进程或反复确认）

> 提示：
> - 如果弹窗未及时确认超时，或者 Chrome 未开启远程调试，插件会自动回退到内置的隐藏浏览器模式，不会报错阻塞。
> - 多账号场景下，主账号会直接复用你当前 Chrome 的上下文；如果同一个引擎里同时有不同账号，其余账号会自动使用独立上下文以避免串号。

## 环境变量配置（可选）

- `HARK_WEB_ENGINE_PORT`：自定义本地引擎监听端口（默认 `18622`）
- `HARK_WEB_REUSE_CHROME`：是否自动探测并复用已运行的 Chrome（默认开启；设为 `0` 禁用，强制使用独立浏览器进程）
- `HARK_WEB_CHROME`：指定 Chrome 可执行文件路径
- `HARK_WEB_CHROME_PORT`：指定已运行 Chrome 的 CDP 调试端口（会自动尝试 `/json/version` 与 `DevToolsActivePort`）
- `HARK_WEB_BROWSER`：当回退到独立浏览器时的运行模式，可选 `hidden`（默认后台隐藏窗口，推荐）、`headless`（无头模式）、`show`（显示窗口）
- `HARK_WEB_PROXY`：指定代理地址（如 `http://127.0.0.1:7890`，或设为 `direct` 直连）
- `HARK_WEB_IDLE_MIN`：闲置多长时间自动释放后台标签页/浏览器（默认 60 分钟）
