# Octopus to Magpie Connect

[English](README.en.md)

`octopus-to-magpie-connect` 是一个 Magpie 社区页面插件：它把本机 Magpie 网关接入 Octopus 云端节点。连接器直接运行在 **Magpie 已有的 Bun 插件宿主**中，不会另启 Go Connector、companion、守护进程或服务，不生成子进程，也不会退出或终止 Magpie。

- **Octopus 项目（上游项目）**：[`https://github.com/lingyuins/octopus`](https://github.com/lingyuins/octopus)
- **本插件项目**：[`https://github.com/lingyuins/octopus-to-magpie-connect`](https://github.com/lingyuins/octopus-to-magpie-connect)

> Octopus 的 GitHub 仓库地址是上面的代码仓库链接；它不是你在插件页面中填写的云端 WebSocket 地址。云端地址仍应使用你在 Octopus 本地节点页面为节点生成的 `wss://.../node/v1/connect` 地址。

## 快速开始

1. 在 Octopus 创建一个本地节点，取得节点令牌和节点的 `wss://.../node/v1/connect` 地址。
2. 在 Magpie 创建 API 密钥，并确认本机 Magpie 网关端口（默认 `3425`）。
3. 在 Magpie 安装并打开本插件，填写云端地址、模型 ID 和私有凭据。
4. 保存后单独确认“请求连接”，**完全退出并重新启动 Magpie**。
5. 回到 Octopus 的本地节点页面查看真实连接状态，再点击“测试连接”。

页面保存成功只表示保存了期望状态，不代表节点已经在线；本插件没有虚构的实时状态 API。

## 安装

在 Magpie 中安装已发布的 npm 包：

```sh
magpie plugin add octopus-to-magpie-connect
# 固定当前发布版本时，可替换为目标版本号：
magpie plugin add octopus-to-magpie-connect@0.1.1
# 也可以从 Git 或本地文件夹安装：
magpie plugin add lingyuins/octopus-to-magpie-connect
magpie plugin add D:/CodeWorkspace/octopus-to-magpie-connect
```

无构建步骤。全新本地 checkout 请先在目录内执行 `npm ci`，再添加该文件夹：Magpie 直接加载本地目录，因此固定版本的 `ws` 依赖需要提前安装。npm/Git 包安装由 Magpie 的包安装器处理；本项目不会自动安装或启用插件。

如果从旧的页面版 Connector 迁移，请先停用或移除旧插件，不要为同一个节点继续运行一个独立的旧 Connector。

## 它连接什么、凭据存在哪里

本插件连接两个都属于你的系统：

1. **Octopus 云端**：使用你在 Octopus 本地节点页面创建节点时得到的**节点令牌**。连接器只向你填写的 `wss://.../node/v1/connect` 地址建立一条出站 TLS WebSocket；没有账号密码，也没有 OAuth 流程。
2. **本机 Magpie 网关**：使用你在 Magpie 中创建的 **API 密钥**。连接器只访问固定的 `http://127.0.0.1:<端口>`（默认 `3425`）；即使是 loopback，也必须提供密钥。

**凭据存放位置由你选择，插件绝不自动发现：**

- 插件页面填写：明文保存在本机 Magpie 的 `plugins.json`。
- 环境变量 `OCTOPUS_NODE_TOKEN` / `OCTOPUS_MAGPIE_KEY` / `OCTOPUS_MAGPIE_URL`：插件不落盘。
- `OCTOPUS_MAGPIE_PRIVATE_CONFIG` 指向的外部私有 JSON 文件：文件位置由你决定，请用操作系统权限保护。

节点令牌只发往你指定的 Octopus 地址，Magpie 密钥只发往本机 loopback 网关，除此之外不发送任何凭据。

## 模型发现与导入

没有固定模型清单。请选择希望该 Octopus 节点对外提供的确切模型 ID（每个 ID 一个标签，不支持通配符），可以逐条添加，也可以批量导入。只有允许列表中的 ID 才会转发到 Magpie；Octopus 云端页面的“测试连接”只验证隧道、密钥和允许列表，不发送推理请求。

### 查询 Magpie 网关模型

在运行 Magpie 的电脑上打开 PowerShell，以下命令会逐行输出网关公开的模型 ID：

```powershell
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3425/v1/models?format=text').Content
```

端口不是 `3425` 时替换为实际端口。当前 Magpie 允许本机 loopback 不带密钥只读查询目录；连接器本身仍要求 Magpie API 密钥。也可以运行 `magpie models` 在终端查看模型目录。

要查询连接器所用密钥实际允许的模型，请在 Authorization 请求头中携带该密钥。下面的示例使用隐藏输入，不会把密钥写入 URL 或命令历史；User-Agent 中的版本应与实际安装版本一致：

```powershell
$key = Read-Host 'Magpie API key' -AsSecureString
try {
  (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3425/v1/models?format=text' `
    -UserAgent 'octopus-ly-connector:v0.1.1' `
    -Headers @{ Authorization = 'Bearer ' + [System.Net.NetworkCredential]::new('', $key).Password }).Content
} finally {
  Remove-Variable key -ErrorAction SilentlyContinue
}
```

这里的“所有模型”是网关当前公开且可见的目录，不是每个上游厂商所有可能的模型。provider 启用状态、隐藏模型、agent 可见性和密钥限制都会影响结果；出现在目录中也不保证实际调用成功或免费。

在插件页面展开“批量导入”：指令预览会跟随表单中填写的端口（留空为 `3425`）。点击“复制指令”不会保存偏好，也不会包含凭据；如果浏览器拒绝剪贴板访问，可以选中只读命令手动复制。在本机 PowerShell 运行后，把输出粘贴进导入框；也支持 `/v1/models` 返回的 JSON（`{"data":[{"id":"provider/model"}]}`）。

导入输入上限为 4 MiB，最终允许列表最多 1024 个唯一 ID。重复项会跳过；任何非法 ID 或超限都会让整批导入失败且不修改草稿。请检查并删除不希望公开的标签，再手动保存并确认。导入不会自动保存，也不会自动请求连接。

Magpie 插件页面沙箱禁止直接联网（`connect-src 'none'`），官方 bridge 也没有模型目录读取接口，因此本插件使用“本地命令 + 粘贴”的离线导入方式，不提供无法工作的“获取模型”按钮。不需要另起服务器，也不需要放宽沙箱。

## 私密信息配置

在 Octopus 创建节点并取得节点令牌；自行取得 Magpie API 密钥。凭据可通过插件页面、环境变量或外部私有文件提供，本插件**不自动读取 auth 文件，也不搜索凭据**。

### 方式一：插件页面

在 Magpie 中打开 Octopus Connector 页面，在“私有凭据”区域填写节点令牌、Magpie API 密钥，可选填本机 Magpie 端口（默认 `3425`，连接器固定访问 `127.0.0.1`），然后保存。

这些值会以明文形式保存在本机 Magpie 的 `plugins.json` 中。显示 `__keep__` 的字段表示已有存储值：保持不动即可沿用，输入新值会替换，清空则回退到环境变量或私有文件。本机独享时，这是最简便的方式。

### 方式二：环境变量

在启动 Magpie 前设置：

```powershell
$env:OCTOPUS_NODE_TOKEN = '<你的节点令牌>'
$env:OCTOPUS_MAGPIE_KEY = '<你的 Magpie API 密钥>'
$env:OCTOPUS_MAGPIE_URL = 'http://127.0.0.1:3425'
# 然后从此环境启动 Magpie。
```

本地地址必须是固定的 HTTP 字面 loopback origin，不允许 `localhost`、额外路径、凭据或查询参数，也不能通过重定向切换目标。端口填写实际 Magpie 网关端口；默认地址是 `http://127.0.0.1:3425`。**即使 loopback 也必须提供 Magpie 密钥。**

### 方式三：外部私有 JSON 文件

也可以显式设置 `OCTOPUS_MAGPIE_PRIVATE_CONFIG`，指向**插件目录外部私有 JSON 文件的绝对路径**。文件只接受以下 snake_case 字段，拒绝 camelCase 和未知字段：

```json
{
  "node_token": "<你的节点令牌>",
  "magpie_key": "<你的 Magpie API 密钥>",
  "magpie_url": "http://127.0.0.1:3425",
  "allow_insecure_loopback": false
}
```

请用操作系统权限保护该文件，不要把它放入插件目录或提交到版本控制。环境变量优先于对应 JSON 字段，页面保存的凭据优先于环境变量和文件来源。不会自动查找私有配置或认证文件。

`OCTOPUS_ALLOW_INSECURE_LOOPBACK=true` 仅用于显式的私密测试：它不会豁免密钥，也不会允许公网明文云端地址；公开页面始终要求 `wss://`。

变更环境变量后必须重启 Magpie。变更外部私有文件后，旧连接器会断连并永久退役；随后请显式重载插件宿主或重启 Magpie，才能使用新凭据。旧宿主不会采用替换后的节点令牌。Windows 短时读取句柄可能导致原子替换暂时返回 `EPERM`；Magpie 现有设置写入器会对此重试约 500ms，外部编辑器也应重试短暂共享冲突。插件每次读取后都会先关闭句柄再解析，任何读取失败都会安全退役。请勿把密钥粘贴到模型列表或诊断消息中。

## 页面操作与 Bun 宿主生命周期

在 Magpie 中打开插件页面：

1. 填写以 `/node/v1/connect` 结尾的云端 WSS 地址（可带部署前缀）。
2. 用“添加”按钮或回车逐个加入精确模型 ID，或打开“批量导入”粘贴上文获取的网关模型列表。每个 ID 都会成为可移除的标签；大小写、逗号和 `*` 均按字面处理，不会展开通配符。
3. 保存偏好后，单独确认“请求连接”。安装或打开页面不会自动把 `connect` 设为 `true`；标签和字段改动只有通过确认的保存才会写入 Magpie。
4. **完全退出并重新启动 Magpie。仅刷新插件页面不够。** 修改端口、令牌、密钥或模型后也要重启。
5. 到 Octopus 的“本地节点”页面查看真实状态，再点击“测试连接”。该测试只检查隧道、网关、密钥和允许列表中的模型，不发送推理请求。

页面会显示完整步骤、“已保存的期望”、上次保存时间和重启提示。它显示的是已保存的期望状态，不是在线状态。

页面只调用官方 `_magpie/bridge.js` 提供的 `ready`、`theme`、`onTheme` 以及自身的 `options.get/set` API；不自行联网、不虚构连接状态，也不使用自定义 RPC。凭据字段只显示 `__keep__` 占位符，永不回显真实值；未知存量字段不会回显，确认保存后只保留九个已知字段。保存操作有一秒限频。

**Bun 宿主是惰性启动的：** Magpie 需要插件钩子时才启动宿主，添加插件或打开页面本身不能证明宿主已运行。保存选项可能重载宿主；重载或断开会取消在途云端请求，并可能导致请求失败，不会重放请求。若保存连接期望后未建立连接，请显式重载或重启 Magpie，并执行正常会加载插件的 Magpie 操作，**无需单独启动 Connector**。

保存会保留当前的连接期望。断开时会忽略当前未保存的错误表单，使用上次合法配置保存 `connect=false`。所有写入都需要确认并受限频；清空保存的密钥或端口会移除页面覆盖，恢复到环境变量、私有文件或默认来源。

## 九个公开字段

```json
{
  "version": 1,
  "connect": false,
  "cloud_url": "wss://octopus.example/prefix/node/v1/connect",
  "models": ["provider/exact-model-id"],
  "max_concurrency": 4,
  "request_timeout_seconds": 300,
  "node_token": "",
  "magpie_key": "",
  "magpie_url": ""
}
```

版本固定为 1，连接期望为布尔值。云端地址只接受安全的 `wss://` 形式，不允许凭据、查询参数、片段、编码字符、反斜杠、点段或空路径段。模型为 1–1024 个唯一精确 ID，每个 1–512 个 UTF-8 字节，不能有首尾空格或控制字符；大小写、逗号和 `*` 都按字面处理。并发数为 1–32 的整数，超时为 1–3600 秒的整数。

唯一未配置形态为 `{ "version": 1, "connect": false, "cloud_url": "", "models": [], "max_concurrency": 4, "request_timeout_seconds": 300, "node_token": "", "magpie_key": "", "magpie_url": "" }`。没有 options 或空 options 也使用这个禁用默认值。

`node_token`、`magpie_key` 和 `magpie_url` 可以是空字符串，此时由环境变量 `OCTOPUS_NODE_TOKEN`、`OCTOPUS_MAGPIE_KEY` 和 `OCTOPUS_MAGPIE_URL`（或外部私有 JSON 文件）提供。当它们有值时，会以明文保存在 `plugins.json` 中，并优先于环境变量和文件来源。

## 单实例与失败关闭

运行时从 `input.directory/plugins.json` 读取控制配置。绝对目录 spec 以及 npm/Git 安装 spec 都必须把实际安装目标经 `fs.realpath` 规范化后，与自身模块目录精确比较；包名相同本身不能证明身份。Git spec 通过 `input.directory/plugins/package.json` 中的完整依赖值精确映射。该文件及插件自己的包元数据都只是有界 JSON 读取，不涉及凭据发现或代码执行；必须且只能匹配一个条目。

禁用或移除插件、文件丢失、读取失败、重复匹配、非法配置或断开期望，都会在观察到时立即取消当前会话。连接器会先关闭 WSS 并等待本地请求取消完成，再释放所有权，不会终止宿主。

连接器使用两个受限的 `127.0.0.1` 排他 TCP listener 作为操作系统 lease：一个绑定规范化的插件目录身份，另一个绑定节点令牌的 SHA-256 身份（端口范围 32000–59999）。这可以防止同一安装被多个宿主同时运行，也可以防止同机复制目录后使用同一个节点令牌双活。它们不提供 HTTP 或管理 API，传入 socket 会立即销毁；活跃 owner 不会被强抢，owner 死亡后由操作系统释放 lease。端口冲突会失败关闭或等待，不会冒险接管。

保存选项触发重载时，旧宿主可能继续存在最多十分钟。每个 runtime 固定其初始公开选项；发现配置变化后会永久退役，不会使用新配置或新令牌重连。新宿主会等待旧会话取消并释放 lease 后再接管。只有相同控制配置和相同私密配置持续有效时才会自动重连；重试采用带随机抖动的指数退避，从 500ms 起、上限 30 秒，连接持续超过 60 秒后重置退避。

## 验证

```sh
npm test
# 如果已安装 Bun：
bun test tests/*.test.mjs
```

测试覆盖页面行为、严格的控制与私有配置、入口快速返回、旧新宿主交接、独占 lease 和显式启动的多进程 fixture（包括 owner 死亡释放）。只有测试 fixture 会启动或停止测试子进程，正式插件不会。所有凭据均为合成测试值；测试不会真实安装 Magpie 插件，浏览器 mock bridge 也不会被正式页面引用。
