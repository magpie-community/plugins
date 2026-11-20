<h1 align="center">Magpie-Capy-Server</h1>

<p align="center">Connect Capy to magpie — with Cookie login for headless Linux servers.</p>

把 [Capy](https://capy.ai) 接进 [magpie](https://usemagpie.ai) 的 provider 插件。本项目 fork 自 [baijiu666/magpie-Capy](https://github.com/baijiu666/magpie-Capy)，在原项目基础上新增了 Cookie 登录，专为无头 Linux 服务器设计：无需桌面端、无需图形浏览器，粘贴两段 Cookie 即可登录。提供 3 个免费模型，原生 SSE 流式 / 非流式对话，支持图片 / PDF 附件。

A magpie provider plugin that connects [Capy](https://capy.ai) to [magpie](https://usemagpie.ai). Forked from [baijiu666/magpie-Capy](https://github.com/baijiu666/magpie-Capy), with Cookie login added for headless Linux servers: no desktop app, no graphical browser — paste two pieces of Cookie and sign in. 3 free models, native SSE streaming / non-streaming chat, image / PDF attachments.

当前版本：**v0.2.3**（`package.json` 版本 `0.2.3`，对应 git tag `v0.2.3`；未发布 GitHub Release，未发布到 npm）。

- **纯无头**：自动注册设备，走 Capy device tunnel；运行时不需要 Capy 桌面端。
- **登录**：本机 Capy 客户端导入 / 浏览器登录 / 粘贴 Cookie 登录（无头服务器适用；两框分别粘贴，获取方法见下方登录说明）。
- **对话**：OpenAI 兼容 `/chat/completions`，原生 SSE，流式/非流式。
- **模型**：动态目录 + 静态兜底；3 个免费模型。
- **附件**：图片 / PDF 走 Capy files 通道（单文件 250 MB）。
- **用量**：流式与非流式对话都上报估算 token 数（近似值，见下方已知限制）。
- **零运行时依赖**：TypeScript + Bun，构建为单个 `dist/index.mjs`。

## 安装

在 Magpie 插件设置中添加 GitHub 仓库 `baiz329/magpie-capy-server`，或本地开发时构建后添加本仓库路径。provider id 为 `capy`。

本地构建：

```bash
bun install
bun run build
```

## 登录

支持三种方式：本机 Capy 客户端导入、浏览器登录，以及无头环境适用的粘贴 Cookie 登录（两框）。

### 本机 Capy 客户端导入

1. 先在本机装好 Capy 桌面端并登录一次（只需要登录过，登录时桌面端不用开着）。
2. 在 Magpie 里选这个方式，插件会只读本机保存的 Capy 登录凭据（Windows 上是 `%APPDATA%\Capy` 下的 `Local State`），自动完成登录，不用复制任何东西。
3. 如果这台机器上从来没在 Capy 桌面端登过录，会报“请先在 Capy 桌面端登录”，先去桌面端登一次再回来。

注意：这个方式只在装了 Capy 桌面端的机器上能用（目前是 Windows）。无头 Linux 服务器上没有桌面端，**用下面的粘贴 Cookie 登录**。

### 浏览器登录

1. 在 Magpie 里选这个方式，插件会自动打开 Capy 官方登录页 `https://capy.ai/sign-in`（用本机 Chrome / Edge / Brave / Chromium）。
2. 在打开的页面上用 Google、GitHub、Passkey 或邮箱登录 Capy。
3. 登录成功后插件会自动读取登录态，**不需要复制任何东西**，等它完成就行；中途关掉浏览器等于取消登录。

注意：这个方式需要图形浏览器。无头 Linux 服务器上没有图形浏览器，**用下面的粘贴 Cookie 登录**。

### 粘贴 Cookie 登录（两框）

**第一框：clerk 请求头（必须包含 `__client`）**

1. 在浏览器里登录 `capy.ai`，按 F12 打开开发者工具（DevTools），点 **Network（网络）** 标签页，刷新页面。
2. 在请求列表里找到一条发往 `clerk.capy.ai` 的请求——名称通常是 `client?…` 或 `environment?…`（Initiator（启动器）一列显示 `clerk.browser.js`），点开它。
3. 在右侧详情里点 **Headers（标头）**，往下翻到 **Request Headers（请求标头）**，找到 `cookie:` 这一行，把它后面的完整值整个复制下来，确认里面有 `__client` 这一项。
4. 把这串粘贴到 Magpie 登录的**第一框**。

注意：`__client` 是 HttpOnly Cookie，只在 `clerk.capy.ai` 这个域上。点 `capy.ai` 主域的请求（比如 `me`、`devices`、`billing`）是拿不到它的，**必须点发往 `clerk.capy.ai` 的请求**。

**第二框：`__session` 的值**

1. 仍在开发者工具里，点 **Application（应用）** 标签页，左侧点开 **Cookies（Cookie）** → `https://capy.ai`。
2. 在列表里找到 `__session`，点开它，把 **Value（值）** 完整复制下来（很长一串，以 `eyJ` 开头）。
3. 把这个值粘贴到 Magpie 登录的**第二框**。
4. 如果没有不带后缀的 `__session`，就复制 `__session_VSH_xxx` 的值填进去；也可以直接填 Clerk session id。

**注意事项**

- 粘贴登录后，不要在原来那个浏览器里点退出登录，那会让复制出来的 Cookie 失效。
- Cookie 是敏感登录凭据：不要贴进聊天、源码、命令行参数或日志。
- 可选捷径：如果装了 Cookie-Editor 扩展，也可以把它的 JSON 导出整段粘贴到第一框（一次导出同时包含 `__client` 与 `__session`）。但这只是捷径，**不装扩展也能用上面两框的办法登录**。
- 登录后可在 Magpie 里查看模型列表，并用 `particle/particle-1` 做一次流式和一次非流式对话，确认登录与模型都正常。

## 风险提示

本插件通过你自己的 Clerk 会话直接调用 Capy 网站的聊天接口（逆向实现，不是 Capy 官方 API）。免费还是付费模型都走同一条接口（模型只是参数），没有单独的官方 API 对话通道；插件自动签发的 API Key 只用来拉模型列表、收流式消息、传附件和查用量，不用来直接调模型。每一次调用都会在你的 Capy 账号里真实新建一个对话；请求格式高度一致、行为模式与正常网页使用不同，Capy 服务端可以识别出来。**存在被判定为非官方客户端并封号的风险，免费额度上尤其如此。**

建议：不要高频、批量调用；不要把它当作重度主力长期跑任务；轻量使用。是否使用请自行权衡。

## 已知限制

- **用量显示**：Capy 上游不返回 token 用量。流式与非流式对话都由插件按启发式估算并上报（CJK 约 1 token/字，其余约 1 token/4 字符；流式在 `[DONE]` 前单独发一个 usage chunk），是**近似值，不是精确计数，也不能当作计费依据**。速度 / 耗时由模型本身决定，插件不做测速。
- **地区限制**：两个 ADS 免费模型（`zai/glm-5.3-flash-ads`、`deepseek/deepseek-v4.1-flash-ads`）要求出口 IP 在 US / CA / UK / AU / NZ / IE（见下方地区表）。
- **工具与浏览器**：没有原生 OpenAI tools；只有 `PromptToolBridge` 提示词约定，Capy agent 可能忽略。浏览器 / computer use 未实现。

## 开发

```bash
bun test
bun run typecheck
bun run build
bun run smoke     # 真实 Capy：本机登录 → models → particle-1 "pong"
```

`smoke` 需要本机已登录 Capy 桌面端。Cookie 登录的真实服务器登录、模型和对话验收由用户自行执行；自动测试通过不代表真实环境已验收。请不要把 Cookie 粘贴到聊天、源码或日志。

## 架构

```
entry (Magpie hooks)
  → application (use cases / stream / tool bridge)
    → ports (CapyApp, CapyPublic, DeviceRuntime, SecretStore, …)
      → adapters (Capy App/Public/Device tunnel/DPAPI/Host)
domain: 纯类型/错误/事件，不依赖 I/O
```

详见 [`spec/ARCHITECTURE.md`](./spec/ARCHITECTURE.md) 与 [`spec/CONTRACTS.md`](./spec/CONTRACTS.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `src/domain/` | 纯类型、错误、事件 |
| `src/application/` | 登录、目录、聊天、设备、额度、附件、工具桥 |
| `src/ports/` | 冻结接口 |
| `src/adapters/capy/` | Capy App/Public/Device/SSE/Files/local/browser |
| `src/adapters/host/` | Magpie auth 记录 |
| `src/adapters/platform/` | proxy/DPAPI/HTTP/ULID/clock/logger/token 估算 |
| `src/entry/` | Magpie 插件装配 |
| `src/protocol/` | SSE / OpenAI 编解码 |
| `spec/` | 行为、架构、协议、决策、审计 |

## 免费模型与地区

| 模型 | 免费方式 | 地区 |
|---|---|---|
| `particle/particle-1` | 免费、无广告 | 无地区限制 |
| `zai/glm-5.3-flash-ads` | App 内广告免费 | **仅 US / CA / UK / AU / NZ / IE 出口 IP** |
| `deepseek/deepseek-v4.1-flash-ads` | App 内广告免费 | **仅 US / CA / UK / AU / NZ / IE 出口 IP** |

两个 ADS 模型是 Capy 服务端按**出口 IP** 判定的，不是请求头能绕过的：

- 插件会读取 `MAGPIE_CAPY_PROXY`、`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 或 Windows 系统代理。
- 启动日志会打印 `proxy_enabled`（只打印 host:port，不打印凭据），可以先确认代理是否生效。
- 出口不在支持地区时，插件返回 `region_unsupported`，并在错误里附带 Capy 的原文；
  需要把代理切到支持地区的节点，或改用 `particle/particle-1`。
- ADS 模型还必须带 `ads-models` 客户端能力位；插件只对这两个模型自动加。

## 无头设备与工具

设备名默认取 `os.hostname()`；可用 `MAGPIE_CAPY_DEVICE_NAME` 覆盖。
已有设备会通过 `PATCH /app/orgs/{org}/devices/{id}` 自动重命名，不需要重新配对。
Capy 设置里如果还留着旧的 `magpie-headless` 设备，可以在设备页面手动删除；插件只使用当前主机名这台。

machine RPC 已实现：

| 能力 | handler |
|---|---|
| 执行命令 | `bash` / `bash_output` |
| 读写文件 | `read` / `write` / `edit` / `file_read` / `file_write` |
| 工作区 | `worktree_ensure` / `worktree_list` |
| 卷 | `volume_landed` / `volume_probe` |
| Git | `POST /v1/git/capture` |

> [!warning]
> `bash` 会在**当前 Windows 用户权限**下执行 Capy agent 发来的命令，和 Capy 桌面端的行为一致。
> 只安装可信插件、只登录可信账号；不要把这个设备 token 交给别人。

浏览器 / computer use 仍未实现。

## 边界

- 无头设备实现 bash / 文件 / 工作区；浏览器 / computer use 不可用。
- 免费 ADS 模型（GLM-5.3-Flash / DeepSeek V4.1 Flash）只允许这些出口 IP：
  US / CA / UK / AU / NZ / IE。插件会自动读取 `MAGPIE_CAPY_PROXY`、`HTTPS_PROXY`
  和 Windows 系统代理，并在日志里打印 `proxy_enabled`；出口不在支持地区会返回
  `region_unsupported`，这是 Capy 服务端限制，插件无法绕过。
- 没有原生 OpenAI tools；只有 `PromptToolBridge` 提示词约定，Capy agent 可能忽略。
- 没有数据库/队列：插件是请求作用域 + 本地 device token。
- 同一 Magpie 里只安装一份 `capy` 插件。

## License

MIT
