# Nowledge Mem / AI Now — Magpie Agent 插件

在 **Magpie → Agent → Nowledge Mem / AI Now** 选择一个模型，同步到 Nowledge 的 **Default、AI Now、Background** 三项用途。上游账号、订阅、密钥、模型路由和故障切换由 Magpie 管理；Nowledge 只连接 Magpie 网关。

这是使用官方 Agent 扩展协议的第三方插件，不是 Nowledge 的 MCP 记忆插件。它不会把 Nowledge 变成 Magpie 的模型供应商。

与社区现有的 `@magpie-community/gateway-nowledge-mem` 不同：本插件管理 **Nowledge 自己使用哪个模型**；现有 gateway 插件为其他 Agent 召回记忆、注入 Context Bundle，并按需导入对话。本插件不依赖该 gateway 插件，也不执行记忆召回或对话导入。

## 安装

要求：已运行的 Magpie、Nowledge Mem 桌面版或自托管服务；Nowledge 需要支持 `magpie` 类型和独立 provider 实例。开发与验证版本见 [VALIDATION.md](VALIDATION.md)。Bun 由 Magpie 的插件宿主管理，没有 npm 依赖和安装脚本。独立诊断命令需要 Node.js 22+，或使用 `bun cli.mjs`。

1. 在 Magpie 的 **插件 → 添加插件** 中填写 `github:Alexhang1314520/magpie-agent-nowledge-mem`，或选择下载解压后包含本文件和 `package.json` 的完整文件夹。
2. 确认 Magpie 的上游 provider 已经登录并有可用模型。
3. 打开 **Agent → Nowledge Mem / AI Now**，选择支持工具调用的模型或路由组。
4. 保持 Magpie 和 Nowledge 运行，通常等待 2–4 秒。Nowledge 的 Providers 页面会出现独立的 **Magpie · Nowledge Agent**，三项用途会使用你刚选的模型。开始一个新对话验证实际回答。

有 `magpie` 命令时可以直接从 GitHub 安装。使用标签固定已测试版本：

```sh
magpie plugin add github:Alexhang1314520/magpie-agent-nowledge-mem#v0.1.0
```

也可在解压后的插件目录执行：

```sh
magpie plugin add "$PWD"
magpie nowledge-mem <供应商/模型>
```

macOS 未把 Magpie 加入 PATH 时，可用应用中的命令：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add "$PWD"
```

不要只导入 `agent.js`：这个插件同时需要 `main` 指定的 Bun 同步模块。不要导入 `.tgz` 文件作为本地目录；使用解压后的完整文件夹。

## 实际管理范围

| 项目 | 行为 |
| --- | --- |
| Default、AI Now、Background | 同步为 Magpie 当前选中的同一个模型 |
| Remote / Local 模式 | 首次接入启用 Remote；正常断开恢复接入前的值 |
| 其他 provider 及其密钥 | 不覆盖，使用独立实例 `magpie:nowledge-agent` |
| Embedding、Vision / OCR、Fast decisions | 不写它们的用途配置；**原本跟随 Default 的 Vision 也会随 Default 改变** |
| 已打开的对话、单次会话或 AI Identity 的显式模型覆盖 | 可能继续使用自己的模型；请开始新对话并检查其模型选择 |
| 模型能力 | 同步已知 context window、输出上限和图片能力；不臆造未知能力 |

网关 URL 和 Agent 专属 key 来自 Magpie 的 `connect` 入参，未固定网关端口，也不需要复制上游 key。使用完整 `provider/model` 或 `group/name`，不增加 `openai/` 前缀。请求采用 Chat Completions，Magpie 负责向上游协议转换。

## Nowledge 地址与认证

默认连接本机 `http://127.0.0.1:14242`。如果你的 Nowledge 使用其他端口、远程地址或访问 key，请创建：

`~/.config/magpie-nowledge-mem/adapter.json`

```json
{
  "apiUrl": "https://your-mem.example.com",
  "apiKeyFile": "~/.config/magpie-nowledge-mem/nowledge.key",
  "pollMs": 2000
}
```

`nowledge.key` 中只放 **Nowledge 服务的访问 key**，并设置文件权限为仅自己可读写。它与 Magpie 的网关 key 是两套凭据。不要把任何 key 提交到插件项目。

也支持宿主环境变量 `NMEM_API_URL`、`NMEM_API_KEY`；显式 `apiUrl` / `apiKeyFile` 优先。GUI 启动的应用未必继承终端的环境变量，优先使用上述文件。Magpie 的插件选项也支持相同字段，选项优先于文件。

独立 CLI 不会自动读取 Magpie 中保存的插件选项；使用诊断／恢复命令时，请把相同连接参数放入上述 `adapter.json` 或 CLI 的环境变量。

远程 Nowledge 必须使用 HTTPS 才能发送访问 key；HTTP 仅允许本机回环地址。接口重定向被拒绝。请使用 Nowledge 实际展示的连接地址，不推测远程 `/remote-api` 或其他部署路径。

