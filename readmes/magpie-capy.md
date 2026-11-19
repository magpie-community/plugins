# magpie-capy 0.2.3

**Capy 任务平台工具（非模型提供方） · MIT 源码许可 · 品牌归属见 `docs/attribution.md`**

在 Magpie 中配置组织 API Key 后，智能体可读取项目、线程、子代理、消息，并以有界时间观察线程 SSE；写入默认关闭。

### 登录路径现状

登录不使用 OAuth：先在 Capy 网页用邮箱登录，到 Settings 创建 API Key，再在 Magpie 的密码输入框中手动粘贴并显式委托。Key 本身不是只读类型，也没有自带 scope，权限随 principal；建议使用专用只读服务账号并设置到期时间（如 30 天），但未验证具体 scope、principal 映射或到期元数据。该流程尚未完成新 GUI 验收；GUI 本地退出和提示取消未验证，不能写成已支持的一键登录。
- 当前可用路径是 Capy 设置 → API 创建组织 API Key，再在 Magpie 中配置；这是高级路径。
- 本插件不实现 OAuth、设备登录、浏览器会话复用或凭证发现。
发布状态：0.2.3 的 GitHub 发布已获授权，npm 发布仍待认证；不声称 npm 已发布。发布包已存在，使用官方 Magpie CLI 和稳定插件 ID 的标准安装方式；npm 发布后使用标准 npm 安装。不要手动加载解压后的包目录；0.2.2 归档保持不变。

