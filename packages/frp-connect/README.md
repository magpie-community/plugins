# frp-connect

把 frp（frpc）做成一个 magpie 插件：一个配置页面，加一个连着 magpie 生命周期的 frpc 进程。你在页面里填好服务器和代理，插件生成 `frpc.toml`、下载并启动固定版本的 frpc，点一下就能开、能停。

## 组成

- **配置页面**（`magpie.page`）：在 magpie 侧边栏「FRP 连接」里填服务器、鉴权、代理，右边就是实际会跑的 `frpc.toml`。「校验配置 / 启动 / 停止 / 重启」都在页面上。
- **插件自己跑的服务**（`index.mjs`）：在 `127.0.0.1:33417` 上给页面提供文件和控制接口，并负责 frpc 的启动、看护和停止。
- **只读的工具**：给智能体的 `state`、`logs`、`generate`、`verify`。

## 安装

```bash
magpie plugin add ./frp-connect
```

就地加载，不用构建、不用装依赖：`index.mjs` 不从 `@opencode-ai/plugin` 或任何包导入。

## frpc 从哪来

- `frpcBinary: "download"`（默认）：插件只跑 frp **0.71.1**，下载地址是 frp 自己的 GitHub release。下载后按本包里的 SHA256（`lib/frpc.mjs` 的 `SUMS`）校验，不一致就解压都不做、直接报错，也不会去跑它。别的版本不会被使用：升级只能通过升级本插件。
  按当前平台取：Windows / macOS 的 amd64、arm64；Linux 还有 arm（32 位，含 armv7）、loong64、riscv64、mips64le。frp 没发布包的平台（ppc64le、s390x 等）只能走 `local`。
- `frpcBinary: "local"`：用你自己的 frpc，填 `frpcPath`（留空则用 PATH 里的 `frpc`）。这时校验和由你负责。

## 配置

页面顶部两种写法，随时互换，互换后跑的是同一份配置：

- **可视化**：填服务器和代理，自动生成 `frpc.toml`。生成的配置里总有 `loginFailExit = false`，服务器暂时连不上会一直重试。
- **frpc.toml**：直接粘一份完整的 `frpc.toml`，原样使用。

页面预览的 `frpc.toml` 就是写盘并被 frpc 读取的那一份（有测试咬住页面和 `lib/toml.mjs` 的两份生成代码）。

字段：

| 字段 | 说明 |
| --- | --- |
| `serverAddr` / `serverPort` | FRP 服务器地址和端口（默认 7000） |
| `authMethod` / `authToken` | 需要鉴权时填；token 为空则不写 `[auth]` |
| `transport` | `tcp`（默认）、`kcp`、`quic`、`websocket`、`wss` |
| `proxies` | 代理列表；`tcp`/`udp` 填 `remotePort`，`http`/`https` 填 `customDomains`（逗号分隔）或 `subdomain` |
| `configMode` | `form` 或 `toml` |
| `frpcToml` | `configMode` 为 `toml` 时使用的全文 |
| `frpcBinary` / `frpcPath` | frpc 的来源 |
| `autoStart` | 开 magpie 时自动启动（页面上的勾选，默认关） |

命令行等价：

```bash
magpie plugin options @magpie-community/frp-connect '{
  "serverAddr": "1.2.3.4",
  "serverPort": 7000,
  "authMethod": "token",
  "authToken": "your-token",
  "proxies": [{ "name": "ssh", "type": "tcp", "localIP": "127.0.0.1", "localPort": 22, "remotePort": 6000 }]
}'
```

改选项会让 magpie 重载插件，新的配置随之生效。

## 谁能开隧道

只有页面能。开始和停止是页面按钮，发到插件自己的控制接口，并带着宿主给页面的密钥（写在插件目录的 `service.key`，只有 magpie 宿主读得到）。所以：

- 智能体只有只读工具，**给不了**“开个口子”的指令；
- 网页里的提示注入、别的进程、别的浏览器标签页，都调不动它。

密钥 `service.key`、`frpc.toml`、日志都在 magpie 自己的目录里（`~/.config/magpie/frp-connect`、macOS 的 `~/Library/Application Support/magpie/frp-connect`、Windows 的 `%LOCALAPPDATA%\magpie\frp-connect`），**不在**你当前打开的项目目录里，也不在插件的安装目录里。

## 生命周期

- frpc 是宿主进程的子进程，不 `detached`：magpie 退出或者插件被关掉，它跟着结束。
- 停止只杀自己记下的那个 frpc：先看进程还在不在，再看它的命令行里是不是自己的 `frpc.toml`，PID 被重启后的别的进程复用了也不会误杀。
- 日志写在状态目录里，只在 frpc 运行时增长；安装目录始终是只读的。

## frpc 的日志

页面下方的日志从控制接口读，3 秒刷新一次；`logs` 工具也能读到末尾。

## 关于把 magpie 网关暴露到公网

**不要**用 `type = "tcp"` 把 `127.0.0.1:3425` 映射出去。frpc 自己在本机发起连接，不带转发头，magpie 会把这种请求当成本机用户，于是**不需要网关密钥**：谁能连上你 frps 映射出来的那个端口，谁就能花你的订阅额度。frps 若是第三方在跑，风险由它掌握。

要让网关给外面用，用 frp 的 `http` / `https` 代理（它们带 `X-Forwarded-For`，magpie 会当成远端请求，于是要求「在局域网上共享」加上网关密钥），并在 magpie 里打开「在局域网上共享」、设一个 `sk-magpie-key-…`。只转发你自己的服务（git、文件服务之类）时用 `tcp` / `udp` 没有问题。

## 限制

- 只跑 frp 0.71.1，不支持自选版本（这是校验和能固定下来的前提）。
- 页面上的「校验配置」跑 `frpc verify -c`；工具 `verify` 只检查选项、报出会用的 SHA256，不跑 frpc、不下载任何东西。
- 认证 token 保存在 magpie 的 `plugins.json` 里（页面输入框是密码框，不会回显到日志）。
