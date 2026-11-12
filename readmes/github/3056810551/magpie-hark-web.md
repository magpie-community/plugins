<p align="center"><img src="icon.svg" width="72" height="72" alt=""></p>

<h1 align="center">magpie-hark-web</h1>

<p align="center">
  把 <a href="https://hark.com">hark.com</a> 的网页账号接进 <a href="https://github.com/yetone/magpie">Magpie</a>：<br>
  在浏览器里登录或直接导入已登录的 Chrome 会话，就能在 Codex、OpenCode 等 Agent 里使用 Hark，<br>
  支持工具调用（Tool Calls），并在额度卡片上查看每日 Token 与周期额度池用量。
</p>

<p align="center">
  Provider id：<code>hark-web</code> · 模型：<code>hark-web/hark</code>、<code>hark-web/hark-chat</code> · macOS / Windows / Linux · MIT
</p>

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

## 在 Agent 里使用

```sh
magpie codex hark-web/hark        # 让 Codex 使用 Hark
magpie opencode hark-web/hark     # 让 OpenCode 使用 Hark
magpie provider test hark-web     # 发送测试消息，检查整条调用链路
```

也可以在任何兼容 OpenAI 格式的客户端中使用 `http://127.0.0.1:18622/v1` 作为接口基地址。

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

## 工具调用（Tool Calling）

Hark 网页本身没有开放函数调用接口，插件采用提示词映射机制：
1. 请求包含 `tools` 时，插件自动将工具签名注入到系统提示词中；
2. 引导模型使用标准 `tool_call` 代码块返回调用意图；
3. 引擎在流式输出中捕获并结构化解析为标准 OpenAI `tool_calls` 响应；
4. 工具执行结果以标记上下文形式回传给后续轮次。

## 额度卡片（Usage Card）

插件会自动调用 Hark 的 `/api/billing/summary` 接口，展示实时额度信息：
- **每日 Token**：当日已消耗量、总限额与次日刷新时间。
- **周期额度池**：当前订阅周期内的 Token 用量与周期重置时间。
- **方案类型**：显示当前账号对应的会员方案（如 Hark Pro）。

## 环境变量配置（可选）

- `HARK_WEB_ENGINE_PORT`：自定义本地引擎监听端口（默认 `18622`）
- `HARK_WEB_CHROME`：指定 Chrome 可执行文件路径
- `HARK_WEB_CHROME_PORT`：指定已运行 Chrome 的 CDP 调试端口
- `HARK_WEB_BROWSER`：浏览器运行模式，可选 `hidden`（默认后台隐藏窗口，推荐）、`headless`（无头模式）、`show`（显示窗口）
- `HARK_WEB_PROXY`：指定代理地址（如 `http://127.0.0.1:7890`，或设为 `direct` 直连）
- `HARK_WEB_IDLE_MIN`：闲置多长时间自动释放后台浏览器进程以节省内存（默认 60 分钟）