Nowledge Mem **Cloud 托管工作区** 的模型由服务管理，不属于本插件适用范围。自托管 Nowledge 与 Magpie 分处两台机器时，还必须保证写入 Nowledge 的 Magpie 网关地址能从 Nowledge 服务所在机器访问；`127.0.0.1` 始终指服务自身。单独改 `apiUrl` 不能解决网关可达性。

## 状态与恢复

在插件目录执行：

```sh
node cli.mjs status
node cli.mjs sync
node cli.mjs restore
```

- `status`：显示后端地址、三项用途、是否有恢复日志和上次同步结果，不输出 key。
- `sync`：立即应用当前选择，并解除紧急恢复留下的暂停。
- `restore`：恢复仍由插件管理的设置；暂停当前选择，防止仍在运行的宿主马上重新接管。以后在 Magpie 改选模型，或执行 `sync`，可再次接管。

正常断开请在 **Magpie 的 Agent 行**关掉连接，或执行：

```sh
magpie nowledge-mem default
```

等待同步后，用 `node cli.mjs status` 确认 `recoveryPending` 为 `false`，再停用或卸载插件。**直接停用插件、退出 Magpie 或删除插件目录，会同时停止 Bun 同步模块，无法保证当时自动回滚。** 如果已经这么做，保留插件文件，启动 Nowledge 后执行 `node cli.mjs restore`。

恢复数据保存在 `~/.config/magpie-nowledge-mem/state.json`，状态在同目录 `status.json`。**恢复前不要删除 `state.json`。** 它记录原用途及插件自己的写入，不保存旧 provider 的 API key。写入采用权限 `0600` 的临时文件及原子替换；同步加进程锁，崩溃后保留日志供重试。同步宿主会将插件自己的标准目录收紧为 `0700`，并在读取选择文件前将其权限收紧为 `0600`。

如果你在 Nowledge 中手动修改了已接管的用途，插件会保留修改，并在日志／状态里报告 `conflicts`，以后不再覆盖该用途。如果手动改过插件 provider 的连接字段，或其他用途正在引用它，恢复时会保留该 provider。恢复完成后需要你自行核对再删除；不会直接覆盖或删除。

提供商列表只返回 `has_api_key`，无法判断用户是否手动替换了同一实例里的 key。因此请在 Magpie 管理期间通过 Magpie 切换连接，或先断开 Agent 后再编辑该 provider 的凭据。后端 API 没有条件写入机制；外部同时写设置时存在读取与写入之间的短暂竞争窗口。

## 排障

- Agent 未出现：确认安装的是完整文件夹，包中有 `package.json` 的 `magpie.agent` 和 `main`；检查 `nmem` 是否在 PATH；在 Magpie 里关开插件加载新版本。
- 选模型后未生效：打开 Nowledge，执行 `node cli.mjs status`，查看 Magpie 插件宿主日志；修改设置后需要让选择文件稳定一个轮询周期。
- `HTTP 401/403`：配置 Nowledge 访问 key 或核对服务权限；不能用上游模型 key 代替。
- `already exists`：同名独立实例已存在。先检查恢复日志并执行 `restore`；对于用户保留的实例，手动更名或删除后再连接，插件不会覆盖它。
- 没有默认 provider 但已有其他 provider：请先在 Nowledge 选一个默认 provider，保证断开时有可恢复目标。
- 后端离线：保持文件和恢复日志，恢复服务后自动重试。无法解析的 JSON 不会被当成断开。
- 命令行单次执行不会持久运行同步模块；持续同步需要 Magpie 应用或 `magpie serve` 保持运行。

## 开发与官方依据

```sh
npm test
npm run check
MAGPIE_BIN=/Applications/magpie.app/Contents/MacOS/magpie node tests/magpie-smoke.mjs
npm pack
```

烟雾测试使用独立 Magpie 配置、临时插件副本及模拟 HTTP 服务，不调用真实模型。

- [Magpie 插件开发：Agent 插件](https://usemagpie.ai/docs/zh/plugins)：moejs Agent 模块、`connect`、Bun `main` 同步方案、键级恢复。
- [Magpie 应用接入指南](https://usemagpie.ai/docs/integrate)：动态模型目录、完整模型 id、网关协议及身份识别。
- [Nowledge LLM Providers](https://mem.nowledge.co/docs/llm-providers)：用途、OpenAI 兼容接口、上下文窗口。
- [Nowledge CLI](https://mem.nowledge.co/docs/cli)：provider 与用途配置。

Nowledge 的 provider 管理路由当前未包含在其公开 OpenAPI 中。本实现按 **0.10.115 官方应用附带的客户端代码**核对 REST 路由与请求体，并对实际运行服务检查 provider 的创建／删除行为。后续 Nowledge 版本改变这些接口时可能需要更新适配器。

许可证：MIT。
