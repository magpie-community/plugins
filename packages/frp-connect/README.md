# frp-connect

一个 magpie 插件，把 FRP 连接做成「配置页面 + 服务」。你在插件的配置页面里填好 FRP 服务器和代理，插件自己生成 `frpc.toml`、运行并管理 `frpc`，不需要再维护一份外部 frpc 配置文件，也不需要单独安装 `frpc`。

## 组成

- 配置页面（`magpie.page`）：在 magpie 侧边栏「FRP 连接」里填服务器和代理，实时预览生成的 `frpc.toml`，点保存写入插件选项。
- 「操作」按钮：页面里可直接点 校验配置 / 启动 / 停止 / 重启 / 刷新日志。
- 「运行日志」区域：页面底部每 3 秒刷新一次 frpc 日志与运行状态（由服务端写入 `page/_log.js` 供页面读取）。
- 服务（工具钩子）：读取插件选项，生成配置、校验并运行 `frpc`，支持自动连接。

工具（每个接入 magpie 的智能体都能用）：

- `frp-connect_start` —— 启动；若配置有变化会先重启
- `frp-connect_stop` —— 停止
- `frp-connect_restart` —— 重启，应用最新配置
- `frp-connect_status` —— 运行状态 / PID
- `frp-connect_logs` —— 查看 frpc 日志路径与最新日志
- `frp-connect_install` —— 确认 frpc 可用并报告路径与版本
- `frp-connect_generate` —— 输出当前生成的 `frpc.toml`
- `frp-connect_verify` —— `frpc verify -c` 校验

## 安装

```bash
magpie plugin add ./frp-connect
```

文件夹就地加载，无需构建、无需安装依赖（`@opencode-ai/plugin` 由 magpie 插件宿主提供）。

## frpc 从哪来

页面里可以选 frpc 来源（`frpcMode`）：

- `download`（默认，自动下载）：优先用内置的 Windows frpc；没有就按当前平台（Windows/macOS/Linux、amd64/arm64）自动下载并缓存到 magpie 配置目录。页面会显示下载进度和安装位置。
- `local`（使用本地 frpc）：用你指定的 `frpcPath`（留空则用 PATH 里的 `frpc`），不自动下载。

## 配置

插件支持两种配置方式，可在页面顶部切换，也可用 `configMode` 选项指定：

- `form`（可视化）：填服务器和代理，插件自动生成 `frpc.toml`。
- `toml`（原始配置）：直接粘贴完整的 `frpc.toml` 内容（`frpcToml` 字段）。

页面里在「可视化配置」和「frpc.toml」之间切换时会**自动互相转换**：切到 toml 时把表单生成成文本，切回 form 时把文本解析回表单字段。

在 magpie 里打开插件页面「FRP 连接」填写，或在命令行用 JSON 设置：

```bash
magpie plugin options frp-connect '{
  "frpcPath": "frpc",
  "autoConnect": false,
  "configMode": "form",
  "frpcToml": "",
  "serverAddr": "1.2.3.4",
  "serverPort": 7000,
  "authMethod": "token",
  "authToken": "your-token",
  "transport": "tcp",
  "proxies": [
    { "name": "magpie", "type": "tcp", "localIP": "127.0.0.1", "localPort": 3425, "remotePort": 6000 }
  ]
}'
```

字段说明：

- `serverAddr` / `serverPort`：FRP 服务器地址和端口。
- `authMethod` / `authToken`：需要鉴权时填；`authToken` 为空则不生成 `[auth]`。
- `transport`：`tcp`（默认）、`kcp`、`quic`、`websocket`、`wss`。
- `proxies`：代理列表。`tcp`/`udp` 填 `remotePort`；`http`/`https` 填 `customDomains`（逗号分隔）或 `subdomain`。
- `frpcMode`：`download`（默认，自动下载）或 `local`（使用本地 frpc）。
- `frpcPath`：`frpcMode` 为 `local` 时使用；填完整路径如 `C:/frp/frpc.exe`，留空用 PATH 里的 `frpc`。
- `configMode`：`form`（默认，可视化）或 `toml`（直接使用 `frpcToml`）。
- `frpcToml`：`configMode` 为 `toml` 时使用的完整 frpc.toml 文本。
- `frpcVersion`：自动下载时使用的版本，默认 `0.71.1`；设为 `latest` 会先查 GitHub 拿最新版本号（查不到就回退到 `0.71.1`）。
- `frpcDownloadBase`：自动下载的基地址，默认 GitHub。网络受限时可改为镜像，例如 `https://ghproxy.com/https://github.com/fatedier/frp/releases/download`。
- `autoConnect`：`true` 时，插件加载即连接。

选项变更会触发 magpie 重载插件宿主，因此保存后配置即生效（`autoConnect` 开时会自动用新配置重连）。

## 使用

1. 打开插件页面，填服务器和代理，点「保存」。
2. 让智能体调用 `frp-connect_verify` 校验，再 `frp-connect_start` 连接。
3. 查看状态：`frp-connect_status`。

可视化（form）模式会自动加上 `loginFailExit = false`，让 frpc 连不上服务器时持续重试而不是退出。用 raw（toml）模式时建议也加上这一行，否则 frp v0.71 默认会在首次登录失败后直接退出。

要让 magpie 网关（默认 `127.0.0.1:3425`）被外网访问，添加一个代理把 `localIP`/`localPort` 指向它：

- 名称：`magpie`
- 类型：`tcp`
- 本地端口：`3425`
- 远端端口：例如 `6000`

然后在其它的电脑上：

```bash
magpie provider add remote-magpie sk-magpie-key-… url=http://<服务器地址>:6000 id=office
```

详见 magpie 文档「远程 magpie」。

## 文件与日志

生成的 `frpc.toml`、PID 和日志保存在 magpie 配置目录的 `frp-connect/` 下（由 `input.directory` 提供）。启动失败时工具返回里会附带日志尾部。

页面里的日志区域会读取服务端定时写入的 `page/_log.js`（运行时生成，可忽略或加入 `.gitignore`）。

页面按钮通过写入一个 `requestAction` 选项来触发服务端动作：保存选项会触发插件宿主重载，服务端在重载时读取该选项并执行（用 nonce 去重，避免重复执行）。结果会写回 `page/_log.js` 的 `lastAction`，由页面日志区显示。

## 限制

- `frpc` 以独立子进程运行；`stop` 按记录的 PID 结束它。
- 配置页面运行在 magpie 的沙盒里，无法直接读取运行状态；状态通过智能体调用 `frp-connect_status` 获取。