> English overview: [below](#english). 中文完整说明也保存在 `README.zh-CN.md`。Capy 名称与图标属于 Capy 品牌。

## 安装

首选官方 CLI 的 GitHub 规格安装：

```bash
magpie plugin add github:grokboot/magpie-capy
```

桌面版：**插件 → 添加插件 → GitHub**，填入 `grokboot/magpie-capy`。

`Discover` 中本插件应标为 **Unofficial**，不是 Capy 或 Magpie 官方插件。GitHub 的 `magpie-plugin` topic 是官方未审阅收录路径，但不保证立即出现：仓库已被 GitHub 搜索索引，只有实际应用目录包含本插件后才可能显示。GitHub 预构建目录在 48 小时内优先；目录不可用时回退到客户端缓存的 topic 查询（约 10 分钟）或实时 GitHub 查询。精选 registry 是独立的推荐列表，最多每 6 小时刷新。没有“等 10 分钟就会出现”的承诺，当前也不宣称 Discover 已显示。

发布归档同样可用，顶层文件夹固定为 `magpie-capy/`：

```bash
tar -xzf magpie-capy-0.2.2.tgz
magpie plugin add ./magpie-capy
```

开发时也可直接装源码目录：

```bash
git clone https://github.com/grokboot/magpie-capy
magpie plugin add ./magpie-capy
```

npm 发布元数据已准备；0.2.3 计划在 GUI 验收通过且 npm 认证就绪后作为公开版本发布，当前不声称已发布。发布后可用 npm 安装，GitHub 安装仍作为替代路径；标准 npm tgz 顶层为 `package/`，不代表解压后手动文件夹安装是稳定路径。

## 配置 API Key（真正的 Magpie 登录/配置）

1. 在 **Capy 设置 → API** 手动创建组织 API Key。
2. 在 Magpie 的 **插件 → Capy** 行点击 **配置 Capy 组织 API Key**。
3. Magpie 将密钥保存在自己的 `plugin-auth.json`（600）；插件不把密钥写入公开选项、页面、URL、日志或工具结果。
4. 登录/刷新时做一次只读 `GET /api/v1/projects` 验证；用量卡片显示“只读连接已验证”或具体错误，401 标记登录过期。

**徽标说明**：0.2.2 插件的实际 GUI 检查只显示 `Tools` 徽标。Capy 的工具通过独立的 MCP 工具服务器提供，面向 Capy 公共任务 API；工具与认证是两回事。`capy` 只是 Magpie 的零模型认证命名空间，仅用于登录入口，**没有注册模型、不提供模型、不做推理、没有 completion 端点**。零模型的本地认证桥接不是模型提供商，也不保证出现 `Provider` 徽标；是否显示 `Provider` 取决于宿主版本与分类逻辑（较早的 GUI 曾同时显示 `Tools` 和 `Provider`），当前不声称会显示。不要为了获得 `Provider` 徽标而伪造模型或修改宿主分类。

兼容旧安装：`CAPY_API_KEY` 仍有效且优先；用量卡片会说明工具实际使用环境变量还是 Magpie 登录。环境变量格式无效会显示配置错误。Magpie 可保存多个账号，但工具调用没有账号选择器；检测到多个账号时工具会安全停止，不会静默使用最后一个账号。

### 清除

本地清除请使用 `magpie plugin logout capy`，再按需移除环境变量。本次验收未找到 Magpie 宿主 UI 可用的本地退出入口；移除插件会卸载但保留授权，移除 Provider 仍保持 Capy 登录状态，二者都不是退出登录。宿主认证文件由 Magpie 管理；刚退出时内存中的旧密钥会在 Magpie 下一次 provider 刷新/无认证回调时清除。

## 交给智能体与 MCP

看到 **工具，已对智能体隐藏** 时，这是宿主暴露设置。点击 **交给智能体**，再到 Library → MCP 或路由器确认目标智能体。也可手动添加 `http://127.0.0.1:3425/mcp/magpie/tools`。登录与工具暴露是两件独立的事。

## 选项与写入

插件行现在有 **Options**。默认示例：

```json
{"allowWrites": false}
```

写入默认关闭。需要时可将 `allowWrites` 设为 `true`，或在环境中设置 `CAPY_ALLOW_WRITES=true`。Options 是公开的非密钥策略，**绝不能填 API Key**。每次写入仍须 `confirm:true`；创建/发消息可能执行命令、消耗额度或创建 PR。

## 从 0.1.0 升级

更新或重新添加本目录。插件登录保存在 Magpie 的 `plugin-auth.json`，通常不会因重新加载源码丢失；环境变量也不受影响。

## 宿主边界

- 本地文件夹详情与 npm registry 卡片元数据来源不同；仅靠 manifest 不能完全补齐 registry 版本/许可证/摘要展示。
- 最终 0.2.2 归档保持不可变；0.2.3 只准备 npm 发布元数据，标准 npm tgz 顶层为 `package/`。从本地文件夹复制仍可能沿用文件系统时间。
- “隐藏”、MCP 路由、按智能体授权和 Provider 徽标均由 Magpie 宿主控制。

## 测试与限制

`bun run check`、`bun run check:openapi`、`npm pack --dry-run`。117 个 mock 测试在 UTC 与 Asia/Shanghai 时区通过，typecheck 通过，未暴露原始 payload、日志或 Key。受控端到端验证使用已批准的服务账号 Key，官方 Magpie CLI 原生授权保存到宿主存储后，仅执行一次公开只读 `list_projects`（HTTP 200，空列表）；网关重启后可从持久化授权继续成功，官方 CLI 本地 logout 后工具无授权失败。由于没有项目数据，未覆盖 subagent、SSE、消息创建/发送/打断，也不声称全部 API 或新 GUI 已验收。0.2.1 的真实 GUI 验收只适用于旧版。0.2.3 的 GUI 验收已通过名称/图标、中文 README、10 个工具、授权状态和 Options `allowWrites=false` 持久化；GUI 本地退出和提示取消未验证，不能写成完整 GUI 已通过。本地 logout 只清除本地授权，不等于服务端撤销；环境变量 `CAPY_API_KEY` 可覆盖 UI 退出并保持授权，需明确警告。

## English

A Magpie task-tool plugin for Capy projects, threads, subagents, messages, and bounded SSE. Capy is a task platform, not an inference provider; this plugin exposes only Capy task tools through Magpie's zero-model auth bridge, not chat inference.

There is no OAuth, device login, session reuse, or credential discovery. The intended flow is Capy web email login, then Settings to create an API Key, then explicit manual delegation by pasting the key into Magpie's native password input. The key is not read-only by type, has no scopes of its own, and permissions follow the principal. Use a dedicated read-only service user and an expiry such as 30 days where possible; no specific scope, principal mapping, or expiry metadata was verified. Magpie saves the key only after one bounded read-only `GET /api/v1/projects` check succeeds; cancelling or a rejected key saves nothing. Opening capy.ai or the Capy plugin alone never marks Magpie connected. Writes are off by default unless `allowWrites` is saved or `CAPY_ALLOW_WRITES=true`, and every write still requires `confirm:true`.

Basic native authorization, a read-only project-list call (HTTP 200, empty result), restart with persisted native auth without `CAPY_API_KEY` in the environment, and CLI local logout/clear were tested end to end; after official logout, restarting without `CAPY_API_KEY` left the tool unauthorized (`isError: true`), and no raw payloads, logs, or keys were exposed. Because no project data was available, subagent, SSE, message, and write paths were not live-tested. The suite contains 117 tests. CLI local logout clears the local credential but is not server-side revocation, and `CAPY_API_KEY` can override UI logout and keep tools authorized, so this is a known risk. For release 0.2.3, install through the official Magpie CLI with the stable plugin ID; once npm publication is available, use standard npm installation. Do not manually load the unpacked package folder. The GitHub release is authorized; npm publication is pending authentication, so npm availability is not claimed yet. `Discover` labels the plugin **Unofficial**. The repo is already indexed by GitHub search, but the actual app catalog must contain it before it can appear, and no current Discover visibility is claimed. Catalog lookup prefers the prebuilt GitHub catalog for 48 hours; if it is unavailable, lookup falls back to a client-cached topic query (about 10 minutes) or live GitHub. The curated registry is a separate recommended list that refreshes at most every 6 hours. The 0.2.3 GUI check passed name, icon, Chinese README, 10 tools, authorized status, and Options `allowWrites=false` persistence; GUI local logout and prompt cancel were not verified, so this is not a complete GUI pass. See `docs/ux-auth-exposure.md`, `README.zh-CN.md`, and `SECURITY.md`.
